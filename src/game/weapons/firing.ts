/**
 * THE FIRING CHAIN. One ray in, one set of events out.
 *
 * M2_VERTICAL_SLICE §1 specifies this link by link, and this file is that specification made
 * executable:
 *
 *   build the ray  →  enemy raycast first, then world raycast; nearer wins
 *                  →  damage: base × falloff(distance) × part × stats.damageMult
 *                  →  penetrate per the def, losing damage each time
 *                  →  hitstop on crits and kills
 *                  →  emit weapon:fired, hit:enemy / hit:world
 *                  →  VFX / audio / HUD react purely off those events
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE DELIBERATELY DOES NOT DO: call `ctx.vfx`, `ctx.audio` or `ctx.hud`. Every
 *  consequence of a shot leaves through the typed bus. That is not ceremony — it is the reason
 *  three agents can build the VFX, the audio and the HUD in parallel against a gun none of them
 *  can see, and the reason a future replay/spectator layer gets impacts for free.
 *
 *  EMISSION ORDER, which the consumers may rely on:
 *      weapon:fired  →  hit:enemy (near → far)  →  hit:world
 *  `hit:enemy` is emitted by the ENEMY, from inside `takeDamage`, not by this file — see the
 *  long note in `applyEnemyHit`. The order above still holds, because that call happens between
 *  the two emits this file does own.
 *  A shot that hits nothing emits only `weapon:fired`. The tracer's endpoint for a clean miss
 *  is therefore `origin + direction * weapon.def.range`.
 *
 *  EVENT PAYLOAD VECTORS ARE SHARED SCRATCH. Read them inside your handler; never retain one.
 *  This is the same convention `main.ts` already relies on for `player:damaged`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ZERO ALLOCATION. Everything below runs on module-level scratch (`_`-prefixed) and one reused
 * `DamageInfo`. A shotgun firing 8 pellets into a crowd allocates nothing.
 */

import { Vector3 } from 'three';
import type {
  BodyPart, Damageable, DamageInfo, EnemyHit, GameCtx, RNG, WeaponDef, WeaponInstance,
} from '@/core/types';
import { clamp01 } from '@/core/mathx';
import { PLAYER, WEAPON } from '@/game/tuning';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scratch
// ─────────────────────────────────────────────────────────────────────────────────────────────

const _dir = new Vector3();
const _point = new Vector3();
const _normal = new Vector3();
const _up = new Vector3();
const _right = new Vector3();

/** One reusable damage packet. Enemies must consume it synchronously. */
const _damage: DamageInfo = {
  amount: 0,
  point: new Vector3(),
  normal: new Vector3(),
  direction: new Vector3(),
  part: 'torso',
  isCrit: false,
  knockback: 0,
  weaponId: '',
  affix: 'none',
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Damage model
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Range falloff. Full damage out to `WEAPON.falloffStart` of the weapon's range, then a linear
 * ramp to `def.falloff` at max range, then flat.
 *
 * Linear, not a curve, and that is a design choice: a player has to be able to feel where a
 * weapon stops working, and a linear ramp between two numbers printed in the def is something
 * you can learn by shooting things. A smooth curve hides the edge.
 */
export function falloffAt(def: WeaponDef, distance: number): number {
  const start = def.range * WEAPON.falloffStart;
  if (distance <= start) return 1;
  const t = clamp01((distance - start) / Math.max(def.range - start, 1e-3));
  return 1 + (def.falloff - 1) * t;
}

/**
 * Body-part multiplier.
 *
 * The head term is `def.headshotMult` re-based through the player's `critMult`, so a weapon
 * states its own crit character (a marksman is 4×, the pistol is 2.5×) while a boon that raises
 * `critMult` still scales every weapon proportionally. `PLAYER.critMult` is the baseline the
 * def's number was authored against.
 */
export function partMultiplier(def: WeaponDef, part: BodyPart, critMult: number): number {
  if (part === 'head') return def.headshotMult * (critMult / Math.max(PLAYER.critMult, 1e-3));
  if (part === 'limb') return WEAPON.limbMult;
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shot description
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Everything one trace needs. Filled in by the service, reused every shot. */
export interface ShotParams {
  weapon: WeaponInstance;
  def: WeaponDef;
  origin: Vector3;
  /** Unit direction, already scattered by the spread cone. */
  direction: Vector3;
  /** `stats.damageMult` × active-reload buff × ghost-bullet penalty × `WEAPON.damageScale`. */
  damageMult: number;
  /** `stats.critMult`. */
  critMult: number;
}

/** What came of it. Reused — copy anything you keep. */
export interface ShotResult {
  /** How many enemies were damaged. */
  targets: number;
  crits: number;
  kills: number;
  /** True if the trace ended on world geometry. */
  hitWorld: boolean;
  /** Where the trace ended — the tracer's far end. */
  readonly end: Vector3;
  /** Distance to the first thing hit, or the weapon's range on a clean miss. */
  distance: number;
}

const _result: ShotResult = {
  targets: 0,
  crits: 0,
  kills: 0,
  hitWorld: false,
  end: new Vector3(),
  distance: 0,
};

/**
 * Persistent hit buffer handed to `EnemyService.raycast`. Kept at module scope so the array
 * itself is never reallocated; the enemy service owns what it puts inside.
 */
const _enemyHits: EnemyHit[] = [];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The trace
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Fire one ray. Emits `hit:enemy` (near → far) and/or `hit:world`, applies hitstop, and returns
 * a description of what happened so the caller can do the bookkeeping (ammo refunds, kill
 * trauma) that is a *weapon* concern rather than a *ballistics* one.
 *
 * THE NEARER-WINS RULE, which is the subtle part: we ask the enemies for every hit along the
 * ray up front, then walk them in order and stop the instant one lies *behind* the world hit.
 * Doing it the other way round — world first, then enemies clipped to it — reads identically
 * 99% of the time and then fails exactly when a zombie is standing in a doorway.
 */
export function traceShot(ctx: GameCtx, p: ShotParams): ShotResult {
  const def = p.def;
  const r = _result;
  r.targets = 0;
  r.crits = 0;
  r.kills = 0;
  r.hitWorld = false;
  r.distance = def.range;
  r.end.copy(p.origin).addScaledVector(p.direction, def.range);

  _dir.copy(p.direction);

  // ── world first, as a DEPTH LIMIT (the damage still resolves enemy-first) ────────────────
  const world = ctx.world.raycast(p.origin, _dir, def.range);
  const worldDistance = world.hit ? world.distance : Number.POSITIVE_INFINITY;
  if (world.hit) {
    _point.copy(world.point);
    _normal.copy(world.normal);
  }

  // ── enemies ─────────────────────────────────────────────────────────────────────────────
  const wanted = Math.min(def.penetration + 1, WEAPON.maxTraceHits);
  const count = ctx.enemies.raycast(p.origin, _dir, def.range, wanted, _enemyHits);

  let pierced = 0;
  /**
   * The distinction that matters: a shot can stop because it buried itself in a body (no wall
   * impact) or because the wall was in front of the enemy all along (wall impact, no enemy).
   * Collapsing those two into one "blocked" flag eats the impact on every shot fired at a
   * zombie standing behind cover — visible as bullets that vanish.
   */
  let stoppedInBody = false;

  for (let i = 0; i < count && i < _enemyHits.length; i++) {
    const h = _enemyHits[i];
    if (!h || !h.enemy) continue;
    // The wall is nearer than this enemy: the bullet never got here, and neither does the loop.
    if (h.distance >= worldDistance) break;

    applyEnemyHit(ctx, p, h, pierced, r);
    pierced++;

    if (pierced > def.penetration) { stoppedInBody = true; break; }
  }

  // ── the world hit only lands if the shot actually reached it ────────────────────────────
  if (world.hit && !stoppedInBody) {
    r.hitWorld = true;
    if (r.targets === 0) r.distance = world.distance;
    r.end.copy(_point);
    ctx.events.emit('hit:world', {
      point: _point,
      normal: _normal,
      surface: world.surface,
      kind: 'bullet',
    });
  }

  return r;
}

function applyEnemyHit(
  ctx: GameCtx, p: ShotParams, h: EnemyHit, pierceIndex: number, r: ShotResult,
): void {
  const def = p.def;
  const target: Damageable = h.enemy;
  const part: BodyPart = h.part;
  const isCrit = part === 'head';

  // Each successive body a shot passes through eats some of it. `Math.pow` with a tiny integer
  // exponent is cheaper than it looks and the penetration count is bounded by `maxTraceHits`.
  let pierceMult = 1;
  for (let i = 0; i < pierceIndex; i++) pierceMult *= WEAPON.penetrationDamageMult;

  const amount = def.damage
    * falloffAt(def, h.distance)
    * partMultiplier(def, part, p.critMult)
    * p.damageMult
    * pierceMult;

  _damage.amount = amount;
  _damage.point.copy(h.point);
  _damage.normal.copy(h.normal);
  _damage.direction.copy(p.direction);
  _damage.part = part;
  _damage.isCrit = isCrit;
  /**
   * `DamageInfo.knockback` is a DIMENSIONLESS SCALE, not an impulse and not a damage figure.
   *
   * INTEGRATION FIX (BUILD 003). This used to be `amount`, on the reading that the enemy would
   * turn damage into shove. The enemy does exactly that — `ENEMY.knockbackPerDamage` is "the
   * knockback impulse PER UNIT OF DAMAGE" and `reactions.applyHit` computes
   * `amount * knockbackPerDamage * knockbackScale / mass` — so passing the amount a second time
   * SQUARED it. A 105-damage headshot resolved to 105 × 0.035 × 105 = 386 m/s of impulse and
   * punted the zombie clean out of the arena. Measured in-browser: one headshot moved a shambler
   * from 13 m to 34 m to 65 m away, which is also why every follow-up shot in the burst missed.
   * The enemy's own call sites already used this convention (`damageSphere` passes 1, melee 0).
   */
  _damage.knockback = 1;
  _damage.weaponId = def.id;
  _damage.affix = def.affix;

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // `takeDamage` IS the emission of `hit:enemy`.
  //
  // INTEGRATION FIX (BUILD 003). This function used to emit `hit:enemy` itself, right here,
  // after the call below — and `EnemySystem.damage()` emits it too, for every path into an
  // enemy's health ("there is no quiet damage"). Both were correct in isolation and together
  // they fired the event TWICE per bullet: two hit markers, two blood sprays, two damage
  // numbers stacked on one another, two hitmark sounds, and a `remainingHealth` on the second
  // copy that the weapon could only read structurally off a contract that has no health field.
  // Measured in-browser: one aimed headshot produced two identical `hit:enemy` events.
  //
  // The enemy owns it, and must: splash (`damageSphere`), chain lightning and melee-reflect
  // damage never pass through this file at all, so an emit here can only ever be a partial
  // truth. The weapon still learns everything it needs from `target.alive`.
  // ═════════════════════════════════════════════════════════════════════════════════════════
  target.takeDamage(_damage);

  const killed = !target.alive;

  r.targets++;
  if (isCrit) r.crits++;
  if (killed) r.kills++;
  // `distance` is to the FIRST thing hit (falloff, audio); `end` is the LAST (the tracer's tip).
  if (r.targets === 1) r.distance = h.distance;
  r.end.copy(h.point);

  // HITSTOP — the cheapest heaviness there is (ART §5, GAME_BIBLE §8). Kill beats crit beats
  // body, and `Time.hitstop` stacks by max, so a penetrating shot through three zombies gives
  // one crisp freeze rather than a slideshow.
  const stop = killed ? WEAPON.hitstopKill : isCrit ? WEAPON.hitstopCrit : WEAPON.hitstopBody;
  ctx.time.hitstop(stop);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Ray construction
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Build one shot's direction: the player's aim, scattered inside `cone`.
 *
 * The origin is `player.eye` and the aim is `player.lookDir` — the camera's AIM angles, which
 * deliberately exclude bob and shake. A shooter where the screen rattle moved your bullets
 * would be unplayable, and `player/camera.ts` already draws that line for us.
 */
export function buildShotDirection(out: Vector3, aim: Vector3, cone: number, rng: RNG): Vector3 {
  out.copy(aim).normalize();
  if (cone <= 0) return out;

  if (Math.abs(out.y) < 0.9) _right.set(0, 1, 0);
  else _right.set(1, 0, 0);
  _up.crossVectors(out, _right).normalize();
  _right.crossVectors(_up, out).normalize();

  const angle = rng.next() * Math.PI * 2;
  const radius = Math.tan(cone) * Math.sqrt(rng.next());
  out.addScaledVector(_up, Math.cos(angle) * radius);
  out.addScaledVector(_right, Math.sin(angle) * radius);
  return out.normalize();
}

/** Point `distance` along a ray, into `out`. */
export function pointAlong(out: Vector3, origin: Vector3, dir: Vector3, distance: number): Vector3 {
  return out.copy(origin).addScaledVector(dir, distance);
}

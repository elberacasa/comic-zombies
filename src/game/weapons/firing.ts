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
 * ZERO ALLOCATION. Everything below runs on module-level scratch (`_`-prefixed): the vectors, one
 * reused `DamageInfo`, one reused `hit:world` payload. A shotgun firing 8 pellets into a crowd
 * allocates nothing — that claim was aspirational until BUILD 009, when the payload literal that
 * broke it was hoisted out.
 */

import { Vector3 } from 'three';
import type {
  BodyPart, Damageable, DamageInfo, EnemyHit, GameCtx, ImpactKind, RNG, SurfaceKind, WeaponDef,
  WeaponInstance,
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

/**
 * One reusable `hit:world` payload.
 *
 * The header above already promises consumers that the payload VECTORS are shared scratch, and
 * the bus is synchronous (`Emitter.emit` calls every handler inline), so the wrapper object can
 * be shared on exactly the same terms — nobody may retain it, and nobody does: the VFX handler
 * copies `point`/`normal` into `_v`/`_n` on entry, the audio handler reads `point.x/y/z` straight
 * into `engine.play`. `point` and `normal` are permanently aliased to the module scratch the
 * trace already fills, so an emit writes ONE field.
 *
 * Worth an object: the boomstick fires 8 pellets per trigger pull and each one that reaches a
 * wall emitted a fresh literal — 8 objects per pull, at 90 rpm, forever.
 */
const _worldHit: { point: Vector3; normal: Vector3; surface: SurfaceKind; kind: ImpactKind } = {
  point: _point,
  normal: _normal,
  surface: 'concrete',
  // Every emit from this file is a bullet. If a future launcher branch lands here it must set
  // this field per shot rather than assume it.
  kind: 'bullet',
};

/**
 * HITSTOP RATE LIMIT (BUILD 009 — "the SMG lags the whole game when firing").
 *
 * The minimum real-time gap between two REQUESTED hitstops, and the reason it is 0.13 s: that is
 * the pistol's own cadence (400 rpm semi ⇒ 150 ms cap, ~200 ms in a human hand), which is what
 * `hitstopBody` 0.02 / `hitstopCrit` 0.045 were authored against. The pistol therefore comes out
 * byte-identical — it can never fire fast enough to be gated.
 *
 * WHAT IT FIXES. One hitstop costs its freeze plus `HITSTOP_RECOVERY` 0.055 s of ramp-back
 * (core/time.ts) = 75 ms of degraded world time for a body hit. `ratatat` is 900 rpm, i.e. a
 * 66.7 ms interval — SHORTER than one cycle — so every shot re-armed the freeze before the
 * previous had recovered and the world never returned to scale 1 while the trigger was held.
 * Integrated over the easeOutExpo recovery that is ~59% world speed on a stream of body hits and
 * ~23% on a stream of headshots (45 ms freeze inside a 66.7 ms window), with the sim accumulator
 * seeing `HITSTOP_FLOOR` 0.02 during each freeze — zero fixed steps, so the PLAYER's own movement
 * stopped ~15 times a second. The frame rate was never the problem; the world clock was.
 *
 * WHAT IT COSTS. Nothing below ~460 rpm (1 / 0.13 s = 7.7 shots/s) — inkslinger 400, boomstick
 * 90 and longshot 55 are all under that line and come out unchanged. The freeze itself is never
 * shortened either; only how often a gun may ask for one. Integrating the recovery curve over a 130 ms window gives, for
 * sustained fire at any rate: 79% average world speed on body hits (was 59%) and 60% on
 * headshots (was 23%). The number that actually matters is not the average though — it is that
 * every window now ends with 30–55 ms at exactly scale 1.0, so the fixed accumulator always gets
 * real steps and the player never stops moving.
 *
 * Deliberately at the REQUEST, not in `Time.hitstop`: the nuke, the explosion and the death cam
 * ask for freezes through the same call and must not be throttled by a gun's cadence.
 *
 * Lives in `WEAPON.hitstopMinGap` next to the three durations it governs — it is a feel value and
 * feel values belong in `tuning.ts` where they can be found and tuned together.
 */

/** `time.unscaledElapsed` of the last hitstop this file requested. */
let _lastHitstopAt = -1e9;

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
    // `_worldHit.point` / `.normal` ARE `_point` / `_normal`, already filled above.
    _worldHit.surface = world.surface;
    ctx.events.emit('hit:world', _worldHit);
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
  //
  // RATE-LIMITED at the request — see `WEAPON.hitstopMinGap`. A KILL is always let through: it is the
  // beat the whole feel is built around, and it self-limits (you cannot kill faster than zombies
  // die). It still stamps the clock, so the next body freeze is pushed a full gap past it.
  //
  // …AND SO IS EVERY OTHER HIT OF THE SAME TRIGGER PULL (`sameFrame`). Without this the gate
  // silently broke the "kill beats crit beats body" line above, which is the whole point of the
  // paragraph: `boomstick` throws 8 pellets and `longshot` penetrates 3 bodies, all resolved
  // inside ONE `fireShot` call, and only the FIRST of them cleared the gate. A blast whose
  // pellet 1 hit a torso and pellet 3 hit a skull got the 0.02 body freeze and threw the 0.045
  // crit freeze away — the shotgun headshot, the single most satisfying thing in the arsenal,
  // stopped feeling different from a chest shot.
  //
  // It costs nothing, because this is a max-stack and not a new freeze: `Time.hitstop` only ever
  // RAISES `_hitstop` (`if (s > this._hitstop)`), so N requests inside one frame produce exactly
  // one freeze of the largest of them — which is what the header has always promised. And the
  // window is genuinely one trigger pull: `service.ts::tryFire` calls `fireShot` at most once per
  // update, so `unscaledElapsed` (advanced once per frame, never mid-frame) cannot span two
  // pulls even at 15 fps.
  //
  // `unscaledElapsed` is the right clock here: this whole file runs on the trigger's unscaled
  // frame time (the service header states that rule), and gating on scaled time would mean the
  // freeze slows down its own gate. `Time.reset()` zeroes the clock, so a `now` behind the stamp
  // means the clock restarted — take the shot rather than sulk for 0.13 s into a new run.
  const stop = killed ? WEAPON.hitstopKill : isCrit ? WEAPON.hitstopCrit : WEAPON.hitstopBody;
  const now = ctx.time.unscaledElapsed;
  const sameFrame = now === _lastHitstopAt;
  if (killed || sameFrame || now - _lastHitstopAt >= WEAPON.hitstopMinGap || now < _lastHitstopAt) {
    _lastHitstopAt = now;
    ctx.time.hitstop(stop);
  }
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

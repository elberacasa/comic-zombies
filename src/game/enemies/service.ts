/**
 * ENEMY SERVICE — the `EnemyService` + `System` implementation. The horde.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PERFORMANCE CONTRACT — 25 alive inside a shared 350-call / 900k-triangle frame.
 *
 *  The arena already spends 129–159 draw calls and 416–645 k triangles (measured, BUILD 002).
 *  A viewmodel and a VFX system are still to land. So the horde's budget is not "the rest of
 *  350" — it is a hard ~50 calls, and everything below is built around that number.
 *
 *      body mesh + inverted hull   2 draw calls  per zombie   (see body.ts for how)
 *      ~2.0 k triangles            both meshes   per zombie
 *      25 alive                    50 calls · ~50 k triangles · ~5.5 % of the triangle budget
 *
 *  SIM COST is the other half, and it is bought with scheduling rather than with cleverness:
 *
 *      `world.steer()` is SEVEN octree raycasts. 25 enemies × 120 Hz = 21 000 rays/second —
 *      more than the player's entire movement solver. Steering decisions therefore run at
 *      `SCHED.steerHz` (10 Hz) on a round-robin slice: 2–3 enemies re-decide per fixed step,
 *      and every enemy integrates its existing heading on every step. Ground probes run at
 *      12 Hz and hard capsule corrections at 24 Hz, both sliced the same way.
 *      Net: ~1 750 rays/second instead of 21 000, and movement is still perfectly smooth,
 *      because only the DECISION is staggered — never the integration.
 *
 *  ZERO ALLOCATION. Every body, material, matrix, hitbox vector and event payload object is
 *  built during `init()`. Nothing in `fixedUpdate`, `update`, `raycast`, `querySphere`,
 *  `damageSphere` or `takeDamage` constructs anything. Spawning mid-fight cannot hitch.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS SYSTEM EMITS — and it never calls the VFX or audio services directly, because those
 * are built in parallel and coupling to them would undo the whole point of the event bus:
 *
 *      enemy:spawned      every spawn
 *      hit:enemy          EVERY bullet, with `remainingHealth` and `killed`
 *      enemy:dismembered  a limb's own health pool ran out
 *      enemy:killed       health reached zero, with `byCrit` and the killing `part`
 *      enemy:attacked     a melee swing connected (the player is damaged directly, via the
 *                         `PlayerService` contract, which is a `core/types.ts` interface and not
 *                         another system's implementation)
 *      fx:sound           groans, wind-up, swing, flesh hit, death — recipe ids, no samples
 *
 * DEBUG: `Z` spawns five around the player, `X` fills to 25 for a perf reading, `B` kills the
 * horde. Registered here rather than in `main.ts` so the milestone is playable without the
 * integrator having to own a gameplay hotkey.
 */

import { Group, Vector3 } from 'three';
import type {
  BodyPart, DamageInfo, Damageable, EnemyHit, EnemyKind, EnemyService, GameCtx, System,
} from '@/core/types';
import { PALETTE } from '@/art/palette';
import { Rng } from '@/core/rng';
import { TAU, clamp, clamp01, damp, lambdaFromHalfLife, lerp, smoothstep } from '@/core/mathx';
import {
  applyGravity, makeMotionParams, moveBody, type MotionParams,
} from '@/game/motion';
import { ENEMY } from '@/game/tuning';
import { NAV_CLIMB, NAV_DROP, NAV_WALK, buildNav, type NavGraph } from '@/world/nav';
import {
  ANIM, BODY, BONE, HITBOX, LIMB_BONES, LIMB_CAPSULES, LIMB_COUNT, LIMB_SEGMENTS, NAV,
  OUTLINE, POOL, SCHED, SPEED_TIERS, VARIANTS, defFor, rollTier,
  type EnemyDef, type EnemyStateName,
} from '@/game/enemies/defs';
import { EnemyBody, buildEnemyGeometry, type EnemyGeometrySet, type PoseArgs } from '@/game/enemies/body';
import { HitReactions } from '@/game/enemies/reactions';
import {
  crowdInto, detourInto, enter, integrateVelocity, stateSpeedMult, steerInto, stepState,
  strikeConnects, tickUnstick, turnToward, type AiAgent, type Neighbour,
} from '@/game/enemies/ai';

// ═════════════════════════════════════════════════════════════════════════════
// Module scratch. Nothing in a hot path allocates.
// ═════════════════════════════════════════════════════════════════════════════

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _sep = new Vector3();
/** The conga follow heading — a unit vector at the body I am queueing behind, or zero. */
const _follow = new Vector3();
const _toPlayer = new Vector3();
const _capA = new Vector3();
const _capB = new Vector3();
const _rayP = new Vector3();
const _segQ = new Vector3();
/** Where the nav graph says to walk next, and the hop after it (string-pulling). */
const _navA = new Vector3();
const _navB = new Vector3();
/** The node the body is currently standing on — the corridor pull's anchor. */
const _navC = new Vector3();
const _poseArgs: PoseArgs = {
  gait: 0, speed01: 0, state: 'chase', windup01: 0, strike01: 0, targetDist: 99,
  leanX: 0, leanZ: 0, shudder: 0, spawn01: 1, death01: 0, climb01: 0,
};

/** Candidate headings the wedge rescue sweeps around the player, starting directly behind. */
const RESCUE_HEADINGS = 8;

/**
 * Hitbox anchor slots, in the order `Enemy.hWorld` stores them.
 *
 * ═══ A LIMB IS TWO CAPSULES NOW, NOT ONE ═══
 * BUILD 007 shipped one shoulder→hand capsule per limb, which the rig agent flagged as the next
 * change. It matters because the capsule is a straight tube between the two ends: with the elbow
 * bent — which is every reaching, swinging or dragging pose the animator wrote — that tube
 * leaves the arm entirely and hangs in the air in front of the chest. A bullet through empty
 * space scored a limb hit, and the shot that visibly clipped the forearm missed. Splitting at
 * the elbow and the knee costs at most four extra ray/capsule tests on a body whose head AND
 * torso have already been missed, and it is the difference between a hitbox you can learn and
 * one you cannot.
 */
const H_HEAD = 0;
/** The second head primitive: the jaw. Scores `'head'` — the chin is not a body shot. */
const H_JAW = 1;
const H_TORSO_A = 2;
const H_TORSO_B = 3;
/**
 * Limb capsule `s` (`s = limb * LIMB_SEGMENTS + 0|1|2`, upper → mid → tip) occupies
 * `H_LIMB + s * 2` and `+ 1`.
 */
const H_LIMB = 4;
const H_COUNT = H_LIMB + LIMB_CAPSULES * 2;

// ═════════════════════════════════════════════════════════════════════════════
// Ray tests — allocation-free, scalar where it matters.
// ═════════════════════════════════════════════════════════════════════════════

/** Nearest positive ray/sphere intersection distance, or -1. `d` must be normalised. */
function raySphere(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number,
  r: number, maxD: number,
): number {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  const hit = t < 0 ? 0 : t;
  return hit <= maxD ? hit : -1;
}

/**
 * Ray vs capsule (segment `a`→`b`, radius `r`). Returns the hit distance or -1, and writes the
 * surface point into `outP` and the outward normal into `outN`.
 *
 * Closest-approach form rather than the full quadric: a capsule's exact entry point matters to
 * within a centimetre for a hit that is about to be scored in whole numbers of damage, and this
 * costs a third of the flops.
 */
function rayCapsule(
  o: Vector3, d: Vector3, a: Vector3, b: Vector3, r: number, maxD: number,
  outP: Vector3, outN: Vector3,
): number {
  const vx = b.x - a.x, vy = b.y - a.y, vz = b.z - a.z;
  const wx = o.x - a.x, wy = o.y - a.y, wz = o.z - a.z;
  const bb = d.x * vx + d.y * vy + d.z * vz;
  const cc = vx * vx + vy * vy + vz * vz;
  const dd = d.x * wx + d.y * wy + d.z * wz;
  const ee = vx * wx + vy * wy + vz * wz;
  const den = cc - bb * bb;

  let t: number;
  if (den > 1e-8) t = (bb * dd - ee) * -1 / den;
  // Parallel: pin the ray at its origin and take the closest point on the segment to it.
  else t = cc > 1e-8 ? ee / cc : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  let s = bb * t - dd;
  s = s < 0 ? 0 : s > maxD ? maxD : s;

  _rayP.set(o.x + d.x * s, o.y + d.y * s, o.z + d.z * s);
  _segQ.set(a.x + vx * t, a.y + vy * t, a.z + vz * t);
  const dist2 = _rayP.distanceToSquared(_segQ);
  if (dist2 > r * r) return -1;

  const back = Math.sqrt(Math.max(0, r * r - dist2));
  const hit = Math.max(0, s - back);
  if (hit > maxD) return -1;

  outP.set(o.x + d.x * hit, o.y + d.y * hit, o.z + d.z * hit);
  outN.copy(outP).sub(_segQ);
  if (outN.lengthSq() < 1e-8) outN.copy(d).negate();
  else outN.normalize();
  return hit;
}

// ═════════════════════════════════════════════════════════════════════════════
// One zombie
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A pooled enemy. Implements `Damageable` (the frozen contract the weapon system shoots at),
 * `AiAgent` (what `ai.ts` steers) and `Neighbour` (what separation reads) — all structurally,
 * so no module has to import another's implementation.
 */
class Enemy implements Damageable, AiAgent, Neighbour {
  readonly id: number;
  readonly body: EnemyBody;
  readonly reactions = new HitReactions();

  /** FEET position. Same convention as `PlayerService.position`. */
  readonly position = new Vector3();
  /**
   * XZ is the steering velocity `ai.ts` integrates; **Y is now real vertical velocity**, owned
   * by the shared mover in `game/motion`. Nothing in `ai.ts` reads or writes `.y`, so the horde
   * gained gravity without the steering model changing by a line.
   */
  readonly velocity = new Vector3();
  readonly desired = new Vector3(0, 0, -1);
  /** `MotionBody`: normal of whatever this body is standing on. */
  readonly groundNormal = new Vector3(0, 1, 0);
  /** `MotionBody`: DERIVED from the collision result every fixed step. Never remembered. */
  grounded = true;
  /**
   * `MotionBody`: vertical debt owed to presentation by a step-up. The collider snaps up the
   * kerb; the drawn body — and its hitboxes, so what you see stays what you hit — trails it.
   */
  stepSmear = 0;
  /** Knockback lives outside `velocity` so the steering clamp cannot instantly eat it. */
  readonly push = new Vector3();

  kind: EnemyKind = 'shambler';
  def: EnemyDef;
  alive = false;
  /**
   * True while this body is sitting in the free list. The pool's own double-free interlock:
   * `recycle()` early-returns when it is already set, so no amount of re-entrancy can put the
   * same object in `free` twice and hand it to two `_alive` slots on a later `spawn()`.
   */
  pooled = true;
  health = 0;
  maxHealth = 0;

  state: EnemyStateName = 'chase';
  stateT = 0;
  attackT = 0;
  cooldownT = 0;
  distToPlayer = 999;
  heightToPlayer = 0;
  staggerT = 0;
  canMelee = true;
  swingJitter = 1;
  yaw = 0;

  /**
   * SPEED TIER index into `SPEED_TIERS` — walk / walker / runner / sprinter, rolled at spawn
   * from `TIER_MIX[round]`. This is the CoD mechanic that turns the horde from slow-and-
   * inevitable into a genuine threat; see the long note above `SPEED_TIERS` in defs.ts.
   */
  tier = 0;
  /** `SPEED_TIERS[tier].lungeMult`, cached so the hot loop does not index the table. */
  lungeMult = 1;

  /** Chase speed for THIS instance: def × director scale × tier × per-instance jitter. */
  baseSpeed = 1;
  radius: number = BODY.radius;
  height: number = BODY.height;
  groundY = 0;
  /** Continuous gait phase, advanced by distance travelled. */
  gait = 0;

  /** `AiAgent` unstick state — owned entirely by `ai.ts::tickUnstick`. */
  wedgeT = 0;
  wedgeSampleT = 0;
  wedgeRefX = 0;
  wedgeRefZ = 0;
  detourT = 0;
  detourSign = 1;
  wedgeTrips = 0;

  // ── NAVIGATION (BUILD 005) ───────────────────────────────────────────────
  /**
   * True while this body is taking its heading from the nav graph instead of straight from the
   * player. Entered when the player is more than `NAV.heightTrigger` above/below it, or when it
   * has physically wedged; left again with hysteresis so it cannot chatter on a stair.
   */
  navMode = false;
  /** Minimum time left in graph mode. */
  navHoldT = 0;
  /** Seconds into the current ledge climb, and how long this particular ledge takes. */
  climbT = 0;
  climbDur = 1;
  /** Cooldown after a climb, so a body that lands on a lip cannot re-enter it every step. */
  climbCoolT = 0;
  readonly climbFrom = new Vector3();
  readonly climbTo = new Vector3();
  /** Last XZ at which this body was PROVEN to be standing on its own `groundY`. */
  supportX = 0;
  supportZ = 0;
  /** True when the route's next step is a deliberate DROP, so the ledge guard stands aside. */
  navDropOk = false;
  /** Graph distance to the player at the last route decision. `Infinity` if unrouted. */
  navCost = Infinity;

  /** The 12 Hz pose clock tick this body is currently HOLDING. */
  poseTick = -1;
  /** Snapshot of every pose input, taken on a tick and held until the next one (ART §8). */
  heldGait = 0;
  heldSpeed01 = 0;
  heldDist = 99;
  heldLeanX = 0;
  heldLeanZ = 0;
  heldShudder = 0;

  /** World-space hitbox anchors, refreshed once per frame. */
  readonly hWorld: Vector3[] = [];
  /** Enemy-local hitbox anchors, refreshed on the pose tick. */
  readonly hLocal: Vector3[] = [];
  readonly limbLive = [true, true, true, true];
  /**
   * PER-INSTANCE hitbox radii, metres, refreshed on the pose tick from `rig.boneRadius()`.
   *
   * They are not `HITBOX.<x> * (height / BODY.height)` any more. That ratio only carries the
   * variant's overall scale and misses its per-chain girth roll entirely — see the note on
   * `HITBOX.headBindRadius`. A `bloated` head is authored 1.20× and was getting a hitbox 17%
   * narrower than the skull the player is aiming at.
   */
  headRadius: number = HITBOX.headRadius;
  jawRadius: number = HITBOX.jawRadius;
  torsoRadius: number = HITBOX.torsoRadius;
  /** One radius per limb capsule, in `H_LIMB` order (upper R, lower R, upper L, lower L, …). */
  readonly limbRadius = new Float32Array(LIMB_CAPSULES);

  /** Set by `raycast()` so `takeDamage()` knows WHICH limb the trace actually hit. */
  pendingLimb = -1;
  pendingLimbFrame = -1;

  nextGroan = 0;
  /** Round-robin slot, so the scheduler spreads the expensive queries across fixed steps. */
  slot = 0;

  /** Bound by the service at construction. An `Enemy` deliberately owns no services. */
  private readonly onDamage: (self: Enemy, info: DamageInfo) => void;

  constructor(
    id: number, body: EnemyBody, def: EnemyDef,
    onDamage: (self: Enemy, info: DamageInfo) => void,
  ) {
    this.id = id;
    this.body = body;
    this.def = def;
    this.onDamage = onDamage;
    for (let i = 0; i < H_COUNT; i++) {
      this.hWorld.push(new Vector3());
      this.hLocal.push(new Vector3());
    }
  }

  /** Chest height, world space — where a word pop, a hit spark or a groan belongs. */
  chestPoint(out: Vector3): Vector3 {
    return out.set(this.position.x, this.position.y + this.height * 0.62, this.position.z);
  }

  /** The `Damageable` entry point the weapon system shoots at. */
  takeDamage(info: DamageInfo): void {
    this.onDamage(this, info);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The system
// ═════════════════════════════════════════════════════════════════════════════

interface RingHit {
  enemy: Damageable;
  point: Vector3;
  normal: Vector3;
  distance: number;
  part: BodyPart;
}

export class EnemySystem implements System, EnemyService {
  readonly name = 'enemies';

  readonly group = new Group();

  private ctx: GameCtx | null = null;
  private geo: EnemyGeometrySet | null = null;
  private readonly rng = new Rng(0x5a11b1e);

  /**
   * THE NAVIGATION LAYER. Public so the console can interrogate it (`CZ.enemies.nav.stats`,
   * `CZ.enemies.navProbe(...)`) — a graph you cannot inspect is a graph you cannot trust.
   *
   * Built once, in `init`, off the collision octree. `world/nav.ts` is a LIBRARY, not a game
   * system: it holds no per-frame state of its own beyond the field it is asked to compute, and
   * it depends on a two-method `NavProbe` shape rather than on `WorldService`. Importing it here
   * is therefore not a system-to-system dependency (ARCHITECTURE §1) — it is the same kind of
   * import `body.ts` already makes of `@/world/lighting`.
   *
   * NOTE FOR THE LEAD: the ideal home for this is `WorldService`, so `ctx.world.nav` would hand
   * it to anyone who needs it. That is a `core/types.ts` change and `core/types.ts` is frozen,
   * so the graph is built and owned by the only system that currently needs it. If a second
   * consumer appears (a director wanting reachability, a boon that spawns on a route), promote
   * `nav` onto `WorldService` and delete this paragraph.
   */
  nav: NavGraph | null = null;

  /** Agents that asked for a route this step. At zero the flow field does not run at all. */
  private navDemand = 0;
  /**
   * Live bodies that are chasing, out of the fight, and asking for effectively no speed. This is
   * the shape of the BUILD 005 blocker (a body frozen under an elevated player by the contact
   * standoff) and the only reason it survived a milestone is that nothing put it on screen. It
   * must read 0. See `ai.ts::contactFactor`.
   */
  private frozenCount = 0;
  /**
   * Set by `beginClimb`. The step loop reads it to know that the body it was about to move has
   * just been handed to the climb instead — a plain `e.state === 'climb'` re-read there is not
   * enough, because control flow analysis has already narrowed `state` past that possibility.
   */
  private climbCommitted = false;

  /**
   * The shared solver's settings, ONE instance mutated in place. 25 bodies × 120 Hz means a
   * per-call object would be 3 000 allocations a second in the hottest loop in the game.
   */
  private readonly motion: MotionParams = makeMotionParams();

  private readonly pool: Enemy[] = [];
  private readonly free: Enemy[] = [];
  private readonly _alive: Enemy[] = [];
  /** Bodies holding their death pose before the slot recycles. Not `alive`, still drawn. */
  private readonly dying: Enemy[] = [];

  private readonly hitRing: RingHit[] = [];
  private hitIndex = 0;
  /** Scratch used by `raycast` to sort candidates. Sized to the pool, never grown. */
  private readonly candIdx: number[] = [];
  private readonly candDist: number[] = [];
  private readonly candPart: BodyPart[] = [];
  private readonly candPoint: Vector3[] = [];
  private readonly candNormal: Vector3[] = [];
  private readonly candLimb: number[] = [];

  private frameStamp = -1;
  private stepCount = 0;
  private variantCursor = 0;

  /**
   * THE ROUND, as the horde knows it — the only input to the speed-tier roll.
   *
   * It arrives on `round:start` rather than as a `spawn()` argument because `EnemyService` is
   * frozen in `core/types.ts` and `spawn(kind, position, hpScale, speedScale)` has no room for
   * it. NOTE FOR THE LEAD: if the contract ever reopens, a fifth `round` argument is strictly
   * better than this listener — the director already knows the number and passing it removes an
   * ordering assumption (a spawn racing ahead of `round:start` would roll on the old mix).
   * `RoundSystem` emits `round:start` before its first `roundOpenDelay` elapses, so today that
   * race cannot happen.
   */
  private _round = 1;
  private offRound: (() => void) | null = null;

  /** Live count per `SPEED_TIERS` index. Debug/harness only; recomputed on demand. */
  readonly tierCounts = new Int32Array(SPEED_TIERS.length);

  /** Reusable payloads. Emitting must not allocate — this runs on every bullet. */
  private readonly meleeInfo: DamageInfo = {
    amount: 0,
    point: new Vector3(),
    normal: new Vector3(),
    direction: new Vector3(),
    part: 'torso',
    isCrit: false,
    knockback: 0,
  };
  private readonly splashInfo: DamageInfo = {
    amount: 0,
    point: new Vector3(),
    normal: new Vector3(),
    direction: new Vector3(),
    part: 'torso',
    isCrit: false,
    knockback: 0,
  };
  private readonly evPos = new Vector3();
  private readonly evPos2 = new Vector3();

  private offKeys: (() => void) | null = null;

  // ── EnemyService ───────────────────────────────────────────────────────────

  get aliveCount(): number { return this._alive.length; }
  get all(): readonly Damageable[] { return this._alive; }

  // ── System ─────────────────────────────────────────────────────────────────

  init(ctx: GameCtx): void {
    this.ctx = ctx;
    this.group.name = 'enemies';
    // The horde lives in the scene root, not in `world.root`: the world owns static geometry
    // and its own lifetime, and a round reset must never be able to take the arena with it.
    ctx.scene.add(this.group);

    this.geo = buildEnemyGeometry();

    for (let i = 0; i < POOL.capacity; i++) {
      const variant = VARIANTS[i % VARIANTS.length];
      const body = new EnemyBody(this.geo, variant, PALETTE.ACID, 1);
      const e = new Enemy(i, body, defFor('shambler'), this.damage);
      e.slot = i;
      this.group.add(body.mesh);
      this.pool.push(e);
      this.free.push(e);
      this.candIdx.push(0);
      this.candDist.push(0);
      this.candPart.push('torso');
      this.candPoint.push(new Vector3());
      this.candNormal.push(new Vector3());
      this.candLimb.push(-1);
    }

    for (let i = 0; i < POOL.hitRing; i++) {
      this.hitRing.push({
        enemy: this.pool[0],
        point: new Vector3(),
        normal: new Vector3(),
        distance: 0,
        part: 'torso',
      });
    }

    // THE GRAPH. Built here, once, from the finished collision world — `world` is registered
    // before `enemies` (ARCHITECTURE §3), so the octree is complete by the time this runs.
    this.nav = buildNav(ctx.world, ctx.world.bounds);

    const g = this.geo;
    ctx.debug.watch('zombies', () => `${this._alive.length}/${ENEMY.maxAlive}`);
    ctx.debug.watch('nav', () => {
      const n = this.nav;
      if (!n) return '—';
      return `${n.stats.nodes}n ${n.stats.edges}e ${n.stats.climbs}c · ${n.stats.buildMs.toFixed(0)}ms`;
    });
    ctx.debug.watch('pathing', () => {
      let climbing = 0;
      for (const e of this._alive) if (e.state === 'climb') climbing++;
      return `${this.navDemand} routed / ${climbing} climbing`;
    });
    // The wedge made itself felt as "the round is broken" rather than seen. Now it is on screen:
    // `stuck` counts bodies currently accumulating a wedge, `detour` counts bodies working
    // their way out of one. Both should read 0 most of the time and never sit non-zero.
    ctx.debug.watch('stuck', () => {
      let stuck = 0;
      let detour = 0;
      for (const e of this._alive) {
        if (e.detourT > 0) detour++;
        else if (e.wedgeT > 0) stuck++;
      }
      return `${stuck} / detour ${detour}`;
    });
    ctx.debug.watch('frozen', () => `${this.frozenCount}`);
    // The tier mix is the milestone's headline mechanic and it is invisible in a screenshot,
    // so it goes on the debug overlay: slow → fast, live counts.
    ctx.debug.watch('tiers', () => {
      this.countTiers();
      let s = '';
      for (let i = 0; i < SPEED_TIERS.length; i++) {
        s += `${i > 0 ? '/' : ''}${this.tierCounts[i]}`;
      }
      return `${s} (R${this._round})`;
    });
    ctx.debug.watch('zombie draws', () => (this._alive.length + this.dying.length) * 2);
    ctx.debug.watch('zombie tris', () =>
      Math.round((this._alive.length + this.dying.length) * (g.triangles + g.hullTriangles)));

    this.offRound = ctx.events.on('round:start', (p) => { this._round = Math.max(1, p.round); });

    this.installDebugKeys(ctx);
  }

  /** Refresh `tierCounts` from the live horde. O(alive), no allocation. */
  countTiers(): void {
    this.tierCounts.fill(0);
    for (let i = 0; i < this._alive.length; i++) {
      const t = this._alive[i].tier;
      if (t >= 0 && t < this.tierCounts.length) this.tierCounts[t]++;
    }
  }

  /** The round the tier roll is using. Set by `round:start`; 1 before any director speaks. */
  get round(): number { return this._round; }
  set round(n: number) { this._round = Math.max(1, Math.floor(n)); }

  dispose(): void {
    this.offKeys?.();
    this.offKeys = null;
    this.offRound?.();
    this.offRound = null;
    for (const e of this.pool) e.body.dispose();
    this.pool.length = 0;
    this.free.length = 0;
    this._alive.length = 0;
    this.dying.length = 0;
    this.geo?.dispose();
    this.geo = null;
    this.nav = null;
    this.group.removeFromParent();
    this.group.clear();
  }

  /**
   * DETERMINISTIC SIM. Everything that decides where a zombie is, or whether it hit you, lives
   * here; `update` is presentation only.
   */
  fixedUpdate(dt: number, ctx: GameCtx): void {
    this.stepCount++;
    const steerEvery = Math.max(1, Math.round(1 / (SCHED.steerHz * dt)));
    // NOTE FOR THE LEAD: `SCHED.groundHz`, `SCHED.collideHz`, `SCHED.fallSpeed` and
    // `SCHED.climbSpeed` are now unread. They described the sampled ground-follow this build
    // deleted (see `ENEMY.gravity` in tuning.ts). `defs.ts` is not mine to edit — please strip
    // them there. `SCHED.steerHz` and the conga constants are still live and must stay.
    const smearLambda = lambdaFromHalfLife(ENEMY.stepSmoothHalfLife);
    const player = ctx.player.position;
    const now = ctx.time.elapsed;

    // ── THE FLOW FIELD. One budgeted Dijkstra sweep from the player's node serves the whole
    //    horde; an agent's query is then an array read. It only runs while somebody is actually
    //    asking (`navDemand`), which is only while somebody is above, below or wedged — so a
    //    flat fight against a flat-ground player pays exactly nothing for pathing. ────────────
    this.nav?.update(dt, player.x, player.y, player.z, this.navDemand, NAV.repathTime);
    let demand = 0;
    let frozen = 0;

    for (let i = 0; i < this._alive.length; i++) {
      const e = this._alive[i];

      // ── targeting ────────────────────────────────────────────────────────
      _toPlayer.set(player.x - e.position.x, 0, player.z - e.position.z);
      e.distToPlayer = _toPlayer.length();
      e.heightToPlayer = player.y - e.position.y;
      if (e.distToPlayer > 1e-4) _toPlayer.divideScalar(e.distToPlayer);
      e.canMelee = e.reactions.canMelee;
      e.staggerT = e.reactions.staggerT;
      e.reactions.step(dt);

      // ── THE CLIMB owns the body outright: no steering, no ground follow, no capsule
      //    correction. It is the one place in this system that moves a body THROUGH the
      //    world, which is exactly why it is a state and not a flag. ───────────────────
      if (e.state === 'climb') {
        this.stepClimb(e, dt, ctx);
        this.groan(e, ctx, now);
        continue;
      }
      if (e.climbCoolT > 0) e.climbCoolT = Math.max(0, e.climbCoolT - dt);

      // ── ROUTE MODE. The single decision that keeps kiting intact: consult the graph only
      //    when direct steering provably cannot work. See `NAV.heightTrigger`. ──────────
      if (e.navHoldT > 0) e.navHoldT = Math.max(0, e.navHoldT - dt);
      const dh = Math.abs(e.heightToPlayer);
      if (!e.navMode) {
        if (dh > NAV.heightTrigger || e.wedgeTrips > 0) {
          e.navMode = true;
          e.navHoldT = NAV.holdTime;
        }
      } else if (e.navHoldT <= 0 && dh < NAV.heightRelease && e.wedgeTrips === 0
        // …AND the graph agrees with the crow flight. Height alone is not enough: a body
        // standing on the TOP STEP of the NE roof flight is within 60 cm of a player on the
        // roof and 16 m of stringer and fresh air away from them. Releasing on height alone
        // made it turn and walk straight off the side of the stair it had just climbed —
        // measured, every single time. `navCostSlack` is what "the direct line is the real
        // route" means numerically.
        && e.navCost <= e.distToPlayer * NAV.navCostSlack + NAV.navCostBias) {
        e.navMode = false;
      }
      if (e.navMode) demand++;

      // ── the decision, on a round-robin slice (see the header) ────────────
      if ((this.stepCount + e.slot) % steerEvery === 0) {
        // The graph changes the TARGET and nothing else — separation, the conga relief, the
        // wall whiskers and the turn-rate cap all still shape the motion, so a horde on a
        // route is still a clumping fluid rather than a queue of rail-followers.
        this.climbCommitted = false;
        const target = this.routeTarget(e, ctx) ?? player;
        // Separation AND the conga follow heading, one pass. `_follow` is zero for the body at
        // the head of the line, which makes its steering bit-for-bit BUILD 006's.
        crowdInto(_sep, _follow, e.position, i, e.distToPlayer, _toPlayer,
          this._alive, this._alive.length);
        steerInto(e.desired, ctx.world, e.position, target, _sep, _follow);
        // Wedged: walk ALONG the blocker instead of pressing into it (see `ai.ts::tickUnstick`).
        if (e.detourT > 0) detourInto(e.desired, e.detourSign);
        // `routeTarget` may have committed this body to a mantle. Nothing below applies to it.
        if (this.climbCommitted) continue;
      }

      // ── the state machine ────────────────────────────────────────────────
      const action = stepState(e, dt, ANIM.spawnTime);
      if (action === 'windup') {
        e.chestPoint(this.evPos);
        ctx.events.emit('fx:sound', { id: 'zombie_windup', position: this.evPos, pitch: this.pitchFor(e) });
      } else if (action === 'strike') {
        this.resolveStrike(e, ctx);
      } else if (action === 'recover') {
        // Re-roll the swing cadence every time a swing ends, so a pack that arrived together
        // drifts apart instead of hammering you as one 350-damage event (ENEMY.meleeCooldownJitter).
        e.swingJitter = 1 + this.rng.spread(ENEMY.meleeCooldownJitter);
      }

      // ── speed ────────────────────────────────────────────────────────────
      // `e.lungeMult` is the TIER's, not the def's: a sprinter that also lunges is a teleport.
      const speed = e.baseSpeed
        * stateSpeedMult(e, e.lungeMult, e.def.windupSpeedMult)
        * e.reactions.legSpeedMult(e.def);

      if (speed < ENEMY.wedgeMinSpeed && e.state === 'chase'
        && (e.distToPlayer > ENEMY.meleeRange
          || Math.abs(e.heightToPlayer) > ENEMY.verticalMeleeGate)) frozen++;

      integrateVelocity(e.velocity, e.desired, speed, ENEMY.steerAccel, dt);

      // ══════════════════════════════════════════════════════════════════════
      //  MOVE. One swept capsule with gravity, EVERY fixed step, same solver as
      //  the player (`game/motion`). This replaces four separate mechanisms:
      //  a 12 Hz `groundAt` probe, a lerp of `position.y` toward it, a 24 Hz
      //  horizontal-only capsule correction, and the ledge guard that used to
      //  hold a body's HEIGHT rather than refuse its STEP.
      //
      //  Holding height is what put bodies inside awnings and orange panels
      //  (complaint 4) and what made every kerb a stutter (complaint 1). The
      //  vertical axis is now collided continuously, so neither is reachable.
      // ══════════════════════════════════════════════════════════════════════
      const m = this.motion;
      m.stepHeight = NAV.stepUp;
      m.minGroundNormalY = ENEMY.minGroundNormalY;
      m.groundSnapDistance = ENEMY.groundSnap;
      m.maxSubstepDistance = ENEMY.maxSubstepDistance;
      m.maxSubsteps = ENEMY.maxSubsteps;
      m.iterations = ENEMY.collisionIterations;
      // Knockback rides alongside the steering velocity: it translates the body but is not slid
      // along walls or fed back into the steering clamp.
      m.driftX = e.push.x;
      m.driftZ = e.push.z;
      m.canStepUp = true;
      m.canSnap = true;
      /**
       * THE LEDGE GUARD, now expressed as "refuse the STEP" instead of "hold the HEIGHT".
       *
       * Same policy as BUILD 005's `followGround`: a body routing toward a player who is not
       * clearly below it does not walk off the thing it is climbing, and a route step the flow
       * field explicitly marked as a DROP is honoured either way. What changed is the mechanism
       * — the mover reverts the horizontal move one axis at a time (so a body pressed against a
       * lip still SLIDES along it and finds the top of the flight) and never, ever suspends the
       * body in mid-air.
       */
      m.ledgeGuard = !e.navDropOk && e.heightToPlayer > -NAV.heightTrigger;

      applyGravity(e.velocity, e.grounded, ENEMY.gravity, ENEMY.fallGravityMult,
        ENEMY.maxFallSpeed, dt);

      const fromX = e.position.x;
      const fromZ = e.position.z;
      moveBody(ctx.world, e, m, dt);
      const dx = e.position.x - fromX;
      const dz = e.position.z - fromZ;

      const decay = Math.exp(-6.5 * dt);
      e.push.x *= decay;
      e.push.z *= decay;
      e.stepSmear = damp(e.stepSmear, 0, smearLambda, dt);
      // `groundY` is now pure bookkeeping for the climb: the mover owns height.
      if (e.grounded) {
        e.groundY = e.position.y;
        e.supportX = e.position.x;
        e.supportZ = e.position.z;
      }

      // Gait advances by DISTANCE, not by time, so the stride always matches the feet.
      e.gait += Math.hypot(dx, dz) / ANIM.strideMetres;
      if (e.gait > 1e6) e.gait = 0;

      // ── facing. While swinging, commit to the player: a telegraph you can
      //    strafe around is not a telegraph. ─────────────────────────────────
      e.yaw = e.state === 'attack' && e.distToPlayer > 1e-3
        ? turnToward(e.yaw, _toPlayer, dt * 2.2)
        : turnToward(e.yaw, e.desired, dt);

      // ── never leave the block ────────────────────────────────────────────
      const b = ctx.world.bounds;
      e.position.x = clamp(e.position.x, b.min.x + e.radius, b.max.x - e.radius);
      e.position.z = clamp(e.position.z, b.min.z + e.radius, b.max.z - e.radius);

      // ── THE UNSTICK. Runs LAST, after every correction that can undo a step,
      //    so it measures where the body actually ended up. ──────────────────
      //
      //    THE ESCALATOR, in order of how much the world has to bend: mantle → detour →
      //    detour the other way → re-place. The mantle is FIRST because a wedge is most often
      //    a body pressed against something it should simply have climbed, and climbing it is
      //    the only response that gets the body where it was actually trying to go.
      const tripped = tickUnstick(e, dt, speed);
      if (tripped && this.tryMantle(e, ctx)) continue;
      if (e.wedgeTrips >= ENEMY.wedgeRescueTrips) this.rescueWedged(e, ctx);

      // ── the horde bed: spatialised groans, rate-limited per body ─────────
      this.groan(e, ctx, now);
    }
    this.navDemand = demand;
    this.frozenCount = frozen;

    // ── corpses: hold the impact pose, then recycle the slot ───────────────
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const e = this.dying[i];
      e.stateT += dt;
      e.reactions.step(dt);
      if (e.stateT >= ANIM.deathHold) {
        this.dying.splice(i, 1);
        this.recycle(e);
      }
    }
  }

  /** Presentation. The pose clock, and nothing else. */
  update(_dt: number, ctx: GameCtx): void {
    this.syncFrame(ctx);
  }

  /**
   * ═══ WHERE `followGround` WENT (BUILD 006) ═══
   *
   * This is where a 12 Hz `groundAt` probe used to write `e.groundY`, plus a ledge guard that
   * recovered a body by RESTORING ITS HEIGHT to the last ground it was proven to be standing on.
   *
   * Both are gone. The probe was complaint 1 ("slow, they get stuck everywhere") — 83 ms between
   * samples is ~16 cm of blind travel, so every kerb, stair nose and ramp was a stutter and a
   * re-plan. Restoring HEIGHT was complaint 4 ("stuck inside some walls and some orange panels")
   * — `groundAt` returns the top of an AWNING as readily as the floor, the body was lifted into
   * it, and a correction that only ever applied X and Z could never push it back out.
   *
   * The policy survived; the mechanism did not. `game/motion`'s ledge guard reverts the
   * HORIZONTAL step one axis at a time (see `m.ledgeGuard` in `fixedUpdate`), so a body pressed
   * against a lip still slides along it and finds the top of a flight — and nothing anywhere in
   * this system can suspend a body in mid-air any more.
   */

  /** The horde bed: spatialised groans, rate-limited per body. */
  private groan(e: Enemy, ctx: GameCtx, now: number): void {
    if (now < e.nextGroan) return;
    e.chestPoint(this.evPos);
    ctx.events.emit('fx:sound', {
      id: 'zombie_groan',
      position: this.evPos,
      pitch: this.pitchFor(e),
      volume: clamp01(1 - e.distToPlayer / 45),
    });
    e.nextGroan = now + this.rng.range(e.def.groanInterval[0], e.def.groanInterval[1]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ROUTING — the answer to "u can just camp top of a building or fountain"
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Where this body should steer, if the nav graph has an opinion. Returns `null` to mean
   * "no opinion — chase the player directly", which is the BUILD 004 behaviour and the case
   * every flat-ground fight takes.
   *
   * Called on the 10 Hz steer slice only, so this costs 2–3 array reads per agent per 100 ms.
   * There is no search here: the flow field already did it once for everybody.
   */
  private routeTarget(e: Enemy, ctx: GameCtx): Vector3 | null {
    const nav = this.nav;
    e.navDropOk = false;
    e.navCost = Infinity;
    if (!nav || !e.navMode || !nav.hasField) return null;
    const here = nav.nodeAt(e.position.x, e.position.y, e.position.z);
    if (here < 0) return null;
    e.navCost = nav.costOf(here);
    const step = nav.next(here);
    if (step < 0) return null;

    nav.point(step, _navA);
    const kind = nav.kindOf(here);
    e.navDropOk = kind === NAV_DROP;

    if (kind === NAV_CLIMB) {
      /**
       * Walk at the ledge, then commit — but commit to a SHORT HOP, not to the node.
       *
       * The two ends of a climb link are a full lattice cell apart (1.75 m, or 2.47 m on a
       * diagonal) and the ledge itself stands between them, so a body can never get within a
       * body-length of the destination node: the thing it is trying to climb is in the way.
       * Measured on the SW lot container stack — a shambler mantled the first container, then
       * stood on top of it for forty seconds with the second container 1.97 m away and a
       * 1.35 m commit radius. So `climbReach` is now a full cell diagonal, and the climb goes
       * to a point one body-length in FRONT of the agent at the ledge's height, exactly like
       * the opportunist mantle. `beginClimb` proves that point has ground on it, so a hop aimed
       * at fresh air is simply refused and the body keeps walking in.
       */
      const dx = _navA.x - e.position.x;
      const dz = _navA.z - e.position.z;
      const d = Math.hypot(dx, dz);
      if (d <= NAV.climbReach && d > 1e-3 && e.climbCoolT <= 0) {
        const hop = e.radius + NAV.probeAhead;
        if (this.beginClimb(
          e, ctx,
          e.position.x + (dx / d) * hop, e.position.z + (dz / d) * hop,
          _navA.y + 0.5,
        )) return null;
      }
      return _navA;
    }

    // STRING-PULLING. Aiming at the very next node walks the lattice diagonals and reads as a
    // robot on graph paper. Aim one hop further whenever that hop is on the same level and
    // close by, so the line through open ground is straight and only bends where the route does.
    if (kind === NAV_WALK) {
      const step2 = nav.next(step);
      if (step2 >= 0 && nav.kindOf(step) === NAV_WALK) {
        nav.point(step2, _navB);
        const dx = _navB.x - e.position.x;
        const dz = _navB.z - e.position.z;
        if (dx * dx + dz * dz < NAV.lookAheadRange * NAV.lookAheadRange
          && Math.abs(_navB.y - _navA.y) < NAV.lookAheadRise) {
          _navA.copy(_navB);
        }
      }
    }

    /**
     * THE CORRIDOR PULL. Steering at the next node alone lets a body drift off the spine of
     * whatever it is walking on and then cut the corner into thin air. It is worst exactly
     * where it matters most: the NE roof flight meets its landing deck through a 0.7 m pinch at
     * the top step, and a body aiming straight at the deck node from half a metre off the
     * stair's centreline walks over the stringer instead of through the gap. Traced: it reached
     * 6.3 m and then stood pressed against the west stringer for the rest of the round.
     *
     * So the heading is corrected by the body's offset from the node it is CURRENTLY on — it
     * steers "back onto the line, and then along it". Pure arithmetic, no rays, and it composes
     * with separation rather than replacing it: on a wide street every body's own node is
     * already under its feet, the correction is ~zero, and the horde spreads exactly as before.
     */
    nav.point(here, _navC);
    _navA.x += (_navC.x - e.position.x) * NAV.corridorPull;
    _navA.z += (_navC.z - e.position.z) * NAV.corridorPull;

    /**
     * THE WRONG-SIDE CHECK. A 1.75 m lattice cell can straddle a 0.3 m collider — the SW lot's
     * chain-link perimeter is exactly that — so a body standing 40 cm OUTSIDE the fence resolves
     * to the node 12 cm INSIDE it and is handed a route that leads through the wire. It then
     * presses north forever, and because it keeps shuffling it never looks wedged enough for the
     * unstick to fire.
     *
     * One chest-height ray per routed body per steer slice (25 bodies × 10 Hz = 250 rays/s, i.e.
     * nothing) says whether the route's first step is even physically in front of us. If it is
     * not, the body is fed straight into the existing escalator — mantle, detour, detour the
     * other way, re-place — instead of being left to lean on a fence for the rest of the round.
     */
    _v3.set(_navA.x - e.position.x, 0, _navA.z - e.position.z);
    const reach = _v3.length();
    if (reach > 0.6) {
      _v3.divideScalar(reach);
      _v2.set(e.position.x, e.position.y + 0.95, e.position.z);
      if (ctx.world.raycast(_v2, _v3, Math.min(reach, NAV.sightProbe)).hit) {
        e.wedgeT += ENEMY.wedgeTrip * NAV.blockedWedgeShare;
      }
    }
    return _navA;
  }

  /**
   * THE OPPORTUNIST MANTLE. Independent of the graph, and deliberately so: the lattice is
   * 1.75 m coarse and a shambler pressed against a 0.6 m dais step or a 1.2 m loading dock
   * should not have to wait for a node to exist in exactly the right place. Fired by the wedge
   * detector — a body that has been *asking to move and not moving* for `ENEMY.wedgeTrip`
   * seconds has, more often than not, simply walked into something it should have climbed.
   *
   * Two rays and one capsule query, only on a trip event. Costs nothing in the steady state.
   */
  private tryMantle(e: Enemy, ctx: GameCtx): boolean {
    if (e.climbCoolT > 0 || e.state !== 'chase') return false;
    const dx = e.desired.x;
    const dz = e.desired.z;
    if (dx * dx + dz * dz < 1e-6) return false;

    // Is the thing in front of us a FACE (something to climb) rather than a slope (something
    // to walk up) or thin air (something else is holding us)?
    _v1.set(e.position.x, e.position.y + 0.35, e.position.z);
    _v2.set(dx, 0, dz);
    const wall = ctx.world.raycast(_v1, _v2, e.radius + NAV.probeAhead);
    if (!wall.hit || wall.normal.y > NAV.probeWallNormalY) return false;

    const reach = e.radius + NAV.probeAhead;
    return this.beginClimb(
      e, ctx,
      e.position.x + dx * reach, e.position.z + dz * reach,
      e.position.y + NAV.climbMax + 0.4,
    );
  }

  /**
   * Commit to a ledge. Proves the destination before it moves anything: there must be ground
   * there, the rise must be a real ledge (taller than a step, shorter than `NAV.climbMax`), and
   * a body must actually fit on top of it. A refused climb costs the caller nothing.
   */
  private beginClimb(e: Enemy, ctx: GameCtx, tx: number, tz: number, probeTopY: number): boolean {
    _v3.set(tx, probeTopY, tz);
    const g = ctx.world.groundAt(_v3);
    if (g === null) return false;
    const gap = g - e.position.y;
    if (gap <= NAV.stepUp || gap > NAV.climbMax) return false;

    _capA.set(tx, g + e.radius + 0.02, tz);
    _capB.set(tx, g + e.height - e.radius, tz);
    if (ctx.world.collideCapsule(_capA, _capB, e.radius).depth > 0.06) return false;

    // …and never mantle INTO the player. `collideCapsule` only knows about the world, so neither
    // climb path considered the one body that is guaranteed to be standing at the top of the
    // ledge a camping player is being climbed toward.
    const p = ctx.player.position;
    const pdx = tx - p.x;
    const pdz = tz - p.z;
    const clear = e.radius + ENEMY.separationRadius;
    if (pdx * pdx + pdz * pdz < clear * clear
      && Math.abs(g - p.y) < ENEMY.verticalMeleeGate) return false;

    e.climbFrom.copy(e.position);
    e.climbTo.set(tx, g, tz);
    e.climbT = 0;
    // The whole cost of holding high ground: 1.05 s for a dais step, 1.46 s for a loading dock,
    // 2.24 s for a shipping container. Slow enough to shoot, slow enough to run from.
    e.climbDur = NAV.climbBase + gap * NAV.climbPerMetre;
    e.velocity.set(0, 0, 0);
    e.push.set(0, 0, 0);
    e.detourT = 0;
    e.wedgeT = 0;
    e.wedgeTrips = 0;
    // Face the ledge and HOLD it — the climb is a telegraph and a telegraph you can see the
    // back of is not a telegraph.
    const fx = tx - e.position.x;
    const fz = tz - e.position.z;
    if (fx * fx + fz * fz > 1e-6) e.yaw = Math.atan2(-fx, -fz);
    enter(e, 'climb');
    this.climbCommitted = true;

    e.chestPoint(this.evPos);
    ctx.events.emit('fx:sound', {
      id: 'zombie_groan', position: this.evPos, pitch: this.pitchFor(e) * 0.78, volume: 0.85,
    });
    return true;
  }

  /**
   * Drive one body up a ledge. The vertical comes first and the horizontal last — a zombie
   * hauls its chest over the lip and only then drags its hips across, which is the difference
   * between a climb and a body sliding up an invisible ramp.
   */
  private stepClimb(e: Enemy, dt: number, ctx: GameCtx): void {
    e.stateT += dt;

    /**
     * KNOCKBACK GETS THROUGH (BUILD 006). This branch used to skip the push integration AND the
     * push decay, so a shot fired at a climbing body did nothing when you took it and then
     * teleported its whole effect onto the body two seconds later, on plant. Both halves are
     * fixed here: enough impulse tears it off the wall, and anything short of that shifts the
     * whole mantle trajectory and then decays, so nothing is ever stored up.
     */
    const impulse = Math.hypot(e.push.x, e.push.z);
    if (impulse >= NAV.climbBreakImpulse) { this.breakClimb(e, ctx); return; }
    if (impulse > 1e-4) {
      const px = e.push.x * dt;
      const pz = e.push.z * dt;
      e.climbFrom.x += px;
      e.climbFrom.z += pz;
      e.climbTo.x += px;
      e.climbTo.z += pz;
      const d = Math.exp(-6.5 * dt);
      e.push.x *= d;
      e.push.z *= d;
    }

    e.climbT += dt;
    const k = clamp01(e.climbT / Math.max(1e-3, e.climbDur));
    const rise = smoothstep(clamp01((k - ANIM.climbHold * 0.55) / 0.62));
    const over = smoothstep(clamp01((k - 0.45) / 0.55));

    e.position.x = lerp(e.climbFrom.x, e.climbTo.x, over);
    e.position.z = lerp(e.climbFrom.z, e.climbTo.z, over);
    e.position.y = lerp(e.climbFrom.y, e.climbTo.y, rise);
    e.groundY = e.position.y;
    e.velocity.set(0, 0, 0);

    if (k < 1) return;

    e.position.copy(e.climbTo);
    const g = ctx.world.groundAt(e.position);
    if (g !== null) e.position.y = g;
    e.groundY = e.position.y;
    e.grounded = true;
    e.groundNormal.set(0, 1, 0);
    e.velocity.set(0, 0, 0);
    e.stepSmear = 0;
    e.climbCoolT = NAV.climbCooldown;
    e.supportX = e.position.x;
    e.supportZ = e.position.z;
    e.wedgeSampleT = 0;
    e.wedgeRefX = e.position.x;
    e.wedgeRefZ = e.position.z;
    enter(e, 'chase');
  }

  /**
   * Torn off a ledge. The body keeps its `push` — it should visibly go somewhere — and drops onto
   * whatever `groundAt` proves is under it right now, which is the surface it launched from for
   * the first half of the mantle and the lower tier it already cleared for the second. It lands
   * in `stagger` rather than `chase`: it was shot, and a body that snaps straight back to a
   * purposeful walk reads as the hit not registering.
   */
  private breakClimb(e: Enemy, ctx: GameCtx): void {
    _v1.set(e.position.x, e.position.y + 0.2, e.position.z);
    const g = ctx.world.groundAt(_v1);
    e.position.y = g ?? e.climbFrom.y;
    e.groundY = e.position.y;
    e.velocity.set(0, 0, 0);
    // Torn off a ledge mid-mantle: it is standing on whatever `groundAt` just proved, and the
    // mover re-derives that on the next step anyway.
    e.grounded = true;
    e.stepSmear = 0;
    e.climbT = 0;
    e.climbCoolT = NAV.climbCooldown;
    e.supportX = e.position.x;
    e.supportZ = e.position.z;
    e.wedgeT = 0;
    e.wedgeSampleT = 0;
    e.wedgeRefX = e.position.x;
    e.wedgeRefZ = e.position.z;
    enter(e, e.staggerT > 0 ? 'stagger' : 'chase');
  }

  /**
   * Console diagnostic: can the horde get from `from` to `to` at all? Used by the BUILD 005
   * acceptance test — a camp spot that survives this milestone is a failure, so the test that
   * proves it must be one call away in the browser.
   */
  navProbe(from: Vector3, to: Vector3): { hops: number; cost: number; kinds: string } {
    return this.nav?.probeRoute(from, to) ?? { hops: -1, cost: Infinity, kinds: 'no graph' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pose + hitboxes
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Bring every body's pose, transform and hitbox up to date for THIS frame — at most once,
   * whoever asks first.
   *
   * It is called lazily from `raycast`/`querySphere`/`damageSphere` as well as from `update`,
   * because the registration order puts `weapons` BEFORE `enemies` (ARCHITECTURE §3): a shot
   * fired this frame must trace against this frame's zombies, not last frame's. One frame of
   * stale hitbox is 2.7 cm on a shambler, and it is still 2.7 cm too many.
   */
  private syncFrame(ctx: GameCtx): void {
    if (this.frameStamp === ctx.time.frame) return;
    this.frameStamp = ctx.time.frame;
    const t = ctx.time.elapsed;
    for (let i = 0; i < this._alive.length; i++) this.syncOne(this._alive[i], t, false);
    for (let i = 0; i < this.dying.length; i++) this.syncOne(this.dying[i], t, true);
  }

  /**
   * ON TWELVES. The pose is only re-evaluated when the 12 Hz clock ticks, and every input to it
   * is snapshotted at that tick and HELD until the next one — so a pose is genuinely held for
   * five frames at 60 fps and then jumps (ART §8). Two things fall out of that:
   *
   *   • the animation reads as drawn stop-motion rather than as interpolation, which is the
   *     entire brief; and
   *   • pose evaluation costs 12 Hz × 25 bodies instead of 60 Hz × 25, i.e. a fifth.
   *
   * The ROOT transform still updates every frame — a body that translated on twelves would read
   * as teleporting and would be miserable to lead a shot on. Limited animation moves the drawing
   * on twos; it does not move the camera on twos.
   */
  private syncOne(e: Enemy, now: number, dead: boolean): void {
    const tick = Math.floor((now + e.body.poseClockOffset) * ANIM.poseFps);
    if (tick !== e.poseTick) {
      e.poseTick = tick;
      e.heldGait = e.gait + e.body.gaitOffset;
      // A climbing body's feet are off the floor: its gait amplitude must read as zero or the
      // legs keep marching in mid-air, which is the single most common way a climb looks wrong.
      e.heldSpeed01 = e.state === 'climb'
        ? 0
        : clamp01(Math.hypot(e.velocity.x, e.velocity.z) / Math.max(0.2, e.baseSpeed));
      e.heldDist = e.distToPlayer;
      e.heldLeanX = e.reactions.leanX;
      e.heldLeanZ = e.reactions.leanZ;
      e.heldShudder = e.reactions.shudderValue;

      _poseArgs.gait = e.heldGait - Math.floor(e.heldGait);
      _poseArgs.speed01 = e.heldSpeed01;
      _poseArgs.state = e.state;
      _poseArgs.windup01 = clamp01(e.attackT / Math.max(1e-3, ENEMY.meleeWindup));
      _poseArgs.strike01 = e.attackT > ENEMY.meleeWindup
        ? clamp01((e.attackT - ENEMY.meleeWindup) / ANIM.strikeTime)
        : 0;
      _poseArgs.climb01 = e.state === 'climb' ? clamp01(e.climbT / Math.max(1e-3, e.climbDur)) : 0;
      _poseArgs.targetDist = e.heldDist;
      _poseArgs.leanX = e.heldLeanX;
      _poseArgs.leanZ = e.heldLeanZ;
      _poseArgs.shudder = e.heldShudder;
      _poseArgs.spawn01 = e.state === 'spawn' ? clamp01(e.stateT / ANIM.spawnTime) : 1;
      _poseArgs.death01 = dead ? clamp01(e.stateT / ANIM.deathHold) : 0;
      e.body.pose(_poseArgs);
      this.cacheLocalHitboxes(e);
    }

    // The collider snaps a kerb; the DRAWN body trails it by `stepSmear` (ENEMY.stepSmoothHalfLife)
    // so mounting a step is not a 45 cm pop. Hitboxes use the same offset — what you see is what
    // you hit is a rule, not an aspiration.
    e.body.mesh.position.set(e.position.x, e.position.y - e.stepSmear, e.position.z);
    e.body.mesh.rotation.y = e.yaw;
    this.worldHitboxes(e);
    this.taperOutline(e);
  }

  /**
   * Hold the full 8 px ink weight up close and taper it past `OUTLINE.fullRange`. See the note
   * on `OUTLINE` in defs.ts: without this, the reserved INK channel eats the reserved HUE
   * channel at the far end of a 140 m sightline, and §9 asks for both.
   *
   * One uniform write per body per frame, off the CAMERA (not the player — a spectator or a
   * kill-cam must get the same line).
   */
  private taperOutline(e: Enemy): void {
    const cam = this.ctx?.camera;
    if (!cam) return;
    const dx = e.position.x - cam.position.x;
    const dy = e.position.y + e.height * 0.5 - cam.position.y;
    const dz = e.position.z - cam.position.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const full = e.body.outlinePx;
    const px = d <= OUTLINE.fullRange ? full : Math.max(OUTLINE.minPx, full * (OUTLINE.fullRange / d));
    e.body.setOutlinePx(px);
  }

  /**
   * Read the anchors off the freshly posed rig — what you see is what you hit.
   *
   * Head and torso come from `EnemyBody`'s own primitives (both are single bone-local offsets).
   * The LIMBS are built here, straight off `rig.boneSegment`, as two capsules each: root→elbow
   * and elbow→hand-tip (root→knee, knee→foot-tip). Every radius is the rig's own per-instance
   * `boneRadius`, so a fat zombie has fat hitboxes and a gaunt one has thin ones without a
   * single number being duplicated between the drawing and the collision.
   */
  private cacheLocalHitboxes(e: Enemy): void {
    const rig = e.body.rig;
    e.body.headPoint(e.hLocal[H_HEAD]);
    _v1.set(0, HITBOX.jawCenterY, HITBOX.jawCenterZ);
    rig.boneLocal(BONE.JAW, _v1, e.hLocal[H_JAW]);
    e.body.torsoSegment(e.hLocal[H_TORSO_A], e.hLocal[H_TORSO_B]);
    e.headRadius = HITBOX.headRadius * (rig.boneRadius(BONE.HEAD) / HITBOX.headBindRadius);
    e.jawRadius = HITBOX.jawRadius * (rig.boneRadius(BONE.JAW) / HITBOX.jawBindRadius);
    e.torsoRadius = HITBOX.torsoRadius * (rig.boneRadius(BONE.CHEST) / HITBOX.torsoBindRadius);

    for (let l = 0; l < LIMB_COUNT; l++) {
      const chain = LIMB_BONES[l] as readonly number[];
      e.limbLive[l] = !rig.isSevered(chain[0] as number);
      for (let k = 0; k < LIMB_SEGMENTS; k++) {
        const bone = chain[k] as number;
        const s = l * LIMB_SEGMENTS + k;
        rig.boneSegment(bone, e.hLocal[H_LIMB + s * 2], e.hLocal[H_LIMB + s * 2 + 1]);
        e.limbRadius[s] = rig.boneRadius(bone) * HITBOX.limbGenerosity;
      }
    }
  }

  /** Enemy-local → world. Yaw is the only rotation, so this is two multiplies per component. */
  private worldHitboxes(e: Enemy): void {
    const s = Math.sin(e.yaw);
    const c = Math.cos(e.yaw);
    for (let i = 0; i < H_COUNT; i++) {
      const p = e.hLocal[i];
      e.hWorld[i].set(
        e.position.x + p.x * c + p.z * s,
        e.position.y - e.stepSmear + p.y,
        e.position.z + -p.x * s + p.z * c,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Spawning
  // ═══════════════════════════════════════════════════════════════════════════

  spawn(kind: EnemyKind, position: Vector3, hpScale: number, speedScale: number): Damageable | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (this._alive.length >= ENEMY.maxAlive) return null;
    const e = this.free.pop();
    if (!e) return null;

    const def = defFor(kind);
    e.kind = kind;
    e.def = def;
    e.pooled = false;
    e.alive = true;
    e.maxHealth = def.health * Math.max(0.05, hpScale) * ENEMY.healthScale;
    e.health = e.maxHealth;

    /**
     * ═══ THE SPEED TIER ═══ (see `SPEED_TIERS` / `TIER_MIX` in defs.ts)
     *
     * Rolled HERE, per instance, from the round's distribution — not handed down as one number
     * for the whole round. That is the CoD mechanic and it is the answer to "they aren't truly a
     * threat": at round 9 this line produces a horde that is 2% shamblers, 21% walkers, 47%
     * runners and 30% sprinters, so what comes around the corner is genuinely unknown until you
     * see it move.
     *
     * `_round` is fed by `round:start`. It is 1 until a director says otherwise, which is the
     * right default for a bare console `CZ.spawn()` and for the headless harness.
     */
    e.tier = rollTier(this.rng.next(), this._round);
    const tier = SPEED_TIERS[e.tier] as (typeof SPEED_TIERS)[number];
    e.lungeMult = tier.lungeMult;
    e.baseSpeed = def.speed
      * tier.speedMult
      * Math.max(0.05, speedScale)
      * ENEMY.speedScale
      * (1 + this.rng.spread(tier.jitter))
      * (1 + this.rng.spread(def.speedJitter));
    e.swingJitter = 1 + this.rng.spread(ENEMY.meleeCooldownJitter);

    // A fresh body on every spawn, not once per pool slot: reusing a slot must never hand the
    // player the same zombie twice in a row.
    const variant = VARIANTS[this.variantCursor % VARIANTS.length];
    this.variantCursor++;
    e.body.reseed(this.rng, variant);
    if (def.hue !== PALETTE.ACID) e.body.setHue(def.hue);
    e.height = e.body.height;
    e.radius = BODY.radius * (e.height / BODY.height);

    e.position.copy(position);
    const g = ctx.world.groundAt(position);
    e.groundY = g !== null ? g : position.y;
    e.position.y = e.groundY;

    e.velocity.set(0, 0, 0);
    e.push.set(0, 0, 0);
    e.grounded = true;
    e.groundNormal.set(0, 1, 0);
    e.stepSmear = 0;
    e.reactions.reset(def);
    e.staggerT = 0;
    e.attackT = 0;
    e.cooldownT = 0;
    e.gait = this.rng.next();
    e.wedgeT = 0;
    e.wedgeSampleT = 0;
    e.wedgeRefX = e.position.x;
    e.wedgeRefZ = e.position.z;
    e.detourT = 0;
    e.wedgeTrips = 0;
    e.navMode = false;
    e.navHoldT = 0;
    e.navDropOk = false;
    e.climbT = 0;
    e.climbCoolT = 0;
    e.supportX = e.position.x;
    e.supportZ = e.position.z;
    e.poseTick = -1;
    e.canMelee = true;
    e.pendingLimb = -1;
    e.nextGroan = ctx.time.elapsed + this.rng.range(0.2, def.groanInterval[1]);

    // Face the player immediately — a zombie that pops in facing a wall reads as a bug.
    _v1.set(ctx.player.position.x - e.position.x, 0, ctx.player.position.z - e.position.z);
    if (_v1.lengthSq() > 1e-6) {
      _v1.normalize();
      e.desired.copy(_v1);
      e.yaw = Math.atan2(-_v1.x, -_v1.z);
    }
    enter(e, 'spawn');

    e.body.setVisible(true);
    this._alive.push(e);
    this.evPos.copy(e.position);
    ctx.events.emit('enemy:spawned', { enemy: e, kind, position: this.evPos });
    return e;
  }

  /**
   * THE RESCUE — the horde's last resort, and the reason a wedge can never end a run.
   *
   * `tickUnstick` has already tried two tangential detours and this body has still not travelled.
   * Rather than leave it there (the round only leaves `active` at `aliveCount === 0`, so one of
   * these costs the player a 30–60 s straggler hunt against a zombie that is physically incapable
   * of arriving), we re-place it on ground we can PROVE is walkable.
   *
   * The proof is the player: they are standing on navigable ground right now. So the candidate
   * ring is centred on them, we prefer headings BEHIND their look direction — the rescue should
   * read as the horde coming round the back, never as a body blinking into the crosshair — and
   * every candidate is validated with the same `groundAt` + `collideCapsule` the spawner uses.
   *
   * NOTE FOR THE LEAD: this lives in the enemy system, not in `RoundSystem`, because the frozen
   * `EnemyService` contract has no `relocate`/`teleport` member and I may not edit
   * `src/core/types.ts`. The owner of the bodies is the only module that can legally move one.
   * If a director-side straggler policy is wanted later, `EnemyService` needs one method.
   */
  private rescueWedged(e: Enemy, ctx: GameCtx): void {
    e.wedgeTrips = 0;
    e.wedgeT = 0;
    e.detourT = 0;

    const p = ctx.player.position;
    const look = ctx.player.lookDir;
    // Behind the player first, then sweeping outward to either side, front last.
    const back = Math.atan2(look.x, look.z);

    for (let pass = 0; pass < 2; pass++) {
      const radius = pass === 0 ? ENEMY.wedgeRescueDistance : ENEMY.wedgeRescueFallback;
      for (let i = 0; i < RESCUE_HEADINGS; i++) {
        // 0, +45, -45, +90, -90 … so the first candidates are the ones behind them.
        const step = Math.ceil(i / 2) * (TAU / RESCUE_HEADINGS) * (i % 2 === 0 ? 1 : -1);
        const a = back + step;
        _v1.set(p.x + Math.sin(a) * radius, p.y, p.z + Math.cos(a) * radius);
        if (!this.placeAt(e, _v1, ctx)) continue;
        return;
      }
    }
    // Nothing on either ring took it. Leave it where it is — the detour keeps trying, and a
    // failed rescue must never move a body somewhere worse than where it already was.
  }

  /** Try to seat `e` at `at`. Returns false if that spot has no ground or is inside geometry. */
  private placeAt(e: Enemy, at: Vector3, ctx: GameCtx): boolean {
    const g = ctx.world.groundAt(at);
    if (g === null) return false;

    _capA.set(at.x, g + e.radius, at.z);
    _capB.set(at.x, g + e.height - e.radius, at.z);
    if (ctx.world.collideCapsule(_capA, _capB, e.radius).depth > 1e-4) return false;

    e.position.set(at.x, g, at.z);
    e.groundY = g;
    e.velocity.set(0, 0, 0);
    e.push.set(0, 0, 0);
    e.grounded = true;
    e.groundNormal.set(0, 1, 0);
    e.stepSmear = 0;
    e.supportX = at.x;
    e.supportZ = at.z;
    e.wedgeRefX = at.x;
    e.wedgeRefZ = at.z;
    e.wedgeSampleT = 0;
    // Face the player, or it arrives walking at a wall.
    _v2.set(ctx.player.position.x - at.x, 0, ctx.player.position.z - at.z);
    if (_v2.lengthSq() > 1e-6) {
      _v2.normalize();
      e.desired.copy(_v2);
      e.yaw = Math.atan2(-_v2.x, -_v2.z);
    }
    return true;
  }

  private recycle(e: Enemy): void {
    // Double-free interlock — see `Enemy.pooled`.
    if (e.pooled) return;
    e.pooled = true;
    e.alive = false;
    e.body.setVisible(false);
    this.free.push(e);
  }

  private removeAlive(e: Enemy): void {
    const i = this._alive.indexOf(e);
    if (i >= 0) this._alive.splice(i, 1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Damage
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * THE HIT. Every path into an enemy's health goes through here, so every path produces the
   * same four things: a flinch, a stagger, a knockback and a `hit:enemy` event. There is no
   * "quiet" damage.
   */
  private readonly damage = (e: Enemy, info: DamageInfo): void => {
    const ctx = this.ctx;
    if (!ctx || !e.alive) return;

    // Which limb? Only trust the trace if it was recorded for this very frame — a penetrating
    // shot records a limb for several enemies and only damages some of them.
    let limb = -1;
    if (info.part === 'limb') {
      limb = e.pendingLimbFrame === ctx.time.frame && e.pendingLimb >= 0
        ? e.pendingLimb
        // Splash and chain damage have no trace: pick the limb facing the blast, deterministically.
        : (info.direction.x >= 0 ? 0 : 1) + (info.direction.y < -0.2 ? 2 : 0);
    }
    e.pendingLimb = -1;

    // The bullet direction in the enemy's own frame. This is what makes a shot from behind lurch
    // the body FORWARD and a shot from the left roll it right — a flinch that ignores the
    // direction of travel is a wobble, not an impact.
    const fx = -Math.sin(e.yaw);
    const fz = -Math.cos(e.yaw);
    const rx = Math.cos(e.yaw);
    const rz = -Math.sin(e.yaw);
    const dotF = info.direction.x * fx + info.direction.z * fz;
    const dotR = info.direction.x * rx + info.direction.z * rz;
    // Positive lean = "hit from the front" = arch back; positive leanX tips toward its right.
    const leanZ = -dotF;
    const leanX = -dotR;

    const amount = Math.max(0, info.amount);
    e.health -= amount;
    const killed = e.health <= 0;

    const r = e.reactions.applyHit(
      amount, info.part, info.isCrit, leanX, leanZ, limb, e.def, info.knockback,
    );
    e.staggerT = e.reactions.staggerT;
    e.push.x += info.direction.x * r.knockback;
    e.push.z += info.direction.z * r.knockback;
    if (r.interrupted && e.state === 'attack') {
      e.attackT = 0;
      e.cooldownT = ENEMY.meleeCooldown * 0.5;
    }

    ctx.events.emit('hit:enemy', {
      target: e,
      info,
      remainingHealth: Math.max(0, e.health),
      killed,
    });
    ctx.events.emit('fx:sound', {
      id: info.part === 'head' || info.isCrit ? 'zombie_crit' : 'zombie_flesh',
      position: info.point,
      pitch: this.pitchFor(e),
    });

    if (r.severed >= 0) {
      e.body.sever(r.severed);
      e.canMelee = e.reactions.canMelee;
      e.body.limbRootPoint(r.severed, _v2);
      const s = Math.sin(e.yaw);
      const c = Math.cos(e.yaw);
      this.evPos2.set(
        e.position.x + _v2.x * c + _v2.z * s,
        e.position.y + _v2.y,
        e.position.z + -_v2.x * s + _v2.z * c,
      );
      ctx.events.emit('enemy:dismembered', {
        enemy: e,
        part: 'limb',
        position: this.evPos2,
      });
      // The pose has to be rebuilt now, not at the next tick, or the arm hangs there for five
      // frames after it has visibly been shot off.
      e.poseTick = -1;
    }

    if (killed) this.kill(e, info);
  }

  private kill(e: Enemy, info: DamageInfo): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // RE-ENTRANCY GUARD. `damage()` emits `hit:enemy` with `killed: true` BEFORE it calls us, and
    // a listener (BOOM SHOT's `damageSphere`) can re-damage this same body while it is still in
    // `_alive` with `alive === true`. That inner `damage()` kills it, then the outer one returns
    // here and would `dying.push(e)` a SECOND time — the corpse loop recycles it twice, `free`
    // holds it twice, and a later `spawn()` hands the identical object to two `_alive` slots.
    // `aliveCount` then never reaches 0 and the round is stranded permanently.
    if (!e.alive) return;
    e.alive = false;
    e.health = 0;
    e.velocity.set(0, 0, 0);
    this.removeAlive(e);
    enter(e, 'death');
    e.poseTick = -1;
    this.dying.push(e);

    e.chestPoint(this.evPos);
    ctx.events.emit('enemy:killed', {
      enemy: e,
      kind: e.kind,
      position: this.evPos,
      byCrit: info.isCrit || info.part === 'head',
      part: info.part,
    });
    ctx.events.emit('fx:sound', { id: 'zombie_death', position: this.evPos, pitch: this.pitchFor(e) });
  }

  /** The melee connects — or whiffs, if the player used the tell. */
  private resolveStrike(e: Enemy, ctx: GameCtx): void {
    e.chestPoint(this.evPos);
    ctx.events.emit('fx:sound', { id: 'zombie_swing', position: this.evPos, pitch: this.pitchFor(e) });
    if (!strikeConnects(e) || !e.canMelee) return;

    const info = this.meleeInfo;
    info.amount = e.def.meleeDamage;
    info.part = 'torso';
    info.isCrit = false;
    info.knockback = 0;
    info.direction.set(ctx.player.position.x - e.position.x, 0, ctx.player.position.z - e.position.z);
    if (info.direction.lengthSq() < 1e-6) info.direction.set(0, 0, -1);
    info.direction.normalize();
    info.normal.copy(info.direction).negate();
    info.point.copy(ctx.player.position);
    info.point.y += 1.2;

    ctx.player.takeDamage(info);
    ctx.events.emit('enemy:attacked', { enemy: e, damage: info.amount });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Queries
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Bullet trace against the horde. Broad-phase sphere per enemy first — 25 ray/sphere tests
   * reject almost everything — then at most six capsule/sphere tests on the survivors, keeping
   * only the NEAREST part per enemy (a bullet hits one part of one body).
   *
   * The returned records come from a ring of `POOL.hitRing` and stay valid for the next
   * `hitRing - 1` calls. Copy the point/normal if you intend to keep them past this frame.
   * This mirrors `WorldCollision.raycast`'s convention exactly, so a weapon can treat a world
   * hit and an enemy hit the same way.
   */
  raycast(origin: Vector3, dir: Vector3, maxDistance: number, max: number, out: EnemyHit[]): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    this.syncFrame(ctx);

    _v1.copy(dir);
    if (_v1.lengthSq() < 1e-12) return 0;
    _v1.normalize();

    let n = 0;
    for (let i = 0; i < this._alive.length; i++) {
      const e = this._alive[i];
      const bcy = e.position.y + e.height * HITBOX.broadCenter;
      const br = HITBOX.broadRadius * (e.height / BODY.height);
      if (raySphere(
        origin.x, origin.y, origin.z, _v1.x, _v1.y, _v1.z,
        e.position.x, bcy, e.position.z, br, maxDistance,
      ) < 0) continue;

      // ── PART PRIORITY, NOT NEAREST SURFACE (see `HITBOX.priority` in defs.ts) ──
      // The six primitives deliberately overlap, so "nearest wins" measured *aiming at the head
      // and scoring a torso hit* and *aiming at the chest and scoring a limb hit*. Resolve
      // head → torso → limb instead: a limb only ever scores when the trace missed both of the
      // others, which is also the right game — a limb never shields a body shot, and taking one
      // off costs you a deliberate shot at a limb clear of the silhouette.
      let best = Infinity;
      let bestPart: BodyPart = 'torso';
      let bestLimb = -1;

      // THE HEAD IS TWO SPHERES — cranium and jaw. Both score `'head'`: the chin and the neck
      // are headshot surface, and 31% of clean jaw shots used to register nothing at all.
      let th = raySphere(
        origin.x, origin.y, origin.z, _v1.x, _v1.y, _v1.z,
        e.hWorld[H_HEAD].x, e.hWorld[H_HEAD].y, e.hWorld[H_HEAD].z,
        e.headRadius, maxDistance,
      );
      let hAnchor = H_HEAD;
      if (th < 0) {
        th = raySphere(
          origin.x, origin.y, origin.z, _v1.x, _v1.y, _v1.z,
          e.hWorld[H_JAW].x, e.hWorld[H_JAW].y, e.hWorld[H_JAW].z,
          e.jawRadius, maxDistance,
        );
        hAnchor = H_JAW;
      }
      if (th >= 0) {
        best = th;
        bestPart = 'head';
        this.candPoint[n].copy(origin).addScaledVector(_v1, th);
        this.candNormal[n].copy(this.candPoint[n]).sub(e.hWorld[hAnchor]).normalize();
      } else {
        const tt = rayCapsule(
          origin, _v1, e.hWorld[H_TORSO_A], e.hWorld[H_TORSO_B],
          e.torsoRadius, maxDistance, _v2, _v3,
        );
        if (tt >= 0) {
          best = tt;
          bestPart = 'torso';
          this.candPoint[n].copy(_v2);
          this.candNormal[n].copy(_v3);
        } else {
          for (let s = 0; s < LIMB_CAPSULES; s++) {
            const l = (s / LIMB_SEGMENTS) | 0;
            if (!e.limbLive[l]) continue;
            const tl = rayCapsule(
              origin, _v1, e.hWorld[H_LIMB + s * 2], e.hWorld[H_LIMB + s * 2 + 1],
              e.limbRadius[s] as number, maxDistance, _v2, _v3,
            );
            if (tl >= 0 && tl < best) {
              best = tl;
              bestPart = 'limb';
              bestLimb = l;
              this.candPoint[n].copy(_v2);
              this.candNormal[n].copy(_v3);
            }
          }
        }
      }

      if (best === Infinity) continue;
      this.candIdx[n] = i;
      this.candDist[n] = best;
      this.candPart[n] = bestPart;
      this.candLimb[n] = bestLimb;
      n++;
    }

    if (n === 0) return 0;

    // Insertion sort near→far. `n` is at most the live count, and the array is nearly sorted
    // in practice, so this beats anything with a comparator closure.
    for (let i = 1; i < n; i++) {
      const d = this.candDist[i];
      const idx = this.candIdx[i];
      const part = this.candPart[i];
      const limb = this.candLimb[i];
      _v2.copy(this.candPoint[i]);
      _v3.copy(this.candNormal[i]);
      let j = i - 1;
      while (j >= 0 && this.candDist[j] > d) {
        this.candDist[j + 1] = this.candDist[j];
        this.candIdx[j + 1] = this.candIdx[j];
        this.candPart[j + 1] = this.candPart[j];
        this.candLimb[j + 1] = this.candLimb[j];
        this.candPoint[j + 1].copy(this.candPoint[j]);
        this.candNormal[j + 1].copy(this.candNormal[j]);
        j--;
      }
      this.candDist[j + 1] = d;
      this.candIdx[j + 1] = idx;
      this.candPart[j + 1] = part;
      this.candLimb[j + 1] = limb;
      this.candPoint[j + 1].copy(_v2);
      this.candNormal[j + 1].copy(_v3);
    }

    const count = Math.min(n, max, POOL.hitRing);
    for (let i = 0; i < count; i++) {
      const e = this._alive[this.candIdx[i]];
      // Record which limb the trace found, for `takeDamage` to turn into dismemberment.
      e.pendingLimb = this.candLimb[i];
      e.pendingLimbFrame = ctx.time.frame;

      const h = this.hitRing[this.hitIndex];
      this.hitIndex = (this.hitIndex + 1) % POOL.hitRing;
      h.enemy = e;
      h.point.copy(this.candPoint[i]);
      h.normal.copy(this.candNormal[i]);
      h.distance = this.candDist[i];
      h.part = this.candPart[i];
      out[i] = h;
    }
    return count;
  }

  querySphere(center: Vector3, radius: number, out: Damageable[]): number {
    const ctx = this.ctx;
    if (ctx) this.syncFrame(ctx);
    const r2 = radius * radius;
    let n = 0;
    for (let i = 0; i < this._alive.length; i++) {
      const e = this._alive[i];
      const dx = e.position.x - center.x;
      const dy = e.position.y + e.height * 0.5 - center.y;
      const dz = e.position.z - center.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out[n++] = e;
    }
    return n;
  }

  /**
   * Splash. Damage falls off with distance on a curve, not linearly — a linear falloff makes
   * the edge of every explosion feel like it did nothing, and the centre feel identical to the
   * edge. `source` is copied, never retained.
   */
  damageSphere(center: Vector3, radius: number, damage: number, source: DamageInfo): number {
    const ctx = this.ctx;
    if (!ctx || radius <= 0) return 0;
    this.syncFrame(ctx);
    const info = this.splashInfo;
    let n = 0;
    // Iterate a snapshot length: a kill inside the loop removes from `_alive`, so walk backwards.
    for (let i = this._alive.length - 1; i >= 0; i--) {
      const e = this._alive[i];
      e.chestPoint(_v1);
      const d = _v1.distanceTo(center);
      if (d > radius) continue;
      const falloff = Math.pow(1 - clamp01(d / radius), 1.4);
      info.amount = damage * falloff;
      if (info.amount <= 0) continue;
      info.point.copy(_v1);
      info.direction.copy(_v1).sub(center);
      if (info.direction.lengthSq() < 1e-6) info.direction.set(0, 1, 0);
      info.direction.normalize();
      info.normal.copy(info.direction).negate();
      info.part = source.part === 'head' ? 'torso' : source.part;
      info.isCrit = false;
      info.knockback = source.knockback > 0 ? source.knockback * falloff : falloff;
      info.weaponId = source.weaponId;
      info.affix = source.affix;
      this.damage(e, info);
      n++;
    }
    return n;
  }

  /** NUKE. Everything dies loudly, through the normal path, so points and VFX all fire. */
  killAll(reason?: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const info = this.splashInfo;
    for (let i = this._alive.length - 1; i >= 0; i--) {
      const e = this._alive[i];
      e.chestPoint(_v1);
      info.amount = e.health + 1;
      info.point.copy(_v1);
      info.direction.set(0, -1, 0);
      info.normal.set(0, 1, 0);
      info.part = 'torso';
      info.isCrit = false;
      info.knockback = 1;
      info.weaponId = reason;
      this.damage(e, info);
    }
  }

  /** Silent removal — a round reset or a teardown. No events, no points, no VFX. */
  despawnAll(): void {
    for (let i = this._alive.length - 1; i >= 0; i--) this.recycle(this._alive[i]);
    for (let i = this.dying.length - 1; i >= 0; i--) this.recycle(this.dying[i]);
    this._alive.length = 0;
    this.dying.length = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Per-body pitch, stable for the life of a spawn: a horde where every groan is the same pitch
   * reads as one enormous animal. Derived from the id, not rolled per sound, so a given zombie
   * always sounds like itself.
   */
  private pitchFor(e: Enemy): number {
    const h = ((e.id * 2654435761) >>> 0) / 4294967296;
    return 0.82 + h * 0.4;
  }

  /**
   * DEBUG SPAWNING, so BUILD 003 is playable the moment the system is registered.
   * `Z` five around the player · `X` fill to 25 (the perf reading) · `B` kill the horde.
   * Deliberately not on a key `core/input.ts` binds (C is crouch, V melee, Q swap, G grenade).
   */
  private installDebugKeys(ctx: GameCtx): void {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.repeat || !ctx.input.pointerLocked) return;
      if (ev.code === 'KeyZ') { this.debugSpawn(ctx, 5); ctx.hud.toast(`HORDE · ${this._alive.length}`); }
      else if (ev.code === 'KeyX') { this.debugSpawn(ctx, 25 - this._alive.length); ctx.hud.toast(`HORDE · ${this._alive.length}`); }
      else if (ev.code === 'KeyB') { this.killAll('debug'); ctx.hud.toast('HORDE CLEARED'); }
      else return;
      ev.preventDefault();
    };
    window.addEventListener('keydown', onKey, { passive: false });
    this.offKeys = () => window.removeEventListener('keydown', onKey);
  }

  /** Ring the player at kiting distance, spread over the full circle. */
  private debugSpawn(ctx: GameCtx, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = this.rng.range(9, 22);
      _v1.set(
        ctx.player.position.x + Math.cos(a) * r,
        ctx.player.position.y + 1.5,
        ctx.player.position.z + Math.sin(a) * r,
      );
      const g = ctx.world.groundAt(_v1);
      if (g === null) continue;
      _v1.y = g;
      this.spawn('shambler', _v1, 1, 1);
    }
  }
}

export type { Enemy };

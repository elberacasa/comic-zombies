/**
 * WORLD COLLISION — the `WorldService` implementation.
 *
 * An `Octree` of *simplified proxy triangles* (never the visual meshes: the arena's merged
 * buckets are ~200k triangles, the collision world is ~4k boxes' worth) plus a hand-rolled
 * capsule solver.
 *
 * WHY NOT `Octree.capsuleIntersect()` DIRECTLY:
 *   1. It allocates — a `Vector3` clone per contact, a fresh triangle array per query. This
 *      runs several times per fixed step, at 120 Hz. Zero garbage in hot loops is the rule.
 *   2. Its triangle gathering dedupes with `Array.indexOf`, which is O(n²) in the number of
 *      candidate triangles. We stamp triangles with a query id instead: O(1).
 *   3. It resolves in a single pass, which leaves the capsule wedged in corners, and it has
 *      no notion of *grounded*, which the whole movement state machine depends on.
 *
 * THE CONTRACT THAT KEEPS THE FEEL CLEAN:
 *   - `collideCapsule(bottom, top, radius)` takes the two *sphere centres* of the capsule,
 *     not its extreme tips. Standard three.js `Capsule` convention.
 *   - Depenetration never pushes further than `radius` past a face — that is what stops a
 *     player pressed against a thin fence from being ejected out the other side. Deep floor
 *     penetration (a fast fall landing between steps) is caught separately by a downward
 *     rescue ray, so you can never sink through the ground.
 *   - `grounded` is sticky: a short probe ray keeps it true while you walk down stairs, so
 *     the movement state machine never flickers between `walk` and `air`.
 */

import { Box3, Group, Plane, Ray, Triangle, Vector3 } from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { Octree } from 'three/addons/math/Octree.js';
import type { CapsuleCollision, RaycastHit, SurfaceKind, WorldService } from '@/core/types';
import type { Arena, ArenaCollider, ArenaZone } from '@/world/arena';

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fallbacks only. The walkable-slope limit and the sticky-ground reach are MOVEMENT feel
 * constants and live in `game/tuning.ts` — but `world/` must not import `game/`, so the
 * integrator passes them in (`WorldOptions.groundNormalY` / `.groundProbe`).
 *
 * These two used to be hardcoded here at 0.5 / 0.18 while the controller used 0.6 / (nothing),
 * which left the player *grounded* on 53–60° ramps that the controller classified as too steep:
 * a stale ground normal feeding the slide solver plus a wasted step-up raycast every substep.
 * One source of truth now.
 */
const DEFAULT_GROUND_NORMAL_Y = 0.6;
const DEFAULT_GROUND_PROBE = 0.18;
/** Depenetration passes. 4 resolves any realistic corner; 1 leaves you wedged. */
const SOLVER_PASSES = 4;
/** Stop when a pass moves us less than this. */
const SOLVER_EPS = 1e-4;
/** A hair of extra push so we rest *just* outside the surface instead of exactly on it. */
const SKIN = 0.0015;
/**
 * Ceiling on a single deep-escape push, in radii. The escape only fires for a capsule that is
 * genuinely enclosed (see `capsuleTriangle`), and four passes at four radii each is enough to
 * leave anything in this arena — while keeping the worst single-step displacement small enough
 * that it reads as being shoved out rather than as a teleport.
 */
const DEEP_ESCAPE_CAP = 4;
/**
 * The escape marches out in steps of this many radii and takes the FIRST landing that is proven
 * clear (see `collideCapsule`). A quarter-radius is ~9 cm on a shambler: fine enough that the
 * body leaves by the smallest push that actually works, coarse enough that the whole march is at
 * most 32 probes — and the march only ever runs on a capsule that is genuinely enclosed, which
 * over a 120 s soak of 25 bodies is a few dozen steps out of 360 000.
 */
const DEEP_ESCAPE_STRIDE = 0.25;
/**
 * How far the march LOOKS, in radii, which is deliberately further than it will ever PUSH. A
 * capsule inside a 2 m thick block still has to be told which way is out; capping the search at
 * the same 4 radii it commits would make that case indistinguishable from "this normal is not an
 * exit at all", and the second case is the one that used to fling bodies across the arena.
 */
const DEEP_ESCAPE_REACH = 8;
/** Ordinary contact a proven escape landing may still have. Forgives resting on a floor. */
const DEEP_LANDING_TOL = 0.02;
/** How far the floor-rescue ray looks below the capsule. */
const RESCUE_DEPTH = 3.0;
/** AI steering probe length. Local avoidance, not pathfinding — arena scale does not move it. */
const STEER_PROBE = 2.9;
/**
 * How far down `groundAt` looks. Raised from 60 to 140 for the BUILD 002 arena: the map is
 * now 140 m across and 34 m tall, and the director calls `findFreeSpawn` → `groundAt` from
 * points that can sit well above the deck they belong to. A miss here silently returns null
 * and the spawn is refused, which is invisible in the frame and infuriating to debug.
 */
const GROUND_SEARCH = 140;

// ─────────────────────────────────────────────────────────────────────────────
// Tagged triangle — carries the surface family and a query stamp for O(1) dedupe.
// ─────────────────────────────────────────────────────────────────────────────

class SurfTriangle extends Triangle {
  surface: SurfaceKind = 'concrete';
  mark = 0;
}

// Module-level scratch. Nothing in this file allocates after `build()`.
const _plane = new Plane();
const _ray = new Ray();
const _ip = new Vector3();
const _p1 = new Vector3();
const _p2 = new Vector3();
const _n = new Vector3();
const _bestN = new Vector3();
const _groundN = new Vector3();
const _capStart = new Vector3();
const _capEnd = new Vector3();
const _dir = new Vector3();
const _flat = new Vector3();
const _probe = new Vector3();
const _tmp = new Vector3();
const _tmp2 = new Vector3();
const _u = new Vector3();
const _v = new Vector3();
const _w = new Vector3();
// Dedicated to the octree gather so it can never clobber a caller's scratch mid-query.
const _g1 = new Vector3();
const _g2 = new Vector3();
const _steerOrigin = new Vector3();
const UP = new Vector3(0, 1, 0);

/** Closest points between two segments. Port of the Octree helper, allocation-free. */
function segmentClosest(
  a0: Vector3, a1: Vector3, b0: Vector3, b1: Vector3, outA: Vector3, outB: Vector3,
): void {
  _u.copy(a1).sub(a0);
  _v.copy(b1).sub(b0);
  _w.copy(b0).sub(a0);
  const a = _u.dot(_v);
  const b = _u.dot(_u);
  const c = _v.dot(_v);
  const d = _v.dot(_w);
  const e = _u.dot(_w);
  let t1: number;
  let t2: number;
  const div = b * c - a * a;
  if (Math.abs(div) < 1e-10) {
    const d1 = -d / c;
    const d2 = (a - d) / c;
    if (Math.abs(d1 - 0.5) < Math.abs(d2 - 0.5)) { t1 = 0; t2 = d1; } else { t1 = 1; t2 = d2; }
  } else {
    t1 = (d * a + e * c) / div;
    t2 = (t1 * a - d) / c;
  }
  t1 = t1 < 0 ? 0 : t1 > 1 ? 1 : t1;
  t2 = t2 < 0 ? 0 : t2 > 1 ? 1 : t2;
  outA.copy(_u).multiplyScalar(t1).add(a0);
  outB.copy(_v).multiplyScalar(t2).add(b0);
}

/**
 * ═══ THE DEEP CHANNEL (BUILD 006) ═══
 *
 * `capsuleTriangle` refuses to resolve a capsule whose BOTH sphere centres sit behind a face,
 * and that refusal is correct in the common case: pushing there would eject a player pressed
 * against a thin fence out the far side of it. But it is also the reason a body that somehow
 * ends up genuinely INSIDE a wall or an orange panel can never get out — every face of the
 * volume it is inside refuses, the solver reports depth 0, and the body is wedged forever.
 * MEASURED before this change, 25 bodies × 120 s: 8 bodies inside geometry on the flat test,
 * worst overlap 1.14 m — i.e. a whole body-width inside a solid.
 *
 * So the refusal now RECORDS the escape it declined to make. `collideCapsule` uses it only when
 * a whole pass produced no ordinary contact at all, which is exactly the "enclosed, nothing can
 * push me" state and never the "leaning on a fence" state. The shallowest recorded plane wins,
 * so we always leave by the nearest face.
 */
let _deepDepth = 0;
let _deepCount = 0;
const _deepN = new Vector3();
const _deepSum = new Vector3();
/** The chosen escape, held across the landing probe (which overwrites `_deepN`/`_deepDepth`). */
const _escapeN = new Vector3();
const _escapeA = new Vector3();
const _escapeB = new Vector3();

/**
 * Capsule vs triangle. Returns penetration depth (0 = no contact) and writes the
 * push-out direction into `out`.
 *
 * On the deep-refusal path it also writes `_deepDepth` / `_deepN` (see above) — the caller
 * decides whether to act on them.
 */
function capsuleTriangle(start: Vector3, end: Vector3, radius: number, tri: Triangle, out: Vector3): number {
  tri.getPlane(_plane);
  const ds = _plane.distanceToPoint(start);
  const de = _plane.distanceToPoint(end);
  const d1 = ds - radius;
  const d2 = de - radius;

  // Fully in front → no contact.
  if (d1 > 0 && d2 > 0) return 0;

  // Both centres behind the face → refuse to resolve here (thin geometry would eject us), but
  // remember the escape so a fully enclosed capsule is not left with no way out at all.
  if (d1 < -radius && d2 < -radius) {
    // Only if we are actually WITHIN this face's extent — the projection of the nearer sphere
    // centre onto the plane has to land on the triangle itself.
    const near = Math.abs(ds) < Math.abs(de) ? start : end;
    _ip.copy(near).addScaledVector(_plane.normal, -_plane.distanceToPoint(near));
    if (tri.containsPoint(_ip)) {
      // Push the DEEPEST centre to a radius in front of the plane.
      const escape = radius - Math.min(ds, de);
      _deepCount++;
      _deepSum.add(_plane.normal);
      if (_deepDepth === 0 || escape < _deepDepth) {
        _deepDepth = escape;
        _deepN.copy(_plane.normal);
      }
    }
    return 0;
  }

  const sum = Math.abs(d1) + Math.abs(d2);
  const delta = sum > 1e-9 ? Math.abs(d1 / sum) : 0.5;
  _ip.copy(start).lerp(end, delta);
  if (tri.containsPoint(_ip)) {
    out.copy(_plane.normal);
    /**
     * ═══ A TRIANGLE HAS NO THICKNESS, SO IT CANNOT PUSH FURTHER THAN A RADIUS ═══
     *
     * This used to be a bare `Math.abs(Math.min(d1, d2))` (the three.js Octree formula), which is
     * only bounded while BOTH sphere centres are near the plane. The refusal above catches the
     * case where both are more than a radius behind it — but not the STRADDLE, where one centre
     * is metres behind the plane and the other is in front. There `min(d1, d2)` is the distance
     * to the far centre, and the solver dutifully shoved the entire capsule that far along the
     * face normal. That sphere is not touching the triangle at all; it is past it.
     *
     * MEASURED at the foot of `east_stair` (56, 0, -30), which is where the soak's worst readings
     * and its longest stalls both live: a shambler standing on the PAVEMENT straddles the
     * underside plane of the rotated stair slab — bottom sphere below it, head above it — and the
     * solver returned depth 1.94 m along (0, -0.41, -0.91), i.e. "please move down and backwards
     * by two metres". Bodies were landing at y = -0.28, under the deck. 24 samples at that one
     * site in a 120 s soak, and it is the same shape at every flight in the arena.
     *
     * A radius is the true ceiling: it is the deepest a sphere can be inside an infinitely thin
     * surface and still be in contact with it. This restores the contract this file's own header
     * has always claimed ("depenetration never pushes further than `radius` past a face"). Genuine
     * deep floor penetration is not this function's job and never was — the downward rescue ray
     * below owns it, and the deep escape owns being properly enclosed.
     */
    const depth = Math.abs(Math.min(d1, d2));
    return depth > radius ? radius : depth;
  }

  const r2 = radius * radius;
  for (let e = 0; e < 3; e++) {
    const ea = e === 0 ? tri.a : e === 1 ? tri.b : tri.c;
    const eb = e === 0 ? tri.b : e === 1 ? tri.c : tri.a;
    segmentClosest(start, end, ea, eb, _p1, _p2);
    const dsq = _p1.distanceToSquared(_p2);
    if (dsq < r2) {
      out.copy(_p1).sub(_p2);
      const len = Math.sqrt(dsq);
      if (len < 1e-8) return 0;
      out.divideScalar(len);
      return radius - len;
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ENCLOSURE, and it is the guard that makes the deep escape safe.
 *
 * Being behind ONE face proves nothing: an arena face can be tens of metres across, so a player
 * falling past a building is "behind" its roof plane with the projection still landing inside the
 * triangle. MEASURED before this test existed: walking off the 34 m perimeter roof, the falling
 * capsule was shoved 3.25 m back onto the roof every 0.6 s, forever — a float bug reintroduced by
 * the fix for a different float bug.
 *
 * Being behind SEVERAL faces whose normals point in conflicting directions is what "inside a
 * solid" actually means. Coplanar faces (one big wall, however many triangles) sum to full
 * length and are rejected; the six faces of a box sum to ~zero and are accepted.
 */
/*
 * ⚠ AND THAT TEST FALSE-POSITIVED ON EVERY STAIRCASE IN THE ARENA. A `stairRun` collider is a
 * thin ROTATED SLAB. A capsule standing legitimately on top of one is behind the slab's underside
 * AND behind its lower end cap — two faces whose normals are ~90° apart, which sums to
 * count × 0.707 and sails under the 0.85 bar. The deep escape then fired on every solver pass
 * that found no ordinary contact (constant on a slope) and shoved the body up to `radius * 4`.
 *
 * The missing half of the test: an escape is only real if the faces we are behind actually
 * OPPOSE it. Inside a box, the other faces point back at you and the sum dots negative against
 * the chosen escape normal. On a stair the faces ENDORSE it — they agree with the direction we
 * were about to be flung — and `_deepSum · _deepN` comes out large and positive.
 */
function enclosed(): boolean {
  if (_deepCount < 2) return false;
  if (_deepSum.length() >= _deepCount * 0.85) return false;
  return _deepSum.dot(_deepN) <= 0.5;
}

const HIT_RING = 8;

function makeHit(): RaycastHit {
  return { hit: false, point: new Vector3(), normal: new Vector3(0, 1, 0), distance: 0, surface: 'concrete' };
}

/** Movement constants the solver needs but does not own. See `game/tuning.ts` MOVE. */
export interface CollisionOptions {
  /** cos of the steepest walkable slope. MUST match `MOVE.minGroundNormalY`. */
  groundNormalY?: number;
  /** Sticky-ground probe reach, metres. MUST match `MOVE.groundProbe`. */
  groundProbe?: number;
}

export class WorldCollision implements WorldService {
  readonly root: Group;
  readonly playerSpawn: { position: Vector3; yaw: number };
  readonly enemySpawns: readonly Vector3[];
  readonly bounds: Box3;
  readonly zones: readonly ArenaZone[];

  /** Live triangle count in the collision world — worth watching in the debug panel. */
  readonly triangleCount: number;

  private readonly octree = new Octree();
  private readonly tris: SurfTriangle[] = [];
  private readonly capsule = new Capsule(new Vector3(), new Vector3(), 0.4);
  private readonly hits: RaycastHit[] = [];
  private readonly result: CapsuleCollision = {
    correction: new Vector3(), normal: new Vector3(0, 1, 0), grounded: false, depth: 0,
  };
  private hitIndex = 0;
  private stamp = 1;

  /** cos of the steepest slope that counts as ground. Supplied by the integrator. */
  private readonly groundNormalY: number;
  /** Extra reach of the sticky-ground probe, metres. */
  private readonly groundProbe: number;

  constructor(root: Group, arena: Arena, opts: CollisionOptions = {}) {
    this.groundNormalY = opts.groundNormalY ?? DEFAULT_GROUND_NORMAL_Y;
    this.groundProbe = opts.groundProbe ?? DEFAULT_GROUND_PROBE;
    this.root = root;
    this.playerSpawn = arena.playerSpawn;
    this.enemySpawns = arena.enemySpawns;
    this.bounds = arena.bounds;
    this.zones = arena.zones;
    for (let i = 0; i < HIT_RING; i++) this.hits.push(makeHit());
    this.triangleCount = this.buildFrom(arena.colliders);
  }

  // ── build ────────────────────────────────────────────────────────────────

  private buildFrom(colliders: readonly ArenaCollider[]): number {
    let count = 0;
    for (const c of colliders) {
      const geo = c.geometry.index ? c.geometry.toNonIndexed() : c.geometry;
      const pos = geo.getAttribute('position');
      for (let i = 0; i < pos.count; i += 3) {
        const t = new SurfTriangle(
          new Vector3().fromBufferAttribute(pos, i),
          new Vector3().fromBufferAttribute(pos, i + 1),
          new Vector3().fromBufferAttribute(pos, i + 2),
        );
        t.surface = c.surface;
        this.octree.addTriangle(t);
        count++;
      }
      if (geo !== c.geometry) geo.dispose();
    }
    this.octree.build();
    return count;
  }

  // ── gathering (O(1) dedupe via a per-query stamp) ─────────────────────────

  private gatherRay(node: Octree, ray: Ray, maxDistance: number): void {
    const subs = node.subTrees;
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i] as Octree;
      const box = sub.box;
      if (!box || !ray.intersectsBox(box)) continue;
      const reach = maxDistance + box.getSize(_g2).length();
      if (ray.origin.distanceToSquared(box.getCenter(_g1)) > reach * reach) continue;
      if (sub.triangles.length > 0) {
        for (let j = 0; j < sub.triangles.length; j++) {
          const t = sub.triangles[j] as SurfTriangle;
          if (t.mark === this.stamp) continue;
          t.mark = this.stamp;
          this.tris.push(t);
        }
      } else {
        this.gatherRay(sub, ray, maxDistance);
      }
    }
  }

  private gatherCapsule(node: Octree, cap: Capsule): void {
    const subs = node.subTrees;
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i] as Octree;
      const box = sub.box;
      if (!box || !cap.intersectsBox(box)) continue;
      if (sub.triangles.length > 0) {
        for (let j = 0; j < sub.triangles.length; j++) {
          const t = sub.triangles[j] as SurfTriangle;
          if (t.mark === this.stamp) continue;
          t.mark = this.stamp;
          this.tris.push(t);
        }
      } else {
        this.gatherCapsule(sub, cap);
      }
    }
  }

  // ── raycast ──────────────────────────────────────────────────────────────

  /**
   * Nearest front-facing hit within `maxDistance`.
   *
   * The returned record comes from a ring of 8 — it stays valid for the next 7 calls, which
   * covers any realistic "trace, then use the result" pattern without allocating. Copy the
   * point/normal if you intend to keep them longer than a frame.
   */
  raycast(origin: Vector3, dir: Vector3, maxDistance: number): RaycastHit {
    const hit = this.hits[this.hitIndex] as RaycastHit;
    this.hitIndex = (this.hitIndex + 1) % HIT_RING;

    _dir.copy(dir);
    if (_dir.lengthSq() < 1e-12) _dir.set(0, 0, -1);
    _dir.normalize();
    _ray.origin.copy(origin);
    _ray.direction.copy(_dir);

    this.stamp++;
    this.tris.length = 0;
    this.gatherRay(this.octree, _ray, maxDistance);

    let best = maxDistance;
    let bestTri: SurfTriangle | null = null;
    for (let i = 0; i < this.tris.length; i++) {
      const t = this.tris[i] as SurfTriangle;
      if (_ray.intersectTriangle(t.a, t.b, t.c, true, _ip) === null) continue;
      const d = _ip.distanceTo(origin);
      if (d < best) {
        best = d;
        bestTri = t;
        _p1.copy(_ip);
      }
    }

    if (!bestTri) {
      hit.hit = false;
      hit.distance = maxDistance;
      hit.point.copy(origin).addScaledVector(_dir, maxDistance);
      hit.normal.copy(_dir).negate();
      hit.surface = 'concrete';
      return hit;
    }

    hit.hit = true;
    hit.distance = best;
    hit.point.copy(_p1);
    bestTri.getNormal(hit.normal);
    if (hit.normal.dot(_dir) > 0) hit.normal.negate();
    hit.surface = bestTri.surface;
    return hit;
  }

  // ── capsule ──────────────────────────────────────────────────────────────

  /**
   * `bottom` and `top` are the capsule's sphere CENTRES (three.js `Capsule` convention):
   * a 1.8 m player with a 0.4 m radius is `bottom = feet + 0.4`, `top = feet + 1.4`.
   */
  collideCapsule(bottom: Vector3, top: Vector3, radius: number): CapsuleCollision {
    const out = this.result;
    _capStart.copy(bottom);
    _capEnd.copy(top);

    let grounded = false;
    let bestDepth = 0;
    let bestGroundY = -1;
    _bestN.set(0, 1, 0);
    _groundN.set(0, 1, 0);

    for (let pass = 0; pass < SOLVER_PASSES; pass++) {
      this.capsule.start.copy(_capStart);
      this.capsule.end.copy(_capEnd);
      this.capsule.radius = radius;

      this.stamp++;
      this.tris.length = 0;
      this.gatherCapsule(this.octree, this.capsule);
      if (this.tris.length === 0) break;

      let moved = 0;
      _deepDepth = 0;
      _deepCount = 0;
      _deepSum.set(0, 0, 0);
      for (let i = 0; i < this.tris.length; i++) {
        const t = this.tris[i] as SurfTriangle;
        const depth = capsuleTriangle(_capStart, _capEnd, radius, t, _n);
        if (depth <= 0) continue;
        const push = depth + SKIN;
        _capStart.addScaledVector(_n, push);
        _capEnd.addScaledVector(_n, push);
        moved += push;

        if (_n.y >= this.groundNormalY) {
          grounded = true;
          if (_n.y > bestGroundY) { bestGroundY = _n.y; _groundN.copy(_n); }
        }
        if (depth > bestDepth) { bestDepth = depth; _bestN.copy(_n); }
      }

      // ── THE DEEP ESCAPE ──────────────────────────────────────────────────────
      // Nothing in this whole pass could push us anywhere, yet at least one face reports that
      // we are behind it and within its extent: we are INSIDE something. Leave by the nearest
      // face. Capped per pass so a body that is somehow inside a whole building walks out over
      // a few passes rather than teleporting across the map in one.
      //
      // ═══ WHERE IT LANDS IS NOT OPTIONAL (MAP INTEGRITY) ═══
      // `_deepDepth` is the distance to the far side of ONE plane. It says nothing about what
      // occupies the space along the way, so the escape used to be a blind shove of up to
      // `radius * 4` = 1.48 m per pass — four passes of that is 5.9 m of unvalidated travel, and
      // the mover then applies the sum (clamped at `MotionParams.maxCorrection`) in one step.
      //
      // MEASURED, 25 bodies × 120 s with the player camped: 27 of 31 clean→embedded transitions
      // were this. The worst was id=16 at t=90.90 s — 0.000 → 0.343 m deep, displaced 3.195 m in
      // a single step while travelling 0.0135 m, landing at y = -0.28 (below the deck). And the
      // field this produces is not continuous: sampling a ±0.20 m box at 2 cm around a spot a
      // body had been standing CLEAN in one step earlier, 180 of 441 cells reported over 1 m,
      // worst 2.11 m. Bodies were not failing to leave walls — they were being thrown into them.
      //
      // So the escape now MARCHES and PROVES. It steps out along the chosen normal and commits
      // at the first landing where the capsule genuinely fits, which is almost always a few
      // centimetres rather than a metre; a capsule inside something genuinely thick still gets
      // its full `DEEP_ESCAPE_CAP` shove, but only once the march has seen air on the far side.
      if (moved === 0 && _deepDepth > 0 && enclosed()) {
        // `_deepN` / `_deepDepth` are clobbered by every landing probe — take our copy first.
        _escapeN.copy(_deepN);
        const reach = Math.min(_deepDepth + SKIN, radius * DEEP_ESCAPE_REACH);
        const stride = radius * DEEP_ESCAPE_STRIDE;
        let clear = 0;
        for (let d = stride; d <= reach; d += stride) {
          _escapeA.copy(_capStart).addScaledVector(_escapeN, d);
          _escapeB.copy(_capEnd).addScaledVector(_escapeN, d);
          if (this.landingClear(_escapeA, _escapeB, radius)) { clear = d; break; }
        }
        // NO PROVEN LANDING, NO ESCAPE. `enclosed()` is a heuristic over face normals and it does
        // false-positive — measured at the foot of `plaza_stair` (17.5, 0.24, 21.7), where 150 of
        // 441 cells in a ±0.20 m box around a spot bodies stand in CLEANLY reported over 1 m of
        // solver depth. Every one of those was this escape firing its full cap into a direction
        // that leads nowhere. If eight radii of march cannot find air, this normal is not an exit
        // and the honest answer is the one the refusal already gives: report no contact.
        if (clear > 0) {
          const push = Math.min(clear, radius * DEEP_ESCAPE_CAP);
          _capStart.addScaledVector(_escapeN, push);
          _capEnd.addScaledVector(_escapeN, push);
          moved = push;
          if (_escapeN.y >= this.groundNormalY) {
            grounded = true;
            if (_escapeN.y > bestGroundY) { bestGroundY = _escapeN.y; _groundN.copy(_escapeN); }
          }
          if (push > bestDepth) { bestDepth = push; _bestN.copy(_escapeN); }
        }
      }

      if (moved < SOLVER_EPS) break;
    }

    // ── Deep-floor rescue ────────────────────────────────────────────────────
    // The depenetration above deliberately refuses to push more than a radius through a
    // face (thin geometry would eject us). A fast fall can land the capsule further than
    // that inside the floor between two fixed steps, so we look straight down and lift.
    if (!grounded) {
      _tmp.copy(_capEnd);
      const floor = this.raycast(_tmp, _tmp2.set(0, -1, 0), RESCUE_DEPTH + radius + _capEnd.y - _capStart.y);
      if (floor.hit && floor.normal.y >= this.groundNormalY) {
        const wantY = floor.point.y + radius;
        if (_capStart.y < wantY - 1e-4) {
          const lift = wantY - _capStart.y;
          _capStart.y += lift;
          _capEnd.y += lift;
          grounded = true;
          _groundN.copy(floor.normal);
          if (lift > bestDepth) { bestDepth = lift; _bestN.copy(floor.normal); }
        }
      }
    }

    // ── Sticky ground ────────────────────────────────────────────────────────
    // Walking down a stair or over a curb must never flicker `grounded` off for a frame:
    // the whole movement state machine (slide, coyote jump, landing VFX) keys off it.
    if (!grounded) {
      _tmp.copy(_capStart);
      const probe = this.raycast(_tmp, _tmp2.set(0, -1, 0), radius + this.groundProbe);
      if (probe.hit && probe.normal.y >= this.groundNormalY) {
        grounded = true;
        _groundN.copy(probe.normal);
      }
    }

    out.correction.copy(_capStart).sub(bottom);
    out.depth = out.correction.length();
    out.grounded = grounded;
    out.normal.copy(grounded ? _groundN : _bestN);
    if (out.depth < 1e-6) out.normal.copy(grounded ? _groundN : UP);
    return out;
  }

  // ── AI steering ──────────────────────────────────────────────────────────

  /**
   * Seek `to` with short whisker probes for wall avoidance. Steering, not pathfinding —
   * GAME_BIBLE §4 wants the horde to flow and clump, not to solve a maze.
   *
   * ═══ A RAMP IS NOT A WALL (BUILD 005) ═══
   * The whiskers are cast HORIZONTALLY from chest height, so on a 34° staircase the surface
   * ahead of you crosses the whisker about 1.4 m out — and the old code scored that as a
   * head-on obstacle and steered around it. The measured result was exact and repeatable: a
   * shambler walked 1.7 m up the NE roof flight, was deflected sideways off the stringer by its
   * own wall-avoidance, and fell back to the pavement. Every flight in the arena did this, which
   * is a large part of why "they dont go up stairs".
   *
   * A hit whose normal is walkable is GROUND, not geometry to dodge — you climb it. Testing the
   * normal against the same `groundNormalY` the capsule solver uses means the steering, the
   * movement solver and the nav graph all agree on what "walkable" means, which is the only way
   * three systems this coupled can stay coherent.
   */
  steer(from: Vector3, to: Vector3, out: Vector3): Vector3 {
    _flat.copy(to).sub(from);
    _flat.y = 0;
    const dist = _flat.length();
    if (dist < 1e-4) return out.set(0, 0, 0);
    _flat.divideScalar(dist);

    // Chest height, so the probes don't graze kerbs and rubble.
    _steerOrigin.copy(from);
    _steerOrigin.y += 0.95;

    const reach = Math.min(STEER_PROBE, dist);
    let bestScore = -Infinity;
    let bestAngle = 0;
    // Straight ahead first, then progressively wider whiskers on alternating sides.
    for (let i = 0; i < 7; i++) {
      const angle = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * (0.38 + Math.floor((i - 1) / 2) * 0.42);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      _probe.set(_flat.x * c - _flat.z * s, 0, _flat.x * s + _flat.z * c);
      const hit = this.raycast(_steerOrigin, _probe, reach);
      // A walkable slope crossing the whisker is a ramp you walk UP, not a wall you go round.
      const blocked = hit.hit && hit.normal.y < this.groundNormalY;
      const clear = blocked ? hit.distance / reach : 1;
      // Prefer clear lanes, then prefer not turning. Head-on walls score worst.
      const score = clear * 1.6 + Math.cos(angle) * 0.55 - (blocked && clear < 0.35 ? 1.2 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestAngle = angle;
      }
      if (i === 0 && clear > 0.99) break; // straight line is free — take it, skip the rest
    }

    const c = Math.cos(bestAngle);
    const s = Math.sin(bestAngle);
    out.set(_flat.x * c - _flat.z * s, 0, _flat.x * s + _flat.z * c);
    return out.normalize();
  }

  // ── queries ──────────────────────────────────────────────────────────────

  /** Ground height under `p`, or null if there is nothing below within `GROUND_SEARCH`. */
  groundAt(p: Vector3): number | null {
    _tmp.copy(p);
    _tmp.y += 0.6;
    const hit = this.raycast(_tmp, _tmp2.set(0, -1, 0), GROUND_SEARCH);
    return hit.hit ? hit.point.y : null;
  }

  /** Zone id containing `p` (last match wins — the specific volumes are pushed last). */
  zoneAt(p: Vector3): string | null {
    let found: string | null = null;
    for (const z of this.zones) if (z.box.containsPoint(p)) found = z.id;
    return found;
  }

  zone(id: string): ArenaZone | undefined {
    for (const z of this.zones) if (z.id === id) return z;
    return undefined;
  }

  /**
   * Nudge a spawn position onto free ground. Spawn points are authored, but props, doors
   * and future arena changes can graze one — the director should never fail to spawn
   * because a barrel moved 20 cm. Spirals outward, snapping to the ground each step.
   * Returns false if nothing within `search` metres works.
   *
   * The default search radius went 3.5 → 5.0 with the BUILD 002 rescale: every spawn point
   * now sits in a 3 m deep recessed doorway in the perimeter wall, so a 3.5 m spiral could
   * be entirely inside the recess if a rubble pile happened to land in the mouth. 5 m always
   * reaches the open ring boulevard, which is where the horde is supposed to end up anyway.
   */
  findFreeSpawn(near: Vector3, radius: number, height: number, out: Vector3, search = 5.0): boolean {
    for (let r = 0; r <= search; r += 0.25) {
      const steps = r === 0 ? 1 : 16;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = near.x + Math.cos(a) * r;
        const z = near.z + Math.sin(a) * r;
        _tmp.set(x, near.y + 0.6, z);
        const g = this.groundAt(_tmp);
        if (g === null) continue;
        _tmp.set(x, g + radius + 0.02, z);
        _tmp2.set(x, g + radius + 0.02 + Math.max(0.1, height - radius * 2), z);
        if (!this.capsuleFree(_tmp, _tmp2, radius)) continue;
        out.set(x, g, z);
        return true;
      }
    }
    out.copy(near);
    return false;
  }

  /**
   * Would a deep escape that ended here have actually got us OUT?
   *
   * Stricter than `capsuleFree` in the one way that matters to the escape: `capsuleTriangle`
   * returns 0 for a face we are entirely BEHIND, so a capsule buried in the middle of another
   * solid passes `capsuleFree` with flying colours. That is precisely the landing the escape must
   * never take. So this asks both questions — no ordinary contact worth the name, AND not
   * enclosed by the same test that authorised the escape in the first place.
   *
   * Runs only while a capsule is genuinely enclosed, so it costs nothing in the steady state.
   */
  private landingClear(bottom: Vector3, top: Vector3, radius: number): boolean {
    this.capsule.start.copy(bottom);
    this.capsule.end.copy(top);
    this.capsule.radius = radius;
    this.stamp++;
    this.tris.length = 0;
    this.gatherCapsule(this.octree, this.capsule);
    _deepDepth = 0;
    _deepCount = 0;
    _deepSum.set(0, 0, 0);
    let worst = 0;
    for (let i = 0; i < this.tris.length; i++) {
      const d = capsuleTriangle(bottom, top, radius, this.tris[i] as SurfTriangle, _n);
      if (d > worst) {
        if (d > DEEP_LANDING_TOL) return false;
        worst = d;
      }
    }
    return !enclosed();
  }

  /**
   * True if a capsule here is clear of static geometry. `tolerance` forgives the grazing
   * contact you always get from resting exactly on the floor.
   */
  capsuleFree(bottom: Vector3, top: Vector3, radius: number, tolerance = 0.02): boolean {
    this.capsule.start.copy(bottom);
    this.capsule.end.copy(top);
    this.capsule.radius = radius;
    this.stamp++;
    this.tris.length = 0;
    this.gatherCapsule(this.octree, this.capsule);
    for (let i = 0; i < this.tris.length; i++) {
      if (capsuleTriangle(bottom, top, radius, this.tris[i] as SurfTriangle, _n) > tolerance) return false;
    }
    return true;
  }

  /** Line-of-sight test — the spawn director uses it to stay out of the player's view. */
  visible(from: Vector3, to: Vector3): boolean {
    _tmp.copy(to).sub(from);
    const d = _tmp.length();
    if (d < 1e-4) return true;
    _tmp.divideScalar(d);
    const hit = this.raycast(from, _tmp, d - 0.05);
    return !hit.hit;
  }

  dispose(): void {
    this.octree.clear();
    this.tris.length = 0;
  }
}

export function buildCollision(root: Group, arena: Arena, opts: CollisionOptions = {}): WorldCollision {
  return new WorldCollision(root, arena, opts);
}

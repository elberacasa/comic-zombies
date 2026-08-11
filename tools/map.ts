/**
 * THE MAP-INTEGRITY HARNESS — "walls are walls, stairs are stairs, and it has to be consistent".
 *
 *     node tools/map.mjs                # everything
 *     node tools/map.mjs reach          # the walkable atlas + reachability flood fill
 *     node tools/map.mjs inside         # no reachable point is inside a solid
 *     node tools/map.mjs speed          # nothing passes through a wall at kit-maximum speed
 *     node tools/map.mjs stairs         # every flight's COLLISION profile is a ramp
 *     node tools/map.mjs floors         # every drawn walkable surface has a collider
 *
 * IT EXITS NON-ZERO WHEN THE ARENA IS UNSOUND. `docs/MAP_INTEGRITY.md` §4 asks for an
 * INVARIANT rather than a list of patches, because the arena is going to grow to more maps
 * (`GAME_BIBLE` §9.1) and "95% solid" is a property that decays silently. This file is that
 * invariant. It is deliberately map-agnostic except for `tools/routes.ts`: everything else is
 * derived by probing the collision world, so a second arena costs one new staircase table.
 *
 * EVERY CHECK PRINTS A MEASURED NUMBER, NEVER A BARE BOOLEAN. These harnesses are read by a
 * human doing diagnosis; "3 of 412 sample points inside geometry, worst 0.31 m at
 * (12.4, 0.0, -33.1)" is worth an order of magnitude more than FAIL, because it says where to
 * look and how bad it is.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT "REACHABLE" MEANS HERE, AND WHY THE DEFINITION IS THE WHOLE DESIGN
 *
 *  `docs/MAP_INTEGRITY.md` §4 asks: "sample the walkable surface densely; for each point assert
 *  the player capsule does not intersect collision geometry." Taken literally that check is
 *  either trivially true or trivially false, depending on one decision:
 *
 *    • If a sample counts as walkable only when the player capsule FITS there, then asserting
 *      the capsule does not intersect anything is a tautology — the check cannot fail.
 *    • If every point with walkable ground under it counts, then the check fails everywhere:
 *      the roadway plane runs on underneath every building in the city, so ~25% of a 140 × 140
 *      grid sits inside a block, and a sample 20 cm from any wall overlaps it by 22 cm with a
 *      0.42 m capsule. Both are contact, not containment, and neither is a bug.
 *
 *  So the atlas below builds the honest middle: a surface sample is STANDABLE when the player
 *  capsule fits there after up to four depenetration passes — exactly what the mover would do
 *  to you on the frame you arrived — and REACHABLE when it is connected to the player spawn by
 *  a chain of standable samples the movement rules allow (`MOVE.stepHeight` up, any drop down).
 *  Reachability is then a graph fact, and the assertions in §1/§2 are run against that graph
 *  using machinery the graph did not use: the real `PlayerController` and the real `moveBody`.
 *  That is what makes them able to fail.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { installDomStub } from './domstub';

installDomStub();

const { Vector3 } = await import('three');
const { FIXED, buildRig, pad, padLeft } = await import('./rig');
const { MOVE } = await import('@/game/tuning');
const { moveBody, makeMotionParams, applyGravity, capsuleOverlapDepth } =
  await import('@/game/motion');
const { STAIRS } = await import('./routes');

const rig = buildRig(0x1234);
const { world, arena, controller, input } = rig;

const mode = process.argv[2] ?? 'all';
const want = (m: string): boolean => mode === 'all' || mode === m;
let failures = 0;

function hr(title: string): void {
  console.log(`\n${'─'.repeat(96)}\n${title}\n${'─'.repeat(96)}`);
}

function fail(line: string): void {
  failures++;
  console.log(`  *** ${line}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0. THE WALKABLE ATLAS — every standable spot in the arena, and which ones connect to spawn.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Grid pitch, metres. 0.5 puts ~4 samples inside the player's own 0.84 m footprint, which is
 * fine enough that a 1 m gap between two props is still sampled and coarse enough that the
 * whole atlas costs 148 866 walkable-surface probes in under a second (measured: 0.8 s for the
 * raycasts plus the standability settle, on the BUILD 008 arena).
 */
const GRID = 0.5;
/** Half-extent of the sampled square. `world.bounds` is larger; the playable city is ±70. */
const REACH_HALF = 70;
const GRID_N = Math.round((2 * REACH_HALF) / GRID) + 1;
/**
 * Vertical levels kept per column. The tallest stack in the arena is 5 (street · dock · deck ·
 * catwalk · roof); 12 is headroom that also bounds the key packing below.
 */
const MAX_LEVELS = 12;

/** One standable candidate: a walkable surface, plus where the capsule actually ends up. */
interface Spot {
  /** Standing height after settling. Seeded by the down-ray, then corrected like the mover. */
  y: number;
  /** Capsule centre after settling — this, not the grid point, is where a body actually is. */
  x: number;
  z: number;
  /** Did the capsule fit, within 2 cm, after at most four depenetration passes? */
  free: boolean;
  /** Residual overlap left at (x, y, z). Reported so "standable" is a number, not a verdict. */
  depth: number;
}

const columns: (Spot[] | null)[] = new Array(GRID_N * GRID_N).fill(null);

const _down = new Vector3(0, -1, 0);
const _from = new Vector3();
const _capA = new Vector3();
const _capB = new Vector3();

function colIndex(i: number, j: number): number { return i * GRID_N + j; }
function spotKey(i: number, j: number, k: number): number { return (i * GRID_N + j) * MAX_LEVELS + k; }
function keyI(key: number): number { return Math.floor(key / MAX_LEVELS / GRID_N); }
function keyJ(key: number): number { return Math.floor(key / MAX_LEVELS) % GRID_N; }
function keyK(key: number): number { return key % MAX_LEVELS; }
function spotOf(key: number): Spot {
  return (columns[colIndex(keyI(key), keyJ(key))] as Spot[])[keyK(key)] as Spot;
}

/**
 * Can the player stand here? Runs the loop the mover runs on arrival: test the capsule, take
 * the depenetration correction, test again. Four passes and a 0.5 m displacement budget —
 * `MOVE.maxCorrection` is 0.5 for exactly the same reason, and past it the "correction" is the
 * deep-escape path in `world/collision.ts`, i.e. the body was enclosed, which is precisely the
 * state this wants to call NOT standable.
 *
 * THE CORRECTION IS APPLIED IN ALL THREE AXES, and that detail decides whether the whole west
 * side of the map exists. A capsule dropped on the exact raycast point of a SLOPED surface is
 * always slightly inside it — the bottom sphere's nearest point to the ramp plane is not the
 * point directly under its centre — and every `stairRun` proxy in the arena reported a 0.029 m
 * residual because of it. Taking only the horizontal push left that residual untouched, so
 * every ramp in the arena was classified unstandable and the flood fill never left the ground
 * floor: 13.6 m catwalk absent, reachable set 16 240 m². Pushing in Y as well (which is what
 * `moveBody` does) recovers them.
 */
function settleCapsule(x: number, y: number, z: number, out: Spot): void {
  let px = x;
  let py = y;
  let pz = z;
  let depth = 0;
  for (let it = 0; it < 4; it++) {
    _capA.set(px, py + MOVE.radius, pz);
    _capB.set(px, py + MOVE.standHeight - MOVE.radius, pz);
    const c = world.collideCapsule(_capA, _capB, MOVE.radius);
    depth = c ? c.depth : 0;
    if (depth <= 0.02 || !c) break;
    if (c.correction.lengthSq() < 1e-8) break;
    px += c.correction.x;
    py += c.correction.y;
    pz += c.correction.z;
    if (Math.hypot(px - x, py - y, pz - z) > MOVE.maxCorrection) break;
  }
  out.x = px;
  out.y = py;
  out.z = pz;
  out.depth = depth;
  out.free = depth <= 0.02 && Math.hypot(px - x, py - y, pz - z) <= MOVE.maxCorrection;
}

interface Atlas {
  surfaces: number;
  standable: number;
  reachable: Set<number>;
  /** Reachable spots in deterministic key order — every sampler below walks this. */
  order: number[];
  levels: Map<number, number>;
  islands: number;
}

let atlas: Atlas | null = null;

function buildAtlas(): Atlas {
  const t0 = performance.now();
  let surfaces = 0;
  let standable = 0;
  for (let i = 0; i < GRID_N; i++) {
    const x = -REACH_HALF + i * GRID;
    for (let j = 0; j < GRID_N; j++) {
      const z = -REACH_HALF + j * GRID;
      let list: Spot[] | null = null;
      let y = 80;
      for (let k = 0; k < MAX_LEVELS; k++) {
        _from.set(x, y, z);
        const hit = world.raycast(_from, _down, 200);
        if (!hit.hit) break;
        const hy = hit.point.y;
        if (hit.normal.y >= MOVE.minGroundNormalY) {
          // +2 cm: the raycast lands exactly ON the face, and a capsule whose bottom sphere is
          // tangent to the floor is a coin-flip for the solver. The mover rests bodies just
          // proud of the surface for the same reason (`SKIN` in world/collision.ts).
          const s: Spot = { y: hy, x, z, free: false, depth: 0 };
          settleCapsule(x, hy + 0.02, z, s);
          if (!list) list = [];
          list.push(s);
          surfaces++;
          if (s.free) standable++;
        }
        y = hy - 0.05;
        if (y < -1) break;
      }
      columns[colIndex(i, j)] = list;
    }
  }

  // ── flood fill from the player spawn ──────────────────────────────────────────────────────
  const reachable = new Set<number>();
  const order: number[] = [];
  const spawn = world.playerSpawn.position;
  const si = Math.round((spawn.x + REACH_HALF) / GRID);
  const sj = Math.round((spawn.z + REACH_HALF) / GRID);
  const seedList = columns[colIndex(si, sj)];
  if (!seedList) throw new Error('[map] the player spawn column has no walkable surface at all');
  let seedK = -1;
  let seedD = Infinity;
  for (let k = 0; k < seedList.length; k++) {
    const d = Math.abs((seedList[k] as Spot).y - spawn.y);
    if (d < seedD) { seedD = d; seedK = k; }
  }
  const seed = seedList[seedK] as Spot;
  if (!seed.free) {
    // Not fatal — the spawn is where the game puts you, so it is reachable BY DEFINITION — but
    // it is worth shouting about, because it means you begin the round in contact with a solid.
    fail(`player spawn is not standable: residual overlap ${seed.depth.toFixed(3)} m ` +
      `at (${spawn.x.toFixed(1)}, ${spawn.y.toFixed(2)}, ${spawn.z.toFixed(1)})`);
  }
  reachable.add(spotKey(si, sj, seedK));
  order.push(spotKey(si, sj, seedK));

  const DIRS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let head = 0; head < order.length; head++) {
    const key = order[head] as number;
    const i = keyI(key);
    const j = keyJ(key);
    const y = spotOf(key).y;
    for (const [di, dj] of DIRS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= GRID_N || nj >= GRID_N) continue;
      const list = columns[colIndex(ni, nj)];
      if (!list) continue;
      // WALKING WINS OVER FALLING. Every free surface within a step is entered — a stair nose
      // and the tread above it can both be within 0.45 m and both are real places to be. Only
      // when nothing is within a step does the body fall, and then only to the HIGHEST surface
      // below: without that clause the fill drops from a catwalk straight onto the street it
      // overhangs and declares the whole basement reachable.
      let walked = false;
      let fallK = -1;
      let fallY = -Infinity;
      for (let k = 0; k < list.length; k++) {
        const s = list[k] as Spot;
        if (!s.free) continue;
        const dy = s.y - y;
        if (Math.abs(dy) <= MOVE.stepHeight) {
          walked = true;
          const kk = spotKey(ni, nj, k);
          if (reachable.has(kk)) continue;
          reachable.add(kk);
          order.push(kk);
        } else if (dy < 0 && s.y > fallY) { fallY = s.y; fallK = k; }
      }
      if (walked || fallK < 0) continue;
      const nk = spotKey(ni, nj, fallK);
      if (reachable.has(nk)) continue;
      reachable.add(nk);
      order.push(nk);
    }
  }

  // ── standable spots NOT connected to spawn — islands, counted by a second fill ─────────────
  const visited = new Set<number>(reachable);
  let islands = 0;
  const stack: number[] = [];
  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      const list = columns[colIndex(i, j)];
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        if (!(list[k] as Spot).free) continue;
        const key = spotKey(i, j, k);
        if (visited.has(key)) continue;
        islands++;
        visited.add(key);
        stack.length = 0;
        stack.push(key);
        while (stack.length) {
          const cur = stack.pop() as number;
          const ci = keyI(cur);
          const cj = keyJ(cur);
          const cy = spotOf(cur).y;
          for (const [di, dj] of DIRS) {
            const ni = ci + di;
            const nj = cj + dj;
            if (ni < 0 || nj < 0 || ni >= GRID_N || nj >= GRID_N) continue;
            const nl = columns[colIndex(ni, nj)];
            if (!nl) continue;
            for (let nk2 = 0; nk2 < nl.length; nk2++) {
              const s = nl[nk2] as Spot;
              if (!s.free || Math.abs(s.y - cy) > MOVE.stepHeight) continue;
              const kk = spotKey(ni, nj, nk2);
              if (visited.has(kk)) continue;
              visited.add(kk);
              stack.push(kk);
            }
          }
        }
      }
    }
  }

  const levels = new Map<number, number>();
  for (const key of order) {
    const b = Math.round(spotOf(key).y);
    levels.set(b, (levels.get(b) ?? 0) + 1);
  }

  const built: Atlas = { surfaces, standable, reachable, order, levels, islands };
  console.log(`  atlas built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return built;
}

function requireAtlas(): Atlas {
  if (!atlas) atlas = buildAtlas();
  return atlas;
}

function reachSection(): void {
  hr(`ARENA · THE WALKABLE ATLAS (${GRID_N}×${GRID_N} columns at ${GRID.toFixed(2)} m, ` +
    `capsule r=${MOVE.radius} h=${MOVE.standHeight})`);
  const a = requireAtlas();
  const area = a.reachable.size * GRID * GRID;
  console.log(`  walkable surfaces found    ${a.surfaces}`);
  console.log(`  standable (capsule fits)   ${a.standable}  ` +
    `(${((100 * a.standable) / a.surfaces).toFixed(1)}%)`);
  console.log(`  reachable from spawn       ${a.reachable.size} spots = ${area.toFixed(0)} m²`);
  const lv = [...a.levels.entries()].sort((p, q) => p[0] - q[0]).filter(([, c]) => c >= 8);
  console.log(`  by height                  ` +
    lv.map(([y, c]) => `${y}m:${c}`).join('  '));
  console.log(`  standable islands off the reachable set   ${a.islands}`);

  // ENEMY SPAWNS MUST BE REACHABLE. A spawn point in a pocket the flood fill cannot leave is a
  // horde that never arrives — the same defect class as a wall you can walk through, seen from
  // the director's side. `world.enemySpawns` is the exact list `EnemySystem` draws from.
  let orphan = 0;
  let worstOff = 0;
  let worstAt = '';
  for (const p of world.enemySpawns) {
    const i = Math.round((p.x + REACH_HALF) / GRID);
    const j = Math.round((p.z + REACH_HALF) / GRID);
    let best = Infinity;
    if (i >= 0 && j >= 0 && i < GRID_N && j < GRID_N) {
      const list = columns[colIndex(i, j)];
      if (list) {
        for (let k = 0; k < list.length; k++) {
          if (!a.reachable.has(spotKey(i, j, k))) continue;
          const d = Math.abs((list[k] as Spot).y - p.y);
          if (d < best) best = d;
        }
      }
    }
    if (best > 1.0) {
      orphan++;
      if (best > worstOff && best < Infinity) { worstOff = best; }
      if (worstAt === '') worstAt = `(${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)})`;
    }
  }
  console.log(`  enemy spawn points         ${world.enemySpawns.length}, ` +
    `${orphan} not connected to the player`);
  if (orphan > 0) fail(`${orphan} enemy spawn point(s) are unreachable — first at ${worstAt}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. NO REACHABLE POINT IS INSIDE A SOLID
//
// Run with the REAL `PlayerController`: teleport onto the spot, hold no input, let the game's
// own mover settle for 0.33 s, then ask four questions of where it ended up. The atlas picked
// the spot with a static four-pass capsule settle; the assertion drives the whole controller
// (gravity, ground snap, step-up, `recoverFromVoid`) for forty fixed steps, so the two cannot
// agree by construction — which is the only reason this check is able to fail.
//
// ── WHY THERE IS NO "SPINE PROBE" ────────────────────────────────────────────────────────────
// The obvious way to separate CONTACT from CONTAINMENT is to re-probe the same capsule at a
// tiny radius: a body at arm's length from a wall reports up to `MOVE.radius` (0.42 m) of
// overlap and is fine, a body whose capsule AXIS is inside the solid is not. It was built, and
// it does not work, because `collideCapsule` does not return a penetration depth for a capsule
// it decides is ENCLOSED — it returns the deep-escape magnitude, which `world/collision.ts`
// caps in RADII. Measured at seven flagged spots: depth 0.246 at r = 0.06, 0.406 at r = 0.10,
// 0.806 at r = 0.20, 1.206 at r = 0.30 — dead on 4r, i.e. the cap, not the geometry. A probe
// small enough to be a spine is small enough to be enclosed by every kerb it touches. The four
// measures below are raycast- or real-capsule-based and have no such failure mode.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Fixed steps of settling. 40 = 0.33 s: long enough to fall 0.54 m and stop bouncing. */
const SETTLE_STEPS = 40;
/** How many reachable spots to drive the controller onto. */
const INSIDE_SAMPLES = 2000;
/** Residual capsule overlap that still counts as resolved. `moveBody` leaves ~1.5 mm of SKIN. */
const RESIDUAL_TOL = 0.02;
/** Ignore hits in the bottom of the capsule — that is the floor the body is standing on. */
const ANKLE = 0.25;

/**
 * Height above the feet of the LOWEST collision surface that passes through the body, or 0 when
 * the body is clear. Raycasts only: it walks the downward hit stack from just under the crown of
 * the head and reports the deepest hit that is still inside the capsule. A floor slab crossing
 * the player's chest is "a wall you are inside" seen from the only side a raycast can see it.
 */
function buriedDepth(x: number, y: number, z: number): number {
  const from = new Vector3(x, y + MOVE.standHeight - 0.02, z);
  const dir = new Vector3(0, -1, 0);
  let lowest = 0;
  for (let i = 0; i < MAX_LEVELS; i++) {
    const hit = world.raycast(from, dir, 200);
    if (!hit.hit) break;
    const h = hit.point.y - y;
    if (h < ANKLE) break;
    lowest = h;
    from.y = hit.point.y - 0.02;
    if (from.y < y) break;
  }
  return lowest;
}

function insideSection(): void {
  hr('PLAYER · NO REACHABLE POINT IS INSIDE A SOLID (real controller, settled 0.33 s)');
  const a = requireAtlas();
  const stride = Math.max(1, Math.floor(a.order.length / INSIDE_SAMPLES));

  let tested = 0;
  let overlapping = 0;
  let worstOverlap = 0;
  let worstOverlapAt = '';
  let crouchOnly = 0;
  let buried = 0;
  let worstBuried = Infinity;
  let worstBuriedAt = '';
  let ejected = 0;
  let worstEject = 0;
  let worstEjectAt = '';
  let sank = 0;
  let worstSank = 0;
  let worstSankAt = '';
  const feet = new Vector3();

  for (let n = 0; n < a.order.length; n += stride) {
    const s = spotOf(a.order[n] as number);
    feet.set(s.x, s.y + 0.05, s.z);
    controller.teleport(feet, 0);
    input.reset();
    for (let i = 0; i < SETTLE_STEPS; i++) rig.stepPlayer(0);
    tested++;

    const p = controller.position;
    const overlap = capsuleOverlapDepth(world, p, MOVE.standHeight, MOVE.radius);
    const bury = buriedDepth(p.x, p.y, p.z);
    const slide = Math.hypot(p.x - s.x, p.z - s.z);
    const drop = s.y - p.y;

    if (overlap > RESIDUAL_TOL) {
      overlapping++;
      if (overlap > worstOverlap) {
        worstOverlap = overlap;
        worstOverlapAt = `(${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)})`;
      }
    }
    if (bury > 0 && bury >= MOVE.crouchHeight) crouchOnly++;
    if (bury > 0 && bury < MOVE.crouchHeight) {
      buried++;
      if (bury < worstBuried) {
        worstBuried = bury;
        worstBuriedAt = `(${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)})`;
      }
    }
    // 0.6 m of lateral travel with no input is not settling, it is being expelled: the spot the
    // atlas called standable was inside something the controller disagreed about.
    if (slide > 0.6) {
      ejected++;
      if (slide > worstEject) {
        worstEject = slide;
        worstEjectAt = `(${s.x.toFixed(1)}, ${s.y.toFixed(2)}, ${s.z.toFixed(1)})`;
      }
    }
    // Falling more than a step in 0.33 s of standing still means the floor was not there.
    if (drop > MOVE.stepHeight) {
      sank++;
      if (drop > worstSank) {
        worstSank = drop;
        worstSankAt = `(${s.x.toFixed(1)}, ${s.y.toFixed(2)}, ${s.z.toFixed(1)})`;
      }
    }
  }

  console.log(`  sampled                    ${tested} of ${a.reachable.size} reachable spots ` +
    `(every ${stride}${stride === 1 ? 'st' : 'th'})`);
  console.log(`  capsule still overlapping  ${overlapping} of ${tested} sample points` +
    (overlapping ? `, worst ${worstOverlap.toFixed(2)} m at ${worstOverlapAt}` : ''));
  console.log(`  crouch-only headroom       ${crouchOnly} of ${tested} sample points ` +
    `(ceiling between ${MOVE.crouchHeight.toFixed(2)} and ${MOVE.standHeight.toFixed(2)} m — ` +
    `low cover, not a fault)`);
  console.log(`  no headroom in any posture ${buried} of ${tested} sample points` +
    (buried ? `, ceiling ${worstBuried.toFixed(2)} m above the feet at ${worstBuriedAt}` : ''));
  console.log(`  expelled while standing    ${ejected}` +
    (ejected ? `, worst ${worstEject.toFixed(2)} m from ${worstEjectAt}` : ''));
  console.log(`  sank through the floor     ${sank}` +
    (sank ? `, worst ${worstSank.toFixed(2)} m at ${worstSankAt}` : ''));

  if (overlapping > 0) {
    fail(`${overlapping} of ${tested} reachable sample points leave the player capsule INSIDE ` +
      `geometry, worst ${worstOverlap.toFixed(2)} m at ${worstOverlapAt}`);
  }
  if (buried > 0) {
    fail(`${buried} of ${tested} reachable sample points have a ceiling below the CROUCH ` +
      `capsule (${MOVE.crouchHeight.toFixed(2)} m) — the body cannot exist there in any ` +
      `posture. Worst ${worstBuried.toFixed(2)} m above the feet at ${worstBuriedAt}`);
  }
  if (sank > 0) {
    fail(`${sank} of ${tested} reachable sample points have no floor under them, ` +
      `worst drop ${worstSank.toFixed(2)} m at ${worstSankAt}`);
  }
  if (ejected > 0) {
    fail(`${ejected} of ${tested} reachable sample points expel a standing player, ` +
      `worst ${worstEject.toFixed(2)} m from ${worstEjectAt}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. NO PASS-THROUGH AT SPEED
//
// Fire the player capsule at wall faces at the fastest the movement kit can produce, using the
// REAL `moveBody` with the player's own `MotionParams`. Three shapes, because the kit has three
// and they tunnel differently:
//
//   SPRINT   stand capsule (1.85 m) at `MOVE.speedHardCap` — the ceiling on a bhop/slide-cancel
//            chain, and therefore the fastest a body can ever be moving horizontally.
//   SLIDE    slide capsule (0.95 m) at the same speed. Short capsules find gaps tall ones cannot.
//   DIVE     dive capsule (0.95 m) at `speedHardCap` horizontally PLUS `MOVE.diveUp` vertically,
//            with `canSnap` and `canStepUp` off exactly as `PlayerController` sets them mid-dive,
//            and gravity applied at `diveGravityMult`. `docs/MAP_INTEGRITY.md` §4 names the dive
//            as the most likely thing in the game to tunnel; this is that shot.
//
// WHICH FACES. Found by probing, not by hand, so the set grows with the arena. A candidate is
// only fired at once four offset rays (±0.3 m sideways, ±0.5 m up) confirm the same face within
// 0.3 m, which throws away poles, railings and door jambs. That exclusion is deliberate: a
// capsule pressed into a one-triangle-thick fence is the one case where depenetration is
// *allowed* to pick a side, so firing at one would report a fault that is not one.
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface WallFace {
  x: number; y: number; z: number; nx: number; nz: number; groundY: number;
  /** Solid thickness along the shot axis, metres. Capped at `THICK_PROBE`. */
  thick: number;
}

/** How far past a face to look for its back. 1 m is thicker than any wall proxy in the arena. */
const THICK_PROBE = 1.0;

/**
 * Thickness of the solid behind a face, measured by walking a 3 cm sphere through it. Reported
 * with every pass-through, because it is the difference between two completely different bugs:
 * a 0.10 m reading is a fence rail the depenetration picked the wrong side of, a 0.90 m reading
 * is a wall a body buried itself in. A count of failures cannot tell you which you have.
 */
function faceThickness(x: number, y: number, z: number, dx: number, dz: number): number {
  const a = new Vector3();
  for (let d = 0.02; d <= THICK_PROBE; d += 0.02) {
    a.set(x + dx * d, y, z + dz * d);
    const c = world.collideCapsule(a, a, 0.03);
    if (!c || c.depth <= 0) return d;
  }
  return THICK_PROBE;
}

/** Metres of run-up in front of the face. The capsule must stop with its surface on the face. */
const LAUNCH_BACK = 1.0;
/** Metres of bite allowed before it counts as a pass-through. */
const BITE_TOL = 0.12;
/** Metres of sideways drift after which the shot is a flank, not a pass-through. */
const FLANK_LANE = 0.6;
const SPEED_FACES = 500;

function findWallFaces(): WallFace[] {
  const a = requireAtlas();
  const found: WallFace[] = [];
  const seen = new Set<string>();
  const org = new Vector3();
  const dir = new Vector3();
  const side = new Vector3();
  const probe = new Vector3();
  const _launch = new Vector3();
  const stride = Math.max(1, Math.floor(a.order.length / 6000));

  for (let n = 0; n < a.order.length; n += stride) {
    const s = spotOf(a.order[n] as number);
    org.set(s.x, s.y + 1.0, s.z);
    for (let d = 0; d < 8; d++) {
      const ang = (d * Math.PI) / 4;
      dir.set(Math.cos(ang), 0, Math.sin(ang));
      const hit = world.raycast(org, dir, 5);
      if (!hit.hit) continue;
      if (hit.distance < LAUNCH_BACK + MOVE.radius + 0.1) continue;   // no room for the run-up
      if (Math.abs(hit.normal.y) > 0.5) continue;                     // a floor or a ceiling
      // Quantise to 1.5 m so a long facade contributes a handful of shots, not four hundred.
      const key = `${Math.round(hit.point.x / 1.5)},${Math.round(hit.point.y / 1.5)},` +
        `${Math.round(hit.point.z / 1.5)},${Math.round(hit.normal.x)},${Math.round(hit.normal.z)}`;
      if (seen.has(key)) continue;

      const px = hit.point.x;
      const py = hit.point.y;
      const pz = hit.point.z;
      const nx = hit.normal.x;
      const nz = hit.normal.z;
      // WHAT COUNTS AS A WALL. Four offset rays must find the same face within 0.3 m: ±0.3 m
      // sideways, and — the two that matter — a SKIRT ray 0.17 m off the floor and a CROWN ray
      // at 1.72 m. Without those two the harness fires at things it is wrong to be stopped by:
      // measured on BUILD 008, the barrier at (-17.0, 60.0) has its collider starting above the
      // 0.95 m slide capsule, so `slide` and `dive` "passed through" it 6.9 m — which is not a
      // hole, it is sliding under a barrier, i.e. the movement kit working. A wall the harness
      // asserts you cannot pass must be solid from the floor to over your head.
      //
      // It does NOT have to be THICK. A fence rail 2 cm deep that a sprint goes straight through
      // is the playtester's complaint word for word, so thin faces stay in the set and their
      // thickness is measured and printed instead.
      side.set(-dir.z, 0, dir.x);
      let broad = true;
      for (const [ox, oy] of [[0.3, 0], [-0.3, 0], [0, 0.7], [0, -0.85]] as const) {
        probe.set(org.x + side.x * ox, org.y + oy, org.z + side.z * ox);
        const h2 = world.raycast(probe, dir, 6);
        if (!h2.hit || Math.abs(h2.distance - hit.distance) > 0.3) { broad = false; break; }
      }
      if (!broad) continue;
      // The run-up must start in open air, or the shot measures the launch, not the wall.
      const lx = px + hit.normal.x * (LAUNCH_BACK + MOVE.radius);
      const lz = pz + hit.normal.z * (LAUNCH_BACK + MOVE.radius);
      if (capsuleOverlapDepth(world, _launch.set(lx, s.y + 0.05, lz),
        MOVE.standHeight, MOVE.radius) > 0.02) continue;

      seen.add(key);
      found.push({ x: px, y: py, z: pz, nx, nz, groundY: s.y,
        thick: faceThickness(px, py, pz, dir.x, dir.z) });
    }
  }
  // Spread the shots over the whole arena instead of taking the first 500 in scan order.
  if (found.length <= SPEED_FACES) return found;
  const out: WallFace[] = [];
  for (let i = 0; i < SPEED_FACES; i++) {
    out.push(found[Math.floor((i * (found.length - 1)) / (SPEED_FACES - 1))] as WallFace);
  }
  return out;
}

interface Probe {
  name: string;
  height: number;
  speed: number;
  up: number;
  grounded: boolean;
  canStepUp: boolean;
  canSnap: boolean;
  gravityMult: number;
  /** Feet height above the ground at launch. */
  lift: number;
}

const PROBES: readonly Probe[] = [
  { name: 'sprint', height: MOVE.standHeight, speed: MOVE.speedHardCap, up: 0,
    grounded: true, canStepUp: true, canSnap: true, gravityMult: 0, lift: 0.05 },
  { name: 'slide', height: MOVE.slideHeight, speed: MOVE.speedHardCap, up: 0,
    grounded: true, canStepUp: false, canSnap: true, gravityMult: 0, lift: 0.05 },
  { name: 'dive', height: MOVE.diveHeight, speed: MOVE.speedHardCap, up: MOVE.diveUp,
    grounded: false, canStepUp: false, canSnap: false, gravityMult: MOVE.diveGravityMult,
    lift: 0.35 },
];

/** One reusable body and one reusable param block — the whole section allocates nothing. */
const shot = {
  position: new Vector3(),
  velocity: new Vector3(),
  groundNormal: new Vector3(0, 1, 0),
  height: MOVE.standHeight,
  radius: MOVE.radius,
  grounded: false,
  stepSmear: 0,
};
const shotParams = makeMotionParams();

function fireAt(f: WallFace, p: Probe): number {
  // Aim straight into the face: `hit.normal` already points back at the shooter.
  const ax = -f.nx;
  const az = -f.nz;
  const inv = 1 / Math.hypot(ax, az);
  const dx = ax * inv;
  const dz = az * inv;
  const back = LAUNCH_BACK + MOVE.radius;
  const ox = f.x - dx * back;
  const oz = f.z - dz * back;

  shot.position.set(ox, f.groundY + p.lift, oz);
  shot.velocity.set(dx * p.speed, p.up, dz * p.speed);
  shot.groundNormal.set(0, 1, 0);
  shot.height = p.height;
  shot.radius = MOVE.radius;
  shot.grounded = p.grounded;
  shot.stepSmear = 0;

  shotParams.stepHeight = MOVE.stepHeight;
  shotParams.minGroundNormalY = MOVE.minGroundNormalY;
  shotParams.groundSnapDistance = MOVE.groundSnapDistance;
  shotParams.maxSubstepDistance = MOVE.maxSubstepDistance;
  shotParams.maxSubsteps = 8;
  shotParams.iterations = MOVE.collisionIterations;
  shotParams.maxCorrection = MOVE.maxCorrection;
  shotParams.canStepUp = p.canStepUp;
  shotParams.canSnap = p.canSnap;
  shotParams.ledgeGuard = false;

  // 0.35 s. At 16 m/s that is 5.6 m of travel into a face 1.0 m away — six times the room a
  // tunnelling body needs, and short enough for the LANE test below to stay meaningful.
  //
  // THE LANE. Progress is only counted while the body is still within `FLANK_LANE` of the line
  // it was fired along. A capsule that slides along a facade and rounds the corner has made a
  // lot of forward progress and passed through nothing; without this the harness reported the
  // corner of every building as a hole.
  const steps = Math.round(0.35 / FIXED);
  let maxAlong = 0;
  for (let i = 0; i < steps; i++) {
    if (p.gravityMult > 0) {
      applyGravity(shot.velocity, shot.grounded, MOVE.gravity * p.gravityMult,
        MOVE.fallGravityMult, MOVE.maxFallSpeed, FIXED);
    }
    moveBody(world, shot, shotParams, FIXED);
    const rx = shot.position.x - ox;
    const rz = shot.position.z - oz;
    if (Math.abs(rx * -dz + rz * dx) > FLANK_LANE) break;
    const along = rx * dx + rz * dz;
    if (along > maxAlong) maxAlong = along;
  }
  // The capsule stops with its surface on the face, i.e. `LAUNCH_BACK` of travel. Anything past
  // that is how far it bit into the solid.
  return maxAlong - LAUNCH_BACK;
}

/** Clear air above the feet at (x, z), metres, up to 12 m. Mirrors `buriedDepth`, looking up. */
function buriedDropCeiling(x: number, y: number, z: number): number {
  const from = new Vector3(x, y + 12, z);
  const dir = new Vector3(0, -1, 0);
  let ceiling = 12;
  for (let i = 0; i < MAX_LEVELS; i++) {
    const hit = world.raycast(from, dir, 200);
    if (!hit.hit) break;
    const h = hit.point.y - y;
    if (h <= 0.05) break;
    ceiling = h;
    from.y = hit.point.y - 0.02;
    if (from.y < y) break;
  }
  return ceiling;
}

function speedSection(): void {
  hr(`PLAYER · NO PASS-THROUGH AT KIT-MAXIMUM SPEED (${MOVE.speedHardCap} m/s cap, ` +
    `dive +${MOVE.diveUp} m/s up)`);
  const faces = findWallFaces();
  console.log(`  wall faces probed          ${faces.length} ` +
    `(solid floor-to-head, ≥0.6 m wide; poles and half-height barriers excluded)`);
  console.log(`${pad('  probe', 12)}${padLeft('shots', 8)}${padLeft('through', 9)}` +
    `${padLeft('worst bite', 12)}  where`);

  for (const p of PROBES) {
    let through = 0;
    let worst = -Infinity;
    let worstAt = '';
    for (const f of faces) {
      const bite = fireAt(f, p);
      if (bite > worst) {
        worst = bite;
        worstAt = `(${f.x.toFixed(1)}, ${f.y.toFixed(2)}, ${f.z.toFixed(1)})`;
      }
      if (bite > BITE_TOL) {
        through++;
        // Print every site, capped at eight. A count tells you the arena is broken; a list of
        // coordinates and normals tells you which wall to open in the builder.
        if (through <= 8) {
          console.log(`      through at (${f.x.toFixed(2)}, ${f.y.toFixed(2)}, ` +
            `${f.z.toFixed(2)})  normal (${f.nx.toFixed(2)}, ${f.nz.toFixed(2)})  ` +
            `solid ${f.thick.toFixed(2)} m thick  bite ${bite.toFixed(2)} m` +
            `${bite > f.thick ? '  ← OUT THE FAR SIDE' : ''}`);
        }
      }
    }
    console.log(`${pad(`  ${p.name}`, 12)}${padLeft(faces.length, 8)}${padLeft(through, 9)}` +
      `${padLeft(`${worst.toFixed(3)} m`, 12)}  ${worstAt}`);
    if (through > 0) {
      fail(`${through} of ${faces.length} wall faces let a ${p.name} through at ` +
        `${p.speed.toFixed(1)} m/s, worst bite ${worst.toFixed(2)} m at ${worstAt}`);
    }
  }

  // ── the vertical case: terminal-velocity fall onto every reachable floor ───────────────────
  // `MOVE.maxFallSpeed` is 45 m/s = 0.375 m per fixed step, which is close enough to the 0.42 m
  // capsule radius that a floor thinner than the substep is the classic way to leave the world.
  const a = requireAtlas();
  const stride = Math.max(1, Math.floor(a.order.length / 1500));
  let dropped = 0;
  let skipped = 0;
  let fell = 0;
  let worstSink = 0;
  let worstAt = '';
  for (let n = 0; n < a.order.length; n += stride) {
    const s = spotOf(a.order[n] as number);
    // Drop from as high as the spot is OPEN, never from inside whatever is over it. Starting a
    // 45 m/s drop 6 m up under a 6.8 m deck launches the body inside the deck and measures the
    // solver's escape, not the floor. The velocity is set directly, so a 1 m drop still arrives
    // at terminal velocity — the height only has to be clear.
    const ceiling = buriedDropCeiling(s.x, s.y, s.z);
    const lift = Math.min(6, ceiling - MOVE.standHeight - 0.05);
    if (lift < 1) { skipped++; continue; }
    shot.position.set(s.x, s.y + lift, s.z);
    shot.velocity.set(0, -MOVE.maxFallSpeed, 0);
    shot.groundNormal.set(0, 1, 0);
    shot.height = MOVE.standHeight;
    shot.radius = MOVE.radius;
    shot.grounded = false;
    shot.stepSmear = 0;
    shotParams.canStepUp = false;
    shotParams.canSnap = true;
    shotParams.iterations = MOVE.collisionIterations;
    shotParams.maxCorrection = MOVE.maxCorrection;
    const steps = Math.round(0.5 / FIXED);
    for (let i = 0; i < steps; i++) moveBody(world, shot, shotParams, FIXED);
    dropped++;
    // Measured against the floor UNDER WHERE IT LANDED, not where it was dropped. A capsule
    // that hits a 40° stair ramp at 45 m/s slides several metres down it and loses height
    // honestly; only a capsule that ends up below the collision ground has gone through it.
    const gy = groundBelow(shot.position.x, shot.position.z, s.y + lift);
    const sink = gy === null ? s.y - shot.position.y : gy - shot.position.y;
    if (sink > worstSink) {
      worstSink = sink;
      worstAt = `(${shot.position.x.toFixed(1)}, ${shot.position.y.toFixed(2)}, ` +
        `${shot.position.z.toFixed(1)})`;
    }
    if (sink > MOVE.stepHeight) fell++;
  }
  console.log(`${pad('  fall', 12)}${padLeft(dropped, 8)}${padLeft(fell, 9)}` +
    `${padLeft(`${worstSink.toFixed(3)} m`, 12)}  ${worstAt}   ` +
    `← ${MOVE.maxFallSpeed} m/s straight down onto reachable floors ` +
    `(${skipped} skipped for no clear drop)`);
  if (fell > 0) {
    fail(`${fell} of ${dropped} reachable floors let a ${MOVE.maxFallSpeed} m/s fall through, ` +
      `worst ${worstSink.toFixed(2)} m at ${worstAt}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. STAIRS ARE STAIRS
//
// `tools/stairs.mjs` proves a body can WALK each flight. That is the outcome; this is the
// mechanism. Sample the COLLISION ground along three lanes of every flight at 10 cm and assert
// the profile is what a staircase is:
//
//   • NO GAP — there is collision ground under every point of the run. A hole in a flight is a
//     body dropped into the block below it, and it is invisible in a walk test because the
//     mover's ground snap papers over anything narrower than `groundSnapDistance`.
//   • NO LIP taller than `MOVE.stepHeight` (0.45). A taller riser is not climbable by walking;
//     it needs a jump or a mantle, which makes the route a lie.
//   • MONOTONIC — the profile never falls while the flight rises. A dip is a tread that the
//     ramp proxy misses, i.e. somewhere to catch a foot.
//
// The lanes are the flight centre and ±0.35 m, because a ramp proxy narrower than the drawn
// steps reads as solid down the middle and empty at the edges, which is exactly the "map is not
// pixel perfect" complaint.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const LANE_OFFSETS = [0, 0.3, -0.3] as const;
const PROFILE_STEP = 0.1;
/**
 * How far a sample may sit from the straight line between foot and head before it is judged to
 * be OFF the flight rather than a fault in it. 1.2 m clears the two flights that are not ramps
 * — `plaza_dais` is three discrete treads on a plinth and deviates 0.9 m from linear at its
 * midpoint — while still catching a lane that has fallen off the side onto the storey below.
 */
const EXPECT_TOL = 1.2;

/**
 * First walkable collision surface at or below `ceiling`. Plain `groundAt` returns whatever the
 * ray meets first, which on the west fire escape is the 13.6 m catwalk hanging over flight 1.
 */
function groundBelow(x: number, z: number, ceiling: number): number | null {
  const from = new Vector3(x, ceiling, z);
  const dir = new Vector3(0, -1, 0);
  for (let i = 0; i < MAX_LEVELS; i++) {
    const hit = world.raycast(from, dir, 200);
    if (!hit.hit) return null;
    if (hit.normal.y >= MOVE.minGroundNormalY) return hit.point.y;
    from.y = hit.point.y - 0.02;
    if (from.y < -2) return null;
  }
  return null;
}

function stairSection(): void {
  hr(`ARENA · EVERY FLIGHT'S COLLISION PROFILE IS A RAMP ` +
    `(3 lanes × ${PROFILE_STEP.toFixed(2)} m, lip limit ${MOVE.stepHeight.toFixed(2)} m)`);
  console.log(`${pad('  route', 18)}${padLeft('rise', 7)}${padLeft('run', 7)}` +
    `${padLeft('samples', 9)}${padLeft('gaps', 6)}${padLeft('max lip', 10)}` +
    `${padLeft('worst dip', 11)}  verdict`);

  for (const s of STAIRS) {
    const [bx, by, bz] = s.bottom;
    const [tx, ty, tz] = s.top;
    const dx = tx - bx;
    const dz = tz - bz;
    const run = Math.hypot(dx, dz);
    const ux = dx / run;
    const uz = dz / run;
    const sx = -uz;
    const sz = ux;
    // The ray starts 2 m over the head of the flight; `groundBelow` walks down past anything
    // overhanging, so a catwalk above a flight cannot be mistaken for its tread.
    const ceiling = Math.max(by, ty) + 2.0;

    let samples = 0;
    let gaps = 0;
    let maxLip = 0;
    let lipAt = 0;
    let worstDip = 0;
    let dipAt = 0;
    const ds: number[] = [];
    const gs: (number | null)[] = [];
    for (const off of LANE_OFFSETS) {
      ds.length = 0;
      gs.length = 0;
      for (let d = 0; d <= run + 1e-6; d += PROFILE_STEP) {
        const x = bx + ux * d + sx * off;
        const z = bz + uz * d + sz * off;
        const g = groundBelow(x, z, ceiling);
        const expect = by + ((ty - by) * d) / run;
        ds.push(d);
        gs.push(g === null || Math.abs(g - expect) > EXPECT_TOL ? null : g);
      }
      // TRIM, DO NOT COUNT, THE ENDS. The last sample of an offset lane sits on the lip of the
      // landing and routinely steps off its side — on BUILD 008 that alone reported a 6.85 m
      // "dip" on `plaza_stair` and 1.28 m on both dock flights. A lane that leaves the flight at
      // its very end has not found a hole in it. A lane that leaves it in the MIDDLE has.
      let lo = 0;
      let hi = gs.length - 1;
      while (lo <= hi && gs[lo] === null) lo++;
      while (hi >= lo && gs[hi] === null) hi--;
      let prev: number | null = null;
      for (let i = lo; i <= hi; i++) {
        samples++;
        const g = gs[i];
        if (g === null) { gaps++; prev = null; continue; }
        if (prev !== null) {
          const step = g - prev;
          if (step > maxLip) { maxLip = step; lipAt = ds[i] as number; }
          if (-step > worstDip) { worstDip = -step; dipAt = ds[i] as number; }
        }
        prev = g;
      }
    }

    // 2 cm of dip is the raycast landing on either side of a tread nose, not a hole.
    const dipBad = worstDip > 0.02;
    const lipBad = maxLip > MOVE.stepHeight + 1e-3;
    const bad = gaps > 0 || dipBad || lipBad;
    console.log(`${pad(`  ${s.id}`, 18)}${padLeft((ty - by).toFixed(2), 7)}` +
      `${padLeft(run.toFixed(1), 7)}${padLeft(samples, 9)}${padLeft(gaps, 6)}` +
      `${padLeft(`${maxLip.toFixed(2)}@${lipAt.toFixed(1)}`, 10)}` +
      `${padLeft(`${worstDip.toFixed(2)}@${dipAt.toFixed(1)}`, 11)}  ` +
      `${bad ? '*** BROKEN ***' : 'RAMP'}`);
    if (gaps > 0) {
      fail(`${s.id}: ${gaps} of ${samples} profile samples have no collision ground on the ` +
        `flight — a hole partway up, not an overrun at the end`);
    }
    if (lipBad) {
      fail(`${s.id}: a ${maxLip.toFixed(2)} m lip at ${lipAt.toFixed(1)} m along the flight ` +
        `exceeds MOVE.stepHeight ${MOVE.stepHeight.toFixed(2)}`);
    }
    if (dipBad) {
      fail(`${s.id}: the profile drops ${worstDip.toFixed(2)} m at ${dipAt.toFixed(1)} m along ` +
        `a rising flight`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. EVERY DRAWN WALKABLE SURFACE HAS A COLLIDER
//
// ── WHY THIS IS NOT THE FULL "EVERY VISUAL MASS HAS A COLLIDER" CHECK ────────────────────────
// `docs/MAP_INTEGRITY.md` §4 asks for that, and it cannot be written honestly against what
// `world/arena.ts` exposes. Measured on the BUILD 008 arena: the visual output is 248 342
// triangles merged down to 33 meshes, one per material bucket per spatial cell; the collision
// output is 4 464 triangles merged down to FOUR `ArenaCollider`s, one per `SurfaceKind`. No
// object survives that reduction on either side, so there is no drawn mass to pair a collider
// with. The obvious surrogate — assert every drawn triangle has collision geometry within a
// tolerance — was built and measured before being thrown away: it flags 25% of 36 000 probes,
// and the flagged set is dominated by things that are correct by design (window reveals, sills
// and cornices proud of a facade, catwalk ribs, and — the biggest single family — probes whose
// origin sits inside a volume, which both `Octree.rayIntersect` and `WorldCollision.raycast`
// backface-cull and therefore report as a 10–40 m disagreement). A check that fires constantly
// for non-bugs is worse than no check, so it is not shipped.
//
// What IS unambiguous is the subset below. `ground`, `walk` and `deck` are the buckets whose
// definition in `arena.ts` §2 is "the surface you stand on" — roadway, sidewalk and elevated
// walkway. If one of those is drawn with no collider under it you fall through the world, and
// there is no reading of that which is intentional. The check asserts the named meshes exist
// first, so renaming a bucket makes it shout rather than silently test nothing.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const WALKABLE_MESHES = ['arena_ground', 'arena_walk', 'arena_deck'] as const;
/** Sample density on a drawn floor: one probe per this many m², capped per triangle. */
const FLOOR_SAMPLE_AREA = 1.5;
const FLOOR_SAMPLE_CAP = 96;
/**
 * Beyond this the collider is not offset from the drawing, it is ABSENT: half a metre is more
 * than `MOVE.stepHeight`, so a body that arrives expecting the drawn surface does not step down
 * onto the collider, it falls. Everything under it is reported as a number and not gated —
 * measured on BUILD 008, 4 500 of 4 802 `walk` samples sit 0.10 m proud of their collider,
 * which is the sidewalk slab being drawn above the flat road proxy. That is failure mode (2) in
 * `docs/MAP_INTEGRITY.md` §2 — "the map is not pixel perfect" — and it is a real thing to fix,
 * but it is not a hole and gating on it would drown the hole.
 */
const FLOOR_MISSING = 0.5;
/** Below this the drawing and the collider agree for reporting purposes. */
const FLOOR_TOL = 0.06;

interface FloorRow {
  probes: number;
  missing: number;
  offset: number;
  worst: number;
  at: string;
  /** Every |Δ| seen, for the median — the honest headline for a systematic offset. */
  errs: number[];
}

function floorSection(): void {
  hr('ARENA · EVERY DRAWN WALKABLE SURFACE HAS A COLLIDER UNDER IT');
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  const nrm = new Vector3();
  const pt = new Vector3();

  const perMesh = new Map<string, FloorRow>();
  const meshNames: string[] = [];

  arena.group.traverse((o) => {
    const mesh = o as unknown as { name?: string; isMesh?: boolean; geometry?: unknown };
    if (!mesh.isMesh || typeof mesh.name !== 'string') return;
    const family = WALKABLE_MESHES.find((w) => (mesh.name as string).startsWith(w));
    if (!family) return;
    meshNames.push(mesh.name);
    const geo = mesh.geometry as {
      index: { getX(i: number): number; count: number } | null;
      getAttribute(n: string): { count: number };
    };
    const pos = geo.getAttribute('position');
    const idx = geo.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    let row = perMesh.get(family);
    if (!row) { row = { probes: 0, missing: 0, offset: 0, worst: 0, at: '', errs: [] }; }
    perMesh.set(family, row);

    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos as never, i0);
      b.fromBufferAttribute(pos as never, i1);
      c.fromBufferAttribute(pos as never, i2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      nrm.crossVectors(ab, ac);
      const area = nrm.length() * 0.5;
      if (area < 1e-6) continue;
      nrm.divideScalar(area * 2);
      if (Math.abs(nrm.y) < MOVE.minGroundNormalY) continue;   // a riser, not a tread

      const n = Math.min(FLOOR_SAMPLE_CAP, Math.max(1, Math.ceil(area / FLOOR_SAMPLE_AREA)));
      for (let k = 0; k < n; k++) {
        // Deterministic low-discrepancy barycentric coords — no RNG anywhere in this harness.
        // The 0.12 inset keeps every probe off the triangle's own edge: a drawn deck and its
        // box proxy share a boundary, and a probe exactly on it is a coin flip between the deck
        // and the street 6.8 m below.
        let u = ((k + 1) * 0.6180339887) % 1;
        let v = ((k + 1) * 0.3819660113) % 1;
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        u = 0.12 + u * 0.76;
        v = 0.12 + v * 0.76;
        if (u + v > 0.88) { const t2 = u; u = 0.88 - v; v = 0.88 - t2; }
        pt.copy(a).addScaledVector(ab, u).addScaledVector(ac, v);
        // Outside the playable square the drawn ground plane runs on to ±90 m as a backdrop and
        // is correctly uncollided; the city is ±70.
        if (Math.abs(pt.x) > REACH_HALF || Math.abs(pt.z) > REACH_HALF) continue;
        row.probes++;
        const g = groundBelow(pt.x, pt.z, pt.y + 0.5);
        const err = g === null ? Infinity : Math.abs(g - pt.y);
        row.errs.push(err);
        if (err > FLOOR_MISSING) {
          row.missing++;
          if (err > row.worst) {
            row.worst = err;
            row.at = `(${pt.x.toFixed(1)}, ${pt.y.toFixed(2)}, ${pt.z.toFixed(1)})`;
          }
        } else if (err > FLOOR_TOL) row.offset++;
      }
    }
  });

  for (const w of WALKABLE_MESHES) {
    if (!meshNames.some((n) => n.startsWith(w))) {
      fail(`no mesh named '${w}*' in the arena group — the bucket was renamed and this check ` +
        `is now testing nothing. Fix WALKABLE_MESHES in tools/map.ts.`);
    }
  }

  console.log(`${pad('  bucket', 16)}${padLeft('meshes', 7)}${padLeft('probes', 8)}` +
    `${padLeft('no collider', 12)}${padLeft('median Δ', 10)}${padLeft('offset >6cm', 12)}` +
    `${padLeft('worst', 9)}  where`);
  for (const w of WALKABLE_MESHES) {
    const row = perMesh.get(w);
    const count = meshNames.filter((n) => n.startsWith(w)).length;
    if (!row || row.probes === 0) {
      console.log(`${pad(`  ${w}`, 16)}${padLeft(count, 7)}${padLeft(0, 8)}` +
        `${padLeft('—', 12)}${padLeft('—', 10)}${padLeft('—', 12)}${padLeft('—', 9)}` +
        `  (nothing inside ±${REACH_HALF} m)`);
      continue;
    }
    const sorted = row.errs.slice().sort((p, q) => p - q);
    const median = sorted[sorted.length >> 1] as number;
    console.log(`${pad(`  ${w}`, 16)}${padLeft(count, 7)}${padLeft(row.probes, 8)}` +
      `${padLeft(row.missing, 12)}${padLeft(`${median.toFixed(3)} m`, 10)}` +
      `${padLeft(row.offset, 12)}` +
      `${padLeft(row.worst === 0 ? '—' : `${row.worst.toFixed(2)} m`, 9)}  ${row.at}`);
    // NOT A GATE, BUT THE PLAYTESTER'S OTHER SENTENCE. "the map should be perfectly pixel
    // perfect": a median offset means the surface you SEE and the surface you STAND ON are not
    // the same plane, everywhere, systematically. It is reported at 5 cm because that is about
    // where it starts being visible at the 1.68 m eye height.
    if (median > 0.05) {
      console.log(`      ↳ the drawn '${w}' surface sits a median ${median.toFixed(2)} m above ` +
        `its collider — you stand that far INSIDE the drawing. Not gated (it is an offset, not ` +
        `a hole) but it is "not pixel perfect", measured.`);
    }
    if (row.missing > 0) {
      fail(`${row.missing} of ${row.probes} drawn '${w}' surface samples have NO collider ` +
        `within ${FLOOR_MISSING.toFixed(2)} m — you fall through the drawing. Worst ` +
        `${row.worst === Infinity ? 'nothing below at all' : `${row.worst.toFixed(2)} m`} ` +
        `at ${row.at}`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════

console.log(`collision triangles ${world.triangleCount} · drawn triangles ${arena.triangles} · ` +
  `player capsule r=${MOVE.radius} h=${MOVE.standHeight} · stepHeight ${MOVE.stepHeight}`);

if (want('reach')) reachSection();
if (want('inside')) insideSection();
if (want('speed')) speedSection();
if (want('stairs')) stairSection();
if (want('floors')) floorSection();

console.log(`\n${failures === 0 ? 'MAP INTEGRITY: ALL CHECKS PASSED' : `MAP INTEGRITY: ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

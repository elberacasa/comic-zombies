/**
 * NAVIGATION — the walkable-surface graph, and the flow field over it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS (BUILD 004 playtest, verbatim):
 *
 *      "we could make better zombies, like they dont go up stairs or things so u can just
 *       camp top of a building or fountain"
 *
 *  The horde steers. Steering is a LOCAL operator: `world.steer()` picks the clearest of seven
 *  whiskers toward the player and `groundAt()` follows whatever ground happens to rise under a
 *  body. Between them a shambler can FOLLOW a ramp it is already standing on, but it has no
 *  representation of "there is a stair 40 m that way and it comes out where you are". So a
 *  player on the NE roof, the west catwalk, the container stack or the monument dais was
 *  unreachable, and the arena's own vertical routes — authored as a player escape — became a
 *  permanent camp. `enemies/ai.ts` used to argue that asymmetry was level design working. It
 *  was not. It was the AI missing a whole class of knowledge.
 *
 *  This module is that knowledge, and NOTHING ELSE. It does not steer, it does not move a
 *  body, it does not know what an enemy is. It answers exactly three questions:
 *
 *      nodeAt(p)        which walkable surface am I standing on?
 *      next(node)       which surface should I step to, to get closer to the goal?
 *      kindOf(node)     do I walk there, climb there, or drop there?
 *
 *  ROUTE CHOICE, NOT RAILS. `game/enemies` uses the answer as the TARGET it steers toward, so
 *  separation, the conga relief, the wall whiskers and the turn-rate cap all still shape the
 *  motion. A horde on a stair is still a clumping, grinding, trainable fluid — it is just a
 *  fluid that now knows which way is up.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE GRAPH
 * ─────────
 * A COLUMN LATTICE, not a nav-mesh. The arena is sampled on a `CELL` metre lattice; each
 * column is raycast from the sky downward, collecting *every* upward-facing surface under it
 * (three.js `Ray.intersectTriangle` is called with backface culling on inside
 * `WorldCollision.raycast`, so a downward ray can only ever return a surface you could stand
 * on — undersides are invisible to it, which is what makes this cheap and safe). A surface
 * becomes a NODE if it has `MIN_HEADROOM` of air above it. One column therefore holds the
 * plaza at y=0, the gantry at 6.8 and the catwalk at 13.6 as three separate nodes.
 *
 * EDGES are built between the eight neighbouring columns, in three kinds:
 *
 *   WALK   the two surfaces are continuous — same level, a kerb, or a real ramp/stair. Proven
 *          by sampling the ground at the MIDPOINT of the link and requiring it to sit on the
 *          straight line between the two ends (`MID_TOL`). That single test is what separates
 *          "a 40° stair" from "a 1.7 m ledge with a hole in front of it", and it is why the
 *          arena's eight authored flights become graph edges without a line of hand-authoring.
 *   CLIMB  a ledge from `STEP_UP` to `CLIMB_MAX` high with open air above it. The enemy layer
 *          answers this with a slow, telegraphed mantle. Expensive, so a route that can walk
 *          around will.
 *   DROP   the same ledge downward, up to `DROP_MAX`. Cheap — falling is free.
 *
 * THE FIELD
 * ─────────
 * Every agent chases the same target, so we do not path per agent: ONE Dijkstra sweep from the
 * player's node over the reversed graph produces `next[]` for the whole arena, and an agent's
 * query is an array read. The sweep is BUDGETED (`NAV_BUDGET` settled nodes per fixed step)
 * and DOUBLE-BUFFERED, so no step ever pays for a full sweep and no agent ever reads a
 * half-built field. It only runs at all while at least one agent is asking for it — which is
 * only while somebody is above or behind you, i.e. only while it is earning its cost.
 *
 * ZERO ALLOCATION after `buildNav()`. Every array is a typed array sized at build.
 */

import { Vector3 } from 'three';
import type { RaycastHit } from '@/core/types';

// ═════════════════════════════════════════════════════════════════════════════
// Geometry constants. These describe the WORLD, not how anything feels — the
// feel constants (when to path, how long a climb takes) live in
// `game/enemies/defs.ts` NAV, because `world/` must never import `game/`.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Lattice pitch, metres. 1.75 is chosen against the arena's narrowest walkable structures:
 * the west fire escape is 1.8 m wide and the gantry deck 2.6 m, so at this pitch every one of
 * them catches at least one column line. 2.0 m dropped the skybridge; 1.5 m cost 60% more
 * build time for routes that were already connected.
 */
const CELL = 1.75;

/**
 * Surfaces above this are not sampled. The arena's tallest *walkable* route is the west
 * catwalk at 13.6 m; everything above is a building roof with no way on or off it, and
 * sampling those would add ~1400 permanently unreachable nodes to every sweep.
 */
const MAX_Y = 16.5;

/** A surface with less than this much air above it is a crawlspace, not a floor. */
const MIN_HEADROOM = 1.95;

/** Cosine of the steepest surface that counts as standable. Matches `MOVE.minGroundNormalY`. */
const GROUND_NORMAL_Y = 0.6;

/** Rise an agent absorbs by walking. Anything under this is a kerb, not a ledge. */
const STEP_UP = 0.45;

/**
 * The tallest ledge an agent may mantle.
 *
 * WAS 2.9 ("clears the SW lot's 2.6 m shipping containers"), and it left the loading dock as a
 * hard hole in the level: `CZ.camp('dock')` puts the player on the canopy at 5.95 m, and MEASURED
 * there — 15 street spawns, 90–150 s — ZERO arrived and ZERO attacks landed, three runs, while a
 * full BFS found 127 unreachable nodes with 47 standable surfaces above 1.2 m among them. The
 * horde walked to the dock platform and stood under the player until the round ended.
 *
 * The blocking rise is the dock platform (y 1.20) to the canopy tier (y 4.57): 3.37 m. 3.05 was
 * measured too — it closes the 2.97 m gap from the 1.60 m tier and made the dock reachable on
 * SOME approaches only, so bodies that converged on the 1.20 m platform still circled there for
 * 90 s. 3.45 closes it from every approach: dock first contact 17.5 s, 8 of 15 up on the canopy,
 * 249 attacks. Nothing else in the arena regressed (see the table in PLAYTEST).
 *
 * The cost of raising it is a longer, more telegraphed mantle, not a cheaper one: `NAV.climbBase`
 * + gap × `climbPerMetre` puts a 3.45 m ledge at 2.7 s of a body hanging on a wall, which is the
 * most shootable it has ever been. `game/enemies/defs.ts` NAV.climbMax MUST match this.
 */
const CLIMB_MAX = 3.45;

/** The tallest ledge an agent may drop off. 7.0 clears the 6.8 m gantry and the NE roof. */
const DROP_MAX = 7.0;

/** Steepest WALK link, rise per metre of run. 0.95 ≈ 44°; the arena's stairs are 40°. */
const SLOPE_MAX = 0.95;

/**
 * How far a midpoint sample may sit off the straight line between two nodes and still count as
 * a ramp. Tight on purpose: a pure LEDGE of height h puts its midpoint sample h/2 off the line,
 * so this value is exactly the height at which "stair" stops and "ledge" starts (2 × 0.30 =
 * 0.6 m). The arena's authored flights are 40° ramp proxies whose midpoint error is a single
 * 0.17 m riser, so they clear it with room to spare.
 */
const MID_TOL = 0.30;

/** Height above a surface that the "is the lane clear" whisker is cast at. Chest, not shins. */
const CLEAR_Y = 0.95;

/** Below this height difference a link is flat enough to skip the midpoint continuity ray. */
const FLAT_EPS = 0.12;

/** Max upward-facing surfaces collected per column. Plaza + deck + catwalk + slack. */
const MAX_LEVELS = 5;

/** How far below `MAX_Y` a column probe starts, and how deep it looks in one cast. */
const PROBE_TOP = MAX_Y + 2;
const PROBE_DEPTH = 200;

// ── link costs, in metres-equivalent ────────────────────────────────────────
/**
 * Flat cost of committing to a mantle, plus a per-metre term. High: an agent should walk 8 m
 * around rather than climb, and a 2.6 m container costs 8 + 13 = 21 m of detour.
 *
 * TRIED AND REVERTED IN BUILD 006, so nobody spends the afternoon again. The east gantry is
 * still slow to reach (65 s, versus 8–36 s for every other vantage) and the obvious suspect was
 * this pair: make climbing cheap and the field should find a shorter way up. It does not, and
 * the reason is in the graph rather than in the prices. MEASURED with `CZ.navRoute` from four
 * street points around the gantry: every route costs 81–120 m for a crow distance of 13–22 m and
 * contains ZERO climb links, at CLIMB_MAX 3.05 and again at 3.6. There is no chain of ledges
 * onto that deck at any climbable height — the arena gives the gantry spine exactly one entrance
 * and it is a long way round. Halving these costs shaved the gantry from 79 s to 65 s and BROKE
 * THE LOADING DOCK: the field started preferring a cheap climb chain the agent's own `beginClimb`
 * refuses, and 15 of 15 bodies circled the dock platform at y 1.2 for 90 s having previously
 * arrived in 31.7 s. Cost tuning cannot fix the gantry. Geometry can: it needs an intermediate
 * tier, a second flight, or a ladder, and that is a job for `world/arena.ts`.
 */
const CLIMB_COST = 8;
const CLIMB_COST_PER_M = 5;
/** Dropping is nearly free, but not free, or the field prefers cliffs to stairs. */
const DROP_COST = 1.5;

/**
 * DIAGONAL PENALTY — the fix for corner-cutting, and it is one number rather than a rule.
 *
 * A lattice diagonal is √2 ≈ 1.414 cells long, so a straight Dijkstra always prefers one
 * diagonal to two orthogonals. At the top of a staircase that is catastrophic: the plaza flight
 * meets the gantry through a right-angled corner, and the field routed a body diagonally across
 * it — i.e. through the 40 cm of fresh air off the flight's north stringer. Traced repeatedly:
 * the body climbed 5.8 of the 6.8 m, was stopped by the ledge guard one cell short of the deck,
 * and stood there. Every flight in the arena has this corner.
 *
 * Any multiplier above √2 makes a diagonal cost more than the two orthogonals that box it in,
 * so **wherever the L-shaped route exists the field takes the L**, and wherever the diagonal is
 * the only connection (the NE roof flight reaches its landing deck through a 0.7 m pinch that
 * is genuinely diagonal) it is still there and still used. No topology is lost and no corner is
 * cut — which is what a hand-written no-corner-cutting rule would have done at much greater
 * cost and with the risk of severing that pinch outright.
 */
const DIAG_COST = 1.45;

/** Settled nodes per `update()` call. The whole sweep is ~9 k nodes → ~56 fixed steps ≈ 0.47 s. */
const NAV_BUDGET = 160;

export const NAV_WALK = 0;
export const NAV_CLIMB = 1;
export const NAV_DROP = 2;

// ═════════════════════════════════════════════════════════════════════════════
// The world this needs. Structurally satisfied by `WorldService` — declared here
// so `nav.ts` depends on a two-method shape rather than on the whole contract.
// ═════════════════════════════════════════════════════════════════════════════

export interface NavProbe {
  raycast(origin: Vector3, dir: Vector3, maxDistance: number): RaycastHit;
}

export interface NavBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface NavStats {
  nodes: number;
  edges: number;
  climbs: number;
  drops: number;
  columns: number;
  rays: number;
  buildMs: number;
}

// ── module scratch. Nothing after `buildNav` allocates. ─────────────────────
const _o = new Vector3();
const _d = new Vector3();
const _down = new Vector3(0, -1, 0);

/** Neighbour column offsets. Only the four "forward" ones — each pair is visited once. */
const NB_X = [1, 0, 1, 1];
const NB_Z = [0, 1, 1, -1];

// ═════════════════════════════════════════════════════════════════════════════
// The graph
// ═════════════════════════════════════════════════════════════════════════════

export class NavGraph {
  readonly cell = CELL;
  readonly nodeCount: number;
  readonly stats: NavStats;

  /** Column origin and dimensions. */
  private readonly x0: number;
  private readonly z0: number;
  private readonly nx: number;
  private readonly nz: number;

  /** Node fields. `nodeCol` indexes back into the column lattice. */
  private readonly nodeY: Float32Array;
  private readonly nodeCol: Int32Array;
  private readonly nodeHead: Float32Array;
  /** `colStart[c] … colStart[c+1]` is column `c`'s node range, ascending in y. */
  private readonly colStart: Int32Array;

  /** CSR adjacency. `edgeTwin` is the index of the b→a edge, which is how the sweep reverses. */
  private readonly edgeStart: Int32Array;
  private readonly edgeTo: Int32Array;
  private readonly edgeCost: Float32Array;
  private readonly edgeKind: Uint8Array;
  private readonly edgeTwin: Int32Array;

  // ── the flow field, double-buffered ──────────────────────────────────────
  private distA: Float32Array;
  private nextA: Int32Array;
  private kindA: Uint8Array;
  private distB: Float32Array;
  private nextB: Int32Array;
  private kindB: Uint8Array;

  /** Binary heap of node indices, lazily deleted (a node may appear more than once). */
  private readonly heap: Int32Array;
  private readonly heapKey: Float32Array;
  private heapSize = 0;

  /**
   * `probeRoute`'s PRIVATE scratch. Allocated on the first console probe and never touched by
   * the sim, which is the whole point — see the comment on `probeRoute`.
   */
  private probeDist: Float32Array | null = null;
  private probeNext: Int32Array | null = null;
  private probeKind: Uint8Array | null = null;
  private probeHeap: Int32Array | null = null;
  private probeHeapKey: Float32Array | null = null;

  private sweeping = false;
  /** True once a sweep has completed at least once — the front buffer is meaningful. */
  private live = false;
  private goalNode = -1;
  private liveGoal = -1;
  private sinceSweep = 0;
  /** Sweeps completed. Watchable, and the enemy layer uses it to invalidate cached hops. */
  version = 0;

  constructor(
    x0: number, z0: number, nx: number, nz: number,
    nodeY: Float32Array, nodeCol: Int32Array, nodeHead: Float32Array, colStart: Int32Array,
    edgeStart: Int32Array, edgeTo: Int32Array, edgeCost: Float32Array,
    edgeKind: Uint8Array, edgeTwin: Int32Array, stats: NavStats,
  ) {
    this.x0 = x0;
    this.z0 = z0;
    this.nx = nx;
    this.nz = nz;
    this.nodeY = nodeY;
    this.nodeCol = nodeCol;
    this.nodeHead = nodeHead;
    this.colStart = colStart;
    this.edgeStart = edgeStart;
    this.edgeTo = edgeTo;
    this.edgeCost = edgeCost;
    this.edgeKind = edgeKind;
    this.edgeTwin = edgeTwin;
    this.stats = stats;
    this.nodeCount = nodeY.length;

    const n = this.nodeCount;
    this.distA = new Float32Array(n);
    this.nextA = new Int32Array(n);
    this.kindA = new Uint8Array(n);
    this.distB = new Float32Array(n);
    this.nextB = new Int32Array(n);
    this.kindB = new Uint8Array(n);
    this.distA.fill(Infinity);
    this.distB.fill(Infinity);
    this.nextA.fill(-1);
    this.nextB.fill(-1);
    // Lazy deletion means a node can be pushed once per incoming edge. Sized to the edge list
    // plus one, which is the true worst case, so `push` can never need to grow.
    const cap = edgeTo.length + 8;
    this.heap = new Int32Array(cap);
    this.heapKey = new Float32Array(cap);
  }

  // ── queries ───────────────────────────────────────────────────────────────

  /** Column index for a world XZ, or -1 outside the lattice. */
  private colAt(x: number, z: number): number {
    const gx = Math.floor((x - this.x0) / CELL);
    const gz = Math.floor((z - this.z0) / CELL);
    if (gx < 0 || gz < 0 || gx >= this.nx || gz >= this.nz) return -1;
    return gx * this.nz + gz;
  }

  /**
   * The node a body at `(x, y, z)` is standing on: the highest surface in its column that is
   * not more than `up` above its feet, preferring the closest below. Pure arithmetic — no rays,
   * which is why every agent can afford to call it every fixed step.
   */
  nodeAt(x: number, y: number, z: number, up = 1.4): number {
    const own = this.bestInColumn(this.colAt(x, z), y, up);
    if (own >= 0) return own;

    /**
     * THE HOLE FALLBACK, and it is not an optimisation — it is a correctness fix that the
     * acceptance test found. A column is legitimately EMPTY wherever the ground has less than
     * `MIN_HEADROOM` above it, which in a city arena means the whole strip of pavement that
     * runs UNDER an external staircase. A body that wanders into that strip used to lose the
     * field entirely and fall back to steering — i.e. it stood at the foot of the very stair it
     * needed, pressing into the underside, forever. Measured: 0 of 15 reached the NE roof.
     *
     * So a miss searches the eight neighbouring columns. It costs nothing in the common case
     * (the body's own column almost always has a node) and it turns a hard routing hole into a
     * one-cell inaccuracy.
     */
    const gx = Math.floor((x - this.x0) / CELL);
    const gz = Math.floor((z - this.z0) / CELL);
    let best = -1;
    let bestD = Infinity;
    for (let ox = -1; ox <= 1; ox++) {
      const cx = gx + ox;
      if (cx < 0 || cx >= this.nx) continue;
      for (let oz = -1; oz <= 1; oz++) {
        const cz = gz + oz;
        if (cz < 0 || cz >= this.nz) continue;
        const n = this.bestInColumn(cx * this.nz + cz, y, up);
        if (n < 0) continue;
        const d = Math.abs(y - this.nodeY[n]);
        if (d < bestD) { bestD = d; best = n; }
      }
    }
    return best;
  }

  /** Closest node to `y` in one column, or -1. Below the feet is the normal case. */
  private bestInColumn(c: number, y: number, up: number): number {
    if (c < 0) return -1;
    const s = this.colStart[c];
    const e = this.colStart[c + 1];
    let best = -1;
    let bestD = Infinity;
    for (let i = s; i < e; i++) {
      const dy = y - this.nodeY[i];
      // A little above the feet is forgiven so a body mid-climb or mid-fall still resolves.
      const d = dy >= -up ? Math.abs(dy) : Infinity;
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD > 3.5 ? -1 : best;
  }

  /** Centre of a node's column at its own surface height. */
  point(i: number, out: Vector3): Vector3 {
    const c = this.nodeCol[i];
    const gx = (c / this.nz) | 0;
    const gz = c - gx * this.nz;
    return out.set(this.x0 + (gx + 0.5) * CELL, this.nodeY[i], this.z0 + (gz + 0.5) * CELL);
  }

  surfaceY(i: number): number { return this.nodeY[i]; }
  headroom(i: number): number { return this.nodeHead[i]; }

  /** True once a full sweep has landed. Until then agents fall back to pure steering. */
  get hasField(): boolean { return this.live; }
  get goal(): number { return this.liveGoal; }

  /** The next node on the route from `i` to the goal, or -1 if unreachable / not swept yet. */
  next(i: number): number {
    return this.live && i >= 0 && i < this.nodeCount ? this.nextA[i] : -1;
  }

  /** How the step from `i` to `next(i)` is made: `NAV_WALK` / `NAV_CLIMB` / `NAV_DROP`. */
  kindOf(i: number): number {
    return this.live && i >= 0 && i < this.nodeCount ? this.kindA[i] : NAV_WALK;
  }

  /** Graph distance from `i` to the goal, in metres-equivalent. `Infinity` if unreachable. */
  costOf(i: number): number {
    return this.live && i >= 0 && i < this.nodeCount ? this.distA[i] : Infinity;
  }

  // ── the sweep ─────────────────────────────────────────────────────────────

  /**
   * Advance the flow field. Call once per fixed step from the system that owns the agents.
   *
   * `demand` is the number of agents that actually want a route right now. At zero the whole
   * thing idles: a player on the ground with a horde on the ground never pays for pathing, and
   * the cost only appears in exactly the situation the cost exists for.
   *
   * `repathTime` is the maximum age of a finished field before it is rebuilt.
   */
  update(dt: number, goalX: number, goalY: number, goalZ: number, demand: number, repathTime: number): void {
    this.sinceSweep += dt;
    if (demand <= 0) return;

    if (!this.sweeping) {
      const g = this.nodeAt(goalX, goalY, goalZ, 2.2);
      const stale = this.sinceSweep >= repathTime || !this.live;
      if (g >= 0 && (stale || g !== this.goalNode)) this.beginSweep(g);
      if (!this.sweeping) return;
    }
    this.expand(NAV_BUDGET);
  }

  private beginSweep(goal: number): void {
    this.goalNode = goal;
    this.sinceSweep = 0;
    this.sweeping = true;
    this.distB.fill(Infinity);
    this.nextB.fill(-1);
    this.heapSize = 0;
    this.distB[goal] = 0;
    this.push(goal, 0);
  }

  /**
   * Dijkstra from the goal over the REVERSED graph. Every edge in this graph is built as a
   * twinned pair, so "the cost of coming here from v" is `edgeCost[edgeTwin[e]]` where `e` is
   * the outgoing edge to v — no second adjacency structure, no allocation.
   */
  private expand(budget: number): void {
    const { edgeStart, edgeTo, edgeCost, edgeKind, edgeTwin, distB, nextB, kindB } = this;
    let settled = 0;
    while (this.heapSize > 0 && settled < budget) {
      const key = this.heapKey[0];
      const u = this.heap[0];
      this.pop();
      if (key > distB[u]) continue;   // stale heap entry
      settled++;
      const e0 = edgeStart[u];
      const e1 = edgeStart[u + 1];
      for (let e = e0; e < e1; e++) {
        const v = edgeTo[e];
        const back = edgeTwin[e];
        // One-way (a drop too tall to climb back up). It cannot be walked in reverse, so it
        // must not seed a route. This is the check that stops the field routing up a cliff.
        if (back < 0) continue;
        const nd = key + edgeCost[back];
        if (nd < distB[v]) {
          distB[v] = nd;
          nextB[v] = u;
          kindB[v] = edgeKind[back];
          this.push(v, nd);
        }
      }
    }
    if (this.heapSize === 0) {
      // Commit: swap the buffers so agents flip from the previous complete field to this one
      // in a single step. A partially-built field is never visible.
      const d = this.distA; this.distA = this.distB; this.distB = d;
      const n = this.nextA; this.nextA = this.nextB; this.nextB = n;
      const k = this.kindA; this.kindA = this.kindB; this.kindB = k;
      this.sweeping = false;
      this.live = true;
      this.liveGoal = this.goalNode;
      this.version++;
    }
  }

  private push(node: number, key: number): void {
    let i = this.heapSize++;
    const h = this.heap;
    const hk = this.heapKey;
    h[i] = node;
    hk[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= hk[i]) break;
      const tn = h[p]; h[p] = h[i]; h[i] = tn;
      const tk = hk[p]; hk[p] = hk[i]; hk[i] = tk;
      i = p;
    }
  }

  private pop(): void {
    const h = this.heap;
    const hk = this.heapKey;
    const n = --this.heapSize;
    h[0] = h[n];
    hk[0] = hk[n];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < n && hk[l] < hk[m]) m = l;
      if (r < n && hk[r] < hk[m]) m = r;
      if (m === i) break;
      const tn = h[m]; h[m] = h[i]; h[i] = tn;
      const tk = hk[m]; hk[m] = hk[i]; hk[i] = tk;
      i = m;
    }
  }

  // ── diagnostics ───────────────────────────────────────────────────────────

  /**
   * Blocking full-graph reachability check, for the console and for the acceptance test.
   * Returns the number of graph hops from `from` to `to` and the route's cost, or -1.
   *
   * ═══ IT USED TO CORRUPT THE LIVE FIELD (BUILD 005 major) ═══
   * The old version ran `beginSweep` + `expand` on the SHARED back buffer, which meant that when
   * the heap emptied `expand` did what it always does: swapped the buffers, set `liveGoal` to
   * the PROBE's destination and bumped `version`. So the console diagnostic the playtest doc
   * hands the human — `CZ.navRoute(...)` — silently re-pointed the whole horde at wherever the
   * probe was asking about. MEASURED: one call moved `nav.goal` 4902 → 1212 and version
   * 1497 → 1498; called mid-sweep it bumped version twice and left the field and the goal
   * disagreeing. It also wiped an in-flight sweep and reset `sinceSweep`.
   *
   * So it now owns its arrays outright. They are allocated on first use and reused after that:
   * this is a console call, it happens at human speed, and the sim must not be able to feel it.
   * Nothing below writes a single field the sim reads.
   */
  probeRoute(from: Vector3, to: Vector3): { hops: number; cost: number; kinds: string } {
    const g = this.nodeAt(to.x, to.y, to.z, 2.2);
    const s = this.nodeAt(from.x, from.y, from.z, 2.2);
    if (g < 0 || s < 0) return { hops: -1, cost: Infinity, kinds: g < 0 ? 'no goal node' : 'no start node' };

    const n = this.nodeCount;
    if (!this.probeDist) {
      this.probeDist = new Float32Array(n);
      this.probeNext = new Int32Array(n);
      this.probeKind = new Uint8Array(n);
      this.probeHeap = new Int32Array(this.heap.length);
      this.probeHeapKey = new Float32Array(this.heap.length);
    }
    const dist = this.probeDist;
    const next = this.probeNext!;
    const kind = this.probeKind!;
    const heap = this.probeHeap!;
    const heapKey = this.probeHeapKey!;
    dist.fill(Infinity);
    next.fill(-1);
    dist[g] = 0;

    // A self-contained Dijkstra over the reversed graph, byte-for-byte the sim's rule set (see
    // `expand`) but writing only into the arrays above.
    let size = 0;
    const push = (node: number, key: number): void => {
      let i = size++;
      heap[i] = node;
      heapKey[i] = key;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapKey[p] <= heapKey[i]) break;
        const tn = heap[p]; heap[p] = heap[i]; heap[i] = tn;
        const tk = heapKey[p]; heapKey[p] = heapKey[i]; heapKey[i] = tk;
        i = p;
      }
    };
    push(g, 0);
    while (size > 0) {
      const key = heapKey[0];
      const u = heap[0];
      const last = --size;
      heap[0] = heap[last];
      heapKey[0] = heapKey[last];
      for (let i = 0; ;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < size && heapKey[l] < heapKey[m]) m = l;
        if (r < size && heapKey[r] < heapKey[m]) m = r;
        if (m === i) break;
        const tn = heap[m]; heap[m] = heap[i]; heap[i] = tn;
        const tk = heapKey[m]; heapKey[m] = heapKey[i]; heapKey[i] = tk;
        i = m;
      }
      if (key > dist[u]) continue;
      const e0 = this.edgeStart[u];
      const e1 = this.edgeStart[u + 1];
      for (let e = e0; e < e1; e++) {
        const v = this.edgeTo[e];
        const back = this.edgeTwin[e];
        if (back < 0) continue;
        const nd = key + this.edgeCost[back];
        if (nd < dist[v]) {
          dist[v] = nd;
          next[v] = u;
          kind[v] = this.edgeKind[back];
          push(v, nd);
        }
      }
    }

    if (!isFinite(dist[s])) return { hops: -1, cost: Infinity, kinds: 'unreachable' };
    let hops = 0;
    let climbs = 0;
    let drops = 0;
    let node = s;
    while (node !== g && hops < 4000) {
      const k = kind[node];
      if (k === NAV_CLIMB) climbs++;
      else if (k === NAV_DROP) drops++;
      node = next[node];
      if (node < 0) return { hops: -1, cost: Infinity, kinds: 'broken chain' };
      hops++;
    }
    return { hops, cost: dist[s], kinds: `${climbs} climb / ${drops} drop` };
  }

  /**
   * Can the horde get from `from` to anywhere at all? Same isolated sweep as `probeRoute`,
   * reduced to the one bit `main.ts::camp` needs: is this vantage point on the graph AND
   * connected to the street? A camp spot that fails this is not a camping test, it is a hole.
   */
  reachableFrom(from: Vector3, to: Vector3): boolean {
    return this.probeRoute(from, to).hops >= 0;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The build. Runs once, at `init`, off the collision octree.
// ═════════════════════════════════════════════════════════════════════════════

export function buildNav(world: NavProbe, bounds: NavBounds): NavGraph {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let rays = 0;

  /**
   * SNAP THE LATTICE TO THE ARENA'S OWN ORIGIN, not to its bounds. The arena is authored around
   * (0, 0) — every stair, deck and catwalk in it is placed symmetrically about the origin — and
   * `bounds.min` is −69.4, an arbitrary 0.6 m inset off the perimeter wall. Sampling from there
   * put the lattice 0.6 m out of phase with the level: the NE roof stair (2.2 m wide, centred on
   * x = 58.5) got its only column line at x = 57.475, seven centimetres inside its west edge.
   * The horde routed up the extreme lip of the flight and fell off it — measured, on the trace:
   * a body reached 1.7 m up the stair and then dropped back to the pavement, forever.
   *
   * Aligning `x0` to a multiple of `CELL` puts that same line at 58.625 — 12 cm off the stair's
   * centre. Nothing else in this file changed and the flight became walkable.
   */
  const x0 = Math.floor(bounds.min.x / CELL) * CELL;
  const z0 = Math.floor(bounds.min.z / CELL) * CELL;
  const nx = Math.max(1, Math.ceil((bounds.max.x - x0) / CELL));
  const nz = Math.max(1, Math.ceil((bounds.max.z - z0) / CELL));
  const cols = nx * nz;

  // ── 1. sample every column ───────────────────────────────────────────────
  const colStart = new Int32Array(cols + 1);
  const yList: number[] = [];
  const headList: number[] = [];
  const colList: number[] = [];

  for (let gx = 0; gx < nx; gx++) {
    const x = x0 + (gx + 0.5) * CELL;
    for (let gz = 0; gz < nz; gz++) {
      const c = gx * nz + gz;
      colStart[c] = yList.length;
      const z = z0 + (gz + 0.5) * CELL;

      let top = PROBE_TOP;
      let above = Infinity;
      for (let lvl = 0; lvl < MAX_LEVELS; lvl++) {
        _o.set(x, top, z);
        const hit = world.raycast(_o, _down, PROBE_DEPTH);
        rays++;
        if (!hit.hit) break;
        const y = hit.point.y;
        if (y < bounds.min.y) break;
        const head = above - y;
        if (hit.normal.y >= GROUND_NORMAL_Y && y <= MAX_Y && head >= MIN_HEADROOM) {
          yList.push(y);
          headList.push(head);
          colList.push(c);
        }
        above = y;
        top = y - 0.05;
        if (top < bounds.min.y) break;
      }
      // Ascending in y is what `nodeAt` and the edge builder assume; the probe walks downward,
      // so reverse this column's slice in place.
      const s = colStart[c];
      for (let a = s, b = yList.length - 1; a < b; a++, b--) {
        const ty = yList[a]; yList[a] = yList[b]; yList[b] = ty;
        const th = headList[a]; headList[a] = headList[b]; headList[b] = th;
      }
    }
  }
  colStart[cols] = yList.length;

  const count = yList.length;
  const nodeY = Float32Array.from(yList);
  const nodeHead = Float32Array.from(headList);
  const nodeCol = Int32Array.from(colList);

  // ── 2. helpers over the sampled lattice ──────────────────────────────────

  /**
   * Is there standable ground at `(x, z)` within `MID_TOL` of height `y`?
   *
   * A REAL RAYCAST, deliberately, and this is the one place where that is not negotiable. The
   * first pass answered this out of the sampled lattice, which is worthless for the question
   * being asked: the midpoint of two ADJACENT columns lands exactly on their shared boundary,
   * so a lattice lookup floors straight back onto one of the two endpoints and every ramp in
   * the arena reports a half-rise error. Measured consequence — the plaza stair up to the
   * gantry came out as five CLIMB links instead of six WALK links, and the west fire escape as
   * ten. The horde still got there; it got there by mantling a staircase.
   *
   * The ray is `2 × MID_TOL` long, so it is a handful of triangles and it fires only for links
   * that are not already flat (`FLAT_EPS`), which is under 15% of them.
   */
  const groundNear = (x: number, z: number, y: number): boolean => {
    _o.set(x, y + MID_TOL + 0.05, z);
    rays++;
    const hit = world.raycast(_o, _down, MID_TOL * 2 + 0.1);
    return hit.hit && hit.normal.y >= GROUND_NORMAL_Y;
  };

  /**
   * Is the lane between two surfaces open to a BODY, not to a laser?
   *
   * THREE rays, and the full length, and both of those are scars.
   *
   *   • A single centreline ray is a zero-width probe and the agents are 0.74 m wide. The SW
   *     lot's chain-link perimeter is one continuous 2.1 m collider, and the horde routed
   *     straight through it — a node happened to land 12 cm inside the fence line, so the
   *     "route" was to stand in the road pressing north forever.
   *   • That same test also shortened the ray by 5 cm to avoid grazing the destination floor,
   *     which is unnecessary (the probe runs at CHEST height, in mid-air at both ends) and was
   *     the actual arithmetic that let the fence through: it stood 1.725 m away on a 1.75 m
   *     link, so the probe stopped two and a half centimetres short of it.
   *
   * The ±`SIDE` offsets are half a body's width apart, which is wide enough to see a fence post
   * or a railing and narrow enough to fit every authored opening in the arena (the narrowest is
   * a 1.8 m fire escape).
   */
  const SIDE = 0.30;
  const clear = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean => {
    _d.set(bx - ax, by - ay, bz - az);
    const len = _d.length();
    if (len < 1e-4) return true;
    _d.divideScalar(len);
    // Lateral offset, perpendicular to the lane in the XZ plane.
    const l = Math.hypot(_d.x, _d.z) || 1;
    const px = (-_d.z / l) * SIDE;
    const pz = (_d.x / l) * SIDE;
    for (let s = -1; s <= 1; s++) {
      _o.set(ax + px * s, ay, az + pz * s);
      rays++;
      if (world.raycast(_o, _d, len).hit) return false;
    }
    return true;
  };

  /**
   * Is the ground between two nodes CONTINUOUS — i.e. is this a ramp/stair rather than a ledge
   * with a hole in front of it? Sampled at the midpoint, with a lateral fallback so a 1.8 m
   * wide fire escape whose midpoint lands a hand's width off the stringer is not severed.
   */
  const continuous = (
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  ): boolean => {
    const mx = (ax + bx) * 0.5;
    const mz = (az + bz) * 0.5;
    const my = (ay + by) * 0.5;
    if (groundNear(mx, mz, my)) return true;
    // Perpendicular offsets, a third of a cell each way — a 1.8 m wide fire escape whose
    // centreline sample lands on a stringer must not be severed.
    const dx = bx - ax;
    const dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    const px = (-dz / l) * CELL * 0.34;
    const pz = (dx / l) * CELL * 0.34;
    return groundNear(mx + px, mz + pz, my) || groundNear(mx - px, mz - pz, my);
  };

  // ── 3. edges ─────────────────────────────────────────────────────────────
  // Built into plain arrays (build time — allocation is free here), then flattened to CSR.

  const eA: number[] = [];
  const eB: number[] = [];
  const eCost: number[] = [];
  const eKind: number[] = [];
  let climbs = 0;
  let drops = 0;

  const link = (a: number, b: number, cost: number, kind: number): void => {
    eA.push(a); eB.push(b); eCost.push(cost); eKind.push(kind);
  };

  for (let gx = 0; gx < nx; gx++) {
    for (let gz = 0; gz < nz; gz++) {
      const c = gx * nz + gz;
      const cs = colStart[c];
      const ce = colStart[c + 1];
      if (cs === ce) continue;
      const ax = x0 + (gx + 0.5) * CELL;
      const az = z0 + (gz + 0.5) * CELL;

      for (let k = 0; k < 4; k++) {
        const ox = gx + NB_X[k];
        const oz = gz + NB_Z[k];
        if (ox < 0 || oz < 0 || ox >= nx || oz >= nz) continue;
        const oc = ox * nz + oz;
        const os = colStart[oc];
        const oe = colStart[oc + 1];
        if (os === oe) continue;
        const bx = x0 + (ox + 0.5) * CELL;
        const bz = z0 + (oz + 0.5) * CELL;
        const run = Math.hypot(bx - ax, bz - az);
        const diagonal = NB_X[k] !== 0 && NB_Z[k] !== 0;

        for (let i = cs; i < ce; i++) {
          const ay = nodeY[i];
          for (let j = os; j < oe; j++) {
            const by = nodeY[j];
            const dy = by - ay;
            const ady = Math.abs(dy);

            // ── WALK: same level, kerb, ramp or stair ─────────────────────
            if (ady <= SLOPE_MAX * run) {
              if (ady > FLAT_EPS && !continuous(ax, ay, az, bx, by, bz)) {
                // Not a ramp. Fall through to the ledge tests below.
              } else if (clear(ax, ay + CLEAR_Y, az, bx, by + CLEAR_Y, bz)) {
                const cost = Math.hypot(run, dy) * (diagonal ? DIAG_COST : 1);
                link(i, j, cost, NAV_WALK);
                link(j, i, cost, NAV_WALK);
                continue;
              } else {
                continue;   // blocked lane — no link of any kind here
              }
            }

            // ── LEDGE: climb up / drop down ───────────────────────────────
            const lo = dy > 0 ? i : j;
            const hi = dy > 0 ? j : i;
            const loY = dy > 0 ? ay : by;
            const hiY = dy > 0 ? by : ay;
            const loX = dy > 0 ? ax : bx;
            const loZ = dy > 0 ? az : bz;
            const hiX = dy > 0 ? bx : ax;
            const hiZ = dy > 0 ? bz : az;
            const gap = hiY - loY;
            if (gap <= STEP_UP || gap > DROP_MAX) continue;
            // The air over the low node has to be tall enough to stand up in on the way, and
            // the lane just above the ledge lip has to be open.
            if (nodeHead[lo] < gap + 0.4) continue;
            if (!clear(loX, hiY + 0.35, loZ, hiX, hiY + 0.35, hiZ)) continue;

            if (gap <= CLIMB_MAX) {
              link(lo, hi, run + CLIMB_COST + gap * CLIMB_COST_PER_M, NAV_CLIMB);
              climbs++;
            }
            link(hi, lo, run + DROP_COST, NAV_DROP);
            drops++;
          }
        }
      }
    }
  }

  // ── 4. flatten to CSR, with twin indices ─────────────────────────────────
  const edgeCount = eA.length;
  const edgeStart = new Int32Array(count + 1);
  for (let e = 0; e < edgeCount; e++) edgeStart[eA[e] + 1]++;
  for (let n = 0; n < count; n++) edgeStart[n + 1] += edgeStart[n];

  const cursor = Int32Array.from(edgeStart.subarray(0, count));
  const edgeTo = new Int32Array(edgeCount);
  const edgeCost = new Float32Array(edgeCount);
  const edgeKind = new Uint8Array(edgeCount);
  const edgeTwin = new Int32Array(edgeCount);
  /** raw edge index → CSR slot, so the twin links can be resolved afterwards. */
  const slotOf = new Int32Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    const slot = cursor[eA[e]]++;
    slotOf[e] = slot;
    edgeTo[slot] = eB[e];
    edgeCost[slot] = eCost[e];
    edgeKind[slot] = eKind[e];
  }
  /**
   * TWINS. Almost every link is emitted as a pair, but a ledge taller than `CLIMB_MAX` is a
   * DROP with no way back up — a genuinely one-way edge. Resolve by scanning the destination's
   * adjacency (build-time only, and each list is ~8 long) rather than by index arithmetic, so
   * the result is correct no matter what order the pairs were emitted in. `-1` marks one-way:
   * the reversed sweep must refuse to traverse it, or the field would happily route a zombie
   * UP a 6.8 m sheer wall.
   */
  for (let e = 0; e < edgeCount; e++) {
    const slot = slotOf[e];
    const a = eA[e];
    const b = eB[e];
    let twin = -1;
    for (let f = edgeStart[b]; f < edgeStart[b + 1]; f++) {
      if (edgeTo[f] === a) { twin = f; break; }
    }
    edgeTwin[slot] = twin;
  }

  const stats: NavStats = {
    nodes: count,
    edges: edgeCount,
    climbs,
    drops,
    columns: cols,
    rays,
    buildMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  };

  return new NavGraph(
    x0, z0, nx, nz, nodeY, nodeCol, nodeHead, colStart,
    edgeStart, edgeTo, edgeCost, edgeKind, edgeTwin, stats,
  );
}

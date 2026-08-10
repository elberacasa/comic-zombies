/**
 * NAV DEBUG DRAW — "why did that zombie go THERE?"
 *
 * The navigation layer (`world/nav.ts`) is a 6.8k-node column lattice carrying a budgeted flow
 * field. Everything it does is invisible: an agent either arrives or it does not, and when it does
 * not there is nothing on screen to tell you whether the graph is wrong, the field is stale, or
 * the body is stuck on geometry the graph never knew about. This draws the field.
 *
 * IT IS A DEBUG *CONSUMER*, NOT A SYSTEM WITH AN OPINION. It reads the graph through the same
 * public surface the console has (`nodeAt` / `point` / `next` / `kindOf` / `costOf`), never
 * through a structural probe, and it is handed the graph by `main.ts` as a getter — this file
 * imports the `NavGraph` *type* from the library, never the enemy system that owns the instance.
 *
 * THREE MODES, cycled with F8 (and `CZ.navDraw.mode`):
 *   off      nothing, zero cost — one boolean per frame.
 *   routes   the route every live enemy is actually going to walk, node by node, to the goal.
 *            This is the one you want 95% of the time: it answers "stupid route?" directly.
 *   field    routes PLUS the whole flow field in a radius around the player — every node's
 *            surface tick and its outgoing flow link. This is what you look at when the routes
 *            are missing entirely (no node under the body, a hole in the lattice, a severed
 *            flight of stairs).
 *
 * DRAWS ONLY WHILE THE DEBUG OVERLAY IS UP (backquote), because it shares `DebugSystem`'s single
 * 4096-segment buffer with every other debug consumer — and that buffer is cleared and ignored
 * whenever the overlay is off. Both budgets below exist so nav draw can never eat the whole
 * buffer and starve someone else's lines.
 *
 * ZERO ALLOCATION. Two module scratch vectors, a fixed route budget, no arrays built per frame.
 */

import { Vector3 } from 'three';

import type { GameCtx, System } from '@/core/types';
import { PALETTE } from '@/art/palette';
import { NAV_CLIMB, NAV_DROP } from '@/world/nav';
import type { NavGraph } from '@/world/nav';

export type NavDrawMode = 'off' | 'routes' | 'field';

const MODES: readonly NavDrawMode[] = ['off', 'routes', 'field'] as const;

/**
 * Feel/legibility constants for a debug overlay. These are not gameplay numbers and deliberately
 * do NOT live in `tuning.ts` — nothing here can change how the game plays.
 */
const DRAW = {
  /** Radius around the player the field is sampled in, metres. ~700 nodes at CELL 1.75. */
  fieldRadius: 22,
  /** Hard segment ceiling for the field layer, so it can never starve another debug consumer. */
  fieldBudget: 2200,
  /** Hard segment ceiling for the route layer. 25 agents × 40 hops is the worst realistic case. */
  routeBudget: 1100,
  /** Route hops followed per agent before we give up. Long enough to cross the arena. */
  maxHops: 46,
  /** Lift every line off its surface so it reads against the floor it describes. */
  lift: 0.08,
  /** Height of a node's surface tick. */
  tick: 0.22,
  /** Height of the goal marker's mast. */
  goalMast: 2.4,
} as const;

const COLOR = {
  /** A walk link — the overwhelming majority. Cool, so climbs and drops pop out of it. */
  walk: PALETTE.ELECTRIC,
  /** A climb link: a body will mantle here. */
  climb: PALETTE.GOLD,
  /** A drop link: a body will step off an edge here. */
  drop: PALETTE.RUST,
  /** A node the field cannot reach from the player. If a route dies, it dies into these. */
  orphan: PALETTE.SLATE,
  /** The route an agent is committed to right now. */
  route: PALETTE.PAPER,
  /** Where the field is flowing to — the player's own node. */
  goal: PALETTE.ACID,
} as const;

const _a = new Vector3();
const _b = new Vector3();

export interface NavDrawOptions {
  /** How to reach the live graph. Returns null before `EnemySystem.init` has built it. */
  graph: () => NavGraph | null;
  /** Start mode. Defaults to `routes` — free unless the debug overlay is up. */
  mode?: NavDrawMode;
}

export class NavDrawSystem implements System {
  readonly name = 'navdraw';

  mode: NavDrawMode;

  private readonly graphOf: () => NavGraph | null;
  private ctx: GameCtx | null = null;
  /** Last frame's segment counts, for the debug panel — the overlay's own cost, visible. */
  private drawnField = 0;
  private drawnRoutes = 0;

  constructor(opts: NavDrawOptions) {
    this.graphOf = opts.graph;
    this.mode = opts.mode ?? 'routes';
    window.addEventListener('keydown', this.onKeyDown);
  }

  init(ctx: GameCtx): void {
    this.ctx = ctx;
    ctx.debug.watch('nav draw', () => {
      if (this.mode === 'off') return 'off (F8)';
      const nav = this.graphOf();
      if (!nav) return `${this.mode} · no graph`;
      // "Nothing on screen" has two very different causes and the panel must tell them apart:
      // the field genuinely idles at `navDemand === 0` (everyone is on the player's level and
      // steering directly), which is correct and NOT a bug.
      if (!nav.hasField) return `${this.mode} · lattice only (field idle)`;
      return `${this.mode} · ${this.drawnRoutes}+${this.drawnField} seg`;
    });
  }

  /**
   * Presentation, not simulation — this must never run in `fixedUpdate`, and it must never
   * touch the graph's own state. Nothing here writes anything the sim can read.
   */
  update(_dt: number, ctx: GameCtx): void {
    this.drawnField = 0;
    this.drawnRoutes = 0;
    if (this.mode === 'off' || !ctx.debug.enabled) return;
    const nav = this.graphOf();
    if (!nav) return;

    /**
     * NO FIELD IS THE NORMAL CASE, not a failure. The flow field only sweeps while `navDemand`
     * is non-zero — i.e. while somebody is above, below or wedged — so a horde fighting the
     * player on flat ground never builds one, by design. An overlay that drew nothing in that
     * state would read as broken and send the next person hunting a bug that is not there. So
     * the lattice still draws: you can see the graph exists and where its holes are, and the
     * panel says "field idle" rather than leaving you to guess.
     */
    if (!nav.hasField) {
      if (this.mode === 'field') this.drawField(ctx, nav);
      return;
    }

    this.drawGoal(ctx, nav);
    this.drawRoutes(ctx, nav);
    if (this.mode === 'field') this.drawField(ctx, nav);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.ctx = null;
  }

  /** Cycle off → routes → field → off. Also `CZ.navDraw.cycle()`. */
  cycle(): NavDrawMode {
    const i = MODES.indexOf(this.mode);
    this.mode = MODES[(i + 1) % MODES.length]!;
    return this.mode;
  }

  // ── layers ────────────────────────────────────────────────────────────────

  /** A mast on the node the whole field is flowing toward. If this is not under the player's
   *  feet, the field is stale — which is the single most useful thing this overlay can say. */
  private drawGoal(ctx: GameCtx, nav: NavGraph): void {
    const g = nav.goal;
    if (g < 0) return;
    nav.point(g, _a);
    _a.y += DRAW.lift;
    _b.copy(_a);
    _b.y += DRAW.goalMast;
    ctx.debug.line(_a, _b, COLOR.goal);
    ctx.debug.point(_a, COLOR.goal);
  }

  /**
   * THE ROUTE LAYER. For every living enemy, resolve the node under it and walk `next()` to the
   * goal exactly the way the agent will. This is the ground truth of what the body is about to
   * do — including the case that matters most, where `nodeAt` returns -1 and the trail simply
   * does not appear, which tells you the body is somewhere the lattice does not describe.
   */
  private drawRoutes(ctx: GameCtx, nav: NavGraph): void {
    const bodies = ctx.enemies.all;
    let budget = DRAW.routeBudget;
    for (let i = 0; i < bodies.length && budget > 0; i++) {
      const e = bodies[i]!;
      if (!e.alive) continue;
      const p = e.position;
      let n = nav.nodeAt(p.x, p.y, p.z);
      if (n < 0) continue;

      // From the body's chest down to the node it resolved to: this is the "am I even on the
      // graph I think I am on" line, and it is how you catch a body one storey off its route.
      _a.set(p.x, p.y + 1.1, p.z);
      nav.point(n, _b);
      _b.y += DRAW.lift;
      ctx.debug.line(_a, _b, COLOR.route);
      budget--;

      for (let hop = 0; hop < DRAW.maxHops && budget > 0; hop++) {
        const to = nav.next(n);
        if (to < 0) break;
        const kind = nav.kindOf(n);
        nav.point(n, _a);
        nav.point(to, _b);
        _a.y += DRAW.lift;
        _b.y += DRAW.lift;
        ctx.debug.line(_a, _b, kindColor(kind, COLOR.route));
        budget--;
        n = to;
      }
    }
    this.drawnRoutes = DRAW.routeBudget - budget;
  }

  /**
   * THE FIELD LAYER. Every node in a radius of the player gets an upright tick (so you can see
   * the lattice's actual resolution and where it has holes) and its outgoing flow link coloured
   * by kind. Unreachable nodes get a dim tick and no link — a wall of those is a severed region.
   */
  private drawField(ctx: GameCtx, nav: NavGraph): void {
    const eye = ctx.player.position;
    const r2 = DRAW.fieldRadius * DRAW.fieldRadius;
    let budget = DRAW.fieldBudget;

    for (let i = 0; i < nav.nodeCount && budget > 0; i++) {
      nav.point(i, _a);
      const dx = _a.x - eye.x;
      const dz = _a.z - eye.z;
      if (dx * dx + dz * dz > r2) continue;
      // Vertical slab too: on a multi-storey column we only want the deck we are looking at,
      // or a fountain rim buries itself under the roof lattice three floors up.
      if (Math.abs(_a.y - eye.y) > DRAW.fieldRadius * 0.5) continue;

      _a.y += DRAW.lift;
      const to = nav.next(i);
      const reachable = to >= 0 || i === nav.goal;

      _b.copy(_a);
      _b.y += DRAW.tick;
      ctx.debug.line(_a, _b, reachable ? kindColor(nav.kindOf(i), COLOR.walk) : COLOR.orphan);
      budget--;

      if (to >= 0 && budget > 0) {
        nav.point(to, _b);
        _b.y += DRAW.lift;
        ctx.debug.line(_a, _b, kindColor(nav.kindOf(i), COLOR.walk));
        budget--;
      }
    }
    this.drawnField = DRAW.fieldBudget - budget;
  }

  // ── hotkey ────────────────────────────────────────────────────────────────

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== 'F8' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const m = this.cycle();
    // Turning the layer on with the overlay down would silently do nothing, which reads as a
    // dead key. Bring the overlay up with it.
    const ctx = this.ctx;
    if (ctx) {
      if (m !== 'off' && !ctx.debug.enabled) ctx.debug.toggle();
      ctx.hud.toast(m === 'off' ? 'NAV DRAW · OFF' : `NAV DRAW · ${m.toUpperCase()}`);
    }
  };
}

/** WALK keeps the caller's colour; CLIMB and DROP are always called out. */
function kindColor(kind: number, walk: number): number {
  if (kind === NAV_CLIMB) return COLOR.climb;
  if (kind === NAV_DROP) return COLOR.drop;
  return walk;
}

export function createNavDraw(opts: NavDrawOptions): NavDrawSystem {
  return new NavDrawSystem(opts);
}

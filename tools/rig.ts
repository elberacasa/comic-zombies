/**
 * HEADLESS RIG — the real arena, the real collision octree, the real `PlayerController` and
 * the real `EnemySystem`, running in node with no GL context and no DOM.
 *
 * WHY THIS EXISTS. "After the gravity changes I can't go upstairs" is a movement-solver
 * regression, and a movement-solver regression is exactly the kind of fact a machine can pin
 * down and a human should never have to. Everything here is objective: heights, times,
 * penetration depths, milliseconds. Nothing here judges how anything looks or feels.
 *
 * NOTHING IN `src/` IS MODIFIED TO SUPPORT THIS. The rig only uses the exported surfaces the
 * game already has, so it cannot drift into being a second implementation of the game.
 *
 * Run it with `node tools/stairs.mjs` (bundles through vite, so `@/` and `three/addons`
 * resolve exactly as they do in the browser).
 */

import { Scene, Vector3, PerspectiveCamera, Group } from 'three';
import type {
  ActionName, DamageInfo, Damageable, DebugService, EventBus, GameCtx, HudService,
  InputService, PlayerStats, Time, WorldService,
} from '@/core/types';
import { Emitter } from '@/core/events';
import { Rng } from '@/core/rng';
import { buildArena, type Arena } from '@/world/arena';
import { buildCollision, type WorldCollision } from '@/world/collision';
import { PlayerController } from '@/game/player/controller';
import { makeBaseStats } from '@/game/player/stats';
import { EnemySystem } from '@/game/enemies/service';
import { BODY } from '@/game/enemies/defs';
import { MOVE } from '@/game/tuning';

export const FIXED = 1 / 120;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Stubs. Only the surfaces `PlayerController` and `EnemySystem` actually touch do any work.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export class RigInput implements InputService {
  readonly lookDelta = { x: 0, y: 0 };
  readonly moveAxis = { x: 0, y: 0 };
  pointerLocked = true;
  sensitivity = 1;
  adsSensitivityMult = 1;

  private readonly held = new Set<ActionName>();
  private readonly downEdge = new Set<ActionName>();
  private readonly upEdge = new Set<ActionName>();

  down(a: ActionName): boolean { return this.held.has(a); }
  pressed(a: ActionName): boolean { return this.downEdge.has(a); }
  released(a: ActionName): boolean { return this.upEdge.has(a); }
  requestPointerLock(): void { /* no pointer in node */ }

  set(a: ActionName, on: boolean): void {
    if (on && !this.held.has(a)) { this.held.add(a); this.downEdge.add(a); }
    else if (!on && this.held.has(a)) { this.held.delete(a); this.upEdge.add(a); }
  }

  /** Call once per simulated FRAME, after the step that consumed the edges. */
  endFrame(): void { this.downEdge.clear(); this.upEdge.clear(); }

  reset(): void {
    this.held.clear(); this.downEdge.clear(); this.upEdge.clear();
    this.moveAxis.x = 0; this.moveAxis.y = 0;
  }
}

class RigTime implements Time {
  elapsed = 0;
  unscaledElapsed = 0;
  dt = FIXED;
  frameDt = FIXED;
  frame = 0;
  timeScale = 1;
  hitstop(): void { /* the rig never stalls the clock */ }
  advance(): void {
    this.elapsed += FIXED; this.unscaledElapsed += FIXED; this.frame++;
  }
}

class RigDebug implements DebugService {
  readonly enabled = false;
  toggle(): void {}
  watch(): void {}
  line(): void {}
  point(): void {}
  log(): void {}
}

class RigHud implements HudService {
  titleCard(): void {}
  toast(): void {}
  prompt(): void {}
  setCrosshairSpread(): void {}
  hitMarker(): void {}
  setVisible(): void {}
}

/**
 * The player stand-in the horde steers at. `EnemySystem` reads exactly two things off
 * `ctx.player` — `position` and `lookDir` — plus `takeDamage`, which the rig swallows so a
 * 120 s soak is never cut short by a death.
 */
class RigPlayer implements Damageable {
  readonly id = -1;
  readonly alive = true;
  readonly position = new Vector3();
  readonly lookDir = new Vector3(0, 0, -1);
  hits = 0;
  takeDamage(_info: DamageInfo): void { this.hits++; }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The rig
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface Rig {
  readonly arena: Arena;
  readonly world: WorldCollision;
  readonly events: EventBus;
  readonly input: RigInput;
  readonly time: RigTime;
  readonly ctx: GameCtx;
  readonly controller: PlayerController;
  readonly enemies: EnemySystem;
  readonly stats: PlayerStats;
  /** Advance the PLAYER only, one fixed step. Yaw is held by the caller. */
  stepPlayer(yaw: number): void;
  /** Advance the player and the horde, one fixed step. Returns sim milliseconds. */
  stepAll(yaw: number): number;
  /** Advance the horde only (the player is parked wherever `ctx.player.position` says). */
  stepHorde(): number;
}

export function buildRig(seed = 0x1234): Rig {
  const arena = buildArena({ seed });
  const root = new Group();
  root.add(arena.group);
  const world = buildCollision(root, arena, {
    groundNormalY: MOVE.minGroundNormalY,
    groundProbe: MOVE.groundProbe,
  });

  const events = new Emitter() as unknown as EventBus;
  const input = new RigInput();
  const time = new RigTime();
  const scene = new Scene();
  const player = new RigPlayer();
  const enemies = new EnemySystem();
  const stats = makeBaseStats();

  /**
   * ONE aggregate cast, and it is deliberate. `GameCtx` names sixteen services; the two
   * systems under test touch six of them, and hand-stubbing renderer/weapons/rounds/boons/
   * vfx/audio would be several hundred lines of code that can silently rot out of date. The
   * six that ARE touched are implemented properly above, against their real interfaces, so
   * the parts of the contract this rig exercises are type-checked for real.
   */
  const ctx = {
    scene,
    camera: new PerspectiveCamera(),
    input,
    events,
    time,
    rng: new Rng(seed),
    world,
    player,
    enemies,
    debug: new RigDebug(),
    hud: new RigHud(),
  } as unknown as GameCtx;

  const controller = new PlayerController();
  controller.attach({ world, input, events, stats: () => stats });

  enemies.init(ctx);

  const stepPlayer = (yaw: number): void => {
    time.advance();
    controller.beginFrame(time.frame);
    controller.fixedUpdate(FIXED, yaw, time.frame);
    // The horde steers at `ctx.player`, so keep the stand-in glued to the real capsule.
    player.position.copy(controller.position);
    player.position.y += controller.eyeHeight;
    input.endFrame();
  };

  const stepHorde = (): number => {
    const t0 = performance.now();
    enemies.fixedUpdate(FIXED, ctx);
    return performance.now() - t0;
  };

  const stepAll = (yaw: number): number => {
    const t0 = performance.now();
    stepPlayer(yaw);
    enemies.fixedUpdate(FIXED, ctx);
    return performance.now() - t0;
  };

  return {
    arena, world, events, input, time, ctx, controller, enemies, stats,
    stepPlayer, stepAll, stepHorde,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Yaw that makes the controller's forward axis point from `from` to `to`. */
export function yawToward(fx: number, fz: number, tx: number, tz: number): number {
  // The controller's forward is (-sin(yaw), 0, -cos(yaw)).
  return Math.atan2(-(tx - fx), -(tz - fz));
}

const _probeA = new Vector3();
const _probeB = new Vector3();

/** How deep a body of this shape at `pos` (FEET) sits inside the collision world. */
export function overlapAt(world: WorldService, pos: Vector3, height: number, radius: number): number {
  _probeA.set(pos.x, pos.y + radius, pos.z);
  _probeB.set(pos.x, pos.y + Math.max(height - radius, radius + 0.01), pos.z);
  const c = world.collideCapsule(_probeA, _probeB, radius);
  return c ? c.depth : 0;
}

/** Ground height under (x, z), searching from `fromY` down. Null when there is nothing. */
export function groundAt(world: WorldService, x: number, z: number, fromY: number): number | null {
  _probeA.set(x, fromY, z);
  _probeB.set(0, -1, 0);
  const hit = world.raycast(_probeA, _probeB, 200);
  return hit.hit ? hit.point.y : null;
}

export const ENEMY_SHAPE = { radius: BODY.radius, height: BODY.height };

export function pad(s: string | number, n: number): string {
  const t = String(s);
  return t.length >= n ? t : t + ' '.repeat(n - t.length);
}

export function padLeft(s: string | number, n: number): string {
  const t = String(s);
  return t.length >= n ? t : ' '.repeat(n - t.length) + t;
}

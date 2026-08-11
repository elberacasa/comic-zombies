/**
 * PLAYER SYSTEM — wires the controller + camera to the game context and exposes `PlayerService`.
 *
 * Registration order (ARCHITECTURE §3) puts the player after `world` and before `weapons`, so by
 * the time a gun fires this frame, `player.eye` and `player.lookDir` are already this frame's.
 *
 * FRAME CONTRACT
 *   fixedUpdate  · look is consumed ONCE per frame (first fixed step), then the sim steps
 *   update       · camera layers advance at frame rate; look is consumed here too if the frame
 *                  ran zero fixed steps (>120fps displays), so the view never stutters
 *   lateUpdate   · the eye is interpolated between sim snapshots and the camera is composed
 *
 * Everything gameplay-critical (position, velocity, state machine) is in `fixedUpdate`.
 * Everything presentational (bob, dip, shake, FOV) is in `update`. Nothing crosses over.
 */

import { Vector3 } from 'three';
import type {
  DamageInfo, GameCtx, MoveState, PlayerService, PlayerStats, System,
} from '@/core/types';
import { clamp01 } from '@/core/mathx';
import { css } from '@/art/palette';
import type { ComfortMode } from '@/game/tuning';
import { CAMERA, MOVE, PLAYER } from '@/game/tuning';
import { PlayerController } from './controller';
import { PlayerCamera } from './camera';
import { StatModifierStack, clampStats, copyStats, makeBaseStats } from './stats';
import type { StatModifier } from './stats';

const _eye = new Vector3();
const _hurtDir = new Vector3();

/**
 * Prices in, whole points out — the single place `spend()` and `canAfford()` agree on what a
 * number of points means, so a prompt can never say AFFORDABLE about a cost the transaction then
 * rejects.
 *
 * Returns `-1` for anything that is not a spendable price (negative, NaN, ±Infinity); callers
 * treat that as an unconditional refusal. Rounding matches `addPoints`, which also rounds, so the
 * two halves of the economy cannot disagree about a fractional value. Branch-only, no allocation.
 */
function normalizeCost(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) return -1;
  return Math.round(amount);
}

/**
 * COMFORT TOGGLE KEY (ART_DIRECTION §10 wants this reachable, and reachable *live* — the whole
 * point of a comfort preset is that the person who needs it is already feeling sick).
 *
 * F7 rather than a letter: every letter within reach of WASD is either bound or about to be, and
 * F1–F5 already belong to the quality tiers and the art-direction A/B in `main.ts`.
 */
const COMFORT_KEY = 'F7';

export class PlayerSystem implements System, PlayerService {
  readonly name = 'player';

  readonly controller = new PlayerController();
  readonly camera = new PlayerCamera();

  /** The injectable boon modifier stack. `BoonService` owns the entries; we only run them. */
  readonly modifiers = new StatModifierStack();

  readonly id = 0;

  private readonly _base: PlayerStats = makeBaseStats();
  private readonly _stats: PlayerStats = makeBaseStats();
  private readonly _lookDir = new Vector3(0, 0, -1);
  private readonly _eyeSim = new Vector3();

  private _health = PLAYER.startHealth;
  private _points = PLAYER.startPoints;
  private _down = false;
  private _dead = false;
  private _downTimer = 0;
  private _sinceDamage = 999;
  private _kills = 0;

  private ctx!: GameCtx;
  private lookFrame = -1;
  private offLanded: (() => void) | null = null;
  private onComfortKey: ((e: KeyboardEvent) => void) | null = null;

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // System
  // ═══════════════════════════════════════════════════════════════════════════════════════

  init(ctx: GameCtx): void {
    this.ctx = ctx;

    this.controller.attach({
      world: ctx.world,
      input: ctx.input,
      events: ctx.events,
      stats: () => this._stats,
    });
    this.camera.attach(ctx);

    this.recomputeStats();
    this._health = Math.min(PLAYER.startHealth, this._stats.maxHealth);

    const spawn = ctx.world.playerSpawn;
    this.controller.teleport(spawn.position, spawn.yaw);
    this.camera.setLook(spawn.yaw, 0);
    this.syncEye();

    // The camera reacts to landings, but it must not know what a controller is.
    this.offLanded = ctx.events.on('player:landed', (p) => {
      this.camera.landed(p.impactSpeed, this.controller.lastLandWasDive);
    });

    this.registerDebug(ctx);
    this.installComfortKey(ctx);
    ctx.events.emit('player:spawned', { position: this.controller.position });
  }

  dispose(): void {
    this.offLanded?.();
    this.offLanded = null;
    if (this.onComfortKey) {
      window.removeEventListener('keydown', this.onComfortKey);
      this.onComfortKey = null;
    }
    this.camera.dispose();
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Comfort preset — ART_DIRECTION §10
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * `'full'` (tuned default) or `'reduced'` (bob, lean, pose roll, land roll, shake and FOV
   * punch all zeroed). Live from the console as `CZ.player.comfortMode = 'reduced'`, from
   * `CZ.tuning.CAMERA.comfort`, or with the F7 key.
   */
  get comfortMode(): ComfortMode { return this.camera.comfortMode; }
  set comfortMode(mode: ComfortMode) {
    if (mode === this.camera.comfortMode) return;
    this.camera.comfortMode = mode;
    this.ctx?.hud.toast(`COMFORT · ${mode.toUpperCase()}`);
  }

  toggleComfort(): ComfortMode {
    this.comfortMode = this.camera.comfortMode === 'full' ? 'reduced' : 'full';
    return this.camera.comfortMode;
  }

  /**
   * The key listener lives here rather than in `main.ts` because the player system owns the
   * camera that the preset drives, and because a comfort toggle must survive `main.ts` being
   * re-wired by another milestone. It is removed in `dispose()`.
   */
  private installComfortKey(_ctx: GameCtx): void {
    const handler = (e: KeyboardEvent): void => {
      if (e.code !== COMFORT_KEY || e.repeat) return;
      e.preventDefault();
      this.toggleComfort();
    };
    this.onComfortKey = handler;
    window.addEventListener('keydown', handler, { passive: false });

    // The console card in `main.ts` is not ours to edit, so the binding announces itself here,
    // in the same visual language. `debug.log` is gated on the debug panel being open, and this
    // line has to be visible to a player who is already feeling sick — so it is a plain log.
    const key = `color:${css('ELECTRIC')};font:700 13px monospace`;
    const txt = `color:${css('PAPER')};font:13px monospace`;
    console.log(
      `%cCOMFORT%c  ${COMFORT_KEY} toggles motion comfort (ART §10) — currently ` +
      `${this.camera.comfortMode.toUpperCase()}.  REDUCED zeroes bob, lean, roll, shake and the ` +
      `FOV punch.  Live: %cCZ.player.comfortMode = 'reduced'`,
      key, txt, key,
    );
  }

  // ── sim ─────────────────────────────────────────────────────────────────────────────────

  fixedUpdate(dt: number, ctx: GameCtx): void {
    this.consumeLook(ctx);
    // Idempotent per frame; update() below already did it on any frame that ran zero steps.
    this.controller.beginFrame(ctx.time.frame);
    this.controller.fixedUpdate(dt, this.camera.yaw, ctx.time.frame);
    this.tickHealth(dt);
    this.syncEye();
  }

  // ── presentation ────────────────────────────────────────────────────────────────────────

  update(dt: number, ctx: GameCtx): void {
    // If the display outruns the sim (>120fps) a frame can run zero fixed steps. The view must
    // still track the mouse on those frames or fast flicks visibly stutter.
    this.consumeLook(ctx);
    // Same reason, but for the JUMP/CROUCH edges: input clears them at the end of every frame,
    // so they have to be latched from a hook that always runs. update() always runs.
    this.controller.beginFrame(ctx.time.frame);

    this.camera.update(dt, this.controller.drive);
    this.camera.forward(this._lookDir);

    // Speed lines are a render-service knob; the camera computed the intensity, we route it.
    // Only push when there is something to say — the pass decays on its own and re-driving it
    // with 0 every frame would fight that decay.
    const lines = this.camera.speedLineIntensity;
    if (lines > 0.001) ctx.renderer.speedLines(lines);
  }

  lateUpdate(alpha: number, ctx: GameCtx): void {
    this.controller.eyeAt(alpha, _eye);
    this.camera.compose(ctx.camera, _eye, this.controller.drive);
    this.camera.forward(this._lookDir);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Look
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private consumeLook(ctx: GameCtx): void {
    const f = ctx.time.frame;
    if (f === this.lookFrame) return;
    this.lookFrame = f;
    if (this._dead) return;
    const l = ctx.input.lookDelta;
    this.camera.applyLook(l.x, l.y, ctx.time.frameDt);
  }

  private syncEye(): void {
    this._eyeSim.copy(this.controller.position);
    this._eyeSim.y += this.controller.eyeHeight;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // PlayerService
  // ═══════════════════════════════════════════════════════════════════════════════════════

  get stats(): Readonly<PlayerStats> { return this._stats; }
  get baseStats(): Readonly<PlayerStats> { return this._base; }
  get health(): number { return this._health; }
  get alive(): boolean { return !this._dead; }
  get moveState(): MoveState { return this._down ? 'down' : this.controller.moveState; }
  get velocity(): Vector3 { return this.controller.velocity; }
  get speed(): number { return this.controller.speed; }
  get isAiming(): boolean { return this.ctx ? this.ctx.input.down('aim') : false; }
  get isDown(): boolean { return this._down; }
  /** FEET position — what enemies steer toward. Live reference; do not mutate it. */
  get position(): Vector3 { return this.controller.position; }
  /** Deterministic sim eye (no bob/shake) — the authoritative origin for shooting rays. */
  get eye(): Vector3 { return this._eyeSim; }
  get lookDir(): Vector3 { return this._lookDir; }
  get points(): number { return this._points; }
  get kills(): number { return this._kills; }
  /** Seconds of dive-roll invulnerability remaining. */
  get iFrames(): number { return this.controller.iFrames; }

  // ── presentation state for the weapon / viewmodel layer (PlayerService) ────
  // Plain forwards. They exist as contract members so `tsc` defends them; before this they were
  // read by structural probe, which would have degraded silently on any rename.
  get bobDistance(): number { return this.controller.bobDistance; }
  get sprintAmount(): number { return this.controller.sprintAmount; }
  get grounded(): boolean { return this.controller.grounded; }
  get crouching(): boolean { return this.controller.crouching; }
  get lastLandWasDive(): boolean { return this.controller.lastLandWasDive; }

  /** ADS zoom request. The camera clamps the summed punch, so this cannot breach ART §10. */
  get fovBias(): number { return this.camera.fovBias; }
  set fovBias(v: number) { this.camera.fovBias = v; }

  /** Weapon recoil impulse, radians. Positive pitch = muzzle climbs. */
  addRecoil(pitchRad: number, yawRad: number): void {
    this.camera.addRecoil(pitchRad, yawRad);
  }

  heal(amount: number): void {
    if (amount <= 0 || this._dead) return;
    const before = this._health;
    this._health = Math.min(this._health + amount, this._stats.maxHealth);
    const delta = this._health - before;
    if (delta <= 0) return;
    this.ctx?.events.emit('player:healed', { amount: delta, health: this._health });
  }

  addPoints(amount: number, reason = 'unknown'): void {
    if (amount === 0) return;
    const delta = amount > 0 ? Math.round(amount * this._stats.pointsMult) : Math.round(amount);
    this._points = Math.max(0, this._points + delta);
    this.ctx?.events.emit('player:points', { total: this._points, delta, reason });
  }

  /**
   * THE SINK. Every wall-buy, box spin, perk and Pack-a-Punch is one call to this
   * (BO2_MECHANICS §1.1 — "nothing else is possible without it").
   *
   * Atomicity is the whole point: a purchase must never half-happen. We test the normalized cost
   * against the balance and only then touch `_points`, so there is no intermediate state a
   * listener could observe and no path that can drive the balance below zero.
   *
   * `pointsMult` is deliberately NOT applied. It is an INCOME multiplier — a boon that pays 1.4×
   * must not silently inflate every price by 1.4× too, which would make it a no-op.
   *
   * Not a hot path — a purchase is one keypress, a handful per round — so the two small event
   * payloads are allocated fresh, exactly like `addPoints`/`heal`/`takeDamage` above. The
   * per-frame side of this API is `canAfford()`, which allocates nothing and emits nothing.
   */
  spend(amount: number, reason = 'unknown'): boolean {
    const cost = normalizeCost(amount);
    // A malformed price (negative / NaN / Infinity) is a caller bug, not a poor player. Refuse it
    // silently: firing the "can't afford" beat here would send the human hunting for points they
    // already have.
    if (cost < 0) return false;

    if (cost > this._points) {
      this.ctx?.events.emit('player:denied', {
        total: this._points, cost, shortfall: cost - this._points, reason,
      });
      return false;
    }

    this._points -= cost;
    // The HUD counter only refreshes on `player:points`, so a spend that skipped it would leave
    // the badge printing a balance the player no longer has — the same class of lie as the
    // vitals-badge bug in `tickHealth`. `hud.floatPoints` already ignores non-positive deltas, so
    // this updates the number without popping a floating "+" over a purchase.
    if (cost > 0) {
      this.ctx?.events.emit('player:points', { total: this._points, delta: -cost, reason });
    }
    this.ctx?.events.emit('player:spent', { total: this._points, cost, reason });
    return true;
  }

  /** Pure query — safe to call every frame from a buy prompt. See `PlayerService.canAfford`. */
  canAfford(amount: number): boolean {
    const cost = normalizeCost(amount);
    return cost >= 0 && cost <= this._points;
  }

  takeDamage(info: DamageInfo): void {
    if (this._dead || info.amount <= 0) return;
    // Dive landing roll grants i-frames (GAME_BIBLE §2) — the reward half of the dive's risk.
    if (this.controller.iFrames > 0) return;

    this._health -= info.amount;
    this._sinceDamage = 0;

    _hurtDir.copy(info.direction);
    this.ctx?.events.emit('player:damaged', {
      amount: info.amount,
      health: Math.max(this._health, 0),
      fromDirection: _hurtDir,
    });

    // Impact is a camera event as much as a health event.
    const t = clamp01(info.amount / Math.max(this._stats.maxHealth * 0.25, 1));
    this.camera.shake(0.18 + t * 0.35, 0.4);

    if (this._health <= 0) this.enterDown();
  }

  recomputeStats(): void {
    if (this.modifiers.count === 0) {
      copyStats(this._stats, this._base);
      clampStats(this._stats);
    } else {
      this.modifiers.apply(this._stats, this._base);
    }
    if (this._health > this._stats.maxHealth) this._health = this._stats.maxHealth;
    this.ctx?.events.emit('player:statsChanged', {});
  }

  /** Convenience for `BoonService`: push a modifier and recompute. Returns a disposer. */
  addStatModifier(fn: StatModifier, label = 'boon', order = 0): () => void {
    const off = this.modifiers.add(fn, label, order);
    this.recomputeStats();
    return () => { off(); this.recomputeStats(); };
  }

  teleport(position: Vector3, yaw?: number): void {
    this.controller.teleport(position, yaw);
    if (yaw !== undefined) this.camera.setLook(yaw, 0);
    this.camera.reset();
    this.syncEye();
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Health / down / death
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private tickHealth(dt: number): void {
    if (this._dead) return;

    if (this._down) {
      this._downTimer -= dt;
      if (this._downTimer <= 0) this.die();
      return;
    }

    this._sinceDamage += dt;
    const s = this._stats;
    if (this._sinceDamage < s.regenDelay || s.healthRegenPerSec <= 0) return;
    if (this._health >= s.maxHealth) return;

    const before = this._health;
    this._health = Math.min(this._health + s.healthRegenPerSec * dt, s.maxHealth);
    const delta = this._health - before;
    if (delta <= 0) return;

    // THE VITALS BADGE MUST NOT LIE. The HUD only refreshes health on `player:damaged`,
    // `player:healed` and `player:statsChanged`, so regen that mutates `_health` silently
    // froze the readout at the damaged value for the rest of the run.
    //
    // Rate-limited to the integer the badge actually prints (and to the instant we top out),
    // so an idle player at full HP emits nothing at all and the ART §4.1 stillness diff stays
    // at zero. Regen is ~1 HP/s, so this is a handful of emits, not one per fixed step.
    const full = this._health >= s.maxHealth;
    if (!full && Math.ceil(this._health) === Math.ceil(before)) return;
    this.ctx?.events.emit('player:healed', { amount: delta, health: this._health });
  }

  private enterDown(): void {
    if (this._down) return;
    if (this._stats.reviveCharges > 0) {
      // Self-revive boon: consume a charge, bounce straight back up. Never even go down.
      this._base.reviveCharges = Math.max(0, this._base.reviveCharges - 1);
      this.recomputeStats();
      this._health = this._stats.maxHealth * 0.5;
      this.camera.shake(0.7, 0.7);
      this.ctx?.events.emit('player:revived', {});
      return;
    }
    this._health = 0;
    this._down = true;
    this._downTimer = PLAYER.downTime;
    this.camera.shake(0.6, 0.8);
    this.ctx?.events.emit('player:down', { reviveTime: PLAYER.downTime });
  }

  private die(): void {
    if (this._dead) return;
    this._dead = true;
    this._down = false;
    // The run is over — stop taking movement input. `consumeLook` was already gated on `_dead`,
    // but the controller reads `input.moveAxis` itself, so the player could still walk around
    // behind the INKED OUT card. Gravity and collision keep running (see `frozen`), so the body
    // settles rather than freezing mid-stride.
    this.controller.frozen = true;
    this.ctx?.events.emit('player:died', {});
  }

  /** Full reset for a new run. */
  respawn(): void {
    this._dead = false;
    this._down = false;
    // Must be cleared here or "RUN IT BACK" hands you a game you cannot move in.
    this.controller.frozen = false;
    this._downTimer = 0;
    this._sinceDamage = 999;
    this._kills = 0;
    this._points = PLAYER.startPoints;
    this.modifiers.clear();
    this.recomputeStats();
    this._health = this._stats.maxHealth;
    const spawn = this.ctx.world.playerSpawn;
    this.teleport(spawn.position, spawn.yaw);
    this.ctx.events.emit('player:spawned', { position: this.controller.position });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Debug — these four are the ones we will be staring at while tuning with the human.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private registerDebug(ctx: GameCtx): void {
    const d = ctx.debug;
    d.watch('speed', () => this.controller.speed.toFixed(2) + ' m/s');
    d.watch('state', () => this.moveState);
    d.watch('grounded', () => (this.controller.grounded ? 'yes' : 'no'));
    d.watch('slide t', () => this.controller.slideTimer.toFixed(3));
    d.watch('sprint', () => this.controller.sprintAmount.toFixed(2));
    d.watch('vspeed', () => this.controller.velocity.y.toFixed(2));
    d.watch('air t', () => this.controller.airTime.toFixed(2));
    d.watch('fov', () => this.camera.currentFov.toFixed(1));
    d.watch('trauma', () => this.camera.currentTrauma.toFixed(2));
    // The two ART §10 budgets, live on screen while we tune with the human. If `roll°` ever
    // reads above 4 or `lateral` above 0.015, a clamp has failed and it is a bug.
    d.watch('roll°', () => this.camera.currentRollDeg.toFixed(2));
    d.watch('lateral', () => this.camera.currentLateral.toFixed(4) + ' m');
    d.watch('comfort', () => this.camera.comfortMode);
    d.watch('health', () => `${Math.ceil(this._health)}/${Math.round(this._stats.maxHealth)}`);
    d.watch('points', () => this._points);
    d.watch('pos', () => {
      const p = this.controller.position;
      return `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`;
    });
    d.watch('cap h', () => this.controller.height.toFixed(2) + ' / ' + MOVE.standHeight.toFixed(2));
    d.watch('boons', () => this.modifiers.labels());
  }
}

export function createPlayer(): PlayerSystem {
  return new PlayerSystem();
}

/**
 * Set the motion-comfort preset without holding a reference to the player (ART §10). Anything
 * that only wants to flip the switch — a pause menu, a settings screen, a boot flag — uses this.
 * `PlayerCamera` reads `CAMERA.comfort` every frame, so this takes effect immediately.
 */
export function setComfortMode(mode: ComfortMode): void {
  if (mode !== 'full' && mode !== 'reduced') return;
  CAMERA.comfort = mode;
}

export function getComfortMode(): ComfortMode { return CAMERA.comfort; }

export { PlayerController } from './controller';
export { PlayerCamera } from './camera';
export { StatModifierStack, makeBaseStats } from './stats';
export type { StatModifier, StatModifierEntry } from './stats';
export type { CameraDrive } from './drive';
export { makeCameraDrive } from './drive';
export type { ComfortMode, ComfortScales } from '@/game/tuning';
export { comfortScales } from '@/game/tuning';

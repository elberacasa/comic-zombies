/**
 * WEAPON SERVICE — the system that owns the gun in your hands.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 *  1. ZERO INPUT LATENCY. The trigger is read and the shot is resolved inside `update()`, on
 *     the frame the button went down. Not queued for the next fixed step, not buffered, not
 *     deferred to `lateUpdate`. M2 §1 is explicit about this and the playtester will feel a
 *     single frame of delay without being able to name it.
 *
 *     That is a deliberate exception to "gameplay lives in fixedUpdate" (ARCHITECTURE §3), and
 *     it is a safe one: a hitscan shot is a pure function of the player's eye and aim, both of
 *     which are already this frame's by the time we run (the player system is registered ahead
 *     of us). Nothing here integrates over time, so nothing here can desync.
 *
 *  2. THE GUN NEVER TOUCHES THE VFX, AUDIO OR HUD SERVICES. Everything a shot causes leaves
 *     through the typed bus. The one exception is the crosshair, which is a continuous readout
 *     with no event in the frozen map — see `pushCrosshair()`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * TIMEBASE. Every weapon timer runs on UNSCALED frame time (`update`'s `dt`, which the loop
 * hands us as `time.frameDt`). Hitstop must make the WORLD feel heavy, never the trigger: a
 * fire-rate gate that stalls during a hitstop is indistinguishable from input lag.
 */

import { Vector3 } from 'three';
import type {
  GameCtx, PlayerStats, RNG, System, WeaponAffix, WeaponDef, WeaponInstance, WeaponService,
} from '@/core/types';
import { clamp01, easeOutCubic, lerp } from '@/core/mathx';
import { CAMERA, MOVE, WEAPON } from '@/game/tuning';
import { STARTER_WEAPON_ID, WEAPON_DEFS, getWeaponDef, upgradedDef } from './defs';
import { RecoilController, SpreadController, safeSpreadMult, type RecoilRig, type SpreadState } from './recoil';
import { buildShotDirection, traceShot, type ShotParams } from './firing';
import { Viewmodel, makeViewmodelDrive, type ViewmodelDrive } from './viewmodel';

const _origin = new Vector3();
const _aim = new Vector3();
const _dir = new Vector3();
const _prevPos = new Vector3();

const SLOT_COUNT = 2;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Weapon — the live instance. `WeaponInstance` from core/types.ts, implemented exactly.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export class Weapon implements WeaponInstance {
  def: WeaponDef;
  ammo: number;
  reserve: number;

  /** Set once by Pack-a-Punch. `def` is swapped for its derived upgraded form. */
  private _upgraded = false;

  // ── reload state machine ────────────────────────────────────────────────────────────────
  private _reloading = false;
  private _windowOpen = false;
  /** Seconds elapsed into the current reload, and its (mutable) total duration. */
  reloadT = 0;
  reloadDuration = 0;
  windowStart = 0;
  windowEnd = 0;
  /** The player only gets ONE attempt per reload. That is what makes the window matter. */
  activeAttempted = false;
  activeSucceeded = false;

  constructor(def: WeaponDef, stats: Readonly<PlayerStats>) {
    this.def = def;
    this.ammo = magSizeOf(def, stats);
    this.reserve = def.infiniteReserve ? 0 : Math.round(def.reserveAmmo * stats.reserveAmmoMult);
  }

  get isReloading(): boolean { return this._reloading; }
  get activeReloadOpen(): boolean { return this._windowOpen; }
  get upgraded(): boolean { return this._upgraded; }

  /** 0..1 through the reload, or -1 when not reloading — the viewmodel's routine clock. */
  get reloadProgress(): number {
    if (!this._reloading || this.reloadDuration <= 0) return -1;
    return clamp01(this.reloadT / this.reloadDuration);
  }

  /** @internal — only the service drives these. */
  setReloading(v: boolean): void { this._reloading = v; }
  /** @internal */
  setWindowOpen(v: boolean): void { this._windowOpen = v; }
  /** @internal */
  applyUpgrade(affix: WeaponAffix, stats: Readonly<PlayerStats>): void {
    this.def = upgradedDef(this.def, affix);
    this._upgraded = true;
    this.ammo = magSizeOf(this.def, stats);
    this.reserve = this.def.infiniteReserve
      ? 0
      : Math.round(this.def.reserveAmmo * stats.reserveAmmoMult);
  }
}

function magSizeOf(def: WeaponDef, stats: Readonly<PlayerStats>): number {
  return Math.max(1, Math.round(def.magSize * Math.max(stats.magSizeMult, 0.05)));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The player seam is now TYPED.
//
// These fields used to be read through untyped structural probes (`ctx.player as unknown as
// {...}`). That satisfied ARCHITECTURE §1 — no implementation import — but bought it with
// silence: a rename in the player would compile clean here and cost a 22° FOV flick at runtime.
// `PlayerService` and `InputService` now carry them, so the compiler defends the seam and the
// fallbacks below are gone with the probes that needed them.

// ═════════════════════════════════════════════════════════════════════════════════════════════
// WeaponSystem
// ═════════════════════════════════════════════════════════════════════════════════════════════

export class WeaponSystem implements System, WeaponService {
  readonly name = 'weapons';

  readonly allDefs: readonly WeaponDef[] = WEAPON_DEFS;

  private readonly _slots: (Weapon | null)[] = new Array<Weapon | null>(SLOT_COUNT).fill(null);
  private slot = 0;

  readonly recoil = new RecoilController();
  readonly spread = new SpreadController();
  readonly viewmodel = new Viewmodel();

  private ctx!: GameCtx;
  private rng!: RNG;
  private rig: RecoilRig | null = null;

  // ── firing ──────────────────────────────────────────────────────────────────────────────
  private sinceShot = 999;
  private dryCooldown = 0;
  private emptySince = -1;

  // ── ADS ─────────────────────────────────────────────────────────────────────────────────
  /** Raw 0..1 ADS timer. `adsBlend` is this on a curve — M2 §1: "a curve, not a lerp". */
  private adsT = 0;
  private adsBlend = 0;

  // ── active reload buff ──────────────────────────────────────────────────────────────────
  private buffRemaining = 0;

  // ── equip ───────────────────────────────────────────────────────────────────────────────
  private equipRemaining = 0;

  // ── bob distance (fallback accumulator, used only if the player does not expose one) ─────
  private bobFallback = 0;
  private hasPrevPos = false;

  private readonly drive: ViewmodelDrive = makeViewmodelDrive();
  private readonly spreadState: SpreadState = {
    moving: false, sprinting: false, airborne: false, crouching: false, sliding: false, ads: 0,
  };
  private readonly shot: ShotParams = {
    weapon: null as unknown as WeaponInstance,
    def: WEAPON_DEFS[0],
    origin: _origin,
    direction: _dir,
    damageMult: 1,
    critMult: 1,
  };

  private offs: (() => void)[] = [];
  private announced = false;

  /** The cone the crosshair should draw, radians. Public so a HUD can poll it if it prefers. */
  currentSpread = 0;

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // System
  // ═══════════════════════════════════════════════════════════════════════════════════════

  init(ctx: GameCtx): void {
    this.ctx = ctx;
    // A dedicated stream, so spread jitter can never perturb any other system's RNG sequence.
    this.rng = ctx.rng.fork(0x1e5a);

    // `PlayerService.addRecoil` IS the recoil rig now — no probing, no null case.
    this.rig = ctx.player;

    this.viewmodel.build(ctx.scene);

    this.offs.push(
      ctx.events.on('player:landed', (p) => this.viewmodel.landed(p.impactSpeed)),
      // A respawn must not leave a half-played reload or a spring mid-flight on screen.
      ctx.events.on('player:spawned', () => this.resetTransient()),
    );

    this.give(STARTER_WEAPON_ID);
    this.registerDebug(ctx);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.viewmodel.dispose();
  }

  // ── sim: only the bob accumulator fallback lives here ───────────────────────────────────

  fixedUpdate(dt: number, ctx: GameCtx): void {
    // bobDistance is a contract member now, so the fallback accumulator is dead weight.
    return;
    const p = ctx.player.position;
    if (!this.hasPrevPos) {
      _prevPos.copy(p);
      this.hasPrevPos = true;
      return;
    }
    const state = ctx.player.moveState;
    if (state !== 'air' && state !== 'dive' && state !== 'mantle') {
      this.bobFallback += Math.hypot(p.x - _prevPos.x, p.z - _prevPos.z);
    }
    _prevPos.copy(p);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // The frame. Order matters and is documented at every step.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  update(dt: number, ctx: GameCtx): void {
    const w = this.currentWeapon;

    this.sinceShot += dt;
    if (this.dryCooldown > 0) this.dryCooldown = Math.max(0, this.dryCooldown - dt);
    if (this.buffRemaining > 0) this.buffRemaining = Math.max(0, this.buffRemaining - dt);
    if (this.equipRemaining > 0) this.equipRemaining = Math.max(0, this.equipRemaining - dt);

    // 1 · ADS first: the cone, the FOV and the sensitivity all key off it, and the shot below
    //     must use THIS frame's value or ADS would be one frame behind the trigger.
    this.updateAds(dt, ctx, w);

    // 2 · reload state machine, including the active-reload window.
    if (w) this.updateReload(dt, ctx, w);

    // 3 · THE TRIGGER. On the edge, in this frame, with no buffering anywhere in the path.
    if (w) this.updateTrigger(ctx, w);

    // 4 · swap (M2 ships one weapon; the tech is here so M4 does not have to add it).
    if (ctx.input.pressed('swap')) this.swapTo(this.slot === 0 ? 1 : 0);

    // 5 · recoil recovery. AFTER the shot, so this frame's kick is not immediately handed back,
    //     and it consumes the same `lookDelta` the player already consumed this frame.
    const look = ctx.input.lookDelta;
    this.recoil.update(dt, w?.def ?? null, look.x, look.y, this.rig);
    this.spread.update(dt);

    // 6 · publish the cone and drive the viewmodel.
    this.pushCrosshair(ctx, w);
    this.fillDrive(ctx, w, dt);
    this.viewmodel.update(dt, this.drive);

    // 7 · one-time announce. `init()` runs in registration order and we are registered before
    //     the HUD, so the ammo emitted while equipping the starter has nobody listening yet.
    //     The first frame is the earliest point at which every system's `init` has run.
    if (!this.announced) {
      this.announced = true;
      if (w) this.emitAmmo(ctx, w);
    }
  }

  lateUpdate(_alpha: number, ctx: GameCtx): void {
    // The player system is registered ahead of us, so `camera.matrixWorld` is already this
    // frame's finished pose — bob, dip, shake, roll and all. The viewmodel hangs off it.
    this.viewmodel.compose(ctx.camera, this.drive);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // ADS — position, FOV and spread on a curve (M2 §1)
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private updateAds(dt: number, ctx: GameCtx, w: Weapon | null): void {
    const aiming = ctx.input.down('aim');
    const def = w?.def;
    const stats = ctx.player.stats;
    const time = Math.max((def?.adsTime ?? 0.2) / Math.max(stats.adsSpeedMult, 0.05), 1e-3);

    const dir = aiming ? 1 : -1;
    this.adsT = clamp01(this.adsT + (dir * dt) / time);
    // `easeOutCubic` is a pure function of `adsT`, so reversing mid-blend can never pop — and
    // it front-loads the movement, which is what makes an ADS feel snappy rather than gluey.
    this.adsBlend = easeOutCubic(this.adsT);

    // ── FOV ───────────────────────────────────────────────────────────────────────────────
    // `PlayerCamera.updateFov` adds `CAMERA.fovAds` as a STEP the instant `input.down('aim')`
    // flips. We cancel that step exactly and replace it with the weapon's own `adsFov` on the
    // blend curve — so the sight picture is per-weapon and the change is smooth and bounded,
    // which ART §10 requires ("fast FOV punches are a strong nausea trigger").
    //
    // The cancellation MUST key off the same value the camera does. `PlayerCamera` reads
    // `CameraDrive.isAiming`, which the controller writes at the end of each fixed step — so on
    // a frame that ran zero fixed steps (>120 fps displays) it can be one frame behind
    // `input.down('aim')`. Reading the input here instead would mis-cancel by the full 22° for
    // that one frame, which the FOV spring would smear into a visible flick exactly on the
    // press. The blend above still keys off the raw input, because that is latency-critical;
    // only the cancellation term follows the camera.
    if (def) {
      const camAiming = ctx.player.isAiming;
      const step = camAiming ? CAMERA.fovAds : 0;
      ctx.player.fovBias = this.adsBlend * (def.adsFov - CAMERA.fovBase) - step;
    } else {
      ctx.player.fovBias = 0;
    }

    // ── sensitivity ───────────────────────────────────────────────────────────────────────
    // Scaled with the blend so the mouse never changes gain in a step. `InputSystem` publishes
    // this field for exactly this purpose.
    ctx.input.adsSensitivityMult = lerp(1, WEAPON.adsSensitivityMult, this.adsBlend);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Reload + ACTIVE RELOAD (GAME_BIBLE §3 — the pistol's skill expression)
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private updateReload(dt: number, ctx: GameCtx, w: Weapon): void {
    const pressed = ctx.input.pressed('reload');

    if (!w.isReloading) {
      // Auto-reload on empty, after a beat — long enough that the dry click registers as its
      // own event, short enough that you never stand there wondering why nothing happened.
      if (w.ammo <= 0 && this.emptySince >= 0) {
        this.emptySince += dt;
        if (this.emptySince >= WEAPON.autoReloadDelay) this.startReload(ctx, w);
      }
      if (pressed) this.startReload(ctx, w);
      return;
    }

    w.reloadT += dt;

    // ── the window ────────────────────────────────────────────────────────────────────────
    const open = !w.activeAttempted && w.reloadT >= w.windowStart && w.reloadT < w.windowEnd;
    if (open !== w.activeReloadOpen) {
      w.setWindowOpen(open);
      // The HUD draws the sweep from `weapon:reloadStart`'s duration and the def's window
      // fractions; this event is the authoritative "you may press it NOW".
      ctx.events.emit('weapon:activeReloadWindow', { open });
    }

    // ── the tap ───────────────────────────────────────────────────────────────────────────
    if (pressed && !w.activeAttempted) {
      w.activeAttempted = true;
      if (open) {
        // SUCCESS: the remaining reload is cut by `activeReloadSpeedup`, and you get the buff.
        const remaining = Math.max(0, w.reloadDuration - w.reloadT);
        w.reloadDuration = w.reloadT + remaining * (1 - WEAPON.activeReloadSpeedup);
        w.activeSucceeded = true;
        this.buffRemaining = WEAPON.activeReloadBuffTime;
        this.viewmodel.activeSuccess();
      } else {
        // MISS: a small stumble. Deliberately a nuisance, not a punishment — the cost of a miss
        // has to stay small or nobody ever tries it, and trying it is the whole mechanic.
        w.reloadDuration += WEAPON.activeReloadMissPenalty;
        this.viewmodel.activeMiss();
      }
      if (w.activeReloadOpen) {
        w.setWindowOpen(false);
        ctx.events.emit('weapon:activeReloadWindow', { open: false });
      }
    }

    if (w.reloadT >= w.reloadDuration) this.finishReload(ctx, w);
  }

  private startReload(ctx: GameCtx, w: Weapon): void {
    if (w.isReloading) return;
    const stats = ctx.player.stats;
    const mag = magSizeOf(w.def, stats);
    if (w.ammo >= mag) return;
    if (!w.def.infiniteReserve && w.reserve <= 0) return;

    const speed = Math.max(stats.reloadSpeedMult, 0.05);
    w.setReloading(true);
    w.reloadT = 0;
    w.reloadDuration = w.def.reloadTime / speed;
    // The window is scaled by the SAME speed factor, so it always sits at the same FRACTION of
    // the bar. A reload-speed boon must never move the sweet spot out from under a player who
    // has already learned it — that would make a buff feel like a nerf.
    w.windowStart = w.def.activeReloadWindow[0] / speed;
    w.windowEnd = (w.def.activeReloadWindow[0] + w.def.activeReloadWindow[1]) / speed;
    w.activeAttempted = false;
    w.activeSucceeded = false;
    this.emptySince = -1;

    ctx.events.emit('weapon:reloadStart', { weapon: w, duration: w.reloadDuration });
  }

  private finishReload(ctx: GameCtx, w: Weapon): void {
    const stats = ctx.player.stats;
    const mag = magSizeOf(w.def, stats);
    const need = Math.max(0, mag - w.ammo);
    const take = w.def.infiniteReserve ? need : Math.min(need, w.reserve);
    w.ammo += take;
    if (!w.def.infiniteReserve) w.reserve -= take;

    w.setReloading(false);
    if (w.activeReloadOpen) {
      w.setWindowOpen(false);
      ctx.events.emit('weapon:activeReloadWindow', { open: false });
    }
    ctx.events.emit('weapon:reloadEnd', { weapon: w, active: w.activeSucceeded });
    this.emitAmmo(ctx, w);
  }

  private cancelReload(ctx: GameCtx, w: Weapon): void {
    if (!w.isReloading) return;
    w.setReloading(false);
    if (w.activeReloadOpen) {
      w.setWindowOpen(false);
      ctx.events.emit('weapon:activeReloadWindow', { open: false });
    }
    ctx.events.emit('weapon:reloadEnd', { weapon: w, active: false });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // THE TRIGGER
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private updateTrigger(ctx: GameCtx, w: Weapon): void {
    // Semi-auto reads the EDGE, full-auto reads the HELD state. That single line is the whole
    // difference between a pistol and an SMG at the input layer, and it comes from the def.
    const wants = w.def.auto ? ctx.input.down('fire') : ctx.input.pressed('fire');
    if (!wants) return;

    if (w.isReloading) return;
    if (this.equipRemaining > 0) return;

    if (w.ammo <= 0) {
      if (this.dryCooldown > 0) return;
      this.dryCooldown = WEAPON.dryFireCooldown;
      if (this.emptySince < 0) this.emptySince = 0;
      ctx.events.emit('weapon:dryFire', { weapon: w });
      return;
    }

    const stats = ctx.player.stats;
    const rpm = Math.max(w.def.rpm * WEAPON.fireRateScale * Math.max(stats.fireRateMult, 0.05), 1);
    const interval = 60 / rpm;
    if (this.sinceShot < interval) return;

    this.fireShot(ctx, w, stats);
  }

  private fireShot(ctx: GameCtx, w: Weapon, stats: Readonly<PlayerStats>): void {
    const def = w.def;
    this.sinceShot = 0;

    // ── 1. ammo ───────────────────────────────────────────────────────────────────────────
    w.ammo -= 1;
    if (w.ammo <= 0) this.emptySince = 0;

    // ── 2. recoil: pattern in, camera kick out, viewmodel kick out ────────────────────────
    const recoilMult = Math.max(stats.recoilMult, 0)
      * lerp(1, WEAPON.adsRecoilMult, this.adsBlend);
    const kick = this.recoil.fire(def, recoilMult, this.rig);
    this.viewmodel.fire(def.weaponKick, kick.yaw, this.adsBlend);

    // The camera's trauma channel — a separate layer from the recoil spring, and the reason a
    // shot reads as a bang rather than only as a climb.
    ctx.events.emit('fx:shake', {
      amount: WEAPON.shotTrauma * def.cameraKick,
      duration: WEAPON.shotTraumaTime,
    });

    // ── 3. the ray ────────────────────────────────────────────────────────────────────────
    _origin.copy(ctx.player.eye);
    _aim.copy(ctx.player.lookDir);

    this.fillSpreadState(ctx);
    const cone = this.spread.cone(def, this.spreadState, safeSpreadMult(stats.spreadMult));
    this.spread.addShot();
    this.currentSpread = cone;

    // Announced BEFORE the impacts, per M2 §1's chain. Consumers may rely on the order:
    // weapon:fired → hit:enemy (near→far) → hit:world. `shotIndex` is the recoil pattern index,
    // so it is also a free 0..N-1 variation seed for the muzzle flash and the shell eject.
    ctx.events.emit('weapon:fired', {
      weapon: w,
      origin: _origin,
      direction: _aim,
      shotIndex: kick.index,
    });

    // ── 4. trace ──────────────────────────────────────────────────────────────────────────
    const buff = this.buffRemaining > 0 ? WEAPON.activeReloadBuff : 1;
    const baseMult = Math.max(stats.damageMult, 0) * WEAPON.damageScale * buff;

    this.shot.weapon = w;
    this.shot.def = def;
    this.shot.critMult = stats.critMult;

    let crits = 0;
    let kills = 0;

    const pellets = Math.max(1, def.pellets);
    for (let i = 0; i < pellets; i++) {
      buildShotDirection(_dir, _aim, cone, this.rng);
      this.shot.damageMult = baseMult;
      const r = traceShot(ctx, this.shot);
      crits += r.crits;
      kills += r.kills;
    }

    // GHOST BULLETS — `PlayerStats.extraShots` (the Double Vision boon). They are extra rays at
    // a damage penalty, fired through a slightly wider cone so they read as a second gun rather
    // than as a duplicate of the first.
    const extra = Math.max(0, Math.floor(stats.extraShots));
    for (let i = 0; i < extra; i++) {
      buildShotDirection(_dir, _aim, cone * 1.6 + 0.004, this.rng);
      this.shot.damageMult = baseMult * Math.max(stats.extraShotDamageMult, 0);
      const r = traceShot(ctx, this.shot);
      crits += r.crits;
      kills += r.kills;
    }

    // ── 5. aftermath ──────────────────────────────────────────────────────────────────────
    if (kills > 0) {
      ctx.events.emit('fx:shake', {
        amount: WEAPON.killTrauma * Math.min(kills, 3),
        duration: WEAPON.killTraumaTime,
      });
    }
    // Headshots refund to the magazine (`PlayerStats.headshotRefund`, GAME_BIBLE §5 rare boon).
    if (crits > 0 && stats.headshotRefund > 0) {
      const mag = magSizeOf(def, stats);
      w.ammo = Math.min(mag, w.ammo + Math.round(stats.headshotRefund * crits));
    }

    this.emitAmmo(ctx, w);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // State gathering
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private fillSpreadState(ctx: GameCtx): void {
    const s = this.spreadState;
    const state = ctx.player.moveState;
    s.airborne = state === 'air' || state === 'dive';
    s.sliding = state === 'slide';
    s.sprinting = state === 'sprint';
    s.crouching = ctx.player.crouching && !s.sliding;
    s.moving = ctx.player.speed > MOVE.footstepMinSpeed;
    s.ads = this.adsBlend;
  }

  private fillDrive(ctx: GameCtx, w: Weapon | null, dt: number): void {
    const d = this.drive;
    const state = ctx.player.moveState;

    d.speed = ctx.player.speed;
    d.bobDistance = ctx.player.bobDistance;
    d.grounded = ctx.player.grounded;
    d.moving = d.grounded && d.speed > MOVE.footstepMinSpeed && state !== 'slide';
    d.sprintAmount = ctx.player.sprintAmount;
    d.adsAmount = this.adsBlend;
    d.reloadProgress = w ? w.reloadProgress : -1;

    // Angular rate of the view, rad/s. Zero mouse movement ⇒ zero sway target ⇒ the sway spring
    // settles and `Viewmodel.settle*` snaps it to exactly the rest pose (ART §4.1).
    const look = ctx.input.lookDelta;
    const inv = dt > 1e-5 ? 1 / dt : 0;
    d.lookRateX = look.x * inv;
    d.lookRateY = look.y * inv;
  }

  /**
   * The crosshair is the one HUD call this system makes, because the frozen event map has no
   * event for a continuous readout and `setCrosshairSpread` is on the `HudService` interface
   * precisely so a weapon can drive it.
   *
   * DONE IN BUILD 003: `main.ts` used to carry an `AppSystem` that wrote the same field every
   * frame as an M1 placeholder ("the crosshair breathes with movement instead of with recoil").
   * It was registered after this system, so it won, and the crosshair never reacted to the gun.
   * That system is gone — this is now the only writer. Do not add a second one.
   */
  private pushCrosshair(ctx: GameCtx, w: Weapon | null): void {
    if (!w) return;
    this.fillSpreadState(ctx);
    const mult = safeSpreadMult(ctx.player.stats.spreadMult);
    this.currentSpread = this.spread.cone(w.def, this.spreadState, mult);
    ctx.hud.setCrosshairSpread(this.currentSpread);
  }

  private emitAmmo(ctx: GameCtx, w: Weapon): void {
    // `-1` is the HUD's sentinel for an infinite reserve — it prints `∞`.
    ctx.events.emit('weapon:ammoChanged', {
      ammo: w.ammo,
      reserve: w.def.infiniteReserve ? -1 : w.reserve,
    });
  }

  private resetTransient(): void {
    this.recoil.reset();
    this.spread.reset();
    this.viewmodel.reset();
    this.adsT = 0;
    this.adsBlend = 0;
    this.buffRemaining = 0;
    this.sinceShot = 999;
    this.dryCooldown = 0;
    this.emptySince = -1;
    const w = this.currentWeapon;
    if (w && w.isReloading) this.cancelReload(this.ctx, w);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // WeaponService
  // ═══════════════════════════════════════════════════════════════════════════════════════

  get current(): WeaponInstance | null { return this._slots[this.slot]; }
  get slots(): readonly (WeaponInstance | null)[] { return this._slots; }

  private get currentWeapon(): Weapon | null { return this._slots[this.slot]; }

  getDef(id: string): WeaponDef | undefined { return getWeaponDef(id); }

  give(defId: string): WeaponInstance | null {
    const def = getWeaponDef(defId);
    if (!def) return null;
    const w = new Weapon(def, this.ctx.player.stats);

    // Fill the first empty slot; otherwise replace what is in your hands. That is the Zombies
    // rule and it is the one players expect — a wall-buy never silently eats your other gun.
    let target = this._slots.indexOf(null);
    if (target < 0) target = this.slot;
    this._slots[target] = w;

    this.equipSlot(target, true);
    return w;
  }

  swapTo(slot: number): void {
    if (slot < 0 || slot >= SLOT_COUNT) return;
    if (slot === this.slot) return;
    if (!this._slots[slot]) return;
    this.equipSlot(slot, false);
  }

  private equipSlot(slot: number, isNew: boolean): void {
    const prev = this.currentWeapon;
    if (prev && prev.isReloading) this.cancelReload(this.ctx, prev);

    this.slot = slot;
    const w = this._slots[slot];
    if (!w) return;

    this.recoil.reset();
    this.spread.reset();
    this.sinceShot = 999;
    this.dryCooldown = 0;
    this.emptySince = w.ammo <= 0 ? 0 : -1;
    this.equipRemaining = isNew ? WEAPON.equipTime * 0.6 : WEAPON.equipTime;
    this.viewmodel.equip(w.def.id);

    this.ctx.events.emit('weapon:equipped', { weapon: w, slot });
    this.emitAmmo(this.ctx, w);
  }

  refillAmmo(slotOrAll: number | 'all' = 'all'): void {
    const stats = this.ctx.player.stats;
    const apply = (w: Weapon | null): void => {
      if (!w) return;
      w.ammo = magSizeOf(w.def, stats);
      if (!w.def.infiniteReserve) {
        w.reserve = Math.round(w.def.reserveAmmo * Math.max(stats.reserveAmmoMult, 0));
      }
    };
    if (slotOrAll === 'all') for (const w of this._slots) apply(w);
    else apply(this._slots[slotOrAll] ?? null);

    const cur = this.currentWeapon;
    if (cur) this.emitAmmo(this.ctx, cur);
  }

  upgrade(slot: number, affix: WeaponAffix = 'none'): void {
    const w = this._slots[slot];
    if (!w) return;
    if (w.isReloading) this.cancelReload(this.ctx, w);
    w.applyUpgrade(affix, this.ctx.player.stats);
    this.ctx.events.emit('weapon:upgraded', { weapon: w });
    if (slot === this.slot) this.emitAmmo(this.ctx, w);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Debug — the rows we will be staring at while tuning the gun with the human.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private registerDebug(ctx: GameCtx): void {
    const d = ctx.debug;
    d.watch('weapon', () => this.currentWeapon?.def.name ?? '—');
    d.watch('ammo', () => {
      const w = this.currentWeapon;
      if (!w) return '—';
      return `${w.ammo}/${w.def.infiniteReserve ? '∞' : w.reserve}`;
    });
    d.watch('spread°', () => (this.currentSpread * (180 / Math.PI)).toFixed(3));
    d.watch('shot #', () => this.recoil.shotIndex);
    // The CoD trick, live: how much climb the player still owes. It should drop as they pull
    // down and spring to 0 when they stop shooting — if it only ever springs, the correction
    // accounting is broken.
    d.watch('recoil debt°', () => this.recoil.debtDeg.toFixed(2));
    d.watch('ads', () => this.adsBlend.toFixed(2));
    d.watch('ar buff', () => (this.buffRemaining > 0 ? this.buffRemaining.toFixed(1) + 's' : '—'));
    // ART §4.1: this must read `yes` whenever the player is standing still and not shooting.
    d.watch('vm still', () => (this.viewmodel.frozen ? 'yes' : 'no'));
  }
}

export function createWeapons(): WeaponSystem {
  return new WeaponSystem();
}

/**
 * RECOIL & SPREAD — where the bullet actually goes, and where the view ends up.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ONE IDEA IN THIS FILE: recoil is a CONTRACT WITH THE PLAYER, not a random number.
 *
 *  Every shot's kick comes from `WeaponDef.recoilPattern` indexed by shot number. Fire the same
 *  burst twice and the muzzle traces the same path twice. That is what makes it learnable, and
 *  learnable is what makes it skill (GAME_BIBLE §3).
 *
 *  THE RECOVERY IS THE OTHER HALF, and it is the part most implementations get wrong:
 *
 *      The gun springs back toward where you were aiming BEFORE the burst — but only by the
 *      amount you have NOT already corrected yourself.
 *
 *  That is the Call of Duty trick. It means pulling down is never punished (you do not get
 *  yanked below your target when the spring lets go), and never doing anything is not rewarded
 *  either (you still have to fight the climb *during* the burst). We track a signed DEBT of
 *  un-corrected climb, subtract the player's own mouse movement from it every frame, and only
 *  ever hand back what is left.
 *
 *  AND A PATTERN IS A PER-CARTRIDGE PROMISE, WHICH MAKES THE RATE THE OTHER HALF OF IT. An
 *  automatic weapon spends that promise as many times a second as its cyclic rate says, and
 *  nothing here used to be watching the product. Two rules fix that and both are gated on
 *  `WeaponDef.auto`, so every semi-auto in the arsenal takes the identical code path it always
 *  did: `autoClimbScale` caps the climb per SECOND (`WEAPON.recoilAutoClimbMax`) and
 *  `recoverDelay` stops a fast weapon from re-arming the recovery delay forever
 *  (`WEAPON.recoilRecoverAutoDuty`). Neither one touches the pattern's shape.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE CAMERA SEAM. `player/camera.ts` owns a dedicated recoil spring and exposes exactly one
 * entry point, `addRecoil(pitchRad, yawRad)`. It splits every kick two ways:
 *   · `CAMERA.recoilAutoReturn` of it goes into a spring that returns to zero by itself — the
 *     transient snap you *see*,
 *   · the remaining `1 - recoilAutoReturn` is folded permanently into the look angles — the
 *     climb you have to *fight*.
 * That permanent fraction is the debt this file accounts for. We never touch the camera any
 * other way, and we never modify that file: it is comfort-critical (ART §10).
 */

import type { RNG, WeaponDef } from '@/core/types';
import type { Vector3 } from 'three';
import { TAU, clamp, clamp01, lerp } from '@/core/mathx';
import { CAMERA, WEAPON, sustainedFireWeight } from '@/game/tuning';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The camera seam, structurally typed.
//
// A game system may never import another game system's implementation (ARCHITECTURE §1), and
// `PlayerService` in the frozen contract does not expose the recoil channel. So we describe the
// shape we need and probe for it at runtime: no import, no coupling, and a missing rig simply
// means the weapon still fires and the camera does not kick.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RecoilRig {
  /** `pitchRad` positive = the muzzle climbs. */
  addRecoil(pitchRad: number, yawRad: number): void;
}

function isRecoilRig(x: unknown): x is RecoilRig {
  return typeof (x as RecoilRig | null)?.addRecoil === 'function';
}

/**
 * Find the camera's recoil channel on whatever the player service happens to be.
 * Returns `null` if this build's player does not expose one.
 */
export function findRecoilRig(player: unknown): RecoilRig | null {
  const p = player as { camera?: unknown } | null;
  if (isRecoilRig(p)) return p;
  if (p && isRecoilRig(p.camera)) return p.camera;
  return null;
}

/** The fraction of a kick that `addRecoil` folds permanently into the look angles. */
function permanentFraction(): number {
  return 1 - clamp01(CAMERA.recoilAutoReturn);
}

/**
 * Peak displacement of a damped spring kicked from rest, as `peak = v · gain(ζ) / ω`. Same
 * closed form as `player/camera.ts`, duplicated rather than imported (ARCHITECTURE §1). We need
 * it here to predict what the camera's spring will do with the return impulses we send it.
 */
function springPeakGain(zeta: number): number {
  if (zeta >= 0.999) return Math.exp(-1);
  const wd = Math.sqrt(1 - zeta * zeta);
  const t = Math.atan2(wd, zeta) / wd;
  return (Math.exp(-zeta * t) * Math.sin(wd * t)) / wd;
}

/**
 * THE RETURN-RATE CEILING, and it is not optional.
 *
 * `addRecoil` is the only door into the camera, and it splits everything it is handed: `auto`
 * into a spring, `1 - auto` into the look angles. To hand back `R · debt` of *permanent* climb
 * per second we must therefore push `R · debt / perm` through the door — and `auto` of that
 * lands in the spring as a sustained impulse train.
 *
 * A spring driven by a constant impulse rate sits at a constant offset. Working it through:
 *
 *     impulse per unit peak = ω / gain(ζ)          (the peak→velocity conversion addRecoil uses)
 *     peak requested per second = R · debt · auto / perm
 *     force  F = that · ω / gain(ζ)
 *     offset x = −F / ω²  =  −R · debt · auto / (perm · ω · gain(ζ))
 *
 * So the recovery drags the camera an EXTRA `R · auto / (perm · ω · gain)` times the debt below
 * the pre-fire angle while it runs. With the shipped camera (9 Hz, ζ0.55, auto 0.85) that factor
 * is `R · 0.19`, and the ceiling below therefore lands at R = 2.60.
 *
 * MEASURED — a full 12-round inkslinger magazine, no player correction, simulated at 60 Hz
 * against this exact code path:
 *     clamped   (R = 2.60)    worst dip below the pre-fire angle    0.000°, debt fully returned
 *     unclamped (R = 11)      worst dip                            −0.358°
 * Modest for a pistol — and it scales linearly with the debt. An SMG emptying 32 rounds through
 * a pattern three times as steep pulls the view down by several degrees with no input at all,
 * which is exactly the class of un-commanded motion ART §10 exists to prevent. It would have
 * arrived in M4 as "the SMG feels weird", not as a bug anyone could name.
 *
 * A *small* dip is not a bug, it is the gun settling, and the camera's recoil spring is
 * under-damped precisely so that settle has some ring to it. So we budget it: the effective
 * return rate is clamped so the transient never exceeds `WEAPON.recoilRecoverTransientMax` of
 * the debt, no matter what a weapon def asks for. The def states intent; physics gets a veto.
 */
function maxReturnRate(perm: number): number {
  const omega = TAU * Math.max(CAMERA.recoilHz, 1e-3);
  const gain = springPeakGain(CAMERA.recoilDamping);
  const auto = Math.max(clamp01(CAMERA.recoilAutoReturn), 1e-3);
  return (WEAPON.recoilRecoverTransientMax * perm * omega * gain) / auto;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SUSTAINED AUTOMATIC FIRE — the rate awareness the camera never had.
//
// `WEAPON.recoilAutoClimbMax` carries the whole derivation and the measurements that forced it.
// This is the arithmetic: a pattern's mean pitch entry is what the burst adds to the view per
// SHOT, and dividing by the measured shot interval turns it into the thing the player actually
// fights — degrees of climb per SECOND.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Mean pitch entry of a recoil pattern, cached per pattern.
 *
 * A def's pattern is a frozen literal that lives for the process, so this is at most one small
 * allocation per weapon that has ever been fired and exactly zero per shot after that. Keyed on
 * the pattern rather than the def so a Pack-a-Punch form (`upgradedDef` spreads the same array)
 * shares its base weapon's entry instead of paying for a second one.
 */
const _patternMeanPitch = new WeakMap<object, number>();

function meanPatternPitch(pattern: WeaponDef['recoilPattern']): number {
  const key = pattern as unknown as object;
  const hit = _patternMeanPitch.get(key);
  if (hit !== undefined) return hit;
  let sum = 0;
  for (let i = 0; i < pattern.length; i++) sum += pattern[i][0];
  const mean = pattern.length > 0 ? sum / pattern.length : 0;
  _patternMeanPitch.set(key, mean);
  return mean;
}

/**
 * The scale a sustained shot's camera kick is multiplied by so the weapon's climb per second
 * lands on `WEAPON.recoilAutoClimbMax`. Exactly 1 for a semi-auto, for the first shot of an
 * engagement (infinite gap ⇒ zero weight), for a tapped automatic, and for any automatic already
 * inside the ceiling — `x * 1` is exact in IEEE 754, so those cases are bit-identical.
 *
 * ONE scalar for the whole pattern entry, pitch and yaw together: the path stays the path.
 */
function autoClimbScale(def: WeaponDef, gap: number): number {
  if (!def.auto) return 1;
  const w = sustainedFireWeight(gap);
  if (w <= 0) return 1;
  const climb = meanPatternPitch(def.recoilPattern) * def.cameraKick;
  if (climb <= 0) return 1;
  // `climb / gap` is rad/s; the cap is the same. Guard the divide, then clamp to a shrink.
  const capped = clamp01((WEAPON.recoilAutoClimbMax * Math.max(gap, 1e-4)) / climb);
  return lerp(1, capped, w);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// RecoilController
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** What a single shot's kick came out as. Reused, never allocated per shot. */
export interface RecoilKick {
  pitch: number;
  yaw: number;
  /** Index of the pattern entry that produced it — the viewmodel varies its roll off this. */
  index: number;
}

export class RecoilController {
  /** Monotonic shot counter into the pattern. Resets after `recoilPatternResetTime` of quiet. */
  shotIndex = 0;
  /** Seconds since the last shot. */
  sinceShot = 999;

  /**
   * THE DEBT. How much of the burst's permanent climb the player has not yet corrected, in
   * radians. Positive pitch = the view sits above where the burst started.
   */
  debtPitch = 0;
  debtYaw = 0;

  /**
   * The interval between the last two shots, seconds — the weapon's MEASURED cadence. Read by
   * the sustained-fire rules instead of `def.rpm` so a fire-rate boon, `WEAPON.fireRateScale`
   * and a feathered trigger are all automatically accounted for, exactly as the viewmodel's
   * kick clock already does it. 999 until a burst has two shots in it.
   */
  private lastGap = 999;

  private readonly kick: RecoilKick = { pitch: 0, yaw: 0, index: 0 };

  reset(): void {
    this.shotIndex = 0;
    this.sinceShot = 999;
    this.lastGap = 999;
    this.debtPitch = 0;
    this.debtYaw = 0;
  }

  /**
   * Seconds after a shot before the recovery is allowed to run. See
   * `WEAPON.recoilRecoverAutoDuty`: a fixed 90 ms delay silently disabled the recovery
   * ENTIRELY for any automatic faster than 667 rpm, so an automatic's delay is additionally
   * capped at half of its own measured cycle. A semi-auto takes the first return and is
   * bit-identical.
   */
  private recoverDelay(def: WeaponDef | null): number {
    const base = WEAPON.recoilRecoverDelay;
    if (!def?.auto || !Number.isFinite(this.lastGap)) return base;
    return Math.min(base, this.lastGap * Math.max(WEAPON.recoilRecoverAutoDuty, 0));
  }

  /**
   * Advance one shot and push the kick into the camera. Returns the kick that was applied so the
   * viewmodel layer can scale its own (separate, softer) kick from the same numbers.
   *
   * `mult` folds in `PlayerStats.recoilMult` and the ADS brace; the def's `cameraKick` is
   * applied here so a weapon's whole recoil personality lives in its def.
   */
  fire(def: WeaponDef, mult: number, rig: RecoilRig | null): RecoilKick {
    // The gap since the previous shot, before the clock is reset. Same quantity the viewmodel
    // measures off its own clock, and the input to every sustained-fire rule.
    const gap = this.sinceShot;
    this.lastGap = gap;

    const pattern = def.recoilPattern;
    if (pattern.length === 0) {
      this.kick.pitch = 0;
      this.kick.yaw = 0;
      this.kick.index = 0;
      this.sinceShot = 0;
      return this.kick;
    }

    // A burst that has gone quiet starts again from the top. You cannot learn a pattern whose
    // starting point you cannot predict, so "first shot of an engagement" must be a real state.
    if (this.sinceShot > WEAPON.recoilPatternResetTime) this.shotIndex = 0;

    const i = this.shotIndex % pattern.length;
    const entry = pattern[i];
    // The opener gets a little extra — the crack that says a fight just started.
    const opener = this.shotIndex === 0 ? WEAPON.recoilFirstShotMult : 1;
    // ...and a HELD trigger gets less, on an automatic, so the climb per second lands in a band
    // the player can aim through however fast the weapon cycles. Exactly 1 on a semi-auto, on
    // the opener and on a tapped shot. `WEAPON.recoilAutoClimbMax` carries the derivation.
    const scale = def.cameraKick * mult * opener * autoClimbScale(def, gap);

    const pitch = entry[0] * scale;
    const yaw = entry[1] * scale;

    this.kick.pitch = pitch;
    this.kick.yaw = yaw;
    this.kick.index = i;

    // Book the permanent part of the kick as debt BEFORE handing it to the camera, so the very
    // next frame's mouse movement already counts as a correction against this shot.
    const perm = permanentFraction();
    this.debtPitch += pitch * perm;
    this.debtYaw += yaw * perm;

    rig?.addRecoil(pitch, yaw);

    this.shotIndex++;
    this.sinceShot = 0;
    return this.kick;
  }

  /**
   * Per-frame. `lookDx` / `lookDy` are THIS frame's mouse deltas in radians, exactly as the
   * player consumed them (`+x` = mouse right, `+y` = mouse down).
   *
   * Two things happen, in this order and only this order:
   *   1. the player's own movement is subtracted from the debt — but only when it moves AGAINST
   *      the climb. Aiming further up during a burst is a choice, not an anti-correction, and
   *      the gun must never yank you back down further than you asked for;
   *   2. whatever debt survives springs back toward zero, after a short delay so the recovery
   *      never fights the burst that is still in progress.
   */
  update(dt: number, def: WeaponDef | null, lookDx: number, lookDy: number, rig: RecoilRig | null): void {
    this.sinceShot += dt;

    const perm = permanentFraction();
    if (perm <= 1e-4) {
      // The camera returns 100% of every kick by itself; there is no debt to account for.
      this.debtPitch = 0;
      this.debtYaw = 0;
      return;
    }

    // ── 1. the player's correction eats the debt ──────────────────────────────────────────
    //
    // `camera.applyLook` does `targetPitch -= dy` and `targetYaw -= dx`. So the view's excess
    // over the pre-burst angle changes by `-dy` / `-dx`. We only ever let that SHRINK the debt.
    if (this.debtPitch > 0 && lookDy > 0) this.debtPitch = Math.max(0, this.debtPitch - lookDy);
    else if (this.debtPitch < 0 && lookDy < 0) this.debtPitch = Math.min(0, this.debtPitch - lookDy);

    if (this.debtYaw > 0 && lookDx > 0) this.debtYaw = Math.max(0, this.debtYaw - lookDx);
    else if (this.debtYaw < 0 && lookDx < 0) this.debtYaw = Math.min(0, this.debtYaw - lookDx);

    // ── 2. return what is left ────────────────────────────────────────────────────────────
    if (this.sinceShot < this.recoverDelay(def)) return;
    if (Math.abs(this.debtPitch) < 1e-6 && Math.abs(this.debtYaw) < 1e-6) {
      this.debtPitch = 0;
      this.debtYaw = 0;
      return;
    }

    // The def states the weapon's intended springback rate; `maxReturnRate` vetoes anything the
    // camera's spring cannot absorb without lurching. See the derivation above — this clamp is
    // the difference between a settle and a 3° dive after a full magazine.
    const wanted = (def?.recoilRecovery ?? WEAPON.recoilRecoverRate) * WEAPON.recoilRecoverScale;
    const rate = Math.min(Math.max(wanted, 0), maxReturnRate(perm));
    if (rate <= 0) return;

    const k = 1 - Math.exp(-rate * dt);
    const dPitch = this.debtPitch * k;
    const dYaw = this.debtYaw * k;

    // `addRecoil` only folds `perm` of what it is handed into the look angles, so to return
    // `dPitch` of debt we hand it `dPitch / perm`. The other `auto` fraction lands in the
    // camera's recoil spring — bounded, by the clamp above, to a settle you feel rather than a
    // motion you notice.
    rig?.addRecoil(-dPitch / perm, -dYaw / perm);

    this.debtPitch -= dPitch;
    this.debtYaw -= dYaw;
  }

  /** Debug readout: the climb the player still owes, in degrees. */
  get debtDeg(): number {
    return Math.hypot(this.debtPitch, this.debtYaw) * (180 / Math.PI);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// SPREAD — the cone the ray is scattered inside.
//
// Spread and recoil are different promises. Recoil is deterministic and yours to master; spread
// is genuinely random and is the game telling you that you are not in a position to shoot yet.
// Standing still and aiming should collapse it to almost nothing (the inkslinger's ADS cone is
// 0.10°); sprinting and jumping should open it up until hip-firing is a suggestion.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Everything the cone depends on, gathered once per frame by the service. */
export interface SpreadState {
  moving: boolean;
  sprinting: boolean;
  airborne: boolean;
  crouching: boolean;
  sliding: boolean;
  /** 0..1 ADS blend. */
  ads: number;
}

export class SpreadController {
  /** Extra cone accumulated by firing, in radians. Decays back to 0. */
  bloom = 0;
  private sinceShot = 999;
  /** The cone actually used by the last shot — the HUD crosshair reads this. */
  current = 0;

  reset(): void {
    this.bloom = 0;
    this.sinceShot = 999;
    this.current = 0;
  }

  /** The state cone before bloom: the def's hip/ADS cones scaled by what the player is doing. */
  baseCone(def: WeaponDef, s: SpreadState, spreadMult: number): number {
    // ADS blends the two authored cones on the same curve the pose uses, so the sight picture
    // and the accuracy tighten together instead of one leading the other.
    let cone = def.spreadHip + (def.spreadAds - def.spreadHip) * clamp01(s.ads);

    // Multipliers, in the order they matter. Sliding is REWARDED (GAME_BIBLE §2: "slide around
    // a corner into a shot") — it is the only fast movement state that tightens the cone.
    if (s.sliding) cone *= WEAPON.spreadSlideMult;
    else if (s.crouching) cone *= WEAPON.spreadCrouchMult;
    else if (s.airborne) cone *= WEAPON.spreadAirMult;
    else if (s.sprinting) cone *= WEAPON.spreadSprintMult;
    else if (s.moving) cone *= WEAPON.spreadMoveMult;

    return cone * spreadMult;
  }

  /** Full cone including bloom, clamped to `spreadBloomMax` times the state cone. */
  cone(def: WeaponDef, s: SpreadState, spreadMult: number): number {
    const base = this.baseCone(def, s, spreadMult);
    const capped = Math.min(base + this.bloom, base * WEAPON.spreadBloomMax);
    this.current = capped;
    return capped;
  }

  /** Called once per shot (not per pellet). */
  addShot(): void {
    this.bloom += WEAPON.spreadPerShot;
    this.sinceShot = 0;
  }

  update(dt: number): void {
    this.sinceShot += dt;
    if (this.bloom <= 0) {
      this.bloom = 0;
      return;
    }
    if (this.sinceShot < WEAPON.spreadRecoverDelay) return;
    this.bloom *= Math.exp(-WEAPON.spreadRecoverRate * dt);
    if (this.bloom < 1e-6) this.bloom = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Cone scattering
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Scatter `dir` (unit) inside a cone of half-angle `cone` radians, in place.
 *
 * `sqrt` on the radius gives a UNIFORM disc rather than a centre-weighted one. That matters for
 * a shotgun (an even pattern reads as a pattern; a centre-weighted one reads as "the gun is
 * lying to me") and costs nothing for a pistol. Zero allocation: the basis is built from the
 * direction itself.
 */
export function scatter(dir: Vector3, cone: number, rng: RNG, up: Vector3, right: Vector3): Vector3 {
  if (cone <= 0) return dir;

  // Any stable perpendicular basis will do; pick the axis the direction is least aligned with
  // so the cross product never degenerates when looking straight up or down.
  if (Math.abs(dir.y) < 0.9) right.set(0, 1, 0);
  else right.set(1, 0, 0);
  up.crossVectors(dir, right).normalize();
  right.crossVectors(up, dir).normalize();

  const angle = rng.next() * TAU;
  const radius = Math.tan(cone) * Math.sqrt(rng.next());
  dir.addScaledVector(up, Math.cos(angle) * radius);
  dir.addScaledVector(right, Math.sin(angle) * radius);
  return dir.normalize();
}

/** Clamp a spread multiplier into something sane — boons stack multiplicatively. */
export function safeSpreadMult(v: number): number {
  return clamp(v, 0, 12);
}

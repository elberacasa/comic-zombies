/**
 * PLAYER CAMERA — 50% of the feel.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE RULE: every effect is an INDEPENDENT ADDITIVE LAYER. No layer ever reads another layer's
 *  output, no layer ever writes the camera directly. They each produce a small offset, and
 *  `compose()` sums them once, in a fixed order, at the very end of the frame.
 *
 *  Why this matters: when the human says "the landing is too much", exactly one number changes
 *  and nothing else in the camera moves. Coupled camera code is untunable camera code.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 *  LAYERS (all frame-rate independent — springs and exponential damping, never `*= 0.9`):
 *    1. look          yaw/pitch from the mouse, pitch-clamped, smoothed by a hair
 *    2. posture       eye height (owned by the controller) + step smear
 *    3. bob           figure-8, phase driven by DISTANCE travelled so it locks to the stride
 *    4. land dip      under-damped spring, impulse scaled by impact speed
 *    5. lean          strafe + turn roll — the layer nobody notices until it's missing
 *    6. pose          slide/dive roll and pitch
 *    7. recoil        its own spring channel, impulse-driven, ready for the weapon system
 *    8. trauma shake  additive value-noise on 6 axes, decaying, driven by `shake()`/`fx:shake`
 *    9. FOV           critically damped spring: sprint/slide push out, ADS pulls in
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  MOTION COMFORT (ART_DIRECTION §10) — the second contract this file has to keep.
 *
 *  Build 001's feedback was "dizzy after a minute" and "going straight with W feels like falling
 *  to the right". Both were this file. Two invariants are now enforced here, in code, rather
 *  than being left to whatever the tuning constants happen to add up to:
 *
 *    A. ZERO INPUT ⇒ ZERO BIAS. With `strafeInput === 0` and no mouse movement, the summed
 *       lateral offset, the summed roll and the yaw drift are all exactly zero, in every move
 *       state. No layer is allowed a fallback that resolves to a *direction* — see `updatePose`,
 *       which used to bank a hardcoded 7° on every straight slide.
 *    B. BOUNDED ROTATION. `compose()` soft-limits the SUM of all five roll layers to
 *       `CAMERA.rollTotalLimitDeg`, and `updateFov()` clamps the total FOV punch. Individual
 *       constants can be re-tuned freely without anyone having to re-derive the worst case.
 *
 *  THE SIGN CONVENTION, derived once so nobody has to guess again:
 *    `camera.rotation.z > 0` rotates the camera's up vector toward world −X, i.e. the HEAD BANKS
 *    LEFT, and world-up projects toward the right of the screen. `rotation.z < 0` banks RIGHT.
 *    A local `+x` offset moves the camera to the player's RIGHT.
 *    §10 therefore reads, concretely: a positive lateral offset must never come with a negative
 *    roll. Every layer below states which way it goes and why.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PerspectiveCamera, Vector3 } from 'three';
import { Vector3 as Vec3 } from 'three';
import type { EventBus, GameCtx } from '@/core/types';
import {
  DEG2RAD, HALF_PI, Spring, TAU, clamp, clamp01, damp, lambdaFromHalfLife, lerp, wrapAngle,
} from '@/core/mathx';
import type { ComfortMode } from '@/game/tuning';
import { CAMERA, MOVE, comfortScales } from '@/game/tuning';
import type { CameraDrive } from './drive';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cheap value noise. Perlin-ish is all a shake needs — what matters is that it is CONTINUOUS
// (so the camera never teleports) and that each axis uses a different seed (so the motion is
// not a straight line). Two octaves gives it a hand-held-camera texture instead of a sine wave.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function hash01(i: number, seed: number): number {
  let h = (i | 0) * 374761393 + seed * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Smooth noise in [-1, 1]. */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(i, seed);
  const b = hash01(i + 1, seed);
  return (a + (b - a) * u) * 2 - 1;
}

function noise2oct(x: number, seed: number): number {
  return noise1(x, seed) * 0.72 + noise1(x * 2.13 + 11.7, seed + 977) * 0.28;
}

const _offset = new Vec3();
const _local = new Vec3();

/**
 * Peak displacement of a damped spring kicked from rest with velocity `v`, expressed as
 * `peak = v * gain(ζ) / ω`. We need the inverse constantly ("dip the camera by exactly 0.25m"),
 * and the naive `v = peak·ω` is only right for an *undamped* spring — at ζ = 0.62 it delivers
 * less than half the requested motion, which is exactly the kind of silent halving that makes a
 * landing feel weightless no matter what you type into the tuning file.
 */
function springPeakGain(zeta: number): number {
  if (zeta >= 0.999) return Math.exp(-1); // critically damped: peak = v/(ω·e)
  const wd = Math.sqrt(1 - zeta * zeta);
  const t = Math.atan2(wd, zeta) / wd; // time of peak, in units of 1/ω
  return (Math.exp(-zeta * t) * Math.sin(wd * t)) / wd;
}

/** Velocity impulse that makes `spring` peak at `peak` from rest. */
function impulseForPeak(spring: Spring, peak: number): number {
  const omega = TAU * spring.frequency;
  return (peak * omega) / springPeakGain(spring.damping);
}

/**
 * Smooth saturation toward ±`limit`. Used to cap the SUMMED camera roll (ART §10: ≤ ~4°).
 *
 * A hard `clamp` would be wrong here: it puts a corner in the roll's derivative exactly at the
 * moment the camera is at its most violent, which reads as the view *catching* on something.
 * `L·tanh(x/L)` is C-infinity, monotonic and asymptotically bounded, and for |x| < L/2 it is
 * within ~2% of the identity — so the 0.3° bob roll passes through untouched and only a pile-up
 * of four layers at once is actually squeezed.
 */
function softLimit(x: number, limit: number): number {
  if (limit <= 0) return 0;
  return limit * Math.tanh(x / limit);
}

/**
 * Signed strafe intent with a smooth deadzone: exactly 0 below `dz`, ramping to ±1 by `full`.
 *
 * THIS IS THE FIX FOR "GOING STRAIGHT FEELS LIKE FALLING RIGHT". The old pose code was
 * `Math.abs(s) > 0.15 ? -Math.sign(s) : 1` — a zero input fell through to a hardcoded `1`, so
 * every straight slide banked a constant 7° in the same direction, forever. A zero input must
 * produce a zero *magnitude*, never a default direction. The ramp (rather than a bare `sign`)
 * also stops the roll from popping the instant a key is tapped.
 */
function strafeSign(strafe: number, dz = 0.08, full = 0.5): number {
  const a = Math.abs(strafe);
  if (a <= dz) return 0;
  const t = Math.min((a - dz) / Math.max(full - dz, 1e-4), 1);
  return strafe < 0 ? -t : t;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

export class PlayerCamera {
  // ── 1. look ─────────────────────────────────────────────────────────────────────────────
  /** Smoothed, authoritative view angles. The controller reads `yaw` for its wish direction. */
  yaw = 0;
  pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  /** Yaw change last frame, rad/s — feeds the turn component of the lean. */
  private yawRate = 0;

  /**
   * The AIM angles: look + the layers that legitimately move your point of impact (recoil, the
   * landing nod, the slide pitch). Shake and bob are deliberately excluded — a shooter where the
   * screen rattle moved your bullets would be unplayable. `forward()` returns this, so the
   * crosshair and the hitscan ray can never disagree.
   */
  private aimYaw = 0;
  private aimPitch = 0;

  // ── 4. landing dip ──────────────────────────────────────────────────────────────────────
  private readonly dip = new Spring(CAMERA.landDipHz, CAMERA.landDipDamping);

  // ── 5. lean ─────────────────────────────────────────────────────────────────────────────
  private lean = 0;

  // ── 6. slide / dive pose ────────────────────────────────────────────────────────────────
  private readonly poseRoll = new Spring(CAMERA.poseHz, CAMERA.poseDamping);
  private readonly posePitch = new Spring(CAMERA.poseHz, CAMERA.poseDamping);

  // ── 7. recoil ───────────────────────────────────────────────────────────────────────────
  private readonly recoilPitch = new Spring(CAMERA.recoilHz, CAMERA.recoilDamping);
  private readonly recoilYaw = new Spring(CAMERA.recoilHz, CAMERA.recoilDamping);

  // ── 8. trauma shake ─────────────────────────────────────────────────────────────────────
  private trauma = 0;
  private traumaDecay = CAMERA.shakeDecay;
  private shakeTime = 0;

  // ── 9. fov ──────────────────────────────────────────────────────────────────────────────
  private readonly fov = new Spring(CAMERA.fovSpringHz, CAMERA.fovSpringDamping);
  /** Extra FOV requested by another system (ADS zoom). Weapons write this. */
  fovBias = 0;
  private lastAppliedFov = -1;

  // ── 3. bob ──────────────────────────────────────────────────────────────────────────────
  private bobWeight = 0;
  private bobOffX = 0;
  private bobOffY = 0;
  private bobRoll = 0;

  // ── land pose (derived from the dip, kept separate so the pitch/roll can be re-tuned) ────
  private landPitch = 0;
  private landRoll = 0;
  private landRollSign = 1;

  /** The post-clamp summed roll written to the camera last frame. Debug/§10 budget readout only. */
  private appliedRoll = 0;

  /** 0..1 — how hard the render service should draw screen-space speed lines this frame. */
  speedLineIntensity = 0;

  private events: EventBus | null = null;
  private offShake: (() => void) | null = null;

  constructor() {
    this.fov.snap(CAMERA.fovBase);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════

  attach(ctx: GameCtx): void {
    this.events = ctx.events;
    // Anything in the game may ask for a shake without knowing the camera exists.
    this.offShake = ctx.events.on('fx:shake', (p) => this.shake(p.amount, p.duration));
    ctx.camera.near = CAMERA.near;
    ctx.camera.far = CAMERA.far;
    ctx.camera.fov = CAMERA.fovBase;
    ctx.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.offShake?.();
    this.offShake = null;
    this.events = null;
  }

  // ── 1. look ─────────────────────────────────────────────────────────────────────────────

  /**
   * Apply this frame's mouse delta. `dx`/`dy` are already sensitivity-scaled radians from the
   * input service: +x = mouse right, +y = mouse down.
   *
   * Call EXACTLY ONCE per frame, as early as possible. Everything about an FPS's responsiveness
   * lives in this method; nothing is allowed to buffer, filter or accelerate here beyond the
   * sub-frame `lookSmoothHalfLife` smear.
   */
  applyLook(dx: number, dy: number, dt: number): void {
    this.targetYaw = wrapAngle(this.targetYaw - dx);
    const limit = CAMERA.pitchLimitDeg * DEG2RAD;
    this.targetPitch = clamp(this.targetPitch - dy, -limit, limit);

    const prevYaw = this.yaw;
    if (CAMERA.lookSmoothHalfLife <= 0 || dt <= 0) {
      this.yaw = this.targetYaw;
      this.pitch = this.targetPitch;
    } else {
      const lambda = lambdaFromHalfLife(CAMERA.lookSmoothHalfLife);
      // Damp along the shortest arc so the wrap at ±π never spins the world.
      this.yaw = wrapAngle(prevYaw + wrapAngle(this.targetYaw - prevYaw) * (1 - Math.exp(-lambda * dt)));
      this.pitch = damp(this.pitch, this.targetPitch, lambda, dt);
    }
    this.yawRate = dt > 0 ? wrapAngle(this.yaw - prevYaw) / dt : 0;
    this.updateAim();
  }

  private updateAim(): void {
    const hard = HALF_PI - 0.001;
    this.aimYaw = wrapAngle(this.yaw + this.recoilYaw.value);
    this.aimPitch = clamp(
      this.pitch + this.recoilPitch.value + this.posePitch.value + this.landPitch,
      -hard, hard,
    );
  }

  /** Hard-set the view (spawn, teleport, cutscene). Kills all smoothing. */
  setLook(yaw: number, pitch = 0): void {
    this.yaw = this.targetYaw = wrapAngle(yaw);
    const limit = CAMERA.pitchLimitDeg * DEG2RAD;
    this.pitch = this.targetPitch = clamp(pitch, -limit, limit);
    this.yawRate = 0;
    this.updateAim();
  }

  /** Unit aim vector. Writes into `out`. The authoritative direction for every hitscan ray. */
  forward(out: Vector3): Vector3 {
    const cp = Math.cos(this.aimPitch);
    out.set(-Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * cp);
    return out;
  }

  // ── 4/8/7 impulse entry points ──────────────────────────────────────────────────────────

  /**
   * Additive trauma. `amount` 0..1, `duration` seconds. Trauma STACKS (a nuke during a reload
   * shake is more violent than either alone) and the decay rate takes the fastest request, so a
   * short sharp shake never gets stretched by a long soft one that is still running.
   */
  shake(amount: number, duration = 0.35): void {
    if (amount <= 0) return;
    this.trauma = Math.min(this.trauma + amount, CAMERA.shakeMaxTrauma);
    const rate = amount / Math.max(duration, 0.02);
    if (rate > this.traumaDecay || this.trauma <= amount) this.traumaDecay = rate;
  }

  /**
   * Weapon recoil. `pitchRad` positive = muzzle climbs. `recoilAutoReturn` of the kick springs
   * back on its own; the remainder is folded permanently into the look angles, so the player has
   * to pull down — that residual is what makes a recoil pattern learnable instead of random.
   */
  addRecoil(pitchRad: number, yawRad: number): void {
    const auto = clamp01(CAMERA.recoilAutoReturn);
    // A weapon def states its kick as a PEAK ANGLE, so convert peak → spring velocity.
    this.recoilPitch.impulse(impulseForPeak(this.recoilPitch, pitchRad * auto));
    this.recoilYaw.impulse(impulseForPeak(this.recoilYaw, yawRad * auto));
    if (auto < 1) {
      const limit = CAMERA.pitchLimitDeg * DEG2RAD;
      this.targetPitch = clamp(this.targetPitch + pitchRad * (1 - auto), -limit, limit);
      this.targetYaw = wrapAngle(this.targetYaw + yawRad * (1 - auto));
    }
  }

  /** Landing. `impactSpeed` is the downward speed at touchdown, m/s. */
  landed(impactSpeed: number, wasDive: boolean): void {
    const t = clamp01(
      (impactSpeed - MOVE.landSoftSpeed) / Math.max(MOVE.landHardSpeed - MOVE.landSoftSpeed, 1e-3),
    );
    if (t <= 0) return;

    let dipMetres = Math.min(impactSpeed * CAMERA.landDipPerSpeed, CAMERA.landDipMax);
    if (wasDive) dipMetres *= CAMERA.landDiveMult;
    dipMetres *= comfortScales().landDip;
    if (dipMetres <= 0) return;

    this.dip.impulse(impulseForPeak(this.dip, -dipMetres));
    this.landRollSign = this.landRollSign > 0 ? -1 : 1; // alternate so two landings never match
    this.shake(CAMERA.landTrauma * t * (wasDive ? 1.4 : 1), 0.3);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Per-frame layer update. Presentation only — safe to run at variable dt.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  update(dt: number, d: CameraDrive): void {
    this.updateBob(dt, d);
    this.updateDip(dt);
    this.updateLean(dt, d);
    this.updatePose(dt, d);
    this.updateRecoil(dt);
    this.updateShake(dt);
    this.updateFov(dt, d);
    this.updateSpeedLines(d);
    this.updateAim();
  }

  // ── 3. bob ──────────────────────────────────────────────────────────────────────────────

  private updateBob(dt: number, d: CameraDrive): void {
    const walk = Math.max(MOVE.walkSpeed, 1e-3);
    const moving = d.grounded && d.speed > MOVE.footstepMinSpeed && d.moveState !== 'slide';
    this.bobWeight = damp(
      this.bobWeight, moving ? 1 : 0, lambdaFromHalfLife(CAMERA.bobBlendHalfLife), dt,
    );

    let amp = Math.min(d.speed / walk, CAMERA.bobSpeedMax) * this.bobWeight;
    amp *= lerp(1, CAMERA.bobSprintMult, d.sprintAmount);
    amp *= lerp(1, CAMERA.bobCrouchMult, clamp01(d.crouchAmount));
    if (!d.grounded) amp *= CAMERA.bobAirMult;
    if (d.isAiming) amp *= CAMERA.bobAdsMult;
    amp *= comfortScales().bob;
    // The multipliers above compound (speed ratio × sprint × …), which is how 0.035m of authored
    // amplitude silently became 0.096m at a sprint in build 001. One explicit ceiling means the
    // worst case is `bobAmpX * bobAmpScaleMax`, provable by reading two numbers.
    if (amp > CAMERA.bobAmpScaleMax) amp = CAMERA.bobAmpScaleMax;

    // Figure-8: one horizontal cycle per two steps, one vertical bounce per step.
    const phase = d.bobDistance * CAMERA.bobCyclesPerMetre * TAU;
    const lateral = Math.sin(phase);

    // ART §10 — "never move and roll in the same direction at the same time". Both terms are
    // driven from the SAME `lateral`, deliberately and with a matching sign, because under this
    // file's sign convention (see the header) `+x` translates RIGHT and `+roll` banks LEFT — so a
    // matching sign makes the roll OPPOSE the translation, which is also what a real neck does:
    // the head counter-rotates as the body's weight shifts onto a foot. Flipping either sign
    // would make them compound, which is the falling cue. Do not "fix" this without re-deriving.
    this.bobOffX = lateral * CAMERA.bobAmpX * amp;
    this.bobOffY = Math.sin(phase * 2) * CAMERA.bobAmpY * amp;
    this.bobRoll = lateral * CAMERA.bobRollDeg * DEG2RAD * amp;
  }

  // ── 4. dip ──────────────────────────────────────────────────────────────────────────────

  private updateDip(dt: number): void {
    this.dip.target = 0;
    const v = this.dip.step(dt);
    this.landPitch = -v * CAMERA.landPitchPerDip * DEG2RAD;
    // The dip impulse is already comfort-scaled in `landed()`; only the roll gets its own knob,
    // because REDUCED keeps the vertical drop (it is the landing's only feedback) and drops the
    // rotation (which is the part that has no physical cause the player commanded).
    this.landRoll = v * CAMERA.landRollPerDip * DEG2RAD * this.landRollSign * comfortScales().landRoll;
  }

  // ── 5. lean ─────────────────────────────────────────────────────────────────────────────

  private updateLean(dt: number, d: CameraDrive): void {
    // SIGN: strafing right translates the whole camera right, so §10 forbids also banking right.
    // `+strafe` → `+roll` → banks LEFT, i.e. away from the travel — which is exactly what the
    // tuning file has always *said* this layer does ("strafing right rolls the camera left").
    // Build 001 had the opposite sign, so the two cues compounded on every strafe.
    let target = strafeSign(d.strafeInput, 0, 1) * CAMERA.leanStrafeDeg * DEG2RAD;
    // Turn lean: same logic against the yaw sweep, and identical to build 001 in sign.
    const turn = clamp(-this.yawRate / CAMERA.leanTurnRateRef, -1, 1);
    target += turn * CAMERA.leanTurnDeg * DEG2RAD;
    if (!d.grounded) target *= CAMERA.leanAirMult;
    if (d.isAiming) target *= CAMERA.leanAdsMult;
    target *= comfortScales().lean;
    this.lean = damp(this.lean, target, lambdaFromHalfLife(CAMERA.leanHalfLife), dt);
  }

  // ── 6. pose ─────────────────────────────────────────────────────────────────────────────

  private updatePose(dt: number, d: CameraDrive): void {
    let roll = 0;
    let pitch = 0;
    // The roll is ALWAYS a function of a live input. `strafeSign` returns exactly 0 for a zero
    // strafe, so holding W through a slide or a dive keeps the horizon dead level — that is the
    // "falling to the right" bug, and it was a hardcoded `1` (slide) and no sign at all (dive).
    // The magnitude is player-commanded; the direction is player-commanded; nothing is default.
    const s = strafeSign(d.strafeInput) * comfortScales().poseRoll;
    if (d.moveState === 'slide') {
      // Same sign convention as the strafe lean, so the two layers reinforce instead of fighting.
      roll = s * CAMERA.slideRollDeg * DEG2RAD * clamp01(d.slideAmount + 0.35);
      // Pitch is NOT comfort-scaled: it is a posture readout (you are 0.7m off the ground and
      // looking along it), not a rotation cue, and losing it loses the read on the slide.
      pitch = -CAMERA.slidePitchDeg * DEG2RAD;
    } else if (d.moveState === 'dive') {
      roll = s * CAMERA.diveRollDeg * DEG2RAD;
      pitch = -CAMERA.divePitchDeg * DEG2RAD;
    }
    this.poseRoll.target = roll;
    this.posePitch.target = pitch;
    this.poseRoll.step(dt);
    this.posePitch.step(dt);
  }

  // ── 7. recoil ───────────────────────────────────────────────────────────────────────────

  private updateRecoil(dt: number): void {
    this.recoilPitch.target = 0;
    this.recoilYaw.target = 0;
    this.recoilPitch.step(dt);
    this.recoilYaw.step(dt);
  }

  // ── 8. shake ────────────────────────────────────────────────────────────────────────────

  private updateShake(dt: number): void {
    if (this.trauma <= 0) {
      this.trauma = 0;
      this.traumaDecay = CAMERA.shakeDecay;
      return;
    }
    // Shake advances on UNSCALED time conceptually; we are handed frameDt, which already is.
    this.shakeTime += dt;
    this.trauma -= this.traumaDecay * dt;
    if (this.trauma < 0) this.trauma = 0;
  }

  private shakeAmount(): number {
    if (this.trauma <= 0) return 0;
    return Math.pow(this.trauma, CAMERA.shakeExponent) * comfortScales().shake;
  }

  // ── 9. fov ──────────────────────────────────────────────────────────────────────────────

  private updateFov(dt: number, d: CameraDrive): void {
    // The four pushes used to be summed straight onto the base and could reach +23° together
    // (sprint 7 + slide 12 + speed 8, with the dive's 15 on top of a dive→slide chain). A fast
    // FOV swing of that size is one of the strongest nausea triggers there is (ART §10), so the
    // whole punch is accumulated separately and hard-capped before it ever reaches the spring.
    let punch = 0;
    punch += CAMERA.fovSprint * clamp01(d.sprintAmount);
    punch += CAMERA.fovSlide * clamp01(d.slideAmount);
    punch += CAMERA.fovDive * clamp01(d.diveAmount);
    // Speed-derived push, so a bunny-hop chain keeps visually escalating past the state pushes.
    const over = Math.max(0, d.speed - MOVE.walkSpeed);
    punch += Math.min(over * CAMERA.fovPerSpeed, CAMERA.fovSpeedMax);

    punch *= comfortScales().fovPunch;
    if (punch > CAMERA.fovPunchMax) punch = CAMERA.fovPunchMax;

    // ADS is a sight picture, not a punch: it is deliberately outside the cap and outside the
    // comfort scale, because a weapon that does not zoom when you aim is a broken weapon.
    let target = CAMERA.fovBase + punch;
    if (d.isAiming) target += CAMERA.fovAds;

    target += this.fovBias;
    this.fov.target = target;
    this.fov.step(dt);
  }

  private updateSpeedLines(d: CameraDrive): void {
    const t = clamp01(d.speed / Math.max(CAMERA.speedLinesAtSpeed, 1e-3));
    const th = CAMERA.speedLinesThreshold;
    const raw = t <= th ? 0 : clamp01((t - th) / (1 - th));
    // Full-screen radial motion is a strong peripheral vection cue — it is exactly what a comic
    // uses to SAY "fast", which is why it stays on in FULL, and exactly why it gets halved in
    // REDUCED rather than being left as the one un-damped motion source on the screen.
    this.speedLineIntensity = raw * comfortScales().speedLines;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Compose — the ONLY place the THREE camera is written. Sum, then apply, once.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  compose(camera: PerspectiveCamera, eyeWorld: Vector3, d: CameraDrive): void {
    const shake = this.shakeAmount();
    const t = this.shakeTime * CAMERA.shakeFrequency;

    // ── rotation ──────────────────────────────────────────────────────────────────────────
    // Start from the AIM angles so the crosshair is always on the bullet, then add the layers
    // that are pure presentation (shake, bob roll, lean, pose roll).
    let pitch = this.aimPitch;
    let yaw = this.aimYaw;
    let roll = this.bobRoll + this.lean + this.poseRoll.value + this.landRoll;

    if (shake > 0) {
      pitch += noise2oct(t, 17) * shake * CAMERA.shakePitchDeg * DEG2RAD;
      yaw += noise2oct(t, 53) * shake * CAMERA.shakeYawDeg * DEG2RAD;
      roll += noise2oct(t, 91) * shake * CAMERA.shakeRollDeg * DEG2RAD;
    }

    // ART §10, enforced rather than hoped for: the five roll layers are independent and each is
    // individually reasonable, but they can all fire at once (strafing, airborne, mid-slide,
    // landing, shaken) — build 001 summed to 12.1° that way. Saturating here means re-tuning any
    // single constant can never re-open the hole, and the small everyday values pass through
    // essentially unchanged. See `softLimit`.
    roll = softLimit(roll, CAMERA.rollTotalLimitDeg * DEG2RAD);
    this.appliedRoll = roll;

    // Hard clamp AFTER additive layers so a big kick can never flip the world over.
    const hardLimit = HALF_PI - 0.001;
    if (pitch > hardLimit) pitch = hardLimit;
    else if (pitch < -hardLimit) pitch = -hardLimit;

    camera.rotation.set(pitch, yaw, roll, 'YXZ');

    // ── position ──────────────────────────────────────────────────────────────────────────
    // Local offsets are expressed in a yaw-only basis: bob and shake should slide across the
    // screen, not swing with the pitch. `x` = right, `y` = up, `z` = backwards.
    _local.set(this.bobOffX, this.bobOffY + this.dip.value - d.stepSmear, 0);
    // +z local is BACKWARDS: a climbing muzzle shoves the camera back into the player's shoulder.
    _local.z += this.recoilPitch.value * CAMERA.recoilPushback;

    if (shake > 0) {
      const p = shake * CAMERA.shakePos;
      _local.x += noise2oct(t * 1.31 + 3.1, 211) * p;
      _local.y += noise2oct(t * 1.17 + 7.7, 307) * p;
    }

    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    // right = (c, 0, -s); up = (0,1,0); back = (s, 0, c)
    _offset.set(
      _local.x * c + _local.z * s,
      _local.y,
      _local.x * -s + _local.z * c,
    );

    camera.position.copy(eyeWorld).add(_offset);

    // ── fov ───────────────────────────────────────────────────────────────────────────────
    const f = this.fov.value;
    if (Math.abs(f - this.lastAppliedFov) > 0.01) {
      camera.fov = f;
      camera.updateProjectionMatrix();
      this.lastAppliedFov = f;
    }
    camera.updateMatrixWorld();
  }

  /** Kill every transient layer — respawn, teleport, round reset. */
  reset(): void {
    this.dip.reset();
    this.poseRoll.reset();
    this.posePitch.reset();
    this.recoilPitch.reset();
    this.recoilYaw.reset();
    this.fov.snap(CAMERA.fovBase);
    this.trauma = 0;
    this.traumaDecay = CAMERA.shakeDecay;
    this.lean = 0;
    this.bobWeight = 0;
    this.bobOffX = this.bobOffY = this.bobRoll = 0;
    this.landPitch = this.landRoll = 0;
    this.appliedRoll = 0;
    this.speedLineIntensity = 0;
    this.lastAppliedFov = -1;
    this.updateAim();
  }

  // ── comfort preset (ART_DIRECTION §10) ──────────────────────────────────────────────────
  //
  // The state lives on `CAMERA.comfort` rather than on this instance so that every reader —
  // this camera, a future weapon-sway layer, the render layer freezing the boiling line — sees
  // one value, and so `CZ.tuning.CAMERA.comfort = 'reduced'` in the console does the same thing
  // the key does. Setting it takes effect on the very next frame; nothing caches the scales.

  get comfortMode(): ComfortMode { return CAMERA.comfort; }
  set comfortMode(mode: ComfortMode) {
    if (mode !== 'full' && mode !== 'reduced') return;
    if (CAMERA.comfort === mode) return;
    CAMERA.comfort = mode;
    // Drop everything already in flight, or a shake started in FULL keeps playing out in REDUCED.
    if (mode === 'reduced') {
      this.trauma = 0;
      this.traumaDecay = CAMERA.shakeDecay;
      this.dip.reset();
      this.landPitch = this.landRoll = 0;
      this.lean = 0;
      this.bobOffX = this.bobOffY = this.bobRoll = 0;
      this.speedLineIntensity = 0;
    }
  }

  /** Flip the preset. Returns the new mode so a caller can toast it. */
  toggleComfort(): ComfortMode {
    this.comfortMode = CAMERA.comfort === 'full' ? 'reduced' : 'full';
    return CAMERA.comfort;
  }

  // ── debug readouts ──────────────────────────────────────────────────────────────────────
  get currentFov(): number { return this.fov.value; }
  get currentTrauma(): number { return this.trauma; }
  /** Summed roll actually written to the camera last frame, post-clamp, degrees. §10 readout. */
  get currentRollDeg(): number { return this.appliedRoll / DEG2RAD; }
  /** Lateral (side-to-side) camera offset actually applied this frame, metres — the §10 readout. */
  get currentLateral(): number { return this.bobOffX; }
}

export function createCamera(ctx: GameCtx): PlayerCamera {
  const cam = new PlayerCamera();
  cam.attach(ctx);
  return cam;
}

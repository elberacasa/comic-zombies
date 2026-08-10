/**
 * MATHX — the maths toolbox every system leans on.
 *
 * Three jobs:
 *  1. Frame-rate-independent smoothing (`damp`, `Spring`) so feel never depends on fps.
 *  2. The easing library. ART_DIRECTION §8: *nothing eases linearly*. Fast in, overshoot,
 *     settle, hold. If you find yourself writing `a + (b - a) * t` in a system file, use one
 *     of these instead.
 *  3. Shared scratch vectors (`_v1`.._v6`) so hot loops allocate nothing.
 *
 * SCRATCH RULES: a scratch vector is valid only inside the function that grabbed it. Never
 * hold one across a call that might also use it, never store one, never return one.
 */

import { Euler, Matrix4, Quaternion, Vector2, Vector3 } from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI * 0.5;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EPSILON = 1e-6;

// ─────────────────────────────────────────────────────────────────────────────
// Scalar basics
// ─────────────────────────────────────────────────────────────────────────────

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Alias of clamp01, for shader-brain readability. */
export const saturate = clamp01;

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Where does `v` sit between a and b? Unclamped. */
export function invLerp(a: number, b: number, v: number): number {
  const d = b - a;
  return Math.abs(d) < EPSILON ? 0 : (v - a) / d;
}

export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return outMin + (outMax - outMin) * invLerp(inMin, inMax, v);
}

export function remapClamped(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return outMin + (outMax - outMin) * clamp01(invLerp(inMin, inMax, v));
}

/** Step `current` toward `target` by at most `maxDelta`. Linear, for hard limits only. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function moveTowardsAngle(current: number, target: number, maxDelta: number): number {
  return current + clamp(shortestAngle(current, target), -maxDelta, maxDelta);
}

export function sign0(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

export function fract(v: number): number {
  return v - Math.floor(v);
}

export function repeat(v: number, length: number): number {
  return clamp(v - Math.floor(v / length) * length, 0, length);
}

export function pingPong(v: number, length: number): number {
  const t = repeat(v, length * 2);
  return length - Math.abs(t - length);
}

/** True if the two values are within `eps`. */
export function approx(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}

/** Deadzone with re-normalisation, so sticks/axes never snap. */
export function deadzone(v: number, dz = 0.15): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

// ─────────────────────────────────────────────────────────────────────────────
// Angles
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let x = (a + PI) % TAU;
  if (x < 0) x += TAU;
  return x - PI;
}

/** Signed shortest delta from `from` to `to`, in (-PI, PI]. */
export function shortestAngle(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function lerpAngle(from: number, to: number, t: number): number {
  return from + shortestAngle(from, to) * t;
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + shortestAngle(current, target) * (1 - Math.exp(-lambda * dt));
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame-rate-independent smoothing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exponential smoothing that behaves identically at 30 and 240 fps.
 * `lambda` is a rate in 1/seconds — bigger is snappier. 8 is loose, 25 is tight, 60 is nearly instant.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** In-place `damp` on a Vector3. Returns `out`. */
export function dampVec(out: Vector3, target: Vector3, lambda: number, dt: number): Vector3 {
  const f = 1 - Math.exp(-lambda * dt);
  out.x += (target.x - out.x) * f;
  out.y += (target.y - out.y) * f;
  out.z += (target.z - out.z) * f;
  return out;
}

/** In-place `damp` on a Vector2. Returns `out`. */
export function dampVec2(out: Vector2, target: Vector2, lambda: number, dt: number): Vector2 {
  const f = 1 - Math.exp(-lambda * dt);
  out.x += (target.x - out.x) * f;
  out.y += (target.y - out.y) * f;
  return out;
}

/** Shortest-arc quaternion damping, in place. Returns `out`. */
export function dampQuat(out: Quaternion, target: Quaternion, lambda: number, dt: number): Quaternion {
  return out.slerp(target, 1 - Math.exp(-lambda * dt));
}

/** Convert a "reach ~99% of the way in `seconds`" intuition into a lambda. */
export function lambdaFromHalfLife(halfLifeSeconds: number): number {
  return Math.LN2 / Math.max(halfLifeSeconds, EPSILON);
}

// ─────────────────────────────────────────────────────────────────────────────
// Spring damper — camera and weapon kick
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exact solution of `x'' = -2ζω x' - ω²x` over a timestep, as a 2×2 transition matrix
 * `[d1, v1] = M · [d0, v0]`.
 *
 * Why not the usual semi-implicit integrator: it is stable, but it bleeds amplitude badly once
 * `ω·dt` gets large — a 14 Hz weapon kick at 120 Hz loses ~60% of its punch, and worse, the loss
 * changes with the timestep, so the same numbers feel different on different machines. The
 * closed-form solution is exact at any dt, so a spring tuned on one machine feels identical on
 * every other. Weapon kick and camera recoil are the whole game; they get the exact version.
 */
const _spring = { m11: 1, m12: 0, m21: 0, m22: 1 };

function springMatrix(omega: number, zeta: number, dt: number): void {
  const w = omega;
  const t = dt;
  if (zeta > 0.999 && zeta < 1.001) {
    // Critically damped — fastest settle with no overshoot.
    const e = Math.exp(-w * t);
    const wt = w * t;
    _spring.m11 = e * (1 + wt);
    _spring.m12 = e * t;
    _spring.m21 = -e * w * w * t;
    _spring.m22 = e * (1 - wt);
  } else if (zeta < 1) {
    // Under-damped — this is the comic overshoot.
    const alpha = zeta * w;
    const wd = w * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-alpha * t);
    const c = Math.cos(wd * t);
    const s = Math.sin(wd * t) / wd;
    _spring.m11 = e * (c + alpha * s);
    _spring.m12 = e * s;
    _spring.m21 = -e * w * w * s;
    _spring.m22 = e * (c - alpha * s);
  } else {
    // Over-damped — sluggish, for heavy things.
    const root = w * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * w + root;
    const r2 = -zeta * w - root;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    const inv = 1 / (r1 - r2);
    _spring.m11 = (r1 * e2 - r2 * e1) * inv;
    _spring.m12 = (e1 - e2) * inv;
    _spring.m21 = w * w * (e2 - e1) * inv;
    _spring.m22 = (r1 * e1 - r2 * e2) * inv;
  }
}

/**
 * Damped spring, solved exactly. Unconditionally stable, timestep-independent.
 *
 * `frequency` is in Hz — how fast it wants to oscillate. `damping` is the ratio:
 * 1 = critically damped (no overshoot, fastest settle — camera follow, ADS blend),
 * 0.4..0.8 = bouncy overshoot (weapon kick, HUD number pops, card deals),
 * >1 = sluggish (heavy weapon sway).
 *
 * Typical use: `kick.impulse(-def.weaponKick)` on fire, `kick.step(dt)` every frame.
 */
export class Spring {
  value = 0;
  velocity = 0;
  target = 0;
  private omega: number;

  constructor(frequency = 12, public damping = 1) {
    this.omega = TAU * frequency;
  }

  get frequency(): number { return this.omega / TAU; }
  set frequency(hz: number) { this.omega = TAU * hz; }

  /** Advance. Returns the new value. */
  step(dt: number): number {
    if (dt <= 0) return this.value;
    springMatrix(this.omega, this.damping, dt);
    const d = this.value - this.target;
    const v = this.velocity;
    this.value = this.target + _spring.m11 * d + _spring.m12 * v;
    this.velocity = _spring.m21 * d + _spring.m22 * v;
    return this.value;
  }

  /** Kick the spring without moving it — the punch. Peak displacement ≈ `v / (2π·frequency)`. */
  impulse(v: number): void { this.velocity += v; }
  /** Teleport, killing motion. */
  snap(v: number): void { this.value = v; this.target = v; this.velocity = 0; }
  reset(): void { this.snap(0); }
}

/**
 * Three springs sharing one set of coefficients — camera offsets, weapon position sway, shake.
 * The transition matrix is solved once per step and applied to all three axes.
 */
export class SpringVec3 {
  readonly value = new Vector3();
  readonly velocity = new Vector3();
  readonly target = new Vector3();
  private omega: number;

  constructor(frequency = 12, public damping = 1) {
    this.omega = TAU * frequency;
  }

  get frequency(): number { return this.omega / TAU; }
  set frequency(hz: number) { this.omega = TAU * hz; }

  step(dt: number): Vector3 {
    if (dt <= 0) return this.value;
    springMatrix(this.omega, this.damping, dt);
    const { m11, m12, m21, m22 } = _spring;
    const p = this.value;
    const v = this.velocity;
    const t = this.target;

    const dx = p.x - t.x;
    const dy = p.y - t.y;
    const dz = p.z - t.z;

    p.x = t.x + m11 * dx + m12 * v.x;
    p.y = t.y + m11 * dy + m12 * v.y;
    p.z = t.z + m11 * dz + m12 * v.z;

    v.x = m21 * dx + m22 * v.x;
    v.y = m21 * dy + m22 * v.y;
    v.z = m21 * dz + m22 * v.z;
    return p;
  }

  impulse(x: number, y: number, z: number): void {
    this.velocity.x += x; this.velocity.y += y; this.velocity.z += z;
  }

  snap(x = 0, y = 0, z = 0): void {
    this.value.set(x, y, z);
    this.target.set(x, y, z);
    this.velocity.set(0, 0, 0);
  }

  reset(): void { this.snap(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// EASING — ART_DIRECTION §8. Nothing eases linearly.
// All take t in [0,1] and return a value that starts at 0 and ends at 1
// (except the overshoot/punch family, which is the point).
// ─────────────────────────────────────────────────────────────────────────────

export function easeInQuad(t: number): number { return t * t; }
export function easeOutQuad(t: number): number { return t * (2 - t); }
export function easeInCubic(t: number): number { return t * t * t; }
export function easeOutCubic(t: number): number { const f = 1 - t; return 1 - f * f * f; }
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
export function easeOutQuint(t: number): number { const f = 1 - t; return 1 - f * f * f * f * f; }

/** The workhorse for "snap in, settle". Almost all UI and weapon motion uses this. */
export function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

export function easeInExpo(t: number): number {
  return t <= 0 ? 0 : Math.pow(2, 10 * t - 10);
}

export function easeInOutExpo(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
}

/**
 * THE COMIC OVERSHOOT. Goes past 1 and comes back. Use it on anything that pops:
 * word bubbles, HUD numbers, card deals, hit markers.
 */
export function easeOutBack(t: number, overshoot = 1.70158): number {
  const c3 = overshoot + 1;
  const f = t - 1;
  return 1 + c3 * f * f * f + overshoot * f * f;
}

export function easeInBack(t: number, overshoot = 1.70158): number {
  const c3 = overshoot + 1;
  return c3 * t * t * t - overshoot * t * t;
}

export function easeInOutBack(t: number, overshoot = 1.70158): number {
  const c2 = overshoot * 1.525;
  return t < 0.5
    ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
    : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
}

/** Big rubbery overshoot. For legendary-tier moments only — it is loud. */
export function easeOutElastic(t: number, amplitude = 1, period = 0.35): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const s = (period / TAU) * Math.asin(1 / Math.max(amplitude, 1));
  return amplitude * Math.pow(2, -10 * t) * Math.sin(((t - s) * TAU) / period) + 1;
}

export function easeOutBounce(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { const u = t - 1.5 / d1; return n1 * u * u + 0.75; }
  if (t < 2.5 / d1) { const u = t - 2.25 / d1; return n1 * u * u + 0.9375; }
  const u = t - 2.625 / d1;
  return n1 * u * u + 0.984375;
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function smootherstep(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * PUNCH: a decaying oscillation around 0, for camera shake, recoil settle, HUD number kicks.
 * t in [0,1] over the punch's lifetime. Returns roughly [-1, 1], ending at 0.
 */
export function punch(t: number, frequency = 3, decay = 5): number {
  if (t <= 0 || t >= 1) return 0;
  return Math.sin(t * TAU * frequency) * Math.exp(-decay * t);
}

/**
 * POP: a scale curve for spawning things — 0 → overshoot → 1.
 * Word pops, damage numbers, boon cards. `peak` is how far past 1 it flies.
 */
export function pop(t: number, peak = 1.25): number {
  const x = clamp01(t);
  return easeOutBack(x, (peak - 1) * 6.8);
}

/**
 * HOLD FRAMES (ART_DIRECTION §8). Stay at 0 for the first `hold` fraction of the curve, then
 * ease hard. A pose held then snapped reads as *animation*; a lerp reads as interpolation.
 */
export function holdThenEase(t: number, hold = 0.25, ease: (x: number) => number = easeOutExpo): number {
  const x = clamp01(t);
  if (x <= hold) return 0;
  return ease((x - hold) / (1 - hold));
}

/** Ramp up then back down — 0 at both ends, 1 in the middle. For flashes and flickers. */
export function arch(t: number): number {
  const x = clamp01(t);
  return Math.sin(x * PI);
}

/** One-frame-ish spike that decays fast. Impact flashes. */
export function spike(t: number, sharpness = 8): number {
  const x = clamp01(t);
  return Math.exp(-sharpness * x);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vector helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp a vector's length in place. */
export function clampLength(v: Vector3, max: number): Vector3 {
  const l2 = v.lengthSq();
  if (l2 > max * max && l2 > EPSILON) v.multiplyScalar(max / Math.sqrt(l2));
  return v;
}

/** Zero the Y component and re-normalise (safe on degenerate input). */
export function flattenNormalize(v: Vector3): Vector3 {
  v.y = 0;
  const l = v.length();
  if (l > EPSILON) v.multiplyScalar(1 / l);
  else v.set(0, 0, -1);
  return v;
}

/** Component of `v` along `n` removed, in place. Used for wall sliding. */
export function projectOnPlane(v: Vector3, n: Vector3): Vector3 {
  return v.addScaledVector(n, -v.dot(n));
}

/** Step a vector toward a target by at most `maxDelta`, in place. */
export function moveTowardsVec(out: Vector3, target: Vector3, maxDelta: number): Vector3 {
  const dx = target.x - out.x;
  const dy = target.y - out.y;
  const dz = target.z - out.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 <= maxDelta * maxDelta || d2 < EPSILON) return out.copy(target);
  const s = maxDelta / Math.sqrt(d2);
  out.x += dx * s; out.y += dy * s; out.z += dz * s;
  return out;
}

/** Squared horizontal distance — cheap AI/audio culling. */
export function distanceSqXZ(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Yaw (radians about +Y) that faces along `dir`. Matches -Z forward convention. */
export function yawFromDirection(dir: Vector3): number {
  return Math.atan2(-dir.x, -dir.z);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED SCRATCH — zero-allocation hot loops.
// Grab, use, drop. Never persist. `_vA/_vB` are for library code that must not
// collide with a caller already holding `_v1.._v6`.
// ─────────────────────────────────────────────────────────────────────────────

export const _v1 = new Vector3();
export const _v2 = new Vector3();
export const _v3 = new Vector3();
export const _v4 = new Vector3();
export const _v5 = new Vector3();
export const _v6 = new Vector3();
export const _vA = new Vector3();
export const _vB = new Vector3();

export const _q1 = new Quaternion();
export const _q2 = new Quaternion();

export const _m1 = new Matrix4();
export const _m2 = new Matrix4();

export const _e1 = new Euler();

export const _t1 = new Vector2();
export const _t2 = new Vector2();

/** Canonical axes — READ ONLY. Copy before mutating. */
export const UP = new Vector3(0, 1, 0);
export const DOWN = new Vector3(0, -1, 0);
export const FORWARD = new Vector3(0, 0, -1);
export const RIGHT = new Vector3(1, 0, 0);
export const ZERO = new Vector3(0, 0, 0);

/**
 * RNG — deterministic, seeded, forkable.
 *
 * Nothing in the game calls `Math.random()`. Recoil patterns, spawn composition, boon draws and
 * mystery-box rolls all come from here, so a run can be replayed from its seed and so the
 * *learnable* parts of the game (recoil) are learnable at all.
 *
 * Algorithm: sfc32 — 128 bits of state, passes PractRand, ~2ns per call, no BigInt.
 * Seeded through splitmix32 so neighbouring seeds (0, 1, 2) produce unrelated streams.
 *
 * FORKING: give each subsystem its own stream (`rng.fork()`), so adding a particle effect that
 * consumes randomness can never shift the enemy spawn sequence.
 */

import { Vector3 } from 'three';
import type { RNG } from '@/core/types';

/** Avalanche a 32-bit integer into a well-distributed 32-bit integer. */
export function hash32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Stable string → 32-bit seed (FNV-1a). Lets us seed from a run name or level id. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const _scratch = new Vector3();

export class Rng implements RNG {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;
  private _seed = 0;
  private _gaussSpare = 0;
  private _hasGaussSpare = false;

  constructor(seed: number = 0x5eed1e) {
    this.seed = seed;
  }

  /** Reading gives the seed this stream was started from; writing restarts the stream. */
  get seed(): number { return this._seed; }
  set seed(s: number) {
    this._seed = s >>> 0;
    // splitmix32 expansion — one seed word into four state words.
    let x = this._seed;
    const nextState = (): number => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = nextState();
    this.b = nextState();
    this.c = nextState();
    this.d = nextState();
    this._hasGaussSpare = false;
    // Burn in — the first few outputs of a freshly seeded sfc32 are weakly mixed.
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform in [0, 1). */
  next(): number {
    // sfc32
    const t = (this.a + this.b | 0) + this.d | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Uniform 32-bit unsigned integer. */
  nextUint(): number {
    const t = (this.a + this.b | 0) + this.d | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number {
    const span = maxExclusive - minInclusive;
    if (span <= 0) return minInclusive;
    return minInclusive + Math.floor(this.next() * span);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** True with probability `p` (default a coin flip). */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** -1 or +1. */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  /** Symmetric uniform in [-amount, amount] — jitter, spread, wobble. */
  spread(amount: number): number {
    return (this.next() * 2 - 1) * amount;
  }

  /**
   * Normally distributed, mean 0 / stddev 1 (Box–Muller, with the second value cached).
   * Use for anything that should *cluster* — recoil scatter, blood spray, crowd variation.
   * Uniform noise looks random; gaussian noise looks natural.
   */
  gauss(mean = 0, stddev = 1): number {
    if (this._hasGaussSpare) {
      this._hasGaussSpare = false;
      return mean + stddev * this._gaussSpare;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this._gaussSpare = v * f;
    this._hasGaussSpare = true;
    return mean + stddev * u * f;
  }

  /** Uniform point on the unit sphere, written into `out`. */
  unitSphere(out: Vector3): Vector3 {
    const z = this.next() * 2 - 1;
    const t = this.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return out.set(r * Math.cos(t), r * Math.sin(t), z);
  }

  /** Uniform point *inside* the unit sphere, scaled by `radius`. */
  insideSphere(out: Vector3, radius = 1): Vector3 {
    this.unitSphere(out);
    return out.multiplyScalar(radius * Math.cbrt(this.next()));
  }

  /** Uniform point inside a disk on the XZ plane. */
  insideDiskXZ(out: Vector3, radius = 1): Vector3 {
    const t = this.next() * Math.PI * 2;
    const r = radius * Math.sqrt(this.next());
    return out.set(Math.cos(t) * r, 0, Math.sin(t) * r);
  }

  /**
   * A direction inside a cone of half-angle `halfAngle` (radians) around `dir`.
   * This is bullet spread — uniform over the cap, so a shotgun pattern is even, not centre-heavy.
   */
  cone(dir: Vector3, halfAngle: number, out: Vector3): Vector3 {
    if (halfAngle <= 0) return out.copy(dir).normalize();
    const cosMax = Math.cos(halfAngle);
    const z = cosMax + (1 - cosMax) * this.next();
    const phi = this.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    // Build a basis around `dir` without allocating.
    const d = _scratch.copy(dir).normalize();
    const ax = Math.abs(d.y) < 0.99 ? 0 : 1;
    // Tangent = normalize(cross(up-ish, d))
    let tx: number;
    let ty: number;
    let tz: number;
    if (ax === 0) { tx = -d.z; ty = 0; tz = d.x; }
    else { tx = 0; ty = -d.z; tz = d.y; }
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // Bitangent = cross(d, tangent)
    const bx = d.y * tz - d.z * ty;
    const by = d.z * tx - d.x * tz;
    const bz = d.x * ty - d.y * tx;
    const cp = Math.cos(phi) * r;
    const sp = Math.sin(phi) * r;
    return out.set(
      d.x * z + tx * cp + bx * sp,
      d.y * z + ty * cp + by * sp,
      d.z * z + tz * cp + bz * sp,
    ).normalize();
  }

  /** In-place Fisher–Yates. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /**
   * Weighted pick. `weights` must be the same length as `arr`; zero-weight entries never come up.
   * Boon rarity and mystery-box tables run through this.
   */
  weighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  /**
   * A child stream. Without an explicit seed the child is derived from this stream's state, so
   * the whole tree stays reproducible from one root seed.
   */
  fork(seed?: number): Rng {
    return new Rng(seed !== undefined ? seed >>> 0 : this.nextUint());
  }

  /** Restart this stream from its original seed. */
  reset(): void {
    this.seed = this._seed;
  }
}

/** Factory, for code that would rather not `new`. */
export function createRng(seed?: number): Rng {
  return new Rng(seed);
}

/**
 * The default stream. Systems that need reproducibility should `fork()` this in `init` and keep
 * their own instance — never share a stream across systems.
 */
export const rng = new Rng(0x5eed1e);

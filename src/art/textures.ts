/**
 * PROCEDURAL TEXTURE FACTORY — every pixel in this game is drawn here, at runtime.
 * Nothing in this file loads a file. See docs/ART_DIRECTION.md.
 *
 * The house rules for everything generated here:
 *   • FLAT COLOUR + HEAVY INK. Tones are quantised into 2–4 flats, never gradients.
 *   • Shadow is a HALFTONE DOT FIELD or HATCHING, never a soft grey smear.
 *   • Every line is hand-roughened. A perfectly straight line is a bug.
 *   • Colour only ever comes from `@/art/palette`.
 *
 * Everything is cached by key (we build once, ever) and registered for disposal.
 *
 *   Noise / rough-ink utilities   makeSeededRandom, hash2, valueNoise2D, simplex2D, fbm2D,
 *                                 roughStroke, taperStroke, roughPolygon, hatchRegion
 *   Screen tone                   makeHalftoneTexture, makeNewsprintTexture
 *   Decals / VFX                  makeInkSplatTexture, makeSpeedLinesTexture, makeStarBurstTexture
 *   Surfaces                      makeCrackedConcrete, makeRustMetal, makePlankWood, makeBrick,
 *                                 makeFacade
 *   Wall dressing atlases         makeWallAdSheet, makePosterSheet
 *   Lookups                       makeGradientRamp
 *   Lifecycle                     setArtAnisotropy, disposeArtTextures, artTextureCount
 */

import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
  type Texture,
} from 'three';
import {
  PALETTE,
  cssOf,
  mix8,
  rgb8,
  rgb8Hex,
  rgb8Mix,
  shade,
  tint,
  type PaletteToken,
  type RGB8,
} from '@/art/palette';

// ═════════════════════════════════════════════════════════════════════════════
// 1. SEEDED RANDOM + NOISE
//    Deterministic: the same seed always paints the same texture, so a decal
//    picked by the seeded game RNG is reproducible across a replay.
// ═════════════════════════════════════════════════════════════════════════════

export interface SeededRandom {
  /** [0,1) */
  next(): number;
  range(min: number, max: number): number;
  int(minInclusive: number, maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  /** -1 or +1. */
  sign(): number;
  bool(chance?: number): boolean;
  /** Centred: [-a, +a]. */
  spread(a: number): number;
}

/** mulberry32 — tiny, fast, good enough for art. */
export function makeSeededRandom(seed: number): SeededRandom {
  let s = (seed | 0) || 0x9e3779b9;
  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor((max - min) * next()),
    pick: <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length) % arr.length] as T,
    sign: () => (next() < 0.5 ? -1 : 1),
    bool: (chance = 0.5) => next() < chance,
    spread: (a) => (next() * 2 - 1) * a,
  };
}

/** Deterministic 2D hash → [0,1). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const _fade = (t: number): number => t * t * (3 - 2 * t);

/** Value noise, [-1,1]. */
export function valueNoise2D(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = _fade(x - xi);
  const yf = _fade(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * xf;
  const bot = c + (d - c) * xf;
  return (top + (bot - top) * yf) * 2 - 1;
}

/**
 * Seamlessly tiling value noise: lattice coordinates wrap at `period`, so a
 * texture sampled over [0,period) tiles perfectly. Required for every surface map.
 */
export function tileNoise2D(x: number, y: number, period: number, seed = 0): number {
  const p = Math.max(1, period | 0);
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = _fade(x - xi);
  const yf = _fade(y - yi);
  const x0 = ((xi % p) + p) % p;
  const y0 = ((yi % p) + p) % p;
  const x1 = (x0 + 1) % p;
  const y1 = (y0 + 1) % p;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const top = a + (b - a) * xf;
  const bot = c + (d - c) * xf;
  return (top + (bot - top) * yf) * 2 - 1;
}

const _GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
] as const;

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** Seeded 2D simplex noise, ~[-1,1]. Cheaper artefacts than value noise for organic masks. */
export function simplex2D(xin: number, yin: number, seed = 0): number {
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;

  let n = 0;
  const corner = (xx: number, yy: number, ii: number, jj: number): number => {
    let tt = 0.5 - xx * xx - yy * yy;
    if (tt <= 0) return 0;
    const g = _GRAD[Math.floor(hash2(ii, jj, seed) * 8) & 7] as readonly [number, number];
    tt *= tt;
    return tt * tt * (g[0] * xx + g[1] * yy);
  };
  n += corner(x0, y0, i, j);
  n += corner(x1, y1, i + i1, j + j1);
  n += corner(x2, y2, i + 1, j + 1);
  return 70 * n;
}

export interface FbmOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  seed?: number;
  /** Non-zero makes the result seamlessly tile over this lattice period. */
  period?: number;
}

/** Fractal sum of value noise, roughly [-1,1]. */
export function fbm2D(x: number, y: number, opts: FbmOptions = {}): number {
  const octaves = opts.octaves ?? 4;
  const lacunarity = opts.lacunarity ?? 2;
  const gain = opts.gain ?? 0.5;
  const seed = opts.seed ?? 0;
  const period = opts.period ?? 0;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * (period > 0
      ? tileNoise2D(x * freq, y * freq, Math.max(1, Math.round(period * freq)), seed + o * 131)
      : valueNoise2D(x * freq, y * freq, seed + o * 131));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / (norm || 1);
}

/** Ridged fbm — makes cracks, rust edges and torn paper. [0,1]. */
export function ridged2D(x: number, y: number, opts: FbmOptions = {}): number {
  return 1 - Math.abs(fbm2D(x, y, opts));
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. CANVAS + INK-ROUGHENING UTILITIES
//    These sell the whole style: nothing we draw is allowed to be geometrically
//    perfect. Every stroke wobbles, every fill has a chewed edge.
// ═════════════════════════════════════════════════════════════════════════════

export interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  size: number;
}

/** Allocate a canvas + 2D context, throwing loudly if the browser refuses one. */
export function makeCanvas(width: number, height = width): Canvas2D {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width | 0);
  canvas.height = Math.max(1, height | 0);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[art/textures] 2D canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx, size: canvas.width };
}

/**
 * Run `draw` nine times, once per neighbouring tile offset, so any linework that
 * crosses the texture seam continues on the other side. Build-time only.
 */
export function drawWrapped(ctx: CanvasRenderingContext2D, size: number, draw: () => void): void {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      ctx.save();
      ctx.translate(ox * size, oy * size);
      draw();
      ctx.restore();
    }
  }
}

export interface RoughOptions {
  /** Ink colour (css). Defaults to INK. */
  color?: string;
  /** Nominal line width in px. */
  width?: number;
  /** Perpendicular wobble in px. */
  jitter?: number;
  /** Length of a resampled segment in px — smaller = more wobble frequency. */
  step?: number;
  /** Number of overlapping strokes. 2 reads as a confident inked line. */
  passes?: number;
  seed?: number;
  closed?: boolean;
  alpha?: number;
}

/** Resample a polyline to fixed-length steps and displace it with noise. */
function roughenPoints(
  pts: readonly number[],
  step: number,
  jitter: number,
  seed: number,
  closed: boolean,
): number[] {
  const out: number[] = [];
  const n = pts.length / 2;
  if (n < 2) return pts.slice();
  const last = closed ? n : n - 1;
  let travelled = 0;
  for (let i = 0; i < last; i++) {
    const ax = pts[i * 2] as number;
    const ay = pts[i * 2 + 1] as number;
    const j = (i + 1) % n;
    const bx = pts[j * 2] as number;
    const by = pts[j * 2 + 1] as number;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-4;
    const nx = -dy / len;
    const ny = dx / len;
    const steps = Math.max(1, Math.round(len / step));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const d = travelled + t * len;
      const w =
        valueNoise2D(d * 0.06, seed * 0.37, seed) * 0.7 +
        valueNoise2D(d * 0.19, seed * 0.91 + 7, seed + 3) * 0.3;
      out.push(ax + dx * t + nx * w * jitter, ay + dy * t + ny * w * jitter);
    }
    travelled += len;
  }
  if (!closed) {
    out.push(pts[(n - 1) * 2] as number, pts[(n - 1) * 2 + 1] as number);
  }
  return out;
}

function tracePath(ctx: CanvasRenderingContext2D, p: readonly number[], closed: boolean): void {
  ctx.beginPath();
  ctx.moveTo(p[0] as number, p[1] as number);
  for (let i = 1; i < p.length / 2 - 1; i++) {
    const cx = p[i * 2] as number;
    const cy = p[i * 2 + 1] as number;
    const mx = (cx + (p[i * 2 + 2] as number)) * 0.5;
    const my = (cy + (p[i * 2 + 3] as number)) * 0.5;
    ctx.quadraticCurveTo(cx, cy, mx, my);
  }
  const n = p.length / 2;
  ctx.lineTo(p[(n - 1) * 2] as number, p[(n - 1) * 2 + 1] as number);
  if (closed) ctx.closePath();
}

/**
 * The workhorse: a hand-drawn ink stroke through `pts` (flat x,y pairs).
 * Two offset passes with slightly different wobble = a confident, weighty line.
 */
export function roughStroke(
  ctx: CanvasRenderingContext2D,
  pts: readonly number[],
  opts: RoughOptions = {},
): void {
  const width = opts.width ?? 2;
  const jitter = opts.jitter ?? width * 0.6;
  const step = opts.step ?? 7;
  const passes = opts.passes ?? 2;
  const seed = opts.seed ?? 1;
  const closed = opts.closed ?? false;
  ctx.save();
  ctx.strokeStyle = opts.color ?? cssOf(rgb8('INK'));
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let p = 0; p < passes; p++) {
    const rp = roughenPoints(pts, step, jitter, seed + p * 977, closed);
    ctx.lineWidth = width * (p === 0 ? 1 : 0.72);
    tracePath(ctx, rp, closed);
    ctx.stroke();
  }
  ctx.restore();
}

/** A stroke whose width ramps from `wStart` to `wEnd` — speed lines, drips, grain. */
export function taperStroke(
  ctx: CanvasRenderingContext2D,
  pts: readonly number[],
  wStart: number,
  wEnd: number,
  opts: RoughOptions = {},
): void {
  const seed = opts.seed ?? 1;
  const jitter = opts.jitter ?? 1.2;
  const rp = roughenPoints(pts, opts.step ?? 6, jitter, seed, false);
  const n = rp.length / 2;
  if (n < 2) return;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < n; i++) {
    const px = rp[i * 2] as number;
    const py = rp[i * 2 + 1] as number;
    const qx = rp[Math.min(n - 1, i + 1) * 2] as number;
    const qy = rp[Math.min(n - 1, i + 1) * 2 + 1] as number;
    const ox = rp[Math.max(0, i - 1) * 2] as number;
    const oy = rp[Math.max(0, i - 1) * 2 + 1] as number;
    let dx = qx - ox;
    let dy = qy - oy;
    const l = Math.hypot(dx, dy) || 1e-4;
    dx /= l;
    dy /= l;
    const t = i / (n - 1);
    const w = (wStart + (wEnd - wStart) * t) * 0.5;
    left.push(px - dy * w, py + dx * w);
    right.push(px + dy * w, py - dx * w);
  }
  ctx.save();
  ctx.fillStyle = opts.color ?? cssOf(rgb8('INK'));
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.beginPath();
  ctx.moveTo(left[0] as number, left[1] as number);
  for (let i = 1; i < n; i++) ctx.lineTo(left[i * 2] as number, left[i * 2 + 1] as number);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i * 2] as number, right[i * 2 + 1] as number);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Closed rough polygon: fill, then ink the border. */
export function roughPolygon(
  ctx: CanvasRenderingContext2D,
  pts: readonly number[],
  fill: string | null,
  ink: string | null,
  opts: RoughOptions = {},
): void {
  const seed = opts.seed ?? 1;
  const rp = roughenPoints(pts, opts.step ?? 9, opts.jitter ?? 1.5, seed, true);
  if (fill) {
    ctx.save();
    ctx.fillStyle = fill;
    ctx.globalAlpha = opts.alpha ?? 1;
    tracePath(ctx, rp, true);
    ctx.fill();
    ctx.restore();
  }
  if (ink) roughStroke(ctx, pts, { ...opts, color: ink, closed: true, seed: seed + 17 });
}

/** A wobbly circle — for rivets, knots, bullet holes. */
export function roughCircle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  fill: string | null,
  ink: string | null,
  opts: RoughOptions = {},
): void {
  const seed = opts.seed ?? 1;
  const segs = Math.max(7, Math.round(r * 0.9) + 7);
  const pts: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const rr = r * (1 + valueNoise2D(Math.cos(a) * 2.3 + seed, Math.sin(a) * 2.3, seed) * 0.09);
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  roughPolygon(ctx, pts, fill, ink, { ...opts, step: Math.max(3, r * 0.5), jitter: r * 0.05 });
}

export interface HatchOptions {
  angleDeg?: number;
  spacing?: number;
  width?: number;
  color?: string;
  seed?: number;
  alpha?: number;
  /** Randomly drop this fraction of lines so hatching breathes. */
  dropout?: number;
  /** Cross-hatch a second set at +90°. */
  cross?: boolean;
}

/**
 * Fill the current clip region with hand-drawn hatching. This is how a comic
 * artist makes a shadow — never with a soft gradient.
 */
export function hatchRegion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: HatchOptions = {},
): void {
  const angle = ((opts.angleDeg ?? 38) * Math.PI) / 180;
  const spacing = opts.spacing ?? 9;
  const width = opts.width ?? 1.6;
  const color = opts.color ?? cssOf(rgb8('INK'));
  const seed = opts.seed ?? 5;
  const dropout = opts.dropout ?? 0.12;
  const rnd = makeSeededRandom(seed);
  const diag = Math.hypot(w, h);
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const nx = -dy;
  const ny = dx;
  const count = Math.ceil(diag / spacing);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let i = -count; i <= count; i++) {
    if (rnd.next() < dropout) continue;
    const off = i * spacing + rnd.spread(spacing * 0.18);
    const ex = diag * 0.5 * (0.72 + rnd.next() * 0.28);
    roughStroke(
      ctx,
      [cx + nx * off - dx * ex, cy + ny * off - dy * ex, cx + nx * off + dx * ex, cy + ny * off + dy * ex],
      { color, width: width * (0.75 + rnd.next() * 0.5), jitter: 1.1, passes: 1, seed: seed + i * 31, alpha: opts.alpha ?? 1 },
    );
  }
  if (opts.cross) {
    hatchRegion(ctx, x, y, w, h, { ...opts, cross: false, angleDeg: (opts.angleDeg ?? 38) + 84, seed: seed + 613, spacing: spacing * 1.25 });
  }
  ctx.restore();
}

/**
 * Scatter a halftone dot field over a rect, dot radius driven by `density(x,y)`.
 * The signature move of the style — used for every painted shadow in this file.
 */
export function halftoneField(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  pitch: number,
  angleDeg: number,
  color: string,
  density: (px: number, py: number) => number,
  seed = 11,
): void {
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const reach = Math.ceil(Math.hypot(w, h) / pitch / 2) + 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = color;
  for (let j = -reach; j <= reach; j++) {
    for (let i = -reach; i <= reach; i++) {
      const lx = i * pitch;
      const ly = j * pitch;
      const px = cx + lx * ca - ly * sa;
      const py = cy + lx * sa + ly * ca;
      if (px < x - pitch || px > x + w + pitch || py < y - pitch || py > y + h + pitch) continue;
      const d = Math.max(0, Math.min(1, density(px, py)));
      if (d <= 0.02) continue;
      const r = pitch * 0.5 * Math.sqrt(d) * (0.86 + hash2(i, j, seed) * 0.28);
      if (r < 0.35) continue;
      ctx.beginPath();
      ctx.ellipse(px, py, r, r * (0.9 + hash2(i, j, seed + 5) * 0.2), hash2(i, j, seed + 9) * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. TEXTURE CACHE / DISPOSE REGISTRY
// ═════════════════════════════════════════════════════════════════════════════

const _cache = new Map<string, Texture>();
const _sets = new Map<string, SurfaceTextureSet>();
let _anisotropy = 4;

function finish(
  tex: Texture,
  opts: { srgb: boolean; repeat: boolean; mips?: boolean; nearest?: boolean },
): Texture {
  tex.colorSpace = opts.srgb ? SRGBColorSpace : NoColorSpace;
  tex.wrapS = tex.wrapT = opts.repeat ? RepeatWrapping : ClampToEdgeWrapping;
  const mips = opts.mips ?? true;
  tex.generateMipmaps = mips;
  tex.magFilter = opts.nearest ? NearestFilter : LinearFilter;
  tex.minFilter = opts.nearest ? NearestFilter : mips ? LinearMipmapLinearFilter : LinearFilter;
  tex.anisotropy = opts.nearest ? 1 : _anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function register<T extends Texture>(key: string, tex: T): T {
  tex.name = key;
  _cache.set(key, tex);
  return tex;
}

function cached<T extends Texture>(key: string, build: () => T): T {
  const hit = _cache.get(key);
  if (hit) return hit as T;
  return register(key, build());
}

/**
 * Call once from the renderer with `renderer.capabilities.getMaxAnisotropy()`.
 * Applies retroactively to everything already built.
 */
export function setArtAnisotropy(max: number): void {
  _anisotropy = Math.max(1, Math.min(16, Math.floor(max)));
  for (const t of _cache.values()) {
    if (t.magFilter !== NearestFilter) {
      t.anisotropy = _anisotropy;
      t.needsUpdate = true;
    }
  }
}

/** Free every generated texture. Systems that own GPU resources must call this on teardown. */
export function disposeArtTextures(): void {
  for (const t of _cache.values()) t.dispose();
  _cache.clear();
  _sets.clear();
}

export function artTextureCount(): number {
  return _cache.size;
}

/** Look a generated texture up by cache key (debug/inspection only). */
export function getArtTexture(key: string): Texture | undefined {
  return _cache.get(key);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. SCREEN TONE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Tiling halftone dot screen. White dots on black — a MASK, tint it downstream.
 *
 * The tile itself is axis-aligned and the rotation is applied via `texture.rotation`,
 * which keeps the tiling seamless at any angle (ART_DIRECTION §2.2: 15° per family).
 *
 * @param pitch  dot spacing in texels
 * @param angle  screen-tone rotation in degrees
 * @param size   tile size; rounded so `pitch` divides it exactly
 */
export function makeHalftoneTexture(pitch = 8, angle = 15, size = 128): Texture {
  const cells = Math.max(2, Math.round(size / pitch));
  const realPitch = size / cells;
  const key = `halftone:${cells}:${angle}:${size}`;
  return cached(key, () => {
    const { canvas, ctx } = makeCanvas(size);
    ctx.fillStyle = cssOf(rgb8('INK'));
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = cssOf(rgb8('PAPER'));
    const r = realPitch * 0.34;
    for (let j = -1; j <= cells; j++) {
      for (let i = -1; i <= cells; i++) {
        const px = (i + 0.5) * realPitch;
        const py = (j + 0.5) * realPitch;
        // Hand-printed dots: a hair of ellipticity and rotation, never a perfect circle.
        const rr = r * (0.94 + hash2(i, j, 7) * 0.12);
        ctx.beginPath();
        ctx.ellipse(px, py, rr, rr * (0.93 + hash2(i, j, 19) * 0.14), hash2(i, j, 23) * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const tex = new CanvasTexture(canvas);
    finish(tex, { srgb: false, repeat: true });
    tex.center.set(0.5, 0.5);
    tex.rotation = (angle * Math.PI) / 180;
    return tex;
  });
}

/**
 * Newsprint: paper fibre + CMYK misregistered dot noise. Fed to the grain pass
 * (ART_DIRECTION §4.7) at ~4% opacity, tiled over the screen.
 */
export function makeNewsprintTexture(size = 512): Texture {
  const key = `newsprint:${size}`;
  return cached(key, () => {
    const { canvas, ctx } = makeCanvas(size);
    const paper = rgb8('PAPER');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const period = 16;
    const scale = period / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Fibre: stretched fbm in two directions + fine speckle.
        const f =
          fbm2D(x * scale * 2.2, y * scale * 7.5, { octaves: 3, period: period * 2, seed: 21 }) * 0.55 +
          fbm2D(x * scale * 7.5, y * scale * 2.2, { octaves: 3, period: period * 2, seed: 44 }) * 0.35 +
          (hash2(x, y, 91) - 0.5) * 0.5;
        const v = 1 + f * 0.09;
        const i = (y * size + x) * 4;
        d[i] = Math.max(0, Math.min(255, paper[0] * v));
        d[i + 1] = Math.max(0, Math.min(255, paper[1] * v));
        d[i + 2] = Math.max(0, Math.min(255, paper[2] * v));
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // CMYK dot noise: three misregistered screens, exactly like cheap print.
    const screens: readonly { token: PaletteToken; angle: number; alpha: number }[] = [
      { token: 'ELECTRIC', angle: 15, alpha: 0.1 },
      { token: 'HOT', angle: 75, alpha: 0.09 },
      { token: 'GOLD', angle: 45, alpha: 0.08 },
    ];
    ctx.globalCompositeOperation = 'multiply';
    for (let s = 0; s < screens.length; s++) {
      const sc = screens[s] as { token: PaletteToken; angle: number; alpha: number };
      ctx.globalAlpha = sc.alpha;
      halftoneField(
        ctx, 0, 0, size, size, 4.5, sc.angle, cssOf(rgb8(sc.token)),
        (px, py) => 0.25 + 0.35 * fbm2D(px * scale * 3, py * scale * 3, { octaves: 2, period: period * 3, seed: 60 + s * 7 }),
        30 + s,
      );
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // A few long fibres on top — the thing that reads as "paper" instantly.
    const rnd = makeSeededRandom(1337);
    drawWrapped(ctx, size, () => {
      for (let i = 0; i < 40; i++) {
        const x0 = rnd.range(0, size);
        const y0 = rnd.range(0, size);
        const len = rnd.range(size * 0.05, size * 0.3);
        const a = rnd.range(0, Math.PI * 2);
        taperStroke(
          ctx,
          [x0, y0, x0 + Math.cos(a) * len * 0.5, y0 + Math.sin(a) * len * 0.5, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len],
          rnd.range(0.4, 1.1), 0.2,
          { color: shade('PAPER', 0.16, 0.35), seed: i * 13 + 1, jitter: 2.4 },
        );
      }
    });

    const tex = new CanvasTexture(canvas);
    return finish(tex, { srgb: true, repeat: true });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. INK SPLAT — the blood decal
//    Built as a metaball field (so lobes merge organically), eroded by noise (so
//    the edge is chewed, not smooth), with drip tails and a halftone dot fringe.
//    Output is a white RGB + alpha MASK: tint it HOT in the decal material.
// ═════════════════════════════════════════════════════════════════════════════

interface Blob {
  x: number;
  y: number;
  r: number;
  sign: number;
}

export interface SplatOptions {
  /** Directional bias in radians — splats thrown along the bullet direction. */
  direction?: number;
  /** 0 = round blot, 1 = violently directional. */
  spray?: number;
  /** How many drip tails run "down" the surface. */
  drips?: number;
  /** Halftone fringe pitch in px. */
  fringePitch?: number;
}

/**
 * A hand-drawn ink splat mask. Must read as DRAWN — hard edges, satellite
 * droplets, tapered drips, dispersed dot fringe. Never a soft blurry blob.
 */
export function makeInkSplatTexture(seed = 0, size = 256, opts: SplatOptions = {}): Texture {
  const dir = opts.direction ?? 0;
  const spray = opts.spray ?? 0.35;
  const dripCount = opts.drips ?? 3;
  const fringePitch = opts.fringePitch ?? 7;
  const key = `splat:${seed}:${size}:${dir.toFixed(2)}:${spray.toFixed(2)}:${dripCount}`;
  return cached(key, () => {
    const rnd = makeSeededRandom(seed * 7919 + 13);
    const half = size * 0.5;
    const blobs: Blob[] = [];

    // Core mass — lobes pushed well off-centre so the outline is lumpy, never a disc.
    const coreR = half * 0.26;
    blobs.push({ x: half, y: half, r: coreR * 0.92, sign: 1 });
    const lobes = 5;
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2 + rnd.spread(0.7);
      const d = rnd.range(0.55, 1.25) * coreR;
      blobs.push({
        x: half + Math.cos(a) * d + Math.cos(dir) * spray * coreR * 0.5,
        y: half + Math.sin(a) * d + Math.sin(dir) * spray * coreR * 0.5,
        r: coreR * rnd.range(0.34, 0.8),
        sign: 1,
      });
    }

    // Spurs: chains of shrinking lobes that shoot out of the mass. These are what
    // turn a metaball puddle into a thrown splat.
    const spurs = 4 + Math.floor(rnd.next() * 3);
    for (let i = 0; i < spurs; i++) {
      const biased = rnd.bool(0.6);
      let ang = biased ? dir + rnd.spread(0.8 + (1 - spray)) : rnd.range(0, Math.PI * 2);
      let px = half + Math.cos(ang) * coreR * 0.7;
      let py = half + Math.sin(ang) * coreR * 0.7;
      let r = coreR * rnd.range(0.3, 0.5);
      const steps = 4 + Math.floor(rnd.next() * 4);
      for (let s = 0; s < steps; s++) {
        ang += rnd.spread(0.3);
        const step = r * rnd.range(1.1, 1.7);
        px += Math.cos(ang) * step;
        py += Math.sin(ang) * step;
        r *= rnd.range(0.62, 0.82);
        if (r < 1.4) break;
        blobs.push({ x: px, y: py, r, sign: 1 });
      }
    }

    // Satellite droplets flung along the impact direction.
    const sat = 9 + Math.floor(rnd.next() * 7);
    for (let i = 0; i < sat; i++) {
      const a = dir + rnd.spread(Math.PI * (1 - spray * 0.7));
      const d = rnd.range(coreR * 1.4, half * 0.9);
      blobs.push({
        x: half + Math.cos(a) * d,
        y: half + Math.sin(a) * d,
        r: coreR * rnd.range(0.1, 0.34) * (1 - d / (half * 1.5)) * 1.7,
        sign: 1,
      });
    }

    // Drip tails: long, thin, tapering chains that leave the mass and run.
    for (let i = 0; i < dripCount; i++) {
      const a = dir + rnd.spread(0.9);
      const startD = coreR * rnd.range(0.8, 1.3);
      let px = half + Math.cos(a) * startD;
      let py = half + Math.sin(a) * startD;
      let r = coreR * rnd.range(0.16, 0.26);
      const steps = 8 + Math.floor(rnd.next() * 7);
      let ang = a;
      for (let s = 0; s < steps; s++) {
        ang += rnd.spread(0.16);
        const step = r * rnd.range(1.5, 2.3);
        px += Math.cos(ang) * step;
        py += Math.sin(ang) * step;
        r *= rnd.range(0.86, 0.97);
        if (r < 1.1 || Math.hypot(px - half, py - half) > half * 0.92) break;
        blobs.push({ x: px, y: py, r, sign: 1 });
      }
      // The bead at the end of a drip — always slightly fatter.
      blobs.push({ x: px, y: py, r: r * 1.9, sign: 1 });
    }

    // Negative lobes chew holes and bites out of the mass so it never looks stamped.
    for (let i = 0; i < 5; i++) {
      const a = rnd.range(0, Math.PI * 2);
      const d = rnd.range(0.3, 1.25) * coreR;
      blobs.push({ x: half + Math.cos(a) * d, y: half + Math.sin(a) * d, r: coreR * rnd.range(0.2, 0.46), sign: -1 });
    }

    const { canvas, ctx } = makeCanvas(size);
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const nScale = 3.2 / size;
    const nSeed = seed * 31 + 5;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let f = 0;
        for (let b = 0; b < blobs.length; b++) {
          const bl = blobs[b] as Blob;
          const dx = x - bl.x;
          const dy = y - bl.y;
          const dd = dx * dx + dy * dy + 1;
          f += (bl.sign * bl.r * bl.r) / dd;
        }
        // Noise erosion — this is what turns a metaball into a drawn shape.
        // Low frequency chews big bites out of the silhouette; high frequency
        // roughens the contour so it reads as brush, not vector.
        const n =
          fbm2D(x * nScale, y * nScale, { octaves: 3, seed: nSeed }) * 0.85 +
          simplex2D(x * nScale * 4.2, y * nScale * 4.2, nSeed + 9) * 0.22;
        f *= 1 + n;

        // Radial falloff keeps the mask inside the tile.
        const rr = Math.hypot(x - half, y - half) / half;
        f *= 1 - Math.max(0, Math.min(1, (rr - 0.86) / 0.14));

        let a: number;
        if (f >= 1) {
          a = 1;
        } else if (f > 0.55) {
          // Dispersed halftone fringe: the mass breaks into dots as it thins out.
          const t = (f - 0.55) / 0.45;
          const cxi = Math.floor(x / fringePitch);
          const cyi = Math.floor(y / fringePitch);
          const jx = (hash2(cxi, cyi, nSeed) - 0.5) * fringePitch * 0.5;
          const jy = (hash2(cxi, cyi, nSeed + 3) - 0.5) * fringePitch * 0.5;
          const dcx = x - (cxi + 0.5) * fringePitch - jx;
          const dcy = y - (cyi + 0.5) * fringePitch - jy;
          const dist = Math.hypot(dcx, dcy);
          const radius = fringePitch * 0.52 * t * t;
          a = dist < radius ? 1 : 0;
        } else {
          a = 0;
        }
        // 1-texel soften only right at the hard boundary — keeps it crisp, kills crawl.
        if (a === 1 && f < 1.04 && f >= 1) a = Math.min(1, 0.6 + (f - 1) * 10);

        const i = (y * size + x) * 4;
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new CanvasTexture(canvas);
    return finish(tex, { srgb: false, repeat: false });
  });
}

/** Convenience pool: N distinct splats, so decals never visibly repeat. */
export function makeSplatSet(count = 6, size = 256, opts: SplatOptions = {}): Texture[] {
  const out: Texture[] = [];
  for (let i = 0; i < count; i++) {
    out.push(makeInkSplatTexture(i + 1, size, { ...opts, direction: (i / count) * Math.PI * 2 }));
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. VFX SHAPES
// ═════════════════════════════════════════════════════════════════════════════

export interface SpeedLinesOptions {
  lines?: number;
  /** Inner radius (0..1 of half-size) where the lines start. */
  innerRadius?: number;
  seed?: number;
}

/**
 * Radial screen-space speed lines with tapered inner ends. White-on-transparent
 * MASK — the overlay pass tints it (INK for sprint, HOT for damage).
 */
export function makeSpeedLinesTexture(size = 512, opts: SpeedLinesOptions = {}): Texture {
  const lines = opts.lines ?? 84;
  const inner = opts.innerRadius ?? 0.38;
  const seed = opts.seed ?? 3;
  const key = `speedlines:${size}:${lines}:${inner}:${seed}`;
  return cached(key, () => {
    const { canvas, ctx } = makeCanvas(size);
    const half = size * 0.5;
    const rnd = makeSeededRandom(seed);
    const white = cssOf(rgb8('PAPER'));
    for (let i = 0; i < lines; i++) {
      // Uneven angular spacing: a regular fan reads as a sunburst clipart, not motion.
      const a = ((i + rnd.spread(0.42)) / lines) * Math.PI * 2;
      // Wide variance in where each line starts is what makes the eye read speed.
      const r0 = half * inner * rnd.range(0.55, 2.1);
      const r1 = half * rnd.range(1.08, 1.5);
      if (r0 > r1 * half * 0.9) continue;
      const w = rnd.range(1, 13) * (size / 512);
      const bend = rnd.spread(0.035);
      const pts = [
        half + Math.cos(a) * r0, half + Math.sin(a) * r0,
        half + Math.cos(a + bend) * (r0 + r1) * 0.5, half + Math.sin(a + bend) * (r0 + r1) * 0.5,
        half + Math.cos(a + bend * 2) * r1, half + Math.sin(a + bend * 2) * r1,
      ];
      taperStroke(ctx, pts, 0.1, w, {
        color: white, seed: seed + i * 7, jitter: 1.1, step: 14, alpha: rnd.range(0.55, 1),
      });
    }
    // Dot dispersion right at the frame edge — the lines dissolve into screen tone.
    halftoneField(
      ctx, 0, 0, size, size, 11 * (size / 512), 22, white,
      (px, py) => {
        const t = Math.hypot(px - half, py - half) / half;
        return Math.max(0, Math.min(1, (t - 0.62) / 0.4)) * 0.5;
      },
      seed + 91,
    );
    const tex = new CanvasTexture(canvas);
    return finish(tex, { srgb: false, repeat: false });
  });
}

/**
 * Hard-edged star burst: muzzle flash / impact spike. PAPER core → GOLD →
 * HOT fringe, with ink spikes. Two hues max, saturated, zero blur.
 */
export function makeStarBurstTexture(points = 9, size = 256, seed = 1): Texture {
  const key = `starburst:${points}:${size}:${seed}`;
  return cached(key, () => {
    const { canvas, ctx } = makeCanvas(size);
    const half = size * 0.5;
    const rnd = makeSeededRandom(seed * 131 + 7);

    const star = (outer: number, innerRatio: number, jitterAmt: number, phase: number): number[] => {
      const pts: number[] = [];
      const n = points * 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + phase;
        const isOuter = i % 2 === 0;
        const base = isOuter ? outer : outer * innerRatio;
        const r = base * (1 + rnd.spread(jitterAmt));
        pts.push(half + Math.cos(a) * r, half + Math.sin(a) * r);
      }
      return pts;
    };

    const phase = rnd.range(0, Math.PI);
    // Long thin ink spikes shooting past the body of the star.
    for (let i = 0; i < points; i++) {
      const a = (i / points) * Math.PI * 2 + phase + rnd.spread(0.1);
      const r = half * rnd.range(0.86, 1.0);
      taperStroke(
        ctx,
        [half + Math.cos(a) * half * 0.2, half + Math.sin(a) * half * 0.2, half + Math.cos(a) * r, half + Math.sin(a) * r],
        half * 0.16, 0.4,
        { color: cssOf(rgb8('HOT')), seed: seed + i * 11, jitter: 1.5 },
      );
    }
    roughPolygon(ctx, star(half * 0.8, 0.42, 0.12, phase), cssOf(rgb8('HOT')), null, { seed: seed + 1, jitter: 2 });
    roughPolygon(ctx, star(half * 0.6, 0.4, 0.1, phase + 0.15), cssOf(rgb8('RUST')), null, { seed: seed + 2, jitter: 1.6 });
    roughPolygon(ctx, star(half * 0.44, 0.44, 0.09, phase + 0.05), cssOf(rgb8('GOLD')), null, { seed: seed + 3, jitter: 1.4 });
    roughPolygon(ctx, star(half * 0.22, 0.5, 0.1, phase + 0.3), tint('GOLD', 0.75), null, { seed: seed + 4, jitter: 1.1 });
    const tex = new CanvasTexture(canvas);
    return finish(tex, { srgb: true, repeat: false });
  });
}

/**
 * Banded colour ramp for toon lookups, skies and fog. Hard steps, no smoothing —
 * a colourist's flat wash (ART_DIRECTION §6).
 *
 * @param colors palette VALUES (e.g. `PALETTE.NIGHT_A`), first = u0, last = u1
 * @param steps  number of hard bands
 */
export function makeGradientRamp(colors: readonly number[], steps = 6): Texture {
  const key = `ramp:${colors.join('-')}:${steps}`;
  return cached(key, () => {
    const n = Math.max(2, steps | 0);
    const data = new Uint8Array(n * 4 * 4);
    const stops = colors.length > 1 ? colors : [colors[0] ?? PALETTE.PAPER, colors[0] ?? PALETTE.PAPER];
    for (let i = 0; i < n; i++) {
      // Quantise to the band centre so every band is a flat, deliberate colour.
      const t = n > 1 ? i / (n - 1) : 0;
      const f = t * (stops.length - 1);
      const i0 = Math.min(stops.length - 1, Math.floor(f));
      const i1 = Math.min(stops.length - 1, i0 + 1);
      const c = mix8(rgb8Hex(stops[i0] as number), rgb8Hex(stops[i1] as number), f - i0);
      for (let row = 0; row < 4; row++) {
        const o = (row * n + i) * 4;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
        data[o + 3] = 255;
      }
    }
    const tex = new DataTexture(data, n, 4, RGBAFormat, UnsignedByteType);
    finish(tex, { srgb: true, repeat: false, mips: false, nearest: true });
    return tex;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. COMIC SURFACES
//    Not photoreal. These are INKED COMIC BACKGROUNDS: 2–3 flat tones, black
//    linework, hatching for shadow, halftone for mid-tone. Every one tiles.
// ═════════════════════════════════════════════════════════════════════════════

export interface SurfaceTextureSet {
  /** sRGB colour map, tiling. */
  map: Texture;
  /**
   * Greyscale "how broken up is this surface" map, tiling. Not PBR roughness —
   * the ink material uses it to modulate halftone density and rim response.
   */
  roughnessLike: Texture;
}

export interface SurfaceOptions {
  size?: number;
  seed?: number;
}

/** Paint quantised flat tone blocks — the colourist's base wash under the linework. */
function paintFlatTones(
  ctx: CanvasRenderingContext2D,
  size: number,
  tones: readonly RGB8[],
  freq: number,
  seed: number,
  speckle = 0.05,
): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const period = Math.max(2, Math.round(freq));
  const scale = period / size;
  const n = tones.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = fbm2D(x * scale, y * scale, { octaves: 4, period, seed }) * 0.5 + 0.5;
      let idx = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
      if (hash2(x, y, seed + 7) < speckle) idx = Math.min(n - 1, idx + 1);
      const c = tones[idx] as RGB8;
      const i = (y * size + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Greyscale companion map derived from the same noise field. */
function buildRoughnessLike(size: number, freq: number, seed: number, bias: number): Texture {
  const { canvas, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const period = Math.max(2, Math.round(freq));
  const scale = period / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = fbm2D(x * scale, y * scale, { octaves: 4, period, seed: seed + 500 }) * 0.5 + 0.5;
      const band = Math.round(Math.max(0, Math.min(1, v * 0.8 + bias)) * 4) / 4;
      const g = Math.round(band * 255);
      const i = (y * size + x) * 4;
      d[i] = g;
      d[i + 1] = g;
      d[i + 2] = g;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  return finish(tex, { srgb: false, repeat: true });
}

function surfaceCached(key: string, build: () => SurfaceTextureSet): SurfaceTextureSet {
  const hit = _sets.get(key);
  if (hit) return hit;
  const set = build();
  register(`${key}:map`, set.map);
  register(`${key}:rough`, set.roughnessLike);
  _sets.set(key, set);
  return set;
}

/** Branching crack linework — recursive, tapered, wrapped across the seam. */
function drawCracks(
  ctx: CanvasRenderingContext2D,
  size: number,
  rnd: SeededRandom,
  count: number,
  ink: string,
  baseWidth: number,
): void {
  const branch = (x: number, y: number, angle: number, len: number, width: number, depth: number): void => {
    if (depth > 3 || len < size * 0.03 || width < 0.4) return;
    const segs = 3 + Math.floor(rnd.next() * 3);
    const pts: number[] = [x, y];
    let px = x;
    let py = y;
    let a = angle;
    for (let i = 0; i < segs; i++) {
      a += rnd.spread(0.55);
      px += Math.cos(a) * (len / segs);
      py += Math.sin(a) * (len / segs);
      pts.push(px, py);
    }
    taperStroke(ctx, pts, width, width * 0.25, { color: ink, seed: rnd.int(0, 9999), jitter: 1.6, step: 5 });
    if (rnd.bool(0.75)) branch(px, py, a + rnd.spread(0.9), len * rnd.range(0.4, 0.7), width * 0.6, depth + 1);
    if (rnd.bool(0.5)) {
      const t = rnd.range(0.3, 0.7);
      const bx = x + (px - x) * t;
      const by = y + (py - y) * t;
      branch(bx, by, angle + rnd.sign() * rnd.range(0.6, 1.3), len * rnd.range(0.35, 0.6), width * 0.55, depth + 1);
    }
  };
  for (let i = 0; i < count; i++) {
    branch(rnd.range(0, size), rnd.range(0, size), rnd.range(0, Math.PI * 2), size * rnd.range(0.22, 0.5), baseWidth, 0);
  }
}

/** Inked concrete: flat greys, spidering cracks, chipped corners, hatched shadow. */
export function makeCrackedConcrete(opts: SurfaceOptions = {}): SurfaceTextureSet {
  const size = opts.size ?? 512;
  const seed = opts.seed ?? 1;
  return surfaceCached(`concrete:${size}:${seed}`, () => {
    const { canvas, ctx } = makeCanvas(size);
    const rnd = makeSeededRandom(seed * 977 + 5);
    const ink = cssOf(rgb8('INK'));

    /**
     * Four flats, and their MEAN MATTERS. The ink shader does
     *   `albedo = mix(albedo, albedo * (0.55 + tex * 0.95), mapStrength)`
     * so a map is a multiplier centred on tex ≈ 0.47, not a colour. BUILD 001 painted these
     * around BONE (mean ≈ 0.67) which silently brightened every concrete surface in the game
     * by ~19% — part of why 33% of the frame sat above 0.7. They are now centred on
     * `CONCRETE`, so the map adds STRUCTURE without adding exposure, and the bucket's own
     * token decides the value. Spread is wide, mean is neutral.
     */
    const freq = 3;
    paintFlatTones(
      ctx, size,
      [rgb8Mix('CONCRETE', 'INK_SOFT', 0.5), rgb8Mix('CONCRETE', 'INK', 0.2), rgb8('CONCRETE'), rgb8Mix('CONCRETE', 'PAPER', 0.4)],
      freq, seed, 0,
    );

    // Screen-tone the darker flats rather than leaving them flat.
    const scale = freq / size;
    halftoneField(
      ctx, 0, 0, size, size, 11, 15, cssOf(rgb8('INK')),
      (px, py) => {
        const v = fbm2D(px * scale, py * scale, { octaves: 4, period: freq, seed }) * 0.5 + 0.5;
        return Math.max(0, 0.42 - v) * 2.6;
      },
      seed + 3,
    );

    // Cracks: the loudest linework on the surface. Heavy, few, confident.
    drawWrapped(ctx, size, () => {
      drawCracks(ctx, size, makeSeededRandom(seed * 31 + 11), 3, ink, 5.5);
    });

    // Chips: hard-edged missing chunks with an ink lip and a PAPER highlight.
    drawWrapped(ctx, size, () => {
      const r2 = makeSeededRandom(seed * 61 + 3);
      for (let i = 0; i < 7; i++) {
        const cx = r2.range(0, size);
        const cy = r2.range(0, size);
        const r = r2.range(size * 0.012, size * 0.05);
        const pts: number[] = [];
        const n = 5 + r2.int(0, 4);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          const rr = r * r2.range(0.6, 1.35);
          pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        }
        roughPolygon(ctx, pts, shade('CONCRETE', 0.66), ink, { seed: i * 17 + 1, width: 2, jitter: 1.4 });
        ctx.save();
        ctx.globalAlpha = 0.7;
        taperStroke(ctx, [cx - r * 0.5, cy - r * 0.4, cx + r * 0.4, cy - r * 0.65], 2, 0.4, { color: tint('CONCRETE', 0.66), seed: i * 5 });
        ctx.restore();
      }
    });

    // Hatched shadow patches — the artist's pass, not the renderer's.
    const r3 = makeSeededRandom(seed * 13 + 9);
    for (let i = 0; i < 4; i++) {
      const w = r3.range(size * 0.12, size * 0.3);
      const h = r3.range(size * 0.1, size * 0.28);
      hatchRegion(ctx, r3.range(0, size - w), r3.range(0, size - h), w, h, {
        angleDeg: 34 + i * 15, spacing: r3.range(7, 12), width: 1.5, color: ink, alpha: 0.4, seed: seed + i * 41, dropout: 0.25,
      });
    }

    const tex = new CanvasTexture(canvas);
    return { map: finish(tex, { srgb: true, repeat: true }), roughnessLike: buildRoughnessLike(size >> 1, 7, seed, 0.25) };
  });
}

/** Inked sheet metal: cool flats, rust blooms with dot fringe, rivets, scratches. */
export function makeRustMetal(opts: SurfaceOptions = {}): SurfaceTextureSet {
  const size = opts.size ?? 512;
  const seed = opts.seed ?? 2;
  return surfaceCached(`rustmetal:${size}:${seed}`, () => {
    const { canvas, ctx } = makeCanvas(size);
    const rnd = makeSeededRandom(seed * 613 + 17);
    const ink = cssOf(rgb8('INK'));

    paintFlatTones(
      ctx, size,
      [rgb8Mix('INK_SOFT', 'INK', 0.35), rgb8Mix('INK_SOFT', 'BONE', 0.18), rgb8Mix('INK_SOFT', 'BONE', 0.34), rgb8Mix('BONE', 'INK_SOFT', 0.42)],
      5, seed, 0.03,
    );

    // Rust blooms: metaball patches in RUST, then a dot fringe so they read as printed.
    const patches = 5;
    for (let i = 0; i < patches; i++) {
      const cx = rnd.range(0, size);
      const cy = rnd.range(0, size);
      const r = rnd.range(size * 0.06, size * 0.16);
      drawWrapped(ctx, size, () => {
        const lobes = 4 + Math.floor(hash2(i, 3, seed) * 4);
        // Ink the outer contour of the bloom first — rust is a DRAWN shape here.
        for (let k = 0; k < lobes; k++) {
          const a = (k / lobes) * Math.PI * 2 + hash2(i, k, seed) * 1.4;
          const d = r * 0.55 * hash2(i, k + 9, seed);
          roughCircle(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.45 + hash2(i, k + 2, seed) * 0.5),
            cssOf(rgb8Mix('RUST', 'INK', 0.35)), cssOf(rgb8('INK')), { seed: i * 71 + k, width: 2.4, jitter: 1.6 });
        }
        // Second inner pass without ink so interior seams don't show.
        for (let k = 0; k < lobes; k++) {
          const a = (k / lobes) * Math.PI * 2 + hash2(i, k, seed) * 1.4;
          const d = r * 0.55 * hash2(i, k + 9, seed);
          roughCircle(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.45 + hash2(i, k + 2, seed) * 0.5) * 0.9,
            cssOf(rgb8Mix('RUST', 'INK', 0.35)), null, { seed: i * 71 + k });
        }
        for (let k = 0; k < lobes; k++) {
          const a = (k / lobes) * Math.PI * 2 + hash2(i, k + 5, seed) * 1.4;
          const d = r * 0.4 * hash2(i, k + 11, seed);
          roughCircle(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.28 + hash2(i, k + 4, seed) * 0.3),
            cssOf(rgb8('RUST')), null, { seed: i * 91 + k });
        }
      });
      halftoneField(
        ctx, Math.max(0, cx - r * 1.9), Math.max(0, cy - r * 1.9), r * 3.8, r * 3.8, 6, 45, cssOf(rgb8Mix('RUST', 'INK', 0.2)),
        (px, py) => {
          const t = Math.hypot(px - cx, py - cy) / (r * 1.7);
          return Math.max(0, Math.min(1, 1.15 - t)) * 0.85;
        },
        seed + i,
      );
    }

    // Panel seams + rivet rows.
    drawWrapped(ctx, size, () => {
      const seamY = size * 0.5;
      roughStroke(ctx, [-size * 0.1, seamY, size * 1.1, seamY], { color: ink, width: 4, jitter: 2, seed: seed + 1 });
      roughStroke(ctx, [size * 0.5, -size * 0.1, size * 0.5, size * 1.1], { color: ink, width: 3.2, jitter: 2, seed: seed + 2 });
      for (let i = 0; i < 9; i++) {
        const t = (i + 0.5) / 9;
        for (const [rx, ry] of [
          [t * size, seamY - 11] as const,
          [t * size, seamY + 11] as const,
          [size * 0.5 - 11, t * size] as const,
          [size * 0.5 + 11, t * size] as const,
        ]) {
          roughCircle(ctx, rx, ry, 4.6, cssOf(rgb8Mix('BONE', 'INK_SOFT', 0.45)), ink, { seed: i * 13 + 1, width: 1.8 });
          ctx.save();
          ctx.globalAlpha = 0.85;
          roughCircle(ctx, rx - 1.4, ry - 1.4, 1.5, tint('BONE', 0.55), null, { seed: i * 3 + 2 });
          ctx.restore();
        }
      }
    });

    // Scratches — bright, thin, confident.
    drawWrapped(ctx, size, () => {
      const r2 = makeSeededRandom(seed * 7 + 3);
      for (let i = 0; i < 26; i++) {
        const x0 = r2.range(0, size);
        const y0 = r2.range(0, size);
        const a = r2.range(0, Math.PI * 2);
        const l = r2.range(size * 0.03, size * 0.18);
        taperStroke(ctx, [x0, y0, x0 + Math.cos(a) * l, y0 + Math.sin(a) * l], r2.range(0.8, 2.2), 0.2, {
          color: tint('BONE', 0.5, 0.75), seed: i * 29 + 1, jitter: 1.6,
        });
      }
    });

    hatchRegion(ctx, 0, size * 0.5, size, size * 0.5, { angleDeg: 60, spacing: 13, width: 1.4, color: ink, alpha: 0.28, seed: seed + 77 });

    const tex = new CanvasTexture(canvas);
    return { map: finish(tex, { srgb: true, repeat: true }), roughnessLike: buildRoughnessLike(size >> 1, 5, seed, 0.3) };
  });
}

/** Inked planks: hard gap lines, drawn grain, knots, nails. */
export function makePlankWood(opts: SurfaceOptions & { planks?: number } = {}): SurfaceTextureSet {
  const size = opts.size ?? 512;
  const seed = opts.seed ?? 3;
  const planks = opts.planks ?? 4;
  return surfaceCached(`plank:${size}:${seed}:${planks}`, () => {
    const { canvas, ctx } = makeCanvas(size);
    const rnd = makeSeededRandom(seed * 331 + 29);
    const ink = cssOf(rgb8('INK'));
    const pw = size / planks;

    // Wide value spread between neighbouring boards — that contrast is what makes
    // planks read from across the arena instead of blurring into one brown wall.
    const tones: readonly string[] = [
      cssOf(rgb8Mix('BONE', 'INK', 0.5)),
      cssOf(rgb8Mix('BONE', 'RUST', 0.3)),
      cssOf(rgb8Mix('BONE', 'INK_SOFT', 0.14)),
      cssOf(rgb8Mix('BONE', 'INK', 0.33)),
    ];

    for (let p = 0; p < planks; p++) {
      const x0 = p * pw;
      ctx.fillStyle = tones[p % tones.length] as string;
      ctx.fillRect(x0, 0, pw + 1, size);

      // Screen tone on the darker boards.
      if (p % 2 === 0) {
        halftoneField(ctx, x0, 0, pw, size, 9, 15 + p * 15, cssOf(rgb8('INK')), () => 0.34, seed + p);
      }

      // Grain: fewer, heavier tapered strokes that bow around the knots.
      const grainCount = 5 + rnd.int(0, 4);
      for (let g = 0; g < grainCount; g++) {
        const gx = x0 + rnd.range(pw * 0.08, pw * 0.92);
        const bow = rnd.spread(pw * 0.14);
        const pts = [gx, -8, gx + bow, size * 0.33, gx - bow * 0.6, size * 0.66, gx + bow * 0.3, size + 8];
        taperStroke(ctx, pts, rnd.range(1.8, 3.6), rnd.range(0.5, 1.6), {
          color: shade('BONE', 0.85, 0.85),
          seed: p * 97 + g, jitter: 2.6, step: 14,
        });
      }

      // Knots: concentric wobble rings, dead centre of the plank's character.
      if (rnd.bool(0.75)) {
        const kx = x0 + rnd.range(pw * 0.25, pw * 0.75);
        const ky = rnd.range(size * 0.08, size * 0.92);
        const kr = rnd.range(pw * 0.1, pw * 0.22);
        for (let r = 3; r >= 1; r--) {
          roughCircle(ctx, kx, ky, kr * (r / 3), r === 1 ? shade('BONE', 0.85) : null, ink, {
            seed: p * 41 + r, width: 2.2 - r * 0.3, jitter: 1.2,
          });
        }
      }

      // Board shadow at the gap: hatched, not gradient.
      hatchRegion(ctx, x0, 0, pw * 0.2, size, { angleDeg: 78, spacing: 4.5, width: 1.7, color: ink, alpha: 0.6, seed: p * 7 + 1, dropout: 0.08 });
      // ...and a PAPER catch-light down the far edge, so each board has a lit side.
      hatchRegion(ctx, x0 + pw * 0.82, 0, pw * 0.18, size, { angleDeg: 78, spacing: 6, width: 1.4, color: tint('BONE', 0.7), alpha: 0.35, seed: p * 11 + 2, dropout: 0.3 });

      // The gap itself — the heaviest line in the texture.
      roughStroke(ctx, [x0, -10, x0 + rnd.spread(2), size * 0.5, x0, size + 10], {
        color: ink, width: 9, jitter: 1.8, seed: p * 53 + 3, step: 22,
      });

      // Nails.
      for (const ny of [size * 0.06, size * 0.94]) {
        const nx = x0 + pw * 0.5 + rnd.spread(pw * 0.15);
        roughCircle(ctx, nx, ny, 3.4, cssOf(rgb8Mix('INK_SOFT', 'BONE', 0.35)), ink, { seed: p * 11 + 5, width: 1.6 });
        roughCircle(ctx, nx - 1, ny - 1, 1.1, tint('BONE', 0.6), null, { seed: p * 19 + 7 });
      }
    }

    // Splits across the whole board run.
    drawWrapped(ctx, size, () => {
      drawCracks(ctx, size, makeSeededRandom(seed * 17 + 7), 2, ink, 2.2);
    });

    const tex = new CanvasTexture(canvas);
    return { map: finish(tex, { srgb: true, repeat: true }), roughnessLike: buildRoughnessLike(size >> 1, 9, seed, 0.2) };
  });
}

/** Inked brickwork: running bond, per-brick flats, mortar ink, hatched underside. */
export function makeBrick(opts: SurfaceOptions & { rows?: number; cols?: number } = {}): SurfaceTextureSet {
  const size = opts.size ?? 512;
  const seed = opts.seed ?? 4;
  const rows = opts.rows ?? 8;
  const cols = opts.cols ?? 4;
  return surfaceCached(`brick:${size}:${seed}:${rows}:${cols}`, () => {
    const { canvas, ctx } = makeCanvas(size);
    const ink = cssOf(rgb8('INK'));
    const bh = size / rows;
    const bw = size / cols;

    // Mortar bed.
    ctx.fillStyle = cssOf(rgb8Mix('BONE', 'INK_SOFT', 0.55));
    ctx.fillRect(0, 0, size, size);
    halftoneField(ctx, 0, 0, size, size, 5, 15, cssOf(rgb8Mix('INK_SOFT', 'INK', 0.3)), () => 0.4, seed + 2);

    const brickTones: readonly string[] = [
      cssOf(rgb8Mix('RUST', 'INK', 0.45)),
      cssOf(rgb8Mix('RUST', 'INK', 0.3)),
      cssOf(rgb8Mix('BONE', 'RUST', 0.55)),
      cssOf(rgb8Mix('RUST', 'INK_SOFT', 0.55)),
      cssOf(rgb8Mix('BONE', 'INK', 0.45)),
    ];

    for (let r = 0; r < rows; r++) {
      const offset = r % 2 === 0 ? 0 : bw * 0.5;
      for (let c = -1; c <= cols; c++) {
        const bx = c * bw + offset;
        const by = r * bh;
        const gap = Math.max(2.5, bh * 0.09);
        const x0 = bx + gap * 0.5;
        const y0 = by + gap * 0.5;
        const w = bw - gap;
        const h = bh - gap;
        const id = r * 97 + ((c + 8) % (cols + 2)) * 13;
        const tone = brickTones[Math.floor(hash2(r, (c + cols * 2) % cols, seed) * brickTones.length) % brickTones.length] as string;

        const jx = (hash2(r, c, seed + 1) - 0.5) * 2.2;
        const jy = (hash2(r, c, seed + 2) - 0.5) * 1.6;
        roughPolygon(
          ctx,
          [x0 + jx, y0 + jy, x0 + w + jx, y0 - jy, x0 + w - jx, y0 + h + jy, x0 - jx, y0 + h - jy],
          tone, ink,
          { seed: id, width: 2.6, jitter: 1.5, step: 10 },
        );

        // A third of the bricks get screen tone, a few get hatching. Never all.
        const roll = hash2(r, c, seed + 3);
        if (roll < 0.33) {
          halftoneField(ctx, x0, y0, w, h, 6, 15 + (r % 3) * 15, cssOf(rgb8('INK')), () => 0.42, id);
        } else if (roll > 0.86) {
          hatchRegion(ctx, x0, y0, w, h, { angleDeg: 40, spacing: 6, width: 1.3, color: ink, alpha: 0.45, seed: id + 5, dropout: 0.2 });
        }
        // Contact shadow along the bottom edge — hatched, hard-edged.
        hatchRegion(ctx, x0, y0 + h * 0.72, w, h * 0.28, { angleDeg: 20, spacing: 4.5, width: 1.2, color: ink, alpha: 0.4, seed: id + 9, dropout: 0.15 });
        // Chipped corner.
        if (hash2(r, c, seed + 4) > 0.8) {
          const cxp = hash2(r, c, seed + 5) > 0.5 ? x0 + w : x0;
          const cyp = hash2(r, c, seed + 6) > 0.5 ? y0 + h : y0;
          roughCircle(ctx, cxp, cyp, Math.min(w, h) * 0.18, cssOf(rgb8Mix('BONE', 'INK_SOFT', 0.5)), ink, { seed: id + 11, width: 1.6 });
        }
      }
    }

    drawWrapped(ctx, size, () => {
      drawCracks(ctx, size, makeSeededRandom(seed * 23 + 3), 2, ink, 2.4);
    });

    const tex = new CanvasTexture(canvas);
    return { map: finish(tex, { srgb: true, repeat: true }), roughnessLike: buildRoughnessLike(size >> 1, 11, seed, 0.28) };
  });
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * INKED FACADE — one tile is ONE STOREY.
 *
 * The BUILD 002 diagnosis, verbatim: "large wall faces are empty flat screened planes with no
 * linework, signage or damage". `mass` (every building in the city, and by far the biggest
 * vertical area in the frame) was drawing a 2.5 m brick tile stretched over a 34 m slab.
 *
 * This is the answer, and it is the cheapest one available: a texture costs ZERO draw calls
 * and ZERO triangles, and the arena's UVs are world-space metres, so setting `mapScale` to
 * `1 / STOREY` makes one tile of this texture exactly one floor of the building. Every line
 * in here then lands where a building's lines actually land — the string course sits at the
 * floor plate, the pilasters run the full storey, the soot bleeds DOWN from the course.
 *
 * It deliberately contains NO windows: the arena stamps real window geometry on a 4.2 m × 3.4 m
 * grid, and a second, painted set of windows at a different pitch would read as a print error.
 * What it contains is everything BETWEEN the windows, which is what was missing.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function makeFacade(opts: SurfaceOptions = {}): SurfaceTextureSet {
  const size = opts.size ?? 512;
  const seed = opts.seed ?? 7;
  return surfaceCached(`facade:${size}:${seed}`, () => {
    const { canvas, ctx } = makeCanvas(size);
    const rnd = makeSeededRandom(seed * 449 + 13);
    const ink = cssOf(rgb8('INK'));

    /**
     * A SURFACE MAP IS A VALUE MAP, NOT A COLOUR. The ink shader multiplies:
     *   `albedo = mix(albedo, albedo * (0.55 + tex * 0.95), mapStrength)`
     * so what a map contributes is entirely its own DYNAMIC RANGE, and a texture painted in
     * the same dark family as the flat it modulates contributes nothing. The first draft of
     * this file painted four SLATE-family tones (0.25–0.45), which multiplied the wall by
     * 0.79–0.98 — a 19% swing, invisible at 20 m, and the buildings stayed the flat slabs
     * the diagnosis complained about.
     *
     * These four span 0.19 → 0.73 around a ~0.45 mean: the wall keeps its `SLATE` hue and
     * its authored value, and the texture supplies a 0.73×–1.24× swing of STRUCTURE on top.
     * The hue still comes from the bucket. The map only ever decides light and dark.
     */
    paintFlatTones(
      ctx, size,
      [
        rgb8Mix('SLATE', 'INK', 0.42),
        rgb8('SLATE'),
        rgb8Mix('SLATE', 'CONCRETE', 0.62),
        rgb8('BONE'),
      ],
      4, seed, 0.04,
    );

    // ── Storey structure. The two horizontals are the whole point. ──────────
    const courseY = size * 0.085;          // string course, just above the floor plate
    const spandrelY = size * 0.72;         // the band under the next floor's sill line
    // A lighter render band above the course: the storey now has a top and a bottom.
    ctx.fillStyle = cssOf(rgb8Mix('SLATE', 'BONE', 0.34));
    ctx.fillRect(0, 0, size, courseY);
    halftoneField(ctx, 0, 0, size, courseY, 7, 15, ink, () => 0.3, seed + 21);
    roughStroke(ctx, [-size * 0.1, courseY, size * 1.1, courseY + rnd.spread(2)],
      { color: ink, width: 6.5, jitter: 2.2, seed: seed + 1, step: 26 });
    roughStroke(ctx, [-size * 0.1, spandrelY, size * 1.1, spandrelY + rnd.spread(2)],
      { color: ink, width: 3.4, jitter: 2.0, seed: seed + 2, step: 30 });

    // ── Pilasters: two verticals, so a bay has a width as well as a height. ─
    for (const px of [size * 0.28, size * 0.74]) {
      const w = size * 0.055;
      ctx.fillStyle = cssOf(rgb8Mix('SLATE', 'BONE', 0.16));
      ctx.fillRect(px, courseY, w, size - courseY);
      // Lit edge / shadow edge — a pilaster is a value pair or it is a stripe.
      hatchRegion(ctx, px + w * 0.58, courseY, w * 0.42, size - courseY, {
        angleDeg: 82, spacing: 4, width: 1.5, color: ink, alpha: 0.55, seed: seed + 31, dropout: 0.1,
      });
      roughStroke(ctx, [px, courseY, px + rnd.spread(1.6), size + 8],
        { color: ink, width: 2.6, jitter: 1.4, seed: seed + 41, step: 24 });
    }

    // ── Rain and soot streaks, bleeding DOWN from the course. The single most
    //    "lived-in" mark a building can carry, and it is four strokes. ───────
    for (let i = 0; i < 9; i++) {
      const x = rnd.range(0, size);
      const len = rnd.range(size * 0.18, size * 0.62);
      taperStroke(ctx, [x, courseY + 2, x + rnd.spread(5), courseY + len],
        rnd.range(3, 9), 0.6,
        { color: shade('SLATE', 0.76, 0.6), seed: i * 37 + 3, jitter: 2.4, step: 16 });
    }

    // ── Patched render: irregular polygons where the skin came off. ─────────
    drawWrapped(ctx, size, () => {
      const r2 = makeSeededRandom(seed * 97 + 5);
      for (let i = 0; i < 3; i++) {
        const cx = r2.range(0, size);
        const cy = r2.range(courseY, size);
        const r = r2.range(size * 0.05, size * 0.13);
        const pts: number[] = [];
        const n = 6 + r2.int(0, 4);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          const rr = r * r2.range(0.55, 1.4);
          pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        }
        // The patch is BRICK showing through — a second hue, and only a second one.
        roughPolygon(ctx, pts, cssOf(rgb8Mix('RUST', 'INK', 0.5)), ink,
          { seed: i * 23 + 7, width: 2.4, jitter: 1.7, step: 9 });
        halftoneField(ctx, cx - r, cy - r, r * 2, r * 2, 6, 45, ink, () => 0.4, seed + i);
      }
    });

    // ── Damage: a couple of confident cracks and a hatched corner. ──────────
    drawWrapped(ctx, size, () => {
      drawCracks(ctx, size, makeSeededRandom(seed * 19 + 3), 2, ink, 3.2);
    });
    hatchRegion(ctx, 0, size * 0.78, size * 0.34, size * 0.22, {
      angleDeg: 38, spacing: 8, width: 1.6, color: ink, alpha: 0.42, seed: seed + 61, dropout: 0.22,
    });

    const tex = new CanvasTexture(canvas);
    return { map: finish(tex, { srgb: true, repeat: true }), roughnessLike: buildRoughnessLike(size >> 1, 6, seed, 0.26) };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 7b. WALL DRESSING ATLASES
//
//   A decal is a quad with a hand-picked cell of one atlas in its UVs, which means an
//   arbitrary number of DIFFERENT painted signs costs exactly one texture, one material and
//   one draw call. This is where "AAA production value" is actually bought on a flat wall:
//   the wall is not more detailed, it is more *inhabited*.
//
//   Both sheets are drawn OPAQUE with an ink border, because a comic wall sign is a painted
//   rectangle, not a soft alpha blend. They are pasted a few centimetres proud of the facade.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Bold condensed system fonts only — these ship with the OS, so this is not an "asset".
 * Kept local rather than imported from `art/letters.ts`: letters.ts imports THIS file, and a
 * cycle for the sake of one string is not worth it. Keep the two in step.
 */
const SIGN_FONT_STACK =
  'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", "Franklin Gothic Heavy", sans-serif';

/** Roughened block lettering, fitted to a box. The painted-sign look, not the SFX look. */
function paintedWord(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  maxW: number,
  h: number,
  fill: string,
  ink: string | null,
  rotate: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotate);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let fs = h;
  ctx.font = `900 ${fs}px ${SIGN_FONT_STACK}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    fs = Math.max(6, fs * (maxW / w));
    ctx.font = `900 ${fs}px ${SIGN_FONT_STACK}`;
  }
  if (ink) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(2, fs * 0.14);
    ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** Chew the edges of the last-drawn rect so nothing on a wall is machine-straight. */
function weatherCell(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  rnd: SeededRandom, ink: string, amount: number,
): void {
  // Flaked paint: small polygons of the wall showing back through.
  const flakes = Math.round(amount * 14);
  for (let i = 0; i < flakes; i++) {
    const fx = x + rnd.range(0, w);
    const fy = y + rnd.range(0, h);
    const r = rnd.range(w * 0.01, w * 0.06);
    const pts: number[] = [];
    const n = 5 + rnd.int(0, 3);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      pts.push(fx + Math.cos(a) * r * rnd.range(0.5, 1.3), fy + Math.sin(a) * r * rnd.range(0.5, 1.3));
    }
    roughPolygon(ctx, pts, cssOf(rgb8Mix('SLATE', 'INK_SOFT', 0.3)), null, { seed: i * 13 + 3, jitter: 1.2 });
  }
  // Halftone the bottom third: a sign is dirtier where the street splashes it.
  halftoneField(ctx, x, y + h * 0.62, w, h * 0.38, 7, 15, ink,
    (px, py) => ((py - (y + h * 0.62)) / (h * 0.38)) * 0.7 * amount, 91);
  // Ink border, drawn last so it survives the weathering.
  roughPolygon(ctx, [x + 2, y + 2, x + w - 2, y + 2, x + w - 2, y + h - 2, x + 2, y + h - 2],
    null, ink, { seed: 5, width: 4, jitter: 2.2, step: 22 });
}

/**
 * BIG PAINTED WALL ADVERTISING — a 2×2 atlas of full-facade ghost signs.
 *
 * Every cell is one hue plus PAPER, per ART §1's two-hue rule, and none of them is `ACID` or
 * `HOT`: a wall-sized surface in an enemy hue would destroy the reserved channel (ART §9).
 * They are the strongest value contrast on the buildings and they are what the eye reads
 * across the plaza — which is exactly the job a real painted sign has.
 */
export function makeWallAdSheet(size = 512): Texture {
  return cached(`walladsheet:${size}`, () => {
    const { canvas, ctx } = makeCanvas(size);
    const ink = cssOf(rgb8('INK'));
    const half = size / 2;

    // [word, sub, ground token, letter token, weathering]
    const cells: readonly (readonly [string, string, PaletteToken, PaletteToken, number])[] = [
      ['DELUXE', 'FURNITURE CO', 'NIGHT_B', 'PAPER', 0.9],
      ['COLA', 'ICE COLD 5c', 'RUST', 'PAPER', 0.6],
      ['HOTEL', 'ROOMS 50c', 'PAPER', 'SLATE', 0.75],
      ['WORKS', 'EST. 1931', 'TEAL', 'BONE', 1.0],
    ];

    for (let i = 0; i < 4; i++) {
      const cx0 = (i % 2) * half;
      const cy0 = Math.floor(i / 2) * half;
      const cell = cells[i] as readonly [string, string, PaletteToken, PaletteToken, number];
      const [word, sub, ground, letters, wear] = cell;
      const rnd = makeSeededRandom(i * 733 + 17);

      ctx.fillStyle = cssOf(rgb8(ground));
      ctx.fillRect(cx0, cy0, half, half);
      // A flat second tone as a banner behind the word — sign painters build in blocks.
      ctx.fillStyle = cssOf(rgb8Mix(ground, letters, 0.18));
      ctx.fillRect(cx0 + half * 0.06, cy0 + half * 0.24, half * 0.88, half * 0.34);

      paintedWord(ctx, word, cx0 + half * 0.5, cy0 + half * 0.41, half * 0.84, half * 0.3,
        cssOf(rgb8(letters)), ink, rnd.spread(0.02));
      paintedWord(ctx, sub, cx0 + half * 0.5, cy0 + half * 0.68, half * 0.72, half * 0.1,
        cssOf(rgb8Mix(letters, ground, 0.25)), null, rnd.spread(0.015));

      // Rules above and below the type — the classic hand-lettered sign furniture.
      for (const ry of [cy0 + half * 0.19, cy0 + half * 0.78]) {
        roughStroke(ctx, [cx0 + half * 0.08, ry, cx0 + half * 0.92, ry + rnd.spread(2)],
          { color: cssOf(rgb8(letters)), width: half * 0.018, jitter: 1.6, seed: i * 11 + 3 });
      }
      weatherCell(ctx, cx0, cy0, half, half, rnd, ink, wear);
    }

    const tex = new CanvasTexture(canvas);
    return finish(tex, { srgb: true, repeat: false });
  });
}

/**
 * FLY-POSTED BILLS — a 4×4 atlas of small pasted posters for street level.
 *
 * Sixteen scraps of paper at 0.9 m, clustered around doorways and at the base of every blank
 * wall. Individually they are nothing; as a rhythm along a 140 m street they are the
 * difference between a set and a city. Type is drawn as BARS, not letters — at the size these
 * appear on screen a real word would be unreadable mush, and bars read as "text" instantly.
 */
export function makePosterSheet(size = 512): Texture {
  return cached(`postersheet:${size}`, () => {
    const { canvas, ctx } = makeCanvas(size);
    const ink = cssOf(rgb8('INK'));
    const c = size / 4;
    const grounds: readonly PaletteToken[] = ['PAPER', 'BONE', 'SODIUM', 'TEAL', 'NIGHT_B', 'RUST'];

    for (let i = 0; i < 16; i++) {
      const x0 = (i % 4) * c;
      const y0 = Math.floor(i / 4) * c;
      const rnd = makeSeededRandom(i * 311 + 29);
      const ground = grounds[i % grounds.length] as PaletteToken;
      const dark = ground === 'PAPER' || ground === 'BONE' || ground === 'SODIUM';
      const type = dark ? 'INK' : 'PAPER';

      // The sheet, torn and pasted slightly off-square.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, c, c);
      ctx.clip();
      ctx.fillStyle = cssOf(rgb8Mix('SLATE', 'INK_SOFT', 0.4));
      ctx.fillRect(x0, y0, c, c);
      const pad = c * 0.06;
      const pts: number[] = [];
      const corners: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (const [ux, uy] of corners) {
        pts.push(x0 + pad + ux * (c - pad * 2) + rnd.spread(c * 0.035),
          y0 + pad + uy * (c - pad * 2) + rnd.spread(c * 0.035));
      }
      roughPolygon(ctx, pts, cssOf(rgb8(ground)), ink, { seed: i * 7 + 1, width: 2.6, jitter: 2.4, step: 8 });

      // A headline bar, a block of "body text" bars, and sometimes a big shape.
      const tx = x0 + c * 0.16;
      const tw = c * 0.68;
      ctx.fillStyle = cssOf(rgb8(type as PaletteToken));
      ctx.fillRect(tx, y0 + c * 0.18, tw * rnd.range(0.7, 1), c * 0.1);
      if (rnd.bool(0.45)) {
        roughCircle(ctx, x0 + c * 0.5, y0 + c * 0.5, c * rnd.range(0.13, 0.2),
          cssOf(rgb8Mix(type as PaletteToken, ground, 0.35)), ink, { seed: i * 5, width: 2 });
      }
      for (let k = 0; k < 5; k++) {
        const ly = y0 + c * (0.62 + k * 0.055);
        ctx.fillRect(tx, ly, tw * rnd.range(0.35, 1), c * 0.022);
      }
      // Screen tone + a torn corner, so no two read the same at a glance.
      halftoneField(ctx, x0, y0, c, c, 6, 15 + (i % 4) * 15, ink, () => 0.22, i + 3);
      if (rnd.bool(0.5)) {
        const cxp = x0 + (rnd.bool() ? c * 0.94 : c * 0.06);
        const cyp = y0 + (rnd.bool() ? c * 0.94 : c * 0.06);
        roughCircle(ctx, cxp, cyp, c * 0.13, cssOf(rgb8Mix('SLATE', 'INK_SOFT', 0.4)), null, { seed: i * 3 + 9 });
      }
      ctx.restore();
    }

    const tex = new CanvasTexture(canvas);
    return finish(tex, { srgb: true, repeat: false });
  });
}

/** Every surface family, keyed by the engine's `SurfaceKind`-ish names. */
export function makeSurfaceLibrary(size = 512): Record<'concrete' | 'metal' | 'wood' | 'brick' | 'facade', SurfaceTextureSet> {
  return {
    concrete: makeCrackedConcrete({ size }),
    metal: makeRustMetal({ size }),
    wood: makePlankWood({ size }),
    brick: makeBrick({ size }),
    facade: makeFacade({ size }),
  };
}

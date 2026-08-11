/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WEAPON SURFACES — procedural break-up maps for the viewmodel
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE PROBLEM THIS FILE EXISTS TO SOLVE
 *
 *   *"i dont like how all the guns have like gray lines on top of it, they look bad, we need to
 *   truly make models that look good"* — the playtester.
 *
 * The guns are flat colour fields. The fix is SURFACE, not more geometry: under a 7 px
 * screen-space inverted hull at 0.30 m from the eye, anything you bolt on turns to grey mush
 * (`docs/WEAPON_ART.md` §0). A map costs zero triangles, zero draw calls, and cannot be eaten by
 * the ink line.
 *
 * ── THE ONE RULE (WEAPON_ART §0) ────────────────────────────────────────────────────────────
 * BOLD. Few, large, high-contrast marks. TWO VALUES PER PATTERN, hard-edged, plus linework.
 * Wood grain is 3–4 broad bands, not 40 fine lines. Vents are 3 big slots, not 8 thin ones.
 * Knurling is a diamond you could COUNT. If you cannot see the mark from across a room at
 * thumbnail size, it is too fine — so nothing in here is drawn below ~2 % of the tile.
 *
 * ── HOW THIS PLUGS IN (the environment's mechanism, reused verbatim) ────────────────────────
 * Every generator returns the **same `SurfaceTextureSet`** shape `art/textures` returns for
 * concrete / rust / planks / brick / facades: `{ map, roughnessLike }`. `map` goes straight into
 * `makeInkMaterial({ map, mapStrength, mapScale, mapHalftone })`. There is no second mechanism.
 *
 * ── WHY THESE MAPS ARE GREY AND THE ENVIRONMENT'S ARE COLOURED ──────────────────────────────
 * The ink shader does, in LINEAR space:
 *
 *     albedo = mix(albedo, albedo * (0.55 + tex.rgb * 0.95), uMapStrength)
 *
 * — the map is a **multiplier**, never a colour. The environment sets exploit that loosely by
 * painting near their own token. A weapon cannot afford that: the gun's three fields are
 * authored at specific values (polymer 0.29 / frame 0.44 / steel 0.57, all under
 * `ENV_VALUE_CEIL` 0.78) and a map that quietly re-tints them breaks the palette law. So these
 * maps are authored **directly in multiplier space**: a texel is encoded so that the shader
 * lands on an exact target value, and mid-grey `rgb(183,183,183)` is the identity — it leaves
 * the base colour untouched. That is what "modulate, never replace" means in numbers.
 *
 * `base` is therefore not decoration: it is what tells a generator its HEADROOM. A 0.29 polymer
 * can only be darkened so far before it falls through `ENV_VALUE_FLOOR`; a 0.57 steel can only be
 * lifted so far before it hits the ceiling reserved for enemies and practicals. Every tone is
 * clamped against the real base, in linear luminance, before it is encoded.
 *
 * ── NO BAKED HALFTONE (this is the one place we deliberately differ from the env sets) ───────
 * `makeCrackedConcrete` and friends bake dot fields into the map. Correct at 2–30 m. WRONG here:
 * ART §4.1 — *the print is fixed, only the drawing moves*. A dot baked into a texture on an
 * object 0.30 m from the eye is a dot the size of a thumbnail that swims when the gun sways, and
 * it beats against the screen-space lattice in `INK_GLOBALS.uHalftonePitch`. Weapon screen-tone
 * comes from the material: the shader already turns map darkness into printed dots via
 * `uMapHalftone`, in screen space, at the frame's own pitch. So: no baked dots in this file.
 *
 * ── COST ────────────────────────────────────────────────────────────────────────────────────
 * Default 256 px colour + 128 px break-up. These are seen on parts a few centimetres across at
 * 0.30 m; 256 is already more than one texel per screen pixel, and the marks are 5–50 px wide so
 * they stay hard-edged through mip 0–1. Six surfaces ≈ 2 MB of VRAM, built ONCE at boot, cached
 * by argument. Nothing in here allocates after boot.
 */

import {
  CanvasTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';

import { PALETTE, READABILITY, hexMix } from '@/art/palette';
import {
  drawWrapped,
  makeCanvas,
  makeSeededRandom,
  roughCircle,
  type SeededRandom,
  type SurfaceTextureSet,
} from '@/art/textures';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE GUN'S VALUE LADDER
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The three (four) flat fields a gun is allowed, as sRGB hex, derived from palette tokens so the
 * set stays small (ART §1: *in-between values are blends, not new tokens*).
 *
 * Measured luma: polymer 0.289 · frame 0.441 · steel 0.570 · wood 0.434 — the spread
 * `WEAPON_ART.md` §2 asks for, every one of them under `ENV_VALUE_CEIL` (0.78) and above
 * `ENV_VALUE_FLOOR` (0.12). These are *suggestions* for the viewmodel's materials; a generator
 * will happily modulate whatever base it is handed.
 */
export const WEAPON_FIELD = {
  /** Grip, fore-end, stock — the parts a hand touches. Cool, dark, matte. */
  polymer: hexMix(PALETTE.SLATE, PALETTE.INK_SOFT, 0.214),
  /** Receiver / frame — the mass of the gun. Neutral, dead centre of the midtone band. */
  frame: hexMix(PALETTE.SLATE, PALETTE.CONCRETE, 0.6),
  /** Bolt, charging handle, muzzle device — machined and a touch warm, so it separates. */
  steel: hexMix(PALETTE.CONCRETE, PALETTE.BONE, 0.238),
  /** Shotgun furniture / rifle stock. Walnut: BONE→RUST, dropped toward INK to sit at frame value. */
  wood: hexMix(hexMix(PALETTE.BONE, PALETTE.RUST, 0.45), PALETTE.INK, 0.35),
} as const;

/**
 * What to hand `makeInkMaterial` alongside one of these maps.
 *
 * · `mapStrength: 1` is not a taste call — these maps are authored as an EXACT modulation, so
 *   anything less silently compresses every mark toward flat. (If you must run lower, the mark
 *   you get is `1 + s * (m - 1)` of the mark authored.)
 * · `mapScale: 1` means one tile per UV unit. `bevelBox` faces are 0..1, so one tile per face,
 *   which is what the pattern sizes below are drawn for. Raise it only for a genuinely long part.
 * · `mapHalftone: 0.22` is deliberately below the environment's 0.35: the viewmodel is 0.30 m
 *   away and already carries the heaviest ink line in the game (7 px). Dot the map as hard as a
 *   wall and the gun goes muddy.
 */
export const WEAPON_SURFACE_MAP = {
  mapStrength: 1,
  mapScale: 1,
  mapHalftone: 0.22,
} as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. MULTIPLIER-SPACE ENCODING
//    The map is a multiplier, so we author multipliers and encode them at the end.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The shader's map curve: `mul = MAP_BIAS + tex * MAP_GAIN`, tex linear. */
const MAP_BIAS = 0.55;
const MAP_GAIN = 0.95;
/** Darkest a map can push a surface (texel 0). Below this is impossible — not a choice. */
const MUL_MIN = MAP_BIAS;
/** Brightest a map can push a surface (texel 1). */
const MUL_MAX = MAP_BIAS + MAP_GAIN;

const srgbToLinear = (u: number): number =>
  u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);

const linearToSrgb = (u: number): number =>
  u <= 0.0031308 ? u * 12.92 : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Linear RGB triple. Everything in the tone maths below lives here. */
type Lin = [number, number, number];

const linLuma = (c: Lin): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Value band from `READABILITY`, converted once into the linear space the shader multiplies in. */
const Y_FLOOR = srgbToLinear(READABILITY.ENV_VALUE_FLOOR);
const Y_CEIL = srgbToLinear(READABILITY.ENV_VALUE_CEIL);

/** sRGB hex → linear RGB. The space the shader's multiply actually happens in. */
function baseLin(hex: number): Lin {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ];
}

/**
 * Encode a desired OUTPUT colour as the css texel that makes the shader produce it over `base`.
 *
 * Per channel: `out = base * (0.55 + tex * 0.95)` ⇒ `tex = (out/base - 0.55) / 0.95`, then
 * re-encoded to sRGB because the map is uploaded as an sRGB texture and the sampler decodes it.
 * The multiplier is clamped to what the curve can express; a hue push on a very dark base is
 * therefore approximate, which is correct — a map may not invent a colour the base does not have.
 */
function encodeTone(base: Lin, out: Lin): string {
  const enc = (i: 0 | 1 | 2): number => {
    const b = Math.max(base[i], 0.002);
    const m = Math.min(MUL_MAX, Math.max(MUL_MIN, out[i] / b));
    return Math.round(255 * linearToSrgb(clamp01((m - MAP_BIAS) / MAP_GAIN)));
  };
  return `rgb(${enc(0)},${enc(1)},${enc(2)})`;
}

/**
 * Build one tone: scale the base by `mul`, optionally pull it `t` of the way toward a warm
 * accent, then hold the result inside the readability band before encoding.
 *
 * `allowInk` exempts a tone from the FLOOR — linework is allowed under it (ART §1: *the darks
 * below belong to ink*), a flat is not.
 */
function tone(base: Lin, mul: number, toward: Lin | null, t: number, allowInk = false): string {
  let out: Lin = [(base[0] as number) * mul, (base[1] as number) * mul, (base[2] as number) * mul];
  if (toward && t > 0) {
    out = [
      out[0] + (toward[0] - out[0]) * t,
      out[1] + (toward[1] - out[1]) * t,
      out[2] + (toward[2] - out[2]) * t,
    ];
  }
  const y = linLuma(out);
  if (y > 1e-5) {
    const lo = allowInk ? 0 : Y_FLOOR;
    const k = y > Y_CEIL ? Y_CEIL / y : y < lo ? lo / y : 1;
    if (k !== 1) out = [out[0] * k, out[1] * k, out[2] * k];
  }
  return encodeTone(base, out);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE FIVE INKS
//    A pattern gets a field, TWO values, linework, and one warm accent. That is the whole
//    vocabulary — WEAPON_ART §0 and ART §1 ("max 2 hues per material") both land on this.
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface Inks {
  /** The base, untouched. Multiplier 1.0 — mid grey. */
  field: string;
  /** The darker of the pattern's two values. */
  lo: string;
  /** The lighter of the pattern's two values. */
  hi: string;
  /** Hard linework. The map floor: 0.55×, the darkest the shader curve can go. */
  ink: string;
  /** RUST. The single warm accent the gun is allowed. */
  accent: string;
}

const RUST_LIN: Lin = baseLin(PALETTE.RUST);

/** Colour-pass inks for a given base and mark contrast. `spread` is the ± value swing at c = 1. */
function colourInks(base: number, contrast: number, spread: number): Inks {
  const b = baseLin(base);
  const c = clamp01(contrast);
  return {
    field: tone(b, 1, null, 0),
    lo: tone(b, 1 - spread * c, null, 0),
    hi: tone(b, 1 + spread * c, null, 0),
    ink: tone(b, MUL_MIN, null, 0, true),
    accent: tone(b, 0.95, RUST_LIN, 0.55),
  };
}

/**
 * Break-up-pass inks. Same geometry, different palette: the second canvas is the greyscale
 * "how broken up is this surface" companion every environment set ships. Quantised to quarters,
 * exactly like `buildRoughnessLike`, because it drives banded response, not a tonal wash.
 */
function breakupInks(intensity: number): Inks {
  const q = (t: number): string => {
    const g = Math.round(255 * (Math.round(clamp01(0.15 + t * intensity * 0.85) * 4) / 4));
    return `rgb(${g},${g},${g})`;
  };
  return { field: q(0.15), lo: q(0.75), hi: q(0.45), ink: q(1), accent: q(0.8) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. DRAWING PRIMITIVES
//    Hard-edged on purpose. `art/textures` roughStroke/roughPolygon are noise-displaced and do
//    NOT repeat across the tile seam; anything here that spans the whole tile uses a periodic
//    wobble instead so the map tiles exactly. Local marks still go through drawWrapped.
// ═════════════════════════════════════════════════════════════════════════════════════════════

function fillPoly(ctx: CanvasRenderingContext2D, pts: readonly number[], fill: string): void {
  if (pts.length < 6) return;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0] as number, pts[1] as number);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] as number, pts[i + 1] as number);
  ctx.closePath();
  ctx.fill();
}

function strokePath(
  ctx: CanvasRenderingContext2D,
  pts: readonly number[],
  color: string,
  width: number,
  closed = false,
): void {
  if (pts.length < 4) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0] as number, pts[1] as number);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] as number, pts[i + 1] as number);
  if (closed) ctx.closePath();
  ctx.stroke();
}

/**
 * A horizontal edge at height `t`, wobbled by a sum of two sines of the tile width. Exactly
 * periodic in x, so a band boundary drawn with it meets itself across the seam — which a
 * noise-displaced `roughStroke` does not.
 */
function wavyEdge(size: number, t: number, amp: number, phase: number, samples = 24): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = (i / samples) * size;
    const a = (x / size) * Math.PI * 2;
    pts.push(x, t * size + (Math.sin(a + phase) + Math.sin(a * 2 + phase * 1.7) * 0.45) * amp);
  }
  return pts;
}

/** A rectilinear blob: a rect with two rectangular steps bitten out. Blocky loss, not soft noise. */
function blockyPoly(rnd: SeededRandom, cx: number, cy: number, w: number, h: number): number[] {
  const x0 = cx - w * 0.5;
  const x1 = cx + w * 0.5;
  const y0 = cy - h * 0.5;
  const y1 = cy + h * 0.5;
  const sx = w * rnd.range(0.22, 0.46);
  const sy = h * rnd.range(0.22, 0.46);
  const tx = w * rnd.range(0.18, 0.4);
  const ty = h * rnd.range(0.18, 0.4);
  return [x0, y0, x1 - sx, y0, x1 - sx, y0 + sy, x1, y0 + sy, x1, y1, x0 + tx, y1, x0 + tx, y1 - ty, x0, y1 - ty];
}

/** A bevelled-corner capsule — a stamped slot, not a soft rounded rect. */
function bevelSlotPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const b = Math.min(w, h) * 0.34;
  ctx.beginPath();
  ctx.moveTo(x + b, y);
  ctx.lineTo(x + w - b, y);
  ctx.lineTo(x + w, y + b);
  ctx.lineTo(x + w, y + h - b);
  ctx.lineTo(x + w - b, y + h);
  ctx.lineTo(x + b, y + h);
  ctx.lineTo(x, y + h - b);
  ctx.lineTo(x, y + b);
  ctx.closePath();
}

/** The direction a linear pattern runs in UV space. */
export type GrainAxis = 'u' | 'v';

/**
 * Paint in "runs along +x" space, then rotate the tile onto its own footprint if the caller
 * wants the pattern running along v. `(x, y) → (size - y, x)`: a bijection of the tile onto
 * itself, so tile-periodicity survives it.
 */
function withAxis(
  ctx: CanvasRenderingContext2D,
  size: number,
  axis: GrainAxis,
  draw: () => void,
): void {
  if (axis === 'u') {
    draw();
    return;
  }
  ctx.save();
  ctx.translate(size, 0);
  ctx.rotate(Math.PI / 2);
  draw();
  ctx.restore();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. CACHE + BUILD
//    Same contract as `art/textures`: keyed by every argument that changes a pixel, built once,
//    disposable, inspectable. Two calls with the same args return the SAME instance.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const _sets = new Map<string, SurfaceTextureSet>();
const _textures = new Map<string, Texture>();
let _anisotropy = 4;

/** Match `art/textures`' anisotropy to the renderer's cap. Call before building, at boot. */
export function setWeaponSurfaceAnisotropy(max: number): void {
  _anisotropy = Math.max(1, Math.floor(max));
  for (const tex of _textures.values()) {
    tex.anisotropy = _anisotropy;
    tex.needsUpdate = true;
  }
}

function finishTex(tex: Texture, srgb: boolean): Texture {
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = true;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = _anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Paints one tile. Called twice per surface — once per ink set — with identical geometry. */
type Painter = (ctx: CanvasRenderingContext2D, size: number, k: Inks) => void;

function buildSurface(
  key: string,
  size: number,
  paint: Painter,
  colour: Inks,
  breakup: Inks,
): SurfaceTextureSet {
  const hit = _sets.get(key);
  if (hit) return hit;

  const a = makeCanvas(size);
  paint(a.ctx, size, colour);
  const map = finishTex(new CanvasTexture(a.canvas), true);
  map.name = `${key}:map`;

  // Half res: it drives banded break-up response, never a silhouette. Same relative geometry,
  // because every painter measures in fractions of `size`.
  const bs = Math.max(32, size >> 1);
  const b = makeCanvas(bs);
  paint(b.ctx, bs, breakup);
  const roughnessLike = finishTex(new CanvasTexture(b.canvas), false);
  roughnessLike.name = `${key}:rough`;

  const set: SurfaceTextureSet = { map, roughnessLike };
  _textures.set(map.name, map);
  _textures.set(roughnessLike.name, roughnessLike);
  _sets.set(key, set);
  return set;
}

/** Free every weapon surface. Mirrors `disposeArtTextures`. */
export function disposeWeaponSurfaces(): void {
  for (const tex of _textures.values()) tex.dispose();
  _textures.clear();
  _sets.clear();
}

/** How many textures this library is holding — for the boot budget print. */
export function weaponSurfaceCount(): number {
  return _textures.size;
}

/** Look one up by its cache key, e.g. `'wood:717072:256:3:4:u:1:map'`. Debug only. */
export function getWeaponSurface(key: string): Texture | undefined {
  return _textures.get(key);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6. OPTIONS
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Shared by every generator.
 *
 * `base` is REQUIRED and it is load-bearing — see the header. It is the flat colour of the field
 * the map will sit on, and it decides both the encoding and how far a mark is allowed to travel
 * before it leaves the readability band.
 */
export interface WeaponSurfaceOptions {
  /** sRGB hex of the field this map modulates. Use one of `WEAPON_FIELD`. */
  base: number;
  /** Tile resolution. 256 default; 128 is plenty for a small part. */
  size?: number;
  /** Deterministic variation. Same seed ⇒ same pixels, forever. */
  seed?: number;
  /** 0..1 mark contrast. Each pattern has its own value swing; this scales it. */
  contrast?: number;
}

const DEF_SIZE = 256;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7. THE GENERATORS
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface WoodGrainOptions extends WeaponSurfaceOptions {
  /** 3 or 4. More than 4 and it stops reading as grain and starts reading as stripes. */
  bands?: number;
  /** Direction the grain runs. Default 'u'. */
  axis?: GrainAxis;
  /** Draw the single knot. One. A second one reads as a pattern, not as timber. */
  knot?: boolean;
}

/**
 * **woodGrain** — shotgun furniture, rifle stock.
 *
 * 3–4 BROAD bands, hard-edged, alternating between the pattern's two values, split by heavy ink.
 * Not 40 fine lines: at 0.30 m under a 7 px hull those average to a uniform grey and you have
 * spent a texture to make the gun flatter. One knot, two confident grain strokes, done.
 */
export function makeWoodGrain(opts: WoodGrainOptions): SurfaceTextureSet {
  const size = opts.size ?? DEF_SIZE;
  const seed = opts.seed ?? 3;
  const bands = Math.max(3, Math.min(4, Math.round(opts.bands ?? 4)));
  const axis = opts.axis ?? 'u';
  const knot = opts.knot ?? true;
  const contrast = opts.contrast ?? 0.7;
  const key = `wood:${opts.base.toString(16)}:${size}:${seed}:${bands}:${axis}:${knot ? 1 : 0}:${contrast}`;

  const paint: Painter = (ctx, s, k) => {
    const u = s / 256;
    const rnd = makeSeededRandom(seed * 131 + 7);
    ctx.fillStyle = k.field;
    ctx.fillRect(0, 0, s, s);

    withAxis(ctx, s, axis, () => {
      const amp = s * 0.018;
      // Broad bands. Each is a quad between two periodic wobbles, so it tiles exactly.
      for (let i = 0; i < bands; i++) {
        const top = wavyEdge(s, i / bands, amp, i * 1.9 + seed);
        const bot = wavyEdge(s, (i + 1) / bands, amp, (i + 1) * 1.9 + seed);
        const poly = top.slice();
        for (let j = bot.length - 2; j >= 0; j -= 2) poly.push(bot[j] as number, bot[j + 1] as number);
        fillPoly(ctx, poly, i % 2 === 0 ? k.lo : k.hi);
      }
      // The ink between planks of grain. Heavy — this is the mark that survives the hull.
      for (let i = 0; i <= bands; i++) {
        strokePath(ctx, wavyEdge(s, i / bands, amp, i * 1.9 + seed), k.ink, 3.6 * u);
      }
      // Two grain strokes. TWO. They exist to break the band edges' regularity, nothing else.
      for (let i = 0; i < 2; i++) {
        const t = (i + 0.5) / bands + rnd.spread(0.06);
        ctx.globalAlpha = 0.55;
        strokePath(ctx, wavyEdge(s, t, amp * 1.6, i * 3.1 + seed * 0.5), k.ink, 2.6 * u);
        ctx.globalAlpha = 1;
      }
      if (knot) {
        drawWrapped(ctx, s, () => {
          const cx = s * 0.62;
          const cy = s * ((rnd.int(0, bands) + 0.5) / bands);
          roughCircle(ctx, cx, cy, s * 0.085, k.lo, k.ink, { seed: seed * 5 + 1, width: 3.2 * u });
          roughCircle(ctx, cx, cy, s * 0.038, null, k.ink, { seed: seed * 5 + 9, width: 2.4 * u });
        });
      }
    });
  };

  return buildSurface(key, size, paint, colourInks(opts.base, contrast, 0.3), breakupInks(0.7));
}

export interface VentedSteelOptions extends WeaponSurfaceOptions {
  /** Big slots. 3 is the spec. Above 4 they stop being slots and become a grille. */
  slots?: number;
  /** Direction the slots elongate. Default 'u'. */
  axis?: GrainAxis;
  /** The two bolt heads at the ends of the shroud. */
  rivets?: boolean;
}

/**
 * **ventedSteel** — SMG barrel shroud, shotgun heat shield.
 *
 * THREE big slots (`WEAPON_ART` §1: *3 BOLD slots, not 8 thin ones*), each ~13 % of the tile
 * tall and 68 % of it long, cut with a bevel so the ink reads them as stamped. Each slot gets a
 * bright lip on top and a dark one underneath — that pair is the whole illusion of depth and it
 * costs no geometry. One hard light-catch band along the top edge, two bolt heads.
 */
export function makeVentedSteel(opts: VentedSteelOptions): SurfaceTextureSet {
  const size = opts.size ?? DEF_SIZE;
  const seed = opts.seed ?? 4;
  const slots = Math.max(2, Math.min(4, Math.round(opts.slots ?? 3)));
  const axis = opts.axis ?? 'u';
  const rivets = opts.rivets ?? true;
  const contrast = opts.contrast ?? 0.75;
  const key = `vent:${opts.base.toString(16)}:${size}:${seed}:${slots}:${axis}:${rivets ? 1 : 0}:${contrast}`;

  const paint: Painter = (ctx, s, k) => {
    const u = s / 256;
    ctx.fillStyle = k.field;
    ctx.fillRect(0, 0, s, s);

    withAxis(ctx, s, axis, () => {
      // The shroud's light catch: one hard band, not a gradient (ART §2: specular is a SHAPE).
      ctx.fillStyle = k.hi;
      ctx.fillRect(0, 0, s, s * 0.11);
      ctx.fillStyle = k.ink;
      ctx.fillRect(0, s * 0.11, s, 2.4 * u);

      const h = s * 0.13;
      const w = s * 0.68;
      const x = s * 0.16;
      const span = 0.62;
      const first = 0.26;
      for (let i = 0; i < slots; i++) {
        const y = s * (first + (slots > 1 ? (i / (slots - 1)) * span : 0)) - h * 0.5;
        bevelSlotPath(ctx, x, y, w, h);
        ctx.fillStyle = k.ink;
        ctx.fill();
        // Lip above (lit) and below (shadowed) — the depth cue.
        strokePath(ctx, [x + h * 0.34, y - 1.6 * u, x + w - h * 0.34, y - 1.6 * u], k.hi, 3.2 * u);
        strokePath(ctx, [x + h * 0.34, y + h + 1.6 * u, x + w - h * 0.34, y + h + 1.6 * u], k.lo, 3.2 * u);
      }

      if (rivets) {
        for (let i = 0; i < 2; i++) {
          const cx = s * (i === 0 ? 0.075 : 0.925);
          const cy = s * 0.55;
          roughCircle(ctx, cx, cy, s * 0.045, k.hi, k.ink, { seed: seed * 17 + i, width: 3 * u });
          roughCircle(ctx, cx, cy, s * 0.018, k.lo, null, { seed: seed * 17 + i + 5 });
        }
      }
    });
  };

  return buildSurface(key, size, paint, colourInks(opts.base, contrast, 0.32), breakupInks(0.85));
}

export interface KnurledOptions extends WeaponSurfaceOptions {
  /** Diamonds across the tile. 4–6. You are supposed to be able to COUNT them. */
  cells?: number;
}

/**
 * **knurled** — grips, the shotgun pump, a bolt knob.
 *
 * A coarse diamond you could count: 5 across the tile, so each diamond is ~50 px of a 256 px
 * map and roughly a centimetre on the real part. Grooves take the dark value, diamond faces the
 * light one, and every diamond is inked — that outline is what makes it read as *cut* rather
 * than as a printed pattern. Real knurling is ten times finer and would vanish entirely.
 */
export function makeKnurled(opts: KnurledOptions): SurfaceTextureSet {
  const size = opts.size ?? DEF_SIZE;
  const seed = opts.seed ?? 5;
  const cells = Math.max(3, Math.min(7, Math.round(opts.cells ?? 5)));
  const contrast = opts.contrast ?? 0.8;
  const key = `knurl:${opts.base.toString(16)}:${size}:${seed}:${cells}:${contrast}`;

  const paint: Painter = (ctx, s, k) => {
    const u = s / 256;
    // Grooves first: the dark value is the ground, the diamonds sit proud of it.
    ctx.fillStyle = k.lo;
    ctx.fillRect(0, 0, s, s);

    const step = s / cells;
    const a = step * 0.5;
    // Lattice (step, 0) and (step/2, step): diamonds meet tip-to-tip, grooves run diagonally.
    for (let j = -1; j <= cells; j++) {
      const cy = (j + 0.5) * step;
      const off = j % 2 === 0 ? 0 : step * 0.5;
      for (let i = -1; i <= cells; i++) {
        const cx = (i + 0.5) * step + off;
        const d = [cx, cy - a, cx + a, cy, cx, cy + a, cx - a, cy];
        fillPoly(ctx, d, k.hi);
        strokePath(ctx, d, k.ink, 2.4 * u, true);
        // The lower facet takes the SAME dark value as the groove — the light comes from above,
        // and a shaded facet and a groove are one shadow, not two. Two values, hard-edged.
        fillPoly(ctx, [cx, cy + a * 0.1, cx + a * 0.9, cy + a * 0.12, cx, cy + a * 0.92], k.lo);
      }
    }
  };

  return buildSurface(key, size, paint, colourInks(opts.base, contrast, 0.28), breakupInks(0.9));
}

export interface TapeWrapOptions extends WeaponSurfaceOptions {
  /** Chunky diagonals across the tile. 3–5. */
  wraps?: number;
  /**
   * Wrap slope, as an INTEGER rise over the tile. 2 ⇒ ≈27° tape angle. It must stay an integer:
   * the band field is `(x + slope·y)·wraps/size`, which is only tile-periodic for integer slope.
   */
  slope?: number;
  /** Fraction of each pitch covered by tape. 0.55 default — chunky, with the under-value showing. */
  coverage?: number;
}

/**
 * **tapeWrap** — the wrapped-grip read: friction tape over a pistol grip or a fore-end.
 *
 * A chunky diagonal in exactly two values. Four wraps across the tile at ~27°, each ~55 % of its
 * pitch, with a hard ink lip on the leading edge of every wrap and one torn notch per wrap so it
 * reads as applied by hand rather than printed. No feathered edges anywhere: tape has an edge.
 */
export function makeTapeWrap(opts: TapeWrapOptions): SurfaceTextureSet {
  const size = opts.size ?? DEF_SIZE;
  const seed = opts.seed ?? 6;
  const wraps = Math.max(2, Math.min(6, Math.round(opts.wraps ?? 4)));
  const slope = Math.max(1, Math.min(3, Math.round(opts.slope ?? 2)));
  const coverage = Math.max(0.3, Math.min(0.8, opts.coverage ?? 0.55));
  const contrast = opts.contrast ?? 0.7;
  const key = `tape:${opts.base.toString(16)}:${size}:${seed}:${wraps}:${slope}:${coverage}:${contrast}`;

  const paint: Painter = (ctx, s, k) => {
    const u = s / 256;
    const rnd = makeSeededRandom(seed * 337 + 11);
    // The exposed under-value between wraps.
    ctx.fillStyle = k.lo;
    ctx.fillRect(0, 0, s, s);

    // Bands live on `x + slope*y = C`. Extend well past the tile; the field is periodic so the
    // seam matches by construction.
    const pitch = s / wraps;
    const yA = -s;
    const yB = 2 * s;
    const cMax = Math.ceil((s * (1 + slope * 2)) / pitch) + 2;
    for (let c = -2; c <= cMax; c++) {
      const c0 = c * pitch;
      const c1 = c0 + pitch * coverage;
      fillPoly(
        ctx,
        [c0 - slope * yA, yA, c0 - slope * yB, yB, c1 - slope * yB, yB, c1 - slope * yA, yA],
        k.hi,
      );
      // Leading-edge lip: the overlap of the previous turn.
      strokePath(ctx, [c0 - slope * yA, yA, c0 - slope * yB, yB], k.ink, 3.4 * u);
      strokePath(ctx, [c1 - slope * yA, yA, c1 - slope * yB, yB], k.ink, 2.2 * u);
    }

    // One torn notch per wrap. Blocky loss, exposing the under-value.
    drawWrapped(ctx, s, () => {
      for (let i = 0; i < wraps; i++) {
        const y = s * ((i + 0.5) / wraps);
        const cIdx = Math.round((y * slope) / pitch) + rnd.int(0, wraps);
        const x = cIdx * pitch - slope * y + pitch * coverage * rnd.range(0.15, 0.55);
        fillPoly(ctx, blockyPoly(rnd, x, y, pitch * 0.34, s * 0.09), k.lo);
      }
    });
  };

  return buildSurface(key, size, paint, colourInks(opts.base, contrast, 0.3), breakupInks(0.6));
}

export interface ChippedPaintOptions extends WeaponSurfaceOptions {
  /** Chips per tile. 6–9. Fewer, bigger marks beat many small ones — always. */
  chips?: number;
  /** What the paint has come off to expose. Default 'lighter' — bare steel under a dark finish. */
  reveal?: 'lighter' | 'darker';
  /** Let two chips take the RUST accent. This is the gun's ONE warm note (ART §1, §9). */
  accent?: boolean;
}

/**
 * **chippedPaint** — the worn painted receiver.
 *
 * Blocky loss, not soft noise: every chip is a rectilinear polygon with two steps bitten out,
 * hard-filled with the revealed value and inked on ONE side only. The asymmetric lip is what
 * makes it read as a lifted edge instead of a sticker. Two wear zones run along the tile's top
 * and bottom, where a hand and a holster actually take the finish off, and two chips carry RUST.
 */
export function makeChippedPaint(opts: ChippedPaintOptions): SurfaceTextureSet {
  const size = opts.size ?? DEF_SIZE;
  const seed = opts.seed ?? 7;
  const chips = Math.max(4, Math.min(12, Math.round(opts.chips ?? 7)));
  const reveal = opts.reveal ?? 'lighter';
  const accent = opts.accent ?? true;
  const contrast = opts.contrast ?? 0.75;
  const key = `chip:${opts.base.toString(16)}:${size}:${seed}:${chips}:${reveal}:${accent ? 1 : 0}:${contrast}`;

  const paint: Painter = (ctx, s, k) => {
    const u = s / 256;
    const rnd = makeSeededRandom(seed * 719 + 13);
    const bare = reveal === 'lighter' ? k.hi : k.lo;
    ctx.fillStyle = k.field;
    ctx.fillRect(0, 0, s, s);

    const chip = (cx: number, cy: number, w: number, h: number, fill: string): void => {
      const p = blockyPoly(rnd, cx, cy, w, h);
      fillPoly(ctx, p, fill);
      // Ink two of the eight edges only. Asymmetry is the whole trick.
      strokePath(ctx, p.slice(0, 8), k.ink, 3 * u);
    };

    // The two wear zones: the edges of the part, where finish actually goes.
    drawWrapped(ctx, s, () => {
      chip(s * 0.42, s * 0.06, s * 0.5, s * 0.13, bare);
      chip(s * 0.66, s * 0.95, s * 0.42, s * 0.11, bare);
    });

    drawWrapped(ctx, s, () => {
      for (let i = 0; i < chips; i++) {
        const w = s * rnd.range(0.1, 0.2);
        const h = s * rnd.range(0.08, 0.17);
        const useAccent = accent && i < 2;
        chip(rnd.range(0, s), rnd.range(s * 0.15, s * 0.85), w, h, useAccent ? k.accent : bare);
      }
    });

    // Two long scuffs. Straight, confident, hard — a scratch is a line, not a gradient.
    drawWrapped(ctx, s, () => {
      for (let i = 0; i < 2; i++) {
        const y = rnd.range(s * 0.2, s * 0.8);
        const x = rnd.range(0, s * 0.6);
        const l = s * rnd.range(0.24, 0.44);
        strokePath(ctx, [x, y, x + l, y + rnd.spread(s * 0.05)], bare, 4 * u);
      }
    });
  };

  return buildSurface(key, size, paint, colourInks(opts.base, contrast, 0.42), breakupInks(0.8));
}

export interface ParkerisedOptions extends WeaponSurfaceOptions {
  /** Blotches per tile. 8–14. */
  patches?: number;
  /** Bead-blast specks. Linework, so they may sit under the value floor. */
  specks?: number;
}

/**
 * **parkerised** — plain matte gun finish. The "no pattern" option that still refuses to be flat.
 *
 * This is the one every gun gets somewhere. Big, low-contrast blocky patches (±8 % of the base,
 * not ±30) plus a sparse scatter of hard ink specks for tooth. It reads as *finish* at a glance
 * and as nothing in particular at a distance, which is exactly the job: it stops a large field
 * printing as one dead value without ever competing with the marks that are supposed to be seen.
 */
export function makeParkerised(opts: ParkerisedOptions): SurfaceTextureSet {
  const size = opts.size ?? DEF_SIZE;
  const seed = opts.seed ?? 8;
  const patches = Math.max(4, Math.min(20, Math.round(opts.patches ?? 11)));
  const specks = Math.max(0, Math.min(120, Math.round(opts.specks ?? 44)));
  const contrast = opts.contrast ?? 0.8;
  const key = `park:${opts.base.toString(16)}:${size}:${seed}:${patches}:${specks}:${contrast}`;

  const paint: Painter = (ctx, s, k) => {
    const u = s / 256;
    const rnd = makeSeededRandom(seed * 911 + 19);
    ctx.fillStyle = k.field;
    ctx.fillRect(0, 0, s, s);

    drawWrapped(ctx, s, () => {
      for (let i = 0; i < patches; i++) {
        fillPoly(
          ctx,
          blockyPoly(rnd, rnd.range(0, s), rnd.range(0, s), s * rnd.range(0.22, 0.46), s * rnd.range(0.18, 0.4)),
          i % 2 === 0 ? k.lo : k.hi,
        );
      }
    });

    drawWrapped(ctx, s, () => {
      for (let i = 0; i < specks; i++) {
        roughCircle(ctx, rnd.range(0, s), rnd.range(0, s), u * rnd.range(1.4, 2.6), k.ink, null, {
          seed: seed + i * 7,
        });
      }
    });
  };

  return buildSurface(key, size, paint, colourInks(opts.base, contrast, 0.1), breakupInks(0.3));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8. THE LIBRARY
//    One call at boot, six sets, every one cached. Mirrors `makeSurfaceLibrary` in art/textures.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type WeaponSurfaceName =
  | 'woodGrain'
  | 'ventedSteel'
  | 'knurled'
  | 'tapeWrap'
  | 'chippedPaint'
  | 'parkerised';

/**
 * The house set: each pattern on the field it belongs to. Build it once in the viewmodel's boot
 * path and hand `set.map` to `makeInkMaterial` with `WEAPON_SURFACE_MAP`.
 *
 * Anything needing a different base calls the generator directly — it is the same cache.
 */
export function makeWeaponSurfaceLibrary(size = DEF_SIZE): Record<WeaponSurfaceName, SurfaceTextureSet> {
  return {
    woodGrain: makeWoodGrain({ base: WEAPON_FIELD.wood, size, seed: 3 }),
    ventedSteel: makeVentedSteel({ base: WEAPON_FIELD.steel, size, seed: 4 }),
    knurled: makeKnurled({ base: WEAPON_FIELD.polymer, size, seed: 5 }),
    tapeWrap: makeTapeWrap({ base: WEAPON_FIELD.polymer, size, seed: 6 }),
    chippedPaint: makeChippedPaint({ base: WEAPON_FIELD.frame, size, seed: 7 }),
    parkerised: makeParkerised({ base: WEAPON_FIELD.frame, size, seed: 8 }),
  };
}

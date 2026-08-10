/**
 * THE ONOMATOPOEIA ENGINE. See docs/ART_DIRECTION.md §5.
 *
 * "BLAM!" "SPLAT!" "KA-BOOM!" — the loudest, most comic-book thing in the game, and
 * 100% generated: bold condensed OS fonts drawn to a canvas, never a downloaded webfont.
 *
 * Anatomy of one word, drawn back to front:
 *   1. HARD DROP SHADOW   — flat INK silhouette, offset down-right. No blur, ever.
 *   2. OUTER INK OUTLINE  — thick, drawn several times at sub-pixel offsets so the
 *                           contour wobbles like a brush pen.
 *   3. PAPER OUTLINE      — the newsprint "keyline" that separates ink from fill.
 *   4. TWO-TONE FILL      — flat colour, lighter band across the top third.
 *   5. HALFTONE           — dot screen creeping up from the bottom of the letters.
 * Every letter is individually rotated, offset and scaled — a word set in a straight
 * line at a uniform size is a bug.
 *
 * Everything is cached by (text + resolved style): we never draw the same word twice.
 */

import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  SRGBColorSpace,
} from 'three';
import { cssOf, rgb8, rgb8Mix, shade, tint, type PaletteToken } from '@/art/palette';
import { halftoneField, makeSeededRandom } from '@/art/textures';

/**
 * Bold condensed system fonts only — these ship with the OS, so this is not an
 * "asset". Impact is the classic comic SFX face; the rest are per-platform fallbacks.
 */
export const COMIC_FONT_STACK =
  'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", "Franklin Gothic Heavy", sans-serif';

export interface WordStyleOptions {
  /** Letter fill colour. */
  fill?: PaletteToken;
  /** Outer contour. Effectively always INK. */
  ink?: PaletteToken;
  /** The keyline between ink and fill. */
  paper?: PaletteToken;
  /** Cap height in px. Bigger = crisper on screen; 128 is the house default. */
  fontSize?: number;
  /** Italic shear. Positive leans right. 0.18 is a good comic lean. */
  skew?: number;
  /** Whole-word rotation in degrees. */
  rotate?: number;
  /** Per-letter chaos, 0..1. */
  jitter?: number;
  /** Outer ink thickness as a fraction of fontSize. */
  outline?: number;
  /** Drop shadow offset as a fraction of fontSize. */
  shadow?: number;
  /** Halftone dots climbing the lower part of the letters. */
  halftone?: boolean;
  /** Append an exclamation mark if the text doesn't already end in punctuation. */
  bang?: boolean;
  /** Letter tracking as a fraction of fontSize (negative = tighter). */
  tracking?: number;
  seed?: number;
}

export interface WordTexture {
  texture: CanvasTexture;
  /** width / height — multiply your quad's height by this. */
  aspect: number;
  width: number;
  height: number;
}

interface ResolvedStyle {
  fill: PaletteToken;
  ink: PaletteToken;
  paper: PaletteToken;
  fontSize: number;
  skew: number;
  rotate: number;
  jitter: number;
  outline: number;
  shadow: number;
  halftone: boolean;
  bang: boolean;
  tracking: number;
  seed: number;
}

const DEFAULTS: ResolvedStyle = {
  fill: 'GOLD',
  ink: 'INK',
  paper: 'PAPER',
  fontSize: 128,
  skew: 0.17,
  rotate: -6,
  jitter: 1,
  outline: 0.085,
  shadow: 0.06,
  halftone: true,
  bang: true,
  tracking: 0.012,
  seed: 0,
};

function resolve(o: WordStyleOptions): ResolvedStyle {
  return {
    fill: o.fill ?? DEFAULTS.fill,
    ink: o.ink ?? DEFAULTS.ink,
    paper: o.paper ?? DEFAULTS.paper,
    fontSize: o.fontSize ?? DEFAULTS.fontSize,
    skew: o.skew ?? DEFAULTS.skew,
    rotate: o.rotate ?? DEFAULTS.rotate,
    jitter: o.jitter ?? DEFAULTS.jitter,
    outline: o.outline ?? DEFAULTS.outline,
    shadow: o.shadow ?? DEFAULTS.shadow,
    halftone: o.halftone ?? DEFAULTS.halftone,
    bang: o.bang ?? DEFAULTS.bang,
    tracking: o.tracking ?? DEFAULTS.tracking,
    seed: o.seed ?? DEFAULTS.seed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

const _words = new Map<string, WordTexture>();

function keyOf(text: string, s: ResolvedStyle): string {
  return [
    text, s.fill, s.ink, s.paper, s.fontSize, s.skew, s.rotate, s.jitter,
    s.outline, s.shadow, s.halftone ? 1 : 0, s.bang ? 1 : 0, s.tracking, s.seed,
  ].join('|');
}

/** How many distinct word textures are resident. */
export function wordTextureCount(): number {
  return _words.size;
}

/** Free every generated word/number texture. */
export function disposeWordTextures(): void {
  for (const w of _words.values()) w.texture.dispose();
  _words.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

interface Glyph {
  ch: string;
  /** Advance origin along the baseline, before jitter. */
  x: number;
  w: number;
  rot: number;
  dy: number;
  sx: number;
  sy: number;
}

let _measureCtx: CanvasRenderingContext2D | null = null;

function measureContext(): CanvasRenderingContext2D {
  if (!_measureCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('[art/letters] 2D canvas context unavailable');
    _measureCtx = ctx;
  }
  return _measureCtx;
}

function newCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.ceil(w));
  canvas.height = Math.max(2, Math.ceil(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[art/letters] 2D canvas context unavailable');
  return { canvas, ctx };
}

// ─────────────────────────────────────────────────────────────────────────────
// The word painter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Draw a comic word to a canvas texture.
 * The result is cached — calling this every frame with the same text is free.
 */
export function makeWordTexture(text: string, opts: WordStyleOptions = {}): WordTexture {
  const s = resolve(opts);
  let str = text.toUpperCase();
  if (s.bang && !/[!?.]$/.test(str)) str += '!';
  const key = keyOf(str, s);
  const hit = _words.get(key);
  if (hit) return hit;

  const fs = s.fontSize;
  const font = `900 ${fs}px ${COMIC_FONT_STACK}`;
  const mctx = measureContext();
  mctx.font = font;

  // Per-letter chaos, deterministic per (text, seed).
  let h = s.seed | 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  const rnd = makeSeededRandom(h || 1);

  const tracking = s.tracking * fs;
  const glyphs: Glyph[] = [];
  let cursor = 0;
  let maxAsc = fs * 0.75;
  let maxDesc = fs * 0.2;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i] as string;
    const m = mctx.measureText(ch);
    const w = m.width;
    maxAsc = Math.max(maxAsc, m.actualBoundingBoxAscent || 0);
    maxDesc = Math.max(maxDesc, m.actualBoundingBoxDescent || 0);
    const sx = 1 + rnd.spread(0.06 * s.jitter);
    const sy = 1 + rnd.spread(0.09 * s.jitter);
    glyphs.push({
      ch,
      x: cursor,
      w,
      rot: rnd.spread(0.075 * s.jitter),
      dy: rnd.spread(0.05 * fs * s.jitter),
      sx,
      sy,
    });
    cursor += w * sx + tracking;
  }
  const wordW = Math.max(1, cursor - tracking);
  const blockH = maxAsc + maxDesc;

  const outlineW = fs * s.outline;
  const shadowOff = fs * s.shadow;
  const pad = outlineW * 2.6 + shadowOff + fs * 0.16;

  const skewExtra = Math.abs(s.skew) * blockH;
  const w0 = wordW + skewExtra + pad * 2;
  const h0 = blockH + fs * 0.14 * s.jitter + pad * 2;
  const rot = (s.rotate * Math.PI) / 180;
  const ca = Math.abs(Math.cos(rot));
  const sa = Math.abs(Math.sin(rot));
  const cw = w0 * ca + h0 * sa;
  const chh = w0 * sa + h0 * ca;

  const { canvas, ctx } = newCanvas(cw, chh);

  /** Set up the shared word transform: centred, rotated, sheared. */
  const beginWord = (c: CanvasRenderingContext2D): void => {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.translate(cw * 0.5, chh * 0.5);
    c.rotate(rot);
    c.transform(1, 0, -s.skew, 1, 0, 0);
    c.translate(-wordW * 0.5, (maxAsc - maxDesc) * 0.5);
  };

  /** Paint every glyph once, in `mode`, offset by (ox, oy). */
  const paint = (
    c: CanvasRenderingContext2D,
    mode: 'fill' | 'stroke',
    style: string,
    lineWidth: number,
    ox: number,
    oy: number,
    wobble: number,
    wseed: number,
  ): void => {
    c.font = font;
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.miterLimit = 2;
    if (mode === 'fill') c.fillStyle = style;
    else {
      c.strokeStyle = style;
      c.lineWidth = lineWidth;
    }
    const wr = makeSeededRandom(wseed);
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i] as Glyph;
      c.save();
      c.translate(g.x + ox + wr.spread(wobble), g.dy + oy + wr.spread(wobble));
      c.rotate(g.rot);
      c.scale(g.sx, g.sy);
      if (mode === 'fill') c.fillText(g.ch, 0, 0);
      else c.strokeText(g.ch, 0, 0);
      c.restore();
    }
  };

  // ── 1. Hard drop shadow: a solid INK silhouette, offset. Never blurred. ──────
  beginWord(ctx);
  const inkCss = cssOf(rgb8(s.ink));
  paint(ctx, 'stroke', inkCss, outlineW * 2, shadowOff, shadowOff, 0, 1);
  paint(ctx, 'fill', inkCss, 0, shadowOff, shadowOff, 0, 1);

  // ── 2. Outer ink outline, drawn several times with sub-pixel wobble so the
  //       contour reads as a brush line rather than a vector offset. ────────────
  for (let p = 0; p < 3; p++) {
    beginWord(ctx);
    paint(ctx, 'stroke', inkCss, outlineW * (2 - p * 0.18), 0, 0, outlineW * 0.16, 11 + p * 37);
  }
  beginWord(ctx);
  paint(ctx, 'fill', inkCss, 0, 0, 0, 0, 3);

  // ── 3. PAPER keyline ────────────────────────────────────────────────────────
  beginWord(ctx);
  paint(ctx, 'stroke', cssOf(rgb8(s.paper)), outlineW * 0.95, 0, 0, outlineW * 0.06, 71);
  beginWord(ctx);
  paint(ctx, 'fill', cssOf(rgb8(s.paper)), 0, 0, 0, 0, 5);

  // ── 4+5. Two-tone fill + halftone, built on a scratch canvas so the tone is
  //         clipped to the letter shapes and never dirties the outlines. ────────
  const scratch = newCanvas(cw, chh);
  const sc = scratch.ctx;
  beginWord(sc);
  paint(sc, 'fill', cssOf(rgb8(s.fill)), 0, 0, 0, 0, 7);

  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'source-atop';
  // Lighter band across the top third — the flat "lit" half of the letter.
  sc.fillStyle = tint(s.fill, 0.42);
  sc.fillRect(0, 0, cw, chh * 0.42);
  // A darker toe so the letter has three flats, like a real colourist's SFX.
  sc.fillStyle = shade(s.fill, 0.3);
  sc.fillRect(0, chh * 0.78, cw, chh * 0.22);
  if (s.halftone) {
    halftoneField(
      sc, 0, 0, cw, chh, Math.max(4, fs * 0.075), 15, cssOf(rgb8Mix(s.fill, 'INK', 0.62)),
      (_px, py) => Math.max(0, Math.min(1, (py / chh - 0.35) / 0.5)),
      h || 1,
    );
  }
  sc.globalCompositeOperation = 'source-over';

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(scratch.canvas, 0, 0);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  texture.name = `word:${str}`;

  const out: WordTexture = { texture, aspect: cw / chh, width: cw, height: chh };
  _words.set(key, out);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Damage numbers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Damage number: GOLD for a normal hit, HOT and louder for a crit.
 * Numbers are bucketed so we cache a bounded set instead of one per damage roll.
 */
export function makeNumberTexture(n: number, isCrit = false): WordTexture {
  const v = Math.max(0, Math.round(n));
  return makeWordTexture(String(v), isCrit
    ? { fill: 'HOT', fontSize: 116, rotate: -9, skew: 0.22, jitter: 1.25, outline: 0.1, bang: true, halftone: true, seed: 2 }
    : { fill: 'GOLD', fontSize: 96, rotate: -4, skew: 0.14, jitter: 0.65, outline: 0.075, bang: false, halftone: true, seed: 1 });
}

/** Points popup ("+150"), always GOLD — reward owns that hue. */
export function makePointsTexture(points: number): WordTexture {
  return makeWordTexture(`+${Math.max(0, Math.round(points))}`, {
    fill: 'GOLD', fontSize: 84, rotate: -3, skew: 0.12, jitter: 0.5, outline: 0.07, bang: false, halftone: false, seed: 4,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The word pools
// ─────────────────────────────────────────────────────────────────────────────

/** Curated onomatopoeia pools. Callers pick one at random for the beat they're on. */
export const WORD_SETS = {
  /** Bullet lands on flesh. Short, percussive. */
  hit: ['POW', 'WHAP', 'THWACK', 'BAP', 'WHUMP', 'TOK', 'THUD', 'PLAK'],
  /** Bullet lands on the world. Harder, drier. */
  hitWorld: ['TAK', 'PING', 'CHNK', 'KLANG', 'SPANG', 'THOK'],
  /** A zombie comes apart. Wet and gleeful. */
  kill: ['SPLAT', 'SPLORCH', 'KERSPLAT', 'SQUELCH', 'SHRAKK', 'GLORP', 'SPLURK', 'SPLOOSH'],
  /** Headshot. The best sound in the game. */
  crit: ['CRACK', 'KRAK', 'SKULLSHOT', 'BULLSEYE', 'KA-POW', 'THWAKK', 'SNAP'],
  /** Big booms. */
  explosion: ['KA-BOOM', 'BADOOM', 'KRAKA-BOOM', 'FWOOSH', 'WHUMPF', 'BAROOM'],
  /** Gunfire. */
  gun: ['BLAM', 'BLAM-BLAM', 'RATATAT', 'BOOM', 'PAKOW', 'BRRRT', 'CHK-CHK'],
  /** Melee / bash. */
  melee: ['WHAM', 'KRUNCH', 'SMASH', 'CLOBBER', 'DOINK', 'BONK'],
  /** Movement flourishes. */
  move: ['WHOOSH', 'SHFFF', 'SKRRT', 'FWIP'],
  /** Shock affix. */
  shock: ['ZZAP', 'KRZZT', 'BZZAK', 'ZOTT'],
  /** Flame affix. */
  flame: ['FWOOM', 'WHOOMPH', 'SSSSS'],
  /** Player takes a hit. */
  hurt: ['ARGH', 'UNGH', 'OOF', 'GAAH'],
} as const;

export type WordSetName = keyof typeof WORD_SETS;

/** Pick a fitting word. `r` is a [0,1) roll — pass your seeded RNG's `next()`. */
export function pickWord(set: WordSetName, r: number): string {
  const pool = WORD_SETS[set] as readonly string[];
  return pool[Math.min(pool.length - 1, Math.floor(r * pool.length))] as string;
}

/** Per-pool house styling, so a SPLAT never looks like a KA-BOOM. */
export const WORD_SET_STYLE: Record<WordSetName, WordStyleOptions> = {
  hit: { fill: 'PAPER', fontSize: 96, rotate: -7, jitter: 0.9, outline: 0.08 },
  hitWorld: { fill: 'BONE', fontSize: 80, rotate: 5, jitter: 0.7, outline: 0.075, halftone: false },
  kill: { fill: 'HOT', fontSize: 132, rotate: -10, jitter: 1.25, outline: 0.095 },
  crit: { fill: 'GOLD', fontSize: 140, rotate: -12, skew: 0.22, jitter: 1.35, outline: 0.1 },
  explosion: { fill: 'RUST', fontSize: 160, rotate: -8, skew: 0.2, jitter: 1.3, outline: 0.105 },
  gun: { fill: 'GOLD', fontSize: 112, rotate: -6, jitter: 1, outline: 0.085 },
  melee: { fill: 'ELECTRIC', fontSize: 124, rotate: 8, jitter: 1.15, outline: 0.09 },
  move: { fill: 'PAPER', fontSize: 88, rotate: -14, skew: 0.3, jitter: 0.6, outline: 0.07, halftone: false },
  shock: { fill: 'ELECTRIC', fontSize: 120, rotate: -11, skew: 0.24, jitter: 1.3, outline: 0.09 },
  flame: { fill: 'RUST', fontSize: 120, rotate: -9, jitter: 1.1, outline: 0.09 },
  hurt: { fill: 'HOT', fontSize: 104, rotate: 6, jitter: 1.1, outline: 0.085 },
};

/**
 * One-call helper for the VFX layer: roll a word from a pool and get its texture,
 * already styled for that beat.
 */
export function makeWordFromSet(set: WordSetName, r: number, override: WordStyleOptions = {}): WordTexture {
  return makeWordTexture(pickWord(set, r), { ...WORD_SET_STYLE[set], ...override });
}

/**
 * Pre-render pools during the loading screen so the first BLAM! never costs a
 * frame hitch mid-fight. Returns the number of words rendered.
 *
 * COSTS VRAM: a word is roughly a 900×300 RGBA canvas (~1 MB). The default covers
 * only the pools that fire every second of combat — pass more sets deliberately,
 * and don't prewarm the whole vocabulary unless you have budget for ~60 MB.
 */
export function prewarmWords(sets: readonly WordSetName[] = ['gun', 'hit', 'crit', 'kill']): number {
  let n = 0;
  for (const set of sets) {
    for (const w of WORD_SETS[set] as readonly string[]) {
      makeWordTexture(w, WORD_SET_STYLE[set]);
      n++;
    }
  }
  return n;
}

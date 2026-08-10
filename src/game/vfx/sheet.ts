/**
 * THE VFX PRINTING PLATE — one atlas, one texture, one upload.
 *
 * Every shape the VFX layer draws lives on a single 1024×1024 sheet: ink splats, hard-edged
 * star bursts, spike rings, panel shards, ink droplets with drip tails, dust puffs and the ten
 * digits of a damage number. That is not a micro-optimisation, it is the reason the whole VFX
 * layer costs SIX draw calls: a family of effects can only be one `InstancedMesh` if every
 * instance samples the same texture, and a per-instance `aUvRect` picks the cell.
 *
 * ART §5 is the law on what is drawn here: **shapes, not soft particles.** Every cell has a
 * hard edge and, where it needs one, its own baked ink border — VFX are excluded from the
 * renderer's normal/depth prepass (LAYER.NO_INK), so a card that wants a line has to bring it.
 * Nothing on this sheet is a blurred blob.
 *
 * TWO KINDS OF CELL, one shader:
 *   • **MASK cells** are painted white (`PAPER`-white, not off-white) with `INK` linework, and
 *     are multiplied by a per-instance tint at draw time. White × HOT = HOT; INK × HOT ≈ INK,
 *     so the baked border survives the tint. This is how one droplet shape serves blood-ink,
 *     oil and dust.
 *   • **PRINTED cells** (the star bursts) are already coloured by `art/textures.ts` in the
 *     reserved GOLD-core / HOT-fringe recipe and are drawn with a white tint.
 *
 * LAYOUT (canvas pixels; v is flipped for GL by `cellAt`):
 *
 *   y    0..256   splat  ×4        256²   hand-drawn ink splat masks (decals)
 *   y  256..512   burst  ×4        256²   printed star bursts (muzzle flash, impacts)
 *   y  512..640   shard  ×4        128²   panel shards, white fill + heavy ink border
 *                 drop   ×4        128²   ink droplet + drip tail
 *   y  640..768   dust   ×4        128²   lumpy dust puff, inked, halftone-holed
 *                 spike  ×4        128²   radial ink-spike ring (tintable impact burst)
 *   y  768..896   digit  ×10       102×128 comic digits, PAPER fill + INK outline
 *   y  896..1024  streak ×2         96×128 tapered bullet streak (the rest is free)
 */

import {
  CanvasTexture, ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace,
  type Texture,
} from 'three';

import { cssOf, rgb8, type PaletteToken } from '@/art/palette';
import {
  halftoneField, makeCanvas, makeSeededRandom, makeSplatSet, makeStarBurstTexture,
  roughPolygon, roughStroke, taperStroke,
} from '@/art/textures';
import { COMIC_FONT_STACK } from '@/art/letters';

// ─────────────────────────────────────────────────────────────────────────────
// Cells
// ─────────────────────────────────────────────────────────────────────────────

/** One cell of the sheet: a UV rect plus the aspect its quad must be drawn at. */
export interface Cell {
  u0: number;
  v0: number;
  du: number;
  dv: number;
  /** width / height of the drawn content — multiply a quad's height by this. */
  aspect: number;
}

export interface VfxSheet {
  readonly texture: Texture;
  /** Hand-drawn ink splat masks — decals. */
  readonly splat: readonly Cell[];
  /** Printed star bursts (GOLD core, HOT fringe) — muzzle flash, impact flash. */
  readonly burst: readonly Cell[];
  /** Radial ink-spike ring masks — the tintable half of an impact. */
  readonly spike: readonly Cell[];
  /** Panel shards — flat quads with an ink border, for `panelShatter`. */
  readonly shard: readonly Cell[];
  /** Ink droplets with drip tails — blood-as-ink in flight. */
  readonly drop: readonly Cell[];
  /** Dust puffs. */
  readonly dust: readonly Cell[];
  /** Digits 0..9 for damage numbers. */
  readonly digit: readonly Cell[];
  /** Tapered bullet streaks. Thin at v=0 (the tail), heavy at v=1 (the head). */
  readonly streak: readonly Cell[];
  dispose(): void;
}

const SIZE = 1024;
/** Content is inset inside its cell so mip level 2+ cannot bleed a neighbour in. */
const INSET = 5;

function cellAt(x: number, y: number, w: number, h: number): Cell {
  // CanvasTexture has flipY = true, so canvas row 0 is v = 1.
  return {
    u0: x / SIZE,
    v0: 1 - (y + h) / SIZE,
    du: w / SIZE,
    dv: h / SIZE,
    aspect: w / h,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The painters. Everything below is MASK art: white fill, INK line, transparent
// ground. The tint is applied per instance at draw time.
// ─────────────────────────────────────────────────────────────────────────────

const WHITE = cssOf(rgb8('PAPER'));
const INK = cssOf(rgb8('INK'));

/**
 * A panel shard: an irregular flat polygon with the heaviest ink border on the sheet.
 * ART §5 — "flat quads with ink borders spinning away". The border is what makes a 12 cm
 * shard still read as *drawn* at 20 m.
 */
function paintShard(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number): void {
  const rnd = makeSeededRandom(seed * 977 + 31);
  const cx = x + s * 0.5;
  const cy = y + s * 0.5;
  const r = s * 0.5 - INSET - s * 0.06;
  const n = 4 + rnd.int(0, 3);
  const pts: number[] = [];
  let a = rnd.range(0, Math.PI * 2);
  for (let i = 0; i < n; i++) {
    a += (Math.PI * 2) / n + rnd.spread(0.5 / n);
    const rr = r * rnd.range(0.52, 1);
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  roughPolygon(ctx, pts, WHITE, INK, { seed, width: s * 0.075, jitter: s * 0.012, step: s * 0.1, passes: 2 });
  // One interior crease — a torn panel has a fold line, and it is what stops the shard from
  // reading as a plain triangle once it is spinning.
  const i0 = rnd.int(0, n);
  const i1 = (i0 + 2) % n;
  roughStroke(
    ctx,
    [pts[i0 * 2], pts[i0 * 2 + 1], cx + rnd.spread(r * 0.3), cy + rnd.spread(r * 0.3), pts[i1 * 2], pts[i1 * 2 + 1]],
    { color: INK, width: s * 0.03, jitter: s * 0.02, seed: seed + 5, alpha: 0.75 },
  );
}

/** An ink droplet: a blot with a tapered drip tail. Blood is ink (ART §5). */
function paintDrop(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number): void {
  const rnd = makeSeededRandom(seed * 613 + 17);
  const cx = x + s * 0.5;
  const headY = y + s * 0.66;
  const r = s * (0.15 + rnd.range(0, 0.07));

  // The tail first, so the head overlaps it cleanly.
  taperStroke(
    ctx,
    [cx + rnd.spread(s * 0.05), y + INSET + s * 0.04, cx + rnd.spread(s * 0.06), headY - r * 0.4],
    s * 0.02, r * 1.7,
    { color: WHITE, seed: seed + 3, jitter: s * 0.02, step: s * 0.09 },
  );
  const pts: number[] = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + Math.sin(a * 3 + seed) * 0.12);
    pts.push(cx + Math.cos(a) * rr, headY + Math.sin(a) * rr * 1.05);
  }
  roughPolygon(ctx, pts, WHITE, INK, { seed: seed + 11, width: s * 0.035, jitter: s * 0.008, step: s * 0.08 });
  // Two satellite specks — a real splatter never leaves one clean drop.
  for (let i = 0; i < 2; i++) {
    const a = rnd.range(0, Math.PI * 2);
    const d = r * rnd.range(1.5, 2.4);
    const sr = r * rnd.range(0.12, 0.26);
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * d, headY + Math.sin(a) * d * 0.7, sr, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * A dust puff: a lumpy inked cloud with a halftone bite taken out of the underside.
 * Flat and drawn — this is a comic's "poof", not a smoke sprite.
 */
function paintDust(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number): void {
  const rnd = makeSeededRandom(seed * 331 + 7);
  const cx = x + s * 0.5;
  const cy = y + s * 0.52;
  const r = s * 0.5 - INSET - s * 0.05;
  const lobes = 5 + rnd.int(0, 3);
  const pts: number[] = [];
  const steps = lobes * 6;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const bump = 0.74 + Math.abs(Math.sin(a * lobes * 0.5 + seed)) * 0.26;
    pts.push(cx + Math.cos(a) * r * bump, cy + Math.sin(a) * r * bump * 0.82);
  }
  roughPolygon(ctx, pts, WHITE, INK, { seed, width: s * 0.045, jitter: s * 0.01, step: s * 0.07 });
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  halftoneField(
    ctx, x, y, s, s, Math.max(4, s * 0.075), 15, '#fff',
    (_px, py) => Math.max(0, Math.min(1, (py - y - s * 0.5) / (s * 0.42))),
    seed + 41,
  );
  ctx.restore();
}

/**
 * A radial ink-spike burst (ART §5: "radial ink-spike burst — procedural star polygon").
 * Tintable, so the same shape is HOT out of a zombie and PAPER out of concrete.
 */
function paintSpike(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number): void {
  const rnd = makeSeededRandom(seed * 149 + 3);
  const cx = x + s * 0.5;
  const cy = y + s * 0.5;
  const R = s * 0.5 - INSET;
  const spikes = 7 + rnd.int(0, 5);
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 + rnd.spread(0.22);
    const r0 = R * rnd.range(0.1, 0.24);
    const r1 = R * rnd.range(0.62, 1);
    taperStroke(
      ctx,
      [cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1],
      R * rnd.range(0.1, 0.19), 0.5,
      { color: WHITE, seed: seed + i * 13, jitter: R * 0.02, step: R * 0.16 },
    );
  }
  // A small solid core so the burst has a centre of gravity rather than being all legs.
  const core: number[] = [];
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    core.push(cx + Math.cos(a) * R * rnd.range(0.14, 0.26), cy + Math.sin(a) * R * rnd.range(0.14, 0.26));
  }
  roughPolygon(ctx, core, WHITE, null, { seed: seed + 71, jitter: R * 0.015, step: R * 0.1 });
}

/**
 * A bullet streak: a tapered bar running the height of the cell, thin at the bottom (the tail,
 * v = 0) and heavy at the top (the head, v = 1). `composeStreak` stretches this along the shot,
 * so the taper is what stops a tracer reading as a laser beam.
 */
function paintStreak(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seed: number): void {
  const cx = x + w * 0.5;
  taperStroke(
    ctx,
    [cx, y + h - INSET, cx, y + h * 0.45, cx, y + INSET],
    w * 0.06, w * 0.55,
    { color: WHITE, seed, jitter: w * 0.03, step: h * 0.12 },
  );
}

/**
 * One comic digit: hard INK drop shadow, heavy INK contour, flat PAPER face.
 * Bold condensed OS fonts only — `COMIC_FONT_STACK` ships with the operating system, so this
 * is generated art, not a downloaded asset (CLAUDE.md §1).
 *
 * Returns the width actually used, so the cell is tight and multi-digit numbers kern.
 */
function paintDigit(
  ctx: CanvasRenderingContext2D, x: number, y: number, cellW: number, cellH: number, ch: string,
): number {
  const fs = cellH * 0.82;
  const font = `900 ${fs}px ${COMIC_FONT_STACK}`;
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const m = ctx.measureText(ch);
  const outline = fs * 0.15;
  const shadow = fs * 0.07;
  const w = Math.min(cellW - INSET, m.width + outline * 2 + shadow);
  const bx = x + INSET * 0.5 + outline;
  const by = y + cellH - INSET - fs * 0.13;

  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = outline * 2;
  ctx.strokeText(ch, bx + shadow, by + shadow);
  ctx.fillText(ch, bx + shadow, by + shadow);
  ctx.lineWidth = outline * 2;
  ctx.strokeText(ch, bx, by);
  ctx.fillStyle = WHITE;
  ctx.fillText(ch, bx, by);
  ctx.restore();
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

/** Blit a source canvas into a cell, fitted and centred, with the sheet's inset. */
function blit(
  ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number,
  x: number, y: number, w: number, h: number,
): void {
  const availW = w - INSET * 2;
  const availH = h - INSET * 2;
  const k = Math.min(availW / sw, availH / sh);
  const dw = sw * k;
  const dh = sh * k;
  ctx.drawImage(src, x + (w - dw) * 0.5, y + (h - dh) * 0.5, dw, dh);
}

function canvasOf(tex: Texture): { image: CanvasImageSource; w: number; h: number } | null {
  const img = tex.image as HTMLCanvasElement | undefined;
  if (!img || !img.width) return null;
  return { image: img, w: img.width, h: img.height };
}

/**
 * Paint the sheet. ~150 ms of canvas work, all of it during the boot screen — the four ink
 * splats are per-pixel noise fields and are by far the largest part of that.
 */
export function buildVfxSheet(): VfxSheet {
  const { canvas, ctx } = makeCanvas(SIZE, SIZE);
  // `makeCanvas` turns smoothing off (it exists for pixel-exact tile work); the atlas
  // downsamples 256² sources into 128² cells and needs it back on.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const splat: Cell[] = [];
  const burst: Cell[] = [];
  const spike: Cell[] = [];
  const shard: Cell[] = [];
  const drop: Cell[] = [];
  const dust: Cell[] = [];
  const digit: Cell[] = [];
  const streak: Cell[] = [];

  // ── row A: ink splat masks, straight from the art library ───────────────────
  const splats = makeSplatSet(4, 256, { spray: 0.5, drips: 4, fringePitch: 8 });
  for (let i = 0; i < 4; i++) {
    const src = canvasOf(splats[i]);
    const x = i * 256;
    if (src) blit(ctx, src.image, src.w, src.h, x, 0, 256, 256);
    splat.push(cellAt(x, 0, 256, 256));
  }

  // ── row B: printed star bursts. Already GOLD-core / HOT-fringe (ART §5) ─────
  const burstPoints = [9, 7, 12, 5];
  for (let i = 0; i < 4; i++) {
    const src = canvasOf(makeStarBurstTexture(burstPoints[i], 256, i + 1));
    const x = i * 256;
    if (src) blit(ctx, src.image, src.w, src.h, x, 256, 256, 256);
    burst.push(cellAt(x, 256, 256, 256));
  }

  // ── row C: shards + droplets ────────────────────────────────────────────────
  for (let i = 0; i < 4; i++) {
    paintShard(ctx, i * 128, 512, 128, i + 1);
    shard.push(cellAt(i * 128, 512, 128, 128));
    paintDrop(ctx, 512 + i * 128, 512, 128, i + 1);
    drop.push(cellAt(512 + i * 128, 512, 128, 128));
  }

  // ── row D: dust + spike rings ───────────────────────────────────────────────
  for (let i = 0; i < 4; i++) {
    paintDust(ctx, i * 128, 640, 128, i + 1);
    dust.push(cellAt(i * 128, 640, 128, 128));
    paintSpike(ctx, 512 + i * 128, 640, 128, i + 1);
    spike.push(cellAt(512 + i * 128, 640, 128, 128));
  }

  // ── row E: the digits ───────────────────────────────────────────────────────
  const DW = 102;
  const DH = 128;
  for (let i = 0; i < 10; i++) {
    const x = i * DW;
    const used = paintDigit(ctx, x, 768, DW, DH, String(i));
    const c = cellAt(x, 768, used, DH);
    digit.push(c);
  }

  // ── row F: bullet streaks (the rest of this row is deliberately free) ───────
  for (let i = 0; i < 2; i++) {
    paintStreak(ctx, i * 96, 896, 96, 128, i + 1);
    streak.push(cellAt(i * 96, 896, 96, 128));
  }

  const texture = new CanvasTexture(canvas);
  texture.name = 'vfx:sheet';
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  return {
    texture,
    splat, burst, spike, shard, drop, dust, digit, streak,
    dispose(): void { texture.dispose(); },
  };
}

/**
 * Palette-driven tints the VFX layer uses. Kept here rather than in `tuning.ts` because they
 * are COLOUR, and colour lives in the palette (ARCHITECTURE §1.7) — `tuning.ts` owns feel
 * numbers only. Every one of these is a straight token or a sanctioned two-token blend.
 */
export const VFX_TINT: Record<string, PaletteToken> = {
  blood: 'HOT',
  fleshShadow: 'HOT',
  concrete: 'BONE',
  metal: 'PAPER',
  wood: 'BONE',
  glass: 'ELECTRIC',
  dirt: 'BONE',
  flesh: 'HOT',
  spark: 'GOLD',
  fire: 'RUST',
  shock: 'ELECTRIC',
  dust: 'CONCRETE',
  number: 'GOLD',
  crit: 'HOT',
};

/** Debug-only: dump the sheet as a data URL to eyeball the plate in the console. */
export function sheetDataUrl(sheet: VfxSheet): string {
  const img = sheet.texture.image as HTMLCanvasElement;
  return img.toDataURL('image/png');
}

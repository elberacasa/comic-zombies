/**
 * THE BOON GLYPH SET — 26 flat ink icons, drawn from path data, zero assets.
 *
 * The contract is `BOON_ICON_IDS` in `@/game/boons`: a `readonly` tuple whose union type every
 * boon def is built through. `GLYPHS` below is a `Record<BoonIconId, Glyph>`, so the day someone
 * adds a boon with a glyph nobody has drawn, THIS FILE STOPS COMPILING. That is the whole point
 * of the vocabulary being a type and not a string.
 *
 * THE DRAWING RULE (ART §7 + §5): every glyph is a **solid silhouette** — no gradients, no
 * strokes thinner than 3.5, no soft edges. It is painted twice: once in the card's accent flat,
 * offset by `SHADOW_OFFSET`, and once in `INK` on top. That is a hard offset drop shadow AND a
 * deliberate mis-registration, the same printing error the chromatic pass fakes at full-screen
 * scale. Interior detail is *knocked out* in the card's own paper colour (the `cut` ops) rather
 * than drawn as a second flat, because a comic icon is ink and holes, never three values.
 *
 * All 26 read at 34 px (the HUD deck strip) and at 76 px (a draw card). They are authored in a
 * 64×64 box with ~4 px of bleed so nothing clips when the card rotates.
 */

import type { BoonIconId } from '@/game/boons';
import { PALETTE, css } from '@/art/palette';
import type { PaletteToken } from '@/art/palette';

/** A single drawing op: a filled path, a stroked path (`s` = width), or a circle. */
type Op =
  | { readonly d: string; readonly s?: number }
  | { readonly c: readonly [cx: number, cy: number, r: number]; readonly s?: number };

interface Glyph {
  /** The silhouette. Painted in the accent (offset) and then in INK. */
  readonly ink: readonly Op[];
  /** Interior detail, knocked out in the card's paper colour on top of the silhouette. */
  readonly cut?: readonly Op[];
  /** Ink drawn AFTER the knockout — anything that must survive a hole cut around it. */
  readonly top?: readonly Op[];
}

/** How far the accent plate is mis-registered from the ink plate, in glyph units. */
const SHADOW_OFFSET = 3.2;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The set. Order matches BOON_ICON_IDS: 8 common · 8 rare · 6 epic · 4 legendary.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const GLYPHS: Record<BoonIconId, Glyph> = {
  // ── common ────────────────────────────────────────────────────────────────────────────────
  /** Lightning bolt — rate of fire. */
  bolt: { ink: [{ d: 'M38 1 L11 34 H27 L21 63 L53 26 H34 Z' }] },
  /** Fat comic heart — health. */
  heart: {
    ink: [{ d: 'M32 61 C3 42 3 17 18 11 C27 7 32 15 32 22 C32 15 37 7 46 11 C61 17 61 42 32 61 Z' }],
    cut: [{ d: 'M20 20 C15 22 14 28 16 33', s: 4 }],
  },
  /** Magazine sliding out of a well — reload speed. */
  mag: {
    ink: [{ d: 'M17 6 H43 L47 19 H21 Z' }, { d: 'M20 24 H46 V61 H20 Z' }],
    cut: [{ d: 'M26 32 H40', s: 4 }, { d: 'M26 41 H40', s: 4 }, { d: 'M26 50 H40', s: 4 }],
  },
  /** Three stacked rounds — magazine capacity. */
  bullets: {
    ink: [
      { d: 'M6 31 L12 15 L18 31 V60 H6 Z' },
      { d: 'M26 27 L32 9 L38 27 V60 H26 Z' },
      { d: 'M46 31 L52 15 L58 31 V60 H46 Z' },
    ],
    cut: [{ d: 'M6 44 H18', s: 3.5 }, { d: 'M26 40 H38', s: 3.5 }, { d: 'M46 44 H58', s: 3.5 }],
  },
  /** Knurled pistol grip — recoil control. */
  grip: {
    ink: [{ d: 'M15 4 H50 V18 H37 L31 61 H13 L25 18 H15 Z' }],
    cut: [{ d: 'M22 30 H34', s: 3.5 }, { d: 'M20 38 H32', s: 3.5 }, { d: 'M18 46 H30', s: 3.5 }],
  },
  /** Running boot with a motion arc — move speed. */
  boot: {
    ink: [
      { d: 'M23 4 H39 V31 L60 41 V57 H23 Z' },
      { d: 'M15 16 C6 25 6 38 15 47', s: 5 },
      { d: 'M5 21 C-1 27 -1 36 5 42', s: 4.5 },
    ],
    cut: [{ d: 'M23 46 H60', s: 4 }],
  },
  /** Fat coin — points. */
  coin: {
    ink: [{ c: [32, 32, 29] }],
    cut: [
      { c: [32, 32, 21], s: 4 },
      { d: 'M41 22 C41 15 24 15 24 23 C24 31 41 31 41 39 C41 47 24 47 24 40', s: 5 },
      { d: 'M32 12 V52', s: 4 },
    ],
  },
  /** Ring sight with cross ticks — ADS speed. */
  scope: {
    ink: [
      { c: [32, 32, 25] },
      { d: 'M32 0 V13', s: 6 }, { d: 'M32 51 V64', s: 6 },
      { d: 'M0 32 H13', s: 6 }, { d: 'M51 32 H64', s: 6 },
    ],
    cut: [{ c: [32, 32, 17] }],
  },

  // ── rare ──────────────────────────────────────────────────────────────────────────────────
  /** A round arcing back into a magazine — headshot refund. */
  'bullet-return': {
    ink: [
      { d: 'M14 34 H34 V61 H14 Z' },
      { d: 'M50 36 A19 19 0 0 0 28 17', s: 5.5 },
      { d: 'M32 6 L38 20 L20 24 Z' },
      { d: 'M46 10 L52 1 L58 10 V26 H46 Z' },
    ],
    cut: [{ d: 'M19 42 H29', s: 3.5 }, { d: 'M19 51 H29', s: 3.5 }],
  },
  /** One heavy ink droplet — lifesteal. */
  droplet: {
    ink: [{ d: 'M32 1 C48 24 56 34 56 42 A24 24 0 0 1 8 42 C8 34 16 24 32 1 Z' }],
    cut: [{ d: 'M20 40 C19 48 23 54 29 57', s: 4.5 }],
  },
  /** A body-arrow skidding, with speed lines — slide damage. */
  slide: {
    ink: [
      { d: 'M22 12 L60 34 L22 56 L30 34 Z' },
      { d: 'M2 18 H18', s: 5 }, { d: 'M0 34 H14', s: 5 }, { d: 'M2 50 H18', s: 5 },
    ],
  },
  /** Medical cross with a pulse notch — health regen. */
  cross: {
    ink: [{ d: 'M24 4 H40 V23 H60 V41 H40 V60 H24 V41 H4 V23 H24 Z' }],
    cut: [{ d: 'M8 32 H21 L25 23 L31 43 L37 32 H56', s: 4 }],
  },
  /** A single feathered wing — the air jump. */
  wing: {
    ink: [{ d: 'M2 41 C14 8 43 2 62 6 C50 15 47 21 45 26 C40 24 34 24 30 26 C38 29 40 33 40 35 C33 35 27 37 23 41 C29 43 31 47 31 49 C21 45 9 45 2 41 Z' }],
    cut: [{ d: 'M18 30 C26 24 36 20 50 14', s: 3.5 }],
  },
  /** Crosshair with a solid centre — crit multiplier. */
  crosshair: {
    ink: [
      { c: [32, 32, 26] },
      { d: 'M32 0 V16', s: 6 }, { d: 'M32 48 V64', s: 6 },
      { d: 'M0 32 H16', s: 6 }, { d: 'M48 32 H64', s: 6 },
    ],
    cut: [{ c: [32, 32, 18] }],
    top: [{ c: [32, 32, 7] }],
  },
  /** Anvil — raw damage. */
  anvil: {
    ink: [
      { d: 'M4 13 H58 L46 28 H36 L42 41 H20 L27 28 H16 Z' },
      { d: 'M17 45 H47 V59 H17 Z' },
    ],
    cut: [{ d: 'M24 21 H44', s: 3.5 }],
  },
  /** A clean comic page with a folded corner — the perfect round. */
  page: {
    ink: [{ d: 'M11 3 H41 L53 15 V61 H11 Z' }],
    cut: [
      { d: 'M41 3 V15 H53', s: 4 },
      { d: 'M19 28 H45', s: 4 }, { d: 'M19 38 H45', s: 4 }, { d: 'M19 48 H36', s: 4 },
    ],
  },

  // ── epic ──────────────────────────────────────────────────────────────────────────────────
  /** Jagged explosion star — explosive rounds. */
  burst: {
    ink: [{ d: 'M32 0 L40 17 L57 9 L48 27 L64 33 L47 40 L54 58 L36 49 L31 64 L25 48 L8 56 L16 38 L0 32 L16 25 L8 7 L25 15 Z' }],
    cut: [{ c: [32, 32, 7] }],
  },
  /** Two links joined by a lightning kink — chain lightning. */
  chain: {
    ink: [
      { d: 'M2 19 H29 V45 H2 Z' },
      { d: 'M35 19 H62 V45 H35 Z' },
      { d: 'M34 8 L24 34 H32 L28 56 L42 30 H34 Z' },
    ],
    cut: [{ d: 'M10 26 H21 V38 H10 Z' }, { d: 'M43 26 H54 V38 H43 Z' }],
  },
  /** A cracked pane — Glass Cannon. */
  crack: {
    ink: [{ d: 'M7 4 H57 V60 H7 Z' }],
    cut: [
      { d: 'M32 4 L27 24 L38 31 L29 45 L34 60', s: 4.5 },
      { d: 'M27 24 L10 19', s: 3.5 },
      { d: 'M38 31 L55 26', s: 3.5 },
      { d: 'M29 45 L12 50', s: 3.5 },
    ],
  },
  /** Four raking speed lines — Kinetic Ink. */
  'speed-lines': {
    ink: [
      { d: 'M22 5 H62 L50 16 H10 Z' },
      { d: 'M30 20 H64 L52 31 H18 Z' },
      { d: 'M10 35 H52 L40 46 H-2 Z' },
      { d: 'M24 50 H60 L48 61 H12 Z' },
    ],
  },
  /** Three concentric jagged rings — blast radius. */
  ripple: {
    ink: [
      { d: 'M32 2 L41 15 L57 17 L49 32 L57 47 L41 49 L32 62 L23 49 L7 47 L15 32 L7 17 L23 15 Z', s: 5 },
      { d: 'M32 17 L37 24 L45 26 L41 32 L45 40 L37 42 L32 49 L27 42 L19 40 L23 32 L19 26 L27 24 Z', s: 4.5 },
      { c: [32, 32, 5] },
    ],
  },
  /** A bird rising out of an ink blot — self-revive. */
  phoenix: {
    ink: [
      { d: 'M32 3 C36 15 41 20 47 23 C41 25 36 27 34 32 L34 47 H30 V32 C28 27 23 25 17 23 C23 20 28 15 32 3 Z' },
      { d: 'M2 30 C13 20 26 24 32 33 C21 34 10 37 2 30 Z' },
      { d: 'M62 30 C51 20 38 24 32 33 C43 34 54 37 62 30 Z' },
      { d: 'M5 55 C14 49 22 59 32 55 C42 51 51 60 60 55 C57 63 8 63 5 55 Z' },
    ],
  },

  // ── legendary ─────────────────────────────────────────────────────────────────────────────
  /** A comic panel frame with a corner torn off — Panel Break. */
  panel: {
    ink: [{ d: 'M3 3 H61 V61 H3 Z' }],
    cut: [{ d: 'M14 14 H50 V50 H14 Z' }, { d: 'M44 -2 L66 20 V-2 Z' }, { d: 'M40 -1 L64 23', s: 4 }],
  },
  /** Two overlapping eyes, offset like a mis-registered plate — Double Vision. */
  eye: {
    ink: [
      { d: 'M1 30 C11 14 27 14 37 30 C27 46 11 46 1 30 Z' },
      { d: 'M27 34 C37 18 53 18 63 34 C53 50 37 50 27 34 Z' },
    ],
    cut: [{ c: [19, 30, 6] }, { c: [45, 34, 6] }],
  },
  /** A spilled inkwell with a quill — the Ink Pact. */
  inkwell: {
    ink: [
      { d: 'M13 29 H51 L46 60 H18 Z' },
      { d: 'M21 18 H43 V29 H21 Z' },
      { d: 'M1 60 C9 51 17 58 24 53 L27 60 Z' },
      { d: 'M39 25 C48 15 55 8 63 3', s: 6 },
      { d: 'M34 31 L44 22 L47 29 Z' },
    ],
    cut: [{ d: 'M22 38 H42', s: 3.5 }],
  },
  /** A d6 mid-tumble — Wild Draw. */
  dice: {
    ink: [{ d: 'M32 2 L62 32 L32 62 L2 32 Z' }],
    cut: [{ c: [32, 17, 4.4] }, { c: [21, 32, 4.4] }, { c: [43, 32, 4.4] }, { c: [32, 47, 4.4] }],
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────

function opMarkup(op: Op): string {
  const stroke = op.s !== undefined && op.s > 0;
  const paint = stroke
    ? `fill="none" stroke-width="${op.s}" stroke-linejoin="round" stroke-linecap="round"`
    : 'stroke="none"';
  if ('c' in op) {
    const [cx, cy, r] = op.c;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" ${paint}/>`;
  }
  return `<path d="${op.d}" ${paint}/>`;
}

function layer(ops: readonly Op[], colour: string, dx = 0): string {
  if (ops.length === 0) return '';
  const t = dx !== 0 ? ` transform="translate(${dx},${dx})"` : '';
  return `<g${t} fill="${colour}" stroke="${colour}">${ops.map(opMarkup).join('')}</g>`;
}

/**
 * SVG markup for one boon glyph.
 *
 * `accent` is the mis-registered plate behind the ink (the card's rarity colour); `knockout` is
 * the card's own paper colour, which the interior detail is cut out in. Returns markup rather
 * than a node because every caller is building a card out of a template anyway, and one string
 * assignment beats twenty `createElementNS` calls.
 */
export function iconSvg(id: BoonIconId, accent: PaletteToken, knockout: PaletteToken): string {
  const g = GLYPHS[id];
  const ink = css('INK');
  return (
    `<svg class="cz-glyph" viewBox="-3 -3 70 70" aria-hidden="true">` +
    layer(g.ink, css(accent), SHADOW_OFFSET) +
    layer(g.ink, ink) +
    layer(g.cut ?? [], css(knockout)) +
    layer(g.top ?? [], ink) +
    `</svg>`
  );
}

/**
 * Fall back safely if a def ever carries an icon id outside the vocabulary. It cannot happen
 * through `BOON_DEFS` (the `def()` helper is typed) but `BoonDef.icon` is a bare `string` in the
 * frozen contract, so the UI must not throw on one.
 */
export function isIconId(v: string): v is BoonIconId {
  return Object.prototype.hasOwnProperty.call(GLYPHS, v);
}

/** The glyph used when an unknown icon id arrives. */
export const FALLBACK_ICON: BoonIconId = 'page';

export { PALETTE };

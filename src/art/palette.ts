/**
 * THE LOCKED PALETTE. See docs/ART_DIRECTION.md §1.
 *
 * No system file may contain a raw hex colour. Everything comes from here.
 * Max 2 hues per material. Saturation stays high — never desaturate toward mud.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUILD 002 — THE COLOUR PASS.  "we need better coloring" / "visuals are the most important"
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * BUILD 001 was measured, not guessed: a plaza frame was 49% of pixels under 0.1 luminance and
 * only 10% in the 0.2–0.7 midtone band, and its two hue clusters (violet ~270°, gold ~45°) held
 * 69% of all chromatic pixels. Half the picture was a void and the other half was one flat tone.
 * Two structural faults caused it, and both are fixed HERE, in the ink set:
 *
 *   1. NO MIDDLE OF THE VALUE LADDER. The environment tokens were BONE 0.73 / PAPER 0.91 for
 *      the ground and NIGHT_B 0.17 / INK_SOFT 0.13 / NIGHT_A 0.10 for everything vertical.
 *      There was literally nothing authored between 0.19 and 0.73, so no lighting rig on earth
 *      could have produced a midtone-led frame. `CONCRETE`, `SLATE` and `TEAL` fill that gap;
 *      `NIGHT_A`, `NIGHT_B` and `INK_SOFT` were re-valued up out of the void.
 *   2. NO HUE OPPOSITION. Violet + gold are 40° apart on the warm side of the wheel once gold
 *      lands on a violet ground — they are the same colour story. A comic night page is built
 *      on a COMPLEMENTARY SPLIT: cool shadow, warm light. `TEAL` is now the cool half and
 *      `SODIUM` the warm half, with violet `NIGHT_B` as the connective mid between them.
 *
 * The reserved channels did not move. `ACID` and `HOT` still belong to enemies (ART §9) and no
 * large environment surface may use them; `GOLD` is now spent only on interactables, because
 * generic street lighting moved to `SODIUM`.
 *
 * VALUE LADDER (sRGB luma of the raw token — where each one sits on the page):
 *
 *   INK      0.03  │ linework only, the reserved black
 *   NIGHT_A  0.15  │ sky zenith, fog far, ambient floor
 *   INK_SOFT 0.18  │ secondary line, cool shadow band
 *   NIGHT_B  0.23  │ sky horizon, fog near, the connective violet
 *   SLATE    0.32  │ building mass — the biggest vertical area in the frame
 *   TEAL     0.44  │ cool shadow accent, glass, fill light
 *   CONCRETE 0.52  │ roadway and plaza ground
 *   SODIUM   0.66  │ street practicals, warm key
 *   BONE     0.73  │ sidewalk, trim, wood
 *   PAPER    0.91  │ road markings, highlight, UI — the reserved white
 */

import { Color, SRGBColorSpace } from 'three';

export const PALETTE = {
  /** The blackest black. Outlines, deepest shadow, panel gutters. RESERVED FOR LINEWORK. */
  INK: 0x0b0a14,
  /**
   * Secondary lines, shadow band on cool surfaces.
   * BUILD 002: re-valued 0x221f38 → 0x262e4c (luma 0.13 → 0.18) and turned from violet-black
   * toward blue. It is the shadow hue of half the level; at 0.13 every one of those surfaces
   * was inside the sub-0.1 void once the shadow band multiplied it.
   */
  INK_SOFT: 0x262e4c,
  /** Newsprint highlight, UI cards, bone, teeth. RESERVED as the frame's brightest value. */
  PAPER: 0xf2e8d5,
  /**
   * Sky zenith / fog far / ambient floor.
   * BUILD 002: re-valued 0x1a1636 → 0x1d2747. Same darkness family, but navy-indigo instead of
   * violet-black and lifted from 0.10 to 0.15 — this token alone was ~20% of the frame sitting
   * under the 0.1 line, and as `uAmbient` it sets the shadow floor of every material.
   */
  NIGHT_A: 0x1d2747,
  /**
   * Sky horizon / fog near / ambient bounce. The CONNECTIVE VIOLET that ties the cool shadow
   * family to the warm practicals.
   * BUILD 002: re-valued 0x3a2159 → 0x4d2e82. Same hue, more saturated, luma 0.17 → 0.23.
   */
  NIGHT_B: 0x4d2e82,
  /** Blood-ink, danger, damage, crit. RESERVED FOR ENEMIES + damage (ART §9). */
  HOT: 0xff2e63,
  /** Player energy, UI accent, shock affix. */
  ELECTRIC: 0x00e5ff,
  /** Zombie flesh, toxic, spitter. RESERVED FOR ENEMIES (ART §9). */
  ACID: 0x8cff3e,
  /** Points, power-ups, muzzle core, rewards. Gameplay-critical: marks INTERACTABLES only. */
  GOLD: 0xffc531,
  /** Fire, explosions, burn barrels. */
  RUST: 0xf4761b,
  /** Environment mid-tones: wood, sidewalk, cloth. */
  BONE: 0xcbb89a,

  // ── BUILD 002 environment tokens ──────────────────────────────────────────
  // Four, deliberately. A colourist picking inks for a night sequence buys the cool half of
  // the split, the warm half, and the two neutrals that carry the biggest areas of the page.

  /**
   * THE COOL HALF OF THE SPLIT. Deep petrol teal — the shadow family, night glass, the fill
   * light, and the walkable-edge accent. Sits at 0.44, dead centre of the midtone band, which
   * is why it is the workhorse: a teal shadow on a warm surface still reads as a MIDTONE.
   * Distinct from `ELECTRIC` on purpose — ELECTRIC is a UI/player signal, TEAL is architecture.
   */
  TEAL: 0x2f7f8f,
  /**
   * THE WARM HALF OF THE SPLIT. Sodium-vapour street lighting: the orange every real night
   * street is actually lit by. Generic lamps, god-ray cones and ground pools are SODIUM, which
   * is what frees `GOLD` to mean "you can interact with this" again (ART §6).
   */
  SODIUM: 0xff9a3c,
  /**
   * Roadway, plaza deck, kerb — the biggest single surface in the frame. A warm mid-grey, NOT
   * paper white: BUILD 001 painted the ground `PAPER`, which blew 33% of the frame past 0.7,
   * left no headroom for light pools, and gave a bright enemy nothing to read against.
   */
  CONCRETE: 0x8f8474,
  /**
   * Building mass — the second biggest area, and the one that used to be a flat violet slab.
   * A cool blue-grey slate: dark enough to stay behind the action, light enough to hold
   * screen-tone, linework and signage, and opposite the sodium practicals in hue.
   */
  SLATE: 0x445270,
} as const;

export type PaletteToken = keyof typeof PALETTE;

/**
 * The tokens above are authored as **sRGB** hex, the way a colourist picks them. Shaders and
 * lights need them in the renderer's **linear** working space.
 *
 * `setHex(hex, SRGBColorSpace)` is the one correct way to cross that boundary. It is NOT the
 * same as `new Color(hex).convertSRGBToLinear()`: three's `ColorManagement` is enabled by
 * default (r152+), so `new Color(hex)` has *already* landed in the working space, and the extra
 * `convertSRGBToLinear()` converts a second time — which crushes `NIGHT_A` by 13×, turns every
 * shadow into pure black, and warms `PAPER` off-palette. Being explicit here also keeps this
 * correct if the working colour space is ever changed globally.
 */
function toWorking(hex: number): Color {
  return new Color().setHex(hex, SRGBColorSpace);
}

const _cache = new Map<number, Color>();
/** Shared immutable Color instances — do not mutate the result. */
export function color(hex: number): Color {
  let c = _cache.get(hex);
  if (!c) { c = toWorking(hex); _cache.set(hex, c); }
  return c;
}

/** Fresh mutable Color from a token. */
export function col(token: PaletteToken): Color {
  return toWorking(PALETTE[token]);
}

/** `#rrggbb` string, for DOM/canvas use (sRGB, not linear). */
export function css(token: PaletteToken, alpha = 1): string {
  const h = PALETTE[token];
  if (alpha >= 1) return `#${h.toString(16).padStart(6, '0')}`;
  return `rgba(${(h >> 16) & 255},${(h >> 8) & 255},${h & 255},${alpha})`;
}

/** Nudge a colour toward another without leaving the palette's saturation range. */
export function mix(a: number, b: number, t: number): Color {
  return color(a).clone().lerp(color(b), t);
}

/**
 * A two-token blend as a packed **sRGB hex**, for APIs that take a hex rather than a `Color`
 * (material bucket tables, light specs). This is the sanctioned way to author an in-between
 * value without minting a new token — the same rule `cssMix` states for canvas work. Blending
 * happens in sRGB bytes on purpose: that is the space a colourist mixes ink in, and it is what
 * keeps the result on the palette's own value ramp instead of washing out through linear light.
 */
export function hexMix(a: number, b: number, t: number): number {
  const u = Math.max(0, Math.min(1, t));
  const r = Math.round(((a >> 16) & 255) + ((((b >> 16) & 255)) - ((a >> 16) & 255)) * u);
  const g = Math.round(((a >> 8) & 255) + ((((b >> 8) & 255)) - ((a >> 8) & 255)) * u);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * u);
  return (r << 16) | (g << 8) | bl;
}

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS-SIDE HELPERS (added by art-lib)
//
// Procedural textures are painted with the 2D canvas API, which works in *sRGB
// bytes*, not linear-light Colors. These helpers keep `src/art/textures.ts` and
// `src/art/letters.ts` free of raw hex while giving them byte-accurate mixing.
// ─────────────────────────────────────────────────────────────────────────────

/** An sRGB byte triple, the currency of canvas painting. */
export type RGB8 = readonly [r: number, g: number, b: number];

/** sRGB byte triple for a palette token. */
export function rgb8(token: PaletteToken): RGB8 {
  const h = PALETTE[token];
  return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
}

/** sRGB byte triple for a palette *value* (e.g. `PALETTE.HOT`, or a token lookup). */
export function rgb8Hex(hex: number): RGB8 {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

const _l = (a: number, b: number, t: number): number =>
  Math.max(0, Math.min(255, Math.round(a + (b - a) * t)));

/** Blend two palette tokens in canvas (sRGB) space. `t=0` → a, `t=1` → b. */
export function rgb8Mix(a: PaletteToken, b: PaletteToken, t: number): RGB8 {
  const x = rgb8(a);
  const y = rgb8(b);
  return [_l(x[0], y[0], t), _l(x[1], y[1], t), _l(x[2], y[2], t)];
}

/** Blend two byte triples. */
export function mix8(a: RGB8, b: RGB8, t: number): RGB8 {
  return [_l(a[0], b[0], t), _l(a[1], b[1], t), _l(a[2], b[2], t)];
}

/** `rgb()` / `rgba()` string for a byte triple. */
export function cssOf(c: RGB8, alpha = 1): string {
  return alpha >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/** Push a token toward `INK`. Saturation is preserved — this is a value move, not a desaturation. */
export function shade(token: PaletteToken, amount: number, alpha = 1): string {
  return cssOf(rgb8Mix(token, 'INK', amount), alpha);
}

/** Push a token toward `PAPER` (the comic "highlight" move). */
export function tint(token: PaletteToken, amount: number, alpha = 1): string {
  return cssOf(rgb8Mix(token, 'PAPER', amount), alpha);
}

/** Two-token blend as a css string — the only sanctioned way to make an in-between colour. */
export function cssMix(a: PaletteToken, b: PaletteToken, t: number, alpha = 1): string {
  return cssOf(rgb8Mix(a, b, t), alpha);
}

/**
 * Semantic assignments — use these, not the raw tokens, wherever meaning exists.
 * Keeps the game readable: danger is always HOT, reward is always GOLD.
 */
export const SEMANTIC = {
  danger: PALETTE.HOT,
  reward: PALETTE.GOLD,
  player: PALETTE.ELECTRIC,
  enemy: PALETTE.ACID,
  fire: PALETTE.RUST,
  outline: PALETTE.INK,
  ui: PALETTE.PAPER,
  fogNear: PALETTE.NIGHT_B,
  fogFar: PALETTE.NIGHT_A,
  /** Generic street lighting. NOT a gameplay signal — see `interactable`. */
  practical: PALETTE.SODIUM,
  /** A thing the player can use, buy, mantle or open. The ONLY meaning `GOLD` carries. */
  interactable: PALETTE.GOLD,
  /** The cool half of the night split: shadow, glass, fill. */
  shadowCool: PALETTE.TEAL,
} as const;

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE READABILITY CONTRACT, in numbers. ART_DIRECTION §9, enforced here so it is one import
 * away from every system that draws something.
 *
 * The environment is authored to live between `ENV_VALUE_FLOOR` and `ENV_VALUE_CEIL`. That
 * band is what guarantees an enemy silhouette pops against ANY part of the arena: `ACID`
 * (0.79) is above the ceiling and an enemy's ink weight is below the floor, so a zombie is
 * simultaneously brighter than the brightest wall and blacker-edged than the darkest one.
 * Break the band and you break the game, not the picture.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
export const READABILITY = {
  /** Nothing in the environment is darker than this except LINEWORK. */
  ENV_VALUE_FLOOR: 0.12,
  /** Nothing in the environment is brighter than this except road markings and practicals. */
  ENV_VALUE_CEIL: 0.78,
  /** Hues no large environment surface may take. Enemies own them. */
  RESERVED_HUES: [PALETTE.ACID, PALETTE.HOT] as const,
  /**
   * Screen-px ink weight, and it is a strict ORDER, not three independent numbers:
   *
   *     enemy 8  >  viewmodel 7  >  heaviest prop 6
   *
   * An inker builds depth with weight — hero contour bold, background thin — and the two things
   * the player looks at most are the zombie and the gun, in that order. M2 §1 requires the
   * viewmodel to carry "the heaviest outline weight of any non-enemy object"; shipping it at the
   * PROP cap made the gun's contour indistinguishable from the dumpster in front of it, which is
   * a missing hierarchy exactly where the eye lives. One contract, three call sites, so the
   * ordering cannot drift.
   */
  ENEMY_OUTLINE_PX: 8,
  VIEWMODEL_OUTLINE_PX: 7,
  PROP_OUTLINE_MAX_PX: 6,
} as const;

/** sRGB-encoded luma of a palette value — the number a histogram of the frame reports. */
export function luma(hex: number): number {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

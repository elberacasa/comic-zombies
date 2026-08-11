/**
 * THE HUD — comic panel furniture, not sci-fi glass. See ART_DIRECTION §7.
 *
 * WHY DOM AND NOT A CANVAS: a HUD is text and hard edges. The browser rasterises DOM text at
 * device resolution with subpixel-accurate hinting; a canvas HUD is a texture that has to be
 * re-uploaded, and at 1080p→4K it either blurs or costs a full-screen upload every frame. Every
 * element here is a rectangle, a border and a shadow — exactly what the compositor is fastest at.
 * The whole layer is `pointer-events:none` so click-to-lock always reaches the canvas.
 *
 * THE LANGUAGE (every rule below is applied to every element, no exceptions):
 *   · 4–6px INK borders. No thin lines, ever. A 1px border reads as a web page.
 *   · Hard offset drop shadows in flat INK. Never a blur — a blurred shadow is not printed ink.
 *   · Halftone dot fill behind numbers (a CSS radial-gradient tile, 5px pitch).
 *   · ±1–4° rotation on every card so the page never looks like a CSS grid.
 *   · Values PUNCH when they change: 1 → 1.32 → 0.94 → 1 in 280ms. Overshoot, then settle.
 *   · Semantic colour only: HOT = danger, GOLD = reward, ELECTRIC = player, PAPER = card.
 *
 * ANIMATION is Web Animations API rather than CSS classes: it gives exact control of the
 * hold-frame (ART §8) — a pose parked for 3–4 frames before a fast transition — which is what
 * makes the title card read as *drawn* rather than *tweened*.
 */

import type * as THREE from 'three';
import { Vector3 } from 'three';

import type { BoonDef, GameCtx, HudService, System, WeaponInstance } from '@/core/types';
import { PALETTE, css } from '@/art/palette';
import { ROUND } from '@/game/tuning';
import { FALLBACK_ICON, iconSvg, isIconId } from '@/ui/icons';
import { NavPanels } from '@/ui/minimap';

/** Module scratch — the HUD allocates nothing inside a handler or a frame. */
const _toSrc = new Vector3();
const _fwd = new Vector3();
const _rgt = new Vector3();

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const FONT = 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif';

/** Crosshair geometry, in CSS pixels at the SVG's 1:1 viewBox. */
const CH = {
  /** Gap from centre at zero spread. */
  minGap: 7,
  maxGap: 46,
  tickLength: 9,
  inkWidth: 3.6,
  paperWidth: 7.2,
  /** How fast the gap chases the requested spread. Snappy, but not instant. */
  chase: 18,
  /**
   * THE ADS FADE (BUILD 005). Once the iron sights actually line up on the camera axis — which
   * is what M3.5 fixed — the crosshair is drawn ON TOP OF the front post it duplicates. It is
   * redundant (the sight IS the aiming reference) and it is clutter in the one place the player
   * is looking hardest. So it fades out as the sights come up and returns the instant they drop.
   *
   * It never reaches zero: a sliver of crosshair is the difference between "aimed" and "the HUD
   * has died", and it costs nothing to keep. Measured against the shipped sight picture, 0.12
   * is invisible over the post and still legible against the dark plaza floor.
   */
  adsOpacity: 0.12,
  /**
   * Fraction of the weapon's own `adsTime` this fade takes. Slightly faster than the pose so
   * the crosshair is out of the way BEFORE the notch settles, never after.
   */
  adsFadeFraction: 0.75,
} as const;

/** The four tick rotations, built once — they never change, only the translate does. */
const CROSS_ROT = ['rotate(0)', 'rotate(90)', 'rotate(180)', 'rotate(270)'] as const;

const TITLE_HOLD = 3 / 60;

/** Active-reload bar geometry and timing. Presentation only — the truth is in `WEAPON`. */
const AR = {
  /** Inner track width in CSS px; must match `.cz-ar-track`. */
  trackW: 268,
  /** How long PERFECT! / MISSED stays up after the reload ends. */
  resultHold: 0.5,
} as const;

/** Damage-direction chevrons. */
const DMG = {
  slots: 6,
  /** Seconds a chevron stays up. */
  life: 1.15,
  /** Distance from centre, in the SVG's 1:1 units. */
  radius: 138,
  halfWidth: 40,
  depth: 26,
} as const;

/**
 * HIT DAMAGE NUMBERS — "how hard did that land".
 *
 * The world-space numbers (`vfx/emitters.ts::NumberEmitter`) print into the blood, at the wound,
 * under the spray, and they merge for 0.18 s per target — which is the right *effect* and the
 * wrong *reading*: by the time you have parsed one it is a running total of three bullets. The
 * HUD copy is the readable one. It sits beside the crosshair, where the eye already is, on PAPER
 * over ink so it survives a red screen.
 *
 * ONE TRIGGER PULL = ONE NUMBER. `mergeWindow` is 45 ms, deliberately *below* the fastest fire
 * interval in the arsenal (ratatat, 900 rpm = 66.7 ms). So a shotgun's 8 pellets and a marksman
 * round's 3 penetration hits — all resolved inside a single frame — add into one number, and two
 * pulls of the trigger never do. That is the difference between reading your damage and reading
 * an accumulator.
 */
const HITNUM = {
  slots: 8,
  /** Seconds on screen. Long enough to read at a glance, short enough not to queue up. */
  life: 0.58,
  /** See above: must stay under 60 ms or auto fire chains into one growing total. */
  mergeWindow: 0.045,
  /**
   * Slot anchors: [x, y, tilt°] in CSS px from screen centre, applied ONCE at construction.
   *
   * Right and below the crosshair only — never above it, which is where the head you are
   * shooting at is. Slots are handed out in order and recycled in order, so consecutive numbers
   * are always at different anchors and a burst cascades down the fan instead of strobing in
   * one spot. No randomness: the HUD is deterministic like everything else.
   */
  anchors: [
    [52, 18, -5], [76, 44, 4], [46, 68, -3], [86, 92, 6],
    [58, 116, -6], [92, 20, 3], [40, 44, -4], [70, 68, 5],
  ],
} as const;

/**
 * Damage → the string on screen, QUANTISED so the set of strings it can ever produce is finite.
 *
 * Why quantise at all: word and number art is cached by string (`art/letters.ts`), and damage is
 * a float — range falloff alone makes 41.83 and 41.79 two different values, so printing raw
 * `amount` mints a new cache entry per bullet and leaks textures for the life of the session.
 * This HUD readout is DOM and does not touch that cache, but it feeds the same `damageLabel()`
 * contract the world numbers should use, and the memo below is only bounded because the input is.
 *
 * The buckets are chosen so the rounding is always smaller than the thing it is describing:
 *   ·   1‥99   → exact integer          →  99 strings   (every body shot in the game today)
 *   · 100‥999  → nearest 5  (≤2.5% off) → 180 strings   (crits, shotgun broadsides)
 *   · 1000‥9975→ nearest 25 (≤1.3% off) → 360 strings   (Pack-a-Punch / insta-kill territory)
 *   · above    → the single string "9999+"               →   1 string
 * TOTAL: **640 distinct strings, forever**, whatever the damage curve does later. Clamping, not
 * truncating, at the top: taking 4 digits off 12345 shows "1234", which is wrong by 10× and
 * silent — the same reasoning as `NumberEmitter.layout`.
 */
const HITNUM_MAX_LABELS = 640;
const _labelMemo = new Map<number, string>();

function damageLabel(amount: number): string {
  // Floor at 1: a hit that connected must never print "0". A grazing pellet at maximum falloff
  // rounds to nothing, and "0" reads as "your gun does not work" rather than "barely".
  const a = Math.max(1, Math.round(amount));
  let q: number;
  if (a < 100) q = a;
  else if (a < 1000) q = Math.round(a / 5) * 5;
  else if (a <= 9975) q = Math.round(a / 25) * 25;
  else q = -1;
  // Memoised so a sustained burst writes textContent without allocating a string per bullet.
  // The map can never exceed HITNUM_MAX_LABELS entries because `q` above is a bounded set.
  let s = _labelMemo.get(q);
  if (s === undefined) {
    s = q < 0 ? '9999+' : String(q);
    // The cap is unreachable by construction — it is here so that if someone widens a bucket
    // later, the memo stops growing instead of quietly becoming a leak.
    if (_labelMemo.size < HITNUM_MAX_LABELS) _labelMemo.set(q, s);
  }
  return s;
}

/**
 * Pre-built keyframes. WAAPI copies the array it is given, so one frozen array per variant means
 * a hit costs exactly one `Animation` object instead of an array plus four object literals — and
 * at 900 rpm into a horde that is the difference between a flat heap and a sawtooth.
 *
 * The OUTER element carries the anchor and the tilt as static CSS; only the inner <i> is
 * animated, so these four keyframes serve all eight slots.
 */
const HITNUM_KF_BODY: Keyframe[] = [
  { transform: 'translateY(8px) scale(.55) rotate(-9deg)', opacity: 0, offset: 0 },
  { transform: 'translateY(-2px) scale(1.2) rotate(3deg)', opacity: 1, offset: 0.15 },
  { transform: 'translateY(-6px) scale(1) rotate(0deg)', opacity: 1, offset: 0.3 },
  { transform: 'translateY(-38px) scale(.9) rotate(4deg)', opacity: 0, offset: 1 },
];
/** A crit hits harder on every channel at once: it is HOT, it is bigger, and it SLAMS. */
const HITNUM_KF_CRIT: Keyframe[] = [
  { transform: 'translateY(10px) scale(.5) rotate(-13deg)', opacity: 0, offset: 0 },
  { transform: 'translateY(-4px) scale(1.5) rotate(5deg)', opacity: 1, offset: 0.13 },
  { transform: 'translateY(-8px) scale(1.18) rotate(0deg)', opacity: 1, offset: 0.32 },
  { transform: 'translateY(-52px) scale(1.02) rotate(6deg)', opacity: 0, offset: 1 },
];
const HITNUM_KF_KILL: Keyframe[] = [
  { transform: 'translateY(12px) scale(.5) rotate(14deg)', opacity: 0, offset: 0 },
  { transform: 'translateY(-6px) scale(1.62) rotate(-6deg)', opacity: 1, offset: 0.12 },
  { transform: 'translateY(-10px) scale(1.24) rotate(0deg)', opacity: 1, offset: 0.34 },
  { transform: 'translateY(-58px) scale(1.06) rotate(-7deg)', opacity: 0, offset: 1 },
];
const HITNUM_TIMING: KeyframeAnimationOptions = {
  duration: HITNUM.life * 1000,
  easing: 'cubic-bezier(.15,.9,.3,1)',
  fill: 'forwards',
};

/**
 * The hit marker's three poses, likewise frozen. This used to build a 3-entry array with three
 * object literals — and call `getAnimations()`, which allocates an array of its own — on EVERY
 * bullet that connected. It was the last per-hit allocation left in the HUD.
 */
const HITMARK_KF_BODY: Keyframe[] = [
  { transform: 'scale(.55) rotate(0deg)', opacity: 1 },
  { transform: 'scale(1) rotate(0deg)', opacity: 1, offset: 0.35 },
  { transform: 'scale(1.12) rotate(0deg)', opacity: 0 },
];
const HITMARK_KF_CRIT: Keyframe[] = [
  { transform: 'scale(.69) rotate(0deg)', opacity: 1 },
  { transform: 'scale(1.25) rotate(0deg)', opacity: 1, offset: 0.35 },
  { transform: 'scale(1.4) rotate(0deg)', opacity: 0 },
];
const HITMARK_KF_KILL: Keyframe[] = [
  { transform: 'scale(.83) rotate(-14deg)', opacity: 1 },
  { transform: 'scale(1.5) rotate(0deg)', opacity: 1, offset: 0.35 },
  { transform: 'scale(1.68) rotate(0deg)', opacity: 0 },
];
const HITMARK_TIME_HIT: KeyframeAnimationOptions = { duration: 180, easing: 'cubic-bezier(.15,.9,.3,1)' };
const HITMARK_TIME_KILL: KeyframeAnimationOptions = { duration: 300, easing: 'cubic-bezier(.15,.9,.3,1)' };

/** Below this fraction of the largest magazine we have seen, the ammo readout goes HOT. */
const LOW_AMMO_FRAC = 0.26;

/**
 * THE POINTS COUNTER.
 *
 * A points readout that snaps is a number; one that *rolls* is a slot machine, and a slot machine
 * is the reason anyone plays one more round. The roll is deliberately bounded at both ends: fast
 * enough that the display has always caught up before the next kill lands (`rollRate` is a
 * fraction of the remaining gap per second, so a 5,000-point nuke and a 60-point body shot both
 * settle in about the same time), and hard-snapped inside `rollSnap` so it can never sit one
 * point away forever writing to the DOM. When it lands, it STOPS — that is the ART §4.1 contract.
 */
const POINTS = {
  rollRate: 11,
  /** Below this gap, jump straight to the total and stop animating. */
  rollSnap: 2,
  /** A second award inside this window merges into the floater already on screen. */
  mergeWindow: 0.28,
  floaters: 6,
} as const;

/** Power-up buff readouts. The durations are the director's; we only draw them. */
const BUFF_LABEL: Record<string, string> = {
  double_points: 'DOUBLE POINTS',
  insta_kill: 'INSTA-KILL',
  carnage: 'CARNAGE',
};
const BUFF_TIME: Record<string, number> = {
  double_points: ROUND.powerupDoublePointsTime,
  insta_kill: ROUND.powerupInstaKillTime,
  carnage: ROUND.powerupCarnageTime,
};

/**
 * The parts of the round director the HUD needs that are NOT on `RoundService`.
 *
 * Named and typed rather than probed: `main.ts` hands the real `RoundSystem` to
 * `attachRounds()`, so tsc checks the shape at the call site and a rename breaks the build
 * instead of silently leaving the combo bar frozen at full.
 */
export interface RoundExtras {
  /** 0..1 of the combo window still left. */
  readonly comboGraceFraction: number;
  /** True on a surge round — doubled rewards, mixed composition. */
  readonly isSurge: boolean;
}

export interface HudOptions {
  /** Defaults to `#ui`, then `document.body`. */
  container?: HTMLElement;
  /** Start hidden — `main.ts` reveals the HUD when the boot overlay fades. */
  visible?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles. One <style> element, injected once, all colours from the palette.
// ─────────────────────────────────────────────────────────────────────────────

function styleSheet(): string {
  const ink = css('INK');
  const inkSoft = css('INK_SOFT');
  const paper = css('PAPER');
  const hot = css('HOT');
  const gold = css('GOLD');
  const electric = css('ELECTRIC');
  const acid = css('ACID');
  const rust = css('RUST');
  const shadow = css('INK', 0.92);
  const dots = css('INK', 0.26);

  return `
.cz-hud {
  position: absolute; inset: 0; pointer-events: none; overflow: hidden;
  font-family: ${FONT}; color: ${ink};
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  user-select: none; -webkit-user-select: none;
  transition: opacity .18s steps(3, end);
}
.cz-hud[data-hidden="1"] { opacity: 0; }

/* ── the halftone tile every card is filled with ─────────────────────────── */
.cz-tone::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background-image: radial-gradient(circle at 50% 50%, ${dots} 1.15px, transparent 1.35px);
  background-size: 5px 5px;
  mix-blend-mode: multiply;
}

/* ── badges ──────────────────────────────────────────────────────────────── */
.cz-badge {
  position: absolute; display: flex; align-items: flex-end; gap: .5rem;
  background: ${paper}; border: 5px solid ${ink};
  box-shadow: 7px 7px 0 ${shadow};
  padding: .22rem .85rem .32rem;
  line-height: 1;
}
.cz-badge > * { position: relative; z-index: 1; }
/* The small caption over each gauge ("ROUND", "POINTS", "AMMO").
 *
 * Was .72rem / .2em tracking / .72 opacity — three legibility taxes stacked on the same element,
 * which is the other half of "some things are a bit blurry". Impact is a CONDENSED face: it is
 * already narrow, so wide tracking at a small size pulls the letters apart until the word loses
 * its shape and you are reading glyph by glyph. And .72 opacity over a halftone panel drops the
 * contrast right where the strokes are thinnest.
 *
 * Bigger, tighter, and more opaque. Still clearly subordinate to the value it labels — that is
 * what the size step and the remaining opacity are for — but now readable at a glance mid-fight,
 * which is the only moment it is ever read. */
.cz-label {
  font-size: .8rem; letter-spacing: .12em; color: ${ink};
  opacity: .86; padding-bottom: .28rem; white-space: nowrap;
}
.cz-value {
  font-size: 2.5rem; letter-spacing: .01em; display: inline-block;
  transform-origin: 50% 70%;
  text-shadow: 2px 2px 0 ${css('INK', 0.18)};
}
.cz-value.sm { font-size: 1.55rem; }

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * NOTHING THE PLAYER READS IS ROTATED. Do not re-add a tilt to a panel below this line.
 *
 * Every persistent panel used to carry one — round -2.2deg, points 1.7, health 1.1, ammo -1.5,
 * combo 2.4, the buff and deck chips, the toasts, and (worst) the run-summary CARD at -2deg,
 * which rotated every stat row inside it regardless of the row's own transform.
 *
 * The playtester filed two separate notes: "some things are a bit blurry" and "what if we mde
 * everything straight instead of to a side". They are ONE defect. A rotated DOM element cannot
 * rasterise its glyphs onto the pixel grid — the browser renders the text and then resamples it
 * along a non-axis-aligned axis, so every stem picks up subpixel antialiasing it would not
 * otherwise have. 1-2 degrees is the worst possible amount: enough to destroy grid alignment,
 * too little to read as a deliberate angle. It looked blurry because it WAS blurry.
 *
 * THE RULE: the tilt moves from the TYPE to the FRAME, and from the PERSISTENT to the TRANSIENT.
 *   · Instruments you read mid-fight — round, points, health, ammo, combo, buffs, toasts, the
 *     run summary — are axis-aligned. They are gauges, and a gauge must be crisp.
 *   · The comic character is carried by the things that do not hold type: the heavy ink borders,
 *     the hard offset drop shadows (flat INK, never a blur), the halftone fills, the letterforms
 *     themselves. A straight panel with a hand-inked border still reads as a comic panel.
 *   · Deliberate BEATS keep their kinetics, because those are drawings, not instruments — the
 *     round title card, the SURGE sticker, and every popup/onomatopoeia animation below. You
 *     feel those; you do not read them character by character.
 *
 * The test for anything new: is the player READING it, or FEELING it? Reading wins → straight.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
.cz-round  { top: 26px; left: 28px; }
.cz-round .cz-value { color: ${ink}; }
.cz-points { top: 26px; right: 28px; background: ${gold}; }
.cz-points .cz-value { color: ${ink}; }
.cz-health { bottom: 30px; left: 28px; flex-direction: column; align-items: flex-start; gap: .3rem; }
.cz-ammo   { bottom: 30px; right: 28px; }
.cz-ammo .cz-value { color: ${ink}; }
.cz-ammo .cz-reserve { font-size: 1.15rem; color: ${ink}; opacity: .6; padding-bottom: .35rem; }
/* Value contrast does the warning, never a blink: an animation that loops while the player
   stands still is exactly what ART §4.1 forbids. Low mag turns the number HOT; empty adds a
   printed tag. Both are STATIC once they land. */
.cz-ammo[data-low="1"]   .cz-value { color: ${hot}; }
.cz-ammo[data-empty="1"] { background: ${hot}; }
.cz-ammo[data-empty="1"] .cz-value,
.cz-ammo[data-empty="1"] .cz-label,
.cz-ammo[data-empty="1"] .cz-reserve { color: ${paper}; }
.cz-reload-tag {
  position: absolute; bottom: 108px; right: 28px;
  background: ${hot}; color: ${paper}; border: 4px solid ${ink};
  box-shadow: 6px 6px 0 ${shadow};
  padding: .18rem .8rem .26rem; font-size: 1.05rem; letter-spacing: .18em;
  transform-origin: 100% 50%;
  display: none; white-space: nowrap;
}
.cz-reload-tag[data-on="1"] { display: block; }

/* ── ACTIVE RELOAD (GAME_BIBLE §3) ───────────────────────────────────────────
   The pistol's whole skill expression, so it gets the loudest furniture on the HUD that is
   not the crosshair. Sits below centre: close enough to read without leaving the target,
   far enough that it never covers what you are shooting. Only exists during a reload. */
.cz-ar {
  position: absolute; left: 50%; top: 50%;
  margin-top: 86px; transform: translateX(-50%) rotate(-1.6deg);
  background: ${paper}; border: 5px solid ${ink}; box-shadow: 7px 7px 0 ${shadow};
  padding: .2rem .5rem .34rem; display: none;
}
.cz-ar[data-on="1"] { display: block; }
.cz-ar > * { position: relative; z-index: 1; }
.cz-ar-label {
  display: block; text-align: center; font-size: .8rem; letter-spacing: .24em;
  color: ${ink}; opacity: .8; padding-bottom: .2rem; white-space: nowrap;
}
.cz-ar-track {
  position: relative; width: 268px; height: 17px;
  border: 3px solid ${ink}; background: ${inkSoft}; overflow: hidden;
}
/* The sweet spot. GOLD = reward, per the semantic palette. */
.cz-ar-zone {
  position: absolute; top: 0; bottom: 0; background: ${gold};
  border-left: 3px solid ${ink}; border-right: 3px solid ${ink};
}
/* Everything the sweep has already eaten. */
.cz-ar-fill {
  position: absolute; inset: 0; transform-origin: 0 50%; transform: scaleX(0);
  background: ${css('INK', 0.55)};
}
/* The needle — the thing the eye actually tracks. */
.cz-ar-needle {
  position: absolute; top: -2px; bottom: -2px; width: 5px; margin-left: -2px;
  background: ${ink};
}
.cz-ar[data-state="open"] { border-color: ${gold}; }
.cz-ar[data-state="open"] .cz-ar-label { color: ${ink}; opacity: 1; }
.cz-ar[data-state="good"] { background: ${acid}; border-color: ${ink}; }
.cz-ar[data-state="good"] .cz-ar-label { color: ${ink}; opacity: 1; }
.cz-ar[data-state="miss"] { background: ${hot}; }
.cz-ar[data-state="miss"] .cz-ar-label { color: ${paper}; opacity: 1; }

/* ── damage direction ────────────────────────────────────────────────────────
   Comic chevrons, ink-outlined, pointing at whatever just hit you. Pooled: six slots, oldest
   recycled. Opacity is driven by WAAPI and lands back on 0, so nothing lingers on screen. */
.cz-dmg {
  position: absolute; left: 50%; top: 50%; width: 460px; height: 460px;
  margin: -230px 0 0 -230px; overflow: visible;
}
.cz-dmg g.pulse { opacity: 0; transform-origin: 50% 50%; }
.cz-dmg .ink { stroke: ${ink}; stroke-width: 15; fill: none; stroke-linejoin: miter; }
.cz-dmg .hot { stroke: ${hot}; stroke-width: 7.5; fill: none; stroke-linejoin: miter; }

/* ── THE COMBO BADGE — the aggression dial ───────────────────────────────────
   GOLD, not HOT: the chain is a REWARD, and HOT belongs to enemies and damage (ART §9).
   It escalates on three channels at once — the number grows with the tier, the card gains a
   static speed-line halo at ×4, and the drain bar underneath shows the window closing. The bar
   is the only thing here that moves per frame, and it only exists while a chain is alive. */
.cz-combo {
  top: 50%; right: 46px; transform: translateY(-50%) rotate(-5deg);
  background: ${gold}; border-color: ${ink}; opacity: 0;
  flex-direction: column; align-items: flex-end; gap: .18rem;
  padding: .3rem .9rem .42rem;
  transition: opacity .1s steps(2, end);
}
.cz-combo[data-on="1"] { opacity: 1; }
.cz-combo .cz-value {
  color: ${ink}; line-height: .86;
  text-shadow: 3px 3px 0 ${css('PAPER', 0.55)};
}
.cz-combo .cz-label { color: ${ink}; opacity: .82; padding: 0; }
.cz-comborow { display: flex; align-items: flex-end; gap: .45rem; }
.cz-combobar {
  position: relative; width: 100%; height: 9px; min-width: 96px;
  border: 3px solid ${ink}; background: ${inkSoft}; overflow: hidden;
}
.cz-combofill {
  position: absolute; inset: 0; transform-origin: 100% 50%;
  background: ${ink};
}
/* ×4 and ×5 print a halo. Static — a conic gradient that never turns. */
.cz-combolines {
  position: absolute; left: 50%; top: 50%; width: 240px; height: 240px;
  margin: -120px 0 0 -120px; z-index: 0; display: none; pointer-events: none;
  background: repeating-conic-gradient(from 0deg at 50% 50%,
    ${css('GOLD', 0.55)} 0deg .6deg, transparent .6deg 4.6deg);
  -webkit-mask-image: radial-gradient(circle at 50% 50%, transparent 26%, #000 44%, transparent 72%);
  mask-image: radial-gradient(circle at 50% 50%, transparent 26%, #000 44%, transparent 72%);
}
.cz-combo[data-tier="hot"] .cz-combolines { display: block; }
.cz-combo[data-tier="hot"] { background: ${rust}; }
.cz-combo[data-tier="hot"] .cz-value { color: ${paper}; text-shadow: 3px 3px 0 ${ink}; }
.cz-combo[data-tier="hot"] .cz-label { color: ${paper}; }
.cz-combo[data-tier="hot"] .cz-combofill { background: ${paper}; }

/* ── ENEMIES LEFT ────────────────────────────────────────────────────────────
   Under the round badge, inverted (INK card, PAPER type) so it reads as the round's counter
   rather than as another stat. Hidden outside an active round — an empty street says "0 LEFT"
   by not being there. */
.cz-remain {
  top: 116px; left: 28px;
  background: ${ink}; border-color: ${paper}; box-shadow: 6px 6px 0 ${css('INK', 0.75)};
  padding: .16rem .7rem .24rem;
}
.cz-remain .cz-value { color: ${paper}; font-size: 1.7rem; }
.cz-remain .cz-label { color: ${paper}; opacity: .66; font-size: .62rem; padding-bottom: .2rem; }
.cz-remain[data-on="0"] { display: none; }

/* The SURGE flag rides on the round badge itself, so the two can never disagree. */
.cz-surgetag {
  position: absolute; top: -16px; right: -26px; z-index: 3; display: none;
  background: ${gold}; color: ${ink}; border: 4px solid ${ink};
  box-shadow: 4px 4px 0 ${css('INK', 0.8)};
  padding: .06rem .45rem .12rem; font-size: .74rem; letter-spacing: .16em;
  transform: rotate(7deg);
}
.cz-round[data-surge="1"] .cz-surgetag { display: block; }

/* ── FLOATING POINTS ─────────────────────────────────────────────────────────
   Pooled. Awards inside POINTS.mergeWindow merge into the live floater instead of stacking
   six "+10"s on top of each other, which is what a body shot into a horde would otherwise do. */
.cz-floats { position: absolute; top: 96px; right: 30px; width: 0; height: 0; }
.cz-float {
  position: absolute; right: 0; top: 0; white-space: nowrap;
  font-size: 1.6rem; color: ${gold}; opacity: 0;
  text-shadow: 3px 3px 0 ${ink}, -1px -1px 0 ${ink}, 1px -1px 0 ${ink}, -1px 1px 0 ${ink};
}

/* ── POWER-UP TIMERS ─────────────────────────────────────────────────────────
   GOLD, because a power-up is the definition of an interactable reward. The bar under each tag
   drains, which is the only readout in the game that tells you when to stop pushing. */
.cz-buffs {
  position: absolute; left: 28px; bottom: 138px;
  display: flex; flex-direction: column-reverse; align-items: flex-start; gap: 8px;
}
.cz-buff {
  position: relative; background: ${gold}; color: ${ink};
  border: 4px solid ${ink}; box-shadow: 6px 6px 0 ${shadow};
  padding: .16rem .7rem .34rem; font-size: .95rem; letter-spacing: .14em;
  white-space: nowrap; overflow: hidden;
}
.cz-buff span { position: relative; z-index: 2; }
.cz-buff i {
  position: absolute; left: 0; right: 0; bottom: 0; height: 5px; display: block;
  background: ${ink}; transform-origin: 0 50%;
}

/* ── THE DECK ────────────────────────────────────────────────────────────────
   Every boon you own, as a chip strip along the bottom edge. Rebuilt on boon:chosen and
   completely static in between. .cz-chip is shared with the run summary in ui/cards.ts. */
.cz-chip {
  position: relative; width: 38px; height: 38px;
  border: 4px solid ${ink}; box-shadow: 4px 4px 0 ${css('INK', 0.8)};
  display: grid; place-items: center; background: ${paper};
}
.cz-chip .cz-glyph { width: 24px; height: 24px; }
.cz-chip i {
  position: absolute; right: -7px; bottom: -8px; z-index: 3;
  background: ${ink}; color: ${paper}; border: 2px solid ${paper};
  font-style: normal; font-size: .62rem; letter-spacing: .04em;
  padding: 0 3px 1px; line-height: 1.15;
}
.cz-deck {
  position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
  display: flex; align-items: flex-end; gap: 9px;
}
.cz-deck:empty { display: none; }

/* ── DOWN ────────────────────────────────────────────────────────────────────
   The one moment the HUD is allowed to shout. HOT is correct here: this is damage. */
.cz-down {
  position: absolute; inset: 0; display: grid; place-items: center;
  visibility: hidden; opacity: 0; transition: opacity .14s steps(2, end);
  /* Above every other piece of HUD furniture, including the title card, which is appended last
     and would otherwise paint over the crawl timer. Going down outranks everything. */
  z-index: 4;
}
.cz-down[data-on="1"] { visibility: visible; opacity: 1; }
.cz-down-scrim {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at 50% 50%,
    ${css('HOT', 0.1)} 0%, ${css('INK', 0.5)} 46%, ${css('INK', 0.88)} 100%);
}
.cz-down-panel > * { position: relative; z-index: 1; }
.cz-down-panel {
  position: relative; text-align: center;
  background: ${hot}; border: 8px solid ${ink}; box-shadow: 16px 16px 0 ${ink};
  padding: .3rem 2.6rem 1rem;
}
.cz-down-lab {
  display: inline-block; background: ${ink}; color: ${paper};
  letter-spacing: .3em; font-size: clamp(.85rem, 1.8vw, 1.3rem);
  padding: .22rem 1.2rem .3rem;
}
.cz-down-num {
  font-size: clamp(4rem, 15vw, 11rem); line-height: .92; color: ${paper};
  text-shadow: 7px 7px 0 ${ink};
}
.cz-down-bar {
  position: relative; height: 16px; border: 4px solid ${ink};
  background: ${css('INK', 0.55)}; overflow: hidden;
}
.cz-down-fill {
  position: absolute; inset: 0; transform-origin: 0 50%; background: ${paper};
}
.cz-down-sub {
  display: block; padding-top: .5rem; letter-spacing: .2em;
  color: ${ink}; font-size: clamp(.7rem, 1.3vw, .95rem);
}

/* ── health bar: hard segments, no gradient ──────────────────────────────── */
.cz-hprow { display: flex; align-items: baseline; gap: .5rem; }
.cz-hpbar {
  position: relative; width: 208px; height: 15px;
  border: 3px solid ${ink}; background: ${inkSoft}; overflow: hidden;
}
.cz-hpfill {
  position: absolute; inset: 0; transform-origin: 0 50%;
  background: ${hot};
  transition: transform .14s cubic-bezier(.2,.9,.25,1);
}
.cz-hpbar::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background-image: repeating-linear-gradient(90deg, transparent 0 19px, ${ink} 19px 22px);
}

/* ── crosshair ───────────────────────────────────────────────────────────── */
.cz-cross {
  position: absolute; left: 50%; top: 50%; width: 200px; height: 200px;
  margin: -100px 0 0 -100px; overflow: visible;
}
.cz-cross .paper { stroke: ${paper}; stroke-width: ${CH.paperWidth}; stroke-linecap: butt; }
.cz-cross .ink   { stroke: ${ink};   stroke-width: ${CH.inkWidth};   stroke-linecap: butt; }
.cz-cross .dotp  { fill: ${paper}; }
.cz-cross .doti  { fill: ${ink}; }

/* ── hit marker ──────────────────────────────────────────────────────────── */
.cz-hit {
  position: absolute; left: 50%; top: 50%; width: 140px; height: 140px;
  margin: -70px 0 0 -70px; opacity: 0; overflow: visible;
}
.cz-hit .paper { stroke: ${paper}; stroke-width: 8.5; stroke-linecap: butt; }
.cz-hit .ink   { stroke: ${ink};   stroke-width: 4.5; stroke-linecap: butt; }
.cz-hit[data-crit="1"] .ink { stroke: ${hot}; }
.cz-hit[data-kill="1"] .ink { stroke: ${gold}; }
/* A kill gets a SHAPE change, not just a colour change — the difference has to survive
   peripheral vision. Four ticks say "hit"; ticks plus a struck-through diamond say "dead". */
.cz-hit .killmark { display: none; }
.cz-hit[data-kill="1"] .killmark { display: inline; }

/* ── HIT DAMAGE NUMBERS ──────────────────────────────────────────────────────
   Pooled, eight slots, anchored beside the crosshair. Outer span = anchor + tilt, set once and
   never touched again; inner <i> = the only thing WAAPI animates.

   THE CRIT READ IS THREE CHANNELS, not a colour: HOT instead of PAPER, ~40% bigger type, and a
   harder slam with more travel. Any one of those alone dies in peripheral vision or on a HOT
   screen — together a crit is unmistakable at a glance. A KILL takes it further into GOLD, which
   is the same promotion the hit marker's diamond makes, so the two can never disagree.

   The ink stroke is drawn with four offset text-shadows rather than -webkit-text-stroke: a stroke
   thins at the joins of Impact's heavy verticals, and a damage number that goes grey over a lit
   street is a number you cannot read. */
.cz-hitnums { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.cz-hitnum {
  position: absolute; white-space: nowrap; line-height: 1;
  font-size: 1.45rem; letter-spacing: .02em; color: ${paper};
}
.cz-hitnum > i {
  display: inline-block; font-style: normal; opacity: 0; transform-origin: 50% 65%;
  text-shadow:
    3px 3px 0 ${ink}, -2px -2px 0 ${ink}, 2px -2px 0 ${ink}, -2px 2px 0 ${ink},
    0 3px 0 ${ink}, 3px 0 0 ${ink}, 0 -3px 0 ${ink}, -3px 0 0 ${ink};
}
.cz-hitnum[data-kind="crit"] { color: ${hot}; font-size: 2.05rem; }
.cz-hitnum[data-kind="kill"] { color: ${gold}; font-size: 2.05rem; }

/* ── interact prompt ─────────────────────────────────────────────────────── */
.cz-prompt {
  position: absolute; left: 50%; top: 60%;
  transform: translateX(-50%) rotate(-1.2deg) scale(.9);
  background: ${paper}; border: 5px solid ${ink}; box-shadow: 7px 7px 0 ${shadow};
  padding: .3rem 1.1rem .4rem; font-size: 1.25rem; letter-spacing: .1em;
  opacity: 0; white-space: nowrap;
  transition: opacity .12s steps(2,end), transform .16s cubic-bezier(.2,1.5,.3,1);
}
.cz-prompt > * { position: relative; z-index: 1; }
.cz-prompt[data-on="1"] { opacity: 1; transform: translateX(-50%) rotate(-1.2deg) scale(1); }
.cz-prompt b { color: ${electric}; -webkit-text-stroke: 1px ${ink}; }

/* ── toasts ──────────────────────────────────────────────────────────────── */
.cz-toasts {
  position: absolute; left: 50%; bottom: 20%; transform: translateX(-50%);
  display: flex; flex-direction: column-reverse; align-items: center; gap: 9px;
}
.cz-toast {
  background: ${ink}; color: ${paper}; border: 3px solid ${paper};
  box-shadow: 5px 5px 0 ${css('INK', 0.7)};
  padding: .26rem 1.05rem .34rem; font-size: 1.05rem; letter-spacing: .13em;
  white-space: nowrap;
}

/* ── title card ──────────────────────────────────────────────────────────── */
.cz-title {
  position: absolute; inset: 0; display: grid; place-items: center;
  opacity: 0; visibility: hidden;
  transition: opacity .2s steps(3, end);
}
/* A scrim under the burst. Without it the card competes with a lit arena; with it the page
   turns and everything that is not the card recedes. This is the panel gutter. */
.cz-title-scrim {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at 50% 50%,
    ${css('INK', 0.38)} 0%, ${css('INK', 0.62)} 45%, ${css('INK', 0.86)} 100%);
}
/* Speed lines are PAPER, not INK: this is a night scene, and black rays on a black street are
   an invisible flourish. Comics ink the burst in whatever contrasts with the panel. */
.cz-title-lines {
  position: absolute; left: 50%; top: 50%; width: 240vmax; height: 240vmax;
  margin: -120vmax 0 0 -120vmax;
  background: repeating-conic-gradient(from 0deg at 50% 50%,
    ${paper} 0deg 0.5deg, transparent 0.5deg 1.15deg,
    ${paper} 1.15deg 1.5deg, transparent 1.5deg 3.9deg);
  -webkit-mask-image: radial-gradient(circle at 50% 50%, transparent 9%, #000 40%, #000 100%);
  mask-image: radial-gradient(circle at 50% 50%, transparent 9%, #000 40%, #000 100%);
  opacity: .5;
}
.cz-title-panel {
  position: relative; text-align: center;
  background: ${paper}; border: 7px solid ${ink};
  box-shadow: 14px 14px 0 ${ink};
  padding: .35rem 2.8rem 1.05rem;
  transform: rotate(-2deg);
}
.cz-title-panel > * { position: relative; z-index: 1; }
.cz-title-text {
  font-size: clamp(2.8rem, 9.5vw, 7.5rem); line-height: .92; color: ${ink};
  letter-spacing: .012em;
  text-shadow: 5px 5px 0 ${hot}, 10px 10px 0 ${css('INK', 0.28)};
}
.cz-title-sub {
  display: inline-block; margin-top: .45rem;
  background: ${ink}; color: ${paper};
  font-size: clamp(.85rem, 1.8vw, 1.35rem); letter-spacing: .26em;
  padding: .22rem 1.1rem .3rem; transform: rotate(1.6deg);
}
.cz-title-sub:empty { display: none; }
.cz-title-accent {
  position: absolute; z-index: 0; inset: -18px -26px auto auto;
  width: 0; height: 0;
}
`;
}

// ─────────────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

/** Restart a WAAPI punch on an element. Cheap: the compositor owns the transform. */
function punch(el: Element, strength = 1): void {
  el.getAnimations().forEach((a) => a.cancel());
  const up = 1 + 0.32 * strength;
  const down = 1 - 0.06 * strength;
  el.animate(
    [
      { transform: 'scale(1)' },
      { transform: `scale(${up.toFixed(3)})`, offset: 0.22 },
      { transform: `scale(${down.toFixed(3)})`, offset: 0.55 },
      { transform: 'scale(1)' },
    ],
    { duration: 280, easing: 'cubic-bezier(.2,.9,.25,1)' },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The system
// ─────────────────────────────────────────────────────────────────────────────

export class HudSystem implements System, HudService {
  readonly name = 'hud';

  readonly root: HTMLDivElement;

  private readonly styleEl: HTMLStyleElement;
  private readonly container: HTMLElement;

  // crosshair
  private readonly crossTicks: SVGGElement[] = [];
  private spreadTarget = 0;
  private spreadGap = CH.minGap;
  private fovDeg = 78;
  /**
   * The HUD is the only DOM in the frame loop, so it has to hold to the ~0 heap growth budget
   * (ARCHITECTURE §6) like everything else. Two things used to break it every frame: four
   * template strings + a `toFixed` pushed through `setAttribute` (which re-parses the SVG
   * transform), and a `clientHeight` read that forced a synchronous layout. The crosshair now
   * only writes when it has actually moved a visible amount, and the viewport height is cached.
   */
  private lastAppliedGap = Number.NaN;
  private viewportH = 0;
  /**
   * The HUD's own 0..1 aim blend, chased toward `player.isAiming`.
   *
   * DERIVED, NOT PUBLISHED. `HudService` is frozen and carries no ADS channel, and the weapon's
   * `adsBlend` is private to its system — so rather than invent a probe, the HUD runs the same
   * shape of chase off the two things the CONTRACT does give it: the boolean `player.isAiming`
   * and the current weapon's own `def.adsTime`. Driving it from the weapon's own timing constant
   * is what keeps the fade in step with the pose instead of guessing at a duration.
   */
  private adsBlend = 0;
  private lastAppliedCrossOpacity = Number.NaN;
  private readonly crossEl: SVGSVGElement;

  // widgets
  private readonly hitMark: SVGSVGElement;
  /** The live hit-marker animation, held so it can be cancelled without `getAnimations()`. */
  private hitMarkAnim: Animation | null = null;
  private readonly dmgSvg: SVGSVGElement;
  private readonly dmgSlots: SVGGElement[] = [];
  private dmgNext = 0;
  private readonly arEl: HTMLDivElement;
  private readonly arLabel: HTMLDivElement;
  private readonly arZone: HTMLDivElement;
  private readonly arFill: HTMLDivElement;
  private readonly arNeedle: HTMLDivElement;
  private readonly ammoEl: HTMLDivElement;
  private readonly weaponLabel: HTMLSpanElement;
  private readonly reloadTag: HTMLDivElement;
  private readonly promptEl: HTMLDivElement;
  private readonly toastStack: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly titleScrim: HTMLDivElement;
  private readonly titleLines: HTMLDivElement;
  private readonly titlePanel: HTMLDivElement;
  private readonly titleText: HTMLDivElement;
  private readonly titleSub: HTMLDivElement;

  private readonly vRound: HTMLSpanElement;
  private readonly vPoints: HTMLSpanElement;
  private readonly vHealth: HTMLSpanElement;
  private readonly vAmmo: HTMLSpanElement;
  private readonly vReserve: HTMLSpanElement;
  private readonly vCombo: HTMLSpanElement;
  private readonly comboEl: HTMLDivElement;
  private readonly comboFill: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly roundEl: HTMLDivElement;

  // M3 furniture
  private readonly remainEl: HTMLDivElement;
  private readonly vRemain: HTMLSpanElement;
  private readonly floatLayer: HTMLDivElement;
  private readonly floats: HTMLSpanElement[] = [];
  /** Hit damage numbers: outer = anchored shell, inner = the animated glyph run. */
  private readonly hitNumLayer: HTMLDivElement;
  private readonly hitNumShells: HTMLSpanElement[] = [];
  private readonly hitNumGlyphs: HTMLElement[] = [];
  private readonly hitNumAnims: (Animation | null)[] = [];
  private readonly buffLayer: HTMLDivElement;
  private readonly deckEl: HTMLDivElement;
  private readonly downEl: HTMLDivElement;
  private readonly downNum: HTMLDivElement;
  private readonly downFill: HTMLDivElement;

  /**
   * The compass strip and the minimap. Public so whatever owns an objective next — wall-buys,
   * the mystery box, a downed team-mate — can call `hud.nav.beacon(id, x, z)` without this file
   * growing a pass-through method per feature.
   */
  readonly nav: NavPanels;

  // state
  private health = 100;
  private maxHealth = 100;
  private points = -1;
  private round = -1;
  private ammo = -1;
  private reserve = -1;
  private combo = 0;
  private comboMult = 1;
  private hitTimer = 0;
  private titleTimer = 0;
  private visible: boolean;
  private readonly offs: (() => void)[] = [];

  /** The director's non-contract readouts. Null until `attachRounds()`; everything degrades. */
  private rounds: RoundExtras | null = null;
  /** A card layer owns the screen — suppress title cards so two panels never fight. */
  private modal = false;

  // hit damage numbers. `hitNumAge` is seconds since the live number was last written; it starts
  // above `mergeWindow` so the first hit of a session can never merge into slot 0.
  private hitNumNext = 0;
  private hitNumAge = 99;
  private hitNumOwner = -1;
  private hitNumValue = 0;
  private hitNumSlot = -1;
  private hitNumCrit = false;

  // rolling points
  private pointsTarget = 0;
  private pointsShown = 0;
  private rolling = false;
  private floatNext = 0;
  private floatAge = 99;
  private floatValue = 0;

  // enemies left
  private remainShown = -1;

  // combo drain
  private lastComboFill = -1;

  // power-up buffs. At most three can ever be live, so this is a fixed pool.
  private readonly buffs: { id: string; el: HTMLDivElement; bar: HTMLElement; text: HTMLElement; left: number; total: number; shown: number }[] = [];

  // down state
  private downLeft = 0;
  private downTotal = 0;
  private downShown = -1;

  // active reload
  private arState: 'off' | 'run' | 'open' | 'good' | 'miss' = 'off';
  private arT = 0;
  private arDuration = 0;
  private arResult = 0;
  private arWindowSeen = false;
  private arRunning = false;
  private arTapped = false;
  private arStartFrame = -1;
  private arClosedFrame = -1;
  private lastNeedlePx = Number.NaN;

  // ammo
  private magMax = 0;

  constructor(opts: HudOptions = {}) {
    this.container =
      opts.container ??
      (document.getElementById('ui') as HTMLElement | null) ??
      document.body;

    this.styleEl = document.createElement('style');
    this.styleEl.id = 'cz-hud-style';
    this.styleEl.textContent = styleSheet();
    document.head.appendChild(this.styleEl);

    this.root = div('cz-hud');
    this.visible = opts.visible ?? false;
    this.root.dataset.hidden = this.visible ? '0' : '1';

    // ── crosshair ────────────────────────────────────────────────────────────
    const cross = svg('svg');
    cross.setAttribute('class', 'cz-cross');
    cross.setAttribute('viewBox', '-100 -100 200 200');
    for (let i = 0; i < 4; i++) {
      const g = svg('g');
      g.setAttribute('transform', `rotate(${i * 90}) translate(0,${-CH.minGap})`);
      for (const cls of ['paper', 'ink']) {
        const l = svg('line');
        l.setAttribute('class', cls);
        l.setAttribute('x1', '0');
        l.setAttribute('y1', '0');
        l.setAttribute('x2', '0');
        l.setAttribute('y2', String(-CH.tickLength));
        g.appendChild(l);
      }
      cross.appendChild(g);
      this.crossTicks.push(g);
    }
    const dotP = svg('circle');
    dotP.setAttribute('class', 'dotp');
    dotP.setAttribute('r', '3.1');
    const dotI = svg('circle');
    dotI.setAttribute('class', 'doti');
    dotI.setAttribute('r', '1.5');
    cross.appendChild(dotP);
    cross.appendChild(dotI);
    this.root.appendChild(cross);
    this.crossEl = cross;

    // ── hit marker ───────────────────────────────────────────────────────────
    this.hitMark = svg('svg');
    this.hitMark.setAttribute('class', 'cz-hit');
    this.hitMark.setAttribute('viewBox', '-70 -70 140 140');
    for (let i = 0; i < 4; i++) {
      const g = svg('g');
      g.setAttribute('transform', `rotate(${45 + i * 90})`);
      for (const cls of ['paper', 'ink']) {
        const l = svg('line');
        l.setAttribute('class', cls);
        l.setAttribute('x1', '0');
        l.setAttribute('y1', '-11');
        l.setAttribute('x2', '0');
        l.setAttribute('y2', '-25');
        g.appendChild(l);
      }
      this.hitMark.appendChild(g);
    }
    // The kill diamond: only drawn when the hit was the last one.
    for (const cls of ['paper', 'ink']) {
      const poly = svg('polygon');
      poly.setAttribute('class', `killmark ${cls}`);
      poly.setAttribute('points', '0,-34 34,0 0,34 -34,0');
      poly.setAttribute('fill', 'none');
      this.hitMark.appendChild(poly);
    }
    this.root.appendChild(this.hitMark);

    // ── damage direction ─────────────────────────────────────────────────────
    // Six pooled chevrons on one SVG. Each slot is a <g> that gets rotated to the incoming
    // angle and animated in and out; nothing is created or destroyed at damage time.
    this.dmgSvg = svg('svg');
    this.dmgSvg.setAttribute('class', 'cz-dmg');
    this.dmgSvg.setAttribute('viewBox', '-230 -230 460 460');
    const chev =
      `M ${-DMG.halfWidth} ${-DMG.radius} ` +
      `L 0 ${-DMG.radius - DMG.depth} ` +
      `L ${DMG.halfWidth} ${-DMG.radius}`;
    for (let i = 0; i < DMG.slots; i++) {
      // Two nested groups on purpose: the OUTER one carries the rotation as an SVG attribute,
      // the INNER one is animated. A WAAPI `transform` keyframe is a CSS transform, and a CSS
      // transform overrides the presentation attribute outright — animate the same element and
      // every chevron snaps back to pointing straight up.
      const g = svg('g');
      const pulse = svg('g');
      pulse.setAttribute('class', 'pulse');
      for (const cls of ['ink', 'hot']) {
        const path = svg('path');
        path.setAttribute('class', cls);
        path.setAttribute('d', chev);
        pulse.appendChild(path);
      }
      g.appendChild(pulse);
      this.dmgSvg.appendChild(g);
      this.dmgSlots.push(g);
    }
    this.root.appendChild(this.dmgSvg);

    // ── badges ───────────────────────────────────────────────────────────────
    const mk = (
      cls: string, label: string, valueCls = 'cz-value',
    ): { el: HTMLDivElement; value: HTMLSpanElement } => {
      const el = div(`cz-badge cz-tone ${cls}`);
      const lab = document.createElement('span');
      lab.className = 'cz-label';
      lab.textContent = label;
      const val = document.createElement('span');
      val.className = valueCls;
      val.textContent = '0';
      el.append(lab, val);
      this.root.appendChild(el);
      return { el, value: val };
    };

    const round = mk('cz-round', 'ROUND');
    this.vRound = round.value;
    this.roundEl = round.el;
    const surgeTag = div('cz-surgetag');
    surgeTag.textContent = 'SURGE';
    this.roundEl.appendChild(surgeTag);

    const points = mk('cz-points', 'POINTS');
    this.vPoints = points.value;

    const remain = mk('cz-remain', 'LEFT', 'cz-value sm');
    this.remainEl = remain.el;
    this.vRemain = remain.value;
    this.remainEl.dataset.on = '0';

    // Floating "+100"s. Pooled and anchored under the points badge, so the eye that just looked
    // at the number sees where the number came from.
    this.floatLayer = div('cz-floats');
    for (let i = 0; i < POINTS.floaters; i++) {
      const f = document.createElement('span');
      f.className = 'cz-float';
      this.floatLayer.appendChild(f);
      this.floats.push(f);
    }
    this.root.appendChild(this.floatLayer);

    // Hit damage numbers. Anchors and tilts are baked into the shells here and never rewritten,
    // so landing a hit only ever touches `textContent`, one dataset key and one animation.
    this.hitNumLayer = div('cz-hitnums');
    for (let i = 0; i < HITNUM.slots; i++) {
      const shell = document.createElement('span');
      shell.className = 'cz-hitnum';
      const a = HITNUM.anchors[i % HITNUM.anchors.length]!;
      shell.style.left = `${a[0]}px`;
      shell.style.top = `${a[1]}px`;
      shell.style.transform = `rotate(${a[2]}deg)`;
      const glyphs = document.createElement('i');
      shell.appendChild(glyphs);
      this.hitNumLayer.appendChild(shell);
      this.hitNumShells.push(shell);
      this.hitNumGlyphs.push(glyphs);
      this.hitNumAnims.push(null);
    }
    this.root.appendChild(this.hitNumLayer);

    this.buffLayer = div('cz-buffs');
    this.root.appendChild(this.buffLayer);

    this.deckEl = div('cz-deck');
    this.root.appendChild(this.deckEl);

    // Health is a badge with a bar under the number, so it reads at a glance.
    const health = div('cz-badge cz-tone cz-health');
    const hprow = div('cz-hprow');
    const hlab = document.createElement('span');
    hlab.className = 'cz-label';
    hlab.textContent = 'VITALS';
    this.vHealth = document.createElement('span');
    this.vHealth.className = 'cz-value';
    this.vHealth.textContent = '100';
    hprow.append(this.vHealth, hlab);
    const bar = div('cz-hpbar');
    this.hpFill = div('cz-hpfill');
    bar.appendChild(this.hpFill);
    health.append(hprow, bar);
    this.root.appendChild(health);

    const ammo = div('cz-badge cz-tone cz-ammo');
    this.ammoEl = ammo;
    this.weaponLabel = document.createElement('span');
    this.weaponLabel.className = 'cz-label';
    this.weaponLabel.textContent = 'AMMO';
    this.vAmmo = document.createElement('span');
    this.vAmmo.className = 'cz-value';
    this.vAmmo.textContent = '—';
    this.vReserve = document.createElement('span');
    this.vReserve.className = 'cz-reserve';
    this.vReserve.textContent = '';
    ammo.append(this.weaponLabel, this.vAmmo, this.vReserve);
    this.root.appendChild(ammo);

    this.reloadTag = div('cz-reload-tag');
    this.reloadTag.textContent = 'RELOAD — R';
    this.root.appendChild(this.reloadTag);

    // ── active reload bar ────────────────────────────────────────────────────
    this.arEl = div('cz-ar cz-tone');
    this.arLabel = div('cz-ar-label');
    this.arLabel.textContent = 'RELOADING';
    const arTrack = div('cz-ar-track');
    this.arZone = div('cz-ar-zone');
    this.arFill = div('cz-ar-fill');
    this.arNeedle = div('cz-ar-needle');
    arTrack.append(this.arFill, this.arZone, this.arNeedle);
    this.arEl.append(this.arLabel, arTrack);
    this.root.appendChild(this.arEl);

    // ── the combo badge ──────────────────────────────────────────────────────
    // Three children: the halo (static, only shown at ×4+), the number row, and the drain bar.
    this.comboEl = div('cz-badge cz-tone cz-combo');
    this.comboEl.dataset.on = '0';
    this.comboEl.appendChild(div('cz-combolines'));
    const crow = div('cz-comborow');
    const clab = document.createElement('span');
    clab.className = 'cz-label';
    clab.textContent = 'COMBO';
    this.vCombo = document.createElement('span');
    this.vCombo.className = 'cz-value';
    this.vCombo.textContent = 'x1';
    crow.append(clab, this.vCombo);
    const cbar = div('cz-combobar');
    this.comboFill = div('cz-combofill');
    cbar.appendChild(this.comboFill);
    this.comboEl.append(crow, cbar);
    this.root.appendChild(this.comboEl);

    // ── the down panel ───────────────────────────────────────────────────────
    this.downEl = div('cz-down');
    this.downEl.dataset.on = '0';
    const downPanel = div('cz-down-panel cz-tone');
    const downLab = div('cz-down-lab');
    downLab.textContent = 'YOU WENT DOWN';
    this.downNum = div('cz-down-num');
    this.downNum.textContent = '8';
    const downBar = div('cz-down-bar');
    this.downFill = div('cz-down-fill');
    downBar.appendChild(this.downFill);
    const downSub = document.createElement('span');
    downSub.className = 'cz-down-sub';
    downSub.textContent = 'CRAWL — SECONDS UNTIL THE INK TAKES YOU';
    downPanel.append(downLab, this.downNum, downBar, downSub);
    this.downEl.append(div('cz-down-scrim'), downPanel);
    this.root.appendChild(this.downEl);

    // ── compass + minimap ────────────────────────────────────────────────────
    //
    // Canvas, not DOM, and it owns its own <style> — see `ui/minimap.ts` for why. Mounted HERE,
    // before the prompt/toast/title layer, so a title card or the boon draw always paints over
    // the navigation furniture rather than under it.
    this.nav = new NavPanels(this.root);

    // ── prompt / toasts / title ──────────────────────────────────────────────
    this.promptEl = div('cz-prompt cz-tone');
    const promptSpan = document.createElement('span');
    this.promptEl.appendChild(promptSpan);
    this.root.appendChild(this.promptEl);

    this.toastStack = div('cz-toasts');
    this.root.appendChild(this.toastStack);

    this.titleEl = div('cz-title');
    this.titleScrim = div('cz-title-scrim');
    this.titleLines = div('cz-title-lines');
    this.titlePanel = div('cz-title-panel cz-tone');
    this.titleText = div('cz-title-text');
    this.titleSub = div('cz-title-sub');
    this.titlePanel.append(this.titleText, this.titleSub);
    this.titleEl.append(this.titleScrim, this.titleLines, this.titlePanel);
    this.root.appendChild(this.titleEl);

    this.container.appendChild(this.root);
    this.applyHealth();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // System
  // ═══════════════════════════════════════════════════════════════════════════

  init(ctx: GameCtx): void {
    const on = ctx.events.on.bind(ctx.events);

    this.measure();
    window.addEventListener('resize', this.onResize);

    // Owns its own event subscriptions and its own teardown; the HUD only mounts and ticks it.
    this.nav.init(ctx);

    this.setRound(ctx.rounds.round);
    this.setPoints(ctx.player.points);
    this.setHealth(ctx.player.health, ctx.player.stats.maxHealth);

    // PRIME FROM THE SERVICE, NOT FROM THE EVENT. The weapon system is registered ahead of the
    // HUD, so it equips the starter and emits `weapon:equipped` inside its own `init()` — before
    // the subscription below exists. It re-announces the AMMO on its first frame but not the
    // weapon, so without this the badge reads a generic "AMMO" for the whole session.
    const held = ctx.weapons.current;
    if (held) {
      this.weaponLabel.textContent = held.def.name.toUpperCase();
      this.magMax = held.ammo;
      this.setAmmo(held.ammo, held.def.infiniteReserve ? -1 : held.reserve);
    }

    this.offs.push(
      on('player:damaged', (p) => {
        this.setHealth(p.health, ctx.player.stats.maxHealth);
        this.damageFrom(p.fromDirection, ctx);
      }),
      on('player:healed', (p) => this.setHealth(p.health, ctx.player.stats.maxHealth)),
      on('player:statsChanged', () => this.setHealth(ctx.player.health, ctx.player.stats.maxHealth)),
      on('player:points', (p) => { this.setPoints(p.total); this.floatPoints(p.delta); }),
      on('round:start', (p) => this.onRoundStart(p.round, p.toSpawn)),
      on('round:cleared', (p) => {
        this.setRemaining(0);
        this.titleCard(
          p.perfect ? 'UNTOUCHED' : 'ROUND CLEAR',
          p.perfect ? `ROUND ${p.round} · NOT A SCRATCH` : `ROUND ${p.round} DOWN`,
          1.5,
        );
      }),
      on('round:intermission', () => this.toast('THE PAGE TURNS')),
      on('combo:changed', (p) => this.setCombo(p.combo, p.multiplier)),
      on('powerup:collected', (p) => this.addBuff(p.id)),
      on('boon:chosen', (p) => this.onBoonChosen(p.def, ctx)),
      on('player:down', (p) => this.enterDown(p.reviveTime)),
      on('player:revived', () => this.exitDown()),
      on('player:died', () => this.exitDown()),
      on('player:spawned', () => this.onRespawn(ctx)),
      on('weapon:ammoChanged', (p) => this.setAmmo(p.ammo, p.reserve)),
      on('weapon:equipped', (p) => {
        this.weaponLabel.textContent = p.weapon.def.name.toUpperCase();
        // A new gun resets what "a full magazine" means for the low-ammo colour.
        this.magMax = p.weapon.ammo;
        this.endActiveReload('off');
      }),
      on('weapon:dryFire', () => {
        punch(this.vAmmo, 1.1);
        this.setReloadTag(true);
      }),
      on('weapon:reloadStart', (p) => this.startActiveReload(p.weapon, p.duration, ctx)),
      on('weapon:activeReloadWindow', (p) => this.setActiveReloadWindow(p.open, ctx)),
      on('weapon:reloadEnd', (p) => this.endActiveReload(p.active ? 'good' : 'done')),
      on('hit:enemy', (p) => {
        // Both readouts take their crit from the SAME field. `info.isCrit` is set by
        // `firing.ts` as `part === 'head'`, so the marker, the number and the audio cue can
        // never disagree about what just happened.
        this.hitMarker(p.info.isCrit, p.killed);
        this.hitNumber(p.info.amount, p.info.isCrit, p.killed, p.target.id);
      }),
      on('ui:prompt', (p) => this.prompt(p.text)),
      on('ui:titleCard', (p) => this.titleCard(p.text, p.subtitle, p.duration)),
    );

    this.pointsTarget = ctx.player.points;
    this.pointsShown = this.pointsTarget;

    ctx.debug.watch('hud spread', () => this.spreadGap.toFixed(1) + 'px');
    ctx.debug.watch('hud reload', () => this.arState);
    ctx.debug.watch('hud live', () => {
      const bits: string[] = [];
      if (this.rolling) bits.push('roll');
      if (this.combo >= 2) bits.push('combo');
      if (this.buffs.length > 0) bits.push(`buff×${this.buffs.length}`);
      if (this.downLeft > 0) bits.push('down');
      return bits.length > 0 ? bits.join(' ') : 'idle';
    });
  }

  /** Presentation only — runs on unscaled frame time so the HUD never freezes in hitstop. */
  update(dt: number, ctx: GameCtx): void {
    this.fovDeg = ctx.camera.fov;
    this.stepPoints(dt);
    this.stepCombo(dt);
    this.stepBuffs(dt);
    this.stepDown(dt);
    this.setRemaining(ctx.rounds.phase === 'active' ? ctx.rounds.remaining : 0);

    // Crosshair gap chases the requested cone. Exponential chase is framerate-independent.
    const want = this.gapFor(this.spreadTarget);
    const k = 1 - Math.exp(-CH.chase * dt);
    this.spreadGap += (want - this.spreadGap) * k;
    this.stepAds(dt, ctx);
    this.applyCrosshair();

    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitMark.style.opacity = '0';
    }
    // Unscaled frame time on purpose: the merge window has to close in REAL seconds, or a
    // hitstop frame (which is exactly when a shotgun's pellets land) would stretch it past a
    // trigger interval and start accumulating.
    this.hitNumAge += dt;
    if (this.titleTimer > 0) {
      this.titleTimer -= dt;
      if (this.titleTimer <= 0) this.dismissTitle();
    }
    this.stepActiveReload(dt, ctx);

    // Compass + minimap. `visible && !modal` is the "is anyone looking at this" gate; the widget
    // applies its own second gate (no redraw unless gameplay time advanced or the player turned),
    // which is what makes a paused or hitstopped frame cost a float compare.
    this.nav.update(dt, ctx, this.visible && !this.modal);
  }

  dispose(): void {
    this.nav.dispose();
    window.removeEventListener('resize', this.onResize);
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.root.remove();
    this.styleEl.remove();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HudService
  // ═══════════════════════════════════════════════════════════════════════════

  titleCard(text: string, subtitle?: string, duration = 2.2): void {
    // A card layer (the boon draw, the back cover) owns the whole page while it is up. Two
    // full-screen panels fighting reads as a bug, so the modal always wins.
    if (this.modal) return;
    this.titleText.textContent = text;
    this.titleSub.textContent = subtitle ?? '';
    this.titleEl.style.visibility = 'visible';
    this.titleEl.style.opacity = '1';
    this.titleTimer = duration;

    for (const el of [this.titlePanel, this.titleLines]) {
      el.getAnimations().forEach((a) => a.cancel());
    }

    // The panel SLAMS on: overshoot, a held frame at the overshoot, then settle. The held
    // frame is the whole trick — without it this reads as a tween, not as ink hitting paper.
    //
    // EVERY keyframe names EVERY property it touches, including the one at offset 1. A property
    // missing from the last keyframe gets an implicit keyframe built from the element's
    // underlying value, which — after a previous dismiss animation has run — is zero, and the
    // card silently finishes invisible. Explicit endpoints, always.
    const rot = 'rotate(-2deg)';
    this.titlePanel.animate(
      [
        { transform: `${rot} scale(2.1)`, opacity: 0, offset: 0 },
        { transform: `${rot} scale(.9)`, opacity: 1, offset: 0.14 },
        { transform: `${rot} scale(.9)`, opacity: 1, offset: 0.14 + TITLE_HOLD },
        { transform: `${rot} scale(1.07)`, opacity: 1, offset: 0.34 },
        { transform: `${rot} scale(1)`, opacity: 1, offset: 1 },
      ],
      { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' },
    );

    // Speed lines rush in and keep turning fractionally — a still radial burst looks printed;
    // a slowly rotating one looks like it is being drawn.
    this.titleLines.animate(
      [
        { transform: 'rotate(-9deg) scale(.55)', opacity: 0, offset: 0 },
        { transform: 'rotate(-2deg) scale(1)', opacity: 0.62, offset: 0.1 },
        { transform: 'rotate(3deg) scale(1.08)', opacity: 0.3, offset: 1 },
      ],
      { duration: duration * 1000, easing: 'cubic-bezier(.1,.8,.3,1)', fill: 'both' },
    );
  }

  toast(text: string): void {
    const el = div('cz-toast');
    el.textContent = text;
    this.toastStack.appendChild(el);
    // Cap the stack — a wall of toasts is noise, not information.
    while (this.toastStack.childElementCount > 4) this.toastStack.firstElementChild?.remove();

    const rot = this.toastStack.childElementCount % 2 === 0 ? 1.9 : -1.6;
    el.animate(
      [
        { transform: `translateY(26px) rotate(${rot}deg) scale(.8)`, opacity: 0 },
        { transform: `translateY(0) rotate(${rot}deg) scale(1.06)`, opacity: 1, offset: 0.16 },
        { transform: `translateY(0) rotate(${rot}deg) scale(1)`, opacity: 1, offset: 0.24 },
        { transform: `translateY(0) rotate(${rot}deg) scale(1)`, opacity: 1, offset: 0.8 },
        { transform: `translateY(-16px) rotate(${rot}deg) scale(.96)`, opacity: 0 },
      ],
      { duration: 2600, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'forwards' },
    ).finished.then(() => el.remove()).catch(() => el.remove());
  }

  prompt(text: string | null): void {
    const span = this.promptEl.firstElementChild as HTMLElement;
    if (text === null || text.length === 0) {
      this.promptEl.dataset.on = '0';
      return;
    }
    // `HOLD F — Ratatat [500]`: the key is ELECTRIC, the cost is GOLD. Both are parsed out of
    // the plain string so callers never have to know about markup.
    span.innerHTML = text
      .replace(/\b(HOLD|TAP|PRESS)\s+([A-Z0-9]+)\b/g, '$1 <b>$2</b>')
      .replace(/\[(\d+)\]/g, `<span style="color:${css('GOLD')};-webkit-text-stroke:1px ${css('INK')}">[$1]</span>`);
    this.promptEl.dataset.on = '1';
  }

  setCrosshairSpread(radians: number): void {
    this.spreadTarget = radians > 0 ? radians : 0;
  }

  hitMarker(isCrit: boolean, killed: boolean): void {
    this.hitMark.dataset.crit = isCrit ? '1' : '0';
    this.hitMark.dataset.kill = killed ? '1' : '0';
    this.hitMark.style.opacity = '1';
    this.hitTimer = killed ? 0.3 : 0.18;
    // Cancel the one animation we know about instead of asking the element for its list —
    // `getAnimations()` builds a fresh array on every call, and this runs per bullet.
    this.hitMarkAnim?.cancel();
    this.hitMarkAnim = this.hitMark.animate(
      killed ? HITMARK_KF_KILL : isCrit ? HITMARK_KF_CRIT : HITMARK_KF_BODY,
      killed ? HITMARK_TIME_KILL : HITMARK_TIME_HIT,
    );
  }

  /**
   * THE NUMBER. What that bullet was actually worth, next to the crosshair, in real units.
   *
   * This is the readout the player asked for: it is how you tell a 26 from a 42, how you see a
   * head shot pay 2.5×, and — once Pack-a-Punch exists — how an upgrade proves itself in one
   * shot instead of one round. `amount` comes straight off `DamageInfo`, post-falloff and
   * post-multiplier, i.e. exactly what the zombie lost.
   *
   * Merging is per TARGET and only inside `HITNUM.mergeWindow` (45 ms — under the fastest fire
   * interval in the game), so it can catch the pellets of one shotgun blast and never two pulls
   * of a trigger. `killed` outranks `isCrit` for the styling: the last hit is the one you most
   * need to read, and GOLD matches the kill diamond the marker draws in the same frame.
   */
  private hitNumber(amount: number, isCrit: boolean, killed: boolean, targetId: number): void {
    if (!(amount > 0)) return;

    const merging =
      this.hitNumSlot >= 0 && this.hitNumOwner === targetId && this.hitNumAge < HITNUM.mergeWindow;

    const slot = merging ? this.hitNumSlot : this.hitNumNext;
    if (!merging) this.hitNumNext = (this.hitNumNext + 1) % HITNUM.slots;

    this.hitNumValue = merging ? this.hitNumValue + amount : amount;
    this.hitNumCrit = merging ? this.hitNumCrit || isCrit : isCrit;
    this.hitNumOwner = targetId;
    this.hitNumSlot = slot;
    this.hitNumAge = 0;

    const shell = this.hitNumShells[slot]!;
    const kind = killed ? 'kill' : this.hitNumCrit ? 'crit' : 'body';
    if (shell.dataset.kind !== kind) shell.dataset.kind = kind;
    this.hitNumGlyphs[slot]!.textContent = damageLabel(this.hitNumValue);

    // A merged pellet only rewrites the text — restarting the slam mid-blast would make one
    // shot look like eight, which is the exact noise this readout exists to replace. A kill is
    // the one exception: the pose changes, so it has to be re-played.
    if (merging && !killed) return;
    this.hitNumAnims[slot]?.cancel();
    this.hitNumAnims[slot] = this.hitNumGlyphs[slot]!.animate(
      killed ? HITNUM_KF_KILL : this.hitNumCrit ? HITNUM_KF_CRIT : HITNUM_KF_BODY,
      HITNUM_TIMING,
    );
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.dataset.hidden = v ? '0' : '1';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Value setters — public so M3 can drive them directly as well as by event
  // ═══════════════════════════════════════════════════════════════════════════

  setHealth(health: number, maxHealth = this.maxHealth): void {
    const h = Math.max(0, Math.ceil(health));
    const changed = h !== Math.ceil(this.health);
    this.health = health;
    this.maxHealth = Math.max(1, maxHealth);
    this.applyHealth();
    if (changed) punch(this.vHealth, 0.75);
  }

  /**
   * The number the player is chasing. It does not jump — it ROLLS, in `stepPoints`, and stops
   * dead the instant it arrives. A counter that keeps ticking while you stand still is exactly
   * the class of bug ART §4.1 forbids, so `rolling` is a hard latch, not a decaying spring.
   */
  setPoints(total: number): void {
    if (total === this.pointsTarget) return;
    const up = total > this.pointsTarget;
    this.pointsTarget = total;
    // A drop (a purchase, a new run) is not a slot machine — snap it.
    if (!up) {
      this.pointsShown = total;
      this.rolling = false;
      this.writePoints();
      punch(this.vPoints, 0.5);
      return;
    }
    this.rolling = true;
    punch(this.vPoints, 1);
  }

  setRound(n: number): void {
    if (n === this.round) return;
    this.round = n;
    this.vRound.textContent = n > 0 ? String(n).padStart(2, '0') : '—';
    // THE SLAM. A round number is the biggest state change on the HUD and it gets the biggest
    // punch in the vocabulary: overshoot past 1.6, a held frame, then settle with a kick of
    // rotation so it lands like a stamp rather than a tween.
    this.vRound.getAnimations().forEach((a) => a.cancel());
    this.vRound.animate(
      [
        { transform: 'scale(2.05) rotate(-9deg)', opacity: 0, offset: 0 },
        { transform: 'scale(1.34) rotate(4deg)', opacity: 1, offset: 0.2 },
        { transform: 'scale(1.34) rotate(4deg)', opacity: 1, offset: 0.28 },
        { transform: 'scale(.93) rotate(-2deg)', opacity: 1, offset: 0.55 },
        { transform: 'scale(1) rotate(0deg)', opacity: 1, offset: 1 },
      ],
      { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' },
    );
  }

  setAmmo(ammo: number, reserve: number): void {
    if (ammo === this.ammo && reserve === this.reserve) return;
    const spent = ammo < this.ammo;
    this.ammo = ammo;
    this.reserve = reserve;
    // "Full" is whatever the largest magazine we have seen is — so the low-ammo threshold
    // follows a mag-size boon without the HUD having to know that boons exist.
    if (ammo > this.magMax) this.magMax = ammo;
    this.vAmmo.textContent = String(ammo);
    // `reserve < 0` is the weapon system's flag for an infinite reserve.
    this.vReserve.textContent = reserve < 0 ? '∞' : `/ ${reserve}`;
    this.applyAmmoState();
    if (spent) punch(this.vAmmo, 0.45);
    else punch(this.vAmmo);
  }

  /**
   * THE AGGRESSION DIAL. `combo` is the raw unbroken-kill count, `multiplier` the payout tier.
   * The badge scales with the TIER (that is the thing worth chasing), and the drain bar under it
   * is driven from `RoundExtras.comboGraceFraction` every frame the chain is alive — the player
   * has to be able to feel the 3-second window closing or the meter is just a number.
   */
  setCombo(combo: number, multiplier: number): void {
    const wasOn = this.combo >= 2;
    this.combo = combo;
    const on = combo >= 2;
    this.comboEl.dataset.on = on ? '1' : '0';
    if (!on) {
      // The chain died. Park the bar full so the next one starts from a clean card, and stop
      // writing to it — from here the badge is invisible and completely static.
      this.comboFill.style.transform = 'scaleX(1)';
      this.lastComboFill = 1;
      this.comboMult = 1;
      if (wasOn) this.comboEl.dataset.tier = 'cool';
      return;
    }
    const tierChanged = multiplier !== this.comboMult;
    this.comboMult = multiplier;
    this.vCombo.textContent = `x${multiplier}${multiplier >= 4 ? '!!' : ''}`;
    // ×2 → 2.5rem, ×5 → 4.0rem. The badge physically grows as the stakes do.
    this.vCombo.style.fontSize = `${(2.5 + (multiplier - 2) * 0.5).toFixed(2)}rem`;
    this.comboEl.dataset.tier = multiplier >= 4 ? 'hot' : 'cool';
    punch(this.vCombo, tierChanged ? 1.35 : 0.6);
    if (tierChanged) this.slamCombo();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M3 — the loop's furniture
  // ═══════════════════════════════════════════════════════════════════════════

  /** `main.ts` hands us the real `RoundSystem`. Without it the combo bar simply stays full. */
  attachRounds(src: RoundExtras): void {
    this.rounds = src;
  }

  /** A card layer owns the screen: hold every title card until it hands the page back. */
  setModal(on: boolean): void {
    this.modal = on;
    if (on && this.titleTimer > 0) {
      this.titleTimer = 0;
      this.dismissTitle();
    }
  }

  private onRoundStart(round: number, toSpawn: number): void {
    const surge = ROUND.surgeEvery > 0 && round % ROUND.surgeEvery === 0;
    this.roundEl.dataset.surge = surge ? '1' : '0';
    this.setRound(round);
    this.setRemaining(toSpawn);
    this.clearBuffs();
    this.titleCard(
      `ROUND ${round}`,
      surge ? 'SURGE — DOUBLE POINTS' : round === 1 ? 'THEY ARE COMING' : `${toSpawn} IN THE STREET`,
      ROUND.titleCardTime * 0.85,
    );
  }

  /** A new run: wipe everything that belonged to the last one. */
  private onRespawn(ctx: GameCtx): void {
    this.exitDown();
    this.clearBuffs();
    this.setCombo(0, 1);
    this.deckEl.textContent = '';
    this.roundEl.dataset.surge = '0';
    this.setRemaining(0);
    this.pointsTarget = ctx.player.points;
    this.pointsShown = this.pointsTarget;
    this.rolling = false;
    this.points = -1;
    this.writePoints();
  }

  // ── points ────────────────────────────────────────────────────────────────

  private writePoints(): void {
    const n = Math.round(this.pointsShown);
    if (n === this.points) return;
    this.points = n;
    this.vPoints.textContent = n.toLocaleString('en-US');
  }

  private stepPoints(dt: number): void {
    this.floatAge += dt;
    if (!this.rolling) return;
    const gap = this.pointsTarget - this.pointsShown;
    if (Math.abs(gap) <= POINTS.rollSnap) {
      this.pointsShown = this.pointsTarget;
      this.rolling = false;
    } else {
      this.pointsShown += gap * (1 - Math.exp(-POINTS.rollRate * dt));
    }
    this.writePoints();
  }

  /**
   * "+60" flying off the badge. Awards inside `POINTS.mergeWindow` MERGE rather than stack: a
   * shotgun into a horde pays six times in three frames and six overlapping floaters is noise.
   */
  private floatPoints(delta: number): void {
    if (delta <= 0) return;
    if (this.floatAge < POINTS.mergeWindow) {
      const live = this.floats[(this.floatNext - 1 + POINTS.floaters) % POINTS.floaters]!;
      this.floatValue += delta;
      live.textContent = `+${this.floatValue}`;
      this.floatAge = 0;
      return;
    }
    const el = this.floats[this.floatNext]!;
    this.floatNext = (this.floatNext + 1) % POINTS.floaters;
    this.floatValue = delta;
    this.floatAge = 0;
    el.textContent = `+${delta}`;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate(
      [
        { transform: 'translate(0, 6px) scale(.7) rotate(-6deg)', opacity: 0, offset: 0 },
        { transform: 'translate(0, -8px) scale(1.15) rotate(2deg)', opacity: 1, offset: 0.18 },
        { transform: 'translate(0, -14px) scale(1) rotate(0deg)', opacity: 1, offset: 0.32 },
        { transform: 'translate(0, -52px) scale(.95) rotate(3deg)', opacity: 0, offset: 1 },
      ],
      { duration: 900, easing: 'cubic-bezier(.15,.85,.3,1)', fill: 'forwards' },
    );
  }

  // ── enemies left ──────────────────────────────────────────────────────────

  private setRemaining(n: number): void {
    if (n === this.remainShown) return;
    const wasHidden = this.remainShown <= 0;
    this.remainShown = n;
    if (n <= 0) { this.remainEl.dataset.on = '0'; return; }
    this.remainEl.dataset.on = '1';
    this.vRemain.textContent = String(n);
    if (!wasHidden) punch(this.vRemain, 0.5);
  }

  // ── combo ─────────────────────────────────────────────────────────────────

  private stepCombo(dt: number): void {
    void dt;
    if (this.combo < 2) return;
    const f = this.rounds ? Math.max(0, Math.min(1, this.rounds.comboGraceFraction)) : 1;
    if (Math.abs(f - this.lastComboFill) < 0.005) return;
    this.lastComboFill = f;
    this.comboFill.style.transform = `scaleX(${f.toFixed(3)})`;
  }

  /** The whole card kicks when the TIER changes — a bigger beat than a number punch. */
  private slamCombo(): void {
    const base = 'translateY(-50%) rotate(-5deg)';
    this.comboEl.getAnimations().forEach((a) => a.cancel());
    this.comboEl.animate(
      [
        { transform: `${base} scale(1)` },
        { transform: `${base} scale(1.22)`, offset: 0.24 },
        { transform: `${base} scale(1.22)`, offset: 0.33 },
        { transform: `${base} scale(.97)`, offset: 0.62 },
        { transform: `${base} scale(1)` },
      ],
      { duration: 300, easing: 'cubic-bezier(.2,.9,.25,1)' },
    );
  }

  // ── power-up timers ───────────────────────────────────────────────────────

  private addBuff(id: string): void {
    const total = BUFF_TIME[id];
    const label = BUFF_LABEL[id];
    if (total === undefined || label === undefined) return;

    let b = this.buffs.find((x) => x.id === id);
    if (!b) {
      const el = div('cz-buff');
      const text = document.createElement('span');
      const bar = document.createElement('i');
      el.append(text, bar);
      this.buffLayer.appendChild(el);
      b = { id, el, bar, text, left: total, total, shown: -1 };
      this.buffs.push(b);
    }
    b.left = total;
    b.total = total;
    b.shown = -1;
    this.writeBuff(b);
    b.el.getAnimations().forEach((a) => a.cancel());
    b.el.animate(
      [
        { transform: 'translateX(-120%) rotate(-8deg)', opacity: 0 },
        { transform: 'translateX(6px) rotate(1.4deg)', opacity: 1, offset: 0.55 },
        { transform: 'translateX(0) rotate(-1.4deg)', opacity: 1 },
      ],
      { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' },
    );
  }

  private writeBuff(b: { el: HTMLDivElement; bar: HTMLElement; text: HTMLElement; id: string; left: number; total: number; shown: number }): void {
    const secs = Math.max(0, Math.ceil(b.left));
    if (secs !== b.shown) {
      b.shown = secs;
      b.text.textContent = `${BUFF_LABEL[b.id] ?? b.id} ${secs}`;
    }
    b.bar.style.transform = `scaleX(${(b.left / b.total).toFixed(3)})`;
  }

  private stepBuffs(dt: number): void {
    if (this.buffs.length === 0) return;
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      const b = this.buffs[i]!;
      b.left -= dt;
      if (b.left <= 0) {
        b.el.remove();
        this.buffs.splice(i, 1);
        continue;
      }
      this.writeBuff(b);
    }
  }

  private clearBuffs(): void {
    for (const b of this.buffs) b.el.remove();
    this.buffs.length = 0;
  }

  // ── the deck ──────────────────────────────────────────────────────────────

  /**
   * Rebuilt whole on every take. `boons.owned` is a stable array updated in place, so reading it
   * here is always current, and a full rebuild of ≤26 chips a few times a run is cheaper than
   * keeping a diff correct.
   */
  private onBoonChosen(def: BoonDef, ctx: GameCtx): void {
    const owned = ctx.boons.owned;
    let html = '';
    for (let i = 0; i < owned.length; i++) {
      const d = owned[i]!.def;
      const icon = isIconId(d.icon) ? d.icon : FALLBACK_ICON;
      html +=
        `<div class="cz-chip" title="${d.name}">${iconSvg(icon, 'BONE', 'PAPER')}` +
        (owned[i]!.stacks > 1 ? `<i>&times;${owned[i]!.stacks}</i>` : '') +
        '</div>';
    }
    this.deckEl.innerHTML = html;
    const last = this.deckEl.lastElementChild;
    if (last) {
      last.animate(
        [
          { transform: 'scale(2.4) rotate(-14deg)', opacity: 0 },
          { transform: 'scale(1.1) rotate(3deg)', opacity: 1, offset: 0.45 },
          { transform: 'scale(1) rotate(0deg)', opacity: 1 },
        ],
        { duration: 380, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
    }
    this.toast(`${def.name.toUpperCase()} TAKEN`);
  }

  // ── down ──────────────────────────────────────────────────────────────────

  private enterDown(seconds: number): void {
    // Clear anything mid-beat: a ROUND N card still on screen when you go down is two panels
    // shouting at once, and the one that matters is the countdown.
    if (this.titleTimer > 0) { this.titleTimer = 0; this.dismissTitle(); }
    this.downTotal = Math.max(0.1, seconds);
    this.downLeft = this.downTotal;
    this.downShown = -1;
    this.downEl.dataset.on = '1';
    this.stepDown(0);
    this.downEl.getAnimations().forEach((a) => a.cancel());
    this.downEl.animate(
      [
        { opacity: 0, transform: 'scale(1.14)' },
        { opacity: 1, transform: 'scale(.98)', offset: 0.18 },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' },
    );
  }

  private exitDown(): void {
    if (this.downLeft <= 0 && this.downEl.dataset.on === '0') return;
    this.downLeft = 0;
    this.downEl.dataset.on = '0';
  }

  private stepDown(dt: number): void {
    if (this.downLeft <= 0) return;
    this.downLeft -= dt;
    const left = Math.max(0, this.downLeft);
    const secs = Math.ceil(left);
    if (secs !== this.downShown) {
      this.downShown = secs;
      this.downNum.textContent = String(secs);
      punch(this.downNum, 1.1);
    }
    this.downFill.style.transform = `scaleX(${(left / this.downTotal).toFixed(3)})`;
    if (this.downLeft <= 0) this.downEl.dataset.on = '0';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTIVE RELOAD — the pistol's skill expression, drawn.
  //
  // The bar is driven by the same unscaled frame clock the weapon's reload runs on, so the
  // needle and the weapon agree to within one frame without either knowing about the other.
  // The SWEET SPOT is placed from FRACTIONS of `reloadTime`, never from absolute seconds:
  // a reload-speed boon then shortens the bar and the sweet spot together, and the muscle
  // memory the player built keeps working. That is the whole reason it is done this way.
  // ═══════════════════════════════════════════════════════════════════════════

  private startActiveReload(weapon: WeaponInstance, duration: number, ctx: GameCtx): void {
    const def = weapon.def;
    const total = Math.max(def.reloadTime, 1e-3);
    const start = clamp01(def.activeReloadWindow[0] / total);
    const width = clamp01(def.activeReloadWindow[1] / total);

    this.arDuration = Math.max(duration, 0.05);
    this.arT = 0;
    this.arResult = 0;
    this.arWindowSeen = false;
    this.arRunning = true;
    this.arTapped = false;
    this.arStartFrame = ctx.time.frame;
    this.arClosedFrame = -1;
    this.lastNeedlePx = Number.NaN;

    this.arZone.style.left = `${(start * 100).toFixed(2)}%`;
    this.arZone.style.width = `${(Math.max(width, 0.02) * 100).toFixed(2)}%`;
    this.arFill.style.transform = 'scaleX(0)';
    this.arNeedle.style.left = '0px';

    this.arLabel.textContent = 'RELOADING';
    this.arState = 'run';
    this.arEl.dataset.on = '1';
    this.arEl.dataset.state = 'run';
    this.setReloadTag(false);
    this.slamBar(0.55);
  }

  private setActiveReloadWindow(open: boolean, ctx: GameCtx): void {
    if (open) this.arWindowSeen = true;
    else this.arClosedFrame = ctx.time.frame;
    // A verdict already on screen outranks the window state — the window closing is exactly
    // what a successful tap causes, and it must not wipe the PERFECT! the tap just earned.
    if (this.arState !== 'run' && this.arState !== 'open') return;
    if (open) {
      this.arState = 'open';
      this.arEl.dataset.state = 'open';
      this.arLabel.textContent = 'TAP R';
      this.slamBar(0.35);
    } else {
      this.arState = 'run';
      this.arEl.dataset.state = 'run';
      this.arLabel.textContent = 'RELOADING';
    }
  }

  /**
   * THE VERDICT, ON THE FRAME OF THE PRESS.
   *
   * The weapon does not announce the tap — success only becomes visible ~0.5s later when the
   * shortened reload ends, and a skill mechanic whose feedback arrives half a second after the
   * input cannot be learned. So the HUD reads the same edge, on the same frame, and applies the
   * same rule the weapon does: the window was open ⇒ you got it.
   *
   * Why `arClosedFrame` matters: the weapon system is registered ahead of the HUD, so by the
   * time this runs it has ALREADY consumed the tap and closed the window — `arState` reads
   * 'run' and a naive check would print MISSED on a perfect reload. The window having closed on
   * THIS frame counts as open.
   */
  private checkActiveReloadTap(ctx: GameCtx): void {
    if (!this.arRunning || this.arTapped) return;
    // The press that STARTED the reload is not an attempt at its own window.
    if (ctx.time.frame === this.arStartFrame) return;
    if (!ctx.input.pressed('reload')) return;

    this.arTapped = true;
    const wasOpen = this.arState === 'open' || this.arClosedFrame === ctx.time.frame;
    if (wasOpen) {
      this.arState = 'good';
      this.arEl.dataset.state = 'good';
      this.arLabel.textContent = 'PERFECT!';
      this.slamBar(1);
    } else {
      this.arState = 'miss';
      this.arEl.dataset.state = 'miss';
      this.arLabel.textContent = 'MISSED';
    }
  }

  /** `good` = active reload landed · `done` = ordinary finish · `off` = tear it down now. */
  private endActiveReload(kind: 'good' | 'done' | 'off'): void {
    if (kind === 'off' || this.arState === 'off') {
      this.arState = 'off';
      this.arResult = 0;
      this.arRunning = false;
      this.arEl.dataset.on = '0';
      return;
    }
    this.arRunning = false;
    this.arFill.style.transform = 'scaleX(1)';
    this.arNeedle.style.left = `${AR.trackW}px`;
    this.lastNeedlePx = AR.trackW;

    if (kind === 'good') {
      this.arState = 'good';
      this.arEl.dataset.state = 'good';
      this.arLabel.textContent = 'PERFECT!';
      this.arResult = AR.resultHold;
      this.slamBar(1);
    } else if (this.arWindowSeen) {
      // Only call it a miss if the window actually opened and went by — a reload interrupted
      // before the window ever opened is not a failure and must not be scolded.
      this.arState = 'miss';
      this.arEl.dataset.state = 'miss';
      this.arLabel.textContent = 'MISSED';
      this.arResult = AR.resultHold * 0.62;
    } else {
      this.arState = 'off';
      this.arEl.dataset.on = '0';
      return;
    }
    this.setReloadTag(false);
  }

  private stepActiveReload(dt: number, ctx: GameCtx): void {
    if (this.arState === 'off') return;
    this.checkActiveReloadTap(ctx);

    if (this.arResult > 0) {
      this.arResult -= dt;
      if (this.arResult <= 0) {
        this.arState = 'off';
        this.arEl.dataset.on = '0';
      }
      return;
    }
    // A provisional verdict is already on the card, but the reload itself is still running —
    // the needle keeps travelling so the bar never lies about how long is left.
    if (!this.arRunning) return;

    this.arT += dt;
    const t = this.arT / this.arDuration;
    if (t >= 1.25) {
      // Belt and braces: if a `weapon:reloadEnd` is ever lost the bar still leaves the screen.
      this.endActiveReload('off');
      return;
    }
    const px = Math.min(1, t) * AR.trackW;
    // Sub-half-pixel needle movement is invisible and costs a style recalc every frame.
    if (Math.abs(px - this.lastNeedlePx) < 0.5) return;
    this.lastNeedlePx = px;
    this.arNeedle.style.left = `${px.toFixed(1)}px`;
    this.arFill.style.transform = `scaleX(${(px / AR.trackW).toFixed(4)})`;
  }

  /**
   * The bar's own punch. It cannot use `punch()` because the card carries a translate and a
   * rotation in its CSS transform, and a WAAPI `scale(1)` keyframe would drop both — the bar
   * would jump to the left of the screen for 280ms. Every keyframe writes the whole transform.
   */
  private slamBar(strength: number): void {
    const base = 'translateX(-50%) rotate(-1.6deg)';
    this.arEl.getAnimations().forEach((a) => a.cancel());
    const up = (1 + 0.14 * strength).toFixed(3);
    this.arEl.animate(
      [
        { transform: `${base} scale(${(1 - 0.06 * strength).toFixed(3)})` },
        { transform: `${base} scale(${up})`, offset: 0.3 },
        { transform: `${base} scale(1)` },
      ],
      { duration: 210, easing: 'cubic-bezier(.2,.9,.25,1)' },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DAMAGE DIRECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `fromDirection` is the DIRECTION OF TRAVEL of whatever hit you (`DamageInfo.direction`),
   * so the attacker is at minus that. Projected onto the camera's right/forward basis it
   * becomes a screen angle: 0° straight ahead, +90° off your right shoulder.
   */
  private damageFrom(fromDirection: THREE.Vector3, ctx: GameCtx): void {
    _toSrc.copy(fromDirection).multiplyScalar(-1);
    _fwd.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    _rgt.set(1, 0, 0).applyQuaternion(ctx.camera.quaternion);
    const x = _toSrc.dot(_rgt);
    const z = _toSrc.dot(_fwd);
    if (x === 0 && z === 0) return;

    const deg = (Math.atan2(x, z) * 180) / Math.PI;
    const slot = this.dmgSlots[this.dmgNext]!;
    this.dmgNext = (this.dmgNext + 1) % DMG.slots;
    slot.setAttribute('transform', `rotate(${deg.toFixed(1)})`);

    const pulse = slot.firstElementChild as SVGGElement;
    pulse.getAnimations().forEach((a) => a.cancel());
    pulse.animate(
      [
        { opacity: 0, transform: 'scale(1.22)' },
        { opacity: 1, transform: 'scale(.97)', offset: 0.12 },
        { opacity: 1, transform: 'scale(1)', offset: 0.2 },
        { opacity: 1, transform: 'scale(1)', offset: 0.6 },
        { opacity: 0, transform: 'scale(1.04)' },
      ],
      { duration: DMG.life * 1000, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'forwards' },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // internals
  // ═══════════════════════════════════════════════════════════════════════════

  /** Low / empty is a COLOUR change and a printed tag. Never a blink — see ART §4.1. */
  private applyAmmoState(): void {
    const empty = this.ammo <= 0;
    const low = !empty && this.magMax > 0 && this.ammo / this.magMax <= LOW_AMMO_FRAC;
    this.ammoEl.dataset.low = low ? '1' : '0';
    this.ammoEl.dataset.empty = empty ? '1' : '0';
    this.setReloadTag((low || empty) && this.arState === 'off');
  }

  private setReloadTag(on: boolean): void {
    const want = on ? '1' : '0';
    if (this.reloadTag.dataset.on === want) return;
    this.reloadTag.dataset.on = want;
    if (on) {
      this.reloadTag.animate(
        [
          { transform: 'rotate(2.4deg) scale(.6)', opacity: 0 },
          { transform: 'rotate(2.4deg) scale(1.08)', opacity: 1, offset: 0.4 },
          { transform: 'rotate(2.4deg) scale(1)', opacity: 1 },
        ],
        { duration: 220, easing: 'cubic-bezier(.2,.9,.25,1)' },
      );
    }
  }

  /** Cached on resize — reading `clientHeight` per frame forces a synchronous layout. */
  private readonly onResize = (): void => { this.measure(); };

  private measure(): void {
    this.viewportH = this.root.clientHeight || window.innerHeight;
  }

  /** Cone half-angle (radians) → pixels on screen, using the live vertical FOV. */
  private gapFor(radians: number): number {
    const h = this.viewportH || window.innerHeight;
    const focal = (h * 0.5) / Math.tan((this.fovDeg * Math.PI) / 360);
    const px = Math.tan(radians) * focal;
    return Math.min(CH.maxGap, CH.minGap + px);
  }

  /** Chase the aim blend at the CURRENT weapon's ADS speed. See the `adsBlend` field. */
  private stepAds(dt: number, ctx: GameCtx): void {
    const w = ctx.weapons.current;
    // A weapon with an instant ADS, or no weapon at all, must not divide by zero.
    const time = Math.max(0.02, (w ? w.def.adsTime : 0.2) * CH.adsFadeFraction);
    const target = ctx.player.isAiming ? 1 : 0;
    // Exponential chase with a half-life of `time / 3`: ~95% of the way in `time`.
    this.adsBlend += (target - this.adsBlend) * (1 - Math.exp(-(3 / time) * dt));
    // Snap the ends so the crosshair reaches exactly full opacity at the hip (ART §4.1: an
    // idle HUD element that never quite settles is a pixel that never stops changing).
    if (target === 0 && this.adsBlend < 0.002) this.adsBlend = 0;
    else if (target === 1 && this.adsBlend > 0.998) this.adsBlend = 1;
  }

  private applyCrosshair(): void {
    const r = this.spreadGap;
    // Opacity first: the gap can be settled while the fade is still running.
    //
    // NOTE THE SENSE OF THE TEST. It is written as an early-out on "close enough", exactly like
    // `lastAppliedGap` below, and that is load-bearing rather than stylistic: the seed value is
    // NaN, every comparison against NaN is false, and the inverted form (`if (delta >= eps)
    // apply`) therefore NEVER fires — not on the first frame, and not ever after, because the
    // last-applied value is only written inside the branch. I wrote it that way first and the
    // crosshair never faded at all.
    const o = 1 + (CH.adsOpacity - 1) * this.adsBlend;
    // The two ENDPOINTS always get written, even when they are inside the epsilon of the last
    // value. `stepAds` snaps its blend to exactly 0 or 1, and without this the final step of the
    // fade is swallowed: MEASURED, the crosshair settled at 0.996 opacity and stayed there for
    // the rest of the run because the remaining 0.004 never cleared the guard. The same class of
    // "nearly at rest, forever" the viewmodel's `restEpsilon` snap exists to kill (ART §4.1).
    const settled = o === 1 || o === CH.adsOpacity;
    if (!(Math.abs(o - this.lastAppliedCrossOpacity) < 0.004) ||
        (settled && o !== this.lastAppliedCrossOpacity)) {
      this.lastAppliedCrossOpacity = o;
      this.crossEl.style.opacity = o.toFixed(3);
    }
    // Sub-0.05px crosshair movement is invisible and costs a transform re-parse per tick.
    if (Math.abs(r - this.lastAppliedGap) < 0.05) return;
    this.lastAppliedGap = r;
    const t = (-r).toFixed(2);
    for (let i = 0; i < 4; i++) {
      this.crossTicks[i]!.setAttribute('transform', CROSS_ROT[i] + ' translate(0,' + t + ')');
    }
  }

  private applyHealth(): void {
    const frac = Math.max(0, Math.min(1, this.health / this.maxHealth));
    this.hpFill.style.transform = `scaleX(${frac.toFixed(4)})`;
    // Below a quarter the bar goes GOLD→HOT and the number turns: value contrast does the
    // warning, not an animation the player has to notice.
    this.hpFill.style.background = frac < 0.26 ? css('HOT') : css('ACID');
    this.vHealth.style.color = frac < 0.26 ? css('HOT') : css('INK');
    this.vHealth.textContent = String(Math.max(0, Math.ceil(this.health)));
  }

  private dismissTitle(): void {
    this.titleEl.style.opacity = '0';
    this.titlePanel.animate(
      [
        { transform: 'rotate(-2deg) scale(1)', opacity: 1 },
        { transform: 'rotate(-6deg) scale(1.22)', opacity: 0 },
      ],
      { duration: 240, easing: 'cubic-bezier(.6,0,.9,.4)', fill: 'forwards' },
    );
    window.setTimeout(() => {
      if (this.titleTimer <= 0) this.titleEl.style.visibility = 'hidden';
    }, 260);
  }
}

export function createHud(opts?: HudOptions): HudSystem {
  return new HudSystem(opts);
}

/** Re-exported so `main.ts` can tint a toast without reaching for a raw hex. */
export { PALETTE };

/**
 * PASS 8 — VIGNETTE + FOREGROUND FLOOR WASH + PANEL FRAME (ART_DIRECTION §4.8, §6, §7)
 *
 * Three things:
 *
 *   • **THE FOREGROUND FLOOR WASH.** New, and it is the fix for the single worst compositional
 *     fault in the shipped frame: the bottom ~40% of the picture is flat, bright, featureless
 *     tarmac — the largest area in the image, carrying no information — while the content the
 *     eye is supposed to land on (buildings, monument, sky) sits *darker* than it. Bright empty
 *     foreground under a dark busy background is the value structure upside down.
 *
 *     It cannot be fixed upstream. Contrast rotates about a pivot, so every increase in the
 *     grade pushes a 0.65 ground FURTHER up; and the ground is lit by the key at N·L = 0.72
 *     (`world/lighting.ts::KEY_DIR`), which is the top band, so there is no lighting knob that
 *     reaches it without taking the lit facades with it. What a colourist does instead is lay a
 *     shadow flat over the empty foreground — a graduated wash — and that is what this is.
 *
 *     Three properties make it safe rather than a blanket darkening:
 *       – it is **luminance-windowed**: it bites on the mid-bright empty tarmac and releases on
 *         both ends, so it never crushes the already-dark viewmodel, the ink, the crates or the
 *         shadow side of anything, and it never dulls a practical or a PAPER road marking;
 *       – it is **reserved-channel guarded** (ART §9): green dominance belongs to enemies and
 *         nothing else in the frame has any, so `g - max(r,b)` is a free, exact enemy mask and
 *         the wash releases on it. A zombie in the near foreground does not get dimmed;
 *       – it is a **pure function of `uv` and `gl_FragCoord`** — no clock, no seed, no depth.
 *         ART §4.1 holds by construction: a parked camera produces a bit-identical wash.
 *
 *   • **A heavy WARM vignette.** Not a grey darkening — the falloff is tinted toward RUST
 *     before it drops to INK, which is what a warm key light bouncing off a dark room does,
 *     and it is what keeps the frame edges from looking like a cheap Photoshop filter. The
 *     vignette also carries the damage state: `uVigDamage` pushes the whole ring toward HOT.
 *
 *   • **THE PANEL FRAME.** Driven to 1 for big beats (round start, boon draw, the last
 *     zombie of a round dying), the frame draws a thick hand-inked border around the image
 *     with slightly rounded corners, a PAPER gutter outside it, and a hand-drawn contour
 *     whose wobble is drawn ONCE PER BEAT and then held perfectly still. The picture stops
 *     being a camera feed and becomes a PANEL on a page. Ramp it in over ~0.15 s, out over ~0.5 s.
 *
 *     ART §4.1 — THE PANEL FRAME IS PRINT, NOT DRAWING. It used to ride `uBoil` at spatial
 *     multipliers of 31/47/19, which re-inked the entire border every 12 fps tick: measured
 *     5.227% of pixels changing per frame for the whole 25 s boon draw (budget 0.5%, and the
 *     border band alone was repainting 13–30% of itself every frame) — the human's #1 past
 *     complaint, reintroduced by our own furniture, in the three moments they sit still to
 *     read. The contour now comes from `uFrameSeed`, re-rolled by `Renderer.panelFrame()` on
 *     the RISING EDGE of a beat only. A new panel gets a new hand-inked line; the panel that
 *     is on screen never moves. Measured after: 0.041%.
 *
 * Runs in DISPLAY space, after the grade.
 *
 * UNIFORMS
 *   uFloorAmount   master foreground floor wash, 0 = off
 *   uFloorHeight   how far up the frame the wash reaches, in normalised screen units
 *   uFloorWindow   vec4(inLo, inHi, outLo, outHi) — the luminance window the wash bites in
 *   uFloorTint     multiplicative tint the floor is enriched toward before it is darkened
 *   uFloorEdge     the colour the wash resolves to at full strength (INK)
 *   uVigAmount     master vignette darkness, 0..1
 *   uVigInner      radius where the falloff starts (0 = centre, 1 = corner)
 *   uVigOuter      radius where it reaches full
 *   uVigWarm       multiplicative warm tint applied inside the falloff
 *   uVigEdge       the colour the extreme edge lands on (INK)
 *   uVigDamage     0..1, pushes the ring toward HOT — the damage indicator
 *   uVigHot        HOT, display-referred
 *   uFrame         0 = no panel, 1 = full comic panel border
 *   uFrameWidth    border thickness in normalised screen units
 *   uFrameMargin   how far the border is inset at uFrame == 1
 *   uFrameRadius   corner rounding
 *   uFrameWobble   hand-drawn contour amplitude
 *   uFrameSeed     three contour phases, re-rolled ONCE per beat and then held (never animated)
 *   uFrameInk      border colour
 *   uFramePaper    gutter colour outside the border
 */

import { Vector3, Vector4 } from 'three';
import { PALETTE } from '@/art/palette';
import { buildPass, srgbVec, tintVec, type CommonUniforms, type PassChunk, type Uniforms } from './common';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export interface VignetteOptions {
  amount?: number;
  inner?: number;
  outer?: number;
  warmAmount?: number;
  /** Foreground floor wash strength. 0 disables it entirely (a few multiplies). */
  floorAmount?: number;
  floorHeight?: number;
  frameWidth?: number;
  frameMargin?: number;
  frameRadius?: number;
  frameWobble?: number;
}

export function makeVignetteUniforms(opts: VignetteOptions = {}): Uniforms {
  return {
    /**
     * THE FOREGROUND FLOOR WASH — see the header for why it exists and why it is here rather
     * than in the lighting rig or the grade.
     *
     * 0.58 is measured, not guessed: the shipped plaza frame reads ~0.66 sRGB luma across the
     * bottom third against ~0.32 on the building mass behind it. At 0.58 the wash takes that
     * band to ~0.44, which puts the floor BELOW the lit facades and just above the shadow side
     * of them — the ordering a comic page wants (busy midtone content, quiet dark foreground)
     * without flattening the ground into a second block of ink.
     */
    uFloorAmount: { value: opts.floorAmount ?? 0.58 },
    /**
     * Reaches 0.52 of the way up the frame and falls off quadratically from the bottom edge, so
     * it is essentially spent by the horizon line at a neutral pitch. Deliberately NOT tied to
     * the real horizon: a wash that tracked the camera would move every time the player looked
     * up, which is the one thing ART §4.1 forbids. This is a printed graduated filter.
     */
    uFloorHeight: { value: opts.floorHeight ?? 0.52 },
    /**
     * THE LUMINANCE WINDOW — `vec4(inLo, inHi, outLo, outHi)`, and it is what makes this a
     * colourist's flat rather than a brightness slider.
     *
     * It ramps IN over 0.26→0.52 so nothing already dark is touched: the viewmodel (a dark blob
     * low in the frame), every ink line, every crate shadow and the whole shadow half of the
     * street pass through untouched. It ramps OUT over 0.74→0.94 so the things that are *meant*
     * to be the brightest objects in the picture — practical pools, PAPER road markings, muzzle
     * flash — are not dimmed by the very pass that is supposed to make them read.
     */
    uFloorWindow: { value: new Vector4(0.26, 0.52, 0.74, 0.94) },
    /** Enrich before darkening: the floor goes violet-cool, not grey. Two tokens, ART §1. */
    uFloorTint: { value: tintVec(PALETTE.NIGHT_B, 0.34) },
    uFloorEdge: { value: srgbVec(PALETTE.INK) },
    /**
     * 0.62 → 0.72, inner 0.42 → 0.34. The panel closes further in and starts sooner. This is
     * the cheapest focus tool in the stack and it was set to "tasteful"; the brief is louder.
     * `uVigOuter` comes in 1.06 → 1.02 so the corners actually reach full strength on a 16:9
     * frame instead of running off the end of the ramp.
     */
    uVigAmount: { value: opts.amount ?? 0.72 },
    uVigInner: { value: opts.inner ?? 0.34 },
    uVigOuter: { value: opts.outer ?? 1.02 },
    /** 0.35 → 0.48: the falloff reads as warm light dying, and it needed to read harder. */
    uVigWarm: { value: tintVec(PALETTE.RUST, opts.warmAmount ?? 0.48) },
    uVigEdge: { value: srgbVec(PALETTE.INK) },
    uVigDamage: { value: 0 },
    uVigHot: { value: srgbVec(PALETTE.HOT) },
    uFrame: { value: 0 },
    uFrameWidth: { value: opts.frameWidth ?? 0.026 },
    uFrameMargin: { value: opts.frameMargin ?? 0.035 },
    uFrameRadius: { value: opts.frameRadius ?? 0.05 },
    uFrameWobble: { value: opts.frameWobble ?? 0.006 },
    // One hand-inked contour per beat. Written only by `Renderer.panelFrame()`, on the rising
    // edge. NEVER driven by a clock — see the header note.
    uFrameSeed: { value: new Vector3(0.31, 0.57, 0.83) },
    uFrameInk: { value: srgbVec(PALETTE.INK) },
    uFramePaper: { value: srgbVec(PALETTE.PAPER) },
  };
}

const DECLS = /* glsl */ `
  uniform float uFloorAmount;
  uniform float uFloorHeight;
  uniform vec4 uFloorWindow;
  uniform vec3 uFloorTint;
  uniform vec3 uFloorEdge;
  uniform float uVigAmount;
  uniform float uVigInner;
  uniform float uVigOuter;
  uniform vec3 uVigWarm;
  uniform vec3 uVigEdge;
  uniform float uVigDamage;
  uniform vec3 uVigHot;
  uniform float uFrame;
  uniform float uFrameWidth;
  uniform float uFrameMargin;
  uniform float uFrameRadius;
  uniform float uFrameWobble;
  uniform vec3 uFrameSeed;
  uniform vec3 uFrameInk;
  uniform vec3 uFramePaper;
`;

const BODY = /* glsl */ `
  /** Signed distance to a rounded box. Negative inside. */
  float czSdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  /**
   * THE FOREGROUND FLOOR WASH. Runs FIRST, before the vignette darkens on top of it, so the
   * two compose the way a colourist stacks flats: the floor sits back, then the panel edge
   * closes in around what is left.
   *
   * Everything here is a pure function of uv, gl_FragCoord and the pixel's own colour.
   * There is no clock, no seed, no depth fetch and no neighbourhood sample — ART §4.1 is not
   * "respected" by this function, it is unrepresentable in it.
   */
  vec3 czFloorWash(vec3 c, vec2 uv) {
    // 1 at the bottom edge → 0 at uFloorHeight, squared so the transition has no visible
    // shoulder where it meets the middle of the frame.
    float h = 1.0 - smoothstep(0.0, max(uFloorHeight, 0.01), uv.y);
    h *= h;
    if (h < 0.002) return c;

    float l = czLum(c);
    // Bite on the mid-bright empty tarmac; release on the darks and on the true highlights.
    float w = smoothstep(uFloorWindow.x, uFloorWindow.y, l)
            * (1.0 - smoothstep(uFloorWindow.z, uFloorWindow.w, l));

    /**
     * ART §9 — THE RESERVED CHANNEL IS NEVER DIMMED.
     *
     * ACID is the enemy hue and the squint probe measured green dominance at 0.000 for every
     * environment cell in every frame tested, so g - max(r,b) is an exact, free enemy mask in
     * display space — no extra render, no layer, no depth. A zombie standing on the near ground
     * keeps its value while the ground under it goes down, which is the opposite of swallowing
     * it: the wash *raises* its contrast against the floor. (HOT specials are deliberately not
     * masked here — red dominance would also catch the sodium practicals, the RUST fire and the
     * warm tarmac itself, which is most of the surface this pass exists to darken.)
     */
    float acid = clamp((c.g - max(c.r, c.b)) * 5.0, 0.0, 1.0);

    float amt = h * w * uFloorAmount * (1.0 - 0.9 * acid);
    // The grade has already posterised to ~24 levels, so a smooth multiply across a large flat
    // would print as a stair. Break the ramp on the page's OWN ordered screen — spatial only,
    // identical every frame, no temporal dither anywhere near this (§4.1 table, row 4).
    amt *= 1.0 + (czBayer8(gl_FragCoord.xy) - 0.5) * 0.14;

    // Enrich, then darken. A ground that just loses value goes grey and dead; pushing it toward
    // the connective violet first is what makes it read as a shadow flat instead of a fade.
    c *= mix(vec3(1.0), uFloorTint, clamp(amt * 1.35, 0.0, 1.0));
    c = mix(c, uFloorEdge, amt * 0.46);
    return c;
  }

  vec3 czVignette(vec3 c, vec2 uv) {
    vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
    float corner = 0.5 * sqrt(uAspect * uAspect + 1.0);
    float r = length(p) / corner;

    // ── foreground floor wash ───────────────────────────────────────────────
    if (uFloorAmount > 0.001) c = czFloorWash(c, uv);

    // ── warm vignette ───────────────────────────────────────────────────────
    float v = smoothstep(uVigInner, uVigOuter, r) * uVigAmount;
    // Tint before darkening: the falloff is warm light dying, not grey being added.
    c *= mix(vec3(1.0), uVigWarm, v * 0.85);
    c = mix(c, uVigEdge, v * v * 0.85);

    // Damage state rides the same ring, in HOT, with a dot screen so it prints.
    if (uVigDamage > 0.001) {
      float ring = smoothstep(0.28, 1.02, r);
      // The frame's own screen at its own plate angle — never an independent pitch (moiré).
      float d = czDots(gl_FragCoord.xy, ring * 0.9, 60.0, uScreenPitch);
      c = mix(c, uVigHot, ring * uVigDamage * (0.35 + 0.65 * d));
    }

    // ── panel frame ─────────────────────────────────────────────────────────
    if (uFrame > 0.001) {
      float m = uFrameMargin * uFrame;
      vec2 b = vec2(uAspect, 1.0) * 0.5 - m;
      float sd = czSdRoundBox(p, b, uFrameRadius * uFrame);

      // Hand-drawn contour, INKED ONCE. The phases come from uFrameSeed, which is re-rolled
      // on the rising edge of a beat and then held for the whole beat — so this panel has a
      // wobbly hand-drawn border and the NEXT panel has a different one, but neither of them
      // moves while it is on screen. ART §4.1: the print is fixed, only the drawing moves.
      // (uBoil is deliberately not referenced here. Do not put a clock back in this expression.)
      float along = (abs(p.x) > abs(p.y) ? p.y : p.x) * 9.0;
      float w1 = sin(along + uFrameSeed.x * 31.0) * 0.55;
      float w2 = sin(along * 2.37 + uFrameSeed.y * 47.0) * 0.28;
      float w3 = sin(along * 5.11 + uFrameSeed.z * 19.0) * 0.17;
      sd += (w1 + w2 + w3) * uFrameWobble * uFrame;

      float bw = uFrameWidth * uFrame;
      // 1 inside the ink border, 0 elsewhere. Antialiased with a 1-pixel ramp.
      float aa = uTexel.y * 1.5;
      float border = smoothstep(-aa, aa, sd) * (1.0 - smoothstep(bw - aa, bw + aa, sd));
      float gutter = smoothstep(bw - aa, bw + aa, sd);

      // A hard offset drop shadow just inside the frame — comic panel furniture.
      float inner = 1.0 - smoothstep(-bw * 1.9, -bw * 0.2, sd);
      c = mix(c, c * 0.55, inner * 0.5 * uFrame);

      c = mix(c, uFrameInk, border);
      // The gutter is paper with its own screen-tone, so it never reads as flat UI.
      float gd = czDots(gl_FragCoord.xy, 0.22, 15.0, uScreenPitch);
      c = mix(c, mix(uFramePaper, uFramePaper * 0.86, gd), gutter);
    }

    return c;
  }
`;

export function makeVignetteChunk(opts: VignetteOptions = {}): PassChunk {
  return {
    id: 'vignette',
    decls: DECLS,
    body: BODY,
    call: 'c = czVignette(c, uv);',
    uniforms: makeVignetteUniforms(opts),
  };
}

/** Standalone pass 8. */
export function makeVignettePass(common: CommonUniforms, opts: VignetteOptions = {}): {
  pass: ShaderPass;
  chunk: PassChunk;
} {
  const chunk = makeVignetteChunk(opts);
  return { pass: buildPass('ComicVignettePass', [chunk], common), chunk };
}

/**
 * PASS 8 — VIGNETTE + PANEL FRAME (ART_DIRECTION §4.8, §7)
 *
 * Two things:
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

import { Vector3 } from 'three';
import { PALETTE } from '@/art/palette';
import { buildPass, srgbVec, tintVec, type CommonUniforms, type PassChunk, type Uniforms } from './common';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export interface VignetteOptions {
  amount?: number;
  inner?: number;
  outer?: number;
  warmAmount?: number;
  frameWidth?: number;
  frameMargin?: number;
  frameRadius?: number;
  frameWobble?: number;
}

export function makeVignetteUniforms(opts: VignetteOptions = {}): Uniforms {
  return {
    uVigAmount: { value: opts.amount ?? 0.62 },
    uVigInner: { value: opts.inner ?? 0.42 },
    uVigOuter: { value: opts.outer ?? 1.06 },
    uVigWarm: { value: tintVec(PALETTE.RUST, opts.warmAmount ?? 0.35) },
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

  vec3 czVignette(vec3 c, vec2 uv) {
    vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
    float corner = 0.5 * sqrt(uAspect * uAspect + 1.0);
    float r = length(p) / corner;

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

/**
 * PASS 3 — HALFTONE / SCREEN-TONE (ART_DIRECTION §2.2, §4.3, §6)
 *
 * "The single most important signature of the style." Three things happen here, all of
 * them in SCREEN space with the dot pitch in PIXELS — the dots are printed on the page,
 * they are not painted on the objects, so they never scale with distance.
 *
 *   1. **Tone.** The shadow/luminance mask is filled with a rotated dot screen whose dot
 *      radius carries the value. The screen angle rotates 15° per luminance band, the way
 *      a colourist changes screens between tone levels, and a second finer screen is laid
 *      over the deepest darks — overlapping screens is what real print looks like.
 *      Highlights get an inverted "knockout" screen so bright areas dissolve too.
 *   2. **Banded ambient occlusion.** A cheap 6-tap depth AO, quantised to hard bands and
 *      *rendered as hatching dots* rather than a grey smear (ART_DIRECTION §2.5).
 *   3. **Distance fog as a colourist's wash.** Depth is quantised into flat bands between
 *      two palette colours, and the transition between bands is dithered with the same dot
 *      screen, so distant geometry dissolves into tone instead of showing a hard ring.
 *
 * The ink pass ahead of this one wrote its edge amount into ALPHA; the tone is masked out
 * of the linework so lines stay solid ink and never get chewed up by dots.
 *
 * Runs in LINEAR light. Sky pixels (raw depth == 1) are excluded from the fog.
 *
 * UNIFORMS
 *   tHtDepth              prepass DepthTexture
 *   uHtNear/uHtFar        camera planes
 *   uHtPitch              dot pitch in DRAWING-BUFFER pixels. Authored in CSS px on the quality
 *                         tier and converted by ComicPipeline — never write it directly, or the
 *                         dots shrink physically as the pixel ratio climbs.
 *   uHtAngle              base screen angle, degrees
 *   uHtStrength           master tone amount
 *   uHtLo / uHtHi         perceptual luminance window the tone occupies
 *   uHtInk                the colour the dots print in (LINEAR)
 *   uAoStrength           0 = off
 *   uAoRadius             AO sample radius in pixels at 1 m
 *   uAoRange              depth difference (m) that counts as fully occluded
 *   uAoBands              how many hard AO steps
 *   uFogColorNear/Far     the wash colours (LINEAR)
 *   uFogRange             vec2(startMetres, endMetres)
 *   uFogBands             number of flat fog steps
 *   uFogStrength          0 = off
 */

import { Vector2 } from 'three';
import { PALETTE } from '@/art/palette';
import { buildPass, linVec, type CommonUniforms, type PassChunk, type Uniforms } from './common';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Texture } from 'three';

export interface HalftonePassOptions {
  pitch?: number;
  angle?: number;
  strength?: number;
  lo?: number;
  hi?: number;
  ink?: number;
  ao?: number;
  aoRadius?: number;
  aoRange?: number;
  aoBands?: number;
  fogNear?: number;
  fogFar?: number;
  fogRange?: [number, number];
  fogBands?: number;
  fogStrength?: number;
}

export function makeHalftoneUniforms(opts: HalftonePassOptions = {}): Uniforms {
  return {
    tHtDepth: { value: null as Texture | null },
    uHtNear: { value: 0.1 },
    uHtFar: { value: 200 },
    uHtPitch: { value: opts.pitch ?? 6.6 },
    uHtAngle: { value: opts.angle ?? 15 },
    uHtStrength: { value: opts.strength ?? 0.9 },
    uHtLo: { value: opts.lo ?? 0.06 },
    uHtHi: { value: opts.hi ?? 0.62 },
    uHtInk: { value: linVec(opts.ink ?? PALETTE.INK) },
    uAoStrength: { value: opts.ao ?? 0.85 },
    uAoRadius: { value: opts.aoRadius ?? 26 },
    uAoRange: { value: opts.aoRange ?? 0.6 },
    uAoBands: { value: opts.aoBands ?? 3 },
    uFogColorNear: { value: linVec(opts.fogNear ?? PALETTE.NIGHT_B) },
    uFogColorFar: { value: linVec(opts.fogFar ?? PALETTE.NIGHT_A) },
    uFogRange: { value: new Vector2(opts.fogRange?.[0] ?? 34, opts.fogRange?.[1] ?? 150) },
    uFogBands: { value: opts.fogBands ?? 6 },
    uFogStrength: { value: opts.fogStrength ?? 0.30 },
  };
}

const DECLS = /* glsl */ `
  uniform sampler2D tHtDepth;
  uniform float uHtNear;
  uniform float uHtFar;
  uniform float uHtPitch;
  uniform float uHtAngle;
  uniform float uHtStrength;
  uniform float uHtLo;
  uniform float uHtHi;
  uniform vec3 uHtInk;
  uniform float uAoStrength;
  uniform float uAoRadius;
  uniform float uAoRange;
  uniform float uAoBands;
  uniform vec3 uFogColorNear;
  uniform vec3 uFogColorFar;
  uniform vec2 uFogRange;
  uniform float uFogBands;
  uniform float uFogStrength;
`;

const BODY = /* glsl */ `
  float czHtDepth(vec2 uv) {
    return czLinearDepth(texture2D(tHtDepth, uv).x, uHtNear, uHtFar);
  }

  vec3 czHalftone(vec3 c, vec2 uv, float lineMask) {
    vec2 frag = gl_FragCoord.xy;
    // Linework is solid ink — never let the screen-tone eat into it.
    float protect = 1.0 - clamp(lineMask, 0.0, 1.0);

    float raw = texture2D(tHtDepth, uv).x;
    float isSky = step(0.999999, raw);
    float depth = czLinearDepth(raw, uHtNear, uHtFar);

    // ── 2. banded AO, drawn as hatching ─────────────────────────────────────
    float ao = 0.0;
    if (uAoStrength > 0.001 && isSky < 0.5) {
      // Radius shrinks with distance so the AO covers a roughly constant world size.
      float rp = uAoRadius / (1.0 + depth * 0.55);
      vec2 r = max(rp, 1.0) * uTexel;
      float occ = 0.0;
      // Six taps on a hexagon whose orientation is a per-PIXEL constant, never a per-frame
      // one (ART §4.1). Build 001 rotated the whole kernel on the boil, which re-computed
      // the occlusion of every surface in the frame five times a second — a full-screen
      // per-frame random dressed up as hatching. The dither is now spatial only: the tap
      // ring is offset by an ordered Bayer value, so it is nailed to the page like the dots.
      float base = czBayer8(frag) * 1.0471976;
      for (int i = 0; i < 6; i++) {
        float a = base + float(i) * 1.0471976;
        vec2 o = vec2(cos(a), sin(a)) * r * (0.45 + 0.55 * czHash12(frag + float(i)));
        float ds = czHtDepth(uv + o);
        occ += clamp((depth - ds) / max(uAoRange, 0.01), 0.0, 1.0);
      }
      occ /= 6.0;
      // Hard bands, never a soft grey smear.
      ao = floor(clamp(occ, 0.0, 1.0) * uAoBands) / max(uAoBands, 1.0);
      ao *= uAoStrength * protect;
      // Plate angle: the four-colour set, never an arbitrary offset (see the note below).
      float aoDots = czDots(frag, ao * 1.15, uHtAngle + 60.0, uHtPitch * 1.25);
      c = mix(c, mix(c * 0.42, uHtInk, 0.45), aoDots * ao);
    }

    // ── 1. tone ─────────────────────────────────────────────────────────────
    //
    // ONE SCREEN FAMILY. Real print is four plates at 15° / 75° / 0° / 45° — those angles are
    // chosen precisely because they do NOT beat against each other. Arbitrary offsets (+52°,
    // +75°) at near-identical pitches produce moiré, and the build was stacking up to ten
    // such lattices per pixel: the result was a mechanical checkerboard weave on every
    // concrete column, not a colourist's screen-tone.
    float pl = sqrt(clamp(czLum(c), 0.0, 1.0));
    // The screen angle steps between plates per luminance band, like changing tone sheets.
    float band = floor(clamp(pl, 0.0, 0.999) * 3.0);
    float angle = uHtAngle + band * 15.0;

    float shadow = smoothstep(uHtHi, uHtLo, pl) * uHtStrength * protect;
    float coverage = clamp(1.0 - pl * 1.18, 0.0, 1.0);
    float d1 = czDots(frag, coverage, angle, uHtPitch);
    c = mix(c, mix(c * 0.44, uHtInk, 0.40), d1 * shadow);

    // A coarser second screen in the deepest darks — TWO overlapping screens is what real
    // print looks like. Two. Not five.
    float deep = smoothstep(uHtLo + 0.22, uHtLo, pl) * uHtStrength * protect;
    float d2 = czDots(frag, clamp(coverage * 1.2, 0.0, 1.0), angle + 60.0, uHtPitch * 2.0);
    c = mix(c, uHtInk, d2 * deep * 0.42);

    // ── 3. fog as a flat, banded, dot-dissolved wash ────────────────────────
    if (uFogStrength > 0.001) {
      float t = clamp((depth - uFogRange.x) / max(1.0, uFogRange.y - uFogRange.x), 0.0, 1.0);
      float steps = max(uFogBands, 1.0);
      float banded = floor(t * steps) / steps;
      float frac = fract(t * steps);
      float fd = czDots(frag, frac, uHtAngle + 45.0, uHtPitch * 1.5);
      float amt = clamp(banded + fd / steps, 0.0, 1.0) * uFogStrength * (1.0 - isSky);
      vec3 fogCol = mix(uFogColorNear, uFogColorFar, clamp(banded + fd / steps, 0.0, 1.0));
      c = mix(c, fogCol, amt);
    }

    return c;
  }
`;

export function makeHalftoneChunk(opts: HalftonePassOptions = {}): PassChunk {
  return {
    id: 'halftone',
    decls: DECLS,
    body: BODY,
    call: 'c = czHalftone(c, uv, srcA);',
    uniforms: makeHalftoneUniforms(opts),
  };
}

/** Standalone pass 3. */
export function makeHalftonePass(common: CommonUniforms, opts: HalftonePassOptions = {}): {
  pass: ShaderPass;
  chunk: PassChunk;
} {
  const chunk = makeHalftoneChunk(opts);
  return { pass: buildPass('ComicHalftonePass', [chunk], common), chunk };
}

/** Wire the prepass depth into a halftone chunk's uniforms. */
export function setHalftoneDepth(u: Uniforms, depth: Texture, near: number, far: number): void {
  (u.tHtDepth as { value: Texture | null }).value = depth;
  (u.uHtNear as { value: number }).value = near;
  (u.uHtFar as { value: number }).value = far;
}

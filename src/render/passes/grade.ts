/**
 * PASS 6 — COLOUR GRADE (ART_DIRECTION §4.6)
 *
 * The pass that decides whether the frame looks *printed* or looks *rendered*. It is also
 * the boundary of the pipeline's colour-space contract: everything before it works in
 * linear light, everything after it works in display-referred sRGB, and it owns the encode.
 *
 * ORDER INSIDE THE SHADER (this order matters as much as the pass order does):
 *   1. exposure, then a filmic shoulder so highlights roll instead of clipping flat
 *   2. linear → sRGB (from here on the numbers are ink density on paper)
 *   3. contrast S-curve about a 0.42 pivot, with a lifted, tinted black point — comics
 *      have no true black in the flats, the black lives in the linework
 *   4. saturation LIFT, then vibrance so the already-saturated palette does not clip
 *   5. split tone: shadows toward NIGHT_B, highlights toward GOLD/RUST
 *   6. POSTERIZE to ~24 levels per channel, dithered with an 8×8 Bayer screen so the
 *      quantisation reads as a printer's screen and not as banding
 *
 * UNIFORMS
 *   uGradeExposure    linear gain before the curve
 *   uGradeShoulder    filmic roll-off; higher = softer highlights
 *   uGradeContrast    S-curve slope about the pivot
 *   uGradePivot       the value the contrast rotates around
 *   uGradeLift        black-point lift (keeps flats off pure black)
 *   uGradeSaturation  global saturation multiplier (>1 — never desaturate toward mud)
 *   uGradeVibrance    extra push applied only to low-saturation pixels
 *   uGradeShadowTint  multiplicative tint at the dark end
 *   uGradeHighTint    multiplicative tint at the bright end
 *   uGradeLevels      posterize steps per channel (24 is the house value)
 *   uGradeDither      0 = hard posterize, 1 = full Bayer dither
 *   uGradeInk         the colour the lifted black point is tinted toward
 */

import { PALETTE } from '@/art/palette';
import { buildPass, srgbVec, tintVec, type CommonUniforms, type PassChunk, type Uniforms } from './common';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export interface GradeOptions {
  exposure?: number;
  shoulder?: number;
  contrast?: number;
  pivot?: number;
  lift?: number;
  saturation?: number;
  vibrance?: number;
  /** Palette token value the shadows are tinted toward. */
  shadowTint?: number;
  shadowTintAmount?: number;
  /** Palette token value the highlights are tinted toward. */
  highlightTint?: number;
  highlightTintAmount?: number;
  levels?: number;
  dither?: number;
}

export function makeGradeUniforms(opts: GradeOptions = {}): Uniforms {
  return {
    uGradeExposure: { value: opts.exposure ?? 1.22 },
    uGradeShoulder: { value: opts.shoulder ?? 1.55 },
    // A 1.24 S-curve about a 0.42 pivot crushes everything under the pivot toward zero, which
    // is the opposite of what this pass's own doc-comment asks for ("comics have no true black
    // in the flats"). Gentler curve, higher black point: the midtones survive, and the black
    // that is left belongs to the linework.
    uGradeContrast: { value: opts.contrast ?? 1.12 },
    uGradePivot: { value: opts.pivot ?? 0.42 },
    uGradeLift: { value: opts.lift ?? 0.14 },
    uGradeSaturation: { value: opts.saturation ?? 1.28 },
    uGradeVibrance: { value: opts.vibrance ?? 0.35 },
    uGradeShadowTint: {
      value: tintVec(opts.shadowTint ?? PALETTE.NIGHT_B, opts.shadowTintAmount ?? 0.16),
    },
    uGradeHighTint: {
      value: tintVec(opts.highlightTint ?? PALETTE.GOLD, opts.highlightTintAmount ?? 0.12),
    },
    uGradeLevels: { value: opts.levels ?? 24 },
    uGradeDither: { value: opts.dither ?? 0.85 },
    uGradeInk: { value: srgbVec(PALETTE.NIGHT_A) },
  };
}

const DECLS = /* glsl */ `
  uniform float uGradeExposure;
  uniform float uGradeShoulder;
  uniform float uGradeContrast;
  uniform float uGradePivot;
  uniform float uGradeLift;
  uniform float uGradeSaturation;
  uniform float uGradeVibrance;
  uniform vec3 uGradeShadowTint;
  uniform vec3 uGradeHighTint;
  uniform float uGradeLevels;
  uniform float uGradeDither;
  uniform vec3 uGradeInk;
`;

const BODY = /* glsl */ `
  vec3 czGrade(vec3 c) {
    c = max(c, vec3(0.0));

    // 1 — exposure + filmic shoulder (still linear).
    c *= uGradeExposure;
    c = c * (1.0 + c / (uGradeShoulder * uGradeShoulder)) / (1.0 + c);

    // 2 — into display space. Everything below is ink density on paper.
    c = czToSRGB(c);

    // 3 — contrast about the pivot, then lift the black point onto a cool near-black.
    //     Comics have no true black in the FLATS; the black lives in the linework.
    c = (c - uGradePivot) * uGradeContrast + uGradePivot;
    c = c * (1.0 - uGradeLift) + uGradeInk * uGradeLift;
    c = clamp(c, 0.0, 1.4);

    // 4 — saturation lift, then vibrance on whatever is still washed out.
    float l = czLum(c);
    c = mix(vec3(l), c, uGradeSaturation);
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float sat = mx - mn;
    c = mix(vec3(l), c, 1.0 + uGradeVibrance * (1.0 - clamp(sat * 1.6, 0.0, 1.0)));

    // 5 — split tone. Cool ink in the darks, warm press oil in the lights.
    float t = smoothstep(0.12, 0.86, l);
    c *= mix(uGradeShadowTint, uGradeHighTint, t);

    // 6 — posterize. The Bayer screen turns the quantisation into a printer's
    //     rosette instead of a banding artefact.
    c = clamp(c, 0.0, 1.0);
    float levels = max(uGradeLevels, 2.0);
    float dith = (czBayer8(gl_FragCoord.xy) - 0.5) * uGradeDither / levels;
    c = floor(c * levels + 0.5 + dith * levels) / levels;

    return clamp(c, 0.0, 1.0);
  }
`;

export function makeGradeChunk(opts: GradeOptions = {}): PassChunk {
  return {
    id: 'grade',
    decls: DECLS,
    body: BODY,
    call: 'c = czGrade(c);',
    uniforms: makeGradeUniforms(opts),
  };
}

/**
 * Standalone pass 6. NOTE: the grade owns the linear → sRGB encode, so it must always be
 * present in the stack. Turn its look down with the uniforms, never by removing the pass.
 */
export function makeGradePass(common: CommonUniforms, opts: GradeOptions = {}): {
  pass: ShaderPass;
  chunk: PassChunk;
} {
  const chunk = makeGradeChunk(opts);
  return { pass: buildPass('ComicGradePass', [chunk], common), chunk };
}

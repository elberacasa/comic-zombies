/**
 * PASS 7 — PAPER GRAIN (ART_DIRECTION §4.7)
 *
 * ~4% of animated newsprint fibre plus a fine CMYK dot noise. Small, and load-bearing:
 * it is the layer that stops every flat colour region from looking like a solid fill from
 * a vector program. Without it the posterized grade reads as "low colour depth"; with it,
 * the same image reads as "printed on cheap paper".
 *
 * The fibre texture comes from `art/textures.makeNewsprintTexture()` — a real procedural
 * paper with directional fibre and three misregistered CMYK screens baked in. It is tiled
 * 1:1 in screen pixels and it is **NAILED TO THE PAGE**.
 *
 * THE PAPER DOES NOT SHIMMER (ART §4.1). Build 001 jumped the fibre tile by a new offset on
 * every 12 fps boil step; a frame-difference audit put paper grain at 27.5% of pixels changed
 * per frame — twenty times more of the image than the boiling ink LINE, which is the one thing
 * that is actually allowed to move. Grain is a property of the sheet the panel is printed on.
 * The sheet is chosen once, when the press is set up, and then it holds still for the whole
 * session: the tile offset below is rolled once in JS and never touched again.
 *
 * Runs in DISPLAY space, after the grade.
 *
 * UNIFORMS
 *   tGrain          the newsprint texture
 *   uGrainAmount    fibre modulation depth (≈0.045 of signal at the default)
 *   uGrainMid       the texture's own mean luminance, so the modulation is signed
 *   uGrainScale     screen-pixels per texture pixel; 1.0 = one texel per screen pixel
 *   uGrainOffset    this session's fixed tile offset — a constant, not an animation
 *   uGrainCmyk      strength of the extra fine CMYK dot screens
 *   uGrainC/M/Y     the three screen colours (from the palette)
 */

import { NoColorSpace, SRGBColorSpace, Vector2, type Texture } from 'three';
import { PALETTE, color } from '@/art/palette';
import { makeNewsprintTexture } from '@/art/textures';
import { buildPass, srgbVec, type CommonUniforms, type PassChunk, type Uniforms } from './common';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export interface GrainOptions {
  amount?: number;
  scale?: number;
  jump?: number;
  cmyk?: number;
  /** Texture size. 512 is plenty; the tile is never magnified. */
  size?: number;
}

/**
 * Mean linear luminance of the newsprint texture. three uploads sRGB textures as
 * SRGB8_ALPHA8, so the sampler hardware-decodes them and the shader sees LINEAR values —
 * the mid point therefore has to be PAPER's linear luminance, not its sRGB byte value.
 */
function newsprintMid(): number {
  const c = color(PALETTE.PAPER);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

export function makeGrainUniforms(opts: GrainOptions = {}): Uniforms {
  const tex: Texture = makeNewsprintTexture(opts.size ?? 512);
  // Belt and braces: the pass depends on the sampler decoding to linear.
  if (tex.colorSpace !== SRGBColorSpace && tex.colorSpace !== NoColorSpace) {
    tex.colorSpace = SRGBColorSpace;
  }
  return {
    tGrain: { value: tex },
    // 0.55 against the newsprint's own ±9% variation lands near 5% of signal on an already
    // posterized image. 0.34 hits the ≈4% the header promises. Now that the fibre is STATIC
    // it can carry that weight comfortably: a still texture at 4% reads as paper, whereas the
    // same 4% re-seeded every frame read as sensor noise.
    uGrainAmount: { value: opts.amount ?? 0.34 },
    uGrainMid: { value: newsprintMid() },
    uGrainScale: { value: opts.scale ?? 1 },
    // Which patch of the sheet this session got. Rolled once; never animated.
    uGrainOffset: {
      value: new Vector2(Math.random(), Math.random()).multiplyScalar(opts.jump ?? 1),
    },
    uGrainCmyk: { value: opts.cmyk ?? 0.012 },
    /** Fine-screen pitch in drawing-buffer px. Driven by the pipeline to uHtPitch * 0.5. */
    uGrainPitch: { value: 3.3 },
    uGrainC: { value: srgbVec(PALETTE.ELECTRIC) },
    uGrainM: { value: srgbVec(PALETTE.HOT) },
    uGrainY: { value: srgbVec(PALETTE.GOLD) },
    uGrainTexSize: { value: opts.size ?? 512 },
  };
}

const DECLS = /* glsl */ `
  uniform sampler2D tGrain;
  uniform float uGrainAmount;
  uniform float uGrainMid;
  uniform float uGrainScale;
  uniform vec2 uGrainOffset;
  uniform float uGrainCmyk;
  uniform float uGrainPitch;
  uniform vec3 uGrainC;
  uniform vec3 uGrainM;
  uniform vec3 uGrainY;
  uniform float uGrainTexSize;
`;

const BODY = /* glsl */ `
  vec3 czGrain(vec3 c, vec2 uv) {
    vec2 frag = gl_FragCoord.xy;

    // One texel per screen pixel at a FIXED offset. The paper is the paper.
    vec2 guv = frag / max(uGrainTexSize * uGrainScale, 1.0) + uGrainOffset;
    vec3 g = texture2D(tGrain, guv).rgb;

    // Signed fibre: the paper's own ±9% variation, scaled to ~4% of the image.
    float f = czLum(g) / max(uGrainMid, 1e-4) - 1.0;
    c *= 1.0 + f * uGrainAmount;

    // Fine CMYK screens on top. ONE pitch — a clean harmonic (half) of the main screen — at
    // three plate angles from the classic set. Three unrelated pitches clustered around 4.7px
    // beat against the main screen and against each other, which is moiré, not print.
    // Multiply, never add — ink removes light from paper.
    if (uGrainCmyk > 0.0001) {
      float cmykPitch = max(2.0, uGrainPitch);
      float dc = czDots(frag, 0.42, 15.0, cmykPitch);
      float dm = czDots(frag, 0.42, 75.0, cmykPitch);
      float dy = czDots(frag, 0.42, 45.0, cmykPitch);
      vec3 screens = vec3(1.0)
        - (vec3(1.0) - uGrainC) * dc * uGrainCmyk
        - (vec3(1.0) - uGrainM) * dm * uGrainCmyk
        - (vec3(1.0) - uGrainY) * dy * uGrainCmyk;
      c *= clamp(screens, 0.0, 1.0);
    }

    return c;
  }
`;

export function makeGrainChunk(opts: GrainOptions = {}): PassChunk {
  return {
    id: 'grain',
    decls: DECLS,
    body: BODY,
    call: 'c = czGrain(c, uv);',
    uniforms: makeGrainUniforms(opts),
  };
}

/** Standalone pass 7. */
export function makeGrainPass(common: CommonUniforms, opts: GrainOptions = {}): {
  pass: ShaderPass;
  chunk: PassChunk;
} {
  const chunk = makeGrainChunk(opts);
  return { pass: buildPass('ComicGrainPass', [chunk], common), chunk };
}

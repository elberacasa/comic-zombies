/**
 * PASS 5 — CHROMATIC OFFSET / PRINT MISREGISTRATION (ART_DIRECTION §4.5)
 *
 * Two effects in one, because they are the same physical accident:
 *
 *   • **Misregistration.** A cheap four-colour press never lands the plates exactly on
 *     top of one another. A constant ~1 px offset of the red and cyan records, in a
 *     fixed direction, is the thing your eye reads as "printed on newsprint".
 *   • **Radial split.** On top of that, a 2–3 px RGB separation that ramps from zero at
 *     the optical centre to full at the corners, so the frame edges feel like a lens.
 *
 * Both scale in PIXELS, not in UV, so they are resolution independent. The whole thing is
 * driven up hard for a couple of frames on big beats (`renderer.flash`) — that is what
 * makes an explosion feel like it knocked the printing plates out of line.
 *
 * ONE OFFSET PER SESSION (ART §4.1). A press misregisters once, for the whole run — it does
 * not re-register between two frames of the same drawing. Build 001 wandered the plate offset
 * on the 12fps boil, which shifted the red and blue records of EVERY high-contrast edge in the
 * frame five times a second. The variance is now rolled once, in JS, at construction: each
 * session gets its own slightly-bad print run and then holds it dead still for ever.
 *
 * Runs in LINEAR light (before the grade). This chunk SAMPLES tDiffuse itself.
 *
 * UNIFORMS
 *   uChromaAmount   radial split at the corner, in pixels
 *   uChromaPower    how sharply the split ramps toward the edge (1 = linear, 2 = lazy)
 *   uChromaMisreg   constant plate offset, in pixels (vec2). Already carries this session's
 *                   variance — the shader never modifies it.
 *   uChromaBoil     retained so quality tiers can still zero/restore the effect; it is a
 *                   CONSTRUCTION-TIME variance amount, not a per-frame animation.
 */

import { Vector2 } from 'three';
import { buildPass, type CommonUniforms, type PassChunk, type Uniforms } from './common';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export interface ChromaticOptions {
  amount?: number;
  power?: number;
  misregistration?: [number, number];
  boil?: number;
}

export function makeChromaticUniforms(opts: ChromaticOptions = {}): Uniforms {
  const variance = opts.boil ?? 0.18;
  // Rolled ONCE. This is the whole "bad print run" — it never changes again.
  const jx = 1 + (Math.random() - 0.5) * 2 * variance;
  const jy = 1 + (Math.random() - 0.5) * 2 * variance;
  return {
    uChromaAmount: { value: opts.amount ?? 2.6 },
    uChromaPower: { value: opts.power ?? 1.7 },
    uChromaMisreg: {
      value: new Vector2(
        (opts.misregistration?.[0] ?? 0.85) * jx,
        (opts.misregistration?.[1] ?? -0.55) * jy,
      ),
    },
    uChromaBoil: { value: variance },
  };
}

const DECLS = /* glsl */ `
  uniform float uChromaAmount;
  uniform float uChromaPower;
  uniform vec2 uChromaMisreg;
`;

const BODY = /* glsl */ `
  vec3 czChromatic(sampler2D tex, vec2 uv) {
    vec2 d = uv - 0.5;
    // Aspect-correct the radius so the split is symmetric on ultrawide screens:
    // r == 1 exactly at the corners, whatever the aspect ratio.
    vec2 p = d * vec2(uAspect, 1.0);
    float r = clamp(length(p) / (0.5 * sqrt(uAspect * uAspect + 1.0)), 0.0, 1.0);
    float ramp = pow(r, uChromaPower);

    // The plate offset is a CONSTANT (ART §4.1). This session's variance was rolled once on
    // the CPU and baked into uChromaMisreg; nothing here is a function of time.
    vec2 misreg = uChromaMisreg;
    vec2 radial = d / max(length(d), 1e-4) * uChromaAmount * ramp;

    vec2 offR = (radial + misreg) * uTexel;
    vec2 offB = (-radial - misreg * 0.75) * uTexel;

    float cr = texture2D(tex, uv + offR).r;
    vec4 mid = texture2D(tex, uv);
    float cb = texture2D(tex, uv + offB).b;
    // Green stays put: it is the key plate everything else registers against.
    return vec3(cr, mid.g, cb);
  }
`;

export function makeChromaticChunk(opts: ChromaticOptions = {}): PassChunk {
  return {
    id: 'chromatic',
    decls: DECLS,
    body: BODY,
    call: 'c = czChromatic(tDiffuse, uv);',
    source: true,
    uniforms: makeChromaticUniforms(opts),
  };
}

/** Standalone pass 5. */
export function makeChromaticPass(common: CommonUniforms, opts: ChromaticOptions = {}): {
  pass: ShaderPass;
  chunk: PassChunk;
} {
  const chunk = makeChromaticChunk(opts);
  return { pass: buildPass('ComicChromaticPass', [chunk], common), chunk };
}

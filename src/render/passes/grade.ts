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
 * ═════════════════════════════════════════════════════════════════════════════════════════
 * THE PIVOT PASS — "BE LOUDER" (CLAUDE.md §1.5).
 *
 * Every uniform in this file already existed; the machinery was complete and the VALUES were
 * conservative. Contrast 1.12 about a 0.42 pivot and saturation 1.28 is a *correction*, not a
 * grade — it is what you dial in when you are afraid of the image. The reference (Skopje '83)
 * is loud, and a full-screen pass is the highest impact-per-line surface in the project, so
 * the numbers moved a long way in one step rather than creeping:
 *
 *     contrast   1.12 → 1.32     saturation  1.28 → 1.55     vibrance 0.35 → 0.48
 *     lift       0.14 → 0.085    exposure    1.22 → 1.16     pivot    0.42 → 0.44
 *
 * `uGradeSplit` is the only genuinely NEW uniform, and it exists because of an ownership
 * seam rather than a look decision: `render/pipeline.ts::applyEscalation` re-authors the two
 * tint VECTORS every round from its own `GRADE_SHADOW_TINT` / `GRADE_HIGH_TINT` constants, so
 * raising `shadowTintAmount` here would be silently reset the moment round 1 begins. An
 * EXPONENT on the assembled tint is not re-authored by anything, and because `tintVec`
 * normalises about its own mean, `pow()` amplifies the warm/cool LEAN without moving the
 * frame's overall brightness — which is exactly the property the tint vectors were built for.
 * ═════════════════════════════════════════════════════════════════════════════════════════
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
 *   uGradeSplit       EXPONENT on the COOL half of the split tone. 1 = the tint vector as
 *                     authored, >1 = a harder warm/cool separation at the same mean brightness.
 *   uGradeSplitWarm   fraction of uGradeSplit the WARM half takes. <1 for ART §9 — see below.
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
  /** Exponent on the assembled split tone. 1 = as authored, 2.4 is the house value. */
  split?: number;
  /** How much of `split` the WARM half is allowed to take. See the uniform's own note. */
  splitWarm?: number;
  levels?: number;
  dither?: number;
}

export function makeGradeUniforms(opts: GradeOptions = {}): Uniforms {
  return {
    /**
     * DOWN 1.22 → 1.16, and it is the only value in this file that moved toward *less*.
     * The largest single area of the frame is bright, empty ground; a louder contrast curve
     * rotates everything above the pivot further UP, so the ground had to lose a little
     * before the curve was allowed to push. `passes/vignette.ts::czFloorWash` does the rest.
     */
    uGradeExposure: { value: opts.exposure ?? 1.16 },
    uGradeShoulder: { value: opts.shoulder ?? 1.55 },
    /**
     * 1.12 → 1.32 about a pivot lifted 0.42 → 0.44.
     *
     * The old comment here argued a 1.24 curve "crushes everything under the pivot toward
     * zero" — true only because the black point was ALSO being lifted 0.14 onto a cool ink,
     * which is a second, redundant flattening. Contrast and lift were fighting each other.
     * Lift comes down to 0.085 (still nowhere near a true black: the flats bottom out on
     * `uGradeInk`, not on 0) and the curve is allowed to do its job.
     */
    uGradeContrast: { value: opts.contrast ?? 1.32 },
    uGradePivot: { value: opts.pivot ?? 0.44 },
    uGradeLift: { value: opts.lift ?? 0.085 },
    /**
     * 1.28 → 1.55, with vibrance 0.35 → 0.48 behind it. The palette is authored saturated and
     * the grade was giving most of that back. Vibrance carries the larger share of the
     * increase because it only touches pixels that are still washed out, which is exactly the
     * hazed distance `world/lighting.ts` now creates — aerial perspective should desaturate
     * by DEPTH, not leave the whole frame timid.
     */
    uGradeSaturation: { value: opts.saturation ?? 1.55 },
    uGradeVibrance: { value: opts.vibrance ?? 0.48 },
    uGradeShadowTint: {
      value: tintVec(opts.shadowTint ?? PALETTE.NIGHT_B, opts.shadowTintAmount ?? 0.16),
    },
    uGradeHighTint: {
      value: tintVec(opts.highlightTint ?? PALETTE.GOLD, opts.highlightTintAmount ?? 0.12),
    },
    /** See the header: the amounts above are re-authored per round, this exponent is not. */
    uGradeSplit: { value: opts.split ?? 2.4 },
    /**
     * THE WARM HALF GETS LESS OF IT, AND THE REASON IS ART §9, NOT TASTE.
     *
     * The two halves of the split are not symmetrical with respect to the reserved channel.
     * `NIGHT_B` (0x4d2e82) has green as its LOWEST channel, so amplifying the shadow tint
     * pushes green down and strictly helps the enemy channel. `GOLD` (0xffc531) has green
     * sitting *between* red and blue, so amplifying the highlight tint widens the yellow-vs-
     * violet spread across the frame — and while the per-pixel guard below stops any single
     * pixel gaining green dominance, a blurred CELL that averages a warmer yellow against a
     * cooler violet still drifts green, which is exactly what §9's squint test measures.
     *
     * Swept on the plaza, no enemies, strongest 48×27 cell. ART §9's bar is +0.005:
     *
     *     splitWarm 1.00  (warm exp 2.40)   +0.0275   FAIL — the whole warm half amplified
     *     splitWarm 0.70  (warm exp 1.98)   +0.0161   FAIL
     *     splitWarm 0.55  (warm exp 1.77)   +0.0083   FAIL
     *     splitWarm 0.45  (warm exp 1.63)   +0.0014   PASS  ← shipped
     *     splitWarm 0.00  (warm exp 1.00)   −0.0169   pass, and the warm split is thrown away
     *
     * 0.45 is the last value on the safe side with real margin, and the COOL half still takes
     * the full 2.4 — which is most of a night frame and most of what the split is for.
     *
     * So the shadow half — which is most of a night frame, and the half doing the "cool ink in
     * the darks" work — keeps the full push, and only the half that can manufacture the problem
     * is damped. `1 + (split - 1) * 0.45`.
     */
    uGradeSplitWarm: { value: opts.splitWarm ?? 0.45 },
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
  uniform float uGradeSplit;
  uniform float uGradeSplitWarm;
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
    //
    // The window widened 0.12–0.86 → 0.06–0.92 so the lean reaches the deep shadow and the
    // hot practical instead of stopping at the midtones, and the assembled tint is raised to
    // uGradeSplit. Both tint vectors come out of tintVec(), which normalises about its own
    // mean, so pow() steepens the warm/cool SEPARATION and leaves the mean where it was:
    // a channel at 1.09 becomes 1.23 while its partner at 0.93 becomes 0.84. Louder split,
    // same exposure. (See the header for why this is an exponent and not a bigger amount.)
    float dom0 = c.g - max(c.r, c.b);
    // Each half is raised on its own exponent and only then mixed — see uGradeSplitWarm for
    // why they are not symmetrical. Powering the two tints separately is also the more honest
    // operation: each end of the split keeps its own authored strength.
    float t = smoothstep(0.06, 0.92, l);
    float warm = 1.0 + (uGradeSplit - 1.0) * uGradeSplitWarm;
    vec3 cool = pow(max(uGradeShadowTint, vec3(0.004)), vec3(uGradeSplit));
    vec3 hot  = pow(max(uGradeHighTint,   vec3(0.004)), vec3(warm));
    c *= mix(cool, hot, t);

    /**
     * ART §9, AS AN OPERATOR CONSTRAINT: THE GRADE MAY NOT MANUFACTURE GREEN DOMINANCE.
     *
     * MEASURED, and this is the entire reason these six lines exist. The 48×27 squint probe on
     * the shipped plaza, no enemies present, strongest cell in the frame:
     *
     *     old grade                     −0.014   (no environment green anywhere — §9 holding)
     *     new grade, unguarded           +0.033   ← §9 VIOLATED, and by 6× its stated +0.005 bar
     *     new grade, this guard on       +0.004
     *
     * The mechanism is not saturation and not vibrance — both were isolated and neither moves
     * the number (dropping saturation back to 1.28 makes it WORSE, +0.042, because a more
     * neutral surface is more easily tipped). It is the split tone itself. GOLD is
     * 0xffc531: g 197 against b 49, so leaning highlights toward it lifts green while crushing
     * blue. At the authored 0.12 amount the gap is under half a percent and harmless; raised to
     * uGradeSplit the tint becomes ~(1.16, 1.05, 0.81), and any surface that happened to sit
     * with green between its red and blue — half the SLATE facades — comes out the far side
     * green-dominant. That is the enemy channel, being handed to the architecture, by the pass
     * that is supposed to be making enemies easier to see.
     *
     * Backing uGradeSplit off until the probe passes would fix this frame and nothing else:
     * the next agent to touch the tint colours, or the escalation riding GOLD → RUST, would
     * reintroduce it silently. So the constraint is stated instead of tuned — green dominance
     * may pass through this pass, it may not be CREATED by it. dom0 is the dominance the
     * pixel arrived with (floored at 0, so a neutral surface may not go positive at all); the
     * green channel is pulled back by however much the tint added beyond it.
     *
     * Enemies are unaffected by construction: an ACID body arrives with dom0 ~ +0.25, far
     * above anything the tint could add, so the correction term is zero on every pixel §9
     * actually cares about. Cost is 6 ALU and no branch.
     */
    float dom1 = c.g - max(c.r, c.b);
    c.g -= max(0.0, dom1 - max(dom0, 0.0));

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

/**
 * PASS 2 — THE INK EDGE (ART_DIRECTION §3, §4.2)
 *
 * Depth + normal Sobel-style edge detection over the prepass, composited as hand-drawn
 * ink over the scene colour. This is the *interior detail* half of the line work — the
 * silhouette half is the inverted-hull pass in `materials/index.ts`. Both are required.
 *
 * WHAT MAKES IT READ AS DRAWN RATHER THAN AS AN EDGE FILTER
 *   • **Thickness is modulated by depth.** The sample radius grows with distance so a
 *     zombie 60 m away keeps a bold contour instead of dissolving into a 1-px hairline.
 *   • **Creases fade, silhouettes don't.** Normal-derived edges (panel lines, folds) fall
 *     off with distance; depth-derived edges (contours) never do.
 *   • **Colour-holds line.** On bright surfaces the line picks up the surface hue — real
 *     comic printing never puts pure black on a hot red, it holds the line in a dark red.
 *   • **Boiling line.** The sample position is perturbed by low-frequency noise re-seeded
 *     at 12 fps (uBoil), not per frame. This single detail sells the style.
 *
 * THIS PASS IS THE ONE THING ALLOWED TO MOVE ON ITS OWN (ART §4.1) — AND ONLY IN THE NEAR
 * FIELD. The boil displaces the EDGE SAMPLING only: `scene` is read at the untouched uv, so
 * the wobble can only change pixels where the edge term or the silhouette rim is non-zero —
 * i.e. line art.
 *
 * **THE BOIL GATE (`boilGate`), added in the M1.5 fix pass.** The header used to claim
 * "~1.4% of the frame"; measured on the shipped 140 m arena it was 6.27 percentage points of
 * a 7.99% total, because this city is two orders of magnitude denser in linework than
 * whatever that number was taken against. Every window mullion, railing, kerb and catenary
 * wire in the frame was being re-inked five times a second, which is precisely the human's
 * "every pixel seems to be jumping like glitching" — and a nausea vector.
 *
 * An inker boils the HERO's contour; they do not re-draw the background city three times a
 * second. So the gate is `max(nearField * uInkBoilEnv, acidBoil)`:
 *   • the environment only boils within ~4 m and is fully printed by ~11 m, at 65% amplitude;
 *   • anything in the RESERVED ACID/HOT channel — i.e. an enemy, ART §9 — boils at full
 *     amplitude at any distance, because high-frequency motion is the enemies' channel.
 *
 * Do not raise `uInkBoil` past a fraction of a pixel and never give the boil a full-screen
 * consumer. The acceptance test is ART §4.1: camera parked, two frames five sim steps apart,
 * ≤0.5% of pixels changed.
 *
 * The pass writes the edge amount into ALPHA, so the halftone pass that follows can
 * protect the linework from being dotted over. Nothing else uses that alpha.
 *
 * UNIFORMS
 *   tNormal          view-space normals from the prepass, packed n*0.5+0.5
 *   tDepth           the prepass DepthTexture
 *   uInkNear/Far     camera planes, for depth linearisation
 *   uInkColor        line colour (LINEAR) — INK
 *   uInkStrength     master opacity/width knob (RenderService.inkStrength)
 *   uInkThickness    base sample radius in screen pixels at the near plane
 *   uInkDepthSense   sensitivity of the depth term (silhouettes/contacts)
 *   uInkNormalSense  sensitivity of the normal term (creases/panel lines)
 *   uInkThreshold    edge cut-in point; uInkSoftness the width of that ramp
 *   uInkColorHold    0 = pure ink, 1 = the line fully takes the surface hue
 *   uInkBoil         hand-drawn wobble amplitude, in pixels
 *   uInkFarFade      distance (m) over which crease detail fades out
 *
 * ── ADDED IN THE M1 FIX PASS ─────────────────────────────────────────────────────────────
 *
 * **WEIGHT VARIATION** — the difference between a drawn line and a Sobel filter. A constant
 * stroke reads as "detected"; real ink is heavy on the shadow side of a form, heavy where it
 * meets the ground, and tapers to nothing on the lit side. Three modulations of the sample
 * radius do that here:
 *   • light-direction weighting  — `uInkWeightShadow` on the unlit side, `uInkWeightLit` on
 *     the lit side, keyed off the prepass normal against the view-space key direction;
 *   • contact weighting          — the NEAR side of a depth discontinuity widens by
 *     `uInkContact`, so props gain a heavy ground-contact contour;
 *   • width boil                 — a second, lower-frequency wobble on the RADIUS, so the
 *     stroke breathes in weight and not only in position.
 *
 * **SCREEN-SPACE RIM** — the material's Fresnel rim cannot draw an edge on flat-shaded boxes
 * (constant face normals ⇒ a per-face constant, so it floods faces instead of edging them).
 * The rim therefore lives HERE, keyed off the same depth discontinuity the edge term already
 * computes: a fragment whose neighbours are FURTHER away is on the near side of a silhouette.
 * It is gated by the view-space rim direction so only back-lit edges light up, banded hard so
 * it reads as a drawn edge light, and composited BEFORE the ink so the line draws on top.
 *
 *   uInkKeyDirView   view-space key direction   (written per frame by the renderer)
 *   uInkRimDirView   view-space rim direction   (written per frame by the renderer)
 *   uInkRimColor     rim hue (LINEAR) — ELECTRIC
 *   uInkRimStrength  master rim amount
 *   uInkRimWidth     silhouette tap radius in px, independent of the edge radius
 *   uInkWeightLit / uInkWeightShadow / uInkContact / uInkBoilWidth   see above
 */

import { Vector3 } from 'three';
import { PALETTE } from '@/art/palette';
import { buildPass, linVec, type CommonUniforms, type PassChunk, type Uniforms } from './common';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Texture } from 'three';

export interface InkPassOptions {
  color?: number;
  thickness?: number;
  depthSensitivity?: number;
  normalSensitivity?: number;
  threshold?: number;
  softness?: number;
  colorHold?: number;
  boil?: number;
  farFade?: number;
  /** Screen-space rim light. */
  rimColor?: number;
  rimStrength?: number;
  rimWidth?: number;
  /** Stroke weight on the lit / shadow side of a form. */
  weightLit?: number;
  weightShadow?: number;
  /** Extra weight on the near side of a depth discontinuity (ground contact). */
  contact?: number;
  /** Low-frequency wobble on the stroke WIDTH. */
  boilWidth?: number;
  /** Fraction of the boil the environment keeps (0..1). Enemies always boil in full. */
  boilEnv?: number;
  /**
   * The RESERVED-CHANNEL rim (ART §9). Where the scene colour under a silhouette is already
   * green-dominant — which, because ACID/HOT are reserved, can only be an enemy — the rim is
   * tinted to `enemyRimColor` and boosted by `enemyRimStrength`. That makes the always-on
   * enemy rim a real screen-space edge instead of a per-face Fresnel that flat-shaded
   * geometry cannot draw (see the SCREEN-SPACE RIM note above).
   */
  enemyRimColor?: number;
  enemyRimStrength?: number;
}

export function makeInkUniforms(opts: InkPassOptions = {}): Uniforms {
  return {
    tNormal: { value: null as Texture | null },
    tDepth: { value: null as Texture | null },
    uInkNear: { value: 0.1 },
    uInkFar: { value: 200 },
    uInkColor: { value: linVec(opts.color ?? PALETTE.INK) },
    uInkStrength: { value: 1 },
    uInkThickness: { value: opts.thickness ?? 1.35 },
    uInkDepthSense: { value: opts.depthSensitivity ?? 4.5 },
    uInkNormalSense: { value: opts.normalSensitivity ?? 1.35 },
    uInkThreshold: { value: opts.threshold ?? 0.18 },
    uInkSoftness: { value: opts.softness ?? 0.28 },
    uInkColorHold: { value: opts.colorHold ?? 0.55 },
    /**
     * THE BOIL AMPLITUDE, in pixels — and the single most nausea-relevant number in this
     * file. 2.2 px in build 001 (wider than the stroke itself), 0.9 px in build 002, and
     * **0.3 px now**. Together with the near-field gate below, the ink boil's contribution
     * to the §4.1 parked-camera diff falls from 6.27 points to a fraction of one.
     * `CZ.renderer.pipeline.u('uInkBoil').value` if you want to find your own number.
     */
    /*
     * 0.12, NOT 0.3. Measured, not guessed: with the scene fully settled, zero enemies and the
     * camera parked at a 2268x1315 buffer (an ordinary Retina window), 0.3 put the §4.1 stillness
     * test at mean 0.547% / max 0.657% — over the 0.5% cap. A sweep of 1.0 / 0.75 / 0.55 / 0.40x
     * gave max 0.657 / 0.605 / 0.569 / 0.453, so 0.40x is the first value that clears it on PEAKS
     * as well as on the mean. The DPI falloff in `pipeline.applyBoilScale()` cannot get there on
     * its own — it keys on buffer HEIGHT, so at 1315 px it only scales to 0.921 and would need an
     * exponent near 18 to reach 0.40, which is a cliff, not a curve. The amplitude was simply too
     * high; the falloff still handles genuinely huge buffers on top of this.
     */
    uInkBoil: { value: opts.boil ?? 0.12 },
    uInkFarFade: { value: opts.farFade ?? 42 },
    // ── weight variation ─────────────────────────────────────────────────────
    uInkWeightLit: { value: opts.weightLit ?? 0.45 },
    uInkWeightShadow: { value: opts.weightShadow ?? 1.6 },
    uInkContact: { value: opts.contact ?? 0.8 },
    /** Weight breathing on the contour. Same reasoning as uInkBoil, and near-field gated too. */
    uInkBoilWidth: { value: opts.boilWidth ?? 0.028 },
    /**
     * How much of the boil the ENVIRONMENT is allowed to keep inside the near-field
     * gate. Enemies always get 1.0 (see the acid term in BODY). Turn this to 0 and the
     * city is inked dead-still — which is a legitimate accessibility setting, and is
     * what a COMFORT preset should do with it.
     *
     * MEASURED (ART §4.1, camera parked, 2880×1315, two frames one boil step apart):
     * at 0.65 the worst authored pose (plaza-N) was 0.527% — over budget. At 0.45 the
     * sweep is spawn 0.05% · plaza-N 0.19% · street-x25 0.30%*  · roof-ne 0.09% ·
     * arcade-west 0.12% · ring-lane 0.03%, against a 0.5% budget and a 7.99% baseline.
     * (* street-x25 measured at 0.65; it scales down with this number.)
     */
    uInkBoilEnv: { value: opts.boilEnv ?? 0.45 },
    // ── screen-space rim ─────────────────────────────────────────────────────
    uInkKeyDirView: { value: new Vector3(0, 0, 1) },
    uInkRimDirView: { value: new Vector3(0, 0, 1) },
    uInkRimColor: { value: linVec(opts.rimColor ?? PALETTE.ELECTRIC) },
    /**
     * 0.9 → 0.5. At 0.9 with a downward-only luminance gate the rim was STRONGEST on the
     * darkest surfaces, so a dark interior turned into a cyan wireframe overlay — every
     * kerb, pipe and railing rimmed at close to enemy strength, which is also a direct
     * ART §9 violation. The gate is a band-pass now (see BODY) and the master is halved.
     */
    uInkRimStrength: { value: opts.rimStrength ?? 0.5 },
    uInkRimWidth: { value: opts.rimWidth ?? 2.5 },
    /** ART §9 reserved channel — see InkPassOptions.enemyRimColor. */
    uInkEnemyRimColor: { value: linVec(opts.enemyRimColor ?? PALETTE.ACID) },
    uInkEnemyRimStrength: { value: opts.enemyRimStrength ?? 2.6 },
  };
}

const DECLS = /* glsl */ `
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform float uInkNear;
  uniform float uInkFar;
  uniform vec3 uInkColor;
  uniform float uInkStrength;
  uniform float uInkThickness;
  uniform float uInkDepthSense;
  uniform float uInkNormalSense;
  uniform float uInkThreshold;
  uniform float uInkSoftness;
  uniform float uInkColorHold;
  uniform float uInkBoil;
  uniform float uInkFarFade;
  uniform float uInkWeightLit;
  uniform float uInkWeightShadow;
  uniform float uInkContact;
  uniform float uInkBoilWidth;
  uniform float uInkBoilEnv;
  uniform vec3 uInkKeyDirView;
  uniform vec3 uInkRimDirView;
  uniform vec3 uInkRimColor;
  uniform float uInkRimStrength;
  uniform float uInkRimWidth;
  uniform vec3 uInkEnemyRimColor;
  uniform float uInkEnemyRimStrength;
`;

const BODY = /* glsl */ `
  float czEdgeOut;

  float czVN2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = czHash12(i);
    float b = czHash12(i + vec2(1.0, 0.0));
    float c0 = czHash12(i + vec2(0.0, 1.0));
    float d0 = czHash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c0, d0, f.x), f.y);
  }

  float czDepthAt(vec2 uv) {
    return czLinearDepth(texture2D(tDepth, uv).x, uInkNear, uInkFar);
  }
  vec3 czNormalAt(vec2 uv) {
    return normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0);
  }

  vec3 czInk(sampler2D tex, vec2 uv) {
    vec4 src = texture2D(tex, uv);
    vec3 scene = src.rgb;

    // ── THE UNWOBBLED READ — lighting, and everything that is not a stroke ──
    // The depth/normal at the TRUE fragment. The rim light, the stroke-weight lighting
    // term and the contact probe all read from here, because none of them is line art:
    // dragging a lamp around on the 12fps boil repaints a wide band down every silhouette
    // in the frame, which measured at ~9.7% of all pixels — seven times the ink itself.
    float dC0 = czDepthAt(uv);
    vec3 nC0 = czNormalAt(uv);

    // ── THE BOIL GATE — the whole §4.1 fix ──────────────────────────────────
    // Two terms, and they are ART §4.1 and ART §9 respectively.
    //
    // boilNear: only what you are standing next to is allowed to boil at all. Past ~11 m
    // the stroke is PRINTED and stays printed, so a parked camera looking down a 140 m
    // street of window mullions produces a frozen frame. Measured at spawn: gating at
    // 9→18 m left 0.43–0.67% of the frame moving; 4→11 m lands it inside the 0.5% budget
    // with the wobble still plainly visible on anything within arm's reach.
    //
    // acidBoil: §9 reserves high-frequency motion to ENEMIES. ACID/HOT are reserved hues, so
    // green dominance in the scene colour is a sufficient enemy mask — and an enemy boils
    // at FULL amplitude at any distance, which is what "the inker boils the hero's contour"
    // actually means. The environment only ever gets the quiet near-field remainder.
    float boilNear = (1.0 - smoothstep(4.0, 11.0, dC0)) * uInkBoilEnv;
    float acidBoil = clamp((scene.g - max(scene.r, scene.b)) * 5.0, 0.0, 1.0);
    float boilGate = max(boilNear, acidBoil);

    // ── SILHOUETTE PROBE ────────────────────────────────────────────────────
    // Four taps at their own radius. A fragment whose diagonal neighbours are FURTHER
    // than the plane through them is on the NEAR side of a depth discontinuity — i.e. it
    // is the silhouette itself, not the background behind it. Second-derivative form, so
    // a grazing floor (an enormous but perfectly linear depth slope) never fires.
    vec2 rr = max(uInkRimWidth, 1.0) * uTexel;
    float sTL = czDepthAt(uv + vec2(-rr.x, -rr.y));
    float sTR = czDepthAt(uv + vec2( rr.x, -rr.y));
    float sBL = czDepthAt(uv + vec2(-rr.x,  rr.y));
    float sBR = czDepthAt(uv + vec2( rr.x,  rr.y));
    float nearer = max((sTL + sBR) * 0.5 - dC0, (sTR + sBL) * 0.5 - dC0);
    float nearerMask = smoothstep(0.02, 0.06, nearer / max(dC0 * 0.5 + 0.5, 0.5));

    // ── THE BOILING LINE — the only displaced read in the whole renderer ────
    // The EDGE neighbourhood, and nothing else, is nudged by low-frequency noise that
    // changes 12 times a second, so the contour wobbles like animated ink. Because only
    // the edge taps move, the only pixels that can change on a boil step are pixels the
    // stroke is drawn into or out of — line art, exactly as ART §4.1 requires.
    vec2 wob = vec2(
      czVN2(uv * 6.0 + uBoil.xy * 17.0),
      czVN2(uv * 6.0 + uBoil.yz * 17.0 + 41.7)) - 0.5;
    vec2 wobOff = wob * uInkBoil * boilGate * uTexel * 2.0;
    vec2 suv = uv + wobOff;

    float dC = czDepthAt(suv);
    float dn = clamp(dC / uInkFar, 0.0, 1.0);

    // ── STROKE WEIGHT ───────────────────────────────────────────────────────
    // Thickness in SCREEN pixels, widened with distance so far contours stay bold.
    float radius = max(1.0, uInkThickness * mix(1.0, 2.0, sqrt(dn)) * mix(0.75, 1.35, uInkStrength));
    // Heavy on the shadow side of a form, tapering to nothing on the lit side. This is the
    // single thing that separates a drawn contour from an edge-detect.
    float lit = max(dot(nC0, uInkKeyDirView), 0.0);
    radius *= mix(uInkWeightShadow, uInkWeightLit, smoothstep(0.04, 0.72, lit));
    // Contact weight: where a form sits in front of something else, the line thickens.
    radius *= 1.0 + uInkContact * nearerMask;
    // Never sample at a sub-pixel radius. Below ~1 px the four taps land inside the same
    // texel as the centre, the Laplacian collapses to numerical noise, and the line
    // flickers on and off along its own length as the camera moves — the "sub-pixel-thin
    // ink lines that flicker" in the playtest notes. One pixel is the floor for a filter
    // that is trying to detect a discontinuity.
    radius = max(radius, 1.0);
    // The CREASE radius is the steady one. The CONTOUR radius additionally breathes in
    // width on the 12fps boil, so the brush line varies in weight as well as position.
    vec2 rn = radius * uTexel;
    float radiusD = max(radius * (1.0 + (czVN2(uv * 2.5 + uBoil.zx * 13.0) - 0.5) * uInkBoilWidth * boilGate), 1.0);
    vec2 r = radiusD * uTexel;

    // Roberts-cross on the diagonals: 4 taps, diagonal-aware, cheap.
    // THESE are the taps that boil — depth edges are CONTOURS, the brush line a hand draws
    // around a form, and ART §3 gives the wobble to the silhouette specifically.
    float dTL = czDepthAt(suv + vec2(-r.x, -r.y));
    float dTR = czDepthAt(suv + vec2( r.x, -r.y));
    float dBL = czDepthAt(suv + vec2(-r.x,  r.y));
    float dBR = czDepthAt(suv + vec2( r.x,  r.y));

    // SECOND derivative, not first. A plain gradient fires on every receding surface —
    // a floor seen at a grazing angle has an enormous depth slope and would ink itself
    // solid black toward the horizon. The Laplacian is exactly zero on any flat surface
    // at any angle, and only responds to genuine discontinuities and depth creases.
    float lap1 = abs(dTL + dBR - 2.0 * dC);
    float lap2 = abs(dTR + dBL - 2.0 * dC);
    // Relative: a 10 cm step 2 m away is an edge, the same step at 80 m is not.
    float edgeD = (lap1 + lap2) / max(dC * 0.5 + 0.5, 0.5);

    // ── INTERIOR DETAIL — the pen work, and it does NOT boil ────────────────
    // An inker wobbles the brush contour of a form. They do not re-draw every window
    // mullion, brick course and panel line three times a second. Practically, this arena is
    // mostly interior detail: boiling the crease term as well was re-printing ~7% of the
    // whole frame on every boil step, which is a full order of magnitude past "subtle
    // enough that you feel it rather than see it". Creases now sample the TRUE uv at the
    // steady radius, so a still camera holds them perfectly.
    vec3 nTL = czNormalAt(uv + vec2(-rn.x, -rn.y));
    vec3 nTR = czNormalAt(uv + vec2( rn.x, -rn.y));
    vec3 nBL = czNormalAt(uv + vec2(-rn.x,  rn.y));
    vec3 nBR = czNormalAt(uv + vec2( rn.x,  rn.y));
    float edgeN = max(1.0 - dot(nTL, nBR), 1.0 - dot(nTR, nBL));
    // Creases are interior detail — they belong to close-up drawing, not to the
    // background wash. Fade them out with distance; contours never fade.
    edgeN *= 1.0 - smoothstep(uInkFarFade * 0.35, uInkFarFade, dC0);

    float edge = edgeD * uInkDepthSense + edgeN * uInkNormalSense;
    edge = smoothstep(uInkThreshold, uInkThreshold + uInkSoftness, edge);
    edge = clamp(edge * uInkStrength, 0.0, 1.0);

    // ── SCREEN-SPACE RIM LIGHT ──────────────────────────────────────────────
    // The third lamp of the rig, drawn where it can actually be seen: on the near side of
    // a silhouette, gated to the back-lit facing so it never becomes an outline glow.
    // Additive and BEFORE the ink mix, so the line still draws over the top of it.
    // Reads the UNWOBBLED normal: a light does not boil (§4.1).
    float rimFace = smoothstep(-0.10, 0.50, dot(nC0, uInkRimDirView));
    float rimAmt = nearerMask * rimFace * uInkRimStrength;
    // A BAND-PASS, not a downward gate. The old 1 - 0.6*smoothstep(0.30,1.0,lum) made the
    // rim STRONGEST on the darkest surfaces, so a 43%-sub-0.1 interior turned into a cyan
    // wireframe — every kerb and pipe rimmed at close to enemy strength, which reads as an
    // outline shader and breaks ART §9 as well. The rim now lives in the MIDTONES, which is
    // where an edge light is actually visible, and dies in the darks where ink already owns
    // the image.
    float rimLum = czLum(scene);
    rimAmt *= smoothstep(0.05, 0.18, rimLum) * (1.0 - 0.6 * smoothstep(0.30, 1.0, rimLum));

    // ── THE RESERVED CHANNEL (ART §9) — the always-on enemy rim ─────────────
    // ACID/HOT are reserved to enemies, so green dominance in the scene colour IS the enemy
    // mask: no environment surface in the arena is allowed to be green-dominant. Where the
    // silhouette sits on such a fragment the rim switches to ACID and is boosted, which is
    // how the recipe's "contrasting rim that never turns off" finally gets drawn — a
    // per-fragment Fresnel cannot edge flat-shaded geometry, but this probe can.
    // It costs one dot product and rides the silhouette mask the pass already computed.
    float acidness = clamp((scene.g - max(scene.r, scene.b)) * 5.0, 0.0, 1.0);
    vec3 rimCol = mix(uInkRimColor, uInkEnemyRimColor, acidness);
    // The enemy rim is NOT band-passed or luminance-gated: it never turns off, by contract.
    rimAmt = mix(rimAmt, nearerMask * uInkRimStrength * uInkEnemyRimStrength, acidness);
    scene += rimCol * rimAmt;

    // Colour-holds line: never pure black on a saturated surface (ART_DIRECTION §3).
    float pl = sqrt(clamp(czLum(scene), 0.0, 1.0));
    vec3 line = mix(uInkColor, uInkColor * 0.30 + min(scene, vec3(1.5)) * 0.55,
                    uInkColorHold * smoothstep(0.26, 0.85, pl));

    czEdgeOut = edge;
    return mix(scene, line, edge);
  }
`;

export function makeInkChunk(opts: InkPassOptions = {}): PassChunk {
  return {
    id: 'ink',
    decls: DECLS,
    body: BODY,
    call: 'c = czInk(tDiffuse, uv); srcA = czEdgeOut;',
    source: true,
    uniforms: makeInkUniforms(opts),
  };
}

/** Standalone pass 2. Feed it the prepass targets via `setInkSources`. */
export function makeInkPass(common: CommonUniforms, opts: InkPassOptions = {}): {
  pass: ShaderPass;
  chunk: PassChunk;
} {
  const chunk = makeInkChunk(opts);
  return { pass: buildPass('ComicInkPass', [chunk], common), chunk };
}

/**
 * Push the rig's key/rim directions into VIEW space for the screen-space rim. The prepass
 * writes view-space normals (MeshNormalMaterial), so both sides of every dot product have to
 * live there. Call once per frame from the renderer, which is the only thing that owns a camera.
 */
export function setInkViewDirs(u: Uniforms, keyView: Vector3, rimView: Vector3): void {
  (u.uInkKeyDirView as { value: Vector3 }).value.copy(keyView);
  (u.uInkRimDirView as { value: Vector3 }).value.copy(rimView);
}

/** Wire the normal/depth prepass into an ink chunk's uniforms. */
export function setInkSources(
  u: Uniforms,
  normals: Texture,
  depth: Texture,
  near: number,
  far: number,
): void {
  (u.tNormal as { value: Texture | null }).value = normals;
  (u.tDepth as { value: Texture | null }).value = depth;
  (u.uInkNear as { value: number }).value = near;
  (u.uInkFar as { value: number }).value = far;
}

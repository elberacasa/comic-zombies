/**
 * PASS 9 — OVERLAYS: SPEED LINES · IMPACT FLASH · LENS INK SPLATS (ART_DIRECTION §4.9, §5)
 *
 * The last thing on the page, and the loudest. Everything here is driven by a uniform,
 * decays on its own inside `RenderService`, and costs nothing when its uniform is zero.
 *
 *   • **Speed lines.** Radial screen-space lines drawn in the shader in a CIRCULAR field
 *     (aspect-corrected) so they stay radial on any monitor, and held off the centre of the
 *     screen so they never eat crosshair readability. The stroke set is FIXED for the
 *     session; intensity makes the strokes grow inward and cut in, so the motion comes from
 *     the ramp and not from re-randomising a full-screen effect (§4.1). Ramp them in on
 *     sprint / slide / dive and on big hits.
 *
 *   • **Impact flash.** The comic "flash frame". A one-frame push toward a colour — PAPER
 *     for a crit, HOT for damage taken, GOLD for a powerup. Mixed AND added, so it blooms
 *     out the whole frame rather than just washing it.
 *
 *   • **Lens ink splats.** Hand-drawn splat masks stuck to the "lens" as the damage
 *     indicator, biased toward the direction the damage came from, in blood-ink HOT over
 *     INK. Four instances at fixed positions with different rotations and scales. They do
 *     not drift: ink that has landed on the lens stays where it landed.
 *
 * Runs in DISPLAY space, after the grade. This is the last chunk in the stack.
 *
 * UNIFORMS
 *   tSpeed / tSplatA / tSplatB   procedural masks (white RGB + alpha)
 *   uOvSpeed        0..1 speed-line intensity
 *   uOvSpeedColor   line colour (INK for sprint, HOT for a big hit)
 *   uOvSpeedInner   radius the lines are held off the centre by
 *   uOvFlash        0..1 full-screen flash
 *   uOvFlashColor   flash colour
 *   uOvSplat        0..1 lens splat opacity
 *   uOvSplatDir     screen-space direction the damage came from
 *   uOvSplatColor   splat body colour
 *   uOvSplatRim     splat fringe colour
 */

import { Vector2 } from 'three';
import { PALETTE, hexMix } from '@/art/palette';
import { makeSplatSet } from '@/art/textures';
import { buildPass, srgbVec, type CommonUniforms, type PassChunk, type Uniforms } from './common';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Texture } from 'three';

export interface OverlayOptions {
  splatSize?: number;
  speedColor?: number;
  flashColor?: number;
  splatColor?: number;
  splatRim?: number;
  speedInner?: number;
  /** How many radial lines fill the frame. 120 is dense; 60 reads as a slow drift. */
  speedCount?: number;
  /** Colour of the accumulated plate soot. INK family — it is dirt, not a light. */
  sootColor?: number;
}

export function makeOverlayUniforms(opts: OverlayOptions = {}): Uniforms {
  // Splats are hand-drawn masks used at roughly their own scale — a texture is right.
  // Speed lines are NOT: a 512 px radial texture stretched to a 4K frame magnifies its
  // strokes ~10x into soft grey wedges. They are generated in the shader instead, which
  // is crisp at any resolution and lets every line re-draw itself on the 12 fps boil.
  const splats: Texture[] = makeSplatSet(2, opts.splatSize ?? 512, { spray: 0.55, drips: 4 });
  return {
    tSplatA: { value: splats[0] ?? null },
    tSplatB: { value: splats[1] ?? splats[0] ?? null },
    uOvSpeed: { value: 0 },
    uOvSpeedColor: { value: srgbVec(opts.speedColor ?? PALETTE.INK) },
    uOvSpeedInner: { value: opts.speedInner ?? 0.26 },
    uOvSpeedCount: { value: opts.speedCount ?? 120 },
    /** The stroke set for this session. Rolled once — never a per-frame re-seed (§4.1). */
    uOvSpeedSeed: { value: Math.floor(Math.random() * 97) },
    uOvFlash: { value: 0 },
    uOvFlashColor: { value: srgbVec(opts.flashColor ?? PALETTE.PAPER) },
    uOvSplat: { value: 0 },
    uOvSplatDir: { value: new Vector2(0, 0) },
    uOvSplatColor: { value: srgbVec(opts.splatColor ?? PALETTE.INK) },
    uOvSplatRim: { value: srgbVec(opts.splatRim ?? PALETTE.HOT) },
    /**
     * THE PAGE ACCUMULATES DAMAGE. Driven ONCE PER ROUND by the visual escalation
     * (`game/tuning.ts::VISUAL_ESCALATION.sootPeak`) and held perfectly still in between —
     * it is a pure function of `gl_FragCoord`, with no clock and no per-frame reseed, so a
     * parked camera produces a bit-identical frame (ART §4.1). 0 through the early rounds.
     */
    uOvSoot: { value: 0 },
    // INK pushed a fifth of the way to RUST: soot off a burning city, not a grey filter. Still
    // in the linework family, so it takes value out of the frame edge without inventing a hue.
    uOvSootColor: { value: srgbVec(opts.sootColor ?? hexMix(PALETTE.INK, PALETTE.RUST, 0.2)) },
  };
}

const DECLS = /* glsl */ `
  uniform sampler2D tSplatA;
  uniform sampler2D tSplatB;
  uniform float uOvSpeed;
  uniform vec3 uOvSpeedColor;
  uniform float uOvSpeedInner;
  uniform float uOvSpeedCount;
  uniform float uOvSpeedSeed;
  uniform float uOvFlash;
  uniform vec3 uOvFlashColor;
  uniform float uOvSplat;
  uniform vec2 uOvSplatDir;
  uniform vec3 uOvSplatColor;
  uniform vec3 uOvSplatRim;
  uniform float uOvSoot;
  uniform vec3 uOvSootColor;
`;

const BODY = /* glsl */ `
  float czSplatAt(sampler2D tex, vec2 p, vec2 pos, float rot, float scale) {
    vec2 q = czRot(p - pos, rot) / max(scale, 0.001) + 0.5;
    vec2 inR = step(vec2(0.0), q) * step(q, vec2(1.0));
    return texture2D(tex, q).a * inR.x * inR.y;
  }

  vec3 czOverlay(vec3 c, vec2 uv) {
    vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
    float corner = 0.5 * sqrt(uAspect * uAspect + 1.0);
    float rr = length(p) / corner;

    // ── speed lines: drawn, not sampled ─────────────────────────────────────
    if (uOvSpeed > 0.002) {
      float amt = clamp(uOvSpeed, 0.0, 1.0);
      float ang = atan(p.y, p.x);
      // Angular wedges, one line per wedge, each with its own hashed length, width and
      // phase — a FIXED set of strokes, drawn once and then only ramped.
      //
      // Build 001 re-seeded the whole set on the 12 fps boil. That is a full-screen effect
      // re-randomising itself five times a second, which ART §4.1 forbids outright ("boiling
      // line: outline geometry only, never a full-screen effect") — and it fires precisely
      // when the player is already sprinting, i.e. when the nausea budget is at its thinnest.
      // The animation now comes from uOvSpeed: strokes GROW inward from the frame edge and
      // more of them cut in as the intensity rises, which reads as acceleration instead of
      // as static. Nothing here is a function of time.
      float seed = uOvSpeedSeed;
      float count = max(uOvSpeedCount, 8.0);
      float a01 = ang * 0.1591549 + 0.5;
      float id = floor(a01 * count);
      float f = fract(a01 * count) - 0.5;
      float h1 = czHash12(vec2(id, seed));
      float h2 = czHash12(vec2(id, seed + 17.0));
      float h3 = czHash12(vec2(id, seed + 41.0));

      // Where the line starts, pulled toward the centre as the intensity rises.
      float start = mix(mix(0.95, 0.30, amt), mix(0.55, 0.05, amt), h1);
      // Half-width in wedge units, tapering to a point at the inner end.
      float w = mix(0.10, 0.44, h2 * h2);
      float grow = clamp((rr - start) / 0.42, 0.0, 1.0);
      float taper = w * grow;
      float line = 1.0 - smoothstep(taper * 0.55, taper, abs(f));
      line *= step(start, rr) * step(0.35, h3 + amt * 0.75);

      // Held off the centre: the crosshair area must never get busy.
      float ramp = smoothstep(uOvSpeedInner, min(uOvSpeedInner + 0.42, 1.0), rr);
      // The far ends dissolve into the frame's own screen — same lattice, own plate angle,
      // so it rosettes with the tone instead of beating against it.
      float diss = czDots(gl_FragCoord.xy, clamp((rr - 0.55) / 0.5, 0.0, 1.0) * 0.75, 30.0, uScreenPitch * 0.75);
      float mask = clamp(max(line, diss * smoothstep(0.62, 1.0, rr) * 0.7) * ramp * amt, 0.0, 1.0);
      c = mix(c, uOvSpeedColor, mask);
    }

    // ── lens ink splats (damage indicator) ──────────────────────────────────
    if (uOvSplat > 0.002) {
      // Bias every splat toward where the damage came from. The ink lands where it lands:
      // the drift that used to ride uBoilSmooth moved these masks EVERY frame while the
      // player was hurt — i.e. exactly when they are least able to tolerate it (§4.1).
      vec2 bias = uOvSplatDir * 0.30;
      vec2 drift = vec2(0.0);
      float s = 0.55 + 0.45 * uOvSplat;
      float a = 0.0;
      a = max(a, czSplatAt(tSplatA, p, vec2(-0.42,  0.20) * vec2(uAspect, 1.0) + bias + drift,  0.60, 0.52 * s));
      a = max(a, czSplatAt(tSplatB, p, vec2( 0.38, -0.16) * vec2(uAspect, 1.0) + bias - drift, -1.35, 0.44 * s));
      a = max(a, czSplatAt(tSplatA, p, vec2( 0.16,  0.34) * vec2(uAspect, 1.0) + bias * 0.6,    2.40, 0.34 * s));
      a = max(a, czSplatAt(tSplatB, p, vec2(-0.24, -0.32) * vec2(uAspect, 1.0) + bias * 0.8,    3.70, 0.30 * s));
      float body = smoothstep(0.30, 0.62, a);
      float fringe = smoothstep(0.06, 0.30, a) - body;
      c = mix(c, uOvSplatRim, clamp(fringe, 0.0, 1.0) * uOvSplat * 0.85);
      c = mix(c, uOvSplatColor, body * uOvSplat);
    }

    // ── accumulated plate soot (visual escalation) ──────────────────────────
    // A page that has been through fifteen rounds. Sparse hashed cells on a coarse harmonic of
    // the frame's OWN screen pitch, printed through the same czDots the whole stack uses — so
    // it rosettes with the tone instead of beating against it — and biased hard toward the
    // frame edge, where the vignette already lives, so the midtone band the consistency pass
    // recovered is left alone. Nothing in this block is a function of time.
    //
    // PLATE ANGLE 52.5°. The lattice repeats every 90°, not 180 (czDots screens with fract()
    // on a square grid), so the arena's families occupy 0/15/30/45/60/75 and the strays sit at
    // 7.5 (deck), 67.5 (glass) and 82.5 (enemy). 52.5 is the widest slot left.
    if (uOvSoot > 0.002) {
      float sootEdge = 0.24 + 0.76 * smoothstep(0.26, 1.02, rr);
      float pitch = max(2.0, uScreenPitch * 2.0);
      float cell = czHash12(floor(gl_FragCoord.xy / pitch));
      float speck = smoothstep(0.66, 0.90, cell);
      float grime = czDots(gl_FragCoord.xy, 0.58, 52.5, pitch);
      c = mix(c, uOvSootColor, clamp(speck * grime * sootEdge * uOvSoot, 0.0, 1.0));
    }

    // ── the flash frame — always last, always over everything ───────────────
    if (uOvFlash > 0.001) {
      float f = clamp(uOvFlash, 0.0, 1.0);
      c = mix(c, uOvFlashColor, f * 0.92);
      c += uOvFlashColor * f * 0.35;
    }

    return c;
  }
`;

export function makeOverlayChunk(opts: OverlayOptions = {}): PassChunk {
  return {
    id: 'overlay',
    decls: DECLS,
    body: BODY,
    call: 'c = czOverlay(c, uv);',
    uniforms: makeOverlayUniforms(opts),
  };
}

/** Standalone pass 9. */
export function makeOverlayPass(common: CommonUniforms, opts: OverlayOptions = {}): {
  pass: ShaderPass;
  chunk: PassChunk;
} {
  const chunk = makeOverlayChunk(opts);
  return { pass: buildPass('ComicOverlayPass', [chunk], common), chunk };
}

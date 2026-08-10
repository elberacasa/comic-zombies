/**
 * POST STACK — shared plumbing.
 *
 * Every pass in this folder is written twice over, from one source of truth:
 *
 *   • as a **chunk** (`PassChunk`) — GLSL uniform declarations, helper functions and a
 *     one-line call — so the pipeline can weld several cheap passes into a single
 *     fragment shader and save a full-screen render-target round trip per pass;
 *   • as a **standalone `ShaderPass`** — so any pass can be inserted, reordered,
 *     disabled or debugged on its own.
 *
 * Both share the *same uniform objects*, so `pipeline.u('uOvFlash').value = 1` drives the
 * pass whichever form it is currently living in.
 *
 * COLOUR SPACE CONTRACT (read this before touching a shader):
 *   passes 1–4 (scene, ink, halftone, bloom) work in LINEAR light;
 *   `grade.ts` converts to display-referred sRGB and everything after it — grain,
 *   vignette, overlays — works in that display space and is written to the canvas raw.
 *   No pass includes <colorspace_fragment>: the grade owns the encode.
 */

import { ShaderMaterial, Vector2, Vector3 } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { rgb8Hex, color } from '@/art/palette';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Uniform<T = unknown> { value: T }
export type Uniforms = Record<string, Uniform>;

export interface PassChunk {
  /** Stable id, used for the fused shader's comment banners. */
  readonly id: string;
  /** GLSL uniform declarations unique to this chunk. Shared globals are declared once. */
  readonly decls: string;
  /** GLSL helpers + the chunk's entry function. */
  readonly body: string;
  /** The call site, operating on `c` (vec3, display or linear per contract) and `uv`. */
  readonly call: string;
  /** True when this chunk samples tDiffuse itself and therefore initialises `c`. */
  readonly source?: boolean;
  /** Uniform objects, created once and shared between the fused and standalone forms. */
  readonly uniforms: Uniforms;
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour helpers — the palette is the only source of colour (ARCHITECTURE §1.7)
// ─────────────────────────────────────────────────────────────────────────────

/** Palette value as a LINEAR rgb vector — for passes that run before the grade. */
export function linVec(hex: number): Vector3 {
  const c = color(hex);
  return new Vector3(c.r, c.g, c.b);
}

/** Palette value as a DISPLAY-REFERRED (sRGB) rgb vector — for passes after the grade. */
export function srgbVec(hex: number): Vector3 {
  const [r, g, b] = rgb8Hex(hex);
  return new Vector3(r / 255, g / 255, b / 255);
}

/** Multiplicative tint that never leaves the palette's saturation range. */
export function tintVec(hex: number, amount: number): Vector3 {
  const v = srgbVec(hex);
  const m = (v.x + v.y + v.z) / 3 || 1;
  return new Vector3(
    1 + (v.x / m - 1) * amount,
    1 + (v.y / m - 1) * amount,
    1 + (v.z / m - 1) * amount,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared uniforms — one set per pipeline, referenced by every pass
// ─────────────────────────────────────────────────────────────────────────────

export interface CommonUniforms extends Uniforms {
  /** Drawing-buffer size in pixels. */
  uResolution: Uniform<Vector2>;
  /** 1 / uResolution. */
  uTexel: Uniform<Vector2>;
  /** width / height. */
  uAspect: Uniform<number>;
  /** Unscaled seconds since boot. */
  uTime: Uniform<number>;
  /**
   * 12fps re-seeded noise — the boiling LINE (shared with INK_GLOBALS).
   *
   * ART §4.1: this may drive **outline geometry only**. Anything that reads it and writes
   * a large area of the frame is a bug. The only legal consumers in the post stack are
   * `passes/ink.ts` (edge sampling) and the panel border in `passes/vignette.ts`.
   */
  uBoil: Uniform<Vector3>;
  /**
   * Smoothed 60Hz companion to uBoil. **Deprecated for image content** — a value that
   * changes every frame cannot appear in a pass without breaking §4.1. Kept so existing
   * shaders keep compiling; no pass reads it any more.
   */
  uBoilSmooth: Uniform<Vector3>;
  /** Global halftone dot-pitch multiplier (RenderService.halftoneScale). */
  uHalftoneScale: Uniform<number>;
  /**
   * THE screen-tone pitch, in drawing-buffer pixels. One lattice for the whole frame.
   * Every dot screen in every pass measures against this so the plates are pitch-locked
   * and differ only in ANGLE — which is a rosette (print) rather than a beat (moiré).
   * Driven by `ComicPipeline.applyHalftonePitch`.
   */
  uScreenPitch: Uniform<number>;
}

export function makeCommonUniforms(boil: Uniform<Vector3>, boilSmooth: Uniform<Vector3>): CommonUniforms {
  return {
    uResolution: { value: new Vector2(1, 1) },
    uTexel: { value: new Vector2(1, 1) },
    uAspect: { value: 1 },
    uTime: { value: 0 },
    uBoil: boil,
    uBoilSmooth: boilSmooth,
    uHalftoneScale: { value: 1 },
    uScreenPitch: { value: 6.6 },
  };
}

export const COMMON_DECLS = /* glsl */ `
  uniform vec2 uResolution;
  uniform vec2 uTexel;
  uniform float uAspect;
  uniform float uTime;
  uniform vec3 uBoil;
  uniform vec3 uBoilSmooth;
  uniform float uHalftoneScale;
  uniform float uScreenPitch;
`;

// ─────────────────────────────────────────────────────────────────────────────
// Shared GLSL toolbox (GLSL ES 1.00 — no textureLod, no dynamic array indexing)
// ─────────────────────────────────────────────────────────────────────────────

export const GLSL_UTIL = /* glsl */ `
  const vec3 CZ_LUMA = vec3(0.2126, 0.7152, 0.0722);
  float czLum(vec3 c) { return dot(c, CZ_LUMA); }

  vec3 czToSRGB(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c * 12.92, 1.055 * pow(c, vec3(0.4166667)) - 0.055, step(vec3(0.0031308), c));
  }
  vec3 czToLinear(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }

  float czHash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec2 czRot(vec2 p, float a) {
    float s = sin(a), c = cos(a);
    return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  }

  /** 8×8 ordered dither in [0,1) — the printer's screen, used to break up banding. */
  float czBayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
  float czBayer4(vec2 a) { return czBayer2(0.5 * a) * 0.25 + czBayer2(a); }
  float czBayer8(vec2 a) { return czBayer4(0.5 * a) * 0.25 + czBayer2(a); }

  /**
   * The signature of the whole art direction: a rotated dot screen whose dot RADIUS
   * carries the tone. Pitch is in PIXELS — dots are printed on the page, never on
   * the object, so they never scale with distance.
   *
   * THE LATTICE IS NAILED TO THE PAGE (ART §4.1). It is a pure function of gl_FragCoord,
   * the pitch and the angle — no time, no boil, no seed. Build 001 jumped it by eighths of
   * a cell on every 12fps boil step, which re-drew the tone across the ENTIRE frame five
   * times a second; measured, that single line moved ~96% of the pixels in the image and is
   * the largest part of what the playtester called "every pixel jumping like glitching".
   * A printed screen does not move. Only the drawing on top of it does.
   */
  float czDots(vec2 frag, float coverage, float angleDeg, float pitchPx) {
    float pitch = max(2.0, pitchPx * uHalftoneScale);
    vec2 p = frag / pitch;
    vec2 r = czRot(p, radians(angleDeg));
    vec2 cell = fract(r) - 0.5;
    float rad = 0.52 * sqrt(clamp(coverage, 0.0, 1.0));
    // A ±0.075-cell ramp is ~1.5 device px at the house pitch: enough to antialias the dot
    // edge as the camera moves (a harder edge crawls and sparkles) without going mushy.
    return smoothstep(rad + 0.075, rad - 0.075, length(cell));
  }

  /** Perspective depth buffer value → view-space distance in metres. */
  float czLinearDepth(float rawDepth, float near, float far) {
    float ndc = rawDepth * 2.0 - 1.0;
    return (2.0 * near * far) / (far + near - ndc * (far - near));
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Shader assembly
// ─────────────────────────────────────────────────────────────────────────────

const FS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Assemble a fragment shader from an ordered list of chunks. */
export function buildFragment(chunks: readonly PassChunk[]): string {
  let decls = '';
  let bodies = '';
  let calls = '';
  for (const ch of chunks) {
    decls += `\n// ── ${ch.id} ──\n${ch.decls}`;
    bodies += `\n// ── ${ch.id} ──\n${ch.body}`;
    calls += `  ${ch.call}\n`;
  }
  const needsSample = chunks[0]?.source !== true;
  return /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
varying vec2 vUv;
${COMMON_DECLS}
${decls}
${GLSL_UTIL}
${bodies}

void main() {
  vec2 uv = vUv;
${needsSample ? '  vec4 src = texture2D(tDiffuse, uv);\n  vec3 c = src.rgb;\n  float srcA = src.a;' : '  vec3 c = vec3(0.0);\n  float srcA = 1.0;'}
${calls}
  gl_FragColor = vec4(c, srcA);
}
`;
}

/**
 * Build a ShaderPass from one or more chunks. Uniform objects are shared, not copied,
 * so the pipeline can drive a value once and reach every form of every pass.
 */
export function buildPass(
  name: string,
  chunks: readonly PassChunk[],
  common: CommonUniforms,
  extra?: Uniforms,
): ShaderPass {
  const uniforms: Uniforms = { tDiffuse: { value: null }, ...common, ...extra };
  for (const ch of chunks) for (const k of Object.keys(ch.uniforms)) uniforms[k] = ch.uniforms[k]!;
  // NOTE: ShaderPass deep-CLONES a plain shader object's uniforms, which would sever the
  // sharing this whole design depends on. Handing it a ShaderMaterial keeps the objects.
  const material = new ShaderMaterial({
    name,
    uniforms,
    vertexShader: FS_VERT,
    fragmentShader: buildFragment(chunks),
    depthTest: false,
    depthWrite: false,
  });
  return new ShaderPass(material);
}

/** Merge every chunk's uniforms into one flat registry the pipeline can poke by name. */
export function collectUniforms(chunks: readonly PassChunk[], into: Uniforms): Uniforms {
  for (const ch of chunks) for (const k of Object.keys(ch.uniforms)) into[k] = ch.uniforms[k]!;
  return into;
}

/**
 * INK MATERIAL — the shading heart of the art direction. See docs/ART_DIRECTION.md §2–3.
 *
 * Owned by `render-pipeline`. The seeded API is preserved exactly — `world/`, `game/` and
 * `ui/` import these names:
 *
 *   makeInkMaterial(opts)      → the banded + halftone + rim + gleam toon material
 *   setInkColor(mat, hex)      → recolour in place
 *   buildOutlineHull(geo, t)   → inverted-hull silhouette mesh
 *   outlineTree(root, opts)    → outline every mesh under a root
 *   INK_GLOBALS                → shared uniforms; driven once per frame by the renderer
 *   updateInkGlobals(dt, w, h) → call once per frame from the renderer
 *
 * Deepened in M1 with:
 *   • a matcap-free cartoon GLEAM (a hard highlight *shape*, not a gradient)
 *   • albedo map support with a halftone multiply (texture detail becomes screen-tone)
 *   • an emissive / bloom-layer flag (`bloom: true` → the object joins LAYER.BLOOM)
 *   • makeInkMaterialVariants() for material families that share a look
 *   • makeSkyMaterial() / buildSkyDome() — the sky is a piece of ART, not a clear colour
 *
 * COLOUR SPACE: every material here writes LINEAR values. The post stack stays linear until
 * `passes/grade.ts`, which converts to display-referred sRGB. `#include <colorspace_fragment>`
 * is a no-op when rendering into the composer's render targets and the correct encode when a
 * material is ever drawn straight to the canvas (the LAYER.OVERLAY pass), so it stays.
 */

import {
  BackSide, Color, DoubleSide, FrontSide, Mesh, ShaderMaterial, SphereGeometry, Vector2, Vector3,
  type BufferGeometry, type Object3D, type Texture,
} from 'three';
import { PALETTE, color } from '@/art/palette';
import { makeHullGeometry } from '@/art/shapes';

// ─────────────────────────────────────────────────────────────────────────────
// Layers — see docs/ARCHITECTURE.md §5. The renderer swaps the camera's layer
// mask between the prepass / main / bloom / overlay renders, so an object's
// layer decides which of those it participates in.
// ─────────────────────────────────────────────────────────────────────────────

export const LAYER = {
  /** Everything: lit, ink-edged, post-processed. */
  DEFAULT: 0,
  /** Inverted-hull silhouettes. Drawn in the main pass, excluded from the normal/depth prepass. */
  OUTLINE: 1,
  /** Emissive: additionally rendered into the selective-bloom source. Keep layer 0 enabled too. */
  BLOOM: 2,
  /** Drawn straight to the canvas after post — nothing here is graded. */
  OVERLAY: 3,
  /** Sky and other things that must not generate ink edges (excluded from the prepass). */
  NO_INK: 4,
} as const;

/** Also render this object into the selective-bloom source. Keeps its existing layers. */
export function markBloom(o: Object3D, recursive = true): void {
  if (recursive) o.traverse((c) => c.layers.enable(LAYER.BLOOM));
  else o.layers.enable(LAYER.BLOOM);
}

/** Exclude this object from the normal/depth prepass, so the ink pass never edges it. */
export function markNoInk(o: Object3D, recursive = true): void {
  const apply = (c: Object3D): void => { c.layers.set(LAYER.NO_INK); };
  if (recursive) o.traverse(apply);
  else apply(o);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared globals — one uniform object referenced by every ink material, so the
// renderer updates lighting / boiling line / resolution exactly once per frame.
// ─────────────────────────────────────────────────────────────────────────────

export const INK_GLOBALS = {
  uResolution: { value: new Vector2(1, 1) },
  /**
   * Re-seeded at 12fps, not 60 — the hand-drawn "boiling" wobble.
   *
   * **ART §4.1: OUTLINE GEOMETRY ONLY.** The only legal consumers are the inverted-hull
   * vertex shader below and the edge sampling in `passes/ink.ts`. If a shader reads this
   * and writes a large area of the frame, the whole page re-prints itself five times a
   * second — which is what the playtester saw as "every pixel jumping like glitching".
   */
  uBoil: { value: new Vector3(0, 0, 0) },
  uTime: { value: 0 },
  /** Key light direction (world space, pointing FROM the light). */
  uKeyDir: { value: new Vector3(-0.5, 0.85, 0.35).normalize() },
  uKeyColor: { value: color(PALETTE.RUST).clone() },
  uKeyIntensity: { value: 1.15 },
  /** Cool fill from the opposite side — never a flat ambient wash. */
  uFillDir: { value: new Vector3(0.6, 0.35, -0.7).normalize() },
  uFillColor: { value: color(PALETTE.NIGHT_B).clone() },
  uFillIntensity: { value: 0.55 },
  uAmbient: { value: color(PALETTE.NIGHT_A).clone() },
  /** Global art-direction knobs, driven by RenderService.inkStrength / halftoneScale. */
  uInkStrength: { value: 1 },
  uHalftoneScale: { value: 1 },
  /**
   * THE screen-tone pitch in CSS pixels, driven from the quality tier by `ComicPipeline`.
   * Materials and the sky print on the same sheet as the post stack: same pitch, different
   * plate angle. Per-material variation is a MULTIPLIER (`InkMaterialOptions.halftonePitch`),
   * never an independent pitch — two lattices a pixel apart beat, and a beat is moiré.
   */
  uHalftonePitch: { value: 6.6 },
  uFogColorNear: { value: color(PALETTE.NIGHT_B).clone() },
  uFogColorFar: { value: color(PALETTE.NIGHT_A).clone() },
  uFogRange: { value: new Vector2(18, 95) },
  /** Rim/back light direction — the third lamp of the rig (ART_DIRECTION §6). */
  uRimDir: { value: new Vector3(0.15, 0.25, 0.95).normalize() },
  /** Scene accent, used by the sky glow and as the default rim tint. */
  uAccent: { value: color(PALETTE.ELECTRIC).clone() },
  /**
   * Smoothly-varying 0..1 companion to uBoil.
   *
   * **DEPRECATED AS IMAGE CONTENT.** It changes every frame by definition, so anything that
   * reads it violates §4.1 the moment it writes more than a handful of pixels. It is kept
   * only so that existing uniform wiring keeps resolving; nothing in `render/` reads it.
   */
  uBoilSmooth: { value: new Vector3(0, 0, 0) },
  /**
   * How much of a light's HUE is applied to the flats, 0..1. The palette's light
   * colours are fully saturated (RUST is almost pure orange); multiplying an albedo
   * by one raw would annihilate two of its channels and turn the whole arena monochrome.
   * Lights are normalised to unit peak and blended toward white by this amount, so the
   * key reads as *warm* and the fill as *cool* while the flats keep their own hue —
   * which is exactly how a colourist lights a page. 0 = white lights, 1 = raw palette.
   */
  uLightSat: { value: 0.62 },
};

export type InkGlobals = typeof INK_GLOBALS;

let _boilAccum = 0;
const BOIL_HZ = 12;
const _boilPrev = new Vector3();
const _boilNext = new Vector3(0.5, 0.5, 0.5);

/** Call once per frame, before rendering. `dt` is unscaled real time. */
export function updateInkGlobals(dt: number, width: number, height: number): void {
  INK_GLOBALS.uTime.value += dt;
  INK_GLOBALS.uResolution.value.set(width, height);
  _boilAccum += dt;
  const step = 1 / BOIL_HZ;
  if (_boilAccum >= step) {
    _boilAccum %= step;
    _boilPrev.copy(_boilNext);
    _boilNext.set(Math.random(), Math.random(), Math.random());
    INK_GLOBALS.uBoil.value.copy(_boilNext);
  }
  // The smooth companion interpolates between the same 12fps seeds, so anything that
  // would visibly pop (sky cloud drift, lens splat drift) can ride it instead.
  const t = Math.min(1, _boilAccum * BOIL_HZ);
  INK_GLOBALS.uBoilSmooth.value.lerpVectors(_boilPrev, _boilNext, t * t * (3 - 2 * t));
}

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface InkMaterialOptions {
  /** Base hue. Must come from the palette. */
  color: number;
  /** Shadow-band hue. Defaults to a palette-consistent darkening. */
  shadowColor?: number;
  /** Fresnel rim — this is what makes it read as AAA rather than flat. */
  rimColor?: number;
  rimPower?: number;
  /** Rim exponent at `rimNear` and closer. Defaults to `rimPower` (no distance behaviour). */
  rimPowerNear?: number;
  /** Rim strength multiplier at `rimNear` and closer. */
  rimNearMul?: number;
  /** Distance, metres, at/below which the near rim applies, and at/above which the far one does. */
  rimNear?: number;
  rimFar?: number;
  rimStrength?: number;
  /** Number of light bands. 3 is the house standard. */
  bands?: number;
  /** Halftone dot strength in the shadow band, 0..1. */
  halftone?: number;
  /**
   * THE MINIMUM SCREEN. A colourist does not leave the biggest empty area of a panel as a
   * dead fill — they screen it, always, lit or not. The shadow-band tone mask alone gives a
   * fully-lit horizontal plane ZERO dots, which is exactly backwards: the ground is 40–50%
   * of every frame in this game and it was printing as one flat value with no texture, no
   * linework and no tone. This is the floor under that mask, so every surface always carries
   * at least a light screen. It is also what pulls the over-0.7 tail down off the ceiling
   * `READABILITY.ENV_VALUE_CEIL` reserves for practicals and enemies.
   */
  toneFloor?: number;
  /**
   * Dot pitch as a MULTIPLE of the frame's screen pitch (`INK_GLOBALS.uHalftonePitch`).
   * 1 = the same lattice as every other screen in the frame, which is what you want almost
   * always. Use whole or half steps (0.5, 2) if a material family needs a coarser plate —
   * anything else beats against the post stack's screen.
   */
  halftonePitch?: number;
  /** Screen-tone rotation, degrees. Vary per material family (15° steps). */
  halftoneAngle?: number;
  /** Hard cartoon gleam. */
  specular?: number;
  emissive?: number;
  emissiveIntensity?: number;
  /** Distance fog participation, 0..1. */
  fog?: number;
  side?: 'front' | 'back' | 'double';
  flatShading?: boolean;
  transparent?: boolean;
  opacity?: number;

  // ── added in M1 ───────────────────────────────────────────────────────────

  /**
   * Matcap-free cartoon GLEAM: a hard-clipped highlight *shape* anchored to the
   * view-space normal and oriented by the key light. 0 = off, 1 = chrome.
   */
  gleam?: number;
  /** Angular size of the gleam blob in view-normal space. Smaller = tighter, glossier. */
  gleamSize?: number;
  gleamColor?: number;
  /** Albedo map (procedural, from `art/textures`). Multiplied over the flat colour. */
  map?: Texture | null;
  /** How much of the map to let through. 0 = flat colour, 1 = full texture. */
  mapStrength?: number;
  /** Texture repeat multiplier applied in the shader (UVs are 1 tile/metre). */
  mapScale?: number;
  /**
   * Turn the map's own value structure into printed screen-tone rather than tonal
   * variation — dark texels become dots. This is what keeps textures reading as INK.
   */
  mapHalftone?: number;
  /** Join LAYER.BLOOM: whatever mesh uses this material is added to the bloom source. */
  bloom?: boolean;
  /** Vertex-baked AO strength — reads the geometry's `color` attribute if present. */
  vertexAo?: number;
  /** Renderable name, for debugging. */
  name?: string;
}

export type InkMaterial = ShaderMaterial & { readonly isInkMaterial: true };

// ─────────────────────────────────────────────────────────────────────────────
// Shared GLSL
// ─────────────────────────────────────────────────────────────────────────────

/** Cheap, sin-free 3D value noise. Used by the sky and by the boiling line. */
const NOISE_GLSL = /* glsl */ `
  float czHash13(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float czNoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = czHash13(i);
    float n100 = czHash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = czHash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = czHash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = czHash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = czHash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = czHash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = czHash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z);
  }
`;

const VERT = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  varying vec3 vViewNormal;
  varying float vDepth;
  varying vec2 vUv;
  varying float vAo;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    vUv = uv;
    // Painted AO: art/shapes bakes crevice darkening into the colour attribute.
    // three declares 'attribute vec3 color' only when material.vertexColors is on,
    // which makeInkMaterial() flips whenever 'vertexAo' is requested.
    #ifdef USE_COLOR
      vAo = color.r;
    #else
      vAo = 1.0;
    #endif
    vec4 mvPos = viewMatrix * worldPos;
    vViewNormal = normalize(mat3(viewMatrix) * vWorldNormal);
    vDepth = -mvPos.z;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uColor;
  uniform vec3 uShadowColor;
  uniform vec3 uRimColor;
  uniform float uRimPower;
  /**
   * NEAR-FIELD rim shape. The rim serves two jobs that want opposite settings: far away it must
   * FLOOD the silhouette so an enemy is findable (ART §9), and up close it must HUG the edge so
   * the form underneath can be read. A single exponent cannot do both — at the wide value that
   * makes a body findable at 25 m, the term covers nearly the whole surface at 3 m and erases
   * every anatomical landmark the mesh has. Defaults equal the far values, so any material that
   * does not opt in behaves exactly as before.
   */
  uniform float uRimPowerNear;
  uniform float uRimNearMul;
  uniform vec2 uRimRange;
  uniform float uRimStrength;
  uniform float uBands;
  uniform float uHalftone;
  uniform float uToneFloor;
  uniform float uHalftoneMul;
  uniform float uHalftoneAngle;
  uniform float uSpecular;
  uniform vec3 uEmissive;
  uniform float uEmissiveIntensity;
  uniform float uFog;
  uniform float uOpacity;
  uniform float uGleam;
  uniform float uGleamSize;
  uniform vec3 uGleamColor;
  uniform float uMapStrength;
  uniform float uMapScale;
  uniform float uMapHalftone;
  uniform float uVertexAo;
  #ifdef USE_ALBEDO
    uniform sampler2D uMap;
  #endif

  uniform vec2 uResolution;
  // NOTE: uBoil is declared but deliberately UNREFERENCED in this shader. The surface
  // shading of a flat is print — it does not boil (ART §4.1). Only the inverted-hull vertex
  // shader below and passes/ink.ts are allowed to read it.
  uniform vec3 uBoil;
  uniform float uTime;
  uniform vec3 uKeyDir;
  uniform vec3 uKeyColor;
  uniform float uKeyIntensity;
  uniform vec3 uFillDir;
  uniform vec3 uFillColor;
  uniform float uFillIntensity;
  uniform vec3 uRimDir;
  uniform vec3 uAccent;
  uniform vec3 uAmbient;
  uniform float uLightSat;
  uniform float uHalftoneScale;
  uniform float uHalftonePitch;
  uniform vec3 uFogColorNear;
  uniform vec3 uFogColorFar;
  uniform vec2 uFogRange;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  varying vec3 vViewNormal;
  varying float vDepth;
  varying vec2 vUv;
  varying float vAo;

  // A palette light colour → a usable diffuse tint. See INK_GLOBALS.uLightSat.
  vec3 lightTint(vec3 c) {
    float m = max(max(c.r, c.g), max(c.b, 1e-4));
    return mix(vec3(1.0), c / m, uLightSat);
  }

  // 3-step quantisation with a hair of softening to kill aliasing (ART_DIRECTION §2.1).
  float bandify(float x) {
    float e = 0.02;
    if (uBands <= 2.5) {
      return 0.22 + 0.78 * smoothstep(0.5 - e, 0.5 + e, x);
    }
    return 0.16
      + 0.36 * smoothstep(0.30 - e, 0.30 + e, x)
      + 0.48 * smoothstep(0.66 - e, 0.66 + e, x);
  }

  // Screen-space halftone: dots are printed on the page, not on the object,
  // so pitch is in PIXELS and never scales with distance.
  // 8×8 ordered dither — a printer's screen, static by construction. Used to break the
  // fog bands without adding another rotating dot lattice to the pile.
  float czBayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
  float czBayer4(vec2 a) { return czBayer2(0.5 * a) * 0.25 + czBayer2(a); }
  float czBayer8(vec2 a) { return czBayer4(0.5 * a) * 0.25 + czBayer2(a); }

  /**
   * THE DOTS ARE PRINTED ON THE PAGE (ART §4.1). A pure function of gl_FragCoord, the
   * frame's screen pitch and this material's plate angle — no time term, no boil, no seed.
   * uHalftoneScale carries the pixel ratio; the pitch is authored in CSS px so a dot is the
   * same physical size at any DPR, and it is the SAME pitch the post stack prints with.
   */
  float halftoneDots(float coverage, float angleDeg, float mul) {
    float pitch = max(2.0, uHalftonePitch * mul * uHalftoneScale);
    float a = radians(angleDeg);
    vec2 p = gl_FragCoord.xy / pitch;
    vec2 r = vec2(p.x * cos(a) - p.y * sin(a), p.x * sin(a) + p.y * cos(a));
    vec2 cell = fract(r) - 0.5;
    float d = length(cell);
    float radius = 0.52 * sqrt(clamp(coverage, 0.0, 1.0));
    // Wider AA ramp than build 001: a 0.055 edge is well under a pixel at this pitch, which
    // sparkles along every dot boundary as the camera moves.
    return smoothstep(radius + 0.075, radius - 0.075, d);
  }

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(vViewDir);

    // ── albedo ──────────────────────────────────────────────────────────────
    vec3 albedo = uColor;
    float mapTone = 0.0;
    #ifdef USE_ALBEDO
      vec4 tex = texture2D(uMap, vUv * uMapScale);
      // Two hues max: the map modulates the flat colour, it never replaces it.
      // Modulate, never replace: the map moves the flat around its own value, so a
      // dark texel becomes screen-tone (below) instead of crushing the colour to black.
      albedo = mix(albedo, albedo * (0.55 + tex.rgb * 0.95), uMapStrength);
      // The map's darkness becomes printed dots instead of a muddy tonal wash.
      mapTone = (1.0 - dot(tex.rgb, vec3(0.299, 0.587, 0.114))) * uMapHalftone;
    #endif
    float ao = mix(1.0, clamp(vAo, 0.0, 1.0), uVertexAo);

    // ── three-light rig ─────────────────────────────────────────────────────
    float keyRaw  = max(dot(N, uKeyDir), 0.0);
    float fillRaw = max(dot(N, uFillDir), 0.0);

    float key  = bandify(keyRaw) * uKeyIntensity * ao;
    float fill = bandify(fillRaw) * uFillIntensity;
    float lightAmount = clamp(key + fill * 0.5, 0.0, 1.0);

    // Base flat colour, dropped to the shadow hue where unlit.
    //
    // THE SHADOW FLOOR. A graphic novel is built on MIDTONES; black is reserved for the
    // linework. A shadow band that falls to near-zero has no value for the screen-tone to
    // modulate and no value for a black line to be seen against — which is how half a frame
    // ends up as a featureless void. The band therefore keeps a trace of the surface's own
    // hue and never falls below roughly 12% of the albedo.
    vec3 lit = albedo * (lightTint(uKeyColor) * key + lightTint(uFillColor) * fill * 0.9);
    // Three terms, and all three are load-bearing: the shadow hue itself, a trace of the
    // surface's own albedo (so the flat is still recognisably ITS colour in shadow), and a
    // flat ambient bounce — the violet wash a colourist floods a night page with. Without the
    // third the darkest flats land under 5% luminance and the frame is a void.
    vec3 shade = uShadowColor * (uAmbient + 0.55) + albedo * 0.12 + uAmbient * 0.55;
    vec3 base = mix(shade, lit + albedo * 0.35, lightAmount);

    // ── halftone: the shadow band is dots, never flat darkness ──────────────
    // ONE screen only. The post halftone pass lays the dominant screen over the whole frame
    // with real depth behind it; this one is a quiet underlay printed on the surface itself.
    // Stacking a second and a third here just beat against it into a mechanical weave.
    float shadowMask = (1.0 - smoothstep(0.25, 0.72, lightAmount)) * uHalftone;
    // Coverage never falls to zero either: a lit plane still prints a fine screen rather
    // than a bare fill, which is what gives the ground its texture back at 2–20 m.
    float coverage = clamp(max(1.0 - lightAmount, uToneFloor * 0.55) + mapTone, 0.0, 1.0);
    float dots = halftoneDots(coverage, uHalftoneAngle, uHalftoneMul);
    // THE TONE FLOOR — see InkMaterialOptions.toneFloor. A max(), not a sum: a shadow band
    // that is already fully screened must not be screened twice.
    float toneMask = clamp(max(shadowMask, uToneFloor * uHalftone) + mapTone * 0.85, 0.0, 1.0) * 0.6;
    base = mix(base, mix(base, uShadowColor * 0.62, dots), toneMask);

    // ── hard cartoon gleam — a SHAPE, not a gradient ────────────────────────
    // Still hard-clipped, but with a hair of ramp on the clip. A bare step() on a continuous
    // function has no antialiasing at all: on any curved or near-tangent surface the
    // highlight's boundary snaps between whole pixels as the camera moves, which is the
    // specular POPPING the playtester read as inconsistency. 0.007 of N·H is a couple of
    // pixels of ramp on typical curvature — still a shape, no longer a sparkle generator.
    vec3 H = normalize(uKeyDir + V);
    float spec = smoothstep(0.965, 0.972, max(dot(N, H), 0.0)) * uSpecular;
    base += lightTint(uKeyColor) * spec;

    if (uGleam > 0.001) {
      // Matcap-free: build the highlight in view-normal space and orient it by the
      // key light, so it slides across the surface like a drawn-on chrome flick.
      vec2 g = vViewNormal.xy;
      vec2 kv = normalize((viewMatrix * vec4(uKeyDir, 0.0)).xy + vec2(1e-4, 1e-4));
      vec2 perp = vec2(-kv.y, kv.x);
      float s = max(0.02, uGleamSize);
      float d1 = length((g - kv * 0.52) * vec2(1.0, 1.75));
      float d2 = length((g - kv * 0.24 - perp * 0.30) * vec2(1.7, 1.0));
      float blob = max(
        1.0 - smoothstep(s * 0.92, s, d1),
        (1.0 - smoothstep(s * 0.50, s * 0.56, d2)) * 0.85);
      base += uGleamColor * blob * uGleam * (0.35 + 0.65 * lightAmount);
    }

    // ── Fresnel rim — a FILL, not the rim light ─────────────────────────────
    // A per-fragment Fresnel cannot draw an edge on flat-shaded geometry: face normals are
    // constant across a face, so N·V is a per-face constant and this term floods whole
    // polygons instead of edging them. The real rim is drawn in screen space by passes/ink.ts,
    // off the depth discontinuity. What is left here is a gentle grazing-angle tint.
    float rimT = clamp((vDepth - uRimRange.x) / max(0.5, uRimRange.y - uRimRange.x), 0.0, 1.0);
    float rimPow = mix(uRimPowerNear, uRimPower, rimT);
    float rimMul = mix(uRimNearMul, 1.0, rimT);
    float rim = pow(1.0 - max(dot(N, V), 0.0), rimPow) * rimMul;
    // The rim is a back light, so it lives on the side away from the key.
    float back = 0.45 + 0.55 * max(dot(N, uRimDir), 0.0);
    rim *= back * smoothstep(0.0, 0.35, 1.0 - keyRaw * 0.5);
    // Hard-clip the rim into a band: a drawn edge light, not an airbrushed one.
    rim = smoothstep(0.12, 0.30, rim) * (0.55 + 0.45 * rim);
    base += uRimColor * rim * uRimStrength;

    base += uEmissive * uEmissiveIntensity;

    // ── banded distance fog — a colourist's flat background wash, in steps ──
    float fogT = clamp((vDepth - uFogRange.x) / max(1.0, uFogRange.y - uFogRange.x), 0.0, 1.0);
    float fogBanded = floor(fogT * 5.0) / 5.0;
    // The step between bands is dithered so the wash never shows a hard ring where a large
    // flat surface crosses a boundary. An ORDERED dither, not a dot screen: the post halftone
    // pass owns the frame's screen-tone, and a fourth lattice here only beat against it.
    float bandFrac = fract(fogT * 5.0);
    float fogMix = clamp(fogBanded + step(czBayer8(gl_FragCoord.xy), bandFrac) * 0.2, 0.0, 1.0);
    vec3 fogCol = mix(uFogColorNear, uFogColorFar, fogMix);
    base = mix(base, fogCol, fogMix * uFog);

    gl_FragColor = vec4(base, uOpacity);
    #include <colorspace_fragment>
  }
`;

let _familyAngle = 0;

/** The house material. Every opaque surface in the game uses this. */
export function makeInkMaterial(opts: InkMaterialOptions): InkMaterial {
  const base = color(opts.color);
  const shadow = opts.shadowColor !== undefined
    ? color(opts.shadowColor)
    : base.clone().multiplyScalar(0.28).lerp(color(PALETTE.INK_SOFT), 0.55);

  const angle = opts.halftoneAngle ?? ((_familyAngle = (_familyAngle + 15) % 90));

  const defines: Record<string, string> = {};
  if (opts.map) defines.USE_ALBEDO = '';

  const mat = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    vertexColors: (opts.vertexAo ?? 0) > 0,
    side: opts.side === 'back' ? BackSide : opts.side === 'double' ? DoubleSide : FrontSide,
    uniforms: {
      uColor: { value: base.clone() },
      uShadowColor: { value: shadow },
      uRimColor: { value: color(opts.rimColor ?? PALETTE.ELECTRIC).clone() },
      uRimPower: { value: opts.rimPower ?? 3.2 },
      uRimPowerNear: { value: opts.rimPowerNear ?? opts.rimPower ?? 3.2 },
      uRimNearMul: { value: opts.rimNearMul ?? 1 },
      uRimRange: { value: new Vector2(opts.rimNear ?? 4, opts.rimFar ?? 14) },
      // A material Fresnel is a FILL — the drawn rim lives in passes/ink.ts (screen space).
      uRimStrength: { value: opts.rimStrength ?? 0.22 },
      uBands: { value: opts.bands ?? 3 },
      uHalftone: { value: opts.halftone ?? 0.85 },
      uToneFloor: { value: opts.toneFloor ?? 0.18 },
      /** Multiple of the frame's screen pitch. 1 = the same lattice as everything else. */
      uHalftoneMul: { value: opts.halftonePitch ?? 1 },
      uHalftoneAngle: { value: angle },
      uSpecular: { value: opts.specular ?? 0.35 },
      uEmissive: { value: color(opts.emissive ?? PALETTE.INK).clone() },
      uEmissiveIntensity: { value: opts.emissiveIntensity ?? 0 },
      uFog: { value: opts.fog ?? 1 },
      uOpacity: { value: opts.opacity ?? 1 },
      uGleam: { value: opts.gleam ?? 0 },
      uGleamSize: { value: opts.gleamSize ?? 0.34 },
      uGleamColor: { value: color(opts.gleamColor ?? PALETTE.PAPER).clone() },
      uMap: { value: opts.map ?? null },
      uMapStrength: { value: opts.mapStrength ?? 0.85 },
      uMapScale: { value: opts.mapScale ?? 1 },
      uMapHalftone: { value: opts.mapHalftone ?? 0.35 },
      uVertexAo: { value: opts.vertexAo ?? 0 },
      ...INK_GLOBALS,
    },
  });
  (mat as unknown as { isInkMaterial: boolean }).isInkMaterial = true;
  (mat.userData as { bloom?: boolean }).bloom = opts.bloom ?? false;
  mat.name = opts.name ?? 'InkMaterial';
  // `flatShading` is accepted for API compatibility but is a no-op here: the shader
  // uses whatever normals the geometry carries, and `art/shapes` already builds every
  // primitive faceted (non-indexed, per-face normals). Weld it yourself if you want smooth.
  return mat as InkMaterial;
}

/** Convenience: recolour an existing ink material without rebuilding it. */
export function setInkColor(mat: InkMaterial, hex: number): void {
  (mat.uniforms.uColor!.value as Color).copy(color(hex));
}

/** Recolour the shadow band (used when a zombie is burning / shocked). */
export function setInkShadowColor(mat: InkMaterial, hex: number): void {
  (mat.uniforms.uShadowColor!.value as Color).copy(color(hex));
}

/** Drive the emissive term — muzzle heat, powerup pulse, hit flash. */
export function setInkEmissive(mat: InkMaterial, hex: number, intensity: number): void {
  (mat.uniforms.uEmissive!.value as Color).copy(color(hex));
  mat.uniforms.uEmissiveIntensity!.value = intensity;
}

/** Swap the albedo map at runtime. Recompiles once when the define flips. */
export function setInkMap(mat: InkMaterial, map: Texture | null): void {
  const had = mat.defines && 'USE_ALBEDO' in mat.defines;
  mat.uniforms.uMap!.value = map;
  if (!!map !== !!had) {
    mat.defines = mat.defines ?? {};
    if (map) mat.defines.USE_ALBEDO = '';
    else delete mat.defines.USE_ALBEDO;
    mat.needsUpdate = true;
  }
}

/**
 * Build a family of materials that share a look but differ per member — the way a
 * colourist works: one palette, many flats.
 *
 *   const zombie = makeInkMaterialVariants(
 *     { color: PALETTE.ACID, rimColor: PALETTE.HOT, halftoneAngle: 15 },
 *     { skin: {}, cloth: { color: PALETTE.NIGHT_B }, bone: { color: PALETTE.PAPER } });
 */
export function makeInkMaterialVariants<K extends string>(
  base: InkMaterialOptions,
  variants: Record<K, Partial<InkMaterialOptions>>,
): Record<K, InkMaterial> {
  const out = {} as Record<K, InkMaterial>;
  for (const key of Object.keys(variants) as K[]) {
    out[key] = makeInkMaterial({ ...base, ...variants[key], name: `Ink:${key}` });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inverted-hull silhouette (ART_DIRECTION §3)
// ─────────────────────────────────────────────────────────────────────────────

const OUTLINE_VERT = /* glsl */ `
  uniform float uThickness;
  uniform float uMinThickness;
  uniform float uBoilAmount;
  uniform vec2 uResolution;
  uniform vec3 uBoil;
  ${NOISE_GLSL}
  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);

    // Screen-space constant thickness: distant zombies keep bold outlines.
    // (-mvPos.z / resolution.y) is the world size of one pixel at this depth for a
    // ~53° vertical FOV; the 2.2 factor folds that constant in.
    // uResolution is the CSS size, so uThickness is CSS pixels and the line is the same
    // physical weight on a retina panel as on a 1x monitor.
    float px = max(-mvPos.z, 0.05) / max(uResolution.y, 1.0);
    float scale = max(uThickness, uMinThickness) * px * 2.2;

    // THE BOILING LINE — and this vertex shader is one of only two places in the whole
    // renderer allowed to read uBoil (ART §4.1). Re-seeded at 12fps, low frequency in
    // OBJECT space so the wobble travels with the surface instead of crawling in screen
    // space. Both octaves step on the SAME 12fps seed: the second one used to ride
    // uBoilSmooth, which is a 60Hz interpolant, so every silhouette in the game was
    // breathing on every single frame underneath the 12fps one.
    //
    // **AND IT IS NEAR-FIELD ONLY** (M1.5 fix pass). Measured with the post-stack boil
    // already zeroed, this term alone moved 1.71% of a parked frame — 3.4× the whole §4.1
    // budget — because uBoilAmount was applied flat at any distance, so a hundred distant
    // silhouettes 60 m away each swung by an amount that is large relative to their
    // on-screen size. That reads as glitter, not as ink. The wobble now dies off by 16 m,
    // exactly like the screen-space boil in passes/ink.ts: the prop at your feet breathes,
    // the city behind it is printed.
    float viewDist = max(-mvPos.z, 0.0);
    float boilNear = clamp(1.0 - viewDist / 16.0, 0.0, 1.0);
    float wob = czNoise3(position * 3.7 + uBoil * 11.0) - 0.5;
    float wob2 = czNoise3(position * 11.3 - uBoil.zxy * 7.0) - 0.5;
    scale *= 1.0 + uBoilAmount * (wob * 0.9 + wob2 * 0.35) * boilNear;

    mvPos.xyz += n * scale;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const OUTLINE_FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uInk;
  void main() {
    gl_FragColor = vec4(uInk, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface OutlineOptions {
  /** On-screen thickness in pixels. 2–4 for props, 4–6 for characters. */
  thickness?: number;
  /** Never let the line get thinner than this many pixels. */
  minThickness?: number;
  /** Line colour; defaults to INK. Bright surfaces should tint toward their own hue. */
  ink?: number;
  /**
   * 0 = dead straight, 1 = very wobbly. **`ENV_BOIL` (0.03) is the environment default;
   * `ENEMY_BOIL` (0.08) is for characters and characters only.**
   *
   * This inflates the hull along the normal, so it moves the OUTER edge of the silhouette
   * band of every outlined object at once. 0.18 in build 001 was ~2.2% of the frame; 0.08
   * on the shipped 140 m arena still measured 1.71%, i.e. 3.4× the whole §4.1 budget, for
   * the simple reason that a dense city has a hundred silhouettes in frame and a character
   * study has one. ART §9 gives the "high-frequency motion" channel to enemies — so the
   * environment gets the quiet line and the zombie gets the boiling one.
   */
  boil?: number;
  /**
   * Weld the geometry before inflating. Flat-shaded/non-indexed geometry (everything
   * from `art/shapes`) shatters into slivers without this — see art-lib note #1.
   * Results are cached per source geometry, so repeated calls are free.
   */
  weld?: boolean;
}

/**
 * THE TWO BOIL AMPLITUDES. ART §9 reserves high-frequency motion for enemies, and §4.1
 * caps what the whole frame is allowed to repaint with a parked camera. Both are satisfied
 * by drawing the line: the city is inked steady, the characters boil.
 */
export const ENV_BOIL = 0.03;
export const ENEMY_BOIL = 0.08;

const _weldCache = new WeakMap<BufferGeometry, BufferGeometry>();

/** Welded copy of `geo`, cached. Shared by every hull built from the same source. */
export function outlineGeometry(geo: BufferGeometry): BufferGeometry {
  let w = _weldCache.get(geo);
  if (!w) {
    w = makeHullGeometry(geo);
    _weldCache.set(geo, w);
  }
  return w;
}

/**
 * Build the backface hull mesh for `geometry`. Add it as a child of the source mesh.
 * The hull is placed on LAYER.OUTLINE so the normal/depth prepass never sees it.
 */
export function buildOutlineHull(geometry: BufferGeometry, opts: OutlineOptions = {}): Mesh {
  const mat = new ShaderMaterial({
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    side: BackSide,
    uniforms: {
      uThickness: { value: opts.thickness ?? 5.0 },
      uMinThickness: { value: opts.minThickness ?? 2.5 },
      uBoilAmount: { value: opts.boil ?? ENV_BOIL },
      uInk: { value: color(opts.ink ?? PALETTE.INK).clone() },
      uResolution: INK_GLOBALS.uResolution,
      uBoil: INK_GLOBALS.uBoil,
    },
  });
  const geo = opts.weld === false ? geometry : outlineGeometry(geometry);
  const hull = new Mesh(geo, mat);
  hull.name = 'outline';
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.frustumCulled = false;
  hull.renderOrder = -1;
  hull.layers.set(LAYER.OUTLINE);
  return hull;
}

/** Walk an object tree and give every mesh a silhouette hull. Returns the hulls. */
export function outlineTree(root: Object3D, opts: OutlineOptions = {}): Mesh[] {
  const made: Mesh[] = [];
  const targets: Mesh[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh && m.name !== 'outline' && !m.layers.isEnabled(LAYER.OVERLAY)) targets.push(m);
  });
  for (const m of targets) {
    if (!m.geometry) continue;
    const hull = buildOutlineHull(m.geometry, opts);
    m.add(hull);
    made.push(hull);
  }
  return made;
}

/** Set the on-screen thickness of hulls previously returned by `outlineTree`. */
export function setOutlineThickness(hulls: readonly Mesh[], px: number): void {
  for (const h of hulls) {
    const u = (h.material as ShaderMaterial).uniforms;
    if (u.uThickness) u.uThickness.value = px;
  }
}

/** Detach and dispose hull materials. Welded geometry is shared and is NOT disposed here. */
export function disposeOutlines(hulls: readonly Mesh[]): void {
  for (const h of hulls) {
    h.parent?.remove(h);
    (h.material as ShaderMaterial).dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SKY — a piece of art, not a clear colour (ART_DIRECTION §6)
//
// A camera-locked dome painted entirely in the fragment shader:
//   • hard-banded night gradient, NIGHT_A → NIGHT_B, with a RUST horizon fire
//   • a huge PAPER moon with an inked rim, crater dots, halftone terminator and
//     three concentric comic glow rings
//   • hand-drawn cloud silhouettes: hard-thresholded noise with an INK contour
//     and a moon-facing rim, drifting on three parallax layers ON TWELVES
//   • hashed stars, PAINTED — they do not twinkle
//   • screen-space halftone laid over the whole thing so it prints like paper
//
// THE SKY IS A PAINTED BACKDROP, NOT A SCREENSAVER (ART §4.1). It fills most of the upper
// frame, so anything that animates here animates a huge fraction of the image. Build 001
// twinkled every star on the 12fps boil, wobbled every cloud contour on the 60Hz smooth
// interpolant, and slid the cloud domain continuously with uTime. The only motion left is
// the cloud drift, and it is quantised onto the same 12fps clock as the ink — a sky that
// animates on twelves next to a line that animates on twelves reads as one drawing.
// ─────────────────────────────────────────────────────────────────────────────

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    // Strip translation → the dome is always centred on the camera; xyww pins it
    // to the far plane so its radius is irrelevant.
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix * modelMatrix) * position, 1.0);
    gl_Position = p.xyww;
  }
`;

const SKY_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  uniform vec3 uMoonGlow;
  uniform vec3 uInk;
  uniform vec3 uPaper;
  uniform vec3 uCloud;
  uniform vec3 uCloudRim;
  uniform vec3 uMoonDir;
  uniform float uMoonSize;
  uniform float uBands;
  uniform float uCloudCover;
  uniform float uCloudSpeed;
  uniform float uStars;
  uniform float uHalftone;
  uniform float uHalftonePitch;
  uniform float uHalftoneMul;
  uniform float uHalftoneScale;
  uniform float uTime;
  uniform vec2 uResolution;

  varying vec3 vDir;

  ${NOISE_GLSL}

  float fbm3(vec3 p) {
    float a = 0.5;
    float s = 0.0;
    for (int i = 0; i < 4; i++) {
      s += a * czNoise3(p);
      p *= 2.03;
      a *= 0.5;
    }
    return s;
  }

  /** Same sheet, same pitch, own plate angle. Static by construction (§4.1). */
  float dots(vec2 frag, float coverage, float angleDeg, float mul) {
    float pitch = max(2.0, uHalftonePitch * uHalftoneMul * mul * uHalftoneScale);
    float a = radians(angleDeg);
    vec2 p = frag / pitch;
    vec2 r = vec2(p.x * cos(a) - p.y * sin(a), p.x * sin(a) + p.y * cos(a));
    vec2 cell = fract(r) - 0.5;
    float rad = 0.52 * sqrt(clamp(coverage, 0.0, 1.0));
    return smoothstep(rad + 0.075, rad - 0.075, length(cell));
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -1.0, 1.0);

    // ── banded gradient. Hard steps: a colourist's flat wash, never a smooth ramp.
    //    h == 0 is the skyline and lands exactly on uHorizon; h == 1 is the zenith.
    float t = clamp(h, 0.0, 1.0);
    float bandT = clamp(floor(t * uBands) / max(uBands - 1.0, 1.0), 0.0, 1.0);
    vec3 sky = mix(uHorizon, uZenith, bandT);

    // Horizon fire — a narrow warm wash sitting ON the skyline, banded the same way.
    // Narrow on purpose: it is a rim of light behind the arena, not a sunset.
    float horizonAmt = pow(clamp(1.0 - abs(h) * 5.5, 0.0, 1.0), 1.6);
    float horizonBand = floor(horizonAmt * 4.0) / 4.0;
    sky = mix(sky, uGlow, horizonBand * 0.62);

    // ── stars (upper hemisphere only) ──────────────────────────────────────
    if (uStars > 0.0 && h > -0.02) {
      vec3 sp = d * 165.0;
      vec3 cellId = floor(sp);
      float sh = czHash13(cellId);
      float bright = step(0.983, sh);
      vec3 local = fract(sp) - 0.5;
      float sd = length(local.xy + local.z * 0.5);
      // PAINTED, not twinkling. Each star gets its own fixed brightness from its own cell
      // hash, so the field still has variety — but the whole upper hemisphere no longer
      // re-prints itself five times a second while the player stands still.
      float tw = 0.55 + 0.45 * czHash13(cellId + 31.0);
      float star = bright * smoothstep(0.30, 0.06, sd) * tw;
      sky += uPaper * star * uStars * smoothstep(-0.02, 0.25, h);
    }

    // ── the moon: huge, inked, with comic glow rings ────────────────────────
    float md = distance(d, normalize(uMoonDir));
    float R = uMoonSize;
    // Three hard concentric halo bands — a printed glow, not a soft bloom.
    float halo = 0.0;
    halo += (1.0 - smoothstep(R * 2.4, R * 2.5, md)) * 0.16;
    halo += (1.0 - smoothstep(R * 1.7, R * 1.8, md)) * 0.22;
    halo += (1.0 - smoothstep(R * 1.30, R * 1.36, md)) * 0.30;
    // Dissolve the outer halo into screen tone.
    float haloDots = dots(gl_FragCoord.xy, clamp(1.0 - md / (R * 2.5), 0.0, 1.0) * 0.9, 68.0, 1.5);
    sky += uMoonGlow * halo * (0.40 + 0.60 * haloDots);

    // Radiating spikes — the comic "shine" marks.
    vec3 up = abs(uMoonDir.y) > 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 mx = normalize(cross(up, normalize(uMoonDir)));
    vec3 my = cross(normalize(uMoonDir), mx);
    vec2 mp = vec2(dot(d, mx), dot(d, my));
    float ang = atan(mp.y, mp.x);
    float spikes = pow(abs(cos(ang * 4.0)), 40.0);
    float spikeFall = (1.0 - smoothstep(R * 1.05, R * 2.6, md)) * step(R, md);
    sky += uPaper * spikes * spikeFall * 0.22;

    // The disc itself: ink rim, PAPER body, halftone terminator, crater dots.
    float rimW = R * 0.055;
    float disc = 1.0 - smoothstep(R - rimW, R - rimW * 0.4, md);
    float rimLine = (1.0 - smoothstep(R, R + rimW * 0.5, md)) - disc;
    if (disc > 0.0) {
      // Terminator: the lower-left of the disc falls into printed dots.
      float term = clamp((dot(normalize(mp), normalize(vec2(-0.7, -0.7))) * 0.5 + 0.5) * (md / R) * 1.6, 0.0, 1.0);
      float tdots = dots(gl_FragCoord.xy, term, 15.0, 1.0);
      vec3 body = mix(uPaper, uPaper * 0.42 + uHorizon * 0.5, tdots * 0.9);
      // Craters: a handful of hashed circles, each a flat darker patch with a rim.
      for (int i = 0; i < 5; i++) {
        float fi = float(i);
        vec2 c = (vec2(czHash13(vec3(fi, 1.0, 3.0)), czHash13(vec3(fi, 7.0, 2.0))) - 0.5) * R * 1.35;
        float cr = R * (0.09 + 0.13 * czHash13(vec3(fi, 4.0, 9.0)));
        float cd = length(mp - c);
        body = mix(body, uPaper * 0.68, 1.0 - smoothstep(cr * 0.75, cr, cd));
        body = mix(body, uPaper * 0.34, (1.0 - smoothstep(cr, cr * 1.1, cd)) * step(cr * 0.92, cd));
      }
      sky = mix(sky, body, disc);
    }
    sky = mix(sky, uInk, rimLine);

    // ── clouds: hand-drawn silhouettes on three drifting layers ─────────────
    float cloudMask = 0.0;
    float cloudEdge = 0.0;
    float cloudLit = 0.0;
    float cloudEdge2 = 0.0;
    // Flatten the domain near the horizon so clouds stretch out in perspective.
    vec3 cd = vec3(d.x, d.y * 2.15, d.z);
    for (int L = 0; L < 3; L++) {
      float fl = float(L);
      float scale = 2.3 + fl * 1.7;
      // ON TWELVES. The drift is quantised onto the same 12fps clock the ink boils on, so
      // consecutive frames of a still camera are identical and the sky steps with the line
      // instead of sliding under it. At 0.004 rad/s a step moves the domain by ~3e-4 — far
      // below one pixel, so this costs nothing visually and buys a frozen frame.
      float drift = floor(uTime * 12.0) / 12.0 * uCloudSpeed * (0.35 + fl * 0.5);
      vec3 q = cd * scale + vec3(drift, fl * 3.1, drift * 0.35);
      float n = fbm3(q);
      // Hand-drawn wobble on the contour. Its seed is CONSTANT — it rides the drift, so it
      // steps on twelves with everything else. Driving it from the 60Hz smooth interpolant
      // made every cloud edge in the sky crawl on every frame.
      n += (czNoise3(q * 6.5 + 4.0) - 0.5) * 0.06;
      float thr = 0.665 - uCloudCover * 0.17 + fl * 0.05;
      float m = smoothstep(thr, thr + 0.012, n);
      // The contour has to be a LINE, so its width in noise space scales with the layer's
      // frequency: a fixed 0.023 band collapses to a fraction of a pixel on the low-frequency
      // layers, which is exactly how a cloud becomes a smudge.
      float ew = 0.035 + 0.05 / scale;
      float e = smoothstep(thr - ew, thr - ew * 0.35, n) * (1.0 - m);
      float layerFade = 1.0 - fl * 0.30;
      cloudMask = max(cloudMask, m * layerFade);
      cloudEdge = max(cloudEdge, e * layerFade);
      // Rim light: a bright band just INSIDE the contour, strongest on the moon side.
      float toward = clamp(dot(d, normalize(uMoonDir)) * 0.5 + 0.5, 0.0, 1.0);
      float rimBand = smoothstep(thr + 0.004, thr + 0.050, n) * (1.0 - smoothstep(thr + 0.050, thr + 0.125, n));
      cloudLit = max(cloudLit, m * rimBand * toward * layerFade);
      // A DOUBLED line on the lit side — the cheapest thing that makes a threshold read as
      // something a hand drew. Offset inward, thinner, only where the moon is.
      float e2 = smoothstep(thr + ew * 1.6, thr + ew * 2.4, n)
               * (1.0 - smoothstep(thr + ew * 2.4, thr + ew * 3.4, n));
      cloudEdge2 = max(cloudEdge2, e2 * toward * layerFade);
    }
    // Clouds thin out toward the zenith and pile up at the horizon.
    float cloudBelt = smoothstep(0.58, 0.06, abs(h - 0.20));
    cloudMask *= cloudBelt;
    cloudEdge *= cloudBelt;
    cloudEdge2 *= cloudBelt;
    cloudLit *= cloudBelt;

    vec3 cloudCol = mix(uCloud, uCloudRim, clamp(cloudLit * 1.6, 0.0, 1.0));
    // Screen-tone inside the cloud body so it reads as printed, not as vector art.
    float cdots = dots(gl_FragCoord.xy, 0.55 - cloudLit * 0.35, 45.0, 1.5);
    cloudCol = mix(cloudCol, cloudCol * 0.62, cdots * 0.5 * uHalftone);
    sky = mix(sky, cloudCol, clamp(cloudMask, 0.0, 1.0));
    // The contour is drawn LAST and at full strength — a cloud without an ink line
    // is a smudge, and a smudge is the one thing this art direction cannot have.
    sky = mix(sky, uInk, clamp(cloudEdge2 * 1.1, 0.0, 1.0));
    sky = mix(sky, uInk, clamp(cloudEdge * 2.2, 0.0, 1.0));

    // ── unify the whole sky under one printed screen ────────────────────────
    float lum = dot(sky, vec3(0.299, 0.587, 0.114));
    float sdots = dots(gl_FragCoord.xy, clamp(1.0 - sqrt(clamp(lum, 0.0, 1.0)) * 1.25, 0.0, 1.0), 15.0, 1.0);
    sky = mix(sky, sky * 0.72 + uInk * 0.28, sdots * uHalftone * 0.55);

    gl_FragColor = vec4(sky, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface SkyOptions {
  /** Top-of-dome colour. */
  zenith?: number;
  /** Colour at the horizon line. */
  horizon?: number;
  /** The warm wash sitting on the skyline. Kept narrow — it is a rim, not a sunset. */
  glow?: number;
  /** The moon's concentric halo rings. */
  moonGlow?: number;
  /** Gain on the gradient. The sky is a light source; the palette night tones are not. */
  brightness?: number;
  /** Cloud body / cloud rim. Two hues, like everything else. */
  cloud?: number;
  cloudRim?: number;
  /** 0 = clear night, 1 = overcast. */
  cloudCover?: number;
  /** Radians of drift per second. Keep it slow — 0.004 is a lazy sky. */
  cloudSpeed?: number;
  /** Number of hard gradient bands. */
  bands?: number;
  /** Angular radius of the moon in direction-space. 0.16 is HUGE and correct. */
  moonSize?: number;
  moonDir?: Vector3;
  /** 0..1 star density. */
  stars?: number;
  /** Screen-tone strength over the sky. */
  halftone?: number;
  /** Screen pitch as a MULTIPLE of the frame's pitch. 1 = the same lattice as everything. */
  halftonePitch?: number;
}

/**
 * The sky material. Camera-locked, depth-independent, painted from scratch.
 * Use `buildSkyDome()` unless you need to own the mesh yourself.
 */
export function makeSkyMaterial(opts: SkyOptions = {}): ShaderMaterial {
  const mat = new ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      // The sky is a LIGHT SOURCE, so the gradient is gained up: NIGHT_A/NIGHT_B are
      // near-black in linear light and would be crushed to nothing by the grade's
      // contrast curve, leaving a black rectangle instead of a painted backdrop.
      uZenith: { value: color(opts.zenith ?? PALETTE.NIGHT_A).clone().multiplyScalar((opts.brightness ?? 1.55) * 1.5) },
      uHorizon: { value: color(opts.horizon ?? PALETTE.NIGHT_B).clone().multiplyScalar(opts.brightness ?? 1.55) },
      uGlow: { value: color(opts.glow ?? PALETTE.RUST).clone().multiplyScalar(0.22) },
      uMoonGlow: { value: color(opts.moonGlow ?? PALETTE.PAPER).clone().lerp(color(PALETTE.GOLD), 0.4).multiplyScalar(0.16) },
      uInk: { value: color(PALETTE.INK).clone() },
      uPaper: { value: color(PALETTE.PAPER).clone() },
      // Clouds are MOONLIT: lighter than the sky behind them. An ink contour is
      // invisible on a dark shape against a dark sky — the silhouette has to be the
      // bright element, with the ink drawn around it. That is how night skies are inked.
      uCloud: { value: color(opts.cloud ?? PALETTE.NIGHT_B).clone().multiplyScalar((opts.brightness ?? 1.55) * 1.15) },
      uCloudRim: { value: color(opts.cloudRim ?? PALETTE.PAPER).clone().multiplyScalar(0.42) },
      uMoonDir: { value: (opts.moonDir ?? new Vector3(-0.45, 0.36, -0.82)).clone().normalize() },
      uMoonSize: { value: opts.moonSize ?? 0.155 },
      uBands: { value: opts.bands ?? 7 },
      uCloudCover: { value: opts.cloudCover ?? 0.34 },
      uCloudSpeed: { value: opts.cloudSpeed ?? 0.004 },
      uStars: { value: opts.stars ?? 0.9 },
      uHalftone: { value: opts.halftone ?? 0.85 },
      uHalftoneMul: { value: opts.halftonePitch ?? 1 },
      uHalftonePitch: INK_GLOBALS.uHalftonePitch,
      uHalftoneScale: INK_GLOBALS.uHalftoneScale,
      uTime: INK_GLOBALS.uTime,
      uResolution: INK_GLOBALS.uResolution,
    },
  });
  mat.name = 'SkyMaterial';
  return mat;
}

/**
 * Ready-to-add sky. Put it in the scene root and forget about it: it is camera-locked,
 * never culled, drawn first, and excluded from the ink prepass (LAYER.NO_INK) so the
 * Sobel pass silhouettes the arena against it instead of edging the clouds.
 */
export function buildSkyDome(opts: SkyOptions = {}): Mesh {
  const geo = new SphereGeometry(1, 24, 16);
  const mesh = new Mesh(geo, makeSkyMaterial(opts));
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.matrixAutoUpdate = false;
  mesh.layers.set(LAYER.NO_INK);
  return mesh;
}

/** Point the moon somewhere else — e.g. to line it up with the key light. */
export function setSkyMoonDir(mat: ShaderMaterial, dir: Vector3): void {
  (mat.uniforms.uMoonDir!.value as Vector3).copy(dir).normalize();
}

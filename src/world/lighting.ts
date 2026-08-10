/**
 * WORLD LIGHTING — the three-light rig, banded fog and practical lights.
 * See docs/ART_DIRECTION.md §6 and §9.
 *
 *   warm SODIUM/GOLD key  ·  cool TEAL fill  ·  TEAL/ELECTRIC rim/back
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  BUILD 002 — THE COLOUR PASS.  A histogram of a BUILD 001 plaza frame: 49% of pixels under
 *  0.1 luminance, 10% in the 0.2–0.7 midtone band, 33% over 0.7. A void, a flat, and a blown
 *  ground. This module and `art/palette.ts` are where that gets fixed.
 *
 *  THE COMPOSITION, top to bottom, is now an actual value ladder — a colourist stages a page
 *  by deciding where the eye lands, and the eye lands on the brightest thing in the midtone
 *  band, not on whatever happens to be nearest:
 *
 *    sky            0.15 → 0.24   a real gradient, dark zenith to lit horizon
 *    building mass  0.28 → 0.42   cool SLATE, dark enough to sit behind the action
 *    ground         0.46 → 0.63   warm CONCRETE, the plane everything is read against
 *    light POOLS    0.70 → 0.85   the staged islands the eye is led between
 *    practicals     0.90 → 1.00   and only the practicals are allowed up here
 *    linework       < 0.10        RESERVED. Nothing but ink lives under the floor.
 *
 *  and the hue is a COMPLEMENTARY SPLIT, not a monochrome: warm sodium light against cool
 *  teal shadow, with violet NIGHT_B as the connective mid that keeps them one picture.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * IMPORTANT: `InkMaterial` does not sample scene lights — it reads the `INK_GLOBALS`
 * uniforms instead. So this module is the *single* place that decides the scene's light
 * directions, and it writes them to BOTH the real THREE lights (for any standard material in
 * the game: viewmodel, UI props) and to `INK_GLOBALS`, so the shaded flats and the real lights
 * can never disagree. See `SHADOWS` below for what that costs us.
 *
 * Practicals are two things at once:
 *   1. a real `PointLight` (capped by quality tier), and
 *   2. the *drawn* light — a banded god-ray cone plus a halftoned ground pool — which is
 *      what actually sells it on ink materials. Both merge into ONE draw call each.
 */

import {
  AdditiveBlending,
  AmbientLight,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  Group,
  Mesh,
  PointLight,
  Scene,
  ShaderMaterial,
  Vector3,
} from 'three';
import { PALETTE, READABILITY, color, hexMix, mix } from '@/art/palette';
import { ENEMY_BOIL, INK_GLOBALS, makeInkMaterial, type InkMaterial } from '@/render/materials';
import type { QualityTier } from '@/core/types';
import type { EscalationState } from '@/game/tuning';

// ═════════════════════════════════════════════════════════════════════════════
// THE VISUAL ESCALATION BUS — how round 15 gets to look different from round 1.
//
// The escalation touches two things that have no way to reach each other: the LIGHT RIG (this
// file, built inside `createWorld`) and the POST STACK (`render/pipeline.ts`, built inside
// `createRenderer`, three boot steps earlier). Neither is reachable from a `GameCtx` service —
// `RenderService` exposes the art-direction knobs but not the grade, and `WorldService` is the
// collision contract and exposes no lighting at all.
//
// Rather than widen a FROZEN interface or invent a cross-system import, this is the same seam
// `INK_GLOBALS` already uses one directory over: a module-level singleton that consumers
// SELF-REGISTER with in their own constructors, and that exactly one producer drives.
//
//   producer  `game/rounds/director.ts`  → ESCALATION.apply(escalationAt(round, surge))
//   consumers `ArenaLighting`            → the rig, the fog, the sky, the failing practicals
//             `ComicPipeline`            → the grade, the vignette, the overlay soot
//
// It lives HERE rather than in `render/pipeline.ts` for one measured reason: the headless
// harnesses (`tools/zombie.mjs`, `tools/rig.ts`) reach this file through
// `game/enemies/body.ts → makeEnemyMaterial`, and putting the bus in `pipeline.ts` would drag
// `EffectComposer` and the whole post stack into a node process that has no WebGL context.
// `pipeline.ts` importing `world/lighting.ts` is the direction that costs nothing.
//
// ART §4.1: `apply()` is called ONCE PER ROUND, from `beginRound`. There is no per-frame path
// into any of this, and nothing below interpolates toward anything over time. The look steps
// between rounds and is bit-static within one.
// ═════════════════════════════════════════════════════════════════════════════

/** Anything that changes its appearance with the round number. Implemented, never probed for. */
export interface EscalationSink {
  /** Read what you need NOW — `e` is a shared scratch object and must not be retained. */
  applyEscalation(e: Readonly<EscalationState>): void;
}

class EscalationBus {
  private readonly sinks = new Set<EscalationSink>();
  private current: Readonly<EscalationState> | null = null;

  /** The state in force, or null before the first round has begun. Do not retain. */
  get state(): Readonly<EscalationState> | null { return this.current; }
  get round(): number { return this.current?.round ?? 0; }

  /**
   * Register a consumer. A sink that arrives late (a pipeline rebuilt after a WebGL context
   * loss, a world reloaded mid-run) is brought straight up to the round in force; a sink that
   * registers during boot gets nothing, which is correct — `main.ts::calibrateLighting` runs
   * after `createWorld` and would otherwise be overwriting an escalation it never saw.
   */
  attach(sink: EscalationSink): void {
    this.sinks.add(sink);
    if (this.current) sink.applyEscalation(this.current);
  }

  detach(sink: EscalationSink): void {
    this.sinks.delete(sink);
  }

  /** Fan a freshly computed state out to every consumer. Producer-only. */
  apply(e: Readonly<EscalationState>): void {
    this.current = e;
    for (const s of this.sinks) s.applyEscalation(e);
  }

  /** Re-push the state in force — for anything that clobbers a uniform (a quality change). */
  reapply(): void {
    if (this.current) this.apply(this.current);
  }
}

/** The one instance. See the block above for who drives it and who listens. */
export const ESCALATION = new EscalationBus();

// ─────────────────────────────────────────────────────────────────────────────
// Rig constants — the art direction, in numbers.
// ─────────────────────────────────────────────────────────────────────────────

/** Direction TO the key light. Low and raking, so every box gets a lit face and a dark face. */
export const KEY_DIR = new Vector3(-0.52, 0.72, 0.46).normalize();
/** Direction TO the cool fill — roughly opposite, higher, weaker. */
export const FILL_DIR = new Vector3(0.62, 0.44, -0.65).normalize();
/** Direction TO the rim/back light. Behind the plaza, low, so silhouettes get a cold edge. */
export const RIM_DIR = new Vector3(0.18, 0.26, -0.95).normalize();

/**
 * THE KEY. Lowered 1.22 → 1.02 in the colour pass, and the reason is arithmetic, not taste:
 * a horizontal surface sees N·KEY = 0.72, which `bandify` rounds to the TOP band, so the
 * ground was being multiplied by `1.22 + fill + 0.35` ≈ 2.05× its own albedo. That is why a
 * 0.52 `CONCRETE` road measured 0.70 on screen and why no practical could ever read as a
 * pool: there was no headroom left above the ambient wash for a light to land in.
 */
const KEY_INTENSITY = 1.02;
/**
 * The cool half of the split carries real weight now (0.58 → 0.86). This single number is
 * most of the midtone lift: `lightAmount = key + fill*0.5`, so raising the fill pulls every
 * surface that faces away from the key up off the shadow floor and into the band — which is
 * exactly what a colourist's cool bounce does on a night page.
 */
const FILL_INTENSITY = 0.86;
const RIM_INTENSITY = 0.9;

/**
 * THE AMBIENT FLOOR — the most load-bearing colour in the file.
 *
 * `InkMaterial`'s shadow term is
 *     shade = shadowColor * (uAmbient + 0.55) + albedo * 0.12 + uAmbient * 0.55
 * so `uAmbient` is not a "little bit of light", it is the *height of the floor the whole
 * frame stands on*. BUILD 001 set it to NIGHT_A × 0.9 — a near-black violet, which put the
 * shadow side of every surface in the arena under 0.1 and produced the void the playtester
 * saw. It is now a lifted violet-teal at roughly 3× the luminance.
 *
 * If you raise this further the frame goes milky and the ink stops reading; if you drop it
 * the void comes back. It was tuned against a measured histogram, not by eye.
 */
const AMBIENT_MIX = 0.58;      // NIGHT_B → TEAL
/**
 * 0.72 → 0.82 in the M1.5 pass. The BUILD 002 mean histogram was good (15.8% sub-0.1) but
 * the mean hid two frames worse than BUILD 001 ever was: the west depot arcade at 42.97%
 * sub-0.1 and the south colonnade at 24.15%, both covered routes that took no key at all.
 * Practicals were added inside both (see `world/arena.ts`), and this lifts the floor under
 * every OTHER unlit interior in the map by the same amount. It is the last 0.1 available —
 * past ~0.9 the frame goes milky and the ink stops reading against it.
 */
const AMBIENT_LEVEL = 0.82;
/** Three's own `AmbientLight`, for standard materials only. Matches the ink floor. */
const AMBIENT_LIGHT_INTENSITY = 0.55;

/**
 * How much of a light's hue lands on the flats (`INK_GLOBALS.uLightSat`). Raised 0.62 → 0.70
 * with the palette pass: the warm/cool split only reads if the lights are allowed to be
 * warm and cool. Above ~0.8 the fully-saturated palette lights start annihilating channels
 * and the arena goes monochrome the other way.
 */
const LIGHT_SATURATION = 0.7;

/**
 * BANDED FOG RANGE, metres. Aerial perspective is a VALUE tool before it is an atmosphere
 * tool: it lifts distant geometry toward the sky value in five hard steps, which is what
 * separates the building ring from the backdrop from the sky instead of stacking three
 * different darks on top of each other.
 *
 * BUILD 001 authored 26 / 118 against a 70 m block. BUILD 002's arena is 140 m across with a
 * 198 m diagonal, so 118 m fogged away the entire rescale. These are the correct numbers for
 * the shipped arena and they are now AUTHORITATIVE:
 *
 *   `world/index.ts::fitFogToArena` derives `[max(FOG_NEAR, 140*0.4), max(FOG_FAR, 198*1.15)]`
 *   = `[max(56, 56), max(230, 228)]` = **exactly these values**. That override was left as a
 *   stopgap by the space-scale agent with a request to take the decision here; taking it here
 *   turns the override into the no-op it was designed to become. It can now be deleted by
 *   whoever owns `world/index.ts` (not this agent) without changing a single pixel.
 */
export const FOG_NEAR = 56;
export const FOG_FAR = 230;

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * SHADOWS — read this before you flip the switch back.
 *
 * `InkMaterial` is a raw `ShaderMaterial` with no `<shadowmap_pars_fragment>` and no
 * `lights: true`. It cannot RECEIVE a shadow, and every opaque surface in the arena is an
 * `InkMaterial`. Turning `key.castShadow` on therefore renders a full extra depth pass of
 * the whole city, every frame, onto a map that literally nothing samples. Measured on this
 * arena that is a second traversal of ~52 objects for zero pixels of image.
 *
 * So the arena's contact is DRAWN, which is also the correct answer stylistically (ART §2.5:
 * "ambient occlusion is painted, not computed"):
 *   • the `grime` bucket carries key-aligned painted cast shadows under every block, prop and
 *     kerb, offset along -KEY_DIR and screen-toned rather than flat;
 *   • every practical lays a halftoned ground POOL, and a pool is what makes a light read as
 *     landing on a floor;
 *   • the post stack's banded AO does the small-scale crevice work.
 *
 * The rig is kept fully configured — direction, fitted camera, tier-driven map size — so the
 * day `InkMaterial` grows shadow support (an owner of `render/materials/` would add the
 * standard three chunks plus a `receiveShadow` path) this is a one-line change:
 *     SHADOW_CASTING = true
 * and it will be correct immediately, at a 4.6 cm texel instead of BUILD 001's 17 cm.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
const SHADOW_CASTING = false;

/**
 * The shadow camera is fitted to a box around the FOCUS, not around the whole 140 m arena.
 * Fitting it to `bounds` was a 17 cm texel at 1024; a 52 m half-extent at 2048 is 5.1 cm.
 * `setShadowFocus()` lets a gameplay system slide it with the player for M2.
 */
const SHADOW_HALF = 52;

// ─────────────────────────────────────────────────────────────────────────────
// Practicals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A drawn light source. The arena emits these; lighting turns them into the real
 * `PointLight` plus the god-ray cone and ground pool geometry.
 */
export interface PracticalSpec {
  /** World position of the *emitter* (the lamp lens, the sign tube). */
  position: Vector3;
  /** Palette hex. GOLD marks interactables, HOT marks danger, ELECTRIC marks tech. */
  color: number;
  /** Real point-light intensity multiplier. */
  intensity: number;
  /** Point-light reach, metres. */
  radius: number;
  /** God-ray cone: base radius on the ground. 0 disables the cone. */
  coneRadius: number;
  /** Ground light pool radius. 0 disables the pool. */
  poolRadius: number;
  /** 0 = rock steady, 1 = dying-neon stutter. */
  flicker: number;
  /** Ground height under the practical (pools/cones land here). */
  groundY: number;
  /** Whether the pool sits on a roof/catwalk — purely informational for the integrator. */
  raised?: boolean;
}

export interface LightingOptions {
  /** Arena bounds — the shadow camera is fitted tightly around this. */
  bounds: Box3;
  practicals: readonly PracticalSpec[];
  quality?: QualityTier;
  /** Random seed for the flicker phases. */
  seed?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The drawn light: banded god-ray cones + halftoned ground pools.
//
// Both share one shader. `aParam` carries (t, seed, kind):
//   t    — 0 at the emitter, 1 at the far end (cone height / pool rim)
//   seed — per-practical flicker phase
//   kind — 0 cone, 1 pool
// ─────────────────────────────────────────────────────────────────────────────

const GLOW_VERT = /* glsl */ `
  attribute vec4 aParam;
  varying vec4 vParam;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vParam = aParam;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GLOW_FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3  uColor;
  uniform float uTime;
  uniform float uStrength;
  uniform vec2  uResolution;
  uniform float uHalftoneScale;
  uniform float uHalftonePitch;
  /**
   * THE CITY ACCUMULATES DAMAGE (BUILD 007). aParam.w is a per-practical uniform-random baked
   * on the CPU at build time; every lamp whose hash is below uLampFail has guttered out. It is
   * a threshold on a static attribute, so a "failed" lamp is failed identically on every frame
   * of the round — nothing here flickers, and ART 4.1 is satisfied by construction.
   *
   * It DIMS rather than switching off (uLampDim ~ 0.26). A dead lamp takes its ground pool with
   * it, and the pool is what makes light read as landing on a floor; killing 30% of the pools
   * outright is exactly the value collapse the consistency pass just fixed.
   */
  uniform float uLampFail;
  uniform float uLampDim;
  varying vec4 vParam;
  varying vec3 vN;
  varying vec3 vV;

  /**
   * PER-TUBE BRIGHTNESS — NOT a flicker. See ART_DIRECTION §4.1.
   *
   * BUILD 001 ran a dying-neon stutter here off uTime at 60 Hz. The image-stability agent
   * measured it as the LAST remaining source of movement in a frame with a stationary camera
   * (0.049% of pixels changing per frame, the entire residual after every other pass was
   * frozen). A comic page's light does not buzz — the artist draws one lamp brighter and one
   * lamp dimmer and the reader supplies the buzz.
   *
   * So the curve is now a pure function of the per-practical seed: same shape, same variety
   * lamp-to-lamp, zero time dependence. The image is bit-stable when the camera is still, and
   * the "high-frequency motion" channel is left entirely to enemies (ART §9).
   */
  float tubeLevel(float s) {
    float a = sin(s * 7.3) * 0.5 + 0.5;
    float b = sin(s * 2.1 + 1.7) * 0.5 + 0.5;
    float g = fract(sin(s * 91.71) * 4375.85);
    float dim = step(0.88, g) * 0.28;   // roughly one tube in eight is on its way out
    return clamp(0.84 + 0.16 * a * b - dim, 0.0, 1.1);
  }

  // Comic screen-tone, in PIXELS — printed on the page, never on the object.
  // Pitch-locked to the frame's ONE lattice, exactly like halftoneDots() in the ink
  // material, so it rosettes with the post stack's screen instead of beating into moiré.
  // BUILD 001 hardcoded 6.0 here against a 9.9 device-px post screen — a third lattice.
  float dots(float amount) {
    float pitch = max(2.0, uHalftonePitch * uHalftoneScale);
    vec2 p = gl_FragCoord.xy / pitch;
    vec2 c = fract(vec2(p.x * 0.966 - p.y * 0.259, p.x * 0.259 + p.y * 0.966)) - 0.5;
    float r = 0.52 * sqrt(clamp(amount, 0.0, 1.0));
    return smoothstep(r + 0.08, r - 0.08, length(c));
  }

  void main() {
    float t = clamp(vParam.x, 0.0, 1.0);
    float seed = vParam.y;
    float isPool = vParam.z;

    // Cone: a filled volume is thickest where its surface faces you.
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float cone = pow(facing, 1.3) * pow(1.0 - t, 1.4) * 0.52;
    /**
     * THE POOL IS THE COMPOSITION. Measured against the shipped arena: at eye height a
     * pow(1-t, 1.8) * 0.66 pool contributed 0.002 of frame luminance — it was falling to
     * nothing within a third of its own radius, so an 11 m pool lit a 3 m disc and the
     * street read as one even wash. A light pool has to be a SHAPE with an edge, the way a
     * colourist paints one: nearly flat across its area, then a hard halftoned rim.
     */
    float pool = pow(1.0 - t, 0.85) * 1.45;
    float a = mix(cone, pool, isPool);

    // Quantise into flat comic steps — light is a shape, not a gradient.
    a = floor(a * 5.0 + 0.35) / 5.0;
    a *= tubeLevel(seed) * uStrength;
    // …and this lamp may simply have gone out by now. Static threshold, static result.
    a *= mix(1.0, uLampDim, step(vParam.w, uLampFail));

    // The outer step of the falloff breaks into halftone rather than fading smoothly.
    float edge = smoothstep(0.55, 0.95, t);
    a *= mix(1.0, dots(1.0 - t), edge * 0.85);

    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor * a, a);
    #include <colorspace_fragment>
  }
`;

interface GlowPart {
  positions: number[];
  normals: number[];
  params: number[];
}

function newPart(): GlowPart {
  return { positions: [], normals: [], params: [] };
}

function tri(
  p: GlowPart,
  ax: number, ay: number, az: number, at: number,
  bx: number, by: number, bz: number, bt: number,
  cx: number, cy: number, cz: number, ct: number,
  seed: number, kind: number, fail: number,
): void {
  // Face normal, flat — matches the faceted house style.
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  p.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  p.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  p.params.push(at, seed, kind, fail, bt, seed, kind, fail, ct, seed, kind, fail);
}

function partToGeometry(p: GlowPart): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p.positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(p.normals, 3));
  // vec4: (t, seed, kind, failHash). The 4th lane is what lets one uniform put a deterministic
  // third of the city's lamps out without a second draw call or a per-lamp mesh.
  g.setAttribute('aParam', new Float32BufferAttribute(p.params, 4));
  g.computeBoundingSphere();
  return g;
}

const CONE_SEGMENTS = 13;
const POOL_SEGMENTS = 20;
/**
 * Pools and cone bases float this far above the ground they belong to. The arena stacks
 * painted ground decals from y=0.014 (cracks) up to y=0.12 (sidewalks) — a pool sitting at
 * y=0.03 is simply *behind* the pavement and never draws. Learned the hard way.
 */
const POOL_LIFT = 0.14;

/** Faceted light cone from the emitter down to the ground. Slight per-segment wobble. */
function pushCone(p: GlowPart, s: PracticalSpec, seed: number, fail: number): void {
  const topR = Math.max(0.12, s.coneRadius * 0.16);
  const y0 = s.position.y;
  const y1 = s.groundY + POOL_LIFT;
  if (y0 - y1 < 0.4) return;
  for (let i = 0; i < CONE_SEGMENTS; i++) {
    const a0 = (i / CONE_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / CONE_SEGMENTS) * Math.PI * 2;
    const w0 = 0.95 + 0.09 * Math.sin(i * 2.7 + seed * 5.0);
    const w1 = 0.95 + 0.09 * Math.sin((i + 1) * 2.7 + seed * 5.0);
    const tx0 = s.position.x + Math.cos(a0) * topR;
    const tz0 = s.position.z + Math.sin(a0) * topR;
    const tx1 = s.position.x + Math.cos(a1) * topR;
    const tz1 = s.position.z + Math.sin(a1) * topR;
    const bx0 = s.position.x + Math.cos(a0) * s.coneRadius * w0;
    const bz0 = s.position.z + Math.sin(a0) * s.coneRadius * w0;
    const bx1 = s.position.x + Math.cos(a1) * s.coneRadius * w1;
    const bz1 = s.position.z + Math.sin(a1) * s.coneRadius * w1;
    tri(p, tx0, y0, tz0, 0, bx0, y1, bz0, 1, bx1, y1, bz1, 1, seed, 0, fail);
    tri(p, tx0, y0, tz0, 0, bx1, y1, bz1, 1, tx1, y0, tz1, 0, seed, 0, fail);
  }
}

/**
 * Ground pool: a fan with a jittered rim so the spill looks drawn, not stamped.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WINDING. **EVERY GROUND LIGHT POOL IN BUILD 001 WAS INVISIBLE** and this is why.
 *
 * The fan used to be emitted centre → (cos a0, sin a0) → (cos a1, sin a1) with a1 > a0. In
 * XZ that is CLOCKWISE seen from above, so the face normal came out as (0, -sin(a1-a0), 0)
 * — pointing at the floor. `tri()` bakes that normal per face and the material is FrontSide,
 * so every pool was backface-culled: 55 practicals laying 55 discs of light that never
 * rasterised a single fragment. The cones survived (their side walls happen to wind the
 * other way), which is why the arena looked lit-ish and nothing ever sat on the ground.
 *
 * MEASURED: forcing `side = BackSide` at the plaza raised frame luminance 0.319 → 0.328 with
 * no other change; `FrontSide` and "no pools at all" were bit-identical.
 *
 * The order below is centre → a1 → a0, which is anti-clockwise in XZ and gives +Y — the same
 * convention `flatPoly` in `world/arena.ts` documents for every painted ground decal.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
function pushPool(p: GlowPart, s: PracticalSpec, seed: number, fail: number): void {
  const y = s.groundY + POOL_LIFT;
  for (let i = 0; i < POOL_SEGMENTS; i++) {
    const a0 = (i / POOL_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / POOL_SEGMENTS) * Math.PI * 2;
    const r0 = s.poolRadius * (0.93 + 0.09 * Math.sin(i * 3.1 + seed * 9.0));
    const r1 = s.poolRadius * (0.93 + 0.09 * Math.sin((i + 1) * 3.1 + seed * 9.0));
    tri(
      p,
      s.position.x, y, s.position.z, 0,
      s.position.x + Math.cos(a1) * r1, y, s.position.z + Math.sin(a1) * r1, 1,
      s.position.x + Math.cos(a0) * r0, y, s.position.z + Math.sin(a0) * r0, 1,
      seed, 1, fail,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The rig
// ─────────────────────────────────────────────────────────────────────────────

interface LivePractical {
  light: PointLight | null;
  /** Authored intensity, before the per-tube level and before any lamp failure. */
  base: number;
  seed: number;
  flicker: number;
  /** The baked, time-invariant per-tube level (`tubeLevelCpu`). */
  level: number;
  /**
   * This lamp's uniform-random in [0,1). The escalation puts out every lamp whose hash is below
   * `lampFail`, and the SAME number is baked into `aParam.w` — so the real `PointLight` and the
   * drawn pool can never disagree about which lamps are dead.
   */
  fail: number;
}

/** Module-level scratch — no allocation in anything that can be called per frame. */
const _size = new Vector3();
/** Scratch for the escalation's colour maths. Never returned, never retained. */
const _ember = new Color();
const _out = new Color();

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

const lumaOf = (c: Color): number => LUMA_R * c.r + LUMA_G * c.g + LUMA_B * c.b;

/**
 * AN EMBER SHIFT IS A HUE MOVE, NOT A BRIGHTNESS MOVE.
 *
 * Every "toward RUST" in the escalation goes through here, and the magnitude-matching step is
 * the whole point: `RUST` (0xf4761b) is nine times the luminance of `NIGHT_B`, so a naive
 * `base.lerp(color(RUST), 0.3)` does not bruise the horizon — it triples it, blows the fog past
 * `ENV_VALUE_CEIL` and eats the midtone band the consistency pass just recovered. Scaling the
 * target to the base's own luminance first means `amount` rotates the hue and `gain` is the ONLY
 * thing allowed to change the value, explicitly, where a comment can justify it.
 */
function ember(out: Color, base: Color, hex: number, amount: number, gain = 1): Color {
  out.copy(base);
  if (amount > 0) {
    _ember.copy(color(hex));
    const tl = Math.max(1e-4, lumaOf(_ember));
    _ember.multiplyScalar(lumaOf(base) / tl);
    out.lerp(_ember, Math.min(1, amount));
  }
  if (gain !== 1) out.multiplyScalar(gain);
  return out;
}

// ── The rig's four colours, in one place, so nothing can disagree about them. ──
/** Warm sodium key with a squeeze of gold. The lit half of the complementary split. */
const keyColor = (): Color => mix(PALETTE.SODIUM, PALETTE.GOLD, 0.3);
/** Cool teal fill with a hint of the violet connective. The shadow half of the split. */
const fillColor = (): Color => mix(PALETTE.TEAL, PALETTE.NIGHT_B, 0.28);
/** Cold back light — the edge on every silhouette. */
const rimColor = (): Color => mix(PALETTE.TEAL, PALETTE.ELECTRIC, 0.45);
/** The floor the whole frame stands on. See `AMBIENT_MIX` / `AMBIENT_LEVEL` above. */
const ambientColor = (): Color =>
  mix(PALETTE.NIGHT_B, PALETTE.TEAL, AMBIENT_MIX).multiplyScalar(AMBIENT_LEVEL);

/**
 * Same curve as the shader's `tubeLevel()`, so the real light and the drawn light agree.
 * TIME-INVARIANT by design — see the comment on `tubeLevel` in GLOW_FRAG. It is applied once
 * at build time; nothing in this module writes a light intensity per frame any more.
 */
function tubeLevelCpu(seed: number): number {
  const a = Math.sin(seed * 7.3) * 0.5 + 0.5;
  const b = Math.sin(seed * 2.1 + 1.7) * 0.5 + 0.5;
  const g = Math.abs(Math.sin(seed * 91.71) * 4375.85) % 1;
  const dim = g > 0.88 ? 0.28 : 0;
  return Math.max(0, Math.min(1.1, 0.84 + 0.16 * a * b - dim));
}

/**
 * The base state the escalation interpolates AWAY FROM.
 *
 * Snapshotted lazily, on the first `applyEscalation` rather than in the constructor, and that is
 * load-bearing: `main.ts::calibrateLighting` overwrites `INK_GLOBALS.uAmbient`, `uFillIntensity`
 * and two real light intensities immediately after `createWorld` returns. A constructor snapshot
 * would capture the pre-calibration rig and round 1 would silently un-calibrate the frame. The
 * first round begins on the first pointer lock, long after boot, so by then the snapshot is of
 * the frame the human actually sees at round 1.
 */
interface RigBaseline {
  keyColor: Color;
  keyIntensity: number;
  fillColor: Color;
  fillIntensity: number;
  ambientColor: Color;
  ambientIntensity: number;
  inkKeyColor: Color;
  inkKeyIntensity: number;
  inkFillColor: Color;
  inkFillIntensity: number;
  inkAmbient: Color;
  fogNear: Color;
  fogFar: Color;
  fogRange: [number, number];
  /** Sky uniform bases, empty when this arena has no sky dome. */
  skyZenith: Color | null;
  skyHorizon: Color | null;
  skyGlow: Color | null;
  skyCloudCover: number;
  skyStars: number;
}

/** The sky dome's escalation-relevant uniforms, found by name. See `captureSky`. */
interface SkyUniforms {
  zenith: { value: Color };
  horizon: { value: Color };
  glow: { value: Color };
  cloudCover: { value: number };
  stars: { value: number };
}

/**
 * three types a `ShaderMaterial`'s uniform bag as `{ [k: string]: { value: any } }`, so these
 * two guards are how the sky's uniforms are read WITHOUT an untyped probe: the runtime check is
 * what narrows, the cast only names what the check has already proven.
 */
function colorUniform(u: { value: unknown } | undefined): { value: Color } | null {
  return u && u.value instanceof Color ? (u as { value: Color }) : null;
}
function numberUniform(u: { value: unknown } | undefined): { value: number } | null {
  return u && typeof u.value === 'number' ? (u as { value: number }) : null;
}

export class ArenaLighting implements EscalationSink {
  /** Everything this module draws. Added to the world root by `WorldSystem`. */
  readonly group = new Group();
  readonly key: DirectionalLight;
  readonly fill: DirectionalLight;
  readonly rim: DirectionalLight;
  readonly ambient: AmbientLight;

  private readonly glowMaterials: ShaderMaterial[] = [];
  /** The palette hex each merged glow bucket was built from, parallel to `glowMaterials`. */
  private readonly glowHex: number[] = [];
  private readonly glowBase: Color[] = [];
  private readonly glowMeshes: Mesh[] = [];
  private readonly live: LivePractical[] = [];
  private readonly bounds: Box3;
  private readonly shadowFocus = new Vector3();
  private tier: QualityTier;

  // ── visual escalation ─────────────────────────────────────────────────────
  private baseline: RigBaseline | null = null;
  private sky: SkyUniforms | null = null;
  private scene: Scene | null = null;
  /** The round in force, purely for the debug readout. 0 = nothing applied yet. */
  private escRound = 0;

  constructor(opts: LightingOptions) {
    this.bounds = opts.bounds.clone();
    this.tier = opts.quality ?? 'high';
    this.group.name = 'lighting';

    const size = this.bounds.getSize(new Vector3());
    const center = this.bounds.getCenter(new Vector3());
    const reach = Math.max(size.x, size.z) * 0.75 + 12;

    // ── Key: warm sodium, raking, the only shadow caster. ───────────────────
    // SODIUM→GOLD, not RUST→GOLD: RUST is fire, and a fire-coloured key made the whole
    // city read as if it were burning, which is a story beat, not a street.
    this.key = new DirectionalLight(keyColor(), KEY_INTENSITY);
    this.key.position.copy(center).addScaledVector(KEY_DIR, reach);
    this.key.target.position.copy(center);
    this.key.name = 'keyLight';
    this.key.shadow.bias = -0.0008;
    this.key.shadow.normalBias = 0.035;
    this.key.shadow.radius = 3;
    this.group.add(this.key, this.key.target);
    this.setShadowFocus(center);

    // ── Fill: cool TEAL bounce from the opposite side. Never a flat wash. ───
    // This is the cool half of the complementary split and it does the midtone work.
    this.fill = new DirectionalLight(fillColor(), FILL_INTENSITY);
    this.fill.position.copy(center).addScaledVector(FILL_DIR, reach);
    this.fill.target.position.copy(center);
    this.fill.name = 'fillLight';
    this.group.add(this.fill, this.fill.target);

    // ── Rim: cold back light. This is what puts a bright edge on every silhouette. ─
    this.rim = new DirectionalLight(rimColor(), RIM_INTENSITY);
    this.rim.position.copy(center).addScaledVector(RIM_DIR, reach);
    this.rim.target.position.copy(center);
    this.rim.name = 'rimLight';
    this.group.add(this.rim, this.rim.target);

    // Ambient for standard materials only — matched to the ink shader's shadow floor so a
    // viewmodel or a prop on a MeshStandardMaterial sits in the same night as the city.
    this.ambient = new AmbientLight(ambientColor(), AMBIENT_LIGHT_INTENSITY);
    this.group.add(this.ambient);

    this.writeInkGlobals();
    this.buildPracticals(opts.practicals, opts.seed ?? 0xa11e);
    this.applyTier();
    // Self-register. Nothing is pushed at boot (the bus has no state until round 1), so this
    // cannot fight `calibrateLighting`; see `RigBaseline`.
    ESCALATION.attach(this);
  }

  /** Materials and shaded flats must agree — the ink shader reads these, not the lights. */
  private writeInkGlobals(): void {
    INK_GLOBALS.uKeyDir.value.copy(KEY_DIR);
    INK_GLOBALS.uKeyColor.value.copy(keyColor());
    INK_GLOBALS.uKeyIntensity.value = KEY_INTENSITY;
    INK_GLOBALS.uFillDir.value.copy(FILL_DIR);
    INK_GLOBALS.uFillColor.value.copy(fillColor());
    INK_GLOBALS.uFillIntensity.value = FILL_INTENSITY;
    INK_GLOBALS.uAmbient.value.copy(ambientColor());
    INK_GLOBALS.uRimDir.value.copy(RIM_DIR);
    INK_GLOBALS.uAccent.value.copy(color(PALETTE.TEAL)).lerp(color(PALETTE.ELECTRIC), 0.35);
    INK_GLOBALS.uLightSat.value = LIGHT_SATURATION;
    // Fog near is the connective violet, fog far is the sky. A surface 200 m away and the
    // sky behind it are then the SAME value, which is what makes the backdrop read as
    // distance instead of as a second, closer wall.
    INK_GLOBALS.uFogColorNear.value.copy(color(PALETTE.NIGHT_B));
    INK_GLOBALS.uFogColorFar.value.copy(color(PALETTE.NIGHT_A));
    INK_GLOBALS.uFogRange.value.set(FOG_NEAR, FOG_FAR);
  }

  /**
   * Slide the shadow camera's box. Costs nothing today (see `SHADOW_CASTING`), exists so an
   * M2 system can call `lighting.setShadowFocus(player.position)` the moment ink materials
   * can receive a shadow, and get a 5 cm texel instead of a 17 cm one.
   */
  setShadowFocus(p: Vector3): void {
    this.shadowFocus.set(p.x, 0, p.z);
    const size = this.bounds.getSize(_size);
    const reach = Math.max(size.x, size.z) * 0.75 + 12;
    const half = Math.min(SHADOW_HALF, Math.max(size.x, size.z) * 0.62);
    const cam = this.key.shadow.camera;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 1; cam.far = reach * 2.4;
    cam.updateProjectionMatrix();
    this.key.position.copy(this.shadowFocus).addScaledVector(KEY_DIR, reach);
    this.key.target.position.copy(this.shadowFocus);
    this.key.target.updateMatrixWorld();
  }

  /**
   * One merged mesh per practical *colour*, so eight lamps cost one draw call, not eight.
   */
  private buildPracticals(specs: readonly PracticalSpec[], seed: number): void {
    const byColor = new Map<number, GlowPart>();
    let i = 0;
    for (const s of specs) {
      const phase = ((seed + i * 37) % 97) * 0.137;
      // Which lamps die first, decided once, from the arena seed — so a `?seed=` replay dies in
      // the same order, and so the same lamp is dead in the pool, in the cone and in the real
      // point light. Deliberately independent of `phase`: the brightest lamps must not also be
      // the ones that survive, or the escalation would only ever kill the dim ones.
      const fail = Math.abs(Math.sin((seed + 1) * 0.0113 + (i + 1) * 12.9898) * 43758.5453) % 1;
      i++;
      let part = byColor.get(s.color);
      if (!part) { part = newPart(); byColor.set(s.color, part); }
      if (s.coneRadius > 0) pushCone(part, s, phase, fail);
      if (s.poolRadius > 0) pushPool(part, s, phase, fail);

      const light = new PointLight(color(s.color), s.intensity, s.radius, 2);
      light.position.copy(s.position);
      light.name = 'practical';
      // The per-tube level is baked in ONCE, here. Nothing writes an intensity per frame.
      const lvl = s.flicker <= 0 ? 1 : 1 - s.flicker + s.flicker * tubeLevelCpu(phase);
      light.intensity = s.intensity * lvl;
      this.live.push({ light, base: s.intensity, seed: phase, flicker: s.flicker, level: lvl, fail });
      this.group.add(light);
    }

    for (const [hex, part] of byColor) {
      if (part.positions.length === 0) continue;
      const mat = new ShaderMaterial({
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {
          uColor: { value: color(hex).clone() },
          uTime: { value: 0 },
          uStrength: { value: 1 },
          uResolution: INK_GLOBALS.uResolution,
          uHalftoneScale: INK_GLOBALS.uHalftoneScale,
          uHalftonePitch: INK_GLOBALS.uHalftonePitch,
          uLampFail: { value: 0 },
          uLampDim: { value: 1 },
        },
      });
      mat.name = 'GodRayMaterial';
      const mesh = new Mesh(partToGeometry(part), mat);
      mesh.name = 'practicalGlow';
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.layers.enable(2); // emissive/bloom
      this.glowMaterials.push(mat);
      this.glowHex.push(hex);
      this.glowBase.push(color(hex).clone());
      this.glowMeshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Fog is a *colour gradient in steps* — set it on the scene too, for non-ink materials. */
  applyToScene(scene: Scene): void {
    scene.fog = new Fog(PALETTE.NIGHT_A, FOG_NEAR, FOG_FAR);
    this.scene = scene;
    this.captureSky(scene);
  }

  /**
   * FIND THE SKY.
   *
   * The dome is built by `render/materials::buildSkyDome` and placed by `world/arena.ts`, and
   * neither hands a handle to anything — the arena's own comment is "the world just places it".
   * The escalation needs it, because the sky is a fifth of the frame and therefore the single
   * cheapest large-area change available: no geometry, no draw call, no extra pass.
   *
   * So it is found by NAME, at the one moment the world guarantees the arena is already in the
   * scene (`WorldSystem.init` adds the root before calling `applyToScene`). This is a typed
   * narrowing of three's own `Material` union, not an untyped probe — if the dome is absent or
   * its uniforms are ever renamed, `this.sky` stays null and every sky term is skipped.
   *
   * **If `world/arena.ts` ever gains an owner again: publish the sky material on `Arena` and
   * pass it in through `LightingOptions`, and delete this.**
   */
  private captureSky(scene: Scene): void {
    if (this.sky) return;
    let found: SkyUniforms | null = null;
    scene.traverse((o) => {
      if (found !== null || o.name !== 'sky' || !(o instanceof Mesh)) return;
      const mat = o.material;
      if (Array.isArray(mat) || !(mat instanceof ShaderMaterial)) return;
      const u = mat.uniforms;
      const zenith = colorUniform(u.uZenith);
      const horizon = colorUniform(u.uHorizon);
      const glow = colorUniform(u.uGlow);
      const cloudCover = numberUniform(u.uCloudCover);
      const stars = numberUniform(u.uStars);
      if (!zenith || !horizon || !glow || !cloudCover || !stars) return;
      found = { zenith, horizon, glow, cloudCover, stars };
    });
    this.sky = found;
  }

  /**
   * Shadow maps are the renderer's switch, but the rig owns the decision — and the decision
   * is currently NO, at every tier, because nothing in the arena can receive one. See the
   * `SHADOW_CASTING` block at the top of this file: this is a measured perf reclaim, not an
   * oversight, and it is one constant away from being reversed.
   */
  applyToRenderer(renderer: { shadowMap: { enabled: boolean } }): void {
    renderer.shadowMap.enabled = SHADOW_CASTING && (this.tier === 'high' || this.tier === 'ultra');
  }

  get quality(): QualityTier { return this.tier; }

  setQuality(tier: QualityTier): void {
    this.tier = tier;
    this.applyTier();
  }

  private applyTier(): void {
    const t = this.tier;
    const shadows = SHADOW_CASTING && (t === 'high' || t === 'ultra');
    this.key.castShadow = shadows;
    // Fitted to SHADOW_HALF (52 m), not to the 140 m arena: 2048 over 104 m is a 5.1 cm
    // texel — a real contact shadow — where BUILD 001's 1024 over 140 m was 17 cm.
    const map = t === 'ultra' ? 3072 : 2048;
    this.key.shadow.mapSize.set(map, map);

    // Point lights force shader permutations on standard materials — budget them hard.
    // NOTE: they are also nearly decorative right now, because `InkMaterial` ignores scene
    // lights entirely. The *drawn* pools below are what the player actually sees, which is
    // why the pool is the thing that got stronger in BUILD 002 and not the point light.
    const maxLights = t === 'low' ? 0 : t === 'med' ? 3 : t === 'high' ? 6 : 8;
    let used = 0;
    for (const p of this.live) {
      if (!p.light) continue;
      const on = used < maxLights;
      p.light.visible = on;
      if (on) used++;
    }
    // The drawn light is the art direction, so it survives everywhere but LOW.
    const glow = t !== 'low';
    for (const m of this.glowMeshes) m.visible = glow;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VISUAL ESCALATION — the night deepens and turns hostile.
  //
  // Called ONCE PER ROUND from the bus at the top of this file. Every write below is an
  // absolute value derived from the round, never a delta and never an interpolation toward
  // something, so re-applying the same round is idempotent and applying a round twice in a row
  // is a no-op. That property is what makes `CZ.rounds.setEscalation(n)` a legitimate way to
  // audit the look: it produces exactly the frame round `n` produces.
  // ═══════════════════════════════════════════════════════════════════════════

  /** The round the LOOK is currently set to. Not the same thing as the director's round. */
  get escalationRound(): number { return this.escRound; }

  applyEscalation(e: Readonly<EscalationState>): void {
    const b = this.baseline ?? this.snapshot();
    this.escRound = e.round;

    // ── the rig ───────────────────────────────────────────────────────────
    // The warm key turns from sodium street light to firelight and loses a little punch; the
    // cool fill retreats hardest, which is what makes the night stop being pretty; the ambient
    // FLOOR barely moves, because it is the floor (see `AMBIENT_LEVEL`).
    this.key.color.copy(ember(_out, b.keyColor, PALETTE.RUST, e.keyEmber));
    this.key.intensity = b.keyIntensity * e.keyGain;
    this.fill.intensity = b.fillIntensity * e.fillGain;
    this.ambient.color.copy(ember(_out, b.ambientColor, PALETTE.RUST, e.ambientEmber));
    this.ambient.intensity = b.ambientIntensity * e.ambientGain;

    // The ink materials do not sample scene lights, so the same decisions have to be written
    // twice or the flats and the real lights disagree. Same contract as `writeInkGlobals`.
    INK_GLOBALS.uKeyColor.value.copy(ember(_out, b.inkKeyColor, PALETTE.RUST, e.keyEmber));
    INK_GLOBALS.uKeyIntensity.value = b.inkKeyIntensity * e.keyGain;
    INK_GLOBALS.uFillIntensity.value = b.inkFillIntensity * e.fillGain;
    INK_GLOBALS.uAmbient.value.copy(
      ember(_out, b.inkAmbient, PALETTE.RUST, e.ambientEmber, e.ambientGain));

    // ── fog: the world closes in ──────────────────────────────────────────
    // Aerial perspective is this file's main value tool, so it is also the escalation's. Enemies
    // are authored `fog: 0` and never fade (ART §9), so tightening the fog RAISES the contrast
    // between a threat and the city behind it rather than hiding anything.
    INK_GLOBALS.uFogColorNear.value.copy(ember(_out, b.fogNear, PALETTE.RUST, e.fogNearEmber));
    INK_GLOBALS.uFogColorFar.value.copy(ember(_out, b.fogFar, PALETTE.RUST, e.fogFarEmber));
    const near = b.fogRange[0] * e.fogNearScale;
    const far = b.fogRange[1] * e.fogFarScale;
    INK_GLOBALS.uFogRange.value.set(near, far);
    const fog = this.scene?.fog;
    if (fog instanceof Fog) {
      fog.color.copy(ember(_out, b.fogFar, PALETTE.RUST, e.fogFarEmber));
      fog.near = near;
      fog.far = far;
    }

    // ── the sky bruises ───────────────────────────────────────────────────
    const sky = this.sky;
    if (sky && b.skyZenith && b.skyHorizon && b.skyGlow) {
      // Zenith sinks toward INK: the top of the sky closes down, which is also what puts the
      // building ring back on top of it as the facades themselves get darker.
      sky.zenith.value.copy(b.skyZenith).lerp(color(PALETTE.INK), e.skyDeepen);
      sky.horizon.value.copy(ember(_out, b.skyHorizon, PALETTE.RUST, e.skyHorizonEmber));
      /**
       * THE ONLY RESERVED HUE IN THE ESCALATION, and it is here on purpose. `uGlow` is a narrow
       * rim on the horizon line that the sky shader already multiplies by 0.22 — it is 60+ m
       * behind anything the player can shoot, it never touches the mid-frame, and it goes
       * SODIUM → RUST first and only then a short way toward HOT. ART §9's requirement is that
       * nothing competes with an enemy silhouette; a distant gradient at the very bottom of the
       * sky does not, and the squint probe (per-cell `g - max(r,b)`) is unmoved by it either
       * way, because HOT carries no green. Measured, not assumed — see the handoff table.
       */
      ember(_out, b.skyGlow, PALETTE.RUST, e.skyEmberRust, e.skyGlowGain);
      sky.glow.value.copy(_out).lerp(
        _ember.copy(color(PALETTE.HOT)).multiplyScalar(lumaOf(_out) / Math.max(1e-4, lumaOf(color(PALETTE.HOT)))),
        e.skyEmberHot,
      );
      // Relative to whatever the arena authored, so this cannot drift away from `world/arena.ts`.
      sky.cloudCover.value = Math.min(1, b.skyCloudCover + e.cloudAdd);
      sky.stars.value = b.skyStars * e.starMul;
    }

    // ── the city accumulates damage ───────────────────────────────────────
    for (const m of this.glowMaterials) {
      const f = m.uniforms.uLampFail;
      const d = m.uniforms.uLampDim;
      if (f) f.value = e.lampFail;
      if (d) d.value = e.lampFailDim;
    }
    for (let i = 0; i < this.glowMaterials.length; i++) {
      // Only the SODIUM buckets turn. `GOLD` marks interactables (ART §6) and `ELECTRIC` marks
      // tech — moving either would break a gameplay signal to buy an atmosphere beat.
      if (this.glowHex[i] !== PALETTE.SODIUM) continue;
      const u = this.glowMaterials[i]?.uniforms.uColor;
      const base = this.glowBase[i];
      if (!u || !base || !(u.value instanceof Color)) continue;
      u.value.copy(ember(_out, base, PALETTE.RUST, e.lampEmber));
    }
    for (const p of this.live) {
      if (!p.light) continue;
      const dim = p.fail < e.lampFail ? e.lampFailDim : 1;
      p.light.intensity = p.base * p.level * dim;
    }
  }

  /** Freeze the frame the escalation departs from. See `RigBaseline` for why it is lazy. */
  private snapshot(): RigBaseline {
    const sky = this.sky;
    const b: RigBaseline = {
      keyColor: this.key.color.clone(),
      keyIntensity: this.key.intensity,
      fillColor: this.fill.color.clone(),
      fillIntensity: this.fill.intensity,
      ambientColor: this.ambient.color.clone(),
      ambientIntensity: this.ambient.intensity,
      inkKeyColor: INK_GLOBALS.uKeyColor.value.clone(),
      inkKeyIntensity: INK_GLOBALS.uKeyIntensity.value,
      inkFillColor: INK_GLOBALS.uFillColor.value.clone(),
      inkFillIntensity: INK_GLOBALS.uFillIntensity.value,
      inkAmbient: INK_GLOBALS.uAmbient.value.clone(),
      fogNear: INK_GLOBALS.uFogColorNear.value.clone(),
      fogFar: INK_GLOBALS.uFogColorFar.value.clone(),
      // The arena's own derived range, not this file's constants — `world/index.ts` widens it to
      // fit the shipped 140 m block and writes it after `applyToScene`.
      fogRange: [INK_GLOBALS.uFogRange.value.x, INK_GLOBALS.uFogRange.value.y],
      skyZenith: sky ? sky.zenith.value.clone() : null,
      skyHorizon: sky ? sky.horizon.value.clone() : null,
      skyGlow: sky ? sky.glow.value.clone() : null,
      skyCloudCover: sky ? sky.cloudCover.value : 0,
      skyStars: sky ? sky.stars.value : 0,
    };
    this.baseline = b;
    return b;
  }

  /**
   * Per-frame hook. Deliberately EMPTY of image content.
   *
   * ART §4.1: "stand still, don't touch the mouse, and the image must be frozen." BUILD 001
   * animated every practical's intensity and every god-ray's alpha off `uTime` at 60 Hz, and
   * that was measured as the last thing in the frame still moving with a parked camera. The
   * per-tube level is now baked at build time (`tubeLevelCpu`) and the shader's `tubeLevel()`
   * has no time term, so there is nothing left to drive here.
   *
   * `uTime` is still written so the uniform stays live for anything that needs a clock later
   * (a scripted blackout, a power-up surge) — no shader currently reads it.
   */
  update(dt: number): void {
    void dt;
  }

  dispose(): void {
    ESCALATION.detach(this);
    for (const m of this.glowMeshes) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    for (const m of this.glowMaterials) m.dispose();
    this.glowMeshes.length = 0;
    this.glowMaterials.length = 0;
    this.glowHex.length = 0;
    this.glowBase.length = 0;
    this.sky = null;
    this.scene = null;
    for (const p of this.live) if (p.light) { p.light.dispose(); this.group.remove(p.light); }
    this.live.length = 0;
    this.key.dispose();
    this.fill.dispose();
    this.rim.dispose();
    this.group.clear();
  }
}

export function buildLighting(opts: LightingOptions): ArenaLighting {
  return new ArenaLighting(opts);
}

// ═════════════════════════════════════════════════════════════════════════════
// THE ENEMY RECIPE — ART_DIRECTION §9, as code.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The reserved-channel contract, in one factory. **M2 enemy agents: use this, do not hand-roll
 * an `InkMaterial` for a zombie.** It is what makes a zombie findable in a tenth of a second,
 * and it is a gameplay requirement, not a taste one.
 *
 * The whole arena was authored to make this work. Every environment surface lives between
 * `READABILITY.ENV_VALUE_FLOOR` and `ENV_VALUE_CEIL`; the darks below the floor belong to
 * linework and the brights above the ceiling belong to practicals. An enemy therefore gets
 * BOTH extremes at once and can never sink into a background:
 *
 *   1. HUE — `ACID` (or `HOT` for a special), on BOTH bands: the lit half and the shadow half.
 *      No environment surface may use either hue. The M1.5 pass had to enforce that for real
 *      — sixteen wall posters were cycling ACID "INFECTED" and HOT "DANGER", and on the ring
 *      boulevard the environment measured a HIGHER green dominance (+0.042) than an actual
 *      enemy (+0.038). See the poster table in `world/arena.ts` §6.8.
 *   2. RIM — always on, viewer-facing. Half of it is the material Fresnel below; the other
 *      and more important half is the reserved-channel probe in `render/passes/ink.ts`, which
 *      finds the green and draws a real screen-space edge. A per-fragment Fresnel cannot edge
 *      flat-shaded geometry — every face normal is constant — so the material alone was never
 *      going to deliver this, which is why the shipped recipe measured 0.088 instead of 0.209.
 *   3. INK — `READABILITY.ENEMY_OUTLINE_PX` (8) is the heaviest line in the game. The heaviest
 *      prop in the arena is `mass` at 6. The inker gives the character the bold line. Enemies
 *      also get `ENEMY_BOIL`; the environment is inked steady (ART §9, §4.1).
 *   4. VALUE — a hard 3-band cel with a bright terminator, plus a small always-on emissive
 *      floor in the enemy's own hue, so the channel survives a dark interior and 25 m of air.
 *   5. NO FOG. `fog: 0`. Aerial perspective belongs to the city, never to a threat.
 *
 * MEASURE IT, do not trust it: drop capsules built from this factory at the plaza, down a
 * radial street at 20–25 m, inside the west arcade and on the NE roof, blur the frame to a
 * 48×27 grid and read per-cell `g - max(r,b)`. The enemy must clear +0.12 and no environment
 * cell anywhere may clear +0.005.
 *
 * `outlinePx` is returned rather than applied because the silhouette is a separate inverted
 * hull built by `buildOutlineHull` — pass it straight through.
 */
export interface EnemyMaterialOptions {
  /** Body hue. `ACID` for standard flesh, `HOT` for a special/elite. Nothing else. */
  hue?: number;
  /** Darker second hue for the shadow band. Two hues max, ART §1. */
  shadow?: number;
  /** 1 = standard. Push to 1.3 for a boss that must read across the whole arena. */
  presence?: number;
  name?: string;
}

export interface EnemyMaterialRecipe {
  material: InkMaterial;
  /** Feed to `buildOutlineHull({ thickness })`. The heaviest ink weight in the game. */
  outlinePx: number;
  /**
   * Feed to `buildOutlineHull({ boil })`. ART §9 reserves high-frequency motion to enemies,
   * so the environment now inks at `ENV_BOIL` (0.03) and this is the only thing in the game
   * that gets the full `ENEMY_BOIL` (0.08) hand-drawn wobble. Pass it; do not hardcode it.
   */
  boil: number;
}

export function makeEnemyMaterial(opts: EnemyMaterialOptions = {}): EnemyMaterialRecipe {
  const hue = opts.hue ?? PALETTE.ACID;
  const presence = opts.presence ?? 1;
  const material = makeInkMaterial({
    color: hue,
    /**
     * THE SHADOW SIDE STAYS IN THE RESERVED HUE. It used to be raw `NIGHT_B` — a violet
     * with no green in it at all — so half of every silhouette left the reserved channel
     * the moment it turned away from the key, and the squint test saw a two-tone blob
     * instead of a green one. Measured at nine positions, the recipe scored 0.088 green
     * dominance on the bright plaza and literally 0.000 at 25 m against ART §9's claimed
     * 0.209. Mixing the hue back into the shadow band is most of the difference.
     */
    shadowColor: opts.shadow ?? hexMix(hue, PALETTE.NIGHT_B, 0.55),
    // The rim is the contract. It never turns off and it is always the accent, not the hue,
    // so an ACID body gets a HOT-ward edge and reads as lit from behind by something wrong.
    rimColor: hue === PALETTE.HOT ? PALETTE.GOLD : PALETTE.ACID,
    /**
     * 0.62 → 1.25, and `rimPower` 1.7 → 1.1 so the term reaches further round the form.
     * This is the material's grazing-angle FILL; the drawn always-on rim is the reserved
     * channel probe in `render/passes/ink.ts` (`uInkEnemyRimColor`), which keys off exactly
     * the green dominance this recipe guarantees. The two are one feature: the material
     * makes the enemy the only green thing in the frame, the ink pass finds it and edges it.
     */
    rimStrength: 1.25 * presence,
    /**
     * FAR: a wide exponent so the term floods the silhouette and the body is findable across the
     * arena — the ART §9 contract, measured by the squint test.
     */
    rimPower: 1.1,
    /**
     * NEAR: a tight exponent so the rim hugs the edge instead of washing the surface.
     *
     * The wide far-field rim is what a player sees at 25 m and it is correct there. At melee
     * range it covered nearly the whole body, and combined with `toneFloor: 0` and a halved
     * halftone it turned a fully modelled corpse — skull, brow, jaw, hands, feet, torn coat —
     * into a flat green mass. The playtester's words: "enemies skeletons should be more
     * consistent and precise". The mesh was never the problem; the shading was hiding it.
     *
     * Measured: narrowing the rim alone restored the form but dropped squint dominance to 0.104
     * against the 0.12 floor. Distance-splitting the term keeps both.
     */
    rimPowerNear: 3.2,
    rimNearMul: 0.85,
    rimNear: 3.5,
    rimFar: 13,
    bands: 3,
    /**
     * 0.85 → 0.4. At 0.85 the shadow band was 85% screened into dots, and a dot screen
     * averages a hue toward the paper between the dots — which removes the very green the
     * enemy is supposed to be found by. An enemy still prints; it prints lighter than a wall.
     */
    /**
     * Raised 0.4 → 0.72 with `toneFloor` off the floor. The shadow band on an enemy now carries
     * screen-tone like every other surface in the game, which is what makes a shoulder read as
     * separate from a chest at conversation distance.
     */
    halftone: 0.72,
    /** No tone floor on a character: the body is a shape, not a background wash. */
    toneFloor: 0.18,
    /**
     * 82.5°, and the old value of 105° was arithmetically wrong rather than merely a taste
     * call. `halftoneDots()` screens with `fract()` on a SQUARE lattice, so the dot pattern
     * repeats every 90°: **105° IS 15°** — the plate `mass` (every building facade) and
     * `grime` (the painted cast shadow on every road) already print on. The comment claimed
     * "30° off every environment family"; the enemy was in fact sharing a plate with the two
     * largest surfaces it is ever seen against, which is the one place the separation had to
     * hold. The arena's families sit on the 15° grid (0/15/30/45/60/75), so 82.5° is 7.5°
     * from the nearest of them in both directions — the maximum separation available once
     * every 15° slot is taken. See the SCREEN ANGLES note in `world/arena.ts`.
     */
    halftoneAngle: 82.5,
    specular: 0.5,
    gleam: 0.35 * presence,
    gleamSize: 0.34,
    gleamColor: PALETTE.PAPER,
    /**
     * ZERO. `fog: 0.35` still dragged a body 35% of the way to the fog colour with distance,
     * which is why the capsule at 25 m measured as a dark smudge and contributed nothing to
     * green dominance. A zombie at 90 m is a threat you must count; aerial perspective is
     * for the city. This is the line ART §9 always meant by "enemies do not fade".
     */
    fog: 0,
    /**
     * A FLOOR OF THE ENEMY'S OWN HUE, always on, independent of the rig. It is small (0.16)
     * — this is not a glowing zombie — but it is what makes the reserved channel survive a
     * dark arcade, a bright plaza floor and 25 m of distance alike, because it does not
     * depend on a light landing on the body. Without it the "findable in a tenth of a
     * second" contract is a promise the material cannot keep in a shadow.
     */
    emissive: hue,
    emissiveIntensity: 0.16 * presence,
    name: opts.name ?? 'Ink_enemy',
  });
  return { material, outlinePx: READABILITY.ENEMY_OUTLINE_PX * presence, boil: ENEMY_BOIL };
}

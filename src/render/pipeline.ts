/**
 * THE POST STACK — ART_DIRECTION §4, in the fixed order. The order is load-bearing.
 *
 *   1. scene render        RenderPass, into a linear HalfFloat buffer
 *   2. ink edge            passes/ink.ts        — depth+normal Sobel, boiling line
 *   3. halftone/screentone passes/halftone.ts   — tone + banded AO + banded fog wash
 *   4. selective bloom     passes/bloom.ts      — LAYER.BLOOM + threshold, quantised halo
 *   5. chromatic offset    passes/chromatic.ts ┐
 *   6. colour grade        passes/grade.ts     │  fused into ONE fragment shader by
 *   7. paper grain         passes/grain.ts     │  default — five full-screen round trips
 *   8. vignette + frame    passes/vignette.ts  │  collapsed into one. Pass `fuse: false`
 *   9. overlays            passes/overlay.ts   ┘  to run them discretely for debugging.
 *
 * Passes 1–3 are NEVER dropped by a quality tier: losing them loses the art direction.
 * Tiers drop resolution, then bloom levels, then grain/chromatic — in that order.
 *
 * COLOUR SPACE: linear through pass 4; `grade` converts to display-referred sRGB and the
 * result is written to the canvas verbatim. No pass includes <colorspace_fragment>, and
 * there is deliberately no OutputPass — the grade owns the encode.
 */

import { HalfFloatType, WebGLRenderTarget } from 'three';
import type { PerspectiveCamera, Scene, Texture, Vector3, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { PALETTE, hexMix } from '@/art/palette';
import { ESCALATION, type EscalationSink } from '@/world/lighting';
import type { EscalationState } from '@/game/tuning';

import {
  buildPass, collectUniforms, makeCommonUniforms, tintVec,
  type CommonUniforms, type PassChunk, type Uniform, type Uniforms,
} from './passes/common';
import { makeInkChunk, setInkSources, setInkViewDirs, type InkPassOptions } from './passes/ink';
import { makeHalftoneChunk, setHalftoneDepth, type HalftonePassOptions } from './passes/halftone';
import { ComicBloomPass, type BloomOptions } from './passes/bloom';
import { makeChromaticChunk, type ChromaticOptions } from './passes/chromatic';
import { makeGradeChunk, type GradeOptions } from './passes/grade';
import { makeGrainChunk, type GrainOptions } from './passes/grain';
import { makeVignetteChunk, type VignetteOptions } from './passes/vignette';
import { makeOverlayChunk, type OverlayOptions } from './passes/overlay';
import { INK_GLOBALS } from './materials/index';

/**
 * Drawing-buffer height the ink boil's authored amplitude is measured against. At or below
 * this the boil runs at full strength; above it the amplitude is scaled down. See
 * `ComicPipeline.applyBoilScale`.
 */
const BOIL_REFERENCE_HEIGHT = 1250;
/** Exponent on that ratio. >1 because the measured §4.1 cost grew faster than resolution. */
const BOIL_FALLOFF = 1.6;

export interface PipelineOptions {
  /**
   * Weld passes 5–9 into a single fragment shader (default). They are all cheap per-pixel
   * maths on the same texel, so five render-target round trips buy nothing but bandwidth.
   * Set false to run them as discrete, individually toggleable passes.
   */
  fuse?: boolean;
  /** MSAA samples on the scene buffer (WebGL2). 0 at LOW/MED, 4 at HIGH/ULTRA. */
  samples?: number;
  ink?: InkPassOptions;
  halftone?: HalftonePassOptions;
  bloom?: BloomOptions;
  chromatic?: ChromaticOptions;
  grade?: GradeOptions;
  grain?: GrainOptions;
  vignette?: VignetteOptions;
  overlay?: OverlayOptions;
}

/** The knobs a quality tier is allowed to touch. Passes 1–3 are not on this list. */
export interface PipelineQuality {
  bloom: boolean;
  bloomLevels: number;
  chromatic: boolean;
  grain: boolean;
  ao: boolean;
  /** Halftone dot pitch in pixels — coarser on low-end, never absent. */
  halftonePitch: number;
  /** Ink sample radius in pixels. */
  inkThickness: number;
}

/**
 * How strong the split-tone tints are, matching `passes/grade.ts`'s own defaults. Read here
 * rather than imported because `makeGradeUniforms` bakes them into a vector — this is the amount
 * the escalation re-authors that vector at, and it is deliberately UNCHANGED by the round: an
 * ember shift is a hue move (see `world/lighting.ts::ember`), never a strength move.
 */
const GRADE_SHADOW_TINT = 0.16;
const GRADE_HIGH_TINT = 0.12;

export class ComicPipeline implements EscalationSink {
  readonly composer: EffectComposer;
  readonly common: CommonUniforms;
  /** Every chunk uniform, flat, addressable by name. Drive the look from here. */
  readonly uniforms: Uniforms = {};

  readonly renderPass: RenderPass;
  readonly inkPass: ShaderPass;
  readonly halftonePass: ShaderPass;
  readonly bloomPass: ComicBloomPass;
  /** Present when fused; `null` in discrete mode. */
  readonly finishPass: ShaderPass | null;
  /** Present in discrete mode; empty when fused. */
  readonly finishParts: readonly ShaderPass[];

  private readonly chunks: PassChunk[] = [];
  private readonly ownedPasses: Pass[] = [];
  private readonly defaults = new Map<string, number>();
  private readonly renderer: WebGLRenderer;

  /**
   * The halftone pitch is authored in CSS pixels and converted to drawing-buffer pixels here.
   * `czDots` measures in `gl_FragCoord`, which is device pixels — so leaving the tier value raw
   * made the dots physically SHRINK as quality (and therefore pixelRatio) went up, until at
   * ULTRA on a retina panel the signature of the whole art direction was sub-perceptual.
   */
  private htPitchCss = 6.6;
  private devicePixelRatio = 1;
  /** Last computed boil scale — read it in the debug panel when auditing ART §4.1. */
  private _boilScale = 1;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    width: number,
    height: number,
    pixelRatio: number,
    opts: PipelineOptions = {},
  ) {
    this.renderer = renderer;
    this.common = makeCommonUniforms(INK_GLOBALS.uBoil, INK_GLOBALS.uBoilSmooth);

    // The composer's own buffers, so MSAA can be requested on the scene render. Everything
    // downstream reads a resolved texture, so multisampling costs nothing after pass 1.
    const rt = new WebGLRenderTarget(
      Math.max(1, Math.round(width * pixelRatio)),
      Math.max(1, Math.round(height * pixelRatio)),
      { type: HalfFloatType, samples: opts.samples ?? 0 },
    );
    rt.texture.name = 'ComicPipeline.rt1';
    this.composer = new EffectComposer(renderer, rt);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);

    // ── 1 · scene ────────────────────────────────────────────────────────────
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // ── 2 · ink ──────────────────────────────────────────────────────────────
    const inkChunk = makeInkChunk(opts.ink);
    this.inkPass = buildPass('ComicInkPass', [inkChunk], this.common);
    this.composer.addPass(this.inkPass);
    this.chunks.push(inkChunk);

    // ── 3 · halftone ─────────────────────────────────────────────────────────
    const htChunk = makeHalftoneChunk(opts.halftone);
    this.halftonePass = buildPass('ComicHalftonePass', [htChunk], this.common);
    this.composer.addPass(this.halftonePass);
    this.chunks.push(htChunk);

    // ── 4 · bloom ────────────────────────────────────────────────────────────
    this.bloomPass = new ComicBloomPass(
      Math.round(width * pixelRatio), Math.round(height * pixelRatio), this.common, opts.bloom);
    this.composer.addPass(this.bloomPass);

    // ── 5–9 · the finishing chain ────────────────────────────────────────────
    const finish: PassChunk[] = [
      makeChromaticChunk(opts.chromatic),
      makeGradeChunk(opts.grade),
      makeGrainChunk(opts.grain),
      makeVignetteChunk(opts.vignette),
      makeOverlayChunk(opts.overlay),
    ];
    this.chunks.push(...finish);

    if (opts.fuse === false) {
      const parts: ShaderPass[] = [];
      for (const ch of finish) {
        const p = buildPass(`Comic_${ch.id}`, [ch], this.common);
        this.composer.addPass(p);
        parts.push(p);
        this.ownedPasses.push(p);
      }
      this.finishParts = parts;
      this.finishPass = null;
    } else {
      this.finishPass = buildPass('ComicFinishPass', finish, this.common);
      this.composer.addPass(this.finishPass);
      this.ownedPasses.push(this.finishPass);
      this.finishParts = [];
    }

    this.ownedPasses.push(this.inkPass, this.halftonePass, this.bloomPass);
    collectUniforms(this.chunks, this.uniforms);
    for (const key of Object.keys(this.uniforms)) {
      const v = this.uniforms[key]!.value;
      if (typeof v === 'number') this.defaults.set(key, v);
    }

    this.htPitchCss = this.u('uHtPitch').value;
    this.setSize(width, height, pixelRatio);
    // Self-register with the visual-escalation bus. Nothing is pushed until the first round
    // begins; a pipeline rebuilt mid-run (context loss) is brought straight up to date.
    ESCALATION.attach(this);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // VISUAL ESCALATION — the grade, the panel and the plate, per round.
  //
  // Every value written here is ABSOLUTE and derived from the round, never a delta — so
  // applying the same round twice is a no-op and jumping round 20 → round 1 restores the
  // shipped look exactly. Called once per round from `game/rounds/director.ts`; there is no
  // per-frame path into any of it, which is how ART §4.1 survives an escalating grade.
  //
  // Nothing below adds a pass, a texture or a render target: it is seven scalars and two
  // vec3s on shaders that already run. The measured cost of the whole escalation is 0 draw
  // calls and 0 triangles.
  // ───────────────────────────────────────────────────────────────────────────

  /** The round the LOOK is set to. 0 before the first round. */
  private _escRound = 0;
  get escalationRound(): number { return this._escRound; }

  applyEscalation(e: Readonly<EscalationState>): void {
    this._escRound = e.round;

    // ── the grade hardens ─────────────────────────────────────────────────
    this.u('uGradeContrast').value = e.contrast;
    this.u('uGradeSaturation').value = e.saturation;
    this.u('uGradeExposure').value = e.exposure;
    // A CHEAPER PRESS: 24 → 17 posterize steps. Fewer inks, a coarser separation, the look of
    // a book printed in a hurry. The Bayer dither is untouched, so this reads as a rougher
    // screen rather than as banding.
    this.u('uGradeLevels').value = e.levels;

    /**
     * SPLIT TONE. `tintVec` returns a MULTIPLICATIVE tint normalised about its own mean, so a
     * hue swap here cannot change the frame's overall brightness — only which way the darks and
     * the lights lean. The shadows bruise NIGHT_B → HOT and the highlights cool from GOLD to
     * RUST, which is the entire "the night turns hostile" beat expressed in two vec3s.
     *
     * ART §9: HOT here is a 16%-strength multiplicative lean on the DARK end of a full-frame
     * grade, not a surface colour — it cannot compete with an enemy silhouette because it is
     * applied to the enemy too, and the reserved-channel probe reads green dominance, which
     * neither HOT nor RUST carries.
     */
    (this.u<Vector3>('uGradeShadowTint').value).copy(
      tintVec(hexMix(PALETTE.NIGHT_B, PALETTE.HOT, e.shadowEmber), GRADE_SHADOW_TINT));
    (this.u<Vector3>('uGradeHighTint').value).copy(
      tintVec(hexMix(PALETTE.GOLD, PALETTE.RUST, e.highEmber), GRADE_HIGH_TINT));

    // ── the panel closes in ───────────────────────────────────────────────
    // Written straight onto `passes/vignette.ts`'s uniforms; that file is untouched.
    this.u('uVigAmount').value = e.vignette;
    this.u('uVigInner').value = e.vignetteInner;

    // ── the comic language gets denser ────────────────────────────────────
    this.u('uOvSpeedCount').value = e.speedCount;
    this.u('uOvSoot').value = e.soot;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Uniform access
  // ───────────────────────────────────────────────────────────────────────────

  /** Typed handle on any chunk uniform. Throws on a typo rather than failing silently. */
  u<T = number>(name: string): Uniform<T> {
    const x = this.uniforms[name];
    if (!x) throw new Error(`ComicPipeline: no uniform "${name}"`);
    return x as Uniform<T>;
  }

  /** Restore a numeric uniform to the value it was built with. */
  reset(name: string): void {
    const d = this.defaults.get(name);
    if (d !== undefined) this.u(name).value = d;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Wiring
  // ───────────────────────────────────────────────────────────────────────────

  setScene(scene: Scene, camera: PerspectiveCamera): void {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  /** Hand the normal+depth prepass to passes 2 and 3. Call once per resize/camera change. */
  setPrepass(normals: Texture, depth: Texture, near: number, far: number): void {
    setInkSources(this.uniforms, normals, depth, near, far);
    setHalftoneDepth(this.uniforms, depth, near, far);
  }

  /**
   * The key and rim directions of the light rig, in VIEW space. The ink pass draws the rim
   * (a per-fragment Fresnel cannot edge a flat-shaded box), and it needs both directions in
   * the same space the prepass normals live in. Call once per frame.
   */
  setViewLightDirs(keyView: Vector3, rimView: Vector3): void {
    setInkViewDirs(this.uniforms, keyView, rimView);
  }

  /** Hand the LAYER.BLOOM-only render to pass 4. `null` falls back to threshold-only. */
  setEmissive(tex: Texture | null): void {
    this.bloomPass.setEmissiveSource(tex);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    const w = Math.max(1, Math.round(width * pixelRatio));
    const h = Math.max(1, Math.round(height * pixelRatio));
    (this.common.uResolution.value).set(w, h);
    (this.common.uTexel.value).set(1 / w, 1 / h);
    this.common.uAspect.value = w / h;
    this.devicePixelRatio = pixelRatio;
    this.applyHalftonePitch();
    this.applyBoilScale();
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * THE BOIL IS RESOLUTION-AWARE, BECAUSE THE §4.1 BUDGET IS MEASURED IN *PIXELS CHANGED*.
   *
   * `uInkBoil` is authored in screen pixels of displacement, and that number alone was treated
   * as the whole story. It is not: the wobble can only change pixels where a contour exists,
   * and the number of contours a buffer RESOLVES grows with its resolution. Same amplitude,
   * denser linework ⇒ more of the frame flips on every boil tick.
   *
   * MEASURED, camera bit-static, no enemies, on the shipped city:
   *   2400×1231 buffer — max 0.21% of pixels changed, mean 0.078%          PASS
   *   3200×1754 buffer — mean 0.70%, peak 0.822% on the 12 boil frames/s   FAIL (1.4–1.6× over)
   *
   * The second line is an ordinary Retina laptop (a 1482×812 window at 2.16× DPR) — i.e. the
   * machine the playtester actually plays on was the one getting the crawling screen, which is
   * exactly the "every pixel jumping like glitching" report §4.1.1 exists to prevent.
   *
   * So the amplitude is scaled DOWN above a reference buffer height. The exponent is above 1
   * because the failure grew faster than linearly with resolution, and the scale is clamped at
   * 1 so nothing changes at or below the reference — the boil at 1080p/1231p is measured-good
   * and must not be quietly weakened to buy headroom somewhere else.
   * ═════════════════════════════════════════════════════════════════════════════════════════
   */
  private applyBoilScale(): void {
    const h = Math.max(1, this.common.uResolution.value.y);
    const k = Math.min(1, (BOIL_REFERENCE_HEIGHT / h) ** BOIL_FALLOFF);
    this._boilScale = k;
    const pos = this.defaults.get('uInkBoil');
    if (pos !== undefined) this.u('uInkBoil').value = pos * k;
    const width = this.defaults.get('uInkBoilWidth');
    if (width !== undefined) this.u('uInkBoilWidth').value = width * k;
  }

  /** The §4.1 resolution compensation currently applied to the ink boil. 1 = full amplitude. */
  get boilScale(): number { return this._boilScale; }

  /**
   * CSS-authored pitch → drawing-buffer pixels. Same physical dot size at any DPR.
   *
   * ONE LATTICE. Everything that prints a dot in this frame — the tone pass, the AO hatching,
   * the fog dissolve, the bloom halo, the CMYK fines in the grain, the vignette ring, the
   * panel gutter, the speed-line dissolve — measures against `uScreenPitch` or an exact
   * harmonic of it, and differs only in plate ANGLE. Same pitch + different angle is a
   * rosette, which is what print looks like. Different pitch + similar angle is a beat,
   * which is moiré, and moiré is the thing that crawls across a wall as you walk past it.
   */
  private applyHalftonePitch(): void {
    const px = this.htPitchCss * this.devicePixelRatio;
    this.common.uScreenPitch.value = px;
    this.u('uHtPitch').value = px;
    // The grain's fine screen is a HARMONIC of the main one, never an independent pitch.
    this.u('uGrainPitch').value = px * 0.5;
    // Materials and the sky print on the same sheet — INK_GLOBALS carries the CSS pitch and
    // their own uHalftoneScale carries the DPR, so the physical dot matches the post stack's.
    INK_GLOBALS.uHalftonePitch.value = this.htPitchCss;
  }

  /**
   * Change MSAA on the scene buffer. Disposing forces three to rebuild the framebuffer
   * with the new sample count on the next bind.
   */
  setSamples(n: number): void {
    const s = Math.max(0, Math.min(8, n | 0));
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples === s) continue;
      rt.samples = s;
      rt.dispose();
    }
  }

  /** Per-frame. `dt` is unscaled real seconds. */
  render(dt: number): void {
    this.common.uTime.value += dt;
    this.composer.render(dt);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Quality
  // ───────────────────────────────────────────────────────────────────────────

  applyQuality(q: PipelineQuality): void {
    this.bloomPass.enabled = q.bloom;
    this.bloomPass.levels = q.bloomLevels;

    // Fused chunks cannot be switched off as passes, so they are switched off by
    // zeroing the uniforms that drive them. Cost when off: a few multiplies.
    if (q.chromatic) { this.reset('uChromaAmount'); this.reset('uChromaBoil'); }
    else { this.u('uChromaAmount').value = 0; this.u('uChromaBoil').value = 0; }

    if (q.grain) { this.reset('uGrainAmount'); this.reset('uGrainCmyk'); }
    else { this.u('uGrainAmount').value = 0; this.u('uGrainCmyk').value = 0; }

    if (q.ao) this.reset('uAoStrength');
    else this.u('uAoStrength').value = 0;

    // Authored in CSS px; `applyHalftonePitch` converts. Never write uHtPitch directly.
    this.htPitchCss = q.halftonePitch;
    this.applyHalftonePitch();
    this.u('uInkThickness').value = q.inkThickness;

    // In discrete mode the same decisions also skip whole passes, which is cheaper.
    for (const p of this.finishParts) {
      const n = p.material.name;
      if (n === 'Comic_chromatic') p.enabled = q.chromatic;
      if (n === 'Comic_grain') p.enabled = q.grain;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Art-direction knobs (mirrored from RenderService)
  // ───────────────────────────────────────────────────────────────────────────

  set inkStrength(v: number) { this.u('uInkStrength').value = v; }
  get inkStrength(): number { return this.u('uInkStrength').value; }

  set halftoneScale(v: number) { this.common.uHalftoneScale.value = v; }
  get halftoneScale(): number { return this.common.uHalftoneScale.value; }

  /** 0 = no panel border, 1 = a full comic panel. Drive it for big beats. */
  set panelFrame(v: number) { this.u('uFrame').value = v; }
  get panelFrame(): number { return this.u('uFrame').value; }

  dispose(): void {
    ESCALATION.detach(this);
    for (const p of this.ownedPasses) p.dispose();
    this.composer.dispose();
  }
}

export function createPipeline(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  width: number,
  height: number,
  pixelRatio: number,
  opts?: PipelineOptions,
): ComicPipeline {
  return new ComicPipeline(renderer, scene, camera, width, height, pixelRatio, opts);
}

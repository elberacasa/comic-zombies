/**
 * RENDER SERVICE — the owner of the look.
 *
 * Implements `RenderService` from `core/types.ts`. Everything the art direction needs to
 * happen every frame happens here, in this order:
 *
 *   1. decay the self-decaying overlays (flash, speed lines, lens splats, panel frame)
 *   2. drive INK_GLOBALS (12 fps boiling line, resolution, art-direction knobs)
 *   3. **normal + depth prepass** — the whole scene through a MeshNormalMaterial into an
 *      RGBA target with a DepthTexture attached. Passes 2 and 3 of the post stack live on
 *      this. Half resolution at LOW/MED; the edge pass is written to survive that.
 *      Anything whose shape is computed in its OWN vertex shader (posed enemies, the
 *      lens-magnified viewmodel) is drawn with a matching stand-in instead — see
 *      `swapInPrepassMaterials`, which is the only place that subtlety lives.
 *   4. **emissive prepass** — LAYER.BLOOM objects only, into a small black target. This is
 *      what makes the bloom *selective* rather than a brightness threshold.
 *   5. the post stack (`pipeline.ts`)
 *   6. LAYER.OVERLAY straight to the canvas, ungraded (opt in with `overlayLayer`)
 *
 * LAYERS (see materials/index.ts → LAYER)
 *   0 default · 1 outline hulls · 2 emissive/bloom · 3 ungraded overlay · 4 no-ink (sky)
 *   The camera's layer mask is swapped between renders and the caller's own mask is
 *   preserved — set `camera.layers` however you like, the renderer only ever adds bits.
 *
 * QUALITY TIERS change pixel ratio, prepass resolution, MSAA, shadow maps, bloom levels,
 * halftone pitch and ink width. They NEVER drop passes 1–3: losing the scene, the ink or
 * the halftone loses the art direction. Resolution goes first, style goes last.
 */

import {
  ClampToEdgeWrapping, Color, DepthFormat, DepthTexture, Group, LinearFilter, Matrix4, Mesh,
  MeshNormalMaterial, NearestFilter, NoToneMapping, PCFShadowMap, RGBAFormat,
  SRGBColorSpace, UnsignedByteType, UnsignedIntType, Vector3, WebGLRenderTarget, WebGLRenderer,
  type Material, type Object3D, type PerspectiveCamera, type Scene, type Vector2,
} from 'three';

import type { QualityTier, RenderService } from '@/core/types';

/** Render-scale bounds. Below ~0.55 the ink line starts to break up on thin geometry. */
/**
 * ═══ THE DIAL MUST BE INVISIBLE, NOT JUST EFFECTIVE ═══
 *
 * The playtester, twice: *"graphics are going low and they look bad suddenly swapping quality"*.
 * The first report was the governor HUNTING at round start (fixed — a spike now resets the
 * counter). This is the second and different one: the dial was doing the right thing and you
 * could still SEE it happen.
 *
 * Two causes, both here rather than in the logic:
 *
 *  · `STEP` was 0.1. A 10% resolution change in one frame is a visible pop — the whole image
 *    softens at once, which reads as the game breaking rather than as a graceful degrade.
 *    0.04 is below the threshold where you notice a single step, so the frame rate is bought
 *    gradually instead of in cliffs.
 *  · `MIN` was 0.55 — THIRTY PERCENT of the pixels. That is not a soft image, it is a bad one,
 *    and no frame rate is worth it in a game whose whole pitch is the way it looks. 0.74 is 55%
 *    of the pixels and is the point measured to still read as intended.
 *
 * WHY A RESOLUTION DROP IS SAFE AT ALL: the halftone pitch and the ink weight are authored in
 * CSS pixels and converted per `pixelRatio`, so the dots and the lines keep their on-screen size
 * as the buffer shrinks. A drop softens edges; it does not restyle the drawing. That is the
 * property that makes this dial usable and it is why resolution goes before any feature.
 *
 * Costs traded knowingly: a smaller step means more `applyResolution()` calls, and each one
 * reallocates render targets. Bounded at 7 steps from 1.0 to MIN, spaced by `ADJUST_S`, which is
 * far below the rate at which that allocation is noticeable.
 */
const RenderScale = {
  MIN: 0.74,
  /**
   * ═══ THESE TWO NUMBERS WERE THE WHOLE BUG, AND THEY WERE BELOW THE VSYNC FLOOR ═══
   *
   * They were `TARGET_MS: 13.5` and `RELAX_MS: 10.5`. **A vsynced 60 Hz frame is 16.67 ms.**
   * So on a machine hitting a locked, perfect 60 fps, `ms > TARGET_MS` was ALWAYS true and
   * `ms < RELAX_MS` needed 95 fps to ever fire. The governor could only walk downward. It did
   * exactly that, forever, on every machine — and the console said so in as many words:
   *
   *     [render] 60 fps sustained — render scale 1.00 → 0.90
   *     [render] 60 fps sustained — render scale 0.90 → 0.80   … → 0.55
   *     [render] 60 fps sustained at minimum render scale — dropping quality high → med
   *
   * "60 fps sustained" and dropping resolution in the same sentence. That is the playtester's
   * *"graphics are going low and they look bad"*, in full: not a governor that was too eager,
   * a governor that was mathematically incapable of ever being satisfied. Every session, after
   * about forty seconds, degraded to minimum resolution and then walked the quality tiers down.
   *
   * The thresholds are now stated in fps, below the vsync floor rather than above it:
   * degrade only under ~50 fps, recover once back over ~58. The 2.8 ms gap is the hysteresis,
   * and both sides are reachable at a normal 60 Hz refresh — which is the property the old pair
   * did not have.
   */
  /** ~51 fps. Genuinely slow, not merely vsynced. */
  TARGET_MS: 19.5,
  /** ~58 fps. Reachable at a locked 60, which is what makes recovery possible at all. */
  RELAX_MS: 17.2,
  /** Per-adjustment change. Small enough that ONE step is not perceptible. */
  STEP: 0.04,
  /** Seconds between steps once the governor has committed to adjusting. */
  ADJUST_S: 0.6,
} as const;
import { PALETTE, color, rgb8Hex } from '@/art/palette';
import { setArtAnisotropy } from '@/art/textures';
import {
  INK_GLOBALS, LAYER, disposeOutlines, inkPrepassMaterialFor, outlineTree, updateInkGlobals,
  type OutlineOptions,
} from './materials/index';
import { ComicPipeline, type PipelineOptions, type PipelineQuality } from './pipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Quality tiers
// ─────────────────────────────────────────────────────────────────────────────

interface TierConfig extends PipelineQuality {
  /** Hard cap on devicePixelRatio. */
  pixelRatioCap: number;
  /** Prepass resolution as a fraction of the drawing buffer. */
  prepassScale: number;
  /** MSAA samples on the scene buffer. */
  samples: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Canvas antialias flag — only meaningful for the LAYER.OVERLAY direct render. */
  antialias: boolean;
}

/**
 * `halftonePitch` is in **CSS pixels** — the pipeline multiplies by the pixel ratio so a dot is
 * the same physical size on a 1x monitor and a 2x laptop. Authoring it in device pixels (which
 * is what `gl_FragCoord` measures) made the screen-tone shrink as quality went UP, which is
 * backwards: ULTRA had the least visible art direction of any tier.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MSAA IS OFF AT EVERY TIER, AND THAT IS THE PERFORMANCE FIX.  (M1.5)
 *
 * Measured at 1920×1080, DPR 1, Apple M4 — a GPU well above the "mid-range laptop" bar:
 * ULTRA 36–42 fps, HIGH 35 fps, and `loop.stats.frameMs` only 2.4–4.1 ms, so every bit of it
 * was GPU. Flipping MSAA 4 → 0 with everything else untouched took ULTRA from 36 to 55 fps:
 * **~10 ms of a ~26 ms frame** was being spent multisampling a HalfFloat 1080p buffer whose
 * geometric edges are then (a) overdrawn by the inverted-hull silhouettes, (b) overdrawn
 * again by the screen-space ink pass, and (c) dissolved into a dot lattice by the halftone
 * screen. We were paying a third of the frame for antialiasing that three later passes
 * deliberately destroy. Nothing in the art direction wants a soft edge.
 *
 * The other half of the fix is `high.prepassScale`. HIGH was rendering the whole city a
 * SECOND time at full resolution just to fill the normal/depth prepass; the edge pass was
 * written to survive half resolution (that is why LOW/MED already do it) and at 1080p the
 * difference in the line is not visible under the halftone.
 *
 * THE LADDER IS ALSO MONOTONIC NOW. HIGH used to be *slower* than ULTRA (35 vs 38–42 across
 * repeated runs) because its only real differences were a shadow map nothing samples and a
 * pixelRatio cap that does nothing at DPR 1. Cost per tier now strictly increases: resolution
 * cap, then prepass resolution, then bloom levels and AO. `guessQuality()` returns HIGH for
 * essentially every machine, so HIGH is *the* shipped experience and it is budgeted as one.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const TIERS: Record<QualityTier, TierConfig> = {
  low: {
    pixelRatioCap: 0.75, prepassScale: 0.5, samples: 0, shadows: false, shadowMapSize: 0,
    antialias: false,
    bloom: false, bloomLevels: 1, chromatic: false, grain: false, ao: false,
    halftonePitch: 8.0, inkThickness: 1.15,
  },
  med: {
    pixelRatioCap: 1, prepassScale: 0.5, samples: 0, shadows: false, shadowMapSize: 0,
    antialias: false,
    bloom: true, bloomLevels: 1, chromatic: true, grain: true, ao: false,
    halftonePitch: 7.2, inkThickness: 1.25,
  },
  high: {
    pixelRatioCap: 1.5, prepassScale: 0.5, samples: 0, shadows: false, shadowMapSize: 0,
    antialias: false,
    bloom: true, bloomLevels: 2, chromatic: true, grain: true, ao: true,
    halftonePitch: 6.6, inkThickness: 1.35,
  },
  ultra: {
    pixelRatioCap: 2, prepassScale: 1, samples: 0, shadows: false, shadowMapSize: 0,
    antialias: false,
    bloom: true, bloomLevels: 3, chromatic: true, grain: true, ao: true,
    halftonePitch: 6.2, inkThickness: 1.45,
  },
};

/** Tier order, cheapest first. The auto-quality guard walks DOWN this and never up. */
const TIER_ORDER: readonly QualityTier[] = ['low', 'med', 'high', 'ultra'];

/** The guard fires below this many fps... */
const AUTO_QUALITY_FPS = 55;
/** ...sustained for this many seconds... */
const AUTO_QUALITY_HOLD = 3.0;
/**
 * Seconds of headroom before the render scale climbs back. DELIBERATELY SHORTER than the hold
 * above: dropping resolution is a safety net and recovering it is the normal state, so a drop
 * that turns out to be wrong should be visible for as little time as possible.
 */
const AUTO_QUALITY_RECOVER = 1.2;
/** ...and then ignores the next few seconds while the new tier settles. */
const AUTO_QUALITY_GRACE = 3.0;

// ─────────────────────────────────────────────────────────────────────────────
// Feel constants for the self-decaying overlays. These are presentation-only and
// deliberately live here rather than in game/tuning.ts — they are the renderer's
// own physics, not gameplay.
// ─────────────────────────────────────────────────────────────────────────────

/** 1 → 0 in ~0.15 s. The comic flash frame is SHORT. */
const FLASH_DECAY = 6.6;
/** Speed lines fall away in ~0.45 s once nothing is feeding them. */
const SPEEDLINE_DECAY = 2.2;
/** Lens splats linger — they are a damage indicator, not a flourish. */
const SPLAT_DECAY = 0.5;
/** Panel frame: snaps in, eases out. */
const FRAME_ATTACK = 9;
const FRAME_RELEASE = 2.4;

// ─────────────────────────────────────────────────────────────────────────────

export interface RendererOptions {
  canvas?: HTMLCanvasElement;
  width?: number;
  height?: number;
  quality?: QualityTier;
  /**
   * Wired by the integrator to `events.emit('quality:changed', { tier })`.
   * The renderer must not import a game system, so it takes a callback instead.
   */
  onQualityChanged?: (tier: QualityTier) => void;
  /** Render LAYER.OVERLAY objects straight to the canvas after post, ungraded. */
  overlayLayer?: boolean;
  pipeline?: PipelineOptions;
}

const _clearColor = new Color();
// Module-level scratch — the render path allocates nothing (ARCHITECTURE §1.5).
const _view = new Matrix4();
const _keyView = new Vector3();
const _rimView = new Vector3();

export class ComicRenderer implements RenderService {
  readonly three: WebGLRenderer;
  readonly pipeline: ComicPipeline;

  /** Render LAYER.OVERLAY straight to the canvas after post. Off by default. */
  overlayLayer: boolean;

  private _quality: QualityTier;
  private tier: TierConfig;
  private readonly onQualityChanged: ((tier: QualityTier) => void) | undefined;

  private _inkStrength = 1;
  private _halftoneScale = 1;

  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  // prepass
  private prepassRT: WebGLRenderTarget;
  private depthTex: DepthTexture;
  private readonly normalMat: MeshNormalMaterial;
  // selective-bloom source
  private emissiveRT: WebGLRenderTarget;

  private readonly outlines = new Map<Object3D, Mesh[]>();

  // ── prepass material swap (see `swapInPrepassMaterials`) ────────────────────
  // Reused every frame; `length = 0` keeps the capacity, so after the first frame this is a
  // zero-allocation traversal (ARCHITECTURE §1.5).
  private readonly prepassMeshes: Mesh[] = [];
  private readonly prepassSaved: (Material | Material[])[] = [];
  private prepassBits = 0;

  // self-decaying overlay state
  private flashAmount = 0;
  private speedAmount = 0;
  private splatAmount = 0;
  private frameTarget = 0;
  private frameValue = 0;
  /** Which hand-inked panel contour we are on. Advanced once per beat, never per frame. */
  private frameSeedTick = 0;

  private lastTime = 0;
  private disposed = false;

  // auto-quality guard
  /** Set false to pin the tier — the debug console and a future options menu both want this. */
  autoQuality = true;
  private frameAvg = 1 / 60;
  private slowFor = 0;
  private fastFor = 0;
  private autoGrace = AUTO_QUALITY_GRACE;

  constructor(opts: RendererOptions = {}) {
    const canvas = opts.canvas;
    this._quality = opts.quality ?? 'high';
    this.tier = TIERS[this._quality];
    this.onQualityChanged = opts.onQualityChanged;
    this.overlayLayer = opts.overlayLayer ?? false;

    this.three = new WebGLRenderer({
      canvas,
      antialias: this.tier.antialias,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });

    // We grade ourselves — the tone map and the encode both live in passes/grade.ts.
    this.three.toneMapping = NoToneMapping;
    this.three.outputColorSpace = SRGBColorSpace;
    this.three.autoClear = true;
    this.three.setClearColor(color(PALETTE.INK), 1);
    this.three.shadowMap.enabled = this.tier.shadows;
    // r185 removed PCFSoftShadowMap; three silently substitutes PCFShadowMap and warns once
    // per renderer/tier change. Same result, no console noise.
    this.three.shadowMap.type = PCFShadowMap;
    this.three.shadowMap.autoUpdate = this.tier.shadows;
    /**
     * `autoReset = true` resets `renderer.info` at the start of EVERY `WebGLRenderer.render()`
     * call, and one composited frame issues twelve of them (normal/depth prepass, emissive
     * prepass, the composer's beauty pass, then nine fullscreen post passes). Anyone reading
     * `info` afterwards therefore saw only the LAST fullscreen quad: `CZ.stats()` reported
     * `{calls: 1, triangles: 1}` while the frame genuinely cost 132 calls / 403k triangles.
     * The documented handle for policing the ARCHITECTURE §6 budget could not observe a
     * violation if there was one. It is manual now, reset once at the top of `render()`.
     */
    this.three.info.autoReset = false;

    setArtAnisotropy(this.three.capabilities.getMaxAnisotropy());

    this.width = opts.width ?? canvas?.clientWidth ?? 1280;
    this.height = opts.height ?? canvas?.clientHeight ?? 720;
    this.pixelRatio = this.resolvePixelRatio();
    this.three.setPixelRatio(this.pixelRatio);
    this.three.setSize(this.width, this.height, false);

    // ── prepass targets ─────────────────────────────────────────────────────
    this.normalMat = new MeshNormalMaterial();
    this.normalMat.name = 'PrepassNormals';
    const [pw, ph] = this.prepassSize();
    this.depthTex = makeDepthTexture(pw, ph);
    this.prepassRT = makePrepassRT(pw, ph, this.depthTex);
    this.emissiveRT = makeEmissiveRT(Math.max(1, pw >> 1), Math.max(1, ph >> 1));

    // ── post stack ──────────────────────────────────────────────────────────
    // Built with a placeholder scene/camera; `render()` re-points it every frame, which
    // is free and means the integrator never has to hand us the scene up front.
    this.pipeline = new ComicPipeline(
      this.three,
      PLACEHOLDER.scene, PLACEHOLDER.camera,
      this.width, this.height, this.pixelRatio,
      { samples: this.tier.samples, ...opts.pipeline },
    );
    this.pipeline.setEmissive(this.emissiveRT.texture);
    this.applyTier(false);

    this.three.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.three.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RenderService — quality
  // ───────────────────────────────────────────────────────────────────────────

  get quality(): QualityTier { return this._quality; }
  set quality(tier: QualityTier) {
    if (tier === this._quality || !TIERS[tier]) return;
    this._quality = tier;
    this.tier = TIERS[tier];
    // Give the new tier time to settle before the auto guard is allowed to judge it.
    this.slowFor = 0;
    this.autoGrace = AUTO_QUALITY_GRACE;
    this.frameAvg = 1 / 60;
    this.applyTier(true);
  }

  private applyTier(emit: boolean): void {
    const t = this.tier;
    this.pixelRatio = this.resolvePixelRatio();
    this.three.setPixelRatio(this.pixelRatio);
    this.three.setSize(this.width, this.height, false);
    this.three.shadowMap.enabled = t.shadows;
    this.three.shadowMap.autoUpdate = t.shadows;
    this.pipeline.setSamples(t.samples);
    this.pipeline.setSize(this.width, this.height, this.pixelRatio);
    this.pipeline.applyQuality(t);
    this.syncHalftoneScale();
    this.resizePrepass();
    if (emit) this.onQualityChanged?.(this._quality);
  }

  /**
   * RENDER SCALE — the largest performance lever we have, and the one this art direction is
   * unusually tolerant of.
   *
   * A photoreal game at 0.6x looks mushy, because its detail lives in the texels. Ours does not:
   * the surfaces are flat colour, the edges are hard ink, and the halftone screen is measured in
   * CSS pixels and converted to device pixels by `applyHalftonePitch` — so the dots keep the same
   * ON-SCREEN size at any render scale rather than shrinking with it. Lower the scale and the
   * page does not become a finer print; it stays the same print, drawn with fewer samples.
   *
   * Everything derives from `pixelRatio`: composer targets, prepass, halftone pitch, boil
   * amplitude, ink width. So scaling here scales the entire frame — scene, ink and post together
   * — which is what makes it worth ~1/scale² rather than a fraction of the frame.
   *
   * 1 = the tier's native resolution. The governor drives it between `MIN_SCALE` and 1.
   */
  private _renderScale = 1;

  get renderScale(): number { return this._renderScale; }
  set renderScale(v: number) {
    const next = Math.max(RenderScale.MIN, Math.min(1, v));
    if (Math.abs(next - this._renderScale) < 0.005) return;
    this._renderScale = next;
    this.applyResolution();
  }

  /** Re-derive every resolution-dependent target from the current tier and render scale. */
  private applyResolution(): void {
    this.pixelRatio = this.resolvePixelRatio();
    this.three.setPixelRatio(this.pixelRatio);
    this.three.setSize(this.width, this.height, false);
    this.pipeline.setSize(this.width, this.height, this.pixelRatio);
    this.resizePrepass();
  }

  private resolvePixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const capped = Math.min(dpr, this.tier.pixelRatioCap);
    return Math.max(0.4, capped * this._renderScale);
  }

  private prepassSize(): [number, number] {
    const w = Math.max(1, Math.round(this.width * this.pixelRatio * this.tier.prepassScale));
    const h = Math.max(1, Math.round(this.height * this.pixelRatio * this.tier.prepassScale));
    return [w, h];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RenderService — art-direction knobs
  // ───────────────────────────────────────────────────────────────────────────

  get inkStrength(): number { return this._inkStrength; }
  set inkStrength(v: number) {
    this._inkStrength = v;
    INK_GLOBALS.uInkStrength.value = v;
    this.pipeline.inkStrength = v;
  }

  get halftoneScale(): number { return this._halftoneScale; }
  set halftoneScale(v: number) {
    this._halftoneScale = v;
    this.syncHalftoneScale();
    this.pipeline.halftoneScale = v;
  }

  /**
   * Material-side screens measure in `gl_FragCoord` (device pixels) against a pitch authored in
   * CSS pixels, so the global scale carries the pixel ratio for them. The post stack does the
   * same conversion inside the pipeline, so its own `uHalftoneScale` stays the pure user knob —
   * multiplying there too would square the ratio.
   */
  private syncHalftoneScale(): void {
    INK_GLOBALS.uHalftoneScale.value = this._halftoneScale * this.pixelRatio;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RenderService — sizing
  // ───────────────────────────────────────────────────────────────────────────

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.pixelRatio = this.resolvePixelRatio();
    this.three.setPixelRatio(this.pixelRatio);
    this.three.setSize(this.width, this.height, false);
    this.pipeline.setSize(this.width, this.height, this.pixelRatio);
    this.syncHalftoneScale();
    this.resizePrepass();
  }

  private resizePrepass(): void {
    const [w, h] = this.prepassSize();
    if (this.prepassRT.width === w && this.prepassRT.height === h) return;
    this.prepassRT.setSize(w, h);
    this.depthTex.image.width = w;
    this.depthTex.image.height = h;
    this.depthTex.needsUpdate = true;
    this.emissiveRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RenderService — the frame
  // ───────────────────────────────────────────────────────────────────────────

  render(scene: Scene, camera: PerspectiveCamera): void {
    if (this.disposed) return;

    // Whole-frame draw-call / triangle totals. See the `autoReset` note in the constructor.
    this.three.info.reset();

    const now = performance.now();
    const dt = this.lastTime === 0 ? 1 / 60 : Math.min(0.25, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.decayOverlays(dt);
    this.watchFrameRate(dt);

    // CSS size, NOT the drawing buffer. Every consumer of INK_GLOBALS.uResolution measures
    // an ON-SCREEN quantity — the inverted-hull thickness above all — so feeding it device
    // pixels made a "4 px" outline 2 px on a retina panel and 5.3 px on a 0.75x LOW tier.
    updateInkGlobals(dt, this.width, this.height);

    // The screen-space rim needs the rig in view space (the prepass writes view normals).
    camera.updateMatrixWorld();
    _view.copy(camera.matrixWorld).invert();
    _keyView.copy(INK_GLOBALS.uKeyDir.value).transformDirection(_view);
    _rimView.copy(INK_GLOBALS.uRimDir.value).transformDirection(_view);
    this.pipeline.setViewLightDirs(_keyView, _rimView);

    // Layer masks. We only ever ADD bits to whatever the caller asked for, so a camera
    // configured to hide something stays configured that way.
    const userMask = camera.layers.mask;
    const bit = (n: number): number => 1 << n;
    const mainMask = userMask | bit(LAYER.OUTLINE) | bit(LAYER.BLOOM) | bit(LAYER.NO_INK);
    const prepassMask = userMask & ~(bit(LAYER.OUTLINE) | bit(LAYER.NO_INK) | bit(LAYER.OVERLAY));

    // ── 3 · normal + depth prepass ──────────────────────────────────────────
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    this.three.getClearColor(_clearColor);
    const prevClearAlpha = this.three.getClearAlpha();

    // `scene.overrideMaterial` is deliberately CLEARED rather than set — see
    // `swapInPrepassMaterials`. A caller-set override must not leak into the prepass either.
    scene.overrideMaterial = null;
    this.swapInPrepassMaterials(scene, prepassMask);
    scene.background = null;
    camera.layers.mask = prepassMask;
    this.three.setRenderTarget(this.prepassRT);
    this.three.setClearColor(BLACK, 0);
    this.three.clear(true, true, false);
    this.three.render(scene, camera);

    this.restorePrepassMaterials();
    scene.overrideMaterial = prevOverride;

    // ── 4 · emissive prepass — what makes the bloom SELECTIVE ───────────────
    if (this.tier.bloom) {
      camera.layers.mask = bit(LAYER.BLOOM);
      this.three.setRenderTarget(this.emissiveRT);
      this.three.setClearColor(BLACK, 1);
      this.three.clear(true, true, false);
      this.three.render(scene, camera);
    }

    scene.background = prevBackground;
    this.three.setClearColor(_clearColor, prevClearAlpha);
    this.three.setRenderTarget(null);

    // ── 5 · the post stack ──────────────────────────────────────────────────
    camera.layers.mask = mainMask;
    this.pipeline.setScene(scene, camera);
    this.pipeline.setPrepass(this.prepassRT.texture, this.depthTex, camera.near, camera.far);
    this.pipeline.setEmissive(this.tier.bloom ? this.emissiveRT.texture : null);
    this.pipeline.render(dt);

    // ── 6 · ungraded overlay layer ──────────────────────────────────────────
    if (this.overlayLayer) {
      camera.layers.mask = bit(LAYER.OVERLAY);
      const prevAutoClear = this.three.autoClear;
      this.three.autoClear = false;
      this.three.setRenderTarget(null);
      this.three.clearDepth();
      this.three.render(scene, camera);
      this.three.autoClear = prevAutoClear;
    }

    camera.layers.mask = userMask;
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * THE PREPASS MATERIAL SWAP — and why `scene.overrideMaterial` cannot be used here.
   *
   * `overrideMaterial` replaces EVERY material with one stock `MeshNormalMaterial`, which means
   * the prepass draws every object with three's stock vertex shader. Anything whose shape is
   * computed in ITS OWN vertex shader is therefore written into the prepass in the wrong place —
   * and the whole ink pass, the screen-space rim and the boil gate all read that buffer.
   *
   * Shipped symptom (M2 art review, "every zombie renders translucent"): the shambler is posed
   * entirely on the GPU — one merged buffer with a per-vertex `aPart` index and a `mat4[14]`
   * uniform, patched into its material's vertex shader (`game/enemies/body.ts`). The override
   * material has neither the attribute nor the uniform, so all fourteen parts collapsed to the
   * body origin and the prepass recorded the CITY BEHIND the zombie across its whole silhouette.
   * `passes/ink.ts` then inked arcade railings, kerbs and window mullions straight across the
   * torso (the "green glass ghost"), gave the body no interior linework of its own, never fired
   * the §9 always-on enemy rim (it is gated on `nearerMask`, computed from that same depth), and
   * fed `boilNear` a background distance. One bug, four symptoms.
   *
   * The fix keeps the renderer decoupled from every game system, as ARCHITECTURE §1 requires:
   * an object that needs a special prepass material publishes it on
   * `mesh.userData.czPrepassMaterial` and we swap it in per object. No import, no registry, and
   * anything that does not opt in behaves exactly as it did under `overrideMaterial`.
   *
   * SECOND SHIPPED SYMPTOM, SAME BUG, THE VIEWMODEL ("the guns have these sticks showing out"):
   * `game/weapons/viewmodel.ts` rewrites every gun material's vertex shader with the HERO LENS,
   * a clip-space magnification (~2.6× at hip) about a fixed screen point. The stock normal
   * material has no `uHeroLens` and no patch, so the prepass drew the gun small and centred
   * while the beauty pass drew it big — and over most of the gun's pixels the prepass held the
   * CITY. The ink pass Sobel'd buildings and overhead wires straight across the receiver and
   * the sight posts, which is why the sights read as translucent antennae, and why they were
   * SOLID the moment you set `pipeline.inkPass.enabled = false`.
   *
   * Those materials do not hand-author a stand-in — the patch is applied by a game system to a
   * material `materials/index.ts` built — so the fallback below asks the MATERIAL for one:
   * `inkPrepassMaterialFor()` returns a normal-writing derivative carrying that same patched
   * vertex shader, or null for anything whose shader is still the stock `VERT` (every wall,
   * prop and enemy hull in the arena — an O(1) reference compare, no behaviour change, no cost).
   * The renderer still imports nothing from `game/`.
   *
   * Only objects that the prepass camera mask can actually see are touched, so outline hulls
   * (LAYER.OUTLINE) and the sky (LAYER.NO_INK) are skipped for free.
   * ═════════════════════════════════════════════════════════════════════════════════════════
   */
  private swapInPrepassMaterials(scene: Scene, prepassMask: number): void {
    this.prepassBits = prepassMask;
    this.prepassMeshes.length = 0;
    this.prepassSaved.length = 0;
    scene.traverseVisible(this.collectPrepassMesh);
  }

  private readonly collectPrepassMesh = (obj: Object3D): void => {
    if (!(obj as { isMesh?: boolean }).isMesh) return;
    if ((obj.layers.mask & this.prepassBits) === 0) return;
    const mesh = obj as Mesh;
    // Hand-authored stand-in first: an object that knows how it is posed always wins.
    // Otherwise ask the material itself — an ink material whose vertex shader its owner has
    // patched (the viewmodel's hero lens) derives one; everything unpatched returns null in
    // O(1) and gets the stock normal material exactly as before. See `inkPrepassMaterialFor`.
    const custom = (mesh.userData as { czPrepassMaterial?: Material }).czPrepassMaterial
      ?? inkPrepassMaterialFor(mesh.material);
    this.prepassMeshes.push(mesh);
    this.prepassSaved.push(mesh.material);
    mesh.material = custom ?? this.normalMat;
  };

  private restorePrepassMaterials(): void {
    const meshes = this.prepassMeshes;
    const saved = this.prepassSaved;
    for (let i = 0; i < meshes.length; i++) {
      const m = saved[i];
      if (m) (meshes[i] as Mesh).material = m;
    }
    meshes.length = 0;
    saved.length = 0;
  }

  /**
   * PERFORMANCE IS A FEATURE (CLAUDE.md §1). A fixed tier ladder guesses the machine once and
   * is then wrong forever; this watches the actual frame and steps DOWN one notch when a
   * 60-frame rolling average has implied under 55 fps for two continuous seconds. It never
   * steps back up — an oscillating tier is worse than a slightly conservative one, and the
   * player can always pick a tier by hand (which resets the grace period).
   *
   * Deliberately measured here rather than read from `loop.stats`: the renderer must not
   * import a game system, and wall-clock between two `render()` calls IS the frame time.
   */
  private watchFrameRate(dt: number): void {
    /**
     * A HIDDEN TAB IS NOT A SLOW GPU. Chrome throttles `requestAnimationFrame` to a few hertz
     * in a background tab, so without this guard the first alt-tab reads as "13 fps sustained"
     * and walks the player all the way down to LOW — permanently, because the ladder only ever
     * steps down. Caught in the M1.5 verification pass; the console showed three spurious
     * demotions in one session. Same reason for the `dt` cap below: the single enormous frame
     * you get when a tab is restored, or when the debugger pauses, must not poison the average.
     */
    if (typeof document !== 'undefined' && document.hidden) {
      this.frameAvg = 1 / 60;
      this.slowFor = 0;
      this.autoGrace = AUTO_QUALITY_GRACE;
      return;
    }
    if (dt > 0.2) { this.slowFor = 0; return; }
    // A 60-frame exponential average — same horizon as the spec, no ring buffer to allocate.
    this.frameAvg += (dt - this.frameAvg) * (1 / 60);
    if (this.autoGrace > 0) { this.autoGrace = Math.max(0, this.autoGrace - dt); return; }
    if (!this.autoQuality) return;

    // ── RESOLUTION FIRST, FEATURES LAST ──────────────────────────────────────
    //
    // A tier drop is a cliff: it turns off bloom, or the grain, or halves the prepass — all
    // things a player SEES. Render scale is a continuous dial that this art direction barely
    // registers, because the halftone pitch is authored in CSS pixels and converted per
    // `pixelRatio`, so the dots keep their on-screen size instead of shrinking with the buffer.
    //
    // MEASURED, 25 zombies at 2554x1230: scale 1.0 = 5.25 ms, 0.85 = 3.77, 0.70 = 2.73,
    // 0.60 = 2.17. Roughly 1/scale², because it scales the whole frame — scene, ink and post
    // together — not one stage of it.
    //
    // So: give away resolution down to MIN before giving away a single feature. The two
    // thresholds are deliberately apart (13.5 ms down, 10.5 ms up) so the dial cannot oscillate
    // around a single boundary; a frame that sits between them is left alone.
    const ms = this.frameAvg * 1000;

    // ── A SPIKE IS NOT A TREND ────────────────────────────────────────────────
    //
    // The first version drove this off the 60-frame average alone, and a round start is a burst:
    // bodies spawn, VFX pools touch their shaders for the first time, the title card and panel
    // frame come up. That burst dragged the average over budget, the dial dropped resolution, and
    // then crept back over several seconds — so every round opened blurry and slowly sharpened.
    // The playtester's words: "graphics go to the shit when starting rounds and start to get
    // better". That is this governor hunting, not the renderer failing.
    //
    // So a drop now requires the frame to be over budget CONTINUOUSLY. `slowFor` resets the
    // instant one frame comes in under it, which a burst always does the moment it ends. Only
    // genuine sustained load — a horde that is actually too big for this GPU — survives that.
    if (ms <= RenderScale.TARGET_MS) this.slowFor = 0;

    if (ms > RenderScale.TARGET_MS) {
      this.slowFor += dt;
      if (this.slowFor >= AUTO_QUALITY_HOLD) {
        // Stay in adjusting mode rather than re-arming the full hold: the first step costs 3 s of
        // sustained slowness to earn, and after that the dial converges at `ADJUST_S`. Small
        // steps are only invisible if there are enough of them to actually reach the target.
        this.slowFor = AUTO_QUALITY_HOLD - RenderScale.ADJUST_S;
        if (this._renderScale > RenderScale.MIN + 0.002) {
          this.renderScale = Math.max(RenderScale.MIN, this._renderScale - RenderScale.STEP);
        }
        // ── AND THEN IT STOPS. NO AUTOMATIC TIER DROP DURING A RUN. ──────────────────────
        //
        // This used to fall through to `quality = TIER_ORDER[i - 1]` once resolution bottomed
        // out. A tier drop switches bloom, grain and the prepass scale OFF — it does not soften
        // the image, it CHANGES it, mid-fight, without the player doing anything. That is the
        // literal definition of the bug GAME_BIBLE §8.5 names: "anything that varies without the
        // player causing it is a bug", and it is the thing the playtester was actually seeing.
        //
        // A machine that cannot hold 60 at MIN scale should pick a lower tier ONCE, at boot,
        // where it costs nothing and surprises nobody — or the player sets it themselves in the
        // graphics menu, which now exists. Degrading their run to buy frames is not our call.
      }
    } else if (ms < RenderScale.RELAX_MS && this._renderScale < 1) {
      // Headroom. Climb back, slower than we fell — recovering resolution is a nicety, dropping
      // it is a necessity, and a dial that rises eagerly will hunt.
      this.slowFor = 0;
      this.fastFor += dt;
      if (this.fastFor >= AUTO_QUALITY_RECOVER) {
        this.fastFor = 0;
        this.renderScale = Math.min(1, this._renderScale + RenderScale.STEP);
      }
    } else {
      this.slowFor = 0;
      this.fastFor = 0;
    }
  }

  private decayOverlays(dt: number): void {
    const u = this.pipeline;

    if (this.flashAmount > 0) {
      this.flashAmount = Math.max(0, this.flashAmount - dt * FLASH_DECAY);
    }
    if (this.speedAmount > 0) {
      this.speedAmount = Math.max(0, this.speedAmount - dt * SPEEDLINE_DECAY);
    }
    if (this.splatAmount > 0) {
      this.splatAmount = Math.max(0, this.splatAmount - dt * SPLAT_DECAY);
    }
    // Snap in, ease out — the panel slams onto the page and then relaxes.
    if (this.frameValue !== this.frameTarget) {
      const rate = this.frameTarget > this.frameValue ? FRAME_ATTACK : FRAME_RELEASE;
      this.frameValue += (this.frameTarget - this.frameValue) * Math.min(1, dt * rate);
      // An exponential approach never actually ARRIVES, and a panel border that is still
      // creeping by 1e-4 a frame is a border that repaints every frame for as long as it is
      // up. ART §4.1 wants the settled state bit-identical, so we land it.
      if (Math.abs(this.frameTarget - this.frameValue) < 1e-3) this.frameValue = this.frameTarget;
    }

    u.u('uOvFlash').value = this.flashAmount;
    u.u('uOvSpeed').value = this.speedAmount;
    u.u('uOvSplat').value = this.splatAmount;
    // The damage ring and the lens splats are the same event, seen twice.
    u.u('uVigDamage').value = this.splatAmount * 0.55;
    u.u('uFrame').value = this.frameValue;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RenderService — outlines
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Give every mesh under `target` an inverted-hull silhouette. The hulls are welded
   * (flat-shaded geometry shatters otherwise), cached per source geometry, and placed on
   * LAYER.OUTLINE so the ink prepass never sees them.
   */
  addOutline(target: Mesh | Group, thickness = 3.5, opts: OutlineOptions = {}): void {
    if (this.outlines.has(target)) return;
    const hulls = outlineTree(target, { thickness, ...opts });
    if (hulls.length > 0) this.outlines.set(target, hulls);
  }

  removeOutline(target: Mesh | Group): void {
    const hulls = this.outlines.get(target);
    if (!hulls) return;
    disposeOutlines(hulls);
    this.outlines.delete(target);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RenderService — overlays (all self-decaying)
  // ───────────────────────────────────────────────────────────────────────────

  /** Full-screen impact flash — the comic white frame. Stacks by max. */
  flash(intensity: number, colorHex?: number): void {
    const i = Math.max(0, Math.min(1.5, intensity));
    if (i <= this.flashAmount) return;
    this.flashAmount = i;
    if (colorHex !== undefined) {
      const [r, g, b] = rgb8Hex(colorHex);
      (this.pipeline.u<Vector3>('uOvFlashColor').value).set(r / 255, g / 255, b / 255);
    }
  }

  /** Radial speed lines. Feed it every frame while sprinting; it decays on its own. */
  speedLines(intensity: number): void {
    const i = Math.max(0, Math.min(1, intensity));
    if (i > this.speedAmount) this.speedAmount = i;
  }

  /**
   * Lens ink splats — the damage indicator. `dirX/dirY` is the screen-space direction the
   * damage came from (+x right, +y up); the splats bias toward it.
   */
  inkSplat(intensity: number, dirX = 0, dirY = 0): void {
    const i = Math.max(0, Math.min(1, intensity));
    if (i > this.splatAmount) this.splatAmount = i;
    (this.pipeline.u<Vector2>('uOvSplatDir').value).set(dirX, dirY);
  }

  /**
   * The PANEL FRAME. Drive to 1 for a big beat (round start, boon draw, the last kill of
   * a round) and back to 0 when it is over. Snaps in, eases out.
   */
  panelFrame(amount: number): void {
    const t = Math.max(0, Math.min(1, amount));
    // RISING EDGE = a new panel = a new hand-inked contour, drawn once and then held dead
    // still for the whole beat (ART §4.1 — the frame is print, not drawing). This is the only
    // writer of uFrameSeed; nothing anywhere may drive it from a clock.
    if (t > 0.001 && this.frameTarget <= 0.001) this.reseedPanelFrame();
    this.frameTarget = t;
  }

  /**
   * Golden-ratio walk rather than `Math.random()`: deterministic, allocation-free, and each
   * beat lands somewhere visibly different from the last.
   */
  private reseedPanelFrame(): void {
    this.frameSeedTick++;
    const n = this.frameSeedTick;
    const s = this.pipeline.u<Vector3>('uFrameSeed').value;
    const fract = (x: number): number => x - Math.floor(x);
    s.set(fract(n * 0.7548776662), fract(n * 0.5698402909), fract(n * 0.3819660113));
  }

  /** Tint the speed lines — INK while sprinting, HOT on a big hit. */
  setSpeedLineColor(colorHex: number): void {
    const [r, g, b] = rgb8Hex(colorHex);
    (this.pipeline.u<Vector3>('uOvSpeedColor').value).set(r / 255, g / 255, b / 255);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Teardown
  // ───────────────────────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.three.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.three.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    for (const hulls of this.outlines.values()) disposeOutlines(hulls);
    this.outlines.clear();
    this.pipeline.dispose();
    this.prepassRT.dispose();
    this.depthTex.dispose();
    this.emissiveRT.dispose();
    this.normalMat.dispose();
    this.three.dispose();
  }

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    console.warn('[render] WebGL context lost');
  };

  private readonly onContextRestored = (): void => {
    console.warn('[render] WebGL context restored — reapplying quality tier');
    this.applyTier(false);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BLACK = new Color(0, 0, 0);

/** Minimal scene/camera the pipeline is constructed against; `render()` re-points it. */
const PLACEHOLDER = {
  scene: { isScene: true } as unknown as Scene,
  camera: { isCamera: true } as unknown as PerspectiveCamera,
};

function makeDepthTexture(w: number, h: number): DepthTexture {
  const d = new DepthTexture(w, h, UnsignedIntType);
  d.format = DepthFormat;
  d.minFilter = NearestFilter;
  d.magFilter = NearestFilter;
  d.generateMipmaps = false;
  d.name = 'prepass.depth';
  return d;
}

function makePrepassRT(w: number, h: number, depth: DepthTexture): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(w, h, {
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.depthTexture = depth;
  rt.texture.name = 'prepass.normal';
  return rt;
}

function makeEmissiveRT(w: number, h: number): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(w, h, {
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.name = 'prepass.emissive';
  return rt;
}

export function createRenderer(opts: RendererOptions = {}): ComicRenderer {
  return new ComicRenderer(opts);
}

/**
 * PASS 4 — SELECTIVE BLOOM, tuned as a comic GLOW BLEED (ART_DIRECTION §4.4)
 *
 * Not a soft haze. In print, a glowing thing gets a *halo of ink screens* around it —
 * discrete rings of tone, saturated, with a hard core. So:
 *
 *   • The bright source is `max(thresholded scene, LAYER.BLOOM render)`. The layer render
 *     is what makes this *selective*: a muzzle flash, a powerup, a rim light or a wall-buy
 *     sign is drawn into a small emissive-only target by the renderer and always blooms,
 *     regardless of how bright the graded scene happens to be. Threshold alone catches
 *     anything else that is genuinely hot.
 *   • The blur runs over N halving mip levels with a separable 9-tap kernel.
 *   • The composite QUANTISES the glow magnitude into hard steps and boosts its saturation,
 *     then multiplies it by a halftone screen, so the halo prints as dots rather than as
 *     an airbrushed smear. This is the difference between "comic" and "bloom slider".
 *
 * Runs in LINEAR light. Additive.
 */

import {
  ClampToEdgeWrapping, HalfFloatType, LinearFilter, RGBAFormat, ShaderMaterial, Vector2, Vector3,
  WebGLRenderTarget, type Texture, type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { PALETTE } from '@/art/palette';
import { COMMON_DECLS, GLSL_UTIL, linVec, type CommonUniforms } from './common';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const THRESHOLD_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tEmissive;
  uniform float uHasEmissive;
  uniform float uThreshold;
  uniform float uKnee;
  uniform float uEmissiveBoost;
  varying vec2 vUv;
  const vec3 CZ_LUMA = vec3(0.2126, 0.7152, 0.0722);
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    vec3 e = texture2D(tEmissive, vUv).rgb * uEmissiveBoost * uHasEmissive;
    c = max(c, e);
    float l = dot(c, CZ_LUMA);
    float k = smoothstep(uThreshold, uThreshold + max(uKnee, 0.001), l);
    gl_FragColor = vec4(c * k, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec2 uDirection;
  varying vec2 vUv;
  void main() {
    // 9-tap gaussian, linear-sampled pairs folded in.
    vec3 s = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
    vec2 o1 = uDirection * 1.3846153846;
    vec2 o2 = uDirection * 3.2307692308;
    s += texture2D(tDiffuse, vUv + o1).rgb * 0.3162162162;
    s += texture2D(tDiffuse, vUv - o1).rgb * 0.3162162162;
    s += texture2D(tDiffuse, vUv + o2).rgb * 0.0702702703;
    s += texture2D(tDiffuse, vUv - o2).rgb * 0.0702702703;
    gl_FragColor = vec4(s, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom0;
  uniform sampler2D tBloom1;
  uniform sampler2D tBloom2;
  uniform vec3 uWeights;
  uniform float uStrength;
  uniform float uSteps;
  uniform float uSaturation;
  uniform float uDots;
  uniform float uDotPitch;
  uniform vec3 uTint;
  varying vec2 vUv;
  ${COMMON_DECLS}
  ${GLSL_UTIL}
  void main() {
    vec3 base = texture2D(tDiffuse, vUv).rgb;
    vec3 b = texture2D(tBloom0, vUv).rgb * uWeights.x
           + texture2D(tBloom1, vUv).rgb * uWeights.y
           + texture2D(tBloom2, vUv).rgb * uWeights.z;

    float l = czLum(b);
    if (l > 0.0001) {
      // Quantise the HALO's magnitude, keeping its hue: printed rings, not a gradient.
      float q = floor(clamp(l, 0.0, 4.0) * uSteps) / uSteps;
      // Keep a smooth sliver of the top step so the core never looks stepped.
      q = mix(q, l, 0.22);
      b *= q / l;
      // Saturate the glow — comic light is coloured light.
      b = mix(vec3(czLum(b)), b, uSaturation) * uTint;
      // Print the halo as tone, on the FRAME'S screen (uScreenPitch) at the yellow plate
      // angle. uDotPitch is a multiplier, not an absolute pitch: an independent ~6.5px
      // lattice sitting next to a 9.9px one beat across every glowing window in the arena,
      // and a beat is moiré, not print.
      float cov = clamp(q * 1.4, 0.0, 1.0);
      float d = czDots(gl_FragCoord.xy, cov, 45.0, uScreenPitch * uDotPitch);
      b *= mix(1.0, 0.45 + 0.85 * d, uDots);
    }
    gl_FragColor = vec4(base + b * uStrength, 1.0);
  }
`;

export interface BloomOptions {
  /** Number of halving blur levels. 1 at MED, 2 at HIGH, 3 at ULTRA. */
  levels?: number;
  strength?: number;
  threshold?: number;
  knee?: number;
  /** Hard steps the glow magnitude is quantised into. */
  steps?: number;
  saturation?: number;
  /** How much of the halo is replaced by a dot screen, 0..1. */
  dots?: number;
  /** Halo screen pitch as a MULTIPLE of the frame's screen pitch. 1 = the same lattice. */
  dotPitch?: number;
  emissiveBoost?: number;
  /** Overall glow tint. Defaults to neutral-warm so glow never goes green. */
  tint?: number;
}

function makeRT(w: number, h: number, name: string): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.name = name;
  rt.texture.generateMipmaps = false;
  return rt;
}

export class ComicBloomPass extends Pass {
  private _levels: number;
  private width = 1;
  private height = 1;

  /** Active blur levels, 1..3. Cheap to change — the targets are always allocated. */
  get levels(): number { return this._levels; }
  set levels(n: number) { this._levels = Math.max(1, Math.min(3, Math.round(n))); }

  private readonly rtBright: WebGLRenderTarget;
  private readonly rtH: WebGLRenderTarget[] = [];
  private readonly rtV: WebGLRenderTarget[] = [];

  private readonly thresholdMat: ShaderMaterial;
  private readonly blurMat: ShaderMaterial;
  private readonly compositeMat: ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(width: number, height: number, common: CommonUniforms, opts: BloomOptions = {}) {
    super();
    this._levels = Math.max(1, Math.min(3, opts.levels ?? 3));
    this.needsSwap = true;

    this.thresholdMat = new ShaderMaterial({
      name: 'ComicBloomThreshold',
      vertexShader: VERT,
      fragmentShader: THRESHOLD_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tEmissive: { value: null },
        uHasEmissive: { value: 0 },
        uThreshold: { value: opts.threshold ?? 0.62 },
        uKnee: { value: opts.knee ?? 0.35 },
        uEmissiveBoost: { value: opts.emissiveBoost ?? 1.6 },
      },
    });

    this.blurMat = new ShaderMaterial({
      name: 'ComicBloomBlur',
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        uDirection: { value: new Vector2(1, 0) },
      },
    });

    this.compositeMat = new ShaderMaterial({
      name: 'ComicBloomComposite',
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tBloom0: { value: null },
        tBloom1: { value: null },
        tBloom2: { value: null },
        uWeights: { value: new Vector3(1, 0.72, 0.48) },
        uStrength: { value: opts.strength ?? 0.85 },
        uSteps: { value: opts.steps ?? 5 },
        uSaturation: { value: opts.saturation ?? 1.45 },
        uDots: { value: opts.dots ?? 0.55 },
        uDotPitch: { value: opts.dotPitch ?? 1 },
        uTint: { value: linVec(opts.tint ?? PALETTE.PAPER).lerp(linVec(PALETTE.GOLD), 0.18) },
        ...common,
      },
    });

    this.rtBright = makeRT(1, 1, 'bloom.bright');
    for (let i = 0; i < 3; i++) {
      this.rtH.push(makeRT(1, 1, `bloom.h${i}`));
      this.rtV.push(makeRT(1, 1, `bloom.v${i}`));
    }
    this.quad = new FullScreenQuad(this.thresholdMat);
    this.setSize(width, height);
  }

  /** The renderer's LAYER.BLOOM-only render. Pass `null` to fall back to threshold-only. */
  setEmissiveSource(tex: Texture | null): void {
    this.thresholdMat.uniforms.tEmissive!.value = tex;
    this.thresholdMat.uniforms.uHasEmissive!.value = tex ? 1 : 0;
  }

  get strength(): number { return this.compositeMat.uniforms.uStrength!.value as number; }
  set strength(v: number) { this.compositeMat.uniforms.uStrength!.value = v; }
  get threshold(): number { return this.thresholdMat.uniforms.uThreshold!.value as number; }
  set threshold(v: number) { this.thresholdMat.uniforms.uThreshold!.value = v; }

  override setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    let w = Math.max(1, this.width >> 1);
    let h = Math.max(1, this.height >> 1);
    this.rtBright.setSize(w, h);
    for (let i = 0; i < 3; i++) {
      this.rtH[i]!.setSize(w, h);
      this.rtV[i]!.setSize(w, h);
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }

  override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // 1 — threshold + downsample into the half-res bright buffer.
    this.thresholdMat.uniforms.tDiffuse!.value = readBuffer.texture;
    this.quad.material = this.thresholdMat;
    renderer.setRenderTarget(this.rtBright);
    renderer.clear();
    this.quad.render(renderer);

    // 2 — separable blur chain, halving each level.
    let src: Texture = this.rtBright.texture;
    const dir = this.blurMat.uniforms.uDirection!.value as Vector2;
    for (let i = 0; i < this._levels; i++) {
      const h = this.rtH[i]!;
      const v = this.rtV[i]!;
      this.quad.material = this.blurMat;

      this.blurMat.uniforms.tDiffuse!.value = src;
      dir.set(1 / h.width, 0);
      renderer.setRenderTarget(h);
      renderer.clear();
      this.quad.render(renderer);

      this.blurMat.uniforms.tDiffuse!.value = h.texture;
      dir.set(0, 1 / v.height);
      renderer.setRenderTarget(v);
      renderer.clear();
      this.quad.render(renderer);

      src = v.texture;
    }

    // 3 — composite. Unused levels sample the last one at zero weight.
    const u = this.compositeMat.uniforms;
    u.tDiffuse!.value = readBuffer.texture;
    u.tBloom0!.value = this.rtV[0]!.texture;
    u.tBloom1!.value = this.rtV[Math.min(1, this._levels - 1)]!.texture;
    u.tBloom2!.value = this.rtV[Math.min(2, this._levels - 1)]!.texture;
    (u.uWeights!.value as Vector3).set(1, this._levels > 1 ? 0.72 : 0, this._levels > 2 ? 0.48 : 0);

    this.quad.material = this.compositeMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);

    renderer.autoClear = oldAutoClear;
  }

  override dispose(): void {
    this.rtBright.dispose();
    for (const rt of this.rtH) rt.dispose();
    for (const rt of this.rtV) rt.dispose();
    this.thresholdMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.quad.dispose();
  }
}

/** Factory, for symmetry with the ShaderPass-based passes. */
export function makeBloomPass(
  width: number,
  height: number,
  common: CommonUniforms,
  opts: BloomOptions = {},
): ComicBloomPass {
  return new ComicBloomPass(width, height, common, opts);
}

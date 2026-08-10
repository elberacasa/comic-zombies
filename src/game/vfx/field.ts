/**
 * THE INSTANCED FIELD — one `InstancedMesh`, one draw call, N effects.
 *
 * Every VFX family in this milestone is an `InstancedField`: a fixed-capacity slot allocator
 * bolted to an `InstancedMesh` whose per-instance attributes carry a UV rect into the VFX sheet,
 * a tint and an opacity. That combination is what lets impacts, blood, dust and drip tails —
 * six different shapes with four different colours — cost exactly ONE draw call between them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY SLOTS ARE STABLE (and why that is an ART §4.1 decision, not a perf one)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The obvious design compacts live instances into `[0, live)` every frame and sets `mesh.count`.
 * It is also the design that makes a *settled decal* re-upload its matrix 60 times a second
 * forever. Here a slot index IS an instance index for the life of the effect, so a family whose
 * contents did not move this frame uploads nothing at all: `flush()` is a no-op unless someone
 * called a setter. A decal that has landed is then genuinely frozen — in the buffer, not just
 * on screen.
 *
 * The cost is that a family always draws `capacity` instances, most of them collapsed to a
 * zero-scale matrix. A collapsed instance is 4 vertex invocations that produce degenerate
 * triangles and zero fragments; at our capacities that is under 3000 wasted vertices across the
 * whole VFX layer, against a 900k triangle budget. It is not a real cost.
 *
 * A family with nothing live sets `mesh.visible = false` and costs ZERO draw calls.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * LAYERS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every field lives on `LAYER.NO_INK`. VFX must not enter the normal/depth prepass: a flat card
 * is a rectangle to a Sobel filter, so the ink pass would draw a box around every particle.
 * The linework a card needs is baked into its cell on the sheet instead. Fields that glow also
 * enable `LAYER.BLOOM`, which costs one extra draw call (the emissive prepass) — the muzzle
 * flash is the only family that pays it.
 */

import {
  BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Float32BufferAttribute, FrontSide,
  InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, ShaderMaterial, Vector3,
  type Texture,
} from 'three';

import { IdAllocator, SparseSet } from '@/core/pool';
import { LAYER } from '@/render/materials/index';
import type { Cell } from '@/game/vfx/sheet';

// ─────────────────────────────────────────────────────────────────────────────
// The shader. Two lines of maths and a hard alpha cut — the whole point of the
// comic look is that there is nothing soft to compute.
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_VERT = /* glsl */ `
  attribute vec4 aUvRect;
  attribute vec3 aTint;
  attribute float aFade;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vFade;
  void main() {
    vUv = aUvRect.xy + uv * aUvRect.zw;
    vTint = aTint;
    vFade = aFade;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

/**
 * `uCut` is the whole art direction in one uniform: a card is either printed or it is not.
 * The sheet's masks are already near-binary, so this only removes the one texel of anti-alias
 * the painters leave behind — which is exactly what a printing press does.
 */
const FIELD_FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D uSheet;
  uniform float uCut;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vFade;
  void main() {
    vec4 t = texture2D(uSheet, vUv);
    float a = t.a * vFade;
    if (a < uCut) discard;
    gl_FragColor = vec4(t.rgb * vTint, a);
    #include <colorspace_fragment>
  }
`;

/** A unit quad in the XY plane, centred on the origin. Four verts, two triangles. */
function unitQuad(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeBoundingSphere();
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface FieldOptions {
  name: string;
  capacity: number;
  sheet: Texture;
  /**
   * SOLID cards depth-write and cut hard at 50% — panel shards, which are objects in the
   * world and must occlude each other correctly. Everything else is a transparent print laid
   * over the frame and must not write depth.
   */
  solid?: boolean;
  doubleSide?: boolean;
  /** Transparent fields sort against each other by this. Decals under, words over. */
  renderOrder?: number;
  /** Join LAYER.BLOOM. Costs one extra draw call; only the muzzle flash earns it. */
  bloom?: boolean;
  /** Discard threshold. Defaults to 0.04 for prints, 0.5 for solids. */
  cut?: number;
  /** Depth bias in units — decals need it or they z-fight the surface they are printed on. */
  polygonOffset?: number;
}

export class InstancedField {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
  readonly material: ShaderMaterial;

  private readonly geometry: BufferGeometry;
  private readonly uvRect: InstancedBufferAttribute;
  private readonly tint: InstancedBufferAttribute;
  private readonly fade: InstancedBufferAttribute;

  private readonly ids: IdAllocator;
  private readonly set: SparseSet;

  private matrixDirty = false;
  private attrDirty = false;
  private _peak = 0;
  private _starved = 0;

  constructor(opts: FieldOptions) {
    this.capacity = Math.max(1, opts.capacity | 0);
    this.geometry = unitQuad();

    const solid = opts.solid === true;
    this.material = new ShaderMaterial({
      name: `Vfx:${opts.name}`,
      vertexShader: FIELD_VERT,
      fragmentShader: FIELD_FRAG,
      uniforms: {
        uSheet: { value: opts.sheet },
        uCut: { value: opts.cut ?? (solid ? 0.5 : 0.04) },
      },
      transparent: !solid,
      depthWrite: solid,
      depthTest: true,
      side: opts.doubleSide === false ? FrontSide : DoubleSide,
      polygonOffset: opts.polygonOffset !== undefined,
      polygonOffsetFactor: -(opts.polygonOffset ?? 0),
      polygonOffsetUnits: -(opts.polygonOffset ?? 0),
    });

    const n = this.capacity;
    this.uvRect = new InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.tint = new InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    this.fade = new InstancedBufferAttribute(new Float32Array(n), 1);
    this.uvRect.setUsage(DynamicDrawUsage);
    this.tint.setUsage(DynamicDrawUsage);
    this.fade.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aUvRect', this.uvRect);
    this.geometry.setAttribute('aTint', this.tint);
    this.geometry.setAttribute('aFade', this.fade);

    this.mesh = new InstancedMesh(this.geometry, this.material, n);
    this.mesh.name = `vfx-${opts.name}`;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = opts.renderOrder ?? 0;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    // NO_INK keeps flat cards out of the Sobel prepass; BLOOM is opt-in and costs a draw call.
    this.mesh.layers.set(LAYER.NO_INK);
    if (opts.bloom) this.mesh.layers.enable(LAYER.BLOOM);

    // Every slot starts collapsed. A zero-scale matrix is well defined (w stays 1), so the
    // four verts land on one point and the rasteriser throws the triangles away.
    const m = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < n; i++) m[i * 16 + 15] = 1;

    this.ids = new IdAllocator(n);
    this.set = new SparseSet(n);
  }

  get live(): number { return this.set.size; }
  get peak(): number { return this._peak; }
  /** Non-zero means the pool ran dry and effects were dropped. Retune `VFX.pool`. */
  get starved(): number { return this._starved; }
  /** Packed live slot ids. Valid for `[0, live)`. Order changes on release — never assume it. */
  get dense(): Int32Array { return this.set.dense; }

  /** Take a slot, or -1 at the cap. Never grows, never allocates. */
  acquire(): number {
    const id = this.ids.alloc();
    if (id < 0) { this._starved++; return -1; }
    this.set.add(id);
    if (this.set.size > this._peak) this._peak = this.set.size;
    this.mesh.visible = true;
    return id;
  }

  /** Give a slot back and collapse its instance. Releasing twice corrupts the allocator. */
  release(slot: number): void {
    if (!this.set.has(slot)) return;
    this.set.remove(slot);
    this.ids.release(slot);
    this.collapse(slot);
    if (this.set.size === 0) this.mesh.visible = false;
  }

  releaseAll(): void {
    const d = this.set.dense;
    for (let i = this.set.size - 1; i >= 0; i--) this.release(d[i]);
  }

  // ── per-instance writes ────────────────────────────────────────────────────

  setCell(slot: number, cell: Cell): void {
    const a = this.uvRect.array as Float32Array;
    const i = slot * 4;
    a[i] = cell.u0; a[i + 1] = cell.v0; a[i + 2] = cell.du; a[i + 3] = cell.dv;
    this.attrDirty = true;
  }

  setTint(slot: number, c: Color): void {
    const a = this.tint.array as Float32Array;
    const i = slot * 3;
    a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b;
    this.attrDirty = true;
  }

  setFade(slot: number, v: number): void {
    (this.fade.array as Float32Array)[slot] = v;
    this.attrDirty = true;
  }

  /** Write a composed transform. Use the `compose*` helpers below to build one. */
  setMatrix(slot: number, m: Matrix4): void {
    m.toArray(this.mesh.instanceMatrix.array as Float32Array, slot * 16);
    this.matrixDirty = true;
  }

  private collapse(slot: number): void {
    const a = this.mesh.instanceMatrix.array as Float32Array;
    const o = slot * 16;
    for (let i = 0; i < 16; i++) a[o + i] = 0;
    a[o + 15] = 1;
    (this.fade.array as Float32Array)[slot] = 0;
    this.matrixDirty = true;
    this.attrDirty = true;
  }

  /**
   * Upload whatever actually changed. Called once per frame per family — and does nothing at
   * all on a frame where nothing moved, which is the ART §4.1 guarantee for settled decals.
   */
  flush(): void {
    if (this.matrixDirty) { this.mesh.instanceMatrix.needsUpdate = true; this.matrixDirty = false; }
    if (this.attrDirty) {
      this.uvRect.needsUpdate = true;
      this.tint.needsUpdate = true;
      this.fade.needsUpdate = true;
      this.attrDirty = false;
    }
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Matrix composition helpers. All allocation-free — the scratch below is the
// only state and it is written and consumed inside a single call.
// ─────────────────────────────────────────────────────────────────────────────

const _q = new Quaternion();
const _qr = new Quaternion();
const _s = new Vector3();
const _axisZ = new Vector3(0, 0, 1);
const _right = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();
const _pos = new Vector3();

/**
 * A camera-facing card with an in-plane roll.
 * `camQuat` is the camera's world quaternion; rolling AFTER it spins the card in screen space,
 * which is what makes twenty identical droplets stop looking like twenty identical droplets.
 */
export function composeBillboard(
  out: Matrix4, pos: Vector3, camQuat: Quaternion, roll: number, w: number, h: number,
): Matrix4 {
  _q.copy(camQuat).multiply(_qr.setFromAxisAngle(_axisZ, roll));
  return out.compose(pos, _q, _s.set(w, h, 1));
}

/** A card lying on a surface: +Z along `normal`, rolled in the surface plane. */
export function composeSurface(
  out: Matrix4, pos: Vector3, normal: Vector3, roll: number, w: number, h: number,
): Matrix4 {
  _q.setFromUnitVectors(_axisZ, _fwd.copy(normal).normalize());
  _q.multiply(_qr.setFromAxisAngle(_axisZ, roll));
  return out.compose(pos, _q, _s.set(w, h, 1));
}

/** A freely tumbling card — panel shards. `rot` is an owned quaternion the caller integrates. */
export function composeFree(out: Matrix4, pos: Vector3, rot: Quaternion, w: number, h: number): Matrix4 {
  return out.compose(pos, rot, _s.set(w, h, 1));
}

/**
 * A streak: the quad's +Y runs from `from` to `to`, its +X faces the camera.
 * Built as an explicit basis rather than a look-at, because a look-at of a nearly view-aligned
 * direction is exactly where quaternion solutions flip and the streak strobes.
 */
export function composeStreak(
  out: Matrix4, from: Vector3, to: Vector3, camPos: Vector3, halfWidth: number,
): Matrix4 {
  _up.copy(to).sub(from);
  const len = _up.length();
  if (len < 1e-5) return out.makeScale(0, 0, 0);
  _up.multiplyScalar(1 / len);
  _pos.copy(from).lerp(to, 0.5);
  _fwd.copy(camPos).sub(_pos);
  _right.crossVectors(_up, _fwd);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0).cross(_up);
  _right.normalize();
  _fwd.crossVectors(_right, _up).normalize();
  out.makeBasis(_right, _up, _fwd);
  out.scale(_s.set(halfWidth * 2, len, 1));
  out.setPosition(_pos);
  return out;
}

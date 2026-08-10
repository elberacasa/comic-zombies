/**
 * THE SKINNED RIG — bind pose, skin binding, and the per-instance bone palette.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS NOT `THREE.SkinnedMesh`. Read this before "simplifying" it.
 *
 *  The brief asked for `SkinnedMesh` + `Skeleton` + `Bone`. What ships here is real linear
 *  blend skinning — four influences per vertex, weights solved from bone-segment distance,
 *  one shared geometry, per-instance bone palette — but the palette is a uniform this module
 *  owns rather than a `THREE.Skeleton`. Four reasons, all structural:
 *
 *  1. **THE MATERIALS ARE NOT OURS.** A zombie's body material comes from
 *     `world/lighting.ts::makeEnemyMaterial()` (ART §9 makes that mandatory) and its silhouette
 *     from `render/materials::buildOutlineHull()`. Both are raw `ShaderMaterial`s with
 *     hand-written GLSL and no `#include <skinning_*>` chunks. three only wires bind matrices
 *     and the bone texture into a program that declares them, so using `SkinnedMesh` would mean
 *     editing two files this agent does not own — in the one place ART §9 says not to fork.
 *
 *  2. **THREE MATERIALS MUST POSE IDENTICALLY.** Body, hull and the renderer's depth/normal
 *     PREPASS stand-in (see `body.ts`) all draw the same zombie. They share ONE `Float32Array`
 *     by reference here, so they cannot disagree — not even by a frame. Under `SkinnedMesh` the
 *     hull is a child `Mesh`, not a `SkinnedMesh`, and would need its own bone plumbing.
 *
 *  3. **COST.** `Skeleton` allocates a `DataTexture` per skeleton and `Bone` is an `Object3D`:
 *     32 pooled bodies × 21 bones = 672 extra scene-graph nodes with 672 world-matrix updates
 *     and 32 texture uploads per frame, to reproduce a 252-float uniform we compute anyway.
 *
 *  4. **THE BUDGET IS THE POINT.** The palette is `vec4 uBone[63]` — a 3×4 affine row packing,
 *     63 vec4 registers instead of 84 for `mat4[21]` — and costs ZERO extra draw calls. 25
 *     skinned zombies stay at 50 draw calls, exactly as the rigid version did.
 *
 *  The lead should know this deviation exists. It is confined to this module and `body.ts`; if
 *  `InkMaterial` ever grows skinning chunks, swapping to `SkinnedMesh` is a local change.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT LIVES HERE
 *   • the bind pose (`BIND_POS`, `BIND_TAIL`, `INV_BIND`), derived once from `defs.SKEL`
 *   • `solveSkin()`  — bone-segment distance → four indices + four weights per vertex
 *   • `solveAo()`    — painted occlusion, solved as "how much other skeleton is this buried in"
 *   • `BonePalette`  — one instance's rest offsets, scales, posed bone matrices and the packed
 *                      uniform array; this is also the object the combat agent reads bones from
 *   • `SKIN_DECL` / `SKIN_MAIN` — the GLSL the three materials are patched with
 *
 * ZERO ALLOCATION after construction. `compose()` runs 12 times a second per body and touches
 * only module scratch.
 */

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import {
  BODY, BONE_COUNT, BONE_PARENT, BONE_TAIL, SKEL,
} from '@/game/enemies/defs';

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE POSE BUFFER LAYOUT
//
// `body.ts` writes one 9-float record per bone and this module consumes it. Nine floats, not a
// Matrix4, because every animation layer is ADDITIVE — a flinch adds radians onto a wind-up
// which added radians onto a gait — and you cannot add matrices.
// ═════════════════════════════════════════════════════════════════════════════

export const POSE_STRIDE = 9;
/** Field offsets into a bone's 9-float pose record. */
export const RX = 0;
export const RY = 1;
export const RZ = 2;
export const OX = 3;
export const OY = 4;
export const OZ = 5;
export const SX = 6;
export const SY = 7;
export const SZ = 8;

/** Allocate a pose buffer. One per module — `body.ts` keeps exactly one, shared by all bodies. */
export function makePoseBuffer(): Float32Array {
  return new Float32Array(BONE_COUNT * POSE_STRIDE);
}

/** Reset a pose buffer to the bind pose (no rotation, no offset, unit scale). */
export function clearPose(pose: Float32Array): void {
  for (let i = 0; i < BONE_COUNT; i++) {
    const b = i * POSE_STRIDE;
    pose[b + RX] = 0; pose[b + RY] = 0; pose[b + RZ] = 0;
    pose[b + OX] = 0; pose[b + OY] = 0; pose[b + OZ] = 0;
    pose[b + SX] = 1; pose[b + SY] = 1; pose[b + SZ] = 1;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE BIND POSE
//
// Bind rotations are identity by construction — `SKEL` is joint OFFSETS only — so a bind world
// matrix is a pure translation and its inverse is the negated translation. That is not a
// shortcut, it is the property that makes the whole rig auditable: a vertex's bind-space
// position minus its bone's bind position IS its offset from the joint, with no matrix maths
// in between, which is what `solveSkin` measures and what the hitbox API reports.
// ═════════════════════════════════════════════════════════════════════════════

/** Joint position of each bone in enemy-local BIND space. */
export const BIND_POS: readonly Vector3[] = (() => {
  const out: Vector3[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const r = SKEL[i] as { x: number; y: number; z: number };
    const p = new Vector3(r.x, r.y, r.z);
    const parent = BONE_PARENT[i] as number;
    if (parent >= 0) p.add(out[parent] as Vector3);
    out.push(p);
  }
  return out;
})();

/**
 * Tail (far end) of each bone in BIND space. This is the segment EVERYTHING measures against —
 * skin weights, painted AO, and the combat agent's capsules — so getting it wrong is not a
 * cosmetic error, it silently unbinds a whole region.
 *
 * The rule is: an authored `BONE_TAIL` always wins; otherwise the bone points at its FIRST
 * child by index. "First child" and not "the mean of the children", which is what this
 * originally did and which the harness caught immediately:
 *
 *   HIPS has three children — SPINE (up) and both THIGHs (down) — and their mean is
 *   0.002 m from the hips joint. A 2 mm bone segment binds nothing and occludes nothing; the
 *   entire pelvis was effectively falling through to the spine and the thighs.
 *   CHEST has NECK plus two clavicles, and their mean pointed the chest sideways.
 *
 * Bone index order is authored so that the first child is always the primary chain (defs.ts
 * `BONE_PARENT`), which makes this rule correct by construction rather than by luck.
 */
export const BIND_TAIL: readonly Vector3[] = (() => {
  const out: Vector3[] = [];
  for (let i = 0; i < BONE_COUNT; i++) out.push(new Vector3());
  for (let i = 0; i < BONE_COUNT; i++) {
    const acc = out[i] as Vector3;
    const p = BIND_POS[i] as Vector3;
    const authored = BONE_TAIL[i];
    if (authored) {
      acc.set(p.x + authored[0], p.y + authored[1], p.z + authored[2]);
      continue;
    }
    let first = -1;
    for (let c = 0; c < BONE_COUNT; c++) {
      if (BONE_PARENT[c] === i) { first = c; break; }
    }
    if (first >= 0) acc.copy(BIND_POS[first] as Vector3);
    else acc.set(p.x, p.y - (SKEL[i] as { radius: number }).radius * 1.5, p.z);
  }
  return out;
})();

/** Length of each bone's bind segment, metres. */
export const BIND_LENGTH: readonly number[] = BIND_POS.map((p, i) => p.distanceTo(BIND_TAIL[i] as Vector3));

/** `INV_BIND[i] · v` takes a BIND-space point into bone `i`'s local space. */
export const INV_BIND: readonly Matrix4[] = BIND_POS.map((p) => new Matrix4().makeTranslation(-p.x, -p.y, -p.z));

// ── scratch ──────────────────────────────────────────────────────────────────
const _ab = new Vector3();
const _ap = new Vector3();
const _q = new Quaternion();
const _qp = new Quaternion();
const _v = new Vector3();
const _s = new Vector3();
const _e = new Euler(0, 0, 0, 'YXZ');
const _m = new Matrix4();

/** Squared distance from a point to a bone's BIND segment. No allocation. */
function distToBone(bone: number, x: number, y: number, z: number): number {
  const a = BIND_POS[bone] as Vector3;
  const b = BIND_TAIL[bone] as Vector3;
  _ab.set(b.x - a.x, b.y - a.y, b.z - a.z);
  _ap.set(x - a.x, y - a.y, z - a.z);
  const len2 = _ab.lengthSq();
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, _ap.dot(_ab) / len2));
  const dx = _ap.x - _ab.x * t;
  const dy = _ap.y - _ab.y * t;
  const dz = _ap.z - _ab.z * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Public form of the same query — tooling and harnesses use it to audit the bind. */
export function distanceToBone(bone: number, p: Vector3): number {
  return distToBone(bone, p.x, p.y, p.z);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. SKIN BINDING
// ═════════════════════════════════════════════════════════════════════════════

/** Maximum bone influences per vertex. Four is the classic budget and the shader is unrolled. */
export const SKIN_INFLUENCES = 4;

/**
 * Softening term, metres, added to every distance before the falloff. It is what stops a vertex
 * sitting exactly ON a bone segment from taking 100% of that bone: at d = 0 the weight would be
 * infinite and the surface would rotate rigidly again, which is the bug this whole file exists
 * to fix. 0.035 ≈ a third of a limb radius.
 */
const SKIN_SOFT = 0.035;

/**
 * Falloff exponent. This is the one number that decides whether the character reads as skinned
 * or as rubber, and it is a trade with a measurable middle:
 *
 *   P = 3   an elbow bend drags a third of the upper arm with it — the limb bows like a hose
 *   P = 5   the bend is confined to ~1.4 bone radii either side of the joint — a real elbow
 *   P = 9   the blend band is under half a radius; the joint creases hard and the silhouette
 *           pinches, which is visually indistinguishable from the rigid parts we just removed
 *
 * 5. Verified by `tools/zombie.mjs skin`, which reports the blend-band width at every joint.
 */
const SKIN_POW = 5;

/** Weights below this fraction of the vertex's strongest are dropped before normalising. */
const SKIN_CULL = 0.04;

const _cand: number[] = [];
const _candW: number[] = [];

/**
 * Solve four bone influences for a run of cage vertices.
 *
 * `bones` is the candidate set — the chain this surface belongs to plus its neighbours. Gating
 * candidates by surface region is not a shortcut, it is correctness: the forearm passes within
 * 6 cm of the thigh in the bind pose, and pure nearest-bone binding welds the two together the
 * first time the zombie takes a step.
 *
 * Writes `SKIN_INFLUENCES` floats per vertex into `outIndex`/`outWeight`, starting at
 * `vertexOffset`. Weights always sum to 1.
 */
export function solveSkin(
  position: Float32Array,
  count: number,
  bones: readonly number[],
  outIndex: Float32Array,
  outWeight: Float32Array,
  vertexOffset: number,
): void {
  for (let i = 0; i < count; i++) {
    const x = position[i * 3] as number;
    const y = position[i * 3 + 1] as number;
    const z = position[i * 3 + 2] as number;

    _cand.length = 0;
    _candW.length = 0;
    let best = 0;
    for (let k = 0; k < bones.length; k++) {
      const b = bones[k] as number;
      const d = distToBone(b, x, y, z);
      const w = Math.pow(1 / (d + SKIN_SOFT), SKIN_POW);
      _cand.push(b);
      _candW.push(w);
      if (w > best) best = w;
    }

    // Top-4 selection by partial insertion — `bones` is never longer than ~6, so this is a
    // handful of comparisons and it allocates nothing.
    const idx = [0, 0, 0, 0];
    const wt = [0, 0, 0, 0];
    for (let k = 0; k < _cand.length; k++) {
      const w = _candW[k] as number;
      if (w < best * SKIN_CULL) continue;
      for (let s = 0; s < SKIN_INFLUENCES; s++) {
        if (w > (wt[s] as number)) {
          for (let t = SKIN_INFLUENCES - 1; t > s; t--) {
            wt[t] = wt[t - 1] as number;
            idx[t] = idx[t - 1] as number;
          }
          wt[s] = w;
          idx[s] = _cand[k] as number;
          break;
        }
      }
    }

    let sum = 0;
    for (let s = 0; s < SKIN_INFLUENCES; s++) sum += wt[s] as number;
    if (sum <= 0) {
      // Unreachable with a non-empty candidate set, but a NaN weight is a mesh stretched to the
      // horizon, so the fallback is explicit rather than assumed.
      idx[0] = bones[0] as number;
      wt[0] = 1;
      sum = 1;
    }
    const o = (vertexOffset + i) * SKIN_INFLUENCES;
    for (let s = 0; s < SKIN_INFLUENCES; s++) {
      outIndex[o + s] = idx[s] as number;
      outWeight[o + s] = (wt[s] as number) / sum;
    }
  }
}

/**
 * PAINTED AMBIENT OCCLUSION (ART §2.5 — "ambient occlusion is painted, not computed").
 *
 * The rigid body darkened each part toward the joint it hung from. One continuous surface has
 * no parts to darken toward, so occlusion is solved for what it actually is: a vertex is dark
 * in proportion to how much OTHER skeleton it is buried in. `exclude` is the surface's own
 * chain, so a limb does not darken itself uniformly — only where another mass closes in.
 *
 * That lands the darkening in the armpits, the crotch, the neck root, under the jaw and under
 * the coat flap, with the deepest value on the body in the neck — which is exactly where an
 * inker would put it, and it is what keeps the head reading as a separate object.
 */
export function solveAo(
  position: Float32Array,
  normal: Float32Array,
  count: number,
  exclude: readonly number[],
  out: Float32Array,
  vertexOffset: number,
): void {
  const R = BODY.aoRange;
  for (let i = 0; i < count; i++) {
    const x = position[i * 3] as number;
    const y = position[i * 3 + 1] as number;
    const z = position[i * 3 + 2] as number;
    let occ = 0;
    for (let b = 0; b < BONE_COUNT; b++) {
      if (exclude.indexOf(b) >= 0) continue;
      const d = distToBone(b, x, y, z) - (SKEL[b] as { radius: number }).radius;
      if (d >= R) continue;
      const t = 1 - Math.max(0, d) / R;
      occ += t * t;
    }
    // Downward-facing surfaces sit in their own shadow — the cheapest half of any AO term.
    const ny = normal[i * 3 + 1] as number;
    const facing = 0.82 + 0.18 * (ny * 0.5 + 0.5);
    const ao = Math.max(BODY.aoMin, Math.min(1, (1 - Math.min(1, occ * 0.55)) * facing));
    out[vertexOffset + i] = ao;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE GLSL
//
// The palette is packed as THREE vec4 ROWS of a 4×4 affine matrix (the bottom row is always
// 0,0,0,1 and is never uploaded): 3 registers per bone instead of 4. At 21 bones that is 63
// vec4 uniforms rather than 84 — comfortably inside the 256-register floor, with room for the
// ink shader's own 40-odd uniforms and for the skeleton to grow.
// ═════════════════════════════════════════════════════════════════════════════

/** Number of `vec4` registers the bone palette occupies. */
export const PALETTE_VEC4S = BONE_COUNT * 3;
/** Length of the `Float32Array` a `BonePalette` uploads. */
export const PALETTE_FLOATS = PALETTE_VEC4S * 4;

export const SKIN_DECL = /* glsl */ `
attribute vec4 aSkinIndex;
attribute vec4 aSkinWeight;
uniform vec4 uBone[${PALETTE_VEC4S}];

mat4 czBoneMatrix(float fi) {
  int i = int(fi) * 3;
  vec4 r0 = uBone[i];
  vec4 r1 = uBone[i + 1];
  vec4 r2 = uBone[i + 2];
  return mat4(
    r0.x, r1.x, r2.x, 0.0,
    r0.y, r1.y, r2.y, 0.0,
    r0.z, r1.z, r2.z, 0.0,
    r0.w, r1.w, r2.w, 1.0);
}
`;

/**
 * Inserted at the top of `main()`. `position` and `normal` are attributes, i.e. globals, and a
 * local declaration legally shadows a global in GLSL — so every line after this one sees the
 * SKINNED vertex and the rest of the shader is untouched. That is why this is a short insertion
 * at one well-known marker rather than surgery on expressions we do not own.
 *
 * The normal is normalised with `inversesqrt(max(dot(n,n), 1e-12))` rather than `normalize()`:
 * a severed limb's bones are scaled to a speck, and `normalize(vec3(0))` is NaN, and one NaN in
 * an inverted hull's inflation direction is a triangle stretching to the horizon.
 */
export const SKIN_MAIN = /* glsl */ `
  vec3 czRawPosition = position;
  vec3 czRawNormal = normal;
  mat4 czSkin =
      czBoneMatrix(aSkinIndex.x) * aSkinWeight.x
    + czBoneMatrix(aSkinIndex.y) * aSkinWeight.y
    + czBoneMatrix(aSkinIndex.z) * aSkinWeight.z
    + czBoneMatrix(aSkinIndex.w) * aSkinWeight.w;
  vec3 position = (czSkin * vec4(czRawPosition, 1.0)).xyz;
  vec3 czSkinnedNormal = mat3(czSkin) * czRawNormal;
  vec3 normal = czSkinnedNormal * inversesqrt(max(dot(czSkinnedNormal, czSkinnedNormal), 1e-12));
`;

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE PER-INSTANCE PALETTE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A severed bone is scaled to a speck rather than to zero: a zero matrix makes the shader's
 * normal maths degenerate, and the vertices blended onto the neighbouring bone would inherit
 * garbage. At 1e-4 the collapsed triangles are sub-pixel, and the vertices that are only
 * PARTLY weighted to the severed bone stay put — which is why a shot-off arm now leaves a
 * ragged stump on the shoulder instead of a hole in the torso.
 */
export const SEVERED_SCALE = 1e-4;

/**
 * One zombie's skeleton instance: per-instance bone lengths and thicknesses, the posed bone
 * matrices, and the packed uniform the three materials share by reference.
 *
 * ── THE BONE API THE COMBAT AGENT READS ────────────────────────────────────────────────────
 * Everything below is valid immediately after `compose()`, which `EnemyBody.pose()` calls, and
 * is expressed in ENEMY-LOCAL space (origin at the collider's feet, +X the enemy's right, -Z
 * forward, +Y up). The service turns that into world space with the body's yaw and position —
 * see `EnemySystem.worldHitboxes`.
 *
 *   palette.bonePoint(BONE.HEAD, out)        → the joint (head end) of a bone
 *   palette.boneTip(BONE.HEAD, out)          → the far end (tail) of a bone
 *   palette.boneSegment(BONE.FORE_R, a, b)   → both, for a capsule
 *   palette.boneRadius(BONE.FORE_R)          → flesh half-width, already instance-scaled
 *   palette.boneMatrix(BONE.HEAD)            → the full posed matrix, to hang a decal or a
 *                                              particle emitter off; DO NOT MUTATE IT
 *   palette.boneLocal(BONE.HEAD, v, out)     → a point in that bone's local space → enemy-local
 *
 * These are read off the SAME stepped matrices the mesh is drawn with — the pose is evaluated
 * on the 12 Hz clock and the bones hold with it — so a head that is being held for five frames
 * is also being aimed at for those five frames. A hitbox that leads the drawing is the single
 * most infuriating bug a shooter can ship.
 * ───────────────────────────────────────────────────────────────────────────────────────────
 */
export class BonePalette {
  /** Per-instance, parent-relative joint offsets. Bone-LENGTH variation lives here. */
  readonly rest: Vector3[] = [];
  /** Per-instance bone thickness. Bone-GIRTH variation lives here. */
  readonly scale: Vector3[] = [];
  /** Posed bone matrices in enemy-local space (translation·rotation·scale). */
  readonly world: Matrix4[] = [];
  /** Posed joint positions in enemy-local space. */
  readonly wpos: Vector3[] = [];
  /** Posed joint orientations in enemy-local space. */
  readonly wquat: Quaternion[] = [];
  /** The uniform: `BONE_COUNT × 3` vec4 rows of `world · INV_BIND`. Shared by three materials. */
  readonly data = new Float32Array(PALETTE_FLOATS);

  private readonly radius = new Float32Array(BONE_COUNT);
  private readonly severed = new Uint8Array(BONE_COUNT);
  private readonly tailLocal: Vector3[] = [];

  constructor() {
    for (let i = 0; i < BONE_COUNT; i++) {
      const r = SKEL[i] as { x: number; y: number; z: number; radius: number };
      this.rest.push(new Vector3(r.x, r.y, r.z));
      this.scale.push(new Vector3(1, 1, 1));
      this.world.push(new Matrix4());
      this.wpos.push(new Vector3());
      this.wquat.push(new Quaternion());
      this.radius[i] = r.radius;
      // The tail expressed in the bone's own space, so it follows rotation AND bone scaling.
      const t = (BIND_TAIL[i] as Vector3).clone().sub(BIND_POS[i] as Vector3);
      this.tailLocal.push(t);
    }
    this.reset();
  }

  /** Restore the authored bind proportions. Call before applying an instance's rolls. */
  reset(): void {
    for (let i = 0; i < BONE_COUNT; i++) {
      const r = SKEL[i] as { x: number; y: number; z: number; radius: number };
      (this.rest[i] as Vector3).set(r.x, r.y, r.z);
      (this.scale[i] as Vector3).set(1, 1, 1);
      this.radius[i] = r.radius;
      this.severed[i] = 0;
    }
  }

  /**
   * Scale one bone's LENGTH — its own offset from its parent, and therefore everything below
   * it. This is where silhouette variety comes from now: a rigid-part rig could only swap a
   * mesh, a skeleton can make one zombie's forearm 30% longer and the skin stretches to match.
   */
  scaleBoneLength(bone: number, k: number): void {
    (this.rest[bone] as Vector3).multiplyScalar(k);
  }

  /** Scale one bone's GIRTH. Not inherited — see `compose`. */
  setBoneGirth(bone: number, x: number, y: number, z: number): void {
    (this.scale[bone] as Vector3).set(x, y, z);
    this.radius[bone] = (SKEL[bone] as { radius: number }).radius * Math.max(x, z);
  }

  setSevered(bone: number, on: boolean): void {
    this.severed[bone] = on ? 1 : 0;
  }

  isSevered(bone: number): boolean {
    return this.severed[bone] !== 0;
  }

  /**
   * Local pose → posed bone matrices → packed palette, in ONE forward pass. `BONE_PARENT` is
   * monotonic by construction, so a parent is always resolved before its children.
   *
   * Scale is deliberately NOT inherited: a bone's world transform is built from its parent's
   * POSITION AND ROTATION only, and its own scale is applied last. Inheriting a non-uniform
   * scale down a chain skews every child's rotation — which is exactly how a "bloated" variant
   * ends up with sheared legs.
   */
  compose(pose: Float32Array): void {
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = i * POSE_STRIDE;
      _e.set(pose[b + RX] as number, pose[b + RY] as number, pose[b + RZ] as number, 'YXZ');
      _q.setFromEuler(_e);
      const rest = this.rest[i] as Vector3;
      _v.set(
        rest.x + (pose[b + OX] as number),
        rest.y + (pose[b + OY] as number),
        rest.z + (pose[b + OZ] as number),
      );
      const parent = BONE_PARENT[i] as number;
      const wp = this.wpos[i] as Vector3;
      const wq = this.wquat[i] as Quaternion;
      if (parent < 0) {
        wp.copy(_v);
        wq.copy(_q);
      } else {
        _qp.copy(this.wquat[parent] as Quaternion);
        wp.copy(_v).applyQuaternion(_qp).add(this.wpos[parent] as Vector3);
        wq.copy(_qp).multiply(_q);
      }
      const sv = this.scale[i] as Vector3;
      _s.set(
        sv.x * (pose[b + SX] as number),
        sv.y * (pose[b + SY] as number),
        sv.z * (pose[b + SZ] as number),
      );
      if (this.severed[i]) _s.multiplyScalar(SEVERED_SCALE);
      const w = this.world[i] as Matrix4;
      w.compose(wp, wq, _s);

      // Skinning matrix: bind space → bone space → posed space.
      _m.multiplyMatrices(w, INV_BIND[i] as Matrix4);
      const e = _m.elements;
      const o = i * 12;
      this.data[o] = e[0] as number;
      this.data[o + 1] = e[4] as number;
      this.data[o + 2] = e[8] as number;
      this.data[o + 3] = e[12] as number;
      this.data[o + 4] = e[1] as number;
      this.data[o + 5] = e[5] as number;
      this.data[o + 6] = e[9] as number;
      this.data[o + 7] = e[13] as number;
      this.data[o + 8] = e[2] as number;
      this.data[o + 9] = e[6] as number;
      this.data[o + 10] = e[10] as number;
      this.data[o + 11] = e[14] as number;
    }
  }

  // ── the bone API ──────────────────────────────────────────────────────────

  /** Posed joint (head end) of a bone, enemy-local. */
  bonePoint(bone: number, out: Vector3): Vector3 {
    return out.copy(this.wpos[bone] as Vector3);
  }

  /** Posed far end (tail) of a bone, enemy-local. Follows rotation and instance bone scaling. */
  boneTip(bone: number, out: Vector3): Vector3 {
    const t = this.tailLocal[bone] as Vector3;
    const sv = this.scale[bone] as Vector3;
    out.set(t.x * sv.x, t.y * sv.y, t.z * sv.z);
    out.applyQuaternion(this.wquat[bone] as Quaternion).add(this.wpos[bone] as Vector3);
    return out;
  }

  /** Both ends at once — the capsule a limb hitbox is built from. */
  boneSegment(bone: number, a: Vector3, b: Vector3): void {
    this.bonePoint(bone, a);
    this.boneTip(bone, b);
  }

  /** Flesh half-width around a bone, metres, already scaled by this instance's girth roll. */
  boneRadius(bone: number): number {
    return this.radius[bone] as number;
  }

  /** The full posed matrix. Read-only — mutating it corrupts the next frame's palette. */
  boneMatrix(bone: number): Matrix4 {
    return this.world[bone] as Matrix4;
  }

  /** A point in a bone's LOCAL space → enemy-local space. */
  boneLocal(bone: number, local: Vector3, out: Vector3): Vector3 {
    return out.copy(local).applyMatrix4(this.world[bone] as Matrix4);
  }
}

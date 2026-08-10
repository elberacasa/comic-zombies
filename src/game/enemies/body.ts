/**
 * THE SHAMBLER'S BODY — procedural geometry, the bone-less rig, and the drawn animation.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE ZOMBIE = TWO DRAW CALLS. Read this before changing anything structural.
 *
 *  The brief is a *hierarchical mesh group* — pelvis → torso → head + four limbs (M2 §2). The
 *  literal reading of that is fourteen `Mesh`es plus fourteen silhouette hulls per zombie:
 *  28 draw calls each, 700 for a horde of twenty-five, against a whole-frame budget of 350 with
 *  an arena that already spends ~145. That reading is unshippable.
 *
 *  So the hierarchy is real but it is *not* the scene graph. Every part is baked into ONE merged
 *  buffer carrying a per-vertex `aPart` index, and the fourteen part transforms are uploaded as
 *  a `mat4[14]` uniform which the vertex shader applies before the model matrix. That is rigid
 *  skinning with one bone per vertex, done by hand, because `InkMaterial` is a raw
 *  `ShaderMaterial` with no skinning chunks and it is not ours to change.
 *
 *      1 body mesh + 1 inverted-hull mesh   =  2 draw calls per zombie
 *      ~0.9 k triangles + ~1.1 k hull       =  ~2.0 k triangles per zombie
 *
 *  And because the geometry is SHARED by every instance — variants and per-instance proportions
 *  live entirely in the part matrices — the whole horde costs two buffers of VRAM and boot
 *  builds them exactly once.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE SHADER PATCH. `makeEnemyMaterial()` (world/lighting.ts) is the mandated recipe and we do
 * not fork it; we take the material it returns and insert five lines at the top of `main()`
 * that shadow `position` and `normal` with their posed values. Shadowing a global with a local
 * is legal GLSL, and it means the ~90 lines of ink shading below never have to know the rig
 * exists — so a future edit to `InkMaterial` cannot silently break the zombies. The same five
 * lines go into the hull shader from `buildOutlineHull()`.
 *
 * ART DIRECTION, non-negotiable (ART §9 — the human asked for this by name):
 *   • flesh is `ACID`, on BOTH cel bands, straight out of `makeEnemyMaterial()`
 *   • the rim never turns off, and the reserved-channel probe in `passes/ink.ts` finds it
 *   • the silhouette is `READABILITY.ENEMY_OUTLINE_PX` = 8 px, the heaviest line in the game,
 *     against a 6 px cap on the heaviest prop in the arena
 *   • the boil is `ENEMY_BOIL` (0.08); the city inks at `ENV_BOIL` (0.03)
 */

import {
  BufferGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  Quaternion,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import { PALETTE, hexMix } from '@/art/palette';
import { bevelBox, jitterVertices, makeHullGeometry, place } from '@/art/shapes';
import {
  LAYER, buildOutlineHull, setInkColor, setInkEmissive, type InkMaterial,
} from '@/render/materials';
import { makeEnemyMaterial } from '@/world/lighting';
import { Rng } from '@/core/rng';
import { TAU, clamp01, easeOutBack, easeOutExpo, holdThenEase, lerp, smoothstep } from '@/core/mathx';
import {
  ANIM, BODY, HITBOX, LIMB, LIMB_ROOT, PART, PART_COUNT, PART_PARENT,
  type BodyVariant, type EnemyStateName,
} from '@/game/enemies/defs';

// ═════════════════════════════════════════════════════════════════════════════
// 1. GEOMETRY — built once at boot, shared by every zombie that will ever exist.
// ═════════════════════════════════════════════════════════════════════════════

/** A chunky bevelled mass. The bevel is the ink line (shapes.ts §1), so never skip it. */
function mass(size: readonly [number, number, number], seed: number): BufferGeometry {
  return bevelBox(size[0], size[1], size[2], Math.min(size[0], size[1], size[2]) * BODY.bevel, seed);
}

/**
 * Painted AO (ART §2.5 — "ambient occlusion is painted, not computed"). Every part darkens
 * toward the joint it hangs from, written into the `color` attribute, which `InkMaterial` reads
 * as `vAo` and multiplies into the key term. It deepens the cel break without touching the hue,
 * which matters a great deal here: the reserved `ACID` channel has to survive intact.
 *
 * `jointAtTop` is true for limbs (they hang from y = 0) and false for the torso stack (each
 * segment is joined at its base).
 */
function paintAo(geo: BufferGeometry, topY: number, bottomY: number, jointAtTop: boolean): BufferGeometry {
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const span = Math.max(1e-3, topY - bottomY);
  for (let i = 0; i < pos.count; i++) {
    // `t` = 0 at the joint, 1 at the free end.
    const up = (pos.getY(i) - bottomY) / span;
    const t = jointAtTop ? 1 - up : up;
    const ao = BODY.aoMin + (1 - BODY.aoMin) * smoothstep(clamp01(t * 1.25));
    col[i * 3] = ao;
    col[i * 3 + 1] = ao;
    col[i * 3 + 2] = ao;
  }
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  return geo;
}

/** Concatenate two part sub-meshes (both non-indexed position/normal/uv). Disposes the inputs. */
function joinGeo(a: BufferGeometry, b: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    const pa = a.getAttribute(name);
    const pb = b.getAttribute(name);
    if (!pa || !pb) continue;
    const size = pa.itemSize;
    const arr = new Float32Array(pa.count * size + pb.count * size);
    arr.set(pa.array as Float32Array, 0);
    arr.set(pb.array as Float32Array, pa.count * size);
    out.setAttribute(name, new Float32BufferAttribute(arr, size));
  }
  a.dispose();
  b.dispose();
  return out;
}

/**
 * The fourteen parts, each authored with **its joint at the origin** so a rotation is a rotation
 * about that joint and nothing else. Limbs hang down -Y; torso segments stack up +Y.
 *
 * Proportions are the caricature in `defs.BODY`: heavy hiked shoulders, a small dropped head, a
 * slack jaw, long hanging arms with over-sized hands, short bent legs. An inker exaggerates the
 * read and throws the anatomy away.
 */
function buildParts(): BufferGeometry[] {
  const parts: BufferGeometry[] = new Array(PART_COUNT) as BufferGeometry[];

  // ── pelvis ────────────────────────────────────────────────────────────────
  parts[PART.PELVIS] = paintAo(place(mass(BODY.pelvis, 11), { y: 0.02 }), 0.16, -0.12, true);

  // ── belly: cocked a few degrees, because nothing on this body is square ────
  const belly = mass(BODY.belly, 13);
  place(belly, { y: BODY.belly[1] * 0.42, rz: 0.05 });
  parts[PART.BELLY] = paintAo(belly, 0.30, -0.02, false);

  // ── chest: the mass, plus two hiked shoulder lumps that carry the silhouette ──
  let chest = mass(BODY.chest, 17);
  place(chest, { y: BODY.chest[1] * 0.44, rz: -0.04 });
  for (const sx of [1, -1]) {
    const lump = mass([0.215, 0.18, 0.235], 19 + sx);
    place(lump, {
      x: sx * BODY.chest[0] * 0.42,
      y: BODY.chest[1] * 0.78 + (sx > 0 ? 0.02 : 0.05),
      rz: sx * 0.22,
    });
    chest = joinGeo(chest, lump);
  }
  parts[PART.CHEST] = paintAo(chest, 0.42, -0.02, false);

  // ── head: skull + a heavy brow ridge. The brow is what makes it read as a FACE at 30 m. ──
  let head = mass(BODY.head, 23);
  place(head, { y: BODY.head[1] * 0.42, rx: 0.06 });
  const brow = mass(BODY.brow, 29);
  place(brow, { y: BODY.head[1] * 0.52, z: -BODY.head[2] * 0.44 });
  head = joinGeo(head, brow);
  parts[PART.HEAD] = paintAo(head, 0.30, -0.06, false);

  // ── jaw: hangs open. A slack jaw is most of the silhouette's "wrongness". ──
  const jaw = mass(BODY.jaw, 31);
  place(jaw, { y: -BODY.jaw[1] * 0.4, z: -0.02 });
  parts[PART.JAW] = paintAo(jaw, 0.04, -0.14, true);

  // ── arms ──────────────────────────────────────────────────────────────────
  for (const [idx, seed] of [[PART.ARM_UR, 37], [PART.ARM_UL, 41]] as const) {
    const g = mass(BODY.upperArm, seed);
    place(g, { y: -BODY.upperArm[1] * 0.5, rz: idx === PART.ARM_UR ? 0.04 : -0.07 });
    parts[idx] = paintAo(g, 0.02, -BODY.upperArm[1], true);
  }
  for (const [idx, seed] of [[PART.ARM_LR, 43], [PART.ARM_LL, 47]] as const) {
    let g = mass(BODY.lowerArm, seed);
    place(g, { y: -BODY.lowerArm[1] * 0.5 });
    // A splayed, over-sized hand — the part the player actually sees coming at them.
    const hand = mass(BODY.hand, seed + 1);
    place(hand, {
      y: -BODY.lowerArm[1] - BODY.hand[1] * 0.35,
      rz: idx === PART.ARM_LR ? 0.3 : -0.22,
      rx: 0.2,
    });
    g = joinGeo(g, hand);
    parts[idx] = paintAo(g, 0.02, -BODY.lowerArm[1] - BODY.hand[1], true);
  }

  // ── legs ──────────────────────────────────────────────────────────────────
  for (const [idx, seed] of [[PART.LEG_UR, 53], [PART.LEG_UL, 59]] as const) {
    const g = mass(BODY.thigh, seed);
    place(g, { y: -BODY.thigh[1] * 0.5 });
    parts[idx] = paintAo(g, 0.02, -BODY.thigh[1], true);
  }
  for (const [idx, seed] of [[PART.LEG_LR, 61], [PART.LEG_LL, 67]] as const) {
    let g = mass(BODY.shin, seed);
    place(g, { y: -BODY.shin[1] * 0.5 });
    const foot = mass(BODY.foot, seed + 1);
    place(foot, { y: -BODY.shin[1] - BODY.foot[1] * 0.3, z: -BODY.foot[2] * 0.22 });
    g = joinGeo(g, foot);
    parts[idx] = paintAo(g, 0.02, -BODY.shin[1] - BODY.foot[1], true);
  }

  // ── the asymmetry part: a torn flap of coat off one shoulder blade ─────────
  // 0.13 deep, not 0.045: a coat flap thinner than the ink band renders as a black blob.
  let rag = mass([0.23, 0.42, 0.135], 71);
  place(rag, { y: -0.18, rz: 0.16, rx: -0.1 });
  const rag2 = mass([0.16, 0.26, 0.125], 73);
  place(rag2, { x: -0.09, y: -0.36, rz: 0.42 });
  rag = joinGeo(rag, rag2);
  parts[PART.RAG] = paintAo(rag, 0.02, -0.62, true);

  for (let i = 0; i < PART_COUNT; i++) jitterVertices(parts[i], BODY.jitter, 100 + i * 13);
  return parts;
}

/**
 * Concatenate the parts into one buffer, tagging every vertex with the index of the part it
 * belongs to. `aPart` is the entire rig, as far as the GPU is concerned.
 */
function concatParts(parts: readonly BufferGeometry[], withColor: boolean): BufferGeometry {
  let total = 0;
  for (const p of parts) total += p.getAttribute('position').count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const colors = withColor ? new Float32Array(total * 3) : null;
  const aPart = new Float32Array(total);

  let v = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const pos = p.getAttribute('position');
    const nrm = p.getAttribute('normal');
    const tex = p.getAttribute('uv');
    const col = p.getAttribute('color');
    for (let k = 0; k < pos.count; k++, v++) {
      position[v * 3] = pos.getX(k);
      position[v * 3 + 1] = pos.getY(k);
      position[v * 3 + 2] = pos.getZ(k);
      if (nrm) {
        normal[v * 3] = nrm.getX(k);
        normal[v * 3 + 1] = nrm.getY(k);
        normal[v * 3 + 2] = nrm.getZ(k);
      }
      if (tex) {
        uv[v * 2] = tex.getX(k);
        uv[v * 2 + 1] = tex.getY(k);
      }
      if (colors) {
        const a = col ? col.getX(k) : 1;
        colors[v * 3] = a;
        colors[v * 3 + 1] = a;
        colors[v * 3 + 2] = a;
      }
      aPart[v] = i;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  if (colors) geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.setAttribute('aPart', new Float32BufferAttribute(aPart, 1));
  // The rest pose's bounds are not the ANIMATED bounds — a wind-up throws the arms well outside
  // them, and a body culled mid-swing pops. Frustum culling reads this, so it is authored
  // generously rather than computed.
  geo.boundingSphere = new Sphere(new Vector3(0, BODY.height * 0.5, 0), BODY.height * 0.95);
  return geo;
}

export interface EnemyGeometrySet {
  body: BufferGeometry;
  hull: BufferGeometry;
  triangles: number;
  hullTriangles: number;
  dispose(): void;
}

/**
 * Build the shared geometry. Called exactly once, from `EnemySystem.init`.
 *
 * The hull is welded PER PART before concatenation: `makeHullGeometry` averages normals across
 * coincident vertices so the inverted hull inflates as one continuous shell instead of blowing
 * apart into slivers (art/shapes note #1) — but welding ACROSS two parts would give one vertex
 * two conflicting `aPart` values and tear the rig apart the first time an arm moved. Weld inside
 * a part; concatenate between them.
 */
export function buildEnemyGeometry(): EnemyGeometrySet {
  const parts = buildParts();
  const body = concatParts(parts, true);

  const hullParts: BufferGeometry[] = new Array(PART_COUNT) as BufferGeometry[];
  for (let i = 0; i < PART_COUNT; i++) {
    const welded = makeHullGeometry(parts[i]);
    const flat = welded.index ? welded.toNonIndexed() : welded;
    if (flat !== welded) welded.dispose();
    hullParts[i] = flat;
  }
  const hull = concatParts(hullParts, false);
  for (const g of hullParts) g.dispose();
  for (const g of parts) g.dispose();

  return {
    body,
    hull,
    triangles: body.getAttribute('position').count / 3,
    hullTriangles: hull.getAttribute('position').count / 3,
    dispose(): void {
      body.dispose();
      hull.dispose();
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE SHADER PATCH
// ═════════════════════════════════════════════════════════════════════════════

const SKIN_DECL = /* glsl */ `
attribute float aPart;
uniform mat4 uPart[${PART_COUNT}];
`;

/**
 * Inserted at the top of `main()`. `position` and `normal` are attributes, i.e. globals, and a
 * local declaration legally shadows a global in GLSL — so every line after this one sees the
 * POSED vertex and the rest of the shader is untouched. That is why this patch is a five-line
 * insertion at one well-known marker rather than surgery on expressions we do not own.
 */
const SKIN_MAIN = /* glsl */ `
  vec3 czRawPosition = position;
  vec3 czRawNormal = normal;
  mat4 czPartMatrix = uPart[int(aPart + 0.5)];
  vec3 position = (czPartMatrix * vec4(czRawPosition, 1.0)).xyz;
  vec3 normal = normalize(mat3(czPartMatrix) * czRawNormal);
`;

const MAIN_MARKER = 'void main() {';

/**
 * Patch a vertex shader to apply the rig. Loud on failure: a silently un-rigged zombie is a
 * T-posing statue sliding across the plaza, which is far worse than a console error.
 */
function patchPartSkinning(src: string, label: string): string {
  const at = src.indexOf(MAIN_MARKER);
  if (at < 0) {
    console.error(
      `[enemies/body] could not patch the rig into the ${label} vertex shader — ` +
      `"${MAIN_MARKER}" not found. Zombies will not animate. Someone changed ` +
      `render/materials/index.ts; re-anchor this patch.`,
    );
    return src;
  }
  return `${SKIN_DECL}${src.slice(0, at)}${MAIN_MARKER}${SKIN_MAIN}${src.slice(at + MAIN_MARKER.length)}`;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE THIRD MATERIAL — the depth/normal PREPASS, and the bug it exists to kill.
 *
 * `render/renderer.ts` fills a view-normal + depth buffer before the beauty pass, and the ink
 * pass, the screen-space rim and the boil gate all read it. It used to do that with a single
 * stock `MeshNormalMaterial` forced onto the whole scene through `scene.overrideMaterial` —
 * which has neither our `aPart` attribute nor our `uPart` uniform. So every zombie wrote its
 * UNPOSED geometry (all fourteen parts collapsed onto the body origin) into the prepass while
 * the beauty pass drew it posed. Measured result, at 2–15 m: the ink pass read the CITY's depth
 * across the zombie's silhouette and inked arcade railings, kerbs and bins straight through the
 * torso; the body got no interior line of its own; the always-on ART §9 enemy rim, gated on that
 * same depth via `nearerMask`, never drew; and `boilNear` sampled a background distance. The
 * enemy — the one thing §9 says must be the most legible object in the frame — was the only
 * translucent thing in it.
 *
 * The renderer now swaps materials per object and honours `mesh.userData.czPrepassMaterial`, so
 * the fix is simply to publish a rigged normal material here. It is deliberately a hand-written
 * ShaderMaterial rather than a patched `MeshNormalMaterial`: it is nine lines, it cannot be
 * broken by a three.js include being reshuffled, and it goes through the SAME
 * `patchPartSkinning()` as the body and the hull — so the three shaders cannot pose differently.
 * Output matches `MeshNormalMaterial` exactly: `normalize(view normal) * 0.5 + 0.5`.
 *
 * The hull needs no equivalent: it lives on `LAYER.OUTLINE`, which the prepass mask excludes.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const PREPASS_VERT = /* glsl */ `
varying vec3 czViewNormal;
void main() {
  czViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PREPASS_FRAG = /* glsl */ `
varying vec3 czViewNormal;
void main() {
  gl_FragColor = vec4(normalize(czViewNormal) * 0.5 + 0.5, 1.0);
}
`;

export interface EnemyMaterialPair {
  body: InkMaterial;
  hull: ShaderMaterial;
  /** Rigged stand-in for the renderer's normal/depth prepass. See the block comment above. */
  prepass: ShaderMaterial;
  outlinePx: number;
}

/**
 * One enemy's materials, sharing one `mat4[14]` uniform object so the body and its silhouette
 * can never pose differently.
 *
 * `makeEnemyMaterial()` is called per instance rather than cloned: `ShaderMaterial.clone()` runs
 * `UniformsUtils.clone()`, which DEEP-COPIES uniform values — that would fork every zombie off
 * the shared `INK_GLOBALS` objects and quietly freeze its lighting, resolution and boil at
 * whatever they happened to be at boot. The factory spreads `...INK_GLOBALS` by reference, so
 * calling it again is the only correct way to get a second instance.
 *
 * All instances compile to ONE program (identical source, identical defines), so N materials is
 * N uniform uploads, not N shader compiles.
 */
export function makeEnemyMaterials(
  matrices: readonly Matrix4[], hue: number, presence: number,
): EnemyMaterialPair {
  const recipe = makeEnemyMaterial({ hue, presence, name: 'Ink_shambler' });
  const body = recipe.material;
  body.vertexShader = patchPartSkinning(body.vertexShader, 'ink');
  body.uniforms.uPart = { value: matrices };
  // Painted AO lives in the geometry's `color` attribute; switch the shader over to reading it.
  body.vertexColors = true;
  body.uniforms.uVertexAo!.value = BODY.aoStrength;

  // THE HEAVIEST INK WEIGHT IN THE GAME (ART §9): 8 px, against a 6 px cap on the heaviest prop
  // in the arena. `buildOutlineHull` builds its own material on every call — verified against
  // `render/materials/index.ts` — so an enemy's line weight cannot leak into the city's the way
  // the M1.5 report described. A scratch geometry is passed and immediately freed: we want the
  // material and its uniform block, not the mesh.
  const scratch = new BufferGeometry();
  const hullMesh = buildOutlineHull(scratch, {
    thickness: recipe.outlinePx,
    minThickness: recipe.outlinePx * 0.55,
    boil: recipe.boil,
    ink: PALETTE.INK,
    weld: false,
  });
  const hull = hullMesh.material as ShaderMaterial;
  hull.vertexShader = patchPartSkinning(hull.vertexShader, 'outline');
  hull.uniforms.uPart = { value: matrices };
  scratch.dispose();

  // The prepass material shares the very same `matrices` array by reference, so the buffer the
  // ink pass reads can never disagree with the body it is drawn over — not even by one frame.
  const prepass = new ShaderMaterial({
    name: 'Prepass_shambler',
    vertexShader: patchPartSkinning(PREPASS_VERT, 'prepass'),
    fragmentShader: PREPASS_FRAG,
    uniforms: { uPart: { value: matrices } },
  });

  return { body, hull, prepass, outlinePx: recipe.outlinePx };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE RIG
// ═════════════════════════════════════════════════════════════════════════════

/** Everything the pose evaluator needs. The service fills a module-level scratch instance. */
export interface PoseArgs {
  /** Gait phase, 0..1, already snapped onto the 12 Hz pose clock. */
  gait: number;
  /** Movement speed as a fraction of this enemy's own chase speed. */
  speed01: number;
  state: EnemyStateName;
  /** 0..1 through the melee wind-up. */
  windup01: number;
  /** 0..1 through the melee strike. */
  strike01: number;
  /** 0..1 through a ledge climb. Only read while `state === 'climb'`. */
  climb01: number;
  /** Metres to the player — drives the reach pose. */
  targetDist: number;
  /** Additive flinch lean: `leanX` rolls (side hits), `leanZ` pitches (front/back hits). */
  leanX: number;
  leanZ: number;
  /** High-frequency shudder amplitude. ART §9 reserves this channel to enemies. */
  shudder: number;
  spawn01: number;
  death01: number;
}

// ── module scratch — nothing below this line allocates ──────────────────────
const _q = new Quaternion();
const _qp = new Quaternion();
const _v = new Vector3();
const _s = new Vector3();
const _e = new Euler(0, 0, 0, 'YXZ');
const _wPos: Vector3[] = [];
const _wQuat: Quaternion[] = [];
for (let i = 0; i < PART_COUNT; i++) {
  _wPos.push(new Vector3());
  _wQuat.push(new Quaternion());
}
/** Per-part local pose, refilled per enemy: [rx, ry, rz, ox, oy, oz, sx, sy, sz]. */
const _pose = new Float32Array(PART_COUNT * 9);

const RX = 0, RY = 1, RZ = 2, OX = 3, OY = 4, OZ = 5, SX = 6, SY = 7, SZ = 8;

function clearPose(): void {
  for (let i = 0; i < PART_COUNT; i++) {
    const b = i * 9;
    _pose[b + RX] = 0; _pose[b + RY] = 0; _pose[b + RZ] = 0;
    _pose[b + OX] = 0; _pose[b + OY] = 0; _pose[b + OZ] = 0;
    _pose[b + SX] = 1; _pose[b + SY] = 1; _pose[b + SZ] = 1;
  }
}

/**
 * A severed part is scaled to a speck rather than to zero: a zero matrix makes the shader's
 * `normalize(mat3(m) * normal)` produce NaN, and NaN in a hull's inflation direction is how you
 * get a triangle stretching to the horizon. At 1e-4 the triangles are sub-pixel and degenerate.
 */
const SEVERED_SCALE = 1e-4;

/**
 * How far toward `HOT` a single instance's flesh may be shifted. Both endpoints are ART §9
 * reserved enemy hues, so this cannot leak into the environment's channel — but it is still
 * capped hard, and the cap is MEASURED, not guessed.
 *
 * The §9 squint metric is green dominance, `(G − max(R,B))/255`, box-averaged to a 48×26 grid.
 * Fourteen shamblers at 3 m, identical camera, only this constant changed:
 *
 *     0.00 → 0.195     0.04 → 0.190     0.06 → 0.141     0.08 → 0.155     0.12 → 0.152
 *
 * i.e. everything up to ~0.05 is free and everything past it costs about a quarter of the
 * enemy's readability. "Easier to spot enemies" is standing playtester feedback and therefore a
 * regression test; internal colour depth is a nice-to-have. So the horde's variety is bought in
 * the SILHOUETTE (see `reseed`), and the hue only gets what it can have for nothing.
 */
const HUE_SPREAD = 0.05;

/**
 * One zombie's renderable body: two meshes, fourteen matrices, and the per-instance proportions
 * that stop it being a twin of the one next to it.
 */
export class EnemyBody {
  readonly mesh: Mesh;
  readonly hull: Mesh;
  readonly matrices: Matrix4[] = [];
  readonly material: InkMaterial;
  readonly hullMaterial: ShaderMaterial;
  /** Published on the mesh as `userData.czPrepassMaterial`; the renderer swaps it in. */
  readonly prepassMaterial: ShaderMaterial;
  /** Full-weight ink for this instance — `READABILITY.ENEMY_OUTLINE_PX` × presence. */
  readonly outlinePx: number;

  /** Rest offset of each part from its parent, after variant + per-instance variation. */
  private readonly rest: Vector3[] = [];
  /** Per-part scale — this is where a "gaunt" and a "bloated" actually differ. */
  private readonly scale: Vector3[] = [];
  private readonly severed = [false, false, false, false];

  private variant: BodyVariant;
  /** Which leg drags. The most-noticed piece of per-instance character. */
  private dragSide = 0;
  private headTilt = 0;
  private shoulderHike = 0;
  private heightScale = 1;
  /**
   * ── THE SILHOUETTE VARIATION SET (M2 §2: "no two are twins") ──────────────────────────
   * These five are deliberately in the OUTLINE, not in the proportions: a bold line erases
   * interior detail, so scale jitter on a limb's width is invisible at fighting range while a
   * dead arm, a lolling head or an off-axis torso are readable at 25 m in one glance.
   */
  private armDragSide = 0;
  /** Length multiplier on the dragging arm — 1.12–1.30, i.e. it visibly hangs lower. */
  private armDragLen = 1;
  /** Extra forward droop on that arm, radians. */
  private armDragDroop = 0;
  /** Off-axis torso lean (roll) and twist (yaw), radians. Nobody stands square. */
  private torsoLean = 0;
  private torsoTwist = 0;
  /** The kind's authored hue, before this instance's warm shift. */
  private baseHue: number;
  /** Gait phase offset, so a horde never marches in step. */
  private gaitPhase = 0;
  /** Offset on the 12 Hz pose clock, so the horde does not all POP on the same frame. */
  private poseOffset = 0;

  constructor(geo: EnemyGeometrySet, variant: BodyVariant, hue: number, presence: number) {
    this.variant = variant;
    this.baseHue = hue;
    for (let i = 0; i < PART_COUNT; i++) {
      this.matrices.push(new Matrix4());
      this.rest.push(new Vector3());
      this.scale.push(new Vector3(1, 1, 1));
    }
    const mats = makeEnemyMaterials(this.matrices, hue, presence);
    this.material = mats.body;
    this.hullMaterial = mats.hull;
    this.prepassMaterial = mats.prepass;
    this.outlinePx = mats.outlinePx;

    this.mesh = new Mesh(geo.body, this.material);
    this.mesh.name = 'shambler';
    // The renderer looks for exactly this key (userData, not an import — ARCHITECTURE §1) and
    // draws the depth/normal prepass with it. Without it the zombie is inked THROUGH.
    (this.mesh.userData as { czPrepassMaterial?: ShaderMaterial }).czPrepassMaterial =
      this.prepassMaterial;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;

    this.hull = new Mesh(geo.hull, this.hullMaterial);
    this.hull.name = 'outline';
    // `buildOutlineHull` disables culling because a static prop's hull can extend past its
    // source geometry's bounds. Ours cannot: the hull is a child at identity of the body mesh
    // and shares its (deliberately generous) bounding sphere, so it culls in lockstep with the
    // body and can never be dropped while the body draws. Measured: 25 alive with 18 on screen
    // costs 43 draw calls instead of 50, because the seven behind you cost nothing at all.
    this.hull.frustumCulled = true;
    this.hull.renderOrder = -1;
    this.hull.castShadow = false;
    this.hull.receiveShadow = false;
    // The prepass must never see a hull, or the ink pass edges the silhouette twice.
    this.hull.layers.set(LAYER.OUTLINE);
    this.mesh.add(this.hull);

    this.reseed(new Rng(1), variant);
  }

  get poseClockOffset(): number { return this.poseOffset; }
  get gaitOffset(): number { return this.gaitPhase; }
  /** Standing height of this instance, metres — the hitbox capsule and broad sphere use it. */
  get height(): number { return BODY.height * this.heightScale; }

  /**
   * Roll a fresh body. Called on every spawn, not once per pool slot: reusing a slot must never
   * hand the player the same zombie twice in a row.
   */
  reseed(rng: Rng, variant: BodyVariant): void {
    this.variant = variant;
    const g = variant.scale * rng.range(0.94, 1.07);
    const torso = variant.torso * rng.range(0.95, 1.06);
    const limb = variant.limb * rng.range(0.94, 1.07);
    const head = variant.head * rng.range(0.93, 1.08);
    const reach = variant.reach * rng.range(0.95, 1.06);
    this.heightScale = g;
    // ── the silhouette roll ───────────────────────────────────────────────────────────────
    // Every one of these is authored as SIGN × MAGNITUDE rather than as a symmetric range,
    // because a symmetric range's most likely value is ZERO — which is exactly how twenty-five
    // "randomised" bodies came out as a clone army. A zombie is never straight; it is bent one
    // way or the other, and the roll only picks WHICH way and HOW far.
    this.shoulderHike = rng.range(0.06, 0.17) * rng.sign();
    // 15–30° of real head loll, never level.
    this.headTilt = rng.range(0.26, 0.52) * rng.sign();
    this.torsoLean = rng.range(0.06, 0.19) * rng.sign();
    this.torsoTwist = rng.range(0.08, 0.24) * rng.sign();
    this.dragSide = rng.next() < 0.5 ? 0 : 1;
    // The dead arm is deliberately NOT correlated with the dragging leg — a body broken on one
    // diagonal reads far more wrong than one broken down one side.
    this.armDragSide = rng.next() < 0.5 ? 0 : 1;
    this.armDragLen = rng.range(1.12, 1.30);
    this.armDragDroop = rng.range(0.22, 0.55);
    this.gaitPhase = rng.next();
    this.poseOffset = rng.next() * ANIM.poseOffsetSpread;

    /**
     * INTERNAL COLOUR DEPTH, INSIDE THE RESERVED CHANNEL (ART §9). The horde was one flat ACID
     * value. Each instance is now shifted a little toward `HOT` — the OTHER reserved enemy hue —
     * so a crowd has warm bodies and cold bodies in it. Capped hard at `HUE_SPREAD`, which is a
     * measured number: see the note on the constant.
     */
    this.setHue(hexMix(this.baseHue, PALETTE.HOT, rng.range(0, HUE_SPREAD)));

    const B = BODY;
    const set = (i: number, x: number, y: number, z: number): void => {
      this.rest[i].set(x * g, y * g, z * g);
    };
    const sc = (i: number, x: number, y: number, z: number): void => {
      this.scale[i].set(x, y, z);
    };

    set(PART.PELVIS, 0, B.hipY, 0);
    set(PART.BELLY, 0, B.bellyY * torso, 0);
    set(PART.CHEST, 0, B.chestY * torso, 0);
    set(PART.HEAD, 0, B.headY * torso, 0.015);
    set(PART.JAW, 0, B.jawY * head, B.jawZ * head);
    // The dead arm is LONGER as well as slacker — the two together are what make it read as a
    // limb hanging wrong rather than as an animation glitch.
    const reachR = reach * (this.armDragSide === 0 ? this.armDragLen : 1);
    const reachL = reach * (this.armDragSide === 1 ? this.armDragLen : 1);
    set(PART.ARM_UR, B.shoulderR * torso, B.shoulderY * torso + this.shoulderHike, 0);
    set(PART.ARM_UL, B.shoulderL * torso, B.shoulderYL * torso - this.shoulderHike, 0);
    set(PART.ARM_LR, 0, B.elbowY * limb * reachR, 0);
    set(PART.ARM_LL, 0, B.elbowY * limb * reachL, 0);
    set(PART.LEG_UR, B.hipX * torso, B.hipOffY, 0);
    set(PART.LEG_UL, -B.hipX * torso, B.hipOffY, 0);
    set(PART.LEG_LR, 0, B.kneeY * limb, 0);
    set(PART.LEG_LL, 0, B.kneeY * limb, 0);
    set(PART.RAG, -0.17 * torso, -0.02, -0.15 * torso);

    sc(PART.PELVIS, torso, g, torso);
    sc(PART.BELLY, torso * rng.range(0.97, 1.10), torso, torso);
    sc(PART.CHEST, torso, torso, torso * rng.range(0.94, 1.05));
    sc(PART.HEAD, head, head, head);
    sc(PART.JAW, head, head, head);
    sc(PART.ARM_UR, limb, limb * reachR, limb);
    sc(PART.ARM_UL, limb * rng.range(0.90, 1.12), limb * reachL, limb);
    sc(PART.ARM_LR, limb, limb * reachR, limb);
    sc(PART.ARM_LL, limb, limb * reachL, limb);
    sc(PART.LEG_UR, limb, limb, limb);
    sc(PART.LEG_UL, limb, limb, limb);
    sc(PART.LEG_LR, limb, limb, limb);
    sc(PART.LEG_LL, limb, limb, limb);
    sc(PART.RAG, torso, torso * rng.range(0.8, 1.3), torso);

    this.severed[0] = false;
    this.severed[1] = false;
    this.severed[2] = false;
    this.severed[3] = false;
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  /** Screen-px ink weight for this body. Driven per frame by the service's distance taper. */
  setOutlinePx(px: number): void {
    const u = this.hullMaterial.uniforms;
    if (u.uThickness) u.uThickness.value = px;
    if (u.uMinThickness) u.uMinThickness.value = Math.min(px, px * 0.55);
  }

  /** Recolour in place — a `HOT` special, or a shock/flame affix later. No rebuild, no hitch. */
  setHue(hue: number): void {
    setInkColor(this.material, hue);
    setInkEmissive(this.material, hue, 0.16);
  }

  sever(limb: number): void {
    this.severed[limb] = true;
  }

  isSevered(limb: number): boolean {
    return this.severed[limb];
  }

  // ── the animation ────────────────────────────────────────────────────────

  /**
   * Evaluate every layer, compose the fourteen matrices, and leave them in `this.matrices`
   * (which the two materials already point at — no upload call needed).
   *
   * Layer order is load-bearing: gait → state pose → additive flinch. The flinch is LAST and
   * ADDITIVE so a bullet visibly moves a body that is mid-swing, which is the whole of
   * "a zombie that absorbs a bullet without visibly reacting is a bug".
   */
  pose(a: PoseArgs): void {
    clearPose();
    this.poseGait(a);
    if (a.state === 'attack') this.poseAttack(a);
    if (a.state === 'climb') this.poseClimb(a);
    if (a.state === 'spawn') this.poseSpawn(a);
    if (a.state === 'death') this.poseDeath(a);
    this.poseFlinch(a);
    this.compose();
  }

  /**
   * THE WALK. Everything here is sampled from `a.gait`, which the service has already snapped
   * onto the 12 Hz clock — so each of these curves is a staircase, not a curve, and the body
   * holds a pose for ~5 frames at 60 fps before jumping to the next (ART §8). Smooth
   * interpolation is the enemy; we want the uncanny stop-motion of animated ink.
   */
  private poseGait(a: PoseArgs): void {
    const ph = a.gait;
    const amp = 0.35 + 0.65 * a.speed01;
    const s = Math.sin(ph * TAU);
    const c = Math.cos(ph * TAU);
    const s2 = Math.sin(ph * TAU * 2);

    // ── pelvis: roll, twist, and a hard drop on every foot-plant. This is the weight. ──
    const p = PART.PELVIS * 9;
    _pose[p + RZ] += s * ANIM.hipRoll * amp;
    _pose[p + RY] += s * ANIM.hipTwist * amp;
    _pose[p + OY] += -Math.abs(s) * ANIM.bobDown * amp;

    // ── spine: a permanent hunch, a counter-twist, and squash/stretch on twos ──
    // SIGN: a part ABOVE its joint leans BACK for a positive rx (see the note on ANIM.windupLean),
    // so the hunch — which is forward — is negative all the way up the spine.
    const b = PART.BELLY * 9;
    _pose[b + RX] += -this.variant.stoop * 0.45;
    // Off-axis: this body is bent sideways and turned a few degrees off its own heading, for
    // its whole life. It is a rest-pose property, so it costs nothing per frame and it survives
    // the 12 Hz pose clock intact.
    _pose[b + RZ] += this.torsoLean * 0.45;
    _pose[b + SY] += s2 * ANIM.squash * amp;
    _pose[b + SX] += -s2 * ANIM.squash * 0.5 * amp;
    _pose[b + SZ] += -s2 * ANIM.squash * 0.5 * amp;

    const ch = PART.CHEST * 9;
    _pose[ch + RX] += -(this.variant.stoop * 0.55 + ANIM.hunch * a.speed01);
    _pose[ch + RY] += -s * ANIM.spineTwist * amp + this.torsoTwist;
    _pose[ch + RZ] += this.shoulderHike * 1.4 + this.torsoLean * 0.55;
    // The stretch has to travel: a stretched belly must lift the chest or the torso pulls apart.
    _pose[ch + OY] += s2 * ANIM.squash * 0.16 * amp;

    // ── head: lolls on its own slower beat, and is never quite level ─────────
    const h = PART.HEAD * 9;
    _pose[h + RZ] += this.headTilt + Math.sin(ph * TAU + 1.15) * ANIM.headLoll * amp;
    _pose[h + RX] += -this.variant.stoop * 0.6 + Math.sin(ph * TAU * 2 + 0.6) * ANIM.headNod * amp;
    _pose[h + RY] += -_pose[ch + RY] * 0.6;

    const j = PART.JAW * 9;
    _pose[j + RX] += ANIM.jawOpen * (0.55 + 0.45 * Math.sin(ph * TAU * 0.5 + 2.1));

    // ── legs: one drags, and they are off-beat by `limpAsym`, not a clean half cycle ──
    this.poseLeg(PART.LEG_UR, PART.LEG_LR, ph, amp, this.dragSide === 0);
    this.poseLeg(PART.LEG_UL, PART.LEG_LL, ph + 0.5 + ANIM.limpAsym, amp, this.dragSide === 1);

    // ── arms: lag the legs by 0.37 of a cycle. 0.5 reads as walking; 0.37 reads as wrong. ──
    const reach = 1 - smoothstep(clamp01((a.targetDist - 1.2) / ANIM.armReachRange));
    this.poseArm(
      PART.ARM_UR, PART.ARM_LR, ph + ANIM.armLag, amp, reach, 1, this.armDragSide === 0);
    this.poseArm(
      PART.ARM_UL, PART.ARM_LL, ph + ANIM.armLag + 0.5 + ANIM.limpAsym * 0.5, amp, reach, -1,
      this.armDragSide === 1);

    // ── the rag swings a beat behind everything else ─────────────────────────
    const r = PART.RAG * 9;
    _pose[r + RX] += 0.18 + c * 0.16 * amp;
    _pose[r + RZ] += s * 0.13 * amp;
  }

  private poseLeg(upper: number, lower: number, ph: number, amp: number, drag: boolean): void {
    const swing = Math.sin(ph * TAU);
    const u = upper * 9;
    const l = lower * 9;
    const k = drag ? ANIM.dragLeg : 1;
    _pose[u + RX] += swing * ANIM.thighSwing * amp * k;
    // Knees only bend one way. `max(0, …)` is what stops a shin folding forward through a thigh.
    const bend = Math.max(0, Math.sin((ph + 0.28) * TAU));
    _pose[l + RX] += -(bend * ANIM.kneeBend * amp * k + (drag ? 0.34 : 0.06));
    if (drag) _pose[u + RZ] += 0.16;
  }

  private poseArm(
    upper: number, lower: number, ph: number, amp: number, reach: number, side: number,
    drag: boolean,
  ): void {
    const swing = Math.sin(ph * TAU);
    const u = upper * 9;
    const l = lower * 9;
    const k = drag ? ANIM.dragArm : 1;
    // Hanging and swinging far away; reaching for you the closer you get. The DEAD arm barely
    // swings, hangs further forward and off the body, and keeps a folded elbow — so even at a
    // dead stop the two sides of this zombie do not match.
    _pose[u + RX] += swing * ANIM.armSwing * amp * k + ANIM.armIdleForward + reach * ANIM.armReach;
    _pose[u + RZ] += side * (0.13 + reach * 0.1);
    _pose[l + RX] += -ANIM.armDroop - Math.max(0, swing) * 0.22 * amp * k + reach * 0.34;
    _pose[l + RZ] += side * 0.08;
    if (drag) {
      _pose[u + RX] += this.armDragDroop;
      _pose[u + RZ] += side * 0.16;
      _pose[l + RX] += -0.30;
    }
  }

  /**
   * THE TELL. A wind-up held perfectly still for `ANIM.windupHold` of its duration and then
   * snapped — because a pose that eases into place has no readable moment of commitment, and the
   * player is meant to see the commitment and slide out of it. 0.42 s of tell against a 5.4 m/s
   * walk is 2.27 m of escape, and the swing reaches 1.9 m. Every hit is avoidable.
   */
  private poseAttack(a: PoseArgs): void {
    const rise = holdThenEase(a.windup01, ANIM.windupHold, easeOutExpo);
    const hit = a.strike01 > 0 ? easeOutExpo(clamp01(a.strike01)) : 0;
    const arm = lerp(ANIM.windupArm * rise, ANIM.strikeArm, hit);
    const lean = lerp(ANIM.windupLean * rise, ANIM.strikeLean, hit);

    _pose[PART.CHEST * 9 + RX] += lean;
    _pose[PART.BELLY * 9 + RX] += lean * 0.4;
    _pose[PART.PELVIS * 9 + OZ] += -ANIM.strikeLunge * hit;
    _pose[PART.PELVIS * 9 + OY] += -0.06 * rise;
    _pose[PART.HEAD * 9 + RX] += lean * 0.55;
    _pose[PART.JAW * 9 + RX] += ANIM.windupJaw * Math.max(rise, hit);

    for (const [u, l, side] of [
      [PART.ARM_UR, PART.ARM_LR, 1],
      [PART.ARM_UL, PART.ARM_LL, -1],
    ] as const) {
      _pose[u * 9 + RX] += arm;
      _pose[u * 9 + RZ] += side * (0.55 * rise - 0.35 * hit);
      _pose[l * 9 + RX] += -0.55 * rise + 0.5 * hit;
    }
  }

  /**
   * THE CLIMB (BUILD 005). The answer to *"they dont go up stairs or things so u can just camp
   * top of a building"* — and it has to be an answer the player can watch happening, or a horde
   * appearing on your ledge reads as the game cheating rather than as the game coming for you.
   *
   * Three drawings, in the hold-frame language of everything else in this file (ART §8 — the
   * inputs are already snapped to the 12 Hz clock by the service, so each of these curves is a
   * staircase and the body genuinely HOLDS each beat for several frames):
   *
   *   REACH   both arms thrown straight overhead onto the lip, head back, legs hanging dead.
   *           Held for `ANIM.climbHold` of the whole duration — this is the tell, and it is the
   *           longest held pose any enemy has. You get to see it, aim at it, and decide.
   *   HAUL    elbows fold, the torso is dragged up and pitches forward over the lip, the whole
   *           dead weight swaying on two arms.
   *   PLANT   the leading knee is thrown up onto the ledge and the body rises over it.
   *
   * The whole thing is 1.0–2.2 s depending on the ledge (`NAV.climbBase` + per metre). A player
   * holding a rim gets a slow, telegraphed, entirely fair fight — which is the point. This is a
   * horror beat, not a parkour move.
   */
  private poseClimb(a: PoseArgs): void {
    const t = clamp01(a.climb01);
    // Phase 1: the hang. Phase 2: the haul. `holdThenEase` is the same operator the melee
    // wind-up uses, which is deliberate — a held pose then a commit is this game's verb.
    const haul = holdThenEase(t, ANIM.climbHold, easeOutExpo);
    // The plant only starts once the chest is over the lip.
    const plant = clamp01((t - 0.62) / 0.38);
    const plantK = easeOutExpo(plant);
    // Dead-weight sway, on the same slow beat as the head loll. Dies as the body gets support.
    const sway = Math.sin(t * TAU * 1.5) * ANIM.climbSway * (1 - plantK);

    const p = PART.PELVIS * 9;
    _pose[p + OZ] += -ANIM.climbPull * haul;
    _pose[p + RZ] += sway;
    _pose[p + RX] += -0.32 * haul;

    // Torso: arched back while hanging, folded forward over the lip as it comes up.
    const b = PART.BELLY * 9;
    _pose[b + RX] += lerp(0.22, ANIM.climbFold * 0.45, haul);
    const ch = PART.CHEST * 9;
    _pose[ch + RX] += lerp(0.34, ANIM.climbFold, haul);
    _pose[ch + RZ] += sway * 0.6;

    // Head up at the ledge the whole way — a zombie climbing toward you looks AT you.
    _pose[PART.HEAD * 9 + RX] += lerp(0.55, 0.1, haul);
    _pose[PART.JAW * 9 + RX] += ANIM.windupJaw * (0.5 + 0.5 * (1 - haul));

    // Arms: straight overhead on the lip, elbows folding as they pull.
    for (const [u, l, side] of [
      [PART.ARM_UR, PART.ARM_LR, 1],
      [PART.ARM_UL, PART.ARM_LL, -1],
    ] as const) {
      _pose[u * 9 + RX] += ANIM.climbArmUp * (1 - plantK * 0.55);
      _pose[u * 9 + RZ] += side * (0.34 + sway * 0.5);
      _pose[l * 9 + RX] += ANIM.climbElbow * haul;
    }

    // Legs: dead and hanging, then one knee thrown onto the ledge. The asymmetry is the read.
    const lead = this.dragSide === 0 ? PART.LEG_UL : PART.LEG_UR;
    const leadLow = lead === PART.LEG_UL ? PART.LEG_LL : PART.LEG_LR;
    const trail = lead === PART.LEG_UL ? PART.LEG_UR : PART.LEG_UL;
    const trailLow = trail === PART.LEG_UR ? PART.LEG_LR : PART.LEG_LL;
    _pose[lead * 9 + RX] += ANIM.climbKnee * plantK;
    _pose[leadLow * 9 + RX] += -ANIM.climbKnee * 0.85 * plantK - 0.2;
    _pose[trail * 9 + RX] += -0.28 * (1 - plantK) + 0.35 * plantK;
    _pose[trailLow * 9 + RX] += -0.55 * (1 - plantK * 0.6);

    // The rag hangs straight down — the one part that is honest about which way gravity is.
    _pose[PART.RAG * 9 + RX] += 0.42 * (1 - haul * 0.5);
  }

  /** Comic pop-in: squashed flat, overshoot past full height, settle. */
  private poseSpawn(a: PoseArgs): void {
    const k = easeOutBack(clamp01(a.spawn01), (ANIM.spawnOvershoot - 1) * 6.8);
    const p = PART.PELVIS * 9;
    _pose[p + SY] *= lerp(ANIM.spawnSquash, 1, k);
    const sxz = lerp(1 + (1 - ANIM.spawnSquash) * 0.7, 1, k);
    _pose[p + SX] *= sxz;
    _pose[p + SZ] *= sxz;
    _pose[p + OY] += -(1 - k) * 0.35;
  }

  /**
   * THE IMPACT FRAME (ART §5). One dramatic blown-back pose, snapped to in two frames and then
   * held perfectly still until the body is gone and `panelShatter` owns the moment. A corpse
   * that ragdolls is a different game; a corpse that holds one drawn pose and then explodes into
   * panel shards is this one.
   */
  private poseDeath(a: PoseArgs): void {
    const k = easeOutExpo(clamp01(a.death01 * 3.4));
    // Blown BACKWARD: positive rx arches the torso back, which is the comic impact frame.
    _pose[PART.CHEST * 9 + RX] += ANIM.deathArch * k;
    _pose[PART.HEAD * 9 + RX] += ANIM.deathArch * 0.8 * k;
    _pose[PART.JAW * 9 + RX] += 1.3 * k;
    _pose[PART.PELVIS * 9 + OY] += -0.16 * k;
    _pose[PART.PELVIS * 9 + SY] *= 1 - 0.12 * k;
    for (const [u, side] of [[PART.ARM_UR, 1], [PART.ARM_UL, -1]] as const) {
      _pose[u * 9 + RX] += -ANIM.deathArmFling * k;
      _pose[u * 9 + RZ] += side * 1.05 * k;
    }
    _pose[PART.LEG_UR * 9 + RX] += 0.5 * k;
    _pose[PART.LEG_UL * 9 + RX] += 0.5 * k;
  }

  /**
   * ADDITIVE, applied after everything else. `leanX` / `leanZ` come from a bouncy spring in
   * `reactions.ts`, so a hit throws the body, overshoots and comes back; the shudder is the
   * high-frequency channel ART §9 reserves for enemies and nothing else in the frame.
   */
  private poseFlinch(a: PoseArgs): void {
    if (a.leanX === 0 && a.leanZ === 0 && a.shudder === 0) return;
    const lx = a.leanX * ANIM.flinchLean;
    const lz = a.leanZ * ANIM.flinchLean;
    const sh = a.shudder * ANIM.shudderAmp;

    _pose[PART.PELVIS * 9 + RZ] += lx * 0.45;
    _pose[PART.PELVIS * 9 + RX] += lz * 0.45;
    _pose[PART.BELLY * 9 + RZ] += lx * 0.30;
    _pose[PART.BELLY * 9 + RX] += lz * 0.35;
    _pose[PART.CHEST * 9 + RZ] += lx * 0.55 + sh;
    _pose[PART.CHEST * 9 + RX] += lz * 0.60;
    _pose[PART.HEAD * 9 + RZ] += lx * 0.90 - sh * 2.2;
    _pose[PART.HEAD * 9 + RX] += lz * 1.15;
    // Arms fly. A flinch you can only see in the torso reads as a wobble, not as an impact.
    for (const [u, l, side] of [
      [PART.ARM_UR, PART.ARM_LR, 1],
      [PART.ARM_UL, PART.ARM_LL, -1],
    ] as const) {
      _pose[u * 9 + RX] += lz * 0.8;
      _pose[u * 9 + RZ] += lx * 0.7 + side * sh * 1.6;
      _pose[l * 9 + RX] += lz * 0.5;
    }
  }

  /**
   * Local pose → fourteen enemy-local matrices, in one forward pass. `PART_PARENT` is monotonic
   * by construction, so a parent is always already resolved when its child is reached.
   *
   * Scale is deliberately NOT inherited: a part's world transform is built from its parent's
   * POSITION AND ROTATION only, and its own scale is applied last. Inheriting a non-uniform
   * scale down a chain skews every child's rotation — which is exactly how a "bloated" variant
   * ends up with sheared legs.
   */
  private compose(): void {
    for (let i = 0; i < PART_COUNT; i++) {
      const b = i * 9;
      _e.set(_pose[b + RX], _pose[b + RY], _pose[b + RZ], 'YXZ');
      _q.setFromEuler(_e);
      _v.set(
        this.rest[i].x + _pose[b + OX],
        this.rest[i].y + _pose[b + OY],
        this.rest[i].z + _pose[b + OZ],
      );
      const parent = PART_PARENT[i];
      if (parent < 0) {
        _wPos[i].copy(_v);
        _wQuat[i].copy(_q);
      } else {
        _qp.copy(_wQuat[parent]);
        _wPos[i].copy(_v).applyQuaternion(_qp).add(_wPos[parent]);
        _wQuat[i].copy(_qp).multiply(_q);
      }
      const sv = this.scale[i];
      _s.set(sv.x * _pose[b + SX], sv.y * _pose[b + SY], sv.z * _pose[b + SZ]);
      if (this.severedPart(i)) _s.multiplyScalar(SEVERED_SCALE);
      this.matrices[i].compose(_wPos[i], _wQuat[i], _s);
    }
  }

  /** True when this part belongs to a limb that has been shot off. */
  private severedPart(i: number): boolean {
    if (this.severed[LIMB.ARM_R] && (i === PART.ARM_UR || i === PART.ARM_LR)) return true;
    if (this.severed[LIMB.ARM_L] && (i === PART.ARM_UL || i === PART.ARM_LL)) return true;
    if (this.severed[LIMB.LEG_R] && (i === PART.LEG_UR || i === PART.LEG_LR)) return true;
    if (this.severed[LIMB.LEG_L] && (i === PART.LEG_UL || i === PART.LEG_LL)) return true;
    return false;
  }

  // ── hitbox anchors, read straight off the posed rig ───────────────────────
  //
  // WHAT YOU SEE IS WHAT YOU HIT. These are derived from the SAME stepped matrices the mesh is
  // drawn with, not from a smooth parallel rig — so a head that is being held for five frames
  // is also being *aimed at* for those five frames. A hitbox that leads the drawing is the
  // single most infuriating bug a shooter can ship.

  /** Head sphere centre, in enemy-local space. */
  headPoint(out: Vector3): Vector3 {
    return out.set(0, HITBOX.headCenterY, 0).applyMatrix4(this.matrices[PART.HEAD]);
  }

  /** Torso capsule, in enemy-local space. */
  torsoSegment(a: Vector3, b: Vector3): void {
    a.setFromMatrixPosition(this.matrices[PART.PELVIS]);
    b.set(0, HITBOX.torsoTopY, 0).applyMatrix4(this.matrices[PART.CHEST]);
  }

  /**
   * Limb capsule, in enemy-local space: shoulder→hand or hip→foot as ONE capsule. A capsule per
   * bone would be more accurate and would cost twice the ray tests for a target nobody is meant
   * to be sniping — limbs are the dismemberment surface, not a precision one.
   * Returns false when the limb is already gone.
   */
  limbSegment(limb: number, a: Vector3, b: Vector3): boolean {
    if (this.severed[limb]) return false;
    const root = LIMB_ROOT[limb];
    // The rig pairs upper/lower consecutively — see `PART` in defs.ts.
    const tip = root + 1;
    a.setFromMatrixPosition(this.matrices[root]);
    const len = limb < 2
      ? BODY.lowerArm[1] + BODY.hand[1] * 0.5
      : BODY.shin[1] + BODY.foot[1] * 0.5;
    b.set(0, -len, 0).applyMatrix4(this.matrices[tip]);
    return true;
  }

  /** Local-space position of the joint a severed limb came off — where the ink spray belongs. */
  limbRootPoint(limb: number, out: Vector3): Vector3 {
    return out.setFromMatrixPosition(this.matrices[LIMB_ROOT[limb]]);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.remove(this.hull);
    this.material.dispose();
    this.hullMaterial.dispose();
    this.prepassMaterial.dispose();
  }
}

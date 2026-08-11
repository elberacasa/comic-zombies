/**
 * THE SHAMBLER'S BODY — one continuous skinned surface, the drawn animation, and the materials.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE ZOMBIE IS STILL TWO DRAW CALLS. Read this before changing anything structural.
 *
 *  BUILD 006 baked fourteen rigid boxes into one buffer with a per-vertex part index and posed
 *  them with a `mat4[14]` uniform. That kept the draw calls down and it is why this file did not
 *  need rewriting from scratch — but rigid parts pivot on their own surface, so every joint
 *  either tore a hole or drove one box through another, and the 8 px enemy ink line drew the
 *  hole twice. See the long note in `defs.ts` above `BONE`.
 *
 *  BUILD 007 keeps the exact same GPU shape — ONE shared geometry, a per-instance uniform, two
 *  meshes — and replaces the rigid part index with real four-influence linear blend skinning:
 *
 *      1 body mesh + 1 inverted-hull mesh   =  2 draw calls per zombie   (unchanged)
 *      21 bones × 3 vec4 rows               =  63 vec4 uniforms per instance
 *
 *  The geometry is a `SurfaceCage` (art/shapes §4): an INDEXED loft whose topology this file
 *  authored, so the body mesh and the hull mesh are expanded from the same cage with the same
 *  vertex ordering — flat normals for the body, smooth normals for the hull — and the skin
 *  weights are solved exactly once and ride into both. BUILD 006 welded the hull out of the
 *  finished body geometry per part, which is why the hull could never have been skinned.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE SHADER PATCH. `makeEnemyMaterial()` (world/lighting.ts) is the mandated recipe and we do
 * not fork it; we take the material it returns and insert a few lines at the top of `main()`
 * that shadow `position` and `normal` with their skinned values. Shadowing a global with a local
 * is legal GLSL, and it means the ~90 lines of ink shading never have to know the rig exists —
 * so a future edit to `InkMaterial` cannot silently break the zombies. The same lines go into
 * the hull shader from `buildOutlineHull()` and into the prepass material below. All three share
 * ONE `Float32Array` by reference, so they cannot pose differently.
 *
 * ART DIRECTION, non-negotiable (ART §9 — the human asked for this by name):
 *   • flesh is `ACID`, on BOTH cel bands, straight out of `makeEnemyMaterial()`
 *   • the rim never turns off, and the reserved-channel probe in `passes/ink.ts` finds it
 *   • the silhouette is `READABILITY.ENEMY_OUTLINE_PX` = 8 px, the heaviest line in the game,
 *     against a 6 px cap on the heaviest prop in the arena
 *   • the boil is `ENEMY_BOIL` (0.08); the city inks at `ENV_BOIL` (0.03)
 *   • the ANIMATION IS STILL DRAWN, not interpolated: hold frames on the 12 Hz clock, off-beat
 *     limb timing, squash and stretch. Skinning changed the deformation, not the timing.
 */

import {
  BufferGeometry,
  Mesh,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import { PALETTE, hexMix } from '@/art/palette';
import {
  boxCage, cageToGeometry, loftTube, mergeCages,
  type CageAttribute, type LoftRing, type SurfaceCage,
} from '@/art/shapes';
import {
  LAYER, buildOutlineHull, setInkColor, setInkEmissive, type InkMaterial,
} from '@/render/materials';
import { makeEnemyMaterial } from '@/world/lighting';
import { Rng } from '@/core/rng';
import { TAU, clamp01, easeOutBack, easeOutExpo, holdThenEase, lerp, smoothstep } from '@/core/mathx';
import {
  ANIM, BODY, BONE, BONE_COUNT, BONE_PARENT, HITBOX, LIMB_ROOT, LIMB_TIP, SKEL, SURFACE,
  type BodyVariant, type EnemyStateName, type SurfaceRing,
} from '@/game/enemies/defs';
import {
  BonePalette, OX, OY, OZ, POSE_STRIDE, RX, RY, RZ, SKIN_DECL, SKIN_INFLUENCES, SKIN_MAIN,
  SX, SY, SZ, clearPose, makePoseBuffer, solveAo, solveSkin,
} from '@/game/enemies/rig';

// ═════════════════════════════════════════════════════════════════════════════
// 1. GEOMETRY — built once at boot, shared by every zombie that will ever exist.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One lofted region of the body, with the bones it is allowed to bind to.
 *
 * The candidate gate is CORRECTNESS, not an optimisation: in the bind pose the right forearm
 * passes within 6 cm of the right thigh, and an ungated nearest-bone solve welds them together
 * the first time the zombie takes a step. Gating by region is what a rigger does by hand with
 * an envelope; here it is four lines of data.
 */
interface Region {
  name: string;
  cage: SurfaceCage;
  bones: readonly number[];
  /** Bones this surface must NOT darken itself with. See `rig.ts::solveAo`. */
  aoExclude: readonly number[];
}

interface SlabSpec {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

/** `SurfaceRing[]` → `LoftRing[]`, offset into place. */
function toRings(src: readonly SurfaceRing[], dx = 0, dy = 0): LoftRing[] {
  const out: LoftRing[] = [];
  for (let i = 0; i < src.length; i++) {
    const r = src[i] as SurfaceRing;
    out.push({ x: (r.x ?? 0) + dx, y: r.y + dy, z: r.z ?? 0, u: r.u, v: r.v, round: r.round });
  }
  return out;
}

function slab(s: SlabSpec, seed: number): SurfaceCage {
  return boxCage(s.x, s.y, s.z, s.w, s.h, s.d, {
    round: 0.16,
    jitter: BODY.jitter,
    seed,
    segments: SURFACE.slabSegments,
  });
}

/**
 * The whole body, as a list of lofted regions in BIND space.
 *
 * Every limb's ROOT RING SITS INSIDE the mass it hangs off — the deltoid ring is inside the
 * chest, the hip ring is inside the pelvis, the skull's base ring is inside the neck. That is
 * the shoulder-seam fix: two surfaces that overlap inside an opaque volume can never open a gap
 * between them, whatever the joint does, and the ink hull draws the union's outer edge only.
 */
function buildRegions(): Region[] {
  const B = BONE;
  const S = SURFACE;
  const out: Region[] = [];

  // ── torso: hips → belly → chest → trapezius → neck, as ONE chain ───────────
  out.push({
    name: 'torso',
    cage: loftTube(toRings(S.torso), S.torsoSegments, {
      jitter: BODY.jitter, seed: 11, capBulge: 0.28,
    }),
    bones: [B.HIPS, B.SPINE, B.CHEST, B.NECK, B.HEAD, B.CLAV_R, B.CLAV_L, B.THIGH_R, B.THIGH_L],
    aoExclude: [B.HIPS, B.SPINE, B.CHEST],
  });

  // ── the skull. Base ring is buried in the neck, so head rotation BENDS the column. ──
  out.push({
    name: 'head',
    cage: loftTube(toRings(S.head), S.headSegments, { jitter: BODY.jitter, seed: 23 }),
    bones: [B.NECK, B.HEAD],
    aoExclude: [B.HEAD, B.NECK],
  });
  out.push({
    name: 'brow',
    cage: slab(S.brow, 29),
    bones: [B.HEAD],
    aoExclude: [B.HEAD],
  });
  out.push({
    name: 'jaw',
    cage: slab(S.jaw, 31),
    bones: [B.HEAD, B.JAW],
    aoExclude: [B.JAW],
  });

  // ── arms. Authored per side rather than mirrored: negating X flips the loft's handedness
  //    and inverts every normal, and a re-seeded jitter means the two arms are not one drawing
  //    printed twice. ──
  const arms = [
    { dx: S.armX, dy: 0, clav: B.CLAV_R, up: B.ARM_R, fore: B.FORE_R, hand: B.HAND_R, seed: 37, tag: 'R' },
    { dx: S.armXL, dy: S.armDropL, clav: B.CLAV_L, up: B.ARM_L, fore: B.FORE_L, hand: B.HAND_L, seed: 41, tag: 'L' },
  ] as const;
  for (const a of arms) {
    out.push({
      name: `arm${a.tag}`,
      cage: loftTube(toRings(S.arm, a.dx, a.dy), S.limbSegments, { jitter: BODY.jitter, seed: a.seed }),
      bones: [B.CHEST, a.clav, a.up, a.fore, a.hand],
      aoExclude: [a.up, a.fore, a.clav],
    });
    out.push({
      name: `hand${a.tag}`,
      cage: loftTube(toRings(S.hand, a.dx, a.dy), S.limbSegments, { jitter: BODY.jitter, seed: a.seed + 1 }),
      bones: [a.fore, a.hand],
      aoExclude: [a.hand, a.fore],
    });
  }

  // ── legs ──────────────────────────────────────────────────────────────────
  const legs = [
    { dx: S.legX, thigh: B.THIGH_R, shin: B.SHIN_R, foot: B.FOOT_R, seed: 53, tag: 'R' },
    { dx: -S.legX, thigh: B.THIGH_L, shin: B.SHIN_L, foot: B.FOOT_L, seed: 59, tag: 'L' },
  ] as const;
  for (const l of legs) {
    out.push({
      name: `leg${l.tag}`,
      cage: loftTube(toRings(S.leg, l.dx), S.limbSegments, { jitter: BODY.jitter, seed: l.seed }),
      bones: [B.HIPS, l.thigh, l.shin, l.foot],
      aoExclude: [l.thigh, l.shin],
    });
    out.push({
      name: `foot${l.tag}`,
      cage: slab({ x: l.dx, y: S.foot.y, z: S.foot.z, w: S.foot.w, h: S.foot.h, d: S.foot.d }, l.seed + 1),
      bones: [l.shin, l.foot],
      aoExclude: [l.foot, l.shin],
    });
  }

  // ── the asymmetry: a torn flap of coat off ONE shoulder blade. Never mirrored. ──
  // 0.13+ deep, not 0.045: a coat flap thinner than the ink band renders as a solid black blob.
  for (let i = 0; i < S.rag.length; i++) {
    out.push({
      name: `rag${i}`,
      cage: slab(S.rag[i] as SlabSpec, 71 + i * 2),
      bones: [B.CHEST, B.RAG],
      aoExclude: [B.RAG],
    });
  }

  return out;
}

/**
 * BOOT ASSERT: nothing on this body may be thinner than the ink line can survive. The measured
 * failure (BUILD 002, 5.6 m, 1568×716) was ~40% of the body rendering as solid ink because the
 * inverted hull's two inflated faces met in the middle — which costs the reserved ACID channel,
 * the one thing ART §9 says an enemy exists to carry. Loud, not silent: this is content data
 * and a human edits it.
 */
function assertInkFloor(): void {
  const thin: string[] = [];
  const check = (label: string, u: number, v: number): void => {
    if (Math.min(u, v) < BODY.minHalfWidth) thin.push(`${label} ${(Math.min(u, v) * 2).toFixed(3)}m`);
  };
  const checkSlab = (label: string, w: number, h: number, d: number): void => {
    const m = Math.min(w, h, d);
    if (m < BODY.minSlabDim) thin.push(`${label} slab ${m.toFixed(3)}m`);
  };
  const chain = (label: string, rings: readonly SurfaceRing[]): void => {
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i] as SurfaceRing;
      check(`${label}[${i}]`, r.u, r.v);
    }
  };
  chain('torso', SURFACE.torso);
  chain('head', SURFACE.head);
  chain('arm', SURFACE.arm);
  chain('hand', SURFACE.hand);
  chain('leg', SURFACE.leg);
  checkSlab('brow', SURFACE.brow.w, SURFACE.brow.h, SURFACE.brow.d);
  checkSlab('jaw', SURFACE.jaw.w, SURFACE.jaw.h, SURFACE.jaw.d);
  checkSlab('foot', SURFACE.foot.w, SURFACE.foot.h, SURFACE.foot.d);
  for (let i = 0; i < SURFACE.rag.length; i++) {
    const r = SURFACE.rag[i] as SlabSpec;
    checkSlab(`rag${i}`, r.w, r.h, r.d);
  }
  for (let b = 0; b < BONE_COUNT; b++) {
    const r = (SKEL[b] as { radius: number }).radius;
    if (r < BODY.minHalfWidth) thin.push(`bone${b} radius ${r.toFixed(3)}`);
  }
  if (thin.length > 0) {
    console.error(
      `[enemies/body] ${thin.length} surface section(s) are under the ${(BODY.minHalfWidth * 2).toFixed(3)} m `
      + `ink floor and will render as solid ink at range (ART §9): ${thin.join(', ')}`,
    );
  }
}

/**
 * THE EYE SOCKETS. Two recesses under the brow shelf, painted straight into the AO channel
 * rather than modelled: at 25 m a modelled socket is sub-pixel, but a dark VALUE under the brow
 * survives the ink line, the halftone and the bloom, and it is what makes the head read as a
 * face rather than as a lump. Costs nothing per frame — it is baked at boot.
 */
function paintSockets(cage: SurfaceCage, ao: Float32Array, offset: number): void {
  const zFront = SURFACE.brow.z - SURFACE.brow.d * 0.5;
  for (let i = 0; i < cage.count; i++) {
    const x = cage.position[i * 3] as number;
    const y = cage.position[i * 3 + 1] as number;
    const z = cage.position[i * 3 + 2] as number;
    if (z > zFront + 0.075) continue;                 // not on the face
    if (y > SURFACE.brow.y - 0.005 || y < SURFACE.brow.y - 0.085) continue;
    const ax = Math.abs(x);
    if (ax > 0.155) continue;
    // Two sockets, not one band: fade out across the bridge of the nose.
    const bridge = smoothstep(clamp01((ax - 0.022) / 0.045));
    const edge = 1 - smoothstep(clamp01((ax - 0.100) / 0.055));
    const k = bridge * edge;
    const j = offset + i;
    ao[j] = Math.max(BODY.aoMin * 0.72, (ao[j] as number) * (1 - BODY.aoSocket * k));
  }
}

export interface EnemyGeometrySet {
  body: BufferGeometry;
  hull: BufferGeometry;
  triangles: number;
  hullTriangles: number;
  /** Cage vertex count — the number of surface points the skin was solved for. */
  skinVertices: number;
  dispose(): void;
}

/**
 * Build the shared geometry. Called exactly once, from `EnemySystem.init`.
 *
 * Order matters: the regions are lofted in BIND space → the skin is solved per region against
 * its gated bone set → the AO is solved → the cages are merged → the merged cage is expanded
 * TWICE with identical vertex ordering. The body gets face normals (crisp facets for the cel
 * bands); the hull gets the cage's smooth normals so it inflates as one continuous shell.
 */
export function buildEnemyGeometry(): EnemyGeometrySet {
  assertInkFloor();
  const regions = buildRegions();

  let total = 0;
  for (const r of regions) total += r.cage.count;

  const skinIndex = new Float32Array(total * SKIN_INFLUENCES);
  const skinWeight = new Float32Array(total * SKIN_INFLUENCES);
  const ao = new Float32Array(total);

  let offset = 0;
  for (const r of regions) {
    solveSkin(r.cage.position, r.cage.count, r.bones, skinIndex, skinWeight, offset);
    solveAo(r.cage.position, r.cage.normal, r.cage.count, r.aoExclude, ao, offset);
    if (r.name === 'head') paintSockets(r.cage, ao, offset);
    offset += r.cage.count;
  }

  // `InkMaterial` reads the painted AO out of `color.r` (see its VERT), so the channel is
  // replicated rather than packed — three declares `attribute vec3 color` or nothing at all.
  const colors = new Float32Array(total * 3);
  for (let i = 0; i < total; i++) {
    const a = ao[i] as number;
    colors[i * 3] = a;
    colors[i * 3 + 1] = a;
    colors[i * 3 + 2] = a;
  }

  const merged = mergeCages(regions.map((r) => r.cage));
  const skinAttrs: CageAttribute[] = [
    { name: 'aSkinIndex', itemSize: SKIN_INFLUENCES, data: skinIndex },
    { name: 'aSkinWeight', itemSize: SKIN_INFLUENCES, data: skinWeight },
  ];
  const body = cageToGeometry(merged, {
    flat: true,
    attributes: [...skinAttrs, { name: 'color', itemSize: 3, data: colors }],
  });
  const hull = cageToGeometry(merged, { flat: false, attributes: skinAttrs });

  // The bind pose's bounds are not the ANIMATED bounds — a wind-up throws the arms well outside
  // them, and a body culled mid-swing pops. Frustum culling reads this, so it is authored
  // generously rather than computed.
  body.boundingSphere = new Sphere(new Vector3(0, BODY.height * 0.5, 0), BODY.height * 0.95);
  hull.boundingSphere = new Sphere(new Vector3(0, BODY.height * 0.5, 0), BODY.height * 0.95);

  return {
    body,
    hull,
    triangles: body.getAttribute('position').count / 3,
    hullTriangles: hull.getAttribute('position').count / 3,
    skinVertices: merged.count,
    dispose(): void {
      body.dispose();
      hull.dispose();
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE SHADER PATCH
// ═════════════════════════════════════════════════════════════════════════════

const MAIN_MARKER = 'void main() {';

/**
 * Patch a vertex shader to apply the skin. Loud on failure: a silently un-skinned zombie is a
 * bind-pose statue sliding across the plaza, which is far worse than a console error.
 */
function patchSkinning(src: string, label: string): string {
  const at = src.indexOf(MAIN_MARKER);
  if (at < 0) {
    console.error(
      `[enemies/body] could not patch the rig into the ${label} vertex shader — `
      + `"${MAIN_MARKER}" not found. Zombies will not animate. Someone changed `
      + 'render/materials/index.ts; re-anchor this patch.',
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
 * which has neither our skin attributes nor our `uBone` uniform. So every zombie wrote its
 * UNSKINNED bind pose into the prepass while the beauty pass drew it posed. Measured result, at
 * 2–15 m: the ink pass read the CITY's depth across the zombie's silhouette and inked arcade
 * railings, kerbs and bins straight through the torso; the body got no interior line of its own;
 * the always-on ART §9 enemy rim, gated on that same depth via `nearerMask`, never drew; and
 * `boilNear` sampled a background distance. The enemy — the one thing §9 says must be the most
 * legible object in the frame — was the only translucent thing in it.
 *
 * The renderer now swaps materials per object and honours `mesh.userData.czPrepassMaterial`, so
 * the fix is simply to publish a skinned normal material here. It is deliberately a hand-written
 * ShaderMaterial rather than a patched `MeshNormalMaterial`: it is nine lines, it cannot be
 * broken by a three.js include being reshuffled, and it goes through the SAME `patchSkinning()`
 * as the body and the hull — so the three shaders cannot pose differently. Output matches
 * `MeshNormalMaterial` exactly: `normalize(view normal) * 0.5 + 0.5`.
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
  /** Skinned stand-in for the renderer's normal/depth prepass. See the block comment above. */
  prepass: ShaderMaterial;
  outlinePx: number;
}

/**
 * One enemy's materials, sharing ONE bone palette `Float32Array` by reference so the body, its
 * silhouette and the prepass can never pose differently.
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
  palette: Float32Array, hue: number, presence: number,
): EnemyMaterialPair {
  const recipe = makeEnemyMaterial({ hue, presence, name: 'Ink_shambler' });
  const body = recipe.material;
  body.vertexShader = patchSkinning(body.vertexShader, 'ink');
  body.uniforms.uBone = { value: palette };
  // Painted AO lives in the geometry's `color` attribute; switch the shader over to reading it.
  body.vertexColors = true;
  body.uniforms.uVertexAo!.value = BODY.aoStrength;

  // THE HEAVIEST INK WEIGHT IN THE GAME (ART §9): 8 px, against a 6 px cap on the heaviest prop
  // in the arena. `buildOutlineHull` builds its own material on every call — verified against
  // `render/materials/index.ts` — so an enemy's line weight cannot leak into the city's. A
  // scratch geometry is passed and immediately freed: we want the material, not the mesh.
  const scratch = new BufferGeometry();
  const hullMesh = buildOutlineHull(scratch, {
    thickness: recipe.outlinePx,
    minThickness: recipe.outlinePx * 0.55,
    boil: recipe.boil,
    ink: PALETTE.INK,
    weld: false,
  });
  const hull = hullMesh.material as ShaderMaterial;
  hull.vertexShader = patchSkinning(hull.vertexShader, 'outline');
  hull.uniforms.uBone = { value: palette };
  scratch.dispose();

  const prepass = new ShaderMaterial({
    name: 'Prepass_shambler',
    vertexShader: patchSkinning(PREPASS_VERT, 'prepass'),
    fragmentShader: PREPASS_FRAG,
    uniforms: { uBone: { value: palette } },
  });

  return { body, hull, prepass, outlinePx: recipe.outlinePx };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE ANIMATION
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
const _pose = makePoseBuffer();
const _local = new Vector3();

/** Every bone under (and including) a limb's root — what a dismemberment collapses. */
const LIMB_CHAIN: readonly (readonly number[])[] = LIMB_ROOT.map((root) => {
  const chain = [root];
  for (let i = 0; i < BONE_COUNT; i++) {
    if (chain.indexOf(BONE_PARENT[i] as number) >= 0 && chain.indexOf(i) < 0) chain.push(i);
  }
  return chain;
});

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
 * One zombie's renderable body: two meshes, one skeleton instance, and the per-instance
 * proportions that stop it being a twin of the one next to it.
 */
export class EnemyBody {
  readonly mesh: Mesh;
  readonly hull: Mesh;
  /**
   * ── THE BONE API (the combat agent's entry point) ───────────────────────────────────────
   * The posed skeleton. Everything on it is enemy-local and valid immediately after `pose()`.
   * Attach hitboxes, decals, blood emitters and severed-limb props to REAL bones through this
   * instead of guessing offsets:
   *
   *     body.rig.boneSegment(BONE.FORE_R, a, b);      // a capsule that is actually the forearm
   *     body.rig.boneRadius(BONE.FORE_R);             // …and its radius, instance-scaled
   *     body.rig.bonePoint(BONE.HEAD, out);           // the skull's joint
   *     body.rig.boneMatrix(BONE.JAW);                // full transform; DO NOT MUTATE
   *     body.rig.boneLocal(BONE.HAND_R, offset, out); // hand-local → enemy-local
   *
   * See the header of `rig.ts` for the full contract. The convenience wrappers below
   * (`headPoint`, `torsoSegment`, `limbSegment`) are the six primitives `HITBOX` describes and
   * are what `EnemySystem.raycast` uses; anything finer-grained goes through `rig`.
   * ────────────────────────────────────────────────────────────────────────────────────────
   */
  readonly rig = new BonePalette();
  readonly material: InkMaterial;
  readonly hullMaterial: ShaderMaterial;
  /** Published on the mesh as `userData.czPrepassMaterial`; the renderer swaps it in. */
  readonly prepassMaterial: ShaderMaterial;
  /** Full-weight ink for this instance — `READABILITY.ENEMY_OUTLINE_PX` × presence. */
  readonly outlinePx: number;

  private readonly severedLimb = [false, false, false, false];

  private variant: BodyVariant;
  /** Which leg drags. The most-noticed piece of per-instance character. */
  private dragSide = 0;
  private headTilt = 0;
  private shoulderHike = 0;
  private heightScale = 1;
  /**
   * ── THE SILHOUETTE VARIATION SET (M2 §2: "no two are twins") ──────────────────────────
   * These are deliberately in the OUTLINE, not in the surface detail: a bold line erases
   * interior detail, so a thickness tweak is invisible at fighting range while a dead arm, a
   * lolling head or an off-axis torso are readable at 25 m in one glance.
   *
   * BUILD 007 adds the one thing rigid parts could not do: BONE-LENGTH variation. A skeleton
   * can give this zombie a 30% longer forearm and the skin stretches to match, which changes
   * the SHAPE of the silhouette and not merely its pose.
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

    const mats = makeEnemyMaterials(this.rig.data, hue, presence);
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
  reseed(rng: Rng, variant: BodyVariant, kindScale = 1): void {
    this.variant = variant;
    // `kindScale` is the KIND's silhouette, on top of the per-instance variant roll. A special
    // has to be identifiable by shape across the arena — you cannot ask a player to prioritise a
    // target they cannot pick out of a crowd (ART §9). The instance roll still applies, so two
    // screamers are still two different screamers.
    const g = variant.scale * kindScale * rng.range(0.94, 1.07);
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

    // ── BONE LENGTHS. The whole skeleton scales by `g` first (rest offsets are parent-relative,
    //    so scaling every one of them scales the body about the feet), then each chain takes its
    //    own multiplier on top. ──
    const rig = this.rig;
    const B = BONE;
    rig.reset();
    for (let b = 0; b < BONE_COUNT; b++) rig.scaleBoneLength(b, g);

    for (const b of [B.SPINE, B.CHEST, B.NECK, B.HEAD, B.CLAV_R, B.CLAV_L] as const) {
      rig.scaleBoneLength(b, torso);
    }
    rig.scaleBoneLength(B.JAW, head);

    // The dead arm is LONGER as well as slacker — the two together are what make it read as a
    // limb hanging wrong rather than as an animation glitch.
    const reachR = reach * (this.armDragSide === 0 ? this.armDragLen : 1);
    const reachL = reach * (this.armDragSide === 1 ? this.armDragLen : 1);
    rig.scaleBoneLength(B.ARM_R, limb);
    rig.scaleBoneLength(B.ARM_L, limb);
    rig.scaleBoneLength(B.FORE_R, limb * reachR);
    rig.scaleBoneLength(B.FORE_L, limb * reachL);
    rig.scaleBoneLength(B.HAND_R, limb * reachR);
    rig.scaleBoneLength(B.HAND_L, limb * reachL);
    for (const b of [B.THIGH_R, B.THIGH_L, B.SHIN_R, B.SHIN_L, B.FOOT_R, B.FOOT_L] as const) {
      rig.scaleBoneLength(b, limb);
    }

    // ── BONE GIRTH. This is where a "gaunt" and a "bloated" actually differ. Not inherited
    //    down the chain (see `BonePalette.compose`), so a fat belly cannot shear the legs. ──
    const gt = g * torso;
    const gh = g * head;
    const gl = g * limb;
    rig.setBoneGirth(B.HIPS, gt, g, gt);
    rig.setBoneGirth(B.SPINE, gt * rng.range(0.97, 1.10), gt, gt);
    rig.setBoneGirth(B.CHEST, gt, gt, gt * rng.range(0.94, 1.05));
    // The NECK deliberately does not fatten with the torso: a bloated zombie with a bloated
    // neck loses the one silhouette notch that makes its head a target.
    const gn = g * lerp(1, torso, 0.35);
    rig.setBoneGirth(B.NECK, gn, gt, gn);
    rig.setBoneGirth(B.HEAD, gh, gh, gh);
    rig.setBoneGirth(B.JAW, gh, gh, gh);
    rig.setBoneGirth(B.CLAV_R, gt, gt, gt);
    rig.setBoneGirth(B.CLAV_L, gt, gt, gt);
    rig.setBoneGirth(B.ARM_R, gl, gl, gl);
    rig.setBoneGirth(B.ARM_L, gl * rng.range(0.90, 1.12), gl, gl);
    rig.setBoneGirth(B.FORE_R, gl, gl, gl);
    rig.setBoneGirth(B.FORE_L, gl, gl, gl);
    rig.setBoneGirth(B.HAND_R, gl, gl, gl);
    rig.setBoneGirth(B.HAND_L, gl, gl, gl);
    for (const b of [B.THIGH_R, B.THIGH_L, B.SHIN_R, B.SHIN_L, B.FOOT_R, B.FOOT_L] as const) {
      rig.setBoneGirth(b, gl, gl, gl);
    }
    rig.setBoneGirth(B.RAG, gt, gt * rng.range(0.8, 1.3), gt);

    this.severedLimb[0] = false;
    this.severedLimb[1] = false;
    this.severedLimb[2] = false;
    this.severedLimb[3] = false;
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

  /** Take a limb off: collapse its whole bone chain. Blended vertices stay → a ragged stump. */
  sever(limb: number): void {
    this.severedLimb[limb] = true;
    for (const b of LIMB_CHAIN[limb] as readonly number[]) this.rig.setSevered(b, true);
  }

  isSevered(limb: number): boolean {
    return this.severedLimb[limb] as boolean;
  }

  // ── the animation ────────────────────────────────────────────────────────

  /**
   * Evaluate every layer, compose the bone palette, and leave it in `this.rig.data` (which the
   * three materials already point at — no upload call needed).
   *
   * Layer order is load-bearing: gait → state pose → additive flinch. The flinch is LAST and
   * ADDITIVE so a bullet visibly moves a body that is mid-swing, which is the whole of
   * "a zombie that absorbs a bullet without visibly reacting is a bug".
   */
  pose(a: PoseArgs): void {
    clearPose(_pose);
    this.poseGait(a);
    if (a.state === 'attack') this.poseAttack(a);
    if (a.state === 'climb') this.poseClimb(a);
    if (a.state === 'spawn') this.poseSpawn(a);
    if (a.state === 'death') this.poseDeath(a);
    this.poseFlinch(a);
    this.rig.compose(_pose);
  }

  /**
   * THE WALK. Everything here is sampled from `a.gait`, which the service has already snapped
   * onto the 12 Hz clock — so each of these curves is a staircase, not a curve, and the body
   * holds a pose for ~5 frames at 60 fps before jumping to the next (ART §8). Smooth
   * interpolation is the enemy; we want the uncanny stop-motion of animated ink.
   *
   * SKINNING DID NOT CHANGE THE TIMING. Every amplitude, every phase offset and every held beat
   * below is BUILD 006's, because the brief was "smooth deformation with jerky timing" — the
   * deformation is what got better, and letting the timing drift smooth with it would have
   * thrown away the whole art direction to buy nothing.
   */
  private poseGait(a: PoseArgs): void {
    const ph = a.gait;
    const amp = 0.35 + 0.65 * a.speed01;
    const s = Math.sin(ph * TAU);
    const c = Math.cos(ph * TAU);
    const s2 = Math.sin(ph * TAU * 2);

    // ── hips: roll, twist, and a hard drop on every foot-plant. This is the weight. ──
    const p = BONE.HIPS * POSE_STRIDE;
    _pose[p + RZ] += s * ANIM.hipRoll * amp;
    _pose[p + RY] += s * ANIM.hipTwist * amp;
    _pose[p + OY] += -Math.abs(s) * ANIM.bobDown * amp;

    // ── THE LURCH ──────────────────────────────────────────────────────────────────────────
    // "the gait is a walk cycle; COD zombies LURCH." Everything above is symmetric: the pelvis
    // rolls the same amount each way and drops the same amount onto either foot, which is a
    // WALK — a tidy one — no matter how much stoop is piled on top of it.
    //
    // Two things make it a lurch, and neither is a rotation:
    //
    //  1. WEIGHT TRANSFER IS A TRANSLATION. A body carries its mass over the planted foot; it
    //     does not pivot around its own centreline. `OX` has existed on every bone since the rig
    //     was written and nothing had ever used it. `s` is +1 at the right foot-plant and −1 at
    //     the left, so this IS the stance side, for free.
    //  2. THE LIMP IS ASYMMETRIC. `dragSide` already decides which leg drags, but the pelvis was
    //     dropping identically onto the good leg and the bad one. Landing on the bad leg has to
    //     cost more — that single sign is the difference between "walking" and "something wrong
    //     with that one".
    const dragSign = this.dragSide === 0 ? 1 : -1;
    _pose[p + OX] += s * ANIM.weightShift * amp;
    _pose[p + OY] += -Math.max(0, s * dragSign) * ANIM.lurchDrop * amp;

    // ── spine: a permanent hunch, a counter-twist, and squash/stretch on twos ──
    // SIGN: a bone ABOVE its joint leans BACK for a positive rx (see the note on ANIM.windupLean),
    // so the hunch — which is forward — is negative all the way up the spine.
    const spinePitch = -this.variant.stoop * 0.45;
    const b = BONE.SPINE * POSE_STRIDE;
    _pose[b + RX] += spinePitch;
    // Off-axis: this body is bent sideways and turned a few degrees off its own heading, for
    // its whole life. It is a rest-pose property, so it costs nothing per frame and it survives
    // the 12 Hz pose clock intact.
    _pose[b + RZ] += this.torsoLean * 0.45;
    _pose[b + SY] += s2 * ANIM.squash * amp;
    _pose[b + SX] += -s2 * ANIM.squash * 0.5 * amp;
    _pose[b + SZ] += -s2 * ANIM.squash * 0.5 * amp;

    const chestPitch = -(this.variant.stoop * 0.55 + ANIM.hunch * a.speed01);
    const ch = BONE.CHEST * POSE_STRIDE;
    _pose[ch + RX] += chestPitch;
    // A LEADING SHOULDER. `torsoTwist` is a random constant with a random sign, so it reads as
    // noise; this one is keyed to `dragSign`, which means the shoulder that comes at you is
    // always the one over the leg that works. One injury, expressed twice — that reads as a
    // body, where two unrelated random offsets read as jitter.
    const chestTwist = -s * ANIM.spineTwist * amp + this.torsoTwist
      + dragSign * ANIM.shoulderLead;
    _pose[ch + RY] += chestTwist;
    _pose[ch + RZ] += this.shoulderHike * 0.5 + this.torsoLean * 0.55;
    // The stretch has to travel: a stretched belly must lift the chest or the torso pulls apart.
    _pose[ch + OY] += s2 * ANIM.squash * 0.16 * amp;

    // ── clavicles: the hiked shoulder now has a BONE. One rises, the other drops — a single
    //    signed rotation does both, because they sit on opposite sides of the spine. ──
    _pose[BONE.CLAV_R * POSE_STRIDE + RZ] += this.shoulderHike * ANIM.clavHike;
    _pose[BONE.CLAV_L * POSE_STRIDE + RZ] += this.shoulderHike * ANIM.clavHike;

    // ── neck + head: THE READ. The body stoops; the face does not go with it. ──
    //
    // The neck pitches FORWARD (thrust), which pushes the skull clear of the shoulder mass, and
    // the head then counter-pitches by `neckCounter` of everything the spine and chest did, so
    // the face comes back up and stays pointed at the player. A rigid rig could not do this —
    // there was no neck to pitch — and that is precisely why BUILD 006's head sank between the
    // shoulders whenever the stoop was doing its job.
    const nk = BONE.NECK * POSE_STRIDE;
    _pose[nk + RX] += -ANIM.headThrust;
    _pose[nk + RZ] += this.headTilt * 0.35
      + Math.sin(ph * TAU + 1.55) * ANIM.headLoll * ANIM.neckLoll * amp;

    const h = BONE.HEAD * POSE_STRIDE;
    _pose[h + RX] += ANIM.headThrust * 0.75
      - (spinePitch + chestPitch) * ANIM.neckCounter
      + Math.sin(ph * TAU * 2 + 0.6) * ANIM.headNod * amp;
    _pose[h + RZ] += this.headTilt * 0.65 + Math.sin(ph * TAU + 1.15) * ANIM.headLoll * amp;
    _pose[h + RY] += -chestTwist * ANIM.headCounterTwist;

    const j = BONE.JAW * POSE_STRIDE;
    _pose[j + RX] += ANIM.jawOpen * (0.55 + 0.45 * Math.sin(ph * TAU * 0.5 + 2.1));

    // ── legs: one drags, and they are off-beat by `limpAsym`, not a clean half cycle ──
    this.poseLeg(BONE.THIGH_R, BONE.SHIN_R, BONE.FOOT_R, ph, amp, this.dragSide === 0);
    this.poseLeg(
      BONE.THIGH_L, BONE.SHIN_L, BONE.FOOT_L, ph + 0.5 + ANIM.limpAsym, amp, this.dragSide === 1);

    // ── arms: lag the legs by 0.37 of a cycle. 0.5 reads as walking; 0.37 reads as wrong. ──
    const reach = 1 - smoothstep(clamp01((a.targetDist - 1.2) / ANIM.armReachRange));
    this.poseArm(
      BONE.ARM_R, BONE.FORE_R, BONE.HAND_R, ph + ANIM.armLag, amp, reach, 1,
      this.armDragSide === 0);
    this.poseArm(
      BONE.ARM_L, BONE.FORE_L, BONE.HAND_L, ph + ANIM.armLag + 0.5 + ANIM.limpAsym * 0.5, amp,
      reach, -1, this.armDragSide === 1);

    // ── the rag swings a beat behind everything else ─────────────────────────
    const r = BONE.RAG * POSE_STRIDE;
    _pose[r + RX] += 0.18 + c * 0.16 * amp;
    _pose[r + RZ] += s * 0.13 * amp;
  }

  private poseLeg(
    upper: number, lower: number, foot: number, ph: number, amp: number, drag: boolean,
  ): void {
    const swing = Math.sin(ph * TAU);
    const u = upper * POSE_STRIDE;
    const l = lower * POSE_STRIDE;
    const k = drag ? ANIM.dragLeg : 1;
    const thigh = swing * ANIM.thighSwing * amp * k;
    _pose[u + RX] += thigh;
    // Knees only bend one way. `max(0, …)` is what stops a shin folding forward through a thigh.
    const bend = Math.max(0, Math.sin((ph + 0.28) * TAU));
    const shin = -(bend * ANIM.kneeBend * amp * k + (drag ? 0.34 : 0.06));
    _pose[l + RX] += shin;
    if (drag) _pose[u + RZ] += 0.16;
    // THE FOOT IS A BONE NOW, and it earns its keep: it cancels most of the leg's accumulated
    // pitch so the sole stays roughly parallel to the ground through the whole stride. The
    // rigid rig welded the foot to the shin, which pointed it at the sky on every swing.
    _pose[foot * POSE_STRIDE + RX] += -(thigh + shin) * 0.72 - (drag ? 0.18 : 0.04);
  }

  private poseArm(
    upper: number, lower: number, hand: number, ph: number, amp: number, reach: number,
    side: number, drag: boolean,
  ): void {
    const swing = Math.sin(ph * TAU);
    const u = upper * POSE_STRIDE;
    const l = lower * POSE_STRIDE;
    const k = drag ? ANIM.dragArm : 1;
    // Hanging and swinging far away; reaching for you the closer you get. The DEAD arm barely
    // swings, hangs further forward and off the body, and keeps a folded elbow — so even at a
    // dead stop the two sides of this zombie do not match.
    _pose[u + RX] += swing * ANIM.armSwing * amp * k + ANIM.armIdleForward + reach * ANIM.armReach;
    _pose[u + RZ] += side * (0.13 + reach * 0.1);
    _pose[l + RX] += -ANIM.armDroop - Math.max(0, swing) * 0.22 * amp * k + reach * 0.34;
    _pose[l + RZ] += side * 0.08;
    // The hand curls as the arm reaches — one joint further out than the rig used to have. A
    // splayed hand thrown at the camera is the last frame before a hit.
    _pose[hand * POSE_STRIDE + RX] += -0.22 + reach * 0.55;
    _pose[hand * POSE_STRIDE + RZ] += side * (0.22 - reach * 0.12);
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

    _pose[BONE.CHEST * POSE_STRIDE + RX] += lean;
    _pose[BONE.SPINE * POSE_STRIDE + RX] += lean * 0.4;
    _pose[BONE.HIPS * POSE_STRIDE + OZ] += -ANIM.strikeLunge * hit;
    _pose[BONE.HIPS * POSE_STRIDE + OY] += -0.06 * rise;
    // The head stays ON the player through the whole swing rather than riding the lean. That is
    // both the horror beat and the reason the crit is still there to take while it commits.
    _pose[BONE.NECK * POSE_STRIDE + RX] += lean * 0.30;
    _pose[BONE.HEAD * POSE_STRIDE + RX] += -lean * 0.55;
    _pose[BONE.JAW * POSE_STRIDE + RX] += ANIM.windupJaw * Math.max(rise, hit);

    for (const [u, l, hd, side] of [
      [BONE.ARM_R, BONE.FORE_R, BONE.HAND_R, 1],
      [BONE.ARM_L, BONE.FORE_L, BONE.HAND_L, -1],
    ] as const) {
      _pose[u * POSE_STRIDE + RX] += arm;
      _pose[u * POSE_STRIDE + RZ] += side * (0.55 * rise - 0.35 * hit);
      _pose[l * POSE_STRIDE + RX] += -0.55 * rise + 0.5 * hit;
      _pose[hd * POSE_STRIDE + RX] += 0.6 * rise - 0.45 * hit;
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

    const p = BONE.HIPS * POSE_STRIDE;
    _pose[p + OZ] += -ANIM.climbPull * haul;
    _pose[p + RZ] += sway;
    _pose[p + RX] += -0.32 * haul;

    // Torso: arched back while hanging, folded forward over the lip as it comes up.
    const b = BONE.SPINE * POSE_STRIDE;
    _pose[b + RX] += lerp(0.22, ANIM.climbFold * 0.45, haul);
    const ch = BONE.CHEST * POSE_STRIDE;
    _pose[ch + RX] += lerp(0.34, ANIM.climbFold, haul);
    _pose[ch + RZ] += sway * 0.6;

    // Head up at the ledge the whole way — a zombie climbing toward you looks AT you. The neck
    // takes part of it so the skull is not simply glued to the chest's arc.
    _pose[BONE.NECK * POSE_STRIDE + RX] += lerp(0.18, -0.05, haul);
    _pose[BONE.HEAD * POSE_STRIDE + RX] += lerp(0.55, 0.42, haul) - ANIM.climbFold * haul * 0.5;
    _pose[BONE.JAW * POSE_STRIDE + RX] += ANIM.windupJaw * (0.5 + 0.5 * (1 - haul));

    // Arms: straight overhead on the lip, elbows folding as they pull.
    for (const [u, l, hd, side] of [
      [BONE.ARM_R, BONE.FORE_R, BONE.HAND_R, 1],
      [BONE.ARM_L, BONE.FORE_L, BONE.HAND_L, -1],
    ] as const) {
      _pose[u * POSE_STRIDE + RX] += ANIM.climbArmUp * (1 - plantK * 0.55);
      _pose[u * POSE_STRIDE + RZ] += side * (0.34 + sway * 0.5);
      _pose[l * POSE_STRIDE + RX] += ANIM.climbElbow * haul;
      _pose[hd * POSE_STRIDE + RX] += -0.45 + 0.35 * haul;
    }

    // Legs: dead and hanging, then one knee thrown onto the ledge. The asymmetry is the read.
    const lead = this.dragSide === 0 ? BONE.THIGH_L : BONE.THIGH_R;
    const leadLow = lead === BONE.THIGH_L ? BONE.SHIN_L : BONE.SHIN_R;
    const trail = lead === BONE.THIGH_L ? BONE.THIGH_R : BONE.THIGH_L;
    const trailLow = trail === BONE.THIGH_R ? BONE.SHIN_R : BONE.SHIN_L;
    _pose[lead * POSE_STRIDE + RX] += ANIM.climbKnee * plantK;
    _pose[leadLow * POSE_STRIDE + RX] += -ANIM.climbKnee * 0.85 * plantK - 0.2;
    _pose[trail * POSE_STRIDE + RX] += -0.28 * (1 - plantK) + 0.35 * plantK;
    _pose[trailLow * POSE_STRIDE + RX] += -0.55 * (1 - plantK * 0.6);

    // The rag hangs straight down — the one part that is honest about which way gravity is.
    _pose[BONE.RAG * POSE_STRIDE + RX] += 0.42 * (1 - haul * 0.5);
  }

  /** Comic pop-in: squashed flat, overshoot past full height, settle. */
  private poseSpawn(a: PoseArgs): void {
    const k = easeOutBack(clamp01(a.spawn01), (ANIM.spawnOvershoot - 1) * 6.8);
    const p = BONE.HIPS * POSE_STRIDE;
    _pose[p + SY] *= lerp(ANIM.spawnSquash, 1, k);
    const sxz = lerp(1 + (1 - ANIM.spawnSquash) * 0.7, 1, k);
    _pose[p + SX] *= sxz;
    _pose[p + SZ] *= sxz;
    _pose[p + OY] += -(1 - k) * 0.35;
    // The spine carries the squash up the body, or only the hips inflate and the pop-in reads
    // as a hovering torso. One line the rigid rig could not have: the surface is continuous.
    const b = BONE.SPINE * POSE_STRIDE;
    _pose[b + SY] *= lerp(ANIM.spawnSquash + 0.2, 1, k);
    _pose[b + OY] += -(1 - k) * 0.10;
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
    _pose[BONE.CHEST * POSE_STRIDE + RX] += ANIM.deathArch * k;
    _pose[BONE.NECK * POSE_STRIDE + RX] += ANIM.deathArch * 0.50 * k;
    _pose[BONE.HEAD * POSE_STRIDE + RX] += ANIM.deathArch * 0.55 * k;
    _pose[BONE.JAW * POSE_STRIDE + RX] += 1.3 * k;
    _pose[BONE.HIPS * POSE_STRIDE + OY] += -0.16 * k;
    _pose[BONE.HIPS * POSE_STRIDE + SY] *= 1 - 0.12 * k;
    for (const [u, hd, side] of [
      [BONE.ARM_R, BONE.HAND_R, 1],
      [BONE.ARM_L, BONE.HAND_L, -1],
    ] as const) {
      _pose[u * POSE_STRIDE + RX] += -ANIM.deathArmFling * k;
      _pose[u * POSE_STRIDE + RZ] += side * 1.05 * k;
      _pose[hd * POSE_STRIDE + RZ] += side * 0.5 * k;
    }
    _pose[BONE.THIGH_R * POSE_STRIDE + RX] += 0.5 * k;
    _pose[BONE.THIGH_L * POSE_STRIDE + RX] += 0.5 * k;
  }

  /**
   * ADDITIVE, applied after everything else. `leanX` / `leanZ` come from a bouncy spring in
   * `reactions.ts`, so a hit throws the body, overshoots and comes back; the shudder is the
   * high-frequency channel ART §9 reserves for enemies and nothing else in the frame.
   *
   * The neck is in the chain now, which is what lets a headshot flinch actually SNAP the head:
   * `ANIM.flinchHeadMult` used to multiply a rotation that had nowhere to travel.
   */
  private poseFlinch(a: PoseArgs): void {
    if (a.leanX === 0 && a.leanZ === 0 && a.shudder === 0) return;
    const lx = a.leanX * ANIM.flinchLean;
    const lz = a.leanZ * ANIM.flinchLean;
    const sh = a.shudder * ANIM.shudderAmp;

    _pose[BONE.HIPS * POSE_STRIDE + RZ] += lx * 0.45;
    _pose[BONE.HIPS * POSE_STRIDE + RX] += lz * 0.45;
    _pose[BONE.SPINE * POSE_STRIDE + RZ] += lx * 0.30;
    _pose[BONE.SPINE * POSE_STRIDE + RX] += lz * 0.35;
    _pose[BONE.CHEST * POSE_STRIDE + RZ] += lx * 0.55 + sh;
    _pose[BONE.CHEST * POSE_STRIDE + RX] += lz * 0.60;
    _pose[BONE.NECK * POSE_STRIDE + RZ] += lx * 0.60 - sh * 1.1;
    _pose[BONE.NECK * POSE_STRIDE + RX] += lz * 0.70;
    _pose[BONE.HEAD * POSE_STRIDE + RZ] += lx * 0.90 - sh * 2.2;
    _pose[BONE.HEAD * POSE_STRIDE + RX] += lz * 1.15;
    // Arms fly. A flinch you can only see in the torso reads as a wobble, not as an impact.
    for (const [u, l, side] of [
      [BONE.ARM_R, BONE.FORE_R, 1],
      [BONE.ARM_L, BONE.FORE_L, -1],
    ] as const) {
      _pose[u * POSE_STRIDE + RX] += lz * 0.8;
      _pose[u * POSE_STRIDE + RZ] += lx * 0.7 + side * sh * 1.6;
      _pose[l * POSE_STRIDE + RX] += lz * 0.5;
    }
  }

  // ── hitbox anchors, read straight off the posed rig ───────────────────────
  //
  // WHAT YOU SEE IS WHAT YOU HIT. These are derived from the SAME stepped bone matrices the
  // mesh is drawn with, not from a smooth parallel rig — so a head that is being held for five
  // frames is also being *aimed at* for those five frames. A hitbox that leads the drawing is
  // the single most infuriating bug a shooter can ship.
  //
  // Anything the combat agent needs beyond these six primitives comes off `this.rig` directly.

  /** Head sphere centre, in enemy-local space. Dead centre of the DRAWN cranium. */
  headPoint(out: Vector3): Vector3 {
    _local.set(0, HITBOX.headCenterY, HITBOX.headCenterZ);
    return this.rig.boneLocal(BONE.HEAD, _local, out);
  }

  /** Torso capsule, in enemy-local space. */
  torsoSegment(a: Vector3, b: Vector3): void {
    this.rig.bonePoint(BONE.HIPS, a);
    _local.set(0, HITBOX.torsoTopY, 0);
    this.rig.boneLocal(BONE.CHEST, _local, b);
  }

  /**
   * Limb capsule, in enemy-local space: shoulder→hand or hip→foot as ONE capsule. A capsule per
   * bone would be more accurate and would cost twice the ray tests for a target nobody is meant
   * to be sniping — limbs are the dismemberment surface, not a precision one. The combat agent
   * can build the per-bone version from `rig.boneSegment()` whenever that changes.
   * Returns false when the limb is already gone.
   */
  limbSegment(limb: number, a: Vector3, b: Vector3): boolean {
    if (this.severedLimb[limb]) return false;
    this.rig.bonePoint(LIMB_ROOT[limb] as number, a);
    this.rig.boneTip(LIMB_TIP[limb] as number, b);
    return true;
  }

  /** Local-space position of the joint a severed limb came off — where the ink spray belongs. */
  limbRootPoint(limb: number, out: Vector3): Vector3 {
    return this.rig.bonePoint(LIMB_ROOT[limb] as number, out);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.remove(this.hull);
    this.material.dispose();
    this.hullMaterial.dispose();
    this.prepassMaterial.dispose();
  }
}

/**
 * HEADLESS RIG HARNESS — objective facts about the skinned Shambler. No GL, no DOM, no browser.
 *
 * WHAT THIS PROVES (and nothing else — how it LOOKS is the human's job):
 *   skin      every vertex's weights sum to 1, every index is in range, and the blend band at
 *             each joint is measured rather than asserted
 *   seams     the maximum WEIGHT DISCONTINUITY across any mesh edge. This is the direct,
 *             numeric form of "joints gap": two ends of one edge bound to disjoint bones is
 *             exactly what tore BUILD 006's rigid parts apart, and it cannot happen here
 *             unless a weight solve is wrong.
 *   stretch   the maximum EDGE STRETCH across a sweep of extreme poses. A skinned surface
 *             redistributes; a broken one blows an edge out. Bounded stretch is the proof the
 *             silhouette stays closed.
 *   hitbox    does the head sphere match the DRAWN skull? Reported as coverage and overshoot.
 *   determ    same seed → byte-identical bone palette
 *   perf      pose + palette compose cost for 25 bodies, and heap growth over 20 000 poses
 *   budget    triangles and per-instance uniform footprint against the stated budget
 *
 * Run:  node tools/zombie.mjs [all|skin|seams|stretch|hitbox|determ|perf|budget]
 */

import { Vector3 } from 'three';
import './domstub';
import { Rng } from '@/core/rng';
import {
  BODY, BONE, BONE_COUNT, BONE_NAME, HITBOX, LIMB, SKEL, SURFACE, VARIANTS,
} from '@/game/enemies/defs';
import {
  BIND_LENGTH, BIND_POS, BIND_TAIL, PALETTE_VEC4S, SKIN_INFLUENCES, distanceToBone,
} from '@/game/enemies/rig';
import { EnemyBody, buildEnemyGeometry, type PoseArgs } from '@/game/enemies/body';

const args = process.argv.slice(2);
const want = (name: string): boolean => args.length === 0 || args[0] === 'all' || args.includes(name);
let failures = 0;

function ok(cond: boolean, label: string, detail = ''): void {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
}

function head(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 74 - title.length))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared: the geometry, and a body to pose.
// ─────────────────────────────────────────────────────────────────────────────

const geo = buildEnemyGeometry();
const bodyPos = geo.body.getAttribute('position');
const skinIdx = geo.body.getAttribute('aSkinIndex');
const skinWt = geo.body.getAttribute('aSkinWeight');
const hullPos = geo.hull.getAttribute('position');
const hullIdx = geo.hull.getAttribute('aSkinIndex');

function makeBody(seed: number, variant = 0): EnemyBody {
  const b = new EnemyBody(geo, VARIANTS[variant]!, 0x9ee600, 1);
  b.reseed(new Rng(seed), VARIANTS[variant]!);
  return b;
}

const POSE: PoseArgs = {
  gait: 0, speed01: 1, state: 'chase', windup01: 0, strike01: 0, climb01: 0,
  targetDist: 20, leanX: 0, leanZ: 0, shudder: 0, spawn01: 1, death01: 0,
};

function resetPose(): void {
  POSE.gait = 0; POSE.speed01 = 1; POSE.state = 'chase'; POSE.windup01 = 0;
  POSE.strike01 = 0; POSE.climb01 = 0; POSE.targetDist = 20;
  POSE.leanX = 0; POSE.leanZ = 0; POSE.shudder = 0; POSE.spawn01 = 1; POSE.death01 = 0;
}

/** The pose sweep every geometric test runs against — the extremes, not the average. */
interface Beat { name: string; apply: () => void }
const BEATS: Beat[] = [
  { name: 'bind', apply: () => { resetPose(); POSE.speed01 = 0; } },
  { name: 'walk 0.00', apply: () => { resetPose(); POSE.gait = 0.0; } },
  { name: 'walk 0.25', apply: () => { resetPose(); POSE.gait = 0.25; } },
  { name: 'walk 0.50', apply: () => { resetPose(); POSE.gait = 0.5; } },
  { name: 'walk 0.75', apply: () => { resetPose(); POSE.gait = 0.75; } },
  { name: 'reach', apply: () => { resetPose(); POSE.targetDist = 0.8; } },
  { name: 'windup', apply: () => { resetPose(); POSE.state = 'attack'; POSE.windup01 = 1; POSE.targetDist = 1.2; } },
  { name: 'strike', apply: () => { resetPose(); POSE.state = 'attack'; POSE.windup01 = 1; POSE.strike01 = 1; POSE.targetDist = 1.2; } },
  { name: 'climb hang', apply: () => { resetPose(); POSE.state = 'climb'; POSE.climb01 = 0.2; POSE.speed01 = 0; } },
  { name: 'climb plant', apply: () => { resetPose(); POSE.state = 'climb'; POSE.climb01 = 0.9; POSE.speed01 = 0; } },
  { name: 'death', apply: () => { resetPose(); POSE.state = 'death'; POSE.death01 = 1; } },
  { name: 'spawn', apply: () => { resetPose(); POSE.state = 'spawn'; POSE.spawn01 = 0.05; } },
  { name: 'flinch max', apply: () => { resetPose(); POSE.leanX = 0.58; POSE.leanZ = -0.58; POSE.shudder = 1; } },
];

// Skin a cage vertex on the CPU exactly as the shader does, so every geometric claim below is
// about the surface the GPU actually draws.
const _sv = new Vector3();
function skinVertex(body: EnemyBody, i: number, out: Vector3): Vector3 {
  out.set(0, 0, 0);
  const px = bodyPos.getX(i);
  const py = bodyPos.getY(i);
  const pz = bodyPos.getZ(i);
  const idx = [skinIdx.getX(i), skinIdx.getY(i), skinIdx.getZ(i), skinIdx.getW(i)];
  const wt = [skinWt.getX(i), skinWt.getY(i), skinWt.getZ(i), skinWt.getW(i)];
  for (let k = 0; k < SKIN_INFLUENCES; k++) {
    const w = wt[k]!;
    if (w === 0) continue;
    const o = (idx[k]! | 0) * 12;
    const d = body.rig.data;
    _sv.set(
      d[o]! * px + d[o + 1]! * py + d[o + 2]! * pz + d[o + 3]!,
      d[o + 4]! * px + d[o + 5]! * py + d[o + 6]! * pz + d[o + 7]!,
      d[o + 8]! * px + d[o + 9]! * py + d[o + 10]! * pz + d[o + 11]!,
    );
    out.addScaledVector(_sv, w);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
if (want('budget')) {
  head('BUDGET');
  const perZombie = geo.triangles + geo.hullTriangles;
  console.log(`  body            ${geo.triangles} tris`);
  console.log(`  hull            ${geo.hullTriangles} tris`);
  console.log(`  per zombie      ${perZombie} tris, 2 draw calls`);
  console.log(`  25 alive        ${perZombie * 25} tris, 50 draw calls`);
  console.log(`  cage vertices   ${geo.skinVertices} (skin solved once, shared by the whole horde)`);
  console.log(`  bone palette    ${BONE_COUNT} bones × 3 vec4 rows = ${PALETTE_VEC4S} vec4 uniforms`);
  console.log(`  VRAM (shared)   ${((bodyPos.count * 17 + hullPos.count * 13) * 4 / 1024 / 1024).toFixed(2)} MB of attributes, built once at boot`);
  ok(perZombie * 25 <= 900000 - 400000, '25 alive fit the tri budget', `${perZombie * 25} ≤ 500000 (900k total − ~400k arena)`);
  ok(PALETTE_VEC4S <= 200, 'bone palette fits a 256-vec4 vertex uniform floor', `${PALETTE_VEC4S} vec4`);
}

// ─────────────────────────────────────────────────────────────────────────────
if (want('skin')) {
  head('SKIN BINDING');
  let badSum = 0;
  let badIdx = 0;
  let worstSum = 0;
  const influenceHist = [0, 0, 0, 0, 0];
  for (let i = 0; i < skinWt.count; i++) {
    const w = [skinWt.getX(i), skinWt.getY(i), skinWt.getZ(i), skinWt.getW(i)];
    const idx = [skinIdx.getX(i), skinIdx.getY(i), skinIdx.getZ(i), skinIdx.getW(i)];
    const sum = w[0]! + w[1]! + w[2]! + w[3]!;
    worstSum = Math.max(worstSum, Math.abs(sum - 1));
    if (Math.abs(sum - 1) > 1e-4) badSum++;
    let n = 0;
    for (let k = 0; k < 4; k++) {
      if (!Number.isInteger(idx[k]!) || idx[k]! < 0 || idx[k]! >= BONE_COUNT) badIdx++;
      if (w[k]! > 1e-4) n++;
    }
    influenceHist[n] = (influenceHist[n] ?? 0) + 1;
  }
  ok(badSum === 0, 'every vertex\'s weights sum to 1', `worst |Σw − 1| = ${worstSum.toExponential(2)}`);
  ok(badIdx === 0, 'every bone index is a valid integer in range');
  console.log(`  influences/vertex   1:${influenceHist[1]}  2:${influenceHist[2]}  3:${influenceHist[3]}  4:${influenceHist[4]}`);

  // The hull's attributes must be byte-identical to the body's, vertex for vertex — that is the
  // whole reason both are expanded from one cage. If they ever diverge the outline slides off.
  let hullMismatch = 0;
  for (let i = 0; i < hullPos.count; i++) {
    if (hullPos.getX(i) !== bodyPos.getX(i) || hullPos.getY(i) !== bodyPos.getY(i)
      || hullPos.getZ(i) !== bodyPos.getZ(i) || hullIdx.getX(i) !== skinIdx.getX(i)) {
      hullMismatch++;
    }
  }
  ok(hullMismatch === 0, 'hull vertex i IS body vertex i (same cage, same skin)', `${hullPos.count} verts`);

  // BLEND BAND: how far either side of a joint the surface is genuinely shared between the two
  // bones. Too wide and the limb bows like a hose; zero and we are back to rigid parts.
  console.log('  blend band (metres of surface shared 20–80% between a bone and its parent):');
  for (const [child, parent] of [
    [BONE.FORE_R, BONE.ARM_R], [BONE.SHIN_R, BONE.THIGH_R], [BONE.HEAD, BONE.NECK],
    [BONE.NECK, BONE.CHEST], [BONE.ARM_R, BONE.CLAV_R], [BONE.FOOT_R, BONE.SHIN_R],
  ] as const) {
    let lo = Infinity;
    let hi = -Infinity;
    let shared = 0;
    for (let i = 0; i < skinWt.count; i++) {
      let wc = 0;
      let wp = 0;
      for (let k = 0; k < 4; k++) {
        const bi = [skinIdx.getX(i), skinIdx.getY(i), skinIdx.getZ(i), skinIdx.getW(i)][k]!;
        const w = [skinWt.getX(i), skinWt.getY(i), skinWt.getZ(i), skinWt.getW(i)][k]!;
        if (bi === child) wc = w;
        if (bi === parent) wp = w;
      }
      if (wc < 0.2 || wc > 0.8 || wp < 0.05) continue;
      shared++;
      const y = bodyPos.getY(i);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    const band = shared > 0 ? hi - lo : 0;
    const bone = BIND_LENGTH[child] ?? 0;
    console.log(
      `    ${BONE_NAME[child]!.padEnd(8)}↔${BONE_NAME[parent]!.padEnd(8)} `
      + `${band.toFixed(3)} m over a ${bone.toFixed(3)} m bone  (${shared} verts)`,
    );
    ok(shared > 0, `  ${BONE_NAME[child]} blends into ${BONE_NAME[parent]}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
if (want('seams')) {
  head('SEAMS — weight discontinuity across mesh edges');
  console.log('  BUILD 006\'s rigid parts had NO shared edges across a joint at all: the two');
  console.log('  sides of an elbow were separate boxes, which is why bending one opened a hole.');
  console.log('  Here every joint is crossed by real edges, and this measures how violently the');
  console.log('  binding changes along them. 0 = rigid seam impossible; 2 = a full tear.');
  // The body geometry is non-indexed: every 3 consecutive verts are a triangle, so its 3 edges
  // are exactly the surface's edges (duplicated, which is fine for a maximum).
  let sum = 0;
  let n = 0;
  const top: { d: number; y: number }[] = [];
  const wOf = (i: number, out: Float64Array): void => {
    out.fill(0);
    for (let k = 0; k < 4; k++) {
      const bi = [skinIdx.getX(i), skinIdx.getY(i), skinIdx.getZ(i), skinIdx.getW(i)][k]! | 0;
      const w = [skinWt.getX(i), skinWt.getY(i), skinWt.getZ(i), skinWt.getW(i)][k]!;
      out[bi] = (out[bi] ?? 0) + w;
    }
  };
  const wa = new Float64Array(BONE_COUNT);
  const wb = new Float64Array(BONE_COUNT);
  for (let t = 0; t < bodyPos.count; t += 3) {
    for (let e = 0; e < 3; e++) {
      wOf(t + e, wa);
      wOf(t + ((e + 1) % 3), wb);
      let d = 0;
      for (let b = 0; b < BONE_COUNT; b++) d += Math.abs((wa[b] ?? 0) - (wb[b] ?? 0));
      sum += d;
      n++;
      top.push({ d, y: bodyPos.getY(t + e) });
    }
  }
  top.sort((a, b) => b.d - a.d);
  const worst = top[0]?.d ?? 0;
  console.log(`  mean L1 weight change per edge  ${(sum / n).toFixed(4)}`);
  console.log(`  worst 5                         ${top.slice(0, 5).map((x) => `${x.d.toFixed(2)}@y${x.y.toFixed(2)}`).join('  ')}`);
  // 2.0 is a FULL tear (disjoint bone sets either side of one edge). Anything short of that is
  // a crease, and creases are correct where the anatomy has one — the ankle inside a boot is
  // rigid, and so is the jaw hinge. The thing that would actually break the silhouette is an
  // edge blowing out under pose, which `stretch` measures directly.
  ok(worst < 1.8, 'no edge crosses a full binding tear', `worst ${worst.toFixed(3)} < 1.8`);
}

// ─────────────────────────────────────────────────────────────────────────────
if (want('stretch')) {
  head('STRETCH — edge length under the pose sweep');
  console.log('  A skinned surface REDISTRIBUTES; a broken one blows an edge out. Bounded');
  console.log('  stretch across every extreme pose is the numeric form of "the silhouette');
  console.log('  stays closed". Reported as posed length ÷ bind length.');
  const body = makeBody(0x1234);
  const a = new Vector3();
  const b = new Vector3();
  // Bind lengths first.
  const bindLen = new Float64Array(bodyPos.count);
  for (let t = 0; t < bodyPos.count; t += 3) {
    for (let e = 0; e < 3; e++) {
      const i = t + e;
      const j = t + ((e + 1) % 3);
      bindLen[i] = Math.hypot(
        bodyPos.getX(j) - bodyPos.getX(i),
        bodyPos.getY(j) - bodyPos.getY(i),
        bodyPos.getZ(j) - bodyPos.getZ(i),
      );
    }
  }
  let globalWorst = 0;
  let globalMaxLen = 0;
  let nan = 0;
  for (const beat of BEATS) {
    beat.apply();
    body.pose(POSE);
    let worst = 0;
    let maxLen = 0;
    for (let t = 0; t < bodyPos.count; t += 3) {
      for (let e = 0; e < 3; e++) {
        const i = t + e;
        const j = t + ((e + 1) % 3);
        const L0 = bindLen[i] ?? 0;
        if (L0 < 1e-5) continue;
        skinVertex(body, i, a);
        skinVertex(body, j, b);
        if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) { nan++; continue; }
        const L1 = a.distanceTo(b);
        worst = Math.max(worst, L1 / L0);
        maxLen = Math.max(maxLen, L1);
      }
    }
    globalWorst = Math.max(globalWorst, worst);
    globalMaxLen = Math.max(globalMaxLen, maxLen);
    console.log(`    ${beat.name.padEnd(13)} worst stretch ×${worst.toFixed(3)}   longest edge ${maxLen.toFixed(3)} m`);
  }
  ok(nan === 0, 'no NaN anywhere in the skinned surface', `${nan} bad vertices`);
  // THE BOUND IS DERIVED, NOT PICKED. Linear blend skinning stretches the OUTSIDE of a bend by
  // about `1 + r·θ/w`, where r is the limb radius, θ the joint angle and w the blend band. The
  // worst joint in the whole vocabulary is the climb's folded elbow: r = 0.098, θ ≈ 1.7 rad,
  // w = 0.136 m → ×2.22 expected. Anything under ~×2.6 is LBS behaving; a tear is unbounded.
  ok(globalWorst < 2.6, 'no edge tears under any pose', `worst ×${globalWorst.toFixed(3)} < 2.6 expected ×2.2`);
  ok(globalMaxLen < 0.40, 'no edge shoots off under any pose', `longest posed edge ${globalMaxLen.toFixed(3)} m`);

  // …and the same with a limb shot off, which is the one place a collapsed bone could produce
  // a degenerate normal and a hull triangle stretching to the horizon.
  body.sever(LIMB.ARM_R);
  resetPose();
  POSE.gait = 0.3;
  body.pose(POSE);
  let severNan = 0;
  let severMax = 0;
  for (let i = 0; i < bodyPos.count; i++) {
    skinVertex(body, i, a);
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) severNan++;
    severMax = Math.max(severMax, a.length());
  }
  ok(severNan === 0, 'severed arm produces no NaN', `max |v| = ${severMax.toFixed(2)} m`);
  ok(severMax < 6, 'severed arm produces no runaway vertex', `max |v| = ${severMax.toFixed(2)} m`);
}

// ─────────────────────────────────────────────────────────────────────────────
if (want('hitbox')) {
  head('HITBOX vs THE DRAWING — "understandable hitboxes"');
  const body = makeBody(0x2222);
  resetPose();
  body.pose(POSE);

  // Static, data-only read numbers first.
  const headW = Math.max(...SURFACE.head.map((r) => r.u)) * 2;
  const headH = SURFACE.head[SURFACE.head.length - 1]!.y - SURFACE.head[1]!.y;
  const neckW = SURFACE.torso[SURFACE.torso.length - 1]!.u * 2;
  const chestW = Math.max(...SURFACE.torso.map((r) => r.u)) * 2;
  const shoulderW = (SURFACE.armX + (SURFACE.arm[1]!.u)) * 2;
  console.log(`  drawn skull      ${headW.toFixed(3)} m wide × ${headH.toFixed(3)} m tall`);
  console.log(`  head hitbox      ${(HITBOX.headRadius * 2).toFixed(3)} m sphere`);
  console.log(`  sphere / skull   ${((HITBOX.headRadius * 2) / headW * 100 - 100).toFixed(1)}% larger  (BUILD 006: +59.3%)`);
  console.log(`  neck             ${neckW.toFixed(3)} m  →  head is ${(headW / neckW).toFixed(2)}× the neck`);
  console.log(`  chest            ${chestW.toFixed(3)} m  →  head is ${(headW / chestW * 100).toFixed(0)}% of the torso width`);
  console.log(`  shoulder span    ${shoulderW.toFixed(3)} m`);

  // Now the real question: does the sphere contain the DRAWN head, and only the drawn head?
  const centre = new Vector3();
  body.headPoint(centre);
  const v = new Vector3();
  // Cage vertex ranges: torso, head, brow, jaw are regions 0..3 in build order, but the merged
  // buffer is expanded, so classify by bone weight instead — a vertex is "head" when the HEAD
  // or JAW bone owns the majority of it.
  const weightOn = (i: number, bone: number): number => {
    let w = 0;
    for (let k = 0; k < 4; k++) {
      const bi = [skinIdx.getX(i), skinIdx.getY(i), skinIdx.getZ(i), skinIdx.getW(i)][k]! | 0;
      if (bi === bone) w += [skinWt.getX(i), skinWt.getY(i), skinWt.getZ(i), skinWt.getW(i)][k]!;
    }
    return w;
  };
  let cranIn = 0;
  let cranOut = 0;
  let cranMaxOut = 0;
  let jawIn = 0;
  let jawTotal = 0;
  let bodyIn = 0;
  const bodyInBones = new Set<string>();
  // …and the tight sphere the cranium ACTUALLY needs, so `HITBOX.headRadius` is a measurement
  // and not a guess. Ritter's algorithm is overkill for a blob; centroid + max radius is the
  // number a player experiences ("can I hit the middle of the head from any angle").
  const cent = new Vector3();
  let cranN = 0;
  for (let i = 0; i < bodyPos.count; i++) {
    if (weightOn(i, BONE.HEAD) <= 0.6) continue;
    skinVertex(body, i, v);
    cent.add(v);
    cranN++;
  }
  cent.multiplyScalar(1 / Math.max(1, cranN));
  let tight = 0;
  for (let i = 0; i < bodyPos.count; i++) {
    skinVertex(body, i, v);
    const d = v.distanceTo(centre);
    const wc = weightOn(i, BONE.HEAD);
    const wj = weightOn(i, BONE.JAW);
    if (wc > 0.6) {
      tight = Math.max(tight, v.distanceTo(cent));
      if (d <= HITBOX.headRadius) cranIn++;
      else { cranOut++; cranMaxOut = Math.max(cranMaxOut, d - HITBOX.headRadius); }
    } else if (wj > 0.6) {
      jawTotal++;
      if (d <= HITBOX.headRadius) jawIn++;
    } else if (wc + wj + weightOn(i, BONE.NECK) < 0.1 && d <= HITBOX.headRadius) {
      // The NECK is deliberately not counted: a neck shot landing as a crit is correct, and
      // it is the whole reason the neck is drawn as a thin readable column in the first place.
      bodyIn++;
      let dom = -1;
      let dw = 0;
      for (let k = 0; k < 4; k++) {
        const w = [skinWt.getX(i), skinWt.getY(i), skinWt.getZ(i), skinWt.getW(i)][k]!;
        if (w > dw) { dw = w; dom = [skinIdx.getX(i), skinIdx.getY(i), skinIdx.getZ(i), skinIdx.getW(i)][k]! | 0; }
      }
      bodyInBones.add(BONE_NAME[dom] ?? String(dom));
    }
  }
  const cover = cranIn / Math.max(1, cranIn + cranOut);
  console.log(`  CRANIUM surface inside the sphere       ${(cover * 100).toFixed(1)}%  (${cranIn}/${cranIn + cranOut})`);
  console.log(`  worst cranium overshoot                 ${cranMaxOut.toFixed(3)} m`);
  console.log(`  JAW surface inside the sphere           ${(jawIn / Math.max(1, jawTotal) * 100).toFixed(1)}%  (a hanging jaw is not a crit)`);
  console.log(`  NON-head surface inside the sphere      ${bodyIn} verts ${bodyIn ? `on ${[...bodyInBones].join(',')}` : ''} (0 = the sphere never steals a body shot)`);
  console.log(`  tight sphere the cranium needs          r=${tight.toFixed(3)} m at local y=${(cent.y).toFixed(3)}`);
  ok(cranMaxOut < 0.10, 'nothing on the cranium sticks far outside the sphere', `${cranMaxOut.toFixed(3)} m`);

  // ── THE METRIC THAT ACTUALLY DECIDES WHETHER A HEADSHOT FEELS FAIR ──────────────────────
  // A sphere inscribed in a box covers the box's face centres and not its corners, so "% of
  // the 3-D surface inside the sphere" is a number about geometry, not about aiming. The
  // player never sees the surface; they see the SILHOUETTE, and they aim at the middle of it.
  // So: project the drawn head onto the view plane from eight azimuths and ask how much of
  // that 2-D shape the sphere's disc covers, and by how much the shape overhangs it.
  console.log('  projected (what the player aims at), 8 azimuths:');
  let worstCover = 1;
  let worstOver = 0;
  const proj = new Vector3();
  for (let az = 0; az < 8; az++) {
    const th = (az / 8) * Math.PI * 2;
    const dirX = Math.sin(th);
    const dirZ = Math.cos(th);
    // basis perpendicular to the view direction: right = (cos, 0, -sin), up = (0,1,0)
    const rx = Math.cos(th);
    const rz = -Math.sin(th);
    // AREA-WEIGHTED, per triangle. Counting vertices weights the brow slab (many verts, small
    // area) as heavily as the whole cranium and produced a number about tessellation instead of
    // about aiming — the first pass read 69% for a head that was visually almost entirely
    // inside the sphere.
    let covered = 0;
    let tot = 0;
    let over = 0;
    for (let t = 0; t < bodyPos.count; t += 3) {
      if (weightOn(t, BONE.HEAD) <= 0.6) continue;
      let cu = 0;
      let cv = 0;
      const pu: number[] = [];
      const pv: number[] = [];
      for (let k = 0; k < 3; k++) {
        skinVertex(body, t + k, v);
        proj.copy(v).sub(centre);
        const u2 = proj.x * rx + proj.z * rz;
        const v2 = proj.y;
        pu.push(u2);
        pv.push(v2);
        cu += u2 / 3;
        cv += v2 / 3;
        over = Math.max(over, Math.max(0, Math.hypot(u2, v2) - HITBOX.headRadius));
      }
      const area = Math.abs(
        (pu[1]! - pu[0]!) * (pv[2]! - pv[0]!) - (pu[2]! - pu[0]!) * (pv[1]! - pv[0]!),
      ) * 0.5;
      tot += area;
      if (Math.hypot(cu, cv) <= HITBOX.headRadius) covered += area;
    }
    const c = covered / Math.max(1e-9, tot);
    worstCover = Math.min(worstCover, c);
    worstOver = Math.max(worstOver, over);
    if (az % 2 === 0) {
      console.log(`    az ${String(Math.round(th * 180 / Math.PI)).padStart(3)}°  ${(c * 100).toFixed(1)}% of the drawn head is inside the disc, overhang ${over.toFixed(3)} m  (dir ${dirX.toFixed(2)},${dirZ.toFixed(2)})`);
    }
  }
  console.log(`  worst azimuth: ${(worstCover * 100).toFixed(1)}% covered, ${worstOver.toFixed(3)} m overhang`);
  ok(worstCover > 0.90, 'from every angle the sphere covers the head you can see');
  ok(worstOver < 0.05, 'and never leaves more than 5 cm of head outside it', `${worstOver.toFixed(3)} m`);
  // How much TORSO the head sphere steals, across the whole variation space rather than one
  // roll — the head lolls up to 30° (`headTilt`), and at the extreme the sphere brushes the
  // shoulder it is lolling onto. Bounded and reported rather than assumed away.
  let worstSteal = 0;
  let worstSeed = 0;
  for (let sd = 0; sd < 24; sd++) {
    const z = makeBody(sd * 7717 + 11, sd % 3);
    resetPose();
    z.pose(POSE);
    const c2 = new Vector3();
    z.headPoint(c2);
    let steal = 0;
    let tot2 = 0;
    for (let i = 0; i < bodyPos.count; i++) {
      const w = weightOn(i, BONE.HEAD) + weightOn(i, BONE.JAW) + weightOn(i, BONE.NECK);
      if (w > 0.1) continue;
      tot2++;
      skinVertex(z, i, v);
      if (v.distanceTo(c2) <= HITBOX.headRadius) steal++;
    }
    const f = steal / Math.max(1, tot2);
    if (f > worstSteal) { worstSteal = f; worstSeed = sd; }
  }
  console.log(`  worst TORSO surface stolen by the head sphere, over 24 rolls  ${(worstSteal * 100).toFixed(2)}%  (roll ${worstSeed})`);
  // ⚠ THRESHOLD RAISED 1% → 2.5% BY THE COMBAT AGENT. Not a loosened gate — the sphere it
  // measures deliberately changed. `HITBOX.headRadius` is now the SOLVED minimum enclosing
  // sphere of the drawn skull (R 0.220 @ y 0.100, 100% coverage; the 0.195 @ 0.135 this check
  // was written against contained only 70.1% of it — measured in `tools/combat.mjs hitbox`).
  // Fitting the skull moved the centre 35 mm down as well as growing the radius, so the sphere
  // now reaches the trapezius. That overlap is intended and is CoD's own behaviour: the neck
  // and the trap are headshot surface, and they are exactly what a train shows you as it walks
  // away. Measured 1.52% of non-head/neck surface at the worst of 24 rolls.
  ok(worstSteal < 0.025, 'the head sphere never steals a meaningful amount of body', `${(worstSteal * 100).toFixed(2)}% < 2.5%`);

  // Limb capsules must contain the limb they are named after.
  const a = new Vector3();
  const b = new Vector3();
  for (const limb of [LIMB.ARM_R, LIMB.LEG_R] as const) {
    body.limbSegment(limb, a, b);
    const r = limb < 2 ? HITBOX.armRadius : HITBOX.legRadius;
    const bones = limb < 2
      ? [BONE.ARM_R, BONE.FORE_R, BONE.HAND_R]
      : [BONE.THIGH_R, BONE.SHIN_R, BONE.FOOT_R];
    let n = 0;
    let hit = 0;
    for (let i = 0; i < bodyPos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) {
        const bi = [skinIdx.getX(i), skinIdx.getY(i), skinIdx.getZ(i), skinIdx.getW(i)][k]! | 0;
        if (bones.indexOf(bi) >= 0) w += [skinWt.getX(i), skinWt.getY(i), skinWt.getZ(i), skinWt.getW(i)][k]!;
      }
      if (w < 0.7) continue;
      n++;
      skinVertex(body, i, v);
      // point→segment distance
      const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
      const apx = v.x - a.x, apy = v.y - a.y, apz = v.z - a.z;
      const l2 = abx * abx + aby * aby + abz * abz;
      const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / l2));
      const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
      if (Math.hypot(dx, dy, dz) <= r * 1.35) hit++;
    }
    const name = limb < 2 ? 'arm ' : 'leg ';
    console.log(`  ${name}capsule (r=${r}) contains ${(hit / n * 100).toFixed(1)}% of its own surface`);
    ok(hit / n > 0.72, `  ${name}capsule matches the drawn limb`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
if (want('determ')) {
  head('DETERMINISM');
  const a = makeBody(0xbeef, 1);
  const b = makeBody(0xbeef, 1);
  resetPose();
  POSE.gait = 0.37;
  POSE.targetDist = 3;
  a.pose(POSE);
  b.pose(POSE);
  let diff = 0;
  for (let i = 0; i < a.rig.data.length; i++) if (a.rig.data[i] !== b.rig.data[i]) diff++;
  ok(diff === 0, 'same seed → byte-identical bone palette', `${a.rig.data.length} floats`);

  const c = makeBody(0xbeef1, 1);
  c.pose(POSE);
  let varied = 0;
  for (let i = 0; i < a.rig.data.length; i++) if (a.rig.data[i] !== c.rig.data[i]) varied++;
  ok(varied > a.rig.data.length * 0.5, 'a different seed is a genuinely different body', `${varied} floats differ`);

  // Bone-length variation is the new silhouette lever — measure that it actually moves.
  let minH = Infinity;
  let maxH = -Infinity;
  let minArm = Infinity;
  let maxArm = -Infinity;
  const p = new Vector3();
  const q = new Vector3();
  for (let s = 0; s < 400; s++) {
    const z = makeBody(s * 7919 + 3, s % 3);
    resetPose();
    z.pose(POSE);
    z.rig.bonePoint(BONE.HEAD, p);
    minH = Math.min(minH, p.y);
    maxH = Math.max(maxH, p.y);
    z.rig.boneSegment(LIMB.ARM_R === 0 ? BONE.ARM_R : BONE.ARM_R, p, q);
    z.rig.bonePoint(BONE.ARM_R, p);
    z.rig.boneTip(BONE.HAND_R, q);
    const reach = p.distanceTo(q);
    minArm = Math.min(minArm, reach);
    maxArm = Math.max(maxArm, reach);
  }
  console.log(`  head height over 400 rolls   ${minH.toFixed(3)} … ${maxH.toFixed(3)} m  (spread ${(maxH - minH).toFixed(3)})`);
  console.log(`  arm reach over 400 rolls     ${minArm.toFixed(3)} … ${maxArm.toFixed(3)} m  (spread ${(maxArm - minArm).toFixed(3)})`);
  ok(maxH - minH > 0.15, 'bone-length variation moves the head height');
  ok(maxArm - minArm > 0.25, 'bone-length variation moves the arm reach');
}

// ─────────────────────────────────────────────────────────────────────────────
if (want('perf')) {
  head('PERFORMANCE — pose + palette compose');
  const bodies: EnemyBody[] = [];
  for (let i = 0; i < 25; i++) bodies.push(makeBody(i * 131 + 1, i % 3));
  resetPose();
  // warm
  for (let k = 0; k < 500; k++) for (const b of bodies) { POSE.gait = (k % 60) / 60; b.pose(POSE); }

  const N = 2000;
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < N; k++) {
    POSE.gait = (k % 60) / 60;
    for (const b of bodies) b.pose(POSE);
  }
  const t1 = process.hrtime.bigint();
  const perTick = Number(t1 - t0) / 1e6 / N;
  console.log(`  25 bodies, one 12 Hz pose tick   ${perTick.toFixed(4)} ms`);
  console.log(`  …at 12 Hz that is               ${(perTick * 12).toFixed(3)} ms per SECOND of wall clock`);
  console.log(`  …i.e. per 60 fps frame          ${(perTick * 12 / 60).toFixed(4)} ms`);
  ok(perTick < 1.0, '25 bodies pose in under 1 ms per tick');

  // Allocation: the pose path must be allocation-free or a horde GCs mid-fight.
  if (typeof globalThis.gc === 'function') (globalThis.gc as () => void)();
  const before = process.memoryUsage().heapUsed;
  for (let k = 0; k < 20000; k++) {
    POSE.gait = (k % 60) / 60;
    for (const b of bodies) b.pose(POSE);
  }
  if (typeof globalThis.gc === 'function') (globalThis.gc as () => void)();
  const after = process.memoryUsage().heapUsed;
  const grew = (after - before) / 1024;
  console.log(`  heap growth over 500 000 poses   ${grew.toFixed(1)} KB`);
  ok(grew < 512, 'pose() does not allocate', `${grew.toFixed(1)} KB`);
}

// ─────────────────────────────────────────────────────────────────────────────
if (want('bind')) {
  head('BIND POSE');
  for (let b = 0; b < BONE_COUNT; b++) {
    const p = BIND_POS[b]!;
    const t = BIND_TAIL[b]!;
    console.log(
      `  ${String(b).padStart(2)} ${BONE_NAME[b]!.padEnd(8)} `
      + `head (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})  `
      + `len ${(BIND_LENGTH[b] ?? 0).toFixed(3)}  r ${SKEL[b]!.radius.toFixed(3)}  `
      + `tail (${t.x.toFixed(3)}, ${t.y.toFixed(3)}, ${t.z.toFixed(3)})`,
    );
  }
  const crown = BIND_POS[BONE.HEAD]!.y + 0.30;
  console.log(`  crown ${crown.toFixed(3)} m vs BODY.height ${BODY.height} m`);
  ok(Math.abs(crown - BODY.height) < 0.10, 'the drawn body matches the collision capsule height');
  // Nothing may bind to nothing.
  const v = new Vector3();
  let orphan = 0;
  for (let b = 0; b < BONE_COUNT; b++) {
    v.copy(BIND_POS[b]!).lerp(BIND_TAIL[b]!, 0.5);
    if (distanceToBone(b, v) > 1e-6) orphan++;
  }
  ok(orphan === 0, 'every bone segment is well-formed');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

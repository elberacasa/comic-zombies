/**
 * HEADLESS WEAPON-FIT HARNESS — the two spatial contracts and the L:H ceiling, measured on the
 * REAL built geometry. No GL, no DOM, no browser.  Run:  node tools/gunfit.mjs
 *
 * It calls `Viewmodel.build()` under the DOM stub and reads the merged part geometries straight
 * off the scene graph, so every number below comes out of `buildGunGeometry` itself rather than
 * out of a re-implementation that can drift from it. The pose walk is a copy of
 * `assertClearance`'s (which is dev-only and therefore silent in a production bundle).
 *
 * WHAT IT PROVES
 *   table     each weapon's drawn L, H and L:H, and reach / swayed reach / near for all seven
 *             poses x five sway corners x the flourishes, with the binding part named
 *   ceiling   the legal DRAWN z window a profile may put geometry in, swept over `restDz`, and
 *             the height floor the builder's hard-coded grip/heel/hammer impose on every gun
 *   dcSweep   holds the DRAWN gun constant (rescales every authored z by 0.62/dc) and sweeps
 *             `depthCompress`, which is the only honest way to ask what that field costs
 *
 * It mutates the REDLINE profile object in memory for the sweep and restores it afterwards.
 * Nothing here is imported by the game.
 */
import { Euler, Group, Matrix4, Quaternion, Vector3, type BufferGeometry } from 'three';
import { installDomStub } from './domstub';

installDomStub();

import { CAMERA, MOVE, WEAPON } from '@/game/tuning';
import { WEAPON_MODELS } from '@/game/weapons/models';
import type { GunProfile } from '@/game/weapons/models';
import { Viewmodel } from '@/game/weapons/viewmodel';

const V = WEAPON.view;
const DEG2RAD = Math.PI / 180;

const NAMES = [
  'vm-hand', 'vm-frame', 'vm-polymer', 'vm-slide', 'vm-steel', 'vm-sights',
  'vm-accent', 'vm-accent-slide', 'vm-trim', 'vm-mag', 'vm-core',
] as const;
interface Parts { [k: string]: BufferGeometry }

function collect(): Map<string, Parts> {
  installDomStub();
  const vm = new Viewmodel();
  vm.build(new Group());
  const out = new Map<string, Parts>();
  for (const m of WEAPON_MODELS) {
    const g = vm.root.getObjectByName(`vm-${m.profile.id}`);
    if (!g) continue;
    const parts: Parts = {};
    g.traverse((o) => {
      const anyO = o as { name: string; geometry?: BufferGeometry };
      if (anyO.geometry && (NAMES as readonly string[]).includes(anyO.name)) {
        parts[anyO.name] = anyO.geometry;
      }
    });
    out.set(m.profile.id, parts);
  }
  return out;
}

interface Box { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
function newBox(): Box {
  return { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9 };
}
function grow(b: Box, geo: BufferGeometry): void {
  const a = geo.getAttribute('position');
  if (!a) return;
  for (let i = 0; i < a.count; i++) {
    const x = a.getX(i); const y = a.getY(i); const z = a.getZ(i);
    if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
    if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
  }
}

// ── the pose table, copied from assertClearance ────────────────────────────────────────────
interface Pose {
  name: string; x: number; y: number; z: number;
  pitchDeg: number; yawDeg: number; rollDeg: number;
  slideZ?: number; magY?: number; canFlourish?: boolean;
}
const SWAY_CORNERS: readonly (readonly [number, number])[] = [
  [0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1],
];
const SWAY_ROLL_FROM_YAW = -0.55;

function aimSocket(p: GunProfile): Vector3 {
  return new Vector3(0, p.sight.lineY, p.sight.rearZ * p.depthCompress);
}
function adsOffset(s: Vector3): { x: number; y: number; z: number } {
  return { x: -s.x, y: -s.y, z: -V.adsSightDistance - s.z };
}

function poses(adsX: number, adsY: number, adsZ: number, restDz: number): Pose[] {
  const kick = V.clearanceKickBudget;
  const rest: Pose = {
    name: 'rest', x: V.restX, y: V.restY, z: V.restZ + restDz,
    pitchDeg: V.restPitchDeg, yawDeg: V.restYawDeg, rollDeg: V.restRollDeg, canFlourish: true,
  };
  const ads: Pose = { name: 'ads', x: adsX, y: adsY, z: adsZ, pitchDeg: 0, yawDeg: 0, rollDeg: 0 };
  return [
    rest, ads,
    {
      name: 'sprint', x: V.sprintX, y: V.sprintY, z: V.restZ + restDz + V.sprintZ,
      pitchDeg: V.sprintPitchDeg, yawDeg: V.sprintYawDeg, rollDeg: V.sprintRollDeg,
    },
    {
      name: 'reload', x: rest.x, y: rest.y - V.reloadDropY, z: rest.z + V.reloadPushZ,
      pitchDeg: rest.pitchDeg + V.reloadPitchDeg, yawDeg: rest.yawDeg,
      rollDeg: rest.rollDeg + V.reloadRollDeg, magY: -V.reloadMagDrop, canFlourish: true,
    },
    {
      name: 'equip', x: rest.x, y: rest.y + V.equipDropY, z: rest.z,
      pitchDeg: rest.pitchDeg, yawDeg: rest.yawDeg, rollDeg: rest.rollDeg + V.equipRollDeg,
    },
    {
      name: 'rest+recoil+land',
      x: rest.x, y: rest.y + V.kickUp * kick - V.landDipMax, z: rest.z + V.kickBack * kick,
      pitchDeg: rest.pitchDeg + V.kickPitchDeg * kick,
      yawDeg: rest.yawDeg + V.kickYawDeg * kick,
      rollDeg: rest.rollDeg - V.kickRollDeg * kick,
      slideZ: 0.020 * V.depthCompress,
    },
    {
      name: 'ads+recoil',
      x: ads.x, y: ads.y + V.kickUp * kick * V.kickAdsMult,
      z: ads.z + V.kickBack * kick * V.kickAdsMult,
      pitchDeg: V.kickPitchDeg * kick * V.kickAdsMult,
      yawDeg: V.kickYawDeg * kick * V.kickAdsMult,
      rollDeg: -V.kickRollDeg * kick * V.kickAdsMult,
      slideZ: 0.020 * V.depthCompress,
    },
  ];
}

interface Row { pose: string; reach: number; swayed: number; near: number; nearPart: string }

function walk(parts: Parts, p: GunProfile): Row[] {
  const socket = aimSocket(p);
  const ads = adsOffset(socket);
  const sway = V.swayPosMax;
  const rows: Row[] = [];
  const _euler = new Euler(0, 0, 0, 'YXZ');
  const _q = new Quaternion();
  const _p = new Vector3();
  const _m = new Matrix4();
  const _probe = new Vector3();
  const _one = new Vector3(1, 1, 1);
  for (const pose of poses(ads.x, ads.y, ads.z, p.restDz ?? 0)) {
    let reach = 0; let swayed = 0; let near = Infinity; let nearPart = '';
    const flourishes = pose.canFlourish ? [0, 1, -1] : [0];
    const over = V.clearanceSwayOvershoot;
    for (const s of SWAY_CORNERS) {
      for (const f of flourishes) {
        const swayYaw = V.swayRotMaxDeg * s[1] * over;
        const exPitch = V.swayRotMaxDeg * s[0] * over - V.activeSnapDeg * 0.4 * Math.abs(f);
        const exRoll = swayYaw * SWAY_ROLL_FROM_YAW
          + V.bobRollDeg * (s[1] < 0 ? -1 : 1) + V.activeSnapDeg * f;
        _euler.set(
          (pose.pitchDeg + exPitch) * DEG2RAD,
          (pose.yawDeg + swayYaw) * DEG2RAD,
          (pose.rollDeg + exRoll) * DEG2RAD,
          'YXZ',
        );
        _q.setFromEuler(_euler);
        _p.set(pose.x, pose.y, pose.z);
        _m.compose(_p, _q, _one);
        for (const name of NAMES) {
          const geo = parts[name];
          if (!geo) continue;
          const childZ = (name === 'vm-slide' || name === 'vm-sights' || name === 'vm-accent-slide'
            || name === 'vm-steel') ? (pose.slideZ ?? 0) : 0;
          const childY = name === 'vm-mag' ? (pose.magY ?? 0) : 0;
          const a = geo.getAttribute('position');
          if (!a) continue;
          for (let i = 0; i < a.count; i++) {
            _probe.set(a.getX(i), a.getY(i) + childY, a.getZ(i) + childZ).applyMatrix4(_m);
            reach = Math.max(reach, Math.hypot(_probe.x, _probe.z));
            swayed = Math.max(swayed, Math.hypot(Math.abs(_probe.x) + sway, _probe.z));
            if (-_probe.z < near) { near = -_probe.z; nearPart = name; }
          }
        }
      }
    }
    rows.push({ pose: pose.name, reach, swayed, near, nearPart });
  }
  return rows;
}

function report(all: Map<string, Parts>): void {
  console.log(`budgets: reach <= ${V.maxEyeDistance}  swayed <= ${MOVE.radius}  near >= ${V.nearClearance}  (CAMERA.near ${CAMERA.near})`);
  for (const m of WEAPON_MODELS) {
    const p = m.profile;
    const parts = all.get(p.id);
    if (!parts) continue;
    const gun = newBox();
    const hand = newBox();
    for (const n of NAMES) {
      const geo = parts[n];
      if (!geo) continue;
      if (n === 'vm-hand') grow(hand, geo); else grow(gun, geo);
    }
    const L = gun.maxZ - gun.minZ;
    const H = gun.maxY - gun.minY;
    const rows = walk(parts, p);
    let wr = 0; let ws = 0; let wn = Infinity; let wnp = ''; let wnPose = '';
    for (const r of rows) {
      wr = Math.max(wr, r.reach); ws = Math.max(ws, r.swayed);
      if (r.near < wn) { wn = r.near; wnp = r.nearPart; wnPose = r.pose; }
    }
    const bad = wr > V.maxEyeDistance || ws > MOVE.radius || wn < V.nearClearance;
    console.log(
      `\n${p.id.padEnd(11)} dc ${p.depthCompress.toFixed(2)}  restDz ${(p.restDz ?? 0).toFixed(3)}` +
      `   L ${(L * 1000).toFixed(1)} mm  H ${(H * 1000).toFixed(1)} mm  L:H ${(L / H).toFixed(3)}` +
      `   ${bad ? '*** FAIL ***' : 'ok'}`,
    );
    console.log(
      `   gun z [${gun.minZ.toFixed(4)}, ${gun.maxZ.toFixed(4)}]  y [${gun.minY.toFixed(4)}, ${gun.maxY.toFixed(4)}]` +
      `   hand z [${hand.minZ.toFixed(4)}, ${hand.maxZ.toFixed(4)}]`,
    );
    console.log(`   worst  reach ${wr.toFixed(4)}  swayed ${ws.toFixed(4)}  near ${wn.toFixed(4)} (${wnPose}, ${wnp})`);
    for (const r of rows) {
      console.log(
        `     ${r.pose.padEnd(17)} reach ${r.reach.toFixed(4)} (swayed ${r.swayed.toFixed(4)}) near ${r.near.toFixed(4)} [${r.nearPart}]`,
      );
    }
  }
}

// ── THE CEILING PROBE ──────────────────────────────────────────────────────────────────────
// A candidate vertex in DRAWN gun space (i.e. the space the merged attributes are already in,
// post-MODEL_SCALE, post-depthCompress). Asks: what z window may a profile put geometry in?
function poseMats(restDz: number, p: GunProfile): { m: Matrix4; slide: number }[] {
  const socket = aimSocket(p);
  const ads = adsOffset(socket);
  const out: { m: Matrix4; slide: number }[] = [];
  for (const pose of poses(ads.x, ads.y, ads.z, restDz)) {
    const flourishes = pose.canFlourish ? [0, 1, -1] : [0];
    const over = V.clearanceSwayOvershoot;
    for (const s of SWAY_CORNERS) {
      for (const f of flourishes) {
        const swayYaw = V.swayRotMaxDeg * s[1] * over;
        const exPitch = V.swayRotMaxDeg * s[0] * over - V.activeSnapDeg * 0.4 * Math.abs(f);
        const exRoll = swayYaw * SWAY_ROLL_FROM_YAW
          + V.bobRollDeg * (s[1] < 0 ? -1 : 1) + V.activeSnapDeg * f;
        const e = new Euler(
          (pose.pitchDeg + exPitch) * DEG2RAD,
          (pose.yawDeg + swayYaw) * DEG2RAD,
          (pose.rollDeg + exRoll) * DEG2RAD,
          'YXZ',
        );
        const m = new Matrix4().compose(
          new Vector3(pose.x, pose.y, pose.z), new Quaternion().setFromEuler(e), new Vector3(1, 1, 1),
        );
        out.push({ m, slide: pose.slideZ ?? 0 });
      }
    }
  }
  return out;
}

function probeOK(mats: { m: Matrix4 }[], x: number, y: number, z: number, front: boolean): boolean {
  const v = new Vector3();
  for (const { m } of mats) {
    v.set(x, y, z).applyMatrix4(m);
    if (front) {
      if (Math.hypot(v.x, v.z) > V.maxEyeDistance) return false;
      if (Math.hypot(Math.abs(v.x) + V.swayPosMax, v.z) > MOVE.radius) return false;
    } else if (-v.z < V.nearClearance) return false;
  }
  return true;
}

function windowFor(restDz: number, p: GunProfile, halfW: number, loY: number, hiY: number):
{ front: number; rear: number } {
  const mats = poseMats(restDz, p);
  const xs = [-halfW, 0, halfW];
  const ys = [loY, (loY + hiY) * 0.5, hiY];
  const all = (z: number, front: boolean): boolean => {
    for (const x of xs) for (const y of ys) if (!probeOK(mats, x, y, z, front)) return false;
    return true;
  };
  // Front: most negative legal z (reach + swayed).
  let lo = -0.60; let hi = 0.0;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) * 0.5; if (all(mid, true)) hi = mid; else lo = mid; }
  const front = hi;
  // Rear: most positive legal z (near plane).
  let rlo = -0.10; let rhi = 0.40;
  for (let i = 0; i < 40; i++) { const mid = (rlo + rhi) * 0.5; if (all(mid, false)) rlo = mid; else rhi = mid; }
  return { front, rear: rlo };
}

/** Does the builder's own fixed hand assembly still pass at this restDz? */
function handOK(parts: Parts, restDz: number, p: GunProfile): { near: number; reach: number } {
  const mats = poseMats(restDz, p);
  const geo = parts['vm-hand']!;
  const a = geo.getAttribute('position');
  const v = new Vector3();
  let near = Infinity; let reach = 0;
  for (const { m } of mats) {
    for (let i = 0; i < a.count; i++) {
      v.set(a.getX(i), a.getY(i), a.getZ(i)).applyMatrix4(m);
      near = Math.min(near, -v.z);
      reach = Math.max(reach, Math.hypot(Math.abs(v.x) + V.swayPosMax, v.z));
    }
  }
  return { near, reach };
}

function ceiling(all: Map<string, Parts>): void {
  const p = WEAPON_MODELS.find((m) => m.profile.id === 'redline')!.profile;
  const parts = all.get('redline')!;
  console.log('\n══ CEILING PROBE — legal DRAWN z window for profile geometry ══');
  console.log('  receiver probe 28 mm wide (y 0.014…0.050) · stock probe 26 mm wide (y 0.014…0.046)');
  let best = { L: 0, dz: 0, front: 0, rear: 0 };
  for (let dz = -0.070; dz <= 0.0301; dz += 0.002) {
    const h = handOK(parts, dz, p);
    const legal = h.near >= V.nearClearance && h.reach <= MOVE.radius;
    const f = windowFor(dz, p, 0.014, 0.014, 0.050);
    const r = windowFor(dz, p, 0.013, 0.014, 0.046);
    const L = r.rear - f.front;
    if (legal && L > best.L) best = { L, dz, front: f.front, rear: r.rear };
    if (Math.abs(Math.round(dz * 1000)) % 10 === 0) {
      console.log(`  restDz ${dz.toFixed(3)}  front ${f.front.toFixed(4)}  rear ${r.rear.toFixed(4)}  window ${(L * 1000).toFixed(1)} mm   hand near ${h.near.toFixed(4)} ${legal ? '' : '  ILLEGAL'}`);
    }
  }
  console.log(`  BEST  restDz ${best.dz.toFixed(3)}  z [${best.front.toFixed(4)}, ${best.rear.toFixed(4)}]  = ${(best.L * 1000).toFixed(1)} mm`);

  // How much does the FRONT probe's width cost? A muzzle can is 18–22 mm across, not 28.
  for (const hw of [0.006, 0.009, 0.014, 0.019]) {
    const f = windowFor(0, p, hw, 0.014, 0.050);
    console.log(`  front bound at halfWidth ${(hw * 1000).toFixed(0)} mm (restDz 0): ${f.front.toFixed(4)}`);
  }

  // ── THE HEIGHT FLOOR, and what it is made of ──────────────────────────────────────────
  const pol = parts['vm-polymer']!;
  const ap = pol.getAttribute('position');
  let lowest = 1e9;
  for (let i = 0; i < ap.count; i++) lowest = Math.min(lowest, ap.getY(i));
  const acc = parts['vm-accent']!;
  const aa = acc.getAttribute('position');
  let hammerTop = -1e9;
  for (let i = 0; i < aa.count; i++) hammerTop = Math.max(hammerTop, aa.getY(i));
  console.log(`\n══ HEIGHT FLOOR ══  polymer bottom (grip/heel) ${lowest.toFixed(4)}  ·  accent top (hammer) ${hammerTop.toFixed(4)}`);
  console.log(`  floor H = ${((hammerTop - lowest) * 1000).toFixed(1)} mm   → L:H ceiling ${(best.L / (hammerTop - lowest)).toFixed(2)}`);
  for (const k of [1.0, 0.85, 0.7, 0.6, 0.5]) {
    const h = (hammerTop - lowest * k);
    console.log(`  hand assembly at ${(k * 100).toFixed(0)}% of its Y size → H ${(h * 1000).toFixed(1)} mm → L:H ${(best.L / h).toFixed(2)}`);
  }
}

// ── IS depthCompress NOW FREE? Rescale every authored z by 0.62/dc and the DRAWN gun should be
//    bit-identical. Before the hand exemption it could not be: the hand scaled with it.
const Z_KEYS = new Set(['z', 'd', 'len', 'rearZ', 'frontZ', 'bladeD', 'step']);
function scaleZ(o: unknown, k: number): void {
  if (!o || typeof o !== 'object') return;
  for (const [key, val] of Object.entries(o as Record<string, unknown>)) {
    if (typeof val === 'number') {
      if (Z_KEYS.has(key)) (o as Record<string, number>)[key] = val * k;
    } else scaleZ(val, k);
  }
}

function dcSweep(): void {
  console.log('\n══ IS depthCompress FREE NOW? (redline, every authored z rescaled by 0.62/dc) ══');
  const base = WEAPON_MODELS.find((m) => m.profile.id === 'redline')!.profile;
  const orig = JSON.parse(JSON.stringify(base)) as GunProfile;
  for (const dc of [0.62, 0.80, 1.00, 1.20]) {
    // restore, then rescale
    const p = base as unknown as Record<string, unknown>;
    for (const key of Object.keys(orig)) p[key] = JSON.parse(JSON.stringify((orig as never)[key]));
    scaleZ(base, 0.62 / dc);
    (base as { depthCompress: number }).depthCompress = dc;
    const parts = collect().get('redline')!;
    const gun = newBox(); const hand = newBox();
    for (const n of NAMES) {
      const g = parts[n];
      if (!g) continue;
      if (n === 'vm-hand') grow(hand, g); else grow(gun, g);
    }
    const rows = walk(parts, base);
    let wr = 0; let ws = 0; let wn = Infinity;
    for (const r of rows) { wr = Math.max(wr, r.reach); ws = Math.max(ws, r.swayed); wn = Math.min(wn, r.near); }
    console.log(
      `  dc ${dc.toFixed(2)}  drawn L ${((gun.maxZ - gun.minZ) * 1000).toFixed(1)} mm  H ${((gun.maxY - gun.minY) * 1000).toFixed(1)} mm` +
      `  L:H ${((gun.maxZ - gun.minZ) / (gun.maxY - gun.minY)).toFixed(3)}` +
      `   reach ${wr.toFixed(4)}  swayed ${ws.toFixed(4)}  near ${wn.toFixed(4)}` +
      `   ${wr <= V.maxEyeDistance && ws <= MOVE.radius && wn >= V.nearClearance ? 'ok' : '*** FAIL ***'}`,
    );
  }
  // restore
  const p = base as unknown as Record<string, unknown>;
  for (const key of Object.keys(orig)) p[key] = JSON.parse(JSON.stringify((orig as never)[key]));
}

const ALL = collect();
report(ALL);
ceiling(ALL);
dcSweep();

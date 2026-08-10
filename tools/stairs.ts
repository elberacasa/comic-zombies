/**
 * THE STAIR HARNESS — proves, from node, that the player can walk up every vertical route in
 * the arena, that walking off a ledge still falls, and that the horde climbs the same stairs.
 *
 *     node tools/stairs.mjs                 # everything
 *     node tools/stairs.mjs stairs          # just the staircase table
 *     node tools/stairs.mjs ledges
 *     node tools/stairs.mjs horde           # 15 bodies up the east stair
 *     node tools/stairs.mjs soak            # 25 bodies x 120 s
 *
 * IT EXITS NON-ZERO WHEN A ROUTE FAILS. Wire it into whatever gate you like; the point is that
 * "I can't go upstairs" can never again be discovered by a human at the end of a milestone.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ROUTES, and where each one comes from in `world/arena.ts` §6.6. Coordinates are
 *  duplicated here on purpose: if someone moves a staircase and does not move it here, this
 *  harness fails loudly instead of quietly testing empty air (every case asserts that its
 *  start point and its top actually exist in the collision world before it walks).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { installDomStub } from './domstub';

installDomStub();

const { Vector3 } = await import('three');
const {
  FIXED, buildRig, yawToward, overlapAt, groundAt, ENEMY_SHAPE, pad, padLeft,
} = await import('./rig');
const { MOVE, ENEMY } = await import('@/game/tuning');
const { NAV } = await import('@/game/enemies/defs');

type V3 = InstanceType<typeof Vector3>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Arena constants, mirrored from `world/arena.ts`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const STOREY = 3.4;
const DECK_Y = STOREY * 2;          // 6.8
const DECK2_Y = STOREY * 4;         // 13.6
const BLOCK_C = 42;
const FIRE_X = -26.4;               // west.cx + west.w/2 + 2.6
const DOCK_Z = 26.4;                // south.cz - south.d/2 - 0.6 - 2.0

interface StairCase {
  id: string;
  /** Foot of the flight, in world metres. */
  bottom: [number, number, number];
  /** Head of the flight. */
  top: [number, number, number];
  /** How far behind the foot the walk starts. */
  back: number;
  note: string;
}

const STAIRS: readonly StairCase[] = [
  { id: 'plaza_stair', bottom: [17.4, 0, 22.4], top: [27.4, DECK_Y, 22.4], back: 2.2,
    note: 'LOOP D — plaza up to the east gantry' },
  { id: 'east_stair', bottom: [58.5, 0, -28.0], top: [58.5, DECK_Y, -44.0], back: 2.2,
    note: 'LOOP D — ring boulevard up to the NE market roof' },
  { id: 'fire_escape_1', bottom: [FIRE_X, 0, -16.0], top: [FIRE_X, DECK_Y, -8.0], back: 2.2,
    note: 'LOOP F — west fire escape, flight 1' },
  { id: 'fire_escape_2', bottom: [FIRE_X, DECK_Y, -5.2], top: [FIRE_X, DECK2_Y, 2.8], back: 2.0,
    note: 'LOOP F — west fire escape, flight 2 (off a half-landing)' },
  { id: 'west_high_s', bottom: [FIRE_X, DECK_Y, 28.0], top: [FIRE_X, DECK2_Y, 19.4], back: 2.0,
    note: 'LOOP F — south flight back up to the 13.6 m catwalk' },
  { id: 'west_low_s', bottom: [FIRE_X, 0, 39.4], top: [FIRE_X, DECK_Y, 30.8], back: 2.2,
    note: 'LOOP F — south-west street mouth up to the half-landing' },
  { id: 'dock_steps_w', bottom: [-22.5, 0, DOCK_Z], top: [-19.5, 1.2, DOCK_Z], back: 2.2,
    note: 'LOOP G — west end of the south loading dock' },
  { id: 'dock_steps_e', bottom: [10.5, 0, DOCK_Z], top: [7.5, 1.2, DOCK_Z], back: 2.2,
    note: 'LOOP G — east end of the south loading dock' },
  // Not a ramp: the dais is three DISCRETE 0.19 m collide-boxes on top of a 0.45 m plinth, so
  // it is the only vertical route in the arena that can only be climbed by the step-up path.
  { id: 'plaza_dais', bottom: [0, 0, 9.4], top: [0, 0.9, 4.0], back: 2.2,
    note: 'plaza monument — DISCRETE steps, the pure step-up case' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────

const rig = buildRig(0x1234);
const { world, controller, input, enemies, ctx } = rig;

const mode = process.argv[2] ?? 'all';
const want = (m: string): boolean => mode === 'all' || mode === m;
let failures = 0;

function hr(title: string): void {
  console.log(`\n${'─'.repeat(96)}\n${title}\n${'─'.repeat(96)}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE STAIRCASE TABLE
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface StairResult {
  id: string;
  startY: number;
  targetY: number;
  peakY: number;
  endY: number;
  seconds: number;
  arrived: boolean;
  /** Metres of horizontal progress made along the flight axis. */
  along: number;
  runLen: number;
}

function place(x: number, y: number, z: number, yaw: number): void {
  const p = new Vector3(x, y, z);
  controller.teleport(p, yaw);
  input.reset();
  for (let i = 0; i < 40; i++) rig.stepPlayer(yaw); // settle onto the floor
}

function walkStair(s: StairCase, seconds = 12): StairResult {
  const [bx, by, bz] = s.bottom;
  const [tx, ty, tz] = s.top;
  const dx = tx - bx;
  const dz = tz - bz;
  const runLen = Math.hypot(dx, dz);
  const ux = dx / runLen;
  const uz = dz / runLen;

  const sx = bx - ux * s.back;
  const sz = bz - uz * s.back;
  const g = groundAt(world, sx, sz, by + 1.4);
  if (g === null) throw new Error(`[stairs] no ground at the foot of ${s.id}`);

  // Aim three metres past the head of the flight so the walk finishes ON the upper deck.
  const yaw = yawToward(sx, sz, tx + ux * 3, tz + uz * 3);
  place(sx, g + 0.05, sz, yaw);

  const startY = controller.position.y;
  input.moveAxis.y = 1;

  // ARRIVAL IS STRICT: the head of a `stairRun` ramp sits 0.12 m proud of the deck it serves,
  // so a body that has genuinely finished the flight is AT the deck height, not near it. The
  // walk continues for a moment after arrival so the reported `endY` is where you end up
  // standing, not the instant you first clear the lip.
  const steps = Math.round(seconds / FIXED);
  let peakY = startY;
  let used = 0;
  let settle = -1;
  for (let i = 0; i < steps; i++) {
    rig.stepPlayer(yaw);
    used++;
    if (controller.position.y > peakY) peakY = controller.position.y;
    if (settle < 0 && controller.position.y >= ty - 0.05) settle = used;
    if (settle >= 0 && used - settle > 60) break;
  }
  input.moveAxis.y = 0;

  const along = (controller.position.x - sx) * ux + (controller.position.z - sz) * uz;
  return {
    id: s.id,
    startY,
    targetY: ty,
    peakY,
    endY: controller.position.y,
    seconds: (settle < 0 ? used : settle) * FIXED,
    arrived: peakY >= ty - 0.05,
    along,
    runLen: runLen + s.back,
  };
}

function stairTable(): void {
  hr('PLAYER · EVERY STAIRCASE IN THE ARENA (walk forward, no jump, no sprint)');
  console.log(
    `${pad('route', 16)}${padLeft('startY', 8)}${padLeft('topY', 8)}${padLeft('peakY', 8)}${padLeft('endY', 8)}` +
    `${padLeft('along/run', 12)}${padLeft('t(s)', 7)}  verdict`,
  );
  for (const s of STAIRS) {
    const r = walkStair(s);
    if (!r.arrived) failures++;
    console.log(
      `${pad(r.id, 16)}${padLeft(r.startY.toFixed(2), 8)}${padLeft(r.targetY.toFixed(2), 8)}` +
      `${padLeft(r.peakY.toFixed(2), 8)}${padLeft(r.endY.toFixed(2), 8)}` +
      `${padLeft(`${r.along.toFixed(1)}/${r.runLen.toFixed(1)}`, 12)}` +
      `${padLeft(r.seconds.toFixed(2), 7)}  ${r.arrived ? 'CLIMBED' : '*** STUCK ***'}`,
    );
  }
}

/**
 * Ground height sampled along each flight's axis. This is the check that the coordinates above
 * still describe a real staircase: if someone moves a flight, the profile goes flat and you can
 * see it in one line instead of debugging a walk that mysteriously wanders off.
 */
function stairProfiles(): void {
  hr('ARENA · GROUND PROFILE ALONG EACH FLIGHT (collision world, not the visual steps)');
  for (const s of STAIRS) {
    const [bx, by, bz] = s.bottom;
    const [tx, ty, tz] = s.top;
    const dx = tx - bx;
    const dz = tz - bz;
    const run = Math.hypot(dx, dz);
    const ux = dx / run;
    const uz = dz / run;
    const cells: string[] = [];
    for (let d = -s.back; d <= run + 2.5; d += (run + s.back + 2.5) / 14) {
      const g = groundAt(world, bx + ux * d, bz + uz * d, Math.max(by, ty) + 3);
      cells.push(g === null ? ' -- ' : padLeft(g.toFixed(2), 5));
    }
    console.log(`${pad(s.id, 16)}${cells.join('')}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. LEDGES — walking off one must ALWAYS fall. Found by probing, not by hand, so the set
//    grows with the arena instead of going stale.
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface Ledge { x: number; z: number; y: number; dropTo: number; dx: number; dz: number; }

function findLedges(maxCount: number): Ledge[] {
  const found: Ledge[] = [];
  const R = 68;
  const STEP = 2.0;
  const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const feet = new Vector3();
  for (let x = -R; x <= R; x += STEP) {
    for (let z = -R; z <= R; z += STEP) {
      const g = groundAt(world, x, z, 60);
      if (g === null || g < 0.7) continue;
      feet.set(x, g, z);
      if (overlapAt(world, feet, MOVE.standHeight, MOVE.radius) > 1e-3) continue;
      for (const [dx, dz] of DIRS) {
        const ox = x + dx * 1.8;
        const oz = z + dz * 1.8;
        const g2 = groundAt(world, ox, oz, g + 1.0);
        const below = g2 === null ? -40 : g2;
        if (g - below < 0.9) continue;
        found.push({ x, z, y: g, dropTo: below, dx, dz });
        break;
      }
    }
  }
  // Spread the sample across the whole height range instead of taking 17 kerbs in a row.
  found.sort((a, b) => a.y - b.y);
  if (found.length <= maxCount) return found;
  const out: Ledge[] = [];
  for (let i = 0; i < maxCount; i++) {
    out.push(found[Math.floor((i * (found.length - 1)) / (maxCount - 1))] as Ledge);
  }
  return out;
}

function ledgeTest(): void {
  hr('PLAYER · WALKING OFF A LEDGE MUST FALL (the bug the mover was built for)');
  const ledges = findLedges(17);
  let fell = 0;
  console.log(`${pad('ledge', 26)}${padLeft('standY', 8)}${padLeft('floorY', 8)}${padLeft('endY', 8)}  verdict`);
  for (const L of ledges) {
    const yaw = yawToward(L.x, L.z, L.x + L.dx, L.z + L.dz);
    place(L.x, L.y + 0.05, L.z, yaw);
    input.moveAxis.y = 1;
    const steps = Math.round(3.61 / FIXED); // the same 3.61 s window the old measurement used
    for (let i = 0; i < steps; i++) rig.stepPlayer(yaw);
    input.moveAxis.y = 0;
    const endY = controller.position.y;
    const dropped = L.y - endY > 0.5;
    if (dropped) fell++; else failures++;
    console.log(
      `${pad(`(${L.x.toFixed(0)}, ${L.z.toFixed(0)}) d=${(L.y - L.dropTo).toFixed(1)}m`, 26)}` +
      `${padLeft(L.y.toFixed(2), 8)}${padLeft(L.dropTo.toFixed(2), 8)}${padLeft(endY.toFixed(2), 8)}` +
      `  ${dropped ? 'FELL' : '*** FLOATED ***'}`,
    );
  }
  console.log(`\n  ${fell} of ${ledges.length} ledges fell.`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE HORDE ON THE EAST STAIR
// ═════════════════════════════════════════════════════════════════════════════════════════════

function hordeStair(count = 15, seconds = 40): void {
  hr(`HORDE · ${count} BODIES UP THE EAST STAIR, PLAYER ON THE NE ROOF`);
  enemies.despawnAll();
  // Player parked on the roof. The controller is not driven here — the horde only reads
  // `ctx.player.position`, and a stationary target is the cleanest climb measurement.
  const roofY = groundAt(world, BLOCK_C, -BLOCK_C, 20) ?? DECK_Y;
  ctx.player.position.set(BLOCK_C, roofY + MOVE.standEye, -BLOCK_C);

  const spawn = new Vector3();
  const ids: Damageableish[] = [];
  for (let i = 0; i < count; i++) {
    const ox = ((i % 5) - 2) * 0.8;
    const oz = Math.floor(i / 5) * 1.2;
    spawn.set(58.5 + ox, 0.2, -26.0 + oz);
    const g = groundAt(world, spawn.x, spawn.z, 6) ?? 0;
    spawn.y = g + 0.05;
    const e = enemies.spawn('shambler', spawn, 1, 1);
    if (e) ids.push(e as Damageableish);
  }

  const steps = Math.round(seconds / FIXED);
  const arriveT = new Map<number, number>();
  let simMs = 0;
  for (let i = 0; i < steps; i++) {
    simMs += rig.stepHorde();
    const t = (i + 1) * FIXED;
    for (const e of ids) {
      if (arriveT.has(e.id)) continue;
      if (e.position.y >= DECK_Y - 0.4) arriveT.set(e.id, t);
    }
    if (arriveT.size === ids.length) break;
  }

  const times = [...arriveT.values()].sort((a, b) => a - b);
  console.log(`  spawned            ${ids.length}`);
  console.log(`  reached the roof   ${times.length} / ${ids.length}`);
  if (times.length) {
    console.log(`  first / median / last arrival   ` +
      `${times[0].toFixed(1)}s / ${times[times.length >> 1].toFixed(1)}s / ` +
      `${times[times.length - 1].toFixed(1)}s`);
  }
  const stragglers = ids.filter((e) => !arriveT.has(e.id));
  for (const e of stragglers) {
    console.log(`  STUCK  id=${e.id} at (${e.position.x.toFixed(1)}, ` +
      `${e.position.y.toFixed(2)}, ${e.position.z.toFixed(1)})`);
  }
  console.log(`  sim cost  ${(simMs / Math.max(1, Math.min(steps, steps))).toFixed(3)} ms/step ` +
    `for ${ids.length} bodies`);
  if (times.length < ids.length) failures++;
  enemies.despawnAll();
}

interface Damageableish { readonly id: number; readonly alive: boolean; readonly position: V3 }

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE SOAK — 25 bodies x 120 s. Zero inside geometry, zero stalled-while-chasing > 2 s.
// ═════════════════════════════════════════════════════════════════════════════════════════════

function soak(count: number, seconds: number, camp: boolean): void {
  hr(`HORDE · ${count} BODIES x ${seconds} s — ${camp ? 'PLAYER CAMPED ON THE NE ROOF' : 'PLAYER AT SPAWN'}`);
  enemies.despawnAll();

  if (camp) {
    const roofY = groundAt(world, BLOCK_C, -BLOCK_C, 20) ?? DECK_Y;
    ctx.player.position.set(BLOCK_C, roofY + MOVE.standEye, -BLOCK_C);
  } else {
    const s = world.playerSpawn.position;
    ctx.player.position.set(s.x, s.y + MOVE.standEye, s.z);
  }

  const spawn = new Vector3();
  const bodies: Damageableish[] = [];
  const edges = world.enemySpawns;
  for (let i = 0; i < count; i++) {
    const p = edges[i % edges.length] as V3;
    spawn.copy(p);
    if (world.findFreeSpawn(spawn, ENEMY_SHAPE.radius, ENEMY_SHAPE.height, spawn)) {
      const e = enemies.spawn('shambler', spawn, 1, 1);
      if (e) bodies.push(e as Damageableish);
    }
  }

  const steps = Math.round(seconds / FIXED);
  const last = new Map<number, V3>();
  const stallT = new Map<number, number>();
  const maxStall = new Map<number, number>();
  const insideIds = new Set<number>();
  let maxDepth = 0;
  let insideSamples = 0;
  let simMs = 0;
  const feet = new Vector3();
  for (const e of bodies) last.set(e.id, new Vector3().copy(e.position));

  for (let i = 0; i < steps; i++) {
    simMs += rig.stepHorde();
    // Sample at 20 Hz — enough to catch a 2 s stall, cheap enough not to dominate the run.
    if (i % 6 !== 0) continue;
    const dt = 6 * FIXED;
    for (const e of bodies) {
      if (!e.alive) continue;
      feet.set(e.position.x, e.position.y, e.position.z);
      const d = overlapAt(world, feet, ENEMY_SHAPE.height, ENEMY_SHAPE.radius);
      if (d > 0.12) { insideIds.add(e.id); insideSamples++; if (d > maxDepth) maxDepth = d; }

      const prev = last.get(e.id) as V3;
      const moved = Math.hypot(e.position.x - prev.x, e.position.z - prev.z);
      prev.copy(e.position);

      const dxp = ctx.player.position.x - e.position.x;
      const dzp = ctx.player.position.z - e.position.z;
      const dyp = ctx.player.position.y - e.position.y;
      const chasing = Math.hypot(dxp, dzp) > ENEMY.meleeRange
        || Math.abs(dyp) > ENEMY.verticalMeleeGate;
      if (chasing && moved < 0.02 * (dt / FIXED) * 0.5) {
        const t = (stallT.get(e.id) ?? 0) + dt;
        stallT.set(e.id, t);
        if (t > (maxStall.get(e.id) ?? 0)) maxStall.set(e.id, t);
      } else {
        stallT.set(e.id, 0);
      }
    }
  }

  let stalled = 0;
  let worstStall = 0;
  for (const [, t] of maxStall) {
    if (t > 2) stalled++;
    if (t > worstStall) worstStall = t;
  }
  console.log(`  bodies                    ${bodies.length}`);
  console.log(`  inside geometry           ${insideIds.size} bodies (${insideSamples} samples), worst overlap ${maxDepth.toFixed(2)} m`);
  console.log(`  stalled while chasing >2s ${stalled} bodies, worst single stall ${worstStall.toFixed(1)} s`);
  console.log(`  sim cost                  ${(simMs / steps).toFixed(3)} ms/step for ${bodies.length} bodies`);
  if (insideIds.size > 0 || stalled > 0) failures++;
  enemies.despawnAll();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════

console.log(`collision triangles ${world.triangleCount} · nav ${NAV.stepUp.toFixed(2)} m step-up · ` +
  `MOVE.stepHeight ${MOVE.stepHeight.toFixed(2)} m`);

if (want('profile')) stairProfiles();
if (want('stairs')) stairTable();
if (want('ledges')) ledgeTest();
if (want('horde')) hordeStair();
if (want('soak')) { soak(25, 120, false); soak(25, 120, true); }

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

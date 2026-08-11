/**
 * THE EMBEDDING PROBE — throwaway diagnostic for MAP_INTEGRITY §2.5.
 *
 * `tools/stairs.mjs soak` reports "N bodies inside geometry" but not HOW they got there. This
 * harness samples the same soak at EVERY fixed step (the soak samples every 6th) with each
 * body's OWN capsule, and classifies the step on which a body crosses from clean to embedded.
 *
 *     node tools/embed.mjs trace     # per-step entry classification + worst-body timeline
 *     node tools/embed.mjs ablate    # turn one mechanism off at a time, re-measure
 *     node tools/embed.mjs shape     # is the 0.12 m threshold measuring the right capsule?
 *
 * NOTHING IN src/ IS MODIFIED. Everything here is read off exported surfaces; the ablation pass
 * mutates the exported tuning objects in place, which is a harness-side experiment only.
 */

import { installDomStub } from './domstub';

installDomStub();

const { Vector3 } = await import('three');
const { buildRig, groundAt, pad, padLeft, FIXED } = await import('./rig');
const { MOVE, ENEMY } = await import('@/game/tuning');
const { NAV, BODY, SCHED } = await import('@/game/enemies/defs');
const { crowdInto } = await import('@/game/enemies/ai');
const { COUNTERS, resetCounters } = await import('@/game/motion/mover');

type V3 = InstanceType<typeof Vector3>;

/** The subset of the (unexported) `Enemy` class this probe reads. Structural, so no src import. */
interface Probe {
  readonly id: number;
  readonly alive: boolean;
  readonly position: V3;
  readonly velocity: V3;
  readonly desired: V3;
  readonly push: V3;
  readonly radius: number;
  readonly height: number;
  readonly grounded: boolean;
  readonly state: string;
  readonly distToPlayer: number;
  readonly wedgeTrips: number;
  readonly navMode: boolean;
  readonly baseSpeed: number;
  readonly tier: number;
  readonly climbT: number;
  readonly climbDur: number;
  readonly climbFrom: V3;
  readonly climbTo: V3;
}

const BLOCK_C = 42;
const THRESH = 0.12;           // the soak's "inside geometry" bar
const MOVER_MAX_STEP = ENEMY.maxSubsteps * ENEMY.maxSubstepDistance; // 0.60 m — the mover's ceiling

const mode = process.argv[2] ?? 'trace';

function hr(t: string): void { console.log(`\n${'─'.repeat(100)}\n${t}\n${'─'.repeat(100)}`); }

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Measurement
// ═════════════════════════════════════════════════════════════════════════════════════════════

const _a = new Vector3();
const _b = new Vector3();
const _corr = new Vector3();
const _nom = new Vector3();

/**
 * Depth AND push-out direction for a capsule at `pos` (FEET). Same call the game's mover makes,
 * and the same one `tools/rig.ts::overlapAt` makes — but with the body's own radius/height
 * rather than the nominal BODY constants, because `spawn()` scales both per instance
 * (`service.ts:1372`) and the nominal capsule is not the one the solver moves.
 */
function probeDepth(world: WorldLike, pos: V3, height: number, radius: number, outCorr: V3): number {
  _a.set(pos.x, pos.y + radius, pos.z);
  _b.set(pos.x, pos.y + Math.max(height - radius, radius + 0.01), pos.z);
  const c = world.collideCapsule(_a, _b, radius);
  outCorr.copy(c.correction);
  return c.depth;
}

interface WorldLike {
  collideCapsule(a: V3, b: V3, r: number): { depth: number; correction: V3; normal: V3; grounded: boolean };
  readonly bounds: { min: V3; max: V3 };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The instrumented soak
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** One clean→embedded transition. */
interface Entry {
  id: number;
  step: number;
  depth: number;
  prevDepth: number;
  /** metres the body's feet moved on the step it went in. */
  disp: number;
  /** vertical share of that displacement. */
  dispY: number;
  stateBefore: string;
  stateAfter: string;
  grounded: boolean;
  speed: number;
  /** unit push-out direction the solver reports once embedded. */
  outX: number; outY: number; outZ: number;
  /** separation vector acting on this body on the step it went in (pre-step, from `crowdInto`). */
  sepMag: number;
  /** component of the (weighted) separation pointing INTO the wall. >0 = crowd pushed it in. */
  sepInward: number;
  /** same for the final steering heading and the actual velocity. */
  desiredInward: number;
  velInward: number;
  pushInward: number;
  x: number; y: number; z: number;
  /** Largest depenetration correction the mover made ANYWHERE this step, pre-clamp (COUNTERS). */
  stepWorstCorr: number;
  /** Corrections the mover refused to make in full this step (`maxCorrection` hit). */
  stepClamped: number;
  /** `wedgeTrips` before → after. A `rescueWedged` shows as (>=2 → 0). */
  wedgeBefore: number;
  wedgeAfter: number;
  cause: string;
}

/** One >2 s chase stall, the other half of the failing scoreboard. */
interface Stall {
  id: number;
  start: number;
  dur: number;
  x: number; y: number; z: number;
  state: string;
  navMode: boolean;
  wedgeTrips: number;
  distToPlayer: number;
  heightBelowPlayer: number;
  grounded: boolean;
  speed: number;
  baseSpeed: number;
  /** fraction of the stall spent embedded deeper than THRESH (own capsule). */
  embeddedFrac: number;
  /** fraction of the stall spent in the climb state. */
  climbFrac: number;
  /** deepest overlap seen at any point during the stall. */
  maxDepth: number;
}

interface Episode { id: number; start: number; end: number; maxDepth: number; climbSteps: number }

interface SoakOut {
  entries: Entry[];
  episodes: Episode[];
  stalls: Stall[];
  insideIds: Set<number>;
  insideStepSamples: number;
  totalBodySteps: number;
  maxDepth: number;
  /** The scoreboard exactly as `stairs.mjs` computes it — NOMINAL capsule, 20 Hz. */
  nomIds: Set<number>;
  nomSamples: number;
  nomMaxDepth: number;
  /** Biggest depenetration correction anywhere in the run, and how often one was clamped. */
  worstCorrection: number;
  clamped: number;
  /** The worst NOMINAL reading, and what the SAME body's own capsule said at the same instant. */
  nomWorstOwn: number;
  nomWorstR: number;
  nomWorstH: number;
  nomWorstAt: [number, number, number];
  /**
   * For the deepest 'solver' entry: how the solver's reported depth varies over a ±0.2 m box
   * around the position the body was standing CLEAN in one step earlier, at 2 cm resolution.
   * A smooth field means the body walked in; a cliff means `collideCapsule` changed its mind.
   */
  cliffMax: number;
  cliffOver1: number;
  cliffCells: number;
  cliffAt: [number, number, number];
  /** longest single substep any body's mover could have taken, metres. */
  worstSubstep: number;
  maxSpeed: number;
  climbBodySteps: number;
  /** body-steps embedded while in the climb state. */
  climbInsideSteps: number;
  /** how many bodies were already embedded on the first frame after spawn. */
  spawnEmbedded: number;
  /** decimated 20 Hz counts, so the numbers are comparable with `stairs.mjs soak`. */
  soakIds: Set<number>;
  soakSamples: number;
  soakMaxDepth: number;
}

function instrumentedSoak(seed: number, count: number, seconds: number, camp: boolean): SoakOut {
  const rig = buildRig(seed);
  const { world, enemies, ctx } = rig;
  const w = world as unknown as WorldLike;

  if (camp) {
    const roofY = groundAt(world, BLOCK_C, -BLOCK_C, 20) ?? 6.8;
    ctx.player.position.set(BLOCK_C, roofY + MOVE.standEye, -BLOCK_C);
  } else {
    const s = world.playerSpawn.position;
    ctx.player.position.set(s.x, s.y + MOVE.standEye, s.z);
  }

  const spawn = new Vector3();
  const edges = world.enemySpawns;
  for (let i = 0; i < count; i++) {
    const p = edges[i % edges.length] as V3;
    spawn.copy(p);
    if (world.findFreeSpawn(spawn, BODY.radius, BODY.height, spawn)) enemies.spawn('shambler', spawn, 1, 1);
  }

  const bodies = enemies.all as unknown as readonly Probe[];
  const n = bodies.length;

  // Per-body persistent trace state. Preallocated: this loop runs 28 800 × 25 times.
  const prevPos: V3[] = [];
  const preSep: V3[] = [];
  const preState: string[] = [];
  const preWedge: number[] = [];
  const prevDepth: number[] = [];
  const inside: boolean[] = [];
  const epStart: number[] = [];
  const epMax: number[] = [];
  const epClimb: number[] = [];
  const ids: number[] = [];
  // Stall bookkeeping, mirroring `stairs.mjs::soak` but at 120 Hz and with state attached.
  const stallSteps: number[] = [];
  const stallStart: number[] = [];
  const stallEmb: number[] = [];
  const stallClimb: number[] = [];
  const stallMaxD: number[] = [];
  for (let i = 0; i < n; i++) {
    prevPos.push(new Vector3().copy(bodies[i].position));
    preSep.push(new Vector3());
    preState.push(bodies[i].state);
    preWedge.push(0);
    prevDepth.push(0);
    inside.push(false);
    epStart.push(-1);
    epMax.push(0);
    epClimb.push(0);
    ids.push(bodies[i].id);
    stallSteps.push(0); stallStart.push(0); stallEmb.push(0); stallClimb.push(0); stallMaxD.push(0);
  }

  const out: SoakOut = {
    entries: [], episodes: [], stalls: [], insideIds: new Set(), insideStepSamples: 0,
    totalBodySteps: 0, maxDepth: 0, nomIds: new Set(), nomSamples: 0, nomMaxDepth: 0,
    worstCorrection: 0, clamped: 0, nomWorstOwn: 0, nomWorstR: 0, nomWorstH: 0,
    nomWorstAt: [0, 0, 0], cliffMax: 0, cliffOver1: 0, cliffCells: 0, cliffAt: [0, 0, 0],
    worstSubstep: 0, maxSpeed: 0, climbBodySteps: 0,
    climbInsideSteps: 0, spawnEmbedded: 0, soakIds: new Set(), soakSamples: 0, soakMaxDepth: 0,
  };
  const scan = new Vector3();

  const sep = new Vector3();
  const follow = new Vector3();
  const toPlayer = new Vector3();

  // Frame 0 — did `findFreeSpawn` put anybody inside something before a single step ran?
  for (let i = 0; i < n; i++) {
    const d = probeDepth(w, bodies[i].position, bodies[i].height, bodies[i].radius, _corr);
    prevDepth[i] = d;
    if (d > THRESH) { out.spawnEmbedded++; inside[i] = true; epStart[i] = 0; epMax[i] = d; }
  }

  const steps = Math.round(seconds / FIXED);
  for (let s = 0; s < steps; s++) {
    // ── PRE-STEP: what the crowd is doing to each body, before the service moves anything.
    for (let i = 0; i < n; i++) {
      const e = bodies[i];
      prevPos[i].copy(e.position);
      preState[i] = e.state;
      preWedge[i] = e.wedgeTrips;
      toPlayer.set(ctx.player.position.x - e.position.x, 0, ctx.player.position.z - e.position.z);
      const dl = toPlayer.length();
      if (dl > 1e-4) toPlayer.divideScalar(dl);
      crowdInto(sep, follow, e.position, i, e.distToPlayer, toPlayer,
        bodies as unknown as Parameters<typeof crowdInto>[6], n);
      preSep[i].copy(sep);
    }

    resetCounters();
    rig.stepHorde();
    const stepWorstCorr = COUNTERS.worstCorrection;
    const stepClamped = COUNTERS.clamped;
    if (stepWorstCorr > out.worstCorrection) out.worstCorrection = stepWorstCorr;
    out.clamped += stepClamped;

    // ── POST-STEP
    for (let i = 0; i < n; i++) {
      const e = bodies[i];
      if (!e.alive) continue;
      // `_alive` is spliced on death; nothing dies in this soak, but assert rather than assume,
      // because a shifted index silently turns "the body next door" into a 40 m teleport.
      if (e.id !== ids[i]) throw new Error(`[embed] _alive reordered at step ${s} slot ${i}`);
      out.totalBodySteps++;

      const d = probeDepth(w, e.position, e.height, e.radius, _corr);
      const dx = e.position.x - prevPos[i].x;
      const dy = e.position.y - prevPos[i].y;
      const dz = e.position.z - prevPos[i].z;
      const disp = Math.hypot(dx, dy, dz);
      const speed = e.velocity.length();
      if (speed > out.maxSpeed) out.maxSpeed = speed;
      // Longest substep the mover could have taken with this velocity (mirrors `moveBody`).
      const intended = speed * FIXED;
      const sub = intended / Math.max(1, Math.min(Math.ceil(intended / ENEMY.maxSubstepDistance), ENEMY.maxSubsteps));
      if (sub > out.worstSubstep) out.worstSubstep = sub;
      if (e.state === 'climb') out.climbBodySteps++;

      if (d > out.maxDepth) out.maxDepth = d;
      if (d > THRESH) {
        out.insideStepSamples++;
        out.insideIds.add(e.id);
        if (e.state === 'climb') out.climbInsideSteps++;
      }
      // The same 20 Hz decimation `stairs.mjs` uses, so this run is comparable with the scoreboard.
      if (s % 6 === 0) {
        if (d > THRESH) {
          out.soakSamples++; out.soakIds.add(e.id);
          if (d > out.soakMaxDepth) out.soakMaxDepth = d;
        }
        // …and the scoreboard's OWN probe, which uses the nominal BODY capsule for every body.
        const dn = probeDepth(w, e.position, BODY.height, BODY.radius, _nom);
        if (dn > THRESH) {
          out.nomSamples++; out.nomIds.add(e.id);
          if (dn > out.nomMaxDepth) {
            out.nomMaxDepth = dn;
            out.nomWorstOwn = d;                       // …what the REAL capsule said, same instant
            out.nomWorstR = e.radius; out.nomWorstH = e.height;
            out.nomWorstAt = [e.position.x, e.position.y, e.position.z];
          }
        }
      }

      // ── STALL, the scoreboard's other failing check. Same rule as `stairs.mjs::soak`
      //    (chasing, and moving less than 1 cm per 50 ms) but sampled every step.
      const dyp = ctx.player.position.y - e.position.y;
      const chasing = e.distToPlayer > ENEMY.meleeRange || Math.abs(dyp) > ENEMY.verticalMeleeGate;
      if (chasing && disp < 0.02 * 0.5) {
        if (stallSteps[i] === 0) {
          stallStart[i] = s; stallEmb[i] = 0; stallClimb[i] = 0; stallMaxD[i] = 0;
        }
        stallSteps[i]++;
        if (d > THRESH) stallEmb[i]++;
        if (e.state === 'climb') stallClimb[i]++;
        if (d > stallMaxD[i]) stallMaxD[i] = d;
      } else if (stallSteps[i] > 0) {
        if (stallSteps[i] * FIXED > 2) {
          out.stalls.push({
            id: e.id, start: stallStart[i], dur: stallSteps[i] * FIXED,
            x: e.position.x, y: e.position.y, z: e.position.z,
            state: e.state, navMode: e.navMode, wedgeTrips: e.wedgeTrips,
            distToPlayer: e.distToPlayer, heightBelowPlayer: dyp,
            grounded: e.grounded, speed, baseSpeed: e.baseSpeed,
            embeddedFrac: stallEmb[i] / stallSteps[i],
            climbFrac: stallClimb[i] / stallSteps[i],
            maxDepth: stallMaxD[i],
          });
        }
        stallSteps[i] = 0;
      }

      const nowInside = d > THRESH;
      if (nowInside && !inside[i]) {
        // ── ENTRY. Decide, from the step itself, which mechanism put it there.
        const len = _corr.length();
        const ox = len > 1e-9 ? _corr.x / len : 0;
        const oy = len > 1e-9 ? _corr.y / len : 0;
        const oz = len > 1e-9 ? _corr.z / len : 0;
        const sw = ENEMY.separationWeight;
        const sx = preSep[i].x * sw;
        const sz = preSep[i].z * sw;
        const sm = Math.hypot(sx, sz);

        // ── CAUSE, in the order the mechanisms can be told apart from the outside.
        //
        //   climb    — `stepClimb` owns the body and skips the mover entirely
        //   rescue   — `rescueWedged`→`placeAt` teleported it (wedgeTrips >= 2 collapsing to 0)
        //   solver   — the mover's OWN depenetration moved it further than the sweep ever could
        //              (the sweep ceiling is maxSubsteps × maxSubstepDistance; a correction is
        //              capped only by `maxCorrection`, and there are `iterations` of them)
        //   tunnel   — one substep longer than the body's radius
        //   walk     — an ordinary sub-centimetre step
        let cause: string;
        if (preState[i] === 'climb' || e.state === 'climb') cause = 'climb';
        else if (preWedge[i] >= ENEMY.wedgeRescueTrips && e.wedgeTrips === 0 && disp > MOVER_MAX_STEP) cause = 'rescue';
        else if (disp > MOVER_MAX_STEP && stepWorstCorr > MOVER_MAX_STEP) cause = 'solver';
        else if (disp > MOVER_MAX_STEP) cause = 'unattributed jump';
        else if (sub > e.radius) cause = 'tunnel';
        else if (disp < 1e-4) cause = 'static';                  // world came to it / solver flipped
        else cause = 'walk';

        out.entries.push({
          id: e.id, step: s, depth: d, prevDepth: prevDepth[i], disp, dispY: dy,
          stateBefore: preState[i], stateAfter: e.state, grounded: e.grounded, speed,
          outX: ox, outY: oy, outZ: oz,
          sepMag: sm,
          sepInward: sm > 1e-6 ? -((sx / sm) * ox + (sz / sm) * oz) : 0,
          desiredInward: -(e.desired.x * ox + e.desired.z * oz),
          velInward: -(e.velocity.x * ox + e.velocity.y * oy + e.velocity.z * oz),
          pushInward: -(e.push.x * ox + e.push.z * oz),
          x: e.position.x, y: e.position.y, z: e.position.z,
          stepWorstCorr, stepClamped, wedgeBefore: preWedge[i], wedgeAfter: e.wedgeTrips,
          cause,
        });
        // ── THE CLIFF TEST. For the deepest solver fling, scan the neighbourhood of the position
        //    the body was standing CLEAN in, one step earlier. `collideCapsule` is supposed to be
        //    a continuous field; if 2 cm away it reports metres, the fling is the solver changing
        //    its mind, not the body travelling.
        if (cause === 'solver' && d > out.cliffMax * 0 && disp > MOVER_MAX_STEP) {
          let mx = 0; let over = 0; let cells = 0;
          for (let gx = -10; gx <= 10; gx++) {
            for (let gz = -10; gz <= 10; gz++) {
              scan.set(prevPos[i].x + gx * 0.02, prevPos[i].y, prevPos[i].z + gz * 0.02);
              const dd = probeDepth(w, scan, e.height, e.radius, _nom);
              cells++;
              if (dd > 1.0) over++;
              if (dd > mx) mx = dd;
            }
          }
          if (mx > out.cliffMax) {
            out.cliffMax = mx; out.cliffOver1 = over; out.cliffCells = cells;
            out.cliffAt = [prevPos[i].x, prevPos[i].y, prevPos[i].z];
          }
        }
        inside[i] = true; epStart[i] = s; epMax[i] = d; epClimb[i] = 0;
      } else if (!nowInside && inside[i]) {
        out.episodes.push({ id: e.id, start: epStart[i], end: s, maxDepth: epMax[i], climbSteps: epClimb[i] });
        inside[i] = false;
      }
      if (inside[i]) {
        if (d > epMax[i]) epMax[i] = d;
        if (e.state === 'climb') epClimb[i]++;
      }
      prevDepth[i] = d;
    }
  }
  for (let i = 0; i < n; i++) {
    if (inside[i]) out.episodes.push({ id: bodies[i].id, start: epStart[i], end: steps, maxDepth: epMax[i], climbSteps: epClimb[i] });
  }
  enemies.despawnAll();
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Reporting
// ═════════════════════════════════════════════════════════════════════════════════════════════

function report(name: string, r: SoakOut): void {
  hr(name);
  console.log(`  stairs.mjs metric (NOMINAL cap)   ${r.nomIds.size} bodies, ${r.nomSamples} samples, worst ${r.nomMaxDepth.toFixed(2)} m`);
  console.log(`  same metric, EACH BODY'S capsule  ${r.soakIds.size} bodies, ${r.soakSamples} samples, worst ${r.soakMaxDepth.toFixed(2)} m`);
  console.log(`  every-step                        ${r.insideIds.size} bodies, ${r.insideStepSamples} / ${r.totalBodySteps} body-steps embedded, worst ${r.maxDepth.toFixed(2)} m`);
  console.log(`  worst depenetration correction    ${r.worstCorrection.toFixed(2)} m (mover maxCorrection 1.50) · clamped ${r.clamped} times`);
  if (r.nomMaxDepth > 0) {
    console.log(`  at the worst NOMINAL reading      nominal ${r.nomMaxDepth.toFixed(2)} m vs own ${r.nomWorstOwn.toFixed(2)} m ` +
      `(that body is r=${r.nomWorstR.toFixed(3)} h=${r.nomWorstH.toFixed(3)}, probe is r=${BODY.radius} h=${BODY.height}) ` +
      `at (${r.nomWorstAt[0].toFixed(1)}, ${r.nomWorstAt[1].toFixed(2)}, ${r.nomWorstAt[2].toFixed(1)})`);
  }
  if (r.cliffCells > 0) {
    console.log(`  solver field around a CLEAN spot  worst ${r.cliffMax.toFixed(2)} m within ±0.20 m of ` +
      `(${r.cliffAt[0].toFixed(1)}, ${r.cliffAt[1].toFixed(2)}, ${r.cliffAt[2].toFixed(1)}) · ` +
      `${r.cliffOver1}/${r.cliffCells} cells report over 1 m`);
  }
  console.log(`  embedded body-steps in CLIMB      ${r.climbInsideSteps} (${(100 * r.climbInsideSteps / Math.max(1, r.insideStepSamples)).toFixed(1)}% of embedded time)`);
  console.log(`  climb body-steps overall          ${r.climbBodySteps} (${(100 * r.climbBodySteps / Math.max(1, r.totalBodySteps)).toFixed(1)}% of all body-steps) — ` +
    `${(100 * r.climbInsideSteps / Math.max(1, r.climbBodySteps)).toFixed(1)}% of CLIMB TIME is spent inside geometry`);
  console.log(`  embedded on the first frame       ${r.spawnEmbedded} bodies`);
  console.log(`  worst single substep / radius     ${r.worstSubstep.toFixed(4)} m vs ${BODY.radius.toFixed(2)} m  · max body speed ${r.maxSpeed.toFixed(2)} m/s`);

  // ── ENTRY MECHANISMS
  const byCause = new Map<string, Entry[]>();
  for (const e of r.entries) {
    const a = byCause.get(e.cause);
    if (a) a.push(e); else byCause.set(e.cause, [e]);
  }
  console.log(`\n  ENTRY EVENTS (clean → embedded transitions): ${r.entries.length}`);
  console.log(`  ${pad('mechanism', 12)}${padLeft('n', 5)}${padLeft('share', 8)}${padLeft('worstDepth', 12)}${padLeft('medDisp', 10)}${padLeft('sepInward', 11)}${padLeft('velInward', 11)}${padLeft('|out.y|', 9)}`);
  const causes = [...byCause.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [c, list] of causes) {
    const disp = list.map((e) => e.disp).sort((a, b) => a - b);
    const sepIn = list.filter((e) => e.sepInward > 0.2).length;
    const velIn = list.filter((e) => e.velInward > 0.2).length;
    const vert = list.filter((e) => Math.abs(e.outY) > 0.9).length;
    console.log(`  ${pad(c, 12)}${padLeft(list.length, 5)}${padLeft(`${(100 * list.length / Math.max(1, r.entries.length)).toFixed(0)}%`, 8)}` +
      `${padLeft(Math.max(...list.map((e) => e.depth)).toFixed(2), 12)}` +
      `${padLeft(disp[disp.length >> 1].toFixed(3), 10)}` +
      `${padLeft(`${sepIn}/${list.length}`, 11)}${padLeft(`${velIn}/${list.length}`, 11)}${padLeft(`${vert}/${list.length}`, 9)}`);
  }

  // ── EPISODES: entering vs failing to leave
  const eps = r.episodes.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const durs = eps.map((e) => (e.end - e.start) * FIXED).sort((a, b) => a - b);
  if (durs.length) {
    console.log(`\n  EMBEDDED EPISODES: ${eps.length} · median ${durs[durs.length >> 1].toFixed(2)} s · ` +
      `p90 ${durs[Math.floor(durs.length * 0.9)].toFixed(2)} s · worst ${durs[durs.length - 1].toFixed(2)} s`);
    console.log(`  ${pad('id', 6)}${padLeft('t0(s)', 9)}${padLeft('dur(s)', 9)}${padLeft('maxDepth', 10)}${padLeft('climb%', 9)}`);
    for (const e of eps.slice(0, 8)) {
      console.log(`  ${pad(e.id, 6)}${padLeft((e.start * FIXED).toFixed(1), 9)}${padLeft(((e.end - e.start) * FIXED).toFixed(2), 9)}` +
        `${padLeft(e.maxDepth.toFixed(2), 10)}${padLeft(`${(100 * e.climbSteps / Math.max(1, e.end - e.start)).toFixed(0)}%`, 9)}`);
    }
  }

  // ── THE WORST ENTRY, in full
  if (r.entries.length) {
    const worst = r.entries.reduce((a, b) => (b.depth > a.depth ? b : a));
    console.log(`\n  DEEPEST SINGLE ENTRY  id=${worst.id} at t=${(worst.step * FIXED).toFixed(2)} s`);
    console.log(`    depth ${worst.prevDepth.toFixed(3)} → ${worst.depth.toFixed(3)} m in one step` +
      ` · moved ${worst.disp.toFixed(3)} m (dy ${worst.dispY.toFixed(3)})`);
    console.log(`    state ${worst.stateBefore} → ${worst.stateAfter} · grounded ${worst.grounded} · speed ${worst.speed.toFixed(2)} m/s`);
    console.log(`    push-out dir (${worst.outX.toFixed(2)}, ${worst.outY.toFixed(2)}, ${worst.outZ.toFixed(2)}) at (${worst.x.toFixed(1)}, ${worst.y.toFixed(2)}, ${worst.z.toFixed(1)})`);
    console.log(`    separation |w·sep| ${worst.sepMag.toFixed(3)} · inward ${worst.sepInward.toFixed(2)}` +
      ` · desired inward ${worst.desiredInward.toFixed(2)} · velocity inward ${worst.velInward.toFixed(2)} m/s · knockback inward ${worst.pushInward.toFixed(2)}`);
    console.log(`    step's worst correction ${worst.stepWorstCorr.toFixed(2)} m, ${worst.stepClamped} clamped · wedgeTrips ${worst.wedgeBefore}→${worst.wedgeAfter}`);
    console.log(`    cause: ${worst.cause}`);
  }

  // ── THE STALLS. A body wedged in a wall is a body not walking — is it the same bodies?
  const st = r.stalls.slice().sort((a, b) => b.dur - a.dur);
  const stallIds = new Set(st.map((s) => s.id));
  const bothIds = [...stallIds].filter((i) => r.insideIds.has(i));
  console.log(`\n  CHASE STALLS > 2 s: ${st.length} episodes across ${stallIds.size} bodies · ` +
    `worst ${st.length ? st[0].dur.toFixed(1) : '0'} s`);
  console.log(`  bodies that BOTH stalled and embedded: ${bothIds.length} of ${stallIds.size}`);
  const embSum = st.reduce((a, b) => a + b.embeddedFrac * b.dur, 0);
  const durSum = st.reduce((a, b) => a + b.dur, 0);
  console.log(`  stalled time spent embedded: ${(100 * embSum / Math.max(1e-9, durSum)).toFixed(2)}% ` +
    `· in climb: ${(100 * st.reduce((a, b) => a + b.climbFrac * b.dur, 0) / Math.max(1e-9, durSum)).toFixed(1)}%`);
  console.log(`  ${pad('id', 5)}${padLeft('t0', 7)}${padLeft('dur', 8)}${pad('  where', 26)}${pad('state', 9)}` +
    `${padLeft('nav', 5)}${padLeft('wedge', 7)}${padLeft('distP', 8)}${padLeft('dyP', 8)}${padLeft('spd', 7)}${padLeft('emb%', 7)}${padLeft('maxD', 7)}`);
  for (const s of st.slice(0, 10)) {
    console.log(`  ${pad(s.id, 5)}${padLeft((s.start * FIXED).toFixed(0), 7)}${padLeft(s.dur.toFixed(1), 8)}` +
      `${pad(`  (${s.x.toFixed(1)}, ${s.y.toFixed(1)}, ${s.z.toFixed(1)})`, 26)}${pad(s.state, 9)}` +
      `${padLeft(s.navMode ? 'Y' : 'n', 5)}${padLeft(s.wedgeTrips, 7)}${padLeft(s.distToPlayer.toFixed(1), 8)}` +
      `${padLeft(s.heightBelowPlayer.toFixed(1), 8)}${padLeft(s.speed.toFixed(2), 7)}` +
      `${padLeft(`${(100 * s.embeddedFrac).toFixed(0)}%`, 7)}${padLeft(s.maxDepth.toFixed(2), 7)}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Mode: trace
// ═════════════════════════════════════════════════════════════════════════════════════════════

if (mode === 'trace' || mode === 'all') {
  console.log(`ENEMY.maxSubsteps ${ENEMY.maxSubsteps} × maxSubstepDistance ${ENEMY.maxSubstepDistance} = ${MOVER_MAX_STEP.toFixed(2)} m/step ceiling · ` +
    `iterations ${ENEMY.collisionIterations} · BODY.radius ${BODY.radius} · NAV.climbMax ${NAV.climbMax} · separationWeight ${ENEMY.separationWeight}`);
  report('SPAWN — 25 BODIES × 120 s, PLAYER AT SPAWN', instrumentedSoak(0x1234, 25, 120, false));
  report('ROOF CAMP — 25 BODIES × 120 s, PLAYER ON THE NE ROOF', instrumentedSoak(0x1234, 25, 120, true));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Mode: ablate — turn one mechanism off, re-measure. The one that collapses the count is the one.
// ═════════════════════════════════════════════════════════════════════════════════════════════

if (mode === 'ablate' || mode === 'all') {
  hr('ABLATION — roof camp, 25 × 120 s. Each row rebuilds the arena from the same seed.');
  type Mut = Record<string, number>;
  const E = ENEMY as unknown as Mut;
  const N = NAV as unknown as Mut;
  const S = SCHED as unknown as Mut;
  const base = {
    separationWeight: ENEMY.separationWeight, climbMax: NAV.climbMax,
    wedgeRescueTrips: ENEMY.wedgeRescueTrips, collisionIterations: ENEMY.collisionIterations,
    maxSubsteps: ENEMY.maxSubsteps, maxSubstepDistance: ENEMY.maxSubstepDistance,
    congaRelief: SCHED.congaRelief, separationRadius: ENEMY.separationRadius,
  };
  const restore = (): void => {
    E.separationWeight = base.separationWeight; N.climbMax = base.climbMax;
    E.wedgeRescueTrips = base.wedgeRescueTrips; E.collisionIterations = base.collisionIterations;
    E.maxSubsteps = base.maxSubsteps; E.maxSubstepDistance = base.maxSubstepDistance;
    S.congaRelief = base.congaRelief; E.separationRadius = base.separationRadius;
  };

  const cases: [string, () => void][] = [
    ['baseline', () => {}],
    ['no separation', () => { E.separationWeight = 0; }],
    ['no conga relief', () => { S.congaRelief = 1; }],
    ['2x separation', () => { E.separationWeight = base.separationWeight * 2; }],
    ['no climb/mantle', () => { N.climbMax = 0; }],
    ['no wedge rescue', () => { E.wedgeRescueTrips = 1e9; }],
    ['16 substeps @0.05', () => { E.maxSubsteps = 16; E.maxSubstepDistance = 0.05; }],
    ['4 depen. iters', () => { E.collisionIterations = 4; }],
    ['6 depen. iters', () => { E.collisionIterations = 6; }],
    ['8 depen. iters', () => { E.collisionIterations = 8; }],
    ['12 depen. iters', () => { E.collisionIterations = 12; }],
    ['6 iters + no climb', () => { E.collisionIterations = 6; N.climbMax = 0; }],
    ['12 iters + no climb', () => { E.collisionIterations = 12; N.climbMax = 0; }],
  ];

  console.log(`  'nominal' is today's stairs.mjs scoreboard; 'own' is the same metric with each body's real capsule.`);
  console.log(`  ${pad('ablation', 21)}${padLeft('nomBody', 8)}${padLeft('nomSmp', 8)}${padLeft('nomWorst', 9)}` +
    `${padLeft('ownBody', 8)}${padLeft('ownSmp', 8)}${padLeft('ownWorst', 9)}` +
    `${padLeft('bodySteps', 10)}${padLeft('entries', 8)}${padLeft('climb%', 7)}${padLeft('ms/step', 9)}  entry mix`);
  for (const [name, apply] of cases) {
    restore();
    apply();
    const t0 = performance.now();
    const r = instrumentedSoak(0x1234, 25, 120, true);
    const ms = (performance.now() - t0) / (120 / FIXED);
    const mix = new Map<string, number>();
    for (const e of r.entries) mix.set(e.cause, (mix.get(e.cause) ?? 0) + 1);
    const mixStr = [...mix.entries()].sort((a, b) => b[1] - a[1]).map(([c, k]) => `${c}:${k}`).join(' ');
    console.log(`  ${pad(name, 21)}${padLeft(r.nomIds.size, 8)}${padLeft(r.nomSamples, 8)}${padLeft(r.nomMaxDepth.toFixed(2), 9)}` +
      `${padLeft(r.soakIds.size, 8)}${padLeft(r.soakSamples, 8)}${padLeft(r.soakMaxDepth.toFixed(2), 9)}` +
      `${padLeft(r.insideStepSamples, 10)}${padLeft(r.entries.length, 8)}` +
      `${padLeft(`${(100 * r.climbInsideSteps / Math.max(1, r.insideStepSamples)).toFixed(0)}%`, 7)}` +
      `${padLeft(ms.toFixed(3), 9)}  ${mixStr}`);
  }
  restore();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Mode: spots — what the solver's depth field actually looks like at the sites the trace named.
// ═════════════════════════════════════════════════════════════════════════════════════════════

if (mode === 'spots' || mode === 'all') {
  hr('DEPTH FIELD at the sites the trace named. Cell = collideCapsule depth, 4 cm grid, 1.2 m across.');
  console.log('  legend  · = 0   digits = decimetres of reported penetration   # = over 1.0 m');
  const rig = buildRig(0x1234);
  const w = rig.world as unknown as WorldLike;
  const p = new Vector3();
  const trash = new Vector3();
  // r/h are a MEDIAN live body (`shape` mode measures the spread), not the nominal constants.
  const R = 0.334;
  const H = 1.659;
  const sites: [string, number, number, number][] = [
    ['east stair foot — stall + fling hot spot', 57.2, 0.0, -30.0],
    ['plaza stair foot — stall hot spot', 18.5, 0.0, 18.4],
    ['west plaza — 25.8 s stall hot spot', -6.7, 0.0, -8.0],
    ['worst NOMINAL false positive (spawn)', -15.0, 0.0, -18.0],
    ['worst NOMINAL false positive (camp)', 17.5, 0.0, 21.6],
  ];
  for (const [label, x, y, z] of sites) {
    const g = groundAt(rig.world, x, z, y + 8) ?? y;
    console.log(`\n  ${label}  (${x}, ${z})  ground ${g.toFixed(2)} m`);
    let over = 0; let cells = 0; let mx = 0;
    for (let gz = -15; gz <= 15; gz++) {
      let row = '    ';
      for (let gx = -15; gx <= 15; gx++) {
        p.set(x + gx * 0.04, g, z + gz * 0.04);
        const d = probeDepth(w, p, H, R, trash);
        cells++;
        if (d > mx) mx = d;
        if (d > 1.0) { over++; row += '#'; } else if (d < 0.02) row += '·';
        else row += String(Math.min(9, Math.max(1, Math.round(d * 10))));
      }
      console.log(row);
    }
    const nomOver = ((): number => {
      let k = 0;
      for (let gz = -15; gz <= 15; gz++) {
        for (let gx = -15; gx <= 15; gx++) {
          p.set(x + gx * 0.04, g, z + gz * 0.04);
          if (probeDepth(w, p, BODY.height, BODY.radius, trash) > 1.0) k++;
        }
      }
      return k;
    })();
    console.log(`    own capsule (r=${R} h=${H}): ${over}/${cells} cells over 1 m, worst ${mx.toFixed(2)} m` +
      `  ·  NOMINAL probe (r=${BODY.radius} h=${BODY.height}): ${nomOver}/${cells} over 1 m`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Mode: shape — is the scoreboard measuring the capsule the solver actually moves?
// ═════════════════════════════════════════════════════════════════════════════════════════════

if (mode === 'shape' || mode === 'all') {
  hr('CAPSULE SHAPE — `stairs.mjs` probes BODY.radius/BODY.height; `spawn()` scales both per body.');
  const rig = buildRig(0x1234);
  const spawn = new Vector3();
  const edges = rig.world.enemySpawns;
  for (let i = 0; i < 25; i++) {
    spawn.copy(edges[i % edges.length] as V3);
    if (rig.world.findFreeSpawn(spawn, BODY.radius, BODY.height, spawn)) rig.enemies.spawn('shambler', spawn, 1, 1);
  }
  const bodies = rig.enemies.all as unknown as readonly Probe[];
  let minR = Infinity; let maxR = 0; let minH = Infinity; let maxH = 0;
  for (const e of bodies) {
    if (e.radius < minR) minR = e.radius;
    if (e.radius > maxR) maxR = e.radius;
    if (e.height < minH) minH = e.height;
    if (e.height > maxH) maxH = e.height;
  }
  console.log(`  nominal      radius ${BODY.radius.toFixed(3)}  height ${BODY.height.toFixed(3)}`);
  console.log(`  actual       radius ${minR.toFixed(3)}–${maxR.toFixed(3)}  height ${minH.toFixed(3)}–${maxH.toFixed(3)}  (${bodies.length} bodies)`);
  console.log(`  a nominal probe on a smaller body over-reports contact by up to ${((BODY.radius - minR) * 100).toFixed(1)} cm of radius.`);
  rig.enemies.despawnAll();
}

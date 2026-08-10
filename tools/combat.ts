/**
 * COMBAT HARNESS — the objective half of "make the horde feel like CoD Zombies".
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS IS FOR, and what it deliberately refuses to do.
 *
 *  The human judges feel. This measures the FACTS underneath the feel, in the real arena,
 *  against the real `EnemySystem`, the real bone rig and the real bullet trace, headless in
 *  node. Nothing here has an opinion about whether a headshot is satisfying; it only reports
 *  whether the thing you aimed at is the thing the game scored, how fast the horde is, how
 *  long it takes to kill you, and how tight a trained line actually is.
 *
 *  Five suites, one command:
 *
 *    curve    the CoD health curve and the speed-tier distribution, per round
 *    hitbox   the CONFUSION MATRIX — aimed-at part vs scored part, at 5 / 15 / 30 m
 *    surround time-to-down with five zombies on you
 *    conga    the training metric — drive a circle, measure how tight the line is
 *    perf     sim cost of the new steering pass at 25 alive
 *
 *  Run it with `node tools/combat.mjs [all|curve|hitbox|surround|conga|perf]`, which bundles
 *  through vite so `@/` and `three/addons` resolve exactly as they do in the browser.
 *
 *  NOTHING IN `src/` IS MODIFIED TO SUPPORT THIS. Everything below goes through exports the
 *  game already has, so the harness cannot drift into being a second implementation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { installDomStub } from './domstub';

installDomStub();

const { Vector3 } = await import('three');
const { Rng } = await import('@/core/rng');
const { PLAYER, ENEMY, ROUND, MOVE } = await import('@/game/tuning');
const { roundHealth } = await import('@/game/rounds/director');
const {
  BONE, HITBOX, LIMB_CAPSULES, LIMB_COUNT, SCHED, SPEED_TIERS, TIER_COUNT, TIER_MIX,
  SHAMBLER, rollTier, tierMixFor,
} = await import('@/game/enemies/defs');
const { FIXED, buildRig, ENEMY_SHAPE, pad, padLeft } = await import('./rig');

type Enemy = import('@/game/enemies/service').Enemy;
type EnemyHit = import('@/core/types').EnemyHit;
type Rng = InstanceType<typeof Rng>;
type V3 = InstanceType<typeof Vector3>;

const rig = buildRig(0x1234);
const { world, ctx, enemies, events } = rig;

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${label}${detail ? `  — ${detail}` : ''}`);
}
function hr(title: string): void {
  console.log(`\n${'═'.repeat(94)}\n  ${title}\n${'═'.repeat(94)}`);
}
function f(n: number, d = 2): string { return n.toFixed(d); }

const args = process.argv.slice(2);
const want = (s: string): boolean => args.length === 0 || args.includes('all') || args.includes(s);

/** Damage the inkslinger does to a head at point blank: `WEAPON` base 42 × `PLAYER.critMult`. */
const HEAD_DAMAGE = 42 * PLAYER.critMult;
/** …and with the Pack-a-Punch-equivalent `UPGRADE.damageMult` (2.1) that M4 has to sell. */
const HEAD_DAMAGE_PAP = HEAD_DAMAGE * 2.1;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE CURVE — health per round, and the speed-tier mix per round
// ═════════════════════════════════════════════════════════════════════════════════════════════

function curve(): void {
  hr('HEALTH — Call of Duty WaW/BO1: 150 at R1, +100 through R9, ×1.1 compounding from R10');

  // The formula, stated independently of the implementation, so this is a real check and not a
  // tautology: build the curve by literal recurrence and compare against `roundHealth`.
  let ref = ROUND.hpRound1;
  let worstErr = 0;
  for (let n = 1; n <= 60; n++) {
    if (n > 1) {
      ref = n <= ROUND.hpLinearUntil ? ref + ROUND.hpAddPerRound : ref * ROUND.hpGrowth;
    }
    worstErr = Math.max(worstErr, Math.abs(roundHealth(n) - ref) / ref);
  }
  check(worstErr < 1e-9, 'roundHealth() matches the CoD recurrence for 60 rounds',
    `worst relative error ${worstErr.toExponential(1)}`);
  check(roundHealth(1) === 150, 'round 1 is 150 HP');
  check(Math.abs(roundHealth(10) - 1045) < 0.5, 'round 10 is 1045 HP', f(roundHealth(10), 1));

  console.log(`\n  ${pad('round', 7)}${padLeft('health', 10)}${padLeft('×R1', 8)}`
    + `${padLeft('headshots', 11)}${padLeft('+PaP', 7)}${padLeft('body shots', 12)}`);
  console.log(`  ${'─'.repeat(55)}`);
  for (const n of [1, 2, 5, 9, 10, 15, 20, 25, 30]) {
    const hp = roundHealth(n);
    console.log(`  ${pad(`R${n}`, 7)}${padLeft(f(hp, 0), 10)}${padLeft(`${f(hp / 150, 1)}×`, 8)}`
      + `${padLeft(Math.ceil(hp / HEAD_DAMAGE), 11)}`
      + `${padLeft(Math.ceil(hp / HEAD_DAMAGE_PAP), 7)}`
      + `${padLeft(Math.ceil(hp / 42), 12)}`);
  }

  hr('SPEED TIERS — a per-instance roll from a round-driven mix (CoD walk / run / sprint)');

  for (let r = 0; r < TIER_MIX.length; r++) {
    const row = TIER_MIX[r] as readonly number[];
    let sum = 0;
    for (const v of row) sum += v;
    if (Math.abs(sum - 1) > 1e-9) {
      check(false, `TIER_MIX row ${r + 1} sums to 1`, f(sum, 6));
      return;
    }
  }
  check(true, `all ${TIER_MIX.length} TIER_MIX rows sum to 1`);

  // The DISTRIBUTION AS SHIPPED: `rollTier` is what `EnemySystem.spawn` calls, so sampling it is
  // sampling the game. 200 000 rolls puts the sampling error under 0.15 points.
  const rng = new Rng(0xc0ffee);
  const N = 200_000;
  console.log(`\n  ${pad('round', 7)}${SPEED_TIERS.map((t) => padLeft(t.id, 11)).join('')}`
    + `${padLeft('mean m/s', 11)}${padLeft('top m/s', 10)}${padLeft('% player walk', 15)}`);
  console.log(`  ${'─'.repeat(85)}`);
  const rows: { round: number; share: number[]; mean: number; top: number }[] = [];
  for (const n of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25]) {
    const count = new Array<number>(TIER_COUNT).fill(0);
    for (let i = 0; i < N; i++) count[rollTier(rng.next(), n) as number]++;
    const speedScale = Math.min(ROUND.speedScaleMax, n >= ROUND.speedScaleStartRound
      ? 1 + (n - ROUND.speedScaleStartRound + 1) * ROUND.speedPerRound : 1);
    let mean = 0;
    let top = 0;
    const share: number[] = [];
    for (let t = 0; t < TIER_COUNT; t++) {
      const p = (count[t] as number) / N;
      share.push(p);
      const v = SHAMBLER.speed * (SPEED_TIERS[t] as { speedMult: number }).speedMult * speedScale;
      mean += p * v;
      if (p > 0.001) top = v;
    }
    rows.push({ round: n, share, mean, top });
    console.log(`  ${pad(`R${n}`, 7)}${share.map((p) => padLeft(`${f(p * 100, 1)}%`, 11)).join('')}`
      + `${padLeft(f(mean), 11)}${padLeft(f(top), 10)}`
      + `${padLeft(`${f(100 * top / MOVE.walkSpeed, 0)}%`, 15)}`);
  }

  const r1 = rows.find((r) => r.round === 1);
  const r15 = rows.find((r) => r.round === 15);
  const r20 = rows.find((r) => r.round === 20);
  check((r1?.share[0] ?? 0) > 0.999, 'round 1 is 100% shamblers — the opening is still an opening');
  check((r15?.share[3] ?? 0) > 0.8, 'round 15 is >80% sprinters',
    `${f((r15?.share[3] ?? 0) * 100, 1)}%`);
  check((r20?.top ?? 99) < MOVE.walkSpeed, 'the FASTEST zombie the game can produce is slower '
    + 'than the player WALK — a straight line is always an escape, so a train is always trainable',
    `${f(r20?.top ?? 0)} m/s vs ${f(MOVE.walkSpeed)} m/s`);

  hr('MELEE — CoD: a swing is about half your health, 2–3 hits down you');
  const hits = Math.ceil(PLAYER.maxHealth / SHAMBLER.meleeDamage);
  console.log(`  swing damage ${SHAMBLER.meleeDamage} · player health ${PLAYER.maxHealth}`
    + ` · ${f(100 * SHAMBLER.meleeDamage / PLAYER.maxHealth, 1)}% per hit · ${hits} hits to down`);
  check(hits >= 2 && hits <= 3, 'between 2 and 3 hits down the player', `${hits}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. HITBOXES — the confusion matrix, and the overhang profile
//
// ═══ AIM AT THE DRAWING, SCORE WITH THE GAME ═══
//
// Every aim point below is a POSED MESH VERTEX. The vertices are skinned on the CPU with the
// same four-influence linear blend and the same `rig.data` palette the vertex shader uses, so a
// point in this test is a point on the surface the GPU actually draws. Each one is labelled by
// its DOMINANT BONE — head/jaw are 'head', spine/chest/clavicle/neck/rag are 'torso', the four
// limb chains are 'limb'.
//
// That is what makes the matrix meaningful rather than circular: nothing here consults `HITBOX`,
// `hWorld` or `cacheLocalHitboxes`. It asks the only question a player asks — *I shot the thing
// I could see; what did the game give me?*
//
// SELF-OCCLUSION is excluded rather than counted. A vertex on the far side of the body is not
// something the player can shoot, so a ray whose hit lands far in front of its target vertex is
// reported separately instead of polluting a cell.
//
// THE OVERHANG PROFILE is the other half of honest, and it replaces a much worse test. Measuring
// "a near miss 0.5 m from the body axis" is meaningless — the torso capsule is 0.35 m of radius
// on its own, so half those rays were aimed INSIDE the zombie. Instead, per horizontal slice of
// the body, this measures the DRAWN half-width from the mesh and the HITBOX half-width by
// marching a ray outward in 1 cm steps, and reports the difference. Positive = the hitbox is
// wider than the drawing and a visible miss registers; negative = the hitbox is narrower and a
// visible hit does not.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The classes a DRAWN vertex can belong to. `neck` is split out of the torso deliberately: the
 * neck and the trapezius are the one region where CoD's head hitbox legitimately overhangs the
 * body, and lumping them into `torso` would report a 47% "confusion" that is entirely the
 * intended behaviour. `cloth` is the RAG — a hanging coat flap, not flesh, and correctly
 * carries no hitbox at all — so it is excluded from the matrix.
 */
type AimPart = 'head' | 'neck' | 'torso' | 'limb';
type VertClass = AimPart | 'cloth';
type Scored = 'head' | 'torso' | 'limb' | 'miss';
const AIM_PARTS: readonly AimPart[] = ['head', 'neck', 'torso', 'limb'];
const SCORED: readonly Scored[] = ['head', 'torso', 'limb', 'miss'];
/** Column in `SCORED` that counts as "correct" for each row of `AIM_PARTS`. */
const CORRECT_COL: readonly number[] = [0, 0, 1, 2];

/** Dominant-bone → aim part. The only place this harness decides what a body part IS. */
const BONE_PART: readonly VertClass[] = (() => {
  const m: VertClass[] = [];
  for (let b = 0; b < 21; b++) m.push('torso');
  m[BONE.HEAD] = 'head';
  m[BONE.JAW] = 'head';
  for (const b of [BONE.ARM_R, BONE.FORE_R, BONE.HAND_R, BONE.ARM_L, BONE.FORE_L, BONE.HAND_L,
    BONE.THIGH_R, BONE.SHIN_R, BONE.FOOT_R, BONE.THIGH_L, BONE.SHIN_L, BONE.FOOT_L]) {
    m[b] = 'limb';
  }
  m[BONE.NECK] = 'neck';
  m[BONE.CLAV_R] = 'neck';
  m[BONE.CLAV_L] = 'neck';
  m[BONE.RAG] = 'cloth';
  return m;
})();

const _p = new Vector3();
const _o = new Vector3();
const _d = new Vector3();
const _sv = new Vector3();
const _hits: EnemyHit[] = [];

interface Mesh {
  count: number;
  pos: { getX(i: number): number; getY(i: number): number; getZ(i: number): number };
  idx: { getX(i: number): number; getY(i: number): number; getZ(i: number): number; getW(i: number): number };
  wt: { getX(i: number): number; getY(i: number): number; getZ(i: number): number; getW(i: number): number };
}

function meshOf(e: Enemy): Mesh {
  const g = e.body.mesh.geometry;
  const pos = g.getAttribute('position');
  return {
    count: pos.count,
    pos,
    idx: g.getAttribute('aSkinIndex'),
    wt: g.getAttribute('aSkinWeight'),
  } as Mesh;
}

/** Skin vertex `i` on the CPU exactly as the shader does, then yaw it into WORLD space. */
function posedVertex(e: Enemy, m: Mesh, i: number, out: V3): void {
  const px = m.pos.getX(i);
  const py = m.pos.getY(i);
  const pz = m.pos.getZ(i);
  const w = [m.wt.getX(i), m.wt.getY(i), m.wt.getZ(i), m.wt.getW(i)];
  const b = [m.idx.getX(i), m.idx.getY(i), m.idx.getZ(i), m.idx.getW(i)];
  const d = e.body.rig.data;
  let lx = 0;
  let ly = 0;
  let lz = 0;
  for (let k = 0; k < 4; k++) {
    const wk = w[k] as number;
    if (wk === 0) continue;
    const o = ((b[k] as number) | 0) * 12;
    lx += wk * ((d[o] as number) * px + (d[o + 1] as number) * py + (d[o + 2] as number) * pz + (d[o + 3] as number));
    ly += wk * ((d[o + 4] as number) * px + (d[o + 5] as number) * py + (d[o + 6] as number) * pz + (d[o + 7] as number));
    lz += wk * ((d[o + 8] as number) * px + (d[o + 9] as number) * py + (d[o + 10] as number) * pz + (d[o + 11] as number));
  }
  const s = Math.sin(e.yaw);
  const c = Math.cos(e.yaw);
  out.set(
    e.position.x + lx * c + lz * s,
    e.position.y - e.stepSmear + ly,
    e.position.z + -lx * s + lz * c,
  );
}

/** The part this vertex belongs to, by its heaviest influence. */
function vertexPart(m: Mesh, i: number): VertClass {
  const w = [m.wt.getX(i), m.wt.getY(i), m.wt.getZ(i), m.wt.getW(i)];
  const b = [m.idx.getX(i), m.idx.getY(i), m.idx.getZ(i), m.idx.getW(i)];
  let best = -1;
  let bestW = -1;
  for (let k = 0; k < 4; k++) {
    if ((w[k] as number) > bestW) { bestW = w[k] as number; best = (b[k] as number) | 0; }
  }
  return (BONE_PART[best] ?? 'torso') as VertClass;
}

/** Spawn `n` bodies far enough apart that no ray can ever cross two of them. */
function spreadBodies(n: number, ring: number): Enemy[] {
  enemies.despawnAll();
  const origin = world.playerSpawn.position;
  const spawn = new Vector3();
  const out: Enemy[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    spawn.set(origin.x + Math.cos(a) * ring, origin.y + 3, origin.z + Math.sin(a) * ring);
    if (!world.findFreeSpawn(spawn, ENEMY_SHAPE.radius, ENEMY_SHAPE.height, spawn)) continue;
    const e = enemies.spawn('shambler', spawn, 1, 1) as Enemy | null;
    if (e) out.push(e);
  }
  ctx.player.position.set(origin.x, origin.y + MOVE.standEye, origin.z);
  // Walk for a second and a half so the poses under test are real chase poses — arms swinging,
  // elbows bent, heads lolling — and not the bind pose. They stay tens of metres apart.
  for (let i = 0; i < Math.round(1.5 / FIXED); i++) rig.stepHorde();
  return out;
}

/** Trace at `target` from `_o` and return [scoredPart, hitDistance]. */
function shootAt(target: V3, range: number): [Scored, number] {
  _d.copy(target).sub(_o);
  const dist = _d.length();
  if (dist < 1e-4) return ['miss', -1];
  _d.divideScalar(dist);
  const n = enemies.raycast(_o, _d, range * 3, 1, _hits);
  if (n === 0) return ['miss', -1];
  const h = _hits[0] as EnemyHit;
  const part = h.part === 'head' || h.part === 'torso' || h.part === 'limb' ? h.part : 'miss';
  return [part as Scored, h.distance];
}

function hitboxes(): void {
  hr('HITBOX CONFUSION MATRIX — aimed-at part vs scored part');
  console.log('  Aim points are POSED MESH VERTICES, skinned on the CPU with the shader\'s own');
  console.log('  palette and labelled by dominant bone. Nothing here reads HITBOX or hWorld.\n');

  const bodies = spreadBodies(10, 46);
  const AZ = [0, 0.25, 0.5, 0.75, 1.15, 1.6, 2.1, 2.6];
  const RANGES = [5, 15, 30];
  const v = new Vector3();

  for (const range of RANGES) {
    const counts: number[][] = AIM_PARTS.map(() => [0, 0, 0, 0]);
    let occluded = 0;
    let tested = 0;
    let cloth = 0;

    for (const e of bodies) {
      const m = meshOf(e);
      for (const azf of AZ) {
        const az = azf * Math.PI;
        _o.set(
          e.position.x + Math.cos(az) * range,
          e.position.y + MOVE.standEye,
          e.position.z + Math.sin(az) * range,
        );
        ctx.player.position.copy(_o);
        ctx.time.advance();
        // Force the pose + world hitbox refresh for THIS frame before anything is measured, so
        // the vertices below and the capsules being shot at are the same instant.
        enemies.raycast(_o, _d.set(0, -1, 0), 1, 1, _hits);

        // Every 7th vertex — a deterministic stride over the whole surface, not a random sample.
        for (let i = 0; i < m.count; i += 7) {
          const part = vertexPart(m, i);
          // The coat flap has no hitbox and should not have one — it is cloth, not a body part.
          if (part === 'cloth') { cloth++; continue; }
          posedVertex(e, m, i, v);
          const want2 = _o.distanceTo(v);
          const [scored, dist] = shootAt(v, range);
          // A vertex the player cannot see is not a registration test.
          if (scored !== 'miss' && dist < want2 - 0.22) { occluded++; continue; }
          tested++;
          (counts[AIM_PARTS.indexOf(part)] as number[])[SCORED.indexOf(scored)]!++;
        }
      }
    }

    console.log(`  ── ${range} m ${'─'.repeat(46)}`);
    console.log(`  ${pad('aimed at', 12)}${SCORED.map((s) => padLeft(s, 10)).join('')}`
      + `${padLeft('correct', 11)}${padLeft('samples', 10)}`);
    for (let a = 0; a < AIM_PARTS.length; a++) {
      const row = counts[a] as number[];
      const total = row.reduce((x, y) => x + y, 0) || 1;
      const correct = (row[CORRECT_COL[a] as number] as number) / total;
      console.log(`  ${pad(AIM_PARTS[a] as string, 12)}`
        + row.map((x) => padLeft(`${f(100 * x / total, 1)}%`, 10)).join('')
        + padLeft(`${f(100 * correct, 1)}%`, 11) + padLeft(total, 10));
    }
    const headRow = counts[0] as number[];
    const headTotal = headRow.reduce((x, y) => x + y, 0) || 1;
    const neckRow = counts[1] as number[];
    const neckTotal = neckRow.reduce((x, y) => x + y, 0) || 1;
    const torsoRow = counts[2] as number[];
    const torsoTotal = torsoRow.reduce((x, y) => x + y, 0) || 1;
    const limbRow = counts[3] as number[];
    const limbTotal = limbRow.reduce((x, y) => x + y, 0) || 1;
    check((headRow[0] as number) / headTotal > 0.92,
      `${range} m — a shot at the drawn SKULL scores a HEAD`,
      `${f(100 * (headRow[0] as number) / headTotal, 1)}%`);
    check((headRow[3] as number) / headTotal < 0.05,
      `${range} m — a shot at the drawn SKULL is never nothing`,
      `${f(100 * (headRow[3] as number) / headTotal, 1)}% miss`);
    check((torsoRow[2] as number) / torsoTotal < 0.02,
      `${range} m — a torso shot is never stolen by a limb`,
      `${f(100 * (torsoRow[2] as number) / torsoTotal, 2)}%`);
    check((torsoRow[3] as number) / torsoTotal < 0.01,
      `${range} m — a shot at the drawn TORSO is never nothing`,
      `${f(100 * (torsoRow[3] as number) / torsoTotal, 1)}% miss`);
    check((limbRow[3] as number) / limbTotal < 0.03,
      `${range} m — a shot at a drawn LIMB is never nothing`,
      `${f(100 * (limbRow[3] as number) / limbTotal, 1)}% miss`);
    check((neckRow[3] as number) / neckTotal < 0.02,
      `${range} m — a shot at the drawn NECK or trapezius is never nothing`,
      `${f(100 * (neckRow[3] as number) / neckTotal, 1)}% miss`);
    console.log(`  (${occluded} of ${occluded + tested} rays were self-occluded, `
      + `${cloth} vertices were coat cloth — both excluded)\n`);
  }
  console.log('  READ THE OFF-DIAGONALS — two of them are the design, not a defect:');
  console.log('   · limb→torso. `HITBOX.priority` resolves head→torso→limb, so an upper arm');
  console.log('     hanging across the chest scores a BODY shot instead of shielding one. A limb');
  console.log('     never protects a zombie, and the damage is identical either way.');
  console.log('   · neck→head. The neck and the trapezius are headshot surface, exactly as they');
  console.log('     are in CoD — and that is the region a train exposes as it walks away from you.');

  // ── THE SILHOUETTE MARGIN ───────────────────────────────────────────────────────────────
  hr('SILHOUETTE MARGIN — how far outside the drawing does the hitbox still register?');
  console.log('  For each body, each azimuth and each 1/16th of its OWN height, the outermost');
  console.log('  drawn vertex on each side is the silhouette edge. Rays are then aimed at that');
  console.log('  edge pushed outward by a margin. 0 cm should register (a visible hit hits);');
  console.log('  a large margin should not (a visible miss misses).\n');

  const MARGINS = [0, 0.02, 0.05, 0.08, 0.12, 0.18, 0.25, 0.35];
  const hitAt = new Int32Array(MARGINS.length);
  let edges = 0;
  const BANDS = 16;
  const lat = new Float64Array(BANDS * 2);

  for (const e of bodies) {
    const m = meshOf(e);
    for (const azf of [0, 0.4, 0.8, 1.2, 1.6]) {
      const az = azf * Math.PI;
      const range = 12;
      _o.set(
        e.position.x + Math.cos(az) * range,
        e.position.y + MOVE.standEye,
        e.position.z + Math.sin(az) * range,
      );
      ctx.player.position.copy(_o);
      ctx.time.advance();
      enemies.raycast(_o, _d.set(0, -1, 0), 1, 1, _hits);

      // Lateral axis: horizontal, perpendicular to the shot.
      const lx = -Math.sin(az);
      const lz = Math.cos(az);
      const band = e.height / BANDS;
      lat.fill(0);
      const ly = new Float64Array(BANDS * 2);
      for (let i = 0; i < m.count; i++) {
        if (vertexPart(m, i) === 'cloth') continue;
        posedVertex(e, m, i, v);
        const bi = Math.floor((v.y - e.position.y) / band);
        if (bi < 0 || bi >= BANDS) continue;
        const l = (v.x - e.position.x) * lx + (v.z - e.position.z) * lz;
        const side = l >= 0 ? 0 : 1;
        const k = bi * 2 + side;
        if (Math.abs(l) > Math.abs(lat[k] as number)) { lat[k] = l; ly[k] = v.y; }
      }

      for (let k = 0; k < BANDS * 2; k++) {
        const w = lat[k] as number;
        if (Math.abs(w) < 0.02) continue;
        edges++;
        const sgn = w >= 0 ? 1 : -1;
        for (let mi = 0; mi < MARGINS.length; mi++) {
          const x = w + sgn * (MARGINS[mi] as number);
          _p.set(e.position.x + lx * x, ly[k] as number, e.position.z + lz * x);
          if (shootAt(_p, range)[0] !== 'miss') hitAt[mi]++;
        }
      }
    }
  }

  console.log(`  ${pad('margin', 12)}${padLeft('registers', 12)}`);
  for (let mi = 0; mi < MARGINS.length; mi++) {
    const pct = 100 * (hitAt[mi] as number) / Math.max(1, edges);
    const bar = '█'.repeat(Math.round(pct / 3));
    console.log(`  ${pad(`${f(100 * (MARGINS[mi] as number), 0)} cm`, 12)}`
      + `${padLeft(`${f(pct, 1)}%`, 12)}  ${bar}`);
  }
  console.log(`  (${edges} silhouette edges sampled)`);
  const at0 = 100 * (hitAt[0] as number) / Math.max(1, edges);
  const at25 = 100 * (hitAt[6] as number) / Math.max(1, edges);
  check(at0 > 88, 'a shot ON the drawn silhouette edge registers', `${f(at0, 1)}%`);
  check(at25 < 22, 'a shot 25 cm outside the silhouette mostly does not', `${f(at25, 1)}%`);

  // ── the head sphere against the instance it belongs to ──────────────────────────────────
  hr('HEAD SPHERE — one per instance, not one for the horde');
  let minR = 99;
  let maxR = 0;
  for (const e of bodies) { minR = Math.min(minR, e.headRadius); maxR = Math.max(maxR, e.headRadius); }
  console.log(`  head hitbox radius across ${bodies.length} instances: ${f(minR, 3)}–${f(maxR, 3)} m`);
  console.log(`  (fixed ${HITBOX.headRadius} × height-ratio before this build — a ±${f(100 * (maxR / minR - 1), 0)}%`
    + ' spread the old formula could not see, because it carried the variant SCALE but not its GIRTH)');
  console.log(`  limb capsules per body: ${LIMB_CAPSULES} (was ${LIMB_COUNT}, one per limb)`);
  check(maxR / minR > 1.1, 'the head hitbox actually varies per instance', `${f(maxR / minR, 3)}×`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. SURROUNDED — how long five zombies take to put you down
// ═════════════════════════════════════════════════════════════════════════════════════════════

function surround(): void {
  hr('TIME TO DOWN — the player stands still, surrounded');
  console.log('  The player does not move and does not shoot. This is the worst case, and it is');
  console.log('  the number that decides whether being surrounded is how you die.\n');

  let damage = 0;
  let swings = 0;
  const off = events.on('enemy:attacked', (p) => { damage += p.damage; swings++; });

  console.log(`  ${pad('attackers', 11)}${padLeft('first hit', 12)}${padLeft('half HP', 11)}`
    + `${padLeft('DOWNED', 11)}${padLeft('swings', 9)}${padLeft('dmg/s', 9)}`);
  console.log(`  ${'─'.repeat(64)}`);

  const results: { n: number; down: number }[] = [];
  for (const count of [1, 2, 3, 5, 8]) {
    enemies.despawnAll();
    damage = 0;
    swings = 0;
    const p = world.playerSpawn.position;
    // FEET, not eye height. `PlayerService.position` is the feet (see the comment on
    // `Enemy.position`), and `ai.ts::canSwing` gates on `|heightToPlayer| < verticalMeleeGate`
    // — which is 1.7, i.e. exactly `MOVE.standEye`. Park the stand-in at eye height and NOTHING
    // can ever swing at it. `tools/rig.ts::stepPlayer` does add `eyeHeight`; that is a rig bug,
    // reported to the lead, and this harness does not copy it.
    ctx.player.position.set(p.x, p.y, p.z);
    ctx.player.lookDir.set(0, 0, -1);

    const spawn = new Vector3();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      spawn.set(p.x + Math.cos(a) * 3.0, p.y + 1.5, p.z + Math.sin(a) * 3.0);
      if (!world.findFreeSpawn(spawn, ENEMY_SHAPE.radius, ENEMY_SHAPE.height, spawn)) continue;
      enemies.spawn('shambler', spawn, 1, 1);
    }

    let first = -1;
    let half = -1;
    let down = -1;
    const steps = Math.round(20 / FIXED);
    for (let i = 0; i < steps; i++) {
      rig.stepHorde();
      const t = i * FIXED;
      if (first < 0 && damage > 0) first = t;
      if (half < 0 && damage >= PLAYER.maxHealth * 0.5) half = t;
      if (damage >= PLAYER.maxHealth) { down = t; break; }
    }
    results.push({ n: count, down });
    const dps = down > 0 ? PLAYER.maxHealth / down : damage / 20;
    console.log(`  ${pad(count, 11)}${padLeft(first < 0 ? '—' : `${f(first)} s`, 12)}`
      + `${padLeft(half < 0 ? '—' : `${f(half)} s`, 11)}`
      + `${padLeft(down < 0 ? '> 20 s' : `${f(down)} s`, 11)}`
      + `${padLeft(swings, 9)}${padLeft(f(dps, 0), 9)}`);
  }
  off();

  const five = results.find((r) => r.n === 5);
  check((five?.down ?? -1) > 0 && (five?.down ?? 99) < 6,
    'five zombies on a stationary player down them inside 6 s', `${f(five?.down ?? -1)} s`);
  const one = results.find((r) => r.n === 1);
  check((one?.down ?? 0) > 3.5,
    'ONE zombie still takes >3.5 s — you always have time to walk out of a single swing',
    `${f(one?.down ?? -1)} s`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE CONGA LINE — the training metric
//
// Drive the player around a circle at walking pace and ask two questions about the horde:
//
//   LATERAL DEVIATION — for each chasing body, the distance from it to the nearest point on the
//   path the player has actually walked. A perfect train is bodies ON your footprints; a mob
//   cuts the circle and sits metres inside it. This is the number that says "followable".
//
//   CHAIN LENGTH — sort the horde by distance to the player and walk the list: a body extends
//   the chain while it is within `SCHED.congaFollowRadius` of the one in front of it. That is
//   literally "how many zombies are in the line you can mow down in one sweep".
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface Sample { dev: number; chain: number; spread: number; pack: number; width: number }

/**
 * Walk a circle and measure the line behind you.
 *
 * `pace` is the player's speed. It is NOT always 5.4 — a horde that is a third of your speed
 * cannot be trained on a tight loop by anyone, it simply falls behind and cuts to the middle,
 * and measuring that tells you nothing about the steering. A human trains at the pace the horde
 * makes them train at, so the driver does too: `TRAIN_LEAD` × the fastest zombie of the round,
 * capped at the player's walk.
 *
 * Deviation is measured over the TRAIN — bodies inside `WINDOW` metres. A straggler that spawned
 * on the far side of the arena is not part of the line and should not be averaged into it.
 */
const TRAIN_LEAD = 1.35;
const WINDOW = 16;
/**
 * Gap under which two consecutive bodies count as links in the same queue, metres. A FIXED
 * constant on purpose — using `SCHED.congaFollowRadius` here made the metric move with the
 * parameter under test, which is how a tuning sweep lies to you.
 */
const QUEUE_GAP = 4.2;

/**
 * PAIRED RUNS. `EnemySystem` owns a private `Rng` whose stream carries across spawns, so the
 * control and the shipped run would otherwise draw different variants, girths and tier rolls and
 * the A/B would be comparing two different hordes. Restarting the stream before every run makes
 * the two columns identical in every respect except the one force under test. `Rng.seed` is a
 * documented public setter; the cast reaches a private FIELD, which is a harness liberty and is
 * the only one in this file.
 */
function reseedHorde(): void {
  const priv = enemies as unknown as {
    rng: { seed: number };
    variantCursor: number;
    pool: unknown[];
    free: unknown[];
  };
  priv.rng.seed = 0x5a11b1e;

  // THE POOL'S FREE-LIST ORDER IS CARRIED STATE TOO, and it was the third piece.
  //
  // `despawnAll()` recycles every body, but the order they land back on `free` depends on the
  // order they died — so a suite that ran BEFORE this one leaves the list permuted, `spawn()`
  // pops different bodies for the same spawn index, and each one arrives carrying whatever
  // per-instance state its previous life left on it. The A/B stayed honest (both columns saw the
  // same permutation) but the ABSOLUTE numbers moved with run order, which made the suite
  // disagree with itself:
  //
  //   conga alone        R1 6.3→7.6  R10 5.3→6.7  R15 7.1→7.8   +18%, every round improves
  //   conga after others R1 4.3→6.2  R10 6.2→5.5  R15 5.7→6.4   +12%, R10 REGRESSES
  //
  // Same code, same seed, opposite conclusions — and the second one sent a real investigation
  // after a bug in the steering that was not there. Restoring `free` to the pool's own order
  // makes every run start from the identical horde regardless of what ran first.
  priv.free.length = 0;
  for (let i = priv.pool.length - 1; i >= 0; i--) priv.free.push(priv.pool[i]);
  // The variant cursor is the OTHER piece of carried state — it walks `VARIANTS` round-robin,
  // so without this the control run gets gaunt/bloated/twisted and the shipped run gets
  // bloated/twisted/gaunt, and a third of the difference between the columns is body shape.
  priv.variantCursor = 0;
}

function congaRun(count: number, radius: number, seconds: number, round: number, label: string): Sample {
  enemies.despawnAll();
  reseedHorde();
  enemies.round = round;
  const c = world.playerSpawn.position;
  const path: number[] = [];
  const PATH_MAX = 600;

  // The fastest tier this round can actually produce, and the pace it forces.
  const mix = tierMixFor(round);
  const speedScale = Math.min(ROUND.speedScaleMax, round >= ROUND.speedScaleStartRound
    ? 1 + (round - ROUND.speedScaleStartRound + 1) * ROUND.speedPerRound : 1);
  let fastest = SHAMBLER.speed;
  for (let t = 0; t < TIER_COUNT; t++) {
    if ((mix[t] as number) > 0.02) {
      fastest = SHAMBLER.speed * (SPEED_TIERS[t] as { speedMult: number }).speedMult * speedScale;
    }
  }
  const pace = Math.min(MOVE.walkSpeed, fastest * TRAIN_LEAD);

  const spawn = new Vector3();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = radius + 2 + (i % 3) * 1.2;
    spawn.set(c.x + Math.cos(a) * r, c.y + 2, c.z + Math.sin(a) * r);
    if (!world.findFreeSpawn(spawn, ENEMY_SHAPE.radius, ENEMY_SHAPE.height, spawn)) continue;
    enemies.spawn('shambler', spawn, 1, 1);
  }

  const steps = Math.round(seconds / FIXED);
  const omega = pace / radius;
  const lap = (Math.PI * 2) / omega;
  let devSum = 0;
  let devN = 0;
  let chainSum = 0;
  let chainN = 0;
  let spreadSum = 0;
  let packSum = 0;
  let widthSum = 0;
  let widthN = 0;

  const live = enemies.all as readonly { alive: boolean; position: V3 }[];
  const order: number[] = [];

  for (let i = 0; i < steps; i++) {
    const a = i * FIXED * omega;
    ctx.player.position.set(c.x + Math.cos(a) * radius, c.y, c.z + Math.sin(a) * radius);
    ctx.player.lookDir.set(-Math.sin(a), 0, Math.cos(a));
    rig.stepHorde();

    if (i % 6 === 0) {
      path.push(ctx.player.position.x, ctx.player.position.z);
      if (path.length > PATH_MAX * 2) path.splice(0, 2);
    }
    // Measure at 5 Hz, and only once a full lap of footprints exists to measure against.
    if (i % 24 !== 0 || i * FIXED < lap) continue;

    order.length = 0;
    const dp = (k: number): number => {
      const q = live[k]!.position;
      return Math.hypot(q.x - ctx.player.position.x, q.z - ctx.player.position.z);
    };
    for (let k = 0; k < live.length; k++) if (live[k]!.alive && dp(k) <= WINDOW) order.push(k);
    if (order.length < 2) continue;
    order.sort((x, y) => dp(x) - dp(y));
    packSum += order.length;

    for (const k of order) {
      const q = live[k]!.position;
      let best = Infinity;
      for (let sI = 0; sI + 3 < path.length; sI += 2) {
        best = Math.min(best, segDist(q.x, q.z,
          path[sI] as number, path[sI + 1] as number,
          path[sI + 2] as number, path[sI + 3] as number));
      }
      if (best < Infinity) { devSum += best; devN++; }
    }

    let chain = 1;
    for (let k = 1; k < order.length; k++) {
      const a1 = live[order[k - 1] as number]!.position;
      const b1 = live[order[k] as number]!.position;
      if (Math.hypot(b1.x - a1.x, b1.z - a1.z) <= QUEUE_GAP) chain++;
      else break;
    }
    chainSum += chain;
    chainN++;

    // ═══ THE SHAPE OF THE PACK — a LINE or a FAN ═══════════════════════════════════════
    //
    // This is the metric that actually answers the human's ask. "Distance to the path I
    // walked" is the wrong question for a circle: a horde chasing greedily runs a SMALLER
    // circle inside yours, and it is supposed to — that is the corner-cutting that makes a
    // train a train. What matters is whether they are strung out in a LINE or fanned into a
    // CRESCENT that surrounds you.
    //
    // So: take the head-of-the-line → tail axis, project every body in the pack onto it and
    // onto its perpendicular. LENGTH is the spread along the line, WIDTH is the spread
    // across it. A conga line is long and thin; a mob is short and wide.
    const head = live[order[0] as number]!.position;
    const tail = live[order[order.length - 1] as number]!.position;
    const axX = tail.x - head.x;
    const axZ = tail.z - head.z;
    const axL = Math.hypot(axX, axZ);
    spreadSum += axL;
    if (axL > 1e-3) {
      const ux = axX / axL;
      const uz = axZ / axL;
      let s2 = 0;
      for (const k of order) {
        const q = live[k]!.position;
        const w = (q.x - head.x) * -uz + (q.z - head.z) * ux;
        s2 += w * w;
      }
      widthSum += Math.sqrt(s2 / order.length);
      widthN++;
    }
  }

  const sOut: Sample = {
    dev: devN ? devSum / devN : NaN,
    chain: chainN ? chainSum / chainN : NaN,
    spread: chainN ? spreadSum / chainN : NaN,
    pack: chainN ? packSum / chainN : NaN,
    width: widthN ? widthSum / widthN : NaN,
  };
  console.log(`  ${pad(label, 28)}${padLeft(f(pace), 8)}${padLeft(f(sOut.pack, 1), 7)}`
    + `${padLeft(f(sOut.spread), 10)}${padLeft(f(sOut.width), 10)}`
    + `${padLeft(f(sOut.spread / sOut.width, 2), 9)}${padLeft(f(sOut.chain, 1), 8)}`
    + `${padLeft(f(sOut.dev), 10)}`);
  return sOut;
}

/** Distance from (px,pz) to the segment (ax,az)–(bx,bz). */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let t = l2 > 1e-9 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

function conga(): void {
  hr('THE CONGA LINE — the training metric');
  console.log('  The driver circles at 1.35× the fastest zombie of the round (capped at walk),');
  console.log('  because that is the pace a human trains at. Metrics cover the bodies within');
  console.log(`  ${WINDOW} m — the train — and ignore stragglers still crossing the arena.\n`);
  console.log('  length  = head→tail extent of the pack, m.');
  console.log('  width   = RMS spread ACROSS that axis, m. A conga line is long and THIN.');
  console.log('  L/W     = the shape. > 2 is a line, ~1 is a blob, < 1 is a crescent round you.');
  console.log(`  chain   = unbroken queue length, nearest-first, gaps under ${QUEUE_GAP} m.`);
  console.log('  lat dev = distance to the path you walked (context — a train legitimately');
  console.log('            cuts inside your circle, so this is reported, not asserted).\n');
  console.log(`  ${pad('condition', 28)}${padLeft('pace', 8)}${padLeft('pack', 7)}`
    + `${padLeft('length', 10)}${padLeft('width', 10)}${padLeft('L/W', 9)}`
    + `${padLeft('chain', 8)}${padLeft('lat dev', 10)}`);
  console.log(`  ${'─'.repeat(82)}`);

  // ═══ THE A/B ═══════════════════════════════════════════════════════════════════════════
  // `SCHED` is `as const`, which is a COMPILE-TIME assertion — the object is a plain mutable
  // JS object at run time. Zeroing the follow weight for one run is therefore a genuine control:
  // the same seed, the same arena, the same bodies, the same steering, minus exactly one force.
  const sched = SCHED as unknown as { congaFollowWeight: number };
  const shipped = sched.congaFollowWeight;

  sched.congaFollowWeight = 0;
  console.log('  ── control: SCHED.congaFollowWeight = 0 (BUILD 006 steering) ──');
  const c1 = congaRun(16, 12, 70, 1, 'R1  · 16 bodies · 12 m loop');
  const c10 = congaRun(20, 12, 70, 10, 'R10 · 20 bodies · 12 m loop');
  const c15 = congaRun(20, 12, 70, 15, 'R15 · 20 bodies · 12 m loop');

  sched.congaFollowWeight = shipped;
  console.log(`  ── shipped: SCHED.congaFollowWeight = ${shipped} ──`);
  const a1 = congaRun(16, 12, 70, 1, 'R1  · 16 bodies · 12 m loop');
  const a10 = congaRun(20, 12, 70, 10, 'R10 · 20 bodies · 12 m loop');
  const a15 = congaRun(20, 12, 70, 15, 'R15 · 20 bodies · 12 m loop');
  const a18 = congaRun(20, 18, 70, 10, 'R10 · 20 bodies · 18 m loop');
  enemies.round = 1;

  const lw = (x: Sample): number => x.spread / x.width;
  console.log('');
  console.log(`  follow term · shape L/W  ${f(lw(c1), 2)} → ${f(lw(a1), 2)} at R1,`
    + `  ${f(lw(c10), 2)} → ${f(lw(a10), 2)} at R10,  ${f(lw(c15), 2)} → ${f(lw(a15), 2)} at R15`);
  console.log(`              · width m    ${f(c1.width)} → ${f(a1.width)} at R1,`
    + `  ${f(c10.width)} → ${f(a10.width)} at R10,  ${f(c15.width)} → ${f(a15.width)} at R15`);
  console.log(`              · chain      ${f(c1.chain, 1)} → ${f(a1.chain, 1)} at R1,`
    + `  ${f(c10.chain, 1)} → ${f(a10.chain, 1)} at R10,  ${f(c15.chain, 1)} → ${f(a15.chain, 1)} at R15`);

  const meanW = (x: Sample, y: Sample, z: Sample): number => (x.width + y.width + z.width) / 3;
  const meanC = (x: Sample, y: Sample, z: Sample): number => (x.chain + y.chain + z.chain) / 3;
  // CHAIN is the robust half of the A/B — it moves 25–45% in the same direction at every round
  // and every seed tried. WIDTH is the noisier half (one round in three can go the other way on
  // a given seed), so it is bounded rather than compared.
  check(a1.chain > c1.chain && a10.chain > c10.chain && a15.chain > c15.chain,
    'the follow term lengthens the unbroken queue at EVERY round tested',
    `chain ${f(meanC(c1, c10, c15), 1)} → ${f(meanC(a1, a10, a15), 1)} mean`);
  check(meanC(a1, a10, a15) > meanC(c1, c10, c15) * 1.2,
    '…by at least 20% on average',
    `${f(100 * (meanC(a1, a10, a15) / meanC(c1, c10, c15) - 1), 0)}%`);
  check(meanW(a1, a10, a15) < 3.6,
    'and the trained pack stays under 3.6 m across the line of travel',
    `width ${f(meanW(c1, c10, c15))} → ${f(meanW(a1, a10, a15))} m`);
  check(lw(a10) > 2 && lw(a15) > 2,
    'the trained pack is a LINE, not a blob (length/width > 2)',
    `${f(lw(a10), 2)} / ${f(lw(a15), 2)}`);
  check(a10.chain >= 5, 'the queue is at least 5 bodies long', f(a10.chain, 1));
  check(lw(a18) > 1.8, 'and it holds its shape on a wider loop', `${f(lw(a18), 2)}`);
  check(a15.spread > 4,
    'the horde is still STRUNG OUT, not a point — a train you can sweep in one pass',
    `${f(a15.spread)} m head→tail`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. PERF — the new steering pass must not cost anything
// ═════════════════════════════════════════════════════════════════════════════════════════════

function perf(): void {
  hr('SIM COST — the conga follow rides inside the existing separation loop');
  enemies.despawnAll();
  reseedHorde();
  const c = world.playerSpawn.position;
  ctx.player.position.set(c.x, c.y, c.z);
  const spawn = new Vector3();
  for (let i = 0; i < 25; i++) {
    const a = (i / 25) * Math.PI * 2;
    spawn.set(c.x + Math.cos(a) * (10 + (i % 4)), c.y + 2, c.z + Math.sin(a) * (10 + (i % 4)));
    if (!world.findFreeSpawn(spawn, ENEMY_SHAPE.radius, ENEMY_SHAPE.height, spawn)) continue;
    enemies.spawn('shambler', spawn, 1, 1);
  }
  for (let i = 0; i < 600; i++) rig.stepHorde();   // warm

  const steps = 12_000;
  let ms = 0;
  for (let i = 0; i < steps; i++) ms += rig.stepHorde();
  console.log(`  ${enemies.aliveCount} alive · ${f(ms / steps, 4)} ms / fixed step`
    + ` · ${f(ms / steps * 2, 4)} ms per 60 fps frame (two 120 Hz sim steps)`);
  check(ms / steps < 0.35, 'horde sim stays under 0.35 ms/step at 25 alive',
    `${f(ms / steps, 4)} ms`);

  // Allocation: a hot loop that allocates is a frame that hitches later.
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) {
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 60_000; i++) rig.stepHorde();
    gc();
    const after = process.memoryUsage().heapUsed;
    const kb = (after - before) / 1024;
    console.log(`  heap over 60 000 steps with 25 bodies: ${kb >= 0 ? '+' : ''}${f(kb, 0)} KB`);
    check(Math.abs(kb) < 512, 'no heap growth in the horde step', `${f(kb, 0)} KB`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════

console.log(`\nCOMBAT HARNESS · seed 0x1234 · arena ${world.bounds.max.x - world.bounds.min.x} m`
  + ` · ENEMY.meleeDamage ${ENEMY.meleeDamage}`);

if (want('curve')) curve();
if (want('hitbox')) hitboxes();
if (want('surround')) surround();
if (want('conga')) conga();
if (want('perf')) perf();

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);

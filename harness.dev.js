(() => {
const CZ = window.CZ;
const V3 = CZ.player.position.constructor;
const FIXED = 1 / 120;
const H = {};
window.__H = H;

function sys(name) { return CZ.loop.all.find((s) => s.name === name); }
const P = sys('player'), E = sys('enemies'), W = CZ.ctx.world;

function step(n) {
  const t = CZ.time;
  for (let i = 0; i < n; i++) {
    t.paused = false;
    t.elapsed += FIXED; t.unscaledElapsed += FIXED; t.frame++; t.dt = FIXED;
    P.fixedUpdate(FIXED, CZ.ctx);
    E.fixedUpdate(FIXED, CZ.ctx);
  }
}
function stepTimed(n) {
  const t = CZ.time; let ms = 0;
  for (let i = 0; i < n; i++) {
    t.paused = false;
    t.elapsed += FIXED; t.unscaledElapsed += FIXED; t.frame++; t.dt = FIXED;
    const a = performance.now();
    P.fixedUpdate(FIXED, CZ.ctx);
    E.fixedUpdate(FIXED, CZ.ctx);
    ms += performance.now() - a;
  }
  return ms;
}

const _a = new V3(), _b = new V3();
function depthOf(e) {
  // TRUE capsule — no step offset, no lift. This is "am I inside geometry".
  _a.set(e.position.x, e.position.y + e.radius, e.position.z);
  _b.set(e.position.x, e.position.y + e.height - e.radius, e.position.z);
  const c = W.collideCapsule(_a, _b, e.radius);
  return c ? c.depth : 0;
}

const MELEE = CZ.tuning.ENEMY.meleeRange, GATE = CZ.tuning.ENEMY.verticalMeleeGate;

// ── TEST A: 25 zombies, 120 s of sim ─────────────────────────────────────────
H.hordeTest = async function hordeTest(seconds, mode) {
  CZ.loop.stop();
  CZ.killAll();
  CZ.renderer.autoQuality = false;
  CZ.input.enabled = true;
  CZ.input.moveAxis.x = 0; CZ.input.moveAxis.y = 0;
  if (mode === 'camp') CZ.camp('roof_ne');
  else CZ.player.controller.teleport(CZ.ctx.world.playerSpawn.position, CZ.ctx.world.playerSpawn.yaw);
  step(60);
  const n = mode === 'camp' ? CZ.spawnStreet(25) : CZ.spawn(25);

  const steps = Math.round(seconds / FIXED);
  const track = new Map();
  let simMs = 0, samples = 0;
  let insideSamples = 0, maxDepth = 0; const insideIds = new Set();
  let stallEvents = 0, maxStall = 0; const stallIds = new Set();
  let arrivals = 0; const arrivedIds = new Set();
  let sumDist = 0, distSamples = 0;

  for (let done = 0; done < steps; done += 240) {
    // The harness measures LOCOMOTION, not survival: an invulnerable player keeps the horde
    // alive for the full window instead of downing them and triggering a killAll.
    CZ.player.controller.iFrames = 999;
    simMs += stepTimed(Math.min(240, steps - done)); samples += Math.min(240, steps - done);
    const alive = E.all;
    for (let i = 0; i < alive.length; i++) {
      const e = alive[i];
      let t = track.get(e.id);
      if (!t) { t = { x: e.position.x, z: e.position.z, still: 0 }; track.set(e.id, t); }
      const moved = Math.hypot(e.position.x - t.x, e.position.z - t.z);
      const outOfFight = e.distToPlayer > MELEE || Math.abs(e.heightToPlayer) > GATE;
      if (moved > 0.30 || e.state !== 'chase' || !outOfFight) { t.x = e.position.x; t.z = e.position.z; t.still = 0; }
      else {
        t.still += 240 * FIXED;
        if (t.still > 2.0) { stallEvents++; stallIds.add(e.id); if (t.still > maxStall) maxStall = t.still; }
      }
      const d = depthOf(e);
      if (d > 0.10) { insideSamples++; insideIds.add(e.id); if (d > maxDepth) maxDepth = d; }
      sumDist += e.distToPlayer; distSamples++;
      if (e.distToPlayer < 2.5 && Math.abs(e.heightToPlayer) < GATE && !arrivedIds.has(e.id)) { arrivedIds.add(e.id); arrivals++; }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  return {
    mode: mode || 'flat', spawned: n, alive: E.all.length, simSeconds: seconds,
    insideGeometry_bodies: insideIds.size, insideGeometry_samples: insideSamples,
    maxOverlapDepth_m: +maxDepth.toFixed(3),
    stalled2s_bodies: stallIds.size, stalled2s_events: stallEvents, maxStall_s: +maxStall.toFixed(1),
    arrivedWithin2_5m: arrivals,
    avgDistToPlayer_m: +(sumDist / Math.max(1, distSamples)).toFixed(2),
    simMsPerStep: +(simMs / samples).toFixed(3),
  };
};

// ── TEST B: ledge fall ───────────────────────────────────────────────────────
const _p = new V3(), _d = new V3(0, -1, 0);
function groundAtXZ(x, z, fromY) { _p.set(x, fromY, z); return W.groundAt(_p); }

H.findLedges = function findLedges() {
  const b = W.bounds, out = [];
  const seen = new Set();
  const stepM = 2.0, probe = 1.1;
  for (let x = b.min.x + 4; x < b.max.x - 4; x += stepM) {
    for (let z = b.min.z + 4; z < b.max.z - 4; z += stepM) {
      const g = groundAtXZ(x, z, b.max.y - 1);
      if (g === null) continue;
      for (let k = 0; k < 4; k++) {
        const dx = k === 0 ? probe : k === 1 ? -probe : 0;
        const dz = k === 2 ? probe : k === 3 ? -probe : 0;
        const g2 = groundAtXZ(x + dx, z + dz, g + 0.6);
        if (g2 === null) continue;
        const drop = g - g2;
        if (drop < 0.6) continue;
        const bucket = Math.round(drop * 2) / 2;
        if (seen.has(bucket) || seen.size > 40) continue;
        seen.add(bucket);
        out.push({ drop: +drop.toFixed(2), topY: +g.toFixed(2), x, z, dx, dz });
      }
    }
  }
  out.sort((a, c) => a.drop - c.drop);
  return out;
};

H.ledgeTest = async function ledgeTest(ledges) {
  CZ.loop.stop();
  CZ.killAll();
  const c = CZ.player.controller;
  CZ.input.enabled = true;
  const res = [];
  let frame = CZ.time.frame;
  for (const L of ledges) {
    // stand 1.4 m back from the lip, facing the drop
    const len = Math.hypot(L.dx, L.dz);
    const ux = L.dx / len, uz = L.dz / len;
    const sx = L.x - ux * 1.4, sz = L.z - uz * 1.4;
    const g = groundAtXZ(sx, sz, L.topY + 1.0);
    if (g === null || Math.abs(g - L.topY) > 0.3) { res.push({ drop: L.drop, skipped: 'no stand ground' }); continue; }
    // yaw such that forward (-sin yaw, -cos yaw) === (ux, uz)
    const yaw = Math.atan2(-ux, -uz);
    c.teleport(new V3(sx, g, sz), yaw);
    CZ.input.moveAxis.x = 0; CZ.input.moveAxis.y = 0;
    for (let i = 0; i < 60; i++) { CZ.time.paused = false; c.fixedUpdate(FIXED, yaw, frame++); }
    const y0 = c.position.y;
    const grounded0 = c.grounded;
    CZ.input.moveAxis.y = 1;
    let minY = y0, floatSteps = 0, offEdge = false;
    for (let i = 0; i < 480; i++) {
      CZ.time.paused = false;
      c.fixedUpdate(FIXED, yaw, frame++);
      if (c.position.y < minY) minY = c.position.y;
      // travelled past the lip?
      const dot = (c.position.x - L.x) * ux + (c.position.z - L.z) * uz;
      if (dot > 0.55) { offEdge = true; if (c.position.y > y0 - 0.25) floatSteps++; }
    }
    CZ.input.moveAxis.y = 0;
    const dropped = y0 - c.position.y;
    res.push({
      drop: L.drop, startY: +y0.toFixed(2), endY: +c.position.y.toFixed(2),
      fell_m: +dropped.toFixed(2), wentOverEdge: offEdge,
      floatSeconds: +(floatSteps * FIXED).toFixed(2),
      grounded0, PASS: !offEdge ? null : dropped > Math.min(L.drop, 1.0) * 0.7,
    });
    await new Promise((r) => setTimeout(r, 0));
  }
  return res;
};

H.run = async function run(opts) {
  const o = opts || {};
  H.result = { status: 'running' };
  try {
    const flat = await H.hordeTest(o.seconds || 120, 'flat');
    const camp = await H.hordeTest(o.seconds || 120, 'camp');
    const ledges = H.findLedges();
    const ledge = await H.ledgeTest(ledges);
    const tested = ledge.filter((r) => r.wentOverEdge);
    H.result = {
      status: 'done', flat, camp, ledgeCount: ledges.length,
      ledgeSummary: {
        heightsFound: ledges.map((l) => l.drop),
        walkedOff: tested.length,
        fell: tested.filter((r) => r.PASS).length,
        floated: tested.filter((r) => !r.PASS).map((r) => ({ drop: r.drop, floatSeconds: r.floatSeconds })),
      },
      ledge,
    };
  } catch (err) { H.result = { status: 'error', error: String(err && err.stack || err) }; }
  return H.result;
};
return 'harness installed';
})()

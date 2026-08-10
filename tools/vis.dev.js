/**
 * VISUAL-CONSISTENCY MEASUREMENT HARNESS — dev only, never imported by the game.
 *
 * Objective frame statistics off the real drawing buffer: value histogram, warm/cool hue
 * split, per-region bands, and the ART §4.1 stillness test. No judgement, only numbers.
 *
 *   const M = await import('/vis.dev.js').then(m => m.install());
 *   M.sweep(M.STATIONS)
 *   M.stillness()
 */

export function install() {
  const CZ = window.CZ;
  const R = CZ.renderer;
  const gl = R.three.getContext();
  const cv = R.three.domElement;
  const V = CZ.player.position.constructor;

  function busy(ms) { const t = performance.now(); while (performance.now() - t < ms) { /* spin */ } }
  function step(n = 1, gap = 16) {
    CZ.renderer.autoQuality = false;
    for (let i = 0; i < n; i++) {
      CZ.time.paused = false;
      CZ.input.enabled = true;
      CZ.loop.stepOnce();
      if (i < n - 1) busy(gap);
    }
  }
  function grab() {
    const w = cv.width, h = cv.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { w, h, buf };
  }
  function analyse(g, stride = 4) {
    const { w, h, buf } = g;
    let n = 0, sub01 = 0, b0102 = 0, mid = 0, blown = 0, sum = 0;
    let warm = 0, cool = 0, green = 0, chroma = 0, satSum = 0;
    for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) {
      const i = (y * w + x) * 4;
      const r = buf[i] / 255, gc = buf[i + 1] / 255, b = buf[i + 2] / 255;
      const L = 0.2126 * r + 0.7152 * gc + 0.0722 * b;
      n++; sum += L;
      if (L < 0.1) sub01++; else if (L < 0.2) b0102++;
      if (L >= 0.2 && L <= 0.7) mid++;
      if (L > 0.7) blown++;
      const mx = Math.max(r, gc, b), mn = Math.min(r, gc, b);
      const s = mx > 0 ? (mx - mn) / mx : 0; satSum += s;
      if (s > 0.15) {
        chroma++;
        const d = mx - mn;
        let hue;
        if (mx === r) hue = ((gc - b) / d + 6) % 6; else if (mx === gc) hue = (b - r) / d + 2; else hue = (r - gc) / d + 4;
        hue *= 60;
        if (hue < 75 || hue >= 330) warm++; else if (hue >= 160 && hue < 300) cool++; else green++;
      }
    }
    const p = v => +(100 * v / n).toFixed(1);
    const q = v => +(100 * v / Math.max(1, chroma)).toFixed(1);
    return {
      mean: +(sum / n).toFixed(4), sub01: p(sub01), b0102: p(b0102), mid: p(mid), blown: p(blown),
      warmPct: q(warm), coolPct: q(cool), greenPct: q(green), chromaPct: p(chroma),
      meanSat: +(satSum / n).toFixed(3),
    };
  }
  function look(pos, yaw, pitch) {
    if (pos) CZ.player.teleport(new V(pos[0], pos[1], pos[2]), yaw);
    CZ.player.camera.setLook(yaw, pitch);
    step(3, 16);
    CZ.player.camera.setLook(yaw, pitch);
    step(1, 16);
  }
  const YAWS = [0, 1.571, 3.142, 4.712];
  const STATIONS = [
    { id: 'GROUND plaza', pos: [0, 0.1, 21] },
    { id: 'GROUND ring N', pos: [0, 0.1, -62.5] },
    { id: 'GROUND radial E', pos: [25, 0.1, 0] },
    { id: 'HIGH roof_ne', camp: 'roof_ne' },
    { id: 'HIGH gantry', camp: 'gantry' },
    { id: 'HIGH catwalk', camp: 'catwalk' },
  ];
  function sweep(stations = STATIONS, yaws = YAWS, pitch = -0.12) {
    CZ.loop.stop();
    const out = [];
    for (const st of stations) {
      if (st.camp) CZ.camp(st.camp);
      const rows = [];
      for (const y of yaws) { look(st.pos ?? null, y, pitch); rows.push(analyse(grab())); }
      const agg = k => +(rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(2);
      out.push({
        id: st.id,
        pos: [+CZ.player.position.x.toFixed(1), +CZ.player.position.y.toFixed(2), +CZ.player.position.z.toFixed(1)],
        mean: agg('mean'), sub01: agg('sub01'), b0102: agg('b0102'), mid: agg('mid'), blown: agg('blown'),
        warm: agg('warmPct'), cool: agg('coolPct'), green: agg('greenPct'), sat: agg('meanSat'),
        worstSub01: Math.max(...rows.map(r => r.sub01)),
        worstB0102: Math.max(...rows.map(r => r.b0102)),
        worstMid: Math.min(...rows.map(r => r.mid)),
      });
    }
    return out;
  }
  /** ART §4.1: with the camera parked, < 0.5% of pixels may differ between frames. */
  function stillness(frames = 6) {
    CZ.loop.stop();
    step(4, 16);
    let prev = null, worst = 0;
    const each = [];
    for (let f = 0; f < frames; f++) {
      step(1, 16);
      const g = grab();
      if (prev) {
        let n = 0, diff = 0;
        for (let i = 0; i < g.buf.length; i += 16) {
          n++;
          if (Math.abs(g.buf[i] - prev[i]) > 2 || Math.abs(g.buf[i + 1] - prev[i + 1]) > 2 || Math.abs(g.buf[i + 2] - prev[i + 2]) > 2) diff++;
        }
        const pct = +(100 * diff / n).toFixed(3);
        each.push(pct);
        worst = Math.max(worst, pct);
      }
      prev = g.buf;
    }
    return { worstPctChanged: worst, each };
  }
  function info() {
    const i = R.three.info;
    return { calls: i.render.calls, tris: i.render.triangles, programs: i.programs ? i.programs.length : -1, geometries: i.memory.geometries, textures: i.memory.textures };
  }
  const M = { CZ, gl, cv, busy, step, grab, analyse, look, sweep, stillness, info, STATIONS, YAWS };
  window.__M = M;
  return M;
}

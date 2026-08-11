/**
 * THE COMPASS BAR AND THE MINIMAP — UI_SPEC §2 and §3.
 *
 *     "a minimap that displays zombies and a NORTH_EAST_WEST etc bar on top like most
 *      shooters? lets make our gam pro"   — the playtester
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS CANVAS AND `hud.ts` IS DOM
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The HUD is DOM because it is text and hard edges that change a few times a second. These two
 * are the opposite: they change EVERY frame, and the minimap's content is up to 28 moving dots.
 * A DOM element per zombie would be 28 style recalcs and 28 layer transforms per frame — exactly
 * the churn that made this HUD hitch earlier in the build. So each widget is ONE `<canvas>`,
 * redrawn with Canvas 2D, and the *frame* around it (heavy ink border, hard offset shadow,
 * halftone fill) is CSS on a wrapper div — composited once, never repainted.
 *
 * THE RASTERISATION RULES, which are the same defect `hud.ts` was just cured of:
 *   · Every canvas is sized in DEVICE pixels and scaled down by CSS. A CSS-scaled canvas is a
 *     resampled canvas, which is the panel-rotation blur wearing a different hat.
 *   · Compass glyphs are drawn AXIS-ALIGNED into a baked 360° tape; the tape's *position*
 *     scrolls. Nothing that holds a letter is ever rotated, and the scroll offset is rounded to
 *     a whole device pixel (worth ≤0.21° of compass error — invisible; a fractional blit is not).
 *   · The minimap DOES rotate, because heading-up is the whole point, but it rotates a baked
 *     BITMAP of the arena, never type. The only letter on it ('N') is drawn axis-aligned at a
 *     rotated *position*.
 *
 * THE STATIC/DYNAMIC SPLIT, which is where the frame budget is won:
 *   · The arena is baked ONCE at boot into an offscreen canvas by sampling `world.groundAt()`
 *     on a 128×128 grid — 16,384 vertical rays, MEASURED at 32 ms in the node harness against
 *     the real collision octree (48²=6.2 ms, 64²=9.2, 96²=18.7, 128²=32.2). One-off, at boot,
 *     next to an arena build that already costs seconds.
 *   · The compass tape (every tick and every letter, all 360°) is baked once too.
 *   · Per frame we do: one clipped `drawImage` of the arena, two `drawImage` slices of the tape,
 *     two batched dot paths, and about a dozen vector ops. See `EXPECTED COST` at the bottom.
 *
 * ZERO ALLOCATION PER FRAME. No arrays are built, no strings are concatenated (the heading
 * readout indexes a 360-entry table built at module load), no vectors are constructed. The
 * enemy list is iterated in place — `EnemyService.all` is already an array, so copying it into
 * a "scratch array" would be strictly more work and more garbage.
 *
 * RESERVED HUES (ART §9) CARRY THE SEMANTICS — no minimap-specific colours are invented:
 *   ACID     ordinary zombies
 *   HOT      specials. This is the gameplay upgrade: the Screamer exists to be priority-killed,
 *            and a HOT dot is how you find it in a crowd.
 *   ELECTRIC the player
 *   GOLD     beacons — powerup drops today, wall-buys and the mystery box next.
 *
 * WHAT THIS FILE MAY TOUCH: `ctx.world` (bake only), `ctx.player`, `ctx.enemies`, `ctx.camera`,
 * `ctx.time`, `ctx.events`, `ctx.debug` — all frozen contracts. It imports no game system.
 */

import { Vector3 } from 'three';

import type { EnemyKind, GameCtx, WorldService } from '@/core/types';
import { css, cssMix } from '@/art/palette';
import { ROUND } from '@/game/tuning';

/**
 * The same stack `hud.ts` uses, duplicated rather than imported: `hud.ts` imports THIS file, so
 * importing its `FONT` back would close a cycle. Two lines of duplication beats that.
 */
const FONT = 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif';

/** Which enemy kinds are worth a HOT dot. Ordinary shamblers and sprinters are just the horde. */
const SPECIAL_KINDS: Readonly<Record<EnemyKind, boolean>> = {
  shambler: false,
  sprinter: false,
  brute: true,
  spitter: true,
  screamer: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tunables. All CSS pixels unless the name says device.
// ─────────────────────────────────────────────────────────────────────────────

const COMPASS = {
  /** Inner width of the strip. Wide enough for three cardinals, narrow enough to clear the
   *  round/points badges at 28 px inset on a 1280-wide window. */
  width: 380,
  /**
   * Tall enough for three stacked bands that never overlap, because they all carry type:
   * ticks 2‥10, the eight labels on a 20 px baseline, and the heading chip 22‥34. A shorter
   * strip put the chip on top of the very label the player is trying to read.
   */
  height: 34,
  /** Degrees visible across the whole strip. 160° ≈ 2.4 px/deg — a turn reads as motion, and
   *  N and E are never both crammed under the centre tick. */
  spanDeg: 160,
  /** Minor ticks every this many degrees, between the eight named points. */
  minorStepDeg: 15,
  /** Distance from the top of the canvas that ticks start. */
  tickTop: 2,
  tickMajor: 8,
  tickMinor: 6,
  tickTiny: 4,
  /** Baseline for the eight labels, from the top of the canvas. */
  labelBaseline: 20,
  fontMajor: 14,
  fontMinor: 10,
  /** The heading chip, flush with the bottom edge under the centre tick. */
  readoutH: 12,
  readoutW: 38,
  readoutFont: 10,
  /** Must match the CSS border below — `layout()` needs the border-box width. */
  borderPx: 4,
} as const;

const MAP = {
  /** Diameter of the drawn disc. ~160 px is the budget UI_SPEC §2 sets. */
  size: 168,
  /** Metres from the player to the rim. Covers the plaza plus the ring boulevard. */
  rangeM: 46,
  /** One faint ring at this fraction of the range, so distances can be judged at a glance. */
  ringAt: 0.5,
  /** Dot radius for a zombie on the player's own level, in CSS px. */
  dotR: 3.4,
  /** Dots for bodies this far above/below the player shrink to `dotROff` — a roof camper and a
   *  zombie in the street below must not read as the same threat. */
  levelTolM: 3.0,
  dotROff: 2.2,
  /** Player arrow half-width / length. */
  arrowW: 5.5,
  arrowL: 8.5,
  /** How far down the view cone reaches, as a fraction of the radius. */
  coneReach: 0.62,
  northFont: 11,
  /** Inset of the 'N' pip from the rim. */
  northInset: 11,
} as const;

/**
 * The arena bake. `cells` is the sampling grid; the bake's px-per-metre is NOT here — it is
 * derived from the device pixel ratio inside `bakeArena()` so the per-frame blit only ever
 * downsamples.
 */
const BAKE = {
  cells: 128,
  /** Height above the player-spawn datum at which ground stops being street and starts being a
   *  raised deck. Measured: the arena's height histogram is 0/1/2/5/7 m then jumps to 20 m+. */
  raisedM: 1.2,
  /** …and above this it is building mass, not somewhere you can stand. */
  buildingM: 9.0,
} as const;

/** How many beacons can be live at once. Fixed pool — see `beacon()`. */
const BEACON_SLOTS = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Precomputed strings. Building these per frame would be the only allocation in the file.
// ─────────────────────────────────────────────────────────────────────────────

/** "000".."359" — the compass readout indexes this instead of calling String(). */
const HEADING_LABELS: readonly string[] = (() => {
  const out: string[] = [];
  for (let d = 0; d < 360; d++) out.push(d < 10 ? `00${d}` : d < 100 ? `0${d}` : `${d}`);
  return out;
})();

const POINT_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

// Colour strings, resolved once. `css()` builds a string every call, so none of these may be
// evaluated inside a draw.
const C_INK = css('INK');
const C_INK_75 = css('INK', 0.75);
const C_INK_38 = css('INK', 0.38);
const C_INK_14 = css('INK', 0.14);
const C_PAPER = css('PAPER');
const C_ACID = css('ACID');
const C_HOT = css('HOT');
const C_ELECTRIC = css('ELECTRIC');
const C_ELECTRIC_22 = css('ELECTRIC', 0.22);
const C_GOLD = css('GOLD');
const C_RAISED = cssMix('PAPER', 'INK', 0.34);

const TWO_PI = Math.PI * 2;
const DEG = 180 / Math.PI;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext('2d');
  // Only null when the element already has a context of another type, which cannot happen for a
  // canvas this module created and owns. Throwing beats silently drawing nothing.
  if (!g) throw new Error('minimap: 2d context unavailable');
  return g;
}

/** Wrap radians into [0, 2π). */
function wrapTau(a: number): number {
  const r = a % TWO_PI;
  return r < 0 ? r + TWO_PI : r;
}

/** Shortest signed distance from `a` to `b` in degrees, in (-180, 180]. */
function deltaDeg(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────

interface Beacon {
  id: string;
  live: boolean;
  x: number;
  z: number;
  /** Seconds until this beacon expires on its own; Infinity for a permanent one. */
  ttl: number;
}

/**
 * The compass strip and the minimap, mounted and driven as one unit because they share the
 * device-pixel machinery, the heading, and the beacon pool.
 */
export class NavPanels {
  // ── DOM ────────────────────────────────────────────────────────────────────
  private readonly styleEl: HTMLStyleElement;
  private readonly compassWrap: HTMLDivElement;
  private readonly compassCv: HTMLCanvasElement;
  private readonly compassG: CanvasRenderingContext2D;
  private readonly mapWrap: HTMLDivElement;
  private readonly mapCv: HTMLCanvasElement;
  private readonly mapG: CanvasRenderingContext2D;

  /**
   * Device pixels per CSS pixel, sampled at construction and re-checked on resize. Starts at 0,
   * not 1: a fresh `<canvas>` is already 300×150, so a "have I sized this yet" test that leans on
   * the width would call itself done on a non-retina display and never size anything.
   */
  private dpr = 0;

  // ── baked, static ──────────────────────────────────────────────────────────
  /** The 360° compass tape: every tick and every letter, drawn once, axis-aligned. */
  private readonly tape: HTMLCanvasElement;
  /** Device px per degree on the tape. */
  private tapePpd = 1;
  private tapeW = 1;

  /** The arena, top-down, in device px. Blitted with a rotation; never redrawn. */
  private readonly bake: HTMLCanvasElement;
  private bakeReady = false;
  /** Device px per metre in `bake`. */
  private bakePpm = 4;
  private bakeMinX = 0;
  private bakeMinZ = 0;
  /** Wall-clock cost of the bake, for `CZ.debug`. */
  private bakeMs = 0;

  // ── per-frame state (all preallocated) ─────────────────────────────────────
  private heading = 0;
  private lastHeading = Number.NaN;
  private lastSimTime = Number.NaN;
  private drawUs = 0;

  /**
   * Ids of enemies that are currently a SPECIAL, maintained from `enemy:spawned` / `enemy:killed`.
   *
   * `Damageable` (the frozen contract `EnemyService.all` hands out) carries no `kind`, and this
   * file is forbidden from importing the enemy system to go looking for one. The event bus
   * publishes the kind at spawn and at death, which is exactly the information needed and the
   * only coupling the architecture allows.
   *
   * Enemy ids are pool slots and ARE reused, so a spawn must positively *clear* the flag for an
   * ordinary body — otherwise a slot that once held a Screamer would paint every shambler after
   * it HOT. `despawnAll()` is silent, but that is harmless for the same reason: nothing is drawn
   * for a dead body, and the next spawn in that slot re-stamps the flag either way.
   */
  private readonly specials = new Set<number>();

  private readonly beacons: Beacon[] = [];

  private readonly probe = new Vector3();
  private readonly offs: (() => void)[] = [];
  private readonly onResize = (): void => { this.layout(); this.measure(); };

  constructor(parent: HTMLElement) {
    this.styleEl = document.createElement('style');
    this.styleEl.id = 'cz-nav-style';
    this.styleEl.textContent = styleSheet();
    document.head.appendChild(this.styleEl);

    this.compassWrap = document.createElement('div');
    this.compassWrap.className = 'cz-compass';
    this.compassCv = document.createElement('canvas');
    this.compassWrap.appendChild(this.compassCv);
    parent.appendChild(this.compassWrap);
    this.compassG = ctx2d(this.compassCv);

    this.mapWrap = document.createElement('div');
    this.mapWrap.className = 'cz-minimap';
    this.mapCv = document.createElement('canvas');
    this.mapWrap.appendChild(this.mapCv);
    parent.appendChild(this.mapWrap);
    this.mapG = ctx2d(this.mapCv);

    this.tape = document.createElement('canvas');
    this.bake = document.createElement('canvas');

    for (let i = 0; i < BEACON_SLOTS; i++) this.beacons.push({ id: '', live: false, x: 0, z: 0, ttl: 0 });

    this.layout();
    this.measure();
  }

  /**
   * INTEGER-CENTRE THE COMPASS. `left: 50%` on an odd viewport width lands the strip on a half
   * pixel, and a canvas on a half pixel is a RESAMPLED canvas — the exact defect §1 of the spec
   * is about, arriving through the back door. So the one element that has to be centred gets its
   * left edge computed and rounded, on construction and on every resize. `innerWidth` is used
   * rather than the parent's `clientWidth` because the HUD root is `inset: 0`: same number, no
   * forced layout.
   */
  private layout(): void {
    const total = COMPASS.width + COMPASS.borderPx * 2;
    this.compassWrap.style.left = `${Math.round((window.innerWidth - total) * 0.5)}px`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  init(ctx: GameCtx): void {
    window.addEventListener('resize', this.onResize);
    this.bakeArena(ctx.world);

    const on = ctx.events.on.bind(ctx.events);
    this.offs.push(
      on('enemy:spawned', (p) => {
        if (SPECIAL_KINDS[p.kind]) this.specials.add(p.enemy.id);
        else this.specials.delete(p.enemy.id);
      }),
      on('enemy:killed', (p) => this.specials.delete(p.enemy.id)),
      /**
       * Powerups are the only beacon source that exists today. Their drop is published; their
       * EXPIRY is not (`powerups.ts::retire` is silent on both the timeout and the round reset),
       * so the beacon carries its own `ROUND.powerupLifetime` countdown and the round start
       * sweeps the pool. Worst case the dot is a fraction of a second stale after a long hitstop
       * chain, because the countdown runs on unscaled frame time and the pickup's does not — a
       * dot that lingers half a second is a far smaller lie than one that never leaves.
       */
      on('powerup:dropped', (p) => this.beacon(p.id, p.position.x, p.position.z, ROUND.powerupLifetime)),
      on('powerup:collected', (p) => this.clearBeacon(p.id)),
      on('round:start', () => this.clearBeacons()),
      on('player:died', () => this.clearBeacons()),
    );

    ctx.debug.watch('nav bake', () => `${this.bakeMs.toFixed(1)} ms · ${this.bake.width}px`);
    ctx.debug.watch('nav draw', () => `${this.drawUs.toFixed(0)} µs`);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.specials.clear();
    this.compassWrap.remove();
    this.mapWrap.remove();
    this.styleEl.remove();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Beacons — the objective-marker data path UI_SPEC §3 asks to be designed now.
  //
  // A compass with nothing to point at is decoration. This is deliberately a WORLD POSITION in
  // and a slot out: a wall-buy, the mystery box's current spot and a downed team-mate are all
  // the same call, and none of them need to know this file exists beyond `hud.nav.beacon(...)`.
  // Fixed pool, linear scan over six — no map, no allocation, no growth.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Place (or move) the beacon named `id`. `ttl` seconds, or omit for a permanent one. */
  beacon(id: string, x: number, z: number, ttl = Infinity): void {
    let slot = this.findBeacon(id);
    if (!slot) {
      for (let i = 0; i < this.beacons.length; i++) {
        const b = this.beacons[i];
        if (!b.live) { slot = b; break; }
      }
    }
    // Full pool: the newest beacon is dropped rather than evicting one the player is walking to.
    if (!slot) return;
    slot.id = id;
    slot.live = true;
    slot.x = x;
    slot.z = z;
    slot.ttl = ttl;
  }

  clearBeacon(id: string): void {
    const b = this.findBeacon(id);
    if (b) { b.live = false; b.id = ''; }
  }

  clearBeacons(): void {
    for (let i = 0; i < this.beacons.length; i++) {
      const b = this.beacons[i];
      b.live = false;
      b.id = '';
    }
  }

  private findBeacon(id: string): Beacon | null {
    for (let i = 0; i < this.beacons.length; i++) {
      const b = this.beacons[i];
      if (b.live && b.id === id) return b;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The frame
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `active` is the HUD's own "is anyone looking at this" flag — false while the HUD is hidden or
   * a full-screen card owns the page.
   *
   * The second gate is the important one: nothing is redrawn unless either GAMEPLAY TIME moved
   * or the player TURNED. `time.elapsed` is scaled time, so it stops dead while paused
   * (`GameTime.beginFrame` zeroes `effectiveScale`) — which makes a paused frame cost one float
   * compare, exactly as UI_SPEC §2 requires, without inventing a pause flag on a frozen
   * contract. It also stops during hitstop, where skipping is not a compromise but correct: the
   * world genuinely has not moved, and if the player is mid-flick the heading test redraws anyway.
   */
  update(dt: number, ctx: GameCtx, active: boolean): void {
    if (!active) return;

    this.stepBeacons(dt);

    // Heading: bearing from north, north being -Z (three's default forward). Straight up or
    // straight down leaves the horizontal component at zero — hold the last heading rather than
    // letting the whole compass snap to an arbitrary value.
    const look = ctx.player.lookDir;
    const flat = look.x * look.x + look.z * look.z;
    if (flat > 1e-8) this.heading = wrapTau(Math.atan2(look.x, -look.z));

    // Beacon bearings are taken from the player, and the compass draws before the map, so the
    // position is latched here once rather than reached for twice.
    this.beaconRefX = ctx.player.position.x;
    this.beaconRefZ = ctx.player.position.z;

    const simT = ctx.time.elapsed;
    if (simT === this.lastSimTime && this.heading === this.lastHeading) return;
    this.lastSimTime = simT;
    this.lastHeading = this.heading;

    const measure = ctx.debug.enabled;
    const t0 = measure ? performance.now() : 0;

    this.drawCompass();
    this.drawMap(ctx);

    if (measure) this.drawUs = (performance.now() - t0) * 1000;
  }

  private stepBeacons(dt: number): void {
    for (let i = 0; i < this.beacons.length; i++) {
      const b = this.beacons[i];
      if (!b.live || b.ttl === Infinity) continue;
      b.ttl -= dt;
      if (b.ttl <= 0) { b.live = false; b.id = ''; }
    }
  }

  // ── compass ────────────────────────────────────────────────────────────────

  private drawCompass(): void {
    const g = this.compassG;
    const w = this.compassCv.width;
    const h = this.compassCv.height;
    const cx = Math.round(w * 0.5);
    g.clearRect(0, 0, w, h);

    // THE TAPE. Source x for bearing 0 is 0, so the window we want starts at
    // `heading * pxPerDeg - halfWidth`, wrapped. Rounded to a whole device pixel: a fractional
    // source offset resamples every glyph on the strip, which is the §1 blur all over again.
    const hdDeg = this.heading * DEG;
    let sx = Math.round(hdDeg * this.tapePpd - cx) % this.tapeW;
    if (sx < 0) sx += this.tapeW;
    const first = Math.min(w, this.tapeW - sx);
    g.drawImage(this.tape, sx, 0, first, h, 0, 0, first, h);
    if (first < w) g.drawImage(this.tape, 0, 0, w - first, h, first, 0, w - first, h);

    // BEACONS on the strip: a GOLD diamond at their bearing, clipped to the visible span.
    const ppd = this.tapePpd;
    for (let i = 0; i < this.beacons.length; i++) {
      const b = this.beacons[i];
      if (!b.live) continue;
      const bear = wrapTau(Math.atan2(b.x - this.beaconRefX, -(b.z - this.beaconRefZ))) * DEG;
      const x = cx + deltaDeg(hdDeg, bear) * ppd;
      if (x < 0 || x > w) continue;
      this.diamond(g, Math.round(x), Math.round(h * 0.34), Math.round(4 * this.dpr), C_GOLD);
    }

    // THE CENTRE TICK. A downward ink wedge over the tape, then the numeric bearing in an ink
    // chip beneath it — "zombies at 270" is a callout you can actually make.
    const d = this.dpr;
    g.fillStyle = C_INK;
    g.beginPath();
    g.moveTo(cx - 4.5 * d, 0);
    g.lineTo(cx + 4.5 * d, 0);
    g.lineTo(cx, 5 * d);
    g.closePath();
    g.fill();

    const rw = Math.round(COMPASS.readoutW * d);
    const rh = Math.round(COMPASS.readoutH * d);
    const rx = cx - Math.round(rw * 0.5);
    const ry = h - rh;
    g.fillRect(rx, ry, rw, rh);
    g.fillStyle = C_PAPER;
    g.font = this.fontReadout;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText(HEADING_LABELS[Math.round(hdDeg) % 360], cx, h - Math.round(2.5 * d));
  }

  // ── minimap ────────────────────────────────────────────────────────────────

  private drawMap(ctx: GameCtx): void {
    const g = this.mapG;
    const size = this.mapCv.width;
    const c = size * 0.5;
    const r = c - 1;
    const S = r / MAP.rangeM; // device px per metre on screen
    const h = this.heading;
    const sin = Math.sin(h);
    const cos = Math.cos(h);

    const pos = ctx.player.position;
    const px = pos.x;
    const py = pos.y;
    const pz = pos.z;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, size, size);

    g.save();
    g.beginPath();
    g.arc(c, c, r, 0, TWO_PI);
    g.clip();

    // 1. THE ARENA. One rotated blit of the static bake. Derivation: world → screen is
    //    right = dx·cos + dz·sin, fwd = dx·sin − dz·cos, screen = (c + right·S, c − fwd·S);
    //    composing that with bake-px → world (x/ppm + minX) gives the matrix below.
    if (this.bakeReady) {
      const k = S / this.bakePpm;
      const a = k * cos;
      const b = -k * sin;
      const cc = k * sin;
      const dd = k * cos;
      const e = c + S * ((this.bakeMinX - px) * cos + (this.bakeMinZ - pz) * sin);
      const f = c + S * (-(this.bakeMinX - px) * sin + (this.bakeMinZ - pz) * cos);
      g.setTransform(a, b, cc, dd, e, f);
      g.drawImage(this.bake, 0, 0);
      g.setTransform(1, 0, 0, 1, 0, 0);
    }

    // 2. Range ring — one faint circle so "how far is that" has an answer.
    g.strokeStyle = C_INK_14;
    g.lineWidth = 1 * this.dpr;
    g.beginPath();
    g.arc(c, c, r * MAP.ringAt, 0, TWO_PI);
    g.stroke();

    // 3. THE HORDE. Two batched paths — every ordinary body in one, every special in the other —
    //    so 28 alive costs 4 draw calls, not 56. Specials are painted last: a HOT dot must never
    //    be buried under the ACID crowd it is standing in.
    const all = ctx.enemies.all;
    const rr = MAP.rangeM * MAP.rangeM;
    const dotR = MAP.dotR * this.dpr;
    const dotOff = MAP.dotROff * this.dpr;
    g.lineWidth = 1.6 * this.dpr;
    g.strokeStyle = C_INK;

    for (let pass = 0; pass < 2; pass++) {
      const wantSpecial = pass === 1;
      g.beginPath();
      let any = false;
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (!e.alive) continue;
        if (this.specials.has(e.id) !== wantSpecial) continue;
        const ep = e.position;
        const dx = ep.x - px;
        const dz = ep.z - pz;
        if (dx * dx + dz * dz > rr) continue; // off the disc: not drawn, not clamped to the rim —
        // a ring of pinned dots is noise, and the compass already covers "which way is trouble".
        const right = dx * cos + dz * sin;
        const fwd = dx * sin - dz * cos;
        const dy = ep.y - py;
        const rad = dy > MAP.levelTolM || dy < -MAP.levelTolM ? dotOff : dotR;
        g.moveTo(c + right * S + rad, c - fwd * S);
        g.arc(c + right * S, c - fwd * S, rad, 0, TWO_PI);
        any = true;
      }
      if (!any) continue;
      g.fillStyle = wantSpecial ? C_HOT : C_ACID;
      g.fill();
      g.stroke();
    }

    // 4. Beacons.
    for (let i = 0; i < this.beacons.length; i++) {
      const b = this.beacons[i];
      if (!b.live) continue;
      const dx = b.x - px;
      const dz = b.z - pz;
      if (dx * dx + dz * dz > rr) continue;
      const right = dx * cos + dz * sin;
      const fwd = dx * sin - dz * cos;
      this.diamond(g, c + right * S, c - fwd * S, 4.6 * this.dpr, C_GOLD);
    }

    // 5. THE PLAYER — always dead centre, always pointing up, because the map is heading-up.
    //    The cone is the real camera FOV, so "is that thing on my screen" is answerable.
    //    `camera.fov` is VERTICAL; the horizontal half-angle is the tangent relation, not
    //    `fov × aspect` — at 78° and 16:9 that shorthand would draw a 138° cone instead of 105°.
    const half = Math.atan(Math.tan((ctx.camera.fov * 0.5) / DEG) * ctx.camera.aspect);
    const reach = r * MAP.coneReach;
    g.fillStyle = C_ELECTRIC_22;
    g.beginPath();
    g.moveTo(c, c);
    g.arc(c, c, reach, -Math.PI * 0.5 - half, -Math.PI * 0.5 + half);
    g.closePath();
    g.fill();

    const aw = MAP.arrowW * this.dpr;
    const al = MAP.arrowL * this.dpr;
    g.beginPath();
    g.moveTo(c, c - al);
    g.lineTo(c + aw, c + al * 0.62);
    g.lineTo(c, c + al * 0.2);
    g.lineTo(c - aw, c + al * 0.62);
    g.closePath();
    g.fillStyle = C_ELECTRIC;
    g.fill();
    g.lineWidth = 1.8 * this.dpr;
    g.strokeStyle = C_INK;
    g.stroke();

    // 6. The north pip. AXIS-ALIGNED GLYPH at a rotated POSITION — the map turns, the letter
    //    never does. Due north from the player is (−sin, −cos) in screen space.
    const nr = r - MAP.northInset * this.dpr;
    g.fillStyle = C_INK_75;
    g.font = this.fontNorth;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', c - sin * nr, c - cos * nr);

    g.restore();
  }

  /** A GOLD beacon lozenge with a hard ink edge. Shared by both widgets. */
  private diamond(g: CanvasRenderingContext2D, x: number, y: number, rad: number, fill: string): void {
    g.beginPath();
    g.moveTo(x, y - rad);
    g.lineTo(x + rad, y);
    g.lineTo(x, y + rad);
    g.lineTo(x - rad, y);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 1.6 * this.dpr;
    g.strokeStyle = C_INK;
    g.stroke();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sizing and baking
  // ═══════════════════════════════════════════════════════════════════════════

  private fontReadout = '11px sans-serif';
  private fontNorth = '11px sans-serif';
  /**
   * Beacon bearings on the compass are taken from the PLAYER, not from the map centre, and the
   * compass is drawn before the map — so the player position is cached here on the way past.
   */
  private beaconRefX = 0;
  private beaconRefZ = 0;

  /**
   * Size every canvas in device pixels and let CSS scale it down. Called at construction and on
   * every resize, because moving a window between a retina and a non-retina display changes
   * `devicePixelRatio` under a canvas that would otherwise stay at the old resolution.
   */
  private measure(): void {
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    if (dpr === this.dpr) return;
    this.dpr = dpr;

    sizeCanvas(this.compassCv, COMPASS.width, COMPASS.height, dpr);
    sizeCanvas(this.mapCv, MAP.size, MAP.size, dpr);

    this.fontReadout = `${Math.round(COMPASS.readoutFont * dpr)}px ${FONT}`;
    this.fontNorth = `${Math.round(MAP.northFont * dpr)}px ${FONT}`;

    this.bakeTape();
    // Force the next `update()` past the idle gate — the canvases were just cleared by resizing.
    this.lastHeading = Number.NaN;
    this.lastSimTime = Number.NaN;
  }

  /**
   * THE COMPASS TAPE — all 360°, drawn once, every glyph axis-aligned.
   *
   * Baking it is what makes the strip cost two `drawImage` calls a frame instead of eight
   * `fillText`s plus thirty strokes. It also means the letters are rasterised exactly once, at
   * device resolution, on the pixel grid — the strip can never go soft the way rotated DOM text
   * did, no matter how fast the player turns.
   */
  private bakeTape(): void {
    const d = this.dpr;
    const w = this.compassCv.width;
    const h = this.compassCv.height;
    const ppd = w / COMPASS.spanDeg;
    this.tapePpd = ppd;
    this.tapeW = Math.round(360 * ppd);
    this.tape.width = this.tapeW;
    this.tape.height = h;

    const g = ctx2d(this.tape);
    g.clearRect(0, 0, this.tapeW, h);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';

    const top = Math.round(COMPASS.tickTop * d);
    const base = Math.round(COMPASS.labelBaseline * d);
    const fontMajor = `${Math.round(COMPASS.fontMajor * d)}px ${FONT}`;
    const fontMinor = `${Math.round(COMPASS.fontMinor * d)}px ${FONT}`;

    // Minor ticks first, so a cardinal's tall tick paints over any tick it shares a degree with.
    g.fillStyle = C_INK_38;
    for (let deg = 0; deg < 360; deg += COMPASS.minorStepDeg) {
      if (deg % 45 === 0) continue;
      const x = Math.round(deg * ppd);
      g.fillRect(x, top, Math.max(1, Math.round(d)), Math.round(COMPASS.tickTiny * d));
    }

    for (let i = 0; i < 8; i++) {
      const deg = i * 45;
      const major = i % 2 === 0;
      const x = Math.round(deg * ppd);
      g.fillStyle = major ? C_INK : C_INK_75;
      g.fillRect(
        x - Math.round(d),
        top,
        Math.max(2, Math.round(2 * d)),
        Math.round((major ? COMPASS.tickMajor : COMPASS.tickMinor) * d),
      );
      g.font = major ? fontMajor : fontMinor;
      g.fillText(POINT_LABELS[i], x, base);
    }

    // THE SEAM. 'N' sits at 0°, i.e. centred on x=0, so its LEFT half falls off the canvas and
    // every pass through north would show half a letter. Drawing it again centred on x=tapeW
    // puts that missing half in the last few pixels of the tape (the right half clips away
    // instead) — which is precisely where the wrapping two-slice blit looks for degrees 359⁻.
    // Padding the canvas instead would break the modulo arithmetic in `drawCompass`.
    g.fillStyle = C_INK;
    g.font = fontMajor;
    g.fillText('N', this.tapeW, base);
    g.fillRect(this.tapeW - Math.round(d), top, Math.max(2, Math.round(2 * d)), Math.round(COMPASS.tickMajor * d));
  }

  /**
   * THE ARENA BAKE — 16,384 vertical `groundAt()` rays, once, at boot.
   *
   * WHY A HEIGHTFIELD AND NOT AN OUTLINE: `WorldService` publishes no floor plan, and this file
   * is not allowed to reach into `world/arena.ts` for one. What the contract does give is
   * `groundAt()`, and the height it returns separates the arena into exactly the three things a
   * minimap needs: street (the measured histogram puts 57% of cells at 0 m), raised decks and
   * docks (1–7 m), and building mass (20–37 m). Sampling it is therefore not a workaround — it
   * is the same query the AI uses, so the map can never disagree with where you can actually go.
   *
   * COST, measured in the node harness against the real collision octree:
   *   48² 6.2 ms · 64² 9.2 ms · 96² 18.7 ms · 128² 32.2 ms.
   * 128 cells over 140 m is 1.09 m per cell, which lands at ~4 device px on the blitted disc —
   * chunky enough to read as inked shapes, fine enough that a street mouth is still a street
   * mouth. 32 ms sits next to an arena build that already costs seconds.
   */
  private bakeArena(world: WorldService): void {
    const t0 = performance.now();
    const b = world.bounds;
    const minX = b.min.x;
    const minZ = b.min.z;
    const spanX = b.max.x - minX;
    const spanZ = b.max.z - minZ;
    if (spanX <= 0 || spanZ <= 0) return;

    // Bake scale: at or just above the on-screen scale, so the per-frame blit only ever DOWNsamples.
    const screenPpm = (MAP.size * this.dpr * 0.5 - 1) / MAP.rangeM;
    const ppm = Math.min(8, Math.max(3, Math.ceil(screenPpm)));
    this.bakePpm = ppm;
    this.bakeMinX = minX;
    this.bakeMinZ = minZ;

    const w = Math.ceil(spanX * ppm);
    const hgt = Math.ceil(spanZ * ppm);
    this.bake.width = w;
    this.bake.height = hgt;
    const g = ctx2d(this.bake);
    g.clearRect(0, 0, w, hgt);

    const n = BAKE.cells;
    const stepX = spanX / n;
    const stepZ = spanZ / n;
    // The datum is where the player starts, so "street level" means the same thing here as it
    // does to the person reading the map.
    const datum = world.playerSpawn.position.y;
    // One ray from just under the ceiling of the bounds: `groundAt` lifts its origin 0.6 m and
    // searches 140 m down, which clears the tallest roof in the arena (37 m) by a wide margin.
    const probeY = b.max.y - 1;

    // SAMPLE ONCE. The three fill passes below need each cell's class three times over, and
    // re-querying the octree for it would turn a 32 ms bake into a 96 ms one. Class 3 is "no
    // floor here at all" and is never drawn — it stays void.
    const cls = new Uint8Array(n * n);
    for (let iz = 0; iz < n; iz++) {
      const row = iz * n;
      for (let ix = 0; ix < n; ix++) {
        this.probe.set(minX + (ix + 0.5) * stepX, probeY, minZ + (iz + 0.5) * stepZ);
        const y = world.groundAt(this.probe);
        if (y === null) { cls[row + ix] = 3; continue; }
        const rel = y - datum;
        cls[row + ix] = rel >= BAKE.buildingM ? 2 : rel >= BAKE.raisedM ? 1 : 0;
      }
    }

    // Three batched paths — one per surface class — instead of 16,384 `fillRect`s with a
    // `fillStyle` write between each. Bake-time only, but it is also what keeps the edges hard:
    // adjacent cells in one path fuse into a single filled shape with no seam between them.
    for (let pass = 0; pass < 3; pass++) {
      g.beginPath();
      let any = false;
      for (let iz = 0; iz < n; iz++) {
        const row = iz * n;
        const z0 = Math.floor(iz * stepZ * ppm);
        const z1 = Math.floor((iz + 1) * stepZ * ppm);
        for (let ix = 0; ix < n; ix++) {
          if (cls[row + ix] !== pass) continue;
          const x0 = Math.floor(ix * stepX * ppm);
          const x1 = Math.floor((ix + 1) * stepX * ppm);
          g.rect(x0, z0, x1 - x0, z1 - z0);
          any = true;
        }
      }
      if (!any) continue;
      g.fillStyle = pass === 0 ? C_PAPER : pass === 1 ? C_RAISED : C_INK;
      g.fill();
    }

    this.bakeReady = true;
    this.bakeMs = performance.now() - t0;
  }

}

function sizeCanvas(c: HTMLCanvasElement, cssW: number, cssH: number, dpr: number): void {
  c.width = Math.round(cssW * dpr);
  c.height = Math.round(cssH * dpr);
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles. Its own <style> element so `hud.ts` needs nothing but a mount point.
//
// Everything comic about these two widgets that is NOT the drawing lives here, as CSS on a
// wrapper: the heavy ink border, the hard offset shadow (flat INK, never a blur), the halftone
// fill and the paper/void ground. It is composited once and never repainted, so the per-frame
// cost of the panel furniture is zero.
// ─────────────────────────────────────────────────────────────────────────────

function styleSheet(): string {
  const ink = css('INK');
  const dots = css('INK', 0.26);
  const void_ = css('INK_SOFT');
  const halftone = `radial-gradient(circle at 50% 50%, ${dots} 1.15px, transparent 1.35px)`;

  return `
/* ── THE COMPASS ─────────────────────────────────────────────────────────────
   Top centre, thin, and deliberately quiet: it sits directly above the crosshair and must not
   compete with it. NO transform on this element — see \`layout()\`; \`left\` is written in whole
   pixels by JS instead, because a half-pixel canvas is a resampled canvas.

   The edge mask fades both ends so the strip reads as a tape running past a window rather than
   as a panel with two hard stops. */
.cz-compass {
  position: absolute; top: 20px;
  width: ${COMPASS.width}px; height: ${COMPASS.height}px;
  background: ${css('PAPER', 0.86)};
  border: ${COMPASS.borderPx}px solid ${ink};
  box-shadow: 6px 6px 0 ${css('INK', 0.7)};
  opacity: .93;
}
.cz-compass > canvas {
  display: block;
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 13%, #000 87%, transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0%, #000 13%, #000 87%, transparent 100%);
}
.cz-compass::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background-image: ${halftone}; background-size: 5px 5px;
  mix-blend-mode: multiply;
}

/* ── THE MINIMAP ─────────────────────────────────────────────────────────────
   Top left, under the ROUND badge and the ENEMIES LEFT counter, which is where a shooter player
   already looks for it. A disc rather than a rectangle: the map is heading-up, and a rotating
   square shows its corners turning, which reads as the map being crooked rather than as the
   player turning.

   The ground under the drawing is INK_SOFT — anything outside the arena is void, not paper —
   and the arena's own floor is painted PAPER by the bake, so the walkable shape is literally
   the lit part of the panel. */
.cz-minimap {
  position: absolute; left: 28px; top: 172px;
  width: ${MAP.size}px; height: ${MAP.size}px;
  border-radius: 50%; overflow: hidden;
  background: ${void_};
  border: 5px solid ${ink};
  box-shadow: 7px 7px 0 ${css('INK', 0.75)};
}
.cz-minimap > canvas { display: block; }
/* Halftone over the whole disc: ink dots multiplying onto paper streets, which is what makes it
   read as printed rather than as a radar. Clipped to the circle like everything else here. */
.cz-minimap::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: 50%;
  background-image: ${halftone}; background-size: 5px 5px;
  mix-blend-mode: multiply;
}
/* An inner paper hairline, the way a printed panel has a keyline inside its border. */
.cz-minimap::before {
  content: ''; position: absolute; inset: 2px; pointer-events: none; z-index: 2;
  border-radius: 50%; border: 1px solid ${css('PAPER', 0.22)};
}
`;
}

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EXPECTED COST — the UI_SPEC §5 gate is ~0.3 ms/frame for both together.
 *
 * COMPASS, per frame: 1 clearRect (380×26 CSS px), 2 drawImage slices of a 1728×52 tape at 1:1
 * (no resample — the offset is integer), 1 triangle, 1 fillRect, 1 fillText of a 3-glyph string
 * from a preallocated table, plus ≤6 beacon diamonds. ~15–25 µs.
 *
 * MINIMAP, per frame: 1 clearRect + 1 circular clip (336² device px at DPR 2), 1 rotated
 * drawImage of the 560² bake into that clip, 1 stroked arc, 2 batched dot paths (one fill + one
 * stroke each regardless of how many bodies are alive — 28 alive is 4 draw calls, not 56), a
 * cone, a 4-point arrow and one 'N'. ~90–150 µs, dominated by the rotated blit.
 *
 * TOGETHER: ~0.11–0.18 ms, inside budget, and ZERO on any frame where gameplay time did not
 * advance and the player did not turn (pause, the boon draw, the back cover, a hidden HUD).
 *
 * ALLOCATION per frame: none. No array is built, no string is concatenated, no object or vector
 * is constructed; every colour, font and label string is resolved at construction or module load.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

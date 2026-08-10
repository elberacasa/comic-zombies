/**
 * DEBUG — the stats panel and the world-space debug draw.
 *
 * Two jobs:
 *  • `watch(label, getter)` — a live readout in a comic-styled panel, top-left. Every system
 *    registers what it wants to tune in `init`, and we can see the game's brain while playing.
 *  • `line`/`point`/`box`/`ray` — world-space overlay drawn from ONE pooled LineSegments buffer,
 *    so a thousand debug lines is still a single draw call. Entries expire on a timer.
 *
 * COST WHEN OFF: the panel is `display:none` and no getter is evaluated; debug draw calls return
 * on a boolean check before touching a buffer; the mesh is `visible = false` so the renderer skips
 * it. Leave `debug.line(...)` calls in shipping code — they cost a branch.
 *
 * Toggle with the backquote key (`), or `?debug=1` in the URL to boot enabled.
 */

import {
  BufferAttribute, BufferGeometry, DynamicDrawUsage, LineBasicMaterial, LineSegments,
} from 'three';
import type { Box3, Scene, Vector3 } from 'three';
import type { DebugService, GameCtx, System, Time } from '@/core/types';
import type { PerfStats } from '@/core/loop';
import { PALETTE, css, color } from '@/art/palette';
import { RingBuffer } from '@/core/pool';

/** Segment capacity. 4096 segments = 8192 verts = nothing, and it never grows at runtime. */
const MAX_SEGMENTS = 4096;
const LOG_LINES = 8;
/** Panel refresh rate. 10 Hz — fast enough to read, slow enough to be free. */
const PANEL_HZ = 10;
const POINT_SIZE = 0.07;

/**
 * PANEL COLUMN WIDTH, and the reason columns exist at all.
 *
 * BUILD 005 pushed the watch list to 71 rows (navigation, pathing, unstick, nav draw, the
 * viewmodel's clearance readouts, the audio bus) and the single-column panel measured 1206 px
 * tall in an 821 px viewport — MEASURED. Everything a milestone had just added was below the
 * fold, in the one tool whose entire job is to show you what the game is doing.
 *
 * So the rows container is a WRAPPING COLUMN FLEX capped at the viewport: rows fill a column,
 * then start a new one to the right. A fixed row width is what makes wrapping possible at all
 * (a flex item with `justify-content: space-between` and no width collapses to its content).
 */
const ROW_WIDTH = 196;
/** Room for the panel's own title bar, hint line and border. */
const PANEL_CHROME = 74;

interface Watch {
  label: string;
  getter: () => string | number;
  row: HTMLDivElement;
  value: HTMLSpanElement;
  last: string;
}

export interface DebugOptions {
  /** Start enabled. Defaults to `?debug=1` in the URL. */
  enabled?: boolean;
  /** Attach the DOM panel here. Defaults to document.body. */
  container?: HTMLElement;
}

export class DebugSystem implements DebugService, System {
  readonly name = 'debug';

  private _enabled: boolean;
  private readonly container: HTMLElement;

  // DOM
  private root: HTMLDivElement | null = null;
  private rows: HTMLDivElement | null = null;
  private logEl: HTMLDivElement | null = null;
  private readonly watches: Watch[] = [];
  private readonly watchByLabel = new Map<string, Watch>();
  private readonly logs = new RingBuffer<string>(LOG_LINES);
  private nextPanelUpdate = 0;
  private logDirty = false;

  // Debug draw
  private readonly positions = new Float32Array(MAX_SEGMENTS * 6);
  private readonly colors = new Float32Array(MAX_SEGMENTS * 6);
  private readonly expiry = new Float64Array(MAX_SEGMENTS);
  private segCount = 0;
  private geometry: BufferGeometry | null = null;
  private lines: LineSegments | null = null;
  private posAttr: BufferAttribute | null = null;
  private colAttr: BufferAttribute | null = null;
  private scene: Scene | null = null;

  /**
   * The clock every segment is stamped against.
   *
   * THIS USED TO BE A CACHED NUMBER, refreshed at the top of `update()`, and it made the whole
   * debug-draw buffer a no-op for any system registered BEFORE this one — which is every system
   * that would ever want to draw, since `debug` sits at the end of the order so it can see the
   * finished frame. Sequence: a system draws in frame N and stamps `expiry = now`, but `now` is
   * still frame N−1's timestamp because `update()` has not run yet; `update()` then advances
   * `now` to frame N and `expireSegments` immediately drops the line as already expired. Nothing
   * was ever uploaded. BUILD 005's nav overlay was the first consumer of `line()` in the
   * project's life, which is why it took until now to find.
   *
   * Reading the live clock instead makes the stamp correct no matter where in the order the
   * caller sits: `unscaledElapsed` advances exactly once per frame, in `beginFrame`, so every
   * draw inside frame N stamps the same value and a `seconds = 0` line survives precisely one
   * frame. Systems that draw must still be registered before `debug`, which is the ordering the
   * buffer has always implied — but now that ordering WORKS.
   */
  private time: Time | null = null;
  private now = 0;
  private perf: PerfStats | null = null;
  private disposed = false;

  constructor(opts: DebugOptions = {}) {
    this.container = opts.container ?? document.body;
    const fromUrl = typeof location !== 'undefined' && /[?&]debug=1/.test(location.search);
    this._enabled = opts.enabled ?? fromUrl;
    window.addEventListener('keydown', this.onKeyDown);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  init(ctx: GameCtx): void {
    this.scene = ctx.scene;
    this.time = ctx.time;
    this.now = ctx.time.unscaledElapsed;
    this.buildDrawBuffer();
    this.buildPanel();
    this.applyEnabled();
  }

  update(_dt: number, ctx: GameCtx): void {
    // Same value the draw calls earlier in this frame already stamped themselves with — see the
    // `time` field. Kept so `now` is still meaningful if `init` never ran.
    this.now = ctx.time.unscaledElapsed;
    if (!this._enabled) return;
    this.expireSegments();
    this.uploadSegments();
    if (this.now >= this.nextPanelUpdate) {
      this.nextPanelUpdate = this.now + 1 / PANEL_HZ;
      this.refreshPanel();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.lines && this.scene) this.scene.remove(this.lines);
    this.geometry?.dispose();
    (this.lines?.material as LineBasicMaterial | undefined)?.dispose();
    this.root?.remove();
    this.root = null;
    this.watches.length = 0;
    this.watchByLabel.clear();
  }

  // ── DebugService ───────────────────────────────────────────────────────────

  get enabled(): boolean { return this._enabled; }

  toggle(): void { this.setEnabled(!this._enabled); }

  setEnabled(v: boolean): void {
    if (this._enabled === v) return;
    this._enabled = v;
    this.applyEnabled();
  }

  /**
   * Register a live readout. Call once, in `init` — the getter runs at `PANEL_HZ`, never per
   * frame, so it may be as expensive as a string build. Re-registering a label replaces it.
   */
  watch(label: string, getter: () => string | number): void {
    const existing = this.watchByLabel.get(label);
    if (existing) { existing.getter = getter; return; }
    const row = document.createElement('div');
    // FIXED WIDTH is what lets the rows container wrap into columns — see `buildPanel`.
    row.style.cssText =
      `display:flex;justify-content:space-between;gap:14px;line-height:1.45;width:${ROW_WIDTH}px;`;
    const k = document.createElement('span');
    k.textContent = label;
    k.style.cssText = `opacity:0.62;letter-spacing:0.06em;`;
    const v = document.createElement('span');
    v.textContent = '–';
    v.style.cssText = `color:${css('GOLD')};font-weight:700;text-align:right;`;
    row.appendChild(k);
    row.appendChild(v);
    const w: Watch = { label, getter, row, value: v, last: '' };
    this.watches.push(w);
    this.watchByLabel.set(label, w);
    this.rows?.appendChild(row);
  }

  /** Wire the loop's perf counters into the panel. Call once from `main.ts`. */
  bindPerf(stats: PerfStats): void {
    if (this.perf) return;
    this.perf = stats;
    this.watch('fps', () => stats.fps.toFixed(0));
    this.watch('frame ms', () => `${stats.frameMs.toFixed(2)} (max ${stats.worstFrameMs.toFixed(1)})`);
    this.watch('sim ms', () => `${stats.simMs.toFixed(2)} ×${stats.steps}`);
    this.watch('update ms', () => stats.updateMs.toFixed(2));
    this.watch('render ms', () => stats.renderMs.toFixed(2));
    this.watch('dropped', () => stats.dropped);
  }

  /** A world-space line. `seconds` 0 = one frame. */
  line(from: Vector3, to: Vector3, hex: number = PALETTE.ELECTRIC, seconds = 0): void {
    if (!this._enabled || this.segCount >= MAX_SEGMENTS) return;
    const i = this.segCount * 6;
    const p = this.positions;
    p[i] = from.x; p[i + 1] = from.y; p[i + 2] = from.z;
    p[i + 3] = to.x; p[i + 4] = to.y; p[i + 5] = to.z;
    const c = color(hex);
    const col = this.colors;
    col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b;
    col[i + 3] = c.r; col[i + 4] = c.g; col[i + 5] = c.b;
    this.expiry[this.segCount] = this.stamp() + Math.max(0, seconds);
    this.segCount++;
  }

  /** A small 3-axis cross. */
  point(at: Vector3, hex: number = PALETTE.HOT, seconds = 0): void {
    if (!this._enabled) return;
    const s = POINT_SIZE;
    this.rawSegment(at.x - s, at.y, at.z, at.x + s, at.y, at.z, hex, seconds);
    this.rawSegment(at.x, at.y - s, at.z, at.x, at.y + s, at.z, hex, seconds);
    this.rawSegment(at.x, at.y, at.z - s, at.x, at.y, at.z + s, hex, seconds);
  }

  /** Origin + direction × length. Direction need not be normalised. */
  ray(origin: Vector3, dir: Vector3, length = 1, hex: number = PALETTE.ACID, seconds = 0): void {
    if (!this._enabled) return;
    this.rawSegment(
      origin.x, origin.y, origin.z,
      origin.x + dir.x * length, origin.y + dir.y * length, origin.z + dir.z * length,
      hex, seconds,
    );
  }

  /** Wireframe AABB — spawn volumes, arena bounds, hitboxes. */
  box(b: Box3, hex: number = PALETTE.GOLD, seconds = 0): void {
    if (!this._enabled) return;
    const { min, max } = b;
    const x0 = min.x, y0 = min.y, z0 = min.z;
    const x1 = max.x, y1 = max.y, z1 = max.z;
    // bottom
    this.rawSegment(x0, y0, z0, x1, y0, z0, hex, seconds);
    this.rawSegment(x1, y0, z0, x1, y0, z1, hex, seconds);
    this.rawSegment(x1, y0, z1, x0, y0, z1, hex, seconds);
    this.rawSegment(x0, y0, z1, x0, y0, z0, hex, seconds);
    // top
    this.rawSegment(x0, y1, z0, x1, y1, z0, hex, seconds);
    this.rawSegment(x1, y1, z0, x1, y1, z1, hex, seconds);
    this.rawSegment(x1, y1, z1, x0, y1, z1, hex, seconds);
    this.rawSegment(x0, y1, z1, x0, y1, z0, hex, seconds);
    // uprights
    this.rawSegment(x0, y0, z0, x0, y1, z0, hex, seconds);
    this.rawSegment(x1, y0, z0, x1, y1, z0, hex, seconds);
    this.rawSegment(x1, y0, z1, x1, y1, z1, hex, seconds);
    this.rawSegment(x0, y0, z1, x0, y1, z1, hex, seconds);
  }

  /** Throttled, deduplicated console output that also lands in the panel. */
  log(...args: unknown[]): void {
    if (!this._enabled) return;
    let s = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      s += (i ? ' ' : '') + (typeof a === 'string' ? a : safeStringify(a));
    }
    if (this.logs.last === s) return;
    this.logs.push(s);
    this.logDirty = true;
    console.log('%c[cz]', `color:${css('ELECTRIC')}`, ...args);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** This frame's timestamp, valid at any point in the system order. */
  private stamp(): number {
    return this.time !== null ? this.time.unscaledElapsed : this.now;
  }

  private rawSegment(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    hex: number, seconds: number,
  ): void {
    if (this.segCount >= MAX_SEGMENTS) return;
    const i = this.segCount * 6;
    const p = this.positions;
    p[i] = ax; p[i + 1] = ay; p[i + 2] = az;
    p[i + 3] = bx; p[i + 4] = by; p[i + 5] = bz;
    const c = color(hex);
    const col = this.colors;
    col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b;
    col[i + 3] = c.r; col[i + 4] = c.g; col[i + 5] = c.b;
    this.expiry[this.segCount] = this.stamp() + Math.max(0, seconds);
    this.segCount++;
  }

  /** Swap-remove expired segments. O(live), no allocation. */
  private expireSegments(): void {
    const now = this.now;
    const p = this.positions;
    const c = this.colors;
    let i = 0;
    while (i < this.segCount) {
      if (this.expiry[i] < now) {
        const last = this.segCount - 1;
        if (i !== last) {
          const dst = i * 6;
          const src = last * 6;
          for (let k = 0; k < 6; k++) { p[dst + k] = p[src + k]; c[dst + k] = c[src + k]; }
          this.expiry[i] = this.expiry[last];
        }
        this.segCount--;
      } else {
        i++;
      }
    }
  }

  private uploadSegments(): void {
    const geo = this.geometry;
    const lines = this.lines;
    if (!geo || !lines || !this.posAttr || !this.colAttr) return;
    const verts = this.segCount * 2;
    lines.visible = verts > 0;
    if (verts === 0) return;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    geo.setDrawRange(0, verts);
  }

  private buildDrawBuffer(): void {
    if (this.geometry || !this.scene) return;
    const geo = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.positions, 3);
    this.colAttr = new BufferAttribute(this.colors, 3);
    this.posAttr.setUsage(DynamicDrawUsage);
    this.colAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);
    const mat = new LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
    });
    const lines = new LineSegments(geo, mat);
    lines.name = 'debug-lines';
    lines.frustumCulled = false;
    lines.renderOrder = 9999;
    lines.visible = false;
    this.geometry = geo;
    this.lines = lines;
    this.scene.add(lines);
  }

  // ── the panel (ART_DIRECTION §7: ink border, hard shadow, halftone fill) ────

  private buildPanel(): void {
    if (this.root) return;
    const root = document.createElement('div');
    root.id = 'cz-debug';
    root.style.cssText = [
      'position:fixed', 'top:14px', 'left:14px', 'z-index:9999',
      // No max-width: the rows wrap into as many columns as the viewport height needs.
      'min-width:212px',
      'padding:0 0 8px 0',
      `background-color:${css('INK', 0.94)}`,
      `background-image:radial-gradient(${css('INK_SOFT')} 1px, transparent 1.3px)`,
      'background-size:5px 5px',
      `border:3px solid ${css('PAPER')}`,
      `box-shadow:6px 6px 0 ${css('INK')}`,
      `color:${css('PAPER')}`,
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace",
      'font-size:11px', 'font-weight:600',
      'letter-spacing:0.02em',
      'text-transform:uppercase',
      'transform:rotate(-0.4deg)',
      'pointer-events:none',
      'user-select:none',
      'display:none',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'COMIC ZOMBIES // DEBUG';
    title.style.cssText = [
      `background:${css('PAPER')}`, `color:${css('INK')}`,
      'padding:3px 8px', 'font-weight:800', 'letter-spacing:0.14em', 'font-size:10px',
      'margin-bottom:6px',
    ].join(';');
    root.appendChild(title);

    const rows = document.createElement('div');
    rows.style.cssText = [
      'padding:0 9px',
      'display:flex', 'flex-direction:column', 'flex-wrap:wrap',
      'align-content:flex-start',
      'column-gap:18px',
      `max-height:calc(100vh - ${PANEL_CHROME}px)`,
    ].join(';');
    root.appendChild(rows);

    const log = document.createElement('div');
    log.style.cssText = [
      'padding:6px 9px 0 9px', 'margin-top:6px',
      `border-top:2px solid ${css('INK_SOFT')}`,
      `color:${css('ACID')}`, 'text-transform:none', 'font-weight:500',
      'font-size:10px', 'line-height:1.35', 'white-space:pre-wrap', 'word-break:break-word',
      'display:none',
    ].join(';');
    root.appendChild(log);

    const hint = document.createElement('div');
    hint.textContent = '` toggles';
    hint.style.cssText = `padding:7px 9px 0 9px;opacity:0.35;font-size:9px;letter-spacing:0.1em;`;
    root.appendChild(hint);

    this.container.appendChild(root);
    this.root = root;
    this.rows = rows;
    this.logEl = log;
    for (const w of this.watches) rows.appendChild(w.row);
  }

  private refreshPanel(): void {
    for (let i = 0; i < this.watches.length; i++) {
      const w = this.watches[i];
      let s: string;
      try {
        const raw = w.getter();
        s = typeof raw === 'number'
          ? (Number.isInteger(raw) ? String(raw) : raw.toFixed(2))
          : raw;
      } catch {
        s = 'ERR';
      }
      if (s !== w.last) { w.last = s; w.value.textContent = s; }
    }
    if (this.logDirty && this.logEl) {
      this.logDirty = false;
      let text = '';
      this.logs.forEach((l, i) => { text += (i ? '\n' : '') + l; });
      this.logEl.textContent = text;
      this.logEl.style.display = text ? 'block' : 'none';
    }
  }

  private applyEnabled(): void {
    if (this.root) this.root.style.display = this._enabled ? 'block' : 'none';
    if (!this._enabled) {
      this.segCount = 0;
      if (this.lines) this.lines.visible = false;
      if (this.geometry) this.geometry.setDrawRange(0, 0);
    } else {
      this.nextPanelUpdate = 0;
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== 'Backquote' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    this.toggle();
  };
}

function safeStringify(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

export function createDebug(opts?: DebugOptions): DebugSystem {
  return new DebugSystem(opts);
}

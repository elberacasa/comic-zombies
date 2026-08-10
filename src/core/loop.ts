/**
 * GAME LOOP — fixed-timestep simulation, interpolated presentation.
 *
 * The sim runs at exactly 120 Hz (`FIXED_DT`) no matter what the display does. A 144 Hz monitor
 * and a 30 fps laptop run the *same* physics, the same recoil, the same enemy steering. Nothing
 * gameplay-critical ever reads `frameDt`.
 *
 * Frame order — this is the contract every system is written against:
 *
 *   1. time.beginFrame()      real delta, clamped; hitstop/slow-mo resolved
 *   2. input.beginFrame()     buffered device events published as this frame's edges
 *   3. fixedUpdate × N        deterministic gameplay, dt === FIXED_DT, N capped
 *   4. update                 presentation, variable dt: animation, VFX, cameras
 *   5. lateUpdate(alpha)      interpolation and anything that must see the finished world
 *   6. render(alpha)          the draw call
 *   7. input.endFrame()       edges cleared
 *
 * SPIRAL OF DEATH: if a frame takes longer than the steps it owes, the accumulator grows, which
 * means more steps next frame, which makes it slower still. We cap catch-up at `maxSteps` and
 * discard the debt — the game slows down for a moment instead of freezing forever.
 */

import { FIXED_DT } from '@/core/types';
import type { GameCtx, System } from '@/core/types';
import type { GameTime } from '@/core/time';
import { RollingAverage } from '@/core/pool';

/** The slice of InputService the loop drives. Keeps the loop testable without a DOM. */
export interface FrameInput {
  beginFrame(): void;
  endFrame(): void;
}

export interface PerfStats {
  /** Smoothed frames per second. */
  fps: number;
  /** Whole-frame cost, ms, smoothed. */
  frameMs: number;
  /** Worst frame in the last ~2s — the number that reveals hitching. */
  worstFrameMs: number;
  /** Time in fixedUpdate, ms. Budget: 3ms. */
  simMs: number;
  /** Time in update + lateUpdate, ms. */
  updateMs: number;
  /** Time in the render callback, ms. */
  renderMs: number;
  /** Fixed steps executed this frame. Steady state at 60fps is 2. */
  steps: number;
  /** Frames where the step cap was hit and simulation debt was dropped. */
  dropped: number;
  frame: number;
  systems: number;
}

export interface GameLoopOptions {
  ctx: GameCtx;
  time: GameTime;
  input: FrameInput;
  /** Draw. `alpha` is the fixed-step interpolant, 0..1, for smoothing between sim states. */
  render: (alpha: number) => void;
  /** Catch-up cap. 5 steps @120Hz covers a 41ms frame before we start shedding time. */
  maxSteps?: number;
  /** Called if a system throws. The loop stops rather than spamming the console 60×/second. */
  onError?: (err: unknown) => void;
}

export class GameLoop {
  readonly stats: PerfStats = {
    fps: 0, frameMs: 0, worstFrameMs: 0, simMs: 0, updateMs: 0, renderMs: 0,
    steps: 0, dropped: 0, frame: 0, systems: 0,
  };

  private readonly systems: System[] = [];
  private readonly ctx: GameCtx;
  private readonly time: GameTime;
  private readonly input: FrameInput;
  private readonly renderFn: (alpha: number) => void;
  private readonly maxSteps: number;
  private readonly onError: ((err: unknown) => void) | null;

  private accumulator = 0;
  private rafId = 0;
  private _running = false;
  private _started = false;
  private _disposed = false;

  private readonly avgFrame = new RollingAverage(90);
  private readonly avgSim = new RollingAverage(90);
  private readonly avgUpdate = new RollingAverage(90);
  private readonly avgRender = new RollingAverage(90);
  private readonly peakFrame = new RollingAverage(120);

  constructor(opts: GameLoopOptions) {
    this.ctx = opts.ctx;
    this.time = opts.time;
    this.input = opts.input;
    this.renderFn = opts.render;
    this.maxSteps = Math.max(1, opts.maxSteps ?? 5);
    this.onError = opts.onError ?? null;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get running(): boolean { return this._running; }
  /** Registration order — the order systems are updated in. */
  get all(): readonly System[] { return this.systems; }

  /** Register a system. Order matters: later systems see this frame's results of earlier ones. */
  add<T extends System>(system: T): T {
    this.systems.push(system);
    this.stats.systems = this.systems.length;
    return system;
  }

  addAll(...systems: System[]): void {
    for (const s of systems) this.add(s);
  }

  find(name: string): System | undefined {
    return this.systems.find((s) => s.name === name);
  }

  /** Run every `init` in registration order, awaiting each, then start the frame loop. */
  async start(): Promise<void> {
    if (this._running || this._disposed) return;
    if (!this._started) {
      this._started = true;
      for (const s of this.systems) {
        if (s.init) await s.init(this.ctx);
      }
    }
    this._running = true;
    this.accumulator = 0;
    this.time.resync(performance.now());
    this.rafId = requestAnimationFrame(this.tick);
  }

  /** Halt the frame loop. Systems keep their state; `start()` resumes cleanly. */
  stop(): void {
    if (!this._running) return;
    this._running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** Run exactly one frame while stopped — frame-stepping for debugging. */
  stepOnce(): void {
    if (this._running) return;
    this.frame(performance.now());
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (let i = this.systems.length - 1; i >= 0; i--) {
      const s = this.systems[i];
      if (s.dispose) s.dispose();
    }
    this.systems.length = 0;
  }

  // ── the frame ──────────────────────────────────────────────────────────────

  private readonly tick = (nowMs: number): void => {
    if (!this._running) return;
    this.rafId = requestAnimationFrame(this.tick);
    this.frame(nowMs);
  };

  private frame(nowMs: number): void {
    const t0 = performance.now();
    const time = this.time;
    const systems = this.systems;
    const n = systems.length;

    try {
      time.beginFrame(nowMs);
      this.input.beginFrame();

      // ── 3. fixed simulation ────────────────────────────────────────────────
      const tSim = performance.now();
      this.accumulator += time.scaledFrameDt;
      let steps = 0;
      if (this.accumulator >= FIXED_DT) {
        time.enterFixed();
        while (this.accumulator >= FIXED_DT && steps < this.maxSteps) {
          for (let i = 0; i < n; i++) {
            const s = systems[i];
            if (s.fixedUpdate) s.fixedUpdate(FIXED_DT, this.ctx);
          }
          this.accumulator -= FIXED_DT;
          steps++;
        }
        time.exitFixed();
        if (this.accumulator >= FIXED_DT) {
          // We are behind and cannot catch up. Shed the debt: better a brief slow-motion
          // hiccup than an ever-growing backlog that locks the tab.
          this.accumulator = FIXED_DT * 0.5;
          this.stats.dropped++;
        }
      }
      const simMs = performance.now() - tSim;

      // ── 4/5. presentation ──────────────────────────────────────────────────
      const tUpd = performance.now();
      const frameDt = time.frameDt;
      for (let i = 0; i < n; i++) {
        const s = systems[i];
        if (s.update) s.update(frameDt, this.ctx);
      }
      const alpha = this.accumulator / FIXED_DT;
      for (let i = 0; i < n; i++) {
        const s = systems[i];
        if (s.lateUpdate) s.lateUpdate(alpha, this.ctx);
      }
      const updateMs = performance.now() - tUpd;

      // ── 6. draw ────────────────────────────────────────────────────────────
      const tRen = performance.now();
      this.renderFn(alpha);
      const renderMs = performance.now() - tRen;

      // ── 7. done ────────────────────────────────────────────────────────────
      this.input.endFrame();

      const frameMs = performance.now() - t0;
      this.avgFrame.push(frameMs);
      this.avgSim.push(simMs);
      this.avgUpdate.push(updateMs);
      this.avgRender.push(renderMs);
      this.peakFrame.push(frameMs);

      const st = this.stats;
      st.frameMs = this.avgFrame.avg;
      st.worstFrameMs = this.peakFrame.max;
      st.simMs = this.avgSim.avg;
      st.updateMs = this.avgUpdate.avg;
      st.renderMs = this.avgRender.avg;
      st.steps = steps;
      st.frame = time.frame;
      // Measure fps from wall-clock deltas, not from our own work, so it reflects vsync.
      if (time.frameDt > 0) st.fps = this.smoothedFps(time.frameDt);
    } catch (err) {
      this.stop();
      if (this.onError) this.onError(err);
      else console.error('[loop] system threw — loop stopped', err);
    }
  }

  private fpsAccum = 0;
  private smoothedFps(frameDt: number): number {
    const instant = frameDt > 0 ? 1 / frameDt : 0;
    // Heavy smoothing: a jittery fps counter is unreadable and invites bad conclusions.
    this.fpsAccum = this.fpsAccum === 0 ? instant : this.fpsAccum + (instant - this.fpsAccum) * 0.06;
    return this.fpsAccum;
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      // Throw away the debt accrued while hidden; rAF is throttled or stopped in a background tab.
      this.accumulator = 0;
    } else {
      this.accumulator = 0;
      this.time.resync(performance.now());
    }
  };
}

export function createLoop(opts: GameLoopOptions): GameLoop {
  return new GameLoop(opts);
}

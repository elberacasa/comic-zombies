/**
 * TIME — the clock, and the single most important juice primitive in the game.
 *
 * Two clocks run at once:
 *   • `unscaledElapsed` — real seconds. UI, VFX and the pause menu live here so they never freeze.
 *   • `elapsed` — gameplay seconds, scaled by hitstop / slow-mo / pause.
 *
 * HITSTOP (ART_DIRECTION §5): on a crit or kill we freeze gameplay time for 2–6 frames and let
 * the presentation keep running. It costs nothing and makes every impact feel three times
 * heavier. The critical detail is the recovery: the freeze must *snap* back to full speed on an
 * exponential ease, not ramp back linearly — a linear ramp reads as lag, an exponential snap
 * reads as impact. Stacking is by max, never by sum, so a shotgun blast that hits eight zombies
 * gives one crisp freeze instead of half a second of slideshow.
 */

import { FIXED_DT, MAX_FRAME_DT } from '@/core/types';
import type { Time } from '@/core/types';
import { easeOutExpo, clamp } from '@/core/mathx';

/** How fast gameplay time snaps back to full speed after a freeze. Short = snappy. */
const HITSTOP_RECOVERY = 0.055;
/** Hitstop never fully stops the clock — a sliver of motion keeps animation from looking dead. */
const HITSTOP_FLOOR = 0.02;
/** Refuse absurd freezes; anything longer is a slow-mo, not a hitstop. */
const HITSTOP_MAX = 0.25;

export class GameTime implements Time {
  elapsed = 0;
  unscaledElapsed = 0;
  dt = FIXED_DT;
  frameDt = 0;
  frame = 0;
  timeScale = 1;

  /** Hard pause (menu). Unscaled time keeps running so the menu can animate. */
  paused = false;

  /** Gameplay seconds this frame: `frameDt * effectiveScale`. The loop accumulates THIS. */
  scaledFrameDt = 0;

  /** The product of every scale layer this frame — what the world actually experienced. */
  effectiveScale = 1;

  private _hitstop = 0;
  private _hitstopRecover = 0;
  private _slowScale = 1;
  private _slowRemaining = 0;
  private _slowBlend = 0;
  private _lastNow = -1;
  private _frameDtBeforeFixed = 0;

  // ── frame lifecycle (driven by GameLoop) ───────────────────────────────────

  /**
   * Start a frame. `nowMs` is `performance.now()`. Returns the clamped real delta.
   * A tab that was hidden, a breakpoint, or a GC spike all show up here as a huge delta —
   * MAX_FRAME_DT clamps it so the sim never tries to catch up through a spiral of death.
   */
  beginFrame(nowMs: number): number {
    if (this._lastNow < 0) this._lastNow = nowMs;
    const raw = (nowMs - this._lastNow) * 0.001;
    this._lastNow = nowMs;

    this.frameDt = clamp(raw, 0, MAX_FRAME_DT);
    this.unscaledElapsed += this.frameDt;
    this.frame++;

    this.effectiveScale = this.paused ? 0 : this.timeScale * this.stepHitstop() * this.stepSlowmo();
    this.scaledFrameDt = this.frameDt * this.effectiveScale;
    this.elapsed += this.scaledFrameDt;

    this.dt = this.scaledFrameDt;
    this._frameDtBeforeFixed = this.scaledFrameDt;
    return this.frameDt;
  }

  /** The loop calls this around each fixed step so `time.dt` is always the right delta. */
  enterFixed(): void { this.dt = FIXED_DT; }
  exitFixed(): void { this.dt = this._frameDtBeforeFixed; }

  /** Discard accumulated wall-clock time — call after a stall (tab restored, assets built). */
  resync(nowMs: number): void {
    this._lastNow = nowMs;
    this.frameDt = 0;
    this.scaledFrameDt = 0;
  }

  // ── the juice ──────────────────────────────────────────────────────────────

  /**
   * Freeze gameplay for `seconds` of REAL time, then snap back. Stacks by max.
   * Rule of thumb: 0.03 body shot, 0.05 crit, 0.08 kill, 0.12 explosion.
   */
  hitstop(seconds: number): void {
    const s = clamp(seconds, 0, HITSTOP_MAX);
    if (s > this._hitstop) this._hitstop = s;
  }

  get hitstopActive(): boolean { return this._hitstop > 0; }
  /** 0..1 — how frozen we are right now. Audio ducking and post-fx read this. */
  get hitstopAmount(): number {
    if (this._hitstop > 0) return 1;
    return this._hitstopRecover > 0 ? this._hitstopRecover / HITSTOP_RECOVERY : 0;
  }

  /**
   * Timed slow motion — the Panel Break boon, nukes, the death cam. Unlike hitstop this is a
   * *scale*, so the player keeps playing, and it blends back over `blendOut` seconds.
   */
  slowmo(scale: number, seconds: number, blendOut = 0.4): void {
    if (seconds <= this._slowRemaining && scale >= this._slowScale) return;
    this._slowScale = clamp(scale, 0, 1);
    this._slowRemaining = seconds;
    this._slowBlend = Math.max(blendOut, 1e-3);
  }

  clearSlowmo(): void {
    this._slowRemaining = 0;
    this._slowScale = 1;
  }

  /** Kill every time distortion instantly — round transitions, respawn, game over. */
  clearDistortion(): void {
    this._hitstop = 0;
    this._hitstopRecover = 0;
    this.clearSlowmo();
    this.timeScale = 1;
  }

  reset(): void {
    this.elapsed = 0;
    this.unscaledElapsed = 0;
    this.frame = 0;
    this.frameDt = 0;
    this.scaledFrameDt = 0;
    this.dt = FIXED_DT;
    this.paused = false;
    this._lastNow = -1;
    this.clearDistortion();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Returns this frame's hitstop multiplier and advances the freeze/recovery state machine. */
  private stepHitstop(): number {
    if (this._hitstop > 0) {
      this._hitstop -= this.frameDt;
      if (this._hitstop <= 0) {
        this._hitstop = 0;
        this._hitstopRecover = HITSTOP_RECOVERY;
      }
      return HITSTOP_FLOOR;
    }
    if (this._hitstopRecover > 0) {
      this._hitstopRecover = Math.max(0, this._hitstopRecover - this.frameDt);
      const t = 1 - this._hitstopRecover / HITSTOP_RECOVERY;
      // Snap, don't ramp: 90% of the speed is back in the first third of the recovery.
      return HITSTOP_FLOOR + (1 - HITSTOP_FLOOR) * easeOutExpo(t);
    }
    return 1;
  }

  private stepSlowmo(): number {
    if (this._slowRemaining <= 0) {
      if (this._slowScale >= 1) return 1;
      // Blending back out after the timer expired.
      this._slowScale = Math.min(1, this._slowScale + this.frameDt / this._slowBlend);
      return this._slowScale;
    }
    this._slowRemaining -= this.frameDt;
    return this._slowScale;
  }
}

/** The clock. One per game; `main.ts` owns it and hands it out through `GameCtx`. */
export function createTime(): GameTime {
  return new GameTime();
}

/**
 * THE COMBO METER — GAME_BIBLE §5.
 *
 * Consecutive kills inside a shrinking window ramp a multiplier ×1 → ×5. Taking damage resets
 * it to zero. That is the entire rule set, and it is the mechanic that pays for aggression:
 * every other system in the game rewards you for being careful, and this one only pays if you
 * keep moving forward.
 *
 * TWO DESIGN DECISIONS THAT ARE NOT OBVIOUS FROM THE BIBLE LINE:
 *
 *  1. THE LADDER IS EXPLICIT, NOT ARITHMETIC. A "step every N kills" ramp makes the top of the
 *     meter a function of round size — at 8 zombies (round 1) ×5 is unreachable, at 50 (round
 *     20) it is automatic. `ROUND.comboLadder` sets the four thresholds directly, so ×3 is a
 *     good kite pass in any round and ×5 is 14 unbroken kills in any round.
 *  2. THE WINDOW CLOSES AS YOU CLIMB. At ×1 you have `ROUND.comboWindow` seconds of grace; at
 *     ×5 you have `ROUND.comboWindowAtMax`. Without this, ×5 is a state you park in — you reach
 *     it once in a big round and it never drops, which turns the meter from a risk into a
 *     formality. With it, the top of the ladder is a tightrope you can feel.
 *
 * The meter owns NO presentation. It emits `combo:changed` and the HUD, the audio bed (which
 * pitches `combo_tick` up the ladder) and the economy all read it from there.
 */

import type { EventBus } from '@/core/types';
import { ROUND } from '@/game/tuning';

export class ComboMeter {
  private _combo = 0;
  private _multiplier = 1;
  private _best = 0;
  /** Seconds of grace left before the chain lapses. 0 = no chain running. */
  private _grace = 0;
  /**
   * Multiplier on every window, fed by the director once per round from that round's own TTK.
   * See `ROUND.comboWindowRoundScaleMax`: a fixed window turns a difficulty increase into a
   * combo decrease, because a round-10 zombie takes ~2.5× as long to kill as a round-1 one.
   */
  private _roundScale = 1;
  /** Highest multiplier the chain has actually reached this run — the tuning readout. */
  private _bestMultiplier = 1;

  /**
   * The bus arrives as a GETTER, not as a value. The meter is built in the director's
   * constructor (so `RoundService.combo` is answerable the instant the service exists) while
   * `GameCtx` only arrives in `init()` — a lazy lookup is the whole of that gap, and it costs
   * one property read per emit.
   */
  constructor(private readonly bus: () => EventBus | null) {}

  /** Consecutive kills in the current chain. */
  get combo(): number { return this._combo; }
  /** The payout multiplier the chain is currently worth, 1..`ROUND.comboMaxMultiplier`. */
  get multiplier(): number { return this._multiplier; }
  /** High-water mark for the run — reported in `game:over`. */
  get best(): number { return this._best; }
  /** Highest multiplier reached this run. The combo ladder's own acceptance test, on screen. */
  get bestMultiplier(): number { return this._bestMultiplier; }

  /**
   * Set the round's TTK stretch. The director passes `sqrt(hpScale)`, clamped — the meter never
   * learns what a round or an enemy is, it just takes a number.
   */
  setRoundScale(scale: number): void {
    this._roundScale = Math.max(1, Math.min(ROUND.comboWindowRoundScaleMax, scale));
  }
  /** Seconds of grace left, for the HUD's drain bar. */
  get grace(): number { return this._grace; }
  /** 0..1 of the current window still left. */
  get graceFraction(): number {
    const w = this.windowFor(this._multiplier);
    return w > 0 ? Math.min(1, this._grace / w) : 0;
  }

  /** A kill landed. Extends the chain and re-arms the (now possibly shorter) window. */
  onKill(): void {
    this._combo++;
    if (this._combo > this._best) this._best = this._combo;
    const mult = this.multiplierFor(this._combo);
    if (mult > this._bestMultiplier) this._bestMultiplier = mult;
    this._grace = this.windowFor(mult);
    if (mult !== this._multiplier) {
      this._multiplier = mult;
      this.publish();
    } else {
      // The count changed even when the tier did not — the HUD shows both.
      this.publish();
    }
  }

  /** The player was touched. GAME_BIBLE §5: the chain dies, immediately and completely. */
  onDamaged(): void {
    if (this._combo === 0 && this._multiplier === 1) return;
    this.breakChain();
  }

  /** Round boundary / new run. Silent unless something was actually running. */
  reset(): void {
    this._grace = 0;
    if (this._combo === 0 && this._multiplier === 1) return;
    this.breakChain();
  }

  /** Clear the run's high-water mark too. New run only. */
  resetRun(): void {
    this.reset();
    this._best = 0;
    this._bestMultiplier = 1;
  }

  /** Fixed-step. The window is gameplay time, so it freezes with hitstop — as it should. */
  tick(dt: number): void {
    if (this._grace <= 0) return;
    this._grace -= dt;
    if (this._grace <= 0) {
      this._grace = 0;
      this.breakChain();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────

  private breakChain(): void {
    this._combo = 0;
    this._multiplier = 1;
    this._grace = 0;
    this.publish();
  }

  private publish(): void {
    this.bus()?.emit('combo:changed', { combo: this._combo, multiplier: this._multiplier });
  }

  /**
   * Ladder lookup. `comboLadder[i]` is the kill count at which the multiplier becomes `i + 2`,
   * so a four-entry ladder tops out at ×5 — and the result is clamped by
   * `ROUND.comboMaxMultiplier` so shortening the ladder can never desync the two.
   */
  private multiplierFor(combo: number): number {
    const ladder = ROUND.comboLadder;
    let mult = 1;
    for (let i = 0; i < ladder.length; i++) {
      const need = ladder[i];
      if (need === undefined || combo < need) break;
      mult = i + 2;
    }
    return Math.min(mult, ROUND.comboMaxMultiplier);
  }

  /** Grace window for a given multiplier — linear from `comboWindow` down to `comboWindowAtMax`. */
  private windowFor(multiplier: number): number {
    const span = Math.max(1, ROUND.comboMaxMultiplier - 1);
    const t = Math.min(1, Math.max(0, (multiplier - 1) / span));
    return (ROUND.comboWindow + (ROUND.comboWindowAtMax - ROUND.comboWindow) * t) * this._roundScale;
  }
}

/**
 * THE ECONOMY — GAME_BIBLE §5, and the persistent meta from §7.
 *
 * Every point the player ever earns goes through `award()`. That is the whole reason this file
 * exists as a separate object from the director: there is exactly ONE place where the combo
 * multiplier, the DOUBLE POINTS power-up and the surge reward multiplier are composed, so they
 * can never disagree about what a kill is worth.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE MULTIPLIER STACK, in order, and who owns each factor:
 *
 *      base            ROUND.pointsHit / pointsKill / pointsCritKill / bonuses   (this file)
 *    × combo           ComboMeter.multiplier, ×1..×5                             (combo.ts)
 *    × doublePoints    ROUND.doublePointsMult while the power-up is up           (director)
 *    × reward          ROUND.surgeRewardMult on a surge round                    (director)
 *    × stats.pointsMult                                                          (BOONS)
 *
 *  The last factor is applied inside `PlayerService.addPoints`, NOT here. That is deliberate:
 *  `pointsMult` is a `PlayerStats` field and the boon modifier stack owns it, so routing every
 *  award through `addPoints` is what makes a points boon work without this file ever knowing a
 *  boon exists. It is also what emits `player:points` for the HUD to animate.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * CONTRACT NOTE for whoever wires the floating "+60" popups: `player:points` carries an
 * optional `worldPos`, but `PlayerService.addPoints(amount, reason)` has no position parameter,
 * so the payload this file produces never has one. A HUD that wants the number to fly out of
 * the corpse should listen to `enemy:killed` for the position and to `player:points` for the
 * value, or `core/types.ts` needs a third `addPoints` argument (a contract change we did not
 * make unilaterally).
 */

import type { PlayerService } from '@/core/types';
import { ROUND } from '@/game/tuning';
import type { ComboMeter } from '@/game/rounds/combo';

// ─────────────────────────────────────────────────────────────────────────────
// Persistent meta (GAME_BIBLE §7). ONE namespaced key, and it may never throw.
// ─────────────────────────────────────────────────────────────────────────────

export interface MetaSave {
  bestRound: number;
  totalKills: number;
  bestPoints: number;
  runs: number;
}

const EMPTY_META: MetaSave = { bestRound: 0, totalKills: 0, bestPoints: 0, runs: 0 };

/** `unknown` in, a whole `MetaSave` out. Never trusts the blob — a user can edit it. */
function normalizeMeta(raw: unknown): MetaSave {
  const out: MetaSave = { ...EMPTY_META };
  if (typeof raw !== 'object' || raw === null) return out;
  const rec = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  out.bestRound = num(rec['bestRound']);
  out.totalKills = num(rec['totalKills']);
  out.bestPoints = num(rec['bestPoints']);
  out.runs = num(rec['runs']);
  return out;
}

/**
 * Safari in private mode throws on `localStorage` *access*, not just on `setItem`, and a
 * DOMException thrown out of `init()` would take the whole loop down (`main.ts` catches system
 * errors and shows PANEL TORN). So both halves are fully guarded and both fail to "no meta".
 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadMeta(): MetaSave {
  const s = storage();
  if (!s) return { ...EMPTY_META };
  try {
    const raw = s.getItem(ROUND.metaKey);
    if (raw === null) return { ...EMPTY_META };
    return normalizeMeta(JSON.parse(raw) as unknown);
  } catch {
    return { ...EMPTY_META };
  }
}

export function saveMeta(meta: MetaSave): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(ROUND.metaKey, JSON.stringify(meta));
  } catch {
    // Quota, private browsing, a disabled storage partition. The run still plays.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

/** Everything `game:over` reports, accumulated live. */
export interface RunStats {
  round: number;
  kills: number;
  bestCombo: number;
  timeSurvived: number;
  points: number;
}

export class Economy {
  /** DOUBLE POINTS, 1 or `ROUND.doublePointsMult`. The director owns the timer. */
  doublePoints = 1;
  /** Surge round payout multiplier. The director sets it at every round start. */
  rewardMult = 1;

  /** Kills this run. */
  private _kills = 0;
  /** Kills this round, and whether the player has been touched during it. */
  private _roundKills = 0;
  private _roundClean = true;

  /** Multi-kill window bookkeeping. */
  private _lastKillAt = -999;
  private _multiKillCount = 0;

  /**
   * THE RUN'S SCORE, tracked here rather than read off the player at death time.
   *
   * MEASURED BUG this exists to fix: `main.ts` owns the world-side death reset and calls
   * `PlayerService`-adjacent `respawn()` from its own `player:died` handler — which is
   * registered BEFORE the director's, so by the time the run summary asks `player.points` the
   * counter has already been reset to `PLAYER.startPoints`. Every finished run reported 500.
   * Listener order is not something either side should have to know about, so the economy keeps
   * its own high-water mark and the summary reads that.
   */
  private _peakPoints = 0;

  constructor(
    private readonly player: PlayerService,
    private readonly combo: ComboMeter,
  ) {}

  get kills(): number { return this._kills; }
  get roundKills(): number { return this._roundKills; }
  get roundClean(): boolean { return this._roundClean; }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  beginRun(): void {
    this._kills = 0;
    this._roundKills = 0;
    this._roundClean = true;
    this._lastKillAt = -999;
    this._multiKillCount = 0;
    this.doublePoints = 1;
    this.rewardMult = 1;
    this._peakPoints = this.player.points;
  }

  beginRound(surge: boolean): void {
    this._roundKills = 0;
    this._roundClean = true;
    this._multiKillCount = 0;
    this.rewardMult = surge ? ROUND.surgeRewardMult : 1;
  }

  // ── the awards (GAME_BIBLE §5) ────────────────────────────────────────────

  /**
   * THE ONE DOOR. `base` is a raw tuning constant; everything above it composes here, and the
   * boon layer's `pointsMult` composes inside `addPoints`. Returns the granted amount so a
   * caller can print it.
   */
  award(base: number, reason: string, applyCombo = true): number {
    if (base <= 0) return 0;
    const mult = applyCombo ? this.combo.multiplier : 1;
    const amount = Math.round(base * mult * this.doublePoints * this.rewardMult);
    if (amount <= 0) return 0;
    this.player.addPoints(amount, reason);
    if (this.player.points > this._peakPoints) this._peakPoints = this.player.points;
    return amount;
  }

  /** The run's score, immune to a respawn resetting the player's counter. See `_peakPoints`. */
  get runPoints(): number { return this._peakPoints; }

  /** A bullet connected but did not kill. Flat by default — see `ROUND.comboAppliesToHits`. */
  onHit(): void {
    this.award(ROUND.pointsHit, 'hit', ROUND.comboAppliesToHits);
  }

  /**
   * A zombie died. Steps the combo, pays the kill, and pays the multi-kill bonus if this kill
   * landed inside `ROUND.multiKillWindow` of the last one.
   *
   * Returns the multi-kill count (1 = a lone kill, 2 = a double, …) so the director can stage
   * the word pop for it without recomputing the window.
   */
  onKill(byCrit: boolean, now: number): number {
    this._kills++;
    this._roundKills++;
    this.combo.onKill();

    // The combo has already stepped, so the kill is paid at the multiplier it just earned —
    // the first kill of a chain pays ×1, which is what makes the ramp feel like a ramp.
    this.award(byCrit ? ROUND.pointsCritKill : ROUND.pointsKill, byCrit ? 'crit-kill' : 'kill');

    if (now - this._lastKillAt <= ROUND.multiKillWindow) this._multiKillCount++;
    else this._multiKillCount = 1;
    this._lastKillAt = now;

    if (this._multiKillCount >= 2) {
      // Capped: the bonus rewards an angle, not a body count. See `ROUND.multiKillMax`.
      const steps = Math.min(this._multiKillCount, ROUND.multiKillMax) - 1;
      this.award(ROUND.pointsMultiKill * steps, 'multi-kill');
    }
    return this._multiKillCount;
  }

  /** The player was touched: the chain dies and the round can no longer be perfect. */
  onDamaged(): void {
    this._roundClean = false;
    this.combo.onDamaged();
    this._multiKillCount = 0;
  }

  /** Round survived. Pays the clear bonus and, if untouched, the perfect-round bonus. */
  onRoundCleared(): boolean {
    const perfect = this._roundClean && this._roundKills > 0;
    this.award(ROUND.pointsRoundClear, 'round-clear', false);
    if (perfect) this.award(ROUND.pointsPerfectRound, 'perfect-round', false);
    return perfect;
  }

  // ── reporting ─────────────────────────────────────────────────────────────

  /** Fills `out` in place — `game:over` fires once per run, but this must not allocate either. */
  fillStats(out: RunStats, round: number, timeSurvived: number): RunStats {
    out.round = round;
    out.kills = this._kills;
    out.bestCombo = this.combo.best;
    out.timeSurvived = timeSurvived;
    out.points = this._peakPoints;
    return out;
  }

  /** Fold a finished run into the persistent meta and write it back. */
  commitMeta(meta: MetaSave, round: number): MetaSave {
    meta.bestRound = Math.max(meta.bestRound, round);
    meta.totalKills += this._kills;
    meta.bestPoints = Math.max(meta.bestPoints, this._peakPoints);
    meta.runs += 1;
    saveMeta(meta);
    return meta;
  }
}

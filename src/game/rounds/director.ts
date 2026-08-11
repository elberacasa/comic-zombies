/**
 * THE ROUND DIRECTOR — GAME_BIBLE §5 (economy) · §6 (director) · §7 (fail state).
 *
 * This is the system that turns the M2 sandbox into a game: it decides how many zombies, how
 * hard, from where and when; it owns the points economy and the combo meter; it drops the
 * power-ups; and it ends the run.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE BEAT (GAME_BIBLE §6 asks for a *beat*, not a spawn timer)
 *
 *      active ──(last zombie dies)──▶ clearing ──▶ intermission ──▶ [boondraw] ──▶ active
 *                                     silence      the breath        1 of 3        the drop
 *                                     1.5 s        7 s               (M4)
 *
 *  · CLEARING is `ROUND.clearSilence` seconds of nothing at all. It emits `round:cleared` on
 *    entry and then simply waits. That silence is the most valuable second in the loop — it is
 *    where the player exhales and notices that they want another one.
 *  · INTERMISSION emits `round:intermission` and deals the boon cards `ROUND.boonDrawDelay`
 *    in. `BoonService` is an inert stub until M4, so the draw is *offered* and the director
 *    only waits on `pendingChoice` if one actually appears — and never longer than
 *    `ROUND.boonDrawTimeout`. Nothing here deadlocks on a system that does not exist yet.
 *  · The next round then emits `round:start`, which is what raises the title card (the HUD owns
 *    drawing it) and the panel frame (`main.ts` owns that). NOTHING SPAWNS for
 *    `ROUND.roundOpenDelay` seconds afterwards, so the card is over before the street moves.
 *
 *  PHASE MAPPING to the frozen `RoundPhase` union: 'pre' before the first round, 'active' while
 *  the horde is out, 'clearing' during the silence, 'intermission' during the breath,
 *  'boondraw' only while a real choice is pending, 'gameover' after `player:died`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 *  THE ESCALATION, in the bible's own order — HP first, then speed, then composition:
 *
 *      count(N)  = round(6 + 2.2·N),                     capped at ROUND.spawnCountMax
 *      liveCap(N)= floor(12 + 1.6·N),                    capped at ROUND.liveCapMax (25)
 *      hp(N)     = 1 + 0.14·(N-1)                        for N ≤ 10
 *                = hp(10) · 1.09^(N-10)                  after that
 *      speed(N)  = 1                                     for N < 4
 *                = 1 + 0.03·(N-3)                        capped at 1.55
 *      surge     = every 5th round: ×1.25 count, ×1.1 hp, ×1.06 speed, ×2 rewards
 *
 *  COMPOSITION is the third axis and it is deliberately inert (`ROUND.specialsEnabled = false`).
 *  `composition()` below is the whole seam: it already reads the intro-round table and the
 *  per-round share, it just returns 'shambler' every time until the specials have real AI.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  WHAT THIS FILE IS ALLOWED TO TOUCH. Only `GameCtx` interfaces and the event bus — it imports
 *  no other game system's implementation. The power-up effects are the interesting case:
 *    · MAX AMMO    → `ctx.weapons.refillAmmo('all')`
 *    · DOUBLE POINTS → a factor inside `Economy`, NOT a write to `PlayerStats.pointsMult`
 *                      (that field belongs to the boon modifier stack; two owners would fight)
 *    · INSTA-KILL  → re-issues the hit through the target's own `Damageable.takeDamage`
 *    · NUKE        → `ctx.enemies.killAll()`, which routes every death through the normal
 *                    damage path so points, VFX and audio all fire exactly as usual
 *    · CARNAGE     → tops the magazine back up every step, so it never empties and therefore
 *                    never auto-reloads. There is no "disable reload" in `WeaponService`, and
 *                    inventing one for a 30-second buff is not worth a contract change.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

import { Vector3 } from 'three';

import type {
  DamageInfo, Damageable, EnemyKind, GameCtx, RNG, RoundPhase, RoundService, System,
} from '@/core/types';
import { PALETTE, SEMANTIC } from '@/art/palette';
import { ROUND, VISUAL_ESCALATION, escalationAt } from '@/game/tuning';
// The visual-escalation bus. NOT another game system — it is the same kind of module-level
// singleton as `INK_GLOBALS`, and `game/enemies/body.ts` already imports this file for
// `makeEnemyMaterial`. See the block at the top of `world/lighting.ts` for why it lives there
// and why the director is its only producer.
import { ESCALATION } from '@/world/lighting';

import { ComboMeter } from '@/game/rounds/combo';
import { Economy, loadMeta, type MetaSave, type RunStats } from '@/game/rounds/economy';
import { PowerupField, type PowerupDef, type PowerupId } from '@/game/rounds/powerups';
import { SpawnDirector } from '@/game/rounds/spawner';

// Module-level scratch. Nothing in this file allocates after `init`.
const _spawnAt = new Vector3();
const _wordAt = new Vector3();
const _nukeAt = new Vector3();

/**
 * The INSTA-KILL re-issue, pre-built. It has to be a persistent object because the kill it
 * causes re-enters this file synchronously (`enemy:killed` → `onEnemyKilled`), and sharing a
 * scratch vector with the word-pop position would let the re-entrant call scribble on the
 * damage packet that is still being read one frame up the stack.
 */
const _ikPoint = new Vector3();
const _ikNormal = new Vector3(0, 1, 0);
const _ikDir = new Vector3(0, 0, -1);
const _instaKill: DamageInfo = {
  amount: 0,
  point: _ikPoint,
  normal: _ikNormal,
  direction: _ikDir,
  part: 'head',
  isCrit: true,
  knockback: 1,
  weaponId: 'insta_kill',
};
/** Enough to end anything the HP curve can produce (`ROUND.hpMax` × brute HP × headroom). */
const INSTA_KILL_DAMAGE = 1e10;

/**
 * ═══ THE HEALTH CURVE — Call of Duty: World at War / Black Ops, exactly ═══
 *
 *     round 1        150
 *     rounds 2 … 9   previous + 100
 *     round 10 +     previous × 1.1, compounding forever
 *
 * Every constant is in `ROUND` (see the long note there for why the KNEE is the design, and for
 * the honest TTK arithmetic against the current arsenal). This is exported and PURE so
 * `tools/combat.mjs` verifies the shipped curve rather than a re-implementation of it, and so a
 * wall-buy or a Pack-a-Punch price can be quoted against real numbers when M4 lands.
 */
export function roundHealth(round: number): number {
  const n = Math.max(1, Math.floor(round));
  const capped = ROUND.hpCapRound > 0 ? Math.min(n, ROUND.hpCapRound) : n;
  const L = Math.max(1, ROUND.hpLinearUntil);
  const linearTop = ROUND.hpRound1 + (L - 1) * ROUND.hpAddPerRound;
  const hp = capped <= L
    ? ROUND.hpRound1 + (capped - 1) * ROUND.hpAddPerRound
    : linearTop * Math.pow(ROUND.hpGrowth, capped - L);
  return Math.min(ROUND.hpMax, hp);
}

/** Word pops the director stages itself. GOLD = reward, HOT/ACID stay reserved for enemies. */
const MULTI_KILL_WORDS = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI-KILL'] as const;

export class RoundSystem implements System, RoundService {
  readonly name = 'rounds';

  private ctx: GameCtx | null = null;
  private rng: RNG | null = null;

  // ── contract state ────────────────────────────────────────────────────────
  private _round = 0;
  private _phase: RoundPhase = 'pre';
  /** Zombies of this round not yet killed (unspawned + alive). */
  private _remaining = 0;

  // ── round bookkeeping ─────────────────────────────────────────────────────
  private toSpawn = 0;
  private spawned = 0;
  /**
   * A special's *first* round is a scripted beat, not a dice roll. Its share on the intro round
   * is one `specialSharePerRound` step — 1.2% — so left to chance the player meets the Screamer
   * many rounds after it was "introduced", or never. BO2 makes a debut an event you remember.
   * Each entry pins one guaranteed spawn of `kind` to wave index `at`.
   */
  private debuts: Array<{ kind: EnemyKind; at: number }> = [];
  private spawnTimer = 0;
  private phaseTimer = 0;
  private boonOffered = false;
  private hpScale = 1;
  private speedScale = 1;
  private liveCap = ROUND.liveCapMax;
  private surge = false;
  /**
   * The round the LOOK is set to, which is normally `_round` but is deliberately allowed to
   * diverge: `setEscalation(n)` moves the picture without touching a single gameplay number, so
   * the human can audit round 20's frame while standing in round 1's fight.
   */
  private escRound = 0;
  /** One GOLD-ladder speed-line pulse per round, the first time the combo tops out. */
  private comboPeaked = false;

  // ── run bookkeeping ───────────────────────────────────────────────────────
  private runStartedAt = 0;
  private dryKills = 0;
  private meta: MetaSave = { bestRound: 0, totalKills: 0, bestPoints: 0, runs: 0 };
  private readonly stats: RunStats = { round: 0, kills: 0, bestCombo: 0, timeSurvived: 0, points: 0 };

  // ── power-up state ────────────────────────────────────────────────────────
  private instaKillT = 0;
  private doublePointsT = 0;
  private carnageT = 0;
  /** Re-entrancy guard: INSTA-KILL re-issues damage, which re-emits `hit:enemy`. */
  private inInstaKill = false;

  // ── owned parts ───────────────────────────────────────────────────────────
  private readonly comboMeter: ComboMeter;
  private economy: Economy | null = null;
  private spawner: SpawnDirector | null = null;
  private readonly powerups: PowerupField;
  private readonly offs: (() => void)[] = [];

  constructor() {
    // Both parts are built now and wired in `init` — `RoundService.combo` has to answer from
    // the moment the service lands in `GameCtx`, which is before any system's `init` has run.
    this.comboMeter = new ComboMeter(() => this.ctx?.events ?? null);
    this.powerups = new PowerupField((def, at) => this.applyPowerup(def, at));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RoundService
  // ═══════════════════════════════════════════════════════════════════════════

  get round(): number { return this._round; }
  get phase(): RoundPhase { return this._phase; }
  get remaining(): number { return this._remaining; }
  get combo(): number { return this.comboMeter.combo; }
  get comboMultiplier(): number { return this.comboMeter.multiplier; }

  // ── beyond the frozen contract, for the run-summary panel ─────────────────
  //
  // `game:over` carries round / kills / bestCombo / timeSurvived, which is four of the five
  // numbers a back-cover summary wants — POINTS is the fifth and the event map has no slot for
  // it. Rather than change a frozen event, the concrete class exposes the finished run and the
  // persistent meta. `ui/cards.ts` reads `CZ.ctx.rounds` as a `RoundSystem`, not as a
  // `RoundService`. If a second consumer ever needs points, that is the moment to add the field
  // to `game:over` properly.

  /** The last finished run. Valid from the frame `game:over` fires. Do not mutate. */
  get lastRun(): Readonly<RunStats> { return this.stats; }
  /** Persistent meta (GAME_BIBLE §7): best round, total kills, best points, runs. */
  get bestRound(): number { return this.meta.bestRound; }
  get totalKills(): number { return this.meta.totalKills; }
  /** The number the POINTS badge is actually chasing, until M4 gives points a sink. */
  get bestPoints(): number { return this.meta.bestPoints; }
  /** 0..1 of the combo window still left — the HUD's drain bar. */
  get comboGraceFraction(): number { return this.comboMeter.graceFraction; }
  /** Live-enemy cap for the current round, for a HUD that wants to show pressure. */
  get liveCapNow(): number { return this.liveCap; }
  /** True on a surge round (every `ROUND.surgeEvery`). */
  get isSurge(): boolean { return this.surge; }

  /** Begin a run. Idempotent while a run is already going. */
  start(): void {
    if (this._phase !== 'pre' && this._phase !== 'gameover') return;
    this.beginRun();
  }

  /** Testing hatch. Jumps straight into round `n` with a clean street. */
  skipToRound(n: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const target = Math.max(1, Math.floor(n));
    ctx.enemies.despawnAll();
    this.powerups.clear();
    this.clearBuffs();
    this.comboMeter.reset();
    if (this._phase === 'pre' || this._phase === 'gameover') {
      this.beginRun(target);
      return;
    }
    this.beginRound(target);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // System
  // ═══════════════════════════════════════════════════════════════════════════

  init(ctx: GameCtx): void {
    this.ctx = ctx;
    // A private stream. Spawn/drop rolls must never shift the sequence the recoil patterns
    // and the enemy variants are drawn from.
    this.rng = ctx.rng.fork(0xd12ec7);
    this.meta = loadMeta();
    this.economy = new Economy(ctx.player, this.comboMeter);
    this.spawner = new SpawnDirector(ctx);
    this.powerups.init(ctx);

    const on = ctx.events.on.bind(ctx.events);

    this.offs.push(
      on('hit:enemy', (p) => this.onHitEnemy(p.target, p.info, p.killed)),
      on('enemy:killed', (p) => this.onEnemyKilled(p.position, p.byCrit)),
      on('player:damaged', () => this.economy?.onDamaged()),
      on('player:down', () => this.onPlayerDown()),
      on('player:revived', () => this.ctx?.hud.toast('BACK ON YOUR FEET')),
      on('player:died', () => this.onPlayerDied()),
      /**
       * A QUALITY CHANGE CLOBBERS THE ESCALATION, so it has to be re-pushed.
       * `WorldSystem.init` re-runs `applyFog` on every `quality:changed` and writes the
       * arena-derived fog range straight back over the round's tightened one; `ComicPipeline`
       * .applyQuality resets its own uniforms the same way. Re-applying is a no-op for
       * everything else because every escalation write is absolute.
       */
      on('quality:changed', () => ESCALATION.reapply()),
    );

    this.registerDebug(ctx);
  }



  /** Gameplay. Everything that decides anything runs here, at a fixed step. */
  fixedUpdate(dt: number, ctx: GameCtx): void {
    this.comboMeter.tick(dt);
    this.tickBuffs(dt, ctx);
    this.powerups.fixedUpdate(dt, ctx);

    switch (this._phase) {
      case 'active': this.tickActive(dt, ctx); break;
      case 'clearing': this.tickClearing(dt); break;
      case 'intermission': this.tickIntermission(dt, ctx); break;
      case 'boondraw': this.tickBoonDraw(dt, ctx); break;
      case 'gameover': this.tickGameOver(dt, ctx); break;
      case 'pre': break;
    }
  }

  /** Presentation only — the floating pickups. */
  update(dt: number, ctx: GameCtx): void {
    this.powerups.update(dt, ctx);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.powerups.dispose();
    this.ctx = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The state machine
  // ═══════════════════════════════════════════════════════════════════════════

  private beginRun(firstRound = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.enemies.despawnAll();
    this.powerups.clear();
    this.clearBuffs();
    this.comboMeter.resetRun();
    this.economy?.beginRun();
    this.dryKills = 0;
    this.runStartedAt = ctx.time.elapsed;
    this.beginRound(firstRound);
  }

  private beginRound(n: number): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this._round = Math.max(1, Math.floor(n));
    this.surge = ROUND.surgeEvery > 0 && this._round % ROUND.surgeEvery === 0;

    this.toSpawn = this.spawnCountFor(this._round);
    this.spawned = 0;
    this.planDebuts();
    this._remaining = this.toSpawn;
    this.hpScale = this.hpScaleFor(this._round);
    this.speedScale = this.speedScaleFor(this._round);
    this.liveCap = this.liveCapFor(this._round);

    // The title card owns the opening beat. Nothing spawns until it has cleared.
    this.spawnTimer = ROUND.roundOpenDelay;
    this.spawner?.reset(this._round);
    this.economy?.beginRound(this.surge);
    // The combo window stretches with the round's own TTK — a fixed window turns a difficulty
    // increase into a combo decrease. Square root, so the window grows slower than the kill does.
    this.comboMeter.setRoundScale(Math.sqrt(this.hpScale));

    // THE LOOK OF THE ROUND. Once, here, before anything else in the round happens — and then
    // held perfectly still until the next `beginRound`. See `VISUAL_ESCALATION` in tuning.ts.
    this.comboPeaked = false;
    this.applyEscalation(this._round, this.surge);

    this.setPhase('active');
    ctx.events.emit('round:start', { round: this._round, toSpawn: this.toSpawn });
    if (this.surge) ctx.hud.toast(`SURGE · ROUND ${this._round} · DOUBLE POINTS`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VISUAL ESCALATION — presentation only. Nothing in this block reads or writes a
  // gameplay number, and nothing outside it drives the look.
  //
  // The human's brief was "so people dont get bored quick", and a single unchanging arena is
  // the fastest way to bore someone however good it looks the first time. The curve lives in
  // `game/tuning.ts::escalationAt`; the two consumers are the light rig and the post stack,
  // which reach each other through the bus in `world/lighting.ts`.
  // ═══════════════════════════════════════════════════════════════════════════

  /** The round the picture is currently set to. Not necessarily the round you are fighting. */
  get escalationRound(): number { return this.escRound; }

  /**
   * THE AUDIT HATCH — `CZ.setEscalation(20)`.
   *
   * Sets the LOOK to round `n` and nothing else: no spawns, no HP, no speed, no phase change.
   * That separation is the point — the human can stand in an empty round-1 street and step the
   * picture 1 → 20 without a fight in the way, and every state is absolute so stepping back
   * down restores the shipped frame exactly. Pass no argument to resync with the live round.
   */
  setEscalation(n?: number): number {
    const target = n === undefined ? this._round : Math.max(1, Math.floor(n));
    const surge = ROUND.surgeEvery > 0 && target % ROUND.surgeEvery === 0;
    this.applyEscalation(target, surge);
    return this.escRound;
  }

  private applyEscalation(round: number, surge: boolean): void {
    this.escRound = Math.max(1, Math.floor(round));
    ESCALATION.apply(escalationAt(this.escRound, surge));
  }

  private tickActive(dt: number, ctx: GameCtx): void {
    const alive = ctx.enemies.aliveCount;
    this._remaining = (this.toSpawn - this.spawned) + alive;

    if (this.spawned < this.toSpawn) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        // Push up to `spawnBurstMax` through in one tick while we are under the cap, so the
        // opening of a big round fills the street instead of trickling.
        let made = 0;
        const headroom = Math.min(ROUND.spawnBurstMax, this.liveCap - alive, this.toSpawn - this.spawned);
        for (let i = 0; i < headroom; i++) {
          if (!this.trySpawnOne(ctx)) break;
          made++;
        }
        // A failed pick (nowhere out of sight) retries next tick, not next interval — that is
        // what keeps a round from stalling when the player is standing in a bad spot.
        this.spawnTimer = made > 0 ? this.spawnIntervalFor(this._round) : dt;
      }
    } else if (alive === 0) {
      this.setPhase('clearing');
      this.phaseTimer = ROUND.clearSilence;
      const perfect = this.economy?.onRoundCleared() ?? false;
      this._remaining = 0;
      ctx.events.emit('round:cleared', { round: this._round, perfect });
      if (perfect) ctx.hud.toast('UNTOUCHED · PERFECT ROUND');
    }
  }

  /** THE SILENCE. Nothing happens on purpose. */
  private tickClearing(dt: number): void {
    this.phaseTimer -= dt;
    if (this.phaseTimer > 0) return;
    this.setPhase('intermission');
    this.phaseTimer = ROUND.intermissionTime;
    this.boonOffered = false;
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.events.emit('round:intermission', { seconds: ROUND.intermissionTime });
    // Nothing draws `round:intermission` yet, and an empty street with no message reads as a
    // hang rather than as a breath. One toast, until M4's boon cards fill the window.
    ctx.hud.toast(`ROUND ${this._round + 1} INCOMING`);
  }

  private tickIntermission(dt: number, ctx: GameCtx): void {
    this.phaseTimer -= dt;

    if (!this.boonOffered && this.phaseTimer <= ROUND.intermissionTime - ROUND.boonDrawDelay) {
      this.boonOffered = true;
      ctx.boons.offer(3);
      // Only wait on a draw that actually materialised. The M4 stub returns null and the
      // intermission runs its normal length — no branch anywhere else needs to know.
      if (ctx.boons.pendingChoice !== null) {
        this.setPhase('boondraw');
        this.phaseTimer = ROUND.boonDrawTimeout;
        return;
      }
    }
    if (this.phaseTimer <= 0) this.beginRound(this._round + 1);
  }

  private tickBoonDraw(dt: number, ctx: GameCtx): void {
    this.phaseTimer -= dt;
    if (ctx.boons.pendingChoice === null || this.phaseTimer <= 0) {
      this.beginRound(this._round + 1);
    }
  }

  /**
   * GAME_BIBLE §7. The player system owns the crawl and the self-revive (it consumes
   * `PlayerStats.reviveCharges` before it ever goes down); we own what the RUN does about it.
   * A run restarts once somebody has actually put a living player back in the world — the test
   * is on health rather than on a `player:spawned` event that can arrive before `player:died`
   * depending on listener order.
   *
   * THE HOLD IS GONE (BUILD 004). `gameOverHold` used to gate this, counted from the moment of
   * DEATH, so pressing SPACE on the back cover handed you full control of an empty street for a
   * measured 3.47 s before ROUND 1 started. That is precisely the moment the "one more round"
   * impulse has to be paid off, and it was being spent watching nothing happen. The back cover
   * already owns its own dismissal — the summary decides when the beat is over, and the instant
   * a living player exists the street should be filling. `dt` is no longer read here.
   */
  private tickGameOver(_dt: number, ctx: GameCtx): void {
    if (ctx.player.isDown || ctx.player.health <= 0) return;
    this.beginRun();
  }

  private setPhase(p: RoundPhase): void {
    this._phase = p;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Spawning
  // ═══════════════════════════════════════════════════════════════════════════

  private trySpawnOne(ctx: GameCtx): boolean {
    const spawner = this.spawner;
    if (!spawner) return false;
    if (!spawner.pick(_spawnAt)) return false;
    const kind = this.takeDebut() ?? this.composition(this._round);
    const enemy = ctx.enemies.spawn(kind, _spawnAt, this.hpScale, this.speedScale);
    if (!enemy) return false;
    this.spawned++;
    return true;
  }

  // ── the curve ─────────────────────────────────────────────────────────────

  private spawnCountFor(n: number): number {
    const base = ROUND.spawnBase + n * ROUND.spawnPerRound;
    const scaled = this.surge ? base * ROUND.surgeSpawnMult : base;
    return Math.max(1, Math.min(ROUND.spawnCountMax, Math.round(scaled)));
  }

  private liveCapFor(n: number): number {
    const cap = Math.floor(ROUND.liveCapBase + n * ROUND.liveCapPerRound);
    return Math.max(1, Math.min(ROUND.liveCapMax, cap));
  }

  private spawnIntervalFor(n: number): number {
    // THE OPENING (see `ROUND.spawnIntervalEarly`). The first rounds are a short sharp fight,
    // not a trickle: at 1.6 s apart, round 1's eight zombies took 11 s just to get on the street.
    if (n <= ROUND.spawnEarlyRounds) return ROUND.spawnIntervalEarly;
    const t = ROUND.spawnInterval - (n - 1) * ROUND.spawnIntervalDecay;
    return Math.max(ROUND.spawnIntervalMin, t);
  }

  /** HP first (GAME_BIBLE §6). `roundHealth` is the whole curve; the surge is the only extra. */
  private hpScaleFor(n: number): number {
    let s = roundHealth(n) / ROUND.hpRound1;
    if (this.surge) s *= ROUND.surgeHpMult;
    return Math.max(0.1, s);
  }

  /**
   * Speed second — and it is no longer the speed AXIS. `enemies/defs.ts::SPEED_TIERS` +
   * `TIER_MIX` roll a walk/walker/runner/sprinter tier per instance from a round-driven
   * distribution, exactly as CoD does. What survives here is a small, late, hard-capped creep on
   * top of the tier so rounds past the mix's saturation still have somewhere to go. The cap is
   * what keeps a train trainable: worst case is 4.63 m/s against a 5.4 m/s walk.
   */
  private speedScaleFor(n: number): number {
    let s = 1;
    if (n >= ROUND.speedScaleStartRound) {
      s = 1 + (n - ROUND.speedScaleStartRound + 1) * ROUND.speedPerRound;
    }
    if (this.surge) s *= ROUND.surgeSpeedMult;
    return Math.max(0.1, Math.min(ROUND.speedScaleMax, s));
  }

  /**
   * COMPOSITION — the third axis of escalation, and it is LIVE.
   *
   * HP first, then speed, then composition (GAME_BIBLE §6). Sprinters from round 4, brutes from
   * 7, screamers from 8, each taking a share that grows per round and is capped so the mass
   * stays the mass — a round that is all specials is a different game, not a harder one.
   *
   * The spitter is parked at round 9999 in `ROUND.specialIntroRound` until it has a projectile;
   * see the reasoning in `tuning.ts`. Shamblers always take the remainder.
   */
  /**
   * Pin a guaranteed spawn for every special whose intro round is exactly this one. It lands a
   * third of the way into the wave, never on the opening zombie — the round should read as normal
   * for a beat, so the new silhouette arriving is a change the player notices.
   */
  private planDebuts(): void {
    this.debuts.length = 0;
    if (!ROUND.specialsEnabled) return;
    const intro = ROUND.specialIntroRound as Record<string, number>;
    const at = Math.min(Math.max(2, Math.floor(this.toSpawn * 0.34)), Math.max(0, this.toSpawn - 1));
    for (const key of Object.keys(intro)) {
      if (intro[key] === this._round) this.debuts.push({ kind: key as EnemyKind, at });
    }
  }

  /** The pinned kind for the current wave index, if one is due. */
  private takeDebut(): EnemyKind | null {
    for (let i = 0; i < this.debuts.length; i++) {
      if (this.spawned >= this.debuts[i].at) {
        const kind = this.debuts[i].kind;
        this.debuts.splice(i, 1);
        return kind;
      }
    }
    return null;
  }

  private composition(n: number): EnemyKind {
    if (!ROUND.specialsEnabled) return 'shambler';
    const rng = this.rng;
    if (!rng) return 'shambler';
    const intro = ROUND.specialIntroRound;
    let roll = rng.next();
    const consider = (kind: Exclude<EnemyKind, 'shambler'>, from: number): EnemyKind | null => {
      if (n < from) return null;
      const share = Math.min(ROUND.specialShareMax, (n - from + 1) * ROUND.specialSharePerRound);
      roll -= share;
      return roll <= 0 ? kind : null;
    };
    return (
      consider('sprinter', intro.sprinter) ??
      consider('brute', intro.brute) ??
      consider('spitter', intro.spitter) ??
      consider('screamer', intro.screamer) ??
      'shambler'
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Economy hooks
  // ═══════════════════════════════════════════════════════════════════════════

  private onHitEnemy(target: Damageable, info: DamageInfo, killed: boolean): void {
    if (this._phase === 'gameover') return;
    if (this.inInstaKill) return;

    if (killed) return;
    this.economy?.onHit();

    // INSTA-KILL: re-issue the hit as lethal through the target's own contract method, so the
    // kill takes the normal path — flinch, dismember, panel shatter, points, audio, all of it.
    if (this.instaKillT <= 0 || !target.alive) return;
    this.inInstaKill = true;
    _instaKill.amount = INSTA_KILL_DAMAGE;
    _ikPoint.copy(info.point);
    _ikNormal.copy(info.normal);
    _ikDir.copy(info.direction);
    _instaKill.part = info.part;
    _instaKill.knockback = info.knockback;
    target.takeDamage(_instaKill);
    this.inInstaKill = false;
  }

  private onEnemyKilled(position: Vector3, byCrit: boolean): void {
    const ctx = this.ctx;
    const economy = this.economy;
    if (!ctx || !economy) return;
    if (this._phase === 'gameover' || this._phase === 'pre') return;

    const multi = economy.onKill(byCrit, ctx.time.elapsed);

    /**
     * PLAYING WELL LOOKS LOUDER (the fourth escalation channel: the comic language itself).
     *
     * One speed-line pulse the first time a round's chain reaches the top of the ladder. It is a
     * ONE-SHOT into `RenderService.speedLines`, which is self-decaying — so it animates while it
     * is alive and leaves nothing running at rest, which is how it satisfies ART §4.1 by
     * construction rather than by measurement. Once per round, so a long ×5 chain is one beat
     * and not a strobe.
     *
     * The line COLOUR is deliberately left alone: `game/vfx/service.ts` owns that knob globally
     * and reverts it to INK on its own timer — `game/boons/effects.ts` declined to touch it for
     * exactly this reason and so does this.
     */
    if (!this.comboPeaked &&
        VISUAL_ESCALATION.comboPeakLines > 0 &&
        this.comboMeter.multiplier >= ROUND.comboMaxMultiplier) {
      this.comboPeaked = true;
      ctx.renderer.speedLines(VISUAL_ESCALATION.comboPeakLines);
    }

    if (multi >= 2) {
      const word = MULTI_KILL_WORDS[Math.min(multi, MULTI_KILL_WORDS.length - 1)];
      if (word) {
        _wordAt.set(position.x, position.y + 2.1, position.z);
        ctx.vfx.wordPop(_wordAt, word, SEMANTIC.reward, 1.05);
      }
    }

    this.maybeDropPowerup(position);
  }

  /**
   * Random from kills at a tuned rate, with a PITY COUNTER. A pure 4.5% roll goes 35 kills dry
   * one run in five, and a mechanic the player never sees does not exist.
   */
  private maybeDropPowerup(position: Vector3): void {
    const rng = this.rng;
    if (!rng) return;
    this.dryKills++;
    const pity = this.dryKills >= ROUND.powerupPityKills;
    if (!pity && rng.next() > ROUND.powerupChance) return;
    if (this.powerups.drop(position) === null) return;
    this.dryKills = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Power-up effects
  // ═══════════════════════════════════════════════════════════════════════════

  private applyPowerup(def: PowerupDef, at: Vector3): void {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.hud.toast(def.label);
    _wordAt.set(at.x, at.y + 0.9, at.z);
    ctx.vfx.wordPop(_wordAt, def.label, SEMANTIC.reward, 1.15);

    switch (def.id) {
      case 'max_ammo':
        ctx.weapons.refillAmmo('all');
        break;
      case 'double_points':
        this.doublePointsT = ROUND.powerupDoublePointsTime;
        if (this.economy) this.economy.doublePoints = ROUND.doublePointsMult;
        break;
      case 'insta_kill':
        this.instaKillT = ROUND.powerupInstaKillTime;
        break;
      case 'carnage':
        this.carnageT = ROUND.powerupCarnageTime;
        ctx.weapons.refillAmmo('all');
        break;
      case 'nuke':
        this.fireNuke(ctx);
        break;
    }
  }

  /**
   * THE NUKE IS AN EVENT, not a button. White frame, a rung camera, a beat of hitstop, the
   * loudest word in the vocabulary, and then the whole street comes apart at once — every death
   * goes through the normal damage path, so the points, the panel shatter and the audio all
   * fire exactly as if the player had shot each one.
   */
  private fireNuke(ctx: GameCtx): void {
    ctx.renderer.flash(ROUND.nukeFlash, PALETTE.PAPER);
    ctx.events.emit('fx:hitstop', { seconds: ROUND.nukeHitstop });
    ctx.vfx.shake(ROUND.nukeShake, ROUND.nukeShakeTime);
    _nukeAt.copy(ctx.player.eye).addScaledVector(ctx.player.lookDir, 7);
    ctx.vfx.wordPop(_nukeAt, 'KA-BOOM', PALETTE.RUST, 2.4);
    ctx.enemies.killAll('nuke');
    this.economy?.award(ROUND.pointsNuke, 'nuke', false);
  }

  private tickBuffs(dt: number, ctx: GameCtx): void {
    if (this.doublePointsT > 0) {
      this.doublePointsT -= dt;
      if (this.doublePointsT <= 0 && this.economy) {
        this.economy.doublePoints = 1;
        ctx.hud.toast('DOUBLE POINTS OVER');
      }
    }
    if (this.instaKillT > 0) {
      this.instaKillT -= dt;
      if (this.instaKillT <= 0) ctx.hud.toast('INSTA-KILL OVER');
    }
    if (this.carnageT > 0) {
      this.carnageT -= dt;
      // Top the magazine back up before it can run dry: infinite ammo AND no reload, without
      // needing a `WeaponService` flag that does not exist.
      const cur = ctx.weapons.current;
      if (cur && cur.ammo < cur.def.magSize) ctx.weapons.refillAmmo('all');
      if (this.carnageT <= 0) ctx.hud.toast('CARNAGE OVER');
    }
  }

  private clearBuffs(): void {
    this.instaKillT = 0;
    this.carnageT = 0;
    this.doublePointsT = 0;
    if (this.economy) this.economy.doublePoints = 1;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Fail state (GAME_BIBLE §7)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The crawl. `PLAYER.downTime` (8 s) and the self-revive are the player system's to run — it
   * checks `PlayerStats.reviveCharges` before it ever goes down, so a revive boon simply means
   * `player:down` never fires. All the round owes the moment is a beat and a broken chain.
   */
  private onPlayerDown(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.comboMeter.reset();
    this.economy?.onDamaged();
    // The audio layer already ducks and plays `player_down` off the same event; the round only
    // owes the moment a broken chain and a spoiled perfect-round flag.
    void ctx;
  }

  private onPlayerDied(): void {
    const ctx = this.ctx;
    const economy = this.economy;
    if (!ctx || !economy) return;
    if (this._phase === 'gameover') return;

    this.setPhase('gameover');
    // NOT a restart gate any more — see `tickGameOver`. Zeroed so a stale timer from an earlier
    // phase can never leak into the game-over state.
    this.phaseTimer = 0;
    this._remaining = 0;
    this.powerups.clear();
    this.clearBuffs();
    this.comboMeter.reset();

    const survived = Math.max(0, ctx.time.elapsed - this.runStartedAt);
    economy.fillStats(this.stats, this._round, survived);
    const newBest = this._round > this.meta.bestRound;
    economy.commitMeta(this.meta, this._round);

    ctx.events.emit('game:over', {
      round: this.stats.round,
      kills: this.stats.kills,
      bestCombo: this.stats.bestCombo,
      timeSurvived: this.stats.timeSurvived,
    });

    ctx.hud.titleCard(
      'INKED OUT',
      `ROUND ${this.stats.round} · ${this.stats.kills} KILLS · ${this.stats.points} PTS${newBest ? ' · NEW BEST' : ''}`,
      3.2,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════

  private registerDebug(ctx: GameCtx): void {
    const d = ctx.debug;
    d.watch('round', () => `${this._round}${this.surge ? ' SURGE' : ''}`);
    d.watch('phase', () => this._phase);
    d.watch('wave', () => `${this.spawned}/${this.toSpawn} · ${this._remaining} left`);
    d.watch('live cap', () => `${ctx.enemies.aliveCount}/${this.liveCap}`);
    d.watch('scale', () => `hp ×${this.hpScale.toFixed(2)} spd ×${this.speedScale.toFixed(2)}`);
    d.watch('combo', () => `${this.comboMeter.combo} ×${this.comboMeter.multiplier}`);
    // The combo ladder's own acceptance test, on screen instead of in a spreadsheet: peak
    // multiplier reached this run, and the window this round is actually running.
    d.watch('combo peak', () =>
      `×${this.comboMeter.bestMultiplier} · window ×${Math.min(
        ROUND.comboWindowRoundScaleMax, Math.sqrt(this.hpScale),
      ).toFixed(2)}`);
    d.watch('powerups', () => `${this.powerups.live} live · ${this.dryKills} dry`);
    d.watch('buffs', () => {
      const b: string[] = [];
      if (this.doublePointsT > 0) b.push(`2X ${this.doublePointsT.toFixed(0)}`);
      if (this.instaKillT > 0) b.push(`IK ${this.instaKillT.toFixed(0)}`);
      if (this.carnageT > 0) b.push(`CARN ${this.carnageT.toFixed(0)}`);
      return b.length > 0 ? b.join(' ') : '—';
    });
    // THE LOOK, on screen next to the fight it belongs to. `t` is the master escalation curve;
    // `lamps` is how much of the city has gone dark. Reads the bus, not a private copy, so a
    // desync between the director and what is actually on the glass is visible immediately.
    d.watch('look', () => {
      const e = ESCALATION.state;
      if (!e) return '—';
      return `r${e.round}${e.surge ? ' SURGE' : ''} t${e.t.toFixed(2)} lamps -${(e.lampFail * 100).toFixed(0)}%`;
    });
    d.watch('spawn veto', () => `${this.spawner?.rejectedVisible ?? 0} seen · ${this.spawner?.desperateSpawns ?? 0} far`);
    d.watch('spawn src', () => `${this.spawner?.ringSpawns ?? 0} ring · ${this.spawner?.doorSpawns ?? 0} door`);
    d.watch('best round', () => this.meta.bestRound);
  }
}

/** Build the director. Everything expensive happens in `init()`, so this is free during boot. */
export function createRounds(): RoundSystem {
  return new RoundSystem();
}

export type { PowerupId };

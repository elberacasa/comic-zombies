/**
 * BOON SERVICE — the roguelite layer (GAME_BIBLE §5).
 *
 * Owns three things and nothing else:
 *   1. THE DRAW — `offer(3)` deals distinct, rarity-weighted cards and emits `boon:offer`.
 *   2. THE STACK — `choose(id)` inserts the def's `modify` into `PlayerService`'s modifier
 *      stack and runs its `attach`, keeping the disposer so a boon can be taken away again.
 *   3. THE RUN — resetting all of the above when a new run starts.
 *
 * It never computes a stat itself. `player/stats.ts` owns `base → modifiers → clamp`; this file
 * only decides which functions are in the list and in what order.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  CONTRACT GAP — READ THIS BEFORE WIRING `main.ts`.
 *
 *  `PlayerService` (core/types.ts, frozen) exposes `recomputeStats()` and documents it as
 *  "Called by BoonService" — but it exposes no way to PUT anything into the stack that
 *  `recomputeStats()` walks. `PlayerSystem.addStatModifier()` exists and is exactly right; it
 *  is simply not on the interface, and `core/types.ts` is not ours to edit.
 *
 *  The workaround is deliberately NOT a structural probe. Probing (`ctx.player as unknown as
 *  {…}`) is what bit this project once already: it compiles, and it fails silently. Instead the
 *  requirement is a named interface, `BoonStatHost`, and it is satisfied by PASSING the player
 *  in at construction:
 *
 *      const player = createPlayer();
 *      const boons  = createBoons(player);      // ← tsc checks this call site
 *
 *  `PlayerSystem` already matches `BoonStatHost` structurally, so this needs no cast and no
 *  import from `player/**`. If someone renames `addStatModifier`, that line stops compiling —
 *  which is the entire property a probe throws away.
 *
 *  If the host is omitted, stat boons are inert and the service says so, loudly, once.
 *  See the result notes for the proposed `core/types.ts` amendment.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * FRAME COST AT REST: `update()` is `if (n === 0) return;` when no behavioural boon is owned,
 * and `fixedUpdate()` is two field reads. Nothing here animates, allocates or draws while the
 * player stands still (ART §4.1).
 */

import type {
  BoonDef, BoonRarity, BoonService, GameCtx, PlayerStats, System,
} from '@/core/types';
import {
  BOON_DEFS, BOON_DRAW, BOON_RARITIES, BOON_RUNTIME, BOON_BY_RARITY,
  boonById, rarityWeight, resetBoonRuntime,
} from './defs';
import type { BoonDefX } from './defs';
import { BoonStatEffects } from './effects';

/**
 * What the boon layer needs from the player and cannot get from `PlayerService`.
 * Structurally satisfied by `PlayerSystem`; see the header.
 */
export interface BoonStatHost {
  /** Push a pure stat mutation onto the stack and recompute. Returns a disposer. */
  addStatModifier(fn: (stats: PlayerStats) => void, label?: string, order?: number): () => void;
  recomputeStats(): void;
}

interface OwnedBoon {
  def: BoonDefX;
  stacks: number;
  /** Disposer for the entry in `PlayerService`'s modifier stack. */
  statOff: (() => void) | null;
  /** Disposer returned by `attach`. */
  behaviourOff: (() => void) | null;
}

/** Public shape of `owned`, matching the frozen `BoonService` contract exactly. */
interface OwnedView {
  def: BoonDef;
  stacks: number;
}

export class BoonSystem implements System, BoonService {
  readonly name = 'boons';
  readonly allDefs: readonly BoonDef[] = BOON_DEFS;

  private readonly _owned: OwnedBoon[] = [];
  /** Mirror handed out through `owned` — rebuilt only when something is taken. */
  private readonly _ownedView: OwnedView[] = [];
  private _pending: BoonDef[] | null = null;
  /** Scratch for the draw. Reused; `offer()` allocates nothing after the first call. */
  private readonly _draw: BoonDefX[] = [];

  private readonly effects = new BoonStatEffects();
  private ctx: GameCtx | null = null;
  private host: BoonStatHost | null;
  private warnedNoHost = false;
  private warnedNoCtx = false;

  constructor(host?: BoonStatHost) {
    this.host = host ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // System
  // ═══════════════════════════════════════════════════════════════════════════════════════

  init(ctx: GameCtx): void {
    this.ctx = ctx;
    this.effects.attach(ctx);
    resetBoonRuntime();
    // A fresh run wipes the deck. `player:spawned` fires on respawn as well as on boot, and
    // the player system clears its own modifier stack in `respawn()` — so ours must go too or
    // `owned` would claim boons whose modifiers no longer exist.
    ctx.events.on('player:spawned', () => {
      if (this._owned.length > 0) this.resetRun();
    });
    this.registerDebug(ctx);
  }

  dispose(): void {
    this.clearAll();
    this.effects.dispose();
    resetBoonRuntime();
    this.ctx = null;
  }

  /**
   * Behavioural boons that need a clock register a ticker (`BOON_RUNTIME.tickers`) instead of
   * polling — a def has no frame hook and should not grow one. Real `frameDt`, deliberately:
   * Panel Break scales gameplay time and a timer measured in scaled time would never expire.
   */
  update(dt: number, ctx: GameCtx): void {
    const t = BOON_RUNTIME.tickers;
    if (t.length === 0) return;
    for (let i = t.length - 1; i >= 0; i--) t[i](dt, ctx);
  }

  fixedUpdate(dt: number, ctx: GameCtx): void {
    this.effects.fixedUpdate(dt, ctx);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Wiring
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /** Late injection, for a `main.ts` that builds the boon service before the player. */
  attachStatHost(host: BoonStatHost): void {
    if (this.host === host) return;
    this.host = host;
    // Re-register anything taken before the host arrived, in the original order.
    for (let i = 0; i < this._owned.length; i++) {
      const o = this._owned[i];
      if (o.statOff || !o.def.modify) continue;
      o.statOff = this.pushModifier(o.def, o.stacks);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // BoonService — queries
  // ═══════════════════════════════════════════════════════════════════════════════════════

  get owned(): readonly OwnedView[] { return this._ownedView; }
  get pendingChoice(): readonly BoonDef[] | null { return this._pending; }

  has(id: string): boolean {
    return this.find(id) !== null;
  }

  stacksOf(id: string): number {
    const o = this.find(id);
    return o ? o.stacks : 0;
  }

  /** True when every stack of `id` is already taken and it must never be offered again. */
  isMaxed(id: string): boolean {
    const d = boonById(id);
    return d ? this.stacksOf(id) >= d.maxStacks : true;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // THE DRAW
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * Deal `count` DISTINCT cards, weighted by rarity, shifted by the round number, excluding
   * anything already at max stacks. Emits `boon:offer`; the UI paints it (ART §7).
   *
   * The roll is two-stage — pick a rarity by weight, then a card uniformly inside it — so the
   * shape of the pool (8 commons vs 4 legendaries) never distorts the rarity odds. A rarity
   * whose eligible pool is empty is skipped by zeroing its weight, not by falling through, so
   * a late run that has maxed every epic still deals three real cards.
   */
  offer(count = BOON_DRAW.cards): void {
    const ctx = this.ctx;
    if (!ctx) { this.warnNotRegistered('offer'); return; }
    const round = ctx.rounds.round;
    const picks = this._draw;
    picks.length = 0;

    const wanted = Math.max(1, Math.floor(count));
    for (let i = 0; i < wanted; i++) {
      const d = this.rollOne(ctx, round, picks);
      if (!d) break;
      picks.push(d);
    }

    // PITY (BOON_DRAW.pityFromRound): three commons is the one hand that makes a player stop
    // reading the cards. Re-roll the last one at rare-or-better, once.
    if (round >= BOON_DRAW.pityFromRound && picks.length > 1) {
      let allCommon = true;
      for (let i = 0; i < picks.length; i++) if (picks[i].rarity !== 'common') { allCommon = false; break; }
      if (allCommon) {
        picks.length -= 1;
        const up = this.rollOne(ctx, round, picks, true);
        if (up) picks.push(up);
      }
    }

    if (picks.length === 0) {
      this._pending = null;
      return;
    }

    // The payload is `readonly BoonDef[]` and outlives this call (the UI holds it while the
    // cards are on screen), so it is the one array here that is genuinely copied.
    const choices = picks.slice();
    this._pending = choices;
    ctx.events.emit('boon:offer', { choices });
    ctx.events.emit('fx:sound', { id: 'card_deal', volume: 1 });
  }

  private rollOne(
    ctx: GameCtx, round: number, exclude: readonly BoonDefX[], forceUncommon = false,
  ): BoonDefX | null {
    let total = 0;
    // Four weights on the stack, not in an array — `offer` runs on the round-clear beat and
    // there is no reason for it to make garbage.
    let wCommon = 0, wRare = 0, wEpic = 0, wLegendary = 0;
    for (let i = 0; i < BOON_RARITIES.length; i++) {
      const r = BOON_RARITIES[i];
      if (forceUncommon && r === 'common') continue;
      if (this.eligibleCount(r, exclude) === 0) continue;
      const w = rarityWeight(r, round);
      total += w;
      if (r === 'common') wCommon = w;
      else if (r === 'rare') wRare = w;
      else if (r === 'epic') wEpic = w;
      else wLegendary = w;
    }
    if (total <= 0) return forceUncommon ? this.rollOne(ctx, round, exclude, false) : null;

    let roll = ctx.rng.next() * total;
    let rarity: BoonRarity = 'common';
    if ((roll -= wCommon) < 0) rarity = 'common';
    else if ((roll -= wRare) < 0) rarity = 'rare';
    else if ((roll -= wEpic) < 0) rarity = 'epic';
    else if ((roll -= wLegendary) < 0) rarity = 'legendary';
    else rarity = 'common';

    return this.pickFrom(ctx, rarity, exclude);
  }

  private eligibleCount(rarity: BoonRarity, exclude: readonly BoonDefX[]): number {
    const pool = BOON_BY_RARITY[rarity];
    let n = 0;
    for (let i = 0; i < pool.length; i++) {
      const d = pool[i];
      if (this.isMaxed(d.id)) continue;
      if (contains(exclude, d)) continue;
      n++;
    }
    return n;
  }

  /** Uniform reservoir pick inside one rarity — one pass, no temporary array. */
  private pickFrom(ctx: GameCtx, rarity: BoonRarity, exclude: readonly BoonDefX[]): BoonDefX | null {
    const pool = BOON_BY_RARITY[rarity];
    let seen = 0;
    let chosen: BoonDefX | null = null;
    for (let i = 0; i < pool.length; i++) {
      const d = pool[i];
      if (this.isMaxed(d.id)) continue;
      if (contains(exclude, d)) continue;
      seen++;
      if (ctx.rng.next() < 1 / seen) chosen = d;
    }
    return chosen;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // TAKING A CARD
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /** Take one of the pending cards. Ignores anything that was not actually on offer. */
  choose(id: string): void {
    const pending = this._pending;
    if (pending) {
      let onOffer = false;
      for (let i = 0; i < pending.length; i++) if (pending[i].id === id) { onOffer = true; break; }
      if (!onOffer) return;
    }
    this._pending = null;
    this.apply(id, true);
  }

  /** Grant without a draw — power-ups, Wild Draw, debug. */
  grant(id: string): void {
    this.apply(id, false);
  }

  private apply(id: string, fromDraw: boolean): void {
    const ctx = this.ctx;
    const d = boonById(id);
    if (!d) return;
    if (!ctx) { this.warnNotRegistered('choose/grant'); return; }

    let o = this.find(id);
    if (o && o.stacks >= d.maxStacks) return;

    if (o) {
      o.stacks++;
      // A stacked boon is REBUILT, never patched: `modify(stats, stacks)` and
      // `attach(ctx, stacks)` are both functions of the stack count, so the only correct way
      // to add a stack is to tear the old one down and stand a new one up in the same slot.
      o.statOff?.();
      o.statOff = null;
      o.behaviourOff?.();
      o.behaviourOff = null;
    } else {
      o = { def: d, stacks: 1, statOff: null, behaviourOff: null };
      this._owned.push(o);
    }

    if (d.modify) o.statOff = this.pushModifier(d, o.stacks);
    if (d.attach) o.behaviourOff = d.attach(ctx, o.stacks);

    this.syncView();
    ctx.events.emit('boon:chosen', { def: d, stacks: o.stacks });
    ctx.events.emit('fx:sound', { id: fromDraw ? 'card_take' : 'upgrade_chime', volume: 1 });
  }

  /**
   * Insert `def.modify` into the player's stack. `order` is normally 0 — insertion order is the
   * order the player took the cards, which is a real build decision (see `player/stats.ts`) —
   * and 100 for the one boon that must have the last word (Ink Pact's "you have 1 HP").
   */
  private pushModifier(d: BoonDefX, stacks: number): (() => void) | null {
    const host = this.host;
    if (!host) {
      if (!this.warnedNoHost) {
        this.warnedNoHost = true;
        console.error(
          '[boons] no BoonStatHost — stat boons are INERT. main.ts must call ' +
          '`createBoons(player)` or `boons.attachStatHost(player)`. See boons/service.ts.',
        );
      }
      return null;
    }
    const fn = d.modify;
    if (!fn) return null;
    return host.addStatModifier((s) => fn(s, stacks), d.id, d.order ?? 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Run lifecycle
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /** Wipe the deck for a new run. Every disposer runs; run state is zeroed. */
  resetRun(): void {
    this.clearAll();
    resetBoonRuntime();
    this.host?.recomputeStats();
  }

  private clearAll(): void {
    for (let i = this._owned.length - 1; i >= 0; i--) {
      const o = this._owned[i];
      o.behaviourOff?.();
      o.statOff?.();
    }
    this._owned.length = 0;
    this._pending = null;
    this.syncView();
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Internals
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * `init()` never ran, so there is no `ctx` and the whole layer is dead weight. This is the
   * failure mode of forgetting `loop.add(boons)` in `main.ts`, and it is exactly the kind of
   * thing that presents as "the boon cards never appear" three hours later. Say it out loud.
   */
  private warnNotRegistered(what: string): void {
    if (this.warnedNoCtx) return;
    this.warnedNoCtx = true;
    console.error(
      `[boons] ${what}() before init — the boon system was never registered with the loop. ` +
      'main.ts needs `loop.add(boons)`. See src/game/boons/index.ts.',
    );
  }

  private find(id: string): OwnedBoon | null {
    for (let i = 0; i < this._owned.length; i++) if (this._owned[i].def.id === id) return this._owned[i];
    return null;
  }

  /** `owned` is read by the HUD every frame; keep it a stable array, updated in place. */
  private syncView(): void {
    this._ownedView.length = this._owned.length;
    for (let i = 0; i < this._owned.length; i++) {
      const o = this._owned[i];
      const v = this._ownedView[i];
      if (v && v.def === o.def) { v.stacks = o.stacks; continue; }
      this._ownedView[i] = { def: o.def, stacks: o.stacks };
    }
  }

  private registerDebug(ctx: GameCtx): void {
    const d = ctx.debug;
    d.watch('boon deck', () => (this._owned.length === 0 ? 'empty' : this.deckLabel()));
    d.watch('kinetic', () => BOON_RUNTIME.kineticCharges);
    d.watch('revives', () => `${ctx.player.stats.reviveCharges} left · ${BOON_RUNTIME.revivesSpent} spent`);
    d.watch('panel brk', () => (BOON_RUNTIME.panelBoost > 1 ? 'FROZEN' : '-'));
  }

  private deckLabel(): string {
    let s = '';
    for (let i = 0; i < this._owned.length; i++) {
      const o = this._owned[i];
      s += (i ? ' ' : '') + o.def.id + (o.stacks > 1 ? `x${o.stacks}` : '');
    }
    return s;
  }
}

function contains(list: readonly BoonDefX[], d: BoonDefX): boolean {
  for (let i = 0; i < list.length; i++) if (list[i] === d) return true;
  return false;
}

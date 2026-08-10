/**
 * BOON CONTENT — pure data plus the small closures a behavioural boon needs.
 *
 * ARCHITECTURE §5: "pure data lives in `defs.ts` files". Same split as `weapons/defs.ts` and
 * `enemies/defs.ts`:
 *
 *   tuning.ts  →  "how does the RUN feel"     (shared, tuned live by the feel pass)
 *   defs.ts    →  "what IS Glass Cannon"      (content, owned by the boon agent)
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE MODIFIER STACK IS THE WHOLE DESIGN (GAME_BIBLE §5).
 *
 *  A boon is one of exactly two things and never a third:
 *
 *    modify(stats, stacks)  — PURE stat math over `PlayerStats`. It is handed the working copy
 *                             partway through `PlayerService.recomputeStats()`, mutates it, and
 *                             returns. It may not touch the world, allocate, or remember
 *                             anything: it runs every time ANY boon changes.
 *
 *    attach(ctx, stacks)    — behaviour. Subscribes to the event bus, returns a disposer.
 *                             It may not reach into another system's implementation; every
 *                             capability it uses is a `core/types.ts` interface or an event.
 *
 *  Nothing anywhere else in the codebase knows the id `glass_cannon`. If a boon's effect is
 *  hardcoded into a system, the boon is wrong, not the system. The four stat fields nobody had
 *  claimed yet (`lifestealPerKill`, `slideDamage`, `explosiveChance`, `chainChance`) are read
 *  generically in `./effects.ts` — by VALUE, never by boon id, so a power-up or a future weapon
 *  affix that raises the same number gets the same behaviour for free.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * STACKING IS MULTIPLICATIVE on multipliers and additive on counts, and the ORDER of the stack
 * is the order the boons were taken (see `player/stats.ts`). That is deliberate and the player
 * feels it. The one exception is `order: 100`, which forces a modifier to run last — Ink Pact
 * *sets* max health to 1 and would otherwise be undone by any health boon taken after it.
 *
 * COMFORT (ART §10): the fastest legal build here is Ink Pact × Light Feet ×5 × Kinetic Ink ×2
 * ≈ 3.6× walk speed. That cannot make the camera sick, and it is not a matter of taste: the
 * camera clamps bob amplitude (`bobAmpScaleMax`), total roll (`rollTotalLimitDeg: 4`) and the
 * summed FOV punch (`fovPunchMax: 8`) AFTER summing every layer, so no stat can breach them.
 * `scratchpad/boon-harness` proves it by running the real `PlayerCamera` at that speed.
 */

import type { BoonDef, BoonRarity, GameCtx, PlayerStats } from '@/core/types';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ICON VOCABULARY — the contract with the UI agent.
//
// `BoonDef.icon` is typed `string` in the frozen contract, so the vocabulary is enforced here
// instead: every def below is built through `def()`, which takes a `BoonIconId`. The UI's card
// painter should `switch` over `BOON_ICON_IDS` — adding a boon with a new glyph then fails to
// compile until the glyph exists, which is the whole point.
//
// Every one of these is a FLAT INK GLYPH: solid `INK` silhouette, one accent flat from the
// palette, hard drop shadow, no gradients (ART §7). They read at 48 px on a comic card.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const BOON_ICON_IDS = [
  // common
  'bolt',           // lightning bolt — rate of fire
  'heart',          // fat comic heart — health
  'mag',            // magazine, sliding out — reload
  'bullets',        // three stacked rounds — capacity
  'grip',           // knurled pistol grip — control
  'boot',           // running boot with a motion arc — speed
  'coin',           // fat coin with a $ — points
  'scope',          // ring sight with cross ticks — ADS
  // rare
  'bullet-return',  // a round arcing back into a mag — refund
  'droplet',        // one heavy ink droplet — lifesteal
  'slide',          // a body-arrow skidding, three speed lines — slide
  'cross',          // medical cross with a pulse notch — regen
  'wing',           // single feathered wing — air jump
  'crosshair',      // crosshair with a skull dot — crit
  'anvil',          // anvil — raw damage
  'page',           // clean comic page with a folded corner — round clear
  // epic
  'burst',          // jagged explosion star — explosive rounds
  'chain',          // two links joined by a lightning kink — chain
  'crack',          // cracked pane — glass cannon
  'speed-lines',    // four raking speed lines — momentum
  'ripple',         // three concentric jagged rings — blast radius
  'phoenix',        // bird rising from an ink blot — revive
  // legendary
  'panel',          // a comic panel frame with a broken corner — Panel Break
  'eye',            // two overlapping eyes, offset like mis-registered print — Double Vision
  'inkwell',        // spilled inkwell with a quill — Ink Pact
  'dice',           // a d6 mid-tumble — Wild Draw
] as const;

export type BoonIconId = (typeof BOON_ICON_IDS)[number];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// BOON_TUNING — every magnitude in the pool, in one block.
//
// These are CONTENT numbers (what IS Heavy Ink), not feel numbers, so they live here rather
// than in `game/tuning.ts` — same call as `weapons/defs.ts` putting `rpm` next to the gun.
// The one thing that arguably belongs in `tuning.ts` is `DRAW`; see the note in the result.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const BOON_TUNING = {
  // ── common: boring on purpose. These are the baseline the rares are measured against. ─────
  fireRatePerStack: 1.12,
  healthPerStack: 20,
  reloadPerStack: 1.15,
  magPerStack: 1.2,
  magReservePerStack: 1.1,
  recoilPerStack: 0.85,
  gripSpreadPerStack: 0.9,
  movePerStack: 1.06,
  pointsPerStack: 1.15,
  adsPerStack: 1.2,
  adsSpreadPerStack: 0.92,

  // ── rare ──────────────────────────────────────────────────────────────────────────────────
  refundPerStack: 1,
  lifestealPerStack: 6,
  slideDamagePerStack: 45,
  slideImpulsePerStack: 1.05,
  regenDelayPerStack: 1.2,
  regenRatePerStack: 1.4,
  airControlPerStack: 1.25,
  critPerStack: 0.6,
  damageRarePerStack: 1.18,

  // ── epic ──────────────────────────────────────────────────────────────────────────────────
  explosiveChancePerStack: 0.2,
  explosiveRadiusPerExtraStack: 0.35,
  chainChanceFirst: 0.5,
  chainChancePerExtraStack: 0.25,
  glassDamagePerStack: 1.7,
  glassHealthPerStack: 0.6,
  splashRadiusPerStack: 1.6,

  /** KINETIC INK: a decaying kill-fuelled buff. The cap is what keeps it inside comfort. */
  kinetic: {
    fireRatePerCharge: 0.05,
    movePerCharge: 0.02,
    maxCharges: 6,
    /** Seconds a charge survives without a kill. One kill refreshes the whole meter. */
    chargeLife: 5,
    /** Charges gained per kill, per boon stack. */
    chargesPerKill: 1,
  },

  // ── legendary ─────────────────────────────────────────────────────────────────────────────

  /**
   * PANEL BREAK (GAME_BIBLE §5): "killing 10 zombies in 3s freezes time for 2s".
   *
   * The world drops to `timeScale`; the player does NOT get a matching movement boost, because
   * movement acceleration is an absolute m/s² and scaling the target speed inside a slowed clock
   * makes you accelerate *slower* in real terms, not faster. What DOES compensate cleanly is
   * anything driven by a plain timer — fire rate, reload, ADS — so those are divided by the
   * scale and you shoot at full real-world speed into a frozen panel. That is also the version
   * that cannot touch the comfort budget: your speed, and therefore the camera, never changes.
   */
  panelBreak: {
    killsToTrigger: 10,
    killsLessPerExtraStack: 2,
    window: 3,
    duration: 2,
    durationPerExtraStack: 0.6,
    timeScale: 0.22,
    /** Real seconds before it can fire again. Without this, round 20 is one long freeze. */
    cooldown: 14,
    blendOut: 0.35,
  },

  doubleVisionDamageAtMaxStacks: 0.6,

  inkPact: {
    health: 1,
    damage: 4,
    speed: 1.5,
  },

  /**
   * The generic stat-effect layer in `./effects.ts`. These are NOT per-boon numbers — they are
   * how the four unclaimed `PlayerStats` fields cash out into damage, and anything that raises
   * those fields (a boon, a power-up, a future affix) gets them.
   */
  effects: {
    /** Explosion damage as a fraction of the bullet that set it off. */
    explosiveDamageFraction: 0.8,
    /** Chain arc damage as a fraction of the crit that started it. */
    chainDamageFraction: 0.45,
    /** How far a chain arc reaches for its next target, metres. */
    chainRadius: 6.5,
    /** Contact-damage tick while sliding, and the reach of the tick, metres. */
    slideTick: 0.18,
    slideRadius: 1.6,
    /** Height above the feet the slide sphere is centred at. */
    slideHeight: 0.5,
  },
} as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE DRAW — rarity weights, and how they shift with the round number.
//
// GAME_BIBLE §5: "late rounds see more epics". Linear ramps with hard rails, so round 30 is
// generous but never *only* legendaries — a run still has to be built, not handed over.
//
//        round 1        round 10       round 20       round 30
//   com  59.8           40.0           18.0           18.0
//   rare 27.4           31.0           34.0           34.0
//   epic 10.3           22.0           34.0           34.0
//   leg   2.5            7.0           12.0           14.0
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const BOON_DRAW = {
  /**
   * ROUND 1 IS THE MECHANIC'S ONLY INTRODUCTION. At 62/27/9/2 the first hand a player ever sees
   * was ~11% epic-or-better PER CARD, which in practice means two flat percentages and a third
   * flat percentage — the weakest possible showcase for a pool whose whole design is
   * build-defining Epics and Legendaries (GLASS CANNON, INK PACT, WILD DRAW, PANEL BREAK). The
   * bump to 13/3 puts epic-or-better at ~17% a card, so roughly half of first draws contain
   * something that looks dangerous. The late-game rails (`max`) are untouched.
   */
  base: { common: 62, rare: 27, epic: 13, legendary: 3 } as Record<BoonRarity, number>,
  perRound: { common: -2.2, rare: 0.4, epic: 1.3, legendary: 0.5 } as Record<BoonRarity, number>,
  min: { common: 18, rare: 27, epic: 13, legendary: 3 } as Record<BoonRarity, number>,
  max: { common: 62, rare: 34, epic: 34, legendary: 14 } as Record<BoonRarity, number>,

  /**
   * PITY. From this round on, an all-common hand is re-rolled once at rare-or-better. Three
   * boring cards is the one draw that makes a player stop caring about the draw.
   */
  pityFromRound: 4,

  /** Cards dealt. The bible says 1 of 3 everywhere; `offer(count)` may still override it. */
  cards: 3,
} as const;

/** Weight for `rarity` at `round`, already railed. */
export function rarityWeight(rarity: BoonRarity, round: number): number {
  const r = Math.max(0, round);
  const w = BOON_DRAW.base[rarity] + BOON_DRAW.perRound[rarity] * r;
  const lo = BOON_DRAW.min[rarity];
  const hi = BOON_DRAW.max[rarity];
  return w < lo ? lo : w > hi ? hi : w;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// RUN STATE for the behavioural boons.
//
// `modify()` is pure and gets no closure over anything, so a boon whose stat effect VARIES over
// the run (Kinetic Ink's decaying charges, Second Printing's consumed revive, Panel Break's
// active window) reads it from here, and its `attach()` writes here and calls
// `ctx.player.recomputeStats()`. This is run state, not def state — one object, reset per run.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** A per-frame tick a behavioural boon needs. The boon SYSTEM runs these; defs never poll. */
export type BoonTicker = (dt: number, ctx: GameCtx) => void;

export const BOON_RUNTIME = {
  /** Kinetic Ink charges currently held, 0..`kinetic.maxCharges`. */
  kineticCharges: 0,
  kineticTimer: 0,

  /**
   * Second Printing revives ALREADY SPENT this run. Counting spends, not stock, is what makes
   * the boon idempotent under `BoonSystem.apply()`'s teardown-and-rebuild: the old disposer runs
   * and then `attach(ctx, newStacks)` re-runs, so anything `attach` writes into run state is
   * written against a wiped counter. The old code did `revives = min(stacks, revives + 1)`
   * against a freshly-zeroed `revives`, which always evaluated to 1 — so the second stack of a
   * 2-stack EPIC granted nothing at all, and taking it after spending your revive refunded it.
   * A spend counter has neither failure mode: `modify` derives the stock from `stacks`.
   */
  revivesSpent: 0,

  /** 1 while Panel Break is idle; `1 / timeScale` while it is firing. */
  panelBoost: 1,

  /** Tickers registered by `attach()`. Iterated by the boon system's `update()`. */
  tickers: [] as BoonTicker[],
};

export function resetBoonRuntime(): void {
  BOON_RUNTIME.kineticCharges = 0;
  BOON_RUNTIME.kineticTimer = 0;
  BOON_RUNTIME.revivesSpent = 0;
  BOON_RUNTIME.panelBoost = 1;
  BOON_RUNTIME.tickers.length = 0;
}

function addTicker(t: BoonTicker): () => void {
  BOON_RUNTIME.tickers.push(t);
  return () => {
    const i = BOON_RUNTIME.tickers.indexOf(t);
    if (i >= 0) BOON_RUNTIME.tickers.splice(i, 1);
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Def plumbing
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The shipped def type. Structurally a `BoonDef` (so `allDefs` satisfies the frozen contract)
 * plus two things the contract has no room for: a typed icon id, and the stack `order` the
 * modifier is inserted at.
 */
export interface BoonDefX extends BoonDef {
  icon: BoonIconId;
  /** Lower runs first in `StatModifierStack`. 0 = normal. 100 = "this one wins" (Ink Pact). */
  order?: number;
}

/** `x ** stacks` — the multiplicative stacking rule, spelled out once. */
function pow(base: number, stacks: number): number {
  return Math.pow(base, stacks);
}

function def(d: BoonDefX): BoonDefX {
  return d;
}

const T = BOON_TUNING;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// COMMON — boring on purpose (GAME_BIBLE §5). They are the floor everything else builds on,
// and they exist so that the moment an epic lands the player can FEEL the difference in kind.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const COMMON: BoonDefX[] = [
  def({
    id: 'trigger_finger',
    name: 'TRIGGER FINGER',
    description: '+12% fire rate.',
    rarity: 'common',
    icon: 'bolt',
    maxStacks: 5,
    modify(s, n) { s.fireRateMult *= pow(T.fireRatePerStack, n); },
  }),
  def({
    id: 'thick_skin',
    name: 'THICK SKIN',
    description: '+20 max health.',
    rarity: 'common',
    icon: 'heart',
    maxStacks: 5,
    modify(s, n) { s.maxHealth += T.healthPerStack * n; },
  }),
  def({
    id: 'oiled_action',
    name: 'OILED ACTION',
    description: '+15% reload speed.',
    rarity: 'common',
    icon: 'mag',
    maxStacks: 4,
    modify(s, n) { s.reloadSpeedMult *= pow(T.reloadPerStack, n); },
  }),
  def({
    id: 'deep_pockets',
    name: 'DEEP POCKETS',
    description: '+20% magazine, +10% reserve ammo.',
    rarity: 'common',
    icon: 'bullets',
    maxStacks: 4,
    modify(s, n) {
      s.magSizeMult *= pow(T.magPerStack, n);
      s.reserveAmmoMult *= pow(T.magReservePerStack, n);
    },
  }),
  def({
    id: 'sure_grip',
    name: 'SURE GRIP',
    description: '-15% recoil, -10% spread.',
    rarity: 'common',
    icon: 'grip',
    maxStacks: 4,
    modify(s, n) {
      s.recoilMult *= pow(T.recoilPerStack, n);
      s.spreadMult *= pow(T.gripSpreadPerStack, n);
    },
  }),
  def({
    id: 'light_feet',
    name: 'LIGHT FEET',
    description: '+6% move speed.',
    rarity: 'common',
    icon: 'boot',
    maxStacks: 5,
    modify(s, n) { s.moveSpeed *= pow(T.movePerStack, n); },
  }),
  def({
    id: 'blood_money',
    name: 'BLOOD MONEY',
    description: '+15% points from everything.',
    rarity: 'common',
    icon: 'coin',
    maxStacks: 4,
    modify(s, n) { s.pointsMult *= pow(T.pointsPerStack, n); },
  }),
  def({
    id: 'snap_sights',
    name: 'SNAP SIGHTS',
    description: '+20% aim speed, -8% spread.',
    rarity: 'common',
    icon: 'scope',
    maxStacks: 3,
    modify(s, n) {
      s.adsSpeedMult *= pow(T.adsPerStack, n);
      s.spreadMult *= pow(T.adsSpreadPerStack, n);
    },
  }),
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// RARE — the first cards that change how you PLAY rather than how big a number is.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const RARE: BoonDefX[] = [
  def({
    id: 'brass_catcher',
    name: 'BRASS CATCHER',
    description: 'Headshots put a bullet back in the mag.',
    rarity: 'rare',
    icon: 'bullet-return',
    maxStacks: 3,
    modify(s, n) { s.headshotRefund += T.refundPerStack * n; },
  }),
  def({
    id: 'red_ink',
    name: 'RED INK',
    description: 'Every kill heals you for 6.',
    rarity: 'rare',
    icon: 'droplet',
    maxStacks: 4,
    modify(s, n) { s.lifestealPerKill += T.lifestealPerStack * n; },
  }),
  def({
    id: 'roadkill',
    name: 'ROADKILL',
    description: 'Sliding through zombies deals 45 damage.',
    rarity: 'rare',
    icon: 'slide',
    maxStacks: 3,
    modify(s, n) {
      s.slideDamage += T.slideDamagePerStack * n;
      s.slideImpulse *= pow(T.slideImpulsePerStack, n);
    },
  }),
  def({
    id: 'second_wind',
    name: 'SECOND WIND',
    description: 'Regen starts 1.2s sooner and heals 40% faster.',
    rarity: 'rare',
    icon: 'cross',
    maxStacks: 3,
    modify(s, n) {
      s.regenDelay -= T.regenDelayPerStack * n;
      s.healthRegenPerSec *= pow(T.regenRatePerStack, n);
    },
  }),
  def({
    id: 'page_turner',
    name: 'PAGE TURNER',
    description: '+1 air jump and +25% air control.',
    rarity: 'rare',
    icon: 'wing',
    maxStacks: 2,
    modify(s, n) {
      s.extraJumps += n;
      s.airControl *= pow(T.airControlPerStack, n);
    },
  }),
  def({
    id: 'hollow_point',
    name: 'HOLLOW POINT',
    description: '+0.6 headshot multiplier.',
    rarity: 'rare',
    icon: 'crosshair',
    maxStacks: 3,
    modify(s, n) { s.critMult += T.critPerStack * n; },
  }),
  def({
    id: 'heavy_ink',
    name: 'HEAVY INK',
    description: '+18% damage.',
    rarity: 'rare',
    icon: 'anvil',
    maxStacks: 4,
    modify(s, n) { s.damageMult *= pow(T.damageRarePerStack, n); },
  }),
  /**
   * The one behavioural rare, and it exists to make the round-clear beat matter: it turns the
   * "perfect round" flag the director already emits into a real reward. At 2 stacks it stops
   * caring whether the round was perfect, which is a genuinely different card.
   */
  def({
    id: 'clean_page',
    name: 'CLEAN PAGE',
    description: 'Clear a round untouched: full heal and full ammo.',
    rarity: 'rare',
    icon: 'page',
    maxStacks: 2,
    attach(ctx, stacks) {
      return ctx.events.on('round:cleared', (p) => {
        if (!p.perfect && stacks < 2) return;
        ctx.player.heal(ctx.player.stats.maxHealth);
        ctx.weapons.refillAmmo('all');
        ctx.events.emit('fx:sound', { id: 'heal_pulse', volume: 0.9 });
      });
    },
  }),
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// EPIC — build-defining. Each of these is a reason to change what you shoot at and where you
// stand, and three of them (Boom Shot, Shock Panel, Splash Page) form a combo the player can
// see coming two rounds out. Splash Page does NOTHING on its own — that is the design: a card
// that is worthless until it is the best card in the deck.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const EPIC: BoonDefX[] = [
  def({
    id: 'boom_shot',
    name: 'BOOM SHOT',
    description: '20% of your bullets detonate.',
    rarity: 'epic',
    icon: 'burst',
    maxStacks: 3,
    modify(s, n) {
      s.explosiveChance += T.explosiveChancePerStack * n;
      s.explosiveRadius += T.explosiveRadiusPerExtraStack * (n - 1);
    },
  }),
  def({
    id: 'shock_panel',
    name: 'SHOCK PANEL',
    description: 'Half your headshots chain lightning.',
    rarity: 'epic',
    icon: 'chain',
    maxStacks: 3,
    modify(s, n) {
      s.chainChance += T.chainChanceFirst + T.chainChancePerExtraStack * (n - 1);
      s.chainTargets += n - 1;
    },
  }),
  def({
    id: 'glass_cannon',
    name: 'GLASS CANNON',
    description: '+70% damage. -40% max health.',
    rarity: 'epic',
    icon: 'crack',
    maxStacks: 2,
    modify(s, n) {
      s.damageMult *= pow(T.glassDamagePerStack, n);
      s.maxHealth *= pow(T.glassHealthPerStack, n);
    },
  }),
  /**
   * KINETIC INK — the aggression engine. Charges are held in run state and read by `modify`,
   * so the buff flows through the SAME modifier stack as everything else instead of being a
   * parallel set of numbers some other system has to remember to apply.
   */
  def({
    id: 'kinetic_ink',
    name: 'KINETIC INK',
    description: 'Each kill: +5% fire rate, +2% speed. Stacks 6x.',
    rarity: 'epic',
    icon: 'speed-lines',
    maxStacks: 2,
    modify(s) {
      const c = BOON_RUNTIME.kineticCharges;
      if (c <= 0) return;
      s.fireRateMult *= 1 + T.kinetic.fireRatePerCharge * c;
      s.moveSpeed *= 1 + T.kinetic.movePerCharge * c;
    },
    attach(ctx, stacks) {
      const cap = T.kinetic.maxCharges;
      const offKill = ctx.events.on('enemy:killed', () => {
        BOON_RUNTIME.kineticTimer = T.kinetic.chargeLife;
        const next = Math.min(cap, BOON_RUNTIME.kineticCharges + T.kinetic.chargesPerKill * stacks);
        if (next === BOON_RUNTIME.kineticCharges) return;
        BOON_RUNTIME.kineticCharges = next;
        ctx.player.recomputeStats();
      });
      // Decay is a ticker rather than a timer-per-kill: one charge falls off every `chargeLife`
      // seconds of not killing, so the meter drains instead of snapping to zero.
      const offTick = addTicker((dt, c2) => {
        if (BOON_RUNTIME.kineticCharges <= 0) return;
        BOON_RUNTIME.kineticTimer -= dt;
        if (BOON_RUNTIME.kineticTimer > 0) return;
        BOON_RUNTIME.kineticTimer = T.kinetic.chargeLife;
        BOON_RUNTIME.kineticCharges--;
        c2.player.recomputeStats();
      });
      return () => {
        offKill();
        offTick();
        BOON_RUNTIME.kineticCharges = 0;
        BOON_RUNTIME.kineticTimer = 0;
      };
    },
  }),
  def({
    id: 'splash_page',
    name: 'SPLASH PAGE',
    description: '+60% blast radius, +1 chain target.',
    rarity: 'epic',
    icon: 'ripple',
    maxStacks: 2,
    modify(s, n) {
      s.explosiveRadius *= pow(T.splashRadiusPerStack, n);
      s.chainTargets += n;
    },
  }),
  /**
   * SECOND PRINTING — GAME_BIBLE §7's self-revive.
   *
   * `PlayerService` consumes a charge by decrementing its own BASE stats, which a persistent
   * `+1 reviveCharges` modifier would silently refill on the next recompute — an infinite-life
   * bug that would have compiled. So the charge lives in run state, `modify` reports it, and
   * `player:revived` (which the player emits at the exact moment it is spent) burns it.
   */
  def({
    id: 'second_printing',
    name: 'SECOND PRINTING',
    description: 'Cheat death once. Back up at half health.',
    rarity: 'epic',
    icon: 'phoenix',
    maxStacks: 2,
    // One charge PER STACK, minus what has already been burned. `attach` writes no run state at
    // all, so a rebuild at a higher stack count is a pure no-op on the counter.
    modify(s, n) { s.reviveCharges += Math.max(0, n - BOON_RUNTIME.revivesSpent); },
    attach(ctx, _stacks) {
      ctx.player.recomputeStats();
      const off = ctx.events.on('player:revived', () => {
        BOON_RUNTIME.revivesSpent++;
        ctx.player.recomputeStats();
        ctx.events.emit('fx:flash', { intensity: 0.55 });
      });
      return () => { off(); BOON_RUNTIME.revivesSpent = 0; };
    },
  }),
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// LEGENDARY — the run goes off the rails. Three of these are specified in GAME_BIBLE §5 and are
// implemented to the letter; Wild Draw is ours, and it is the most broken card in the game on
// purpose, because a roguelite needs one card that makes the player laugh out loud.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const LEGENDARY: BoonDefX[] = [
  def({
    id: 'panel_break',
    name: 'PANEL BREAK',
    description: '10 kills in 3s freezes the panel. You keep firing.',
    rarity: 'legendary',
    icon: 'panel',
    maxStacks: 3,
    /** Compensates the timer-driven stats so the gun runs at real-world speed while frozen. */
    modify(s) {
      const b = BOON_RUNTIME.panelBoost;
      if (b === 1) return;
      s.fireRateMult *= b;
      s.reloadSpeedMult *= b;
      s.adsSpeedMult *= b;
    },
    attach(ctx, stacks) {
      const P = T.panelBreak;
      const need = Math.max(3, P.killsToTrigger - P.killsLessPerExtraStack * (stacks - 1));
      const duration = P.duration + P.durationPerExtraStack * (stacks - 1);

      // Ring of kill timestamps (UNSCALED seconds — a freeze must not extend its own window).
      const stamps = new Float64Array(32);
      let head = 0;
      let count = 0;
      let cooldown = 0;
      let remaining = 0;
      /**
       * Separate from `remaining` on purpose. The ticker decrements `remaining` to zero and
       * THEN calls `stop()`, so a `stop()` guarded on `remaining > 0` would decline to do
       * anything at exactly the moment it is needed — the freeze would never end and the
       * gun would keep its 4.5× fire rate for the rest of the run. Caught by the harness.
       */
      let active = false;
      /** The timeScale we found on the way in. Restored exactly, never assumed to be 1. */
      let priorScale = 1;

      const stop = (): void => {
        if (!active) return;
        active = false;
        remaining = 0;
        BOON_RUNTIME.panelBoost = 1;
        ctx.time.timeScale = priorScale;
        ctx.renderer.panelFrame(0);
        ctx.player.recomputeStats();
      };

      const offKill = ctx.events.on('enemy:killed', () => {
        if (active || cooldown > 0) return;
        const now = ctx.time.unscaledElapsed;
        stamps[head] = now;
        head = (head + 1) % stamps.length;
        if (count < stamps.length) count++;
        let within = 0;
        for (let i = 0; i < count; i++) if (now - stamps[i] <= P.window) within++;
        if (within < need) return;

        // FIRE.
        count = 0;
        head = 0;
        active = true;
        remaining = duration;
        cooldown = P.cooldown + duration;
        priorScale = ctx.time.timeScale;
        ctx.time.timeScale = priorScale * P.timeScale;
        BOON_RUNTIME.panelBoost = 1 / P.timeScale;
        ctx.player.recomputeStats();
        ctx.renderer.panelFrame(1);
        ctx.events.emit('fx:flash', { intensity: 0.7 });
        ctx.events.emit('fx:sound', { id: 'upgrade_chime', volume: 1 });
        ctx.hud.titleCard('PANEL BREAK', undefined, Math.min(duration, 1.6));
      });

      // Real seconds: `update()` is handed `frameDt`, which timeScale does not touch. A freeze
      // measured in frozen time would never end.
      const offTick = addTicker((dt) => {
        if (cooldown > 0) cooldown -= dt;
        if (!active) return;
        remaining -= dt;
        if (remaining <= 0) stop();
      });

      return () => { offKill(); offTick(); stop(); BOON_RUNTIME.panelBoost = 1; };
    },
  }),
  def({
    id: 'double_vision',
    name: 'DOUBLE VISION',
    description: 'Every gun fires a ghost bullet at 50% damage.',
    rarity: 'legendary',
    icon: 'eye',
    maxStacks: 2,
    modify(s, n) {
      s.extraShots += n;
      if (n >= 2) s.extraShotDamageMult = T.doubleVisionDamageAtMaxStacks;
    },
  }),
  def({
    id: 'ink_pact',
    name: 'INK PACT',
    description: 'You have 1 HP. 4x damage. 1.5x speed.',
    rarity: 'legendary',
    icon: 'inkwell',
    maxStacks: 1,
    /** Runs LAST so a health boon taken afterwards cannot quietly cancel the pact. */
    order: 100,
    modify(s) {
      s.maxHealth = T.inkPact.health;
      s.damageMult *= T.inkPact.damage;
      s.moveSpeed *= T.inkPact.speed;
    },
  }),
  /**
   * WILD DRAW — every round you clear also deals you a free boon. Taken on round 6 it is worth
   * roughly a doubling of the whole run's progression, which is exactly the "a run that goes off
   * the rails is the point" card GAME_BIBLE §5 asks for. It goes through `BoonService.grant`
   * on the CONTRACT (`ctx.boons`), so it cannot desync from a normal pick.
   */
  def({
    id: 'wild_draw',
    name: 'WILD DRAW',
    description: 'Every round you clear also deals you a free boon.',
    rarity: 'legendary',
    icon: 'dice',
    maxStacks: 1,
    attach(ctx) {
      return ctx.events.on('round:cleared', () => {
        const pool = ctx.boons.allDefs;
        // Reservoir pick over the eligible defs — one pass, no array allocation.
        let seen = 0;
        let chosen: string | null = null;
        for (let i = 0; i < pool.length; i++) {
          const d = pool[i];
          if (ctx.boons.stacksOf(d.id) >= d.maxStacks) continue;
          seen++;
          if (ctx.rng.next() < 1 / seen) chosen = d.id;
        }
        if (chosen) ctx.boons.grant(chosen);
      });
    },
  }),
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE POOL
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const BOON_DEFS: readonly BoonDefX[] = [...COMMON, ...RARE, ...EPIC, ...LEGENDARY];

export const BOON_RARITIES: readonly BoonRarity[] = ['common', 'rare', 'epic', 'legendary'];

/** Defs of one rarity, in declaration order. Built once — the draw must not allocate. */
export const BOON_BY_RARITY: Readonly<Record<BoonRarity, readonly BoonDefX[]>> = {
  common: COMMON,
  rare: RARE,
  epic: EPIC,
  legendary: LEGENDARY,
};

const _byId = new Map<string, BoonDefX>();
for (const d of BOON_DEFS) {
  if (_byId.has(d.id)) throw new Error(`[boons] duplicate boon id: ${d.id}`);
  _byId.set(d.id, d);
}

export function boonById(id: string): BoonDefX | undefined {
  return _byId.get(id);
}

/** Exposed for the harness: apply one def's `modify` to a stat block without a service. */
export function applyBoonModify(d: BoonDefX, stats: PlayerStats, stacks: number): void {
  d.modify?.(stats, stacks);
}

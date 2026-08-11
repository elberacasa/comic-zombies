/**
 * PACK-A-PUNCH — the damage cliff that decides where the run ends (BO2_MECHANICS §5).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THIS FILE IS WIRING, ON PURPOSE. READ BEFORE "IMPROVING" IT.
 *
 *  The upgrade system is already built and was already correct — it was simply unreachable:
 *
 *      `UPGRADE`      (weapons/defs.ts)  the ×2.1 damage / ×1.5 mag / ×0.85 reload table
 *      `upgradedDef`  (weapons/defs.ts)  pure: returns a DERIVED `WeaponDef`, renames it
 *      `WeaponAffix`  (core/types.ts)    'shock' | 'flame' | 'ink'
 *      `.upgrade()`   (WeaponService)    swaps the instance's def and emits `weapon:upgraded`
 *
 *  Because the upgraded form is a plain `WeaponDef`, every system downstream — firing, the
 *  viewmodel, the HUD, the recoil solver — keeps working with zero awareness that an upgrade
 *  happened. So the ONLY thing missing was a machine, a price, and the beat. That is all that is
 *  here. Nothing in this file recomputes damage, and nothing here may start to.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY IT HAS TO EXIST AT ALL: our round health curve is the CoD recurrence (`roundHealth()`,
 * checked by `tools/combat.mjs`), so we have BO2's exact wall coming — past round ~25 an
 * un-upgraded gun mathematically cannot keep up. §5: "it is not a nice-to-have, it is the thing
 * that decides where the run ends."
 */

import { Vector3 } from 'three';

import type { GameCtx, RNG, WeaponAffix } from '@/core/types';
import { PALETTE, SEMANTIC } from '@/art/palette';
import { MACHINE, MachineKit, machineWord, type MachineVisual } from './perks';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Tuning. Belongs in `src/game/tuning.ts`; parked here for the same reason as `PERK` — see
// the note at the top of `perks.ts`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const PAP = {
  /**
   * BO2's number, unchanged. It is deliberately more than two full rounds of income at the point
   * you first want it, which is what makes "box again or bank for the Punch" the decision §0
   * says the whole game is actually about.
   */
  cost: 5000,
  /** How long the machine holds its lit/handed-back state before going quiet again. */
  beatTime: 1.4,
  /** Title card seconds for the reveal. Short — it must not eat a round beat. */
  cardTime: 1.5,
} as const;

/**
 * The three shipped affixes. `'none'` is excluded deliberately: it exists in the type as the
 * un-upgraded default and its name ('MK-II') is the fallback for a gun that got no element.
 * Every Pack-a-Punch here rolls a real one, because the elemental identity is the *visible* half
 * of the upgrade — `GAME_BIBLE §3`: shock chain / flame DoT / ink-blind.
 */
const AFFIXES: readonly WeaponAffix[] = ['shock', 'flame', 'ink'];

/** Affix → the hue the machine flashes. None of these are `ACID`/`HOT` (reserved, ART §9). */
const AFFIX_COLOR: Record<string, number> = {
  shock: PALETTE.ELECTRIC,
  flame: PALETTE.RUST,
  ink: PALETTE.NIGHT_B,
  none: PALETTE.GOLD,
};

export class PackAPunch {
  readonly id = 'packapunch';
  readonly position = new Vector3();
  readonly useRadius = MACHINE.useRadius;

  private visual: MachineVisual | null = null;
  /**
   * Own stream, forked once in `build`. Everything random in this file comes from here and
   * nothing else — no `Math.random()`, no clock. The affix a run rolls is a function of the run
   * seed and the order of purchases, so a replay reproduces it exactly (`GAME_BIBLE §9.3`).
   */
  private rng: RNG | null = null;
  private beat = 0;
  private beatColor: number = SEMANTIC.interactable;
  private _upgrades = 0;

  get upgradeCount(): number { return this._upgrades; }

  build(ctx: GameCtx, kit: MachineKit): void {
    // Bare fork — parent-derived, so the affix varies run to run and still replays from
    // `?seed=`. See the longer note on the same call in `box.ts`.
    this.rng = ctx.rng.fork();
    this.visual = kit.build(ctx, {
      shape: 'cabinet',
      label: 'PACK-A-PUNCH',
      // INK body: the Punch is the one machine that is not selling you a comfort. It is a black
      // press with a gold mouth, and it should read as heavier than the perk cabinets beside it.
      bodyColor: PALETTE.INK_SOFT,
      glowColor: SEMANTIC.interactable,
    });
  }

  place(position: Vector3, yaw: number): void {
    this.position.copy(position);
    const v = this.visual;
    if (!v) return;
    v.root.position.copy(position);
    v.root.rotation.set(0, yaw, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // The prompt
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * Per-frame, allocation-free. Every branch that is NOT "you may buy this" says why, because a
   * machine you are standing on that does nothing when you press F is indistinguishable from a
   * bug — and you are being chased while you read it.
   */
  promptText(ctx: GameCtx): string | null {
    const w = ctx.weapons.current;
    if (!w) return 'PACK-A-PUNCH — NO WEAPON';
    if (w.upgraded) return `${w.def.name} — ALREADY PACKED`;
    if (!ctx.player.canAfford(PAP.cost)) {
      return `PACK-A-PUNCH [${PAP.cost}] · NEED ${PAP.cost - ctx.player.points}`;
    }
    return `PRESS F — PACK-A-PUNCH [${PAP.cost}]`;
  }

  /**
   * The interact edge. Order is load-bearing: every REFUSAL is checked before the money moves,
   * so a player holding an already-packed gun is never charged 5000 for nothing. `spend()` itself
   * applies no policy of its own — deciding who may buy is this system's job, by contract.
   */
  use(ctx: GameCtx): void {
    const w = ctx.weapons.current;
    if (!w || w.upgraded) return;

    // `WeaponService` upgrades BY SLOT and does not publish which slot is current. `slots` is the
    // live array `current` is drawn from, so identity search is exact — not a heuristic.
    const slot = ctx.weapons.slots.indexOf(w);
    if (slot < 0) return;

    if (!ctx.player.spend(PAP.cost, 'packapunch')) return;

    // ONE draw, from the forked stream, inside the fixed step. `pick` is uniform over the three.
    const affix = this.rng ? this.rng.pick(AFFIXES) : 'shock';

    ctx.weapons.upgrade(slot, affix);
    // BO2 hands the gun back full. It also matters mechanically: `upgradedDef` raises `magSize`
    // and `reserveAmmo`, and without this you would walk away with the OLD ammo count in a bigger
    // magazine and think the upgrade shorted you.
    ctx.weapons.refillAmmo(slot);
    this._upgrades++;

    // `upgrade()` swapped the instance's def for the derived one, so this is already the new
    // comic-ified name — "RATATAT THUNDERPEN", built by `upgradedDef`, not spelled here.
    const name = w.def.name;
    const color = AFFIX_COLOR[affix] ?? PALETTE.GOLD;
    this.beat = PAP.beatTime;
    this.beatColor = color;

    ctx.events.emit('ui:titleCard', { text: 'PACKED', subtitle: name, duration: PAP.cardTime });
    ctx.events.emit('fx:word', { text: 'KA-CHUNK', position: this.position, color, scale: 1.35 });
    ctx.events.emit('fx:sound', { id: 'upgrade_chime', volume: 1 });
    ctx.events.emit('fx:shake', { amount: 0.35, duration: 0.3 });
    ctx.events.emit('fx:flash', { intensity: 0.3, color });
    this.visual?.setLabel(machineWord(name));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Presentation
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /** Real frame time, so the stamp lands through the hitstop the shake just asked for. */
  update(dt: number): void {
    if (this.beat <= 0) return;
    this.beat -= dt;
    const v = this.visual;
    if (!v) return;
    if (this.beat <= 0) {
      this.beat = 0;
      v.setGlow(SEMANTIC.interactable, 1.0);
      v.setLabel(machineWord('PACK-A-PUNCH'));
      return;
    }
    // Strobe on the 12 fps comic clock — hold frames, never interpolation (ART §8).
    const on = Math.floor(this.beat * 12) % 2 === 0;
    v.setGlow(on ? PALETTE.PAPER : this.beatColor, on ? 2.6 : 1.4);
  }

  /** New run. The weapons themselves are reset by the weapon system; only our beat is ours. */
  reset(): void {
    this._upgrades = 0;
    this.beat = 0;
    this.visual?.setGlow(SEMANTIC.interactable, 1.0);
    this.visual?.setLabel(machineWord('PACK-A-PUNCH'));
  }

  dispose(ctx: GameCtx): void {
    this.visual?.dispose(ctx);
    this.visual = null;
    this.rng = null;
  }
}

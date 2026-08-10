/**
 * PLAYER STATS — the baseline block and the modifier stack that boons write through.
 *
 * The contract (`PlayerStats` in core/types.ts) is a flat bag of numbers. The rules around it:
 *
 *   • `baseStats` is the truth. Nothing outside this file ever mutates it.
 *   • `stats` is derived: `base → each modifier in stack order → clamp`. Recomputed only when
 *     something changes (a boon taken, a power-up expiring), never per frame.
 *   • Systems READ `player.stats.x` every frame and never cache it — a boon can land mid-round.
 *   • Modifiers are plain functions, so a boon can multiply, add, or clamp; order is insertion
 *     order, which is the order boons were taken. That is intentional: "×1.12 fire rate" taken
 *     after "+2 fire rate" is a different (and better) build, and players notice.
 */

import type { PlayerStats } from '@/core/types';
import { MOVE, PLAYER } from '@/game/tuning';

/** A pure stat mutation. Receives the working copy; mutates it in place. */
export type StatModifier = (stats: PlayerStats) => void;

/** An entry in the stack. `order` breaks ties so additive boons can be forced before multiplicative. */
export interface StatModifierEntry {
  fn: StatModifier;
  /** Lower runs first. Boons default to 0; "final clamp" style effects use a high number. */
  order: number;
  /** Debug label, shown in the watch panel. */
  label: string;
}

/**
 * The baseline. Everything movement-related is derived from `MOVE` so there is exactly one
 * place to tune walk speed — the stat block does not get to disagree with the tuning file.
 */
export function makeBaseStats(): PlayerStats {
  return {
    maxHealth: PLAYER.maxHealth,

    moveSpeed: MOVE.walkSpeed,
    sprintMult: MOVE.sprintMult,
    jumpImpulse: MOVE.jumpImpulse,
    slideImpulse: MOVE.slideImpulse,
    /** 1 = the tuned air control. Boons scale this; `MOVE.airAccel` is the absolute quantity. */
    airControl: 1,

    damageMult: 1,
    critMult: PLAYER.critMult,
    fireRateMult: 1,
    reloadSpeedMult: 1,
    magSizeMult: 1,
    reserveAmmoMult: 1,
    adsSpeedMult: 1,
    spreadMult: 1,
    recoilMult: 1,

    pointsMult: 1,
    lifestealPerKill: 0,
    healthRegenPerSec: PLAYER.regenPerSecond,
    regenDelay: PLAYER.regenDelay,

    extraShots: 0,
    extraShotDamageMult: 0.5,
    explosiveChance: 0,
    explosiveRadius: 2.5,
    chainChance: 0,
    chainTargets: 2,
    slideDamage: 0,
    headshotRefund: 0,
    extraJumps: 0,
    reviveCharges: 0,
  };
}

/** Copy `src` over `dst` in place — no allocation, so `recomputeStats()` is garbage-free. */
export function copyStats(dst: PlayerStats, src: Readonly<PlayerStats>): PlayerStats {
  dst.maxHealth = src.maxHealth;
  dst.moveSpeed = src.moveSpeed;
  dst.sprintMult = src.sprintMult;
  dst.jumpImpulse = src.jumpImpulse;
  dst.slideImpulse = src.slideImpulse;
  dst.airControl = src.airControl;
  dst.damageMult = src.damageMult;
  dst.critMult = src.critMult;
  dst.fireRateMult = src.fireRateMult;
  dst.reloadSpeedMult = src.reloadSpeedMult;
  dst.magSizeMult = src.magSizeMult;
  dst.reserveAmmoMult = src.reserveAmmoMult;
  dst.adsSpeedMult = src.adsSpeedMult;
  dst.spreadMult = src.spreadMult;
  dst.recoilMult = src.recoilMult;
  dst.pointsMult = src.pointsMult;
  dst.lifestealPerKill = src.lifestealPerKill;
  dst.healthRegenPerSec = src.healthRegenPerSec;
  dst.regenDelay = src.regenDelay;
  dst.extraShots = src.extraShots;
  dst.extraShotDamageMult = src.extraShotDamageMult;
  dst.explosiveChance = src.explosiveChance;
  dst.explosiveRadius = src.explosiveRadius;
  dst.chainChance = src.chainChance;
  dst.chainTargets = src.chainTargets;
  dst.slideDamage = src.slideDamage;
  dst.headshotRefund = src.headshotRefund;
  dst.extraJumps = src.extraJumps;
  dst.reviveCharges = src.reviveCharges;
  return dst;
}

/**
 * Sanity rails applied after every modifier has run. A "×0 fire rate" boon interaction must
 * never be able to soft-lock the run; a "1 HP" legendary must still leave you at exactly 1.
 */
export function clampStats(s: PlayerStats): void {
  if (s.maxHealth < 1) s.maxHealth = 1;
  if (s.moveSpeed < 0.5) s.moveSpeed = 0.5;
  if (s.sprintMult < 1) s.sprintMult = 1;
  if (s.jumpImpulse < 0) s.jumpImpulse = 0;
  if (s.slideImpulse < 0) s.slideImpulse = 0;
  if (s.airControl < 0) s.airControl = 0;
  if (s.damageMult < 0) s.damageMult = 0;
  if (s.critMult < 1) s.critMult = 1;
  if (s.fireRateMult < 0.1) s.fireRateMult = 0.1;
  if (s.reloadSpeedMult < 0.1) s.reloadSpeedMult = 0.1;
  if (s.magSizeMult < 0.1) s.magSizeMult = 0.1;
  if (s.reserveAmmoMult < 0) s.reserveAmmoMult = 0;
  if (s.adsSpeedMult < 0.1) s.adsSpeedMult = 0.1;
  if (s.spreadMult < 0) s.spreadMult = 0;
  if (s.recoilMult < 0) s.recoilMult = 0;
  if (s.pointsMult < 0) s.pointsMult = 0;
  if (s.healthRegenPerSec < 0) s.healthRegenPerSec = 0;
  if (s.regenDelay < 0) s.regenDelay = 0;
  if (s.extraShots < 0) s.extraShots = 0;
  if (s.explosiveChance < 0) s.explosiveChance = 0;
  if (s.explosiveChance > 1) s.explosiveChance = 1;
  if (s.chainChance < 0) s.chainChance = 0;
  if (s.chainChance > 1) s.chainChance = 1;
  if (s.chainTargets < 0) s.chainTargets = 0;
  if (s.slideDamage < 0) s.slideDamage = 0;
  if (s.headshotRefund < 0) s.headshotRefund = 0;
  if (s.extraJumps < 0) s.extraJumps = 0;
  if (s.reviveCharges < 0) s.reviveCharges = 0;
}

/**
 * The injectable modifier stack. `BoonService` owns entries; it adds one per boon and disposes
 * it if the boon is ever removed. This file has no idea what a boon is, which is the point.
 */
export class StatModifierStack {
  private readonly entries: StatModifierEntry[] = [];
  private _dirty = true;

  get dirty(): boolean { return this._dirty; }
  get count(): number { return this.entries.length; }

  /** Returns a disposer. Adding or removing marks the stack dirty; it does not recompute. */
  add(fn: StatModifier, label = 'modifier', order = 0): () => void {
    const entry: StatModifierEntry = { fn, order, label };
    this.entries.push(entry);
    this.entries.sort((a, b) => a.order - b.order);
    this._dirty = true;
    return () => this.remove(entry);
  }

  remove(entry: StatModifierEntry): void {
    const i = this.entries.indexOf(entry);
    if (i >= 0) { this.entries.splice(i, 1); this._dirty = true; }
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries.length = 0;
    this._dirty = true;
  }

  /** `out = base` then every modifier in order, then the rails. */
  apply(out: PlayerStats, base: Readonly<PlayerStats>): PlayerStats {
    copyStats(out, base);
    for (let i = 0; i < this.entries.length; i++) this.entries[i].fn(out);
    clampStats(out);
    this._dirty = false;
    return out;
  }

  /** For the debug panel. */
  labels(): string {
    if (this.entries.length === 0) return 'none';
    let s = '';
    for (let i = 0; i < this.entries.length; i++) s += (i ? ',' : '') + this.entries[i].label;
    return s;
  }
}

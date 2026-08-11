/**
 * THE MYSTERY BOX — the best risk/reward loop in the genre (BO2_MECHANICS §4).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE RELOCATE IS THE MECHANIC. IT IS NOT A FLOURISH.
 *
 *  A box that stays put is a vending machine: you walk over, you pay, you get a gun, and the
 *  only question is whether you have 950 points. A box that LEAVES after a random number of uses
 *  turns every single spin into the same question BO2 players actually agonise over — *hit it
 *  again now, or walk away with what I have?* — because the next spin might be the last one on
 *  this side of the map. §4: "the move is what makes it a decision rather than a vending
 *  machine. Keep it." So: 2–5 uses, drawn from the seeded stream, then it flies to another site.
 *
 *  Everything random here — the weapon, the number of uses, the destination — comes from ONE
 *  forked stream (`ctx.rng.fork`). No `Math.random()`, no wall clock, ever: determinism is a
 *  product requirement now, not a testing convenience (`GAME_BIBLE §9.3`), because leaderboards
 *  and netcode both need a run to replay from its seed.
 *
 *  THE OUTCOME IS DECIDED IN THE FIXED STEP, THE SPIN IS PURE PRESENTATION. The weapon is rolled
 *  the instant you pay, inside `fixedUpdate`, and merely *revealed* 2.4 s later. The riffling
 *  card in between draws no randomness at all — it indexes a quantised animation clock. Get this
 *  backwards and the box becomes frame-rate dependent, which is the one bug a replay cannot
 *  survive.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THIS FILE ALSO OWNS TWO THINGS THE WHOLE ECONOMY LAYER SHARES, because they have nowhere
 * better to live while `main.ts` and `tuning.ts` belong to other agents this milestone:
 *
 *   1. `solveSites()` — where machines go, derived from `WorldService` (ground probe + capsule
 *      clearance + farthest-point spread). NOT hardcoded coordinates: the arena is regenerated
 *      from a seed and a literal `(23.4, 0, -11.8)` would be inside a wall the next time
 *      `world/arena.ts` changes.
 *   2. `createEconomyExtras()` — the ONE registration point `main.ts` needs, wrapping the box,
 *      the four perk machines and Pack-a-Punch in a single `System`. They share the interact
 *      prompt, so one of them has to arbitrate it; see `pickNearest`.
 */

import { Vector3 } from 'three';

import type {
  GameCtx, RNG, System, WeaponDef, WorldService,
} from '@/core/types';
import { PALETTE, SEMANTIC } from '@/art/palette';
import { MOVE } from '@/game/tuning';
import type { WordTexture } from '@/art/letters';
import {
  MACHINE, MachineKit, PerkBank, machineWord,
  type MachineVisual, type PerkStatHost,
} from './perks';
import { PackAPunch } from './packapunch';
import {
  OWNER_MACHINE, ownsSpot, publishDistance, resetInteractClaims, takeInteract,
} from './claim';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0. TUNING — see the note in `perks.ts` about why these are not in `game/tuning.ts` yet.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const BOX = {
  /** BO2's number, unchanged. It is ~1.5 wall-buys, which is what makes the gamble read. */
  cost: 950,
  /** Uses before it relocates, inclusive range. Drawn once per placement from the seeded stream. */
  minUses: 2,
  maxUses: 5,
  /** The spin. Long enough to be a beat, short enough that you can still be training. */
  spinTime: 2.4,
  /** How long the winning weapon's card is held up before the box settles. */
  revealTime: 1.4,
  /** The fly-away. The box is UNUSABLE for this whole window — that is the loss you can feel. */
  leaveTime: 2.0,
  /** Cards riffle at 8 fps and the lid steps at 12. Hold frames, never lerps (ART §8). */
  riffleFps: 8,
  animFps: 12,
  /** Lid hinge angle when open, radians (negative = tips back). */
  lidOpenAngle: -1.12,
  lidOpenTime: 0.3,
} as const;

export const SITE = {
  /** Candidate lattice. 4 rings × 24 spokes = 96 probes, once, at init. */
  rings: [0.30, 0.44, 0.58, 0.72] as const,
  spokes: 24,
  /** How many sites to solve. 4 perks + Pack-a-Punch = 5 fixed; the rest are box spots. */
  want: 11,
  /** A machine must be at least this far from where you spawn — the walk IS the cost (§3). */
  minFromSpawn: 14,
  /** And machines must not cluster, or the "which one first" decision evaporates. */
  minSeparation: 17,
  /**
   * Reject anything more than this above or below the floor the player SPAWNS on: street level
   * only, no roof decks.
   *
   * "The floor" is the spawn's own Y and NOT `bounds.min.y`, which is −2 — the bounding box has
   * to contain the kerbs and the sunken dock, so a probe started from it casts from below the
   * street and every downward ray in the arena misses. That cost a whole solve pass returning
   * zero sites, silently, with the machines all stacked on the origin.
   */
  maxGroundRise: 2.5,
  maxGroundDrop: 1.6,
  /** Probe height above the spawn floor. `groundAt` adds another 0.6 before it casts. */
  probeHeight: 0.9,
  /** Clearance radius for the prop itself, and for the patch of floor you stand on to use it. */
  propClearance: 0.95,
  /** How far in front of the machine the player stands, metres. */
  standOffset: 1.5,
} as const;

/**
 * Weighted draw table, keyed by ARCHETYPE rather than by weapon id, so a fifth gun added to
 * `WEAPON_DEFS` next milestone is in the box automatically at a sane weight instead of silently
 * never appearing. The pistol is the DUD and it is in here on purpose: BO2's box could always
 * hand you back something worse than what you were holding, and the possibility of wasting 950
 * is what makes the other outcomes land.
 */
const ARCHETYPE_WEIGHT: Record<WeaponDef['archetype'], number> = {
  pistol: 8,
  smg: 30,
  shotgun: 26,
  marksman: 22,
  launcher: 14,
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. SITING — where a machine may stand, asked of the world rather than typed in
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface MachineSite {
  position: Vector3;
  /** Yaw that turns the machine's face (local +Z) toward the middle of the arena. */
  yaw: number;
}

const _probe = new Vector3();
const _bottom = new Vector3();
const _top = new Vector3();
const _centre = new Vector3();

/**
 * Free-standing capsule test. `collideCapsule` returns a zero-length correction when clear.
 *
 * The capsule is a SWEPT SPHERE, so its segment runs from `y + radius` to `y + height - radius`
 * and the caps cover the rest — which is why `height` is clamped to at least a diameter. Without
 * that clamp the fat prop probe (radius 0.95, height 2.02) inverts its own segment and degenerates
 * into a point query at knee height, i.e. it silently stops testing anything.
 */
function isClear(
  world: WorldService, x: number, y: number, z: number, radius: number, height: number,
): boolean {
  const h = Math.max(height, radius * 2 + 0.05);
  _bottom.set(x, y + radius, z);
  _top.set(x, y + h - radius, z);
  const c = world.collideCapsule(_bottom, _top, radius);
  return c.correction.lengthSq() < 1e-6;
}

/**
 * Solve up to `SITE.want` machine sites from the world itself.
 *
 * Three filters, in cost order — a probe that fails the cheap test never pays for the expensive
 * one: distance from spawn, then one downward ray for the floor, then two capsule queries (the
 * prop's footprint and the patch of floor the player will stand on to use it). Spread is
 * farthest-point greedy, which is what stops all five machines landing in the same plaza.
 *
 * ~96 probes ONCE, at init, alongside the enemy nav build. Nothing here runs per frame.
 */
export function solveSites(ctx: GameCtx, rng: RNG): MachineSite[] {
  const world = ctx.world;
  const b = world.bounds;
  b.getCenter(_centre);
  const halfX = (b.max.x - b.min.x) * 0.5;
  const halfZ = (b.max.z - b.min.z) * 0.5;
  const reach = Math.min(halfX, halfZ);
  const spawn = world.playerSpawn.position;
  const floorY = spawn.y;

  const found: MachineSite[] = [];
  // Two parallel plain arrays instead of an object per candidate: this runs once, but a 96-entry
  // garbage pile at init is 96 entries the GC will collect during the first round otherwise.
  const cx: number[] = [];
  const cz: number[] = [];
  const cy: number[] = [];

  // A seeded angular offset so the lattice is not axis-aligned with the street grid — otherwise
  // every probe lands in the middle of a road and the sites are suspiciously regular.
  const phase = rng.next() * Math.PI * 2;

  for (let r = 0; r < SITE.rings.length; r++) {
    const radius = reach * SITE.rings[r];
    for (let s = 0; s < SITE.spokes; s++) {
      const a = phase + (s / SITE.spokes) * Math.PI * 2 + r * 0.13;
      const x = _centre.x + Math.cos(a) * radius;
      const z = _centre.z + Math.sin(a) * radius;

      const dsx = x - spawn.x;
      const dsz = z - spawn.z;
      if (dsx * dsx + dsz * dsz < SITE.minFromSpawn * SITE.minFromSpawn) continue;

      _probe.set(x, floorY + SITE.probeHeight, z);
      const g = world.groundAt(_probe);
      if (g === null) continue;
      if (g > floorY + SITE.maxGroundRise || g < floorY - SITE.maxGroundDrop) continue;

      if (!isClear(world, x, g, z, SITE.propClearance, MACHINE.cabinetHeight)) continue;

      // The spot you stand on to use it, one step toward the middle of the arena.
      let tx = _centre.x - x;
      let tz = _centre.z - z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const sx = x + tx * SITE.standOffset;
      const sz = z + tz * SITE.standOffset;
      if (!isClear(world, sx, g, sz, MOVE.radius, MOVE.standHeight)) continue;

      cx.push(x); cz.push(z); cy.push(g);
    }
  }

  if (cx.length === 0) return found;

  // FARTHEST-POINT GREEDY. Seed from the stream so two runs of the same seed place machines
  // identically and two different seeds do not, then repeatedly take whichever surviving
  // candidate is furthest from everything already chosen.
  const taken = new Uint8Array(cx.length);
  let first = Math.floor(rng.next() * cx.length);
  if (first >= cx.length) first = cx.length - 1;
  const push = (i: number): void => {
    taken[i] = 1;
    const dx = _centre.x - cx[i];
    const dz = _centre.z - cz[i];
    found.push({ position: new Vector3(cx[i], cy[i], cz[i]), yaw: Math.atan2(dx, dz) });
  };
  push(first);

  const minSep2 = SITE.minSeparation * SITE.minSeparation;
  while (found.length < SITE.want) {
    let best = -1;
    let bestD2 = -1;
    for (let i = 0; i < cx.length; i++) {
      if (taken[i]) continue;
      let near2 = Infinity;
      for (let j = 0; j < found.length; j++) {
        const p = found[j].position;
        const dx = p.x - cx[i];
        const dz = p.z - cz[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < near2) near2 = d2;
      }
      if (near2 < minSep2) continue;
      if (near2 > bestD2) { bestD2 = near2; best = i; }
    }
    if (best < 0) break;
    push(best);
  }

  return found;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE BOX
// ═════════════════════════════════════════════════════════════════════════════════════════════

type BoxState = 'ready' | 'spinning' | 'reveal' | 'leaving';

export class MysteryBox {
  readonly id = 'mysterybox';
  readonly position = new Vector3();
  readonly useRadius = MACHINE.useRadius;

  private visual: MachineVisual | null = null;
  private rng: RNG | null = null;

  private state: BoxState = 'ready';
  private timer = 0;
  /** Uses remaining before the relocate. Drawn on every placement. */
  private usesLeft = 0;
  private _spins = 0;
  /** The weapon this spin already landed on — rolled at purchase, shown at reveal. */
  private prize: WeaponDef | null = null;
  /** True when this spin is the one that ends with the box leaving. */
  private leavingAfter = false;

  /** Sites the box may occupy, handed over by the composite. Index of the current one. */
  private sites: readonly MachineSite[] = [];
  private siteIndex = 0;

  /** Prebuilt sign textures — the riffle must not build a cache key eight times a second. */
  private readonly riffle: WordTexture[] = [];
  private idleWord: WordTexture | null = null;
  private lidAngle = 0;

  get spins(): number { return this._spins; }
  get usesRemaining(): number { return this.usesLeft; }

  build(ctx: GameCtx, kit: MachineKit): void {
    // NO EXPLICIT SEED, deliberately — and this is the opposite choice from `solveSites`. A fork
    // WITH a seed ignores the parent's state and produces the same stream in every run; a bare
    // fork derives from it. Machine PLACEMENT wants the former (a map you can learn). Which gun
    // the box hands you, how many spins you get and where it flies to want the latter, or the
    // box is a lookup table by spin number and the gamble evaporates. Both are replayable from
    // `?seed=`, which is all determinism actually requires (`GAME_BIBLE §9.3`).
    this.rng = ctx.rng.fork();
    this.visual = kit.build(ctx, {
      shape: 'chest',
      label: 'MYSTERY BOX',
      bodyColor: PALETTE.NIGHT_B,
      glowColor: SEMANTIC.interactable,
    });
    this.idleWord = machineWord('MYSTERY BOX');
    for (const d of ctx.weapons.allDefs) this.riffle.push(machineWord(d.name));
  }

  /**
   * Hand over every spot the box is allowed to occupy and drop it on the first one. The composite
   * owns the site list because the perks and Pack-a-Punch must claim theirs first — a box that
   * relocated on top of the Pack-a-Punch would put two prompts in one place.
   */
  setSites(sites: readonly MachineSite[]): void {
    this.sites = sites;
    if (sites.length === 0) return;
    const rng = this.rng;
    this.siteIndex = rng ? Math.min(sites.length - 1, Math.floor(rng.next() * sites.length)) : 0;
    this.moveToSite(this.siteIndex);
    this.rollUses();
  }

  private moveToSite(i: number): void {
    const s = this.sites[i];
    if (!s) return;
    this.position.copy(s.position);
    const v = this.visual;
    if (!v) return;
    v.root.position.copy(s.position);
    v.root.rotation.set(0, s.yaw, 0);
  }

  /** `int(min, max + 1)` — inclusive on both ends, one draw. */
  private rollUses(): void {
    const rng = this.rng;
    this.usesLeft = rng ? rng.int(BOX.minUses, BOX.maxUses + 1) : BOX.minUses;
  }

  // ── the prompt ────────────────────────────────────────────────────────────────────────────

  promptText(ctx: GameCtx): string | null {
    if (this.state === 'spinning') return 'MYSTERY BOX · SPINNING';
    if (this.state === 'reveal') return this.prize ? `${this.prize.name}!` : null;
    if (this.state === 'leaving') return 'THE BOX IS LEAVING';
    if (!ctx.player.canAfford(BOX.cost)) {
      return `MYSTERY BOX [${BOX.cost}] · NEED ${BOX.cost - ctx.player.points}`;
    }
    return `PRESS F — MYSTERY BOX [${BOX.cost}]`;
  }

  // ── the spin ──────────────────────────────────────────────────────────────────────────────

  /**
   * Pay, roll, start the animation. THE ROLL HAPPENS HERE, in the fixed step, before a single
   * frame of the spin has been drawn — so the outcome is a function of the seed and the sim
   * step, never of how long the animation happened to run on this machine.
   */
  use(ctx: GameCtx): void {
    if (this.state !== 'ready') return;
    if (!ctx.player.spend(BOX.cost, 'mysterybox')) return;

    this.prize = this.rollWeapon(ctx);
    this._spins++;
    this.usesLeft--;
    this.leavingAfter = this.usesLeft <= 0;
    this.state = 'spinning';
    this.timer = BOX.spinTime;

    ctx.events.emit('fx:sound', { id: 'card_deal', volume: 1 });
    ctx.events.emit('fx:word', {
      text: 'SPIN', position: this.position, color: SEMANTIC.interactable, scale: 1.0,
    });
  }

  /**
   * One weighted draw over `WEAPON_DEFS`, one call to `next()`. The weights are recomputed here
   * rather than cached because the table is four entries long and a spin happens a handful of
   * times a round — caching it would be a stale-state bug in exchange for nothing.
   */
  private rollWeapon(ctx: GameCtx): WeaponDef | null {
    const defs = ctx.weapons.allDefs;
    if (defs.length === 0) return null;
    const rng = this.rng;
    let total = 0;
    for (let i = 0; i < defs.length; i++) total += ARCHETYPE_WEIGHT[defs[i].archetype] ?? 1;
    if (total <= 0) return defs[0];
    let roll = (rng ? rng.next() : 0) * total;
    for (let i = 0; i < defs.length; i++) {
      roll -= ARCHETYPE_WEIGHT[defs[i].archetype] ?? 1;
      if (roll <= 0) return defs[i];
    }
    return defs[defs.length - 1];
  }

  /** Gameplay timers. Everything that changes state or hands over a weapon lives in here. */
  fixedUpdate(dt: number, ctx: GameCtx): void {
    if (this.state === 'ready') return;
    this.timer -= dt;
    if (this.timer > 0) return;

    if (this.state === 'spinning') {
      this.award(ctx);
      this.state = 'reveal';
      this.timer = BOX.revealTime;
      return;
    }

    if (this.state === 'reveal') {
      if (this.leavingAfter) {
        this.beginLeaving(ctx);
      } else {
        this.state = 'ready';
        this.prize = null;
        if (this.idleWord) this.visual?.setLabel(this.idleWord);
      }
      return;
    }

    // 'leaving' — the box reappears somewhere else, with a fresh use count.
    this.finishLeaving(ctx);
  }

  private award(ctx: GameCtx): void {
    const def = this.prize;
    if (!def) return;
    // `give()` fills an empty slot first and only replaces what is in your hands when both are
    // full — the Zombies rule, and the one players expect. A repeat of what you already hold is
    // the dud outcome and it is allowed to happen: that is the risk half of risk/reward.
    ctx.weapons.give(def.id);
    this.visual?.setLabel(machineWord(def.name));

    ctx.events.emit('fx:word', {
      text: def.name, position: this.position, color: SEMANTIC.interactable, scale: 1.3,
    });
    ctx.events.emit('fx:sound', { id: 'weapon_equip', volume: 1 });
    ctx.events.emit('fx:flash', { intensity: 0.24, color: PALETTE.GOLD });
    ctx.hud.toast(`BOX · ${def.name}`);
  }

  private beginLeaving(ctx: GameCtx): void {
    this.state = 'leaving';
    this.timer = BOX.leaveTime;
    this.prize = null;
    const v = this.visual;
    if (v) {
      v.setLabel(machineWord('GONE'));
      v.setGlow(PALETTE.INK_SOFT, 0.2);
    }
    // The BO2 teddy bear, in our register: a word, a sting, and the box is not there any more.
    ctx.events.emit('fx:word', {
      text: 'POOF', position: this.position, color: PALETTE.NIGHT_B, scale: 1.4,
    });
    ctx.events.emit('fx:sound', { id: 'card_deal', volume: 1, pitch: 0.7 });
    ctx.hud.toast('THE BOX MOVED ON');
  }

  private finishLeaving(ctx: GameCtx): void {
    const rng = this.rng;
    const n = this.sites.length;
    if (n > 1 && rng) {
      // Uniform over the OTHER sites: `int(0, n-1)` then skip the current index, so the box can
      // never "relocate" to where it already is — which would read as the mechanic being broken.
      let next = rng.int(0, n - 1);
      if (next >= this.siteIndex) next++;
      this.siteIndex = next;
    }
    this.moveToSite(this.siteIndex);
    this.rollUses();
    this.state = 'ready';
    this.timer = 0;
    this.lidAngle = 0;
    const v = this.visual;
    if (v) {
      if (this.idleWord) v.setLabel(this.idleWord);
      v.setGlow(SEMANTIC.interactable, 1.0);
      v.root.visible = true;
      if (v.lid) v.lid.rotation.x = 0;
    }
    ctx.events.emit('fx:sound', { id: 'powerup_drop', volume: 0.9 });
  }

  // ── presentation ──────────────────────────────────────────────────────────────────────────

  /**
   * Frame time, not sim time. Nothing in here decides anything.
   *
   * THE STILLNESS TEST (ART §4.1): a box nobody is using is bit-identical frame to frame — the
   * first line returns before touching a transform, the glow is a static emissive and there is
   * no idle bob. Six machines scattered through the arena must not make the print crawl.
   */
  update(dt: number, ctx: GameCtx): void {
    if (this.state === 'ready' && this.lidAngle === 0) return;
    const v = this.visual;
    if (!v) return;

    // The box is invisible for the back half of the fly-away, so the relocate reads as a jump
    // cut rather than a slide across the map.
    if (this.state === 'leaving') {
      v.root.visible = this.timer > BOX.leaveTime * 0.45;
    }

    // Lid: quantised to `animFps` steps so it opens in hold frames like a hand-animated cel.
    const open = this.state === 'spinning' || this.state === 'reveal';
    const target = open ? BOX.lidOpenAngle : 0;
    const rate = Math.abs(BOX.lidOpenAngle) / Math.max(0.05, BOX.lidOpenTime);
    const step = rate * dt;
    if (this.lidAngle < target) this.lidAngle = Math.min(target, this.lidAngle + step);
    else if (this.lidAngle > target) this.lidAngle = Math.max(target, this.lidAngle - step);
    if (v.lid) {
      const steps = Math.max(2, Math.round(BOX.animFps));
      v.lid.rotation.x = Math.round(this.lidAngle * steps) / steps;
    }

    // The riffle: NO randomness, just the animation clock indexing a prebuilt list. Using the
    // stream here would make the sim state depend on frame rate, which is the whole bug the
    // roll-at-purchase split exists to avoid.
    if (this.state === 'spinning' && this.riffle.length > 0) {
      const tick = Math.floor(ctx.time.unscaledElapsed * BOX.riffleFps);
      v.setLabel(this.riffle[((tick % this.riffle.length) + this.riffle.length) % this.riffle.length]);
      const on = tick % 2 === 0;
      v.setGlow(on ? PALETTE.PAPER : SEMANTIC.interactable, on ? 2.2 : 1.1);
    } else if (this.state === 'reveal') {
      const on = Math.floor(ctx.time.unscaledElapsed * BOX.animFps) % 2 === 0;
      v.setGlow(on ? PALETTE.PAPER : SEMANTIC.interactable, on ? 2.6 : 1.2);
    }
  }

  /** New run: back to the opening state, including a fresh site and use count. */
  reset(ctx: GameCtx): void {
    this.state = 'ready';
    this.timer = 0;
    this.prize = null;
    this.leavingAfter = false;
    this._spins = 0;
    this.lidAngle = 0;
    const v = this.visual;
    if (v) {
      v.root.visible = true;
      if (v.lid) v.lid.rotation.x = 0;
      if (this.idleWord) v.setLabel(this.idleWord);
      v.setGlow(SEMANTIC.interactable, 1.0);
    }
    if (this.sites.length > 0) this.setSites(this.sites);
  }

  dispose(ctx: GameCtx): void {
    this.visual?.dispose(ctx);
    this.visual = null;
    this.rng = null;
    this.riffle.length = 0;
    this.idleWord = null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE COMPOSITE — the one `System` `main.ts` registers
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The shape every machine satisfies. Declared HERE and satisfied STRUCTURALLY — `PerkMachine`,
 * `MysteryBox` and `PackAPunch` do not import it, which is what keeps the module graph acyclic
 * (`box → perks`, `box → packapunch`, `packapunch → perks`, and nothing back). TypeScript still
 * checks it at the assignment below, so renaming `use()` on any of the three breaks the build.
 */
interface Machine {
  readonly id: string;
  readonly position: Vector3;
  readonly useRadius: number;
  promptText(ctx: GameCtx): string | null;
  use(ctx: GameCtx): void;
  update(dt: number, ctx: GameCtx): void;
}

export class EconomyExtrasSystem implements System {
  readonly name = 'economy-extras';

  readonly kit = new MachineKit();
  readonly perks: PerkBank;
  readonly box = new MysteryBox();
  readonly pap = new PackAPunch();

  /** Every machine, in prompt-arbitration order. Built once in `init`. */
  private readonly machines: Machine[] = [];
  private sites: MachineSite[] = [];

  /** The machine the player is standing at, decided in the fixed step. */
  private nearest: Machine | null = null;
  /** What we last pushed to `ui:prompt`, so we only ever emit on a change. */
  private shownPrompt: string | null = null;
  private promptClock = 0;

  /** Interact edge, latched once per FRAME and consumed by the next fixed step. */
  private pendingUse = false;
  private inputFrame = -1;
  /**
   * The frame the pending press was LATCHED on, which is not always the frame it is spent on: a
   * frame above 120 fps runs no fixed step, so a press latched in `update` is consumed by the
   * next frame's `fixedUpdate`. The claim broker is stamped per press, so it has to be told the
   * frame the press happened on or the wall-buy layer could take the same press one frame earlier
   * and this deferral would spend it a second time.
   */
  private pendingFrame = -1;
  private sawSpawn = false;
  private offSpawn: (() => void) | null = null;

  constructor(host: PerkStatHost | null) {
    this.perks = new PerkBank(host);
  }

  // ── build ─────────────────────────────────────────────────────────────────────────────────

  init(ctx: GameCtx): void {
    this.kit.init(ctx);
    this.perks.build(ctx, this.kit);
    this.box.build(ctx, this.kit);
    this.pap.build(ctx, this.kit);

    for (const m of this.perks.machines) this.machines.push(m);
    this.machines.push(this.pap);
    this.machines.push(this.box);

    // EXPLICITLY SEEDED, so placement ignores the run seed and the machines are in the same
    // places every game. That is not laziness, it is the BO2 rule: perk locations are a property
    // of the MAP, and learning "Jug is through the west alley" is half of what map knowledge is.
    // Its own stream, too, so adding a machine cannot shift which gun the box hands out on spin
    // three (`core/rng.ts`, "FORKING").
    const rng = ctx.rng.fork(0x5117e5);
    this.sites = solveSites(ctx, rng);
    this.assignSites(ctx);

    // A new run wipes the player's modifier stack in `respawn()`, so our perk disposers point at
    // entries that no longer exist. Same contract the boon layer follows, same reason.
    this.offSpawn = ctx.events.on('player:spawned', () => {
      if (!this.sawSpawn) { this.sawSpawn = true; return; }
      this.perks.reset();
      this.pap.reset();
      this.box.reset(ctx);
      this.clearPrompt(ctx);
    });

    this.registerDebug(ctx);
  }

  /**
   * Perks and Pack-a-Punch take the first, best-spread sites; everything left over is the box's
   * relocation pool. If the solver came up short — a future arena with nowhere legal to stand —
   * we place what we can and SAY SO, loudly, once: a silently missing Pack-a-Punch presents as
   * "the economy is broken" three hours later.
   */
  private assignSites(ctx: GameCtx): void {
    const fixed = this.perks.machines.length + 1;
    if (this.sites.length === 0) {
      console.error(
        '[economy] no legal machine sites — the perks, the box and Pack-a-Punch are all ' +
        'UNREACHABLE. `solveSites` found nothing: check `SITE.minFromSpawn` / `minSeparation` ' +
        'against the arena size in world/arena.ts.',
      );
      return;
    }
    if (this.sites.length < fixed + 2) {
      console.warn(
        `[economy] only ${this.sites.length} machine sites for ${fixed} machines + a box that ` +
        'needs somewhere to move to. Machines will share spots. Widen the SITE lattice.',
      );
    }

    let i = 0;
    for (const m of this.perks.machines) {
      const s = this.sites[i % this.sites.length];
      m.place(s.position, s.yaw);
      i++;
    }
    const papSite = this.sites[i % this.sites.length];
    this.pap.place(papSite.position, papSite.yaw);
    i++;

    // Everything after the fixed machines is a box spot; if there is nothing left, the box gets
    // the whole list and simply relocates among the occupied sites rather than not existing.
    const spare = this.sites.slice(Math.min(i, this.sites.length));
    this.box.setSites(spare.length > 0 ? spare : this.sites);
  }

  // ── frame ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Latch the interact edge exactly once per frame. `fixedUpdate` runs first, so on any normal
   * frame the press is consumed with zero added latency; `update` covers the >120 fps case where
   * a frame runs no fixed step at all and the edge would otherwise be dropped. Identical to the
   * `beginFrame` pattern in `player/controller.ts`, and for the identical reason.
   */
  private beginFrame(ctx: GameCtx): void {
    if (ctx.time.frame === this.inputFrame) return;
    this.inputFrame = ctx.time.frame;
    if (ctx.input.pressed('interact')) {
      this.pendingUse = true;
      this.pendingFrame = ctx.time.frame;
    }
  }

  fixedUpdate(dt: number, ctx: GameCtx): void {
    this.beginFrame(ctx);
    this.box.fixedUpdate(dt, ctx);

    const near = this.pickNearest(ctx);
    if (near !== this.nearest) {
      this.nearest = near;
      // Force a prompt refresh on the next frame rather than waiting out the 10 Hz clock.
      this.promptClock = 999;
    }

    if (!this.pendingUse) return;
    // Cleared whatever happens: the edge belongs to this frame, and if the wall-buy layer is the
    // one standing closer then this press was never ours to hold on to.
    this.pendingUse = false;
    // Being downed or dead is a POLICY question and `spend()` deliberately has no opinion on it
    // (see its contract) — so the answer lives here, where the purchase does.
    if (!near || ctx.player.isDown || !ctx.player.alive) return;
    // A wall-buy can be chalked 1.11 m from a machine on the shipped arena (measured — see
    // `claim.ts`). Nearest wins, machines take ties, and the frame stamp makes one press one
    // purchase even when the two distances disagree by a frame.
    if (!takeInteract(this.pendingFrame, OWNER_MACHINE)) return;
    near.use(ctx);
    this.promptClock = 999;
  }

  /**
   * Nearest machine within its own use radius. Squared distances, no allocation, no sqrt — six
   * machines at 120 Hz is 720 checks a second and it should cost nothing.
   *
   * The vertical window is the same one power-ups use: generous but finite, so you cannot buy
   * Pack-a-Punch through the deck you are standing on.
   */
  private pickNearest(ctx: GameCtx): Machine | null {
    const p = ctx.player.position;
    let best: Machine | null = null;
    let bestD2 = Infinity;
    // A dead or downed player is standing at nothing, and saying so is what stops a machine that
    // cannot be used from out-arguing a wall-buy that can.
    const usable = ctx.player.alive && !ctx.player.isDown;
    if (usable) {
      for (let i = 0; i < this.machines.length; i++) {
        const m = this.machines[i];
        const dy = p.y - m.position.y;
        if (dy < MACHINE.useHeightBelow || dy > MACHINE.useHeightAbove) continue;
        const dx = p.x - m.position.x;
        const dz = p.z - m.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > m.useRadius * m.useRadius) continue;
        if (d2 < bestD2) { bestD2 = d2; best = m; }
      }
    }
    // Published EVERY step, `Infinity` included: a distance that is only refreshed while
    // something is in range keeps winning arbitration after the player has walked away from it.
    publishDistance(OWNER_MACHINE, bestD2);
    return best;
  }

  update(dt: number, ctx: GameCtx): void {
    this.beginFrame(ctx);

    this.perks.update(dt);
    this.pap.update(dt);
    this.box.update(dt, ctx);

    // The prompt string is rebuilt at 10 Hz, not per frame. It carries a live "NEED 340" that has
    // to track your balance, so it cannot be built once — but a template literal every frame is
    // garbage in a per-frame path for a readout nobody can read faster than this anyway.
    this.promptClock += dt;
    if (this.promptClock < 0.1) return;
    this.promptClock = 0;

    // The prompt has to agree with the key: if the wall-buy layer owns this spot it is also the
    // one the press will buy from, so showing a perk line here would offer something F does not
    // buy. `ownsSpot` is the same test `takeInteract` applies, so the two cannot disagree.
    const m = this.nearest && ownsSpot(OWNER_MACHINE) ? this.nearest : null;
    const text = m ? m.promptText(ctx) : null;
    if (text === this.shownPrompt) return;
    // Never emit a null over a prompt we did not put up: wall-buys share this channel, and
    // clearing theirs from here would make their prompt flicker as you walk past a perk machine.
    if (text === null && this.shownPrompt === null) return;
    this.shownPrompt = text;
    ctx.events.emit('ui:prompt', { text });
  }

  private clearPrompt(ctx: GameCtx): void {
    if (this.shownPrompt === null) return;
    this.shownPrompt = null;
    ctx.events.emit('ui:prompt', { text: null });
  }

  // ── teardown / debug ──────────────────────────────────────────────────────────────────────

  dispose(): void {
    this.offSpawn?.();
    this.offSpawn = null;
    this.machines.length = 0;
    // Module state outlives the system — see the matching call in `wallbuys.ts::dispose`.
    resetInteractClaims();
  }

  /**
   * `dispose()` has no ctx (the `System` contract), and every machine needs one to give its ink
   * hull back to the renderer. `main.ts` never tears the world down mid-session today, so this is
   * the explicit hook rather than a leak hidden behind an optional parameter.
   */
  disposeWith(ctx: GameCtx): void {
    this.perks.dispose(ctx);
    this.box.dispose(ctx);
    this.pap.dispose(ctx);
    this.kit.dispose(ctx);
    this.dispose();
  }

  private registerDebug(ctx: GameCtx): void {
    const d = ctx.debug;
    d.watch('perks', () => this.perks.label());
    d.watch('box', () => `${this.box.usesRemaining} left · ${this.box.spins} spins`);
    d.watch('pap', () => (this.pap.upgradeCount > 0 ? `${this.pap.upgradeCount}×` : '—'));
    d.watch('machine', () => this.nearest?.id ?? '—');
    d.watch('sites', () => this.sites.length);
  }
}

/**
 * THE ENTRY POINT. One line in `main.ts`, and `player` is load-bearing exactly the way
 * `createBoons(player)` is: the perk layer needs somewhere to push stat modifiers, and
 * `PlayerService` has no way to write to the stack it documents. `PlayerSystem` satisfies
 * `PerkStatHost` structurally, so handing the player in IS the wiring, and `tsc` checks it. With
 * no host, every perk in the game is silently inert.
 */
export function createEconomyExtras(host: PerkStatHost | null = null): EconomyExtrasSystem {
  return new EconomyExtrasSystem(host);
}

export { MachineKit, PerkBank, PERK_DEFS } from './perks';
export type { PerkDef, PerkStatHost } from './perks';
export { PackAPunch, PAP } from './packapunch';

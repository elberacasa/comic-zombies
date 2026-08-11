/**
 * PERKS — the BOUGHT, KNOWN, BORING half of the upgrade layer (BO2_MECHANICS §3).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WHY FOUR AND NOT SEVEN, and why they are deliberately dull
 *
 *  We already ship 26 boons, drawn three-at-a-time between rounds, and they already occupy the
 *  "permanent upgrade" niche. Bolting BO2's seven perks on top would stand up two parallel
 *  upgrade systems competing for the same design space, and the loser would be the boons — the
 *  signature twist. §3's resolution, followed exactly here:
 *
 *      perks are BOUGHT · KNOWN · RELIABLE      boons are DRAWN · RANDOM · BUILD-DEFINING
 *
 *  So a perk is one number, it is the number you expected, and there are four of them. INK GUT
 *  is the load-bearing one: BO2's whole opening — "how fast can I get Jug" — exists because one
 *  purchase is obviously correct, and that is what gives rounds 1–5 a shape. The other three are
 *  the reload / fire-rate / sprint trio, because those are the three moments the player already
 *  feels: the reload you die during, the DPS wall, and the training loop.
 *
 *  NOTHING HERE HARDCODES A STAT INTO A SYSTEM. Every perk is a `PlayerStats` mutation pushed
 *  onto the SAME modifier stack the boons use (`player/stats.ts`), through the same
 *  `addStatModifier` seam. A perk cannot desync from a boon because there is only one pipeline:
 *  `base → modifiers in insertion order → clamp`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THIS FILE ALSO OWNS THE MACHINE KIT — the procedural cabinet/chest prop, its sign and its
 * glow bar — because all three economy machines are the same object with a different label, and
 * the alternative was three copies of it. `box.ts` and `packapunch.ts` import the kit FROM here;
 * nothing here imports them, so the module graph stays acyclic (box → perks, pap → perks).
 *
 * FRAME COST AT REST: a machine that nobody is standing next to runs zero code. There is no
 * idle animation at all — the glow is a static emissive, not a flicker — which is ART §4.1 taken
 * literally: six props scattered through the arena must not make the print crawl.
 */

import {
  DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3,
  type BufferGeometry, type Object3D,
} from 'three';

import type { GameCtx, PlayerStats } from '@/core/types';
import { PALETTE, READABILITY, SEMANTIC } from '@/art/palette';
import { makeWordTexture, type WordTexture } from '@/art/letters';
import { bevelBox, mergeTransformed } from '@/art/shapes';
import { LAYER, makeInkMaterial, markBloom, setInkEmissive } from '@/render/materials/index';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0. TUNING
//
// These belong in `src/game/tuning.ts` with everything else the human tunes by feel, and they
// are parked here only because that file is another agent's this milestone. Moving them is a
// cut-and-paste and an import; nothing reads a literal.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const MACHINE = {
  /** How close you have to stand. Generous: you are being chased when you buy (§2). */
  useRadius: 2.6,
  /** Vertical tolerance — you cannot buy a perk from the roof deck above it. */
  useHeightBelow: -2.4,
  useHeightAbove: 3.0,
  /** Cabinet footprint, metres. */
  cabinetWidth: 0.98,
  cabinetHeight: 2.02,
  cabinetDepth: 0.66,
  /** Sign cap height on the cabinet face, metres. */
  signHeight: 0.30,
  signY: 1.34,
  /** Chest (the mystery box) footprint. */
  chestWidth: 1.32,
  chestHeight: 0.64,
  chestDepth: 0.88,
  chestSignY: 1.42,
  chestSignHeight: 0.34,
  /** Ink weight. A machine is a PROP and takes the prop cap — enemies own 8px (ART §9). */
  outlinePx: READABILITY.PROP_OUTLINE_MAX_PX,
} as const;

export const PERK = {
  /** Juggernog is ~2.5× effective health, and that ratio is the whole reason it is THE perk. */
  inkGutHealthMult: 2.5,
  inkGutCost: 2500,

  /** Speed Cola is ~2×; 1.9 leaves the active-reload window still worth hitting. */
  quickInkReloadMult: 1.9,
  quickInkCost: 3000,

  /**
   * Double Tap II was 2× fire rate AND double bullets — enormous, and it would trivialise our
   * recoil patterns, which are the learnable skill. 1.5× rpm is a real DPS cliff that still
   * costs you 1.5× the ammo, so the wall-buy route stays part of the plan.
   */
  doubleInkFireRateMult: 1.5,
  doubleInkCost: 2000,

  /**
   * Stamin-Up. `sprintMult` is a BONUS over walk speed (base 1.62), so scaling the whole number
   * would be a 22% sprint buff dressed up as a 22% multiplier. We scale the bonus: 1.62 → 1.756.
   */
  longLegsSprintBonusMult: 1.22,
  longLegsWalkMult: 1.05,
  longLegsCost: 2000,
} as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE MACHINE KIT — one prop builder, three machines
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type MachineShape = 'cabinet' | 'chest';

export interface MachineVisualOptions {
  shape: MachineShape;
  /** What the sign says at rest. */
  label: string;
  bodyColor: number;
  /** The glow bar. GOLD while it is something you can buy — see the note in `build`. */
  glowColor: number;
}

export interface MachineVisual {
  readonly root: Group;
  /** The chest lid, or null on a cabinet. Rotates about its BACK edge to open. */
  readonly lid: Object3D | null;
  /** Repaint the glow bar — GOLD = buyable, perk colour = owned, INK_SOFT = dead. */
  setGlow(hex: number, intensity: number): void;
  /** Swap the sign text. Word textures are globally cached, so this is free after first use. */
  setLabel(w: WordTexture): void;
  dispose(ctx: GameCtx): void;
}

/** Sign style, shared so every machine in the arena is lettered by the same hand. */
export const SIGN_STYLE = {
  fill: 'PAPER', ink: 'INK', paper: 'GOLD',
  fontSize: 92, rotate: -3, jitter: 0.45, outline: 0.085, bang: false,
} as const;

/**
 * Build the word textures a machine will ever show, ONCE, at init. `makeWordTexture` caches
 * internally, but it still resolves a style object and builds a cache key per call — and the
 * box riffles labels eight times a second while it spins. Prebuilt, that path is an array read.
 */
export function machineWord(text: string): WordTexture {
  return makeWordTexture(text, SIGN_STYLE);
}

/**
 * Shared geometry and the factory for a machine prop. One instance for the whole economy layer,
 * built in `init`, disposed with it.
 *
 * DRAW COST, measured by construction: a cabinet is body(1) + sign(1) + glow(1) + one ink hull,
 * = 4 draws; the chest adds a lid and its hull, = 6. Six machines is ~26 draws against BUILD
 * 009's 194 — but they are `frustumCulled` static props scattered across a 140 m arena, so the
 * typical on-screen count is one or two. They are NOT `frustumCulled = false` for exactly that
 * reason (power-ups are, because a power-up you cannot see is a power-up you lose).
 */
export class MachineKit {
  private cabinetGeo: BufferGeometry | null = null;
  private chestBaseGeo: BufferGeometry | null = null;
  private chestLidGeo: BufferGeometry | null = null;
  private glowGeo: BufferGeometry | null = null;
  private signGeo: PlaneGeometry | null = null;
  private root: Group | null = null;

  init(ctx: GameCtx): void {
    const root = new Group();
    root.name = 'economy-machines';
    ctx.scene.add(root);
    this.root = root;

    const M = MACHINE;

    // THE CABINET. A comic vending machine is read from its silhouette, so the shape is three
    // stacked masses with different widths — plinth, body, canopy — rather than one box with
    // detail on it. The canopy overhangs, which is what puts a hard shadow across the sign.
    this.cabinetGeo = mergeTransformed([
      { geo: bevelBox(M.cabinetWidth * 1.12, 0.17, M.cabinetDepth * 1.10, 0.035, 11), at: { y: 0.085 } },
      { geo: bevelBox(M.cabinetWidth, M.cabinetHeight - 0.46, M.cabinetDepth, 0.05, 12), at: { y: 0.17 + (M.cabinetHeight - 0.46) * 0.5 } },
      { geo: bevelBox(M.cabinetWidth * 1.14, 0.21, M.cabinetDepth * 1.18, 0.045, 13), at: { y: M.cabinetHeight - 0.18 } },
      // Two side rails: the vertical lines that stop the body reading as a fridge.
      { geo: bevelBox(0.075, M.cabinetHeight - 0.60, 0.075, 0.02, 14), at: { x: -M.cabinetWidth * 0.47, y: M.cabinetHeight * 0.5 - 0.05, z: M.cabinetDepth * 0.47 } },
      { geo: bevelBox(0.075, M.cabinetHeight - 0.60, 0.075, 0.02, 15), at: { x: M.cabinetWidth * 0.47, y: M.cabinetHeight * 0.5 - 0.05, z: M.cabinetDepth * 0.47 } },
      // The dispense slot, sunk into the lower front.
      { geo: bevelBox(M.cabinetWidth * 0.56, 0.16, 0.10, 0.02, 16), at: { y: 0.52, z: M.cabinetDepth * 0.5 - 0.02 } },
    ]);

    // THE CHEST. Low, wide, lid on top — a treasure box, which is what the mystery box is.
    this.chestBaseGeo = mergeTransformed([
      { geo: bevelBox(M.chestWidth * 1.06, 0.12, M.chestDepth * 1.06, 0.03, 21), at: { y: 0.06 } },
      { geo: bevelBox(M.chestWidth, M.chestHeight, M.chestDepth, 0.055, 22), at: { y: 0.12 + M.chestHeight * 0.5 } },
      { geo: bevelBox(M.chestWidth * 1.02, 0.09, 0.09, 0.02, 23), at: { y: 0.12 + M.chestHeight * 0.62, z: M.chestDepth * 0.5 } },
    ]);
    // The lid's ORIGIN is its back edge, so `rotation.x` alone opens it on a hinge.
    this.chestLidGeo = mergeTransformed([
      { geo: bevelBox(M.chestWidth * 1.04, 0.17, M.chestDepth * 1.02, 0.05, 24), at: { y: 0.085, z: M.chestDepth * 0.5 } },
    ]);

    // The glow bar: a thin emissive strip, the ONLY part of a machine on the bloom layer.
    this.glowGeo = bevelBox(M.cabinetWidth * 0.86, 0.075, 0.06, 0.018, 31);
    this.signGeo = new PlaneGeometry(1, 1);
  }

  /**
   * GOLD IS A CONTRACT (`SEMANTIC.interactable`), not a colour choice: it means "you can use
   * this" and nothing else. `ACID` and `HOT` are RESERVED FOR ENEMIES by ART §9, so a machine
   * may never take them however well they would read — a buyable that flashes as a threat is a
   * readability bug. Owned perks repaint the bar to their own (non-reserved) hue, which is how
   * you can tell across the map whether you already bought it.
   */
  build(ctx: GameCtx, opts: MachineVisualOptions): MachineVisual {
    const M = MACHINE;
    const group = new Group();
    group.name = `machine-${opts.label.toLowerCase().replace(/\s+/g, '-')}`;

    const bodyMat = makeInkMaterial({
      name: 'machine-body',
      color: opts.bodyColor,
      shadowColor: PALETTE.NIGHT_A,
      rimColor: PALETTE.PAPER,
      rimStrength: 0.72,
      bands: 3,
      halftone: 0.42,
      halftoneAngle: 30,
      specular: 0.18,
      flatShading: true,
    });

    const isChest = opts.shape === 'chest';
    const bodyGeo = (isChest ? this.chestBaseGeo : this.cabinetGeo) as BufferGeometry;
    const body = new Mesh(bodyGeo, bodyMat);
    body.name = 'machine-body';
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    let lid: Mesh | null = null;
    if (isChest) {
      lid = new Mesh(this.chestLidGeo as BufferGeometry, bodyMat);
      lid.name = 'machine-lid';
      lid.castShadow = true;
      // Hinge at the back edge: the geometry was authored around it, so this is a bare offset.
      lid.position.set(0, 0.12 + M.chestHeight, -M.chestDepth * 0.5);
      group.add(lid);
    }

    const glowMat = makeInkMaterial({
      name: 'machine-glow',
      color: opts.glowColor,
      shadowColor: opts.glowColor,
      rimColor: PALETTE.PAPER,
      rimStrength: 0.4,
      emissive: opts.glowColor,
      emissiveIntensity: 1.0,
      bands: 2,
      halftone: 0,
      flatShading: true,
      bloom: true,
    });
    const glow = new Mesh(this.glowGeo as BufferGeometry, glowMat);
    glow.name = 'machine-glow';
    markBloom(glow, false);
    if (isChest) glow.position.set(0, 0.12 + M.chestHeight * 0.5, M.chestDepth * 0.5 + 0.02);
    else glow.position.set(0, M.cabinetHeight - 0.36, M.cabinetDepth * 0.5 + 0.02);
    group.add(glow);

    const first = machineWord(opts.label);
    const signMat = new MeshBasicMaterial({
      map: first.texture, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false,
    });
    const sign = new Mesh(this.signGeo as PlaneGeometry, signMat);
    sign.name = 'machine-sign';
    // Lettering carries its own ink; a Sobel pass over it would just draw a box around the word.
    sign.layers.set(LAYER.NO_INK);
    sign.renderOrder = 11;
    const signH = isChest ? M.chestSignHeight : M.signHeight;
    sign.scale.set(signH * first.aspect, signH, 1);
    sign.position.set(0, isChest ? M.chestSignY : M.signY, (isChest ? M.chestDepth : M.cabinetDepth) * 0.5 + 0.035);
    group.add(sign);

    this.root?.add(group);
    // Outline the mass, not the lettering. The lid gets its own hull or it loses its contour the
    // moment it opens past the body silhouette.
    ctx.renderer.addOutline(body, MACHINE.outlinePx);
    if (lid) ctx.renderer.addOutline(lid, MACHINE.outlinePx);

    const visual: MachineVisual = {
      root: group,
      lid,
      setGlow: (hex: number, intensity: number): void => {
        setInkEmissive(glowMat, hex, intensity);
      },
      setLabel: (w: WordTexture): void => {
        if (signMat.map === w.texture) return;
        signMat.map = w.texture;
        signMat.needsUpdate = true;
        sign.scale.set(signH * w.aspect, signH, 1);
      },
      dispose: (c: GameCtx): void => {
        c.renderer.removeOutline(body);
        if (lid) c.renderer.removeOutline(lid);
        bodyMat.dispose();
        glowMat.dispose();
        signMat.dispose();
        group.removeFromParent();
      },
    };
    return visual;
  }

  dispose(ctx: GameCtx): void {
    this.cabinetGeo?.dispose();
    this.chestBaseGeo?.dispose();
    this.chestLidGeo?.dispose();
    this.glowGeo?.dispose();
    this.signGeo?.dispose();
    this.cabinetGeo = null;
    this.chestBaseGeo = null;
    this.chestLidGeo = null;
    this.glowGeo = null;
    this.signGeo = null;
    // Word textures belong to the global `art/letters` cache, which `main.ts` disposes.
    if (this.root) ctx.scene.remove(this.root);
    this.root = null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE FOUR PERKS
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface PerkDef {
  id: string;
  /** What the sign and the prompt say. */
  name: string;
  /** One line, for the toast. */
  blurb: string;
  cost: number;
  /** Machine body hue, and the colour its glow bar turns once you own it. */
  bodyColor: number;
  ownedColor: number;
  /** The stat mutation. Pure — this is the entire perk. */
  modify(stats: PlayerStats): void;
}

/**
 * Ordered by the run they describe: health first, because that is the one the opening of every
 * game is about, then the three quality-of-life numbers.
 */
export const PERK_DEFS: readonly PerkDef[] = [
  {
    id: 'ink_gut',
    name: 'INK GUT',
    blurb: 'YOU SOAK IT UP',
    cost: PERK.inkGutCost,
    bodyColor: PALETTE.RUST,
    ownedColor: PALETTE.RUST,
    modify: (s) => { s.maxHealth *= PERK.inkGutHealthMult; },
  },
  {
    id: 'quick_ink',
    name: 'QUICK INK',
    blurb: 'HANDS LIKE A PRINTER',
    cost: PERK.quickInkCost,
    bodyColor: PALETTE.TEAL,
    ownedColor: PALETTE.ELECTRIC,
    modify: (s) => { s.reloadSpeedMult *= PERK.quickInkReloadMult; },
  },
  {
    id: 'double_ink',
    name: 'DOUBLE INK',
    blurb: 'TWICE THE PAGE RATE',
    cost: PERK.doubleInkCost,
    bodyColor: PALETTE.NIGHT_B,
    ownedColor: PALETTE.GOLD,
    modify: (s) => { s.fireRateMult *= PERK.doubleInkFireRateMult; },
  },
  {
    id: 'long_legs',
    name: 'LONG LEGS',
    blurb: 'THE TRAIN NEVER CATCHES YOU',
    cost: PERK.longLegsCost,
    bodyColor: PALETTE.SLATE,
    ownedColor: PALETTE.BONE,
    modify: (s) => {
      s.sprintMult = 1 + (s.sprintMult - 1) * PERK.longLegsSprintBonusMult;
      s.moveSpeed *= PERK.longLegsWalkMult;
    },
  },
];

/**
 * What the perk layer needs from the player and cannot get from `PlayerService`.
 *
 * `PlayerService` exposes `recomputeStats()` and documents it as "called by BoonService", but it
 * exposes no way to PUT anything into the stack that walks. `PlayerSystem.addStatModifier()` is
 * exactly right and simply is not on the frozen interface — the identical gap `boons/service.ts`
 * documents at length. The fix is the same one, and deliberately NOT a structural probe: a named
 * interface, satisfied by passing the player in at construction, so `tsc` checks the call site
 * and a rename breaks the build instead of silently making every perk inert.
 */
export interface PerkStatHost {
  addStatModifier(fn: (stats: PlayerStats) => void, label?: string, order?: number): () => void;
  recomputeStats(): void;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE MACHINE
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * One perk, one physical cabinet. §3: "perk machines should be physical objects in the arena you
 * walk to, not a menu — the walk is the cost, and it puts you somewhere on the map at a specific
 * time." So this owns a position and a prompt, and it never opens any UI.
 */
export class PerkMachine {
  readonly id: string;
  readonly position = new Vector3();
  readonly useRadius = MACHINE.useRadius;

  private visual: MachineVisual | null = null;
  private statOff: (() => void) | null = null;
  private _owned = false;
  /** Purchase flash, seconds remaining. Presentation only. */
  private flash = 0;

  constructor(readonly def: PerkDef, private readonly host: PerkStatHost | null) {
    this.id = `perk:${def.id}`;
  }

  get owned(): boolean { return this._owned; }

  build(ctx: GameCtx, kit: MachineKit): void {
    this.visual = kit.build(ctx, {
      shape: 'cabinet',
      label: this.def.name,
      bodyColor: this.def.bodyColor,
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

  /**
   * Per-frame while in range. Allocation-free and side-effect-free — `canAfford` is a pure
   * query, which is the whole reason it exists separately from `spend`.
   */
  promptText(ctx: GameCtx): string | null {
    if (this._owned) return `${this.def.name} — OWNED`;
    const cost = this.def.cost;
    if (ctx.player.canAfford(cost)) return `PRESS F — ${this.def.name} [${cost}]`;
    return `${this.def.name} [${cost}] · NEED ${cost - ctx.player.points}`;
  }

  /** The interact edge. Owns its own `spend()`; a refusal has already fired `player:denied`. */
  use(ctx: GameCtx): void {
    if (this._owned) return;
    if (!ctx.player.spend(this.def.cost, `perk:${this.def.id}`)) return;
    this.grant(ctx);
  }

  /**
   * Apply the perk. Split out from `use` so a power-up or a debug handle can grant one without
   * charging for it, and so the purchase path is only ever "spend, then this".
   */
  grant(ctx: GameCtx): void {
    if (this._owned) return;
    this._owned = true;

    const host = this.host;
    if (host) {
      const before = ctx.player.stats.maxHealth;
      // order 0: the same slot boons take, so a perk and a boon compose in the order the player
      // acquired them — which is a real build decision (`player/stats.ts`). Ink Pact's "you have
      // 1 HP" runs at order 100 and still gets the last word over INK GUT, which is correct.
      this.statOff = host.addStatModifier(this.def.modify, this.def.id, 0);
      // A bigger bar that is not fuller is not a power spike. BO2's Jug tops you up on purchase
      // and that instant is most of why it feels like the run just changed; heal exactly the
      // headroom we just created, so the other three perks pay nothing.
      const gained = ctx.player.stats.maxHealth - before;
      if (gained > 0) ctx.player.heal(gained);
    }

    this.visual?.setGlow(this.def.ownedColor, 1.25);
    this.visual?.setLabel(machineWord(this.def.name));
    this.flash = 0.5;

    ctx.hud.toast(`${this.def.name} · ${this.def.blurb}`);
    ctx.events.emit('fx:sound', { id: 'upgrade_chime', volume: 1 });
    ctx.events.emit('fx:flash', { intensity: 0.22, color: this.def.ownedColor });
    ctx.events.emit('fx:word', {
      text: this.def.name, position: this.position, color: this.def.ownedColor, scale: 1.15,
    });
  }

  /** Presentation only. Runs on real frame time so the stamp lands through hitstop. */
  update(dt: number): void {
    if (this.flash <= 0) return;
    this.flash -= dt;
    const v = this.visual;
    if (!v) return;
    if (this.flash <= 0) {
      this.flash = 0;
      v.setGlow(this.def.ownedColor, 1.25);
      return;
    }
    // Two-frame strobe, not a fade — a comic flashes, it does not dissolve (ART §8).
    const on = Math.floor(this.flash * 12) % 2 === 0;
    v.setGlow(on ? PALETTE.PAPER : this.def.ownedColor, on ? 2.4 : 1.25);
  }

  /** New run: the player's modifier stack was already wiped, so drop ours and forget it. */
  reset(): void {
    this.statOff?.();
    this.statOff = null;
    this._owned = false;
    this.flash = 0;
    this.visual?.setGlow(SEMANTIC.interactable, 1.0);
  }

  dispose(ctx: GameCtx): void {
    this.statOff?.();
    this.statOff = null;
    this.visual?.dispose(ctx);
    this.visual = null;
  }
}

/** The four machines as one object, so the composite has one thing to own. */
export class PerkBank {
  readonly machines: PerkMachine[] = [];

  constructor(host: PerkStatHost | null) {
    for (const def of PERK_DEFS) this.machines.push(new PerkMachine(def, host));
  }

  build(ctx: GameCtx, kit: MachineKit): void {
    for (let i = 0; i < this.machines.length; i++) this.machines[i].build(ctx, kit);
  }

  update(dt: number): void {
    for (let i = 0; i < this.machines.length; i++) this.machines[i].update(dt);
  }

  reset(): void {
    for (let i = 0; i < this.machines.length; i++) this.machines[i].reset();
  }

  dispose(ctx: GameCtx): void {
    for (let i = 0; i < this.machines.length; i++) this.machines[i].dispose(ctx);
  }

  /** For the debug panel. */
  label(): string {
    let s = '';
    for (let i = 0; i < this.machines.length; i++) {
      if (!this.machines[i].owned) continue;
      s += (s ? ' ' : '') + this.machines[i].def.id;
    }
    return s || 'none';
  }

  find(id: string): PerkMachine | null {
    for (let i = 0; i < this.machines.length; i++) {
      if (this.machines[i].def.id === id) return this.machines[i];
    }
    return null;
  }
}

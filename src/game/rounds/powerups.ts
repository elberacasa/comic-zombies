/**
 * POWER-UP DROPS — GAME_BIBLE §5.
 *
 * MAX AMMO · DOUBLE POINTS · INSTA-KILL · NUKE · CARNAGE. This file owns the OBJECT: the pooled
 * floating pickup, its look, its lifetime and the pickup test. The *effects* live in the
 * director, because they touch weapons, enemies and the economy and a drop should not know
 * about any of them.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE LOOK (ART §6, §7, §9)
 *
 *  A pickup is drawn the way a comic draws "grab this": a hard GOLD star burst with an ink
 *  contour, and a lettered card standing in front of it saying what it is. Two meshes, both
 *  pooled, both hidden when the pool slot is free.
 *
 *  GOLD IS A CONTRACT, NOT A COLOUR CHOICE. `SEMANTIC.interactable` is GOLD and GOLD *only*
 *  means "you can use this" — that is why the arena's generic street lighting moved to SODIUM.
 *  The two brightest, most saturated channels in the game (`ACID`, `HOT`) are RESERVED FOR
 *  ENEMIES by ART §9, so a reward may never borrow them: a pickup that reads as a threat for
 *  even a tenth of a second is a readability bug, not a style. Reward = GOLD, always.
 *
 *  THE STILLNESS TEST (ART §4.1). The star spins and the card bobs — and both are QUANTISED to
 *  `ROUND.powerupAnimFps` (12) and `ROUND.powerupSpinSteps` (24 discrete positions), so between
 *  ticks the object is bit-identical and the print does not crawl. That is also just how a
 *  comic animates: hold frames, never interpolation (ART §8). The idle-frame regression test is
 *  run with nothing on the ground, and a pickup only exists when something IS happening — but
 *  it is quantised anyway, because "the rule only applies when the tester is looking" is how
 *  4.1 got violated the first time.
 *
 *  The card BILLBOARDS to the camera. That is not idle animation: it changes only when the
 *  camera moves, exactly like every other surface in the frame.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3,
  type BufferGeometry, type Object3D, type Texture,
} from 'three';

import { Pool } from '@/core/pool';
import type { GameCtx, RNG } from '@/core/types';
import { PALETTE, SEMANTIC, READABILITY } from '@/art/palette';
import { makeWordTexture } from '@/art/letters';
import { starPolygon } from '@/art/shapes';
import { LAYER, makeInkMaterial, markBloom, type InkMaterial } from '@/render/materials/index';
import { ROUND } from '@/game/tuning';

// ─────────────────────────────────────────────────────────────────────────────
// Content
// ─────────────────────────────────────────────────────────────────────────────

export type PowerupId = 'max_ammo' | 'double_points' | 'insta_kill' | 'nuke' | 'carnage';

export interface PowerupDef {
  id: PowerupId;
  /** What the card says. Also what the HUD toasts. */
  label: string;
  /**
   * Relative drop weight. NUKE and CARNAGE are the two that change a whole round, so they are
   * the rare ones; MAX AMMO is the bread-and-butter save.
   */
  weight: number;
}

export const POWERUP_DEFS: readonly PowerupDef[] = [
  { id: 'max_ammo', label: 'MAX AMMO', weight: 30 },
  { id: 'double_points', label: 'DOUBLE POINTS', weight: 24 },
  { id: 'insta_kill', label: 'INSTA-KILL', weight: 20 },
  { id: 'carnage', label: 'CARNAGE', weight: 14 },
  { id: 'nuke', label: 'NUKE', weight: 12 },
];

const TOTAL_WEIGHT = POWERUP_DEFS.reduce((a, d) => a + d.weight, 0);

/** Weighted pick from a [0,1) roll. */
export function rollPowerup(r: number): PowerupDef {
  let t = r * TOTAL_WEIGHT;
  for (const d of POWERUP_DEFS) {
    t -= d.weight;
    if (t <= 0) return d;
  }
  return POWERUP_DEFS[POWERUP_DEFS.length - 1] as PowerupDef;
}

// ─────────────────────────────────────────────────────────────────────────────

interface Pickup {
  root: Group;
  star: Mesh;
  card: Mesh;
  cardMaterial: MeshBasicMaterial;
  def: PowerupDef;
  /** Ground position; the root hovers `ROUND.powerupHoverHeight` above it. */
  x: number; y: number; z: number;
  age: number;
  /** Phase offset so two drops never bob in lockstep. */
  phase: number;
  live: boolean;
}

const _toCam = new Vector3();
const _pos = new Vector3();

export class PowerupField {
  private ctx: GameCtx | null = null;
  private rng: RNG | null = null;
  private root: Group | null = null;

  private pool: Pool<Pickup> | null = null;
  private readonly liveList: Pickup[] = [];

  /** Shared geometry — one star, one card, for every pickup ever. */
  private starGeo: BufferGeometry | null = null;
  private cardGeo: PlaneGeometry | null = null;
  private starMat: InkMaterial | null = null;
  /** Word texture and aspect per power-up, built once during `init`. */
  private readonly cardTex = new Map<PowerupId, Texture>();
  private readonly cardAspect = new Map<PowerupId, number>();

  /** Quantised animation clock — advances in whole `1 / powerupAnimFps` steps. */
  private animTick = 0;

  constructor(private readonly onCollected: (def: PowerupDef, at: Vector3) => void) {}

  get live(): number { return this.liveList.length; }

  // ── build ─────────────────────────────────────────────────────────────────

  init(ctx: GameCtx): void {
    this.ctx = ctx;
    this.rng = ctx.rng.fork(0x900d1e);

    const root = new Group();
    root.name = 'powerups';
    ctx.scene.add(root);
    this.root = root;

    this.starGeo = starPolygon(9, ROUND.powerupStarRadius * 0.42, ROUND.powerupStarRadius, 0x1d);
    this.cardGeo = new PlaneGeometry(1, 1);

    // ONE material for every star. GOLD, emissive, on the bloom layer — the reward channel.
    this.starMat = makeInkMaterial({
      name: 'powerup-star',
      color: SEMANTIC.interactable,
      shadowColor: PALETTE.RUST,
      rimColor: PALETTE.PAPER,
      rimStrength: 0.8,
      emissive: SEMANTIC.interactable,
      emissiveIntensity: 0.95,
      bands: 3,
      halftone: 0.35,
      side: 'double',
      flatShading: true,
      bloom: true,
    });

    for (const d of POWERUP_DEFS) {
      const w = makeWordTexture(d.label, {
        fill: 'GOLD', ink: 'INK', paper: 'PAPER',
        fontSize: 96, rotate: -4, jitter: 0.5, outline: 0.09, bang: false,
      });
      this.cardTex.set(d.id, w.texture);
      this.cardAspect.set(d.id, w.aspect);
    }

    this.pool = new Pool<Pickup>({
      label: 'rounds:powerups',
      max: Math.max(1, ROUND.powerupPoolSize),
      initial: Math.max(1, ROUND.powerupPoolSize),
      create: () => this.build(),
      reset: (p) => { p.root.visible = false; p.live = false; p.age = 0; },
    });
  }

  private build(): Pickup {
    const ctx = this.ctx;
    const group = new Group();
    group.name = 'powerup';
    group.visible = false;

    const star = new Mesh(this.starGeo as BufferGeometry, this.starMat as InkMaterial);
    star.name = 'powerup-star';
    star.frustumCulled = false;
    markBloom(star, false);
    group.add(star);

    const first = POWERUP_DEFS[0] as PowerupDef;
    const cardMaterial = new MeshBasicMaterial({
      map: this.cardTex.get(first.id) ?? null,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    const card = new Mesh(this.cardGeo as PlaneGeometry, cardMaterial);
    card.name = 'powerup-card';
    card.frustumCulled = false;
    // A lettered card carries its own ink; a Sobel filter would just draw a box around it.
    card.layers.set(LAYER.NO_INK);
    card.renderOrder = 11;
    group.add(card);

    this.root?.add(group);
    // The heaviest ink in the game belongs to enemies (ART §9). A pickup is a prop and takes
    // the prop cap — visible, bold, and provably never competing with a silhouette.
    ctx?.renderer.addOutline(star, READABILITY.PROP_OUTLINE_MAX_PX);

    return {
      root: group, star, card, cardMaterial,
      def: first, x: 0, y: 0, z: 0, age: 0, phase: 0, live: false,
    };
  }

  // ── spawning ──────────────────────────────────────────────────────────────

  /**
   * Drop a pickup at `at` (a corpse position). Returns the def that landed, or null if the
   * live cap is full or there is no ground under the body.
   */
  drop(at: Vector3, forced?: PowerupId): PowerupDef | null {
    const ctx = this.ctx;
    const pool = this.pool;
    const rng = this.rng;
    if (!ctx || !pool || !rng) return null;
    if (this.liveList.length >= ROUND.powerupMaxLive) return null;

    _pos.set(at.x, at.y + 1.2, at.z);
    const g = ctx.world.groundAt(_pos);
    const groundY = g !== null ? g : at.y;

    const def = forced
      ? (POWERUP_DEFS.find((d) => d.id === forced) ?? rollPowerup(rng.next()))
      : rollPowerup(rng.next());

    const p = pool.acquire();
    if (!p) return null;

    p.def = def;
    p.x = at.x;
    p.y = groundY;
    p.z = at.z;
    p.age = 0;
    p.phase = rng.next();
    p.live = true;

    const tex = this.cardTex.get(def.id) ?? null;
    const hadMap = p.cardMaterial.map !== null;
    p.cardMaterial.map = tex;
    if (!hadMap) p.cardMaterial.needsUpdate = true;
    p.cardMaterial.opacity = 1;

    const aspect = this.cardAspect.get(def.id) ?? 3;
    p.card.scale.set(ROUND.powerupCardHeight * aspect, ROUND.powerupCardHeight, 1);
    p.card.position.set(0, -ROUND.powerupStarRadius * 0.06, 0.09);

    p.root.position.set(p.x, p.y + ROUND.powerupHoverHeight, p.z);
    p.root.visible = true;
    this.liveList.push(p);

    _pos.set(p.x, p.y + ROUND.powerupHoverHeight, p.z);
    ctx.events.emit('powerup:dropped', { id: def.id, position: _pos });
    return def;
  }

  // ── simulation ────────────────────────────────────────────────────────────

  /** Fixed step: lifetime and the pickup test. Gameplay, so it freezes with hitstop. */
  fixedUpdate(dt: number, ctx: GameCtx): void {
    if (this.liveList.length === 0) return;
    const r2 = ROUND.powerupPickupRadius * ROUND.powerupPickupRadius;
    const player = ctx.player;

    for (let i = this.liveList.length - 1; i >= 0; i--) {
      const p = this.liveList[i];
      p.age += dt;

      const dx = player.position.x - p.x;
      const dz = player.position.z - p.z;
      const dy = player.position.y - p.y;
      // Vertical tolerance is generous but finite — you cannot grab a pickup from a roof deck.
      if (dx * dx + dz * dz <= r2 && dy > -2.5 && dy < 3.2 && !player.isDown) {
        _pos.set(p.x, p.y + ROUND.powerupHoverHeight, p.z);
        const def = p.def;
        this.retire(i);
        ctx.events.emit('powerup:collected', { id: def.id });
        this.onCollected(def, _pos);
        continue;
      }

      if (p.age >= ROUND.powerupLifetime) this.retire(i);
    }
  }

  /**
   * Presentation. Runs on UNSCALED frame time so a pickup keeps turning through hitstop, and
   * quantised to `ROUND.powerupAnimFps` so the print is frozen between ticks (ART §4.1).
   */
  update(_dt: number, ctx: GameCtx): void {
    if (this.liveList.length === 0) return;

    const step = 1 / Math.max(1, ROUND.powerupAnimFps);
    this.animTick = Math.floor(ctx.time.unscaledElapsed / step);
    const t = this.animTick * step;

    const cam = ctx.camera;
    const spinSteps = Math.max(2, Math.floor(ROUND.powerupSpinSteps));
    const spinPeriod = Math.max(0.05, ROUND.powerupSpinPeriod);
    const bobPeriod = Math.max(0.05, ROUND.powerupBobPeriod);

    for (let i = 0; i < this.liveList.length; i++) {
      const p = this.liveList[i];

      // Billboard about Y only: the card always faces the reader, and never tips off the
      // horizon the way a full look-at does when the player is on a roof. Camera-driven, so a
      // parked camera leaves it perfectly still.
      _toCam.copy(cam.position).sub(p.root.position);
      _toCam.y = 0;
      if (_toCam.lengthSq() > 1e-6) p.root.rotation.set(0, Math.atan2(_toCam.x, _toCam.z), 0);

      // Quantised spin, in `spinSteps` discrete positions — a hand-animated turn, not a lerp.
      const spinPhase = (t / spinPeriod + p.phase) % 1;
      const stepIndex = Math.floor(spinPhase * spinSteps);
      p.star.rotation.z = (stepIndex / spinSteps) * Math.PI * 2;

      // Quantised bob, on the same clock.
      const bob = Math.sin(((t / bobPeriod + p.phase) % 1) * Math.PI * 2) * ROUND.powerupBobAmp;
      p.root.position.set(p.x, p.y + ROUND.powerupHoverHeight + bob, p.z);

      // The last seconds blink — on the same 12 fps clock, so it strobes like a printed
      // animation cel rather than fading like a dissolve.
      const left = ROUND.powerupLifetime - p.age;
      if (left <= ROUND.powerupBlinkTime) {
        const on = this.animTick % 2 === 0 || left > ROUND.powerupBlinkTime * 0.45;
        if (p.root.visible !== on) p.root.visible = on;
      }
    }
  }

  // ── teardown ──────────────────────────────────────────────────────────────

  /** Round reset / game over. Silent — no `powerup:collected`. */
  clear(): void {
    for (let i = this.liveList.length - 1; i >= 0; i--) this.retire(i);
  }

  private retire(index: number): void {
    const p = this.liveList[index];
    this.liveList.splice(index, 1);
    this.pool?.release(p);
  }

  dispose(): void {
    const ctx = this.ctx;
    this.liveList.length = 0;
    this.pool?.forEachCreated((p) => {
      ctx?.renderer.removeOutline(p.star);
      p.cardMaterial.dispose();
      (p.root.parent as Object3D | null)?.remove(p.root);
    });
    this.pool = null;
    this.starGeo?.dispose();
    this.cardGeo?.dispose();
    this.starMat?.dispose();
    // The word textures are owned by the global `art/letters` cache, which `main.ts` disposes.
    this.cardTex.clear();
    this.cardAspect.clear();
    if (this.root) ctx?.scene.remove(this.root);
    this.root = null;
    this.ctx = null;
  }
}

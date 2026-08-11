/**
 * CORE CONTRACTS — the integration seam of the whole game.
 *
 * Every subsystem talks to every other subsystem through the interfaces in this file and the
 * typed event bus in `./events.ts`. Nothing else. If you need a new cross-module dependency,
 * add it here (or add an event) rather than importing one game module from another.
 *
 * Parallel agents own disjoint implementation files but SHARE this file — treat it as frozen
 * unless the change is coordinated. See docs/ARCHITECTURE.md for ownership.
 */

import type * as THREE from 'three';
import type { GameEventMap } from './events';

// ─────────────────────────────────────────────────────────────────────────────
// Time & systems
// ─────────────────────────────────────────────────────────────────────────────

/** Simulation runs at a fixed step; rendering interpolates. Never tie gameplay to frame rate. */
export const FIXED_DT = 1 / 120;
export const MAX_FRAME_DT = 0.25;

export interface Time {
  /** Seconds since boot, affected by timeScale (use for gameplay). */
  readonly elapsed: number;
  /** Seconds since boot, unaffected by timeScale (use for UI/VFX that must never freeze). */
  readonly unscaledElapsed: number;
  /** Current simulation delta (equals FIXED_DT inside fixedUpdate). */
  readonly dt: number;
  /** Real frame delta, clamped. */
  readonly frameDt: number;
  readonly frame: number;
  /** Global time multiplier. Hitstop and slow-mo write here. */
  timeScale: number;
  /** Freeze gameplay time for `seconds` (real time). Used for impact hitstop. Stacks by max. */
  hitstop(seconds: number): void;
}

/**
 * A game system. Registered in `src/main.ts`, updated in registration order.
 * Implement only the hooks you need.
 */
export interface System {
  readonly name: string;
  /** Async setup. Runs once, before the first update, in registration order. */
  init?(ctx: GameCtx): void | Promise<void>;
  /** Deterministic simulation step. Called 0..N times per frame with dt === FIXED_DT. */
  fixedUpdate?(dt: number, ctx: GameCtx): void;
  /** Per-frame, variable dt. Presentation, interpolation, input sampling, VFX. */
  update?(dt: number, ctx: GameCtx): void;
  /** Called after all updates, before the render pass. `alpha` is the fixed-step interpolant. */
  lateUpdate?(alpha: number, ctx: GameCtx): void;
  dispose?(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// The service locator passed to every system
// ─────────────────────────────────────────────────────────────────────────────

export interface GameCtx {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: RenderService;
  readonly input: InputService;
  readonly events: EventBus;
  readonly time: Time;
  readonly rng: RNG;
  readonly world: WorldService;
  readonly player: PlayerService;
  readonly weapons: WeaponService;
  readonly enemies: EnemyService;
  readonly rounds: RoundService;
  readonly boons: BoonService;
  readonly vfx: VfxService;
  readonly hud: HudService;
  readonly audio: AudioService;
  readonly debug: DebugService;
}

/** Typed event bus. The full event map lives in `./events.ts`. */
export interface EventBus {
  on<K extends keyof GameEventMap>(k: K, fn: (p: GameEventMap[K]) => void): () => void;
  once<K extends keyof GameEventMap>(k: K, fn: (p: GameEventMap[K]) => void): () => void;
  off<K extends keyof GameEventMap>(k: K, fn: (p: GameEventMap[K]) => void): void;
  emit<K extends keyof GameEventMap>(k: K, p: GameEventMap[K]): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

export type ActionName =
  | 'forward' | 'back' | 'left' | 'right'
  | 'jump' | 'crouch' | 'sprint'
  | 'fire' | 'aim' | 'reload' | 'interact'
  | 'swap' | 'melee' | 'grenade'
  | 'pause' | 'scoreboard';

export interface InputService {
  /** Held this frame. */
  down(a: ActionName): boolean;
  /** Went down this frame (edge). */
  pressed(a: ActionName): boolean;
  /** Went up this frame (edge). */
  released(a: ActionName): boolean;
  /** Mouse delta in radians for this frame, sensitivity-applied. */
  readonly lookDelta: { x: number; y: number };
  /** Normalized move vector in local space, length ≤ 1. */
  readonly moveAxis: { x: number; y: number };
  readonly pointerLocked: boolean;
  requestPointerLock(): void;
  sensitivity: number;
  /**
   * Look-sensitivity multiplier applied while aiming down sights. The weapon owns the value
   * (it is a per-weapon feel constant); input owns applying it, so zoom sensitivity is corrected
   * before any smoothing rather than after.
   */
  adsSensitivityMult: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic RNG (seeded — recoil patterns and runs must be reproducible)
// ─────────────────────────────────────────────────────────────────────────────

export interface RNG {
  /** [0,1) */
  next(): number;
  range(min: number, max: number): number;
  int(minInclusive: number, maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  /** Random unit vector written into `out`. */
  unitSphere(out: THREE.Vector3): THREE.Vector3;
  fork(seed?: number): RNG;
  seed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────

export type QualityTier = 'low' | 'med' | 'high' | 'ultra';

export interface RenderService {
  readonly three: THREE.WebGLRenderer;
  quality: QualityTier;
  /** Screen-space ink line width multiplier (art-direction knob). */
  inkStrength: number;
  /** Halftone dot scale multiplier. */
  halftoneScale: number;
  resize(width: number, height: number): void;
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void;
  /** Register a mesh for the inverted-hull silhouette pass. */
  addOutline(target: THREE.Mesh | THREE.Group, thickness?: number): void;
  removeOutline(target: THREE.Mesh | THREE.Group): void;
  /** Full-screen impact flash (comic white frame). 0..1 */
  flash(intensity: number, color?: number): void;
  /** Screen-space radial speed lines. 0..1, decays on its own. */
  speedLines(intensity: number): void;
  /** Tint the speed lines — INK while sprinting, HOT on a big hit. */
  setSpeedLineColor(colorHex: number): void;
  /**
   * Lens ink splats — the damage indicator. `dirX/dirY` is the screen-space direction the
   * damage came from (+x right, +y up); the splats bias toward it. Decays on its own.
   */
  inkSplat(intensity: number, dirX?: number, dirY?: number): void;
  /**
   * The PANEL FRAME (ART_DIRECTION §4.8). Drive to 1 for a big beat — round start, boon draw,
   * the last kill of a round — and back to 0 when it is over. Snaps in, eases out.
   */
  panelFrame(amount: number): void;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// World / collision
// ─────────────────────────────────────────────────────────────────────────────

export interface RaycastHit {
  hit: boolean;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  /** Surface material family, drives impact VFX + sound. */
  surface: SurfaceKind;
}

export type SurfaceKind = 'concrete' | 'metal' | 'wood' | 'glass' | 'flesh' | 'dirt';

export interface CapsuleCollision {
  /** Position correction to apply, zero-length if free. */
  correction: THREE.Vector3;
  normal: THREE.Vector3;
  grounded: boolean;
  depth: number;
}

export interface WorldService {
  readonly root: THREE.Group;
  readonly playerSpawn: { position: THREE.Vector3; yaw: number };
  /** Points the director may spawn enemies at. */
  readonly enemySpawns: readonly THREE.Vector3[];
  /** Arena bounds for clamping and AI. */
  readonly bounds: THREE.Box3;
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number): RaycastHit;
  /** Resolve a capsule (from `bottom` to `top`, radius `r`) against static geometry. */
  collideCapsule(bottom: THREE.Vector3, top: THREE.Vector3, radius: number): CapsuleCollision;
  /** Steering hint for AI: a desired direction from `from` toward `to` that avoids walls. */
  steer(from: THREE.Vector3, to: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** Nearest point on navigable ground below `p`, or null. */
  groundAt(p: THREE.Vector3): number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Damage
// ─────────────────────────────────────────────────────────────────────────────

export type BodyPart = 'head' | 'torso' | 'limb';

export interface DamageInfo {
  amount: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Direction of travel of whatever caused this. */
  direction: THREE.Vector3;
  part: BodyPart;
  isCrit: boolean;
  knockback: number;
  weaponId?: string;
  affix?: WeaponAffix;
}

export interface Damageable {
  readonly id: number;
  readonly alive: boolean;
  readonly position: THREE.Vector3;
  takeDamage(info: DamageInfo): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Player
// ─────────────────────────────────────────────────────────────────────────────

export type MoveState = 'idle' | 'walk' | 'sprint' | 'air' | 'slide' | 'dive' | 'mantle' | 'down';

/**
 * All player-facing numbers boons are allowed to modify.
 * Systems must READ these every frame — never cache a stat value.
 */
export interface PlayerStats {
  maxHealth: number;
  moveSpeed: number;
  sprintMult: number;
  jumpImpulse: number;
  slideImpulse: number;
  airControl: number;
  damageMult: number;
  critMult: number;
  fireRateMult: number;
  reloadSpeedMult: number;
  magSizeMult: number;
  reserveAmmoMult: number;
  adsSpeedMult: number;
  spreadMult: number;
  recoilMult: number;
  pointsMult: number;
  lifestealPerKill: number;
  healthRegenPerSec: number;
  regenDelay: number;
  /** Extra projectiles fired per shot (ghost bullets). */
  extraShots: number;
  extraShotDamageMult: number;
  /** 0..1 chance a shot is explosive. */
  explosiveChance: number;
  explosiveRadius: number;
  /** 0..1 chance a crit chains lightning. */
  chainChance: number;
  chainTargets: number;
  /** Contact damage dealt while sliding. */
  slideDamage: number;
  /** Bullets refunded to the mag on a headshot. */
  headshotRefund: number;
  extraJumps: number;
  reviveCharges: number;
}

export interface PlayerService extends Damageable {
  readonly stats: Readonly<PlayerStats>;
  /** Base stats before boon modifiers — boons must not mutate this. */
  readonly baseStats: Readonly<PlayerStats>;
  readonly health: number;
  readonly moveState: MoveState;
  readonly velocity: THREE.Vector3;
  /** Horizontal speed, m/s. Drives speed lines / FOV. */
  readonly speed: number;
  readonly isAiming: boolean;
  readonly isDown: boolean;
  /** Eye position — the authoritative source for shooting rays and audio listener. */
  readonly eye: THREE.Vector3;
  /** Normalized forward direction of the camera. */
  readonly lookDir: THREE.Vector3;

  // ── presentation state the viewmodel / weapon layer needs ──────────────────
  //
  // These exist because a weapon has to move WITH the body, not merely near it. They were
  // originally read via untyped structural probes (`ctx.player as unknown as {...}`), which
  // compiled fine and would have silently degraded — a rename costing a 22° FOV flick with no
  // error. Anything a second system genuinely needs belongs in the contract, where `tsc`
  // defends it.

  /**
   * Distance-based stride phase, in metres travelled. The viewmodel bob reads this so it stays
   * locked to the camera bob and can be driven in ANTI-PHASE — two motion cues in phase compound
   * into nausea (ART §10).
   */
  readonly bobDistance: number;
  /** 0..1 sprint blend, not a boolean — the weapon lowers progressively. */
  readonly sprintAmount: number;
  readonly grounded: boolean;
  readonly crouching: boolean;
  /** True when the last landing came out of a dive: a heavier viewmodel land. */
  readonly lastLandWasDive: boolean;

  /**
   * Extra FOV degrees requested by another system (ADS zoom). The camera SUMS this with its own
   * punch and applies the ART §10 clamp afterwards, so writing here can never breach the comfort
   * budget no matter what a weapon def asks for.
   */
  fovBias: number;

  /**
   * Apply a recoil impulse in radians; positive pitch = muzzle climbs. Routed through the
   * camera's own spring channel, so recoil composes with (and is clamped alongside) every other
   * camera layer instead of fighting them.
   */
  addRecoil(pitchRad: number, yawRad: number): void;
  heal(amount: number): void;
  addPoints(amount: number, reason?: string): void;
  readonly points: number;

  /**
   * ATOMIC SPEND — the foundation the whole economy stands on (BO2_MECHANICS §1.1). Wall-buys,
   * the mystery box, perks and Pack-a-Punch are all one call to this.
   *
   * Deducts `amount` and returns `true` ONLY if it was affordable; deducts NOTHING and returns
   * `false` otherwise. There is no partial spend and no path to negative points. `amount` is the
   * literal price — unlike `addPoints`, it is NOT scaled by `stats.pointsMult`, because a boon
   * that pays you more must not also make everything cost more.
   *
   * Emits `player:spent` on success (with `player:points` carrying a negative delta so the HUD
   * counter stays honest) and `player:denied` on refusal, so the UI has a beat for both. Costs
   * that are negative, NaN or infinite are a caller bug: they return `false` and emit nothing at
   * all, because a "can't afford" beat for a malformed price would be a lie.
   *
   * Applies NO policy of its own — it does not care whether you are downed, dead or mid-reload.
   * The system that owns the purchase decides who may buy; this only moves the number.
   */
  spend(amount: number, reason?: string): boolean;

  /**
   * Non-mutating affordability test. This is the one to call every frame while deciding whether
   * to show a buy prompt — it allocates nothing, emits nothing and touches no state. Use it for
   * the prompt, then call `spend()` once on the actual press.
   */
  canAfford(amount: number): boolean;
  /** Recompute stats from baseStats + boon modifier stack. Called by BoonService. */
  recomputeStats(): void;
  teleport(position: THREE.Vector3, yaw?: number): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weapons
// ─────────────────────────────────────────────────────────────────────────────

export type WeaponAffix = 'none' | 'shock' | 'flame' | 'ink';

export interface WeaponDef {
  id: string;
  name: string;
  archetype: 'pistol' | 'smg' | 'shotgun' | 'marksman' | 'launcher';
  damage: number;
  headshotMult: number;
  /** Rounds per minute. */
  rpm: number;
  auto: boolean;
  magSize: number;
  reserveAmmo: number;
  /** Infinite reserve (starter pistol). */
  infiniteReserve?: boolean;
  reloadTime: number;
  /** Seconds into the reload where the active-reload window opens, and its width. */
  activeReloadWindow: [start: number, width: number];
  pellets: number;
  /** Radians of cone at hip / ads. */
  spreadHip: number;
  spreadAds: number;
  /** Deterministic recoil pattern, in radians, indexed by shot number (wraps). */
  recoilPattern: readonly [pitch: number, yaw: number][];
  recoilRecovery: number;
  /** Camera kick and weapon-model kick are separate layers. */
  cameraKick: number;
  weaponKick: number;
  range: number;
  /** Damage multiplier at max range. */
  falloff: number;
  /** How many enemies a shot penetrates. */
  penetration: number;
  adsTime: number;
  adsFov: number;
  moveSpeedMult: number;
  affix: WeaponAffix;
  /** Points cost at a wall-buy, and ammo refill cost. */
  buyCost: number;
  ammoCost: number;
}

export interface WeaponInstance {
  readonly def: WeaponDef;
  ammo: number;
  reserve: number;
  readonly isReloading: boolean;
  /** True while the active-reload window is open. */
  readonly activeReloadOpen: boolean;
  readonly upgraded: boolean;
}

export interface WeaponService {
  readonly current: WeaponInstance | null;
  readonly slots: readonly (WeaponInstance | null)[];
  give(defId: string): WeaponInstance | null;
  swapTo(slot: number): void;
  refillAmmo(slotOrAll?: number | 'all'): void;
  upgrade(slot: number, affix?: WeaponAffix): void;
  /** Registry lookup — content lives in `src/game/weapons/defs.ts`. */
  getDef(id: string): WeaponDef | undefined;
  readonly allDefs: readonly WeaponDef[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Enemies
// ─────────────────────────────────────────────────────────────────────────────

export type EnemyKind = 'shambler' | 'sprinter' | 'brute' | 'spitter' | 'screamer';

export interface EnemyHit {
  enemy: Damageable;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  part: BodyPart;
}

export interface EnemyService {
  readonly aliveCount: number;
  readonly all: readonly Damageable[];
  spawn(kind: EnemyKind, position: THREE.Vector3, hpScale: number, speedScale: number): Damageable | null;
  /** Bullet trace against enemy hitboxes. Returns hits sorted near→far, up to `max`. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number, max: number, out: EnemyHit[]): number;
  /** Radius query for splash/chain. */
  querySphere(center: THREE.Vector3, radius: number, out: Damageable[]): number;
  damageSphere(center: THREE.Vector3, radius: number, damage: number, source: DamageInfo): number;
  killAll(reason?: string): void;
  despawnAll(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rounds / director
// ─────────────────────────────────────────────────────────────────────────────

export type RoundPhase = 'pre' | 'active' | 'clearing' | 'intermission' | 'boondraw' | 'gameover';

export interface RoundService {
  readonly round: number;
  readonly phase: RoundPhase;
  readonly remaining: number;
  readonly combo: number;
  readonly comboMultiplier: number;
  start(): void;
  skipToRound(n: number): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boons
// ─────────────────────────────────────────────────────────────────────────────

export type BoonRarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface BoonDef {
  id: string;
  name: string;
  description: string;
  rarity: BoonRarity;
  /** Emoji-free procedural icon id, drawn by the UI layer. */
  icon: string;
  maxStacks: number;
  /** Pure stat modification. Applied over the base stats in stack order. */
  modify?(stats: PlayerStats, stacks: number): void;
  /** Behavioural boons hook events here; return a disposer. */
  attach?(ctx: GameCtx, stacks: number): () => void;
}

export interface BoonService {
  readonly owned: readonly { def: BoonDef; stacks: number }[];
  readonly pendingChoice: readonly BoonDef[] | null;
  /** Deal 3 cards. Emits `boon:offer`. */
  offer(count?: number): void;
  choose(id: string): void;
  has(id: string): boolean;
  stacksOf(id: string): number;
  grant(id: string): void;
  readonly allDefs: readonly BoonDef[];
}

// ─────────────────────────────────────────────────────────────────────────────
// VFX / HUD / Audio / Debug
// ─────────────────────────────────────────────────────────────────────────────

export type ImpactKind = 'bullet' | 'blood' | 'explosion' | 'shock' | 'flame';

export interface VfxService {
  impact(position: THREE.Vector3, normal: THREE.Vector3, kind: ImpactKind, scale?: number): void;
  muzzleFlash(position: THREE.Vector3, direction: THREE.Vector3, scale?: number): void;
  tracer(from: THREE.Vector3, to: THREE.Vector3, thickness?: number): void;
  inkSplatter(position: THREE.Vector3, direction: THREE.Vector3, amount: number): void;
  /** Zombie death: flat panel shards spinning away. */
  panelShatter(position: THREE.Vector3, direction: THREE.Vector3, color: number): void;
  /** Billboarded onomatopoeia, e.g. "BLAM!". */
  wordPop(position: THREE.Vector3, text: string, color: number, scale?: number): void;
  damageNumber(position: THREE.Vector3, amount: number, isCrit: boolean): void;
  explosion(position: THREE.Vector3, radius: number): void;
  /** Additive camera shake. */
  shake(amount: number, duration: number): void;
  dust(position: THREE.Vector3, amount: number): void;
}

export interface HudService {
  /** Big centered comic title card, e.g. "ROUND 7". */
  titleCard(text: string, subtitle?: string, duration?: number): void;
  toast(text: string): void;
  /** Contextual interact prompt, e.g. "HOLD F — Ratatat [500]". Pass null to clear. */
  prompt(text: string | null): void;
  setCrosshairSpread(radians: number): void;
  hitMarker(isCrit: boolean, killed: boolean): void;
  setVisible(v: boolean): void;
}

export interface AudioService {
  /** Fire a synthesized one-shot. `id` is a synth recipe name, not a file. */
  play(id: string, opts?: { position?: THREE.Vector3; volume?: number; pitch?: number }): void;
  /** Adaptive music intensity, 0..1. */
  setIntensity(v: number): void;
  /** Muffled/underwater filter for hitstop, downed state, nuke. */
  setDucking(v: number): void;
  masterVolume: number;
  resume(): Promise<void>;
}

export interface DebugService {
  readonly enabled: boolean;
  toggle(): void;
  watch(label: string, getter: () => string | number): void;
  line(from: THREE.Vector3, to: THREE.Vector3, color?: number, seconds?: number): void;
  point(at: THREE.Vector3, color?: number, seconds?: number): void;
  log(...args: unknown[]): void;
}

/**
 * THE EVENT MAP — the other half of the integration seam.
 *
 * Systems communicate by emitting and listening here. This is how a weapon system makes the HUD
 * flash, the audio pop and the camera shake without ever importing any of them.
 *
 * Adding an event is cheap and encouraged. Adding a direct import between two game systems is not.
 */

import type * as THREE from 'three';
import type {
  BodyPart, BoonDef, DamageInfo, Damageable, EnemyKind, ImpactKind,
  MoveState, QualityTier, SurfaceKind, WeaponInstance,
} from './types';

export interface GameEventMap {
  // ── lifecycle ──────────────────────────────────────────────────────────────
  'game:booted': Record<string, never>;
  'game:started': Record<string, never>;
  'game:over': { round: number; kills: number; bestCombo: number; timeSurvived: number };
  'game:paused': { paused: boolean };
  'quality:changed': { tier: QualityTier };

  // ── player ─────────────────────────────────────────────────────────────────
  'player:spawned': { position: THREE.Vector3 };
  'player:damaged': { amount: number; health: number; fromDirection: THREE.Vector3 };
  'player:healed': { amount: number; health: number };
  'player:down': { reviveTime: number };
  'player:revived': Record<string, never>;
  'player:died': Record<string, never>;
  'player:movestate': { from: MoveState; to: MoveState; speed: number };
  'player:landed': { impactSpeed: number; position: THREE.Vector3 };
  'player:footstep': { position: THREE.Vector3; surface: SurfaceKind; sprinting: boolean };
  'player:points': { total: number; delta: number; reason: string; worldPos?: THREE.Vector3 };
  'player:statsChanged': Record<string, never>;

  // ── weapons ────────────────────────────────────────────────────────────────
  'weapon:equipped': { weapon: WeaponInstance; slot: number };
  'weapon:fired': { weapon: WeaponInstance; origin: THREE.Vector3; direction: THREE.Vector3; shotIndex: number };
  'weapon:dryFire': { weapon: WeaponInstance };
  'weapon:reloadStart': { weapon: WeaponInstance; duration: number };
  'weapon:reloadEnd': { weapon: WeaponInstance; active: boolean };
  'weapon:activeReloadWindow': { open: boolean };
  'weapon:ammoChanged': { ammo: number; reserve: number };
  'weapon:upgraded': { weapon: WeaponInstance };

  // ── combat ─────────────────────────────────────────────────────────────────
  'hit:world': { point: THREE.Vector3; normal: THREE.Vector3; surface: SurfaceKind; kind: ImpactKind };
  'hit:enemy': { target: Damageable; info: DamageInfo; remainingHealth: number; killed: boolean };
  'enemy:spawned': { enemy: Damageable; kind: EnemyKind; position: THREE.Vector3 };
  'enemy:killed': { enemy: Damageable; kind: EnemyKind; position: THREE.Vector3; byCrit: boolean; part: BodyPart };
  'enemy:dismembered': { enemy: Damageable; part: BodyPart; position: THREE.Vector3 };
  'enemy:attacked': { enemy: Damageable; damage: number };

  // ── rounds & economy ───────────────────────────────────────────────────────
  'round:start': { round: number; toSpawn: number };
  'round:cleared': { round: number; perfect: boolean };
  'round:intermission': { seconds: number };
  'combo:changed': { combo: number; multiplier: number };
  'powerup:dropped': { id: string; position: THREE.Vector3 };
  'powerup:collected': { id: string };

  // ── boons ──────────────────────────────────────────────────────────────────
  'boon:offer': { choices: readonly BoonDef[] };
  'boon:chosen': { def: BoonDef; stacks: number };

  // ── presentation (fire-and-forget; anyone may emit) ─────────────────────────
  /** Request an onomatopoeia pop in world space. */
  'fx:word': { text: string; position: THREE.Vector3; color: number; scale?: number };
  /** Request a synthesized sound by recipe id. */
  'fx:sound': { id: string; position?: THREE.Vector3; volume?: number; pitch?: number };
  'fx:shake': { amount: number; duration: number };
  'fx:flash': { intensity: number; color?: number };
  'fx:hitstop': { seconds: number };

  // ── ui ─────────────────────────────────────────────────────────────────────
  'ui:prompt': { text: string | null };
  'ui:titleCard': { text: string; subtitle?: string; duration?: number };
}

export type GameEventKey = keyof GameEventMap;

/** Minimal, allocation-free-on-emit typed bus. */
export class Emitter {
  private map = new Map<GameEventKey, Set<(p: never) => void>>();

  on<K extends GameEventKey>(k: K, fn: (p: GameEventMap[K]) => void): () => void {
    let set = this.map.get(k);
    if (!set) { set = new Set(); this.map.set(k, set); }
    set.add(fn as (p: never) => void);
    return () => this.off(k, fn);
  }

  once<K extends GameEventKey>(k: K, fn: (p: GameEventMap[K]) => void): () => void {
    const wrapped = (p: GameEventMap[K]) => { this.off(k, wrapped); fn(p); };
    return this.on(k, wrapped);
  }

  off<K extends GameEventKey>(k: K, fn: (p: GameEventMap[K]) => void): void {
    this.map.get(k)?.delete(fn as (p: never) => void);
  }

  emit<K extends GameEventKey>(k: K, p: GameEventMap[K]): void {
    const set = this.map.get(k);
    if (!set) return;
    for (const fn of set) (fn as (q: GameEventMap[K]) => void)(p);
  }

  clear(): void { this.map.clear(); }
}

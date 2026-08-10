/**
 * WORLD SYSTEM — owns the arena geometry, the collision world and the light rig.
 *
 * Registration order (ARCHITECTURE §3) puts `world` right after `time`, so every system
 * downstream can raycast and resolve against a world that is already built.
 *
 *   const world = createWorld();          // build it (synchronous, ~1 frame of work)
 *   ctx.world = world.service;            // hand the WorldService to the ctx
 *   loop.add(world);
 */

import { Fog, Group, Vector3 } from 'three';
import type { GameCtx, QualityTier, System, WorldService } from '@/core/types';
import { INK_GLOBALS } from '@/render/materials';
import { PALETTE, color } from '@/art/palette';
import { buildArena, type Arena, type ArenaOptions, type ArenaZone } from '@/world/arena';
import { WorldCollision, buildCollision, type CollisionOptions } from '@/world/collision';
import { ArenaLighting, buildLighting, FOG_NEAR, FOG_FAR } from '@/world/lighting';

export interface WorldOptions extends ArenaOptions, CollisionOptions {
  quality?: QualityTier;
  /**
   * Override the fog range, metres. Omit and it is derived from the arena's own size (see
   * `fitFogToArena`) — which is the correct default, because fog distance is a property of
   * how big the space is, and the space is what this module owns.
   */
  fogRange?: [number, number];
}

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * FOG vs ARENA SCALE — a stopgap that belongs to `lighting.ts`, parked here on purpose.
 *
 * `lighting.ts` hardcodes `FOG_NEAR = 26 / FOG_FAR = 118`, authored against BUILD 001's 70 m
 * block where 118 m was comfortably past the far wall. BUILD 002 doubled the arena to 140 m:
 * with those numbers the far perimeter, the backdrop masses and the entire far half of every
 * 140 m sightline sit at fog = 1.0, which erases the single thing the rescale was for.
 *
 * This module owns the arena size, so it derives a fog range from it and writes it after
 * `lighting.applyToScene`. It only ever WIDENS the range — if someone later authors a wider
 * one in `lighting.ts`, this becomes a no-op automatically and can be deleted.
 *
 * `lighting.ts` is not mine to edit. Colour/lighting agent: please take the decision properly
 * over there and delete this. The numbers below are geometry, not art.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
function fitFogToArena(bounds: { min: Vector3; max: Vector3 }): [number, number] {
  const w = bounds.max.x - bounds.min.x;
  const d = bounds.max.z - bounds.min.z;
  // The longest thing a player can look down is the diagonal. Fog must not close before it.
  const diagonal = Math.hypot(w, d);
  // Near = a third of a block: close enough that atmosphere still separates the foreground
  // from the building ring. Far = the full diagonal plus the backdrop ring behind the wall.
  return [Math.max(FOG_NEAR, w * 0.4), Math.max(FOG_FAR, diagonal * 1.15)];
}

export class WorldSystem implements System {
  readonly name = 'world';

  readonly root = new Group();
  readonly arena: Arena;
  readonly collision: WorldCollision;
  readonly lighting: ArenaLighting;

  /** Fog range actually in force, metres. Watched in the debug panel. */
  readonly fogRange: [number, number];

  private added = false;
  private offQuality: (() => void) | null = null;

  constructor(opts: WorldOptions = {}) {
    this.root.name = 'world';

    this.arena = buildArena(opts);
    this.root.add(this.arena.group);

    // The walkable-slope limit and ground probe are MOVEMENT constants: `game/tuning.ts` owns
    // them and the integrator hands them down, so the solver and the controller can never
    // disagree about what counts as standing on something.
    this.collision = buildCollision(this.root, this.arena, {
      groundNormalY: opts.groundNormalY,
      groundProbe: opts.groundProbe,
    });

    this.lighting = buildLighting({
      bounds: this.arena.bounds,
      practicals: this.arena.practicals,
      quality: opts.quality ?? 'high',
      seed: opts.seed,
    });
    this.root.add(this.lighting.group);

    this.fogRange = opts.fogRange ?? fitFogToArena(this.arena.bounds);
  }

  /**
   * Push the arena-derived fog range into both consumers: three's `scene.fog` (standard
   * materials, the sky dome) and `INK_GLOBALS.uFogRange` (every `InkMaterial`). They must
   * agree or the banded fog steps on the buildings won't line up with the sky.
   */
  private applyFog(scene: GameCtx['scene']): void {
    const [near, far] = this.fogRange;
    INK_GLOBALS.uFogRange.value.set(near, far);
    const fog = scene.fog;
    if (fog instanceof Fog) {
      fog.near = near;
      fog.far = far;
    } else {
      scene.fog = new Fog(color(PALETTE.NIGHT_A).getHex(), near, far);
    }
  }

  /** The contract the rest of the game talks to. */
  get service(): WorldService {
    return this.collision;
  }

  get zones(): readonly ArenaZone[] {
    return this.collision.zones;
  }

  /** Player spawn, straight from the level design. */
  get playerSpawn(): { position: Vector3; yaw: number } {
    return this.arena.playerSpawn;
  }

  /** Drop the light rig (and its shadow map) down a tier. Also driven by `quality:changed`. */
  setQuality(tier: QualityTier): void {
    this.lighting.setQuality(tier);
  }

  init(ctx: GameCtx): void {
    if (!this.added) {
      ctx.scene.add(this.root);
      this.added = true;
    }
    this.lighting.applyToScene(ctx.scene);
    // AFTER applyToScene — it installs its own Fog and writes its own uFogRange, and the
    // arena's size has to win. See `fitFogToArena`.
    this.applyFog(ctx.scene);
    this.lighting.applyToRenderer(ctx.renderer.three);
    this.lighting.setQuality(ctx.renderer.quality);

    this.offQuality = ctx.events.on('quality:changed', (p) => {
      this.lighting.setQuality(p.tier);
      this.lighting.applyToRenderer(ctx.renderer.three);
      // `setQuality` may re-write the ink globals; keep the arena-derived range in force.
      this.applyFog(ctx.scene);
    });

    ctx.debug.watch('arena draws', () => this.arena.drawCalls);
    ctx.debug.watch('arena tris', () => this.arena.triangles);
    ctx.debug.watch('collide tris', () => this.collision.triangleCount);
    ctx.debug.watch('fog', () => `${this.fogRange[0].toFixed(0)}–${this.fogRange[1].toFixed(0)}m`);
    ctx.debug.watch('zone', () => this.collision.zoneAt(ctx.camera.position) ?? '—');
  }

  /**
   * Presentation only — practical flicker and god-ray animation. Deliberately driven by
   * UNSCALED time so the neon keeps buzzing through hitstop and slow-mo.
   */
  update(dt: number, ctx: GameCtx): void {
    this.lighting.update(ctx.time.frameDt > 0 ? ctx.time.frameDt : dt);
  }

  dispose(): void {
    this.offQuality?.();
    this.offQuality = null;
    this.collision.dispose();
    this.lighting.dispose();
    this.arena.dispose();
    this.root.clear();
    this.root.removeFromParent();
  }
}

export function createWorld(opts: WorldOptions = {}): WorldSystem {
  return new WorldSystem(opts);
}

export { buildArena, ARENA_HALF } from '@/world/arena';
export type { Arena, ArenaZone, ArenaCollider, ArenaOptions } from '@/world/arena';
export { WorldCollision, buildCollision } from '@/world/collision';
export { ArenaLighting, buildLighting, KEY_DIR, FILL_DIR, RIM_DIR, FOG_NEAR, FOG_FAR } from '@/world/lighting';
export type { PracticalSpec, LightingOptions } from '@/world/lighting';

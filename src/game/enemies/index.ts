/**
 * ENEMIES — the module's public face.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WIRING IT UP (integrator — this is the whole change, and it is three lines)
 *
 *      import { createEnemies } from '@/game/enemies';
 *      …
 *      const enemies = createEnemies();          // before the ctx is built
 *      const ctx: GameCtx = { …, enemies, … };   // replaces `stubs.enemies`
 *      loop.add(enemies);                        // AFTER player, BEFORE rounds (ARCH §3)
 *
 *  Registration order matters and is not negotiable: `player` must have moved this step before
 *  the horde steers at it, and `weapons` must be able to trace against this frame's bodies. The
 *  second is handled defensively — `raycast()` brings the horde's pose up to date on demand — so
 *  registering `enemies` after `weapons` is correct and safe, exactly as ARCHITECTURE §3 says.
 *
 *  Nothing else in `main.ts` needs to change. There is no VFX call, no audio call and no HUD
 *  call anywhere in this module: it emits `enemy:spawned`, `hit:enemy`, `enemy:dismembered`,
 *  `enemy:killed`, `enemy:attacked` and `fx:sound`, and the systems built in parallel react to
 *  those. `game/stubs.ts::StubEnemies` can be deleted from the stub set the moment this is in.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * PLAYING IT BEFORE THE ROUND DIRECTOR EXISTS (M3 owns `RoundService`):
 *   `Z` spawns five zombies around the player · `X` fills the arena to 25 · `B` clears them.
 *   Or from the console: `CZ.ctx.enemies.spawn('shambler', CZ.player.position, 1, 1)`.
 */

export { EnemySystem } from '@/game/enemies/service';

export {
  ANIM, BODY, ENEMY_DEFS, HITBOX, LIMB, PART, POOL, SCHED, SHAMBLER, VARIANTS, defFor,
  type BodyVariant, type EnemyDef, type EnemyStateName,
} from '@/game/enemies/defs';

export { EnemyBody, buildEnemyGeometry, makeEnemyMaterials } from '@/game/enemies/body';
export type { EnemyGeometrySet, PoseArgs } from '@/game/enemies/body';

export { HitReactions } from '@/game/enemies/reactions';
export type { ReactionResult } from '@/game/enemies/reactions';

import { EnemySystem } from '@/game/enemies/service';

/**
 * Build the horde. Everything expensive — geometry, hulls, materials, the whole pool of
 * `POOL.capacity` bodies — is built in `init()`, not here, so this is free to call during boot
 * before the scene exists.
 */
export function createEnemies(): EnemySystem {
  return new EnemySystem();
}

/**
 * MOTION — the shared character-motion solver.
 *
 * One swept-capsule mover with gravity, used by BOTH the player controller and the horde.
 * See `mover.ts` for why it exists and what it guarantees.
 *
 * This module is a LIBRARY, not a game system: it holds no per-frame state beyond scratch, it
 * depends only on the `WorldService` interface from `core/types.ts`, and it is therefore not a
 * system-to-system dependency (ARCHITECTURE §1) — `game/player/**` and `game/enemies/**` both
 * import it exactly the way `enemies/body.ts` already imports `world/lighting`.
 */

export {
  applyGravity,
  capsuleOverlapDepth,
  lastResidual,
  makeMotionParams,
  moveBody,
} from './mover';
export type { MotionBody, MotionParams } from './mover';

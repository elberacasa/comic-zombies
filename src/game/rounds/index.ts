/**
 * ROUNDS — the module's public face. M3, "The Loop".
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WIRING IT UP (integrator — this is the whole change)
 *
 *      import { createRounds } from '@/game/rounds';
 *      …
 *      const rounds = createRounds();            // before the ctx is built
 *      const ctx: GameCtx = { …, rounds, … };    // replaces `stubs.rounds`
 *      loop.add(rounds);                         // AFTER enemies, BEFORE vfx (ARCH §3)
 *      …
 *      rounds.start();                           // on the first pointer lock
 *
 *  `RoundSystem` implements both `System` and `RoundService`, so the same object is the service
 *  in `GameCtx` and the frame hook in the loop. Registration order matters exactly once: the
 *  director reads `enemies.aliveCount` to decide whether a round is over, so it must run after
 *  the horde has been stepped, or a round "clears" one frame early.
 *
 *  Nothing else needs to change. This module makes no direct call into another game system's
 *  implementation — it talks through `GameCtx` interfaces and the typed bus only.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * EMITS   `round:start` · `round:cleared` · `round:intermission` · `combo:changed`
 *         `powerup:dropped` · `powerup:collected` · `game:over` · `fx:hitstop`
 *         (plus `player:points` indirectly, via `PlayerService.addPoints`)
 * CONSUMES `hit:enemy` · `enemy:killed` · `player:damaged` · `player:down` · `player:revived`
 *         · `player:died`
 *
 * TESTING HATCH: `RoundService.skipToRound(n)` clears the street and drops you straight into
 * round `n` with that round's HP, speed, count and live cap. Expose it on `window.CZ`.
 */

export { RoundSystem, createRounds } from '@/game/rounds/director';

export { ComboMeter } from '@/game/rounds/combo';
export { Economy, loadMeta, saveMeta } from '@/game/rounds/economy';
export type { MetaSave, RunStats } from '@/game/rounds/economy';
export { SpawnDirector } from '@/game/rounds/spawner';
export { PowerupField, POWERUP_DEFS, rollPowerup } from '@/game/rounds/powerups';
export type { PowerupDef, PowerupId } from '@/game/rounds/powerups';

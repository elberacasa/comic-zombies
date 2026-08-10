/**
 * BOONS — the roguelite layer. GAME_BIBLE §5.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WIRING (main.ts) — three lines, and the middle one is the one that matters.
 *
 *      const player = createPlayer();
 *      const boons  = createBoons(player);     // ← the modifier-stack host; tsc checks it
 *      …
 *      boons: boons,                            // in the GameCtx literal, replacing stubs.boons
 *      …
 *      loop.add(boons);                         // AFTER enemies, BEFORE vfx (ARCHITECTURE §3)
 *
 *  Registration position matters for exactly one reason: `BoonStatEffects.fixedUpdate` applies
 *  slide contact damage, and it must see the position the player reached THIS step, not last.
 *  Anywhere after `player` is correct; §3's slot (after `rounds`) is the intended one.
 *
 *  Without `loop.add`, `init()` never runs, `ctx` is never set, and `offer()` will log an error
 *  rather than fail quietly.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { BoonSystem } from './service';
import type { BoonStatHost } from './service';

/**
 * Build the boon service.
 *
 * `host` is the object that owns the player's stat modifier stack — in practice `PlayerSystem`,
 * which satisfies `BoonStatHost` structurally, so this call needs no cast and creates no import
 * from `player/**`. It is optional only so the service can be constructed before the player
 * exists; `attachStatHost()` completes the wiring later. With no host, stat boons are inert and
 * say so on the console.
 */
export function createBoons(host?: BoonStatHost): BoonSystem {
  return new BoonSystem(host);
}

export { BoonSystem } from './service';
export type { BoonStatHost } from './service';

export {
  BOON_DEFS,
  BOON_BY_RARITY,
  BOON_DRAW,
  BOON_ICON_IDS,
  BOON_RARITIES,
  BOON_RUNTIME,
  BOON_TUNING,
  boonById,
  rarityWeight,
  resetBoonRuntime,
} from './defs';
export type { BoonDefX, BoonIconId, BoonTicker } from './defs';
export { BoonStatEffects } from './effects';

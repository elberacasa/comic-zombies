/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE ARSENAL — the registry, and the only list of weapons in the codebase.
 *
 * ADDING A FIFTH GUN IS: write `models/<id>.ts`, import it here, put it in the array. Nothing
 * in `../viewmodel.ts` is touched — not the builder, not the material factory, not the pose
 * stack, not `assertClearance`. That is the whole point of the split and it is the test to run
 * against any future change to this layout: if a new weapon needs an edit upstairs, the
 * vocabulary is missing an entry and the fix belongs in `types.ts`, not in a special case.
 *
 * ORDER IS EQUIP ORDER. `GUN_IDS`, the gallery's page order and the boot weapon all read this
 * array front to back, so index 0 is what the player is holding on the first frame — and it is
 * also the profile every clearance number in the codebase is quoted against.
 *
 * THE PISTOL IS THE REFERENCE. Its numbers are BUILD 007's, unchanged to the millimetre: it is
 * the model the other three are read against and the one whose clearance is measured at 0.386 m.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */

import { BOOMSTICK } from './boomstick';
import { INKSLINGER } from './inkslinger';
import { LONGSHOT } from './longshot';
import { PRESS } from './press';
import { RATATAT } from './ratatat';
import { REDLINE } from './redline';
import type { WeaponModelDef } from './types';

/** Every weapon in the game, in equip order. One line per gun, and that is the whole list. */
export const WEAPON_MODELS: readonly WeaponModelDef[] = [
  INKSLINGER,
  // Second, so J's first press hands it over and Q flips straight back to the reference pistol.
  PRESS,
  RATATAT,
  BOOMSTICK,
  LONGSHOT,
  // Last, so every existing equip index is untouched. It is the clean-sheet battle rifle the
  // other five get rebuilt against — see the header of `models/redline.ts` for why its
  // `depthCompress` is 0.62 and not the 1.0 the rework brief asked for.
  REDLINE,
];

/**
 * The model for a `WeaponDef.id`, falling back to the reference pistol.
 *
 * The fallback is deliberate and it is the same one `profileFor` has always had: a def that
 * names a model nobody wrote must still produce a gun in the player's hands rather than a
 * crash mid-round. It is not a licence to skip the registry — `GUN_IDS` is built from this
 * array, so an unregistered model is a weapon the gallery and the equip flow cannot see.
 */
export function weaponModelFor(id: string): WeaponModelDef {
  return WEAPON_MODELS.find((m) => m.profile.id === id) ?? (WEAPON_MODELS[0] as WeaponModelDef);
}

export * from './types';

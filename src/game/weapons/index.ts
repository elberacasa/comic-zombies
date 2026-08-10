/**
 * WEAPONS — public surface of the module.
 *
 * `main.ts` needs exactly two lines to adopt this:
 *
 *   const weapons = createWeapons();          // build it next to the player
 *   ...
 *   weapons: weapons,                         // in the GameCtx, replacing `stubs.weapons`
 *   loop.add(weapons);                        // after `player`, per ARCHITECTURE §3
 *
 * Everything else is events. See `service.ts` for the frame contract and `firing.ts` for the
 * emission order the VFX / audio / HUD systems can rely on.
 */

export { WeaponSystem, Weapon, createWeapons } from './service';
export {
  INKSLINGER, WEAPON_DEFS, STARTER_WEAPON_ID, UPGRADE, getWeaponDef, upgradedDef,
} from './defs';
export { RecoilController, SpreadController, findRecoilRig, scatter, safeSpreadMult } from './recoil';
export type { RecoilKick, RecoilRig, SpreadState } from './recoil';
export { traceShot, buildShotDirection, falloffAt, partMultiplier, pointAlong } from './firing';
export type { ShotParams, ShotResult } from './firing';
export { Viewmodel, makeViewmodelDrive } from './viewmodel';
export type { ViewmodelDrive } from './viewmodel';

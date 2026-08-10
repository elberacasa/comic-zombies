/**
 * WEAPON CONTENT. Pure data — no behaviour, no imports from the service.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE DEF IS THE WEAPON. `service.ts` knows nothing about any specific gun; everything that
 *  makes the inkslinger feel like the inkslinger is in this file. That is the test the M4
 *  arsenal has to pass: all five GAME_BIBLE §3 archetypes must be expressible HERE, with the
 *  service untouched. The sketches at the bottom of this file exist to prove that claim now,
 *  while there is only one shipped weapon to check it against.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Units: metres, seconds, RADIANS. `rpm` is the only "game" unit and it is rounds per minute.
 */

import type { WeaponAffix, WeaponDef } from '@/core/types';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// INKSLINGER — the starter pistol, and the gun the human will judge gunplay on.
//
// IDENTITY (GAME_BIBLE §3): *infinite reserve, precise, rewards headshots.*
// It is deliberately not exciting on paper. Its whole skill expression is in three places:
//   1. the headshot (2.5×, and the pistol's damage is tuned so heads matter for TTK),
//   2. the recoil pattern, which is short, steep and completely learnable,
//   3. the active reload, which is the difference between a good pistol and a great one.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const INKSLINGER: WeaponDef = {
  id: 'inkslinger',
  name: 'INKSLINGER',
  archetype: 'pistol',

  /**
   * Base body damage. Paired with `headshotMult` this gives 42 body / 105 head, i.e. a
   * two-shot head kill on anything up to 210 HP and a five-shot body kill on the same target.
   * That ~2.5× gap is the entire point of the gun: heads are not a bonus, they are the plan.
   */
  damage: 42,
  /** GAME_BIBLE §3: headshots are crits at 2.5×. Scaled by `PlayerStats.critMult` at runtime. */
  headshotMult: 2.5,

  /**
   * 400 rpm = 150 ms between shots. Semi-auto, so this is a CEILING on a fast trigger finger
   * rather than a rate you sit at — it exists to stop a macro out-DPSing an SMG. Raise it and
   * the pistol stops feeling deliberate; drop it below ~330 and double-tapping feels blocked.
   */
  rpm: 400,
  auto: false,

  /** 12 in the mag: two headshot kills plus a miss, four times over, before a reload decision. */
  magSize: 12,
  reserveAmmo: 0,
  /** The starter never runs out — you can always fight, you just cannot always fight *well*. */
  infiniteReserve: true,

  /**
   * 1.55 s is a long reload for a pistol, on purpose: the active reload has to be worth
   * learning, and it cannot be if the base reload is already free.
   */
  reloadTime: 1.55,
  /**
   * ACTIVE RELOAD WINDOW — [start, width] in seconds along the base reload.
   * 0.62 → 0.88 is 40–57% of the bar: past the halfway mark so it cannot be mashed early, and
   * 0.26 s wide (≈16 frames at 60 fps) so it is comfortably hittable once you know where it is
   * and comfortably missable if you are panicking. This one pair of numbers is the pistol's
   * skill ceiling — retune it from playtest feedback before touching anything else here.
   */
  activeReloadWindow: [0.62, 0.26],

  pellets: 1,

  /**
   * Cones, in radians (half-angle).
   * Hip 0.012 rad ≈ 0.69° — an 18 cm radius at 15 m. A real, usable hip-fire cone, because
   * kiting demands it (GAME_BIBLE §3), but not one you can headshot across the plaza with.
   * ADS 0.0018 rad ≈ 0.10° — 2.7 cm at 15 m. Effectively a laser: this is the reward for
   * standing still, and it is what makes ADS a decision rather than a habit.
   */
  spreadHip: 0.012,
  spreadAds: 0.0018,

  /**
   * THE PATTERN. Deterministic, indexed by shot number, wrapping. Learnable = skill; random
   * spray = luck (GAME_BIBLE §3).
   *
   * Shape: a hard vertical crack on shot 1 that settles into a steady climb, with a lateral
   * drift that goes RIGHT for three shots and then comes back LEFT. That reversal is what makes
   * it a *pattern* rather than a slope — a slope you compensate by holding the mouse down, a
   * pattern you have to actually learn.
   *
   * The yaw column sums to EXACTLY ZERO over one cycle. That is deliberate and it is an ART §10
   * rule as much as a gunplay one: a pattern with net lateral bias walks the player's aim
   * sideways with no input, which is the same class of bug as a camera that drifts on a
   * straight line. Keep the sum at zero if you retune it.
   */
  recoilPattern: [
    [0.0264, 0.0000],
    [0.0240, 0.0070],
    [0.0221, 0.0128],
    [0.0208, 0.0084],
    [0.0198, -0.0064],
    [0.0192, -0.0122],
    [0.0198, -0.0096],
    [0.0211, 0.0000],
  ],

  /**
   * Rate (1/s) the un-corrected part of the climb springs back at. 2.6 gives a ~0.4 s time
   * constant: the muzzle settles over about a second after a burst, which is the CoD read.
   *
   * It is also, not coincidentally, right at the ceiling `recoil.ts:maxReturnRate` derives from
   * the camera's spring — a faster return cannot reach the look angles without dragging the
   * camera's recoil spring down with it. Raising this number does not make the gun recover
   * faster; it just gets clamped. See `WEAPON.recoilRecoverTransientMax`.
   */
  recoilRecovery: 2.6,

  /**
   * THE TWO KICK LAYERS, scaled per weapon. `cameraKick` multiplies the pattern above into the
   * camera's recoil spring; `weaponKick` multiplies the (separate, softer, slower) viewmodel
   * kick springs. 1.0 / 1.0 makes the inkslinger the reference weapon both layers are read
   * against — an SMG will run ~0.5 camera and ~0.7 weapon, a shotgun ~2.2 / 2.6.
   */
  cameraKick: 1,
  weaponKick: 1,

  /**
   * 55 m of useful range with damage falling to 62% at the far end (falloff starts at 45% of
   * range — see `WEAPON.falloffStart`). The arena's longest sightline is ~140 m, so the pistol
   * is explicitly not the answer down a full radial street. That is what the marksman is for.
   */
  range: 55,
  falloff: 0.62,

  /** A pistol stops at the first thing it hits. Penetration is the marksman's identity. */
  penetration: 0,

  /** 0.18 s to full ADS — fast. The pistol's handling is its compensation for its damage. */
  adsTime: 0.18,
  /**
   * FOV while aiming, degrees. 56 against `CAMERA.fovBase` 78 is a 22° pull — matched to the
   * shipped `CAMERA.fovAds` so the two agree, and delivered on a curve rather than the camera's
   * step (see `service.ts:applyAdsFov`). ART §10: FOV changes must be smooth and bounded.
   */
  adsFov: 56,

  /** You barely slow down carrying a pistol. It is the weapon you *move* with. */
  moveSpeedMult: 0.96,

  affix: 'none',

  /** Wall-buy economics. The starter is never sold, only re-ammoed. */
  buyCost: 0,
  ammoCost: 250,
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The registry
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Everything the game can hand you. M2 ships one, perfectly. M4 fills this out. */
export const WEAPON_DEFS: readonly WeaponDef[] = [INKSLINGER];

const _byId = new Map<string, WeaponDef>();
for (const d of WEAPON_DEFS) _byId.set(d.id, d);

export function getWeaponDef(id: string): WeaponDef | undefined {
  return _byId.get(id);
}

/** The gun you spawn holding. */
export const STARTER_WEAPON_ID = INKSLINGER.id;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PACK-A-PUNCH — the upgraded form is a DERIVED DEF, not a special case in the service.
//
// GAME_BIBLE §5: "+damage, +mag, an elemental affix and a comic-ified name". Because it returns
// a plain `WeaponDef`, every system downstream (firing, viewmodel, HUD) keeps working with zero
// awareness that an upgrade happened.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const AFFIX_NAMES: Record<WeaponAffix, string> = {
  none: 'MK-II',
  shock: 'THUNDERPEN',
  flame: 'FIREBRAND',
  ink: 'BLACKOUT',
};

export const UPGRADE = {
  damageMult: 2.1,
  magMult: 1.5,
  reserveMult: 1.5,
  /** Upgraded guns handle better too — that is most of why the upgrade *feels* like one. */
  reloadMult: 0.85,
  spreadMult: 0.8,
  recoilMult: 0.85,
} as const;

/** Build the Pack-a-Punch form of a def. Pure — the source def is never mutated. */
export function upgradedDef(base: WeaponDef, affix: WeaponAffix = 'none'): WeaponDef {
  return {
    ...base,
    id: `${base.id}+`,
    name: `${base.name} ${AFFIX_NAMES[affix]}`,
    damage: Math.round(base.damage * UPGRADE.damageMult),
    magSize: Math.round(base.magSize * UPGRADE.magMult),
    reserveAmmo: Math.round(base.reserveAmmo * UPGRADE.reserveMult),
    reloadTime: base.reloadTime * UPGRADE.reloadMult,
    activeReloadWindow: [
      base.activeReloadWindow[0] * UPGRADE.reloadMult,
      base.activeReloadWindow[1] * UPGRADE.reloadMult,
    ],
    spreadHip: base.spreadHip * UPGRADE.spreadMult,
    spreadAds: base.spreadAds * UPGRADE.spreadMult,
    cameraKick: base.cameraKick * UPGRADE.recoilMult,
    weaponKick: base.weaponKick * UPGRADE.recoilMult,
    affix,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// ARCHETYPE COVERAGE — the proof that `WeaponDef` can carry M4 without the service changing.
//
// These are NOT shipped (they are not in `WEAPON_DEFS`) and they are not tuned. They exist so
// that the claim "all five archetypes are expressible in the def" is checkable today, by
// reading, rather than being discovered to be false in M4. Each line names the field that
// carries the archetype's identity.
//
//   ratatat   SMG        auto: true · rpm 900 · magSize 32 · a 24-entry pattern with a steep
//                        vertical climb and a hard left drift · spreadHip wide, spreadAds mid ·
//                        cameraKick 0.45 (small per shot, brutal cumulative)
//   boomstick Shotgun    pellets: 8 · spreadHip 0.075 · rpm 90 · falloff 0.18 (dies fast) ·
//                        range 18 · penetration 0 · weaponKick 2.6
//   longshot  Marksman   penetration: 3 · headshotMult 4 · rpm 55 · range 140 · falloff 0.95 ·
//                        adsFov 34 · spreadHip huge (it is an ADS weapon and the def says so)
//   thumper   Launcher   archetype: 'launcher' — the ONE archetype that is not hitscan.
//                        `firing.ts` dispatches on `def.archetype`, and the launcher branch is
//                        already there, delegating to a projectile hook that M4 fills in. The
//                        def carries everything else it needs (damage, rpm, mag, reload, kick);
//                        the splash radius rides on `PlayerStats.explosiveRadius` exactly like
//                        the explosive-rounds boon, so no new def field is required.
// ═════════════════════════════════════════════════════════════════════════════════════════════

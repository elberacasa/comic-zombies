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

/**
 * ═══ THE PRESS — the inkslinger's stats, in a different object ═══
 *
 * It is a LOOK, not a weapon: `models/press.ts` is a clean-sheet answer to
 * `docs/WEAPON_REWORK.md`, and the only way to judge whether that answer is better is to hold
 * the two guns one after the other and change nothing else. So the def is the pistol's, spread
 * whole — damage, rpm, mag, both cones, the eight-row recoil pattern, both kick layers, the
 * active-reload window, ADS time and FOV — with an id and a name over the top. Every difference
 * the player can feel is zero by construction rather than by matching numbers in two files.
 *
 * If it wins, it stops being a clone and gets its own numbers. If it loses, it deletes cleanly.
 */
export const PRESS: WeaponDef = { ...INKSLINGER, id: 'press', name: 'THE PRESS' };

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The registry
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ═══ THE RATATAT — SMG, the hip-fire king ═══
 *
 * Identity: you do not aim this gun, you SWIM in a horde with it. The lowest per-shot damage in
 * the game and by far the highest rate, so its answer to a body in your face is volume, and its
 * answer to a body at 40 m is "that is not your job".
 *
 * The pattern is the whole skill. It cracks vertically over five shots, plateaus, then drifts
 * HARD LEFT for ten — and the last six sweep back right. Holding the mouse down and pulling
 * straight down does not work; you have to counter the drift and then stop countering it, which
 * is exactly the "learnable pattern, not a slope" test in the inkslinger's own note above.
 */
export const RATATAT: WeaponDef = {
  id: 'ratatat',
  name: 'RATATAT',
  archetype: 'smg',
  /** 26 × 2.2 = 57 a head. Four heads or ~6 bodies on a round-1 shambler — it kills by RATE. */
  damage: 26,
  /** Below the pistol's 2.5: rewarding precision on a 900 rpm spray would delete the marksman. */
  headshotMult: 2.2,
  /** 900 rpm = 15 rounds a second. The mag is gone in 2.1 s, which is the whole risk. */
  rpm: 900,
  auto: true,
  magSize: 32,
  reserveAmmo: 224,
  reloadTime: 1.9,
  activeReloadWindow: [0.78, 0.24],
  pellets: 1,
  /**
   * Hip 0.020 rad ≈ 1.1° — WIDER than the pistol in absolute terms but far tighter per second of
   * fire, which is what "hip-fire king" actually means. ADS 0.006 is deliberately NOT a laser:
   * aiming an SMG should tighten the cone, not turn it into a marksman.
   */
  spreadHip: 0.020,
  spreadAds: 0.006,
  recoilPattern: [
    [0.0182, 0.0000],
    [0.0170, 0.0014],
    [0.0158, 0.0013],
    [0.0146, -0.0003],
    [0.0134, -0.0015],
    [0.0120, -0.0011],
    [0.0112, 0.0005],
    [0.0110, 0.0016],
    [0.0116, -0.0042],
    [0.0126, -0.0053],
    [0.0137, -0.0064],
    [0.0142, -0.0075],
    [0.0140, -0.0086],
    [0.0131, -0.0097],
    [0.0120, -0.0108],
    [0.0112, -0.0119],
    [0.0110, -0.0130],
    [0.0116, -0.0141],
    [0.0127, 0.0120],
    [0.0137, 0.0135],
    [0.0142, 0.0150],
    [0.0140, 0.0160],
    [0.0131, 0.0165],
    [0.0120, 0.0166],
  ],
  recoilRecovery: 3.4,
  /** Small per shot, brutal cumulative — fifteen of these a second is the real kick. */
  cameraKick: 0.45,
  weaponKick: 0.7,
  range: 32,
  falloff: 0.45,
  penetration: 0,
  adsTime: 0.15,
  adsFov: 62,
  moveSpeedMult: 0.94,
  affix: 'none',
  buyCost: 1200,
  ammoCost: 600,
};

/**
 * ═══ THE BOOMSTICK — shotgun, the panic button ═══
 *
 * Identity: the answer to being SURROUNDED, and nothing else. 8 pellets × 24 is 192 damage
 * inside 8 m and almost nothing past 18, because `falloff` 0.18 is the most aggressive in the
 * game. It exists to buy you the half-second you need to get out of a corner.
 *
 * Six shells and a 2.6 s reload is the cost. Firing it dry in a crowd is how you die with it.
 */
export const BOOMSTICK: WeaponDef = {
  id: 'boomstick',
  name: 'BOOMSTICK',
  archetype: 'shotgun',
  damage: 24,
  /** 1.6, not 2.5: with 8 pellets a "headshot" is really 3 pellets that happened to land high. */
  headshotMult: 1.6,
  rpm: 90,
  auto: false,
  magSize: 6,
  reserveAmmo: 48,
  reloadTime: 2.6,
  activeReloadWindow: [1.05, 0.30],
  pellets: 8,
  /** 0.075 rad ≈ 4.3° — a real cone. You point this, you do not aim it. */
  spreadHip: 0.075,
  spreadAds: 0.052,
  recoilPattern: [
    [0.0620, 0.0000],
    [0.0585, 0.0090],
    [0.0570, -0.0075],
    [0.0562, 0.0062],
    [0.0575, -0.0058],
    [0.0596, -0.0019],
  ],
  recoilRecovery: 2.2,
  /** The heaviest kick in the game on both layers. It should feel like it hurts to fire. */
  cameraKick: 2.2,
  weaponKick: 2.6,
  range: 18,
  falloff: 0.18,
  penetration: 0,
  adsTime: 0.26,
  adsFov: 66,
  moveSpeedMult: 0.90,
  affix: 'none',
  buyCost: 1500,
  ammoCost: 750,
};

/**
 * ═══ THE LONGSHOT — marksman, the train-killer ═══
 *
 * Identity: `penetration: 3`. Every other gun stops at the first body; this one goes through
 * four. It is the only weapon in the game that rewards the player for the horde being in a
 * CONGA LINE — which is the skill the whole enemy design is built around (GAME_BIBLE §4), and
 * until now nothing paid you for doing it.
 *
 * `headshotMult: 4` on 145 base is 580 to a head, through four heads. That is the highest
 * ceiling in the arsenal and it is gated behind lining the shot up, at 55 rpm, from range.
 */
export const LONGSHOT: WeaponDef = {
  id: 'longshot',
  name: 'LONGSHOT',
  archetype: 'marksman',
  damage: 145,
  headshotMult: 4,
  rpm: 55,
  auto: false,
  magSize: 7,
  reserveAmmo: 56,
  reloadTime: 2.4,
  activeReloadWindow: [0.95, 0.26],
  pellets: 1,
  /**
   * Hip 0.055 is enormous ON PURPOSE — three times the shotgun's useful accuracy. This is an ADS
   * weapon and the def says so out loud: hip-firing it is a mistake the numbers punish rather
   * than a playstyle. ADS 0.0004 is four times tighter than the pistol's laser.
   */
  spreadHip: 0.055,
  spreadAds: 0.0004,
  recoilPattern: [
    [0.0480, 0.0000],
    [0.0455, 0.0074],
    [0.0442, -0.0068],
    [0.0451, 0.0052],
    [0.0468, -0.0058],
  ],
  recoilRecovery: 2.0,
  cameraKick: 1.8,
  weaponKick: 2.0,
  /** The arena's longest sightline is ~140 m and this is the only gun that owns it. */
  range: 140,
  falloff: 0.95,
  penetration: 3,
  adsTime: 0.32,
  adsFov: 34,
  /** You are slow carrying this. Committing to the long lane is the trade. */
  moveSpeedMult: 0.88,
  affix: 'none',
  buyCost: 2000,
  ammoCost: 900,
};

/**
 * ═══ REDLINE — battle rifle, the one that hits like a sniper and fires like an SMG ═══
 *
 * Identity: the gap between the ratatat and the longshot, and the only weapon that is good at
 * BOTH ranges. 58 × 2.6 = 151 to a head at 520 rpm, `penetration: 1` so it goes through the
 * first body in a conga line, and a **20-round magazine** — the SCAR-H's real capacity, and the
 * whole risk. It kills three shamblers a mag and then you are reloading in front of the fourth.
 *
 * ─── WHY `archetype: 'smg'` ON A 7.62 BATTLE RIFLE ──────────────────────────────────────────
 * Because `archetype` is not a claim about role in this codebase — the numbers carry the role,
 * and `firing.ts` never reads the field. It is read in exactly four places, and two of them are
 * VISIBLE:
 *
 *   · `economy/wallbuys.ts` draws the wall-buy card's gun silhouette from `GUN_PARTS[archetype]`.
 *     `smg` is *folding stock · receiver · barrel · box mag · grip* — which is literally this
 *     weapon's parts list. `marksman` adds **a scope and two mounts** that REDLINE does not have
 *     and must not advertise on a card the player buys from.
 *   · `economy/box.ts` weights the mystery box: smg 30, marksman 22. A rifle you can actually
 *     fight a round with should be a common box roll, not a rare one.
 *   · `audio/index.ts` resolves `gun_${id}` first and falls back to `gun_${archetype}`, so this
 *     currently fires with the SMG's report. That is the one place the choice costs something —
 *     `gun_smg` is a bandpass-3400 crack and a 7.62 wants more chest. A `gun_redline` recipe in
 *     `audio/recipes.ts` would override it without touching this line. Noted, not owned here.
 *   · `main.ts` prints the archetype in the equip toast.
 *
 * ─── AND THE ONE NUMBER THAT IS A CLEARANCE CONSTRAINT, NOT A FEEL ONE ──────────────────────
 * `weaponKick: 1` is the ceiling, not a choice. `WEAPON.view.clearanceKickBudget` is 1.0 and the
 * viewmodel's tightest pose keeps 0.073 m at that value; walked offline, 1.1 puts a vertex 0.067 m
 * from the eye — inside `view.nearClearance` — because REDLINE's stock is the rearmost thing on
 * any weapon in the arsenal. So the weight goes into `cameraKick` (which spends no clearance at
 * all) and into the pattern's amplitude instead. To raise it, first pull `stock.z` in by 10 mm in
 * `models/redline.ts`; that buys 1.2 and costs the gun 10 mm of drawn length.
 */
export const REDLINE: WeaponDef = {
  id: 'redline',
  name: 'REDLINE',
  archetype: 'smg',
  /**
   * 58 body / 151 head. Three body shots or two heads on a round-1 shambler, against the
   * ratatat's six and four — you feel every trigger pull land, which is the point of the gun.
   */
  damage: 58,
  /** Above the SMG's 2.2, below the pistol's 2.5: precise, but not a sniper's reward. */
  headshotMult: 2.6,
  /**
   * 520 rpm = 115 ms between shots. Deliberately between the ratatat's 900 and the longshot's 55,
   * and deliberately just past `WEAPON.view.kickSettleResidual`'s rotational floor (438 rpm): the
   * rate-aware kick spring stiffens itself for this gun, so sustained fire buzzes rather than
   * heaves — exactly the behaviour that note was written to give the SMG.
   */
  rpm: 520,
  auto: true,
  /** TWENTY. The SCAR-H's real magazine, and the entire risk/reward of the weapon. */
  magSize: 20,
  reserveAmmo: 140,
  reloadTime: 2.15,
  /** 40–51 % of the bar. Late enough that it cannot be mashed, 0.24 s wide (≈14 frames). */
  activeReloadWindow: [0.86, 0.24],
  pellets: 1,
  /**
   * Hip 0.030 rad ≈ 1.7° — HALF AGAIN the SMG's, because a battle rifle is not a hip-fire weapon
   * and the def should say so out loud. ADS 0.0022 is a near-laser: tighter than the SMG's 0.006,
   * a hair looser than the pistol's 0.0018, five times looser than the longshot's.
   */
  spreadHip: 0.030,
  spreadAds: 0.0022,
  /**
   * Twelve shots — a hard vertical crack that settles by shot 7, with the lateral going RIGHT for
   * five, sweeping LEFT for five, and snapping back RIGHT on the last two. That reversal is what
   * makes it a pattern you learn rather than a slope you hold against.
   *
   * The yaw column sums to EXACTLY ZERO over one cycle (40+74+96+84+30−38−96−126−114−60+110 = 0,
   * in units of 1e-4). Keep it there if you retune it: a pattern with net lateral bias walks the
   * player's aim sideways with no input.
   */
  recoilPattern: [
    [0.0290, 0.0000],
    [0.0268, 0.0040],
    [0.0250, 0.0074],
    [0.0236, 0.0096],
    [0.0226, 0.0084],
    [0.0220, 0.0030],
    [0.0218, -0.0038],
    [0.0221, -0.0096],
    [0.0228, -0.0126],
    [0.0239, -0.0114],
    [0.0254, -0.0060],
    [0.0272, 0.0110],
  ],
  /** Between the SMG's 3.4 and the sniper's 2.0. It settles, but it makes you wait a beat. */
  recoilRecovery: 2.8,
  /** The punch lives HERE, because the camera layer costs no viewmodel clearance. See above. */
  cameraKick: 1.2,
  weaponKick: 1,
  /** 78 m useful, falling to 72 % at the far end. Owns everything except the long radial street. */
  range: 78,
  falloff: 0.72,
  /** ONE body, not none and not four. The mid rung of the conga-line ladder the enemies build. */
  penetration: 1,
  adsTime: 0.24,
  adsFov: 48,
  moveSpeedMult: 0.91,
  affix: 'none',
  buyCost: 1600,
  ammoCost: 800,
};

/**
 * Everything the game can hand you.
 *
 * `thumper` (GAME_BIBLE §3's launcher) is deliberately NOT here. The archetype note below this
 * registry used to claim `firing.ts` "dispatches on `def.archetype`" and that the launcher branch
 * was already written — neither is true; `archetype` is not read anywhere in the firing path, and
 * every weapon above works purely because it is hitscan data. A launcher needs a real projectile
 * (arc, splash, self-knockback), so it ships when that exists rather than as a def that silently
 * fires an invisible bullet.
 *
 * `PRESS` is NOT here either, and its def above is retained on purpose. It was always a
 * stat-identical clone of the starter pistol — a visual A/B for the `J` key, nothing more. In a
 * shipping arsenal that is a bug the player can buy: the mystery box hands you a second pistol
 * with different art and numerically identical everything. It comes back the moment it has its
 * own numbers, which is what its own comment says it must earn.
 */
export const WEAPON_DEFS: readonly WeaponDef[] = [
  INKSLINGER, RATATAT, BOOMSTICK, LONGSHOT, REDLINE,
];

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
//   thumper   Launcher   archetype: 'launcher' — the ONE archetype that is not hitscan, and the
//                        ONE still unbuilt. CORRECTION, BUILD 009: this note used to say
//                        "`firing.ts` dispatches on `def.archetype`, and the launcher branch is
//                        already there". Both halves are false — `archetype` is not read anywhere
//                        in the firing path. The other four archetypes shipped anyway, because
//                        they are all hitscan and `pellets` / `spread` / `penetration` / `falloff`
//                        genuinely do carry them. The launcher needs real projectile code (arc,
//                        splash, self-knockback) and is the honest remaining gap.
// ═════════════════════════════════════════════════════════════════════════════════════════════

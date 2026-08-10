/**
 * ENEMY CONTENT — pure data. No behaviour, no THREE objects, no side effects.
 *
 * ARCHITECTURE §5: "pure data lives in `defs.ts` files". `game/tuning.ts` owns the numbers the
 * *director* and the *feel pass* reach for (`ENEMY.separationRadius`, `ENEMY.meleeWindup`,
 * `ENEMY.maxAlive` …) and this file owns everything that is specific to a KIND of enemy or to
 * the way its body is drawn and animated. The rule of thumb:
 *
 *   tuning.ts  →  "how does the horde FEEL"      (shared, tuned live, owned by the feel pass)
 *   defs.ts    →  "what IS a Shambler"           (content, owned by the enemy agent)
 *
 * Nothing here is imported by a system other than `game/enemies/**`.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SHAMBLER — M2's only enemy, and the one the whole horde is built out of.
 *
 *  Design brief (GAME_BIBLE §4, M2_VERTICAL_SLICE §2): *slow, relentless, melee, KITE-ABLE*.
 *  Every number below is chosen against the player's own numbers so that kiting is a real,
 *  learnable skill rather than a stat check:
 *
 *    player walk        5.40 m/s      shambler chase   1.62 m/s   → 3.3× — you always out-walk it
 *    player sprint      8.75 m/s      shambler lunge   2.55 m/s   → 3.4× — you always out-run it
 *    player turn        instant       shambler turn    240 °/s    → cutting a corner GAINS you metres
 *    melee reach        1.90 m        windup           0.42 s     → 0.42s × 5.4 m/s = 2.27 m of
 *                                                                    escape available on the tell
 *
 *  The last row is the whole melee design: the wind-up is longer than the time it takes a
 *  walking player to leave the swing's reach, so *every single hit you take is a hit you could
 *  have avoided*. That is what makes being surrounded feel like your fault, which is what makes
 *  a Zombies mode addictive rather than unfair.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { PALETTE } from '@/art/palette';
import type { EnemyKind } from '@/core/types';

// ─────────────────────────────────────────────────────────────────────────────
// The rig — a bone-less hierarchy of mesh parts (ART_DIRECTION §8).
//
// Fourteen parts, indexed. The order is load-bearing: **a part's parent always has a lower
// index than the part itself**, so the whole hierarchy resolves in a single forward pass with
// no recursion and no sorting (see `body.ts::poseInto`).
// ─────────────────────────────────────────────────────────────────────────────

export const PART = {
  PELVIS: 0,
  BELLY: 1,
  CHEST: 2,
  HEAD: 3,
  JAW: 4,
  ARM_UR: 5,
  ARM_LR: 6,
  ARM_UL: 7,
  ARM_LL: 8,
  LEG_UR: 9,
  LEG_LR: 10,
  LEG_UL: 11,
  LEG_LL: 12,
  /** The asymmetry part: a hanging strip of coat / a torn-open ribcage. Never mirrored. */
  RAG: 13,
} as const;

export const PART_COUNT = 14;

/** `PART_PARENT[i]` is the index of `i`'s parent, or -1 for the root. Monotonic by construction. */
export const PART_PARENT: readonly number[] = [
  -1,            // PELVIS
  PART.PELVIS,   // BELLY
  PART.BELLY,    // CHEST
  PART.CHEST,    // HEAD
  PART.HEAD,     // JAW
  PART.CHEST,    // ARM_UR
  PART.ARM_UR,   // ARM_LR
  PART.CHEST,    // ARM_UL
  PART.ARM_UL,   // ARM_LL
  PART.PELVIS,   // LEG_UR
  PART.LEG_UR,   // LEG_LR
  PART.PELVIS,   // LEG_UL
  PART.LEG_UL,   // LEG_LR
  PART.CHEST,    // RAG
];

/** The four dismemberable limbs, in `Limb` order. */
export const LIMB = { ARM_R: 0, ARM_L: 1, LEG_R: 2, LEG_L: 3 } as const;
export const LIMB_COUNT = 4;

/** Root part of each limb — severing it collapses the part and everything under it. */
export const LIMB_ROOT: readonly number[] = [PART.ARM_UR, PART.ARM_UL, PART.LEG_UR, PART.LEG_UL];

// ─────────────────────────────────────────────────────────────────────────────
// BODY — the Shambler's proportions, in metres.
//
// Deliberately NOT human. ART §9 wants a silhouette you can name in a tenth of a second:
// heavy shoulders, a small dropped head, long hanging arms, short bent legs. Read it as a
// caricature — an inker exaggerates the read and throws away the anatomy.
// ─────────────────────────────────────────────────────────────────────────────

export const BODY = {
  /** Standing height of the *hitbox* capsule (ARCHITECTURE §5 says a zombie is ~1.85 m). */
  height: 1.84,
  /** Collision radius. Fat enough that a horde jams a 1.6 m doorway — clumping is a feature. */
  radius: 0.37,

  // ── joint positions, parent-relative, in metres ─────────────────────────────
  hipY: 0.88,
  bellyY: 0.17,
  chestY: 0.25,
  headY: 0.30,
  jawY: -0.075,
  jawZ: 0.055,
  /** Shoulder: +X is the enemy's RIGHT (forward is -Z, up is +Y). Asymmetric on purpose. */
  shoulderR: 0.255,
  shoulderL: -0.268,
  shoulderY: 0.185,
  shoulderYL: 0.215,
  elbowY: -0.315,
  hipX: 0.135,
  hipOffY: -0.055,
  kneeY: -0.435,

  /**
   * ───────────────────────────────────────────────────────────────────────────────────────
   * PART SIZES — [width, height, depth] of the chunky bevelled masses.
   *
   * **THE MINIMUM DIMENSION HERE IS A FUNCTION OF THE OUTLINE WEIGHT, NOT OF TASTE.** The
   * inverted hull inflates the silhouette along its normal by a *screen-space* amount, so at
   * `READABILITY.ENEMY_OUTLINE_PX` = 8 — the heaviest line in the game, and non-negotiable
   * (ART §9) — a part thinner than roughly twice that band has no albedo left between its two
   * inflated faces and **renders as solid ink**.
   *
   * Measured in-engine at 5.6 m, 1568×716 CSS: the first pass authored 0.11–0.13 m arms, a
   * 0.045 m coat flap and a 0.075 m brow, and every one of them came out BLACK — roughly 40%
   * of the body had lost the reserved `ACID` channel entirely, which is the one thing this
   * enemy exists to carry. Nothing on a Shambler is under ~0.13 m any more.
   *
   * The knock-on is pure upside: an inker draws a character with chunky masses precisely so
   * the bold line has somewhere to sit. Thin limbs and a bold line are incompatible, and it is
   * the LINE that is the art direction.
   * ───────────────────────────────────────────────────────────────────────────────────────
   */
  pelvis: [0.42, 0.26, 0.29] as const,
  belly: [0.43, 0.31, 0.31] as const,
  chest: [0.56, 0.38, 0.33] as const,
  head: [0.27, 0.30, 0.29] as const,
  brow: [0.29, 0.115, 0.16] as const,
  jaw: [0.21, 0.135, 0.22] as const,
  upperArm: [0.185, 0.345, 0.195] as const,
  lowerArm: [0.16, 0.335, 0.17] as const,
  hand: [0.185, 0.195, 0.165] as const,
  thigh: [0.225, 0.455, 0.235] as const,
  shin: [0.19, 0.415, 0.20] as const,
  foot: [0.21, 0.14, 0.31] as const,

  /** Bevel as a fraction of the smallest dimension. The bevel IS the ink line (shapes.ts §1). */
  bevel: 0.20,
  /** Hand-drawn silhouette wobble, metres. Small — it must not fight the animation. */
  jitter: 0.008,

  /**
   * Painted vertex AO (ART §2.5 — "ambient occlusion is painted, not computed"). Every part
   * darkens toward the joint it hangs from, which is what stops fourteen flat masses reading
   * as fourteen flat masses. Fed to `InkMaterial`'s `uVertexAo`; the shader multiplies the KEY
   * term by it, so it deepens the cel break without touching the reserved ACID hue.
   */
  aoMin: 0.58,
  aoStrength: 0.34,
} as const;

/**
 * THREE SILHOUETTES. Per-instance matrix variation (see `body.ts::seedVariation`) makes no two
 * zombies twins, but it cannot change the *shape language* — so there are three authored body
 * types and the pool cycles them. All three share one geometry pipeline, so a variant costs one
 * extra buffer and ZERO extra draw calls.
 *
 * `limb`/`torso`/`head` scale the built geometry; `reach` and `stoop` move the joints.
 */
export interface BodyVariant {
  id: string;
  torso: number;
  limb: number;
  head: number;
  /** Arm length multiplier — the "reacher" reads completely differently in silhouette. */
  reach: number;
  /** Forward hunch, radians, baked into the rest pose. */
  stoop: number;
  /** Overall height multiplier. */
  scale: number;
}

/**
 * A bold line erases interior detail — that is what a bold line is FOR — so the only thing a
 * variant can actually change is the OUTER SILHOUETTE. These three are therefore pushed to
 * caricature rather than nudged: at a glance across a plaza you should be able to say "the tall
 * one", "the fat one" and "the broken one" without seeing a single feature.
 */
export const VARIANTS: readonly BodyVariant[] = [
  /** GAUNT — tall, narrow, arms past the knee, head down. Reads as a scarecrow. */
  { id: 'gaunt', torso: 0.82, limb: 0.86, head: 0.90, reach: 1.24, stoop: 0.42, scale: 1.09 },
  /** BLOATED — squat, wide belly, huge head, stubby arms. Reads as a barrel. */
  { id: 'bloated', torso: 1.28, limb: 1.16, head: 1.20, reach: 0.82, stoop: 0.26, scale: 0.90 },
  /** TWISTED — one shoulder wrenched up, folded almost double. Reads as broken. */
  { id: 'twisted', torso: 1.02, limb: 0.94, head: 1.00, reach: 1.06, stoop: 0.66, scale: 1.02 },
];

// ─────────────────────────────────────────────────────────────────────────────
// HITBOXES — six primitives, welded to the animated rig.
//
// The head is a SPHERE and it is deliberately a hair larger than the drawn head. A crit that
// feels like it should have landed and didn't is the single most frustrating thing a shooter
// can do; the head being slightly generous costs nothing and is what makes the slide-into-
// headshot in the milestone brief repeatable rather than lucky.
// ─────────────────────────────────────────────────────────────────────────────

export const HITBOX = {
  /** Drawn head is 0.235 m across; the sphere is 0.43 m across. Forgiving, by design. */
  headRadius: 0.215,
  /** Where the head sphere sits, in HEAD-part local space. */
  headCenterY: 0.115,
  torsoRadius: 0.325,
  /** Capsule from the pelvis joint up to here in CHEST local space. */
  torsoTopY: 0.26,
  /**
   * PART PRIORITY, NOT NEAREST-SURFACE. The six primitives overlap on purpose — a torso capsule
   * that stops short of the shoulders leaves a dead zone, and arms hanging forward genuinely
   * sit between the muzzle and the chest. Resolving by nearest surface therefore measured
   * *aiming at the head and scoring a torso hit* (the torso cap sphere bulges past the neck)
   * and *aiming at the chest and scoring a limb hit* (the reaching arm was in the way).
   *
   * So the resolution is head → torso → limb, and a limb only ever scores when the trace missed
   * both of the others. Which is also the right game: a limb never shields a body shot, and
   * dismemberment costs you a deliberate shot at a limb that is clear of the silhouette.
   */
  priority: ['head', 'torso', 'limb'] as const,
  armRadius: 0.125,
  legRadius: 0.145,
  /**
   * Broad-phase sphere, centred at `position.y + height * broadCenter`. Every bullet trace
   * rejects 25 enemies with 25 ray/sphere tests before it touches a capsule.
   */
  broadRadius: 1.24,
  broadCenter: 0.55,
} as const;

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE INK WEIGHT, AND THE ONE PLACE IT IS ALLOWED TO BEND.
 *
 * `READABILITY.ENEMY_OUTLINE_PX` = 8 is the heaviest line in the game and it is a contract
 * (ART §9). But a screen-space line does not shrink with distance while the character does, so
 * at the far end of one of the arena's 140 m sightlines an 8 px band on each side consumes a
 * body that is only ~20 px tall — and the enemy stops being ACID and becomes a black blob.
 * That trades one half of §9 (the reserved HUE) away to buy the other half (the reserved INK),
 * which is not a trade §9 offers.
 *
 * So the line holds its full weight out to `outlineFullRange` and then tapers, never below
 * `outlineMinPx` — which is still above the arena's own `mass` line at the same distance, so
 * the enemy keeps the heaviest ink in frame at every range. Measured on the shipped arena: at
 * 8 m the horde's green dominance is 0.223 against an environment peak of −0.029, and the
 * taper is what keeps a body at 45 m green instead of solid ink.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
export const OUTLINE = {
  /** Metres. Inside this the line is the full `READABILITY.ENEMY_OUTLINE_PX`. */
  fullRange: 15,
  /** Never thinner than this, at any distance. Still the boldest line in the frame. */
  minPx: 3.6,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATION — jerky and DRAWN (ART §8), never smooth.
// ─────────────────────────────────────────────────────────────────────────────

export const ANIM = {
  /**
   * ON TWELVES. The pose is sampled on a 12 Hz stepped clock, so a pose is HELD for five
   * frames at 60 fps and then jumps. This is the single most important number in the file:
   * lerping between poses reads as interpolation, holding then snapping reads as *animation*.
   * 12 also matches the ink boil (`BOIL_HZ` in render/materials) and the sky's cloud drift —
   * a body that steps on twelves next to a line that boils on twelves reads as one drawing.
   */
  poseFps: 12,
  /**
   * Every instance gets a phase offset on that clock so twenty-five zombies do not all pop on
   * the same frame — which would read as the whole screen stuttering, not as animation.
   */
  poseOffsetSpread: 1,

  /** One full gait cycle per this many metres travelled. Longer = a heavier, slower lurch. */
  strideMetres: 1.15,
  /** Cycles per second when standing still (the idle sway still breathes). */
  idleStrideHz: 0.30,

  // ── pelvis / spine ─────────────────────────────────────────────────────────
  hipRoll: 0.155,
  hipTwist: 0.175,
  /** The pelvis drops on every foot-plant. This is the weight. */
  bobDown: 0.062,
  /** Extra hunch on top of the variant's baked stoop. */
  hunch: 0.16,
  spineTwist: 0.24,

  /** Squash & stretch on the torso, as a fraction. Two per gait cycle, off-beat with the hips. */
  squash: 0.105,

  // ── limbs ──────────────────────────────────────────────────────────────────
  thighSwing: 0.66,
  kneeBend: 0.92,
  /** The DRAG. One leg (chosen per instance) swings this much less and stays bent. */
  dragLeg: 0.42,
  /**
   * THE DEAD ARM. Same idea one storey up, and it is the single most legible piece of
   * per-instance silhouette: one arm (chosen per instance, and 12–30% longer than the other)
   * barely swings and hangs off the shoulder. With 25 alive the review read the horde as
   * "identical hazmat workers"; a crowd where every other body has a different limb hanging
   * wrong is a crowd you can track individual members of while kiting, which is a GAMEPLAY
   * property, not only a drawing one.
   */
  dragArm: 0.30,
  armSwing: 0.40,
  /**
   * OFF-BEAT LIMB TIMING (ART §8). Arms lag the legs by 0.37 of a cycle — not 0.5, which is
   * what a human does and what reads as "walking". 0.37 reads as *wrong*, and wrong is the
   * entire brief for a zombie.
   */
  armLag: 0.37,
  /** Left/right phase asymmetry. 0.5 is a clean walk; 0.58 is a limp. */
  limpAsym: 0.08,
  /** Resting arm droop and the reach the horde does at close range. */
  armDroop: 0.34,
  /** Arms hang forward even at range — you should be able to read "reaching" from 30 m. */
  armIdleForward: 0.42,
  armReach: 0.95,
  armReachRange: 7.0,

  // ── head ───────────────────────────────────────────────────────────────────
  headLoll: 0.15,
  headNod: 0.11,
  jawOpen: 0.42,

  // ── attack ─────────────────────────────────────────────────────────────────
  /**
   * SIGN CONVENTION for every torso value below: a part above its own joint rotates BACKWARD
   * for a positive `rx` (rotation about +X takes +Y toward +Z, and -Z is forward). So a
   * positive lean arches the chest back and a negative one pitches it forward. A part BELOW
   * its joint — every limb — is the mirror: positive `rx` swings the hand or foot forward.
   *
   * Wind-up: torso arches BACK, both arms rise back and up. Big, slow, unmistakable (M2 §2).
   */
  windupLean: 0.42,
  windupArm: -1.05,
  windupJaw: 1.0,
  /** Strike: fast forward swing. Held pose, then this in `strikeTime` seconds. */
  strikeArm: 1.85,
  strikeLean: -0.62,
  strikeLunge: 0.24,
  strikeTime: 0.12,
  /** Fraction of the wind-up spent held perfectly still before the arms finish rising. */
  windupHold: 0.42,

  // ── the climb (BUILD 005) ──────────────────────────────────────────────────
  //
  // THE HORROR BEAT, NOT A PARKOUR MOVE. A shambler that vaults a container in 0.4 s is a
  // sprinter with extra steps and it deletes the whole reason to hold high ground. The climb is
  // therefore authored as the slowest thing in the enemy's whole vocabulary: it plants both
  // hands on the lip, HOLDS (`climbHold` of the duration, on the 12 Hz clock, so it is a real
  // held drawing), then hauls. `NAV.climbBase/climbPerMetre` say how long that takes; these say
  // what it looks like.

  /** Fraction of the climb spent hanging on the lip before the haul starts. The tell. */
  climbHold: 0.34,
  /** Both arms rotate to here at the reach. Negative = up and back (see the sign convention). */
  climbArmUp: -2.35,
  /** …and the elbows fold to here as the body is dragged over the lip. */
  climbElbow: 1.15,
  /** Torso pitch at the top of the haul: folded forward over the ledge. */
  climbFold: -0.95,
  /** Knee drive as the leading leg is thrown onto the ledge. */
  climbKnee: 1.55,
  /** How far the pelvis is dragged toward the wall through the haul, metres. */
  climbPull: 0.22,
  /** Sideways sway of the hanging body, radians. Dead weight on two arms. */
  climbSway: 0.14,

  // ── spawn / death ──────────────────────────────────────────────────────────
  /** Comic pop-in: squashed, overshoot, settle. */
  spawnTime: 0.34,
  spawnSquash: 0.55,
  spawnOvershoot: 1.22,
  /**
   * THE IMPACT FRAME. On death the body snaps to one dramatic blown-back pose and holds it,
   * frozen, for this long — then it is gone and `VfxService.panelShatter` owns the moment.
   * A corpse that ragdolls is a different game; a corpse that holds one drawn pose for two
   * frames and then explodes into panel shards is this one.
   */
  deathHold: 0.11,
  deathArch: 0.85,
  deathArmFling: 1.4,

  // ── hit reaction springs ───────────────────────────────────────────────────
  //
  // AUTHORED IN PEAK RADIANS, NOT IN SPRING VELOCITY. `Spring.impulse()` takes a velocity and
  // the resulting peak displacement is `v / (2π·frequency)` — so a "1.0 impulse" on a 6.5 Hz
  // spring peaks at 0.025 rad, i.e. one and a half degrees, i.e. invisible. The first pass
  // authored exactly that and measured a 0.003 rad lean off a 20-damage hit: a zombie that
  // absorbed a bullet without visibly reacting, which the milestone brief calls a bug by name.
  // `reactions.ts` now converts peak → impulse, and every number below is a real rotation you
  // can picture.

  /** Body-lean spring: bouncy, so a flinch overshoots and comes back (ART §8). */
  flinchFreq: 6.5,
  flinchDamping: 0.42,
  /** Multiplier from the spring's value to radians at the pelvis. Parts scale off this. */
  flinchLean: 1.0,
  /** PEAK LEAN, radians, per point of damage. 20 damage → 0.20 rad ≈ 11°, and you see it. */
  flinchPeakPerDamage: 0.0105,
  /** Floor: even a 1-damage graze rocks the body ~6°. "Did it react" is read before "did it hurt". */
  flinchPeakMin: 0.105,
  /** Ceiling, so a 400-damage shotgun does not spin a body inside out. */
  flinchPeakMax: 0.58,
  /** A headshot flinch is worth this many times a body flinch. Heads snap. */
  flinchHeadMult: 1.9,
  /** A flinch peaking above this cancels a committed melee swing. ~15°. */
  flinchInterrupt: 0.26,
  /** High-frequency shudder layered on top of the lean — the "ink vibrating" tell (ART §9). */
  shudderFreq: 19,
  shudderDamping: 0.26,
  /** Peak of the shudder spring's own value, before `shudderAmp` scales it into radians. */
  shudderPeak: 1.0,
  shudderAmp: 0.085,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// The kind table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `climb` is BUILD 005's addition and it is a first-class state, not a flag on `chase`: while a
 * body is hauling itself over a ledge it is not steering, not colliding, not following the
 * ground and not able to swing. Everything about it is exceptional, so it gets its own case
 * rather than five `if (climbing)` guards scattered through the step.
 */
export type EnemyStateName = 'spawn' | 'chase' | 'attack' | 'stagger' | 'death' | 'climb';

export interface EnemyDef {
  kind: EnemyKind;
  name: string;
  /** Base health at round 1, before the director's `hpScale`. */
  health: number;
  /** Chase speed, m/s, before the director's `speedScale` and per-instance jitter. */
  speed: number;
  /** ± fraction of per-instance speed variation. This is what strings a horde into a line. */
  speedJitter: number;
  /** Multiplier applied while closing the last few metres — the "it noticed you" beat. */
  lungeMult: number;
  /** Fraction of chase speed retained during a melee wind-up. Low = you can walk out of it. */
  windupSpeedMult: number;
  /** Melee damage. `tuning.ENEMY.meleeDamage` is the shared default; a kind may override. */
  meleeDamage: number;
  /** Health of one limb. Take this much damage in a limb and it comes off (comic clean cut). */
  limbHealth: number;
  /** Losing a leg costs this much speed; losing both arms disables the melee entirely. */
  oneLegSpeedMult: number;
  /** Knockback resistance. 1 = light, 3 = a Brute you cannot push. */
  mass: number;
  /** Body hue. RESERVED (ART §9) — `ACID` for flesh, `HOT` for a special. Nothing else, ever. */
  hue: number;
  /** Rim/outline presence multiplier. 1 = standard, 1.3 = "readable across the whole arena". */
  presence: number;
  /** Seconds between idle groans, min/max. Spatialised by the audio system off `fx:sound`. */
  groanInterval: readonly [number, number];
}

export const SHAMBLER: EnemyDef = {
  kind: 'shambler',
  name: 'SHAMBLER',
  /**
   * 150. Four body shots or two headshots from the `inkslinger` at 40 damage / 2.5× crit.
   * Low enough that round 1 is a power fantasy, and the director scales it, not this file.
   */
  health: 150,
  /** 1.62 m/s — 30% of the player's walk. See the kite table in the file header. */
  speed: 1.62,
  speedJitter: 0.16,
  lungeMult: 1.58,
  windupSpeedMult: 0.22,
  meleeDamage: 28,
  limbHealth: 52,
  oneLegSpeedMult: 0.62,
  mass: 1,
  hue: PALETTE.ACID,
  presence: 1,
  groanInterval: [3.2, 7.5],
};

/**
 * M2 ships ONE enemy (M2_VERTICAL_SLICE §2). The other four kinds exist in `EnemyKind` because
 * the contract is frozen; asking for one here returns a Shambler with the obvious stat move so
 * the M3 director can be written against the real API today and the M4 enemy agent can drop in
 * a real body without touching a single call site.
 */
export const ENEMY_DEFS: Readonly<Record<EnemyKind, EnemyDef>> = {
  shambler: SHAMBLER,
  sprinter: { ...SHAMBLER, kind: 'sprinter', name: 'SPRINTER', health: 85, speed: 3.6, lungeMult: 1.9, mass: 0.7 },
  brute: { ...SHAMBLER, kind: 'brute', name: 'BRUTE', health: 620, speed: 1.18, limbHealth: 160, mass: 3, presence: 1.25 },
  spitter: { ...SHAMBLER, kind: 'spitter', name: 'SPITTER', health: 120, speed: 1.4, hue: PALETTE.HOT },
  screamer: { ...SHAMBLER, kind: 'screamer', name: 'SCREAMER', health: 95, speed: 2.1, hue: PALETTE.HOT },
};

export function defFor(kind: EnemyKind): EnemyDef {
  return ENEMY_DEFS[kind] ?? SHAMBLER;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool sizing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POOL EVERYTHING, PRE-ALLOCATE THE MAXIMUM (ARCHITECTURE §4). Every body, material, hull and
 * matrix a run will ever need is built during `init`, before the first frame. Nothing in this
 * subsystem constructs a THREE object after boot, so spawning a zombie mid-fight cannot hitch.
 *
 * `tuning.ENEMY.maxAlive` is 28; the pool carries a couple of spare slots so a `spawn()` racing
 * a `killAll()` never starves.
 */
export const POOL = {
  /** Hard cap on bodies built at boot. Must be ≥ `tuning.ENEMY.maxAlive`. */
  capacity: 32,
  /** Ring of `EnemyHit` records handed back by `raycast()`. Valid for the next N-1 calls. */
  hitRing: 16,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// AI scheduling — the reason 25 zombies cost ~0.3 ms of sim instead of 6 ms.
// ─────────────────────────────────────────────────────────────────────────────

export const SCHED = {
  /**
   * `WorldService.steer()` casts SEVEN rays. Running it for 25 zombies at the 120 Hz fixed rate
   * would be 21 000 octree raycasts per second, which is most of a frame budget spent deciding
   * things that do not change that fast. Each enemy re-decides its heading at ~10 Hz instead,
   * round-robin across fixed steps, and integrates that heading every step — so movement is
   * perfectly smooth and only the *decision* is staggered.
   */
  steerHz: 10,
  /** Ground probe rate. A shambler at 1.6 m/s moves 8 cm between samples. */
  groundHz: 12,
  /** Hard capsule-vs-world correction rate. Steering already avoids walls; this is the backstop. */
  collideHz: 24,
  /** Vertical fall / climb rate limits, m/s, for the ground follower. */
  fallSpeed: 14,
  climbSpeed: 3.2,
  /**
   * CONGA LINE. A neighbour this well-aligned between me and the player is not something to
   * push away from — it is someone to queue behind. Separation is scaled down by
   * `congaRelief` for those, which is precisely what turns a blob into the trainable snake
   * the whole kiting skill is built on (GAME_BIBLE §4).
   */
  congaCos: 0.72,
  congaRelief: 0.28,
  /** Neighbours further than this are ignored by separation entirely. */
  neighbourRadius: 2.6,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION — the feel half of `world/nav.ts`.
//
// `world/nav.ts` owns the GEOMETRY constants (lattice pitch, what counts as a ledge, what
// counts as a ramp) because those describe the arena. Everything below is about the HORDE:
// when it consults the graph at all, how it moves along it, and how long a climb takes. It
// lives in `defs.ts` beside `SCHED` for the same reason `SCHED` does — `world/` may not import
// `game/`, and these are enemy-behaviour numbers, not world numbers.
// ─────────────────────────────────────────────────────────────────────────────

export const NAV = {
  /**
   * THE ONE DECISION THAT PROTECTS KITING.
   *
   * The graph is for ROUTE CHOICE, never for locomotion. An agent only consults it when direct
   * steering provably cannot work — when the player is more than this far above or below it —
   * or when it has been physically wedged. On flat ground, chasing a player on flat ground,
   * BUILD 004's steering runs completely untouched, which is what keeps the horde a clumping,
   * grindable, trainable fluid (GAME_BIBLE §4) instead of 25 agents on a rail.
   *
   * 1.25 m: taller than every kerb, dais step and dock lip in the arena, shorter than one
   * storey, so standing on the monument's second step does not put the horde on rails.
   */
  heightTrigger: 1.25,
  /** Below this the agent drops straight back to pure steering. Hysteresis, so it cannot chatter. */
  heightRelease: 0.85,
  /** Minimum seconds an agent stays in graph mode once it enters. */
  holdTime: 1.4,
  /**
   * A body leaves graph mode only when the graph route is no longer than
   * `distToPlayer × navCostSlack + navCostBias` — i.e. when walking straight at the player IS
   * the route. Height alone was not enough: at the top of a flight you are level with the
   * player and still sixteen metres of stringer away from them.
   */
  navCostSlack: 1.06,
  navCostBias: 1.2,

  /**
   * Seconds between complete flow-field sweeps while anything is asking for one. The player
   * moves ~5.4 m/s and a shambler ~1.6 m/s, so a 0.8 s old field is at most one node stale on
   * the goal end — and the goal end is the end the agent is nowhere near.
   */
  repathTime: 0.8,

  /**
   * STRING-PULLING. Steering at the very next node makes a body walk the lattice diagonals,
   * which reads as a robot on graph paper. It aims at the node one further along whenever that
   * one is on the same level and within this many metres, so the line through open ground is
   * straight and only tightens up where the route actually turns.
   */
  lookAheadRange: 7.0,
  /** …and only when the further node is within this much of the nearer one's height. */
  lookAheadRise: 0.5,

  /**
   * How hard a routed body is pulled back onto the centre of the surface it is walking on,
   * as a fraction of its lateral offset. 0 is BUILD 004 (aim at the node, drift off the edge);
   * 1 aims a full offset-width past the node and reads as a body sidling. 0.8 keeps a shambler
   * on the spine of a 2.2 m staircase without visibly straightening the horde on open ground,
   * where the offset — and therefore this whole term — is already near zero.
   */
  corridorPull: 0.8,

  /**
   * Rise an agent absorbs by walking, metres. MUST match `world/nav.ts` STEP_UP — it is also
   * the height the hard capsule correction is lifted by, which is what actually lets a body
   * walk onto a kerb, a dais step or a 0.4 m lip instead of being pushed off it forever.
   */
  stepUp: 0.45,
  /**
   * Tallest ledge a body may mantle, metres. MUST match `world/nav.ts` CLIMB_MAX — see the long
   * note there. 3.45 as of BUILD 006: 2.9 left the loading-dock canopy permanently unreachable
   * (0 of 15 arrivals in 150 s, 0 attacks) and 3.05 only opened it from some approaches.
   */
  climbMax: 3.45,

  /** Seconds of climb, before the per-metre term. */
  climbBase: 0.80,
  /** …plus this per metre of ledge: 0.45 m → 1.05 s, 1.2 m → 1.46 s, 2.6 m → 2.24 s. */
  climbPerMetre: 0.55,
  /**
   * How close (metres, XZ) to the destination NODE an agent must be before it commits to a
   * mantle. Must be at least a full lattice diagonal (`world/nav.ts` CELL × √2 ≈ 2.48): the
   * ledge stands between the two ends of a climb link, so a body can never get closer to the
   * far node than one cell, and a tighter radius means it never climbs at all.
   */
  climbReach: 2.6,
  /** Cooldown after a climb so a body that lands badly cannot re-enter it every step. */
  climbCooldown: 0.6,

  /**
   * SHOOT THEM OFF THE LEDGE. The mantle is sold as "the moment you can punish them", and until
   * BUILD 006 it was the one moment you could not: `state === 'climb'` skipped the whole velocity
   * and knockback branch, so `e.push` was neither applied nor decayed. MEASURED: five crit hits
   * at knockback 40 on a body 0.31 s into a mantle left `push` at (7.00, 0, 0) and moved the body
   * 0.000 m; 95 hits across a climb saturated `push` and then dumped it in one lump on plant,
   * shoving the body 0.37 m and off the container two seconds after the shots that did it.
   *
   * Now the climb carries and decays `push` like every other state, and this much accumulated
   * knockback impulse (m/s) tears the body off the wall. At `knockbackPerDamage` 0.035 and mass
   * 1, that is one 85-damage headshot, or three body hits inside the decay window — the ledge is
   * a real window of vulnerability rather than a cutscene.
   */
  climbBreakImpulse: 2.6,

  /**
   * THE OPPORTUNIST MANTLE. Independent of the graph: any wedged body probes straight ahead for
   * a ledge before it takes a tangential detour. This is what makes the monument dais, a loading
   * dock and every 1.2 m lip in the arena work without depending on lattice resolution.
   */
  probeAhead: 0.95,
  /** How steep a face has to be for the forward probe to call it a ledge rather than a slope. */
  probeWallNormalY: 0.55,

  /** How far the "is my route's first step actually in front of me" ray looks, metres. */
  sightProbe: 3.0,
  /**
   * How much of a full wedge a blocked route step is worth. Two blocked steer slices trip the
   * unstick, four re-place the body — which is the right answer for a route that leads through
   * a fence, and unreachable for a body that is merely brushing a corner.
   */
  blockedWedgeShare: 0.5,
} as const;

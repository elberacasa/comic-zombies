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
// THE SKELETON (BUILD 007 — replaces the bone-less mesh hierarchy)
//
// ═══════════════════════════════════════════════════════════════════════════════════════════
//  WHY THIS CHANGED, AND WHAT IT COST.
//
//  BUILD 006's Shambler was fourteen bevelled boxes parented to each other and posed as rigid
//  bodies — ART §8's literal "bone-less: hierarchical mesh groups". Rigid parts have one
//  failure mode and it is structural, not cosmetic: **a rigid part rotates about a point on
//  its own surface**, so every joint either opens a wedge-shaped hole on the outside of the
//  bend or drives one box through another on the inside. A 90° elbow on a 0.16 m arm opens a
//  gap of roughly 0.5 × 0.16 × √2 ≈ 0.11 m — two thirds of the limb's own width. Under the 8 px
//  enemy ink line that hole is inked on BOTH sides, so the arm reads as two separate objects,
//  and the silhouette — the one thing ART §9 makes a gameplay contract — comes apart exactly
//  when the body is doing something worth looking at.
//
//  The fix is the thing rigid parts are an approximation of: linear blend skinning. One
//  continuous surface, every vertex influenced by up to four bones, weights solved from
//  distance to the bone SEGMENT (see `rig.ts::solveSkin`). A bend now redistributes the surface
//  instead of tearing it, and the silhouette stays closed at any angle.
//
//  WHAT DID NOT CHANGE, deliberately:
//   • the TIMING. Skinning changes deformation, not animation language. The pose is still
//     sampled on the 12 Hz stepped clock (`ANIM.poseFps`), still held for ~5 frames at 60 fps,
//     still off-beat between limbs (`ANIM.armLag` 0.37, `ANIM.limpAsym`). Smooth deformation
//     with jerky timing is the target; smooth deformation with smooth timing is a different,
//     much worse game.
//   • the DRAW CALL COUNT. Still one body mesh + one inverted hull per zombie, still ONE shared
//     geometry for the whole horde. The bone palette is a per-instance uniform, not a scene
//     graph — see the long note at the top of `rig.ts` for why this is not `THREE.SkinnedMesh`.
//
//  ORDER IS LOAD-BEARING: **a bone's parent always has a lower index than the bone itself**, so
//  the hierarchy resolves in one forward pass with no recursion and no sorting.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export const BONE = {
  HIPS: 0,
  SPINE: 1,
  CHEST: 2,
  /** The neck is a BONE, not a gap. See `SURFACE` — it is the whole headshot read. */
  NECK: 3,
  HEAD: 4,
  JAW: 5,
  CLAV_R: 6,
  ARM_R: 7,
  FORE_R: 8,
  HAND_R: 9,
  CLAV_L: 10,
  ARM_L: 11,
  FORE_L: 12,
  HAND_L: 13,
  THIGH_R: 14,
  SHIN_R: 15,
  FOOT_R: 16,
  THIGH_L: 17,
  SHIN_L: 18,
  FOOT_L: 19,
  /** The asymmetry bone: a hanging strip of coat off one shoulder blade. Never mirrored. */
  RAG: 20,
} as const;

export const BONE_COUNT = 21;

/** `BONE_PARENT[i]` is the index of `i`'s parent, or -1 for the root. Monotonic by construction. */
export const BONE_PARENT: readonly number[] = [
  -1,            // HIPS
  BONE.HIPS,     // SPINE
  BONE.SPINE,    // CHEST
  BONE.CHEST,    // NECK
  BONE.NECK,     // HEAD
  BONE.HEAD,     // JAW
  BONE.CHEST,    // CLAV_R
  BONE.CLAV_R,   // ARM_R
  BONE.ARM_R,    // FORE_R
  BONE.FORE_R,   // HAND_R
  BONE.CHEST,    // CLAV_L
  BONE.CLAV_L,   // ARM_L
  BONE.ARM_L,    // FORE_L
  BONE.FORE_L,   // HAND_L
  BONE.HIPS,     // THIGH_R
  BONE.THIGH_R,  // SHIN_R
  BONE.SHIN_R,   // FOOT_R
  BONE.HIPS,     // THIGH_L
  BONE.THIGH_L,  // SHIN_L
  BONE.SHIN_L,   // FOOT_L
  BONE.CHEST,    // RAG
];

/** Debug / tooling only. Never branch on a name. */
export const BONE_NAME: readonly string[] = [
  'hips', 'spine', 'chest', 'neck', 'head', 'jaw',
  'clav_r', 'arm_r', 'fore_r', 'hand_r',
  'clav_l', 'arm_l', 'fore_l', 'hand_l',
  'thigh_r', 'shin_r', 'foot_r',
  'thigh_l', 'shin_l', 'foot_l',
  'rag',
];

/**
 * LEGACY ALIAS. `game/enemies/index.ts` re-exports `PART` and is not this agent's file to edit,
 * so the fourteen old names keep resolving — to the equivalent BONE index. New code uses `BONE`.
 *
 * @deprecated Use `BONE`.
 */
export const PART = {
  PELVIS: BONE.HIPS,
  BELLY: BONE.SPINE,
  CHEST: BONE.CHEST,
  HEAD: BONE.HEAD,
  JAW: BONE.JAW,
  ARM_UR: BONE.ARM_R,
  ARM_LR: BONE.FORE_R,
  ARM_UL: BONE.ARM_L,
  ARM_LL: BONE.FORE_L,
  LEG_UR: BONE.THIGH_R,
  LEG_LR: BONE.SHIN_R,
  LEG_UL: BONE.THIGH_L,
  LEG_LL: BONE.SHIN_L,
  RAG: BONE.RAG,
} as const;

/** The four dismemberable limbs, in `Limb` order. */
export const LIMB = { ARM_R: 0, ARM_L: 1, LEG_R: 2, LEG_L: 3 } as const;
export const LIMB_COUNT = 4;

/** Root bone of each limb — severing it collapses that bone and everything under it. */
export const LIMB_ROOT: readonly number[] = [BONE.ARM_R, BONE.ARM_L, BONE.THIGH_R, BONE.THIGH_L];
/** MID bone of each limb — the forearm / shin. */
export const LIMB_MID: readonly number[] = [BONE.FORE_R, BONE.FORE_L, BONE.SHIN_R, BONE.SHIN_L];
/** Tip bone of each limb — the hand / foot. */
export const LIMB_TIP: readonly number[] = [BONE.HAND_R, BONE.HAND_L, BONE.FOOT_R, BONE.FOOT_L];

/**
 * ═══ A LIMB IS THREE CAPSULES, ONE PER BONE ═══
 *
 * BUILD 007 gave each limb ONE capsule, shoulder joint → hand tip. A capsule is a straight tube
 * between its ends, and a limb is not straight in any pose the animator wrote, so that tube
 * both (a) left the drawing — a bullet through the empty air in front of a reaching zombie's
 * chest scored a limb hit — and (b) cut every corner, which is why **37% of the drawn shin and
 * 27% of the drawn calf registered NOTHING**: the knee→toe line skips the ankle entirely.
 *
 * One capsule per bone follows the bend. Cost is at most eight more ray/capsule tests, and only
 * on a body whose head AND torso have already been missed (`HITBOX.priority`).
 */
export const LIMB_BONES: readonly (readonly number[])[] = [
  [BONE.ARM_R, BONE.FORE_R, BONE.HAND_R],
  [BONE.ARM_L, BONE.FORE_L, BONE.HAND_L],
  [BONE.THIGH_R, BONE.SHIN_R, BONE.FOOT_R],
  [BONE.THIGH_L, BONE.SHIN_L, BONE.FOOT_L],
];
/** Hitbox capsules per limb: upper, mid, tip. */
export const LIMB_SEGMENTS = 3;
/** Total limb capsules across the body. */
export const LIMB_CAPSULES = LIMB_COUNT * LIMB_SEGMENTS;

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE BIND POSE — every bone's joint position in ENEMY-LOCAL METRES, parent-relative, with
 * identity rotation. This table is the single source of truth for:
 *
 *   • where the geometry is authored (the surface cage is drawn around these joints, in the
 *     same space — that is what "bind pose" means);
 *   • the inverse-bind matrices `rig.ts` builds once at boot;
 *   • the segments `solveSkin` measures distance to;
 *   • the hitbox capsules the combat agent reads through `EnemyBody.rig.boneSegment()`.
 *
 * Change a number here and the mesh, the skin weights AND the hitboxes all move together, which
 * is the entire point — "what you see is what you hit" stops being a promise and becomes a
 * property of the data.
 *
 * `radius` is the flesh half-width around that bone: the falloff support for the skin solve and
 * the capsule radius the combat agent gets. It is not decoration — see `BODY.minHalfWidth`.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
export interface BoneRest {
  /** Parent-relative joint offset, metres. */
  x: number;
  y: number;
  z: number;
  /** Flesh half-width around this bone, metres. */
  radius: number;
}

export const SKEL: readonly BoneRest[] = [
  /* HIPS    */ { x: 0, y: 0.900, z: 0.000, radius: 0.200 },
  /* SPINE   */ { x: 0, y: 0.150, z: 0.000, radius: 0.190 },
  /* CHEST   */ { x: 0, y: 0.185, z: -0.010, radius: 0.240 },
  /* NECK    */ { x: 0, y: 0.173, z: -0.042, radius: 0.085 },
  /* HEAD    */ { x: 0, y: 0.144, z: -0.036, radius: 0.175 },
  /* JAW     */ { x: 0, y: 0.040, z: 0.058, radius: 0.120 },
  /* CLAV_R  */ { x: 0.078, y: 0.157, z: 0.000, radius: 0.130 },
  /* ARM_R   */ { x: 0.170, y: -0.020, z: 0.000, radius: 0.118 },
  /* FORE_R  */ { x: 0, y: -0.325, z: 0.000, radius: 0.098 },
  /* HAND_R  */ { x: 0, y: -0.320, z: 0.000, radius: 0.112 },
  /* CLAV_L  */ { x: -0.078, y: 0.161, z: 0.000, radius: 0.130 },
  /* ARM_L   */ { x: -0.178, y: -0.012, z: 0.000, radius: 0.118 },
  /* FORE_L  */ { x: 0, y: -0.325, z: 0.000, radius: 0.098 },
  /* HAND_L  */ { x: 0, y: -0.320, z: 0.000, radius: 0.112 },
  /* THIGH_R */ { x: 0.132, y: -0.072, z: 0.000, radius: 0.135 },
  /* SHIN_R  */ { x: 0, y: -0.433, z: 0.005, radius: 0.105 },
  /* FOOT_R  */ { x: 0, y: -0.385, z: -0.005, radius: 0.120 },
  /* THIGH_L */ { x: -0.132, y: -0.072, z: 0.000, radius: 0.135 },
  /* SHIN_L  */ { x: 0, y: -0.433, z: 0.005, radius: 0.105 },
  /* FOOT_L  */ { x: 0, y: -0.385, z: -0.005, radius: 0.120 },
  /* RAG     */ { x: -0.170, y: -0.020, z: 0.140, radius: 0.120 },
];

/**
 * Direction and length of a LEAF bone's tail, in its own space. A leaf has no child to point
 * at, so the segment `solveSkin` and the hitbox capsules measure against would be a single
 * point — which makes a hand or a foot bind to nothing and gives it a zero-length capsule.
 */
export const BONE_TAIL: Readonly<Record<number, readonly [number, number, number]>> = {
  [BONE.HEAD]: [0, 0.300, 0.010],
  [BONE.JAW]: [0, -0.075, -0.150],
  // The hand and the foot both GREW (see `SURFACE.hand` / `SURFACE.foot`), and these tails are
  // what the skin solve binds against and what the limb hitbox capsule is measured along. Left
  // at their old lengths the new fingers and toes would hang off the end of both.
  [BONE.HAND_R]: [0, -0.245, -0.040],
  [BONE.HAND_L]: [0, -0.245, -0.040],
  [BONE.FOOT_R]: [0, -0.020, -0.235],
  [BONE.FOOT_L]: [0, -0.020, -0.235],
  [BONE.RAG]: [-0.040, -0.400, 0.030],
};

// ─────────────────────────────────────────────────────────────────────────────
// BODY — the Shambler's global proportions, in metres.
//
// Deliberately NOT human. ART §9 wants a silhouette you can name in a tenth of a second:
// heavy shoulders, a big dropped head on a thin neck, long hanging arms, short bent legs. Read
// it as a caricature — an inker exaggerates the read and throws away the anatomy.
// ─────────────────────────────────────────────────────────────────────────────

export const BODY = {
  /** Standing height of the *hitbox* capsule (ARCHITECTURE §5 says a zombie is ~1.85 m). */
  height: 1.84,
  /** Collision radius. Fat enough that a horde jams a 1.6 m doorway — clumping is a feature. */
  radius: 0.37,

  /**
   * ───────────────────────────────────────────────────────────────────────────────────────
   * **THE MINIMUM CROSS-SECTION IS A FUNCTION OF THE OUTLINE WEIGHT, NOT OF TASTE.** The
   * inverted hull inflates the silhouette along its normal by a *screen-space* amount, so at
   * `READABILITY.ENEMY_OUTLINE_PX` = 8 — the heaviest line in the game, and non-negotiable
   * (ART §9) — anything thinner than roughly twice that band has no albedo left between its two
   * inflated faces and **renders as solid ink**.
   *
   * Measured in-engine at 5.6 m, 1568×716 CSS: the first pass authored 0.11–0.13 m arms, a
   * 0.045 m coat flap and a 0.075 m brow, and every one of them came out BLACK — roughly 40%
   * of the body had lost the reserved `ACID` channel entirely, which is the one thing this
   * enemy exists to carry.
   *
   * So every `SKEL[i].radius` and every ring in `SURFACE` is checked against this floor at boot
   * — see `body.ts::assertInkFloor`, which prints the offenders rather than shrugging.
   * ───────────────────────────────────────────────────────────────────────────────────────
   */
  minHalfWidth: 0.070,
  /**
   * …and a separate, LOWER floor for a slab that is embedded in a bigger mass (the brow shelf,
   * the jaw, the feet, the coat flap). Those never present a thin isolated silhouette — only
   * the protruding lip is ever on the outline — so the empirical floor is the one BUILD 002
   * actually measured: 0.075 m came out solid black, 0.115 m did not.
   */
  minSlabDim: 0.110,

  /** Hand-drawn silhouette wobble, metres. Small — it must not fight the animation. */
  jitter: 0.006,

  /**
   * Painted vertex AO (ART §2.5 — "ambient occlusion is painted, not computed"). With ONE
   * continuous skinned surface there are no longer fourteen part boundaries to darken toward,
   * so AO is now solved as real proximity occlusion at boot (`rig.ts::solveAo`): a vertex
   * darkens by how much OTHER skeleton it is buried in. That lands it in the armpits, the
   * crotch, the neck root, under the jaw and under the coat flap — which is exactly where an
   * inker puts it — and it is what keeps a single smooth mass from reading as a smooth mass.
   *
   * Fed to `InkMaterial`'s `uVertexAo`; the shader multiplies the KEY term by it, so it deepens
   * the cel break without touching the reserved ACID hue.
   */
  aoMin: 0.52,
  aoStrength: 0.38,
  /** Metres. How far another bone reaches when it occludes a vertex. */
  aoRange: 0.30,
  /** Extra darkening painted into the eye sockets under the brow shelf. 0 = off. */
  aoSocket: 0.30,
} as const;

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE SURFACE — the cage `body.ts` lofts, authored in the SAME enemy-local bind space as
 * `SKEL`. Each entry is a chain of cross-sections: `y` up the body, `u` half-width (side),
 * `v` half-depth (front/back), `round` 0 = a hard chamfered slab, 1 = a true ellipse.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *  **THE HEAD IS THE PRODUCT.** The human asked for a head they can line up and stack
 *  headshots on while training a horde, and BUILD 006 could not deliver one for a reason
 *  that is measurable rather than aesthetic:
 *
 *      BUILD 006      drawn skull 0.27 m across · hitbox sphere 0.43 m across  → 59% larger
 *      BUILD 007      drawn skull 0.35 m across · hitbox sphere 0.37 m across  →  6% larger
 *
 *  A hitbox 59% wider than the thing you are aiming at cannot be learned. You score crits you
 *  did not aim for and miss ones you did, and the only conclusion available to the player is
 *  "headshots are random" — which is what "headshots aren't that pleasant" means. The sphere
 *  is now the drawn skull, plus a hair. It is 26% smaller in cross-section than BUILD 006's,
 *  and that is the intended trade: a smaller box you can SEE beats a larger one you cannot.
 *
 *  Three things make it readable at 25 m and while strafing:
 *   1. SIZE — 0.35 m across against a 0.556 m chest. The head is 63% of the torso's width.
 *   2. A NECK — a real 0.15 m column, ~0.11 m of it bare between the trapezius and the skull
 *      base, carrying the deepest painted AO on the body. The silhouette has a waist.
 *   3. THRUST — the head bone sits 0.088 m FORWARD of the chest and `ANIM.headThrust` pitches
 *      the neck further, so from any 3/4 angle the skull clears the shoulder mass instead of
 *      being fused into it. That is what makes it a target rather than a bump.
 * ═══════════════════════════════════════════════════════════════════════════════════════
 */
export interface SurfaceRing {
  x?: number;
  y: number;
  z?: number;
  u: number;
  v: number;
  round?: number;
}

export const SURFACE = {
  /** Ring resolution. Facets are a feature (shapes.ts §1) — these are deliberately low. */
  torsoSegments: 14,
  headSegments: 14,
  limbSegments: 10,
  slabSegments: 8,

  /** Hips → belly → chest → trapezius → neck. ONE chain, so the neck can never gap. */
  torso: [
    { y: 0.760, z: 0.005, u: 0.170, v: 0.140, round: 0.35 },
    { y: 0.870, z: 0.000, u: 0.212, v: 0.162, round: 0.30 },
    { y: 0.975, z: 0.000, u: 0.196, v: 0.156, round: 0.30 },
    { y: 1.085, z: -0.004, u: 0.216, v: 0.182, round: 0.25 },
    { y: 1.185, z: -0.008, u: 0.248, v: 0.180, round: 0.25 },
    { y: 1.275, z: -0.012, u: 0.278, v: 0.176, round: 0.25 },
    { y: 1.355, z: -0.024, u: 0.268, v: 0.163, round: 0.30 },
    { y: 1.408, z: -0.038, u: 0.185, v: 0.128, round: 0.40 },
    { y: 1.448, z: -0.052, u: 0.086, v: 0.088, round: 0.70 },
    { y: 1.520, z: -0.070, u: 0.075, v: 0.080, round: 0.80 },
  ] as readonly SurfaceRing[],

  /** The skull. Starts BURIED in the neck so head rotation bends the column, never breaks it. */
  //
  // THE DEPTH IS CAPPED BY THE HITBOX, NOT BY ANATOMY. A skull is deeper than it is wide, and
  // the first pass authored it that way (0.380 m deep against 0.350 m across). Measured from
  // eight azimuths (`tools/zombie.mjs hitbox`), that cost 24 points of coverage the moment the
  // player was beside the zombie rather than in front of it: 93.7% of the drawn head inside the
  // hitbox disc head-on, **69.4% from the side, with 69 mm of head hanging outside the sphere**.
  // Strafing past a train is exactly when you take these shots. The skull is now near-isotropic
  // (0.356 × 0.340 × 0.323 m) so one sphere can be honest from every angle.
  head: [
    { y: 1.480, z: -0.062, u: 0.070, v: 0.070, round: 0.70 },
    { y: 1.545, z: -0.078, u: 0.128, v: 0.134, round: 0.55 },
    { y: 1.610, z: -0.086, u: 0.172, v: 0.168, round: 0.40 },
    { y: 1.690, z: -0.082, u: 0.178, v: 0.170, round: 0.40 },
    { y: 1.770, z: -0.074, u: 0.152, v: 0.143, round: 0.50 },
    { y: 1.835, z: -0.068, u: 0.094, v: 0.088, round: 0.70 },
  ] as readonly SurfaceRing[],

  /** The brow shelf. A hard slab across the front — it is what makes a FACE read at 30 m. */
  brow: { x: 0, y: 1.630, z: -0.208, w: 0.330, h: 0.112, d: 0.150 },
  /** The slack jaw, hung off `BONE.JAW`. Most of the silhouette's "wrongness". */
  jaw: { x: 0, y: 1.522, z: -0.178, w: 0.252, h: 0.140, d: 0.300 },

  /**
   * One arm, authored on the RIGHT (+X). The left is re-authored, not mirrored, so the two are
   * not one drawing printed twice. Root ring sits INSIDE the chest — the shoulder-seam fix.
   */
  //
  // ─── LANDMARKS, NOT A TAPER ───────────────────────────────────────────────────────────────
  // Every ring below used to fall monotonically from 0.124 at the shoulder to 0.084 at the
  // wrist. A monotonically tapering tube is the definition of the note the human wrote — "not
  // blobs, but bodies" — because a taper has no ANATOMY in it: nothing tells you where the arm
  // bends until it bends, and a limb whose joint you cannot locate reads as a sock.
  //
  // The joints are not guesses. Walking `SKEL` from HIPS gives shoulder y 1.372, ELBOW 1.047,
  // WRIST 0.727 in bind space, and the rings already sampled exactly those heights — they just
  // did nothing there. So the shape now goes deltoid → triceps belly → TAPER INTO the elbow →
  // condyle knob → forearm belly → wrist pinch, which is the sequence an inker draws.
  //
  // THE PINCH IS BOUNDED BY THE INK FLOOR, NOT BY TASTE. `BODY.minHalfWidth` = 0.070 and
  // `body.ts::assertInkFloor` fails the boot if anything goes under, so the wrist and the ankle
  // stop at 0.072. That floor is also *why* this file was a tube: staying clear of it is easiest
  // if nothing is ever sculpted. But the floor only forbids going THINNER — the landmarks below
  // are made by ADDING mass at the joints, which costs the floor nothing and buys silhouette.
  // ──────────────────────────────────────────────────────────────────────────────────────────
  arm: [
    { y: 1.452, u: 0.110, v: 0.110, round: 0.5 },
    /* deltoid cap — BODY says "heavy shoulders", and this is where they live */
    { y: 1.395, u: 0.136, v: 0.130, round: 0.4 },
    { y: 1.310, u: 0.120, v: 0.116, round: 0.35 },
    { y: 1.200, u: 0.099, v: 0.100, round: 0.35 },
    /* narrowest of the upper arm, immediately above the joint */
    { y: 1.110, u: 0.088, v: 0.092, round: 0.35 },
    /* ELBOW (SKEL: y 1.047). A hard knob pushed BACK (+z) — the olecranon point. */
    { y: 1.047, z: 0.014, u: 0.112, v: 0.108, round: 0.28 },
    /* forearm belly, straight under the joint */
    { y: 0.985, u: 0.104, v: 0.100, round: 0.32 },
    { y: 0.880, u: 0.092, v: 0.090, round: 0.35 },
    { y: 0.790, u: 0.078, v: 0.078, round: 0.4 },
    /* WRIST (SKEL: y 0.727). The pinch is what makes the hand a separate mass. */
    { y: 0.727, u: 0.072, v: 0.073, round: 0.45 },
  ] as readonly SurfaceRing[],
  /**
   * The over-sized splayed hand — the part that actually comes at the player.
   *
   * Was a 0.118 lump barely wider than the 0.084 wrist it grew out of, i.e. a stump. It is now
   * BROAD AND FLAT (u 0.152 against v 0.112) and 63 mm longer, so it reads as fingers rather
   * than as the end of the arm. Width, not length, is what carries at 10 m.
   */
  hand: [
    { y: 0.762, u: 0.076, v: 0.076, round: 0.5 },
    /* heel of the hand */
    { y: 0.700, z: -0.014, u: 0.112, v: 0.098, round: 0.32 },
    /* KNUCKLES — the widest point of the whole arm */
    { y: 0.628, z: -0.030, u: 0.152, v: 0.112, round: 0.24 },
    /* fingers, splayed */
    { y: 0.552, z: -0.038, u: 0.146, v: 0.104, round: 0.20 },
    { y: 0.482, z: -0.030, u: 0.100, v: 0.082, round: 0.35 },
  ] as readonly SurfaceRing[],
  /** Shoulder x of each arm chain in bind space (`SKEL` CLAV.x + ARM.x). */
  armX: 0.248,
  armXL: -0.256,
  /** The left shoulder sits a touch higher — nothing on this body is symmetric. */
  armDropL: 0.012,

  /**
   * One leg, authored on the RIGHT (+X). Root ring inside the pelvis.
   *
   * Same story as the arm, and worse: 0.150 → 0.088 with the KNEE (SKEL: y 0.395) sitting in the
   * middle of the slope doing nothing, and no calf at all — the old profile was *narrower* below
   * the knee than above it the whole way down, which is a chicken leg, not a human one.
   *
   * The two z-offsets are the point of the silhouette: the patella pushes FORWARD (−z) and the
   * calf belly pushes BACK (+z), so a bent leg now has a front and a back instead of being a
   * bendy cylinder. That is legible from behind at 10 m, which is where the horde usually is.
   */
  leg: [
    { y: 0.905, u: 0.152, v: 0.150, round: 0.4 },
    /* glute / hip mass */
    { y: 0.828, u: 0.156, v: 0.152, round: 0.35 },
    /* thigh belly — the heaviest cross-section on the body */
    { y: 0.740, u: 0.148, v: 0.146, round: 0.30 },
    { y: 0.600, u: 0.128, v: 0.132, round: 0.30 },
    /* narrow, just above the joint */
    { y: 0.470, u: 0.104, v: 0.110, round: 0.32 },
    /* KNEE (SKEL: y 0.395) — the patella, pushed FORWARD */
    { y: 0.395, z: -0.014, u: 0.124, v: 0.122, round: 0.26 },
    /* CALF belly, pushed BACK */
    { y: 0.320, z: 0.016, u: 0.118, v: 0.120, round: 0.32 },
    { y: 0.200, z: 0.010, u: 0.102, v: 0.104, round: 0.35 },
    { y: 0.090, u: 0.078, v: 0.082, round: 0.4 },
    /* ANKLE pinch — hard against the 0.070 ink floor, same as the wrist */
    { y: 0.030, u: 0.072, v: 0.076, round: 0.5 },
  ] as readonly SurfaceRing[],
  legX: 0.132,
  /**
   * The foot slab, hung off `BONE.FOOT_*`. Sole at y ≈ 0, toes forward (-Z).
   * Grown 15% wider and 23% longer: against a pinched 0.072 ankle a small foot reads as a stump,
   * and the foot is the part that sells the DRAG — you have to be able to see it not clear the
   * ground. Still far above `minSlabDim`.
   */
  foot: { x: 0.132, y: 0.064, z: -0.098, w: 0.248, h: 0.152, d: 0.395 },

  /** The torn coat flap. Two slabs, off ONE shoulder blade, never mirrored. */
  rag: [
    { x: -0.185, y: 1.115, z: 0.150, w: 0.235, h: 0.440, d: 0.140 },
    { x: -0.258, y: 0.930, z: 0.128, w: 0.170, h: 0.270, d: 0.148 },
  ],
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
  /**
   * ═══ THE SPHERE IS THE DRAWN SKULL — SOLVED, NOT ESTIMATED ═══
   *
   * `tools/combat.mjs` skins every cage vertex on the CPU with the shader's own palette, keeps
   * the ones whose dominant bone is HEAD, and grid-searches the MINIMUM ENCLOSING SPHERE over
   * 16 instances × 4 gait phases — every variant, every girth roll, every head tilt. The answer,
   * to the millimetre, is **R 0.220 at (0, 0.100, −0.020) in HEAD-bone local**, and it contains
   * **100.0%** of the drawn skull.
   *
   * WHAT WAS THERE BEFORE, measured the same way:
   *   BUILD 006  R 0.215 @ (0, 0.115, 0)   — 59% wider than the head it was drawn around
   *   BUILD 007  R 0.195 @ (0, 0.135, −0.005) — contains **70.1%** of the drawn skull
   *
   * Both are the same bug with opposite signs, and both produce the human's complaint. A sphere
   * wider than the drawing rewards a visible miss and cannot be learned. A sphere NARROWER than
   * the drawing — which is what shipped — punishes a visible hit, and it does it on the crown
   * and the back of the head, i.e. on the *train*, where you are stacking crits on the back of
   * skulls walking away from you. 30% of clean skull shots were scoring a body hit.
   *
   * The centre moved DOWN 35 mm as well as growing: the cage's mass is lower than the joint
   * offset suggested, and the old centre was sitting near the top of the cranium. That is why
   * the old sphere both missed the crown AND brushed the shoulder.
   */
  headRadius: 0.220,
  /** Where the head sphere sits, in HEAD-BONE local space. The solved centre, above. */
  headCenterY: 0.100,
  headCenterZ: -0.020,
  /**
   * ═══ THE JAW IS PART OF THE HEAD ═══
   *
   * Measured: **31% of drawn-jaw shots registered nothing at all** and the rest scored a torso
   * hit — the jaw hangs forward and down out of any sphere that fits the cranium (its verts sit
   * a median 0.237 from the skull centre, outside even a 0.220 sphere).
   *
   * So the head is TWO spheres, and both score `'head'`. The minimum enclosing sphere of the
   * drawn jaw is R 0.172 at (0, 0.015, −0.100) in JAW-bone local — 100% coverage. One extra
   * ray/sphere test per body, and only when the cranium sphere already missed.
   *
   * This is also what CoD does: the chin and the neck are headshot surface, not body surface.
   */
  jawRadius: 0.172,
  jawCenterY: 0.015,
  jawCenterZ: -0.100,
  /** `jawRadius / SKEL[JAW].radius` — the per-instance girth ratio's denominator. */
  jawBindRadius: 0.120,
  /**
   * The torso capsule stops at the shoulder line rather than at the neck: its top cap sphere
   * would otherwise swallow the head, and a head you can hit by aiming at the collarbone is a
   * head nobody learns to aim at. `HITBOX.priority` still resolves head→torso, so the overlap
   * that remains costs nothing.
   */
  torsoRadius: 0.290,
  /** Capsule from the hips joint up to here in CHEST-BONE local space. */
  torsoTopY: 0.045,
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

  /**
   * ═══ EVERY RADIUS ABOVE IS A BIND-POSE NUMBER, AND THE INSTANCE SCALES IT BY GIRTH ═══
   *
   * `body.ts::reseed` rolls a per-instance girth for every bone (`gt` torso, `gh` head, `gl`
   * limb — each already carrying the variant's overall scale `g`), and `rig.boneRadius(bone)`
   * returns the result. The hitbox therefore scales by `rig.boneRadius(b) / SKEL[b].radius`,
   * NOT by `height / BODY.height`.
   *
   * WHY IT MATTERS, measured: the height ratio only carries `g`. It misses the VARIANT term
   * entirely — a `bloated` head is authored at 1.20× and a `gaunt` head at 0.90×, so the old
   * `headRadius * (height / BODY.height)` gave the bloated zombie a hitbox 17% narrower than
   * its own drawn skull and the gaunt one a hitbox 11% wider. Both directions are the exact
   * complaint ("hitboxes I can't understand"): the one with the huge head was the hardest to
   * crit, and the skinny one rewarded a miss.
   */
  /** `headRadius / SKEL[HEAD].radius`, `torsoRadius / SKEL[CHEST].radius` — see above. */
  headBindRadius: 0.175,
  torsoBindRadius: 0.240,
  /**
   * Limb capsules take `rig.boneRadius(bone)` DIRECTLY (upper arm 0.118, forearm 0.098, thigh
   * 0.135, shin 0.105 at bind) times this.
   *
   * 1.38 is MEASURED, not chosen: `tools/combat.mjs` reports, per bone, the 99th percentile of
   * the distance from a drawn vertex to its own bone segment, in units of `SKEL[b].radius` —
   * arm 1.32, forearm 1.47, hand 1.26, thigh 1.44, shin 1.24, foot 1.22. `boneRadius` is the
   * skin-solve's falloff support, which is deliberately tighter than the surface it produced;
   * this is the ratio that turns it back into the surface.
   *
   * Being generous here is nearly free and never steals a shot: `HITBOX.priority` resolves
   * head → torso → limb, so a limb capsule only ever catches a ray that already missed both.
   */
  limbGenerosity: 1.38,
  /**
   * LEGACY, kept only so a caller outside this module still resolves. The live path is
   * `rig.boneRadius()`; nothing in `service.ts` reads these any more.
   * @deprecated
   */
  armRadius: 0.125,
  legRadius: 0.135,
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
  /**
   * ── THE LURCH (see `body.ts::poseGait`) ──
   * Lateral weight transfer onto the planted foot, METRES. A walking body carries its mass over
   * the foot it is standing on; the old gait only rolled and dropped, which is a march.
   */
  weightShift: 0.045,
  /** Extra pelvis drop when the weight lands on the DRAG leg. Asymmetry is what makes a limp. */
  lurchDrop: 0.038,
  /** Constant yaw carrying the good-side shoulder ahead, radians. Keyed to `dragSide`. */
  shoulderLead: 0.20,
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

  // ── head / neck (BUILD 007) ────────────────────────────────────────────────
  //
  // The neck and the clavicles are new bones and they exist for one reason: to keep the head
  // clear of the shoulder mass while the body stoops. A stooping rigid body drops its head
  // between its shoulders and the target disappears; a stooping SKELETON pitches the spine and
  // counter-pitches the neck, so the chest goes down and the face stays up and forward.
  headLoll: 0.15,
  headNod: 0.11,
  jawOpen: 0.42,
  /** Fraction of the spine's forward pitch the neck cancels. 0 = head buried, 1 = head level. */
  neckCounter: 0.78,
  /** Fraction of the spine's twist the head cancels, so it keeps facing the way it walks. */
  headCounterTwist: 0.60,
  /** Constant forward thrust of the head on the neck, radians. Lead with the face. */
  headThrust: 0.26,
  /** The neck lolls a beat behind the head — the head is never rigidly bolted on. */
  neckLoll: 0.34,
  /** How much of the per-instance shoulder hike the clavicle carries (the rest is the chest). */
  clavHike: 1.15,

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
export type EnemyStateName =
  'spawn' | 'chase' | 'attack' | 'stagger' | 'death' | 'climb' | 'scream';

/**
 * BEHAVIOUR ARCHETYPE — the thing that actually makes an enemy different.
 *
 * `sprinter`, `brute` and `spitter` shipped as `{...SHAMBLER, health, speed}`: one body, one AI,
 * different numbers. A player cannot tell those apart except by how long they take to die, which
 * is not variety — it is the same fight at a different length. GAME_BIBLE §4 asks for enemies
 * that change what the player DOES, so a kind now declares a role and the state machine branches
 * on it.
 */
export type EnemyRole = 'melee' | 'screamer';

export interface EnemyDef {
  kind: EnemyKind;
  name: string;
  /** Base health at round 1, before the director's `hpScale`. */
  health: number;
  /**
   * BASE chase speed, m/s — the SLOWEST tier. `SPEED_TIERS[t].speedMult` multiplies it at spawn,
   * so this is the shambler's 1.62 and a sprinter-tier instance of the same kind is 4.13.
   */
  speed: number;
  /**
   * Kind-level ± speed variation, on top of the tier's own jitter. Near zero now: the TIER is
   * where a horde's speed spread comes from, and stacking a wide kind jitter on top of it just
   * blurs the three silhouettes back into one smear.
   */
  speedJitter: number;
  /**
   * FALLBACK "it noticed you" multiplier over the last few metres. `SPEED_TIERS[t].lungeMult`
   * overrides it per instance — a sprinter that also lunges reads as a teleport.
   */
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

  // ── behaviour ─────────────────────────────────────────────────────────────
  /** What this kind DOES. See `EnemyRole`. */
  role: EnemyRole;
  /**
   * Silhouette scale. A special has to be identifiable by SHAPE at a glance, not by reading its
   * health bar — ART §9 is about recognising a threat before you can count its pixels.
   */
  bodyScale: number;
  /** Screamer: metres it holds at instead of closing to melee. */
  standoff: number;
  /** Screamer: seconds of telegraphed wind-up before the scream lands. Long enough to punish. */
  screamWindup: number;
  /** Screamer: bodies a completed scream calls in. */
  screamSummon: number;
  /** Screamer: seconds before it may scream again. */
  screamCooldown: number;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// SPEED TIERS — the answer to "zombies… aren't truly a threat".
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
//  WHAT COD ACTUALLY DOES, and what we were doing instead.
//
//  Every zombie in Treyarch Zombies picks a MOVEMENT TIER at spawn — walk / run / sprint — from
//  a round-driven distribution, and the distribution shifts toward the fast end every round
//  until, in the low teens, essentially everything sprints. That single mechanic is why round 4
//  and round 14 feel like different games even though the zombie is the same model: at round 4
//  the horde is a tide you walk away from, at round 14 it is a pack that runs you down.
//
//  WE HAD ONE SPEED FOR THE WHOLE HORDE. `SHAMBLER.speed` × a director scalar that crept from
//  1.00 to 1.55 over twenty rounds, plus ±16% of instance jitter. Every zombie in a round moved
//  within ±16% of every other zombie in that round, and the fastest thing the game could ever
//  produce was 2.51 m/s against a 5.4 m/s walk. Nothing in that arrangement can frighten you:
//  you are never surprised by an individual, and the horde is never faster than your stroll.
//
//  A TIER IS NOT JUST A SPEED. A sprinter that also lunges is a teleport, so `lungeMult` — the
//  "it noticed you" acceleration over the last few metres — comes DOWN as the tier goes up. The
//  shambler lurches at you because it is slow; the sprinter does not need to.
//
//  THE CEILING IS DELIBERATE AND IT PROTECTS KITING. The fastest tier is 2.55× base = 4.13 m/s,
//  which is 76% of the player's WALK (5.4) and 47% of their sprint (8.75). You can always
//  out-walk the horde in a straight line — which is what makes a train possible — but you can no
//  longer out-walk it around a corner, and standing still is now fatal. That is the trade.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface SpeedTier {
  /** Debug / HUD only. Never branch on it. */
  id: string;
  /** Multiplier on `EnemyDef.speed` (1.62 m/s for the shambler). */
  speedMult: number;
  /** Replaces `EnemyDef.lungeMult` for this instance. Falls as the tier rises — see above. */
  lungeMult: number;
  /** ± fraction of per-instance speed jitter INSIDE the tier. Small: the tier is the spread now. */
  jitter: number;
}

/** Ordered slow → fast. `TIER_MIX` indexes into this; the order is load-bearing. */
export const SPEED_TIERS: readonly SpeedTier[] = [
  /** 1.62 m/s. The classic drag-foot. Round 1 is nothing but these. */
  { id: 'shambler', speedMult: 1.00, lungeMult: 1.58, jitter: 0.10 },
  /** 2.11 m/s. Walks with purpose. First appears at round 2, dominates rounds 5–7. */
  { id: 'walker', speedMult: 1.30, lungeMult: 1.42, jitter: 0.09 },
  /** 3.01 m/s. A jog you cannot ignore — faster than a player who is aiming down sights. */
  { id: 'runner', speedMult: 1.86, lungeMult: 1.20, jitter: 0.08 },
  /** 4.13 m/s. 76% of the player's walk. It closes the moment you stop moving. */
  { id: 'sprinter', speedMult: 2.55, lungeMult: 1.06, jitter: 0.07 },
];

export const TIER_COUNT = 4;

/**
 * THE MIX, by round. Row `n-1` is round `n`; past the table the last row repeats forever.
 * Each row is [shambler, walker, runner, sprinter] and MUST sum to 1 — `assertTierMix()` is
 * called from `rollTier` in dev and the harness checks every row.
 *
 * The shape is CoD's: pure shamblers for a round, a slow bleed into walkers through the single
 * digits, runners taking over around 8–10, and sprinters the clear majority from 11 on. Round
 * 15 is 87% sprinters; the table saturates at 95% because a horde with literally zero variation
 * stops reading as a crowd and starts reading as a spawner.
 */
export const TIER_MIX: readonly (readonly number[])[] = [
  /* R1  */[1.00, 0.00, 0.00, 0.00],
  /* R2  */[0.92, 0.08, 0.00, 0.00],
  /* R3  */[0.78, 0.22, 0.00, 0.00],
  /* R4  */[0.58, 0.38, 0.04, 0.00],
  /* R5  */[0.38, 0.46, 0.16, 0.00],
  /* R6  */[0.22, 0.46, 0.28, 0.04],
  /* R7  */[0.12, 0.40, 0.36, 0.12],
  /* R8  */[0.06, 0.31, 0.43, 0.20],
  /* R9  */[0.02, 0.21, 0.47, 0.30],
  /* R10 */[0.00, 0.13, 0.46, 0.41],
  /* R11 */[0.00, 0.07, 0.41, 0.52],
  /* R12 */[0.00, 0.03, 0.34, 0.63],
  /* R13 */[0.00, 0.01, 0.26, 0.73],
  /* R14 */[0.00, 0.00, 0.19, 0.81],
  /* R15 */[0.00, 0.00, 0.13, 0.87],
  /* R16 */[0.00, 0.00, 0.08, 0.92],
  /* R17+*/[0.00, 0.00, 0.05, 0.95],
];

/** The distribution for a round, clamped to the table. Never allocates. */
export function tierMixFor(round: number): readonly number[] {
  const i = Math.max(0, Math.min(TIER_MIX.length - 1, Math.floor(round) - 1));
  return TIER_MIX[i] as readonly number[];
}

/**
 * Pick a tier index from one uniform sample in [0,1). Pure and deterministic: the same `u01`
 * and round always give the same tier, which is what lets `tools/combat.mjs` verify the shipped
 * distribution rather than a re-implementation of it.
 */
export function rollTier(u01: number, round: number): number {
  const mix = tierMixFor(round);
  let acc = 0;
  for (let i = 0; i < TIER_COUNT; i++) {
    acc += mix[i] as number;
    if (u01 < acc) return i;
  }
  // Float slack on a row that sums to 0.9999999: take the fastest non-zero tier.
  for (let i = TIER_COUNT - 1; i >= 0; i--) if ((mix[i] as number) > 0) return i;
  return 0;
}

export const SHAMBLER: EnemyDef = {
  kind: 'shambler',
  name: 'SHAMBLER',
  /**
   * 150. Four body shots or two headshots from the `inkslinger` at 40 damage / 2.5× crit.
   * Low enough that round 1 is a power fantasy, and the director scales it, not this file.
   */
  health: 150,
  /** 1.62 m/s at the SLOWEST tier — 30% of the player's walk. See `SPEED_TIERS` for the rest. */
  speed: 1.62,
  /** 0.05, not 0.16: the tier spread replaced it. See the note on `EnemyDef.speedJitter`. */
  speedJitter: 0.05,
  lungeMult: 1.58,
  windupSpeedMult: 0.22,
  /**
   * 70 = 46.7% of the player's 150. Two hits leave you on 10 HP, three down you — which is
   * CoD's own contract (50 damage against 100 health, 2 hits without Juggernog) expressed in
   * this game's numbers. It was 28: FIVE hits, with 22 HP/s of regen after 4.5 s, so a swarm
   * that landed four swings on you was a scratch you walked off. Being surrounded has to be
   * the thing that kills you or none of the rest of this matters.
   */
  meleeDamage: 70,
  limbHealth: 52,
  oneLegSpeedMult: 0.62,
  role: 'melee',
  bodyScale: 1,
  standoff: 0,
  screamWindup: 0,
  screamSummon: 0,
  screamCooldown: 0,
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
  sprinter: {
    ...SHAMBLER, kind: 'sprinter', name: 'SPRINTER',
    health: 85, speed: 3.6, lungeMult: 1.9, mass: 0.7,
    // Lean and short — it reads as the thing that is FAST before it proves it.
    bodyScale: 0.92,
  },
  brute: {
    ...SHAMBLER, kind: 'brute', name: 'BRUTE',
    health: 620, speed: 1.18, limbHealth: 160, mass: 3, presence: 1.25,
    bodyScale: 1.28,
  },
  spitter: { ...SHAMBLER, kind: 'spitter', name: 'SPITTER', health: 120, speed: 1.4, hue: PALETTE.HOT },

  /**
   * THE SCREAMER — the first enemy that is a DECISION rather than a health pool.
   *
   * It never swings at you. It closes to `standoff`, winds up for `screamWindup` seconds, and if
   * it finishes, `screamSummon` more bodies arrive. So it converts "shoot whatever is nearest"
   * into "break the kite, find the one that matters, and get back on the line" — which is
   * exactly the priority-target pressure GAME_BIBLE §4 asks for and the only thing in the game
   * so far that punishes tunnel vision.
   *
   * Tall, thin and HOT-hued so it is identifiable across the arena at a glance: you cannot be
   * asked to prioritise a target you cannot pick out. Low health, because the cost of ignoring
   * it should be the wave it calls, not the ammo it eats.
   */
  screamer: {
    ...SHAMBLER, kind: 'screamer', name: 'SCREAMER',
    health: 95, speed: 2.1, hue: PALETTE.HOT, presence: 1.3,
    role: 'screamer', bodyScale: 1.14,
    standoff: 9, screamWindup: 2.6, screamSummon: 4, screamCooldown: 9,
  },
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
  //
  // `groundHz`, `collideHz`, `fallSpeed` and `climbSpeed` USED TO LIVE HERE. They described the
  // sampled ground-follow BUILD 006 deleted when the horde moved onto the shared swept-capsule
  // mover (`ENEMY.gravity` in tuning.ts tells that story). Nothing has read them since; they are
  // gone rather than left as four numbers that look tunable and are not.
  //

  /**
   * ═══ THE CONGA LINE — two forces, and they are the whole training skill ═══
   *
   * 1. RELIEF. A neighbour this well-aligned between me and the player is not something to push
   *    away from — it is someone to queue behind. Its separation is scaled by `congaRelief`,
   *    which is what turns a pushing blob into a queue (GAME_BIBLE §4).
   *
   * 2. FOLLOW (new). Relief alone stops a queue being torn apart; it does not build one. The
   *    failure it leaves is CORNERS: every body aims at the player's CURRENT position, so when
   *    the player turns, the ten zombies behind them all cut the corner simultaneously and the
   *    line becomes a fan. Measured on a 12 m circle before this term existed, the horde's mean
   *    lateral deviation from the player's own recent path was metres, not centimetres — a mob,
   *    not a train.
   *
   *    So a body that has a LEADER — a neighbour ahead of it, closer to the player, roughly in
   *    the direction it is already going — steers partly at the LEADER instead of at the player.
   *    Since "closer to the player" is a strict order, the follow graph is a forest and cannot
   *    cycle; the body at the head of the line has no leader and pursues the player directly.
   *
   *    This is deliberately NOT pathfinding. The leader is a position, not a route, and the
   *    follower still runs its own wall whiskers, its own separation and its own turn-rate cap.
   *    It makes the horde walk the path you walked, which is exactly what makes a train readable
   *    and mow-down-able — and it is the reason perfect pathfinding would ruin the game.
   */
  congaCos: 0.72,
  congaRelief: 0.28,
  /**
   * How far ahead a body will look for someone to queue behind, metres. 6.0 is measured: at 4.2
   * a body only finds a leader once it is already shoulder to shoulder with it, which is far too
   * late to bend its line, and the pack's cross-track width barely moved. See `tools/combat.mjs
   * conga`, which runs the whole thing twice — once with `congaFollowWeight` forced to 0 — so
   * every number here is a real A/B against BUILD 006's steering.
   */
  /** A screamer will not call for help at someone on a roof it cannot see properly. */
  screamMaxRise: 2.5,
  congaFollowRadius: 6.0,
  /** …and how much closer to the player they must be before they count as a leader, metres. */
  congaFollowLead: 0.55,
  /** cos of the widest angle off my own line to the player that a leader may sit at. */
  congaFollowCos: 0.42,
  /**
   * Weight of the follow heading against `ENEMY.seekWeight` (1.0).
   *
   * MEASURED across a 0 → 1.3 sweep at three round mixes: the pack's cross-track WIDTH — the
   * number that says "a line, not a crescent wrapping round you" — falls from 4.3 m to ~3.1 m at
   * round 1 and from 3.9 m to ~2.8 m at round 15, and the unbroken queue roughly doubles. Past
   * ~1.3 the gain stops and the horde starts walking single file down your exact footprints,
   * which reads as scripted and, worse, makes them trivially predictable.
   */
  congaFollowWeight: 0.9,
  /**
   * MAX VERTICAL SEPARATION, metres, between me and anyone I will queue behind.
   *
   * A conga line is a HORIZONTAL formation. Without this gate a body at the foot of a staircase
   * happily picks a leader halfway up the flight, and because the follow heading outweighs
   * `ENEMY.seekWeight` it overrides the wall-avoiding seek that is the only thing keeping the
   * body ON the ramp — so the queue drives into the side of the stairs and the whole pack wedges
   * at the bottom.
   *
   * MEASURED on `tools/stairs.mjs horde` (15 bodies up the east stair, player on the NE roof):
   * ungated 1/15 reached the roof, gated 12/15 — identical to the follow term switched off
   * entirely. Flat ground is unaffected, because there every neighbour is within a few cm of my
   * own height and the gate never fires, so the conga A/B in `tools/combat.mjs` is untouched.
   */
  congaFollowRise: 1.0,
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

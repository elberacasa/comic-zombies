/**
 * TUNING — every number the game's FEEL depends on.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THIS FILE IS THE STEERING WHEEL. Nothing else in `src/game/**` may contain a magic number.
 *  A system file reads `MOVE.sprintMult`; it never writes `1.62`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * How to use it during a playtest:
 *   1. The human plays and says a sentence like "sliding feels floaty".
 *   2. You find the one constant that sentence maps to (the comments below tell you which).
 *   3. You change it, Vite hot-reloads, they play again. One number per iteration.
 *
 * Rules for editing:
 *   • Every value carries a comment saying WHY it is that number and what moving it does.
 *   • Units are SI: metres, seconds, radians (degrees only where a comment says `deg`).
 *   • Nothing here is `as const` — these are deliberately mutable so a debug slider or the
 *     console can poke them live mid-playtest without a rebuild.
 *   • Values that boons are allowed to change live in `PlayerStats` (see `player/stats.ts`);
 *     the numbers here are the BASELINE those stats are built from.
 *
 * Sections: PLAYER · MOVE · CAMERA · WEAPON · ENEMY · ROUND · VFX
 */

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PLAYER — the survivability baseline. Boons multiply on top of these.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const PLAYER = {
  /**
   * Max health. 150 (not 100) so that a Shambler hit can be a chunky 25–35 and still give the
   * player 4–5 mistakes. Zombies-style: you are meant to get hit, panic, and kite out of it.
   */
  maxHealth: 150,

  /** Health at spawn. Equal to max — no ramp-up, the round starts hot. */
  startHealth: 150,

  /**
   * Regen per second once the delay has elapsed. 22/s = a full heal in ~7s of not being touched.
   * High on purpose: the fun is in disengaging and re-engaging, not in babysitting a health bar.
   */
  regenPerSecond: 22,

  /**
   * Seconds after the last hit before regen starts. 4.5s is long enough that being surrounded
   * is genuinely losing, short enough that a clean escape is immediately rewarded.
   */
  regenDelay: 4.5,

  /** Below this fraction of max health the screen goes full comic red-vignette panic mode. */
  lowHealthFraction: 0.34,

  /** Points you start a run with. 500 = one wall-buy or a box spin, so round 1 has a decision. */
  startPoints: 500,

  /** Downed state: seconds of crawling before death. Self-revive boons cancel it. */
  downTime: 8,

  /** Movement speed multiplier while downed (crawling). */
  downSpeedMult: 0.35,

  /** Crit (headshot) damage multiplier the player DEALS. Mirrors `PlayerStats.critMult`. */
  critMult: 2.5,
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// MOVE — the single most important block in the project. GAME_BIBLE §2.
//
// Design intent, in one line: *fast, weighty, expressive, never mushy*.
//   - Acceleration is high enough that a tap of W moves you THIS frame (no ramp-in mush).
//   - Friction is high enough that releasing W stops you crisply (no ice).
//   - But momentum in the air and in a slide is never taken away — that's where the skill is.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
//  AFTER THE ~2× ARENA RESCALE — READ BEFORE TOUCHING ANYTHING HERE.
//
//  The human said "bigger spaces, feels everything is small compared to speed and char". The
//  answer is a bigger arena, NOT a slower player: nothing in this block was slowed down, and
//  nothing in it should be. Slowing the player to fix a scale problem trades one complaint for
//  a worse one, because speed is the whole movement pillar.
//
//  What genuinely changes when every distance doubles, in the order I'd re-test them:
//
//  1. `sprintRampTime` (0.25s) becomes almost free. Over a 2× arena you spend far more of each
//     traverse at top speed, so the ramp stops being a meaningful cost and slide-cancelling
//     stops being the obvious answer. If the human says cancel-chaining feels pointless now,
//     RAISE this to ~0.35 before touching `slideCancelSpeedKeep` — make sprint expensive again
//     rather than making the tech stronger.
//  2. `speedHardCap` (16). A 2× arena means long straights where a bunny-hop chain has room to
//     actually reach the cap and hold it, which never happened in the 001 arena. If travel feels
//     capped/rubbery on the long streets, this is the number — not `walkSpeed`.
//  3. `slideDuration` (0.7) + `slideFriction` (1.8) are tuned to agree: a slide entered at
//     ~12 m/s decays to `slideEndSpeed` at almost exactly 0.7s, which covers ~7m. In a 2× arena
//     that is now a *small* fraction of a block, so a slide reads as a dodge rather than a
//     traversal tool. If we want it to be traversal again, lower `slideFriction` and raise
//     `slideDuration` TOGETHER, keeping them in agreement.
//  4. `airStrafeMaxWish` (1.1) / `airStrafeAccel` (110) are unchanged by scale — air-strafe gain
//     is per-tick, so longer jumps simply gain more. Watch for the cap in (2) being hit sooner.
//  5. `coyoteTime` / `jumpBufferTime` / `bhopWindow` are human-reaction constants. Scale does not
//     touch them. Do not "rebalance" them with the arena.
//
//  Camera-side: nothing in CAMERA needs rescaling either. Bob phase is per-METRE, so the stride
//  rhythm is identical at any arena size, and the FOV punch is speed-derived, not distance-derived.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const MOVE = {
  // ── BODY ────────────────────────────────────────────────────────────────────────────────
  // The capsule. `position` is at the FEET; the capsule spans [radius, height-radius].

  /**
   * Capsule radius. 0.42 lets the player fit through a 1.0m gap with clearance and keeps them
   * from wedging on corners. Bigger = safer collision, more "I'm stuck on nothing".
   */
  radius: 0.42,

  /** Standing capsule height. Slightly over eye height so the head has geometry above it. */
  standHeight: 1.85,
  /** Crouched capsule height. Must clear 2*radius (0.84). */
  crouchHeight: 1.15,
  /** Sliding capsule height — low enough to duck a Brute's swing. THE reason to slide. */
  slideHeight: 0.95,
  /** Dolphin-dive capsule height. Same as slide so dive→slide is seamless. */
  diveHeight: 0.95,

  /** Eye heights per posture. Kept separate from capsule height so the camera can be art-directed. */
  standEye: 1.68,
  crouchEye: 0.98,
  slideEye: 0.72,
  diveEye: 0.62,

  /**
   * Half-life (s) of the posture height blend. 0.055 ≈ 3 frames at 60fps: fast enough to feel
   * like a snap, slow enough that the camera doesn't teleport. Raise it and crouching feels
   * like an elevator; drop it to 0 and the camera pops.
   */
  postureHalfLife: 0.055,

  /** Max height the controller will step up without a vault. Curbs, rubble, low crates. */
  stepHeight: 0.45,

  /**
   * Half-life (s) the camera uses to smooth out a step-up. Without this, walking up stairs
   * looks like a strobe. This is a CAMERA-only smear — the collider really does snap.
   */
  stepSmoothHalfLife: 0.06,

  /**
   * Minimum surface normal Y to count as ground. 0.6 ≈ 53° — you can run up a steep ramp but
   * not a wall. Lower it and the player wall-climbs; raise it and ramps feel like glue.
   */
  minGroundNormalY: 0.6,

  /**
   * Downward probe length used to confirm ground contact when not penetrating. Handed to the
   * collision solver by `main.ts` — it is the sticky-ground reach that stops `grounded` from
   * flickering off while you walk down a stair. 0.18 is the value collision shipped with.
   */
  groundProbe: 0.18,

  /**
   * How far the controller will snap down to stay glued when running off a lip or down a ramp.
   * Without this, every slope crest launches you into a tiny involuntary hop.
   */
  groundSnapDistance: 0.45,

  /** Collision resolve iterations per substep. 4 handles a corner (3 planes) with margin. */
  collisionIterations: 4,

  /**
   * Hard cap on a single depenetration correction, metres. Above this the solver is escaping,
   * not contacting, and the player feels a teleport. Measured worst pre-fix displacement on the
   * fire escape was 3.38 m in ONE substep. The horde keeps the looser 1.5 m mover default — see
   * `motion/mover.ts::MotionParams.maxCorrection` for why the two must not be unified.
   */
  maxCorrection: 0.5,

  /** Max distance moved per collision substep. Below `radius` so nothing tunnels at high speed. */
  maxSubstepDistance: 0.3,

  /** If the player somehow ends up below this Y, respawn them at the arena spawn. Safety net. */
  fallResetY: -40,

  // ── GROUND LOCOMOTION ───────────────────────────────────────────────────────────────────

  /**
   * Base walk speed, m/s. 5.4 is deliberately faster than real life (a human jogs ~4) — this is
   * an arcade shooter and the arena is compact. Raise it and the arena feels small.
   */
  walkSpeed: 5.4,

  /** Sprint multiplier over walk. 1.62 → 8.75 m/s, roughly CoD tac-sprint. */
  sprintMult: 1.62,

  /** Crouch-walk multiplier. 0.46 → 2.5 m/s. Slow enough that crouching is a real commitment. */
  crouchSpeedMult: 0.46,

  /** Backpedal multiplier — you cannot retreat as fast as you advance. Forces you to commit. */
  backpedalMult: 0.78,

  /**
   * Ground acceleration, m/s². 95 = full walk speed in ~0.057s (under 4 frames at 60fps).
   * THIS is the "instant response, no mush" number. Drop it below ~40 and the game feels drunk.
   */
  groundAccel: 95,

  /**
   * Ground friction coefficient (1/s), Quake-style: `drop = max(speed, stopSpeed) * friction * dt`.
   * 8.5 stops you from walk speed in ~0.12s. Raise = stickier, lower = ice.
   */
  groundFriction: 8.5,

  /**
   * Friction floor speed. Below this the friction still bites at `stopSpeed * friction`, which
   * is what kills the last 0.3 m/s of creep instead of asymptotically approaching zero.
   */
  stopSpeed: 3.2,

  /** Friction multiplier while crouched — crouching should feel planted, not slippery. */
  crouchFrictionMult: 1.35,

  /**
   * Seconds to ramp from walk speed to full sprint (GAME_BIBLE §2 says 0.25s).
   * This ramp is why slide-cancelling is fast: cancelling RESETS the ramp to full.
   */
  sprintRampTime: 0.25,

  /** Seconds to ramp back down when sprint is released. Faster than the ramp up — sprint is a state you leave instantly. */
  sprintDecayTime: 0.12,

  /** Sprint requires you to be pushing forward at least this much of the stick. Prevents sprint-strafing. */
  sprintForwardDot: 0.55,

  /**
   * Hard ceiling on horizontal speed, m/s. Bunny-hopping should be strong (35% faster than a
   * walker per the bible ⇒ ~11.8 m/s sustained) but not unbounded. 16 leaves headroom for a
   * dive-into-slide-cancel chain to feel broken-in-a-good-way without breaking collision.
   */
  speedHardCap: 16,

  // ── JUMP / GRAVITY / AIR ────────────────────────────────────────────────────────────────

  /**
   * Gravity, m/s². 18 is ~1.8× real. Real gravity in an FPS reads as floaty moon-jumping;
   * heavy gravity + a big impulse gives a fast, weighty, "snappy arc" jump.
   */
  gravity: 18,

  /**
   * Extra gravity multiplier once you are falling (velocity.y < 0). The classic platformer trick:
   * a fast fall makes the jump read as *decisive* instead of hang-timey.
   */
  fallGravityMult: 1.28,

  /** Extra gravity while a dive is airborne — the dive should arc, not glide. */
  diveGravityMult: 1.05,

  /** Terminal velocity. Prevents tunnelling on a long fall. */
  maxFallSpeed: 45,

  /** Jump impulse, m/s. With gravity 18 → apex 1.14m, air time ~0.72s. Clears the vault height. */
  jumpImpulse: 6.4,

  /**
   * Releasing jump early cuts upward velocity by this factor. Variable jump height = expression;
   * it lets a player hop a curb without committing to a full arc. 1.0 disables it.
   */
  jumpCutMult: 0.55,

  /**
   * Coyote time: you may still jump this long after walking off a ledge. 0.1s (bible value).
   * This is invisible when it works and infuriating when it's missing.
   */
  coyoteTime: 0.1,

  /**
   * Jump buffer: a jump pressed this long before landing still fires on touchdown. 0.12s.
   * Buffering is what makes bunny-hop chains land instead of eating a frame of friction.
   */
  jumpBufferTime: 0.12,

  /** Minimum seconds between jumps. Stops a single press double-firing across two fixed steps. */
  jumpCooldown: 0.08,

  /**
   * Air acceleration toward the wish direction, m/s². Low: you mostly keep your momentum.
   * This is scaled by `PlayerStats.airControl` so boons can make you a hummingbird.
   */
  airAccel: 14,

  /**
   * SOURCE-STYLE STRAFE ACCELERATION — the bunny-hop engine.
   * When the wish direction is nearly perpendicular to your velocity, we accelerate along it,
   * but the "wish speed" used for the cap is clamped to `airStrafeMaxWish`. Because the cap is
   * tiny, you can add a small amount of speed *every tick you keep turning*, and there is no
   * upper bound from the accel formula itself — only from `speedHardCap`.
   *
   * airStrafeAccel: how hard the strafe bite is. Raise it and gaining speed gets easier/cheaper.
   * airStrafeMaxWish: the classic 30ups clamp, in m/s. Raise it and normal air-strafing stops
   *   feeling like a technique and starts feeling like flying.
   */
  airStrafeAccel: 110,
  airStrafeMaxWish: 1.1,

  /** Air friction (1/s). Should be 0 — momentum in the air is sacred. Non-zero only for debug. */
  airFriction: 0,

  /**
   * Bonus: landing with a buffered jump preserves this fraction of horizontal speed instead of
   * eating one tick of ground friction. 1.0 = perfect hop chaining, <1 = each hop bleeds.
   * 0.98 makes an infinite chain slowly decay, so a chain still needs slide-cancels to sustain.
   */
  bhopSpeedKeep: 0.98,

  /** Seconds after landing during which a buffered jump counts as a perfect hop. */
  bhopWindow: 0.1,

  // ── SLIDE (the core skill tech) ─────────────────────────────────────────────────────────

  /** You must be going at least this fast to start a slide. Just under sprint speed. */
  slideMinSpeed: 6.2,

  /** Speed added along the slide direction on entry (also `PlayerStats.slideImpulse`). The "pop". */
  slideImpulse: 3.4,

  /** Speed a slide is clamped to on entry. Stops a dive-slide chain from compounding to orbit. */
  slideMaxSpeed: 13,

  /** Full slide duration, s (bible: ~0.7). After this it eases back to a crouch or a run. */
  slideDuration: 0.7,

  /**
   * Friction (1/s) during a slide. ~⅕ of ground friction: you keep gliding, but you can feel the
   * ground eating you. Tuned so a slide entered at ~12 m/s decays to `slideEndSpeed` at almost
   * exactly `slideDuration` — the two numbers are meant to agree. Lower = the slide never ends
   * and kiting becomes trivial; higher = the slide dies before the cancel window is useful.
   */
  slideFriction: 1.8,

  /** Below this speed the slide gives up early and drops you into a crouch. */
  slideEndSpeed: 3.6,

  /**
   * How hard you can steer mid-slide, m/s². Small but non-zero: "slide around a corner into a
   * shot" (bible) needs SOME authority. Too high and the slide becomes a hover-car.
   */
  slideSteerAccel: 9,

  /** Max degrees per second you can curve a slide. Caps the steer so it stays a commitment. */
  slideSteerMaxDeg: 110,

  /** Downhill acceleration along the slope while sliding, m/s². Slopes are speed. */
  slideSlopeAccel: 14,

  /** Cooldown before another slide can start. Prevents slide-spam as a substitute for skill. */
  slideCooldown: 0.28,

  // ── SLIDE-CANCEL (THE tech — bible calls it "the fastest way to travel") ────────────────

  /**
   * Jumping within this many seconds of the slide starting is a CANCEL, not a normal jump-out.
   * 0.35s (bible). Widen it and the tech becomes free; narrow it and it becomes a timing puzzle.
   */
  slideCancelWindow: 0.35,

  /**
   * Fraction of horizontal speed kept through a cancel. 0.94 = "most speed" (bible) — a chain of
   * cancels is slightly lossy, so a top player has to keep the rhythm perfect to hold the cap.
   */
  slideCancelSpeedKeep: 0.94,

  /** Jump impulse multiplier on a cancel. Slightly lower — a cancel is a skip, not a leap. */
  slideCancelJumpMult: 0.92,

  /**
   * A cancel RESETS the sprint ramp to full (bible: "resets sprint"). This is the mechanical
   * reason to chain: normally re-sprinting costs 0.25s of walk speed, cancelling costs 0.
   */
  slideCancelSprintReset: 1,

  /** Slide cooldown is shortened to this on a cancel so the chain can continue. */
  slideCancelCooldown: 0.1,

  // ── DOLPHIN DIVE ────────────────────────────────────────────────────────────────────────

  /**
   * Hold crouch this long while sliding to convert the slide into a dive.
   * Tap crouch = slide, HOLD crouch = dive (bible §2). Keeping them on the same key means the
   * player never has to think, they just express intent by how long they hold.
   */
  diveHoldTime: 0.2,

  /** The conversion is only offered this early into a slide — a dive is a committed opener. */
  diveConvertWindow: 0.3,

  /** Minimum speed to dive at all. */
  diveMinSpeed: 6.5,

  /** Forward launch speed of the dive, m/s. Long commit, big travel. */
  diveForward: 10.5,

  /** Upward launch speed of the dive, m/s. Low arc — a dive is a leap, not a jump. */
  diveUp: 4.4,

  /** You cannot steer a dive at all beyond this (m/s²). It's a commitment; that's the risk. */
  diveSteerAccel: 3,

  /** Landing roll duration, s. Roll = a short slide you cannot cancel out of instantly. */
  diveRollTime: 0.45,

  /** Fraction of impact speed carried into the roll. Rewards diving DOWNHILL and into a run. */
  diveRollSpeedKeep: 0.62,

  /** Invulnerable frames on the landing roll (bible). Consumed by the damage path in M2. */
  diveIFrames: 0.35,

  /** Cooldown after a dive ends. Long — the dive is an escape tool, not a movement tool. */
  diveCooldown: 0.75,

  // ── VAULT / MANTLE ──────────────────────────────────────────────────────────────────────

  /** Ledges lower than this are handled by the step-up instead. */
  vaultMinHeight: 0.5,
  /** Ledges up to this high are auto-vaulted (waist/chest). Above it: nothing (M5 adds ledge-grab). */
  vaultMaxHeight: 1.3,

  /** How far ahead the forward probe looks for a wall, beyond the capsule radius. */
  vaultProbeDistance: 0.75,

  /**
   * How far PAST THE WALL FACE we look for (and land on) the ledge top. Measured from the wall
   * hit, not from the player, so the landing spot is consistent no matter how far away you
   * triggered the vault. Must exceed the capsule radius or you land straddling the lip.
   */
  vaultLandingInset: 0.68,

  /** Vertical clearance required above the ledge for the player to fit. */
  vaultClearance: 1.0,

  /** Seconds the mantle animation takes. Short — a vault must never feel like a cutscene. */
  vaultDuration: 0.3,

  /** Extra arc height added mid-mantle, m. Sells the weight of pulling yourself over. */
  vaultArc: 0.16,

  /** Horizontal speed you exit a vault with. Vaulting is FAST — it's a shortcut, not a penalty. */
  vaultExitSpeed: 5,

  /** Cooldown after a vault. */
  vaultCooldown: 0.2,

  /** Minimum forward input (0..1) required to trigger an auto-vault. Prevents surprise mantles. */
  vaultMinForwardInput: 0.5,

  /** Minimum horizontal speed to trigger an auto-vault. Standing against a crate does nothing. */
  vaultMinSpeed: 1.2,

  // ── FOOTSTEPS & LANDING (event emission; audio/VFX listen) ──────────────────────────────

  /** Metres of travel between footstep events while walking. */
  strideWalk: 2.1,
  /** Metres between footsteps while sprinting (longer gait, but faster → higher rate). */
  strideSprint: 2.7,
  /** Metres between footsteps while crouched (short, quiet, quick). */
  strideCrouch: 1.5,
  /** Below this speed we stop emitting footsteps entirely. */
  footstepMinSpeed: 0.7,

  /** Impact speeds (m/s) that bracket the landing feedback ramp: below soft = silent, above hard = max. */
  landSoftSpeed: 4,
  landHardSpeed: 15,

  /** Fall speed above which landing hurts, and damage per m/s over it. (Wired up in M2.) */
  fallDamageSpeed: 19,
  fallDamagePerSpeed: 7,
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CAMERA — 50% of the feel. Every entry here is one INDEPENDENT ADDITIVE LAYER.
//
// The composition order is fixed and never changes:
//     look (yaw/pitch)  →  posture eye height  →  step smear  →  bob  →  land dip
//     →  lean roll  →  slide/dive roll+pitch  →  recoil kick  →  trauma shake  →  FOV
//
// Every layer is frame-rate independent (spring or exponential damp), so a value tuned at
// 60fps feels identical at 144fps. If a layer ever feels "different on my machine", that is a bug.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
//  MOTION COMFORT IS A HARD CONSTRAINT IN THIS BLOCK — ART_DIRECTION §10, and it is LAW.
//
//  Build 001 made the human dizzy in under a minute and made a straight line feel like falling
//  to the right. The three budgets below are not taste; `player/camera.ts` ENFORCES the two that
//  matter with a clamp instead of trusting these constants to add up:
//
//    • lateral camera translation, any speed   ≤ 0.015 m   (measured worst case now: 0.0094 m)
//    • summed roll from ALL layers at once     ≤ 4 deg     (soft-clamped in compose())
//    • FOV punch above `fovBase`               ≤ 8 deg     (clamped in updateFov())
//
//  THE ZERO-INPUT RULE: hold W and nothing else, and every layer here must produce exactly zero
//  lateral bias, zero net roll and zero yaw drift. A default that falls back to a *direction*
//  when the input is zero is a bug, not a style choice. There is a node harness that proves it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** FULL is the tuned default. REDUCED is the accessibility preset required by ART §10. */
export type ComfortMode = 'full' | 'reduced';

/**
 * Per-layer multipliers applied on top of every constant below. This is the ONLY mechanism the
 * comfort preset uses — there is no second code path, so FULL and REDUCED can never drift apart.
 */
export interface ComfortScales {
  /** View bob (all three axes). */
  bob: number;
  /** Strafe + turn lean roll. */
  lean: number;
  /** Slide/dive pose roll (the pose PITCH is kept: it is a posture readout, not a rotation cue). */
  poseRoll: number;
  /** Landing dip (vertical). */
  landDip: number;
  /** Landing roll. */
  landRoll: number;
  /** Trauma shake, all axes. */
  shake: number;
  /** Sprint/slide/dive/speed FOV punch. ADS zoom is NOT scaled — that one is a sight picture. */
  fovPunch: number;
  /** Screen-space radial speed lines — strong peripheral vection, so it gets a knob. */
  speedLines: number;
  /**
   * CONTRACT FOR THE RENDER LAYER (ART §4.1 + §10): 0 = freeze the boiling outline seed and any
   * other per-frame texture animation. `render/**` should read `comfortScales().boiling` once per
   * frame. The camera does not consume this field; it is published here so nobody needs a new
   * cross-module import to honour the preset.
   */
  boiling: number;
}

export const CAMERA = {
  // ── COMFORT PRESET (ART_DIRECTION §10) ──────────────────────────────────────────────────

  /**
   * Live preset selector. `CZ.tuning.CAMERA.comfort = 'reduced'` works from the console, and so
   * does `CZ.player.comfortMode = 'reduced'` / the F7 key — they all write this one field.
   */
  comfort: 'full' as ComfortMode,

  /**
   * REDUCED zeroes bob, lean, pose roll, land roll, shake and the FOV punch, and halves the
   * speed lines. What survives is the landing dip at 35% (pure vertical, and without it a 12 m/s
   * landing has no feedback at all) and the pose PITCH (you must be able to tell you are sliding).
   * It costs us almost nothing and some players cannot play without it.
   */
  COMFORT: {
    full: {
      bob: 1, lean: 1, poseRoll: 1, landDip: 1, landRoll: 1,
      shake: 1, fovPunch: 1, speedLines: 1, boiling: 1,
    },
    reduced: {
      bob: 0, lean: 0, poseRoll: 0, landDip: 0.35, landRoll: 0,
      shake: 0, fovPunch: 0, speedLines: 0.5, boiling: 0,
    },
  } as Record<ComfortMode, ComfortScales>,

  /**
   * HARD CEILING on the SUM of every roll layer (bob + lean + pose + land + shake), degrees.
   * ART §10: "summed must never exceed ~4°". Enforced in `compose()` with a smooth saturation
   * (`L·tanh(x/L)`), not a hard clip — a hard clip would create a visible corner exactly when the
   * camera is already at its most violent. Below ~2° the saturation is within 1% of a straight
   * pass-through, so the subtle layers are untouched and only the pile-up is caught.
   */
  rollTotalLimitDeg: 4,

  /**
   * HARD CEILING on total FOV punch above `fovBase`, degrees (ADS zoom excluded — that is a
   * sight picture, not a punch). Build 001 could stack sprint+slide+speed to +23°, which is a
   * textbook nausea trigger. 8 is a push you feel and never a zoom that swims.
   */
  fovPunchMax: 8,

  // ── LOOK ────────────────────────────────────────────────────────────────────────────────

  /** Pitch clamp, degrees. 88 (not 90) so the horizon never fully inverts and the roll stays sane. */
  pitchLimitDeg: 88,

  /**
   * Half-life (s) of look smoothing. MUST STAY TINY. 0.008 ≈ half a frame at 60fps: it removes
   * single-pixel mouse jitter and nothing else. Anything above ~0.02 and the human will describe
   * the game as "laggy" without being able to say why. Set to 0 to disable entirely.
   */
  lookSmoothHalfLife: 0.008,

  // ── FIELD OF VIEW ───────────────────────────────────────────────────────────────────────

  /**
   * Base FOV, degrees (vertical). 78 vertical ≈ 106 horizontal at 16:9 — wide, comic-panel,
   * CoD-console-plus. Wide FOV is also what makes speed legible.
   *
   * NOT reduced for comfort, deliberately: a WIDE base FOV lowers sim-sickness (more static
   * peripheral reference), it is the *changes* that trigger it. So the base stays big and the
   * punches got cut instead.
   */
  fovBase: 78,

  /**
   * FOV added at full sprint. WAS 7. The push is what SELLS speed, but four of these used to
   * stack; each one is now roughly half so the sum lands inside `fovPunchMax` on its own merits
   * instead of being clipped. You should feel sprint *open up*, not lurch.
   */
  fovSprint: 4,
  /** FOV added while sliding. WAS 12 — a 12° step in ~0.2s is the single worst offender we had. */
  fovSlide: 5,
  /** FOV added while diving. WAS 15. Still the biggest push in the game, at a third of the size. */
  fovDive: 6,
  /** FOV subtracted while aiming down sights (the weapon system may override per-weapon). */
  fovAds: -22,

  /**
   * Extra FOV per m/s of speed above walk speed, applied on top of the state pushes. Keeps a
   * bunny-hop chain visually escalating instead of plateauing. WAS 0.55 with a +8 cap, which
   * alone was the whole comfort budget.
   */
  fovPerSpeed: 0.25,
  /** Cap on the speed-derived component. WAS 8. */
  fovSpeedMax: 3,

  /**
   * FOV spring. WAS 4.5Hz — fast enough that entering a slide read as a lens snap. 2.6Hz
   * critically damped still reacts inside a quarter second but the motion is a breath, not a
   * punch. Stays critically damped: FOV must NEVER overshoot, an overshooting FOV is nausea.
   */
  fovSpringHz: 2.6,
  fovSpringDamping: 1,

  // ── VIEW BOB (figure-8) ─────────────────────────────────────────────────────────────────
  //
  // Bob phase is driven by DISTANCE TRAVELLED, not by time. That's why the bob stays locked to
  // the footstep rhythm at every speed and never "swims" when you accelerate.
  // The figure-8: horizontal uses sin(φ), vertical uses sin(2φ) — one vertical bounce per foot.
  //
  // ART §10: "Lateral camera translation is the number one nausea source... ≤1.5cm at walk, or
  // zero. Vertical bob is far safer than horizontal." So the horizontal amplitude was cut by 6×
  // and the vertical was raised — the gait now reads almost entirely as a vertical bounce.

  /** Bob cycles per metre travelled. 0.24 → one full cycle (2 steps) every ~4.2m. */
  bobCyclesPerMetre: 0.24,

  /**
   * Horizontal (side-to-side) bob amplitude, m, at walk speed. WAS 0.035 — which the speed and
   * sprint multipliers then compounded to ±0.096 m, i.e. 19cm of lateral camera travel per
   * stride at a sprint. That is the motion-sickness bug the human felt in under a minute.
   * 0.006 is 0.6cm at walk and 0.94cm at the hard amplitude ceiling, inside §10's 1.5cm.
   * You should feel a trace of sway, never see the world slide sideways.
   */
  bobAmpX: 0.006,
  /**
   * Vertical bob amplitude, m, at walk speed. WAS 0.018 — RAISED, because vertical bob does not
   * make people sick and it is now carrying the whole sense of footfall on its own.
   */
  bobAmpY: 0.026,
  /**
   * Roll added by the bob, degrees at walk speed. WAS 0.45. It opposes the lateral translation
   * (see the sign derivation in `camera.ts:updateBob` — §10 forbids moving and rolling the same
   * way), so it partly cancels the lateral cue rather than compounding it.
   */
  bobRollDeg: 0.3,

  /** Amplitude multipliers per state. Sprint is a stomp; crouch is a creep. WAS 1.7 for sprint. */
  bobSprintMult: 1.25,
  bobCrouchMult: 0.55,
  /** Bob is scaled down this much while aiming — ADS must be steady or you cannot shoot. */
  bobAdsMult: 0.25,

  /** Bob amplitude scales with speed/walkSpeed, clamped here. WAS 1.8. */
  bobSpeedMax: 1.25,

  /**
   * ABSOLUTE ceiling on the final bob amplitude scale, AFTER speed × sprint × crouch × comfort.
   * The old code multiplied the speed ratio (up to 1.8) BY the sprint multiplier (1.7) for a
   * silent 3.06× — nobody reading `bobAmpX: 0.035` could have predicted 9.6cm. This one number
   * makes the worst case provable: max lateral = bobAmpX × bobAmpScaleMax = 0.0094 m, always.
   */
  bobAmpScaleMax: 1.56,

  /** Half-life (s) for blending bob amplitude in/out when you start or stop moving. */
  bobBlendHalfLife: 0.12,

  /** Vertical bob added in the air (none — you are not stepping on anything). */
  bobAirMult: 0,

  // ── LANDING DIP ─────────────────────────────────────────────────────────────────────────
  //
  // KEPT, and justified: the landing dip is *caused by the player's own jump*. It is the one
  // un-commanded camera motion that is directly predicted by the thing the player just did, and
  // predicted motion is the kind vestibular systems tolerate. It is also almost pure vertical.

  /**
   * Metres of camera dip per m/s of impact speed. WAS 0.021 with a 0.34 cap and a 1.6× dive
   * multiplier — 0.54 m of vertical camera travel on a dive landing, which is more than a
   * crouch. 0.014 / 0.20 / 1.35 gives 0.27 m worst case: still unmistakably heavy, half the trip.
   */
  landDipPerSpeed: 0.014,
  /** Hard cap on the dip, m. Beyond this the camera clips the floor and it reads as a bug. */
  landDipMax: 0.2,
  /**
   * Landing dip spring. WAS 4.6Hz / ζ0.62. Still under-damped — that rebound is the "oof" — but
   * ζ0.72 cuts the second bounce, which is the part that reads as the floor wobbling.
   */
  landDipHz: 5.2,
  landDipDamping: 0.72,
  /** Forward pitch, degrees, per metre of dip. WAS 9. The head nods, it doesn't just drop. */
  landPitchPerDip: 7,
  /**
   * Roll on landing, degrees per metre of dip, sign-alternating so two landings never look alike.
   * WAS 4 (→ 2.2° on a dive landing, over §10's "any single layer above 2° is suspect").
   */
  landRollPerDip: 1.6,
  /** A dive-roll landing multiplies the dip by this. WAS 1.6. */
  landDiveMult: 1.35,
  /** Trauma (0..1) added on a max-speed landing. WAS 0.35. Feeds the shake layer. */
  landTrauma: 0.24,

  // ── SLIDE / DIVE POSE ───────────────────────────────────────────────────────────────────
  //
  // THE "FALLING TO THE RIGHT" BUG LIVED HERE. The slide roll used to fall back to a hardcoded
  // +1 sign when the strafe input was zero, so EVERY straight slide banked a constant 7°, and
  // the dive roll had no sign at all — a constant 10°, always the same way. Both are now signed
  // by the strafe input and are exactly zero when you are only holding W. See camera.ts.

  /**
   * Camera roll while sliding, degrees, at full strafe. WAS 7 (and 7 with NO strafe, which was
   * the bug). It uses the same sign convention as the strafe lean so the two never fight.
   */
  slideRollDeg: 2.2,
  /** Extra downward pitch while sliding, degrees. You're low and looking along the ground. */
  slidePitchDeg: 2.5,
  /**
   * Camera roll during a dive, degrees, at full strafe. WAS a constant, unsigned 10 — the single
   * biggest un-commanded rotation in the build. Dive straight now and the horizon stays level.
   */
  diveRollDeg: 1.8,
  /** Pitch during a dive, degrees (negative = look up as you launch, then the arc takes over). */
  divePitchDeg: -5,
  /**
   * Pose spring. WAS 6Hz / ζ0.85 — under-damped, so the pose roll overshot its target on the way
   * in. Overshoot on a ROLL axis is a comfort hazard, so this is now critically damped; the
   * slide still snaps in (5Hz settles in ~0.2s), it just no longer wobbles past level.
   */
  poseHz: 5,
  poseDamping: 1,

  // ── STRAFE LEAN ─────────────────────────────────────────────────────────────────────────
  //
  // The subtlest layer and the one that makes a CoD camera feel ALIVE. Strafing right rolls the
  // camera left by a couple of degrees. Nobody notices it; everybody notices when it's gone.
  //
  // NOTE: build 001's implementation rolled the camera the SAME way as the strafe, contradicting
  // the line above and violating §10 ("if the camera translates right it must not also roll
  // right"). The sign was flipped to match both. If the human says strafing now feels backwards,
  // this is the one to A/B first — flip the sign in `camera.ts:updateLean`, not here.

  /** Max lean roll from strafing, degrees. WAS 2.4; cut so the summed roll budget closes. */
  leanStrafeDeg: 1.6,
  /** Additional lean from turning the mouse, degrees at max turn rate. WAS 1.1. */
  leanTurnDeg: 0.7,
  /** Turn rate (rad/s) that produces the full `leanTurnDeg`. */
  leanTurnRateRef: 6,
  /** Half-life (s) of the lean blend. Slow-ish: the lean should trail the input, never lead it. */
  leanHalfLife: 0.14,
  /**
   * Lean multiplier while airborne — you lean MORE in the air (nothing is bracing you).
   * WAS 1.45, which pushed the airborne lean alone to 3.5° and blew the whole roll budget.
   */
  leanAirMult: 1.15,
  /** Lean multiplier while aiming. Near zero: ADS is a tripod. */
  leanAdsMult: 0.2,

  // ── TRAUMA SHAKE (additive, Perlin-ish, decaying) ───────────────────────────────────────
  //
  // We store TRAUMA (0..1) and shake by trauma^exponent. Squaring means small hits are subtle
  // and big hits are violent — a linear shake makes everything feel like the same event.
  //
  // KEPT, and justified: every trauma impulse in the game is a discrete EVENT the player can
  // point at (a landing, a hit taken, a shot, an explosion). It is loud, brief and causal —
  // the opposite of the continuous, sourceless motion that makes people sick.

  /** Exponent applied to trauma. 2 = quadratic. 3 makes small shakes nearly invisible. */
  shakeExponent: 2,
  /** Base decay of trauma per second when no duration was supplied. WAS 1.6 — ends sooner now. */
  shakeDecay: 2,
  /**
   * Noise frequency, Hz. WAS 22 — near the frame rate, which reads as a strobe rather than a
   * rattle and is the sort of high-frequency image motion §10 warns about. 15 is still a
   * hand-held-camera rattle; below ~10 it becomes a sway.
   */
  shakeFrequency: 15,
  /** Max angular shake at trauma = 1, degrees. WAS 3 / 3 / 4.5. Roll is the readable one. */
  shakePitchDeg: 2.2,
  shakeYawDeg: 2.2,
  shakeRollDeg: 2.6,
  /** Max positional shake at trauma = 1, m. WAS 0.055. Positional shake sells an explosion. */
  shakePos: 0.035,
  /** Trauma is clamped here so ten simultaneous explosions don't blind the player. */
  shakeMaxTrauma: 1,

  // ── RECOIL KICK CHANNEL (M2 hooks the weapon system into this) ──────────────────────────

  /**
   * Recoil lives in its own spring so it composes with, and never fights, look input. The weapon
   * system calls `addRecoil(pitchRad, yawRad)`; the spring returns it to zero.
   */
  recoilHz: 9,
  /** Under-damped: the muzzle overshoots on the way back. That overshoot IS the recoil pattern's feel. */
  recoilDamping: 0.55,
  /**
   * Fraction of the kick that the camera returns on its own. <1 leaves residual climb the player
   * must pull down — that's the "learnable recoil pattern" from GAME_BIBLE §3.
   */
  recoilAutoReturn: 0.85,
  /** Positional kickback of the camera per unit of recoil pitch, m. Tiny, but it adds punch. */
  recoilPushback: 0.35,

  // ── MISC ────────────────────────────────────────────────────────────────────────────────

  /** Near/far planes. Near is tight so a weapon viewmodel never clips through the camera. */
  near: 0.05,
  far: 400,

  /** Speed (m/s) at which the render service's screen-space speed lines reach full strength. */
  speedLinesAtSpeed: 12,
  /** Speed lines only start above this fraction of `speedLinesAtSpeed`. */
  speedLinesThreshold: 0.62,
};

/**
 * The active comfort multipliers. Call it, don't cache it — the human flips the preset live with
 * F7 mid-run and every reader must see the change on the very next frame.
 *
 * Anything outside `game/player/**` that wants to honour the preset (the render layer freezing
 * the boiling line, a future weapon-sway layer) imports THIS, not the player.
 */
export function comfortScales(): ComfortScales {
  return CAMERA.COMFORT[CAMERA.comfort] ?? CAMERA.COMFORT.full;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// WEAPON — M2 owner: weapons agent. Global multipliers only; per-weapon data is CONTENT and
// lives in `src/game/weapons/defs.ts`. These are the knobs that apply to ALL guns.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
//  THE FEEL BRIEF, so a future tuning pass knows what each block is protecting.
//
//  1. ZERO LATENCY. The gun fires on the input edge inside `update()`, and every timer in this
//     block runs on UNSCALED frame time — so hitstop makes the world heavy without ever making
//     the trigger feel sticky. If firing ever feels laggy, it is not a number in here.
//  2. THE RECOIL IS LEARNABLE. The climb comes from `WeaponDef.recoilPattern` indexed by shot
//     number, never from a random. What makes it *masterable* is the recovery: the camera gives
//     back only the part of the climb the player did NOT already pull down themselves
//     (`recoilRecoverRate` / `recoilRecoverDelay` below). That is the CoD trick.
//  3. TWO KICK LAYERS, NEVER ONE. The camera kick is the tuned spring in `CAMERA.recoil*`; the
//     weapon-model kick is `view.kick*` down here and is deliberately BIGGER and SLOWER. One
//     layer alone reads as either a twitchy camera or a floaty gun.
//  4. ART §4.1 IS A HARD CONSTRAINT ON THE VIEWMODEL. It covers a big fraction of the frame, so
//     any layer that never settles is a stillness-test failure on its own. Every viewmodel layer
//     here is gated on real player/camera motion and snaps to an exact rest pose — see
//     `view.restEpsilon` and `view.breathAmp` (which is 0, on purpose).
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const WEAPON = {
  /** Global damage scalar — the fastest way to retune the whole game's TTK in one number. */
  damageScale: 1,
  /** Global fire-rate scalar. */
  fireRateScale: 1,

  /** Seconds of hitstop on a body hit / on a crit / on a kill. GAME_BIBLE §8 wants 2–6 frames. */
  hitstopBody: 0.02,
  hitstopCrit: 0.045,
  hitstopKill: 0.06,
  /**
   * MINIMUM SECONDS BETWEEN TWO GUN-REQUESTED HITSTOPS. The fix for "the SMG lags the whole game
   * when firing" — and it was never a frame-rate bug.
   *
   * One hitstop is `hitstopBody` 0.02 of freeze plus `HITSTOP_RECOVERY` 0.055 of ramp = a 75 ms
   * cycle. The ratatat's interval at 900 rpm is 60/900 = **66.7 ms**, which is SHORTER, so every
   * shot re-armed the freeze before the previous one had finished recovering and the world clock
   * never came back to 1.0 while the trigger was held. Measured by integrating the recovery
   * curve: ~59% world speed on a stream of body hits and **~23% on headshots**. The frame rate
   * was fine the whole time; the *world* was in slow motion, which is exactly what the player
   * described. Every other weapon was safe purely by arithmetic — the pistol's 150 ms cap, the
   * shotgun's 667 ms, the marksman's 1091 ms are all longer than the cycle.
   *
   * 0.13 is the pistol's own cadence, i.e. the rhythm these hitstop values were authored against,
   * so the reference weapon is byte-identical and only the guns that outrun the effect are
   * capped. Result: 79% world speed on sustained body hits, 60% on headshots — but the number
   * that matters is that every window now ends with 30–55 ms at exactly scale 1.0, so the fixed
   * accumulator always gets real steps and the player never stops moving.
   *
   * Enforced at the REQUEST site in `weapons/firing.ts`, never inside `Time.hitstop` — the nuke,
   * the explosion and the death cam come through the same call and must not be throttled by a
   * gun's fire rate. A kill is always allowed through: it is a beat, and it is self-limiting.
   *
   * NOT fixed by shortening `HITSTOP_RECOVERY`: the exponential snap IS the feel, and shortening
   * it would degrade every weapon in the game to fix one.
   */
  hitstopMinGap: 0.13,

  /** Trauma added to the camera per shot, scaled by the weapon's `cameraKick`. */
  shotTrauma: 0.055,
  /** Duration handed to the shake with a shot's trauma. Short — a shot is a snap, not a rumble. */
  shotTraumaTime: 0.16,
  /** Trauma added on a kill you caused. Kills should feel like they land in your hands. */
  killTrauma: 0.09,
  killTraumaTime: 0.24,

  /** Spread multiplier while moving / sprinting / airborne. Hip-fire must stay usable while kiting. */
  spreadMoveMult: 1.35,
  spreadSprintMult: 2.1,
  spreadAirMult: 1.8,
  /** Spread multiplier while crouched or sliding — sliding is REWARDED with accuracy. */
  spreadCrouchMult: 0.7,
  spreadSlideMult: 0.85,

  /**
   * Radians of cone added per shot (bloom), and the ceiling the bloom stacks to. The pistol is
   * semi-auto, so bloom is a soft cap on panic-clicking rather than the SMG's main cost.
   * `spreadBloomMax` is a MULTIPLE of the state cone, not an absolute angle.
   */
  spreadPerShot: 0.0022,
  spreadBloomMax: 2.6,

  /** How long after firing before spread starts recovering, and its recovery rate (1/s). */
  spreadRecoverDelay: 0.08,
  spreadRecoverRate: 6,

  /** Mouse sensitivity multiplier while aiming. <1 so ADS is finer, matching the FOV zoom. */
  adsSensitivityMult: 0.72,
  /** Recoil multiplier while aiming — a braced weapon climbs less, and ADS must be rewarded. */
  adsRecoilMult: 0.78,

  /** Active reload: damage buff and its duration on a successful hit (GAME_BIBLE §3). */
  activeReloadSpeedup: 0.4,
  activeReloadBuff: 1.3,
  activeReloadBuffTime: 3,
  /** Penalty stumble time on a missed active reload. */
  activeReloadMissPenalty: 0.35,

  /** Movement speed multiplier while aiming. Consumed by the player controller once wired. */
  adsMoveMult: 0.55,

  // ── RECOIL PATTERN & RECOVERY (GAME_BIBLE §3 — "learnable, not random") ─────────────────

  /**
   * Seconds of not firing after which `shotIndex` resets to the top of the pattern. Long enough
   * that a semi-auto rhythm stays inside one burst, short enough that a fresh engagement always
   * starts from shot 1 — you cannot learn a pattern whose start you cannot predict.
   */
  recoilPatternResetTime: 0.55,

  /**
   * Seconds after the last shot before the un-corrected climb starts springing back.
   * THE RECOVERY ONLY RETURNS WHAT THE PLAYER DID NOT ALREADY PULL DOWN — every radian of
   * downward mouse movement is subtracted from the debt first (see `recoil.ts`).
   */
  recoilRecoverDelay: 0.09,

  /**
   * Global multiplier on each weapon's own `WeaponDef.recoilRecovery` rate, and the fallback
   * rate (1/s) for a def that does not state one. Raise the rate and the gun self-corrects
   * (easy, mushy); drop it to 0 and the climb is permanent (pure Counter-Strike).
   */
  recoilRecoverScale: 1,
  recoilRecoverRate: 2.6,

  /**
   * HOW MUCH TRANSIENT DIP THE RECOVERY IS ALLOWED TO COST, as a fraction of the debt it is
   * returning. **This is a physics veto on the constant above, not a taste knob.**
   *
   * `PlayerCamera.addRecoil` is the only door into the view, and it splits everything it is
   * handed between a spring and the look angles. Returning debt through that door therefore
   * drives the spring, and a fast return drives it hard: the dip is `R · auto / (perm · ω ·
   * gain(ζ))` times the debt, which for the shipped camera (9 Hz, ζ0.55, auto 0.85) is `R·0.19`.
   *
   * MEASURED, simulating a full 12-round inkslinger magazine with no player correction:
   *   clamped (rate 2.60)  →  worst dip below the pre-fire angle  0.000°
   *   unclamped (rate 11)  →  worst dip                          −0.358°
   * Small for a pistol, and it scales with the debt — an SMG dumping a 32-round magazine with a
   * pattern three times as steep would be pulling the view down by several degrees on its own,
   * un-commanded, which is the class of motion ART §10 exists to prevent. `maxReturnRate` in
   * `recoil.ts` derives the ceiling from the camera's own constants, so re-tuning either side
   * can never silently re-open the hole. 0.5 is a settle you feel and never a motion you notice.
   */
  recoilRecoverTransientMax: 0.5,

  /** First shot out of a rest state gets this much extra kick — the "crack" of the opener. */
  recoilFirstShotMult: 1.18,

  // ── DAMAGE MODEL ────────────────────────────────────────────────────────────────────────

  /** Limb damage multiplier. Below 1 so aiming centre-mass is still the safe choice. */
  limbMult: 0.75,
  /**
   * Fraction of `WeaponDef.range` at which falloff STARTS. Inside it the gun does full damage;
   * from here to `range` it ramps linearly to `WeaponDef.falloff`, then holds.
   */
  falloffStart: 0.45,
  /** Damage retained by each successive enemy a penetrating shot passes through. */
  penetrationDamageMult: 0.72,
  /** Max enemy hitbox hits a single trace will consider. Bounds the per-shot work. */
  maxTraceHits: 6,

  // ── HANDLING ────────────────────────────────────────────────────────────────────────────

  /** Cooldown after a dry click, so holding an empty trigger does not machine-gun the sound. */
  dryFireCooldown: 0.22,
  /** Seconds after running dry before the reload starts by itself. */
  autoReloadDelay: 0.12,
  /** Seconds to raise a weapon on equip/swap. The viewmodel plays a draw over this. */
  equipTime: 0.32,

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // VIEWMODEL — the gun you actually look at. ART §4.1 and §10 both bite here.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  view: {
    /**
     * THE CLIPPING CONTRACT. Every vertex of the viewmodel stays inside this radius of the eye.
     * `MOVE.radius` is 0.42, so nothing static can ever be closer than that horizontally —
     * which means a viewmodel inside 0.40 m can never punch through a wall, and we do not need
     * a second camera pass or a depth clear to keep it honest. Raise it past `MOVE.radius` and
     * the gun starts poking through geometry when you hug a corner.
     */
    maxEyeDistance: 0.4,

    /**
     * THE NEAR-PLANE CONTRACT. No vertex of the viewmodel, in ANY pose, may sit closer to the eye
     * than this along the camera's forward axis. `CAMERA.near` is 0.05 m, so this is 2.4× the
     * clip distance — headroom for the three things the pose table cannot see:
     *   · the inverted ink hull, which inflates the silhouette in SCREEN space (7 px) and so
     *     drags real vertices toward the camera by an amount that grows as the part gets close;
     *   · `swayPosMax` (0.04 m), the one layer that can push the model AWAY from the muzzle and
     *     therefore TOWARD the eye at the grip end;
     *   · the recoil kick, which is `kickBack` × the def's `weaponKick` straight back at you.
     *
     * WHY 0.07 AND NOT 0.20. The number is small on purpose, because the thing it guards against
     * is small: measured, the inverted hull's screen-space inflation is only `(px/H)·2·tan(fov/2)`
     * of the view depth — 1.4 mm at 7 px and 0.1 m out — and the sway layer contributes exactly
     * zero z (see `assertClearance`). So the real requirement is `CAMERA.near` (0.05) plus the
     * hull plus a safety band, not a round number picked out of the air. Set it much higher and
     * it starts vetoing poses that are perfectly fine, which is how an assertion earns the
     * reputation that gets it deleted.
     *
     * MEASURED, per vertex, through the full pose transform (BUILD 005 — the viewmodel prints
     * this whole table at `console.debug` on every dev boot):
     *   rest 0.104 · ADS 0.125 · sprint 0.093 · reload 0.087 · equip 0.119 · rest+recoil 0.077
     * All at the back of the forearm. Two of those numbers moved because of this check:
     * the first cut of the new sprint pose tucked the gun 39 mm back and put a vertex 0.047 m
     * from the eye — INSIDE `CAMERA.near`, i.e. a forearm sliced open every time you ran — and
     * the reload's `reloadPushZ` was trimmed to buy back its margin. Neither would have been
     * caught by the old rest-pose-only bounding-sphere check.
     *
     * Complaint #3 from the BUILD 004 playtest ("you aim like inside the pistol") was NOT this;
     * ADS measured 0.125 m all along. See `adsSightDistance`.
     */
    nearClearance: 0.07,

    /**
     * `WeaponDef.weaponKick` the clearance check budgets for, because recoil is the one layer
     * that drives the model straight back INTO the eye (`kickBack` metres per unit of kick).
     *
     * 1.0 is the inkslinger, i.e. every gun that currently exists, and at 1.0 the rest pose keeps
     * 0.077 m of clearance at the peak of a shot — the tightest number on the model, and 27 mm
     * clear of `CAMERA.near`. **`defs.ts` speculates `weaponKick 2.6` for the roadmap shotgun, and
     * that gun does not fit: measured, 2.6 puts a vertex 0.033 m from the eye, inside
     * `CAMERA.near`.** Whoever adds it must either cut `kickBack`, push `restZ` forward, or
     * accept a sliced-open forearm on every shot — and should raise this number first so the
     * warning fires. It is stated here rather than checked here so that dev boots are not
     * spammed about a weapon nobody has written yet.
     */
    clearanceKickBudget: 1,

    /**
     * How far past its clamped target the sway spring is allowed to travel, as a multiplier, when
     * `assertClearance` bounds the rotational sway layer. The clamp in `update()` is on the
     * TARGET; the spring that chases it passes through. 1.25 covers the overshoot of a spring at
     * this damping without inventing a pose the model cannot reach.
     */
    clearanceSwayOvershoot: 1.25,

    /**
     * LOW-LENS COMPENSATION (M2 §1 "held at a low FOV so it doesn't distort"). We render in the
     * one scene camera at `CAMERA.fovBase` (78°), which would splay a near object badly. With
     * no second pass available, the model's LOCAL Z is compressed by this factor before the
     * perspective divide un-compresses it, which is optically most of what a longer lens buys.
     * 1 = raw wide-angle splay. Below ~0.5 the gun starts to read as a flat sticker.
     */
    depthCompress: 0.72,

    /**
     * Rest pose, metres in camera space: +x right, +y up, -z forward. Hip-fire.
     * These three numbers are what `maxEyeDistance` is measured against — the model's deepest
     * vertex lands at about `restZ - 0.115`, so `restZ` is the one that decides whether the gun
     * can clip a wall. `assertClearance()` in the viewmodel checks it at build time.
     */
    restX: 0.125,
    restY: -0.112,
    restZ: -0.242,
    /**
     * Rest rotation, degrees. A little toe-in and roll so it reads as HELD, not mounted.
     *
     * `restYawDeg` is doing more work than it looks like. A pistol viewed from directly behind
     * is 3.6 cm wide and 15 cm deep, so head-on it projects to about 4% of the screen width —
     * a vertical sliver, and M2 §1 asks for something "readable in silhouette". Angling the
     * muzzle inboard turns the depth into width: at −14° the model projects to ~8% instead,
     * which is what actually shows the slide, the brake and the trigger guard as a shape. Past
     * about −20° it stops reading as pointing where the crosshair is.
     */
    restPitchDeg: -2.5,
    restYawDeg: -14,
    restRollDeg: 3.2,

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * THE ADS POSE IS NOT TUNED. IT IS SOLVED. (BUILD 004 complaint #3.)
     *
     * The human: *"when aiming down sights the aim doesn't go where it should and u aim like
     * inside the pistol weird."* Both halves of that were literally true, and measured:
     *
     *   · Shots leave `ctx.player.eye` along `ctx.player.lookDir` — screen centre, exactly.
     *   · The old pose was three hand-picked numbers (`adsX/Y/Z` = 0, −0.045, −0.235). At
     *     1600×821 / 56° that put the REAR sight 56.2 px and the FRONT sight 45.9 px above
     *     screen centre — so the sights did not agree with the bullet, and they did not even
     *     agree with EACH OTHER (10.3 px of parallax between them).
     *   · Worse, the camera axis at y = 0 ran straight through the slide: the slide's camera-
     *     space y span was [−0.035, +0.019] and the RUST top rib's was [−0.000, +0.011]. The
     *     crosshair was sitting *inside the gun*. That is the "inside the pistol" report, and
     *     it was never a near-plane clip (nearest vertex measured 0.124 m vs a 0.05 m near).
     *
     * So there are no `adsX`/`adsY` knobs any more. `viewmodel.ts` defines an AIM SOCKET at the
     * rear-sight notch and solves the ADS translation so the socket lands on the camera's
     * forward axis with the front blade behind it on the same line — both sights therefore
     * project to exactly screen centre, at any FOV and any aspect, and the rest-pose yaw/pitch/
     * roll all drive to 0 so the model's own -Z *is* the camera's -Z. Change the sight geometry
     * and the pose follows it; there is nothing left to get out of sync.
     *
     * This is the ONE remaining number: how far in front of the eye the rear notch sits.
     * Smaller = bigger sight picture and less of the world. Below ~0.19 the hand starts eating
     * the frame; above ~0.28 the sights are too small to read against a comic-scale enemy.
     */
    adsSightDistance: 0.235,
    /**
     * Half-life (s) of the ADS pose blend. The FOV and the spread cone use the def's own
     * `adsTime` curve (0.18 s, `easeOutCubic`); this is a SECOND filter on top of it, and its
     * only job is to make sure a blend that reverses mid-flight can never pop.
     *
     * WAS 0.055, which put a 13-frame tail on the end of an 11-frame blend: the FOV said "you
     * are aimed" at frame 11 while the sight line was still 27 px off centre, and it took 27
     * frames (450 ms) to come inside a pixel. Nothing about that costs ACCURACY — the shot is
     * traced down the camera axis whether the model has finished moving or not — but a sight
     * picture that arrives after the zoom is a sight picture that feels like it is catching up
     * with you. 0.030 s (1.8 frames) tracks the def's curve closely enough that the two land
     * together, and `settle`'s exact snap still guarantees the §4.1 rest.
     * MEASURED, distance of the front-sight tip from screen centre: from 247 px at the hip,
     * inside 3 px in 16 frames (267 ms) and inside 1 px in 19 (317 ms); was 21 / 27 frames.
     */
    adsPoseHalfLife: 0.03,

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * THE SPRINT POSE — DOWN AND OUTBOARD. (BUILD 004 complaint #2.)
     *
     * The human: *"when running the pistol moves to the inside, i believe it should move to a
     * better position since it doesnt look natural there."* They were describing a real fault.
     * The old pose was `x 0.055` (from a rest `x` of 0.125 — i.e. it slid 70 mm TOWARD screen
     * centre) with `yaw +26°`, and +yaw swings the muzzle to −x, i.e. LEFT, across the player's
     * own chest. The silhouette said "sweeping my own body with a loaded pistol".
     *
     * A sprint pose has one job: read as NOT READY TO FIRE at a glance. So the arm relaxes and
     * the whole thing goes down and OUT — away from centre, tucked toward the hip, muzzle
     * angled down and away, wrist rolled out. Every number below moves further from the sight
     * line than rest does, which is exactly the opposite of what it used to do:
     *
     *          rest        sprint      direction
     *   x      +0.125      +0.140      outboard, away from the aim axis
     *   y      -0.112      -0.148      down 36 mm, toward the hip
     *   pitch   -2.5°      -28°        muzzle DOWN (+pitch raises the muzzle)
     *   yaw    -14°        -28°        muzzle OUTBOARD (-yaw swings it to +x)
     *   roll    +3.2°      -22°        top rolled away from the body - a relaxed wrist
     *
     * AND THE LATERAL IS SMALLER THAN IT WANTS TO BE, because the clipping contract vetoed the
     * rest. `assertClearance` measures every vertex of this pose against `MOVE.radius`, and this
     * gun is already big for a 0.42 m collision capsule: the rest pose's muzzle sits 0.374 m out
     * (0.393 under a full sway flick). Every millimetre of `sprintX` and every degree of
     * `sprintYawDeg` pushes the muzzle further along +x, and the first cut of this pose
     * (x 0.178, yaw -27) measured 0.416 m / 0.441 m swayed - i.e. a muzzle that pokes through
     * the wall you are sprinting past. 0.140 / -28 deg is the outboard-most pose that still
     * lands inside the budget (0.385 / 0.408), and the DROP does the rest of the talking: 36 mm
     * of it, plus 28 deg of muzzle-down. Deeper than that and the slide leaves the frame
     * entirely, which reads as "weapon holstered" rather than "weapon lowered".
     */
    sprintX: 0.14,
    sprintY: -0.148,
    /**
     * Offset applied to `restZ`, not an absolute. **0, and it is 0 the hard way.**
     * The obvious sprint pose tucks the gun back against the ribs, and the first cut of this one
     * did (+0.039). `assertClearance` measured the back of the forearm at 0.047 m from the eye in
     * that pose — INSIDE `CAMERA.near` (0.05), i.e. a forearm sliced open on every stride, which
     * is the exact failure the playtester reported at ADS and would have been a fresh one here.
     * Pushing it forward instead buys near-plane margin but spends reach, and reach is the
     * budget that is already tight (see the note above). Leaving z alone and paying for the
     * whole pose in DROP and ROTATION is what fits both contracts at once.
     *
     * BUILD 006: `restZ` moved 17 mm FORWARD to buy the near-plane margin the rewritten
     * `assertClearance` proved was missing once the rotational sway layers were counted. This
     * offset holds the sprint pose exactly where the playtester's fix put it (absolute z −0.225),
     * because moving it forward with the rest pose pushed sprint reach to 0.400 m — on the
     * `maxEyeDistance` line, and 0.422 m under a sway flick, outside `MOVE.radius`. So the gun
     * now comes 17 mm closer to the chest when you run, which is what a sprint carry does anyway.
     */
    sprintZ: 0.017,
    sprintPitchDeg: -28,
    sprintYawDeg: -28,
    sprintRollDeg: -22,
    /**
     * ASYMMETRIC ON PURPOSE. Dropping into the pose can take its time (0.11 s reads as the arm
     * relaxing); coming OUT of it must never be something the player waits on.
     *
     * The trigger itself is NOT gated on any of this — `updateTrigger` fires on the frame you
     * press it, sprint or no sprint — so the risk here is not input latency, it is the gun still
     * being down by your hip while the bullets leave. MEASURED, hip↔sprint pose distance, from
     * releasing sprint:
     *   0.045 s half-life →  90% raised in 11 frames (183 ms), 99% in 20 (333 ms)
     *   0.030 s half-life →  90% raised in  9 frames (150 ms), 99% in 15 (250 ms)
     * The floor is not this constant: `PlayerController` blends its own `sprintAmount` out over
     * 7 frames (117 ms) and the pose can only chase that. 0.030 s puts the viewmodel within a
     * frame or two of the player's own decay, which is as instant as this layer is allowed to
     * be without it becoming a snap.
     */
    sprintInHalfLife: 0.11,
    sprintOutHalfLife: 0.03,

    // ── LOOK SWAY (the "idle sway" layer — and it MUST come to rest) ──────────────────────
    //
    // ART §4.1: with the camera parked the image is frozen. So the only thing driving sway is
    // the mouse: the gun lags the view, then settles to EXACTLY the rest pose and stops. There
    // is no free-running oscillator anywhere in this block.

    /** Metres of positional lag per radian/second of view rotation. */
    swayPos: 0.012,
    /** Degrees of rotational lag per radian/second of view rotation. */
    swayRotDeg: 3.4,
    /** Sway spring — soft and slow, so the gun trails the view like weight on a wrist. */
    swayHz: 3.4,
    swayDamping: 0.72,
    /**
     * Hard ceiling on the sway offset, metres / degrees. Stops a fast flick throwing the gun —
     * and, less obviously, keeps the model inside the `maxEyeDistance` clipping budget, since
     * sway is the one layer that can push it AWAY from the eye.
     */
    swayPosMax: 0.04,
    swayRotMaxDeg: 6,

    /**
     * FREE-RUNNING IDLE BREATHING. **0, and it is 0 on purpose.**
     * A breathing sine is the classic viewmodel layer and it is also an automatic ART §4.1
     * failure: it animates a large chunk of the frame forever with the player standing still,
     * which is exactly the "every pixel jumping" the playtester reported. If a future pass wants
     * it, gate it on something the player is doing — do not just raise this number.
     */
    breathAmp: 0,
    breathHz: 0.28,

    // ── WALK BOB — and the sign of this layer is a COMFORT decision, not a taste one ───────
    //
    // ART §10 / M2 §1: "opposed to the camera bob, never in phase". Derived once, here:
    //   · The camera bob translates the CAMERA by `+bobOffX` (right). On screen that slides the
    //     whole WORLD to the LEFT.
    //   · The viewmodel is rigidly parented to the camera, so a camera translation moves it not
    //     at all on screen. Its own local `+x` offset moves the GUN to the RIGHT on screen.
    //   · Therefore a viewmodel offset with the SAME SIGN as the camera's bob offset produces
    //     OPPOSED motion in the image: world left, gun right. Same sign, opposite cue.
    // Flipping `bobPhaseSign` to -1 is the A/B if the human ever says the bob compounds.

    bobPhaseSign: 1,
    /** Metres of horizontal / vertical gun bob at walk speed. */
    bobAmpX: 0.009,
    bobAmpY: 0.007,
    /** Degrees of roll the bob adds. Tiny — the camera already owns the roll budget. */
    bobRollDeg: 0.55,
    /** Bob amplitude scales with speed/walkSpeed and is clamped here (same shape as CAMERA). */
    bobSpeedMax: 1.35,
    /** Half-life (s) for blending the bob in and out. Slightly slower than the camera's, so the
     *  gun starts and stops moving a beat after the view — that lag is what reads as weight. */
    bobBlendHalfLife: 0.16,
    /** Bob multiplier while aiming. Near zero: ADS is a tripod. */
    bobAdsMult: 0.18,

    // ── RECOIL KICK (the model layer — bigger and slower than the camera's, always) ────────

    /** Metres the model punches back / up per unit of the def's `weaponKick`. */
    kickBack: 0.055,
    kickUp: 0.016,
    /** Degrees the model pitches up / yaws / rolls per unit of `weaponKick`. */
    kickPitchDeg: 9.5,
    kickYawDeg: 3.2,
    kickRollDeg: 5.5,
    /**
     * The model's kick springs. `CAMERA.recoilHz` is 9 Hz at ζ0.55; these are deliberately
     * LOWER and BOUNCIER so the gun is still settling after the camera has finished. If the two
     * layers ever end up with the same numbers, delete one — you no longer have two layers.
     */
    kickPosHz: 6.5,
    kickPosDamping: 0.42,
    kickRotHz: 5.8,
    kickRotDamping: 0.38,
    /** Kick multiplier while aiming. A braced gun moves less in the sight picture. */
    kickAdsMult: 0.55,

    // ── RELOAD ROUTINE (scripted over the reload's real duration, so it always fits) ───────

    /** Metres the gun drops / degrees it rolls at the deepest point of the reload. */
    reloadDropY: 0.13,
    /**
     * Metres the gun pulls BACK toward the eye at the bottom of the reload arc. WAS 0.045, which
     * left the deepest point of the routine 0.074 m from the eye — the tightest near-plane margin
     * of any pose on the model and only 24 mm clear of `CAMERA.near`. 0.032 buys that back to
     * 0.087 m; 13 mm at the bottom of a 0.13 m drop is not a difference anyone can feel.
     */
    reloadPushZ: 0.014,
    reloadRollDeg: 26,
    reloadPitchDeg: 17,
    /** Normalised time of the magazine-out and magazine-in beats. */
    reloadMagOutT: 0.24,
    reloadMagInT: 0.62,
    /** Metres the magazine falls away at the mag-out beat. */
    reloadMagDrop: 0.12,
    /** Extra snap (degrees) added on a SUCCESSFUL active reload — the reward flourish. */
    activeSnapDeg: 11,
    /** Wobble (degrees) added on a MISSED active reload — the stumble. */
    missWobbleDeg: 9,

    // ── EQUIP / LAND ──────────────────────────────────────────────────────────────────────

    /** Metres the gun starts below the rest pose when drawn, and degrees it starts rolled. */
    equipDropY: 0.22,
    equipRollDeg: -24,
    /** Metres of gun dip per m/s of landing impact, and its cap. Causal, so §10 tolerates it. */
    landDipPerSpeed: 0.006,
    landDipMax: 0.07,

    // ── PRESENTATION ──────────────────────────────────────────────────────────────────────

    /**
     * Silhouette weight, screen px. `READABILITY.PROP_OUTLINE_MAX_PX` is the cap for anything
     * that is not an enemy, and the viewmodel takes exactly that — the heaviest non-enemy line
     * in the game, still a clear step under the enemy's 8 px (ART §9).
     */
    outlinePx: 6,
    /**
     * INK ON THE SIGHTS ONLY. The silhouette line (`READABILITY.VIEWMODEL_OUTLINE_PX`, 7 px) is
     * a SCREEN-SPACE band, so it costs a 26-px-wide front post 14 px of its albedo and closes a
     * 20 mm notch outright. The sights are not the silhouette — they are the one piece of
     * interior detail the player is asked to read to a couple of pixels — so they get their own
     * mesh and their own line. 3.5 px still inks them clearly against the world (it is the same
     * `minThickness` every other hull on this model falls back to) and leaves a measured ~19 px
     * of post and ~13 px of light bar either side at 1600×821. Do not raise this to "match" the
     * body: the hierarchy that matters here is post-vs-notch, not gun-vs-world.
     */
    sightOutlinePx: 3.5,
    /**
     * BOILING LINE ON THE HULL: **0**. The boil is a hero effect with a coverage budget
     * (ART §4.1.1, ~0.3% of changed pixels), and the viewmodel covers a measured 6.5% of the
     * frame at 0.37 m — where the hull shader's near-field gate (`1 - dist/16`) is at ~98% of
     * full amplitude. A boiling viewmodel would spend the entire frame budget on the one object
     * that is on screen 100% of the time. It keeps the heavy line and loses the wobble.
     */
    hullBoil: 0,

    /**
     * Below this the summed animation is snapped to an exact rest pose and the transform is left
     * alone entirely — the ART §4.1 stillness guarantee, in code. Metres for position, and the
     * same number in radians for rotation (both are far below one pixel at this distance).
     */
    restEpsilon: 2e-5,
  },
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// ENEMY — STUB (M2 owner: enemies agent). Per-kind data lives in `src/game/enemies/defs.ts`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const ENEMY = {
  /** Global HP and speed scalars — the round director multiplies these per round. */
  healthScale: 1,
  speedScale: 1,

  /** Steering: separation radius and weight. This is what makes a horde read as a CONGA LINE. */
  separationRadius: 1.15,
  separationWeight: 1.6,
  /** Seek weight toward the player, and wall-avoidance weight. */
  seekWeight: 1,
  avoidWeight: 1.4,
  /** Steering acceleration, m/s², and max turn rate, deg/s. Slow turns = kite-able. */
  steerAccel: 22,
  turnRateDeg: 240,

  /** Melee: reach, windup (the tell), damage, and cooldown. The windup is what makes it dodgeable. */
  meleeRange: 1.9,
  /**
   * Vertical separation above which a zombie and the player are simply not in the same fight:
   * no swing lands, and — since BUILD 005's blocker — the contact standoff does not apply
   * either. A body walking UNDER a player on a 6 m roof is not crowding them.
   */
  verticalMeleeGate: 1.7,
  meleeWindup: 0.42,
  /**
   * SHARED DEFAULT — a kind may override it (`EnemyDef.meleeDamage`, and the shambler does).
   * 70 of the player's 150: CoD's "half your health, two hits down you without Juggernog",
   * expressed in this game's numbers. See the long note on `SHAMBLER.meleeDamage`.
   */
  meleeDamage: 70,
  meleeCooldown: 1.1,
  /**
   * ± fraction of jitter on each swing's cooldown, so a pack does not lock into one metronome.
   *
   * WHY IT IS NOT COSMETIC. Every zombie enters `attack` at the same trigger (inside
   * `meleeRange`) and leaves it after a fixed `SWING_TIME`, so five bodies that arrive together
   * synchronise permanently: all five wind up on the same frame, all five land on the same
   * frame, and 350 damage arrives as ONE event you cannot react to and cannot read. Being
   * surrounded should be a drum roll of separate hits you are frantically walking out of. 0.22
   * de-phases a pack inside two swing cycles and is far too small to be felt as a delay.
   */
  meleeCooldownJitter: 0.22,

  /**
   * THE HIT REACTION, and why it is now almost entirely ANIMATION.
   *
   * BUILD 010, the playtester: *"zombies should keep walking when u shoot them? they feel weird
   * moving back when shot"*. They are right, and the numbers were indefensible. `e.push` decays
   * at e^-6.5t, so one impulse travels `impulse / 6.5` metres before it is gone:
   *
   * | shot                     | impulse         | travel, BEFORE  | travel, NOW |
   * |--------------------------|-----------------|-----------------|-------------|
   * | inkslinger body, 42 dmg  | 1.47 m/s        | **0.226 m back**| 0.018 m     |
   * | longshot, 145 dmg        | 5.08 m/s        | **0.781 m back**| 0.062 m     |
   * | ratatat held, 26 × 15/s  | 2.10 m/s steady | **walks backwards at 2.1 m/s** | 0.17 m/s of drag |
   *
   * And the comparison that decides it: a staggered shambler walks at 1.62 × 0.25 = 0.40 m/s, so
   * it covers 6.2 cm in the 0.154 s the push lasts. Every one of the old figures was several
   * times that — the body genuinely reversed — and `ai.ts::contactFactor` takes its forward speed
   * to ~0 inside the melee standoff, i.e. at exactly the range you do most of your shooting.
   * BO2 zombies are not pushed around the map. The relentless walk is the horror of the mode, and
   * positional knockback also made trains unpredictable, which is the competitive half of §8.5.
   *
   * The fix is a SPLIT, not a deletion. `knockbackPerDamage` is unchanged, because it is still
   * the REACTION IMPULSE — what a hit is worth in m/s — and two designed mechanics measure it at
   * exactly this calibration:
   *   · `NAV.climbBreakImpulse` = 2.6 is documented as "one 85-damage headshot tears a body off a
   *     mantle", which is only true at 0.035. A CLIMBING body therefore still banks the full
   *     impulse, so shooting them off a ledge is bit-for-bit what it was.
   *   · splash (`damageSphere`) still translates at full strength. An explosion is allowed to
   *     throw a body; that is what an explosion is.
   * What changed is how much of that impulse a body ON ITS FEET may spend on TRANSLATION —
   * see `knockbackTranslation`. The flinch and shudder springs (`ANIM.flinch*`, `ANIM.shudder*`)
   * are untouched: the hit is now read entirely off them.
   */
  knockbackPerDamage: 0.035,
  /**
   * Fraction of the reaction impulse a GROUNDED body spends on world translation.
   *
   * 0.08: an inkslinger body shot moves a shambler 1.8 cm against the 6.2 cm it walks forward in
   * the same window, so the net motion is always forward and no single bullet reads as a shove.
   * Held fire is the case that matters more — a ratatat mag-dump settles at 0.17 m/s of drag
   * against 0.40 m/s of staggered walk, so a full auto burst SLOWS the horde instead of reversing
   * it. Not zero on purpose: a wall of gunfire visibly biting is worth keeping.
   */
  knockbackTranslation: 0.08,
  /**
   * Hard ceiling on accumulated grounded knockback, m/s. At the 6.5/s decay, 0.65 is 10 cm of
   * travel — the most that can happen without the body reading as reversing even at contact,
   * where its own forward speed is 0.
   *
   * Nothing in the current arsenal reaches it: boomstick lands 0.54 m/s when all 8 pellets
   * connect at point blank (8 cm — the shotgun is the one gun that visibly nudges, and it earns
   * that by delivering 192 damage in a single instant), longshot 0.41, inkslinger 0.12. This is
   * a guard rail for Pack-a-Punch damage multipliers and stacked boons, not a normal-case clamp.
   * Splash and the climb are exempt; they are the genuinely physical cases.
   */
  knockbackTranslationMax: 0.65,
  /**
   * Seconds of stagger per hit, before the ×1.0–2.6 scale in `reactions.ts::applyHit`.
   *
   * 0.07, was 0.12 — the other half of "they should keep walking". The stagger STATE is what
   * stops a zombie (`ai.ts::stateSpeedMult` gives it 0.25× speed); the flinch SPRING is what
   * SHOWS the hit, and the spring is additive and runs in every state. So shortening the state
   * costs the read nothing. At 0.12 a typical 42-damage body shot bought 0.27 s of stagger
   * against the inkslinger's 0.15 s fire interval — any sustained fire pinned a body at quarter
   * speed permanently. 0.07 puts that same shot at 0.155 s: a held trigger still suppresses (it
   * should), but a marksman rifle at 1.09 s between shots no longer does.
   *
   * Not lower: the Screamer counter (`ai.ts` 'scream' → `staggerT > 0` cancels the call) and the
   * melee interrupt both trigger on ENTERING stagger, so they are unaffected by the duration,
   * but the state still has to survive long enough to be seen as a stumble.
   */
  flinchTime: 0.07,

  /**
   * THE UNSTICK (BUILD 004 blocker). Steering is not pathfinding — GAME_BIBLE §4 buys a horde
   * that FLOWS in exchange for a horde that can be outsmarted, and that trade only holds if
   * wedging is impossible or self-correcting. It was neither: measured 15–20% of every round's
   * spawns computing a 1.6–1.8 m/s chase velocity while their position moved 0.000–0.145 m in
   * two seconds — the hard wall correction was undoing the integration every collide tick. One
   * body held 128 s of `stateT` 5.5 m from a stationary player. Because the round only leaves
   * `active` at `aliveCount === 0`, that is a permanent straggler hunt.
   *
   * The detector is deliberately conservative: it only ever looks at a body that is in `chase`
   * and asking for real speed, so a staggered, attacking or spawning zombie is never touched.
   */
  /** Seconds between displacement samples. */
  wedgeSample: 0.5,
  /** Below this requested speed a body is not trying to move, so it cannot be wedged. m/s. */
  wedgeMinSpeed: 0.5,
  /** Actual displacement rate under this, while trying, counts as wedged. m/s. */
  wedgeMinProgress: 0.05,
  /** Sustained wedge before we intervene, seconds. Long enough that a crowd jam self-solves. */
  wedgeTrip: 1.5,
  /** Seconds of tangential detour once tripped. */
  wedgeDetourTime: 1.6,
  /** How far off the seek heading the detour steers, degrees. ~tangent to the blocker. */
  wedgeDetourDeg: 75,

  /**
   * THE RESCUE. Two failed detours (~6 s of a body that has not moved) and the horde stops
   * pretending: the enemy system re-places it on walkable ground near the player. A round that
   * only ends at `aliveCount === 0` cannot be allowed to depend on the steering being perfect.
   * Preference is given to a heading BEHIND the player, so the rescue reads as the horde
   * flanking rather than as a zombie blinking into your crosshair.
   */
  wedgeRescueTrips: 2,
  /** Preferred re-placement ring around the player, metres. Far enough to be a walk, not a pop. */
  wedgeRescueDistance: 16,
  /** Fallback ring if nothing on the preferred ring is walkable, metres. */
  wedgeRescueFallback: 8,

  // ═══════════════════════════════════════════════════════════════════════════════════════
  //  LOCOMOTION — the horde now runs the SAME swept-capsule solver as the player.
  //  See `src/game/motion/mover.ts` for why, and for the before/after measurements.
  //
  //  What these replaced: `SCHED.groundHz` (a 12 Hz `groundAt` probe), `SCHED.climbSpeed` and
  //  `SCHED.fallSpeed` (a lerp of `position.y` toward that probe) and `SCHED.collideHz` (a 24 Hz
  //  capsule correction that only ever applied X and Z). Those four numbers ARE the playtester's
  //  complaints 1 and 4: a 12 Hz probe is ~16 cm of blind travel per sample, so every kerb and
  //  stair nose made a body stutter; and a probe that returns the height of an AWNING lifts a
  //  body into solid geometry that a horizontal-only correction can never push it out of.
  //
  //  They are deliberately NOT the player's numbers. A zombie is heavier and dumber: it drops
  //  off a ledge decisively instead of sailing, and it absorbs a kerb without a hop.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * Gravity, m/s². Heavier than the player's 18: a shambler stepping off a loading dock should
   * arrive, not float down. Raise it and drops read as falling rocks; lower it and the horde
   * hangs in the air on every kerb, which is the exact "floaty" read we are removing.
   */
  gravity: 26,
  /** Extra bite once already falling. Small — a zombie's fall is a drop, not a dive. */
  fallGravityMult: 1.12,
  /** Terminal velocity, m/s. Bounded so nothing tunnels off the 34 m roofs. */
  maxFallSpeed: 34,

  /**
   * cos of the steepest slope a body can stand on. THE SAME NUMBER the player, the collision
   * solver and `world.steer()` use — three systems this coupled disagreeing about what
   * "walkable" means is how a horde ends up refusing to use a ramp it is standing on.
   */
  minGroundNormalY: MOVE.minGroundNormalY,

  /**
   * How far a body glues back down when it runs off a crest, a kerb lip or a stair nose.
   * Slightly more generous than the player's 0.45: a zombie has no coyote time, no jump and no
   * mantle-on-demand, so anything it cannot glue over it has to route around.
   */
  groundSnap: 0.5,

  /** Max distance per collision substep, m. Well under `BODY.radius` (0.37) — nothing tunnels. */
  maxSubstepDistance: 0.2,
  /** Substep cap per step. A chase body moves 1.4 cm per step; 3 covers any knockback shove. */
  maxSubsteps: 3,
  /**
   * Depenetration iterations per substep.
   *
   * WAS 3, AND 3 WAS THE BUG. `collideCapsule`'s depth field is not continuous: measured at the
   * east stair foot, a 4 cm scan finds a clean band, then ~28 cm of honest contact (0.1→0.3 m),
   * then a CLIFF straight past 1 m — 270 of 961 cells over a metre, worst 1.68. Cross that cliff
   * and `depenetrate` applies up to `maxCorrection` (1.5 m) per iteration, and at 3 iterations it
   * runs out of passes MID-FLIGHT and leaves the body wherever the last correction threw it —
   * traced: one body moved **3.195 m in a single step** while travelling 0.0135 m. That landing
   * is unvalidated, and sometimes it is inside something else. This is how bodies got into walls.
   *
   * 6 WAS TRIED AND REVERTED, and the measurement is why. It does converge — but with the
   * honest per-body scoreboard in place it buys almost nothing (roof camp 2 bodies → 1, worst
   * overlap 0.56 → 0.24 m; spawn is already 0.00 either way) and it costs TWO THIRDS of the
   * conga queue gain in `tools/combat.mjs` (chain lengthening 19% → 6%). More depenetration
   * passes separate bodies from each OTHER as well as from walls, which is precisely the force
   * that holds a train together. Trading the core trainability skill — the one the playtester
   * singled out with "i like how zombies behave" — for 30 cm on one body in one scenario is a
   * bad trade. Left at 3.
   *
   * NOTE the thing this replaces. `mover.ts` justifies the horde's `maxCorrection` of 1.5 (vs the
   * player's 0.5) as letting bodies "escape a wall they are genuinely inside". Measured, that
   * wall does not exist: the longest embedded episode across 240 s of soak is 0.48 s and bodies
   * are ejected within a frame or two. The old cap was not helping them escape — a 1.5 m
   * correction is precisely what was launching them somewhere unvalidated in the first place.
   */
  collisionIterations: 3,

  /**
   * Half-life (s) of the visual pay-back for a step-up. The collider really does snap up a kerb;
   * the DRAWN body (and its hitboxes, so what you see stays what you hit) trails it over this.
   * The old ground lerp took ~140 ms to climb 0.45 m, so this is deliberately in that ballpark —
   * without it, mounting a kerb is a 45 cm pop.
   */
  stepSmoothHalfLife: 0.09,

  /** Live enemy cap (ARCHITECTURE §6 perf budget). */
  maxAlive: 28,

  /** Seconds a corpse's panel-shards linger before the body is recycled. */
  corpseLinger: 1.6,
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// ROUND — M3 owner: rounds agent. The escalation curve, the beat, and the economy.
// GAME_BIBLE §5 (economy) · §6 (director) · §7 (fail state).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
//  WHAT THIS BLOCK IS PROTECTING, so a future tuning pass knows which number a sentence maps to.
//
//  1. THE ROUND MUST ESCALATE ON THE AXIS THE PLAYER CAN FEEL. Bible order: HP first, THEN
//     speed, THEN composition. HP alone is a slog; speed alone is a wall. So the HP curve does
//     all the work for the first three rounds, speed only starts biting at `speedScaleStartRound`
//     and is hard-capped at `speedScaleMax` (a shambler that outruns a walking player stops being
//     kite-able, and kiting is the whole skill of the genre).
//  2. THE DROP IS NEVER A POP. `spawnMinDistance` + the frustum + line-of-sight test in
//     `rounds/spawner.ts` mean a zombie may only appear where the player cannot see it. Every
//     weight in the SPAWN DIRECTOR block below is a *preference*; the visibility test is a VETO,
//     and it is not tunable from here on purpose.
//  3. THE COMBO REWARDS AGGRESSION, NOT CAMPING. The ladder is set so a competent player holds
//     ×3 comfortably (5 kills, ~3s apart) and only reaches ×5 by committing to 14 unbroken kills
//     — and the window SHRINKS as the multiplier climbs, so the top of the ladder is a tightrope.
//  4. LIVE CAP IS A PERF CONTRACT. `liveCapMax` (25) sits under `ENEMY.maxAlive` (28) with two
//     spare bodies, and the measured budget at 25 alive is 192 draw calls / 434k tris against
//     ARCHITECTURE §6's 350 / 900k. The headroom is real; it is not ours to spend.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const ROUND = {
  // ── THE CURVE ───────────────────────────────────────────────────────────────────────────

  /**
   * Spawn count for round N: `round(spawnBase + N * spawnPerRound)` (GAME_BIBLE §6: ≈ 6 + N*2.2).
   * R1 = 8 · R5 = 17 · R10 = 28 · R20 = 50 · R30 = 72.
   */
  spawnBase: 6,
  spawnPerRound: 2.2,
  /**
   * Hard ceiling on a single round's spawn count.
   *
   * 64 assumed a ~1.5 kill/s pace. The measured pace at the rounds that actually reach the cap
   * is 0.12–0.18 kills/s, which made 64 a five-to-nine-minute round rather than the intended
   * four. With the HP ceiling now doing the TTK work, count is the axis carrying the escalation
   * — but a round still has to END, so the ceiling comes down to a number that is a long fight
   * instead of a chore. Reached at round 19.
   */
  spawnCountMax: 48,

  /**
   * Live-enemy cap, ramped. Round 1 with 25 zombies on screen is not "hard", it is a wall the
   * player never learns from — the early rounds have to be a *rhythm*. The cap opens by
   * `liveCapPerRound` and saturates at `liveCapMax` around round 9.
   * R1 = 13 · R4 = 18 · R9 = 25.
   */
  liveCapBase: 12,
  liveCapPerRound: 1.6,
  /** ARCHITECTURE §6 perf contract. Stays under `ENEMY.maxAlive` (28) with spare bodies. */
  liveCapMax: 25,

  /** Seconds between spawns, and how much that shrinks per round (floor at `spawnIntervalMin`). */
  spawnInterval: 1.6,
  spawnIntervalDecay: 0.045,
  spawnIntervalMin: 0.35,

  /**
   * THE OPENING. Round 1 used to send 8 zombies from a 19–34 m ring at 1.62 m/s on a 1.6 s
   * metronome, 1.9 s after the title card. A new player — who stands still, because nobody has
   * taught them otherwise — got first contact 12–17 seconds in and a 47-second round. Playing
   * forward into them cleared it in a measured 16.0 s. So the opening minute of the game was
   * either empty or over before it registered, depending on a behaviour we never taught.
   *
   * The fix is DENSER, not longer: the first few rounds spawn on a tighter interval and from the
   * near end of the ring, so the whole round is on the street inside ~5 s and the fight is a
   * short sharp one. Note what is NOT tuned here — the visibility veto in `rounds/spawner.ts` is
   * absolute, so "contact in 5 seconds" is not purchasable at any ring distance; the honest
   * target is a ~20–25 s round-1 with the horde assembled early rather than trickling.
   */
  spawnEarlyRounds: 3,
  spawnIntervalEarly: 0.8,
  spawnIdealDistanceEarly: 18,
  spawnMinDistanceEarly: 14,
  /**
   * Max zombies the director may push through in a single spawn tick when it is far under the
   * live cap. Without it, the opening of a late round trickles in one at a time behind a 0.35 s
   * metronome and the horde takes 20 s to assemble. 3 fills the street fast without a pop.
   */
  spawnBurstMax: 3,

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *  THE HEALTH CURVE — Call of Duty: World at War / Black Ops, exactly.
   *
   *      round 1        = 150 HP
   *      rounds 2 … 9   = previous + 100          (250, 350, 450, 550, 650, 750, 850, 950)
   *      round 10 +     = previous × 1.1          (compounding, forever)
   *
   *  R1 150 · R5 550 · R10 1045 · R15 1683 · R20 2711 · R25 4365 · R30 7030.
   *
   *  WHY THIS EXACT SHAPE, and not the smooth exponential we shipped. Treyarch's curve has a
   *  KNEE, and the knee is the design. The +100 stretch is FLAT in ratio terms — round 2 is
   *  1.67× round 1, but round 9 is only 1.13× round 8 — so the first nine rounds get steadily
   *  EASIER relative to the round before them, which is exactly the "I'm getting good at this"
   *  slope a new player needs. Then round 10 flips to a constant 10% compound and every round
   *  after it is the same amount harder than the last, forever. A single smooth exponent (what
   *  `hpExponent: 1.06` was) cannot produce both halves, and what it produced instead was a
   *  first ten rounds that were too soft and a saturation cap that made round 20 and round 40
   *  numerically identical.
   *
   *  THE THING THE LEAD MUST KNOW, stated plainly rather than hidden in a cap: the inkslinger
   *  does 105 to a head, so this curve is 2 headshots at R1, 6 at R5, 10 at R10, 17 at R15 and
   *  26 at R20. In CoD you answer round 15 with Pack-a-Punch; here `weapons/defs.ts::UPGRADE`
   *  exists (`damageMult` 2.1 → 220/head, i.e. 8 headshots at R15) but nothing in M3 sells it.
   *  THE CURVE IS NOT THE PROBLEM — the missing damage economy is, and capping HP to hide it is
   *  what produced the previous build's flat late game. `hpCapRound` below is the one-number
   *  escape hatch if the human wants the old behaviour back before M4 lands the upgrade.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  /** Round 1 health. `EnemyDef.health` matches it, so `hpScale` is 1.0 at round 1. */
  hpRound1: 150,
  /** Flat addition per round through `hpLinearUntil`. */
  hpAddPerRound: 100,
  /** Last round of the +100 stretch. Round `hpLinearUntil + 1` is the first compounding one. */
  hpLinearUntil: 9,
  /** Compound factor from `hpLinearUntil + 1` on. CoD's is exactly 1.1. */
  hpGrowth: 1.1,
  /**
   * Round past which health STOPS growing. 0 = never (CoD's own behaviour, and the default).
   * Set it to e.g. 15 to freeze the late game at 1683 HP while the damage economy is missing —
   * one number, one place, and the curve below it is untouched.
   */
  hpCapRound: 0,
  /** Absolute numeric guard. CoD clamps around 1e6 too; nothing reaches it before round ~100. */
  hpMax: 1_000_000,

  /**
   * ═══ SPEED SCALING IS NO LONGER THE SPEED AXIS ═══
   *
   * `enemies/defs.ts::SPEED_TIERS` + `TIER_MIX` now carry the whole escalation: a per-instance
   * walk / walker / runner / sprinter tier rolled at spawn from a round-driven distribution,
   * exactly as CoD does it. That takes the horde from a single 1.62–2.51 m/s band to a mix
   * spanning 1.62–4.13 m/s that shifts fast as the rounds climb.
   *
   * What is left here is a small late-game creep on TOP of the tier, so rounds past the point
   * where the mix saturates (~17) still have somewhere to go. Kept tiny and kept late: the
   * sprinter tier is already 76% of the player's walk, and `speedScaleMax` 1.12 puts the
   * absolute worst case at 4.63 m/s — still under 5.4, so a straight line is still an escape and
   * a train is still trainable. That last clause is the entire reason for the cap.
   */
  speedPerRound: 0.012,
  speedScaleStartRound: 12,
  speedScaleMax: 1.12,

  // ── THE BEAT (GAME_BIBLE §6: horde silence → title card → intermission → the drop) ───────

  /**
   * Seconds of nothing after the last kill of a round, before `round:cleared` fires. THE
   * SILENCE. It is the most valuable second in the loop: it is what makes the player exhale
   * and notice they want another one. Do not shorten it to "tighten the pacing".
   */
  clearSilence: 1.5,
  /**
   * Intermission length: the breath, the boon draw, the spend window.
   *
   * THE BIBLE SAYS 7 AND M3 SHIPS 5, deliberately. Seven seconds is right once the player has
   * something to DO with them — pick a boon, buy a wall gun, spin the box. In M3 none of those
   * exist yet, so seven seconds of an empty street plus `clearSilence` plus `roundOpenDelay` is
   * 10.4 s of nothing between rounds, which is where "one more round" goes to die. Put it back
   * to 7 the moment M4 lands the boon draw.
   */
  intermissionTime: 5,
  /** How long the round title card holds. The HUD owns drawing it; this is the timing. */
  titleCardTime: 2.4,
  /**
   * How long the panel frame stays closed on `round:cleared` — the last-kill beat. It lived as a
   * bare `1100` in `main.ts`, which is exactly the kind of feel number that drifts away from the
   * beat it belongs to. Seconds.
   */
  clearPanelHold: 1.1,
  /**
   * Delay from `round:start` (and its title card) to the FIRST spawn of the round. The card
   * must be over before anything moves, or the beat is stepped on.
   */
  roundOpenDelay: 1.9,
  /** Seconds into the intermission before the boon cards are dealt. */
  boonDrawDelay: 1.2,
  /**
   * If the player never picks, stop waiting after this. It was 25 s — a quarter of a minute of
   * the game holding still while the player reads three cards they have probably already read.
   * The drain bar makes the deadline legible, and 15 s is comfortably longer than a real read.
   */
  boonDrawTimeout: 15,
  /**
   * Floor on how soon the BACK COVER may be dismissed — nothing else, and deliberately SHORT.
   *
   * It used to gate the restart itself, counted from the moment of death, which meant pressing
   * SPACE on the back cover bought you a measured 3.47 s of dead air standing in an empty
   * street — the exact moment the "one more round" impulse has to be paid off. `tickGameOver`
   * now restarts the instant a living player exists, and the summary owns its own dismissal
   * (`ui/cards.ts`).
   *
   * What is left is one real hazard: SPACE is also JUMP. Dying mid-air with the jump key going
   * would otherwise dismiss the summary before the player has read a single number. This is the
   * guard against that, and nothing more — long enough to outlive a keypress in flight, far too
   * short to be felt as a wait.
   */
  gameOverHold: 0.35,

  // ── SPAWN DIRECTOR (GAME_BIBLE §6: "out of the player's view, away from their kite path") ─
  //
  // Weights are PREFERENCES over the arena's 24 spawn points. The visibility veto lives in code.

  /** Nothing may ever materialise closer than this, visible or not. */
  spawnMinDistance: 16,
  /**
   * The distance the director aims for. A shambler walks at 1.62 m/s, so 25 m is a ~15 s
   * approach — long enough to watch them come, short enough that a round is a fight and not a
   * commute. Raise it and the early game goes quiet; drop it below ~18 and they arrive on top
   * of you before you have heard them.
   */
  spawnIdealDistance: 25,
  /** Beyond this a spawn point is a 40-second walk and the round stalls. */
  spawnMaxDistance: 95,

  /**
   * THE RING. The arena's 24 authored `enemySpawns` all sit on the 140 m perimeter — MEASURED,
   * the nearest is 46 m from the player's own spawn — so a director restricted to them makes
   * the first zombie of every round arrive half a minute late. These are the director's own
   * generated candidates: `spawnRingSamples` points around the player between the two radii,
   * regenerated every pick, each one validated for ground and for a body-sized gap before use.
   */
  spawnRingSamples: 14,
  spawnRingMin: 19,
  spawnRingMax: 34,
  /**
   * Score bonus an AUTHORED door gets over a generated ring point. Small on purpose: "they came
   * out of the alley" reads better than "they were behind that car", but not so much better
   * that the director walks the horde in from 90 m to get it.
   */
  spawnDoorBonus: 0.5,
  /**
   * Degrees added to the camera's own horizontal half-FOV before a spawn point counts as "in
   * view". Covers the player flicking their aim during the spawn frame and the fact that a
   * zombie is 1.85 m tall, not a point.
   */
  spawnViewMarginDeg: 14,
  /** Preference for spawning behind the player (1 = directly behind). */
  spawnBehindWeight: 2.4,
  /** Preference for spawning AWAY from the direction the player is travelling — the kite path. */
  spawnKiteAvoidWeight: 1.5,
  /** Preference for `spawnIdealDistance`. */
  spawnDistanceWeight: 1.1,
  /** A little noise so a round never spawns the same door in the same order twice. */
  spawnScoreJitter: 0.35,
  /** How many top-scoring points get the (expensive) line-of-sight test. */
  spawnCandidates: 6,
  /** Metres of scatter around the chosen point, so ten from one door don't stack. */
  spawnJitter: 1.7,
  /**
   * Consecutive failed spawn attempts after which the director stops being fussy and will use
   * the most-behind point beyond `spawnDesperationDistance` even if it is technically in frame.
   * A zombie appearing 60 m away at an alley mouth reads as "they walked in", not as a pop —
   * and a round that never spawns anything is a far worse bug than a distant materialisation.
   */
  spawnDesperationTries: 14,
  spawnDesperationDistance: 45,

  // ── POINTS (GAME_BIBLE §5) ──────────────────────────────────────────────────────────────

  pointsHit: 10,
  pointsKill: 60,
  pointsCritKill: 100,
  /** Cleared a round without being touched. The single biggest skill payout in the economy. */
  pointsPerfectRound: 250,
  /** Flat reward for surviving the round at all — the beat needs a number to punch up. */
  pointsRoundClear: 75,
  /** Bonus per EXTRA kill inside `multiKillWindow` (2 kills = +40, 3 = +80, 4+ = +120). */
  pointsMultiKill: 40,
  multiKillWindow: 1.1,
  /**
   * Where the multi-kill count stops counting. MEASURED without it: eight kills chained inside
   * the window paid 4,945 points at round 1, because the bonus grows linearly with the chain
   * AND is then multiplied by the combo — and a NUKE, which kills 25 bodies in a single frame,
   * would have paid roughly 30,000 on its own. A multi-kill is meant to reward a good shotgun
   * angle, not to be the whole economy. Capped at 4 it tops out at +120 before the combo.
   */
  multiKillMax: 4,
  /** Flat reward for a NUKE, on top of the ~25 kills it pays out. */
  pointsNuke: 400,
  /**
   * Whether the combo multiplier applies to per-HIT points as well as to kills.
   * FALSE, deliberately: at ×5 a 10-point body shot becomes 50, which pays a player more for
   * spraying a brute than for killing four shamblers. The combo is a KILL-chain reward.
   */
  comboAppliesToHits: false,

  // ── COMBO METER (GAME_BIBLE §5) ─────────────────────────────────────────────────────────

  /**
   * THE LADDER: consecutive-kill counts at which the multiplier steps to ×2, ×3, ×4, ×5.
   * Tuned against the brief "a competent player holds ×3 comfortably, ×5 only by committing":
   * ×3 is 4 kills (one good kite pass), ×5 is 10 unbroken kills — a real commitment, but one
   * that FITS INSIDE THE ROUND. A flat "every 4 kills" ramp made ×5 either trivial or
   * unreachable depending on the round size; an explicit ladder lets the bottom be generous and
   * the top be a tightrope.
   *
   * IT WAS [2, 5, 9, 14] AND THE TOP HALF WAS UNREACHABLE. Rounds 1/2/3 spawn 8/10/13 zombies —
   * fewer than 14 — so ×5 was impossible before round 4 BY ARITHMETIC, and from round 6 it was
   * impossible in practice because TTK plus a 1.55 s reload every three kills exceeds the
   * window. Measured peak multiplier across every sample: ×3 at R1 (max chain 6), ×3 at R5
   * (chain 7), ×2 at R10, ×2 at R20. The ×4 and ×5 badge art existed and had to be driven from
   * the console to be seen at all. 10 fits inside round 2's spawn count and inside a good kite
   * pass at round 10.
   */
  comboLadder: [2, 4, 7, 10],
  comboMaxMultiplier: 5,
  /**
   * Seconds of grace between kills at ×1 (GAME_BIBLE §5 says 3), and at the top of the ladder.
   * The window CLOSES as the multiplier climbs, which is what stops ×5 being a state you park
   * in. Raise `comboWindowAtMax` toward `comboWindow` if the human says the top feels unfair.
   */
  comboWindow: 3.2,
  comboWindowAtMax: 2.2,
  /**
   * …AND THE WINDOW STRETCHES WITH THE ROUND'S OWN TTK.
   *
   * A flat window converts a difficulty increase into a combo DECREASE: a round-10 zombie takes
   * ~2.5× as long to kill as a round-1 one, so the same 2.2 s that is a tightrope at round 1 is
   * arithmetically unsurvivable at round 10 no matter how well the player plays. The director
   * feeds `ComboMeter.setRoundScale(sqrt(hpScale))` each round and the window is multiplied by
   * it — square root, not linear, so the window grows more slowly than the kill takes and the
   * top of the ladder stays a tightrope instead of becoming free. This is the ceiling on that
   * stretch: R1 ×1.00 · R5 ×1.31 · R10 ×1.58 · R15+ ×1.80.
   */
  comboWindowRoundScaleMax: 1.8,

  // ── POWER-UP DROPS (GAME_BIBLE §5) ──────────────────────────────────────────────────────

  /**
   * Chance a kill drops a power-up. 0.045 ≈ one per 22 kills ≈ roughly one a round early on.
   * Raise it and drops stop being an event; drop it and the human never sees a NUKE.
   */
  powerupChance: 0.045,
  /**
   * PITY COUNTER. A pure 4.5% roll has a 20% chance of going 35 kills dry, and a run where the
   * player never sees the mechanic is a run where the mechanic does not exist. After this many
   * dry kills the next one drops, guaranteed.
   */
  powerupPityKills: 32,
  /** Seconds a drop sits on the ground, and how long it blinks before expiring. */
  powerupLifetime: 22,
  powerupBlinkTime: 5,
  /** Live drops allowed at once, and the pooled meshes behind them. */
  powerupMaxLive: 3,
  powerupPoolSize: 6,
  /** Pickup radius, m. Generous — chasing a pickup through a horde must never feel finicky. */
  powerupPickupRadius: 2.4,

  /** Hover height above the ground, m, and the bob amplitude around it. */
  powerupHoverHeight: 1.15,
  powerupBobAmp: 0.16,
  /**
   * ART §4.1 + §8. The pickup's spin and bob are QUANTISED to this frame rate and this many
   * spin positions, so between ticks the object is bit-identical and the print does not crawl.
   * It is also simply how a comic animates: hold frames, not interpolation.
   */
  powerupAnimFps: 12,
  powerupSpinSteps: 24,
  powerupSpinPeriod: 3.6,
  powerupBobPeriod: 2,
  /** Star backing radius and label card height, m. */
  powerupStarRadius: 0.62,
  powerupCardHeight: 0.34,

  /** Durations of the timed power-ups, seconds. */
  powerupDoublePointsTime: 30,
  powerupInstaKillTime: 30,
  powerupCarnageTime: 30,
  /** DOUBLE POINTS multiplier. Multiplies the combo, it does not replace it. */
  doublePointsMult: 2,

  /** NUKE presentation: the screen flash, the shake and how long the world stays rung. */
  nukeFlash: 1.15,
  nukeShake: 0.85,
  nukeShakeTime: 0.9,
  nukeHitstop: 0.09,

  // ── SURGE — every Nth round (GAME_BIBLE §6) ─────────────────────────────────────────────
  //
  // M4 SEAM: the bible's surge is "mixed specials, arena hazard, doubled rewards". Only the
  // Shambler exists in M3, so the surge scales what we have and doubles the payout; the
  // composition half switches on with `specialsEnabled` below.

  surgeEvery: 5,
  surgeSpawnMult: 1.25,
  surgeHpMult: 1.1,
  surgeSpeedMult: 1.06,
  surgeRewardMult: 2,

  // ── COMPOSITION — LIVE ──────────────────────────────────────────────────────────────────
  //
  // A kind earns a place in the mix when it changes what the player DOES, not when it has a stat
  // block. Three qualify:
  //
  //   sprinter  a genuine speed threat with its own lean silhouette (bodyScale 0.92)
  //   brute     a wall you cannot push (mass 3) and cannot miss (bodyScale 1.28)
  //   screamer  a DECISION: it never swings, it calls four more bodies, and staggering it
  //             cancels the call. The first thing in the game that punishes tunnel vision.
  //
  // THE SPITTER IS STILL GATED, on the reasoning this comment block has carried since M3: a
  // spitter that does not spit is just a pink shambler, and `HOT` is reserved by ART §9 for a
  // threat the player must read *differently*. Spending the reserved hue on something that
  // behaves identically to the mass is worse than not shipping it. It joins the mix the day it
  // gets a projectile — set `spitter` below to its intro round then, and nothing else changes.

  specialsEnabled: true,
  /**
   * First round each special may appear in. `spitter` is parked past any reachable round rather
   * than deleted, so the table still documents the intent and the gate is one number.
   *
   * The screamer comes in at 8 rather than 12: it is the most interesting thing in the set and
   * the one that teaches priority-targeting, and a mechanic the player meets for the first time
   * at round 12 has already had eleven rounds to learn the wrong habit.
   */
  specialIntroRound: { sprinter: 4, brute: 7, spitter: 9999, screamer: 8 },
  /**
   * Share of a round's spawns each special takes once introduced, growing per round after its
   * intro, capped. Shamblers always take the remainder — the mass is never not the mass.
   */
  specialSharePerRound: 0.012,
  specialShareMax: 0.22,

  // ── META (GAME_BIBLE §7) ────────────────────────────────────────────────────────────────

  /** ONE namespaced localStorage key holds the whole persistent meta blob. */
  metaKey: 'cz.meta.v1',
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// VFX — M2 owner: vfx agent. Densities and lifetimes. ART_DIRECTION §5 is the law on the LOOK
// ("shapes, not soft particles"); this block only decides HOW MUCH, HOW LONG and HOW MANY.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO CONSTRAINTS EVERY NUMBER IN HERE IS FITTED TO
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// 1. ART §4.1 — THE STILLNESS TEST. Effects animate while they are ALIVE; nothing animates at
//    REST. There is no idle shimmer, no ambient emitter and no per-frame random anywhere in
//    `src/game/vfx/**`. The one thing that outlives its own animation is the DECAL, and a decal
//    that has settled is part of the print: its fade is QUANTISED to `decalFadeSteps` flat
//    levels (a colourist's flats, not a dissolve), so a settled decal is bit-identical frame to
//    frame and the instance buffer is not even re-uploaded. See `decals.ts`.
//
// 2. THE DRAW-CALL BUDGET (ARCHITECTURE §6: ≤350 calls with 25 zombies alive). Every family
//    below is ONE `InstancedMesh` sharing ONE atlas — the whole VFX layer is 6 draw calls plus
//    at most `wordPool` word-pop billboards, and 0 draw calls when nothing is on screen
//    (an empty family sets `mesh.visible = false`). The pool sizes are therefore free to be
//    generous: a card costs 2 triangles and one 4×4 matrix write, not a draw call.
//
// Pool sizes are HARD CAPS, not hints. When a pool is empty the effect is dropped rather than
// grown — a frame that silently allocates is a frame that hitches later.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const VFX = {
  /**
   * Global density multiplier — the quality-tier switch scales this, nothing else.
   * Multiplies every per-event particle COUNT (never a lifetime, never a size), so turning it
   * down thins the spray without changing the timing of anything the player reads.
   */
  density: 1,

  // ── POOLS ────────────────────────────────────────────────────────────────────────────────
  // One `InstancedMesh` per family. `live` never exceeds these; `acquire` returns null at the
  // cap and the effect is simply not drawn. Measured peaks during a 25-zombie fight are in
  // `service.ts`'s debug watch — retune from those, not from guesses.

  pool: {
    /**
     * Billboarded flat cards: impact spikes, ink droplets, dust puffs, drip tails.
     * MEASURED: 272 live with every shot of a 400 rpm magazine connecting on a 25-zombie
     * horde and nothing dying; 500 if all 25 die in the same frame (the NUKE power-up).
     * 640 covers the nuke with the `pressureFloor` taper doing the rest.
     */
    cards: 640,
    /** Muzzle flashes + explosion cores. On LAYER.BLOOM, so this one costs 2 calls, not 1. */
    flashes: 24,
    /** Bullet streaks. One per shot, and they live 0.09 s — 32 is four full magazines in flight. */
    tracers: 32,
    /** Panel shards. MEASURED: 450 wanted by a 25-kill nuke; 384 + the taper covers it. */
    shards: 384,
    /** Digit quads. A damage number is up to `damageNumberMaxDigits` of these. MEASURED peak 95. */
    digits: 128,
    /** Word-pop billboards. THE ONLY family that is not instanced — see the note above. */
    words: 10,
  },

  /**
   * GRACEFUL DEGRADATION. Below half-full a pool spawns at full density; from there it tapers
   * linearly to this fraction at the cap. Without it, a 25-kill nuke starves the card pool 838
   * times and *which* effects survive is decided by nothing but spawn order. With it, the
   * effects thin out evenly and the frame stays a comic panel instead of a wall of pink.
   * Set it to 1 to disable the taper (and watch `vfx starved` in the debug panel).
   */
  pressureFloor: 0.25,

  /** Impact sparks/ink per bullet hit, and their lifetime. */
  impactParticles: 7,
  impactLifetime: 0.5,
  /** Impact spike size range, m. Under ~0.05 a card reads as a speck, not as drawn ink. */
  impactSpikeSize: [0.06, 0.18] as [number, number],
  /**
   * Radius (m) the impact spike-burst card opens to, and how long the burst lasts.
   * 0.11 s is ~7 frames. The muzzle flash gets two frames because it is a flash; an impact is
   * a DRAWN burst and at two frames the player simply never sees it.
   */
  /**
   * MEASURED AND CUT, 0.34 → 0.20. At 0.34 m plus seven spike cards of up to 0.18 m each, at
   * the pistol's real cadence, a firefight at ~4 m stacked into a HOT starburst covering roughly
   * a QUARTER of a 1482×812 frame and completely occluding the zombie being shot. HOT is a
   * RESERVED ENEMY HUE (ART §9), so the largest and most saturated element in a combat frame was
   * a VFX rather than an enemy — the staging contract inverted. The shapes were never the
   * problem; the scale and the colour budget were.
   */
  impactBurstSize: 0.2,
  impactBurstTime: 0.11,
  /**
   * Minimum seconds between two bursts on the SAME target. Overlapping hits still each get
   * their spikes, their number, their hitmarker and their blood — they just stop summing their
   * big burst cards into one screen-filling flare. ~0.12 s is under the pistol's own fire
   * interval, so a single stream of shots is untouched; it is only multi-hit stacking that is
   * capped.
   */
  impactBurstCooldown: 0.12,

  /** Blood/ink splatter per hit and on death. Comic ink, not gore. */
  bloodParticles: 9,
  deathShards: 18,
  deathShardLifetime: 1.4,
  deathShardSpeed: 7,
  /** Panel-shard size range (m) and how fast they tumble, rad/s. */
  shardSize: [0.14, 0.42] as [number, number],
  shardSpin: [3.2, 11] as [number, number],
  /** Gravity applied to shards and to ink droplets, m/s². Heavier than real — comic weight. */
  gravity: 17,

  /**
   * Ink droplet speed range (m/s), size range (m), and how long one arcs before it lands.
   *
   * MEASURED AND RETUNED. The first pass threw 14 droplets at up to 9.5 m/s for 0.75 s with
   * almost no drag: 7 m of travel at 4.5 cm across, which photographs as red confetti spread
   * over half the frame — the exact "soft particle" failure ART §5 forbids, just with hard
   * edges. Blood is INK: fewer marks, each one big enough to read as a DRAWN shape, staying
   * near the body it came out of.
   */
  inkSpeed: [1.6, 5.2] as [number, number],
  inkSize: [0.09, 0.28] as [number, number],
  inkLifetime: 0.55,
  /** Upward kick added to a droplet on top of its spray direction, m/s. */
  inkLift: [0.3, 1.6] as [number, number],
  /** Air drag on a droplet, per second. High: ink is heavy and it does not fly. */
  inkDrag: 1.1,
  /** Fraction of droplets that leave a decal where they land. 1 = all of them. */
  inkDecalChance: 0.55,

  /** Muzzle flash lifetime, s. Two frames at 60fps — a flash you can SEE is a flash that's too long. */
  muzzleFlashTime: 0.045,
  /**
   * Muzzle flash quad height, metres. It is drawn 0.34 m from the eye, so 0.14 m already
   * subtends about a quarter of the screen — a comic muzzle flash is enormous and lasts two
   * frames. Double this and it is the whole frame; halve it and the gun stops going off.
   */
  muzzleFlashSize: 0.14,
  /**
   * Where the flash is drawn, in CAMERA SPACE (+x right, +y up, −z forward).
   *
   * This deliberately does NOT read the viewmodel's rest pose — VFX must never import
   * `weapons/**` (ARCHITECTURE §1) — so it is an independent approximation of where the gun's
   * muzzle sits on screen, fitted to `WEAPON.view.rest*` + the barrel length. If the viewmodel
   * is ever re-posed and the flash detaches from the barrel, THIS is the number to move.
   *
   * BUILD 003 CALIBRATION (integrator). The fitted approximation was 0.044 m inboard of the
   * real barrel — 8.6° at that depth, ~175 px at 1568 wide — so the flash visibly floated to
   * the left of the gun in the composited frame. Replaced with a MEASUREMENT of the `vm-core`
   * tip in camera space, taken over the three frames the flash is actually alive rather than
   * at rest, because the gun is mid-kick the whole time it is on screen:
   *     rest   0.152, −0.117, −0.335
   *     fire+0 0.152, −0.090, −0.290   ← flash spawns
   *     fire+1 0.152, −0.082, −0.279
   *     fire+2 0.152, −0.088, −0.292   ← flash gone by here (muzzleFlashTime 0.045 s)
   * Re-measure the same way if the viewmodel is re-posed:
   *     `vm.root.getObjectByName('vm-core')` → geometry bbox min.z → world → `camera.worldToLocal`.
   */
  muzzleLocal: [0.152, -0.089, -0.287] as [number, number, number],

  /** Tracer travel speed (m/s) and lifetime. Hitscan, so this is pure presentation. */
  tracerSpeed: 220,
  tracerLifetime: 0.09,
  /** Tracer streak length (m) and half-width (m). A streak, never a laser beam. */
  tracerLength: 7,
  tracerWidth: 0.018,
  /**
   * Where a tracer ends when the shot hit nothing at all. The weapon's `range` is 55 m and a
   * clean miss emits no `hit:*`, so the streak needs its own horizon.
   */
  tracerMissDistance: 42,

  /** Word pops ("BLAM!", "SPLAT!"): lifetime, rise distance, and pop-in overshoot. */
  wordLifetime: 0.75,
  wordRise: 1.1,
  wordOvershoot: 1.28,
  /** Fraction of `wordLifetime` spent punching in. The rest holds, then snaps out. */
  wordPopIn: 0.18,
  /** World height (m) of a word pop at scale 1, and how far it drifts toward the viewer. */
  wordHeight: 0.62,
  wordTowardCamera: 0.35,
  /**
   * RATE LIMITS, seconds. Onomatopoeia is a HERO beat — one every few seconds reads as comic,
   * one per bullet reads as a slot machine. Each channel has its own cooldown.
   */
  wordCooldown: { gun: 1.35, crit: 0.42, kill: 0.3, hurt: 1.6, world: 2.4 },
  /**
   * GLOBAL word gate, seconds. Per-channel cooldowns alone let a crit, a kill and an opener
   * land on the same frame — measured, and it prints three overlapping words on top of each
   * other, which is unreadable and un-comic. An inker letters ONE sound at a time.
   */
  wordGlobalGap: 0.26,
  /**
   * A "BLAM!" only fires on the first shot after a lull this long — the opener of a burst,
   * never the middle of one.
   */
  gunWordGap: 0.55,

  /** Floating damage numbers. */
  damageNumberLifetime: 0.85,
  damageNumberRise: 1.4,
  /** Digit height (m) at 1 m, sideways arc (m), and the cap on digits drawn. */
  damageNumberSize: 0.28,
  /**
   * How far a number drifts sideways over its life. Raised from 0.55: in a crowd, numbers from
   * two different zombies were landing on top of each other and reading as one wrong number.
   * The drift angle is rolled per number, so a wider arc separates them.
   */
  damageNumberArc: 0.95,
  damageNumberMaxDigits: 4,
  /**
   * Vertical spread (m) between two numbers born at the same instant, plus a per-number climb
   * rate multiplier. Measured fix: without it, six numbers over a horde all rose from the same
   * height at the same speed and read as one long wrong number ("6897 3525").
   */
  damageNumberStagger: 0.42,
  /** Crits are drawn bigger. Multiplies size only — never the lifetime. */
  damageNumberCritScale: 1.45,
  /**
   * Minimum seconds between two damage numbers on the SAME enemy. Below this the newer number
   * is merged into the older one (its value is added) so a full magazine reads as one
   * accumulating count instead of twelve overlapping sprites.
   */
  damageNumberMerge: 0.18,

  /** Footstep dust puff amount at walk / sprint / slide / landing. */
  dustWalk: 3,
  dustSprint: 6,
  dustSlide: 14,
  dustLand: 10,
  /** Dust puff lifetime, size range (m), rise speed (m/s) and outward drift (m/s). */
  dustLifetime: 0.5,
  dustSize: [0.16, 0.44] as [number, number],
  dustRise: 0.8,
  dustSpread: 1.5,

  /** Decal budget — decals are the cheapest way to make a fight look like it HAPPENED. */
  maxDecals: 220,
  decalFadeTime: 14,
  /**
   * ART §4.1: A SETTLED DECAL IS PART OF THE PRINT AND MUST BE FROZEN.
   *
   * A continuous 14 s fade is a per-pixel change every frame across every decal in the frame,
   * which is precisely the "every pixel jumping" failure. So the fade is quantised: a decal
   * sits at one of this many flat opacities, changing `decalFadeSteps` times in its whole life
   * instead of 840 times. Between steps the instance buffer is not re-uploaded at all.
   * Flat tones are also simply what ink on newsprint does.
   */
  decalFadeSteps: 4,
  /** Decal size ranges (m) for a bullet mark, a blood splat and a big death pool. */
  decalSizeBullet: [0.16, 0.28] as [number, number],
  decalSizeBlood: [0.28, 0.7] as [number, number],
  decalSizeDeath: [1.1, 1.9] as [number, number],
  /** How far a decal is pushed off its surface, m. Big enough to beat depth precision at 60 m. */
  decalOffset: 0.022,

  /**
   * FULL-SCREEN FLASH — and the reason these are much smaller than they look.
   *
   * `renderer.flash` decays at 6.6/s, so an intensity of `i` covers the frame for `i/6.6`
   * seconds. The overlay applies it as `mix(c, colour, i*0.92) + colour*i*0.35`, i.e. an
   * intensity of 0.18 is a 17% wash over the WHOLE frame.
   *
   * At 400 rpm a headshot lands every 150 ms. A 0.18 flash lasting 27 ms on each of those is a
   * **7 Hz full-screen colour strobe** — squarely inside the photosensitivity band and a direct
   * ART §10 violation ("nausea is a bug with the highest severity we have"). So:
   *
   *   • a crit gets NO full-screen flash at all. It gets a bigger HOT spike burst, a 1.45×
   *     HOT damage number, a CRACK! and the weapon's hitstop. That is already four channels.
   *   • a KILL gets a small flash, and `flashGap` guarantees a multi-kill is ONE flash.
   *   • the flash frame is PAPER, per ART §5's "1-frame white flash frame". HOT is reserved
   *     for the one flash that means danger: the player being hit.
   */
  flashCrit: 0,
  flashKill: 0.08,
  flashHurt: 0.22,
  /** Minimum seconds between two full-screen flashes. The anti-strobe gate. */
  flashGap: 0.22,
  /** Explosion flash, and the `fx:shake` a kill / crit / explosion asks the camera for. */
  flashExplosion: 0.45,
  shakeKill: 0.16,
  shakeKillTime: 0.22,
  shakeExplosion: 0.85,
  shakeExplosionTime: 0.5,
  /**
   * `fx:shake` at or above this amplitude also pulses HOT speed lines for `bigHitLineTime`
   * seconds (ART §5: "speed lines ramp in on big hits"). Below it, a shake is just a shake.
   */
  bigHitShake: 0.5,
  bigHitLines: 0.55,
  bigHitLineTime: 0.3,

  /** Explosion: card count, shard count, and the fireball's peak radius as a fraction of `radius`. */
  explosionCards: 26,
  explosionShards: 14,
  explosionCoreScale: 0.85,
  explosionTime: 0.4,
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// VISUAL ESCALATION — "so people dont get bored quick" (BUILD 007).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
//  A SINGLE UNCHANGING ARENA IS THE FASTEST WAY TO BORE SOMEONE, no matter how good it looks
//  the first time. Round 15 has to LOOK different from round 1, and the difference has to be
//  cumulative — a curve the player rides, not a switch that flips.
//
//  THE THREE ERAS, and they fall straight out of `curve` below rather than being three
//  hand-authored presets (a preset is a switch; a curve is a slide):
//
//      rounds 1–5    t ≤ 0.14   a cool sodium-lit night. The shipped look, untouched.
//      rounds 6–12   t 0.2–0.7  the sky bruises, lamps start failing, the grade hardens
//      rounds 13+    t → 1      genuinely apocalyptic: ember horizon, a third of the city's
//                               practicals dead, soot on the plate, a tight hot vignette
//
//  ═══ THE THREE CONSTRAINTS EVERY NUMBER BELOW IS FITTED TO ═══
//
//  1. **ART §4.1 — STILLNESS.** Every one of these values is recomputed exactly ONCE, in
//     `RoundSystem.beginRound`, and then held perfectly still for the whole round. There is no
//     per-frame term, no lerp-toward, no clock anywhere in the escalation path. A creeping
//     grade is the human's single loudest past complaint and it is not coming back. The look
//     changes BETWEEN rounds; within a round the frame is bit-static.
//
//  2. **ART §9 — RESERVED CHANNELS.** `ACID` and `HOT` belong to enemies. The apocalyptic sky
//     is driven toward `RUST` (SEMANTIC.fire — explicitly NOT reserved), with `HOT` allowed
//     only in `skyEmberHot`: the narrow horizon rim, which the sky shader already multiplies by
//     0.22 and which is 60+ metres behind anything a player shoots. Nothing large, near or
//     mid-frame may take a reserved hue. Verified with the squint probe, not asserted.
//
//  3. **THE VALUE STRUCTURE MUST SURVIVE.** The consistency pass measured the frame back into
//     shape; an apocalyptic round 20 that collapses into a two-value void undoes it. So the
//     AMBIENT FLOOR barely moves (`ambientGainPeak` 0.94 — it is the height of the floor the
//     whole frame stands on, see `world/lighting.ts::AMBIENT_LEVEL`), failing lamps DIM rather
//     than switch off (`lampFailDim`), and the horizon glow comes UP as the key comes down so
//     the frame loses warmth from the top and regains it at the back.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const VISUAL_ESCALATION = {
  /** Master switch. `false` pins every round at the round-1 look. */
  enabled: true,

  /**
   * The round the look is fully escalated at, and holds from. 15 because that is the number the
   * human said out loud ("round 15 look different from round 1") and because the combat pass put
   * the speed-tier mix at saturation there too — the picture and the fight peak together.
   */
  peakRound: 15,
  /**
   * Ease on `t = ((round-1)/(peakRound-1)) ^ curve`. ABOVE 1 ON PURPOSE — the change is
   * back-loaded so the opening rounds stay the clean sodium night the whole art direction was
   * tuned against, and the escalation is something the player earns rather than something that
   * starts happening immediately. At 1.6: round 5 → 0.14, round 10 → 0.49, round 15 → 1.
   */
  curve: 1.6,

  // ── SKY ──────────────────────────────────────────────────────────────────────────────────
  // Drives the `SkyMaterial` uniforms through `ArenaLighting`. The sky is a fifth of the frame
  // and it is the cheapest large-area change available: no geometry, no draw call, no pass.

  /** How far the horizon glow (`uGlow`) rides SODIUM → RUST → HOT. */
  skyEmberRust: 0.85,
  /** …and then the last leg toward HOT. Small: this is the only reserved hue in the sky. */
  skyEmberHot: 0.30,
  /** Gain on the horizon glow at peak. It gets BRIGHTER as the key light dies — see §3 above. */
  skyGlowGainPeak: 2.6,
  /** How far the zenith sinks toward INK. The top of the sky closes down. */
  skyDeepenPeak: 0.48,
  /** How far the horizon band itself warms NIGHT_B → RUST. */
  skyHorizonEmberPeak: 0.34,
  /**
   * ADDED to whatever cover the arena authored (0.38 today). Relative, not absolute, so this
   * section cannot silently drift away from `world/arena.ts` if the sky is ever re-authored.
   */
  cloudAddPeak: 0.38,
  /** MULTIPLIES the arena's star density. The overcast swallows them. */
  starMulPeak: 0.21,

  // ── FOG ──────────────────────────────────────────────────────────────────────────────────
  // Aerial perspective is a VALUE tool before it is an atmosphere tool (see `lighting.ts`), so
  // this is the escalation's main lever on depth. Enemies are `fog: 0` and never fade, so
  // tightening the fog RAISES enemy contrast against the city rather than hiding a threat.

  /** How far the near fog colour warms NIGHT_B → RUST. */
  fogNearEmberPeak: 0.30,
  /** …and the far fog colour, which is also the value the backdrop resolves to. Kept smaller. */
  fogFarEmberPeak: 0.16,
  /**
   * Fog far distance at peak, metres, as a FRACTION of the arena-derived range. 0.80 pulls a
   * 230 m range in to 184 m — the far perimeter starts to go, the world closes in, and the
   * 198 m diagonal is still not fully fogged (which would erase the whole rescale).
   */
  fogFarScalePeak: 0.76,
  /** Same for fog near. Slightly stronger, so the banded steps bunch toward the player. */
  fogNearScalePeak: 0.74,

  // ── THE LIGHT RIG ────────────────────────────────────────────────────────────────────────

  /** How far the warm key rides toward RUST. The sodium street light turns to firelight. */
  keyEmberPeak: 0.55,
  /** Multiplier on key intensity at peak. The city stops being well lit. */
  keyGainPeak: 0.94,
  /** Multiplier on the cool fill. The pretty teal bounce retreats hardest. */
  fillGainPeak: 0.82,
  /**
   * Multiplier on the AMBIENT FLOOR. 0.94, and it is deliberately the smallest move in the
   * file: `AMBIENT_LEVEL` is what keeps every shadow-side surface above
   * `READABILITY.ENV_VALUE_FLOOR`. Drop this to 0.8 and round 20 measures as BUILD 001 did.
   */
  ambientGainPeak: 1.0,
  /** How far the ambient floor's hue warms toward RUST. Bruised darks, same value. */
  ambientEmberPeak: 0.30,

  // ── THE CITY ACCUMULATES DAMAGE ──────────────────────────────────────────────────────────
  // Procedural, deterministic, and free: every practical carries a per-lamp hash baked into its
  // glow geometry, and one uniform decides how many of them are below the cut. Same hash on the
  // CPU drives the real `PointLight`, so the drawn light and the sampled light never disagree.

  /** Fraction of practicals that have failed by peak. 0.30 = roughly one lamp in three. */
  lampFailPeak: 0.36,
  /**
   * What a "failed" lamp drops to, NOT zero. A dead lamp removes its ground pool, and a pool is
   * what makes a light read as landing on a floor — kill 30% of them outright and the streets
   * lose 30% of their staged islands, which is the value collapse §3 forbids. A guttering lamp
   * at 0.26 still lays a shape; it just stops being a place you want to stand.
   */
  lampFailDim: 0.26,
  /** How far the surviving SODIUM practicals ride toward RUST. GOLD lamps never move (§9). */
  lampEmberPeak: 0.40,

  // ── THE GRADE ────────────────────────────────────────────────────────────────────────────
  // All existing `passes/grade.ts` uniforms — no new shader code, so this composes with
  // everything instead of being a separate overlay laid on top of the picture.

  /** `uGradeContrast`. A harder page as the night gets worse. */
  contrastStart: 1.12,
  contrastPeak: 1.14,
  /** `uGradeSaturation`. The ink gets louder, never muddier. */
  saturationStart: 1.28,
  saturationPeak: 1.46,
  /** `uGradeExposure`. Small — this is the one knob that can eat the midtone band wholesale. */
  exposureStart: 1.22,
  exposurePeak: 1.20,
  /**
   * `uGradeLevels` — posterize steps per channel. 24 → 17 is a CHEAPER PRESS: fewer inks, a
   * coarser separation, the look of a book printed in a hurry. The Bayer dither is still on, so
   * this reads as a rougher screen rather than as banding.
   */
  levelsStart: 24,
  levelsPeak: 21,
  /** How far the shadow tint rides NIGHT_B → HOT. Multiplicative and tiny — see `tintVec`. */
  shadowEmberPeak: 0.55,
  /** How far the highlight tint rides GOLD → RUST. */
  highEmberPeak: 0.60,

  // ── FRAME FURNITURE ──────────────────────────────────────────────────────────────────────

  /** `uVigAmount` / `uVigInner`. The panel closes in on you. */
  vignetteStart: 0.62,
  vignettePeak: 0.68,
  vignetteInnerStart: 0.42,
  vignetteInnerPeak: 0.39,
  /**
   * `uOvSoot` — static ink build-up on the plate, drawn on the frame's own dot lattice at a free
   * plate angle. NOT a particle, NOT a clock: a pure function of `gl_FragCoord`, so it is
   * bit-identical frame to frame (§4.1) and reads as a page that has been through fifteen
   * rounds. Concentrated toward the frame edge where the vignette already lives, so it costs
   * the midtone band almost nothing.
   */
  sootPeak: 0.30,
  /** `uOvSpeedCount` — the comic language gets denser as the rounds get faster. */
  speedCountStart: 120,
  speedCountPeak: 168,

  // ── SURGE ROUNDS GET THEIR OWN LOOK ──────────────────────────────────────────────────────
  // The director already marks them (`ROUND.surgeEvery`). A surge is a PUSH on top of wherever
  // the curve currently is, not a separate preset — so surge round 5 and surge round 20 are
  // both recognisably "the loud one" without either of them leaving its own era.

  /** Extra ember on the sky and the key. This is the beat that says "this one is different". */
  surgeEmber: 0.26,
  /** Extra gain on the horizon glow. */
  surgeGlowGain: 0.45,
  /** Additive push on grade saturation / contrast. */
  surgeSaturation: 0.07,
  surgeContrast: 0.025,
  /** The panel tightens. */
  surgeVignette: 0.035,
  surgeVignetteInner: -0.03,
  /** Extra ember on the surviving lamps — the whole street turns the colour of the round. */
  surgeLampEmber: 0.25,

  /**
   * PLAYING WELL LOOKS LOUDER. One GOLD speed-line pulse the first time a round's combo hits its
   * top multiplier — a one-shot into the renderer's own self-decaying overlay, not a driven
   * uniform, so it obeys §4.1 by construction (it animates while it is ALIVE and nothing at
   * rest). 0 disables it.
   */
  comboPeakLines: 0.55,
};

/**
 * THE ESCALATION STATE — every number the look derives from the round, in one bag.
 *
 * Deliberately SCALARS ONLY, no colours. `game/tuning.ts` owns *how far*; `world/lighting.ts`
 * and `render/pipeline.ts` own *toward what*, because that is where the palette lives and
 * ARCHITECTURE §1.7 says no system file carries a raw hue. That split is also why this type can
 * be `import type`'d by the world and render layers without creating a runtime edge from either
 * of them into `game/**`.
 */
export interface EscalationState {
  /** The round this state was computed for. */
  round: number;
  /** The master curve, 0 at round 1 → 1 at `peakRound`. Every field below is derived from it. */
  t: number;
  surge: boolean;

  // sky
  skyEmberRust: number;
  skyEmberHot: number;
  skyGlowGain: number;
  skyDeepen: number;
  skyHorizonEmber: number;
  cloudAdd: number;
  starMul: number;

  // fog
  fogNearEmber: number;
  fogFarEmber: number;
  fogNearScale: number;
  fogFarScale: number;

  // rig
  keyEmber: number;
  keyGain: number;
  fillGain: number;
  ambientGain: number;
  ambientEmber: number;

  // the city
  lampFail: number;
  lampFailDim: number;
  lampEmber: number;

  // grade
  contrast: number;
  saturation: number;
  exposure: number;
  levels: number;
  shadowEmber: number;
  highEmber: number;

  // frame furniture
  vignette: number;
  vignetteInner: number;
  soot: number;
  speedCount: number;
}

const _esc: EscalationState = {
  round: 1, t: 0, surge: false,
  skyEmberRust: 0, skyEmberHot: 0, skyGlowGain: 1, skyDeepen: 0, skyHorizonEmber: 0,
  cloudAdd: 0, starMul: 1,
  fogNearEmber: 0, fogFarEmber: 0, fogNearScale: 1, fogFarScale: 1,
  keyEmber: 0, keyGain: 1, fillGain: 1, ambientGain: 1, ambientEmber: 0,
  lampFail: 0, lampFailDim: 1, lampEmber: 0,
  contrast: 1, saturation: 1, exposure: 1, levels: 24, shadowEmber: 0, highEmber: 0,
  vignette: 0, vignetteInner: 0, soot: 0, speedCount: 120,
};

const lerp01 = (a: number, b: number, t: number): number => a + (b - a) * t;
const sat01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The whole escalation curve, PURE and allocation-free.
 *
 * Returns a SHARED module-level object — read it now, never retain it. Every consumer copies the
 * few numbers it cares about into uniforms during the same synchronous call, exactly like the
 * event bus's scratch vectors. It is called once per round, so this costs nothing measurable;
 * the reason it is shared rather than fresh is that a per-round allocation in a 40-round run is
 * a per-round allocation, and ARCHITECTURE §1.5 does not carve out an exception for "rare".
 */
export function escalationAt(round: number, surge = false): Readonly<EscalationState> {
  const V = VISUAL_ESCALATION;
  const n = Math.max(1, Math.floor(round));
  const span = Math.max(2, Math.floor(V.peakRound));
  const raw = V.enabled ? sat01((n - 1) / (span - 1)) : 0;
  const t = Math.pow(raw, Math.max(0.05, V.curve));
  const s = surge && V.enabled ? 1 : 0;

  _esc.round = n;
  _esc.t = t;
  _esc.surge = surge;

  _esc.skyEmberRust = sat01(V.skyEmberRust * t + V.surgeEmber * s);
  _esc.skyEmberHot = sat01(V.skyEmberHot * t + V.surgeEmber * 0.5 * s);
  _esc.skyGlowGain = lerp01(1, V.skyGlowGainPeak, t) + V.surgeGlowGain * s;
  _esc.skyDeepen = sat01(V.skyDeepenPeak * t);
  _esc.skyHorizonEmber = sat01(V.skyHorizonEmberPeak * t + V.surgeEmber * 0.35 * s);
  _esc.cloudAdd = V.cloudAddPeak * t;
  _esc.starMul = lerp01(1, V.starMulPeak, t);

  _esc.fogNearEmber = sat01(V.fogNearEmberPeak * t);
  _esc.fogFarEmber = sat01(V.fogFarEmberPeak * t);
  _esc.fogNearScale = lerp01(1, V.fogNearScalePeak, t);
  _esc.fogFarScale = lerp01(1, V.fogFarScalePeak, t);

  _esc.keyEmber = sat01(V.keyEmberPeak * t + V.surgeEmber * s);
  _esc.keyGain = lerp01(1, V.keyGainPeak, t);
  _esc.fillGain = lerp01(1, V.fillGainPeak, t);
  _esc.ambientGain = lerp01(1, V.ambientGainPeak, t);
  _esc.ambientEmber = sat01(V.ambientEmberPeak * t);

  _esc.lampFail = sat01(V.lampFailPeak * t);
  _esc.lampFailDim = V.lampFailDim;
  _esc.lampEmber = sat01(V.lampEmberPeak * t + V.surgeLampEmber * s);

  _esc.contrast = lerp01(V.contrastStart, V.contrastPeak, t) + V.surgeContrast * s;
  _esc.saturation = lerp01(V.saturationStart, V.saturationPeak, t) + V.surgeSaturation * s;
  _esc.exposure = lerp01(V.exposureStart, V.exposurePeak, t);
  _esc.levels = Math.round(lerp01(V.levelsStart, V.levelsPeak, t));
  _esc.shadowEmber = sat01(V.shadowEmberPeak * t);
  _esc.highEmber = sat01(V.highEmberPeak * t);

  _esc.vignette = sat01(lerp01(V.vignetteStart, V.vignettePeak, t) + V.surgeVignette * s);
  _esc.vignetteInner = sat01(
    lerp01(V.vignetteInnerStart, V.vignetteInnerPeak, t) + V.surgeVignetteInner * s);
  _esc.soot = sat01(V.sootPeak * t);
  _esc.speedCount = Math.round(lerp01(V.speedCountStart, V.speedCountPeak, t));

  return _esc;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Aggregate — for a debug UI that wants to walk every section generically.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const TUNING = { PLAYER, MOVE, CAMERA, WEAPON, ENEMY, ROUND, VFX, VISUAL_ESCALATION };

export type TuningSection = keyof typeof TUNING;

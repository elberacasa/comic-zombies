/**
 * LONGSHOT — one weapon, one file: its proportions, its palette and its surfaces.
 *
 * The runtime that consumes this lives in `../viewmodel.ts`; the contract it is written
 * against is in `./types.ts`. Nothing here knows how a box is bevelled or how a material is
 * made — and nothing there knows this weapon exists except through `./index.ts`.
 */

import type { FieldSet, GunProfile, WeaponModelDef, WeaponSkin } from './types';
import { FIELD, plainSteel } from './types';
import { PALETTE, hexMix } from '@/art/palette';

/**
 * LONGSHOT — the longest thing in the game, the only one with a full stock, and the palest
 * object the player will hold all session.
 *
 * ─── FIVE BUILDS, FIVE TIMES THE SAME NOTE, AND WHY FOUR FIXES MISSED ────────────────────
 * "gray lines on top" · "sights too long" · "3 grey thing on top" · "the guns in the top have
 * this sticks like showing out" · "remove and remake a better sight blades that design looks
 * bad and not competitive at all". Five reports across five builds, and every previous pass
 * answered by RESHAPING THE BLADES: the ears went, the rail teeth went, the 120 mm warm rib
 * was cut to 30 mm, the blades were darkened from BONE 0.73 to dark iron, then re-proportioned
 * from 0.14 to 0.67 to 1.13 aspect. The note came back every time.
 *
 * IT CAME BACK BECAUSE ALL FIVE OF THOSE PASSES LEFT THE STALK. Screenshotted with the ink
 * pass off, the previous geometry is unambiguous: two blocks STANDING OFF the receiver on a
 * neck, plus a third out front. Reshaping the block does not fix a shape whose problem is
 * that it RISES. It does not matter how landscape the block is if there is daylight logic
 * under it — the eye reads mass-on-a-neck as an antenna and always will.
 *
 * ─── THE RULE THIS PASS IS BUILT ON: NOTHING MAY RISE ON A NECK ──────────────────────────
 * A sight on this gun may now only be one of two things:
 *
 *   (a) a SOLID BLOCK sitting flush on the receiver with the sight window CUT THROUGH it —
 *       the mass IS the sight and the hole is the picture; or
 *   (b) a window cut DOWN INTO mass the receiver already has, adding nothing that stands.
 *
 * "Flush" is not "zero height" — the line still has to clear the barrel. It means every
 * millimetre of height belongs to a CHUNKY BLOCK that reads as machined into the gun. The
 * test is a single question: could any part of this be mistaken for an antenna? If yes, wrong.
 *
 * EVERY MILLIMETRE BELOW IS A **DRAWN** MILLIMETRE — `z` here is halved by `depthCompress`
 * 0.50 after the builder is done with it, so an authored depth and a drawn depth are two
 * different numbers and only the second one is what the playtester is looking at.
 *
 * ─── WHAT IS THERE NOW: ONE LOW-PROFILE OPTIC HOUSING ────────────────────────────────────
 *   REAR   a single machined OPTIC HOUSING, 48 mm across the receiver's tail, 30 mm
 *          fore-and-aft drawn (`bladeD` 0.060), standing 12 mm proud, with a 22 × 12 × 30 mm
 *          WINDOW cut down through its centre. The window's floor is the receiver's own top
 *          face — it is not a gap between two parts, it is a hole in one part whose bottom is
 *          the gun. Its rear face is flush with the receiver's rear face (both z 0.024) and
 *          its bottom is buried 8 mm inside the top face.
 *   FRONT  the same block language 110 mm forward: 13 × 20 × 30 mm drawn, buried 8 mm into
 *          the receiver, standing the same 12 mm proud, its front face flush with the
 *          receiver's nose at −0.146. It is a machined front block, not a blade.
 *
 * THE PROPORTION, IN THE VIEW THAT ACTUALLY GENERATED THE COMPLAINT. The rest pose shows the
 * player the gun's LEFT FLANK all session, and in that view the housing's two walls overlap
 * into one slab. Side profile, drawn, proud × deep:
 *
 *     44 × 6  (0.14, a flag)  →  18 × 12 (0.67)  →  16 × 18 (1.13)  →  12 × 30 (2.50)
 *
 * The front block is the same 12 × 30 = 2.50. Neither element is portrait in ANY view: the
 * housing wall is 13 wide × 12 proud head-on (1.08) and the front block is 13 × 12 (1.08).
 * There is no axis left along which either one is taller than it is thick.
 *
 * ─── THE HONEST LIMIT: THE WINDOW IS OPEN AT THE TOP ─────────────────────────────────────
 * A *bored* round aperture — mass above the hole as well as beside it — is NOT expressible
 * here and was not faked. The builder pins BOTH sight tops to `sight.lineY` (`lineY − h/2`
 * placement, viewmodel.ts), and `lineY` is also where the ADS solve puts the eye. Any bridge
 * over the window would therefore be exactly at eye height with the hole beneath it, and the
 * player would be sighting on the roof of their own optic. So the window is cut down through
 * the block from its top face: a machined U-channel, closed on three sides by real mass,
 * open on the fourth because the sight line runs through there. See the `sight` note for the
 * one spec that would close it.
 *
 * ─── WHERE THE HEIGHT WENT: `lineY` 0.070 → 0.066 ────────────────────────────────────────
 * Proud height is `lineY` minus the surface under it, so the line is the only lever. 0.066
 * over a 0.054 receiver top is 12 mm of housing proud — the lowest this gun has ever sat and
 * still 15 mm of clearance over the muzzle can's 0.051 top.
 *
 *   · THE AIM SOLVE FOLLOWS IT — see below. `lineY` is an input to the solve, not a tuned
 *     constant, so a lower line is a lower socket and a re-solved ADS translation.
 *   · THE GUN READS BIGGER AT ADS, which §1.5 of the constitution asks for: the receiver's
 *     top edge sits 42 px under the crosshair, against 55 px at `lineY` 0.070 and 156 px two
 *     passes ago (1600 × 821 / 56°, 772 px/rad).
 *   · IT BUYS CLEARANCE RATHER THAN SPENDING IT — see the clearance block.
 *
 * ─── THE AIM SOLVE, PRESERVED BY CONSTRUCTION RATHER THAN BY LUCK ────────────────────────
 * `aimSocketOf()` = `(0, lineY, rearZ × depthCompress)` and `adsOffsetOf()` negates x and y
 * exactly, so `socket + ads` is (0, 0, −adsSightDistance) for ANY `lineY` and ANY `rearZ`.
 * The boot assertion in `assertClearance()` tests precisely that residual and it is
 * identically zero here — moving the line moves the socket and the ADS translation together.
 *
 * The two TOPS stay coincident the same way: the builder places the front block at
 * `lineY − frontH/2` and the housing walls at `lineY − rearH/2`, so both top faces land on
 * the sight line whatever the heights are. Here they are equal (0.020) because both are
 * buried 8 mm into the same 0.054 top face, which is a stronger guarantee still.
 *
 * THE PICTURE, MEASURED. Radius 0.110 authored (`rearZ` −0.006 → `frontZ` −0.116), 0.055
 * drawn, so the window is 0.235 m from the eye and the front block 0.290 m. Half-window
 * 0.011/0.235 = 0.04681 rad; front block half-width 0.0065/0.290 = 0.02241 rad; LIGHT BAR
 * 0.02440 rad per side. The previous geometry gave 0.02416 and the pistol reference the whole
 * sight contract was solved against gives 0.0253. The bar the player actually aims with got
 * 1 % WIDER, and the front block itself went from 28 px to 35 px across — bolder against a
 * 3.5 px sight hull, not thinner.
 *
 * ─── CLEARANCE: THIS PASS BUYS MARGIN ────────────────────────────────────────────────────
 * The model's worst vertices are ones this profile still does not touch: `muzzle.fin3` at
 * 0.389 reach / 0.4087 swayed on the mag floorplate at reload, and the forearm at the near
 * plane (0.096). Neither metric reads y at all, so 4 mm off the sight line is free.
 *
 *   housing      |x| ≤ 0.024 at drawn z −0.018…0.012 — its worst corner ranks far below the
 *                bolt paddle's (|x| ≈ 0.038 at drawn z 0.001, measured 0.3005 / 0.3247)
 *   near plane   housing rear face still 0.024 authored / 0.012 drawn, exactly where the old
 *                block's was, and 84 mm inside the butt pad that actually sets the near metric
 *   front block  |x| ≤ 0.0065 against the old front pad's ±0.009 at the same z — strictly
 *                INSIDE the footprint it replaces, and inside the receiver's own ±0.013 nose
 *   the rib      the 48 × 18 mm pad that used to sit at −0.122 on the top face is GONE (see
 *                the `rib` note), which is the millimetres this pass hands back
 *
 * No forward-most (−z) or right-most (+x) vertex on this model moved. Reach stays 0.389,
 * near stays 0.096.
 *
 * ─── THE SILHOUETTE, STILL FIVE EVENTS ───────────────────────────────────────────────────
 * stock → receiver with an optic housing machined into its tail → bare top → front block →
 * hard step down → bare fluted barrel with a gas block under it → the can. Plus the bolt
 * handle out to the right and the bipod stub under the handguard, the two OUTLINE events.
 */
const PROFILE: GunProfile = {
  id: 'longshot',
  /**
   * The most compressed, because it is authored the longest. 0.50 is MEASURED: at 0.52 this
   * gun reached 0.426 m — past the 0.40 budget AND past `MOVE.radius` (0.42), i.e. it would
   * genuinely have punched the muzzle through walls.
   *
   * UNTOUCHED, and deliberately: the pose that binds it is REST/EQUIP on `muzzle.fin3`, and
   * this profile does not move the muzzle by a millimetre, so there is no headroom here to
   * spend and nothing to gain by re-solving it.
   */
  depthCompress: 0.50,
  restDz: 0.016,
  sight: {
    /**
     * ONE LOW OPTIC HOUSING AND ONE FRONT BLOCK — the header's argument, as numbers. Read that
     * first; this note is the arithmetic, the three floors it is against, and the one spec
     * that is missing.
     *
     * ─── THE SPEC THAT DOES NOT EXIST, STATED PLAINLY ────────────────────────────────────
     * `SightSpec` gives this file exactly three boxes: one at x 0 and a mirrored pair, ALL
     * THREE with their top faces pinned to `lineY` by the builder, all three sharing one
     * `bladeW` and one `bladeD`. A truly BORED aperture needs a fourth box bridging the pair
     * ABOVE the hole, and it needs that bridge to be the only thing at `lineY` while the hole
     * sits below it — which the pinning forbids and which the ADS solve would break anyway,
     * because the eye is AT `lineY` and would be looking at the bridge's top face instead of
     * through the hole. Faking a bridge out of the front blade (moving `frontZ` onto `rearZ`)
     * would give a solid slab with no window and no sight radius. So it was not done.
     *
     * WHAT WOULD CLOSE IT — one part spec, and nothing else needs to change:
     *
     *     opticBlock?: { w, h, d, y, z, boreR, wallMin } | null
     *       one flush block on the receiver top with a ROUND hole bored through it on z; the
     *       builder emits it into `sightParts`, centres the bore on `sight.lineY` (NOT on the
     *       block's top face — that is the whole point), and dev-warns when
     *       min(w/2 − boreR, (y + h/2) − (lineY + boreR)) < INK_FLOOR so the ring wall is
     *       checked on every side rather than by hand in a comment like this one.
     *
     * With that, the rear of this gun becomes a genuine ring: mass above the sight line as
     * well as beside it, and a round hole instead of a square one. Without it, the honest
     * best is a U-channel cut down through one block — which is what is below, and which is
     * still option (b) of the brief: subtractive, and standing on nothing.
     *
     * ─── `lineY` 0.070 → 0.066 ───────────────────────────────────────────────────────────
     * Proud height is `lineY` minus the surface under it, so this is the only lever there is.
     * 0.066 over the receiver's 0.054 top face is 12 mm of housing proud, and 12 mm is also
     * the window's height — the two are the same number by construction, because the window's
     * floor IS the top face. `lineY` is an INPUT to `aimSocketOf()`, not a tuned constant, so
     * the socket and the ADS translation move with it and the boot assertion's residual stays
     * identically zero.
     *
     * IT CANNOT GO LOWER WITHOUT BREAKING THE INK FLOOR, and that is now the binding
     * constraint rather than `guardSightLine()`: at `lineY` 0.064 the window would be exactly
     * 10 mm tall, i.e. sitting on the floor with no margin. 0.066 leaves 2 mm. (The
     * `guardSightLine()` ceiling of `lineY − 0.010` = 0.056 is clear by a wide margin now that
     * the front pad is gone — the tallest thing on the top face is the receiver itself at
     * 0.054, and the RUST hammer spur at 0.0529 behind it.)
     *
     * ─── THE HOUSING: `bladeD` 0.036 → 0.060, `bladeW` 0.011 → 0.013, gap 0.010 → 0.011 ──
     * Every `z` in this file is multiplied by `depthCompress` on the way out of the builder
     * (`place(g, { sz: MODEL_SCALE * P.depthCompress })`, viewmodel.ts) — AFTER every clamp —
     * so a depth authored here is not the depth that is drawn, and on this gun the factor is
     * 0.50, the harshest in the game. `bladeD` 0.060 renders as **30 mm**. Stated in the only
     * space that can be checked against a complaint about what the screen shows:
     *
     *     drawn depth 30 mm · proud 12 mm · side-profile aspect 2.50, both blocks
     *     head-on 13 mm wide × 12 mm proud → 1.08, both blocks
     *
     * The progression on the side profile, which is the view the rest pose shows all session:
     * 0.14 → 0.67 → 1.13 → 2.50. For reference the other three profiles land at 1.01
     * (inkslinger), 1.17 (ratatat) and 2.17 (boomstick); this gun is now the most landscape
     * in the arsenal, which is right, because it is the one that was reported five times.
     *
     * `rearZ` 0.006 → −0.006 is bookkeeping, not a move: the housing's rear face is
     * `rearZ` + `bladeD`/2, so deepening the block by 24 mm pulls its centre back by 12 and
     * the face stays at 0.024, FLUSH with the receiver's own rear face. The nearest sight
     * vertex is exactly where it has been for two passes.
     *
     * `frontZ` −0.122 → −0.116 puts the front block's front face at −0.146, flush with the
     * receiver's nose, with the whole 30 mm of it drawn on the receiver's own top face. It
     * moved BACKWARD relative to its own front face, which is why the clearance table says
     * this pass buys margin.
     *
     * `rearH` and `frontH` are now both 0.020, and equal ON PURPOSE: both blocks stand on the
     * same 0.054 top face and are buried the same 8 mm into it. The builder derives both tops
     * from `lineY` independently, so they are ALLOWED to differ — they simply have no reason
     * to here, and equal heights on a shared host is the strongest form of "machined out of
     * the same piece" the vocabulary can express.
     *
     * ─── THE PICTURE, MEASURED ───────────────────────────────────────────────────────────
     * Radius 0.110 authored (−0.006 → −0.116), 0.055 drawn: window 0.235 m from the eye,
     * front block 0.290 m. Half-window 0.011/0.235 = 0.04681 rad. Front block half-width
     * 0.0065/0.290 = 0.02241 rad. LIGHT BAR 0.02440 rad per side, against 0.02416 for the
     * previous geometry and 0.0253 for the pistol reference the whole contract was solved
     * against — 1 % WIDER than what shipped. At 772 px/rad the front block reads 35 px across
     * and 30 px tall inside a 72 px window, against 28 px across and 40 px tall before: wider,
     * squatter, and with more light either side of it.
     *
     * ─── THE INK FLOOR (0.010 m), EVERY DIMENSION AS DRAWN ───────────────────────────────
     * The builder makes all three of these with `bevelBox` and NOT `inkChunk`, so there is no
     * clamp and no dev warning behind this line — it is checked here or nowhere.
     *
     *     housing wall ×2   0.013 w × 0.020 h × 0.030 d      thinnest 0.013   +3 mm
     *     front block       0.013 w × 0.020 h × 0.030 d      thinnest 0.013   +3 mm
     *     WINDOW (void)     0.022 w × 0.012 h × 0.030 d      thinnest 0.012   +2 mm
     *
     * The void is the high-risk term and it is checked as hard as the mass: its floor is the
     * receiver's own 0.054 top face, its walls are 13 mm of iron either side — 3 mm over the
     * floor on the wall thickness the brief calls out — and it is 30 mm deep drawn. Wider,
     * deeper and thicker-walled than it is tall, in every direction.
     */
    lineY: 0.066, rearZ: -0.006, frontZ: -0.116,
    bladeW: 0.013, rearH: 0.020, frontH: 0.020, bladeD: 0.060, notchHalfGap: 0.011,
  },
  /**
   * 170 mm, cut entirely off the FRONT of an older 200 (rear face still z 0.024) — which is
   * what opens the bare-barrel window between the handguard's nose and the choke. Spans
   * z −0.146…0.024, x ±0.013, y 0.014…0.054, and every top-side part below is placed off
   * those three numbers rather than by eye. 26 × 170 makes it the slimmest long gun by ratio
   * (6.5:1 against the shotgun's), which is the rifle's whole proportion story.
   */
  receiver: { w: 0.026, h: 0.040, d: 0.170, y: 0.034, z: -0.061 },
  /**
   * NONE, AND THAT IS THE MECHANISM SPEAKING. Cocking serrations are a slide's read and this
   * gun does not have a slide — it has a BOLT, which is modelled, sticks out to the right and
   * is the biggest silhouette event on the weapon. Three 1 mm-proud teeth in the band
   * z 0.014…−0.020 would also have interleaved with the port's deflector at −0.030…−0.018 and
   * lost both reads. The rear of this receiver now carries the aperture block on top, the bolt
   * handle to the right, the release lever to the left and the RUST hammer spur behind — it is
   * the busiest 40 mm on the gun without them.
   */
  serrations: 0,
  /**
   * ON THE RECEIVER'S OWN AXIS (y 0.034) and fat at r 0.014: the builder places the muzzle can
   * at `receiver.y`, so anything lower enters the back of the can misaligned, and a 28 mm
   * barrel between a 26 mm receiver and a 34 mm can is the step-UP a heavy barrel wants.
   * Spans −0.114…−0.218, so it bridges the receiver's nose and the choke's rear with 51 mm of
   * bare round in between — the only exposed barrel in the arsenal.
   */
  barrel: { r: 0.014, len: 0.104, y: 0.034, z: -0.166 },
  /**
   * UNTOUCHED. `fin3` is the model's worst vertex in the rest, equip and sprint poses at
   * 0.3941 m against a 0.40 budget — every millimetre this profile spends elsewhere is spent
   * because this line was not touched.
   */
  muzzle: { r: 0.017, len: 0.034, z: -0.218, fins: 4, finW: 0.034 },
  /**
   * UNTOUCHED, and it is the RELOAD pose's worst vertex (measured this build: 0.368 reach /
   * 0.378 swayed on the floorplate — the inherited 0.3792/0.4087 in this note predated the
   * pose work and is corrected here) — the one place on this gun where a millimetre of `h` or
   * `d` comes straight out of `MOVE.radius`. The binding poses are REST and EQUIP at 0.396
   * swayed against `MOVE.radius` 0.42, and SPRINT at 0.078 against the 0.07 near plane.
   * It is also invisible in every other pose: raked at `MAG_RAKE` it
   * spans y −0.102…−0.014 inside a gloved fist that spans −0.102…−0.006, i.e. it is swallowed
   * whole. That is what frees the `magWell` slot for the bipod stub below.
   */
  magazine: { w: 0.022, h: 0.078, d: 0.044, y: -0.058, z: 0.008 },
  tube: null,
  /**
   * THE HANDGUARD — short and pulled back, which is the other half of the barrel window. Its
   * top face at 0.020 overlaps the barrel's underside and the receiver's, so there is no
   * floating gap at either end: three masses reading as one assembly.
   *
   * THREE RIBS, NOT FOUR, AND THE REASON IS THE INK LINE. The builder spaces them across
   * `d × 0.68`; at four on a 76 mm block the gaps fall to 7.6 mm, under the band, and the
   * whole stack prints as one black field. At three the pitch is 25.8 mm and 15.8 mm of
   * handguard shows between 10 mm ribs, so both the rib AND the gap survive the line.
   */
  foreEnd: { w: 0.028, h: 0.032, d: 0.076, y: 0.004, z: -0.112, ribs: 3 },
  /**
   * THE STOCK — the thing no other gun in the arsenal has, so it is authored to be seen: 3 mm
   * of overlap into the receiver's rear face (it was floating 6 mm clear of it once), a comb
   * at 0.044 that reads as a cheek-weld line 10 mm under the receiver's top, 2 mm wider than
   * the receiver so the shoulder is a step on the outline, and the butt pad the builder adds
   * as a second step 3 mm proud of that.
   *
   * It stops SHORT of burying the RUST hammer spur, deliberately: the spur stands 9 mm proud
   * of the comb and it is the rearmost warm mark on the model.
   *
   * NOT DEEPENED. +z is toward the eye, and the butt pad's rear face is already the nearest
   * thing on this gun to the near plane.
   */
  stock: { w: 0.032, h: 0.060, d: 0.118, y: 0.014, z: 0.080, skeleton: false },
  /**
   * THE GAS BLOCK — the `rib` slot, evicted from the top face for good.
   *
   * IT HAD TO MOVE, AND THE REASON IS ARITHMETIC. `rib` is the one warm mark the builder puts
   * at x 0 on the gun's centreline, and every previous incarnation of it lived on the receiver
   * top: a 120 mm bar nose-to-tail (the literal "grey line on top"), then a 30 mm block, then
   * a 48 × 18 mm pad under the front post with its top at 0.059. That last one was legal only
   * against `lineY` 0.070. The new sight line is 0.066, so `guardSightLine()`'s ceiling is
   * 0.056 and the pad is 3 mm over it — but the real objection is worse than the guard:
   * anything on the top face runs FORWARD of the window and is therefore NEARER the eye than
   * the front block at every ray below the line, so a 5 mm-proud pad would appear at −0.0355
   * rad against the front block's base at −0.0414 and eat the bottom quarter of the picture.
   * A warm bar across the top of this gun is also, verbatim, complaint number one of five.
   * There is no height at which it is both visible and harmless. So it leaves the top face.
   *
   * WHERE IT WENT, AND WHY THAT IS A REAL PART RATHER THAN A PARKING SPACE. Under the bare
   * barrel at z −0.178, in the 51 mm window the shortened receiver and the pulled-back
   * handguard open between them: 14 × 16 × 24 mm spanning y 0.006…0.022 and z −0.190…−0.166.
   * Its top overlaps the barrel's 0.020 underside by 2 mm — no floating gap — and it hangs
   * 14 mm below a 28 mm round, which is a gas block, and a gas block is exactly what a
   * semi-auto marksman rifle has at that station. It is also correctly parented: `rib` rides
   * the reciprocating group, and an op-rod block is the one part of a rifle that is SUPPOSED
   * to move when the action cycles.
   *
   * IT CANNOT TOUCH THE SIGHT PICTURE. Its top at 0.022 is 44 mm below the sight line and
   * 32 mm below the receiver's own top face, which already sets the ADS horizon — it is buried
   * under the gun's silhouette at every ray. And it clears both barrel flutes, which live on
   * the SIDE faces at y 0.027…0.041 (`panels`), and the muzzle can's rear at −0.201 by 11 mm.
   *
   * IT COSTS NO CLEARANCE. |x| ≤ 0.007 at z −0.190 authored / −0.095 drawn, against
   * `muzzle.fin3` at |x| 0.017 / −0.1175 drawn: strictly smaller in BOTH terms of
   * `hypot(|x| + sway, z)`, so it cannot become the worst vertex in any pose. Reach stays
   * 0.389, near stays 0.096 — and the pad it replaces is 48 mm of geometry deleted from the
   * receiver's nose, which is where this pass hands margin back.
   *
   * INK FLOOR: 0.014 × 0.016 × 0.012 AS DRAWN (`d` 0.024 × `depthCompress` 0.50), thinnest
   * term 2 mm clear — which needs saying, because the builder makes this one with `bevelBox`
   * and no `inkChunk` clamp behind it, and because the clamp would have validated the
   * pre-compression number anyway.
   */
  rib: { w: 0.014, h: 0.016, d: 0.024, y: 0.014, z: -0.178 },

  /**
   * THE EJECTION PORT — on this gun it is the BOLT'S port, the longest in the game at 44 mm,
   * because a marksman cartridge is long and because the bolt handle 54 mm behind it has to
   * read as the thing that opens it.
   *
   * SIZED BY THE RECEIVER'S SIDE FACE, NOT BY EYE. The receiver spans y 0.014…0.054. At
   * y 0.034 / h 0.020 the top lip tops out at 0.054 and the shelf bottoms at 0.014, so the
   * frame fills the face edge to edge and nothing climbs onto the top face, where the sight
   * picture lives.
   *
   * PLACED BY THE TWO THINGS IT MUST NOT TOUCH: the deflector's rear face lands at −0.018,
   * eleven millimetres clear of the bolt paddle's front face at −0.007, and the front wall at
   * −0.084, sixty-two millimetres inside the receiver's nose. Those are the two proudest steel
   * masses on this flank and they must not fuse into one smear.
   *
   * `shellR` 0.006 is 12 mm of RUST across a 20 mm opening: a rifle case is SLIM. It is the
   * one warm mark on the gun that is not on the outline — a hot dot in the middle of the one
   * rectangle the eye is drawn to, now sitting on COLD steel rather than warm.
   */
  ejectionPort: { h: 0.020, d: 0.044, y: 0.034, z: -0.052, shellR: 0.006 },
  /**
   * THE BOLT HANDLE — the strongest possible "this is a rifle" silhouette event, and the only
   * part on any of the four guns allowed to stick out to the RIGHT.
   *
   * ITS SIZE IS THE BUDGET SPEAKING, and it is affordable only because it sits at z 0.002,
   * essentially on the eye's own depth, where reach is nearly all x: MEASURED, the paddle's
   * worst pose is 0.3005 m reach / 0.3247 swayed against budgets of 0.40 and 0.42. The same
   * 18 mm of stand-off hung off the muzzle end would have blown the budget on its own.
   *
   * PLACED WHERE A BOLT GUN PUTS IT: 11 mm behind the port's deflector and 10 mm forward of
   * the stock's front face, the one window on this flank that is not already spoken for.
   * `thick` 0.013 gives a 14 mm stem and a paddle on the end of it, so the shape ends in the
   * builder's HOOK — a hook survives the ink line and a taper does not.
   */
  chargingHandle: { side: 'right', len: 0.018, thick: 0.013, y: 0.028, z: 0.002 },
  /**
   * THE BOLT RELEASE, built out of the `selector` slot. A round boss with a bar swung off it,
   * on the LEFT of the action, is exactly what a bolt rifle has there — and this gun's
   * fire-selector real estate does not exist, because it does not have a fire selector.
   *
   * The boss straddles the receiver's lower edge, which is what makes it read as a control let
   * INTO the action rather than a button stuck onto it. The lever sweeps 14° down and back to
   * y 0.013, nineteen millimetres above the gloved fist's top edge — the two masses can never
   * fuse, and the eye is already at the thumb.
   *
   * LEFT, because the right flank is spent on the port and the bolt: this gun is a different
   * object from each side, and the rest pose (x +0.125, yaw −14°) shows the player the LEFT
   * face all session.
   */
  selector: { r: 0.008, len: 0.028, thick: 0.012, y: 0.020, z: -0.012, angleDeg: -14 },
  /**
   * THE BIPOD STUB, built out of the `magWell` slot, which this gun's own magazine has no use
   * for (see the note there: it is buried inside the fist).
   *
   * A block with a flared collar under it IS a bipod's mounting lug with its leg pack folded
   * against the barrel, and the slot's `MAG_RAKE` cant of 17° is what sells it as a folded
   * mechanism rather than a box glued on. It hangs from 2 mm up inside the handguard, so there
   * is no floating gap, and the collar is narrower than its host, so it reads as a separate
   * hanging part instead of a thickening of the same one.
   *
   * IT IS THE BOTTOM OUTLINE'S ONLY EVENT FORWARD OF THE TRIGGER GUARD. That edge ran dead
   * straight from the hand to the muzzle and now reads guard → notch → bipod foot → handguard
   * → bare barrel. MEASURED at ~0.349 reach: 51 mm inside the budget, because it is tucked
   * under the handguard's nose rather than hung past it.
   */
  magWell: { w: 0.018, h: 0.022, d: 0.024, y: -0.030, z: -0.132, flare: 0.005 },
  /**
   * NO SIGHT EARS AND NO RAIL TEETH, PERMANENTLY. Both were deleted because together they were
   * the pale bar the playtester asked to have removed, and re-adding either would put back the
   * exact thing the fifth complaint was about: a part that STANDS OFF the receiver. The one
   * structural job the teeth ever did — holding a blade clear of the top face — no longer
   * exists, because nothing on this gun is held up any more: both sight blocks are buried
   * 8 mm INTO the receiver and stand on their own mass. A rail would also cost reach a hood or
   * an ear cannot pay for. Do not re-add them, under any name.
   *
   * TWO BOLD FLUTES PER FLANK, HOSTED ON THE BARREL, in the 51 mm window the shortened
   * receiver and the pulled-back handguard opened between them.
   *
   * THE HOST IS THE POINT. `panels` emits POLYMER, which on this gun is luma 0.212 against a
   * frame of 0.571 — the hardest value break in the arsenal, so a flute cut into the tan
   * barrel is a black slot you can read across the room. On the dark handguard it would have
   * been invisible. `hostHalfW` is the barrel's radius, so each cut stands 2.5 mm proud of a
   * 28 mm round at the equator: a bitten-out step, not a plate.
   *
   * Two of 20 mm at a 30 mm pitch leaves a 10 mm land between them, exactly the ink floor —
   * the GAP has to survive the line as well as the cut does. BOTH flanks, deliberately: a
   * barrel fluted down one side only reads as damage, and this gun's asymmetry budget is
   * already spent on the bolt and the release lever.
   */
  panels: {
    count: 2, side: 'both', h: 0.014, d: 0.020,
    y: 0.034, z: -0.163, step: 0.030, hostHalfW: 0.014,
  },
};

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════
 * DESERT TAN — and this time far enough from the shotgun to survive a glance.
 *
 * "we need more differentiator colours, still look the same overall." Measured, they were
 * right, and on this gun the collision was exact: the rifle's frame was #a37a57 (luma 0.503,
 * hue 28°, sat 0.47) and the shotgun's steel is #a67f5d (0.521, 28°, 0.44). Two of the four
 * guns were wearing the same colour, one of them on its biggest mass. Everything below is
 * pushed on all three axes the eye actually separates — VALUE, HUE and SATURATION:
 *
 *   frame    #a9905e   luma 0.571 · hue 40° · sat 0.44   receiver · slide · barrel · guard
 *   polymer  #3d352d   luma 0.212 · hue 30° · sat 0.26   grip · fore-end · stock · flutes
 *   steel    #9da7a9   luma 0.647 · hue 190° · sat 0.07  port frame · bolt handle · magazine
 *
 * THE FRAME IS THE IDENTITY. At 0.571 it is by a wide margin the palest large mass in the
 * arsenal — the next is the SMG's 0.372, then the pistol's 0.358 and the shotgun's 0.319 — so
 * "the light gun" is now true at a glance rather than only in the fiction. It is also 12° of
 * hue off the shotgun's walnut steel and a full 0.05 above it in value, which is what the
 * collision above needed.
 *
 * THE INTERNAL CONTRAST IS THE OTHER HALF OF IT. Frame 0.571 over polymer 0.212 is a value
 * break of 0.359, more than twice any other gun's (pistol 0.145, SMG 0.154, shotgun 0.116) —
 * a pale sand upper on near-black furniture. WEAPON_ART §2 calls material separation the
 * cheapest quality lever we have, and it costs no geometry at all.
 *
 * THE STEEL IS THE ONE COLD THING ON A WARM GUN. 190° against the frame's 40° is a near
 * hue-opposition, so the bolt handle, the port frame and the magazine read as bare machined
 * metal let into painted sand rather than as a slightly lighter tan. It is also the brightest
 * steel of the four (0.647 against 0.500–0.521), which is the rifle again being the pale one.
 *
 * ART §9 IS INTACT, AND IT WAS CHECKED RATHER THAN ASSUMED. ACID (0x8cff3e) and HOT
 * (0xff2e63) belong to enemies and appear nowhere here. GOLD (0xffc531) belongs to
 * interactables and the muzzle core: the frame sits 3° from it in hue, which is unavoidable in
 * a desert tan, so the separation is bought where it is visible instead — GOLD is luma 0.779 /
 * sat 0.81 / value 1.00 and this is 0.571 / 0.44 / 0.68, i.e. a dark khaki against a bright
 * yellow, not a dimmer version of the same signal. Every field is under `ENV_VALUE_CEIL`
 * (0.78).
 *
 * AND THE SIGHTS ARE NOT IN THIS TABLE, WHICH IS THE POINT OF THEM. They wear the shared
 * sight material — dark iron, flat value 0.188, set in `viewmodel.ts` after the playtester
 * objected to pale marks on the top edge three times. Against this frame at 0.571 that is the
 * hardest value break on the weapon, so the optic housing and the front block read as DARK
 * MACHINED MASS let into a pale sand receiver — and the window through the housing reads as a
 * hole because the sand shows through it. Nothing in this file may lighten them.
 * ═════════════════════════════════════════════════════════════════════════════════════════
 */
const FIELDS: FieldSet = {
  /** Desert tan: BONE pushed toward GOLD for the yellow, then dropped toward INK for value. */
  frame: hexMix(hexMix(PALETTE.BONE, PALETTE.GOLD, 0.34), PALETTE.INK, 0.25),
  /** The same tan taken almost to black — warm charcoal furniture, not a neutral grey. */
  polymer: hexMix(hexMix(PALETTE.BONE, PALETTE.GOLD, 0.30), PALETTE.INK, 0.76),
  /** Cold pale machined steel, petrol-cast: the one hue opposition on the weapon. */
  steel: hexMix(hexMix(PALETTE.SLATE, PALETTE.PAPER, 0.60), PALETTE.TEAL, 0.12),
  /** Unused — this gun has no timber. Kept so the field set is total. */
  wood: FIELD.wood,
};

/**
 * CARED-FOR. One even phosphate over the whole upper — the receiver and the frame now name
 * the SAME surface (`framePark`), which `matFor` resolves to one cached material for both
 * groups, so it costs nothing and it removes the seam where the plain frame met the parkerised
 * receiver. The furniture is parkerised too and the only mark anywhere else is the knurl on
 * the bolt knob and the magazine, i.e. the two things a hand actually grabs. This is a weapon
 * somebody looks after; the SMG is the one with the paint knocked off it.
 */
const SKIN: WeaponSkin = {
  frame: { mat: 'framePark', uv: 16 },
  slide: { mat: 'framePark', uv: 16 },
  polymer: { mat: 'polyPark', uv: 16 },
  steel: { mat: 'steelKnurl', uv: 22 },
  magazine: plainSteel,
};

export const LONGSHOT: WeaponModelDef = { profile: PROFILE, fields: FIELDS, skin: SKIN };

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
 * ─── SIX BUILDS, SIX TIMES THE SAME NOTE, AND WHAT THE SIXTH ONE FINALLY SAID ────────────
 * "gray lines on top" · "sights too long" · "3 grey thing on top" · "the guns in the top have
 * this sticks like showing out" · "remove and remake a better sight blades that design looks
 * bad and not competitive at all" · **"The 3 sights look bad like too huge?"**
 *
 * The sixth is the useful one, because it contains a COUNT and a SIZE, and the count was
 * literally right. The parts list it was looking at was `housing wall ×2` + `front block`:
 * three separate solids. The pass that shipped it called the first two "one optic housing
 * with a window cut through it", but there was no hole anywhere on the gun — there was a
 * 22 mm GAP between two wall blocks with NOTHING BRIDGING THE TOP, and a gap between two
 * solids reads as two solids however the comment describes it.
 *
 * ─── SO THIS PASS CHANGES THE TWO THINGS THAT HAD TO CHANGE TOGETHER ─────────────────────
 *   1. A REAL BORED PART. `opticBlock` (see `OpticBlockSpec`) emits four bars closed at the
 *      corners around a square hole that is centred ON `lineY`, with SOLID IRON ABOVE IT AND
 *      BELOW IT. That is the difference between one machined ring and two walls, and it is
 *      not expressible in `SightSpec` — the builder pins every blade top to `lineY`, so a
 *      bridge over the gap would have sat exactly at eye height and the player would have
 *      been sighting along the roof of their own optic. The previous pass was right to refuse
 *      to fake it; the part now exists, so it is built for real.
 *   2. IT IS MUCH SMALLER, and "smaller" is measured in the view that generated the
 *      complaint, not on the spec sheet. See the table below.
 *
 * PART COUNT GOES 3 → 2. `opticBlock` REPLACES the rear blade pair and `opticFront` REPLACES
 * the front blade — the builder skips both, they never supplement. One ring, one post.
 *
 * EVERY MILLIMETRE BELOW IS A **DRAWN** MILLIMETRE — `z` here is halved by `depthCompress`
 * 0.50 after the builder is done with it, so an authored depth and a drawn depth are two
 * different numbers and only the second one is what the playtester is looking at.
 *
 * ─── WHAT IS THERE NOW: A RING AND A PIN ─────────────────────────────────────────────────
 *   REAR   ONE bored APERTURE RING at the receiver's tail: 36 mm across, 36 mm tall, 11 mm
 *          fore-and-aft drawn, with a 16 × 16 mm SQUARE HOLE through it centred on the sight
 *          line. 10 mm of iron on all four sides of that hole. Its bottom 8 mm is buried in
 *          the receiver and its rear face is flush with the receiver's rear face (z 0.024),
 *          so 28 mm of it stands proud and the rest is inside the gun.
 *   FRONT  ONE PIN 148 mm forward: 10 × 10 mm, 11 mm deep drawn, standing exactly 10 mm
 *          proud of the receiver top with its TIP ON THE SIGHT LINE — i.e. dead centre of the
 *          ring — and its front face flush with the receiver's nose at −0.146.
 *
 * ─── "TOO HUGE", ANSWERED IN NUMBERS ─────────────────────────────────────────────────────
 * The rest pose (x +0.125, yaw −14°) shows the player the gun's LEFT FLANK all session, so
 * flank ink area is the number the complaint was actually about. Drawn, proud of the receiver:
 *
 *                        WAS (3 solids)              NOW (2 solids)          change
 *     rear element       30 deep × 12 proud = 360    11 × 28 = 308           −14 %
 *     front element      30 deep × 12 proud = 360    11 × 10 = 110           −69 %
 *     FLANK INK TOTAL    720 mm²                     418 mm²                 −42 %
 *     width across       48 mm                       36 mm                   −25 %
 *     depth, drawn       30 mm                       11 mm                   −63 %
 *     proud volume       14 040 mm³                  9 372 mm³               −33 %
 *
 * THE ONE AXIS THAT GREW IS HEIGHT, AND IT IS FORCED, NOT CHOSEN. A bored ring cannot be
 * shorter than `2 × boreR + topWall + bottomWall`, and both walls are pinned at the 10 mm ink
 * floor, so the smallest legal ring on this gun is 30 mm tall whatever it is authored at; this
 * one is 36 mm because the hole has to stay a usable window. Mass above the hole is the whole
 * point of the brief — it is what makes the part read as machined instead of assembled — so
 * the height was spent there and bought back on the two axes nothing depends on. Depth is the
 * axis the complaint named ("30 mm fore-and-aft") and it took the biggest cut.
 *
 * ─── WHERE THE HEIGHT WENT: `lineY` 0.066 → 0.064 ────────────────────────────────────────
 * 0.064 over the 0.054 receiver top is 10 mm — the documented floor for this gap (anything on
 * the top face nearer the eye than the front element occludes the picture from below, which is
 * what `guardSightLine()` polices), and the last 2 mm available anywhere on this axis. It also
 * still clears the muzzle can's 0.051 top by 13 mm, which the sight line has to.
 *
 * ─── THE AIM SOLVE, PRESERVED BY CONSTRUCTION RATHER THAN BY LUCK ────────────────────────
 * `aimSocketOf()` = `(0, lineY, rearZ × depthCompress)` and `adsOffsetOf()` negates x and y
 * exactly, so `socket + ads` is (0, 0, −adsSightDistance) for ANY `lineY` and ANY `rearZ`.
 * The boot assertion in `assertClearance()` tests precisely that residual and it is
 * identically zero here — moving the line moves the socket and the ADS translation together.
 *
 * FRONT AND REAR STILL AGREE, BY A STRONGER GUARANTEE THAN BEFORE. The bore is placed from
 * `lineY ± boreR`, so its centre IS the sight line by construction, and the front pin's height
 * is derived as `lineY − footY`, so its tip IS the sight line too. Neither number can drift
 * without the other; there is no shared blade height left to keep in sync by hand.
 *
 * THE PICTURE, MEASURED. Radius 0.148 authored (`rearZ` 0.013 → `frontZ` −0.135), 0.074
 * drawn, so the ring is 0.235 m from the eye and the pin 0.309 m. Half-bore 0.008/0.235 =
 * 0.03404 rad; pin half-width 0.005/0.309 = 0.01618 rad; LIGHT BAR 0.01786 rad per side, i.e.
 * the pin fills 48 % of the aperture width and there is real daylight either side of it. At
 * 772 px/rad that is a 14 px bar against a 3.5 px sight hull — thinner than the 19 px the
 * U-channel gave, which is the price of a smaller ring, and still twice the hull. The sight
 * radius itself went UP, 0.055 → 0.074 drawn, because the ring moved back to the tail.
 *
 * ─── CLEARANCE: NOTHING MOVED OUTWARD, SO NOTHING MOVED ──────────────────────────────────
 * The model's worst vertices are ones this profile does not touch: `muzzle.fin3` at 0.389
 * reach and the forearm at the near plane (0.096).
 *
 *   ring         |x| ≤ 0.018 at drawn z 0.001…0.012, against the old housing's ±0.024 at
 *                drawn −0.018…0.012 — strictly INSIDE the footprint it replaces, and far
 *                below the bolt paddle's corner (|x| ≈ 0.038 at drawn z 0.001, 0.3005/0.3247)
 *   near plane   ring rear face still 0.024 authored / 0.012 drawn, exactly where the old
 *                housing's was, and 84 mm inside the butt pad that actually sets the metric
 *   front pin    |x| ≤ 0.005 and forward-most vertex at drawn z −0.073 — the SAME plane the
 *                old front block's front face was on, at a third of the cross-section
 *
 * No forward-most (−z) or right-most (+x) vertex on this model moved. Reach stays 0.389,
 * near stays 0.096.
 *
 * ─── THE SILHOUETTE, STILL FIVE EVENTS ───────────────────────────────────────────────────
 * stock → receiver with an aperture ring machined into its tail → bare top → front pin →
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
     * THE THREE NUMBERS THE APERTURE IS SOLVED FROM, AND NOTHING ELSE IN THIS BLOCK IS BUILT.
     * Read the header first; this note is the arithmetic.
     *
     * `lineY`, `rearZ` and `frontZ` are the whole live contract now:
     *   · `lineY` 0.064 is the eye, the bore's centre and the front pin's tip — one number,
     *     three jobs, which is why front and rear cannot disagree.
     *   · `rearZ` 0.013 must equal `opticBlock.z` (the builder dev-warns past 1 mm). The ring
     *     is 0.022 deep, so its rear face lands at 0.024, FLUSH with the receiver's own rear
     *     face — the same plane the old housing's rear face sat on, so the nearest sight
     *     vertex has not moved a millimetre and the near-plane metric is untouched.
     *   · `frontZ` −0.135 tracks `opticFront.z`. The pin is 0.022 deep, so its front face
     *     lands at −0.146, flush with the receiver's nose. Sight radius 0.148 authored /
     *     0.074 drawn, UP from 0.055 — a longer radius on a marksman rifle, bought by moving
     *     the ring back to the tail rather than by pushing anything forward.
     *
     * ─── `lineY` 0.066 → 0.064, AND WHY THAT IS THE FLOOR ────────────────────────────────
     * The gap between the sight line and the receiver's 0.054 top face is what the front
     * element stands in, and `guardSightLine()` fixes the minimum at 0.010: below that the
     * receiver's own top face — which runs forward from the ring and is therefore NEARER the
     * eye than the pin at every ray under the line — starts eating the bottom of the picture,
     * and the pin's visible height drops under the ink band and prints black. 0.064 is exactly
     * that floor. It is also 13 mm over the muzzle can's 0.051 top, which the line must clear.
     *
     * `lineY` is an INPUT to `aimSocketOf()`, not a tuned constant, so the socket and the ADS
     * translation moved down with it and the boot assertion's residual stays identically zero.
     *
     * ─── THE FIVE FIELDS BELOW ARE DEAD GEOMETRY, KEPT LEGAL ON PURPOSE ──────────────────
     * `bladeW`, `rearH`, `frontH`, `bladeD` and `notchHalfGap` describe the blade pair and the
     * front blade that `opticBlock` / `opticFront` REPLACE — the builder takes the aperture
     * branch and never reads them. `SightSpec` still requires them, so rather than leave five
     * stale numbers from a rejected build they are set to the aperture's own dimensions: a
     * 0.010 blade at a 0.008 half-gap is a 0.036 rear pair, the ring's outer width, and 0.022
     * is the ring's depth. If the optic is ever switched off, what comes back is floor-legal
     * iron at the right size instead of the thing the playtester rejected six times.
     */
    lineY: 0.064, rearZ: 0.013, frontZ: -0.135,
    bladeW: 0.010, rearH: 0.010, frontH: 0.010, bladeD: 0.022, notchHalfGap: 0.008,
  },
  /**
   * THE BORED APERTURE RING — the part the last five passes could not express, and the answer
   * to "the 3 sights look bad like too huge". See `OpticBlockSpec` for the contract and the
   * header of this file for the size argument. This note is the arithmetic and the floors.
   *
   * ─── THE BORE IS THE PART. EVERYTHING ELSE IS DERIVED FROM IT ────────────────────────────
   * `boreR` 0.008 puts the hole at 0.056…0.072 in y and ±0.008 in x — 16 × 16 mm, centred on
   * `lineY` 0.064 BY CONSTRUCTION rather than by a placement number that could drift. The
   * builder then hangs four bars off those edges and closes them at the corners: full-width top
   * and bottom caps, jambs between them. One continuous frame, iron above the hole as well as
   * beside and below it. That is the whole difference between this and the two walls it
   * replaces, and it is why the player can now count ONE solid here instead of two.
   *
   * ─── THE OUTER BLOCK IS THE THINNEST LEGAL RING, EXACTLY ────────────────────────────────
   * `w` 0.036 and `h` 0.036 are not chosen sizes, they are `2 × boreR` plus one ink floor on
   * each of the four sides. Every wall lands ON the floor, which is the smallest a bored part
   * can be here:
   *
   *     top wall     y + h/2 − (lineY + boreR)  =  0.082 − 0.072  =  0.010    at the floor
   *     bottom wall  (lineY − boreR) − (y − h/2) = 0.056 − 0.046  =  0.010    at the floor
   *     side wall ×2 w/2 − boreR                 = 0.018 − 0.008  =  0.010    at the floor
   *     BORE (void)  2 × boreR                   =  0.016                     +6 mm
   *     depth        0.022 authored → 0.011 DRAWN (`depthCompress` 0.50)      +1 mm
   *
   * Unlike the blades this replaces, none of that is checked by hand: all four bars go through
   * `inkChunk()`, and `opticBlock`'s own guard re-derives every wall from the bore and names
   * the thinnest one in dev if an edit ever drops it under `max(wallMin, INK_FLOOR)`. `wallMin`
   * 0.010 is this file asserting the floor it believes it is authored against.
   *
   * THE VOID IS THE HIGH-RISK TERM and it is the one with margin: 16 mm of hole against a
   * 10 mm band. It is a genuine hole with the world visible through it, not a gap between two
   * parts — which is the sentence the previous five builds could not truthfully write.
   *
   * ─── `y` = `lineY`: THE BOTTOM BAR IS BURIED, WHICH IS WHERE THE SIZE IS HIDDEN ─────────
   * `y` is the BLOCK's centre and is deliberately free of the bore. At 0.064 the block spans
   * 0.046…0.082, so its bottom 8 mm sits INSIDE the receiver (top face 0.054) and costs nothing
   * on screen: 28 mm stands proud, not 36. The bottom cap doubles as the mount — it is wider
   * than the 26 mm receiver, so it steps out over both flanks and reads as a machined base the
   * ring grows out of rather than a block set on top of one.
   *
   * ─── CLEARANCE: STRICTLY INSIDE WHAT IT REPLACES ────────────────────────────────────────
   * |x| ≤ 0.018 at drawn z 0.001…0.012, against the old housing's ±0.024 at drawn −0.018…0.012.
   * Narrower, shallower, no further back. It cannot become the worst vertex in any pose — the
   * bolt paddle at |x| 0.038 / drawn z 0.001 measures 0.3005 reach against a 0.40 budget, and
   * the butt pad still sets the near plane at 0.096. Reach stays 0.389.
   */
  opticBlock: { w: 0.036, h: 0.036, d: 0.022, y: 0.064, z: 0.013, boreR: 0.008, wallMin: 0.010 },
  /**
   * THE FRONT PIN — the second and last solid on this gun, and it is deliberately the smallest
   * legal one. 10 × 10 mm in section, 0.022 deep authored / 11 mm DRAWN, standing exactly
   * 10 mm proud of the receiver's 0.054 top face. Every one of those is the ink floor: there is
   * no smaller front element this renderer can draw.
   *
   * `footY` 0.050 buries the foot 4 mm inside the receiver so the pin is 0.014 tall as
   * geometry (clear of `inkChunk`'s clamp) while showing only 10 mm — the same trick the ring's
   * bottom cap uses. The builder derives the height as `lineY − footY`, so the TIP LANDS ON
   * `lineY`, i.e. dead centre of the bore: pin in the middle of the ring, daylight all round.
   *
   * THE PICTURE. Pin half-width 0.005 at 0.309 m = 0.01618 rad against the bore's 0.03404 —
   * the pin fills 48 % of the aperture and leaves a 0.01786 rad light bar each side, 14 px at
   * 772 px/rad against a 3.5 px sight hull. Narrower bars than the 22 mm U-channel gave, which
   * is the honest cost of a ring a third of its width; still four times the hull.
   *
   * IT COSTS NOTHING. `z` −0.135 with `d` 0.022 puts its front face at −0.146 — flush with the
   * receiver's nose and on the SAME plane (drawn z −0.073) the old front block's front face
   * occupied, at |x| ≤ 0.005 against that block's ±0.0065. No forward-most vertex moved.
   */
  opticFront: { w: 0.010, d: 0.022, z: -0.135, footY: 0.050 },
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
   * against `lineY` 0.070. The sight line is now 0.064, so `guardSightLine()`'s ceiling is
   * 0.054 and the pad is 5 mm over it — but the real objection is worse than the guard:
   * anything on the top face runs FORWARD of the bore and is therefore NEARER the eye than the
   * front pin at every ray below the line, so a 5 mm-proud pad would appear at −0.0289 rad
   * against the bore's own bottom rim at −0.0340 and eat the bottom third of the picture.
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
   * exists, because nothing on this gun is held up any more: the ring's bottom cap is buried
   * 8 mm into the receiver and the front pin's foot 4 mm, and both stand on their own mass.
   * Sight ears would also be the wrong idea twice over now — the bore already IS a hood, and
   * `sightWings` would eat the light bars either side of the pin, which is the whole picture.
   * A rail would cost reach a hood or an ear cannot pay for. Do not re-add them, under any
   * name. NOTHING ELSE STANDS ON THE TOP FACE: ring, 138 mm of bare receiver, pin.
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
 * hardest value break on the weapon, so the aperture ring and the front pin read as DARK
 * MACHINED MASS let into a pale sand receiver — and the bore reads as a HOLE because the world
 * behind the gun shows through it. Nothing in this file may lighten them.
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

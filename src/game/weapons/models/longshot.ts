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
 * ─── FOUR BUILDS, FOUR TIMES THE SAME NOTE, AND WHY THE LAST THREE FIXES MISSED ──────────
 * "gray lines on top" · "sights too long" · "3 grey thing on top" · "the guns in the top have
 * this sticks like showing out". Four separate reports across four builds, and every previous
 * pass answered them by SUBTRACTING NEIGHBOURS: the sight ears went, the rail teeth went, the
 * 120 mm warm rib was cut to 30 mm, the blades were darkened from BONE 0.73 to dark iron. The
 * note came back every time, because none of that touched the thing being described.
 *
 * THE BLADES THEMSELVES WERE THE STICKS. They stood 44 mm proud of a receiver top face at
 * 0.054 — taller than the receiver is deep (40 mm) — on an 11 × 12 mm footprint. A part four
 * times taller than it is thick, standing alone on a flat plate, is an ANTENNA. It does not
 * matter what colour it is or what is next to it.
 *
 * ─── THE PRINCIPLE: A SIGHT IS SUBTRACTIVE, NOT ADDITIVE ─────────────────────────────────
 * A post stuck ON a receiver reads as glued on. A real sight reads as part of the gun because
 * it is a MASS with a slot cut INTO it, and because the blade sits WITHIN a base rather than
 * on top of one. Same job in the sight picture, opposite read in the silhouette. So:
 *
 * EVERY MILLIMETRE BELOW IS A **DRAWN** MILLIMETRE — `z` here is halved by `depthCompress`
 * 0.50 after the builder is done with it, so an authored depth and a drawn depth are two
 * different numbers and only the second one is what the playtester is looking at. The pass
 * before this one stated its proportions in authored millimetres and shipped a rear block
 * that was still taller than it was deep. See the `sight` note for the measurement.
 *
 *   REAR   a machined BLOCK let into the top of the receiver's tail: 42 mm across, 18 mm
 *          fore-and-aft drawn (`bladeD` 0.036), standing 16 mm proud, with a 20 × 16 × 18 mm
 *          CHANNEL milled down its centre. Its rear face is flush with the receiver's own
 *          rear face (both at z 0.024) and its bottom is buried 6 mm inside the top face, so
 *          it is machined out of the receiver rather than fastened to it. Wider than it is
 *          tall, deeper than it is tall: a block with a notch, in every direction.
 *   FRONT  a 24 × 18 mm BASE PAD (drawn) standing 5 mm proud of the top face, with the post
 *          rising from INSIDE it — the post's 11 × 18 mm drawn footprint sits within the
 *          pad's on all four sides (3.5 mm of shoulder each side, 3 mm fore and aft drawn)
 *          and its bottom is buried 6 mm in. What stands clear is 11 mm of blade on a
 *          plinth, not 44 mm of stick.
 *
 * The proportion is the whole fix, and it is arithmetic rather than taste. Rear blade, side
 * profile, all drawn: was 44 proud × 6 deep (aspect 0.14, a flag), then 18 × 12 (0.67, still
 * portrait). Now 16 proud × 18 deep — aspect 1.13, landscape, a block. Front blade: was
 * 44 × 6 clear of everything; now 11 × 18 sitting in a pad.
 *
 * ─── WHERE THE HEIGHT WENT: `lineY` 0.098 → 0.070 ────────────────────────────────────────
 * A blade's proud height is `lineY` minus the surface under it — there is no other way to
 * shorten one, because both blades must reach DOWN to their host (the previous pass raised
 * them to 46 mm precisely to kill the daylight under them, and that is not being undone).
 * Dropping the sight line 28 mm is half the fix (deepening the blades is the other half, and
 * the one the previous pass got wrong); it is also free three times over. The figures below
 * were measured at `lineY` 0.072 and the line has since gone to 0.070, which moves them in
 * the same direction by another 2 mm of drop — they are floors, not exact readings:
 *
 *   · THE AIM SOLVE FOLLOWS IT — see below. `lineY` is an input to the solve, not a tuned
 *     constant, so a lower line is a lower socket and a re-solved ADS translation.
 *   · THE ADS PICTURE GETS CLEANER, MEASURED. The eye sits on the line, so the grazing angle
 *     across the receiver's own top face falls from 0.187 rad to 0.0766 rad, and the muzzle
 *     can's intrusion above that horizon drops from 18.5 mm to 5.8 mm at the muzzle plane.
 *     Less gun in the notch, not more.
 *   · THE GUN READS BIGGER AT ADS, which §1.5 of the constitution asks for: the receiver's
 *     top edge sits 64 px under the crosshair instead of 156 px at 1600×821 / 56°.
 *
 * ─── THE AIM SOLVE, PRESERVED BY CONSTRUCTION RATHER THAN BY LUCK ────────────────────────
 * `aimSocketOf()` = `(0, lineY, rearZ × depthCompress)` and `adsOffsetOf()` negates x and y
 * exactly, so `socket + ads` is (0, 0, −adsSightDistance) for ANY `lineY` and ANY `rearZ`.
 * The boot assertion in `assertClearance()` tests precisely that residual, and it is
 * identically zero here — moving the line moves the socket and the ADS translation together.
 *
 * The two TOPS stay coincident the same way: the builder places the front blade at
 * `lineY − frontH/2` and the rear pair at `lineY − rearH/2`, so both top faces land on the
 * sight line whatever the heights are. `rearH` 0.022 and `frontH` 0.017 differ here — they
 * have different surfaces under them — and the tops still cannot drift apart.
 *
 * The PICTURE is the part that could have drifted, so it is measured. Sight radius 0.128
 * (`rearZ` 0.006 → `frontZ` −0.122), compressed 0.50, puts the notch 0.235 m from the eye and
 * the post 0.299 m. The ±0.010 notch window projects to ±0.01272 at the front plane against a
 * 5.5 mm post half-width: 7.22 mm of light bar per side, 0.0241 rad. The geometry before this
 * pass gave 0.0245 and the pistol reference the whole sight contract was solved against gives
 * 0.0253. A 1.6 % change to the number the player actually aims with.
 *
 * ─── CLEARANCE: EVERY EDIT IS VERTICAL, INWARD OR BACKWARD ───────────────────────────────
 * The model's worst vertices are ones this profile still does not touch: `muzzle.fin3` at
 * 0.389 reach, the magazine floorplate at reload, the forearm at the near plane (0.096).
 *
 *   sight line   −28 mm of HEIGHT, and neither metric reads y at all
 *   rear block   `rearZ` 0.020 → 0.006 and 36 mm deep, so it spans z −0.012…0.024 — inside the
 *                receiver's own z footprint, 8 mm FURTHER from the near plane than before
 *   front pad    front face −0.146, level with the receiver nose at −0.146; |x| ≤ 0.009 <
 *                the receiver's ±0.013. Worst reach hypot(0.009 + sway, 0.146) ≈ 0.148 m,
 *                against a receiver corner at 0.150 that already ranks above it
 *   front post   `frontZ` −0.128 → −0.122, i.e. it grew BACKWARD; its front face is −0.140,
 *                6 mm inside the pad, which is itself level with the nose
 *
 * No forward-most (−z) or right-most (+x) vertex on this model moved. Reach stays 0.389,
 * near stays 0.096.
 *
 * ─── THE SILHOUETTE, STILL FIVE EVENTS ───────────────────────────────────────────────────
 * stock → receiver with a notched block milled into its tail → bare top → front pad and blade
 * → hard step down → bare fluted barrel → the can. Plus the bolt handle out to the right and
 * the bipod stub under the handguard, the two events on the OUTLINE.
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
     * A NOTCHED BLOCK AND A BLADE IN A PAD — the geometry the header argues for, as numbers.
     * Read that note first; this one is the arithmetic and the two floors it is against.
     *
     * `lineY` 0.098 → 0.072 → 0.070. Proud height = `lineY` − the surface underneath, and
     * both blades must reach down to their host or they float (which is the bug two passes ago
     * closed by making them 46 mm tall). 0.070 over a 0.054 top face is 16 mm of rear block
     * proud; over the 0.059 front pad it is 11 mm of blade. `lineY` is an INPUT to
     * `aimSocketOf()`, not a tuned constant, so the socket and the ADS translation move with
     * it and the boot assertion's residual stays identically zero. It cannot go much lower:
     * `guardSightLine()` fails anything on the top face above `lineY − 0.010`, and the front
     * pad tops out at 0.059, so 0.070 leaves exactly 1 mm of that ceiling.
     *
     * `rearZ` 0.020 → 0.012 → 0.006 keeps the block's rear face at 0.024, FLUSH with the
     * receiver's own rear face, rather than hanging over the stock behind it. It is
     * bookkeeping, not a move: the face is `rearZ` + `bladeD`/2, so deepening the block by
     * 12 mm pulls its centre back by 6. The nearest sight vertex is exactly where it was.
     *
     * `bladeD` 0.012 → 0.024 → 0.036, AND THE MIDDLE NUMBER WAS MEASURED IN THE WRONG SPACE.
     * Every `z` in this file is multiplied by `depthCompress` on the way out of the builder
     * (`place(g, { sz: MODEL_SCALE * P.depthCompress })`, viewmodel.ts) — AFTER every clamp,
     * so a depth authored here is not the depth that is drawn. On this gun the factor is 0.50,
     * the harshest in the game: `bladeD` 0.024 renders as **12 mm**, not 24, and the claimed
     * side-profile aspect of 1.33 was really 12/18 = 0.67. Still portrait, i.e. still a post,
     * which was the whole complaint. Verified in-browser, not derived: the built `vm-sights`
     * geometry's local z span measured 0.082 = 0.164 × 0.50 exactly, while its y span measured
     * 0.022 = `rearH` untouched. z is halved; y and x are not.
     *
     * So the target is now stated in DRAWN millimetres, which is the only space that can be
     * checked against a complaint about what the screen shows:
     *
     *     drawn depth = `bladeD` × 0.50 = 18 mm      proud = `lineY` − the surface under it
     *     rear   18 deep / 16 proud = 1.13      front  18 deep / 11 proud = 1.64
     *
     * Both terms move: depth alone would have needed `bladeD` 0.044 to clear an 18 mm-proud
     * block, which does not fit between the receiver's rear face (0.024) and its nose
     * (−0.146) with a pad around it. For reference the other three profiles land at 1.01
     * (inkslinger), 1.17 (ratatat) and 2.17 (boomstick) on this same measure — this gun was
     * the only one still under 1, and it is the one in the playtester's screenshot.
     *
     * `rearH` 0.022 and `frontH` 0.017 are unchanged, and the lower line buries them DEEPER
     * rather than floating them: rear bottoms at 0.048, 6 mm inside a 0.054 top face; front
     * bottoms at 0.053, 6 mm inside a pad spanning 0.043…0.059. The two are ALLOWED to differ
     * — the builder derives both tops from `lineY`, so the sight line survives any pair.
     *
     * `bladeW` 0.011 and `notchHalfGap` 0.010 ARE NOT TOUCHED, on purpose: together they are
     * the sight picture. Outer faces stay at ±0.021 on a ±0.013 receiver, which on a block
     * this deep now reads as a sight base overhanging its dovetail rather than as two slabs
     * outboard in space.
     *
     * THE PICTURE, MEASURED. Radius 0.128 (`rearZ` 0.006 → `frontZ` −0.122), compressed 0.50:
     * notch 0.235 m from the eye, post 0.299 m, ratio 1.272. The ±0.010 window projects to
     * ±0.01272 against a 5.5 mm post half-width → 7.22 mm of light bar per side, 0.0241 rad.
     * The previous geometry gave 0.0245 and the pistol reference this whole sight contract was
     * solved against gives 0.0253. A 1.6 % change to the number the player actually aims with.
     *
     * THE INK FLOOR (0.010 m), every dimension AS DRAWN — which is the correction above: a
     * depth has to be checked after `depthCompress`, not before, and it matters more here than
     * anywhere because the builder makes the blades with `bevelBox` and NOT `inkChunk`, so
     * there is no clamp and no dev warning behind this line. Rear blade 0.011 × 0.022 × 0.018
     * drawn, front blade 0.011 × 0.017 × 0.018 drawn. Thinnest term 0.011, one millimetre
     * clear. The notch VOID is checked too, since a gap has to survive the line as well as a
     * mass: 20 mm wide × 16 mm tall (its floor is the receiver's own 0.054 top face) × 18 mm
     * deep drawn — every term over the floor, and now wider and deeper than it is tall.
     */
    lineY: 0.070, rearZ: 0.006, frontZ: -0.122,
    bladeW: 0.011, rearH: 0.022, frontH: 0.017, bladeD: 0.036, notchHalfGap: 0.010,
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
   * UNTOUCHED, and it is the RELOAD pose's worst vertex (0.3792 reach / 0.4087 swayed on the
   * floorplate) — the one place on this gun where a millimetre of `h` or `d` comes straight
   * out of `MOVE.radius`. It is also invisible in every other pose: raked at `MAG_RAKE` it
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
   * THE FRONT SIGHT'S BASE PAD — the `rib` slot spent on the subtractive read rather than on a
   * stripe. It was a 120 mm bar nose-to-tail once (the "grey line on top"), then a 30 × 14 mm
   * block under the post; it is now the PLINTH THE BLADE SITS INSIDE, which is the only job on
   * this gun worth the one warm mark forward of the hand.
   *
   * 48 × 18 mm on plan, spanning z −0.146…−0.098 and x ±0.009, top at 0.059 — 5 mm proud of
   * the receiver's 0.054 top face with 11 mm of it buried inside. The post's 11 × 36 mm
   * footprint sits WITHIN that on all four sides: 3.5 mm of shoulder either side, 6 mm fore
   * and aft. A blade rising out of a pad is a machined front sight; the same blade on a flat
   * plate is the stick the playtester has now reported four times.
   *
   * `d` 0.032 → 0.048 and `z` −0.128 → −0.122 TRACK THE BLADE, they are not an independent
   * choice: `sight.bladeD` went to 0.036 to fix the drawn side-profile aspect (see that note),
   * and a pad the blade overhangs is not a pad. Both are still halved by `depthCompress` on
   * the way out, so what is drawn is a 24 mm-deep pad under an 18 mm-deep blade — the shoulder
   * survives the compression because BOTH terms are compressed by the same factor.
   *
   * IT CANNOT OCCLUDE THE SIGHT PICTURE, and this is the check that killed the 120 mm rib.
   * Anything on the top face runs FORWARD of the rear notch and is therefore nearer the eye
   * than the post at every ray below the line — but this pad is AT the post's own z (both
   * centred on −0.122), so it is not in front of the post, it IS the post's base. Its top at
   * 0.059 is 11 mm under `lineY` 0.070, and `guardSightLine()` fails anything on the top face
   * above `lineY − 0.010` = 0.060. One millimetre of margin, and it is the binding constraint
   * on how far the sight line may drop — re-checked against the new line, not inherited.
   *
   * AND IT COSTS NO CLEARANCE. |x| ≤ 0.009 against the receiver's ±0.013, front face −0.146,
   * exactly level with the receiver's own nose: strictly inside the host's x/z footprint, so
   * the receiver's corner vertex (hypot(0.013, 0.146) ≈ 0.1466) still ranks above the pad's
   * (hypot(0.009, 0.146) ≈ 0.1463) at every pose, and both are 240 mm inside the 0.40 budget
   * the muzzle actually spends. Confirmed at boot: reach 0.389, near 0.096, unchanged.
   *
   * INK FLOOR: 0.018 × 0.016 × 0.024 AS DRAWN (`d` 0.048 × `depthCompress` 0.50), thinnest
   * term 6 mm clear — which needs saying twice, because the builder makes this one with
   * `bevelBox` and no `inkChunk` clamp behind it, and because the clamp would have validated
   * the pre-compression number anyway.
   */
  rib: { w: 0.018, h: 0.016, d: 0.048, y: 0.051, z: -0.122 },

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
   * the pale bar the playtester asked to have removed. The remake above replaces the one
   * structural job the teeth were doing — holding the blades up off the top face — with the
   * blades' own hosts: the rear pair is buried in the receiver, the front blade is buried in
   * its pad. A rail would also cost the reach a hood or an ear cannot pay for. Do not re-add
   * them, under any name.
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
 * hardest value break on the weapon, so the notched block and the blade read as DARK CUTOUTS
 * in a pale sand receiver. Nothing in this file may lighten them.
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

/**
 * BOOMSTICK — one weapon, one file: its proportions, its palette and its surfaces.
 *
 * The runtime that consumes this lives in `../viewmodel.ts`; the contract it is written
 * against is in `./types.ts`. Nothing here knows how a box is bevelled or how a material is
 * made — and nothing there knows this weapon exists except through `./index.ts`.
 */

import type { FieldSet, GunProfile, WeaponModelDef, WeaponSkin } from './types';
import { plainFrame, plainSteel } from './types';
import { PALETTE, hexMix } from '@/art/palette';

/**
 * BOOMSTICK — short, fat and top-heavy. Everything about it is BORE: the widest receiver in the
 * game, a fat choke, a tube slung underneath and a ribbed pump the support hand is wrapped
 * around. It should look like it hurts to fire, which is what the 2.6 weaponKick in the def is
 * telling you.
 *
 * ─── THE THREE THINGS THIS PASS CHANGED, AND WHY ─────────────────────────────────────────
 *
 * 1 · THE THREE SLABS ARE ONE BEAD AND ONE NOTCHED LIP. 58 % LESS SIGHT, AND THE BIG ONE IS GONE.
 *     This is the SEVENTH report of the same thing, and the seventh is the one that names the
 *     failure precisely: *"the 3 sights look bad like too huge"*. Both halves of that sentence
 *     are measurable and neither was answered last pass, which spent its whole budget on the
 *     ASPECT of the three slabs and none of it on their SIZE or their NUMBER:
 *
 *       what shipped        three 20.5 × 42 mm pads, 5 mm proud — 2583 mm² of plan-view furniture
 *                           standing on a 68 × 106 mm top face, i.e. 36 % of it
 *       what is here now    one 11 × 14 mm bead and one 68 × 20 mm lip with a notch bitten out
 *                           of it — 1094 mm², 58 % less, and the front slab is 83 % smaller
 *
 *     THE LAW OF THE LAST PASS STANDS AND IS UNCHANGED: **a sight may not RISE OFF the receiver.**
 *     Nothing here is a stalk; both parts are still mostly buried and still 5 mm proud. What is
 *     new is that the front sight stopped being a 42 mm slab pretending to be a bead and became
 *     an actual bead, which `SightSpec` alone could not express.
 *
 *     · THE FRONT IS A BEAD, AND IT TAKES THE NEW `opticFront` PART TO BE ONE. `SightSpec` has
 *       ONE `bladeW` and ONE `bladeD` shared by the front element and the rear pair, so the front
 *       pad could never be smaller than the cheeks that have to reach the flanks — that single
 *       coupling is why this gun has been wearing a 20.5 × 42 mm plate on its nose for six
 *       passes. `opticFront` carries its own `w`/`d`, so the bead is now 11 × 14 mm: 154 mm² where
 *       there was 861, 53 × 42 px at the hip where there was 98 × 125. It is the smallest sight
 *       element in the arsenal, which is correct — a shotgun is POINTED, not aimed.
 *
 *     · THE REAR IS A LIP ACROSS THE WHOLE TOP WITH A NOTCH BITTEN OUT OF ITS CENTRE, and the
 *       fix is the RATIO, not the shape. It shipped as 20.5 mm of metal · 27 mm of void · 20.5 mm
 *       of metal — the void was the WIDEST of the three, so the eye read two blocks with a gap and
 *       counted them. It is now 23.5 · 21 · 23.5: each cheek is wider than the hole between them,
 *       their outer faces are still dead on the receiver's own flank |x| 0.034, and the notch has
 *       a FLOOR (the receiver's top face, 5 mm down). Metal on both sides, metal underneath, one
 *       continuous 68 mm step: a slot milled into a lip, not two things with a space between them.
 *       This is the pistol's answer to the same brief, arrived at independently — see the note in
 *       `inkslinger.ts` about a hole in one part even though the geometry is two.
 *
 *     · AND `bladeD` 0.042 → 0.020, WHICH IS WHERE THE "TOO HUGE" ACTUALLY LIVED. Last pass made
 *       the void 27 × 42 and called it 1.56 : 1, "the plan-view of a groove". It never drew that
 *       way: `depthCompress` 0.62 is applied to z on the way out of the builder, so 42 mm of
 *       authored length RENDERS as 26 — and 27 × 26 is a SQUARE VOID, which is exactly the
 *       plan-view of a gap between two blocks that the last pass was trying to get away from. The
 *       arithmetic was done in authored metres on an axis the renderer shrinks by 38 %. At
 *       `bladeD` 0.020 the lip draws 12.4 mm deep against 68 mm wide — 5.5 : 1 across the gun,
 *       which no amount of foreshortening can turn back into a block.
 *
 *     · WHY NOT THE BORED RING (`opticBlock`), WHICH IS THE PART THIS COMPLAINT SHIPPED. Because
 *       its proud height is a formula, not a preference: `(lineY − receiverTop) + boreR + topWall`,
 *       with `topWall ≥ INK_FLOOR` and `boreR ≥ INK_FLOOR/2` or the void inks shut. On this gun
 *       `lineY − receiverTop` is 5 mm, and a bore that leaves any daylight around a 10 mm post at
 *       this gun's 64 mm sight radius needs `boreR ≈ 0.010` — which floors the ring at **25 mm
 *       proud against the 5 mm that is here now**. Answering "too huge" with a part five times
 *       taller is not a trade. The ring belongs on the marksman, whose line sits 8 mm over a
 *       receiver 40 mm deeper; the shotgun gets the subtractive version, which is the notch above.
 *       `opticBlock` is therefore deliberately absent, not merely unset.
 *
 *     · WHAT IT COSTS ON SCREEN, MEASURED IN THE UNITS THE LAST PASS MEASURED IN. At the hip the
 *       hero lens is ×2.6 and 5 mm subtends ≈ 24 px, of which the sights' 3.5 px line takes 7 —
 *       17 px of dark-iron albedo on both parts, a low machined ledge rather than a black smear.
 *       At ADS (846 px/rad, this file's own figure from last pass) the notch is 0.0894 rad ≈ 76 px
 *       wide and the bead 0.0400 rad ≈ 34 px, so the light bars are 21 px each less 7 px of ink
 *       = **14 px of daylight per side, up from 10**. Shrinking the front element bought sight
 *       picture as well as screen. That is a shotgun sight picture.
 *
 *     The rib had to leave the top face for any of this to be possible, and the arithmetic is
 *     forced, not stylistic: `guardSightLine`'s rule is that nothing on the upper may come within
 *     10 mm of the sight line, because anything standing there runs FORWARD from the rear notch
 *     and is therefore nearer the eye than the front post at every ray below the line. A rib
 *     standing 2 mm proud of a 0.058 top face needs `lineY` ≥ 0.070, which is 7 mm of extra stick
 *     on the one edge this whole note is about. Rib on top, or a low milled sight. Not both. See
 *     `rib` below for where it went instead.
 *
 * 2 · THE CHOKE COMES DOWN AGAIN, 0.027 → 0.025, AND IT IS WHAT PAYS FOR THE LOW SIGHT LINE.
 *     The builder places the can on the RECEIVER's centre line (y 0.030), so its top is
 *     `0.030 + r` and it is only invisible at ADS while it stays UNDER the grazing ray that runs
 *     from the eye over the receiver's nose. Solve that ray with the socket at
 *     `adsSightDistance` 0.235 and `depthCompress` 0.62 folded into z: it passes the can's rear
 *     face (z −0.115, i.e. 0.307 m out) at y 0.0577. At r 0.027 the can topped out at 0.057 —
 *     0.7 mm under it, which is 0.0023 rad, which is TWO PIXELS, which the 7 px silhouette hull
 *     eats outright. The pale BONE crown was going to print as a smudge directly under the bead.
 *     At 0.025 it tops out at 0.055, 2.7 mm and ≈ 7 px clear, and the only thing cropping the
 *     bead is the receiver's own top face — i.e. exactly the part of the pad that is buried in it
 *     and never visible.
 *
 *     Note which direction the sight line helped: LOWERING the eye flattens that grazing ray, so
 *     `lineY` 0.066 → 0.063 raised the ray at the choke from 0.0575 to 0.0577. The low sight did
 *     not create this problem, it eased it — the can was already 0.5 mm from cropping the post
 *     before this pass and nobody had measured it.
 *
 *     It is still by a wide margin the fattest bore in the arsenal (the SMG's is 0.015, the
 *     pistol's 0.017, the marksman's 0.019), and the 2 mm came off the model's forward-most and
 *     one of its widest parts, so it is 2 mm handed BACK to the clearance budget.
 *
 * 3 · IT IS THE WARM GUN, AND IT IS NOW WARM ENOUGH TO SAY SO. See `FIELDS`.
 *
 * ─── WHAT §1 ASKS THIS GUN FOR, AND WHERE EACH ONE LANDED ────────────────────────────────
 *   a heat shield, half-tube, bold cutouts   → `foreEnd` (the shroud + its two clamp bands) and
 *                                              `panels` (ONE bold cut per flank, see below)
 *   a visible shell in the ejection port     → `ejectionPort.shellR` 0.010 — a 20 mm RUST round
 *                                              in a 30 mm window, the fattest in the game
 *   a receiver visibly THICKER than any other→ w 0.068 against the SMG's 0.046, the pistol's
 *                                              0.030 and the marksman's 0.026, on a body only
 *                                              106 mm long. Width against LENGTH is what the eye
 *                                              measures, and 68 × 106 is a brick
 *   a bold front sight on a raised base      → `opticFront` — an 11 × 14 mm BEAD, 5 mm proud,
 *                                              milled into the receiver's nose rather than stood
 *                                              on a post. §1 wrote "on a raised post" and the
 *                                              post is exactly what seven rounds of feedback have
 *                                              been about, so the brief is answered on its intent
 *                                              (one deliberate, unmistakable front sight) and
 *                                              refused on its letter. "Bold" is now carried by
 *                                              being the ONLY thing on the nose, not by area.
 *                                              See 1 above
 *   ribbing on the pump that reads as grip   → the shared builder's four pump ribs, unchanged —
 *                                              which is why the pump can afford to wear walnut
 *                                              rather than a knurl map (see `SKIN`)
 *
 * ─── CLEARANCE: EVERY EDIT IN THIS PASS IS INWARD, DOWNWARD OR BACKWARD ──────────────────
 * Budgets: reach ≤ 0.40 as `hypot(|x| + sway, z)`, swayed ≤ 0.42, near ≥ 0.07. Last measured
 * worst case for this gun: reach 0.390 (the pump at reload), near 0.073 (the forearm). Neither
 * part is touched by anything below. Part by part:
 *
 *   muzzle.r  0.027 → 0.025   |x| −2 mm and the can's y-extent shrinks at both ends; z is
 *                             untouched, so the model's forward-most vertex (−0.145) keeps its
 *                             z and loses width. Strictly inward.
 *   sight     THIS PASS SPENDS NOTHING ON ANY AXIS AND HANDS BACK VOLUME ON ALL SIX. Every
 *                             extreme is unchanged or smaller, and `lineY` / `rearZ` — the only
 *                             two fields `aimSocketOf()` reads — are BYTE-IDENTICAL, so the ADS
 *                             solve, the socket assertion and the ADS translation are the same
 *                             numbers they were. Forward: the bead's front face retreats z −0.086
 *                             → −0.072, 14 mm back INSIDE the receiver's nose. Rearward: the lip's
 *                             back face retreats z 0.020 → 0.009, 11 mm forward of the receiver's
 *                             own back face, so the near-plane figure — 0.073, set by the FOREARM
 *                             130 mm further back — cannot have moved. Laterally the cheeks still
 *                             reach |x| 0.034, the receiver's own flank, and the bead reaches
 *                             |x| 0.0055: the gun is not one micrometre wider. Vertically the
 *                             topmost sight vertex is unchanged at `lineY` 0.063 — it is the sight
 *                             line itself and it does not move. The worst vertex is still the PUMP
 *                             at 0.390 in the reload pose, which nothing here touches.
 *   port      h 0.022 → 0.030 is vertical only. The lips' |x| (0.039) and the deflector's
 *                             (0.042) are set by `rSideX` and do not move; every z is derived
 *                             from `ep.z`/`ep.d`, both unchanged.
 *   shell     r 0.008 → 0.010 grows in y and z only — the cylinder's axis is x and its LENGTH
 *                             (0.016) is a builder constant, so its x extent is identical.
 *   rib       becomes 72 mm wide at |z| ≤ 0.079 → hypot(0.036 + sway, 0.079) ≈ 0.10. The
 *                             fore-end shroud already sits at |x| 0.035 / |z| 0.118 and the
 *                             choke at |x| 0.027 / |z| 0.145; both dominate it by 3-6 cm.
 *   panels    outer face 0.0245 → 0.0285 at |z| ≤ 0.110 → ≈ 0.125 swayed, against the shroud's
 *                             own 0.135 at the same sway. Dominated.
 *   selector  y only.
 *
 * Nothing moved toward +z, so the near-plane figure cannot have changed: the rib band's rear
 * face (z 0.013) is behind the receiver's own (0.020), which is itself 130 mm behind the
 * forearm that actually sets that number.
 */
const PROFILE: GunProfile = {
  id: 'boomstick',
  /**
   * 0.58 → 0.62 shipped, and UNTOUCHED here. The RELOAD pose is this gun's worst at 0.390 m and
   * its worst vertex is the PUMP, which this profile does not move — so there is no headroom to
   * spend and nothing to be gained by re-solving it.
   */
  depthCompress: 0.62,
  restDz: 0.009,
  /**
   * A NOTCH BITTEN OUT OF A LIP, AND A BEAD ON THE NOSE — the least sight in the arsenal, which
   * is what a shotgun wants because a shotgun is POINTED and not aimed. Nothing here rises off
   * the receiver on a neck; see point 1 of the header for the law, for the size arithmetic and
   * for why the bored ring (`opticBlock`) is refused on this gun specifically.
   *
   * THE FRONT ELEMENT IS `opticFront` AND IS NO LONGER BUILT FROM THESE FIELDS. `bladeW`,
   * `bladeD` and `notchHalfGap` therefore now describe the REAR ONLY, which is the whole reason
   * the bead could finally shrink: one shared `bladeW` cannot be 23.5 mm at the flank and 11 mm
   * on the nose at the same time. `frontH` and `frontZ` are INERT — the builder takes
   * `opticFront.footY` for the height and `opticFront.z` for the plane — and both are left equal
   * to what the bead actually does, so nothing here lies about the gun that gets built.
   *
   * The five constraints it is solved against:
   *
   * 1 · THE AIM SOLVE IS UNTOUCHED, TO THE BIT. `aimSocketOf` reads exactly two fields, `lineY`
   *     and `rearZ`, and NEITHER MOVED: 0.063 and −0.001, so the socket is still
   *     `(0, lineY, rearZ · depthCompress)` = `(0, 0.063, −0.00062)`, `adsOffsetOf` is still its
   *     exact negation in x and y, and the boot on-axis assertion (|x|, |y| against 1e-9) passes
   *     for the same reason it did before: the equation is an identity, not a tuned pair. The
   *     bead does not enter the solve either — the builder places it at x 0 with its top at
   *     `lineY − h/2 + h/2` = `lineY` for any `footY`, so it shares the socket's x AND y at any z
   *     and lands on the same camera axis. This pass changes the SIZE of two boxes and nothing
   *     about where the gun looks or where it shoots.
   *
   * 2 · THE LIGHT BARS GOT WIDER, NOT NARROWER, WHICH IS THE HAPPY HALF OF SHRINKING A SIGHT.
   *     The two elements sit at different distances at ADS and the hull is SCREEN-SPACE, so the
   *     comparison has to be angular. At `adsSightDistance` 0.235 the notch half-angle is
   *     0.0105/0.235 = 0.0447 rad; the bead is 64 mm further out, which `depthCompress` 0.62
   *     folds to 0.2747 m, so its half-angle is 0.0055/0.2747 = 0.0200. The bar is 0.0247 rad
   *     ≈ 21 px at the ADS FOV (846 px/rad, this file's own figure), and the sights carry
   *     `view.sightOutlinePx` (3.5) rather than the silhouette's 7, so it loses 7 px total and
   *     prints ≈ 14 px of daylight per side against the 10 px that shipped. The notch got
   *     6 mm NARROWER and the picture got BETTER, because the thing standing in it got 9.5 mm
   *     thinner.
   *
   * 3 · THE CHEEKS STILL ADD NO WIDTH AT ALL. `notchHalfGap` 0.0105 + `bladeW`/2 = 0.0105 +
   *     0.01175 = 0.034 — the receiver's own flank, exactly, as before. The outer wall of each
   *     cheek is coplanar with the flank below it, so the Sobel has one edge there and not two,
   *     and the pair reads as the receiver's own back end being NOTCHED rather than as a rail
   *     clamped on top of it. It is also why the clearance note above can say the gun is not one
   *     micrometre wider.
   *
   * 4 · THE METAL IS NOW WIDER THAN THE HOLE, AND THAT IS THE WHOLE FIX. Across the gun it reads
   *     23.5 · 21 · 23.5 where it shipped 20.5 · 27 · 20.5 — the void used to be the largest of
   *     the three fields, which is how a notch becomes "two blocks with a gap" and gets counted.
   *     The hole also has a FLOOR: the cheeks are 13 mm tall against a 0.058 top face, so between
   *     them is 5 mm of milled step with the receiver's own flat at the bottom of it. Metal both
   *     sides, metal underneath, one continuous 68 mm lip. Depth is 0.020 authored = **12.4 mm
   *     drawn** after `depthCompress`, against 68 mm across: 5.5 : 1, and unlike last pass's
   *     27 × 42 that ratio is quoted in the units the renderer actually uses (0.042 drew as 26,
   *     i.e. the "1.56 : 1 groove" shipped as a 27 × 26 square void — the exact shape it was
   *     trying not to be).
   *
   * 5 · NOTHING FOULS. `rearH` 0.013 bottoms the cheeks at y 0.050, 1.8 mm above the cocking
   *     serrations' 0.048 ceiling; the bead's `footY` 0.049 sits 9 mm above the barrel's 0.040
   *     crown and 9 mm inside the 0.058 top face. In z they are 54 mm apart (the lip ends at
   *     −0.011, the bead starts at −0.058) and neither touches the ejection port frame, whose top
   *     lip is at |x| 0.033 and spans z −0.027 → −0.077 — outboard of the bead's |x| 0.0055 and
   *     forward of the cheeks.
   *
   * INK FLOOR — every dimension of both parts, checked: cheeks 0.0235 W · 0.013 H · 0.020 D;
   * bead 0.011 W · 0.014 H · 0.014 D. All at or above the 0.010 m floor, and so is the 0.021 m
   * notch between the cheeks (a void under the band inks shut). The 5 mm PROUD STEP is not a part
   * and is not measured against the floor: it is a step in blocks whose smallest real dimension
   * is 11 mm, and the hull is drawn round the block, not round the step. Measured on screen it is
   * 24 px at the hip and 15 px at ADS against a 3.5 px line, so it holds albedo at both. Nothing
   * here is a wall, which is how the hood-shaped answer to this brief loses a front sight to the
   * hull.
   */
  sight: {
    // LIVE: the aim solve, byte-identical to what shipped. `frontZ` is shadowed by
    // `opticFront.z` and set to match it; `frontH` is inert for the same reason.
    lineY: 0.063, rearZ: -0.001, frontZ: -0.065,
    // REAR ONLY now — the front branch of the builder is replaced by `opticFront`.
    bladeW: 0.0235, rearH: 0.013, frontH: 0.014, bladeD: 0.020, notchHalfGap: 0.0105,
  },
  /**
   * NO BORED RING. Not "unset" — REFUSED, and refused by arithmetic. A ring's proud height is
   * `(lineY − receiverTop) + boreR + topWall`, `topWall ≥ INK_FLOOR` and `boreR ≥ INK_FLOOR/2`
   * or the void inks shut; a bore that leaves daylight around a 10 mm post at this gun's 64 mm
   * sight radius wants `boreR ≈ 0.010`. On a 0.058 top face with the line at 0.063 that floors
   * at 25 mm proud, against the 5 mm here. The complaint being answered is "too huge". The ring
   * is the marksman's part; this gun gets the subtractive version of the same idea — a notch with
   * a floor, cut into a lip that is flush with the flanks. See header point 1.
   */
  opticBlock: null,
  /**
   * THE BEAD — 11 mm across, 14 mm fore-and-aft (8.7 mm drawn), 14 mm tall of which 9 is buried
   * in the receiver and 5 stands proud. 154 mm² of plan-view where the pad it replaces was 861.
   *
   * `w` 0.011 is one millimetre over the ink floor and that is deliberate: it is the number the
   * light bars are bought with (point 2 — every millimetre off the bead is ≈ 2 px of daylight
   * back on each side), and at 53 px wide at the hip it still has 46 px of dark-iron albedo
   * inside the 3.5 px sight line. `d` 0.014 draws as 8.7 mm after `depthCompress` 0.62, so the
   * bead is very nearly SQUARE on screen — a stud, which is what a bead is, rather than the slab
   * that has been sitting on this nose for six passes.
   *
   * `z` −0.065 is unchanged from the pad it replaces, so the 64 mm sight radius and every
   * grazing-ray number in header point 2 (the choke's 2.7 mm of clearance under the eye line)
   * hold exactly. `footY` 0.049 puts its underside 9 mm inside the receiver's 0.058 top face —
   * the mass IS the sight, and the front face at z −0.072 is 14 mm inside the receiver's nose, so
   * the bead can never become a forward vertex.
   */
  opticFront: { w: 0.011, d: 0.014, z: -0.065, footY: 0.049 },
  /**
   * THE THICKEST RECEIVER IN THE GAME, AND SHORT ENOUGH FOR THE WIDTH TO READ AS GIRTH.
   * x ±0.034, y 0.002 → 0.058, z 0.020 → −0.086. Every number below that talks about "the top
   * face" or "the flanks" means those.
   */
  receiver: { w: 0.068, h: 0.056, d: 0.106, y: 0.030, z: -0.033 },
  /**
   * TWO, NOT THREE — arithmetic, and the right answer anyway. The serrations march back from
   * z 0.015 at a 17 mm pitch and the ejection port's deflector needs the band from −0.033 to
   * −0.021; a third tooth would land at −0.029..−0.019 and interleave a 1 mm proud tooth stack
   * with a 5 mm proud port frame, losing both reads. A pump gun's cocking read is the PUMP, so
   * this is the one gun that can spend its serrations.
   */
  serrations: 2,
  /**
   * Visible for its whole length: it spans −0.130 to −0.066, bridging the receiver's nose and
   * the choke's rear through the 29 mm window between them. Browned frame value, so it is the
   * mid tone that the dark shroud above it and the walnut cut in its flank both read against.
   */
  barrel: { r: 0.026, len: 0.064, y: 0.014, z: -0.098 },
  /**
   * THE CHOKE. `fins: 0` — a plain flared can, because the diameter IS the detail.
   *
   * `r` 0.025 is set by the sight picture and not by taste; the full derivation is in the header
   * (point 2). Short version: the builder puts the can on the receiver's centre line, so the can
   * is only invisible at ADS while `0.030 + r` stays under the grazing ray that leaves the eye
   * over the receiver's nose — and that ray passes the can's rear face at y 0.0577. At 0.027 the
   * margin was 0.7 mm, which is two pixels, which the 7 px silhouette hull eats: a pale BONE
   * crown printing as a smudge directly under the bead. At 0.025 it tops out at 0.055 and the
   * margin is 2.7 mm ≈ 7 px, where it can never enter the picture.
   */
  muzzle: { r: 0.025, len: 0.030, z: -0.130, fins: 0, finW: 0 },
  magazine: null,
  /**
   * The tube, and its y and z are a CLEARANCE decision rather than a taste one: the shared
   * builder derives the PUMP from `tube.y`/`tube.z`, and the pump is this gun's worst vertex in
   * the reload pose at 0.390 m against a 0.40 budget. Moving the tube forward a millimetre moves
   * the pump with it and spends margin that does not exist. Untouched.
   */
  tube: { r: 0.020, len: 0.088, y: -0.012, z: -0.090 },

  /**
   * THE HEAT SHIELD, built out of the `foreEnd` slot — §1's first ask for this gun.
   *
   * IT IS THE `foreEnd` AND NOT `railTeeth` BECAUSE OF PARENTING, not shape. A heat shield is
   * clamped to the BARREL, and the barrel is in the static `frame` mesh; everything in `steel`
   * rides the receiver, which reciprocates 14 mm on every shot. A shroud that sheared against
   * the barrel it is bolted to would read as a bug on every trigger pull.
   *
   * IT BRIDGES BOTH MASSES ON PURPOSE: z −0.082 to −0.118, overlapping the receiver's nose
   * (−0.086) by 4 mm and the choke's rear (−0.115) by 3 mm, so there is no floating gap at
   * either end. It sits at y 0.015–0.045 over a barrel that tops out at 0.040 — a HALF-TUBE,
   * covering the barrel's upper 25 mm and standing 5 mm proud, with the round frame-brown
   * underside showing all the way along.
   *
   * TWO RIBS, NOT THREE, AND THE REASON IS THE INK LINE. The builder spaces them across
   * `d × 0.68`; at two they are 24.5 mm apart with 14.4 mm of shroud showing between them, which
   * survives the 7 px hull on both the band AND the gap. At three the gap falls to 2.9 mm and
   * the whole stack prints as one black field.
   */
  foreEnd: { w: 0.070, h: 0.030, d: 0.036, y: 0.030, z: -0.100, ribs: 2 },
  /**
   * NO STOCK, DELIBERATELY. A pistol-grip-only pump is the shape that says "this hurts to fire"
   * before it is fired, and a stock is the one addition that would be spent at +z, where the
   * near plane (0.073 m against a 0.07 budget) is the tight number rather than reach.
   */
  stock: null,
  /**
   * THE RIB LEAVES THE TOP FACE AND BECOMES THE RECEIVER'S WAIST BAND — a 72 × 10 × 92 mm RUST
   * band along the receiver's lower edge, 2 mm proud on both flanks and hanging 8 mm below it.
   *
   * WHY IT MOVED. Two reasons, and the first one alone is decisive. (a) The sight arithmetic in
   * the header: a proud top rib forces `lineY` ≥ 0.070, i.e. 4 mm MORE stick on the one edge the
   * playtester keeps objecting to, and this gun's brief is a low sight milled into the mass.
   * (b) It was invisible anyway — a later pass raised the receiver to h 0.056, i.e. a top face
   * at 0.058, and left the rib at a top of 0.056, so the one warm mark on the gun had been
   * sitting two millimetres INSIDE the mass it was meant to decorate.
   *
   * WHY THIS PLACE. The band rides the slide (`accentSlide`), so it belongs to the receiver and
   * reciprocates with it — which is exactly what a shell-carrier line does. It threads the one
   * free lane on the flanks: the port shelf bottoms out at y 0.005 and the safety's lever tip at
   * 0.006, so a band spanning −0.006 → 0.004 clears both by a millimetre and clears nothing
   * else, because there is nothing else down there. It is 4 mm wider than the receiver and
   * 22 mm wider than the lower frame body it passes through, so it reads as a proud ledge on
   * both flanks and from below — a warm line low on the mass, where the eye reads a gun's
   * weight, instead of a warm line on the one edge the player is trying to aim along.
   */
  rib: { w: 0.072, h: 0.010, d: 0.092, y: -0.001, z: -0.033 },

  /**
   * THE BIGGEST EJECTION PORT IN THE GAME, WITH A SHELL IN IT — §1's second ask.
   *
   * `h` 0.022 → 0.030, AND THE NUMBER COMES OFF THE RECEIVER'S SIDE FACE. That face spans
   * y 0.002 → 0.058. At h 0.030 the top lip tops out at 0.055 and the shelf bottoms at 0.005, so
   * the frame fills the flank edge to edge with 3 mm of receiver showing above and below — the
   * proportion the port was authored for, before the receiver grew 8 mm taller underneath it and
   * left the port floating in the middle of the face with 12 mm of blank steel on either side.
   * The deflector grows with it (`h + 0.024` = 54 mm), which makes the gun's asymmetry event a
   * full-height bar rather than a tab.
   *
   * PLACED BY THE TWO THINGS IT MUST NOT TOUCH, and neither moved: the deflector's rear face
   * lands at −0.021, 9 mm clear of the last serration at −0.012, and the front wall's face at
   * −0.081, 5 mm inside the receiver's nose at −0.086.
   *
   * THE BRASS IS THE POINT. `shellR` 0.010 is a 20 mm round across a 30 mm opening — the fattest
   * in the game against the pistol's and the SMG's 12 mm, because a shotgun shell IS fat and
   * because this is the one warm mark on the gun that is not on the outline: a hot dot in the
   * middle of the one rectangle the eye is drawn to. It grows in y and z only; see the clearance
   * note in the header.
   */
  ejectionPort: { h: 0.030, d: 0.038, y: 0.030, z: -0.052, shellR: 0.010 },
  /**
   * NO CHARGING HANDLE. This gun's charging handle is the pump, it is 44 mm across, the support
   * hand is wrapped around it and the reload animation racks it. A second cocking device on the
   * receiver would be a lie about the mechanism, and it would hand back the asymmetry §0 asks
   * for, since the right flank is already spent on the port.
   */
  chargingHandle: null,
  /**
   * THE CROSS-BOLT SAFETY, built out of the `selector` slot — a round boss with a bar swung off
   * it is precisely a safety button and its detent lever, and it is what a pump gun has instead
   * of a fire selector.
   *
   * `y` 0.012 → 0.021 for one reason: the waist band now occupies −0.006 → 0.004 on this flank,
   * and at 0.012 the lever's swung tip reached down to 0.001 and grew out of it. At 0.021 the
   * boss spans 0.013 → 0.029 and the tip bottoms at 0.006, two millimetres clear. The 20° DOWN
   * and BACK sweep is kept — it points the lever at the trigger finger rather than at nothing.
   * LEFT flank, because the right is the port: the two faces of this gun carry different events,
   * and the left is the one the rest pose actually shows the player.
   */
  selector: { r: 0.008, len: 0.026, thick: 0.012, y: 0.021, z: -0.010, angleDeg: -20 },
  /**
   * NO MAG WELL. There is no magazine — the shells go up the tube, and the `magazine` slot on
   * this gun is spent on the pump. A flared collar at the butt would be a funnel into a grip
   * nothing is ever inserted through, which is the one thing the part is not allowed to be.
   */
  magWell: null,
  /**
   * NO SIGHT WINGS, AND THE REASON IS THIS PASS'S PRINCIPLE RATHER THAN A STYLE CALL. Ears are
   * the ADDITIVE answer to the sticks problem: two more things standing on the top edge, hoping
   * that three sticks read as a hood. They were removed from this arsenal twice already, by name,
   * for printing as pale bars, and a housing built out of them is walls — the exact shape the
   * 7 px hull eats, which is how this project has already lost a trigger guard and a front sight.
   * The hood read is bought SUBTRACTIVELY instead: mass with a notch cut through it. See `sight`.
   */
  sightWings: null,
  /**
   * ONE BOLD CUT PER FLANK, BITTEN OUT OF THE BARREL — and both halves of that sentence are the
   * fix. It shipped as two cuts per flank on a 24 mm pitch, and neither of them worked.
   *
   * `hostHalfW` 0.022 → 0.026, WHICH IS THE WHOLE PART. The builder places a cut's outer face at
   * `hostHalfW + 0.0025`; the barrel's radius is 0.026, so at 0.022 every cut's outer face sat
   * at 0.0245 — one and a half millimetres INSIDE the mass it was supposed to be cut into, i.e.
   * invisible. At 0.026 it stands 2.5 mm proud at the barrel's equator: a bitten-out step, which
   * is what the part is for.
   *
   * `count` 2 → 1, and it is the WINDOW that decides. Bare barrel runs from the receiver's nose
   * (−0.086) to the choke's rear (−0.115) — 29 mm. Two 16 mm cuts span 42 mm, so each one had an
   * end buried in a neighbour and showed under 10 mm, which is under the ink floor on the one
   * measure that matters: what the player can see. One 20 mm cut centred at −0.100 spans
   * −0.090 → −0.110 with a 4 mm margin at each end and is 20 mm of visible cut. Bigger, bolder,
   * fewer — §0, applied to the one place on this gun where the space is genuinely scarce.
   *
   * `y` 0.014 → 0.008 for the same reason. The shroud's underside is at 0.015; a cut topping out
   * at 0.020 had its top 5 mm swallowed and showed 7 mm. At y 0.008 it spans 0.002 → 0.014, one
   * millimetre under the shroud and clear of the tube below (whose top is 0.008, and whose
   * half-width there is 14 mm against the cut's inner face at 17.5 mm).
   *
   * BOTH FLANKS, which makes two cutouts on the gun — §1's ask. This is the one detail here
   * allowed to be symmetric: a shield vented down one side only reads as damage. The asymmetry
   * budget is spent on the port and the safety.
   */
  panels: {
    count: 1, side: 'both', h: 0.012, d: 0.020,
    y: 0.008, z: -0.100, step: 0.024, hostHalfW: 0.026,
  },
  /**
   * NO RAIL TEETH. Removed by name once already for reading as pale bars, and they are additive
   * furniture on the one edge five rounds of feedback have been about. This gun's top face is now
   * two milled bosses and 47 mm of bare machined flat between them; teeth would put the stack of
   * small proud shapes straight back and undo the whole first half of this pass.
   */
  railTeeth: null,
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RED WALNUT ON BROWNED STEEL — the warm gun, and now warm enough to be named across a room.
 *
 * The playtester: *"we need more differentiator colours, still look the same overall"*. The four
 * palettes were using a very small part of the space they are allowed. This one was the worst
 * offender in a specific way: its `steel` (#a67f5d, luma 0.52, hue 28°) and the marksman's
 * `frame` (#a37a57, luma 0.50, hue 28°) were the same colour to within a rounding error, and its
 * walnut (#946846, hue 26°) was the same hue family as both. Three of this gun's four fields
 * were sitting on top of the rifle's identity.
 *
 * The fix is hue and saturation, not brightness — the value ladder has to keep doing its job:
 *
 *   polymer  #403234  luma 0.208  hue 351°  sat 0.22   held in reserve, see below
 *   frame    #6a514b  luma 0.337  hue  12°  sat 0.29   BROWNED STEEL — receiver, barrel, tube,
 *                                                      guard, lower. Dark, warm, restrained
 *   wood     #bf5f3c  luma 0.443  hue  16°  sat 0.69   RED WALNUT — grip, heel, shroud, pump
 *   (RUST)   #f4761b  luma 0.542  hue  25°  sat 0.89   shared accent: waist band, shell, hammer
 *   steel    #b79472  luma 0.600  hue  30°  sat 0.38   the port frame and its deflector only
 *   (BONE)   #cbb89a  luma 0.729                       shared: the choke. NOT the sights — those
 *                                                      are the arsenal's dark iron, 0.188
 *
 * SIX STEPS, EVENLY SPREAD, ALL LEGAL. Every value is under `READABILITY.ENV_VALUE_CEIL` (0.78)
 * and under ACID's 0.849, so the enemy still owns the top of the ladder; nothing reaches BONE's
 * 0.729 except BONE; GOLD appears on this object only as the muzzle core; and neither reserved
 * hue (ACID 96°, HOT 340°) is within 80° of anything here. ART §9 intact.
 *
 * THE WALNUT IS `RUST` PULLED 32 % TOWARD `NIGHT_B`, and that one mix is the whole "redder,
 * richer" note. NIGHT_B is the palette's connective violet, so pulling toward it rotates the hue
 * DOWN the wheel (25° → 16°, i.e. orange → red) and drops the value (0.542 → 0.443) without
 * touching saturation much (0.89 → 0.69). The result is a mahogany that is unmistakably a
 * different colour from both the RUST accent sitting next to it on the receiver — 10 points of
 * luma and 9° of hue apart — and from the marksman's pale desert tan, which is 6 points brighter,
 * 12° yellower and only 47 % saturated. HOT (0xff2e63) is the obvious way to push a red and it is
 * not available: it belongs to enemies. This gets there through a token that does not.
 *
 * THE STEEL IS SMALLER AND BRIGHTER. It is worn by four bars around one rectangle, so it can
 * afford to be the brightest field on the gun (0.52 → 0.60) — a bronzed lip that makes the port
 * the thing the eye lands on. It is one notch LESS saturated than it was (0.44 → 0.38), which is
 * what keeps a warm 0.60 reading as polished metal rather than drifting toward the GOLD that
 * §9 reserves for interactables (0.78, 43°, sat 0.81 — three moves away on every axis).
 *
 * THE FRAME STAYS DARK ON PURPOSE. It is the largest mass on screen and the environment's SLATE
 * building faces sit at 0.318; at 0.337 the receiver is a hair brighter than the wall behind it
 * AND its complement in hue (12° against 221°), which is a stronger separation than value alone
 * would buy. It gains what it is allowed to gain: saturation 0.22 → 0.29 and hue 3° → 12°, so it
 * finally reads as BROWNED steel rather than as the neutral grey-plum it was.
 *
 * `polymer` IS UNUSED BY THIS GUN'S SKIN and is deliberately still coherent. Every part in the
 * polymer group wears `wood` here (see `SKIN`), so nothing samples this colour today — but
 * `fieldFor` hands it to any surface generator that ever asks, and a stranded grey in this slot
 * is exactly the silent hole that let a gun wear another gun's finish. It is authored as this
 * gun's own dark end: the same SLATE→RUST browning, taken to 0.21.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const FIELDS: FieldSet = {
  frame: hexMix(hexMix(PALETTE.SLATE, PALETTE.RUST, 0.32), PALETTE.INK, 0.16),
  polymer: hexMix(hexMix(PALETTE.SLATE, PALETTE.RUST, 0.30), PALETTE.INK, 0.52),
  steel: hexMix(hexMix(PALETTE.BONE, PALETTE.RUST, 0.20), PALETTE.INK, 0.14),
  wood: hexMix(PALETTE.RUST, PALETTE.NIGHT_B, 0.32),
};

/**
 * THE WOOD GUN, ALL THE WAY THROUGH. Every part the hand touches is walnut and every part of the
 * mechanism is browned steel — which is what a pump gun with wood furniture actually is, and it
 * is the one identity in the arsenal no other weapon is allowed to spend (the marksman takes a
 * uniform phosphate instead, precisely so this stays unique).
 *
 * THE PUMP MOVES FROM KNURLED STEEL TO WALNUT, and the argument that kept it steel — "the pump
 * is the part the hand rides" — turns out to be an argument for wood. The grip read on that part
 * is carried by the builder's four geometric ribs, which are 10 mm blocks on the OUTLINE and
 * therefore survive the ink line; the knurl map was doing that job a second time in a way the
 * 7 px hull mostly erases. Spending it on timber instead makes the shroud, the grip and the pump
 * one continuous walnut assembly with the barrel and tube running dark through the middle of it.
 *
 * DIFFERENT TILE DENSITIES ON PURPOSE: 14 tiles/m across the shroud and grip (a 71 mm tile, four
 * grain bands of 18 mm each), 18 on the 50 mm pump (a 56 mm tile, 14 mm bands, so a whole grain
 * cycle and its knot land on the part rather than one smeared gradient). Same timber, two pieces.
 *
 * THE METAL WEARS NO MAP AT ALL. Parkerising is the pistol's and the marksman's, chipping and
 * venting are the SMG's; a fourth pattern on the fourth gun would be four textures reading as one
 * noisy family. An even, unmarked browning is its own finish — and against the grain it is
 * carrying next to it, "the metal is the plain part" is the strongest thing it can say.
 */
const SKIN: WeaponSkin = {
  frame: plainFrame,
  slide: plainFrame,
  polymer: { mat: 'wood', uv: 14 },
  steel: plainSteel,
  magazine: { mat: 'wood', uv: 18 },
};

export const BOOMSTICK: WeaponModelDef = { profile: PROFILE, fields: FIELDS, skin: SKIN };

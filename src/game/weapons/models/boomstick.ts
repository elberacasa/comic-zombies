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
 * 1 · THE STALK IS GONE. THE TOP OF THE RECEIVER IS NOW A RIB WITH A GROOVE IN IT. This is the
 *     SIXTH report of the same thing — *"gray lines on top"*, *"sights too long"*, *"3 grey thing
 *     on top"*, *"sticks like showing out"*, *"remove and remake, that design looks bad and not
 *     competitive at all"* — and every previous pass, this file's own last one included, answered
 *     it by RESHAPING the blades: shorter, darker, fewer, wider, deeper. None of it could work.
 *     A screenshot with the ink pass off finally said why: they were BLOCKS STANDING ON STALKS,
 *     and reshaping a block does not remove the stalk under it.
 *
 *     THE LAW THIS PASS IS WRITTEN UNDER: **a sight may not RISE OFF the receiver.** Its height
 *     must come from a chunky block that reads as machined INTO the gun. The test is literal —
 *     could you mistake any part of it for an antenna? Then it is wrong.
 *
 *     A shotgun is POINTED, not aimed, so it needs the least sight in the arsenal: a bead on a
 *     rib. That is what this is now, and the three numbers that make it are the PROUD HEIGHT, the
 *     PLAN-VIEW ASPECT and the SIGHT RADIUS:
 *
 *       proud height   8 mm → 5 mm   (`lineY` 0.066 → 0.063 against a 0.058 top face)
 *       bladeD        0.028 → 0.042  (the pads are now LONGER than the groove is wide)
 *       sight radius  0.078 → 0.064  (what pays for the length; see 2 below)
 *
 *     · THE REAR IS A GROOVE, NOT A GAP BETWEEN TWO THINGS. `notchHalfGap` 0.0135 → 0.0135 and
 *       `bladeW` 0.020 → 0.0205 puts the two cheeks' outer faces on |x| 0.034 — DEAD ON the
 *       receiver's own flank, so the pair adds not one micrometre of width and the Sobel merges
 *       their outer walls into the flank's existing line. What changed is the aspect of the void
 *       between them: it was 27 mm wide × 28 mm long, i.e. SQUARE, which is the plan-view of a
 *       gap between two blocks. It is now 27 × 42 — half again as long as it is wide, which is
 *       the plan-view of a groove milled down a rib. Same two boxes, opposite read.
 *
 *     · THE FRONT IS A BEAD PAD LAID ALONG THE NOSE. 20.5 wide × 42 long × 5 proud, spanning
 *       z −0.044 → −0.086, so its front face is dead flush with the receiver's nose and its
 *       length is TWICE its width. A 5 mm step on a 42 mm pad is 8.4 : 1 in profile. There is no
 *       aspect ratio at which that is a post.
 *
 *     · BOTH ARE MOSTLY BURIED. `frontH` 0.014 and `rearH` 0.013 against a top face at 0.058:
 *       9 mm and 8 mm of each block is inside the receiver, 5 mm is out. The mass IS the sight.
 *       The rear cheeks bottom at 0.050, 1.8 mm above the cocking serrations' 0.048 ceiling; the
 *       front pad bottoms at 0.049, 9 mm above the barrel's 0.040 crown.
 *
 *     · WHAT IT COSTS ON SCREEN, MEASURED RATHER THAN HOPED. At the hip the hero lens is ×2.6
 *       and 5 mm subtends ≈ 24 px, of which the sights' 3.5 px line takes 7 — 17 px of dark-iron
 *       albedo, a low machined ledge rather than a black smear. At ADS the lens is identity and
 *       the picture is: two 71 × 18 px shoulders, a 200 px window between them, the receiver's
 *       own flat closing the bottom of that window 14 px under the crosshair, and the bead
 *       rising 15 px out of it to touch the line. ≈ 10 px of daylight each side of the bead
 *       after ink (see the `sight` block, point 2). That is a shotgun sight picture.
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
 *   a bold front sight on a raised base      → `sight` — a BEAD PAD laid along the receiver's
 *                                              nose, 42 mm long and 5 mm proud, rather than a
 *                                              post stood on it. §1 wrote "on a raised post" and
 *                                              the post is exactly what six rounds of feedback
 *                                              have been about, so the brief is answered on its
 *                                              intent (a bold, deliberate front sight) and
 *                                              refused on its letter. See 1 above
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
 *   sight     THIS PASS SPENDS NOTHING AND HANDS BACK HEIGHT. Every extreme is unchanged or
 *                             smaller. Forward: the front pad's front face is still z −0.086,
 *                             flush with the receiver's nose, exactly where it was — `bladeD`
 *                             0.028 → 0.042 and `frontZ` −0.072 → −0.065 cancel by construction,
 *                             and the extra 14 mm of length is spent BACKWARD, toward the hand.
 *                             Rearward: the cheeks still end on z 0.020, the receiver's own back
 *                             face (`bladeD`/2 grew 7 mm and `rearZ` 0.006 → −0.001 gave it back),
 *                             so the near-plane figure — 0.073, set by the FOREARM 130 mm further
 *                             back — cannot have moved. Laterally the cheeks reach |x| 0.034,
 *                             which is the receiver's own flank: the gun is not one micrometre
 *                             wider. Vertically the topmost sight vertex drops 0.066 → 0.063, and
 *                             in the rolled sprint and reload poses a 3 mm drop on the highest
 *                             part of the upper is 3 mm off a rotated lever arm. The worst vertex
 *                             is still the PUMP at 0.390 in the reload pose, which nothing here
 *                             touches; the front pad's own worst is hypot(0.0103 + 0.020, 0.086)
 *                             ≈ 0.091 against a 0.40 budget, dominated by 6 cm.
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
   * A GROOVE DOWN THE BACK OF THE RIB AND A BEAD PAD ALONG ITS NOSE — a shotgun's sight, which
   * is the least sight in the arsenal because a shotgun is POINTED and not aimed. Nothing here
   * rises off the receiver on a neck; see point 1 of the header for the law and for the three
   * numbers that carry it. The five constraints it is solved against:
   *
   * 1 · THE AIM SOLVE STILL HOLDS, AND IT HOLDS BY CONSTRUCTION RATHER THAN BY LUCK.
   *     `aimSocketOf` reads exactly two fields, `lineY` and `rearZ`, and BOTH MOVED: 0.066 →
   *     0.063 and 0.006 → −0.001. That is fine and it is the intended way to change a sight —
   *     the socket is `(0, lineY, rearZ · depthCompress)` = `(0, 0.063, −0.00062)` and
   *     `adsOffsetOf` is its exact negation in x and y, so `socket + ads` is `(0, 0, …)` to the
   *     bit and the boot on-axis assertion (which tests |x| and |y| against 1e-9) passes for the
   *     same reason it did before: the equation is an identity, not a tuned pair of numbers. The
   *     front pad does not enter the solve at all — the builder places it at x 0 with its top at
   *     `lineY - frontH/2 + frontH/2` = `lineY`, so it shares the socket's x AND y at any z and
   *     lands on the same camera axis. What LOWERING `lineY` actually does is re-solve the ADS
   *     translation 3 mm further up, which is invisible, and drop the model's highest vertex by
   *     3 mm, which is the entire point of the pass.
   *
   * 2 · THE LIGHT BARS SURVIVE THE INK, which is the bug the SIGHT block in `viewmodel.ts`
   *     exists to record, and it is TIGHTER here than it was because the sight radius got
   *     shorter. The two elements sit at different distances at ADS and the hull is SCREEN-SPACE,
   *     so the comparison has to be angular. At `adsSightDistance` 0.235 the notch half-angle is
   *     0.0135/0.235 = 0.0575 rad; the bead pad is 64 mm further out, which `depthCompress` 0.62
   *     folds to 0.2747 m, so its half-angle is 0.01025/0.2747 = 0.0373. The bar is 0.0201 rad,
   *     ≈ 17 px at the ADS FOV, and the sights carry `view.sightOutlinePx` (3.5) rather than the
   *     silhouette's 7, so it loses 7 px total and prints ≈ 10 px of daylight per side. That is
   *     the price of the 14 mm of extra pad length, paid knowingly: 14 px of bar bought the
   *     plan-view aspect that stops the thing reading as blocks, and 10 px is still daylight.
   *
   * 3 · THE CHEEKS ADD NO WIDTH AT ALL. `notchHalfGap` 0.0135 + `bladeW`/2 = 0.0135 + 0.01025 =
   *     0.034 — the receiver's own flank, exactly. The outer wall of each cheek is coplanar with
   *     the flank below it, so the Sobel has one edge there and not two, and the pair reads as
   *     the receiver's back end being GROOVED rather than as a rail clamped on top of it. It is
   *     also why the clearance note above can say the gun is not one micrometre wider.
   *
   * 4 · THE GROOVE IS LONGER THAN IT IS WIDE, AND THAT IS THE WHOLE FIX. 27 mm across, 42 mm fore
   *     and aft, 5 mm deep. The last pass had 27 × 28 — a square void, which is the plan-view of
   *     a GAP BETWEEN TWO BLOCKS no matter how the blocks are shaped. At 1.56 : 1 it is the
   *     plan-view of a channel milled down a rib. The front pad is the same trade: 20.5 wide by
   *     42 long is 2 : 1 lying down, and 5 proud on 42 long is 8.4 : 1 in profile.
   *
   * 5 · NOTHING FOULS. `rearH` 0.013 bottoms the cheeks at y 0.050, 1.8 mm above the cocking
   *     serrations' 0.048 ceiling; `frontH` 0.014 bottoms the pad at 0.049, 9 mm above the
   *     barrel's 0.040 crown. In z the two are 22 mm apart (rear ends at −0.022, pad starts at
   *     −0.044) and neither touches the ejection port frame, whose top lip is at |x| 0.033 and
   *     spans z −0.027 → −0.077 — outboard of the pad and forward of the cheeks.
   *
   * INK FLOOR — every dimension of both parts, checked: 0.0205 W · 0.042 D · 0.013 rear H ·
   * 0.014 front H. All at or above the 0.010 m floor, and so is the 0.027 m groove between the
   * cheeks. The 5 mm PROUD STEP is not a part and is not measured against the floor: it is a step
   * in a block whose smallest real dimension is 13 mm, and the hull is drawn round the block, not
   * round the step. Measured on screen it is 24 px at the hip and 15 px at ADS against a 7 px
   * line, so it holds albedo at both. Nothing here is a wall, which is how the hood-shaped answer
   * to this brief loses a front sight to the hull.
   */
  sight: {
    lineY: 0.063, rearZ: -0.001, frontZ: -0.065,
    bladeW: 0.0205, rearH: 0.013, frontH: 0.014, bladeD: 0.042, notchHalfGap: 0.0135,
  },
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

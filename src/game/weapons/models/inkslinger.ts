/**
 * INKSLINGER — one weapon, one file: its proportions, its palette and its surfaces.
 *
 * The runtime that consumes this lives in `../viewmodel.ts`; the contract it is written
 * against is in `./types.ts`. Nothing here knows how a box is bevelled or how a material is
 * made — and nothing there knows this weapon exists except through `./index.ts`.
 */

import type { FieldSet, GunProfile, WeaponModelDef, WeaponSkin } from './types';
import { FIELD, plainSteel } from './types';
import { PALETTE, hexMix } from '@/art/palette';

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE SIGHT — SIXTH PASS, AND THIS ONE ONLY TAKES THINGS AWAY. Same two events in the same two
 * places at the same height; 45 % less solid in both of them.
 *
 * ─── SIX REPORTS, AND WHAT THE SIXTH ONE ACTUALLY SAID ────────────────────────────────────
 * *"gray lines on top"* → *"sights too long"* → *"3 grey thing on top"* → *"sticks like showing
 * out"* → *"remove and remake a better sight"* → **"the 3 sights look bad like too huge?"**
 *
 * The sixth is two complaints wearing one sentence and they have to be answered separately:
 *   · **THREE.** The player is counting SOLIDS. On a notch sight there are literally three —
 *     left wall, right wall, front post — and the two walls do not read as one part because
 *     there is nothing bridging them. That is a real defect and it has a real fix (a bored
 *     ring), which this gun cannot afford; see the next section, which is arithmetic, not
 *     taste.
 *   · **TOO HUGE.** That one is answerable here and in full, and it is what this pass does.
 *
 * ─── WHY THE PISTOL DOES NOT GET THE BORED APERTURE ───────────────────────────────────────
 * `OpticBlockSpec` is the fix for "three solids": one machined part, a hole through it, material
 * above the hole AND below it. It landed for the marksman. It is arithmetically impossible here,
 * and the formula is in the interface itself:
 *
 *     proud = (lineY − slideTop) + boreR + topWall
 *           = (0.061 − 0.049) + boreR + topWall
 *
 * `topWall` cannot go under `INK_FLOOR` (0.010) and `boreR` cannot go under `INK_FLOOR / 2`
 * (0.005) or the VOID inks shut and the ring becomes a solid block again. So the smallest legal
 * bored ring on this gun stands **27 mm proud of the slide** — against the 12 mm that is there
 * now. Fixing "three" by shipping a part two and a quarter times taller is answering half a
 * complaint with the other half, on the one gun whose sight line the entire ADS solve is anchored
 * to. The pistol stays SUBTRACTIVE: a slot milled down into the slide's top mass, and a boss
 * grown out of it. If "three" outlives this build, the lever is `lineY`, not a ring — see the
 * bottom of this block, where that trade is priced.
 *
 * ─── SO EVERY MILLIMETRE CAME OFF THE TWO AXES THAT WERE FREE ─────────────────────────────
 * Proud height is FORCED: it is `lineY − slideTop`, and `lineY` is the aim socket. Width and
 * depth are not, and both were authored far past what the read needs.
 *
 *                       was            now          Δ
 *   rear body   w      44 mm          36 mm       −18 %   (overhang per flank 7 → 3 mm)
 *   rear body   d      30 mm          18 mm       −40 %
 *   front boss  w      12 mm          11 mm        −8 %
 *   front boss  d      30 mm          18 mm       −40 %
 *   PROUD HEIGHT       12 mm          12 mm         0     (= lineY, deliberately frozen)
 *   solid volume     23 040 mm³     13 824 mm³    −40 %
 *
 * Depth is where the money was. The complaint named it in the marksman's words — "30 mm fore-and-
 * aft" — and nothing depends on it: sight radius is `frontZ − rearZ`, not blade length, and the
 * ink line cares about cross-section, not run. `depthCompress` 0.66 then shrinks it again on the
 * way out, so 30 mm drew as 19.8 and 18 mm draws as 11.9 — against 12 mm of proud height, the
 * rear body is now SQUARE in profile where it was a 1.65:1 slab. It stopped being a block lying
 * on the gun and became the cross-section of a slot.
 *
 * ─── WHERE THE THREE SOLIDS SIT, AND WHY NONE OF THEM STANDS ON ANYTHING ──────────────────
 * The slide is 30 mm wide, its top face is at y 0.049, and `bevelBox`'s 7 mm chamfer means that
 * top face is a 16 mm-wide FLAT (x ±0.008) with the corners falling away to the shoulder line at
 * (±0.015, 0.042). Every placement below is measured against those three numbers.
 *
 *   REAR — a 36 × 20 × 18 mm body with a 14 mm slot down the middle, CUT INTO the slide rather
 *   than parked on it. Its top is `lineY` 0.061 (12 mm proud) and its bottom is 0.041 — ONE
 *   MILLIMETRE BELOW the slide's shoulder line and 1.4 mm below the top of the cocking
 *   serrations. That is the whole subtractive trick: the body's underside does not rest on the
 *   slide's top face, it passes THROUGH it and terminates on the widest line the slide has, so
 *   there is no base, no seam and no gap for the ink pass to find. At 36 mm it overhangs each
 *   flank by 3 mm — under the ink band at this range, i.e. flush to look at — where the 44 mm
 *   body overhung by 7 mm and read as a plate bolted on top. The slot is 14 mm wide and 12 mm
 *   deep with the slide's own top face as its floor: a MILLED NOTCH.
 *
 *   FRONT — an 11 × 24 × 18 mm boss, 12 mm proud and 12 mm BURIED, and at x ±0.0055 it sits
 *   wholly inside the slide's 16 mm flat. It grows straight out of the flat with no chamfer
 *   valley beside it and no visible root, which is the difference between a boss and a post: a
 *   post has a bottom edge you can see, this does not.
 *
 * ─── THE SIGHT PICTURE, RE-DERIVED FROM SCRATCH FOR THE NARROWER NOTCH ────────────────────
 * The eye sits `view.adsSightDistance` 0.235 m from the socket, which is at gun-space `rearZ`, so
 * anything at gun-space `z` is at `d(z) = 0.235 + (0.002 − z) × 0.66` and subtends `x / d` rad.
 *
 *   notch window   ±0.007 at d 0.2350   = ±29.8 mrad
 *   front post     ±0.0055 at d 0.3089  = ±17.8 mrad
 *   LIGHT BAR                             12.0 mrad each side
 *   hammer spur    top 0.0529, d 0.2192  → closes the picture below 37.0 mrad
 *
 * Narrowing the notch from ±0.010 to ±0.007 costs 11 mrad of bar (23.0 → 12.0) and buys 8 mm of
 * body width. That is the trade this pass is making and it is the right way round: 12 mrad is
 * still two thirds of a post-width of daylight either side, and the human has never once
 * complained that the notch was tight — they have complained six times that it was big.
 *
 * THE RIB HAD TO COME WITH IT, and this is the part that would have shipped as a bug. The RUST
 * rib runs forward from inside the notch, so it is nearer the eye than the post at every ray
 * under the line, and at its old 14 mm it was ±0.007 — EXACTLY the new notch's inner faces. The
 * slot's floor would have been rib, wall to wall, and the light bars would have closed to nothing:
 * the "orange mass filling the notch" bug, walked into from the other side. So `rib.w` 0.014 →
 * 0.010, and the result is better than what it replaces rather than merely survivable:
 *
 *   rib z      d        half-angle    starts occluding at
 *   0.000    0.2363     ±21.2 mrad        38.1 mrad   ← behind the hammer, never seen
 *   −0.052   0.2706     ±18.5 mrad        33.3 mrad
 *   −0.104   0.3050     ±16.4 mrad        29.5 mrad   ← narrower than the post's ±17.8
 *
 * Above 29.5 mrad the picture is open sky. Between 29.5 and 32.0 the rib is INSIDE the post's own
 * width and invisible behind it. Between 32.0 and 37.0 it peeks past the post by at most 2.8 mrad
 * and still leaves a 9.3 mrad bar; below 37.0 the hammer has closed everything anyway. At the old
 * 14 mm the same worst case left a **1.0 mrad** bar. The rib is now the one occluder that never
 * enters the sight picture at all.
 *
 * ─── INK FLOOR (`INK_FLOOR` 0.010), EVERY SOLID, EVERY AXIS ───────────────────────────────
 * front boss 11 × 24 × 18 · rear walls 11 × 20 × 18 · rib 10 × 11 × 104. Smallest dimension
 * anywhere is the rib's 10 mm, ON the floor; the sight solids are 11 mm, 10 % over. The sights
 * are built with `bevelBox`, which does NOT clamp and does NOT warn — `inkChunk` is the part that
 * does both and the sight solids do not go through it — so this line is the only thing between
 * the file and a black bar on the top edge. It is affordable at 11 mm because the sights carry
 * `view.sightOutlinePx` (3.5 px), half the silhouette's band, which is the whole reason that
 * separate thinner hull exists.
 *
 * THE VOIDS, which a hull is blind to and which is how this project has already lost a trigger
 * guard:
 *   · the notch is 14 mm of air — 40 % over the floor, and the number the light bars come from;
 *   · rear body front face −0.007 to front boss rear face −0.101 is 94 mm of clear air, up from
 *     82, because both solids got shorter and neither moved;
 *   · the rear body's underside at 0.041 against the serration tops at 0.0424 is NOT a 1.4 mm
 *     gap, it is a 1.4 mm INTERPENETRATION. A gap there would have printed the rear of the slide
 *     as one black band. Solids that touch are safe; solids that nearly touch are not;
 *   · the boss's rear face is at −0.101 and the rib's front end at −0.104, so those two
 *     INTERPENETRATE by 3 mm as well. That is why `frontZ` did NOT move forward to chase the
 *     shorter boss back out to the slide's nose: at `bladeD` 0.018 a `frontZ` of −0.116 would
 *     have left a 3 mm GAP there instead of a 3 mm overlap, and the two hulls would have merged
 *     into one black smear across the front of the slide. The boss now terminates the warm spine
 *     instead — dark iron capping RUST, one continuous mass;
 *   · the rib's flank at ±0.005 against the notch's inner faces at ±0.007 is a 2 mm lateral gap,
 *     under the band, so it will ink shut. That is DESIGNED: it lies at the very back of the slot
 *     and only becomes visible below 38.1 mrad, which is a millirad past where the hammer has
 *     already closed the picture. At hip it reads as the shadow line of a milled slot, which is
 *     what it is.
 *
 * ─── IF "THREE" SURVIVES THIS BUILD, THE NEXT LEVER IS `lineY`, AND HERE IS ITS PRICE ─────
 * `lineY` 0.061 → 0.058 takes the proud height of both solids from 12 mm to 9 mm in one number.
 * It costs the sight picture: the rib's far end starts occluding at (0.058 − 0.052) / 0.305 =
 * 19.7 mrad instead of 29.5 and becomes the binding occluder ahead of the hammer's 23.3, so the
 * clear post drops from 29.5 mrad to 19.7 — 6.1 mm of visible post against 9 mm of proud post,
 * where today it is 9.1 of 12. It also moves `aimSocketOf()` and therefore the whole ADS
 * translation on the gun every other gun's feel is measured against. Do it deliberately, with the
 * human watching, and lower the rib with it — not as a side effect of a width pass.
 *
 * NO WINGS, NO RAIL TEETH, EVER. Both were pale bars added ON TOP of the top edge — the additive
 * answer to an additive problem — and they are not coming back.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const SIGHT = {
  /**
   * THE sight line: the top edge of the front boss and of both rear walls, and the number
   * `aimSocketOf()` anchors the whole ADS solve to. Gun space, metres.
   *
   * 0.066 → 0.061. The slide's top face is at 0.049, so this is 12 mm of proud sight where there
   * were 17 — the single change that takes the stalk out of all three solids. It is the LOWEST
   * this can go without moving something else: the hammer spur (top 0.0529, hard-coded in the
   * builder) closes the sight picture 37 mrad below the line here, and every further millimetre
   * off `lineY` takes ~4.5 mrad of clear post with it.
   */
  lineY: 0.061,
  /**
   * Rear notch centre and front boss centre, along the slide. BOTH UNCHANGED, and `frontZ` is
   * unchanged ON PURPOSE rather than by omission.
   *
   * `rearZ` is the aim socket's z, so it cannot move without moving the ADS solve. `frontZ` is
   * sight RADIUS, not sight LINE — the socket does not read it and the boss's top sits on `lineY`
   * at any z — and the obvious move when `bladeD` came down from 30 to 18 was to push it forward
   * to −0.116 so the boss's front face stayed at −0.125 (two millimetres behind the slide's nose
   * at −0.127, where it was). That would have been a bug. The boss's REAR face is the load-bearing
   * end: the RUST rib's front end is at −0.104, and at `frontZ` −0.110 the shortened boss reaches
   * back to −0.101 and still INTERPENETRATES the rib by 3 mm. At −0.116 it would reach back only
   * to −0.107 and leave a 3 mm GAP — two solids a hull's width apart, which prints as one black
   * smear. Solids that touch are safe; solids that nearly touch are not.
   *
   * Leaving it put also refunds 6 mm of forward clearance: the boss's front face retreats from
   * −0.125 to −0.119, and the reach budget is quoted from the muzzle can at −0.153 regardless.
   */
  rearZ: 0.002,
  frontZ: -0.110,
  /**
   * Wall thickness and post width — the builder feeds one number to both. 0.012 → 0.011, which is
   * 2 mm off the rear body's outer width and 1 mm off the post's.
   *
   * 11 mm is 10 % over `INK_FLOOR` rather than the 20 % this file used to insist on, and the
   * margin is affordable for exactly one reason: the sights are drawn with
   * `view.sightOutlinePx` (3.5 px), half the silhouette band the floor was derived against. That
   * thinner hull exists so interior detail can be finer than the outline; this is the file
   * finally spending it. Do not take it to 0.010 — `bevelBox` neither clamps nor warns, so the
   * floor here is enforced by this comment and nothing else.
   */
  bladeW: 0.011,
  /**
   * How far each solid reaches DOWN from the line. NEITHER IS A VISIBLE HEIGHT — the visible
   * height of both solids is `lineY − 0.049` = 12 mm, and these numbers only say how deep the
   * root is buried. Both are sized to a LANDMARK on the slide rather than to a clearance, and
   * both are unchanged, because burying more is free and burying less is how a boss turns back
   * into a post:
   *   rearH  0.020 → bottom 0.041, one millimetre below the slide's shoulder line (±0.015,
   *          0.042) and 1.4 mm below the serration tops. The body passes through the slide's
   *          top instead of resting on it — no base, no seam, no gap.
   *   frontH 0.024 → bottom 0.037, twelve millimetres inside a slide whose own underside is at
   *          0.011. At x ±0.0055 the boss is inside the 16 mm top flat, so every millimetre of
   *          that root is buried and invisible and the boss has no bottom edge to read as a neck.
   */
  rearH: 0.020,
  frontH: 0.024,
  /**
   * Fore-and-aft length on both solids, 30 → 18 mm, and this is where most of the "too huge" is
   * paid off. Depth is the one axis nothing else depends on — sight radius is `frontZ − rearZ`,
   * not blade length, and the ink line cares about cross-section, not run — and `depthCompress`
   * 0.66 shrinks it again on the way out, so 30 mm DREW as 19.8 and 18 mm draws as 11.9. Against
   * 12 mm of proud height the rear body is now square in profile where it was a 1.65:1 slab: the
   * cross-section of a slot rather than a block lying on the gun.
   */
  bladeD: 0.018,
  /**
   * Half the notch gap, 0.010 → 0.007. Via the builder's `±(notchHalfGap + bladeW/2)` placement
   * this is the OTHER half of the rear body's outer width, and the pair takes it from 44 mm to
   * 36 mm on a 30 mm slide — 3 mm of overhang per flank, under the ink band, instead of 7 mm of
   * plate hanging over each side.
   *
   * It costs 11 mrad of light bar (23.0 → 12.0 either side of the post) and it is the reason
   * `rib.w` had to come down to 0.010 in the same pass: at 14 mm the rib was ±0.007, exactly the
   * new notch's inner faces, and the slot's floor would have been rib from wall to wall. The full
   * derivation is in the SIGHT block above. Do not narrow this further without re-deriving it —
   * the post is ±17.8 mrad and the bars vanish at ±0.0055.
   */
  notchHalfGap: 0.007,
} as const;

/**
 * INKSLINGER — the pistol, and the reference every other gun is read against.
 *
 * THE PROPORTIONS ARE FROZEN. `receiver`, `sight.lineY`, `depthCompress`, `barrel`, `magazine`
 * and `rib` are BUILD 007's numbers to the millimetre: this is the model whose clearance the
 * whole budget is quoted from and whose sight line the ADS solve is anchored to.
 *
 * ─── THE FIVE READS WEAPON_ART §1 ASKS THIS GUN FOR ─────────────────────────────────────
 * ejection port · extractor · beavertail · slide-lock lever · a squared-off guard hook. Four
 * of them are vocabulary parts; the other two are the base `stock` and `foreEnd` slots doing a
 * job the vocabulary has no entry for, which is explained where each one is set.
 *
 * ─── AND WHY IT IS SEVEN ZONES AND NOT SEVENTY PARTS (§0) ───────────────────────────────
 * Every addition is one BOLD mass in a zone that had nothing in it, and no two of them are on
 * the same face:
 *
 *   rear-right   ejection port frame + brass in the port   (steel + RUST, rides the slide)
 *   rear-left    slide-lock boss and lever                 (polymer, static)
 *   top-rear     beavertail tang over the web of the hand  (polymer, static)
 *   bottom       flared magwell funnel at the butt         (polymer, static)
 *   front-low    squared guard hook                        (polymer, static)
 *   front-end    a two-plate compensator on a short can    (BONE trim, the one pale mass)
 *   front-left   two stamped cuts in the dust cover        (polymer, static)
 *
 * That is four value fields on one gun — polymer 0.29, frame 0.40, steel 0.58, BONE 0.73 — plus
 * the RUST warm read, which §2 calls the biggest available win and which costs no geometry at
 * all. Left and right carry DIFFERENT events, so the gun is asymmetric from every angle the
 * player can put it at.
 *
 * ─── CLEARANCE: WHERE THIS BUILD SPENDS AND WHERE IT BUYS ───────────────────────────────
 * Budgets: reach ≤ 0.400 · swayed ≤ 0.420 · near ≥ 0.070, measured by `assertClearance` over
 * seven poses × the sway corners × the flourish signs. The inkslinger is the most pinned gun in
 * the game (last measured 0.384 reach / 0.078 near) and `restDz` is 0 because it has no near-
 * plane margin to trade.
 *
 * NOTHING BELOW MOVES A VERTEX FORWARD OR OUTBOARD OF THE ONE THE PREVIOUS BUILD MEASURED. The
 * only extents that changed at all are in the muzzle group, and both of them retreat — see the
 * `muzzle` note. Every other part on this gun is either behind the hand, inward, or vertical.
 *
 * AND THE SIGHT SHRINK BUYS ON EVERY AXIS THE WALK MEASURES, WITHOUT SPENDING ON ANY:
 *   · outboard  rear body |x| 0.022 → 0.018. −4 mm off the assembly's widest vertex. (It was
 *               never the binding one — the fist is ±0.031 — but nothing gets wider.)
 *   · forward   front boss face −0.125 → −0.119. −6 mm of reach, and it was already 28 mm behind
 *               the muzzle can at −0.153 that the budget is actually quoted from.
 *   · rearward  rear body +z 0.017 → 0.011, AWAY from the eye. The `near` metric is the forearm,
 *               ~60 mm nearer again; the sights cannot become the nearest vertex either way.
 *   · vertical  nothing moved. `sight.lineY` is frozen at 0.061 on purpose — it is the aim
 *               socket, and this is the gun the ADS solve is the reference for.
 * Every extent this pass touches retreats. It cannot fail the walk, only pass it by more.
 */
const PROFILE: GunProfile = {
  id: 'inkslinger',
  depthCompress: 0.66,
  restDz: 0,
  /**
   * A SLOT IN THE SLIDE AND A BOSS ON ITS NOSE — see the SIGHT block, which is the argument.
   * Same three solids in the same three places at the same height, 40 % less material in them.
   *
   * ─── THE PART SPEC THIS FILE ASKED FOR, WHICH NOW EXISTS AND IS STILL NOT USED HERE ────
   * The previous build ended with a request: a bored/slotted block as its own part, `w` authored
   * independently of the slot, so the rear sight could stop being a part sitting on the gun and
   * become a cut in it. That part shipped — `OpticBlockSpec` / `opticFront` in `./types.ts`, one
   * machined ring with the bore centred ON `sight.lineY` and solid material above and below it,
   * which is the only construction that reads as one object rather than two walls.
   *
   * THE PISTOL DOES NOT TAKE IT, AND THE REASON IS A FORMULA RATHER THAN A PREFERENCE. A ring's
   * proud height is `(lineY − slideTop) + boreR + topWall`; `topWall ≥ INK_FLOOR` and
   * `boreR ≥ INK_FLOOR / 2` or the hole inks shut. On this gun that floors at **27 mm proud**
   * against the 12 mm that is here now. The complaint being answered is "too huge" — shipping a
   * part 2.25× taller to fix the other half of it is not a trade, and the marksman, whose line
   * sits far higher over a far deeper receiver, is where that part belongs.
   *
   * What the pistol does instead is the subtractive version of the same idea: the notch's floor
   * IS the slide's top face, the body's underside passes a millimetre THROUGH the slide's shoulder
   * line, and the body is now 36 mm on a 30 mm slide instead of 44. A 3 mm overhang is under the
   * ink band; the read is a slot milled down into the slide, which is a hole in one part even
   * though the geometry is two.
   *
   * `opticBlock` and `opticFront` are therefore deliberately absent, not merely unset. If they
   * are ever added here, `lineY` has to come down with them and the RUST rib has to come down
   * with `lineY` — all three in one deliberate pass, with the human watching.
   *
   * NO SIGHT WINGS, NO RAIL TEETH. Both were pale bars added ON TOP of the top edge — the
   * additive answer to an additive problem — and neither is coming back.
   */
  sight: SIGHT,
  receiver: { w: 0.030, h: 0.038, d: 0.150, y: 0.030, z: -0.052 },
  serrations: 4,
  barrel: { r: 0.014, len: 0.056, y: 0.010, z: -0.112 },
  /**
   * THE COMPENSATOR — shorter, wider, and two plates instead of three.
   *
   * WHAT WAS WRONG WITH IT, MEASURED OFF ITS OWN NUMBERS. The can is a 7-segment cylinder of
   * radius 0.017, so its flats sit at 0.017·cos(π/7) = 0.0153 and its corners at 0.0170. The
   * fins were 0.036 wide — 0.018 per side. That is ONE millimetre of protrusion past the can's
   * corners: roughly 1.6 screen px at 0.30 m, i.e. entirely inside the 7 px ink band. Three
   * fins that could not be seen, and the outermost of them was the model's WORST FORWARD VERTEX
   * (z −0.1595, x ±0.018) — the single number the whole reach budget was being quoted from. The
   * gun was paying its scarcest resource for geometry that printed as a black ring.
   *
   * SO THE BRAKE IS RE-CUT ON BOTH AXES AT ONCE, and the trade is strictly in our favour:
   *
   *   len  0.030 → 0.026   the can's face retreats from z −0.155 to −0.153, and with it the
   *                        GOLD core the builder places on that face. A 26 mm can is also
   *                        simply less BONE at the business end — this was the pistol's biggest
   *                        pale mass, not its sights.
   *   fins 3 → 2           deletes the i=2 fin at z −0.1595 outright. The forward-most vertex on
   *                        the whole model is now the core disc at −0.155 → −0.157 becomes
   *                        −0.153 → −0.155, and the fins no longer reach past the can at all
   *                        (i=1 sits at z −0.1426, its face at −0.1481, 5 mm behind the can).
   *   finW 0.036 → 0.048   the ONLY outward move in this file: +0.006 per side, to 0.024. That
   *                        is 7 mm proud of the can's corners and 8.7 mm proud of its flats —
   *                        ~11 px at 0.30 m against a 7 px band, so the step finally survives
   *                        the ink and the brake reads as a brake.
   *
   * THE ARITHMETIC THAT SAYS THIS IS SAFE. Reach is `hypot(|x| + sway, z)`, so a vertex's
   * exchange rate between the two axes is `∂r/∂x : ∂r/∂z = X : Z`. Against the old worst vertex
   * the new outermost fin trades Δx = +0.006 for Δz = −0.0169 of gun space, which the profile's
   * `depthCompress` 0.66 turns into −0.0112 of model depth. It is an improvement whenever
   * `0.006·X < 0.0112·Z`, i.e. `X < 1.87·Z` — and X (a hand's width plus sway, ~0.10–0.20 m) is
   * a small fraction of Z (~0.34–0.36 m) in every pose the clearance walk visits, including the
   * swayed corners where X is largest and Z smallest. The margin is not close: worst case the
   * inequality clears by better than 3×.
   *
   * The near-plane metric is untouched — nothing here is anywhere near the eye; that number is
   * the forearm, at +z, and this build does not touch the hand.
   */
  muzzle: { r: 0.017, len: 0.026, z: -0.140, fins: 2, finW: 0.048 },
  magazine: { w: 0.024, h: 0.086, d: 0.036, y: -0.060, z: 0.016 },
  tube: null,
  /**
   * THE SQUARED-OFF GUARD HOOK — §1's "very comic gun silhouette event", built out of the
   * `foreEnd` slot because the trigger guard itself lives in the shared builder and a pistol
   * has no support-hand fore-end to spend the slot on.
   *
   * It is a prow welded onto the front-bottom corner of the guard: it overlaps `guardFront`
   * (which reaches z −0.0637) and `guardBottom` (which reaches y −0.0617) and then juts 6 mm
   * further forward and 5 mm further down, at 24 mm wide against the guard bars' 14 mm. A
   * step on the OUTLINE is the one kind of detail the ink line cannot erase, because the ink
   * line *is* the outline — and it is 90 mm behind the muzzle, so it costs no reach.
   *
   * ONE RIB, NOT TWO, AND THE NUMBER IS ARITHMETIC RATHER THAN TASTE. `h > d`, so the slot's
   * rib generator stacks them vertically at a pitch of `h × 0.62 / (ribs − 1)` — on a 20 mm
   * face that is a 12.4 mm pitch for two ribs, and since every rib is `INK_FLOOR` (10 mm)
   * tall, the GAP between them comes out at 2.4 mm. `inkChunk` cannot see that: it floors the
   * part and is blind to the space between two of them, and 2.4 mm is a quarter of the floor.
   * The two hulls would have overlapped and the pair would have printed as one solid black
   * lump on the front of the guard — §0's failure exactly, arrived at from the other side.
   *
   * At one, the rib is a 28 × 10 × 20 mm band standing proud of a 24 × 20 × 16 mm block on
   * every face: a two-tier hook with a real step in its outline. Bigger, bolder, fewer.
   */
  foreEnd: { w: 0.024, h: 0.020, d: 0.016, y: -0.056, z: -0.062, ribs: 1 },
  /**
   * THE BEAVERTAIL, built out of the `stock` slot — a pistol has no stock, and a solid
   * `stock` is precisely "a mass behind the grip", which is what a beavertail tang is.
   *
   * It runs back from the frame's rear face (z 0.012) under the slide's rear, and the slot's
   * pad becomes the tang's flared terminus: 5 mm taller than the body, so the tip sweeps UP
   * toward the hammer spur instead of tapering to nothing. That upsweep is the whole read —
   * a taper would have died under the ink line, a step survives it.
   *
   * ITS HEIGHT IS ANATOMY, NOT STYLING. The bottom sits at y −0.007 and the fist's top edge
   * at −0.006, so the tang lies ON the web of the hand rather than floating above a gap; the
   * top overlaps the receiver's underside by 1 mm so it reads as one continuous frame. And it
   * is POLYMER, which carries the grip's dark blue up and around behind the hand — the frame
   * colour is then a band between two dark masses instead of the whole gun.
   */
  stock: { w: 0.028, h: 0.018, d: 0.036, y: 0.002, z: 0.030, skeleton: false },
  /**
   * THE WARM SPINE, NARROWED TO 10 mm WITH THE NOTCH — 0.014 → 0.010, and this is not a styling
   * change, it is the notch pass finishing itself.
   *
   * The rib runs FORWARD out of the notch, so it is nearer the eye than the front post at every
   * ray under the sight line, and its half-width is measured against the notch's window. At 14 mm
   * it was ±0.007 — which is EXACTLY where `notchHalfGap` 0.007 puts the slot's inner faces. The
   * slot's floor would have been rib from wall to wall and the light bars would have closed to
   * zero: the "orange mass filling the notch" bug, walked into from the other side. The previous
   * build wrote this consequence down before the notch was narrowed and it was right.
   *
   * AT 10 mm THE RIB LEAVES THE SIGHT PICTURE ENTIRELY, which is better than what it replaces:
   * its front end (d 0.305) is ±16.4 mrad, narrower than the post's own ±17.8, so it hides behind
   * the post from 29.5 mrad down; the worst ray, at 37.0 mrad where the hammer spur (top 0.0529,
   * hard-coded in the builder, nearer the eye at d 0.219) closes everything anyway, leaves a
   * 9.3 mrad bar. At 14 mm that same worst case left 1.0 mrad. Full derivation in the SIGHT block.
   *
   * DO NOT RAISE IT AND DO NOT WIDEN IT BACK. 10 mm is ON `INK_FLOOR` and the top at 0.052 is
   * 3 mm proud of the slide — take either one further and the part is gone, as ink or as a
   * silhouette. And if `sight.lineY` is ever lowered, this comes down with it in the same commit:
   * at `lineY` 0.058 the rib's far end starts occluding at 19.7 mrad and becomes the binding
   * occluder ahead of the hammer. `guardSightLine` does not police this part, so there is no
   * warning to catch it: it is arithmetic or nothing.
   */
  rib: { w: 0.010, h: 0.011, d: 0.104, y: 0.0465, z: -0.052 },

  /**
   * THE EJECTION PORT — §1's "single most gun-like detail", with the front wall doing the
   * extractor's job.
   *
   * SIZED BY THE SLIDE'S TOP FACE, NOT BY EYE. The lip stands 5 mm above the opening and is
   * 10 mm thick, so `y + h/2 + 0.010` must land on or under the slide's 0.049 top: at
   * y 0.030 / h 0.018 the lip's top is 0.049 and the shelf's bottom 0.011, i.e. the frame
   * fills the side face edge to edge with 1 mm of slide showing above and below. A lip that
   * broke the top face would run forward of the rear notch and start eating the sight
   * picture from below, which is the rib bug all over again — the RUST rib already closes the
   * picture at 0.052, so at 0.049 this is behind it and invisible to ADS.
   *
   * The brass in the port is the fourth RUST mark and the only one that is not on the
   * outline: it is a warm dot in the middle of the one rectangle the eye is drawn to, and it is
   * the only warm thing on a gun that is otherwise entirely cold. At r 0.006 it is 12 mm across
   * in an 18 mm window — a comic-fat round, not a case rim.
   */
  ejectionPort: { h: 0.018, d: 0.034, y: 0.030, z: -0.034, shellR: 0.006 },
  /**
   * NO CHARGING HANDLE, DELIBERATELY. A pistol's cocking read is its serrations and its
   * hammer spur, both of which it already has. A slide-mounted hook would have to go on the
   * left (the right is the port) at the same z as the port's deflector — which would turn the
   * one silhouette event this gun has into a matched pair and hand back the asymmetry §0 asks
   * for. Fewer, bolder, and on one side only.
   */
  chargingHandle: null,
  /**
   * THE SLIDE-LOCK LEVER. The `selector` part is a round boss with a bar swung off it on the
   * LEFT of the receiver, which is a slide stop's shape exactly — so the pistol spends the
   * slot on the lever §1 asks it for rather than on a fire selector it does not have.
   *
   * It sits at y 0.006, in the seam between frame and slide, and sweeps 12° up and back to
   * z −0.001. That puts it directly above the thumb (whose top is at −0.008), which is both
   * where a slide stop lives and where the eye already is.
   */
  selector: { r: 0.008, len: 0.030, thick: 0.011, y: 0.006, z: -0.030, angleDeg: 12 },
  /**
   * THE FLARED MAGWELL. A pistol's magazine is inside its grip, so there is no well to show
   * half way up — the only honest place for this part is the BUTT, as the funnel the mag is
   * fed into, which is also the one comic-gun cliché that reads instantly at a glance.
   *
   * PLACED UNDER THE FIST, NOT INSIDE IT. The gloved fist is 62 mm wide and its bottom edge
   * runs from y −0.082 to −0.102; a collar 46 mm across placed any higher would be swallowed
   * whole and the flare would be invisible. At y −0.104 the collar's skirt lands at −0.126,
   * four millimetres below the heel and 6.5 mm proud of it per side, so it emerges from under
   * the hand as a distinct step. The magazine's floorplate then sits recessed 7 mm inside the
   * mouth — the mag reads as INSERTED, which is the whole point of the part — and the reload
   * drops it straight out through a funnel that stays put, because the well is static polymer
   * and the magazine is not.
   */
  magWell: { w: 0.036, h: 0.016, d: 0.048, y: -0.104, z: 0.028, flare: 0.005 },
  /**
   * TWO STAMPED CUTS, LEFT ONLY, IN THE DUST COVER — the one panel of the frame that is
   * forward of the hand and therefore actually visible in the rest pose. Two and not three:
   * the host is 62 mm long and a third cut would put the pitch under the ink band.
   *
   * THE PITCH IS 28 mm, NOT 20, AND THAT IS THE SAME LAW AS THE PART THICKNESS. A 16 mm cut
   * on a 20 mm pitch leaves a FOUR millimetre land between them, and a land has to survive
   * the 7 px hull exactly as the cut does — at 4 mm the two inflated hulls overlap and the
   * pair reads as one 36 mm dark bar rather than as two cuts. `inkChunk` floors the part and
   * is blind to the space between two of them, which is why this has to be checked by hand.
   * At 28 mm the land is 12 mm, and the forward cut still ends at z −0.094, seven millimetres
   * inside the dust cover's own nose at −0.101 — so the group costs no reach and hangs off
   * nothing.
   *
   * They go on the LEFT because the right-hand face at this height is under the port and the
   * deflector, and a gun with a different event on each side is a gun that was drawn rather
   * than mirrored. Polymer, so they are dark cuts in a mid-blue mass, not plates on it.
   */
  panels: {
    count: 2, side: 'left', h: 0.011, d: 0.016,
    y: -0.021, z: -0.058, step: 0.028, hostHalfW: 0.013,
  },
  /**
   * NO RAIL TEETH. The slide's top face is 16 mm wide once the rib is on it, and anything up
   * there runs forward of the rear notch and occludes the front post from below. The pistol's
   * top is spoken for.
   */
};

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * BLUED — and it is the only cold gun in the game.
 *
 * The playtester, on the arsenal after the per-weapon palettes shipped: *"we need more
 * differentiator colours, they still look the same overall"*. Measured against the other three
 * files, they were right about this gun specifically: its frame was `hexMix(SLATE, TEAL, 0.34)`
 * = #3D617B, which is luma 0.358 at HSL saturation 0.34. The SMG's olive frame is luma 0.372.
 * A fourteen-thousandth of a value apart is not a palette, it is a rounding error with a hue
 * attached — and the hue could not carry it either, because 0.34 saturation is a GREY that
 * leans blue rather than a blue.
 *
 * THE CAUSE IS IN THE INK SET, AND IT HAS A FIX. There is no saturated blue token: `SLATE`
 * (0.24 sat) is the blue and it is deliberately a grey, because it is the building mass and a
 * vivid one would fight the enemies (ART §9). Blending two greys can only produce a third grey,
 * which is exactly what every previous attempt at this gun did. So the blue is MIXED, the way a
 * colourist mixes an ink, from the two ends of the palette's cool half —
 *
 *     BLUED_INK = ELECTRIC (#00E5FF, cyan) × NIGHT_B (#4D2E82, violet) at 0.62
 *               = #3074B2 — hue 209°, HSL sat 0.58
 *
 * — and then every field is knocked back off it into the value it needs. Nothing on the gun
 * wears the ink raw, and the nearest any field gets to `ELECTRIC` itself is the steel, three
 * value steps and two thirds of a saturation below it. Using `ELECTRIC` as the chroma source is
 * also not a new channel on this object: every `FieldLook` in `viewmodel.ts` already rims the
 * weapon in `ELECTRIC`, so the rim light and the metal it is rimming now belong to one family
 * and the sheen reads as cold steel instead of as a blue edge on a grey box.
 *
 *   field    hex       luma    hue    sat    was              Δluma
 *   polymer  #2B4E7A   0.289   213°   0.48   #2D3654 (0.213)  +0.076, sat 0.30 → 0.48
 *   frame    #346DA3   0.395   209°   0.52   #3D617B (0.358)  +0.037, sat 0.34 → 0.52
 *   steel    #709ABE   0.579   208°   0.38   #7F8592 (0.520)  +0.059, sat 0.08 → 0.38
 *
 * A monotone ladder in one hue, with the saturation peaking on the FRAME — the largest mass on
 * screen and therefore the one that has to carry the identity in the tenth of a second before a
 * silhouette resolves. The polymer lands on the 0.29 the value ladder in `viewmodel.ts`
 * documents, so the note there about not taking this field far below `SLATE` still holds.
 *
 * ART §9, CHECKED FIELD BY FIELD. `ACID` (#8CFF3E) and `HOT` (#FF2E63) belong to enemies and
 * `GOLD` (#FFC531) to interactables and the muzzle core: none of the three appears here or in
 * anything mixed here. Every value is under `ENV_VALUE_CEIL` 0.78, the brightest (steel, 0.579)
 * stays a clear step under the sights' `BONE` 0.73 so the front post remains the palest thing on
 * the weapon, and nothing on the gun is warm except the two RUST marks it is supposed to have.
 *
 * AND IT SEPARATES FROM THE LEVEL, WHICH IS THE OTHER HALF OF THE JOB. The failure this file
 * has already recorded once is a blue-grey gun vanishing against `SLATE` walls. The frame is now
 * +0.077 luma over `SLATE` at 2.2× its saturation, and against the warm `CONCRETE` deck (0.52)
 * it is a straight hue opposition. It is the only cool-hued weapon in the arsenal — the SMG is
 * olive, the shotgun is oxide-brown over walnut, the marksman is tan — so "the blue one" is a
 * complete description of which gun you are holding.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const BLUED_INK = hexMix(PALETTE.ELECTRIC, PALETTE.NIGHT_B, 0.62);

const FIELDS: FieldSet = {
  /** Receiver, slide, barrel, guard — the mass that says "blue" before anything else resolves. */
  frame: hexMix(BLUED_INK, PALETTE.SLATE, 0.22),
  /** Grip, beavertail, magwell, guard hook, panels — the same ink taken to near-navy. */
  polymer: hexMix(BLUED_INK, PALETTE.INK_SOFT, 0.55),
  /** Port frame, deflector, magazine — bright cold metal, still unmistakably the same alloy. */
  steel: hexMix(BLUED_INK, PALETTE.PAPER, 0.33),
  /** This gun has no wooden part; the skin never names it. Kept so the field set is total. */
  wood: FIELD.wood,
};

/**
 * Issued and maintained: one hot-blued finish over the whole gun — `framePark`'s mottle is what
 * a blued slide looks like when the finish has started to go at the edges — and a grip somebody
 * wrapped themselves. The tape is the only thing on this weapon that a person did, and it is the
 * only surface in the arsenal that is a REPAIR rather than a factory finish.
 */
const SKIN: WeaponSkin = {
  frame: { mat: 'framePark', uv: 16 },
  slide: { mat: 'framePark', uv: 16 },
  polymer: { mat: 'polyTape', uv: 18 },
  steel: plainSteel,
  magazine: plainSteel,
};

export const INKSLINGER: WeaponModelDef = { profile: PROFILE, fields: FIELDS, skin: SKIN };

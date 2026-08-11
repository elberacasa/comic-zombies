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
 * THE SIGHT — the reference the whole game's ADS is solved against, and now the SHORTEST
 * assembly in the arsenal rather than merely the smallest numbers in it.
 *
 * THE THREE NUMBERS THAT MAY NOT MOVE: `lineY`, `rearZ` and `notchHalfGap`. `lineY` feeds
 * `aimSocketOf()` feeds the ADS translation — move it and the gun shoots somewhere other than
 * where it looks; `rearZ` is the socket's z; `notchHalfGap` is the light-bar window that was
 * measured open once and must stay open. Everything else here is shape.
 *
 * WHAT CHANGED, AND WHY IT IS THE ONLY LEVER THIS GUN HAS. The playtester, on the arsenal:
 * *"the sights or grey things on top are too long, i would remove those and remake that part in
 * all guns"*. They are right, and on THIS gun the answer is arithmetic rather than taste:
 *
 *   · The blades stand `lineY − 0.049` = 17 mm proud of the slide's top face. That height is
 *     `lineY`, i.e. the aim solve, and it cannot come down. Their WIDTH is 11 mm — one
 *     millimetre over `INK_FLOOR`, so it cannot come in either without the post printing solid
 *     black (WEAPON_ART §0; this project has already lost a front sight to exactly that).
 *   · So the only axis with room is fore-and-aft, and `bladeD` takes the trim: 12 → 11 mm on
 *     all three blades. The post is now an 11 × 11 mm SQUARE COLUMN in plan — a pistol post,
 *     not a rail segment — and the rear pair are two matching 11 mm blocks with a 20 mm notch
 *     between them. Nothing on this gun's top edge is longer than it is wide.
 *
 * AND THE PALE MASS THIS GUN ACTUALLY HAD IS NOT UP HERE. `sightParts` is three blocks; the
 * `BONE` that dominates the pistol at a glance was the muzzle brake — a 30 mm can wearing three
 * fins that protruded ONE millimetre past it. See the `muzzle` note in the profile: that is
 * where the "long pale thing" on the inkslinger got shortened.
 *
 * NO WINGS, EVER. Ears round the front post were removed across the arsenal and are not coming
 * back: they are `BONE` (0.73, the brightest value on the weapon) standing on the one edge the
 * player looks at for 100% of the session, and four guns wearing them is four guns wearing the
 * same pale bar. `sightWings` is therefore absent from the profile below, not set to a small
 * number.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const SIGHT = {
  /**
   * THE sight line: the top edge of the front blade and of both rear blades. Gun space, metres.
   * The slide's top face is at 0.049, so the blade heights below are what stands the line off it
   * — raise `lineY` and you MUST raise the heights with it or the blades float. FROZEN: this is
   * the number `aimSocketOf()` is anchored to.
   */
  lineY: 0.066,
  /** Rear notch centre and front blade centre, along the slide. `rearZ` is the aim socket. */
  rearZ: 0.002,
  frontZ: -0.118,
  /** Blade width — one millimetre over the ink floor, so the blades hold albedo. */
  bladeW: 0.011,
  /**
   * Blade heights below the line. Both are the minimum that still BURIES the blade in the slide:
   * at `rearH` 0.018 the rear pair reach down to 0.048, one millimetre inside the 0.049 top face,
   * and anything less leaves them floating over a hairline gap once the bevels are cut.
   */
  rearH: 0.018,
  frontH: 0.020,
  /** Fore-and-aft length. 12 → 11 mm: square in plan, and one over the ink floor. */
  bladeD: 0.011,
  /** Half the notch gap: the inner face of each rear blade sits this far off centre. SOLVED. */
  notchHalfGap: 0.010,
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
 */
const PROFILE: GunProfile = {
  id: 'inkslinger',
  depthCompress: 0.66,
  restDz: 0,
  /**
   * NO SIGHT WINGS, NO RAIL TEETH. Both were added for "reads military" and both were wrong:
   * the wings are BONE (0.73 luma, the brightest value on the gun) and the teeth are steel, so
   * every weapon ended up wearing a stack of pale bars along its top edge. The playtester: "all
   * the guns have like gray lines on top of it, they look bad". The front post and rear notch
   * STAY: those are the sight picture and ADS needs them. See the SIGHT block.
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
   * THE WARM SPINE. Do not widen it and do not raise it: at w 0.014 it is ±0.007 against the
   * notch's ±0.010 window, which is what leaves a light bar either side of it at the near end
   * of the sight picture, and at a top of 0.052 it clears ~34 px of a 38 px front post. Both
   * numbers were measured off the framebuffer after the "orange mass filling the notch" bug and
   * both are one millimetre from failing again.
   */
  rib: { w: 0.014, h: 0.011, d: 0.104, y: 0.0465, z: -0.052 },

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

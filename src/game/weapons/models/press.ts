/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE PRESS — a printing press, in a comic book. Designed clean, in one pass, as a whole object.
 *
 * It ships ALONGSIDE the inkslinger, not instead of it, and its `WeaponDef` is the inkslinger's
 * stats to the decimal (see `defs.ts`) so that pressing J and comparing the two is a comparison
 * of nothing but the LOOK.
 *
 * ─── WHAT IT IS ─────────────────────────────────────────────────────────────────────────────
 * A heavy squared slab of a slide with ONE raised top plate running most of its length, one
 * scribed channel down each of its big flat flanks, an exposed hammer at the back, a wrapped
 * grip, and three tiny hot marks at the two ends. Everything else is a calm plane.
 *
 * ─── THE FOUR RULES FROM `docs/WEAPON_REWORK.md`, AND WHERE EACH ONE IS SPENT ────────────────
 *  §1.1  NOTHING THIN STANDS ON THE RECEIVER. There is exactly one raised mass on the top of
 *        this gun and it is ONE SOLID — see THE TOP PLATE below, which is the whole design.
 *  §1.2  Interior detail is drawn at the interior weight. The plate is the only part on the gun
 *        that rides the thin `view.sightOutlinePx` hull, and it is sized against
 *        `INK_FLOOR_INTERIOR` (0.007) rather than the silhouette floor.
 *  §1.3  DETAIL IS PANEL LINES, NOT PARTS. The flanks' channel, its lit lip and its bolt heads
 *        are all TEXTURE — `frameVent` at 11 tiles/m. Not one triangle was spent on them, and
 *        they cannot become sticks. The part count on this gun is LOWER than the inkslinger's.
 *  §1.4  BIG SIMPLE SHAPES. Three detail zones — the breech, the flank channel, the muzzle
 *        plate — with 30–80 mm of dead calm between each of them.
 *  §1.5  Calm desaturated body (HSL sat 0.09–0.11 on the two big fields), and every saturated
 *        mark is at an END of the gun. See the palette block.
 *
 * ─── AND THE ONE CONSTRAINT THAT DECIDED THE SHAPE, WHICH IS ARITHMETIC RATHER THAN TASTE ────
 * `WEAPON_REWORK` §1.1 asks for a receiver top with nothing on it. **The builder cannot express
 * that**, and it is worth writing down exactly why, because it is what a seventh sight pass
 * would rediscover the hard way:
 *
 *   · every blade's TOP is pinned to `sight.lineY` by `buildGunGeometry`, front and rear alike;
 *   · `lineY` is where `aimSocketOf()` puts the EYE, so nothing forward of the socket may rise
 *     above it — a mass above the line at ADS is a wall across the sight picture;
 *   · therefore the blades are, necessarily, the TALLEST things on the gun. They cannot be
 *     buried inside anything, because anything that covered them would be above the line;
 *   · and `lineY` has a hard floor of its own: the hammer spur is hard-coded in the builder at a
 *     top of 0.0529, it is the NEAREST part of the model to the eye (d ≈ 0.219 m at ADS), and
 *     every millimetre `lineY` sits above it buys only 4.6 mrad of daylight under the crosshair.
 *
 * So a visible aim mass is forced. What is NOT forced is that it be three of them: the rule the
 * six failed passes broke is *ONE MASS*, and this file spends its entire sight budget on making
 * the three boxes the builder emits into a single continuous solid — see below.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { FieldSet, GunProfile, WeaponModelDef, WeaponSkin } from './types';
import { FIELD, plainSteel } from './types';
import { PALETTE, hexMix } from '@/art/palette';

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE TOP PLATE — three boxes, one solid, and the only thing standing on this receiver.
 *
 * `SightSpec` can only say three boxes: a pair at ±(`notchHalfGap` + `bladeW`/2) and one on the
 * centreline, all three with their tops pinned to `lineY`. Six passes at the pistol authored
 * those as three separate stalks and the playtester counted them out loud every single time.
 * The numbers below make the same three boxes OVERLAP — in x for the pair, in z for the front —
 * so what the builder merges into `sightParts` is one closed volume with no gap anywhere in it.
 * There is nothing to count.
 *
 *   right rear   x  [−0.003, +0.013]      ← `notchHalfGap` is NEGATIVE, and that is the trick
 *   left  rear   x  [−0.013, +0.003]         (6 mm of overlap on the centreline)
 *   union        x  [−0.013, +0.013]  = 26 mm, on a 34 mm slab: inset 4 mm per flank
 *
 *   rear pair    z  [−0.043, +0.019]      ← 62 mm at the full 26 mm width
 *   front        z  [−0.093, −0.031]      ← 62 mm at 16 mm, overlapping the pair by 12 mm
 *   union        z  [−0.093, +0.019]  = 112 mm authored, 74 mm drawn after `depthCompress`
 *
 * The result is a two-tier plate: a wide breech section that steps in by 5 mm per side to a
 * narrower forward tongue. That step is 8.5 px against a 3.5 px hull, so it survives as a real
 * step in the outline rather than closing into a seam — a comic-legible shape, and the one
 * silhouette event on the top of this gun.
 *
 * ─── WHY IT READS AS PART OF THE SLIDE AND NOT AS A BLOCK PARKED ON IT ──────────────────────
 * Aspect and burial, the two things the inkslinger's last pass identified and could not afford:
 *
 *   · 74 mm drawn against 13 mm proud is **5.7:1**. Nothing that long and that low reads as a
 *     stalk; it reads as a raised strap, which is what a machined top rail is.
 *   · `rearH`/`frontH` are 26 mm against 13 mm of visible height, so HALF THE PART IS BURIED.
 *     Its underside sits at y 0.034 — six millimetres below the receiver's chamfer shoulder
 *     (±0.017, 0.040) and thirteen below its top face — so the plate passes THROUGH the top of
 *     the slide and terminates deep inside it. No base, no seam, no gap for the ink to find.
 *   · 26 mm wide on a 34 mm slab leaves 4 mm of slide showing either side: the plate is inset,
 *     not overhanging. A plate that overhangs is a plate somebody bolted on.
 *
 * ─── AND WHAT THE PLAYER SIGHTS WITH ────────────────────────────────────────────────────────
 * The plate's top face IS the sight line — the eye sits exactly on it, so at ADS it is edge-on
 * and its two flanks converge to a point at the crosshair. A flat-top sighting plane: no post,
 * no notch, no blades, nothing standing anywhere. That is `WEAPON_REWORK` §1.1's *"that line can
 * exist without a tall part standing on it"*, as close as this builder can be made to get.
 *
 * The one thing that can intrude on it is the hard-coded hammer, and it is checked, not hoped:
 * the eye is `0.235 + (rearZ − z) × 0.66` from anything at gun-space z, so the spur (top 0.0529,
 * z 0.026) sits at d 0.210 m and its top clears `lineY` 0.060 by **33.8 mrad** — 1.9° below the
 * crosshair before the first warm pixel. (The shipped inkslinger clears 37.0 mrad at d 0.219.
 * The marginal case, and the reason `lineY` is not lower, is 0.055 → 10 mrad, which puts an
 * orange mass 14 px under the aim point. That failure has been shipped once already.)
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const SIGHT = {
  /**
   * THE sight line, and here also the top face of the plate and of the whole gun. 0.060.
   *
   * Floored by the hammer (0.0529 at d 0.210 → this is 33.8 mrad of daylight) and ceilinged by
   * the plate's proud height: `lineY − receiverTop` is what the player sees standing on the
   * slide, and every millimetre added to `lineY` is a millimetre added to that. 13 mm is the
   * balance — 1.9× `INK_FLOOR_INTERIOR`, and a 5.7:1 plate.
   *
   * Moving it moves `aimSocketOf()` and therefore the whole ADS translation. It is not a
   * styling number.
   */
  lineY: 0.060,
  /**
   * The plate's two centres. `rearZ` is the aim socket — it sits inside the wide section, 31 mm
   * from either of its ends, which is the point: the aim reference is INSIDE the one mass rather
   * than being a part of its own.
   *
   * **−0.012 IS A NEAR-PLANE NUMBER, AND IT WAS MEASURED, NOT CHOSEN.** `adsOffsetOf()` puts the
   * socket exactly `view.adsSightDistance` from the eye, so moving the socket FORWARD along the
   * gun drags the gun's whole rear end back toward the camera: `adsZ` = −0.235 − `rearZ` × 0.66.
   * The first draft of this plate sat at −0.033 to buy a 16 mm air gap between its rear face and
   * the hammer, and it put the forearm 0.067 m from the eye in the `ads+recoil` pose — **inside
   * `view.nearClearance` 0.070**, i.e. the player would have seen the hollow inside of their own
   * arm every time they fired down the sights. Walked over all seven poses × the sway corners:
   *
   *   rearZ    ads+recoil near      verdict
   *   −0.033        0.067           FAILS the near plane
   *   −0.020        0.076           legal, 6 mm of margin
   *   **−0.012**    **0.081**       shipped: 11 mm of margin
   *   −0.008        0.084           the plate's rear face reaches the slab's own rear face
   *                                 (z 0.023) and the two coplanar faces z-fight
   *   (inkslinger)  0.090           the reference, for scale
   *
   * At −0.012 the plate's rear face lands at z 0.019, four millimetres inside the slab's breech
   * face, and the hammer's leading vertex at 0.0141 is INSIDE it — a genuine 5 mm interpenetration
   * rather than a near miss. That is deliberate and it is the safe half of the rule this project
   * keeps relearning: solids that touch are safe, solids that nearly touch merge hulls and print
   * as one black lump. The hammer now emerges FROM the back of the plate, which is also what a
   * hammer does.
   */
  rearZ: -0.012,
  frontZ: -0.062,
  /**
   * Blade width and, via `notchHalfGap` below, half of the plate's width. 16 mm is 2.3×
   * `INK_FLOOR_INTERIOR` and 1.6× the silhouette floor, so the forward tongue is legal on either
   * hull — which matters, because a 16 mm-wide part is the narrowest thing on this gun.
   */
  bladeW: 0.016,
  /**
   * How far each box reaches DOWN from the line. NEITHER IS A VISIBLE HEIGHT: the plate stands
   * `lineY − 0.047` = 13 mm proud and these say only how deep the root goes. At 26 mm the
   * underside is at 0.034, which is below the receiver's chamfer shoulder AND 27 mm above its
   * own floor at 0.007 — buried in solid slide on every side. Burying more is free; burying less
   * is how a plate turns back into a lid.
   */
  rearH: 0.026,
  frontH: 0.026,
  /**
   * Fore-and-aft length of each box, and the axis that makes this part read as a rail rather
   * than as a block. 62 mm authored; `depthCompress` 0.66 draws it as 41 mm, and the two boxes
   * overlap by 12 mm to give a 112 mm / 74 mm-drawn union.
   *
   * It is also the axis that pays for itself: the plate is 74 mm long and 13 mm tall on screen,
   * and 5.7:1 is the entire reason the top of this gun does not read as something sitting on it.
   *
   * Its front face lands at z −0.093, which leaves **34 mm of completely bare slide deck** (22 mm
   * drawn) between it and the slab's nose at −0.127. That gap is the one place on the top of this
   * gun where there is nothing at all, and it is deliberate: §1.4's *"large quiet areas between"*.
   */
  bladeD: 0.062,
  /**
   * **NEGATIVE, AND THAT IS THE POINT.** The builder places the rear pair at
   * `±(notchHalfGap + bladeW/2)`, so this number is the x of each box's INNER face. At 0 they
   * abut on the centreline (two coplanar faces, which z-fight); at −0.003 they OVERLAP BY 6 MM
   * and the pair is a single 26 mm solid with no notch, no gap and no seam.
   *
   * There is no sight picture to lose by closing it: this gun has no front element to frame, and
   * `sightWings` — the one other consumer of this field — is deliberately null. Do not take it
   * back to a positive number without re-reading the block at the top of this file; a gap here is
   * how "one mass" becomes "two walls" and the playtester starts counting again.
   */
  notchHalfGap: -0.003,
} as const;

/**
 * THE PRESS. Same footprint as the inkslinger to the millimetre on the two axes the clearance
 * walk measures, so the comparison is fair and the budget is provably safe; everything that
 * differs, differs in y, in mass distribution, in surface and in colour.
 *
 * ─── CLEARANCE, WALKED OFFLINE OVER ALL SEVEN POSES × THE SWAY CORNERS × THE FLOURISHES ─────
 * `depthCompress` and `restDz` are the inkslinger's, so five of the seven poses are literally the
 * same pose and the binding vertex in all of them is a corner of the SHARED forearm. The two that
 * differ are ADS and ads+recoil, which are solved from this gun's own socket. Every part list
 * below was run through a re-implementation of `assertClearance` (un-bevelled boxes, i.e. every
 * corner further out than the real `bevelBox` puts it — conservative on purpose), against the
 * shipped inkslinger as the control:
 *
 *   pose               INKSLINGER  reach / near      THE PRESS  reach / near
 *   rest                   0.383 (0.391) / 0.087       0.382 (0.390) / 0.087
 *   ads                    0.344 (0.345) / 0.109       0.335 (0.335) / 0.100
 *   sprint                 0.378 (0.386) / 0.069       0.376 (0.385) / 0.069
 *   reload                 0.382 (0.393) / 0.088       0.382 (0.393) / 0.088
 *   equip                  0.384 (0.391) / 0.117       0.383 (0.390) / 0.117
 *   rest+recoil+land       0.327 (0.335) / 0.071       0.327 (0.335) / 0.071
 *   ads+recoil             0.311 (0.312) / 0.090       0.302 (0.302) / 0.081
 *   budgets                reach ≤ 0.400 · swayed ≤ 0.420 · near ≥ 0.070
 *
 * THE PRESS is at or inside the reference on every axis of every pose. The only column it gives
 * anything up in is the ADS near plane (see `sight.rearZ`, where that 9 mm is priced), and it
 * keeps 11 mm of margin there. Reach falls everywhere, because this gun has fewer parts and none
 * of them is further out than one of the inkslinger's:
 *
 *   −z  muzzle can face −0.153 · fin corner −0.1481 — both the inkslinger's numbers exactly, and
 *       they are what the whole reach budget is quoted from. The plate stops at −0.093, which is
 *       26 mm behind the inkslinger's front sight boss.
 *   +z  the forearm (shared). Behind the gun proper: stock pad 0.061 against the reference's
 *       0.064, breech block 0.031, hammer 0.0379 (shared).
 *   ±x  the fist, 0.031 (shared). The widest part of the gun is the muzzle fin at 0.024 — the
 *       inkslinger's number — and the serrations at 0.018 are inboard of the fist by 13 mm.
 *   +y  plate top 0.060, one millimetre under the inkslinger's sight top.
 */
const PROFILE: GunProfile = {
  id: 'press',
  /** The inkslinger's, unchanged: the two guns must foreshorten identically to be comparable. */
  depthCompress: 0.66,
  restDz: 0,
  sight: SIGHT,
  /**
   * THE SLAB. 34 × 40 × 150 mm, spanning y 0.007…0.047 and z −0.127…0.023.
   *
   * Four millimetres wider and two taller than the inkslinger's, and its top face is 2 mm LOWER
   * — the mass moved down and out rather than up, so the gun is heavier without the sight line
   * having to chase it. The three numbers that everything else on the top of this gun is
   * measured from:
   *
   *   top face      0.047   the plate stands 13 mm proud of it; the hammer 5.9 mm
   *   chamfer       `bevelBox`'s 7 mm bevel leaves a 20 mm-wide top FLAT (x ±0.010) with the
   *                 corners falling to the shoulder line at (±0.017, 0.040)
   *   flanks        26 mm of dead-flat side face, 150 mm long, top to bottom of the chamfers —
   *                 **the big calm plane this gun's detail is drawn ON rather than bolted TO**
   *
   * That flank is why the slab is 40 mm tall. At the inkslinger's 38 mm the scribed channel and
   * its lit lip had nowhere to sit that was not an edge.
   */
  receiver: { w: 0.034, h: 0.040, d: 0.150, y: 0.027, z: -0.052 },
  /**
   * THREE, not the inkslinger's four. They are `INK_FLOOR` thick on the builder's 17 mm pitch,
   * so the tooth holds albedo and the 7 mm gap holds an ink line; three of them cover 44 mm of
   * breech and leave the forward 100 mm of the slab free of any geometry at all, which is the
   * calm §1.4 is asking for. A fourth would buy nothing and cost 17 mm of quiet.
   */
  serrations: 3,
  /** The inkslinger's barrel, unchanged — it sets the forward extent every budget is quoted at. */
  barrel: { r: 0.014, len: 0.056, y: 0.010, z: -0.112 },
  /**
   * ONE PLATE ON A SHORT CAN, not two, not three.
   *
   * `r`, `len` and `z` are the inkslinger's exactly, so the forward-most vertex on this model is
   * the same vertex at the same place and the reach budget cannot have regressed. What changed
   * is the fin COUNT: one 48 × 10 × 11 mm plate standing 7 mm proud of the can's corners
   * (≈12 px, comfortably over the band) instead of two.
   *
   * The muzzle group is `trim`, i.e. BONE at luma 0.729 — the palest thing on the weapon. On a
   * gun whose whole thesis is a calm desaturated body, one bold pale plate at the business end is
   * an accent; two is a pattern, and a pattern at the far end of the barrel is where the eye
   * stops going to the target. It is also, and not by accident, the shape of a press platen.
   */
  muzzle: { r: 0.017, len: 0.026, z: -0.140, fins: 1, finW: 0.048 },
  /** Inside the grip, seen only as its floorplate under the heel. The inkslinger's, unchanged. */
  magazine: { w: 0.024, h: 0.086, d: 0.036, y: -0.060, z: 0.016 },
  tube: null,
  /**
   * THE UNDERLUG — one squared polymer block under the dust cover, and `ribs: 0`.
   *
   * A pistol has no support-hand fore-end, so the slot is spent the way the inkslinger spends it:
   * on a mass that gives the lower half of the gun a silhouette event to answer the top plate's.
   * It is 26 × 14 × 44 mm at y −0.035, which puts its top 1.5 mm INSIDE the dust cover's
   * underside (−0.0295) — an interpenetration, not a 1.5 mm gap, which is the difference between
   * one continuous mass and a black seam — and its underside 12.5 mm (21 px) proud of it.
   *
   * Its flanks are flush with the rail block's (both 26 mm), so the step is a pure VALUE break:
   * dark polymer continuing the frame's line downward. A 1 mm ledge would have been 1.7 px, under
   * the band, and would have read as a mistake rather than as a chamfer.
   *
   * ZERO RIBS, and that is `WEAPON_REWORK` §1.3 in one field. The rib generator stacks bands at
   * `h × 0.62 / (ribs − 1)`; on a 14 mm face any count above one puts the GAPS under the ink band
   * and the stack prints as a single black lump. This gun draws its lines instead.
   */
  foreEnd: { w: 0.026, h: 0.014, d: 0.044, y: -0.035, z: -0.070, ribs: 0 },
  /**
   * THE BEAVERTAIL, out of the `stock` slot — a solid `stock` is exactly "a mass behind the
   * grip", which is what a tang is, and a pistol has no stock to spend the slot on.
   *
   * 32 × 20 × 34 mm at y 0.002, with the slot's pad as a flared 38 × 30 × 16 mm terminus. Its
   * top at 0.012 meets the warm breech block's underside at 0.010 (a 2 mm overlap), so the rear
   * of the gun is one continuous stack — tang, breech, hammer — rather than three floating
   * masses. Polymer, so the grip's dark value carries up and around behind the hand.
   *
   * Its rearmost vertex is 0.061, three millimetres FORWARD of the inkslinger's 0.064: the near
   * plane is the one budget a rear mass can spend, and this one does not spend any of it.
   */
  stock: { w: 0.032, h: 0.020, d: 0.034, y: 0.002, z: 0.028, skeleton: false },
  /**
   * THE INKED BREECH — the `rib` slot, spent at the BACK of the gun instead of along the top.
   *
   * The slot is RUST and it rides the SLIDE (`accentSlide`), and both facts decided where it
   * could go. It cannot go under the barrel, where the frame is static and a warm bar would
   * reciprocate 13 mm on every shot against a frame that does not; and it must not go along the
   * top, where the plate now lives and a second raised mass would be exactly the thing this
   * design exists to delete.
   *
   * So it is a 26 × 16 × 18 mm block at the breech: buried inside the slab up to its rear face
   * at 0.023 and standing 8 mm (13.5 px) proud of it, overlapping the beavertail below by 2 mm
   * and the hammer above by 1 mm. Those two overlaps are the part's whole job — the hammer is the
   * gun's one strong silhouette event and a spur growing out of a warm breech block reads as a
   * mechanism, where a spur floating over a 13 mm gap reads as an error.
   *
   * It is also mechanically honest for once: the breech block IS the part that travels, and on
   * every shot it slides back past the hammer it just dropped and into the tang behind it (at the
   * clearance walk's 20 mm cycle its rear face reaches 0.051 against the pad's front face at
   * 0.045). Swallowed by a bigger mass is the one way a moving part may end a stroke; ending it
   * a few millimetres SHORT of one is the hull-merge failure again.
   */
  rib: { w: 0.026, h: 0.016, d: 0.018, y: 0.018, z: 0.022 },

  // ── THE DETAIL VOCABULARY: ONE ENTRY, AND EVERY OMISSION IS DELIBERATE ──────────────────
  /**
   * NO EJECTION PORT, and it is the hardest omission in the file — `WEAPON_ART` §1 calls it the
   * single most gun-like detail available. It is four proud steel bars and a shell, all of them
   * on the receiver's FLANK, and the flank is this gun's big calm plane: the scribed channel and
   * its two bolt heads are drawn there, and a port frame would sit on top of them. Three detail
   * zones was the budget (§1.4) and the breech, the flank and the muzzle already spend it.
   */
  ejectionPort: null,
  /** NO CHARGING HANDLE. It is a stem with a hook on it — thin, standing, and on the receiver. */
  chargingHandle: null,
  /** NO SELECTOR. A round boss plus a swung bar is two small parts to say one small thing. */
  selector: null,
  /** NO MAG WELL. The butt is under the fist and behind the ink; the flare would be invisible. */
  magWell: null,
  /** NO WINGS. There is no post to protect, and `notchHalfGap` is negative — see the block above. */
  sightWings: null,
  /**
   * NO APERTURE. `OpticBlockSpec` floors at `(lineY − receiverTop) + boreR + topWall` proud,
   * which on this receiver is 13 + 5 + 10 = **28 mm** of ring standing on the slide. This gun
   * already answers "one machined part rather than two walls" with the top plate, at half the
   * height and none of the hole.
   */
  opticBlock: null,
  opticFront: null,
  /**
   * TWO STAMPED CUTS, LEFT ONLY, IN THE DUST COVER — the one bold geometric mark on the gun's
   * visible flank, and the one place a value break beats a drawn line.
   *
   * They go on the LEFT because that is the side the camera sees: the weapon is held at the
   * lower right of the frame, so the player looks at its left flank all day and its right flank
   * never. They go on the FRAME (`hostHalfW` 0.014, the lower body's half-width) and not on the
   * slab, because `panels` are POLYMER and therefore STATIC — two cuts that held still while the
   * slide cycled 13 mm underneath them would read as a bug on every shot.
   *
   * THE PITCH IS THE PART THAT NEEDS CHECKING, NOT THE CUT. `inkChunk` floors each cut and is
   * blind to the LAND between two of them: at a 26 mm cut on a 40 mm pitch the land is 14 mm
   * (24 px) and the pair reads as two cuts; at the 34/38 this file first tried it was 4 mm, both
   * hulls overlapped and the pair would have printed as one 60 mm dark bar. The forward cut ends
   * at z −0.091, nine millimetres inside the body's own nose at −0.100, so the group hangs off
   * nothing and costs no reach.
   */
  panels: {
    count: 2, side: 'left', h: 0.018, d: 0.026,
    y: -0.004, z: -0.038, step: 0.040, hostHalfW: 0.014,
  },
  /** NO RAIL TEETH. Nothing thin stands on this receiver — that is the whole brief. */
  railTeeth: null,
};

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * INK-STAINED IRON — and it is the only NEUTRAL gun in the arsenal.
 *
 * `WEAPON_REWORK` §1.5, measured off the reference: *"The main body is a calm desaturated grey.
 * We spread mid-saturation colour across the whole weapon, which is why the guns read as 'a
 * coloured object' rather than 'a grey machine with hot details'."*
 *
 * Every gun we ship is a coloured object. Measured: inkslinger frame HSL sat 0.52, ratatat olive,
 * boomstick oxide over walnut, longshot desert tan. So THE PRESS takes the one axis nobody has
 * taken — it is a GREY MACHINE, and "the grey one" is a complete description of which gun you are
 * holding, exactly the way "the blue one" describes the inkslinger.
 *
 * ─── THE INK IT IS MIXED FROM ───────────────────────────────────────────────────────────────
 * Grey is not the absence of a decision. Mixing two greys gives a third grey and no identity, so
 * the ink is mixed first and then knocked back:
 *
 *     PRESS_IRON = SLATE (#445270) × NIGHT_B (#4d2e82) at 0.38
 *                = #474477 — hue 244°, HSL sat 0.27, luma 0.284
 *
 * NIGHT_B is the palette's connective violet, which is what "ink-stained" means in this project's
 * own vocabulary. Nothing wears it raw; every field below is a knock-back off it, and the two big
 * ones land at a saturation of a tenth.
 *
 *   field    hex       luma    hue    sat    what wears it
 *   polymer  #524d7a   0.319   247°   0.23   grip · heel · beavertail · underlug · cuts · trigger
 *   frame    #736a83   0.430   262°   0.11   lower frame · guard · barrel · THE SLAB
 *   steel    #948ea1   0.567   259°   0.09   the magazine (the vocabulary's steel is unused)
 *
 * ─── THE VALUE LADDER IT HAS TO LIVE IN, CHECKED AGAINST WHAT IS AROUND IT ──────────────────
 * A weapon palette is not judged on its own; it is judged against the four fixed materials the
 * builder puts on every gun, and it has been shipped wrong here twice:
 *
 *   glove       0.216   ← the largest, nearest object in the frame. `polymer` must not land on
 *                         it or the grip and the hand fuse into one blob. 0.319 clears it by
 *                         0.103, wider than the inkslinger's own 0.073.
 *   sights      0.188   ← the top plate. DARKER than the body it stands on, which is the right
 *                         direction: a dark rail reads against the world you are aiming at.
 *   trim BONE   0.729   ← the muzzle. `steel` at 0.567 stays a clear step under it.
 *   accent RUST 0.542   ← the hammer, the breech block, the grip wrap.
 *
 * So the read, dark to light: plate 0.19 · glove 0.22 · grip 0.32 · slab 0.43 · magazine 0.57 ·
 * muzzle 0.73. Six steps, none of them adjacent by less than 0.03, and the two biggest masses
 * (slab and grip) are 0.11 apart.
 *
 * ─── AND THE THREE HOT MARKS, WHICH ARE ALL THE SATURATION THIS GUN GETS ────────────────────
 * §1.5 asks for a few percent of the area, highly saturated, at the periphery. Measured by where
 * they are rather than by how big they are:
 *
 *   REAR    the hammer spur and the breech block — RUST (sat 0.91), at the two rearmost
 *           centimetres of the gun, forming one warm mass under the tang
 *   GRIP    three wrap bands on the backstrap — RUST, and mostly behind the glove
 *   FRONT   the muzzle core — GOLD (sat 0.90), 20 mm across, on the muzzle face
 *
 * Nothing between those two ends carries any saturation at all. ART §9 is intact field by field:
 * ACID and HOT appear nowhere and in nothing mixed here; GOLD is on the muzzle core, which is the
 * one place the palette reserves it for; every value is under `ENV_VALUE_CEIL` 0.78 and over
 * `ENV_VALUE_FLOOR` 0.12.
 *
 * ─── SEPARATION FROM THE LEVEL ──────────────────────────────────────────────────────────────
 * The failure recorded in the inkslinger's file is a blue-grey gun vanishing against SLATE walls.
 * The slab at 0.430 is +0.112 luma over SLATE (0.318) and −0.092 under the CONCRETE deck (0.523),
 * and it opposes both in hue — 262° against SLATE's 221° and against CONCRETE's warm 36°. It is
 * the only violet-neutral object in the frame.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const PRESS_IRON = hexMix(PALETTE.SLATE, PALETTE.NIGHT_B, 0.38);

const FIELDS: FieldSet = {
  /** Lower frame, guard, barrel and the slab — the calm mass the whole gun is read as. */
  frame: hexMix(PRESS_IRON, PALETTE.BONE, 0.33),
  /** Grip, heel, beavertail, underlug, stamped cuts, trigger — the ink, one step off raw. */
  polymer: hexMix(PRESS_IRON, PALETTE.BONE, 0.08),
  /** The magazine. The `steel` PART group is empty on this gun; the field still has to exist. */
  steel: hexMix(PRESS_IRON, PALETTE.PAPER, 0.45),
  /** No wooden part. Kept so the field set is total. */
  wood: FIELD.wood,
};

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE SURFACES — and this is where `WEAPON_REWORK` §1.3 is actually spent.
 *
 * *"Their receiver is a big smooth slab with scribed grooves across it. Those grooves ARE the
 * detail. They cost nothing in silhouette, they cannot become sticks... Stop adding geometry.
 * Draw lines."*
 *
 * A `Skin` is a pattern plus a TILE DENSITY in tiles per metre, and the density is not a taste
 * dial — it is what decides where each mark lands and how big it is. `projectSurfaceUV` centres
 * the tile on the merged group's bounding box and runs u along −z (down the barrel) on both the
 * top and the side faces, so a density is a statement about millimetres of gun. Every number
 * below was solved rather than tried.
 *
 * ─── THE SLAB: `frameVent` AT 11 TILES/M, WHICH IS THE PANEL LINE ───────────────────────────
 * `makeVentedSteel` draws three bevelled slots at v 0.26 / 0.57 / 0.88, each 0.13 of the tile
 * tall and 0.68 long, filled with the map's darkest value and lipped with the lightest along
 * their top edge — a scribed channel with a lit edge, which is precisely the mark this gun wants.
 * The slide group's bbox is 40 mm tall and 150 mm long, centred at y 0.027, z −0.052, so at
 * 11 tiles/m (a 91 mm tile):
 *
 *   v across the 40 mm flank spans 0.28 … 0.72 — which admits exactly ONE of the three slots.
 *     slot 2 (v 0.505–0.635)  →  y 0.0275 … 0.0393: a 12 mm channel sitting just above the
 *                                flank's midline, 8 mm clear of the top chamfer
 *     slot 1 (v 0.195–0.325)  →  clipped to a 2.5 mm sliver at the very bottom edge, where it
 *                                merges into the silhouette's own line and reads as weight
 *     slot 3, and the pattern's light-catch band, fall outside the flank entirely
 *   u along the 150 mm slab spans −0.325 … 1.325 — one full 62 mm channel across the middle of
 *     the slab plus a 15 mm stub at each end, i.e. a broken panel line rather than a stripe
 *   the two rivets sit at v 0.55, ON the channel's line, 8 mm across: four bolt heads down the
 *     flank in two pairs. A machined channel with bolts at its ends is a printing press.
 *
 * ONE channel and four bolts on a 150 × 40 mm plane. That is `WEAPON_ART` §0's *"3 BOLD slots,
 * not 8 thin ones"* taken one step further, and it is drawn on the same triangles the slab
 * already had.
 *
 * ─── THE REST ───────────────────────────────────────────────────────────────────────────────
 * `framePark` on the lower frame at 12 tiles/m: the deliberately quiet one, ±8 % blocky patches
 * at 18–38 mm, so the frame under the slab is finish rather than pattern. Detail concentrated,
 * §1.4.
 *
 * `polyTape` on the polymer at 11 tiles/m against the inkslinger's 18. Same generator, 60 %
 * coarser: a 91 mm tile puts four wraps at a 23 mm pitch with 12.5 mm of tape, so the grip
 * carries four or five bands you could count instead of nine you could not. This is the
 * "wrapped grip" the design asks for, and the three RUST bands the builder wraps round the
 * backstrap are the same wrap seen from the other side.
 *
 * `plainSteel` twice, both times on purpose: the `steel` group is EMPTY on this gun (no port, no
 * charging handle, no rail teeth — see the profile), and the magazine lives inside the grip where
 * a pattern would be four visible millimetres of floorplate.
 *
 * ─── WHAT THIS FILE COULD NOT DO, AND WHERE IT WOULD GO ─────────────────────────────────────
 * The brief says to spend the boot budget on a bespoke high-resolution surface set for this gun.
 * A weapon file cannot: `MatKey` is a closed union in `./types.ts`, and each key's generator
 * arguments — including `size`, which is 256 for every map in the game — are hard-coded in
 * `buildFieldMat` inside `viewmodel.ts`. A new pattern is therefore three files, none of which
 * this file owns. If the human wants the channel drawn at 1024 with a real bevel and a second
 * scribe line, that is a `pressPlate` generator in `art/surfaces.ts`, one key in `types.ts` and
 * one case in `buildFieldMat` — and it is the highest-value next move on this gun.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const SKIN: WeaponSkin = {
  frame: { mat: 'framePark', uv: 12 },
  slide: { mat: 'frameVent', uv: 11 },
  polymer: { mat: 'polyTape', uv: 11 },
  steel: plainSteel,
  magazine: plainSteel,
};

export const PRESS: WeaponModelDef = { profile: PROFILE, fields: FIELDS, skin: SKIN };

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * REDLINE — an FN SCAR-H, built to the SILHOUETTE SIGNATURE rather than to the tape measure.
 *
 * The brief this file answers, in one line: *"EVERY weapon in this game is TALLER THAN IT IS
 * LONG."* Measured with an offline re-implementation of `assertClearance` (un-bevelled boxes, so
 * every number is conservative), drawn length ÷ drawn height, hand excluded:
 *
 *     inkslinger 0.77  ·  THE PRESS 0.78  ·  ratatat 0.78  ·  longshot 0.99  ·  **REDLINE 1.21**
 *
 * And the mass the eye actually calls "a block" — the receiver — goes from 2.0–2.5:1 to **4.4:1**,
 * with a **140 mm top rail standing 10 mm proud: 14:1**.
 *
 * ─── READ THIS BEFORE CHANGING `depthCompress`, BECAUSE THE OBVIOUS FIX IS ARITHMETICALLY
 *     IMPOSSIBLE AND IT WAS CHECKED RATHER THAN GUESSED ─────────────────────────────────────
 * The brief asked for `depthCompress: 1.0` — no z-squash, true proportions, made to fit by
 * authoring smaller and by `restDz`. **It does not fit, and it does not fit by 24 mm.**
 *
 * `depthCompress` scales the WHOLE model on the way out of `buildGunGeometry`, including the
 * parts a profile does not own: the lower frame, the trigger guard, the grip, and the HAND. The
 * forearm's rear corner sits at gun-space z 0.160; at dc 1.0 that is drawn at 0.160 instead of
 * the press's 0.106, i.e. **54 mm closer to the eye**, and `view.nearClearance` (0.070) then
 * forces `restDz` down to about −0.053 to buy it back. Pushing the pose 53 mm forward spends 53 mm
 * of the reach budget at the muzzle end. Walked over all seven poses with a gun consisting of
 * NOTHING BUT the builder's own fixed parts (no barrel, no receiver, no stock):
 *
 *     dc     restDz    reach   swayed    verdict          (budgets: reach ≤ 0.400, swayed ≤ 0.420)
 *     0.66   −0.003    0.345   0.353     ok
 *     0.78   −0.019    0.371   0.379     ok
 *     0.86   −0.032    0.391   0.398     ok
 *     0.90   −0.038    0.400   0.407     on the line, with zero gun on it
 *     1.00   −0.053    0.424   0.430     **IMPOSSIBLE — the fixed parts alone are 24 mm over**
 *
 * AND THE FINDING THAT MATTERS MORE: **the total drawn length of a weapon in this builder is
 * invariant under `depthCompress`.** Higher dc buys rear length (the hand's own tail moves back,
 * and anything behind the hand is free on the near plane) and gives back exactly that much front
 * length. Solved numerically, front extent + rear extent at the budget:
 *
 *     dc      0.55    0.60    0.66    0.72    0.76    0.80    0.84
 *     drawn L 0.208   0.209   0.211   0.211   0.211   0.211   0.212
 *
 * About 211 mm, whatever you do — 2 % of spread across the whole legal range of the field. (The
 * shipped gun measures 220.7 mm, four percent over the probe, because the probe held a uniform
 * 0.072 m of near-plane margin while this profile spends both budgets down to their last
 * millimetre: 0.073 near, 0.396 reach.) So `depthCompress` is NOT the length lever
 * the brief believed it was; it is a lever that decides **where** the 211 mm goes and **how much
 * z the parts this file does not own keep**. 0.62 is chosen for two reasons, both measured:
 *
 *   · it leaves 54 mm of gun FORWARD of the builder's fixed dust cover (drawn front 0.0626) —
 *     against the press's 36 mm and the ratatat's 49 mm. That forward projection is what reads
 *     as "long" at a glance, and it is bought directly with low dc;
 *   · it keeps the fixed HAND at 62 % depth, above the ratatat's 54 % and the longshot's 50 %.
 *     A 34 mm-deep fist is the thing that makes everything held in it look wrong.
 *
 * ─── AND THE HARD CEILING, WHICH IS WORTH WRITING DOWN ONCE ─────────────────────────────────
 * Drawn HEIGHT has a floor this file cannot touch: the builder's grip and heel bottom out at
 * y −0.1221 and the hard-coded hammer spur tops out at 0.0529 (`sight.lineY` must clear it), so
 * **no profile in this codebase can be shorter than ~0.175 m in y**. With length capped at
 * ~0.211 m, the arsenal-wide ceiling on drawn L:H is **1.21** — which is what this gun measures.
 * There is no seventh pass that gets a 4.6:1 SCAR out of this builder. Getting past 1.21 needs
 * ONE change in `viewmodel.ts`, and it is stated here so nobody re-derives it:
 * **exempt the `hand` group from `depthCompress`, or scale the grip/heel/hand with a second
 * factor.** That alone would return ~50 mm of z budget and unlock dc ≥ 0.9.
 *
 * ─── THE BALANCE THE PLAYTESTER ASKED FOR ("doesnt have to look exactly good... a balance") ──
 * A real SCAR-H is 965 mm long. At the drawn scale of the builder's fixed grip (which is a real
 * 1:1 pistol grip, k ≈ 0.73 of life size) it would need 743 mm of z, and 211 mm is what exists.
 * So the gun is drawn at k_z ≈ 0.22 of life along its axis and k_xy ≈ 0.42 across it — an
 * anisotropy of 2.0, against the arsenal's current 2.6 (longshot) and 3.2 (ratatat). Every
 * INTERNAL ratio is true to the reference and the whole thing is simply small:
 *
 *     REAL SCAR-H, from the trigger        REDLINE, drawn, from the trigger (z −0.0198)
 *     muzzle              −610 mm          −0.0969   ← 15.9 % of the reference
 *     handguard front     −430 mm          −0.0662   ← 15.4 %
 *     magwell front       −175 mm          −0.0376   ← 21.5 %
 *     receiver rear       +150 mm          +0.0818   ← 54.5 %
 *     buttpad             +355 mm          +0.1238   ← 34.9 %
 *     rail ÷ receiver      97 %             88 %
 *     receiver : stock     74 : 26          79 : 21
 *
 * THE FRONT IS AT 16 % OF THE REFERENCE AND THE REAR IS AT 35–55 %, AND THAT IS NOT A MISTAKE —
 * it is the only degree of freedom the pose leaves. Everything ahead of the hand is paid for out
 * of the reach budget, which is exhausted; everything BEHIND the hand is free until it passes the
 * forearm's own tail. A true 63 : 37 front-to-rear split would mean throwing away 60 mm of legal
 * rear length to buy nothing, on the one gun whose whole brief is drawn length. So REDLINE runs
 * a 44 : 56 split about the trigger, which is a battle rifle whose stock is extended a notch
 * further than the reference photograph's — an adjustable stock, in the position that fits.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { FieldSet, GunProfile, WeaponModelDef, WeaponSkin } from './types';
import { FIELD, plainSteel } from './types';
import { PALETTE, hexMix } from '@/art/palette';

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE TOP RAIL — the SCAR's signature, and the one place six previous passes died.
 *
 * *"A LOW FLAT RAIL RUNNING THE LENGTH OF THE RECEIVER, integral to it, reads as machined. A POST
 * STANDING UP reads as an antenna."* The difference is entirely arithmetic and all of it is here.
 *
 * `SightSpec` can only say three boxes with their tops pinned to `lineY`. THE PRESS proved they
 * can be made to overlap into one solid; this file takes the same trick and stretches it, because
 * a SCAR's rail is not a strap on the breech, it is the whole top of the gun:
 *
 *   rear pair   x  ±(notchHalfGap + bladeW/2) = ±0.002, each 14 mm wide
 *               →  [−0.009, +0.005] and [−0.005, +0.009], union **18 mm with 10 mm of overlap**
 *                  (`notchHalfGap` is NEGATIVE; at 0 the two boxes abut and z-fight, at −0.007
 *                   they are fully coincident and z-fight worse. −0.005 is the only safe window.)
 *   rear box    z  authored [−0.048, +0.084]  →  drawn [−0.030, +0.052]
 *   front box   z  authored [−0.142, −0.010]  →  drawn [−0.088, −0.006]
 *   union       z  drawn **[−0.088, +0.052] = 140 mm, continuous, 24 mm of overlap in the middle**
 *
 * ─── WHY IT CANNOT READ AS A LUMP ───────────────────────────────────────────────────────────
 *   · **140 mm long against 10 mm proud is 14:1.** THE PRESS's plate — the thing that finally
 *     stopped the playtester counting solids — is 5.7:1. Nothing at 14:1 is a post; the eye reads
 *     it as an edge of the receiver, which is what a machined rail is.
 *   · **It is 88 % of the receiver's own drawn length** (140 of 158 mm) and it starts and ends
 *     INSIDE it — 8 mm short at the nose, 10 mm short at the tail. A rail that overhangs its
 *     receiver is a rail somebody bolted on.
 *   · **Two thirds of it is buried.** `rearH`/`frontH` are 30 mm reaching down from `lineY` 0.060,
 *     so the underside sits at y 0.030 — 20 mm below the receiver's top face (0.050) and 16 mm
 *     above its floor (0.014). The rail passes THROUGH the receiver's top and terminates deep
 *     inside it. No base, no seam, no gap for the ink to find.
 *   · **18 mm wide on a 28 mm receiver** leaves 5 mm of deck showing either flank. Inset, never
 *     overhanging.
 *   · The front box is 14 mm wide against the rear pair's 18 — a 2 mm step per side, 3.4 px,
 *     well under the ink band. Deliberate, and the opposite of THE PRESS's call: that gun wanted
 *     one silhouette event on its top, a SCAR's rail is a constant section and must not step.
 *
 * ─── AND WHAT THE PLAYER SIGHTS WITH ────────────────────────────────────────────────────────
 * The rail's top face IS the sight line: `aimSocketOf()` puts the eye exactly on `lineY`, so at
 * ADS the rail is edge-on and its two flanks converge at the crosshair. No post, no notch, no
 * blades, nothing standing anywhere — `sightWings`, `railTeeth`, `opticBlock` and `opticFront`
 * are all null and the entire aim reference is a plane on top of the receiver.
 *
 * THE ONE THING THAT CAN INTRUDE ON IT IS THE HARD-CODED HAMMER, and it is checked, not hoped.
 * The eye is `0.235 + (rearZ − z) × depthCompress` from anything at gun-space z, so the spur
 * (top 0.0529, z 0.026) sits at d 0.230 m and its top clears `lineY` 0.060 by **30.9 mrad** —
 * 1.8° below the crosshair before the first warm pixel. (THE PRESS clears 33.8 mrad; the recorded
 * failure was 10 mrad, which put an orange mass 14 px under the aim point.)
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const SIGHT = {
  /**
   * The rail's top face, the sight line, and the highest point on the weapon. 0.060.
   *
   * Floored by the hammer (0.0529, see above) and ceilinged by drawn HEIGHT — every millimetre
   * here is a millimetre off the L:H this whole gun exists to fix. 10 mm proud of the receiver is
   * the balance: 1.4× `INK_FLOOR_INTERIOR` (0.007, the floor for a part on the thin
   * `view.sightOutlinePx` hull, which the sights group rides), ~17 px raw at the hero lens, and
   * a 14:1 plate.
   */
  lineY: 0.060,
  /**
   * The two boxes' centres, and `rearZ` is ALSO the aim socket — `adsOffsetOf()` puts it exactly
   * `view.adsSightDistance` from the eye, so this number drags the whole ADS pose.
   *
   * +0.0179 is 43 mm behind the receiver's centre and 65 mm behind the trigger, which is where a
   * SCAR's rail actually ends: over the rear of the receiver, behind the shooter's hand. It is
   * also the direction the ADS near plane wants — a socket further BACK pushes the model further
   * FORWARD at ADS (`adsZ` = −0.235 − rearZ × 0.62), and the measured ADS clearances are 0.125 m
   * (ads) and 0.102 m (ads+recoil) against a 0.070 budget. There is no tension here for once.
   */
  rearZ: 0.0179,
  frontZ: -0.0759,
  /** Rail width. 14 mm — not dc-scaled, so it is 1.4× the 10 mm silhouette floor as authored. */
  bladeW: 0.014,
  /** How far each box reaches DOWN from the line. NEITHER IS A VISIBLE HEIGHT — see above. */
  rearH: 0.030,
  frontH: 0.030,
  /**
   * Fore-and-aft length of EACH box; the union is `2 × bladeD − overlap`. 132 mm authored draws
   * as 82 mm, and the two overlap by 38 mm authored (24 mm drawn) for a 140 mm continuous rail.
   * This is the single number that makes this gun read as a SCAR rather than as a slab.
   */
  bladeD: 0.132,
  /** NEGATIVE, and that is the point — see the block above. Do not take it positive. */
  notchHalfGap: -0.005,
} as const;

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * REDLINE. Every z below is authored; multiply by `depthCompress` 0.62 for what is drawn, and the
 * drawn number is quoted in every comment because it is the only one any budget is measured in.
 *
 * ─── CLEARANCE, WALKED OFFLINE OVER ALL SEVEN POSES × THE FIVE SWAY CORNERS × THE FLOURISHES ─
 * Re-implementation of `assertClearance` with un-bevelled boxes (every corner further out than
 * `bevelBox` puts it), validated against THE PRESS first — it reproduces that file's shipped
 * table to the millimetre on all seven rows, so these numbers are the same measurement:
 *
 *   pose               reach (swayed) / near      binding vertex      budgets
 *   rest               0.396 (0.403) / 0.092      muzzle core / hand   reach  ≤ 0.400
 *   ads                0.367 (0.368) / 0.125      muzzle core / hand   swayed ≤ 0.420
 *   sprint             0.388 (0.397) / 0.073      muzzle can / hand    near   ≥ 0.070
 *   reload             0.392 (0.401) / 0.094      magazine / hand
 *   equip              0.395 (0.402) / 0.123      muzzle core / hand
 *   rest+recoil+land   0.341 (0.348) / 0.073      muzzle core / stock pad
 *   ads+recoil         0.335 (0.335) / 0.102      muzzle core / stock pad
 *
 * THE FORWARD-MOST VERTEX, longhand, because the brief asked for the arithmetic. It is a corner
 * of the emissive muzzle core at gun space (0.0080, 0.0400, −0.1167) — the core sits at
 * `muzzle.z − muzzle.len/2` and is the only thing ahead of the can's face. Through the rest pose
 * (translate 0.125, −0.112, −0.242; YXZ euler pitch −2.5°, yaw −14°, roll +3.2°):
 *
 *     camera space  (0.1592, −0.0767, −0.3555)
 *     reach   = hypot(0.1592, 0.3555)          = **0.3895**  ≤ 0.400  ✔  (10 mm spare)
 *     swayed  = hypot(0.1592 + 0.0154, 0.3555) = **0.3961**  ≤ 0.420  ✔  (24 mm spare)
 *
 * (The table's 0.396 is the same vertex with the ±7.5° rotational sway corners summed on top,
 * which is what `assertClearance` actually bounds. Both are inside.)
 *
 * THE RIGHT-MOST VERTEX is the shared glove, at gun (0.0430, −0.1536, 0.0248) → camera
 * (0.1674, −0.2617, −0.1991): reach 0.2601, swayed 0.2703. It is nowhere near the budget and it
 * never can be, because reach is a HYPOTENUSE and the wide end of the model has almost no z. The
 * gun's own widest parts are the magwell collar at ±0.020 and the muzzle fin at ±0.019 — both
 * inboard of the fist by 20 mm.
 *
 * ─── AND THE ONE BUDGET THIS GUN SPENDS TO THE LAST MILLIMETRE ──────────────────────────────
 * `view.clearanceKickBudget` is 1.0 and this weapon is AT it: at `weaponKick` 1.0 the tightest
 * pose keeps 0.073 m, at 1.1 it is 0.067 — inside `nearClearance`. So `defs.ts` gives REDLINE
 * `weaponKick: 1.0` and puts the punch a heavy rifle needs into `cameraKick` (which costs no
 * clearance at all) and into the pattern's amplitude. If a future pass wants a heavier gun in the
 * hands it must first pull `stock.z` in by 10 mm — measured, that buys `weaponKick` 1.2 and costs
 * 10 mm of drawn length, i.e. L:H 1.21 → 1.16. This file spent it on length, deliberately.
 */
const PROFILE: GunProfile = {
  id: 'redline',
  /** See the block at the top of this file. 1.0 is impossible; 0.62 is the measured optimum. */
  depthCompress: 0.62,
  /**
   * ZERO, and it is zero the hard way. The near plane has 3 mm of margin at rest+recoil and the
   * reach budget has 4 mm at rest, so this gun is pinned between the two contracts on both sides.
   * Positive spends near for reach (at +0.004 the near falls to 0.069, outside the budget);
   * negative spends reach for near (at −0.006 the reload pose reaches 0.405, outside the budget).
   */
  restDz: 0,
  sight: SIGHT,
  /**
   * THE MONOLITHIC UPPER — 28 × 36 × 255 mm authored, drawn **28 × 36 × 158 mm**, spanning
   * y 0.014…0.050 and drawn z −0.0962…+0.0620.
   *
   * **4.4:1 drawn, against the arsenal's 2.0 (ratatat), 2.1 (longshot) and 2.5 (THE PRESS).**
   * This one field is most of the answer to "they read as blocks": a SCAR's upper receiver and
   * handguard live under one continuous rail and run ~580 mm of a 965 mm gun, and every other
   * weapon in this game spends its length on a thin barrel instead of on the mass that carries
   * the rail. The receiver here runs from 10 mm ahead of the handguard's nose to 5 mm inside the
   * stock's front face — one unbroken slab from muzzle group to butt.
   *
   * The three numbers everything on the top of this gun is measured from:
   *   top face    0.050   the rail stands 10 mm proud of it; the hammer 3 mm
   *   flanks      `bevelBox`'s 7 mm bevel leaves a 14 mm-wide top flat and a ~22 mm dead-flat
   *               side face 158 mm long — **the big calm plane the panel lines are drawn ON**
   *   width 28    narrow on purpose. 36 × 28 mm is roughly 42 % of a real SCAR's section, which
   *               is the "author the whole weapon uniformly smaller" half of the brief. It is
   *               the same width as the longshot's receiver and 18 mm under the ratatat's.
   */
  receiver: { w: 0.028, h: 0.036, d: 0.2552, y: 0.032, z: -0.0276 },
  /**
   * NONE. The builder's serrations are `INK_FLOOR` (10 mm) thick in z and z is dc-scaled, so at
   * 0.62 each tooth draws 6.2 mm on a 10.5 mm pitch: both the tooth and its gap land under the
   * ink band and the whole stack prints as one black patch at the back of the receiver. It is
   * also honest — a SCAR has no cocking serrations. This gun draws its lines instead (see SKIN).
   */
  serrations: 0,
  /**
   * The barrel, 18 mm across and drawn 53 mm long from z −0.1068 to −0.0541. It emerges 11 mm
   * ahead of the receiver's nose, runs **13.5 mm bare** between the handguard's front face
   * (−0.0860) and the muzzle device's rear ring (−0.0995), and dies 5 mm INSIDE the can — an
   * overlap, not a butt joint, because two solids that nearly touch merge hulls and print as one
   * black lump while two that interpenetrate print as one part.
   *
   * `len` is 85 mm authored to buy that 5 mm: at the 71 mm this file first tried, the barrel's
   * face landed 1 mm short of the can's and the two would have inked as separate objects with a
   * seam between them. The visible length is unchanged — the extra is swallowed by the can.
   */
  barrel: { r: 0.009, len: 0.085, y: 0.032, z: -0.1298 },
  /**
   * THE FLASH HIDER — one bold ring on a short can, on the receiver's own centreline (the
   * builder places the can at `receiver.y`, so the bore, the barrel and the muzzle are colinear
   * by construction, which is exactly the SCAR's inline layout).
   *
   * Drawn: the can spans z −0.1155…−0.1015 at r 0.011 — **14 mm long, which is 6.4 % of this
   * gun's length against the reference hider's 6.7 % of a real SCAR's**. The single fin is 38 mm
   * across, i.e. 8 mm proud of the can, and it lands at −0.1029, leaving its rear face 13.5 mm
   * ahead of the handguard's nose: it reads as the device's rear ring with bare barrel behind it,
   * rather than as a collar jammed into the fore-end.
   *
   * ONE FIN, NOT TWO. The builder's fin is 11 mm deep in z and z is dc-scaled: at 0.62 that is
   * 6.8 mm drawn, and a second fin on the 13 mm pitch would leave a 1.2 mm gap between them —
   * two teeth and no gap is one black lump. (Every gun in the arsenal is under the band on this
   * axis — the press 7.3 mm, the ratatat 5.9, the longshot 5.5 — because the dimension is
   * hard-coded in `buildGunGeometry` and then compressed. It is a builder issue, not a profile
   * one, and the fins and the can are merged into one hull anyway, so the fin reads as a step in
   * the can's silhouette rather than as a part with its own line.)
   */
  muzzle: { r: 0.011, len: 0.0226, z: -0.1750, fins: 1, finW: 0.038 },
  /**
   * THE STRAIGHT BOX MAGAZINE, FORWARD OF THE GRIP — the second-biggest "this is a rifle" cue
   * after the rail, and the reason it is not longer is arithmetic rather than taste.
   *
   * The builder rakes it by `MAG_RAKE` 0.30 rad (top back, bottom forward), which is the SCAR's
   * own rake and is shared with `magWell` by construction. Drawn, the box and its floorplate span
   * y −0.067…+0.020 and z −0.060…−0.013: top face flush with the receiver's floor, front face
   * inside the magwell, and the floorplate running **12 mm INTO the fixed fist**, between the
   * second and third finger ridges.
   *
   * That interpenetration is deliberate and it is unavoidable. A magazine forward of the grip is
   * the SCAR read — the ratatat and the longshot both bury theirs inside the fist because they
   * are an SMG and a bolt gun — and the fist sits at a z this file cannot move. A genuine 12 mm
   * overlap is the safe half of the rule this project keeps relearning: the mag and the glove are
   * separate meshes with separate hulls, so what prints is one ink line where the magazine enters
   * the hand, i.e. a magazine going behind a fist. Stopping 2 mm short would have merged the two
   * hulls into a single black lump instead. It also animates correctly: the reload drops the mag
   * 120 mm straight down past the fingers, which is what a magazine does.
   *
   * **IT IS THE RELOAD POSE'S REACH-BINDING PART.** The reload arc drops the model 130 mm and
   * pitches it 17°, and the magazine drops a further 120 mm inside that — so its own length is
   * levered straight out along the reach vector. Measured, holding everything else fixed:
   *   h 0.078 → reload reach 0.400 (ON the budget) · h 0.070 → 0.395 · **h 0.064 → 0.392**
   * The 14 mm this gives up is 14 mm of barrel it gets back at the other end, and a magazine that
   * stops 53 % of the way down the fixed grip against the reference's 71 % is a difference nobody
   * can see. A magazine that clips a wall on a reload is one everybody can.
   */
  magazine: { w: 0.020, h: 0.064, d: 0.048, y: -0.018, z: -0.0645 },
  tube: null,
  /**
   * THE HANDGUARD — 30 × 30 mm authored, drawn 46 mm long from z −0.0860 to −0.0400, hanging
   * under the receiver's front third and overlapping into it by 15 mm in y.
   *
   * It is 30 mm wide against the receiver's 28: 1 mm proud per flank, which is under the ink band
   * and is meant to be. The separation is a VALUE break, not a silhouette one — dark polymer
   * under a lighter receiver, which is `WEAPON_ART` §2's "biggest available win" at zero
   * geometric cost, and it draws the horizontal split down the gun's front half that a SCAR
   * actually has.
   *
   * ZERO RIBS. The rib generator emits `INK_FLOOR` in z for a horizontal fore-end; dc-scaled that
   * is 6.2 mm drawn on a 10 mm floor, so the stack would print solid. The handguard's slots are
   * drawn as `panels` instead — `WEAPON_REWORK` §1.3, and cheaper.
   */
  foreEnd: { w: 0.030, h: 0.030, d: 0.0742, y: 0.018, z: -0.1016, ribs: 0 },
  /**
   * THE SIDE-FOLDING STOCK — solid, inline with the bore, drawn from z +0.0569 to +0.1040.
   *
   * Its front face is 5 mm INSIDE the receiver's rear face (0.0620), which is the whole trick:
   * `WEAPON_REWORK` §2.5's *"no part may look bolted on"* is answered by interpenetration, not by
   * a bracket. And the HINGE the brief asks for is drawn rather than built — the stock is POLYMER
   * (luma 0.291) against the receiver's FRAME (0.460), so the junction plane is a hard value
   * break exactly where a SCAR's hinge is. A hinge boss would be a small part standing separate
   * from the body, which is the failure mode this whole rework exists to delete.
   *
   * 26 mm wide against the receiver's 28 — inset, as a folding stock is. Its top (drawn 0.051 at
   * the pad) stays 9 mm under `lineY`, so it never enters the sight picture.
   *
   * ITS REAR IS THE NEAR-PLANE BINDING VERTEX at both recoil poses (0.073 m). Everything behind
   * the hand is free until it passes the forearm's own tail at drawn 0.0992; this passes it by
   * 4.8 mm and pays for those with the last of the near-plane margin. See `clearanceKickBudget`
   * in the block above before moving it back any further.
   */
  stock: { w: 0.026, h: 0.032, d: 0.060, y: 0.030, z: 0.1217, skeleton: false },
  /**
   * THE RED LINE. The gun is named after it.
   *
   * `rib` is the only RUST part a profile can place, it rides the receiver, and here it is a warm
   * spine running the receiver's whole length UNDER the rail: drawn 124 mm long, 24 mm wide,
   * top face at y 0.052 — 2 mm proud of the receiver and 3 mm wider than the rail either side, so
   * what the player sees is two thin warm lines flanking a dark rail from the muzzle group to
   * behind the hand. That is one continuous saturated mark on the top edge of the silhouette at
   * rest, at ADS and mid-recoil, which is what `WEAPON_REWORK` §1.5 asks a saturated accent to be:
   * peripheral, and a few percent of the area (measured ~3.5 %).
   *
   * It is a VALUE/HUE break, not a silhouette event — 2 mm proud is 3.4 px, well under the band —
   * and that is deliberate: the inkslinger ships exactly this part at exactly this prominence and
   * it is the one warm mark on that gun that has never been complained about. At 8 mm below
   * `lineY` and entirely under the rail's own shadow it cannot occlude the sight plane; there is
   * no front post on this weapon for it to eat.
   */
  rib: { w: 0.024, h: 0.012, d: 0.200, y: 0.046, z: -0.0276 },

  // ── THE DETAIL VOCABULARY: THREE ENTRIES, AND EVERY OMISSION IS DELIBERATE ────────────────
  /**
   * NO EJECTION PORT, and on this gun the omission is free rather than painful. A SCAR ejects to
   * the RIGHT, and the right flank is the one the camera never sees — the weapon is held at the
   * lower right and yawed −14°, so the player looks at its LEFT side for the whole session. The
   * port's front wall is also `INK_FLOOR` in z, which dc-scales to 6.2 mm and would print solid.
   */
  ejectionPort: null,
  /**
   * THE CHARGING HANDLE, LEFT — and this is the one mechanism on the gun (`WEAPON_REWORK` §2.5
   * clause 7: *"a charging handle should look grabbable"*).
   *
   * It goes on the left because that is BOTH the side a factory SCAR ships it on AND the side the
   * camera sees, which is the rare case where the reference and the frame agree. It is a 20 mm
   * stand-off ending in a paddle — a hook, never a taper — and every one of its dimensions clears
   * the ink floor after compression: stem 20 × 18 × 11.2 mm drawn, paddle 12 × 30 × 11.2 mm.
   *
   * `y` 0.034 is the receiver's upper third and is a SIGHT-PICTURE number as much as a styling
   * one: the paddle's top lands at 0.049, one millimetre UNDER the receiver's own top face, so
   * nothing on this gun rises above the deck except the rail. At 0.044 the paddle topped out at
   * 0.059 — one millimetre under `lineY`, i.e. a lump sitting exactly on the sight horizon.
   */
  chargingHandle: { side: 'left', len: 0.020, thick: 0.018, y: 0.034, z: -0.0323 },
  /** NO SELECTOR. A round boss plus a swung bar is two small parts to say one small thing, and
   *  §1.4's budget of three detail zones is already spent on the handguard, the magwell and the
   *  charging handle. */
  selector: null,
  /**
   * THE MAGWELL — the step that makes the magazine read as INSERTED rather than glued on, and the
   * middle of the gun's three detail zones. It is static while the magazine animates down through
   * it on a reload, which is the read we want and costs nothing. It carries the same 0.30 rad rake
   * the magazine does, by construction rather than by two authors typing the same number.
   *
   * Drawn 35 mm long and standing 16 mm below the receiver's floor, with a 5 mm collar flare.
   */
  magWell: { w: 0.030, h: 0.020, d: 0.056, y: 0.008, z: -0.0645, flare: 0.005 },
  /** NO WINGS. There is no post to protect — the rail's top face is the sight. */
  sightWings: null,
  /**
   * NO APERTURE, ON EITHER HALF. `OpticBlockSpec` floors at `(lineY − receiverTop) + boreR +
   * topWall` proud, which on this receiver is 10 + 9 + 10 = **29 mm of ring standing on the
   * deck** — three times the rail's height, on the one gun whose entire thesis is that the top of
   * a receiver is flat. A SCAR wears an optic on the rail; the rail is the point, not the optic.
   */
  opticBlock: null,
  opticFront: null,
  /**
   * TWO BOLD SLOTS IN THE HANDGUARD, LEFT ONLY — the forward detail zone, and the one place on
   * this gun where a cut beats a drawn line, because the handguard is the SCAR's most recognisable
   * cut-away surface.
   *
   * LEFT because that is the flank the camera sees. On the HANDGUARD (`hostHalfW` 0.015) rather
   * than on the receiver, because `panels` are POLYMER and therefore STATIC — two cuts holding
   * still while the receiver cycled 20 mm underneath them would read as a bug on every shot.
   *
   * THE PITCH IS WHAT NEEDED CHECKING, NOT THE CUT. `inkChunk` floors each cut and is blind to
   * the LAND between two of them. Drawn, cut 1 spans z −0.0578…−0.0422 and cut 2 −0.0858…−0.0702:
   * a **12.4 mm land**, over the 10 mm floor, so the pair reads as two slots. At the 40 mm
   * authored step this file first tried, the land was 7 mm, both hulls overlapped, and the group
   * would have printed as one 40 mm dark bar. Both cuts sit fully inside the handguard's drawn
   * span (−0.0860…−0.0400), so the group hangs off nothing and costs no reach.
   */
  panels: {
    count: 2, side: 'left', h: 0.016, d: 0.025,
    y: 0.016, z: -0.0806, step: 0.0452, hostHalfW: 0.015,
  },
  /** NO RAIL TEETH. There is already a rail, it is one solid, and nothing thin stands on it. */
  railTeeth: null,
};

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * COLD IRON — the arsenal's cyan-slate, and the only weapon in the game at this hue.
 *
 * Measured, the five shipped guns own: 220° saturated blue (inkslinger, HSL sat 0.52), 262°
 * violet-grey (THE PRESS, 0.11), near-hueless gunmetal (ratatat, 0.03), 20° oxide over walnut
 * (boomstick) and 40° desert tan (longshot). The gap in that wheel is the COOL CYAN-SLATE at
 * 190–200°, which is also what a blued 7.62 receiver actually looks like under a cold key.
 *
 * ─── THE INK IT IS MIXED FROM ───────────────────────────────────────────────────────────────
 *     REDLINE_IRON = SLATE (#445270) × TEAL (#2f7f8f) at 0.42, knocked back with CONCRETE at 0.32
 *                  = #566f7a — hue 198°, HSL sat 0.17, luma 0.418
 *
 * Nothing wears it raw. The CONCRETE knock-back is what turns a petrol teal into a calm machine
 * grey with a hue rather than a coloured object (`WEAPON_REWORK` §1.5), and it takes the two big
 * fields to a saturation of a tenth:
 *
 *   field    hex       luma    hue    sat    what wears it
 *   frame    #66797e   0.460   193°   0.11   lower frame · guard · barrel · THE RECEIVER
 *   polymer  #3d4d57   0.291   203°   0.18   handguard · stock · grip · magwell · slots · trigger
 *   steel    #8e9b9b   0.597   180°   0.06   the charging handle · the magazine
 *
 * ─── THE VALUE LADDER IT HAS TO LIVE IN, CHECKED AGAINST THE FIXED MATERIALS ────────────────
 * A weapon palette is judged against the six materials `viewmodel.ts` puts on every gun:
 *
 *   sights      0.188   ← THE RAIL. Dark iron, and DARKER than the receiver it sits on, which is
 *                         the correct direction: a dark rail reads against the world you aim at.
 *   glove       0.216   ← the largest, nearest object in the frame. `polymer` must clear it or
 *                         the grip and the hand fuse into one blob. 0.291 clears it by 0.075
 *                         (the inkslinger's own margin is 0.073).
 *   accent RUST 0.542   ← the spine, the grip wrap and the hammer.
 *   trim BONE   0.729   ← the muzzle can and its fin.
 *   core GOLD   0.779   ← the muzzle core, the one place the palette reserves GOLD for.
 *
 * Read dark to light: rail 0.19 · glove 0.22 · polymer 0.29 · receiver 0.46 · RUST 0.54 ·
 * steel 0.60 · muzzle 0.73 · core 0.78. Eight steps, none adjacent by less than 0.028, and the
 * two biggest masses (receiver and handguard) are 0.169 apart.
 *
 * ─── SEPARATION FROM THE LEVEL ──────────────────────────────────────────────────────────────
 * The recorded failure is a blue-grey gun vanishing against SLATE walls. The receiver at 0.460 is
 * +0.142 over SLATE (0.318) and −0.062 under the CONCRETE deck (0.522), and it opposes CONCRETE
 * in hue outright (193° against 36°). Against SLATE's 221° the separation is value, not hue, and
 * +0.142 is a wider margin than THE PRESS's shipped +0.112.
 *
 * ─── ART §9 ─────────────────────────────────────────────────────────────────────────────────
 * ACID and HOT appear nowhere, in nothing mixed here. GOLD appears only as the fixed muzzle core.
 * Every value is over `ENV_VALUE_FLOOR` 0.12 and under `ENV_VALUE_CEIL` 0.78. The one thing worth
 * naming: 193° is 6° from `ELECTRIC` (#00e5ff, the shock affix). They cannot be confused — the
 * receiver is HSL sat 0.11 at luma 0.46, ELECTRIC is sat 1.00 at luma 0.72 — but if a future pass
 * ever makes the shock affix tint a weapon's body rather than its VFX, check this first.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const REDLINE_IRON = hexMix(hexMix(PALETTE.SLATE, PALETTE.TEAL, 0.42), PALETTE.CONCRETE, 0.32);

const FIELDS: FieldSet = {
  /** Lower frame, guard, barrel and the 158 mm receiver — the calm mass the gun is read as. */
  frame: hexMix(REDLINE_IRON, PALETTE.BONE, 0.14),
  /** Handguard, stock, grip, heel, magwell, the two slots and the trigger. The dark half. */
  polymer: hexMix(REDLINE_IRON, PALETTE.INK, 0.34),
  /** The charging handle and the magazine — the only two machined-bright parts on the gun. */
  steel: hexMix(REDLINE_IRON, PALETTE.PAPER, 0.36),
  /** No wooden part. Kept so the field set is total. */
  wood: FIELD.wood,
};

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE SURFACES — where `WEAPON_REWORK` §1.3 is actually spent. *"Stop adding geometry. Draw
 * lines."*
 *
 * `projectSurfaceUV` centres the tile on the MERGED group's bounding box and runs u along −z on
 * both the top and the side faces, so a tiles-per-metre figure is a statement about millimetres
 * of gun. Every number below was solved against this gun's own bounding boxes, not tried.
 *
 * ─── THE RECEIVER: `frameVent` AT 12 TILES/M, WHICH IS THE PANEL LINE ───────────────────────
 * `makeVentedSteel` draws three bevelled slots at v 0.26 / 0.57 / 0.88, each 0.13 of the tile tall
 * and 0.68 long, filled with the map's darkest value and lipped with its lightest along the top
 * edge — a scribed channel with a lit edge, which is exactly the mark a machined receiver wants.
 * The receiver group's drawn bbox is 36 mm tall and 158 mm long, centred at y 0.032, z −0.0171,
 * so at 12 tiles/m (an 83 mm tile):
 *
 *   v across the 36 mm flank spans 0.284 … 0.716 — which admits exactly ONE of the three slots.
 *     slot 2 (v 0.505–0.635)  →  y 0.0324 … 0.0433: an 11 mm channel just above the flank's
 *                                midline, 7 mm clear of the top face
 *     slot 1 (v 0.195–0.325)  →  clipped to a 3.4 mm sliver at the very bottom edge, where it
 *                                merges into the silhouette's own line and reads as weight
 *     slot 3 and the pattern's light-catch band fall outside the flank entirely
 *   u along the 158 mm receiver spans −0.449 … 1.449 — one full 57 mm channel across the middle
 *     plus a ~24 mm stub at each end, i.e. a BROKEN panel line rather than a stripe
 *   the two rivets sit at v 0.55, ON the channel's line: four bolt heads down the flank in two
 *     pairs. A scribed channel with bolts at its ends, on a 158 × 36 mm plane, is a machined
 *     receiver — and not one triangle was spent on it.
 *
 * ─── THE REST ───────────────────────────────────────────────────────────────────────────────
 * `framePark` on the lower frame at 14: the deliberately quiet one. It dresses the guard, the
 * barrel and the dust cover, all of which sit UNDER the receiver's channel — §1.4's "large quiet
 * areas between" needs somewhere to actually be quiet.
 *
 * `polyPark` on the polymer at 15, and it is a restraint call rather than a taste one. The polymer
 * group is the biggest single field on this gun (handguard + stock + grip + magwell, 190 mm of
 * drawn z) and the two stamped slots are the only BOLD marks it is allowed. A knurl or a tape
 * wrap across all of that would put small even detail over the whole lower half of the weapon,
 * which §1.4 measures as noise at every size. Parkerised patches at 15 tiles/m are ±8 % blocky
 * variation at 15–30 mm — finish, not pattern.
 *
 * `steelKnurl` at 26 on the charging handle, and it is the whole reason `steel` is not plain: the
 * group contains exactly two parts, and one of them is the thing the player is meant to believe
 * they could grab. A 38 mm tile puts five diamonds across it, i.e. ~7.7 mm each, so the 20 mm
 * paddle carries two or three you could count. §2.5 clause 7, for the price of one map.
 *
 * `plainSteel` on the magazine: it is a flat pale field forward of the fist and it is the gun's
 * second-strongest silhouette cue after the rail. The strongest thing that can happen to it is
 * nothing.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const SKIN: WeaponSkin = {
  frame: { mat: 'framePark', uv: 14 },
  slide: { mat: 'frameVent', uv: 12 },
  polymer: { mat: 'polyPark', uv: 15 },
  steel: { mat: 'steelKnurl', uv: 26 },
  magazine: plainSteel,
};

export const REDLINE: WeaponModelDef = { profile: PROFILE, fields: FIELDS, skin: SKIN };

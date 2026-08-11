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
 * ─── WHAT THE PLAYTESTER SAID, AND WHAT IT COST ──────────────────────────────────────────
 * "the longshot has this sights or grey things on top too long, i would remove those and
 * remake that part" — and separately, of the whole arsenal, "we need more differentiator
 * colours, still look the same overall".
 *
 * Both are read literally below. The top of this receiver is the ONE edge the player looks at
 * 100% of the session, and it was carrying a 120 mm warm rib running nose-to-tail plus three
 * pale blades standing in mid-air above it — a long horizontal bar, exactly the read they
 * flagged. The sight rail teeth and the sight ears were already deleted for the same reason
 * and are NOT coming back; what was left behind was the worst of both worlds, because the
 * blades' only support went with them.
 *
 * ─── THE SIGHT, REMADE: TWO EVENTS AND A LOT OF NOTHING BETWEEN THEM ─────────────────────
 * The new assembly is TALL and SHORT, where the old one was low and long:
 *
 *   REAR   a raised aperture BLOCK — two 46 mm towers either side of a 20 mm notch, 12 mm
 *          deep, bottoms buried 2 mm into the receiver's top face. It is one compact mass
 *          seen from anywhere but dead astern, and it is the tallest thing on the gun.
 *   FRONT  a SINGLE 11 mm post, 46 mm tall, 12 mm deep, standing on a warm 30 mm base.
 *   BETWEEN THEM  148 mm of bare receiver with NOTHING on it. That gap is the point: it is
 *          what stops the top edge reading as one bar, and it is why the rib had to be cut
 *          from 120 mm to 30 mm (see `rib`).
 *
 * NOTHING FLOATS ANY MORE, WHICH IS THE BUG UNDER THE COMPLAINT. The blades used to top out
 * at 0.098 with bottoms at 0.064–0.068 over a receiver top face of 0.054 — nine to thirteen
 * millimetres of daylight under three slabs, and the rear pair also stood at x ±0.024 on a
 * receiver only ±0.013 wide, i.e. outboard of their own host as well as above it. Both blade
 * heights now run the full 46 mm from the sight line DOWN INTO the receiver, and the notch is
 * tight enough (`notchHalfGap` 0.012 → 0.010) that the towers' outer faces come in to ±0.021.
 * The assembly is smaller in every direction that was wrong and bigger only in the one that
 * was right.
 *
 * ─── THE AIM SOLVE IS BYTE-IDENTICAL, DELIBERATELY ───────────────────────────────────────
 * `aimSocketOf()` reads exactly two numbers: `sight.lineY` and `sight.rearZ`. Neither moved.
 * The socket, `adsOffsetOf()` and the ADS translation are therefore the same numbers this gun
 * shipped with, and the boot assertion still reports the socket dead on the camera axis. The
 * builder places the front blade at `lineY - frontH/2` and the rear pair at `lineY - rearH/2`,
 * so both tops land on the sight line BY CONSTRUCTION — `rearH` and `frontH` are both 0.046
 * here, but even if they were not, the tops could not drift apart.
 *
 * Everything else in the sight block is PICTURE, not solve, and the picture is measured rather
 * than hoped for: the notch's ±0.010 window projects to ±0.0132 at the front plane against a
 * 5.5 mm post half-width, so there are 7.6 mm of light bar per side — 0.0248 rad, within 2 % of
 * the pistol reference picture the whole sight contract was solved against. See `sight`.
 *
 * ─── THE SILHOUETTE, AND WHY IT IS STILL FIVE EVENTS ─────────────────────────────────────
 * stock → receiver under a tall rear block → bare top → tall front post on a warm base →
 * hard step down → bare fluted barrel → the can. Plus a bolt handle out to the right and a
 * bipod stub under the handguard, which are the two events on the OUTLINE — the one kind of
 * detail the ink line cannot erase, because the ink line *is* the outline.
 *
 * ─── CLEARANCE: NOTHING MOVED OUTWARD, IN EITHER BUDGETED DIRECTION ──────────────────────
 * The model's worst vertices are the ones this profile does not touch: `muzzle.fin3` at 0.3941
 * reach / 0.4146 swayed, the magazine floorplate at reload (0.3792 / 0.4087), the forearm at
 * the near plane (0.0893 at sprint). Every edit below is inward, backward or vertical:
 *
 *   front post   z −0.132 → −0.128 (4 mm BACK), width 12 → 11 mm, depth 13 → 12 mm
 *   rear towers  outer x ±0.024 → ±0.021 (3 mm IN per side), depth 13 → 12 mm
 *   both blades  +12 to +16 mm of HEIGHT, which is not a term in either metric
 *   rib          120 → 30 mm long, and now strictly inside the receiver's own x/z footprint
 *                (|x| ≤ 0.007 < 0.013, front face −0.143 > the receiver nose at −0.146), so it
 *                cannot be a worst vertex while the receiver corner above it exists
 *
 * Reach is `hypot(|x| + sway, z)` and the near plane is a depth: neither reads y at all, so
 * 46 mm blades are free. No forward-most (−z) or right-most (+x) vertex on this model moved.
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
     * `lineY` and `rearZ` ARE THE AIM SOLVE. Untouched — see the header note.
     *
     * `rearH` 0.030 → 0.046 and `frontH` 0.034 → 0.046 are the whole remake. The receiver's
     * top face is 0.054 and the line is 0.098, so 0.044 is exactly the height that closes the
     * daylight; at 0.046 both blades bury their bottom 2 mm INSIDE the receiver and there is
     * no gap left to see at any angle. This is presence bought with HEIGHT instead of length,
     * which is the one axis neither spatial budget measures.
     *
     * `bladeD` 0.013 → 0.012 and `bladeW` 0.012 → 0.011 shorten the assembly fore-and-aft and
     * narrow it, both still clear of the 0.010 ink floor. `frontZ` −0.132 → −0.128 pulls the
     * post BACK, which puts 12 mm of receiver ahead of it (it reads mounted rather than
     * cantilevered off the nose) and buys reach margin rather than spending it.
     *
     * `notchHalfGap` 0.012 → 0.010 brings the rear towers' outer faces in from ±0.024 to
     * ±0.021 — 8 mm proud of a ±0.013 receiver instead of 11 mm, i.e. an aperture housing
     * overhanging its base, which is what a rear sight block looks like, rather than two slabs
     * hanging outboard of their own host in space.
     *
     * WHAT THAT COSTS THE PICTURE, MEASURED RATHER THAN WAVED THROUGH. The 148 mm sight
     * radius, compressed by 0.50, puts the notch 0.235 m from the eye and the post 0.309 m, so
     * the ±0.010 window projects to ±0.0132 at the front plane; against a 5.5 mm post
     * half-width that is a 7.6 mm light bar per side, or 0.0248 rad. The old geometry gave
     * 0.0314 rad, so the bars ARE narrower — deliberately, and they land within 2 % of the
     * pistol's 0.0253, which is the reference picture this whole sight contract was solved
     * against. A tighter notch on a marksman rifle is what a marksman rifle has; what it must
     * not be is CLOSED, and 0.0248 rad is ~13 px of albedo at the 56° ADS FOV before the
     * sights' thinner `view.sightOutlinePx` hull takes its few pixels a side.
     */
    lineY: 0.098, rearZ: 0.020, frontZ: -0.128,
    bladeW: 0.011, rearH: 0.046, frontH: 0.046, bladeD: 0.012, notchHalfGap: 0.010,
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
   * THE WARM RIB, CUT FROM 120 mm TO 30 mm — and this is half of the "grey bar on top" fix.
   *
   * It used to run z −0.126…−0.006, i.e. nose-to-tail down the middle of the top face, which
   * is precisely the long horizontal mark the playtester asked to have removed. What is left
   * is a 30 × 14 mm BLOCK sitting directly under the front post: 5 mm proud of the receiver's
   * top face, 9 mm of it buried inside, and 30 mm long against the post's 12 — so the post
   * grows out of a base instead of standing on a flat plate, and the base is the one WARM mark
   * on the forward half of the gun (every other RUST mark — grip tape, hammer spur, the shell
   * in the port — is behind the hand).
   *
   * IT CANNOT OCCLUDE THE SIGHT PICTURE, and the check is the one that killed the old rib.
   * Anything on top of the receiver runs FORWARD of the rear notch and is therefore NEARER the
   * eye than the post at every ray below the line — but this block is AT the post's own z
   * (both centred on −0.128), so it is not in front of the post, it IS the post's base. Its
   * top at 0.059 is also 39 mm under `lineY`, four times the 10 mm clearance
   * `guardSightLine()` asks of anything up there.
   *
   * AND IT COSTS NO CLEARANCE. |x| ≤ 0.007 against the receiver's ±0.013 and its front face is
   * −0.143 against the receiver's nose at −0.146 — strictly inside the host's own x/z
   * footprint, so the receiver's corner vertex ranks above it in reach at every pose.
   */
  rib: { w: 0.014, h: 0.014, d: 0.030, y: 0.052, z: -0.128 },

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
   * the pale bar the playtester asked to have removed, and the remake above replaces the one
   * structural job the teeth were doing (holding the blades up) with blade height, which is
   * free in both budgets where a rail is not. Do not re-add them.
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
 * (0.78) and every field is under the sights' BONE (0.729) — the frame by 0.158, which keeps
 * the front post reading as the brightest thing on the gun, which is its whole job.
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

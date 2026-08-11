/**
 * RATATAT — one weapon, one file: its proportions, its palette and its surfaces.
 *
 * The runtime that consumes this lives in `../viewmodel.ts`; the contract it is written
 * against is in `./types.ts`. Nothing here knows how a box is bevelled or how a material is
 * made — and nothing there knows this weapon exists except through `./index.ts`.
 */

import type { FieldSet, GunProfile, WeaponModelDef, WeaponSkin } from './types';
import { FIELD, plainSteel } from './types';

/**
 * RATATAT — long, low and skeletal. Reads as *fast* before it fires: a slim receiver, a
 * vented shroud, a vertical grip the support hand is obviously clamped onto, and a wire stock
 * that says "this is braced against a shoulder" without adding a solid mass.
 *
 * ─── THE BRIEF: "I LOVED THE SMG" ────────────────────────────────────────────────────────
 * So NOTHING about how it SITS or how big it is has ever moved. `depthCompress`, `restDz`,
 * `receiver`, `serrations`, `barrel`, `muzzle`, `magazine`, `foreEnd` and `stock` are still
 * BUILD 007's numbers to the millimetre, and this pass did not touch one of them either.
 *
 * ─── WHAT THIS PASS CHANGED, AND WHY ─────────────────────────────────────────────────────
 * The playtester, on the whole arsenal: *"the longshot has this sights or grey things on top
 * too long, i would remove those and remake that part in all guns"*, and *"we need more
 * differintiator colours, still look the same overall"*. Three answers, all of them in this
 * file and none of them in the parts they said they liked:
 *
 *   1 · THE SIGHT IS NOW SHORT, LOW AND WIDE-NOTCHED — see the `sight` block. It lost 20 mm
 *       of sight radius, 2 mm off every blade's length, 4 mm of height and gained 6 mm of
 *       notch. A close-range gun gets a fast, open sight; a rifle gets a fine, tall one. The
 *       pale bar on the top edge is now the shortest of the four.
 *   2 · THE OLIVE IS ACTUALLY OLIVE — see `FIELDS`. It was a 0.28-saturation grey that
 *       happened to lean green; it is now a 0.64-saturation olive drab at the frame's proper
 *       0.43 luma, with a pale sage steel above it and a near-black olive polymer below.
 *   3 · THE WARM RIB WAS INVISIBLE AND IS NOW ON THE OUTLINE — see the `rib` block. It was
 *       buried a millimetre *under* the receiver deck, so this gun had no RUST mark on its
 *       top edge at all. That was a bug, not a style choice.
 *
 * ─── WHAT §1 ASKS THIS GUN FOR, AND WHERE EACH ONE LANDED ────────────────────────────────
 *   vented shroud (3 BOLD slots)  → `panels`, three vertical cuts, LOWER LEFT flank, plus the
 *                                   `frameVent` surface on the upper itself
 *   folding-stock hinge           → `selector` repurposed: a pivot boss between the receiver
 *                                   and the two stock rails, with a latch arm swung off it
 *   bold mag well                 → `magWell`, a flared mouth at the butt the stick feeds into
 * plus the "every gun gets" list: an ejection port with brass in it and a charging handle.
 * The top rail's teeth and the front post's ears are deliberately ABSENT: both were pale grey
 * clutter on the one edge the player looks at all session, and both were removed for that
 * reason. Do not re-add them.
 *
 * ─── THE SIDES CARRY DIFFERENT EVENTS, WHICH IS THE §0 ASYMMETRY LEVER ───────────────────
 * The rest pose sits the gun at x +0.125 with the muzzle toed in, so the face the player
 * actually looks at all session is the LEFT one. That is where the parts that are *supposed*
 * to be looked at went — the charging handle, the three stamped cuts and the stock hinge —
 * and the right side takes the ejection port, which is the one detail that reads at ADS and
 * on the outline from above. Left and right are now different guns from every angle.
 *
 *   front-low-left   three bold stamped cuts in the lower's flank   (polymer, static)
 *   mid-left         charging handle standing 20 mm off the receiver (steel, rides slide)
 *   mid-right        ejection port frame + brass in the port         (steel + RUST, slide)
 *   top              a RUST rib running forward INTO the front post   (accent, rides slide)
 *   rear-left        folding-stock pivot boss + latch arm            (polymer, static)
 *   butt             flared magwell mouth the stick feeds through    (polymer, static)
 *
 * Four value fields, none of them geometry: polymer 0.25 · frame 0.43 · steel 0.58 ·
 * BONE 0.73, plus the RUST rib and the brass.
 *
 * ─── WHY THE VENTS ARE ON THE LOWER AND NOT ON THE SHROUD ────────────────────────────────
 * They wanted to be on the receiver's forward third, which IS this gun's barrel shroud. They
 * cannot be: `panels` is POLYMER and polymer is parented to the ROOT, while this gun's whole
 * upper is the reciprocating `slide` mesh. A cut authored on the shroud face would stand
 * still while its host travelled 11 mm back on every one of ~15 rounds a second, and at the
 * front of the group it would end the stroke floating in mid-air ahead of the shroud's nose.
 * The stamped-cut vocabulary is static, so it went on the one mass that is also static: the
 * lower's flank, between the trigger guard and the foregrip, where a pressed-steel SMG puts
 * its lightening cuts anyway. The upper still reads as vented — through the `frameVent`
 * surface map, which is painted, rides the mesh it is painted on, and costs nothing.
 *
 * ─── THE MAGAZINE IS NOT TOUCHED, AND THAT IS A CLEARANCE DECISION ───────────────────────
 * §1 asks for the curve to be emphasised, and the honest answer is that it cannot be
 * lengthened: MEASURED, this gun's binding constraint is the RELOAD pose, whose worst vertex
 * is the magazine floorplate at 0.4170 m swayed against `MOVE.radius` 0.42 — three
 * millimetres. Every millimetre added to `magazine.h` or `.d` is spent straight out of that.
 * What the stick got instead is a MOUTH: the flared well below stops 11 mm short of the
 * floorplate, so the raked body and the plate (which the shared builder kicks 14 mm rearward
 * of it — that offset IS the banana kink) emerge from under the collar as a separate inserted
 * object instead of dying inside the grip. It also got a HARD VALUE BREAK: the magazine wears
 * the pale sage `steel` field against a deep olive frame, so the one silhouette feature this
 * gun is named for is now the lightest mass on the whole weapon.
 */
const PROFILE: GunProfile = {
  id: 'ratatat',
  /**
   * Longest-but-one gun, so the strongest foreshortening after the marksman.
   *
   * 0.54, not 0.60 — MEASURED, twice. At 0.60 rest/reload/equip all read 0.402–0.403 m, and at
   * 0.56 the RELOAD pose alone still did. The budget is 0.40. See the header note.
   *
   * (The headline number in this note read "0.52" for two builds while the value was 0.54; the
   * value is the one that was measured, and RELOAD is still the binding pose at 0.380 reach.)
   */
  depthCompress: 0.54,
  restDz: 0.010,
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * THE SIGHT: SHORT, LOW AND WIDE-NOTCHED — an SMG's sight, not a rifle's.
   *
   * The playtester's complaint was about LENGTH and VALUE: a pale bar lying fore-and-aft along
   * the one edge that is on screen 100% of the session. So every fore-and-aft dimension here
   * came down, and none of the numbers that make the sight *usable* did.
   *
   *   frontZ   −0.138 → −0.118   the post moves 20 mm BACK. Sight radius 152 → 132 mm.
   *   bladeD    0.012 →  0.010   every blade is 2 mm shorter along the gun. That is the ink
   *                              floor exactly, and the sights carry `view.sightOutlinePx`
   *                              (3.5 px), half the silhouette's 7 — so at the floor a sight
   *                              blade has the same albedo headroom a 20 mm part has anywhere
   *                              else on the gun. Nothing here prints black.
   *   lineY     0.074 →  0.070   4 mm lower. The post now stands 13 mm proud of the receiver
   *                              deck (0.057) instead of 17 — still ≈ 21 px of post at ADS,
   *                              which is the number that decides whether the picture works.
   *   frontH    0.024 →  0.020   } both blades shrink by exactly the drop in `lineY`, so the
   *   rearH     0.020 →  0.016   } bases stay where they were, inside the receiver.
   *
   * AND ONE NUMBER WENT UP, WHICH IS THE IDENTITY HALF. `notchHalfGap` 0.010 → 0.013 and
   * `bladeW` 0.011 → 0.013: a WIDE, OPEN notch flanked by two stubby fat posts. That is what a
   * close-range gun's sight is for — the eye finds the front post without hunting — and it is
   * a completely different shape from the marksman's fine tall blade or the shotgun's bead.
   * Wider is also strictly safer under the ink line than narrower: the notch's light bars are
   * 26 mm apart now, where the pistol's 20 mm gap was already the fix for a notch the line was
   * closing.
   *
   * ─── THE AIM SOLVE IS INTACT, BY CONSTRUCTION ──────────────────────────────────────────
   * `rearZ` IS THE SOCKET's z and it has NOT MOVED (0.014), so `aimSocketOf()` returns the
   * same depth it always did and the ADS z-translation is unchanged. `lineY` moved, and that
   * is fine BECAUSE it is the one number both blades are placed from: `buildGunGeometry` puts
   * the front at `lineY − frontH/2` and the rear pair at `lineY − rearH/2`, so both tops land
   * ON `lineY` whatever it is, and the socket is `(0, lineY, rearZ · compress)`. x is 0 and
   * `adsOffsetOf` negates y exactly, so the boot assertion's on-axis probe is 0 to within
   * floating point on both axes. Moving `lineY` moves where the gun sits at ADS; it cannot
   * move where the gun shoots relative to where it looks.
   *
   * ─── CLEARANCE ─────────────────────────────────────────────────────────────────────────
   * Every edit above is neutral or POSITIVE. The post's forward face goes −0.144 → −0.123
   * (21 mm further from the muzzle end, and it was never the worst vertex — the muzzle can's
   * face is at −0.189). The blades' outer x goes ±0.021 → ±0.026, which is still inboard of
   * the ejection-port deflector (±0.031) and the charging handle (−0.037), neither of which is
   * the worst lateral vertex either. Nothing added forward, nothing added outboard.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  sight: {
    lineY: 0.070, rearZ: 0.014, frontZ: -0.118,
    bladeW: 0.013, rearH: 0.016, frontH: 0.020, bladeD: 0.010, notchHalfGap: 0.013,
  },
  receiver: { w: 0.046, h: 0.050, d: 0.184, y: 0.032, z: -0.066 },
  serrations: 5,
  barrel: { r: 0.012, len: 0.078, y: 0.012, z: -0.140 },
  muzzle: { r: 0.015, len: 0.026, z: -0.176, fins: 2, finW: 0.032 },
  /** The long curved stick mag — the single most recognisable thing about an SMG. */
  magazine: { w: 0.022, h: 0.100, d: 0.032, y: -0.072, z: 0.020 },
  tube: null,
  /** Vertical foregrip. The support hand read. */
  foreEnd: { w: 0.042, h: 0.056, d: 0.030, y: -0.020, z: -0.132, ribs: 3 },
  stock: { w: 0.038, h: 0.040, d: 0.086, y: 0.020, z: 0.074, skeleton: true },
  /**
   * THE WARM RIB — AND IT WAS INVISIBLE, WHICH IS WHY IT MOVED.
   *
   * MEASURED off the two numbers themselves: the receiver is `y 0.032, h 0.050`, so its deck
   * is at 0.057, and the rib was `y 0.0505, h 0.011` — a top of 0.056. The gun's single RUST
   * accent, the one thing ART §1 asks for so the weapon never reads as a plumbing fixture, was
   * sitting ONE MILLIMETRE BELOW the surface it was supposed to be a stripe on. Fully enclosed
   * by its own host. This gun has been shipping with no warm mark on its top edge at all.
   *
   * Now `y 0.0525, h 0.011` → a top of 0.058: 1 mm proud of the deck, which is all a colour
   * field needs (its 17 mm-wide top face is what reads, not its edge), and 12 mm BELOW the
   * 0.070 sight line — clearing the builder's `guardSightLine` ceiling of `lineY − 0.010` with
   * 2 mm to spare. That ceiling is the generalised form of the pistol's rib bug, where a rib
   * at 0.0555 occluded all but 16 px of a 38 px front post.
   *
   * IT IS ALSO SHORTER, AND THAT IS THE SIGHT PICTURE AGAIN. At `d 0.130` it ran to z −0.131,
   * i.e. 13 mm PAST the new front post — a warm stripe crossing the pale blade the player aims
   * with. At `d 0.107, z −0.0545` it spans −0.108 → −0.001: it starts 10 mm ahead of the rear
   * notch and DIES 10 mm behind the front post, so it is a warm line that leads the eye up to
   * the post and stops. Both faces moved BACKWARD (+z), so this is clearance-positive.
   *
   * And it is 17 mm wide rather than 13. The rib's own inverted hull eats ~7 px off each side
   * of whatever width it is authored at; at 13 mm that left about 8 px of RUST core on screen,
   * at 17 mm it leaves ~12. Width is free here — occlusion of the front post is a function of
   * HEIGHT only, and the deck it sits on is 46 mm wide, so 17 still leaves 14 mm of olive
   * either side of it.
   */
  rib: { w: 0.017, h: 0.011, d: 0.107, y: 0.0525, z: -0.0545 },

  /**
   * THE EJECTION PORT, AND IT IS FORWARD OF THE SERRATIONS ON PURPOSE.
   *
   * The five cocking serrations are `receiver.w + 0.002` wide — 1 mm proud of the side face —
   * and they run from z 0.016 back to −0.057 in the y band 0.018–0.046, which is exactly the
   * band a port lives in. A port dropped on top of them would interleave a continuous 5 mm
   * proud frame with a stack of 1 mm proud teeth and both reads would be lost. At z −0.092 the
   * deflector's rear face is −0.074, five millimetres clear of the last tooth, which also puts
   * the port where an SMG actually has one: mid-receiver, above the trigger.
   *
   * SIZED BY THE RECEIVER'S SIDE FACE, NOT BY EYE. At y 0.032 / h 0.020 the top lip's top
   * lands on 0.052 and the shelf's bottom on 0.012, so the frame fills the face with a few
   * millimetres of receiver showing above and below. The lip stops under the 0.057 deck, so
   * nothing here climbs onto the rail and starts eating the sight picture from below — the rib
   * already owns that ceiling and is measured against it above.
   *
   * The brass is the warm mark that is NOT on the outline: r 0.006 is 12 mm of round in a
   * 20 mm window, a comic-fat case rather than a rim.
   */
  ejectionPort: { h: 0.020, d: 0.036, y: 0.032, z: -0.092, shellR: 0.006 },
  /**
   * THE CHARGING HANDLE, ON THE LEFT — which is both what an SMG does and where the player
   * is looking. It is the biggest silhouette event on this gun that is not the magazine.
   *
   * Clear of the serrations (rear face −0.076 against their −0.057), so the two steel reads
   * never merge into one smear. At y 0.042 the paddle spans 0.030–0.054 and tops out just
   * under the receiver's deck: it breaks the upper outline without standing over it, and it
   * ends in the builder's HOOK rather than a taper, because a hook survives the ink line.
   *
   * It stands 20 mm off a face that is 23 mm from centre, so the paddle's far edge is at
   * x −0.045 — and the rest pose puts the whole gun at x +0.125, so that edge is the vertex
   * NEAREST screen centre on this side. `assertClearance` measures `hypot(|x| + sway, z)` on
   * the composed vertex, and −x here subtracts from a +x pose: it costs the reach budget
   * nothing at all. This is why the biggest event on the gun is allowed to be this big.
   */
  chargingHandle: { side: 'left', len: 0.020, thick: 0.012, y: 0.042, z: -0.070 },
  /**
   * THE FOLDING-STOCK HINGE, built out of the `selector` slot. A round boss with a bar swung
   * off it IS a hinge pivot and a latch, and this gun's fire-selector real estate is already
   * spent on the charging handle 30 mm forward of it.
   *
   * IT IS PLACED TO BRIDGE TWO MASSES, WHICH IS WHAT MAKES IT READ AS A MECHANISM RATHER THAN
   * A BUTTON. The receiver's rear face is at z 0.026 and the skeleton stock's two rails start
   * at 0.031; the boss is 16 mm across at z 0.030, so it overlaps both and sits in the 12 mm
   * gap between the rails (their inner faces are y 0.0276 and 0.0124). The arm then sweeps
   * 18° down and back to (y 0.010, z 0.060), under the lower rail, where a folding stock's
   * catch goes. Polymer and static — the stock it belongs to is static too.
   */
  selector: { r: 0.008, len: 0.032, thick: 0.012, y: 0.020, z: 0.030, angleDeg: -18 },
  /**
   * THE MAGWELL MOUTH. This gun feeds through its grip, so the only honest place for a well is
   * the BUTT — and that is also the only place the stick is visible, so it is where the part
   * does the most work.
   *
   * THE HEIGHT IS SET BY THE FLOORPLATE, NOT BY THE FIST. Raked at `MAG_RAKE` the collar's
   * rear-bottom corner lands at y −0.126, while the magazine's floorplate corner is at −0.137:
   * eleven millimetres of magazine emerges from under the mouth, so the mag reads as INSERTED
   * and the reload drops it out through a funnel that stays put. Any lower and the collar
   * swallows the plate whole and the whole point of the part is gone; any higher and the
   * 62 mm fist hides it.
   */
  magWell: { w: 0.034, h: 0.018, d: 0.042, y: -0.104, z: 0.026, flare: 0.006 },
  /**
   * THREE BOLD STAMPED CUTS, LEFT ONLY, IN THE LOWER'S FLANK — §1's vent group, on the mass
   * that can actually carry it (see the header note about the reciprocating shroud).
   *
   * They are SLOTS, not dots: 16 mm tall against 14 mm long, in the frame body's 30 mm face
   * (y −0.019 to 0.011), so they sit fully above the trigger guard's 0.019 top and fully
   * inside the host. Pitch 24 mm against a 14 mm cut leaves a 10 mm land between them — the
   * gap has to survive the ink line as well as the cut does, which is the lesson the cocking
   * serrations learned at a 6 mm pitch. Three, and the group ends where the frame does.
   */
  panels: {
    count: 3, side: 'left', h: 0.016, d: 0.014,
    y: -0.008, z: -0.046, step: 0.024, hostHalfW: 0.014,
  },
};

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════
 * OLIVE DRAB — the only green in the arsenal, and now actually green.
 *
 * The playtester: *"we need more differintiator colours, still look the same overall"*, and
 * they were right about this gun specifically. MEASURED, the shipped fields were
 * `frame 0x5c6247` (luma 0.372, HSV saturation 0.28, hue 73°) and `steel` mixed to a
 * 0.05-saturation grey. That is not an olive gun; that is a grey gun with a faint green cast,
 * which at a glance is a grey gun. The four palettes were "too close together" because three
 * of them were barely chromatic at all.
 *
 * The three fields below, measured the same way (luma = 0.2126 R + 0.7152 G + 0.0722 B on the
 * sRGB-encoded values, which is the number `ART_DIRECTION §1`'s ladder is quoted in):
 *
 *   field    hex        luma    sat    hue    was
 *   polymer  #35461C    0.248   0.60    84°   0.218 / 0.24 / 78°   grip · stock · cuts · well
 *   frame    #5E7A2C    0.433   0.64    82°   0.372 / 0.28 / 73°   receiver · slide · barrel
 *   steel    #8B9A63    0.576   0.36    76°   0.500 / 0.05 / 90°   mag · charging handle · port
 *
 * Saturation more than doubles on every field and the ladder lands on `types.ts`'s intended
 * 0.29 / 0.44 / 0.57 for the first time. The frame is now the most saturated receiver in the
 * arsenal (against 0.50 blue-teal on the pistol, 0.47 tan on the marksman and 0.22 red-brown
 * on the shotgun) and the only one anywhere near the green half of the wheel — the other three
 * sit at hues 205°, 28° and 3°, so this one is 54° from its nearest neighbour.
 *
 * ─── ART §9 IS OBEYED, AND HERE IS THE ARITHMETIC RATHER THAN THE ASSERTION ───────────────
 * `ACID` (0x8cff3e) is luma 0.79, saturation 0.76, hue 96°. This frame is luma 0.433 —
 * a FULL VALUE BAND below it, below `READABILITY.ENV_VALUE_CEIL` 0.78, and below the sights'
 * `BONE` 0.73 that shares the same object. The lightest field here, the steel at 0.576, is
 * still 0.15 under BONE and 0.21 under ACID. Nothing on this weapon can be mistaken for a
 * zombie at a tenth of a second, which is the actual test §9 sets: enemies own the top of the
 * value ladder and the neon, and the gun stays in the mid band where the environment lives.
 * `HOT` and `GOLD` do not appear: the one warm mark is `RUST`, on the rib and the brass, and
 * `GOLD` shows only as the muzzle core, which is the reserved use.
 *
 * The hue *family* is shared with ACID and always was — there is one green in a fifteen-token
 * palette. What separates them is what separates olive drab from a highlighter in real life:
 * half the value and half the chroma.
 * ═════════════════════════════════════════════════════════════════════════════════════════
 */
const FIELDS: FieldSet = {
  /** Olive drab. The receiver, the slide, the barrel and the guard — the largest mass. */
  frame: 0x5e7a2c,
  /** Near-black olive. Grip, fore-end, stock, magwell, stamped cuts, trigger, hinge. */
  polymer: 0x35461c,
  /** Pale sage — painted metal, not bare. The magazine, the charging handle, the port frame. */
  steel: 0x8b9a63,
  wood: FIELD.wood,
};

// Scrappy: paint knocked off the lower in blocks, a vented upper, a knurled grip. Three
// different marks on three adjacent masses is what makes it read as fast and used — and all
// three generators are handed this gun's own base colour, so the marks are encoded against
// olive rather than against the grey the fields used to be.
const SKIN: WeaponSkin = {
  frame: { mat: 'frameChip', uv: 12 },
  slide: { mat: 'frameVent', uv: 13 },
  polymer: { mat: 'polyKnurl', uv: 20 },
  // Plain and light: the stick mag is this gun's signature silhouette, and the strongest thing
  // that can happen to it is a flat pale field with nothing competing on it.
  steel: plainSteel,
  magazine: plainSteel,
};

export const RATATAT: WeaponModelDef = { profile: PROFILE, fields: FIELDS, skin: SKIN };

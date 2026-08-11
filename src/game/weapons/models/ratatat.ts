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
 *   1 · THE SIGHT IS TWO MACHINED SLABS SUNK INTO THE RECEIVER — see the `sight` block. The
 *       complaint that has now been filed FIVE times ("gray lines on top" · "sights too long"
 *       · "3 grey thing on top" · "sticks like showing out" · "remove and remake") was never
 *       about the blades' shape, and four passes that reshaped them all missed. It was about
 *       masses whose FOOTPRINT was smaller than their HEIGHT — the silhouette of a mast. The
 *       fix is aspect ratio, not styling: every sight mass is now 26 mm deep against 11 mm
 *       proud. All of the arithmetic is in the `sight` block and the second half of the `rib`
 *       block; read both before touching either.
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
 *   top              a RUST rail running INTO the front post's base   (accent, rides slide)
 *   rear-left        folding-stock pivot boss + latch arm            (polymer, static)
 *   butt             flared magwell mouth the stick feeds through    (polymer, static)
 *
 * Four value fields, none of them geometry: polymer 0.25 · frame 0.43 · steel 0.58, plus the
 * RUST rail and the brass — and the sights, which are DARK IRON (flat 0.188), not BONE. They
 * were pale once; a pale mass on the top edge is the single thing the playtester has objected
 * to most, and it is not coming back.
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
   * THE SIGHT: TWO SLABS SUNK INTO THE RECEIVER. NOTHING HERE STANDS ON A NECK.
   *
   * ─── WHAT WAS ACTUALLY WRONG, AFTER FIVE REPORTS AND FOUR FAILED PASSES ────────────────
   * "gray lines on top" → "sights too long" → "3 grey thing on top" → "sticks like showing
   * out" → "remove and remake a better sight, that design looks bad and not competitive at
   * all". Four passes answered by RESHAPING the blades: shorter, darker, thinner, wings
   * deleted, rail teeth deleted, `bladeD` tripled to get them over the ink floor after the
   * `depthCompress` z-scale. None of it landed, because none of it changed the property being
   * objected to. Rendered with the ink pass switched off, the sights were BLOCKS STANDING ON
   * STALKS — masses whose footprint on the deck was smaller than the height they stood at.
   * That is the silhouette of a mast, and no amount of restyling a mast stops it being one.
   *
   * So this pass does not restyle anything. It changes the ASPECT RATIO, which is the one
   * property that decides whether a mass reads as machined-in or as stuck-on:
   *
   *                    BUILD 011                    now
   *     front post     15 w × 14 d × 13 proud       15 w × 26 d × 11 proud
   *     rear, each     15 w × 14 d × 13 proud       15 w × 26 d × 11 proud
   *
   * (`d` quoted POST-COMPRESSION. `bladeD` is authored and then z-scaled by `depthCompress`
   * 0.54 on the way out of the builder — the arithmetic BUILD 011 found and the three before
   * it missed. 0.048 × 0.54 = 25.9 mm of real gun.)
   *
   * A 14 × 13 box seen from the side is a square lump PERCHED on a deck. A 26 × 11 box seen
   * from the side is a SLAB, 2.4× as long as it is tall, and the eye reads it as part of the
   * surface it sits on. Depth is the only axis where this gun's sights could gain mass for
   * free — the muzzle can is 32 mm further forward and owns the reach vertex — and in five
   * builds nobody had spent it.
   *
   * ─── AND THE MASSES ARE SUNK, NOT SET DOWN. NO DAYLIGHT ANYWHERE UNDER THEM ────────────
   * `lineY` 0.070 → 0.068. The receiver deck is y 0.057 (`receiver.y` 0.032 + `h`/2), so the
   * proud height goes 13 → 11 mm. **That is the floor for this receiver, not a preference:**
   * the RUST rib tops out at 0.058 and `guardSightLine` forbids anything on the deck coming
   * within 10 mm of the line, so `lineY` cannot go below 0.068 without burying the gun's only
   * warm mark under its own deck again (which is the bug the `rib` block below exists to
   * record). 11 mm is the shortest sight in the arsenal, which is the right answer for a
   * 15-rounds-a-second close-range gun.
   *
   *   rearH  0.020 (unchanged) → base y 0.048. NOT arbitrary: the cocking serrations top out
   *     at 0.0483 (`receiver.h` × 0.65 about `receiver.y`) and reach x ±0.024, so the rear
   *     block's outboard skirt lands 0.3 mm INTO them and is supported along its whole width.
   *     Lower would saw the serration stack in half; higher would leave a 1–2 mm slot, and a
   *     1–2 mm slot is far under the ink floor — it would print as a black seam, not a
   *     shadow. Clamped down onto the receiver with nothing visible under it is exactly what
   *     a dovetailed sight block looks like.
   *   frontH 0.024 → 0.030 → base y 0.038, 19 mm inside the receiver. The front block is
   *     15 mm wide against a 46 mm receiver so it has no skirt to land, and nothing stops it
   *     being buried to the hilt. Its hull skirt is entirely inside its host.
   *
   * ─── THE NOTCH IS THE HOLE IN THE BLOCK, AND IT GOT WIDER, NOT NARROWER ────────────────
   * The rear is ONE mass 58 mm wide × 26 mm deep × 11 mm proud with a 28 mm square bite taken
   * out of the middle of it, down to the deck. The wall either side of that bite is `bladeW`
   * 15 mm — 1.5× the 10 mm ink floor, and this is the part of the job most likely to go wrong
   * (a modest hole in a big block survives the line; a big hole in a thin ring does not).
   *
   * `notchHalfGap` 0.013 → 0.014 is a COMPENSATION, not a flourish. A deeper block puts its
   * own front corner 12 mm nearer the eye, which shrinks the window, and puts the post's rear
   * face 22 mm nearer, which fattens the post. Measured at `adsSightDistance` 0.235 m, 56°
   * ADS, 821 px vertical (0.00119 rad/px):
   *
   *                            light bar, each side    post on screen
   *     BUILD 011              28.7 mrad ≈ 24.1 px     42.1 px wide
   *     this, at gap 0.013     25.7 mrad ≈ 21.6 px     44.9 px
   *     this, at gap 0.014     29.8 mrad ≈ 25.0 px     44.9 px
   *
   * — so the picture is fractionally MORE open than the one it replaces while the post is 3 px
   * fatter and 33 px tall. The binding pair is the notch's FRONT corner (z 0.003 − 0.024 =
   * −0.021, 0.2480 m from the eye) against the post's REAR face (−0.083, 0.2814 m). The light
   * bars survive both hulls at `sightOutlinePx` 3.5: ≈ 18 px of daylight either side of the
   * post, against ≈ 17 px before. Nothing about this closes the sight picture.
   *
   * ─── THE AIM SOLVE: `lineY` AND `rearZ` BOTH MOVED, AND IT RE-SOLVES ───────────────────
   * `aimSocketOf()` reads exactly `(0, lineY, rearZ · depthCompress)` and `adsOffsetOf()`
   * negates it, so the boot on-axis probe is satisfied BY CONSTRUCTION for any values: x is 0
   * because the rear pair is symmetric about x = 0, and y cancels because `adsOffsetOf`
   * negates `lineY` exactly. The probe only tests x and y; z is free, and the solve simply
   * re-derives.
   *
   *   lineY  0.070 → 0.068  socket 6.5 mm lower. ADS is re-solved to match.
   *   rearZ  0.014 → 0.003  the notch's CENTRE follows the block. The rear face stays at
   *                         0.027 — 1 mm proud of the receiver's 0.026, exactly where it
   *                         already was, deliberately NOT coplanar with it — and the block
   *                         grows forward onto the deck, so nothing hangs off the back.
   *
   * The two tops staying coincident on the line is structural, not maintained by hand:
   * `buildGunGeometry` places the front at `lineY − frontH/2` and each rear blade at
   * `lineY − rearH/2`, so both tops land ON `lineY` for any `frontH`/`rearH`. Growing a blade
   * downward — the only thing `rearH`/`frontH` do — cannot move the sight line.
   *
   * ─── CLEARANCE: BOUGHT, NOT SPENT ──────────────────────────────────────────────────────
   * Latest worst case for this gun is 0.374 reach / 0.080 near against 0.40 / 0.42 / 0.07.
   *   FORWARD (the expensive one). ZERO SPENT, to the millimetre. `frontZ` −0.118 → −0.107
   *     and `bladeD` 0.026 → 0.048 are chosen together so the post's FRONT face stays exactly
   *     at −0.131 authored (−0.0707 real); all 22 mm of new depth grows REARWARD onto the
   *     deck, to a rear face of −0.083. The muzzle can's face at −0.189 authored / −0.102
   *     real is still the reach vertex, 32 mm ahead.
   *   LATERAL. Blade outer x ±0.028 → ±0.029. Still 2 mm inboard of the ejection-port
   *     deflector at ±0.031, which is the existing lateral vertex on the +x side, so the
   *     measured number does not move at all.
   *   HEIGHT. 2 mm lower. Free on the budgets, and it is the axis the playtester is looking
   *     at all session.
   *   THE ADS POSE. `socket.z` 0.00756 → 0.00162, so `adsOffsetOf` puts the root 5.9 mm
   *     nearer the eye at ADS. That is 6 mm of reach BOUGHT on that pose, and 6 mm off an ADS
   *     near depth of ~0.173 m — the ADS pose is 100 mm clear of the 0.07 near budget, and
   *     rest/reload are what bind both budgets on this gun.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  sight: {
    lineY: 0.068, rearZ: 0.003, frontZ: -0.107,
    bladeW: 0.015, rearH: 0.020, frontH: 0.030, bladeD: 0.048, notchHalfGap: 0.014,
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
   * field needs (its 17 mm-wide top face is what reads, not its edge), and 10 mm BELOW the
   * sight line — landing EXACTLY on the builder's `guardSightLine` ceiling of `lineY − 0.010`.
   * That ceiling is the generalised form of the pistol's rib bug, where a rib at 0.0555
   * occluded all but 16 px of a 38 px front post.
   *
   * **THIS IS THE NUMBER THAT PINS `sight.lineY` AT 0.068 AND NOT LOWER.** The deck is 0.057,
   * a visible rib therefore tops out at 0.058, and the ceiling is `lineY − 0.010`. Any lower
   * sight line re-buries the gun's only warm mark. See the `sight` block.
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
   *
   * ─── AND NOW IT IS THE SIGHT RAIL, WHICH IS THE HALF OF THE SIGHT FIX THAT IS NOT GEOMETRY
   * A front post standing alone on a flat deck reads as glued on however chunky it is. The
   * cheapest housing available is a rail the post GROWS OUT OF, and this gun already had one
   * running down the middle of the deck between the two sights — it just stopped 10 mm short at
   * each end, so all three blades had daylight under them.
   *
   * `d 0.107 → 0.118` and `z −0.0545 → −0.0575` close both gaps and nothing else: the rib
   * spans z −0.1165 → +0.0015. **AND THE SIGHT SLABS GREW TO MEET IT FROM BOTH ENDS**, so the
   * overlap is now enormous rather than marginal: against the front block's −0.131 → −0.083
   * and the rear block's −0.021 → +0.027, the rail runs 33.5 mm into the post's base and
   * 22.5 mm into the rear block's, and the only stretch of it standing in the open is the
   * 62 mm of deck between the two — which is precisely the sight radius, drawn as a warm line.
   * The rail, the post and the notched block are one continuous machined feature.
   *
   * It also floors the notch: the rib is 17 mm wide inside a 28 mm notch, so at ADS the bottom
   * of the sight window is a RUST strip with 5.5 mm of olive either side of it. That is 10 mm
   * below the line the player actually reads, and it costs the picture nothing (below).
   *
   * `w`, `h`, `y` and `d` are all untouched by the sight pass — the rail did not have to move
   * a millimetre for any of this, because the sights came to it.
   *
   * **THE CROSS-SECTION IS DELIBERATELY UNTOUCHED — `w` and `h` and `y` are to the millimetre
   * what they were.** RUST is 0xf4761b, luma 0.54, and it sits on the one edge the playtester
   * keeps objecting to; widening or raising it to make a beefier rail would trade "grey sticks
   * on top" for "orange slab on top". What the rail gains is 11 mm of LENGTH, and every
   * millimetre of that is inside the front post (17 mm rib against a 15 mm post — 1 mm of rib
   * shows either side of it), so the extra warm area visible on the top edge is ~0.
   *
   * OCCLUSION IS STILL A NON-EVENT, and it is the only thing any of this could have broken.
   * The rib's front end is now buried 33.5 mm inside the front block, so the binding ray is
   * the one grazing where the rail EXITS that block — z −0.083, y 0.058, 0.2814 m from an eye
   * sitting on the line at y 0.068. It clears the post from 0.058 up: 10 mm of an 11 mm proud
   * post, ≈ 30 px at ADS. A shadow line set by a height cannot be moved by a length.
   */
  rib: { w: 0.017, h: 0.011, d: 0.118, y: 0.0525, z: -0.0575 },

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
 * ═══ THE OLIVE IS GONE, AND WHY ═══
 *
 * This block used to argue that sharing ACID's hue family was safe because "what separates them
 * is what separates olive drab from a highlighter: half the value and half the chroma". That was
 * TRUE WHEN IT WAS WRITTEN and false about an hour later, because a different agent — working in
 * a different file, correctly, to its own brief — raised the grade's saturation 1.28 → 1.55 and
 * its contrast 1.12 → 1.32 as part of the "be louder" pivot. Half the chroma times 1.55 is not
 * half the chroma. Measured on the frame afterwards, the SMG and the zombies read as the same
 * lime, and the gun sat 14° off ACID's 96° hue.
 *
 * Two individually-correct decisions, broken only in combination — the same failure shape as the
 * depth-prepass-versus-skinned-material bug in this project's history. The lesson recorded here
 * for whoever tunes next: A WEAPON MAY NOT DEFEND A RESERVED HUE WITH CHROMA ALONE, because
 * chroma is a global the grade owns and the weapon does not.
 *
 * So the SMG leaves green entirely. It is now the ARSENAL'S NEUTRAL: worn gunmetal, near-hueless,
 * and it differentiates by being the only DESATURATED gun against three saturated ones — a
 * separation the grade cannot collapse, because multiplying a near-zero chroma keeps it near
 * zero. Its identity now rides its chipped paint, its vented shroud and its RUST accent, which
 * is a better fit for "scrappy and used" than a colour ever was.
 * ═════════════════════════════════════════════════════════════════════════════════════════
 */
const FIELDS: FieldSet = {
  /** Worn gunmetal. The receiver, the slide, the barrel and the guard — the largest mass. */
  frame: 0x5a5c60,
  /** Near-black graphite. Grip, fore-end, stock, magwell, stamped cuts, trigger, hinge. */
  polymer: 0x2e3033,
  /** Pale scuffed steel — painted metal, not bare. Magazine, charging handle, port frame. */
  steel: 0x8e9095,
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

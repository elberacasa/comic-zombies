/**
 * THE VIEWMODEL — the object that is on screen 100% of the time.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  TWO CONTRACTS, AND THEY PULL IN OPPOSITE DIRECTIONS.
 *
 *  A. IT MUST BE ALIVE. M2 §1: layered, code-driven animation — sway, walk bob, recoil kick,
 *     ADS blend, reload routine — all summed, nothing baked, nothing easing linearly (ART §8).
 *
 *  B. IT MUST BE ABLE TO BE COMPLETELY DEAD. ART §4.1: with the camera parked the image is
 *     FROZEN, measured at <0.5% of pixels changed between frames. This object covers a measured
 *     6.5% of the frame at rest (12.9% of the width, half the height, grip running off the
 *     bottom edge) — thirteen times the entire budget. A viewmodel with a free-running idle
 *     oscillator therefore fails that test *on its own*, no matter what the rest of the renderer
 *     does. The playtester has already reported this class of bug once ("every pixel jumping
 *     like glitching"), and the gun is the one object that is on screen for every frame of it.
 *
 *     MEASURED: 400 idle frames with zero input produce ONE changed transform (the first, which
 *     establishes the baseline) and 399 bit-identical ones. After a shot it takes 40 frames
 *     (0.67 s) to come back to a dead stop.
 *
 *  The resolution is that EVERY layer in this file is driven by something the player is doing,
 *  and every layer snaps to an exact rest value when that something stops (`settle()`). There is
 *  no breathing sine. `WEAPON.view.breathAmp` exists, is 0, and says why in the tuning file.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE WALK BOB'S SIGN IS A COMFORT DECISION (ART §10 / M2 §1: "opposed to the camera bob, never
 * in phase"). It is derived in full in the tuning file next to `view.bobPhaseSign`; the short
 * version is that the viewmodel is rigidly parented to the camera, so a camera translation moves
 * it not at all *on screen* — which means a viewmodel offset with the SAME sign as the camera's
 * bob offset produces OPPOSED motion in the image. Same sign, opposite cue. Do not "fix" it.
 *
 * THE LENS. There is one scene camera at `CAMERA.fovBase` (78°) and no second render pass to
 * borrow, so "held at a low FOV so it doesn't distort" is bought optically instead: the model's
 * local Z is compressed by `view.depthCompress` before the perspective divide stretches it back.
 *
 * THE CLIPPING CONTRACT. Every vertex stays inside `view.maxEyeDistance` (0.40 m) of the eye,
 * which is under `MOVE.radius` (0.42 m) — so no static geometry can ever be closer than the gun
 * and the gun can never punch through a wall. That is why this works with ordinary depth testing
 * and needs no depth clear. Its twin is `view.nearClearance`: no vertex may come nearer than
 * 0.07 m, well clear of `CAMERA.near` (0.05 m). `assertClearance()` checks BOTH, per vertex,
 * for every pose the model can reach — rest, ADS, sprint, reload, equip and recoil — at build
 * time in dev.
 *
 * THE AIM SOCKET. The ADS pose is not three tuned numbers; it is solved from the rear-sight
 * notch so the sight picture sits on the axis the bullet is traced along. See the `SIGHT` block.
 */

import {
  Euler, Float32BufferAttribute, Group, Matrix4, Mesh, Quaternion, Vector3,
  type BufferGeometry, type Object3D, type PerspectiveCamera,
} from 'three';
import { PALETTE, READABILITY, hexMix } from '@/art/palette';
import {
  bevelBox, inkCylinder, mergeForStatic, place,
} from '@/art/shapes';
import {
  WEAPON_FIELD, WEAPON_SURFACE_MAP,
  makeChippedPaint, makeKnurled, makeParkerised, makeTapeWrap, makeVentedSteel, makeWoodGrain,
} from '@/art/surfaces';
import {
  buildOutlineHull, makeInkMaterial, markBloom,
  type InkMaterial, type InkMaterialOptions,
} from '@/render/materials/index';
import { DEG2RAD, Spring, SpringVec3, TAU, clamp, clamp01, damp, lambdaFromHalfLife, lerp } from '@/core/mathx';
import { CAMERA, MOVE, WEAPON } from '@/game/tuning';

const V = WEAPON.view;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scratch
// ─────────────────────────────────────────────────────────────────────────────────────────────

const _pos = new Vector3();

const _quat = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');
const _local = new Matrix4();
const _one = new Vector3(1, 1, 1);
const _probe = new Vector3();

/**
 * Peak displacement of a spring kicked from rest, as `peak = v · gain(ζ) / ω`.
 *
 * Same derivation as `player/camera.ts:springPeakGain` — and duplicated here on purpose rather
 * than imported, because a game system may not import another game system (ARCHITECTURE §1) and
 * six lines of closed-form maths is a much smaller cost than the coupling. Without it, "kick the
 * gun back 5 cm" silently delivers 2 cm at ζ 0.42 and every kick constant reads as a lie.
 */
function springPeakGain(zeta: number): number {
  if (zeta >= 0.999) return Math.exp(-1);
  const wd = Math.sqrt(1 - zeta * zeta);
  const t = Math.atan2(wd, zeta) / wd;
  return (Math.exp(-zeta * t) * Math.sin(wd * t)) / wd;
}

function impulseFor(hz: number, zeta: number, peak: number): number {
  const omega = TAU * hz;
  return (peak * omega) / springPeakGain(zeta);
}

/** Exponential approach that actually ARRIVES. The `eps` snap is the §4.1 guarantee. */
function settle(current: number, target: number, halfLife: number, dt: number, eps = 1e-4): number {
  const v = damp(current, target, lambdaFromHalfLife(halfLife), dt);
  return Math.abs(v - target) < eps ? target : v;
}

/** Kill a spring outright once it is below visual threshold, so it stops emitting motion. */
function settleSpring(s: Spring, eps: number): void {
  if (Math.abs(s.value - s.target) < eps && Math.abs(s.velocity) < eps * 60) {
    s.value = s.target;
    s.velocity = 0;
  }
}

function settleSpringVec(s: SpringVec3, eps: number): void {
  const d = _probe.copy(s.value).sub(s.target);
  if (d.lengthSq() < eps * eps && s.velocity.lengthSq() < (eps * 60) * (eps * 60)) {
    s.value.copy(s.target);
    s.velocity.set(0, 0, 0);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// GEOMETRY — a chunky comic pistol, readable in silhouette at a glance.
//
// Gun space: origin at the web of the hand, muzzle down -Z, +Y up, +X right. Everything is
// authored in real metres and then the whole model is scaled once, so the proportions are
// exaggerated the way a comic exaggerates them — a fat slide, an oversized muzzle brake, a
// blocky grip — rather than being an accurate pistol drawn small.
//
// ART §2/§3: bevel everything (the chamfer is what catches the rim and reads as an inked edge),
// low deliberate segment counts, nothing perfectly square.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Overall model scale. One number to make the gun bigger or smaller on screen. */
const MODEL_SCALE = 1;

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE SIGHTS, AND THE AIM SOCKET THEY DEFINE.
 *
 * This file already said the sights were "the only two things on this gun that are meant to line
 * up". They were not lined up, and nothing made them: the blades were placed by hand at two
 * different heights (front top 0.064, rear top 0.062) and the ADS pose was three hand-picked
 * translation constants that happened to leave the whole sight line 56 px above the muzzle line.
 *
 * So the sight line is now ONE number — `lineY`, the height of the top edge of BOTH blades — and
 * everything else is derived from it:
 *
 *   · the front blade is placed at `lineY - frontH/2`, the rear pair at `lineY - rearH/2`, so
 *     their tops are coincident BY CONSTRUCTION and cannot drift apart in a later edit;
 *   · `AIM_SOCKET` is the rear notch on that line, in root-local space (i.e. with `depthCompress`
 *     already folded into z, because that is the space the pose translation lives in);
 *   · `ADS_X/Y/Z` are then SOLVED, not tuned: with the ADS rotation identity, putting the socket
 *     at (0, 0, −adsSightDistance) in camera space puts the rear notch dead on the camera's
 *     forward axis. The front blade shares the socket's x and y and differs only in z, so it
 *     lands on the SAME axis — one point on screen, at any FOV, any aspect, any viewport.
 *
 * That last sentence is the whole fix for the playtester's "you aim like inside the pistol": the
 * bullet leaves the eye along that axis, and now so does the sight picture.
 *
 * MAKING THE PICTURE SURVIVE THE INK. Alignment is necessary and not sufficient — a sight
 * picture is THREE shapes (post, notch, and the LIGHT BARS either side of the post) and all
 * three were being erased. Measured at 1600×821 / 56° ADS, with the sights merged into the slide
 * and carrying its `READABILITY.VIEWMODEL_OUTLINE_PX` (7 px) hull:
 *
 *   · light bars: the blades sat at x = ±0.011 and were 0.011 wide, i.e. a notch gap of exactly
 *     one post-width. Zero bars before ink, and 14 px of ink to spend. The post printed as a
 *     black blob fused to both blades.
 *   · the post itself: 26 px wide, minus 7 px of hull a side, left 12 px of albedo.
 *   · and the RUST slide rib (top 0.0555, i.e. 6.5 mm under the line) occluded everything below
 *     ~16 px of a 38 px post, because the rib runs FORWARD from the notch and so is nearer than
 *     the post at every ray below the sight line.
 *
 * The three fixes, in the same order: a 0.020 notch gap; the sights split into their own mesh
 * with their own **thinner** hull (`view.sightOutlinePx`) so interior detail is not carrying the
 * silhouette's line weight; and the rib dropped to a top of 0.052 with the sight line raised to
 * 0.066, which clears the post down to ~34 px of its 48. Blade WIDTH stays at 0.011 — that is
 * the ink-band floor documented above `buildGunGeometry` and it is not negotiable.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * FOUR GUNS, ONE BUILDER — and why the differences are NOT just "make it longer".
 *
 * Every weapon shares the hand, the grip, the trigger and the guard, because it is the same
 * player holding it. What changes is the RECEIVER, the BARREL, the MUZZLE, what hangs under the
 * fore-end, what sits behind the grip, and the sight line. That is what a real silhouette
 * difference is made of, and it is all data below.
 *
 * ─── THE CONSTRAINT THAT SHAPES ALL OF THIS ─────────────────────────────────────────────────
 * `assertClearance` measures reach as `hypot(|x| + sway, z)` against `view.maxEyeDistance`
 * (0.40 m), and the PISTOL already measures 0.386 — fourteen millimetres of headroom. A rifle
 * authored at its real length would blow straight through that and clip into walls, and pulling
 * the pose back to compensate would drive it through `CAMERA.near` instead. Both directions are
 * walls; there is no room to simply make a longer gun.
 *
 * So length is bought with `depthCompress`, which this file ALREADY applies to the pistol at
 * 0.72 — the model is foreshortened along z on the way out of the builder. Making it per-profile
 * means a rifle can be authored at its true proportions, read long in silhouette, and still
 * occupy less depth than the pistol does. That is exactly the exaggeration a comic panel uses on
 * a gun pointed at the reader, so it is style and budget agreeing for once rather than fighting.
 *
 * ─── AND WHY EACH GUN CARRIES ITS OWN SIGHT ─────────────────────────────────────────────────
 * `AIM_SOCKET` and the ADS translation are SOLVED from the sight line, not tuned (see the SIGHT
 * block). One shared socket across four guns with four different receiver heights would put the
 * sight picture off the bullet on three of them — which is the precise bug the playtester
 * already reported once as "you aim like inside the pistol". Every profile therefore carries its
 * own `sight`, and the socket and ADS offsets are re-solved per model.
 *
 * The marksman gets a raised BLADE rail rather than a scope tube, deliberately: a solid optic
 * would need the camera to see through its own geometry at ADS, and an open ghost-ring reads as
 * precision in this style without asking the renderer for a hole in a solid object.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
interface SightSpec {
  lineY: number;
  rearZ: number;
  frontZ: number;
  bladeW: number;
  rearH: number;
  frontH: number;
  bladeD: number;
  notchHalfGap: number;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE DETAIL VOCABULARY — every optional part a profile can opt into.
 *
 * WEAPON_ART §0 is the law here and it is counter-intuitive: **more detail does not mean more
 * small parts.** The inverted hull inflates every silhouette by a SCREEN-SPACE 7 px, so anything
 * under `INK_FLOOR` has no albedo left between its two inflated faces and prints as solid black.
 * That is not a theory — the trigger guard, the trigger, the muzzle fins and the front sight were
 * all under the band once and an art review recorded the result as "five untextured boxes".
 *
 * So every shape below is authored BOLD, and `inkChunk()` clamps anything an author gets wrong
 * back up to the floor and says so in dev. The four levers that actually buy perceived quality:
 * bigger/fewer shapes · material separation · silhouette events · asymmetry.
 *
 * ─── WHERE THE PARTS LAND, AND WHY IT IS NOT ARBITRARY ──────────────────────────────────────
 * Two new mesh groups carry the whole vocabulary (the draw-call budget allows exactly two):
 *
 *   · `steel`   — machined metal, LIGHTER than the frame. Parented to the SLIDE, so everything
 *                 in it RECIPROCATES on a shot: ejection-port frame, charging handle, rail teeth,
 *                 trigger. A port lip that stayed put while the slide cycled 13 mm underneath it
 *                 would read as a bug on every single shot, and the pistol's slide cycle is the
 *                 one mechanical animation this gun has.
 *   · `polymer` — the parts a hand touches, DARKER than the frame. Parented to the ROOT group,
 *                 i.e. STATIC: grip, heel, fore-end, stock, mag well, selector, stamped panels.
 *
 * Profile authors pick the part that has the parenting they want. Do not put `panels` on a
 * reciprocating pistol slide (they are static); do not expect `railTeeth` to hold still.
 *
 * ─── THE BUDGET, RESTATED WHERE IT WILL BE READ ─────────────────────────────────────────────
 * `assertClearance` measures reach as `hypot(|x| + sway, z)`. Every gun is between 0.387 and
 * 0.393 against a 0.40 budget, so geometry added FORWARD (−z) at the muzzle end eats margin that
 * does not exist. Geometry added BEHIND the hand (+z), INWARD, or VERTICALLY is free, and
 * geometry added sideways at the RECEIVER is nearly free because |z| is small there and the
 * measure is a hypotenuse. Detail the receiver, the stock, the top rail and the sides.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * A recessed ejection port on the RIGHT of the receiver — per WEAPON_ART §1 the single most
 * "gun-like" detail, and no gun had one.
 *
 * It is built as a FRAME of four proud bars around a bare patch of receiver rather than as a
 * plate laid on top: a plate the same colour as its host reads as a raised rectangle, whereas a
 * lighter frame standing 5 mm off the face gives the Sobel interior-detail pass (ART §3) a real
 * depth step to ink, and the enclosed face falls into the cel shadow band on its own. The rear
 * bar is a DEFLECTOR that stands proudest — that is the asymmetry event on the silhouette.
 */
interface EjectionPortSpec {
  /** Opening height, metres. */
  h: number;
  /** Opening length along the receiver, metres. */
  d: number;
  /** Centre of the opening in gun space, metres. */
  y: number;
  z: number;
  /**
   * Radius of a shell sitting in the port, metres — RUST, rides the slide. `0` for none.
   * Anything under half the ink floor is dropped rather than drawn as a black smear.
   */
  shellR: number;
}

/**
 * A bold protruding charging handle / bolt handle. On `'right'` this is the strongest available
 * "this is a rifle" silhouette event; on `'top'` it is a rail-mounted latch.
 *
 * `len` is how far it STANDS OFF the receiver, not its total size. The stem carries a paddle at
 * its outer end so the shape ends in a hook rather than a stub — a hook survives the ink line,
 * a taper does not.
 */
interface ChargingHandleSpec {
  side: 'left' | 'right' | 'top';
  /** Stand-off from the receiver face, metres. */
  len: number;
  /** Stem cross-section, metres. Floored at `INK_FLOOR`. */
  thick: number;
  /** Centre in gun space, metres. */
  y: number;
  z: number;
}

/** A fire-selector lever on the LEFT of the receiver: a round boss plus a bar. Polymer, static. */
interface SelectorSpec {
  /** Boss radius, metres. Floored at `INK_FLOOR / 2` so the boss is ≥ 10 mm across. */
  r: number;
  /** Lever length measured from the boss centre, metres. */
  len: number;
  /** Lever cross-section, metres. Floored at `INK_FLOOR`. */
  thick: number;
  /** Boss centre in gun space, metres. */
  y: number;
  z: number;
  /** Lever angle measured from straight-back (+z); positive swings the tip UP. Degrees. */
  angleDeg: number;
}

/**
 * The step/funnel where a magazine enters the frame, so the mag reads as an INSERTED object
 * rather than a box glued on. Static, while the magazine mesh animates down through it on a
 * reload — which is exactly the read we want and costs nothing extra.
 *
 * It carries the same 0.30 rad rake the magazine build uses, so the two agree by construction.
 */
interface MagWellSpec {
  /** Outer size of the well, metres. */
  w: number;
  h: number;
  d: number;
  /** Centre in gun space, metres. */
  y: number;
  z: number;
  /** How far the bottom collar flares beyond the well on each side, metres. */
  flare: number;
}

/**
 * Protective ears either side of the front post. Instantly reads military.
 *
 * THEY LIVE IN THE `sights` GROUP, which means they ride the slide and carry the thinner
 * `view.sightOutlinePx` line — correct on both counts, and free.
 *
 * `gap` IS A SIGHT-PICTURE CONSTRAINT. The rear notch is nearer the eye than the front post, so
 * its window projects LARGER at the front plane — roughly `notchHalfGap × 1.5`. A wing inside
 * that window eats the light bars the player aims with, which is the exact class of bug the SIGHT
 * block above was written to close. The builder warns in dev when `gap` is too tight.
 */
interface SightWingsSpec {
  /** How far the wing tops stand above `sight.lineY`, metres. May be 0 or negative. */
  rise: number;
  /** Wing thickness across the barrel, metres. Floored at `INK_FLOOR`. */
  thick: number;
  /** Distance from centre to the wing's INNER face, metres. See the note above. */
  gap: number;
  /** Wing depth along the barrel, metres. */
  d: number;
}

/**
 * A group of BOLD stamped cuts or vents — 2–3, never 8. They are POLYMER (dark) and sit nearly
 * flush, so they read as holes cut into the host mass rather than as plates stuck on it.
 *
 * `hostHalfW` is what makes this reusable: the cuts sit on the faces of whatever mass they are
 * cutting, which may be the receiver, an SMG's barrel shroud or a shotgun's heat shield.
 */
interface PanelsSpec {
  /** How many. WEAPON_ART §0: more than 3 is against the rule and the builder says so. */
  count: number;
  /** Asymmetry is a feature — one side reads as authored. */
  side: 'left' | 'right' | 'both';
  /** Cut height and length along the gun, metres. */
  h: number;
  d: number;
  /** Centre of the REARMOST cut, metres. */
  y: number;
  z: number;
  /** Pitch along z; the cuts march FORWARD (−z), metres. */
  step: number;
  /** Half-width of the mass being cut — the cuts sit on its side faces. Metres. */
  hostHalfW: number;
}

/**
 * Chunky teeth along the top rail. Steel, rides the slide.
 *
 * THEIR HEIGHT IS A SIGHT-PICTURE CONSTRAINT, exactly as the RUST rib's is (see the rib note in
 * `buildGunGeometry`): anything on the top of the receiver runs FORWARD from the rear notch and
 * is therefore NEARER the eye than the front post at every ray below the sight line. The rib at
 * a top of 0.0555 once occluded all but 16 px of a 38 px post. The builder warns if a tooth's
 * top comes within 10 mm of `sight.lineY`.
 */
interface RailTeethSpec {
  count: number;
  /** Tooth width across the gun, height, and length along it, metres. */
  w: number;
  h: number;
  d: number;
  /** Centre of the REARMOST tooth, metres. */
  y: number;
  z: number;
  /** Pitch along z; the teeth march FORWARD (−z), metres. */
  step: number;
}

interface GunProfile {
  /** Matches `WeaponDef.id`. */
  id: string;
  /** Per-gun foreshortening along z. Longer gun → stronger compression. See the note above. */
  depthCompress: number;
  /**
   * Rest-pose slide along z, metres. Positive = toward the eye. Spends near-plane margin to buy
   * reach margin, which is what lets a long gun BE long. See the REST_DZ note. Optional; 0 for
   * any gun that is already pinned against the near plane.
   */
  restDz?: number;
  sight: SightSpec;
  /** The upper mass: half-width, half-height, length, and where it sits. */
  receiver: { w: number; h: number; d: number; y: number; z: number };
  /** Cocking serrations cut into the rear of the receiver. */
  serrations: number;
  /** The round mass under the receiver's nose — the "that is a gun" read in silhouette. */
  barrel: { r: number; len: number; y: number; z: number };
  /** Muzzle device: a can plus fins, sized per gun. `fins: 0` for the shotgun's plain choke. */
  muzzle: { r: number; len: number; z: number; fins: number; finW: number };
  /** Box magazine. The shotgun sets `none` and uses a tube instead. */
  magazine: { w: number; h: number; d: number; y: number; z: number } | null;
  /** Tube magazine slung under the barrel (shotgun). */
  tube: { r: number; len: number; y: number; z: number } | null;
  /** What the support hand holds: a vertical grip, a pump, or nothing. */
  foreEnd: { w: number; h: number; d: number; y: number; z: number; ribs: number } | null;
  /** Behind the grip: a skeleton brace or a full stock. */
  stock: { w: number; h: number; d: number; y: number; z: number; skeleton: boolean } | null;
  /** Warm-accent rib along the top of the receiver, between the sights. */
  rib: { w: number; h: number; d: number; y: number; z: number };

  // ── THE OPTIONAL DETAIL VOCABULARY ──────────────────────────────────────────────────────
  // Every one of these is opt-in. Omit it (or set it null) and the builder emits nothing, so a
  // profile that says nothing about them is exactly the gun it was before. See the block of
  // interfaces above for units, parenting and the constraints each one is under.
  /** Recessed port with a proud lip and a rear deflector, RIGHT side. Steel, rides the slide. */
  ejectionPort?: EjectionPortSpec | null;
  /** Bold protruding handle, side or top. Steel, rides the slide. */
  chargingHandle?: ChargingHandleSpec | null;
  /** Fire selector, LEFT side. Polymer, static. */
  selector?: SelectorSpec | null;
  /** Flared well the magazine is inserted through. Polymer, static. */
  magWell?: MagWellSpec | null;
  /** Ears either side of the front post. Rides the sights, carries the sights' lighter ink. */
  sightWings?: SightWingsSpec | null;
  /** 2–3 bold stamped cuts. Polymer, static. */
  panels?: PanelsSpec | null;
  /** Chunky top-rail teeth. Steel, rides the slide. */
  railTeeth?: RailTeethSpec | null;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE INK FLOOR, AS A FUNCTION AND NOT AS A COMMENT.
 *
 * WEAPON_ART §0: at `READABILITY.VIEWMODEL_OUTLINE_PX` (7 px) a part needs more than ~14 px of
 * screen width or it has no albedo between its two inflated hull faces and renders as SOLID INK.
 * The gun sits ~0.30 m from the eye at 78° FOV, where 0.008 m ≈ 13 px — so the floor is 0.010 m
 * on every axis of every structural part, and it is a gate rather than a guideline.
 *
 * It was previously enforced by hand, and it had already drifted twice in this very file: the
 * cocking serrations were 0.006 m and the fore-end ribs 0.008 m, i.e. both were printing as one
 * black smear instead of as the grooves they were modelled to be. `inkChunk` makes that
 * impossible to do silently — it CLAMPS to the floor and says which part broke it, so the four
 * profile authors who will fill in the vocabulary above cannot reintroduce the bug by accident.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const INK_FLOOR = 0.010;

/**
 * The rake every magazine and every mag well is built on, radians. One number, so the well and
 * the magazine that slides through it cannot be authored at two different angles.
 */
const MAG_RAKE = 0.30;

/**
 * Everything that makes a material read as its family — minus the colour it wears, minus the map
 * printed on it, minus its name. A surfaced variant of a field spreads one of these, so a
 * patterned receiver and a plain one differ in exactly one thing: the marks.
 */
type FieldLook = Omit<InkMaterialOptions, 'color' | 'name' | 'map'>;

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE FOUR FLAT FIELDS, AS NUMBERS, IN ONE PLACE.
 *
 * These used to be written inline in the `makeInkMaterial` calls. They moved here because
 * `art/surfaces` authors its maps as an EXACT modulation of a *named* base colour: the generator
 * is handed the field it will sit on, works out how much headroom that base has under
 * `READABILITY.ENV_VALUE_CEIL`, and encodes each mark as the texel that produces the target
 * output. Hand it a different colour from the one the material actually wears and the encoding is
 * silently wrong — marks clip, or vanish. So the material and its map now read the same constant.
 *
 *   polymer  ~0.29   grip · heel · fore-end · stock · trigger · selector · mag well · panels
 *   frame    ~0.44   receiver · slide · barrel · guard
 *   steel    ~0.57   port frame · charging handle · rail teeth · magazine
 *   wood     ~0.43   the shotgun's furniture ONLY — a HUE break at the frame's value
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const FIELD = {
  frame: hexMix(PALETTE.SLATE, PALETTE.BONE, 0.30),
  polymer: hexMix(PALETTE.SLATE, PALETTE.INK_SOFT, 0.28),
  steel: hexMix(PALETTE.SLATE, PALETTE.PAPER, 0.42),
  /** From `art/surfaces` — walnut, dropped toward INK so it lands at the frame's value. */
  wood: WEAPON_FIELD.wood,
} as const;

type FieldSet = { frame: number; polymer: number; steel: number; wood: number };

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * ONE PALETTE PER WEAPON — the thing that was actually making them look alike.
 *
 * The playtester, after the silhouettes were spread apart and the surfaces landed: "i feel like
 * the weapons still look very similar... maybe we should use different colors for each one".
 * Measured in-game, and they were exactly right. Every mesh, every gun:
 *
 *     frame   #6d717d   #6d717d   #6d717d   #6d717d
 *     slide   #6d717d   #6d717d   #6d717d   #6d717d
 *     steel   #8d919a   #8d919a   #8d919a   #8d919a
 *     polymer #3c4866   #3c4866   #946846   #3c4866
 *
 * The ONLY colour difference in the entire arsenal was the shotgun's walnut grip. The receiver —
 * the largest mass on screen — was the identical grey on all four. The surface maps were bound
 * and working at full strength, but a map is a MULTIPLIER over the base colour, so identical
 * bases meant the patterns read as different scuffs on one gun rather than as four guns.
 *
 * Shape got them apart in silhouette; this gets them apart in the two seconds before you register
 * a silhouette. Real weapon families differ by FINISH first — blued, phosphate, wood, desert tan
 * — and that is the axis being used here.
 *
 * THE RESERVED CHANNELS ARE UNTOUCHED (ART §9). ACID 0x8cff3e and HOT 0xff2e63 belong to enemies;
 * GOLD 0xffc531 to interactables and the muzzle core. None appear below. The olive is deliberately
 * dark and desaturated so it cannot be confused with ACID, which is a bright saturated yellow-
 * green — they share a hue family and nothing else. Every value stays under ENV_VALUE_CEIL 0.78,
 * and nothing here climbs into the sights' BONE 0.73. That last one needed a correction: the
 * first pass mixed the desert tan only 30% toward RUST from BONE, which left it at luma 0.672 —
 * legal, but sitting on top of BONE and reading warm enough to flirt with the GOLD that ART §9
 * reserves for interactables. Both tans are now dropped toward INK. The rifle is still the palest
 * gun in the arsenal, which is its whole identity; it just no longer competes with the channels
 * the enemy and the pickups own.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const FIELDS: Record<string, FieldSet> = {
  /** BLUED — cold, dark, workmanlike. The issued sidearm nobody chose. */
  inkslinger: {
    frame: hexMix(PALETTE.SLATE, PALETTE.TEAL, 0.34),
    polymer: hexMix(PALETTE.INK_SOFT, PALETTE.SLATE, 0.22),
    steel: hexMix(PALETTE.SLATE, PALETTE.PAPER, 0.34),
    wood: FIELD.wood,
  },
  /** OLIVE DRAB — the only green in the arsenal, and nowhere near ACID: dark and desaturated. */
  ratatat: {
    frame: 0x5c6247,
    polymer: 0x343a2c,
    steel: hexMix(0x8a8d7e, PALETTE.SLATE, 0.20),
    wood: FIELD.wood,
  },
  /** WALNUT AND BROWNED STEEL — the warm gun. Its metal is warm too, not just its furniture. */
  boomstick: {
    frame: hexMix(hexMix(PALETTE.SLATE, PALETTE.RUST, 0.28), PALETTE.INK, 0.18),
    polymer: FIELD.wood,
    steel: hexMix(hexMix(PALETTE.BONE, PALETTE.RUST, 0.30), PALETTE.INK, 0.24),
    wood: FIELD.wood,
  },
  /** DESERT TAN — the light gun, and the only one that reads pale at a glance. */
  longshot: {
    frame: hexMix(hexMix(PALETTE.BONE, PALETTE.RUST, 0.34), PALETTE.INK, 0.26),
    polymer: hexMix(PALETTE.INK_SOFT, PALETTE.BONE, 0.16),
    steel: hexMix(hexMix(PALETTE.BONE, PALETTE.CONCRETE, 0.30), PALETTE.INK, 0.18),
    wood: FIELD.wood,
  },
};

function fieldFor(id: string): FieldSet {
  return FIELDS[id] ?? (FIELD as unknown as FieldSet);
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE VIEWMODEL RE-PROJECTS ITS OWN UVs, AND WHY IT DOES NOT USE `uMapScale`.
 *
 * `art/shapes` gives every primitive `applyBoxUV(geo, 1)`, whose UVs are **metres of local
 * position**, not a 0..1 unwrap per face — and they are baked BEFORE `place()` moves the part, so
 * they are centred on each primitive's own origin. Two consequences, both fatal to a bold pattern:
 *
 *  1. A gun part is 2–5 cm across, so at one tile per metre a whole part samples 2–5 % of the
 *     tile. Every mark in `art/surfaces` is 5–50 % of a tile wide. You get one flat colour.
 *  2. Because the UVs are centred on zero, that 3 % window lands on the tile's CORNER — and the
 *     patterns put their marks in the middle (the vent slots live at v 0.26–0.88). A shroud would
 *     have sampled nothing but the light-catch band at the top of the tile. Not "a bit subtle" —
 *     literally none of the pattern.
 *
 * `uMapScale` fixes (1) and cannot fix (2): it multiplies the UV, so it scales the window about
 * the same corner. The phase has to be baked, so the scale is baked with it and `mapScale` stays
 * at the 1 that `WEAPON_SURFACE_MAP` asks for.
 *
 * What this does instead, on the MERGED part geometry (so the pattern is continuous across every
 * box in the group, in gun space — a fore-end and the stock behind it read as one piece of
 * timber, which is exactly the tell that says "material" rather than "texture"):
 *
 *  · project from the dominant axis of each vertex's normal — the geometry is faceted, so the
 *    vertex normal IS the face normal and no triangle grouping is needed;
 *  · **U is world −z wherever z is not the projection axis**. That is the one deviation from
 *    `applyBoxUV`, and it is the whole reason the directional patterns work: box mapping runs u
 *    along x on a top face, so wood grain and vent slots ran ALONG the barrel on the sides of the
 *    gun and ACROSS it on top of the same part. Now they run down the barrel on both;
 *  · offset so the geometry's centre lands on the tile's centre, which is where the marks are.
 *
 * The only surviving compromise is the end caps (z-dominant faces): the muzzle face of a barrel
 * and the butt of a stock get u = x, because there is no z to run along. They are a few hundred
 * triangles pointing away from the eye and they take a slice of the pattern, not a stretch of it.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
function projectSurfaceUV(geo: BufferGeometry, tilesPerMetre: number): BufferGeometry {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  if (!pos || !nrm) return geo;

  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = bb ? (bb.min.x + bb.max.x) * 0.5 : 0;
  const cy = bb ? (bb.min.y + bb.max.y) * 0.5 : 0;
  const cz = bb ? (bb.min.z + bb.max.z) * 0.5 : 0;
  const s = tilesPerMetre;
  // Phase: the part's centre sits at the middle of the tile, where the marks live.
  //
  // `oz` is PLUS cz because the z axis is used NEGATED below (u runs along world −z, muzzle
  // forward). With the same minus the other two use, the along-the-barrel phase came out at
  // `0.5 - 2 * cz * s` — several whole tiles off on a part sitting 20 cm down the barrel, which
  // silently picks a different slice of every pattern than the one the comment promises.
  const ox = 0.5 - cx * s;
  const oy = 0.5 - cy * s;
  const oz = 0.5 + cz * s;

  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    let u: number;
    let v: number;
    if (nz >= nx && nz >= ny) {
      // End cap. No z to run along; fall back to box mapping.
      u = px * s + ox;
      v = py * s + oy;
    } else if (ny >= nx) {
      // Top / bottom. Box mapping would put u on x; the pattern runs down the barrel instead.
      u = -pz * s + oz;
      v = px * s + ox;
    } else {
      // Side.
      u = -pz * s + oz;
      v = py * s + oy;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  return geo;
}

/** A bevelled box that cannot be thinner than the ink line can survive. */
function inkChunk(
  w: number, h: number, d: number, bevel: number, seed: number, what: string,
): BufferGeometry {
  const thinnest = Math.min(w, h, d);
  if (import.meta.env?.DEV && thinnest < INK_FLOOR - 1e-6) {
    console.warn(
      `[weapons/viewmodel] "${what}" is ${(thinnest * 1000).toFixed(1)} mm on its thinnest axis, ` +
      `under the ${(INK_FLOOR * 1000).toFixed(0)} mm ink floor — it would print as solid black. ` +
      'Clamped. See WEAPON_ART §0.',
    );
  }
  return bevelBox(
    Math.max(w, INK_FLOOR), Math.max(h, INK_FLOOR), Math.max(d, INK_FLOOR), bevel, seed,
  );
}

/**
 * Anything standing on top of the receiver runs FORWARD from the rear notch and is therefore
 * NEARER the eye than the front post at every ray below the sight line — so it occludes the sight
 * picture from the inside. This is the rib bug, generalised into a check.
 */
function guardSightLine(topY: number, P: GunProfile, what: string): void {
  if (!import.meta.env?.DEV) return;
  const ceil = P.sight.lineY - 0.010;
  if (topY > ceil) {
    console.warn(
      `[weapons/viewmodel] ${P.id}: "${what}" tops out at ${topY.toFixed(4)} m, above the ` +
      `${ceil.toFixed(4)} m ceiling set by sight.lineY ${P.sight.lineY}. It will occlude the ` +
      'front post at ADS from below. Lower it or shorten it.',
    );
  }
}

const SIGHT = {
  /**
   * THE sight line: the top edge of the front blade and of both rear blades. Gun space, metres.
   * The slide's top face is at 0.050, so the blade heights below are what stands the line off it
   * — raise `lineY` and you MUST raise the heights with it or the blades float.
   */
  lineY: 0.066,
  /** Rear notch centre and front blade centre, along the slide. */
  rearZ: 0.002,
  frontZ: -0.118,
  /** Blade width — at the ink-band floor, so the blades hold albedo instead of printing solid. */
  bladeW: 0.011,
  /** Blade heights below the line, and their thickness along the barrel. */
  rearH: 0.018,
  frontH: 0.020,
  bladeD: 0.012,
  /** Half the notch gap: the inner face of each rear blade sits this far off centre. */
  notchHalfGap: 0.010,
} as const;

/**
 * THE FOUR PROFILES.
 *
 * The pistol's numbers are BUILD 007's, unchanged to the millimetre — it is the reference the
 * other three are read against and the one whose clearance is already measured at 0.386 m.
 */
const PROFILES: readonly GunProfile[] = [
  /**
   * INKSLINGER — the pistol, and the reference every other gun is read against.
   *
   * THE PROPORTIONS ARE FROZEN. `receiver`, `sight`, `depthCompress`, `barrel`, `muzzle`,
   * `magazine` and `rib` are BUILD 007's numbers to the millimetre: this is the model whose
   * clearance the whole budget is quoted from and whose `sight.lineY` the ADS solve is anchored
   * to. Everything added below is DETAIL — new masses hung on a shape that did not move.
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
   *   front-top    protective ears round the front post      (sights, lighter ink)
   *   front-left   two stamped cuts in the dust cover        (polymer, static)
   *
   * That is four value fields on one gun — polymer 0.29, frame 0.44, steel 0.57, BONE 0.73 —
   * plus the RUST warm read, which §2 calls the biggest available win and which costs no
   * geometry at all. Left and right now carry DIFFERENT events, so the gun is asymmetric from
   * every angle the player can put it at.
   *
   * ─── CLEARANCE: MEASURED, NOT ASSERTED ──────────────────────────────────────────────────
   * The whole point of the layout above is that NOT ONE of these parts is forward of the muzzle
   * or outboard of the hand. Walked over all seven poses × the sway corners × the flourish
   * signs, the model's worst vertex is unchanged in every pose and every metric — still
   * `muzzle.fin2` at 0.394 / 0.414 swayed, still the magazine at reload, still the forearm at
   * the near plane. The nearest any new part comes to being the offender is the sight ears at
   * 0.404 swayed, ten millimetres inside the mass they sit behind.
   */
  {
    id: 'inkslinger',
    depthCompress: 0.66,
    restDz: 0,
    /**
     * NO SIGHT WINGS, NO RAIL TEETH. Both were added for "reads military" and both were wrong:
     * the wings are BONE (0.73 luma, the brightest value on the gun) and the teeth are steel
     * (0.57), so every weapon ended up wearing a stack of pale bars along its top edge. The
     * playtester: "all the guns have like gray lines on top of it, they look bad". They were
     * right — 400-500 of the vertices in each gun's top 18 mm were this, on all four weapons,
     * which is also why the guns looked alike from the one angle you always see them from.
     * The front post and rear notch STAY: those are the sight picture and ADS needs them.
     */
    sight: SIGHT,
    receiver: { w: 0.030, h: 0.038, d: 0.150, y: 0.030, z: -0.052 },
    serrations: 4,
    barrel: { r: 0.014, len: 0.056, y: 0.010, z: -0.112 },
    muzzle: { r: 0.017, len: 0.030, z: -0.140, fins: 3, finW: 0.036 },
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
     * line *is* the outline — which is exactly why the hook is the only new part allowed to
     * stick out past a silhouette the eye already knows.
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
     * every face: a two-tier hook with a real step in its outline, which is the one kind of
     * detail the ink line cannot erase. Bigger, bolder, fewer.
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
     * is POLYMER, which carries the grip's dark field up and around behind the hand — the frame
     * grey is then a band between two dark masses instead of the whole gun.
     */
    stock: { w: 0.028, h: 0.018, d: 0.036, y: 0.002, z: 0.030, skeleton: false },
    rib: { w: 0.014, h: 0.011, d: 0.104, y: 0.0465, z: -0.052 },

    /**
     * THE EJECTION PORT — §1's "single most gun-like detail", with the front wall doing the
     * extractor's job.
     *
     * SIZED BY THE SLIDE'S TOP FACE, NOT BY EYE. The lip stands 5 mm above the opening and is
     * 10 mm thick, so `y + h/2 + 0.010` must land on or under the slide's 0.050 top: at
     * y 0.030 / h 0.018 the lip's top is 0.049 and the shelf's bottom 0.011, i.e. the frame
     * fills the side face edge to edge with 1 mm of slide showing above and below. A lip that
     * broke the top face would run forward of the rear notch and start eating the sight
     * picture from below, which is the rib bug all over again — the shipped RUST rib already
     * closes the picture at 0.052, so at 0.049 this is behind it and invisible to ADS.
     *
     * The brass in the port is the fourth RUST mark and the only one that is not on the
     * outline: it is a warm dot in the middle of the one rectangle the eye is drawn to. At
     * r 0.006 it is 12 mm across in an 18 mm window — a comic-fat round, not a case rim.
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
     * PROTECTIVE EARS. `gap` IS SOLVED, NOT PICKED. The rear notch is 0.235 m from the eye and
     * the front post 0.321 m, so the notch's ±0.010 window projects to ±0.0137 at the front
     * plane. At 0.017 the ears sit OUTSIDE that window entirely: they frame the post from
     * beyond the light bars and take away none of them. (The builder's ×1.5 heuristic gives
     * 0.015 — this clears the exact number by 3.3 mm, not the heuristic by nothing.)
     *
     * `rise` 0.001 keeps their tops a hair above the sight line, so the ears are the last thing
     * the outline crosses on the way up. They are in `sightParts`, so they ride the slide and
     * carry `view.sightOutlinePx` rather than the 7 px silhouette line.
     */
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
     * than mirrored. Polymer, so they are dark cuts in a mid-grey mass, not plates on it.
     */
    panels: {
      count: 2, side: 'left', h: 0.011, d: 0.016,
      y: -0.021, z: -0.058, step: 0.028, hostHalfW: 0.013,
    },
    /**
     * NO RAIL TEETH. The slide's top face is 16 mm wide and already carries the RUST rib for
     * its full length — teeth would have to sit on top of the rib, and anything up there runs
     * forward of the rear notch and occludes the front post from below. The pistol's top is
     * spoken for.
     */
  },
  /**
   * RATATAT — long, low and skeletal. Reads as *fast* before it fires: a slim receiver, a
   * vented shroud, a vertical grip the support hand is obviously clamped onto, and a wire stock
   * that says "this is braced against a shoulder" without adding a solid mass.
   *
   * ─── THE BRIEF: "I LOVED THE SMG" ────────────────────────────────────────────────────────
   * So NOTHING about how it sits or what size it is has moved. `depthCompress`, `sight`,
   * `receiver`, `serrations`, `barrel`, `muzzle`, `magazine`, `foreEnd`, `stock` and `rib` are
   * BUILD 007's numbers to the millimetre. Everything below is DETAIL hung on a shape that did
   * not change — WEAPON_ART §1's "make it LOOK like what it already feels like".
   *
   * ─── WHAT §1 ASKS THIS GUN FOR, AND WHERE EACH ONE LANDED ────────────────────────────────
   *   vented shroud (3 BOLD slots)  → `panels`, three vertical cuts, LOWER LEFT flank
   *   folding-stock hinge           → `selector` repurposed: a pivot boss between the receiver
   *                                   and the two stock rails, with a latch arm swung off it
   *   bold mag well                 → `magWell`, a flared mouth at the butt the stick feeds into
   *   top rail, 3–4 chunky teeth    → `railTeeth`, four steel crossbars over the warm rib
   * plus the "every gun gets" list: an ejection port with brass in it, a charging handle, and
   * protective ears round the front post.
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
   *   top              four rail teeth crossing the RUST rib           (steel, rides slide)
   *   rear-left        folding-stock pivot boss + latch arm            (polymer, static)
   *   butt             flared magwell mouth the stick feeds through    (polymer, static)
   *   front-top        ears round the front post                       (sights, lighter ink)
   *
   * Four value fields, none of them geometry: polymer 0.29 · frame 0.44 · steel 0.57 ·
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
   * its lightening cuts anyway. See the parenting note in the vocabulary block.
   *
   * ─── THE MAGAZINE IS NOT TOUCHED, AND THAT IS A CLEARANCE DECISION ───────────────────────
   * §1 asks for the curve to be emphasised, and the honest answer is that it cannot be
   * lengthened: MEASURED, this gun's binding constraint is the RELOAD pose, whose worst vertex
   * is the magazine floorplate at 0.4170 m swayed against `MOVE.radius` 0.42 — three
   * millimetres. Every millimetre added to `magazine.h` or `.d` is spent straight out of that.
   * What the stick got instead is a MOUTH: the flared well below stops 11 mm short of the
   * floorplate, so the raked body and the plate (which the shared builder kicks 14 mm rearward
   * of it — that offset IS the banana kink) emerge from under the collar as a separate inserted
   * object instead of dying inside the grip.
   */
  {
    id: 'ratatat',
    /** Longest-but-one gun, so the strongest foreshortening after the marksman. */
    /**
     * 0.52, not 0.60 — MEASURED, twice. At 0.60 rest/reload/equip all read 0.402–0.403 m, and at
     * 0.56 the RELOAD pose alone still did. The budget is 0.40. See the header note.
     */
    depthCompress: 0.54,
    restDz: 0.010,
    sight: {
      lineY: 0.074, rearZ: 0.014, frontZ: -0.138,
      bladeW: 0.011, rearH: 0.020, frontH: 0.024, bladeD: 0.012, notchHalfGap: 0.010,
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
    rib: { w: 0.013, h: 0.011, d: 0.130, y: 0.0505, z: -0.066 },

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
     * SIZED BY THE RECEIVER'S SIDE FACE, NOT BY EYE. The receiver spans y 0.010–0.054. At
     * y 0.032 / h 0.020 the top lip's top lands on 0.052 and the shelf's bottom on 0.012, so the
     * frame fills the face edge to edge with 2 mm of receiver showing above and below. The lip
     * stops under the 0.054 top face, so nothing here climbs onto the rail and starts eating the
     * sight picture from below — the rib and the teeth already own that ceiling.
     *
     * The brass is the warm mark that is NOT on the outline: r 0.006 is 12 mm of round in a
     * 20 mm window, a comic-fat case rather than a rim.
     */
    ejectionPort: { h: 0.020, d: 0.036, y: 0.032, z: -0.092, shellR: 0.006 },
    /**
     * THE CHARGING HANDLE, ON THE LEFT — which is both what an SMG does and where the player
     * is looking. It is the biggest silhouette event on this gun that is not the magazine.
     *
     * Clear of the serrations (rear face −0.076 against their −0.057) and clear of the rail
     * teeth in x, so the three steel parts never merge into one smear. At y 0.042 the paddle
     * spans 0.030–0.054 and tops out flush with the receiver's top face: it breaks the upper
     * outline without standing over it, and it ends in the builder's HOOK rather than a taper,
     * because a hook survives the ink line.
     *
     * It stands 20 mm off a face that is 15 mm from centre, so the far edge of the paddle is at
     * x −0.037 — INBOARD, toward screen centre, i.e. it costs the reach budget nothing at all.
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
     * PROTECTIVE EARS. `gap` IS SOLVED, NOT PICKED. The rear notch sits 0.235 m from the eye and
     * the front post 0.320 m (the 0.152 m between them, compressed by 0.56), so the notch's
     * ±0.010 window projects to ±0.0136 at the front plane. At 0.017 the ears stand outside that
     * window by 3.4 mm and take away none of the light bars. `rise` 0.001 keeps their tops a
     * hair above the sight line so they are the last thing the outline crosses on the way up.
     */
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
    /**
     * FOUR RAIL TEETH — and their HEIGHT is the whole design, because everything on top of a
     * receiver runs forward of the rear notch and occludes the front post from below.
     *
     * The RUST rib already closes the picture at a top of 0.056. The teeth top out at 0.059,
     * i.e. they cost the sight picture THREE MILLIMETRES of a 24 mm post and nothing else, while
     * standing 5 mm proud of the receiver's 0.054 top face. (The builder's ceiling is
     * `lineY − 0.010` = 0.064; this clears it by 5 mm, not by nothing.)
     *
     * They are 26 mm wide against the rib's 13, so they read as steel crossbars ACROSS the warm
     * line rather than as a second stripe along it: four hard value breaks on the top outline,
     * with the RUST showing through the 15 mm gaps between them. Steel, so they ride the slide —
     * as does the rib underneath them, which is the only reason the pair can share a face.
     */
  },
  /**
   * BOOMSTICK — short, fat and top-heavy. Everything about it is BORE: the widest muzzle in the
   * game sitting on a stubby receiver, with a tube slung underneath and a ribbed pump the hand
   * is wrapped around. It should look like it hurts to fire, which is what the 2.6 weaponKick
   * is telling you in the def.
   *
   * ─── THE ONE STRUCTURAL CHANGE, AND WHY IT IS THE WHOLE GUN ──────────────────────────────
   * It shipped as ONE 128 mm box from the hand to the choke, so the entire front half of the
   * weapon was a single untextured slab and there was nowhere to put a heat shield — WEAPON_ART
   * §1's first ask for this gun — because there was no exposed barrel to shield. The receiver is
   * now 106 mm, cut from the FRONT (its rear face stays at z 0.020, i.e. the serrations, the
   * hammer and the hand did not move), which opens a 29 mm window of bare barrel between the
   * receiver's nose at −0.086 and the choke's rear at −0.115. That window is what everything
   * else in this profile hangs on, and it costs zero reach because it is 22 mm of geometry
   * DELETED from the −z end.
   *
   * The silhouette is now four events instead of one: fat brick → hard step down → banded
   * shroud → the widest can in the game. Short and fat, which is what the gun is supposed to be,
   * rather than long and blank, which is what it was.
   *
   * ─── WHAT §1 ASKS THIS GUN FOR, AND WHERE EACH ONE LANDED ────────────────────────────────
   *   a heat shield, half-tube, 2 bold cutouts  → `foreEnd` (the shroud + its two clamp bands)
   *                                               and `panels` (the cutouts, see below)
   *   a visible shell in the ejection port      → `ejectionPort.shellR` 0.008 — 16 mm of RUST
   *                                               brass in a 22 mm window, the fattest in the game
   *   a receiver visibly THICKER than any other → w 0.042 → 0.046, against the pistol's 0.032 and
   *                                               the marksman's 0.028. Half again as wide as
   *                                               anything else, on a mass that is now short
   *                                               enough for the width to read as GIRTH
   *   a bold bead on a raised post              → the front blade moved back onto the receiver's
   *                                               top face and grew ears (`sightWings`)
   *   ribbing on the pump that reads as grip    → the shared builder's four pump ribs, unchanged;
   *                                               see the note on the tube below
   *
   *   front-top      shroud + two proud clamp bands over the bare barrel  (polymer, static)
   *   front-flanks   two bold cuts bitten out of the barrel's sides       (polymer, static)
   *   mid-right      the biggest ejection port in the game + fat brass    (steel + RUST, receiver)
   *   mid-left       cross-bolt safety: boss + lever swung down and back  (polymer, static)
   *   top            RUST rib, shortened to stop at the base of the post  (RUST, receiver)
   *   front-top      ears round the bead                                  (sights, lighter ink)
   *
   * FIVE value fields on one outline — polymer 0.29 · frame 0.44 · steel 0.57 · RUST 0.55 ·
   * BONE 0.73 — which §2 calls the biggest available win and which costs no geometry at all.
   *
   * ─── CLEARANCE: MEASURED, NOT ASSERTED ──────────────────────────────────────────────────
   * Walked over all seven poses × the five sway corners × the flourish signs, per vertex. The
   * model's worst vertex is UNCHANGED in every pose and every metric — still the pump floorplate
   * at reload (the offender this profile's `depthCompress` was solved against, and the reason
   * that number is not touched), still the choke everywhere else, still the forearm at the near
   * plane. The nearest any new part comes to being the offender is the forward clamp band at
   * 0.354 reach / 0.375 swayed, i.e. 41 mm inside the 0.40 budget and 15 mm behind the choke's
   * own number. Nothing here is forward of the muzzle or outboard of the hand.
   */
  {
    id: 'boomstick',
    /**
     * 0.58 — the RELOAD pose was the offender at 0.418 m, worst of any gun, then 0.403 at 0.64.
     * UNTOUCHED, and deliberately so: that pose's worst vertex is the PUMP, which this profile
     * does not move, so there is no headroom here to spend and nothing gained by re-solving it.
     */
    depthCompress: 0.62,
    restDz: 0.009,
    sight: {
      /**
       * A single bead on a low rear notch — a shotgun is pointed, not aimed.
       *
       * `frontZ` −0.110 → −0.076, and this is REQUIRED, not styling: with the receiver cut back
       * to a nose of −0.086 the blade was left standing 8 mm above thin air over the shroud. At
       * −0.076 the blade's front face is 6.5 mm inside the receiver's top face, so the post grows
       * out of the mass it belongs to and stands 16 mm proud of it — which IS the "raised post"
       * §1 asks for. The sight radius drops to 82 mm, which is correct for a gun whose own
       * comment says it is pointed rather than aimed.
       *
       * `lineY`, `rearZ`, `notchHalfGap` and the blade sizes are untouched, so the ADS solve
       * (`aimSocketOf` → `adsOffsetOf`) lands on exactly the numbers it already shipped.
       */
      lineY: 0.070, rearZ: 0.006, frontZ: -0.076,
      bladeW: 0.012, rearH: 0.018, frontH: 0.022, bladeD: 0.013, notchHalfGap: 0.012,
    },
    /**
     * THE THICKEST RECEIVER IN THE GAME, AND NOW SHORT ENOUGH TO READ AS THICK. 46 mm across
     * against the pistol's 32, the SMG's 30 and the marksman's 28 — and 106 mm long instead of
     * 128, cut entirely off the front (rear face still z 0.020). Width relative to LENGTH is what
     * the eye actually measures, and 46 × 106 reads as a brick where 42 × 128 read as a bar.
     */
    receiver: { w: 0.068, h: 0.056, d: 0.106, y: 0.030, z: -0.033 },
    /**
     * TWO, NOT THREE — an arithmetic consequence, and the right answer anyway. The serrations
     * march back from z 0.015 at a 17 mm pitch, and the ejection port's deflector needs the band
     * from −0.033 to −0.021; a third tooth would land at −0.029..−0.019 and interleave a 1 mm
     * proud tooth stack with a 5 mm proud port frame, losing both reads (the SMG note). A pump
     * gun's cocking read is the PUMP, so this is the one gun that can spend the serrations.
     */
    serrations: 2,
    /**
     * Fatter (r 0.020 → 0.022) and longer, because for the first time it is VISIBLE: it now
     * spans −0.130 to −0.066, bridging the receiver's nose and the choke's rear through the
     * 29 mm window the shortened receiver opened. Frame grey, so it is the mid value the polymer
     * shroud above it and the polymer cuts in its flanks both read against.
     */
    barrel: { r: 0.026, len: 0.064, y: 0.014, z: -0.098 },
    /** The bore. `fins: 0` — a plain flared choke, because the diameter IS the detail. */
    muzzle: { r: 0.034, len: 0.030, z: -0.130, fins: 0, finW: 0 },
    magazine: null,
    /**
     * Fatter tube (0.014 → 0.016) — more bore under the barrel — but the SAME y and z, and that
     * is a clearance decision rather than a taste one. The shared builder derives the PUMP from
     * `tube.y` / `tube.z`, and the pump is this gun's worst vertex in the reload pose at 0.395 m
     * against a 0.40 budget. Moving the tube forward by a millimetre moves the pump with it and
     * spends margin that does not exist. The pump's four grip ribs (§1's "ribbing that reads as
     * grip") are the builder's and are likewise left alone.
     */
    tube: { r: 0.020, len: 0.088, y: -0.012, z: -0.090 },

    /**
     * THE HEAT SHIELD, built out of the `foreEnd` slot — §1's first ask for this gun, and the
     * reason the receiver was shortened at all.
     *
     * IT IS THE `foreEnd` AND NOT `railTeeth` BECAUSE OF PARENTING, not because of shape. A heat
     * shield is clamped to the BARREL, and the barrel is in the static `frame` mesh; `railTeeth`
     * and everything else in `steel` ride the receiver, which reciprocates 14 mm on every shot.
     * A shroud that sheared 14 mm against the barrel it is bolted to would read as a bug on every
     * trigger pull. `foreEnd` is polymer and static, i.e. it holds still with its host — and it
     * is also DARK, so the shroud is a hard value break against the mid-grey barrel underneath
     * rather than a second grey box.
     *
     * IT BRIDGES BOTH MASSES ON PURPOSE. It spans z −0.082 to −0.118, overlapping the receiver's
     * nose (−0.086) by 4 mm and the choke's rear (−0.115) by 3 mm, so there is no floating gap at
     * either end and the three masses read as one assembly. It sits at y 0.019–0.041 over a
     * barrel that tops out at 0.036: a HALF-TUBE, covering the barrel's upper 17 mm and standing
     * 5 mm proud, with the round frame-grey underside showing all the way along.
     *
     * TWO RIBS, NOT THREE, AND THE REASON IS THE INK LINE. The builder spaces them across
     * `d × 0.68`; at two they are 24.5 mm apart with 14.4 mm of shroud showing between them,
     * which survives the 7 px hull on both the band AND the gap. At three the gap falls to 2.9 mm
     * and the whole stack prints as one black field — exactly the failure the cocking serrations
     * and the fore-end ribs each had once (see `inkChunk`). They are 2 mm proud on every face, so
     * each one is a step on the outline, which is the one kind of detail the ink cannot erase.
     */
    foreEnd: { w: 0.070, h: 0.030, d: 0.036, y: 0.030, z: -0.100, ribs: 2 },
    /**
     * NO STOCK, DELIBERATELY. A pistol-grip-only pump is the shape that says "this hurts to fire"
     * before it is fired, which is the whole brief for the 2.6 weaponKick — and a stock is the
     * one addition that would be spent at +z, where `nearClearance` (0.07 m, currently 0.084 at
     * sprint) is the tight budget rather than reach. Fewer, bolder, and out of the one direction
     * that has no room.
     */
    stock: null,
    /**
     * The warm rib, shortened with the receiver (d 0.090 → 0.076, so its nose lands at −0.071)
     * and DROPPED from y 0.0525 to 0.0505.
     *
     * THE DROP IS A SIGHT-PICTURE FIX, not tidying. The rib runs forward from the rear notch and
     * is therefore nearer the eye than the post at every ray below the sight line — the pistol's
     * rib once occluded all but 16 px of a 38 px post. Traced through the ADS solve: at a top of
     * 0.058 this rib's silhouette crossed the front plane at y 0.0578 and ate 3.8 mm of the
     * 16 mm of post that stands above the receiver; at a top of 0.056 it crosses at 0.0557 and
     * eats 1.7 mm. It still stands 2 mm proud of the receiver's 0.054 top face and still runs
     * from the notch to the base of the post, which is the job it was hired for.
     */
    rib: { w: 0.018, h: 0.011, d: 0.076, y: 0.0505, z: -0.033 },

    /**
     * THE BIGGEST EJECTION PORT IN THE GAME, WITH A SHELL IN IT — §1's second ask.
     *
     * SIZED BY THE RECEIVER'S SIDE FACE, NOT BY EYE. The receiver spans y 0.006–0.054. At
     * y 0.030 / h 0.022 the top lip tops out at 0.051 and the shelf bottoms at 0.009, so the
     * frame fills the face edge to edge with 3 mm of receiver showing above and below and nothing
     * climbs onto the top rail to start eating the sight picture from below.
     *
     * PLACED BY THE TWO THINGS IT MUST NOT TOUCH. The deflector's rear face lands at −0.021,
     * 9 mm clear of the last serration at −0.012; the front wall's face lands at −0.081, 5 mm
     * inside the receiver's new nose at −0.086. There is exactly one 8 mm window of z where a
     * 38 mm port fits between those two, and this is it.
     *
     * THE BRASS IS THE POINT. `shellR` 0.008 is 16 mm of RUST across a 22 mm opening — the
     * fattest round in the game, against the pistol's and the SMG's 12 mm, because a shotgun
     * shell IS fat and because this is the one warm mark on the gun that is not on the outline:
     * a hot dot in the middle of the one rectangle the eye is drawn to.
     */
    ejectionPort: { h: 0.022, d: 0.038, y: 0.030, z: -0.052, shellR: 0.008 },
    /**
     * NO CHARGING HANDLE. This gun's charging handle is the pump, it is 44 mm across, the support
     * hand is wrapped around it and the reload animation racks it. A second cocking device on the
     * receiver would be a lie about the mechanism and would hand back the asymmetry §0 asks for,
     * since the right side is already spent on the port.
     */
    chargingHandle: null,
    /**
     * THE CROSS-BOLT SAFETY, built out of the `selector` slot — a round boss with a bar swung off
     * it is precisely a safety button and its detent lever, and it is what a pump gun has instead
     * of a fire selector.
     *
     * It sits at y 0.012, in the seam between the receiver's 0.006 underside and the frame body,
     * at z −0.010 — directly above the trigger, where a cross-bolt safety lives, and 21 mm above
     * the thumb's top edge at −0.009 so the two masses never fuse. The lever sweeps 20° DOWN and
     * back, which points it at the trigger finger rather than at nothing. LEFT side, because the
     * right is the port: the two faces of this gun now carry different events, which is §0's
     * asymmetry lever, and the left is the face the rest pose actually shows the player.
     */
    selector: { r: 0.008, len: 0.026, thick: 0.012, y: 0.012, z: -0.010, angleDeg: -20 },
    /**
     * NO MAG WELL. There is no magazine — the shells go up the tube, and the `magazine` slot on
     * this gun is spent on the pump. A flared collar at the butt would be a funnel into a grip
     * that nothing is ever inserted through, which is the one thing the part is not allowed to be.
     */
    magWell: null,
    /**
     * EARS ROUND THE BEAD. `gap` IS SOLVED, NOT PICKED. The rear notch sits 0.235 m from the eye
     * and the front post 0.283 m (the 82 mm between them, compressed by 0.58), so the notch's
     * ±0.012 window projects to ±0.0144 at the front plane. At 0.020 the ears stand 5.6 mm
     * OUTSIDE that window and take away none of the light bars — the exact number cleared, not
     * the builder's ×1.5 heuristic (0.018) scraped.
     *
     * `thick` 0.012 rather than the other guns' 0.011: on the gun whose whole identity is mass,
     * the ears are the top corners of the front silhouette and they should be the heaviest ears
     * in the game. `rise` 0.002 keeps their tops just above the sight line so they are the last
     * thing the outline crosses on the way up, and they run from the receiver's 0.054 top face,
     * so they read as forged out of it rather than perched on it.
     */
    /**
     * THE SHIELD'S TWO CUTOUTS — and they are hosted on the BARREL, which is the whole trick.
     *
     * `panels` emits POLYMER, and polymer cuts on a polymer shroud would be one dark mass with
     * invisible detail in it: the part only reads because of the value break between the cut and
     * its host. So the cuts go on the frame-grey BARREL instead, in the 15 mm band between the
     * shroud's lower edge (0.019) and the pump's top (0.005) — which is exactly where a heat
     * shield's slots are, and where the eye reads them as holes THROUGH the shroud into a dark
     * interior rather than as tiles stuck onto it.
     *
     * `hostHalfW` is the barrel's radius, so at the barrel's equator each cut sits 2.5 mm proud
     * of a 44 mm round mass — a bitten-out step, not a plate. Two, on BOTH flanks: this is the
     * one detail on the gun that is allowed to be symmetric, because a shield with vents down one
     * side only would read as damage. The asymmetry budget is spent on the port and the safety.
     *
     * z −0.090 → −0.088, AND IT IS THE VISIBLE LENGTH THAT IS BEING FLOORED, NOT THE MODELLED
     * ONE. The bare-barrel window is only 29 mm wide (receiver nose −0.086 → choke rear −0.115)
     * and two 16 mm cuts on a 24 mm pitch span 42 mm, so each one has an end buried inside a
     * neighbour: at −0.090 the forward cut ran to −0.122, i.e. SEVEN millimetres of it sat
     * inside the choke can and only 9 mm showed — under the ink floor, which is a floor on what
     * the player can see. Two millimetres rearward splits the overhang evenly and leaves 10 mm
     * of the rear cut and 11 mm of the forward one exposed, both clear of the floor. It also
     * moves geometry BACKWARD, so it costs negative reach.
     *
     * The 8 mm land between them is the one number here that does not clear 10 mm, and it
     * cannot: the window is 29 mm and 2 × 10 + 10 does not fit in it. It is the same 7-8 mm the
     * cocking serrations have always run at, where the gap is meant to read as an ink LINE
     * rather than as daylight.
     */
    panels: {
      count: 2, side: 'both', h: 0.012, d: 0.016,
      y: 0.014, z: -0.088, step: 0.024, hostHalfW: 0.022,
    },
    /**
     * NO RAIL TEETH. The top face is 46 mm wide and already carries the RUST rib for its full
     * length, and anything standing on top of the rib runs forward of the rear notch and occludes
     * the post from below — `guardSightLine`'s ceiling here is 0.060 and the rib is already at
     * 0.056. This gun's top is spoken for, and it is spoken for by the one warm mark that leads
     * the eye to the bead.
     */
  },
  /**
   * LONGSHOT — the longest thing in the game, and the only one with a full stock. A raised
   * ghost-ring rail rather than a scope tube (see the header note): the rear aperture sits
   * 30 mm above the pistol's line, which is what makes the ADS picture read as precision.
   *
   * ─── THE BUG THIS PROFILE EXISTS TO FIX ──────────────────────────────────────────────────
   * "Raised ghost-ring rail" was a lie the geometry never told. `sight.lineY` is 0.098 and the
   * receiver's top face was 0.055, so the rear blades' bottoms sat at 0.068 and the front
   * blade's at 0.064 — THIRTEEN AND NINE MILLIMETRES OF AIR under three floating slabs, with
   * nothing between them and the gun. The rear pair also stood at x ±0.019 on a receiver that
   * was ±0.014 wide, i.e. outboard of their own host as well as above it. Nothing was raising
   * the sights; they were simply authored high. That is why this gun was flagged as the most
   * likely to look wrong, and it is the first thing fixed below: `railTeeth` is spent as the
   * RAIL, not as decoration, and it runs from under the rear aperture to under the front post.
   *
   * ─── THE ONE STRUCTURAL CHANGE, AND WHY IT IS THE WHOLE SILHOUETTE ────────────────────────
   * The receiver was 200 mm and the barrel was buried inside it: with a nose at −0.176, a
   * handguard running to −0.189 and the choke's rear at −0.201, exactly TWELVE MILLIMETRES of
   * barrel were visible on the longest gun in the game. §1 asks this rifle for a long fluted
   * barrel and there was no barrel to flute. The receiver is now 170 mm, cut from the FRONT (its
   * rear face stays at z 0.024, so the hammer, the hand and the sight's `rearZ` did not move),
   * and the handguard is shorter and pulled back to −0.150 — which opens a 51 mm window of bare
   * round barrel between the handguard's nose and the choke. Both edits DELETE geometry from the
   * −z end, so the change costs negative reach.
   *
   * The barrel is also lifted from y 0.014 to 0.034, onto the receiver's own axis. It was 20 mm
   * BELOW the muzzle can (which the builder places at `receiver.y`), which nobody could see
   * while it was inside the receiver and everybody would see the moment it was exposed: a round
   * barrel entering the back of a can it does not line up with.
   *
   * Silhouette is now five events instead of two: stock → long receiver under a slotted rail →
   * hard step down → bare fluted barrel → the can. Plus a bolt handle out to the right and a
   * bipod stub hanging under the handguard, which are the two events on the OUTLINE — the one
   * kind of detail the ink line cannot erase, because the ink line *is* the outline.
   *
   * ─── WHAT §1 ASKS THIS GUN FOR, AND WHERE EACH ONE LANDED ─────────────────────────────────
   *   a proper scope-rail with bold teeth  → `railTeeth`, five 46 mm crossbars, and they are
   *                                          STRUCTURAL: they are what the sights stand on
   *   a cheek riser on the stock           → the `stock` slot, raised and pushed FORWARD into
   *                                          the receiver; see the note there for the trade
   *   a bipod stub under the fore-end      → `magWell` repurposed: a block with a flared foot,
   *                                          hung under the handguard's nose
   *   2–3 bold flutes along the barrel     → `panels`, hosted on the BARREL, in the window the
   *                                          shortened receiver opened
   *   a bolt handle out to the RIGHT       → `chargingHandle`, at the rear of the action
   * plus the "every gun gets" list: an ejection port with brass in it, a lever on the left, and
   * protective ears round the front post.
   *
   *   top            five steel crossbars carrying both sights     (steel, rides receiver)
   *   front-top      ears round the post, standing ON the rail     (sights, lighter ink)
   *   rear-right     bolt handle standing 20 mm off the action     (steel, rides receiver)
   *   mid-right      ejection port frame + brass in the port       (steel + RUST, receiver)
   *   mid-left       bolt-release lever swung down and back        (polymer, static)
   *   front-flanks   two bold flutes bitten out of the barrel      (polymer, static)
   *   front-low      bipod stub + flared foot under the handguard  (polymer, static)
   *
   * FIVE value fields on one outline — polymer 0.29 · frame 0.44 · steel 0.57 · RUST 0.55 ·
   * BONE 0.73 — which §2 calls the biggest available win and which costs no geometry at all.
   *
   * ─── CLEARANCE: MEASURED, NOT ASSERTED ───────────────────────────────────────────────────
   * Walked per vertex over all seven poses × the five sway corners × the flourish signs. The
   * model's worst vertex is UNCHANGED in every pose and every metric, to four decimals — still
   * `muzzle.fin3` at 0.3941 reach / 0.4146 swayed, still the magazine at reload (0.3792 /
   * 0.4087), still the forearm at the near plane (0.0893 at sprint). Nothing added here is
   * forward of the muzzle or outboard of the hand: the highest-ranked NEW part is a sight ear at
   * 0.3775 reach / 0.4004 swayed — 22 mm inside the reach budget and 20 mm inside `MOVE.radius`
   * — then the barrel flutes at 0.3747, the rail's front tooth at 0.3599, the bipod foot at
   * ~0.349, the port at 0.3300 and the bolt handle at 0.3005, which is a full 100 mm of slack.
   * The stock moving FORWARD also bought near-plane margin rather than spending it.
   */
  {
    id: 'longshot',
    /**
     * The most compressed, because it is authored the longest. 0.46 is MEASURED: at 0.52 this
     * gun reached 0.426 m — past the 0.40 budget AND past `MOVE.radius` (0.42), i.e. it would
     * genuinely have punched the muzzle through walls. Its forward parts were shortened too;
     * compression alone would have squashed it into looking short rather than long.
     *
     * UNTOUCHED, and deliberately: the pose that binds it is REST/EQUIP on `muzzle.fin3`, and
     * this profile does not move the muzzle by a millimetre, so there is no headroom here to
     * spend and nothing to gain by re-solving it.
     */
    depthCompress: 0.50,
    restDz: 0.016,
    sight: {
      /**
       * `lineY` and `rearZ` ARE THE AIM SOLVE and they are byte-identical to what shipped —
       * `aimSocketOf` reads exactly those two numbers, so `adsOffsetOf` lands on the same
       * translation and the boot assertion still reports the socket dead on the camera axis.
       * Everything else in this block is sight PICTURE, which is a different contract.
       *
       * `frontZ` −0.156 → −0.132, and this is REQUIRED, not styling: with the receiver cut back
       * to a nose of −0.146 the blade would have been left standing 43 mm above thin air, out
       * past the end of its own host. At −0.132 its front face is 7 mm inside the receiver's
       * nose and it stands on the rail's front tooth, which is what makes the post read as
       * MOUNTED. The sight radius falls to 152 mm; what the player actually reads as precision
       * is the 43 mm the sight line stands above the receiver's top face, and that is unchanged.
       *
       * `notchHalfGap` 0.013 → 0.012 IS A GEOMETRY CONSTRAINT ON THE EARS, not taste. The
       * builder (correctly) refuses a wing inside the rear notch's window projected forward, and
       * at 0.013 the smallest legal `sightWings.gap` was 0.0195 — which would have stood the
       * ears 5.5 mm off a receiver only ±0.016 wide, i.e. floating, which is the exact failure
       * this whole profile is here to end. At 0.012 the ears come in to 0.019 and land on the
       * rail. The picture gets WIDER light bars, not narrower: the notch projects to ±0.0156 at
       * the front plane against a 6 mm post half-width, giving 0.0314 rad of bar per side
       * against the pistol's 0.0253.
       */
      lineY: 0.098, rearZ: 0.020, frontZ: -0.132,
      bladeW: 0.012, rearH: 0.030, frontH: 0.034, bladeD: 0.013, notchHalfGap: 0.012,
    },
    /**
     * 170 mm, not 200, cut entirely off the FRONT (rear face still z 0.024) — see the header
     * note. 32 mm wide rather than 28: the sights and the rail both stand on this face, and a
     * ±0.014 host under a ±0.024 sight assembly is what "floating" looks like from the side.
     * At 32 × 170 it is still the slimmest long gun by ratio (5.3:1 against the shotgun's 2.3).
     */
    receiver: { w: 0.026, h: 0.040, d: 0.170, y: 0.034, z: -0.061 },
    /**
     * NONE, AND THAT IS THE MECHANISM SPEAKING. Cocking serrations are a slide's cocking read
     * and this gun does not have a slide — it has a BOLT, which is now modelled, sticks out to
     * the right and is the biggest silhouette event on the weapon. Three 1 mm-proud teeth in the
     * band z 0.014…−0.020 would also have interleaved with the port's 5 mm-proud deflector at
     * −0.030…−0.018 and lost both reads, which is the failure the SMG and the shotgun each
     * documented. The rear of this receiver now carries the rail's first tooth on top, the bolt
     * handle to the right, the release lever to the left and the RUST spur behind — it is the
     * busiest 40 mm on the gun without them.
     */
    serrations: 0,
    /**
     * LIFTED ONTO THE RECEIVER'S AXIS (y 0.014 → 0.034) and fattened to r 0.014. Both are
     * consequences of it becoming visible for the first time: the builder places the muzzle can
     * at `receiver.y`, so at 0.014 the barrel entered the back of the can 20 mm low, and a
     * 28 mm barrel between a 32 mm receiver and a 34 mm can is the taper a heavy barrel wants.
     * Spans −0.114…−0.218, so it bridges the receiver's nose and the choke's rear with 51 mm of
     * bare round in between.
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
     * THE HANDGUARD, SHORTER AND PULLED BACK — the other half of the barrel window.
     *
     * 82 → 76 mm and its nose moved from −0.189 to −0.150, which leaves the barrel bare from
     * there to the choke. It is RAISED with the barrel (y −0.006 → 0.004) so its top face at
     * 0.022 still overlaps the barrel's underside by 2 mm and the receiver's by 9 mm: no
     * floating gap at either end, which is the thing that makes three masses read as one
     * assembly.
     *
     * FOUR RIBS → THREE, AND THE REASON IS THE INK LINE. The builder spaces them across
     * `d × 0.68`; at four on a 76 mm block the gaps fall to 7.6 mm, under the band, and the
     * whole stack prints as one black field — the failure `inkChunk` exists to stop and the one
     * the fore-end ribs already had once. At three the pitch is 25.8 mm and 15.8 mm of
     * handguard shows between 10 mm ribs, so both the rib AND the gap survive the line.
     */
    foreEnd: { w: 0.028, h: 0.032, d: 0.076, y: 0.004, z: -0.112, ribs: 3 },
    /**
     * THE STOCK, AND WHAT IT IS DOING ABOUT §1's CHEEK RISER.
     *
     * It shipped FLOATING: its front face was at z 0.030 against a receiver whose rear face is
     * 0.024, so there were six millimetres of daylight between the butt and the action. It now
     * starts at 0.021 and overlaps by 3 mm, and the comb rises from 0.040 to 0.044 — 11 mm under
     * the receiver's top face, which is a cheek-weld line rather than a slab that stops nowhere
     * in particular. It is 2 mm wider than the receiver, so the shoulder is a step on the
     * outline, and the butt pad the builder adds is a second step 3 mm proud of that.
     *
     * A SEPARATE RAISED COMB IS THE ONE §1 ASK THIS PROFILE DOES NOT SPEND A SLOT ON. There is
     * no comb part in the vocabulary; the only slot shaped like one is `magWell`, and at this
     * gun's rest pose (x +0.125, yaw −14°) the buttstock sits in the far bottom-right corner of
     * the frame while the handguard's underside is dead centre — so the slot goes to the bipod
     * stub, which is on the outline in the zone the player actually looks at. Comb geometry buys
     * nothing where nobody is looking.
     *
     * The comb stops SHORT of burying the RUST hammer spur, deliberately: at a top of 0.044 the
     * spur still stands 9 mm proud of it, and the spur is the rearmost warm mark on the model.
     */
    stock: { w: 0.032, h: 0.060, d: 0.118, y: 0.014, z: 0.080, skeleton: false },
    /**
     * The warm rib, shortened with the receiver (140 → 120 mm) so its nose lands at −0.126,
     * half a millimetre behind the front post's rear face — it still runs from the notch to the
     * base of the post, which is the job it was hired for. Its top stays at 0.060, which is
     * 9 mm UNDER the rail teeth above it, so the teeth are 46 mm of steel crossing a 13 mm warm
     * line and the RUST shows through the 18.5 mm gaps between them rather than being covered.
     *
     * It cannot occlude the sight picture from here: traced through the ADS solve its silhouette
     * crosses at −0.126 rad against the front post's bottom at −0.112, i.e. it passes below the
     * post at every ray. The rail above it is the part that had to be checked; see there.
     */
    rib: { w: 0.013, h: 0.011, d: 0.120, y: 0.0545, z: -0.066 },

    /**
     * THE EJECTION PORT, AND ON THIS GUN IT IS THE BOLT'S PORT — the longest in the game at
     * 44 mm, because a marksman cartridge is long and because the bolt handle 54 mm behind it
     * has to read as the thing that opens it.
     *
     * SIZED BY THE RECEIVER'S SIDE FACE, NOT BY EYE. The receiver spans y 0.013…0.055. At
     * y 0.034 / h 0.020 the top lip tops out at 0.054 and the shelf bottoms at 0.014, so the
     * frame fills the face edge to edge with a millimetre of receiver showing above and below
     * and nothing climbs onto the top face, where the rail and the sight picture live.
     *
     * PLACED BY THE TWO THINGS IT MUST NOT TOUCH. The deflector's rear face lands at −0.018,
     * eleven millimetres clear of the bolt paddle's front face at −0.007 — the two proudest
     * steel masses on this flank, and they must not fuse into one smear. The front wall lands at
     * −0.084, sixty-two millimetres inside the receiver's nose.
     *
     * `shellR` 0.006 is 12 mm of RUST across a 20 mm opening: a rifle case is SLIM, which is why
     * this is the pistol's and the SMG's round rather than the shotgun's 16 mm. It is the one
     * warm mark on the gun that is not on the outline — a hot dot in the middle of the one
     * rectangle the eye is drawn to.
     */
    ejectionPort: { h: 0.020, d: 0.044, y: 0.034, z: -0.052, shellR: 0.006 },
    /**
     * THE BOLT HANDLE — §1's "strongest possible *this is a rifle* silhouette event", and the
     * only part on any of the four guns that is allowed to stick out to the RIGHT.
     *
     * ITS SIZE IS THE BUDGET SPEAKING. `len` 0.018 puts the paddle's outer face at x 0.036,
     * which makes it the model's widest +x point — 7 mm outboard of the gloved fist. That is
     * affordable only because it sits at z 0.002, i.e. essentially ON the eye's own depth, and
     * reach is a hypotenuse: MEASURED, the paddle's worst pose is 0.3005 m reach / 0.3247 swayed
     * against budgets of 0.40 and 0.42. A hundred millimetres of slack. The same 20 mm of
     * stand-off hung off the muzzle end would have blown the budget on its own.
     *
     * PLACED AT THE REAR OF THE ACTION, WHICH IS WHERE A BOLT GUN PUTS IT: z 0.002 is 11 mm
     * behind the port's deflector and 10 mm forward of the stock's front face, in the one window
     * on this flank that is not already spoken for. `thick` 0.013 gives a 14 mm stem standing
     * proud of the receiver and a 12 × 25 × 18 mm paddle on the end of it, so the shape ends in
     * the builder's HOOK — a hook survives the ink line and a taper does not.
     */
    chargingHandle: { side: 'right', len: 0.018, thick: 0.013, y: 0.028, z: 0.002 },
    /**
     * THE BOLT RELEASE, built out of the `selector` slot. A round boss with a bar swung off it,
     * on the LEFT of the action, is exactly what a bolt rifle has there — and this gun's
     * fire-selector real estate does not exist, because it does not have a fire selector.
     *
     * The boss straddles the receiver's lower edge (y 0.012…0.028 against a receiver bottom of
     * 0.013), which is what makes it read as a control let INTO the action rather than a button
     * stuck onto it. The lever sweeps 14° down and back to y 0.013, nineteen millimetres above
     * the gloved fist's top edge at −0.006 and seventeen above the thumb's — the two masses can
     * never fuse, and the eye is already at the thumb.
     *
     * LEFT, because the right flank is spent on the port and the bolt: this gun is a different
     * object from each side, which is §0's asymmetry lever, and the rest pose (x +0.125, yaw
     * −14°) shows the player the LEFT face all session.
     */
    selector: { r: 0.008, len: 0.028, thick: 0.012, y: 0.020, z: -0.012, angleDeg: -14 },
    /**
     * THE BIPOD STUB — §1's third ask, built out of the `magWell` slot, which this gun's own
     * magazine has no use for (see the note there: it is buried inside the fist).
     *
     * A block with a flared collar under it IS a bipod's mounting lug with its leg pack folded
     * against the barrel, and the slot's `MAG_RAKE` cant of 17° is what sells it as a folded
     * mechanism rather than a box glued on. It hangs from y −0.016 (2 mm up inside the
     * handguard, so there is no floating gap) down to −0.051, and the collar is 28 mm across
     * against the handguard's 34 — narrower than its host, so it reads as a separate hanging
     * part instead of a thickening of the same one.
     *
     * IT IS THE BOTTOM OUTLINE'S ONLY EVENT FORWARD OF THE TRIGGER GUARD, which is why the slot
     * went here rather than on the comb. That edge ran dead straight from the hand to the muzzle
     * and now reads guard (−0.062) → lower rail (−0.030) → notch → bipod foot (−0.051) →
     * handguard (−0.014) → bare barrel. MEASURED at ~0.349 reach: 51 mm inside the budget,
     * because it is tucked under the handguard's nose rather than hung past it.
     */
    magWell: { w: 0.018, h: 0.022, d: 0.024, y: -0.030, z: -0.132, flare: 0.005 },
    /**
     * EARS ROUND THE POST — and on this gun they do a second job the other three do not need:
     * they are 44 mm tall, running from the sight line all the way DOWN to the receiver's top
     * face, so they are the mass that stops the front blade floating 43 mm above its own gun.
     *
     * `gap` IS SOLVED, NOT PICKED. The rear notch sits 0.235 m from the eye and the front post
     * 0.305 m (the 152 mm between them, compressed by 0.46), so the notch's ±0.012 window
     * projects to ±0.0156 at the front plane. At 0.019 the ears stand 3.4 mm OUTSIDE that window
     * and take away none of the light bars — the exact number cleared, not the builder's ×1.5
     * heuristic (0.018) scraped. Their inner faces are 3 mm outboard of the receiver's side
     * face, and the rail's front tooth (±0.023) is directly under them, so they land on steel.
     *
     * They are in `sightParts`, so they ride the receiver and carry `view.sightOutlinePx` rather
     * than the 7 px silhouette line — 44 mm of blade either side of the post would otherwise be
     * the heaviest ink on the gun.
     */
    /**
     * TWO BOLD FLUTES PER FLANK, HOSTED ON THE BARREL — §1's fluted barrel, in the 51 mm window
     * the shortened receiver and the pulled-back handguard opened between them.
     *
     * THE HOST IS THE POINT. `panels` emits POLYMER, so a flute cut into the polymer handguard
     * would be one dark mass with invisible detail in it; on the frame-grey barrel it is a hard
     * value break, which §2 calls the cheapest quality lever we have. `hostHalfW` is the
     * barrel's radius, so at the equator each cut stands 2.5 mm proud of a 28 mm round — a
     * bitten-out step, not a plate.
     *
     * Two of 20 mm at a 30 mm pitch leaves a 10 mm land between them, exactly the ink floor:
     * the GAP has to survive the line as well as the cut does, which is the lesson the cocking
     * serrations learned at a 6 mm pitch. They run −0.153…−0.203, i.e. from 3 mm forward of the
     * handguard's nose to just under the choke, so the flutes span the whole exposed length.
     *
     * BOTH flanks, and that is deliberate: a barrel fluted down one side only would read as
     * damage. The asymmetry budget on this gun is spent on the bolt and the release lever.
     */
    panels: {
      count: 2, side: 'both', h: 0.014, d: 0.020,
      y: 0.034, z: -0.163, step: 0.030, hostHalfW: 0.014,
    },
    /**
     * THE SCOPE RAIL — five bold crossbars, and unlike every other gun's use of this part they
     * are STRUCTURAL. They are what both sights stand on.
     *
     * THE HEIGHT IS SOLVED FROM THE BLADES, NOT PICKED. The receiver's top face is 0.055 and the
     * rear blades' bottoms are 0.068; a tooth of h 0.014 at y 0.062 sits bottom-flush on the
     * face and tops out at 0.069, so it closes that 13 mm of daylight exactly and the aperture
     * lands on metal. The front blade's bottom (0.064) then sits 5 mm INSIDE the front tooth, so
     * the post grows out of the rail instead of hovering over it.
     *
     * THE SPAN IS SOLVED FROM THE SAME TWO NUMBERS. `z` 0.014 puts the first tooth under the
     * rear aperture (z 0.020) and a `step` of 0.0365 lands the fifth on the front post's z
     * (−0.132) to the millimetre. 18 mm teeth on a 36.5 mm pitch leave 18.5 mm of gap — tooth
     * and gap both clear the ink floor by 8 mm, which is what stops five bars printing as one.
     *
     * AND THE SIGHT-PICTURE CHECK, WHICH IS THE ONE THAT KILLS RAILS. Everything on top of a
     * receiver runs FORWARD of the rear notch and is therefore NEARER the eye than the post at
     * every ray below the sight line — the pistol's rib once ate all but 16 px of a 38 px post.
     * Traced through the ADS solve: the REAR tooth crosses at −0.122 rad, below the post's
     * bottom at −0.112, so it never enters the picture at all; the FRONT tooth crosses at
     * −0.095, but it sits at the post's own depth (both 0.305 m, since `step × 4` lands it on
     * `frontZ`) — it is not occluding the post, it IS the post's base. Every tooth between the
     * two is bounded by those. The picture reads as 29 mm of BONE standing out of a rail, which
     * is what a ghost ring is supposed to look like. (`guardSightLine`'s ceiling here is 0.088
     * and the teeth top out at 0.069, clearing it by 19 mm rather than by nothing.)
     *
     * 46 mm wide against a 32 mm receiver — 7 mm proud per side, so the rail overhangs its own
     * host and puts a real depth step down the whole length of the flank the player looks at,
     * and the rear blades at ±0.024 land within a millimetre of its edge. Steel, so it rides the
     * receiver, as do the sights bolted to it and the warm rib underneath — the only reason the
     * three can share a face.
     */
  },
];

function profileFor(id: string): GunProfile {
  return PROFILES.find((p) => p.id === id) ?? (PROFILES[0] as GunProfile);
}

/**
 * THE AIM SOCKET — the rear-sight notch, in ROOT-LOCAL space (post-`MODEL_SCALE`, post-
 * `depthCompress`). This is the point the ADS solve puts on the camera's forward axis.
 *
 * Solved PER PROFILE: four receivers at four heights cannot share one socket without putting the
 * sight picture off the bullet on three of them.
 */
function aimSocketOf(p: GunProfile): Vector3 {
  return new Vector3(0, p.sight.lineY * MODEL_SCALE, p.sight.rearZ * MODEL_SCALE * p.depthCompress);
}

/**
 * THE SOLVED ADS TRANSLATION. Rotation at full ADS is identity (see `compose`), so the socket
 * lands at `(0, 0, −adsSightDistance)` in camera space exactly when the root sits here.
 */
function adsOffsetOf(socket: Vector3): { x: number; y: number; z: number } {
  return { x: -socket.x, y: -socket.y, z: -V.adsSightDistance - socket.z };
}

/**
 * PER-GUN REST OFFSET ALONG Z — how a rifle is allowed to be longer than a pistol.
 *
 * The two spatial budgets pull in opposite directions: reach (<= 0.40) wants the gun close to the
 * body, the near plane (>= 0.07) wants it far from the eye. Every gun was authored against ONE
 * shared rest pose, so each was independently squashed with `depthCompress` until it fitted —
 * and the result was that they all converged on the same apparent size. MEASURED, gun bodies
 * only: the SMG and the rifle came out 0.181 and 0.186 long, 3% apart, with all four inside a
 * 5.6–6.7 cm width band. Four slim sticks. The playtester's note — "weapons all look like the
 * same gun" — was a correct reading of a real geometric fact.
 *
 * But the two budgets are not spent evenly. Measured margins:
 *   inkslinger  reach 0.393 (7 mm spare) · near 0.072 (2 mm spare)   → pinned, cannot move
 *   ratatat     reach 0.387 (13 mm)      · near 0.088 (18 mm)
 *   boomstick   reach 0.393 (7 mm)       · near 0.087 (17 mm)
 *   longshot    reach 0.393 (7 mm)       · near 0.117 (**47 mm**)
 *
 * The rifle is nowhere near the near plane. Sliding it BACK toward the eye spends the margin it
 * has and BUYS the margin it does not — a smaller |z| at the deepest vertex is directly a smaller
 * reach — which is then spent on being visibly the longest gun in the game. That is the trade
 * this field exists to make, and it is why the guns can finally differ from one another.
 *
 * Positive = toward the eye (the near plane), negative = away. Applied to the REST pose only;
 * ADS is solved from the sight socket and must not be touched.
 */
let REST_DZ = 0;

/** The active model's solve. Rebound by `equip()`; the pistol's until then. */
let AIM_SOCKET = aimSocketOf(PROFILES[0] as GunProfile);
let ADS = adsOffsetOf(AIM_SOCKET);
let ADS_X = ADS.x;
let ADS_Y = ADS.y;
let ADS_Z = ADS.z;

/** One built weapon: its geometry, its subtree, and its own solved aim socket. */
interface GunModel {
  id: string;
  geo: GunGeometry;
  group: Group;
  slideMesh: Object3D;
  magMesh: Object3D;
  socket: Vector3;
  ads: { x: number; y: number; z: number };
  restDz: number;
}

interface GunGeometry {
  /** Static lower: frame, barrel, trigger guard. */
  frame: BufferGeometry;
  /**
   * THE DARK FIELD — the parts a hand touches: grip, heel, fore-end, stock, mag well, selector,
   * stamped panels. Static (parented to the root group).
   *
   * WEAPON_ART §2 calls material separation "the biggest available win", and it is the cheapest
   * one we have: the ink style gives us flat colour fields, so a hard value break between two
   * adjacent masses reads as detail at ZERO geometric cost and zero ink risk. Almost the entire
   * gun used to be one grey, which is precisely why it read flat no matter how many boxes it had.
   */
  polymer: BufferGeometry;
  /**
   * THE LIGHT FIELD — machined metal: ejection-port frame, charging handle, rail teeth, trigger.
   * Parented to the SLIDE, so all of it reciprocates on a shot.
   */
  steel: BufferGeometry;
  /** Reciprocating upper: the slide mass and its serrations. */
  slide: BufferGeometry;
  /** The sights. Their own mesh, riding the slide, so they can carry their own lighter ink. */
  sights: BufferGeometry;
  /** Accent trim: muzzle brake, trigger. */
  trim: BufferGeometry;
  /** The ONE warm read, frame half: taped grip + hammer spur (RUST). */
  accent: BufferGeometry;
  /** The warm read's slide half — parented to the slide so it reciprocates with it. */
  accentSlide: BufferGeometry;
  /** The gloved fist, thumb and forearm holding the thing. */
  hand: BufferGeometry;
  /** The magazine — animated separately during a reload. */
  magazine: BufferGeometry;
  /** Emissive muzzle core (GOLD, bloom layer). */
  core: BufferGeometry;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * MINIMUM PART THICKNESS IS A FUNCTION OF THE INK WEIGHT, NOT OF TASTE.
 *
 * Same law `enemies/defs.ts` states for the Shambler, and it was being broken here. The
 * inverted hull inflates the silhouette by a SCREEN-SPACE amount, so at
 * `READABILITY.VIEWMODEL_OUTLINE_PX` (7 px) a part needs more than ~14 px of screen width or it
 * has no albedo left between its two inflated faces and renders as SOLID INK.
 *
 * Measured: the gun sits ~0.30 m from the eye at `CAMERA.fovBase` 78°, which is ~8.7 px per
 * degree on a 679-px-tall viewport — so 0.008 m of real width is 13 px on screen. The trigger
 * guard (0.008), the trigger (0.006), the muzzle fins (0.005) and the front sight (0.006) were
 * therefore ALL under the ink band and all printed as black blobs. That is most of why the art
 * review measured "five untextured boxes with no trigger guard and no barrel read": the parts
 * were modelled, they were just being erased by the line every frame.
 *
 * Nothing structural on this gun is under 0.010 m any more.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
function buildGunGeometry(P: GunProfile = PROFILES[0] as GunProfile): GunGeometry {
  const SIGHT = P.sight;
  const frameParts: BufferGeometry[] = [];
  const polymerParts: BufferGeometry[] = [];
  const steelParts: BufferGeometry[] = [];
  const slideParts: BufferGeometry[] = [];
  const sightParts: BufferGeometry[] = [];
  const trimParts: BufferGeometry[] = [];
  const accentParts: BufferGeometry[] = [];
  const accentSlideParts: BufferGeometry[] = [];
  const handParts: BufferGeometry[] = [];
  const magParts: BufferGeometry[] = [];

  // ── lower frame ────────────────────────────────────────────────────────────────────────
  const body = bevelBox(0.028, 0.030, 0.112, 0.006, 11);
  place(body, { y: -0.004, z: -0.044 });
  frameParts.push(body);

  // Dust cover / rail block under the barrel — the chunk that makes the silhouette read.
  const rail = bevelBox(0.026, 0.017, 0.062, 0.005, 12);
  place(rail, { y: -0.021, z: -0.070 });
  frameParts.push(rail);

  // ── grip: raked back, tapered, with a flared heel ──────────────────────────────────────
  // POLYMER, not frame grey. The hand touches it, so it is the dark end of the value ladder —
  // and a dark grip under a TEAL glove is what stops the two masses fusing into one blob.
  const grip = bevelBox(0.030, 0.098, 0.044, 0.008, 13);
  place(grip, { rx: 0.30 });
  place(grip, { y: -0.062, z: 0.016 });
  polymerParts.push(grip);

  const heel = bevelBox(0.033, 0.014, 0.050, 0.005, 14);
  place(heel, { rx: 0.30 });
  place(heel, { y: -0.108, z: 0.030 });
  polymerParts.push(heel);

  // ── trigger guard: three bars, faceted like an inked curve ─────────────────────────────
  // 0.008 → 0.014: under the ink band the whole guard printed solid black, which is why the
  // review read "no trigger guard". See the block comment above `buildGunGeometry`.
  const guardFront = bevelBox(0.014, 0.034, 0.014, 0.003, 15);
  place(guardFront, { rx: -0.30 });
  place(guardFront, { y: -0.036, z: -0.052 });
  frameParts.push(guardFront);

  const guardBottom = bevelBox(0.014, 0.014, 0.046, 0.003, 16);
  place(guardBottom, { rx: 0.12 });
  place(guardBottom, { y: -0.052, z: -0.032 });
  frameParts.push(guardBottom);

  const guardBack = bevelBox(0.014, 0.024, 0.014, 0.003, 17);
  place(guardBack, { rx: 0.34 });
  place(guardBack, { y: -0.042, z: -0.012 });
  frameParts.push(guardBack);

  // ── barrel: a real cylindrical read poking out under the slide's nose ──────────────────
  // The "no barrel read" note. The muzzle brake sits ON the slide line; this is the round mass
  // beneath it that says "gun" in silhouette before any detail resolves.
  const barrel = inkCylinder(P.barrel.r, P.barrel.len, 7, { seed: 18 });
  place(barrel, { rx: Math.PI * 0.5 });
  place(barrel, { y: P.barrel.y, z: P.barrel.z });
  frameParts.push(barrel);

  // ── the fore-end: what the SUPPORT hand is on ──────────────────────────────────────────
  // A vertical grip (SMG) or a long handguard (marksman). The ribs are what stop a plain box
  // reading as a plain box at the one part of the gun the eye tracks while you are moving.
  if (P.foreEnd) {
    const fe = P.foreEnd;
    const block = bevelBox(fe.w, fe.h, fe.d, 0.005, 81);
    place(block, { y: fe.y, z: fe.z });
    polymerParts.push(block);
    for (let i = 0; i < fe.ribs; i++) {
      // Ribs run across the SHORT axis of whichever way the fore-end is oriented: stacked down
      // a vertical grip, spaced along a handguard.
      //
      // 0.008 → INK_FLOOR. They were 2 mm under the band, so the whole rib stack was printing as
      // one black field instead of as grip texture — the same failure the trigger guard had.
      // Bolder and fewer: the spacing below spreads them so the gaps survive the line too.
      const vertical = fe.h > fe.d;
      const rib = vertical
        ? inkChunk(fe.w + 0.004, INK_FLOOR, fe.d + 0.004, 0.002, 82 + i, 'foreEnd.rib')
        : inkChunk(fe.w + 0.004, fe.h + 0.004, INK_FLOOR, 0.002, 82 + i, 'foreEnd.rib');
      place(rib, vertical
        ? { y: fe.y + fe.h * 0.30 - i * (fe.h * 0.62 / Math.max(1, fe.ribs - 1)), z: fe.z }
        : { y: fe.y, z: fe.z + fe.d * 0.34 - i * (fe.d * 0.68 / Math.max(1, fe.ribs - 1)) });
      polymerParts.push(rib);
    }
  }

  // ── tube magazine (shotgun): the second cylinder that makes the fore-end read as a pump ──
  if (P.tube) {
    const tube = inkCylinder(P.tube.r, P.tube.len, 7, { seed: 88 });
    place(tube, { rx: Math.PI * 0.5 });
    place(tube, { y: P.tube.y, z: P.tube.z });
    frameParts.push(tube);
  }

  // ── stock: the mass behind the grip ────────────────────────────────────────────────────
  // Skeleton = two rails and a pad, which reads as a wire brace and keeps the SMG light. Solid
  // = one block and a pad, which is what makes the marksman look like it is meant to be held
  // still. Both sit BEHIND the hand, i.e. at +z, where they cost reach nothing.
  if (P.stock) {
    const st = P.stock;
    if (st.skeleton) {
      for (const sy of [1, -1]) {
        const rail = inkChunk(st.w, 0.012, st.d, 0.003, 91 + sy, 'stock.rail');
        place(rail, { y: st.y + sy * st.h * 0.34, z: st.z });
        polymerParts.push(rail);
      }
    } else {
      const body = bevelBox(st.w, st.h, st.d, 0.008, 93);
      place(body, { y: st.y, z: st.z });
      polymerParts.push(body);
    }
    const pad = bevelBox(st.w + 0.006, st.h + 0.010, 0.016, 0.004, 94);
    place(pad, { y: st.y, z: st.z + st.d * 0.5 + 0.008 });
    polymerParts.push(pad);
  }

  // ── slide / receiver: the fat top mass, with cut serrations at the rear ────────────────
  const slide = bevelBox(P.receiver.w, P.receiver.h, P.receiver.d, 0.007, 21);
  place(slide, { y: P.receiver.y, z: P.receiver.z });
  slideParts.push(slide);

  // COCKING SERRATIONS — bolder and further apart than they shipped.
  //
  // They were 0.006 m thick on a 0.012 m pitch: BOTH the tooth and the gap were under the ink
  // band, so the hull inflated each tooth over its own neighbour and the whole stack printed as
  // one black patch at the back of the slide. WEAPON_ART §0 exactly — the parts were modelled and
  // the line was erasing them. At the floor on a 0.017 pitch the tooth holds albedo and the 7 mm
  // gap holds an ink line, which is what "serrations" is supposed to look like.
  const SERRATION_PITCH = 0.017;
  for (let i = 0; i < P.serrations; i++) {
    const serration = inkChunk(
      P.receiver.w + 0.002, P.receiver.h * 0.65, INK_FLOOR, 0.0015, 22 + i, 'serration',
    );
    place(serration, {
      y: P.receiver.y,
      z: P.receiver.z + P.receiver.d * 0.5 - 0.010 - i * SERRATION_PITCH,
    });
    slideParts.push(serration);
  }

  // Front and rear sights — the only two things on this gun that are meant to line up, and now
  // the only two that are PLACED FROM one shared number. Both tops land on `SIGHT.lineY`, which
  // is what `AIM_SOCKET` (and therefore the entire ADS solve) is anchored to. See the SIGHT
  // block above before touching any of this: moving a blade moves the aim point.
  const front = bevelBox(SIGHT.bladeW, SIGHT.frontH, SIGHT.bladeD, 0.002, 26);
  place(front, { y: SIGHT.lineY - SIGHT.frontH * 0.5, z: SIGHT.frontZ });
  sightParts.push(front);

  for (const sx of [-1, 1]) {
    const rear = bevelBox(SIGHT.bladeW, SIGHT.rearH, SIGHT.bladeD, 0.002, 27 + sx);
    place(rear, {
      x: sx * (SIGHT.notchHalfGap + SIGHT.bladeW * 0.5),
      y: SIGHT.lineY - SIGHT.rearH * 0.5,
      z: SIGHT.rearZ,
    });
    sightParts.push(rear);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // THE OPTIONAL DETAIL VOCABULARY. Every block below is skipped entirely when the profile
  // says nothing about it, so a profile that opts into none of it builds the gun it built
  // before, vertex for vertex. See the interface block above for units and the rules each
  // part is under.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /** The receiver's side faces and its top face — where nearly all of this detail lives. */
  const rSideX = P.receiver.w * 0.5;
  const rTopY = P.receiver.y + P.receiver.h * 0.5;

  // ── sight wings: ears either side of the front post ────────────────────────────────────
  // In `sightParts`, so they ride the slide and carry the sights' lighter ink rather than the
  // silhouette's 7 px. They are at `frontZ`, which the front blade already occupies, so they
  // never become the model's worst forward vertex — the muzzle can is 20-40 mm ahead of them.
  if (P.sightWings) {
    const wg = P.sightWings;
    if (import.meta.env?.DEV && wg.gap < SIGHT.notchHalfGap * 1.5) {
      console.warn(
        `[weapons/viewmodel] ${P.id}: sightWings.gap ${wg.gap} is inside the rear notch's window ` +
        `at the front plane (~${(SIGHT.notchHalfGap * 1.5).toFixed(4)} m). The wings will eat the ` +
        'light bars either side of the post, which is the whole sight picture.',
      );
    }
    const top = SIGHT.lineY + wg.rise;
    const h = Math.max(0.014, top - rTopY);
    for (const sx of [-1, 1]) {
      const wing = inkChunk(wg.thick, h, wg.d, 0.003, 143 + sx, 'sightWings.wing');
      place(wing, {
        x: sx * (wg.gap + wg.thick * 0.5),
        y: top - h * 0.5,
        z: SIGHT.frontZ,
      });
      sightParts.push(wing);
    }
  }

  // ── ejection port: a proud FRAME around a bare patch of receiver ───────────────────────
  // Not a plate laid on the face — see `EjectionPortSpec`. The rear bar is a deflector and it
  // stands proudest of the four, which is the asymmetry the silhouette is here for.
  if (P.ejectionPort) {
    const ep = P.ejectionPort;
    const lipX = rSideX - 0.001;      // outer face ~5 mm proud of the receiver
    const topLip = inkChunk(0.012, INK_FLOOR, ep.d + 0.012, 0.003, 101, 'ejectionPort.topLip');
    place(topLip, { x: lipX, y: ep.y + ep.h * 0.5 + 0.005, z: ep.z });
    steelParts.push(topLip);

    const shelf = inkChunk(0.012, INK_FLOOR, ep.d + 0.006, 0.003, 102, 'ejectionPort.shelf');
    place(shelf, { x: lipX, y: ep.y - ep.h * 0.5 - 0.005, z: ep.z });
    steelParts.push(shelf);

    // The front wall doubles as the extractor read. A separate 10 mm claw inside a 20 mm port
    // would just fill the port with ink, so the wall does both jobs.
    const wall = inkChunk(0.012, ep.h + 0.020, INK_FLOOR, 0.003, 103, 'ejectionPort.wall');
    place(wall, { x: lipX, y: ep.y, z: ep.z - ep.d * 0.5 - 0.005 });
    steelParts.push(wall);

    const deflector = inkChunk(0.014, ep.h + 0.024, 0.012, 0.004, 104, 'ejectionPort.deflector');
    place(deflector, { x: rSideX + 0.001, y: ep.y, z: ep.z + ep.d * 0.5 + 0.006 });
    steelParts.push(deflector);

    // A shell showing in the port. RUST, riding the slide — one more warm mark, on the one part
    // of the gun the eye lands on. Dropped rather than drawn when it is under the ink band.
    if (ep.shellR >= INK_FLOOR * 0.5) {
      const shell = inkCylinder(ep.shellR, 0.016, 7, { seed: 105 });
      place(shell, { rz: Math.PI * 0.5 });
      place(shell, { x: rSideX - 0.008, y: ep.y, z: ep.z + ep.d * 0.2 });
      accentSlideParts.push(shell);
    }
  }

  // ── charging handle: a stem that ends in a HOOK, never a taper ─────────────────────────
  if (P.chargingHandle) {
    const ch = P.chargingHandle;
    const t = Math.max(ch.thick, INK_FLOOR);
    if (ch.side === 'top') {
      const stem = inkChunk(t, ch.len, t, 0.003, 111, 'chargingHandle.stem');
      place(stem, { y: rTopY + ch.len * 0.5 - 0.004, z: ch.z });
      steelParts.push(stem);
      const paddle = inkChunk(t + 0.014, 0.012, 0.016, 0.004, 112, 'chargingHandle.paddle');
      place(paddle, { y: rTopY + ch.len - 0.004, z: ch.z });
      steelParts.push(paddle);
      guardSightLine(rTopY + ch.len + 0.002, P, 'chargingHandle');
    } else {
      const sign = ch.side === 'right' ? 1 : -1;
      const stem = inkChunk(ch.len, t, t, 0.003, 111, 'chargingHandle.stem');
      place(stem, { x: sign * (rSideX + ch.len * 0.5 - 0.004), y: ch.y, z: ch.z });
      steelParts.push(stem);
      // The hook: deeper along the barrel than it is thick, so the outline gets a step in it.
      const paddle = inkChunk(0.012, t + 0.012, 0.018, 0.004, 112, 'chargingHandle.paddle');
      place(paddle, { x: sign * (rSideX + ch.len - 0.004), y: ch.y, z: ch.z });
      steelParts.push(paddle);
    }
  }

  // ── selector: a boss and a lever, LEFT side. Polymer, static (it is on the frame) ───────
  if (P.selector) {
    const sl = P.selector;
    const boss = inkCylinder(Math.max(sl.r, INK_FLOOR * 0.5), 0.012, 7, { seed: 121 });
    place(boss, { rz: Math.PI * 0.5 });
    place(boss, { x: -(rSideX + 0.002), y: sl.y, z: sl.z });
    polymerParts.push(boss);

    const lever = inkChunk(
      Math.max(sl.thick, INK_FLOOR), Math.max(sl.thick, INK_FLOOR), sl.len, 0.003, 122,
      'selector.lever',
    );
    // Built extending straight back from the boss, then swung about it — so `angleDeg` means what
    // it says no matter what `len` is.
    place(lever, { z: sl.len * 0.5 });
    // Negated: a +x rotation swings a +z arm DOWN, and "positive means the tip goes up" is the
    // only version of this an author will guess right.
    place(lever, { rx: -sl.angleDeg * DEG2RAD });
    place(lever, { x: -(rSideX + 0.005), y: sl.y, z: sl.z });
    polymerParts.push(lever);
  }

  // ── mag well: the step that makes the magazine read as INSERTED ────────────────────────
  // Same 0.30 rad rake the magazine build uses, so the two agree by construction rather than by
  // two authors picking the same number twice.
  if (P.magWell) {
    const mw = P.magWell;
    const well = inkChunk(mw.w, mw.h, mw.d, 0.005, 131, 'magWell.well');
    place(well, { rx: MAG_RAKE });
    place(well, { y: mw.y, z: mw.z });
    polymerParts.push(well);

    // The funnel is at the BOTTOM of the well, where the magazine goes in — and "the bottom" of a
    // raked well is down its own local −y, not down the world's.
    const flare = Math.max(mw.flare, 0.004);
    const collar = inkChunk(
      mw.w + flare * 2, 0.012, mw.d + flare * 2, 0.004, 132, 'magWell.collar',
    );
    place(collar, { rx: MAG_RAKE });
    place(collar, {
      y: mw.y - mw.h * 0.5 * Math.cos(MAG_RAKE),
      z: mw.z + mw.h * 0.5 * Math.sin(MAG_RAKE),
    });
    polymerParts.push(collar);
  }

  // ── stamped panels / vents: DARK and near-flush, so they read as cuts, not as plates ────
  if (P.panels) {
    const pn = P.panels;
    if (import.meta.env?.DEV && pn.count > 3) {
      console.warn(
        `[weapons/viewmodel] ${P.id}: panels.count ${pn.count} — WEAPON_ART §0 says 2-3 BOLD cuts, ` +
        'never 8 fine ones. Past three they merge into one smear under the ink line.',
      );
    }
    const signs: readonly number[] = pn.side === 'both' ? [-1, 1] : [pn.side === 'right' ? 1 : -1];
    for (let i = 0; i < pn.count; i++) {
      for (const sx of signs) {
        const cut = inkChunk(0.011, pn.h, pn.d, 0.002, 151 + i * 2 + (sx > 0 ? 1 : 0), 'panels.cut');
        place(cut, { x: sx * (pn.hostHalfW - 0.003), y: pn.y, z: pn.z - i * pn.step });
        polymerParts.push(cut);
      }
    }
  }

  // ── rail teeth: chunky, and UNDER the sight line ───────────────────────────────────────
  if (P.railTeeth) {
    const rt = P.railTeeth;
    guardSightLine(rt.y + rt.h * 0.5, P, 'railTeeth');
    for (let i = 0; i < rt.count; i++) {
      const tooth = inkChunk(rt.w, rt.h, rt.d, 0.002, 161 + i, 'railTeeth.tooth');
      place(tooth, { y: rt.y, z: rt.z - i * rt.step });
      steelParts.push(tooth);
    }
  }

  // ── trim / accent ──────────────────────────────────────────────────────────────────────
  // Oversized muzzle brake: three fins on a short can. Pure comic — real pistols do not have
  // this, and that is the point. It is the read at the business end.
  const can = inkCylinder(P.muzzle.r, P.muzzle.len, 7, { seed: 31 });
  place(can, { rx: Math.PI * 0.5 });
  place(can, { y: P.receiver.y, z: P.muzzle.z });
  trimParts.push(can);

  for (let i = 0; i < P.muzzle.fins; i++) {
    const fin = bevelBox(P.muzzle.finW, 0.010, 0.011, 0.002, 32 + i);
    place(fin, { y: P.receiver.y, z: P.muzzle.z + P.muzzle.len * 0.4 - i * 0.013 });
    trimParts.push(fin);
  }

  // The trigger moves to POLYMER, and the choice of field is a PARENTING decision as much as a
  // colour one. It was BONE (luma 0.73) — the gun's brightest value, spent on a 22 mm part buried
  // inside the guard where the eye is never asked to look. It cannot go in `steel`, because
  // `steel` rides the slide: a trigger that travelled the slide's 14 mm on every shot would end
  // the stroke inside the rear bar of its own guard. `polymer` is static and dark, which is what
  // a trigger is, and it separates hard against the mid-grey frame right behind it.
  const trigger = inkChunk(0.011, 0.022, 0.011, 0.002, 37, 'trigger');
  place(trigger, { rx: 0.2 });
  place(trigger, { y: -0.032, z: -0.032 });
  polymerParts.push(trigger);

  // ── THE WARM READ (RUST) ───────────────────────────────────────────────────────────────
  // ART §1 allows two hues per material and the palette reserves GOLD for interactables, so the
  // gun's one warm accent is RUST — and it is deliberately spent on parts that DEFINE THE
  // SILHOUETTE (the backstrap, the top of the slide, the hammer spur) rather than on a decal
  // buried in the middle of a face. At rest, at ADS and mid-recoil there is always at least one
  // warm mark on the outline, which is what stops the object reading as a plumbing fixture.

  // Taped grip: three bands wrapped round the backstrap.
  for (let i = 0; i < 3; i++) {
    const band = bevelBox(0.034, 0.013, 0.048, 0.003, 71 + i);
    place(band, { rx: 0.30 });
    place(band, { y: -0.034 - i * 0.027, z: 0.008 + i * 0.008 });
    accentParts.push(band);
  }

  // Slide top rib — a warm line running the length of the upper, between the sights. It is its
  // own group because it belongs to the RECIPROCATING part: a warm stripe that stayed put while
  // the slide cycled underneath it would read as a bug on every single shot.
  //
  // ITS HEIGHT IS A SIGHT-PICTURE CONSTRAINT, NOT A STYLING ONE. The rib runs FORWARD from the
  // rear notch, so it is nearer to the eye than the front post at every ray below the sight
  // line — at a top of 0.0555 it occluded all but ~16 px of a 38 px post and the ADS picture had
  // no front sight in it at all. Sitting 2 mm proud of the slide's 0.050 top face it still reads
  // as a warm rib leading the eye to the post, and it clears ~34 px of it.
  const rib = bevelBox(P.rib.w, P.rib.h, P.rib.d, 0.002, 74);
  place(rib, { y: P.rib.y, z: P.rib.z });
  accentSlideParts.push(rib);

  // Hammer spur: the rearmost thing on the gun, and the top-right corner of the silhouette.
  //
  // AND IT IS THE PART THAT WAS ACTUALLY EATING THE SIGHT PICTURE. It is the NEAREST thing on
  // the model to the eye (depth 0.209 m at ADS, against 0.32 m for the front post), it is
  // centred on x = 0, and at a top of 0.0599 it broke the sight line 21 px below centre — ink
  // hull from 14 px. Measured by hiding one mesh at a time and re-reading the framebuffer: the
  // orange mass filling the notch under the crosshair was this, in RUST, not the slide rib.
  //
  // Dropped to a top of 0.0529, which puts its first intrusion at 48 px / 41 px inked — behind
  // where the slide rib (35 px) already closes the picture, so it is now invisible to the sight
  // line at every depth. It still stands 3 mm proud of the slide's 0.050 top and it is still the
  // rearmost silhouette mark, which is the job it was hired for.
  const hammer = bevelBox(0.014, 0.024, 0.014, 0.003, 36);
  place(hammer, { rx: -0.5 });
  place(hammer, { y: 0.039, z: 0.026 });
  accentParts.push(hammer);

  // ── THE HAND (M2 §1: "a comic FPS is judged on its gun") ───────────────────────────────
  // A chunky gloved fist, a thumb up the frame, and a forearm running off the bottom-right
  // corner. Without it the weapon floats in the corner of the frame like a UI element; with it
  // the player is holding something. All of it is inside the `maxEyeDistance` clipping budget —
  // `assertClearance()` checks that in dev and it is measured in the note above it.
  const fist = bevelBox(0.062, 0.080, 0.068, 0.013, 61);
  place(fist, { rx: 0.30 });
  place(fist, { x: -0.002, y: -0.054, z: 0.020 });
  handParts.push(fist);

  // Four finger ridges curling round the FRONT of the grip.
  for (let i = 0; i < 4; i++) {
    const finger = bevelBox(0.068, 0.018, 0.019, 0.004, 62 + i);
    place(finger, { rx: 0.30 });
    place(finger, { x: -0.004, y: -0.024 - i * 0.020, z: -0.014 - i * 0.005 });
    handParts.push(finger);
  }

  // Thumb, laid up the left side of the frame — the read that says "right hand".
  const thumb = bevelBox(0.020, 0.022, 0.056, 0.005, 66);
  place(thumb, { rx: 0.18 });
  place(thumb, { x: -0.030, y: -0.020, z: -0.008 });
  handParts.push(thumb);

  const wrist = bevelBox(0.062, 0.060, 0.058, 0.011, 67);
  place(wrist, { rx: 0.42 });
  place(wrist, { x: 0.004, y: -0.100, z: 0.052 });
  handParts.push(wrist);

  // MEASURED AGAINST THE NEAR PLANE, not just against `maxEyeDistance`. `CAMERA.near` is
  // 0.05 m; a first pass put the back of the forearm at 0.056 m from the eye, i.e. 6 mm of
  // margin, which one sway impulse would have sliced open. It sits at ~0.10 m now.
  const forearm = bevelBox(0.070, 0.070, 0.100, 0.014, 68);
  place(forearm, { rx: 0.42 });
  place(forearm, { x: 0.008, y: -0.142, z: 0.100 });
  handParts.push(forearm);

  // ── magazine ───────────────────────────────────────────────────────────────────────────
  // This group is what the reload animation drops and re-seats, so the SHOTGUN puts its PUMP
  // here rather than a box mag: racking the fore-end on a reload is the shotgun's whole gesture,
  // and it comes for free by hanging it off the same bone the animation already drives.
  if (P.magazine) {
    const mag = bevelBox(P.magazine.w, P.magazine.h, P.magazine.d, 0.004, 41);
    place(mag, { rx: MAG_RAKE });
    place(mag, { y: P.magazine.y, z: P.magazine.z });
    magParts.push(mag);

    const plate = bevelBox(P.magazine.w + 0.008, 0.010, P.magazine.d + 0.010, 0.003, 42);
    place(plate, { rx: MAG_RAKE });
    place(plate, { y: P.magazine.y - P.magazine.h * 0.5 - 0.004, z: P.magazine.z + 0.014 });
    magParts.push(plate);
  } else if (P.tube) {
    const pump = bevelBox(0.040, 0.034, 0.050, 0.007, 41);
    place(pump, { y: P.tube.y, z: P.tube.z - 0.010 });
    magParts.push(pump);
    for (let i = 0; i < 4; i++) {
      const grip = bevelBox(0.044, 0.010, 0.010, 0.002, 43 + i);
      place(grip, { y: P.tube.y, z: P.tube.z + 0.014 - i * 0.014 });
      magParts.push(grip);
    }
  }

  // ── the emissive muzzle core (GOLD — the palette reserves the muzzle core for it) ───────
  const core = inkCylinder(Math.max(0.008, P.muzzle.r * 0.6), 0.004, 7, { seed: 51 });
  place(core, { rx: Math.PI * 0.5 });
  place(core, { y: P.receiver.y, z: P.muzzle.z - P.muzzle.len * 0.5 });

  const out: GunGeometry = {
    frame: mergeForStatic(frameParts),
    polymer: mergeForStatic(polymerParts),
    steel: mergeForStatic(steelParts),
    slide: mergeForStatic(slideParts),
    sights: mergeForStatic(sightParts),
    trim: mergeForStatic(trimParts),
    accent: mergeForStatic(accentParts),
    accentSlide: mergeForStatic(accentSlideParts),
    hand: mergeForStatic(handParts),
    magazine: mergeForStatic(magParts),
    core,
  };
  for (const g of [
    ...frameParts, ...polymerParts, ...steelParts, ...slideParts, ...sightParts, ...trimParts,
    ...accentParts, ...accentSlideParts, ...handParts, ...magParts,
  ]) g.dispose();

  // ── the lens compensation + overall scale, applied once to everything ───────────────────
  for (const g of [
    out.frame, out.polymer, out.steel, out.slide, out.sights, out.trim, out.accent,
    out.accentSlide, out.hand, out.magazine, out.core,
  ]) {
    place(g, { sx: MODEL_SCALE, sy: MODEL_SCALE, sz: MODEL_SCALE * P.depthCompress });
    g.computeBoundingSphere();
  }
  return out;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO SPATIAL CONTRACTS, VERIFIED — FOR EVERY POSE, NOT JUST FOR REST.
 *
 *  1. HORIZONTAL REACH ≤ `view.maxEyeDistance` (0.40 m). `MOVE.radius` is 0.42, so nothing
 *     static can ever be closer than that — which is the only reason the gun renders with
 *     ordinary depth testing and never punches through a wall.
 *  2. FORWARD DEPTH ≥ `view.nearClearance` (0.07 m). `CAMERA.near` is 0.05 m; a vertex that
 *     crosses it gets sliced open and the player sees the hollow inside of their own weapon.
 *
 * WHAT CHANGED IN BUILD 005. The old version of this function checked contract 1 only, from
 * BOUNDING SPHERES, at the REST TRANSLATION, ignoring rotation — so it could not see the ADS
 * pose at all, could not see the reload arc that swings the gun 130 mm down and 45 mm back, and
 * could not see the near plane it was written to protect. That is exactly the shape of hole the
 * BUILD 004 feedback fell into. It now walks EVERY VERTEX of EVERY MESH through the composed
 * matrix of EVERY POSE the model can actually reach, and the child offsets (slide cycle, mag
 * drop) with them.
 *
 * The per-pose numbers are inflated by every layer that is summed on top of a pose and is not a
 * pose itself — `swayPosMax` in every direction, the recoil kick at `clearanceKickBudget`, and
 * (BUILD 006) the ROTATION layers `compose()` adds in steps 3, 4 and 6: `swayRotMaxDeg` on all
 * three axes at both signs, the walk-bob roll, and the active-reload snap. Missing those is how
 * the previous version reported all-clear at boot while the real transform crossed the near-plane
 * budget in ordinary play. The reported worst case is a bound, not a snapshot.
 *
 * Dev only, once, at build. ~4.7 k vertices × 7 poses × 5 sway corners is a few milliseconds on a
 * dev boot and it buys a regression test that cannot silently rot.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
interface Pose {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Degrees — matching how the tuning file states them. */
  readonly pitchDeg: number;
  readonly yawDeg: number;
  readonly rollDeg: number;
  /** Child offsets: the slide's recoil travel and the magazine's reload drop. */
  readonly slideZ?: number;
  readonly magY?: number;
  /**
   * Whether the active-reload flourish / miss-stumble roll can be summed on top of THIS pose.
   * They fire on reload completion and on a missed active-reload window, so they can only ever
   * land on the rest pose or on the tail of the reload arc — never on sprint, ADS or equip.
   */
  readonly canFlourish?: boolean;
}

/**
 * THE SUMMED ROTATION LAYERS — the hole this whole block was rewritten to close (BUILD 006).
 *
 * `assertClearance` claimed it walked "EVERY VERTEX of EVERY MESH through the composed matrix of
 * EVERY POSE the model can actually reach". It did not: the seven poses carry no rotational sway,
 * no walk-bob roll and no flourish roll/pitch, and `compose()` sums all three ON TOP of whatever
 * pose it just built (steps 3, 4 and 6). The old justification only argued that sway POSITION is
 * a reach term — true of `swayPos`, and irrelevant to `swayRot`, because rotation moves DEPTH as
 * well as reach: it swings the rear of the model toward the eye.
 *
 * MEASURED by driving the real `compose()` over all 4740 vertices: the boot assert reported its
 * tightest pose at 0.077 m and warned about nothing, while reload + max swayRot came to 0.0744,
 * ADS + swayRot + kick to 0.0641, and an entirely ordinary "fire while landing with the view
 * swinging" to 0.0557 — all under `nearClearance`, with the full stack reaching −0.0074 m, i.e.
 * vertices BEHIND the camera.
 *
 * THE BOUND IS THE REAL ONE, NOT A PESSIMISTIC ONE, and the distinction decides whether anyone
 * ever trusts this function. `update()` writes `swayRot.target.set(rx, ry, -ry * 0.55)`: pitch and
 * yaw are independently clamped at `swayRotMaxDeg`, but ROLL IS NOT A FREE AXIS — it is the yaw
 * trailing it, at 0.55×, with the opposite sign. Treating roll as its own ±9° corner invents a
 * pose the model can never reach and would have had me flattening the gun to satisfy an assertion
 * about nothing. So the corners walked here are (pitch±, yaw±) with roll derived, scaled by
 * `clearanceSwayOvershoot` because these are springs and a spring passes its target.
 *
 * Roll is also the axis that matters least: with the 'YXZ' order it is applied FIRST, in the
 * model's own frame, so it spins the gun about its own barrel and moves local z not at all. Only
 * pitch and yaw convert the model's length and width into depth.
 */
const SWAY_CORNERS: readonly (readonly [number, number])[] = [
  [0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1],
];
/** How far the sway spring overshoots its clamped target, as a multiplier. */
const SWAY_ROLL_FROM_YAW = -0.55;

/** Every pose `compose()` can put the model in, at its extreme. */
function posesToCheck(
  adsX: number = ADS_X, adsY: number = ADS_Y, adsZ: number = ADS_Z, restDz = 0,
): readonly Pose[] {
  const kick = V.clearanceKickBudget;
  const rest: Pose = {
    name: 'rest',
    x: V.restX, y: V.restY, z: V.restZ + restDz,
    pitchDeg: V.restPitchDeg, yawDeg: V.restYawDeg, rollDeg: V.restRollDeg,
    canFlourish: true,
  };
  const ads: Pose = {
    name: 'ads', x: adsX, y: adsY, z: adsZ, pitchDeg: 0, yawDeg: 0, rollDeg: 0,
  };
  return [
    rest,
    ads,
    {
      name: 'sprint',
      x: V.sprintX, y: V.sprintY, z: V.restZ + restDz + V.sprintZ,
      pitchDeg: V.sprintPitchDeg, yawDeg: V.sprintYawDeg, rollDeg: V.sprintRollDeg,
    },
    {
      // The deepest point of the reload arch, with the magazine fully dropped.
      name: 'reload',
      x: rest.x, y: rest.y - V.reloadDropY, z: rest.z + V.reloadPushZ,
      pitchDeg: rest.pitchDeg + V.reloadPitchDeg,
      yawDeg: rest.yawDeg,
      rollDeg: rest.rollDeg + V.reloadRollDeg,
      magY: -V.reloadMagDrop,
      canFlourish: true,
    },
    {
      // The first frame of a draw: dropped, rolled, and on its way up.
      name: 'equip',
      x: rest.x, y: rest.y + V.equipDropY, z: rest.z,
      pitchDeg: rest.pitchDeg, yawDeg: rest.yawDeg, rollDeg: rest.rollDeg + V.equipRollDeg,
    },
    {
      // Recoil is the one layer that drives the model straight back INTO the eye, so it gets
      // checked on both of the poses you can actually shoot from.
      name: 'rest+recoil+land',
      x: rest.x, y: rest.y + V.kickUp * kick - V.landDipMax, z: rest.z + V.kickBack * kick,
      pitchDeg: rest.pitchDeg + V.kickPitchDeg * kick,
      yawDeg: rest.yawDeg + V.kickYawDeg * kick,
      rollDeg: rest.rollDeg - V.kickRollDeg * kick,
      slideZ: 0.020 * V.depthCompress,
    },
    {
      name: 'ads+recoil',
      x: ads.x, y: ads.y + V.kickUp * kick * V.kickAdsMult, z: ads.z + V.kickBack * kick * V.kickAdsMult,
      pitchDeg: V.kickPitchDeg * kick * V.kickAdsMult,
      yawDeg: V.kickYawDeg * kick * V.kickAdsMult,
      rollDeg: -V.kickRollDeg * kick * V.kickAdsMult,
      slideZ: 0.020 * V.depthCompress,
    },
  ];
}

function assertClearance(g: GunGeometry, P: GunProfile = PROFILES[0] as GunProfile): void {
  if (!import.meta.env?.DEV) return;

  // ── the alignment contract, stated as an assertion instead of as a hope ──────────────────
  // With the ADS rotation identity, the socket must land dead on the camera's forward axis.
  // If someone re-introduces a "nice" residual tilt or a lateral offset at full ADS, this is
  // what tells them the sight picture no longer agrees with the bullet.
  const socket = aimSocketOf(P);
  const ads = adsOffsetOf(socket);
  _probe.copy(socket).add(_pos.set(ads.x, ads.y, ads.z));
  if (Math.abs(_probe.x) > 1e-9 || Math.abs(_probe.y) > 1e-9) {
    console.warn(
      `[weapons/viewmodel] ${P.id}: the ADS aim socket is off the camera axis by ` +
      `(${_probe.x.toExponential(2)}, ${_probe.y.toExponential(2)}) m. The sights will not ` +
      'point where the shot goes.',
    );
  }

  // SWAY IS A REACH TERM AND NOT A DEPTH TERM, and that is not a simplification — `update()`
  // writes `swayPos.target.set(sx, sy, 0)` and `compose()` adds only `.x` and `.y`. The sway
  // layer has no z component at all, so it can push the model sideways into a wall and can
  // never push it into the near plane.
  //
  // AND IT COMPOSES PER VERTEX, NOT ON THE HYPOTENUSE. `hypot(x, z) + sway` is the number you
  // get by assuming the sway points straight along the reach vector, which it cannot: it is
  // pure ±x. The honest worst case is `hypot(|x| + sway, z)`, and the difference is not
  // cosmetic — for the rest pose (worst vertex near the muzzle, x ≈ 0.10, z ≈ −0.36) the sloppy
  // form reads 0.414 m and the true one 0.386 m. At a 0.42 m budget that is the difference
  // between "6 mm of headroom, panic" and "34 mm, fine", and it would have had me flattening a
  // pose to fix an arithmetic error.
  const sway = V.swayPosMax;
  // The measured table, emitted once at `debug` level — Chrome hides it by default, so it costs
  // nothing on a normal boot and is one filter away when someone is moving a pose.
  const report: string[] = [];

  for (const p of posesToCheck(ads.x, ads.y, ads.z, P.restDz ?? 0)) {
    let reach = 0;
    let reachSway = 0;
    let depth = Infinity;
    let worst = '';

    // The summed layers, as a bound rather than a snapshot. `flourish` walks the two signs of the
    // active-reload snap (its pitch term is one-signed, per `compose()` step 6) plus zero, and
    // the miss-stumble is the same roll axis at a smaller amplitude, so the snap covers it.
    const flourishes: readonly number[] = p.canFlourish ? [0, 1, -1] : [0];
    const over = V.clearanceSwayOvershoot;
    for (const s of SWAY_CORNERS) {
      for (const f of flourishes) {
        const swayYaw = V.swayRotMaxDeg * s[1] * over;
        const exPitch = V.swayRotMaxDeg * s[0] * over - V.activeSnapDeg * 0.4 * Math.abs(f);
        const exYaw = swayYaw;
        // Sway roll trails the yaw; bob roll and the flourish snap ride on top of it.
        const exRoll = swayYaw * SWAY_ROLL_FROM_YAW
          + V.bobRollDeg * (s[1] < 0 ? -1 : 1) + V.activeSnapDeg * f;

        _euler.set(
          (p.pitchDeg + exPitch) * DEG2RAD,
          (p.yawDeg + exYaw) * DEG2RAD,
          (p.rollDeg + exRoll) * DEG2RAD,
          'YXZ',
        );
        _quat.setFromEuler(_euler);
        _pos.set(p.x, p.y, p.z);
        _local.compose(_pos, _quat, _one);

        for (const geo of [
          g.frame, g.polymer, g.steel, g.slide, g.sights, g.trim, g.accent, g.accentSlide,
          g.hand, g.magazine, g.core,
        ]) {
          // `sights`, `accentSlide` and `steel` ride the slide and the magazine has its own
          // reload offset; everything else is rigid to the root. `steel` is in this list because
          // it carries the charging handle and the port deflector — the two parts most likely to
          // become a gun's worst lateral vertex, and a clearance check that cannot see them is
          // the same shape of hole BUILD 005 and BUILD 006 each had to close.
          const childZ = geo === g.slide || geo === g.sights || geo === g.accentSlide
            || geo === g.steel
            ? (p.slideZ ?? 0)
            : 0;
          const childY = geo === g.magazine ? (p.magY ?? 0) : 0;
          const attr = geo.getAttribute('position');
          if (!attr) continue;
          for (let i = 0; i < attr.count; i++) {
            _probe.set(attr.getX(i), attr.getY(i) + childY, attr.getZ(i) + childZ)
              .applyMatrix4(_local);
            reach = Math.max(reach, Math.hypot(_probe.x, _probe.z));
            reachSway = Math.max(reachSway, Math.hypot(Math.abs(_probe.x) + sway, _probe.z));
            if (-_probe.z < depth) {
              depth = -_probe.z;
              worst = `swayRot(pitch ${s[0]}, yaw ${s[1]})${f !== 0 ? ` +flourish${f > 0 ? '+' : '−'}` : ''}`;
            }
          }
        }
      }
    }
    report.push(
      `${p.name.padEnd(16)} reach ${reach.toFixed(3)} (swayed ${reachSway.toFixed(3)}) ` +
      `· near ${depth.toFixed(3)}  [${worst}]`,
    );

    // 1 · the DESIGN budget: the pose itself, before sway.
    if (reach > V.maxEyeDistance) {
      console.warn(
        `[weapons/viewmodel] pose "${p.name}": horizontal reach ${reach.toFixed(3)} m exceeds ` +
        `WEAPON.view.maxEyeDistance ${V.maxEyeDistance}. ` +
        'Pull the pose in (less +x, less +z) or shrink MODEL_SCALE.',
      );
    }
    // 2 · the PHYSICAL contract, which is the one that actually stops a muzzle coming through a
    //     wall: pose + a full sway flick must stay inside the player's collision radius.
    if (reachSway > MOVE.radius) {
      console.warn(
        `[weapons/viewmodel] pose "${p.name}": reach ${reach.toFixed(3)} m becomes ` +
        `${reachSway.toFixed(3)} m under a full ${sway} m sway flick, outside MOVE.radius ` +
        `${MOVE.radius}. The gun CAN punch through a wall on a hard flick against a corner.`,
      );
    }
    // 3 · the near plane.
    if (depth < V.nearClearance) {
      console.warn(
        `[weapons/viewmodel] pose "${p.name}": nearest vertex is ${depth.toFixed(3)} m in front ` +
        `of the eye, inside WEAPON.view.nearClearance ${V.nearClearance} ` +
        `(CAMERA.near is ${CAMERA.near}). The camera is about to end up inside the model — ` +
        'push the pose forward (more negative z) or shorten the grip.',
      );
    }
  }

  console.debug(
    `[weapons/viewmodel] ${P.id} pose clearance (budgets: reach ${V.maxEyeDistance}, ` +
    `MOVE.radius ${MOVE.radius}, near ${V.nearClearance}, CAMERA.near ${CAMERA.near})\n  ` +
    report.join('\n  '),
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The drive — one struct in, no reaching into anything.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface ViewmodelDrive {
  /** Horizontal speed, m/s. */
  speed: number;
  /** Metres travelled on foot — the SAME accumulator the camera bob uses, so the two cannot
   *  drift out of their intended counter-phase relationship. */
  bobDistance: number;
  grounded: boolean;
  moving: boolean;
  /** 0..1 sprint blend. */
  sprintAmount: number;
  /** 0..1 ADS blend, already on the def's curve. */
  adsAmount: number;
  /** This frame's view rotation rate, rad/s. Drives the sway lag. */
  lookRateX: number;
  lookRateY: number;
  /** 0..1 through the reload, or -1 when not reloading. */
  reloadProgress: number;
}

export function makeViewmodelDrive(): ViewmodelDrive {
  return {
    speed: 0,
    bobDistance: 0,
    grounded: true,
    moving: false,
    sprintAmount: 0,
    adsAmount: 0,
    lookRateX: 0,
    lookRateY: 0,
    reloadProgress: -1,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Viewmodel
// ═════════════════════════════════════════════════════════════════════════════════════════════

export class Viewmodel {
  readonly root = new Group();

  private geo: GunGeometry | null = null;
  private readonly materials: InkMaterial[] = [];
  private readonly meshes: Mesh[] = [];
  private readonly hulls: Mesh[] = [];
  private slideMesh: Object3D | null = null;
  private magMesh: Object3D | null = null;

  /**
   * EVERY GUN IS BUILT AT BOOT AND THEN HIDDEN — `ARCHITECTURE §4`, pool everything, allocate
   * nothing after the first frame. Four models is four Groups of nine meshes; three of them are
   * `visible = false` at any moment and three.js skips an invisible subtree entirely, so the
   * draw-call cost is exactly one gun. Building on swap instead would mean constructing geometry
   * AND an inverted hull mid-fight, which is a hitch on an input the player made.
   */
  private readonly models = new Map<string, GunModel>();
  private active: GunModel | null = null;

  // ── layers ──────────────────────────────────────────────────────────────────────────────
  /** Look-lag sway. Position in metres, rotation in radians (x=pitch, y=yaw, z=roll). */
  private readonly swayPos = new SpringVec3(V.swayHz, V.swayDamping);
  private readonly swayRot = new SpringVec3(V.swayHz, V.swayDamping);
  /** Recoil kick — separate springs, deliberately softer and slower than the camera's. */
  private readonly kickPos = new SpringVec3(V.kickPosHz, V.kickPosDamping);
  private readonly kickRot = new SpringVec3(V.kickRotHz, V.kickRotDamping);
  /** Slide reciprocation, metres. Fired only, never idle. */
  private readonly slideSpring = new Spring(14, 0.5);
  /** Landing dip, metres. Causal (the player jumped), so ART §10 tolerates it. */
  private readonly landSpring = new Spring(6.5, 0.62);

  private bobWeight = 0;
  private adsPose = 0;
  private sprintPose = 0;
  private equipT = 1;
  /** One-shot flourish on an active-reload success / stumble on a miss. Decays to 0. */
  private flourish = 0;
  private flourishSign = 1;
  private stumble = 0;

  /**
   * ART §4.1 TELEMETRY: true when the composed local transform is bit-for-bit what it was last
   * frame, i.e. this object contributed exactly zero changed pixels.
   *
   * Measured on the transform itself rather than on the individual layers, so it cannot be
   * fooled by a layer nobody remembered to check. Read it in the debug panel: standing still,
   * not shooting, not reloading, hand off the mouse ⇒ it must say `yes`.
   */
  frozen = false;
  private readonly prev = new Float64Array(6);
  private hasPrev = false;

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Build
  // ═══════════════════════════════════════════════════════════════════════════════════════

  build(scene: Object3D): void {
    if (this.models.size) return;
    const g = buildGunGeometry(PROFILES[0]);

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * THE GUN'S VALUE, AND WHY IT MOVED UP.
     *
     * It shipped at `hexMix(SLATE, INK_SOFT, 0.42)` — luma 0.26 lit, 0.18 in shadow — on the
     * theory that ART §9 reserves the brightest values for enemies. That reasoning is right and
     * the number was still wrong: 0.26 is BELOW every environment surface except linework
     * (CONCRETE ground 0.52, SLATE mass 0.32) and it is the same hue family as SLATE, which the
     * palette itself calls "the biggest vertical area in the frame". Against a wall the weapon
     * disappeared; against the plaza it read as a blue-purple plumbing fixture. The object the
     * player looks at for 100% of the session was the least-designed thing in the picture.
     *
     * It now sits at ~0.44 — a warm-leaning grey between SLATE (0.32) and CONCRETE (0.52), so
     * it separates from BOTH of the two biggest areas of the frame while staying well under
     * `ENV_VALUE_CEIL` (0.78) and nowhere near `ACID` (0.79). §9 is intact: the enemy still owns
     * the top of the value ladder and both reserved hues. The shadow band is `TEAL`, the
     * palette's own "a warm surface takes a cool shadow" rule, which is also what the trim
     * material already does — the shader multiplies it by ~0.6, so the cel break is real.
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    /**
     * The LOOK of a field, minus its colour and minus its map — everything that makes the frame
     * read as the frame under the cel shader. A surfaced variant of a field spreads this, so a
     * patterned receiver and a plain one are the same material in every respect except the marks
     * printed on it. That is what keeps the value ladder below from drifting per weapon.
     */
    const FRAME_LOOK: FieldLook = {
      shadowColor: PALETTE.TEAL,
      rimColor: PALETTE.ELECTRIC,
      rimStrength: 0.26,
      halftoneAngle: 75,
      toneFloor: 0.22,
      specular: 0.5,
      gleam: 0.55,
      gleamSize: 0.3,
      // The gun is 30 cm from the eye and `FOG_NEAR` is tens of metres away; participating in
      // distance fog can only ever be a rounding error, so it is switched off outright.
      fog: 0,
    };
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * THE VALUE LADDER — WEAPON_ART §2's "biggest available win", and it is not a metaphor.
     *
     * The gun shipped as ONE grey with a BONE trim, which is the actual reason it read as five
     * untextured boxes: under a flat cel shader with no texture maps, a value break between two
     * adjacent masses is the ONLY interior detail that the 7 px ink line cannot erase. Geometry
     * costs clearance budget and risks the ink floor; a second flat field costs neither.
     *
     * Four fields now, and they are a real ladder rather than four nearby greys:
     *
     *   polymer  ~0.29   grip · heel · fore-end · stock · trigger · selector · mag well · panels
     *   frame    ~0.44   receiver · slide · barrel · guard          (unchanged, the reference)
     *   steel    ~0.57   port frame · charging handle · rail teeth · magazine
     *   BONE      0.73   sights · muzzle brake                      (unchanged)
     *
     * ART §9 IS INTACT. The whole ladder sits under `READABILITY.ENV_VALUE_CEIL` (0.78) and under
     * `ACID` (0.79) — the enemy still owns the top of the value ladder and both reserved hues,
     * and `GOLD` still means "interactable" and appears on this object only as the muzzle core.
     *
     * AND THE MATERIALS DIFFER BY MORE THAN VALUE, which is the half of this that is free.
     * Polymer is matte: specular 0.10, gleam 0.08, a wide soft tone floor. Steel is machined:
     * specular 0.85 with a small tight gleam. Two masses at the same value under the same light
     * still separate when one of them takes a hard clipped highlight and the other takes none, so
     * the split survives even when the gun is lit flat. Halftone angles are 15° apart per family
     * (ART §2.2) so the shadow bands do not moiré into each other.
     *
     * The polymer value is deliberately NOT taken below SLATE's 0.32 by much: the note above
     * records what happened when the whole gun sat at 0.26 against a SLATE wall. This is a
     * minority field bounded on every side by the 0.44 frame, which is what makes 0.29 safe here
     * and would not make it safe for the body.
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    const POLYMER_LOOK: FieldLook = {
      shadowColor: PALETTE.INK_SOFT,
      rimColor: PALETTE.ELECTRIC,
      rimStrength: 0.30,
      halftoneAngle: 60,
      toneFloor: 0.30,
      specular: 0.10,
      gleam: 0.08,
      gleamSize: 0.45,
      fog: 0,
    };
    const STEEL_LOOK: FieldLook = {
      shadowColor: PALETTE.TEAL,
      rimColor: PALETTE.ELECTRIC,
      rimStrength: 0.28,
      halftoneAngle: 0,
      toneFloor: 0.24,
      specular: 0.85,
      gleam: 0.75,
      gleamSize: 0.20,
      fog: 0,
    };
    /** The ONE warm mark on the weapon, and it lives on the silhouette. Never GOLD: GOLD means
     *  "you can interact with this" (ART §6) and the gun is not a pickup. */
    const accentMat = makeInkMaterial({
      name: 'Ink:viewmodel-accent',
      color: PALETTE.RUST,
      shadowColor: PALETTE.TEAL,
      rimColor: PALETTE.SODIUM,
      rimStrength: 0.3,
      halftoneAngle: 15,
      toneFloor: 0.18,
      specular: 0.3,
      gleam: 0.35,
      gleamSize: 0.28,
      fog: 0,
    });
    /** The glove. Cool and a value step below the frame, so the hand reads as a separate
     *  object behind the gun rather than as more gun. */
    const gloveMat = makeInkMaterial({
      name: 'Ink:viewmodel-glove',
      color: hexMix(PALETTE.TEAL, PALETTE.INK_SOFT, 0.38),
      shadowColor: PALETTE.INK_SOFT,
      rimColor: PALETTE.ELECTRIC,
      rimStrength: 0.22,
      halftoneAngle: 30,
      toneFloor: 0.26,
      specular: 0.28,
      gleam: 0.22,
      gleamSize: 0.34,
      fog: 0,
    });
    const trimMat = makeInkMaterial({
      name: 'Ink:viewmodel-trim',
      color: PALETTE.BONE,
      shadowColor: PALETTE.TEAL,
      rimColor: PALETTE.ELECTRIC,
      rimStrength: 0.24,
      halftoneAngle: 45,
      toneFloor: 0.2,
      specular: 0.62,
      gleam: 0.7,
      gleamSize: 0.26,
      fog: 0,
    });
    /**
     * THE SIGHTS. `BONE` (luma 0.73) with a tone floor of 0.55, and both numbers are
     * readability, not styling.
     *
     * The body of the gun sits at ~0.44 and drops to a TEAL shadow band; measured, the front
     * post rendered between 0.30 and 0.50 — the same value as the slide right behind it, in a
     * shape 20 px wide. A sight picture whose post has no separation from its own gun is a
     * sight picture the player reads by memory rather than by eye. `BONE` puts it a full step
     * above the frame while staying under `READABILITY.ENV_VALUE_CEIL` (0.78) and below `ACID`
     * (0.79) — ART §9 is untouched, the enemy still owns the top of the ladder and both
     * reserved hues, and BONE is already this gun's vocabulary for machined metal (the muzzle
     * brake and the magazine wear it).
     *
     * The high floor is the other half: a post that falls into shadow when you aim into shadow
     * disappears exactly when you need it. Specular and gleam are near zero on purpose — a
     * glinting front sight would be a moving highlight on the one object the player stares at,
     * i.e. an ART §4.1 leak dressed up as polish.
     */
    const sightMat = makeInkMaterial({
      name: 'Ink:viewmodel-sights',
      color: PALETTE.BONE,
      shadowColor: hexMix(PALETTE.BONE, PALETTE.TEAL, 0.4),
      rimColor: PALETTE.ELECTRIC,
      rimStrength: 0.18,
      halftoneAngle: 45,
      toneFloor: 0.55,
      specular: 0.12,
      gleam: 0.1,
      gleamSize: 0.3,
      fog: 0,
    });
    const coreMat = makeInkMaterial({
      name: 'Ink:viewmodel-core',
      color: PALETTE.GOLD,
      shadowColor: PALETTE.RUST,
      emissive: PALETTE.GOLD,
      emissiveIntensity: 1.1,
      bloom: true,
      halftone: 0,
      fog: 0,
    });
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * SURFACE, THE OTHER HALF OF "FOUR DIFFERENT GUNS".
     *
     * The silhouettes were spread apart (small/compact, boxy, fat+stubby, long+thin). That is
     * one half. This is the other: the four guns are now made of visibly different STUFF, so
     * they are told apart by material as well as by outline — which is the read that survives
     * being seen for a tenth of a second in a corridor.
     *
     * WHY THIS IS NOT "ADDING TEXTURE". Every mark comes from `art/surfaces`, which authors in
     * MULTIPLIER space against a named base: a map cannot invent a colour or a value the field
     * does not have, it can only modulate the field within `READABILITY`'s band. So the value
     * ladder (polymer 0.29 · frame 0.44 · steel 0.57 · BONE 0.73) is untouched, ART §9 is
     * untouched, and no surface is allowed near `ACID`, `HOT` or `GOLD`. `RUST` stays what it
     * already was — the single warm accent — and appears inside a map only where a generator
     * spends it, at chip size, on one gun.
     *
     * AND THE MARKS ARE BOLD BY CONSTRUCTION (`WEAPON_ART` §0): 3–4 wood bands, not 40 lines;
     * 3 vent slots, not 8; 5 diamonds you can count. Under a 7 px hull at 0.30 m, fine detail
     * is grey mush — this project has already lost four parts to exactly that. `mapStrength` is
     * 1 because these maps are an exact modulation and anything less compresses every mark
     * toward flat by `1 + s * (m - 1)`; `mapHalftone` is `WEAPON_SURFACE_MAP`'s 0.22, below the
     * environment's 0.35, because this object already carries the heaviest ink line in the game.
     *
     * WHAT EACH GUN IS MADE OF:
     *
     *   inkslinger  parkerised frame AND slide · taped grip          workmanlike, issued
     *   ratatat     chipped lower · vented upper · knurled grip      used, scrappy, fast
     *   boomstick   WALNUT furniture · knurled pump · plain steel    the wood gun, and only it
     *   longshot    parkerised receiver and stock · knurled bolt     precise, cared-for
     *
     * Boomstick owns wood outright. It is the strongest single identity move available and
     * spending it twice would spend it to nothing, which is why the marksman takes a dark
     * polymer stock in a uniform phosphate finish instead — "one careful finish everywhere" is
     * its own identity, and it is the opposite of the SMG's.
     *
     * COST. Textures are built ONCE, at boot, into the module-level cache in `art/surfaces` and
     * keyed by every argument that can change a pixel — including the BASE, so four guns with
     * four different fields correctly get four different bitmaps and nothing here allocates per
     * frame or per equip. Materials are now built PER GUN (see the factory below), because a
     * shared material cannot wear two colours; only the variants a gun's skin actually names get
     * built, so the count is 5 shared + 16 field = 21 rather than 4 guns × 11 = 44. Draw calls
     * do not move at all — same meshes, same count, one gun visible.
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    const WOOD_LOOK: FieldLook = {
      // Walnut is warm, so it takes a cool shadow (ART §1). Oiled, not lacquered: a little more
      // specular than polymer, nowhere near the machined steel.
      shadowColor: PALETTE.TEAL,
      rimColor: PALETTE.ELECTRIC,
      rimStrength: 0.26,
      halftoneAngle: 60,
      toneFloor: 0.28,
      specular: 0.22,
      gleam: 0.18,
      gleamSize: 0.40,
      fog: 0,
    };

    // The five materials above are the ART DIRECTION rather than the gun — the sights, the one
    // warm accent, the glove, the trim and the muzzle core say the same thing on every weapon,
    // so all four share these instances. Everything below is per gun.
    this.materials.push(accentMat, gloveMat, trimMat, sightMat, coreMat);

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * ONE MATERIAL SET PER GUN — the wiring that lets `FIELDS` actually reach the screen.
     *
     * The field materials used to be built HERE, once, from the single shared `FIELD` constant,
     * and every gun was then handed the same instances. That is precisely why the measured
     * arsenal came back as one colour: `frameParkMat` was the pistol's receiver AND the
     * marksman's, so it could not be blued on one and tan on the other no matter what the
     * palette table said. A material wears exactly one colour; four colours therefore need four
     * materials, and no amount of surface mapping substitutes for that (a map is a MULTIPLIER —
     * identical bases give you the same gun with different scuffs).
     *
     * So the set is built per gun, from `fieldFor(p.id)`, and the gun's own colour is ALSO what
     * gets handed to the surface generator as `base`. That second half is not optional: the
     * generators in `art/surfaces` author their marks in multiplier space RELATIVE TO THE BASE,
     * working out the headroom that base has under `READABILITY.ENV_VALUE_CEIL` and encoding
     * each mark as the texel that lands on the intended output. Feed a generator the old grey
     * while the material wears desert tan and every mark is mis-encoded — clipped, or invisible.
     *
     * LAZILY, AND MEMOISED PER (gun, key). A gun only pays for the variants its skin names:
     * the pistol never asks for wood, the shotgun never asks for a vented upper. That is 16
     * field materials over four guns instead of the 44 a build-them-all loop would make, and it
     * is the reason the count moves 16 → 21 rather than 16 → 49.
     *
     * The TEXTURES underneath are still shared wherever they can be: `art/surfaces` caches by
     * every argument that changes a pixel, base included, so two guns asking for the same
     * pattern on the same field get the same bitmap instance, and four different fields
     * correctly get four different bitmaps. Everything here runs once, inside `build()` — never
     * per frame, never on equip.
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    type MatKey =
      | 'frame' | 'polymer' | 'steel'
      | 'framePark' | 'frameChip' | 'frameVent'
      | 'polyTape' | 'polyKnurl' | 'polyPark' | 'wood' | 'steelKnurl';

    const buildFieldMat = (id: string, key: MatKey): InkMaterial => {
      const f = fieldFor(id);
      switch (key) {
        case 'frame':
          return makeInkMaterial({
            ...FRAME_LOOK, name: `Ink:viewmodel-${id}`, color: f.frame,
          });
        case 'polymer':
          return makeInkMaterial({
            ...POLYMER_LOOK, name: `Ink:viewmodel-${id}-polymer`, color: f.polymer,
          });
        case 'steel':
          return makeInkMaterial({
            ...STEEL_LOOK, name: `Ink:viewmodel-${id}-steel`, color: f.steel,
          });
        case 'framePark':
          return makeInkMaterial({
            ...FRAME_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-frame-parkerised`,
            color: f.frame, map: makeParkerised({ base: f.frame, seed: 8 }).map,
          });
        case 'frameChip':
          return makeInkMaterial({
            ...FRAME_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-frame-chipped`,
            color: f.frame,
            map: makeChippedPaint({ base: f.frame, seed: 12, chips: 7, accent: true }).map,
          });
        case 'frameVent':
          return makeInkMaterial({
            ...FRAME_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-frame-vented`,
            color: f.frame,
            map: makeVentedSteel({ base: f.frame, seed: 4, slots: 3, axis: 'u', rivets: true }).map,
          });
        case 'polyTape':
          return makeInkMaterial({
            ...POLYMER_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-polymer-taped`,
            color: f.polymer,
            map: makeTapeWrap({ base: f.polymer, seed: 6, wraps: 4, slope: 2 }).map,
          });
        case 'polyKnurl':
          return makeInkMaterial({
            ...POLYMER_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-polymer-knurled`,
            color: f.polymer, map: makeKnurled({ base: f.polymer, seed: 5, cells: 5 }).map,
          });
        case 'polyPark':
          return makeInkMaterial({
            ...POLYMER_LOOK, ...WEAPON_SURFACE_MAP,
            name: `Ink:viewmodel-${id}-polymer-parkerised`, color: f.polymer,
            map: makeParkerised({ base: f.polymer, seed: 21, patches: 9, specks: 36 }).map,
          });
        case 'wood':
          return makeInkMaterial({
            ...WOOD_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-wood`,
            color: f.wood,
            map: makeWoodGrain({ base: f.wood, seed: 3, bands: 4, axis: 'u', knot: true }).map,
          });
        case 'steelKnurl':
          return makeInkMaterial({
            ...STEEL_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-steel-knurled`,
            color: f.steel,
            map: makeKnurled({ base: f.steel, seed: 14, cells: 5, size: 128 }).map,
          });
      }
    };

    /**
     * `gunId/key` → the one instance. Every material born here is pushed onto `this.materials`
     * at the moment it is created, so `dispose()` frees exactly what was built — no list to keep
     * in sync by hand, and nothing can be freed twice because the cache guarantees one build.
     */
    const fieldMats = new Map<string, InkMaterial>();
    const matFor = (id: string, key: MatKey): InkMaterial => {
      const cacheKey = `${id}/${key}`;
      const hit = fieldMats.get(cacheKey);
      if (hit) return hit;
      const mat = buildFieldMat(id, key);
      fieldMats.set(cacheKey, mat);
      this.materials.push(mat);
      return mat;
    };

    /**
     * A material plus the tile density its pattern wants, in TILES PER METRE of gun.
     *
     * The number is not a taste dial — it is what decides whether a mark clears the ink line.
     * A pattern puts its marks at a fixed fraction of the tile, so tile size sets mark size:
     * `frameVent` at 13 tiles/m is a 7.7 cm tile whose slots are 13 % of it, i.e. 1.0 cm of real
     * gun ≈ 16 screen px at 0.30 m. `polyKnurl` at 20 is a 5 cm tile with 5 diamonds across it,
     * so each diamond is 1 cm — the "coarse diamond you could count" the spec asks for, and
     * roughly ten times coarser than real knurling, which would vanish entirely.
     *
     * `uv: 0` means the part keeps `applyBoxUV`'s metres-of-position UVs and wears no map.
     */
    // A skin names its material by KEY, not by instance, because the instance depends on which
    // gun is being dressed — `matFor(p.id, key)` in the build loop resolves the key against that
    // gun's palette. The keys and the uv numbers below are unchanged; only the colours moved.
    interface Skin { readonly mat: MatKey; readonly uv: number }
    const plainFrame: Skin = { mat: 'frame', uv: 0 };
    const plainPolymer: Skin = { mat: 'polymer', uv: 0 };
    const plainSteel: Skin = { mat: 'steel', uv: 0 };

    interface WeaponSkin {
      readonly frame: Skin; readonly slide: Skin; readonly polymer: Skin;
      readonly steel: Skin; readonly magazine: Skin;
    }
    const DEFAULT_SKIN: WeaponSkin = {
      frame: plainFrame, slide: plainFrame, polymer: plainPolymer,
      steel: plainSteel, magazine: plainSteel,
    };
    const SKINS: Record<string, WeaponSkin> = {
      // Issued and maintained: one phosphate finish over the whole gun, and a grip somebody
      // wrapped themselves. The tape is the only thing on it that a person did.
      inkslinger: {
        frame: { mat: 'framePark', uv: 16 },
        slide: { mat: 'framePark', uv: 16 },
        polymer: { mat: 'polyTape', uv: 18 },
        steel: plainSteel,
        magazine: plainSteel,
      },
      // Scrappy: paint knocked off the lower in blocks, a vented upper, a knurled grip. Three
      // different marks on three adjacent masses is what makes it read as fast and used.
      ratatat: {
        frame: { mat: 'frameChip', uv: 12 },
        slide: { mat: 'frameVent', uv: 13 },
        polymer: { mat: 'polyKnurl', uv: 20 },
        steel: plainSteel,
        magazine: plainSteel,
      },
      // THE WOOD GUN. Furniture in walnut against a plain steel receiver — the one hue break on
      // any of the four, and the reason this gun is recognisable at a glance. The pump is the
      // part the hand rides, so it is knurled steel, not timber.
      boomstick: {
        frame: plainFrame,
        slide: plainFrame,
        polymer: { mat: 'wood', uv: 14 },
        steel: plainSteel,
        magazine: { mat: 'steelKnurl', uv: 22 },
      },
      // Cared-for: the receiver and the stock wear the same even phosphate, and the only mark
      // anywhere else is the bolt knob you actually grab.
      longshot: {
        frame: plainFrame,
        slide: { mat: 'framePark', uv: 16 },
        polymer: { mat: 'polyPark', uv: 16 },
        steel: { mat: 'steelKnurl', uv: 22 },
        magazine: plainSteel,
      },
    };
    /** Re-project only what is actually going to be sampled; a plain part keeps its own UVs. */
    const skinned = (geo: BufferGeometry, s: Skin): BufferGeometry =>
      (s.uv > 0 ? projectSurfaceUV(geo, s.uv) : geo);

    // ── one Group per weapon, all built now, all but one hidden ──────────────────────────
    // Only the ART-DIRECTION materials are shared across the four: sights, accent, glove, trim
    // and the muzzle core. The FIELDS — frame, slide, polymer, steel — are resolved per gun
    // below, which is the whole point: four palettes cannot live on one material.
    for (const p of PROFILES) {
      const gp = p === PROFILES[0] ? g : buildGunGeometry(p);
      assertClearance(gp, p);

      const group = new Group();
      group.name = `vm-${p.id}`;
      group.visible = false;
      this.root.add(group);

      // The hand is added FIRST so it sorts behind the frame in the (identical) depth order and
      // reads as the thing being held rather than as a mitten laid over the gun.
      // Which stuff THIS gun is made of, in THIS gun's colours. Same meshes, same count — the
      // four differ by field, by colour and by surface, never by an extra draw call. `matFor`
      // builds each (gun, key) pair at most once, so a gun that names `framePark` on both its
      // frame and its slide gets one material for both, exactly as before.
      const sk = SKINS[p.id] ?? DEFAULT_SKIN;
      const mat = (s: Skin): InkMaterial => matFor(p.id, s.mat);

      this.addMesh(gp.hand, gloveMat, 'vm-hand', true, group);
      this.addMesh(skinned(gp.frame, sk.frame), mat(sk.frame), 'vm-frame', true, group);
      // THE DARK FIELD, static: grip, heel, fore-end, stock, trigger, selector, well, panels.
      // On the shotgun this whole field is walnut instead — same mesh, one material swap.
      this.addMesh(skinned(gp.polymer, sk.polymer), mat(sk.polymer), 'vm-polymer', true, group);
      const slide = this.addMesh(skinned(gp.slide, sk.slide), mat(sk.slide), 'vm-slide', true, group);
      // THE LIGHT FIELD, parented to the SLIDE so every machined detail reciprocates with it.
      // Empty until a profile opts into the vocabulary; `addMesh` skips the ink hull in that case
      // rather than welding an attribute that is not there.
      this.addMesh(skinned(gp.steel, sk.steel), mat(sk.steel), 'vm-steel', true, slide);
      // THE SIGHTS GET THEIR OWN MESH AND THEIR OWN, LIGHTER LINE. They ride the slide (so they
      // cycle with it) but they are not the silhouette — they are the one piece of INTERIOR
      // detail on this gun that the player is asked to read precisely, and at the silhouette's
      // 7 px the notch and both light bars inked shut. See the SIGHT block for the measurements.
      this.addMesh(gp.sights, sightMat, 'vm-sights', true, slide, V.sightOutlinePx);
      this.addMesh(gp.accent, accentMat, 'vm-accent', true, group);
      // Rides the slide, so it cycles with it on every shot.
      this.addMesh(gp.accentSlide, accentMat, 'vm-accent-slide', true, slide);
      this.addMesh(gp.trim, trimMat, 'vm-trim', true, group);
      // The magazine moves from BONE to STEEL — same mesh, same draw call, one material swap.
      // A bone-white magazine put the gun's brightest value on its largest low mass, hanging
      // below the frame where it competed with the sights for the eye. At the steel value it
      // still reads as a separate inserted object against the 0.44 frame and the dark mag well,
      // which is the read `magWell` exists to sell.
      const mag = this.addMesh(skinned(gp.magazine, sk.magazine), mat(sk.magazine), 'vm-mag', true, group);
      // The muzzle core is the one emissive thing on the gun. It joins LAYER.BLOOM (keeping
      // LAYER.DEFAULT, which `markBloom` does not clear) so the selective bloom halos it.
      const core = this.addMesh(gp.core, coreMat, 'vm-core', false, group);
      markBloom(core, false);

      const socket = aimSocketOf(p);
      this.models.set(p.id, {
        id: p.id, geo: gp, group, slideMesh: slide, magMesh: mag, socket, ads: adsOffsetOf(socket),
        restDz: p.restDz ?? 0,
      });
    }
    // The starter is what you are holding at boot; `equip(id)` re-points everything on a swap.
    this.equip(PROFILES[0]?.id);

    this.root.name = 'viewmodel';
    // The root's world matrix is composed by hand from the camera every lateUpdate, so three
    // must not recompute it from position/quaternion/scale.
    this.root.matrixAutoUpdate = false;
    this.root.frustumCulled = false;
    scene.add(this.root);
  }

  private addMesh(
    geo: BufferGeometry, mat: InkMaterial, name: string, outline: boolean, parent?: Object3D,
    outlinePx?: number,
  ): Mesh {
    const mesh = new Mesh(geo, mat);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    (parent ?? this.root).add(mesh);
    this.meshes.push(mesh);

    // An EMPTY part group is legal — the detail vocabulary is opt-in, so `steel` has nothing in
    // it until a profile asks for something. `mergeForStatic` hands back a bare BufferGeometry in
    // that case; three renders it as zero triangles, but `buildOutlineHull` would try to weld an
    // attribute that is not there. So the hull is skipped rather than the mesh.
    if (outline && geo.getAttribute('position')) {
      // ART §9 / M2 §1: enemy 8 px > VIEWMODEL 7 px > heaviest prop 6 px. One contract, in
      // `READABILITY` — at the prop cap the gun's contour was indistinguishable from the
      // dumpster in front of it, which is a missing ink hierarchy exactly where the player is
      // looking. `hullBoil` is 0; see the tuning file for why.
      const px = outlinePx ?? READABILITY.VIEWMODEL_OUTLINE_PX;
      const hull = buildOutlineHull(geo, {
        thickness: px,
        minThickness: Math.min(3.5, px),
        boil: V.hullBoil,
        ink: PALETTE.INK,
      });
      hull.frustumCulled = false;
      mesh.add(hull);
      this.hulls.push(hull);
    }
    return mesh;
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    for (const h of this.hulls) {
      h.parent?.remove(h);
      (h.material as { dispose(): void }).dispose();
    }
    this.hulls.length = 0;
    for (const m of this.meshes) m.geometry.dispose();
    this.meshes.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    // The surface TEXTURES are deliberately not disposed: they live in `art/surfaces`' module
    // cache, keyed by their arguments, and the gallery samples the same instances. Freeing them
    // from here would free them out from under another owner to reclaim ~2 MB at teardown.
    this.geo = null;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Impulses
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * A shot. `kickScale` is the def's `weaponKick`; `patternYaw` is the sign of this shot's
   * lateral recoil so the model twists the same way the camera does — the two layers must
   * disagree in MAGNITUDE and TIMING, never in direction.
   */
  fire(kickScale: number, patternYaw: number, adsAmount: number): void {
    const s = kickScale * lerp(1, V.kickAdsMult, clamp01(adsAmount));
    if (s <= 0) return;

    const yawSign = patternYaw === 0 ? 0 : Math.sign(patternYaw);

    this.kickPos.impulse(
      0,
      impulseFor(V.kickPosHz, V.kickPosDamping, V.kickUp * s),
      impulseFor(V.kickPosHz, V.kickPosDamping, V.kickBack * s),
    );
    this.kickRot.impulse(
      impulseFor(V.kickRotHz, V.kickRotDamping, V.kickPitchDeg * DEG2RAD * s),
      impulseFor(V.kickRotHz, V.kickRotDamping, V.kickYawDeg * DEG2RAD * s * yawSign),
      impulseFor(V.kickRotHz, V.kickRotDamping, -V.kickRollDeg * DEG2RAD * s),
    );
    // The slide is the one mechanical animation on this gun and it only ever runs on a shot.
    this.slideSpring.impulse(impulseFor(14, 0.5, 0.020 * V.depthCompress));
  }

  /**
   * Weapon drawn / swapped to. Plays the raise, and — when an id is given — swaps which model is
   * visible and REBINDS THE AIM SOLVE to that gun's own sight socket.
   *
   * That rebind is the whole reason this takes an argument. The four receivers sit at four
   * heights, so a shared socket would leave the sight picture off the bullet on three of them,
   * which is the exact bug already reported once as "you aim like inside the pistol".
   */
  equip(defId?: string): void {
    if (defId) {
      const next = this.models.get(defId);
      if (next && next !== this.active) {
        if (this.active) this.active.group.visible = false;
        next.group.visible = true;
        this.active = next;
        this.geo = next.geo;
        this.slideMesh = next.slideMesh;
        this.magMesh = next.magMesh;
        AIM_SOCKET = next.socket;
        ADS = next.ads;
        ADS_X = ADS.x;
        ADS_Y = ADS.y;
        ADS_Z = ADS.z;
        REST_DZ = next.restDz;
      }
    }
    this.equipT = 0;
    this.kickPos.reset();
    this.kickRot.reset();
    this.swayPos.reset();
    this.swayRot.reset();
  }

  /** Active reload nailed — a snap of the wrist. */
  activeSuccess(): void {
    this.flourish = 1;
    this.flourishSign = -this.flourishSign;
  }

  /** Active reload missed — the stumble (GAME_BIBLE §3). */
  activeMiss(): void {
    this.stumble = 1;
  }

  /** Landing. `impactSpeed` is the downward speed at touchdown, m/s. */
  landed(impactSpeed: number): void {
    const dip = Math.min(impactSpeed * V.landDipPerSpeed, V.landDipMax);
    if (dip <= 0) return;
    this.landSpring.impulse(impulseFor(6.5, 0.62, -dip));
  }

  reset(): void {
    this.swayPos.reset();
    this.swayRot.reset();
    this.kickPos.reset();
    this.kickRot.reset();
    this.slideSpring.reset();
    this.landSpring.reset();
    this.bobWeight = 0;
    this.adsPose = 0;
    this.sprintPose = 0;
    this.equipT = 1;
    this.flourish = 0;
    this.stumble = 0;
    this.hasPrev = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Per-frame — advance the layers. `dt` is unscaled frame time; the gun never freezes in
  // hitstop, which is what makes hitstop read as the WORLD stopping rather than the game.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  update(dt: number, d: ViewmodelDrive): void {
    const eps = V.restEpsilon;

    // ── pose blends ───────────────────────────────────────────────────────────────────────
    this.adsPose = settle(this.adsPose, clamp01(d.adsAmount), V.adsPoseHalfLife, dt, 1e-4);
    // A reload takes both hands: you cannot be in the sprint pose while doing one.
    const wantSprint = d.reloadProgress >= 0 ? 0 : clamp01(d.sprintAmount) * (1 - this.adsPose);
    // ASYMMETRIC (BUILD 005). Dropping into the sprint pose is allowed to take a beat; COMING
    // OUT of it never is, because the frame the player presses fire is the frame they expect a
    // bullet, and a gun that is still swinging up is a gun that lied to them. Both halves still
    // end on `settle`'s exact snap, so §4.1 is untouched.
    const half = wantSprint > this.sprintPose ? V.sprintInHalfLife : V.sprintOutHalfLife;
    this.sprintPose = settle(this.sprintPose, wantSprint, half, dt, 1e-4);

    if (this.equipT < 1) {
      this.equipT = Math.min(1, this.equipT + dt / Math.max(WEAPON.equipTime, 1e-3));
    }

    // ── sway: the gun trails the view, then stops dead ────────────────────────────────────
    //
    // Driven purely by the view's ANGULAR RATE. Stop moving the mouse and the target is exactly
    // zero, the spring settles, `settleSpringVec` snaps it, and this layer contributes nothing —
    // which is what makes the stillness test survivable (ART §4.1).
    const swayScale = (1 - this.adsPose * 0.75);
    const sx = clamp(-d.lookRateX * V.swayPos, -V.swayPosMax, V.swayPosMax) * swayScale;
    const sy = clamp(-d.lookRateY * V.swayPos, -V.swayPosMax, V.swayPosMax) * swayScale;
    this.swayPos.target.set(sx, sy, 0);
    this.swayPos.step(dt);
    settleSpringVec(this.swayPos, eps);

    const rMax = V.swayRotMaxDeg * DEG2RAD;
    const rx = clamp(d.lookRateY * V.swayRotDeg * DEG2RAD, -rMax, rMax) * swayScale;
    const ry = clamp(d.lookRateX * V.swayRotDeg * DEG2RAD, -rMax, rMax) * swayScale;
    // The roll trails the yaw — the wrist rotates a beat after the arm swings.
    this.swayRot.target.set(rx, ry, -ry * 0.55);
    this.swayRot.step(dt);
    settleSpringVec(this.swayRot, eps);

    // ── bob weight ────────────────────────────────────────────────────────────────────────
    const bobbing = d.grounded && d.moving && d.reloadProgress < 0;
    this.bobWeight = settle(this.bobWeight, bobbing ? 1 : 0, V.bobBlendHalfLife, dt, 1e-4);

    // ── springs ───────────────────────────────────────────────────────────────────────────
    this.kickPos.step(dt);
    this.kickRot.step(dt);
    settleSpringVec(this.kickPos, eps);
    settleSpringVec(this.kickRot, eps);

    this.slideSpring.target = 0;
    this.slideSpring.step(dt);
    settleSpring(this.slideSpring, eps);

    this.landSpring.target = 0;
    this.landSpring.step(dt);
    settleSpring(this.landSpring, eps);

    // ── one-shot decays ───────────────────────────────────────────────────────────────────
    if (this.flourish > 0) {
      this.flourish = Math.max(0, this.flourish - dt * 4.5);
    }
    if (this.stumble > 0) {
      this.stumble = Math.max(0, this.stumble - dt * 2.6);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Compose — the only place the transform is written. Sum every layer, once, in a fixed order.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  compose(camera: PerspectiveCamera, d: ViewmodelDrive): void {
    if (!this.geo) return;

    // ── 1. base pose: hip → ADS → sprint ──────────────────────────────────────────────────
    //
    // At a = 1 this is the SOLVED ADS transform and nothing else: the rotation is exactly
    // identity, so the model's own -Z is the camera's -Z, and the translation is exactly
    // `-AIM_SOCKET` pushed out to `adsSightDistance`, so the rear notch and the front blade both
    // land on the camera's forward axis — the same axis the bullet is traced along. The rest
    // pose's -14° of yaw is a HIP-FIRE silhouette decision (see the tuning file) and it, the
    // pitch, the roll and the lateral offset all drive to zero here. Do not add a "nice" residual
    // tilt at full ADS: any of it is a sight picture that lies about where the shot goes.
    const a = this.adsPose;
    let px = lerp(V.restX, ADS_X, a);
    let py = lerp(V.restY, ADS_Y, a);
    let pz = lerp(V.restZ + REST_DZ, ADS_Z, a);
    let pitch = lerp(V.restPitchDeg, 0, a) * DEG2RAD;
    let yaw = lerp(V.restYawDeg, 0, a) * DEG2RAD;
    let roll = lerp(V.restRollDeg, 0, a) * DEG2RAD;

    const sp = this.sprintPose;
    if (sp > 0) {
      px = lerp(px, V.sprintX, sp);
      py = lerp(py, V.sprintY, sp);
      pz = lerp(pz, V.restZ + V.sprintZ, sp);
      pitch = lerp(pitch, V.sprintPitchDeg * DEG2RAD, sp);
      yaw = lerp(yaw, V.sprintYawDeg * DEG2RAD, sp);
      roll = lerp(roll, V.sprintRollDeg * DEG2RAD, sp);
    }

    // ── 2. equip raise (ART §8: fast in, overshoot, settle — never a lerp) ────────────────
    if (this.equipT < 1) {
      // 1 - (1-t)^3 with a small overshoot at the end: the gun snaps up and rings once.
      const t = this.equipT;
      const f = 1 - t;
      const e = 1 - f * f * f + Math.sin(t * Math.PI) * 0.12;
      py += V.equipDropY * (1 - e);
      roll += V.equipRollDeg * DEG2RAD * (1 - e);
    }

    // ── 3. walk bob ───────────────────────────────────────────────────────────────────────
    //
    // Phase is DISTANCE-driven, from the same accumulator the camera bob uses, so the two stay
    // locked in the counter-phase relationship ART §10 requires instead of slowly drifting into
    // agreement. Sign: SAME as the camera's, which is OPPOSED on screen — see the tuning file.
    if (this.bobWeight > 0) {
      let amp = Math.min(d.speed / Math.max(MOVE.walkSpeed, 1e-3), V.bobSpeedMax) * this.bobWeight;
      amp *= lerp(1, V.bobAdsMult, a);
      const phase = d.bobDistance * CAMERA.bobCyclesPerMetre * TAU;
      const lateral = Math.sin(phase) * V.bobPhaseSign;
      px += lateral * V.bobAmpX * amp;
      py += Math.sin(phase * 2) * V.bobAmpY * amp * V.bobPhaseSign;
      roll += lateral * V.bobRollDeg * DEG2RAD * amp;
    }

    // ── 4. sway (look lag) ────────────────────────────────────────────────────────────────
    px += this.swayPos.value.x;
    py += this.swayPos.value.y;
    pitch += this.swayRot.value.x;
    yaw += this.swayRot.value.y;
    roll += this.swayRot.value.z;

    // ── 5. reload routine ─────────────────────────────────────────────────────────────────
    if (d.reloadProgress >= 0) {
      const t = clamp01(d.reloadProgress);
      // An arch: down fast, hold low through the magazine work, snap back up at the end.
      const drop = Math.sin(Math.min(t, 1) * Math.PI) ** 0.7;
      py -= V.reloadDropY * drop;
      pz += V.reloadPushZ * drop;
      roll += V.reloadRollDeg * DEG2RAD * drop;
      pitch += V.reloadPitchDeg * DEG2RAD * drop;
      if (this.magMesh) {
        const magT = clamp01((t - V.reloadMagOutT) / Math.max(V.reloadMagInT - V.reloadMagOutT, 1e-3));
        // Out fast, in slow: the drop is gravity, the seat is deliberate.
        const outIn = magT < 0.5 ? magT * 2 : 1 - (magT - 0.5) * 2;
        this.magMesh.position.y = -V.reloadMagDrop * outIn * outIn;
      }
    } else if (this.magMesh && this.magMesh.position.y !== 0) {
      this.magMesh.position.y = 0;
    }

    // ── 6. active-reload flourish / stumble ───────────────────────────────────────────────
    if (this.flourish > 0) {
      const f = this.flourish * this.flourish;
      roll += V.activeSnapDeg * DEG2RAD * f * this.flourishSign;
      pitch -= V.activeSnapDeg * DEG2RAD * 0.4 * f;
    }
    if (this.stumble > 0) {
      // A wobble, not a snap: two cycles decaying out. It is a nuisance, not a punishment.
      const w = Math.sin(this.stumble * Math.PI * 4) * this.stumble * this.stumble;
      roll += V.missWobbleDeg * DEG2RAD * w;
      py -= 0.012 * this.stumble;
    }

    // ── 7. recoil kick — the model layer ──────────────────────────────────────────────────
    px += this.kickPos.value.x;
    py += this.kickPos.value.y;
    pz += this.kickPos.value.z;
    pitch += this.kickRot.value.x;
    yaw += this.kickRot.value.y;
    roll += this.kickRot.value.z;

    // ── 8. landing dip ────────────────────────────────────────────────────────────────────
    py += this.landSpring.value;

    // ── 9. moving parts ───────────────────────────────────────────────────────────────────
    if (this.slideMesh) {
      const z = this.slideSpring.value;
      if (this.slideMesh.position.z !== z) this.slideMesh.position.z = z;
    }

    // ── compose ───────────────────────────────────────────────────────────────────────────
    _pos.set(px, py, pz);
    _euler.set(pitch, yaw, roll, 'YXZ');
    _quat.setFromEuler(_euler);
    _local.compose(_pos, _quat, _one);
    this.root.matrix.multiplyMatrices(camera.matrixWorld, _local);
    this.root.matrixWorldNeedsUpdate = true;

    // ── §4.1 stillness telemetry ──────────────────────────────────────────────────────────
    // Compare the composed transform against the previous frame's, exactly. If it is identical,
    // this object's contribution to the frame is identical too — so with a parked camera the
    // gun's pixels are bit-static. Checking the OUTPUT rather than each layer means a future
    // layer that forgets to settle cannot slip past this readout.
    const p = this.prev;
    this.frozen = this.hasPrev
      && p[0] === px && p[1] === py && p[2] === pz
      && p[3] === pitch && p[4] === yaw && p[5] === roll
      && (!this.slideMesh || this.slideMesh.position.z === 0)
      && (!this.magMesh || this.magMesh.position.y === 0);
    p[0] = px; p[1] = py; p[2] = pz;
    p[3] = pitch; p[4] = yaw; p[5] = roll;
    this.hasPrev = true;
  }

  /** Debug readout: metres the model is currently displaced from its rest pose. */
  get kickMagnitude(): number {
    return this.kickPos.value.length();
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE GALLERY'S DOOR INTO THIS FILE
//
// `src/gallery` documents the art direction by showing the REAL object, never a reconstruction
// of it. For the guns that is not a cosmetic preference: the per-weapon skin table, the tile
// densities and `projectSurfaceUV` all live inside `Viewmodel.build()`, so anything assembled
// out in the gallery would be a second, silently diverging copy of the four guns — the exact
// failure the "one generator, one owner" rule exists to prevent.
//
// So the gallery gets the finished, skinned, ink-hulled Group instead, and this file stays the
// only place a gun is made. Two rules kept the door small:
//
//  · ONE Viewmodel, built lazily on the first call and then shared. Four calls would mean four
//    copies of every geometry and 64 materials for four bitmaps. Nothing is built unless a page
//    actually asks — the game imports this module and never touches this function, so it costs
//    the player nothing but a few dead bytes.
//  · The GLOVE IS HIDDEN. It is a third of the viewmodel's mass and it is not the gun; the
//    section is about what the weapon is made of. It is still built, so what the gallery shows
//    is a subtree of the real thing rather than a differently-assembled thing.
//
// The caller may re-parent what it gets back (the gallery does, to frame it) — each id is handed
// out as its own Group and the map below holds the reference regardless of who owns the node.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The four guns, in equip order. The gallery iterates this; the game equips by def id. */
export const GUN_IDS: readonly string[] = PROFILES.map((p) => p.id);

let showpieceVm: Viewmodel | null = null;
const showpieces = new Map<string, Object3D>();

/**
 * The finished model for one gun id — skinned, outlined, glove hidden, in gun space.
 *
 * Documentation only. Nothing in the game calls this, and it must stay that way: the object it
 * returns is a live subtree of a `Viewmodel` this function owns, not a copy.
 */
export function buildGunShowpiece(id: string): Object3D {
  if (!showpieceVm) {
    showpieceVm = new Viewmodel();
    // A detached root: `build()` wants somewhere to put the rig, and this one is never rendered.
    showpieceVm.build(new Group());
    for (const p of PROFILES) {
      const g = showpieceVm.root.getObjectByName(`vm-${p.id}`);
      if (!g) continue;
      g.visible = true;
      // The gun, not the hand holding it.
      const hand = g.getObjectByName('vm-hand');
      if (hand) hand.visible = false;
      showpieces.set(p.id, g);
    }
  }
  const found = showpieces.get(id);
  if (!found) throw new Error(`[weapons/viewmodel] no such gun: ${id}`);
  return found;
}

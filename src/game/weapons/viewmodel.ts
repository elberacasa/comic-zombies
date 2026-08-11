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
  Euler, Group, Matrix4, Mesh, Quaternion, Vector3,
  type BufferGeometry, type Object3D, type PerspectiveCamera,
} from 'three';
import { PALETTE, READABILITY, hexMix } from '@/art/palette';
import {
  bevelBox, inkCylinder, mergeForStatic, place,
} from '@/art/shapes';
import {
  buildOutlineHull, makeInkMaterial, markBloom, type InkMaterial,
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

interface GunProfile {
  /** Matches `WeaponDef.id`. */
  id: string;
  /** Per-gun foreshortening along z. Longer gun → stronger compression. See the note above. */
  depthCompress: number;
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
  {
    id: 'inkslinger',
    depthCompress: V.depthCompress,
    sight: SIGHT,
    receiver: { w: 0.032, h: 0.040, d: 0.150, y: 0.030, z: -0.052 },
    serrations: 4,
    barrel: { r: 0.014, len: 0.056, y: 0.010, z: -0.112 },
    muzzle: { r: 0.017, len: 0.030, z: -0.140, fins: 3, finW: 0.036 },
    magazine: { w: 0.024, h: 0.086, d: 0.036, y: -0.060, z: 0.016 },
    tube: null,
    foreEnd: null,
    stock: null,
    rib: { w: 0.014, h: 0.011, d: 0.104, y: 0.0465, z: -0.052 },
  },
  /**
   * RATATAT — long, low and skeletal. Reads as *fast* before it fires: a slim receiver, a
   * vented shroud, a vertical grip the support hand is obviously clamped onto, and a wire stock
   * that says "this is braced against a shoulder" without adding a solid mass.
   */
  {
    id: 'ratatat',
    /** Longest-but-one gun, so the strongest foreshortening after the marksman. */
    /**
     * 0.52, not 0.60 — MEASURED, twice. At 0.60 rest/reload/equip all read 0.402–0.403 m, and at
     * 0.56 the RELOAD pose alone still did. The budget is 0.40. See the header note.
     */
    depthCompress: 0.56,
    sight: {
      lineY: 0.074, rearZ: 0.014, frontZ: -0.138,
      bladeW: 0.011, rearH: 0.020, frontH: 0.024, bladeD: 0.012, notchHalfGap: 0.010,
    },
    receiver: { w: 0.030, h: 0.044, d: 0.184, y: 0.032, z: -0.066 },
    serrations: 5,
    barrel: { r: 0.012, len: 0.078, y: 0.012, z: -0.140 },
    muzzle: { r: 0.015, len: 0.026, z: -0.176, fins: 2, finW: 0.032 },
    /** The long curved stick mag — the single most recognisable thing about an SMG. */
    magazine: { w: 0.022, h: 0.100, d: 0.032, y: -0.072, z: 0.020 },
    tube: null,
    /** Vertical foregrip. The support hand read. */
    foreEnd: { w: 0.026, h: 0.056, d: 0.030, y: -0.020, z: -0.132, ribs: 3 },
    stock: { w: 0.024, h: 0.040, d: 0.086, y: 0.020, z: 0.074, skeleton: true },
    rib: { w: 0.013, h: 0.011, d: 0.130, y: 0.0505, z: -0.066 },
  },
  /**
   * BOOMSTICK — short, fat and top-heavy. Everything about it is BORE: the widest muzzle in the
   * game sitting on a stubby receiver, with a tube slung underneath and a ribbed pump the hand
   * is wrapped around. It should look like it hurts to fire, which is what the 2.6 weaponKick
   * is telling you in the def.
   */
  {
    id: 'boomstick',
    /** 0.58 — the RELOAD pose was the offender at 0.418 m, worst of any gun, then 0.403 at 0.64. */
    depthCompress: 0.58,
    sight: {
      /** A single bead on a low rear notch — a shotgun is pointed, not aimed. */
      lineY: 0.070, rearZ: 0.006, frontZ: -0.110,
      bladeW: 0.012, rearH: 0.018, frontH: 0.022, bladeD: 0.013, notchHalfGap: 0.012,
    },
    receiver: { w: 0.042, h: 0.048, d: 0.128, y: 0.030, z: -0.044 },
    serrations: 3,
    barrel: { r: 0.020, len: 0.058, y: 0.014, z: -0.100 },
    /** The bore. `fins: 0` — a plain flared choke, because the diameter IS the detail. */
    muzzle: { r: 0.028, len: 0.030, z: -0.130, fins: 0, finW: 0 },
    magazine: null,
    tube: { r: 0.014, len: 0.088, y: -0.012, z: -0.090 },
    /** The pump. It rides the `magazine` slot so the reload animation racks it — see build(). */
    foreEnd: null,
    stock: null,
    rib: { w: 0.016, h: 0.011, d: 0.090, y: 0.0525, z: -0.044 },
  },
  /**
   * LONGSHOT — the longest thing in the game, and the only one with a full stock. A raised
   * ghost-ring rail rather than a scope tube (see the header note): the rear aperture sits
   * 30 mm above the pistol's line, which is what makes the ADS picture read as precision.
   */
  {
    id: 'longshot',
    /**
     * The most compressed, because it is authored the longest. 0.46 is MEASURED: at 0.52 this
     * gun reached 0.426 m — past the 0.40 budget AND past `MOVE.radius` (0.42), i.e. it would
     * genuinely have punched the muzzle through walls. Its forward parts were shortened too;
     * compression alone would have squashed it into looking short rather than long.
     */
    depthCompress: 0.46,
    sight: {
      lineY: 0.098, rearZ: 0.020, frontZ: -0.156,
      bladeW: 0.012, rearH: 0.030, frontH: 0.034, bladeD: 0.013, notchHalfGap: 0.013,
    },
    receiver: { w: 0.028, h: 0.042, d: 0.200, y: 0.034, z: -0.076 },
    serrations: 3,
    barrel: { r: 0.013, len: 0.104, y: 0.014, z: -0.166 },
    muzzle: { r: 0.017, len: 0.034, z: -0.218, fins: 4, finW: 0.034 },
    magazine: { w: 0.022, h: 0.078, d: 0.044, y: -0.058, z: 0.008 },
    tube: null,
    /** A long slim handguard rather than a vertical grip — you cradle a marksman rifle. */
    foreEnd: { w: 0.030, h: 0.030, d: 0.082, y: -0.006, z: -0.148, ribs: 4 },
    /** Full stock: the mass behind the grip that says "braced". */
    stock: { w: 0.030, h: 0.060, d: 0.112, y: 0.010, z: 0.086, skeleton: false },
    rib: { w: 0.013, h: 0.011, d: 0.140, y: 0.0545, z: -0.076 },
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
}

interface GunGeometry {
  /** Static lower: frame, grip, trigger guard. */
  frame: BufferGeometry;
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
  const grip = bevelBox(0.030, 0.098, 0.044, 0.008, 13);
  place(grip, { rx: 0.30 });
  place(grip, { y: -0.062, z: 0.016 });
  frameParts.push(grip);

  const heel = bevelBox(0.033, 0.014, 0.050, 0.005, 14);
  place(heel, { rx: 0.30 });
  place(heel, { y: -0.108, z: 0.030 });
  frameParts.push(heel);

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
    frameParts.push(block);
    for (let i = 0; i < fe.ribs; i++) {
      // Ribs run across the SHORT axis of whichever way the fore-end is oriented: stacked down
      // a vertical grip, spaced along a handguard.
      const vertical = fe.h > fe.d;
      const rib = vertical
        ? bevelBox(fe.w + 0.004, 0.008, fe.d + 0.004, 0.002, 82 + i)
        : bevelBox(fe.w + 0.004, fe.h + 0.004, 0.008, 0.002, 82 + i);
      place(rib, vertical
        ? { y: fe.y + fe.h * 0.30 - i * (fe.h * 0.62 / Math.max(1, fe.ribs - 1)), z: fe.z }
        : { y: fe.y, z: fe.z + fe.d * 0.34 - i * (fe.d * 0.68 / Math.max(1, fe.ribs - 1)) });
      frameParts.push(rib);
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
        const rail = bevelBox(st.w, 0.012, st.d, 0.003, 91 + sy);
        place(rail, { y: st.y + sy * st.h * 0.34, z: st.z });
        frameParts.push(rail);
      }
    } else {
      const body = bevelBox(st.w, st.h, st.d, 0.008, 93);
      place(body, { y: st.y, z: st.z });
      frameParts.push(body);
    }
    const pad = bevelBox(st.w + 0.006, st.h + 0.010, 0.016, 0.004, 94);
    place(pad, { y: st.y, z: st.z + st.d * 0.5 + 0.008 });
    frameParts.push(pad);
  }

  // ── slide / receiver: the fat top mass, with cut serrations at the rear ────────────────
  const slide = bevelBox(P.receiver.w, P.receiver.h, P.receiver.d, 0.007, 21);
  place(slide, { y: P.receiver.y, z: P.receiver.z });
  slideParts.push(slide);

  for (let i = 0; i < P.serrations; i++) {
    const serration = bevelBox(P.receiver.w + 0.002, P.receiver.h * 0.65, 0.006, 0.0015, 22 + i);
    place(serration, {
      y: P.receiver.y,
      z: P.receiver.z + P.receiver.d * 0.5 - 0.010 - i * 0.012,
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

  const trigger = bevelBox(0.011, 0.022, 0.011, 0.002, 37);
  place(trigger, { rx: 0.2 });
  place(trigger, { y: -0.032, z: -0.032 });
  trimParts.push(trigger);

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
    place(mag, { rx: 0.30 });
    place(mag, { y: P.magazine.y, z: P.magazine.z });
    magParts.push(mag);

    const plate = bevelBox(P.magazine.w + 0.008, 0.010, P.magazine.d + 0.010, 0.003, 42);
    place(plate, { rx: 0.30 });
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
    ...frameParts, ...slideParts, ...sightParts, ...trimParts, ...accentParts,
    ...accentSlideParts, ...handParts, ...magParts,
  ]) g.dispose();

  // ── the lens compensation + overall scale, applied once to everything ───────────────────
  for (const g of [
    out.frame, out.slide, out.sights, out.trim, out.accent, out.accentSlide, out.hand,
    out.magazine, out.core,
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
  adsX: number = ADS_X, adsY: number = ADS_Y, adsZ: number = ADS_Z,
): readonly Pose[] {
  const kick = V.clearanceKickBudget;
  const rest: Pose = {
    name: 'rest',
    x: V.restX, y: V.restY, z: V.restZ,
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
      x: V.sprintX, y: V.sprintY, z: V.restZ + V.sprintZ,
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

  for (const p of posesToCheck(ads.x, ads.y, ads.z)) {
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
          g.frame, g.slide, g.sights, g.trim, g.accent, g.accentSlide, g.hand, g.magazine, g.core,
        ]) {
          // `sights` and `accentSlide` ride the slide and the magazine has its own reload offset;
          // everything else is rigid to the root.
          const childZ = geo === g.slide || geo === g.sights || geo === g.accentSlide
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
    const bodyMat = makeInkMaterial({
      name: 'Ink:viewmodel',
      color: hexMix(PALETTE.SLATE, PALETTE.BONE, 0.30),
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
    });
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
    this.materials.push(bodyMat, accentMat, gloveMat, trimMat, sightMat, coreMat);

    // ── one Group per weapon, all built now, all but one hidden ──────────────────────────
    // The six materials above are SHARED by all four guns: they are the art direction, not the
    // gun, and four copies would be four times the shader compilation for an identical result.
    for (const p of PROFILES) {
      const gp = p === PROFILES[0] ? g : buildGunGeometry(p);
      assertClearance(gp, p);

      const group = new Group();
      group.name = `vm-${p.id}`;
      group.visible = false;
      this.root.add(group);

      // The hand is added FIRST so it sorts behind the frame in the (identical) depth order and
      // reads as the thing being held rather than as a mitten laid over the gun.
      this.addMesh(gp.hand, gloveMat, 'vm-hand', true, group);
      this.addMesh(gp.frame, bodyMat, 'vm-frame', true, group);
      const slide = this.addMesh(gp.slide, bodyMat, 'vm-slide', true, group);
      // THE SIGHTS GET THEIR OWN MESH AND THEIR OWN, LIGHTER LINE. They ride the slide (so they
      // cycle with it) but they are not the silhouette — they are the one piece of INTERIOR
      // detail on this gun that the player is asked to read precisely, and at the silhouette's
      // 7 px the notch and both light bars inked shut. See the SIGHT block for the measurements.
      this.addMesh(gp.sights, sightMat, 'vm-sights', true, slide, V.sightOutlinePx);
      this.addMesh(gp.accent, accentMat, 'vm-accent', true, group);
      // Rides the slide, so it cycles with it on every shot.
      this.addMesh(gp.accentSlide, accentMat, 'vm-accent-slide', true, slide);
      this.addMesh(gp.trim, trimMat, 'vm-trim', true, group);
      const mag = this.addMesh(gp.magazine, trimMat, 'vm-mag', true, group);
      // The muzzle core is the one emissive thing on the gun. It joins LAYER.BLOOM (keeping
      // LAYER.DEFAULT, which `markBloom` does not clear) so the selective bloom halos it.
      const core = this.addMesh(gp.core, coreMat, 'vm-core', false, group);
      markBloom(core, false);

      const socket = aimSocketOf(p);
      this.models.set(p.id, {
        id: p.id, geo: gp, group, slideMesh: slide, magMesh: mag, socket, ads: adsOffsetOf(socket),
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

    if (outline) {
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
    let pz = lerp(V.restZ, ADS_Z, a);
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

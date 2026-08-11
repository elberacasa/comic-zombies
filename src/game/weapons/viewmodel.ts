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
  type BufferGeometry, type Object3D, type PerspectiveCamera, type ShaderMaterial,
} from 'three';
import { PALETTE, READABILITY, hexMix } from '@/art/palette';
import {
  bevelBox, inkCylinder, mergeForStatic, place,
} from '@/art/shapes';
import {
  WEAPON_SURFACE_MAP,
  makeChippedPaint, makeKnurled, makeParkerised, makeTapeWrap, makeVentedSteel, makeWoodGrain,
} from '@/art/surfaces';
import {
  VIEW_SPACE_INK, buildOutlineHull, makeInkMaterial, markBloom,
  type InkMaterial, type InkMaterialOptions,
} from '@/render/materials/index';
import { DEG2RAD, Spring, SpringVec3, TAU, clamp, clamp01, damp, lambdaFromHalfLife, lerp } from '@/core/mathx';
import { CAMERA, MOVE, WEAPON } from '@/game/tuning';
/**
 * THE ARSENAL. One file per weapon, listed in `models/index.ts`; this file never names a gun.
 * `types.ts` holds the contract those files are written against — the profile, the four colour
 * fields and the skin — so the builder below and the data above it can move independently.
 */
import {
  WEAPON_MODELS, weaponModelFor,
  type FieldSet, type GunProfile, type MatKey, type Skin,
} from './models';

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
/** Camera-space key direction, copied from `WEAPON.view.keyDir` and rotated to world per frame. */
const _key = new Vector3();

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * THE HERO LENS — AND IT IS IN CLIP SPACE, WHICH IS THE ENTIRE POINT.
 *
 * `(k, ncx, ncy)`: the magnification, and its centre in NDC. Every vertex shader in this engine
 * ends with `gl_Position = projectionMatrix * mvPos;`, and `attachHeroLens` appends one line to
 * the copies this object uses:
 *
 *     gl_Position.xy = gl_Position.xy * k + nc * (1 - k) * gl_Position.w;
 *
 * which is `s → k·(s − nc) + nc` after the perspective divide: a 2D magnification of the gun's
 * IMAGE about a fixed point on the screen, with `w` — and therefore depth, and therefore depth
 * testing — untouched.
 *
 * WHY NOT IN WORLD SPACE, WHICH IS WHERE THIS WENT FIRST AND WHERE IT WAS WRONG.
 * The camera-space matrix `xʹ = k·x + (k−1)·cx·z` produces the identical image and costs nothing
 * for a vertex sitting on the `cx` column — which is why it looks like the free lever, and why
 * the rest pose measured 0.376 → 0.370 and it nearly shipped. But the clearance contract is a
 * bound on |x| for **every** vertex in **every** pose, and that transform multiplies |x| by k
 * while compensating only in proportion to DEPTH. The vertices with large x and small depth —
 * the outer edge of the glove, the magazine at the bottom of a rolled reload — get almost no
 * compensation at all. Measured, at k = 2.6, over the real pose table:
 *
 *     pose        reach (budget 0.40)     swayed (budget 0.42)
 *     rest              0.403                    0.441
 *     sprint            0.446                    0.477
 *     reload            0.636                    0.674     ← inkslinger; the ratatat hit 0.714
 *
 * i.e. a hand through the wall you are hugging. No `(k, cx)` fixes it: the contract bounds |x|
 * and the transform scales |x|.
 *
 * IN CLIP SPACE THE GEOMETRY DOES NOT MOVE AT ALL. Every number in `assertClearance`'s table is
 * bit-for-bit what it was before this lens existed, on every gun and every pose, because the
 * thing being measured is untouched. And it is the contract's own guarantee that makes drawing
 * the image anywhere on the screen safe: nothing static can be within `MOVE.radius`, so the gun
 * is nearer than the world at every pixel it can possibly land on, and it wins the depth test
 * there for the same reason it won it where it used to be drawn.
 *
 * Identity by default, so anything that renders these materials without running `compose()` —
 * `buildGunShowpiece`, i.e. the gallery — gets the plain, unmagnified gun.
 */
const HERO_LENS = { uHeroLens: { value: new Vector3(1, 0, 0) } };

/** The one line in every vertex shader here that hands a clip-space position to the GPU. */
const CLIP_ANCHOR = 'gl_Position = projectionMatrix * mvPos;';

/**
 * AND THE LINE THE INK HULL SIZES ITSELF WITH — because a clip-space magnification scales the
 * SILHOUETTE INFLATION TOO, and that is not what an ink line is.
 *
 * `READABILITY.VIEWMODEL_OUTLINE_PX` is a contract in SCREEN PIXELS (enemy 8 > viewmodel 7 >
 * heaviest prop 6). The hull inflates in view space by whatever projects to that many pixels,
 * so magnifying its clip position magnifies the line with it: measured, the weapon's share of
 * near-black pixels went the WRONG WAY, 32% → 48.7%, because a 7 px contour had quietly become
 * an 18 px one. Dividing the inflation by the same magnification restores the contract exactly
 * — and because the divide is by the live uniform, the line is still 7 px at every point of the
 * ADS blend, where the magnification is on its way to 1.
 */
const HULL_ANCHOR = 'float scale = max(uThickness, uMinThickness) * px * 2.2;';

/**
 * Patch one material's vertex shader with the lens and point it at the shared uniform.
 *
 * The source string is rewritten directly rather than through `onBeforeCompile`, because these
 * are `ShaderMaterial`s: three keys its program cache on the SOURCE of a custom shader, so a
 * rewritten string gets its own program by construction and cannot collide with the identical
 * unpatched shader every wall in the arena is drawn with.
 */
function attachHeroLens(mat: ShaderMaterial): void {
  if (!mat.vertexShader.includes(CLIP_ANCHOR)) {
    if (import.meta.env?.DEV) {
      console.warn(
        `[weapons/viewmodel] hero lens: the clip anchor is gone from ${mat.name || 'a material'}`
        + "'s vertex shader, so the viewmodel will render un-magnified. Re-anchor the patch.",
      );
    }
    return;
  }
  mat.uniforms.uHeroLens = HERO_LENS.uHeroLens;
  mat.vertexShader = `uniform vec3 uHeroLens;\n${mat.vertexShader}`
    .replace(
      CLIP_ANCHOR,
      `${CLIP_ANCHOR}\n    gl_Position.xy = gl_Position.xy * uHeroLens.x`
      + ' + uHeroLens.yz * (1.0 - uHeroLens.x) * gl_Position.w;',
    )
    .replace(
      HULL_ANCHOR,
      'float scale = max(uThickness, uMinThickness) * px * 2.2 / max(uHeroLens.x, 0.001);',
    );
}

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

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE RATE-AWARE KICK SPRING. `WEAPON.view.kickSettleResidual` carries the full derivation and
 * the measurement that forced it; this is the two lines of maths.
 *
 * A damped spring's envelope decays as `exp(-ζ·ω·t)`, so the time to fall to residual `r` is
 * `-ln(r)/(ζ·ω)`. Invert it: given the gap until the next shot, this is the SLOWEST frequency
 * that is substantially home before that shot lands. The authored `kickPosHz`/`kickRotHz` are a
 * floor, so any weapon whose shots are further apart than its own settle time gets exactly the
 * authored spring and is untouched by this function to the last bit.
 */
function kickHzFor(floorHz: number, zeta: number, gap: number): number {
  if (!Number.isFinite(gap)) return floorHz;
  const z = Math.max(zeta, 0.05);
  const r = clamp(V.kickSettleResidual, 1e-3, 0.99);
  // `max(gap, 1e-4)` is only a divide-by-zero guard — the trigger fires at most once per frame
  // and the clock advances every frame, so a real gap is never zero. `kickHzMax` is the one that
  // does work: past it the spring is faster than the display and the kick would simply vanish.
  const need = -Math.log(r) / (TAU * z * Math.max(gap, 1e-4));
  return clamp(need, floorHz, Math.max(floorHz, V.kickHzMax));
}

/**
 * The safety net (`kickPosMax` / `kickRotMaxDeg`). Scales value AND velocity by the same factor
 * so the clamp contracts the spring's whole state rather than pinning a position against a
 * velocity that is still winding outward — a spring held at a wall would release as a snap.
 * Allocation-free: `Vector3.length` and `multiplyScalar` both work in place.
 */
function clampSpringVec(s: SpringVec3, max: number): void {
  const len = s.value.length();
  if (len <= max || len <= 0) return;
  const k = max / len;
  s.value.multiplyScalar(k);
  s.velocity.multiplyScalar(k);
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
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE RIM IS NO LONGER CYAN, AND THAT WAS THE BLUE.
 *
 * Every viewmodel material used `rimColor: PALETTE.ELECTRIC` — 0x00e5ff, PURE CYAN — and a
 * Fresnel rim is strongest at grazing angles, i.e. exactly the edges nearest the camera. So all
 * four weapons wore an identical bright cyan light along every near edge, which is precisely what
 * the playtester kept reporting after three separate passes at the base colours: "they still all
 * look blue close to the hand and in the back of the gun". No base colour could have fixed it —
 * the rim sat on top of all of them, the same on every gun.
 *
 * It was also a palette violation hiding in plain sight: the palette's own comment calls ELECTRIC
 * "a UI/player signal", not a material colour.
 *
 * Warm and dim now — a soft bounce off the world rather than a light show — so it describes the
 * edge without repainting it, and each gun's own colour is what survives at the silhouette.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
const VIEW_RIM = hexMix(PALETTE.CONCRETE, PALETTE.RUST, 0.22);

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE HERO LIGHTING POLICY — one place, applied to every material on this object.
 *
 * MEASURED, on the shipped frame, by rendering it twice (viewmodel on / off) and differencing:
 * the weapon's own pixels averaged **0.137 luma against a frame mean of 0.270, with 57.6% of
 * them under 0.10** — i.e. the object the player looks at 100% of the time was rendering at
 * half the brightness of the average pixel around it, and more than half of it was effectively
 * ink. That is the "dark unreadable blob", as a number rather than as an impression.
 *
 * WHAT THE MEASUREMENT SAID WAS *NOT* THE CAUSE, because three passes had already guessed wrong:
 *   · the key DIRECTION is worth ±0.02 luma. Swept over eight directions, best to worst, it
 *     never moved the number more than that. It is worth getting right (`WEAPON.view.keyDir`
 *     does) but it was never going to be the fix on its own.
 *   · the ink hull is worth 0.06 — real, and it is *already* paid back by the hero lens, which
 *     made the gun 2.2× wider on screen while its 7 px line stayed 7 px.
 *   · `toneFloor` and `halftone` are worth 0.01 between them. Not the problem.
 *   · **the SHADOW BAND is worth 0.15**, and that is where the mass of the object lives. Under
 *     `bandify()` the unlit band multiplies to 0.16 and the flats are then dropped into a
 *     near-black `TEAL`/`INK_SOFT`, so the largest surfaces of the gun printed as void.
 *
 * So the policy lifts the SHADOW BAND and leaves the FLATS alone. That split is deliberate and
 * it is also an ownership boundary: the four field colours are authored per weapon, next to
 * each weapon's shape, in `models/<id>.ts` — three passes of per-gun colour work live in those
 * numbers and this file does not get to overwrite them. What this file owns is how the object
 * is LIT, and a shadow that is a midtone rather than a hole is a lighting decision. It is also
 * the house rule already stated in the ink shader: *"A graphic novel is built on MIDTONES;
 * black is reserved for the linework."*
 *
 * `valueLift` raises HSV **value** and leaves hue and HSV saturation exactly alone, so a lifted
 * shadow is the same colour it always was, brighter — never a wash toward white, which would
 * desaturate the whole gun at the moment the pivot asked for LOUDER. No hue moves, so ART §9's
 * reserved channels cannot be touched by any of this: `ACID`/`HOT` stay with enemies, `GOLD`
 * with interactables, and the muzzle core keeps its own emissive because it sets one.
 *
 * RESULT, same measurement, same frame, and split so it is honest about which half did what:
 *
 *                                   gun mean luma   under 0.10 luma   non-ink surfaces
 *   before                              0.137            57.6%             0.288
 *   lighting policy only (lens off)     0.207            32.4%             0.300
 *   shipped (policy + hero lens)        0.297            ~25%              0.369
 *
 * against an unchanged frame mean of **0.270**. Two separate wins and they are not the same
 * win: the policy lifts the SURFACES (0.288 → 0.369 on everything that is not linework), and
 * the lens halves the share of the object that is linework at all, because a 7 px hull on a
 * 2.6× wider silhouette is 2.6× less of it. The weapon now reads above the frame's own mean —
 * it is the brightest thing in its own picture, which is what it is.
 */
const HERO_LIGHT = {
  /**
   * ONE STOP ON THE FLATS, as a MULTIPLIER and never as a lerp.
   *
   * `×1.70`, hard-capped at `READABILITY.ENV_VALUE_CEIL`. A multiplier is the whole point:
   * every field keeps its ratio to every other field, so WEAPON_ART §2's value ladder — the
   * one interior read a 7 px ink line cannot erase — comes through the lift with its spacing
   * intact, and so does every per-gun difference authored in `models/<id>.ts`. A lerp toward
   * a light colour would have crushed a 0.19 → 0.81 ladder into 0.48 → 0.86 and thrown away
   * three passes of somebody else's work in one line.
   *
   * ART §9 IS WHAT SETS THE CAP. `ENV_VALUE_CEIL` is 0.78 and `ACID` is 0.79, so the enemy
   * still owns the top of the value ladder by construction: no surface on this weapon can be
   * lifted past the ceiling, and the one flat that was already sitting above it (the BONE trim
   * at 0.81) is brought DOWN to it. Hue and saturation are untouched, so no reserved channel
   * can move: `ACID`/`HOT` stay enemy, `GOLD` stays interactable.
   */
  flatLift: 1.70,
  flatCap: 0.78,
  /** How far the shadow band is lifted toward full value, and the ceiling it may not pass. */
  shadowLift: 0.75,
  shadowCap: 0.78,
  /**
   * AND THE CEILING THAT ACTUALLY BINDS: a shadow band may never come within this fraction of
   * its own FLAT's value.
   *
   * The first cut of this policy did not have it, and it inverted three materials outright —
   * the sights are deliberately dark iron (flat value 0.30, the playtester asked for it three
   * times) over a near-black shadow, so a flat 0.78 ceiling lifted their *shadow* to 0.78 and
   * printed the unlit side of the post brighter than the lit side. A cel shader with the bands
   * the wrong way round is not a bright gun, it is a broken one. Every lift is now relative to
   * the surface it belongs to, which is also why the glove and the sights keep the values two
   * playtest passes put on them while the receiver, the slide and the steel get the whole lift.
   */
  shadowVsFlat: 0.85,
  /** Multipliers on each look's own numbers, so the material families keep their spacing. */
  rim: 2.2,
  gleam: 1.6,
  specular: 1.35,
  /**
   * A self-lit floor, in the surface's OWN flat colour — the one object in the frame a comic
   * colourist would keep in full colour on every page, whatever the light is doing around it.
   * Worth 0.03 of mean luma at 0.50 and it is the only lever left that does not either crush
   * the value ladder or touch a hue; past ~0.7 it starts flattening the cel break itself.
   */
  emissive: 0.50,
} as const;

/**
 * Raise a colour's HSV **value** toward `cap`, preserving hue and saturation exactly.
 *
 * Not `hexMix(c, WHITE, t)`: that is a lerp toward white, which raises value AND destroys
 * saturation — the exact opposite of what §1.5 asked for. Scaling all three channels by one
 * factor moves the colour straight out along its own hue ray.
 */
function hsvValue(hex: number): number {
  return Math.max((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff) / 255;
}

function scaleValue(hex: number, k: number): number {
  const ch = (x: number): number => Math.min(255, Math.round(x * k));
  return (ch((hex >> 16) & 0xff) << 16) | (ch((hex >> 8) & 0xff) << 8) | ch(hex & 0xff);
}

/** Multiply a colour's value by `mul`, clamped to `cap`. Ratios between colours survive. */
function valueScale(hex: number, mul: number, cap: number): number {
  const v = hsvValue(hex);
  if (v <= 0) return hex;
  return scaleValue(hex, Math.min(cap, v * mul) / v);
}

/** Raise a colour's value toward `cap` by `amount` of the remaining headroom. Never darkens. */
function valueLift(hex: number, amount: number, cap: number): number {
  const v = hsvValue(hex);
  // Pure black has no hue ray to travel along; leave it, or the lift invents a grey.
  if (v <= 0) return hex;
  return scaleValue(hex, Math.max(1, Math.min(cap, v + amount * (1 - v)) / v));
}

/**
 * Every material on the viewmodel is built through here, so the policy above cannot be applied
 * to fifteen of the sixteen and then quietly diverge. Anything a call site states explicitly for
 * `emissive` (the muzzle core does) is left exactly as it asked.
 */
function heroInk(opts: InkMaterialOptions): InkMaterial {
  const flat = valueScale(opts.color, HERO_LIGHT.flatLift, HERO_LIGHT.flatCap);
  const mat = makeInkMaterial({
    ...opts,
    color: flat,
    // The shadow chases its OWN flat, never the ceiling — see `shadowVsFlat`.
    shadowColor: opts.shadowColor === undefined
      ? undefined
      : valueLift(
        opts.shadowColor,
        HERO_LIGHT.shadowLift,
        Math.min(HERO_LIGHT.shadowCap, hsvValue(flat) * HERO_LIGHT.shadowVsFlat),
      ),
    rimStrength: Math.min(1, (opts.rimStrength ?? 0.22) * HERO_LIGHT.rim),
    gleam: Math.min(1, (opts.gleam ?? 0) * HERO_LIGHT.gleam),
    specular: Math.min(1, (opts.specular ?? 0.35) * HERO_LIGHT.specular),
    emissive: opts.emissive ?? flat,
    emissiveIntensity: opts.emissiveIntensity ?? HERO_LIGHT.emissive,
  });
  attachHeroLens(mat);
  return mat;
}


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

/** This weapon's four flat colour fields. Authored in `models/<id>.ts`, next to its shape. */
function fieldFor(id: string): FieldSet {
  return weaponModelFor(id).fields;
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
 *
 * ─── THE ONE PART THIS CANNOT BE ASKED ABOUT ────────────────────────────────────────────────
 * An `opticBlock` DELIBERATELY straddles the line: its whole point is solid material above the
 * hole as well as below it, so it is above the ceiling by construction and always will be.
 * Leaving it out of the check would leave a permanent false warning to be trained away, which is
 * how a guard stops being read at all — so the part is routed through here WITH ITS BORE, and in
 * that mode the ceiling test is replaced by the two questions that are actually load-bearing for
 * a straddling part:
 *
 *   · does the bore CONTAIN the sight line (if not, the player sights at iron, not through it);
 *   · is it BEHIND the front element (a window forward of what it frames is not a window).
 */
function guardSightLine(
  topY: number, P: GunProfile, what: string,
  /** Present only for a part the sight line runs THROUGH. Metres, gun space. */
  straddle?: { boreLo: number; boreHi: number; z: number; frontZ: number },
): void {
  if (!import.meta.env?.DEV) return;
  const line = P.sight.lineY;
  if (straddle) {
    if (line <= straddle.boreLo || line >= straddle.boreHi) {
      console.warn(
        `[weapons/viewmodel] ${P.id}: "${what}" bore spans ${straddle.boreLo.toFixed(4)}…` +
        `${straddle.boreHi.toFixed(4)} m, which does not contain sight.lineY ${line}. The eye is ` +
        'on the line, so the player would be sighting on solid metal instead of through the hole.',
      );
    }
    if (straddle.z <= straddle.frontZ) {
      console.warn(
        `[weapons/viewmodel] ${P.id}: "${what}" sits at z ${straddle.z.toFixed(4)} m, at or ` +
        `forward of the front element at ${straddle.frontZ.toFixed(4)} m. A window in front of ` +
        'what it frames is not a sight picture.',
      );
    }
    return;
  }
  const ceil = line - 0.010;
  if (topY > ceil) {
    console.warn(
      `[weapons/viewmodel] ${P.id}: "${what}" tops out at ${topY.toFixed(4)} m, above the ` +
      `${ceil.toFixed(4)} m ceiling set by sight.lineY ${P.sight.lineY}. It will occlude the ` +
      'front post at ADS from below. Lower it or shorten it.',
    );
  }
}

/**
 * THE FOUR PROFILES — one file each, under `models/`.
 *
 * This is a PROJECTION of the registry and not a second source of truth. It exists because the
 * builder, `profileFor`, `assertClearance` and the showpiece door all take a `GunProfile` and
 * have no business knowing about palettes or skins; `Viewmodel.build()` walks `WEAPON_MODELS`
 * itself, where all three halves of a weapon travel together.
 *
 * Adding a weapon does not touch this line, or any other line in this file. See
 * `models/index.ts`.
 */
const PROFILES: readonly GunProfile[] = WEAPON_MODELS.map((m) => m.profile);

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
  //
  // Each of the two is REPLACED, not supplemented, when the profile opts into an aperture: an
  // `opticFront` post and a blade at the same z would be two solids doing one job, and an
  // `opticBlock` behind a surviving blade pair would be three rear sights. The part COUNT is
  // half of what was wrong with the shipped version — the player counted the solids.
  const frontZ = P.opticFront ? P.opticFront.z : SIGHT.frontZ;

  if (P.opticFront) {
    // The aperture's partner: a post whose TIP IS ON `lineY`, i.e. dead centre of the bore.
    const of = P.opticFront;
    const h = Math.max(SIGHT.lineY - of.footY, INK_FLOOR);
    const post = inkChunk(of.w, h, of.d, 0.002, 176, 'opticFront.post');
    place(post, { y: SIGHT.lineY - h * 0.5, z: of.z });
    sightParts.push(post);
  } else {
    const front = bevelBox(SIGHT.bladeW, SIGHT.frontH, SIGHT.bladeD, 0.002, 26);
    place(front, { y: SIGHT.lineY - SIGHT.frontH * 0.5, z: SIGHT.frontZ });
    sightParts.push(front);
  }

  if (P.opticBlock) {
    // ── THE BORED APERTURE: FOUR BARS AROUND A HOLE CENTRED ON THE SIGHT LINE ─────────────
    // Read `OpticBlockSpec` first. The one thing to know here: the bore is placed from
    // `SIGHT.lineY` and NOTHING is allowed to move it — every clamp below grows a wall
    // OUTWARD, away from the hole, because the hole is what `aimSocketOf()` points the eye
    // through. A part that clamped inward would silently re-aim the gun.
    const ob = P.opticBlock;
    const floor = Math.max(ob.wallMin, INK_FLOOR);
    const boreLo = SIGHT.lineY - ob.boreR;
    const boreHi = SIGHT.lineY + ob.boreR;

    // Walls AS AUTHORED — asymmetric on purpose, because `y` is free and burying the bottom
    // bar in the receiver is how this part stays small. Each is checked on its own.
    const rawTop = ob.y + ob.h * 0.5 - boreHi;
    const rawBot = boreLo - (ob.y - ob.h * 0.5);
    const rawSide = ob.w * 0.5 - ob.boreR;
    if (import.meta.env?.DEV) {
      if (ob.wallMin < INK_FLOOR - 1e-6) {
        console.warn(
          `[weapons/viewmodel] ${P.id}: opticBlock.wallMin ${(ob.wallMin * 1000).toFixed(1)} mm ` +
          `is under the ${(INK_FLOOR * 1000).toFixed(0)} mm ink floor. Raised. See WEAPON_ART §0.`,
        );
      }
      const thinnest = Math.min(rawTop, rawBot, rawSide);
      if (thinnest < floor - 1e-6) {
        const which = rawTop === thinnest ? 'top' : rawBot === thinnest ? 'bottom' : 'side';
        console.warn(
          `[weapons/viewmodel] ${P.id}: opticBlock's ${which} wall is ` +
          `${(thinnest * 1000).toFixed(1)} mm, under the ${(floor * 1000).toFixed(1)} mm floor — ` +
          'it would print as solid ink and the ring would read as a gap again. Grown outward, so ' +
          `the block is bigger than the w ${ob.w} / h ${ob.h} authored. Fix it here.`,
        );
      }
      if (ob.boreR * 2 < INK_FLOOR - 1e-6) {
        console.warn(
          `[weapons/viewmodel] ${P.id}: opticBlock.boreR ${ob.boreR} gives a ` +
          `${(ob.boreR * 2000).toFixed(1)} mm hole, thinner than the ink band — the VOID inks ` +
          'shut and the part becomes a solid block. The bore is the sight window; widen it.',
        );
      }
      if (Math.abs(ob.z - SIGHT.rearZ) > 0.001) {
        console.warn(
          `[weapons/viewmodel] ${P.id}: opticBlock.z ${ob.z} is not sight.rearZ ${SIGHT.rearZ}. ` +
          'The ADS solve measures the eye-to-window distance from rearZ, so the window would sit ' +
          'off the distance it was solved for. Set them equal.',
        );
      }
    }
    const wTop = Math.max(rawTop, floor);
    const wBot = Math.max(rawBot, floor);
    const wSide = Math.max(rawSide, floor);
    const spanW = ob.boreR * 2 + wSide * 2;

    // Top and bottom bars run the FULL width, so the four bars close at the corners and the
    // part is one continuous frame rather than four sticks with holes in the diagonals.
    const capTop = inkChunk(spanW, wTop, ob.d, 0.003, 171, 'opticBlock.top');
    place(capTop, { y: boreHi + wTop * 0.5, z: ob.z });
    sightParts.push(capTop);

    const capBot = inkChunk(spanW, wBot, ob.d, 0.003, 172, 'opticBlock.bottom');
    place(capBot, { y: boreLo - wBot * 0.5, z: ob.z });
    sightParts.push(capBot);

    for (const sx of [-1, 1]) {
      // Height is the bore's own height. If that is under the floor `inkChunk` grows it
      // symmetrically about the line, which only overlaps the caps — it cannot eat the hole.
      const jamb = inkChunk(wSide, ob.boreR * 2, ob.d, 0.003, 173 + sx, 'opticBlock.side');
      place(jamb, { x: sx * (ob.boreR + wSide * 0.5), y: SIGHT.lineY, z: ob.z });
      sightParts.push(jamb);
    }

    guardSightLine(boreHi + wTop, P, 'opticBlock', { boreLo, boreHi, z: ob.z, frontZ });
  } else {
    for (const sx of [-1, 1]) {
      const rear = bevelBox(SIGHT.bladeW, SIGHT.rearH, SIGHT.bladeD, 0.002, 27 + sx);
      place(rear, {
        x: sx * (SIGHT.notchHalfGap + SIGHT.bladeW * 0.5),
        y: SIGHT.lineY - SIGHT.rearH * 0.5,
        z: SIGHT.rearZ,
      });
      sightParts.push(rear);
    }
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
    // The window the wings must stay outside of is the NOTCH on an iron-sighted gun and the BORE
    // on an apertured one — same rule, different rear sight. Reading `notchHalfGap` here when the
    // profile has an `opticBlock` would be checking the wings against a sight that is not built.
    const windowHalf = P.opticBlock ? P.opticBlock.boreR : SIGHT.notchHalfGap;
    if (import.meta.env?.DEV && wg.gap < windowHalf * 1.5) {
      console.warn(
        `[weapons/viewmodel] ${P.id}: sightWings.gap ${wg.gap} is inside the rear sight's window ` +
        `at the front plane (~${(windowHalf * 1.5).toFixed(4)} m). The wings will eat the ` +
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
        // The front element's plane, whichever front element the profile built.
        z: frontZ,
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
 * AND THE HERO LENS IS DELIBERATELY ABSENT FROM THIS WHOLE FUNCTION.
 *
 * `WEAPON.view.heroScale` makes the weapon 2.6× bigger on screen and contributes exactly zero
 * to every number below, because it is a CLIP-SPACE magnification (see `HERO_LENS`): it scales
 * `gl_Position.xy` and never touches a vertex. If a future edit moves it back into the model or
 * camera matrix "because that is simpler", this table stops being true — the first attempt did
 * exactly that and took the reload pose to 0.636 m against a 0.40 m budget.
 */

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
        'Pull the pose in (less +x, less +z) or shrink MODEL_SCALE. Raising ' +
        'WEAPON.view.heroScale cannot cause this: the hero lens never moves a vertex.',
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
    `MOVE.radius ${MOVE.radius}, near ${V.nearClearance}, CAMERA.near ${CAMERA.near}; ` +
    `hero lens ×${V.heroScale} is clip-space and contributes nothing here)\n  ` +
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
  /**
   * Recoil kick — separate springs, deliberately softer and slower than the camera's, and the
   * only springs on this model whose FREQUENCY is not constant: `fire()` raises it to whatever
   * the weapon's own rate of fire needs. The constructor value is the floor.
   */
  private readonly kickPos = new SpringVec3(V.kickPosHz, V.kickPosDamping);
  private readonly kickRot = new SpringVec3(V.kickRotHz, V.kickRotDamping);
  /**
   * The viewmodel's own monotonic clock, seconds, advanced by `update()` — and the timestamp of
   * the last shot on it. Their difference is the MEASURED shot interval that sizes the kick
   * spring. Measured rather than read off the def on purpose: it costs no plumbing through
   * `service.ts`, and it is automatically right for a fire-rate boon, `WEAPON.fireRateScale`, a
   * Pack-a-Punch variant and any weapon that does not exist yet.
   */
  private kickClock = 0;
  private lastShotAt = -1e9;
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
  private readonly prev = new Float64Array(7);
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
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * `viewSpaceKey: true`, ON EVERY MATERIAL BELOW, AND IT IS NOT A POLISH FLAG.
     *
     * The ink shader dots a WORLD normal against `INK_GLOBALS.uKeyDir`, a WORLD direction. For
     * a wall that is exactly right — the wall's shading is a property of the wall. For this
     * object it is exactly wrong: the root matrix is composed from the camera every frame, so
     * the gun's normals sweep through the key as the player turns, the 3-band cel terminator
     * flips from one band to the next, and the weapon changes colour for a reason the player
     * did not cause. The playtester: "they change colour depending on where i move very
     * wierd". They were reading a real geometric fact, not an artefact.
     *
     * So every material on the viewmodel — the four field looks, the accent, the glove, the
     * trim, the sights and the muzzle core — takes `VIEW_SPACE_INK.uKeyDir` instead: one fixed
     * CAMERA-space direction, rotated into world once per frame by `updateViewSpaceInk()` in
     * `compose()`. Same rig every FPS uses, and it costs one vector transform per frame because
     * all of them share the one uniform object.
     *
     * NOTHING IN THE WORLD MAY SET THIS. A wall lit from the camera is a wall whose lighting
     * follows the player around, which is the same bug seen from the other side.
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
      rimColor: VIEW_RIM,
      rimStrength: 0.26,
      halftoneAngle: 75,
      toneFloor: 0.22,
      specular: 0.5,
      gleam: 0.55,
      gleamSize: 0.3,
      // The gun is 30 cm from the eye and `FOG_NEAR` is tens of metres away; participating in
      // distance fog can only ever be a rounding error, so it is switched off outright.
      fog: 0,
      viewSpaceKey: true,
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
      rimColor: VIEW_RIM,
      rimStrength: 0.30,
      halftoneAngle: 60,
      toneFloor: 0.30,
      specular: 0.10,
      gleam: 0.08,
      gleamSize: 0.45,
      fog: 0,
      viewSpaceKey: true,
    };
    const STEEL_LOOK: FieldLook = {
      shadowColor: PALETTE.TEAL,
      rimColor: VIEW_RIM,
      rimStrength: 0.28,
      halftoneAngle: 0,
      toneFloor: 0.24,
      specular: 0.85,
      gleam: 0.75,
      gleamSize: 0.20,
      fog: 0,
      viewSpaceKey: true,
    };
    /** The ONE warm mark on the weapon, and it lives on the silhouette. Never GOLD: GOLD means
     *  "you can interact with this" (ART §6) and the gun is not a pickup. */
    const accentMat = heroInk({
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
      viewSpaceKey: true,
    });
    /** The glove. Cool and a value step below the frame, so the hand reads as a separate
     *  object behind the gun rather than as more gun. */
    /**
     * THE GLOVE RECEDES. It was `hexMix(TEAL, INK_SOFT, 0.38)` — a saturated blue-teal at luma
     * 0.34, and it is the single largest, nearest object in the frame on EVERY weapon.
     *
     * The playtester, after shape, surface and per-gun palettes had all landed and the guns still
     * read alike: "they all have the same blue in the back (the part the player sees)". Measured,
     * and they had found the thing every one of my own measurements missed — I had been excluding
     * `vm-hand` from every comparison BECAUSE it is shared by design (same player, same hand), so
     * I never once looked at the biggest object on screen. It carries 417 vertices in the near
     * half of all four guns, and on the boomstick — which has no stock — it is the LARGEST rear
     * mass there is, beating the grip's 297. Four different guns, one loud blue hand in front of
     * every one of them.
     *
     * The hand must stay shared: the player does not change gloves when they change weapon. So
     * the fix is not to colour it per gun, it is to stop it COMPETING. Dark, desaturated, low —
     * it should read as "a hand in shadow holding the thing", and let each weapon's own palette
     * be the colour your eye lands on. Roughly halves its luma and drops most of its chroma.
     *
     * Keeping it above the ink floor matters as much as darkening it: too dark and a 7 px hull
     * closes the fingers into one black mitten, which is the failure this file has hit before.
     */
    const gloveMat = heroInk({
      name: 'Ink:viewmodel-glove',
      color: hexMix(PALETTE.INK, PALETTE.CONCRETE, 0.36),
      shadowColor: PALETTE.INK_SOFT,
      rimColor: VIEW_RIM,
      rimStrength: 0.22,
      halftoneAngle: 30,
      toneFloor: 0.26,
      specular: 0.28,
      gleam: 0.22,
      gleamSize: 0.34,
      fog: 0,
      viewSpaceKey: true,
    });
    const trimMat = heroInk({
      name: 'Ink:viewmodel-trim',
      color: PALETTE.BONE,
      shadowColor: PALETTE.TEAL,
      rimColor: VIEW_RIM,
      rimStrength: 0.24,
      halftoneAngle: 45,
      toneFloor: 0.2,
      specular: 0.62,
      gleam: 0.7,
      gleamSize: 0.26,
      fog: 0,
      viewSpaceKey: true,
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
    const sightMat = heroInk({
      name: 'Ink:viewmodel-sights',
      /**
       * DARK IRON, NOT BONE. This was `PALETTE.BONE` (0.73) — the brightest value anywhere on the
       * weapon — worn by three separate blades standing proud of the top edge. The playtester has
       * now named it three times, most recently "the longshot has 3 grey thing on top looks bad,
       * same with inkslinger". They were three pale bars because they were literally three pale
       * bars.
       *
       * Real iron sights are BLACK, and they work: a dark post reads against the world you are
       * aiming at, not against the gun. That is the correct contrast direction and it also solves
       * the complaint, so the post is now dark iron with a slightly cooler shadow.
       *
       * `toneFloor` stays high for the reason the original note gives — a post that falls into
       * shadow when you aim into shadow disappears exactly when you need it — so the blades keep
       * their own internal light even though they are dark.
       */
      color: hexMix(PALETTE.INK, PALETTE.CONCRETE, 0.30),
      shadowColor: hexMix(PALETTE.INK, PALETTE.TEAL, 0.22),
      rimColor: VIEW_RIM,
      rimStrength: 0.18,
      halftoneAngle: 45,
      toneFloor: 0.55,
      specular: 0.12,
      gleam: 0.1,
      gleamSize: 0.3,
      fog: 0,
      viewSpaceKey: true,
    });
    const coreMat = heroInk({
      name: 'Ink:viewmodel-core',
      color: PALETTE.GOLD,
      shadowColor: PALETTE.RUST,
      emissive: PALETTE.GOLD,
      emissiveIntensity: 1.1,
      bloom: true,
      halftone: 0,
      fog: 0,
      viewSpaceKey: true,
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
      rimColor: VIEW_RIM,
      rimStrength: 0.26,
      halftoneAngle: 60,
      toneFloor: 0.28,
      specular: 0.22,
      gleam: 0.18,
      gleamSize: 0.40,
      fog: 0,
      viewSpaceKey: true,
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
    const buildFieldMat = (id: string, key: MatKey): InkMaterial => {
      const f = fieldFor(id);
      switch (key) {
        case 'frame':
          return heroInk({
            ...FRAME_LOOK, name: `Ink:viewmodel-${id}`, color: f.frame,
          });
        case 'polymer':
          return heroInk({
            ...POLYMER_LOOK, name: `Ink:viewmodel-${id}-polymer`, color: f.polymer,
          });
        case 'steel':
          return heroInk({
            ...STEEL_LOOK, name: `Ink:viewmodel-${id}-steel`, color: f.steel,
          });
        case 'framePark':
          return heroInk({
            ...FRAME_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-frame-parkerised`,
            color: f.frame, map: makeParkerised({ base: f.frame, seed: 8 }).map,
          });
        case 'frameChip':
          return heroInk({
            ...FRAME_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-frame-chipped`,
            color: f.frame,
            map: makeChippedPaint({ base: f.frame, seed: 12, chips: 7, accent: true }).map,
          });
        case 'frameVent':
          return heroInk({
            ...FRAME_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-frame-vented`,
            color: f.frame,
            map: makeVentedSteel({ base: f.frame, seed: 4, slots: 3, axis: 'u', rivets: true }).map,
          });
        case 'polyTape':
          return heroInk({
            ...POLYMER_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-polymer-taped`,
            color: f.polymer,
            map: makeTapeWrap({ base: f.polymer, seed: 6, wraps: 4, slope: 2 }).map,
          });
        case 'polyKnurl':
          return heroInk({
            ...POLYMER_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-polymer-knurled`,
            color: f.polymer, map: makeKnurled({ base: f.polymer, seed: 5, cells: 5 }).map,
          });
        case 'polyPark':
          return heroInk({
            ...POLYMER_LOOK, ...WEAPON_SURFACE_MAP,
            name: `Ink:viewmodel-${id}-polymer-parkerised`, color: f.polymer,
            map: makeParkerised({ base: f.polymer, seed: 21, patches: 9, specks: 36 }).map,
          });
        case 'wood':
          return heroInk({
            ...WOOD_LOOK, ...WEAPON_SURFACE_MAP, name: `Ink:viewmodel-${id}-wood`,
            color: f.wood,
            map: makeWoodGrain({ base: f.wood, seed: 3, bands: 4, axis: 'u', knot: true }).map,
          });
        case 'steelKnurl':
          return heroInk({
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
      const sk = weaponModelFor(p.id).skin;
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
      // The ink hull is a second draw of the same silhouette and it must be magnified with it,
      // or the line detaches from the object it is drawing. Its own line WEIGHT is unaffected —
      // the hull inflates in VIEW space by a screen-pixel amount, and the lens runs after that,
      // so a 2.6× bigger gun still carries exactly a 7 px contour. That is most of why the
      // weapon stopped reading as ink: measured, its share of near-black pixels fell from
      // 57.6% to ~25% without the line getting one pixel thinner.
      attachHeroLens(hull.material as ShaderMaterial);
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
   *
   * ─── THE KICK SPRING IS RE-TUNED HERE, EVERY SHOT ───────────────────────────────────────
   * The gap since the previous shot sizes the spring (`kickHzFor`, and the derivation in
   * `WEAPON.view.kickSettleResidual`). Fire slower than the spring settles — every gun in the
   * arsenal except the ratatat — and `kickHzFor` returns the authored floor and this method is
   * the method it always was, to the bit.
   *
   * THE IMPULSE IS NOT SCALED, AND THAT IS THE WHOLE TRICK, so do not "fix" the `V.kickPosHz`
   * below to match the frequency the spring is actually running at. `impulseFor` sizes a
   * velocity to make a spring AT THE FLOOR peak at the authored displacement; drop that same
   * velocity into a spring stiffened by 1/c and it peaks at `c ×` the authored displacement
   * instead, and gets home `c ×` sooner. One number, both halves of the feel:
   *
   *     ratatat, 66.7 ms shots   rot 5.8 → 11.9 Hz, pitch peak 6.65° → 3.24° per shot
   *                              pos 6.5 → 10.8 Hz, push-back 38 mm → 23 mm per shot
   *
   * It is also the physically honest version: a cartridge delivers the same momentum however
   * fast you pull the trigger, and it is the MOUNT that has to be stiffer to eat fifteen of
   * them a second. And because the excursion only ever shrinks, the authored `kickBack` /
   * `kickPitchDeg` stay a true upper bound — the clearance pose table above still holds.
   */
  fire(kickScale: number, patternYaw: number, adsAmount: number): void {
    const gap = this.kickClock - this.lastShotAt;
    this.lastShotAt = this.kickClock;

    const s = kickScale * lerp(1, V.kickAdsMult, clamp01(adsAmount));
    if (s <= 0) return;

    const yawSign = patternYaw === 0 ? 0 : Math.sign(patternYaw);

    // Re-tuning a spring mid-flight is safe: `SpringVec3` re-derives its matrix every step, and
    // position and velocity are continuous across the change — only the acceleration steps.
    this.kickPos.frequency = kickHzFor(V.kickPosHz, V.kickPosDamping, gap);
    this.kickRot.frequency = kickHzFor(V.kickRotHz, V.kickRotDamping, gap);

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
    this.resetKick();
    this.swayPos.reset();
    this.swayRot.reset();
  }

  /**
   * Kick springs back to rest AND back to the authored floor frequency. A swap must forget the
   * outgoing gun's rate of fire, or the first shot out of an SMG-into-shotgun swap would land on
   * the SMG's stiff spring.
   */
  private resetKick(): void {
    this.kickPos.reset();
    this.kickRot.reset();
    this.kickPos.frequency = V.kickPosHz;
    this.kickRot.frequency = V.kickRotHz;
    this.lastShotAt = -1e9;
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
    this.resetKick();
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

    // The clock `fire()` measures its shot interval against. Advanced BEFORE anything else, and
    // read by `fire()` on the following frame's step 3 — `service.update()` runs the trigger and
    // this method on the same frame at the same wall clock, so the gap it reads is exactly the
    // accumulated frame time between two shots, with no extra frame of lag either way.
    this.kickClock += dt;

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
    // The net. Nothing in the arsenal reaches it (the boomstick, the heaviest gun we have, peaks
    // at 0.149 m / 29.7° against a 0.20 m / 40° ceiling) — it is here so no future combination of
    // rate, `weaponKick` and boons can walk the model off the screen. See `WEAPON.view.kickPosMax`.
    clampSpringVec(this.kickPos, V.kickPosMax);
    clampSpringVec(this.kickRot, V.kickRotMaxDeg * DEG2RAD);
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

    // ── 0. the view-space key ─────────────────────────────────────────────────────────────
    //
    // ONE vector transform, for the whole weapon: every material on this object shares the
    // single `VIEW_SPACE_INK.uKeyDir` uniform object, so rewriting it here relights all of
    // them at once. It belongs in `compose` and nowhere else — this is the one place per frame
    // where the camera's world matrix is already in hand and already up to date, and the key
    // must be rotated with the SAME matrix the model is about to be composed from or the light
    // lags the gun by a frame. No allocation: `transformDirection` works in place.
    //
    // It does not touch `INK_GLOBALS.uKeyDir`, so the arena, the enemies and the sky are lit
    // exactly as they were.
    //
    // THE LAMP ITSELF LIVES IN `WEAPON.view.keyDir`, not in `render/materials`. The materials
    // module owns the RIG — one shared uniform, one transform a frame, the guarantee that no
    // world surface may opt in — and the object being lit owns where the lamp stands, because
    // that is art direction and it is tuned against this specific gun in this specific corner
    // of the frame. Reading it here per frame also means it is live-tunable from the console
    // (`CZ.tuning.WEAPON.view.keyDir`) for the cost of one normalise.
    const kd = V.keyDir;
    _key.set(kd[0], kd[1], kd[2]).normalize().transformDirection(camera.matrixWorld);
    VIEW_SPACE_INK.uKeyDir.value.copy(_key);

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

    // ── 10. THE HERO LENS ─────────────────────────────────────────────────────────────────
    //
    // The last thing written, and it is written to a UNIFORM, not to the matrix above: it is a
    // clip-space magnification of the gun's image about a fixed screen point, so no vertex
    // moves and `assertClearance`'s whole table is untouched by it. See `HERO_LENS` for why
    // that distinction is the difference between shipping this and shipping a hand that goes
    // through walls, and `WEAPON.view.heroScale` for the composition it buys.
    //
    // IT BLENDS OUT AT ADS. At `a = 1` the magnification is exactly 1 and the centre term is
    // exactly 0, so the solved sight picture reaches the screen untouched — the aim socket is
    // on the camera axis and the lens is not allowed to move it off. Any magnification at ADS
    // would displace the sights off the axis the bullet is traced along, and no translation
    // could bring both blades back (a line parallel to the view axis maps to a slanted line),
    // which is the same class of bug as BUILD 004's "you aim like inside the pistol".
    //
    // The centre is stated in the tuning file in screen `x/-z` units, so it is FOV-independent
    // and has to be re-projected each frame — the ADS zoom changes `projectionMatrix` under it.
    const heroK = 1 + (V.heroScale - 1) * (1 - a);
    const pm = camera.projectionMatrix.elements;
    HERO_LENS.uHeroLens.value.set(
      heroK, V.heroCentreX * (pm[0] ?? 1), V.heroCentreY * (pm[5] ?? 1),
    );

    // ── §4.1 stillness telemetry ──────────────────────────────────────────────────────────
    // Compare the composed transform against the previous frame's, exactly. If it is identical,
    // this object's contribution to the frame is identical too — so with a parked camera the
    // gun's pixels are bit-static. Checking the OUTPUT rather than each layer means a future
    // layer that forgets to settle cannot slip past this readout.
    const p = this.prev;
    this.frozen = this.hasPrev
      && p[0] === px && p[1] === py && p[2] === pz
      && p[3] === pitch && p[4] === yaw && p[5] === roll
      // The lens is the seventh channel of the composed transform. It is a pure function of
      // `adsPose`, which the other six already depend on — but "already implied" is exactly the
      // reasoning that let three animation layers slip past the previous version of this check.
      && p[6] === heroK
      && (!this.slideMesh || this.slideMesh.position.z === 0)
      && (!this.magMesh || this.magMesh.position.y === 0);
    p[0] = px; p[1] = py; p[2] = pz;
    p[3] = pitch; p[4] = yaw; p[5] = roll; p[6] = heroK;
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

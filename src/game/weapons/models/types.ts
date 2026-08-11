/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE WEAPON CONTRACT — everything a gun file is allowed to say, and nothing about how it is
 * built.
 *
 * `viewmodel.ts` owns the RUNTIME: the builder, the part primitives, the material factory, the
 * pose stack, `assertClearance` and the aim solve. This module owns the SHAPE OF THE DATA those
 * things consume, and `models/<gun>.ts` owns one gun's worth of that data.
 *
 * The split exists so that adding a fifth weapon is adding ONE FILE plus one line in
 * `models/index.ts` — no edit to the builder, no edit to the runtime, and nothing to keep in sync
 * by hand across the three parallel tables (`PROFILES` / `FIELDS` / `SKINS`) a gun used to be
 * spread over.
 *
 * It also has to be a module of its own rather than a section of `viewmodel.ts`, because a gun
 * file importing its types from the runtime that imports the gun files is a cycle — and one whose
 * shared constants (`FIELD` below) are read at module-init time, i.e. the kind that dies in the
 * temporal dead zone rather than the kind a bundler quietly forgives. Types here, data in the gun
 * files, runtime above: a DAG, in that order.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */

import { PALETTE, hexMix } from '@/art/palette';
import { WEAPON_FIELD } from '@/art/surfaces';

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
export interface SightSpec {
  lineY: number;
  rearZ: number;
  frontZ: number;
  bladeW: number;
  rearH: number;
  frontH: number;
  bladeD: number;
  /**
   * Half the gap between the rear blades. **IGNORED when `opticBlock` is set** — an aperture has
   * no notch, and the window the sight picture is measured against becomes `opticBlock.boreR`
   * (which is what `sightWings`' light-bar warning then compares itself to).
   */
  notchHalfGap: number;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE BORED APERTURE — one machined part with a hole through it, and the arithmetic that makes
 * it possible at all.
 *
 * FIVE PASSES AT THE REAR SIGHT WERE REJECTED, and the fifth failed in a way worth writing down
 * because this interface is the whole answer to it. `SightSpec` can express exactly three boxes
 * — one at x 0 and a mirrored pair — with ALL THREE of their top faces pinned to `lineY` by the
 * builder. Authored bold enough to survive the ink, that pair reads as what it literally is: two
 * wall blocks with a 22 mm gap and NOTHING BRIDGING THE TOP. The verdict was "the 3 sights look
 * bad like too huge", and the count is the tell — the player was counting solids, and there were
 * three of them, because there is no hole anywhere on the gun, only a gap between things.
 *
 * A bridge over that gap is not expressible in `SightSpec` and would be wrong if it were: every
 * blade top is pinned to `lineY`, and `lineY` is ALSO where `aimSocketOf()` puts the eye, so a
 * bridge at `lineY` is a roof the player sights along instead of a ring they sight through.
 *
 * SO THE BORE IS CENTRED ON `sight.lineY`, NOT ON A FACE. That one sentence is the entire reason
 * this spec exists and it is the thing `SightSpec` structurally cannot say. Material above the
 * hole AND below it is what makes a part read as machined rather than as assembled.
 *
 * ─── IT IS FOUR BARS, AND THAT IS NOT A SHORTCUT ────────────────────────────────────────────
 * The builder emits top / bottom / left / right bars around a SQUARE bore rather than a torus or
 * a cylinder with a hole punched in it. WEAPON_ART §0: the inverted hull inflates every
 * silhouette by a screen-space amount, so a thin round wall has no albedo between its two
 * inflated faces and prints as a solid black doughnut — the exact failure that erased the trigger
 * guard. Four chunky bars survive the line. A square aperture is fine in a comic; a black blob is
 * not.
 *
 * ─── THE ARITHMETIC, BECAUSE IT DECIDES HOW BIG THIS PART CAN BE ────────────────────────────
 * Proud height above the receiver's top face is FORCED, not chosen:
 *
 *     proud = (lineY − receiverTop) + boreR + topWall
 *
 * `lineY − receiverTop` cannot go under ~0.010 (anything on the top face nearer the eye than the
 * front post occludes it — see `guardSightLine`), and `topWall` cannot go under `INK_FLOOR`. So
 * the smallest legal bored ring stands about `0.020 + boreR` above the receiver, and `boreR` is
 * itself pinned from below by the sight picture: the bore is the window, `V.adsSightDistance`
 * from the eye, and a bore that is not meaningfully wider than the front post at the front plane
 * leaves no light either side of it to aim with.
 *
 * WHERE THE SIZE IS ACTUALLY BOUGHT IS `d`, AND IT IS BOUGHT CHEAPLY. Depth is the axis the
 * complaint named ("30 mm fore-and-aft") and the only one nothing else depends on — a ring wants
 * to be a ring, not a tunnel. It is also the one axis `depthCompress` shrinks again on the way
 * out of the builder (0.50 on the marksman), so an authored 0.024 draws as 12 mm.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface OpticBlockSpec {
  /** Outer width and height of the block, metres. The walls are what is left around the bore. */
  w: number;
  h: number;
  /** Depth along z, metres — authored, i.e. BEFORE `depthCompress`. Keep it shallow. */
  d: number;
  /**
   * Block centre in gun space, metres. `y` is the BLOCK's centre and has no reason to equal
   * `lineY`: the bore is centred on the sight line whatever `y` says, so moving `y` down buries
   * the bottom bar in the receiver (free — it is invisible) instead of standing it proud.
   * The walls are therefore asymmetric by design, and each is checked separately.
   *
   * `z` should EQUAL `sight.rearZ`: that is where the ADS solve believes the window is, and the
   * builder dev-warns when the two disagree by more than a millimetre.
   */
  y: number;
  z: number;
  /**
   * Half-size of the SQUARE bore, metres — the hole spans `lineY ± boreR` in y and `± boreR` in
   * x. This is the sight window: it is what the front element is framed in, so it is a sight
   * picture number first and a styling number second. Under `INK_FLOOR / 2` the void itself is
   * thinner than the ink band and the hole inks shut; the builder says so.
   */
  boreR: number;
  /**
   * The author's own minimum wall thickness, metres — an assertion, not a size. The builder
   * takes `max(wallMin, INK_FLOOR)` as the floor, warns when a computed wall lands under it, and
   * then GROWS THAT WALL OUTWARD rather than inward, because the bore is what the aim solve
   * reads and it is never allowed to move.
   */
  wallMin: number;
}

/**
 * The small front element that pairs with a bored aperture: a post whose TIP LANDS EXACTLY ON
 * `sight.lineY`, i.e. dead centre of the bore. That is the whole aperture picture — tip in the
 * middle of the ring, light all around it — and it is why this replaces the default front blade
 * (whose top is pinned to `lineY` for the same reason, but which is sized for a notch).
 *
 * KEEP IT TINY. It is the second of the two solids left on the gun and the ring is the one doing
 * the talking.
 */
export interface OpticFrontSpec {
  /** Post width across the gun and depth along it, metres. Both floored at `INK_FLOOR`. */
  w: number;
  d: number;
  /** Centre along z, metres. `sight.rearZ − z` is the sight radius. */
  z: number;
  /** Y of the surface the post stands on; its height is `sight.lineY − footY`. */
  footY: number;
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
export interface EjectionPortSpec {
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
export interface ChargingHandleSpec {
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
export interface SelectorSpec {
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
export interface MagWellSpec {
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
export interface SightWingsSpec {
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
export interface PanelsSpec {
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
export interface RailTeethSpec {
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

export interface GunProfile {
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
  /**
   * A REAL BORED APERTURE, replacing the rear blade pair entirely — one part with a hole through
   * it instead of two walls with a gap between them. When this is set the builder emits no rear
   * blades at all, so the gun goes from three solids to two. See `OpticBlockSpec`.
   */
  opticBlock?: OpticBlockSpec | null;
  /** The tiny post that pairs with it, replacing the default front blade. See `OpticFrontSpec`. */
  opticFront?: OpticFrontSpec | null;
  /** 2–3 bold stamped cuts. Polymer, static. */
  panels?: PanelsSpec | null;
  /** Chunky top-rail teeth. Steel, rides the slide. */
  railTeeth?: RailTeethSpec | null;
}

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
export const FIELD = {
  frame: hexMix(PALETTE.SLATE, PALETTE.BONE, 0.30),
  polymer: hexMix(PALETTE.SLATE, PALETTE.INK_SOFT, 0.28),
  steel: hexMix(PALETTE.SLATE, PALETTE.PAPER, 0.42),
  /** From `art/surfaces` — walnut, dropped toward INK so it lands at the frame's value. */
  wood: WEAPON_FIELD.wood,
} as const;

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
export type FieldSet = { frame: number; polymer: number; steel: number; wood: number };

export type MatKey =
  | 'frame' | 'polymer' | 'steel'
  | 'framePark' | 'frameChip' | 'frameVent'
  | 'polyTape' | 'polyKnurl' | 'polyPark' | 'wood' | 'steelKnurl';

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
export interface Skin { readonly mat: MatKey; readonly uv: number }
export const plainFrame: Skin = { mat: 'frame', uv: 0 };
export const plainPolymer: Skin = { mat: 'polymer', uv: 0 };
export const plainSteel: Skin = { mat: 'steel', uv: 0 };

/** Which surface every mesh group of a weapon wears. Five groups, five answers, no gaps. */
export interface WeaponSkin {
  readonly frame: Skin; readonly slide: Skin; readonly polymer: Skin;
  readonly steel: Skin; readonly magazine: Skin;
}
/**
 * The flat, unpatterned dressing — every group in its field's plain colour and no maps at all.
 *
 * It is the STARTING POINT for a new weapon file (`{ ...DEFAULT_SKIN, polymer: { mat: 'wood',
 * uv: 14 } }`), not a fallback the runtime reaches for: `WeaponModelDef.skin` is required, so a
 * gun cannot ship without saying what it is made of. The old `SKINS[id] ?? DEFAULT_SKIN` lookup
 * is exactly the silent hole that let a gun wear another gun's finish and look identical to it.
 */
export const DEFAULT_SKIN: WeaponSkin = {
  frame: plainFrame, slide: plainFrame, polymer: plainPolymer,
  steel: plainSteel, magazine: plainSteel,
};

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * ONE WEAPON, ONE OBJECT, ONE FILE.
 *
 * A gun used to be three entries in three tables in two different scopes — its `GunProfile` near
 * the top of `viewmodel.ts`, its palette 300 lines further down, and its skin buried inside
 * `Viewmodel.build()`. Nothing kept them together and nothing complained when one of them was
 * missing: `fieldFor()` and the `SKINS` lookup both fall back silently, so a gun could ship with
 * the wrong palette and the only symptom would be that it looked like another gun. Which is, in
 * fact, the bug the palette block above exists to record.
 *
 * So the three travel together now. `models/<id>.ts` exports exactly one of these, the registry
 * lists it, and the runtime reads all three off the same object.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface WeaponModelDef {
  /** Proportions, sight line, `restDz`, `depthCompress` and every optional part. */
  readonly profile: GunProfile;
  /** The four flat colour fields this weapon's materials wear. */
  readonly fields: FieldSet;
  /** Which surface each mesh group wears, and at what tile density. */
  readonly skin: WeaponSkin;
}

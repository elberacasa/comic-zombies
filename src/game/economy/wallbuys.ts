/**
 * WALL-BUYS — the first real sink in the economy, and the thing that finally makes the three
 * BUILD 009 weapons obtainable in normal play (BO2_MECHANICS §2, GAME_BIBLE §5).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT A WALL-BUY IS, AND WHY IT IS NOT A VENDING MACHINE
 *
 *  BO2's chalk wall is two purchases wearing one prop:
 *
 *    · you do not own the gun  →  it sells the GUN at `WeaponDef.buyCost`
 *    · you already own it      →  it sells AMMO at `WeaponDef.ammoCost`, forever
 *
 *  The second half is the one that matters. A weapon you can re-ammo at a known place turns a
 *  wall into a SUPPLY LINE, and a supply line is a route — you train the horde in a loop that
 *  passes your wall, and that decision is the strategy layer §2 is asking for. So the ammo path
 *  is the FAST path here: same key, same press, no menu, no confirmation, no mode toggle. The
 *  system works out which of the two you meant from what is in your hands.
 *
 *  Prices are NEVER invented here. They come off `WeaponDef.buyCost` / `.ammoCost`, which have
 *  carried the numbers since M2 and were unused until now (ratatat 1200/600 · boomstick 1500/750
 *  · longshot 2000/900). A price in this file would be a second source of truth for a number the
 *  weapon already owns.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  PLACEMENT IS FOUND, NEVER AUTHORED (GAME_BIBLE §9.1)
 *
 *  "A new map should require zero changes to `game/`." So there is not one coordinate in this
 *  file. `findWallSpots()` probes the live `WorldService` — ground height, a standing capsule
 *  test, headroom, eight horizontal whiskers hunting a vertical face, then a slide ALONG that
 *  face looking for a patch flat enough to draw on. The spread ("no single training loop passes
 *  all of them") is enforced as a minimum separation in metres plus a minimum angular separation
 *  about the arena's own centre, so a bigger map spreads them further with no edit here.
 *
 *  MEASURED on the shipped arena, headless through `tools/rig.ts`: five walls, every one of them
 *  dead flush against its wall (0.000 m corner deviation), 31.2 m apart at the closest pair
 *  against a 26 m bar, 37–47 m from the player spawn, spanning x −43…+43 and z −20…+45 — i.e.
 *  all four quadrants. 34 ms of probing at boot, against the 190 ms the nav graph already spends
 *  in the same block.
 *
 *  The nav graph would be the better reachability oracle, and ARCHITECTURE §3 already names
 *  "a wall-buy that must be reachable" as the trigger to promote `nav` onto `WorldService`.
 *  `core/types.ts` is frozen and this agent does not own it, so the honest substitute is used
 *  instead: a candidate must sit at STREET LEVEL (within `WALL.maxRise` of the player spawn's
 *  own ground) with a clear standing capsule and open sky above it. That rules out rooftops,
 *  ledges and building interiors, which is what the reachability test was for. When `nav` does
 *  land on `WorldService`, add a `probeRoute` gate to `probeWall` and delete this note.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE VISUAL: CHALK, AND IT IS FREE (BO2_MECHANICS §2, ART §1)
 *
 *  "The chalk is free for us" — a crude chalked weapon silhouette IS the art direction. Each
 *  spot is ONE textured quad on the wall: a canvas-2D chalk drawing built once at boot, drawn
 *  with the same `roughPolygon` linework as every other surface in the game, then punched with
 *  ~700 erase dots so the strokes go patchy the way real chalk does on brick.
 *
 *  Two colours, and they are a contract, not a preference:
 *    · the gun and its name are PAPER — it is chalk, chalk is white,
 *    · the PRICE is GOLD, because `SEMANTIC.interactable` is GOLD and GOLD carries exactly one
 *      meaning in this game: "you can use this" (ART §6).
 *
 *  Affordability is legible from across the map: the quad's opacity drops to `chalkOpacityDim`
 *  when you cannot afford it and snaps back when you can. That is not decoration — it is what
 *  lets a player pick a training loop by looking at the walls rather than at the points badge.
 *
 *  COST: 5 quads, 3 canvas textures (one per weapon, shared across duplicate walls), no
 *  per-frame geometry work, nothing animated. Built once in `init`, exactly as ARCHITECTURE §4
 *  requires of static props.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  CanvasTexture, FrontSide, Group, LinearFilter, LinearMipmapLinearFilter, Mesh,
  MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3, type Texture,
} from 'three';

import type { GameCtx, System, WeaponDef, WeaponInstance, WorldService } from '@/core/types';
import { SEMANTIC, col, cssOf, rgb8, rgb8Hex } from '@/art/palette';
import { COMIC_FONT_STACK } from '@/art/letters';
import { makeCanvas, makeSeededRandom, roughPolygon, roughStroke } from '@/art/textures';
import { LAYER } from '@/render/materials/index';
import { MOVE } from '@/game/tuning';
import { OWNER_WALL, ownsSpot, publishDistance, resetInteractClaims, takeInteract } from './claim';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TUNABLES
//
// ARCHITECTURE §6 wants feel constants in `game/tuning.ts`, and these belong there — but this
// agent owns exactly one new file plus one registration line, and `tuning.ts` has another owner
// this milestone. They are gathered in one block, named, and carry their measurements, so the
// move is a cut-and-paste when the file is free. NOTHING below this block is a magic number.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const WALL = {
  // ── how many, and where ──────────────────────────────────────────────────────────────────
  /**
   * Target wall count. §2 asks for 4–6. Five is the number that fits the arena's shape: the
   * three sellable guns each get a wall plus two duplicate supply walls, so a training loop can
   * pass a re-ammo point without also passing every gun in the game.
   */
  spots: 5,
  /** Hard ceiling, so a future 8-weapon roster does not paper the map in chalk. */
  maxSpots: 6,

  /** Angular samples around the arena centre when hunting candidate walls. */
  angleSamples: 64,
  /** Radial samples per angle, spread across `radiusMin`…`radiusMax` of the arena half-extent. */
  radiusSamples: 8,
  /**
   * Radial band, as a fraction of the arena's half-extent. Inside 0.22 is the plaza (open, no
   * walls); outside 0.78 is the perimeter wall, where a chalk drawing faces a dead end nobody
   * trains through.
   */
  radiusMin: 0.22,
  radiusMax: 0.78,

  /** A wall-buy this close to the player spawn is a freebie, not a walk. Metres. */
  minSpawnDist: 14,
  /** Distance from spawn that scores best — far enough to be a decision, near enough to reach. */
  idealSpawnDist: 42,
  /**
   * Minimum separation between two walls, metres. THE spread constraint: 26 m is wider than any
   * kite loop the arena supports, so no single training circuit passes two of them.
   */
  minSeparation: 26,
  /** …and a minimum angular separation about the arena centre, so they ring the map. */
  minAngleSep: 0.85,
  /** Separation relaxation per retry when the arena cannot fit `spots` walls at full spacing. */
  relaxStep: 0.72,
  relaxTries: 3,

  // ── what makes a usable wall ─────────────────────────────────────────────────────────────
  /** How far the horizontal whiskers look for a face, metres. */
  probeReach: 9,
  /** Whisker count. 8 compass directions — the ray-cache ring in `collision.ts` is also 8. */
  probeDirs: 8,
  /**
   * Closest a whisker hit may be and still count as a wall. Under this the sample point is
   * already jammed against the face and its openness reading is meaningless.
   */
  minStandoff: 0.9,
  /**
   * Where the player is put in front of the face once one is found — arm's length plus a step.
   * The sample point that FOUND the wall is not where the wall-buy goes: the standing spot is
   * re-derived from the face itself and re-validated there. That is what makes the probe pass
   * productive (any sample within `probeReach` of a facade yields a candidate) instead of
   * needing a sample to land in the narrow band where a player would already be standing.
   */
  standoff: 1.5,
  /** |normal.y| above this is a floor or a ceiling, not a wall. cos 73°. */
  maxNormalY: 0.29,
  /**
   * How far either way along a found face we hunt for a flat patch, in steps of `slideStep`.
   * See `probeWall` — this is the difference between three wall-buys on one side of the map and
   * five spread around it. 8 × 0.55 m reaches 4.4 m either way, about two window bays.
   */
  slideSteps: 8,
  slideStep: 0.55,
  /**
   * How much deeper than the whisker's own hit a slide position's local face may be, metres.
   * 2.5 covers any window reveal, doorway recess or bay on these facades; past that the "wall"
   * is really the far side of an alley and the drawing would be nowhere near the player.
   */
  slideDepth: 2.5,
  /**
   * Height above the standing ground the chalk is centred at, metres — and it is MEASURED, not
   * chosen. Every facade in this arena carries a ground-floor plinth that steps back 0.35 m at
   * y ≈ 1.7 (depth profile, `tools/rig.ts`: dead flat 1.54 m out from y 0.60 to 1.60, then 1.89 m
   * from y 1.85 up, at every spot sampled). A drawing centred at chest height therefore had its
   * top corners hanging 35 cm off the wall, and the flatness test — correctly — threw those
   * candidates away, which is what left the first pass with three walls all in one quadrant.
   *
   * 1.10 with `chalkHeight` 0.95 puts the whole quad between 0.63 and 1.58: inside the plinth
   * band with 12 cm to spare, flush on every wall in the arena. Waist-to-chest is also simply
   * where a person chalks on a wall.
   */
  chalkCenterY: 1.10,
  /**
   * Chalk quad size, metres. Roughly life-size for a long gun, which is what a chalked wall
   * weapon should be — and it is also the size the arena's facades can actually hold: see
   * `cornerRecess`, where the flat-patch count is a strong function of the quad's footprint.
   */
  chalkWidth: 1.25,
  chalkHeight: 0.95,
  /** How far off the wall the quad floats. 35 mm clears any facade relief without a visible gap. */
  chalkOffset: 0.035,
  /**
   * THE FLATNESS TEST, AND IT IS ASYMMETRIC ON PURPOSE.
   *
   * Every corner of the quad casts back at the face and must land near the same plane, or the
   * drawing hangs half over a doorway, sinks into a pilaster, or wraps a corner. But the two
   * ways it can miss are not equally bad:
   *
   *   · CLOSER than the plane = the wall bulges INTO the drawing. The quad would be buried in
   *     geometry, which is a visible bug at any depth. Tight: 9 cm, about the depth of a rough
   *     stone course.
   *   · FURTHER than the plane = a shallow reveal behind part of the drawing. The chalk floats
   *     a little there, which at 1.5 m and a grazing view angle reads as a wall with relief on
   *     it, not as a floating decal. Generous: 26 cm.
   *
   * The 26 cm recess figure is the arena's own architecture: the plinth step documented on
   * `chalkCenterY` is 0.35 m, so 0.4 admits a patch that straddles it and anything tighter
   * rejects one. With `chalkCenterY` tuned to keep the quad below the step, no SHIPPED wall
   * needs that slack — all five come out at 0.000 m deviation (MEASURED) — but leaving it means
   * an arena whose walls are not this clean still gets five wall-buys instead of three, and
   * `wFlat` guarantees the flush patches are the ones actually chosen.
   */
  cornerProtrude: 0.09,
  cornerRecess: 0.4,
  /** Minimum clear height above the standing spot. Below this we are indoors, not on a street. */
  minHeadroom: 3,
  /** How far above/below the player spawn's ground still counts as "street level", metres. */
  maxRise: 1.8,
  /** Capsule penetration that means the standing spot is occupied, metres. */
  standClearance: 0.06,

  // ── scoring weights ──────────────────────────────────────────────────────────────────────
  wOpen: 1,
  wStandoff: 0.8,
  wSpawnDist: 0.5,
  /** Prefer the flat patch nearest where the sample actually hit the face. */
  wSlide: 0.35,
  /** Prefer a wall the drawing sits flush against. The heaviest term — it is the LOOK. */
  wFlat: 1.2,

  // ── the interaction ──────────────────────────────────────────────────────────────────────
  /**
   * Prompt radius about the standing spot, metres — 3D, so a player on a balcony directly above
   * a wall-buy does not get its prompt. 3.2 is one comfortable step's tolerance either side of
   * `idealStandoff`; wider and two adjacent props start fighting over the prompt line.
   */
  useRadius: 3.2,

  // ── presentation ─────────────────────────────────────────────────────────────────────────
  /** Chalk opacity when you can afford what is on the wall. */
  chalkOpacity: 0.92,
  /** …and when you cannot. Still legible — it tells you the wall exists and is out of reach. */
  chalkOpacityDim: 0.4,
  /** Purchase strobe length, seconds. */
  flashTime: 0.42,
  /** Strobe rate, Hz. A comic flashes; it does not dissolve (ART §8). */
  flashHz: 12,
  /** Word-pop scale for the purchase beat. */
  wordScale: 1.05,

  // ── the chalk canvas ─────────────────────────────────────────────────────────────────────
  /** Canvas width. Height follows `chalkHeight / chalkWidth` so texels stay square. */
  texWidth: 512,
  /** Chalk stroke width in canvas px at 512 wide. */
  strokeWidth: 6.5,
  /** Erase-dot count — what turns a clean stroke into chalk on brick. */
  dustDots: 700,
} as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CHALK DRAWING — silhouettes as normalized part outlines, one set per archetype.
//
// Crude on purpose: §2 says "the chalk drawing is deliberately crude and readable from across
// the map", and a crude chalked outline is the cheapest asset in the game AND the most on-style.
// Each entry is a closed polygon in [0,1]² over the drawing band, muzzle to the RIGHT.
//
// The parts are the archetype's IDENTITY, not decoration: the SMG has a stick mag and a folding
// stock, the shotgun has a pump and a tube under the barrel, the marksman has a scope on two
// mounts and the longest barrel. That is what makes three chalk drawings tellable apart at 30 m,
// which is the whole job.
// ═════════════════════════════════════════════════════════════════════════════════════════════

type Archetype = WeaponDef['archetype'];

const GUN_PARTS: Record<Archetype, readonly (readonly number[])[]> = {
  pistol: [
    [0.36, 0.40, 0.94, 0.40, 0.94, 0.53, 0.36, 0.53],   // slide
    [0.38, 0.53, 0.56, 0.53, 0.50, 0.88, 0.30, 0.88],   // grip
    [0.56, 0.53, 0.72, 0.53, 0.72, 0.64, 0.56, 0.64],   // trigger guard
  ],
  smg: [
    [0.05, 0.42, 0.26, 0.42, 0.26, 0.54, 0.05, 0.54],   // folding stock
    [0.26, 0.35, 0.66, 0.35, 0.66, 0.56, 0.26, 0.56],   // receiver
    [0.66, 0.42, 0.93, 0.42, 0.93, 0.50, 0.66, 0.50],   // barrel
    [0.44, 0.56, 0.57, 0.56, 0.61, 0.90, 0.48, 0.90],   // the stick mag — the SMG's tell
    [0.27, 0.56, 0.42, 0.56, 0.40, 0.82, 0.25, 0.82],   // grip
  ],
  shotgun: [
    [0.03, 0.40, 0.28, 0.45, 0.28, 0.63, 0.03, 0.61],   // shoulder stock
    [0.28, 0.39, 0.58, 0.39, 0.58, 0.58, 0.28, 0.58],   // receiver
    [0.58, 0.40, 0.97, 0.40, 0.97, 0.50, 0.58, 0.50],   // barrel
    [0.58, 0.52, 0.92, 0.52, 0.92, 0.59, 0.58, 0.59],   // magazine tube
    [0.66, 0.57, 0.82, 0.57, 0.82, 0.68, 0.66, 0.68],   // the pump — the shotgun's tell
    [0.31, 0.58, 0.43, 0.58, 0.41, 0.78, 0.29, 0.78],   // grip
  ],
  marksman: [
    [0.02, 0.42, 0.26, 0.42, 0.26, 0.64, 0.02, 0.59],   // long stock with a cheek riser
    [0.26, 0.42, 0.62, 0.42, 0.62, 0.56, 0.26, 0.56],   // receiver
    [0.62, 0.44, 0.99, 0.44, 0.99, 0.50, 0.62, 0.50],   // the longest barrel in the game
    [0.34, 0.26, 0.64, 0.26, 0.64, 0.37, 0.34, 0.37],   // the scope — the marksman's tell
    [0.39, 0.37, 0.43, 0.37, 0.43, 0.42, 0.39, 0.42],   // front mount
    [0.56, 0.37, 0.60, 0.37, 0.60, 0.42, 0.56, 0.42],   // rear mount
    [0.45, 0.56, 0.57, 0.56, 0.57, 0.71, 0.45, 0.71],   // box mag
    [0.28, 0.56, 0.41, 0.56, 0.39, 0.80, 0.26, 0.80],   // grip
  ],
  launcher: [
    [0.08, 0.36, 0.90, 0.36, 0.90, 0.55, 0.08, 0.55],   // tube
    [0.90, 0.31, 0.99, 0.28, 0.99, 0.63, 0.90, 0.60],   // flared muzzle
    [0.40, 0.28, 0.53, 0.28, 0.53, 0.36, 0.40, 0.36],   // sight
    [0.34, 0.55, 0.47, 0.55, 0.45, 0.80, 0.32, 0.80],   // grip
  ],
};

/** Where on the canvas the silhouette band lives, as fractions of the canvas. */
const ART_BAND = { x0: 0.06, x1: 0.94, y0: 0.14, y1: 0.68 } as const;
/** Baseline of the chalked name, and of the chalked price. */
const NAME_Y = 0.085;
const PRICE_Y = 0.845;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Scratch. Module level — nothing in the per-frame path allocates.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const _p = new Vector3();
const _dir = new Vector3();
const _n = new Vector3();
const _wall = new Vector3();
const _capA = new Vector3();
const _capB = new Vector3();
const _tan = new Vector3();
const _corner = new Vector3();
const _wordAt = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * ONE reused `ui:prompt` payload, on exactly the terms `weapons/service.ts` documents for its
 * own shared payloads: `Emitter.emit` is synchronous, so the object is dead the moment the emit
 * returns, and the HUD reads `p.text` out on entry. Nobody may retain it.
 */
const _promptPayload: { text: string | null } = { text: null };

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A single wall
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** What the player is being offered at a wall this frame. */
type WallMode = 'buy' | 'ammo' | 'full';

interface WallSpot {
  readonly def: WeaponDef;
  /** Where the player stands to use it — the prompt radius is measured from here. */
  readonly anchor: Vector3;
  /** The chalk quad. */
  readonly mesh: Mesh;
  readonly material: MeshBasicMaterial;
  /** Prompt lines, built once. See `buildPrompts` — the per-frame path must never format one. */
  readonly text: Record<WallMode | 'buyDenied' | 'ammoDenied' | 'buySwaps', string>;
  /** `spend()` reasons, built once for the same reason. */
  readonly buyReason: string;
  readonly ammoReason: string;
  /** Purchase strobe, seconds remaining. Presentation only. */
  flash: number;
  /** Last opacity state pushed to the material, so we only write on a change. */
  dimmed: boolean;
}

/**
 * A candidate wall face found by the probe pass, before scoring picks the winners.
 *
 * EXPORTED, and `findWallSpots` with it, so the placement pass is checkable headlessly against
 * the real arena and the real collision octree — the `tools/` rig already hands out a live
 * `WorldService`. Placement is the half of this feature a machine CAN verify (how many spots,
 * how far apart, at what height), and a wall-buy system that silently places zero walls would be
 * a shipped no-op nobody notices until a playtest.
 */
export interface Candidate {
  /** Standing spot, on the ground. */
  sx: number; sy: number; sz: number;
  /** Point on the wall the chalk centres on. */
  wx: number; wy: number; wz: number;
  /** Wall normal, pointing back at the player. */
  nx: number; nz: number;
  score: number;
  angle: number;
  spawnDist: number;
  /** Worst corner deviation from the wall plane, metres. 0 = dead flush. */
  flatness: number;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The system
// ═════════════════════════════════════════════════════════════════════════════════════════════

export class WallBuySystem implements System {
  readonly name = 'wallbuys';

  private root: Group | null = null;
  private geo: PlaneGeometry | null = null;
  private readonly spots: WallSpot[] = [];
  /** One chalk texture per weapon, shared by every wall that sells it. */
  private readonly textures = new Map<string, Texture>();

  /** Index of the wall we are standing at, or -1. */
  private near = -1;
  /** The exact string currently on screen because of US. Null means we are showing nothing. */
  private showing: string | null = null;
  /** Balance at the last affordability sweep — the sweep only runs when this moves. */
  private lastPoints = -1;

  // ── build ───────────────────────────────────────────────────────────────────────────────

  init(ctx: GameCtx): void {
    // Only weapons the defs actually price are sellable. The starter is explicitly excluded by
    // its own def ("the starter is never sold, only re-ammoed") — and it carries `infiniteReserve`,
    // so an inkslinger ammo wall would charge 250 points for nothing.
    const sellable = ctx.weapons.allDefs
      .filter((d) => d.buyCost > 0 && !d.infiniteReserve)
      .slice()
      .sort((a, b) => a.buyCost - b.buyCost);

    if (sellable.length === 0) {
      console.warn('[wallbuys] no weapon def carries a buyCost — no walls placed');
      return;
    }

    const count = Math.min(WALL.maxSpots, Math.max(WALL.spots, sellable.length));
    const found = findWallSpots(ctx.world, count);
    if (found.length === 0) {
      console.warn('[wallbuys] no usable wall face found in this arena — no walls placed');
      return;
    }

    // NEAREST WALL IS THE CHEAPEST WALL. Sorting the found spots by distance from the player's
    // own spawn and then dealing weapons out cheapest-first turns the price ladder into a
    // DISTANCE ladder, for free and with no authored coordinates: the SMG is the gun you can
    // reach on round 2, the marksman is the one you plan a run around. Beyond the first pass the
    // list wraps, and those duplicate walls are the supply line — a second place to re-ammo the
    // cheap guns without walking past every gun in the game.
    found.sort((a, b) => a.spawnDist - b.spawnDist);

    const root = new Group();
    root.name = 'wallbuys';
    ctx.scene.add(root);
    this.root = root;

    const aspect = WALL.chalkHeight / WALL.chalkWidth;
    this.geo = new PlaneGeometry(WALL.chalkWidth, WALL.chalkHeight);

    for (let i = 0; i < found.length; i++) {
      const c = found[i];
      const def = sellable[i % sellable.length];
      this.spots.push(this.buildSpot(ctx, root, def, c, aspect));
    }

    ctx.debug.watch('wallbuy', () => {
      if (this.near < 0) return `${this.spots.length} walls · —`;
      const s = this.spots[this.near];
      return `${s.def.id} ${this.modeOf(ctx, s)}`;
    });
  }

  private buildSpot(
    ctx: GameCtx, root: Group, def: WeaponDef, c: Candidate, aspect: number,
  ): WallSpot {
    let tex = this.textures.get(def.id);
    if (!tex) {
      tex = buildChalkTexture(def, aspect);
      this.textures.set(def.id, tex);
    }

    const material = new MeshBasicMaterial({
      map: tex,
      transparent: true,
      // A decal on a wall must not write depth: it is a flat transparent sheet sitting 35 mm
      // proud of an opaque surface, and writing depth would let its transparent margin occlude
      // anything drawn behind it later in the frame.
      depthWrite: false,
      side: FrontSide,
      // Unlit and un-tone-mapped ON PURPOSE. §2's chalk has to be "readable from across the
      // map", and a lit decal in an unlit alley is invisible exactly where the player most needs
      // to find their re-ammo point. Fog still applies (MeshBasicMaterial participates), so it
      // recedes with distance like everything else instead of floating out of the frame.
      toneMapped: false,
      opacity: WALL.chalkOpacity,
      fog: true,
    });
    material.color.setRGB(1, 1, 1);

    const mesh = new Mesh(this.geo as PlaneGeometry, material);
    mesh.name = `wallbuy-${def.id}`;
    _p.set(c.wx, c.wy, c.wz);
    _n.set(c.nx, 0, c.nz).normalize();
    mesh.position.copy(_p).addScaledVector(_n, WALL.chalkOffset);
    // PlaneGeometry faces +Z, so aiming +Z down the wall normal puts the drawing on the wall and
    // facing the street. `up` is Y and the normal is horizontal by construction (`maxNormalY`),
    // so there is no degenerate lookAt and no roll.
    _corner.copy(mesh.position).add(_n);
    mesh.lookAt(_corner);
    // The chalk carries its own linework; a Sobel edge would just draw a box around the decal.
    mesh.layers.set(LAYER.NO_INK);
    root.add(mesh);

    const cost = def.buyCost;
    const ammo = def.ammoCost;
    return {
      def,
      anchor: new Vector3(c.sx, c.sy, c.sz),
      mesh,
      material,
      text: {
        // `hud.prompt` bolds `PRESS <KEY>` and golds `[digits]`, so both are written plainly and
        // the HUD owns the markup. F and E are the existing `interact` binding (`core/input.ts`)
        // — a wall-buy does not get a keybind of its own.
        buy: `PRESS F — ${def.name} [${cost}]`,
        buySwaps: `PRESS F — ${def.name} [${cost}] · SWAPS`,
        buyDenied: `${def.name} [${cost}] · NOT ENOUGH`,
        ammo: `PRESS F — ${def.name} AMMO [${ammo}]`,
        ammoDenied: `${def.name} AMMO [${ammo}] · NOT ENOUGH`,
        full: `${def.name} · AMMO FULL`,
      },
      buyReason: `wallbuy:${def.id}`,
      ammoReason: `wallammo:${def.id}`,
      flash: 0,
      dimmed: false,
    };
  }

  // ── the frame ───────────────────────────────────────────────────────────────────────────

  /**
   * PRESENTATION *AND* THE PURCHASE, and the second half is deliberate.
   *
   * `input.pressed()` is a FRAME edge: `loop.ts` publishes it in `beginFrame` and clears it in
   * `endFrame`, with `fixedUpdate` running anywhere from 0 to 5 times in between. Reading a buy
   * press in `fixedUpdate` would therefore either MISS it (a frame shorter than FIXED_DT runs no
   * steps at all) or fire it up to FIVE times — five guns, five deductions, one keypress. This
   * is the same exception `weapons/service.ts` documents for the trigger, on the same grounds:
   * the operation integrates nothing over time, reads no clock and rolls no dice, so it cannot
   * desync. It is an instantaneous, deterministic function of one input edge.
   */
  /**
   * SCAN ONLY — no purchase, no prompt, no presentation. It exists so the claim broker has this
   * layer's distance BEFORE the machine layer arbitrates in its own `fixedUpdate` (this system is
   * registered first, so it steps first). Without it the machine would always be comparing
   * against a wall distance one whole frame old — 13 cm of player travel at 60 fps.
   *
   * Five spots, squared distances, no sqrt and no allocation: ~600 compares a second at 120 Hz.
   */
  fixedUpdate(_dt: number, ctx: GameCtx): void {
    if (this.spots.length === 0) return;
    this.scanNearest(ctx);
  }

  /**
   * Nearest wall within reach, published to the claim broker, `this.near` set. Distance is 3D from
   * the STANDING anchor, so a player on a balcony directly above a wall-buy is correctly out of
   * range. Returns the squared distance, or `Infinity` when nothing is in reach.
   *
   * A dead or downed player is standing at nothing — `spend()` applies NO policy by contract, so
   * the answer lives here, and publishing `Infinity` is also what stops a wall you cannot use from
   * out-arguing a machine you can.
   */
  private scanNearest(ctx: GameCtx): number {
    const spots = this.spots;
    if (!ctx.player.alive || ctx.player.isDown) {
      this.near = -1;
      publishDistance(OWNER_WALL, Infinity);
      return Infinity;
    }

    const at = ctx.player.position;
    const maxSq = WALL.useRadius * WALL.useRadius;
    let best = -1;
    let bestSq = maxSq;
    for (let i = 0; i < spots.length; i++) {
      const a = spots[i].anchor;
      const dx = at.x - a.x;
      const dy = at.y - a.y;
      const dz = at.z - a.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestSq) { bestSq = d2; best = i; }
    }
    this.near = best;
    // Published EVERY step, `Infinity` included: a distance refreshed only while something is in
    // range would keep winning arbitration after the player has walked away from it.
    const out = best < 0 ? Infinity : bestSq;
    publishDistance(OWNER_WALL, out);
    return out;
  }

  update(dt: number, ctx: GameCtx): void {
    const spots = this.spots;
    if (spots.length === 0) return;

    for (let i = 0; i < spots.length; i++) this.tickFlash(spots[i], dt);

    if (!ctx.player.alive || ctx.player.isDown) {
      this.scanNearest(ctx);
      this.clearPrompt(ctx);
      return;
    }

    // Affordability sweep: the chalk dims when you cannot afford it. Points only move on kills
    // and purchases, so this runs a handful of times a second, never per frame.
    if (ctx.player.points !== this.lastPoints) {
      this.lastPoints = ctx.player.points;
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        const mode = this.modeOf(ctx, s);
        const dim = mode === 'full'
          ? false
          : !ctx.player.canAfford(mode === 'ammo' ? s.def.ammoCost : s.def.buyCost);
        if (dim !== s.dimmed) {
          s.dimmed = dim;
          if (s.flash <= 0) s.material.opacity = dim ? WALL.chalkOpacityDim : WALL.chalkOpacity;
        }
      }
    }

    // ARBITRATION. A perk machine can be parked 1.11 m from a wall-buy on the shipped arena —
    // measured, see `claim.ts` — and without this both layers answered the same press and took
    // both prices. Re-scanned here rather than reusing the fixed step's answer because a frame
    // above 120 fps runs no fixed step at all and would otherwise arbitrate on last frame's pose.
    this.scanNearest(ctx);
    const best = this.near;
    if (best < 0 || !ownsSpot(OWNER_WALL)) {
      this.clearPrompt(ctx);
      return;
    }

    const spot = spots[best];
    const mode = this.modeOf(ctx, spot);
    this.setPrompt(ctx, this.promptFor(ctx, spot, mode));

    // `takeInteract` stamps the frame, so exactly one of the two layers can ever act on a single
    // press even if the two distances were measured a frame apart.
    if (ctx.input.pressed('interact') && takeInteract(ctx.time.frame, OWNER_WALL)) {
      this.use(ctx, spot, mode);
    }
  }

  // ── the purchase ────────────────────────────────────────────────────────────────────────

  /**
   * Which of the two things this wall sells you right now. Pure, allocation-free, safe to call
   * every frame — it is the per-frame half of the API, exactly like `canAfford`.
   *
   * A Pack-a-Punched gun still counts as owned: `upgradedDef` appends '+' to the id and leaves
   * everything else derived, and BO2's rule is that an upgraded wall weapon re-ammos at its wall
   * for its ORIGINAL price. Matching on both ids is what keeps that true for free.
   */
  private modeOf(ctx: GameCtx, spot: WallSpot): WallMode {
    const held = this.heldSlot(ctx, spot.def.id);
    if (held < 0) return 'buy';
    const inst = ctx.weapons.slots[held];
    return inst && this.ammoFull(ctx, inst) ? 'full' : 'ammo';
  }

  /** Slot index holding this weapon (upgraded or not), or -1. Two slots — no allocation. */
  private heldSlot(ctx: GameCtx, id: string): number {
    const slots = ctx.weapons.slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s) continue;
      if (s.def.id === id || s.def.id === `${id}+`) return i;
    }
    return -1;
  }

  /**
   * Would `refillAmmo` change anything? Charging 600 points for a no-op is the one way a wall-buy
   * can feel like a scam, so a full weapon shows AMMO FULL and refuses the press.
   *
   * MIRRORS `WeaponService.refillAmmo` / `magSizeOf` deliberately: mag and reserve caps are a
   * function of the live def and the live stat multipliers, and `WeaponInstance` publishes no
   * "max" of its own. If those formulas ever move, this moves with them.
   */
  private ammoFull(ctx: GameCtx, inst: WeaponInstance): boolean {
    const stats = ctx.player.stats;
    const def = inst.def;
    const maxMag = Math.max(1, Math.round(def.magSize * Math.max(stats.magSizeMult, 0.05)));
    if (inst.ammo < maxMag) return false;
    if (def.infiniteReserve) return true;
    const maxReserve = Math.round(def.reserveAmmo * Math.max(stats.reserveAmmoMult, 0));
    return inst.reserve >= maxReserve;
  }

  private promptFor(ctx: GameCtx, spot: WallSpot, mode: WallMode): string {
    if (mode === 'full') return spot.text.full;
    if (mode === 'ammo') {
      return ctx.player.canAfford(spot.def.ammoCost) ? spot.text.ammo : spot.text.ammoDenied;
    }
    if (!ctx.player.canAfford(spot.def.buyCost)) return spot.text.buyDenied;
    // Both slots full means `give()` replaces the gun IN YOUR HANDS (`weapons/service.ts`). That
    // is the Zombies rule and it is correct — but losing a 2 000-point marksman to a mistimed
    // press is a feel bug, so the prompt says so BEFORE you press.
    return ctx.weapons.slots.indexOf(null) < 0 ? spot.text.buySwaps : spot.text.buy;
  }

  /**
   * The interact edge. One press, one outcome, no menu — which is what makes the ammo path the
   * fast path §2 asks for.
   *
   * `spend()` is the gate and it is atomic: on a refusal nothing was deducted and `player:denied`
   * has ALREADY fired, so there is nothing to roll back and no second "can't afford" beat to
   * write. Everything after a `true` is the reward.
   */
  private use(ctx: GameCtx, spot: WallSpot, mode: WallMode): void {
    if (mode === 'full') {
      // Not a refusal to pay — there is nothing to sell. No `spend()`, so no `player:denied`.
      ctx.events.emit('fx:sound', { id: 'ui_click', volume: 0.5 });
      return;
    }

    if (mode === 'ammo') {
      if (!ctx.player.spend(spot.def.ammoCost, spot.ammoReason)) { this.deny(ctx, spot); return; }
      const slot = this.heldSlot(ctx, spot.def.id);
      if (slot >= 0) ctx.weapons.refillAmmo(slot);
      ctx.events.emit('fx:sound', { id: 'powerup_take', volume: 0.85, pitch: 1.18 });
      this.beat(ctx, spot, 'AMMO!', SEMANTIC.interactable);
      return;
    }

    if (!ctx.player.spend(spot.def.buyCost, spot.buyReason)) { this.deny(ctx, spot); return; }
    ctx.weapons.give(spot.def.id);
    // `give` already emits `weapon:equipped`, which the audio layer answers — this is the
    // PURCHASE on top of it, the chime that says the points left your pocket.
    ctx.events.emit('fx:sound', { id: 'powerup_take', volume: 1 });
    ctx.events.emit('fx:flash', { intensity: 0.18, color: SEMANTIC.interactable });
    this.beat(ctx, spot, spot.def.name, SEMANTIC.interactable);
  }

  /** The purchase beat: a word off the wall and a strobe on the chalk. */
  private beat(ctx: GameCtx, spot: WallSpot, text: string, color: number): void {
    spot.flash = WALL.flashTime;
    _wordAt.copy(spot.mesh.position);
    ctx.events.emit('fx:word', {
      text, position: _wordAt, color, scale: WALL.wordScale,
    });
    // The prompt is now stale (a buy becomes an ammo sale the instant it lands). Force the next
    // frame to re-emit rather than comparing against a string that no longer applies.
    this.showing = null;
    this.lastPoints = -1;
  }

  /** The refusal beat. `player:denied` already fired inside `spend()`; this is only the sound. */
  private deny(ctx: GameCtx, spot: WallSpot): void {
    ctx.events.emit('fx:sound', { id: 'dry_fire', volume: 0.7 });
    spot.material.opacity = WALL.chalkOpacityDim;
    spot.dimmed = true;
  }

  private tickFlash(spot: WallSpot, dt: number): void {
    if (spot.flash <= 0) return;
    spot.flash -= dt;
    if (spot.flash <= 0) {
      spot.flash = 0;
      spot.material.opacity = spot.dimmed ? WALL.chalkOpacityDim : WALL.chalkOpacity;
      spot.material.color.setRGB(1, 1, 1);
      return;
    }
    // Two-frame strobe, not a fade (ART §8). GOLD on, plain chalk off.
    if (Math.floor(spot.flash * WALL.flashHz) % 2 === 0) {
      spot.material.opacity = 1;
      spot.material.color.copy(GOLD_LINEAR);
    } else {
      spot.material.opacity = WALL.chalkOpacity;
      spot.material.color.setRGB(1, 1, 1);
    }
  }

  // ── the prompt line ─────────────────────────────────────────────────────────────────────
  //
  // `ui:prompt` is a SHARED channel — the perk machines, Pack-a-Punch and the mystery box drive
  // it too. So the protocol here is: emit only when OUR text changes, and never clear a line we
  // did not put up.
  //
  // That protocol alone is NOT enough, and this comment used to claim it was ("standing inside
  // both radii at once lets the nearer one win"). Nothing implemented that and nothing could —
  // neither layer knew the other's distance, so the line stuck at whichever had most recently
  // changed its own string, and one press bought from both. `claim.ts` is what actually makes
  // "the nearer one wins" true, and `ownsSpot` above gates the prompt on the same test the
  // purchase uses so the line can never offer something F does not buy.

  private setPrompt(ctx: GameCtx, text: string): void {
    if (this.showing === text) return;
    this.showing = text;
    _promptPayload.text = text;
    ctx.events.emit('ui:prompt', _promptPayload);
  }

  private clearPrompt(ctx: GameCtx): void {
    if (this.showing === null) return;
    this.showing = null;
    _promptPayload.text = null;
    ctx.events.emit('ui:prompt', _promptPayload);
  }

  // ── the chalk ───────────────────────────────────────────────────────────────────────────

  // ── teardown ────────────────────────────────────────────────────────────────────────────

  dispose(): void {
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      s.mesh.removeFromParent();
      s.material.dispose();
    }
    this.spots.length = 0;
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    this.geo?.dispose();
    this.geo = null;
    this.root?.removeFromParent();
    this.root = null;
    // The claim broker is module state and outlives this system. A torn-down run that left a
    // finite distance behind would let a wall-buy that no longer exists win arbitration against
    // the next run's perk machines.
    resetInteractClaims();
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PLACEMENT — module-level and world-only, so it is checkable without a GL context.
//
// It takes a `WorldService` and nothing else: no scene, no renderer, no `GameCtx`. That is what
// lets the headless rig in `tools/` run the REAL placement pass against the REAL arena and the
// REAL collision octree and report how many walls landed, how far apart, and at what height —
// the objective half of this feature, which is the only half a machine should be spending
// tokens on (CLAUDE.md §2).
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * WHY THE PROBE PASS COUNTS ITS OWN REJECTIONS.
 *
 * Every gate below throws away the overwhelming majority of samples, and if one of them is too
 * tight the only symptom is "there are three wall-buys instead of five" — which reads as a level
 * problem, not a constant problem, and would then be tuned by guessing. These counters name the
 * gate that did it, so a new arena's placement is diagnosable in one line instead of by
 * bisecting `WALL`. Reset on every `findWallSpots`.
 *
 * MEASURED on the shipped arena (headless, `tools/rig.ts`): 512 samples find 191 faces, and of
 * those `corner` throws out ~78%. That number is the whole reason the tangent slide below
 * exists — see `probeWall`.
 */
export const WALL_PROBE_STATS = {
  /** Ring samples taken. */
  samples: 0,
  /** The sample point itself was not street level. */
  offStreet: 0,
  /** No vertical face within `probeReach` of the sample. */
  noFace: 0,
  /** Slide positions tested along a found face. */
  slides: 0,
  noLocalFace: 0,
  cMiss: 0,
  cProt: 0,
  cRec: 0,
  cNorm: 0,
  /** The ground in front of the face is not street level. */
  standOffStreet: 0,
  /** The quad does not land on ONE plane — a doorway, a corner, a window reveal. */
  corner: 0,
  /** The drawing's bottom edge would be buried in the pavement. */
  lowChalk: 0,
  /** A player cannot stand in front of it — a prop, a kerb, geometry. */
  standBlocked: 0,
  /** Under `minHeadroom` of sky above the standing spot: indoors, not a street. */
  headroom: 0,
  /** Inside `minSpawnDist` of the player spawn. */
  nearSpawn: 0,
  /** Candidates produced. */
  ok: 0,
};

/**
 * Probe the live world for wall faces that can hold a chalk drawing, then pick `count` of them
 * that are genuinely spread out.
 *
 * Boot-time only: it allocates freely and casts on the order of 15 000 rays. For scale, the
 * navigation graph in `EnemySystem.init` casts 100 800 in the same awaited block (190 ms in a
 * production build), so this is a small fraction of a cost the boot sequence already carries.
 */
export function findWallSpots(world: WorldService, count: number): Candidate[] {
  const S = WALL_PROBE_STATS;
  S.samples = 0; S.offStreet = 0; S.noFace = 0; S.slides = 0; S.standOffStreet = 0;
  S.noLocalFace = 0; S.cMiss = 0; S.cProt = 0; S.cRec = 0; S.cNorm = 0;
  S.corner = 0; S.lowChalk = 0; S.standBlocked = 0; S.headroom = 0; S.nearSpawn = 0; S.ok = 0;

  const b = world.bounds;
  const cx = (b.min.x + b.max.x) * 0.5;
  const cz = (b.min.z + b.max.z) * 0.5;
  const half = Math.min(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5;

  const spawn = world.playerSpawn.position;
  _p.copy(spawn);
  const spawnY = world.groundAt(_p) ?? spawn.y;

  const pool: Candidate[] = [];
  const TAU = Math.PI * 2;
  for (let a = 0; a < WALL.angleSamples; a++) {
    const ang = (a / WALL.angleSamples) * TAU;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    for (let r = 0; r < WALL.radiusSamples; r++) {
      const f = WALL.radiusSamples > 1 ? r / (WALL.radiusSamples - 1) : 0;
      const rad = half * (WALL.radiusMin + (WALL.radiusMax - WALL.radiusMin) * f);
      probeWall(world, cx + ca * rad, cz + sa * rad, spawnY, spawn, cx, cz, pool);
    }
  }
  if (pool.length === 0) return pool;

  pool.sort((x, y) => y.score - x.score);

  // Greedy pick under BOTH a metric and an angular separation. If the arena cannot fit `count`
  // walls at full spacing, relax and try again rather than shipping four walls in one alley —
  // the spacing is the mechanic, but so is having something to buy.
  const picked: Candidate[] = [];
  let sep = WALL.minSeparation;
  let angSep = WALL.minAngleSep;
  for (let attempt = 0; attempt <= WALL.relaxTries && picked.length < count; attempt++) {
    for (let i = 0; i < pool.length && picked.length < count; i++) {
      const c = pool[i];
      let ok = true;
      for (let j = 0; j < picked.length; j++) {
        const q = picked[j];
        if (q === c) { ok = false; break; }
        if (Math.hypot(c.sx - q.sx, c.sz - q.sz) < sep) { ok = false; break; }
        let da = Math.abs(c.angle - q.angle);
        if (da > Math.PI) da = TAU - da;
        if (da < angSep) { ok = false; break; }
      }
      if (ok) picked.push(c);
    }
    sep *= WALL.relaxStep;
    angSep *= WALL.relaxStep;
  }
  return picked;
}

/**
 * One ring sample: find the nearest vertical face, then walk ALONG it looking for a patch flat
 * enough to chalk on. Appends every position that works to `out`.
 *
 * ═══ THE TANGENT SLIDE, AND WHY IT IS THE WHOLE ALGORITHM ═══
 *
 * The first version tested the face exactly where the sample found it, and it placed THREE walls
 * on a five-wall map, all of them on the west side. The counters said why: of 191 faces found,
 * 149 failed the four-corner plane test. MEASURED depth error across a 1.6 × 1.2 m patch, over
 * 384 faces: it is bimodal — 37 faces are flat to within 5 cm, and 138 sit between 35 and 60 cm.
 * That is not noise, it is ARCHITECTURE: the arena's facades are broken up by recessed windows
 * and pilasters roughly every couple of metres, and a sample landing at a random height and
 * lateral position is far more likely to hit one than to miss it.
 *
 * Shrinking the drawing barely helps (52 flat patches instead of 37 — the reveals are deep, not
 * narrow). Sampling the ring more densely helps but costs rays everywhere, including in the
 * middle of the plaza where there is nothing to find.
 *
 * Sliding along the tangent is the fix that matches the geometry: the flat pier BETWEEN two
 * windows is exactly where a person would chalk a gun, and one face hit gives us a whole row of
 * positions to test for four rays each. Same ray budget, an order of magnitude more candidates.
 *
 * The corner test therefore runs FIRST at each slide position, before the capsule and headroom
 * queries: it is the gate that rejects ~78% of positions, so paying for it first is what keeps
 * the pass cheap.
 */
function probeWall(
  world: WorldService, x: number, z: number, spawnY: number, spawn: Vector3,
  cx: number, cz: number, out: Candidate[],
): void {
  const S = WALL_PROBE_STATS;
  S.samples++;

  // 1 · the sample has to be on the street to be worth looking from. See the nav note in the
  // file header: street level plus a clear capsule plus headroom is the stand-in for a real
  // reachability query, and it is what keeps chalk off rooftops, ledges and interiors.
  _p.set(x, spawnY + WALL.chalkCenterY, z);
  const sampleG = world.groundAt(_p);
  if (sampleG === null || Math.abs(sampleG - spawnY) > WALL.maxRise) { S.offStreet++; return; }

  // 2 · whiskers at the height the chalk will hang. Every result is copied out immediately:
  // `WorldCollision.raycast` hands back a record from a ring of EIGHT and this loop makes
  // exactly eight calls, so the first would otherwise be clobbered by the last.
  _p.set(x, sampleG + WALL.chalkCenterY, z);
  let openSum = 0;
  let wallD = Infinity;
  let wx = 0; let wz = 0;
  let wnx = 0; let wnz = 0;
  for (let d = 0; d < WALL.probeDirs; d++) {
    const a = (d / WALL.probeDirs) * Math.PI * 2;
    _dir.set(Math.cos(a), 0, Math.sin(a));
    const hit = world.raycast(_p, _dir, WALL.probeReach);
    if (!hit.hit) { openSum += WALL.probeReach; continue; }
    openSum += hit.distance;
    if (hit.distance < WALL.minStandoff || hit.distance >= wallD) continue;
    if (Math.abs(hit.normal.y) > WALL.maxNormalY) continue;
    wallD = hit.distance;
    wx = hit.point.x; wz = hit.point.z;
    wnx = hit.normal.x; wnz = hit.normal.z;
  }
  if (!Number.isFinite(wallD)) { S.noFace++; return; }

  _n.set(wnx, 0, wnz);
  if (_n.lengthSq() < 1e-6) { S.noFace++; return; }
  _n.normalize();
  _tan.crossVectors(UP, _n).normalize();

  // Openness is measured once, at the sample, and shared by every slide position off this face:
  // it describes the STREET, which does not change over a few metres of the same wall.
  const openness = openSum / (WALL.probeDirs * WALL.probeReach);
  const fitFace = 1 - Math.min(1, (wallD - WALL.minStandoff) / (WALL.probeReach - WALL.minStandoff));

  // 3 · walk the face. Offsets are symmetric about the hit, closest first, so the highest-scoring
  // patches are also the ones nearest to a place a player was already walking.
  const steps = WALL.slideSteps;
  for (let i = 0; i < steps * 2 + 1; i++) {
    // 0, +1, -1, +2, -2, … in units of `slideStep`.
    const k = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2);
    const off = k * WALL.slideStep;
    S.slides++;

    // RE-MEASURE THE FACE AT EVERY SLIDE POSITION, and this is the fix that made the pass work
    // at all. Anchoring the plane at the whisker's own hit distance assumes the wall is a plane,
    // and it is not: a whisker returns the NEAREST surface, which on this arena's facades is
    // usually a pilaster or a sill standing proud of the wall behind it. MEASURED with the
    // shared anchor, 92% of slide positions failed the corner test and they failed 3–4 corners
    // at a time — the drawing was not straddling a defect, it was floating in front of the whole
    // recessed bay. Casting a fresh centre ray here makes the reference LOCAL, so each patch is
    // judged against its own wall.
    _p.set(x, sampleG + WALL.chalkCenterY, z).addScaledVector(_tan, off);
    _dir.copy(_n).negate();
    const face = world.raycast(_p, _dir, wallD + WALL.slideDepth);
    if (!face.hit || face.distance < WALL.minStandoff || face.normal.dot(_n) < 0.9) {
      S.noLocalFace++;
      continue;
    }
    const sx = face.point.x + _n.x * WALL.standoff;
    const sz = face.point.z + _n.z * WALL.standoff;

    _p.set(sx, spawnY + WALL.chalkCenterY, sz);
    const g = world.groundAt(_p);
    if (g === null || Math.abs(g - spawnY) > WALL.maxRise) { S.standOffStreet++; continue; }

    const cy = g + WALL.chalkCenterY;
    const hw = WALL.chalkWidth * 0.5;
    const hh = WALL.chalkHeight * 0.5;
    // The chalk must clear the deck: a drawing with its bottom edge buried in the pavement reads
    // as a bug, and `chalkCenterY` alone does not guarantee it on a sloped street.
    if (cy - hh < g + 0.05) { S.lowChalk++; continue; }

    // 4 · four corner rays cast back at the face. This is what stops a drawing hanging half over
    // a doorway, sinking into a pilaster, or wrapping an outside corner.
    let flat = true;
    let worstErr = 0;
    for (let c = 0; c < 4; c++) {
      const dx = (c & 1) === 0 ? -hw : hw;
      const dy = (c & 2) === 0 ? -hh : hh;
      _corner.set(sx, cy + dy, sz).addScaledVector(_tan, dx);
      _dir.copy(_n).negate();
      const cs = world.raycast(_corner, _dir, WALL.standoff + WALL.cornerRecess);
      const err = cs.hit ? cs.distance - WALL.standoff : Infinity;
      if (!cs.hit) S.cMiss++;
      else if (err < -WALL.cornerProtrude) S.cProt++;
      else if (cs.normal.dot(_n) < 0.9) S.cNorm++;
      else { worstErr = Math.max(worstErr, Math.abs(err)); continue; }
      flat = false;
      break;
    }
    if (!flat) { S.corner++; continue; }

    // 5 · can a player stand there? Capsule convention is sphere CENTRES, so the bottom sits one
    // radius above the deck (`collision.ts`).
    _capA.set(sx, g + MOVE.radius + 0.02, sz);
    _capB.set(sx, g + MOVE.standHeight - MOVE.radius, sz);
    if (world.collideCapsule(_capA, _capB, MOVE.radius).depth > WALL.standClearance) {
      S.standBlocked++;
      continue;
    }

    _p.set(sx, g + MOVE.standHeight, sz);
    if (world.raycast(_p, UP, WALL.minHeadroom).hit) { S.headroom++; continue; }

    const spawnDist = Math.hypot(sx - spawn.x, sz - spawn.z);
    if (spawnDist < WALL.minSpawnDist) { S.nearSpawn++; continue; }

    // 6 · score. Open street beats alcove (you train through it); a face the sample found close
    // by genuinely fronts that street rather than being glimpsed down an alley; a wall a sensible
    // walk from spawn beats one on the doorstep; and all else equal, the patch nearest where the
    // sample actually hit wins, so a wall-buy lands on the pier a player walks past.
    const fitSpawn = 1 - Math.min(1, Math.abs(spawnDist - WALL.idealSpawnDist) / WALL.idealSpawnDist);
    const fitSlide = 1 - Math.min(1, Math.abs(off) / (steps * WALL.slideStep));
    // FLATNESS IS A PREFERENCE, NOT ONLY A GATE. `cornerRecess` has to be generous enough that
    // every quadrant of the arena has something to sell (see its note), which means some
    // admissible patches sit in front of a shallow bay. Weighting flushness high here means the
    // greedy pick takes the FLATTEST wall in each sector and only ever falls back to a rougher
    // one when a sector has nothing better — so the tolerance buys coverage without spending
    // the look of the walls the player actually visits.
    const fitFlat = 1 - Math.min(1, worstErr / WALL.cornerRecess);

    S.ok++;
    out.push({
      sx, sy: g, sz,
      // The chalk sits on the face, level with the standing spot and directly in front of it.
      wx: sx - _n.x * WALL.standoff, wy: cy, wz: sz - _n.z * WALL.standoff,
      nx: _n.x, nz: _n.z,
      angle: Math.atan2(sz - cz, sx - cx),
      spawnDist,
      flatness: worstErr,
      score: openness * WALL.wOpen + fitFace * WALL.wStandoff + fitSpawn * WALL.wSpawnDist
        + fitSlide * WALL.wSlide + fitFlat * WALL.wFlat,
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Draw one weapon's chalk board. Called once per sellable weapon at boot; the texture is shared
 * by every wall that sells it, so duplicate supply walls cost one material each and no pixels.
 */
export function buildChalkTexture(def: WeaponDef, aspect: number): Texture {
  const W = WALL.texWidth;
  const H = Math.round(W * aspect);
  const { canvas, ctx: c } = makeCanvas(W, H);

  // Deterministic per weapon: the same gun always chalks identically, which matters because
  // determinism is a product requirement (GAME_BIBLE §9.3) and art seeded off a live RNG would
  // shift every stream downstream of it.
  let h = 0x5ca1e;
  for (let i = 0; i < def.id.length; i++) h = (Math.imul(h, 31) + def.id.charCodeAt(i)) | 0;
  const rnd = makeSeededRandom(h || 1);

  const chalk = cssOf(rgb8('PAPER'), 1);
  const gold = cssOf(rgb8Hex(SEMANTIC.interactable), 1);
  const width = (WALL.strokeWidth * W) / WALL.texWidth;

  // 1 · the silhouette
  const parts = GUN_PARTS[def.archetype];
  const bx = ART_BAND.x0 * W;
  const bw = (ART_BAND.x1 - ART_BAND.x0) * W;
  const by = ART_BAND.y0 * H;
  const bh = (ART_BAND.y1 - ART_BAND.y0) * H;
  const pts: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const src = parts[i];
    pts.length = 0;
    for (let k = 0; k < src.length; k += 2) {
      pts.push(bx + src[k] * bw, by + src[k + 1] * bh);
    }
    roughPolygon(c, pts, null, chalk, {
      width, jitter: width * 0.42, step: 13, passes: 2, seed: h + i * 131, alpha: 0.95,
    });
  }

  // 2 · the name, small, above the drawing — legible before the silhouette resolves
  chalkText(c, def.name, W * 0.5, H * NAME_Y, H * 0.085, chalk, rnd.spread(0.02));

  // 3 · the price, big, in GOLD. GOLD is the interactable channel (ART §6) and this is the
  //     only part of the board that is a gameplay signal rather than a picture.
  chalkText(c, String(def.buyCost), W * 0.5, H * PRICE_Y, H * 0.185, gold, rnd.spread(0.03));
  roughStroke(c, [W * 0.24, H * 0.955, W * 0.76, H * 0.955], {
    color: gold, width: width * 0.9, jitter: width * 0.5, passes: 1, seed: h + 977, alpha: 0.8,
  });

  // 4 · CHALK DUST. Solid strokes read as paint; chalk is patchy. Erasing random dots out of
  //     what we just drew breaks the strokes up without touching the transparent background,
  //     which is what makes it look like it was scrawled on brick rather than printed.
  c.save();
  c.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < WALL.dustDots; i++) {
    const r = rnd.range(0.6, 2.4);
    c.globalAlpha = rnd.range(0.25, 0.85);
    c.beginPath();
    c.arc(rnd.range(0, W), rnd.range(0, H), r, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = `chalk-${def.id}`;
  return tex;
}


/** GOLD in the renderer's working space, built once — the purchase strobe's colour. */
const GOLD_LINEAR = col('GOLD');

/**
 * Chalked lettering: a heavy stroked outline with a thin fill behind it. Stroke-led rather than
 * fill-led because that is how chalk actually deposits — the edge of the letter takes the powder
 * and the middle stays open — and because a solid fill at PAPER would blow past the environment
 * value ceiling on a wall-sized decal.
 *
 * The font stack is the same system stack the word pops use (`COMIC_FONT_STACK`): Impact / Arial
 * Black, resolved by the OS. No webfont, no asset file.
 */
function chalkText(
  c: CanvasRenderingContext2D, text: string, cx: number, cy: number,
  size: number, color: string, tilt: number,
): void {
  c.save();
  c.translate(cx, cy);
  c.rotate(tilt);
  c.font = `900 ${Math.round(size)}px ${COMIC_FONT_STACK}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  c.lineWidth = Math.max(2, size * 0.075);
  c.strokeStyle = color;
  c.globalAlpha = 0.95;
  c.strokeText(text, 0, 0);
  c.fillStyle = color;
  c.globalAlpha = 0.3;
  c.fillText(text, 0, 0);
  c.restore();
}

/** `main.ts` adopts this in one line: `loop.add(createWallBuys());`. */
export function createWallBuys(): WallBuySystem {
  return new WallBuySystem();
}

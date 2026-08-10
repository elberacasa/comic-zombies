/**
 * THE ARENA — an inked city block, built entirely from code.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  BUILD 002 — THE 2× RESCALE.  "bigger spaces, feels everything is small compared to
 *  speed and char" (human, BUILD 001).  ARENA_HALF went 35 → 70: a 140 m block, four times
 *  the area, buildings 6–10 storeys instead of 3–4.  Nothing about the player was slowed
 *  down; the SPACE grew to meet the speed.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * LEVEL DESIGN (GAME_BIBLE §2/§4 — it must be kite-able):
 *
 *        ┌──────────────────── 140 m ────────────────────┐
 *        │        ║      NORTH  BLOCK  8F      ║         │  ← ring road: a 15 m boulevard
 *        │  NW 7F ║                            ║  NE 2F  │    that laps the whole map
 *        │ ═══════╬════════════════════════════╬═══════  │  ║ ═ are 8 m radial streets
 *        │        ║                            ║ (roof)  │
 *        │ WEST   ║                            ║  EAST   │
 *        │ 10F    ║          P L A Z A         ║   7F    │  ← plaza is 58 m across
 *        │ +TOWER ║          58 × 58 m         ║ +GANTRY │
 *        │ +DEPOT ║                            ║         │
 *        │ ═══════╬════════════════════════════╬═══════  │
 *        │ SW LOT ║      SOUTH  BLOCK  6F      ║  SE 9F  │
 *        │        ║      + COLONNADE           ║         │
 *        └───────────────────────────────────────────────┘
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE KITE LOOPS — every one of these is a closed circuit with no dead end.  A horde can be
 * trained onto any of them and cut between them at eight junctions.  VERIFIED by walking the
 * graph: plaza ↔ 8 radial streets ↔ ring road, and the ring road is a cycle.
 *
 *   LOOP A  RING BOULEVARD   — the outer lap, ~440 m, four 140 m straights. Never blocked.
 *   LOOP B  PLAZA CIRCUIT    — around the monument dais, ~150 m. The panic loop.
 *   LOOP C  FIGURE-EIGHT     — plaza → any radial street → ring road → another radial → plaza.
 *                              Eight entrances means you can always re-enter behind the horde.
 *   LOOP D  EAST VERTICAL    — ring road → east stair → NE market roof (6.8 m) → skybridge →
 *                              east gantry → plaza stair. Returns to the plaza on foot.
 *   LOOP E  WEST DEPOT       — plaza → covered arcade THROUGH the west block → ring road.
 *                              A shortcut that cuts the ring lap in half. Columned, so it is
 *                              cover, not a corridor.
 *   LOOP F  WEST HIGH ROUTE  — depot → fire escape → 13.6 m catwalk along the west facade →
 *                              stair down into the plaza's north-west corner.
 *   LOOP G  SOUTH PARKOUR    — SW lot container stack (2.6 → 5.2 m mantles) → south block
 *                              loading-dock canopy (4.4 m) → drop into the south colonnade.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE LONG SIGHTLINES — distance is only legible if you can SEE distance.  Eight axes:
 *
 *   • x = ±25 and z = ±25 run clear from wall to wall — 140 m each, straight through a
 *     radial street, across the plaza, and out the far radial street.  Lamp rows and
 *     catenary wires recede down all four; that receding rhythm is what sells the scale.
 *   • The four ring-road straights are 140 m each with a utility-pole row on the wall side.
 *
 * HUMAN-SCALE REFERENCE, everywhere, because a big space with nothing known-sized in it just
 * reads as a small space with a wide FOV:  3.4 m storeys · 2.1 m doorways on every ground
 * floor · 1.05 m railings · 0.15 m stair risers · 4.4 m parked cars · 2.6 m shipping
 * containers · 1.2 m loading docks · 2.4 m bus shelters · 6.5 m boulevard lamps ·
 * 5.5 m traffic signals · 11 m perimeter wall.
 *
 * Landmarks you navigate by: the WATER TOWER on the west block (48 m to its finial), the
 * giant lit MARQUEE on the north block, the SE ROOF BILLBOARD, the crashed BUS in the south
 * ring, the burn barrels, the plaza OBELISK.
 *
 * COMPOSITION: bright BONE/PAPER ground, dark NIGHT_B walls, GOLD + HOT practicals.
 * Enemies (ACID) can never fail to read against it. Contact shadows and grime are *painted*
 * as flat ink polygons (ART_DIRECTION §2.5) rather than computed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * PERFORMANCE — 4× the area for ~1.4× the triangles.  Measured, not estimated.
 *
 *   1. MERGE, DON'T INSTANCE.  Measured on BUILD 001: `renderer.info` counts an InstancedMesh
 *      as geometry-tris × instanceCount, so instancing saves ZERO rendered triangles — and a
 *      merged bucket is already one draw call for an unlimited number of distinct shapes,
 *      where instancing costs one call per distinct shape.  For this arena (hundreds of
 *      one-off shapes, few exact repeats) merging strictly dominates.  What instancing would
 *      have bought us — memory and build time — is not the binding constraint.
 *   2. THE BINDING CONSTRAINT IS TRIANGLES, and BUILD 001 spent 80% of them on *dressing*,
 *      not on the city: `mass` + `wall` (every building and the perimeter) were 3.6k of
 *      196k.  Going up and out is therefore nearly free; what had to get cheaper was the
 *      small stuff.  Two levers, both measured:
 *      • `PLATE_MAX` — any box whose smallest dimension is under 34 cm is stamped from a
 *        12-triangle plain box instead of the 44-triangle `bevelBox`.  A bevel on a 6 cm
 *        railing is sub-pixel at every distance, so this is free visually and it is a 3.7×
 *        saving on sills, railings, kerbs, risers, brackets, ribs, wires and window panes —
 *        which is most of the triangle budget.
 *      • `LOD_RADIUS` — props past it are stamped body-only (a crate is 44 tris of box plus
 *        396 tris of slats; the slats are invisible at 40 m).
 *   3. SPATIAL SPLIT for frustum culling.  The three heavy buckets are merged per spatial
 *      cell instead of per map, so the prepass and the main pass can reject what is behind
 *      you.  Light buckets stay whole — a cell costs a draw call in up to three passes, and
 *      a 700-triangle bucket is not worth that.  `SPLIT_GRID = 1` disables it entirely.
 *
 *   MEASURED IN CHROME, 2400×1315 drawing buffer, HIGH tier, `renderer.info.autoReset = false`
 *   with a manual `reset()` around one full composited frame (scene prepass + bloom pass +
 *   main pass + shadow map + post), camera parked at twelve authored positions:
 *
 *                       arena objects   draw calls        rendered triangles
 *     BUILD 001              32          106 (fixed)       517 k (fixed, nothing culled)
 *     BUILD 002 grid 3       82          159 – 234         402 k – 692 k
 *     BUILD 002 grid 2  →    52          129 – 159         416 k – 645 k   ← shipped
 *
 *   Grid 2 wins: it costs ~5% more triangles at the median camera and saves 75 draw calls at
 *   the worst one, and draw calls are the tighter budget (220 vs 750 k) with 25 zombies, a
 *   viewmodel and VFX still to come.  Authored: 243 k triangles, 4.5 k collision triangles.
 *   Four times the area, 1.24× the authored geometry, and *fewer* worst-case draw calls than
 *   the budget allows.
 */

import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  Vector3,
  type Material,
  type Texture,
} from 'three';
import { PALETTE, color, hexMix } from '@/art/palette';
import {
  buildOutlineHull, buildSkyDome, makeInkMaterial, markBloom, setSkyMoonDir,
  type InkMaterial,
} from '@/render/materials';
import {
  applyBoxUV,
  bevelBox,
  buildProp,
  disposeProp,
  extrudePolygon,
  faceted,
  inkCone,
  inkCylinder,
  inkRock,
  makeHullGeometry,
  mergeForStatic,
  place,
  rubblePile,
  wobbleQuad,
  type PropBuild,
  type PropKind,
  type Transform,
} from '@/art/shapes';
import { makeWordTexture } from '@/art/letters';
import { makePosterSheet, makeSurfaceLibrary, makeWallAdSheet, type SurfaceTextureSet } from '@/art/textures';
import { Rng } from '@/core/rng';
import type { SurfaceKind } from '@/core/types';
import type { PracticalSpec } from '@/world/lighting';

// ═════════════════════════════════════════════════════════════════════════════
// 0. LAYOUT CONSTANTS — the level design, in metres.
// ═════════════════════════════════════════════════════════════════════════════

/** Half-extent of the walled block. The perimeter wall stands on ±HALF. 35 → 70 in BUILD 002. */
export const ARENA_HALF = 70;

/**
 * The cold practical, matched exactly to the `neon` material bucket so a teal tube and the
 * teal light it throws are the same ink. Blended rather than tokenised: `ELECTRIC` belongs to
 * the player and the UI, so the environment only ever borrows a third of the way toward it.
 */
const COLD_NEON = hexMix(PALETTE.TEAL, PALETTE.ELECTRIC, 0.35);

/**
 * ONE STOREY. Every vertical dimension in the level is a multiple of this, which is why the
 * buildings read as buildings: a 27 m box is meaningless, an *eight storey* box is not.
 * 3.4 m is a real commercial floor-to-floor.
 */
const STOREY = 3.4;

/** Outer face of the building ring — beyond this is the ring boulevard. */
const RING_OUT = 55;
/** Inner face of the building ring — inside this is the plaza. */
const RING_IN = 29;
/** Half-length of the four main blocks along their long axis (sets the radial street mouths). */
const MAIN_HALF = 21;
/** Centre-line of the building ring: every block is centred here on its outward axis. */
const BLOCK_C = (RING_IN + RING_OUT) * 0.5;   // 42
/** Centre-line of the ring boulevard. The long kite lane. */
const RING_LANE = (RING_OUT + ARENA_HALF) * 0.5; // 62.5
/** Centre-line of the four radial streets. The 140 m sightlines run down these. */
const RADIAL = (MAIN_HALF + RING_IN) * 0.5;   // 25

const WALL_H = 11;
const WALL_T = 1.8;

/** Height of the first accessible roof / gantry deck — two storeys, mantle-reachable via stairs. */
const DECK_Y = STOREY * 2;        // 6.8
/** The high catwalk level on the west facade. Four storeys. */
const DECK2_Y = STOREY * 4;       // 13.6

/**
 * The block parapet: a RING of four bars, never a lid. See the block-dressing comment where
 * it is stamped — a solid cap here was the measured cause of the NE roof reading as a violet
 * plane, because it buried the warm roof surface under 1.1 m of `wall`.
 */
const PARAPET_H = 1.1;
const PARAPET_T = 0.62;

/**
 * Below this smallest-dimension a bevel is sub-pixel at any viewing distance, so `boxAt`
 * silently swaps the 44-triangle `bevelBox` for a 12-triangle plain box. See the header.
 */
const PLATE_MAX = 0.34;

/** Props further than this from the plaza centre are stamped body-only (no slats/detail). */
const LOD_RADIUS = 38;

/**
 * Spatial cells per axis for frustum culling (see header §3). 2 → four 70 m quadrant cells.
 * 1 disables the split entirely and restores BUILD 001's one-mesh-per-material behaviour.
 *
 * 3 was tried and measured: it culls ~5% more triangles at the median camera and costs 75
 * more draw calls at the worst one (234 vs 159, budget 220). Draw calls are the scarcer
 * resource here, so 2 ships. The table is in the file header.
 */
const SPLIT_GRID = 2;

interface BlockSpec {
  id: string;
  cx: number;
  cz: number;
  /** Footprint size on X and Z, before yaw. */
  w: number;
  d: number;
  /** Storeys. Height is `storeys * STOREY` — never author a raw height. */
  storeys: number;
  yaw: number;
  kind: 'tower' | 'low' | 'arcade' | 'lot';
}

/**
 * The eight islands. Nothing is axis-perfect — every block carries a degree or two of lean.
 * Heights are deliberately uneven and deliberately TALL: the single strongest cue that a
 * space is big is vertical scale above the player's head, and a box costs 44 triangles
 * whether it is 10 m or 34 m.
 */
const BLOCKS: readonly BlockSpec[] = [
  { id: 'north', cx: 0, cz: -BLOCK_C, w: MAIN_HALF * 2, d: RING_OUT - RING_IN, storeys: 8, yaw: 0.009, kind: 'tower' },
  { id: 'south', cx: 0, cz: BLOCK_C, w: MAIN_HALF * 2, d: RING_OUT - RING_IN, storeys: 6, yaw: -0.011, kind: 'low' },
  { id: 'east', cx: BLOCK_C, cz: 0, w: RING_OUT - RING_IN, d: MAIN_HALF * 2, storeys: 7, yaw: -0.008, kind: 'tower' },
  { id: 'west', cx: -BLOCK_C, cz: 0, w: RING_OUT - RING_IN, d: MAIN_HALF * 2, storeys: 10, yaw: 0.007, kind: 'arcade' },
  // NE is deliberately a two-storey market hall among towers: it is the only roof low enough
  // to be a real parkour destination, and a gap in the skyline is good comic composition.
  { id: 'ne', cx: BLOCK_C, cz: -BLOCK_C, w: 26, d: 26, storeys: 2, yaw: 0.017, kind: 'low' },
  { id: 'se', cx: BLOCK_C, cz: BLOCK_C, w: 26, d: 26, storeys: 9, yaw: -0.014, kind: 'tower' },
  { id: 'nw', cx: -BLOCK_C, cz: -BLOCK_C, w: 26, d: 26, storeys: 7, yaw: 0.013, kind: 'tower' },
  { id: 'sw', cx: -BLOCK_C, cz: BLOCK_C, w: 26, d: 26, storeys: 0, yaw: 0, kind: 'lot' },
];

const blockH = (b: BlockSpec): number => b.storeys * STOREY;

/**
 * Where the player wakes up: plaza south, facing north. The marquee is dead ahead across
 * 60 m of plaza, the water tower is over the left shoulder, the gantry crosses on the right,
 * and the obelisk splits the frame. That is the shot this whole arena was composed for.
 */
const PLAYER_SPAWN = { x: 0, z: 21, yaw: 0 };

/**
 * Director spawn points — 24 of them (BUILD 001 had 20 in a quarter of the area).
 *
 * ALL of them sit in recessed doorways in the perimeter wall at |coord| = 66.5, three metres
 * off the ring-boulevard lane centre, so a spawning horde steps INTO the kite lane instead of
 * standing in it.  Every along-axis value is chosen so the building ring occludes it from the
 * plaza: |along| < 21 hides behind a main block, |along| > 29 hides behind a corner block,
 * and the 21..29 band — which is the open radial street, i.e. the 140 m sightline — is left
 * deliberately empty.  Verified by ray from the plaza centre to each point.
 */
const SPAWN_EDGE = 66.5;
const SPAWN_ALONG: readonly number[] = [-56, -36, -8, 8, 36, 56];
const ENEMY_SPAWNS: readonly [number, number][] = (() => {
  const out: [number, number][] = [];
  for (const a of SPAWN_ALONG) {
    out.push([a, -SPAWN_EDGE]);
    out.push([a, SPAWN_EDGE]);
    out.push([-SPAWN_EDGE, a]);
    out.push([SPAWN_EDGE, a]);
  }
  return out;
})();

/** The depot: a covered through-passage carved out of the west block. LOOP E. */
const DEPOT_Z0 = 3;
const DEPOT_Z1 = 13;
const DEPOT_CEIL = 5.2;

// ═════════════════════════════════════════════════════════════════════════════
// 1. PUBLIC SHAPE
// ═════════════════════════════════════════════════════════════════════════════

export interface ArenaZone {
  /** Stable id — door/zone gating in M5 keys off these. */
  id: string;
  box: Box3;
}

/** A simplified, world-space collision proxy. Never the visual mesh. */
export interface ArenaCollider {
  geometry: BufferGeometry;
  surface: SurfaceKind;
}

export interface Arena {
  group: Group;
  playerSpawn: { position: Vector3; yaw: number };
  enemySpawns: Vector3[];
  bounds: Box3;
  zones: ArenaZone[];
  /** Handed to `collision.ts` to build the octree. Disposed by `dispose()`. */
  colliders: ArenaCollider[];
  /** Handed to `lighting.ts`. */
  practicals: PracticalSpec[];
  /** Draw calls this arena costs (meshes + ink hulls). Watched in the debug panel. */
  drawCalls: number;
  triangles: number;
  dispose(): void;
}

export interface ArenaOptions {
  seed?: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. MATERIAL BUCKETS — the whole value structure of the level lives in this table.
// ═════════════════════════════════════════════════════════════════════════════

type BucketId =
  | 'ground' | 'walk' | 'paint' | 'grime' | 'crack'
  | 'mass' | 'wall' | 'trim' | 'metal' | 'rust' | 'hot' | 'glass' | 'emissive'
  // M1.5 readability pass:
  | 'deck'      // walkable elevated surfaces — WARM, so the high route reads like the ground
  // BUILD 002 colour pass:
  | 'neon'      // cold-lit windows and signs — the hue counterweight to the warm ones
  | 'ad'        // big painted wall advertising, one atlas cell per quad
  | 'bill';     // fly-posted street-level bills, one atlas cell per quad

interface BucketDef {
  color: number;
  shadow?: number;
  rim: number;
  rimStrength?: number;
  rimPower?: number;
  halftone?: number;
  halftoneAngle?: number;
  specular?: number;
  emissive?: number;
  emissiveIntensity?: number;
  /** Ink hull thickness in screen px. 0 = no silhouette pass (flat ground decals). */
  outline: number;
  fog?: number;
  /** Put on the bloom layer. */
  bloom?: boolean;
  /** Procedural surface texture family. UVs are 1 tile/metre everywhere. */
  surface?: 'concrete' | 'metal' | 'wood' | 'brick' | 'facade';
  /** A non-tiling decal atlas instead of a surface family. UVs are authored per quad. */
  atlas?: 'wallAd' | 'poster';
  /** How much of the map to let through, and how much of it becomes screen-tone. */
  mapStrength?: number;
  mapHalftone?: number;
  /**
   * TEXTURE REPEAT — and the unit depends on how the geometry was built. This was authored
   * as "tiles per metre" and that is only true for HALF the arena:
   *
   *   • `flatPoly` / `flatRect` / `flatStroke` (ground, walk, paint, grime, crack) write
   *     WORLD-SPACE uv in metres. For those, `mapScale` really is tiles per metre.
   *   • every `B.stamp(...)` of a proto (mass, wall, trim, metal, rust, hot, glass) inherits
   *     `applyBoxUV(unitBox, 1)`, whose uv runs **-0.5 … +0.5 over the whole face**, because
   *     `place()` scales the positions and leaves the uv alone. For those, `mapScale` is
   *     TILES PER FACE — and the BUILD 001 values of 0.4–1.3 therefore stretched a *fraction*
   *     of one 512 px tile across an entire 42 × 34 m building. Every wall in the city was a
   *     flat colour with a dot screen on it, which is exactly the "empty flat screened
   *     planes" in the BUILD 002 diagnosis. Verified in-engine by tinting `mass` and watching
   *     one smeared tile per facade.
   *
   * The stamped buckets below are now authored in tiles-per-face, chosen so a tile lands at
   * roughly one storey on the buildings and one panel on the props.
   *
   * M1.5: `mass` 6 → 11 and `wall` 3.5 → 8. At 6 tiles across a 42 × 34 m block face a tile
   * was 7 m — two storeys — so from 2 m away the whole frame was one flat blue with a soft
   * blurred stain on it and no course line, pilaster edge or grime boundary anywhere at human
   * reading distance. 11 puts a tile on roughly one FLOOR, which is what the comment above
   * always claimed and what the `facade` surface family was drawn for. Note the direction:
   * more tiles per face is FINER, not coarser — the unit is not tiles per metre.
   */
  mapScale?: number;
  /**
   * Merge this bucket per spatial cell instead of once for the whole map, so the frustum
   * can reject it. Only worth it for the buckets that actually carry triangles — a cell is
   * a draw call in up to three passes (prepass, main, shadow), so a cheap bucket that is
   * split costs more than it ever saves.
   *
   * MEASURED on the finished BUILD 002 arena (authored triangles, mesh + ink hull):
   *   trim 92k · metal 67k · rust 45k  ← 78% of the level, split
   *   emissive 15k · glass 14k · wall 8k · crack 7.5k · grime 5.6k · hot 4.6k · mass 1.4k
   * Splitting `mass`, `glass` and `emissive` as well took the object count from 52 to 118
   * and the worst-case draw calls from 159 to 344, for a triangle saving in the noise.
   * They stay whole.
   */
  split?: boolean;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUILD 002 — THE VALUE LADDER.  This table IS the composition. Everything else in the file
 * decides where a shape goes; this decides where the eye goes.
 *
 * BUILD 001, measured off the drawing buffer at the plaza: 49% of pixels under 0.1 luminance,
 * 10% in the 0.2–0.7 midtone band, 33% over 0.7. The cause is visible in the old table — it
 * used exactly two value groups. Ground was `PAPER` 0.91 and `BONE` 0.73; everything vertical
 * was `NIGHT_B` 0.17, `INK_SOFT` 0.13 and `NIGHT_A` 0.10. There was no third group, so there
 * was no midtone, so there was no staging: a blown white floor and a black void above it.
 *
 * The ladder now runs, and every rung is a deliberate step of about 0.1:
 *
 *    paint     PAPER              0.91   road markings ONLY — thin, tiny area, the sparkle
 *    emissive  SODIUM/GOLD        0.85   lit windows, practicals: the brightest large marks
 *    walk      CONCRETE→BONE 0.45 0.61   sidewalk + plaza deck, one step above the road
 *    ground    CONCRETE           0.52   roadway — the plane the whole game is read against
 *    trim      BONE               0.73   kerbs, sills, cornices: the LINEWORK made of geometry
 *    glass     TEAL               0.44   dark cool windows, so a lit one is an event
 *    mass      SLATE              0.32   every building — the biggest vertical area in frame
 *    wall      NIGHT_B            0.23   perimeter + parapets, the connective violet
 *    grime     INK_SOFT           0.18   PAINTED CAST SHADOW (see below)
 *    crack     INK                0.03   linework. RESERVED. Nothing else may live here.
 *
 * THE PAINTED CAST SHADOW. `InkMaterial` cannot receive a shadow map (see the SHADOWS block in
 * `world/lighting.ts`), and ART §2.5 says AO is painted anyway. `grime` is that paint: the
 * arena already offsets a dark quad under every block, prop, kerb and doorway along -KEY_DIR,
 * which is a cast shadow drawn by hand. BUILD 001 rendered it as near-black dirt; it is now a
 * cool, fully screen-toned INK_SOFT that reads as a SHADOW landing on a 0.52 road. That
 * contact is what makes the city sit on the ground.
 *
 * TWO RULES FROM THE M1 FIX PASS — both still hold, and both are about value structure.
 *
 * 1. **`INK` is never a flat's shadow hue.** INK is the blackest black in the palette and it
 *    belongs to the LINEWORK. Shadow hues are TEAL / NIGHT_B / INK_SOFT — dark, saturated, and
 *    still a colour. BUILD 002 adds a corollary: the SHADOW HUE IS THE COOL HALF OF THE SPLIT.
 *    A warm surface (`ground`, `trim`, `walk`) takes a TEAL shadow, which is what turns the
 *    frame from violet-monochrome into a warm/cool picture without touching a single light.
 * 2. **`rimStrength` is a fill, not the rim.** The drawn rim light is a screen-space pass
 *    (passes/ink.ts) keyed off the silhouette; the material Fresnel can only flood flat faces,
 *    so it is turned down to a grazing-angle tint everywhere.
 *
 * `outline` is in CSS pixels. `READABILITY.PROP_OUTLINE_MAX_PX` (6) caps everything here, so
 * an enemy's 8 px silhouette is always the heaviest line in the frame (ART §9).
 *
 * ── THE SCREEN ANGLES ARE MOD 90, NOT MOD 180 ────────────────────────────────────────────
 * ART §2 says the halftone plate is "rotated 15° per material family", and this table was
 * authored as if the angles ran 0…180. They do not. `halftoneDots()` in `render/materials`
 * screens with `fract()` on a SQUARE lattice, so the pattern is identical every 90°:
 *
 *     angle ≡ angle + 90    ⇒  105° IS 15°,  120° IS 30°,  180° IS 0°
 *
 * which is exactly why a real four-colour press only ever uses 0 / 15 / 45 / 75. With six
 * usable 15° slots and fifteen buckets some sharing is unavoidable, so the rule that is
 * actually enforceable is narrower and is the one that matters to a reader:
 *
 *     TWO FAMILIES THAT TOUCH IN THE FRAME MAY NOT SHARE A PLATE.
 *
 * Two did, and both were pairs that are never seen apart: `glass` sat at 15 inside `mass`
 * at 15 (every window in the city), and `deck` sat at 75 under `metal` at 75 (every catwalk
 * rib and railing). They are moved onto the 7.5° half-grid below — off their neighbour by
 * half a step, which is the largest separation left once the 15° slots are full. The enemy
 * plate had the same fault at a higher cost and is fixed in `world/lighting.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const BUCKETS: Record<BucketId, BucketDef> = {
  // ── GROUND: the readability contract. Mid-value and WARM, with a cool shadow. ──
  // Not paper-white: a blown ground has no headroom for a light pool to land on, and an
  // ACID enemy standing on 0.9 is a dark silhouette one moment and invisible the next.
  ground: { color: PALETTE.CONCRETE, shadow: PALETTE.TEAL, rim: PALETTE.TEAL, rimStrength: 0.14, halftone: 0.6, halftoneAngle: 0, specular: 0.06, outline: 0, surface: 'concrete', mapStrength: 0.8, mapHalftone: 0.45, mapScale: 0.34 },
  walk: { color: hexMix(PALETTE.CONCRETE, PALETTE.BONE, 0.45), shadow: PALETTE.TEAL, rim: PALETTE.SODIUM, rimStrength: 0.12, halftone: 0.5, halftoneAngle: 45, specular: 0.06, outline: 0, surface: 'concrete', mapStrength: 0.6, mapHalftone: 0.4, mapScale: 0.5 },
  paint: { color: PALETTE.PAPER, shadow: PALETTE.BONE, rim: PALETTE.GOLD, rimStrength: 0, halftone: 0.2, halftoneAngle: 75, specular: 0, outline: 0 },
  /**
   * THE PAINTED CAST SHADOW. Screen-toned to the maximum: a shadow in ink is DOTS.
   *
   * MEASURED: this bucket is why the ring boulevard was a void. The perimeter wall alone
   * lays a 5.2 m × 140 m shadow down all four sides and every block lays another
   * (b.w+12)×(b.d+12), so `grime` covers most of the ring road — and at raw `INK_SOFT`
   * (0.18) that road histogrammed 44% under 0.1 and 38% between 0.1 and 0.2.
   *
   * A cast shadow is NOT the darkest thing in a picture; the linework is. A shadow is one
   * or two value steps below the surface it falls on, and it keeps that surface's hue. So
   * this is `CONCRETE` dragged 62% toward `INK_SOFT` — 0.52 ground, 0.31 shadow — which is
   * a legible step, still inside the midtone band, and still leaves the whole sub-0.1
   * range to the ink.
   */
  grime: { color: hexMix(PALETTE.CONCRETE, PALETTE.INK_SOFT, 0.62), shadow: PALETTE.INK_SOFT, rim: PALETTE.TEAL, rimStrength: 0, halftone: 1, halftoneAngle: 15, specular: 0, outline: 0, surface: 'concrete', mapStrength: 0.45, mapHalftone: 0.7, mapScale: 0.4 },
  crack: { color: PALETTE.INK, shadow: PALETTE.INK, rim: PALETTE.INK, rimStrength: 0, halftone: 0, specular: 0, outline: 0 },
  // ── VERTICAL: cool slate mass, one step per element, never one flat slab. ──
  // `surface: 'facade'` at mapScale 1/STOREY puts one texture tile on one FLOOR — string
  // course, pilasters, soot streaks and patched render all land where a building's do.
  /**
   * ─────────────────────────────────────────────────────────────────────────────────────
   * `halftone` 0.85 → 0.58, `shadow` lifted 0.4 → 0.28 toward NIGHT_B.
   *
   * MEASURED, not adjusted by eye. The mask-isolation probe (hide `Ink_mass`, diff the two
   * frames, histogram only the pixels that moved) says what this bucket actually PRINTS at,
   * as opposed to what it is authored at — and `mass` is the biggest vertical area in the
   * game, authored at `SLATE` 0.318, with `lighting.ts` promising a ladder rung of 0.28–0.42:
   *
   *              median   p25    p05    below ENV_VALUE_FLOOR (0.12)
   *   catwalk     0.166  0.142  0.111        10.3%
   *   NE roof     0.146  0.122  0.035        23.7%
   *   plaza       0.142  0.104  0.009        34.4%
   *
   * It prints at HALF its own token, and a tenth to a third of it is under the floor that
   * `READABILITY` reserves for linework. On the ground that is survivable, because the warm
   * road carries the frame. From a high route the facades ARE the frame: hiding this one
   * bucket at the catwalk moved 34.4 points of the 0.1–0.2 band and 24.3 points of midtone.
   * That is the whole of "everything above 6.8 m is a two-value violet poster" — the second
   * half of it, after the parapet lid.
   *
   * The loss is a DOUBLE SCREEN. `pipeline.ts` calls the material's halftone "a quiet
   * underlay" under the post pass's dominant one, and at 0.85 it was not quiet — it was
   * nearly solid, on top of a post screen at 0.9. Forcing `uHtStrength` to 0 alone moves this
   * bucket's median 0.171 → 0.222, so the two screens between them were eating a third of the
   * surface. Turning the *underlay* down is the fix that leaves the frame's dominant screen —
   * the signature of the whole art direction — completely untouched.
   * ─────────────────────────────────────────────────────────────────────────────────────
   */
  mass: { color: PALETTE.SLATE, shadow: hexMix(PALETTE.SLATE, PALETTE.NIGHT_B, 0.28), rim: PALETTE.TEAL, rimStrength: 0.22, rimPower: 2.6, halftone: 0.58, halftoneAngle: 15, specular: 0.12, outline: 6, surface: 'facade', mapStrength: 0.95, mapHalftone: 0.22, mapScale: 11 },
  // The perimeter + the backdrop masses: the second-largest vertical area after `mass`.
  // Pure NIGHT_B over 140 m × 11 m read as a saturated violet billboard, so it is pulled
  // most of the way to SLATE and keeps only enough violet to stay the connective hue.
  // `halftone` 0.9 → 0.62 and the shadow off raw INK_SOFT for the same reason as `mass`
  // above: this is the perimeter, the backdrop masses and now the block parapet rings, i.e.
  // the second-largest vertical area and the entire horizon line from any high route.
  wall: { color: hexMix(PALETTE.SLATE, PALETTE.NIGHT_B, 0.42), shadow: hexMix(PALETTE.INK_SOFT, PALETTE.SLATE, 0.3), rim: PALETTE.TEAL, rimStrength: 0.22, halftone: 0.62, halftoneAngle: 30, specular: 0.1, outline: 5.5, surface: 'concrete', mapStrength: 0.9, mapHalftone: 0.4, mapScale: 8 },
  // Trim is the game's linework made of geometry: it is the BRIGHT edge on every dark mass.
  trim: { color: PALETTE.BONE, shadow: PALETTE.TEAL, rim: PALETTE.PAPER, rimStrength: 0.22, halftone: 0.75, halftoneAngle: 60, specular: 0.25, outline: 4.5, surface: 'concrete', mapStrength: 0.7, mapHalftone: 0.45, mapScale: 2.2, split: true },
  metal: { color: PALETTE.SLATE, shadow: PALETTE.INK_SOFT, rim: PALETTE.TEAL, rimStrength: 0.22, halftone: 0.8, halftoneAngle: 75, specular: 0.7, outline: 4.5, surface: 'metal', mapStrength: 0.85, mapHalftone: 0.4, mapScale: 1.8, split: true },
  /**
   * THE HIGH ROUTE, AND WHY IT NEEDED ITS OWN POT OF INK.
   *
   * At ground level the BUILD 002 colour pass genuinely worked — 30.6% warm vs 62% cool
   * chromatic pixels, mean saturation 0.66. **Above 6.8 m it did not.** Standing on the NE
   * market roof, a shipped parkour destination on LOOP D, the deck, the facade opposite, the
   * parapet and the sky were all the same blue-violet: not one warm pixel in frame, which is
   * exactly the monochrome the human complained about in BUILD 001, unchanged for the entire
   * vertical half of the map. The cause was structural — every walkable deck was drawn from
   * the cool `metal` family, so the plane you stand on up there was the same hue as the walls,
   * where at ground level it is warm `CONCRETE` against cool `SLATE`.
   *
   * This is that ground-level contract, lifted. Warm body, cool TEAL shadow, one value step
   * above `walk` because it is a lit metal surface rather than a pavement.
   */
  // `halftoneAngle` 75 → 7.5: `deck` is never seen without `metal` (75) — the grating ribs
  // are laid ON the slab and the railings stand in it. See THE SCREEN ANGLES note above.
  deck: { color: hexMix(PALETTE.CONCRETE, PALETTE.BONE, 0.3), shadow: PALETTE.TEAL, rim: PALETTE.SODIUM, rimStrength: 0.2, halftone: 0.7, halftoneAngle: 7.5, specular: 0.4, outline: 4.5, surface: 'metal', mapStrength: 0.8, mapHalftone: 0.45, mapScale: 2.2, split: true },
  rust: { color: PALETTE.RUST, shadow: PALETTE.INK_SOFT, rim: PALETTE.SODIUM, rimStrength: 0.25, halftone: 0.85, halftoneAngle: 45, specular: 0.3, outline: 4.5, surface: 'wood', mapStrength: 0.8, mapHalftone: 0.45, mapScale: 2.0, split: true },
  /**
   * THE RESERVED-CHANNEL FIX. This bucket was `HOT` and it carried three 12 m shipping
   * containers and every shop awning in the plaza — a lot of enemy-pink on large surfaces,
   * which ART §9 forbids outright and which the previous agent flagged in COLOUR NOTE 7.
   * It is `SODIUM` now: the same job (the loud warm accent that stops the street being all
   * one temperature) with none of the readability cost. The id is unchanged so every call
   * site still resolves; only the ink in the pot changed.
   */
  hot: { color: PALETTE.SODIUM, shadow: PALETTE.RUST, rim: PALETTE.GOLD, rimStrength: 0.25, halftone: 0.8, halftoneAngle: 30, specular: 0.45, outline: 5, surface: 'metal', mapStrength: 0.5, mapHalftone: 0.35, mapScale: 1.5 },
  // Dark cool glass, so a LIT window is an event rather than the default state of a wall.
  // `halftoneAngle` 15 → 67.5: every pane is set INTO `mass` (15), so they shared a plate and
  // a window's screen-tone continued straight through the wall around it.
  glass: { color: PALETTE.TEAL, shadow: PALETTE.NIGHT_A, rim: PALETTE.ELECTRIC, rimStrength: 0.25, halftone: 0.35, halftoneAngle: 67.5, specular: 0.9, outline: 3.5 },
  emissive: { color: PALETTE.SODIUM, shadow: PALETTE.SODIUM, rim: PALETTE.PAPER, rimStrength: 0.3, halftone: 0, specular: 0, emissive: PALETTE.SODIUM, emissiveIntensity: 0.95, outline: 0, fog: 0.3, bloom: true },
  /**
   * THE HUE COUNTERWEIGHT. BUILD 001's frame was 30% warm-gold and 39% violet and nothing
   * else — one lit-window colour for a whole city. Roughly one lit window in four is now
   * cold instead, which does two things at once: it puts the third hue of the split on the
   * buildings, and it makes the warm ones read as warm. ELECTRIC is the player's colour, so
   * this leans on TEAL and only borrows a third of the way toward it.
   */
  neon: { color: hexMix(PALETTE.TEAL, PALETTE.ELECTRIC, 0.35), shadow: PALETTE.TEAL, rim: PALETTE.PAPER, rimStrength: 0.3, halftone: 0, specular: 0, emissive: hexMix(PALETTE.TEAL, PALETTE.ELECTRIC, 0.35), emissiveIntensity: 0.9, outline: 0, fog: 0.3, bloom: true },
  /**
   * PAINTED WALL ADVERTISING. `mapStrength: 1` — for a decal the atlas IS the colour, so the
   * flat under it is PAPER (a multiply by 1.0 leaves the painting alone). One material, one
   * draw call, an unlimited number of visibly different signs.
   */
  ad: { color: PALETTE.PAPER, shadow: PALETTE.NIGHT_B, rim: PALETTE.SODIUM, rimStrength: 0.12, halftone: 0.35, halftoneAngle: 60, specular: 0.05, outline: 0, atlas: 'wallAd', mapStrength: 1, mapHalftone: 0.25, mapScale: 1 },
  bill: { color: PALETTE.PAPER, shadow: PALETTE.NIGHT_B, rim: PALETTE.SODIUM, rimStrength: 0.12, halftone: 0.4, halftoneAngle: 30, specular: 0.05, outline: 0, atlas: 'poster', mapStrength: 1, mapHalftone: 0.3, mapScale: 1 },
};

// ═════════════════════════════════════════════════════════════════════════════
// 3. GEOMETRY HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/** A cached source geometry plus its welded hull, so a shape is stamped many times cheaply. */
interface Proto {
  geo: BufferGeometry;
  hull: BufferGeometry;
}

function proto(geo: BufferGeometry): Proto {
  return { geo, hull: makeHullGeometry(geo) };
}

function disposeProto(p: Proto): void {
  p.geo.dispose();
  p.hull.dispose();
}

/**
 * Fan-triangulate a closed polygon given as flat x,z pairs, lying at height `y`.
 * Points must run ANTI-CLOCKWISE in XZ (increasing atan2(z, x)); the fan is emitted in
 * reverse so the face ends up pointing +Y. Used for every painted ground element.
 */
function flatPoly(pts: readonly number[], y: number): BufferGeometry {
  const n = pts.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i * 2] as number;
    cz += pts[i * 2 + 1] as number;
  }
  cx /= n;
  cz /= n;
  const verts: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 2] as number;
    const az = pts[i * 2 + 1] as number;
    const bx = pts[j * 2] as number;
    const bz = pts[j * 2 + 1] as number;
    verts.push(cx, y, cz, bx, y, bz, ax, y, az);
    // World-space UVs: one texture tile per metre, exactly like `applyBoxUV`, so a
    // painted marking and a wall share the same grain scale.
    uvs.push(cx, cz, bx, bz, ax, az);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Axis-ish rectangle on the ground, with optional yaw. */
function flatRect(cx: number, cz: number, w: number, d: number, y: number, yaw = 0): BufferGeometry {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hw = w * 0.5;
  const hd = d * 0.5;
  const p: number[] = [];
  const corners: [number, number][] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  for (const [x, z] of corners) p.push(cx + x * c - z * s, cz + x * s + z * c);
  return flatPoly(p, y);
}

/**
 * A stroke on the ground from A to B — road paint, crack, wire shadow.
 * Corner order is anti-clockwise in XZ (see `flatPoly`); the obvious ordering builds the
 * quad clockwise and every marking in the level silently faces the floor.
 */
function flatStroke(x0: number, z0: number, x1: number, z1: number, w: number, y: number): BufferGeometry {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz) || 1e-4;
  const nx = (-dz / len) * w * 0.5;
  const nz = (dx / len) * w * 0.5;
  return flatPoly([x0 - nx, z0 - nz, x1 - nx, z1 - nz, x1 + nx, z1 + nz, x0 + nx, z0 + nz], y);
}

/** Irregular n-gon outline, for plaza inlays and light pools. */
function ngon(cx: number, cz: number, r: number, n: number, jitter: number, rng: Rng): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + rng.spread(jitter));
    out.push(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr);
  }
  return out;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WALL DRESSING — a pasted decal whose UVs address ONE CELL of an N×N atlas.
 *
 * This is the whole trick behind "dress the empty surfaces" costing nothing: the variety
 * lives in the quads, not in the textures. Sixteen different fly-posted bills and four
 * different painted advertisements are ONE texture, ONE material and ONE draw call each,
 * merged into the same buffers as everything else in their bucket.
 *
 * `wobbleQuad` gives a hand-torn outline and uv 0..1; this rewrites the uv into the cell.
 * A 0.6% inset stops a mip level from bleeding a neighbouring poster into the edge.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
function decalQuad(w: number, h: number, seed: number, cell: number, grid: number): BufferGeometry {
  const g = wobbleQuad(w, h, seed, 0.022);
  const uv = g.getAttribute('uv') as Float32BufferAttribute;
  const s = 1 / grid;
  const cx = ((cell % grid) + grid) % grid;
  const cy = (Math.floor(cell / grid) % grid + grid) % grid;
  const inset = 0.006;
  for (let i = 0; i < uv.count; i++) {
    const u = inset + uv.getX(i) * (1 - inset * 2);
    const v = inset + uv.getY(i) * (1 - inset * 2);
    uv.setXY(i, (cx + u) * s, (cy + v) * s);
  }
  uv.needsUpdate = true;
  return g;
}

/** A hand-inked crack: a branching, tapering polyline of thin strokes. */
function inkCrack(cx: number, cz: number, len: number, rng: Rng, y: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const walk = (x: number, z: number, ang: number, remaining: number, width: number, depth: number): void => {
    let px = x;
    let pz = z;
    let a = ang;
    let left = remaining;
    let w = width;
    while (left > 0.15 && w > 0.012) {
      const step = Math.min(left, rng.range(0.35, 0.9));
      a += rng.spread(0.7);
      const nx = px + Math.cos(a) * step;
      const nz = pz + Math.sin(a) * step;
      out.push(flatStroke(px, pz, nx, nz, w, y));
      if (depth < 2 && rng.bool(0.22)) {
        walk(nx, nz, a + rng.spread(1.6) + (rng.bool() ? 0.8 : -0.8), left * 0.45, w * 0.6, depth + 1);
      }
      px = nx;
      pz = nz;
      left -= step;
      w *= 0.88;
    }
  };
  const arms = rng.int(2, 4);
  for (let i = 0; i < arms; i++) {
    walk(cx, cz, (i / arms) * Math.PI * 2 + rng.spread(0.9), len, rng.range(0.05, 0.09), 0);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE BUILDER
// ═════════════════════════════════════════════════════════════════════════════

/** One merge target: a (bucket, spatial cell) pair. */
interface Cell {
  geos: BufferGeometry[];
  hulls: BufferGeometry[];
}

interface Bucket {
  def: BucketDef;
  cells: Map<number, Cell>;
}

/** Cell size along one axis. Cells cover [-ARENA_HALF, ARENA_HALF]; anything outside clamps in. */
const CELL_SIZE = (ARENA_HALF * 2) / SPLIT_GRID;

function cellKey(x: number, z: number): number {
  const i = Math.min(SPLIT_GRID - 1, Math.max(0, Math.floor((x + ARENA_HALF) / CELL_SIZE)));
  const j = Math.min(SPLIT_GRID - 1, Math.max(0, Math.floor((z + ARENA_HALF) / CELL_SIZE)));
  return j * SPLIT_GRID + i;
}

const _centre = new Vector3();

class ArenaBuilder {
  readonly buckets = new Map<BucketId, Bucket>();
  readonly colliders: ArenaCollider[] = [];
  private readonly colliderGeos = new Map<SurfaceKind, BufferGeometry[]>();

  bucket(id: BucketId): Bucket {
    let b = this.buckets.get(id);
    if (!b) {
      b = { def: BUCKETS[id], cells: new Map() };
      this.buckets.set(id, b);
    }
    return b;
  }

  private cell(b: Bucket, x: number, z: number): Cell {
    const key = b.def.split && SPLIT_GRID > 1 ? cellKey(x, z) : -1;
    let c = b.cells.get(key);
    if (!c) {
      c = { geos: [], hulls: [] };
      b.cells.set(key, c);
    }
    return c;
  }

  /**
   * Add a world-space geometry. `hull` is the welded silhouette shell, if the bucket inks.
   * The cell is taken from the geometry's own bounding sphere unless the caller knows better
   * (`at`), which is both cheaper and exact for stamped protos.
   */
  add(id: BucketId, geo: BufferGeometry, hull?: BufferGeometry, at?: [number, number]): void {
    const b = this.bucket(id);
    let cx: number;
    let cz: number;
    if (at) {
      cx = at[0];
      cz = at[1];
    } else {
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      _centre.copy(geo.boundingSphere?.center ?? _centre.set(0, 0, 0));
      cx = _centre.x;
      cz = _centre.z;
    }
    const c = this.cell(b, cx, cz);
    c.geos.push(geo);
    if (b.def.outline > 0) c.hulls.push(hull ?? makeHullGeometry(geo));
  }

  /** Stamp a cached proto with a transform. The cheap path — use it for anything repeated. */
  stamp(id: BucketId, p: Proto, t: Transform): void {
    const b = this.bucket(id);
    const c = this.cell(b, t.x ?? 0, t.z ?? 0);
    c.geos.push(place(p.geo.clone(), t));
    if (b.def.outline > 0) c.hulls.push(place(p.hull.clone(), t));
  }

  /** Simplified collision proxy. Boxes only — the capsule solver loves boxes. */
  collideBox(w: number, h: number, d: number, x: number, y: number, z: number, yaw: number, surface: SurfaceKind): void {
    const g = place(new BoxGeometry(w, h, d), { ry: yaw, x, y, z });
    let list = this.colliderGeos.get(surface);
    if (!list) { list = []; this.colliderGeos.set(surface, list); }
    list.push(g);
  }

  /** A sloped proxy (stairs, ramps) — a rotated slab under the visual steps, so no jitter. */
  collideRamp(
    x0: number, z0: number, y0: number, x1: number, z1: number, y1: number,
    width: number, surface: SurfaceKind,
  ): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const dy = y1 - y0;
    const run = Math.hypot(dx, dz);
    const len = Math.hypot(run, dy);
    const yaw = Math.atan2(dx, dz);
    const pitch = -Math.atan2(dy, run);
    const g = new BoxGeometry(width, 0.4, len);
    // Local frame: length along +Z, then pitch about X, then yaw about Y.
    place(g, { y: -0.2 });
    place(g, { rx: pitch });
    place(g, { ry: yaw, x: (x0 + x1) * 0.5, y: (y0 + y1) * 0.5, z: (z0 + z1) * 0.5 });
    let list = this.colliderGeos.get(surface);
    if (!list) { list = []; this.colliderGeos.set(surface, list); }
    list.push(g);
  }

  finishColliders(): ArenaCollider[] {
    for (const [surface, list] of this.colliderGeos) {
      const merged = mergeForStatic(list);
      for (const g of list) g.dispose();
      this.colliders.push({ geometry: merged, surface });
    }
    this.colliderGeos.clear();
    return this.colliders;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. BUILD
// ═════════════════════════════════════════════════════════════════════════════

export function buildArena(opts: ArenaOptions = {}): Arena {
  const rng = new Rng(opts.seed ?? 0xc0b1c5);
  const B = new ArenaBuilder();
  const group = new Group();
  group.name = 'arena';

  const practicals: PracticalSpec[] = [];
  const zones: ArenaZone[] = [];
  const extraMaterials: Material[] = [];
  const extraMeshes: Mesh[] = [];
  /**
   * Word/poster geometry, batched per unique texture. Declared here rather than next to
   * `addWordLater` (§6.7) because §6.5 stencils a word onto a shipping container, and a
   * hoisted function reaching a `const` declared later would hit the temporal dead zone.
   */
  const posterQuads = new Map<string, { tex: Texture; aspect: number; geos: BufferGeometry[]; emissive: boolean }>();

  // ── Protos: built once, stamped thousands of times. ────────────────────────
  const P = {
    box: proto(bevelBox(1, 1, 1, 0.02, 3)),
    boxS: proto(bevelBox(1, 1, 1, 0.11, 5)),
    /**
     * 12 triangles instead of 44. `boxAt` picks this automatically for anything whose
     * smallest dimension is under `PLATE_MAX` — see the header. This one proto is where
     * most of the BUILD 002 triangle budget came from.
     */
    plate: proto(applyBoxUV(faceted(new BoxGeometry(1, 1, 1)), 1)),
    cyl: proto(inkCylinder(0.5, 1, 9, { seed: 2 })),
    cyl6: proto(inkCylinder(0.5, 1, 6, { seed: 3 })),
    cyl12: proto(inkCylinder(0.5, 1, 12, { seed: 4 })),
    cone: proto(inkCone(0.5, 1, 9, 6)),
    rock: proto(inkRock(0.5, 11, 6)),
    // Jersey barrier profile (X = width, Y = height), extruded along Z.
    barrier: proto(
      extrudePolygon([-0.33, 0, 0.33, 0, 0.2, 0.24, 0.12, 0.78, 0.16, 0.9, -0.16, 0.9, -0.12, 0.78, -0.2, 0.24], 2.3),
    ),
  };
  const protos: Proto[] = Object.values(P);

  const boxAt = (
    id: BucketId, w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0, small = false,
  ): void => {
    const p = Math.min(w, h, d) < PLATE_MAX ? P.plate : (small ? P.boxS : P.box);
    B.stamp(id, p, { sx: w, sy: h, sz: d, ry: yaw, x, y, z });
  };
  const cylAt = (
    id: BucketId, r: number, h: number, x: number, y: number, z: number, t: Transform = {},
  ): void => {
    B.stamp(id, r < 0.2 ? P.cyl6 : P.cyl, { sx: r * 2, sy: h, sz: r * 2, x, y, z, ...t });
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.1 THE PROP KIT — built once, stamped everywhere. Density is what separates
  //     AAA from prototype, so nothing below is placed on a grid or at an axis angle.
  // ═══════════════════════════════════════════════════════════════════════════

  const propBucket: Record<PropKind, BucketId> = {
    barrel: 'metal', crate: 'rust', dumpster: 'metal', fence: 'rust',
    streetLamp: 'metal', brokenWall: 'trim', rubble: 'trim', pipe: 'metal', plank: 'rust',
  };
  const accentBucket: Record<PropKind, BucketId> = {
    barrel: 'rust', crate: 'metal', dumpster: 'rust', fence: 'metal',
    streetLamp: 'trim', brokenWall: 'metal', rubble: 'trim', pipe: 'trim', plank: 'rust',
  };
  const propRadius: Record<PropKind, number> = {
    barrel: 0.34, crate: 0.5, dumpster: 1.1, fence: 1.05,
    streetLamp: 0.24, brokenWall: 1.6, rubble: 0.9, pipe: 1.5, plank: 1.0,
  };

  /**
   * Footprint reservations: [cx, cz, halfW, halfD]. Per-axis, so props still reach into
   * the streets but never land on a spawn point, a lane or the player's boots.
   */
  const occupied: [number, number, number, number][] = [];
  for (const b of BLOCKS) occupied.push([b.cx, b.cz, b.w * 0.5 + 2.6, b.d * 0.5 + 2.6]);
  occupied.push([0, 0, 13, 13]);                 // the monument dais
  occupied.push([10, RING_LANE - 2, 6, 9]);      // the crashed bus
  occupied.push([27.5, -2, 4, 26]);              // under the east gantry
  occupied.push([58, -38, 4, 14]);               // the stair up to the NE roof
  occupied.push([PLAYER_SPAWN.x, PLAYER_SPAWN.z, 4.0, 4.0]);
  for (const [sx, sz] of ENEMY_SPAWNS) occupied.push([sx, sz, 2.4, 2.4]);

  /**
   * The four 140 m sightlines are the whole point of the rescale, so random scatter is not
   * allowed to stand in them: a 4 m keep-out either side of each centre-line. Authored
   * street furniture (kerb lamps, parked cars, poles) deliberately IGNORES this — a row of
   * known-size objects lining a vista is what makes it readable, whereas a barrel dropped in
   * the middle of it just breaks the shot.
   */
  const SIGHT_KEEP = 4.0;
  const onSightline = (x: number, z: number, pad: number): boolean =>
    Math.abs(Math.abs(x) - RADIAL) < SIGHT_KEEP + pad || Math.abs(Math.abs(z) - RADIAL) < SIGHT_KEEP + pad;

  const free = (x: number, z: number, pad: number, respectSightlines = true): boolean => {
    if (Math.abs(x) > ARENA_HALF - 3.0 || Math.abs(z) > ARENA_HALF - 3.0) return false;
    if (respectSightlines && onSightline(x, z, pad)) return false;
    for (const [ox, oz, hw, hd] of occupied) {
      if (Math.abs(x - ox) < hw + pad && Math.abs(z - oz) < hd + pad) return false;
    }
    return true;
  };
  const reserve = (x: number, z: number, hw: number, hd: number): void => {
    occupied.push([x, z, hw, hd]);
  };

  const VARIANTS = 4;
  const library = new Map<string, { build: PropBuild; body: Proto; accent?: Proto; glow?: BufferGeometry }>();
  const propOf = (kind: PropKind, variant: number) => {
    const key = `${kind}:${variant}`;
    let e = library.get(key);
    if (!e) {
      const build = buildProp(kind, 13 + variant * 17 + kind.length * 3, 1);
      e = {
        build,
        body: proto(build.body),
        accent: build.accent ? proto(build.accent) : undefined,
        glow: build.glow,
      };
      library.set(key, e);
    }
    return e;
  };

  /**
   * Place a prop. Past `LOD_RADIUS` from the plaza centre the accent geometry (a crate's
   * slats are 396 of its 440 triangles) is dropped — at 40 m it is a silhouette and nothing
   * else. This is the single biggest saving in the dressing pass and it is invisible.
   */
  const placeProp = (kind: PropKind, x: number, z: number, yaw: number, y = 0, variant = -1): void => {
    const v = variant >= 0 ? variant : rng.int(0, VARIANTS);
    const e = propOf(kind, v);
    const t: Transform = { ry: yaw, x, y, z };
    const far = Math.hypot(x, z) > LOD_RADIUS;
    B.stamp(propBucket[kind], e.body, t);
    if (e.accent && !far) B.stamp(accentBucket[kind], e.accent, t);
    if (e.glow) {
      const g = place(e.glow.clone(), t);
      B.add('emissive', g, undefined, [x, z]);
    }
    const r = propRadius[kind];
    reserve(x, z, r * 0.85, r * 0.85);
    // Contact shadow, offset along the key light. Painted, not computed.
    B.add('grime', flatRect(x + r * 0.55, z - r * 0.4, r * 2.6, r * 2.6, 0.02, yaw), undefined, [x, z]);
    if (kind === 'rubble' || kind === 'plank') return; // walk-over clutter, no collider
    const h = kind === 'streetLamp' ? 4.4 : kind === 'dumpster' ? 1.4 : kind === 'fence' ? 1.7 : kind === 'brokenWall' ? 2.2 : 1.0;
    const w = kind === 'dumpster' ? 2.1 : kind === 'fence' ? 2.1 : kind === 'brokenWall' ? 3.1 : kind === 'pipe' ? 3.0 : r * 2;
    const d = kind === 'dumpster' ? 1.15 : kind === 'fence' ? 0.3 : kind === 'brokenWall' ? 0.4 : kind === 'pipe' ? 0.3 : r * 2;
    B.collideBox(w, h, d, x, h * 0.5 + y, z, yaw, kind === 'crate' || kind === 'fence' ? 'wood' : kind === 'brokenWall' ? 'concrete' : 'metal');
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.2 GROUND — bright, and never empty: paint, grime, cracks, sidewalks.
  // ═══════════════════════════════════════════════════════════════════════════

  B.add('ground', flatRect(0, 0, ARENA_HALF * 2 + 40, ARENA_HALF * 2 + 40, 0));
  B.collideBox(ARENA_HALF * 2 + 50, 2, ARENA_HALF * 2 + 50, 0, -1, 0, 0, 'concrete');

  // The plaza reads brightest — the eye goes to the centre, and the horde reads dark on it.
  B.add('walk', flatPoly(ngon(0, 0, 27.2, 18, 0.025, rng), 0.05));
  B.add('paint', flatPoly(ngon(0, 0, 27.8, 18, 0.025, rng), 0.035));

  // Ring boulevard centre line + lane dashes, all the way round. Cheap, and it says "city".
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI * 0.5;
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (let t = -ARENA_HALF + 4; t < ARENA_HALF - 4; t += 6.0) {
      const x = RING_LANE * c - t * s;
      const z = RING_LANE * s + t * c;
      const x2 = RING_LANE * c - (t + 3.4) * s;
      const z2 = RING_LANE * s + (t + 3.4) * c;
      if (Math.abs(x) > ARENA_HALF - 3 || Math.abs(z) > ARENA_HALF - 3) continue;
      B.add('paint', flatStroke(x, z, x2, z2, 0.2, 0.02));
    }
  }

  /**
   * THE FOUR SIGHTLINE STREETS, painted end to end. A dashed centre line running 140 m into
   * the distance is the cheapest and strongest depth cue in the whole level: perspective
   * convergence on a known-width marking is exactly how a reader measures a street.
   */
  for (const s of [-1, 1]) {
    for (let t = -ARENA_HALF + 4; t < ARENA_HALF - 4; t += 6.0) {
      B.add('paint', flatStroke(s * RADIAL, t, s * RADIAL, t + 3.4, 0.2, 0.021));
      B.add('paint', flatStroke(t, s * RADIAL, t + 3.4, s * RADIAL, 0.2, 0.021));
    }
  }

  // Crosswalks where the eight radial streets meet the plaza.
  for (const s of [-1, 1]) {
    for (const along of [-RADIAL, RADIAL]) {
      for (const [cx, cz, ax, az] of [
        [along, s * RING_IN, 1, 0],
        [s * RING_IN, along, 0, 1],
      ] as [number, number, number, number][]) {
        for (let k = -3; k <= 3; k++) {
          const ox = ax * k * 0.8;
          const oz = az * k * 0.8;
          B.add('paint', flatStroke(
            cx + ox - az * 2.2, cz + oz - ax * 2.2,
            cx + ox + az * 2.2, cz + oz + ax * 2.2,
            0.34, 0.022,
          ));
        }
      }
    }
  }

  // The plaza motif is INKED, not painted: a pale mark on the pale plaza inlay is
  // invisible, and the eye needs a dark graphic under the landmark to anchor the shot.
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 + 0.11;
    B.add('crack', flatStroke(
      Math.cos(a) * 11.5, Math.sin(a) * 11.5,
      Math.cos(a) * (22.0 + rng.spread(2.2)), Math.sin(a) * (22.0 + rng.spread(2.2)),
      0.24, 0.058,
    ));
  }
  // Concentric ink rings around the dais, drawn as short chords so they wobble.
  for (const [radius, w] of [[12.8, 0.2], [22.8, 0.3]] as [number, number][]) {
    const seg = 60;
    for (let i = 0; i < seg; i++) {
      if (i % 7 === 3) continue; // worn away in places
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1.02) / seg) * Math.PI * 2;
      const r0 = radius * (1 + rng.spread(0.012));
      B.add('crack', flatStroke(
        Math.cos(a0) * r0, Math.sin(a0) * r0,
        Math.cos(a1) * r0, Math.sin(a1) * r0, w, 0.056,
      ));
    }
  }
  // A halftone wash filling the inner ring — screen-tone on the page, not a shadow.
  B.add('grime', flatPoly(ngon(0, 0, 11.8, 16, 0.02, rng), 0.052));

  // Grime + cracks. Scattered wherever the plaza and the ring are open.
  for (let i = 0; i < 54; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(8, 66);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (Math.abs(x) > ARENA_HALF - 3 || Math.abs(z) > ARENA_HALF - 3) continue;
    B.add('grime', flatPoly(ngon(x, z, rng.range(1.6, 5.0), 9, 0.32, rng), 0.014));
  }
  for (let i = 0; i < 34; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(6, 64);
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    for (const g of inkCrack(cx, cz, rng.range(1.8, 5.0), rng, 0.018)) {
      B.add('crack', g, undefined, [cx, cz]);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.3 PERIMETER — the walled block, its spawn doorways, and the backdrop masses.
  // ═══════════════════════════════════════════════════════════════════════════

  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI * 0.5;
    const nx = Math.cos(a);
    const nz = Math.sin(a);
    const segs = 9;
    for (let s = 0; s < segs; s++) {
      const t = (s + 0.5) / segs;
      const along = (t - 0.5) * (ARENA_HALF * 2 + WALL_T);
      const segLen = ((ARENA_HALF * 2 + WALL_T) / segs) * 1.005;
      const h = WALL_H * rng.range(0.88, 1.08);
      const x = ARENA_HALF * nx - along * nz;
      const z = ARENA_HALF * nz + along * nx;
      // `place({ry})` maps local +Z onto (sin yaw, cos yaw) — i.e. onto the wall's OUTWARD
      // NORMAL here. So the segment's LENGTH is its local X and its thickness is local Z.
      // Getting this backwards turns the perimeter into a row of fins with 28 m gaps
      // between them, and the arena stops being enclosed at all.
      const yaw = Math.atan2(nx, nz) + rng.spread(0.006);
      boxAt('wall', segLen, h, WALL_T, x, h * 0.5, z, yaw);
      // Coping strip so the top edge catches the key light as a bright line.
      boxAt('trim', segLen, 0.3, WALL_T * 1.22, x, h + 0.12, z, yaw, true);
      // Pilasters every ~3 m: vertical rhythm on a 140 m wall, and a scale ruler. 0.32 m
      // wide on purpose — that is under `PLATE_MAX`, so 180 of them cost 12 triangles each.
      for (let k = -2; k <= 2; k++) {
        const px = x - (k * segLen / 5) * nz;
        const pz = z + (k * segLen / 5) * nx;
        boxAt('trim', 0.32, h * 0.94, WALL_T + 0.6, px, h * 0.47, pz, yaw, true);
      }
      B.collideBox(segLen, WALL_H * 2.6, WALL_T + 0.4, x, WALL_H * 1.3, z, yaw, 'concrete');
      // Painted contact shadow at the foot of the wall.
      B.add('grime', flatRect(x - nx * 1.9, z - nz * 1.9, segLen * 0.96, WALL_T + 3.4, 0.016, yaw), undefined, [x, z]);
    }
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════
   * WALL DRESSING — the answer to "large wall faces are empty flat screened planes".
   *
   * `pasteAd` hangs a painted advertisement; `pasteBills` glues a cluster of fly-posted
   * street bills. Both are two-triangle quads sitting a few centimetres proud of a wall,
   * merged into their bucket, so the ENTIRE dressing pass in this level costs 2 draw calls
   * and under 500 triangles. That ratio is the reason this is where production value is
   * cheapest to buy: a wall does not need more geometry, it needs to look INHABITED.
   *
   * `yaw` is the direction the decal FACES (`place({ry})` maps local +Z to (sin, cos)).
   * ═════════════════════════════════════════════════════════════════════════════════════
   */
  const pasteAd = (
    x: number, y: number, z: number, yaw: number, w: number, h: number, cell: number, seed: number,
  ): void => {
    const q = decalQuad(w, h, seed, cell, 2);
    place(q, { ry: yaw, x, y, z });
    B.add('ad', q, undefined, [x, z]);
  };

  const pasteBills = (
    x: number, y: number, z: number, yaw: number, n: number, seed: number, spread = 2.4,
  ): void => {
    const r = new Rng(seed);
    const tx = Math.cos(yaw);
    const tz = -Math.sin(yaw);
    for (let i = 0; i < n; i++) {
      // A real fly-poster wall is overlapping and crooked. Perfectly spaced bills read as
      // wallpaper; a stack that is 20% too close together reads as a city.
      const u = (i - (n - 1) * 0.5) * (spread / Math.max(1, n)) + r.spread(0.18);
      const s = r.range(0.62, 1.0);
      const q = decalQuad(0.86 * s, 1.18 * s, seed + i * 13, r.int(0, 16), 4);
      place(q, { rz: r.spread(0.09), ry: yaw, x: x + tx * u, y: y + r.spread(0.24), z: z + tz * u });
      B.add('bill', q, undefined, [x, z]);
    }
  };

  /**
   * THE PERIMETER'S INNER FACE is the single largest empty surface in the level: four 140 m
   * runs of blank 11 m wall that the player is looking at from the ring boulevard for most
   * of a lap. Three big painted ads and a rhythm of poster clusters per side.
   */
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI * 0.5;
    const nx = Math.cos(a);
    const nz = Math.sin(a);
    const faceIn = ARENA_HALF - WALL_T * 0.5 - 0.12;
    const yaw = Math.atan2(-nx, -nz);   // facing INWARD, into the arena
    for (let k = 0; k < 3; k++) {
      const along = (k - 1) * 40 + rng.spread(4);
      pasteAd(
        faceIn * nx - along * nz, 6.2 + rng.spread(0.5), faceIn * nz + along * nx,
        yaw, 9.5, 6.4, (i + k) % 4, 300 + i * 17 + k,
      );
    }
    for (let k = 0; k < 7; k++) {
      const along = (k - 3) * 17 + rng.spread(3);
      pasteBills(
        faceIn * nx - along * nz, 1.85, faceIn * nz + along * nx,
        yaw, 2 + (k % 3), 900 + i * 31 + k, 2.8,
      );
    }
  }

  /**
   * SPAWN DOORWAYS. Every director spawn point is a real 2.4 m collapsed doorway recessed
   * into the wall — so the horde comes out of *something*, and so the wall carries a
   * repeating 2.4 m human-scale reference all the way round a 140 m span.
   */
  for (const [sx, sz] of ENEMY_SPAWNS) {
    const onX = Math.abs(sx) > Math.abs(sz);
    const sign = onX ? Math.sign(sx) : Math.sign(sz);
    const yaw = onX ? Math.PI * 0.5 : 0;
    const wx = onX ? sign * (ARENA_HALF - WALL_T * 0.5) : sx;
    const wz = onX ? sz : sign * (ARENA_HALF - WALL_T * 0.5);
    // The dark recess itself — a grime slab set back into the wall face.
    boxAt('grime', onX ? 1.0 : 3.0, 2.6, onX ? 3.0 : 1.0, wx, 1.3, wz, 0, true);
    // Frame: two jambs and a lintel, 2.4 m clear. The reference object.
    for (const j of [-1, 1]) {
      boxAt('trim', 0.36, 2.7, 0.36, wx - (onX ? 0 : j * 1.55), 1.35, wz - (onX ? j * 1.55 : 0), yaw, true);
    }
    boxAt('trim', onX ? 0.5 : 3.7, 0.42, onX ? 3.7 : 0.5, wx, 2.8, wz, yaw, true);
    // A hanging broken door leaf, so the recess is not a clean rectangle.
    boxAt('rust', onX ? 0.14 : 1.2, 2.2, onX ? 1.2 : 0.14, wx - (onX ? sign * 0.4 : 0.5), 1.2, wz - (onX ? 0.5 : sign * 0.4), yaw + rng.spread(0.22), true);
    B.add('grime', flatRect(wx - (onX ? sign * 2.2 : 0), wz - (onX ? 0 : sign * 2.2), 4.4, 4.4, 0.018), undefined, [wx, wz]);
  }

  // Backdrop masses: real 3D blocks crowding just outside the wall. Depth layer 1.
  // Scaled with the arena so the city still crowds the horizon at the new distances.
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2 + rng.spread(0.08);
    const r = rng.range(90, 126);
    const h = rng.range(26, 66);
    const w = rng.range(18, 40);
    const d = rng.range(18, 40);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    boxAt('wall', w, h, d, x, h * 0.5, z, rng.spread(0.5));
    if (rng.bool(0.5)) boxAt('wall', w * 0.4, rng.range(4, 12), d * 0.4, x + rng.spread(w * 0.2), h + 2, z + rng.spread(d * 0.2), rng.spread(0.6));
    /**
     * LIT WINDOWS ON THE BACKDROP — on a FLOOR GRID, on the face that points at the arena.
     *
     * This used to be seven 1.4 m cubes at `rng.range(5, h-3)` with `rng.spread(6)` on both
     * horizontal axes: an unstructured sprinkle that could and did land off the box it was
     * meant to be in, and that carried no floor pitch, so a 66 m tower had no scale on it at
     * all. From the ground that is invisible — the block ring covers the backdrop. From the
     * high routes it is a third of the frame, and it is the second half of why a roof frame
     * measured 50% of its middle band into 0.1–0.2 with 5% warm pixels: a wall of unlit
     * `wall`-value slabs at 0.28, screened to about 0.20, and nothing else out there.
     *
     * Same 4.6 × 6.2 m grid the skyline rings use, ~1 in 8 lit, 1 in 5 cold — one ruler
     * across the whole backdrop, and the near ring, the far ring and the real city now agree
     * about how big a storey is. Cost is stamps into two buckets that already exist, so the
     * backdrop is still zero extra draw calls.
     */
    {
      const inward = a + Math.PI;
      const nx = Math.cos(inward);
      const nz = Math.sin(inward);
      // The inward-facing plane, and the tangent along it.
      const fx = x + nx * (w * 0.5 + 0.16);
      const fz = z + nz * (d * 0.5 + 0.16);
      const fyaw = Math.atan2(nx, nz);
      const tx = Math.cos(fyaw);
      const tz = -Math.sin(fyaw);
      const faceW = Math.abs(nx) > Math.abs(nz) ? d : w;
      const cols = Math.max(2, Math.floor(faceW / 4.6));
      const rows = Math.max(2, Math.floor((h - 9) / 6.2));
      for (let c = 0; c < cols; c++) {
        for (let k = 0; k < rows; k++) {
          if (!rng.bool(0.13)) continue;
          const u = (-(cols - 1) / 2 + c) * (faceW / cols);
          boxAt(
            rng.bool(0.2) ? 'neon' : 'emissive', 1.9, 2.6, 0.4,
            fx + tx * u, 6.5 + k * 6.2, fz + tz * u, fyaw, true,
          );
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.4 THE EIGHT BLOCKS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Windows, sills, and the occasional lit pane, along one facade.
   *
   * Column and row pitch are FIXED IN METRES (4.2 × STOREY), never divided out of the wall —
   * that is what makes a window a unit of measurement instead of a decoration. A reader
   * counts eight floors up an unfamiliar building and instantly knows how tall it is.
   */
  const facade = (
    cx: number, cz: number, yaw: number, faceDir: number, faceW: number, h: number, seed: number,
  ): void => {
    const r = new Rng(seed);
    const cols = Math.max(2, Math.floor(faceW / 4.2));
    const rows = Math.max(1, Math.floor((h - 4.6) / STOREY));
    const ang = yaw + faceDir;
    const nx = Math.sin(ang);
    const nz = Math.cos(ang);
    const tx = Math.cos(ang);
    const tz = -Math.sin(ang);
    for (let c = 0; c < cols; c++) {
      const u = (-(cols - 1) / 2 + c) * (faceW / cols);
      for (let rw = 0; rw < rows; rw++) {
        if (r.bool(0.11)) continue; // boarded up — gaps read as damage
        const y = 4.3 + rw * STOREY;
        const px = cx + tx * u;
        const pz = cz + tz * u;
        /**
         * 0.30 → 0.38 lit. The only warm marks a high route has in frame are lit windows —
         * from the west catwalk and the east gantry you are looking at a wall of facade and
         * nothing else, and the measured warm share of a high frame was 3.7% against the
         * plaza's 46%. A lit window is also the only thing in a facade that is ABOVE the
         * midtone band, so this is a value fix as much as a hue one. Four in ten is still a
         * building with more dark windows than lit ones.
         */
        const lit = r.bool(0.38);
        // ONE LIT WINDOW IN FOUR IS COLD. BUILD 001 had a single lit-window colour for a
        // whole city, which is most of why the frame measured as two hues and nothing else.
        // A wall of warm windows with a few cold ones in it reads as a hundred separate
        // rooms; a wall of identical windows reads as a texture.
        const bucket: BucketId = lit ? (r.bool(0.26) ? 'neon' : 'emissive') : 'glass';
        // Panes are plates (12 tris): at 1500 windows the bevel would cost 60k triangles
        // and be invisible on a 1.3 m pane past the first storey.
        B.stamp(bucket, P.plate, {
          sx: 1.3, sy: 1.9, sz: 0.3, ry: ang, x: px, y, z: pz,
        });
        // Sills only on the first three floors — the ones you can actually look at.
        if (rw < 3) {
          B.stamp('trim', P.plate, { sx: 1.7, sy: 0.18, sz: 0.5, ry: ang, x: px, y: y - 1.08, z: pz });
        }
        if (r.bool(0.16)) {
          // A dangling board across a broken window.
          B.stamp('rust', P.plate, { sx: 2.0, sy: 0.2, sz: 0.1, rz: r.spread(0.5), ry: ang, x: px, y: y + r.spread(0.6), z: pz + nz * 0.12 });
        }
      }
    }
  };

  /**
   * A run of ground-floor DOORWAYS along a facade. 2.1 m clear, framed, one every ~6 m.
   * Doors are the reference object a human reads fastest — a wall with doors in it can
   * never accidentally look like a small wall seen close up.
   */
  const doorRun = (
    cx: number, cz: number, yaw: number, faceDir: number, faceW: number, seed: number,
  ): void => {
    const r = new Rng(seed);
    const n = Math.max(1, Math.round(faceW / 6.2));
    const ang = yaw + faceDir;
    const nx = Math.sin(ang);
    const nz = Math.cos(ang);
    const tx = Math.cos(ang);
    const tz = -Math.sin(ang);
    for (let i = 0; i < n; i++) {
      const u = (-(n - 1) / 2 + i) * (faceW / n);
      const px = cx + tx * u;
      const pz = cz + tz * u;
      // Recess, leaf, frame, and a step up to the threshold.
      B.stamp('grime', P.plate, { sx: 1.5, sy: 2.15, sz: 0.24, ry: ang, x: px, y: 1.28, z: pz });
      B.stamp(r.bool(0.35) ? 'rust' : 'metal', P.plate, {
        sx: 1.24, sy: 2.05, sz: 0.14, ry: ang + r.spread(0.05), x: px + nx * 0.14, y: 1.24, z: pz + nz * 0.14,
      });
      for (const j of [-1, 1]) {
        B.stamp('trim', P.plate, { sx: 0.26, sy: 2.5, sz: 0.42, ry: ang, x: px + tx * j * 0.86, y: 1.25, z: pz + tz * j * 0.86 });
      }
      B.stamp('trim', P.plate, { sx: 2.1, sy: 0.3, sz: 0.46, ry: ang, x: px, y: 2.62, z: pz });
      B.stamp('trim', P.plate, { sx: 1.9, sy: 0.16, sz: 0.7, ry: ang, x: px + nx * 0.35, y: 0.28, z: pz + nz * 0.35 });
      if (r.bool(0.45)) {
        // A lit fanlight over the door — a GOLD pinprick at head height, 60 of them
        // marching down a 140 m street. This is the depth cue that costs nothing.
        B.stamp('emissive', P.plate, { sx: 1.0, sy: 0.24, sz: 0.16, ry: ang, x: px + nx * 0.3, y: 2.36, z: pz + nz * 0.3 });
      }
    }
  };

  const blockBox = (b: BlockSpec): { hw: number; hd: number } => ({ hw: b.w * 0.5, hd: b.d * 0.5 });

  for (const b of BLOCKS) {
    const { hw, hd } = blockBox(b);
    if (b.kind === 'lot') continue; // handled below
    const bh = blockH(b);

    if (b.kind === 'arcade') {
      // West block: solid, solid, and a covered passage between them (LOOP E).
      const aD = DEPOT_Z0 - -hd;
      boxAt('mass', b.w, bh, aD, b.cx, bh * 0.5, b.cz + (-hd + DEPOT_Z0) * 0.5, b.yaw);
      B.collideBox(b.w, bh, aD, b.cx, bh * 0.5, b.cz + (-hd + DEPOT_Z0) * 0.5, b.yaw, 'concrete');
      const cD = hd - DEPOT_Z1;
      boxAt('mass', b.w, bh, cD, b.cx, bh * 0.5, b.cz + (DEPOT_Z1 + hd) * 0.5, b.yaw);
      B.collideBox(b.w, bh, cD, b.cx, bh * 0.5, b.cz + (DEPOT_Z1 + hd) * 0.5, b.yaw, 'concrete');
      // The span over the passage.
      const spanH = bh - DEPOT_CEIL;
      boxAt('mass', b.w, spanH, DEPOT_Z1 - DEPOT_Z0, b.cx, DEPOT_CEIL + spanH * 0.5, b.cz + (DEPOT_Z0 + DEPOT_Z1) * 0.5, b.yaw);
      B.collideBox(b.w, spanH, DEPOT_Z1 - DEPOT_Z0, b.cx, DEPOT_CEIL + spanH * 0.5, b.cz + (DEPOT_Z0 + DEPOT_Z1) * 0.5, b.yaw, 'concrete');
      // Columns in the passage — cover, and they break the sightline down the shortcut.
      // Two rows of four: a receding colonnade inside a 26 m tunnel.
      for (const px of [-9.5, -3.5, 3.5, 9.5]) {
        for (const pz of [DEPOT_Z0 + 2.2, DEPOT_Z1 - 2.2]) {
          boxAt('trim', 0.8, DEPOT_CEIL, 0.8, b.cx + px, DEPOT_CEIL * 0.5, b.cz + pz, b.yaw);
          B.collideBox(0.85, DEPOT_CEIL, 0.85, b.cx + px, DEPOT_CEIL * 0.5, b.cz + pz, b.yaw, 'concrete');
          boxAt('trim', 1.1, 0.24, 1.1, b.cx + px, DEPOT_CEIL - 0.14, b.cz + pz, b.yaw, true);
        }
      }
      // Lintel band and a dark grimy floor for the passage.
      boxAt('trim', b.w + 0.3, 0.6, DEPOT_Z1 - DEPOT_Z0 + 0.2, b.cx, DEPOT_CEIL + 0.25, b.cz + (DEPOT_Z0 + DEPOT_Z1) * 0.5, b.yaw, true);
      // Above the block's own sidewalk (y=0.12) — an interior floor, not a pavement.
      B.add('grime', flatRect(b.cx, b.cz + (DEPOT_Z0 + DEPOT_Z1) * 0.5, b.w + 2.5, DEPOT_Z1 - DEPOT_Z0, 0.13, b.yaw), undefined, [b.cx, b.cz]);
      zones.push({
        id: 'depot',
        box: new Box3(new Vector3(b.cx - hw, 0, b.cz + DEPOT_Z0), new Vector3(b.cx + hw, DEPOT_CEIL, b.cz + DEPOT_Z1)),
      });
      // FIVE hanging lamps down the length of the passage, alternating either side of the
      // centre line. Three in a straight row lit a 10 m-deep tunnel in one stripe and left
      // the flanks black: the west arcade measured 43% of pixels under 0.1 luminance plus
      // 23% blown, i.e. worse than any BUILD 001 frame, on a shipped kite route (LOOP E).
      // Staggering them also gives the passage a rhythm to walk through instead of a corridor.
      for (let i = 0; i < 5; i++) {
        const lx = b.cx - 10 + i * 5;
        const lz = b.cz + (DEPOT_Z0 + DEPOT_Z1) * 0.5 + (i % 2 === 0 ? -2.2 : 2.2);
        practicals.push({
          position: new Vector3(lx, DEPOT_CEIL - 0.6, lz),
          // LOOP E is a route, and ART §6 says GOLD marks what you can use. A 4 m pool in
          // a 26 m tunnel lit nothing; 7 m of pool is what makes the shortcut readable
          // from the plaza end as a lit passage rather than a black hole in a wall.
          color: PALETTE.GOLD, intensity: 5, radius: 15, coneRadius: 2.6, poolRadius: 7.0, flicker: 0.55, groundY: 0,
        });
        cylAt('emissive', 0.3, 0.22, lx, DEPOT_CEIL - 0.6, lz);
        cylAt('metal', 0.06, 0.6, lx, DEPOT_CEIL - 0.25, lz);
      }
    } else {
      boxAt('mass', b.w, bh, b.d, b.cx, bh * 0.5, b.cz, b.yaw);
      B.collideBox(b.w, bh, b.d, b.cx, bh * 0.5, b.cz, b.yaw, 'concrete');
      // Setback upper storeys on the tall ones — breaks the box silhouette and gives the
      // skyline a stepped, drawn profile instead of a row of slabs.
      if (b.kind === 'tower' && b.storeys >= 7) {
        const sh = STOREY * 2;
        boxAt('mass', b.w * 0.74, sh, b.d * 0.74, b.cx + b.w * 0.05, bh + sh * 0.5, b.cz - b.d * 0.05, b.yaw);
        B.collideBox(b.w * 0.74, sh, b.d * 0.74, b.cx + b.w * 0.05, bh + sh * 0.5, b.cz - b.d * 0.05, b.yaw, 'concrete');
        boxAt('trim', b.w * 0.78, 0.4, b.d * 0.78, b.cx + b.w * 0.05, bh + sh - 0.2, b.cz - b.d * 0.05, b.yaw, true);
        if (b.storeys >= 9) {
          const th = STOREY * 1.5;
          boxAt('mass', b.w * 0.42, th, b.d * 0.42, b.cx + b.w * 0.08, bh + sh + th * 0.5, b.cz - b.d * 0.08, b.yaw);
        }
      }
    }

    // Plinth, cornice, parapet — the three lines that make a box read as a building.
    // The arcade block gets its plinth in two pieces so the passage stays clear.
    if (b.kind === 'arcade') {
      for (const [z0, z1] of [[-hd, DEPOT_Z0], [DEPOT_Z1, hd]] as [number, number][]) {
        const cz = b.cz + (z0 + z1) * 0.5;
        boxAt('trim', b.w + 0.7, 1.6, z1 - z0, b.cx, 0.8, cz, b.yaw);
        B.collideBox(b.w + 0.7, 1.6, z1 - z0, b.cx, 0.8, cz, b.yaw, 'concrete');
      }
    } else {
      boxAt('trim', b.w + 0.7, 1.6, b.d + 0.7, b.cx, 0.8, b.cz, b.yaw);
      B.collideBox(b.w + 0.7, 1.6, b.d + 0.7, b.cx, 0.8, b.cz, b.yaw, 'concrete');
    }
    boxAt('trim', b.w + 1.0, 0.6, b.d + 1.0, b.cx, bh - 0.4, b.cz, b.yaw, true);
    /**
     * ─────────────────────────────────────────────────────────────────────────────────────
     * THE PARAPET IS A RING. It used to be a LID, and that single box was the whole "the
     * high routes are a two-value violet poster" defect.
     *
     * It was authored as `boxAt('wall', b.w + 0.3, 1.1, b.d + 0.3, …, bh + 0.55, …)` — a
     * SOLID 26.3 × 1.1 × 26.3 m slab sitting on top of every block. On the seven towers
     * nobody can see the top, so it cost four hidden triangles and nothing else. On `ne` —
     * the two-storey market hall, the only walkable roof in the map and the destination of
     * LOOP D — it was a 26 m violet ceiling laid 2 cm above the warm `walk` quad the M1.5
     * readability pass added to fix exactly this, and 1.1 m above the collision surface the
     * player actually walks on. The fix was shipped; the lid buried it.
     *
     * MEASURED, real renderer, camera on the NE roof looking down (pitch −1.3):
     *   before   mean luminance 0.222 · 42.5% of pixels in the 0.1–0.2 band ·  3.8% warm
     *   plaza    mean luminance 0.616 ·  0.4% in the 0.1–0.2 band          · 97.0% warm
     * and hiding `arena_wall` alone turned the pixel under the reticle from (41,41,124) —
     * saturated violet — to (186,134,104), the warm deck that was underneath it all along.
     *
     * A parapet is a low wall around the edge of a roof. It is a ring. So it is four bars
     * now, `PARAPET_T` thick, and everything above 6.8 m gets its warm plane back for
     * ~21 extra boxes across the whole city.
     * ─────────────────────────────────────────────────────────────────────────────────────
     */
    {
      const pw = b.w + 0.3;
      const pd = b.d + 0.3;
      const py = bh + PARAPET_H * 0.5;
      const cyw = Math.cos(b.yaw);
      const syw = Math.sin(b.yaw);
      for (const s of [-1, 1]) {
        // The two bars that run along local X, offset along local Z.
        const oz = s * (pd - PARAPET_T) * 0.5;
        boxAt('wall', pw, PARAPET_H, PARAPET_T, b.cx - oz * syw, py, b.cz + oz * cyw, b.yaw);
        // The two that close the ends, shortened so the corners do not double up.
        const ox = s * (pw - PARAPET_T) * 0.5;
        boxAt('wall', PARAPET_T, PARAPET_H, pd - PARAPET_T * 2, b.cx + ox * cyw, py, b.cz + ox * syw, b.yaw);
      }
    }
    /**
     * BELT COURSES — one bright horizontal line every three storeys. Without them a 34 m
     * dark box has no scale at all; with them a reader counts the bands and the building
     * announces its own height from 60 m away. This is the cheapest verticality cue we have
     * (a 0.3 m band is a 12-triangle plate).
     */
    for (let f = 3; f < b.storeys; f += 3) {
      boxAt('trim', b.w + 0.5, 0.3, b.d + 0.5, b.cx, f * STOREY + 0.6, b.cz, b.yaw, true);
    }

    // Storefronts: a lit ground floor on the plaza-facing side of the four MAIN blocks
    // only. The eye lives at this height, so this is where the value contrast has to
    // happen — but ring it all the way round and the plaza reads like a casino, so the
    // corner blocks stay dark and the shops become a rhythm instead of a wall.
    if (b.cx === 0 || b.cz === 0) {
      const alongZ = b.cx !== 0;
      const faceW = alongZ ? b.d : b.w;
      const ox = alongZ ? (b.cx > 0 ? -(hw + 0.5) : hw + 0.5) : 0;
      const oz = alongZ ? 0 : (b.cz > 0 ? -(hd + 0.5) : hd + 0.5);
      const fx = b.cx + ox * Math.cos(b.yaw) - oz * Math.sin(b.yaw);
      const fz = b.cz + ox * Math.sin(b.yaw) + oz * Math.cos(b.yaw);
      const fyaw = b.yaw + (alongZ ? Math.PI * 0.5 : 0) + (b.cx > 0 || b.cz > 0 ? Math.PI : 0);
      const sr = new Rng(613 + Math.round(b.cx * 31 + b.cz * 17));
      const cols = Math.max(3, Math.round(faceW / 4.6));
      const unit = faceW / cols;
      for (let i = 0; i < cols; i++) {
        const u = (-(cols - 1) / 2 + i) * unit;
        const px = fx + Math.cos(fyaw) * u;
        const pz = fz - Math.sin(fyaw) * u;
        const lit = sr.bool(0.42);
        const h = sr.range(2.4, 3.0);
        boxAt(lit ? (sr.bool(0.3) ? 'neon' : 'emissive') : 'glass', unit - 1.2, h, 0.3, px, 0.9 + h * 0.5, pz, fyaw, true);
        // Awning over the shopfront: a hard shape that throws a painted shadow.
        if (sr.bool(0.55)) {
          boxAt('hot', unit - 0.9, 0.2, 1.3, px, 0.95 + h + 0.3, pz - Math.cos(fyaw) * 0.6, fyaw, true);
          boxAt('trim', unit - 0.9, 0.6, 0.16, px, 0.95 + h + 0.02, pz - Math.cos(fyaw) * 1.2, fyaw, true);
        } else {
          boxAt('trim', unit - 0.6, 0.42, 0.6, px, 0.95 + h + 0.2, pz, fyaw, true);
        }
        // Pier between the shops.
        boxAt('trim', 0.6, 4.4, 0.5, px + Math.cos(fyaw) * unit * 0.5, 2.2, pz - Math.sin(fyaw) * unit * 0.5, fyaw, true);
      }
    }

    // Facades on all four sides — every face of every block is seen from somewhere.
    const sy = Math.sin(b.yaw);
    const cy = Math.cos(b.yaw);
    const seedBase = Math.round(b.cx * 7 + b.cz * 3);
    facade(b.cx + sy * (hd + 0.4), b.cz + cy * (hd + 0.4), b.yaw, 0, b.w - 3, bh, 11 + seedBase);
    facade(b.cx - sy * (hd + 0.4), b.cz - cy * (hd + 0.4), b.yaw, Math.PI, b.w - 3, bh, 23 + seedBase * 2);
    if (b.kind === 'arcade') {
      // Only the solid half of the long faces — no windows floating over the passage.
      const solidC = (-hd + DEPOT_Z0) * 0.5;
      facade(b.cx + cy * (hw + 0.4) - sy * solidC, b.cz - sy * (hw + 0.4) + cy * solidC, b.yaw, Math.PI * 0.5, DEPOT_Z0 + hd - 3, bh, 37 + seedBase);
      facade(b.cx - cy * (hw + 0.4) - sy * solidC, b.cz + sy * (hw + 0.4) + cy * solidC, b.yaw, -Math.PI * 0.5, DEPOT_Z0 + hd - 3, bh, 51 - seedBase);
    } else {
      facade(b.cx + cy * (hw + 0.4), b.cz - sy * (hw + 0.4), b.yaw, Math.PI * 0.5, b.d - 3, bh, 37 + seedBase);
      facade(b.cx - cy * (hw + 0.4), b.cz + sy * (hw + 0.4), b.yaw, -Math.PI * 0.5, b.d - 3, bh, 51 - seedBase);
    }

    // Ground-floor doorways on the two street faces that are NOT the plaza storefront.
    doorRun(b.cx + sy * (hd + 0.45), b.cz + cy * (hd + 0.45), b.yaw, 0, b.w - 4, 71 + seedBase);
    doorRun(b.cx - sy * (hd + 0.45), b.cz - cy * (hd + 0.45), b.yaw, Math.PI, b.w - 4, 83 + seedBase);
    if (b.kind !== 'arcade') {
      doorRun(b.cx + cy * (hw + 0.45), b.cz - sy * (hw + 0.45), b.yaw, Math.PI * 0.5, b.d - 4, 97 + seedBase);
      doorRun(b.cx - cy * (hw + 0.45), b.cz + sy * (hw + 0.45), b.yaw, -Math.PI * 0.5, b.d - 4, 109 + seedBase);
    }

    /**
     * BLOCK DRESSING. Two placements, chosen because they are the two blank surfaces a
     * player actually looks at:
     *
     *   • THE SETBACK. `facade()` stops at `bh`, so the two storeys of setback on every tall
     *     tower are the only genuinely windowless wall in the city — and they are the top of
     *     the skyline, visible from every one of the eight 140 m sightlines. A 9 m painted
     *     ad up there is a landmark you navigate by, for four triangles.
     *   • THE PLINTH. Eye height, on all four street faces, passed within 2 m of on every
     *     lap of the ring. Poster clusters here are the difference between a corridor and a
     *     street; they are also a scale ruler, because a reader knows how big a poster is.
     */
    if (b.kind === 'tower' && b.storeys >= 7) {
      const sh = STOREY * 2;
      const scx = b.cx + b.w * 0.05;
      const scz = b.cz - b.d * 0.05;
      // Face the plaza down whichever axis this block is furthest out on.
      const ax = Math.abs(b.cx) >= Math.abs(b.cz);
      const dirX = ax ? -Math.sign(b.cx) : 0;
      const dirZ = ax ? 0 : -Math.sign(b.cz);
      const off = (ax ? b.w * 0.74 : b.d * 0.74) * 0.5 + 0.25;
      pasteAd(
        scx + dirX * off, bh + sh * 0.5, scz + dirZ * off,
        Math.atan2(dirX, dirZ), (ax ? b.d : b.w) * 0.56, sh * 0.74,
        Math.abs(seedBase) % 4, 700 + seedBase,
      );
    }
    for (const [sx, sz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as [number, number][]) {
      const off = sx !== 0 ? hw + 0.52 : hd + 0.52;
      const faceW = sx !== 0 ? b.d : b.w;
      const fyaw = b.yaw + Math.atan2(sx, sz);
      const ox = sx * off;
      const oz = sz * off;
      const fx = b.cx + ox * Math.cos(b.yaw) - oz * Math.sin(b.yaw);
      const fz = b.cz + ox * Math.sin(b.yaw) + oz * Math.cos(b.yaw);
      const tx = Math.cos(fyaw);
      const tz = -Math.sin(fyaw);
      for (let k = -1; k <= 1; k++) {
        // Offset by half the doorway pitch so the bills land on pier, not on door leaf.
        const u = k * faceW * 0.3 + 3.1;
        pasteBills(fx + tx * u, 1.32, fz + tz * u, fyaw, 3, 4100 + seedBase * 7 + k * 13 + sx * 3 + sz, 2.2);
      }
    }

    // Roof clutter — read from the gantry, and it fills the skyline.
    const rr = new Rng(97 + seedBase);
    for (let i = 0; i < 7; i++) {
      const ux = rr.range(-hw + 2.2, hw - 2.2);
      const uz = rr.range(-hd + 2.2, hd - 2.2);
      const x = b.cx + ux * Math.cos(b.yaw) - uz * Math.sin(b.yaw);
      const z = b.cz + ux * Math.sin(b.yaw) + uz * Math.cos(b.yaw);
      if (rr.bool(0.55)) {
        boxAt('metal', rr.range(1.8, 3.4), rr.range(1.1, 2.1), rr.range(1.8, 3.2), x, bh + 1.6, z, rr.range(0, 3.1), true);
      } else {
        cylAt('metal', rr.range(0.45, 0.9), rr.range(1.4, 3.0), x, bh + 2.2, z);
      }
    }
    // A rooftop water tank on the taller blocks — the classic city skyline silhouette.
    if (b.storeys >= 6) {
      const tx = b.cx + hw * 0.45;
      const tz = b.cz - hd * 0.4;
      for (const [lx, lz] of [[-1.1, -1.1], [1.1, -1.1], [1.1, 1.1], [-1.1, 1.1]] as [number, number][]) {
        boxAt('metal', 0.22, 2.4, 0.22, tx + lx, bh + 1.2, tz + lz, 0, true);
      }
      B.stamp('metal', P.cyl, { sx: 3.0, sy: 2.6, sz: 3.0, x: tx, y: bh + 3.7, z: tz });
      B.stamp('rust', P.cone, { sx: 3.3, sy: 1.0, sz: 3.3, x: tx, y: bh + 5.5, z: tz });
    }
    // Aircraft-warning mast.
    if (rng.bool(0.8)) {
      const mh = rng.range(5, 11);
      cylAt('metal', 0.1, mh, b.cx - hw * 0.5, bh + 1.0 + mh * 0.5, b.cz + hd * 0.4);
      cylAt('emissive', 0.16, 0.32, b.cx - hw * 0.5, bh + 1.0 + mh, b.cz + hd * 0.4);
    }

    // Sidewalk + kerb + painted contact shadow. The sidewalk is 4 m — a real one.
    B.add('walk', flatRect(b.cx, b.cz, b.w + 8, b.d + 8, 0.12, b.yaw), undefined, [b.cx, b.cz]);
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      const ox = sx * (hw + 4);
      const oz = sz * (hd + 4);
      const x = b.cx + ox * Math.cos(b.yaw) - oz * Math.sin(b.yaw);
      const z = b.cz + ox * Math.sin(b.yaw) + oz * Math.cos(b.yaw);
      boxAt('trim', sx !== 0 ? 0.32 : b.w + 8.4, 0.24, sz !== 0 ? 0.32 : b.d + 8.4, x, 0.06, z, b.yaw, true);
    }
    B.add('grime', flatRect(b.cx + 2.4, b.cz - 1.8, b.w + 12, b.d + 12, 0.017, b.yaw), undefined, [b.cx, b.cz]);

    zones.push({
      id: `block_${b.id}`,
      box: new Box3(new Vector3(b.cx - hw, 0, b.cz - hd), new Vector3(b.cx + hw, bh, b.cz + hd)),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.5 THE SW LOT — a fenced yard where a building should be. Sightline relief, and
  //     the container stack that starts LOOP G.
  // ═══════════════════════════════════════════════════════════════════════════

  const lot = BLOCKS.find((b) => b.kind === 'lot') as BlockSpec;
  {
    const hw = lot.w * 0.5;
    const hd = lot.d * 0.5;
    B.add('grime', flatRect(lot.cx, lot.cz, lot.w, lot.d, 0.015), undefined, [lot.cx, lot.cz]);

    // Chain-link perimeter, built from plates so a 100 m run costs almost nothing.
    const lotFence = (x0: number, z0: number, x1: number, z1: number): void => {
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const yaw = Math.atan2(dx, dz);
      const posts = Math.max(2, Math.round(len / 2.4));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        boxAt('metal', 0.14, 2.1, 0.14, x0 + dx * t, 1.05, z0 + dz * t, yaw, true);
      }
      for (const y of [0.35, 1.15, 1.95]) {
        boxAt('rust', 0.06, 0.06, len, (x0 + x1) / 2, y, (z0 + z1) / 2, yaw, true);
      }
      boxAt('grime', 0.03, 1.9, len, (x0 + x1) / 2, 1.05, (z0 + z1) / 2, yaw, true);
      B.collideBox(0.3, 2.1, len, (x0 + x1) / 2, 1.05, (z0 + z1) / 2, yaw, 'metal');
    };
    // Three sides plus two stubs — the fourth side has a 7 m gate onto the plaza-side
    // street, so the lot is a THROUGH route, never a trap. (Bible §4: no dead ends.)
    lotFence(lot.cx - hw, lot.cz - hd, lot.cx - hw, lot.cz + hd);
    lotFence(lot.cx - hw, lot.cz + hd, lot.cx + hw, lot.cz + hd);
    lotFence(lot.cx + hw, lot.cz - hd, lot.cx + hw, lot.cz + hd);
    lotFence(lot.cx - hw, lot.cz - hd, lot.cx - 5, lot.cz - hd);
    lotFence(lot.cx + 5, lot.cz - hd, lot.cx + hw, lot.cz - hd);
    // Gate posts, so the opening reads as a gate.
    for (const s of [-5, 5]) {
      boxAt('rust', 0.4, 3.0, 0.4, lot.cx + s, 1.5, lot.cz - hd, 0, true);
      B.collideBox(0.45, 3.0, 0.45, lot.cx + s, 1.5, lot.cz - hd, 0, 'metal');
    }

    /**
     * SHIPPING CONTAINERS — LOOP G's mantle ladder, and the best human-scale object in the
     * level after the cars: everybody knows a container is 2.6 m tall and 12 m long.
     * Placed as a deliberate staircase: 0 → 2.6 → 5.2, each step a mantle the movement kit
     * already supports, ending on the south block's dock canopy at 4.4 m.
     */
    const container = (x: number, z: number, y: number, yaw: number, len: number, id: BucketId): void => {
      boxAt(id, len, 2.6, 2.44, x, y + 1.3, z, yaw);
      // Corrugation ribs + corner castings: plates, and they're what makes it read.
      const ribs = Math.max(3, Math.round(len / 0.6));
      for (let i = 0; i < ribs; i++) {
        const u = (-(ribs - 1) / 2 + i) * (len / ribs);
        boxAt('grime', 0.1, 2.3, 2.5, x + Math.cos(yaw) * u, y + 1.3, z - Math.sin(yaw) * u, yaw, true);
      }
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          boxAt('metal', 0.3, 0.3, 0.3, x + Math.cos(yaw) * sx * len * 0.5, y + 0.2, z - Math.sin(yaw) * sx * len * 0.5 + sz * 0.1, yaw, true);
          boxAt('metal', 0.3, 0.3, 0.3, x + Math.cos(yaw) * sx * len * 0.5, y + 2.42, z - Math.sin(yaw) * sx * len * 0.5 + sz * 0.1, yaw, true);
        }
      }
      // Door end.
      boxAt('metal', 0.12, 2.3, 2.3, x - Math.cos(yaw) * (len * 0.5 - 0.08), y + 1.3, z + Math.sin(yaw) * (len * 0.5 - 0.08), yaw, true);
      B.collideBox(len, 2.6, 2.5, x, y + 1.3, z, yaw, 'metal');
      reserve(x, z, len * 0.5 + 0.6, 2.0);
      B.add('grime', flatRect(x + 1.2, z - 0.9, len + 2, 4.4, 0.019, yaw), undefined, [x, z]);
    };
    // Step 1 (ground), step 2 (stacked), step 3 (stacked, reaching the dock canopy).
    container(lot.cx - 5.0, lot.cz + 6.0, 0, 0.06, 12, 'hot');
    container(lot.cx + 4.5, lot.cz + 2.0, 0, Math.PI * 0.5 + 0.04, 12, 'metal');
    container(lot.cx - 4.0, lot.cz + 6.4, 2.6, -0.03, 9, 'metal');
    container(lot.cx + 4.5, lot.cz - 2.4, 0, Math.PI * 0.5 - 0.05, 9, 'rust');
    container(lot.cx + 4.6, lot.cz - 2.2, 2.6, Math.PI * 0.5 + 0.02, 9, 'hot');
    addWordLater('CARGO', lot.cx - 5.0, 1.7, lot.cz + 6.0 - 1.3, 0.06, 0.9, 'PAPER', false, -2);

    // The burnt-out car: another big silhouette, and the lot's reason to exist.
    {
      const cx = lot.cx - 6.5;
      const cz = lot.cz - 6.0;
      const yaw = 0.62;
      const put = (id: BucketId, w: number, h: number, d: number, ox: number, oy: number, oz: number): void => {
        B.stamp(id, Math.min(w, h, d) < PLATE_MAX ? P.plate : P.box, {
          sx: w, sy: h, sz: d, rz: 0.05, ry: yaw,
          x: cx + ox * Math.cos(yaw) - oz * Math.sin(yaw),
          y: oy,
          z: cz + ox * Math.sin(yaw) + oz * Math.cos(yaw),
        });
      };
      put('metal', 1.95, 0.85, 4.3, 0, 0.72, 0);
      put('metal', 1.75, 0.75, 2.0, 0, 1.45, 0.15);   // cabin, roof caved in
      put('glass', 1.82, 0.5, 1.85, 0, 1.5, 0.1);
      put('rust', 2.0, 0.18, 4.4, 0, 0.3, 0);
      put('trim', 1.6, 0.3, 0.35, 0, 1.05, -2.1);
      for (const [wx, wz] of [[-0.95, -1.35], [0.95, -1.35], [-0.95, 1.45], [0.95, 1.45]] as [number, number][]) {
        B.stamp('crack', P.cyl6, {
          sx: 0.62, sy: 0.28, sz: 0.62, rz: Math.PI * 0.5, ry: yaw,
          x: cx + wx * Math.cos(yaw) - wz * Math.sin(yaw),
          y: 0.31,
          z: cz + wx * Math.sin(yaw) + wz * Math.cos(yaw),
        });
      }
      B.collideBox(2.1, 1.9, 4.5, cx, 0.95, cz, yaw, 'metal');
      B.add('grime', flatRect(cx + 0.8, cz - 0.5, 3.6, 6.0, 0.019, yaw), undefined, [cx, cz]);
      reserve(cx, cz, 3.0, 3.4);
    }
    for (let i = 0; i < 10; i++) {
      const x = lot.cx + rng.range(-11, 11);
      const z = lot.cz + rng.range(-11, 11);
      if (!free(x, z, 0.8)) continue;
      placeProp(rng.bool(0.5) ? 'crate' : 'barrel', x, z, rng.range(0, 3.1));
    }
    for (let i = 0; i < 5; i++) {
      const px = lot.cx + rng.range(-11, 11);
      const pz = lot.cz + rng.range(-11, 11);
      const g = rubblePile(rng.range(0.8, 1.5), 6, { seed: 400 + i });
      place(g, { ry: rng.range(0, 3), x: px, y: 0, z: pz });
      B.add('trim', g, undefined, [px, pz]);
    }

    zones.push({ id: 'lot_sw', box: new Box3(new Vector3(lot.cx - hw, 0, lot.cz - hd), new Vector3(lot.cx + hw, 8, lot.cz + hd)) });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.6 VERTICALITY — three routes, each of which returns you to the ground on foot.
  //     The movement kit has vault and mantle; this is what they are FOR.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * A 1.05 m handrail from A to B. `y1` slopes it, which matters: a flat rail bolted to a
   * 40° stair floats a metre off the top step and instantly reads as programmer art.
   */
  const railing = (x0: number, z0: number, x1: number, z1: number, y0: number, y1 = y0): void => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const dy = y1 - y0;
    const run = Math.hypot(dx, dz);
    const len = Math.hypot(run, dy);
    const yaw = Math.atan2(dx, dz);
    const pitch = -Math.atan2(dy, run);
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    const my = (y0 + y1) / 2;
    for (const [oy, w, h] of [[1.05, 0.07, 0.09], [0.55, 0.06, 0.07]] as [number, number, number][]) {
      B.stamp('metal', P.plate, { sx: w, sy: h, sz: len, rx: pitch, ry: yaw, x: mx, y: my + oy, z: mz });
    }
    const posts = Math.max(2, Math.round(run / 1.6));
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      boxAt('metal', 0.09, 1.05, 0.09, x0 + dx * t, y0 + dy * t + 0.52, z0 + dz * t, yaw, true);
    }
  };

  /** A run of real steps with a smooth ramp proxy underneath — no collision stutter. */
  const stairRun = (
    x0: number, z0: number, y0: number, x1: number, z1: number, y1: number, width: number,
  ): void => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const run = Math.hypot(dx, dz);
    const rise = Math.abs(y1 - y0);
    const yaw = Math.atan2(dx, dz);
    /**
     * 0.17 m risers. A real stair riser is the finest scale reference in architecture, and
     * a flight of 40 of them is a ruler standing on end — which is exactly why the arena
     * has eight flights and why they are worth the triangles.
     *
     * Tread and riser are ONE box, not two: a step whose height reaches down to the next
     * tread reads identically to a tread-plus-riser pair and costs half as much. Across
     * eight flights that is ~7k triangles, or 18k rendered.
     */
    const steps = Math.max(4, Math.round(rise / 0.17));
    const riser = rise / steps;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const y = y0 + (y1 - y0) * t;
      boxAt('metal', width, riser + 0.14, (run / steps) * 1.05, x0 + dx * t, y - riser * 0.5 - 0.01, z0 + dz * t, yaw, true);
    }
    // Stringers.
    for (const s of [-1, 1]) {
      const ox = Math.cos(yaw) * s * width * 0.5;
      const oz = -Math.sin(yaw) * s * width * 0.5;
      const len = Math.hypot(run, rise);
      const pitch = -Math.atan2(y1 - y0, run);
      B.stamp('metal', P.plate, {
        sx: 0.14, sy: 0.44, sz: len, rx: pitch, ry: yaw,
        x: (x0 + x1) / 2 + ox, y: (y0 + y1) / 2 - 0.3, z: (z0 + z1) / 2 + oz,
      });
      railing(x0 + ox, z0 + oz, x1 + ox, z1 + oz, y0, y1);
    }
    B.collideRamp(x0, z0, y0 + 0.12, x1, z1, y1 + 0.12, width, 'metal');
  };

  /** A deck slab with railings and under-supports. */
  const deck = (cx: number, cz: number, w: number, d: number, y: number, yaw: number, rails: boolean): void => {
    // WARM slab, COOL ribs and rails. See the `deck` bucket: the plane you stand on has to be
    // the warm one at every height, or the whole high route is a monochrome.
    boxAt('deck', w, 0.24, d, cx, y - 0.12, cz, yaw);
    B.collideBox(w, 0.3, d, cx, y - 0.15, cz, yaw, 'metal');
    // Grating ribs — reads as a catwalk, not a plank.
    const ribs = Math.max(2, Math.round(d / 0.9));
    for (let i = 0; i < ribs; i++) {
      const t = (-(ribs - 1) / 2 + i) * (d / ribs);
      boxAt('metal', w * 0.98, 0.08, 0.1, cx - Math.sin(yaw) * t, y + 0.02, cz + Math.cos(yaw) * t, yaw, true);
    }
    if (rails) {
      const hwv = w * 0.5;
      const hdv = d * 0.5;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      for (const sx of [-1, 1]) {
        railing(cx + (sx * hwv) * c - -hdv * s, cz + (sx * hwv) * s + -hdv * c, cx + (sx * hwv) * c - hdv * s, cz + (sx * hwv) * s + hdv * c, y);
      }
    }
  };

  const ne = BLOCKS.find((b) => b.id === 'ne') as BlockSpec;
  const west = BLOCKS.find((b) => b.id === 'west') as BlockSpec;

  // ── ROUTE V1 / LOOP D — the east vertical circuit. ──
  // (a) External stair from the ring boulevard up the NE market hall's east face.
  stairRun(58.5, -28.0, 0, 58.5, -44.0, DECK_Y, 2.2);
  deck(56.0, -45.2, 4.2, 2.8, DECK_Y, 0, false);
  /**
   * (b) The NE roof is walkable — the block's own collider tops out at DECK_Y (2 storeys).
   * A 0.9 m parapet so it reads as a roof, authored as SEGMENTS WITH TWO GAPS: one at the
   * east edge where the stair landing arrives, one at the plaza-facing SW corner where the
   * skybridge leaves. A closed parapet would turn the roof into the map's only dead end.
   */
  for (const [px, pz, pw, pd] of [
    [BLOCK_C, -BLOCK_C - 13, 26, 0.4],            // north edge, closed
    [BLOCK_C + 3.5, -BLOCK_C + 13, 19, 0.4],      // plaza edge, open at the SW corner
    [BLOCK_C - 13, -BLOCK_C - 4, 0.4, 18],        // west edge, open at the SW corner
    [BLOCK_C + 13, -BLOCK_C - 10, 0.4, 6],        // east edge, north of the stair landing
    [BLOCK_C + 13, -BLOCK_C + 6, 0.4, 14],        // east edge, south of the stair landing
  ] as [number, number, number, number][]) {
    boxAt('trim', pw, 0.9, pd, px, DECK_Y + 0.45, pz, ne.yaw, true);
    B.collideBox(pw, 0.9, pd, px, DECK_Y + 0.45, pz, ne.yaw, 'concrete');
  }
  /**
   * THE ROOF SURFACE ITSELF. The block under it is a `mass` box, so the plane you stand on
   * up here was cool SLATE — the same hue as the facade opposite, the parapet and the sky.
   * A 25.6 m warm quad laid over it (two triangles, no new draw call: it merges into the
   * `walk` bucket) restores the ground-level warm/cool contract on the high route, and the
   * two GOLD practicals below light it: ART §6 reserves GOLD for interactables and walkable
   * routes, and this roof is the destination of LOOP D.
   *
   * `walk`, not `deck`: `deck` inks a silhouette hull and this is a flat ground decal, which
   * would get an ink halo inflated around a zero-thickness plane. Same rule as `ground`.
   */
  B.add('walk', flatRect(BLOCK_C, -BLOCK_C, 25.6, 25.6, DECK_Y + 0.06, ne.yaw), undefined, [BLOCK_C, -BLOCK_C]);
  for (const [gx, gz] of [[BLOCK_C - 7, -BLOCK_C - 7], [BLOCK_C + 7, -BLOCK_C + 7]] as [number, number][]) {
    cylAt('metal', 0.09, 3.0, gx, DECK_Y + 1.5, gz);
    cylAt('emissive', 0.22, 0.3, gx, DECK_Y + 3.1, gz);
    practicals.push({
      position: new Vector3(gx, DECK_Y + 3.1, gz), color: PALETTE.GOLD,
      intensity: 4, radius: 16, coneRadius: 2.0, poolRadius: 8.0, flicker: 0.4,
      groundY: DECK_Y, raised: true,
    });
  }
  /**
   * ROOFTOP FLOODS — the practicals ART §6 asks for on the high route. GOLD above is the
   * route marker (§6 reserves it for "you can stand on this"); a roof is also just a lit
   * place, and generic lighting is SODIUM. Two of them on the other diagonal, so all four
   * quadrants of a 25.6 m roof carry a pool instead of two of them, and the deck reads as a
   * space that is lit rather than a plane that is implied. Same fixture kit as the street:
   * `metal` mast, `emissive` head, cone + pool.
   */
  for (const [fx, fz] of [[BLOCK_C + 8, -BLOCK_C - 8], [BLOCK_C - 8, -BLOCK_C + 8]] as [number, number][]) {
    cylAt('metal', 0.1, 4.2, fx, DECK_Y + 2.1, fz);
    boxAt('emissive', 1.15, 0.34, 0.5, fx, DECK_Y + 4.15, fz, ne.yaw, true);
    boxAt('trim', 1.35, 0.16, 0.66, fx, DECK_Y + 4.4, fz, ne.yaw, true);
    practicals.push({
      position: new Vector3(fx, DECK_Y + 4.1, fz), color: PALETTE.SODIUM,
      intensity: 5, radius: 20, coneRadius: 3.4, poolRadius: 10.5, flicker: 0.25,
      groundY: DECK_Y, raised: true,
    });
  }
  // Roof kit for the market hall: skylights and vents you can vault.
  for (let i = 0; i < 4; i++) {
    const sx = BLOCK_C - 8 + i * 5.4;
    boxAt('emissive', 4.2, 0.35, 2.2, sx, DECK_Y + 0.55, -BLOCK_C + 4, ne.yaw, true);
    boxAt('trim', 4.6, 0.4, 2.6, sx, DECK_Y + 0.25, -BLOCK_C + 4, ne.yaw, true);
    B.collideBox(4.6, 0.75, 2.6, sx, DECK_Y + 0.38, -BLOCK_C + 4, ne.yaw, 'metal');
  }
  // (c) Skybridge from the NE roof's open SW corner (29, -29) across the radial street to
  //     the gantry's north end (27.4, -23). Local +Z is the span, so `d` is its length.
  deck(28.2, -26.0, 2.6, 6.8, DECK_Y, -0.261, true);
  // (d) The GANTRY: 44 m of catwalk along the east block's plaza-facing facade. Standing on
  //     it you look straight down the z = -25 sightline to the far wall.
  deck(27.4, 0, 2.6, 44, DECK_Y, 0, true);
  for (let z = -20; z <= 20; z += 5) {
    // Brackets tying the gantry back into the wall.
    boxAt('metal', 1.8, 0.18, 0.18, 28.6, DECK_Y - 0.6, z, 0, true);
    boxAt('metal', 0.16, 2.0, 0.16, 27.0, DECK_Y - 1.1, z, 0.5, true);
    if (z % 10 === 0) {
      cylAt('emissive', 0.16, 0.3, 26.4, DECK_Y + 2.3, z);
      cylAt('metal', 0.07, 2.4, 26.4, DECK_Y + 1.2, z);
      practicals.push({
        // GOLD, not ELECTRIC: this deck is LOOP D's high road. COLOUR NOTE 5 asked for the
        // walkable surfaces to say so, and GOLD is the only channel that means "go here".
        position: new Vector3(26.4, DECK_Y + 2.3, z), color: PALETTE.GOLD,
        intensity: 3.5, radius: 12, coneRadius: 1.8, poolRadius: 4.2, flicker: 0.5, groundY: DECK_Y,
      });
    }
  }
  // (e) Stair down into the plaza. 10 m of run for 6.8 m of rise — walkable, not a ladder.
  stairRun(27.4, 22.4, DECK_Y, 17.4, 22.4, 0.0, 2.2);
  zones.push({ id: 'gantry', box: new Box3(new Vector3(25.6, DECK_Y - 0.6, -24), new Vector3(29.2, DECK_Y + 2.6, 24)) });
  zones.push({ id: 'roof_ne', box: new Box3(new Vector3(ne.cx - 13, DECK_Y - 0.6, ne.cz - 13), new Vector3(ne.cx + 13, DECK_Y + 3, ne.cz + 13)) });

  // ── ROUTE V2 / LOOP F — the west high route. ──
  {
    // Two and a half metres proud of the west block's plaza face, so the fire escape clears
    // the storefront piers below it instead of growing out of an awning.
    const fx = west.cx + west.w * 0.5 + 2.6;   // -26.4
    // Flight 1 (ground → 6.8), half-landing, flight 2 (6.8 → 13.6).
    stairRun(fx, -16.0, 0, fx, -8.0, DECK_Y, 1.8);
    deck(fx, -6.6, 2.4, 2.8, DECK_Y, 0, true);
    stairRun(fx, -5.2, DECK_Y, fx, 2.8, DECK2_Y, 1.8);
    // The catwalk itself: 16 m at four storeys, hugging the west facade. From up here you
    // look down the length of the plaza and straight out the east radial street.
    deck(fx, 11.0, 2.4, 16, DECK2_Y, 0, true);
    for (let z = 4; z <= 18; z += 3.5) {
      boxAt('metal', 2.0, 0.18, 0.18, fx - 1.2, DECK2_Y - 0.6, z, 0, true);
      boxAt('metal', 0.16, 2.2, 0.16, fx, DECK2_Y - 1.2, z, -0.5, true);
    }
    // Down again in two flights to the south-west street mouth. LOOP F closes on foot.
    stairRun(fx, 19.4, DECK2_Y, fx, 28.0, DECK_Y, 1.8);
    deck(fx, 29.4, 2.4, 2.8, DECK_Y, 0, true);
    stairRun(fx, 30.8, DECK_Y, fx, 39.4, 0, 1.8);
    zones.push({ id: 'catwalk_west', box: new Box3(new Vector3(fx - 1.6, DECK2_Y - 0.6, 2), new Vector3(fx + 1.6, DECK2_Y + 2.6, 20)) });
    practicals.push({
      // Was HOT — a reserved enemy hue (ART §9) on a 13.6 m catwalk the player lives on.
      // GOLD instead, and it now lays a pool, so the catwalk reads as a surface you stand on.
      position: new Vector3(fx, DECK2_Y + 2.2, 11), color: PALETTE.GOLD,
      intensity: 4, radius: 16, coneRadius: 2.2, poolRadius: 3.4, flicker: 0.8, groundY: DECK2_Y,
    });
    cylAt('emissive', 0.18, 0.32, fx, DECK2_Y + 2.2, 11);
    cylAt('metal', 0.07, 2.0, fx, DECK2_Y + 1.2, 11);
    // A second lamp at the north end. One lamp on a 16 m catwalk lit a third of it and left
    // the rest as cool silhouette against a cool wall — the same "no warm pixel above 6.8 m"
    // failure as the NE roof. Two pools make the catwalk a lit route from either approach.
    practicals.push({
      position: new Vector3(fx, DECK2_Y + 2.2, 5), color: PALETTE.GOLD,
      intensity: 4, radius: 16, coneRadius: 2.2, poolRadius: 3.4, flicker: 0.45, groundY: DECK2_Y,
    });
    cylAt('emissive', 0.18, 0.32, fx, DECK2_Y + 2.2, 5);
    cylAt('metal', 0.07, 2.0, fx, DECK2_Y + 1.2, 5);
    /**
     * ─────────────────────────────────────────────────────────────────────────────────────
     * BULKHEAD LIGHTS ON THE WALL THE CATWALK HUGS.
     *
     * The catwalk measured as the worst frame in the map: 13.9% warm chromatic pixels against
     * the plaza's 46%, and 53% of its pixels in the 0.1–0.2 band. The reason is geometric —
     * at 13.6 m, 2.6 m off a 34 m facade, roughly half of every frame IS that wall, and the
     * two GOLD route lamps light the deck, not the wall. A pool cannot fix a vertical
     * surface: it is a disc laid on the floor.
     *
     * So the wall gets the fixture a real fire-escape wall carries — a bulkhead every 4 m,
     * `trim` housing + `emissive` lens, warm SODIUM, with a small pool that lands back on the
     * walkway. Six of them, and the run of them is also a distance ruler down a 16 m route.
     * ─────────────────────────────────────────────────────────────────────────────────────
     */
    const wallX = west.cx + west.w * 0.5 + 0.42;   // just proud of the block face at -29
    for (let z = 3.5; z <= 19; z += 3.1) {
      boxAt('trim', 0.30, 0.62, 0.52, wallX, DECK2_Y + 2.05, z, Math.PI * 0.5, true);
      boxAt('emissive', 0.22, 0.44, 0.40, wallX + 0.18, DECK2_Y + 2.05, z, Math.PI * 0.5, true);
      practicals.push({
        position: new Vector3(wallX + 0.2, DECK2_Y + 2.05, z), color: PALETTE.SODIUM,
        intensity: 2.6, radius: 11, coneRadius: 0, poolRadius: 2.9, flicker: 0.3,
        groundY: DECK2_Y, raised: true,
      });
    }
  }

  // ── ROUTE V3 / LOOP G — the south loading dock canopy the containers reach. ──
  {
    const south = BLOCKS.find((b) => b.id === 'south') as BlockSpec;
    const dz = south.cz - south.d * 0.5 - 0.6;
    // A 1.2 m dock platform: the classic vault height, running 26 m along the block.
    boxAt('trim', 26, 1.2, 4.0, south.cx - 6, 0.6, dz - 2.0, south.yaw);
    B.collideBox(26, 1.2, 4.0, south.cx - 6, 0.6, dz - 2.0, south.yaw, 'concrete');
    B.add('grime', flatRect(south.cx - 6, dz - 2.0, 30, 8, 0.021, south.yaw), undefined, [south.cx - 6, dz]);
    // Steps at both ends so the dock is never a wall.
    stairRun(south.cx - 19.5, dz - 2.0, 1.2, south.cx - 22.5, dz - 2.0, 0, 2.0);
    stairRun(south.cx + 7.5, dz - 2.0, 1.2, south.cx + 10.5, dz - 2.0, 0, 2.0);
    // Roller doors + bumpers: human scale, and a colour beat on a long dark face.
    for (let i = 0; i < 4; i++) {
      const x = south.cx - 16 + i * 6.6;
      boxAt('metal', 4.2, 3.6, 0.28, x, 3.0, dz, south.yaw, true);
      for (let k = 0; k < 7; k++) boxAt('grime', 4.0, 0.1, 0.34, x, 1.5 + k * 0.48, dz, south.yaw, true);
      boxAt('hot', 4.6, 0.4, 0.4, x, 4.95, dz, south.yaw, true);
      for (const s of [-1, 1]) boxAt('rust', 0.4, 0.5, 0.36, x + s * 2.4, 1.4, dz - 0.1, south.yaw, true);
    }
    // The canopy the containers deliver you onto, at 4.4 m.
    boxAt('metal', 28, 0.3, 4.6, south.cx - 6, 4.4, dz - 2.2, south.yaw);
    B.collideBox(28, 0.35, 4.6, south.cx - 6, 4.4, dz - 2.2, south.yaw, 'metal');
    for (let i = 0; i <= 7; i++) {
      const x = south.cx - 20 + i * 4;
      boxAt('metal', 0.18, 3.1, 0.18, x, 2.9, dz - 4.3, south.yaw, true);
    }
    railing(south.cx - 20, dz - 4.5, south.cx + 8, dz - 4.5, 4.55);
    zones.push({ id: 'dock_south', box: new Box3(new Vector3(south.cx - 20, 0, dz - 5), new Vector3(south.cx + 8, 6, dz + 1)) });
  }

  // An overhead gantry crossing the plaza — not walkable, pure depth layering.
  {
    const y = 15.0;
    boxAt('metal', 0.7, 0.7, 54, 4.0, y, -2.0, 0.05);
    for (let i = -24; i <= 24; i += 6) {
      boxAt('metal', 0.2, 1.8, 0.2, 4.0 + i * 0.05, y - 0.9, i - 2.0, 0.4, true);
      boxAt('metal', 2.6, 0.16, 0.16, 4.0 + i * 0.05, y + 0.5, i - 2.0, 0.05, true);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.7 LANDMARKS — water tower, marquee, billboard, crashed bus, monument.
  // ═══════════════════════════════════════════════════════════════════════════

  function addWordLater(
    text: string, x: number, y: number, z: number, yaw: number, height: number,
    // NOTE THE ABSENCE OF `HOT` AND `ACID`. ART §9 reserves both hues to enemies, and a word
    // texture is a saturated fill at eye height — exactly the "large surface" the rule bans.
    // If you need a threat colour on a sign, you do not: use SODIUM or RUST.
    fill: 'GOLD' | 'PAPER' | 'SODIUM' | 'RUST' | 'ELECTRIC' | 'BONE', emissive: boolean, rotate = 0,
  ): void {
    const key = `${text}|${fill}|${emissive}`;
    let entry = posterQuads.get(key);
    if (!entry) {
      const wt = makeWordTexture(text, { fill, bang: false, rotate, skew: 0.06, jitter: 0.5, halftone: !emissive, seed: 7 });
      entry = { tex: wt.texture, aspect: wt.aspect, geos: [], emissive };
      posterQuads.set(key, entry);
    }
    const q = wobbleQuad(height * entry.aspect, height, Math.round(x * 7 + z * 3) + 1, 0.02);
    place(q, { ry: yaw, x, y, z });
    entry.geos.push(q);
  }

  // ── Water tower on the tallest block. The thing you navigate by, 48 m up. ──
  {
    const bx = west.cx;
    const bz = west.cz - 8;
    const baseY = blockH(west) + 1.1;
    for (const [lx, lz] of [[-3.2, -3.2], [3.2, -3.2], [3.2, 3.2], [-3.2, 3.2]] as [number, number][]) {
      B.stamp('metal', P.cyl, { sx: 0.5, sy: 8.0, sz: 0.5, rx: lz * 0.03, rz: -lx * 0.03, x: bx + lx, y: baseY + 4.0, z: bz + lz });
      boxAt('metal', 0.2, 0.2, 8.4, bx + lx * 0.5, baseY + 5.2, bz, Math.atan2(lx, 0), true);
    }
    boxAt('metal', 8.6, 0.32, 8.6, bx, baseY + 8.1, bz, 0.04);
    B.stamp('metal', P.cyl12, { sx: 8.6, sy: 7.2, sz: 8.6, x: bx, y: baseY + 11.8, z: bz });
    B.stamp('trim', P.cyl12, { sx: 9.0, sy: 0.36, sz: 9.0, x: bx, y: baseY + 8.6, z: bz });
    B.stamp('trim', P.cyl12, { sx: 9.0, sy: 0.36, sz: 9.0, x: bx, y: baseY + 15.0, z: bz });
    B.stamp('rust', P.cone, { sx: 9.8, sy: 3.2, sz: 9.8, x: bx, y: baseY + 17.0, z: bz });
    cylAt('metal', 0.12, 2.4, bx, baseY + 19.8, bz);
    cylAt('emissive', 0.26, 0.42, bx, baseY + 21.0, bz);
    // Walkway ring + ladder (0.55 m rungs — a ladder is a ruler).
    B.stamp('metal', P.cyl12, { sx: 10.4, sy: 0.18, sz: 10.4, x: bx, y: baseY + 9.4, z: bz });
    for (let i = 0; i < 15; i++) {
      boxAt('metal', 0.6, 0.07, 0.07, bx + 4.6, baseY + 0.5 + i * 0.55, bz, 0, true);
    }
    addWordLater('INK CITY', bx + 4.45, baseY + 12.0, bz, Math.PI * 0.5, 3.4, 'PAPER', false, -2);
    practicals.push({
      // A lit sign is not a threat. SODIUM.
      position: new Vector3(bx, baseY + 21.0, bz), color: PALETTE.SODIUM,
      intensity: 3, radius: 18, coneRadius: 0, poolRadius: 0, flicker: 0.85, groundY: baseY, raised: true,
    });
  }

  // ── The marquee: a giant lit sign on the north block, facing the plaza across 60 m. ──
  {
    const north = BLOCKS.find((b) => b.id === 'north') as BlockSpec;
    const z = north.cz + north.d * 0.5 + 0.9;
    const y = 12.5;
    boxAt('wall', 24, 6.4, 1.0, -8, y, z + 0.5, north.yaw);
    boxAt('emissive', 24.6, 0.4, 0.6, -8, y + 3.4, z + 0.65, north.yaw, true);
    boxAt('emissive', 24.6, 0.4, 0.6, -8, y - 3.4, z + 0.65, north.yaw, true);
    for (let i = -11; i <= 11; i++) {
      B.stamp('emissive', P.plate, { sx: 0.34, sy: 0.34, sz: 0.34, x: -8 + i * 1.06, y: y + 3.4, z: z + 0.9 });
      B.stamp('emissive', P.plate, { sx: 0.34, sy: 0.34, sz: 0.34, x: -8 + i * 1.06, y: y - 3.4, z: z + 0.9 });
    }
    // Offset to x = -8, not centred: from the player spawn the 16 m obelisk sits on the
    // plaza's axis and would eat a centred marquee whole. The landmark has to be readable
    // from the one shot the whole arena is composed for.
    // SODIUM, not HOT. This is a 4.4 m emissive word and it is the focal point of the spawn
    // shot: at HOT it registered as 2.4–9.2% enemy-pink pixels in every frame facing it, on
    // the single most-looked-at object in the arena. It is a street sign, not a threat.
    addWordLater('DEADLINE', -8, y, z + 1.1, 0, 4.4, 'SODIUM', true, -1.5);
    for (const sx of [-11, 11]) boxAt('metal', 0.24, 0.24, 2.4, -8 + sx, y + 2.8, z - 0.4, 0, true);
    practicals.push({
      // THE BIGGEST POOL IN THE LEVEL, and it used to be HOT — a 14 m disc of enemy-pink
      // on the plaza floor, which is the single worst thing you can do to ART §9. GOLD: the
      // marquee is a landmark you navigate by, and it now lights the plaza's north edge.
      position: new Vector3(-8, y - 3.4, z + 0.9), color: PALETTE.GOLD,
      intensity: 7, radius: 34, coneRadius: 6.4, poolRadius: 16.0, flicker: 0.7, groundY: 0,
    });

    // A vertical blade sign further along the same facade — three storeys of neon.
    boxAt('wall', 0.8, 11.0, 2.6, 15.5, 10.5, z + 1.0, north.yaw);
    boxAt('emissive', 1.0, 11.4, 0.34, 15.5, 10.5, z + 2.2, north.yaw, true);
    addWordLater('OPEN', 15.1, 10.5, z + 2.35, -Math.PI * 0.5, 2.1, 'ELECTRIC', true, 0);
    practicals.push({
      // The one COLD practical on the plaza, matched to the `neon` bucket. Three storeys of
      // teal neon against sixteen sodium lamps is what makes the sodium read as warm.
      position: new Vector3(15.5, 10.5, z + 2.2), color: COLD_NEON,
      intensity: 5, radius: 22, coneRadius: 3.2, poolRadius: 8.0, flicker: 0.9, groundY: 0,
    });
  }

  // ── The SE roof billboard: a 30 m sign on legs, 34 m up. Visible from everywhere, and
  //    it puts a hard graphic shape in the sky over the tallest corner of the map. ──
  {
    const se = BLOCKS.find((b) => b.id === 'se') as BlockSpec;
    const topY = blockH(se) + STOREY * 2 + 1.5;
    const bx = se.cx - 2;
    const bz = se.cz - 10;
    for (let i = -3; i <= 3; i++) {
      boxAt('metal', 0.28, 6.0, 0.28, bx + i * 3.6, topY + 3.0, bz, 0, true);
      boxAt('metal', 0.2, 0.2, 3.2, bx + i * 3.6, topY + 4.5, bz - 1.4, 0.5, true);
    }
    boxAt('wall', 24, 8.0, 0.7, bx, topY + 8.5, bz, -0.03);
    boxAt('trim', 24.8, 0.5, 1.0, bx, topY + 12.7, bz, -0.03, true);
    boxAt('trim', 24.8, 0.5, 1.0, bx, topY + 4.3, bz, -0.03, true);
    addWordLater('SURVIVE', bx, topY + 8.5, bz - 0.5, Math.PI, 4.6, 'GOLD', true, 2);
    for (const sx of [-9, 0, 9]) {
      boxAt('emissive', 0.5, 0.5, 0.6, bx + sx, topY + 3.6, bz - 0.7, 0, true);
      practicals.push({
        // Generic floodlights, not an interactable: SODIUM. GOLD is now a gameplay signal.
        position: new Vector3(bx + sx, topY + 3.6, bz - 0.9), color: PALETTE.SODIUM,
        intensity: 2.5, radius: 16, coneRadius: 0, poolRadius: 0, flicker: 0.2, groundY: topY, raised: true,
      });
    }
  }

  // ── The crashed bus: a huge silhouette in the south ring, half blocking the lane. ──
  {
    const bx = 10;
    const bz = RING_LANE - 2;
    const yaw = 0.42;
    const roll = -0.09;
    const put = (
      id: BucketId, w: number, h: number, d: number, ox: number, oy: number, oz: number,
    ): void => {
      const x = bx + ox * Math.cos(yaw) - oz * Math.sin(yaw);
      const z = bz + ox * Math.sin(yaw) + oz * Math.cos(yaw);
      B.stamp(id, Math.min(w, h, d) < PLATE_MAX ? P.plate : P.box, { sx: w, sy: h, sz: d, rz: roll, ry: yaw, x, y: oy, z });
    };
    put('hot', 2.6, 2.3, 11.5, 0, 1.45, 0);           // body
    put('glass', 2.68, 0.95, 8.5, 0, 2.05, -0.4);     // window band, proud of the panels
    put('metal', 2.7, 0.1, 8.5, 0, 2.58, -0.4);       // drip rail over the glass
    put('metal', 2.7, 0.1, 8.5, 0, 1.56, -0.4);       // waist rail under it
    put('hot', 2.42, 0.55, 10.8, 0, 2.85, 0.2);       // roof
    put('trim', 2.74, 0.26, 11.6, 0, 0.42, 0);        // skirt
    put('hot', 2.5, 1.7, 1.3, 0, 1.15, -6.1);         // crumpled nose
    put('glass', 2.4, 0.9, 0.3, 0, 2.05, -6.2);       // windscreen, caved in
    put('metal', 2.7, 0.35, 0.5, 0, 1.5, -6.7);
    put('emissive', 1.5, 0.42, 0.16, 0, 2.62, -6.25); // destination blind, still lit
    put('emissive', 0.55, 0.35, 0.2, -0.9, 1.9, -6.8);
    put('emissive', 0.55, 0.35, 0.2, 0.9, 1.9, -6.8);
    for (const [wx, wz] of [[-1.25, -4.0], [1.25, -4.0], [-1.25, 3.8], [1.25, 3.8]] as [number, number][]) {
      const x = bx + wx * Math.cos(yaw) - wz * Math.sin(yaw);
      const z = bz + wx * Math.sin(yaw) + wz * Math.cos(yaw);
      B.stamp('metal', P.cyl, { sx: 1.05, sy: 0.42, sz: 1.05, rz: Math.PI * 0.5 + roll, ry: yaw, x, y: 0.52, z });
    }
    B.collideBox(2.9, 3.4, 11.7, bx, 1.7, bz, yaw, 'metal');
    B.add('grime', flatRect(bx + 1.2, bz - 0.8, 5.2, 14, 0.019, yaw), undefined, [bx, bz]);
    addWordLater('OUT OF SERVICE', bx + Math.cos(yaw) * 1.38, 2.35, bz + Math.sin(yaw) * 1.38, Math.PI * 0.5 + yaw, 0.55, 'PAPER', false, 1);
    reserve(bx, bz, 4.0, 7.5);
    zones.push({ id: 'bus', box: new Box3(new Vector3(bx - 8, 0, bz - 9), new Vector3(bx + 8, 5, bz + 9)) });
  }

  // ── Plaza monument: the centre of the composition, and waist-high cover.
  //    Scaled to hold a 58 m plaza — a 5 m dais would vanish in it. ──
  {
    B.add('walk', flatPoly(ngon(0, 0, 10.0, 12, 0.02, rng), 0.2));
    B.stamp('trim', P.cyl12, { sx: 20.4, sy: 0.22, sz: 20.4, x: 0, y: 0.11, z: 0 });
    B.stamp('trim', P.cyl12, { sx: 17.6, sy: 0.22, sz: 17.6, x: 0, y: 0.32, z: 0 });
    B.collideBox(18.6, 0.46, 18.6, 0, 0.22, 0, 0.3, 'concrete');
    // Two steps up to the dais — the vault/mantle warm-up, and a ruler at the centre.
    for (let i = 0; i < 3; i++) {
      B.stamp('trim', P.cyl12, { sx: 12.0 - i * 1.2, sy: 0.19, sz: 12.0 - i * 1.2, x: 0, y: 0.42 + i * 0.19, z: 0 });
      B.collideBox(11.6 - i * 1.2, 0.2, 11.6 - i * 1.2, 0, 0.42 + i * 0.19, 0, 0.3, 'concrete');
    }
    boxAt('mass', 4.2, 2.2, 4.2, 0, 2.1, 0, 0.18);
    boxAt('trim', 4.8, 0.36, 4.8, 0, 3.35, 0, 0.18, true);
    // A tapered obelisk, 16 m — reads from the far wall, 70 m away.
    B.stamp('mass', P.box, { sx: 2.6, sy: 11.0, sz: 2.6, ry: 0.18, x: 0, y: 9.0, z: 0 });
    B.stamp('mass', P.cone, { sx: 3.0, sy: 2.6, sz: 3.0, ry: 0.18, x: 0, y: 15.8, z: 0 });
    B.stamp('emissive', P.cone, { sx: 1.3, sy: 1.6, sz: 1.3, ry: 0.18, x: 0, y: 17.4, z: 0 });
    B.collideBox(4.4, 16, 4.4, 0, 8, 0, 0.18, 'concrete');
    addWordLater('1954', 0, 4.2, 2.2, 0, 0.9, 'GOLD', false, -1);
    practicals.push({
      position: new Vector3(0, 17.4, 0), color: PALETTE.GOLD,
      intensity: 6, radius: 30, coneRadius: 0, poolRadius: 13.0, flicker: 0.25, groundY: 0.22,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.8 STREET FURNITURE — the scale ruler, laid down the sightlines.
  //
  //     Everything here exists for one reason: a 140 m street only READS as 140 m if
  //     known-size objects recede down it. Rows beat size. Every row below is a row.
  // ═══════════════════════════════════════════════════════════════════════════

  /** A 6.5 m boulevard lamp: pole, arm, hood, lens. Plates and a cylinder — ~70 triangles. */
  const boulevardLamp = (x: number, z: number, yaw: number, practical: boolean): void => {
    cylAt('metal', 0.13, 6.5, x, 3.25, z);
    boxAt('trim', 0.44, 0.5, 0.44, x, 0.25, z, yaw, true);
    const ax = x + Math.cos(yaw) * 1.1;
    const az = z - Math.sin(yaw) * 1.1;
    boxAt('metal', 2.4, 0.16, 0.16, (x + ax) / 2, 6.4, (z + az) / 2, yaw, true);
    boxAt('metal', 1.1, 0.3, 0.5, ax, 6.15, az, yaw, true);
    boxAt('emissive', 0.9, 0.14, 0.38, ax, 5.96, az, yaw, true);
    B.collideBox(0.4, 6.5, 0.4, x, 3.25, z, 0, 'metal');
    reserve(x, z, 0.8, 0.8);
    B.add('grime', flatRect(x + 0.5, z - 0.4, 2.6, 2.6, 0.02, yaw), undefined, [x, z]);
    if (practical) {
      practicals.push({
        // THE STREET'S OWN COLOUR. Sixteen of these march down every 140 m sightline and
        // they were all GOLD, which is why BUILD 001's frame was 30% gold and why nothing
        // GOLD could read as "interactable" any more. SODIUM is what a real street is lit
        // by, and the bigger pool is what makes a 140 m road read as a receding rhythm of
        // lit islands instead of one even wash.
        position: new Vector3(ax, 5.9, az), color: PALETTE.SODIUM,
        intensity: 6.5, radius: 18, coneRadius: 3.2, poolRadius: 8.5,
        flicker: rng.range(0.12, 0.5), groundY: 0,
      });
    }
  };

  /**
   * LAMP ROWS — the depth cue. One row down each of the four 140 m sightline streets and
   * one down each ring straight, alternating sides so the perspective reads as a corridor.
   * Only every third lamp gets a real practical: `lighting.ts` promotes the first N specs to
   * real point lights (6 at HIGH), the rest are drawn cones, so ORDER MATTERS — the
   * landmarks above are pushed first on purpose.
   */
  /** Outer kerb of a sightline street — where the lamps stand. Poles take the inner kerb. */
  const KERB_OUT = RADIAL + 3.4;   // 28.4
  const KERB_IN = RADIAL - 3.4;    // 21.6
  for (const s of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      const t = -ARENA_HALF + 10 + i * 15;   // -60 … 60 every 15 m
      if (Math.abs(t) < 4) continue;                       // don't stand on the plaza axis
      if (Math.abs(Math.abs(t) - KERB_OUT) < 4) continue;  // don't collide with the crossing row
      boulevardLamp(s * KERB_OUT, t, s > 0 ? -Math.PI * 0.5 : Math.PI * 0.5, i % 3 === 1);
      boulevardLamp(t, s * KERB_OUT, s > 0 ? Math.PI : 0, i % 3 === 2);
    }
  }
  // Ring boulevard: the lamps stand on the BUILDING-side pavement, not against the wall —
  // the wall side is where the spawn doorways are and a lamp in a doorway is a blocker.
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI * 0.5;
    for (let k = 0; k < 8; k++) {
      const t = -ARENA_HALF + 12 + k * 16;
      const x = (RING_OUT + 2.5) * Math.cos(a) - t * Math.sin(a);
      const z = (RING_OUT + 2.5) * Math.sin(a) + t * Math.cos(a);
      if (Math.abs(x) > ARENA_HALF - 6 || Math.abs(z) > ARENA_HALF - 6) continue;
      boulevardLamp(x, z, a + Math.PI, k === 3);
    }
  }

  /** A parked car. ~4.4 m long, 1.45 m tall — the object everybody can size at a glance. */
  const parkedCar = (x: number, z: number, yaw: number, body: BucketId): void => {
    const put = (id: BucketId, w: number, h: number, d: number, ox: number, oy: number, oz: number): void => {
      B.stamp(id, Math.min(w, h, d) < PLATE_MAX ? P.plate : P.box, {
        sx: w, sy: h, sz: d, ry: yaw,
        x: x + ox * Math.cos(yaw) - oz * Math.sin(yaw),
        y: oy,
        z: z + ox * Math.sin(yaw) + oz * Math.cos(yaw),
      });
    };
    put(body, 1.82, 0.72, 4.4, 0, 0.72, 0);
    put(body, 1.66, 0.62, 2.3, 0, 1.32, 0.1);
    put('glass', 1.72, 0.5, 2.16, 0, 1.34, 0.08);
    put('trim', 1.88, 0.14, 4.5, 0, 0.42, 0);
    put('metal', 1.7, 0.2, 0.18, 0, 0.78, -2.22);
    put('emissive', 0.44, 0.2, 0.14, -0.6, 0.86, -2.26);
    put('emissive', 0.44, 0.2, 0.14, 0.6, 0.86, -2.26);
    put('hot', 0.4, 0.18, 0.14, -0.6, 0.86, 2.26);
    put('hot', 0.4, 0.18, 0.14, 0.6, 0.86, 2.26);
    for (const [wx, wz] of [[-0.86, -1.42], [0.86, -1.42], [-0.86, 1.46], [0.86, 1.46]] as [number, number][]) {
      B.stamp('crack', P.cyl6, {
        sx: 0.64, sy: 0.26, sz: 0.64, rz: Math.PI * 0.5, ry: yaw,
        x: x + wx * Math.cos(yaw) - wz * Math.sin(yaw), y: 0.32,
        z: z + wx * Math.sin(yaw) + wz * Math.cos(yaw),
      });
    }
    B.collideBox(1.95, 1.6, 4.5, x, 0.8, z, yaw, 'metal');
    reserve(x, z, 1.6, 2.8);
    B.add('grime', flatRect(x + 0.7, z - 0.5, 3.4, 6.0, 0.019, yaw), undefined, [x, z]);
  };

  /**
   * PARKED CARS at the kerb, in rows, down the ring straights and the sightline streets.
   * Fourteen of them for ~6 k triangles, and they do more for perceived scale than any
   * single building — a street with cars parked along it cannot read as a corridor.
   */
  {
    const carBodies: BucketId[] = ['hot', 'metal', 'rust', 'trim'];
    let ci = 0;
    // Kerbside parking IS the sightline dressing, so it deliberately ignores the sightline
    // keep-out (see `free`) — it still respects every other footprint.
    const park = (x: number, z: number, yaw: number): void => {
      if (!free(x, z, 2.2, false)) return;
      parkedCar(x, z, yaw + rng.spread(0.05), carBodies[ci++ % carBodies.length] as BucketId);
    };
    for (const s of [-1, 1]) {
      for (const t of [-46, -34, 36, 48]) park(s * (RADIAL + 2.8), t, 0);
      for (const t of [-48, -36, 34, 46]) park(t, s * (RADIAL + 2.8), Math.PI * 0.5);
    }
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI * 0.5;
      for (const t of [-44, -14, 16, 44]) {
        const x = (RING_OUT + 6.5) * Math.cos(a) - t * Math.sin(a);
        const z = (RING_OUT + 6.5) * Math.sin(a) + t * Math.cos(a);
        park(x, z, a + Math.PI * 0.5);
      }
    }
  }

  /** Traffic signal: a 5.5 m mast with an arm and three lenses. Marks every junction. */
  const trafficLight = (x: number, z: number, yaw: number): void => {
    cylAt('metal', 0.14, 5.5, x, 2.75, z);
    boxAt('trim', 0.5, 0.4, 0.5, x, 0.2, z, yaw, true);
    const ax = x + Math.cos(yaw) * 2.6;
    const az = z - Math.sin(yaw) * 2.6;
    boxAt('metal', 5.4, 0.18, 0.18, (x + ax) / 2, 5.3, (z + az) / 2, yaw, true);
    boxAt('metal', 0.44, 1.5, 0.4, ax, 4.5, az, yaw, true);
    boxAt('hot', 0.3, 0.3, 0.16, ax, 5.0, az + 0.2, yaw, true);
    boxAt('emissive', 0.3, 0.3, 0.16, ax, 4.55, az + 0.2, yaw, true);
    B.collideBox(0.4, 5.5, 0.4, x, 2.75, z, 0, 'metal');
    reserve(x, z, 0.9, 0.9);
  };
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) {
      trafficLight(s * (RING_IN + 1.5), t * (RADIAL + 3.2), s > 0 ? Math.PI : 0);
      trafficLight(t * (RADIAL + 3.2), s * (RING_IN + 1.5), s > 0 ? -Math.PI * 0.5 : Math.PI * 0.5);
    }
  }

  /**
   * THE SOUTH COLONNADE — twelve columns at 3.6 m centres along the south block's plaza
   * face. A receding row of columns is the oldest depth cue in painting and it is still
   * the best one; it also gives the south side of the plaza real cover to kite through.
   */
  {
    const south = BLOCKS.find((b) => b.id === 'south') as BlockSpec;
    const cz = south.cz - south.d * 0.5 - 3.2;
    for (let i = 0; i < 12; i++) {
      const cx = -19.8 + i * 3.6;
      cylAt('trim', 0.42, 5.0, cx, 2.5, cz);
      boxAt('trim', 1.3, 0.4, 1.3, cx, 0.2, cz, 0, true);
      boxAt('trim', 1.2, 0.36, 1.2, cx, 4.85, cz, 0, true);
      B.collideBox(0.9, 5.0, 0.9, cx, 2.5, cz, 0, 'concrete');
      reserve(cx, cz, 0.9, 0.9);
    }
    boxAt('trim', 46, 0.9, 2.0, -1.8, 5.5, cz, 0);
    B.collideBox(46, 0.9, 2.0, -1.8, 5.5, cz, 0, 'concrete');
    boxAt('trim', 46.6, 0.34, 2.6, -1.8, 6.1, cz, 0, true);
    B.add('grime', flatRect(-1.8, cz, 46, 5.2, 0.022), undefined, [-1.8, cz]);
    /**
     * PRACTICALS UNDER THE LINTEL. The colonnade is a covered kite route and it shipped with
     * no light source of its own at all — it was lit only by the ambient floor while the open
     * plaza beside it took the full key, so the frame measured 24% under 0.1 luminance AND
     * 39% over 0.7 with only 36% midtone: a three-band horizontal sandwich, not a picture.
     * Four SODIUM lamps at 9 m centres with real ground pools give the row its own value
     * structure and turn the receding columns into alternating lit/dark bays, which is what
     * a colonnade is FOR (ART §6: "a light that does not land on the floor cannot stage a
     * space"). SODIUM, not GOLD — you cannot use a column, so it is not an interactable.
     */
    for (let i = 0; i < 4; i++) {
      const lx = -16.2 + i * 9.0;
      cylAt('emissive', 0.26, 0.2, lx, 4.7, cz);
      cylAt('metal', 0.05, 0.5, lx, 4.95, cz);
      practicals.push({
        position: new Vector3(lx, 4.7, cz), color: PALETTE.SODIUM,
        intensity: 4.5, radius: 14, coneRadius: 2.2, poolRadius: 6.4, flicker: 0.35, groundY: 0,
      });
    }
    zones.push({ id: 'colonnade', box: new Box3(new Vector3(-25, 0, cz - 3), new Vector3(22, 6, cz + 3)) });
  }

  /** Bus shelter — 2.4 m of glass and a lit ad panel. Three, on the ring boulevard. */
  const busShelter = (x: number, z: number, yaw: number): void => {
    for (const s of [-1, 1]) {
      boxAt('metal', 0.14, 2.4, 0.14, x + Math.cos(yaw) * s * 1.9, 1.2, z - Math.sin(yaw) * s * 1.9, yaw, true);
      boxAt('metal', 0.14, 2.4, 0.14, x + Math.cos(yaw) * s * 1.9 + Math.sin(yaw) * 1.3, 1.2, z - Math.sin(yaw) * s * 1.9 + Math.cos(yaw) * 1.3, yaw, true);
    }
    boxAt('metal', 4.4, 0.18, 1.8, x + Math.sin(yaw) * 0.65, 2.5, z + Math.cos(yaw) * 0.65, yaw, true);
    boxAt('glass', 4.0, 2.0, 0.1, x + Math.sin(yaw) * 1.3, 1.3, z + Math.cos(yaw) * 1.3, yaw, true);
    boxAt('emissive', 1.3, 1.9, 0.2, x + Math.cos(yaw) * 1.6, 1.3, z - Math.sin(yaw) * 1.6, yaw, true);
    boxAt('rust', 3.0, 0.14, 0.44, x, 0.5, z, yaw, true);
    B.collideBox(4.2, 2.5, 1.5, x + Math.sin(yaw) * 0.9, 1.25, z + Math.cos(yaw) * 0.9, yaw, 'metal');
    reserve(x, z, 2.6, 1.8);
    practicals.push({
      position: new Vector3(x + Math.cos(yaw) * 1.6, 1.9, z - Math.sin(yaw) * 1.6),
      color: COLD_NEON, intensity: 3, radius: 10, coneRadius: 0, poolRadius: 3.6, flicker: 0.35, groundY: 0,
    });
  };
  busShelter(RING_LANE - 5.5, -14, -Math.PI * 0.5);
  busShelter(-RING_LANE + 5.5, 16, Math.PI * 0.5);
  busShelter(-18, RING_LANE - 5.5, 0);

  /** Bench + hydrant + bollard row — the small print of a street. Plates, ~30 tris each. */
  {
    const bench = (x: number, z: number, yaw: number): void => {
      for (const s of [-1, 1]) boxAt('metal', 0.12, 0.44, 0.5, x + Math.cos(yaw) * s * 0.8, 0.22, z - Math.sin(yaw) * s * 0.8, yaw, true);
      for (let i = 0; i < 3; i++) boxAt('rust', 2.0, 0.09, 0.16, x + Math.sin(yaw) * (i * 0.2 - 0.2), 0.46, z + Math.cos(yaw) * (i * 0.2 - 0.2), yaw, true);
      for (let i = 0; i < 3; i++) boxAt('rust', 2.0, 0.16, 0.09, x + Math.sin(yaw) * 0.24, 0.62 + i * 0.18, z + Math.cos(yaw) * 0.24, yaw, true);
      B.collideBox(2.0, 0.9, 0.6, x, 0.45, z, yaw, 'wood');
      reserve(x, z, 1.3, 0.9);
    };
    const hydrant = (x: number, z: number): void => {
      cylAt('hot', 0.16, 0.62, x, 0.31, z);
      B.stamp('hot', P.cyl6, { sx: 0.42, sy: 0.18, sz: 0.42, x, y: 0.68, z });
      for (const s of [-1, 1]) B.stamp('hot', P.cyl6, { sx: 0.16, sy: 0.3, sz: 0.16, rz: Math.PI * 0.5, x: x + s * 0.2, y: 0.42, z });
      B.collideBox(0.4, 0.8, 0.4, x, 0.4, z, 0, 'metal');
      reserve(x, z, 0.6, 0.6);
    };
    for (const s of [-1, 1]) {
      bench(s * (RADIAL + 3.0), -12, s > 0 ? -Math.PI * 0.5 : Math.PI * 0.5);
      bench(-14, s * (RADIAL + 3.0), s > 0 ? Math.PI : 0);
      bench(s * 9, RING_IN - 3.5, s > 0 ? Math.PI : 0);
      hydrant(s * (RING_IN + 2.2), -8);
      hydrant(11, s * (RING_IN + 2.2));
      hydrant(s * (RING_LANE - 6.2), 30);
    }
    // Bollard rows guarding the plaza mouths — a rhythm of 0.9 m posts, four per mouth.
    for (const s of [-1, 1]) {
      for (const along of [-RADIAL, RADIAL]) {
        for (let k = -2; k <= 2; k++) {
          if (k === 0) continue;
          boxAt('trim', 0.22, 0.9, 0.22, along + k * 1.3, 0.45, s * (RING_IN - 1.0), 0, true);
          boxAt('trim', 0.22, 0.9, 0.22, s * (RING_IN - 1.0), 0.45, along + k * 1.3, 0, true);
        }
      }
    }
  }

  // ── Burn barrels: the classic zombies campfire. HOT practical, real flame shapes. ──
  for (const [x, z] of [
    [-17, 16], [35, 43], [-48, -25], [48, 17], [-9, -44], [40, -13], [-38, 48], [16, -34],
  ] as [number, number][]) {
    placeProp('barrel', x, z, rng.range(0, 3), 0, 1);
    for (let i = 0; i < 4; i++) {
      const a = rng.range(0, Math.PI * 2);
      B.stamp('emissive', P.cone, {
        sx: rng.range(0.25, 0.42), sy: rng.range(0.5, 1.1), sz: rng.range(0.25, 0.42),
        rx: rng.spread(0.3), rz: rng.spread(0.3),
        x: x + Math.cos(a) * 0.12, y: 1.0 + rng.range(0, 0.3), z: z + Math.sin(a) * 0.12,
      });
    }
    practicals.push({
      position: new Vector3(x, 1.25, z), color: PALETTE.RUST,
      intensity: 8, radius: 13, coneRadius: 1.3, poolRadius: 4.2, flicker: 1, groundY: 0,
    });
  }

  // ── Hand-placed cover: barriers and sandbags you vault. Spread over a 58 m plaza. ──
  const barrierLine = (x: number, z: number, yaw: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      const ox = (-(n - 1) / 2 + i) * 2.36;
      const px = x + ox * Math.cos(yaw);
      const pz = z + ox * Math.sin(yaw);
      B.stamp('trim', P.barrier, { ry: yaw + Math.PI * 0.5 + rng.spread(0.05), x: px, y: 0, z: pz });
      B.stamp('hot', P.plate, { sx: 0.5, sy: 0.28, sz: 0.9, ry: yaw + Math.PI * 0.5, x: px, y: 0.62, z: pz });
      B.collideBox(0.75, 0.9, 2.35, px, 0.45, pz, yaw + Math.PI * 0.5, 'concrete');
      reserve(px, pz, 1.5, 1.5);
      B.add('grime', flatRect(px + 0.35, pz - 0.25, 1.7, 2.9, 0.02, yaw + Math.PI * 0.5), undefined, [px, pz]);
    }
  };
  barrierLine(-13, -17, 0.08, 4);
  barrierLine(17, 12, Math.PI * 0.5 + 0.1, 4);
  barrierLine(-19, 9, Math.PI * 0.32, 3);
  barrierLine(-15, 15, 0.22, 3);
  // Ring-boulevard cover. Kept OFF the four sightline junctions on purpose: a 9 m line of
  // barriers where a radial street meets the ring is a wall across a kite lane, and the
  // horde has no vault. |along| here is always well clear of the RADIAL ±4 m band.
  barrierLine(RING_LANE - 3, 42, Math.PI * 0.5, 4);
  barrierLine(-RING_LANE + 3, -42, Math.PI * 0.5, 3);
  barrierLine(6, -RING_LANE + 3, 0, 4);
  barrierLine(-40, RING_LANE - 3, 0.05, 3);

  const sandbagRow = (x: number, z: number, yaw: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      for (let row = 0; row < 3; row++) {
        const ox = (-(n - 1) / 2 + i) * 0.62 + (row % 2) * 0.3;
        B.stamp('rust', P.rock, {
          sx: 0.78, sy: 0.42, sz: 0.55,
          ry: yaw + rng.spread(0.25),
          x: x + ox * Math.cos(yaw) + rng.spread(0.05),
          y: 0.2 + row * 0.34,
          z: z + ox * Math.sin(yaw) + rng.spread(0.05),
        });
      }
    }
    const len = n * 0.62;
    B.collideBox(len, 1.0, 0.7, x, 0.5, z, yaw, 'dirt');
    reserve(x, z, len * 0.5 + 0.6, 1.2);
    B.add('grime', flatRect(x + 0.4, z - 0.3, len + 1.2, 1.9, 0.02, yaw), undefined, [x, z]);
  };
  sandbagRow(6, -21, 0.12, 6);
  sandbagRow(-22, -4, Math.PI * 0.5, 5);
  sandbagRow(24, 34, Math.PI * 0.25, 5);
  sandbagRow(-39, 60, 0.05, 6);

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════
   * STAGING POOLS — the composition, as light.
   *
   * A colourist does not light a page evenly; they decide where the eye lands and they put
   * the light THERE. Everything above this point is a light attached to a lamp, which is
   * physically honest and compositionally mute: 140 m of evenly-spaced lamps produce 140 m
   * of even wash, and an even wash is exactly what the playtester was looking at.
   *
   * These have no emitter and no cone. They are pure ground pools, hung high enough to be
   * broad, placed on the ELEVEN NODES OF THE LEVEL GRAPH — the eight radial-street mouths
   * and the four ring corners — so that:
   *
   *   • every junction the player can turn at is a bright island, and the dark stretches
   *     between them are the connective tissue. That rhythm IS the depth cue: eight lit
   *     discs receding down a 140 m street reads as 140 m; one flat wash reads as a room.
   *   • a horde crossing a junction is backlit against a 0.75 pool for a beat, which is a
   *     free readability win at exactly the moment you need to count threats.
   *   • the plaza has a bright rim (the street mouths) and a bright centre (the monument),
   *     with a mid-value ring between them — a composition, not a floodlight.
   *
   * They cost NO extra draw call: pool-only specs merge into the existing SODIUM glow mesh.
   * ═════════════════════════════════════════════════════════════════════════════════════
   */
  const stagingPool = (x: number, z: number, radius: number, intensity: number, hex: number): void => {
    practicals.push({
      position: new Vector3(x, 7.4, z),
      color: hex, intensity, radius: radius * 1.6,
      coneRadius: 0, poolRadius: radius, flicker: 0, groundY: 0,
    });
  };
  for (const s of [-1, 1]) {
    // The four radial-street mouths where they meet the plaza, and again where they meet
    // the ring boulevard: the eight places a kite loop can change direction.
    stagingPool(s * RADIAL, 0, 11.0, 5.0, PALETTE.SODIUM);
    stagingPool(0, s * RADIAL, 11.0, 5.0, PALETTE.SODIUM);
    stagingPool(s * RADIAL, RING_LANE - 6, 9.0, 4.2, PALETTE.SODIUM);
    stagingPool(s * RADIAL, -RING_LANE + 6, 9.0, 4.2, PALETTE.SODIUM);
    stagingPool(RING_LANE - 6, s * RADIAL, 9.0, 4.2, PALETTE.SODIUM);
    stagingPool(-RING_LANE + 6, s * RADIAL, 9.0, 4.2, PALETTE.SODIUM);
  }
  // The four ring corners — the turns of LOOP A, and the furthest points from the plaza.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      stagingPool(sx * (RING_LANE - 2), sz * (RING_LANE - 2), 12.0, 4.6, PALETTE.SODIUM);
    }
  }

  // ── Scatter: everything else, seeded, never axis-perfect. ──
  // Counts are triangle-aware, not taste-aware: `rubble` is 414 triangles a piece and
  // `brokenWall` is 696, where a `plank` is 44. Density comes from the cheap kinds.
  const SCATTER: [PropKind, number][] = [
    ['barrel', 28], ['crate', 26], ['dumpster', 10], ['rubble', 8],
    ['plank', 30], ['pipe', 14], ['brokenWall', 7], ['fence', 8],
  ];
  for (const [kind, count] of SCATTER) {
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 60) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.bool(0.4) ? rng.range(9, 26) : rng.range(30, 66);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!free(x, z, propRadius[kind])) continue;
      placeProp(kind, x, z, rng.range(0, Math.PI * 2));
      placed++;
    }
  }

  // Clusters against walls: stacked crates, leaning planks, trash. Reads as *lived in*.
  for (let i = 0; i < 11; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = 60 + rng.range(0, 6);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (!free(x, z, 1.6)) continue;
    placeProp('crate', x, z, rng.range(0, 3));
    placeProp('crate', x + rng.spread(0.5), z + rng.spread(0.5), rng.range(0, 3), 0.78);
    if (rng.bool(0.6)) placeProp('barrel', x + rng.spread(1.8), z + rng.spread(1.8), rng.range(0, 3));
  }
  // Trash: squashed rocks, everywhere, no collision.
  for (let i = 0; i < 100; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(6, 67);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (Math.abs(x) > ARENA_HALF - 2 || Math.abs(z) > ARENA_HALF - 2) continue;
    B.stamp(rng.bool(0.4) ? 'rust' : 'trim', P.rock, {
      sx: rng.range(0.12, 0.5), sy: rng.range(0.08, 0.3), sz: rng.range(0.12, 0.5),
      ry: rng.range(0, 3.14), x, y: rng.range(0.04, 0.12), z,
    });
  }
  // Rubble skirts at the base of the perimeter wall.
  for (let i = 0; i < 16; i++) {
    const side = rng.int(0, 4);
    const a = side * Math.PI * 0.5;
    const along = rng.range(-62, 62);
    const x = Math.cos(a) * (ARENA_HALF - 2.0) - along * Math.sin(a);
    const z = Math.sin(a) * (ARENA_HALF - 2.0) + along * Math.cos(a);
    const g = rubblePile(rng.range(0.7, 1.4), 6, { seed: 200 + i });
    place(g, { ry: rng.range(0, 3.14), x, y: 0, z });
    B.add('trim', g, undefined, [x, z]);
  }

  /**
   * ── OVERHEAD WIRES + UTILITY POLES ──
   * Catenaries strung down the four sightline streets and across the ring. Free depth: a
   * wire that dips and rises overhead as you sprint is the strongest possible readout of
   * how much ground you just covered.
   */
  {
    const wireSpans: [number, number, number, number, number, number][] = [];
    const poleY = 8.4;
    for (const s of [-1, 1]) {
      // A pole every 15 m down each sightline street, on the INNER kerb (the lamps have the
      // outer one), wired end to end. Wire and lamp row on opposite kerbs is what makes the
      // street read as a corridor rather than as a line of objects.
      let prevZ = -ARENA_HALF + 10;
      for (let i = 1; i < 9; i++) {
        const z = -ARENA_HALF + 10 + i * 15;
        wireSpans.push([s * KERB_IN, poleY, prevZ, s * KERB_IN, poleY, z]);
        prevZ = z;
      }
      let pX = -ARENA_HALF + 10;
      for (let i = 1; i < 9; i++) {
        const x = -ARENA_HALF + 10 + i * 15;
        wireSpans.push([pX, poleY, s * KERB_IN, x, poleY, s * KERB_IN]);
        pX = x;
      }
    }
    // Two long diagonals across the plaza so the sky above the hub is not empty.
    wireSpans.push([-RING_IN + 2, 11, -RING_IN + 2, RING_IN - 2, 12, RING_IN - 2]);
    wireSpans.push([RING_IN - 2, 12, -RING_IN + 2, -RING_IN + 2, 11, RING_IN - 2]);

    for (const [x0, y0, z0, x1, y1, z1] of wireSpans) {
      const segs = 7;
      const sag = 1.9;
      let px = x0;
      let py = y0;
      let pz = z0;
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        const y = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * sag;
        const dx = x - px;
        const dy = y - py;
        const dz = z - pz;
        const len = Math.hypot(dx, dy, dz);
        const yaw = Math.atan2(dx, dz);
        const pitch = -Math.atan2(dy, Math.hypot(dx, dz));
        B.stamp('crack', P.plate, {
          sx: 0.06, sy: 0.06, sz: len * 1.02, rx: pitch, ry: yaw,
          x: (px + x) / 2, y: (py + y) / 2, z: (pz + z) / 2,
        });
        if (i === 4) {
          B.stamp('emissive', P.plate, { sx: 0.2, sy: 0.28, sz: 0.2, x, y: y - 0.2, z });
        }
        px = x; py = y; pz = z;
      }
      // The pole that carries the far end of this span.
      cylAt('rust', 0.17, poleY + 0.6, x1, (poleY + 0.6) * 0.5, z1);
      boxAt('rust', 2.2, 0.16, 0.16, x1, poleY + 0.2, z1, Math.atan2(x1 - x0, z1 - z0) + Math.PI * 0.5, true);
      B.collideBox(0.44, poleY, 0.44, x1, poleY * 0.5, z1, 0, 'wood');
      reserve(x1, z1, 0.8, 0.8);
    }
  }

  // ── Posters torn onto walls. Three textures, reused. ──
  {
    /**
     * THE RESERVED CHANNEL, ENFORCED (ART §9).
     *
     * This table used to be `[['HOT','DANGER'], ['ACID','INFECTED'], ['GOLD','CLOSED']]` and
     * it stamped sixteen saturated posters at eye height around the plaza edges, the block
     * faces and the perimeter wall — roughly five acid-green and six hot-pink. Measured with
     * the §9 squint method (blur to a 48×27 grid, per-cell `g - max(r,b)`), the strongest
     * ENVIRONMENT cell on the ring boulevard came out at +0.042 while an actual enemy at the
     * same pose measured +0.038. **The city was greener than the zombies.** No amount of
     * work on the enemy material can fix a background that is wearing the enemy's colour.
     *
     * Only non-reserved fills here. Ever.
     */
    const words: ['GOLD' | 'PAPER' | 'SODIUM', string][] = [
      ['GOLD', 'CLOSED'], ['PAPER', 'CONDEMNED'], ['SODIUM', 'KEEP OUT'],
    ];
    const spots: [number, number, number][] = [
      [-19, -29.6, 0], [21, -29.6, 0], [-29.6, -12, -Math.PI * 0.5],
      [29.6, 11, Math.PI * 0.5], [-12, 29.6, Math.PI], [13, 29.6, Math.PI],
      [-55.6, -40, Math.PI * 0.5], [55.6, 36, -Math.PI * 0.5], [-68.5, 24, -Math.PI * 0.5],
      [68.5, -44, Math.PI * 0.5], [-40, -68.5, 0], [36, 68.5, Math.PI],
      [-68.5, -18, -Math.PI * 0.5], [68.5, 12, Math.PI * 0.5], [18, -68.5, 0], [-24, 68.5, Math.PI],
    ];
    for (let i = 0; i < spots.length; i++) {
      const [x, z, yaw] = spots[i] as [number, number, number];
      const [fill, text] = words[i % words.length] as ['GOLD' | 'PAPER' | 'SODIUM', string];
      const nx = Math.sin(yaw) * 0.12;
      const nz = Math.cos(yaw) * 0.12;
      addWordLater(text, x + nx, rng.range(2.0, 3.6), z + nz, yaw, rng.range(0.8, 1.3), fill, false, rng.range(-6, 6));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.9 BACKGROUND SKYLINE — flat inked cutouts at three parallax depths.
  //     Cutouts, never geometry: three rings of quads cost 340 triangles total.
  // ═══════════════════════════════════════════════════════════════════════════

  {
    const rings: [number, number, number, number, number][] = [
      // radius, count, minH, maxH, colour-mix toward NIGHT_A
      [172, 38, 30, 90, 0.35],
      [256, 32, 50, 140, 0.68],
      [372, 28, 78, 210, 0.92],
    ];
    let ri = 0;
    for (const [radius, count, minH, maxH, fade] of rings) {
      const geos: BufferGeometry[] = [];
      const r2 = new Rng(4000 + ri * 131);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + r2.spread(0.05);
        const rr = radius * r2.range(0.94, 1.08);
        const h = r2.range(minH, maxH);
        const w = radius * r2.range(0.07, 0.16);
        const x = Math.cos(a) * rr;
        const z = Math.sin(a) * rr;
        const yaw = Math.atan2(x, z);
        const q = wobbleQuad(w, h, 900 + i * 7 + ri * 31, 0.012);
        place(q, { ry: yaw, x, y: h * 0.5, z });
        geos.push(q);
        // A stepped crown or a mast — the silhouette is the whole point.
        if (r2.bool(0.55)) {
          const cw = w * r2.range(0.3, 0.6);
          const ch = h * r2.range(0.06, 0.16);
          const q2 = wobbleQuad(cw, ch, 1900 + i, 0.02);
          place(q2, { ry: yaw, x: x + r2.spread(w * 0.2), y: h + ch * 0.5, z });
          geos.push(q2);
        }
        if (r2.bool(0.3)) {
          const q3 = wobbleQuad(w * 0.04, h * r2.range(0.12, 0.3), 2900 + i, 0.05);
          place(q3, { ry: yaw, x: x + r2.spread(w * 0.3), y: h * 1.12, z });
          geos.push(q3);
        }
        /**
         * THE SKYLINE HAS ITS LIGHTS ON — the two near rings only.
         *
         * The cutouts are single-value flats by design (that IS the parallax trick), and the
         * two nearest rings land on the sky's own value: NIGHT_B→NIGHT_A at 0.20 and 0.17
         * against a sky running 0.15→0.24. On the ground that is invisible, because buildings
         * cover it. On the high routes it is most of the frame, and it is measurably why a
         * roof frame histogrammed 59% of its pixels into the 0.1–0.2 band against the plaza's
         * 17%: two flats and a gradient, all within 0.07 of each other, and no third value
         * anywhere. A night skyline is not a silhouette — it is a silhouette WITH LIGHTS IN
         * IT, and the lights are the only thing giving it depth or scale.
         *
         * So a sparse scatter of lit panes on a fixed 5.4 × 6.2 m grid (a real floor pitch, so
         * the specks are a ruler at 172 m the same way `facade()`'s are at 20 m), one in ~11
         * lit, capped at nine per cutout, ~1 in 5 cold. They go into the existing `emissive`
         * and `neon` buckets, so the whole backdrop still costs ZERO extra draw calls; and
         * both buckets fog, so the far ring's specks sit further back on their own.
         */
        if (ri < 2) {
          const cols = Math.max(1, Math.floor(w / 5.4));
          const rows = Math.max(1, Math.floor((h - 8) / 6.2));
          const nx = Math.sin(yaw);
          const nz = Math.cos(yaw);
          let lit = 0;
          for (let c = 0; c < cols && lit < 9; c++) {
            for (let rw = 0; rw < rows && lit < 9; rw++) {
              if (!r2.bool(0.09)) continue;
              lit++;
              const u = (-(cols - 1) / 2 + c) * (w / Math.max(1, cols));
              const wy = 6 + rw * 6.2;
              boxAt(
                r2.bool(0.2) ? 'neon' : 'emissive', 2.4, 3.2, 0.3,
                x + Math.cos(yaw) * u - nx * 0.7, wy, z - Math.sin(yaw) * u - nz * 0.7,
                yaw, true,
              );
            }
          }
        }
      }
      const merged = mergeForStatic(geos);
      for (const g of geos) g.dispose();
      const mat = makeInkMaterial({
        color: PALETTE.INK,
        shadowColor: PALETTE.INK,
        rimStrength: 0,
        halftone: 0,
        specular: 0,
        fog: 0,
        side: 'double',
        emissive: PALETTE.NIGHT_B,
        emissiveIntensity: 1,
      });
      // Each ring sits further back in the colourist's flat wash — a two-token blend,
      // which is the only sanctioned way to make an in-between value (palette.ts §mix).
      (mat.uniforms.uEmissive!.value as Color).copy(color(PALETTE.NIGHT_B)).lerp(color(PALETTE.NIGHT_A), fade);
      const mesh = new Mesh(merged, mat);
      mesh.name = `skyline_${ri}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = -900 + ri;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
      extraMaterials.push(mat);
      extraMeshes.push(mesh);
      ri++;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.10 BAKE — merge every bucket cell, build the ink hulls, count the cost.
  // ═══════════════════════════════════════════════════════════════════════════

  const materials: InkMaterial[] = [];
  const meshes: Mesh[] = [];
  let triangles = 0;

  // Procedural surface grain. Five canvases, shared by every bucket — the arena never
  // pays for a texture twice, and `art/textures` caches them globally anyway.
  const surfaces: Record<string, SurfaceTextureSet> = makeSurfaceLibrary(512);
  // Two non-tiling decal atlases. Each is ONE texture serving an unlimited number of
  // visibly different signs, because the variety lives in the quads' UVs, not in the map.
  const atlases: Record<string, Texture> = { wallAd: makeWallAdSheet(512), poster: makePosterSheet(512) };

  for (const [id, bucket] of B.buckets) {
    const def = bucket.def;
    const surf = def.surface ? surfaces[def.surface] : undefined;
    const atlasTex = def.atlas ? atlases[def.atlas] : undefined;
    // ONE material per bucket, shared by all of its cells — a split costs draw calls, never
    // shader permutations, and the cells must be indistinguishable in the frame.
    const mat = makeInkMaterial({
      color: def.color,
      shadowColor: def.shadow,
      rimColor: def.rim,
      rimStrength: def.rimStrength,
      rimPower: def.rimPower,
      halftone: def.halftone,
      halftoneAngle: def.halftoneAngle,
      specular: def.specular,
      emissive: def.emissive,
      emissiveIntensity: def.emissiveIntensity,
      fog: def.fog,
      map: atlasTex ?? (surf ? surf.map : null),
      mapStrength: def.mapStrength,
      mapHalftone: def.mapHalftone,
      mapScale: def.mapScale,
      name: `Ink_${id}`,
    });
    mat.name = `Ink_${id}`;
    let used = false;

    for (const [key, cell] of bucket.cells) {
      if (cell.geos.length === 0) continue;
      const merged = mergeForStatic(cell.geos);
      for (const g of cell.geos) g.dispose();
      const mesh = new Mesh(merged, mat);
      mesh.name = key < 0 ? `arena_${id}` : `arena_${id}_${key}`;
      // Flat decals never cast: a painted mark and a pasted poster have no volume.
      mesh.castShadow = id !== 'ground' && id !== 'paint' && id !== 'grime' && id !== 'crack'
        && id !== 'walk' && id !== 'ad' && id !== 'bill';
      mesh.receiveShadow = true;
      /**
       * A split bucket is frustum-culled — that is the entire point of splitting it. An
       * unsplit bucket spans the whole map, so testing it can only ever cost time.
       */
      mesh.frustumCulled = key >= 0;
      if (def.bloom) markBloom(mesh);
      group.add(mesh);
      meshes.push(mesh);
      used = true;
      triangles += merged.getAttribute('position').count / 3;

      if (def.outline > 0 && cell.hulls.length > 0) {
        const hullGeo = mergeForStatic(cell.hulls);
        for (const g of cell.hulls) g.dispose();
        // Hulls are welded per-source-geometry BEFORE the merge (see `proto`) — that is what
        // stops the inverted-hull pass from exploding flat-shaded geometry into slivers, and
        // it means `weld: false` here skips a second, much more expensive weld of the whole
        // merged buffer. Welding post-merge would also fuse props that happen to touch.
        const hull = buildOutlineHull(hullGeo, { thickness: def.outline, weld: false });
        hull.frustumCulled = mesh.frustumCulled;
        mesh.add(hull);
        triangles += hullGeo.getAttribute('position').count / 3;
      } else {
        for (const g of cell.hulls) g.dispose();
      }
    }

    if (used) materials.push(mat);
    else mat.dispose();
  }

  // Poster / lettering meshes — one per unique word texture.
  for (const [, entry] of posterQuads) {
    const merged = mergeForStatic(entry.geos);
    for (const g of entry.geos) g.dispose();
    const mat = new MeshBasicMaterial({
      map: entry.tex,
      transparent: true,
      alphaTest: 0.28,
      depthWrite: true,
      color: entry.emissive ? color(PALETTE.PAPER) : color(PALETTE.BONE),
      toneMapped: !entry.emissive,
      side: DoubleSide,
    });
    mat.name = 'ArenaWord';
    const mesh = new Mesh(merged, mat);
    mesh.name = 'arena_words';
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    if (entry.emissive) markBloom(mesh);
    group.add(mesh);
    extraMaterials.push(mat);
    extraMeshes.push(mesh);
    triangles += merged.getAttribute('position').count / 3;
  }

  // Sky: the renderer owns the dome shader (clouds, moon, stars, screen-tone); the world
  // just places it and points the moon at the key light so the rig and the sky agree.
  const sky = buildSkyDome({
    // The sky is a fifth of the frame and BUILD 001 spent all of it under 0.1 luminance.
    // Both tokens were re-valued in the palette pass (NIGHT_A 0.10 → 0.15, NIGHT_B 0.17 →
    // 0.23), which turns a flat black ceiling into an actual gradient: dark navy zenith,
    // lit violet horizon, and the buildings' `mass` at 0.32 sitting cleanly on top of it.
    zenith: PALETTE.NIGHT_A,
    horizon: PALETTE.NIGHT_B,
    // The horizon glow is the city's own sodium light bouncing off the overcast — the same
    // ink as the street lamps, which is what ties the sky to the ground. RUST read as a
    // fire on the horizon and put a third warm hue in a frame that already had too few.
    glow: PALETTE.SODIUM,
    // Clouds are moonlit SHAPES on a sky, not a ceiling: a lifted INK_SOFT reads as a muddy
    // brown-violet smudge, which ART §1 forbids outright. NIGHT_B keeps the saturation and
    // PAPER gives the moon side a clean printed rim.
    cloud: PALETTE.NIGHT_B,
    cloudRim: PALETTE.PAPER,
    cloudCover: 0.38,
    stars: 0.85,
    moonSize: 0.13,
    moonDir: new Vector3(-0.52, 0.34, 0.46).normalize(),
  });
  setSkyMoonDir(sky.material as ShaderMaterial, new Vector3(-0.52, 0.34, 0.46));
  group.add(sky);
  extraMaterials.push(sky.material as ShaderMaterial);
  extraMeshes.push(sky);

  // Free the protos and the prop library — their geometry now lives in merged buffers.
  for (const p of protos) disposeProto(p);
  for (const [, e] of library) {
    disposeProto(e.body);
    if (e.accent) disposeProto(e.accent);
    disposeProp(e.build);
  }
  library.clear();

  const colliders = B.finishColliders();

  // ═══════════════════════════════════════════════════════════════════════════
  // 6.11 GAMEPLAY DATA — spawns, zones, bounds.
  // ═══════════════════════════════════════════════════════════════════════════

  const playerSpawn = { position: new Vector3(PLAYER_SPAWN.x, 0.1, PLAYER_SPAWN.z), yaw: PLAYER_SPAWN.yaw };
  const enemySpawns: Vector3[] = ENEMY_SPAWNS.map(([x, z]) => new Vector3(x, 0, z));

  zones.push({ id: 'plaza', box: new Box3(new Vector3(-RING_IN, 0, -RING_IN), new Vector3(RING_IN, 24, RING_IN)) });
  zones.push({ id: 'ring_n', box: new Box3(new Vector3(-ARENA_HALF, 0, -ARENA_HALF), new Vector3(ARENA_HALF, 24, -RING_OUT)) });
  zones.push({ id: 'ring_s', box: new Box3(new Vector3(-ARENA_HALF, 0, RING_OUT), new Vector3(ARENA_HALF, 24, ARENA_HALF)) });
  zones.push({ id: 'ring_e', box: new Box3(new Vector3(RING_OUT, 0, -RING_OUT), new Vector3(ARENA_HALF, 24, RING_OUT)) });
  zones.push({ id: 'ring_w', box: new Box3(new Vector3(-ARENA_HALF, 0, -RING_OUT), new Vector3(-RING_OUT, 24, RING_OUT)) });
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][]) {
    const tag = `${sz < 0 ? 'n' : 's'}${sx > 0 ? 'e' : 'w'}`;
    zones.push({
      id: `alley_${tag}_long`,
      box: new Box3(
        new Vector3(Math.min(sx * MAIN_HALF, sx * RING_IN), 0, Math.min(sz * RING_IN, sz * RING_OUT)),
        new Vector3(Math.max(sx * MAIN_HALF, sx * RING_IN), 24, Math.max(sz * RING_IN, sz * RING_OUT)),
      ),
    });
    zones.push({
      id: `alley_${tag}_cross`,
      box: new Box3(
        new Vector3(Math.min(sx * RING_IN, sx * RING_OUT), 0, Math.min(sz * MAIN_HALF, sz * RING_IN)),
        new Vector3(Math.max(sx * RING_IN, sx * RING_OUT), 24, Math.max(sz * MAIN_HALF, sz * RING_IN)),
      ),
    });
  }

  const bounds = new Box3(
    new Vector3(-ARENA_HALF + 0.6, -2, -ARENA_HALF + 0.6),
    new Vector3(ARENA_HALF - 0.6, 60, ARENA_HALF - 0.6),
  );

  const drawCalls = meshes.length + meshes.reduce((n, m) => n + m.children.length, 0) + extraMeshes.length;

  const dispose = (): void => {
    for (const m of meshes) {
      m.geometry.dispose();
      for (const c of m.children) {
        const h = c as Mesh;
        if (h.isMesh) {
          h.geometry.dispose();
          (h.material as Material).dispose();
        }
      }
    }
    for (const m of materials) m.dispose();
    for (const m of extraMeshes) m.geometry.dispose();
    for (const m of extraMaterials) m.dispose();
    for (const c of colliders) c.geometry.dispose();
    // Word and surface textures are NOT disposed here: they live in the global caches in
    // `art/letters` and `art/textures` and are shared with VFX word pops and every other
    // system. Teardown is `disposeWordTextures()` + `disposeArtTextures()`, once, at boot
    // shutdown — see the art-lib hand-off notes.
    group.clear();
  };

  return {
    group,
    playerSpawn,
    enemySpawns,
    bounds,
    zones,
    colliders,
    practicals,
    drawCalls,
    triangles: Math.round(triangles),
    dispose,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * COLOUR NOTES — CLOSED.  The space-scale agent left seven open colour decisions here for the
 * lighting/colour pass. All seven are taken. Kept as a record of what was decided and why,
 * because "why is the marquee gold and not pink" is exactly the question the next agent asks.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. FOG — TAKEN in `world/lighting.ts`. `FOG_NEAR/FOG_FAR` are now 56 / 230, authored against
 *    this 140 m block and its 198 m diagonal. `world/index.ts::fitFogToArena` derives exactly
 *    those two numbers, so its `Math.max` override is now the no-op it was designed to become
 *    and can be deleted by that file's owner without changing a pixel.
 * 2. SHADOW TEXEL — TAKEN. The answer turned out to be that `InkMaterial` cannot RECEIVE a
 *    shadow at all, so the map was costing a full depth pass of the city for zero pixels.
 *    Shadow casting is off, the camera is refitted to a 52 m focus box at 2048 (5.1 cm texel,
 *    was 17 cm) and `setShadowFocus()` exists for M2. See the SHADOWS block in `lighting.ts`.
 * 3. THE FOUR SIGHTLINE STREETS — TAKEN, as STAGING POOLS (search `stagingPool` above). Eleven
 *    emitterless ground pools on the level graph's nodes, so a 140 m street is a rhythm of lit
 *    islands rather than an even wash. NOTE: a real bug was found doing this — `pushPool` wound
 *    its fan clockwise in XZ, so EVERY ground light pool in BUILD 001 was backface-culled and
 *    never drew a fragment. Fixed in `lighting.ts`; that single fix is most of the staging.
 * 4. `mass` FLAT FROM PLINTH TO 34 m — TAKEN three ways: `SLATE` instead of `NIGHT_B` (0.32 vs
 *    0.17, and cool blue instead of violet), a dedicated `facade` surface texture (storey
 *    course, pilasters, soot streaks, patched render), and a corrected `mapScale` — see the
 *    `mapScale` doc comment above, the old values stretched a *fraction* of one tile across an
 *    entire building, which is why every wall was a flat colour with a dot screen on it.
 * 5. WALKABLE SURFACES — TAKEN. The NE roof deck, the west catwalk and the depot arcade now
 *    carry GOLD practicals with real ground pools; generic street lighting moved to SODIUM.
 *    GOLD means "you can use this or stand on this" again, which is ART §6's actual rule.
 * 6. SPAWN DOORWAYS — DECIDED: NO. They stay `grime` recesses. A HOT wash on 24 doorways is a
 *    reserved enemy hue on a permanent environment fixture (ART §9) and it would telegraph a
 *    spawn that has not happened yet. When the director wants to telegraph, that is a VFX
 *    event with a duration, not a paint job.
 * 7. THE SW LOT CONTAINERS — TAKEN. The whole `hot` bucket is `SODIUM` now, not `HOT`. Three
 *    12 m boxes of enemy-pink was the single largest reserved-channel violation in the level.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * FOR THE NEXT AGENT
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * • BUCKETS ARE THE COMPOSITION. If you add geometry, pick the bucket by the VALUE you want it
 *   to have in the frame, not by what it is made of. The ladder is documented on `BUCKETS`.
 * • `ad` and `bill` are decal buckets: a quad whose uv addresses one cell of an atlas
 *   (`decalQuad`). Adding more painted signage costs two triangles, not a draw call. The
 *   biggest remaining blank surfaces are the depot spandrel and the SW lot fence.
 * • STAMPED GEOMETRY HAS NORMALIZED UV (-0.5…0.5 per face); `flatPoly`/`flatRect` geometry has
 *   WORLD uv in metres. `mapScale` means a different thing for each. This is the single most
 *   surprising thing in the file — see the `mapScale` doc comment.
 * • Nothing in this file animates. The practicals no longer flicker (ART §4.1); with a parked
 *   camera every non-boil frame is bit-identical. Do not add a per-frame uniform here.
 */

/**
 * THE ASSET GALLERY — proof that every pixel and every sound in this game is generated in code.
 *
 * This page imports the SAME modules the game does and runs the SAME generators. Nothing here is
 * a mock-up or a re-implementation: if a texture appears on this page, that exact function call
 * is what the arena uses. If it ever stops matching, this page breaks — which is the point.
 *
 * It exists because the project's defining constraint is "100% in-house, zero downloaded assets"
 * (CLAUDE.md), and a constraint you cannot SEE is a constraint nobody believes. Open
 * `/gallery.html` next to `/index.html` and the whole asset pipeline is on one page.
 *
 * Deliberately dependency-free of the game loop: no GameCtx, no systems, no render pipeline.
 * It touches only `art/` (+ a bare three.js renderer for geometry, and `audio/` for sound), so it
 * cannot break the game and the game cannot break it.
 */

import {
  Box3, BoxGeometry, BufferGeometry, Group, Mesh, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
  type Object3D,
} from 'three';

import { PALETTE, READABILITY, css, hexMix, type PaletteToken } from '@/art/palette';
import {
  makeBrick, makeCrackedConcrete, makeFacade, makeGradientRamp, makeHalftoneTexture,
  makeInkSplatTexture, makeNewsprintTexture, makePlankWood, makePosterSheet, makeRustMetal,
  makeSpeedLinesTexture, makeStarBurstTexture, makeWallAdSheet,
} from '@/art/textures';
// The weapon surface library is imported DYNAMICALLY (see `buildWeaponSurfaces`) so the game's
// bundle does not carry a generator only this page calls. The type import is erased, so it costs
// nothing and can stay static.
import type { WeaponSurfaceName } from '@/art/surfaces';
import {
  WORD_SETS, WORD_SET_STYLE, makeNumberTexture, makePointsTexture, makeWordTexture,
  type WordSetName,
} from '@/art/letters';
import { buildProp, mergeProp, type PropKind } from '@/art/shapes';
import { buildOutlineHull, makeInkMaterial, updateInkGlobals } from '@/render/materials/index';
import { WEAPON } from '@/game/tuning';

// ─────────────────────────────────────────────────────────────────────────────
// Tiny DOM helpers. No framework — this page must never become a dependency.
// ─────────────────────────────────────────────────────────────────────────────

const root = document.getElementById('gallery')!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function section(title: string, blurb: string, id?: string): HTMLElement {
  const s = el('section');
  if (id) s.id = id;
  s.appendChild(el('h2', undefined, title));
  s.appendChild(el('p', 'blurb', blurb));
  const grid = el('div', 'grid');
  s.appendChild(grid);
  root.appendChild(s);
  return grid;
}

/** A gallery tile: the generated image itself, its name, and the exact call that made it. */
function tile(grid: HTMLElement, label: string, call: string, node: HTMLElement): void {
  const card = el('figure', 'card');
  const holder = el('div', 'art');
  holder.appendChild(node);
  card.appendChild(holder);
  const cap = el('figcaption');
  cap.appendChild(el('strong', undefined, label));
  cap.appendChild(el('code', undefined, call));
  card.appendChild(cap);
  grid.appendChild(card);
}

/**
 * Show a texture's real pixels.
 *
 * `CanvasTexture` keeps its source canvas on `.image`, so we can hand that straight to the DOM.
 * `DataTexture` does NOT — `.image` is `{data, width, height}`, a raw RGBA buffer with no node to
 * append (this is what broke the banded-ramp tile). Paint those into a canvas instead, nearest-
 * neighbour and upscaled, because a 6×4 ramp is meant to be seen as flat bands.
 */
function canvasOf(tex: { image: unknown }): HTMLCanvasElement {
  const img = tex.image as
    | HTMLCanvasElement
    | { data: Uint8Array | Uint8ClampedArray; width: number; height: number };

  if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) return img;

  const src = img as { data: Uint8Array | Uint8ClampedArray; width: number; height: number };
  if (!src || !src.data) {
    const empty = el('canvas');
    empty.width = empty.height = 8;
    return empty;
  }

  const small = el('canvas');
  small.width = src.width; small.height = src.height;
  const sctx = small.getContext('2d')!;
  sctx.putImageData(new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), 0, 0);

  // Upscale with smoothing off so the quantised bands stay crisp rather than blurring together.
  const out = el('canvas');
  const scale = Math.max(1, Math.floor(256 / Math.max(src.width, src.height)));
  out.width = src.width * scale; out.height = src.height * scale;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(small, 0, 0, out.width, out.height);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · THE PALETTE
// ─────────────────────────────────────────────────────────────────────────────

function srgbLuma(hex: number): number {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function buildPalette(): void {
  const grid = section(
    'The palette',
    'Eleven inks plus four environment tokens, chosen the way a colourist buys a limited set for '
    + 'a night sequence: a cool half, a warm half, two neutrals carrying the biggest areas, and '
    + 'reserved channels nothing else may touch. Sorted by luminance — the value ladder is the '
    + 'reason the frame reads at all.',
  );
  const tokens = (Object.keys(PALETTE) as PaletteToken[])
    .sort((a, b) => srgbLuma(PALETTE[a]) - srgbLuma(PALETTE[b]));

  for (const t of tokens) {
    const hex = PALETTE[t];
    const sw = el('div', 'swatch');
    sw.style.background = css(t);
    const meta = el('div', 'swatchmeta');
    meta.appendChild(el('span', undefined, `luma ${srgbLuma(hex).toFixed(2)}`));
    meta.appendChild(el('span', undefined, `#${hex.toString(16).padStart(6, '0')}`));
    sw.appendChild(meta);
    tile(grid, t, `PALETTE.${t}`, sw);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · TEXTURES — every one drawn to a <canvas> at runtime
// ─────────────────────────────────────────────────────────────────────────────

function buildTextures(): void {
  const grid = section(
    'Textures',
    'Every surface in the game is painted with the 2D canvas API at boot and uploaded as a '
    + 'CanvasTexture. No image file is ever fetched. These are the live generators — the same '
    + 'calls the arena makes.',
  );

  const simple: [string, string, () => { image: unknown }][] = [
    ['Halftone screen', 'makeHalftoneTexture(8, 15, 128)', () => makeHalftoneTexture(8, 15, 128)],
    ['Newsprint grain', 'makeNewsprintTexture(512)', () => makeNewsprintTexture(512)],
    ['Ink splat', 'makeInkSplatTexture(3, 256)', () => makeInkSplatTexture(3, 256)],
    ['Ink splat (seed 7)', 'makeInkSplatTexture(7, 256)', () => makeInkSplatTexture(7, 256)],
    ['Speed lines', 'makeSpeedLinesTexture(512)', () => makeSpeedLinesTexture(512)],
    ['Star burst', 'makeStarBurstTexture(9, 256, 1)', () => makeStarBurstTexture(9, 256, 1)],
    ['Wall advertising', 'makeWallAdSheet(512)', () => makeWallAdSheet(512)],
    ['Poster sheet', 'makePosterSheet(512)', () => makePosterSheet(512)],
    ['Banded ramp', 'makeGradientRamp([...], 6)',
      () => makeGradientRamp([PALETTE.NIGHT_A, PALETTE.NIGHT_B, PALETTE.SODIUM], 6)],
  ];
  for (const [label, call, make] of simple) {
    try { tile(grid, label, call, canvasOf(make())); }
    catch (err) { tile(grid, label, call, el('div', 'err', String(err).slice(0, 120))); }
  }

  // Surface sets return a colour map AND a break-up map. Show both — the second one is what
  // modulates halftone density and rim response, and it is invisible in the game.
  const surfaces: [string, string, () => { map: { image: unknown }; roughnessLike: { image: unknown } }][] = [
    ['Cracked concrete', 'makeCrackedConcrete()', () => makeCrackedConcrete()],
    ['Rust metal', 'makeRustMetal()', () => makeRustMetal()],
    ['Plank wood', 'makePlankWood()', () => makePlankWood()],
    ['Brick', 'makeBrick()', () => makeBrick()],
    ['Building facade', 'makeFacade()', () => makeFacade()],
  ];
  for (const [label, call, make] of surfaces) {
    try {
      const set = make();
      tile(grid, label, `${call}.map`, canvasOf(set.map));
      tile(grid, `${label} — break-up`, `${call}.roughnessLike`, canvasOf(set.roughnessLike));
    } catch (err) {
      tile(grid, label, call, el('div', 'err', String(err).slice(0, 120)));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · LETTERING — the onomatopoeia engine
// ─────────────────────────────────────────────────────────────────────────────

function buildLettering(): void {
  const grid = section(
    'Lettering',
    'Comic sound effects and damage numbers are drawn to canvas at runtime from a bold system '
    + 'font stack — OS fonts, never a downloaded webfont — then given three offset outline '
    + 'layers, a hard drop shadow and roughened ink edges. Cached by text + style, so each word '
    + 'is painted once per run.',
  );

  for (const set of Object.keys(WORD_SETS) as WordSetName[]) {
    const words = WORD_SETS[set];
    const word = words[0]!;
    try {
      const wt = makeWordTexture(word, WORD_SET_STYLE[set]);
      tile(grid, `${set}: ${word}`, `makeWordTexture('${word}', WORD_SET_STYLE.${set})`,
        canvasOf(wt.texture));
    } catch (err) {
      tile(grid, set, 'makeWordTexture', el('div', 'err', String(err).slice(0, 120)));
    }
  }

  try {
    tile(grid, 'Damage number', 'makeNumberTexture(42, false)', canvasOf(makeNumberTexture(42).texture));
    tile(grid, 'Critical hit', 'makeNumberTexture(105, true)', canvasOf(makeNumberTexture(105, true).texture));
    tile(grid, 'Points award', 'makePointsTexture(100)', canvasOf(makePointsTexture(100).texture));
  } catch (err) {
    tile(grid, 'numbers', 'makeNumberTexture', el('div', 'err', String(err).slice(0, 120)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · GEOMETRY — the procedural prop kit, shaded with the real InkMaterial
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE shared renderer for the whole prop grid.
 *
 * Browsers cap live WebGL contexts (~16), so a context per tile is not an option. The first
 * version created one each and then called `forceContextLoss()` to release it — which CLEARS the
 * canvas it just drew into, so every geometry tile came back blank. Correct approach: render into
 * a single offscreen GL canvas, then `drawImage` the result into a plain 2D canvas per tile. One
 * context, N cheap bitmaps, nothing to release.
 */
let _glRenderer: WebGLRenderer | null = null;
function sharedRenderer(size: number): WebGLRenderer {
  if (!_glRenderer) {
    _glRenderer = new WebGLRenderer({ antialias: true, alpha: true });
    _glRenderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  }
  _glRenderer.setSize(size, size, false);
  return _glRenderer;
}

function renderProp(kind: PropKind, seed: number, size = 220): HTMLCanvasElement {
  const renderer = sharedRenderer(size);

  const scene = new Scene();
  const cam = new PerspectiveCamera(38, 1, 0.1, 100);

  let geo: BufferGeometry;
  try {
    geo = mergeProp(buildProp(kind, seed, 1));
  } catch {
    geo = new BoxGeometry(1, 1, 1);
  }
  geo.computeBoundingSphere();
  const r = geo.boundingSphere?.radius ?? 1;
  geo.computeBoundingBox();
  const c = geo.boundingBox ? geo.boundingBox.getCenter(new Vector3()) : new Vector3();

  const mat = makeInkMaterial({ color: PALETTE.BONE, rimColor: PALETTE.ELECTRIC });
  const mesh = new Mesh(geo, mat);
  const g = new Group();
  g.add(mesh);
  mesh.position.set(-c.x, -c.y, -c.z);
  scene.add(g);
  g.rotation.set(0.25, -0.7, 0);

  cam.position.set(0, 0, r * 3.1);
  cam.lookAt(0, 0, 0);

  updateInkGlobals(0.016, size, size);
  renderer.render(scene, cam);

  // Copy the pixels out into a plain 2D canvas so the tile keeps its image after the shared
  // renderer moves on to the next prop.
  const out = el('canvas');
  const dpr = renderer.getPixelRatio();
  out.width = size * dpr; out.height = size * dpr;
  out.style.width = `${size}px`; out.style.height = `${size}px`;
  out.getContext('2d')!.drawImage(renderer.domElement, 0, 0);

  geo.dispose();
  mat.dispose();
  return out;
}

function buildGeometry(): void {
  const grid = section(
    'Geometry',
    'Every mesh is built from code — chamfered boxes, faceted cylinders, jittered vertices so '
    + 'nothing is CAD-perfect. Shown here shaded with the game\'s own InkMaterial: three-band '
    + 'cel light, screen-space halftone in the shadow band, and a Fresnel rim.',
  );
  const kinds: PropKind[] = [
    'barrel', 'crate', 'dumpster', 'fence', 'streetLamp', 'brokenWall', 'rubble', 'pipe', 'plank',
  ];
  for (const k of kinds) {
    try { tile(grid, k, `mergeProp(buildProp('${k}', 1))`, renderProp(k, 1)); }
    catch (err) { tile(grid, k, `buildProp('${k}')`, el('div', 'err', String(err).slice(0, 120))); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5 · WEAPON SURFACES — the patterns the gun is allowed to wear
// ─────────────────────────────────────────────────────────────────────────────

/** The dynamically-loaded surface module, handed on to the models section for its value fields. */
type Surfaces = typeof import('@/art/surfaces');

/**
 * These are NOT the environment's surfaces at a smaller size, and the difference is the whole
 * point of the section: the gun sits ~0.30 m from the eye under a 7 px ink line, so anything
 * fine turns to grey mush before the player ever sees it (WEAPON_ART §0). Every pattern here is
 * therefore deliberately coarse and deliberately two-valued.
 *
 * The library is a cache: calling a generator twice with the same arguments hands back the same
 * texture object, so the variant tiles below cost one build each and the house set costs six.
 */
async function buildWeaponSurfaces(): Promise<Surfaces | null> {
  const grid = section(
    'Weapon surfaces',
    'The viewmodel is on screen 100% of the session, 30 cm from the eye, wrapped in the heaviest '
    + 'ink line in the game — and a 7-pixel line eats fine detail rather than drawing it. So '
    + 'these patterns are coarse on purpose: four broad wood bands instead of forty grain lines, '
    + 'three big vents instead of eight thin ones, a diamond knurl you could count. Two '
    + 'hard-edged values each, no baked halftone (the print is fixed — only the drawing moves), '
    + 'and every map is authored as a MULTIPLIER over one of the gun\'s flat fields, never as a '
    + 'colour of its own.',
    'weapon-surfaces',
  );

  let S: Surfaces;
  try {
    S = await import('@/art/surfaces');
  } catch (err) {
    tile(grid, 'weapon surfaces', "import('@/art/surfaces')",
      el('div', 'err', String(err).slice(0, 160)));
    return null;
  }
  const { WEAPON_FIELD, makeChippedPaint, makeTapeWrap, makeVentedSteel, makeWoodGrain } = S;

  // The house set, exactly as `makeWeaponSurfaceLibrary` builds it — same bases, same seeds, so
  // the call printed under each tile is the call that made it.
  const house: [WeaponSurfaceName, string, string][] = [
    ['woodGrain', 'Wood grain',
      'makeWoodGrain({ base: WEAPON_FIELD.wood, size: 256, seed: 3 })'],
    ['ventedSteel', 'Vented steel',
      'makeVentedSteel({ base: WEAPON_FIELD.steel, size: 256, seed: 4 })'],
    ['knurled', 'Knurling',
      'makeKnurled({ base: WEAPON_FIELD.polymer, size: 256, seed: 5 })'],
    ['tapeWrap', 'Tape wrap',
      'makeTapeWrap({ base: WEAPON_FIELD.polymer, size: 256, seed: 6 })'],
    ['chippedPaint', 'Chipped paint',
      'makeChippedPaint({ base: WEAPON_FIELD.frame, size: 256, seed: 7 })'],
    ['parkerised', 'Parkerised finish',
      'makeParkerised({ base: WEAPON_FIELD.frame, size: 256, seed: 8 })'],
  ];

  try {
    const lib = S.makeWeaponSurfaceLibrary(256);
    for (const [key, label, call] of house) {
      const set = lib[key];
      tile(grid, label, `${call}.map`, canvasOf(set.map));
      // Half res and quantised: this one never reaches the screen as pixels, it modulates
      // halftone density and rim response. Same deal as the environment sets above.
      tile(grid, `${label} — break-up`, `${call}.roughnessLike`, canvasOf(set.roughnessLike));
    }
  } catch (err) {
    tile(grid, 'weapon surfaces', 'makeWeaponSurfaceLibrary(256)',
      el('div', 'err', String(err).slice(0, 120)));
  }

  // Each generator has knobs, and every knob is bounded so it CANNOT be turned fine. Four of
  // them, to show the range a gun author actually has.
  const variants: [string, string, () => { map: { image: unknown } }][] = [
    ['Wood grain — 3 bands, across',
      "makeWoodGrain({ base: WEAPON_FIELD.wood, bands: 3, axis: 'v', knot: false })",
      () => makeWoodGrain({ base: WEAPON_FIELD.wood, bands: 3, axis: 'v', knot: false })],
    ['Vented steel — 4 slots, riveted',
      "makeVentedSteel({ base: WEAPON_FIELD.frame, slots: 4, axis: 'v', rivets: true })",
      () => makeVentedSteel({ base: WEAPON_FIELD.frame, slots: 4, axis: 'v', rivets: true })],
    ['Tape wrap — steeper, heavier',
      'makeTapeWrap({ base: WEAPON_FIELD.polymer, wraps: 3, slope: 3, coverage: 0.72 })',
      () => makeTapeWrap({ base: WEAPON_FIELD.polymer, wraps: 3, slope: 3, coverage: 0.72 })],
    ['Chipped paint — dark reveal',
      "makeChippedPaint({ base: WEAPON_FIELD.steel, chips: 9, reveal: 'darker' })",
      () => makeChippedPaint({ base: WEAPON_FIELD.steel, chips: 9, reveal: 'darker' })],
  ];
  for (const [label, call, make] of variants) {
    try { tile(grid, label, call, canvasOf(make().map)); }
    catch (err) { tile(grid, label, call, el('div', 'err', String(err).slice(0, 120))); }
  }
  return S;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6 · WEAPON MODELS — the four guns, built by the viewmodel's own builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The gallery must never re-implement a generator, so it does not model a gun — it asks
 * `src/game/weapons/viewmodel.ts` for the exact thing the player is holding.
 *
 * That file is owned elsewhere and exports neither its builder nor its profiles today, so the
 * import is PROBED at runtime rather than bound at compile time: the section lights up the moment
 * an export lands and says so in the page until then, instead of failing to build. Two shapes are
 * accepted, in order of how truthful the tile ends up:
 *
 *   1. `buildGunShowpiece(id)` → a finished, skinned, outlined Group. PREFERRED, because the
 *      per-gun skins (parkerised pistol, chipped-and-vented SMG, walnut shotgun) live inside
 *      `Viewmodel.build()` along with `projectSurfaceUV`, and a gallery that re-assembled them
 *      out here would drift from the game the first time that table changed.
 *   2. `buildGunGeometry(profile)` + `PROFILES` → raw part geometry. The tile is then honest but
 *      understated: the value ladder, no surface maps.
 *
 * Narrowing happens once, here, so nothing downstream is loosely typed.
 */
interface GunProfileLike { readonly id: string }
type GunGeometryLike = Readonly<Record<string, BufferGeometry | undefined>>;
type BuildGunGeometry = (p: GunProfileLike) => GunGeometryLike;
type BuildGunShowpiece = (id: string) => Object3D;

/** Which flat field each part of a gun belongs to — the ladder in WEAPON_ART §2. */
type Field = 'frame' | 'polymer' | 'steel' | 'sight' | 'trim' | 'accent' | 'core';
const GUN_PARTS: readonly [part: string, field: Field][] = [
  ['frame', 'frame'],
  ['polymer', 'polymer'],
  ['slide', 'frame'],
  ['steel', 'steel'],
  ['sights', 'sight'],
  ['accent', 'accent'],
  ['accentSlide', 'accent'],
  ['trim', 'trim'],
  ['magazine', 'steel'],
  ['core', 'core'],
  // `hand` is deliberately absent: the glove is a third of the viewmodel's mass and this section
  // is about the gun. It is still built — it is just not what these tiles are for.
];

/** Human names for the four ids, so a tile says what the gun IS as well as what it is called. */
const GUN_LABELS: Readonly<Record<string, string>> = {
  inkslinger: 'INKSLINGER — pistol',
  ratatat: 'RATATAT — SMG',
  boomstick: 'BOOMSTICK — shotgun',
  longshot: 'LONGSHOT — marksman',
};

/**
 * The value ladder as materials. Colours come from `WEAPON_FIELD` — the same four numbers the
 * surface generators above modulate — plus BONE for machined trim and the single RUST accent.
 * Built ONCE and shared by all four tiles, exactly as the viewmodel shares them across guns.
 */
function makeGunMaterials(WEAPON_FIELD: Surfaces['WEAPON_FIELD']):
Record<Field, ReturnType<typeof makeInkMaterial>> {
  const common = { rimColor: PALETTE.ELECTRIC, fog: 0 } as const;
  return {
    frame: makeInkMaterial({
      ...common, color: WEAPON_FIELD.frame, shadowColor: PALETTE.TEAL,
      rimStrength: 0.26, halftoneAngle: 75, toneFloor: 0.22, specular: 0.5, gleam: 0.55,
      gleamSize: 0.3,
    }),
    polymer: makeInkMaterial({
      ...common, color: WEAPON_FIELD.polymer, shadowColor: PALETTE.INK_SOFT,
      rimStrength: 0.30, halftoneAngle: 60, toneFloor: 0.30, specular: 0.10, gleam: 0.08,
      gleamSize: 0.45,
    }),
    steel: makeInkMaterial({
      ...common, color: WEAPON_FIELD.steel, shadowColor: PALETTE.TEAL,
      rimStrength: 0.28, halftoneAngle: 0, toneFloor: 0.24, specular: 0.85, gleam: 0.75,
      gleamSize: 0.20,
    }),
    sight: makeInkMaterial({
      ...common, color: PALETTE.BONE, shadowColor: hexMix(PALETTE.BONE, PALETTE.TEAL, 0.4),
      rimStrength: 0.18, halftoneAngle: 45, toneFloor: 0.55, specular: 0.12, gleam: 0.1,
      gleamSize: 0.3,
    }),
    trim: makeInkMaterial({
      ...common, color: PALETTE.BONE, shadowColor: PALETTE.TEAL,
      rimStrength: 0.24, halftoneAngle: 45, toneFloor: 0.2, specular: 0.62, gleam: 0.7,
      gleamSize: 0.26,
    }),
    accent: makeInkMaterial({
      ...common, color: PALETTE.RUST, shadowColor: PALETTE.TEAL, rimColor: PALETTE.SODIUM,
      rimStrength: 0.3, halftoneAngle: 15, toneFloor: 0.18, specular: 0.3, gleam: 0.35,
      gleamSize: 0.28,
    }),
    core: makeInkMaterial({
      ...common, color: PALETTE.GOLD, shadowColor: PALETTE.RUST,
      emissive: PALETTE.GOLD, emissiveIntensity: 1.1, bloom: true, halftone: 0,
    }),
  };
}

/**
 * THE INK LINE IS SCREEN-SPACE, SO THE TILE HAS TO LIE ABOUT ITS RESOLUTION.
 *
 * `buildOutlineHull` inflates the silhouette by `uThickness` CSS pixels of `INK_GLOBALS
 * .uResolution`. Feed it the tile's own 340 px and a 7 px line becomes 2% of the image — three
 * times the weight the same gun carries on a 1080p screen, i.e. a fatter, muddier gun than the
 * game draws. Feeding it a viewport-sized number instead keeps the line at the ratio the player
 * actually sees. Same reason the gallery renders at 340 and lets CSS scale it down.
 */
const GUN_TILE = 340;
const GUN_INK_RES = 1800;
const GUN_FOV = 40;

/**
 * Frame one gun and copy the pixels out.
 *
 * `subject` is in gun space (barrel down −z, up +y), whatever built it. Nothing is disposed here
 * — the caller owns what it made.
 */
function shootGun(subject: Object3D): HTMLCanvasElement {
  const renderer = sharedRenderer(GUN_TILE);
  const scene = new Scene();
  const cam = new PerspectiveCamera(GUN_FOV, 1, 0.01, 100);
  // Hulls live on LAYER.OUTLINE and the emissive core on LAYER.BLOOM; a default camera sees
  // neither, which would draw the gun with no line at all.
  cam.layers.enableAll();

  subject.visible = true;
  subject.updateMatrixWorld(true);
  const box = new Box3().setFromObject(subject);
  const c = box.getCenter(new Vector3());
  const r = Math.max(0.05, box.getSize(new Vector3()).length() * 0.5);

  const outer = new Group();
  const inner = new Group();
  inner.position.set(-c.x, -c.y, -c.z);
  inner.add(subject);
  outer.add(inner);
  scene.add(outer);

  // THREE-QUARTER, FROM THE LEFT. The guns are canted so the face the player looks at all
  // session is the left one, which is where the authored detail was deliberately put — the
  // selector, the stamped panels, the SMG's charging handle. Muzzle swings out to the left and
  // a touch toward the eye; the camera sits slightly above so the top rail reads.
  outer.rotation.set(0.20, 1.85, 0.05);
  cam.position.set(0, 0, r * 2.95);
  cam.lookAt(0, 0, 0);

  updateInkGlobals(0.016, GUN_INK_RES, GUN_INK_RES);
  renderer.render(scene, cam);

  // Copy out, because the shared renderer is about to draw the next gun over this one.
  const out = el('canvas');
  const dpr = renderer.getPixelRatio();
  out.width = GUN_TILE * dpr; out.height = GUN_TILE * dpr;
  out.style.width = `${GUN_TILE}px`; out.style.height = `${GUN_TILE}px`;
  out.getContext('2d')!.drawImage(renderer.domElement, 0, 0);
  return out;
}

/** PATH 2: raw part geometry, shaded with the flat value ladder and given the real ink line. */
function renderGunParts(build: BuildGunGeometry, profile: GunProfileLike,
  mats: Record<Field, ReturnType<typeof makeInkMaterial>>): HTMLCanvasElement {
  const geo = build(profile);
  const group = new Group();
  const spent: BufferGeometry[] = [];
  const hulls: Mesh[] = [];

  for (const [part, field] of GUN_PARTS) {
    const g = geo[part];
    // A part group is allowed to be EMPTY — the detail vocabulary is opt-in, so `steel` has
    // nothing in it on a profile that asked for none of it.
    if (!g || !g.getAttribute('position')) continue;
    spent.push(g);
    const mesh = new Mesh(g, mats[field]);
    mesh.frustumCulled = false;
    group.add(mesh);

    if (field === 'core') continue; // the muzzle core is emissive; emissive things take no line
    const hull = buildOutlineHull(g, {
      // The sights carry a LIGHTER line than the silhouette on purpose: at 7 px the notch and
      // both light bars ink shut, and the sight picture is the one interior detail on this
      // object the player is asked to read precisely.
      thickness: field === 'sight' ? WEAPON.view.sightOutlinePx : READABILITY.VIEWMODEL_OUTLINE_PX,
      minThickness: 3.5,
      boil: WEAPON.view.hullBoil,
      ink: PALETTE.INK,
    });
    group.add(hull);
    hulls.push(hull);
  }

  const out = shootGun(group);
  for (const g of spent) g.dispose();
  for (const h of hulls) { h.geometry.dispose(); (h.material as { dispose(): void }).dispose(); }
  return out;
}

async function buildWeaponModels(S: Surfaces | null): Promise<void> {
  const grid = section(
    'Weapon models',
    'Four guns, built by the same function the viewmodel calls at boot — bevelled boxes, faceted '
    + 'cylinders, jittered vertices, no file. Nothing structural is under 10 mm, because below '
    + 'that the ink line stops drawing a part and starts erasing it, so identity has to live in '
    + 'bold silhouette events instead of small parts: a vented shroud, a folding hinge, an '
    + 'ejection port, a bolt handle out to the right. Each one then wears the surfaces above as '
    + 'its finish — a parkerised pistol with a taped grip, a chipped and vented SMG, a walnut '
    + 'shotgun. Shown from the left, which is the face the player actually sees all session, '
    + 'with the glove hidden and the real inverted-hull outline on.',
    'weapons',
  );

  let showpiece: BuildGunShowpiece | null = null;
  let build: BuildGunGeometry | null = null;
  let profiles: readonly GunProfileLike[] = [];
  try {
    const mod = await import('@/game/weapons/viewmodel') as unknown as Record<string, unknown>;
    if (typeof mod.buildGunShowpiece === 'function') {
      showpiece = mod.buildGunShowpiece as BuildGunShowpiece;
    }
    if (typeof mod.buildGunGeometry === 'function') build = mod.buildGunGeometry as BuildGunGeometry;
    if (Array.isArray(mod.PROFILES)) profiles = mod.PROFILES as readonly GunProfileLike[];
    else if (Array.isArray(mod.GUN_IDS)) {
      profiles = (mod.GUN_IDS as readonly string[]).map((id) => ({ id }));
    }
  } catch (err) {
    tile(grid, 'viewmodel', "import('@/game/weapons/viewmodel')",
      el('div', 'err', String(err).slice(0, 160)));
    return;
  }

  if (!profiles.length || !(showpiece ?? build)) {
    tile(grid, 'awaiting an export', 'export { buildGunShowpiece, GUN_IDS }',
      el('div', 'err',
        'src/game/weapons/viewmodel.ts exports neither buildGunShowpiece/GUN_IDS nor '
        + 'buildGunGeometry/PROFILES. This page will not re-model the guns to work around that.'));
    return;
  }

  // PATH 1 — a finished Group per gun: skinned with the surfaces above, outlined, exactly the
  // object in the player's hands. Nothing here to shade, so nothing here to drift.
  // Not disposed: what the factory hands back is the factory's to own, and this page renders
  // each gun exactly once and then keeps only the bitmap.
  if (showpiece) {
    for (const p of profiles) {
      const call = `buildGunShowpiece('${p.id}')`;
      try { tile(grid, GUN_LABELS[p.id] ?? p.id, call, shootGun(showpiece(p.id))); }
      catch (err) { tile(grid, p.id, call, el('div', 'err', String(err).slice(0, 120))); }
    }
    return;
  }

  // PATH 2 — raw geometry. Honest but understated: the four flat fields, no surface maps, so the
  // tile shows the value ladder and the silhouette rather than the finish.
  if (!build || !S) {
    tile(grid, 'weapon fields', "import('@/art/surfaces')",
      el('div', 'err', 'the value ladder these guns are shaded with failed to load'));
    return;
  }
  const mats = makeGunMaterials(S.WEAPON_FIELD);
  for (const p of profiles) {
    const call = `buildGunGeometry(PROFILES['${p.id}'])`;
    try { tile(grid, GUN_LABELS[p.id] ?? p.id, call, renderGunParts(build, p, mats)); }
    catch (err) { tile(grid, p.id, call, el('div', 'err', String(err).slice(0, 120))); }
  }
  for (const m of Object.values(mats)) m.dispose();
}

// ─────────────────────────────────────────────────────────────────────────────
// 7 · AUDIO — every sound synthesised, none sampled
// ─────────────────────────────────────────────────────────────────────────────

async function buildAudio(): Promise<void> {
  const grid = section(
    'Audio',
    'Every sound is built from oscillators, code-generated noise buffers, filters and envelopes. '
    + 'There is not one audio file in this project. Click a recipe to hear it — browsers require '
    + 'a gesture before any sound, so the first click also starts the graph.',
  );

  let ids: readonly string[] = [];
  let play: ((id: string) => void) | null = null;
  try {
    const recipes = await import('@/audio/recipes');
    ids = recipes.RECIPE_IDS;
    const audio = await import('@/audio/index');
    const svc = audio.createAudio();
    let started = false;
    play = (id: string): void => {
      if (!started) { void svc.resume(); started = true; }
      svc.play(id);
    };
  } catch (err) {
    root.appendChild(el('p', 'err', `audio unavailable: ${String(err).slice(0, 160)}`));
  }

  for (const id of ids) {
    const btn = el('button', 'sound', '▶');
    btn.addEventListener('click', () => play?.(id));
    tile(grid, id, `audio.play('${id}')`, btn);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const t0 = performance.now();
  buildPalette();
  buildTextures();
  buildLettering();
  buildGeometry();
  await buildWeaponModels(await buildWeaponSurfaces());
  await buildAudio();

  const ms = Math.round(performance.now() - t0);
  const foot = el('p', 'blurb',
    `Everything above was generated in ${ms} ms, in your browser, from code. `
    + 'Zero files were downloaded.');
  root.appendChild(foot);
}

void main();

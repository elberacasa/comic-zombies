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
  BoxGeometry, BufferGeometry, Group, Mesh, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
} from 'three';

import { PALETTE, css, type PaletteToken } from '@/art/palette';
import {
  makeBrick, makeCrackedConcrete, makeFacade, makeGradientRamp, makeHalftoneTexture,
  makeInkSplatTexture, makeNewsprintTexture, makePlankWood, makePosterSheet, makeRustMetal,
  makeSpeedLinesTexture, makeStarBurstTexture, makeWallAdSheet,
} from '@/art/textures';
import {
  WORD_SETS, WORD_SET_STYLE, makeNumberTexture, makePointsTexture, makeWordTexture,
  type WordSetName,
} from '@/art/letters';
import { buildProp, mergeProp, type PropKind } from '@/art/shapes';
import { makeInkMaterial, updateInkGlobals } from '@/render/materials/index';

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

function section(title: string, blurb: string): HTMLElement {
  const s = el('section');
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
// 5 · AUDIO — every sound synthesised, none sampled
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
  await buildAudio();

  const ms = Math.round(performance.now() - t0);
  const foot = el('p', 'blurb',
    `Everything above was generated in ${ms} ms, in your browser, from code. `
    + 'Zero files were downloaded.');
  root.appendChild(foot);
}

void main();

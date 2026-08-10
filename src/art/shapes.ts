/**
 * PROCEDURAL COMIC GEOMETRY. Nothing here loads a model — every vertex is computed.
 * See docs/ART_DIRECTION.md §2–3 for why the shapes look the way they do.
 *
 * The rules that make code-generated geometry read as *drawn* rather than as CAD:
 *   • BEVEL EVERYTHING. A chamfer is a thin facet that catches the rim light and
 *     turns the silhouette into a bold inked edge. Sharp 90° boxes look like a prototype.
 *   • LOW, DELIBERATE SEGMENT COUNTS. 7–10 sided cylinders. Facets are a feature:
 *     they give the cel bands somewhere to break.
 *   • NOTHING IS STRAIGHT. Every prop takes a seed and leans, tapers or wobbles.
 *   • FLAT NORMALS by default so the banded shader gets crisp tonal shapes.
 *
 * CONVENTIONS (the arena/enemy agents depend on these):
 *   • Units are metres, Y is up.
 *   • Every prop is built with its BASE AT y = 0, centred on X/Z. Drop it on the floor
 *     at its world position with no offset maths.
 *   • Props return a `PropBuild` — `body` (base ink material), optional `accent`
 *     (a second material: metal trim, lids, hoops) and optional `glow` (emissive,
 *     layer 2, feeds selective bloom). Call `mergeProp()` if you only want one draw call.
 */

import {
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Matrix4,
  SphereGeometry,
  Vector3,
} from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2, makeSeededRandom, type SeededRandom } from '@/art/textures';

// ═════════════════════════════════════════════════════════════════════════════
// 0. TRANSFORM / ATTRIBUTE UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

const _m = new Matrix4();
const _m2 = new Matrix4();
const _v = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _n = new Vector3();

export interface Transform {
  x?: number;
  y?: number;
  z?: number;
  /** Radians, applied X→Y→Z, about the geometry's current origin. */
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

/**
 * Scale → rotate → translate, applied about the geometry's current origin.
 * Mutates and returns `geo` so calls chain; call twice to rotate about a moved pivot.
 */
export function place(geo: BufferGeometry, t: Transform): BufferGeometry {
  _m.identity();
  _m2.makeScale(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
  _m.multiply(_m2);
  if (t.rx) _m.premultiply(_m2.makeRotationX(t.rx));
  if (t.ry) _m.premultiply(_m2.makeRotationY(t.ry));
  if (t.rz) _m.premultiply(_m2.makeRotationZ(t.rz));
  if (t.x || t.y || t.z) _m.premultiply(_m2.makeTranslation(t.x ?? 0, t.y ?? 0, t.z ?? 0));
  geo.applyMatrix4(_m);
  return geo;
}

/** Non-indexed + flat face normals: the crisp faceted look the cel shader wants. */
export function faceted(geo: BufferGeometry): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.computeVertexNormals();
  return g;
}

/** Zero-filled UVs, so a geometry without them can still be merged. */
function ensureUV(geo: BufferGeometry): void {
  if (!geo.getAttribute('uv')) {
    const count = geo.getAttribute('position').count;
    geo.setAttribute('uv', new Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
}

/**
 * Planar-project UVs from the dominant axis of each face (box mapping).
 * `scale` is texels-per-metre-ish: 1 means one texture tile per metre.
 */
export function applyBoxUV(geo: BufferGeometry, scale = 1): BufferGeometry {
  const g = geo.index ? faceted(geo) : geo;
  const pos = g.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 3) {
    _a.fromBufferAttribute(pos, i);
    _b.fromBufferAttribute(pos, i + 1);
    _c.fromBufferAttribute(pos, i + 2);
    _n.copy(_b).sub(_a).cross(_v.copy(_c).sub(_a));
    const ax = Math.abs(_n.x);
    const ay = Math.abs(_n.y);
    const az = Math.abs(_n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? _a : k === 1 ? _b : _c;
      let u: number;
      let vv: number;
      if (ay >= ax && ay >= az) {
        u = p.x;
        vv = p.z;
      } else if (ax >= az) {
        u = p.z;
        vv = p.y;
      } else {
        u = p.x;
        vv = p.y;
      }
      uv[(i + k) * 2] = u * scale;
      uv[(i + k) * 2 + 1] = vv * scale;
    }
  }
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  return g;
}

/**
 * Nudge vertices so silhouettes wobble like a hand-inked line.
 * Displacement is hashed from the *quantised position*, so vertices that share a
 * corner move together and the mesh never splits open.
 */
export function jitterVertices(geo: BufferGeometry, amount: number, seed = 1): BufferGeometry {
  if (amount <= 0) return geo;
  const pos = geo.getAttribute('position');
  const q = 1e3;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const kx = Math.round(x * q);
    const ky = Math.round(y * q);
    const kz = Math.round(z * q);
    const h1 = hash2(kx, ky ^ kz, seed);
    const h2 = hash2(ky, kz ^ kx, seed + 101);
    const h3 = hash2(kz, kx ^ ky, seed + 211);
    pos.setXYZ(i, x + (h1 - 0.5) * 2 * amount, y + (h2 - 0.5) * 2 * amount, z + (h3 - 0.5) * 2 * amount);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function prepForMerge(geo: BufferGeometry): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  ensureUV(g);
  g.morphAttributes = {};
  return g;
}

/**
 * Merge static geometry into one buffer — the whole reason we can keep the arena
 * under the 350 draw-call budget. Inputs are left untouched.
 */
export function mergeForStatic(geos: readonly BufferGeometry[]): BufferGeometry {
  const list = geos.filter((g) => g.getAttribute('position') !== undefined).map(prepForMerge);
  if (list.length === 0) return new BufferGeometry();
  if (list.length === 1) return list[0] as BufferGeometry;
  const merged = mergeGeometries(list, false) as BufferGeometry | null;
  for (const g of list) g.dispose();
  if (!merged) throw new Error('[art/shapes] mergeForStatic: incompatible geometries');
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/**
 * Build the companion geometry for the inverted-hull ink outline.
 *
 * WHY THIS EXISTS: everything in this file is flat-shaded and non-indexed, so every
 * triangle owns its own vertices with its own face normal. Extruding that along its
 * normals blows the hull apart into flying slivers. Welding coincident positions and
 * averaging the normals gives one continuous shell that inflates cleanly.
 *
 *   const hull = buildOutlineHull(makeHullGeometry(prop.body), { thickness: 4 });
 *
 * Build it once per prop, next to the visual geometry, and cache it — it is not free.
 */
export function makeHullGeometry(geo: BufferGeometry, tolerance = 1e-4): BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo.clone();
  // mergeVertices compares EVERY attribute, so per-face normals/uvs would block the
  // weld entirely. Strip down to raw position first, weld, then average normals.
  for (const name of Object.keys(src.attributes)) {
    if (name !== 'position') src.deleteAttribute(name);
  }
  src.morphAttributes = {};
  const welded = mergeVertices(src, tolerance);
  if (welded !== src) src.dispose();
  welded.computeVertexNormals();
  welded.computeBoundingSphere();
  return welded;
}

/** Merge a list of geometries after transforming each — one call, one buffer. */
export function mergeTransformed(parts: readonly { geo: BufferGeometry; at: Transform }[]): BufferGeometry {
  const list: BufferGeometry[] = [];
  for (const p of parts) list.push(place(p.geo.clone(), p.at));
  const out = mergeForStatic(list);
  for (const g of list) g.dispose();
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. INKED PRIMITIVES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Chamfered box. The bevel is the whole point: it makes a thin bright facet on
 * every edge under the key light, which is what reads as an inked line in 3D.
 *
 * Built as the convex hull of the 24 chamfer corners, so the topology is always sane.
 */
export function bevelBox(w: number, h: number, d: number, bevel = 0.05, seed = 0): BufferGeometry {
  const b = Math.max(0.001, Math.min(bevel, Math.min(w, h, d) * 0.45));
  const hw = w * 0.5;
  const hh = h * 0.5;
  const hd = d * 0.5;
  const pts: Vector3[] = [];
  const rnd = seed ? makeSeededRandom(seed) : null;
  for (let i = 0; i < 8; i++) {
    const sx = i & 1 ? 1 : -1;
    const sy = i & 2 ? 1 : -1;
    const sz = i & 4 ? 1 : -1;
    // Per-corner bevel variation: hand-cut, not machined.
    const bb = rnd ? b * rnd.range(0.7, 1.25) : b;
    pts.push(new Vector3(sx * hw, sy * (hh - bb), sz * (hd - bb)));
    pts.push(new Vector3(sx * (hw - bb), sy * hh, sz * (hd - bb)));
    pts.push(new Vector3(sx * (hw - bb), sy * (hh - bb), sz * hd));
  }
  const geo = new ConvexGeometry(pts) as BufferGeometry;
  return applyBoxUV(faceted(geo), 1);
}

/** Low-segment cylinder. 8 sides by default — facets are a feature. */
export function inkCylinder(
  radius: number,
  height: number,
  segments = 8,
  opts: { radiusTop?: number; open?: boolean; seed?: number; jitter?: number } = {},
): BufferGeometry {
  const geo = faceted(
    new CylinderGeometry(opts.radiusTop ?? radius, radius, height, Math.max(3, segments), 1, opts.open ?? false),
  );
  if (opts.jitter) jitterVertices(geo, opts.jitter, opts.seed ?? 1);
  return applyBoxUV(geo, 1);
}

/** Low-segment capsule — limbs, pipes, rounded props. */
export function inkCapsule(radius: number, height: number, capSegments = 3, radialSegments = 8): BufferGeometry {
  return applyBoxUV(faceted(new CapsuleGeometry(radius, Math.max(0.001, height), capSegments, Math.max(3, radialSegments))), 1);
}

/** Low-segment cone — spikes, lamp shades, rubble. */
export function inkCone(radius: number, height: number, segments = 7, seed = 0): BufferGeometry {
  const geo = faceted(new ConeGeometry(radius, height, Math.max(3, segments), 1, false));
  if (seed) jitterVertices(geo, radius * 0.05, seed);
  return applyBoxUV(geo, 1);
}

/** Chunky faceted sphere/rock. Very low segments, jittered into an irregular lump. */
export function inkRock(radius: number, seed = 1, segments = 6): BufferGeometry {
  const geo = faceted(new SphereGeometry(radius, Math.max(4, segments), Math.max(3, Math.round(segments * 0.7))));
  jitterVertices(geo, radius * 0.22, seed);
  return applyBoxUV(geo, 1);
}

/**
 * A flat irregular polygon extruded to a wafer, with a bevelled rim so the
 * inverted-hull outline pass gives it a proper ink border. Death VFX shards.
 * Lies in the XY plane, thickness along Z.
 */
export function panelShard(size: number, seed = 1, sides = 5): BufferGeometry {
  const rnd = makeSeededRandom(seed * 887 + 3);
  const n = Math.max(3, sides + rnd.int(0, 3));
  const pts: number[] = [];
  let ang = rnd.range(0, Math.PI * 2);
  for (let i = 0; i < n; i++) {
    ang += (Math.PI * 2) / n + rnd.spread(0.45 / n);
    const r = size * 0.5 * rnd.range(0.5, 1.15);
    pts.push(Math.cos(ang) * r, Math.sin(ang) * r);
  }
  return extrudePolygon(pts, size * 0.055);
}

/** Extrude a 2D polygon (flat x,y pairs, CCW-ish) into a prism along Z. */
export function extrudePolygon(pts2d: readonly number[], thickness: number): BufferGeometry {
  const n = pts2d.length / 2;
  const hz = thickness * 0.5;
  const verts: number[] = [];
  const uvs: number[] = [];
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts2d[i * 2] as number;
    cy += pts2d[i * 2 + 1] as number;
  }
  cx /= n;
  cy /= n;

  let maxR = 1e-4;
  for (let i = 0; i < n; i++) {
    maxR = Math.max(maxR, Math.hypot((pts2d[i * 2] as number) - cx, (pts2d[i * 2 + 1] as number) - cy));
  }
  const uvOf = (x: number, y: number): [number, number] => [(x - cx) / (2 * maxR) + 0.5, (y - cy) / (2 * maxR) + 0.5];

  const push = (x: number, y: number, z: number): void => {
    verts.push(x, y, z);
    const [u, v] = uvOf(x, y);
    uvs.push(u, v);
  };

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts2d[i * 2] as number;
    const ay = pts2d[i * 2 + 1] as number;
    const bx = pts2d[j * 2] as number;
    const by = pts2d[j * 2 + 1] as number;
    // front fan
    push(cx, cy, hz);
    push(ax, ay, hz);
    push(bx, by, hz);
    // back fan
    push(cx, cy, -hz);
    push(bx, by, -hz);
    push(ax, ay, -hz);
    // rim quad
    push(ax, ay, hz);
    push(ax, ay, -hz);
    push(bx, by, hz);
    push(bx, by, hz);
    push(ax, ay, -hz);
    push(bx, by, -hz);
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Flat star burst in the XY plane — muzzle flash and impact spikes.
 * Alternating outer/inner radii with per-spike jitter so it never looks stamped.
 */
export function starPolygon(points = 8, innerR = 0.25, outerR = 1, seed = 1): BufferGeometry {
  const rnd = makeSeededRandom(seed * 313 + 7);
  const n = Math.max(3, points) * 2;
  const verts: number[] = [];
  const uvs: number[] = [];
  const rim: [number, number][] = [];
  const phase = rnd.range(0, Math.PI);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + phase + rnd.spread(0.06);
    const r = (i % 2 === 0 ? outerR : innerR) * rnd.range(0.82, 1.18);
    rim.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  for (let i = 0; i < n; i++) {
    const p = rim[i] as [number, number];
    const q = rim[(i + 1) % n] as [number, number];
    verts.push(0, 0, 0, p[0], p[1], 0, q[0], q[1], 0);
    uvs.push(0.5, 0.5, p[0] / (outerR * 2) + 0.5, p[1] / (outerR * 2) + 0.5, q[0] / (outerR * 2) + 0.5, q[1] / (outerR * 2) + 0.5);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** A flat quad in the XY plane with jittered corners — decals, billboards, word pops. */
export function wobbleQuad(width: number, height: number, seed = 1, wobble = 0.03): BufferGeometry {
  const rnd = makeSeededRandom(seed * 71 + 5);
  const hw = width * 0.5;
  const hh = height * 0.5;
  const w = Math.max(hw, hh) * wobble;
  const c: [number, number][] = [
    [-hw + rnd.spread(w), -hh + rnd.spread(w)],
    [hw + rnd.spread(w), -hh + rnd.spread(w)],
    [hw + rnd.spread(w), hh + rnd.spread(w)],
    [-hw + rnd.spread(w), hh + rnd.spread(w)],
  ];
  const p = (i: number): [number, number] => c[i] as [number, number];
  const verts = [
    ...p(0), 0, ...p(1), 0, ...p(2), 0,
    ...p(0), 0, ...p(2), 0, ...p(3), 0,
  ];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE PROP KIT
//    Base at y=0, centred on X/Z. Seeded asymmetry on every single one.
// ═════════════════════════════════════════════════════════════════════════════

export interface PropBuild {
  /** Main mass — give it the prop's base ink material. */
  body: BufferGeometry;
  /** Trim / metal / secondary hue. Two hues max per prop (ART_DIRECTION §1). */
  accent?: BufferGeometry;
  /** Emissive bits: put on layer 2 so selective bloom picks them up. */
  glow?: BufferGeometry;
}

export interface PropOptions {
  seed?: number;
  /** Overall scale multiplier. */
  scale?: number;
  /** Extra silhouette wobble in metres. */
  wobble?: number;
}

function collapse(list: BufferGeometry[], wobble: number, seed: number): BufferGeometry {
  const g = mergeForStatic(list);
  for (const x of list) x.dispose();
  if (wobble > 0) jitterVertices(g, wobble, seed);
  return g;
}

function finishProp(build: PropBuild, scale: number): PropBuild {
  if (scale !== 1) {
    place(build.body, { sx: scale, sy: scale, sz: scale });
    if (build.accent) place(build.accent, { sx: scale, sy: scale, sz: scale });
    if (build.glow) place(build.glow, { sx: scale, sy: scale, sz: scale });
  }
  return build;
}

/** Merge every part of a prop into a single geometry (one draw call, one material). */
export function mergeProp(p: PropBuild): BufferGeometry {
  const list = [p.body];
  if (p.accent) list.push(p.accent);
  if (p.glow) list.push(p.glow);
  return mergeForStatic(list);
}

/** A thick board. Slightly tapered and never quite square. */
export function chunkyPlank(length = 2, width = 0.22, thickness = 0.05, opts: PropOptions = {}): BufferGeometry {
  const seed = opts.seed ?? 1;
  const rnd = makeSeededRandom(seed * 17 + 1);
  const geo = bevelBox(length, thickness, width * rnd.range(0.94, 1.06), thickness * 0.42, seed);
  place(geo, { rz: rnd.spread(0.02), ry: rnd.spread(0.015) });
  return jitterVertices(geo, thickness * 0.09, seed + 5);
}

/** A run of pipe with end flanges. Lies along X by default. */
export function pipe(length = 3, radius = 0.09, opts: PropOptions = {}): PropBuild {
  const seed = opts.seed ?? 2;
  const rnd = makeSeededRandom(seed * 29 + 3);
  const body = inkCylinder(radius, length, 8, { seed });
  place(body, { rz: Math.PI * 0.5 });

  const flanges: BufferGeometry[] = [];
  for (const t of [-0.5, -0.16, 0.5]) {
    const f = inkCylinder(radius * 1.45, radius * 0.7, 8, { seed: seed + 11 });
    place(f, { rz: Math.PI * 0.5, x: length * t * rnd.range(0.97, 1.0) });
    flanges.push(f);
  }
  return finishProp(
    { body: jitterVertices(body, radius * 0.05, seed), accent: collapse(flanges, radius * 0.04, seed + 2) },
    opts.scale ?? 1,
  );
}

/** Oil drum: tapered body, rolled rims, two hoops, dented and leaning. */
export function barrel(opts: PropOptions = {}): PropBuild {
  const seed = opts.seed ?? 3;
  const rnd = makeSeededRandom(seed * 37 + 7);
  const r = 0.29 * rnd.range(0.95, 1.06);
  const h = 0.9 * rnd.range(0.94, 1.07);

  const body = inkCylinder(r, h, 10, { radiusTop: r * rnd.range(0.94, 1.0), seed });
  place(body, { y: h * 0.5 });

  const rings: BufferGeometry[] = [];
  for (const t of [0.06, 0.34, 0.66, 0.95]) {
    const ring = inkCylinder(r * 1.06, h * 0.055, 10, { seed: seed + 3 });
    place(ring, { y: h * t, rz: rnd.spread(0.01) });
    rings.push(ring);
  }
  const lid = inkCylinder(r * 0.92, h * 0.03, 10, { seed: seed + 9 });
  place(lid, { y: h * 1.0 });
  rings.push(lid);

  const b: PropBuild = { body: jitterVertices(body, r * 0.045, seed + 1), accent: collapse(rings, r * 0.02, seed + 4) };
  place(b.body, { rz: rnd.spread(0.045), rx: rnd.spread(0.035) });
  if (b.accent) place(b.accent, { rz: rnd.spread(0.045), rx: rnd.spread(0.035) });
  return finishProp(b, opts.scale ?? 1);
}

/** Wooden crate: bevelled cube plus raised corner battens. */
export function crate(size = 0.8, opts: PropOptions = {}): PropBuild {
  const seed = opts.seed ?? 4;
  const rnd = makeSeededRandom(seed * 53 + 11);
  const s = size * rnd.range(0.94, 1.06);
  const body = bevelBox(s, s * rnd.range(0.9, 1.05), s * rnd.range(0.94, 1.04), s * 0.07, seed);
  place(body, { y: s * 0.5 });

  const battens: BufferGeometry[] = [];
  const t = s * 0.075;
  for (const axis of [0, 1]) {
    for (const sgn of [-1, 1]) {
      for (const edge of [0.08, 0.92]) {
        const bar = bevelBox(axis === 0 ? s * 1.02 : t, t, axis === 0 ? t : s * 1.02, t * 0.35, seed + edge * 100);
        place(bar, {
          y: s * edge,
          x: axis === 0 ? 0 : sgn * s * 0.5,
          z: axis === 0 ? sgn * s * 0.5 : 0,
          ry: rnd.spread(0.012),
        });
        battens.push(bar);
      }
    }
  }
  // A diagonal brace on one face — the detail that stops it reading as a cube.
  const brace = bevelBox(s * 1.28, t * 0.85, t * 0.85, t * 0.3, seed + 3);
  place(brace, { rz: Math.PI * 0.25 });
  place(brace, { y: s * 0.5, z: s * 0.5 });
  battens.push(brace);

  const b: PropBuild = { body: jitterVertices(body, s * 0.012, seed + 2), accent: collapse(battens, s * 0.008, seed + 6) };
  place(b.body, { ry: rnd.spread(0.09) });
  if (b.accent) place(b.accent, { ry: rnd.spread(0.09) });
  return finishProp(b, opts.scale ?? 1);
}

/** Chain-link-less picket fence: posts, two rails, leaning slats, some missing. */
export function fence(width = 2, height = 1.6, opts: PropOptions = {}): PropBuild {
  const seed = opts.seed ?? 5;
  const rnd = makeSeededRandom(seed * 71 + 13);
  const posts: BufferGeometry[] = [];
  const slats: BufferGeometry[] = [];
  const postT = 0.11;

  for (const sgn of [-1, 1]) {
    const p = bevelBox(postT, height * rnd.range(1.0, 1.12), postT, postT * 0.28, seed + sgn);
    place(p, { y: height * 0.5, x: (sgn * width) / 2 });
    place(p, { rz: rnd.spread(0.035) });
    posts.push(p);
  }
  for (const ry of [0.28, 0.82]) {
    const rail = bevelBox(width, 0.09, 0.05, 0.02, seed + ry * 10);
    place(rail, { y: height * ry, rz: rnd.spread(0.018) });
    posts.push(rail);
  }

  const count = Math.max(3, Math.round(width / 0.22));
  for (let i = 0; i < count; i++) {
    if (rnd.bool(0.14)) continue; // gaps read as damage, not as a missing feature
    const x = -width * 0.5 + ((i + 0.5) / count) * width;
    const sh = height * rnd.range(0.8, 1.0);
    const s = bevelBox(0.13, sh, 0.035, 0.012, seed + i * 7);
    place(s, { y: sh * 0.5, x, z: 0.045 });
    place(s, { rz: rnd.spread(0.07) });
    // Broken tip: chop the top with a slanted cut by scaling one end thin.
    if (rnd.bool(0.25)) place(s, { sy: rnd.range(0.55, 0.85) });
    slats.push(s);
  }

  return finishProp(
    { body: collapse(slats, 0.006, seed + 3), accent: collapse(posts, 0.008, seed + 4) },
    opts.scale ?? 1,
  );
}

/** Street lamp: splayed base, tapered pole, hooked arm, glowing lens. GOLD practical. */
export function streetLamp(height = 4.2, opts: PropOptions = {}): PropBuild {
  const seed = opts.seed ?? 6;
  const rnd = makeSeededRandom(seed * 89 + 17);
  const parts: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];

  const base = inkCylinder(0.24, 0.18, 8, { radiusTop: 0.17, seed });
  place(base, { y: 0.09 });
  trim.push(base);
  const collar = inkCylinder(0.15, 0.1, 8, { radiusTop: 0.11, seed: seed + 1 });
  place(collar, { y: 0.23 });
  trim.push(collar);

  const pole = inkCylinder(0.09, height, 8, { radiusTop: 0.055, seed: seed + 2 });
  place(pole, { y: height * 0.5 + 0.2 });
  parts.push(pole);

  // The hook: three short segments so the bend is faceted, like an inked curve.
  const armLen = 0.95 * rnd.range(0.9, 1.12);
  let ax = 0;
  let ay = height + 0.2;
  let angle = -Math.PI * 0.5;
  for (let i = 0; i < 3; i++) {
    angle += 0.42;
    const seg = inkCylinder(0.055 - i * 0.007, armLen / 3, 7, { seed: seed + 10 + i });
    place(seg, { rz: angle });
    place(seg, { x: ax + (Math.cos(angle + Math.PI * 0.5) * armLen) / 6, y: ay + (Math.sin(angle + Math.PI * 0.5) * armLen) / 6 });
    parts.push(seg);
    ax += (Math.cos(angle + Math.PI * 0.5) * armLen) / 3;
    ay += (Math.sin(angle + Math.PI * 0.5) * armLen) / 3;
  }

  const shade = inkCone(0.3, 0.26, 7, seed + 20);
  place(shade, { y: ay - 0.02, x: ax });
  trim.push(shade);

  const lens = inkCylinder(0.19, 0.1, 7, { radiusTop: 0.22, seed: seed + 21 });
  place(lens, { y: ay - 0.17, x: ax });

  const b: PropBuild = {
    body: collapse(parts, 0.006, seed + 5),
    accent: collapse(trim, 0.008, seed + 6),
    glow: lens,
  };
  const lean = rnd.spread(0.03);
  place(b.body, { rz: lean });
  if (b.accent) place(b.accent, { rz: lean });
  if (b.glow) place(b.glow, { rz: lean });
  return finishProp(b, opts.scale ?? 1);
}

/** Dumpster: tapered tub, slanted lid, wheels, side ribs. Prime cover prop. */
export function dumpster(opts: PropOptions = {}): PropBuild {
  const seed = opts.seed ?? 7;
  const rnd = makeSeededRandom(seed * 101 + 19);
  const w = 2.0 * rnd.range(0.96, 1.05);
  const h = 1.15;
  const d = 1.05;

  const parts: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];

  const tub = bevelBox(w, h, d, 0.06, seed);
  // Taper the tub: narrower at the bottom, like a real skip.
  const pos = tub.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = y < 0 ? 0.86 : 1;
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
  }
  pos.needsUpdate = true;
  tub.computeVertexNormals();
  place(tub, { y: h * 0.5 + 0.13 });
  parts.push(tub);

  for (let i = 0; i < 4; i++) {
    const rib = bevelBox(0.07, h * 0.92, d * 1.01, 0.02, seed + i);
    place(rib, { x: -w * 0.34 + (i / 3) * w * 0.68, y: h * 0.5 + 0.13 });
    trim.push(rib);
  }

  const lid = bevelBox(w * 1.04, 0.1, d * 1.06, 0.035, seed + 30);
  place(lid, { rx: rnd.spread(0.06), rz: rnd.range(-0.14, -0.03) });
  place(lid, { y: h + 0.2 });
  trim.push(lid);

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = inkCylinder(0.13, 0.08, 7, { seed: seed + 40 });
      place(wheel, { rx: Math.PI * 0.5 });
      place(wheel, { x: sx * w * 0.4, y: 0.13, z: sz * d * 0.36 });
      trim.push(wheel);
    }
  }

  const b: PropBuild = { body: collapse(parts, 0.01, seed + 3), accent: collapse(trim, 0.006, seed + 4) };
  place(b.body, { ry: rnd.spread(0.05) });
  if (b.accent) place(b.accent, { ry: rnd.spread(0.05) });
  return finishProp(b, opts.scale ?? 1);
}

/**
 * A wall with a blown-out top: built from columns of different heights so the
 * silhouette is a jagged comic tear, plus exposed rebar and fallen chunks.
 */
export function brokenWall(width = 3, height = 2.2, thickness = 0.35, opts: PropOptions = {}): PropBuild {
  const seed = opts.seed ?? 8;
  const rnd = makeSeededRandom(seed * 113 + 23);
  const cols = Math.max(4, Math.round(width / 0.32));
  const parts: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];

  // The tear runs across the wall as a noisy profile — highest at one end.
  const peak = rnd.range(0.2, 0.8);
  for (let i = 0; i < cols; i++) {
    const t = (i + 0.5) / cols;
    const dist = Math.abs(t - peak);
    let hh = height * (1 - dist * rnd.range(0.5, 1.1)) * rnd.range(0.86, 1.06);
    hh = Math.max(height * 0.18, Math.min(height, hh));
    const cw = (width / cols) * rnd.range(0.96, 1.04);
    const block = bevelBox(cw, hh, thickness * rnd.range(0.92, 1.05), thickness * 0.14, seed + i);
    place(block, { y: hh * 0.5, x: -width * 0.5 + (i + 0.5) * (width / cols), rz: rnd.spread(0.02), ry: rnd.spread(0.03) });
    parts.push(block);

    // Rebar poking out of the tallest columns.
    if (hh > height * 0.6 && rnd.bool(0.45)) {
      const bar = inkCylinder(0.018, rnd.range(0.2, 0.5), 5, { seed: seed + i * 3 });
      place(bar, { rz: rnd.spread(0.5), rx: rnd.spread(0.4) });
      place(bar, { y: hh + 0.12, x: -width * 0.5 + (i + 0.5) * (width / cols) + rnd.spread(0.05), z: rnd.spread(thickness * 0.3) });
      trim.push(bar);
    }
  }

  // Fallen chunks at the foot of the wall.
  for (let i = 0; i < 5; i++) {
    const c = bevelBox(rnd.range(0.12, 0.3), rnd.range(0.1, 0.22), rnd.range(0.12, 0.28), 0.03, seed + 200 + i);
    place(c, { rx: rnd.spread(0.6), ry: rnd.spread(1.5), rz: rnd.spread(0.6) });
    place(c, { x: rnd.spread(width * 0.55), y: 0.07, z: thickness * 0.5 + rnd.range(0.05, 0.5) });
    parts.push(c);
  }

  return finishProp(
    { body: collapse(parts, 0.012, seed + 5), accent: trim.length ? collapse(trim, 0.004, seed + 6) : undefined },
    opts.scale ?? 1,
  );
}

/** A heap of angular rubble. Cheap silhouette breaker for arena corners. */
export function rubblePile(radius = 0.9, count = 11, opts: PropOptions = {}): BufferGeometry {
  const seed = opts.seed ?? 9;
  const rnd = makeSeededRandom(seed * 137 + 29);
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const a = rnd.range(0, Math.PI * 2);
    const d = radius * Math.sqrt(rnd.next()) * (1 - t * 0.25);
    const s = radius * rnd.range(0.12, 0.34) * (1 - t * 0.4);
    const chunk = rnd.bool(0.75)
      ? bevelBox(s * rnd.range(0.7, 1.6), s * rnd.range(0.6, 1.2), s * rnd.range(0.7, 1.5), s * 0.16, seed + i)
      : inkRock(s * 0.7, seed + i * 3, 5);
    place(chunk, { rx: rnd.spread(1.2), ry: rnd.spread(3.14), rz: rnd.spread(1.2) });
    place(chunk, { x: Math.cos(a) * d, y: s * 0.45 + (1 - d / radius) * radius * 0.35 * rnd.range(0.4, 1), z: Math.sin(a) * d });
    parts.push(chunk);
  }
  return collapse(parts, radius * 0.01, seed + 7);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. DISPATCH — so the arena can data-drive prop placement
// ═════════════════════════════════════════════════════════════════════════════

export type PropKind = 'barrel' | 'crate' | 'dumpster' | 'fence' | 'streetLamp' | 'brokenWall' | 'rubble' | 'pipe' | 'plank';

/** Build any prop by name with a seed — the arena's content table talks to this. */
export function buildProp(kind: PropKind, seed = 1, scale = 1): PropBuild {
  const o: PropOptions = { seed, scale };
  switch (kind) {
    case 'barrel': return barrel(o);
    case 'crate': return crate(0.8, o);
    case 'dumpster': return dumpster(o);
    case 'fence': return fence(2, 1.6, o);
    case 'streetLamp': return streetLamp(4.2, o);
    case 'brokenWall': return brokenWall(3, 2.2, 0.35, o);
    case 'rubble': return { body: rubblePile(0.9, 11, o) };
    case 'pipe': return pipe(3, 0.09, o);
    case 'plank': return { body: chunkyPlank(2, 0.22, 0.05, o) };
  }
}

/** Free every buffer a prop owns. */
export function disposeProp(p: PropBuild): void {
  p.body.dispose();
  p.accent?.dispose();
  p.glow?.dispose();
}

/** Convenience for callers that just want a seeded variation helper. */
export function shapeRandom(seed: number): SeededRandom {
  return makeSeededRandom(seed);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. SKINNABLE SURFACE CAGES
//
// Everything above builds *finished* `BufferGeometry`: non-indexed, flat-shaded, one buffer per
// prop. That is exactly right for a static city and exactly wrong for a skinned character, for
// two reasons that only show up once a mesh deforms:
//
//   1. A SKINNED VERTEX NEEDS AN IDENTITY. Skin weights are solved per *surface point*; a
//      non-indexed buffer has already split every shared corner into three unrelated copies, so
//      the same point can end up with three different weight sets and the mesh tears along every
//      triangle edge the moment a joint bends.
//   2. THE BODY AND ITS INK HULL MUST BE THE SAME SURFACE. The hull is an inverted, inflated
//      copy; if it is derived by welding the finished body geometry (`makeHullGeometry`) its
//      vertex ORDER is unrelated to the body's, so the per-vertex skin attributes have to be
//      re-solved — and any disagreement shows up as the outline sliding off the silhouette.
//
// A `SurfaceCage` is the missing middle: an INDEXED triangle mesh whose topology is known
// analytically (it was lofted, not welded), carrying smooth per-vertex normals. From one cage
// you expand two geometries with IDENTICAL vertex ordering — flat normals for the body, smooth
// normals for the hull — and any per-cage-vertex attribute (skin indices, skin weights, painted
// AO) rides along into both for free.
//
// Nothing above this line changed. These are additions.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * An indexed triangle mesh with analytic topology, before it is expanded for the GPU.
 * `position`/`normal` are 3 floats per vertex, `uv` is 2, and `index` is triangle triples.
 */
export interface SurfaceCage {
  position: Float32Array;
  /** Area-weighted smooth normals, computed from `index`. */
  normal: Float32Array;
  uv: Float32Array;
  index: Uint32Array;
  /** Vertex count (`position.length / 3`). */
  count: number;
}

/**
 * One cross-section of a lofted tube. Authored directly in the cage's own space — no local
 * frame, no `place()` afterwards — because a skinned surface has to be authored in the same
 * space as the skeleton that binds it.
 */
export interface LoftRing {
  x: number;
  y: number;
  z: number;
  /** Half-extent across the ring's local U axis (the "side" of the limb). */
  u: number;
  /** Half-extent across the ring's local V axis (front/back). */
  v: number;
  /** Roll of the cross-section about the chain tangent, radians. */
  roll?: number;
  /**
   * 0 = a hard rounded-rectangle (chunky, bevelled, comic); 1 = a true ellipse. Anything under
   * ~0.5 keeps the flat facets the cel bands need to break on — see the file header.
   */
  round?: number;
}

export interface LoftOptions {
  capStart?: boolean;
  capEnd?: boolean;
  /** Hand-inked wobble, metres. Applied BEFORE normals, so the body and the hull agree. */
  jitter?: number;
  seed?: number;
  /** Texture repeats per metre along the chain. */
  vScale?: number;
  /**
   * How far past the end ring the cap pole is pushed, as a fraction of the end ring's mean
   * radius. 0.35 reads as a rounded end (a limb); ~0.1 reads as a flat lid (a slab).
   */
  capBulge?: number;
}

const _lt = new Vector3();
const _lu = new Vector3();
const _lv = new Vector3();
const _lref = new Vector3();
const _lp = new Vector3();
const _le1 = new Vector3();
const _le2 = new Vector3();
const _lfn = new Vector3();

/** Superellipse cross-section: `round` 0 is boxy, 1 is elliptical. */
function ringPoint(angle: number, round: number, out: { c: number; s: number }): void {
  const k = 0.55 + 0.45 * Math.max(0, Math.min(1, round));
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  out.c = Math.sign(c) * Math.pow(Math.abs(c), k);
  out.s = Math.sign(s) * Math.pow(Math.abs(s), k);
}

const _rp = { c: 0, s: 0 };

/** Area-weighted vertex normals for an indexed cage. Overwrites `cage.normal`. */
export function computeCageNormals(cage: SurfaceCage): SurfaceCage {
  const { position, normal, index } = cage;
  normal.fill(0);
  for (let t = 0; t < index.length; t += 3) {
    const a = (index[t] as number) * 3;
    const b = (index[t + 1] as number) * 3;
    const c = (index[t + 2] as number) * 3;
    _le1.set(
      (position[b] as number) - (position[a] as number),
      (position[b + 1] as number) - (position[a + 1] as number),
      (position[b + 2] as number) - (position[a + 2] as number),
    );
    _le2.set(
      (position[c] as number) - (position[a] as number),
      (position[c + 1] as number) - (position[a + 1] as number),
      (position[c + 2] as number) - (position[a + 2] as number),
    );
    _lfn.copy(_le1).cross(_le2); // length ∝ triangle area — that IS the weighting
    normal[a] += _lfn.x; normal[a + 1] += _lfn.y; normal[a + 2] += _lfn.z;
    normal[b] += _lfn.x; normal[b + 1] += _lfn.y; normal[b + 2] += _lfn.z;
    normal[c] += _lfn.x; normal[c + 1] += _lfn.y; normal[c + 2] += _lfn.z;
  }
  for (let i = 0; i < normal.length; i += 3) {
    const l = Math.hypot(normal[i] as number, normal[i + 1] as number, normal[i + 2] as number);
    if (l > 1e-9) {
      normal[i] = (normal[i] as number) / l;
      normal[i + 1] = (normal[i + 1] as number) / l;
      normal[i + 2] = (normal[i + 2] as number) / l;
    } else {
      normal[i] = 0; normal[i + 1] = 1; normal[i + 2] = 0;
    }
  }
  return cage;
}

/**
 * Loft a closed tube through a chain of rings. The ring plane is perpendicular to the local
 * chain tangent, so a bent chain lofts without pinching, and the seam is closed by index
 * wrap-around rather than by duplicated vertices — which is what lets a skin weight be solved
 * exactly once per surface point.
 */
export function loftTube(rings: readonly LoftRing[], segments: number, opts: LoftOptions = {}): SurfaceCage {
  const n = rings.length;
  if (n < 2) throw new Error('[art/shapes] loftTube needs at least two rings');
  const seg = Math.max(3, segments);
  const capStart = opts.capStart ?? true;
  const capEnd = opts.capEnd ?? true;
  const vScale = opts.vScale ?? 1;
  const seed = opts.seed ?? 1;
  const bulge = opts.capBulge ?? 0.35;

  const startPole = capStart ? n * seg : -1;
  const endPole = capEnd ? n * seg + (capStart ? 1 : 0) : -1;
  const count = n * seg + (capStart ? 1 : 0) + (capEnd ? 1 : 0);

  const position = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);

  // Arc length along the chain, for the V coordinate.
  const arc = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const a = rings[i] as LoftRing;
    const b = rings[i - 1] as LoftRing;
    arc[i] = (arc[i - 1] as number) + Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  for (let i = 0; i < n; i++) {
    const r = rings[i] as LoftRing;
    const prev = rings[Math.max(0, i - 1)] as LoftRing;
    const next = rings[Math.min(n - 1, i + 1)] as LoftRing;
    _lt.set(next.x - prev.x, next.y - prev.y, next.z - prev.z);
    if (_lt.lengthSq() < 1e-12) _lt.set(0, 1, 0);
    _lt.normalize();
    // A reference axis that is never parallel to the tangent, so the frame cannot degenerate.
    _lref.set(0, 0, 1);
    if (Math.abs(_lt.z) > 0.94) _lref.set(0, 1, 0);
    _lu.copy(_lt).cross(_lref).normalize();
    _lv.copy(_lu).cross(_lt).normalize();
    const roll = r.roll ?? 0;
    if (roll !== 0) {
      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      _lp.copy(_lu).multiplyScalar(cr).addScaledVector(_lv, sr);
      _lv.multiplyScalar(cr).addScaledVector(_lu, -sr);
      _lu.copy(_lp);
    }
    const round = r.round ?? 0.25;
    for (let j = 0; j < seg; j++) {
      ringPoint((j / seg) * Math.PI * 2, round, _rp);
      const vi = i * seg + j;
      position[vi * 3] = r.x + _lu.x * _rp.c * r.u + _lv.x * _rp.s * r.v;
      position[vi * 3 + 1] = r.y + _lu.y * _rp.c * r.u + _lv.y * _rp.s * r.v;
      position[vi * 3 + 2] = r.z + _lu.z * _rp.c * r.u + _lv.z * _rp.s * r.v;
      uv[vi * 2] = j / seg;
      uv[vi * 2 + 1] = (arc[i] as number) * vScale;
    }
    // The caps are poles pushed a little past the end ring, so a limb end reads as rounded
    // rather than as a lid — a flat lid catches the key light as a bright disc and breaks the
    // ink. `capBulge` takes it back down to ~flat for slabs (feet, brow, jaw, coat flap).
    if (i === 0 && capStart) {
      const d = (r.u + r.v) * 0.5 * bulge;
      position[startPole * 3] = r.x - _lt.x * d;
      position[startPole * 3 + 1] = r.y - _lt.y * d;
      position[startPole * 3 + 2] = r.z - _lt.z * d;
      uv[startPole * 2] = 0.5;
      uv[startPole * 2 + 1] = -d * vScale;
    }
    if (i === n - 1 && capEnd) {
      const d = (r.u + r.v) * 0.5 * bulge;
      position[endPole * 3] = r.x + _lt.x * d;
      position[endPole * 3 + 1] = r.y + _lt.y * d;
      position[endPole * 3 + 2] = r.z + _lt.z * d;
      uv[endPole * 2] = 0.5;
      uv[endPole * 2 + 1] = ((arc[n - 1] as number) + d) * vScale;
    }
  }

  if (opts.jitter && opts.jitter > 0) {
    const j = opts.jitter;
    for (let i = 0; i < count; i++) {
      position[i * 3] = (position[i * 3] as number) + (hash2(i, seed, 7) - 0.5) * 2 * j;
      position[i * 3 + 1] = (position[i * 3 + 1] as number) + (hash2(i, seed, 71) - 0.5) * 2 * j;
      position[i * 3 + 2] = (position[i * 3 + 2] as number) + (hash2(i, seed, 131) - 0.5) * 2 * j;
    }
  }

  const triCount = (n - 1) * seg * 2 + (capStart ? seg : 0) + (capEnd ? seg : 0);
  const index = new Uint32Array(triCount * 3);
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const j2 = (j + 1) % seg;
      const a = i * seg + j;
      const b = i * seg + j2;
      const c = (i + 1) * seg + j;
      const d = (i + 1) * seg + j2;
      // Winding chosen so the face normal comes out RADIALLY OUTWARD.
      index[k++] = a; index[k++] = c; index[k++] = b;
      index[k++] = b; index[k++] = c; index[k++] = d;
    }
  }
  if (capStart) {
    for (let j = 0; j < seg; j++) {
      index[k++] = startPole; index[k++] = j; index[k++] = (j + 1) % seg;
    }
  }
  if (capEnd) {
    const base = (n - 1) * seg;
    for (let j = 0; j < seg; j++) {
      index[k++] = endPole; index[k++] = base + ((j + 1) % seg); index[k++] = base + j;
    }
  }

  const cage: SurfaceCage = { position, normal: new Float32Array(count * 3), uv, index, count };
  return computeCageNormals(cage);
}

/** Concatenate cages into one. Index offsets are applied; the inputs are left untouched. */
export function mergeCages(cages: readonly SurfaceCage[]): SurfaceCage {
  let count = 0;
  let tris = 0;
  for (const c of cages) {
    count += c.count;
    tris += c.index.length;
  }
  const out: SurfaceCage = {
    position: new Float32Array(count * 3),
    normal: new Float32Array(count * 3),
    uv: new Float32Array(count * 2),
    index: new Uint32Array(tris),
    count,
  };
  let vo = 0;
  let io = 0;
  for (const c of cages) {
    out.position.set(c.position, vo * 3);
    out.normal.set(c.normal, vo * 3);
    out.uv.set(c.uv, vo * 2);
    for (let i = 0; i < c.index.length; i++) out.index[io + i] = (c.index[i] as number) + vo;
    vo += c.count;
    io += c.index.length;
  }
  return out;
}

/** A per-cage-vertex attribute that rides along into the expanded geometry. */
export interface CageAttribute {
  name: string;
  itemSize: number;
  /** `cage.count * itemSize` floats. */
  data: Float32Array;
}

export interface CageExpandOptions {
  /**
   * `true` gives every triangle its own face normal — the crisp faceted look the cel shader
   * wants, and the body mesh's setting. `false` uses the cage's smooth normals, which is what
   * an inverted-hull silhouette needs so it inflates as one continuous shell.
   */
  flat?: boolean;
  attributes?: readonly CageAttribute[];
}

/**
 * Expand an indexed cage to the non-indexed buffer the renderer draws.
 *
 * Two calls on the SAME cage produce two geometries whose vertex `i` is the same surface point,
 * differing only in the normal — which is precisely the guarantee the body/hull pair needs.
 */
export function cageToGeometry(cage: SurfaceCage, opts: CageExpandOptions = {}): BufferGeometry {
  const flat = opts.flat ?? true;
  const tri = cage.index.length;
  const position = new Float32Array(tri * 3);
  const normal = new Float32Array(tri * 3);
  const uv = new Float32Array(tri * 2);
  const extra = (opts.attributes ?? []).map((a) => ({
    name: a.name,
    itemSize: a.itemSize,
    src: a.data,
    dst: new Float32Array(tri * a.itemSize),
  }));

  for (let t = 0; t < tri; t += 3) {
    const i0 = cage.index[t] as number;
    const i1 = cage.index[t + 1] as number;
    const i2 = cage.index[t + 2] as number;
    if (flat) {
      const a = i0 * 3;
      const b = i1 * 3;
      const c = i2 * 3;
      _le1.set(
        (cage.position[b] as number) - (cage.position[a] as number),
        (cage.position[b + 1] as number) - (cage.position[a + 1] as number),
        (cage.position[b + 2] as number) - (cage.position[a + 2] as number),
      );
      _le2.set(
        (cage.position[c] as number) - (cage.position[a] as number),
        (cage.position[c + 1] as number) - (cage.position[a + 1] as number),
        (cage.position[c + 2] as number) - (cage.position[a + 2] as number),
      );
      _lfn.copy(_le1).cross(_le2);
      if (_lfn.lengthSq() < 1e-16) _lfn.set(0, 1, 0); else _lfn.normalize();
    }
    for (let k = 0; k < 3; k++) {
      const s = k === 0 ? i0 : k === 1 ? i1 : i2;
      const d = t + k;
      position[d * 3] = cage.position[s * 3] as number;
      position[d * 3 + 1] = cage.position[s * 3 + 1] as number;
      position[d * 3 + 2] = cage.position[s * 3 + 2] as number;
      if (flat) {
        normal[d * 3] = _lfn.x; normal[d * 3 + 1] = _lfn.y; normal[d * 3 + 2] = _lfn.z;
      } else {
        normal[d * 3] = cage.normal[s * 3] as number;
        normal[d * 3 + 1] = cage.normal[s * 3 + 1] as number;
        normal[d * 3 + 2] = cage.normal[s * 3 + 2] as number;
      }
      uv[d * 2] = cage.uv[s * 2] as number;
      uv[d * 2 + 1] = cage.uv[s * 2 + 1] as number;
      for (const e of extra) {
        for (let c = 0; c < e.itemSize; c++) e.dst[d * e.itemSize + c] = e.src[s * e.itemSize + c] as number;
      }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  for (const e of extra) geo.setAttribute(e.name, new Float32BufferAttribute(e.dst, e.itemSize));
  return geo;
}

/**
 * A bevelled box as a CAGE rather than as finished geometry — for the handful of body parts
 * (brow ridge, jaw, feet, coat flap) whose read is a hard slab, not a swept limb. Built as four
 * lofted rings so it shares the loft's topology guarantees; the chamfer comes from the ring
 * profile, exactly as `bevelBox`'s does from its hull.
 */
export function boxCage(
  cx: number, cy: number, cz: number,
  w: number, h: number, d: number,
  opts: { round?: number; jitter?: number; seed?: number; segments?: number } = {},
): SurfaceCage {
  const round = opts.round ?? 0.18;
  const hh = h * 0.5;
  return loftTube(
    [
      { x: cx, y: cy - hh * 0.92, z: cz, u: w * 0.42, v: d * 0.42, round },
      { x: cx, y: cy - hh * 0.45, z: cz, u: w * 0.5, v: d * 0.5, round },
      { x: cx, y: cy + hh * 0.45, z: cz, u: w * 0.5, v: d * 0.5, round },
      { x: cx, y: cy + hh * 0.92, z: cz, u: w * 0.42, v: d * 0.42, round },
    ],
    opts.segments ?? 8,
    { jitter: opts.jitter, seed: opts.seed, capStart: true, capEnd: true, capBulge: 0.18 },
  );
}

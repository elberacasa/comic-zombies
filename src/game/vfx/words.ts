/**
 * ONOMATOPOEIA — the loudest thing in the game.
 *
 * `art/letters.ts` already owns the hard part (hard drop shadow → wobbling ink contour → PAPER
 * keyline → two-tone fill → halftone, every letter individually rotated and scaled). This file
 * is only the *staging*: a small pool of billboards that punch a pre-rendered word into world
 * space with an overshoot curve and take it away again.
 *
 * WHY THIS IS THE ONE FAMILY THAT IS NOT INSTANCED. Every other VFX family shares one atlas and
 * therefore one draw call. A word cannot: it is a different texture per word, and the words are
 * the hero effect — downsampling twelve of them into a shared sheet to save eight draw calls we
 * are not short of would trade the most visible art in the game for nothing. So word pops are
 * ordinary meshes, hard-capped at `VFX.pool.words`, sharing one geometry and one texture cache.
 * Typical live count during a fight is 2–3; the cap is 10.
 *
 * ART §4.1: a word animates only while it is alive. There is no idle wobble, no boil, no
 * per-frame jitter — the per-letter chaos is baked into the texture ONCE, at build time, which
 * is exactly how a printed page works.
 */

import {
  DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3,
  type Object3D, type Texture,
} from 'three';

import { Pool } from '@/core/pool';
import { easeOutCubic, clamp01 } from '@/core/mathx';
import { LAYER } from '@/render/materials/index';
import { VFX } from '@/game/tuning';
import type { WordTexture } from '@/art/letters';

interface WordBillboard {
  mesh: Mesh;
  material: MeshBasicMaterial;
  age: number;
  life: number;
  height: number;
  aspect: number;
  /** World position the word was born at. */
  x: number; y: number; z: number;
  /** Final resting roll, radians — the word settles crooked, never square. */
  roll: number;
}

const _pos = new Vector3();
const _toCam = new Vector3();
const _q = new Quaternion();

export class WordPops {
  private readonly pool: Pool<WordBillboard>;
  private readonly liveList: WordBillboard[] = [];
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly root: Object3D;
  private placeholder: Texture | null = null;

  constructor(root: Object3D, capacity: number) {
    this.root = root;
    this.pool = new Pool<WordBillboard>({
      label: 'vfx:words',
      max: Math.max(1, capacity),
      create: () => this.build(),
      reset: (w) => { w.mesh.visible = false; w.age = 0; },
    });
  }

  /** The first word ever rendered becomes the placeholder map, so USE_MAP is compiled in once. */
  prime(tex: Texture): void {
    if (!this.placeholder) this.placeholder = tex;
  }

  private build(): WordBillboard {
    const material = new MeshBasicMaterial({
      map: this.placeholder,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    const mesh = new Mesh(this.geometry, material);
    mesh.name = 'vfx-word';
    mesh.frustumCulled = false;
    mesh.visible = false;
    // Flat cards must not enter the ink prepass — a Sobel filter sees a rectangle, and the
    // word already carries three layers of its own ink.
    mesh.layers.set(LAYER.NO_INK);
    mesh.renderOrder = 12;
    this.root.add(mesh);
    return { mesh, material, age: 0, life: 1, height: 1, aspect: 1, x: 0, y: 0, z: 0, roll: 0 };
  }

  get live(): number { return this.liveList.length; }
  get peak(): number { return this.pool.peak; }
  get starved(): number { return this.pool.starved; }

  /**
   * Stage a word. `roll` is its final crooked angle in radians — ART §7 wants nothing sterile,
   * so a word that lands dead level is a bug.
   */
  spawn(at: Vector3, word: WordTexture, scale: number, roll: number): boolean {
    // Prime BEFORE acquiring: a billboard built with `map = null` compiles without USE_MAP, and
    // every word assigned to it afterwards would be invisible.
    this.prime(word.texture);
    const w = this.pool.acquire();
    if (!w) return false;
    const hadMap = w.material.map !== null;
    w.material.map = word.texture;
    // Only ever true on the very first spawn of a freshly built billboard.
    if (!hadMap) w.material.needsUpdate = true;
    w.material.opacity = 1;
    w.age = 0;
    w.life = Math.max(0.05, VFX.wordLifetime);
    w.height = VFX.wordHeight * Math.max(0.05, scale);
    w.aspect = word.aspect;
    w.x = at.x; w.y = at.y; w.z = at.z;
    w.roll = roll;
    w.mesh.visible = true;
    w.mesh.scale.set(1e-4, 1e-4, 1);
    w.mesh.position.copy(at);
    this.liveList.push(w);
    return true;
  }

  step(dt: number, camQuat: Quaternion, camPos: Vector3): void {
    const popIn = Math.max(0.01, VFX.wordPopIn);
    const over = VFX.wordOvershoot;
    for (let i = this.liveList.length - 1; i >= 0; i--) {
      const w = this.liveList[i];
      const age = w.age + dt;
      if (age >= w.life) {
        w.mesh.visible = false;
        this.liveList.splice(i, 1);
        this.pool.release(w);
        continue;
      }
      w.age = age;
      const t = age / w.life;

      // PUNCH IN: fast in, overshoot past `wordOvershoot`, settle. Nothing eases linearly
      // (ART §8). The sine term is the overshoot and it returns to zero exactly at u = 1, so
      // the word arrives at its authored size with no residual wobble.
      let s: number;
      if (t < popIn) {
        const u = t / popIn;
        s = easeOutCubic(u) * (1 + (over - 1) * Math.sin(u * Math.PI));
      } else {
        // …then a slow drift bigger, and a fast snap away at the very end.
        const u = (t - popIn) / (1 - popIn);
        s = 1 + u * 0.09 - clamp01((u - 0.82) / 0.18) * 0.45;
      }
      const h = w.height * Math.max(0.001, s);

      // Rise on an arc and step toward the viewer, so a word never sinks into the thing it
      // was printed on top of.
      const rise = VFX.wordRise * (t * (2 - t));
      _pos.set(w.x, w.y + rise, w.z);
      _toCam.copy(camPos).sub(_pos);
      const d = _toCam.length();
      if (d > 1e-3) _pos.addScaledVector(_toCam, (VFX.wordTowardCamera * Math.min(1, t * 3)) / d);

      w.mesh.position.copy(_pos);
      _q.copy(camQuat);
      w.mesh.quaternion.copy(_q);
      w.mesh.rotateZ(w.roll);
      w.mesh.scale.set(h * w.aspect, h, 1);
      w.material.opacity = t < 0.72 ? 1 : 1 - (t - 0.72) / 0.28;
    }
  }

  clear(): void {
    for (let i = this.liveList.length - 1; i >= 0; i--) {
      const w = this.liveList[i];
      w.mesh.visible = false;
      this.pool.release(w);
    }
    this.liveList.length = 0;
  }

  dispose(): void {
    this.clear();
    this.pool.clear((w) => {
      w.mesh.parent?.remove(w.mesh);
      w.material.dispose();
    });
    this.geometry.dispose();
  }
}

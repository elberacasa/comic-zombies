/**
 * THE EMITTERS — five families, five draw calls, one simulation style.
 *
 * Each class owns an `InstancedField` plus flat `Float32Array` state indexed by slot. There is
 * no per-effect object, no closure and no allocation anywhere in `step()`: spawning fills the
 * emitter's single reusable descriptor and hands it over, and the per-frame loop walks the
 * field's packed live list.
 *
 *   CardEmitter    billboarded flats on ballistic arcs — ink droplets, dust, impact spikes
 *   ShardEmitter   free-tumbling panel shards — the death beat
 *   TracerEmitter  the bullet streak, a stretched quad, never a laser
 *   DecalField     the print that stays. Oldest-first recycling, QUANTISED fade (ART §4.1)
 *   NumberEmitter  damage numbers, composed digit by digit out of the sheet
 *
 * ART §5 governs the shapes; `tuning.ts::VFX` governs how many and how long. Nothing in this
 * file picks a colour — tints arrive from the service, which gets them from the palette.
 *
 * TIME. Everything here is stepped with the SCALED frame delta, so hitstop freezes the VFX too.
 * That is deliberate: ART §8's hold frame and GAME_BIBLE §8's hitstop only read as weight if
 * the ink freezes with the world. A word pop that keeps rising through a 4-frame freeze
 * un-sells the whole impact.
 */

import { Color, Matrix4, Quaternion, Vector3 } from 'three';

import { RingBuffer } from '@/core/pool';
import { clamp01 } from '@/core/mathx';
import { InstancedField, composeBillboard, composeFree, composeStreak, composeSurface } from '@/game/vfx/field';
import type { Cell } from '@/game/vfx/sheet';
import { VFX } from '@/game/tuning';

const _m = new Matrix4();
const _p = new Vector3();
const _p2 = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _axis = new Vector3();

/**
 * The out curve every short-lived card shares: hold the shape, then leave fast.
 * A linear fade reads as a dissolve; ink does not dissolve, it stops being printed.
 */
function outCurve(t: number, holdTo: number): number {
  if (t <= holdTo) return 1;
  const u = (t - holdTo) / (1 - holdTo);
  return 1 - u * u;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// CARDS — the workhorse. Anything flat, billboarded and thrown.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface CardDesc {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Quad height in metres; width comes from the cell's aspect. */
  size: number;
  /** Multiplier applied to `size` over the card's life. 1 = no change, >1 opens out. */
  grow: number;
  life: number;
  cell: Cell;
  tint: Color;
  roll: number;
  rollV: number;
  /** Fraction of `VFX.gravity` this card feels. Dust floats (~0.1), blood-ink falls (1). */
  grav: number;
  /** Exponential velocity damping per second. */
  drag: number;
  /** Fraction of life spent fully printed before the out curve starts. */
  hold: number;
  /**
   * Y below which the card has landed. `-Infinity` means it never lands, it just expires.
   * On landing `onLand` fires — which is how flying ink becomes a decal.
   */
  landY: number;
}

function newCardDesc(): CardDesc {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    size: 0.1, grow: 1, life: 0.5, cell: null as unknown as Cell, tint: new Color(1, 1, 1),
    roll: 0, rollV: 0, grav: 1, drag: 0, hold: 0.6, landY: -Infinity,
  };
}

/** Called when a card lands. Colour is passed as raw linear components — no Color allocated. */
export type LandFn = (x: number, y: number, z: number, r: number, g: number, b: number, size: number) => void;

export class CardEmitter {
  readonly field: InstancedField;
  /** Fill this, then call `emit()`. Reused every spawn — never retain it. */
  readonly desc: CardDesc = newCardDesc();
  /** Fires when a card crosses `landY`. The service turns flying ink into a decal here. */
  onLand: LandFn | null = null;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly grow: Float32Array;
  private readonly aspect: Float32Array;
  private readonly roll: Float32Array;
  private readonly rollV: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly hold: Float32Array;
  private readonly landY: Float32Array;
  private readonly rgb: Float32Array;

  constructor(field: InstancedField) {
    this.field = field;
    const n = field.capacity;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.age = new Float32Array(n); this.life = new Float32Array(n);
    this.size = new Float32Array(n); this.grow = new Float32Array(n); this.aspect = new Float32Array(n);
    this.roll = new Float32Array(n); this.rollV = new Float32Array(n);
    this.grav = new Float32Array(n); this.drag = new Float32Array(n); this.hold = new Float32Array(n);
    this.landY = new Float32Array(n).fill(-Infinity); this.rgb = new Float32Array(n * 3);
  }

  emit(): number {
    const d = this.desc;
    const s = this.field.acquire();
    if (s < 0) return -1;
    this.px[s] = d.x; this.py[s] = d.y; this.pz[s] = d.z;
    this.vx[s] = d.vx; this.vy[s] = d.vy; this.vz[s] = d.vz;
    this.age[s] = 0; this.life[s] = Math.max(1e-3, d.life);
    this.size[s] = d.size; this.grow[s] = d.grow; this.aspect[s] = d.cell.aspect;
    this.roll[s] = d.roll; this.rollV[s] = d.rollV;
    this.grav[s] = d.grav; this.drag[s] = d.drag; this.hold[s] = d.hold;
    this.landY[s] = d.landY;
    const o = s * 3;
    this.rgb[o] = d.tint.r; this.rgb[o + 1] = d.tint.g; this.rgb[o + 2] = d.tint.b;
    this.field.setCell(s, d.cell);
    this.field.setTint(s, d.tint);
    this.field.setFade(s, 1);
    return s;
  }

  step(dt: number, camQuat: Quaternion): void {
    const f = this.field;
    const dense = f.dense;
    const g = VFX.gravity;
    for (let i = f.live - 1; i >= 0; i--) {
      const s = dense[i];
      const age = this.age[s] + dt;
      const life = this.life[s];
      if (age >= life) { f.release(s); continue; }
      this.age[s] = age;

      const damp = Math.max(0, 1 - this.drag[s] * dt);
      const vx = this.vx[s] * damp;
      const vy = (this.vy[s] - g * this.grav[s] * dt) * damp;
      const vz = this.vz[s] * damp;

      const x = this.px[s] + vx * dt;
      const y = this.py[s] + vy * dt;
      const z = this.pz[s] + vz * dt;

      const floor = this.landY[s];
      if (y <= floor) {
        if (this.onLand) {
          const o = s * 3;
          this.onLand(x, floor, z, this.rgb[o], this.rgb[o + 1], this.rgb[o + 2], this.size[s]);
        }
        f.release(s);
        continue;
      }

      this.vx[s] = vx; this.vy[s] = vy; this.vz[s] = vz;
      this.px[s] = x; this.py[s] = y; this.pz[s] = z;

      const t = age / life;
      const roll = this.roll[s] + this.rollV[s] * dt;
      this.roll[s] = roll;
      const h = this.size[s] * (1 + (this.grow[s] - 1) * t);
      _p.set(x, y, z);
      composeBillboard(_m, _p, camQuat, roll, h * this.aspect[s], h);
      f.setMatrix(s, _m);
      f.setFade(s, outCurve(t, this.hold[s]));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// SHARDS — the death beat. Flat panels with ink borders, tumbling away.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface ShardDesc {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  size: number;
  life: number;
  cell: Cell;
  tint: Color;
  /** Unit tumble axis and rate, rad/s. */
  ax: number; ay: number; az: number;
  spin: number;
  /** Initial orientation — the caller randomises it so no two shards start on the same face. */
  q: Quaternion;
}

function newShardDesc(): ShardDesc {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0.2, life: 1.4,
    cell: null as unknown as Cell, tint: new Color(1, 1, 1),
    ax: 0, ay: 1, az: 0, spin: 6, q: new Quaternion(),
  };
}

export class ShardEmitter {
  readonly field: InstancedField;
  readonly desc: ShardDesc = newShardDesc();

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly aspect: Float32Array;
  private readonly axis: Float32Array;
  private readonly spin: Float32Array;
  private readonly angle: Float32Array;
  /** The shard's starting orientation, xyzw per slot. */
  private readonly q0: Float32Array;

  constructor(field: InstancedField) {
    this.field = field;
    const n = field.capacity;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.age = new Float32Array(n); this.life = new Float32Array(n);
    this.size = new Float32Array(n); this.aspect = new Float32Array(n);
    this.axis = new Float32Array(n * 3); this.spin = new Float32Array(n); this.angle = new Float32Array(n);
    this.q0 = new Float32Array(n * 4);
  }

  emit(): number {
    const d = this.desc;
    const s = this.field.acquire();
    if (s < 0) return -1;
    this.px[s] = d.x; this.py[s] = d.y; this.pz[s] = d.z;
    this.vx[s] = d.vx; this.vy[s] = d.vy; this.vz[s] = d.vz;
    this.age[s] = 0; this.life[s] = Math.max(1e-3, d.life);
    this.size[s] = d.size; this.aspect[s] = d.cell.aspect;
    const o3 = s * 3;
    this.axis[o3] = d.ax; this.axis[o3 + 1] = d.ay; this.axis[o3 + 2] = d.az;
    this.spin[s] = d.spin; this.angle[s] = 0;
    const o4 = s * 4;
    this.q0[o4] = d.q.x; this.q0[o4 + 1] = d.q.y; this.q0[o4 + 2] = d.q.z; this.q0[o4 + 3] = d.q.w;
    this.field.setCell(s, d.cell);
    this.field.setTint(s, d.tint);
    this.field.setFade(s, 1);
    return s;
  }

  step(dt: number): void {
    const f = this.field;
    const dense = f.dense;
    const g = VFX.gravity;
    for (let i = f.live - 1; i >= 0; i--) {
      const s = dense[i];
      const age = this.age[s] + dt;
      const life = this.life[s];
      if (age >= life) { f.release(s); continue; }
      this.age[s] = age;

      const vy = this.vy[s] - g * dt;
      this.vy[s] = vy;
      const x = this.px[s] + this.vx[s] * dt;
      const y = this.py[s] + vy * dt;
      const z = this.pz[s] + this.vz[s] * dt;
      this.px[s] = x; this.py[s] = y; this.pz[s] = z;

      const ang = this.angle[s] + this.spin[s] * dt;
      this.angle[s] = ang;
      const o4 = s * 4;
      const o3 = s * 3;
      _q.set(this.q0[o4], this.q0[o4 + 1], this.q0[o4 + 2], this.q0[o4 + 3]);
      _axis.set(this.axis[o3], this.axis[o3 + 1], this.axis[o3 + 2]);
      _q.multiply(_q2.setFromAxisAngle(_axis, ang));

      const t = age / life;
      // Shards shrink as they fade — a panel torn out of the page is being UN-DRAWN, and a
      // constant-size quad going transparent reads as a ghost instead.
      const h = this.size[s] * (1 - 0.35 * t * t);
      _p.set(x, y, z);
      composeFree(_m, _p, _q, h * this.aspect[s], h);
      f.setMatrix(s, _m);
      f.setFade(s, outCurve(t, 0.55));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TRACERS
// ═════════════════════════════════════════════════════════════════════════════════════════════

export class TracerEmitter {
  readonly field: InstancedField;

  private readonly ox: Float32Array;
  private readonly oy: Float32Array;
  private readonly oz: Float32Array;
  private readonly dx: Float32Array;
  private readonly dy: Float32Array;
  private readonly dz: Float32Array;
  private readonly dist: Float32Array;
  private readonly age: Float32Array;
  private readonly width: Float32Array;

  constructor(field: InstancedField) {
    this.field = field;
    const n = field.capacity;
    this.ox = new Float32Array(n); this.oy = new Float32Array(n); this.oz = new Float32Array(n);
    this.dx = new Float32Array(n); this.dy = new Float32Array(n); this.dz = new Float32Array(n);
    this.dist = new Float32Array(n); this.age = new Float32Array(n); this.width = new Float32Array(n);
  }

  /** `dir` must be normalised; `dist` is where the bullet actually stopped. */
  emit(from: Vector3, dir: Vector3, dist: number, width: number, cell: Cell, tint: Color): number {
    const s = this.field.acquire();
    if (s < 0) return -1;
    this.ox[s] = from.x; this.oy[s] = from.y; this.oz[s] = from.z;
    this.dx[s] = dir.x; this.dy[s] = dir.y; this.dz[s] = dir.z;
    this.dist[s] = dist; this.age[s] = 0; this.width[s] = width;
    this.field.setCell(s, cell);
    this.field.setTint(s, tint);
    this.field.setFade(s, 1);
    return s;
  }

  step(dt: number, camPos: Vector3): void {
    const f = this.field;
    const dense = f.dense;
    const speed = VFX.tracerSpeed;
    const len = VFX.tracerLength;
    const life = Math.max(1e-3, VFX.tracerLifetime);
    for (let i = f.live - 1; i >= 0; i--) {
      const s = dense[i];
      const age = this.age[s] + dt;
      this.age[s] = age;
      const dist = this.dist[s];
      const head = Math.min(dist, speed * age);
      const tail = Math.max(0, head - len);
      if (age >= life || tail >= dist - 1e-3) { f.release(s); continue; }
      _p.set(this.ox[s] + this.dx[s] * tail, this.oy[s] + this.dy[s] * tail, this.oz[s] + this.dz[s] * tail);
      _p2.set(this.ox[s] + this.dx[s] * head, this.oy[s] + this.dy[s] * head, this.oz[s] + this.dz[s] * head);
      composeStreak(_m, _p, _p2, camPos, this.width[s]);
      f.setMatrix(s, _m);
      f.setFade(s, 1 - clamp01(age / life) * 0.65);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// DECALS — the print that stays.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A fixed-size decal book with oldest-first recycling.
 *
 * THE FADE IS QUANTISED (ART §4.1). A decal holds one of `VFX.decalFadeSteps` flat opacities and
 * jumps between them; between jumps its instance data is not touched at all, so a settled decal
 * is bit-identical from frame to frame and the stillness test sees nothing. The step clock
 * carries a per-decal phase offset so two decals never cross a boundary on the same frame — a
 * synchronised jump would put the whole floor into one frame's diff.
 *
 * The last step does NOT reach zero: ink soaks into a page, it does not evaporate. A decal
 * leaves only when the book is full and it is the oldest entry — which is also what makes the
 * floor of a long fight a record of that fight.
 */
export class DecalField {
  readonly field: InstancedField;

  private readonly age: Float32Array;
  private readonly phase: Float32Array;
  private readonly stepIdx: Int8Array;
  private readonly order: RingBuffer<number>;

  constructor(field: InstancedField) {
    this.field = field;
    const n = field.capacity;
    this.age = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.stepIdx = new Int8Array(n);
    this.order = new RingBuffer<number>(n);
  }

  /** `phase01` staggers this decal's fade clock; pass a [0,1) roll from the seeded RNG. */
  emit(
    point: Vector3, normal: Vector3, roll: number, size: number,
    cell: Cell, tint: Color, phase01: number,
  ): number {
    let s = this.field.acquire();
    if (s < 0) {
      // The book is full: retire the oldest print, then take its place.
      const oldest = this.order.shift();
      if (oldest === undefined) return -1;
      this.field.release(oldest);
      s = this.field.acquire();
      if (s < 0) return -1;
    }
    this.order.push(s);

    this.age[s] = 0;
    this.phase[s] = phase01;
    this.stepIdx[s] = 0;
    _p.copy(point).addScaledVector(normal, VFX.decalOffset);
    composeSurface(_m, _p, normal, roll, size * cell.aspect, size);
    this.field.setMatrix(s, _m);
    this.field.setCell(s, cell);
    this.field.setTint(s, tint);
    this.field.setFade(s, 1);
    return s;
  }

  /** Opacity of fade step `i` of `n`. Step 0 is fresh ink; the last step is soaked-in ink. */
  private static levelOf(i: number, n: number): number {
    if (i <= 0) return 1;
    return 1 - (i / Math.max(1, n - 1)) * 0.62;
  }

  step(dt: number): void {
    const f = this.field;
    const dense = f.dense;
    const steps = Math.max(2, VFX.decalFadeSteps | 0);
    const per = Math.max(0.05, VFX.decalFadeTime) / steps;
    for (let i = f.live - 1; i >= 0; i--) {
      const s = dense[i];
      const cur = this.stepIdx[s];
      // A fully soaked decal is FROZEN. No clock, no write, nothing in the frame diff.
      if (cur >= steps - 1) continue;
      const age = this.age[s] + dt;
      this.age[s] = age;
      const want = Math.min(steps - 1, Math.floor((age + this.phase[s] * per) / per));
      if (want !== cur) {
        this.stepIdx[s] = want;
        f.setFade(s, DecalField.levelOf(want, steps));
      }
    }
  }

  clear(): void {
    this.order.clear();
    this.field.releaseAll();
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// DAMAGE NUMBERS — composed from the sheet's digits, so an unbounded set of values costs one
// draw call and not one new texture.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Hard ceiling on digits per number; `VFX.damageNumberMaxDigits` may be lower, never higher. */
const MAX_DIGITS = 6;
/** Digit advance as a fraction of the glyph's own width — comic type is tightly tracked. */
const DIGIT_TRACKING = 0.84;
/** Scratch for `layout`'s allocation-free digit extraction. Least significant first. */
const _digits = new Int8Array(MAX_DIGITS);

export class NumberEmitter {
  readonly field: InstancedField;

  private readonly cap: number;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vz: Float32Array;
  /** Per-number rise multiplier. Numbers that all climb at the same rate stay in one row. */
  private readonly riseK: Float32Array;
  private readonly age: Float32Array;
  private readonly value: Float32Array;
  private readonly owner: Int32Array;
  private readonly crit: Int8Array;
  private readonly slots: Int32Array;
  private readonly count: Int8Array;
  private readonly live: Int32Array;
  private readonly freeList: Int32Array;
  private liveCount = 0;
  private freeCount: number;
  /** slot → the aspect of the digit printed in it. The field does not keep cell metadata. */
  private readonly aspectOf: Float32Array;
  private readonly tintNormal = new Color();
  private readonly tintCrit = new Color();
  private readonly digits: readonly Cell[];

  constructor(field: InstancedField, digits: readonly Cell[], normal: Color, crit: Color) {
    this.field = field;
    this.digits = digits;
    this.tintNormal.copy(normal);
    this.tintCrit.copy(crit);
    this.aspectOf = new Float32Array(field.capacity).fill(0.8);
    // One logical number owns up to `damageNumberMaxDigits` quads, so the number cap follows.
    this.cap = Math.max(4, Math.floor(field.capacity / Math.max(1, VFX.damageNumberMaxDigits)));
    const n = this.cap;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vz = new Float32Array(n); this.riseK = new Float32Array(n).fill(1);
    this.age = new Float32Array(n); this.value = new Float32Array(n);
    this.owner = new Int32Array(n).fill(-1);
    this.crit = new Int8Array(n);
    this.slots = new Int32Array(n * MAX_DIGITS).fill(-1);
    this.count = new Int8Array(n);
    this.live = new Int32Array(n);
    this.freeList = new Int32Array(n);
    for (let i = 0; i < n; i++) this.freeList[i] = n - 1 - i;
    this.freeCount = n;
  }

  /** Live logical numbers (not quads). */
  get liveNumbers(): number { return this.liveCount; }

  /**
   * Add `amount` to the recent number belonging to `ownerId`, or start a new one.
   * Merging is what keeps a full magazine into one zombie readable as a rising count instead
   * of twelve sprites fighting over the same 40 px of screen.
   */
  /**
   * `vary` is a [0,1) roll that separates this number from its neighbours: it offsets the
   * spawn height and scales the climb rate. Without it every number in a crowd rises at the
   * same speed from the same height and they line up into one unreadable row of digits —
   * measured, and it looked like a single wrong number.
   */
  emit(pos: Vector3, amount: number, isCrit: boolean, ownerId: number, driftAngle: number, vary = 0.5): void {
    if (amount <= 0) return;
    for (let i = 0; i < this.liveCount; i++) {
      const n = this.live[i];
      if (this.owner[n] === ownerId && this.age[n] < VFX.damageNumberMerge) {
        this.value[n] += amount;
        this.age[n] = 0;
        if (isCrit) this.crit[n] = 1;
        this.px[n] = pos.x; this.py[n] = pos.y; this.pz[n] = pos.z;
        this.layout(n);
        return;
      }
    }
    if (this.freeCount === 0) return;
    const n = this.freeList[--this.freeCount];
    this.px[n] = pos.x;
    this.py[n] = pos.y + (vary - 0.5) * VFX.damageNumberStagger;
    this.pz[n] = pos.z;
    this.riseK[n] = 0.72 + vary * 0.62;
    this.vx[n] = Math.cos(driftAngle) * VFX.damageNumberArc;
    this.vz[n] = Math.sin(driftAngle) * VFX.damageNumberArc;
    this.age[n] = 0;
    this.value[n] = amount;
    this.crit[n] = isCrit ? 1 : 0;
    this.owner[n] = ownerId;
    this.count[n] = 0;
    this.live[this.liveCount++] = n;
    this.layout(n);
  }

  /** (Re)acquire exactly as many digit quads as the current value needs, and print them. */
  /**
   * (Re)acquire exactly as many digit quads as the current value needs, and print them.
   *
   * Digits are extracted by division into a scratch buffer rather than via `String(v)`. That is
   * not premature: `layout` runs on every bullet that lands, and at 400 rpm across a horde a
   * throwaway string per hit is the only allocation left on the whole VFX hot path.
   */
  private layout(n: number): void {
    const cap = Math.min(VFX.damageNumberMaxDigits, MAX_DIGITS);
    // CLAMP, never truncate. Taking the first `cap` characters of a string turns 12345 into
    // "1234" — a number that is wrong by 10×, and silently. Clamping shows 9999, which reads
    // as "off the scale" instead of as a lie.
    const limit = Math.pow(10, cap) - 1;
    let value = Math.min(limit, Math.max(1, Math.round(this.value[n])));
    let want = 0;
    while (value > 0 && want < cap) { _digits[want++] = value % 10; value = (value / 10) | 0; }
    if (want === 0) { _digits[0] = 0; want = 1; }

    const base = n * MAX_DIGITS;
    for (let i = want; i < this.count[n]; i++) {
      const s = this.slots[base + i];
      if (s >= 0) { this.field.release(s); this.slots[base + i] = -1; }
    }
    const tint = this.crit[n] ? this.tintCrit : this.tintNormal;
    for (let i = 0; i < want; i++) {
      let s = this.slots[base + i];
      if (s < 0) {
        s = this.field.acquire();
        if (s < 0) { this.count[n] = i; return; }
        this.slots[base + i] = s;
      }
      // `_digits` is least-significant first; slot 0 must print the most significant digit.
      const cell = this.digits[_digits[want - 1 - i]];
      this.field.setCell(s, cell);
      this.field.setTint(s, tint);
      this.aspectOf[s] = cell.aspect;
    }
    this.count[n] = want;
  }

  private free(n: number): void {
    const base = n * MAX_DIGITS;
    for (let i = 0; i < MAX_DIGITS; i++) {
      const s = this.slots[base + i];
      if (s >= 0) { this.field.release(s); this.slots[base + i] = -1; }
    }
    this.count[n] = 0;
    this.owner[n] = -1;
    this.freeList[this.freeCount++] = n;
  }

  step(dt: number, camQuat: Quaternion): void {
    const life = Math.max(0.1, VFX.damageNumberLifetime);
    const rise = VFX.damageNumberRise;
    for (let i = this.liveCount - 1; i >= 0; i--) {
      const n = this.live[i];
      const age = this.age[n] + dt;
      if (age >= life) {
        this.free(n);
        this.live[i] = this.live[--this.liveCount];
        continue;
      }
      this.age[n] = age;
      const t = age / life;

      // PUNCH IN, THEN ARC OUT (ART §7: "numbers punch/overshoot when they change").
      // `sin(pi*u)` on the first 14% of life is the overshoot; nothing here eases linearly.
      const u = t / 0.14;
      const scale = t < 0.14 ? u * (1 + 0.55 * Math.sin(u * Math.PI)) : 1;

      const h = VFX.damageNumberSize * (this.crit[n] ? VFX.damageNumberCritScale : 1) * scale;
      const y = this.py[n] + rise * this.riseK[n] * (t * (2 - t));
      const x = this.px[n] + this.vx[n] * t;
      const z = this.pz[n] + this.vz[n] * t;
      const fade = outCurve(t, 0.62);

      // Lay the digits out around the number's centre along the CAMERA's right axis, each on
      // its own aspect, so the lettering kerns like drawn type and not a monospaced readout.
      const base = n * MAX_DIGITS;
      const cnt = this.count[n];
      let total = 0;
      for (let k = 0; k < cnt; k++) {
        const s = this.slots[base + k];
        if (s >= 0) total += this.aspectOf[s] * h * DIGIT_TRACKING;
      }
      let cursor = -total * 0.5;
      for (let k = 0; k < cnt; k++) {
        const s = this.slots[base + k];
        if (s < 0) continue;
        const w = this.aspectOf[s] * h;
        const adv = w * DIGIT_TRACKING;
        _p2.set(cursor + adv * 0.5, 0, 0).applyQuaternion(camQuat);
        _p.set(x, y, z).add(_p2);
        composeBillboard(_m, _p, camQuat, 0, w, h);
        this.field.setMatrix(s, _m);
        this.field.setFade(s, fade);
        cursor += adv;
      }
    }
  }

  /** Recycle every number — round reset, game over, teardown. */
  clear(): void {
    for (let i = this.liveCount - 1; i >= 0; i--) this.free(this.live[i]);
    this.liveCount = 0;
  }
}

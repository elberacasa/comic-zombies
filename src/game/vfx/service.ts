/**
 * VFX — the real `VfxService`.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SYSTEM IS
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * Every visible consequence of a bullet, a hit, a death, a step and a landing. It owns six
 * `InstancedMesh` families over one procedural atlas plus a small pool of word billboards, and
 * it is wired to the rest of the game ENTIRELY through the typed event bus — it imports nothing
 * from `weapons/**`, `enemies/**` or `player/**`, and nothing imports it.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE THREE RULES THIS FILE IS BUILT AROUND
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. **ART §5 — SHAPES, NOT SOFT PARTICLES.** There is not one blurred sprite in here. A muzzle
 *    flash is a hard-edged star polygon with a GOLD core and a HOT fringe, printed for two
 *    frames. An impact is a radial ink-spike burst plus a hand-drawn splat decal. Blood is INK:
 *    HOT droplets with drip tails, thrown on real ballistic arcs, that splat flat onto whatever
 *    they land on. Death is panel shards with ink borders spinning off the page.
 *
 * 2. **ART §4.1 — THE PRINT IS FIXED, ONLY THE DRAWING MOVES.** Effects animate while they are
 *    alive; NOTHING animates at rest. There is no ambient emitter, no idle shimmer, no
 *    per-frame random on anything that has settled, and no `Math.random()` anywhere — all
 *    variation comes from a forked seeded `RNG` at the moment of spawn and is then frozen into
 *    the effect. The one thing that outlives its animation is the decal, whose fade is
 *    quantised to four flat levels so a settled decal is bit-identical between frames
 *    (`emitters.ts::DecalField`). With nothing alive, every family sets `visible = false` and
 *    the VFX layer contributes zero draw calls and zero changed pixels.
 *
 * 3. **ART §9 — THE RESERVED CHANNELS BELONG TO ENEMIES.** VFX may use `HOT` (it is the damage
 *    channel, and blood-ink is the loudest use of it there is) and `GOLD` (muzzle core, damage
 *    numbers, rewards), but never at enemy scale on a static surface: blood decals are `HOT`
 *    knocked toward `INK` so a floor covered in them can never out-shout a live zombie, and no
 *    VFX in this file uses `ACID` except the panel shards of a zombie that has just died —
 *    which is the enemy's own colour leaving the frame.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * TIMING
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * All stepping happens in `lateUpdate`, after every other system's `update` and after the
 * player has composed the camera. That is what makes "input → muzzle flash, same frame"
 * (M2 §6) true regardless of registration order, and it is why the flash can be pinned to the
 * camera's FINAL transform instead of last frame's.
 *
 * The delta used is `ctx.time.dt` — the SCALED frame delta — so hitstop freezes the ink with
 * the world. A 4-frame freeze in which the blood keeps flying is a 4-frame freeze that reads
 * as a stutter instead of an impact.
 */

import { Color, Group, Quaternion, SRGBColorSpace, Vector3 } from 'three';

import type {
  GameCtx, ImpactKind, RNG, SurfaceKind, System, VfxService,
} from '@/core/types';
import { clamp01 } from '@/core/mathx';
import { PALETTE, color, hexMix } from '@/art/palette';
import {
  WORD_SETS, WORD_SET_STYLE, makeWordTexture, pickWord,
  type WordSetName, type WordStyleOptions, type WordTexture,
} from '@/art/letters';
import { VFX } from '@/game/tuning';

import { buildVfxSheet, type Cell, type VfxSheet } from '@/game/vfx/sheet';
import { InstancedField } from '@/game/vfx/field';
import { CardEmitter, DecalField, NumberEmitter, ShardEmitter, TracerEmitter } from '@/game/vfx/emitters';
import { WordPops } from '@/game/vfx/words';

// ─────────────────────────────────────────────────────────────────────────────
// Scratch. Nothing below this line allocates after `init()`.
// ─────────────────────────────────────────────────────────────────────────────

const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _n = new Vector3();
const _dir = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _back = new Vector3();
const _camPos = new Vector3();
const _camQuat = new Quaternion();
const _q = new Quaternion();
const UP = new Vector3(0, 1, 0);

/**
 * One cap height for every generated word.
 *
 * `art/letters.ts` caches a texture per (text + resolved style) and warns that the vocabulary
 * costs about a megabyte a word. Pinning the cap height means the whole game shares ONE cached
 * texture per word instead of one per call site, and emphasis is expressed where it belongs —
 * in the world-space scale of the billboard, not in the size of the canvas.
 */
const WORD_FONT_SIZE = 104;

/** Sets pre-rendered during `init` so the first BLAM! never costs a frame. */
const PREWARM_SETS: readonly WordSetName[] = ['gun', 'crit', 'kill'];

/** How many recent impact sites the burst rate limiter remembers. See `burstAllowed`. */
const BURST_SITES = 12;
/** Metres. Roughly one shambler torso, so "the same target" resolves spatially. */
const BURST_RADIUS = 0.55;

// ═════════════════════════════════════════════════════════════════════════════════════════════

export class VfxSystem implements System, VfxService {
  readonly name = 'vfx';

  private ctx: GameCtx | null = null;
  private rng: RNG | null = null;
  private sheet: VfxSheet | null = null;
  private readonly root = new Group();
  private readonly unsubscribe: (() => void)[] = [];

  // ── families ────────────────────────────────────────────────────────────────
  private cardField!: InstancedField;
  private flashField!: InstancedField;
  private tracerField!: InstancedField;
  private shardField!: InstancedField;
  private decalFieldI!: InstancedField;
  private digitField!: InstancedField;

  private cards!: CardEmitter;
  private flashes!: CardEmitter;
  private tracers!: TracerEmitter;
  private shards!: ShardEmitter;
  private decals!: DecalField;
  private numbers!: NumberEmitter;
  private words!: WordPops;

  // ── palette handles, resolved once (the palette's `color()` returns shared, immutable
  //    instances — these are read, never mutated) ──────────────────────────────
  private readonly cWhite = new Color(1, 1, 1);
  /** Ring of recent burst sites: [x, y, z, unscaledTime] × BURST_SITES. See `burstAllowed`. */
  private readonly burstSites = new Float32Array(BURST_SITES * 4).fill(-1e9);
  private burstCursor = 0;
  private readonly cScratch = new Color();
  private readonly cLand = new Color();
  private cBlood!: Color;
  private cBloodDecal!: Color;
  private cInkDecal!: Color;
  private cGold!: Color;
  private cPaper!: Color;
  private cRust!: Color;
  private cElectric!: Color;
  private cDust!: Color;
  private cAcid!: Color;

  // ── the deferred shot (see `resolveShot`) ───────────────────────────────────
  private shotPending = false;
  private readonly shotDir = new Vector3();
  private readonly shotHitPoint = new Vector3();
  private shotHit = false;
  private shotIndex = 0;
  private lastShotAt = -99;

  // ── rate limiters, in unscaled seconds ──────────────────────────────────────
  private nextGunWord = 0;
  private nextCritWord = 0;
  private nextKillWord = 0;
  private nextHurtWord = 0;
  private nextWorldWord = 0;
  /** The global "one sound at a time" gate — see `emitWord`. */
  private nextAnyWord = 0;
  /** The anti-strobe gate — see `flash()`. */
  private nextFlash = 0;
  /** Resolved word styles, one per set, built on first use — see `wordTexture`. */
  private readonly wordStyles = new Map<WordSetName, WordStyleOptions>();

  /** Remaining seconds of the HOT speed-line pulse a big hit asks for. */
  private lineTimer = 0;
  /** Anonymous damage numbers (no enemy behind them) never merge with each other. */
  private anonOwner = -2;

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  init(ctx: GameCtx): void {
    this.ctx = ctx;
    this.rng = ctx.rng.fork(0x5f1a7);

    this.cBlood = color(PALETTE.HOT);
    // The blood on the FLOOR is knocked toward INK. ART §9 reserves the loud end of HOT for
    // living enemies; two hundred full-strength splats would out-shout the zombies standing on
    // them, which is a gameplay bug dressed as a nice-looking floor.
    this.cBloodDecal = color(hexMix(PALETTE.HOT, PALETTE.INK, 0.42));
    this.cInkDecal = color(hexMix(PALETTE.INK, PALETTE.INK_SOFT, 0.5));
    this.cGold = color(PALETTE.GOLD);
    this.cPaper = color(PALETTE.PAPER);
    this.cRust = color(PALETTE.RUST);
    this.cElectric = color(PALETTE.ELECTRIC);
    this.cDust = color(hexMix(PALETTE.CONCRETE, PALETTE.PAPER, 0.25));
    this.cAcid = color(PALETTE.ACID);

    const sheet = buildVfxSheet();
    this.sheet = sheet;
    const P = VFX.pool;

    this.cardField = new InstancedField({ name: 'cards', capacity: P.cards, sheet: sheet.texture, renderOrder: 4 });
    this.flashField = new InstancedField({ name: 'flash', capacity: P.flashes, sheet: sheet.texture, renderOrder: 10, bloom: true });
    this.tracerField = new InstancedField({ name: 'tracers', capacity: P.tracers, sheet: sheet.texture, renderOrder: 6 });
    this.shardField = new InstancedField({ name: 'shards', capacity: P.shards, sheet: sheet.texture, solid: true });
    this.decalFieldI = new InstancedField({
      name: 'decals', capacity: VFX.maxDecals, sheet: sheet.texture, renderOrder: 1, polygonOffset: 4,
    });
    this.digitField = new InstancedField({ name: 'digits', capacity: P.digits, sheet: sheet.texture, renderOrder: 11 });

    this.cards = new CardEmitter(this.cardField);
    this.flashes = new CardEmitter(this.flashField);
    this.tracers = new TracerEmitter(this.tracerField);
    this.shards = new ShardEmitter(this.shardField);
    this.decals = new DecalField(this.decalFieldI);
    this.numbers = new NumberEmitter(this.digitField, sheet.digit, this.cGold, this.cBlood);

    // Flying ink becomes printed ink. This is the whole "blood is INK" idea in one hook.
    this.cards.onLand = (x, y, z, r, g, b, size) => this.landInk(x, y, z, r, g, b, size);

    this.root.name = 'vfx';
    this.root.add(
      this.decalFieldI.mesh, this.cardField.mesh, this.tracerField.mesh,
      this.shardField.mesh, this.flashField.mesh, this.digitField.mesh,
    );
    ctx.scene.add(this.root);

    this.words = new WordPops(this.root, VFX.pool.words);
    for (const set of PREWARM_SETS) {
      for (const w of WORD_SETS[set] as readonly string[]) this.words.prime(this.wordTexture(set, w).texture);
    }

    // ART §5: "INK while sprinting, HOT on a big hit". The sprint colour is the resting state;
    // `fx:shake` above `bigHitShake` borrows the channel and gives it straight back.
    ctx.renderer.setSpeedLineColor(PALETTE.INK);

    this.subscribe(ctx);
    this.watch(ctx);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.words?.dispose();
    this.cardField?.dispose();
    this.flashField?.dispose();
    this.tracerField?.dispose();
    this.shardField?.dispose();
    this.decalFieldI?.dispose();
    this.digitField?.dispose();
    this.root.parent?.remove(this.root);
    this.sheet?.dispose();
    this.sheet = null;
    this.ctx = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The frame
  // ═══════════════════════════════════════════════════════════════════════════

  lateUpdate(_alpha: number, ctx: GameCtx): void {
    const dt = ctx.time.dt;

    // The camera is final by now — every other system's lateUpdate has run.
    ctx.camera.updateMatrixWorld();
    _camPos.setFromMatrixPosition(ctx.camera.matrixWorld);
    _camQuat.setFromRotationMatrix(ctx.camera.matrixWorld);

    // The shot is staged here rather than in the event handler so the flash sits on THIS
    // frame's muzzle, and so the tracer knows where the bullet actually stopped.
    if (this.shotPending) {
      this.resolveShot();
      this.shotPending = false;
      this.shotHit = false;
    }

    if (dt > 0) {
      this.cards.step(dt, _camQuat);
      this.flashes.step(dt, _camQuat);
      this.shards.step(dt);
      this.tracers.step(dt, _camPos);
      this.numbers.step(dt, _camQuat);
      this.words.step(dt, _camQuat, _camPos);
      this.decals.step(dt);

      if (this.lineTimer > 0) {
        this.lineTimer -= dt;
        ctx.renderer.speedLines(VFX.bigHitLines * clamp01(this.lineTimer / Math.max(1e-3, VFX.bigHitLineTime)));
        if (this.lineTimer <= 0) ctx.renderer.setSpeedLineColor(PALETTE.INK);
      }
    }

    // One upload per family, and only when something in it actually moved.
    this.cardField.flush();
    this.flashField.flush();
    this.tracerField.flush();
    this.shardField.flush();
    this.decalFieldI.flush();
    this.digitField.flush();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VfxService
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * A bullet lands. Two layers, always: a burst that flashes at the point of contact, and a
   * spray of ink spikes thrown back along the surface normal. `bullet` and `explosion` use the
   * printed GOLD/HOT star; everything else uses the tintable spike ring, so blood is HOT,
   * shock is ELECTRIC and flame is RUST without a second texture.
   */
  impact(position: Vector3, normal: Vector3, kind: ImpactKind, scale = 1): void {
    const rng = this.rng;
    const sheet = this.sheet;
    if (!rng || !sheet) return;
    const s = Math.max(0.05, scale);
    _n.copy(normal);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();

    const printed = kind === 'bullet' || kind === 'explosion';
    const tint = this.kindTint(kind);

    // ── the burst ────────────────────────────────────────────────────────────
    // Rate-limited PER TARGET AREA (see `burstAllowed`). The spray, the damage number, the
    // hitmarker and the blood all still fire on every single hit — only the one big burst card
    // is capped, because N of them summed is what produced a screen-filling HOT flare over the
    // enemy that the player is trying to look at. ART §9: the largest, most saturated thing in
    // a combat frame must be an ENEMY, not an effect drawn on top of one.
    const d = this.cards.desc;
    if (kind === 'explosion' || this.burstAllowed(position)) {
      d.x = position.x + _n.x * 0.03; d.y = position.y + _n.y * 0.03; d.z = position.z + _n.z * 0.03;
      d.vx = 0; d.vy = 0; d.vz = 0;
      d.size = VFX.impactBurstSize * s;
      d.grow = 2.3;
      d.life = VFX.impactBurstTime * (kind === 'explosion' ? 3 : 1);
      d.cell = printed ? this.pick(sheet.burst, rng) : this.pick(sheet.spike, rng);
      // PAPER, not pure white. `new Color(1,1,1)` is brighter than the palette's own reserved
      // white (PAPER, 0.91), so a routine pistol impact was minting the single brightest value
      // in the frame out of thin air — off-palette by construction.
      d.tint = printed ? this.cPaper : tint;
      d.roll = rng.range(0, Math.PI * 2);
      d.rollV = 0;
      d.grav = 0; d.drag = 0; d.hold = 0.2; d.landY = -Infinity;
      this.cards.emit();
    }

    // ── the spray ────────────────────────────────────────────────────────────
    const n = Math.max(1, Math.round(VFX.impactParticles * VFX.density * s * this.headroom()));
    for (let i = 0; i < n; i++) {
      this.hemisphere(_dir, _n, rng, 0.78);
      const speed = rng.range(2.2, 7.5) * s;
      d.x = position.x + _n.x * 0.04; d.y = position.y + _n.y * 0.04; d.z = position.z + _n.z * 0.04;
      d.vx = _dir.x * speed; d.vy = _dir.y * speed; d.vz = _dir.z * speed;
      d.size = rng.range(VFX.impactSpikeSize[0], VFX.impactSpikeSize[1]) * s;
      d.grow = 1;
      d.life = VFX.impactLifetime * rng.range(0.4, 1);
      d.cell = this.pick(sheet.spike, rng);
      d.tint = tint;
      d.roll = rng.range(0, Math.PI * 2);
      d.rollV = rng.range(-9, 9);
      d.grav = 0.85; d.drag = 2.4; d.hold = 0.35; d.landY = -Infinity;
      this.cards.emit();
    }
  }

  /**
   * TWO FRAMES OF STAR (`VFX.muzzleFlashTime` = 45 ms). Two overlapping cells at different
   * rolls and sizes so no two shots print the same frame — the variation is rolled once, at
   * spawn, and then frozen (ART §4.1 forbids varying it per frame).
   */
  muzzleFlash(position: Vector3, direction: Vector3, scale = 1): void {
    const rng = this.rng;
    const sheet = this.sheet;
    if (!rng || !sheet) return;
    const s = VFX.muzzleFlashSize * Math.max(0.05, scale);
    const d = this.flashes.desc;
    for (let i = 0; i < 2; i++) {
      d.x = position.x; d.y = position.y; d.z = position.z;
      d.vx = direction.x * 0.6; d.vy = direction.y * 0.6; d.vz = direction.z * 0.6;
      d.size = s * (i === 0 ? 1 : 0.62);
      d.grow = i === 0 ? 1.55 : 2.1;
      d.life = VFX.muzzleFlashTime * (i === 0 ? 1 : 0.75);
      d.cell = this.pick(sheet.burst, rng);
      // PAPER is the palette's reserved white; `Color(1,1,1)` is off-palette and brighter than
      // anything a colourist would put on the page. The flash keeps its GOLD core from the
      // sheet — this only stops the card being multiplied past the top of the value ladder.
      d.tint = this.cPaper;
      d.roll = rng.range(0, Math.PI * 2);
      d.rollV = 0;
      d.grav = 0; d.drag = 0; d.hold = 0.45; d.landY = -Infinity;
      this.flashes.emit();
    }
  }

  /** A streak, not a beam: `tracerLength` metres of tapered ink travelling at `tracerSpeed`. */
  tracer(from: Vector3, to: Vector3, thickness = 1): void {
    const rng = this.rng;
    const sheet = this.sheet;
    if (!rng || !sheet) return;
    _dir.copy(to).sub(from);
    const dist = _dir.length();
    if (dist < 0.05) return;
    _dir.multiplyScalar(1 / dist);
    this.tracers.emit(from, _dir, dist, VFX.tracerWidth * Math.max(0.1, thickness), this.pick(sheet.streak, rng), this.cGold);
  }

  /**
   * BLOOD IS INK (ART §5). HOT droplets with drip tails thrown on real ballistic arcs, that
   * splat flat onto the ground as decals when they land. The floor of a fight is written by
   * this method.
   */
  inkSplatter(position: Vector3, direction: Vector3, amount: number): void {
    const rng = this.rng;
    const sheet = this.sheet;
    const ctx = this.ctx;
    if (!rng || !sheet || !ctx) return;

    _dir.copy(direction);
    if (_dir.lengthSq() < 1e-6) _dir.copy(UP);
    _dir.normalize();

    // One ground probe per splatter, not one per droplet — this is an octree raycast.
    const gy = ctx.world.groundAt(position);
    const landY = gy === null ? -Infinity : gy + 0.012;

    const n = Math.max(1, Math.round(VFX.bloodParticles * VFX.density * Math.max(0.1, amount) * this.headroom()));
    const d = this.cards.desc;
    for (let i = 0; i < n; i++) {
      this.hemisphere(_v2, _dir, rng, 0.55);
      const speed = rng.range(VFX.inkSpeed[0], VFX.inkSpeed[1]) * Math.min(1.6, 0.7 + amount * 0.5);
      d.x = position.x; d.y = position.y; d.z = position.z;
      d.vx = _v2.x * speed;
      d.vy = _v2.y * speed + rng.range(VFX.inkLift[0], VFX.inkLift[1]);
      d.vz = _v2.z * speed;
      d.size = rng.range(VFX.inkSize[0], VFX.inkSize[1]);
      d.grow = 1;
      d.life = VFX.inkLifetime * rng.range(0.7, 1.25);
      d.cell = this.pick(sheet.drop, rng);
      d.tint = this.cBlood;
      d.roll = rng.range(0, Math.PI * 2);
      // Droplets tumble slowly. A fast spin turns a drip tail into a propeller.
      d.rollV = rng.range(-2.2, 2.2);
      d.grav = 1; d.drag = VFX.inkDrag; d.hold = 0.72;
      d.landY = rng.next() < VFX.inkDecalChance ? landY : -Infinity;
      this.cards.emit();
    }
  }

  /**
   * DEATH IS A PANEL SHATTER. Flat quads with ink borders, thrown along `direction`, tumbling
   * on their own axes and shrinking as they go — the character is being un-drawn.
   */
  panelShatter(position: Vector3, direction: Vector3, colorHex: number): void {
    const rng = this.rng;
    const sheet = this.sheet;
    if (!rng || !sheet) return;
    _dir.copy(direction);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0);
    _dir.normalize();
    this.cScratch.setHex(colorHex, SRGBColorSpace);

    const n = Math.max(1, Math.round(VFX.deathShards * VFX.density * this.headroomOf(this.shardField)));
    const d = this.shards.desc;
    for (let i = 0; i < n; i++) {
      this.hemisphere(_v2, _dir, rng, 0.35);
      const speed = VFX.deathShardSpeed * rng.range(0.35, 1.15);
      d.x = position.x + rng.range(-0.22, 0.22);
      d.y = position.y + rng.range(-0.55, 0.55);
      d.z = position.z + rng.range(-0.22, 0.22);
      d.vx = _v2.x * speed;
      d.vy = _v2.y * speed + rng.range(1.5, 4.5);
      d.vz = _v2.z * speed;
      d.size = rng.range(VFX.shardSize[0], VFX.shardSize[1]);
      d.life = VFX.deathShardLifetime * rng.range(0.7, 1.15);
      d.cell = this.pick(sheet.shard, rng);
      d.tint = this.cScratch;
      rng.unitSphere(_v3);
      d.ax = _v3.x; d.ay = _v3.y; d.az = _v3.z;
      d.spin = rng.range(VFX.shardSpin[0], VFX.shardSpin[1]) * (rng.next() < 0.5 ? -1 : 1);
      d.q.setFromAxisAngle(_v3, rng.range(0, Math.PI * 2));
      this.shards.emit();
    }
  }

  /** Billboarded onomatopoeia. `text` may be anything; the style is picked from `colorHex`. */
  wordPop(position: Vector3, text: string, colorHex: number, scale = 1): void {
    const rng = this.rng;
    if (!rng || !this.words) return;
    const tex = makeWordTexture(text, {
      fill: tokenFor(colorHex),
      fontSize: WORD_FONT_SIZE,
      rotate: -6,
      jitter: 1,
      outline: 0.088,
    });
    this.words.spawn(position, tex, scale, rng.range(-0.16, 0.16));
  }

  /** GOLD normal, HOT and 45% larger on a crit. Arcs out, punches in, never eases linearly. */
  damageNumber(position: Vector3, amount: number, isCrit: boolean): void {
    const rng = this.rng;
    if (!rng) return;
    this.numbers.emit(position, amount, isCrit, this.anonOwner--, rng.range(0, Math.PI * 2), rng.next());
  }

  explosion(position: Vector3, radius: number): void {
    const rng = this.rng;
    const sheet = this.sheet;
    const ctx = this.ctx;
    if (!rng || !sheet || !ctx) return;
    const r = Math.max(0.5, radius);

    // The fireball: one big printed star, held then gone. No smoke, ever.
    const f = this.flashes.desc;
    f.x = position.x; f.y = position.y; f.z = position.z;
    f.vx = 0; f.vy = 0; f.vz = 0;
    f.size = r * VFX.explosionCoreScale;
    f.grow = 1.9;
    f.life = VFX.explosionTime;
    f.cell = this.pick(sheet.burst, rng);
    f.tint = this.cWhite;
    f.roll = rng.range(0, Math.PI * 2);
    f.rollV = 0; f.grav = 0; f.drag = 0; f.hold = 0.35; f.landY = -Infinity;
    this.flashes.emit();

    // RUST spikes blown outward, plus shards of whatever it went off next to.
    const d = this.cards.desc;
    const n = Math.max(1, Math.round(VFX.explosionCards * VFX.density * this.headroom()));
    for (let i = 0; i < n; i++) {
      rng.unitSphere(_v2);
      _v2.y = Math.abs(_v2.y) * 0.7 + 0.15;
      _v2.normalize();
      const speed = rng.range(0.4, 1.5) * r * 3.4;
      d.x = position.x; d.y = position.y; d.z = position.z;
      d.vx = _v2.x * speed; d.vy = _v2.y * speed; d.vz = _v2.z * speed;
      d.size = rng.range(0.12, 0.4) * r;
      d.grow = 1.7;
      d.life = rng.range(0.25, 0.65);
      d.cell = this.pick(sheet.spike, rng);
      d.tint = rng.next() < 0.35 ? this.cGold : this.cRust;
      d.roll = rng.range(0, Math.PI * 2);
      d.rollV = rng.range(-7, 7);
      d.grav = 0.5; d.drag = 2.6; d.hold = 0.3; d.landY = -Infinity;
      this.cards.emit();
    }
    this.panelShatter(position, UP, PALETTE.RUST);
    this.dust(position, VFX.explosionShards);

    const gy = ctx.world.groundAt(position);
    if (gy !== null) {
      _v.set(position.x, gy, position.z);
      this.decals.emit(
        _v, UP, rng.range(0, Math.PI * 2), r * 1.4,
        this.pick(sheet.splat, rng), this.cInkDecal, rng.next(),
      );
    }

    this.flash(VFX.flashExplosion, PALETTE.PAPER);
    this.shake(VFX.shakeExplosion, VFX.shakeExplosionTime);
    ctx.events.emit('fx:hitstop', { seconds: 0.1 });
    this.emitWord('explosion', position, 1.5, 0);
  }

  /** Additive camera shake. The camera owns the response; this only asks for it. */
  shake(amount: number, duration: number): void {
    this.ctx?.events.emit('fx:shake', { amount, duration });
  }

  /** Flat inked puffs, floating up and out. Not a smoke sprite — a drawn poof. */
  dust(position: Vector3, amount: number): void {
    const rng = this.rng;
    const sheet = this.sheet;
    if (!rng || !sheet) return;
    const n = Math.max(1, Math.round(amount * VFX.density * this.headroom()));
    const d = this.cards.desc;
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const sp = rng.range(0.25, 1) * VFX.dustSpread;
      d.x = position.x + Math.cos(a) * 0.08;
      d.y = position.y + rng.range(0.02, 0.14);
      d.z = position.z + Math.sin(a) * 0.08;
      d.vx = Math.cos(a) * sp; d.vy = rng.range(0.35, 1) * VFX.dustRise; d.vz = Math.sin(a) * sp;
      d.size = rng.range(VFX.dustSize[0], VFX.dustSize[1]);
      d.grow = 1.85;
      d.life = VFX.dustLifetime * rng.range(0.7, 1.3);
      d.cell = this.pick(sheet.dust, rng);
      d.tint = this.cDust;
      d.roll = rng.range(0, Math.PI * 2);
      d.rollV = rng.range(-1.1, 1.1);
      // Dust barely feels gravity and dies to drag. That is what makes it float rather than
      // fall, without a single soft pixel.
      d.grav = 0.06; d.drag = 2.2; d.hold = 0.25; d.landY = -Infinity;
      this.cards.emit();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The bus. Twelve subscriptions, no imports.
  // ═══════════════════════════════════════════════════════════════════════════

  private subscribe(ctx: GameCtx): void {
    const on = ctx.events.on.bind(ctx.events);
    const u = this.unsubscribe;

    // ── the gun ──────────────────────────────────────────────────────────────
    u.push(on('weapon:fired', (p) => {
      // The payload's vectors are shared scratch — read them here, never retain them.
      this.shotDir.copy(p.direction);
      this.shotIndex = p.shotIndex;
      this.shotPending = true;
      this.shotHit = false;
    }));

    // ── the world takes it ───────────────────────────────────────────────────
    u.push(on('hit:world', (p) => {
      if (!this.shotHit) { this.shotHitPoint.copy(p.point); this.shotHit = true; }
      _v.copy(p.point);
      _n.copy(p.normal);
      this.impact(_v, _n, p.kind, 1);
      this.worldDecal(_v, _n, p.surface);
      if (p.surface === 'concrete' || p.surface === 'dirt') this.dust(_v, 2);
      this.emitWord('hitWorld', _v, 0.65, 0.12);
    }));

    // ── a zombie takes it ────────────────────────────────────────────────────
    u.push(on('hit:enemy', (p) => {
      const rng = this.rng;
      const ctx2 = this.ctx;
      if (!rng || !ctx2) return;
      const info = p.info;
      if (!this.shotHit) { this.shotHitPoint.copy(info.point); this.shotHit = true; }
      _v.copy(info.point);
      _n.copy(info.normal);
      _dir.copy(info.direction);

      const crit = info.isCrit || info.part === 'head';
      this.impact(_v, _n, 'blood', crit ? 1.35 : 1);
      // Ink sprays BACK toward the shooter as well as through — a bullet exit and an entry
      // spray at once, which is the comic read even though it is not the physical one.
      _v2.copy(_n).multiplyScalar(0.65).add(_dir).normalize();
      this.inkSplatter(_v, _v2, crit ? 1.5 : 0.8);

      _v3.copy(_v);
      _v3.y += 0.24;
      this.numbers.emit(_v3, info.amount, crit, p.target.id, rng.range(0, Math.PI * 2), rng.next());

      // NOTE: no full-screen flash on a crit — see `VFX.flashCrit`. At 400 rpm that is a 7 Hz
      // strobe. The crit already reads through four other channels.
      if (crit && !p.killed) {
        this.flash(VFX.flashCrit, PALETTE.PAPER);
        this.emitWord('crit', _v3, 1.05, 0);
      }
    }));

    // ── it comes apart ───────────────────────────────────────────────────────
    u.push(on('enemy:killed', (p) => {
      const rng = this.rng;
      const ctx2 = this.ctx;
      if (!rng || !ctx2) return;
      _v.copy(p.position);
      // Shards blow AWAY from the player: the killing blow came from here.
      _dir.copy(_v).sub(ctx2.player.eye);
      _dir.y = 0.55;
      if (_dir.lengthSq() < 1e-6) _dir.copy(UP);
      _dir.normalize();

      this.panelShatter(_v, _dir, PALETTE.ACID);
      this.inkSplatter(_v, UP, 2.2);
      this.deathPool(_v);

      // PAPER, not HOT: ART §5's flash frame is the comic WHITE impact frame. HOT full-screen
      // is reserved for the player being hurt, so the two can never be confused.
      this.flash(VFX.flashKill, PALETTE.PAPER);
      this.shake(VFX.shakeKill, VFX.shakeKillTime);

      _v3.copy(_v);
      _v3.y += 0.35;
      if (p.byCrit) this.emitWord('crit', _v3, 1.3, 0);
      else this.emitWord('kill', _v3, 1.15, 0);
    }));

    u.push(on('enemy:dismembered', (p) => {
      const rng = this.rng;
      const sheet = this.sheet;
      if (!rng || !sheet) return;
      _v.copy(p.position);
      rng.unitSphere(_dir);
      _dir.y = Math.abs(_dir.y) * 0.6 + 0.3;
      _dir.normalize();
      this.inkSplatter(_v, _dir, 1.4);
      // A limb leaves a few shards of its own — the cut is comic-clean, so the panel tears.
      const d = this.shards.desc;
      for (let i = 0; i < 4; i++) {
        this.hemisphere(_v2, _dir, rng, 0.4);
        const speed = VFX.deathShardSpeed * rng.range(0.3, 0.7);
        d.x = _v.x; d.y = _v.y; d.z = _v.z;
        d.vx = _v2.x * speed; d.vy = _v2.y * speed + 1.6; d.vz = _v2.z * speed;
        d.size = rng.range(VFX.shardSize[0], VFX.shardSize[1] * 0.7);
        d.life = VFX.deathShardLifetime * 0.8;
        d.cell = this.pick(sheet.shard, rng);
        d.tint = this.cAcid;
        rng.unitSphere(_v3);
        d.ax = _v3.x; d.ay = _v3.y; d.az = _v3.z;
        d.spin = rng.range(VFX.shardSpin[0], VFX.shardSpin[1]);
        d.q.setFromAxisAngle(_v3, rng.range(0, Math.PI * 2));
        this.shards.emit();
      }
    }));

    // ── the player ───────────────────────────────────────────────────────────
    u.push(on('player:damaged', (p) => {
      const ctx2 = this.ctx;
      if (!ctx2) return;
      this.flash(VFX.flashHurt, PALETTE.HOT);
      // Ink thrown off the player, biased away from where the hit came from. Placed a metre
      // out so it reads in the frame instead of smearing the near plane.
      _dir.copy(p.fromDirection).negate();
      _dir.y = 0.35;
      _dir.normalize();
      _v.copy(ctx2.player.eye).addScaledVector(_dir, 0.9);
      this.inkSplatter(_v, _dir, 0.7);
      this.bigHitLines();
      this.emitWord('hurt', _v, 1, 0);
    }));

    u.push(on('player:landed', (p) => {
      _v.copy(p.position);
      const hard = clamp01((p.impactSpeed - 3) / 9);
      this.dust(_v, VFX.dustLand * (0.35 + hard));
    }));

    u.push(on('player:footstep', (p) => {
      _v.copy(p.position);
      this.dust(_v, (p.sprinting ? VFX.dustSprint : VFX.dustWalk) * 0.5);
    }));

    // ── presentation requests from anyone ────────────────────────────────────
    u.push(on('fx:word', (p) => {
      this.wordPop(p.position, p.text, p.color, p.scale ?? 1);
    }));

    // NOTE: this handler must never emit `fx:shake` — `shake()` emits it, and a re-emit here
    // would be an infinite loop. It only borrows the speed-line channel.
    u.push(on('fx:shake', (p) => {
      if (p.amount >= VFX.bigHitShake) this.bigHitLines();
    }));

    // `flash` and `hitstop` both combine by MAX, so routing them here is idempotent even
    // though `main.ts` routes them too. Duplicated wiring cannot double an effect.
    u.push(on('fx:flash', (p) => { this.ctx?.renderer.flash(p.intensity, p.color); }));
    u.push(on('fx:hitstop', (p) => { this.ctx?.time.hitstop(p.seconds); }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internals
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Stage the shot that fired this frame.
   *
   * The muzzle anchor is derived from the camera's FINAL world basis plus `VFX.muzzleLocal`,
   * not from the viewmodel — VFX must not import `weapons/**` (ARCHITECTURE §1). If the gun is
   * ever re-posed and the flash drifts off the barrel, `VFX.muzzleLocal` is the one number.
   */
  private resolveShot(): void {
    const ctx = this.ctx;
    const rng = this.rng;
    if (!ctx || !rng) return;

    const m = ctx.camera.matrixWorld;
    _right.setFromMatrixColumn(m, 0).normalize();
    _up.setFromMatrixColumn(m, 1).normalize();
    _back.setFromMatrixColumn(m, 2).normalize();
    const L = VFX.muzzleLocal;
    _v.copy(_camPos).addScaledVector(_right, L[0]).addScaledVector(_up, L[1]).addScaledVector(_back, L[2]);

    // `shotIndex` is the recoil-pattern index (0..7) — a free, deterministic variation seed
    // that costs nothing and guarantees consecutive shots never print the same flash.
    this.muzzleFlash(_v, this.shotDir, 0.86 + (this.shotIndex % 4) * 0.09);

    if (this.shotHit) _v2.copy(this.shotHitPoint);
    else _v2.copy(_v).addScaledVector(this.shotDir, VFX.tracerMissDistance);
    this.tracer(_v, _v2, 1);

    // "BLAM!" is the OPENER of a burst, never the middle of one. A word per bullet at 400 rpm
    // is a slot machine; a word on the first shot after a lull is a comic panel.
    const now = ctx.time.unscaledElapsed;
    if (now - this.lastShotAt > VFX.gunWordGap) {
      _v3.copy(_v).addScaledVector(this.shotDir, 1.7);
      _v3.y += 0.28;
      this.emitWord('gun', _v3, 0.9, 0);
    }
    this.lastShotAt = now;
  }

  /** A droplet reached the floor. Print it. */
  private landInk(x: number, y: number, z: number, r: number, g: number, b: number, size: number): void {
    const rng = this.rng;
    const sheet = this.sheet;
    if (!rng || !sheet) return;
    this.cLand.setRGB(r, g, b).lerp(this.cInkDecal, 0.42);
    _v.set(x, y, z);
    const s = Math.max(VFX.decalSizeBlood[0], Math.min(VFX.decalSizeBlood[1], size * 3.4));
    this.decals.emit(_v, UP, rng.range(0, Math.PI * 2), s, this.pick(sheet.splat, rng), this.cLand, rng.next());
  }

  /** The mark a bullet leaves on the world. Dark, small, and printed on the surface. */
  private worldDecal(point: Vector3, normal: Vector3, surface: SurfaceKind): void {
    const rng = this.rng;
    const sheet = this.sheet;
    if (!rng || !sheet) return;
    // Glass does not take a splat — it takes the impact spikes and nothing else.
    if (surface === 'glass') return;
    const s = rng.range(VFX.decalSizeBullet[0], VFX.decalSizeBullet[1]);
    this.decals.emit(point, normal, rng.range(0, Math.PI * 2), s, this.pick(sheet.splat, rng), this.cInkDecal, rng.next());
  }

  /** The big pool a corpse leaves. One decal, and it is the loudest one we print. */
  private deathPool(at: Vector3): void {
    const rng = this.rng;
    const sheet = this.sheet;
    const ctx = this.ctx;
    if (!rng || !sheet || !ctx) return;
    const gy = ctx.world.groundAt(at);
    if (gy === null) return;
    _v.set(at.x, gy, at.z);
    const s = rng.range(VFX.decalSizeDeath[0], VFX.decalSizeDeath[1]);
    this.decals.emit(_v, UP, rng.range(0, Math.PI * 2), s, this.pick(sheet.splat, rng), this.cBloodDecal, rng.next());
  }

  /**
   * THE ANTI-STROBE GATE. Every full-screen flash in the game goes through here.
   *
   * `renderer.flash` combines by max and decays at 6.6/s, so re-triggering it on a repeating
   * beat produces a square wave at the beat's frequency across the WHOLE frame. `VFX.flashGap`
   * puts a hard floor of 220 ms between flashes, which caps that wave at ~4.5 Hz at an
   * amplitude of 8% — and collapses a 25-kill nuke into ONE flash instead of twenty-five.
   * Nothing in this file may call `renderer.flash` or emit `fx:flash` directly.
   */
  private flash(intensity: number, colorHex: number): void {
    const ctx = this.ctx;
    if (!ctx || intensity <= 0) return;
    const now = ctx.time.unscaledElapsed;
    if (now < this.nextFlash) return;
    this.nextFlash = now + VFX.flashGap;
    ctx.events.emit('fx:flash', { intensity, color: colorHex });
  }

  /** Borrow the speed-line channel for a HOT pulse, and hand it straight back. */
  private bigHitLines(): void {
    if (!this.ctx) return;
    this.ctx.renderer.setSpeedLineColor(PALETTE.HOT);
    this.lineTimer = VFX.bigHitLineTime;
  }

  /**
   * Rate-limited onomatopoeia. `chance` of 0 means "always, if the cooldown is up".
   * Allocation-free: the gates are five plain numbers, indexed by a switch, because this runs
   * on every bullet that lands.
   */
  private emitWord(set: WordSetName, at: Vector3, scale: number, chance: number): void {
    const ctx = this.ctx;
    const rng = this.rng;
    if (!ctx || !rng || !this.words) return;
    const now = ctx.time.unscaledElapsed;
    // Two gates, and both must be open. The per-channel cooldown decides how often a KIND of
    // sound is allowed; the global one guarantees an inker only ever letters ONE sound at a
    // time. Without it a crit, a kill and a burst opener land on the same frame and print
    // three words on top of each other — measured, and unreadable.
    if (now < this.nextAnyWord || now < this.wordGate(set)) return;
    if (chance > 0 && rng.next() > chance) return;
    this.nextAnyWord = now + VFX.wordGlobalGap;
    this.setWordGate(set, now + this.wordCooldown(set));
    const tex = this.wordTexture(set, pickWord(set, rng.next()));
    this.words.spawn(at, tex, scale, rng.range(-0.18, 0.18));
  }

  /**
   * The style object is resolved ONCE per set and reused, so a word pop allocates nothing:
   * spreading `WORD_SET_STYLE[set]` at the call site would mint a fresh object per pop, and
   * `makeWordTexture` only reads it.
   */
  private wordTexture(set: WordSetName, text: string): WordTexture {
    let style = this.wordStyles.get(set);
    if (!style) {
      style = { ...WORD_SET_STYLE[set], fontSize: WORD_FONT_SIZE };
      this.wordStyles.set(set, style);
    }
    return makeWordTexture(text, style);
  }

  private wordCooldown(set: WordSetName): number {
    const c = VFX.wordCooldown;
    switch (set) {
      case 'gun': return c.gun;
      case 'crit': return c.crit;
      case 'kill': return c.kill;
      case 'hurt': return c.hurt;
      case 'hitWorld': return c.world;
      default: return c.kill;
    }
  }

  private wordGate(set: WordSetName): number {
    switch (set) {
      case 'gun': return this.nextGunWord;
      case 'crit': return this.nextCritWord;
      case 'kill': return this.nextKillWord;
      case 'hurt': return this.nextHurtWord;
      case 'hitWorld': return this.nextWorldWord;
      default: return this.nextKillWord;
    }
  }

  private setWordGate(set: WordSetName, at: number): void {
    switch (set) {
      case 'gun': this.nextGunWord = at; break;
      case 'crit': this.nextCritWord = at; break;
      case 'kill': this.nextKillWord = at; break;
      case 'hurt': this.nextHurtWord = at; break;
      case 'hitWorld': this.nextWorldWord = at; break;
      default: this.nextKillWord = at; break;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * PER-TARGET BURST RATE LIMIT (ART §5 / §9).
   *
   * `VfxService.impact` takes a point, not an entity — `core/types.ts` is frozen and this
   * system may not reach into the enemy system to ask who was hit — so "the same target" is
   * resolved SPATIALLY: a burst suppresses further bursts inside `BURST_RADIUS` for
   * `VFX.impactBurstCooldown`. A shambler's torso is ~0.6 m across, so one body is one site,
   * and two zombies standing shoulder to shoulder still get one burst each.
   *
   * Fixed-size ring, no allocation, no map, no per-frame sweep — stale entries simply age out
   * of relevance because the time comparison fails.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  private burstAllowed(position: Vector3): boolean {
    const ctx = this.ctx;
    if (!ctx) return true;
    // Unscaled: hitstop must not extend the cooldown, or a kill would eat the next burst.
    const now = ctx.time.unscaledElapsed;
    const cool = VFX.impactBurstCooldown;
    const sites = this.burstSites;
    for (let i = 0; i < BURST_SITES; i++) {
      const b = i * 4;
      if (now - sites[b + 3] > cool) continue;
      const dx = sites[b] - position.x;
      const dy = sites[b + 1] - position.y;
      const dz = sites[b + 2] - position.z;
      if (dx * dx + dy * dy + dz * dz < BURST_RADIUS * BURST_RADIUS) return false;
    }
    const w = this.burstCursor * 4;
    sites[w] = position.x; sites[w + 1] = position.y; sites[w + 2] = position.z;
    sites[w + 3] = now;
    this.burstCursor = (this.burstCursor + 1) % BURST_SITES;
    return true;
  }

  private kindTint(kind: ImpactKind): Color {
    switch (kind) {
      case 'blood': return this.cBlood;
      case 'shock': return this.cElectric;
      case 'flame': return this.cRust;
      case 'explosion': return this.cRust;
      default: return this.cPaper;
    }
  }

  private pick(cells: readonly Cell[], rng: RNG): Cell {
    return cells[Math.min(cells.length - 1, Math.floor(rng.next() * cells.length))];
  }

  /**
   * GRACEFUL DEGRADATION UNDER POOL PRESSURE.
   *
   * Measured: a NUKE (25 zombies dying on one frame) asks for 500 blood cards and 450 shards
   * at once. Without this the pool starved 838 times and *which* effects survived was decided
   * by nothing but the order the events happened to arrive in. With it, every effect in that
   * frame thins out by the same factor, so the beat still reads and the frame stays a comic
   * panel instead of a wall of pink.
   *
   * Full density until the pool is half full, then linear to `VFX.pressureFloor` at the cap.
   */
  private headroomOf(field: InstancedField): number {
    const u = field.live / field.capacity;
    if (u < 0.5) return 1;
    return 1 - (1 - VFX.pressureFloor) * ((u - 0.5) * 2);
  }

  private headroom(): number {
    return this.headroomOf(this.cardField);
  }

  /**
   * A unit vector in the hemisphere around `axis`, biased toward it by `tightness`
   * (0 = full hemisphere, 1 = straight along the axis). Allocation-free.
   */
  private hemisphere(out: Vector3, axis: Vector3, rng: RNG, tightness: number): Vector3 {
    rng.unitSphere(out);
    if (out.dot(axis) < 0) out.negate();
    out.lerp(axis, clamp01(tightness) * 0.85).normalize();
    return out;
  }

  private watch(ctx: GameCtx): void {
    if (!ctx.debug) return;
    ctx.debug.watch('vfx cards', () => `${this.cardField.live}/${this.cardField.capacity}`);
    ctx.debug.watch('vfx shards', () => `${this.shardField.live}/${this.shardField.capacity}`);
    ctx.debug.watch('vfx decals', () => `${this.decalFieldI.live}/${this.decalFieldI.capacity}`);
    ctx.debug.watch('vfx digits', () => `${this.digitField.live}/${this.digitField.capacity}`);
    ctx.debug.watch('vfx words', () => `${this.words.live}/${VFX.pool.words}`);
    ctx.debug.watch('vfx draws', () => this.drawCalls());
    ctx.debug.watch('vfx starved', () =>
      this.cardField.starved + this.shardField.starved + this.tracerField.starved +
      this.flashField.starved + this.digitField.starved + this.words.starved);
  }

  /**
   * Draw calls the VFX layer is costing RIGHT NOW. Instanced families are 1 each (2 for the
   * bloom-layer flash, which is also rendered into the emissive prepass); words are 1 apiece.
   */
  drawCalls(): number {
    let n = 0;
    if (this.cardField.live > 0) n++;
    if (this.tracerField.live > 0) n++;
    if (this.shardField.live > 0) n++;
    if (this.decalFieldI.live > 0) n++;
    if (this.digitField.live > 0) n++;
    if (this.flashField.live > 0) n += 2;
    n += this.words.live;
    return n;
  }

  /** Recycle everything — round reset, game over, teardown. */
  clear(): void {
    this.cardField.releaseAll();
    this.flashField.releaseAll();
    this.tracerField.releaseAll();
    this.shardField.releaseAll();
    this.numbers.clear();
    this.decals.clear();
    this.words.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map an arbitrary colour back onto a palette token, for callers that hand `wordPop` a hex.
 * Exact matches only, falling back to GOLD — the palette is small and closed (ART §1), so a
 * colour that is not in it is a bug at the call site rather than something to approximate.
 */
function tokenFor(hex: number): 'HOT' | 'GOLD' | 'ACID' | 'ELECTRIC' | 'RUST' | 'PAPER' | 'BONE' {
  switch (hex) {
    case PALETTE.HOT: return 'HOT';
    case PALETTE.ACID: return 'ACID';
    case PALETTE.ELECTRIC: return 'ELECTRIC';
    case PALETTE.RUST: return 'RUST';
    case PALETTE.PAPER: return 'PAPER';
    case PALETTE.BONE: return 'BONE';
    default: return 'GOLD';
  }
}

export function createVfx(): VfxSystem {
  return new VfxSystem();
}

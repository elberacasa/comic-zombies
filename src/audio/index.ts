/**
 * THE AUDIO SYSTEM — `AudioService` for real, replacing `StubAudio`.
 *
 * WIRED PURELY BY EVENTS. This file imports `core/*`, `game/tuning` and its own `audio/*`, and
 * NOTHING else. It never sees a weapon, an enemy, a viewmodel or a mesh: it learns that a gun
 * was fired the same way the HUD and the VFX do, off `weapon:fired`. That is not architectural
 * politeness — it is what makes the audio survive M4 adding nine more guns without a line
 * changing here.
 *
 * WHAT THIS SYSTEM ADDS OVER "PLAY A SOUND WHEN X HAPPENS"
 *
 *  1. THE LAYER STACK. A hit is not one sound. The enemy system fires a spatial `zombie_flesh`
 *     where the body is; this system fires a flat `hitmark` inside the player's head. The world
 *     says "something over there was hit", the head says "and you did it". Kills, crits and
 *     dismemberment stack the same way. That doubling is most of why hits feel connected.
 *
 *  2. DEFERRED BEATS. A shell hits the ground 300 ms after the shot; the magazine drops at 24%
 *     of the reload and seats at 62% — the same fractions the viewmodel animates to, read from
 *     `WEAPON.view` rather than copied, so a reload-speed boon moves the sound with the picture.
 *     A fixed-size pending ring schedules these; it never allocates and never grows.
 *
 *  3. DUCKING AS IMPACT. `ctx.time.hitstop()` freezes the world for 2–6 frames on a crit. This
 *     system slams a low-pass across the whole mix for exactly that long. The player does not
 *     hear a filter — they hear the world flinch.
 *
 *  4. AN ADAPTIVE BED. M3 will drive `setIntensity()` from the round director. Until then the
 *     horde drives it directly, off `EnemyService.aliveCount` and the distance to the nearest
 *     body — both public contract, no import. The two are MAXed, never replaced, so a quiet
 *     round still sounds dangerous when twenty zombies are on top of you.
 *
 * ART §4.1 (the stillness rule) is a rule about PIXELS, and nothing here draws. But the same
 * discipline applies in spirit: with the player parked and nothing alive, the only thing audible
 * is the bed at intensity 0 — a floor of wind at 0.045 gain. Nothing ticks, pings or breathes.
 */

import type {
  AudioService, Damageable, GameCtx, SurfaceKind, System, WeaponDef,
} from '@/core/types';
import { WEAPON } from '@/game/tuning';

import { AudioEngine, measureRecipes } from './engine';
import type { EngineStats, RecipeMeasurement } from './engine';
import { MIX, RECIPE_IDS, hasRecipe } from './recipes';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Lookups — built once so the hot path never concatenates a string.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const IMPACT_OF: Record<SurfaceKind, string> = {
  concrete: 'impact_concrete',
  metal: 'impact_metal',
  wood: 'impact_wood',
  glass: 'impact_glass',
  flesh: 'impact_flesh',
  dirt: 'impact_dirt',
};

const STEP_OF: Record<SurfaceKind, string> = {
  concrete: 'step_concrete',
  metal: 'step_metal',
  wood: 'step_wood',
  glass: 'step_glass',
  flesh: 'step_flesh',
  dirt: 'step_dirt',
};

/** Surfaces a bullet can whine off. */
const RICOCHET_CHANCE: Record<SurfaceKind, number> = {
  concrete: 0.22, metal: 0.45, wood: 0.05, glass: 0.08, flesh: 0, dirt: 0.02,
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Deferred one-shots
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Pending {
  live: boolean;
  id: string;
  at: number;
  spatial: boolean;
  x: number; y: number; z: number;
  volume: number;
  pitch: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

export class AudioSystem implements System, AudioService {
  readonly name = 'audio';

  private readonly engine = new AudioEngine();
  private ctx: GameCtx | null = null;
  private readonly offs: (() => void)[] = [];

  /** Fixed pool of deferred beats. Never grows, never allocates after construction. */
  private readonly pending: Pending[] = [];
  private clock = 0;

  // ── mix state ──
  private externalDuck = 0;
  private externalIntensity = 0;
  private downed = false;
  private paused = false;

  // ── hitstop detection (see `hitstopAmount`) ──
  private fallbackHitstop = 0;

  // ── horde sampling ──
  private hordeTimer = 0;
  private autoIntensity = 0;
  private autoMenace = 0;

  // ── the combo ladder (see `MIX.killLadder`) ──
  /**
   * The chain length the NEXT kill will produce. `enemy:killed` is emitted by the enemy system
   * and `combo:changed` by the director that listens to it, so at the instant a kill sound has
   * to be pitched the meter still holds the previous value — the kill about to be counted is
   * this one. Tracking the count locally and adding one is exact, and `combo:changed` corrects
   * it a microsecond later whatever happens.
   */
  private combo = 0;
  private multiplier = 1;

  // ── weapon bookkeeping ──
  private gunDefId = '';
  private gunRecipe = 'gun_pistol';
  private reloadStartedAt = -1;
  private reloadDuration = 0;
  private lastAmmo = -1;

  private readonly statsOut: EngineStats = {
    running: false, spatialVoices: 0, flatVoices: 0, spatialLive: 0, flatLive: 0,
    stolen: 0, dropped: 0, played: 0, intensity: 0, menace: 0, duck: 0,
  };

  constructor() {
    for (let i = 0; i < MIX.pendingCapacity; i++) {
      this.pending.push({ live: false, id: '', at: 0, spatial: false, x: 0, y: 0, z: 0, volume: 1, pitch: 1 });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AudioService
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  play(id: string, opts?: { position?: import('three').Vector3; volume?: number; pitch?: number }): void {
    const p = opts?.position;
    // Payload vectors are shared scratch everywhere in this codebase — read now, never retain.
    if (p) this.engine.play(id, true, p.x, p.y, p.z, opts?.volume ?? 1, opts?.pitch ?? 1);
    else this.engine.play(id, false, 0, 0, 0, opts?.volume ?? 1, opts?.pitch ?? 1);
  }

  setIntensity(v: number): void {
    this.externalIntensity = Math.max(0, Math.min(1, v));
  }

  setDucking(v: number): void {
    this.externalDuck = Math.max(0, Math.min(1, v));
  }

  get masterVolume(): number { return this.engine.masterVolume; }
  set masterVolume(v: number) { this.engine.masterVolume = v; }

  /**
   * THE AUTOPLAY GATE. `main.ts` calls this from the boot overlay's click — a real user gesture,
   * and the only place it is ever called. Nothing before this point has created an AudioContext.
   */
  async resume(): Promise<void> {
    await this.engine.start();
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // System
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  init(ctx: GameCtx): void {
    this.ctx = ctx;
    const on = ctx.events.on.bind(ctx.events);
    const off = this.offs;

    // ── the generic channel. Anyone may request a sound; the enemy system uses this for every
    //    groan, wind-up, swing, flesh hit, crit and death. ──────────────────────────────────
    off.push(on('fx:sound', (p) => {
      if (p.position) this.engine.play(p.id, true, p.position.x, p.position.y, p.position.z, p.volume ?? 1, p.pitch ?? 1);
      else this.engine.play(p.id, false, 0, 0, 0, p.volume ?? 1, p.pitch ?? 1);
    }));

    // ── weapons ────────────────────────────────────────────────────────────────────────────
    off.push(on('weapon:fired', (p) => {
      const id = this.resolveGun(p.weapon.def);
      this.engine.play(id, false, 0, 0, 0, 1, 1);
      // SIDECHAIN. The horde bed drops 62% under the shot and climbs back over half a second.
      // Sustained fire therefore holds it down — and the instant you stop shooting, the street
      // comes back up around you. That breathing is most of why a mix sounds expensive.
      this.engine.duckBed(MIX.shotBedDuck);
      // The brass lands a beat later. Deferred, not scheduled inside the recipe, because it is a
      // separate event in the world and wants its own stereo position and its own variation.
      this.defer('shell_drop', MIX.shellDelay, false, 0, 0, 0, 1, 1);
    }));

    off.push(on('weapon:dryFire', () => this.engine.play('dry_fire', false, 0, 0, 0, 1, 1)));

    off.push(on('weapon:reloadStart', (p) => {
      this.reloadStartedAt = this.clock;
      this.reloadDuration = p.duration;
      this.defer('reload_magout', p.duration * WEAPON.view.reloadMagOutT, false, 0, 0, 0, 1, 1);
      this.defer('reload_magin', p.duration * WEAPON.view.reloadMagInT, false, 0, 0, 0, 1, 1);
    }));

    off.push(on('weapon:activeReloadWindow', (p) => {
      // Near-subliminal by design: the bar is the skill, this is the safety net. MIX knob → 0
      // removes it entirely.
      if (p.open && MIX.activeReloadCueVolume > 0) {
        this.engine.play('ar_cue', false, 0, 0, 0, MIX.activeReloadCueVolume, 1);
      }
    }));

    off.push(on('weapon:reloadEnd', (p) => {
      const took = this.reloadStartedAt >= 0 ? this.clock - this.reloadStartedAt : 0;
      const planned = this.reloadDuration;
      this.reloadStartedAt = -1;
      this.cancelPending('reload_magout');
      this.cancelPending('reload_magin');
      if (p.active) { this.engine.play('reload_perfect', false, 0, 0, 0, 1, 1); return; }
      // No event distinguishes "missed the window" from "reloaded normally" — but a miss costs
      // `activeReloadMissPenalty` extra seconds, so the elapsed time IS the signal. A cancelled
      // reload finishes early and gets no sound at all, which is correct: nothing happened.
      if (took < planned * 0.9) return;
      this.engine.play('reload_done', false, 0, 0, 0, 1, 1);
      if (took > planned + WEAPON.activeReloadMissPenalty * 0.5) {
        this.engine.play('reload_stumble', false, 0, 0, 0, 0.8, 1);
      }
    }));

    off.push(on('weapon:ammoChanged', (p) => {
      if (p.ammo === MIX.lowAmmoAt && this.lastAmmo > MIX.lowAmmoAt) {
        this.engine.play('ammo_low', false, 0, 0, 0, 1, 1);
      }
      this.lastAmmo = p.ammo;
    }));

    off.push(on('weapon:equipped', () => this.engine.play('weapon_equip', false, 0, 0, 0, 1, 1)));
    off.push(on('weapon:upgraded', () => this.engine.play('upgrade_chime', false, 0, 0, 0, 1, 1)));

    // ── combat ─────────────────────────────────────────────────────────────────────────────
    off.push(on('hit:world', (p) => {
      const id = IMPACT_OF[p.surface] ?? IMPACT_OF.concrete;
      this.engine.play(id, true, p.point.x, p.point.y, p.point.z, 1, 1);
      if (this.rand() < (RICOCHET_CHANCE[p.surface] ?? 0)) {
        this.engine.play('ricochet', true, p.point.x, p.point.y, p.point.z, 0.7, 0.85 + this.rand() * 0.4);
      }
    }));

    off.push(on('hit:enemy', (p) => {
      // The spatial flesh/crit sound is the enemy system's job (it knows which body was hit and
      // what voice it has). This is the player-local confirmation stacked on top.
      const crit = p.info.isCrit || p.info.part === 'head';
      const v = 0.55 + 0.45 * Math.min(1, p.info.amount / MIX.hitmarkFullDamage);
      this.engine.play(crit ? 'hitmark_crit' : 'hitmark', false, 0, 0, 0, v, 1);
    }));

    // ═════════════════════════════════════════════════════════════════════════════════════════
    // THE SLOT MACHINE. This is the loop the whole system exists to serve.
    //
    // Every kill plays the confirm one scale degree higher than the last, so an unbroken chain
    // is a rising major scale that resolves on the eighth kill. A crit kill swaps in `kill_crit`
    // — the only upward-bending sound in the game — a degree higher still. A broken chain drops
    // straight back to the tonic, and the ear hears the loss without a single pixel of UI.
    // ═════════════════════════════════════════════════════════════════════════════════════════
    off.push(on('enemy:killed', (p) => {
      const chain = this.combo + 1;
      const step = chain - 1 + (p.byCrit ? MIX.killCritLadderBonus : 0);
      const ladder = MIX.killLadder;
      const pitch = ladder[step < 0 ? 0 : step >= ladder.length ? ladder.length - 1 : step];
      this.engine.play(p.byCrit ? 'kill_crit' : 'kill_confirm', false, 0, 0, 0, 1, pitch);
      // A kill is a beat: shove the horde back so the reward has the mix to itself.
      this.engine.duckBed(MIX.beatBedDuck);
    }));

    off.push(on('enemy:dismembered', (p) => {
      this.engine.play('dismember', true, p.position.x, p.position.y, p.position.z, 1, 1);
    }));

    off.push(on('enemy:spawned', (p) => {
      this.engine.play('zombie_spawn', true, p.position.x, p.position.y, p.position.z, 0.8, 1);
    }));

    // ── the player ─────────────────────────────────────────────────────────────────────────
    off.push(on('player:footstep', (p) => {
      const id = STEP_OF[p.surface] ?? STEP_OF.concrete;
      if (p.sprinting) {
        this.engine.play(id, false, 0, 0, 0, MIX.sprintStepVolume, MIX.sprintStepPitch);
        // Sprinting is not "the same step, louder" — the timbre changes too.
        this.engine.play('step_scuff', false, 0, 0, 0, MIX.sprintScuffVolume, 1);
      } else {
        this.engine.play(id, false, 0, 0, 0, 1, 1);
      }
    }));

    off.push(on('player:landed', (p) => {
      const hard = p.impactSpeed >= MIX.landHardSpeed;
      const t = Math.min(1, p.impactSpeed / (MIX.landHardSpeed * 1.6));
      this.engine.play(hard ? 'land_hard' : 'land_soft', false, 0, 0, 0, 0.45 + 0.55 * t, 1);
    }));

    off.push(on('player:movestate', (p) => {
      if (p.to === 'slide') this.engine.play('slide_start', false, 0, 0, 0, 1, 1);
      else if (p.to === 'dive') this.engine.play('dive_whoosh', false, 0, 0, 0, 1, 1);
      else if (p.to === 'air' && p.from !== 'slide' && p.from !== 'dive') {
        this.engine.play('jump', false, 0, 0, 0, 1, 1);
      }
    }));

    off.push(on('player:damaged', () => this.engine.play('player_hurt', false, 0, 0, 0, 1, 1)));
    off.push(on('player:healed', () => this.engine.play('heal_pulse', false, 0, 0, 0, 1, 1)));
    off.push(on('player:down', () => { this.downed = true; this.engine.play('player_down', false, 0, 0, 0, 1, 1); }));
    off.push(on('player:revived', () => { this.downed = false; this.engine.play('revive', false, 0, 0, 0, 1, 1); }));
    off.push(on('player:died', () => { this.downed = true; this.engine.play('death_sting', false, 0, 0, 0, 1, 1); }));
    off.push(on('player:spawned', () => { this.downed = false; this.lastAmmo = -1; }));

    // ── rounds, economy, UI (M3 owns the systems; the sounds are ready for them) ────────────
    off.push(on('game:started', () => {
      this.combo = 0; this.multiplier = 1;
      this.engine.play('game_start', false, 0, 0, 0, 1, 1);
      this.engine.duckBed(MIX.beatBedDuck);
    }));
    off.push(on('game:over', () => {
      this.combo = 0; this.multiplier = 1;
      this.engine.play('game_over', false, 0, 0, 0, 1, 1);
    }));
    off.push(on('round:start', () => {
      this.engine.play('round_start', false, 0, 0, 0, 1, 1);
      this.engine.duckBed(MIX.beatBedDuck);
    }));
    off.push(on('round:cleared', () => this.engine.play('round_clear', false, 0, 0, 0, 1, 1)));
    off.push(on('round:intermission', () => this.engine.play('round_break', false, 0, 0, 0, 1, 1)));

    off.push(on('combo:changed', (p) => {
      const wasMult = this.multiplier;
      const wasCombo = this.combo;
      this.combo = p.combo;
      this.multiplier = p.multiplier;
      if (p.multiplier > wasMult) {
        // A TIER. Its own sound, its own shape, one fifth per step — never mistakable for a kill.
        const tier = MIX.comboUpPitch;
        const i = p.multiplier - 1;
        this.engine.play('combo_up', false, 0, 0, 0, 1,
          tier[i < 0 ? 0 : i >= tier.length ? tier.length - 1 : i]);
        this.engine.duckBed(MIX.beatBedDuck);
      } else if (p.combo === 0 && wasCombo >= MIX.comboBreakMin) {
        this.engine.play('combo_break', false, 0, 0, 0, 1, 1);
      }
    }));

    off.push(on('boon:offer', (p) => {
      this.engine.play('boon_reveal', false, 0, 0, 0, 1, 1);
      this.engine.duckBed(MIX.beatBedDuck);
      for (let i = 0; i < p.choices.length; i++) this.defer('card_deal', 0.09 * i, false, 0, 0, 0, 1, 1);
    }));
    off.push(on('boon:chosen', () => this.engine.play('card_take', false, 0, 0, 0, 1, 1)));
    off.push(on('powerup:dropped', (p) => {
      this.engine.play('powerup_drop', true, p.position.x, p.position.y, p.position.z, 1, 1);
    }));
    off.push(on('powerup:collected', () => {
      this.engine.play('powerup_take', false, 0, 0, 0, 1, 1);
      this.engine.duckBed(MIX.beatBedDuck);
    }));

    // ── the shell ──────────────────────────────────────────────────────────────────────────
    off.push(on('game:paused', (p) => { this.paused = p.paused; }));

    ctx.debug.watch('audio', () => {
      const s = this.engine.stats(this.statsOut);
      return `${s.running ? 'on' : 'off'} ${s.spatialLive}/${s.spatialVoices}+${s.flatLive}/${s.flatVoices}`
        + ` int ${s.intensity.toFixed(2)} men ${s.menace.toFixed(2)}`
        + ` duck ${s.duck.toFixed(2)} x${this.multiplier} steal ${s.stolen} drop ${s.dropped}`;
    });
  }

  /**
   * Presentation only — audio has no simulation, so there is no `fixedUpdate`. `dt` here is the
   * REAL frame delta: the mix must keep breathing during hitstop, and it must keep ducking while
   * the game is paused.
   */
  update(dt: number, ctx: GameCtx): void {
    this.clock += dt;
    this.flushPending();

    // ── listener. `player.eye` is the authoritative ear position per `PlayerService`. ───────
    const eye = ctx.player.eye;
    const look = ctx.player.lookDir;
    // Camera up, straight off the quaternion — no Vector3, no matrix update, no allocation.
    const q = ctx.camera.quaternion;
    const ux = 2 * (q.x * q.y - q.w * q.z);
    const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
    const uz = 2 * (q.y * q.z + q.w * q.x);

    // ── ducking ────────────────────────────────────────────────────────────────────────────
    const hs = this.hitstopAmount(ctx);
    let duck = this.externalDuck;
    const fromHitstop = hs * MIX.hitstopDuck;
    if (fromHitstop > duck) duck = fromHitstop;
    if (this.downed && MIX.downDuck > duck) duck = MIX.downDuck;
    if (this.paused && MIX.pauseDuck > duck) duck = MIX.pauseDuck;

    // ── intensity ──────────────────────────────────────────────────────────────────────────
    this.sampleHorde(dt, ctx);
    this.engine.setIntensity(Math.max(this.externalIntensity, this.autoIntensity));
    this.engine.setMenace(this.autoMenace);

    this.engine.update(dt, eye.x, eye.y, eye.z, look.x, look.y, look.z, ux, uy, uz, duck);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // MEASUREMENT — reachable from the console as `CZ.audio.*`.
  //
  // A recipe that is silently broken is worse than one that is merely dull, because nothing in
  // the game will ever tell you. These two methods are how that is caught: `measure()` renders
  // every recipe offline and reports its shape, `probe()` fires one through the REAL graph and
  // watches the master bus with an `AnalyserNode` — which additionally proves the live chain
  // (drive → panner → duck → limiter → master) is passing signal, not just the synth.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /** Offline-render every recipe (or the ones named) and measure peak / RMS / envelope. */
  measure(ids?: readonly string[]): Promise<RecipeMeasurement[]> {
    return measureRecipes(ids);
  }

  /** Every recipe id the game can request. */
  get recipeIds(): readonly string[] { return RECIPE_IDS; }

  /** Live mix counters — voice occupancy, steals, drops. Reused object, never allocates. */
  stats(): EngineStats { return this.engine.stats(this.statsOut); }

  /** The master-bus `AnalyserNode`, for spectral measurement. Created on first call. */
  analyser(): AnalyserNode | null { return this.engine.tapAnalyser(); }

  /**
   * Fire `id` through the live graph and watch the master bus for `windowMs`. Resolves with the
   * peak and RMS the hardware would have received. Requires `resume()` to have run.
   */
  async probe(id: string, windowMs = 700, volume = 1, pitch = 1): Promise<{
    id: string; peak: number; rms: number; frames: number;
  }> {
    const an = this.engine.tapAnalyser();
    if (!an) return { id, peak: 0, rms: 0, frames: 0 };
    const buf = new Float32Array(an.fftSize);
    let peak = 0, sum = 0, n = 0, frames = 0;
    this.engine.play(id, false, 0, 0, 0, volume, pitch);
    const until = performance.now() + windowMs;
    while (performance.now() < until) {
      an.getFloatTimeDomainData(buf);
      frames++;
      for (let i = 0; i < buf.length; i++) {
        const a = buf[i] < 0 ? -buf[i] : buf[i];
        if (a > peak) peak = a;
        sum += buf[i] * buf[i];
        n++;
      }
      await new Promise<void>((r) => { setTimeout(r, 8); });
    }
    return { id, peak: +peak.toFixed(4), rms: +(n > 0 ? Math.sqrt(sum / n) : 0).toFixed(5), frames };
  }

  dispose(): void {
    for (const f of this.offs) f();
    this.offs.length = 0;
    this.engine.dispose();
    this.ctx = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Internals
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /** Audio's own variance stream — never `ctx.rng`, which must stay reproducible for gameplay. */
  private randState = MIX.varianceSeed >>> 0;
  private rand(): number {
    this.randState = (this.randState + 0x6d2b79f5) >>> 0;
    let t = this.randState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * HOW COMPRESSED IS TIME RIGHT NOW, 0..1.
   *
   * `Time` deliberately does not publish "hitstop amount" — but it publishes both clocks, and
   * inside `update()` `dt` is the SCALED frame delta while `frameDt` is the real one. Their
   * ratio is the effective time scale the world just experienced, whatever produced it: hitstop,
   * slow-mo, or a pause. One divide, entirely inside the frozen `Time` contract, and no
   * structural probe into an implementation this system is not allowed to know about.
   *
   * Deriving it rather than asking for it is also more correct: the mix should flinch for ANY
   * time compression, not only for the one called hitstop.
   */
  private hitstopAmount(ctx: GameCtx): number {
    // A PAUSE ALSO STOPS THE CLOCK, and it is not a flinch. Measured: with the game paused,
    // `dt` is 0 and `frameDt` is not, so the ratio reads as a permanent 100% freeze and pins
    // the whole mix behind a 1.5 kHz filter forever. We are told about pauses explicitly, so
    // the ambiguity is resolvable exactly — and `MIX.pauseDuck` already owns that case.
    if (this.paused) { this.fallbackHitstop = 0; return 0; }
    const real = ctx.time.frameDt;
    if (real <= 1e-6) return this.fallbackHitstop;
    const scale = ctx.time.dt / real;
    const compressed = scale >= 1 ? 0 : scale <= 0 ? 1 : 1 - scale;
    // Attack instantly, release over ~8 units/s, so a 3-frame freeze still leaves an audible
    // tail instead of a one-frame filter blip nobody can hear.
    this.fallbackHitstop = compressed > this.fallbackHitstop
      ? compressed
      : Math.max(compressed, this.fallbackHitstop - real * MIX.hitstopReleaseRate);
    return this.fallbackHitstop;
  }

  /**
   * M2 has no round director, so the bed reads the horde directly through the `EnemyService`
   * contract: how many are alive, and how close the nearest one is. Sampled 4×/s, not per frame.
   */
  private sampleHorde(dt: number, ctx: GameCtx): void {
    if (!MIX.autoIntensity) { this.autoIntensity = 0; this.autoMenace = 0; return; }
    this.hordeTimer -= dt;
    if (this.hordeTimer > 0) return;
    this.hordeTimer = MIX.hordeSampleInterval;

    const enemies = ctx.enemies;
    const alive = enemies.aliveCount;
    if (alive <= 0) { this.autoIntensity = 0; this.autoMenace = 0; return; }

    const eye = ctx.player.eye;
    let nearestSq = Infinity;
    const all: readonly Damageable[] = enemies.all;
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (!e.alive) continue;
      const p = e.position;
      const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < nearestSq) nearestSq = d2;
    }
    const near = Math.sqrt(nearestSq === Infinity ? MIX.proximityFar * MIX.proximityFar : nearestSq);

    const count = Math.min(1, alive / MIX.hordeFull);
    const prox = 1 - Math.min(1, Math.max(0, (near - MIX.proximityNear))
      / Math.max(1e-3, MIX.proximityFar - MIX.proximityNear));
    this.autoIntensity = Math.min(1, count * MIX.hordeCountWeight + prox * MIX.hordeProximityWeight);
    // DENSITY AND MENACE ARE DIFFERENT FACTS. Twenty zombies across the block is a loud round;
    // one zombie at your shoulder is an emergency. Folding them into a single number loses the
    // second one entirely, which is exactly the case the player most needs to hear.
    let m = prox;
    if (alive >= MIX.menaceCrowdCount) {
      const crowd = Math.min(1, (alive - MIX.menaceCrowdCount) / MIX.menaceCrowdFull);
      m = Math.min(1, m + crowd * MIX.menaceCrowdWeight);
    }
    this.autoMenace = m;
  }

  private resolveGun(def: WeaponDef): string {
    if (def.id === this.gunDefId) return this.gunRecipe;
    this.gunDefId = def.id;
    // The only string concatenation in the whole system, and it happens once per weapon swap.
    const byId = `gun_${def.id}`;
    const byArchetype = `gun_${def.archetype}`;
    this.gunRecipe = hasRecipe(byId) ? byId : hasRecipe(byArchetype) ? byArchetype : 'gun_pistol';
    return this.gunRecipe;
  }

  // ── the pending ring ────────────────────────────────────────────────────────────────────────

  private defer(
    id: string, delay: number, spatial: boolean,
    x: number, y: number, z: number, volume: number, pitch: number,
  ): void {
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.live) continue;
      p.live = true;
      p.id = id;
      p.at = this.clock + delay;
      p.spatial = spatial;
      p.x = x; p.y = y; p.z = z;
      p.volume = volume;
      p.pitch = pitch;
      return;
    }
    // Full ring: drop it. A deferred beat is never load-bearing, and growing the pool mid-fight
    // to service a shell casing would be the wrong trade.
  }

  private cancelPending(id: string): void {
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.live && p.id === id) p.live = false;
    }
  }

  private flushPending(): void {
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (!p.live || this.clock < p.at) continue;
      p.live = false;
      this.engine.play(p.id, p.spatial, p.x, p.y, p.z, p.volume, p.pitch);
    }
  }
}

/**
 * Build the audio system. Registered in `main.ts` in the ARCHITECTURE §3 slot (after vfx), and
 * placed in `GameCtx` in place of `stubs.audio`.
 */
export function createAudio(): AudioSystem {
  return new AudioSystem();
}

export { MIX, RECIPE_IDS } from './recipes';
export type { Recipe, LayerSpec, NoiseId, VoiceVariant } from './synth';
export { renderRecipeOffline, measureRecipes } from './engine';
export type { RecipeMeasurement } from './engine';

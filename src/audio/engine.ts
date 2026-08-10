/**
 * AUDIO ENGINE — the WebAudio graph, the voice pool, spatialization, ducking and the horde bed.
 *
 * THE GRAPH (built once, on the user gesture)
 *
 *     voice slot ×N ─▶ air ─▶ panner ─┬─▶ dryTap ──▶ dry ──────┐
 *                                     └─▶ crowdTap ▶ crowdDuck ┤
 *     slot.send ───────▶ reverbBus ─────▶ convolver ───────────┤     ← the synthesized room
 *                                                              │
 *                                                              ├─▶ duckFilter ─▶ duckGain
 *     ambient bed ─▶ ambientBus ─▶ bedDuckGain ────────────────┘        └─▶ highpass
 *                                                                          └─▶ limiter
 *                                                                              └─▶ master ─▶ 🔊
 *
 * THREE DUCKS, NOT ONE. `duckFilter`/`duckGain` sit across EVERYTHING and are the world flinching
 * (hitstop, downed, paused). `bedDuckGain` sits across the bed ALONE and is the mix breathing:
 * every shot pushes the horde back for a quarter of a second and lets it climb again. Ducking
 * the whole bus on a gunshot would only make the gunshot duck itself.
 *
 * `crowdDuckGain` (BUILD 006) is the half of that idea the first pass missed. The bed is not the
 * only thing in the gun's way — the horde is 25 SPATIAL VOICES on the SFX path, and none of them
 * were duckable. Measured: an empty street gave a shot +4.8 dB over the mix with its centroid at
 * 4500 Hz; with 25 shamblers around you the same shot gave +2.0 dB and 1041 Hz. The gun stopped
 * cutting through at the exact moment you need to know you hit something. So every recipe marked
 * `crowd` (the sounds the horde MAKES — never the sounds you make TO it) leaves the panner
 * through `crowdTap` instead of `dryTap`, and the shot sidechain pulls that bus down with the bed
 * at `MIX.crowdDuckDepth`.
 *
 * WHY A SLOT POOL. Web Audio source nodes (`OscillatorNode`, `AudioBufferSourceNode`) are ONE-SHOT
 * by specification — once stopped they can never be restarted, so they cannot be pooled and any
 * claim otherwise is a bug waiting to happen. Everything *downstream* of a source can be pooled,
 * and here it is: each slot owns 4 filters, 4 envelope gains, the drive stage, its panner and its
 * reverb send — 14 nodes, built once, reused forever. The per-one-shot allocation is therefore
 * exactly "the source nodes", which is the floor the API allows. The noise itself is pre-baked
 * into `AudioBuffer`s at start-up and every instance plays a random slice of one.
 *
 * WHY TWO POOLS. A spatial slot ends in an HRTF `PannerNode` (that is how you hear a zombie
 * *behind* you — a gameplay cue, not polish). A flat slot ends in a `StereoPannerNode` and is for
 * everything that happens inside the player's own head: their gun, their feet, hitmarkers, UI.
 * Putting a first-person gunshot through an HRTF panner 0.4 m from the listener only colours it.
 *
 * VOICE STEALING. When a pool is full the lowest-priority, then oldest, voice is stolen — but
 * never one whose priority is HIGHER than the incoming sound. A 5 ms fade covers the seam so a
 * steal is inaudible instead of a click.
 *
 * AUTOPLAY POLICY. No `AudioContext` exists until `start()` is called, and `start()` is only ever
 * reached from `resume()`, which `main.ts` calls from the boot overlay's click. Constructing this
 * class is free and silent; `play()` before the gesture is a no-op, not an error.
 */

import type {
  CurveTable, NoiseBank, RandomFn, Recipe, VoiceSlot, VoiceVariant,
} from './synth';
import {
  SYNTH, makeDriveCurve, makeImpulseResponse, makeNoiseBank, makeRandom, renderVoice,
} from './synth';
import { MIX, RECIPES, getRecipe } from './recipes';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A pooled voice
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Shared `onended` handler. One module-level function, so deferring a detach allocates nothing.
 * A source that has already finished has been released by the implementation anyway, so a
 * handler that never fires costs nothing either.
 */
function onSourceEnded(this: AudioScheduledSourceNode): void {
  try { this.disconnect(); } catch { /* already gone */ }
}

class Slot implements VoiceSlot {
  readonly filters: BiquadFilterNode[] = [];
  readonly gains: GainNode[] = [];
  /** Per-layer stereo placement. Flat slots only — an HRTF panner downmixes its input. */
  readonly pans: StereoPannerNode[] | null;
  readonly driveIn: GainNode;
  readonly shaper: WaveShaperNode;
  readonly driveOut: GainNode;
  readonly out: GainNode;
  readonly send: GainNode;
  /**
   * AIR ABSORPTION. Spatial slots only. Distance does not just make a sound quieter — it eats
   * the top end, and that is the cue the ear actually uses to judge how far away something is.
   * Volume alone gives you "a quiet zombie"; volume plus this gives you "a zombie down the
   * street", which is the difference between a mix and a place.
   */
  readonly air: BiquadFilterNode | null;
  /** Exactly one of these is non-null, decided at construction. */
  readonly panner: PannerNode | null;
  readonly stereo: StereoPannerNode | null;
  /** Spatial only: the dry / crowd output taps. Exactly one is open per voice. */
  readonly dryTap: GainNode | null;
  readonly crowdTap: GainNode | null;
  readonly sources: AudioScheduledSourceNode[] = [];

  active = false;
  endTime = 0;
  startedAt = 0;
  priority = 0;
  recipeId = '';
  /** True while this slot is playing a `crowd` recipe. Counted per frame by `update()`. */
  crowd = false;

  constructor(
    ac: BaseAudioContext, spatial: boolean, curve: CurveTable,
    dry: AudioNode, crowd: AudioNode | null, send: AudioNode,
  ) {
    this.pans = spatial ? null : [];
    for (let i = 0; i < SYNTH.maxLayers; i++) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = SYNTH.bypassCutoff;
      const g = ac.createGain();
      g.gain.value = 0;
      f.connect(g);
      this.filters.push(f);
      this.gains.push(g);
      if (this.pans) {
        const p = ac.createStereoPanner();
        p.pan.value = 0;
        this.pans.push(p);
      }
    }

    this.driveIn = ac.createGain();
    this.driveIn.gain.value = 1;
    this.shaper = ac.createWaveShaper();
    this.shaper.curve = curve;
    this.shaper.oversample = '2x';
    this.driveOut = ac.createGain();
    this.driveOut.gain.value = 0;
    this.out = ac.createGain();
    this.out.gain.value = 1;
    this.send = ac.createGain();
    this.send.gain.value = 0;

    if (this.pans) {
      for (let i = 0; i < this.gains.length; i++) {
        this.gains[i].connect(this.pans[i]);
        this.pans[i].connect(this.driveIn);
      }
    } else {
      for (const g of this.gains) g.connect(this.driveIn);
    }
    this.driveIn.connect(this.shaper);
    this.shaper.connect(this.driveOut);
    this.driveOut.connect(this.out);

    if (spatial) {
      const air = ac.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = SYNTH.bypassCutoff;
      air.Q.value = 0.5;
      this.air = air;
      const p = ac.createPanner();
      p.panningModel = MIX.panningModel;
      p.distanceModel = MIX.distanceModel;
      p.refDistance = MIX.refDistance;
      p.maxDistance = MIX.maxDistance;
      p.rolloffFactor = MIX.rolloff;
      this.out.connect(air);
      air.connect(p);
      // THE TWO TAPS. See `Recipe.crowd`. Both are permanent connections; `play` opens one of
      // them at the voice's start time, so nothing is ever re-patched under a live envelope.
      const dt = ac.createGain();
      dt.gain.value = 1;
      const ct = ac.createGain();
      ct.gain.value = 0;
      p.connect(dt);
      dt.connect(dry);
      p.connect(ct);
      ct.connect(crowd ?? dry);
      this.dryTap = dt;
      this.crowdTap = ct;
      this.panner = p;
      this.stereo = null;
    } else {
      this.air = null;
      const s = ac.createStereoPanner();
      this.out.connect(s);
      s.connect(dry);
      this.stereo = s;
      this.panner = null;
      this.dryTap = null;
      this.crowdTap = null;
    }

    // THE ROOM HEARS WHAT THE AIR DELIVERS. Taking the reverb send from BEFORE the air filter
    // was measurably wrong: distance also raises the wet/dry ratio, so a far-off sound came
    // back brighter than a near one — 62% of a 50 m impact's energy above 4 kHz versus 62% at
    // 25 m, when it should have kept falling. Feeding the send from the air filter's output
    // makes the tail obey the same absorption as the direct path, which is what actually
    // happens in a street.
    (this.air ?? this.out).connect(this.send);
    this.send.connect(send);
  }

  /**
   * Stop and detach the current voice's one-shot sources.
   *
   * THE DETACH IS DEFERRED, and that is the whole point. `stop(when)` is scheduled, but
   * `disconnect()` takes effect the instant it is called — so detaching here immediately pulled
   * the sources out of the graph at `now` and the 5 ms steal crossfade had nothing left to fade.
   * A steal became a hard cut, which is exactly the click `synth.ts::resetAt` is written to
   * avoid, and it fired 163 times in a 12 s stress window. `onended` fires after the scheduled
   * stop, costs no polling, and is the allocation-free way to say "detach once you are done".
   * `immediate` is for `dispose()`, where nothing is meant to survive the call.
   */
  free(when: number, immediate = false): void {
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      try { s.stop(when); } catch { /* already stopped — the spec throws, we don't care */ }
      if (immediate) {
        try { s.disconnect(); } catch { /* already gone */ }
      } else {
        s.onended = onSourceEnded;
      }
    }
    this.sources.length = 0;
    this.active = false;
    this.recipeId = '';
  }

  dispose(): void {
    this.free(0, true);
    this.dryTap?.disconnect();
    this.crowdTap?.disconnect();
    for (const f of this.filters) f.disconnect();
    for (const g of this.gains) g.disconnect();
    if (this.pans) for (const p of this.pans) p.disconnect();
    this.air?.disconnect();
    this.driveIn.disconnect();
    this.shaper.disconnect();
    this.driveOut.disconnect();
    this.out.disconnect();
    this.send.disconnect();
    this.panner?.disconnect();
    this.stereo?.disconnect();
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The engine
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface EngineStats {
  running: boolean;
  spatialVoices: number;
  flatVoices: number;
  spatialLive: number;
  flatLive: number;
  stolen: number;
  dropped: number;
  played: number;
  intensity: number;
  menace: number;
  duck: number;
}

function contextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class AudioEngine {
  private ac: AudioContext | null = null;
  private starting: Promise<void> | null = null;

  // ── the master chain ──
  private master!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private highpass!: BiquadFilterNode;
  private duckGain!: GainNode;
  private duckFilter!: BiquadFilterNode;
  private dry!: GainNode;
  private reverbBus!: GainNode;
  private reverbReturn!: GainNode;

  // ── the ambient bed ──
  private ambientBus!: GainNode;
  /** Sidechain trim on the bed alone, so gunfire pushes the horde back without ducking itself. */
  private bedDuckGain!: GainNode;
  /**
   * THE CROWD BUS — the other half of the sidechain, added in BUILD 006. The ambient bed is not
   * the only thing standing in the gun's way: the horde is 25 spatial voices on the SFX path,
   * and ducking the bed alone left the shot +2.0 dB over a full street instead of +4.8 dB. Every
   * `crowd` recipe lands here, and `duckBed` pulls it down with the bed.
   */
  private crowdDuckGain!: GainNode;
  /**
   * CROWD NORMALISATION — the thing that actually lets the gun through, and it is not a duck.
   *
   * MEASURED on the master bus with 25 shamblers on the player: the LIMITER was already pulling
   * 8.7 dB before a shot was fired, and a shot lifted the mix by 0.2 dB. Muting the crowd bus
   * alone took the limiter to 1.6 dB. So the horde's own voices were eating the entire headroom,
   * and no sidechain can rescue a bus that is nine decibels into a limiter continuously — the
   * duck opens a 200 ms window in something that has already been flattened.
   *
   * Twenty-five bodies each groaning at the level that is exactly right for ONE body is a sum
   * nobody authored. This node divides the crowd bus by its own live voice count, so a single
   * distant groan is untouched and a wall of them stays a wall instead of becoming a brick.
   */
  private crowdNormGain!: GainNode;
  private crowdNorm = 1;
  private bedNoiseGain!: GainNode;
  private bedNoiseFilter!: BiquadFilterNode;
  private bedRumbleGain!: GainNode;
  private bedVoiceGain!: GainNode;
  private bedSwellGain!: GainNode;
  /** The "they are ON you" layer — driven by proximity, not by count. */
  private bedCloseGain!: GainNode;
  private bedCloseFilter!: BiquadFilterNode;
  private bedSources: AudioScheduledSourceNode[] = [];

  private bank: NoiseBank | null = null;
  private curve: CurveTable | null = null;
  private analyser: AnalyserNode | null = null;

  private readonly spatialSlots: Slot[] = [];
  private readonly flatSlots: Slot[] = [];

  /** Last trigger time and live count, per recipe id. Both Maps are written, never grown per frame. */
  private readonly lastAt = new Map<string, number>();
  private readonly liveOf = new Map<string, number>();
  private readonly missing = new Set<string>();
  /** Which round-robin take each recipe played last. See `Recipe.variants`. */
  private readonly variantOf = new Map<string, number>();

  private rnd: RandomFn = makeRandom(MIX.varianceSeed);

  private _masterVolume: number = MIX.masterVolume;
  private _intensity = 0;
  private _targetIntensity = 0;
  private _menace = 0;
  private _targetMenace = 0;
  private _duck = 0;
  private _appliedDuck = -1;
  private _bedDuck = 0;

  // Listener position, cached from the last `update()`. Distance-aware filtering needs it at
  // `play()` time, which is not the same instant as the frame that positioned the listener.
  private lx = 0; private ly = 0; private lz = 0;

  // counters, for the debug watch panel
  private _stolen = 0;
  private _dropped = 0;
  private _played = 0;

  get running(): boolean { return this.ac !== null && this.ac.state === 'running'; }
  get sampleRate(): number { return this.ac?.sampleRate ?? 0; }
  get currentTime(): number { return this.ac?.currentTime ?? 0; }

  get masterVolume(): number { return this._masterVolume; }
  set masterVolume(v: number) {
    this._masterVolume = Math.max(0, Math.min(1.5, v));
    if (this.ac) this.master.gain.setTargetAtTime(this._masterVolume, this.ac.currentTime, 0.02);
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────────────────────

  /**
   * Build the graph and start the clock. MUST be called from a user gesture; calling it twice is
   * harmless. Everything expensive (six noise textures, the reverb impulse) happens here, exactly
   * once, on the click that dismisses the boot overlay.
   */
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.build();
    return this.starting;
  }

  private async build(): Promise<void> {
    const Ctor = contextCtor();
    if (!Ctor) return;
    let ac: AudioContext;
    try {
      ac = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.ac = ac;

    this.master = ac.createGain();
    this.master.gain.value = this._masterVolume;
    this.master.connect(ac.destination);

    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = MIX.limiterThreshold;
    this.limiter.knee.value = MIX.limiterKnee;
    this.limiter.ratio.value = MIX.limiterRatio;
    this.limiter.attack.value = MIX.limiterAttack;
    this.limiter.release.value = MIX.limiterRelease;
    this.limiter.connect(this.master);

    this.highpass = ac.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = MIX.highpassHz;
    this.highpass.Q.value = 0.7;
    this.highpass.connect(this.limiter);

    this.duckGain = ac.createGain();
    this.duckGain.gain.value = 1;
    this.duckGain.connect(this.highpass);

    this.duckFilter = ac.createBiquadFilter();
    this.duckFilter.type = 'lowpass';
    this.duckFilter.frequency.value = MIX.duckOpenHz;
    this.duckFilter.Q.value = 0.7;
    this.duckFilter.connect(this.duckGain);

    this.dry = ac.createGain();
    this.dry.gain.value = MIX.sfxLevel;
    this.dry.connect(this.duckFilter);

    const convolver = ac.createConvolver();
    convolver.normalize = true;
    convolver.buffer = makeImpulseResponse(ac, MIX.reverbSeconds, MIX.reverbDecay, MIX.noiseSeed ^ 0x5a5a);
    this.reverbReturn = ac.createGain();
    this.reverbReturn.gain.value = MIX.reverbLevel;
    convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.duckFilter);
    this.reverbBus = ac.createGain();
    this.reverbBus.gain.value = 1;
    this.reverbBus.connect(convolver);

    // The bed gets its own sidechain trim BEFORE the shared duck, so a gunshot can shove the
    // horde down without touching the gunshot. Ducking the whole bus would just make the gun
    // duck itself, which is the classic reason synthesized mixes turn to mud under fire.
    this.bedDuckGain = ac.createGain();
    this.bedDuckGain.gain.value = 1;
    this.bedDuckGain.connect(this.duckFilter);

    // …and the same trim across the horde's own VOICES, which are not the bed. Shallower than
    // the bed duck: a groan that vanishes on every shot reads as a bug, one that leans back a
    // third of a stop reads as the gun being loud.
    this.crowdDuckGain = ac.createGain();
    this.crowdDuckGain.gain.value = 1;
    this.crowdDuckGain.connect(this.duckFilter);

    this.crowdNormGain = ac.createGain();
    this.crowdNormGain.gain.value = 1;
    this.crowdNormGain.connect(this.crowdDuckGain);

    this.ambientBus = ac.createGain();
    this.ambientBus.gain.value = MIX.ambientLevel;
    this.ambientBus.connect(this.bedDuckGain);

    this.bank = makeNoiseBank(ac, MIX.noiseSeed);
    this.curve = makeDriveCurve();

    this.buildAmbientBed(ac, this.bank);

    try { await ac.resume(); } catch { /* a blocked resume is not fatal — the graph is built */ }
  }

  /**
   * THE HORDE BED — four layers, and TWO independent drivers.
   *
   * The bed does not have "a volume". It has a DENSITY (how many of them there are) and a
   * MENACE (how close the nearest one is), and they move different layers:
   *
   *   wind    — brown noise, always there. Opens its band-pass with density: the street gets
   *             busier before it gets louder.
   *   rumble  — a detuned sub pair. Density², because dread is superlinear.
   *   voices  — the reserved `grit` rasp, mid band, swelling on a 0.13 Hz LFO. Density.
   *   close   — the same rasp an octave up and much drier, plus a faster tremolo. MENACE only.
   *             This is the layer that tells you something is behind you *before* it touches
   *             you, and it is the reason "being surrounded" is audible instead of merely true.
   *
   * Started once, never stopped, never reallocated. At density 0 / menace 0 the only thing
   * audible is `bedNoiseLow` — a floor of wind. Nothing ticks, pings or breathes while the
   * player stands still, which is the audio reading of ART §4.1.
   */
  private buildAmbientBed(ac: AudioContext, bank: NoiseBank): void {
    // wind
    const noise = ac.createBufferSource();
    noise.buffer = bank.brown;
    noise.loop = true;
    noise.playbackRate.value = 0.6;
    const nf = ac.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = MIX.bedCutoffLow;
    nf.Q.value = 0.6;
    const ng = ac.createGain();
    ng.gain.value = MIX.bedNoiseLow;
    noise.connect(nf); nf.connect(ng); ng.connect(this.ambientBus);
    this.bedNoiseFilter = nf;
    this.bedNoiseGain = ng;

    // rumble
    const rg = ac.createGain();
    rg.gain.value = MIX.bedRumbleLow;
    const rf = ac.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 130;
    rf.Q.value = 0.8;
    rf.connect(rg); rg.connect(this.ambientBus);
    for (let i = 0; i < 2; i++) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = MIX.bedRumbleHz + (i === 0 ? 0 : MIX.bedRumbleDetune);
      o.connect(rf);
      o.start();
      this.bedSources.push(o);
    }
    this.bedRumbleGain = rg;

    // voices
    const voice = ac.createBufferSource();
    voice.buffer = bank.grit;
    voice.loop = true;
    voice.playbackRate.value = 0.42;
    const vf = ac.createBiquadFilter();
    vf.type = 'bandpass';
    vf.frequency.value = 300;
    vf.Q.value = 2.2;
    const vg = ac.createGain();
    vg.gain.value = MIX.bedVoicesLow;
    voice.connect(vf); vf.connect(vg); vg.connect(this.ambientBus);
    this.bedVoiceGain = vg;

    // the swell — an LFO summed into the voice layer's gain param
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = MIX.bedSwellHz;
    const lg = ac.createGain();
    lg.gain.value = 0;
    lfo.connect(lg); lg.connect(vg.gain);
    lfo.start();
    this.bedSwellGain = lg;

    // the close layer — proximity, not population
    const close = ac.createBufferSource();
    close.buffer = bank.grit;
    close.loop = true;
    close.playbackRate.value = 0.78;
    const cf = ac.createBiquadFilter();
    cf.type = 'bandpass';
    cf.frequency.value = MIX.bedCloseHz;
    cf.Q.value = 3.4;
    const cg = ac.createGain();
    cg.gain.value = 0;
    close.connect(cf); cf.connect(cg); cg.connect(this.ambientBus);
    const clfo = ac.createOscillator();
    clfo.type = 'triangle';
    clfo.frequency.value = MIX.bedCloseTremoloHz;
    const clg = ac.createGain();
    clg.gain.value = 0;
    clfo.connect(clg); clg.connect(cf.frequency);
    clfo.start();
    this.bedCloseGain = cg;
    this.bedCloseFilter = cf;

    this.bedSources.push(lfo, noise, voice, close, clfo);
    noise.start();
    voice.start();
    close.start();
    // The tremolo depth is fixed; only the layer's gain moves, so a still, empty street cannot
    // wobble. `clg` is parked at its authored depth once and never touched again.
    clg.gain.value = MIX.bedCloseTremoloHz > 0 ? MIX.bedCloseWobbleHz : 0;
  }

  dispose(): void {
    const ac = this.ac;
    if (!ac) return;
    for (const s of this.bedSources) { try { s.stop(); } catch { /* not started */ } }
    this.bedSources.length = 0;
    for (const s of this.spatialSlots) s.dispose();
    for (const s of this.flatSlots) s.dispose();
    this.spatialSlots.length = 0;
    this.flatSlots.length = 0;
    this.ac = null;
    this.starting = null;
    void ac.close();
  }

  // ── playback ────────────────────────────────────────────────────────────────────────────────

  /**
   * Fire one instance of `id`. Positional arguments (not an options object) so the game's hot
   * paths can call it every shot without allocating.
   *
   * `spatial` is a REQUEST: a recipe marked `spatial:false` is always flat, because a sound that
   * lives in the player's head should not be re-positioned by whoever happens to trigger it.
   */
  play(
    id: string, spatial: boolean, x: number, y: number, z: number, volume: number, pitch: number,
  ): void {
    const ac = this.ac;
    if (!ac || !this.bank) return;

    const recipe = getRecipe(id);
    if (!recipe) {
      if (!this.missing.has(id)) {
        this.missing.add(id);
        console.warn(`[audio] no recipe "${id}" — the sound was requested but never authored`);
      }
      return;
    }

    const now = ac.currentTime;
    if (recipe.minInterval) {
      const last = this.lastAt.get(id);
      if (last !== undefined && now - last < recipe.minInterval) return;
    }
    const live = this.liveOf.get(id) ?? 0;
    if (live >= (recipe.maxConcurrent ?? MIX.defaultMaxConcurrent)) { this._dropped++; return; }

    const wantSpatial = spatial && recipe.spatial !== false;
    const priority = recipe.priority ?? 1;
    const slot = this.acquire(wantSpatial, priority, now);
    if (!slot) { this._dropped++; return; }

    // A stolen slot is faded out first, so its replacement starts a hair later.
    const when = slot.startedAt > now ? slot.startedAt : now;

    // ── round-robin variant: never the same take twice in a row ──
    let variant: VoiceVariant | undefined;
    const takes = recipe.variants;
    if (takes && takes.length > 0) {
      const prev = this.variantOf.get(id);
      let pick = Math.floor(this.rnd() * takes.length) % takes.length;
      if (takes.length > 1 && pick === prev) pick = (pick + 1) % takes.length;
      this.variantOf.set(id, pick);
      variant = takes[pick];
    }

    // ── distance: air absorption on the dry path, extra wetness on the send ──
    let cutoffMul = 1;
    let reverbMul = 1;
    if (wantSpatial && slot.air) {
      const dx = x - this.lx, dy = y - this.ly, dz = z - this.lz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const t = Math.min(1, Math.max(0, (dist - MIX.airNear) / Math.max(1e-3, MIX.airFar - MIX.airNear)));
      // Exponential, because absorption is dB-per-metre — a linear sweep sounds like a filter
      // being turned, an exponential one sounds like distance.
      const hz = MIX.airNearHz * Math.pow(MIX.airFarHz / MIX.airNearHz, t);
      slot.air.frequency.setValueAtTime(hz, now);
      // Far things are WETTER, not just quieter: the direct path falls off faster than the room.
      reverbMul = 1 + (MIX.distanceWet - 1) * t;
      cutoffMul = 1 - MIX.distanceCutoffPull * t;
    }

    if (slot.panner) {
      if (slot.panner.positionX) {
        slot.panner.positionX.setValueAtTime(x, now);
        slot.panner.positionY.setValueAtTime(y, now);
        slot.panner.positionZ.setValueAtTime(z, now);
      } else {
        (slot.panner as unknown as { setPosition(x: number, y: number, z: number): void })
          .setPosition(x, y, z);
      }
      slot.panner.refDistance = recipe.refDistance ?? MIX.refDistance;
      slot.panner.maxDistance = recipe.maxDistance ?? MIX.maxDistance;
      slot.panner.rolloffFactor = recipe.rolloff ?? MIX.rolloff;
    } else if (slot.stereo) {
      // Flat voices still get a hair of stereo movement so repeated footsteps don't stack into
      // one point in the middle of your skull. A recipe that authors its own per-layer `spread`
      // gets less of it — the authored image is the one that should win.
      const jit = recipe.width && recipe.width > 0 ? MIX.flatPanJitterWide : MIX.flatPanJitter;
      slot.stereo.pan.setValueAtTime((this.rnd() * 2 - 1) * jit, now);
    }

    // Open exactly one output tap, AT `when` rather than now — a stolen slot is mid-crossfade
    // and re-pointing it instantly would cut the outgoing fade into a click.
    if (slot.dryTap && slot.crowdTap) {
      const toCrowd = recipe.crowd === true;
      slot.crowd = toCrowd;
      slot.dryTap.gain.cancelScheduledValues(now);
      slot.crowdTap.gain.cancelScheduledValues(now);
      slot.dryTap.gain.setValueAtTime(toCrowd ? 0 : 1, when);
      slot.crowdTap.gain.setValueAtTime(toCrowd ? 1 : 0, when);
    }

    slot.recipeId = id;
    slot.priority = priority;
    slot.active = true;
    slot.startedAt = when;
    slot.endTime = renderVoice(
      ac, slot, recipe, this.bank, when, pitch, volume, this.rnd, variant, cutoffMul, reverbMul,
    );

    this.lastAt.set(id, now);
    this.liveOf.set(id, live + 1);
    this._played++;
  }

  private acquire(spatial: boolean, priority: number, now: number): Slot | null {
    const pool = spatial ? this.spatialSlots : this.flatSlots;
    const cap = spatial ? MIX.maxSpatialVoices : MIX.maxFlatVoices;

    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].active) { pool[i].startedAt = now; return pool[i]; }
    }
    if (pool.length < cap) {
      const ac = this.ac;
      if (!ac || !this.curve) return null;
      const slot = new Slot(
        ac, spatial, this.curve, this.dry, spatial ? this.crowdNormGain : null, this.reverbBus);
      pool.push(slot);
      slot.startedAt = now;
      return slot;
    }

    // Steal: lowest priority first, then oldest. Never steal something more important.
    let victim: Slot | null = null;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (s.priority > priority) continue;
      if (!victim || s.priority < victim.priority
        || (s.priority === victim.priority && s.startedAt < victim.startedAt)) victim = s;
    }
    if (!victim) return null;

    const fade = MIX.stealFade;
    victim.out.gain.cancelScheduledValues(0);
    victim.out.gain.setTargetAtTime(0, now, fade * 0.35);
    this.releaseSlot(victim, now + fade);
    this._stolen++;
    victim.startedAt = now + fade;
    return victim;
  }

  private releaseSlot(slot: Slot, when: number): void {
    if (slot.recipeId) {
      const n = this.liveOf.get(slot.recipeId) ?? 0;
      this.liveOf.set(slot.recipeId, n > 0 ? n - 1 : 0);
    }
    slot.free(when);
  }

  /** Recycle every voice whose envelope has finished. Called once per frame; O(voices). */
  private sweep(now: number): void {
    for (let i = 0; i < this.spatialSlots.length; i++) {
      const s = this.spatialSlots[i];
      if (s.active && now >= s.endTime) this.releaseSlot(s, now);
    }
    for (let i = 0; i < this.flatSlots.length; i++) {
      const s = this.flatSlots[i];
      if (s.active && now >= s.endTime) this.releaseSlot(s, now);
    }
  }

  // ── per-frame ───────────────────────────────────────────────────────────────────────────────

  /**
   * `px/py/pz` is the listener position (the player's EYE — the authoritative source per
   * `PlayerService`), `f*` the look direction, `u*` the camera's up. Everything is plain numbers:
   * this runs every frame and must not touch a Vector3.
   */
  update(
    dt: number,
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
    duck: number,
  ): void {
    const ac = this.ac;
    if (!ac) return;
    const now = ac.currentTime;

    this.lx = px; this.ly = py; this.lz = pz;
    this.sweep(now);
    this.updateListener(ac, now, px, py, pz, fx, fy, fz, ux, uy, uz);

    // ── ducking ──
    this._duck = duck;
    if (Math.abs(duck - this._appliedDuck) > MIX.duckEpsilon) {
      this._appliedDuck = duck;
      const cut = MIX.duckOpenHz * Math.exp(-MIX.duckCurve * duck);
      this.duckFilter.frequency.setTargetAtTime(Math.max(120, cut), now, MIX.duckTau);
      this.duckGain.gain.setTargetAtTime(1 - MIX.duckGainDrop * duck, now, MIX.duckTau);
    }

    // ── the bed sidechain recovers on its own; only a fresh hit pushes it back down ──
    if (this._bedDuck > 0) {
      this._bedDuck -= dt / MIX.bedDuckRelease;
      if (this._bedDuck < 0) this._bedDuck = 0;
      this.bedDuckGain.gain.setTargetAtTime(
        1 - MIX.bedDuckDepth * this._bedDuck, now, MIX.bedDuckReleaseTau);
      this.crowdDuckGain.gain.setTargetAtTime(
        1 - MIX.crowdDuckDepth * this._bedDuck, now, MIX.bedDuckReleaseTau);
    }

    // ── the crowd bus divides itself by how many of them are shouting ──
    let crowdVoices = 0;
    for (let i = 0; i < this.spatialSlots.length; i++) {
      const s = this.spatialSlots[i];
      if (s.active && s.crowd) crowdVoices++;
    }
    const want = crowdVoices <= 1
      ? 1
      : Math.max(MIX.crowdNormFloor, 1 / (1 + MIX.crowdNormK * (crowdVoices - 1)));
    if (Math.abs(want - this.crowdNorm) > MIX.duckEpsilon) {
      this.crowdNorm = want;
      this.crowdNormGain.gain.setTargetAtTime(want, now, MIX.crowdNormTau);
    }

    // ── the bed follows density and menace, separately ──
    const k = 1 - Math.exp(-dt / MIX.intensityTau);
    this._intensity += (this._targetIntensity - this._intensity) * k;
    // Menace tracks faster than density: a zombie arriving behind you is news, and news that
    // takes 1.1 s to reach the mix is not a cue, it is a memory.
    const km = 1 - Math.exp(-dt / MIX.menaceTau);
    this._menace += (this._targetMenace - this._menace) * km;
    const I = this._intensity;
    const M = this._menace;
    const tau = MIX.intensityTau * 0.5;
    this.bedNoiseGain.gain.setTargetAtTime(
      MIX.bedNoiseLow + (MIX.bedNoiseHigh - MIX.bedNoiseLow) * I, now, tau);
    this.bedRumbleGain.gain.setTargetAtTime(
      MIX.bedRumbleLow + (MIX.bedRumbleHigh - MIX.bedRumbleLow) * Math.max(I * I, M * M * 0.8),
      now, tau);
    const voiceLevel = MIX.bedVoicesLow + (MIX.bedVoicesHigh - MIX.bedVoicesLow) * Math.pow(I, 1.5);
    this.bedVoiceGain.gain.setTargetAtTime(voiceLevel, now, tau);
    this.bedSwellGain.gain.setTargetAtTime(voiceLevel * MIX.bedSwellDepth, now, tau);
    this.bedNoiseFilter.frequency.setTargetAtTime(
      MIX.bedCutoffLow + (MIX.bedCutoffHigh - MIX.bedCutoffLow) * I, now, tau);
    // The close layer is pure proximity, and it comes in late and hard (M³) so it reads as an
    // arrival rather than a fade.
    this.bedCloseGain.gain.setTargetAtTime(MIX.bedCloseHigh * M * M * M, now, MIX.menaceTau * 0.5);
    this.bedCloseFilter.frequency.setTargetAtTime(
      MIX.bedCloseHz + MIX.bedCloseHzRise * M, now, MIX.menaceTau);
  }

  private updateListener(
    ac: AudioContext, now: number,
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
  ): void {
    const l = ac.listener;
    if (l.positionX) {
      l.positionX.setValueAtTime(px, now);
      l.positionY.setValueAtTime(py, now);
      l.positionZ.setValueAtTime(pz, now);
      l.forwardX.setValueAtTime(fx, now);
      l.forwardY.setValueAtTime(fy, now);
      l.forwardZ.setValueAtTime(fz, now);
      l.upX.setValueAtTime(ux, now);
      l.upY.setValueAtTime(uy, now);
      l.upZ.setValueAtTime(uz, now);
    } else {
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(px, py, pz);
      legacy.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // ── mix control ─────────────────────────────────────────────────────────────────────────────

  setIntensity(v: number): void {
    this._targetIntensity = Math.max(0, Math.min(1, v));
  }

  /** How close the nearest thing that wants to eat you is, 0..1. Drives the close bed layer. */
  setMenace(v: number): void {
    this._targetMenace = Math.max(0, Math.min(1, v));
  }

  /**
   * SIDECHAIN. Shove the horde bed down for `MIX.bedDuckRelease` seconds. Called on every shot:
   * the bed is the thing you hear when you are NOT shooting, and a bed that keeps its level
   * under gunfire is the single fastest way to turn a mix into mud.
   *
   * BUILD 006: it now shoves the horde's VOICES down too. The bed was never the thing burying
   * the gun — 25 spatial groans were.
   */
  duckBed(amount: number): void {
    const a = amount > 1 ? 1 : amount < 0 ? 0 : amount;
    if (a <= this._bedDuck) return;
    this._bedDuck = a;
    const ac = this.ac;
    if (!ac) return;
    const now = ac.currentTime;
    this.bedDuckGain.gain.setTargetAtTime(1 - MIX.bedDuckDepth * a, now, MIX.bedDuckAttack);
    this.crowdDuckGain.gain.setTargetAtTime(1 - MIX.crowdDuckDepth * a, now, MIX.bedDuckAttack);
  }

  get intensity(): number { return this._intensity; }
  get menace(): number { return this._menace; }

  /**
   * THE MEASUREMENT TAP. An `AnalyserNode` hung off the master bus so a recipe can be proved
   * non-silent from the console instead of by ear. Created on first request and reused; it is
   * a pure observer and adds nothing to the signal path.
   */
  tapAnalyser(): AnalyserNode | null {
    const ac = this.ac;
    if (!ac) return null;
    if (!this.analyser) {
      const a = ac.createAnalyser();
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0;
      this.master.connect(a);
      this.analyser = a;
    }
    return this.analyser;
  }

  stats(out: EngineStats): EngineStats {
    out.running = this.running;
    out.spatialVoices = this.spatialSlots.length;
    out.flatVoices = this.flatSlots.length;
    let a = 0, b = 0;
    for (const s of this.spatialSlots) if (s.active) a++;
    for (const s of this.flatSlots) if (s.active) b++;
    out.spatialLive = a;
    out.flatLive = b;
    out.stolen = this._stolen;
    out.dropped = this._dropped;
    out.played = this._played;
    out.intensity = this._intensity;
    out.menace = this._menace;
    out.duck = this._duck;
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// OFFLINE RENDER — the measurement seam.
//
// Renders one instance of a recipe through the real slot topology into a buffer, with no
// hardware involved. This is how the recipes are verified (peak, RMS, length, and that two
// instances are genuinely different) instead of being signed off by ear.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function renderRecipeOffline(
  recipeOrId: string | Recipe, seconds = 2, seed = 1, sampleRate = 48000,
  variantIndex = -1,
): Promise<Float32Array | null> {
  const recipe = typeof recipeOrId === 'string' ? getRecipe(recipeOrId) : recipeOrId;
  if (!recipe) return null;
  const OC = typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : null;
  if (!OC) return null;

  const ac = new OC(1, Math.ceil(sampleRate * seconds), sampleRate);
  const bank = makeNoiseBank(ac, MIX.noiseSeed);
  const curve = makeDriveCurve();
  const dry = ac.createGain();
  dry.connect(ac.destination);
  const sink = ac.createGain();
  sink.gain.value = 0;
  sink.connect(ac.destination);

  const slot = new Slot(ac, false, curve, dry, null, sink);
  const takes = recipe.variants;
  const variant = takes && variantIndex >= 0 ? takes[variantIndex % takes.length] : undefined;
  renderVoice(ac, slot, recipe, bank, 0, 1, 1, makeRandom(seed), variant);
  const rendered = await ac.startRendering();
  return rendered.getChannelData(0);
}

/** One recipe's acceptance test. Every field is measured, none is asserted by ear. */
export interface RecipeMeasurement {
  id: string;
  /** Layers the recipe actually stacks. */
  layers: number;
  /** Round-robin takes. */
  takes: number;
  /** Absolute peak, linear. */
  peak: number;
  /** RMS over the audible span, linear. */
  rms: number;
  /** Milliseconds from the first non-silent sample to the peak — the transient. */
  attackMs: number;
  /** Milliseconds the recipe is audible for. */
  lengthMs: number;
  /** True if nothing came out. A silently broken recipe is worse than a dull one. */
  silent: boolean;
}

/**
 * OFFLINE-RENDER EVERY RECIPE AND MEASURE IT.
 *
 * This is the seam that stops a recipe from being signed off by hope. It renders each sound
 * through the real slot topology with no hardware involved and reports peak, RMS, transient
 * length and total length, so "does it make a sound, and is that sound the shape I authored"
 * is a table, not an opinion.
 */
export async function measureRecipes(
  ids?: readonly string[], seconds = 2.4, sampleRate = 48000,
): Promise<RecipeMeasurement[]> {
  const list = ids ?? RECIPES.map((r) => r.id);
  const out: RecipeMeasurement[] = [];
  for (const id of list) {
    const recipe = getRecipe(id);
    if (!recipe) continue;
    const data = await renderRecipeOffline(id, seconds, 1, sampleRate);
    if (!data) continue;
    const floor = 1e-4;
    let peak = 0, peakAt = 0, first = -1, last = -1, sum = 0, n = 0;
    for (let i = 0; i < data.length; i++) {
      const a = data[i] < 0 ? -data[i] : data[i];
      if (a > peak) { peak = a; peakAt = i; }
      if (a > floor) { if (first < 0) first = i; last = i; }
    }
    if (first >= 0) {
      for (let i = first; i <= last; i++) { sum += data[i] * data[i]; n++; }
    }
    out.push({
      id,
      layers: Math.min(recipe.layers.length, SYNTH.maxLayers),
      takes: recipe.variants?.length ?? 0,
      peak: +peak.toFixed(4),
      rms: +(n > 0 ? Math.sqrt(sum / n) : 0).toFixed(4),
      attackMs: first >= 0 ? +(((peakAt - first) / sampleRate) * 1000).toFixed(1) : 0,
      lengthMs: first >= 0 ? +(((last - first) / sampleRate) * 1000).toFixed(1) : 0,
      silent: peak < 0.002,
    });
  }
  return out;
}

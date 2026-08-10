/**
 * SYNTH — the recipe format and the DSP primitives behind it.
 *
 * EVERY SOUND IN THIS GAME IS GENERATED HERE. There are no samples, no fetches, no decodes.
 * A "sound" is a `Recipe`: up to four layers, each an oscillator or a slice of a procedurally
 * generated noise buffer, each with its own filter, its own pitch sweep and its own envelope,
 * summed through a shared saturation stage. That is the whole model, and it is enough to build
 * a gunshot, a bone crack, a chime and a groan out of the same six numbers.
 *
 * WHY THIS SHAPE
 *  • A recipe is DATA (`recipes.ts`), so a sound can be retuned without touching a line of code.
 *  • The node graph a recipe plays through is FIXED (`VoiceSlot`), so the engine can pool it.
 *    Web Audio source nodes are one-shot by spec and cannot be pooled; everything downstream of
 *    them can be, and is. Per one-shot we allocate the source nodes and nothing else.
 *  • Every scalar can be jittered per instance. GAME_BIBLE §8 requires that the same sound never
 *    plays twice identically, and the cheapest way to guarantee that is to make variation part of
 *    the format rather than something each caller remembers to do.
 *
 * NOISE IS PRE-BAKED, NOT PER-SHOT. Six textures are generated once into `AudioBuffer`s and every
 * instance plays a RANDOM SLICE of one. That gives free, zero-cost timbral variation and keeps the
 * hot path down to "create a BufferSourceNode and schedule it".
 *
 * This file knows nothing about the game. It takes a context, a slot, a recipe and a clock.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DSP internals. These are not feel constants — they are the shape of the synthesiser itself.
// Mix levels, voice caps and everything gameplay-facing live in `recipes.ts::MIX`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SYNTH = {
  /**
   * Layers a single voice may stack. The slot graph is built to exactly this width.
   *
   * SIX, NOT FOUR. A great gunshot is a TRANSIENT (the click that decides "sharp"), a BODY (the
   * pitched sweep that decides "big"), a THUMP (the sub you feel), a TAIL (the room answering)
   * and — the two that four layers could never afford — a MECHANICAL layer (the action cycling,
   * which is what separates a gun from a firework) and a WIDTH layer (a detuned, hard-panned
   * copy of the body that makes the sound arrive from a place instead of a point). Those last
   * two are the whole difference between "functional" and "expensive".
   */
  maxLayers: 6,

  /** Seconds of each noise texture. Long enough that a random slice never repeats audibly. */
  noiseSeconds: {
    white: 1.2,
    pink: 1.2,
    brown: 1.6,
    crackle: 1.0,
    metal: 1.2,
    grit: 1.4,
  },

  /** Peak each generated buffer is normalised to. Headroom for the drive stage. */
  noisePeak: 0.95,

  /** `tanh` hardness of the shared saturation curve, and its table size. */
  driveHardness: 2.6,
  driveCurveSize: 2048,

  /**
   * How strongly a layer's FILTER cutoff follows the voice pitch, as an exponent on the pitch
   * multiplier. Full tracking makes a pitched-down sound muffled *and* small; no tracking makes
   * it sound like the same sound played slower. 0.6 is the compromise that reads as "a bigger
   * version of the same object".
   */
  cutoffPitchTrack: 0.6,

  /** An unfiltered layer still passes through its biquad — parked here, effectively bypassed. */
  bypassCutoff: 21000,

  /** Multiples of `decay` a percussive tail is allowed to ring before the source is stopped. */
  tailFactor: 1.7,
  /** `setTargetAtTime` time-constant as a fraction of `decay` / `release`. */
  tauFraction: 1 / 3.2,

  /** Exponential ramps cannot touch zero. */
  minFreq: 8,

  /** Reverb impulse: early-reflection taps (seconds) and their amplitudes. */
  irTaps: [0.0111, 0.0193, 0.0271, 0.0413, 0.0587, 0.0741],
  irTapGains: [0.62, -0.44, 0.36, -0.27, 0.2, -0.14],
  /** One-pole darkening of the reverb tail: coefficient at t=0 and at the end. */
  irDampStart: 0.28,
  irDampEnd: 0.86,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The recipe format
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type NoiseId = 'white' | 'pink' | 'brown' | 'crackle' | 'metal' | 'grit';

export type NoiseBank = Record<NoiseId, AudioBuffer>;

/**
 * One layer of a voice: a source, a filter and an envelope.
 *
 * The envelope is A-D-S-H-R. With `sustain` omitted (or 0) it collapses to a percussive A-D,
 * which is what almost every sound in a shooter actually is.
 */
export interface LayerSpec {
  readonly kind: 'osc' | 'noise';

  /** `osc` only — the waveform. */
  readonly wave?: OscillatorType;
  /** `noise` only — which pre-baked texture to slice. */
  readonly noise?: NoiseId;

  /** `osc` only — start frequency, Hz. */
  readonly freq?: number;
  /** `osc` only — end of the pitch sweep, Hz. Omit for a steady tone. */
  readonly freqEnd?: number;

  /** `noise` only — playback rate, and the end of its sweep. 1 = the texture as generated. */
  readonly rate?: number;
  readonly rateEnd?: number;

  /** Seconds the frequency / rate sweep takes. Defaults to the layer's audible length. */
  readonly sweep?: number;

  /** Seconds before this layer starts, relative to the voice. Staggering layers is most of the craft. */
  readonly delay?: number;

  // ── envelope, seconds ──
  readonly attack: number;
  readonly decay: number;
  /** 0..1 of peak. Omit for a percussive hit. */
  readonly sustain?: number;
  readonly hold?: number;
  readonly release?: number;

  /** Peak linear gain of this layer. */
  readonly gain: number;

  // ── filter (one biquad per layer) ──
  readonly filter?: BiquadFilterType;
  readonly cutoff?: number;
  /** Sweeping the cutoff is what turns a noise burst into an *impact*. */
  readonly cutoffEnd?: number;
  readonly q?: number;

  // ── per-instance variation, as ± fractions ──
  readonly jitterFreq?: number;
  readonly jitterGain?: number;
  readonly jitterCutoff?: number;

  /** 0 = this layer ignores the voice pitch, 1 = tracks it fully. Defaults: osc 1, noise 0.6. */
  readonly pitchTrack?: number;

  /**
   * −1..1 stereo placement of THIS layer, scaled by the recipe's `width`.
   *
   * Only flat (player-local) voices honour it: a spatial voice ends in an HRTF `PannerNode`,
   * whose input is downmixed to mono, so panning its layers would be thrown away. That is
   * exactly the right split — width is a first-person effect. Putting the gun's crack dead
   * centre, its body a hair left and its tail wide is what stops a viewmodel sound from
   * sounding like it is happening inside a single speaker.
   */
  readonly spread?: number;
}

/**
 * A ROUND-ROBIN VARIANT. Per-instance jitter alone still produces the same *shape* every time;
 * a variant changes the sound's identity a little — a slightly tighter, brighter, quieter take.
 * The engine walks the list and can never play the same index twice in a row, so the ear never
 * gets the machine-gun-sameness that kills a shooter's gunfire after ninety seconds.
 */
export interface VoiceVariant {
  /** Multiplies the voice pitch. */
  readonly pitch?: number;
  /** Multiplies the recipe gain. */
  readonly gain?: number;
  /** Multiplies every layer's filter cutoff. */
  readonly cutoff?: number;
}

export interface Recipe {
  readonly id: string;
  readonly layers: readonly LayerSpec[];

  /** Recipe master gain, applied after the drive stage. */
  readonly gain?: number;
  /** Saturation drive. 1 = clean-ish, 4+ = comic-book crunch. */
  readonly drive?: number;
  /** ± fractional pitch randomisation applied to the whole voice. */
  readonly pitchJitter?: number;

  /** Scales every layer's `spread`. 0 = mono, 1 = as authored. Flat voices only. */
  readonly width?: number;

  /**
   * Round-robin takes of this sound. Two consecutive plays are never the same index, so
   * "the same sound twice" is structurally impossible, not merely unlikely.
   */
  readonly variants?: readonly VoiceVariant[];

  /**
   * `false` forces the voice to the flat (non-spatial) bus even when a position is supplied.
   * The player's own gun, hitmarkers and UI live in the player's head, not in the world.
   */
  readonly spatial?: boolean;
  /**
   * THE HORDE'S OWN VOICES. `true` routes this recipe through the crowd bus, which the shot
   * sidechain ducks (see `engine.ts::duckBed`). Measured in BUILD 005: with 25 shamblers around
   * you a pistol shot lifted the mix only +2.0 dB and its centroid only reached 1041 Hz, versus
   * +4.8 dB and 4500 Hz on an empty street — the gun stopped cutting through exactly when shot
   * feedback matters most, because the sidechain only reached the ambient bed and the horde is
   * 25 spatial voices. Mark the sounds the horde MAKES, never the sounds you make TO it: a
   * `zombie_flesh` or a `zombie_death` is your reward and must not duck.
   */
  readonly crowd?: boolean;
  readonly refDistance?: number;
  readonly maxDistance?: number;
  readonly rolloff?: number;

  /** 0..1 send into the shared synthesized room. */
  readonly reverb?: number;

  /** 0..3. A voice is never stolen by something of lower priority. */
  readonly priority?: number;
  /** Seconds before this recipe may retrigger. Stops 12 groans in one tick turning to mush. */
  readonly minInterval?: number;
  /** Simultaneous instances of this recipe. */
  readonly maxConcurrent?: number;
}

/**
 * The reusable half of a voice. The engine builds these once and hands one to `renderVoice`;
 * everything here persists for the life of the process.
 */
export interface VoiceSlot {
  readonly filters: readonly BiquadFilterNode[];
  readonly gains: readonly GainNode[];
  /** Per-layer stereo placement. `null` on spatial slots, where an HRTF panner follows. */
  readonly pans: readonly StereoPannerNode[] | null;
  readonly driveIn: GainNode;
  readonly driveOut: GainNode;
  readonly out: GainNode;
  readonly send: GainNode;
  /**
   * The two parallel taps after the panner on a SPATIAL slot: exactly one is open per voice, so
   * a horde voice lands on the duckable crowd bus and everything else lands on the dry bus. Both
   * stay wired forever; only their gains move, and they move at the voice's own start time so a
   * steal's 5 ms crossfade is never cut. `null` on flat slots, which are never crowd voices.
   */
  readonly dryTap: GainNode | null;
  readonly crowdTap: GainNode | null;
  /** One-shot source nodes of the CURRENT voice. The engine stops and disconnects these. */
  readonly sources: AudioScheduledSourceNode[];
}

export type RandomFn = () => number;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Deterministic noise generation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** mulberry32 — local to the synth so audio randomness never perturbs the gameplay RNG stream. */
export function makeRandom(seed: number): RandomFn {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalise(d: Float32Array, peak: number): void {
  let m = 0;
  for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > m) m = a; }
  if (m < 1e-6) return;
  const k = peak / m;
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

function fillWhite(d: Float32Array, r: RandomFn): void {
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
}

/** Paul Kellett's pink filter — 1/f, which is what "air" and "room" actually sound like. */
function fillPink(d: Float32Array, r: RandomFn): void {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
}

/** Leaky integrator — 1/f², the body of thuds, dust and distant weight. */
function fillBrown(d: Float32Array, r: RandomFn): void {
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = (last + 0.02 * (r() * 2 - 1)) / 1.02;
    d[i] = last;
  }
}

/** Sparse decaying impulses — gravel, glass, bone, the crunch inside a flesh hit. */
function fillCrackle(d: Float32Array, r: RandomFn, sampleRate: number): void {
  d.fill(0);
  const clicks = Math.floor(d.length / (sampleRate * 0.0009));
  for (let k = 0; k < clicks; k++) {
    const pos = Math.floor(r() * d.length);
    const amp = 0.25 + r() * 0.75;
    const len = Math.floor(sampleRate * (0.0008 + r() * 0.006));
    const inv = 1 / Math.max(1, len * 0.32);
    for (let j = 0; j < len && pos + j < d.length; j++) {
      d[pos + j] += amp * (r() * 2 - 1) * Math.exp(-j * inv);
    }
  }
}

/** Inharmonic partials — the ring that says "this object is made of metal". */
function fillMetal(d: Float32Array, r: RandomFn, sampleRate: number): void {
  d.fill(0);
  const ratios = [1, 1.71, 2.43, 3.11, 4.07, 5.32, 6.55, 7.94, 9.41];
  const base = 1180;
  for (let k = 0; k < ratios.length; k++) {
    const f = base * ratios[k] * (0.97 + r() * 0.06);
    const amp = 1 / (1 + k * 0.7);
    const phase = r() * Math.PI * 2;
    const amFreq = 0.7 + k * 0.31;
    const amPhase = r() * Math.PI * 2;
    const w = (Math.PI * 2 * f) / sampleRate;
    const wam = (Math.PI * 2 * amFreq) / sampleRate;
    for (let i = 0; i < d.length; i++) {
      d[i] += amp * Math.sin(w * i + phase) * (0.7 + 0.3 * Math.sin(wam * i + amPhase));
    }
  }
  // A breath of noise stops it reading as a synth pad.
  for (let i = 0; i < d.length; i++) d[i] += (r() * 2 - 1) * 0.12;
}

/**
 * Sample-and-hold, quantised, slowly wobbled — a broken vocal cord.
 * This is the source every zombie sound is built from, and it is why they don't sound like wind.
 */
function fillGrit(d: Float32Array, r: RandomFn, sampleRate: number): void {
  const hold = 7;
  const levels = 2.5;
  let v = 0;
  const w = (Math.PI * 2 * 3.1) / sampleRate;
  for (let i = 0; i < d.length; i++) {
    if (i % hold === 0) v = Math.round((r() * 2 - 1) * levels) / levels;
    d[i] = v * (0.6 + 0.4 * Math.sin(w * i));
  }
}

/** Build the six textures. Called once, on the user gesture that starts the context. */
export function makeNoiseBank(ac: BaseAudioContext, seed: number): NoiseBank {
  const sr = ac.sampleRate;
  const r = makeRandom(seed);
  const mk = (seconds: number, fill: (d: Float32Array) => void): AudioBuffer => {
    const buf = ac.createBuffer(1, Math.max(1, Math.floor(sr * seconds)), sr);
    const d = buf.getChannelData(0);
    fill(d);
    normalise(d, SYNTH.noisePeak);
    return buf;
  };
  return {
    white: mk(SYNTH.noiseSeconds.white, (d) => fillWhite(d, r)),
    pink: mk(SYNTH.noiseSeconds.pink, (d) => fillPink(d, r)),
    brown: mk(SYNTH.noiseSeconds.brown, (d) => fillBrown(d, r)),
    crackle: mk(SYNTH.noiseSeconds.crackle, (d) => fillCrackle(d, r, sr)),
    metal: mk(SYNTH.noiseSeconds.metal, (d) => fillMetal(d, r, sr)),
    grit: mk(SYNTH.noiseSeconds.grit, (d) => fillGrit(d, r, sr)),
  };
}

/**
 * A synthesized room. Noise under an exponential envelope, plus hand-placed early reflections
 * and a tail that darkens as it decays — a small concrete street, not a cathedral.
 */
export function makeImpulseResponse(
  ac: BaseAudioContext, seconds: number, decayExp: number, seed: number,
): AudioBuffer {
  const sr = ac.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ac.createBuffer(2, len, sr);
  const r = makeRandom(seed);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, decayExp);
      const damp = SYNTH.irDampStart + (SYNTH.irDampEnd - SYNTH.irDampStart) * t;
      lp += (1 - damp) * ((r() * 2 - 1) * env - lp);
      d[i] = lp;
    }
    for (let k = 0; k < SYNTH.irTaps.length; k++) {
      // Decorrelate the two channels or the room collapses to the middle of your head.
      const idx = Math.floor(sr * SYNTH.irTaps[k] * (ch === 0 ? 1 : 1.07));
      if (idx < len) d[idx] += SYNTH.irTapGains[k] * (ch === 0 ? 1 : -1);
    }
    normalise(d, 0.7);
  }
  return buf;
}

/** A `WaveShaper` curve. Aliased because the DOM types pin the backing buffer kind. */
export type CurveTable = Float32Array<ArrayBuffer>;

/** Shared saturation curve. Soft-knee `tanh`: transparent when quiet, comic when driven. */
export function makeDriveCurve(): CurveTable {
  const n = SYNTH.driveCurveSize;
  const k = SYNTH.driveHardness;
  const norm = Math.tanh(k);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scheduling
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Park a param at `value` from `at` onward, dropping anything the previous voice scheduled at or
 * after that instant.
 *
 * `at` MATTERS, and getting it wrong is a real bug: a stolen slot is mid-crossfade when its
 * replacement is scheduled, so wiping its `out.gain` "right now" cancels the fade and turns every
 * steal back into the click the fade exists to hide. Everything at the slot level is therefore
 * scheduled at the new voice's START time, which leaves the outgoing fade intact to run into it.
 */
function resetAt(p: AudioParam, value: number, at: number): void {
  p.cancelScheduledValues(at);
  p.setValueAtTime(value, at);
}

/** Wipe a param completely — used per layer, where the whole envelope is authored fresh. */
function reset(p: AudioParam, value: number, now: number): void {
  p.cancelScheduledValues(0);
  p.setValueAtTime(value, now);
}

function jitter(r: RandomFn, amount: number | undefined): number {
  return amount ? 1 + (r() * 2 - 1) * amount : 1;
}

/** Total audible length of a layer's envelope, excluding its delay. */
function layerLength(L: LayerSpec): number {
  const sus = L.sustain ?? 0;
  return sus > 0
    ? L.attack + L.decay + (L.hold ?? 0) + (L.release ?? L.decay)
    : L.attack + L.decay * SYNTH.tailFactor;
}

/**
 * Schedule one layer onto its pre-wired filter → gain pair.
 * Returns the absolute time at which this layer is guaranteed silent.
 */
function scheduleLayer(
  ac: BaseAudioContext, slot: VoiceSlot, index: number, L: LayerSpec,
  bank: NoiseBank, when: number, now: number, pitch: number, r: RandomFn,
  cutoffMul: number, width: number,
): number {
  const filter = slot.filters[index];
  const g = slot.gains[index].gain;
  const t0 = when + (L.delay ?? 0);
  const len = layerLength(L);
  const track = L.pitchTrack ?? (L.kind === 'osc' ? 1 : 0.6);
  const p = 1 + (pitch - 1) * track;

  // ── stereo placement (flat voices only — see `LayerSpec.spread`) ──
  const pans = slot.pans;
  if (pans) {
    const s = (L.spread ?? 0) * width;
    pans[index].pan.cancelScheduledValues(0);
    pans[index].pan.setValueAtTime(s < -1 ? -1 : s > 1 ? 1 : s, t0);
  }

  // ── filter ──
  const cutoff = (L.cutoff ?? SYNTH.bypassCutoff) * jitter(r, L.jitterCutoff) * cutoffMul
    * Math.pow(p, SYNTH.cutoffPitchTrack);
  filter.type = L.filter ?? 'lowpass';
  filter.Q.cancelScheduledValues(0);
  filter.Q.setValueAtTime(L.q ?? 0.7, now);
  filter.frequency.cancelScheduledValues(0);
  const c0 = Math.min(Math.max(cutoff, SYNTH.minFreq), SYNTH.bypassCutoff);
  filter.frequency.setValueAtTime(c0, t0);
  if (L.cutoffEnd !== undefined) {
    const c1 = Math.min(
      Math.max(L.cutoffEnd * cutoffMul * Math.pow(p, SYNTH.cutoffPitchTrack), SYNTH.minFreq),
      SYNTH.bypassCutoff,
    );
    filter.frequency.exponentialRampToValueAtTime(c1, t0 + (L.sweep ?? len));
  }

  // ── source ──
  let src: AudioScheduledSourceNode;
  if (L.kind === 'osc') {
    const osc = ac.createOscillator();
    osc.type = L.wave ?? 'sine';
    const f0 = Math.max((L.freq ?? 440) * p * jitter(r, L.jitterFreq), SYNTH.minFreq);
    osc.frequency.setValueAtTime(f0, t0);
    if (L.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(L.freqEnd * p, SYNTH.minFreq), t0 + (L.sweep ?? len),
      );
    }
    src = osc;
  } else {
    const buf = bank[L.noise ?? 'white'];
    const node = ac.createBufferSource();
    node.buffer = buf;
    const rate = Math.max(0.02, (L.rate ?? 1) * p * jitter(r, L.jitterFreq));
    node.playbackRate.setValueAtTime(rate, t0);
    if (L.rateEnd !== undefined) {
      node.playbackRate.exponentialRampToValueAtTime(
        Math.max(0.02, L.rateEnd * p), t0 + (L.sweep ?? len),
      );
    }
    // A RANDOM SLICE, every single time. This is the cheapest variation in the whole system.
    const need = len * rate + 0.02;
    if (need >= buf.duration) {
      node.loop = true;
      node.loopStart = 0;
      node.loopEnd = buf.duration;
    }
    const offset = node.loop ? r() * buf.duration : r() * Math.max(0, buf.duration - need);
    src = node;
    node.start(t0, offset);
  }
  if (L.kind === 'osc') (src as OscillatorNode).start(t0);
  src.connect(filter);
  slot.sources.push(src);

  // ── envelope ──
  const peak = Math.max(1e-4, L.gain * jitter(r, L.jitterGain));
  const sus = L.sustain ?? 0;
  g.cancelScheduledValues(0);
  g.setValueAtTime(0, t0);
  g.linearRampToValueAtTime(peak, t0 + Math.max(L.attack, 0.0004));
  let end: number;
  if (sus > 0) {
    const rel = L.release ?? L.decay;
    const hold = L.hold ?? 0;
    g.linearRampToValueAtTime(peak * sus, t0 + L.attack + L.decay);
    g.setValueAtTime(peak * sus, t0 + L.attack + L.decay + hold);
    g.setTargetAtTime(0, t0 + L.attack + L.decay + hold, Math.max(rel * SYNTH.tauFraction, 0.002));
    end = t0 + L.attack + L.decay + hold + rel;
  } else {
    g.setTargetAtTime(0, t0 + L.attack, Math.max(L.decay * SYNTH.tauFraction, 0.002));
    end = t0 + L.attack + L.decay * SYNTH.tailFactor;
  }
  g.setValueAtTime(0, end);
  src.stop(end + 0.01);
  return end + 0.01;
}

/**
 * Play `recipe` through `slot`, starting at `when`. Returns the absolute time the slot is free.
 *
 * ALLOCATION: the oscillator / buffer-source nodes, and nothing else. Everything downstream
 * belongs to the slot and is reused for the life of the process.
 */
export function renderVoice(
  ac: BaseAudioContext, slot: VoiceSlot, recipe: Recipe, bank: NoiseBank,
  when: number, pitch: number, volume: number, r: RandomFn,
  variant?: VoiceVariant, cutoffMul = 1, reverbMul = 1,
): number {
  const now = ac.currentTime;
  const drive = recipe.drive ?? 1;
  // Unity-ish makeup so a driven recipe isn't automatically the loudest thing on the bus.
  const makeup = 1 / (0.35 + 0.65 * drive);

  resetAt(slot.driveIn.gain, drive, when);
  resetAt(slot.driveOut.gain, (recipe.gain ?? 1) * (variant?.gain ?? 1) * volume * makeup, when);
  resetAt(slot.out.gain, 1, when);
  const wet = (recipe.reverb ?? 0) * reverbMul;
  resetAt(slot.send.gain, wet > 1.5 ? 1.5 : wet, when);

  const voicePitch = pitch * (variant?.pitch ?? 1) * jitter(r, recipe.pitchJitter);
  const cm = cutoffMul * (variant?.cutoff ?? 1);
  const width = recipe.width ?? 1;

  let end = when;
  const n = Math.min(recipe.layers.length, SYNTH.maxLayers);
  for (let i = 0; i < n; i++) {
    const e = scheduleLayer(ac, slot, i, recipe.layers[i], bank, when, now, voicePitch, r, cm, width);
    if (e > end) end = e;
  }
  // Layers this recipe doesn't use must be silent — the slot is shared. Silenced at `when`, not
  // now, for the same reason as above: cutting them at `now` would chop a stolen voice's tail.
  for (let i = n; i < SYNTH.maxLayers; i++) resetAt(slot.gains[i].gain, 0, when);

  return end;
}

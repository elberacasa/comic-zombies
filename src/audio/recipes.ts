/**
 * RECIPES — the sound design. This file is CONTENT, not code.
 *
 * Same role as `weapons/defs.ts` and `enemies/defs.ts`: pure data the system executes. Retuning
 * the game's audio means editing numbers here and nothing else. `MIX` holds the mix-desk knobs
 * (levels, voice caps, ducking, spatial falloff); `RECIPES` holds every sound in the game.
 *
 * HOW TO READ A RECIPE
 *   Almost everything follows the same three-part anatomy, because that is what an impact IS:
 *     1. TRANSIENT — a filtered noise burst, 1–3 ms attack. This is the part you *hear first*
 *        and the only part that decides whether a sound feels sharp or soft.
 *     2. BODY      — a pitched oscillator sweeping DOWN. The sweep is the whole trick: a static
 *        tone reads as a beep, a falling tone reads as an object being hit.
 *     3. TAIL      — low noise under a long, quiet envelope. The room. Cheap, and its absence is
 *        the single biggest reason synthesized audio sounds like a menu instead of a place.
 *
 * COMIC, NOT REALISTIC (ART_DIRECTION applied to sound). The gun does not sound like a Glock.
 * Pitch sweeps are exaggerated, the drive stage is pushed until the transient clips into a
 * CRACK, and reward sounds are unashamedly musical. The reference is a sound effect drawn as
 * the word "BLAM!" — punchy, over-articulated, instantly readable.
 *
 * THE RESERVED CHANNEL. ART §9 reserves the brightest hue and the heaviest ink for enemies.
 * The audio equivalent is reserved here too: zombie voices own the 150–900 Hz *rasp* band with
 * the `grit` texture, and nothing else in the game uses `grit`. A zombie is always identifiable
 * as a zombie, from any direction, under any amount of gunfire.
 */

import type { NoiseId, Recipe } from './synth';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// MIX — the desk.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const MIX = {
  /** Boot volume. Loud enough to feel, quiet enough not to be the first thing muted. */
  masterVolume: 0.72,

  /** Bus trims. */
  sfxLevel: 1,
  ambientLevel: 0.85,
  reverbLevel: 0.55,

  /** The synthesized room: a short concrete street, not a hall. */
  reverbSeconds: 0.85,
  reverbDecay: 2.6,

  /** DC / rumble guard, and the master limiter. Laptop speakers are the target. */
  highpassHz: 34,
  limiterThreshold: -9,
  limiterKnee: 6,
  limiterRatio: 12,
  limiterAttack: 0.003,
  limiterRelease: 0.18,

  // ── voices ────────────────────────────────────────────────────────────────────────────────
  /** Spatialised voices (one HRTF panner each) and flat voices (player-local / UI). */
  maxSpatialVoices: 20,
  /**
   * Flat slots are cheap (a stereo panner, no HRTF convolution) and they carry everything the
   * player needs to hear about THEMSELVES. Measured at 10 the pool sat pinned at 10/10 through a
   * 30 s firefight, which meant footsteps and brass were being stolen by the gun every time.
   */
  maxFlatVoices: 14,
  defaultMaxConcurrent: 4,
  /** Seconds of crossfade when a voice is stolen. Long enough to kill the click. */
  stealFade: 0.005,

  /**
   * 'HRTF' is what lets you hear a zombie *behind* you — that is a gameplay cue, not polish, so
   * it is the default. Flip to 'equalpower' if a weak machine ever needs the CPU back.
   */
  panningModel: 'HRTF' as PanningModelType,
  distanceModel: 'inverse' as DistanceModelType,
  /** Metres of "full volume" bubble, the cutoff, and the falloff exponent. */
  refDistance: 3.5,
  maxDistance: 90,
  rolloff: 1.15,

  // ── DISTANCE IS NOT VOLUME ────────────────────────────────────────────────────────────────
  /**
   * Air absorbs high frequencies. Inside `airNear` metres a sound is untouched; by `airFar` it
   * has lost everything above `airFarHz`, on an exponential (dB-per-metre) curve. This is the
   * cue the ear actually uses for distance — turn it off and every zombie sounds like it is
   * standing next to you, just quieter.
   */
  airNear: 5,
  airFar: 55,
  airNearHz: 19000,
  airFarHz: 1250,
  /** Far things are WETTER: the direct path falls off faster than the room does. */
  distanceWet: 2.4,
  /** How much a distant voice's own filters close as well, 0..1 of their cutoff. */
  distanceCutoffPull: 0.35,

  /** Random stereo nudge on flat voices — less when the recipe authors its own width. */
  flatPanJitter: 0.22,
  flatPanJitterWide: 0.09,

  // ── ducking (hitstop / downed / paused) ───────────────────────────────────────────────────
  /** Cutoff with the duck fully open, and the exponent that closes it. 1.0 → ≈ 335 Hz. */
  duckOpenHz: 20000,
  duckCurve: 4.1,
  /** Level drop at full duck, and the smoothing time-constant. */
  duckGainDrop: 0.38,
  duckTau: 0.022,
  /** How hard hitstop ducks. This is what makes a crit feel like the world flinched. */
  hitstopDuck: 0.62,
  /** Units-per-second the derived time-compression reading falls back to zero. */
  hitstopReleaseRate: 8,
  /** Ducking while downed, and while paused. */
  downDuck: 0.85,
  pauseDuck: 0.75,
  /** Extra master trim while paused, on top of the duck. */
  pauseGain: 0.4,
  /** Below this delta the duck automation is skipped — no point queuing 60 events/s. */
  duckEpsilon: 0.0025,

  // ── the ambient horde bed ─────────────────────────────────────────────────────────────────
  /** Smoothing of intensity changes. Slow — the bed should swell, never switch. */
  intensityTau: 1.1,
  /** Bed layer levels at intensity 0 → 1. */
  bedNoiseLow: 0.045, bedNoiseHigh: 0.10,
  bedRumbleLow: 0.018, bedRumbleHigh: 0.15,
  bedVoicesLow: 0, bedVoicesHigh: 0.20,
  /** The bed's band-pass opens as the horde grows: dread becomes presence. */
  bedCutoffLow: 200, bedCutoffHigh: 700,
  /** Rumble oscillator pair, Hz — detuned for a slow beat you feel more than hear. */
  bedRumbleHz: 42, bedRumbleDetune: 0.62,
  /** Swell LFO on the voice layer. */
  bedSwellHz: 0.13, bedSwellDepth: 0.55,

  /**
   * THE CLOSE LAYER — proximity, not population. It rides `menace` (distance to the nearest
   * body) on its own, faster clock, so being surrounded is audible a second before it is
   * visible. Silent at menace 0; nothing about it moves while the street is empty.
   */
  menaceTau: 0.45,
  bedCloseHz: 620, bedCloseHzRise: 340, bedCloseHigh: 0.115,
  /** Its tremolo — a breathing rate, not a musical one. */
  bedCloseTremoloHz: 2.7, bedCloseWobbleHz: 90,

  /**
   * THE SIDECHAIN. Every shot shoves the bed down and lets it climb back. `Depth` is how far,
   * `attack` how fast it gets there, `release` how long the climb takes.
   */
  bedDuckDepth: 0.62,
  bedDuckAttack: 0.006,
  bedDuckRelease: 0.55,
  /** Smoothing of the climb back. Slower than the attack — a duck should snap and breathe out. */
  bedDuckReleaseTau: 0.09,
  /**
   * …and how far the same envelope pulls the HORDE'S OWN VOICES down (`Recipe.crowd`). Half the
   * bed's depth: the bed is texture and can be shoved hard, a groan is information and must
   * still be there when the shot has passed. Measured target: the gun stays ≥ 4 dB over the mix
   * with 25 alive, against +2.0 dB before the crowd bus existed.
   */
  crowdDuckDepth: 0.34,

  /**
   * CROWD NORMALISATION. The crowd bus is divided by `1 / (1 + K × (voices − 1))`, floored.
   * One groan is untouched; eight are a wall rather than a brick. See the long note on
   * `engine.ts::crowdNormGain` — MEASURED, 25 shamblers on the player drove the master limiter
   * to 8.7 dB of reduction with no shot fired, and muting this bus alone took it to 1.6 dB.
   * K 0.30 puts eight simultaneous crowd voices at 0.32, which is where the limiter lets go.
   */
  crowdNormK: 0.30,
  /** Never quieter than this, however many of them there are. */
  crowdNormFloor: 0.28,
  /** Smoothing on the normalisation, seconds. Slow enough that it is a level, not a pump. */
  crowdNormTau: 0.12,
  /** How hard a single gunshot ducks the bed, and a nearby explosion / big beat. */
  shotBedDuck: 0.8,
  beatBedDuck: 1,

  /**
   * M2 has no round director, so the bed drives itself off the live horde. `setIntensity()`
   * (M3) is MAXed with this, never replaced — a quiet round should still feel loud if 20
   * zombies are on top of you.
   */
  autoIntensity: true,
  /** Alive count that counts as a full horde, and how often the horde is sampled (seconds). */
  hordeFull: 14,
  hordeSampleInterval: 0.25,
  /** Distance to the nearest zombie that reads as "full" / "gone", metres. */
  proximityNear: 6,
  proximityFar: 32,
  /** Weights of the two auto-intensity terms. */
  hordeCountWeight: 0.6,
  hordeProximityWeight: 0.55,

  /**
   * MENACE — the second driver, and the only one the close bed layer listens to. Proximity is
   * the base; a genuine crowd adds to it even at arm's length distances, because eight bodies
   * at six metres is a different problem from one body at six metres.
   */
  menaceCrowdCount: 6,
  menaceCrowdFull: 12,
  menaceCrowdWeight: 0.45,

  // ── gameplay-facing timing ────────────────────────────────────────────────────────────────
  /** Seconds after the shot that the shell hits the ground. */
  shellDelay: 0.30,
  /**
   * The mag-out / mag-in clicks are scheduled as FRACTIONS of the real reload duration, so a
   * reload-speed boon moves the clicks with the animation instead of desynchronising them.
   * These mirror `WEAPON.view.reloadMagOutT / reloadMagInT`, which is imported, not copied.
   */
  reloadSlapExtra: 0.10,
  /** Magazine left in the mag when the "you are nearly dry" tick fires. */
  lowAmmoAt: 3,
  /**
   * A quiet tick when the active-reload window OPENS. Deliberately near-subliminal: the bar is
   * the primary cue and the skill is reading it. Set to 0 to remove the audio crutch entirely.
   */
  activeReloadCueVolume: 0.18,
  /** Impact speed (m/s) above which a landing is a HARD landing. */
  landHardSpeed: 9,
  /** Sprinting footsteps: louder, heavier, and they gain a scuff layer. */
  sprintStepVolume: 1.3,
  sprintStepPitch: 0.93,
  sprintScuffVolume: 0.55,
  /** Damage that maps to a full-volume hitmarker. */
  hitmarkFullDamage: 45,
  /**
   * ═══ THE SLOT MACHINE ═══════════════════════════════════════════════════════════════════
   *
   * The kill confirm climbs a MAJOR SCALE, one degree per kill in the chain, and parks on the
   * octave. Eight kills is a complete musical phrase that resolves — which is precisely why it
   * makes you want a ninth. This is the highest-value forty bytes in the audio system: a rising
   * line is the oldest reward signal there is, and the player learns it in two rounds without
   * ever being told it exists.
   *
   * Equal-tempered ratios for scale degrees 1 2 3 4 5 6 7 8 (semitones 0 2 4 5 7 9 11 12).
   */
  killLadder: [1, 1.1225, 1.2599, 1.3348, 1.4983, 1.6818, 1.8877, 2] as readonly number[],
  /** A crit kills a scale degree higher still — the crit is always the better outcome. */
  killCritLadderBonus: 1,
  /**
   * The multiplier tier (×1→×5) drives the SEPARATE `combo_up` riser, one perfect fifth per
   * tier, so a tier change is a different event from a kill and cannot be mistaken for one.
   */
  comboUpPitch: [1, 1.3348, 1.6818, 2, 2.5198] as readonly number[],
  /** Chain length below which a break is not worth mourning. */
  comboBreakMin: 3,

  /** Deferred one-shots in flight (shell drops, reload clicks). Fixed pool, never grows. */
  pendingCapacity: 48,

  /** Seed for the noise textures and the reverb impulse. Same seed = same textures every boot. */
  noiseSeed: 0x9e3779b1,
  /** Seed for per-instance variation. */
  varianceSeed: 0x5f356495,
} as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// RECIPES
// ═════════════════════════════════════════════════════════════════════════════════════════════

const GRIT: NoiseId = 'grit';

export const RECIPES: readonly Recipe[] = [
  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE GUN. The most-heard sound in the game by an order of magnitude, so it gets the most work.
  //
  // SIX layers, and each one is doing a specific job:
  //   CRACK — band-passed white sweeping 2.9k→900, dead centre. The sweep is what makes it a
  //           gunshot instead of a hi-hat; the band-pass keeps it out of the zombies' rasp band.
  //   BODY  — a sawtooth falling 430→52 Hz in 85 ms. This is the "BLAM". A pistol in a comic is
  //           drawn as a shape that gets bigger and lower, and that is exactly a downward sweep.
  //   THUMP — a sine sub so it lands in the chest on speakers that have any bottom end at all.
  //   MECH  — the action cycling, 9 ms late and hard right. Every real gun makes TWO sounds per
  //           shot and this is the second one; without it a gunshot is a firework.
  //   WIDE  — a detuned copy of the body, hard left, 3 ms late. Two near-identical transients a
  //           few ms apart at opposite ears is the oldest trick in the book for making a sound
  //           arrive from a PLACE, and it costs one layer.
  //   SLAP  — brown noise tail, wide. The street answering back.
  //
  // FOUR TAKES, round-robin, never the same twice running: tighter, brighter, fatter, duller.
  // At 600 RPM you hear this sound ten times a second — sameness is the enemy, not loudness.
  //
  // It is FLAT (spatial:false) — the gun is in the player's hands, not in the world; a panner at
  // 0.4 m does nothing but colour it. The room send does the spatial work instead.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'gun_pistol',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.0006, decay: 0.055, gain: 0.95,
        filter: 'bandpass', cutoff: 2900, cutoffEnd: 900, q: 0.9,
        jitterCutoff: 0.14, jitterGain: 0.08, pitchTrack: 0.35, spread: 0 },
      { kind: 'osc', wave: 'sawtooth', freq: 430, freqEnd: 52, sweep: 0.085,
        attack: 0.001, decay: 0.105, gain: 0.85,
        filter: 'lowpass', cutoff: 2100, cutoffEnd: 420, q: 1.1, jitterFreq: 0.05, spread: 0.16 },
      { kind: 'osc', wave: 'sine', freq: 135, freqEnd: 44, sweep: 0.13,
        attack: 0.002, decay: 0.20, gain: 0.75, jitterFreq: 0.04, spread: 0 },
      { kind: 'noise', noise: 'metal', delay: 0.009, attack: 0.0006, decay: 0.045, gain: 0.30,
        filter: 'bandpass', cutoff: 3900, q: 2.6, jitterCutoff: 0.2, jitterFreq: 0.14,
        spread: 0.62 },
      { kind: 'osc', wave: 'sawtooth', freq: 418, freqEnd: 50, sweep: 0.09, delay: 0.003,
        attack: 0.001, decay: 0.10, gain: 0.5,
        filter: 'lowpass', cutoff: 1900, cutoffEnd: 400, q: 1.0, jitterFreq: 0.05, spread: -0.7 },
      { kind: 'noise', noise: 'brown', delay: 0.012, attack: 0.012, decay: 0.33, gain: 0.20,
        filter: 'lowpass', cutoff: 1100, cutoffEnd: 380, q: 0.6, jitterCutoff: 0.18,
        spread: -0.35 },
    ],
    gain: 0.95, drive: 3.4, pitchJitter: 0.05, width: 1,
    variants: [
      { pitch: 1, gain: 1, cutoff: 1 },
      { pitch: 1.035, gain: 0.94, cutoff: 1.14 },
      { pitch: 0.965, gain: 1.05, cutoff: 0.9 },
      { pitch: 1.012, gain: 0.97, cutoff: 1.05 },
    ],
    spatial: false, reverb: 0.30, priority: 3, maxConcurrent: 6,
  },
  /** Fallbacks so a weapon added in M4 always makes a noise even before it has its own recipe. */
  {
    id: 'gun_smg',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.0005, decay: 0.038, gain: 0.9,
        filter: 'bandpass', cutoff: 3400, cutoffEnd: 1200, q: 1.0, jitterCutoff: 0.15, spread: 0 },
      { kind: 'osc', wave: 'square', freq: 380, freqEnd: 60, sweep: 0.06,
        attack: 0.001, decay: 0.075, gain: 0.7,
        filter: 'lowpass', cutoff: 2400, cutoffEnd: 520, q: 1.0, jitterFreq: 0.05, spread: 0.2 },
      { kind: 'osc', wave: 'sine', freq: 120, freqEnd: 46, sweep: 0.1,
        attack: 0.002, decay: 0.14, gain: 0.6, spread: 0 },
      { kind: 'noise', noise: 'metal', delay: 0.006, attack: 0.0005, decay: 0.03, gain: 0.34,
        filter: 'bandpass', cutoff: 4600, q: 3.0, jitterCutoff: 0.22, jitterFreq: 0.16,
        spread: 0.66 },
      { kind: 'osc', wave: 'square', freq: 368, freqEnd: 58, sweep: 0.062, delay: 0.0025,
        attack: 0.001, decay: 0.07, gain: 0.42,
        filter: 'lowpass', cutoff: 2200, cutoffEnd: 500, q: 1.0, spread: -0.72 },
      { kind: 'noise', noise: 'brown', delay: 0.01, attack: 0.01, decay: 0.24, gain: 0.15,
        filter: 'lowpass', cutoff: 950, cutoffEnd: 340, q: 0.6, spread: -0.3 },
    ],
    gain: 0.9, drive: 3.6, pitchJitter: 0.06, width: 1,
    variants: [
      { pitch: 1, cutoff: 1 },
      { pitch: 1.045, gain: 0.93, cutoff: 1.16 },
      { pitch: 0.958, gain: 1.06, cutoff: 0.88 },
      { pitch: 1.018, gain: 0.98, cutoff: 1.06 },
    ],
    spatial: false, reverb: 0.26, priority: 3, maxConcurrent: 6,
  },
  {
    id: 'gun_shotgun',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.0008, decay: 0.09, gain: 1.0,
        filter: 'bandpass', cutoff: 1900, cutoffEnd: 520, q: 0.7, jitterCutoff: 0.12, spread: 0 },
      { kind: 'osc', wave: 'sawtooth', freq: 300, freqEnd: 38, sweep: 0.13,
        attack: 0.0015, decay: 0.17, gain: 0.9,
        filter: 'lowpass', cutoff: 1500, cutoffEnd: 260, q: 1.2, jitterFreq: 0.05, spread: 0.22 },
      { kind: 'osc', wave: 'sine', freq: 105, freqEnd: 34, sweep: 0.2,
        attack: 0.003, decay: 0.3, gain: 0.85, spread: 0 },
      { kind: 'noise', noise: 'crackle', delay: 0.004, attack: 0.0008, decay: 0.07, gain: 0.42,
        filter: 'bandpass', cutoff: 2600, cutoffEnd: 1100, q: 1.4, rate: 1.6,
        jitterCutoff: 0.2, spread: 0.5 },
      { kind: 'osc', wave: 'sawtooth', freq: 288, freqEnd: 36, sweep: 0.14, delay: 0.004,
        attack: 0.0015, decay: 0.16, gain: 0.5,
        filter: 'lowpass', cutoff: 1350, cutoffEnd: 250, q: 1.1, spread: -0.74 },
      { kind: 'noise', noise: 'brown', delay: 0.02, attack: 0.02, decay: 0.5, gain: 0.26,
        filter: 'lowpass', cutoff: 800, cutoffEnd: 250, q: 0.6, spread: -0.32 },
    ],
    gain: 1.0, drive: 4.2, pitchJitter: 0.05, width: 1,
    variants: [
      { pitch: 1 },
      { pitch: 1.03, gain: 0.95, cutoff: 1.12 },
      { pitch: 0.97, gain: 1.04, cutoff: 0.9 },
    ],
    spatial: false, reverb: 0.36, priority: 3, maxConcurrent: 4,
  },
  {
    id: 'gun_marksman',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.0005, decay: 0.07, gain: 1.0,
        filter: 'bandpass', cutoff: 3600, cutoffEnd: 1100, q: 1.1, jitterCutoff: 0.12, spread: 0 },
      { kind: 'osc', wave: 'sawtooth', freq: 520, freqEnd: 44, sweep: 0.1,
        attack: 0.001, decay: 0.13, gain: 0.9,
        filter: 'lowpass', cutoff: 2600, cutoffEnd: 380, q: 1.3, jitterFreq: 0.04, spread: 0.18 },
      { kind: 'osc', wave: 'sine', freq: 145, freqEnd: 40, sweep: 0.18,
        attack: 0.002, decay: 0.26, gain: 0.8, spread: 0 },
      { kind: 'noise', noise: 'metal', delay: 0.012, attack: 0.0006, decay: 0.06, gain: 0.32,
        filter: 'bandpass', cutoff: 3400, q: 2.8, jitterCutoff: 0.2, jitterFreq: 0.14,
        spread: 0.6 },
      { kind: 'osc', wave: 'sawtooth', freq: 505, freqEnd: 42, sweep: 0.105, delay: 0.0035,
        attack: 0.001, decay: 0.125, gain: 0.5,
        filter: 'lowpass', cutoff: 2400, cutoffEnd: 360, q: 1.2, spread: -0.72 },
      { kind: 'noise', noise: 'brown', delay: 0.015, attack: 0.014, decay: 0.55, gain: 0.24,
        filter: 'lowpass', cutoff: 1000, cutoffEnd: 300, q: 0.6, spread: -0.34 },
    ],
    gain: 1.0, drive: 3.8, pitchJitter: 0.04, width: 1,
    variants: [
      { pitch: 1 },
      { pitch: 1.022, gain: 0.96, cutoff: 1.1 },
      { pitch: 0.982, gain: 1.03, cutoff: 0.93 },
    ],
    spatial: false, reverb: 0.42, priority: 3, maxConcurrent: 3,
  },

  // ── the gun's mechanical vocabulary ────────────────────────────────────────────────────────
  {
    id: 'dry_fire',
    layers: [
      { kind: 'noise', noise: 'crackle', attack: 0.0005, decay: 0.022, gain: 0.55,
        filter: 'bandpass', cutoff: 3300, q: 1.6, jitterCutoff: 0.12 },
      { kind: 'osc', wave: 'square', freq: 190, freqEnd: 92, sweep: 0.03,
        attack: 0.0008, decay: 0.045, gain: 0.3,
        filter: 'lowpass', cutoff: 1400, q: 1.0 },
    ],
    gain: 0.6, drive: 1.8, pitchJitter: 0.05, spatial: false, reverb: 0.1, priority: 2,
  },
  {
    id: 'shell_drop',
    layers: [
      { kind: 'noise', noise: 'metal', attack: 0.0006, decay: 0.05, gain: 0.5,
        filter: 'bandpass', cutoff: 4300, q: 2.2, jitterCutoff: 0.2, jitterFreq: 0.1 },
      { kind: 'noise', noise: 'metal', delay: 0.088, attack: 0.0006, decay: 0.038, gain: 0.32,
        filter: 'bandpass', cutoff: 3600, q: 2.4, jitterCutoff: 0.2, jitterFreq: 0.12 },
      { kind: 'noise', noise: 'metal', delay: 0.152, attack: 0.0006, decay: 0.028, gain: 0.2,
        filter: 'bandpass', cutoff: 3100, q: 2.6, jitterCutoff: 0.22, jitterFreq: 0.14 },
    ],
    gain: 0.62, drive: 1.4, pitchJitter: 0.11, spatial: false, reverb: 0.18,
    variants: [
      { pitch: 1, cutoff: 1 },
      { pitch: 1.11, gain: 0.9, cutoff: 1.2 },
      { pitch: 0.89, gain: 1.06, cutoff: 0.85 },
      { pitch: 1.04, gain: 0.96, cutoff: 1.02 },
    ],
    priority: 0, maxConcurrent: 4,
  },
  {
    id: 'reload_magout',
    layers: [
      { kind: 'noise', noise: 'metal', attack: 0.0008, decay: 0.05, gain: 0.6,
        filter: 'bandpass', cutoff: 2600, q: 1.8, jitterCutoff: 0.13 },
      { kind: 'osc', wave: 'square', freq: 240, freqEnd: 96, sweep: 0.04,
        attack: 0.001, decay: 0.06, gain: 0.35,
        filter: 'lowpass', cutoff: 1200, q: 1.1, jitterFreq: 0.05 },
    ],
    gain: 0.62, drive: 2.0, pitchJitter: 0.06, spatial: false, reverb: 0.14, priority: 2,
  },
  {
    id: 'reload_magin',
    layers: [
      { kind: 'noise', noise: 'metal', attack: 0.001, decay: 0.07, gain: 0.68,
        filter: 'bandpass', cutoff: 2100, q: 1.5, jitterCutoff: 0.12 },
      { kind: 'osc', wave: 'square', freq: 175, freqEnd: 68, sweep: 0.05,
        attack: 0.001, decay: 0.09, gain: 0.5,
        filter: 'lowpass', cutoff: 900, q: 1.2, jitterFreq: 0.05 },
      { kind: 'osc', wave: 'sine', freq: 92, freqEnd: 52, sweep: 0.08,
        attack: 0.002, decay: 0.11, gain: 0.4 },
    ],
    gain: 0.7, drive: 2.2, pitchJitter: 0.05, spatial: false, reverb: 0.16, priority: 2,
  },
  {
    id: 'reload_done',
    layers: [
      { kind: 'noise', noise: 'metal', attack: 0.0006, decay: 0.035, gain: 0.55,
        filter: 'bandpass', cutoff: 3200, q: 2.0, jitterCutoff: 0.12 },
      { kind: 'noise', noise: 'metal', delay: 0.052, attack: 0.0006, decay: 0.055, gain: 0.62,
        filter: 'bandpass', cutoff: 2400, q: 1.7, jitterCutoff: 0.12 },
      { kind: 'osc', wave: 'square', freq: 210, freqEnd: 88, sweep: 0.05, delay: 0.052,
        attack: 0.001, decay: 0.07, gain: 0.34,
        filter: 'lowpass', cutoff: 1100, q: 1.1 },
    ],
    gain: 0.62, drive: 2.1, pitchJitter: 0.05, spatial: false, reverb: 0.15, priority: 2,
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE ACTIVE RELOAD. This is the skill reward, so it is the ONE sound in the game that is
  // openly musical: a G major arpeggio (G5 → D6 → G6) stacked 45 ms apart with a sparkle on top.
  // Its pitch jitter is near-zero on purpose — a reward has to be a SIGNATURE the player learns
  // to chase, and a signature that wobbles isn't one.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'reload_perfect',
    layers: [
      // The mag still has to SEAT — the reward is only legible as a reward if the mechanical
      // event it rewards is audible underneath it.
      { kind: 'noise', noise: 'metal', attack: 0.0008, decay: 0.05, gain: 0.44,
        filter: 'bandpass', cutoff: 2300, q: 1.7, jitterCutoff: 0.1, spread: 0.35 },
      { kind: 'osc', wave: 'sine', freq: 784, attack: 0.004, decay: 0.30, gain: 0.50,
        spread: -0.28 },
      { kind: 'osc', wave: 'triangle', freq: 1174.7, delay: 0.048,
        attack: 0.003, decay: 0.32, gain: 0.42, spread: 0.3 },
      { kind: 'osc', wave: 'sine', freq: 1568, delay: 0.096,
        attack: 0.003, decay: 0.46, gain: 0.40, spread: -0.45 },
      { kind: 'osc', wave: 'sine', freq: 2349.3, delay: 0.096,
        attack: 0.004, decay: 0.5, gain: 0.14, spread: 0.55 },
      { kind: 'noise', noise: 'white', delay: 0.096, attack: 0.002, decay: 0.20, gain: 0.13,
        filter: 'highpass', cutoff: 6200, q: 0.7, jitterCutoff: 0.06, spread: -0.6 },
    ],
    gain: 0.72, drive: 1.25, pitchJitter: 0.004, width: 1,
    spatial: false, reverb: 0.40, priority: 3, maxConcurrent: 2,
  },
  {
    id: 'reload_stumble',
    layers: [
      { kind: 'noise', noise: 'brown', attack: 0.003, decay: 0.16, gain: 0.5,
        filter: 'lowpass', cutoff: 700, cutoffEnd: 260, q: 0.8, jitterCutoff: 0.14 },
      { kind: 'osc', wave: 'sawtooth', freq: 310, freqEnd: 138, sweep: 0.22,
        attack: 0.006, decay: 0.24, gain: 0.34,
        filter: 'lowpass', cutoff: 900, cutoffEnd: 320, q: 1.4, jitterFreq: 0.05 },
    ],
    gain: 0.55, drive: 2.4, pitchJitter: 0.05, spatial: false, reverb: 0.2, priority: 2,
  },
  {
    id: 'ar_cue',
    layers: [
      { kind: 'osc', wave: 'sine', freq: 2093, attack: 0.002, decay: 0.055, gain: 0.4 },
    ],
    gain: 0.5, drive: 1, pitchJitter: 0.006, spatial: false, reverb: 0.12, priority: 1,
  },
  {
    id: 'ammo_low',
    layers: [
      { kind: 'osc', wave: 'square', freq: 1760, attack: 0.001, decay: 0.035, gain: 0.22,
        filter: 'lowpass', cutoff: 5200, q: 0.8 },
      { kind: 'osc', wave: 'square', freq: 1760, delay: 0.075,
        attack: 0.001, decay: 0.035, gain: 0.22, filter: 'lowpass', cutoff: 5200, q: 0.8 },
    ],
    gain: 0.42, drive: 1.2, pitchJitter: 0.01, spatial: false, reverb: 0.1, priority: 1,
  },
  {
    id: 'weapon_equip',
    layers: [
      { kind: 'noise', noise: 'brown', attack: 0.004, decay: 0.13, gain: 0.42,
        filter: 'bandpass', cutoff: 1500, cutoffEnd: 620, q: 0.9, jitterCutoff: 0.12 },
      { kind: 'noise', noise: 'metal', delay: 0.07, attack: 0.001, decay: 0.09, gain: 0.4,
        filter: 'bandpass', cutoff: 2800, q: 2.0, jitterCutoff: 0.14 },
    ],
    gain: 0.6, drive: 1.8, pitchJitter: 0.05, spatial: false, reverb: 0.2, priority: 2,
  },
  {
    id: 'upgrade_chime',
    layers: [
      { kind: 'osc', wave: 'sawtooth', freq: 130.8, freqEnd: 261.6, sweep: 0.35,
        attack: 0.01, decay: 0.5, gain: 0.4,
        filter: 'lowpass', cutoff: 900, cutoffEnd: 3200, q: 2.0 },
      { kind: 'osc', wave: 'triangle', freq: 523.3, delay: 0.12, attack: 0.005, decay: 0.6, gain: 0.36 },
      { kind: 'osc', wave: 'sine', freq: 1046.5, delay: 0.24, attack: 0.005, decay: 0.8, gain: 0.34 },
      { kind: 'noise', noise: 'white', delay: 0.24, attack: 0.02, decay: 0.5, gain: 0.12,
        filter: 'highpass', cutoff: 5200, q: 0.7 },
    ],
    gain: 0.8, drive: 1.6, pitchJitter: 0.006,
    spatial: false, reverb: 0.55, priority: 3, maxConcurrent: 1,
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // SURFACE IMPACTS — one per `SurfaceKind`. These have to be distinguishable BLIND: the surface
  // you just shot is information (it tells you where the bullet went), so each one owns a
  // different band and a different envelope shape rather than being the same hit re-filtered.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'impact_concrete',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.0006, decay: 0.055, gain: 0.8,
        filter: 'bandpass', cutoff: 1700, cutoffEnd: 520, q: 0.8,
        jitterCutoff: 0.18, jitterGain: 0.14 },
      { kind: 'osc', wave: 'sine', freq: 105, freqEnd: 48, sweep: 0.07,
        attack: 0.001, decay: 0.1, gain: 0.42, jitterFreq: 0.1 },
      { kind: 'noise', noise: 'crackle', delay: 0.006, attack: 0.004, decay: 0.16, gain: 0.22,
        filter: 'highpass', cutoff: 2400, q: 0.7, jitterCutoff: 0.2 },
    ],
    gain: 0.72, drive: 2.6, pitchJitter: 0.11, reverb: 0.3, priority: 1, maxConcurrent: 5,
    variants: [
      { pitch: 1, cutoff: 1 },
      { pitch: 1.08, gain: 0.94, cutoff: 1.16 },
      { pitch: 0.91, gain: 1.05, cutoff: 0.86 },
    ],
  },
  {
    id: 'impact_metal',
    layers: [
      { kind: 'noise', noise: 'metal', attack: 0.0005, decay: 0.16, gain: 0.75,
        filter: 'bandpass', cutoff: 3400, cutoffEnd: 2000, q: 3.0,
        jitterCutoff: 0.22, jitterFreq: 0.14 },
      { kind: 'osc', wave: 'triangle', freq: 2450, freqEnd: 1900, sweep: 0.2,
        attack: 0.001, decay: 0.22, gain: 0.3, jitterFreq: 0.16 },
      { kind: 'noise', noise: 'white', attack: 0.0005, decay: 0.03, gain: 0.55,
        filter: 'bandpass', cutoff: 5200, q: 1.2, jitterCutoff: 0.15 },
      { kind: 'osc', wave: 'sine', freq: 130, freqEnd: 62, sweep: 0.06,
        attack: 0.001, decay: 0.08, gain: 0.3 },
    ],
    gain: 0.66, drive: 2.4, pitchJitter: 0.13, reverb: 0.38, priority: 1, maxConcurrent: 5,
    variants: [
      { pitch: 1, cutoff: 1 },
      { pitch: 1.08, gain: 0.94, cutoff: 1.16 },
      { pitch: 0.91, gain: 1.05, cutoff: 0.86 },
    ],
  },
  {
    id: 'impact_wood',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.0006, decay: 0.04, gain: 0.6,
        filter: 'bandpass', cutoff: 1100, cutoffEnd: 480, q: 1.4, jitterCutoff: 0.2 },
      { kind: 'osc', wave: 'square', freq: 270, freqEnd: 150, sweep: 0.05,
        attack: 0.001, decay: 0.1, gain: 0.5,
        filter: 'lowpass', cutoff: 1300, q: 2.4, jitterFreq: 0.13 },
      { kind: 'noise', noise: 'crackle', delay: 0.01, attack: 0.003, decay: 0.11, gain: 0.24,
        filter: 'bandpass', cutoff: 1900, q: 1.0, jitterCutoff: 0.2 },
    ],
    gain: 0.72, drive: 2.4, pitchJitter: 0.12, reverb: 0.24, priority: 1, maxConcurrent: 5,
    variants: [
      { pitch: 1, cutoff: 1 },
      { pitch: 1.08, gain: 0.94, cutoff: 1.16 },
      { pitch: 0.91, gain: 1.05, cutoff: 0.86 },
    ],
  },
  {
    id: 'impact_glass',
    layers: [
      { kind: 'noise', noise: 'crackle', attack: 0.0005, decay: 0.19, gain: 0.85,
        filter: 'highpass', cutoff: 4200, q: 0.8, jitterCutoff: 0.16, rate: 1.4 },
      { kind: 'noise', noise: 'metal', attack: 0.0006, decay: 0.24, gain: 0.4,
        filter: 'bandpass', cutoff: 5600, q: 3.5, jitterCutoff: 0.2, jitterFreq: 0.18 },
      { kind: 'osc', wave: 'triangle', freq: 3900, freqEnd: 3100, sweep: 0.16,
        attack: 0.001, decay: 0.2, gain: 0.24, jitterFreq: 0.2 },
      { kind: 'noise', noise: 'crackle', delay: 0.06, attack: 0.01, decay: 0.3, gain: 0.3,
        filter: 'highpass', cutoff: 3000, q: 0.7, rate: 0.8, jitterCutoff: 0.2 },
    ],
    gain: 0.6, drive: 2.0, pitchJitter: 0.12, reverb: 0.42, priority: 1, maxConcurrent: 4,
  },
  {
    id: 'impact_flesh',
    layers: [
      { kind: 'noise', noise: 'crackle', attack: 0.0006, decay: 0.045, gain: 0.7,
        filter: 'lowpass', cutoff: 1400, cutoffEnd: 420, q: 1.2, jitterCutoff: 0.18 },
      { kind: 'osc', wave: 'sine', freq: 160, freqEnd: 52, sweep: 0.07,
        attack: 0.001, decay: 0.11, gain: 0.6, jitterFreq: 0.14 },
      { kind: 'noise', noise: 'brown', delay: 0.008, attack: 0.005, decay: 0.13, gain: 0.32,
        filter: 'bandpass', cutoff: 620, cutoffEnd: 260, q: 0.9, jitterCutoff: 0.2 },
    ],
    gain: 0.78, drive: 3.0, pitchJitter: 0.13, reverb: 0.2, priority: 2, maxConcurrent: 6,
    variants: [
      { pitch: 1, cutoff: 1 },
      { pitch: 1.08, gain: 0.94, cutoff: 1.16 },
      { pitch: 0.91, gain: 1.05, cutoff: 0.86 },
    ],
  },
  {
    id: 'impact_dirt',
    layers: [
      { kind: 'noise', noise: 'brown', attack: 0.001, decay: 0.09, gain: 0.75,
        filter: 'lowpass', cutoff: 900, cutoffEnd: 280, q: 0.7, jitterCutoff: 0.18 },
      { kind: 'noise', noise: 'crackle', delay: 0.004, attack: 0.004, decay: 0.14, gain: 0.28,
        filter: 'bandpass', cutoff: 1600, q: 0.8, rate: 0.7, jitterCutoff: 0.2 },
      { kind: 'osc', wave: 'sine', freq: 88, freqEnd: 42, sweep: 0.08,
        attack: 0.002, decay: 0.11, gain: 0.32 },
    ],
    gain: 0.7, drive: 2.0, pitchJitter: 0.13, reverb: 0.16, priority: 1, maxConcurrent: 5,
    variants: [
      { pitch: 1, cutoff: 1 },
      { pitch: 1.08, gain: 0.94, cutoff: 1.16 },
      { pitch: 0.91, gain: 1.05, cutoff: 0.86 },
    ],
  },
  {
    id: 'ricochet',
    layers: [
      { kind: 'osc', wave: 'sawtooth', freq: 3300, freqEnd: 820, sweep: 0.26,
        attack: 0.002, decay: 0.24, gain: 0.3,
        filter: 'bandpass', cutoff: 3000, cutoffEnd: 1200, q: 5.0, jitterFreq: 0.18 },
      { kind: 'noise', noise: 'metal', attack: 0.0006, decay: 0.06, gain: 0.3,
        filter: 'bandpass', cutoff: 4600, q: 2.4, jitterCutoff: 0.2 },
    ],
    gain: 0.45, drive: 1.6, pitchJitter: 0.16, reverb: 0.45, priority: 0, maxConcurrent: 3,
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // HIT CONFIRMATION. Flat and player-local, deliberately layered ON TOP of the spatial flesh
  // sound the enemy system already fires: the world says "something was hit over there", this
  // says "and it was YOU that did it". That stack is why hits in shooters feel connected.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'hitmark',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.0004, decay: 0.018, gain: 0.4,
        filter: 'highpass', cutoff: 3600, q: 0.7, jitterCutoff: 0.1, spread: 0 },
      { kind: 'osc', wave: 'square', freq: 1480, attack: 0.0006, decay: 0.028, gain: 0.26,
        filter: 'lowpass', cutoff: 6000, q: 0.8, jitterFreq: 0.03, spread: 0.1 },
      // A trace of low end. A hitmarker with nothing under 1 kHz reads as a UI beep; four
      // hundredths of a second of 190 Hz reads as contact.
      { kind: 'osc', wave: 'sine', freq: 190, freqEnd: 120, sweep: 0.03,
        attack: 0.0008, decay: 0.04, gain: 0.22, spread: 0 },
    ],
    gain: 0.5, drive: 1.3, pitchJitter: 0.03, width: 1,
    variants: [{ pitch: 1 }, { pitch: 1.05, cutoff: 1.1 }, { pitch: 0.95, cutoff: 0.92 }],
    spatial: false, reverb: 0.05, priority: 2, maxConcurrent: 4, minInterval: 0.02,
  },
  /**
   * THE CRIT TICK. A reward, so it is built like one: the hitmarker tick, then a rising perfect
   * fourth on top of it. Rising = good, falling = bad, and every player already knows that.
   */
  {
    id: 'hitmark_crit',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.0004, decay: 0.02, gain: 0.5,
        filter: 'highpass', cutoff: 4200, q: 0.7, spread: 0 },
      { kind: 'osc', wave: 'triangle', freq: 2093, freqEnd: 2217, sweep: 0.018,
        attack: 0.0008, decay: 0.06, gain: 0.34, spread: -0.2 },
      { kind: 'osc', wave: 'sine', freq: 2794, delay: 0.035,
        attack: 0.001, decay: 0.11, gain: 0.32, spread: 0.24 },
      { kind: 'osc', wave: 'sine', freq: 220, freqEnd: 120, sweep: 0.05,
        attack: 0.001, decay: 0.07, gain: 0.3, spread: 0 },
      { kind: 'noise', noise: 'crackle', attack: 0.0004, decay: 0.03, gain: 0.3,
        filter: 'highpass', cutoff: 5200, q: 0.8, rate: 1.5, jitterCutoff: 0.12, spread: 0.4 },
    ],
    gain: 0.62, drive: 1.5, pitchJitter: 0.012, width: 1,
    spatial: false, reverb: 0.22, priority: 3, maxConcurrent: 3,
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // ═══ THE KILL ═══════════════════════════════════════════════════════════════════════════
  //
  // THIS IS THE SOUND THE PLAYER IS FARMING. Everything else in the mix exists to make room for
  // it. It is played at a pitch taken from `MIX.killLadder` — one scale degree per kill in the
  // chain — so a streak is a rising musical phrase and a broken streak audibly falls back to
  // the tonic. That single mechanic is worth more retention than any particle effect.
  //
  // Six layers: a bright transient so it cuts through gunfire, the two chime tones that carry
  // the ladder, a sub that lands the weight, a wide sparkle and a short wet tail. It is the
  // only sound in the game with `reverb` above 0.3 AND a sub — it is allowed to be the biggest
  // thing in the mix for 200 ms because that is the entire point of it.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'kill_confirm',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.0005, decay: 0.028, gain: 0.34,
        filter: 'bandpass', cutoff: 3400, cutoffEnd: 1400, q: 0.9, jitterCutoff: 0.1, spread: 0 },
      { kind: 'osc', wave: 'sine', freq: 523.3, attack: 0.002, decay: 0.13, gain: 0.36,
        spread: -0.22 },
      { kind: 'osc', wave: 'triangle', freq: 698.5, delay: 0.055,
        attack: 0.002, decay: 0.22, gain: 0.34, spread: 0.26 },
      { kind: 'osc', wave: 'sine', freq: 96, freqEnd: 44, sweep: 0.1,
        attack: 0.002, decay: 0.16, gain: 0.5, spread: 0 },
      { kind: 'osc', wave: 'sine', freq: 1046.5, delay: 0.055,
        attack: 0.003, decay: 0.26, gain: 0.16, spread: 0.5 },
      { kind: 'noise', noise: 'white', delay: 0.055, attack: 0.006, decay: 0.22, gain: 0.09,
        filter: 'highpass', cutoff: 6000, q: 0.7, spread: -0.55 },
    ],
    gain: 0.66, drive: 2.0, pitchJitter: 0.015, width: 1,
    spatial: false, reverb: 0.3, priority: 3, maxConcurrent: 3,
  },
  /**
   * ═══ THE CRIT KILL — the single best sound in the game. ═══════════════════════════════════
   *
   * A headshot kill is the highest-skill outcome the player can produce, so it gets the one
   * sound that is unambiguously better than everything else, and it is built on ONE idea:
   *
   *   THE CRACK BENDS UP.
   *
   * Every other impact in this game falls — that is what an impact does, and `zombie_crit`,
   * `impact_flesh` and the gun all sweep downward. This one, alone, bends UPWARD (1720 → 2380 Hz
   * in eighteen milliseconds) and it is therefore audible as *different in kind* even underneath
   * four other zombies being shot. The rise is short enough to read as a snap rather than a
   * siren; that eighteen milliseconds is the whole design.
   *
   * Under it: a bone snap, a fifth above the kill tone, a hard sub, a wide sparkle and a wet
   * tail. Pitch jitter is almost zero — a signature that wobbles is not a signature.
   */
  {
    id: 'kill_crit',
    layers: [
      { kind: 'osc', wave: 'triangle', freq: 1720, freqEnd: 2380, sweep: 0.018,
        attack: 0.0006, decay: 0.075, gain: 0.5, spread: 0 },
      { kind: 'noise', noise: 'crackle', attack: 0.0004, decay: 0.035, gain: 0.62,
        filter: 'highpass', cutoff: 4400, q: 0.9, rate: 1.7, jitterCutoff: 0.1, spread: 0.18 },
      { kind: 'osc', wave: 'sine', freq: 784, freqEnd: 1046.5, sweep: 0.04, delay: 0.018,
        attack: 0.002, decay: 0.24, gain: 0.4, spread: -0.3 },
      { kind: 'osc', wave: 'sine', freq: 128, freqEnd: 46, sweep: 0.11,
        attack: 0.0015, decay: 0.2, gain: 0.66, spread: 0 },
      { kind: 'osc', wave: 'sine', freq: 2093, delay: 0.055,
        attack: 0.003, decay: 0.34, gain: 0.2, spread: 0.62 },
      { kind: 'noise', noise: 'white', delay: 0.04, attack: 0.008, decay: 0.3, gain: 0.11,
        filter: 'highpass', cutoff: 6800, q: 0.7, spread: -0.66 },
    ],
    gain: 0.82, drive: 2.3, pitchJitter: 0.008, width: 1,
    spatial: false, reverb: 0.4, priority: 3, maxConcurrent: 3,
  },
  /**
   * THE TIER RISER — ×1→×2→×3→×4→×5. A separate event from a kill, so it gets a separate
   * SHAPE: a fast upward sweep with a chime landing on top of it, one perfect fifth higher per
   * tier. You cannot mistake it for a kill confirm, which is exactly why it works as escalation.
   */
  {
    id: 'combo_up',
    layers: [
      { kind: 'osc', wave: 'sawtooth', freq: 330, freqEnd: 990, sweep: 0.13,
        attack: 0.004, decay: 0.14, gain: 0.34,
        filter: 'lowpass', cutoff: 900, cutoffEnd: 4200, q: 3.0, spread: -0.3 },
      { kind: 'osc', wave: 'triangle', freq: 1318.5, delay: 0.12,
        attack: 0.002, decay: 0.28, gain: 0.36, spread: 0.3 },
      { kind: 'osc', wave: 'sine', freq: 1975.5, delay: 0.14,
        attack: 0.003, decay: 0.34, gain: 0.2, spread: -0.5 },
      { kind: 'noise', noise: 'white', delay: 0.12, attack: 0.004, decay: 0.24, gain: 0.13,
        filter: 'highpass', cutoff: 6000, q: 0.7, spread: 0.6 },
      { kind: 'osc', wave: 'sine', freq: 110, freqEnd: 55, sweep: 0.16, delay: 0.12,
        attack: 0.003, decay: 0.2, gain: 0.4, spread: 0 },
    ],
    gain: 0.62, drive: 1.6, pitchJitter: 0.004, width: 1,
    spatial: false, reverb: 0.42, priority: 3, maxConcurrent: 2,
  },
  /**
   * THE BREAK. The mirror image of the riser and the only descending reward sound in the game:
   * a minor third DOWN, dry, short, and quiet enough to be a loss rather than a punishment.
   * It only ever plays for a chain worth mourning (`MIX.comboBreakMin`).
   */
  {
    id: 'combo_break',
    layers: [
      { kind: 'osc', wave: 'triangle', freq: 622.3, freqEnd: 523.3, sweep: 0.1,
        attack: 0.003, decay: 0.16, gain: 0.28, spread: -0.2 },
      { kind: 'osc', wave: 'sine', freq: 415.3, freqEnd: 311.1, sweep: 0.14, delay: 0.06,
        attack: 0.004, decay: 0.22, gain: 0.24, spread: 0.24 },
      { kind: 'noise', noise: 'brown', attack: 0.004, decay: 0.16, gain: 0.16,
        filter: 'lowpass', cutoff: 900, cutoffEnd: 320, q: 0.8, spread: 0 },
    ],
    gain: 0.44, drive: 1.3, pitchJitter: 0.006, width: 1,
    spatial: false, reverb: 0.24, priority: 2, maxConcurrent: 1,
  },
  {
    id: 'dismember',
    layers: [
      { kind: 'noise', noise: GRIT, attack: 0.004, decay: 0.28, gain: 0.7,
        filter: 'bandpass', cutoff: 900, cutoffEnd: 300, q: 1.4,
        rate: 1.3, rateEnd: 0.6, sweep: 0.3, jitterCutoff: 0.2 },
      { kind: 'noise', noise: 'crackle', attack: 0.001, decay: 0.09, gain: 0.6,
        filter: 'lowpass', cutoff: 1800, cutoffEnd: 500, q: 1.0, jitterCutoff: 0.18 },
      { kind: 'osc', wave: 'sine', freq: 130, freqEnd: 40, sweep: 0.16,
        attack: 0.002, decay: 0.22, gain: 0.55, jitterFreq: 0.12 },
    ],
    gain: 0.85, drive: 3.2, pitchJitter: 0.14, reverb: 0.28, priority: 3, maxConcurrent: 3,
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // ZOMBIES. All six are built on `grit` — the reserved rasp texture (see the header). They are
  // spatialised, heavily pitch-jittered (the enemy system also passes a stable per-body pitch,
  // so every zombie has a consistent *voice* and every utterance is still unique) and rate
  // limited, because 25 bodies can all decide to groan on the same tick.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'zombie_groan',
    layers: [
      { kind: 'noise', noise: GRIT, attack: 0.06, decay: 0.5, gain: 0.7,
        filter: 'bandpass', cutoff: 270, cutoffEnd: 190, q: 5.5,
        rate: 0.85, jitterCutoff: 0.22, jitterFreq: 0.16 },
      { kind: 'osc', wave: 'sawtooth', freq: 78, freqEnd: 62, sweep: 0.55,
        attack: 0.07, decay: 0.5, gain: 0.42,
        filter: 'lowpass', cutoff: 420, cutoffEnd: 230, q: 2.0, jitterFreq: 0.13 },
      { kind: 'noise', noise: GRIT, delay: 0.1, attack: 0.09, decay: 0.42, gain: 0.3,
        filter: 'bandpass', cutoff: 640, cutoffEnd: 380, q: 3.0,
        rate: 0.6, jitterCutoff: 0.25 },
    ],
    gain: 0.62, drive: 2.6, pitchJitter: 0.17,
    // THREE THROATS. The enemy system already passes a stable per-body pitch, so a zombie has a
    // consistent voice; these takes make sure two zombies with the SAME body pitch still do not
    // utter the same sound back to back. Wet/dry and throat size, not just pitch.
    variants: [
      { pitch: 1, gain: 1, cutoff: 1 },
      { pitch: 0.88, gain: 1.06, cutoff: 0.8 },
      { pitch: 1.14, gain: 0.9, cutoff: 1.26 },
    ],
    crowd: true, reverb: 0.34, priority: 1, maxConcurrent: 5, minInterval: 0.07,
  },
  /**
   * THE TELL. GAME_BIBLE wants a wind-up you can slide out of, so this sound is designed to be
   * unmistakable: it RISES (everything else a zombie does falls), it is brighter than the groan
   * and it is the loudest thing a zombie can do. 0.42 s later the swing lands.
   */
  {
    id: 'zombie_windup',
    layers: [
      { kind: 'noise', noise: GRIT, attack: 0.11, decay: 0.26, gain: 0.85,
        filter: 'bandpass', cutoff: 320, cutoffEnd: 980, q: 3.5,
        rate: 0.9, rateEnd: 1.35, sweep: 0.3, jitterCutoff: 0.16, jitterFreq: 0.12 },
      { kind: 'osc', wave: 'sawtooth', freq: 92, freqEnd: 158, sweep: 0.3,
        attack: 0.09, decay: 0.24, gain: 0.44,
        filter: 'lowpass', cutoff: 520, cutoffEnd: 1100, q: 2.4, jitterFreq: 0.1 },
      { kind: 'noise', noise: 'brown', delay: 0.02, attack: 0.12, decay: 0.22, gain: 0.24,
        filter: 'bandpass', cutoff: 1400, cutoffEnd: 2600, q: 1.0 },
    ],
    gain: 0.9, drive: 2.8, pitchJitter: 0.12,
    crowd: true, reverb: 0.26, priority: 3, maxConcurrent: 6, minInterval: 0.02,
  },
  {
    id: 'zombie_swing',
    layers: [
      { kind: 'noise', noise: 'brown', attack: 0.03, decay: 0.15, gain: 0.85,
        filter: 'bandpass', cutoff: 1800, cutoffEnd: 320, q: 1.1,
        rate: 1.5, rateEnd: 0.7, sweep: 0.18, jitterCutoff: 0.16 },
      { kind: 'noise', noise: GRIT, delay: 0.02, attack: 0.02, decay: 0.12, gain: 0.3,
        filter: 'bandpass', cutoff: 520, q: 2.5, rate: 1.1, jitterCutoff: 0.2 },
      { kind: 'osc', wave: 'sine', freq: 150, freqEnd: 70, sweep: 0.14,
        attack: 0.02, decay: 0.14, gain: 0.3 },
    ],
    gain: 0.72, drive: 2.2, pitchJitter: 0.13,
    crowd: true, reverb: 0.22, priority: 2, maxConcurrent: 4, minInterval: 0.03,
  },
  {
    id: 'zombie_flesh',
    layers: [
      { kind: 'noise', noise: 'crackle', attack: 0.0006, decay: 0.04, gain: 0.8,
        filter: 'lowpass', cutoff: 1500, cutoffEnd: 400, q: 1.2, jitterCutoff: 0.2 },
      { kind: 'osc', wave: 'sine', freq: 175, freqEnd: 50, sweep: 0.06,
        attack: 0.001, decay: 0.1, gain: 0.62, jitterFreq: 0.15 },
      { kind: 'noise', noise: GRIT, delay: 0.012, attack: 0.01, decay: 0.13, gain: 0.34,
        filter: 'bandpass', cutoff: 480, cutoffEnd: 260, q: 3.0, rate: 1.1, jitterCutoff: 0.22 },
      { kind: 'noise', noise: 'brown', delay: 0.006, attack: 0.004, decay: 0.1, gain: 0.26,
        filter: 'lowpass', cutoff: 700, q: 0.8 },
    ],
    gain: 0.8, drive: 3.2, pitchJitter: 0.15,
    variants: [
      { pitch: 1, cutoff: 1 },
      { pitch: 1.09, gain: 0.95, cutoff: 1.2 },
      { pitch: 0.9, gain: 1.05, cutoff: 0.84 },
      { pitch: 1.03, gain: 0.99, cutoff: 0.96 },
    ],
    reverb: 0.18, priority: 2, maxConcurrent: 6, minInterval: 0.02,
  },
  /**
   * THE CRIT SPLAT. Distinct from `zombie_flesh` in three ways at once — a hard bone SNAP above
   * 3 kHz, a deeper and wetter body, and a short bright ring — so a headshot is audible even
   * with six other zombies being shot in the same second.
   */
  {
    id: 'zombie_crit',
    layers: [
      { kind: 'noise', noise: 'crackle', attack: 0.0004, decay: 0.035, gain: 1.0,
        filter: 'highpass', cutoff: 3000, q: 0.9, rate: 1.5, jitterCutoff: 0.14 },
      { kind: 'osc', wave: 'sine', freq: 210, freqEnd: 38, sweep: 0.09,
        attack: 0.001, decay: 0.17, gain: 0.85, jitterFreq: 0.12 },
      { kind: 'noise', noise: 'crackle', delay: 0.008, attack: 0.002, decay: 0.14, gain: 0.55,
        filter: 'bandpass', cutoff: 1200, cutoffEnd: 400, q: 0.9, rate: 0.75, jitterCutoff: 0.18 },
      { kind: 'osc', wave: 'triangle', freq: 1650, freqEnd: 900, sweep: 0.07,
        attack: 0.0008, decay: 0.09, gain: 0.3, jitterFreq: 0.14 },
    ],
    gain: 0.95, drive: 3.8, pitchJitter: 0.11,
    variants: [
      { pitch: 1, cutoff: 1 },
      { pitch: 1.06, gain: 0.97, cutoff: 1.15 },
      { pitch: 0.94, gain: 1.04, cutoff: 0.88 },
    ],
    reverb: 0.3, priority: 3, maxConcurrent: 4,
  },
  {
    id: 'zombie_death',
    layers: [
      { kind: 'noise', noise: GRIT, attack: 0.03, decay: 0.75, gain: 0.8,
        filter: 'bandpass', cutoff: 420, cutoffEnd: 140, q: 4.0,
        rate: 1.0, rateEnd: 0.55, sweep: 0.7, jitterCutoff: 0.2, jitterFreq: 0.14 },
      { kind: 'osc', wave: 'sawtooth', freq: 112, freqEnd: 36, sweep: 0.8,
        attack: 0.02, decay: 0.8, gain: 0.5,
        filter: 'lowpass', cutoff: 520, cutoffEnd: 180, q: 2.2, jitterFreq: 0.12 },
      { kind: 'noise', noise: 'brown', delay: 0.34, attack: 0.004, decay: 0.24, gain: 0.5,
        filter: 'lowpass', cutoff: 620, cutoffEnd: 220, q: 0.8, jitterCutoff: 0.16 },
      { kind: 'osc', wave: 'sine', freq: 78, freqEnd: 34, sweep: 0.2, delay: 0.34,
        attack: 0.003, decay: 0.26, gain: 0.45 },
    ],
    gain: 0.85, drive: 2.8, pitchJitter: 0.13,
    reverb: 0.4, priority: 3, maxConcurrent: 4,
  },
  {
    id: 'zombie_spawn',
    layers: [
      { kind: 'noise', noise: GRIT, attack: 0.14, decay: 0.5, gain: 0.55,
        filter: 'bandpass', cutoff: 200, cutoffEnd: 560, q: 4.0,
        rate: 0.7, rateEnd: 1.0, sweep: 0.5, jitterCutoff: 0.2 },
      { kind: 'osc', wave: 'sawtooth', freq: 44, freqEnd: 88, sweep: 0.5,
        attack: 0.12, decay: 0.55, gain: 0.4,
        filter: 'lowpass', cutoff: 300, cutoffEnd: 700, q: 2.0 },
    ],
    gain: 0.55, drive: 2.4, pitchJitter: 0.15,
    crowd: true, reverb: 0.45, priority: 1, maxConcurrent: 3, minInterval: 0.08,
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // FOOTSTEPS. Flat, because they are the player's own feet. One per `SurfaceKind`; sprinting
  // is not "the same step, louder" — it also gains `step_scuff`, so the timbre changes, which is
  // what actually reads as effort.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'step_concrete',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.001, decay: 0.042, gain: 0.55,
        filter: 'bandpass', cutoff: 1250, cutoffEnd: 620, q: 1.3,
        jitterCutoff: 0.22, jitterGain: 0.18 },
      { kind: 'osc', wave: 'sine', freq: 72, freqEnd: 44, sweep: 0.05,
        attack: 0.002, decay: 0.07, gain: 0.3, jitterFreq: 0.12 },
    ],
    gain: 0.34, drive: 1.7, pitchJitter: 0.13,
    // FOUR FEET, not one. A footstep is the most-repeated sound a player hears and the fastest
    // way to make a game feel cheap; four takes that alternate heel/toe weight and brightness
    // cost four lines and are the difference between walking and a metronome.
    variants: [
      { pitch: 1, gain: 1, cutoff: 1 },
      { pitch: 1.07, gain: 0.86, cutoff: 1.18 },
      { pitch: 0.92, gain: 1.08, cutoff: 0.84 },
      { pitch: 1.02, gain: 0.94, cutoff: 1.05 },
    ],
    spatial: false, reverb: 0.22, priority: 0, maxConcurrent: 3,
  },
  {
    id: 'step_metal',
    layers: [
      { kind: 'noise', noise: 'metal', attack: 0.0008, decay: 0.09, gain: 0.5,
        filter: 'bandpass', cutoff: 2600, q: 2.2, jitterCutoff: 0.22, jitterFreq: 0.15 },
      { kind: 'osc', wave: 'sine', freq: 110, freqEnd: 60, sweep: 0.05,
        attack: 0.002, decay: 0.08, gain: 0.28, jitterFreq: 0.12 },
    ],
    gain: 0.32, drive: 1.6, pitchJitter: 0.13,
    variants: [
      { pitch: 1, gain: 1, cutoff: 1 },
      { pitch: 1.07, gain: 0.86, cutoff: 1.18 },
      { pitch: 0.92, gain: 1.08, cutoff: 0.84 },
      { pitch: 1.02, gain: 0.94, cutoff: 1.05 },
    ],
    spatial: false, reverb: 0.3, priority: 0, maxConcurrent: 3,
  },
  {
    id: 'step_wood',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.001, decay: 0.035, gain: 0.45,
        filter: 'bandpass', cutoff: 720, q: 3.2, jitterCutoff: 0.2 },
      { kind: 'osc', wave: 'square', freq: 190, freqEnd: 118, sweep: 0.04,
        attack: 0.002, decay: 0.075, gain: 0.34,
        filter: 'lowpass', cutoff: 1000, q: 2.2, jitterFreq: 0.13 },
    ],
    gain: 0.36, drive: 1.8, pitchJitter: 0.13,
    variants: [
      { pitch: 1, gain: 1, cutoff: 1 },
      { pitch: 1.07, gain: 0.86, cutoff: 1.18 },
      { pitch: 0.92, gain: 1.08, cutoff: 0.84 },
      { pitch: 1.02, gain: 0.94, cutoff: 1.05 },
    ],
    spatial: false, reverb: 0.2, priority: 0, maxConcurrent: 3,
  },
  {
    id: 'step_glass',
    layers: [
      { kind: 'noise', noise: 'crackle', attack: 0.0008, decay: 0.1, gain: 0.55,
        filter: 'highpass', cutoff: 3400, q: 0.8, rate: 1.2, jitterCutoff: 0.2 },
      { kind: 'osc', wave: 'sine', freq: 88, freqEnd: 52, sweep: 0.05,
        attack: 0.002, decay: 0.06, gain: 0.22 },
    ],
    gain: 0.32, drive: 1.5, pitchJitter: 0.14,
    variants: [
      { pitch: 1, gain: 1, cutoff: 1 },
      { pitch: 1.07, gain: 0.86, cutoff: 1.18 },
      { pitch: 0.92, gain: 1.08, cutoff: 0.84 },
      { pitch: 1.02, gain: 0.94, cutoff: 1.05 },
    ],
    spatial: false, reverb: 0.26, priority: 0, maxConcurrent: 3,
  },
  {
    id: 'step_dirt',
    layers: [
      { kind: 'noise', noise: 'brown', attack: 0.001, decay: 0.06, gain: 0.6,
        filter: 'lowpass', cutoff: 950, cutoffEnd: 400, q: 0.8, jitterCutoff: 0.2 },
      { kind: 'noise', noise: 'crackle', delay: 0.004, attack: 0.003, decay: 0.07, gain: 0.22,
        filter: 'bandpass', cutoff: 1500, q: 0.9, rate: 0.7, jitterCutoff: 0.22 },
    ],
    gain: 0.34, drive: 1.5, pitchJitter: 0.13,
    variants: [
      { pitch: 1, gain: 1, cutoff: 1 },
      { pitch: 1.07, gain: 0.86, cutoff: 1.18 },
      { pitch: 0.92, gain: 1.08, cutoff: 0.84 },
      { pitch: 1.02, gain: 0.94, cutoff: 1.05 },
    ],
    spatial: false, reverb: 0.14, priority: 0, maxConcurrent: 3,
  },
  {
    id: 'step_flesh',
    layers: [
      { kind: 'noise', noise: 'crackle', attack: 0.001, decay: 0.05, gain: 0.5,
        filter: 'lowpass', cutoff: 800, cutoffEnd: 300, q: 1.1, jitterCutoff: 0.2 },
      { kind: 'osc', wave: 'sine', freq: 96, freqEnd: 46, sweep: 0.05,
        attack: 0.002, decay: 0.08, gain: 0.34, jitterFreq: 0.12 },
    ],
    gain: 0.36, drive: 2.2, pitchJitter: 0.14,
    variants: [
      { pitch: 1, gain: 1, cutoff: 1 },
      { pitch: 1.07, gain: 0.86, cutoff: 1.18 },
      { pitch: 0.92, gain: 1.08, cutoff: 0.84 },
      { pitch: 1.02, gain: 0.94, cutoff: 1.05 },
    ],
    spatial: false, reverb: 0.12, priority: 0, maxConcurrent: 3,
  },
  {
    id: 'step_scuff',
    layers: [
      { kind: 'noise', noise: 'brown', attack: 0.004, decay: 0.085, gain: 0.5,
        filter: 'bandpass', cutoff: 2300, cutoffEnd: 1100, q: 1.0,
        rate: 1.4, rateEnd: 0.9, sweep: 0.09, jitterCutoff: 0.22 },
    ],
    gain: 0.5, drive: 1.4, pitchJitter: 0.16,
    variants: [
      { pitch: 1, gain: 1, cutoff: 1 },
      { pitch: 1.07, gain: 0.86, cutoff: 1.18 },
      { pitch: 0.92, gain: 1.08, cutoff: 0.84 },
      { pitch: 1.02, gain: 0.94, cutoff: 1.05 },
    ],
    spatial: false, reverb: 0.18, priority: 0, maxConcurrent: 3,
  },
  {
    id: 'land_soft',
    layers: [
      { kind: 'noise', noise: 'brown', attack: 0.001, decay: 0.09, gain: 0.7,
        filter: 'lowpass', cutoff: 620, cutoffEnd: 240, q: 0.8, jitterCutoff: 0.15 },
      { kind: 'osc', wave: 'sine', freq: 66, freqEnd: 38, sweep: 0.09,
        attack: 0.002, decay: 0.12, gain: 0.5, jitterFreq: 0.1 },
    ],
    gain: 0.5, drive: 1.8, pitchJitter: 0.1,
    spatial: false, reverb: 0.22, priority: 1,
  },
  {
    id: 'land_hard',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.0008, decay: 0.05, gain: 0.7,
        filter: 'bandpass', cutoff: 1500, cutoffEnd: 480, q: 0.9, jitterCutoff: 0.15 },
      { kind: 'noise', noise: 'brown', attack: 0.002, decay: 0.18, gain: 0.8,
        filter: 'lowpass', cutoff: 520, cutoffEnd: 200, q: 0.8 },
      { kind: 'osc', wave: 'sine', freq: 78, freqEnd: 32, sweep: 0.14,
        attack: 0.002, decay: 0.22, gain: 0.85, jitterFreq: 0.09 },
      { kind: 'noise', noise: GRIT, delay: 0.03, attack: 0.02, decay: 0.16, gain: 0.16,
        filter: 'bandpass', cutoff: 330, q: 3.0, rate: 1.4 },
    ],
    gain: 0.72, drive: 3.0, pitchJitter: 0.09,
    spatial: false, reverb: 0.3, priority: 2,
  },
  {
    id: 'slide_start',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.02, decay: 0.1, sustain: 0.55, hold: 0.16,
        release: 0.3, gain: 0.6,
        filter: 'bandpass', cutoff: 2000, cutoffEnd: 700, q: 1.2, sweep: 0.55,
        jitterCutoff: 0.14 },
      { kind: 'noise', noise: 'brown', attack: 0.02, decay: 0.12, sustain: 0.5, hold: 0.16,
        release: 0.3, gain: 0.4,
        filter: 'lowpass', cutoff: 900, cutoffEnd: 320, q: 0.9, sweep: 0.55 },
      { kind: 'osc', wave: 'sine', freq: 92, freqEnd: 52, sweep: 0.4,
        attack: 0.01, decay: 0.3, gain: 0.35 },
    ],
    gain: 0.5, drive: 2.0, pitchJitter: 0.09,
    spatial: false, reverb: 0.26, priority: 2, maxConcurrent: 2,
  },
  {
    id: 'dive_whoosh',
    layers: [
      { kind: 'noise', noise: 'pink', attack: 0.04, decay: 0.28, gain: 0.7,
        filter: 'bandpass', cutoff: 420, cutoffEnd: 1900, q: 1.1, sweep: 0.22,
        rate: 0.8, rateEnd: 1.5, jitterCutoff: 0.14 },
      { kind: 'osc', wave: 'sine', freq: 130, freqEnd: 58, sweep: 0.3,
        attack: 0.02, decay: 0.3, gain: 0.3 },
    ],
    gain: 0.5, drive: 1.6, pitchJitter: 0.1,
    spatial: false, reverb: 0.28, priority: 2, maxConcurrent: 2,
  },
  {
    id: 'jump',
    layers: [
      { kind: 'noise', noise: 'brown', attack: 0.003, decay: 0.07, gain: 0.4,
        filter: 'bandpass', cutoff: 1400, cutoffEnd: 700, q: 0.9, jitterCutoff: 0.18 },
      { kind: 'noise', noise: GRIT, delay: 0.01, attack: 0.02, decay: 0.1, gain: 0.14,
        filter: 'bandpass', cutoff: 380, q: 3.5, rate: 1.6, jitterFreq: 0.1 },
    ],
    gain: 0.6, drive: 1.6, pitchJitter: 0.12,
    spatial: false, reverb: 0.15, priority: 0, maxConcurrent: 2,
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE PLAYER'S OWN STATE. All flat, all with more low end than anything else in the mix, so
  // "I am being hurt" cuts through a firefight without being loud.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'player_hurt',
    layers: [
      { kind: 'noise', noise: 'brown', attack: 0.001, decay: 0.13, gain: 0.8,
        filter: 'lowpass', cutoff: 700, cutoffEnd: 220, q: 0.9, jitterCutoff: 0.14 },
      { kind: 'osc', wave: 'sawtooth', freq: 340, freqEnd: 150, sweep: 0.1,
        attack: 0.001, decay: 0.16, gain: 0.45,
        filter: 'lowpass', cutoff: 1200, cutoffEnd: 400, q: 1.6, jitterFreq: 0.1 },
      { kind: 'osc', wave: 'sine', freq: 88, freqEnd: 40, sweep: 0.18,
        attack: 0.002, decay: 0.26, gain: 0.7 },
    ],
    gain: 0.78, drive: 3.6, pitchJitter: 0.12,
    spatial: false, reverb: 0.2, priority: 3, maxConcurrent: 2,
  },
  {
    id: 'player_down',
    layers: [
      { kind: 'osc', wave: 'sawtooth', freq: 180, freqEnd: 28, sweep: 1.1,
        attack: 0.01, decay: 1.2, gain: 0.6,
        filter: 'lowpass', cutoff: 900, cutoffEnd: 160, q: 2.4 },
      { kind: 'noise', noise: 'brown', attack: 0.02, decay: 1.0, gain: 0.5,
        filter: 'lowpass', cutoff: 500, cutoffEnd: 140, q: 0.8 },
      { kind: 'noise', noise: GRIT, delay: 0.05, attack: 0.08, decay: 0.7, gain: 0.3,
        filter: 'bandpass', cutoff: 300, cutoffEnd: 150, q: 3.0, rate: 0.9 },
    ],
    gain: 0.85, drive: 2.6, pitchJitter: 0.03,
    spatial: false, reverb: 0.5, priority: 3, maxConcurrent: 1,
  },
  {
    id: 'revive',
    layers: [
      { kind: 'osc', wave: 'sine', freq: 392, freqEnd: 784, sweep: 0.4,
        attack: 0.02, decay: 0.5, gain: 0.45 },
      { kind: 'osc', wave: 'triangle', freq: 587.3, delay: 0.1, attack: 0.01, decay: 0.55, gain: 0.35 },
      { kind: 'noise', noise: 'white', delay: 0.1, attack: 0.05, decay: 0.45, gain: 0.12,
        filter: 'highpass', cutoff: 4200, q: 0.7 },
    ],
    gain: 0.72, drive: 1.4, pitchJitter: 0.006,
    spatial: false, reverb: 0.5, priority: 3, maxConcurrent: 1,
  },
  {
    id: 'death_sting',
    layers: [
      { kind: 'osc', wave: 'sawtooth', freq: 220, freqEnd: 27.5, sweep: 1.3,
        attack: 0.005, decay: 1.5, gain: 0.7,
        filter: 'lowpass', cutoff: 1400, cutoffEnd: 130, q: 3.0 },
      { kind: 'osc', wave: 'sawtooth', freq: 110, freqEnd: 26, sweep: 1.4,
        attack: 0.005, decay: 1.6, gain: 0.5,
        filter: 'lowpass', cutoff: 800, cutoffEnd: 110, q: 2.0 },
      { kind: 'noise', noise: 'brown', attack: 0.01, decay: 1.4, gain: 0.4,
        filter: 'lowpass', cutoff: 620, cutoffEnd: 120, q: 0.8 },
    ],
    gain: 0.9, drive: 3.0, pitchJitter: 0.004,
    spatial: false, reverb: 0.6, priority: 3, maxConcurrent: 1,
  },
  {
    id: 'heal_pulse',
    layers: [
      { kind: 'osc', wave: 'sine', freq: 659.3, attack: 0.01, decay: 0.2, gain: 0.24 },
      { kind: 'osc', wave: 'sine', freq: 987.8, delay: 0.06, attack: 0.01, decay: 0.24, gain: 0.18 },
    ],
    gain: 0.42, drive: 1, pitchJitter: 0.01,
    spatial: false, reverb: 0.3, priority: 1, maxConcurrent: 2, minInterval: 0.25,
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // ROUNDS, ECONOMY, UI. M3 owns the systems; the sounds exist now so nothing lands silent.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  /**
   * ROUND START. A threat, not a fanfare: a rising filtered saw under a minor-third stab, with
   * a drum hit on the downbeat and a rasp swell so you hear the horde arrive rather than being
   * told about it. It is the only cue in the game with the reserved `grit` texture on a flat
   * voice — the horde is briefly INSIDE your head, and then it is out there.
   */
  {
    id: 'round_start',
    layers: [
      { kind: 'osc', wave: 'sawtooth', freq: 65.4, freqEnd: 130.8, sweep: 0.5,
        attack: 0.02, decay: 0.9, gain: 0.55,
        filter: 'lowpass', cutoff: 700, cutoffEnd: 2200, q: 2.6, spread: 0 },
      { kind: 'osc', wave: 'square', freq: 196, delay: 0.14, attack: 0.008, decay: 0.4, gain: 0.32,
        filter: 'lowpass', cutoff: 2400, q: 1.4, spread: -0.35 },
      { kind: 'osc', wave: 'sawtooth', freq: 261.6, delay: 0.3, attack: 0.008, decay: 0.7, gain: 0.36,
        filter: 'lowpass', cutoff: 3000, q: 1.6, spread: 0.38 },
      { kind: 'osc', wave: 'sine', freq: 110, freqEnd: 38, sweep: 0.22, delay: 0.3,
        attack: 0.002, decay: 0.34, gain: 0.7, spread: 0 },
      { kind: 'noise', noise: GRIT, delay: 0.05, attack: 0.24, decay: 0.5, gain: 0.2,
        filter: 'bandpass', cutoff: 240, cutoffEnd: 720, q: 3.5, rate: 0.7, sweep: 0.6,
        spread: -0.7 },
      { kind: 'noise', noise: 'white', delay: 0.3, attack: 0.004, decay: 0.5, gain: 0.18,
        filter: 'bandpass', cutoff: 3400, cutoffEnd: 1200, q: 0.8, spread: 0.66 },
    ],
    gain: 0.85, drive: 2.6, pitchJitter: 0.004, width: 1,
    spatial: false, reverb: 0.55, priority: 3, maxConcurrent: 1,
  },
  /** ROUND CLEAR. A major triad that resolves upward and a soft sub landing — you survived. */
  {
    id: 'round_clear',
    layers: [
      { kind: 'osc', wave: 'triangle', freq: 523.3, attack: 0.008, decay: 0.35, gain: 0.4,
        spread: -0.3 },
      { kind: 'osc', wave: 'triangle', freq: 784, delay: 0.11, attack: 0.008, decay: 0.45, gain: 0.38,
        spread: 0.32 },
      { kind: 'osc', wave: 'sine', freq: 1046.5, delay: 0.22, attack: 0.008, decay: 0.7, gain: 0.36,
        spread: -0.5 },
      { kind: 'osc', wave: 'sine', freq: 1568, delay: 0.33, attack: 0.01, decay: 0.85, gain: 0.18,
        spread: 0.55 },
      { kind: 'osc', wave: 'sine', freq: 130.8, freqEnd: 65.4, sweep: 0.3,
        attack: 0.006, decay: 0.4, gain: 0.42, spread: 0 },
      { kind: 'noise', noise: 'white', delay: 0.22, attack: 0.03, decay: 0.6, gain: 0.12,
        filter: 'highpass', cutoff: 5000, q: 0.7, spread: -0.62 },
    ],
    gain: 0.78, drive: 1.4, pitchJitter: 0.004, width: 1,
    spatial: false, reverb: 0.55, priority: 3, maxConcurrent: 1,
  },
  /** INTERMISSION. Breath. Two quiet notes falling and a long wet tail — the street exhaling. */
  {
    id: 'round_break',
    layers: [
      { kind: 'osc', wave: 'sine', freq: 587.3, attack: 0.03, decay: 0.6, gain: 0.24,
        spread: -0.3 },
      { kind: 'osc', wave: 'sine', freq: 392, delay: 0.2, attack: 0.03, decay: 0.9, gain: 0.22,
        spread: 0.3 },
      { kind: 'noise', noise: 'pink', attack: 0.14, decay: 0.7, gain: 0.09,
        filter: 'bandpass', cutoff: 900, cutoffEnd: 380, q: 0.8, spread: 0 },
    ],
    gain: 0.5, drive: 1.1, pitchJitter: 0.004, width: 1,
    spatial: false, reverb: 0.6, priority: 2, maxConcurrent: 1,
  },
  /** THE RUN BEGINS. One hit, one riser, one breath in. Plays once, on `game:started`. */
  {
    id: 'game_start',
    layers: [
      { kind: 'noise', noise: 'brown', attack: 0.002, decay: 0.4, gain: 0.7,
        filter: 'lowpass', cutoff: 900, cutoffEnd: 220, q: 0.9, spread: 0 },
      { kind: 'osc', wave: 'sine', freq: 98, freqEnd: 32, sweep: 0.4,
        attack: 0.002, decay: 0.55, gain: 0.8, spread: 0 },
      { kind: 'osc', wave: 'sawtooth', freq: 130.8, freqEnd: 523.3, sweep: 0.75,
        attack: 0.25, decay: 0.5, gain: 0.3,
        filter: 'lowpass', cutoff: 500, cutoffEnd: 3600, q: 3.2, spread: -0.4 },
      { kind: 'noise', noise: GRIT, delay: 0.1, attack: 0.4, decay: 0.55, gain: 0.16,
        filter: 'bandpass', cutoff: 220, cutoffEnd: 640, q: 3.0, rate: 0.65, sweep: 0.8,
        spread: 0.55 },
    ],
    gain: 0.8, drive: 2.4, pitchJitter: 0.003, width: 1,
    spatial: false, reverb: 0.55, priority: 3, maxConcurrent: 1,
  },
  /**
   * GAME OVER. The run's obituary, and deliberately NOT `death_sting` — that one is the moment
   * of dying, this one is the moment of reading the number. A tritone collapsing to a unison
   * over a second and a half, and then the room.
   */
  {
    id: 'game_over',
    layers: [
      { kind: 'osc', wave: 'sawtooth', freq: 174.6, freqEnd: 55, sweep: 1.4,
        attack: 0.02, decay: 1.5, gain: 0.5,
        filter: 'lowpass', cutoff: 1100, cutoffEnd: 150, q: 2.6, spread: -0.35 },
      { kind: 'osc', wave: 'sawtooth', freq: 246.9, freqEnd: 55, sweep: 1.5,
        attack: 0.02, decay: 1.6, gain: 0.42,
        filter: 'lowpass', cutoff: 900, cutoffEnd: 140, q: 2.2, spread: 0.38 },
      { kind: 'osc', wave: 'sine', freq: 55, freqEnd: 27.5, sweep: 1.6,
        attack: 0.05, decay: 1.8, gain: 0.6, spread: 0 },
      { kind: 'noise', noise: 'brown', attack: 0.03, decay: 1.6, gain: 0.34,
        filter: 'lowpass', cutoff: 560, cutoffEnd: 110, q: 0.8, spread: -0.6 },
      { kind: 'noise', noise: GRIT, delay: 0.25, attack: 0.3, decay: 1.1, gain: 0.18,
        filter: 'bandpass', cutoff: 300, cutoffEnd: 120, q: 3.5, rate: 0.8, rateEnd: 0.45,
        sweep: 1.2, spread: 0.62 },
    ],
    gain: 0.9, drive: 2.6, pitchJitter: 0.002, width: 1,
    spatial: false, reverb: 0.7, priority: 3, maxConcurrent: 1,
  },
  /**
   * The old per-kill tick. The kill confirm now carries the ladder itself (`MIX.killLadder`),
   * which is strictly better — one reward sound that rises beats two sounds that overlap. Kept
   * as a requestable id so `fx:sound` callers and `combo.ts`'s comment stay honest.
   */
  {
    id: 'combo_tick',
    layers: [
      { kind: 'osc', wave: 'triangle', freq: 880, attack: 0.001, decay: 0.07, gain: 0.24 },
      { kind: 'noise', noise: 'white', attack: 0.0005, decay: 0.02, gain: 0.1,
        filter: 'highpass', cutoff: 5000, q: 0.7 },
    ],
    gain: 0.4, drive: 1.2, pitchJitter: 0.01,
    spatial: false, reverb: 0.2, priority: 1, maxConcurrent: 3, minInterval: 0.03,
  },
  {
    id: 'card_deal',
    layers: [
      { kind: 'noise', noise: 'white', attack: 0.004, decay: 0.09, gain: 0.4,
        filter: 'bandpass', cutoff: 2600, cutoffEnd: 1300, q: 1.1,
        rate: 1.5, rateEnd: 0.9, sweep: 0.1, jitterCutoff: 0.18 },
      { kind: 'noise', noise: 'pink', delay: 0.02, attack: 0.01, decay: 0.1, gain: 0.22,
        filter: 'highpass', cutoff: 1800, q: 0.7 },
    ],
    gain: 0.45, drive: 1.3, pitchJitter: 0.12,
    spatial: false, reverb: 0.25, priority: 2, maxConcurrent: 4,
  },
  /**
   * THE DRAW. Fires once when the cards are offered, under the three `card_deal` whooshes: a
   * held open fifth that says "the game has stopped to give you something". A boon screen with
   * only paper noise on it reads as a menu; this makes it a moment.
   */
  {
    id: 'boon_reveal',
    layers: [
      { kind: 'osc', wave: 'triangle', freq: 261.6, attack: 0.06, decay: 0.9, gain: 0.3,
        filter: 'lowpass', cutoff: 1800, q: 1.2, spread: -0.35 },
      { kind: 'osc', wave: 'triangle', freq: 392, delay: 0.05, attack: 0.06, decay: 0.95, gain: 0.26,
        filter: 'lowpass', cutoff: 2200, q: 1.2, spread: 0.35 },
      { kind: 'osc', wave: 'sine', freq: 1046.5, delay: 0.28, attack: 0.02, decay: 0.7, gain: 0.16,
        spread: -0.55 },
      { kind: 'noise', noise: 'white', attack: 0.12, decay: 0.7, gain: 0.09,
        filter: 'highpass', cutoff: 5600, q: 0.7, spread: 0.6 },
    ],
    gain: 0.6, drive: 1.2, pitchJitter: 0.004, width: 1,
    spatial: false, reverb: 0.55, priority: 3, maxConcurrent: 1,
  },
  {
    id: 'card_take',
    layers: [
      { kind: 'osc', wave: 'sine', freq: 698.5, attack: 0.003, decay: 0.2, gain: 0.34 },
      { kind: 'osc', wave: 'sine', freq: 1046.5, delay: 0.05, attack: 0.003, decay: 0.3, gain: 0.3 },
      { kind: 'noise', noise: 'white', attack: 0.002, decay: 0.06, gain: 0.14,
        filter: 'highpass', cutoff: 4800, q: 0.7 },
    ],
    gain: 0.6, drive: 1.3, pitchJitter: 0.008,
    spatial: false, reverb: 0.35, priority: 2, maxConcurrent: 2,
  },
  {
    id: 'powerup_drop',
    layers: [
      { kind: 'osc', wave: 'triangle', freq: 1318.5, freqEnd: 1975.5, sweep: 0.5,
        attack: 0.02, decay: 0.7, gain: 0.3 },
      { kind: 'osc', wave: 'sine', freq: 659.3, attack: 0.02, decay: 0.7, gain: 0.24 },
      { kind: 'noise', noise: 'white', attack: 0.06, decay: 0.6, gain: 0.1,
        filter: 'bandpass', cutoff: 4000, cutoffEnd: 7000, q: 1.0 },
    ],
    gain: 0.55, drive: 1.2, pitchJitter: 0.01,
    reverb: 0.5, priority: 2, maxConcurrent: 2,
  },
  /**
   * THE POWER-UP. An arcade arpeggio, and unapologetic about it — this is the one moment the
   * game is allowed to sound like a coin-op cabinet. Six layers: the three squares that carry
   * the run, a sub landing on the last one, a sparkle and a wet tail.
   */
  {
    id: 'powerup_take',
    layers: [
      { kind: 'osc', wave: 'square', freq: 523.3, attack: 0.002, decay: 0.1, gain: 0.28,
        filter: 'lowpass', cutoff: 3000, q: 1.0, spread: -0.4 },
      { kind: 'osc', wave: 'square', freq: 784, delay: 0.05, attack: 0.002, decay: 0.1, gain: 0.28,
        filter: 'lowpass', cutoff: 3600, q: 1.0, spread: 0 },
      { kind: 'osc', wave: 'square', freq: 1046.5, delay: 0.1, attack: 0.002, decay: 0.28, gain: 0.28,
        filter: 'lowpass', cutoff: 4200, q: 1.0, spread: 0.4 },
      { kind: 'osc', wave: 'sine', freq: 130.8, freqEnd: 65.4, sweep: 0.18, delay: 0.1,
        attack: 0.002, decay: 0.26, gain: 0.5, spread: 0 },
      { kind: 'osc', wave: 'sine', freq: 2093, delay: 0.15, attack: 0.004, decay: 0.4, gain: 0.14,
        spread: -0.6 },
      { kind: 'noise', noise: 'white', delay: 0.1, attack: 0.006, decay: 0.3, gain: 0.11,
        filter: 'highpass', cutoff: 6200, q: 0.7, spread: 0.62 },
    ],
    gain: 0.6, drive: 1.5, pitchJitter: 0.008, width: 1,
    spatial: false, reverb: 0.4, priority: 3, maxConcurrent: 2,
  },
  {
    id: 'ui_click',
    layers: [
      { kind: 'osc', wave: 'square', freq: 1200, attack: 0.0006, decay: 0.02, gain: 0.16,
        filter: 'lowpass', cutoff: 4000, q: 0.8 },
    ],
    gain: 0.4, drive: 1.1, pitchJitter: 0.02,
    spatial: false, reverb: 0.08, priority: 0, maxConcurrent: 3,
  },
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Lookup
// ═════════════════════════════════════════════════════════════════════════════════════════════

const BY_ID = new Map<string, Recipe>();
for (const r of RECIPES) BY_ID.set(r.id, r);

export function getRecipe(id: string): Recipe | undefined {
  return BY_ID.get(id);
}

export function hasRecipe(id: string): boolean {
  return BY_ID.has(id);
}

export const RECIPE_IDS: readonly string[] = RECIPES.map((r) => r.id);

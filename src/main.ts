/**
 * COMIC ZOMBIES — BOOT.
 *
 * This file does exactly three things and nothing else:
 *   1. builds the services and assembles the `GameCtx` service locator,
 *   2. registers the systems in the order documented in ARCHITECTURE §3,
 *   3. owns the boot / pause / resize / hotkey shell around the loop.
 *
 * No gameplay lives here. If a rule about how the game behaves ends up in this file, it is in
 * the wrong place — it belongs to a system, and the wiring belongs here.
 *
 * BOOT SEQUENCE. Every asset in this game is generated at runtime: the arena alone is ~200ms of
 * synchronous geometry work, and the texture library is a stack of canvas draws. That work is
 * deliberately split across yielded frames with a status on screen, because a browser tab that
 * blocks for a third of a second before its first paint reads as "broken", not as "loading".
 *
 * POINTER LOCK IS THE STATE MACHINE. Rather than tracking "paused" separately and trying to keep
 * it in sync with the browser's lock state (which the user can drop at any time with Esc, alt-tab
 * or a system dialog), pause is *derived*: locked === playing, unlocked === paused. One source of
 * truth, and no way for the two to disagree.
 */

import { PerspectiveCamera, Scene, Vector3 } from 'three';

import { Emitter } from '@/core/events';
import { createDebug } from '@/core/debug';
import { createInput } from '@/core/input';
import { createLoop } from '@/core/loop';
import { createRng } from '@/core/rng';
import { createTime } from '@/core/time';
import { FIXED_DT } from '@/core/types';
import type { DamageInfo, EnemyKind, GameCtx, PlayerService, QualityTier, RNG } from '@/core/types';

import { PALETTE, color, css } from '@/art/palette';
import { disposeArtTextures } from '@/art/textures';
import { disposeWordTextures } from '@/art/letters';

import { INK_GLOBALS } from '@/render/materials/index';
import { createRenderer } from '@/render/renderer';
import { createWorld } from '@/world/index';
import { createPlayer } from '@/game/player/index';
import { createWeapons, STARTER_WEAPON_ID } from '@/game/weapons/index';
import { createEnemies } from '@/game/enemies/index';
import { createVfx } from '@/game/vfx/index';
import { createAudio } from '@/audio/index';
import { createRounds } from '@/game/rounds/index';
import { createBoons } from '@/game/boons/index';
import { createWallBuys } from '@/game/economy/wallbuys';
import { createEconomyExtras } from '@/game/economy/box';
import { CAMERA, MOVE, TUNING } from '@/game/tuning';
import type { NavGraph } from '@/world/nav';

import { createHud } from '@/ui/hud';
import type { HudSystem } from '@/ui/hud';
import { createCards } from '@/ui/cards';
import type { CardsSystem } from '@/ui/cards';
import { createNavDraw } from '@/ui/navdraw';
import type { NavDrawSystem } from '@/ui/navdraw';
import { createBoot, webgl2Supported } from '@/ui/boot';

// ─────────────────────────────────────────────────────────────────────────────
// Live-tuning handle. `window.CZ` in the console: `CZ.renderer.inkStrength = 2`.
// ─────────────────────────────────────────────────────────────────────────────

interface CzGlobals {
  ctx: GameCtx;
  loop: ReturnType<typeof createLoop>;
  renderer: ReturnType<typeof createRenderer>;
  world: ReturnType<typeof createWorld>;
  player: ReturnType<typeof createPlayer>;
  weapons: ReturnType<typeof createWeapons>;
  enemies: ReturnType<typeof createEnemies>;
  rounds: ReturnType<typeof createRounds>;
  boons: ReturnType<typeof createBoons>;
  vfx: ReturnType<typeof createVfx>;
  audio: ReturnType<typeof createAudio>;
  hud: HudSystem;
  cards: CardsSystem;
  /** The nav-graph overlay. `CZ.navDraw.mode = 'field'`, or F8 in the game. */
  navDraw: NavDrawSystem;
  time: ReturnType<typeof createTime>;
  input: ReturnType<typeof createInput>;
  events: Emitter;
  tuning: typeof TUNING;
  /** Spawn `n` shamblers at random arena spawn points (the M3 director's own entry points). */
  spawn(n?: number, kind?: EnemyKind): number;
  /** Spawn `n` shamblers ringing the player at kiting distance. */
  spawnNear(n?: number, kind?: EnemyKind): number;
  /**
   * Spawn `n` shamblers on the STREET around the player — every one of them proven at least
   * 1.5 m below your feet. This is the camping test's spawner: `spawnNear` probes ground from
   * your own eye height and so seeds a rooftop camp with zombies already on the roof.
   */
  spawnStreet(n?: number, kind?: EnemyKind): number;
  killAll(): void;
  /** Jump the director straight into round `n` — that round's count, HP, speed and live cap. */
  skipToRound(n: number): void;
  /**
   * THE LOOK OF ROUND `n`, WITHOUT PLAYING IT. Pushes the visual escalation — sky, fog, guttered
   * street lamps, grade, vignette, soot — to what round `n` looks like and changes NOTHING about
   * gameplay. Call with no argument to snap back to the live round.
   */
  setEscalation(n?: number): number;
  /** Grant a boon by id, skipping the draw. `CZ.boons.allDefs` lists every id. */
  giveBoon(id: string): void;
  /**
   * Put a weapon in your hands, skipping the wall-buy that does not exist yet.
   * `'ratatat'` · `'boomstick'` · `'longshot'` · `'inkslinger'`.
   */
  give(id: string): void;
  /** Deal a boon draw right now, outside the round beat. */
  offerBoons(n?: number): void;
  /** Kill the player outright — the fastest route to the run-summary panel. */
  die(): void;
  /** Snapshot the current frame's draw call / triangle counts. */
  stats(): Record<string, number>;

  // ── M3.5 handles ───────────────────────────────────────────────────────────
  /**
   * The live navigation graph, or null before `EnemySystem.init` has built it. `CZ.nav.stats`
   * is the build report; `CZ.nav.hasField` says whether the flow field has landed yet.
   */
  readonly nav: NavGraph | null;
  /** Blocking reachability probe: `CZ.navRoute(CZ.player.position, somewhere)`. */
  navRoute(from: Vector3, to: Vector3): { hops: number; cost: number; kinds: string };
  /** Fire one synthesized recipe through the real audio graph. `CZ.sounds()` lists the ids. */
  sound(id: string, volume?: number, pitch?: number): void;
  /** Every recipe id the synth knows. */
  sounds(): readonly string[];
  /** Put the player on a named vantage point and look back at the street — the camp test. */
  camp(spot?: CampSpot): string;
  /** Named vantage points, ordered easiest → nastiest. */
  readonly campSpots: readonly CampSpot[];
}

declare global {
  interface Window { CZ?: CzGlobals }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Yield long enough for the browser to actually paint the current boot status.
 *
 * MUST NOT depend on requestAnimationFrame alone. rAF never fires in a background tab, so a
 * pure-rAF yield deadlocks the whole boot sequence: open the game in a background tab and it
 * sits on "MIXING THE INK…" forever, only resuming if the tab is brought to the front. That
 * also blocks every automated browser check we run, since the automation tab is backgrounded.
 *
 * So: race the rAF pair against a timer. Visible tab → we still wait for a real paint. Hidden
 * tab → the timer wins and boot completes anyway (nothing is being painted to wait for).
 */
function paint(timeoutMs = 60): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, 0)));
    setTimeout(finish, timeoutMs);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ART-DIRECTION CALIBRATION.
//
// The five subsystems were each authored and verified in isolation. These are the numbers that
// only exist once they are composited together — the integrator's job, and the render agent's
// documented seam for it ("fine-tuning lives on the pipeline uniforms"). Nothing here changes
// a system's design; it sets the values that only a finished frame can tell you.
//
// BLOOM. The default (threshold .62, emissive boost 1.6, strength .85) was tuned against a
// scene with no emissive content in it. The arena has ~200 lit windows, a marquee and 17
// practicals, all on LAYER.BLOOM — so the selective bloom was selecting nearly a third of the
// screen and smearing the ink borders off the window grid. Comic glow is a *halo around a hard
// shape*, never a wash: high threshold, low boost, low strength keeps the ink edge readable.
// ─────────────────────────────────────────────────────────────────────────────

const BLOOM_CALIBRATION = {
  /** Only genuinely emissive things glow. */
  threshold: 0.92,
  knee: 0.5,
  /** The emissive prepass is already at full intensity — boosting it just clips it. */
  emissiveBoost: 0.55,
  strength: 0.34,
  /** Fewer, harder steps in the halo: printed glow is banded, not smooth. */
  steps: 4,
} as const;

/**
 * AMBIENT. The lighting rig sets the ink ambient to `NIGHT_A`, which is so dark in linear light
 * that every shadow-side facade fell to pure black and swallowed the halftone screen that is
 * supposed to live there (ART §2.2). A graphic-novel night is *violet*, not black — the shadow
 * band has to carry tone. `NIGHT_B` at 0.85 puts the screen-tone back on the walls without
 * flattening the terminator, and the cool fill comes up to match.
 */
function calibrateLighting(lighting: { fill: { intensity: number }; ambient: { intensity: number } }): void {
  INK_GLOBALS.uAmbient.value.copy(color(PALETTE.NIGHT_B)).multiplyScalar(0.85);
  INK_GLOBALS.uFillIntensity.value = 0.78;
  // Keep the real lights in step with the flats — they must never disagree.
  lighting.fill.intensity = 0.78;
  lighting.ambient.intensity = 0.7;
}

/**
 * Pick a starting quality tier. Deliberately conservative: it is far better to start at HIGH
 * and let the player push it to ULTRA than to open at 14fps and have them close the tab.
 */
function guessQuality(): QualityTier {
  const url = new URLSearchParams(location.search).get('q');
  if (url === 'low' || url === 'med' || url === 'high' || url === 'ultra') return url;
  const cores = navigator.hardwareConcurrency ?? 4;
  const dpr = window.devicePixelRatio || 1;
  if (cores <= 4) return 'med';
  if (cores >= 8 && dpr <= 2) return 'high';
  return 'high';
}

// ─────────────────────────────────────────────────────────────────────────────
// Scratch. Module level, never allocated in a handler.
// ─────────────────────────────────────────────────────────────────────────────

const _hurt = new Vector3();
const _right = new Vector3();
const _spawn = new Vector3();
const _probe = new Vector3();

/**
 * `CZ.die()` — the console's route to the fail state. Built once, mutated in place, because the
 * only thing that varies is how much damage is needed to be certainly lethal. The player still
 * goes DOWN first and crawls for `PLAYER.downTime`: that is the fail state, and a debug hatch
 * that skipped it would be testing a code path the player never takes.
 */
const _deathBlow: DamageInfo = {
  amount: 0,
  point: new Vector3(),
  normal: new Vector3(0, 1, 0),
  direction: new Vector3(0, 0, 1),
  part: 'torso',
  isCrit: false,
  knockback: 0,
};

function deathBlow(p: PlayerService): DamageInfo {
  _deathBlow.amount = Math.max(1, p.health) * 4 + 1000;
  _deathBlow.point.copy(p.eye);
  return _deathBlow;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG SPAWNING (M2). The round director is M3, so until it exists the human needs a way to
// put something in front of the gun. Two flavours, because they test different things:
//
//   · AT A SPAWN POINT — the arena's own `enemySpawns`, i.e. the doors and alley mouths the
//     director will actually use. They walk in from distance, so this is the test of whether
//     you can SEE them coming (ART §9) and whether the approach reads.
//   · NEAR THE PLAYER — a ring at 9–22m. This is the test of kiting and of the melee tell,
//     and it is what the enemy system's own Z / X keys do.
//
// Everything here also hangs off `window.CZ` so it works from the console with no pointer lock
// — which is the only way any of it can be exercised under browser automation.
// ─────────────────────────────────────────────────────────────────────────────

/** How many of the nearest spawn points a debug spawn may choose from. */
const DEBUG_SPAWN_CANDIDATES = 4;
/** Never use a spawn point closer than this — nothing may materialise in the player's face. */
const DEBUG_SPAWN_MIN_DIST = 12;
/**
 * Beyond this, a real spawn point is too far to be a usable debug control and the street ring
 * below is used instead. MEASURED: the arena's 24 `enemySpawns` all sit on the 140 m perimeter
 * (±67 m), so from the player's own spawn at (0, 21) the NEAREST one is 46.2 m and the farthest
 * is 103.9 m. A shambler walks at ~1.5 m/s, so "N" spawning at a real door meant pressing a key
 * and then waiting half a minute for anything to happen — which reads as a broken key, not as
 * dread. The doors are still used whenever the player is near one.
 */
const DEBUG_SPAWN_MAX_DIST = 45;
/** The fallback street ring: far enough to watch them come, near enough to be a fight. */
const DEBUG_RING = [26, 38] as const;

class DebugSpawner {
  private readonly rng: RNG;
  /** Spawn-point indices, re-sorted by distance on each use. Never reallocated. */
  private readonly order: number[] = [];

  constructor(private readonly ctx: GameCtx) {
    // A private stream: pressing a debug key must never shift the gameplay RNG sequence.
    this.rng = ctx.rng.fork(0xd3b06);
    for (let i = 0; i < ctx.world.enemySpawns.length; i++) this.order.push(i);
  }

  /**
   * "They walk in from the dark." Prefers the arena's own `enemySpawns` — the doors and alley
   * mouths the M3 director will use — and falls back to a ring in the street around the player
   * when every door is over `DEBUG_SPAWN_MAX_DIST` away. Either way they arrive at a distance
   * where you can see them coming, which is the thing this control exists to test.
   */
  atSpawnPoints(n = 1, kind: EnemyKind = 'shambler'): number {
    const points = this.ctx.world.enemySpawns;
    const eye = this.ctx.player.position;

    this.order.sort((a, b) => {
      const pa = points[a]!;
      const pb = points[b]!;
      const da = Math.hypot(pa.x - eye.x, pa.z - eye.z);
      const db = Math.hypot(pb.x - eye.x, pb.z - eye.z);
      // Anything inside the exclusion radius sorts to the back rather than being dropped, so a
      // player standing on top of the only spawn point still gets zombies.
      return (da < DEBUG_SPAWN_MIN_DIST ? da + 1e4 : da) - (db < DEBUG_SPAWN_MIN_DIST ? db + 1e4 : db);
    });
    const pool = Math.min(DEBUG_SPAWN_CANDIDATES, this.order.length);
    const nearest = points[this.order[0]!];
    const useDoors =
      pool > 0 && nearest !== undefined &&
      Math.hypot(nearest.x - eye.x, nearest.z - eye.z) <= DEBUG_SPAWN_MAX_DIST;

    let made = 0;
    for (let i = 0; i < n; i++) {
      if (useDoors) {
        const p = points[this.order[this.rng.int(0, pool)]!]!;
        // Fan them out a little so ten from one door do not spawn inside each other.
        _spawn.set(p.x + this.rng.range(-1.6, 1.6), p.y, p.z + this.rng.range(-1.6, 1.6));
      } else {
        const a = this.rng.next() * Math.PI * 2;
        const r = this.rng.range(DEBUG_RING[0], DEBUG_RING[1]);
        _spawn.set(eye.x + Math.cos(a) * r, eye.y + 1.5, eye.z + Math.sin(a) * r);
      }
      const g = this.ctx.world.groundAt(_spawn);
      if (g === null) continue;
      _spawn.y = g;
      if (this.ctx.enemies.spawn(kind, _spawn, 1, 1)) made++;
    }
    return made;
  }

  /** Ringing the player, at the distance you want to start kiting from. */
  nearPlayer(n = 1, kind: EnemyKind = 'shambler'): number {
    let made = 0;
    for (let i = 0; i < n; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = this.rng.range(9, 22);
      const eye = this.ctx.player.position;
      _spawn.set(eye.x + Math.cos(a) * r, eye.y + 1.5, eye.z + Math.sin(a) * r);
      const g = this.ctx.world.groundAt(_spawn);
      if (g === null) continue;
      _spawn.y = g;
      if (this.ctx.enemies.spawn(kind, _spawn, 1, 1)) made++;
    }
    return made;
  }

  /**
   * THE CAMPING TEST'S OWN SPAWNER — and the reason it had to exist.
   *
   * `nearPlayer` probes ground from `eye.y + 1.5`, which from a 7.55 m roof finds THE ROOF.
   * MEASURED at `roof_ne`: 7 of 15 "nearby" zombies landed at dy 0.00 or −0.76, i.e. already on
   * the deck with you, so nearly half the horde never had to climb anything and the published
   * time-to-contact was inflated ~1.7×. A camping test that seeds the camp is not a test.
   *
   * So this probes from a fixed STREET height and rejects any candidate that is not at least
   * `STREET_DROP` below the player's feet. Every body it returns had to find a route up.
   */
  street(n = 1, kind: EnemyKind = 'shambler'): number {
    let made = 0;
    const eye = this.ctx.player.position;
    for (let i = 0; i < n * STREET_TRIES && made < n; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = this.rng.range(STREET_RING[0], STREET_RING[1]);
      _spawn.set(eye.x + Math.cos(a) * r, STREET_PROBE_Y, eye.z + Math.sin(a) * r);
      const g = this.ctx.world.groundAt(_spawn);
      // `groundAt` hands back the probe's own height when the ray starts inside geometry, so a
      // result at the probe line is "no street here", not "street at 1.6 m".
      if (g === null || g > STREET_PROBE_Y - 0.05 || g > eye.y - STREET_DROP) continue;
      _spawn.y = g;
      if (this.ctx.enemies.spawn(kind, _spawn, 1, 1)) made++;
    }
    return made;
  }
}

/** Height the street spawner probes DOWN from. Above every kerb, below every deck. */
const STREET_PROBE_Y = 1.6;
/**
 * How far below the player's own footing a candidate must be to count as "the street". 0.5 m so
 * the monument rim (0.90 m) is still a testable camp; the probe height above is what actually
 * guarantees nothing spawns on a deck.
 */
const STREET_DROP = 0.5;
/** Ring the street spawner uses, metres. Matches the measured camping table. */
const STREET_RING: readonly [number, number] = [17, 27];
/** Candidate attempts per requested body before giving up. Rooftop rings reject a lot. */
const STREET_TRIES = 12;

// ─────────────────────────────────────────────────────────────────────────────
// CAMP SPOTS (M3.5). The human's first note on BUILD 004 was "they dont go up stairs or things
// so u can just camp top of a building or fountain". Every one of these is a place that WAS a
// safe camp; `CZ.camp('roof_ne')` puts you on it in one call so the fix can be checked in ten
// seconds instead of a two-minute climb. The arena publishes most of them as named zones, so
// this reads their real boxes rather than carrying a second copy of the level's coordinates.
//
// `monument` is the exception and is the arena's own origin: the plaza dais is authored around
// (0, 0) and is not a zone (it is a `occupied` reservation), so it is named here explicitly.
// ─────────────────────────────────────────────────────────────────────────────

const CAMP_ZONES = {
  roof_ne: 'roof_ne',
  gantry: 'gantry',
  catwalk: 'catwalk_west',
  containers: 'lot_sw',
  dock: 'dock_south',
  bus: 'bus',
} as const;

export type CampSpot = 'monument' | keyof typeof CAMP_ZONES;

const CAMP_SPOTS: readonly CampSpot[] =
  ['monument', 'bus', 'dock', 'containers', 'roof_ne', 'gantry', 'catwalk'] as const;

/** How far above the found surface the probe starts. Above any parapet, below the next storey. */
const CAMP_PROBE_UP = 2.2;
/**
 * Samples per axis across a zone's box when hunting its highest standable surface.
 *
 * A CAMP SPOT IS THE HIGH POINT OF A ZONE, NOT ITS CENTRE. The zone boxes are broad — `lot_sw`
 * covers the whole south-west yard — and its centre is bare tarmac between the containers, so
 * "camp the containers" was dropping the player on the ground at y 0.00 (MEASURED) rather than
 * on the 5.2 m stack the whole spot exists to test. 7×7 is enough to find a 12 m container in a
 * 26 m lot and costs 49 ground probes on a debug call.
 */
const CAMP_SAMPLES = 7;

interface CampWorld {
  readonly zones: readonly { id: string; box: { min: Vector3; max: Vector3 } }[];
  readonly service: { groundAt(p: Vector3): number | null };
}

/**
 * THE MONUMENT IS NOT ITS CENTRE. The plaza dais is a stepped platform (top tier y 0.90 out to
 * r 4.5, then 0.71 / 0.52 / 0.45 steps down to the pavement at r 10) with the obelisk standing
 * on it — and the obelisk's pedestal reaches to r 2.24. Teleporting to (0, 0.90, 0) puts the
 * camera INSIDE that pedestal, looking at the inside of a wall: `collideCapsule` reports no
 * penetration there because the octree is backface-culled, so nothing catches it. MEASURED, and
 * it is what the first camp screenshot showed. So the monument camp stands on the rim, which is
 * where a player camps anyway.
 */
const MONUMENT_RIM = 3.6;

/**
 * Teleport onto a vantage point and look at the ground the horde has to cross. Returns a
 * description, because the console is the UI here and "it moved me somewhere" is not a result.
 *
 * FACING. Camera forward is (−sin yaw, 0, −cos yaw). From a rooftop or a gantry the interesting
 * direction is the plaza, i.e. the origin: `atan2(cx, cz)` — checked against the arena's own
 * spawn, where (0, 21) with yaw 0 faces −Z. On the monument you ARE the origin, so the useful
 * direction is the reverse: out over the rim at whatever is climbing it.
 */
function campAt(
  world: CampWorld, player: PlayerService, spot: CampSpot, nav: NavGraph | null,
): string {
  let cx = 0;
  let cz = 0;
  let top = 3;
  let facing: number;
  if (spot === 'monument') {
    cz = MONUMENT_RIM;
    facing = Math.atan2(-cx, -cz);
    _spawn.set(cx, top + CAMP_PROBE_UP, cz);
  } else {
    const id = CAMP_ZONES[spot];
    const z = world.zones.find((q) => q.id === id);
    if (!z) return `no zone '${id}' in this arena`;
    facing = Math.atan2((z.box.min.x + z.box.max.x) * 0.5, (z.box.min.z + z.box.max.z) * 0.5);
    const probeY = z.box.max.y + CAMP_PROBE_UP;
    let bestY = -Infinity;
    for (let i = 0; i < CAMP_SAMPLES; i++) {
      // Interior samples only — the box edges sit in the wall or off the deck.
      const fx = (i + 1) / (CAMP_SAMPLES + 1);
      const x = z.box.min.x + (z.box.max.x - z.box.min.x) * fx;
      for (let j = 0; j < CAMP_SAMPLES; j++) {
        const fz = (j + 1) / (CAMP_SAMPLES + 1);
        _probe.set(x, probeY, z.box.min.z + (z.box.max.z - z.box.min.z) * fz);
        const y = world.service.groundAt(_probe);
        if (y !== null && y > bestY) { bestY = y; cx = _probe.x; cz = _probe.z; }
      }
    }
    if (bestY === -Infinity) return `no standable surface in zone '${id}'`;
    _spawn.set(cx, bestY, cz);
    player.teleport(_spawn, facing);
    return `${spot} · (${cx.toFixed(1)}, ${bestY.toFixed(2)}, ${cz.toFixed(1)})${reachNote(nav, _spawn)}`;
  }
  const g = world.service.groundAt(_spawn);
  if (g === null) return `no ground under ${spot} at (${cx.toFixed(1)}, ${cz.toFixed(1)})`;
  _spawn.y = g;
  player.teleport(_spawn, facing);
  return `${spot} · (${cx.toFixed(1)}, ${g.toFixed(2)}, ${cz.toFixed(1)})${reachNote(nav, _spawn)}`;
}

/**
 * Say out loud whether the horde can actually get to the spot we just teleported to.
 *
 * BUILD 005 shipped `CZ.camp('dock')` pointing at the loading-dock CANOPY, 5.95 m up, which the
 * graph could not reach at all: 0 arrivals and 0 attacks in 150 s, three runs. The human would
 * have stood there for two minutes, seen nothing come, and concluded the whole milestone failed.
 * The climb limit that caused it is fixed (`world/nav.ts` CLIMB_MAX), but a camp command that
 * cannot tell you it has put you somewhere unreachable is a trap whatever the level does next,
 * so the check is permanent.
 */
function reachNote(nav: NavGraph | null, at: Vector3): string {
  if (!nav || !nav.hasField) return '';
  _probe.set(CAMP_REACH_FROM[0], CAMP_REACH_FROM[1], CAMP_REACH_FROM[2]);
  const r = nav.probeRoute(_probe, at);
  return r.hops >= 0
    ? `  ·  reachable in ${r.hops} hops (${r.kinds})`
    : '  ·  ⚠ UNREACHABLE by the horde — not a valid camping test';
}

/** Street node the reachability note routes from: the arena's own plaza, at ground level. */
const CAMP_REACH_FROM: readonly [number, number, number] = [0, 0, 14];

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE MASTER SEED — every stream in the game forks this one.
 *
 * It was `0xc0ffee`, hard-coded. The result: identical boon draws, identical spawn-point order,
 * identical power-up rolls and identical enemy variants on every fresh load — the round-1 offer
 * came up TRIGGER FINGER / BLOOD MONEY / RED INK on three independent page loads. For a
 * roguelite whose pitch is "by round 15 no two runs look alike" (GAME_BIBLE §1), the second run
 * opening exactly like the first is the specific thing that kills "one more round".
 *
 * So: random by default, and `?seed=` pins it. A pinned seed is what a bug report attaches, what
 * a tuning A/B needs, and what GAME_BIBLE's daily-run stretch feature is already shaped like.
 * Accepts decimal or `0x`-prefixed hex; anything unparseable falls back to random rather than
 * silently seeding every run with NaN.
 */
function pickSeed(): number {
  const raw = new URLSearchParams(window.location.search).get('seed');
  if (raw !== null) {
    const n = Number(raw.trim());
    if (Number.isFinite(n)) return Math.floor(Math.abs(n)) >>> 0;
  }
  // `crypto` where it exists; `Date.now()` is the fallback and is plenty for "not the same run".
  const c = window.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    return c.getRandomValues(new Uint32Array(1))[0]! >>> 0;
  }
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

async function boot(): Promise<void> {
  const overlay = createBoot();

  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('[main] #game canvas missing from index.html');

  if (!webgl2Supported()) {
    overlay.failed(
      'NO INK',
      'This browser cannot open a WebGL2 context, and every line, dot and shadow in this ' +
      'game is drawn by a shader. Try Chrome, Edge or Firefox on a machine with hardware ' +
      'acceleration enabled (chrome://settings → System → "Use graphics acceleration").',
    );
    return;
  }

  // ── 1 · core services ──────────────────────────────────────────────────────
  overlay.setLoading('MIXING THE INK');
  await paint();

  const events = new Emitter();
  const time = createTime();
  const masterSeed = pickSeed();
  const rng = createRng(masterSeed);
  const scene = new Scene();
  scene.name = 'root';

  const camera = new PerspectiveCamera(
    CAMERA.fovBase,
    window.innerWidth / Math.max(1, window.innerHeight),
    CAMERA.near,
    CAMERA.far,
  );
  camera.name = 'player-camera';

  const quality = guessQuality();
  let renderer: ReturnType<typeof createRenderer>;
  try {
    renderer = createRenderer({
      canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      quality,
      onQualityChanged: (tier) => events.emit('quality:changed', { tier }),
      pipeline: { bloom: BLOOM_CALIBRATION },
    });
  } catch (err) {
    console.error(err);
    overlay.failed(
      'PRESS JAMMED',
      'The WebGL renderer failed to start. This is usually a driver or GPU-blocklist issue — ' +
      'check the browser console for the underlying error.',
    );
    return;
  }

  const input = createInput(canvas, { pauseOnLockLost: true });
  const debug = createDebug();
  const hud = createHud({ visible: false });

  // ── 2 · the world (the expensive part) ─────────────────────────────────────
  overlay.setLoading('BUILDING THE BLOCK');
  await paint();
  // MOVE owns the walkable-slope limit and the ground probe; the world solver must be given
  // the same numbers the controller uses, or the two disagree on 53–60° ramps.
  const world = createWorld({
    quality,
    groundNormalY: MOVE.minGroundNormalY,
    groundProbe: MOVE.groundProbe,
  });
  calibrateLighting(world.lighting);

  overlay.setLoading('LIGHTING THE SET');
  await paint();
  const player = createPlayer();

  // ── 3 · the gameplay systems (M2) ──────────────────────────────────────────
  // Each of these is a `System` AND the `XxxService` its `GameCtx` slot names, so the same
  // object is both the contract and the frame hook. Construction is deliberately cheap —
  // every one of them builds its geometry, textures and pools in `init()`, which the loop
  // runs (awaited, in registration order) inside `loop.start()` below.
  overlay.setLoading('LOADING THE INKSLINGER');
  await paint();
  const weapons = createWeapons();
  const enemies = createEnemies();
  const vfx = createVfx();
  const audioSys = createAudio();
  // M3 — the loop. Both of these are the service in `GameCtx` AND a frame hook in the loop.
  //
  // `createBoons(player)` is load-bearing and is checked by tsc: the boon layer needs a place to
  // push stat modifiers, and `PlayerService` has no way to write to the stack it documents.
  // `PlayerSystem` satisfies `BoonStatHost` structurally, so handing the player in IS the wiring
  // — with no host every stat boon in the pool is silently inert.
  const rounds = createRounds();
  const boons = createBoons(player);
  // `createEconomyExtras(player)` is load-bearing for the identical reason `createBoons(player)`
  // is: the four perk machines push permanent stat modifiers, `PlayerService` has no way to write
  // to that stack, and `PlayerSystem` satisfies `PerkStatHost` structurally. With no host every
  // perk in the game buys you a bottle and changes nothing.
  const economy = createEconomyExtras(player);
  const wallbuys = createWallBuys();

  // The card layers: the boon draw and the run summary. They need two things the frozen
  // interfaces cannot carry — the finished run's POINTS (`game:over` has no slot for it) and the
  // HUD's modal latch — so both are handed over as named, tsc-checked shapes rather than probed
  // for at runtime. The HUD's combo drain bar reads `comboGraceFraction` the same way.
  const cards = createCards({ run: rounds, hud });
  hud.attachRounds(rounds);

  // M3.5 — the nav overlay. It reads the graph through a GETTER, not a reference, because the
  // enemy system builds it in `init()` (~190 ms of raycasts) long after this line runs, and
  // rebuilds it to null on dispose. Handing over `enemies.nav` here would capture null forever.
  const navDraw = createNavDraw({ graph: () => enemies.nav });

  // ── 4 · the service locator ────────────────────────────────────────────────
  const ctx: GameCtx = {
    scene,
    camera,
    renderer,
    input,
    events,
    time,
    rng,
    world: world.service,
    player,
    weapons,
    enemies,
    rounds,
    boons,
    vfx,
    hud,
    audio: audioSys,
    debug,
  };

  // ── 5 · systems, in the ARCHITECTURE §3 order ──────────────────────────────
  //   input → time → world → player → weapons → enemies → rounds → boons
  //         → powerups → vfx → audio → hud → cards → debug → render
  // `rounds` is real as of M3 and owns the power-up drops, so there is no separate `powerups`
  // system. `cards` is the UI half of the loop (the boon draw and the run summary) and sits
  // with the HUD at the end, where it can see the finished frame's state.
  const loop = createLoop({
    ctx,
    time,
    input,
    render: () => renderer.render(scene, camera),
    onError: (err) => {
      console.error('%c[COMIC ZOMBIES] a system threw — loop stopped', `color:${css('HOT')}`, err);
      overlay.failed('PANEL TORN', String(err));
    },
  });

  loop.add(input);
  loop.add(world);
  loop.add(player);
  // WEAPONS AFTER PLAYER: the viewmodel hangs off `camera.matrixWorld`, which is only this
  // frame's finished pose once the player system has run.
  loop.add(weapons);
  // ENEMIES AFTER WEAPONS is what ARCHITECTURE §3 says, and it is safe because the enemy
  // system refreshes its hitboxes lazily inside `raycast()` — a shot fired this frame always
  // traces against this frame's bodies, never last frame's.
  loop.add(enemies);
  // ROUNDS AFTER ENEMIES, and it matters exactly once: the director decides a round is over by
  // reading `enemies.aliveCount`, so running it first would clear the round a frame early.
  loop.add(rounds);
  // BOONS AFTER ROUNDS: the boon layer's slide-contact damage must see the position the player
  // reached THIS step, and its behavioural tickers read the round the director just published.
  loop.add(boons);
  // WALL-BUYS AFTER PLAYER AND WEAPONS, and they need both: the proximity test reads the position
  // the player reached THIS frame, and a purchase calls `weapons.give` / `refillAmmo` after the
  // gun has already had its own frame. It finds its own spots by probing `WorldService` in
  // `init()`, so it must also run after `world` — which registration order already guarantees.
  loop.add(wallbuys);
  // THE MACHINES (mystery box · 4 perks · Pack-a-Punch) AFTER THE WALL-BUYS, and the order is
  // load-bearing for exactly one thing: both layers answer the same `interact` key and both write
  // the same `ui:prompt` channel, and on the shipped arena a perk machine lands 1.11 m from a
  // wall-buy. `economy/claim.ts` arbitrates (nearest wins, machines take ties); registering the
  // wall-buys FIRST is what lets them publish their distance in the fixed step before the machine
  // layer reads it in the same step, so neither side ever compares against a stale pose. Same
  // reasons as the wall-buys for needing `player` and `weapons` ahead of it.
  loop.add(economy);
  loop.add(vfx);
  loop.add(audioSys);
  loop.add(hud);
  loop.add(cards);
  // NAV DRAW BEFORE DEBUG, and it is the only ordering constraint it has: it emits into
  // `DebugSystem`'s segment buffer, and `debug.update` is what expires and uploads that buffer.
  // Registered after it, every line it drew would be a frame late.
  loop.add(navDraw);
  loop.add(debug);
  debug.bindPerf(loop.stats);

  // ── 6 · presentation wiring ────────────────────────────────────────────────
  // Anything that has to happen between two shipped systems goes on the bus, never as an
  // import from one into the other.
  events.on('fx:flash', (p) => renderer.flash(p.intensity, p.color));
  events.on('fx:hitstop', (p) => time.hitstop(p.seconds));
  events.on('quality:changed', (p) => {
    world.setQuality(p.tier);
    hud.toast(`QUALITY · ${p.tier.toUpperCase()}`);
  });
  events.on('player:damaged', (p) => {
    // Project the incoming direction into screen space so the lens splats bias toward the hit.
    // The payload's vector is a shared scratch — read it now, never retain it.
    _hurt.copy(p.fromDirection);
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    renderer.inkSplat(0.85, -_hurt.dot(_right), 0);
  });
  // THE ROUND BEAT. The panel frame snaps closed for the title card and eases back out — the
  // page turning. `titleCardTime` owns how long the card is up, so the frame is driven off the
  // same constant instead of a second magic duration that can drift away from it.
  events.on('round:start', () => {
    renderer.panelFrame(1);
    window.setTimeout(() => renderer.panelFrame(0), TUNING.ROUND.titleCardTime * 1000 * 0.62);
  });
  events.on('round:cleared', () => {
    renderer.panelFrame(1);
    window.setTimeout(() => renderer.panelFrame(0), TUNING.ROUND.clearPanelHold * 1000);
  });

  // ── DOWN / DEATH / RESTART ────────────────────────────────────────────────
  // The round director owns the RUN: it emits `game:over` with the summary numbers, writes the
  // meta to localStorage, and starts a fresh run once a living player is back in the world.
  // What lives here is the world-side reset the director must not reach into — and the gate.
  //
  // THE GATE: `player.respawn()` is what the director watches for, so NOT calling it is what
  // holds the back cover on screen. The run summary owns the restart, and the player leaves the
  // dead screen when they decide to, not 3.5 seconds after they died. `cards.onRestart` is the
  // one line that turns the page.
  //
  // `despawnAll()`, NOT `killAll()`: a respawn wipe is not 25 kills. `killAll` routes every
  // body through the normal damage path, which would pay out points, ramp the combo to ×5 and
  // print a screen of SPLATs for an event the player did not cause — and it would do it BEFORE
  // the director's own `player:died` handler runs, so the run summary would report the inflated
  // numbers. `despawnAll` is the silent removal the enemy system documents for exactly this.
  events.on('player:down', () => { renderer.panelFrame(1); });
  events.on('player:revived', () => { renderer.panelFrame(0); });
  events.on('player:died', () => {
    enemies.despawnAll();
    vfx.clear();
    // Dead hands do not shoot or steer. The summary's own key handlers are on `window` and are
    // unaffected; this only silences the game beneath it.
    input.enabled = false;
    input.clearAll();
  });
  cards.onRestart = () => {
    player.respawn();
    renderer.panelFrame(0);
    if (document.pointerLockElement === canvas) input.enabled = true;
  };

  // ── 7 · resize ─────────────────────────────────────────────────────────────
  const resize = (): void => {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    renderer.resize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  // ── 8 · run ────────────────────────────────────────────────────────────────
  // The weapon system equips the inkslinger in its own `init`, and announces the magazine on
  // its first frame — by which point every `init` (including the HUD's subscriptions) has run.
  // So there is nothing to prime here, and no "NO WEAPON" placeholder to write.
  //
  // ITS OWN STATUS LINE, because M3.5 made this phase expensive: `EnemySystem.init` now builds
  // the navigation graph, which is 100 800 raycasts against the collision octree — MEASURED at
  // 190 ms in a production build and 684 ms in dev. `loop.start()` awaits every `init` in one
  // go, so that cost lands inside a single unyielded block. Leaving "LOADING THE INKSLINGER" on
  // screen through it would be a status that lies about what the tab is doing for most of a
  // second, and the boot sequence exists precisely so that never happens.
  overlay.setLoading('TEACHING THEM TO CLIMB');
  await paint();
  await loop.start();

  // ── 9 · the pointer-lock state machine ─────────────────────────────────────
  let everStarted = false;
  time.paused = true;
  // Input is DEAD until the pointer is locked. Without this the click that dismisses the boot
  // overlay is also a trigger pull, and every keystroke typed at a paused screen reaches the
  // weapon (whose `update` runs on unscaled frame time, by design, so the viewmodel keeps
  // animating while paused).
  input.enabled = false;

  const onLockChange = (): void => {
    const locked = document.pointerLockElement === canvas;
    if (locked) {
      time.paused = false;
      // Resuming into an open run summary must not hand the controls back to a dead player.
      input.enabled = !cards.modal;
      overlay.hide();
      hud.setVisible(true);
      if (!everStarted) {
        everStarted = true;
        events.emit('game:started', {});
        rounds.start();
      } else {
        events.emit('game:paused', { paused: false });
      }
    } else if (everStarted) {
      time.paused = true;
      input.clearAll();
      input.enabled = false;
      overlay.paused();
      events.emit('game:paused', { paused: true });
    }
  };
  document.addEventListener('pointerlockchange', onLockChange);

  overlay.onStart = () => {
    input.requestPointerLock();
    void ctx.audio.resume();
  };

  // ── 10 · developer hotkeys ─────────────────────────────────────────────────
  // (backquote is owned by DebugSystem, and Z / X / B by EnemySystem; both install their own
  // listeners. Nothing here may collide with a binding in `core/input.ts`.)
  const QUALITY_KEYS: Record<string, QualityTier> = {
    F1: 'low', F2: 'med', F3: 'high', F4: 'ultra',
  };
  const spawner = new DebugSpawner(ctx);
  let postOn = true;

  // The arsenal, in the debug panel. Both slots, which one is live, and the ammo — so a swap test
  // does not need the console to answer "what am I actually holding".
  debug.watch('weapon', () => {
    const cur = ctx.weapons.current;
    return cur ? `${cur.def.name} ${cur.ammo}/${cur.def.infiniteReserve ? '∞' : cur.reserve}` : '—';
  });
  debug.watch('slots', () => ctx.weapons.slots
    .map((s, i) => (s ? `${i === 0 ? '1:' : '2:'}${s.def.id}` : `${i + 1}:—`))
    .join(' · '));

  const onKey = (e: KeyboardEvent): void => {
    // Debug spawning is deliberately NOT gated on pointer lock: it has to work from a paused
    // screen and from an automated browser, which can never take the lock.
    if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.code === 'KeyN') {
        e.preventDefault();
        spawner.atSpawnPoints(1);
        hud.toast(`SHAMBLER IN · ${ctx.enemies.aliveCount} ALIVE`);
        return;
      }
      if (e.code === 'KeyM') {
        e.preventDefault();
        spawner.atSpawnPoints(10);
        hud.toast(`HORDE IN · ${ctx.enemies.aliveCount} ALIVE`);
        return;
      }
      if (e.code === 'KeyK') {
        e.preventDefault();
        ctx.enemies.killAll('debug');
        hud.toast('BLOCK CLEARED');
        return;
      }
      // J CYCLES THE ARSENAL. Wall-buys do not exist yet, so until they do this is the only way
      // to get a gun other than the starter into your hands — and typing `CZ.give('boomstick')`
      // means leaving the game, which is exactly the friction that stops a weapon being
      // feel-tested at all. `give` fills the first empty slot, so the pistol survives the first
      // press and `swap` (Q / wheel) still flips between the two.
      if (e.code === 'KeyJ') {
        e.preventDefault();
        // The STARTER IS SKIPPED. Cycling through it hands you a second inkslinger in slot 2 and
        // you end the round carrying two identical pistols; worse, the gun you were comparing
        // against is gone. Keeping it pinned in slot 1 means Q always flips back to the
        // reference weapon, which is the whole point of a two-slot comparison.
        const defs = ctx.weapons.allDefs.filter((d) => d.id !== STARTER_WEAPON_ID);
        const held = ctx.weapons.current?.def.id;
        const at = defs.findIndex((d) => d.id === held);
        const next = defs[(at + 1) % defs.length];
        if (next) {
          ctx.weapons.give(next.id);
          hud.toast(`${next.name} · ${next.archetype.toUpperCase()}  ·  Q FOR THE PISTOL`);
        }
        return;
      }
    }
    const tier = QUALITY_KEYS[e.code];
    if (tier) {
      e.preventDefault();
      renderer.quality = tier;
      events.emit('quality:changed', { tier });
      return;
    }
    if (e.code === 'F5') {
      // A/B the art direction: scene + grade stay on so the comparison is a fair one
      // (correct colour either way); the ink, the screen-tone and the bloom toggle.
      e.preventDefault();
      postOn = !postOn;
      const p = renderer.pipeline;
      p.inkPass.enabled = postOn;
      p.halftonePass.enabled = postOn;
      p.bloomPass.enabled = postOn;
      hud.toast(postOn ? 'COMIC PASSES · ON' : 'COMIC PASSES · OFF');
      return;
    }
    if (e.code === 'KeyP') {
      e.preventDefault();
      if (document.pointerLockElement === canvas) input.exitPointerLock();
      else if (overlay.state === 'paused') input.requestPointerLock();
      return;
    }
  };
  window.addEventListener('keydown', onKey, { passive: false });

  // ── 11 · teardown ──────────────────────────────────────────────────────────
  const teardown = (): void => {
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerlockchange', onLockChange);
    loop.dispose();
    renderer.dispose();
    input.dispose();
    overlay.dispose();
    // The art caches are global and outlive any single system.
    disposeArtTextures();
    disposeWordTextures();
  };
  window.addEventListener('pagehide', teardown, { once: true });

  // ── 12 · hand over ─────────────────────────────────────────────────────────
  overlay.ready();
  events.emit('game:booted', {});

  if (import.meta.env.DEV || location.search.includes('cz=1')) {
    window.CZ = {
      ctx, loop, renderer, world, player, hud, cards, navDraw, time, input, events,
      weapons, enemies, rounds, boons, vfx, audio: audioSys, tuning: TUNING,
      spawn: (n = 1, kind: EnemyKind = 'shambler') => spawner.atSpawnPoints(n, kind),
      spawnNear: (n = 1, kind: EnemyKind = 'shambler') => spawner.nearPlayer(n, kind),
      spawnStreet: (n = 1, kind: EnemyKind = 'shambler') => spawner.street(n, kind),
      killAll: () => ctx.enemies.killAll('console'),
      skipToRound: (n: number) => rounds.skipToRound(n),
      setEscalation: (n?: number) => rounds.setEscalation(n),
      giveBoon: (id: string) => boons.grant(id),
      give: (id: string) => {
        if (!ctx.weapons.getDef(id)) {
          console.warn(`[CZ] no weapon '${id}'. Try: ` +
            ctx.weapons.allDefs.map((d) => `'${d.id}'`).join(' · '));
          return;
        }
        ctx.weapons.give(id);
      },
      // Through the CONTRACT, not the class: `BoonSystem.offer`'s default parameter narrows its
      // own type to the literal 3, which a caller passing a plain `number` cannot satisfy.
      offerBoons: (n = 3) => ctx.boons.offer(n),
      die: () => player.takeDamage(deathBlow(player)),
      stats: () => {
        const i = renderer.three.info;
        return {
          calls: i.render.calls,
          triangles: i.render.triangles,
          fps: Math.round(loop.stats.fps),
          frameMs: +loop.stats.frameMs.toFixed(2),
          simMs: +loop.stats.simMs.toFixed(2),
          renderMs: +loop.stats.renderMs.toFixed(2),
          geometries: i.memory.geometries,
          textures: i.memory.textures,
          alive: ctx.enemies.aliveCount,
        };
      },

      // ── M3.5 ───────────────────────────────────────────────────────────────
      // A getter, not a captured value: the graph does not exist until `EnemySystem.init`.
      get nav(): NavGraph | null { return enemies.nav; },
      navRoute: (from: Vector3, to: Vector3) => enemies.navProbe(from, to),
      sound: (id: string, volume = 1, pitch = 1) => audioSys.play(id, { volume, pitch }),
      sounds: () => audioSys.recipeIds,
      camp: (spot: CampSpot = 'monument') => campAt(world, player, spot, enemies.nav),
      campSpots: CAMP_SPOTS,
    };
  }

  printControls(quality, world.arena.drawCalls, world.arena.triangles, masterSeed);
}

// ─────────────────────────────────────────────────────────────────────────────
// The console card. It is the first thing a developer sees; it gets the treatment too.
// ─────────────────────────────────────────────────────────────────────────────

function printControls(quality: QualityTier, draws: number, tris: number, seed: number): void {
  const ink = css('INK');
  const paper = css('PAPER');
  const hot = css('HOT');
  const gold = css('GOLD');
  const electric = css('ELECTRIC');

  const title = [
    'padding:10px 18px',
    `background:${ink}`,
    `color:${paper}`,
    'font:700 26px Impact,"Arial Black",sans-serif',
    'letter-spacing:2px',
    `text-shadow:3px 3px 0 ${hot}`,
    `border:3px solid ${gold}`,
    'border-radius:2px',
  ].join(';');

  const head = `color:${gold};font:700 13px monospace`;
  const key = `color:${electric};font:700 13px monospace`;
  const txt = `color:${paper};font:13px monospace`;

  console.log('%c COMIC ZOMBIES  ·  BUILD 009  ·  THE ARSENAL ', title);
  console.log(
    `%cMOVE%c  WASD   %cSPRINT%c  SHIFT   %cJUMP%c  SPACE   %cSLIDE%c  TAP CTRL   %cDIVE%c  HOLD CTRL`,
    key, txt, key, txt, key, txt, key, txt, key, txt,
  );
  console.log(
    `%cFIRE%c  LMB   %cADS%c  RMB   %cRELOAD%c  R   %cACTIVE RELOAD%c  TAP R AGAIN IN THE GOLD ZONE`,
    key, txt, key, txt, key, txt, key, txt,
  );
  console.log(
    `%cSWAP WEAPON%c  Q or MOUSE WHEEL   %cCYCLE THE ARSENAL%c  J  (debug — until wall-buys exist)`,
    key, txt, key, txt,
  );
  console.log(
    `%cTAKE A BOON%c  1 / 2 / 3 (or aim and click)   %cRUN IT BACK%c  SPACE on the back cover`,
    key, txt, key, txt,
  );
  console.log(
    `%cSPAWN 1%c  N   %cSPAWN 10%c  M   %cKILL ALL%c  K   %c+5 AROUND YOU%c  Z   %cFILL TO 25%c  X   %cCLEAR%c  B`,
    key, txt, key, txt, key, txt, key, txt, key, txt, key, txt,
  );
  console.log(
    `%cPAUSE%c  P / ESC   %cDEBUG%c  \`   %cNAV DRAW%c  F8   %cQUALITY%c  F1 F2 F3 F4   ` +
    `%cA/B THE INK%c  F5   %cCOMFORT%c  F7`,
    key, txt, key, txt, key, txt, key, txt, key, txt, key, txt,
  );
  console.log(
    `%cSTART%c  quality ${quality.toUpperCase()} · arena ${draws} draw calls · ${(tris / 1000).toFixed(0)}k tris · sim ${Math.round(1 / FIXED_DT)}Hz`,
    head, txt,
  );
  console.log(
    `%cSEED%c  %c0x${seed.toString(16).padStart(8, '0')}%c  — replay this exact run with ` +
    `%c?seed=0x${seed.toString(16)}%c on the URL`,
    head, txt, key, txt, key, txt,
  );
  console.log(
    `%cTHE LOOP%c  %cCZ.skipToRound(7)%c · %cCZ.offerBoons()%c · %cCZ.giveBoon('ink_pact')%c · %cCZ.die()`,
    head, txt, key, txt, key, txt, key, txt, key,
  );
  console.log(
    `%cwindow.CZ%c  live handle — %cCZ.spawn(10)%c · %cCZ.spawnNear(5)%c · %cCZ.killAll()%c · %cCZ.stats()`,
    head, txt, key, txt, key, txt, key, txt, key,
  );
  console.log(
    `%cM3.5%c  %cCZ.camp('roof_ne')%c then %cCZ.spawnStreet(15)%c — they come up. ` +
    `%cCZ.nav.stats%c · %cCZ.sound('kill_crit')%c · %cCZ.navDraw.mode='field'`,
    head, txt, key, txt, key, txt, key, txt, key, txt, key,
  );
  console.log(
    `%cBUILD 009%c  %cCZ.setEscalation(20)%c paints round 20's NIGHT without playing it ` +
    `(no argument = back to live). %cCZ.skipToRound(10)%c is the gameplay half.`,
    head, txt, key, txt, key, txt,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

boot().catch((err: unknown) => {
  console.error('%c[COMIC ZOMBIES] boot failed', `color:${css('HOT')};font-weight:700`, err);
  const el = document.getElementById('boot-cta');
  if (el) el.textContent = 'BOOT FAILED — SEE CONSOLE';
});

export { PALETTE };

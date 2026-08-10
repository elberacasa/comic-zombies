/**
 * ENEMY AI — steering, not pathfinding, and the five-state machine on top of it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WHY STEERING. A* would produce a horde that finds the optimal route, arrives as a thin
 *  optimal stream, and is *not fun to kite*. The classic Zombies skill — training a horde into
 *  a conga line and running it around a loop — only exists because the horde is a fluid: it
 *  seeks, it clumps, it grinds along walls, and it takes a readable, predictable, slightly
 *  stupid line that a player can learn to exploit. Clumping is a FEATURE (GAME_BIBLE §4).
 *
 *  Four forces, summed every decision tick:
 *
 *    SEEK + WALL AVOID    `ctx.world.steer(from, to, out)` — seven short whisker rays that pick
 *                         the clearest lane toward the player. The world owns this because the
 *                         world owns the octree; AI never raycasts the arena itself.
 *    SEPARATION           push away from neighbours inside `ENEMY.separationRadius`…
 *    CONGA RELIEF         …except from the neighbour DIRECTLY between you and the player, whose
 *                         separation is cut to `SCHED.congaRelief`. That single exception is
 *                         what turns a pushing blob into a queue, and the queue is the thing
 *                         the whole kiting skill is built on. Without it a horde spreads into
 *                         a crescent and surrounds you; with it, it strings out behind you and
 *                         can be trained around the arena's kite loops A–G.
 *    CONGA FOLLOW         …and relief alone only stops a queue being torn apart; it never BUILDS
 *                         one. The gap it left was corners: every body aims at the player's
 *                         CURRENT position, so the moment the player turns, the whole horde cuts
 *                         the corner at once and the line becomes a fan. A body that has a
 *                         LEADER — a neighbour ahead of it, closer to the player, roughly on its
 *                         own line — now steers partly at the LEADER instead, so the horde walks
 *                         the path you walked. Measured A/B (`tools/combat.mjs conga`): the
 *                         unbroken queue goes 4.8 → 6.0 bodies at R1, 4.2 → 5.6 at R10 and
 *                         4.3 → 6.3 at R15, and the pack narrows across its line of travel.
 *                         See `SCHED.congaFollowWeight` for why this is NOT pathfinding.
 *
 *  THE ARENA'S LOOPS (see the header of `world/arena.ts`) are what this has to work on:
 *    A ring boulevard (~440 m lap) · B plaza circuit (~150 m) · C figure-eight through any of
 *    eight radial-street junctions · D east vertical · E west depot arcade · F west high route ·
 *    G south parkour.
 *
 *  ═══ BUILD 005: THE PART OF THIS HEADER THAT WAS WRONG ═══
 *  This file used to claim that A/B/C/E were the horde's loops and that D/F/G — the vertical
 *  routes — were "vertical player-only escapes, and the horde correctly loses you on them…
 *  That asymmetry is the level design working, not a bug." It was a bug, and the playtester
 *  named it on sight: *"we could make better zombies, like they dont go up stairs or things so
 *  u can just camp top of a building or fountain"*. A route the horde structurally cannot take
 *  is not an escape, it is a win button. Steering is a LOCAL operator — it can follow ground
 *  that rises under a body, but it has no way to know a stair exists 40 m away.
 *
 *  So route choice moved OUT of this file and into `world/nav.ts`: a walkable-surface graph
 *  with vertical links, and one flow field over it. What stayed here is everything that makes
 *  the horde feel like a horde. The graph only ever changes WHERE an agent steers; it never
 *  steers. On flat ground against a flat-ground player the graph is not even consulted
 *  (`NAV.heightTrigger`), so the conga line, the clumping and every trained loop below are
 *  bit-for-bit BUILD 004's.
 *
 *  TURN RATE is the other half of kite-ability: `ENEMY.turnRateDeg` (240°/s) is fast enough to
 *  feel relentless and slow enough that cutting a corner GAINS you metres. Uncapped turning
 *  makes a horde that tracks you perfectly, and a horde that tracks you perfectly cannot be
 *  trained.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ZERO ALLOCATION. Everything below writes into caller-supplied vectors or module scratch.
 * This runs 25 times per fixed step at 120 Hz.
 */

import { Vector3 } from 'three';
import { DEG2RAD, clamp01, shortestAngle, yawFromDirection } from '@/core/mathx';
import { ENEMY } from '@/game/tuning';
import { SCHED, type EnemyStateName } from '@/game/enemies/defs';
import type { WorldService } from '@/core/types';

// ── module scratch ──────────────────────────────────────────────────────────
const _toN = new Vector3();
const _seek = new Vector3();

/** The minimum any AI needs to know about a neighbour. `Enemy` satisfies this structurally. */
export interface Neighbour {
  readonly position: Vector3;
  readonly alive: boolean;
  readonly radius: number;
  /**
   * Horizontal distance from this neighbour to the player, as of this step. It is what orders
   * the conga line: "closer to the player than me" is how a body decides who it is queueing
   * BEHIND, and because that order is strict the follow graph can never contain a cycle.
   */
  readonly distToPlayer: number;
}

/**
 * The state of one agent, as the AI sees it. `Enemy` in `service.ts` implements this
 * structurally — no import in that direction, so there is no cycle.
 */
export interface AiAgent {
  state: EnemyStateName;
  /** Seconds in the current state. */
  stateT: number;
  /** Seconds elapsed inside the current melee swing (wind-up + strike). */
  attackT: number;
  /** Seconds until another swing is allowed. */
  cooldownT: number;
  /** Horizontal distance to the player, refreshed by the service each step. */
  distToPlayer: number;
  /** Vertical separation from the player — a zombie cannot swing at a roof. */
  heightToPlayer: number;
  /** Set by `HitReactions`. Non-zero means it is being staggered. */
  staggerT: number;
  /** False once both arms are shot off. */
  canMelee: boolean;
  /** Behaviour archetype — the state machine branches on it. */
  role: 'melee' | 'screamer';
  /** Screamer: metres it holds at, and the wind-up / cooldown of its call. */
  standoff: number;
  screamWindup: number;
  screamCooldown: number;
  /**
   * Multiplier on the next swing cooldown, ~1 ± `ENEMY.meleeCooldownJitter`. Re-rolled by the
   * service every time a swing ends, which is what stops a pack that arrived together from
   * swinging as one body forever. See `ENEMY.meleeCooldownJitter`.
   */
  swingJitter: number;
  readonly position: Vector3;
  readonly velocity: Vector3;
  /** Unit XZ heading the agent wants to travel. */
  readonly desired: Vector3;
  /** Facing, radians about +Y. -Z is forward, matching the camera convention. */
  yaw: number;

  // ── the unstick detector (see `tickUnstick`) ─────────────────────────────────────────────
  /** Seconds of sustained "asking to move, not moving". */
  wedgeT: number;
  /** Seconds accumulated toward the next displacement sample. */
  wedgeSampleT: number;
  /** Where the body was when the current sample window opened. */
  wedgeRefX: number;
  wedgeRefZ: number;
  /** Seconds of tangential detour left. `> 0` means the seek heading is being rotated. */
  detourT: number;
  /** Which way the detour turns. Flips each trip so a body that guesses wrong tries the other. */
  detourSign: number;
  /** Detours tripped since the last time this body actually travelled. The rescue escalator. */
  wedgeTrips: number;
}

/** What the service must react to after `stepState`. Everything with a side effect lives there. */
export type AiAction = 'none' | 'windup' | 'strike' | 'recover' | 'screamStart' | 'scream';

// ═════════════════════════════════════════════════════════════════════════════
// Steering
// ═════════════════════════════════════════════════════════════════════════════

/**
 * SEPARATION **and** THE FOLLOW HEADING, in one pass over the neighbours.
 *
 * `sep` is the classic push-apart force, with the conga relief applied to whoever is directly
 * between me and the player. `follow` is the new half (see `SCHED.congaFollowWeight`): a unit
 * XZ heading toward the nearest LEADER — a neighbour ahead of me, measurably closer to the
 * player, and roughly on my own line to them. It is zero when I am at the head of the line.
 *
 * ONE LOOP, because this runs `steerHz × aliveCount` times a second and a second pass over 25
 * bodies to find a leader would cost more than the seven octree rays it is helping.
 *
 * `toPlayer` must be the unit XZ direction from `self` to the player; it is what lets a
 * neighbour be recognised as "the one I am queueing behind" rather than "the one crushing me".
 * `selfDist` is the caller's own `distToPlayer`; pass 0 to disable the follow term entirely
 * (nothing can be closer to the player than 0, so no leader is ever found).
 */
export function crowdInto(
  sep: Vector3,
  follow: Vector3,
  self: Vector3,
  selfIndex: number,
  selfDist: number,
  toPlayer: Vector3,
  neighbours: readonly Neighbour[],
  count: number,
): void {
  sep.set(0, 0, 0);
  follow.set(0, 0, 0);

  const r = ENEMY.separationRadius;
  const cull = SCHED.neighbourRadius * SCHED.neighbourRadius;
  const followCull = SCHED.congaFollowRadius * SCHED.congaFollowRadius;
  // A leader must be strictly nearer the player than I am. Zero `selfDist` makes this negative,
  // which nothing can satisfy — the documented "no follow" path.
  const leadMax = selfDist - SCHED.congaFollowLead;

  let bestD2 = Infinity;
  let bestX = 0;
  let bestZ = 0;

  for (let i = 0; i < count; i++) {
    if (i === selfIndex) continue;
    const n = neighbours[i];
    if (!n.alive) continue;
    const dx = self.x - n.position.x;
    const dz = self.z - n.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 1e-6) continue;
    if (d2 > cull && d2 > followCull) continue;
    const d = Math.sqrt(d2);
    // Unit heading from ME toward this neighbour, and how well it agrees with my line to the
    // player. Both halves below need it, so it is computed once.
    const tx = -dx / d;
    const tz = -dz / d;
    const alignment = tx * toPlayer.x + tz * toPlayer.z;

    if (d2 <= cull) {
      const overlap = r + n.radius - d;
      if (overlap > 0) {
        // THE CONGA EXCEPTION. If this neighbour is between me and the player, I am not being
        // crushed — I am in a queue. Cutting separation here is what makes the horde trainable.
        const relief = alignment > SCHED.congaCos ? SCHED.congaRelief : 1;
        const push = (overlap / Math.max(r, 1e-3)) * relief;
        sep.x += (dx / d) * push;
        sep.z += (dz / d) * push;
      }
    }

    // THE LEADER. Nearest neighbour that is ahead of me on my own line, closer in, and ON MY
    // OWN LEVEL — see `SCHED.congaFollowRise`. Queueing behind someone up a staircase steers me
    // into the side of it.
    if (d2 <= followCull && d2 < bestD2
      && n.distToPlayer < leadMax
      && alignment > SCHED.congaFollowCos
      && Math.abs(n.position.y - self.y) <= SCHED.congaFollowRise) {
      bestD2 = d2;
      bestX = tx;
      bestZ = tz;
    }
  }

  if (bestD2 < Infinity) {
    follow.x = bestX;
    follow.z = bestZ;
  }
}

/**
 * The full steering decision: a wall-avoiding seek toward `target`, plus separation and the
 * conga follow heading, normalised into a unit XZ heading. Costs seven octree rays (inside
 * `world.steer`), which is why the service only calls this at `SCHED.steerHz` on a round-robin
 * slice and integrates the result every step in between.
 *
 * `follow` may be zero-length (the body at the head of the line), in which case this is exactly
 * BUILD 006's steering.
 */
export function steerInto(
  out: Vector3,
  world: WorldService,
  self: Vector3,
  target: Vector3,
  separation: Vector3,
  follow: Vector3,
): Vector3 {
  world.steer(self, target, _seek);
  const fw = SCHED.congaFollowWeight;
  out.set(
    _seek.x * ENEMY.seekWeight + separation.x * ENEMY.separationWeight + follow.x * fw,
    0,
    _seek.z * ENEMY.seekWeight + separation.z * ENEMY.separationWeight + follow.z * fw,
  );
  const len = Math.hypot(out.x, out.z);
  if (len < 1e-5) {
    // Boxed in on every side: keep the last heading rather than snapping to an axis, or a
    // packed horde jitters between two directions and reads as broken.
    return out.copy(_seek);
  }
  out.x /= len;
  out.z /= len;
  out.y = 0;
  return out;
}

/**
 * Accelerate toward `desired * speed` and hold the horizontal speed cap. `ENEMY.steerAccel` is
 * high (22 m/s²) on purpose — a shambler is slow at the TOP end, not sluggish to start, and a
 * mushy start makes the horde feel like it is on ice rather than lurching.
 */
export function integrateVelocity(
  velocity: Vector3, desired: Vector3, speed: number, accel: number, dt: number,
): void {
  const tx = desired.x * speed;
  const tz = desired.z * speed;
  const k = clamp01(accel * dt / Math.max(0.001, Math.hypot(tx - velocity.x, tz - velocity.z)));
  velocity.x += (tx - velocity.x) * k;
  velocity.z += (tz - velocity.z) * k;
  const s = Math.hypot(velocity.x, velocity.z);
  if (s > speed) {
    velocity.x *= speed / s;
    velocity.z *= speed / s;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE UNSTICK — a horde that flows must never be able to stop flowing
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Detect a wedged body and put it on a tangential detour.
 *
 * THE BUG THIS EXISTS FOR (BUILD 004 blocker). `steerInto` avoids walls with whiskers, and the
 * service's `collideCapsule` backstop pushes a penetrating body back out. Between them there is
 * a stable fixed point: the steer says "forward", the integration moves the body 2 cm into the
 * kerb, and the correction moves it 2 cm back. Velocity reads a healthy 1.6–1.8 m/s forever and
 * the body never travels. Measured on four live shamblers: position delta 0.000 / 0.001 / 0.145 /
 * 0.002 m over 2.0 sim seconds; 15–20% of an open-ground release of 20 never arrived at all.
 * Since `RoundSystem` only leaves `active` at `aliveCount === 0`, one of these ends the round.
 *
 * WHY DISPLACEMENT AND NOT A CONTACT NORMAL. The wedge is not always a wall — it is equally
 * often a body pinned between the arena bound clamp and a neighbour, or standing on a kerb lip
 * the ground follow keeps re-seating. Sampling "did you actually go anywhere" catches every
 * cause with one test and cannot be fooled by a normal that looks fine.
 *
 * Call once per fixed step per agent, AFTER integration and collision, with the speed the state
 * machine asked for this step. Costs one hypot per `ENEMY.wedgeSample` seconds per body.
 *
 * RETURNS true on the step a wedge TRIPS. BUILD 005 hangs the mantle probe off that edge: the
 * commonest wedge in a city arena is a body pressed against something it should have climbed,
 * and climbing it is the only response that gets the body where it was trying to go. The caller
 * tries the mantle first and only falls through to the tangential detour if there is no ledge.
 */
export function tickUnstick(a: AiAgent, dt: number, wantSpeed: number): boolean {
  // A detour in flight: run it down and hold the detector open.
  if (a.detourT > 0) {
    a.detourT -= dt;
    if (a.detourT <= 0) a.detourT = 0;
    resetWedge(a);
    return false;
  }

  // Only a body that is TRYING to travel can be wedged. Spawning, staggered, climbing and
  // mid-swing bodies are standing still on purpose and must never be nudged for it.
  //
  // …WITH ONE EXCEPTION, and it is the BUILD 006 blocker. A `chase` body asking for ~zero speed
  // while it is nowhere near the player is not standing still on purpose — it is frozen, and
  // gating the detector on `wantSpeed` alone made that failure structurally unreachable by the
  // whole mantle → detour → detour → rescue escalator. So a chaser that is out of the fight
  // (further than melee reach, or separated vertically) stays under observation whatever speed
  // it asked for; if it genuinely travels, `stuck` is false and nothing fires.
  const stalledChaser = a.state === 'chase'
    && (a.distToPlayer > ENEMY.meleeRange
      || Math.abs(a.heightToPlayer) > ENEMY.verticalMeleeGate);
  if (a.state !== 'chase' || (wantSpeed < ENEMY.wedgeMinSpeed && !stalledChaser)) {
    a.wedgeT = 0;
    resetWedge(a);
    return false;
  }

  a.wedgeSampleT += dt;
  if (a.wedgeSampleT < ENEMY.wedgeSample) return false;

  const moved = Math.hypot(a.position.x - a.wedgeRefX, a.position.z - a.wedgeRefZ);
  const stuck = moved / a.wedgeSampleT < ENEMY.wedgeMinProgress;
  a.wedgeT = stuck ? a.wedgeT + a.wedgeSampleT : 0;
  // A body that is genuinely travelling again has escaped: forget the whole episode, so the
  // rescue escalator can only ever fire on a body that has failed to move for a long time.
  if (!stuck) a.wedgeTrips = 0;
  resetWedge(a);

  if (a.wedgeT >= ENEMY.wedgeTrip) {
    a.wedgeT = 0;
    a.detourT = ENEMY.wedgeDetourTime;
    a.detourSign = a.detourSign > 0 ? -1 : 1;
    a.wedgeTrips++;
    return true;
  }
  return false;
}

function resetWedge(a: AiAgent): void {
  a.wedgeSampleT = 0;
  a.wedgeRefX = a.position.x;
  a.wedgeRefZ = a.position.z;
}

/**
 * Rotate a seek heading onto the blocker's tangent. Applied to `desired` on the steer slice
 * while `detourT > 0`: the body stops pressing into whatever is holding it and walks along it,
 * which is what a real crowd does at a doorway. `separation` and the wall whiskers still shape
 * the input, so this bends the decision rather than replacing it.
 */
export function detourInto(out: Vector3, sign: number): Vector3 {
  const t = ENEMY.wedgeDetourDeg * DEG2RAD * (sign >= 0 ? 1 : -1);
  const c = Math.cos(t);
  const s = Math.sin(t);
  const x = out.x * c - out.z * s;
  const z = out.x * s + out.z * c;
  out.x = x;
  out.z = z;
  out.y = 0;
  return out;
}

/** Rotate `yaw` toward `dir` at no more than `ENEMY.turnRateDeg` per second. */
export function turnToward(yaw: number, dir: Vector3, dt: number): number {
  if (Math.abs(dir.x) < 1e-6 && Math.abs(dir.z) < 1e-6) return yaw;
  _toN.set(dir.x, 0, dir.z);
  const want = yawFromDirection(_toN);
  const max = ENEMY.turnRateDeg * DEG2RAD * dt;
  const delta = shortestAngle(yaw, want);
  return yaw + (delta > max ? max : delta < -max ? -max : delta);
}

// ═════════════════════════════════════════════════════════════════════════════
// The state machine:  spawn → chase → attack → stagger → death
// ═════════════════════════════════════════════════════════════════════════════

/** The moment inside a swing where the damage lands: the end of the wind-up. */
export const STRIKE_AT = ENEMY.meleeWindup;
/** Total swing length: the tell, plus the follow-through. */
export const SWING_TIME = ENEMY.meleeWindup + 0.26;

/**
 * Advance one agent's state and report anything the service has to act on.
 *
 * The single most important line in this function is the `attack` entry condition, and it is
 * deliberately *generous to the player*: the swing commits at `attackT >= STRIKE_AT` and only
 * lands if the player is still inside `meleeRange * 1.12` at that instant. The wind-up is
 * 0.42 s; a walking player covers 2.27 m in that time and the reach is 1.9 m. **Every hit you
 * take is a hit you could have walked out of** — which is what makes being surrounded read as
 * your mistake instead of as the game cheating.
 */
export function stepState(a: AiAgent, dt: number, spawnTime: number): AiAction {
  a.stateT += dt;
  if (a.cooldownT > 0) a.cooldownT = Math.max(0, a.cooldownT - dt);

  switch (a.state) {
    case 'spawn':
      if (a.stateT >= spawnTime) enter(a, 'chase');
      return 'none';

    case 'chase': {
      if (a.staggerT > 0) { enter(a, 'stagger'); return 'none'; }

      // ── THE SCREAMER never swings. It holds at `standoff` and calls for help. ──
      //
      // The player's job stops being "shoot the nearest thing" and becomes "break the kite, pick
      // the one that matters, kill it, get back on the line". That is the priority-target
      // pressure GAME_BIBLE §4 asks for, and the wind-up is deliberately long enough to be
      // punished from across the arena — an unpunishable summon is just a tax.
      if (a.role === 'screamer') {
        if (a.cooldownT <= 0 && a.distToPlayer <= a.standoff
          && Math.abs(a.heightToPlayer) <= SCHED.screamMaxRise) {
          enter(a, 'scream');
          return 'screamStart';
        }
        return 'none';
      }

      if (canSwing(a)) {
        enter(a, 'attack');
        a.attackT = 0;
        return 'windup';
      }
      return 'none';
    }

    case 'scream': {
      // Interruptible on purpose: a hit hard enough to stagger it cancels the call entirely, so
      // shooting the screamer is a real answer and not merely a race against its timer.
      if (a.staggerT > 0) { enter(a, 'stagger'); a.cooldownT = a.screamCooldown * 0.5; return 'none'; }
      if (a.stateT >= a.screamWindup) {
        enter(a, 'chase');
        a.cooldownT = a.screamCooldown;
        return 'scream';
      }
      return 'none';
    }

    case 'attack': {
      // A heavy enough hit cancels the swing outright (see `reactions.ts::INTERRUPT_IMPULSE`).
      if (a.staggerT > 0) {
        enter(a, 'stagger');
        a.cooldownT = ENEMY.meleeCooldown * 0.5 * a.swingJitter;
        return 'recover';
      }
      const was = a.attackT;
      a.attackT += dt;
      if (was < STRIKE_AT && a.attackT >= STRIKE_AT) return 'strike';
      if (a.attackT >= SWING_TIME) {
        a.cooldownT = ENEMY.meleeCooldown * a.swingJitter;
        enter(a, 'chase');
        return 'recover';
      }
      return 'none';
    }

    case 'stagger': {
      if (a.staggerT <= 0) enter(a, 'chase');
      return 'none';
    }

    // The service owns the climb entirely — it is the only module that can move a body through
    // geometry. All the state machine does is refuse to interrupt it.
    case 'climb':
      return 'none';

    case 'death':
      return 'none';
  }
}

function canSwing(a: AiAgent): boolean {
  return a.canMelee
    && a.cooldownT <= 0
    && a.distToPlayer <= ENEMY.meleeRange
    // A zombie on the plaza cannot swing at a player on the 6.8 m roof deck. Vertical routes
    // are a real escape (arena loops D/F/G), and they only work if the horde respects height.
    && Math.abs(a.heightToPlayer) < ENEMY.verticalMeleeGate;
}

/** True when the swing that is mid-flight actually connects. */
export function strikeConnects(a: AiAgent): boolean {
  return a.distToPlayer <= ENEMY.meleeRange * 1.12 && Math.abs(a.heightToPlayer) < 1.9;
}

export function enter(a: AiAgent, state: EnemyStateName): void {
  a.state = state;
  a.stateT = 0;
}

/**
 * CONTACT STANDOFF — how much of its speed an agent keeps as it reaches the player's body.
 *
 * INTEGRATION FIX (BUILD 003). Separation pushes an agent away from its NEIGHBOURS; nothing in
 * the steering stack ever pushes it away from the PLAYER, and `seek` aims at the player's exact
 * position. A shambler in `attack` still creeps at `windupSpeedMult` (0.22×), so every swing
 * cycle walks it a little further in. Measured with a stationary player and eight attackers:
 * bodies at 0.05 / 0.41 / 0.43 / 0.46 / 0.94 m — the nearest one's torso was INSIDE the near
 * plane, and since the inverted-hull outline renders back-faces, the frame filled with flat
 * ACID green. Being swarmed is meant to be terrifying, not opaque.
 *
 * The stop distance is `ENEMY.separationRadius` — the same body radius the horde already keeps
 * from itself, so no new feel constant is introduced and the player is simply treated as one
 * more body in the crowd. It sits well inside `meleeRange` (1.9 m) and `strikeConnects`
 * (2.13 m), so nothing about the melee threat changes. The ramp is 0.6 m wide: they decelerate
 * into you and press, rather than stopping dead on a line.
 *
 * ═══ BUILD 006 BLOCKER: THE STANDOFF WAS MEASURING THE WRONG DISTANCE ═══
 * `distToPlayer` is HORIZONTAL (`service.ts` builds it with y zeroed). So a body that walked
 * under a player camping 6 m up on a roof read as "0.4 m from the player", got `stateSpeedMult`
 * 0, and stopped forever. It could not swing (`canSwing` needs |height| < 1.7), it could not be
 * shot (no line of sight from the camp spot straight down through the deck), and it was
 * structurally invisible to the unstick escalator, which only arms above `wedgeMinSpeed`. Since
 * `RoundSystem` only leaves `active` at `aliveCount === 0`, that is a stranded round — measured
 * at 4 of 25 bodies within 30 s of a normal catwalk camp.
 *
 * The standoff exists for exactly one reason: keep a torso out of the camera's near plane. Six
 * metres of vertical separation already does that, so above `ENEMY.verticalMeleeGate` — the same
 * gate `canSwing` uses to decide you are not in the same fight — the standoff simply does not
 * apply and the body keeps walking to the stairs.
 */
function contactFactor(distToPlayer: number, heightToPlayer: number): number {
  if (Math.abs(heightToPlayer) > ENEMY.verticalMeleeGate) return 1;
  return clamp01((distToPlayer - ENEMY.separationRadius) / 0.6);
}

/**
 * How fast this agent should be moving right now, before per-instance and director scaling.
 * The `lunge` term is the "it noticed you" beat: a shambler closing the last few metres speeds
 * up, which is what turns a slow horde into a genuine threat at contact range without ever
 * making it faster than the player across a street.
 */
export function stateSpeedMult(a: AiAgent, lungeMult: number, windupMult: number): number {
  switch (a.state) {
    case 'spawn': return 0;
    // Staggered enemies keep drifting — a hard stop reads as a freeze frame, not as a stumble.
    // Knockback rides on `push`, which is outside this multiplier, so a shot still moves them.
    case 'stagger': return 0.25 * contactFactor(a.distToPlayer, a.heightToPlayer);
    case 'attack': return windupMult * contactFactor(a.distToPlayer, a.heightToPlayer);
    // A climbing body's position is driven by the climb curve, not by velocity. Asking for zero
    // here also keeps `tickUnstick` quiet, so a slow mantle can never be mistaken for a wedge.
    case 'climb': return 0;
    case 'death': return 0;
    default: {
      const close = 1 - clamp01((a.distToPlayer - ENEMY.meleeRange) / 3.5);
      return (1 + (lungeMult - 1) * close) * contactFactor(a.distToPlayer, a.heightToPlayer);
    }
  }
}

/**
 * MOTION — THE ONE SWEPT-CAPSULE MOVER. Used by the player and by every zombie.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS (BUILD 006 blocker, playtester complaints 1, 3 and 4).
 *
 *  Three symptoms, one cause: *the vertical axis was never collided.*
 *
 *  • THE PLAYER FLOATED. `PlayerController.grounded` was only ever set to TRUE — by the collision
 *    resolve, the step-up and the mantle — and only ever cleared by a JUMP, a dive or a vault.
 *    Nothing derived it from the world. So walking off a ledge left `grounded` true, `groundMove`
 *    clamped `velocity.y` to 0, `applyGravity` early-returned on `grounded && vy <= 0`, and the
 *    player kept walking at the height of whatever they had last stood on until they pressed
 *    jump. MEASURED before this file: 17 ledges in the arena from 0.7 m to 34 m, walked off with
 *    W held — 0 of 17 fell, every one of them floated for the full 3.61 s of the test.
 *    `settleGround()` could never fire either, because its first line was `if (grounded) return`.
 *
 *  • THE HORDE HAD NO PHYSICS AT ALL. `EnemySystem` sampled `world.groundAt()` at `SCHED.groundHz`
 *    (12 Hz) and lerped `position.y` toward it. A 12 Hz probe is ~16 cm of blind travel at chase
 *    speed, so every kerb, stair nose and ramp made a body stutter and re-plan (complaint 1); and
 *    `groundAt` happily returns the height of a LEDGE OR AWNING OVERHEAD, so the body was lifted
 *    INTO solid geometry and, because the capsule correction only ever applied X and Z, nothing
 *    could ever push it back out (complaint 4). MEASURED before this file, 25 bodies × 120 s:
 *    8 bodies inside geometry on the flat test (worst overlap 1.14 m), 10 on the camp test, and
 *    11 bodies stalled while chasing for more than 2 s (worst single stall 56 s).
 *
 *  So: one mover, continuous, every fixed step, no sampling.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT IT DOES, IN ORDER, ONCE PER FIXED STEP:
 *   1. sweep the capsule along `velocity * dt`, substepped so nothing tunnels
 *   2. depenetrate against the world after every substep, in ALL THREE AXES
 *   3. derive `grounded` FROM THAT RESULT — never from a flag somebody remembered to set
 *   4. step up over anything shorter than `stepHeight` that blocked the sweep
 *   5. snap back down onto ground within `groundSnapDistance` if we just left it
 *   6. (opt-in) refuse a horizontal step that would walk a routing body off a stair
 *
 * THE PLAYER'S FEEL IS THE REGRESSION TEST. Steps 1, 2, 4 and 5 are `PlayerController`'s own
 * code, moved here unchanged — same substep length, same iteration count, same step-up
 * heuristic (`progress > 0.7`), same snap thresholds, same `stepSmear` bookkeeping. The single
 * behavioural change is step 3, and step 3 is the bug.
 *
 * ZERO ALLOCATION. Everything works through module scratch; nothing here constructs anything.
 */

import { Vector3 } from 'three';
import type { CapsuleCollision, RaycastHit, WorldService } from '@/core/types';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module scratch. NEVER handed back to a caller.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const _bottom = new Vector3();
const _top = new Vector3();
const _delta = new Vector3();
const _substep = new Vector3();
const _before = new Vector3();
const _savePos = new Vector3();
const _saveVel = new Vector3();
const _origin = new Vector3();
const _probe = new Vector3();
const _guardFrom = new Vector3();
const _down = new Vector3(0, -1, 0);
const _corr = new Vector3();

/** Residual overlap left by the last `depenetrate()`. Module-level so nothing allocates. */
let _residual = 0;
/**
 * Upward velocity INJECTED BY THE SOLVER this call while sliding along walkable ground.
 * See `moveBody`'s epilogue for why it has to be given back. Reset every call.
 */
let _slideLift = 0;

/**
 * Diagnostic counters. The stairs harness asserts on these; nothing in the game reads them.
 * Plain numbers, incremented in place — no allocation, and free when nobody looks.
 */
export const COUNTERS = {
  /** Substeps whose depenetration was dominated by a NON-walkable push (the step-up trigger). */
  blocked: 0,
  /** Step-ups actually committed. */
  stepUps: 0,
  /** Depenetration corrections clamped by `maxCorrection` — i.e. teleports refused. */
  clamped: 0,
  /** Largest single correction, metres, seen since the last reset (pre-clamp). */
  worstCorrection: 0,
};

export function resetCounters(): void {
  COUNTERS.blocked = 0;
  COUNTERS.stepUps = 0;
  COUNTERS.clamped = 0;
  COUNTERS.worstCorrection = 0;
}
/**
 * `grounded` as it stood when the current `moveBody` call began. Deliberately NOT a caller-
 * supplied param: the snap and the ledge guard must key off what the body ACTUALLY had under it
 * one instant ago, and that is not something a caller should be able to get wrong.
 */
let _wasGrounded = false;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Contracts
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Anything the mover can move. `PlayerController` and `Enemy` both satisfy this structurally,
 * so neither system imports the other and neither has to be reshaped around the solver.
 */
export interface MotionBody {
  /** FEET position. The capsule spans [y + radius, y + height - radius]. */
  readonly position: Vector3;
  readonly velocity: Vector3;
  /** Normal of whatever we are standing on. Only meaningful while `grounded`. */
  readonly groundNormal: Vector3;
  height: number;
  radius: number;
  /** DERIVED every step by `moveBody`. Do not set it yourself except to force a takeoff. */
  grounded: boolean;
  /**
   * Vertical debt owed to presentation by a step-up or a ground snap: the collider really does
   * teleport, and the camera (or the mesh) pays it back smoothly so stairs are invisible.
   */
  stepSmear: number;
}

/**
 * Per-call motion settings. Callers own ONE of these and mutate it in place — constructing one
 * per step would allocate 25 objects per fixed step at 120 Hz.
 */
export interface MotionParams {
  /** Rise absorbed by walking. Curbs, rubble, stair treads. */
  stepHeight: number;
  /** cos of the steepest walkable slope. Must match what `WorldService` was built with. */
  minGroundNormalY: number;
  /** How far the mover will glue back down when it runs off a crest or a ramp. */
  groundSnapDistance: number;
  /** Max distance moved per collision substep. Keep below `radius` or fast bodies tunnel. */
  maxSubstepDistance: number;
  /** Hard cap on substeps per call, so a teleport-sized delta cannot eat a frame. */
  maxSubsteps: number;
  /** Depenetration iterations per substep. 4 resolves a 3-plane corner with margin. */
  iterations: number;
  /**
   * HARD CAP on a single depenetration correction, metres. Defence in depth against a solver
   * that reports an escape rather than a contact (see `world/collision.ts::enclosed`).
   *
   * MEASURED, and the two values are NOT interchangeable. The player ships at 0.5 because a
   * correction bigger than that is always a bug and the human feels it instantly as a teleport.
   * The horde ships at the 1.5 default because clamping bodies to 0.5 stops them ever escaping a
   * wall they are genuinely inside: roof-camp inside-geometry samples went 426 → 4394 and the
   * worst stall 2.7 s → 10.1 s. A stuck zombie is worse than a fast one.
   */
  maxCorrection: number;
  /** Extra world velocity applied to TRANSLATION only (knockback). Not slid along walls. */
  driftX: number;
  driftZ: number;
  /** May this call step up? The player gates it on `grounded || coyote > 0`. */
  canStepUp: boolean;
  /** May this call snap down? The player refuses mid-dive and just after a jump. */
  canSnap: boolean;
  /**
   * LEDGE GUARD (horde only). Refuse a horizontal step that would drop this body off the thing
   * it is walking on. The player must ALWAYS be allowed to fall, so this is opt-in and the
   * player never opts in.
   */
  ledgeGuard: boolean;
}

/** A sane starting point. Copy it and override; never share one instance between two bodies. */
export function makeMotionParams(): MotionParams {
  return {
    stepHeight: 0.45,
    minGroundNormalY: 0.6,
    groundSnapDistance: 0.45,
    maxSubstepDistance: 0.3,
    maxSubsteps: 8,
    iterations: 4,
    maxCorrection: 1.5,
    driftX: 0,
    driftZ: 0,
    canStepUp: true,
    canSnap: true,
    ledgeGuard: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Write the two SPHERE CENTRES of a feet-anchored capsule into `_bottom` / `_top`. */
function capsuleFor(pos: Vector3, height: number, radius: number): void {
  _bottom.set(pos.x, pos.y + radius, pos.z);
  _top.set(pos.x, pos.y + Math.max(height - radius, radius + 0.01), pos.z);
}

/**
 * How deep a capsule placed at `pos` is inside the world, metres. 0 means clear.
 * The posture blend, the vault probe and the step-up all ask this before committing.
 */
export function capsuleOverlapDepth(
  world: WorldService, pos: Vector3, height: number, radius: number,
): number {
  capsuleFor(pos, height, radius);
  const c = world.collideCapsule(_bottom, _top, radius);
  return c ? c.depth : 0;
}

/**
 * Push the body out of the world and DERIVE `grounded` from what it touched.
 * Returns true when something that is not ground blocked us — the step-up trigger.
 *
 * ═══ THE ONE-LINE BUG (BUILD 006) ═══
 * The controller version read `if (!c || c.depth <= 1e-5) break;` and only looked at
 * `c.grounded` several lines further down. A body resting cleanly on a floor has depth ~0 — the
 * solver pushed it out last step and it has not moved into anything since — so the loop broke
 * out BEFORE the ground flag was ever read, on every single step of normal walking. Combined
 * with `grounded` never being cleared, the flag simply latched true forever. Ground is read
 * FIRST here, before any early exit.
 *
 * ═══ THE SECOND ONE-LINE BUG ("i can't go upstairs"), FIXED HERE ═══
 * `blocked` used to be `else { blocked = true }` on `c.normal.y >= minGroundNormalY`. That test
 * COULD NEVER BE FALSE FOR A GROUNDED BODY, because `collideCapsule` ends with
 *     out.normal.copy(grounded ? _groundN : _bestN)
 * — a body standing on a stair and pressed 2 cm into the plinth in front of it gets back
 * `depth = 0.0215, grounded = true, normal = (0,1,0), correction = (0.021, 0, -0.006)`: a purely
 * HORIZONTAL push wearing a floor normal. `blocked` stayed false, so `tryStepUp` was
 * STRUCTURALLY UNREACHABLE — measured 0 calls across every flight in the arena.
 *
 * The CORRECTION is the honest signal: it is where the solver actually wants to move us. If it
 * is not mostly vertical, something that is not floor is in the way, whatever the normal claims.
 */
function depenetrate(world: WorldService, body: MotionBody, p: MotionParams): boolean {
  let blocked = false;
  _residual = 0;
  for (let i = 0; i < p.iterations; i++) {
    capsuleFor(body.position, body.height, body.radius);
    const c: CapsuleCollision = world.collideCapsule(_bottom, _top, body.radius);
    if (!c) break;

    // Ground first, and unconditionally. `c.grounded` covers the sticky probe (walking down a
    // stair) as well as a real floor contact, and `c.normal` is already the ground normal when
    // it is set — see `world/collision.ts`.
    if (c.grounded) {
      body.grounded = true;
      if (c.normal.y >= p.minGroundNormalY) body.groundNormal.copy(c.normal);
    }

    _residual = c.depth;
    if (c.depth <= 1e-5) break;

    // ── TELEPORT CLAMP ──────────────────────────────────────────────────────────────────────
    // A correction longer than `maxCorrection` is not a contact, it is an escape (see the
    // `enclosed()` guard in `world/collision.ts`). Take the direction, refuse the magnitude.
    _corr.copy(c.correction);
    const clen = _corr.length();
    if (clen > COUNTERS.worstCorrection) COUNTERS.worstCorrection = clen;
    if (clen > p.maxCorrection) {
      _corr.multiplyScalar(p.maxCorrection / clen);
      COUNTERS.clamped++;
    }
    body.position.add(_corr);

    // ── BLOCKED, FROM THE CORRECTION ────────────────────────────────────────────────────────
    // `c.correction` has length `c.depth`, so `correction.y / depth` is the cosine of the push
    // against vertical — exactly the quantity `minGroundNormalY` is expressed in. Multiplied out
    // to avoid the divide (and the depth==0 case is already returned above).
    if (c.correction.y < p.minGroundNormalY * c.depth) {
      blocked = true;
      COUNTERS.blocked++;
    }

    const n = c.normal;
    if (n.y >= p.minGroundNormalY) {
      body.grounded = true;
      body.groundNormal.copy(n);
    }
    // Kill only the component travelling INTO the surface: everything else slides along it.
    // Sliding along a WALKABLE slope converts horizontal speed into upward speed, which is
    // correct within the step and poison across steps — record it so the epilogue can undo it.
    const vn = body.velocity.dot(n);
    if (vn < 0) {
      const vyBefore = body.velocity.y;
      body.velocity.addScaledVector(n, -vn);
      if (n.y >= p.minGroundNormalY) _slideLift += body.velocity.y - vyBefore;
    }
  }
  return blocked;
}

/**
 * Classic step-up: if we lost most of our intended horizontal progress while grounded, retry the
 * same move from `stepHeight` higher and drop onto whatever is there. The collider teleports;
 * `stepSmear` is the debt presentation pays back smoothly, so stairs are invisible.
 *
 * Moved verbatim from `PlayerController.tryStepUp` — including the 0.7 progress threshold, the
 * headroom test and the `-0.02 / +0.02` tolerances. Do not "clean up" these numbers.
 */
function tryStepUp(
  world: WorldService, body: MotionBody, p: MotionParams, before: Vector3, step: Vector3,
): void {
  const wantX = step.x;
  const wantZ = step.z;
  const wantLen2 = wantX * wantX + wantZ * wantZ;
  if (wantLen2 < 1e-8) return;

  const gotX = body.position.x - before.x;
  const gotZ = body.position.z - before.z;
  const progress = (gotX * wantX + gotZ * wantZ) / wantLen2;
  if (progress > 0.7) return; // we basically made it; no step needed

  // TWO PROBE LENGTHS, LONG FIRST. `step` is one SUBSTEP, so at walking pace it can be under
  // 2 cm — probing that far forward lands the capsule back on the very obstacle that blocked it
  // and the step is refused. Reach a full radius ahead first so the probe clears the riser;
  // fall back to the honest substep length for the narrow ledges where a radius overshoots into
  // a wall. `wantLen` is only computed once.
  const wantLen = Math.sqrt(wantLen2);
  const dx = wantX / wantLen;
  const dz = wantZ / wantLen;
  if (attemptStep(world, body, p, before, dx, dz, Math.max(wantLen, body.radius))) return;
  if (wantLen < body.radius) attemptStep(world, body, p, before, dx, dz, wantLen);
}

/**
 * One step-up attempt at a given forward reach. Returns true when it committed.
 *
 * THE RAY BAND MATCHES THE ACCEPTANCE TEST. The old code cast `stepHeight + 0.15` from
 * `stepHeight + 0.05` above the start, so it could reach 0.10 m BELOW where we started — then
 * threw the hit away against `gained < -0.02`. The ray now stops exactly where the acceptance
 * band does, so the first surface it reports is a surface we can actually use.
 */
function attemptStep(
  world: WorldService, body: MotionBody, p: MotionParams,
  before: Vector3, dx: number, dz: number, reach: number,
): boolean {
  _savePos.copy(body.position);
  _saveVel.copy(body.velocity);

  _probe.set(before.x + dx * reach, before.y + p.stepHeight, before.z + dz * reach);
  if (capsuleOverlapDepth(world, _probe, body.height, body.radius) > 1e-3) return false;

  _origin.set(_probe.x, _probe.y + 0.05, _probe.z);
  const hit: RaycastHit = world.raycast(_origin, _down, p.stepHeight + 0.07);
  if (!hit || !hit.hit || hit.normal.y < p.minGroundNormalY) return false;

  // Read everything off the hit BEFORE the capsule query below — the service reuses its records.
  const landY = hit.point.y;
  const nx = hit.normal.x;
  const ny = hit.normal.y;
  const nz = hit.normal.z;
  const gained = landY - before.y;
  if (gained < -0.02 || gained > p.stepHeight + 0.02) return false;

  body.position.set(_probe.x, landY, _probe.z);
  if (capsuleOverlapDepth(world, body.position, body.height, body.radius) > 1e-3) {
    body.position.copy(_savePos);
    body.velocity.copy(_saveVel);
    return false;
  }
  if (body.velocity.y < 0) body.velocity.y = 0;
  body.grounded = true;
  body.groundNormal.set(nx, ny, nz);
  body.stepSmear += gained; // presentation-only debt
  COUNTERS.stepUps++;
  return true;
}

/**
 * Ground snap. Running off a crest or down a ramp technically leaves the floor for a frame,
 * which reads as a tiny involuntary hop and destroys the sense of weight.
 *
 * NOTE FOR THE LEAD: this is `settleGround()`, and until now it was UNREACHABLE — its guard was
 * `if (this.grounded) return`, and `grounded` was permanently true. It runs for the first time
 * in this build. It is what keeps a body glued to stairs and ramps now that gravity is real.
 */
function snapToGround(world: WorldService, body: MotionBody, p: MotionParams): void {
  if (body.grounded) return;
  if (!_wasGrounded) return;
  if (body.velocity.y > 0.2) return;
  if (!p.canSnap) return;

  _origin.set(body.position.x, body.position.y + 0.1, body.position.z);
  const hit = world.raycast(_origin, _down, p.groundSnapDistance + 0.1);
  if (!hit || !hit.hit || hit.normal.y < p.minGroundNormalY) return;
  const drop = body.position.y - hit.point.y;
  if (drop < -0.01 || drop > p.groundSnapDistance) return;

  body.stepSmear -= drop;
  body.position.y = hit.point.y;
  body.velocity.y = 0;
  body.grounded = true;
  body.groundNormal.copy(hit.normal);
}

/**
 * THE LEDGE GUARD — "a body climbing toward you does not walk off the thing it is climbing".
 *
 * Only fires on the step where a grounded body actually leaves the floor, so it costs nothing in
 * the steady state (the ground snap has already had its chance, so any trip here is a drop of
 * more than `groundSnapDistance`). Recovery gives up ONE AXIS AT A TIME, so a body pressed
 * against a lip slides along it — which is how it finds the top of a flight — instead of
 * stopping dead against an invisible wall.
 *
 * It reverts the HORIZONTAL step. It never holds the body up in the air: that was the old
 * `followGround`, and holding height is precisely the bug this whole file exists to kill.
 */
function ledgeGuard(world: WorldService, body: MotionBody, p: MotionParams): void {
  if (body.grounded || !_wasGrounded) return;
  if (body.velocity.y > 0.05) return;
  const nx = body.position.x;
  const nz = body.position.z;
  if (nx === _guardFrom.x && nz === _guardFrom.z) return;
  if (tryStand(world, body, p, _guardFrom.x, nz)) return;
  if (tryStand(world, body, p, nx, _guardFrom.z)) return;
  tryStand(world, body, p, _guardFrom.x, _guardFrom.z);
}

/** Seat the body at (x, z) if there is walkable ground within `stepHeight` and it fits. */
function tryStand(
  world: WorldService, body: MotionBody, p: MotionParams, x: number, z: number,
): boolean {
  _origin.set(x, body.position.y + 0.1, z);
  const hit = world.raycast(_origin, _down, p.stepHeight + 0.15);
  if (!hit || !hit.hit || hit.normal.y < p.minGroundNormalY) return false;
  // Read everything off the hit BEFORE the capsule query below — the service reuses its records.
  const landY = hit.point.y;
  const nx = hit.normal.x;
  const ny = hit.normal.y;
  const nz = hit.normal.z;
  if (body.position.y - landY > p.stepHeight + 0.02) return false;

  _probe.set(x, landY, z);
  if (capsuleOverlapDepth(world, _probe, body.height, body.radius) > 1e-3) return false;

  body.position.set(x, landY, z);
  body.velocity.y = 0;
  body.grounded = true;
  body.groundNormal.set(nx, ny, nz);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The mover
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Gravity, shared so nobody re-derives terminal velocity. `gravity` is the already-scaled base
 * (the player folds its dive multiplier into it); `fallMult` is the extra bite once falling.
 */
export function applyGravity(
  velocity: Vector3, grounded: boolean, gravity: number, fallMult: number, maxFall: number, dt: number,
): void {
  if (grounded && velocity.y <= 0) return;
  let g = gravity;
  if (velocity.y < 0) g *= fallMult;
  velocity.y -= g * dt;
  if (velocity.y < -maxFall) velocity.y = -maxFall;
}

/**
 * Integrate and resolve one body for one fixed step.
 *
 * `body.grounded` is CLEARED here and re-derived from the collision result. A caller that has
 * just jumped, dived or vaulted should still set `grounded = false` itself, because the state
 * machine needs to know before this runs — but it no longer has to, and nothing has to remember
 * to clear it.
 */
export function moveBody(
  world: WorldService, body: MotionBody, p: MotionParams, dt: number,
): void {
  _guardFrom.copy(body.position);
  _wasGrounded = body.grounded;
  _slideLift = 0;
  // GROUND IS DERIVED, NEVER REMEMBERED. This one line is the fix.
  body.grounded = false;

  _delta.set(
    (body.velocity.x + p.driftX) * dt,
    body.velocity.y * dt,
    (body.velocity.z + p.driftZ) * dt,
  );
  const dist = _delta.length();

  if (dist < 1e-7) {
    depenetrate(world, body, p);
  } else {
    let steps = Math.ceil(dist / p.maxSubstepDistance);
    if (steps < 1) steps = 1;
    if (steps > p.maxSubsteps) steps = p.maxSubsteps;
    _substep.copy(_delta).divideScalar(steps);

    for (let i = 0; i < steps; i++) {
      _before.copy(body.position);
      body.position.add(_substep);
      const blocked = depenetrate(world, body, p);
      // Step up while we have (or just had) ground under us. `canStepUp` carries the caller's
      // own coyote/state gate; `body.grounded` covers ground found mid-sweep.
      if (blocked && (p.canStepUp || body.grounded)) tryStepUp(world, body, p, _before, _substep);
    }
  }

  // ── GIVE BACK THE SLOPE RATCHET ───────────────────────────────────────────────────────────
  // `groundMove` clamps only NEGATIVE `velocity.y`, and `applyGravity` early-returns while
  // grounded, so nothing ever removed the upward velocity that sliding along a walkable slope
  // injects. MEASURED: sprinting the 40° fire escape reached vy = 6.7 m/s, which threw the
  // player ~2 m off the top step and reprojected horizontal speed 8.75 → 2.3 m/s. That launch
  // IS "after the gravity changes i can't go upstairs".
  //
  // The target is the velocity that FOLLOWS THE GROUND WE ARE ON RIGHT NOW. Halfway up a ramp
  // that is the whole uphill velocity, so climbing keeps its momentum and stays full speed
  // (stripping it outright costs 3.6× on every flight — measured). The instant the ramp gives
  // way to a flat deck the target drops to 0 and the accumulated ratchet is thrown away.
  //
  // Runs BEFORE `snapToGround` on purpose: the ramp→deck transition is the step where the body
  // has just left the floor, and the snap refuses to glue anything rising faster than 0.2 m/s.
  // Cancel the ratchet first and the snap can do its job, so cresting a flight is flat instead
  // of a 0.5 m hop.
  //
  // Two independent safety rails: we only ever take back what the SOLVER injected
  // (`_slideLift`), and only if we were on the ground when the step began. A jump, a dive and a
  // mantle write `velocity.y` themselves and are not solver-injected, so none can be eaten here.
  if (_slideLift > 0 && body.velocity.y > 0 && (body.grounded || _wasGrounded)) {
    let target = 0;
    if (body.grounded) {
      const gn = body.groundNormal;
      const followY = body.velocity.y - body.velocity.dot(gn) * gn.y;
      if (followY > 0) target = followY;
    }
    if (body.velocity.y > target) {
      const excess = body.velocity.y - target;
      body.velocity.y -= excess < _slideLift ? excess : _slideLift;
    }
  }

  snapToGround(world, body, p);
  if (p.ledgeGuard) ledgeGuard(world, body, p);

  // A body that was grounded, is grounded, and is being pulled down by gravity has no business
  // carrying downward velocity into the next step — otherwise it accumulates all the way to
  // terminal velocity while standing still and launches on the first frame it loses contact.
  if (body.grounded && body.velocity.y < 0) body.velocity.y = 0;
}

/** Residual overlap, metres, left by the most recent `moveBody`. Diagnostics only. */
export function lastResidual(): number { return _residual; }

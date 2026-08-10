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

/** Residual overlap left by the last `depenetrate()`. Module-level so nothing allocates. */
let _residual = 0;
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
 * ═══ THE ONE-LINE BUG ═══
 * The controller version read `if (!c || c.depth <= 1e-5) break;` and only looked at
 * `c.grounded` several lines further down. A body resting cleanly on a floor has depth ~0 — the
 * solver pushed it out last step and it has not moved into anything since — so the loop broke
 * out BEFORE the ground flag was ever read, on every single step of normal walking. Combined
 * with `grounded` never being cleared, the flag simply latched true forever. Ground is read
 * FIRST here, before any early exit.
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

    body.position.add(c.correction);
    const n = c.normal;
    if (n.y >= p.minGroundNormalY) {
      body.grounded = true;
      body.groundNormal.copy(n);
    } else {
      blocked = true;
    }
    // Kill only the component travelling INTO the surface: everything else slides along it.
    const vn = body.velocity.dot(n);
    if (vn < 0) body.velocity.addScaledVector(n, -vn);
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

  _savePos.copy(body.position);
  _saveVel.copy(body.velocity);

  _probe.copy(before);
  _probe.y += p.stepHeight;
  _probe.x += wantX;
  _probe.z += wantZ;
  if (capsuleOverlapDepth(world, _probe, body.height, body.radius) > 1e-3) return; // no room up there

  _origin.set(_probe.x, _probe.y + 0.05, _probe.z);
  const hit: RaycastHit = world.raycast(_origin, _down, p.stepHeight + 0.15);
  if (!hit || !hit.hit || hit.normal.y < p.minGroundNormalY) return;

  const landY = hit.point.y;
  const nx = hit.normal.x;
  const ny = hit.normal.y;
  const nz = hit.normal.z;
  const gained = landY - before.y;
  if (gained < -0.02 || gained > p.stepHeight + 0.02) return;

  body.position.set(_probe.x, landY, _probe.z);
  if (capsuleOverlapDepth(world, body.position, body.height, body.radius) > 1e-3) {
    body.position.copy(_savePos);
    body.velocity.copy(_saveVel);
    return;
  }
  if (body.velocity.y < 0) body.velocity.y = 0;
  body.grounded = true;
  body.groundNormal.set(nx, ny, nz);
  body.stepSmear += gained; // presentation-only debt
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

  snapToGround(world, body, p);
  if (p.ledgeGuard) ledgeGuard(world, body, p);

  // A body that was grounded, is grounded, and is being pulled down by gravity has no business
  // carrying downward velocity into the next step — otherwise it accumulates all the way to
  // terminal velocity while standing still and launches on the first frame it loses contact.
  if (body.grounded && body.velocity.y < 0) body.velocity.y = 0;
}

/** Residual overlap, metres, left by the most recent `moveBody`. Diagnostics only. */
export function lastResidual(): number { return _residual; }

/**
 * PLAYER CONTROLLER — the capsule character controller. GAME_BIBLE §2.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE FEEL THESIS
 *  ───────────────
 *  Ground movement is *snappy*: very high acceleration and very high friction, so the velocity
 *  vector is essentially the input vector, one frame later. That is what "no mush" means.
 *
 *  Air movement is the opposite: almost no friction and a Quake/Source-style strafe accelerator,
 *  so momentum is yours to keep and to grow. Every metre of speed above the walk cap has to be
 *  *earned* in the air or through a slide-cancel — which is exactly where the skill ceiling is.
 *
 *  Nothing ever hard-stops horizontal momentum except a wall. Read that again before adding a
 *  `velocity.set(0,0,0)` anywhere in this file.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * STRUCTURE OF A FIXED STEP (this order matters and is stable):
 *   1. snapshot previous transform (the renderer interpolates between snapshots)
 *   2. sample input edges — exactly once per FRAME even though we may run several steps
 *   3. tick timers (coyote, buffers, cooldowns, ramps)
 *   4. state machine: slide / dive / mantle / air / ground transitions
 *   5. apply the acceleration model for the current state
 *   6. integrate + resolve against the world (substepped, with step-up and ground snap)
 *   7. post: ground/landing detection, footstep stride, event emission, camera drive fill
 *
 * Runs at FIXED_DT (120 Hz). Zero allocations: everything works through module-level scratch.
 */

import { Vector3 } from 'three';
import type {
  EventBus, GameCtx, InputService, MoveState,
  PlayerStats, SurfaceKind, WorldService,
} from '@/core/types';
import {
  DEG2RAD, clamp, clamp01, damp, lambdaFromHalfLife, moveTowards, wrapAngle,
} from '@/core/mathx';
import {
  applyGravity, capsuleOverlapDepth, makeMotionParams, moveBody, type MotionParams,
} from '@/game/motion';
import { MOVE, WEAPON } from '@/game/tuning';
import type { CameraDrive } from './drive';
import { makeCameraDrive } from './drive';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module-level scratch. NEVER return one of these to a caller.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const _wish = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _origin = new Vector3();
const _dir = new Vector3();
const _tmp = new Vector3();
const _tmp2 = new Vector3();
const _down = new Vector3(0, -1, 0);
// The sweep/depenetration/step-up scratch that used to live here moved with the code that used
// it, into `game/motion`. Everything left is intent, probing and the vault.


// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Everything the controller needs from the outside world. Kept explicit so it is testable. */
export interface ControllerDeps {
  world: WorldService;
  input: InputService;
  events: EventBus;
  /** Live stats — read every step, never cached, because a boon can land mid-round. */
  stats: () => Readonly<PlayerStats>;
}

export class PlayerController {
  // ── transform ────────────────────────────────────────────────────────────────────────────
  /** FEET position. The capsule spans [y+radius, y+height-radius]. */
  readonly position = new Vector3();
  /** Position at the start of this fixed step — the renderer lerps between the two. */
  readonly prevPosition = new Vector3();
  readonly velocity = new Vector3();
  readonly groundNormal = new Vector3(0, 1, 0);

  /** Camera-facing yaw, written by the owning system before each step. */
  yaw = 0;

  // ── posture ──────────────────────────────────────────────────────────────────────────────
  height = MOVE.standHeight;
  targetHeight = MOVE.standHeight;
  eyeHeight = MOVE.standEye;
  prevEyeHeight = MOVE.standEye;
  private targetEyeHeight = MOVE.standEye;

  // ── state ────────────────────────────────────────────────────────────────────────────────
  moveState: MoveState = 'idle';
  grounded = true;
  wasGrounded = true;
  crouching = false;

  /** 0..1 sprint ramp. Slide-cancelling snaps this back to 1 — that is the whole tech. */
  sprintAmount = 0;

  // timers
  private coyote = 0;
  private jumpBuffer = 0;
  private jumpCooldown = 0;
  private slideTime = 0;
  private slideDurationCur = MOVE.slideDuration;
  private slideCooldown = 0;
  private diveCooldown = 0;
  private crouchHeldTime = 0;
  private vaultCooldown = 0;
  private airJumpsUsed = 0;
  private sinceLanded = 999;
  onGroundTime = 0;
  airTime = 0;
  /** Seconds of remaining i-frames (dive landing roll). The damage path reads this. */
  iFrames = 0;

  // mantle
  private mantleT = 0;
  private mantleDuration = MOVE.vaultDuration;
  private readonly mantleFrom = new Vector3();
  private readonly mantleTo = new Vector3();

  // footsteps / bob
  private strideAccum = 0;
  bobDistance = 0;
  /** Camera-only vertical smear owed by a step-up or ground snap. */
  stepSmear = 0;

  /** True when the last landing came out of a dolphin dive (the camera plays a bigger dip). */
  lastLandWasDive = false;
  /** Impact speed of the most recent landing, m/s. */
  lastImpactSpeed = 0;

  readonly drive: CameraDrive = makeCameraDrive();

  /**
   * Capsule radius. A field (not a constant read) because `MotionBody` needs one, and because a
   * boon that changes the player's build later has somewhere to write. Kept in step with
   * `MOVE.radius` every step so live-tuning from the console still works mid-playtest.
   */
  radius = MOVE.radius;

  /**
   * The shared solver's settings for THIS body. One instance, mutated in place — the mover runs
   * up to eight substeps per fixed step and must not allocate.
   */
  private readonly motion: MotionParams = makeMotionParams();

  // ── per-frame input edge latch ───────────────────────────────────────────────────────────
  // `pressed()`/`released()` are FRAME edges: input publishes them in beginFrame() and wipes
  // them in endFrame(). fixedUpdate runs 0..N times per frame — and the frozen System contract
  // allows N === 0 (hitstop, slow-mo, >120Hz displays). Latching inside the fixed step would
  // therefore DESTROY the press on any zero-step frame, so the latch lives in `beginFrame()`,
  // which `PlayerSystem` calls from both update() and fixedUpdate().
  //
  // ═══════════════════════════════════════════════════════════════════════════════════════
  //  THE LATCH IS OR-ACCUMULATING, AND CLEARED ONLY BY A STEP THAT CONSUMED IT.  (M2 fix)
  //
  //  The previous version OVERWROTE the four flags every frame (`edgeJump = pressed(...)`).
  //  On a frame that runs ZERO fixed steps nothing consumed them, and the next frame's
  //  overwrite silently threw the press away. `jump` survived only because it also primes
  //  `jumpBuffer`; `crouch` — the SOLE slide trigger — and `edgeJumpUp` — the short-hop cut —
  //  had no such backstop and were simply lost.
  //
  //  MEASURED, and this is not a rare window: `HITSTOP_FLOOR` (core/time.ts) means the
  //  accumulator gains 0.33 ms per frame against an 8.33 ms FIXED_DT, so a body-shot hitstop
  //  (0.02 s) opens 2 consecutive zero-step frames, a kill (0.06 s) opens 4 — 66 ms, longer
  //  than a human CTRL tap — and a VFX explosion (0.1 s) opens 8. Independently, a >120 Hz
  //  display runs zero steps on ~half of ALL frames with no hitstop at all. So the milestone's
  //  headline sequence ("sprint, slide, headshot mid-slide") lost its slide precisely when the
  //  player had just killed something, which is exactly when they slide.
  //
  //  Now: `beginFrame()` ORs this frame's edges into the latch, so a press survives any number
  //  of zero-step frames. `clearEdges()` runs at the END of a fixed step, so the FIRST step
  //  after the press consumes it and no later step can re-fire it (no double jumps).
  //  REGRESSION TEST: at `time.timeScale = 0`, a crouch press must still start a slide on the
  //  first frame that steps.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  private edgeFrame = -1;
  private edgeJump = false;
  private edgeJumpUp = false;
  private edgeCrouch = false;
  private edgeCrouchUp = false;

  private world!: WorldService;
  private input!: InputService;
  private events!: EventBus;
  private getStats!: () => Readonly<PlayerStats>;
  private attached = false;

  attach(deps: ControllerDeps): void {
    this.world = deps.world;
    this.input = deps.input;
    this.events = deps.events;
    this.getStats = deps.stats;
    this.attached = true;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════════════════════

  get speed(): number {
    const { x, z } = this.velocity;
    return Math.sqrt(x * x + z * z);
  }

  get sliding(): boolean { return this.moveState === 'slide'; }
  get diving(): boolean { return this.moveState === 'dive'; }
  get mantling(): boolean { return this.moveState === 'mantle'; }
  /** Seconds into the current slide — the debug panel watches this while we tune the cancel. */
  get slideTimer(): number { return this.moveState === 'slide' ? this.slideTime : 0; }

  teleport(position: Vector3, yaw?: number): void {
    this.position.copy(position);
    this.prevPosition.copy(position);
    this.velocity.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = wrapAngle(yaw);
    this.height = this.targetHeight = MOVE.standHeight;
    this.eyeHeight = this.prevEyeHeight = this.targetEyeHeight = MOVE.standEye;
    this.setState('idle');
    this.grounded = false;
    this.wasGrounded = false;
    this.slideTime = 0;
    this.stepSmear = 0;
    this.sprintAmount = 0;
    this.crouching = false;
    this.iFrames = 0;
  }

  /** Called by whoever owns the loop, once per fixed step, with the camera's yaw for this frame. */
  fixedUpdate(dt: number, yaw: number, frame: number): void {
    if (!this.attached) return;
    this.yaw = yaw;

    // 1 — snapshot for render interpolation
    this.prevPosition.copy(this.position);
    this.prevEyeHeight = this.eyeHeight;
    this.wasGrounded = this.grounded;
    const prevVelY = this.velocity.y;

    // 2 — latch frame edges
    this.sampleEdges(frame);

    // 3 — timers
    this.tickTimers(dt);

    // 4/5 — intent, state machine, acceleration
    this.buildWishDir();
    if (this.moveState === 'mantle') {
      this.updateMantle(dt);
    } else {
      this.updateCrouchAndSlide(dt);
      this.updateSprint(dt);
      this.updateJump();
      if (this.grounded) this.groundMove(dt);
      else this.airMove(dt);
      this.applyGravity(dt);
      this.tryVault();
      this.moveAndCollide(dt);
    }

    // 6 — posture blend (capsule + eye), then re-resolve if standing up clipped us
    this.updatePosture(dt);

    // 7 — post
    this.detectLanding(prevVelY);
    this.updateFootsteps();
    this.updateStateLabel();
    this.stepSmear = damp(this.stepSmear, 0, lambdaFromHalfLife(MOVE.stepSmoothHalfLife), dt);
    if (this.position.y < MOVE.fallResetY) this.recoverFromVoid();
    this.fillDrive(dt);

    // 8 — this step consumed the input edges. Anything the state machine did not act on is
    // gone on purpose; anything it did act on must not fire again next step.
    this.clearEdges();
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 2 — input edges
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * Latch this frame's input edges. MUST be called once per frame from a hook that runs
   * unconditionally (`PlayerSystem.update`), not from the fixed step — see the field comment
   * above. Idempotent: repeated calls with the same frame number are a no-op, so fixedUpdate
   * can call it too and the ordering between the two never matters.
   */
  beginFrame(frame: number): void {
    if (!this.attached || frame === this.edgeFrame) return;
    this.edgeFrame = frame;
    // OR, never assign — see the block comment on the fields. A press latched on a frame that
    // ran no fixed step is still waiting here when one finally runs.
    if (this.input.pressed('jump')) this.edgeJump = true;
    if (this.input.released('jump')) this.edgeJumpUp = true;
    if (this.input.pressed('crouch')) this.edgeCrouch = true;
    if (this.input.released('crouch')) this.edgeCrouchUp = true;
    // Priming the buffer here is what lets a press made on a zero-step frame survive into
    // the next fixed step, exactly as `jumpBufferTime` promises. The latch above now gives
    // crouch and the jump-release the same guarantee without a second timer each.
    if (this.edgeJump) this.jumpBuffer = MOVE.jumpBufferTime;
  }

  private sampleEdges(frame: number): void {
    // Safety net: if some caller drives fixedUpdate without ever calling beginFrame, still
    // latch rather than silently eating input.
    this.beginFrame(frame);
  }

  /**
   * Consume the latch. Called at the END of every fixed step — so the first step after a press
   * sees it, and the second step of the same frame (or the first step of the next frame) does
   * not re-fire it.
   */
  private clearEdges(): void {
    this.edgeJump = false;
    this.edgeJumpUp = false;
    this.edgeCrouch = false;
    this.edgeCrouchUp = false;
  }

  private tickTimers(dt: number): void {
    if (this.jumpBuffer > 0) this.jumpBuffer -= dt;
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;
    if (this.slideCooldown > 0) this.slideCooldown -= dt;
    if (this.diveCooldown > 0) this.diveCooldown -= dt;
    if (this.vaultCooldown > 0) this.vaultCooldown -= dt;
    if (this.iFrames > 0) this.iFrames -= dt;
    this.sinceLanded += dt;

    if (this.grounded) {
      this.coyote = MOVE.coyoteTime;
      this.onGroundTime += dt;
      this.airTime = 0;
      this.airJumpsUsed = 0;
    } else {
      if (this.coyote > 0) this.coyote -= dt;
      this.airTime += dt;
      this.onGroundTime = 0;
    }

    if (this.input.down('crouch')) this.crouchHeldTime += dt;
    else this.crouchHeldTime = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 4 — intent
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /** `_wish` = normalised world-space move intent on the XZ plane (zero length if no input). */
  private buildWishDir(): void {
    const ax = this.input.moveAxis.x;
    const ay = this.input.moveAxis.y;
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    // yaw 0 looks down -Z. forward = (-sin, 0, -cos); right = (cos, 0, -sin).
    _fwd.set(-s, 0, -c);
    _right.set(c, 0, -s);
    _wish.set(0, 0, 0);
    _wish.addScaledVector(_right, ax);
    _wish.addScaledVector(_fwd, ay);
    const l = Math.sqrt(_wish.x * _wish.x + _wish.z * _wish.z);
    if (l > 1e-5) { _wish.x /= l; _wish.z /= l; } else { _wish.set(0, 0, 0); }
  }

  private hasMoveInput(): boolean {
    return Math.abs(this.input.moveAxis.x) > 1e-3 || Math.abs(this.input.moveAxis.y) > 1e-3;
  }

  /** Speed the current posture + input wants, before any air/slide rules. */
  private desiredSpeed(): number {
    const st = this.getStats();
    let s = st.moveSpeed;
    s *= 1 + (st.sprintMult - 1) * this.sprintAmount;
    if (this.crouching && !this.sliding) s *= MOVE.crouchSpeedMult;
    if (this.input.moveAxis.y < -0.1) s *= MOVE.backpedalMult;
    if (this.input.down('aim')) s *= WEAPON.adsMoveMult;
    return s;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 4 — sprint / crouch / slide / dive state machine
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private updateSprint(dt: number): void {
    if (this.moveState === 'slide' || this.moveState === 'dive') return;
    const wantSprint =
      this.input.down('sprint') &&
      this.input.moveAxis.y > MOVE.sprintForwardDot &&
      !this.crouching;

    // Sprint keeps ramping in the air so a jump mid-sprint does not reset the ramp.
    const rate = wantSprint ? dt / MOVE.sprintRampTime : -dt / MOVE.sprintDecayTime;
    this.sprintAmount = clamp01(this.sprintAmount + rate);
  }

  private updateCrouchAndSlide(dt: number): void {
    // ── slide in progress ────────────────────────────────────────────────────────────────
    if (this.moveState === 'slide') {
      this.slideTime += dt;

      // Hold crouch out of a fresh slide → dolphin dive (GAME_BIBLE §2: tap = slide, hold = dive).
      if (
        this.crouchHeldTime >= MOVE.diveHoldTime &&
        this.slideTime <= MOVE.diveConvertWindow &&
        this.speed >= MOVE.diveMinSpeed &&
        this.diveCooldown <= 0 &&
        this.grounded
      ) {
        this.startDive();
        return;
      }

      const done =
        this.slideTime >= this.slideDurationCur ||
        this.speed < MOVE.slideEndSpeed ||
        (!this.grounded && this.slideTime > 0.08);
      if (done) this.endSlide();
      return;
    }

    if (this.moveState === 'dive') return;

    // ── crouch / slide entry ─────────────────────────────────────────────────────────────
    const holding = this.input.down('crouch');
    if (this.edgeCrouch && this.grounded && this.canSlide()) {
      this.startSlide();
      return;
    }
    this.crouching = holding;
  }

  private canSlide(): boolean {
    return (
      this.slideCooldown <= 0 &&
      this.speed >= MOVE.slideMinSpeed &&
      this.sprintAmount > 0.5 &&
      this.moveState !== 'mantle'
    );
  }

  private startSlide(): void {
    const st = this.getStats();
    this.slideTime = 0;
    this.slideDurationCur = MOVE.slideDuration;
    this.crouching = true;
    // Impulse along current travel (not along input) — a slide commits to where you were going.
    const sp = this.speed;
    if (sp > 1e-4) {
      const target = Math.min(sp + st.slideImpulse, MOVE.slideMaxSpeed);
      const k = target / sp;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }
    this.setState('slide');
  }

  /** Ends the slide *without* touching horizontal velocity — momentum is never hard-stopped. */
  private endSlide(): void {
    this.slideTime = 0;
    this.slideCooldown = MOVE.slideCooldown;
    this.crouching = this.input.down('crouch');
    this.setState(this.grounded ? (this.hasMoveInput() ? 'walk' : 'idle') : 'air');
  }

  private startDive(): void {
    const sp = this.speed;
    _dir.set(this.velocity.x, 0, this.velocity.z);
    if (sp > 1e-4) _dir.divideScalar(sp); else _dir.copy(_fwd);
    this.velocity.x = _dir.x * MOVE.diveForward;
    this.velocity.z = _dir.z * MOVE.diveForward;
    this.velocity.y = MOVE.diveUp;
    this.grounded = false;
    this.coyote = 0;
    this.slideTime = 0;
    this.crouching = true;
    this.diveCooldown = MOVE.diveCooldown;
    this.setState('dive');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 4 — jump, slide-cancel, bunny-hop
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private updateJump(): void {
    // Variable jump height: letting go early clips the arc.
    if (this.edgeJumpUp && this.velocity.y > 0 && this.moveState !== 'dive') {
      this.velocity.y *= MOVE.jumpCutMult;
    }

    if (this.jumpBuffer <= 0 || this.jumpCooldown > 0) return;

    const canGround = this.grounded || this.coyote > 0;
    const st = this.getStats();
    if (!canGround) {
      if (this.airJumpsUsed >= st.extraJumps) return;
      this.airJumpsUsed++;
    }

    const cancelling = this.moveState === 'slide' && this.slideTime <= MOVE.slideCancelWindow;
    let impulse = st.jumpImpulse;

    if (this.moveState === 'slide') {
      if (cancelling) {
        // ── THE SLIDE-CANCEL ──────────────────────────────────────────────────────────────
        // Keep most of the speed, refund the sprint ramp, shorten the slide cooldown.
        // Chaining this is the fastest travel in the game and the whole movement skill ceiling.
        const sp = this.speed;
        if (sp > 1e-4) {
          const k = MOVE.slideCancelSpeedKeep;
          this.velocity.x *= k;
          this.velocity.z *= k;
        }
        this.sprintAmount = MOVE.slideCancelSprintReset;
        impulse *= MOVE.slideCancelJumpMult;
        this.slideCooldown = MOVE.slideCancelCooldown;
      } else {
        this.slideCooldown = MOVE.slideCooldown;
      }
      this.slideTime = 0;
      this.crouching = false;
    } else if (this.sinceLanded <= MOVE.bhopWindow) {
      // Perfect hop: we landed a moment ago and the jump was buffered, so we skip the friction
      // tick entirely and only bleed `bhopSpeedKeep`. This is what makes hop chains sustainable.
      this.velocity.x *= MOVE.bhopSpeedKeep;
      this.velocity.z *= MOVE.bhopSpeedKeep;
    }

    this.velocity.y = impulse;
    this.grounded = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpCooldown = MOVE.jumpCooldown;
    this.setState('air');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 5 — acceleration models
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * Quake `accelerate`: add along `dir` only as much as is still missing to reach `wishSpeed`
   * along that axis. Because the shortfall is measured ALONG the wish direction, turning while
   * already fast leaves headroom — which is precisely the air-strafe exploit we want to keep.
   */
  private accelerate(dirX: number, dirZ: number, wishSpeed: number, accel: number, dt: number): void {
    const current = this.velocity.x * dirX + this.velocity.z * dirZ;
    const add = wishSpeed - current;
    if (add <= 0) return;
    let a = accel * dt;
    if (a > add) a = add;
    this.velocity.x += dirX * a;
    this.velocity.z += dirZ * a;
  }

  /** Quake `friction`: `stopSpeed` is the floor that kills the last slow creep instead of easing into it. */
  private applyFriction(dt: number, friction: number): void {
    const sp = this.speed;
    if (sp < 1e-4) { this.velocity.x = 0; this.velocity.z = 0; return; }
    const control = sp < MOVE.stopSpeed ? MOVE.stopSpeed : sp;
    const drop = control * friction * dt;
    const next = sp - drop;
    const k = next <= 0 ? 0 : next / sp;
    this.velocity.x *= k;
    this.velocity.z *= k;
  }

  private groundMove(dt: number): void {
    if (this.moveState === 'slide') { this.slideMove(dt); return; }

    const wishSpeed = this.desiredSpeed();
    const moving = _wish.lengthSq() > 1e-6;

    // Friction always runs on the ground. When you are pushing forward the accel out-muscles it
    // instantly (95 vs ~46 m/s² at walk speed), so the only thing it actually does is kill drift
    // and bleed you back down when you stop sprinting. That combination is the "snappy" feel.
    let friction = MOVE.groundFriction;
    if (this.crouching) friction *= MOVE.crouchFrictionMult;
    this.applyFriction(dt, friction);

    if (moving) this.accelerate(_wish.x, _wish.z, wishSpeed, MOVE.groundAccel, dt);

    if (this.velocity.y < 0) this.velocity.y = 0;
    this.clampHorizontal(MOVE.speedHardCap);
  }

  private slideMove(dt: number): void {
    // Low friction: the slide glides. Slope adds speed, so sliding downhill is genuinely faster.
    this.applyFriction(dt, MOVE.slideFriction);

    if (_wish.lengthSq() > 1e-6) {
      // Steering rotates the velocity instead of adding to it, so a slide can be curved but
      // never accelerated by mashing A/D. The curve is capped in deg/s: it stays a commitment.
      this.rotateHorizontalToward(_wish.x, _wish.z, MOVE.slideSteerMaxDeg * DEG2RAD * dt);
      this.accelerate(_wish.x, _wish.z, this.speed, MOVE.slideSteerAccel, dt);
    }

    // Downhill acceleration along the ground plane.
    const n = this.groundNormal;
    if (n.y < 0.999) {
      _tmp.set(n.x, 0, n.z);
      const l = _tmp.length();
      if (l > 1e-4) {
        _tmp.divideScalar(l);
        this.velocity.x += _tmp.x * MOVE.slideSlopeAccel * (1 - n.y) * dt;
        this.velocity.z += _tmp.z * MOVE.slideSlopeAccel * (1 - n.y) * dt;
      }
    }

    if (this.velocity.y < 0) this.velocity.y = 0;
    this.clampHorizontal(MOVE.speedHardCap);
  }

  private airMove(dt: number): void {
    const st = this.getStats();
    if (MOVE.airFriction > 0) this.applyFriction(dt, MOVE.airFriction);
    if (_wish.lengthSq() < 1e-6) return;

    const diving = this.moveState === 'dive';
    if (diving) {
      // A dive is a commitment. Almost no authority — that is the risk half of the risk/reward.
      this.accelerate(_wish.x, _wish.z, this.desiredSpeed(), MOVE.diveSteerAccel * st.airControl, dt);
      this.clampHorizontal(MOVE.speedHardCap);
      return;
    }

    // ── SOURCE-STYLE STRAFE ACCELERATION ─────────────────────────────────────────────────
    // The cap passed to `accelerate` is a tiny constant, NOT the real wish speed. That means
    // the "shortfall" it measures is always tiny too — so you can only gain a sliver per tick,
    // but you can gain it *every* tick as long as you keep the wish direction near-perpendicular
    // to your velocity. Holding A + curving the mouse left = free speed. Bunny-hopping is real.
    this.accelerate(
      _wish.x, _wish.z,
      MOVE.airStrafeMaxWish,
      MOVE.airStrafeAccel * st.airControl,
      dt,
    );

    // A separate, ordinary air-control term so a player who does NOT know the tech can still
    // steer in the air up to their normal ground speed. Skill adds; it does not gate.
    this.accelerate(_wish.x, _wish.z, this.desiredSpeed(), MOVE.airAccel * st.airControl, dt);

    this.clampHorizontal(MOVE.speedHardCap);
  }

  /**
   * Gravity is the shared solver's (`game/motion`), with the dive multiplier folded into the
   * base — `g * dive * fall` is the same product the inline version computed, in the same order
   * of magnitude, so the jump arc is bit-for-bit what it was.
   */
  private applyGravity(dt: number): void {
    const g = this.moveState === 'dive' ? MOVE.gravity * MOVE.diveGravityMult : MOVE.gravity;
    applyGravity(this.velocity, this.grounded, g, MOVE.fallGravityMult, MOVE.maxFallSpeed, dt);
  }

  private clampHorizontal(max: number): void {
    const sp = this.speed;
    if (sp <= max || sp < 1e-5) return;
    const k = max / sp;
    this.velocity.x *= k;
    this.velocity.z *= k;
  }

  /** Rotate the horizontal velocity toward (dx,dz) by at most `maxRad`, preserving its length. */
  private rotateHorizontalToward(dx: number, dz: number, maxRad: number): void {
    const sp = this.speed;
    if (sp < 1e-4 || maxRad <= 0) return;
    const cur = Math.atan2(this.velocity.x, this.velocity.z);
    const want = Math.atan2(dx, dz);
    let diff = wrapAngle(want - cur);
    if (diff > maxRad) diff = maxRad;
    else if (diff < -maxRad) diff = -maxRad;
    const a = cur + diff;
    this.velocity.x = Math.sin(a) * sp;
    this.velocity.z = Math.cos(a) * sp;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 6 — integration and collision
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * How deep a capsule of `height` at `pos` is inside the world. The posture blend and the vault
   * probe both ask this before committing to a shape or a destination.
   */
  private overlapDepth(pos: Vector3, height: number): number {
    return capsuleOverlapDepth(this.world, pos, height, this.radius);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *  INTEGRATION + COLLISION — now `game/motion`, shared bit-for-bit with the horde.
   *
   *  What used to live here (`resolve` · `moveAndCollide` · `tryStepUp` · `settleGround`) moved
   *  into the mover UNCHANGED: same substep length, same four depenetration iterations, same
   *  0.7 step-up progress threshold, same snap tolerances, same `stepSmear` debt. The player's
   *  feel is the regression test for that file and nothing in it was retuned.
   *
   *  THE ONE THING THAT CHANGED, AND IT IS THE BUG THE PLAYTESTER REPORTED:
   *  *"when u walk over terrain u can stay at that level (for example fly) until you press jump"*.
   *
   *  `grounded` used to be set true by `resolve`/`tryStepUp`/`updateMantle` and cleared ONLY by
   *  a jump, a dive or a vault. Nothing derived it from the world, so once you had touched the
   *  floor you were grounded forever: `groundMove` pinned `velocity.y` to 0, `applyGravity`
   *  early-returned on `grounded && vy <= 0`, and walking off a ledge left you strolling through
   *  the air at the height of whatever you last stood on. `settleGround()` was unreachable for
   *  the same reason — its first line was `if (this.grounded) return`.
   *
   *  The mover CLEARS `grounded` at the top of every step and re-derives it from the collision
   *  result. Everything that deliberately takes off (jump, dive, vault) still clears it before
   *  this runs, because the state machine reads it in the same step.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  private moveAndCollide(dt: number): void {
    const m = this.motion;
    this.radius = MOVE.radius;
    m.stepHeight = MOVE.stepHeight;
    m.minGroundNormalY = MOVE.minGroundNormalY;
    m.groundSnapDistance = MOVE.groundSnapDistance;
    m.maxSubstepDistance = MOVE.maxSubstepDistance;
    m.maxSubsteps = 8;
    m.iterations = MOVE.collisionIterations;
    m.driftX = 0;
    m.driftZ = 0;
    // Coyote time is why this is not simply `grounded`: a player one frame off a lip must still
    // be allowed to mount the next stair tread, exactly as before.
    m.canStepUp = this.grounded || this.coyote > 0;
    // A dive must arc, and a fresh jump must leave the floor. Both would otherwise be eaten by
    // the ground snap on the very step they start.
    m.canSnap = this.moveState !== 'dive' && this.jumpCooldown <= 0;
    m.ledgeGuard = false;
    moveBody(this.world, this, m, dt);
  }

  private recoverFromVoid(): void {
    const spawn = this.world.playerSpawn;
    this.teleport(spawn.position, spawn.yaw);
    this.events.emit('player:spawned', { position: this.position });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 6 — posture
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private updatePosture(dt: number): void {
    let wantH: number;
    let wantEye: number;
    switch (this.moveState) {
      case 'slide': wantH = MOVE.slideHeight; wantEye = MOVE.slideEye; break;
      case 'dive': wantH = MOVE.diveHeight; wantEye = MOVE.diveEye; break;
      default:
        if (this.crouching) { wantH = MOVE.crouchHeight; wantEye = MOVE.crouchEye; }
        else { wantH = MOVE.standHeight; wantEye = MOVE.standEye; }
    }

    // Never stand up into a ceiling — stay small until there is room.
    if (wantH > this.height && this.overlapDepth(this.position, wantH) > 1e-3) {
      wantH = this.height;
      wantEye = this.eyeHeight;
      this.crouching = true;
    }

    this.targetHeight = wantH;
    this.targetEyeHeight = wantEye;
    const lambda = lambdaFromHalfLife(MOVE.postureHalfLife);
    this.height = damp(this.height, this.targetHeight, lambda, dt);
    this.eyeHeight = damp(this.eyeHeight, this.targetEyeHeight, lambda, dt);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 4 — auto-vault / mantle
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * Forward probe → wall → find its lip → check headroom → mantle.
   * Three raycasts and one capsule test, only when you are actually running at something, so it
   * costs nothing in the common case. Waist-high geometry should never stop a sprint dead: the
   * arena is designed as a parkour lattice (bible §2) and this is what makes it read as one.
   */
  private tryVault(): void {
    if (this.moveState === 'dive' || this.moveState === 'slide' || this.moveState === 'mantle') return;
    if (this.vaultCooldown > 0) return;
    if (this.input.moveAxis.y < MOVE.vaultMinForwardInput) return;
    if (this.speed < MOVE.vaultMinSpeed) return;
    if (_wish.lengthSq() < 1e-6) return;

    // 1 — is there a wall at waist height in front of us?
    _origin.set(this.position.x, this.position.y + MOVE.vaultMinHeight * 0.75, this.position.z);
    _dir.set(_wish.x, 0, _wish.z);
    const wall = this.world.raycast(_origin, _dir, MOVE.radius + MOVE.vaultProbeDistance);
    if (!wall || !wall.hit) return;
    if (Math.abs(wall.normal.y) > 0.5) return; // that's a floor/ceiling, not a wall
    // The service reuses its hit object, so take everything we need before the next cast.
    const wallDist = wall.distance;

    // 2 — where is its lip? Probe straight down from just above the max vault height.
    // Measured from the WALL, not from us, so the landing spot doesn't depend on trigger range.
    const inset = wallDist + MOVE.vaultLandingInset;
    _tmp.set(
      this.position.x + _wish.x * inset,
      this.position.y + MOVE.vaultMaxHeight + 0.4,
      this.position.z + _wish.z * inset,
    );
    const top = this.world.raycast(_tmp, _down, MOVE.vaultMaxHeight + 0.5);
    if (!top || !top.hit || top.normal.y < MOVE.minGroundNormalY) return;

    const ledgeY = top.point.y;
    const rise = ledgeY - this.position.y;
    if (rise < MOVE.vaultMinHeight || rise > MOVE.vaultMaxHeight) return;

    // 3 — will we fit up there?
    _tmp2.set(_tmp.x, ledgeY, _tmp.z);
    if (this.overlapDepth(_tmp2, Math.max(MOVE.vaultClearance, MOVE.crouchHeight)) > 1e-3) return;

    this.mantleFrom.copy(this.position);
    this.mantleTo.copy(_tmp2);
    this.mantleT = 0;
    this.mantleDuration = MOVE.vaultDuration;
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.crouching = false;
    this.vaultCooldown = MOVE.vaultCooldown + MOVE.vaultDuration;
    this.setState('mantle');
  }

  private updateMantle(dt: number): void {
    this.mantleT += dt / this.mantleDuration;
    const t = clamp01(this.mantleT);
    // easeOutCubic on the plane, plus a small arc on Y — you pull up and over, not through.
    const e = 1 - (1 - t) * (1 - t) * (1 - t);
    this.position.lerpVectors(this.mantleFrom, this.mantleTo, e);
    this.position.y += Math.sin(t * Math.PI) * MOVE.vaultArc;

    if (t >= 1) {
      this.position.copy(this.mantleTo);
      // Exit with real speed: a vault is a shortcut, never a tax.
      _dir.set(this.mantleTo.x - this.mantleFrom.x, 0, this.mantleTo.z - this.mantleFrom.z);
      const l = _dir.length();
      if (l > 1e-4) _dir.divideScalar(l); else _dir.copy(_fwd);
      this.velocity.set(_dir.x * MOVE.vaultExitSpeed, 0, _dir.z * MOVE.vaultExitSpeed);
      this.grounded = true;
      this.groundNormal.set(0, 1, 0);
      this.setState(this.hasMoveInput() ? 'walk' : 'idle');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 7 — landing, footsteps, state label, drive
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private detectLanding(prevVelY: number): void {
    if (!this.grounded || this.wasGrounded) return;

    const impact = Math.abs(Math.min(prevVelY, 0));
    this.lastImpactSpeed = impact;
    this.sinceLanded = 0;
    this.lastLandWasDive = this.moveState === 'dive';

    if (this.lastLandWasDive) {
      // Dive → landing roll: a short, uncancellable slide that converts fall speed into travel.
      const sp = this.speed;
      const rollSpeed = Math.min(
        Math.max(sp, impact * MOVE.diveRollSpeedKeep),
        MOVE.slideMaxSpeed,
      );
      if (sp > 1e-4) {
        const k = rollSpeed / sp;
        this.velocity.x *= k;
        this.velocity.z *= k;
      }
      this.slideTime = 0;
      this.slideDurationCur = MOVE.diveRollTime;
      this.crouching = true;
      this.iFrames = MOVE.diveIFrames;
      this.setState('slide');
    }

    this.events.emit('player:landed', { impactSpeed: impact, position: this.position });
  }

  private updateFootsteps(): void {
    if (!this.grounded || this.moveState === 'mantle') return;
    const sp = this.speed;
    const dx = this.position.x - this.prevPosition.x;
    const dz = this.position.z - this.prevPosition.z;
    const travelled = Math.sqrt(dx * dx + dz * dz);
    this.bobDistance += travelled;
    if (sp < MOVE.footstepMinSpeed || this.moveState === 'slide') return;

    this.strideAccum += travelled;
    const stride = this.crouching
      ? MOVE.strideCrouch
      : this.sprintAmount > 0.5 ? MOVE.strideSprint : MOVE.strideWalk;
    if (this.strideAccum < stride) return;
    this.strideAccum -= stride;

    this.events.emit('player:footstep', {
      position: this.position,
      surface: this.surfaceBelow(),
      sprinting: this.sprintAmount > 0.5,
    });
  }

  /** Surface family under the feet, for audio and dust VFX. One short ray, only on a footstep. */
  private surfaceBelow(): SurfaceKind {
    _origin.set(this.position.x, this.position.y + 0.25, this.position.z);
    const hit = this.world.raycast(_origin, _down, 0.6);
    return hit && hit.hit ? hit.surface : 'concrete';
  }

  private updateStateLabel(): void {
    if (this.moveState === 'slide' || this.moveState === 'dive' || this.moveState === 'mantle') return;
    if (!this.grounded) { this.setState('air'); return; }
    const sp = this.speed;
    if (sp < 0.35 || !this.hasMoveInput()) { this.setState('idle'); return; }
    this.setState(this.sprintAmount > 0.6 ? 'sprint' : 'walk');
  }

  private setState(next: MoveState): void {
    if (next === this.moveState) return;
    const from = this.moveState;
    this.moveState = next;
    this.drive.prevMoveState = from;
    // Every state change is a comic VFX beat (bible §2). VFX/audio listen; we stay decoupled.
    this.events.emit('player:movestate', { from, to: next, speed: this.speed });
  }

  private fillDrive(dt: number): void {
    const d = this.drive;
    d.moveState = this.moveState;
    d.grounded = this.grounded;
    d.speed = this.speed;
    d.verticalSpeed = this.velocity.y;
    d.strafeInput = this.input.moveAxis.x;
    d.forwardInput = this.input.moveAxis.y;
    d.sprintAmount = this.sprintAmount;
    d.slideAmount = this.moveState === 'slide'
      ? clamp01(1 - this.slideTime / Math.max(this.slideDurationCur, 1e-3))
      : moveTowards(d.slideAmount, 0, dt * 6);
    d.diveAmount = this.moveState === 'dive' ? 1 : moveTowards(d.diveAmount, 0, dt * 5);
    d.crouchAmount = clamp01(
      (MOVE.standEye - this.eyeHeight) / Math.max(MOVE.standEye - MOVE.slideEye, 1e-3),
    );
    d.isAiming = this.input.down('aim');
    d.bobDistance = this.bobDistance;
    d.stepSmear = this.stepSmear;
    d.onGroundTime = this.onGroundTime;
    d.airTime = this.airTime;
  }

  /** Interpolated eye position for rendering. Writes into `out`; allocation-free. */
  eyeAt(alpha: number, out: Vector3): Vector3 {
    const a = clamp(alpha, 0, 1);
    out.lerpVectors(this.prevPosition, this.position, a);
    out.y += this.prevEyeHeight + (this.eyeHeight - this.prevEyeHeight) * a;
    return out;
  }
}

/** Convenience for the owning system. */
export function createController(ctx: GameCtx, stats: () => Readonly<PlayerStats>): PlayerController {
  const c = new PlayerController();
  c.attach({ world: ctx.world, input: ctx.input, events: ctx.events, stats });
  return c;
}

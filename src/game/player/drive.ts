/**
 * CAMERA DRIVE — the one-way data channel from the character controller to the camera.
 *
 * The camera must never reach into the controller (and absolutely never the other way round),
 * so the controller fills exactly one of these structs at the end of every fixed step and the
 * camera reads it. It is a plain mutable object that is allocated ONCE and rewritten in place —
 * zero garbage in the hot loop, per ARCHITECTURE §5.
 *
 * If the camera ever needs a new input, it gets a field here. It does not get an import.
 */

import type { MoveState } from '@/core/types';

export interface CameraDrive {
  /** Current and previous movement state — the camera reacts to the transition, not just the value. */
  moveState: MoveState;
  prevMoveState: MoveState;

  grounded: boolean;
  /** Horizontal speed, m/s. Drives bob amplitude, FOV push and speed lines. */
  speed: number;
  /** Signed vertical speed, m/s. Negative while falling. */
  verticalSpeed: number;

  /** Raw movement intent, -1..1. Strafe drives the lean; forward drives nothing yet (M2: weapon sway). */
  strafeInput: number;
  forwardInput: number;

  /** 0..1 sprint ramp — the camera pushes FOV with the ramp, not with the key. */
  sprintAmount: number;
  /** 0..1, 1 at the instant a slide starts and falling to 0 as it ends. */
  slideAmount: number;
  /** 0..1 while a dolphin dive is in the air. */
  diveAmount: number;
  /** 0..1 posture blend, 0 = standing tall, 1 = fully crouched/slid. */
  crouchAmount: number;

  isAiming: boolean;

  /**
   * Monotonic metres travelled ON FOOT. The bob phase is a function of this, which is why the
   * bob stays locked to the stride at every speed instead of swimming when you accelerate.
   */
  bobDistance: number;

  /**
   * Metres of vertical camera correction owed by a step-up or a ground snap. The collider snaps
   * instantly (gameplay must be exact); the camera pays it off over `MOVE.stepSmoothHalfLife`.
   */
  stepSmear: number;

  /** Seconds continuously grounded / airborne. Used to gate the landing dip and the air lean. */
  onGroundTime: number;
  airTime: number;
}

export function makeCameraDrive(): CameraDrive {
  return {
    moveState: 'idle',
    prevMoveState: 'idle',
    grounded: true,
    speed: 0,
    verticalSpeed: 0,
    strafeInput: 0,
    forwardInput: 0,
    sprintAmount: 0,
    slideAmount: 0,
    diveAmount: 0,
    crouchAmount: 0,
    isAiming: false,
    bobDistance: 0,
    stepSmear: 0,
    onGroundTime: 0,
    airTime: 0,
  };
}

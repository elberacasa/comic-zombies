/**
 * HIT REACTIONS — the half of the enemy that matters more than its health bar.
 *
 * > *"A zombie that absorbs a bullet without visibly reacting is a bug."* — M2_VERTICAL_SLICE §2
 *
 * Health is bookkeeping. What the player actually judges is whether the thing they shot MOVED,
 * and moved in the direction the bullet was travelling. So every single bullet, without
 * exception and regardless of damage, produces all four of these:
 *
 *   1. **A flinch** — an additive, *bouncy* pose impulse on a spring, so the body is thrown,
 *      overshoots and comes back. Layered on top of whatever the body was already doing, which
 *      is why a zombie mid-wind-up visibly jolts instead of ignoring you.
 *   2. **A directional stagger** — the flinch is decomposed into the enemy's own local roll and
 *      pitch axes, so a shot from the side rolls it and a shot from the front pitches it back.
 *      Shooting a zombie in the back and watching it lurch *forward* is worth a lot.
 *   3. **A shudder** — a high-frequency ring on a separate, much stiffer spring. ART §9 reserves
 *      high-frequency motion to enemies; this is the one place in the game that spends it.
 *   4. **Knockback** — a real velocity impulse, divided by `def.mass`, so the horde physically
 *      opens up when you shoot into it and kiting has a pressure-relief valve.
 *
 * Both springs are the exact-solution `Spring` from `core/mathx`: an approximated spring bleeds
 * amplitude as a function of the timestep, so the same flinch would feel different on a 60 Hz
 * and a 144 Hz machine. Impacts are the whole game; they get the exact version.
 *
 * DISMEMBERMENT is tracked here too, because it is a *reaction*, not a stat: each limb carries
 * its own pool of health, and when a limb's pool runs out it comes off with a clean comic cut
 * (the part is collapsed by `body.sever`, and `enemy:dismembered` is emitted for the VFX system
 * to spray ink and throw shards). Losing a leg halves the enemy's speed; losing both arms takes
 * its melee away entirely — so shooting limbs is a real tactical option, not just decoration.
 */

import { Spring, SpringVec3, TAU, clamp } from '@/core/mathx';
import { ENEMY } from '@/game/tuning';
import { ANIM, LIMB_COUNT, type EnemyDef } from '@/game/enemies/defs';
import type { BodyPart } from '@/core/types';

/** What one bullet did, handed back to the service so it can drive state and emit events. */
export interface ReactionResult {
  /** Seconds of stagger to enter. Always > 0 — every hit interrupts something. */
  stagger: number;
  /** Limb index severed by this hit, or -1. */
  severed: number;
  /** True when the hit was heavy enough to cancel a melee wind-up. */
  interrupted: boolean;
  /** Knockback speed to add along the bullet's direction, m/s. */
  knockback: number;
}

/** Stagger scales with the hit, between these bounds, off `ENEMY.flinchTime` as the floor. */
const STAGGER_MIN_MULT = 1;
const STAGGER_MAX_MULT = 2.6;

/**
 * Peak displacement of a damped spring struck with velocity `v` is `v / (2π·f)`. Everything in
 * `ANIM` is authored as the peak we want to SEE, so this is the only place the conversion
 * happens — and it is the reason the flinch is visible at all. See the note in `defs.ts`.
 */
function impulseForPeak(peak: number, frequency: number): number {
  return peak * TAU * frequency;
}

export class HitReactions {
  /** Additive body lean. `.x` rolls (side hits), `.z` pitches (front/back hits). */
  readonly lean = new SpringVec3(ANIM.flinchFreq, ANIM.flinchDamping);
  /** The high-frequency ring on top. Reserved-channel motion (ART §9). */
  readonly shudder = new Spring(ANIM.shudderFreq, ANIM.shudderDamping);

  /** Remaining health of each limb, in `LIMB` order. */
  private readonly limbHp = new Float32Array(LIMB_COUNT);
  private readonly gone = [false, false, false, false];

  /** Seconds left in the `stagger` state. The service reads this. */
  staggerT = 0;

  reset(def: EnemyDef): void {
    this.lean.snap();
    this.shudder.reset();
    for (let i = 0; i < LIMB_COUNT; i++) {
      this.limbHp[i] = def.limbHealth;
      this.gone[i] = false;
    }
    this.staggerT = 0;
  }

  /** Advance both springs. Deterministic — this runs in `fixedUpdate`. */
  step(dt: number): void {
    this.lean.step(dt);
    this.shudder.step(dt);
    if (this.staggerT > 0) this.staggerT = Math.max(0, this.staggerT - dt);
  }

  severedCount(): number {
    let n = 0;
    for (let i = 0; i < LIMB_COUNT; i++) if (this.gone[i]) n++;
    return n;
  }

  isSevered(limb: number): boolean {
    return this.gone[limb];
  }

  /** Both arms gone = no melee. A crawling torso is a different (and funnier) threat. */
  get canMelee(): boolean {
    return !(this.gone[0] && this.gone[1]);
  }

  /** Legs missing → a speed penalty. One leg is a drag; two is a crawl. */
  legSpeedMult(def: EnemyDef): number {
    const lost = (this.gone[2] ? 1 : 0) + (this.gone[3] ? 1 : 0);
    if (lost === 0) return 1;
    return lost === 1 ? def.oneLegSpeedMult : def.oneLegSpeedMult * 0.45;
  }

  /**
   * Apply one hit.
   *
   * `localX` / `localZ` are the bullet's travel direction expressed in the ENEMY's local frame
   * (+X = its right, -Z = the way it is facing) — the service projects them, because only it
   * knows the enemy's yaw. That projection is the entire reason a shot from behind lurches the
   * body forward rather than backward.
   *
   * `limbIndex` is -1 unless the trace actually hit a limb capsule; dismemberment can only ever
   * come off a limb the player really shot.
   */
  applyHit(
    amount: number,
    part: BodyPart,
    isCrit: boolean,
    localX: number,
    localZ: number,
    limbIndex: number,
    def: EnemyDef,
    knockbackScale: number,
  ): ReactionResult {
    // ── the flinch, in radians of peak lean ─────────────────────────────────
    // A FLOOR, not just a scale: even a 1-damage graze must rock the body, because the player
    // reads "did it react" long before they read "did the number go down".
    const raw = Math.max(ANIM.flinchPeakMin, amount * ANIM.flinchPeakPerDamage);
    const headed = part === 'head' || isCrit ? raw * ANIM.flinchHeadMult : raw;
    const peak = Math.min(ANIM.flinchPeakMax, headed) / Math.max(0.35, def.mass);
    const impulse = impulseForPeak(peak, ANIM.flinchFreq);

    this.lean.impulse(localX * impulse, 0, localZ * impulse);
    this.shudder.impulse(
      impulseForPeak(ANIM.shudderPeak * Math.min(1, peak / ANIM.flinchPeakMax), ANIM.shudderFreq)
      * (localX >= 0 ? 1 : -1),
    );

    // ── the stagger ──────────────────────────────────────────────────────────
    const mult = clamp(STAGGER_MIN_MULT + peak * 3.4, STAGGER_MIN_MULT, STAGGER_MAX_MULT);
    const stagger = ENEMY.flinchTime * mult;
    this.staggerT = Math.max(this.staggerT, stagger);

    // ── dismemberment ────────────────────────────────────────────────────────
    let severed = -1;
    if (limbIndex >= 0 && !this.gone[limbIndex]) {
      this.limbHp[limbIndex] -= amount;
      if (this.limbHp[limbIndex] <= 0) {
        this.gone[limbIndex] = true;
        severed = limbIndex;
      }
    }

    return {
      stagger,
      severed,
      interrupted: peak >= ANIM.flinchInterrupt,
      // `knockbackPerDamage` is the shared feel constant; mass is the per-kind resistance.
      knockback: (amount * ENEMY.knockbackPerDamage * Math.max(0, knockbackScale)) / Math.max(0.35, def.mass),
    };
  }

  /** Read-outs for the pose evaluator. */
  get leanX(): number { return this.lean.value.x; }
  get leanZ(): number { return this.lean.value.z; }
  get shudderValue(): number { return this.shudder.value; }
}

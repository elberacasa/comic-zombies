/**
 * THE SPAWN DIRECTOR — GAME_BIBLE §6: *"picks spawn points **out of the player's view** and away
 * from their kite path."*
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THE RULE THIS FILE ENFORCES: A ZOMBIE NEVER APPEARS WHERE THE PLAYER CAN SEE IT APPEAR.
 *
 *  It is two tests, and they are not the same thing:
 *    · FRUSTUM — is the point inside the camera's horizontal cone (plus `spawnViewMarginDeg`)?
 *      Cheap: one dot product. Outside the cone, we are done — it is invisible.
 *    · OCCLUSION — if it IS inside the cone, is there a building between the eye and it? A door
 *      dead ahead but behind a block is a perfectly good spawn, and in a dense city most of the
 *      cone is occluded. One `world.raycast` answers it.
 *
 *  The expensive test therefore runs only on candidates that are potentially visible, and only
 *  until one passes — the common case (the best-scoring point is behind the player) costs ZERO
 *  raycasts. Worst case is `ROUND.spawnCandidates` (6) rays on a spawn tick, roughly 1/second.
 *
 *  The visibility test is a VETO, not a weight. There is no tuning constant that turns it off,
 *  because "the horde materialised in front of me" is the single most immersion-breaking bug a
 *  wave shooter can have.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  WHY THERE ARE TWO KINDS OF CANDIDATE, AND WHY THE DOORS ALONE WERE NOT ENOUGH.
 *
 *  The arena publishes 24 `enemySpawns`, and they are all on the 140 m perimeter: MEASURED from
 *  the player's own spawn at (0, 21), the nearest is 46.2 m and the farthest 103.9 m. A shambler
 *  walks at 1.62 m/s. Spawning a round exclusively at those doors means the first zombie arrives
 *  **28 seconds** after the round starts — which is not tension, it is a loading screen. (The M2
 *  debug spawner hit exactly this and documented it: "pressing a key and then waiting half a
 *  minute for anything to happen reads as a broken key, not as dread.")
 *
 *  So the director generates its own candidates too: a RING of `ROUND.spawnRingSamples` points
 *  around the player between `spawnRingMin` and `spawnRingMax`. Both kinds go through the same
 *  scoring and the same visibility veto; doors get a small `spawnDoorBonus` because "they came
 *  out of the alley" reads better than "they were behind that car", and the distance band
 *  naturally prefers the ring whenever the player is out in the middle of the block.
 *
 *  A ring point is generated, not authored, so it gets two extra validity checks a door does not
 *  need: there has to be navigable ground under it, and a zombie-sized capsule has to fit there
 *  (otherwise the director happily spawns bodies inside a building wall).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THE SCORE PREFERS, once the veto has had its say:
 *   · BEHIND the player — the drop should arrive from where they are not looking.
 *   · AWAY FROM THE KITE PATH — a zombie spawned in front of a sprinting player is a wall, not
 *     a threat. The kite term is scaled by actual speed, so it goes neutral when they stand
 *     still (a stationary player has no kite path, and pretending they do biases every spawn
 *     toward one arbitrary side of the arena).
 *   · A DISTANCE BAND around `spawnIdealDistance` — near enough that the horde arrives inside
 *     the round, far enough that you watch them come (ART §9's "findable in a tenth of a second"
 *     is only worth anything if there is time to look).
 *
 * DESPERATION. If the player parks where every valid candidate is in frame, a strict director
 * spawns nothing and the round deadlocks. After `ROUND.spawnDesperationTries` consecutive
 * failures it will use the most-behind candidate beyond `spawnDesperationDistance` even if it is
 * in frame — at 45 m+ a figure resolving out of the fog reads as an approach, not a pop.
 *
 * ALLOCATION: zero after construction. Scratch vectors are module-level; the ring buffer and the
 * candidate shortlist are pre-sized typed arrays.
 */

import { Vector3 } from 'three';

import type { GameCtx, RNG } from '@/core/types';
import { DEG2RAD, TAU } from '@/core/mathx';
import { MOVE, ROUND } from '@/game/tuning';

const _dir = new Vector3();
const _target = new Vector3();
const _probe = new Vector3();
const _capA = new Vector3();
const _capB = new Vector3();

/** Eye height we aim the occlusion ray at — a zombie's chest, not its feet. */
const OCCLUSION_TARGET_HEIGHT = 1.2;
/** Pull the ray up short of the point so the ground plane itself never counts as a hit. */
const OCCLUSION_BACKOFF = 0.75;
/** Capsule used to prove a generated ring point is not inside a wall. Roughly a shambler. */
const FIT_RADIUS = 0.45;
const FIT_BOTTOM = 0.5;
const FIT_TOP = 1.5;

export class SpawnDirector {
  private readonly rng: RNG;

  /**
   * Candidate index space: `[0, doorCount)` are the arena's authored `enemySpawns`,
   * `[doorCount, doorCount + ringCount)` are this pick's generated ring points.
   */
  private readonly ringX: Float64Array;
  private readonly ringZ: Float64Array;
  private doorCount = 0;

  /** Shortlist, kept sorted best-first. */
  private readonly bestIdx: Int32Array;
  private readonly bestScore: Float64Array;
  private bestCount = 0;

  /** Cosine of the view cone, recomputed once per `pick()` rather than per candidate. */
  private cosView = -1;

  /** This round's distance band. Re-fitted by `reset(round)`; see the note there. */
  private ideal = ROUND.spawnIdealDistance;
  private minDist = ROUND.spawnMinDistance;
  /** …and the radii the generated ring is drawn from, so the band is actually reachable. */
  private ringMin = ROUND.spawnRingMin;
  private ringMax = ROUND.spawnRingMax;

  private _failures = 0;
  private _rejectedVisible = 0;
  private _desperate = 0;
  private _ringSpawns = 0;
  private _doorSpawns = 0;

  constructor(private readonly ctx: GameCtx) {
    // A private stream: the director must not shift the gameplay RNG the recoil patterns and
    // the enemy variants are drawn from.
    this.rng = ctx.rng.fork(0x5c0f7e);
    const k = Math.max(1, Math.floor(ROUND.spawnCandidates));
    this.bestIdx = new Int32Array(k);
    this.bestScore = new Float64Array(k);
    const ring = Math.max(1, Math.floor(ROUND.spawnRingSamples));
    this.ringX = new Float64Array(ring);
    this.ringZ = new Float64Array(ring);
  }

  get failures(): number { return this._failures; }
  /** How many times a candidate was thrown out purely because the player could see it. */
  get rejectedVisible(): number { return this._rejectedVisible; }
  get desperateSpawns(): number { return this._desperate; }
  get ringSpawns(): number { return this._ringSpawns; }
  get doorSpawns(): number { return this._doorSpawns; }

  /**
   * New round: the desperation counter is per-situation, not per-run, and the distance band is
   * re-fitted to the round.
   *
   * THE OPENING. The first rounds pull the band in toward the player (`spawnIdealDistanceEarly`
   * / `spawnMinDistanceEarly`): 25 m of ideal distance is a ~15 s approach, which is right once
   * a round is a fight and wrong when a round is eight zombies and the player has not learned
   * to push into them yet. The VISIBILITY VETO below is untouched and stays absolute — nothing
   * may materialise where the player can see it appear, at any distance.
   */
  reset(round = 1): void {
    this._failures = 0;
    const early = round <= ROUND.spawnEarlyRounds;
    this.ideal = early ? ROUND.spawnIdealDistanceEarly : ROUND.spawnIdealDistance;
    this.minDist = early ? ROUND.spawnMinDistanceEarly : ROUND.spawnMinDistance;
    // Pulling the SCORING band in is useless if the candidates are all still 19–34 m out, so the
    // generated ring moves with it. Derived from the band rather than two more tuning constants.
    this.ringMin = early ? ROUND.spawnMinDistanceEarly : ROUND.spawnRingMin;
    this.ringMax = early ? ROUND.spawnIdealDistanceEarly + 8 : ROUND.spawnRingMax;
  }

  /**
   * Choose a spawn position. Returns true and writes `out` (ground-snapped and jittered), or
   * false if there is nowhere legal right now — in which case the caller should try again on
   * the next tick rather than lowering its standards.
   */
  pick(out: Vector3): boolean {
    const ctx = this.ctx;
    const doors = ctx.world.enemySpawns;
    this.doorCount = doors.length;

    const p = ctx.player.position;

    // Flatten the look direction: the frustum test is horizontal, and a player staring at the
    // sky must not be treated as "looking at" the whole arena.
    const look = ctx.player.lookDir;
    let fx = look.x;
    let fz = look.z;
    const fLen = Math.hypot(fx, fz);
    if (fLen > 1e-4) { fx /= fLen; fz /= fLen; } else { fx = 0; fz = -1; }

    const vel = ctx.player.velocity;
    let vx = vel.x;
    let vz = vel.z;
    const speed = Math.hypot(vx, vz);
    if (speed > 1e-3) { vx /= speed; vz /= speed; } else { vx = 0; vz = 0; }
    // The kite term only matters at speed; full weight from walk speed up.
    const kiteWeight = ROUND.spawnKiteAvoidWeight * Math.min(1, speed / Math.max(1e-3, MOVE.walkSpeed));

    this.buildRing(p);
    this.cosView = this.cosViewLimit();

    const total = this.doorCount + this.ringX.length;
    this.bestCount = 0;
    for (let i = 0; i < total; i++) {
      const isDoor = i < this.doorCount;
      const cx = isDoor ? (doors[i] as Vector3).x : this.ringX[i - this.doorCount];
      const cz = isDoor ? (doors[i] as Vector3).z : this.ringZ[i - this.doorCount];
      const dx = cx - p.x;
      const dz = cz - p.z;
      const d = Math.hypot(dx, dz);
      if (d < this.minDist || d > ROUND.spawnMaxDistance) continue;

      const ux = dx / d;
      const uz = dz / d;
      const behind = -(ux * fx + uz * fz);          // +1 directly behind the player
      const away = -(ux * vx + uz * vz);            // +1 opposite their travel
      const band = 1 - Math.min(1, Math.abs(d - this.ideal) / this.ideal);

      const score =
        behind * ROUND.spawnBehindWeight +
        away * kiteWeight +
        band * ROUND.spawnDistanceWeight +
        (isDoor ? ROUND.spawnDoorBonus : 0) +
        this.rng.next() * ROUND.spawnScoreJitter;

      this.insert(i, score);
    }

    if (this.bestCount === 0) { this._failures++; return false; }

    // Walk the shortlist best-first and take the first one the player cannot see appear.
    for (let k = 0; k < this.bestCount; k++) {
      const idx = this.bestIdx[k];
      if (this.visibleFrom(p, idx, fx, fz)) { this._rejectedVisible++; continue; }
      if (this.place(idx, out)) { this.tally(idx); this._failures = 0; return true; }
    }

    // Nothing invisible was usable. Hold the line unless we have been failing for a while.
    this._failures++;
    if (this._failures < ROUND.spawnDesperationTries) return false;

    for (let k = 0; k < this.bestCount; k++) {
      const idx = this.bestIdx[k];
      const dx = this.candidateX(idx) - p.x;
      const dz = this.candidateZ(idx) - p.z;
      if (Math.hypot(dx, dz) < ROUND.spawnDesperationDistance) continue;
      if (this.place(idx, out)) { this.tally(idx); this._failures = 0; this._desperate++; return true; }
    }
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** One random-phase ring of candidates around the player, regenerated per pick. */
  private buildRing(p: Vector3): void {
    const n = this.ringX.length;
    const phase = this.rng.next() * TAU;
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * TAU;
      const r = this.rng.range(this.ringMin, this.ringMax);
      this.ringX[i] = p.x + Math.cos(a) * r;
      this.ringZ[i] = p.z + Math.sin(a) * r;
    }
  }

  private candidateX(i: number): number {
    return i < this.doorCount
      ? (this.ctx.world.enemySpawns[i] as Vector3).x
      : this.ringX[i - this.doorCount];
  }

  private candidateZ(i: number): number {
    return i < this.doorCount
      ? (this.ctx.world.enemySpawns[i] as Vector3).z
      : this.ringZ[i - this.doorCount];
  }

  private candidateY(i: number): number {
    return i < this.doorCount ? (this.ctx.world.enemySpawns[i] as Vector3).y : this.ctx.player.position.y;
  }

  private tally(i: number): void {
    if (i < this.doorCount) this._doorSpawns++;
    else this._ringSpawns++;
  }

  /** Insertion into the fixed-size best-first shortlist. No allocation, no sort. */
  private insert(index: number, score: number): void {
    const cap = this.bestIdx.length;
    let at = this.bestCount;
    while (at > 0 && this.bestScore[at - 1] < score) at--;
    if (at >= cap) return;
    const end = Math.min(this.bestCount, cap - 1);
    for (let i = end; i > at; i--) {
      this.bestIdx[i] = this.bestIdx[i - 1];
      this.bestScore[i] = this.bestScore[i - 1];
    }
    this.bestIdx[at] = index;
    this.bestScore[at] = score;
    if (this.bestCount < cap) this.bestCount++;
  }

  /**
   * Would a body appearing here be seen appearing? Frustum first (one dot product), then — only
   * if it is inside the cone — a single occlusion ray from the eye.
   */
  private visibleFrom(p: Vector3, index: number, fx: number, fz: number): boolean {
    const cx = this.candidateX(index);
    const cz = this.candidateZ(index);
    const dx = cx - p.x;
    const dz = cz - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return true;
    const dot = (dx / d) * fx + (dz / d) * fz;
    if (dot < this.cosView) return false; // outside the cone — invisible, no ray needed.

    const eye = this.ctx.player.eye;
    _target.set(cx, this.candidateY(index) + OCCLUSION_TARGET_HEIGHT, cz);
    _dir.copy(_target).sub(eye);
    const len = _dir.length();
    if (len < 1e-4) return true;
    _dir.multiplyScalar(1 / len);
    const hit = this.ctx.world.raycast(eye, _dir, Math.max(0.1, len - OCCLUSION_BACKOFF));
    return !hit.hit;
  }

  /**
   * Horizontal half-FOV of the LIVE camera plus the safety margin, as a cosine.
   * `camera.fov` is VERTICAL degrees, so the horizontal half-angle is
   * `atan(tan(vFov/2) · aspect)` — using the vertical angle directly would under-report the
   * cone by ~20° at 16:9 and let a spawn pop in at the edge of the screen. Reading it live also
   * means an ADS zoom (which narrows the FOV) correctly *widens* what counts as off-screen.
   */
  private cosViewLimit(): number {
    const cam = this.ctx.camera;
    const halfV = cam.fov * 0.5 * DEG2RAD;
    const halfH = Math.atan(Math.tan(halfV) * Math.max(0.2, cam.aspect));
    return Math.cos(Math.min(Math.PI, halfH + ROUND.spawnViewMarginDeg * DEG2RAD));
  }

  /**
   * Scatter, snap to ground, and prove a body actually fits. The fit test only matters for
   * generated ring points — an authored door is known-good — but running it on both costs one
   * capsule query on the one candidate we are about to use, and it is what stops the director
   * dropping a shambler inside a building.
   */
  private place(index: number, out: Vector3): boolean {
    const j = ROUND.spawnJitter;
    const baseX = this.candidateX(index);
    const baseZ = this.candidateZ(index);
    const baseY = this.candidateY(index);

    for (let attempt = 0; attempt < 2; attempt++) {
      // First try jittered, then the exact point — jitter can walk off a narrow alley mouth.
      const x = attempt === 0 ? baseX + this.rng.range(-j, j) : baseX;
      const z = attempt === 0 ? baseZ + this.rng.range(-j, j) : baseZ;
      _probe.set(x, baseY + 1.5, z);
      const g = this.ctx.world.groundAt(_probe);
      if (g === null) continue;
      if (!this.fits(x, g, z)) continue;
      out.set(x, g, z);
      return true;
    }
    return false;
  }

  /** Does a zombie-sized capsule stand free here? Non-zero penetration depth = inside geometry. */
  private fits(x: number, y: number, z: number): boolean {
    _capA.set(x, y + FIT_BOTTOM, z);
    _capB.set(x, y + FIT_TOP, z);
    const hit = this.ctx.world.collideCapsule(_capA, _capB, FIT_RADIUS);
    return hit.depth <= 0.02;
  }
}

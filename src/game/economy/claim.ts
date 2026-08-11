/**
 * INTERACT ARBITRATION — who owns the `interact` key this frame, the wall or the machine.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS, WITH THE MEASUREMENT THAT FORCED IT
 *
 *  `wallbuys.ts` and `box.ts` are two independently registered systems that both answer the
 *  SAME key and both write the SAME `ui:prompt` channel, and neither could see the other. Each
 *  file assumed the collision was theoretical — wallbuys.ts literally says "the only cost is
 *  that standing inside both radii at once lets the nearer one win, which is the behaviour you
 *  want anyway". Nothing implemented that. Nothing could: neither knew the other's distance.
 *
 *  It is not theoretical. Both placement solvers ask `WorldService` for flat, reachable, spawn-
 *  distant ground, so they *agree*, and on the shipped arena (seed 0x1234) they agree twice:
 *
 *      wall(-3.8, -20.3) × perk site 2  =  1.11 m apart
 *      wall(27.3, -17.7) × perk site 4  =  2.70 m apart
 *
 *  against a wall radius of 3.2 m and a machine radius of 2.6 m — overlap begins at 5.80 m. So
 *  there are two spots on the map where ONE press of F bought a wall weapon AND a perk, taking
 *  both prices, and where the prompt line showed whichever of the two had most recently changed
 *  its own string rather than whichever you were standing at.
 *
 *  THE RULE: NEAREST WINS, MACHINE TAKES TIES. A perk machine, Pack-a-Punch and the box are
 *  metre-wide props you walk up to; a wall-buy is chalk on the wall those props get parked
 *  against. When you are equidistant you are looking at the prop.
 *
 *  THE PHASE ORDER, which is why `main.ts` registers the wall-buys FIRST. Both layers publish
 *  their distance in `fixedUpdate` before either arbitrates, so at or below 120 fps every
 *  comparison is between two poses from the same step. Above 120 fps a frame can run zero fixed
 *  steps and the machine layer's distance is then one frame old — 8.3 ms, i.e. 7 cm at the
 *  8 m/s sprint ceiling, against props that are at least 1.1 m apart.
 *
 *  CORRECTNESS DOES NOT DEPEND ON THAT. `takeInteract` stamps the frame the PRESS happened on
 *  (not the frame it is spent on — the machine layer defers a press latched on a zero-step frame
 *  into the next frame's fixed step), so at most one purchase can ever come out of one press no
 *  matter how stale either distance is. Only the choice of winner is best-effort.
 *
 *  No allocation (five module-level numbers, written in place), no RNG, no clock — arbitration
 *  is a pure function of two squared distances and the frame counter, so a replay of the same
 *  inputs makes the same purchase.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Who is asking. Not an enum: these are compared, never printed. */
export const OWNER_WALL = 1;
export const OWNER_MACHINE = 2;

/** Squared distance to the nearest thing each layer would sell you, or `Infinity` for none. */
let wallD2 = Infinity;
let machineD2 = Infinity;
/** The frame an `interact` edge was already spent on, so it can never be spent twice. */
let usedFrame = -1;

/**
 * Publish this layer's current candidate. Both layers call this EVERY frame they run, including
 * the frames where nothing is in range — a stale `Infinity` that never gets refreshed would let
 * a layer keep winning arbitration after the player has walked away from it.
 */
export function publishDistance(owner: number, d2: number): void {
  if (owner === OWNER_WALL) wallD2 = d2;
  else machineD2 = d2;
}

/**
 * Is this layer the one the player is standing at? Pure — safe to call every frame for the buy
 * prompt, and it must be, because the prompt and the purchase have to agree about who owns the
 * spot or the line will offer you something the key does not buy.
 *
 * The machine takes ties, so the two tests are deliberately asymmetric (`<` vs `<=`) and cannot
 * both be true.
 *
 * The finiteness guard is not decoration: ties go to the machine, and with NOTHING in range both
 * distances are `Infinity`, so `machineD2 <= wallD2` was true and the machine "owned" a spot in
 * the middle of an empty street. Both callers happen to check that they have a candidate before
 * asking, so it never misfired — it was a trap lying in wait for the third caller.
 */
export function ownsSpot(owner: number): boolean {
  if (owner === OWNER_WALL) return wallD2 < machineD2;
  return machineD2 < Infinity && machineD2 <= wallD2;
}

/**
 * Consume the `interact` edge for this frame, or refuse. Returns `true` at most once per frame
 * across both layers — the frame stamp is the hard guarantee; `ownsSpot` only decides which of
 * the two gets it.
 *
 * Call this ONLY on the frame a press actually landed, and only when you are about to act on it.
 */
export function takeInteract(frame: number, owner: number): boolean {
  if (frame === usedFrame) return false;
  if (!ownsSpot(owner)) return false;
  usedFrame = frame;
  return true;
}

/**
 * Drop everything. Called from both layers' `dispose()` so a torn-down run cannot leave a live
 * distance behind for the next one — module state outlives a system, which is the one hazard a
 * module-level broker carries.
 */
export function resetInteractClaims(): void {
  wallD2 = Infinity;
  machineD2 = Infinity;
  usedFrame = -1;
}

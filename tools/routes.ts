/**
 * THE VERTICAL ROUTES OF THE ARENA — one table, shared by every harness that walks them.
 *
 * This used to live inside `tools/stairs.ts`. It moved here the moment a second harness
 * (`tools/map.ts`, which asserts each flight's COLLISION profile rather than whether a body
 * can walk it) needed the same nine coordinates: two copies of a staircase table is exactly
 * how one of them ends up quietly testing empty air after somebody moves a flight.
 *
 * Coordinates are duplicated from `world/arena.ts` §6.6 ON PURPOSE. They are an assertion, not
 * a lookup: if a flight moves and this table does not, `stairs.ts` reports STUCK and `map.ts`
 * reports a gap in the profile, both loudly. A harness that read the coordinates back out of
 * the arena could not fail that way, and would therefore be worth much less.
 */

export interface StairCase {
  id: string;
  /** Foot of the flight, in world metres. */
  bottom: [number, number, number];
  /** Head of the flight. */
  top: [number, number, number];
  /** How far behind the foot the walk starts. */
  back: number;
  note: string;
}

/** Arena constants, mirrored from `world/arena.ts`. */
export const STOREY = 3.4;
export const DECK_Y = STOREY * 2;          // 6.8
export const DECK2_Y = STOREY * 4;         // 13.6
export const BLOCK_C = 42;
export const FIRE_X = -26.4;               // west.cx + west.w/2 + 2.6
export const DOCK_Z = 26.4;                // south.cz - south.d/2 - 0.6 - 2.0

export const STAIRS: readonly StairCase[] = [
  { id: 'plaza_stair', bottom: [17.4, 0, 22.4], top: [27.4, DECK_Y, 22.4], back: 2.2,
    note: 'LOOP D — plaza up to the east gantry' },
  { id: 'east_stair', bottom: [58.5, 0, -28.0], top: [58.5, DECK_Y, -44.0], back: 2.2,
    note: 'LOOP D — ring boulevard up to the NE market roof' },
  { id: 'fire_escape_1', bottom: [FIRE_X, 0, -16.0], top: [FIRE_X, DECK_Y, -8.0], back: 2.2,
    note: 'LOOP F — west fire escape, flight 1' },
  { id: 'fire_escape_2', bottom: [FIRE_X, DECK_Y, -5.2], top: [FIRE_X, DECK2_Y, 2.8], back: 2.0,
    note: 'LOOP F — west fire escape, flight 2 (off a half-landing)' },
  { id: 'west_high_s', bottom: [FIRE_X, DECK_Y, 28.0], top: [FIRE_X, DECK2_Y, 19.4], back: 2.0,
    note: 'LOOP F — south flight back up to the 13.6 m catwalk' },
  { id: 'west_low_s', bottom: [FIRE_X, 0, 39.4], top: [FIRE_X, DECK_Y, 30.8], back: 2.2,
    note: 'LOOP F — south-west street mouth up to the half-landing' },
  { id: 'dock_steps_w', bottom: [-22.5, 0, DOCK_Z], top: [-19.5, 1.2, DOCK_Z], back: 2.2,
    note: 'LOOP G — west end of the south loading dock' },
  { id: 'dock_steps_e', bottom: [10.5, 0, DOCK_Z], top: [7.5, 1.2, DOCK_Z], back: 2.2,
    note: 'LOOP G — east end of the south loading dock' },
  // Not a ramp: the dais is three DISCRETE 0.19 m collide-boxes on top of a 0.45 m plinth, so
  // it is the only vertical route in the arena that can only be climbed by the step-up path.
  { id: 'plaza_dais', bottom: [0, 0, 9.4], top: [0, 0.9, 4.0], back: 2.2,
    note: 'plaza monument — DISCRETE steps, the pure step-up case' },
];

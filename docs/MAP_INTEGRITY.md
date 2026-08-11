# MAP INTEGRITY — "walls are walls, stairs are stairs"

> *"check map, some walls i can walk trough inside, map should be perfectly pixel perfect, stairs
> are stairs, walls are walls, and it has to be consistent, add that to fix as a whole later"*
> — the playtester

**Status: QUEUED.** Deliberately scheduled after the feel/perf, weapons and economy work, at the
player's own instruction ("fix as a whole later"). This file is the spec so the job can start cold.

Do this as **one pass over the whole arena**, not as a series of one-off patches. Patching
individual walls is how you end up with an arena that is 95% solid forever — the value is in the
*invariant*, not in any single fix.

---

## 1. THIS IS ALREADY MEASURABLE, AND IT IS ALREADY FAILING

Do not start by hunting for holes by hand. **`node tools/stairs.mjs` already fails 3 checks**, and
they are almost certainly the same defect the player is describing from the other side:

```
HORDE · 25 BODIES x 120 s — PLAYER AT SPAWN
  inside geometry           6 bodies (16 samples), worst overlap 1.42 m
  stalled while chasing >2s  10 bodies, worst single stall 22.9 s

HORDE · 25 BODIES x 120 s — PLAYER CAMPED ON THE NE ROOF
  inside geometry           13 bodies (138 samples), worst overlap 0.42 m
  stalled while chasing >2s  10 bodies, worst single stall 28.6 s
```

**A 1.42 m overlap is not a grazed corner — that is a body a metre and a half inside a solid
object.** If a zombie can be there, so can the player, and that is exactly "some walls i can walk
trough inside". These numbers are long-standing and were verified byte-identical before and after
BUILD 008, so they are not a recent regression — they have been shipping the whole time.

**The harness is therefore the scoreboard for this job.** Both `inside geometry` counts must go to
zero and stay there. Anyone working on this should be able to state the number before and after.

---

## 2. THE THREE FAILURE MODES TO SEPARATE

These have different causes and must not be conflated:

1. **A hole in the collision mesh.** Visual geometry exists but no collider was emitted for it, or
   the collider is smaller than the drawing. You walk through a wall that is plainly there.
2. **A collider that disagrees with the drawing.** The wall stops you 20 cm before/after its
   visible face. Reads as "the map is not pixel perfect" even though nothing is passable.
3. **A tunnelling / resolution failure.** The collider is correct but the swept-capsule solve lets
   a fast body (slide, dive, sprint, or a 4.13 m/s sprinter zombie) pass through it in one step,
   or pushes it out the wrong side. This is a *mover* bug, not a *geometry* bug, and it is the
   most likely explanation for a 1.42 m overlap.

Diagnose which one each site is before changing anything. A fix for (1) applied to a case of (3)
just moves the bug.

---

## 2.5 FIRST FINDINGS — read these before starting, they change where you look

A read-only pass has already narrowed this considerably. Three facts:

**(a) It is not a harness artifact.** `tools/stairs.ts::overlapAt` does not implement its own
geometry test — it calls the game's own `world.collideCapsule()` and reports the depth that
solver returns. So a 1.42 m reading means **the collision solver itself knows the body is 1.42 m
inside a solid, and the mover — using that same solver — is failing to push it out.** The engine
is not confused about where the wall is.

**(b) Someone has already been here, and treated the symptom.** `src/game/motion/mover.ts` has a
`maxCorrection` cap, and the horde ships at 1.5 m against the player's 0.5 m. The comment says
why, verbatim:

> *"The horde ships at the 1.5 default because clamping bodies to 0.5 stops them ever escaping a
> wall they are genuinely inside: roof-camp inside-geometry samples went 426 → 4394 and the worst
> stall 2.7 s → 10.1 s. A stuck zombie is worse than a fast one."*

That is an **escape-rate** fix. It makes bodies claw out of walls faster; it never asked how they
get in. The phrase "a wall they are genuinely inside" is the admission. **Do not tune
`maxCorrection` again — that road has been walked. Find the entry mechanism.**

**(c) The roof-camp case is more than twice as bad** (13 bodies / 138 samples, vs 6 / 16 at
spawn). That asymmetry is the strongest clue available, because the difference between the two
scenarios is not the geometry — it is the CROWD. When the player camps somewhere the horde cannot
reach, bodies pile up against walls, still pushing. So the leading hypothesis is:

> **Bodies are being forced into geometry by the horde's own separation/crowding forces, faster
> than depenetration can push them back out.** The mover resolves penetration with 4 iterations
> per substep; if the neighbour-separation push is reapplied every step, a body in a crowd against
> a wall is in a fight between two forces and can lose.

If that is right, the fix is NOT in the collision mesh at all — it is that **depenetration must
win over crowd pressure**, e.g. by resolving penetration last, by damping separation for a body
already in contact with a wall, or by clamping the crowd push along the contact normal.

Test it cheaply before building anything: log, for the worst offenders, whether the body's
pre-resolution position was pushed inward by neighbour separation that step. If yes, this is a
horde-steering bug wearing a collision bug's clothes.

The other two candidates remain open and should be ruled out with the same evidence-first
approach: **tunnelling** at speed (a sprinter at 4.13 m/s against `maxSubsteps`), and **spawn
placement** putting a body inside a prop.

## 3. WHERE TO LOOK

- `src/world/arena.ts` — ~2,500 lines of procedural construction. The likely source of (1): a prop
  or wall drawn but never registered with the collision builder.
- `src/world/collision.ts` (and the octree it builds) — the source of (2). 4,464 collision
  triangles today.
- `src/game/motion/mover.ts` — the shared swept-capsule mover used by BOTH player and enemies. The
  source of (3), and the highest-value place to look, because a fix here fixes every site at once.
- `src/world/nav.ts` — the nav graph is *derived* from the collision octree, so holes in collision
  become holes in navigation. This is very likely why 10 bodies stall for 20+ seconds: they are
  routed through geometry that the graph thinks is passable.

**That last link is the important one.** "Walls I can walk through", "zombies stuck inside walls"
and "zombies stalling for 22 seconds" may well be ONE root cause with three symptoms. Fixing
collision integrity could resolve the stalls for free — and the stalls are the measurable half of
the player's separate note that the zombies *"can be a bit smarter"*.

---

## 4. THE DELIVERABLE: AN INVARIANT, NOT A LIST OF PATCHES

Write a harness (extend `tools/stairs.mjs` or add `tools/map.mjs`) that proves the arena is sound,
and make it part of the standing checks:

- **Every visual mass has a collider.** Walk the arena's construction output and assert that each
  drawn solid registered collision geometry within a tolerance of its bounds. This catches (1)
  at the source instead of by playtesting.
- **No reachable point is inside a solid.** Sample the walkable surface densely; for each point
  assert the player capsule does not intersect collision geometry.
- **No pass-through at speed.** Fire the player capsule at every wall face at the maximum speed
  the movement kit can produce (sprint + slide-cancel + dive — the dive is the fastest thing in
  the game and the most likely to tunnel) and assert it is stopped every time.
- **Stairs are ramps, not steps you can clip into.** `tools/stairs.mjs` already walks all 9
  staircases and reports CLIMBED for each; extend it to assert the *collision* profile of each
  flight is monotonic, with no lip taller than `MOVE.stepHeight` (0.45) and no gap.
- **Ledges fall.** Already covered and passing — keep it.

**Gate: both `inside geometry` counts at 0, all pass-through tests stopped, stairs monotonic.**

---

## 5. WHY IT IS WORTH DOING PROPERLY

The stated destination is a competitive game with leaderboards (`GAME_BIBLE §8.5`). A run that
ends because the player fell through a wall — or worse, a leaderboard time set by exploiting one —
is the one class of bug that invalidates the entire scoring premise. Determinism protects the
*simulation*; map integrity protects the *space the simulation happens in*.

It is also the difference between "an impressive tech demo" and "a game", and the player named it
in exactly those terms: **it has to be consistent.**

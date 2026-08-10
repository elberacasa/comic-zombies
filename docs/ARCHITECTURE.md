# ARCHITECTURE — Comic Zombies

## 1. Rules

1. **`src/core/types.ts` and `src/core/events.ts` are the integration seam.** Systems depend on
   *interfaces* from `types.ts` and communicate via the event map. A game system must never
   import another game system's implementation file.
2. **One owner per file.** Parallel agents get disjoint ownership (§4). Never edit a file you
   don't own — emit an event or request a contract change instead.
3. **Fixed-timestep sim, interpolated render.** `fixedUpdate` is deterministic gameplay;
   `update` is presentation. Nothing gameplay-critical in `update`.
4. **Pool everything spawned per-frame.** Bullets, decals, particles, damage numbers, word pops.
5. **Zero allocation in hot loops.** Module-level scratch vectors, `_v1`, `_v2`, … prefixed `_`.
6. **All feel constants live in `src/game/tuning.ts`.** Never a magic number in a system file.
7. **All colours come from `src/art/palette.ts`.** Never a raw hex in a system file.

## 2. Module tree

```
src/
  main.ts                 # boot, system registration + order, the frame loop owner
  core/
    types.ts   ⛔frozen    # all cross-module interfaces
    events.ts  ⛔frozen    # typed event map + Emitter
    loop.ts               # fixed-timestep accumulator, system runner
    time.ts               # Time impl: timeScale, hitstop
    input.ts              # keyboard/mouse → ActionName, pointer lock, look delta
    rng.ts                # seeded deterministic RNG (sfc32/mulberry32)
    pool.ts               # generic object pool + ring buffers
    mathx.ts              # damping, spring, easing, scratch vectors, angle helpers
    debug.ts              # DebugService: watch panel, debug draw
  art/                    # PROCEDURAL ASSET FACTORY — nothing here loads a file
    palette.ts            # locked colour tokens
    textures.ts           # canvas/procedural textures: halftone, newsprint, ink splat, decals
    shapes.ts             # comic geometry builders: beveled boxes, ink-crease meshes, shards
    letters.ts            # onomatopoeia canvas rendering (word pops, damage numbers)
  render/
    renderer.ts           # RenderService impl: WebGLRenderer, MRT targets, quality tiers
    pipeline.ts           # the post stack, in the fixed order from ART_DIRECTION §4
    passes/               # one file per pass: ink.ts, halftone.ts, bloom.ts, grade.ts, grain.ts …
    materials/index.ts    # makeInkMaterial + outline (inverted hull) + boiling line
  world/
    arena.ts              # procedural arena construction + spawn points
    collision.ts          # WorldService impl: octree raycast + capsule resolve
    nav.ts                # navigation LIBRARY: column lattice, climb/drop links, flow field
    lighting.ts           # the 3-light rig, banded fog, god-rays
  game/
    tuning.ts             # EVERY feel constant
    player/               # controller, camera, stats, health
    weapons/              # defs.ts (content), service, firing, recoil, viewmodel
    enemies/              # defs, service, ai steering, body factory, reactions
    rounds/               # director, spawn logic, economy, combo
    boons/                # defs.ts (content) + service (modifier stack)
    powerups/
  ui/
    hud.ts                # DOM+canvas comic HUD
    cards.ts              # boon draw, title cards, run summary
    boot.ts               # the boot / pause / fail overlay
    navdraw.ts            # nav-graph debug overlay (F8), drawn through ctx.debug.line
  audio/
    engine.ts             # WebAudio graph, spatialization, ducking
    synth.ts              # recipe-based one-shot synthesis (no samples)
```

## 3. System registration order (`main.ts`)

Order matters — later systems see this frame's results of earlier ones.

```
input → world → player → weapons → enemies → rounds → boons
      → vfx → audio → hud → cards → navdraw → debug → render
```

**Two edges in that order are load-bearing and are documented at their call sites in `main.ts`:**

- **`rounds` after `enemies`** — the director decides a round is over by reading
  `enemies.aliveCount`, so running it first clears the round a frame early.
- **`navdraw` before `debug`** — anything that draws into `DebugSystem`'s segment buffer must
  run before the system that expires and uploads it, or its lines are a frame late. (Until
  BUILD 005 the buffer had never had a consumer, and a stale timestamp meant lines drawn by an
  earlier system were dropped as expired before they were ever uploaded. `debug.ts` now stamps
  segments against the live clock, so this ordering works.)

### The navigation graph's home

`src/world/nav.ts` is a **library**, not a system: no per-frame state, and it depends on a
two-method `NavProbe` shape rather than on `WorldService`. The instance is owned by
`game/enemies/service.ts` (`EnemySystem.nav`), because `core/types.ts` is frozen and the graph's
proper home — `ctx.world.nav` — cannot be added to it without a coordinated contract change.
**If a second consumer appears** (director reachability, power-up placement, a wall-buy that
must be reachable), promote `nav` onto `WorldService` rather than importing the enemy system.
`ui/navdraw.ts` is the model to follow: it takes a `() => NavGraph | null` getter from `main.ts`
and imports only the library's types.

## 4. FILE OWNERSHIP (updated per milestone — check before dispatching agents)

### M1 — The Look Test
| Agent | Owns | Must not touch |
|---|---|---|
| `engine-core` | `src/core/{loop,time,input,rng,pool,mathx,debug}.ts` | `core/types.ts`, `core/events.ts`, everything else |
| `art-lib` | `src/art/**` | `render/**`, `world/**` |
| `render-pipeline` | `src/render/**` | `art/**` (import only), `world/**` |
| `arena` | `src/world/**` | `render/**` (import only) |
| `integration` | `src/main.ts`, `src/ui/**`, `src/game/tuning.ts` | others' files, except to fix a broken import |

Seeded by the lead (safe to extend, don't rewrite the API):
`src/art/palette.ts`, `src/render/materials/index.ts`.

## 5. Cross-cutting conventions

- **Units:** metres, seconds, radians. Player eye height 1.7m, zombie ~1.85m.
- **Axes:** Y up, -Z forward for the camera.
- **Layers:** `0` default, `1` outline-hull, `2` emissive/bloom, `3` no-post overlay.
- **Naming:** systems are `XxxSystem implements System`; factories are `makeXxx`/`buildXxx`;
  pure data lives in `defs.ts` files.
- **Disposal:** every system that creates GPU resources implements `dispose()`.
- **Debug:** `ctx.debug.watch('label', () => value)` in `init` for anything worth tuning live.

## 6. Performance budget (per frame @1080p, mid laptop GPU)

| | budget |
|---|---|
| Draw calls | ≤ 350 (instance zombies, merge static arena) |
| Triangles | ≤ 900k |
| Post passes | ≤ 8 at ULTRA, ≤ 4 at LOW |
| Sim (fixedUpdate ×2) | ≤ 3 ms |
| JS heap growth | ~0 during steady play (pooling) |

## 7. HEADLESS REGRESSION HARNESSES

Three suites run the **real** game — arena, collision octree, controller, enemy system — in node
with no browser and no pointer lock, by bundling through vite so `@/…` and `three/addons/…`
resolve exactly as they do in the page. `tools/domstub.ts` shims the canvas so the procedural
texture pass runs headless. Each exits non-zero on failure.

```bash
node tools/stairs.mjs    # movement: every staircase walked AND sprinted at 3 lateral offsets,
                         # every ledge walked off, horde stair climb, 25x120s stuck soak
node tools/zombie.mjs    # the skinned rig: bones, skin weights, hitbox-vs-drawn-mesh alignment
node tools/combat.mjs    # hit registration, health curve, speed tiers, conga tightness
```

**Run these before declaring any movement or combat change done.** They exist because the same
bugs shipped twice from browser-only testing: the stairs regression was invisible until a suite
walked every flight at an angle, and the input-edge bug only appears on frames that run zero
fixed steps. A browser check cannot reliably produce either condition.

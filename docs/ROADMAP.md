# ROADMAP — Comic Zombies

## ▶ CURRENT STATUS

| | |
|---|---|
| **Milestone** | **M3.5 — They Climb** (M1, M1.5, M2, M3 shipped) |
| **State** | M3.5 + the BUILD 006 hardening pass, verified in Chrome; logged as BUILD 006 |
| **Next user playtest** | BUILD 006 — judge the camping fight, the sprint/ADS pose, and the mix |
| **Blocked on** | nothing. User feedback on BUILD 005 outranks M4 when it arrives. |
| **Last updated** | 2026-08-10 |

**Shipped so far.** M1 proved the renderer, M1.5 answered every line of the human's BUILD 001
feedback with measured results, M2 made it a game you can play, M3 made it a run you want to
repeat, and M3.5 is the human's four BUILD 004 notes and nothing else: zombies that navigate and
climb, a sprint pose that is out of the way, iron sights on the camera axis, and a mix that
reacts. Current verified numbers (BUILD 006): stillness **0.21%** idle / **0.20%** at ADS (budget 0.5%),
straight-line drift **0.00000000 m** over 29.4 m of pure-W travel, camera roll **0.30°** walking /
**0.46°** sprinting / **1.70°** strafing (budget 4°), FOV punch **+4.82°** (budget 8°), **250 draw
calls / 486k tris** with 25 zombies all in frame (budget 350 / 900k), navigation **zero** while
nobody needs it. Details per build in `docs/PLAYTEST.md`.

**The east gantry is the one camp left, and it is geometry.** Every graph route onto it costs
81–120 m for a 13–22 m crow flight and contains no climb at any limit — the arena gives that deck
one entrance. It needs an intermediate tier or a second flight in `world/arena.ts`; no AI or cost
tuning can reach it.

**The known weak spot, carried forward:** everything above ~6.8 m — roof decks, catwalks, the
high routes — is still a two-value violet poster (70.7% void in the worst frame). It survived
M1.5 and M2. It should be fixed in M5 at the latest, sooner if the human notices it.

---

## How we sequence (and why)

A big studio front-loads the two things that are most expensive to be wrong about:
**the art direction** and **the core feel**. Everything else is comparatively cheap to change.
So M1 proves the look, M2 proves the feel, and only then do we build content on top of a
foundation we've already validated with a human.

Each milestone ends with **`npm run dev` → the user plays → feedback goes in `PLAYTEST.md`**.
Feedback outranks the roadmap. Tuning passes get scheduled before new features, always.

---

## M0 — Pre-production ✅
Vision locked, art direction locked, architecture + typed contracts, project scaffold.
**Deliverable:** `CLAUDE.md`, `docs/*`, `src/core/types.ts`, `src/core/events.ts`, build pipeline.

## M1 — The Look Test ✅
Prove the comic renderer at AAA quality before anything is built on it.
- Engine core: fixed-timestep loop, input, event bus, time, RNG, pooling
- `InkMaterial` (cel bands + halftone + rim), inverted-hull outlines, boiling line
- Full post stack: edge detect, halftone, selective bloom, chromatic offset, grade, grain, vignette
- Procedural comic arena block-out with the 3-light rig, banded fog, god-rays
- Free-fly / walk camera, quality tier switch, debug overlay
**Done when:** a screenshot is indistinguishable from a comic book panel, at 60fps.
**User tests:** *Does this look AAA? Does it look like a comic? What's off?*

## M1.5 — Comfort, Stability, Space & Colour ✅
Driven entirely by the human's BUILD 001 feedback. Their priority order: **visuals → comfort and
consistency → performance.**

- **Comfort** (`ART §10`) — they were dizzy in under a minute. Lateral bob cut, summed roll
  capped at ~4°, FOV range reduced, plus a REDUCED-motion preset.
- **The straight-line bug** — "going straight with W feels like falling to the right". Two real
  asymmetries: a pose-roll default of `1` when strafe input is zero, and a figure-8 bob that
  translates and rolls in the same direction at the same time.
- **Image stability** (`ART §4.1`) — "every pixel jumping like glitching". The print is fixed:
  static halftone, static grain, constant misregistration. Only the drawing moves.
  **Acceptance: camera parked → two frames differ by <0.5% of pixels.**
- **Space** — arena to ~2× linear (~130-150m), buildings 6-10 storeys, long sightlines, real
  verticality. Bigger space, not a slower player. Draw calls must stay in budget via instancing.
- **Colour & value** — break the monochrome violet. Warm/cool split, real light/dark composition,
  cast shadows, dressed walls. **Acceptance: midtone band ≥40%, sub-0.1 coverage <20%.**
- **Enemy readability** (`ART §9`) — `ACID`/`HOT`, the brightest rim and the heaviest ink weight
  are now *reserved for enemies*. The environment stays in the middle value band.

- **The canvas framing bug** (found during the rescale, fixed by the lead in `index.html`) —
  `<canvas>` is a replaced element, so `position:fixed; inset:0` with `width:auto` laid it out at
  its *intrinsic* 2400×1315 inside a 1600×877 window. The player saw only the top-left of every
  frame, and the render's focus-of-expansion sat off-screen — which reads as constantly drifting
  toward one corner. Very likely a major contributor to both "falling to the right" and "feels
  small compared to speed". Fix: `width:100%; height:100%` on `#game`.

**Done when:** all six acceptance numbers pass and a screenshot leads the eye somewhere.

## M2 — Vertical Slice: the feel ✅ *(spec: `docs/M2_VERTICAL_SLICE.md` · shipped as BUILD 003)*
- Movement kit already shipped in M1; M1.5 makes it comfortable and drift-free
- One weapon (`inkslinger`) with deterministic recoil pattern, ADS, active reload, full juice
- One enemy (Shambler) with steering AI, hit reactions, dismemberment, panel-shard death
- Real `VfxService` and `AudioService` replacing the M1 stubs
- Hitstop, screen shake, camera/weapon kick as separate layers, damage numbers, word pops
**Done when:** sprint → slide → headshot is good enough that the human immediately does it again.
**User tests:** *gun feel, hit feedback, enemy readability, kiting, comfort over 10 minutes.*

## M3 — The Loop 🔨
Rounds, spawn director, points economy, combo meter, boon draw (1 of 3), health/down/death,
round title cards, run summary, HUD in full comic language, localStorage meta.
**Done when:** the user says "one more round" out loud.

## M4 — Content & Systems 🔒
Full weapon set, Pack-a-Punch + elemental affixes, wall-buys, mystery box, power-up drops,
special enemies (Sprinter, Brute, Spitter, Screamer), full boon pool (~35 boons).

## M5 — The Arena 🔒
Real level design: multi-zone arena, buyable doors that grow the map, verticality and parkour
lattice, hazards, practical lighting, environmental storytelling. Kite-path tested.

## M6 — Audio & Feel Polish 🔒
Full synthesized audio: adaptive round music, spatialized horde ambience, weapon layering,
mix pass. Second full feel-tuning pass on every mechanic based on accumulated feedback.

## M7 — Performance & Options 🔒
Quality tiers, instancing/LOD/frustum culling audit, GPU profiling, 60fps lock on mid laptop,
settings menu, sensitivity/FOV/keybinds, accessibility (colourblind-safe accent swaps).

## M8 — Ship 🔒
Main menu, how-to-play, balance pass across 30 rounds, leaderboard, build + deploy.

---

## Backlog / stretch
Co-op (WebRTC), daily seeded runs, boss waves, weapon camos as procedural ink patterns,
photo mode with panel framing, gore-slider, mobile touch controls.

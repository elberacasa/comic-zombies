# ROADMAP — Comic Zombies

## ▶ CURRENT STATUS

| | |
|---|---|
| **Milestone** | **M5 — Free Web Release** (M0–M4 shipped) |
| **State** | BUILD 007 live at comic-zombies.vercel.app; M5 starting |
| **Next user playtest** | BUILD 007 — answer `docs/HUMAN_JUDGE.md` (14 items, ~15 min) |
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

## M2 — Vertical Slice: the feel ✅ *(shipped as BUILD 003)*
- Movement kit already shipped in M1; M1.5 makes it comfortable and drift-free
- One weapon (`inkslinger`) with deterministic recoil pattern, ADS, active reload, full juice
- One enemy (Shambler) with steering AI, hit reactions, dismemberment, panel-shard death
- Real `VfxService` and `AudioService` replacing the M1 stubs
- Hitstop, screen shake, camera/weapon kick as separate layers, damage numbers, word pops
**Done when:** sprint → slide → headshot is good enough that the human immediately does it again.
**User tests:** *gun feel, hit feedback, enemy readability, kiting, comfort over 10 minutes.*

## M3 — The Loop ✅
Rounds, spawn director, points economy, combo meter, boon draw (1 of 3), health/down/death,
round title cards, run summary, HUD in full comic language, localStorage meta.
**Done when:** the user says "one more round" out loud.

## M3.5 — They Climb ✅ *(BUILD 005/006)*
The human's four BUILD 004 notes and nothing else: a navigation graph so zombies use stairs and
climb to rooftops, a sprint pose out of the way, iron sights actually on the camera axis, and a
mix that reacts to the crowd.

## M4 — The Horde Has a Body ✅ *(BUILD 007)*
Skinned procedural zombies (the head hitbox was 59% wider than the drawn skull; it now matches),
CoD's real health curve, speed tiers, conga steering for trains, plus round-by-round visual
escalation. Also fixed the stairs regression the shared mover introduced.

## M5 — FREE WEB RELEASE 🔨
Ship it publicly, for free, and find out whether strangers play past round 5. That signal decides
whether a Steam month is worth spending — and a browser game that spreads builds the wishlists a
paid launch would need anyway.

**Three strands, in this order:**

**1. Performance without losing the look.** MEASURED, not assumed — at 2560x1231 with 25 zombies
alive, GPU-inclusive and readPixels-synced:

| stage | ms | share |
|---|---|---|
| scene | 2.00 | 32% |
| **post total** | **4.19** | **68%** |

The frame is fill-rate bound. An earlier version of this plan assumed a 9-pass stack from
`ART_DIRECTION §4`; the implementation had already fused the finishing chain (chromatic, grade,
grain, vignette, overlay) into one pass, and bloom was already half-res with a downsample chain,
and the prepass already ran at 0.5 scale on every tier but ULTRA. **Most of the obvious wins were
already taken.** What is actually left:

- [x] **Fuse ink + halftone.** They were adjacent `PassChunk`s and the second consumed exactly
      what the first wrote, so the composer paid a full read-modify-write of the frame to pass
      data through VRAM instead of a local variable. Semantically exact — halftone never
      references `tDiffuse`. **1.963 → 1.714 ms/Mpix, −12.7%.** 5 passes → 4.
- [ ] **Fold bloom's final composite into the finish pass.** Bloom's blur chain runs on its own
      small targets, but its composite is a separate full-screen pass. Moving it into `finish`
      takes the stack to 3 passes with no visual change.
- [ ] **Kill the normal/depth prepass with MRT.** It is a second scene traversal — its ~36 draw
      calls are a CPU submission cost that does NOT shrink with `prepassScale`.
- [ ] **Frustum-culling audit.** Looking at the sky still draws 343k triangles.
- [ ] **Revisit instancing.** Rejected earlier because `renderer.info` counts instances as
      geometry×count — true, but that measures triangles, and the win was never triangles. It is
      draw calls and CPU submission.

**2. The arsenal** (`GAME_BIBLE §3`). `ratatat`, `boomstick`, `longshot`, `thumper`, the 2-slot
inventory with fast swap and reload-cancel-by-swap, and Pack-a-Punch with its elemental affixes.
The `WeaponDef` shape was built to carry all five archetypes without touching the service —
this milestone finds out whether that was true.

**3. Release surface.** Sensitivity and FOV must be adjustable (a shooter without a sensitivity
slider is unplayable for half the audience). Open Graph tags and a preview image so a shared link
looks like something. A first-run "desktop recommended" notice. An itch.io page next to the
Vercel build.

**Done when:** a stranger can find it, play it, and tell you what they think.

## M6 — Content & Systems 🔒
Special enemies with genuinely different BEHAVIOUR, not stat reskins — `sprinter`, `brute`,
`spitter` and `screamer` currently share one body and one AI. Wall-buys, the mystery box,
power-up drops, and the rest of the boon pool.
**Note:** points is still a dead stat until wall-buys and Pack-a-Punch land. That is the single
biggest hole in the loop.

## M7 — More Maps 🔒 *(`GAME_BIBLE §9.1`)*
A second and third arena. Content, not engineering — **if** the couplings stay honest. Anything
reading arena geometry must go through `WorldService` and the nav graph.
**Test of readiness:** a new map requires zero changes to `game/`.

## M8 — More Styles 🔒 *(`GAME_BIBLE §9.2`)*
A style is a palette + material recipes + a light rig. Swappable without touching geometry.
**Test of readiness:** the same arena renders in a second style with no geometry edits.

## M9 — Audio & Feel Polish 🔒
Adaptive round music, mix pass, a second full feel-tuning pass on accumulated feedback.

## M10 — Multiplayer 🔒 *(`GAME_BIBLE §9.3` — long way off)*
The maps and movement are the product; zombies are one mode played in them. Requires the sim to
have stayed deterministic — which is now a product requirement, not a testing convenience.
**Test of readiness:** two clients stepping the same seed and input stream land on bit-identical
state. Worth writing that harness long before any networking exists.

---

## Backlog / stretch
Co-op, daily seeded runs, boss waves, procedural weapon camos, photo mode, mobile + touch
controls (see the mobile assessment: viable, but the post stack must be merged first).

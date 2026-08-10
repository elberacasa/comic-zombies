<div align="center">

# COMIC ZOMBIES

### A game that draws itself.

**A Call-of-Duty-style round-based zombies shooter that runs in a browser tab, styled like a graphic novel — with zero downloaded assets.**

No models. No textures. No audio files. No webfonts. Every mesh is built from code, every texture is painted to a canvas at boot, every sound is synthesised from oscillators and noise.

`43,645 lines of TypeScript` · `1 runtime dependency` · `0 asset files` · `~326 kB gzipped`

Built with [Claude Code](https://claude.com/claude-code).

</div>

---

## Run it

```bash
npm install
npm run dev
```

Then open the URL it prints.

| | |
|---|---|
| **`/`** | the game |
| **`/gallery.html`** | **the asset gallery** — every texture, mesh, letterform and sound, generated live in front of you |

On the deployed site it is the other way round: **`/` is the gallery** and **`/play` is the game**.

That second page is the interesting one. It imports the game's *own* modules and calls the *same* generators, so it can't drift into being a pretty lie. Each tile prints the exact function call that produced it.

---

## The constraint

**Nothing is ever downloaded.** Not at build time, not at runtime.

This isn't purity for its own sake — it drives the art direction. Bold, flat, ink-outlined comic art is *achievable in code* at a quality that reads as premium. Photorealism is not. So the style was chosen to fit the constraint, and then the constraint was never broken.

```
TypeScript ──┬──► Canvas 2D ─────────────► textures, lettering, decals
             ├──► GLSL + BufferGeometry ─► shading, meshes, outlines
             └──► WebAudio ──────────────► every single sound
```

The entire dependency list:

```json
{ "three": "^0.185.1" }
```

---

## How it's made

| Layer | How |
|---|---|
| **Textures** | Painted with the Canvas 2D API at boot, uploaded as `CanvasTexture`. Halftone screens, newsprint grain, ink splats grown from metaballs then noise-eroded, plus tiling surface sets (concrete, rust, planks, brick, facades). Each surface returns a colour map *and* a "break-up" map that modulates halftone density and rim response. |
| **Geometry** | Chamfered boxes, faceted cylinders, jittered vertices so nothing is CAD-perfect. A seeded prop kit — barrels, crates, dumpsters, fences, lamps, broken walls, rubble. The arena is ~140×140 m of it, merged into buckets for draw-call budget. |
| **Lettering** | The `BLAM!`/`SPLAT!` engine. Canvas-drawn from a bold **system** font stack (Impact, Arial Black — OS fonts, never a downloaded webfont), given three offset outline layers, a hard drop shadow, and roughened ink edges. |
| **Shading** | `InkMaterial`, custom GLSL: three-band cel light with a hard terminator, screen-space halftone filling the shadow band, Fresnel rim, and a hard-clipped cartoon gleam. Silhouettes come from inverted-hull outlines; interior creases from a depth+normal Sobel pass. |
| **Audio** | Oscillators, code-generated noise buffers, filters, envelopes, and a convolution reverb built from a generated impulse response. 65 recipes. Not one audio file. |

---

## The one rule that mattered most

Early builds made the playtester ill. Their exact words: *"every pixel seems to be jumping like glitching."*

The fix wasn't a bug fix, it was a principle:

> **A comic page does not animate its own texture.**
> Paper doesn't shimmer. Halftone dots don't crawl. CMYK plates don't re-register every frame. Those things are *printed* — nailed to the page, and they never move.

| Layer | Rule |
|---|---|
| Halftone lattice | Perfectly static in screen space |
| Paper grain | Static — one sheet, not a new one per frame |
| Chromatic misregistration | One constant offset per session, like one bad print run |
| Boiling ink line | 12 fps, hero contours only, hard coverage budget |

The measurable version: with the camera parked, consecutive frames must differ by **under 0.5% of pixels**.

**It went from 24.77% → 0.065%.** Stand still in the finished game and the image is genuinely frozen. Only the world moves.

---

## How it was built

Not "one prompt, one game." The project runs like a small studio.

```
MILESTONE ──► AGENTS BUILD ──► ADVERSARIAL REVIEW ──► FIX PASS ──► HUMAN PLAYS
    ▲                                                                   │
    └──────────────── feedback outranks the plan ◄──────────────────────┘
```

Six milestones in about a day. Each one ends in a build a human actually plays, and their feedback sets the next milestone — not the roadmap.

The split that makes it work:

| Agents verify (cheap, objective) | The human judges (fast, free, better) |
|---|---|
| Types, build, console | Does it look good? |
| Draw calls, triangles, frame time | Does it feel good? |
| Allocation, leaks, determinism | Is it fun? |
| Hit registration, pathing, reachability | Is anything ugly or annoying? |

Machines are good at *"is this leaking"*. They're bad at *"is this satisfying"*. Every milestone ends by writing a short `docs/HUMAN_JUDGE.md` checklist — 10–15 items, each testable in under a minute.

### What adversarial review actually caught

Every one of these had already passed its own author's tests:

- **Every zombie rendered translucent.** The depth prepass used a stock material that couldn't run the vertex shader posing the body. Two individually-correct decisions, broken only in combination.
- **Slide was silently dropped on every kill.** Input edges died on frames that ran zero fixed steps — and hitstop, added a milestone later, opened exactly that hole on every kill.
- **Knockback was squared.** A units mismatch across a module boundary produced 386 m/s of knockback: one headshot threw a zombie 65 m, so every follow-up shot missed.
- **The player floated instead of falling.** `grounded` was only ever set true, never derived from the world. Measured: 0 of 17 ledges fell.
- **Every ground light pool was invisible.** Fan geometry wound the wrong way, so all 55 were backface-culled — proven by A/B, where "lights on" and "no lights at all" rendered bit-identically.
- **A latent re-entrancy that only a later feature could reach.** An explosive boon damaged an enemy from inside that enemy's own hit event, corrupting the pool and stranding rounds forever. Unreachable — and therefore invisible — until the boon existed.

---

## Design

Round-based survival with a roguelite twist. Points on hit, kill and crit-kill; a combo meter that rewards aggression; and at the end of every round a draw of **three boons from a pool of 26**, stacking multiplicatively into builds that go off the rails on purpose.

Movement is the skill ceiling: sprint, slide, **slide-cancel**, source-style air-strafe, dolphin dive, mantle. Gunplay uses deterministic recoil patterns — learnable, not random — plus an active-reload timing window.

Full design in [`docs/GAME_BIBLE.md`](docs/GAME_BIBLE.md), art rules in [`docs/ART_DIRECTION.md`](docs/ART_DIRECTION.md), and the milestone-by-milestone log with real playtest feedback in [`docs/PLAYTEST.md`](docs/PLAYTEST.md).

---

## Architecture

```
src/
  core/      loop, time, input, rng, pool, math, events   ← types.ts + events.ts are frozen contracts
  art/       PROCEDURAL ASSET FACTORY — nothing here loads a file
  render/    renderer, 9-pass comic pipeline, InkMaterial
  world/     arena, collision, navigation graph, lighting
  game/      motion, player, weapons, enemies, rounds, boons
  ui/        HUD, boon cards, boot, nav debug draw
  audio/     WebAudio graph + synthesis recipes
```

Two rules keep it coherent under parallel agents:

1. **`core/types.ts` and `core/events.ts` are the integration seam.** Systems depend on interfaces and talk through a typed event bus. A game system never imports another game system's implementation.
2. **One owner per file.** Agents get disjoint ownership, so parallel work can't collide.

Fixed-timestep simulation with interpolated rendering. Everything spawned per-frame is pooled. Zero allocation in hot loops.

Details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Performance

Budgets are enforced and measured, not hoped for.

| | Budget | Measured |
|---|---|---|
| Draw calls (25 zombies) | ≤ 350 | ~192–250 |
| Triangles (25 zombies) | ≤ 900k | ~434–486k |
| Simulation per fixed step | ≤ 3 ms | ~0.4 ms |
| Heap growth during play | ~0 | 8.2 bytes/frame |
| Frame-to-frame pixel change, camera parked | < 0.5% | 0.065% |

---

## Commands

```bash
npm run dev      # dev server — the game at /, the gallery at /gallery.html
npm run build    # production build
npm run check    # typecheck
```

---

<div align="center">

**Every pixel and every sound in this repository was generated by code that Claude Code wrote.**

</div>

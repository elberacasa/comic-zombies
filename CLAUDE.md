# COMIC ZOMBIES — Project Constitution

> **READ THIS FIRST, EVERY SESSION.** This file is the permanent memory of the project.
> If context was compacted, everything you need to not lose the plot is here and in `docs/`.
>
> **→ Then read `docs/CONTINUE_HERE.md`** — where the project stands right now and the exact next
> task. It is the only doc that is allowed to go stale, and it is rewritten each session.

---

## 1. THE GOAL (never negotiate this away)

Build an **AAA+ browser game**: a Call-of-Duty-style **Zombies mode** with a **comic book / graphic novel** art direction, running in WebGL via Three.js at 60fps.

Three pillars, in priority order:

1. **IT MUST FEEL INCREDIBLE.** High skill ceiling, deep movement + gunplay mechanics. Every shot, step and kill is juicy. The user is the human playtester — mechanics can only be validated by *feel*, so we ship playable builds constantly and iterate on their feedback.
2. **IT MUST LOOK LIKE A AAA TITLE.** The bar is Call of Duty / Battlefield production value — not in polygon count, but in *perceived craft*: lighting, composition, post-processing, animation, VFX density, UI polish, audio. Nothing ever looks like a programmer prototype. If a screen looks plain, it is a bug.
3. **IT MUST BE ADDICTIVE.** Round-based escalation, points economy, boons/perks, wall-buys, mystery box, risk/reward loops. "One more round."

### Non-negotiable constraints

- **100% IN-HOUSE ASSETS.** Zero downloaded models, textures, sounds, or fonts-as-assets. Every mesh is generated from code or authored as procedural geometry. Every texture is drawn to a canvas/shader at runtime. Every sound is synthesized with WebAudio. This is *why* we chose comic style — bold, flat, ink-outlined art is achievable in-house at a level that reads as premium.
- **COMIC STYLE IS LAW.** See `docs/ART_DIRECTION.md`. Cel-banded lighting, heavy ink outlines, halftone dots, screen-tone shadows, saturated limited palette, onomatopoeia pop-ups ("BLAM!", "SPLAT!"), speed lines, panel-style UI. Never drift toward realism, never drift toward "low-poly pastel indie".
- **60 FPS at 1080p** on a mid-range laptop GPU. Performance is a feature.
- **BROWSER ONLY.** No install, no download step, loads in seconds.

---

## 2. HOW WE WORK (studio process)

We ship in **milestones**, ordered the way a real studio orders them — see `docs/ROADMAP.md`. The rule:

> **Every milestone ends in a build the user can play in the browser and give feel-feedback on.**

- Vertical slice before breadth. One great gun before ten guns. One great arena before five.
- After each milestone: user plays → gives feedback → we tune. Feel-tuning beats new features.
- All tunable feel values live in `src/game/tuning.ts` so we can iterate fast without hunting code.

### Review: machines check facts, the HUMAN judges feel

**Do not spend agent tokens on visual or feel judgement.** Screenshot-and-squint reviews, pixel
histograms of "does this look good", subjective art critique — these are slow, expensive, and the
human does them better and faster for free. They said so directly, and they are right.

The split:

| Agents verify (cheap, objective, automatable) | The human judges (fast, free, better) |
|---|---|
| `tsc` / build clean · console clean | Does it look good? |
| Draw calls, triangles, frame time | Does it feel good? |
| Allocation / heap growth, leaks | Is it fun? Is it readable? |
| Determinism, unit-testable logic | Is the difficulty right? |
| Stuck-detection, reachability, pathing harnesses | Is the audio satisfying? |
| Contract/architecture violations | Is anything ugly or annoying? |

**Every milestone ends by writing `docs/HUMAN_JUDGE.md`** — a short, ordered checklist of exactly
what to test, with the specific key presses or console commands to get there fast, and a blank
line under each for the answer. Keep it *short*: 8–15 items, each testable in under a minute.
No essays, no numbers the human can't feel. Their answers then drive the next milestone.

Automated review still exists — but only for the objective column, and only where a machine
genuinely catches things a human cannot (allocation in hot loops, re-entrancy, contract drift).

### Subagent rules
- **Never more than 4 subagents in parallel.** Ever. Some work is better done sequentially.
- Parallel agents must own **disjoint files**. Ownership is assigned in `docs/ARCHITECTURE.md`.
- Agents integrate through the **typed contracts** in `src/core/types.ts` and the **typed event bus** in `src/core/events.ts`. Do not invent new cross-module coupling; add an event instead.

### Code standards
- TypeScript strict. No `any` in module boundaries.
- Systems implement the `System` interface and are registered in `src/main.ts`.
- Fixed-timestep simulation (`FIXED_DT`), interpolated rendering. Never tie gameplay to frame rate.
- Object pooling for anything spawned per-frame (bullets, particles, decals, popups).
- No allocations in hot loops — reuse scratch vectors.
- `npm run check` (tsc) must pass before any milestone is declared done.

---

## 3. COMMANDS

```bash
npm run dev      # vite dev server — THIS is how the user playtests
npm run build    # production build
npm run check    # typecheck, must be clean
```

---

## 4. THE MAP OF THE PROJECT

| Doc | What it holds |
|---|---|
| `docs/GAME_BIBLE.md` | The design: loop, mechanics, movement, weapons, boons, economy, enemies |
| `docs/ART_DIRECTION.md` | The look: palette, shading model, outlines, halftone, VFX, UI language |
| `docs/ARCHITECTURE.md` | The code: module layout, file ownership, contracts, system order |
| `docs/ROADMAP.md` | The plan: milestones, what "done" means, current status |
| `docs/PLAYTEST.md` | The log: each build, what to test, user feedback, what we changed |

**Current status lives at the top of `docs/ROADMAP.md`.** Check it to know where we are.

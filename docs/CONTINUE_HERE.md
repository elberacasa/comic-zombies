# CONTINUE HERE

**Read `CLAUDE.md` first, then this.** This file is the "you are here" pointer — it is rewritten
at the end of every working session and is the only doc that goes stale on purpose.

Last updated: 2026-08-10, end of the M6 session.

---

## Where it lives

| | |
|---|---|
| Repo | https://github.com/elberacasa/comic-zombies (public) |
| Play | https://comic-zombies.vercel.app/play |
| Gallery / landing | https://comic-zombies.vercel.app |
| Deploy | `vercel deploy --prod --yes` from the repo root. GitHub is *not* auto-deploying. |

`npm run dev` → game at `/`, asset gallery at `/gallery.html`. On the deployed site those are
swapped by `scripts/postbuild.mjs` (`/` is the gallery, `/play` is the game).

**Test locally, not on Vercel** — the production build does not expose `window.CZ`, and every
useful debug command hangs off it.

---

## THE ONE THING THAT MATTERS MOST

The player tested BUILD 007 and said: **"i wanna play more rounds the game feels legit
addictive."** That is the question M3 existed to ask, and it is answered.

**Stop redesigning the loop.** Rounds, points, combo, the boon draw and the round beat are doing
their job. Everything from here is *quality*, not structure. Their remaining asks, verbatim:

> "they can be a bit smarter" · "needs better enemies" · "graphics should improve" ·
> "enemies skeletons should be more consistent and precise" · "consistent high quality and great
> performance" · "aaa+ quality at the level of cod activision"

And the destination (`GAME_BIBLE §8.5`): **comic COD — MW2 feel, BO2 Zombies structure**, heading
toward leaderboards, co-op, then PvP. "Competitive" is load-bearing: it makes *consistency* a hard
requirement, which is why a hitching frame rate or an unstable image is a bug, not a polish item.

---

## NEXT TWO TASKS, in order

### 1. Wire specials into the round mix  ← START HERE
The Screamer is fully implemented and verified but **the round director never spawns it.** It only
appears via `CZ.spawn(1,'screamer')`. Look at the composition/tier table in
`src/game/rounds/director.ts` and introduce specials at set rounds the way BO2 does — a first
screamer around round 5–8, then a rising share, capped so a round never becomes all specials.
`GAME_BIBLE §6` says "composition shifts (specials introduced at set rounds)".

### 2. Better bodies — "not blobs, bodies with their movement"
The mesh is more complete than it looks: skull, brow, jaw, hands, feet and a torn coat all exist,
and `tools/zombie.mjs` passes on every bone. The last session found that the *shading* was hiding
it (see `ART §9.1`) and fixed the rim. What is still missing is **anatomical read and motion
quality**:
- limbs taper but have no elbow/knee landmark; hands and feet are small and read as stumps
- one flat hue over the whole body — no clothing-vs-flesh split, no wounds
- the gait is a walk cycle; COD zombies *lurch* — weight shifts, drags, a shoulder leading
- per-instance variation exists in the data but barely changes the silhouette at 10 m

Files: `src/game/enemies/body.ts` (regions, surfaces), `rig.ts`, `defs.ts` (`SURFACE`, `VARIANTS`,
`ANIM`). Keep the hold-frame timing (~4.4 frames/pose, `ART §8`) — smooth deformation, jerky
timing, that pairing is the style.

---

## Known-open, deliberately

- **Points is a dead stat.** ~4,400 earned in round 1 and nothing to spend it on until wall-buys,
  the mystery box and Pack-a-Punch exist. Biggest structural hole in the loop; deferred because
  the player asked for enemies and graphics first, and their feedback outranks the roadmap.
- **`node tools/combat.mjs` has 1 failing check** — the conga follow adds 12–18% queue length
  against a 20% bar it set for itself. Investigated at length: the harness was order-dependent
  (fixed), two steering fixes were tried and both made it worse (reverted), and the player then
  said "i like how zombies behave". **Treat the bar as mis-specified, not the mechanic.** Full
  write-up at the top of `PLAYTEST.md`.
- **The east gantry is still a camp spot.** Level geometry, not AI — every route onto it is
  81–120 m for a 13–22 m crow flight with no climb link at any cost. Needs an intermediate tier
  in `world/arena.ts`.
- `sprinter`, `brute`, `spitter` still share the melee role. Only the Screamer has its own
  behaviour. Spitter needs a projectile; Brute needs shootable armour plates.

## Conventions you must not rediscover the hard way

- **Machines check facts; the human judges taste.** Never spend tokens on "does this look good" —
  write `docs/HUMAN_JUDGE.md` (10–15 items, each under a minute) and let them answer.
- **Run the harnesses before declaring movement or combat work done.** They exist because these
  bugs shipped twice from browser-only testing:
  `node tools/stairs.mjs` · `node tools/zombie.mjs` · `node tools/combat.mjs`
- **Browser testing:** pointer lock is blocked under automation and rAF is throttled in a
  background tab. Use `CZ.loop.stop()` + `CZ.loop.stepOnce()` with a **synchronous busy-wait**
  between steps, and set **`CZ.time.paused = false` before every step** or nothing simulates.
- **Bodies walk.** If you place enemies for a measurement and then step 40 frames, they will not
  be where you put them — and the plaza monument sits directly ahead of spawn, so test bodies
  placed at 20 m+ end up *inside it* and the squint metric reads zero. That cost real time.
- Determinism is now a product requirement, not a testing convenience (`GAME_BIBLE §9.3`) —
  leaderboards and future netcode both depend on it. No `Math.random()` or wall-clock in sim.

## Useful console handles

```js
CZ.skipToRound(10)      CZ.spawnStreet(20)     CZ.spawn(1,'screamer')
CZ.camp('roof_ne')      CZ.setEscalation(20)   CZ.killAll()
CZ.renderer.renderScale        // dynamic resolution, 0.55–1.0
CZ.renderer.autoQuality=false  // pin it before measuring anything
CZ.stats()                     // true whole-frame draw calls / triangles
```

# CONTINUE HERE

**Read `CLAUDE.md` first, then this.** This file is the "you are here" pointer — it is rewritten
at the end of every working session and is the only doc that goes stale on purpose.

Last updated: 2026-08-10, end of the BUILD 008 session (specials + bodies).

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

## WHAT BUILD 008 DID (both tasks above are DONE — awaiting the human's verdict)

**`docs/HUMAN_JUDGE.md` is written and unanswered. Get those 11 answers before building more.**

### 1. Specials are in the round mix ✅
`ROUND.specialsEnabled` is on, intro rounds are `sprinter 4 · brute 7 · screamer 8`. Enabling the
flag was not enough on its own: the share ramp is `(n - intro + 1) × 1.2%`, so on a special's own
intro round it had a **1.2% chance per spawn** — i.e. it would show up several rounds late or
never. `director.ts::planDebuts()` now pins one guaranteed spawn of each debuting kind at wave
index `floor(toSpawn × 0.34)`, so a debut is a beat, and the ramp carries the share up from there.
Verified in-browser: round 8 order was `shambler, sprinter, shambler ×6, SCREAMER, brute, …`.

Spitter is parked at round 9999 on purpose — no projectile yet, and a spitter that does not spit
is a pink shambler, which breaks the `ART §9` read.

### 2. Bodies got joints, extremities and a lurch ✅
Every limb ring used to fall monotonically (arm 0.124 → 0.084, leg 0.150 → 0.088). **A monotonic
taper is the blob** — nothing tells you where the limb bends. The joints were never guesses: from
`SKEL`, elbow is y 1.047, wrist 0.727, knee 0.395, ankle 0.010, and the rings already sampled
exactly those heights and did nothing there. Now: deltoid → taper → **elbow knob (+z)** → forearm
belly → **wrist pinch**; and hip → thigh belly → **patella (−z)** → **calf belly (+z)** → **ankle
pinch**. Hands are 29% wider, flatter (u 0.152 vs v 0.112) and 63 mm longer; feet 15% wider and
23% longer; `BONE_TAIL` for hand/foot was extended to match, or the hitbox capsule would end
short of the new fingers and toes.

**Why it was a tube in the first place:** `BODY.minHalfWidth` = 0.070 is asserted at boot
(`body.ts::assertInkFloor`) because anything thinner renders as solid ink under the 8 px outline.
Staying clear of that floor is easiest if you never sculpt. But the floor only forbids going
*thinner* — the landmarks are made by ADDING mass at the joints, which costs the floor nothing.
Wrist and ankle sit at 0.072, 2 mm clear; boot assertion passes.

The lurch (`body.ts::poseGait`): `OX` had existed on every bone since the rig was written and
**nothing had ever used it**. Weight transfer is a translation, not a rotation — the pelvis now
shifts onto the planted foot (`ANIM.weightShift`), drops harder when it lands on the drag leg
(`lurchDrop`), and one shoulder is carried ahead, keyed to `dragSide` so the injury reads as one
coherent thing instead of two random offsets (`shoulderLead`).

Budget after: **194 draw calls, 459k triangles at 25 alive** — unchanged, because no ring
*counts* changed. Hit registration unchanged (limb miss ≤0.9% at 5/15/30 m).

---

## BUILD 009 — the playtester's next round of notes

Their verdict on 008: **"FEELS BETTER"**, with one blocker and a big content ask.

### The blocker: "graphics are going low and they look bad suddenly swapping quality" ✅
Second report of this. The first was the governor *hunting* (fixed in 008 — a spike resets the
counter). This one was different: the logic was correct and you could still SEE it work. Three
policy faults in `render/renderer.ts`, all now fixed:

- `STEP` was **0.1** — a 10% resolution change lands in one frame and the whole image softens at
  once. Now **0.04**, below the threshold where one step is perceptible.
- `MIN` was **0.55** — thirty percent of the pixels. That is not a soft image, it is a bad one.
  Now **0.74**.
- It **dropped the feature tier** once resolution bottomed out, switching bloom and grain OFF
  mid-fight. That does not soften the image, it *changes* it, with the player doing nothing —
  the exact case `GAME_BIBLE §8.5` calls a bug. **Removed entirely.** Tier is chosen once at boot
  or by the player.

Small steps only converge if there are enough of them, so the first drop still costs 3 s of
sustained slowness and the dial then steps every 0.6 s instead of re-arming the full hold.

### Three new weapons ✅ (data only — NOT obtainable yet)
`ratatat` (SMG), `boomstick` (shotgun), `longshot` (marksman) are in `WEAPON_DEFS` and fully
functional: `service.ts:498` loops `def.pellets`, `firing.ts:180` honours `def.penetration`. Every
recoil pattern's yaw column sums to **exactly 0** (the file's own rule — a net lateral bias walks
the player's aim sideways with no input). Verified in-browser: all three equip with correct ammo.

**`thumper` is deliberately absent.** The archetype note in `defs.ts` claimed `firing.ts`
"dispatches on `def.archetype`" and that the launcher branch "is already there" — **both are
false**, `archetype` is not read anywhere in the firing path. The other four shipped anyway
because they are hitscan. The note is corrected in place.

Reach them with **`CZ.give('ratatat')`**.

### THE NEXT CHUNK, and it is one chunk not two
**Wall-buys + the spend UI.** These are the same job: in Zombies a wall-buy *is* how you get a
gun, and it is also the only thing that makes points mean anything. Right now `PlayerService` has
`addPoints()` and `points` but **no `spend()`** — that is the first thing to add. Then buy zones
in the arena, a prompt, and the purchase UI. After that: mystery box, Pack-a-Punch, perks.

Then: **production menus** — main menu, pause, settings with mouse sensitivity, graphics and
audio. Their words: *"great menus now targeting production and not debugging, with sensibility
and all the pro features"*. Everything is F-keys and console handles today.

**Known gap:** all four weapons share ONE hardcoded viewmodel (`buildGunGeometry()`, built once
and cached). An SMG that looks like a pistol is a `CLAUDE.md` §1 violation ("if a screen looks
plain, it is a bug"). Needs a per-archetype silhouette profile — barrel length, stock, foregrip,
scope, wide receiver — not four hand-authored models.

---

### Older: next, once the 008 judge sheet comes back
Still open from the human's own list, in their words: *"they can be a bit smarter"* (awareness,
flanking — the AI is still one `melee` role for everything except the Screamer), and the
clothing-vs-flesh split / wounds, which is the one part of "better bodies" NOT done — the body is
still one flat hue. That is a `SURFACE`/material job, not a geometry one.

---

## Known-open, deliberately

- **Points is a dead stat.** ~4,400 earned in round 1 and nothing to spend it on until wall-buys,
  the mystery box and Pack-a-Punch exist. Biggest structural hole in the loop; deferred because
  the player asked for enemies and graphics first, and their feedback outranks the roadmap.
- **`node tools/stairs.mjs` has 3 failing checks** — bodies ending up inside geometry, and
  chase stalls up to ~23 s, in both the spawn and the roof-camp scenarios. Long-standing and
  byte-identical before/after BUILD 008 (checked by stashing the diff). This is the measurable
  half of the human's *"they can be a bit smarter"* and the best-evidenced next engineering task.
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

---

## BUILD 009 — per-weapon models, and the REAL quality bug

### The quality governor was mathematically incapable of being satisfied ✅
`TARGET_MS` was **13.5 ms** and `RELAX_MS` **10.5 ms**. A vsynced 60 Hz frame is **16.67 ms**.
So `ms > TARGET_MS` was permanently true and recovery needed 95 fps. The console said it outright:
`[render] 60 fps sustained — render scale 1.00 → 0.90 … → 0.55`, then tier drops. Every session
degraded to minimum after ~40 s **on every machine**. Now 19.5 / 17.2 ms (~51 / ~58 fps), both
reachable at a locked 60. Also: step 0.1 → 0.04, MIN 0.55 → 0.74, and no automatic tier drops.

### Four weapons, four models ✅
`GunProfile` drives one builder; each gun carries its own receiver, barrel, muzzle, fore-end,
stock, magazine and — critically — its **own sight, so the ADS socket is re-solved per weapon**.
Shared sockets would have put the sight off the bullet on three of four guns. All four models are
built at boot into hidden Groups (`ARCHITECTURE §4`); `equip(defId)` toggles visibility and
rebinds the solve. Materials are shared.

**The binding constraint is REACH, not taste.** `hypot(|x| + sway, z)` ≤ 0.40, and the pistol was
already at 0.386. First pass measured ratatat 0.403, boomstick 0.418, longshot 0.426 — the last
past `MOVE.radius` (0.42), i.e. it would have punched through walls. Length is therefore bought
with per-profile `depthCompress` (comic foreshortening) plus shorter forward parts.

**And the reload pose is MAGAZINE-driven, not depth-driven.** ratatat's reload sat at exactly
0.402 through three separate compression changes while every other pose fell — the SMG's 0.128 m
stick mag swings out on the reload arc. Shrinking the mag fixed it; compressing never would have.
Final: all four ≤0.393 reach, ≤0.418 swayed, ≥0.072 near.

### NEXT
Wall-buys + spend UI (still no `spend()` on `PlayerService`), then production menus with
sensitivity/graphics/audio. `thumper` still needs projectile code.

# PLAYTEST LOG — Comic Zombies

Every build the human plays gets an entry here: how to run it, what to look at, what we need
answered, and what they said. **Feedback in this file outranks the roadmap.** Newest build first.

---

# THE CONGA INVESTIGATION — the test was wrong before the game was

I reported that the train mechanic was weak, based on `combat.mjs` showing the follow term adding
only 12% to the unbroken queue against a 20% bar, with round 10 actively regressing. **That
finding was partly an artifact of the harness, and chasing it cost two failed fixes.**

**What was actually wrong.** The conga suite is order-dependent. Run alone it reported every round
improving by 18%; run after the other suites it reported round 10 *regressing* and 12% overall —
same code, same seed, opposite conclusions. `reseedHorde()` restored the RNG stream and the
variant cursor, but not the object pool's **free-list order**, which `despawnAll()` leaves
permuted according to the order bodies died. `spawn()` then popped different bodies for the same
spawn index, each carrying whatever its previous life left on it. The A/B stayed honest — both
columns saw the same permutation — but the absolute numbers moved with run order, and the
"round 10 regresses" signal that sent me hunting was noise dressed as data.

Restoring the free list to the pool's own order fixes the every-round check in both run orders.
Some order-dependence remains (absolute numbers still shift), so **the conga suite is trustworthy
for direction, not for absolute values.** Treat a single failing percentage there as a prompt to
look, not as a verdict.

**Two fixes attempted on the steering itself, both reverted, both measured:**
- *Offset pursuit* — aim at the slot behind a leader rather than at the leader, since pure
  pursuit cuts corners on a curve. Geometrically sound, and it made every shape metric worse
  (L/W 4.0 → 3.6, width 3.04 → 3.69). Reverted.
- *Pace matching* — cap a station-keeping follower to its leader's speed, since mixed speed tiers
  from round 10 tear a queue apart. Made it worse still, and contaminated the control run (the
  control only zeroes the follow *weight*, so the cap still applied). Reverted.

**Where it actually stands:** the follow term consistently improves the queue by 12–18% depending
on harness state, and the shipped steering beat both of my attempts to improve it. The 20% bar was
written by the agent that built the feature, asserting its own design goal.

**So this is now a question for the human, not the harness** — which is the convention anyway.
It is item 1 in `HUMAN_JUDGE.md`: can you train a horde into a line and sweep it in one pass? If
that feels good in play, the bar is mis-specified and should be lowered to what the mechanic
actually achieves. If it feels bad, that answer gives a real target to tune against.

---

# BUILD 007 — THE HORDE HAS A BODY

**Date:** 2026-08-10 · **Milestone:** M4 · Five parallel passes (stairs, rig, combat, visual
consistency, visual escalation) reconciled into one build.

## → PLAY THIS BUILD AGAINST [`docs/HUMAN_JUDGE.md`](HUMAN_JUDGE.md)

**14 items, each under a minute, in order.** That file is the deliverable for this build — it
replaces the expensive AI look-and-feel review with the one reviewer who is actually good at it.
Everything objective has already been measured and is listed at the bottom of it so you don't
re-check it.

## What this build answers, from your own words

| you said | what happened |
|---|---|
| "**after the gravity changes i cant go upstairs**" | **Fixed.** Three independent causes, all measured, none of them the one guessed first. All 9 flights climb, verified headless *and* in the real browser with real key presses. |
| "zombies… get stuck everywhere, slow, and aren't truly a threat" | Speed tiers (shambler → sprinter, mixed by round), CoD's real health curve, melee damage 28 → 70. Three on you drops you in 1.3 s. |
| "zombies don't have understandable hitboxes, headshots aren't that pleasant" | The whole body is skinned now. The head hitbox was **59% wider than the drawn skull**; it now matches the drawing, solved from the posed mesh rather than estimated. |
| "in cod u lined them and kept stacking headshots by making trains" | Conga steering: a body steers partly at its leader, so the pack forms a queue you can sweep instead of a crescent that wraps you. |
| "as close as cod logic as possible" | Health curve is CoD WaW/BO1 exactly. Points already were. |
| "lets continue for aaa+ graphics… so people dont get bored quick" | The night now escalates with the round — sky, fog, guttering street lamps, grade, soot. `CZ.setEscalation(20)` shows round 20's look instantly. Rooftops and catwalks got a dedicated readability pass. |

## The one decision waiting on you

Enemy health follows CoD's curve exactly, which means it never stops growing — **26 headshots at
round 20** with the starting gun. Pack-a-Punch exists in code but nothing sells it yet. The last
section of `HUMAN_JUDGE.md` lays out three options; pick one.

## Bugs fixed during integration (found by measurement, not by looking)

- **The stairs fix had been lost entirely.** A mid-workflow rollback reverted every pre-existing
  file; four separate agents reported the regression and none of them owned the files. Re-applied
  and re-verified from scratch.
- **The conga steering broke every staircase for the horde** — bodies queued behind a leader
  halfway up a flight, which overrode the wall-avoiding steering that keeps them on the ramp, and
  the whole pack wedged at the bottom. 1 of 15 reached the roof; now 11. Fixed with a height gate.
- `CZ.setEscalation` was being attached by a `setTimeout` from a file that didn't own
  `window.CZ`; it is a real, typed entry on the console handle now.
- The boot banner still said BUILD 005.

## Known-imperfect, tracked, and not worth your time to confirm

- A few bodies out of 25 can wedge briefly against thin roof railings in long sessions. Collision
  solver limitation with thin slabs, not a movement bug.
- The horde is slower up the **east stair specifically** than it should be — 11 of 15 arrive.
- Cresting a ramp still gives a small hop. It may read as fine; item 2 asks you.

## FEEDBACK — BUILD 007

<!-- your answers from HUMAN_JUDGE.md land here -->

---

# BUILD 006 — M3.5 hardening pass

**Date:** 2026-08-10 · **Milestone:** M3.5 (fix pass on BUILD 005) · No new features. One blocker
and seven majors found by review, applied and re-measured.

## The one that mattered: a round that could not end

A zombie that walked **under** a player standing on a roof was frozen solid, permanently. The
contact standoff — the rule that stops a torso entering the camera's near plane — was measuring
only HORIZONTAL distance, so a body 0.4 m away in plan and six metres below read as "crowding you"
and had its speed clamped to zero. It could not swing (too far below), could not be shot (no line
of sight down through the deck), and was invisible to the whole unstick escalator, which only arms
on a body asking for real speed. Camping the west catwalk froze **4 of 25** bodies within 30 s, and
since a round only ends at zero alive, that is a round you cannot finish.

Now the standoff only applies when you are actually in the same fight (within
`ENEMY.verticalMeleeGate`, the same 1.7 m gate that decides whether a swing can land). Measured on
the NE roof, one shambler placed at 0.40 / 1.10 / 1.14 m in plan and 5.96 m below: **0.000 m
travelled before, 10.6 / 9.8 / 9.4 m in six seconds now.** There is also a `frozen` readout on the
debug panel (backtick) that counts this exact shape of failure. It must read 0.

## Camping — the table, re-measured with a spawner that does not cheat

BUILD 005's camping numbers were taken with `CZ.spawnNear`, which probes for ground from your own
eye height — so from a 7.55 m roof it found **the roof**, and 7 of 15 "incoming" zombies spawned on
the deck beside you. There is now `CZ.spawnStreet(n)`, which probes from a fixed street height and
rejects anything not below your feet. Every number here is from it.

| you camp on | height | first one reaches you | outcome |
|---|---|---|---|
| the monument / fountain rim | 0.90 m | **9.1 s** | all 15 on the rim |
| the bus roof | 3.40 m | **8.1 s** | all 15 up |
| the SW container stack | 5.20 m | **14.0 s** | 9 on the stack, 363 swings landed |
| the west catwalk | 13.60 m | **17.8 s** | 8 up four storeys |
| **the loading-dock canopy** | 5.95 m | **17.5 s** | **was NEVER — 0 arrivals in 150 s** |
| the NE market roof | 7.55 m | **29.3 s** | all 15 up on the deck |
| the east gantry | 6.80 m | 66 s | 10 of 15 — **still the weak spot, see below** |

The dock canopy was the last hole in the level: the climb from the dock platform to the canopy
tier is 3.37 m and the limit was 2.90 m, so a full sweep of the graph found 127 unreachable nodes
with 47 standable surfaces among them. The limit is 3.45 m now and the canopy is a fight.
`CZ.camp()` also tells you whether the horde can reach where it just put you — if it says
**⚠ UNREACHABLE**, that is not a camping test, that is a bug report.

**The east gantry is honestly still a camp, and it is a level problem, not an AI one.** Traced with
`CZ.navRoute` from four street points around it: every route costs 81–120 m of walking for a crow
distance of 13–22 m, and **not one of them contains a single climb** — at the old limit and at a
deliberately silly one. There is no chain of ledges onto that deck at any climbable height; the
arena gives the gantry spine exactly one entrance and it is a long way round. Making climbing
cheaper was tried: it shaved the gantry to 65 s and **broke the loading dock**, so it was reverted.
The gantry needs geometry — an intermediate tier, a second flight, or a ladder.

## You can shoot them off a ledge now. You genuinely could not before.

The mantle is sold as the moment you punish them, and it was the one moment you could not: a
climbing body skipped the knockback branch entirely, so `push` was neither applied nor decayed.
Five crit hits on a mid-mantle zombie produced a stored impulse of 7.0 and moved it **0.000 m** —
and then dumped the whole thing on it two seconds later when it planted, shoving it off the
container long after the shots that did it. Now the climb carries and decays knockback like every
other state, and enough of it (`NAV.climbBreakImpulse`) tears the body off the wall into a stumble.
Measured: three body shots during a mantle → impulse 3.57 → out of `climb`, 0.70 m of travel,
back on the ground. One headshot does it on its own.

## The gun in a crowd

The half of your fourth note that was not fixed. The sidechain only ducked the ambient bed, and the
horde is not the bed — it is twenty-five spatial voices. Measured on the master bus with 25 of them
on you: the **limiter was already pulling 8.7 dB before a shot was fired**, and muting the horde's
voices alone took that to 1.6 dB. Twenty-five bodies each groaning at the level that is right for
one is a sum nobody authored, and no sidechain rescues a bus that is nine decibels into a limiter.

Two changes: the horde's own voices (groan, windup, swing, spawn — never the sounds *you* make to
them) now run on their own bus that the shot ducks, and that bus divides itself by its own live
voice count. Limiter reduction in a 25-body scrum **8.74 → 3.24 dB**. With 25 alive at 7–11 m — the
review's exact test — a shot now lifts the mix **+6.3 dB (2.9–8.4)** against a published **+2.0**,
and its spectral centre reaches **1518–2053 Hz** against **1041**. Being surrounded is still
unmistakable: **20.9 dB** between an empty street and 25 on you.

**In a full melee scrum the shot is still only ~1 dB over the noise** — but that noise is
twenty-five swings and your own body being hit, and it is not obvious that should be quiet.
Judge it: if getting mauled *should* drown the pistol, this is right. If not, say so.

## Also fixed, quietly

- **`CZ.navRoute` used to corrupt live routing.** The console probe the last doc told you to use
  committed its throwaway sweep to the real flow field and re-pointed the whole horde at whatever
  you asked about. It now runs on its own arrays: goal unchanged, version bumps 0, verified over
  ten calls fired mid-sweep.
- **The viewmodel clearance assertion could not see three of its own layers.** It reported all-clear
  at boot while the true transform crossed the near-plane budget in ordinary play (fire while
  landing with the view swinging: 0.0557 m against a 0.070 budget, and −0.0074 m at the extreme —
  vertices behind the camera). It now composes the rotational sway, the walk-bob roll and the
  active-reload snap on top of every pose. Fixing what it found moved the gun 17 mm further from
  your face at the hip, trimmed the sway rotation and the reload push, and held the sprint pose
  exactly where BUILD 005 put it. Every pose now clears: worst near-plane **0.072 m**, worst reach
  **0.393 m** (0.413 under a full sway flick, against `MOVE.radius` 0.42).
- **Voice stealing was a hard cut, not a crossfade** — the audio engine detached a stolen voice's
  sources immediately and left the 5 ms fade nothing to fade. The detach is deferred now.
- **A mantle can no longer end inside you.** Neither climb path checked the player.

## The two-line camping test, corrected

```js
CZ.camp('roof_ne')      // says where it put you AND whether the horde can get there
CZ.spawnStreet(15)      // 15 on the street below you — not on the roof with you
```

`CZ.campSpots` lists them. `CZ.navRoute(a, b)` is safe to call now. `F8` still shows you the routes.

---

# BUILD 005 — M3.5 They Climb

**Date:** 2026-08-10 · **Milestone:** M3.5 · **Judge:** **"nowhere is safe, and every shot sounds
like it hit something."**

This is your BUILD 004 feedback and nothing else. Four notes, four fixes, no new features — the
whole milestone is the list below.

## What you said → what happened

> **1. "we could make better zombies, like they dont go up stairs or things so u can just camp
> top of a building or fountain"**

They climb now. There is a real **navigation graph** under the arena — 6 858 nodes, 47 237 links,
1 627 of them climb links and 2 220 drops, built once at boot from 100 800 raycasts against the
level's own collision. On top of it runs a flow field from your feet outward, so no zombie ever
searches: it reads one number and walks.

The three things that actually killed camping, in order of how much they mattered:

- **A step offset.** A body's collision capsule is now lifted 0.45 m, so kerbs, the monument's
  dais steps and the loading-dock lip stop shoving it back out. This alone killed the fountain.
- **Ramps are not walls.** The steering whiskers were treating the stringer of a staircase as an
  obstacle to dodge. Bodies were climbing 1.7 m of the NE flight and then swerving off the side
  of it — measured, every time. A surface you can stand on is no longer something to avoid.
- **A first-class climb.** 0.80 s plus 0.55 s per metre, reach → hold → haul → plant. Two ways in:
  the graph says "climb here", or a body that has got itself wedged probes straight ahead for a
  ledge and mantles it before it tries walking around.

**Measured, 15 shamblers spawned at street level in a 17–27 m ring, you parked and not shooting:**

| you camp on | height | first one reaches you | outcome |
|---|---|---|---|
| the monument / fountain rim | 0.90 m | **9.3 s** | 12 of 15 in melee by 25 s |
| the NE market roof | 6.80 m | **19.8 s** | 13 of 15 in melee by 64 s, **all 15 up on the deck** |
| the dock platform ledge | 1.20 m | 10.5 s | mantled, 5 climb events |
| the SW container stack | 5.20 m | 15.6 s | 17 climb events to get up there |
| the west catwalk | 13.60 m | 27.6 s | reached; it is four storeys, it takes a while |
| the skybridge / east gantry | 6.80 m | 34–46 s | reached |

Every vantage point in the level is now reachable. The high ones buy you **time**, not safety —
which is what they should have been buying all along.

> **2. "when running the pistol moves to the inside, i believe it should move to a better position
> since it doesnt look natural there"**

It literally was moving inside. The sprint pose swung the muzzle **across your chest** (+26° of
yaw takes the barrel to −x, toward the middle of the screen). It now goes **down and outboard** —
the muzzle moved 52 px further out and 135 px further down, and the pose angle went from 2.5°/14°
to a clean 28° down / 28° right. Coming back up is **90 % done in 150 ms**.

> **3. "when aiming down sights the aim doesnt go where it should and u aim like inside the pistol
> weird"**

The camera axis was running **through the slide** — the slide, its accents and the trim all
straddled y = 0 — and the sights sat above it. So you were looking through the gun, with the iron
sights parked in the upper half of the frame.

| | before | now |
|---|---|---|
| rear sight, pixels from screen centre | −56.2 | **0.00** |
| front sight, pixels from screen centre | −45.9 | **0.00** |
| front↔rear parallax | 10.4 px | **0.00 px** |
| where a bullet lands at 40 m vs the sight line | — | **within 1.5 px** |

Three more things were blocking the *picture* even once it lined up: the notch gap was exactly as
wide as the post (widened), the silhouette outline was eating the post (the sights are now their
own mesh with a thinner outline and their own material), and the **hammer spur** — the nearest
thing on the whole model, dead centre — was the orange mass filling the notch. It got shorter.

**And the crosshair now fades out as the sights come up** (down to 12 % opacity, back to full the
instant you let go). Once the irons genuinely line up, the crosshair is a second aiming reference
drawn on top of the first one. Tell us if you want it back.

> **4. "include better sounds also to make this super addictive"**

**65 recipes, 215 layers** — up from ~58 / ~160 — and, more importantly, a mix that reacts:

- **A kill ladder.** Every kill in a chain is pitched a step higher than the last, all eight
  degrees of it. Measured: from ×1 to ×2 the sub-bass moves 70 → 164 Hz and the brightness moves
  4 652 → 5 378 Hz, monotonically.
- **A reward hierarchy that is actually ordered:** crit kill > kill > crit hitmarker > hitmarker,
  by loudness, in that order, no exceptions.
- **A sidechain.** Every shot ducks the music bed by **52 %** and lets it back in — the gun
  punches a hole in the mix instead of fighting it.
- **A menace bed.** The ambient bed tracks how many of them are near you: an empty street to 25
  zombies is a **20.8 dB** swing. When you are alone it is wind and nothing else.
- **Real distance.** Sounds now lose their high end as they get further away — a glass impact at
  50 m keeps 12.5 % of its treble versus 78 % at 2 m — and the reverb send taps the filtered
  signal, so far things get wetter *and* darker instead of wetter and brighter.
- **New one-shots** for a crit kill, a chain climbing, a chain breaking, a boon card turning
  over, the round break, the drop-in and the back cover. 21 recipes have multiple takes and
  round-robin, so nothing machine-guns the same sample at you.

## How to run it

```bash
npm run dev
```

Open the URL it prints and click **CLICK TO DROP IN** — that click buys pointer lock, starts the
audio and starts round 1. Still zero downloads: every mesh, texture, sound and glyph is code.

Useful URL flags: `?debug=1` boots with the debug panel open · `?q=ultra` forces a quality tier ·
`?seed=0x1234` replays an exact run.

## Controls

Unchanged, plus one new key.

| | |
|---|---|
| **WASD** | move |
| **SHIFT** | sprint |
| **SPACE** | jump — **and "run it back" on the back cover** |
| **CTRL** — tap | slide. Tap again mid-slide to slide-cancel and keep your speed |
| **CTRL** — hold | dolphin dive (0.2 s hold); the landing roll gives i-frames |
| **LEFT MOUSE** | fire — **and pick a boon card** |
| **RIGHT MOUSE** | aim down sights |
| **R** | reload — **and then tap R again when the needle is in the GOLD zone** |
| **1 / 2 / 3** | **take the boon in that slot** |
| **P** or **ESC** | pause |

Debug: **N / M** spawn 1 / 10 · **K** kill everything · **Z / X / B** the enemy system's own keys ·
**`** debug overlay · **F8 → the nav graph** · **F1–F4** quality · **F5** A/B the ink ·
**F7** motion comfort.

**F8 is new.** It cycles *off → routes → field*, and it turns the debug overlay on with it. In
`routes` you see the exact path every living zombie is going to walk, hop by hop, colour-coded:
white for walking, **gold for a climb**, **rust for a drop off a ledge**. In `field` you also get
the raw lattice around you. Green cross = where the field is flowing to, i.e. you. If a zombie
ever takes a route that looks stupid, press F8 and you will see why.

From the console: `CZ.camp('roof_ne')` then `CZ.spawnNear(15)` is the whole camping test in two
lines. Also `CZ.campSpots` · `CZ.nav.stats` · `CZ.navRoute(a, b)` · `CZ.navDraw.mode = 'field'` ·
`CZ.sound('kill_crit')` · `CZ.sounds()` · `CZ.skipToRound(9)` · `CZ.die()` · `CZ.stats()`.

## What to judge — in this order

**1. Go and camp somewhere. On purpose.** Stand on the fountain rim. Then `CZ.camp('roof_ne')`,
or walk up the NE stair yourself, and hold it. **The question is not "can they reach me" — they
can, that is measured. The question is whether the fight up there is any GOOD.** A staircase
should be a chokepoint you can hold and eventually lose, not a wall and not a free kill lane.
If holding the roof is still trivially better than fighting in the street, say so.

**2. Watch one of them climb.** Get close to a 1.2 m dock lip or the container stack and watch a
single body do it. Does the mantle read as *effort* — reach, hang, haul — or does it look like
the zombie teleported up? It is a 1.0–2.2 s animation depending on the height; it is meant to be
the moment you can shoot them off.

**3. SPRINT, and look at the gun.** Hold shift, run 20 m, stop. Two things: is it out of the way
now instead of across your chest, and does it come back up *fast enough* to shoot on the way out
of a sprint? 150 ms to 90 %. If that still feels late, it is a number we can move.

**4. AIM. This is the one we most need an answer on.** Right-click and put the front post on a
zombie's head at 10, 25 and 40 m. **Does the bullet go where the post is?** And separately — is
the sight picture READABLE at night, or does the post disappear into the target? The post has
been given its own material specifically so it separates from its own slide; tell us if it still
merges into a dark background.

**5. SOUND. Play with the volume up.** Specifically:
- Chain four or five kills together. **Does the ladder read?** It should feel like the kills are
  climbing, not repeating.
- Does the gun still cut through when the horde is loud?
- Stand still with nothing near you, then let ten of them close in. The bed should tell you they
  are coming before you see them.
- Anything that is now *too much*? Over-mixed is as bad as thin.

**6. Round 5, 10, 15.** The climbing changes the difficulty curve and we have not retuned for it.
Did a round get harder than it used to be at the same number?

**7. The comfort check, as always.** Hold W and walk a long straight street. No drift, no roll.

## What was measured, not eyeballed

| | |
|---|---|
| `npx tsc --noEmit` / `npx vite build` | clean |
| Draw calls / triangles, **25 zombies alive** | **198 / 437 k** (budget 350 / 900 k) |
| Same, with the nav overlay drawing 1 900 debug segments | **200 / 437 k** — the whole overlay is one draw call |
| Stillness (ART §4.1), camera parked, empty street, 2400×1084 | **max 0.113 %** of pixels changed between frames (budget 0.5 %) |
| Stillness while **holding ADS** | **max 0.125 %** — the new crosshair fade settles, it does not idle |
| Straight line (ART §10), W only, on a corridor proven clear of geometry for 26 m | **0.000000 m** lateral drift over 14.6 m |
| Camera roll while walking straight | **max 0.30°** (budget: 4° summed) |
| Nav graph build | 6 858 nodes · 47 237 edges · 1 627 climbs · 2 220 drops · **181 ms at boot** |
| Nav cost per simulation step, 25 agents all routing | **≈ 5.7 µs** — 1.4 % of the 0.4 ms budget, and **zero** while everyone is on your level |
| Viewmodel at rest, 30 frames at both hip and ADS | frozen **30/30** |
| All 65 audio recipes rendered offline | **0 silent, 0 clipping**; the seven new ones peak 0.23–0.46 |
| Full loop, driven end to end | round 1 → cleared (perfect) → intermission → boon draw → pick → round 2 spawns, **no console errors** |

## Bugs found by integrating it, not by reading it

1. **The entire debug-draw buffer had never worked, in the project's whole life.** `debug.line()`
   stamped each segment against a *cached* timestamp refreshed at the top of `DebugSystem.update`
   — which runs last. So anything drawn by an earlier system stamped last frame's time, and the
   very next expire pass dropped it as already expired. Nothing was ever uploaded. The nav overlay
   is the first thing that ever called `line()`, which is why it took until now to find. It now
   reads the live clock.
2. **The debug panel was 1 206 px tall in an 821 px viewport.** Three agents added watches this
   milestone and the list hit 71 rows, so everything new was below the fold in the one tool whose
   job is to show you what the game is doing. The rows now wrap into columns.
3. **`CZ.camp('monument')` put the camera inside the obelisk.** The dais centre is *inside* the
   monument's pedestal, and nothing catches it — the collision octree is backface-culled, so a
   capsule fully inside a solid reports no penetration at all. The camp spot moved to the rim,
   which is where you would stand anyway. Worth knowing: **a teleport into solid geometry is
   silent in this engine.**
4. **The crosshair fade never fired, then never finished.** Written as `if (delta >= eps) apply`
   against a `NaN` seed, and every comparison with `NaN` is false — so it never ran once. Fixed,
   and then it settled at 0.996 opacity forever because the last 0.004 could not clear its own
   guard. The endpoints are now always written. (The existing gap code had the test the other way
   round for exactly this reason; it was not stylistic.)
5. **A 684 ms boot stall with a status line that lied about it.** The nav graph builds inside
   `EnemySystem.init`, which runs inside a single unyielded `loop.start()`, under a status that
   said "LOADING THE INKSLINGER". It gets its own line now: **TEACHING THEM TO CLIMB**.

## Known, deliberate, and not bugs

- ~~**The south loading-dock canopy is unreachable**~~ — **FIXED IN BUILD 006.** The 3.375 m
  overhang was over the 2.90 m climb limit. The limit is 3.45 m now, the canopy is reachable in
  17.5 s, and `CZ.camp('dock')` is a real camping test rather than a two-minute stare.
- **The flow field does not run at all while everyone is on your level.** That is the design, not
  a hole: a flat-ground fight uses BUILD 004's steering, conga line and clumping bit-for-bit
  unchanged, and pays nothing for pathing. If you press F8 in a street fight and see only the
  lattice, that is correct — the panel says `field idle`.
- **There is still nothing to spend points on.** Wall-buys, the box and Pack-a-Punch are M4.
- **Every zombie is still a shambler.** Sprinters, brutes, spitters and screamers land in M4 with
  real behaviour rather than as recoloured shamblers.

## The questions, short form

1. You camped the roof. Was the fight up there **good**, or just survivable?
2. Watching one climb — effort, or teleport?
3. Sprint → shoot. Is the gun back up in time?
4. Does the bullet go where the front post is? Can you see the post at night?
5. Does the kill ladder read as escalation, or as repetition?
6. Anything in the mix that is now too loud, or anything you still cannot hear?
7. Was there a round that got harder than it used to be at the same number?

---

# BUILD 003 — M2 Vertical Slice

**Date:** 2026-08-10 · **Milestone:** M2 · **Judge:** the **FEEL**. Not the art this time.

There is a gun, there are zombies, and shooting them does something. That is the whole build.
Every question at the bottom is about how it *feels in the hand* — if you find yourself
describing a colour, that's BUILD 002's job and it's already logged.

> **The bar this milestone was built against:** sprint, slide, and headshot a zombie mid-slide.
> That two-second sequence should be good enough that you immediately do it again.
> If it isn't, say so and say which of the three parts let it down.

## How to run it

```bash
npm run dev
```

Open the URL it prints. Click **CLICK TO DROP IN** — that click buys pointer lock *and* starts
the audio (browsers refuse to make a sound before a real gesture, so the game is silent until
you click). Give it a second on the loading bar. **Nothing is downloaded — ever.** The gun, the
zombies, the blood, the word pops and all 58 sounds are generated in code at boot.

You start with the **INKSLINGER** already in your hands. There is **no round director yet** —
that is M3 — so the zombies are on debug keys. **Press M first.**

Useful URL flags: `?debug=1` boots with the debug panel open · `?q=ultra` forces a quality tier.

## Controls

| | |
|---|---|
| **WASD** | move |
| **SHIFT** | sprint |
| **SPACE** | jump |
| **CTRL** — tap | slide. Tap again mid-slide to slide-cancel and keep your speed |
| **CTRL** — hold | dolphin dive (0.2 s hold); the landing roll gives i-frames |
| **LEFT MOUSE** | fire (semi-auto — one click, one shot) |
| **RIGHT MOUSE** | aim down sights |
| **R** | reload — **and then tap R again when the needle is in the GOLD zone** |
| **P** or **ESC** | pause |

### The zombie keys — this is how you get a fight

| | |
|---|---|
| **N** | **1 zombie**, walking in from a street entrance ~26–37 m away |
| **M** | **10 zombies**, same |
| **K** | kill everything |
| **Z** | +5 **right on top of you** (9–22 m) — this is the kiting/panic test |
| **X** | fill the arena to **25** — this is the performance test |
| **B** | clear them |

### And the developer keys, unchanged

| | |
|---|---|
| **` (backquote)** | debug overlay — now reads out the weapon, the horde and every VFX pool |
| **F1–F4** | quality LOW / MED / HIGH / ULTRA |
| **F5** | A/B the art direction (ink + halftone + bloom off) |
| **F7** | motion-comfort toggle (FULL / REDUCED) |

From the console: `CZ.spawn(10)` · `CZ.spawnNear(5)` · `CZ.killAll()` · `CZ.stats()`.

## The one mechanic to actually learn: ACTIVE RELOAD

Press **R**. A bar sweeps under the crosshair with a **gold block** at 40–57% of it. Tap **R**
again while the needle is inside that block:

- **PERFECT!** — the rest of the reload is cut ~40% and you get a **3-second damage buff**.
- **MISSED** — a small stumble, a bit slower. Deliberately a nuisance, not a punishment.

The verdict prints on the **exact frame you press**, so you can learn the rhythm. The gold zone
is a *fraction* of the bar, not a number of seconds, so it will stay in the same place forever
even when a reload-speed boon shortens the whole thing.

## What to judge — in this order

**1. Fire one shot at a wall. Then twelve.**
Weight, kick, rate of fire, and — the important one — where the sights end up when you stop
firing. The recoil pattern is deterministic (learnable), and the gun hands back only the part
of the climb *you* didn't already correct. Does the recovery feel like help or like the gun
fighting you?

**2. Press N. Watch one zombie walk at you across the plaza.**
Can you always find it? Does the approach read? Then shoot it in the head twice (that kills it)
and in the body four times (that also kills it) and tell us which one felt correct.

**3. Press M and fight ten.**
Hit registration, the hitmarker, the hitstop. Hitstop is 2–6 frames on crits and kills — the
single cheapest way to make impacts feel heavy, and the easiest thing in the game to overdo.
**Too much, too little, or right?**

**4. Press X (25 zombies) and kite them.**
Train them into a conga line. Do they clump wrong, spread wrong, or flow? Can you break line
of sight and rebuild the train? This is the classic Zombies skill and the arena was built for it.

**5. Reload under pressure.** Not on an empty street — with three of them closing. Is the
active-reload window fair when you're panicking, or is it a tax?

**6. THE SEQUENCE.** Sprint, slide, headshot mid-slide. Do it five times. Is it satisfying
enough to be the thing you do for an hour?

**7. Play for ten minutes.** The comfort regression check. Nothing about the camera changed
from BUILD 002, but the gun adds a kick channel and the VFX add flashes — if either of those
brings the queasiness back, that outranks everything else in this document.

## What was measured, not eyeballed

| | |
|---|---|
| `tsc --noEmit` / `vite build` | clean |
| Draw calls / triangles, **25 zombies all on screen** | **226 / 460 k** — 65% and 51% of the 350 / 900 k budget |
| Arena alone, same camera | 152 / 388 k |
| VFX cost | ≤ 7 draw calls in a firefight, **0 when idle** |
| Stillness (ART §4.1), camera parked | **max 0.10%** of pixels changed between frames, mean 0.018% (budget 0.5%) |
| Active-reload bar vs the weapon's real window | needle at **40.9%** when the window opens (expected 40.0%), **57.0%** when it closes (expected 56.8%) — inside one frame |
| Time to kill | **2 headshots** (105 damage each) or **4 body** (42 each) |
| VFX pool starvation over 220 shots | **0** |
| Console during a full fight | **no errors, no warnings** |

## Six bugs found by playing it, not by reading it

1. **Every bullet counted twice.** The weapon emitted `hit:enemy` *and* the zombie emitted it
   from inside `takeDamage`. Both were right in isolation; together every shot produced two
   hitmarkers, two blood sprays, two damage numbers on top of each other and two impact sounds.
   The zombie owns it now — splash and chain damage never pass through the gun at all.
2. **A headshot punted a zombie 20 metres.** `DamageInfo.knockback` was being read as a scale by
   the zombie and written as a damage figure by the gun, so the shove was damage *squared*:
   105 × 0.035 × 105 = 386 m/s of impulse. Measured: one headshot moved a shambler from 13 m to
   34 m to 65 m, which is also why every follow-up shot in a burst missed.
3. **Getting surrounded filled the screen with flat green.** Nothing in the steering stack ever
   pushed a zombie away from *you* — separation is between zombies — and one still creeps
   forward during its wind-up. Measured with eight attackers: bodies at 0.05 / 0.41 / 0.43 /
   0.46 m, i.e. a torso inside the camera. They now stop at 1.15 m, the same body radius they
   already keep from each other, well inside melee range. Being swarmed should be terrifying,
   not opaque.
4. **The muzzle flash floated to the left of the gun**, 8.6° off the barrel — the VFX system may
   not import the weapon, so its muzzle position was a fitted guess. Replaced with a measurement
   of the real barrel tip taken over the three frames the flash is actually alive.
5. **Nailing an active reload showed you nothing for half a second.** The weapon only announces
   success when the (now shorter) reload *ends*. A skill mechanic whose feedback lands 500 ms
   after the input cannot be learned, so the HUD now reads the same key press on the same frame
   and prints the verdict instantly.
6. **The build dead-ended on death.** You went down, eight seconds passed, and that was the
   session. There's a respawn loop now: the horde clears, you come back at spawn, press M again.

## Known gaps (M3 owns these, they are not bugs)

- **No rounds, no economy, no points for kills.** ROUND says 01 and POINTS never moves. The
  round director, the combo counter and the wall-buys are the next milestone.
- **No revive, no game over screen.** Going down clears the board and puts you back on your feet.
- **One gun, one enemy.** The other four enemy kinds return a stat-shifted Shambler so M3 can be
  written against the real API; they are not their own creatures yet.
- Health keeps counting past zero while you're down. Cosmetic, invisible — the HUD clamps it.
- **A real vsync'd fps reading still needs you.** rAF does not run in an automated tab, so no
  agent can certify 60fps. Open the debug panel (`` ` ``) with 25 zombies up and tell us the
  number — and set `CZ.renderer.autoQuality = false` first or it will quietly step the tier down.


## Verified by me in Chrome (not just agent-reported)

| | measured | budget |
|---|---|---|
| Stillness, camera parked, settled | **0.088% max / 0.071% mean** | <0.5% |
| Draw calls / tris, 24 zombies | **192 / 434k** | 350 / 900k |
| Frame time (GPU-inclusive throughput) | **~1.9–6.4 ms** | — |
| Straight line (hold W) | zero drift, zero yaw drift, 8 headings | zero |
| Roll / FOV punch | 2.81° / 8.00° | 4° / 8° |
| Enemy squint contrast | **+0.408** at fighting range, env **0.000–0.002** | ≥0.12 / ≤0.005 |
| Shots on zero-fixed-step frames | 8/8 registered | all |

Zombies confirmed **opaque at melee range** and correctly occluded by world geometry.

## Bugs killed in this milestone

Found by *running* it, which is the only way these show up:

1. **Every zombie rendered translucent.** The depth/normal prepass used a stock
   `MeshNormalMaterial`, which cannot run the vertex shader that poses the body — so the ink pass
   read background depth straight through the torso. One bug, four symptoms: see-through enemies,
   no interior linework, the §9 rim never drawing, and the arena inked through their chests.
2. **Slide was silently dropped on kills.** The crouch press edge — the sole slide trigger — died
   on zero-fixed-step frames. Per-kill hitstop opened a 66ms hole on *every kill*, and a 240Hz
   display opens one on ~50% of frames regardless. M1.5 had buffered only `jump`.
3. **`hit:enemy` fired twice per bullet** — two hitmarkers, two sprays, two sounds, per shot.
4. **Knockback was squared** — 386 m/s. One headshot threw a zombie 65m, which is why every
   follow-up missed. Now 0.30m per crit.
5. **Getting surrounded filled the screen with green** — nothing pushed zombies away from the
   *player*. Bodies reached 0.05m, inside the near plane. Now never closer than 1.15m.
6. **The weapon read as five featureless boxes** because its detail parts were *thinner than
   twice the ink line* — the trigger, guard, sights and fins were all rendering as solid ink.
   Now a documented law in `viewmodel.ts`.
7. **The horde was a clone army** — per-instance variation used symmetric ranges, whose most
   likely value is zero. Now sign × magnitude, with a guaranteed head loll and a dead arm.
8. **Muzzle flash was 8.6° off the barrel.**
9. **The boil was over the stillness budget on Retina** — I caught this myself after the fix
   pass passed at a smaller buffer. Amplitude was simply too high; measured a 4-point sweep and
   set the default from the data (0.3 → 0.12).
10. **The weapon read player state through untyped probes.** A rename would have silently cost a
    22° FOV flick with no compile error. `PlayerService` now carries `bobDistance`,
    `sprintAmount`, `grounded`, `crouching`, `lastLandWasDive`, `fovBias` and `addRecoil`.


## FEEDBACK — BUILD 003

> *(over to you)*

**1. Does the gun feel good? Weight, kick, rate, recoil recovery:**

**2. Is the active reload fun or annoying? Is the window fair?**

**3. Do zombies read instantly? Can you always find them?**

**4. Do hits feel like they connect? Hitstop — too much, too little, right?**

**5. Can you kite a group, or do they clump wrong / spread wrong?**

**6. Is the slide-into-headshot sequence satisfying enough to repeat?**

**7. Still comfortable after 10 minutes?**

**FPS with 25 up / machine:**

**The thing that bothers me most:**

---

# BUILD 002 — M1.5 Comfort, Stability, Space & Colour

**Date:** 2026-08-10 · **Milestone:** M1.5 · **Judge:** the COLOUR, the SPACE, and whether you
can play for ten minutes without feeling ill.

Built overnight from your BUILD 001 feedback. Everything below was measured, not eyeballed.

## Your feedback → what happened

| You said | Result |
|---|---|
| "dizzy after a minute" | Worst-case summed camera roll **12.08° → 2.68°**, peak 0.30° vs a 4° budget now enforced in code. Lateral bob at sprint **9.6cm → 0.9cm**. FOV punch capped at 8°. |
| "going straight feels like falling right" | **Three** asymmetries found. Hold-W for 600 frames: lateral drift **0 m**, yaw drift **exactly 0** — verified at four headings, and in the sprint and slide→dive chains that were actually broken. |
| "every pixel jumping like glitching" | Pixels changing per frame with the camera parked: **24.77% → 0.345%**. Grain, halftone, chromatic offset and grade are now bit-static. |
| "bigger spaces" | Arena **70×70m → 140×140m** (4× the area), buildings 6–10 storeys, eight 140m sightlines, seven verified kite loops, real verticality. |
| "we need better coloring" | Midtone band **10.3% → 48.9%**. Void **49.1% → 18.8%**. Violet down to **3.9%** of chromatic pixels; warm/cool split now 30.6% / 62.1%. |
| "easier to spot enemies" | Enemy squint-contrast **+0.182** on the bright plaza, **+0.186** at 25m, **+0.135** in a dark arcade — against an environment peak of **−0.027 to 0.000**. |
| "AAA+ performance" | **144 draw calls / 406k triangles** (41% / 45% of budget), **6.7 ms/frame** GPU-inclusive at HIGH. |

## ⚠️ The one change you may actively dislike

**Strafe lean now banks the opposite way.** The old code rolled the camera the *same* direction as
the strafe, contradicting its own comment and ART §10. It's flipped now. If it reads backwards to
you, it is a one-line sign flip in `updateLean` in `src/game/player/camera.ts` — say the word.

## Five real bugs that were invisible from the outside

1. **You were only seeing the top-left ⅔ of every frame.** `<canvas>` is a replaced element, so
   `position:fixed; inset:0` with `width:auto` laid it out at its intrinsic 2400×1315 inside a
   1600×877 window. The render's focus-of-expansion sat off-screen — which reads exactly as
   drifting toward a corner. Probably a bigger cause of "falling to the right" than the camera
   constants, and of "feels small compared to speed" too.
2. **Every ground light pool had been invisible since BUILD 001** — fan geometry wound the wrong
   way, so all 55 pools were backface-culled.
3. **`mapScale` meant two different things** (world-metre UVs vs −0.5…0.5 per face), so a
   *fraction* of one texture tile was stretched across a whole 42×34m building. That was the real
   cause of the "empty flat walls".
4. **The perf counter was blind** — three.js resets `renderer.info` per `render()`, so with a
   9-pass composer `CZ.stats()` only ever reported the final fullscreen quad: 1 call, 1 triangle.
5. **The game never finished booting in a background tab** — the loading yield waited on
   `requestAnimationFrame`. Now races a timer.

## What to look at

1. **Stand still and stare.** The image should be frozen. Only the 12fps line boil on near
   silhouettes may move, and only subtly.
2. **Walk a full lap of the ring boulevard**, then a radial street end to end. Does it feel big?
3. **Hold W and let go of the mouse.** Perfectly straight?
4. **Play for ten minutes.** Comfort is the acceptance test.
5. **Look up.** The high routes and roof decks are the weakest area — still cool-dominated.
6. `CZ.renderer.autoQuality` now steps quality down if you drop below 55fps. Set it `false`
   before measuring anything.

## Known weak spots (measured, not hidden)

- The west arcade interior is still 43% void + 23% blowout — a two-value poster.
- Everything above 6.8m is still largely monochrome violet.
- 60fps was verified only as a throughput number (~6.7 ms/frame). **A real vsync'd fps reading
  needs you, in a foreground tab, with the debug panel open.** No agent could certify it.

## FEEDBACK — BUILD 002

> *(over to you)*

**Comfort after 10 minutes:**

**Is the image stable now?**

**Colour — better? where's it still weak?**

**Does the space feel big?**

**Strafe lean direction — right or backwards?**

**FPS / machine:**

**The thing that bothers me most:**

---

# BUILD 001 — M1 Look Test

**Date:** 2026-08-09 · **Milestone:** M1 · **Judge:** the ART, not the mechanics.

## How to run it

```bash
npm run dev
```

Open the URL it prints. Click **CLICK TO DROP IN** — that click is what buys pointer lock, so
the game cannot start without it. Give it a second on the loading bar; the arena is ~200ms of
procedural geometry and every texture is drawn to a canvas at boot. **Nothing is downloaded.**

Useful URL flags: `?debug=1` boots with the debug panel open · `?q=ultra` forces a quality tier.

## Controls

| | |
|---|---|
| **WASD** | move |
| **SHIFT** | sprint |
| **SPACE** | jump (hold for height; tap for a short hop) |
| **CTRL** — tap | slide. Tap it again mid-slide to slide-cancel and keep your speed |
| **CTRL** — hold | dolphin dive (0.2s hold), landing roll gives i-frames |
| **P** or **ESC** | pause — releases the mouse. Click to resume. |
| **` (backquote)** | debug overlay: fps, frame ms, draw calls, movement state |
| **F1 F2 F3 F4** | quality: LOW / MED / HIGH / ULTRA |
| **F5** | **A/B the art direction** — toggles the ink, halftone and bloom passes |

There is **no weapon and there are no zombies in this build.** That is on purpose: M1 exists to
prove the renderer before anything is built on top of it. The HUD says `NO WEAPON` honestly
rather than showing fake numbers.

`window.CZ` is live in the console: `CZ.stats()`, `CZ.renderer.inkStrength = 2`,
`CZ.hud.titleCard('ROUND 7')`, `CZ.tuning.CAMERA.fovBase = 90`.

---

## What to look at — in this order

**1. Walk to the middle of the plaza and just turn around slowly.**
Ignore the movement, ignore the empty streets. Look at whether this reads as a *page* — heavy
ink, flat saturated colour, dots in the shadows — or whether it reads as a 3D game with a filter
on it. That distinction is the entire milestone.

**2. Press F5. Then press it again. Then again.**
This is the single most useful thing you can do in this build. Off = the geometry and the cel
lighting with correct colour. On = the ink pass, the screen-tone and the glow. If the "on" state
does not feel like a *different medium*, the art direction is not doing enough work yet.

**3. Get close to a wall, then back off 30 metres.**
The ink lines are screen-space, so they should stay the same weight on screen no matter how far
away the thing is — a distant building should still be boldly outlined, exactly like a comic
where the inker doesn't thin the line for background objects. Check the far skyline for this.

**4. Stand still and stare at one edge for five seconds.**
The outline offset is re-seeded at 12fps, not 60 — the hand-drawn "boiling line" wobble. It is
meant to be subtle enough that you feel it rather than see it. Tell me if it's invisible, or if
it's distracting.

**5. Look up at the sky, then at the marquee, then at a lit window.**
Sky, moon, clouds and stars are painted in a shader; the marquee and windows are the only things
allowed to glow. Is the glow a *halo around a hard shape* (right) or a wash (wrong)?

**6. Look at the HUD.**
Round / points / vitals badges, the crosshair (it opens up as you move — that's deliberate, it's
the only movement readout you have without a gun). Then in the console run
`CZ.hud.titleCard('ROUND 2','THEY ARE COMING')` to see the round-start card, and
`CZ.hud.toast('DOUBLE POINTS')`, `CZ.hud.prompt('HOLD F — RATATAT [500]')`.

**7. Press F1, then F4.** LOW should look *lower resolution*, never *less comic*. The ink, the
halftone and the cel bands are never dropped by a quality tier — only resolution and extras are.
If LOW loses the style rather than the sharpness, that's a bug and I want to know.

---

## The questions we need answered

Please answer these even if the answer is "fine". "Fine" is a real data point.

1. **Does it look like a comic book, or does it look like a 3D game with an outline shader?**
   If the second — what specifically gives it away?
2. **Does it look AAA?** Not "is it high-poly" — does it look like something with a studio
   behind it, or does it look like a well-executed jam game? Where does it drop below that bar?
3. **The night is very dark and very violet.** Is that atmospheric, or is it muddy and hard to
   read? Would you rather see this arena at dusk, or under a harsher, higher-contrast key?
4. **Are the shadows working?** Shadow-side surfaces are supposed to be filled with halftone
   dots, not flat black. Can you see the dots on the buildings, or do the facades read as dead
   black shapes?
5. **Is the ink too heavy, too light, or right?** (`CZ.renderer.inkStrength = 0.6 … 2.5` if you
   want to find your own number — tell me the number you land on.)
6. **Is the halftone too big, too small, or right?** (`CZ.renderer.halftoneScale = 0.6 … 1.8`.)
7. **The glowing windows.** Too much? They're the brightest thing on screen by a long way.
8. **Colour:** anything read as muddy, or as off-palette? Anywhere you wanted more `HOT` or
   `GOLD` and got violet instead?
9. **Composition:** standing at spawn, does the frame lead your eye somewhere, or is it noise?
10. **HUD:** does it read at a glance, does it feel like comic panel furniture, and is anything
    in the wrong corner?
11. **Frame rate** — press `` ` `` and read the FPS / FRAME MS row. What machine, what numbers,
    and did it ever hitch?
12. **The one thing that bothers you most.** Even if it's small. Especially if it's small.

---

## Known and deliberate in this build

- No weapon, no viewmodel, no zombies, no rounds, no sound. M2 and M3.
- The ROUND / POINTS / VITALS badges are wired to real values, but nothing changes them yet.
- Movement is fully implemented (slide-cancel chains, air-strafe, dive, auto-vault) but is *not*
  what this build is asking you to judge. Feel notes are welcome; they land in M2.
- The debug panel overlaps the ROUND badge. It's a dev tool; it wins.

## What changed to make this build

Five agents built the engine, the art library, the render pipeline, the arena and the player in
parallel; integration wired them together and fixed what only showed up once the frame was
composited. The three that mattered:

- **Every colour in the game was being converted sRGB→linear twice** (`art/palette.ts`). Three's
  ColorManagement already converts on `new Color(hex)`, so the extra `convertSRGBToLinear()`
  crushed `NIGHT_A` by 13×. Every shadow was pure black and the sky was nearly invisible.
- **Bloom was selecting a third of the screen.** Threshold and emissive boost were tuned against
  a scene with no emissive content; the arena has ~200 lit windows, a marquee and 17 practicals.
  Recalibrated in `main.ts` so glow is a halo around a hard shape.
- **Ink ambient raised from `NIGHT_A` to `NIGHT_B`**, so the shadow band carries screen-tone
  instead of falling to black.

---

## LEAD'S OWN LOOK — verified in Chrome before handing over

I ran the build myself at 1600×1000 and drove the camera around. Verified: `tsc` clean,
`vite build` clean (800 kB / 220 kB gzip), console clean, **106 draw calls / 517k triangles**
(budget is 350 / 900k), ~3.4 ms per composited frame even in a throttled background tab.

What I actually see, honestly:

**Working.** It does read as a *page*. The ink is bold and varies weight, the halftone screen is
clearly visible at a normal viewing distance, the flats are saturated, the HUD is real comic
panel furniture, and the cyan screen-space rim is picking out silhouette edges the way it should.
The plaza heading has depth and a landmark. This is a real foundation, not a shader demo.

**Not there yet — the frame is tonally monotonous.** Two problems, both confirmed independently
by the art director agent's pixel histograms:

1. **No value structure.** Walls, buildings and sky all sit at nearly the same violet midtone.
   There is no bright/dark read, so nothing in the frame is *staged* — the eye has nowhere to go.
   A comic page works because the colourist reserves the darks for the linework and the lights
   for where they want you to look. We're using the same tone everywhere.
2. **Nearly monochrome.** It's violet and gold, and almost nothing else. `HOT`, `ACID` and
   `ELECTRIC` barely appear outside the rim. Large wall faces are also empty — big flat
   halftone-screened planes with no linework, signage or damage on them, which flattens it further.

**Diagnosis:** this is a *lighting and level-art* problem, not a shader problem. The pipeline is
capable — it's being fed a flat, unlit, undecorated scene. Fixing it means a directional key with
real contrast, a brighter ground/wall value split, and colour accents placed deliberately.
That's the first thing M1.5 does, and it does not require touching the renderer.

---

## FEEDBACK — BUILD 001

> *(over to you — anything at all, in any order. Rough notes are more useful than tidy ones.)*

**Overall gut reaction:**

**Looks like a comic? (1–5, and why):**

**Looks AAA? (1–5, and why):**

**Too dark / just right / too bright:**

**Ink strength I'd land on:**

**Halftone scale I'd land on:**

**FPS / machine:**

**The thing that bothers me most:**

**Anything I want to see next:**

---

### Actions taken from this feedback

> *(filled in after the playtest — every change traced back to a line above.)*

# CONTINUE HERE

**Read `CLAUDE.md` first, then this.** This is the "you are here" pointer — rewritten every
session and the only doc allowed to go stale on purpose.

Last updated: end of the BUILD 010 overnight session.

---

## Where it lives

| | |
|---|---|
| Repo | https://github.com/elberacasa/comic-zombies (public) |
| Play | https://comic-zombies.vercel.app/play |
| Gallery / landing | https://comic-zombies.vercel.app |
| Deploy | `vercel deploy --prod --yes` from the repo root. GitHub is *not* auto-deploying. |

`npm run dev` → game at `/`, gallery at `/gallery.html`. Deployed those are swapped by
`scripts/postbuild.mjs`. **Test locally** — the production build does not expose `window.CZ`.

---

## ⇢ THE ONE THING TO DO NEXT

**`docs/HUMAN_JUDGE.md` is written and UNANSWERED. Get those 15 answers before building anything.**

An entire night of work shipped without a single human eye on it. Two items in that sheet are
written expecting a *negative* answer, and both are load-bearing:

- **Item 3** — knockback *and* effect density were cut in the same build. If a hit now feels
  weak, that is worse than either original bug and it is the first thing to undo.
- **Item 15 — THE ECONOMY IS PROBABLY TOO CHEAP.** Round 1 pays ~4,400 against a 1,200 wall SMG,
  a 950 box spin, 5,000 Pack-a-Punch, 9,500 for all four perks. BO2 pays ~500–1,000 in round 1
  against a 2,500 Juggernog — we are **~4× richer than the game we are copying**, and scarcity is
  where the tension lives. Not retuned blind; it is a feel call.

---

## What shipped overnight (BUILD 009 → 010)

**The SMG "lag" was never a frame-rate problem.** Every hit requested a hitstop: 0.02 s freeze +
0.055 s recovery = a 75 ms cycle. The ratatat fires every **66.7 ms** — shorter — so every shot
re-armed the freeze before the last had recovered and the world clock never returned to 1.0:
~59% speed on body hits, **~23% on headshots**. Zero fixed steps ran during each freeze, so the
player's own position stopped 15×/sec. Fixed with `WEAPON.hitstopMinGap` 0.13 (the pistol's own
cadence), applied at the *request* site so nukes and explosions are never throttled by a gun.

**Zombies keep walking when shot** — a split, not a deletion: `knockbackTranslation` 0.08 kills
the positional shove while `knockbackPerDamage` is untouched, so `NAV.climbBreakImpulse` (shooting
a body off a ledge) and explosive splash still work. The read moved onto the flinch springs.

**Weapon models.** A profile-driven detail vocabulary (ejection ports built as *frames* of proud
steel bars, not plates; charging handles that end in a hook because a hook survives the ink line),
a three-value material ladder (polymer 0.29 / frame 0.44 / steel 0.57) that also separates by
*specular character*, and an **ink floor that is now machine-checked** — `inkChunk()` clamps to
0.010 m and dev-warns. It immediately caught two pre-existing violations. Clearance came back
byte-identical: reach ≤0.393, swayed ≤0.418, near ≥0.072 across all four guns.

**The economy exists.** `spend()` / `canAfford()`, wall-buys (using the `buyCost`/`ammoCost` that
sat unused in every def; same spot sells ammo once you own the gun), the mystery box *with* its
relocate, four perks through the existing modifier stack, and Pack-a-Punch — which was almost
entirely wiring, since `upgradedDef()` and `WeaponService.upgrade()` were already built and
unreachable. `claim.ts` arbitrates the `interact` action. `tools/economy.mjs` covers it.

**Compass + minimap**, canvas-drawn, ~0.11–0.18 ms/frame, zero per-frame allocation. Specials are
`HOT` dots so the Screamer can finally be found and prioritised. Enemy ids are **pool slots and
get reused**, so an ordinary spawn actively clears the special flag.

**The blurry text and the tilted UI were one bug.** Every persistent panel carried a static
`rotate(±1–2.4deg)`; rotated DOM text cannot land on the pixel grid. Instruments are now
axis-aligned; the comic character moved to the frames, and the title card and popups kept their
kinetics.

**Map integrity — and it overturned the going hypothesis.** See the commit; the short version:
~80% of the metric was a **phantom capsule** (the harness probed the nominal 0.37×1.84 while every
body is scaled 0.325–0.428 / 1.615–2.130), crowd pressure was *protective* not causal (removing
separation **tripled** entries), and the real mechanism was the solver itself throwing bodies
metres across a discontinuity in `collideCapsule`'s depth field. Spawn embedding **6 bodies /
1.42 m → 0 / 0.00 m**; camp worst stall **28.6 s → 7.6 s**.

---

## Known-open, deliberately

- **The stalls are a separate, PROVEN bug and the mechanism is known.** 0.00% of stalled time is
  spent embedded. Bodies stall at three sites whose depth maps are smooth — walking on the spot,
  chasing, nav-routed, asking full speed. The unstick escalator never reaches its last rung
  because `ai.ts` resets `wedgeTrips` on a **single** good sample, so a body oscillating between
  stuck and barely-moving never accumulates the 2 trips the rescue needs. **This is the highest-
  value remaining fix** (22.6 s stalls) but it is an AI behaviour change and the horde's feel is
  confirmed-good — do it deliberately, with `tools/stairs.mjs` open.
- **`collisionIterations` 6 was tried and reverted.** It converges the solver but buys almost
  nothing with the honest scoreboard and costs two thirds of the conga queue gain (19% → 6%).
  Documented in `tuning.ts`. Do not re-apply without re-measuring the conga.
- **`tools/map.mjs` reports a real residue**: the drawn arena surface sits a median 0.12–0.24 m
  above its collider. Not a hole, but it *is* the "not pixel perfect" that was felt.
- **`combat.mjs` fails 2** (was 1) — both the same conga check. The underlying metric IMPROVED
  (13% → 19%, chains 5.4→6.1 becoming 6.0→7.1); one round inside the "every round" sub-check
  regressed. Deterministic across runs. The bar is documented as mis-specified.
- **`thumper` (launcher) and `spitter` do not exist** — both need real projectile code. Every
  other archetype shipped because they are hitscan. Deliberate, not forgotten.
- **The east gantry** is still a camp spot — level geometry, not AI.

## Conventions you must not rediscover the hard way

- **Machines check facts; the human judges taste.** Never spend tokens on "does this look good".
- **Run the harnesses before declaring movement/combat work done:** `stairs.mjs` · `zombie.mjs` ·
  `combat.mjs` · `economy.mjs` · `map.mjs`.
- **Measure before fixing.** Three separate hypotheses were overturned by measurement this
  session alone (the SMG was not a perf bug, crowd pressure was protective, and the wall-embedding
  metric was mostly a phantom). Assume the obvious story is wrong until a number says otherwise.
- **Browser testing:** pointer lock is blocked under automation and rAF is throttled in a
  background tab. Use `CZ.loop.stop()` + `CZ.loop.stepOnce()` with a synchronous busy-wait, and
  set `CZ.time.paused = false` before every step.
- Determinism is a product requirement (`GAME_BIBLE §9.3`). No `Math.random()`/`Date.now()` in sim.

## Useful console handles

```js
CZ.give('ratatat')       // 'boomstick' · 'longshot' — or press J in game to cycle
CZ.skipToRound(8)        // guaranteed Screamer debut
CZ.player.spend(500)     CZ.player.canAfford(500)
CZ.camp('roof_ne')       CZ.spawnStreet(20)      CZ.killAll()
CZ.renderer.autoQuality = false   // pin before measuring anything
CZ.stats()                        // true whole-frame draw calls / triangles
```

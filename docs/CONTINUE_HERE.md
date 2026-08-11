# CONTINUE HERE

**Read `CLAUDE.md` first (especially §1.5 THE PIVOT), then this.** Rewritten every session; the
only doc allowed to go stale on purpose.

Last updated: end of the weapon-rework session (BUILD 011).

---

## Where it lives

| | |
|---|---|
| Repo | https://github.com/elberacasa/comic-zombies (public) |
| Play | https://comic-zombies.vercel.app/play |
| Gallery | https://comic-zombies.vercel.app |
| Deploy | `vercel deploy --prod --yes` from the repo root. GitHub does NOT auto-deploy. |

`npm run dev` → game at `/`. **Test locally** — production does not expose `window.CZ`.
In game: **`J` cycles the arsenal**, `Q`/wheel swaps slots, `` ` `` toggles the debug panel.

---

## ⚠ IN FLIGHT RIGHT NOW

**Workflow `wq4kccb11` (`cz-recoil-and-ceiling`) was running when this was written.** Two phases:
1. Rate-aware CAMERA recoil + re-key the mount rule on `auto` (see §2 below)
2. Exempt the `hand` group from `depthCompress` + fix three builder parts under the ink floor

If it landed, verify gates (`tsc`, `npm run build`, `node tools/zombie.mjs`), commit, deploy.
If it did not, its script is at
`~/.claude/projects/-Users-alejandroberacasa-comic-zombies/*/workflows/scripts/cz-recoil-and-ceiling-*.js`
and can be resumed with `Workflow({scriptPath, resumeFromRunId})`.

**THE BROWSER BRIDGE IS DOWN.** `list_connected_browsers` → `[]` through many attempts and a
Chrome restart. Screenshots are impossible until it reconnects (try toggling the extension at
`chrome://extensions`, then clicking its toolbar icon on an `http://` tab). **The human is
currently the only one who can see the game.**

---

## 1. THE FINDING THAT EXPLAINS SEVEN FAILED WEAPON PASSES

**The builder caps every weapon in the game at drawn length:height = 1.21.**

`viewmodel.ts` hard-codes the hand: grip/heel bottom at gun y −0.1221, hammer top at 0.0529
(which `sight.lineY` must clear). So drawn HEIGHT ≥ ~0.175 m for any weapon that can exist. Drawn
LENGTH ≤ ~0.211 m and — measured — is **INVARIANT under `depthCompress`** (0.208–0.212 across the
field's whole legal range; higher dc buys rear length and gives back the same at the front).

Real firearms: pistol 1.6:1, SMG 2.6:1, shotgun 4.2:1, rifle 5.0:1. **Ours were 0.65–1.24:1 —
every gun in the game is taller than it is long. They read as blocks because they ARE blocks.**

Seven passes tried to fix "the guns look bad" by editing gun files. Every one was tuning inside a
box whose walls are in the builder. **Do not accept another gun-file-only fix for a proportion
complaint.**

**THE UNLOCK (phase 2 of the in-flight workflow): exempt the `hand` group from `depthCompress`.**
dc scales the hand too, so at dc 1.0 the forearm draws 54 mm closer to the eye, `nearClearance`
forces `restDz` −0.053, and that spends 53 mm of reach at the muzzle — reach 0.424 **with zero gun
geometry on it**. Freeing the hand returns ~50 mm of z and makes dc ≥ 0.9 legal. There is also a
design argument: the player's hand should be a consistent size whatever gun it holds.

---

## 2. RECOIL — three passes, three corrections, read before touching it

Each pass corrected the previous diagnosis. The maths is documented in `kickHzFor` / `kickAmpFor`
in `viewmodel.ts` and the `WEAPON.view` kick block in `tuning.ts`.

1. **It was never resonance.** An impulse train far ABOVE a spring's natural frequency does not
   resonate — it integrates to a **DC offset**. The SMG parked 4.31° pitch / 23 mm push-back and
   never returned to rest. Fixed by making spring FREQUENCY rate-aware (settle inside one shot
   interval).
2. **The eye sees the BAND, not the mean.** That fix took the mean 23.0 → 7.8 mm but left
   peak-to-peak at 23.9 mm — the model now slammed the full band from rest, 15×/sec. Fixed by
   scaling per-shot AMPLITUDE with rate: position exponent 1 (constant momentum/sec — the SMG was
   handing its mount 2.2× the momentum/sec of the pistol), rotation exponent 0.5 (constant
   energy/sec, keeps pitch the livelier axis).
3. **The threshold keyed on the wrong variable, and the CAMERA was never covered.** The amplitude
   rule engages above 542 rpm, so REDLINE at 520 rpm auto got NOTHING. The real distinction is
   `WeaponDef.auto`, not rate — a semi-auto is gated by a human finger. And camera recoil has no
   rate awareness at all, so REDLINE's steady-state AIM offset is **5.18° (climb 14.5°/s)** against
   the SMG's 1.51° — the camera genuinely moves where bullets go, hence "unplayable to shoot".
   **This is what the in-flight workflow is fixing.**

**Never touch `recoilPattern`, and preserve the FIRST SHOT bit-for-bit.** The pattern is the
game's skill ceiling (`GAME_BIBLE §3`, deterministic and learnable) and flattening the transient
"fixes" wobble by making the gun feel dead. Every pass so far kept first-shot peaks identical.

---

## 3. THE WEAPONS

| id | what it is | status |
|---|---|---|
| `inkslinger` | starter pistol | original, L:H 0.77 |
| `ratatat` | SMG, 900 rpm | recoil now calm; gunmetal (moved off ACID's hue) |
| `boomstick` | shotgun | L:H 0.65 — worst proportions in the game |
| `longshot` | marksman | L:H 0.99 |
| `press` | **THE PRESS** — clean-sheet pistol | ships ALONGSIDE inkslinger, stats cloned exactly so `J` is a pure visual A/B |
| `redline` | **REDLINE** — SCAR-H, 520 rpm auto | **best in the game, L:H 1.21 = the theoretical ceiling.** The human said it "looks much better" |

**The agreed lineup** (MW2 nostalgia, our own names — real counterpart for proportions, our name
to avoid trademarks): REDLINE = SCAR-H ✅ · THE TYPEWRITER = UMP45 · FULL STOP = Intervention ·
THE SPREAD = SPAS-12 · THE PRESS = Desert Eagle ✅

---

## 4. WHAT THE REFERENCE TAUGHT US — `docs/WEAPON_REWORK.md` is the brief

Written by cropping the weapon out of a Skopje '83 screenshot and measuring it. The headlines:

- **Their gun shows NO iron sights at hip.** Six passes died arguing about the shape of a feature
  the reference does not display. THE PRESS and REDLINE both ship with `opticBlock`, `opticFront`,
  `sightWings` and `railTeeth` all null.
- **Line weight is hierarchical** — heavy silhouette, interior at ~¼. Ours was uniform at 7 px,
  which is why every interior detail ever added became a blob. **Fixed**: `uInkInteriorWeight`
  0.25, and three floors now exist — `INK_FLOOR_SILHOUETTE` 0.010 / `INK_FLOOR_INTERIOR` 0.007 /
  `INK_FLOOR_CREASE` 0.003. Before that change a legal interior floor would have been 0.0094,
  i.e. indistinguishable from the silhouette floor.
- **Detail is panel lines on flat planes, not protruding parts.**
- §2.5 is a **standing quality bar** — seven checkable clauses, each one a mistake a real pass made.

---

## 5. NEXT, IN ORDER

1. **Land the in-flight workflow** (recoil playability, then the hand/`depthCompress` ceiling).
2. **`types.ts` relational placement.** The human spotted this: every part spec positions itself
   at ABSOLUTE `y, z` and none reference each other (`OpticBlockSpec {w,h,d,y,z,…}`,
   `EjectionPortSpec {h,d,y,z,…}`, …). That is structurally why nothing looks joined — parts are
   boxes at coordinates, not an assembly that mates. Wanted: parts attach to named anchors on
   other parts (`{ on: 'receiver.top', inset: 0.004 }`) so they mate by construction and survive a
   proportion change. Do this AFTER the ceiling lifts, so parts have room to mate into.
3. **Re-proportion every gun against the raised ceiling**, REDLINE first (it is the template).
4. Then the rest of the MW2 lineup.

## Known-open, deliberately

- **`tools/stairs.mjs` fails 3** — chase stalls up to 22.6 s. PROVEN separate from collision
  (0.00% of stalled time is embedded). `ai.ts` resets `wedgeTrips` on a SINGLE good sample so the
  rescue escalator never reaches its last rung. Highest-value gameplay fix remaining.
- **`combat.mjs` fails 2** — both the conga check; the underlying metric IMPROVED (13% → 19%).
- **`docs/HUMAN_JUDGE.md` (15 items) is still UNANSWERED**, including the flag that the economy is
  ~4× richer than BO2 and probably too cheap.
- `thumper` and `spitter` need real projectile code.
- The screen-space rim in the ink post pass still derives from the world key, so it varies slightly
  with heading; needs a per-object mask in `passes/ink.ts`.

## Conventions you must not rediscover the hard way

- **MEASURE BEFORE FIXING.** This session overturned its own hypothesis five separate times —
  the SMG "lag" was hitstop not frame rate; crowd pressure was protective not causal; the
  wall-embedding metric was mostly a phantom capsule; `depthCompress` does not crush length; the
  kick was a DC offset not resonance. **Assume the obvious story is wrong until a number says
  otherwise.**
- **Look at ONE full-frame screenshot at the start of visual work** (`CLAUDE.md §1.5`). Never
  judge from a zoom — a zoom of a small region exaggerates and has already produced a wrong call.
- **`CZ.stats()` IS MEANINGLESS IN A BACKGROUNDED TAB** — check `document.hidden`; it returns
  frozen values. Drive the loop with `CZ.loop.stepOnce()` and time it instead.
- Run the harnesses before declaring movement/combat work done: `stairs.mjs` · `zombie.mjs` ·
  `combat.mjs` · `economy.mjs` · `map.mjs`.
- Determinism is a product requirement. No `Math.random()`/`Date.now()` in sim.

# HUMAN JUDGE — BUILD 010 · THE OVERNIGHT BUILD

**15 items. Each one is under a minute.** Go top to bottom; the order avoids restarts.

Everything measurable is already measured and is NOT repeated here (types, build, console, draw
calls, clearance, harnesses, allocation). These are only the questions a machine cannot answer.
One word on the **Answer:** line is a useful answer. "hate it" is a useful answer.

```bash
npm run dev          # open the printed localhost URL, CLICK to lock the pointer
```

Test **locally, not on Vercel** — the production build does not expose `window.CZ`.

| | |
|---|---|
| move / sprint / jump / slide | `WASD` · `SHIFT` · `SPACE` · `CTRL` |
| fire / ADS / reload | `LMB` · `RMB` · `R` |
| **swap weapon** | **`Q`** or mouse wheel |
| **cycle the arsenal (debug)** | **`J`** |
| interact / buy | `F` or `E` |
| spawn 10 · fill to 25 · kill all | `M` · `X` · `K` |
| debug overlay | `` ` `` |

---

## A. THE BUGS YOU REPORTED

**1. THE SMG.** `CZ.give('ratatat')` (or `J`), spawn a crowd with `M`, and hold the trigger into
them. It "lagged the whole game" before. **Does it now fire cleanly at full rate?**

The cause was not frame rate — every hit froze the world for 75 ms and the SMG fires every
66.7 ms, so the freeze never finished recovering and the *world clock* ran at 23–59% speed while
you held the trigger. Watch specifically for: does your own movement stay smooth while firing?

Answer:

**2. Same test, headshots.** That was the worst case (~23% world speed). Aim high into a crowd and
hold. Still clean?

Answer:

**3. ZOMBIES NO LONGER GET PUSHED BACK.** Shoot a single zombie walking at you (`K` then `N`).
It should **keep coming** — flinching, but never travelling backwards. Does it read as relentless
now, or did losing the push make bullets feel like they do nothing?

That last one is the real risk: knockback *and* effects were both cut in the same build. If a hit
now feels weak, say so — that would be worse than the original bug.

Answer:

**4. EFFECTS / BLOOD.** You said "too much effects, we want mostly the blood". Fire into a crowd.
Is the per-hit stack simpler and blood-dominant now — and is it still obvious when you connect?

Answer:

**5. DAMAGE NUMBERS.** They now show the real damage dealt. Shoot a body, then a head. **Can you
read the difference at a glance,** and does seeing the true number make the guns feel more
legible?

Answer:

---

## B. THE WEAPONS — "our main screen"

**6.** `J` through all four. Do they now read as **four different guns you'd want to hold**, or
still like boxes? Look for: ejection ports, charging handles, sight wings, the SMG's vented
shroud, the shotgun's heat shield, the marksman's bolt handle.

Answer:

**7. THE MATERIAL SPLIT** is the change I expect to matter most — the gun used to be almost
entirely one grey and now has three flat value fields (dark polymer where your hands go, mid
frame, light steel on the bolt and muzzle). **Does it read as a made object rather than a prop?**

Answer:

**8.** Which of the four looks **worst**? I'd guess the longshot — heaviest foreshortening and a
ghost-ring rail. Name the worst one and what's wrong with it.

Answer:

**9. ADS on each gun.** The sights are solved per weapon, not eyeballed. Do the sights line up
with where the bullets actually go, on all four?

Answer:

---

## C. THE NEW HUD

**10. STRAIGHT UI + LEGIBILITY.** Every gauge you read is now axis-aligned — the tilt *was* the
blur, since rotated text can't land on the pixel grid. **Is the text sharper? Does the HUD still
feel like a comic**, or did it lose character? (The round title card and popups deliberately kept
their tilt.)

Answer:

**11. THE COMPASS** (top centre). Turn around slowly. Readable and useful, or noise?

Answer:

**12. THE MINIMAP** (top left). Spawn a crowd. Zombies are `ACID` dots, **specials are `HOT`**.
`CZ.skipToRound(8)` for a guaranteed Screamer. **Can you spot the Screamer on the minimap and go
kill it?** That's the whole reason it exists.

Answer:

---

## D. THE ECONOMY — points finally buy things

**13. WALL-BUYS.** Walk the arena; chalk outlines on walls sell weapons. Buy one with `F`. Then
walk back to the same wall — it now sells **ammo**. Does the buy feel good, and is the prompt
readable while you're being chased?

Answer:

**14. THE MYSTERY BOX AND PACK-A-PUNCH.** Find the box, spin it. Find Pack-a-Punch, upgrade a gun.
Do these feel like events worth walking across the map for?

Answer:

**15. ⚠ BALANCE — THE ONE I MOST WANT YOUR VERDICT ON, AND I THINK IT IS WRONG.**

Round 1 pays about **4,400 points**. A wall SMG is 1,200, a box spin 950, Pack-a-Punch 5,000, all
four perks 9,500. In BO2, round 1 pays roughly **500–1,000** against a 2,500 Juggernog — so we are
about **4× richer than the game we are copying**, and scarcity is where the tension lives.

Play rounds 1–6 normally and tell me: **can you afford everything almost immediately?** If yes,
prices go up (or income comes down) and the whole early game gets its shape back. I did not retune
this blind because it is a feel call and it is yours.

Answer:

---

## KNOWN, NOT WORTH REPORTING

- The **launcher (`thumper`) does not exist** — it needs real projectile code, unlike the four
  hitscan guns. Deliberate.
- The **Spitter** never spawns; same reason (no projectile).
- Perks are **four**, not BO2's seven — they'd collide with the 26 boons. See
  `docs/BO2_MECHANICS.md §4`.
- **Map integrity** (walls you can walk through, zombies clipping scenery) was the last job of the
  night — check `docs/MAP_INTEGRITY.md` and the commit log for where it landed.
- The **east gantry** is still a safe camp spot (level geometry, not AI).

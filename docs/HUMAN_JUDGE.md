# HUMAN JUDGE — BUILD 008 · SPECIALS + BODIES

**11 items. Each one is under a minute.** The order is chosen so you never have to restart.

Everything measurable is already measured and is NOT repeated here (types, build, console, draw
calls 194, triangles 459k at 25 alive, hit registration at 5/15/30 m, heap, sim cost). These are
only the questions a machine cannot answer. One word on the **Answer:** line is a useful answer.

---

## TO REPRODUCE FAST

```bash
npm run dev          # open the printed localhost URL, CLICK to lock the pointer
```

Test **locally, not on Vercel** — the production build does not expose `window.CZ`.

| | |
|---|---|
| move / sprint / jump | `WASD` · `SHIFT` · `SPACE` |
| fire / ADS / reload | `LMB` · `RMB` · `R` |
| spawn 10 · fill to 25 · kill all | `M` · `X` · `K` |

Open the console (`` ` `` toggles the debug overlay) for the `CZ.` commands below.

---

## A. THE BODIES — this is the main event

The note was *"not blobs, but bodies with their movement."* Three things changed: the limbs got
real **joints**, the hands and feet got **bigger**, and the walk got a **lurch**.

**1.** `CZ.killAll()` then `CZ.spawn(1)`. Walk up to about 10 m and just watch one zombie walk.
Can you now see an **elbow and a knee** — a specific place where the limb bends, rather than a
tube that curves?

Answer:

**2.** Same zombie. Look at the **hands**. They are 29% wider and flatter now. Do they read as
*hands coming at you*, or still as stumps on the end of the arms?

Answer:

**3.** Same zombie, watch it from **behind** as it walks away. The calf now bulges backward and
the kneecap forward. Does the leg have a front and a back, or is it still a bendy cylinder?

Answer:

**4.** THE LURCH. Watch the hips. The body now shifts its weight **sideways onto the planted
foot**, and drops harder when it lands on its bad leg. Does it read as *something wrong with that
one*, or just as a walk?

Answer:

**5.** Is the lurch **too much**? This is the one most likely to be overcooked — say so if it
looks drunk, seasick, or like the body is sliding rather than stepping.

Answer:

**6.** `CZ.spawn(25)`. With a full horde, can you still tell individual zombies apart — or does
the extra motion turn the crowd into visual noise?

Answer:

---

## B. THE SPECIALS — they now actually appear in play

Until this build the Screamer only existed via a console command. Specials now enter the mix at
set rounds, and a special's **first** round is guaranteed rather than a dice roll.

**7.** `CZ.skipToRound(8)` and play the round out. A **Screamer** (tall, pink/HOT) is guaranteed
to arrive about a third of the way in. Did you **notice it arrive** — did it read as an event?

Answer:

**8.** Let one Screamer finish its wind-up on purpose. It calls in 4 more bodies. Is that
punishing enough to make you want to prioritise it next time — or can you ignore it?

Answer:

**9.** Can you pick the Screamer out of a crowd **fast enough to act on it**, or do you find it
only after it has already screamed?

Answer:

**10.** `CZ.skipToRound(20)`. Now it is roughly half specials (brutes, sprinters, screamers).
Is that mix **fun** or is it chaos? Specifically: does anything feel unfair rather than hard?

Answer:

---

## C. THE ONE REGRESSION RISK

**11.** Play rounds 8 → 12 normally, without skipping. Do rounds now take **too long to clear**?
Screamers add bodies outside the round's own count, so a round can stretch. It cannot get stuck —
that is proven — but it can drag, and dragging is the thing that kills "one more round".

Answer:

---

## KNOWN, NOT WORTH REPORTING

- Points still has nothing to spend it on (wall-buys / Pack-a-Punch not built yet).
- The Spitter does not appear at all — it has no projectile yet, so it is parked deliberately.
- The east gantry is still a safe camp spot (level geometry, needs an intermediate tier).
- Some zombies still stall or clip scenery on the far side of the arena — measured and
  pre-existing (`tools/stairs.mjs`, 3 failing checks), not touched by this build.

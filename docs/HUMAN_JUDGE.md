# HUMAN JUDGE — BUILD 007

**14 items. Each one is under a minute. Go top to bottom — the order is chosen so you never have
to restart or backtrack.**

Everything measurable has already been measured; none of it is repeated here. These are only the
questions a machine genuinely cannot answer. Write whatever you actually think on the
**Answer:** line — "fine", "hate it", one word is a useful answer.

---

## TO REPRODUCE FAST

```bash
npm run dev          # then open the printed localhost URL and CLICK to lock the pointer
```

| | |
|---|---|
| move / sprint / jump | `WASD` · `SHIFT` · `SPACE` |
| slide / dive | tap `CTRL` · hold `CTRL` |
| fire / aim / reload | `LMB` · `RMB` · `R` (tap `R` again in the gold zone = active reload) |
| **spawn 1 / 10** | `N` · `M` |
| **+5 right on top of you** | `Z` |
| **fill to 25** | `X` |
| **kill everything** | `K` |
| debug overlay · nav draw | `` ` `` · `F8` |
| pause | `P` or `ESC` |

In the browser console (F12) — the two that matter this build:

```js
CZ.skipToRound(10)      // jump the GAMEPLAY to round 10 (count, health, speed, spawn cap)
CZ.setEscalation(20)    // paint round 20's LOOK right now, without playing it.
                        // CZ.setEscalation() with no argument snaps back to live.
```

`CZ.spawnNear(3)` · `CZ.camp('roof_ne')` · `CZ.killAll()` · `CZ.stats()` are the other handy ones.

---

## A · MOVEMENT — the regression you reported

### 1. Walk up every staircase you can find. Just hold W.

This is the "**after the gravity changes i cant go upstairs**" bug. It was real, it had three
separate causes, and it is fixed. Walk up the plaza stairs, the east stairs to the market roof,
the west fire escape (both flights), the loading-dock steps, and step onto the plaza monument.
Try each one **at an angle** and **sprinting**, not just square-on — that is how it used to break.

Does every flight go up, first try, without you thinking about it?

**Answer:**

### 2. At the top of a flight, do you get a little hop?

Cresting a ramp still throws you a few centimetres into the air before you settle. It is small and
it may read as fine — momentum carrying you over the lip. Tell me if it reads as a *bug* instead.

**Answer:**

### 3. Walk off a roof edge. Then walk off a low kerb.

You should fall off both — no floating, no invisible ledge holding you up. Does falling feel like
weight, or like being switched off?

**Answer:**

### 4. Hold W across flat open street for a few seconds without touching the mouse.

You should track dead straight. Does anything pull you sideways, stick, or stutter?

**Answer:**

---

## B · THE ZOMBIES — "better movement… slow… aren't truly a threat"

### 5. `CZ.spawnNear(3)`. Look at one from about 5 m, from the side, while it walks.

The whole body is new — it is properly skinned now instead of rigid chunks. The *timing* was
deliberately left alone. Do the elbows and knees still read as **drawn**, with weight and snap, or
has it gone smooth and rubbery like generic game animation?

**Answer:**

### 6. Same zombie. Is the head obviously a target?

The head hitbox used to be 59% wider than the skull you were aiming at — you could not learn it.
It now matches the drawing. Can you tell where to shoot without thinking? Does it still read as a
head at 25 m?

**Answer:**

### 7. Shoot heads. Do crits feel *earned*, or just harder?

The target is smaller and honest now. Land a few. Is the hit feedback — sound, pop, the word —
satisfying enough to make you want the next one?

**Answer:**

### 8. `CZ.spawn(15)`. Train them: walk backwards in a wide circle and let them string out.

This is the CoD loop you asked for. Do they form a **line you can sweep**, or a blob that wraps
around you? Can you stack headshots down the queue and feel a combo building?

**Answer:**

### 9. Shoot an arm off. Then a leg.

**Answer:**

### 10. `CZ.skipToRound(10)`. Now actually fight.

By round 10 most of them sprint. Three of them on you drops you in well under two seconds. Are
they genuinely dangerous now — do you feel pressure to keep moving? Or still a nuisance?

**Answer:**

### 11. Do they still get stuck, or fail to reach you?

Run around, go up to a roof, camp there a moment (`CZ.camp('roof_ne')` then `CZ.spawnStreet(15)`).
Do they come and find you everywhere, or do you see any standing still, jittering, or stuck inside
walls? **If you see one stuck, tell me roughly where.**

**Answer:**

---

## C · THE LOOK — "so people dont get bored quick"

### 12. `CZ.setEscalation(1)`, look around. Then `CZ.setEscalation(20)`. Same spot, same view.

Round 20 should feel like a *worse night* — dirtier, tighter, more hostile — without you losing
the ability to read the space or spot a zombie. Is the change obvious enough to be worth it? Is it
too much? Does anything get so dark you cannot fight in it?

**Answer:**

### 13. Go up high — the NE roof or a catwalk — and look out over the city.

The rooftops were the weakest-looking part of the game and got the most work. Does a high route
now look as finished as the street, or is it still the boring part?

**Answer:**

### 14. Anything off-model, ugly, or annoying?

Wrong colour, flat lighting, a surface that looks like a programmer box, UI that breaks the comic
language, a sound that grates, anything that reads as "prototype". Be blunt and specific.

**Answer:**

---

## THE TWO THAT DRIVE THE NEXT MILESTONE

### What is the single worst thing about the game right now?

**Answer:**

### What should we do next?

**Answer:**

---

## ONE DECISION ONLY YOU CAN MAKE

Enemy health now follows CoD's real curve exactly. That means it never stops growing: by round 20
a zombie takes **26 headshots** with the starting gun. Pack-a-Punch (×2.1) exists in the code but
**nothing currently sells it**, so right now there is no way out of that wall.

Three options — pick one:

- **A.** Leave it. Ship the upgrade station next milestone so the curve is survivable.
- **B.** Cap health at a round (one number, `ROUND.hpCapRound` — 12 or 15) so late rounds stay
  fightable with what you have.
- **C.** Something else — say what.

**Answer:**

---

## FOR THE RECORD — what the machines verified, so you don't have to

Don't spend a second checking these; they are here only so you know what is already covered.

- Typecheck, production build and browser console all clean. No GL errors.
- All **9 staircases** climb — verified twice, headless and in the real browser with real key
  presses. Both flights that were completely stuck now work.
- All **17 ledges** in the arena drop you when you walk off them.
- 25 zombies on screen: **199 draw calls / 465k triangles** against a 350 / 900k budget.
- No memory leak across a dozen simulated rounds; GPU resources plateau.
- Walking a straight line drifts **exactly zero** metres. Camera roll and FOV punch are inside
  their comfort budgets.
- With the camera parked the picture is genuinely still (≈0.2% of pixels move, budget 0.5%) — the
  print does not crawl, at round 1 or round 20.

**Two things are known-imperfect and are NOT worth your time to confirm** — they are already on
the list: a few zombies out of 25 can still wedge briefly against thin roof railings during long
sessions, and the horde is slower up the *east stair specifically* than it should be (11 of 15
make it). Both are being tracked.

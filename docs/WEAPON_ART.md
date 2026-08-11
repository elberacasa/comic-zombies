# WEAPON MODELS — the spec

> *"weapon models need to be improved by a lot, thats our main screen we need fun looking aaa+
> quality weapons with details"* — the playtester

The viewmodel is on screen **100% of the session**. It is the single most-looked-at object in the
game. Everything below is written against `src/game/weapons/viewmodel.ts`.

---

## 0. THE COUNTER-INTUITIVE RULE THAT GOVERNS EVERYTHING

**"More detail" does NOT mean more small parts. Under our ink line, small parts DELETE detail.**

The inverted-hull outline inflates every silhouette by a **screen-space** amount —
`READABILITY.VIEWMODEL_OUTLINE_PX` = 7 px. A part thinner than roughly twice that band has no
albedo left between its two inflated faces and **renders as solid black**.

This is not theory. It already happened, and it was measured (see the block comment above
`buildGunGeometry`): the trigger guard (0.008 m), the trigger (0.006), the muzzle fins (0.005) and
the front sight (0.006) were all under the band and **all printed as black blobs**. An art review
at the time recorded the result as *"five untextured boxes with no trigger guard and no barrel
read"* — the parts were modelled, the line was erasing them every frame.

At ~0.30 m from the eye at 78° FOV, **0.008 m of real width ≈ 13 px on screen**. The floor is
therefore **0.010 m for anything structural**, and that is a hard gate, not a guideline.

**So the way to make these guns look expensive is:**

1. **Bigger, bolder, fewer shapes** — a chunky charging handle you can actually see beats six
   receiver pins that all print as one smear.
2. **Material separation** — the ink style gives us flat colour fields, so a *value* or *hue*
   break between adjacent masses reads as detail at zero geometric cost. This is the cheapest
   quality lever we have and it is currently under-used: almost the whole gun is one grey.
3. **Silhouette events** — a notch, a step, a hook on the OUTLINE. The outline is the one thing
   the ink line cannot erase, because the ink line *is* the outline.
4. **Asymmetry** — a real gun is not mirror-symmetric. An ejection port on one side, a selector
   on the other, a sling loop on one side only. Costs three boxes, reads as authored.

---

## 1. WHAT EACH GUN NEEDS

All four share the hand, grip, trigger and guard (same player holding them). The identity lives
in the upper, the fore-end, the stock and the muzzle.

### Every gun gets (the missing vocabulary)

- **Ejection port** — a real recessed rectangle on the RIGHT side of the receiver, with a lip.
  This is the single most "gun-like" detail and no gun currently has one.
- **Charging handle / bolt** — a bold protruding shape. On the pistol it can ride the slide.
- **Selector switch** — a small lever on the left of the receiver. Bold enough to survive the ink.
- **Magazine release + mag well lip** — a step where the magazine meets the frame, so the mag
  reads as a separate inserted object rather than a box glued on.
- **Sight protective wings** — ears either side of the front post. Instantly reads as "military".
- **A stamped panel or vent group** — 2–3 bold cuts, not 8 fine ones.

### `inkslinger` — pistol, the reference
Keep its proportions (its clearance is measured at 0.393 and it is the ADS reference). Add:
ejection port, extractor, a beavertail behind the web of the hand, slide-lock lever, and a
squared-off trigger guard hook at the front (a very "comic gun" silhouette event).

### `ratatat` — SMG
The player *"loved the SMG"*. Do not change its proportions; make it **look** like what it feels
like. Add: a vented barrel shroud (3 BOLD slots, not 8 thin ones), a folding-stock hinge that
reads as a mechanism, a bold magazine well, and a top rail with 3–4 chunky teeth. Its curved
stick mag is its best silhouette feature — emphasise the curve.

### `boomstick` — shotgun
Everything about it should say BORE. Add: a heat shield over the barrel (a half-tube with 2 bold
cutouts), a visible shell in the ejection port, a receiver that is visibly *thicker* than any
other gun, a bold bead front sight on a raised post, and ribbing on the pump that reads as grip.

### `longshot` — marksman
The most likely to look wrong (raised ghost-ring rail + heaviest foreshortening). Add: a proper
scope-rail with bold teeth, a cheek riser on the stock, a bipod stub under the fore-end, a long
fluted barrel (2–3 bold flutes), and a bolt handle sticking out to the right — the strongest
possible "this is a rifle" silhouette event.

---

## 2. MATERIALS — the biggest available win

Today: `bodyMat` (grey), `accentMat` (RUST), `trimMat`, `sightMat` (BONE), `coreMat` (GOLD
emissive), `gloveMat`. Almost the entire gun is `bodyMat`. That is why it reads flat.

**Add a value break.** The established palette rules (`ART_DIRECTION.md` §1, §9) still bind:
- Enemies own the top of the value ladder and the reserved hues (`ACID`, `HOT`). Do not touch.
- `GOLD` is reserved for interactables and the muzzle core.
- The gun sits ~0.44 luma, between `SLATE` (0.32) and `CONCRETE` (0.52).

**Within that, split the gun into two or three value fields:**
- A **darker polymer** for grip, fore-end, stock — the parts a hand touches.
- The existing **mid grey** for the receiver/frame.
- A **lighter machined steel** for the bolt, charging handle and muzzle device.

Three flat fields with hard cel breaks between them will do more for perceived quality than
twenty extra boxes. Keep the single `RUST` warm accent doing what it already does — marking the
silhouette so the gun never reads as a plumbing fixture.

---

## 3. THE CONSTRAINTS YOU CANNOT BREAK

1. **`assertClearance` must pass for all four guns.** Budgets: reach ≤ 0.40
   (`view.maxEyeDistance`), swayed ≤ 0.42 (`MOVE.radius`), near ≥ 0.07 (`CAMERA.near` is 0.05).
   The dev build prints a per-gun table at boot — read it, do not guess. Current margins are
   TIGHT: every gun is between 0.387 and 0.393 against a 0.40 budget.
   **Anything you add forward (−z) or right (+x) eats that margin.** Detail added *behind* the
   hand (+z) or *inward* is free; a longer muzzle device is not.
2. **Minimum 0.010 m on anything structural.** See §0. Non-negotiable.
3. **The sight line is solved, not tuned.** `SIGHT.lineY` → `aimSocketOf()` → the ADS translation.
   Move a blade and you move where the gun shoots relative to where it looks. If you change a
   sight, the boot assertion must still report the socket on-axis.
4. **Draw calls.** Each gun is one Group of ~9 meshes plus hulls; only one is visible at a time.
   Do not add meshes casually — add geometry to the EXISTING part groups (frame / slide / trim /
   accent / sights / magazine) instead of creating new ones. A new material or mesh per detail is
   the wrong answer.
5. **Everything procedural.** `bevelBox`, `inkCylinder`, `place`, `mergeForStatic`. No files.
6. **Bevel everything.** The chamfer is what catches the rim light and reads as an inked edge
   (`ART §2/§3`). Low, deliberate segment counts. Nothing perfectly square.

---

## 4. HOW TO KNOW IT WORKED

Objective, machine-checkable — these are the gates:
- `npx tsc --noEmit` clean.
- Boot clearance table: all four guns inside every budget, printed per gun.
- ADS socket on-axis for all four (the boot assertion warns if not).
- Draw calls with a gun equipped do not rise materially.

Subjective — **the human judges this, not an agent.** Do not spend tokens screenshotting and
squinting. Ship it and let them look. The question they will be asked is simply: *does this look
like a gun from a game you would pay for?*

# THE WEAPON REWORK — measured against the reference

> *"we need to truly rework it that's our main screen every player will look at for hours at each
> weapon"* — the playtester, after rejecting six consecutive sight fixes.

**This supersedes the sight-shape advice in `WEAPON_ART.md` §1.** That file's part vocabulary and
its ink-floor law still hold. Its instinct to add parts does not.

---

## 0. WHY SIX ATTEMPTS FAILED

Every pass patched ONE PART IN ISOLATION — sight wings, then rail teeth, then blade colour, then
blade proportions, then a cut window, then a bored block. Each fixed the stated symptom and left
the object no better, because **nobody ever designed the gun as a whole thing**. The weapon was
built by accretion: a part vocabulary, then profiles, then a palette, then surfaces, then sights,
each pass touching one layer and none looking at the result.

The playtester looked at the rendered frame and counted three blocks in about a second. Every
agent before them had passed its own gates.

---

## 1. WHAT THE REFERENCE ACTUALLY DOES

Measured by cropping the weapon out of a Skopje '83 screenshot and looking at it at size. These
are the findings, in order of how much they matter.

### 1.1 THERE ARE NO IRON SIGHTS AT HIP. AT ALL.

The top of that receiver is a clean, uninterrupted surface. One big smooth arch (a carry handle /
optic housing) and nothing else — no rear notch, no front post, no blades, no rail teeth, **no
thin protrusion of any kind anywhere on the weapon**.

We have spent six rounds arguing about the shape of a feature the reference does not display.

**RULE: nothing thin may stand on the receiver at hip.** If the gun needs an aim reference it is a
single large housing that reads as part of the receiver — one mass, not two, not three. The ADS
sight picture is solved separately and does not require visible blades at rest.

### 1.2 LINE WEIGHT IS HIERARCHICAL. OURS IS UNIFORM.

Their outer silhouette carries a very heavy black line. Interior detail lines are roughly a
QUARTER of that weight. That hierarchy is what lets them put dozens of interior marks on a gun
without it turning to soot.

We draw the silhouette and the interior at the same weight
(`READABILITY.VIEWMODEL_OUTLINE_PX` = 7 with a thinner `view.sightOutlinePx` as the only
exception). **This is why every interior detail we have ever added became a blob, and it is the
single highest-value change available.** A thin interior line pass would let the guns carry real
detail for the first time.

### 1.3 DETAIL IS PANEL LINES ON FLAT SURFACES, NOT PROTRUDING PARTS.

Their receiver is a big smooth slab with scribed grooves across it. Those grooves ARE the detail.
They cost nothing in silhouette, they cannot become sticks, and they cannot be mistaken for
antennae.

We have been adding geometry. **Stop adding geometry. Draw lines.** Panel lines can come from the
surface maps (`art/surfaces.ts` already generates bold marks) or from a crease pass — either is
cheaper and safer than a part.

### 1.4 BIG SIMPLE SHAPES, WITH CALM AREAS BETWEEN.

One big slab, one big arch, a cylinder with four thick rings, a chunky handguard. Nothing on that
gun is small. Detail is CONCENTRATED in two or three places with large quiet areas between them —
the eye gets somewhere to rest.

Ours distributes small details evenly, which reads as noise at any size.

### 1.5 SATURATED ACCENTS ARE TINY AND PERIPHERAL.

A blue tube, an orange stripe, a yellow panel edge — each a few percent of the weapon's area, each
highly saturated, all placed at the periphery. The main body is a calm desaturated grey.

We spread mid-saturation colour across the whole weapon, which is why the guns read as "a coloured
object" rather than "a grey machine with hot details".

### 1.6 THE GUN SITS DIAGONALLY.

It runs lower-left to upper-right across the frame, not axis-aligned. That diagonal is a large
part of why it feels dynamic rather than like a held prop.

---

## 2. WHAT TO ACTUALLY BUILD, IN ORDER

1. **Delete every thin standing part from all four guns.** No blades, no posts, no separate
   housings. If a gun keeps an aim reference it is ONE mass, integral to the receiver.
2. **Add a thin interior line weight** so interior detail can exist at all. This unblocks
   everything else and is one change in the ink pass.
3. **Replace part-detail with panel lines** on the big planes.
4. **Rebalance colour**: calm desaturated body, 2–3 tiny saturated accents at the periphery.
5. Only then revisit proportions.

## 2.5 THE STANDING QUALITY BAR — for every new gun, not just the first

> *"we are making new guns so just a consideration, make the weapons look truly AAA+ quality,
> super pro"* — the playtester.

This is a STANDING instruction on all weapon work from here, not a note on one pass. The viewmodel
is on screen 100% of the session; it is the most-looked-at object in the game and it is judged
against a published commercial title.

What "AAA+" means concretely here — each of these is a thing a previous pass got wrong, so they
are checks, not sentiment:

1. **It must read as a MACHINE, not an assembly of primitives.** Parts must look joined,
   machined and load-bearing — a thing that could be manufactured. If a part looks placed rather
   than fitted, it is wrong.
2. **NO part may look bolted on.** Six passes died on exactly this. Anything standing separate
   from the body of the gun is suspect by default.
3. **Detail comes from LINES AND SURFACE, not from added solids** (§1.3). This is now buildable —
   see `INK_FLOOR_INTERIOR` / `INK_FLOOR_CREASE` in `tuning.ts` and the hierarchical ink line.
4. **Big calm masses with detail concentrated in two or three places** (§1.4). Evenly-distributed
   small detail reads as noise at every size.
5. **Calm desaturated body, 2–3 tiny saturated accents at the periphery** (§1.5).
6. **It must survive the ink line at ARM'S LENGTH**, which is the only distance it is ever seen
   at. Author for the screen, never for the spec sheet — the hero lens magnifies ~2.6x at hip, so
   a part that reads modest in metres can dominate the frame.
7. **Every mechanism must look like it works.** A charging handle should look grabbable, an
   ejection port like something exits it, a magazine like it inserts.

**The acceptance test is §3 below and it has not changed**: crop the weapon out of a full-size
frame, put it beside the reference crop, and ask whether ours reads as a machine. Anything less
than yes is a no.

## 3. HOW TO KNOW IT WORKED

The gates stay as they are (ink floor, clearance, aim solve, 60 fps). But the acceptance test for
this work is not a number:

> **Crop the weapon out of a full-size frame and look at it next to the reference crop.** If ours
> reads as a machine and theirs reads as a machine, it passed. If ours reads as a pile of blocks,
> it did not.

Judge at FULL FRAME SIZE, never from a zoom — a zoom of a small region exaggerates everything and
has already produced one wrong call this session.

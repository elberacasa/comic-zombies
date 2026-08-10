# ART DIRECTION — Comic Zombies

**The look is not a filter we add at the end. It is the rendering architecture.**
If a new system doesn't have a comic answer for how it draws, it isn't done.

---

## 0. The reference in one sentence

*A modern graphic novel — heavy black ink, screaming saturated flats, halftone screen-tone —
rendered with AAA lighting discipline, cinematic composition and film-grade post.*

Think: **Into the Spider-Verse** (halftone + chromatic offset + boiling line) ×
**Borderlands** (ink outlines, flat shading, attitude) × **Call of Duty** (camera work, VFX
density, HUD readability, weapon presentation).

**Anti-references — if we drift here, it's a bug:** photoreal PBR · pastel low-poly indie ·
Minecraft blockiness · flat-shaded untextured "programmer art" · neon synthwave.

---

## 1. PALETTE — the ink set

Defined once in `src/art/palette.ts`. Nothing in the game picks a colour outside this set.

The set is a **complementary night split**: warm sodium light against cool teal shadow, with
violet as the connective mid that keeps them one picture. `luma` is the sRGB-encoded value of
the raw token — the number a histogram of the frame reports — and the ladder is deliberate.
BUILD 001 had nothing authored between 0.19 and 0.73, which is *why* its frames measured 49%
of pixels under 0.1 luminance and only 10% in the midtone band — no lighting rig can invent a
midtone that the ink set does not contain. Measured off the drawing buffer, 12 camera
positions, before → after the BUILD 002 colour pass:

| | sub-0.1 (the void) | 0.2–0.7 (midtone) | over 0.7 (blown) |
|---|---|---|---|
| BUILD 001 | 49.1% | 10.3% | 33.3% |
| **BUILD 002** | **18.8%** | **48.9%** | **2.9%** |

| Token | Hex | luma | Use |
|---|---|---|---|
| `INK` | `#0B0A14` | 0.03 | Outlines, panel gutters. **RESERVED FOR LINEWORK.** |
| `NIGHT_A` | `#1D2747` | 0.15 | Sky zenith, fog far, the ambient floor |
| `INK_SOFT` | `#262E4C` | 0.18 | Secondary lines, cool shadow band |
| `NIGHT_B` | `#4D2E82` | 0.23 | Sky horizon, fog near — **the connective violet** |
| `SLATE` | `#445270` | 0.32 | Building mass, machinery. The biggest vertical area |
| `TEAL` | `#2F7F8F` | 0.44 | **Cool half of the split**: shadow hue, glass, fill light |
| `CONCRETE` | `#8F8474` | 0.52 | Roadway, plaza deck, kerb. The plane you read against |
| `SODIUM` | `#FF9A3C` | 0.66 | **Warm half of the split**: street practicals, warm key |
| `BONE` | `#CBB89A` | 0.73 | Sidewalk, trim, wood, cloth |
| `PAPER` | `#F2E8D5` | 0.91 | Road markings, newsprint highlight, UI. The reserved white |
| `HOT` | `#FF2E63` | 0.42 | Blood-ink, danger, crit. **RESERVED — enemies + damage** |
| `ACID` | `#8CFF3E` | 0.79 | Zombie flesh, toxic, spitter. **RESERVED — enemies** |
| `GOLD` | `#FFC531` | 0.79 | Points, power-ups, muzzle core. **Marks INTERACTABLES** |
| `ELECTRIC` | `#00E5FF` | 0.71 | Player energy, UI accent, shock affix |
| `RUST` | `#F4761B` | 0.55 | Fire, explosions, burn barrels |

Rules:
- **Max 2 hues per material.** Saturation stays high — no muddy desaturation ever.
- **A warm surface takes a COOL shadow.** `ground`, `walk` and `trim` shadow to `TEAL`, not to
  a darker version of themselves. This one rule is most of what turns a monochrome frame into
  a lit one, and it costs nothing.
- **`INK` is never a flat's shadow hue.** It belongs to the linework.
- **In-between values are blends, not new tokens** — `hexMix()` / `cssMix()`. The set stays small.
- **The environment lives between 0.12 and 0.78** (`READABILITY` in `palette.ts`). The darks
  below belong to ink, the brights above to practicals and enemies. See §9.
- **Gameplay-critical things own `HOT`, `ACID` and `GOLD`.** `GOLD` now means *interactable*
  and nothing else — generic street lighting is `SODIUM`, which is what freed it up.

## 2. SHADING MODEL — `InkMaterial`

Custom `ShaderMaterial` in `src/render/materials/`. Every opaque surface uses it.

1. **Cel banding.** N·L quantized to **3 bands** (lit / mid / shadow) with a *hard* terminator,
   softened by exactly ~0.02 to avoid aliasing. No smooth falloff.
2. **Halftone shadow.** The shadow band is not flat — it's filled with a **halftone dot pattern**
   in screen space, dot radius driven by light intensity, rotated 15° per material family.
   *This is the single most important signature of the style.* Dots scale with screen resolution,
   never with world distance (they're printed on the page, not on the object).
3. **Rim light.** Strong Fresnel rim in the scene's accent colour — this is what makes it read
   as AAA rather than flat. Enemies get a `HOT`/`ACID` rim so they pop out of any background.
4. **Specular = a shape, not a gradient.** Hard-clipped blobby highlight, cartoon "gleam".
5. **Ambient occlusion is painted, not computed** — vertex-baked darkening in crevices plus
   a cheap SSAO in post that is quantized to bands (never a soft grey smear).

## 3. LINES — the ink pass

Two complementary techniques, both required:

- **Silhouette:** inverted-hull backface pass on characters/props/weapons. Thickness in
  *screen space* (constant on-screen px, so distant zombies keep bold outlines).
- **Interior detail:** full-screen **depth + normal edge detection** (Sobel), producing creases,
  panel lines, and contact edges the hull pass can't see.
- **Boiling line:** outline offset is perturbed by low-frequency noise re-seeded at **12 fps**,
  not 60 — the hand-drawn wobble of animated ink. Subtle, and **line-art only** (see §4.1).
- Line colour is `INK`, but picks up a hint of the surface hue in bright areas (never pure black
  on a `HOT` surface — it reads as a colour-holds line, like real comic printing).

## 4. POST-PROCESS STACK — fixed order

Implemented in `src/render/pipeline.ts`. Order is load-bearing.

```
1. Scene render        → MRT: colour, normal, depth
2. Edge/ink pass       → composite ink lines over colour
3. Halftone/screentone → applied to shadow mask + distance fog
4. Selective bloom     → emissive only (muzzle, powerups, rim), comic "glow bleed"
5. Chromatic offset    → 2-3px RGB split at screen edges (print misregistration)
6. Colour grade        → curve + slight posterize (24 levels/channel) + saturation lift
7. Paper grain         → animated newsprint fibre + subtle CMYK dot noise, ~4% opacity
8. Vignette            → heavy, warm, plus optional PANEL FRAME during big beats
9. Overlays            → speed lines, impact flashes, damage ink splats on "lens"
```

### 4.1 THE PRINT IS FIXED. ONLY THE DRAWING MOVES. *(the most violated rule we have)*

**A comic page does not animate its own texture.** The paper does not shimmer. The halftone dots
do not crawl. The CMYK plates do not re-register every frame. Those things are *printed* — they
are nailed to the page and they never, ever move.

Build 001 broke this and the result was described by the human as "every pixel jumping like
glitching", which is exactly right and is also a motion-sickness hazard. The rules, now binding:

| Layer | Temporal behaviour | Never |
|---|---|---|
| Halftone dot lattice | **Perfectly static** in screen space | No jitter, no drift, no per-frame seed |
| Paper grain / fibre | **Static**, or re-seeded no faster than 8 fps at ≤3% opacity | Never per-frame |
| Chromatic misregistration | **Constant.** One offset per session, like one bad print run | Never animated |
| Colour grade / posterize | Deterministic per pixel value | No temporal dither |
| **Boiling line** | 12 fps, **outline geometry only**, low spatial frequency | Never a full-screen effect |

The single test: **stand still, don't touch the mouse, and the image must be frozen.** If any
pixel changes while the camera is stationary, that is a bug — not a style. All animation must
come from the camera moving or the world moving, nothing else.

**The measured bar is < 0.5% of pixels changed between consecutive frames, INCLUDING the boil.**
"The boil is sanctioned so it doesn't count" is not a defence — the human cannot see which pass
moved a pixel, only that the screen is crawling.

### 4.1.1 The boil is a HERO effect. It has a coverage budget.

The rule above was written for a sparse scene and it under-specified. In a dense city, "12 fps,
outline geometry only" still means **every window mullion, railing and wire in the frame wobbling
at once** — which measured 8.0% of the frame repainting per frame, 16× over budget, and is
precisely the "every pixel jumping like glitching" the human reported. An inker boils the hero
contour. They do not re-draw the entire background every cel.

So the boil is bounded on three axes, and all three are required:
- **Depth.** Boil amplitude falls to zero with distance. Far geometry has perfectly static lines.
- **Density.** Interior detail edges (mullions, grilles, wires, fine trim) do not boil at all —
  only silhouette and hero contours do.
- **Coverage.** The boiling line may not account for more than **~0.3%** of changed pixels.
  If it exceeds that, reduce amplitude or narrow what qualifies as a hero contour — do not
  argue the budget.

Losing the boil entirely is far better than a crawling screen. It is seasoning, not structure.

Quality tiers (`LOW / MED / HIGH / ULTRA`) drop passes in reverse order — but **1, 2, 3 are never
dropped**, because losing them loses the art direction. Better to drop resolution than style.

## 5. VFX LANGUAGE

Everything is **shapes, not soft particles.** No blurry smoke sprites — ever.

- **Muzzle flash:** hard-edged star/cross polygon, 2 frames, `GOLD` core + `HOT` fringe.
- **Impacts:** radial ink-spike burst (procedural star polygon), plus a decal that is a
  hand-drawn-looking splat mask.
- **Blood:** *ink*, not blood — `HOT` splatter shapes with drip tails, arcing in physical
  trajectories, then splatting flat onto surfaces as decals.
- **Death:** the zombie shatters into **panel shards** (flat quads with ink borders) that spin
  away and fade, plus a big word pop.
- **Onomatopoeia pop-ups:** billboarded words with 3-layer offset outlines and a jitter/pop
  animation curve — `BLAM!` `SPLAT!` `CRACK!` `KA-BOOM!` `THWACK!`. Generated to canvas at
  runtime from a bold system font stack (Impact / Arial Black / Haettenschweiler — OS fonts, not
  downloaded assets), with procedural ink-edge roughening.
- **Speed lines:** radial screen-space lines that ramp in on sprint/slide/dive and on big hits.
- **Hitstop:** 2–6 frames of time freeze on crit/kill, with a 1-frame white "flash frame"
  (the comic impact frame). Cheap, and it makes everything feel 3× heavier.

## 6. LIGHTING & COMPOSITION

All of this lives in `src/world/lighting.ts`, which is the single place the rig is decided.

- **Three-light rig, always:** warm `SODIUM`/`GOLD` key · cool `TEAL` fill · `TEAL`/`ELECTRIC`
  rim/back light. Never a single ambient wash.
- **The ambient is the floor the frame stands on**, not a garnish. `InkMaterial`'s shadow term
  is `shadowColor * (ambient + 0.55) + albedo * 0.12 + ambient * 0.55`, so the ambient colour
  decides how much of the picture falls into the void. BUILD 001 set it to a near-black violet
  and half the frame went under 0.1 luminance.
- **Volumetric god-rays and GROUND POOLS** from practical lights. The pool is the important
  half: a light that does not land on the floor cannot stage a space, and nothing in the scene
  will read as sitting on the ground.
- **Light where you want the eye.** A lamp every 20 m produces an even wash, and an even wash is
  not a composition. The arena also carries **staging pools** with no emitter — pure ground
  light on the eleven nodes of the level graph (eight street mouths, four ring corners) — so
  every junction is a bright island and the runs between them are the dark connective tissue.
  Eight lit discs receding down a 140 m street is what makes 140 m read as 140 m.
- **Fog is a colour gradient, banded** — distant geometry steps toward `NIGHT_A`, which is also
  the sky's zenith, so the backdrop recedes into the sky instead of stacking a second wall on
  it. Fog range is a property of the arena's size; `FOG_NEAR/FOG_FAR` in `lighting.ts` are
  authoritative and are fitted to the shipped 140 m block.
- **Contact is DRAWN, not shadow-mapped.** `InkMaterial` cannot receive a shadow map, so
  `key.castShadow` would cost a full depth pass of the city for zero pixels. Contact comes from
  key-aligned painted `grime` decals and from the practicals' ground pools instead — which is
  also what §2.5 asks for. The rig stays fitted and one constant (`SHADOW_CASTING`) away from
  real shadows the day the material can receive them.
- Arena readability: mid-value warm ground, cool dark walls, `SODIUM` street practicals, and
  `GOLD` reserved for **interactables and walkable routes** — the roof deck, the catwalk, the
  arcade shortcut. If it is GOLD, you can use it or stand on it.

## 7. UI / HUD LANGUAGE

Comic panel furniture, not sci-fi glass:
- Cards, badges and bubbles with **thick ink borders and hard drop shadows** (offset flat black).
- Halftone-dot fills behind numbers. Slight rotation on elements (±2°) so nothing is sterile.
- Numbers punch/overshoot when they change. Damage numbers arc out and fade.
- Boon draw = **three comic cards** dealt onto the screen with motion and a page-flip sound.
- Round start = a **full-screen title card panel** with speed-line background.

## 8. ANIMATION

- Procedural, code-driven, **snappy**: fast in, overshoot, settle. Nothing eases linearly.
- Weapon has independent layers: sway, bob, recoil kick, ADS blend, inspect. Layered, not baked.
- Zombies use procedural skeletal-ish deformation (bone-less: hierarchical mesh groups) with
  exaggerated squash/stretch and off-beat limb timing — uncanny, jerky, *drawn*.
- **Hold frames.** A pose held for 3–4 frames before a fast transition reads as animation, not
  interpolation. Use it on every impact.

---

## 9. READABILITY — enemies must be findable in a tenth of a second

A comic panel is legible because the artist decides what the eye lands on. We do the same, and it
is a *gameplay* requirement, not a taste one: in a horde shooter you must be able to count the
threats in a glance.

The rule is a **reserved channel**. Environment never gets what enemies get.

| Channel | Reserved for | Environment may NOT |
|---|---|---|
| Hue `ACID` + `HOT` | Enemies, and only enemies | Use acid green or hot pink on any large surface |
| Bright rim light | Enemies (always-on, viewer-facing) | Rim props at enemy strength |
| High-frequency motion | Enemies | Animate at all, beyond flicker |
| Heaviest ink weight | Enemy silhouettes | Match enemy outline thickness |

Practically:
- Every enemy carries a **contrasting rim in `ACID` or `HOT` that never turns off**, so a
  silhouette reads against a dark wall *and* a bright ground.
- Enemies get the **thickest outlines in the game** — thicker than any prop. The inker gives the
  character the bold line and the background the thin one. That is exactly how comics stage focus.
- The environment lives in the **middle value band**. Reserve the extremes: the darkest darks for
  linework, the brightest brights for lights and enemies.
- Test: squint at a screenshot until it blurs. The enemies must still be the first thing you see.

**The contract is code, not prose.** `READABILITY` in `src/art/palette.ts` holds the numbers
(env value band 0.12–0.78, enemy outline 8 px vs a 6 px prop cap, the reserved hues), and
`makeEnemyMaterial()` in `src/world/lighting.ts` is the recipe every enemy must be built from.
**M2 agents: use it. Do not hand-roll an `InkMaterial` for a zombie.**

Verified on the shipped BUILD 002 arena by dropping `ACID` placeholders at fourteen positions
and blurring the frame to a 48×26 grid (≈ a 16 px Gaussian):

| Background | enemy "acid" signal | strongest ENVIRONMENT cell |
|---|---|---|
| bright plaza floor (0.61) | 0.209 | **0.000** |
| inside a sodium light pool (0.75) | 0.157 | **0.000** |
| dark perimeter wall (0.27) | 0.055 | **0.000** |
| 140 m radial street, 18–42 m out | 0.014 | **0.000** |

The right-hand column is the whole point: **no cell of the environment, anywhere, in any frame,
has any green dominance at all.** The channel is genuinely reserved, so an enemy is not merely
brighter than its background — it is the only thing in the picture that is that colour.
The placeholders were removed; only the recipe ships.

## 10. MOTION COMFORT — a player must last an hour, not a minute

Nausea is a bug with the highest severity we have. Build 001 made the human dizzy in under a
minute; these are now hard limits, and they live in `CAMERA` in `src/game/tuning.ts`.

- **Lateral camera translation is the number one nausea source.** Horizontal view bob must stay
  tiny (≤1.5cm at walk) or be zero. Vertical bob is far safer than horizontal.
- **Never move and roll in the same direction at the same time.** If the camera translates right
  it must not also roll right — the cues compound into a falling sensation.
- **Roll is the second source.** Strafe lean, bob roll and pose roll summed must never exceed
  ~4° total. Any single one above 2° is suspect.
- **No un-commanded motion.** If the player holds W and nothing else, the camera must travel in a
  perfectly straight line with no lateral bias, no drift, and no rolling. Asymmetric defaults
  (e.g. a roll direction that falls back to "right" when input is zero) are bugs.
- **FOV changes must be smooth and bounded.** Fast FOV punches are a strong nausea trigger; keep
  the total range modest and the spring gentle.
- **Ship a COMFORT preset** that zeroes bob, lean, shake and FOV punch, reachable from the pause
  menu. Some players need it, and it costs us almost nothing.

### 9.1 The rim serves two jobs, and they want opposite settings

Far away the rim must **flood** the silhouette so an enemy is findable in a glance. Up close it
must **hug the edge** so the form underneath can be read. A single Fresnel exponent cannot do
both, and BUILD 007 shipped the far-field answer applied at every distance:

> The playtester: *"enemies skeletons should be more consistent and precise."*

The mesh was never the problem. The body already carried a skull, brow, jaw, hands, feet and a
torn coat, and `tools/zombie.mjs` passed on every bone. But `rimPower: 1.1` is so wide a falloff
that at melee range the term covers nearly the whole surface, and with `toneFloor: 0` and the
halftone halved to 0.4 there was nothing underneath it to see. A fully modelled corpse rendered
as a flat green mass.

**So the rim is now distance-split** (`rimPowerNear` / `rimNear` / `rimFar` on `InkMaterial`):

| | exponent | what it buys |
|---|---|---|
| ≤ 3.5 m | 3.2, ×0.85 strength | the edge reads as an edge; skull, shoulders and limbs have form |
| ≥ 13 m | 1.1, full strength | unchanged from shipped — the §9 squint contract is untouched |

Enemies also got their internal tone back: halftone 0.4 → 0.72 and `toneFloor` 0 → 0.18, so an
enemy's shadow band carries screen-tone like every other surface in the game.

**Measured squint dominance after the change:** 0.306 at 4 m, 0.198 at 8 m, against a 0.12 floor.
Beyond `rimFar` the maths is bit-identical to before, so distant findability cannot regress —
that is a property of the construction, not of a measurement.

**The general rule:** when one term is asked to serve both readability-at-range and
form-at-contact, split it by distance rather than compromising it at both.

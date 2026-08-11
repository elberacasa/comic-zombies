# UI / UX — minimap, compass, legibility, and getting the tilt off the text

> *"we should also be thinking in a minimap that displays zombies and a NORTH_EAST_WEST etc bar on
> top like most shooters? lets make our gam pro"* · *"make text better redable, some things are a
> bit blurry"* · *"what if we mde everything straight instead of to a side? i know is comic styled
> but for better UI/UX"* — the playtester

---

## 1. THE BLUR AND THE TILT ARE THE SAME BUG

The player reported these as two separate notes. They are one.

**Every persistent HUD panel is rotated.** Measured in `src/ui/hud.ts` and `src/ui/cards.ts`:

```
.cz-round   rotate(-2.2deg)      .cz-health  rotate(1.1deg)
.cz-points  rotate(1.7deg)       .cz-ammo    rotate(-1.5deg)
.cz-combo   rotate(2.4deg)       .cz-boon    rotate(1.5deg)
cards.ts    rotate(-2deg), and ±1.1/1.3deg alternating on every stat row
```

A rotated DOM element cannot rasterize its glyphs onto the pixel grid. The browser renders the
text and then resamples it along a non-axis-aligned axis, so every stem and every counter gets
subpixel antialiasing it would not otherwise have. **At 1–2° this is the worst case**: large
enough to destroy grid alignment, too small to read as a deliberate angle. It looks like blur
because it *is* blur.

**So the fix is one change that answers both complaints: take the rotation off anything that
holds text the player must read.**

### This does NOT mean abandoning the comic style

`ART_DIRECTION.md` is law and the answer is not a flat corporate HUD. The rule is:

> **The tilt moves from the TYPE to the FRAME, and from the PERSISTENT to the TRANSIENT.**

- **Persistent, readable HUD** — round, points, health, ammo, combo, prompts: **axis-aligned, 0°.**
  These are instruments. You read them mid-fight and they must be crisp.
- **The comic character stays** in the panel *borders* (hand-inked, uneven, roughened edges), the
  drop shadows (hard offset, flat INK, never a blur), the halftone fills, and the letterforms
  themselves. A straight panel with a wonky ink border still reads as a comic panel.
- **Transient beats keep their kinetics** — damage popups, onomatopoeia, hit markers, the round
  title card. These are *drawings*, not instruments; they are on screen for under a second and
  nobody reads them character by character. Their rotation is the style working correctly.

The distinction to apply: **is the player reading it, or feeling it?** Reading → straight.
Feeling → keep it comic.

### Other legibility items in the same pass

- `letter-spacing: .2em` on `.72rem` Impact is too tight a size for that much tracking — small
  labels lose word shape. Reduce tracking as size drops.
- Avoid `transform: scale()` on live text for the same rasterisation reason; scale the container
  or use font-size steps.
- Ensure panel backgrounds carry enough contrast against a bright arena — the value ladder in
  `ART §1` applies to UI too. Check the HUD against the worst case (standing on lit CONCRETE).
- Pixel-snap panel positions (integer px) so borders land on the grid.

---

## 2. THE MINIMAP

*"a minimap that displays zombies"*.

### What it must do
- Show the player at the centre, with a facing indicator.
- Show **live zombies as dots**, and make specials distinguishable — the Screamer is a
  priority target and `ART §9` reserves `HOT` for exactly that read. A player who can see a HOT
  dot on the minimap can go kill it. This is a genuine gameplay upgrade, not decoration.
- Show the arena's walkable shape so the dots have context.
- Rotate with the player (heading-up) — standard for shooters and easier to act on than north-up.

### How to build it, given this codebase
- **Canvas 2D, drawn once per frame into one `<canvas>`**, composited by the HUD. Do NOT create a
  DOM element per zombie: at 28 alive that is 28 style recalcs a frame and it will hitch exactly
  the way the HUD's WAAPI churn already did.
- The arena outline is **baked once** at boot into an offscreen canvas (the arena is static), then
  blitted each frame with a rotation. Only the dots are redrawn.
- Dots come from `ctx.enemies` — read positions, do not allocate. Reuse a scratch array.
- Draw at a **fixed device-pixel size** and let CSS size it, so it stays crisp at any DPR. This is
  the same trap as §1: never CSS-scale a rendered canvas.
- Style: a comic panel — heavy ink border, halftone or paper fill, flat colour dots with hard ink
  outlines. It should look drawn, not like a radar from a mil-sim.
- **Budget: it is a full-screen-composited element that redraws every frame. Keep it small
  (~160 px), skip the redraw when paused, and allocate nothing per frame.**

### Reserved-hue discipline
`ACID` and `HOT` are reserved for enemies (`ART §9`) — which is *exactly right* for a minimap:
ordinary zombies `ACID`, specials `HOT`, player in a UI hue (`ELECTRIC`), pickups `GOLD`. The
palette already encodes the semantics; use it rather than inventing minimap colours.

---

## 3. THE COMPASS BAR

*"a NORTH_EAST_WEST etc bar on top like most shooters"*.

- A horizontal strip at the top centre, showing the cardinal and intercardinal points
  (N · NE · E · SE · S · SW · W · NW) scrolling as the player turns, with the current heading
  under a centre tick.
- Same canvas-based, DPR-correct approach as the minimap — text on a rotating/scrolling strip is
  precisely where blur creeps back in. Draw the letters axis-aligned; scroll their *positions*,
  never rotate the glyphs.
- This is also where objective markers eventually live (a wall-buy you are heading for, the
  mystery box's current location once it can move). Design the data path for that now even if
  nothing uses it yet — a compass with nothing to point at is decoration; a compass that tells you
  where the box went is a mechanic.
- Keep it thin and low-contrast enough not to fight the crosshair.

---

## 4. ORDER OF WORK

1. **De-tilt + legibility pass** — cheapest, fixes two reported complaints at once, touches only
   existing CSS in `hud.ts` / `cards.ts`. Do this first.
2. **Compass bar** — smaller and simpler than the minimap, and shares the canvas/DPR machinery
   the minimap will need.
3. **Minimap** — built on that machinery.

All three are `src/ui/**` only. None of them should touch gameplay, and none may allocate in a
per-frame path.

## 5. THE GATE

- `npx tsc --noEmit` clean, `npm run build` succeeds.
- No new per-frame allocation (this codebase measures heap growth; keep it at zero).
- Draw calls unchanged — the HUD is DOM/canvas, not scene geometry.
- Minimap + compass together must not cost more than ~0.3 ms/frame.
- **The human judges whether it looks right.** Do not spend tokens screenshotting.

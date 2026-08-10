# M2 — VERTICAL SLICE: THE FEEL

The milestone where the human finally has something to *play*. One gun, one zombie, and enough
juice that shooting it feels better than most shipped shooters. Breadth comes in M4; this is depth.

> **The bar:** if the human sprints, slides, and headshots a zombie mid-slide, that single
> two-second sequence should be good enough that they immediately do it again.

Everything here builds on `src/core/types.ts` (frozen contracts) and `src/core/events.ts`
(the typed bus). Nothing in this milestone may import another game system directly.

---

## 1. THE WEAPON — `inkslinger` (starter pistol)

Semi-auto, infinite reserve, precise, rewards headshots. It's the gun the human will judge
gunplay on, so it has to be perfect before any other weapon exists.

### The firing chain — every link must be felt
```
input.pressed(fire)
  → fire-rate gate (rpm, semi-auto edge only)
  → deduct ammo, advance shotIndex
  → build the ray: eye + lookDir, spread cone from state (hip/ads/moving/airborne)
  → enemy raycast first, then world raycast; nearer wins
  → damage: base × falloff(distance) × part multiplier × stats.damageMult
  → apply recoil: camera kick channel + weapon-model kick + the deterministic pattern
  → emit weapon:fired, hit:enemy or hit:world
  → VFX/audio/HUD react purely off those events
```

### Feel requirements (non-negotiable)
- **Zero input latency.** Fire on the input edge in `update`, never buffered a frame.
- **Deterministic recoil pattern** from `WeaponDef.recoilPattern`, indexed by `shotIndex`.
  Learnable = skill. Random spray = luck. Recovery is a spring back toward the pre-fire angle,
  but only the portion the player didn't manually correct (the CoD "recoil recovery" trick).
- **Camera kick and weapon kick are separate layers** with different stiffness. The weapon model
  moves more and recovers slower than the camera.
- **ADS** blends position, FOV and spread on a curve, not a lerp. `adsTime` from the def.
- **Active reload** (GAME_BIBLE §3): a bar sweeps; tapping R inside `activeReloadWindow` finishes
  ~40% faster and grants a 3s damage buff. Missing it adds a small stumble. This is the pistol's
  skill expression — get the window generous enough to learn and tight enough to matter.
- **Hitstop on crits and kills** — 2–6 frames via `ctx.time.hitstop()`. This is the single
  cheapest way to make impacts feel heavy.
- **Every shot varies:** pitch, muzzle scale, shell ejection angle. Never the exact same frame
  twice. But per `ART §4.1`, none of that variation may animate while the player is idle.

### The viewmodel
Procedural comic geometry (`art/shapes.ts`), heavily stylised — chunky, exaggerated, readable in
silhouette. Layered animation, all code-driven, all summed:
`idle sway` + `walk bob` (opposed to the camera bob, never in phase — see `ART §10`) +
`recoil kick` + `ADS blend` + `reload routine` + `inspect`.
Held at a low FOV so it doesn't distort. Gets the heaviest outline weight of any non-enemy object.

---

## 2. THE ENEMY — Shambler

Slow, relentless, melee. The mass of the horde. Must be **kite-able**: the classic Zombies skill
is training a horde into a conga line, and that only works if movement is readable and predictable.

### Body
Procedural, hierarchical mesh groups (no skeleton): pelvis → torso → head, plus 4 limbs.
Exaggerated proportions, asymmetric silhouette, seeded per-instance variation so no two are twins.
**Per `ART §9` it carries the reserved channels: `ACID` flesh, an always-on enemy-grade rim, and
the heaviest ink weight in the game.** It must read instantly against a bright ground, a lit wall,
the sky, and a dark alley.

### Animation — jerky and *drawn*, not smooth
Procedural, driven by a gait phase. Squash/stretch, off-beat limb timing, **hold frames**
(`ART §8`): pose held 3–4 frames, then a fast transition. Smooth interpolation is the enemy —
we want the uncanny stop-motion of animated ink.

### AI
Steering, not pathfinding: `seek(player)` + `separation(neighbours)` + `wallAvoid` via
`ctx.world.steer()`. Clumping is a feature — it makes the horde flow readably and makes kiting
work. States: `spawn → chase → attack → stagger → death`. Attack telegraphs with a wind-up pose
long enough to slide out of.

### Hit reactions — this matters more than HP
Every bullet produces: flinch (additive pose impulse), directional stagger, ink spray, a floating
damage number, and a hitmarker. Limb shots can dismember with clean comic cuts. Death is a
**panel shatter** (`VfxService.panelShatter`) plus a word pop. A zombie that absorbs a bullet
without visibly reacting is a bug.

---

## 3. VFX — implement `VfxService` for real

Replace the stub. Every method pooled, zero per-frame allocation:
`impact` · `muzzleFlash` · `tracer` · `inkSplatter` · `panelShatter` · `wordPop` ·
`damageNumber` · `explosion` · `shake` · `dust`

Per `ART §5`: **shapes, not soft particles.** Hard-edged star bursts, flat panel shards,
billboarded word pops from `art/letters.ts`. Blood is *ink*: `HOT` splatter arcs that land as
decals. Decals live in a fixed-size pool that recycles oldest-first.

---

## 4. AUDIO — implement `AudioService` for real

100% WebAudio synthesis, zero samples. Recipe-based one-shots in `audio/synth.ts`:
gunshot (noise burst + pitched body + tail), impact per `SurfaceKind`, flesh hit, crit
(distinct and satisfying), reload clicks, active-reload success chime, footsteps per surface,
zombie groans (spatialized, pitch-varied), death, ambient horde bed.
Pitch and filter vary per instance. Spatialized via `PannerNode` from `ctx.player.eye`.
Ducking on hitstop. Must start only after a user gesture (autoplay policy).

---

## 5. HOOKING IT UP

`src/game/stubs.ts` currently holds no-op implementations of `weapons`, `enemies`, `vfx`,
`audio`, `rounds`, `boons`. M2 replaces the first four with real systems, registered in
`main.ts` in the documented order. `rounds` and `boons` stay stubbed until M3 — but M2 should
spawn a handful of zombies on a debug key so the human can fight them.

---

## 6. ACCEPTANCE — measured, not vibes

| | Target |
|---|---|
| `tsc` / `vite build` | clean |
| Draw calls / triangles | ≤ 350 / ≤ 900k **with 25 zombies alive** |
| Heap growth over 60s of combat | ~0 (everything pooled) |
| Stillness test (`ART §4.1`) | < 0.5% pixels changed, camera parked |
| Straight-line test (`ART §10`) | zero lateral drift, zero roll on pure W |
| Input → muzzle flash | same frame |
| Enemy squint test (`ART §9`) | zombies are the first thing visible in a blurred screenshot |

---

## 7. WHAT THE HUMAN WILL BE ASKED TO JUDGE

Written into `docs/PLAYTEST.md` as BUILD 003:
1. Does the gun feel good? Weight, kick, rate, recoil recovery.
2. Is the active reload fun or annoying? Is the window fair?
3. Do zombies read instantly? Can you always find them?
4. Do hits feel like they connect? Is hitstop too much, too little, right?
5. Can you kite a group, or do they clump wrong / spread wrong?
6. Is the slide-into-headshot sequence satisfying enough to repeat?
7. Still comfortable after 10 minutes? (The comfort regression check.)

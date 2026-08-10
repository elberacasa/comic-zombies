# GAME BIBLE — Comic Zombies

The design source of truth. Mechanics only; the look lives in `ART_DIRECTION.md`.

---

## 0. One-line pitch

*A comic book explodes and you're inside it.* Survive endless waves of ink-drawn undead in a
compact arena, chaining slides and headshots, spending blood-money on absurd boons that stack
into broken builds — until the horde finally inks you out.

## 1. The core loop

```
ROUND STARTS  →  horde spawns (count & speed scale)  →  you kite, shoot, chain kills
      ↑                                                          ↓
      └──  pick 1 of 3 BOONS  ←  spend POINTS on walls/box/perks  ←  ROUND CLEARED
```

Session target: 20–40 minutes to a deep round. Death is permanent per run (roguelite run
structure), but the run *ends* with a stat screen and a "best round" chase.

**The addiction engine:** every round the player makes 2 decisions (which boon, what to spend on)
and both compound. By round 15 no two runs look alike.

---

## 2. MOVEMENT — where the skill ceiling lives

This is the single most important system for feel. It must be *fast, weighty and expressive*.

| Mechanic | Description | Skill expression |
|---|---|---|
| **Sprint** | Hold shift. Accelerates over 0.25s, slight FOV punch, weapon lowers. | — |
| **Slide** | Crouch while sprinting. Preserves momentum, decays over ~0.7s. Lowers hitbox. | Slide under swings, slide around corners into a shot |
| **Slide-cancel** | Jump out of a slide in its first 0.35s → keeps most speed, resets sprint. | Chained = the fastest way to travel. THE core tech. |
| **Bunny-hop / air-strafe** | Air control uses source-style strafe accel: turning while holding a strafe key adds speed up to a cap. | Chain hops to outrun the horde |
| **Dive** | Sprint + crouch-hold = dolphin dive. Long commit, invulnerable frames on landing roll. | High-risk escape from a surround |
| **Mantle / vault** | Auto-vault waist-high geometry when moving into it; ledge-grab on chest-high. | Arena is built as a parkour lattice |
| **Ground pound?** | *(post-M4 stretch)* slam from height, ink shockwave. | — |

Rules:
- **Momentum is never hard-stopped** except by walls. No sticky friction.
- Air control tuned so a skilled player is ~35% faster than a walker across the arena.
- Every movement state change fires a comic VFX beat (dust puff, speed lines, "WHOOSH").
- All values in `src/game/tuning.ts` under `MOVE`.

## 3. GUNPLAY

**Hitscan** with per-shot raycast, damage falloff by range, and a **learnable recoil pattern**
per weapon (deterministic, seeded — mastering the pattern is skill, not luck).

- **ADS** (right mouse): tighter spread, slower movement, FOV zoom, comic "focus" vignette.
- **Hip-fire** has a real, usable cone — kiting demands it.
- **Headshots** = crit: 2.5× damage, distinct SFX, big "CRACK!" popup, extra points.
- **Limb shots** can dismember (comic-clean cuts, no gore realism — ink splatter).
- **Active reload:** a thin bar sweeps during reload; tapping R in the sweet spot finishes it
  ~40% faster and grants a 3-second damage buff. Missing it adds a small stumble. *High ceiling.*
- **Weapon inventory:** 2 slots, fast swap, cancel-reload-with-swap tech.

### Weapon archetypes (M2 ships one, M4 ships the set)
| Id | Archetype | Identity |
|---|---|---|
| `inkslinger` | Pistol (starter) | Infinite reserve, precise, rewards headshots |
| `ratatat` | SMG | High RPM, wild vertical climb, hip-fire king |
| `boomstick` | Shotgun | 8 pellets, one-shot cone, the panic button |
| `longshot` | Marksman rifle | Pierces 3 zombies in a line, huge crit |
| `thumper` | Grenade launcher | Arcing, splash, self-knockback for movement tech |

**Pack-a-Punch (upgrade station):** spend big points → weapon gets a comic-ified upgraded form,
new name, +damage, +mag, and an **elemental affix** (shock chain / flame DoT / ink-blind).

## 4. ENEMIES

All must be *kite-able* — the classic Zombies skill of training a horde into a conga line.
AI is steering-based (seek + separation + wall avoidance), not rigid pathfinding, so the horde
flows and clumps readably.

| Enemy | Role | Behaviour |
|---|---|---|
| **Shambler** | The mass | Slow, relentless, melee. Speed scales per round. |
| **Sprinter** | Pressure | Fast bursts, low HP, breaks your kite rhythm. |
| **Brute** | Wall | Huge HP, armor plates that must be shot off, slow heavy swing that breaks your slide. |
| **Spitter** | Zoner | Ranged ink glob, creates a slowing puddle — denies your kite lane. |
| **Screamer** | Threat | **SHIPPED.** Never swings. Holds at 9 m, telegraphs a 2.6 s wind-up, and a completed scream calls 4 more bodies from the arena's own spawn ring. Staggering it cancels the call outright, so shooting it is a real answer rather than a race against a timer. Tall (2.23 m vs 1.84 m) and `HOT`-hued so it can be picked out of a crowd — you cannot ask a player to prioritise a target they cannot see. |

**A KIND IS A BEHAVIOUR, NOT A STAT BLOCK.** `sprinter`, `brute` and `spitter` shipped as
`{...SHAMBLER, health, speed}` — one body, one AI, different numbers — which is not variety, it is
the same fight at a different length. `EnemyDef.role` now branches the state machine, and
`bodyScale` gives a kind its own silhouette on top of the per-instance roll. A special the player
cannot identify at a glance cannot be prioritised, and an enemy that only changes how long it
takes to die does not change how the game is played.

**Hit reactions matter more than HP:** every bullet must produce flinch, ink spray, a floating
damage number, and a directional stagger. Death = comic explosion of ink and panel shards.

## 5. ECONOMY & PROGRESSION

- **Points** on hit (10), kill (60), crit kill (100), multi-kill bonus, no-damage round bonus.
- **Combo meter:** consecutive kills within 3s ramp a multiplier (×1 → ×5). Taking damage resets it.
  Drives aggressive play. Displayed as a comic "COMBO x4!!" badge.
- **Spend on:** wall-buy weapons/ammo, perk machines, mystery box (gacha, price ramps), doors
  (open new arena zones — the arena grows as you get richer), Pack-a-Punch.

### BOONS (the roguelite layer — our signature twist)
End of each round: choose **1 of 3** from a comic "card draw". They stack multiplicatively and
are intentionally build-defining, some are *broken on purpose*.

Sample tiers:
- **Common:** +12% fire rate · +20 max HP · +15% reload speed · +1 slide charge
- **Rare:** headshots refund 1 bullet · kills drop health ink · slide deals contact damage
- **Epic:** every 5th shot is an explosive round · crits chain lightning to 2 nearby
- **Legendary:** *Panel Break* — killing 10 zombies in 3s freezes time for 2s ·
  *Double Vision* — every gun fires a ghost second bullet at 50% damage ·
  *Ink Pact* — you have 1 HP but 4× damage and 1.5× speed

Boons apply to a `PlayerStats` block via a modifier stack — never hardcoded into systems.

### POWER-UP DROPS
Random from kills, comic-glowing floating icons: **MAX AMMO**, **DOUBLE POINTS**, **INSTA-KILL**,
**NUKE** (screen-wide "KA-BOOM!" panel), **CARNAGE** (30s infinite ammo + no reload).

## 6. ROUND / DIRECTOR

- Round N spawn count `≈ 6 + N * 2.2` (capped by a live-enemy cap of ~28 for perf).
- Zombie HP scales, then speed scales, then composition shifts (specials introduced at set rounds).
- Spawn director picks spawn points **out of the player's view** and away from their kite path.
- Round transitions are a *beat*: horde silence, comic title card "**ROUND 7**", boon draw, then drop.
- Every 5th round: **BOSS-ISH SURGE** — mixed specials, arena hazard, doubled rewards.

## 7. FAIL STATE & META

- Down state before death (Zombies-style): crawl for 8s, self-revive if you have the boon.
- Death → run summary panel (comic back-cover style): rounds, kills, best combo, boons taken.
- Persistent meta (localStorage): best round, total kills, unlocked boon pool.

---

## 8. FEEL CHECKLIST (apply to every mechanic we build)

Every action must have: **anticipation → impact → aftermath.**

- [ ] Screen shake scaled to impact, with recovery curve
- [ ] Hitstop (2–6 frames) on crits and kills
- [ ] Camera kick + weapon kick as separate layers
- [ ] A distinct synthesized sound with pitch variation (never the exact same sample twice)
- [ ] A comic VFX beat (ink spray, popup word, speed lines, panel flash)
- [ ] Controller/mouse response < 1 frame of input lag; no input buffering delay on fire

---

## 8.5 THE PITCH, IN THE AUTHOR'S WORDS

> "this games goal is to be a competitive game very addictive with infinite rounds and crazy
> leaderboard achievments, including co op later and multiplayer pvp maps with capture the flag
> etc, **comic COD** in other words, **modern warfare 2 inspired with bo2 zombies combined**"

That reference pair is the most useful design statement in this document, because the two halves
pull in different directions and knowing which wins settles most arguments:

- **BO2 Zombies** gives the *structure*: infinite rounds, a points economy, training a horde,
  a run that ends and is scored. This is what exists today and the playtester has confirmed it is
  addictive.
- **MW2** gives the *feel*: fast, precise, weighty gunplay, and a movement kit with a real skill
  ceiling. Competitive-grade responsiveness, not survival-horror sluggishness.

**Where they conflict, MW2 wins on feel and BO2 wins on structure.** A zombie should be a BO2
zombie in what it does and an MW2 target in how it responds to being shot.

**"Competitive" is the load-bearing word.** It means the game is judged on *consistency*: a stable
frame rate, a stable image, deterministic recoil, no random damage, and no visual instability that
could cost a player a run they were about to record. Anything that varies without the player
causing it is a bug — this is the same principle as ART §4.1, applied to performance rather than
to the print.

**Leaderboards make determinism a feature, not a nicety.** A run worth putting on a board is a run
that can be verified, and a seeded deterministic simulation (`§9.3`) is what makes that possible —
the same property co-op and PvP need later. Nothing may break it.

---

## 9. THE LONG ARC — where this is going

Recorded so that decisions made now don't foreclose it. Order is deliberate; each step should be
cheap *because* of the one before it.

```
Comic Zombies       →  more MAPS   →  more STYLES  →  CO-OP        →  PvP
one arena, one style   same style,    same maps,      same rounds,    same maps,
                       new geometry   new palette     more players    CTF and modes
```

Co-op comes before PvP deliberately: it reuses the round loop wholesale and only adds networking,
whereas PvP needs new modes, new balance and new maps on top of the same networking.

### 9.1 More maps
The arena is ~2,500 lines of procedural construction in `world/arena.ts`, with its kite loops,
spawn ring and nav graph derived from it automatically. A second map is therefore *content*, not
engineering — but only if the couplings stay honest. Anything that reads arena geometry must keep
doing so through `WorldService` and the nav graph, never through hardcoded coordinates.

**Test of readiness:** a new map should require zero changes to `game/`.

### 9.2 More styles
The palette is already a locked token set with a documented value ladder, and materials ask for
tokens rather than colours. A "style" is therefore a palette + a material recipe set + a light
rig — swappable without touching geometry. This is the same insight the asset-generator work is
built on: *a generator asks for a role, not a colour.*

**Test of readiness:** the same arena renders in a second style with no geometry edits.

### 9.3 Multiplayer — and what it demands of us NOW

Long way off. But it imposes one constraint that is far cheaper to keep than to retrofit:

> **THE SIMULATION MUST STAY DETERMINISTIC.**

We already have the hard part — a fixed-timestep sim (`FIXED_DT`), a seeded RNG, and gameplay
strictly separated from presentation. That is precisely the foundation rollback or lockstep
netcode needs, and it exists today by accident of good hygiene rather than by plan. From here it
is a **product requirement**, not a testing convenience:

- Gameplay lives in `fixedUpdate`, presentation in `update`. Never blur that line.
- No `Math.random()` or `Date.now()` in simulation. Seeded RNG only, forked per system so one
  system's draws can never perturb another's sequence.
- No gameplay decision may depend on frame rate, wall-clock time, or render state.
- Iteration order over collections must be stable.

Breaking determinism is the one mistake here that costs a rewrite instead of a refactor.

**Modes, when it comes:** the arena and the movement kit are the product; zombies are one mode
played in them. Deathmatch and an extraction/objective mode both reuse the same maps, weapons and
movement. The enemy system becomes *a* participant type rather than *the* participant type.

**Test of readiness:** two clients stepping the same seed and the same input stream land on
bit-identical state. Worth writing that harness long before there is any networking.

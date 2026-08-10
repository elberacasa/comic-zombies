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
| **Screamer** | Threat | Doesn't attack; if it screams it summons a mini-wave. Kill on sight. Priority-target training. |

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

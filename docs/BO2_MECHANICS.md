# WHAT BLACK OPS 2 ZOMBIES ACTUALLY DID — and which parts we steal

The playtester's brief: *"try to compare and find out how cod bo2 zombies worked and copy top
mechanics"*, toward *"comic COD — MW2 feel, BO2 Zombies structure"* (`GAME_BIBLE §8.5`).

This file is the **spec**, not a history lesson. Every section ends with a verdict: what we take,
what we already have, and what we deliberately skip. Ordered by how much each one would add to
*this* game right now.

---

## 0. The single most important thing BO2 got right

**The round is a contract, and the player's skill is expressed between rounds, not inside them.**

Every round is the same shape — bodies spawn, you train them, you clear them — so the player's
attention goes to the *meta* decisions: what to buy, when to open a door, whether to hit the box
again or save for Pack-a-Punch. The tension is economic, not mechanical.

**We have the round loop and it is confirmed addictive.** What we do not have is a single
decision to spend points on. That is the gap, and it is why the economy sections below outrank
everything else.

---

## 1. THE POINTS ECONOMY — the thing we are missing entirely

### How BO2 did it

| Action | Points |
|---|---|
| Bullet hit | 10 |
| Kill | 60 |
| Headshot kill | 100 |
| Knife kill | 130 |
| Round survived | small bonus |

The genius is that **hits pay**. You are paid for shooting a zombie you do not kill, which means
a low-damage weapon is an *income* weapon. Players deliberately shot zombies with a weak gun to
farm points, then knifed for the kill. That is a strategy the economy *taught* them, not one the
designers scripted.

**Costs, roughly:** wall weapon 500–1500 · wall ammo ~half the weapon · Mystery Box 950 ·
Perk 2000–4000 · Pack-a-Punch 5000 · doors 750–1250.

**Verdict: WE HAVE THE INCOME, NONE OF THE SINKS.** `PlayerService` has `addPoints()` and
`points` and **no `spend()` at all**. ~4,400 points earned in round 1 with nothing to buy is the
biggest structural hole in the game. Everything in §2–§5 depends on adding `spend()` first.

### 1.1 What to build, in order

1. **`spend(amount): boolean`** on `PlayerService` — atomic, returns false if unaffordable, emits
   an event either way so the HUD can play a "can't afford" beat. This is the foundation.
2. **Wall-buys** — the weapon on the wall, bought and re-ammoed at a fixed price.
3. **Mystery Box** — the gacha.
4. **Perks** — the permanent upgrades.
5. **Pack-a-Punch** — the damage cliff that makes round 25 survivable.

---

## 2. WALL-BUYS — the first sink, and the one that teaches the economy

### How BO2 did it

A weapon silhouette is chalked on a wall with a price. Hold ✱ to buy. Once you own it, the same
wall sells **ammo** for roughly half the weapon's price — so a wall-buy is not a one-time
purchase, it is a **supply line you plan your route around**. Training near a wall-buy you can
afford is a real tactical decision.

The chalk drawing is deliberately crude and readable from across the map.

**Verdict: TAKE IT WHOLESALE, AND THE CHALK IS FREE FOR US.** A chalk-outline weapon silhouette
is *exactly* our art direction — we already draw ink outlines and halftone; a chalked gun on a
wall is the cheapest possible asset and the most on-style. `WeaponDef` already carries `buyCost`
and `ammoCost`, unused.

**Design for us:**
- 4–6 wall spots around the arena, each selling one weapon, spread so no single training loop
  passes all of them.
- Price ladder from the existing defs: ratatat 1200 · boomstick 1500 · longshot 2000.
- Ammo at ~half. Buying ammo when you already hold the gun is the common case — make that the
  fast path, one keypress, no menu.
- The prompt must be readable mid-train: you are being chased when you buy.

---

## 3. PERKS — the biggest power spike in BO2, and the most copyable

Perk machines are permanent-until-death upgrades bought with points. In BO2 the important ones:

| Perk | Cost | What it does | Why it matters |
|---|---|---|---|
| **Juggernog** | 2500 | ~2.5× effective health | THE perk. Turns 2-hit-down into 5-hit-down. Everyone buys it first, every game. |
| **Speed Cola** | 3000 | ~2× reload speed | Reload is the moment you die. |
| **Double Tap II** | 2000 | ~2× fire rate AND double bullets | Enormous real DPS. |
| **Quick Revive** | 500 solo | Self-revive once | Solo insurance. |
| **Stamin-Up** | 2000 | Faster/longer sprint | Mobility = survival when training. |
| **Mule Kick** | 4000 | A third weapon slot | Pure inventory. |
| **PhD Flopper** | 2000 | No self-damage, dive causes explosion | Enables explosive playstyles. |

**The design lesson is the ORDER.** Juggernog is so dominant that "how fast can I get Jug" is the
opening of every BO2 game. That is a *good* thing: it gives round 1–5 a clear goal. A run has a
shape because the first 2500 points have an obvious destination.

**Verdict: TAKE IT — BUT WE ALREADY HAVE A ROGUELITE LAYER, SO BE CAREFUL.**

We have **boons** (26 of them, drawn 3-at-a-time between rounds, stacking multiplicatively). Boons
are our signature twist and they already occupy the "permanent upgrade" niche. Bolting BO2's
seven perks on top would create two parallel upgrade systems competing for the same design space.

**The resolution:** perks are the **bought, reliable, known** upgrades; boons are the **drawn,
random, build-defining** ones. You buy Juggernog because you decided to; you get *Ink Pact*
because the cards gave it to you. Keep perks few, boring and load-bearing — health, reload, speed
— and let boons stay the exciting ones. **Ship 4 perks, not 7:**

- **INK GUT** (Juggernog) — the health one. Non-negotiable, it gives the early game its goal.
- **QUICK INK** (Speed Cola) — reload speed.
- **DOUBLE INK** (Double Tap) — fire rate.
- **LONG LEGS** (Stamin-Up) — sprint, because our movement kit is the skill ceiling.

Perk machines should be physical objects in the arena you walk to, not a menu — the walk is the
cost, and it puts you somewhere on the map at a specific time.

---

## 4. THE MYSTERY BOX — the best risk/reward loop in the genre

### How BO2 did it

950 points. A glowing box opens, a weapon spins, you get **a random gun** — possibly the
Ray Gun, possibly a pistol you already have. The box **teleports to a new location** after a
random number of uses (announced by a teddy bear and a music sting), so you can lose access to it.

Why it is so strong:
- **It is a slot machine with a real cost**, and the loss condition (wasting 950) is felt.
- The teleport creates urgency: hit it again now, or lose it?
- The best weapons in the game are *only* available here, so there is no substitute.

**Verdict: TAKE IT, INCLUDING THE MOVE.** This is the single most addictive mechanic in BO2 and
it costs us almost nothing to build — a box prop, a spin animation, a weighted draw from
`WEAPON_DEFS`, and a relocate. The spin is a comic beat: cards riffling, a "!!" panel, a big
onomatopoeia when it lands.

The move is what makes it a *decision* rather than a vending machine. Keep it.

---

## 5. PACK-A-PUNCH — the damage cliff that makes deep rounds possible

5000 points upgrades your weapon: more damage, bigger magazine, a new name, a camo. Without it,
zombie health scaling makes round 25+ mathematically unkillable. With it, the run continues.

**It is not a nice-to-have — it is the thing that decides where the run ends.** BO2's health curve
is the same compounding curve we already implement (`roundHealth()` matches the CoD recurrence,
verified by `tools/combat.mjs`), so we have the same wall coming.

**Verdict: TAKE IT, AND WE HAVE MOST OF IT.** `UPGRADE` and `upgradedDef()` already exist in
`weapons/defs.ts`, along with `WeaponAffix` ('shock' | 'flame' | 'ink') and
`WeaponService.upgrade(slot, affix)`. The system is built and unreachable. It needs a machine in
the world, a price, and the comic-ified renamed weapon.

The affixes are already the right idea: shock chain / flame DoT / ink-blind, per `GAME_BIBLE §3`.

---

## 6. TRAINING — the core skill, and the one we already nailed

BO2 zombies path toward the player and clump. The skill is **training**: gathering the horde into
a conga line and running a loop, mowing them down as they string out behind you. Every good BO2
map is designed around 2–3 viable training loops.

Zombies in BO2 do **not** get knocked backwards by bullets. They flinch, they stumble in place,
they lose limbs — but the pressure never lets up. Positional knockback would make trains
unpredictable and break the whole skill.

**Verdict: WE ALREADY HAVE THIS AND IT IS CONFIRMED GOOD** — the playtester said *"i like how
zombies behave"*. Steering-based AI, conga relief, follow-the-leader. **And the knockback note is
exactly the bug they just reported** ("they feel weird moving back when shot"), which is being
fixed now. BO2 agrees with the playtester.

---

## 7. THE ROUND BEAT AND THE MOOD

BO2's round transition is a *silence*, then the round number, then the distant groan of the next
wave. The dog rounds (every ~5 rounds) break the rhythm deliberately.

**Verdict: WE HAVE THE BEAT** (title card, `clearSilence`, surge every 5 rounds). The surge round
is our dog round. Consider giving the surge a distinct *sound* and *colour* the way BO2 gave dogs
lightning and fog — a round that looks different is a round you remember.

---

## 8. WHAT WE DELIBERATELY DO NOT COPY

- **Buildables / Easter eggs / elaborate quests.** BO2 (Tranzit, Origins) leaned hard on multi-step
  secret quests. Enormous content cost, tiny fraction of players ever saw them. Skip.
- **The bus / Tranzit's map traversal.** Interesting, widely disliked. Skip.
- **Downed-state crawling in solo** beyond what we have. We already have a down state.
- **Weapon camos as progression.** Cosmetic meta belongs after launch, not before.
- **Literal BO2 asset names.** Everything is renamed into our own comic register — INK GUT, not
  Juggernog. This is our game, not a clone, and using their names is both lazy and legally silly.

---

## 9. THE ORDER WE BUILD IT

1. `PlayerService.spend()` — nothing else is possible without it.
2. **Wall-buys** — makes points mean something and makes the three new guns obtainable, which is
   currently blocking the whole arsenal from being playtested in normal play.
3. **Mystery Box** — the addiction engine, including the relocate.
4. **Perks** (4 of them) — gives the early game a goal.
5. **Pack-a-Punch** — mostly wiring an existing system to a machine and a price.

Each of these ends in a playable build. None of them requires new art beyond chalk outlines, a
box, and machine props — all of which are on-style and cheap for a procedural pipeline.

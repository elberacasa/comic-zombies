/**
 * STAT EFFECTS — the generic behaviour behind four `PlayerStats` fields that no other system
 * had claimed: `lifestealPerKill`, `slideDamage`, `explosiveChance` and `chainChance`.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *  THIS FILE CONTAINS NO BOON IDS, AND THAT IS THE POINT.
 *
 *  GAME_BIBLE §5: "Boons apply to a `PlayerStats` block via a modifier stack — never hardcoded
 *  into systems." So the reverse also has to hold: a system that reacts to a stat must react to
 *  the NUMBER, not to the card that raised it. Everything below reads `ctx.player.stats.x` at
 *  the moment of the event and does the same thing whether that x came from Boom Shot, from a
 *  power-up, or from a Pack-a-Punch affix that does not exist yet.
 *
 *  It lives under `game/boons/` because the boon layer is the only thing that raises these
 *  numbers today. If weapons or powerups ever want to own explosive/chain, this file is one
 *  `dispose()` away from being deleted — nothing imports it but `./service.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * COUPLING: every capability used here is a `core/types.ts` interface (`EnemyService`,
 * `PlayerService`, `VfxService`) or an event. No game system's implementation is imported.
 *
 * ALLOCATION: zero per event. Two `DamageInfo` blocks, four scratch vectors and one target
 * array, all module-level, all reused. `enemies.damageSphere` copies out of the info block we
 * hand it, so a shared block is safe.
 *
 * RE-ENTRANCY: `damageSphere` and `takeDamage` both emit `hit:enemy`, and we listen to
 * `hit:enemy`. Without the `busy` latch a Boom Shot inside a Boom Shot is a stack overflow that
 * only reproduces at high round with three stacks. The latch is not an optimisation.
 */

import { Vector3 } from 'three';
import type {
  DamageInfo, Damageable, GameCtx, PlayerStats,
} from '@/core/types';
import { BOON_TUNING } from './defs';

const E = BOON_TUNING.effects;

const _blastInfo: DamageInfo = {
  amount: 0,
  point: new Vector3(),
  normal: new Vector3(0, 1, 0),
  direction: new Vector3(0, 0, -1),
  part: 'torso',
  isCrit: false,
  knockback: 1,
};

const _chainInfo: DamageInfo = {
  amount: 0,
  point: new Vector3(),
  normal: new Vector3(0, 1, 0),
  direction: new Vector3(0, 0, -1),
  part: 'torso',
  isCrit: false,
  knockback: 0.4,
  affix: 'shock',
};

const _slideInfo: DamageInfo = {
  amount: 0,
  point: new Vector3(),
  normal: new Vector3(0, 1, 0),
  direction: new Vector3(0, 0, -1),
  part: 'torso',
  isCrit: false,
  knockback: 1.2,
};

const _p = new Vector3();
const _q = new Vector3();
const _slideCentre = new Vector3();
/** Reused query buffer. `EnemyService.querySphere` writes by index and never pushes. */
const _targets: Damageable[] = [];

export class BoonStatEffects {
  private ctx: GameCtx | null = null;
  private readonly offs: (() => void)[] = [];

  /** Re-entrancy latch — see the header. */
  private busy = false;
  /** At most one detonation per shot: shotgun pellets share a frame. */
  private lastBlastFrame = -1;
  private slideAccum = 0;

  attach(ctx: GameCtx): void {
    this.ctx = ctx;

    this.offs.push(ctx.events.on('enemy:killed', () => {
      const heal = ctx.player.stats.lifestealPerKill;
      if (heal > 0) ctx.player.heal(heal);
    }));

    this.offs.push(ctx.events.on('hit:enemy', (p) => {
      if (this.busy) return;
      const s = ctx.player.stats;
      // Only OUR bullets carry a weaponId; a zombie's melee never reaches this branch anyway,
      // but reading the stat first keeps the common path to two number compares.
      if (s.explosiveChance > 0) this.tryExplode(ctx, s, p.info);
      if (s.chainChance > 0 && p.info.isCrit) this.tryChain(ctx, s, p.info, p.target);
    }));
  }

  dispose(): void {
    for (let i = 0; i < this.offs.length; i++) this.offs[i]();
    this.offs.length = 0;
    this.ctx = null;
    this.busy = false;
    this.slideAccum = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Slide contact damage — the only part of this file that needs the sim clock.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * Called from the boon system's `fixedUpdate`. Ticks rather than running every step: a
   * 0.7 s slide lands ~4 hits, which reads as "you barged through them" instead of as a
   * 120 Hz damage-over-time field.
   */
  fixedUpdate(dt: number, ctx: GameCtx): void {
    const dmg = ctx.player.stats.slideDamage;
    if (dmg <= 0 || ctx.player.moveState !== 'slide') {
      this.slideAccum = 0;
      return;
    }
    this.slideAccum += dt;
    if (this.slideAccum < E.slideTick) return;
    this.slideAccum -= E.slideTick;

    _slideCentre.copy(ctx.player.position);
    _slideCentre.y += E.slideHeight;
    _slideInfo.amount = dmg;
    _slideInfo.point.copy(_slideCentre);
    _slideInfo.direction.copy(ctx.player.velocity);
    if (_slideInfo.direction.lengthSq() < 1e-6) _slideInfo.direction.set(0, 0, -1);
    else _slideInfo.direction.normalize();
    _slideInfo.normal.copy(_slideInfo.direction).negate();

    this.busy = true;
    const n = ctx.enemies.damageSphere(_slideCentre, E.slideRadius, dmg, _slideInfo);
    this.busy = false;
    if (n <= 0) return;
    ctx.vfx.inkSplatter(_slideCentre, _slideInfo.direction, 0.7);
    ctx.events.emit('fx:sound', { id: 'impact_flesh', position: _slideCentre, volume: 0.8 });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Explosive rounds
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private tryExplode(ctx: GameCtx, s: Readonly<PlayerStats>, info: DamageInfo): void {
    if (ctx.time.frame === this.lastBlastFrame) return;
    if (ctx.rng.next() >= s.explosiveChance) return;
    this.lastBlastFrame = ctx.time.frame;

    const radius = s.explosiveRadius;
    _p.copy(info.point);
    _blastInfo.amount = info.amount;
    _blastInfo.point.copy(_p);
    _blastInfo.direction.copy(info.direction);
    _blastInfo.normal.copy(info.normal);
    _blastInfo.weaponId = info.weaponId;
    _blastInfo.affix = info.affix;

    this.busy = true;
    ctx.enemies.damageSphere(_p, radius, info.amount * E.explosiveDamageFraction, _blastInfo);
    this.busy = false;

    ctx.vfx.explosion(_p, radius);
    ctx.events.emit('fx:shake', { amount: 0.28, duration: 0.3 });
    ctx.events.emit('fx:sound', { id: 'impact_metal', position: _p, volume: 1, pitch: 0.55 });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Chain lightning — crits only, so it rewards the same skill the whole game rewards.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  private tryChain(
    ctx: GameCtx, s: Readonly<PlayerStats>, info: DamageInfo, source: Damageable,
  ): void {
    if (ctx.rng.next() >= s.chainChance) return;
    const want = Math.floor(s.chainTargets);
    if (want <= 0) return;

    _p.copy(info.point);
    const found = ctx.enemies.querySphere(_p, E.chainRadius, _targets);
    if (found <= 0) return;

    const damage = info.amount * E.chainDamageFraction;
    _chainInfo.amount = damage;
    _chainInfo.weaponId = info.weaponId;

    this.busy = true;
    let arcs = 0;
    for (let i = 0; i < found && arcs < want; i++) {
      const t = _targets[i];
      if (t === source || !t.alive) continue;
      _q.copy(t.position);
      _q.y += 1;
      _chainInfo.point.copy(_q);
      _chainInfo.direction.copy(_q).sub(_p);
      if (_chainInfo.direction.lengthSq() < 1e-6) _chainInfo.direction.set(0, 1, 0);
      else _chainInfo.direction.normalize();
      _chainInfo.normal.copy(_chainInfo.direction).negate();
      t.takeDamage(_chainInfo);
      ctx.vfx.tracer(_p, _q, 1.4);
      ctx.vfx.impact(_q, _chainInfo.normal, 'shock', 0.9);
      arcs++;
    }
    this.busy = false;
    if (arcs === 0) return;
    // No `setSpeedLineColor` here, tempting as an ELECTRIC flash is: that knob is global,
    // persistent state owned by the movement layer, and a chain arc has no business leaving
    // the player's sprint lines cyan for the rest of the run.
    ctx.events.emit('fx:sound', { id: 'ricochet', position: _p, volume: 0.8, pitch: 1.6 });
  }
}

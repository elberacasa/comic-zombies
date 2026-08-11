/**
 * THE ECONOMY HARNESS — run it with `node tools/economy.mjs`; see that file for what it answers
 * and why. Nothing here judges how anything looks or feels: it measures distances between props,
 * asserts that one keypress cannot become two purchases, and prints the price ladder.
 */
import { installDomStub } from './domstub';

installDomStub();

import { buildRig } from './rig';
import { findWallSpots, WALL } from '@/game/economy/wallbuys';
import { solveSites, SITE } from '@/game/economy/box';
import { MACHINE } from '@/game/economy/perks';
import { getWeaponDef } from '@/game/weapons/defs';

const rig = buildRig(0x1234);
const walls = findWallSpots(rig.world, 5);
const sites = solveSites(rig.ctx, rig.ctx.rng.fork(0x5117e5));

console.log(`walls ${walls.length}   sites ${sites.length}   want ${SITE.want}`);
console.log(`radii: wall ${WALL.useRadius}  machine ${MACHINE.useRadius}  → overlap iff d < ${
  (WALL.useRadius + MACHINE.useRadius).toFixed(2)} m`);

const spawn = rig.world.playerSpawn.position;
for (let i = 0; i < sites.length; i++) {
  const s = sites[i];
  const d = Math.hypot(s.position.x - spawn.x, s.position.z - spawn.z);
  console.log(`  site ${i}  (${s.position.x.toFixed(1)}, ${s.position.z.toFixed(1)}) fromSpawn ${d.toFixed(1)}m`);
}

let worst = Infinity;
let overlaps = 0;
for (const w of walls) {
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    // The wall-buy tests 3D from its STANDING anchor; the machine tests horizontal from its own
    // position with a vertical window. Horizontal distance is the permissive (worst) case.
    const d = Math.hypot(w.sx - s.position.x, w.sz - s.position.z);
    if (d < worst) worst = d;
    if (d < WALL.useRadius + MACHINE.useRadius) {
      overlaps++;
      console.log(`  OVERLAP  wall(${w.sx.toFixed(1)},${w.sz.toFixed(1)}) × site${i} = ${d.toFixed(2)} m`);
    }
  }
}
console.log(`closest wall↔site pair: ${worst.toFixed(2)} m   overlapping pairs: ${overlaps}`);

// ── ARBITRATION ────────────────────────────────────────────────────────────────────────────
{
  const c = await import('@/game/economy/claim');
  const W = c.OWNER_WALL;
  const M = c.OWNER_MACHINE;
  let fails = 0;
  const ok = (name: string, cond: boolean): void => {
    console.log(`  ${cond ? 'PASS' : '*** FAIL ***'}  ${name}`);
    if (!cond) fails++;
  };

  // 1. Wall nearer → wall takes it, machine refused on the same frame.
  c.resetInteractClaims();
  c.publishDistance(W, 1.0); c.publishDistance(M, 4.0);
  ok('wall nearer: wall owns the prompt', c.ownsSpot(W) && !c.ownsSpot(M));
  ok('wall nearer: wall takes the press', c.takeInteract(10, W));
  ok('wall nearer: machine cannot take the same press', !c.takeInteract(10, M));

  // 2. Machine nearer → the mirror.
  c.resetInteractClaims();
  c.publishDistance(W, 4.0); c.publishDistance(M, 1.0);
  ok('machine nearer: machine owns the prompt', c.ownsSpot(M) && !c.ownsSpot(W));
  ok('machine nearer: machine takes the press', c.takeInteract(11, M));
  ok('machine nearer: wall cannot take the same press', !c.takeInteract(11, W));

  // 3. Exact tie → the machine, and never both.
  c.resetInteractClaims();
  c.publishDistance(W, 2.0); c.publishDistance(M, 2.0);
  ok('tie: exactly one owner', c.ownsSpot(W) !== c.ownsSpot(M));
  ok('tie: the machine takes it', c.ownsSpot(M) && c.takeInteract(12, M));
  ok('tie: the wall does not', !c.takeInteract(12, W));

  // 4. The deferred-press case: a press latched on frame 20 and spent on frame 21 is still
  //    stamped 20, so a wall-buy that already took frame 20 blocks it.
  c.resetInteractClaims();
  c.publishDistance(W, 1.0); c.publishDistance(M, 4.0);
  ok('deferred press: wall takes frame 20', c.takeInteract(20, W));
  c.publishDistance(W, 9.0); c.publishDistance(M, 1.0); // player kept moving
  ok('deferred press: machine spending it a frame later is refused', !c.takeInteract(20, M));
  ok('a NEW press on frame 21 still works', c.takeInteract(21, M));

  // 5. Nothing in range → neither.
  c.resetInteractClaims();
  ok('nothing in range: nobody takes it', !c.takeInteract(30, W) && !c.takeInteract(30, M));

  console.log(fails === 0 ? '  arbitration: ALL PASS' : `  arbitration: ${fails} FAILED`);
  if (fails > 0) process.exitCode = 1;
}

// Affordability curve, from the round spawn formula and the doc's measured round-1 income.
const R1 = 4400;
const count = (n: number): number => Math.round(6 + n * 2.2);
let cum = 0;
console.log('\nround  bodies   income(≈)   cumulative');
for (let n = 1; n <= 6; n++) {
  const inc = Math.round((R1 * count(n)) / count(1));
  cum += inc;
  console.log(`  ${String(n).padStart(2)}     ${String(count(n)).padStart(2)}      ${String(inc).padStart(6)}      ${String(cum).padStart(6)}`);
}
const prices: Array<[string, number]> = [
  ['ratatat', getWeaponDef('ratatat')?.buyCost ?? -1],
  ['boomstick', getWeaponDef('boomstick')?.buyCost ?? -1],
  ['longshot', getWeaponDef('longshot')?.buyCost ?? -1],
  ['box spin', 950],
  ['all 4 perks', 2500 + 3000 + 2000 + 2000],
  ['pack-a-punch', 5000],
];
console.log(prices.map(([k, v]) => `${k} ${v}`).join(' · '));

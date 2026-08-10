import { installDomStub } from './domstub';
installDomStub();
const { Vector3 } = await import('three');
const { buildRig, groundAt, yawToward, overlapAt, FIXED } = await import('./rig');
const { MOVE } = await import('@/game/tuning');
const rig = buildRig(0x1234);
const { world, controller, input } = rig;

function walk(label: string, sx: number, sy: number, sz: number, tx: number, tz: number, secs: number, every = 1) {
  console.log(`\n— ${label} —`);
  const g = groundAt(world, sx, sz, sy) ?? 0;
  const yaw = yawToward(sx, sz, tx, tz);
  controller.teleport(new Vector3(sx, g + 0.05, sz), yaw);
  input.reset();
  for (let i = 0; i < 40; i++) rig.stepPlayer(yaw);
  input.moveAxis.y = 1;
  const n = Math.round(secs / FIXED);
  let prev = controller.position.clone();
  for (let i = 0; i < n; i++) {
    rig.stepPlayer(yaw);
    const p = controller.position;
    const jump = p.distanceTo(prev);
    if (i % every === 0 || jump > 0.3) {
      const d = overlapAt(world, p, controller.height, MOVE.radius);
      console.log(`  t=${(i * FIXED).toFixed(3)} pos=(${p.x.toFixed(2)},${p.y.toFixed(3)},${p.z.toFixed(2)}) st=${controller.moveState} gr=${controller.grounded ? 1 : 0} spd=${controller.speed.toFixed(2)} vy=${controller.velocity.y.toFixed(2)} d=${jump.toFixed(3)} ov=${d.toFixed(3)}`);
    }
    prev.copy(p);
  }
  input.moveAxis.y = 0;
}
walk('fire_escape_1', -26.4, 1.4, -18.2, -26.4, -5, 0.75, 4);
walk('dock_steps_e', 12.7, 1.4, 26.4, 5, 26.4, 1.6, 6);
console.log('\n— what is around (-26.4, -14) —');
for (let y = 0; y <= 4; y += 0.25) {
  const p = new Vector3(-26.4, y, -14);
  console.log(`  y=${y.toFixed(2)} overlap(stand)=${overlapAt(world, p, 1.85, 0.42).toFixed(3)}`);
}
console.log('\n— ground profile across the fire escape width at z=-14 —');
for (let x = -29.5; x <= -23; x += 0.3) {
  console.log(`  x=${x.toFixed(1)} g=${(groundAt(world, x, -14, 9) ?? NaN).toFixed(2)}`);
}

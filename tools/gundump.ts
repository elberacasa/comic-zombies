/** One-off: what is actually VISIBLE in a gallery showpiece, and how big is each part on screen. */
import { Box3, Vector3, type Object3D } from 'three';
import { installDomStub } from './domstub';

installDomStub();

const { buildGunShowpiece } = await import('../src/game/weapons/viewmodel');

for (const id of ['inkslinger', 'redline']) {
  const g = buildGunShowpiece(id);
  g.updateMatrixWorld(true);
  const whole = new Box3().setFromObject(g);
  const sz = whole.getSize(new Vector3());
  console.log(`\n${id}  overall ${(sz.x*1000)|0} x ${(sz.y*1000)|0} x ${(sz.z*1000)|0} mm  visible=${g.visible}`);
  const rows: string[] = [];
  g.traverse((o: Object3D) => {
    if (o === g) return;
    const anyO = o as unknown as { isMesh?: boolean };
    if (!anyO.isMesh) return;
    const b = new Box3().setFromObject(o);
    const s = b.getSize(new Vector3());
    const vol = s.x * s.y * s.z;
    let vis = o.visible; let p: Object3D | null = o.parent;
    while (p && p !== g) { if (!p.visible) vis = false; p = p.parent; }
    rows.push(`${vis ? 'VIS ' : '  . '} ${o.name.padEnd(18)} ${(s.x*1000)|0}x${(s.y*1000)|0}x${(s.z*1000)|0} mm  vol ${(vol*1e6).toFixed(1)}`);
  });
  for (const r of rows) console.log('  ' + r);
}

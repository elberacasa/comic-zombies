/**
 * VFX — the barrel.
 *
 * Integration is three lines in `main.ts`:
 *
 * ```ts
 * const vfx = createVfx();
 * // …put it in the GameCtx in place of `stubs.vfx`…
 * loop.add(vfx);   // after `enemies`, per ARCHITECTURE §3
 * ```
 *
 * `VfxSystem` implements both `System` and `VfxService`, so the same object is the service in
 * `GameCtx` and the frame hook in the loop. It subscribes to the bus in `init()` and does all
 * its stepping in `lateUpdate()`, which means registration order only decides where it sits in
 * the debug list — the effects are correct wherever it goes.
 */

export { VfxSystem, createVfx } from '@/game/vfx/service';
export { buildVfxSheet, type VfxSheet, type Cell } from '@/game/vfx/sheet';
export { InstancedField } from '@/game/vfx/field';
export { CardEmitter, ShardEmitter, TracerEmitter, DecalField, NumberEmitter } from '@/game/vfx/emitters';
export { WordPops } from '@/game/vfx/words';

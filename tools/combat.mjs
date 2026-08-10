#!/usr/bin/env node
/**
 * ONE COMMAND:  node tools/combat.mjs [all|curve|hitbox|surround|conga|perf]
 *
 * Bundles `tools/combat.ts` through vite (so `@/…` and `three/addons/…` resolve exactly as they
 * do in the browser build) and runs it in node against the REAL arena, the REAL `EnemySystem`,
 * the REAL bone rig and the REAL bullet trace. No GL context, no browser automation, no
 * throttled rAF, no pointer lock.
 *
 * Exits non-zero when a check fails, so it can gate a milestone. Run it beside
 * `tools/stairs.mjs` (movement) and `tools/zombie.mjs` (the rig).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);

const build = spawnSync(
  'npx',
  ['vite', 'build', '--ssr', 'tools/combat.ts', '--outDir', 'tools/.build', '--emptyOutDir', '--logLevel', 'error'],
  { cwd: root, stdio: 'inherit', shell: false },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const run = spawnSync('node', ['--expose-gc', join(root, 'tools/.build/combat.js'), ...args], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(run.status ?? 1);

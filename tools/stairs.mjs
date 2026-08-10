#!/usr/bin/env node
/**
 * ONE COMMAND:  node tools/stairs.mjs [all|stairs|ledges|horde|soak]
 *
 * Bundles `tools/stairs.ts` through vite (so `@/…` and `three/addons/…` resolve exactly as
 * they do in the browser build) and runs it in node. No GL context, no DOM, no browser
 * automation, no throttled rAF — just the real arena, the real collision octree, the real
 * `PlayerController` and the real `EnemySystem`.
 *
 * Exits non-zero when a route fails, so it can gate a milestone.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);

const build = spawnSync(
  'npx',
  ['vite', 'build', '--ssr', 'tools/stairs.ts', '--outDir', 'tools/.build', '--emptyOutDir', '--logLevel', 'error'],
  { cwd: root, stdio: 'inherit', shell: false },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const run = spawnSync('node', [join(root, 'tools/.build/stairs.js'), ...args], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(run.status ?? 1);

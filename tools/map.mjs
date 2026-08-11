#!/usr/bin/env node
/**
 * ONE COMMAND:  node tools/map.mjs [all|reach|inside|speed|stairs|floors]
 *
 * Bundles `tools/map.ts` through vite (so `@/…` and `three/addons/…` resolve exactly as they do
 * in the browser build) and runs it in node. No GL context, no DOM, no browser automation — just
 * the real arena, the real collision octree, the real `PlayerController` and the real `moveBody`.
 *
 * This is the MAP INTEGRITY invariant of `docs/MAP_INTEGRITY.md` §4: walls are walls, floors are
 * floors, stairs are stairs. Exits non-zero when the arena is unsound, so it can gate a
 * milestone the way `tools/stairs.mjs` gates the vertical routes.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);

const build = spawnSync(
  'npx',
  ['vite', 'build', '--ssr', 'tools/map.ts', '--outDir', 'tools/.build', '--emptyOutDir', '--logLevel', 'error'],
  { cwd: root, stdio: 'inherit', shell: false },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const run = spawnSync('node', [join(root, 'tools/.build/map.js'), ...args], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(run.status ?? 1);

#!/usr/bin/env node
/**
 * ONE COMMAND:  node tools/zombie.mjs [all|budget|skin|seams|stretch|hitbox|determ|perf|bind]
 *
 * Bundles `tools/zombie.ts` through vite (so `@/…` and `three/addons/…` resolve exactly as
 * they do in the browser build) and runs it in node against the REAL enemy geometry, the REAL
 * skin solve and the REAL bone palette. No GL context, no DOM, no browser automation.
 *
 * Exits non-zero when a check fails, so it can gate a milestone.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);

const build = spawnSync(
  'npx',
  ['vite', 'build', '--ssr', 'tools/zombie.ts', '--outDir', 'tools/.build', '--emptyOutDir', '--logLevel', 'error'],
  { cwd: root, stdio: 'inherit', shell: false },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const run = spawnSync('node', ['--expose-gc', join(root, 'tools/.build/zombie.js'), ...args], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(run.status ?? 1);

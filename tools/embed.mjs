#!/usr/bin/env node
/**
 * ONE COMMAND:  node tools/embed.mjs [trace|ablate|shape|all]
 *
 * Same bundling trick as `tools/stairs.mjs`: vite --ssr so `@/…` resolves as it does in the
 * browser build, then plain node. Throwaway diagnostic for MAP_INTEGRITY §2.5.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);

const build = spawnSync(
  'npx',
  ['vite', 'build', '--ssr', 'tools/embed.ts', '--outDir', 'tools/.build', '--logLevel', 'error'],
  { cwd: root, stdio: 'inherit', shell: false },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const run = spawnSync('node', [join(root, 'tools/.build/embed.js'), ...args], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(run.status ?? 1);

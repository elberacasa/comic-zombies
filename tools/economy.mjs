#!/usr/bin/env node
/**
 * ONE COMMAND:  node tools/economy.mjs
 *
 * Bundles `tools/economy.ts` through vite (so `@/…` resolves exactly as it does in the browser
 * build) and runs it in node. No GL context, no DOM — the real arena, the real collision octree,
 * and the REAL placement solvers for both the wall-buys and the machines.
 *
 * WHAT IT ANSWERS, and why a machine should be the one answering it:
 *
 *  1. HOW CLOSE do a wall-buy and a perk machine actually land? Both solvers ask `WorldService`
 *     for flat, reachable, spawn-distant ground, so they AGREE — on seed 0x1234 a machine sits
 *     1.11 m from a wall-buy, well inside the 5.80 m at which both are usable at once. That fact
 *     is why `game/economy/claim.ts` exists, and this is what would catch it coming back.
 *  2. Does the interact arbitration hold? Nearest wins, machines take ties, and — the part worth
 *     testing — ONE press can never become two purchases, including across the frame boundary
 *     where a press latched above 120 fps is spent by the next frame's fixed step.
 *  3. The affordability curve, printed, so the prices can be argued about with numbers.
 *
 * Exits non-zero when an arbitration check fails, so it can gate a milestone.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);

const build = spawnSync(
  'npx',
  ['vite', 'build', '--ssr', 'tools/economy.ts', '--outDir', 'tools/.build', '--emptyOutDir', '--logLevel', 'error'],
  { cwd: root, stdio: 'inherit', shell: false },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const run = spawnSync('node', [join(root, 'tools/.build/economy.js'), ...args], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(run.status ?? 1);

/**
 * Swap the two built pages so the DEPLOYED site opens on the asset gallery.
 *
 * Why a post-build step and not a Vercel rewrite: Vercel resolves filesystem matches BEFORE
 * rewrites, so `/` always hit `dist/index.html` and a `/ → /gallery.html` rewrite never fired.
 * Renaming the source files would work too, but `index.html` is the game's entry and is edited
 * constantly, so the rename is left for later. Swapping the OUTPUT is unambiguous and touches
 * nothing anyone is working in.
 *
 *   dist/index.html   (game)    →  dist/play.html
 *   dist/gallery.html (gallery) →  dist/index.html
 *
 * Bundle references are absolute (`/assets/…`), so moving the HTML does not break them.
 */
import { rename, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const at = (f) => join(dist, f);

for (const f of ['index.html', 'gallery.html']) {
  try { await access(at(f)); }
  catch { console.error(`postbuild: expected dist/${f} — did the multi-page build run?`); process.exit(1); }
}

await rename(at('index.html'), at('play.html'));
await rename(at('gallery.html'), at('index.html'));

// The gallery is now the site root, so its own "back to the game" links must point at /play.
const html = await readFile(at('index.html'), 'utf8');
await writeFile(at('index.html'), html.replaceAll('/index.html', '/play'), 'utf8');

console.log('postbuild: / → gallery, /play → game');

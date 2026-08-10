import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Two entry points, deliberately.
 *
 *   index.html    the game
 *   gallery.html  the asset showcase — every generated texture, mesh, letterform and sound,
 *                 rendered live by calling the game's own modules
 *
 * On the deployed site `/` serves the gallery and the game sits one click away (see vercel.json).
 * Locally `npm run dev` still opens the game at `/`, because that is what you want when you are
 * working on it; the gallery is at `/gallery.html`.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, open: true },
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      input: {
        game: fileURLToPath(new URL('./index.html', import.meta.url)),
        gallery: fileURLToPath(new URL('./gallery.html', import.meta.url)),
      },
    },
  },
});

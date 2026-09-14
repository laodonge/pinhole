import { defineConfig } from "vite";

/**
 * Builds the deployable static site.
 *
 * `dist/` is what you upload: an `index.html` shell, the compiled JS, the
 * service worker at `/sw.js`, and an editable `config.js`.
 */
export default defineConfig({
  base: "/",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});

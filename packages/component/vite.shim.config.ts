import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * The injected websocket shim is built separately from the component.
 *
 * It has to be a standalone classic script: it is served at `/pinhole-shim.js`
 * and injected into the proxied service's document, where it is the first script
 * to run and cannot import anything. It also must not be an ES module, because
 * `<script type="module">` is deferred — by the time it executed, the service
 * would already have opened its websocket against the real constructor.
 *
 * `emptyOutDir` is off so that this second pass does not wipe the component
 * bundle produced by the main build.
 */
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/shim.ts"),
      name: "PinholeShim",
      fileName: () => "pinhole-shim.js",
      formats: ["iife"],
    },
    outDir: "dist",
    emptyOutDir: false,
  },
});

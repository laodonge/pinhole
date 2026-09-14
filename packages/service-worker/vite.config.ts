import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/sw.ts"),
      name: "Sw",
      fileName: () => "sw.js",
      formats: ["iife"],
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});

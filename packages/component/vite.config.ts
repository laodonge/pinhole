import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "EasytierTunnel",
      fileName: "pinhole",
      formats: ["es", "umd"],
    },
  },
});

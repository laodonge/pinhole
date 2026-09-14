import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The service worker is built by `@pinhole/service-worker` into its own
 * `dist/`. The bootstrap must serve it from the origin root (`/sw.js`) for its
 * scope to cover the whole site, so copy it into `public/`.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../../service-worker/dist/sw.js");
const destination = path.resolve(here, "../public/sw.js");

if (!existsSync(source)) {
  console.error(
    `service worker not built yet: ${source}\n` +
      `run \`npm run build --workspace @pinhole/service-worker\` first ` +
      `(or just \`npm run build\` at the repo root, which builds workspaces in order).`,
  );
  process.exit(1);
}

await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`copied sw.js -> ${path.relative(process.cwd(), destination)}`);

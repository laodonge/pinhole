import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The service worker is built by `@pinhole/service-worker` into its own
 * `dist/`. The bootstrap must serve it from the origin root (`/sw.js`) for its
 * scope to cover the whole site, so copy it into `public/`.
 *
 * The websocket shim is copied alongside it for the same reason: the worker
 * injects `<script src="/pinhole-shim.js">` into every proxied document, and
 * that path is on this origin. It has to be present in `dist/` or the injected
 * script 404s and every websocket in the proxied service silently fails.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const files = [
  { source: "../../service-worker/dist/sw.js", name: "sw.js", built: "@pinhole/service-worker" },
  {
    source: "../../component/dist/pinhole-shim.js",
    name: "pinhole-shim.js",
    built: "@pinhole/component",
  },
];

for (const file of files) {
  const source = path.resolve(here, file.source);
  const destination = path.resolve(here, "../public", file.name);

  if (!existsSync(source)) {
    console.error(
      `not built yet: ${source}\n` +
        `run \`npm run build --workspace ${file.built}\` first ` +
        `(or just \`npm run build\` at the repo root, which builds workspaces in order).`,
    );
    process.exit(1);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  console.log(`copied ${file.name} -> ${path.relative(process.cwd(), destination)}`);
}


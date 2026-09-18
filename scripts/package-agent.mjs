/**
 * Builds the shippable agent bundle.
 *
 * The point is that somebody who has never seen this repository can unzip one
 * file, edit `agent.json`, run one command, and have their services reachable
 * from a browser. So each archive contains everything on the server side:
 *
 *   pinhole-agent        the binary
 *   agent.json           the template, self-documenting
 *   README.md            the deployment guide
 *   www/                 the static shell, to upload to your own hosting
 *
 * Usage:
 *   node scripts/package-agent.mjs
 *   node scripts/package-agent.mjs --version 0.2.0
 *   node scripts/package-agent.mjs --targets windows/amd64,linux/amd64
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const agentDir = path.join(root, "packages", "agent");
const bootstrapDist = path.join(root, "packages", "bootstrap", "dist");
const releaseDir = path.join(root, "release");

/** Reasonable coverage for a personal tool; override with --targets. */
const DEFAULT_TARGETS = [
  "windows/amd64",
  "linux/amd64",
  "linux/arm64",
  "darwin/arm64",
  "darwin/amd64",
];

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/**
 * The version to name the archives with.
 *
 * The git tag wins over `package.json`: releases here are cut as tags, and
 * `package.json` has never tracked them, so trusting it silently names a fresh
 * build after a release from months ago.
 */
function version() {
  const explicit = argValue("version");
  if (explicit) return explicit;

  const tag = spawnSync("git", ["describe", "--tags", "--abbrev=0"], {
    cwd: root,
    encoding: "utf8",
  });
  if (tag.status === 0 && tag.stdout.trim()) {
    return tag.stdout.trim().replace(/^v/, "");
  }

  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
}

/** `go build` for one target, into `out`. */
function build(goos, goarch, out) {
  execFileSync(
    "go",
    [
      "build",
      // Strip the build path and the symbol table: 16 MB of Go binary is mostly
      // debug info nobody will use from a release zip.
      "-trimpath",
      "-ldflags",
      "-s -w",
      "-o",
      out,
      ".",
    ],
    {
      cwd: agentDir,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
    },
  );
}

/**
 * Zip `dir` into `zipPath`.
 *
 * Shelled out rather than hand-rolled: a zip writer is a hundred lines of
 * offsets and CRCs, and both platforms already ship a working one.
 */
function zip(dir, zipPath) {
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zipPath}' -Force`,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    return;
  }

  const zipResult = spawnSync("zip", ["-qr", zipPath, "."], { cwd: dir, stdio: "inherit" });
  if (zipResult.error || zipResult.status !== 0) {
    throw new Error("no `zip` on PATH; install it or run the packager on Windows");
  }
}

function main() {
  const ver = version();
  const targets = (argValue("targets") ?? DEFAULT_TARGETS.join(","))
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (!existsSync(bootstrapDist)) {
    console.error(
      `the web shell is not built: ${bootstrapDist}\n` +
        `run \`npm run build\` at the repository root first — the bundle ships it, ` +
        `so that nobody needs Node.js or Go to deploy.`,
    );
    process.exit(1);
  }

  mkdirSync(releaseDir, { recursive: true });
  const made = [];

  for (const target of targets) {
    const [goos, goarch] = target.split("/");
    if (!goos || !goarch) {
      console.error(`bad target ${JSON.stringify(target)}, want os/arch`);
      process.exit(1);
    }

    const name = `pinhole-agent-${ver}-${goos}-${goarch}`;
    const stage = path.join(releaseDir, name);
    const binary = `pinhole-agent${goos === "windows" ? ".exe" : ""}`;

    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });

    console.log(`\n==> ${target}`);
    build(goos, goarch, path.join(stage, binary));

    // The template is copied as the live config: the first thing a user does is
    // edit this file, and making them copy it first is a step that only exists
    // to be forgotten.
    cpSync(path.join(agentDir, "agent.example.json"), path.join(stage, "agent.json"));

    const guide = path.join(root, "docs", "DEPLOY-AGENT.md");
    if (existsSync(guide)) cpSync(guide, path.join(stage, "README.md"));

    cpSync(bootstrapDist, path.join(stage, "www"), { recursive: true });

    const zipPath = path.join(releaseDir, `${name}.zip`);
    rmSync(zipPath, { force: true });
    zip(stage, zipPath);
    made.push(zipPath);
  }

  // Keep only the archives: five staged trees is 60 MB of the same bytes.
  for (const target of targets) {
    const [goos, goarch] = target.split("/");
    rmSync(path.join(releaseDir, `pinhole-agent-${ver}-${goos}-${goarch}`), {
      recursive: true,
      force: true,
    });
  }

  console.log("\narchives:");
  for (const file of made) {
    const size = readFileSync(file).length;
    console.log(`  ${path.relative(root, file)}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

main();


/**
 * Guard the template literal that holds the e2e page.
 *
 * `scripts/e2e.mjs` embeds a whole HTML document in a JavaScript template
 * literal. A backtick inside that region — which is very easy to type in a
 * comment, because the comments there quote identifiers the way the rest of the
 * codebase does — terminates the literal early and breaks the *whole file*.
 *
 * `node --check` cannot help, because the file no longer parses at all, and the
 * in-file self-check that parses the page script never gets to run. So this is a
 * separate program that reads the file as text and never imports it.
 *
 * It has already caught this mistake three times, which is three times more than
 * a comment saying "do not use backticks here" would have.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "e2e.mjs");
const lines = readFileSync(file, "utf8").split("\n");

const OPEN = "const PAGE_HTML = `";

const start = lines.findIndex((l) => l.startsWith(OPEN));
if (start === -1) {
  console.error(`check-page-template: no line starts with ${JSON.stringify(OPEN)}`);
  process.exit(1);
}

// The literal ends at the first backtick-followed-by-semicolon at the end of a
// line. It has to be that specific: a stray backtick in a comment mid-region
// would otherwise be mistaken for the closing delimiter, and the guard would
// cheerfully pass the very mistake it exists to catch — which it did, once.
const end = lines.findIndex((l, i) => i > start && /`;\s*$/.test(l));
if (end === -1) {
  console.error("check-page-template: the PAGE_HTML literal is never closed");
  process.exit(1);
}

// A second, independent signal that the region really is the template: it holds
// an HTML document, so it ends with one.
if (!lines[end].includes("</html>")) {
  console.error(
    `check-page-template: line ${end + 1} closes the literal but does not look ` +
      `like the end of the document, so the literal was probably cut short earlier.`,
  );
  process.exit(1);
}

const offenders = [];
for (let i = start + 1; i < end; i++) {
  const at = lines[i].indexOf("`");
  if (at !== -1) offenders.push(`${i + 1}: ${lines[i].trim()}`);
}

if (offenders.length > 0) {
  console.error(
    `check-page-template: a backtick inside the PAGE_HTML literal ends it early.\n` +
      `Lines ${start + 2}-${end} must not contain one; use quotes instead.\n\n` +
      offenders.map((o) => `  ${o}`).join("\n"),
  );
  process.exit(1);
}

console.log(`check-page-template: ok (PAGE_HTML spans lines ${start + 2}-${end})`);

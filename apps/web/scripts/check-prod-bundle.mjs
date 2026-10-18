#!/usr/bin/env node
/**
 * Proves that test mode cannot ship: after `next build`, nothing under .next may contain the fixture
 * sentinel string, the test cookie name's login path, or the fixture module.
 * Run: npm run build && npm run check:bundle
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".next");
if (!existsSync(root)) {
  console.error("No .next folder. Run `npm run build` first.");
  process.exit(2);
}

const FORBIDDEN = ["FIXTURE_SENTINEL_7f3a9c", "olivia.owner@example.test", "sam.member@example.test", "createFixtureBackend"];
// Only build output that can be served or run: skip caches and dev-only folders. Server source maps hold the
// original source text (including dead branches) and are never served, so they are not scanned.
const SKIP = new Set(["cache", "dev", "diagnostics", "trace", "trace-build", "types"]);

let files = 0;
const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) && dir === root) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs|json|html|rsc|txt|css)$/.test(name)) {
      files++;
      const text = readFileSync(p, "utf8");
      for (const word of FORBIDDEN) if (text.includes(word)) hits.push(`${p.slice(root.length + 1)} contains ${word}`);
    }
  }
}
walk(root);

if (hits.length) {
  console.error(`FAIL: test-mode code is in the production build (${hits.length} hits):\n` + hits.slice(0, 20).join("\n"));
  process.exit(1);
}
console.log(`ok: scanned ${files} files in .next, no fixture code or data found.`);

#!/usr/bin/env node
/**
 * Checks every skill under hermes/skills/<name>/SKILL.md.
 * Run: npm run test:skills
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";

export const EXPECTED = [
  "sdlc-orchestrator",
  "sdlc-ba",
  "sdlc-architect",
  "sdlc-development",
  "sdlc-review",
  "sdlc-qa",
  "sdlc-release",
  "sdlc-change-request",
];

// The words that must not appear in any skill: the old chat channel is gone, all talk is on the website.
const BANNED = [/telegram/i, /\bbot token\b/i];
// Things that look like real secrets.
const SECRET_PATTERNS = [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, /\bsk-[A-Za-z0-9]{20,}\b/, /\bghp_[A-Za-z0-9]{30,}\b/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./];

/** Returns a list of problem strings for one skill file's text (empty list = fine). */
export function validateSkill(dirName, text) {
  const problems = [];
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) return [`${dirName}: file must start with a YAML front matter block between --- lines`];
  let meta;
  try {
    meta = yamlLoad(m[1]);
  } catch (e) {
    return [`${dirName}: front matter is not valid YAML (${e.message.split("\n")[0]})`];
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [`${dirName}: front matter must be a mapping`];

  const keys = Object.keys(meta);
  for (const k of keys) if (!["name", "description"].includes(k)) problems.push(`${dirName}: unexpected front matter key "${k}" (only name and description are allowed)`);
  if (typeof meta.name !== "string" || !meta.name) problems.push(`${dirName}: front matter needs a name`);
  else {
    if (meta.name !== dirName) problems.push(`${dirName}: name "${meta.name}" must match the folder name`);
    if (!/^sdlc-[a-z]+(-[a-z]+)*$/.test(meta.name)) problems.push(`${dirName}: name must look like sdlc-something (lowercase letters and dashes)`);
  }
  if (typeof meta.description !== "string" || !meta.description.trim()) problems.push(`${dirName}: front matter needs a description`);
  else {
    const d = meta.description.trim();
    if (d.length < 40) problems.push(`${dirName}: description is too short to say when to use the skill (${d.length} characters)`);
    if (d.length > 600) problems.push(`${dirName}: description is too long (${d.length} characters, 600 is the limit)`);
  }

  const body = m[2];
  if (body.trim().length < 400) problems.push(`${dirName}: the body is too short`);
  if (!/^# \S/m.test(body)) problems.push(`${dirName}: the body needs a "# Title" heading`);
  if ((body.match(/^## /gm) ?? []).length < 2) problems.push(`${dirName}: the body needs at least two "## " sections`);

  for (const re of BANNED) if (re.test(text)) problems.push(`${dirName}: contains banned wording ${re}`);
  for (const re of SECRET_PATTERNS) if (re.test(text)) problems.push(`${dirName}: looks like it contains a secret (${re})`);
  return problems;
}

export function validateAll(root) {
  const problems = [];
  const dirs = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
  for (const want of EXPECTED) if (!dirs.includes(want)) problems.push(`missing skill folder: ${want}`);
  for (const d of dirs) {
    if (!EXPECTED.includes(d)) problems.push(`unexpected folder: ${d} (add it to EXPECTED in validate.mjs if it is new)`);
    const file = join(root, d, "SKILL.md");
    if (!existsSync(file)) {
      problems.push(`${d}: SKILL.md is missing`);
      continue;
    }
    problems.push(...validateSkill(d, readFileSync(file, "utf8")));
  }
  return { count: dirs.length, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = dirname(fileURLToPath(import.meta.url));
  const { count, problems } = validateAll(root);
  if (problems.length) {
    console.error(`FAIL: ${problems.length} problem(s) in ${count} skill folder(s):\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`ok: ${count} skills have valid front matter and no banned wording.`);
}

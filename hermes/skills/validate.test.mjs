import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAll, validateSkill } from "./validate.mjs";

const BODY = "\n# Title\n\n## One\n\n" + "Some plain words about what to do. ".repeat(20) + "\n\n## Two\n\nMore words.\n";
const good = (name = "sdlc-demo") => `---\nname: ${name}\ndescription: Use this skill when you want to test the checker, which needs a long enough description.\n---\n${BODY}`;

test("a good skill has no problems", () => {
  assert.deepEqual(validateSkill("sdlc-demo", good()), []);
});

test("missing front matter is reported", () => {
  assert.match(validateSkill("sdlc-demo", BODY)[0], /front matter/);
});

test("broken YAML is reported", () => {
  const text = `---\nname: [oops\ndescription: x\n---\n${BODY}`;
  assert.match(validateSkill("sdlc-demo", text)[0], /not valid YAML/);
});

test("name must match the folder and the pattern", () => {
  assert.ok(validateSkill("sdlc-demo", good("sdlc-other")).some((p) => /must match the folder/.test(p)));
  assert.ok(validateSkill("Demo", good("Demo")).some((p) => /sdlc-something/.test(p)));
});

test("description is required and must be sensible", () => {
  const none = `---\nname: sdlc-demo\n---\n${BODY}`;
  assert.ok(validateSkill("sdlc-demo", none).some((p) => /needs a description/.test(p)));
  const short = `---\nname: sdlc-demo\ndescription: Too short.\n---\n${BODY}`;
  assert.ok(validateSkill("sdlc-demo", short).some((p) => /too short/.test(p)));
});

test("extra front matter keys are rejected", () => {
  const text = good().replace("---\n", "---\nowner: me\n");
  assert.ok(validateSkill("sdlc-demo", text).some((p) => /unexpected front matter key/.test(p)));
});

test("banned words and secret-looking text are rejected", () => {
  assert.ok(validateSkill("sdlc-demo", good() + "\nAsk on Telegram.\n").some((p) => /banned/.test(p)));
  assert.ok(validateSkill("sdlc-demo", good() + "\n123456789:" + "A".repeat(35) + "\n").some((p) => /secret/.test(p)));
});

test("every real skill passes", () => {
  const { count, problems } = validateAll(dirname(fileURLToPath(import.meta.url)));
  assert.equal(count, 8);
  assert.deepEqual(problems, []);
});

// Static checks of template/ (workflows, templates, docs skeletons) and hermes/devin/. No network, no secrets.
//   node tests/template/validate.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
const yaml = { load };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const T = path.join(ROOT, "template");
const read = (rel, base = T) => fs.readFileSync(path.join(base, rel), "utf8");
const exists = (rel, base = T) => fs.existsSync(path.join(base, rel));
const loadYaml = (rel, base = T) => yaml.load(read(rel, base));
const trigger = (wf) => wf.on ?? wf[true]; // "on" can be read as a boolean key by some YAML parsers
const stepsOf = (job) => job.steps ?? [];
const runText = (job) => stepsOf(job).map((s) => s.run ?? "").join("\n");

const WORKFLOWS = ["ci.yml", "deploy.yml", "e2e.yml"].map((f) => `.github/workflows/${f}`);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test("every file the README promises exists", () => {
  const files = [
    ".github/workflows/ci.yml", ".github/workflows/deploy.yml", ".github/workflows/e2e.yml",
    ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/team_sync.md", ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/CODEOWNERS", ".gitleaks.toml", ".gitignore", "README.md", "package.json", "package-lock.json",
    "index.html", "src/greeting.js", "src/greeting.test.js", "e2e/smoke.spec.js", "playwright.config.js",
    "docs/BRD.md", "docs/CONTRACT.md", "docs/PLAN.md",
    "scripts/protect-main.sh", "scripts/setup-repo.sh", "scripts/vercel-deploy.sh", "scripts/publish-url.sh", "scripts/verify-release.sh",
  ];
  for (const f of files) assert.ok(exists(f), `missing template/${f}`);
  const readme = read("README.md");
  for (const f of files.filter((x) => x.startsWith("scripts/") || x.startsWith(".github/workflows/"))) {
    assert.ok(readme.includes(f.replace(/^\.\//, "")), `README does not explain ${f}`);
  }
});

test("scripts are executable", () => {
  for (const f of fs.readdirSync(path.join(T, "scripts"))) {
    assert.ok(fs.statSync(path.join(T, "scripts", f)).mode & 0o111, `scripts/${f} is not executable`);
  }
});

test("all workflows are valid YAML with a name, triggers and jobs", () => {
  for (const f of WORKFLOWS) {
    const wf = loadYaml(f);
    assert.equal(typeof wf.name, "string", f);
    assert.ok(trigger(wf), `${f} has no triggers`);
    assert.ok(Object.keys(wf.jobs ?? {}).length > 0, `${f} has no jobs`);
    for (const [id, job] of Object.entries(wf.jobs)) {
      assert.ok(job["runs-on"], `${f} job ${id} has no runs-on`);
      assert.ok(job["timeout-minutes"], `${f} job ${id} has no timeout`);
    }
    assert.ok(wf.permissions, `${f} must set permissions`);
  }
});

test("every action is pinned to an exact version or a full commit SHA", () => {
  const pinned = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@(v\d+\.\d+\.\d+|[0-9a-f]{40})$/;
  let count = 0;
  for (const f of WORKFLOWS) {
    const wf = loadYaml(f);
    for (const [id, job] of Object.entries(wf.jobs)) {
      for (const s of stepsOf(job)) {
        if (!s.uses) continue;
        count++;
        assert.match(s.uses, pinned, `${f} job ${id}: '${s.uses}' is not pinned to an exact version`);
      }
    }
  }
  assert.ok(count >= 8, "expected several actions");
});

test("run steps never put ${{ }} expressions into shell code", () => {
  for (const f of WORKFLOWS) {
    const wf = loadYaml(f);
    for (const [id, job] of Object.entries(wf.jobs)) {
      for (const s of stepsOf(job)) {
        assert.ok(!/\$\{\{/.test(s.run ?? ""), `${f} job ${id} step '${s.name}': pass values with env:, not inside run:`);
      }
    }
  }
});

test("ci.yml: triggers and the three required jobs", () => {
  const wf = loadYaml(".github/workflows/ci.yml");
  const on = trigger(wf);
  assert.ok("pull_request" in on, "runs on pull requests");
  assert.deepEqual(on.push.branches, ["main"]);
  assert.deepEqual(Object.keys(wf.jobs).sort(), ["build-test", "dep-audit", "secret-scan"]);
  for (const [id, job] of Object.entries(wf.jobs)) assert.equal(job.name, id, "check name equals job id");

  const bt = runText(wf.jobs["build-test"]);
  assert.match(bt, /npm ci/);
  assert.match(bt, /npm run lint --if-present/);
  assert.match(bt, /npm test/);
  assert.match(bt, /npm run build/);
  assert.ok(stepsOf(wf.jobs["build-test"]).some((s) => /^actions\/setup-node@/.test(s.uses ?? "")));

  const scan = stepsOf(wf.jobs["secret-scan"]);
  assert.ok(scan.some((s) => /^gitleaks\/gitleaks-action@/.test(s.uses ?? "")), "gitleaks step");
  const checkout = scan.find((s) => /^actions\/checkout@/.test(s.uses ?? ""));
  assert.equal(checkout.with["fetch-depth"], 0, "gitleaks needs the full history");

  assert.match(runText(wf.jobs["dep-audit"]), /npm audit --omit=dev --audit-level=high/);
});

test("deploy.yml: staging on main, production on release tags or by hand, Vercel secrets", () => {
  const wf = loadYaml(".github/workflows/deploy.yml");
  const on = trigger(wf);
  assert.deepEqual(on.push.branches, ["main"]);
  assert.deepEqual(on.push.tags, ["release-*"]);
  assert.ok(on.workflow_dispatch, "manual run");
  assert.deepEqual(Object.keys(wf.jobs).sort(), ["production", "staging"]);

  const text = read(".github/workflows/deploy.yml");
  for (const s of ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]) {
    assert.match(text, new RegExp(`secrets\\.${s}`), `${s} is read from secrets`);
  }
  assert.match(text, /vercel@\$\{VERCEL_CLI_VERSION\}/);
  assert.match(wf.env.VERCEL_CLI_VERSION, /^\d+\.\d+\.\d+$/, "exact Vercel CLI version");

  const st = wf.jobs.staging;
  assert.equal(st.environment.name, "staging");
  assert.match(st.environment.url, /steps\.deploy\.outputs\.url/);
  assert.match(st.if, /refs\/heads\/main/);
  assert.match(runText(st), /vercel-deploy\.sh staging/);
  assert.match(runText(st), /publish-url\.sh staging/);
  assert.equal(st.permissions.statuses, "write");

  const pr = wf.jobs.production;
  assert.equal(pr.environment.name, "production");
  assert.match(pr.if, /refs\/tags\/release-/);
  assert.match(pr.if, /workflow_dispatch/);
  const names = stepsOf(pr).map((s) => s.run ?? "");
  const iVerify = names.findIndex((r) => /verify-release\.sh/.test(r));
  const iDeploy = names.findIndex((r) => /vercel-deploy\.sh production/.test(r));
  assert.ok(iVerify >= 0 && iDeploy > iVerify, "the QA / CI gate runs before the production deploy");
  assert.match(runText(pr), /publish-url\.sh production/);
  assert.equal(stepsOf(pr).find((s) => /actions\/checkout/.test(s.uses ?? "")).with["fetch-depth"], 0);
});

test("e2e.yml: Playwright against an address, report uploaded", () => {
  const wf = loadYaml(".github/workflows/e2e.yml");
  const on = trigger(wf);
  assert.ok(on.workflow_dispatch.inputs.url, "url input");
  assert.ok(on.workflow_call, "can be called from another workflow");
  const job = wf.jobs.e2e;
  assert.match(runText(job), /npx playwright install/);
  assert.match(runText(job), /npx playwright test/);
  assert.match(runText(job), /staging-url/, "falls back to the staging commit status");
  const test_ = stepsOf(job).find((s) => /playwright test/.test(s.run ?? ""));
  assert.ok(test_.env.E2E_BASE_URL, "passes the address to Playwright");
  const up = stepsOf(job).find((s) => /^actions\/upload-artifact@/.test(s.uses ?? ""));
  assert.ok(up, "uploads an artifact");
  assert.equal(up.if, "${{ always() }}");
  assert.equal(up.with.name, "playwright-report");
});

test("secrets used by workflows are only the documented ones", () => {
  const allowed = new Set(["GITHUB_TOKEN", "VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "GITLEAKS_LICENSE", "VERCEL_AUTOMATION_BYPASS_SECRET"]);
  const readme = read("README.md");
  for (const f of WORKFLOWS) {
    for (const m of read(f).matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      assert.ok(allowed.has(m[1]), `${f} uses undocumented secret ${m[1]}`);
      assert.ok(m[1] === "GITHUB_TOKEN" || readme.includes(m[1]), `README does not list ${m[1]}`);
    }
  }
});

test("branch protection and the release gate require exactly the CI job names", () => {
  const jobs = Object.keys(loadYaml(".github/workflows/ci.yml").jobs).sort();
  const grab = (file, re) => read(file).match(re)[1].split(/[ ,]+/).filter(Boolean).sort();
  assert.deepEqual(grab("scripts/protect-main.sh", /^checks="([^"]+)"/m), jobs);
  assert.deepEqual(grab("scripts/verify-release.sh", /CI_CHECKS:-([^}]+)\}/), jobs);
  assert.match(read("README.md"), /build-test.*secret-scan.*dep-audit/s);
});

test("bug_report.yml is a structured form for QA", () => {
  const f = loadYaml(".github/ISSUE_TEMPLATE/bug_report.yml");
  assert.deepEqual(f.labels, ["bug"]);
  const byId = Object.fromEntries(f.body.map((b) => [b.id, b]));
  for (const id of ["requirement", "severity", "steps", "expected", "actual", "evidence"]) {
    assert.ok(byId[id], `field ${id}`);
    assert.equal(byId[id].validations?.required, true, `${id} is required`);
  }
  assert.deepEqual(byId.severity.attributes.options, ["blocker", "major", "minor"]);
});

test("team sync, pull request template, gitleaks config", () => {
  const sync = read(".github/ISSUE_TEMPLATE/team_sync.md");
  const fm = yaml.load(sync.split("---")[1]);
  assert.equal(fm.title, "Team sync");
  assert.match(fm.labels, /sync/);
  for (const w of ["BLOCKER", "INTERFACE", "READY"]) assert.ok(sync.includes(w));
  const pr = read(".github/PULL_REQUEST_TEMPLATE.md");
  assert.match(pr, /Task id/i);
  assert.match(pr, /What changed/i);
  assert.match(pr, /Tests/);
  const toml = read(".gitleaks.toml");
  assert.match(toml, /useDefault\s*=\s*true/);
  const parsed = execFileSync("python3", ["-c", "import sys,tomllib,json;print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", path.join(T, ".gitleaks.toml")]).toString();
  assert.equal(JSON.parse(parsed).extend.useDefault, true);
});

test("docs skeletons match what the skills expect", () => {
  const brd = read("docs/BRD.md");
  for (const h of ["## Goal", "## Users", "## Business requirements", "## Quality requirements", "## Not included", "## Decisions"]) {
    assert.ok(brd.includes(h), `BRD has ${h}`);
  }
  assert.match(brd, /\| ID \| Requirement \|/);
  assert.match(brd, /BR-01/);
  assert.match(brd, /NFR-01/);
  const c = read("docs/CONTRACT.md");
  ["Overview", "Assumptions", "Stack", "Data model", "API contracts", "Design tokens", "Folder layout", "Requirement map"].forEach((h, i) => {
    assert.ok(new RegExp(`^## ${i + 1}\\. ${h}`, "m").test(c), `CONTRACT section ${i + 1} ${h}`);
  });
  const plan = read("docs/PLAN.md");
  assert.ok((plan.match(/^## Task \d+:/gm) ?? []).length >= 2);
  for (const k of ["assignee:", "requirements:", "files:", "branch:", "done when:"]) assert.ok(plan.includes(k), `PLAN has ${k}`);
  assert.match(plan, /assignee: devin/);
});

test("starter app: exact versions, lock file, test and build scripts", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(v, /^\d+\.\d+\.\d+$/, `${name}@${v} must be an exact version`);
  }
  assert.ok(pkg.scripts.test && pkg.scripts.build, "test and build scripts");
  const lock = JSON.parse(read("package-lock.json"));
  assert.ok(lock.lockfileVersion >= 2);
  assert.equal(lock.packages[""].devDependencies.vite, pkg.devDependencies.vite);
});

test("hermes/devin: MCP config snippet", () => {
  const D = path.join(ROOT, "hermes/devin");
  const snippet = yaml.load(read("config.yaml.snippet", D));
  const devin = snippet.mcp_servers.devin;
  assert.equal(devin.url, "https://mcp.devin.ai/mcp");
  assert.equal(devin.headers.Authorization, "Bearer ${DEVIN_API_KEY}");
  assert.deepEqual([...devin.tools.include].sort(), ["ask_question", "devin_session_*", "read_wiki_*"]);
  assert.ok(!/cog_[A-Za-z0-9]{8,}|apk_[A-Za-z0-9]{8,}/.test(read("config.yaml.snippet", D)), "no real key");
  assert.ok(exists("README.md", D) && exists("devin_poller.py", D));
});

test("no real-looking secrets in template/ or hermes/devin/", () => {
  const bad = [/AKIA[0-9A-Z]{16}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-[A-Za-z0-9]{20,}/,
    /xox[abp]-[A-Za-z0-9-]{10,}/, /cog_[A-Za-z0-9]{20,}/, /apk_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  const files = [...walk(T), ...walk(path.join(ROOT, "hermes/devin"))].filter((f) => !f.endsWith("package-lock.json"));
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const re of bad) assert.ok(!re.test(text), `${path.relative(ROOT, f)} looks like it holds a secret (${re})`);
  }
});

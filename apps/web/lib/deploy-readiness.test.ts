/**
 * Checks that the repository is ready to be deployed on Vercel: settings file, security headers, environment variables,
 * the installer package that the site serves, and that no secret ships. Pure file checks, no network.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildPkg } from "../scripts/build-pkg.mjs";
import { securityHeaders } from "../next.config";

const web = fileURLToPath(new URL("..", import.meta.url));
const repo = join(web, "..", "..");
const read = (p: string) => readFileSync(p, "utf8");

describe("vercel.json", () => {
  const cfg = JSON.parse(read(join(web, "vercel.json")));
  it("builds the workspace from the repository root and uses the lock file", () => {
    expect(cfg.framework).toBe("nextjs");
    expect(cfg.installCommand).toBe("cd ../.. && npm ci");
    expect(cfg.buildCommand).toBe("npm run build");
  });
  it("serves the installer package as plain text", () => {
    const rule = cfg.headers.find((h: { source: string }) => h.source === "/pkg/:path*");
    expect(rule.headers).toContainEqual({ key: "Content-Type", value: "text/plain; charset=utf-8" });
  });
  it("the web app has a prebuild step that creates /pkg", () => {
    const pkg = JSON.parse(read(join(web, "package.json")));
    expect(pkg.scripts.prebuild).toBe("node scripts/build-pkg.mjs");
    expect(read(join(repo, ".gitignore"))).toContain("apps/web/public/pkg/");
  });
});

describe("security headers", () => {
  const byKey = Object.fromEntries(securityHeaders.map((h) => [h.key, h.value]));
  it("are all present", () => {
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["Permissions-Policy"]).toContain("camera=()");
    expect(byKey["Strict-Transport-Security"]).toMatch(/^max-age=\d{8,}/);
    expect(byKey["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });
});

describe("environment variables", () => {
  const example = read(join(web, ".env.example"));
  const active = example
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => l.split("=")[0]);
  it("the example lists exactly the two public settings", () => {
    expect([...active].sort()).toEqual(["NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL"]);
  });
  it("test mode stays commented out in the example", () => {
    expect(example).toMatch(/^# HERMES_TEST_MODE=1/m);
    expect(example).not.toMatch(/^HERMES_TEST_MODE=/m);
  });
  it("no web source reads a service role key or any other server secret", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "test-results", "playwright-report", "public"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.(ts|tsx|mjs|js)$/.test(name) &&
          !/\.test\.|\.spec\.|deploy-readiness/.test(name) &&
          /service[_-]?role|SUPABASE_SECRET|sb_secret_/i.test(read(p))
        )
          hits.push(p);
      }
    };
    walk(web);
    expect(hits).toEqual([]);
  });
});

describe("the installer package under /pkg", () => {
  const dirs: string[] = [];
  const build = (base?: string) => {
    const out = mkdtempSync(join(tmpdir(), "hp-pkg-"));
    dirs.push(out);
    return buildPkg({ out, base });
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("contains the installer, plugin, bridge and the eight skills", () => {
    const { files } = build();
    for (const f of [
      "get_v2.sh",
      "SHA256SUMS",
      "install/install_v2.sh",
      "install/edit_config.py",
      "plugin/hermes-platform/__init__.py",
      "plugin/hermes-platform/plugin.yaml",
      "bridge/platform_bridge.py",
    ]) {
      expect(files).toContain(f);
    }
    expect(files.filter((f) => f.startsWith("skills/") && f.endsWith("/SKILL.md"))).toHaveLength(8);
  });

  it("SHA256SUMS matches every file byte for byte, and the scripts are executable", () => {
    const { out } = build();
    const lines = read(join(out, "SHA256SUMS")).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(13);
    for (const line of lines) {
      const [sum, name] = line.split(/\s+/);
      expect(name).toMatch(/^[A-Za-z0-9._/-]+$/);
      expect(name).not.toContain("..");
      expect(createHash("sha256").update(readFileSync(join(out, name!))).digest("hex")).toBe(sum);
    }
    expect(statSync(join(out, "get_v2.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(out, "install/install_v2.sh")).mode & 0o111).not.toBe(0);
  });

  it("puts the download address into get_v2.sh, and leaves a clear placeholder without one", () => {
    const withBase = build("https://hermes.example.test/pkg/");
    const text = read(join(withBase.out, "get_v2.sh"));
    expect(text).toContain('BASE="${HERMES_PLATFORM_BASE:-https://hermes.example.test/pkg}"');
    expect(text).not.toContain("@@BASE@@");
    expect(read(join(build().out, "get_v2.sh"))).toContain("@@BASE@@");
  });

  it("holds no key, token or private key", () => {
    const { out, files } = build("https://hermes.example.test/pkg");
    const bad = [
      /sb_secret_[A-Za-z0-9_-]{20,}/,
      /sb_publishable_[A-Za-z0-9_-]{20,}/,
      /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /gh[pousr]_[A-Za-z0-9]{30,}/,
      /dzqvokssnvsfhixswhtf/,
    ];
    const hits: string[] = [];
    for (const f of files) for (const re of bad) if (re.test(read(join(out, f)))) hits.push(`${f} matches ${re}`);
    expect(hits).toEqual([]);
    expect(existsSync(join(out, "install/get.sh"))).toBe(false); // the old installer is not shipped
  });
});

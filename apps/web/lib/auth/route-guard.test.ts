import { describe, expect, it } from "vitest";
import { decideAccess, isAssetPath, isPublicPath, sanitizeNext } from "./route-guard";

describe("decideAccess: signed out", () => {
  it.each([
    ["/projects", "", "/login?next=%2Fprojects"],
    ["/projects/abc-123", "", "/login?next=%2Fprojects%2Fabc-123"],
    ["/projects", "?tab=brd", "/login?next=%2Fprojects%3Ftab%3Dbrd"],
    ["/settings/team", "", "/login?next=%2Fsettings%2Fteam"],
    ["/", "", "/login"],
  ])("sends %s%s to %s", (pathname, search, to) => {
    expect(decideAccess({ pathname, search, signedIn: false })).toEqual({ action: "redirect", to });
  });

  it.each(["/login", "/signup", "/forgot-password", "/reset-password", "/auth/callback", "/auth/confirm"])(
    "lets a signed-out person open %s",
    (pathname) => {
      expect(decideAccess({ pathname, signedIn: false })).toEqual({ action: "allow" });
    },
  );

  it.each(["/_next/static/chunks/app.js", "/favicon.ico", "/logo.svg", "/robots.txt"])("lets static file %s through", (p) => {
    expect(decideAccess({ pathname: p, signedIn: false })).toEqual({ action: "allow" });
  });

  it("does not treat look-alike paths as public", () => {
    expect(isPublicPath("/login/../projects")).toBe(false);
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/authx")).toBe(false);
    expect(isPublicPath("/projects/login")).toBe(false);
    expect(decideAccess({ pathname: "/authx", signedIn: false }).action).toBe("redirect");
  });

  it.each(["/pkg/get_v2.sh", "/pkg/SHA256SUMS", "/pkg/skills/sdlc-ba/SKILL.md", "/pkg/install/install_v2.sh"])(
    "lets the installer package %s through without a login",
    (p) => {
      expect(decideAccess({ pathname: p, signedIn: false })).toEqual({ action: "allow" });
    },
  );

  it("only opens the /pkg/ folder, not look-alike pages", () => {
    for (const p of ["/pkg", "/pkgs/x", "/projects/pkg/", "/settings/pkg/x"]) {
      expect(decideAccess({ pathname: p, signedIn: false }).action).toBe("redirect");
    }
  });

  it("does not let a path that only ends like a file skip the check", () => {
    expect(isAssetPath("/projects/secret.txt.html")).toBe(false);
    expect(isAssetPath("/projects/x/y.css")).toBe(true); // static by extension; pages never end like this
  });
});

describe("decideAccess: signed in", () => {
  it("lets a signed-in person open app pages", () => {
    expect(decideAccess({ pathname: "/projects", signedIn: true })).toEqual({ action: "allow" });
    expect(decideAccess({ pathname: "/settings/team", signedIn: true })).toEqual({ action: "allow" });
  });

  it("sends a signed-in person away from the login page, to next when it is safe", () => {
    expect(decideAccess({ pathname: "/login", signedIn: true })).toEqual({ action: "redirect", to: "/projects" });
    expect(decideAccess({ pathname: "/login", search: "?next=%2Fprojects%2F42", signedIn: true })).toEqual({
      action: "redirect",
      to: "/projects/42",
    });
    expect(decideAccess({ pathname: "/login", search: "?next=https%3A%2F%2Fevil.test", signedIn: true })).toEqual({
      action: "redirect",
      to: "/projects",
    });
  });

  it("still lets a signed-in person open reset-password (the recovery link signs them in first)", () => {
    expect(decideAccess({ pathname: "/reset-password", signedIn: true })).toEqual({ action: "allow" });
  });

  it("lets the auth callback run for everyone", () => {
    expect(decideAccess({ pathname: "/auth/callback", signedIn: true })).toEqual({ action: "allow" });
  });
});

describe("sanitizeNext", () => {
  it.each([
    ["/projects", "/projects"],
    ["/projects/abc?x=1#y", "/projects/abc?x=1#y"],
    [null, "/projects"],
    [undefined, "/projects"],
    ["", "/projects"],
    ["https://evil.test", "/projects"],
    ["//evil.test", "/projects"],
    ["/\\evil.test", "/projects"],
    ["/%5Cevil.test", "/%5Cevil.test"],
    ["javascript:alert(1)", "/projects"],
    ["projects", "/projects"],
    ["/login", "/projects"],
    ["/signup", "/projects"],
    ["/path\nwith-newline", "/projects"],
    ["/" + "a".repeat(600), "/projects"],
  ])("%j becomes %j", (input, expected) => {
    expect(sanitizeNext(input as string | null | undefined)).toBe(expected);
  });
});

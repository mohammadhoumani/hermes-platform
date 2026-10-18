/**
 * Who may open which page. Pure functions, used by proxy.ts and unit tested.
 */

export const DEFAULT_AFTER_LOGIN = "/projects";

/** Pages a signed-out person may open. Everything else needs a session. */
const PUBLIC_EXACT = new Set(["/login", "/signup", "/forgot-password", "/reset-password"]);
/** Signed-in people are sent away from these (they make no sense once signed in). */
const GUEST_ONLY = new Set(["/login", "/signup", "/forgot-password"]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || pathname === "/auth" || pathname.startsWith("/auth/");
}

/** Static files that never need a session (the proxy matcher skips most of them already). */
export function isAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    // The installer package behind /pkg/get_v2.sh (open source files, no secrets): the VM downloads it without a login.
    pathname.startsWith("/pkg/") ||
    /\.(?:svg|png|jpe?g|gif|webp|ico|woff2?|css|js|map|txt)$/i.test(pathname)
  );
}

/**
 * Only allow redirects to a path on this site. Blocks "//evil.test", "/\evil.test", "https://evil.test",
 * and "javascript:" style values. Falls back to /projects.
 */
export function sanitizeNext(next: string | null | undefined): string {
  if (!next || next.length > 500) return DEFAULT_AFTER_LOGIN;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return DEFAULT_AFTER_LOGIN;
  if (/[\u0000-\u001f]/.test(next)) return DEFAULT_AFTER_LOGIN;
  try {
    const u = new URL(next, "http://local.invalid");
    if (u.origin !== "http://local.invalid") return DEFAULT_AFTER_LOGIN;
    const path = u.pathname + u.search + u.hash;
    if (GUEST_ONLY.has(u.pathname)) return DEFAULT_AFTER_LOGIN;
    return path;
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
}

export type AccessDecision = { action: "allow" } | { action: "redirect"; to: string };

export function decideAccess(input: { pathname: string; search?: string; signedIn: boolean }): AccessDecision {
  const { pathname, signedIn } = input;
  const search = input.search ?? "";
  if (isAssetPath(pathname)) return { action: "allow" };

  if (isPublicPath(pathname)) {
    if (signedIn && GUEST_ONLY.has(pathname)) {
      const next = pathname === "/login" ? new URLSearchParams(search).get("next") : null;
      return { action: "redirect", to: sanitizeNext(next) };
    }
    return { action: "allow" };
  }

  if (signedIn) return { action: "allow" };

  const here = pathname + search;
  const to = here === "/" || here === "" ? "/login" : `/login?next=${encodeURIComponent(here)}`;
  return { action: "redirect", to };
}

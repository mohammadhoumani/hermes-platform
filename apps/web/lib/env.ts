/**
 * Environment helpers. NEXT_PUBLIC_* values are inlined into the browser bundle at build time,
 * so they must be written out in full (no dynamic lookups).
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

/** Returns null when the app has not been configured, so pages can show a clear message instead of crashing. */
export function getSupabaseEnv(): SupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !/^https?:\/\//i.test(url)) return null;
  return { url, anonKey };
}

/**
 * Test mode: the app serves built-in fixture data and accepts a test cookie as a "session".
 * It can only be on when NODE_ENV is not "production". Next.js sets NODE_ENV to "production" for every
 * `next build` and `next start`, and replaces it with a constant at build time, so this whole branch
 * is removed from production bundles (checked by `npm run check:bundle`).
 */
export function isTestMode(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.HERMES_TEST_MODE === "1";
}

/** Cookie that stands in for a signed-in user in test mode: "owner" or "member". */
export const TEST_USER_COOKIE = "hermes-test-user";

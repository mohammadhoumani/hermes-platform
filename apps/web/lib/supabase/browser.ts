import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";

let cached: SupabaseClient | null = null;

/** Supabase client for the browser. Throws a plain-English error when the app is not configured. */
export function getBrowserSupabase(): SupabaseClient {
  if (cached) return cached;
  const env = getSupabaseEnv();
  if (!env) throw new NotConfiguredError();
  cached = createBrowserClient(env.url, env.anonKey);
  return cached;
}

export class NotConfiguredError extends Error {
  constructor() {
    super("This site is not set up yet. The Supabase settings are missing.");
    this.name = "NotConfiguredError";
  }
}

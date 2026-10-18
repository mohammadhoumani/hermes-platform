import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseEnv, isTestMode } from "./env";

afterEach(() => vi.unstubAllEnvs());

describe("isTestMode", () => {
  it("is on only outside production and only when asked", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("HERMES_TEST_MODE", "1");
    expect(isTestMode()).toBe(true);
    vi.stubEnv("HERMES_TEST_MODE", "");
    expect(isTestMode()).toBe(false);
  });
  it("is never on in production, even if HERMES_TEST_MODE=1", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HERMES_TEST_MODE", "1");
    expect(isTestMode()).toBe(false);
  });
});

describe("getSupabaseEnv", () => {
  it("returns null when settings are missing or not a URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "k");
    expect(getSupabaseEnv()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not-a-url");
    expect(getSupabaseEnv()).toBeNull();
  });
  it("returns both values when set", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "w-test");
    expect(getSupabaseEnv()).toEqual({ url: "https://x.supabase.test", anonKey: "w-test" });
  });
});

import { existsSync } from "node:fs";
import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * Shared Playwright settings. The tests run against `next dev` in test mode (built-in fixture data,
 * fake Supabase settings). Nothing here talks to a real service.
 */
export const PORT = 3100;
export const BASE_URL = `http://localhost:${PORT}`;

/** Use the system Chromium when the one Playwright expects is not installed (see docs/M1_REPORT.md). */
const SYSTEM_CHROMIUM = process.env.HERMES_CHROMIUM ?? "/opt/pw-browsers/chromium";
export const launchOptions = existsSync(SYSTEM_CHROMIUM) ? { executablePath: SYSTEM_CHROMIUM } : {};

export const webServer: PlaywrightTestConfig["webServer"] = {
  command: `npx next dev --port ${PORT}`,
  url: `${BASE_URL}/login`,
  reuseExistingServer: !process.env.CI,
  timeout: 180_000,
  env: {
    HERMES_TEST_MODE: "1",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "w-test-anon-key",
    NEXT_TELEMETRY_DISABLED: "1",
  },
};

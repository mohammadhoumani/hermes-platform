import { defineConfig } from "@playwright/test";
import { BASE_URL, launchOptions, webServer } from "./playwright.base";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, launchOptions, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { viewport: { width: 1280, height: 800 } } }],
  webServer,
});

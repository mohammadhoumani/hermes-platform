import { defineConfig } from "@playwright/test";
import { BASE_URL, launchOptions, webServer } from "./playwright.base";

/** Takes the screenshots for docs/screenshots/. Run with `npm run screenshots`. */
export default defineConfig({
  testDir: "./tests/screenshots",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, launchOptions },
  projects: [{ name: "chromium" }],
  webServer,
});

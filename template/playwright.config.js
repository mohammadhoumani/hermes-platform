import { defineConfig, devices } from "@playwright/test";

// E2E_BASE_URL set     -> test that address (the staging site). Used by .github/workflows/e2e.yml.
// E2E_BASE_URL not set -> build the app and test it on this computer.
const baseURL = process.env.E2E_BASE_URL || "http://localhost:4173";
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Lets the tests through Vercel Deployment Protection when the secret is set.
    extraHTTPHeaders: bypass ? { "x-vercel-protection-bypass": bypass } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npm run build && npm run preview", url: baseURL, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});

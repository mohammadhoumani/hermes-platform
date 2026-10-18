import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Playwright runs from apps/web, so the repo root is two folders up.
const OUT = join(process.cwd(), "..", "..", "docs", "screenshots") + "/";
mkdirSync(OUT, { recursive: true });

const TIP = "11111111-1111-4111-8111-111111111111"; // waiting for the BRD approval
const KANBAN = "22222222-2222-4222-8222-222222222222"; // building

const SIZES = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } } as const;
const SCHEMES = ["light", "dark"] as const;

const PAGES: { name: string; path: string; signedIn: boolean; ready: string }[] = [
  { name: "login", path: "/login", signedIn: false, ready: "form" },
  { name: "projects", path: "/projects", signedIn: true, ready: '[data-testid="project-list"]' },
  { name: "project-room-waiting", path: `/projects/${TIP}`, signedIn: true, ready: '[data-testid="brd-panel"]' },
  { name: "project-room-building", path: `/projects/${KANBAN}`, signedIn: true, ready: '[data-testid="feed"]' },
];

for (const pg of PAGES) {
  for (const [sizeName, size] of Object.entries(SIZES)) {
    for (const scheme of SCHEMES) {
      test(`${pg.name} ${scheme} ${sizeName}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: size, colorScheme: scheme, reducedMotion: "reduce" });
        if (pg.signedIn) await context.addCookies([{ name: "hermes-test-user", value: "member", url: "http://localhost:3100" }]);
        const page = await context.newPage();
        await page.goto(pg.path);
        await page.waitForSelector(pg.ready);
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${OUT}${pg.name}-${scheme}-${sizeName}.png`, fullPage: true });
        await context.close();
      });
    }
  }
}

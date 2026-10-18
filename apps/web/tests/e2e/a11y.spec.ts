import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { KANBAN, RECIPE, signInAs, TIP } from "./helpers";

const PHONE = { width: 360, height: 740 };

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "page is wider than the screen").toBeLessThanOrEqual(0);
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(" | ")})`),
  ).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test("login has no accessibility violations", async ({ page }) => {
      await page.goto("/login");
      await axe(page);
    });

    test("projects list has no accessibility violations", async ({ page, context }) => {
      await signInAs(context, "owner");
      await page.goto("/projects");
      await expect(page.getByTestId("project-card").first()).toBeVisible();
      await axe(page);
    });

    for (const [name, id] of [["waiting", TIP], ["building", KANBAN], ["released", RECIPE]] as const) {
      test(`room (${name}) has no accessibility violations`, async ({ page, context }) => {
        await signInAs(context, "owner");
        await page.goto(`/projects/${id}`);
        await expect(page.getByTestId("room-header")).toBeVisible();
        await axe(page);
      });
    }
  });
}

test.describe("phone width", () => {
  test.use({ viewport: PHONE });

  for (const path of ["/login", "/signup", "/forgot-password"]) {
    test(`${path} fits 360px`, async ({ page }) => {
      await page.goto(path);
      await noHorizontalScroll(page);
    });
  }

  test("projects pages fit 360px", async ({ page, context }) => {
    await signInAs(context, "owner");
    for (const path of ["/projects", "/projects/new", "/settings/team"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await noHorizontalScroll(page);
    }
  });

  for (const [name, id] of [["waiting", TIP], ["building", KANBAN], ["released", RECIPE]] as const) {
    test(`room (${name}) fits 360px with no sideways scroll`, async ({ page, context }) => {
      await signInAs(context, "member");
      await page.goto(`/projects/${id}`);
      await expect(page.getByTestId("room-header")).toBeVisible();
      await page.waitForTimeout(500);
      await noHorizontalScroll(page);
    });
  }

  test("on a phone the BRD comes first while it waits for approval", async ({ page, context }) => {
    await signInAs(context, "member");
    await page.goto(`/projects/${TIP}`);
    const brd = await page.getByTestId("brd-panel").boundingBox();
    const conv = await page.getByTestId("conversation").boundingBox();
    expect(brd && conv && brd.y < conv.y).toBe(true);
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("no transform animation runs and the page is still usable", async ({ page, context }) => {
    await signInAs(context, "member");
    await page.goto(`/projects/${KANBAN}`);
    await expect(page.getByTestId("room-header")).toBeVisible();
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect && (a.effect as KeyframeEffect).getKeyframes().some((k) => "transform" in k)).length);
    expect(running).toBe(0);
    // The page transition wrapper must not be left half-transparent or shifted.
    const style = await page.getByTestId("page-transition").evaluate((el) => ({ o: getComputedStyle(el).opacity, t: getComputedStyle(el).transform }));
    expect(style.o).toBe("1");
    expect(style.t === "none" || style.t === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
  });
});

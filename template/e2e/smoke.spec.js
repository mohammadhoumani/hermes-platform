import { test, expect } from "@playwright/test";

test("the home page loads and shows its message", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("#message")).not.toBeEmpty();
  expect(errors).toEqual([]);
});

test("the page does not scroll sideways", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

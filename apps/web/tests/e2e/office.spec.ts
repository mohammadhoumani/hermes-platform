import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchOptions } from "../../playwright.base";
import { KANBAN, RECIPE, signInAs, TIP, watchErrors } from "./helpers";

/**
 * The 3D office in the project room.
 *
 * Headless Chromium has no GPU. WebGL works through SwiftShader (software rendering) when it is switched on with
 * the flags below. Without them the page still works: it shows the 2D map. See docs/M4_OFFICE_REPORT.md.
 */
const WEBGL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const NO_WEBGL_ARGS = ["--disable-3d-apis", "--disable-gpu", "--disable-webgl", "--disable-webgl2"];

// Playwright runs from apps/web, so the repo root is two folders up.
const SHOTS = join(process.cwd(), "..", "..", "docs", "screenshots") + "/";
mkdirSync(SHOTS, { recursive: true });

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** A strong machine, so the room starts on the 3D office by itself. */
async function strongMachine(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
  });
}

async function openRoom(page: Page, id: string) {
  await page.goto(`/projects/${id}`);
  await expect(page.getByTestId("room-header")).toBeVisible();
}

/** Waits until the first 3D frame is on screen. */
async function waitFor3d(page: Page) {
  await expect(page.getByTestId("office-canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("office-canvas")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  // let the labels, the bubbles and the first light fade settle
  await page.waitForTimeout(700);
}

const stage = (page: Page) => page.getByRole("region", { name: "Who is talking" });

// Every test in this file gets software WebGL, except the one that checks what happens without it.
test.use({ launchOptions: { ...launchOptions, args: WEBGL_ARGS } });

test.describe("3D office with WebGL", () => {
  test.use({ viewport: DESKTOP });

  test("opens by itself on a strong machine, after showing the map", async ({ page, context }) => {
    await signInAs(context, "member");
    await strongMachine(page);
    const watch = watchErrors(page);
    await openRoom(page, TIP);
    await waitFor3d(page);
    await expect(stage(page).getByRole("button", { name: "3D office" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("agent-map")).toHaveCount(0);
    watch.expectNone();
  });

  test("the toggle switches between the map and the 3D office, and remembers the choice", async ({ page, context }) => {
    await signInAs(context, "member");
    // a weak machine: the map first
    await page.addInitScript(() => Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 2 }));
    const watch = watchErrors(page);
    await openRoom(page, TIP);
    await expect(page.getByTestId("agent-map")).toBeVisible();
    await expect(stage(page).getByRole("button", { name: "Map" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("office-hint")).toContainText("looks slow");

    await stage(page).getByRole("button", { name: "3D office" }).click();
    await waitFor3d(page);
    await expect(page.getByTestId("agent-map")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("hermes-office-view"))).toBe("3d");

    // the choice survives a reload, even on the weak machine
    await page.reload();
    await waitFor3d(page);

    await stage(page).getByRole("button", { name: "Map" }).click();
    await expect(page.getByTestId("agent-map")).toBeVisible();
    await expect(page.getByTestId("office-canvas")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("hermes-office-view"))).toBe("map");
    await page.reload();
    await expect(page.getByTestId("agent-map")).toBeVisible();
    watch.expectNone();
  });

  test("does not download three.js until the 3D office is wanted", async ({ page, context }) => {
    await signInAs(context, "member");
    await page.addInitScript(() => Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 2 }));
    const scripts: Awaited<ReturnType<Page["waitForResponse"]>>[] = [];
    page.on("response", (r) => {
      if (r.request().resourceType() === "script") scripts.push(r);
    });
    const carriesThree = async () => {
      let found = 0;
      for (const r of scripts) {
        const body = await r.text().catch(() => "");
        if (body.includes("WebGLRenderer")) found++;
      }
      return found;
    };
    await openRoom(page, TIP);
    await expect(page.getByTestId("agent-map")).toBeVisible();
    await page.waitForTimeout(1000);
    expect(await carriesThree(), "scripts with three.js before the 3D office was opened").toBe(0);

    await stage(page).getByRole("button", { name: "3D office" }).click();
    await waitFor3d(page);
    expect(await carriesThree(), "scripts with three.js after").toBeGreaterThan(0);
  });

  test("the canvas has a label, there is a live text summary, and every control can be reached with the keyboard", async ({ page, context }) => {
    await signInAs(context, "member");
    await strongMachine(page);
    await openRoom(page, TIP);
    await waitFor3d(page);

    const canvas = page.getByTestId("office-canvas");
    await expect(canvas).toHaveAttribute("role", "img");
    await expect(canvas).toHaveAttribute("aria-label", /3D virtual office/);

    const live = page.getByTestId("office-live");
    await expect(live).toHaveAttribute("role", "status");
    await expect(live).toContainText("waiting for you to approve the BRD");
    await expect(live).toContainText("Phase 1 of 6: Discovery");
    // visually hidden, but in the page for screen readers
    const box = await live.boundingBox();
    expect((box?.width ?? 0) <= 1 && (box?.height ?? 0) <= 1).toBe(true);
    await expect(stage(page).getByRole("list", { name: "Who is doing what in the office" }).getByRole("listitem")).toHaveCount(11);

    // Tab reaches both view buttons and all five camera buttons
    const names = ["3D office", "Map", "Turn left", "Turn right", "Zoom in", "Zoom out", "Reset view"];
    await stage(page).getByRole("button", { name: names[0]! }).focus();
    for (const name of names.slice(1)) {
      await page.keyboard.press("Tab");
      await expect(stage(page).getByRole("button", { name })).toBeFocused();
    }
    // and a camera button works from the keyboard without breaking the scene
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(canvas).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`the room with the 3D office open has no accessibility violations (${scheme})`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: DESKTOP, colorScheme: scheme });
      await signInAs(context, "member");
      const page = await context.newPage();
      await strongMachine(page);
      await openRoom(page, TIP);
      await waitFor3d(page);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(" | ")})`)).toEqual([]);
      await context.close();
    });
  }

  test("falls back to the map if the graphics context is lost", async ({ page, context }) => {
    await signInAs(context, "member");
    await strongMachine(page);
    await openRoom(page, TIP);
    await waitFor3d(page);
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
      const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    });
    await expect(page.getByTestId("agent-map")).toBeVisible();
    await expect(page.getByTestId("office-hint")).toContainText("stopped working");
    await expect(page.getByTestId("office-canvas")).toHaveCount(0);
  });

  test("an agent that needs you is shown in rose, with a bubble at the BA", async ({ page, context }) => {
    await signInAs(context, "member");
    await strongMachine(page);
    await openRoom(page, TIP);
    await waitFor3d(page);
    const rose = stage(page).locator('[data-office-label][data-visual="needs-you"]');
    await expect(rose).toHaveCount(2); // the BA and the You spot
    await expect(rose.filter({ hasText: "You" })).toHaveCount(1);
    await expect(stage(page).locator('[data-office-bubble][data-tone="attention"]')).toContainText("approve");
  });

  test("it follows the live events: approving the BRD moves the sign and sends the BA to the Architect", async ({ page, context }) => {
    await signInAs(context, "member");
    await strongMachine(page);
    await openRoom(page, TIP);
    await waitFor3d(page);
    await page.getByTestId("approve-brd").click();
    await expect(page.getByTestId("office-live")).toContainText(/handing work to Architect/, { timeout: 15_000 });
    await expect(stage(page).locator("[data-office-sign]")).toHaveText("Phase 2 of 6: Architecture");
    await expect(stage(page).locator('[data-office-label][data-visual="needs-you"]')).toHaveCount(0);
  });

  test("keeps the page free of sideways scroll on a phone", async ({ page, context }) => {
    await signInAs(context, "member");
    await page.setViewportSize({ width: 360, height: 740 });
    await strongMachine(page);
    await openRoom(page, KANBAN);
    await waitFor3d(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("stops drawing when the page is hidden, and draws nothing while nothing happens", async ({ page, context }) => {
    await signInAs(context, "member");
    await strongMachine(page);
    // count the animation frames the page asks for
    await page.addInitScript(() => {
      const w = window as unknown as { __frames: number };
      w.__frames = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => {
        w.__frames++;
        return raf(cb);
      };
    });
    const frames = () => page.evaluate(() => (window as unknown as { __frames: number }).__frames);

    // A finished project: nobody is working, so the scene is drawn once and then left alone.
    await openRoom(page, RECIPE);
    await waitFor3d(page);
    await stage(page).scrollIntoViewIfNeeded();
    await expect(page.getByTestId("office-3d")).toHaveAttribute("data-paused", "no");
    await page.waitForTimeout(500);
    const before = await frames();
    await page.waitForTimeout(2500);
    const idleFrames = (await frames()) - before;
    expect(idleFrames, "frames asked for while idle").toBeLessThanOrEqual(6);

    // A busy project keeps drawing (the glow pulses)...
    await openRoom(page, KANBAN);
    await waitFor3d(page);
    await stage(page).scrollIntoViewIfNeeded();
    const busyBefore = await frames();
    await page.waitForTimeout(2500);
    // (software WebGL is slow, so the count is low on a busy machine; it only has to be clearly above "idle")
    expect((await frames()) - busyBefore, "frames asked for while agents work").toBeGreaterThan(idleFrames + 3);

    // ...until the tab is hidden.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByTestId("office-3d")).toHaveAttribute("data-paused", "yes");
  });
});

test.describe("screenshots of the 3D office", () => {
  const shots: { name: string; id: string; size: typeof DESKTOP; scheme: "light" | "dark" }[] = [
    { name: "office-waiting-light-desktop", id: TIP, size: DESKTOP, scheme: "light" },
    { name: "office-waiting-dark-desktop", id: TIP, size: DESKTOP, scheme: "dark" },
    { name: "office-building-light-desktop", id: KANBAN, size: DESKTOP, scheme: "light" },
    { name: "office-building-dark-desktop", id: KANBAN, size: DESKTOP, scheme: "dark" },
    { name: "office-live-light-desktop", id: RECIPE, size: DESKTOP, scheme: "light" },
    { name: "office-building-light-phone", id: KANBAN, size: PHONE, scheme: "light" },
    { name: "office-waiting-dark-phone", id: TIP, size: PHONE, scheme: "dark" },
  ];

  for (const shot of shots) {
    test(shot.name, async ({ browser }) => {
      const context = await browser.newContext({ viewport: shot.size, colorScheme: shot.scheme });
      await signInAs(context, "member");
      const page = await context.newPage();
      await strongMachine(page);
      await openRoom(page, shot.id);
      await waitFor3d(page);
      await stage(page).scrollIntoViewIfNeeded();
      await stage(page).screenshot({ path: `${SHOTS}${shot.name}.png` });
      await context.close();
    });
  }
});

test.describe("fallback to the 2D map", () => {
  test.describe("when WebGL is not available", () => {
    test("shows the map, explains why, and does not offer the 3D button", async () => {
      // its own browser, started without any WebGL
      const browser = await chromium.launch({ ...launchOptions, args: NO_WEBGL_ARGS });
      const context = await browser.newContext({ viewport: DESKTOP });
      await signInAs(context, "member");
      const page = await context.newPage();
      await strongMachine(page);
      // even a saved "3d" cannot turn it on
      await page.addInitScript(() => localStorage.setItem("hermes-office-view", "3d"));
      const watch = watchErrors(page);
      await openRoom(page, TIP);
      await expect(page.getByTestId("agent-map")).toBeVisible();
      await expect(page.getByTestId("office-hint")).toContainText("needs WebGL");
      await expect(stage(page).getByRole("button", { name: "3D office" })).toBeDisabled();
      await expect(stage(page).getByRole("button", { name: "Map" })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("office-canvas")).toHaveCount(0);
      watch.expectNone();
      await browser.close();
    });
  });

  test.describe("when the user asks for less motion", () => {
    test.use({ viewport: DESKTOP, reducedMotion: "reduce" });

    test("starts on the map, and the 3D office can be opened but stays still", async ({ page, context }) => {
      await signInAs(context, "member");
      await strongMachine(page);
      const watch = watchErrors(page);
      await openRoom(page, KANBAN);
      await expect(page.getByTestId("agent-map")).toBeVisible();
      await expect(page.getByTestId("office-hint")).toContainText("less motion");

      await stage(page).getByRole("button", { name: "3D office" }).click();
      await waitFor3d(page);
      await expect(page.getByTestId("office-3d")).toHaveAttribute("data-reduced", "yes");
      await expect(page.getByTestId("office-hint")).toContainText("stays still");
      // two screenshots a moment apart are identical: nothing pulses or moves
      const first = await page.getByTestId("office-canvas").screenshot();
      await page.waitForTimeout(900);
      const second = await page.getByTestId("office-canvas").screenshot();
      expect(second.equals(first)).toBe(true);
      watch.expectNone();
    });
  });

  test.describe("on a weak device", () => {
    test.use({ viewport: DESKTOP });

    test("starts on the map because of the memory size", async ({ page, context }) => {
      await signInAs(context, "member");
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 16 });
        Object.defineProperty(navigator, "deviceMemory", { get: () => 2 });
      });
      await openRoom(page, TIP);
      await expect(page.getByTestId("agent-map")).toBeVisible();
      await expect(stage(page).getByRole("button", { name: "3D office" })).toBeEnabled();
    });
  });
});

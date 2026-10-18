import { expect, test } from "@playwright/test";
import { KANBAN, RECIPE, signInAs, TIP, watchErrors } from "./helpers";

test.beforeEach(async ({ context }) => {
  await signInAs(context, "member");
});

test("projects list shows every project with a plain status", async ({ page }) => {
  const watch = watchErrors(page);
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible();
  const cards = page.getByTestId("project-card");
  await expect(cards).toHaveCount(7);
  await expect(cards.filter({ hasText: "Tip Calculator" })).toContainText("Needs your OK");
  await expect(cards.filter({ hasText: "Tip Calculator" })).toContainText("Started by you");
  watch.expectNone();
});

test("new project: needs an idea, derives a name, opens the room", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByTestId("start-project").click();
  await expect(page.getByText("Describe your idea first, even in one sentence.")).toBeVisible();
  await page.getByLabel("Your idea").fill("a page that converts miles to kilometres for runners");
  await page.getByTestId("start-project").click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
});

test("unknown or malformed project ids show the not found page", async ({ page }) => {
  await page.goto("/projects/not-a-real-id");
  await expect(page.getByText("We could not find that page")).toBeVisible();
  // The page streams, so the HTTP status is already 200; Next adds a noindex tag instead.
  await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
  await page.goto("/projects/99999999-9999-4999-8999-999999999999");
  await expect(page.getByText("We could not find that page")).toBeVisible();
});

test.describe("the room", () => {
  test("waiting for approval: Approve BRD is the only approval button", async ({ page }) => {
    const watch = watchErrors(page);
    await page.goto(`/projects/${TIP}`);
    await expect(page.getByTestId("room-header").getByRole("heading", { level: 1, name: "Tip Calculator" })).toBeVisible();
    await expect(page.getByTestId("brd-panel")).toBeVisible();
    await expect(page.getByTestId("phase-rail")).toBeVisible();
    await expect(page.getByTestId("agent-map")).toBeVisible();

    // Exactly one control approves anything, and it lives in the BRD panel.
    await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(1);
    await expect(page.getByTestId("approve-brd")).toHaveText(/Approve BRD/);
    await expect(page.getByTestId("conversation").getByRole("button", { name: /approve/i })).toHaveCount(0);

    // The booby-trapped BRD text is shown as text and never runs.
    expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
    await expect(page.getByTestId("brd-panel").locator("script")).toHaveCount(0);
    await expect(page.getByTestId("brd-panel").locator("[onerror]")).toHaveCount(0);
    await expect(page.getByTestId("brd-panel").locator('a[href^="javascript:"]')).toHaveCount(0);
    watch.expectNone();
  });

  test("approving the BRD moves the project on", async ({ page }) => {
    await page.goto(`/projects/${TIP}`);
    await page.getByTestId("approve-brd").click();
    await expect(page.getByTestId("brd-panel")).toContainText("Approved");
    await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(0);
  });

  test("sending a message shows it in the conversation", async ({ page }) => {
    await page.goto(`/projects/${KANBAN}`);
    const box = page.getByTestId("reply-box");
    await expect(page.getByTestId("send-reply")).toBeDisabled();
    await box.fill("Please make the buttons bigger.");
    await page.getByTestId("send-reply").click();
    await expect(page.getByTestId("conversation")).toContainText("Please make the buttons bigger.");
  });

  test("stop asks first, then stops; resume brings it back", async ({ page }) => {
    await page.goto(`/projects/${KANBAN}`);
    await page.getByTestId("stop").click();
    await page.getByTestId("confirm-stop").click();
    await expect(page.getByTestId("resume")).toBeVisible();
    await expect(page.getByText("This project is stopped. Resume it to send messages.")).toBeVisible();
    await page.getByTestId("resume").click();
    await expect(page.getByTestId("stop")).toBeVisible();
  });

  test("a released project shows the release card with links", async ({ page }) => {
    await page.goto(`/projects/${RECIPE}`);
    const card = page.getByTestId("release-card");
    await expect(card).toBeVisible();
    await expect(card.getByRole("link").first()).toHaveAttribute("href", /^https:\/\//);
  });

  test("change request box is available once released", async ({ page }) => {
    await page.goto(`/projects/${RECIPE}`);
    await page.getByLabel(/change/i).first().fill("Add a dark mode.");
    await page.getByTestId("send-change").click();
    await expect(page.getByText("Add a dark mode.").first()).toBeVisible();
  });

  test("the connection badge is shown", async ({ page }) => {
    await page.goto(`/projects/${KANBAN}`);
    await expect(page.getByTestId("connection")).toBeVisible();
  });
});

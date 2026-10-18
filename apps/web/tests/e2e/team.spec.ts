import { expect, test } from "@playwright/test";
import { signInAs, watchErrors } from "./helpers";

test.describe("team: removing access", () => {
  test("an owner removes a member after a confirmation and gives the access back", async ({ page, context }) => {
    const watch = watchErrors(page);
    await signInAs(context, "owner");
    await page.goto("/settings/team");
    const mia = page.getByTestId("member-row").filter({ hasText: "mia.maker@example.test" });
    await expect(mia).toContainText("Active");

    // first press only asks
    await mia.getByRole("button", { name: "Remove access for Mia Maker" }).click();
    const confirm = page.getByRole("group", { name: "Confirm removing Mia Maker" });
    await expect(confirm).toContainText("Their projects are kept");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(mia).toContainText("Active");

    // second time: really remove
    await mia.getByRole("button", { name: "Remove access for Mia Maker" }).click();
    await page.getByRole("button", { name: "Yes, remove access for Mia Maker" }).click();
    await expect(page.getByText(/Mia Maker can no longer sign in/)).toBeVisible();
    await expect(mia).toContainText("Access removed");
    await expect(mia.getByRole("button", { name: /^Remove access/ })).toHaveCount(0);

    // and back
    await mia.getByRole("button", { name: "Give access back to Mia Maker" }).click();
    await expect(page.getByText("Mia Maker has access again.")).toBeVisible();
    await expect(mia).toContainText("Active");
    watch.expectNone();
  });

  test("you cannot remove yourself or another owner", async ({ page, context }) => {
    await signInAs(context, "owner");
    await page.goto("/settings/team");
    const me = page.getByTestId("member-row").filter({ hasText: "olivia.owner@example.test" });
    await expect(me).toContainText("(you)");
    await expect(me.getByRole("button")).toHaveCount(0);
    await expect(me).toContainText("Active");
    const other = page.getByTestId("member-row").filter({ hasText: "oscar.owner@example.test" });
    await expect(other).toBeVisible();
    await expect(other.getByRole("button")).toHaveCount(0);
  });

  test("pending invites can be taken back, joined people are not listed there", async ({ page, context }) => {
    await signInAs(context, "owner");
    await page.goto("/settings/team");
    const invites = page.getByTestId("invite-row");
    await expect(invites).toHaveCount(1);
    await expect(invites.first()).toContainText("pat.pending@example.test");
    await invites.first().getByRole("button", { name: /remove the invite/i }).click();
    await expect(page.getByText("Removed the invite for pat.pending@example.test.")).toBeVisible();
    await expect(page.getByText(/No invites are waiting/)).toBeVisible();
  });

  test("a member sees no team tools at all", async ({ page, context }) => {
    await signInAs(context, "member");
    await page.goto("/settings/team");
    await expect(page.getByText("Only owners can manage the team")).toBeVisible();
    await expect(page.getByTestId("member-row")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Team" })).toHaveCount(0);
  });
});

test.describe("a person whose access was removed", () => {
  test("sees one clear notice on every page, and can sign out", async ({ page, context }) => {
    const watch = watchErrors(page);
    await signInAs(context, "removed");
    for (const path of ["/projects", "/projects/new", "/settings/team", "/projects/11111111-1111-4111-8111-111111111111"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Your access has been removed" })).toBeVisible();
      await expect(page.getByText("Ask a team owner if this is a mistake.")).toBeVisible();
      await expect(page.getByTestId("project-card")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Projects" })).toHaveCount(0);
    }
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    watch.expectNone();
  });
});

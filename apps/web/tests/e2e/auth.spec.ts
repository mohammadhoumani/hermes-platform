import { expect, test } from "@playwright/test";
import { signInAs, watchErrors } from "./helpers";

test.describe("signed out", () => {
  test("login form validates in plain English and logs no errors", async ({ page }) => {
    const watch = watchErrors(page);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /sign in/i, level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await expect(page.getByText("Enter your password.")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeFocused();

    await page.getByLabel("Email").fill("not-an-email");
    await page.getByLabel("Password").fill("x");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter a valid email address, like name@example.com.")).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");

    watch.expectNone();
  });

  test("protected pages send you to /login with a safe ?next=", async ({ page }) => {
    await page.goto("/projects/new");
    await expect(page).toHaveURL(/\/login\?next=%2Fprojects%2Fnew$/);
    await page.goto("/settings/team");
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fteam$/);
  });

  test("the sign up page says Hermes is invite only", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByText("Hermes is invite only")).toBeVisible();
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page.getByText("Enter your name.")).toBeVisible();
  });

  test("forgot and reset password pages load without errors", async ({ page }) => {
    const watch = watchErrors(page);
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByRole("button", { name: /send/i }).click();
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await page.goto("/reset-password");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    watch.expectNone();
  });
});

test.describe("signed in", () => {
  test("a signed-in person is sent away from /login to /projects", async ({ page, context }) => {
    await signInAs(context, "member");
    await page.goto("/login");
    await expect(page).toHaveURL(/\/projects$/);
  });

  test("members cannot manage the team, owners can", async ({ page, context }) => {
    await signInAs(context, "member");
    await page.goto("/settings/team");
    await expect(page.getByText("Only owners can manage the team")).toBeVisible();

    await signInAs(context, "owner");
    await page.goto("/settings/team");
    await expect(page.getByRole("heading", { name: "Invite someone" })).toBeVisible();
  });

  test("owner can invite and remove an invite", async ({ page, context }) => {
    await signInAs(context, "owner");
    await page.goto("/settings/team");
    await page.getByRole("button", { name: "Send invite" }).click();
    await expect(page.getByText("Enter your email address.")).toBeVisible();

    await page.getByLabel("Email address").fill("New.Person@example.test");
    await page.getByRole("button", { name: "Send invite" }).click();
    await expect(page.getByText("Invited new.person@example.test.", { exact: false })).toBeVisible();
    const row = page.getByTestId("invite-row").filter({ hasText: "new.person@example.test" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /remove the invite/i }).click();
    await expect(page.getByText("Removed the invite for new.person@example.test.")).toBeVisible();
    await expect(row).toHaveCount(0);
  });

  test("sign out returns to the login page", async ({ page, context }) => {
    await signInAs(context, "member");
    await page.goto("/projects");
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

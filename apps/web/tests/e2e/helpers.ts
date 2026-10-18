import { expect, type BrowserContext, type Page } from "@playwright/test";

export const TIP = "11111111-1111-4111-8111-111111111111";
export const KANBAN = "22222222-2222-4222-8222-222222222222";
export const RECIPE = "33333333-3333-4333-8333-333333333333";

/** Test mode: a cookie stands in for being signed in. */
/** "removed" is a member whose access a team owner took away. */
export async function signInAs(context: BrowserContext, role: "owner" | "member" | "removed") {
  await context.addCookies([{ name: "hermes-test-user", value: role, url: "http://localhost:3100" }]);
}

/** Collects console errors and uncaught page errors so a test can assert there were none. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return {
    errors,
    expectNone: () => expect(errors, errors.join("\n")).toEqual([]),
  };
}

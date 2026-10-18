import { describe, expect, it } from "vitest";
import { describeAuthError, describeDataError, NOT_INVITED_MESSAGE } from "./messages";
import { validateConfirm, validateEmail, validateName, validateNewPassword, validatePassword } from "./validate";

describe("describeAuthError", () => {
  it("explains the invite trigger in plain words on sign-up", () => {
    expect(describeAuthError({ message: "Database error saving new user", status: 500 }, "signup")).toBe(NOT_INVITED_MESSAGE);
    expect(describeAuthError({ message: "This email has not been invited. Ask the team owner to invite you." }, "signup")).toBe(NOT_INVITED_MESSAGE);
    expect(describeAuthError({ code: "unexpected_failure", status: 500, message: "x" }, "signup")).toBe(NOT_INVITED_MESSAGE);
  });
  it("does not blame the invite list when signing in", () => {
    expect(describeAuthError({ message: "Database error saving new user" }, "signin")).toBe("Something went wrong. Please try again.");
  });
  it("handles wrong passwords and unconfirmed emails", () => {
    expect(describeAuthError({ code: "invalid_credentials", message: "Invalid login credentials" }, "signin")).toMatch(/do not match/);
    expect(describeAuthError({ code: "email_not_confirmed", message: "Email not confirmed" }, "signin")).toMatch(/confirm your email/);
  });
  it("handles an existing account, a weak password and rate limits", () => {
    expect(describeAuthError({ message: "User already registered" }, "signup")).toMatch(/already has an account/);
    expect(describeAuthError({ code: "weak_password", message: "Password should be at least 6 characters" }, "signup")).toMatch(/stronger password/);
    expect(describeAuthError({ status: 429, message: "x" }, "reset")).toMatch(/Too many tries/);
  });
  it("handles network failures", () => {
    expect(describeAuthError({ name: "AuthRetryableFetchError", message: "fetch failed", status: 0 }, "signin")).toMatch(/could not reach/);
    expect(describeAuthError(new TypeError("Failed to fetch"), "signin")).toMatch(/could not reach/);
  });
  it("handles a missing configuration", () => {
    const err = Object.assign(new Error("x"), { name: "NotConfiguredError" });
    expect(describeAuthError(err, "signin")).toMatch(/not set up yet/);
  });
  it("handles an expired reset link", () => {
    expect(describeAuthError({ message: "Auth session missing!" }, "update")).toMatch(/reset link has expired/);
    expect(describeAuthError({ code: "otp_expired", message: "Email link is invalid or has expired" }, "reset")).toMatch(/expired/);
  });
  it("never leaks a raw message for unknown errors", () => {
    expect(describeAuthError({ message: "pg: relation foo does not exist" }, "signin")).toBe("Something went wrong. Please try again.");
    expect(describeAuthError(undefined, "signin")).toBe("Something went wrong. Please try again.");
    expect(describeAuthError(42, "signin")).toBe("Something went wrong. Please try again.");
  });
});

describe("describeDataError", () => {
  it("explains the order rate limit", () => {
    expect(describeDataError({ code: "54000", message: "Too many orders. Please wait a few minutes and try again." })).toMatch(/too fast/);
  });
  it("explains permission errors", () => {
    expect(describeDataError({ code: "42501", message: "new row violates row-level security policy" })).toBe("You are not allowed to do that.");
  });
  it("explains empty and long text", () => {
    expect(describeDataError({ code: "23514", message: 'violates check constraint "orders_text_required"' })).toMatch(/write a message/);
    expect(describeDataError({ code: "23514", message: 'violates check constraint "orders_text_check"' })).toMatch(/too long/);
  });
  it("passes through the plain messages written in the database for create_project", () => {
    expect(describeDataError({ code: "22023", message: "Give your project a name (1 to 120 characters)." })).toMatch(/Give your project a name/);
  });
  it("hides raw errors", () => {
    expect(describeDataError({ code: "XX000", message: "boom internal detail" })).toBe("Something went wrong. Please try again.");
  });
});

describe("form validation", () => {
  it("validates emails", () => {
    expect(validateEmail("")).toMatch(/Enter your email/);
    expect(validateEmail("nope")).toMatch(/valid email/);
    expect(validateEmail("a@b")).toMatch(/valid email/);
    expect(validateEmail(" me@example.com ")).toBeNull();
    expect(validateEmail("a".repeat(250) + "@x.co")).toMatch(/valid email/);
  });
  it("validates passwords", () => {
    expect(validatePassword("")).toMatch(/Enter your password/);
    expect(validatePassword("x")).toBeNull();
    expect(validateNewPassword("")).toMatch(/Choose a password/);
    expect(validateNewPassword("short")).toMatch(/at least 8/);
    expect(validateNewPassword("long enough")).toBeNull();
    expect(validateNewPassword("x".repeat(73))).toMatch(/72/);
  });
  it("validates the confirmation and the name", () => {
    expect(validateConfirm("abc12345", "")).toMatch(/again/);
    expect(validateConfirm("abc12345", "abc12346")).toMatch(/do not match/);
    expect(validateConfirm("abc12345", "abc12345")).toBeNull();
    expect(validateName("  ")).toMatch(/Enter your name/);
    expect(validateName("Sam")).toBeNull();
  });
});

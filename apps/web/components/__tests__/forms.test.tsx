// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push, refresh }) }));

const signInWithPassword = vi.fn();
const signUp = vi.fn();
vi.mock("@/lib/supabase/browser", () => ({ getBrowserSupabase: () => ({ auth: { signInWithPassword, signUp } }) }));

const createProject = vi.fn();
vi.mock("@/lib/backend/browser", () => ({ loadBrowserBackend: async () => ({ createProject }) }));

import { LoginForm } from "@/components/auth/login-form";
import { SignupForm } from "@/components/auth/signup-form";
import { NewProjectForm } from "@/components/projects/new-project-form";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LoginForm", () => {
  it("checks both fields before sending anything", async () => {
    render(<LoginForm next={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter your email address.")).toBeInTheDocument();
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Email/)).toHaveFocus();
  });

  it("signs in and goes to the safe ?next= page", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    render(<LoginForm next="/projects/abc" />);
    await userEvent.type(screen.getByLabelText(/^Email/), "a@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "secret-pass");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/projects/abc"));
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "a@example.test", password: "secret-pass" });
  });

  it("ignores an unsafe ?next= and goes to /projects", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    render(<LoginForm next="https://evil.test/x" />);
    await userEvent.type(screen.getByLabelText(/^Email/), "a@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "secret-pass");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/projects"));
  });

  it("shows a plain message when the password is wrong", async () => {
    signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials", status: 400 } });
    render(<LoginForm next={null} />);
    await userEvent.type(screen.getByLabelText(/^Email/), "a@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/email and password do not match/i);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("SignupForm", () => {
  it("tells people the invite rules when the email was not invited", async () => {
    signUp.mockResolvedValue({ data: {}, error: { message: "Database error saving new user", status: 500 } });
    render(<SignupForm />);
    await userEvent.type(screen.getByLabelText("Your name"), "Sam");
    await userEvent.type(screen.getByLabelText(/^Email/), "sam@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "long-enough-1");
    await userEvent.type(screen.getByLabelText("Type the password again"), "long-enough-1");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invite/i);
  });

  it("checks that the two passwords match", async () => {
    render(<SignupForm />);
    await userEvent.type(screen.getByLabelText("Your name"), "Sam");
    await userEvent.type(screen.getByLabelText(/^Email/), "sam@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "long-enough-1");
    await userEvent.type(screen.getByLabelText("Type the password again"), "different-pass");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(screen.getByText("The two passwords do not match.")).toBeInTheDocument();
    expect(signUp).not.toHaveBeenCalled();
  });
});

describe("NewProjectForm", () => {
  it("asks for an idea first", async () => {
    render(<NewProjectForm testRole={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Start project" }));
    expect(screen.getByText("Describe your idea first, even in one sentence.")).toBeInTheDocument();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("makes a name from the idea when the name is empty, then opens the room", async () => {
    createProject.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    render(<NewProjectForm testRole={null} />);
    await userEvent.type(screen.getByLabelText("Your idea"), "a page that converts miles to kilometres");
    await userEvent.click(screen.getByRole("button", { name: "Start project" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/11111111-1111-4111-8111-111111111111"));
    expect(createProject).toHaveBeenCalledWith("A Page That Converts Miles", "a page that converts miles to kilometres");
  });

  it("uses the name when one is typed", async () => {
    createProject.mockResolvedValue("22222222-2222-4222-8222-222222222222");
    render(<NewProjectForm testRole={null} />);
    await userEvent.type(screen.getByLabelText("Your idea"), "something small");
    await userEvent.type(screen.getByLabelText(/Project name/), "Mile Converter");
    await userEvent.click(screen.getByRole("button", { name: "Start project" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith("Mile Converter", "something small"));
  });
});

// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureBackend } from "@/lib/backend/fixture";
import { FIXTURE_USERS } from "@/lib/backend/fixture-data";
import { BackendError } from "@/lib/backend/types";

let backend = createFixtureBackend("owner", { stepMs: 0 });
vi.mock("@/lib/backend/browser", () => ({ loadBrowserBackend: async () => backend }));

import { TeamManager } from "@/components/team/team-manager";

async function mount() {
  const [invites, members] = await Promise.all([backend.listInvites(), backend.listMembers()]);
  render(<TeamManager initialInvites={invites} initialMembers={members} meId={FIXTURE_USERS.owner.id} testRole="owner" />);
}
const row = (name: RegExp | string) => screen.getAllByTestId("member-row").find((r) => within(r).queryByText(name))!;

beforeEach(() => {
  backend = createFixtureBackend("owner", { stepMs: 0 });
});

describe("TeamManager: people", () => {
  it("lists everybody with the right buttons", async () => {
    await mount();
    expect(screen.getAllByTestId("member-row")).toHaveLength(4);
    // you and the other owner cannot be removed; members can
    expect(within(row("Olivia Owner")).queryByRole("button", { name: /remove access/i })).toBeNull();
    expect(within(row("Olivia Owner")).getByText("(you)")).toBeInTheDocument();
    expect(within(row("Oscar Owner")).queryByRole("button", { name: /remove access/i })).toBeNull();
    expect(within(row("Mia Maker")).getByRole("button", { name: "Remove access for Mia Maker" })).toBeInTheDocument();
    expect(within(row("Sam Member")).getByText(/7 projects/)).toBeInTheDocument();
  });

  it("asks before removing, and Cancel changes nothing", async () => {
    await mount();
    await userEvent.click(within(row("Mia Maker")).getByRole("button", { name: "Remove access for Mia Maker" }));
    const group = screen.getByRole("group", { name: "Confirm removing Mia Maker" });
    expect(group).toHaveTextContent(/projects are kept/i);
    await userEvent.click(within(group).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: /confirm removing/i })).toBeNull();
    expect((await backend.listMembers()).find((m) => m.email === "mia.maker@example.test")!.disabledAt).toBeNull();
  });

  it("removes access after the confirmation, shows it, and can give it back", async () => {
    await mount();
    await userEvent.click(within(row("Mia Maker")).getByRole("button", { name: "Remove access for Mia Maker" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, remove access for Mia Maker" }));
    expect(await screen.findByText(/Mia Maker can no longer sign in/)).toBeInTheDocument();
    const r = row("Mia Maker");
    await waitFor(() => expect(within(r).getByText("Access removed")).toBeInTheDocument());
    expect(within(row("Mia Maker")).queryByRole("button", { name: /^Remove access/ })).toBeNull();

    await userEvent.click(within(row("Mia Maker")).getByRole("button", { name: "Give access back to Mia Maker" }));
    expect(await screen.findByText("Mia Maker has access again.")).toBeInTheDocument();
    await waitFor(() => expect(within(row("Mia Maker")).getByRole("button", { name: "Remove access for Mia Maker" })).toBeInTheDocument());
  });

  it("shows the reason when the server refuses", async () => {
    await mount();
    vi.spyOn(backend, "removeMember").mockRejectedValue(new BackendError("Only team owners can do that."));
    await userEvent.click(within(row("Mia Maker")).getByRole("button", { name: "Remove access for Mia Maker" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, remove access for Mia Maker" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only team owners can do that.");
    // the confirmation stays open so the owner can try again or cancel
    expect(screen.getByRole("group", { name: "Confirm removing Mia Maker" })).toBeInTheDocument();
  });

  it("shows a generic sentence for unexpected errors", async () => {
    await mount();
    vi.spyOn(backend, "removeMember").mockRejectedValue(new Error("boom: secret detail"));
    await userEvent.click(within(row("Mia Maker")).getByRole("button", { name: "Remove access for Mia Maker" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, remove access for Mia Maker" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong. Please try again.");
    expect(alert).not.toHaveTextContent("secret detail");
  });
});

describe("TeamManager: invites", () => {
  it("lists only invites that were not used yet, and revokes them", async () => {
    await mount();
    const list = screen.getByTestId("invite-list");
    expect(within(list).getAllByTestId("invite-row")).toHaveLength(1);
    expect(list).toHaveTextContent("pat.pending@example.test");
    expect(list).not.toHaveTextContent("sam.member@example.test");
    await userEvent.click(within(list).getByRole("button", { name: /remove the invite for pat\.pending/i }));
    expect(await screen.findByText("Removed the invite for pat.pending@example.test.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("invite-list")).toBeNull());
    expect(screen.getByText(/No invites are waiting/)).toBeInTheDocument();
  });

  it("an invite that is sent shows up as waiting", async () => {
    await mount();
    await userEvent.type(screen.getByLabelText("Email address"), "Zed.New@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await screen.findByText(/Invited zed\.new@example\.test/)).toBeInTheDocument();
    expect(await screen.findByText("zed.new@example.test")).toBeInTheDocument();
  });
});

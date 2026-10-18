import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFixtureBackend } from "./fixture";
import { FIXTURE_USERS } from "./fixture-data";
import { createSupabaseBackend, mapMember } from "./supabase";
import { BackendError } from "./types";

/** Just enough of a Supabase client for the calls under test. */
function fakeClient(opts: { rpc?: (name: string, args?: unknown) => { data?: unknown; error?: unknown }; profile?: Record<string, unknown> | null }) {
  const rpc = vi.fn(async (name: string, args?: unknown) => ({ data: null, error: null, ...(opts.rpc?.(name, args) ?? {}) }));
  const client = {
    rpc,
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "sam@example.test" } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.profile ?? null, error: null }) }) }) }),
  };
  return { client: client as unknown as SupabaseClient, rpc };
}

describe("supabase backend: team members", () => {
  it("maps the rows of team_members()", () => {
    expect(
      mapMember({ id: "a", email: "a@example.test", display_name: "Ann", role: "owner", created_at: "2026-01-01T00:00:00Z", disabled_at: null, project_count: "3" }),
    ).toEqual({ id: "a", email: "a@example.test", displayName: "Ann", role: "owner", createdAt: "2026-01-01T00:00:00Z", disabledAt: null, projectCount: 3 });
    expect(mapMember({ id: "b", role: "weird", project_count: null }).role).toBe("member");
    expect(mapMember({ id: "b", disabled_at: "2026-02-02T00:00:00Z" }).disabledAt).toBe("2026-02-02T00:00:00Z");
  });

  it("lists, removes and restores through the three RPCs", async () => {
    const { client, rpc } = fakeClient({
      rpc: (name) => (name === "team_members" ? { data: [{ id: "m1", email: "m@example.test", display_name: "M", role: "member", project_count: 1 }] } : {}),
    });
    const b = createSupabaseBackend(client);
    expect((await b.listMembers()).map((m) => m.email)).toEqual(["m@example.test"]);
    await b.removeMember("m1");
    await b.restoreMember("m1");
    expect(rpc.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["team_members", undefined],
      ["remove_member", { member_id: "m1" }],
      ["restore_member", { member_id: "m1" }],
    ]);
  });

  it("turns database errors into plain sentences", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ code: "42501", message: "Only owners can remove access." }, /Only team owners can do that/],
      [{ code: "22023", message: "You cannot remove your own access." }, /cannot remove your own access/],
      [{ code: "22023", message: "Owners cannot be removed here. Ask the person to leave." }, /Owners cannot be removed/],
      [{ code: "P0002", message: "That person was not found." }, /not found/],
      [{ message: "Failed to fetch" }, /could not reach/],
      [{ code: "XX000", message: "relation foo does not exist" }, /^Something went wrong/],
    ];
    for (const [error, expected] of cases) {
      const { client } = fakeClient({ rpc: () => ({ error }) });
      const err = await createSupabaseBackend(client).removeMember("m1").catch((e) => e);
      expect(err).toBeInstanceOf(BackendError);
      expect(err.message).toMatch(expected);
      expect(err.message).not.toMatch(/relation foo/);
    }
  });

  it("knows when the signed-in person was removed", async () => {
    const gone = await createSupabaseBackend(fakeClient({ profile: { display_name: "Sam", role: "member", disabled_at: "2026-03-03T00:00:00Z" } }).client).getCurrentUser();
    expect(gone?.disabled).toBe(true);
    const fine = await createSupabaseBackend(fakeClient({ profile: { display_name: "Sam", role: "member", disabled_at: null } }).client).getCurrentUser();
    expect(fine?.disabled).toBe(false);
  });
});

describe("fixture backend: team members follow the same rules as the database", () => {
  const owner = () => createFixtureBackend("owner", { stepMs: 0 });

  it("lets an owner remove a member and give access back", async () => {
    const b = owner();
    const members = await b.listMembers();
    const mia = members.find((m) => m.email === "mia.maker@example.test")!;
    expect(mia.disabledAt).toBeNull();
    await b.removeMember(mia.id);
    expect((await b.listMembers()).find((m) => m.id === mia.id)!.disabledAt).not.toBeNull();
    await b.removeMember(mia.id); // a second time changes nothing and does not fail
    await b.restoreMember(mia.id);
    expect((await b.listMembers()).find((m) => m.id === mia.id)!.disabledAt).toBeNull();
  });

  it("refuses to remove yourself, another owner, or an unknown person", async () => {
    const b = owner();
    const members = await b.listMembers();
    await expect(b.removeMember(FIXTURE_USERS.owner.id)).rejects.toThrow(/your own access/);
    await expect(b.removeMember(members.find((m) => m.email === "oscar.owner@example.test")!.id)).rejects.toThrow(/Owners cannot be removed/);
    await expect(b.removeMember("nobody")).rejects.toThrow(/not found/);
    await expect(b.restoreMember("nobody")).rejects.toThrow(/not found/);
  });

  it("keeps all of this away from members", async () => {
    const b = createFixtureBackend("member", { stepMs: 0 });
    await expect(b.listMembers()).rejects.toThrow(/Only team owners/);
    await expect(b.removeMember("x")).rejects.toThrow(/Only team owners/);
    await expect(b.restoreMember("x")).rejects.toThrow(/Only team owners/);
  });

  it("reports a removed person as disabled", async () => {
    expect((await createFixtureBackend("member", { removed: true }).getCurrentUser())?.disabled).toBe(true);
    expect((await createFixtureBackend("member").getCurrentUser())?.disabled).toBeUndefined();
  });
});

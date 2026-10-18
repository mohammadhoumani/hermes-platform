import { describe, expect, it } from "vitest";
import calc from "@/lib/agent-events/fixtures/calculator-run.json";
import type { AgentEvent } from "@/lib/agent-events/types";
import type { Order, PlatformEvent, Project } from "@/lib/backend/types";
import { buildConversation } from "./conversation";
import { buildRail } from "./rail";
import { initRoom, roomReducer } from "./state";
import { timeAgo } from "@/lib/time";

const events = (calc as unknown as AgentEvent[]).map(
  (e, i): PlatformEvent => ({ id: i + 1, projectId: "p", sessionId: "main-1", type: e.type, payload: e, createdAt: new Date((e.ts ?? 0) * 1000).toISOString() }),
);

const project: Project = {
  id: "p", ownerId: "u", name: "Tip", slug: "tip", status: "development", phase: "development", repoUrl: null, stagingUrl: null,
  productionUrl: null, brdMarkdown: null, brdApprovedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const order = (id: number, kind: Order["kind"], text: string, at: string, status: Order["status"] = "queued"): Order => ({
  id, projectId: "p", userId: "u", kind, text, status, note: null, runId: null, createdAt: at,
});

describe("room reducer", () => {
  const snap = { project, orders: [], events: events.slice(0, 20) };

  it("builds the view from the initial events", () => {
    const s = initRoom(snap);
    expect(s.view.eventCount).toBe(20);
    expect(s.lastEventId).toBe(20);
  });

  it("applies live events in order and ignores duplicates", () => {
    let s = initRoom(snap);
    s = roomReducer(s, { type: "event", event: events[20]! });
    s = roomReducer(s, { type: "event", event: events[20]! });
    expect(s.events).toHaveLength(21);
    expect(s.view.eventCount).toBe(21);
  });

  it("gives the same result as a full replay when events arrive late and out of order", () => {
    let s = initRoom({ project, orders: [], events: [] });
    const shuffled = [events[3]!, events[1]!, events[0]!, events[2]!, events[5]!, events[4]!];
    for (const e of shuffled) s = roomReducer(s, { type: "event", event: e });
    const ref = initRoom({ project, orders: [], events: events.slice(0, 6) });
    expect(s.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.view.feed.map((f) => f.text)).toEqual(ref.view.feed.map((f) => f.text));
  });

  it("catches up with a batch of events", () => {
    let s = initRoom(snap);
    s = roomReducer(s, { type: "events", events: events.slice(10, 60) });
    expect(s.lastEventId).toBe(60);
    expect(s.view.eventCount).toBe(60);
  });

  it("updates an order by id and adds new ones in order", () => {
    let s = initRoom({ ...snap, orders: [order(1, "message", "a", "2026-01-01T00:00:01Z")] });
    s = roomReducer(s, { type: "order", order: order(1, "message", "a", "2026-01-01T00:00:01Z", "done") });
    s = roomReducer(s, { type: "order", order: order(2, "message", "b", "2026-01-01T00:00:02Z") });
    expect(s.orders.map((o) => `${o.id}:${o.status}`)).toEqual(["1:done", "2:queued"]);
  });

  it("keeps the newer project row when an older one arrives late", () => {
    let s = initRoom(snap);
    s = roomReducer(s, { type: "project", project: { ...project, status: "qa", updatedAt: "2026-01-01T00:00:10Z" } });
    s = roomReducer(s, { type: "project", project: { ...project, status: "review", updatedAt: "2026-01-01T00:00:05Z" } });
    expect(s.project.status).toBe("qa");
  });

  it("tracks the connection state", () => {
    let s = initRoom(snap);
    s = roomReducer(s, { type: "connection", state: "live" });
    expect(s.connection).toBe("live");
  });
});

describe("conversation", () => {
  it("puts your orders and the agents' lines in time order", () => {
    const orders = [order(1, "start_project", "My idea", "2026-01-01T00:00:00Z"), order(2, "message", "Reply", "2026-01-01T00:00:10Z")];
    const says = [{ id: 7, agent: "ba" as const, kind: "question" as const, text: "Which colour?", ts: Date.parse("2026-01-01T00:00:05Z") / 1000 }];
    const c = buildConversation(orders, says);
    expect(c.map((x) => (x.side === "agent" ? "agent:" + x.text : x.text))).toEqual(["My idea", "agent:Which colour?", "Reply"]);
  });

  it("shows approvals, stops and resumes as system lines", () => {
    const c = buildConversation([order(1, "approve_brd", "", "2026-01-01T00:00:00Z"), order(2, "stop", "", "2026-01-01T00:00:01Z"), order(3, "resume", "", "2026-01-01T00:00:02Z")], []);
    expect(c.map((x) => x.side)).toEqual(["system", "system", "system"]);
    expect(c[0]).toMatchObject({ text: "You approved the BRD." });
  });

  it("labels special orders", () => {
    const c = buildConversation([order(1, "request_brd_changes", "Add dark mode", "2026-01-01T00:00:00Z"), order(2, "change_request", "Round up", "2026-01-01T00:00:01Z")], []);
    expect(c[0]).toMatchObject({ label: "Changes to the BRD" });
    expect(c[1]).toMatchObject({ label: "Change request" });
  });
});

describe("progress rail", () => {
  it("marks phases before the current one as done", () => {
    const r = buildRail({ phase: "review", status: "review" });
    expect(r.map((s) => s.state)).toEqual(["done", "done", "done", "active", "todo", "todo"]);
  });
  it("shows 'needs you' on discovery while the BRD waits", () => {
    const r = buildRail({ phase: "discovery", status: "awaiting_brd_approval" });
    expect(r[0]!.state).toBe("needs-you");
  });
  it("marks everything done when released", () => {
    expect(buildRail({ phase: "release", status: "released" }).every((s) => s.state === "done")).toBe(true);
  });
  it("has nothing active before the run starts", () => {
    expect(buildRail({ phase: null, status: "queued" }).every((s) => s.state === "todo")).toBe(true);
  });
  it("has the six phases in order", () => {
    expect(buildRail({ phase: null, status: "queued" }).map((s) => s.label)).toEqual(["Discovery", "Architecture", "Development", "Review", "QA", "Release"]);
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  it.each([
    ["2026-06-01T11:59:50Z", "just now"],
    ["2026-06-01T11:30:00Z", "30 min ago"],
    ["2026-06-01T09:00:00Z", "3 hours ago"],
    ["2026-05-31T09:00:00Z", "1 day ago"],
    ["2026-05-01T12:00:00Z", "1 month ago"],
    ["2024-06-01T12:00:00Z", "2 years ago"],
    ["not a date", ""],
  ])("%s is %j", (iso, expected) => {
    expect(timeAgo(iso, now)).toBe(expected);
  });
});

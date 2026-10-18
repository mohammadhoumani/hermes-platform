import { describe, expect, it } from "vitest";
import devinStatusRun from "./fixtures/devin-status.json";
import { applyEvent, createInitialState, replay } from "./reduce";
import { LANE_STEPS, type AgentEvent, type ViewState } from "./types";

/** Events in the shape hermes/devin/devin_poller.py emits (make_event) and the bridge forwards. */
const status = devinStatusRun as unknown as AgentEvent[];
const visible = (s: ViewState) => s.feed.filter((f) => !f.quiet);
const PR = "https://github.com/bot-account/tip-calculator/pull/6";

describe("devin_status events from the bridge's Devin poller", () => {
  it("replays a whole session on the Devin lane: start, question, pull request, done", () => {
    const s = replay(status);
    expect(s.lanes.devin).toMatchObject({ pr: "#6", done: "completed" });
    expect(s.lanes.devin.step).toBeGreaterThanOrEqual(LANE_STEPS.indexOf("pr"));
    expect(s.internal.laneOwner.devin).toBeNull();
    expect(s.stats.prs).toBe(1);
    expect(s.internal.prLane["#6"]).toBe("devin");
    const texts = visible(s).map((f) => f.text);
    expect(texts.some((t) => /Task 3: Devin is working/.test(t))).toBe(true);
    expect(texts.some((t) => /waiting for an answer/.test(t))).toBe(true);
    expect(texts.some((t) => t.startsWith(`Opened PR #6: ${PR}`))).toBe(true);
    expect(texts.at(-1)).toMatch(/^Done: Task 3: Devin finished/);
  });

  it("the first status starts the lane, later ones only add progress", () => {
    const s = replay(status.slice(0, 3));
    expect(s.lanes.devin.done).toBe("");
    expect(s.internal.laneOwner.devin).toBe("devin-abc123");
    expect(s.agents.devin).toBe("active");
    expect(visible(s).filter((f) => f.kind === "handoff" && f.to === "devin")).toHaveLength(1);
  });

  it("a failed status stops the Devin lane", () => {
    let s = replay(status.slice(0, 2));
    s = applyEvent(s, { type: "devin_status", sid: "devin-abc123", status: "failed", raw_status: "expired", finished: true, pr: null, text: "Task 3: Devin stopped without finishing" });
    expect(s.lanes.devin.done).toBe("failed");
    expect(visible(s).at(-1)).toMatchObject({ tag: "error", text: expect.stringMatching(/^Stopped/) });
  });

  it("a finished session without a pull request is done; a repeated pull request is not counted twice", () => {
    let s = applyEvent(createInitialState(), { type: "devin_status", sid: "d1", status: "finished", finished: true, pr: null, text: "Devin finished" });
    expect(s.lanes.devin.done).toBe("completed");
    s = replay(status);
    s = applyEvent(s, { type: "devin_status", sid: "devin-abc123", status: "working", pr: PR, pr_url: PR, text: "again" });
    expect(s.stats.prs).toBe(1);
  });

  it("does not show a pull request value that is not a link, and does not change the old state", () => {
    const before = replay(status.slice(0, 2));
    const frozen = JSON.stringify(before);
    const after = applyEvent(before, { type: "devin_status", sid: "devin-abc123", status: "working", pr: "javascript:alert(1)", pr_url: "javascript:alert(1)", text: "x" });
    expect(JSON.stringify(before)).toBe(frozen);
    expect(after.lanes.devin.pr).toBe("");
  });

  it("works with the older Devin events on the same lane (tool call first, poller after)", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "skill", name: "sdlc-development" });
    s = applyEvent(s, { type: "tool_end", tool: "x", status: "ok", actions: [{ action: "devin", op: "create", task: "Styles", session: "devin-abc123" }] });
    s = applyEvent(s, { type: "devin_status", sid: "devin-abc123", status: "working", pr: PR, pr_url: PR, text: "Styles: working" });
    s = applyEvent(s, { type: "devin_status", sid: "devin-abc123", status: "finished", finished: true, pr: PR, pr_url: PR, text: "Styles: finished" });
    expect(s.lanes.devin).toMatchObject({ task: "Styles", pr: "#6", done: "completed" });
    expect(visible(s).filter((f) => f.kind === "handoff" && f.to === "devin")).toHaveLength(1);
  });
});

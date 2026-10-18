import { describe, expect, it } from "vitest";
import calculatorRun from "@/lib/agent-events/fixtures/calculator-run.json";
import discoveryRun from "@/lib/agent-events/fixtures/discovery-awaiting-brd.json";
import pluginRun from "@/lib/agent-events/fixtures/plugin-v2-actions.json";
import { createInitialState, replay } from "@/lib/agent-events/reduce";
import { AGENT_ORDER } from "@/lib/agent-events/roster";
import type { AgentEvent, AgentId, ViewState } from "@/lib/agent-events/types";
import { DESK, MEETING_RADIUS, MEETING_TABLE, meetingSeatOf, seatOf, visitSpotOf } from "./layout";
import { deriveOfficeScene, describeAgents, describeNow, meetingOf, pickBubbles, type AgentScene, type OfficeScene } from "./scene-state";

const calc = calculatorRun as unknown as AgentEvent[];
const discovery = discoveryRun as unknown as AgentEvent[];
const plugin = pluginRun as unknown as AgentEvent[];

/** The view after the first `n` events. */
const upTo = (events: AgentEvent[], n: number) => replay(events.slice(0, n));
/** The view right after the first event that matches. */
function after(events: AgentEvent[], match: (e: AgentEvent, i: number) => boolean): ViewState {
  const i = events.findIndex(match);
  if (i < 0) throw new Error("no matching event in the fixture");
  return upTo(events, i + 1);
}
const agent = (scene: OfficeScene, id: AgentId): AgentScene => scene.agents.find((a) => a.id === id)!;
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

describe("layout", () => {
  it("gives every agent a desk, and no two desks share a spot", () => {
    for (const id of AGENT_ORDER) expect(DESK[id]).toBeDefined();
    const spots = new Set(AGENT_ORDER.map((id) => `${DESK[id].x},${DESK[id].z}`));
    expect(spots.size).toBe(AGENT_ORDER.length);
  });

  it("seats people next to their desk and meeting seats around the table", () => {
    for (const id of AGENT_ORDER.filter((x) => x !== "github")) expect(dist(seatOf(id), DESK[id])).toBeCloseTo(1.15, 5);
    for (const id of ["reviewer", "qa", "orchestrator", "coder1", "coder2", "devin", "architect", "ba"] as const) {
      expect(dist(meetingSeatOf(id), MEETING_TABLE)).toBeGreaterThan(MEETING_RADIUS);
    }
    expect(dist(visitSpotOf("coder2"), DESK.coder2)).toBeLessThan(2);
  });

  it("gives the people who can meet different seats", () => {
    const keys = ["reviewer", "qa", "orchestrator", "coder1", "coder2", "devin"].map((id) => {
      const s = meetingSeatOf(id as AgentId);
      return `${s.x.toFixed(2)},${s.z.toFixed(2)}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("an empty project", () => {
  const scene = deriveOfficeScene(createInitialState());
  it("has everybody idle at their own desk and nothing to say", () => {
    expect(scene.agents).toHaveLength(AGENT_ORDER.length);
    for (const a of scene.agents) {
      expect(a.visual).toBe("idle");
      expect(a.pose).toBe("seated");
    }
    expect(scene.bubbles).toEqual([]);
    expect(scene.packet).toBeNull();
    expect(scene.meeting).toBeNull();
    expect(scene.needsYou).toBe(false);
    expect(scene.phase.text).toBe("Waiting to start");
    expect(scene.summary).toMatch(/quiet/);
  });
});

describe("waiting for the BRD (discovery fixture)", () => {
  const view = replay(discovery);
  const scene = deriveOfficeScene(view);

  it("shows the You spot and the BA in rose, and keeps a bubble for the BA", () => {
    expect(scene.needsYou).toBe(true);
    expect(agent(scene, "human").visual).toBe("needs-you");
    expect(agent(scene, "ba").visual).toBe("needs-you");
    expect(agent(scene, "ba").statusText).toBe("needs you");
    const bubble = scene.bubbles[0]!;
    expect(bubble).toMatchObject({ id: -1, agent: "ba", tone: "attention" });
    expect(bubble.text).toMatch(/approve/i);
  });

  it("says so for screen readers", () => {
    expect(scene.summary).toMatch(/waiting for you to approve the BRD/i);
    expect(scene.summary).toMatch(/Phase 1 of 6: Discovery/);
  });

  it("is not a meeting", () => {
    expect(scene.meeting).toBeNull();
  });

  it("goes back to normal when the user has answered", () => {
    const approved = replay(calc.slice(0, calc.findIndex((e) => e.type === "tool_start" && (e as { tool: string }).tool === "skill_view" && /architect/.test((e as { summary?: string }).summary ?? "")) + 1));
    expect(approved.gate).toBe("approved");
    expect(deriveOfficeScene(approved).needsYou).toBe(false);
  });
});

describe("handoffs", () => {
  // Orchestrator hands the first task to Coder 1.
  const view = after(calc, (e) => e.type === "sub_start" && /input form/i.test((e as { goal?: string }).goal ?? ""));

  it("makes the sender walk to the receiver's desk", () => {
    const scene = deriveOfficeScene(view);
    const walker = agent(scene, "orchestrator");
    expect(view.now).toMatchObject({ kind: "handoff", from: "orchestrator", to: "coder1" });
    expect(walker.pose).toBe("visiting");
    expect(walker.visiting).toBe("coder1");
    expect(walker.target).toEqual(visitSpotOf("coder1"));
    expect(agent(scene, "coder1").pose).toBe("seated");
    expect(agent(scene, "coder1").target).toEqual(seatOf("coder1"));
    expect(scene.packet).toEqual({ id: view.now!.id, from: "orchestrator", to: "coder1" });
  });

  it("sends the walker home once the walk is settled", () => {
    const scene = deriveOfficeScene(view, { settledHandoff: view.now!.id });
    expect(agent(scene, "orchestrator").pose).toBe("seated");
    expect(agent(scene, "orchestrator").target).toEqual(seatOf("orchestrator"));
    expect(scene.packet).toBeNull();
  });

  it("does not make anybody walk for history that was already there", () => {
    const scene = deriveOfficeScene(view, { freshAfter: view.now!.id });
    expect(scene.agents.every((a) => a.pose === "seated")).toBe(true);
    expect(scene.packet).toBeNull();
  });

  it("keeps everybody at their desk, with no flying packet, under reduced motion", () => {
    const scene = deriveOfficeScene(view, { walking: false });
    expect(scene.agents.every((a) => a.pose === "seated")).toBe(true);
    expect(scene.packet).toBeNull();
  });

  it("marks who is working in green", () => {
    const scene = deriveOfficeScene(view);
    expect(agent(scene, "coder1").visual).toBe("working");
    expect(agent(scene, "orchestrator").visual).toBe("working");
    expect(agent(scene, "coder2").visual).toBe("idle");
  });

  it("sends a packet to GitHub (without walking) for a pull request", () => {
    const pr = after(calc, (e) => e.type === "tool_end" && ((e as { actions?: { action: string }[] }).actions ?? []).some((a) => a.action === "pr_open"));
    const scene = deriveOfficeScene(pr);
    expect(pr.now).toMatchObject({ tag: "pr", to: "github" });
    expect(scene.packet).toMatchObject({ to: "github" });
    expect(scene.agents.every((a) => a.pose === "seated")).toBe(true);
    expect(scene.rackActive).toBe(true);
    expect(scene.summary).toMatch(/is opening a pull request/);
  });
});

describe("review and QA at the meeting table", () => {
  it("gathers the reviewer and the coder whose pull request is being checked", () => {
    const view = after(calc, (e) => e.type === "tool_end" && ((e as { actions?: { action: string; verdict?: string }[] }).actions ?? []).some((a) => a.action === "review" && a.verdict === "approved"));
    expect(view.phase).toBe("review");
    const meeting = meetingOf(view);
    expect(meeting?.kind).toBe("review");
    expect(meeting?.participants[0]).toBe("reviewer");
    const scene = deriveOfficeScene(view);
    expect(agent(scene, "reviewer").pose).toBe("meeting");
    expect(agent(scene, "reviewer").target).toEqual(meetingSeatOf("reviewer"));
    for (const id of meeting!.participants) expect(agent(scene, id).pose).toBe("meeting");
    // everybody else stays at their desk
    for (const a of scene.agents) if (!meeting!.participants.includes(a.id)) expect(a.pose).not.toBe("meeting");
  });

  it("does not make anyone walk to a desk whose owner is at the table", () => {
    const view = after(calc, (e) => e.type === "tool_end" && ((e as { actions?: { action: string; verdict?: string }[] }).actions ?? []).some((a) => a.action === "review" && a.verdict === "approved"));
    const scene = deriveOfficeScene(view);
    const meeting = scene.meeting!;
    const to = view.now!.to!;
    if (meeting.participants.includes(to)) expect(agent(scene, view.now!.from).pose).toBe("meeting");
  });

  it("sends QA and the orchestrator to the table during QA", () => {
    const view = after(calc, (e) => e.type === "tool_end" && ((e as { actions?: { action: string }[] }).actions ?? []).some((a) => a.action === "qa_result" || a.action === "deploy"));
    expect(view.phase).toBe("qa");
    const scene = deriveOfficeScene(view);
    expect(scene.meeting).toEqual({ kind: "qa", participants: ["qa", "orchestrator"] });
    expect(agent(scene, "qa").pose).toBe("meeting");
    expect(agent(scene, "orchestrator").pose).toBe("meeting");
  });

  it("empties the table when the project is live", () => {
    const view = replay(calc);
    expect(view.finished).toBe(true);
    const scene = deriveOfficeScene(view);
    expect(scene.meeting).toBeNull();
    expect(scene.agents.every((a) => a.pose === "seated")).toBe(true);
    expect(scene.packet).toBeNull();
    expect(scene.summary).toMatch(/live/i);
    expect(agent(scene, "coder1").visual).toBe("done");
  });

  it("changes requested: the coder goes back to the desk to fix it", () => {
    const view = after(calc, (e) => e.type === "tool_end" && ((e as { actions?: { action: string; verdict?: string }[] }).actions ?? []).some((a) => a.action === "review" && a.verdict === "changes"));
    expect(view.now?.tag).toBe("changes");
    const meeting = meetingOf(view);
    expect(meeting?.participants).not.toContain("coder2");
  });
});

describe("speech bubbles for Team sync", () => {
  const view = replay(plugin);
  const sync = view.feed.filter((f) => f.tag === "sync" && !f.quiet);
  const withSync = (i: number) => replay(plugin.slice(0, plugin.findIndex((e) => e.type === "tool_end" && ((e as { actions?: { action: string; text?: string }[] }).actions ?? []).some((a) => a.action === "sync" && sync[i]!.text.endsWith(a.text ?? "~~~"))) + 1));

  it("the fixture has sync messages to show", () => {
    expect(sync.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a sync message as a short bubble above the agent who wrote it", () => {
    const v = withSync(0);
    const bubbles = pickBubbles(v);
    const b = bubbles.find((x) => x.id === v.now!.id)!;
    expect(b).toBeDefined();
    expect(b.agent).toBe(v.now!.from);
    expect(b.text.length).toBeLessThanOrEqual(70);
    expect(b.text).toContain(sync[0]!.text.slice(0, 20));
  });

  it("shows at most three bubbles, one per agent, newest first", () => {
    const bubbles = pickBubbles(replay(calc.slice(0, 60)));
    expect(bubbles.length).toBeLessThanOrEqual(3);
    expect(new Set(bubbles.map((b) => b.agent)).size).toBe(bubbles.length);
    const ids = bubbles.map((b) => b.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
  });

  it("drops bubbles that have been up long enough", () => {
    const v = withSync(0);
    const scene = deriveOfficeScene(v, { expiredBubbles: new Set(pickBubbles(v).map((b) => b.id)) });
    expect(scene.bubbles).toEqual([]);
  });

  it("clips long text", () => {
    const long = "word ".repeat(80).trim();
    const v = replay([{ type: "turn_start", sid: "s", text: long }] as AgentEvent[]);
    const [b] = pickBubbles(v);
    expect(b!.text.length).toBeLessThanOrEqual(70);
  });
});

describe("phase sign and summary", () => {
  it("names the phase", () => {
    const dev = after(calc, (e) => e.type === "sub_start");
    expect(deriveOfficeScene(dev).phase).toMatchObject({ index: 2, id: "development", text: "Phase 3 of 6: Development" });
  });

  it("describes the newest thing in plain words", () => {
    const v = after(calc, (e) => e.type === "sub_start" && /input form/i.test((e as { goal?: string }).goal ?? ""));
    expect(describeNow(v)).toBe("Orchestrator is handing work to Coder 1.");
  });

  it("lists every agent for screen readers", () => {
    const v = replay(discovery);
    const lines = describeAgents(deriveOfficeScene(v), v);
    expect(lines).toHaveLength(AGENT_ORDER.length);
    expect(lines.find((l) => l.startsWith("You:"))).toMatch(/needs you/);
  });
});

describe("it never changes the view it is given", () => {
  it("is a pure function of the view and the options", () => {
    const v = replay(calc.slice(0, 80));
    const frozen = JSON.stringify(v);
    const a = deriveOfficeScene(v);
    const b = deriveOfficeScene(v);
    expect(JSON.stringify(v)).toBe(frozen);
    expect(a).toEqual(b);
  });
});

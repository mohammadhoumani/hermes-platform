import { describe, expect, it } from "vitest";
import calculatorRun from "./fixtures/calculator-run.json";
import changeRequestRun from "./fixtures/change-request.json";
import discoveryRun from "./fixtures/discovery-awaiting-brd.json";
import { applyEvent, classifySubAgent, createInitialState, isAgentEvent, replay } from "./reduce";
import { cleanOrderText, safeHttpUrl } from "./text";
import type { AgentEvent, ViewState } from "./types";

const calc = calculatorRun as unknown as AgentEvent[];
const discovery = discoveryRun as unknown as AgentEvent[];
const change = changeRequestRun as unknown as AgentEvent[];

const visible = (s: ViewState) => s.feed.filter((f) => !f.quiet);
const phaseTitles = (s: ViewState) => s.feed.filter((f) => f.kind === "phase").map((f) => f.text);

describe("replaying a discovery run (BA writes the BRD and waits)", () => {
  const s = replay(discovery);

  it("is in the discovery phase with the gate waiting for the human", () => {
    expect(s.phase).toBe("discovery");
    expect(s.phaseIndex).toBe(0);
    expect(s.gate).toBe("waiting");
    expect(s.agents.human).toBe("waiting");
    expect(s.finished).toBe(false);
  });

  it("shows the BA as the speaker and nobody else in the lanes", () => {
    expect(s.agents.ba).toBe("active");
    for (const lane of Object.values(s.lanes)) expect(lane.step).toBe(-1);
  });

  it("keeps the BA questions as 'says' for the conversation", () => {
    const questions = s.says.filter((x) => x.agent === "ba").map((x) => x.text);
    expect(questions).toContain("Which tip percentages should be preset?");
    expect(questions).toContain("How many people can split one bill?");
  });

  it("records the repo and the commits", () => {
    expect(s.urls.repo).toBe("https://github.com/bot-account/tip-calculator");
    expect(s.stats.commits).toBe(1);
  });

  it("puts a gate card in the feed", () => {
    expect(s.feed.some((f) => f.kind === "gate" && /approve the BRD/.test(f.text))).toBe(true);
  });
});

describe("replaying the full calculator run", () => {
  const s = replay(calc);

  it("goes through the six phases in order", () => {
    expect(phaseTitles(s)).toEqual(["Discovery", "Architecture", "Development", "Review", "QA", "Release"]);
    expect(s.phase).toBe("release");
    expect(s.phaseIndex).toBe(5);
  });

  it("approves the one gate when the user approves the BRD", () => {
    expect(s.gate).toBe("approved");
    const gateItems = s.feed.filter((f) => f.kind === "gate").map((f) => f.text);
    expect(gateItems).toEqual(["Waiting for you to approve the BRD", "BRD approved"]);
  });

  it("finishes when the production URL is reported", () => {
    expect(s.finished).toBe(true);
    expect(s.urls.production).toBe("https://tip-calculator.example.test/");
    expect(s.urls.staging).toBe("https://tip-calculator-git-main.example.test/");
    for (const [id, st] of Object.entries(s.agents)) {
      if (id !== "human" && id !== "github") expect(st, id).toBe("done");
    }
  });

  it("gives the two Claude coders and Devin their own lanes", () => {
    expect(s.lanes.coder1.task).toMatch(/Hotfix|input form/);
    expect(s.lanes.coder2.branch).toBe("feature/tip-calc-logic");
    expect(s.lanes.coder2.pr).toBe("#5");
    expect(s.lanes.devin.branch).toBe("feature/styles-layout");
    expect(s.lanes.devin.pr).toBe("#6");
    expect(s.lanes.devin.review).toBe("approved");
    expect(s.lanes.devin.ci).toBe("passed");
    expect(s.lanes.devin.done).toBe("completed");
  });

  it("reuses the same lane for the rework of PR #5 (matched by pull request number)", () => {
    const handoffs = s.feed.filter((f) => f.kind === "handoff" && /Fix rounding/.test(f.text));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.to).toBe("coder2");
    expect(handoffs[0]!.lane).toBe("coder2");
  });

  it("counts review and QA rounds", () => {
    expect(s.stats.reviewRounds).toBe(1);
    expect(s.stats.qaRounds).toBe(1);
    expect(s.stats.prs).toBe(4);
    expect(s.stats.merges).toBe(4);
    expect(s.stats.commits).toBe(5);
  });

  it("attributes every review and merge to the Reviewer", () => {
    const reviews = visible(s).filter((f) => f.tag === "review" || f.tag === "changes");
    expect(reviews.length).toBeGreaterThanOrEqual(4);
    for (const r of reviews) expect(r.from).toBe("reviewer");
    for (const m of visible(s).filter((f) => f.tag === "merge")) expect(m.from).toBe("reviewer");
  });

  it("shows the QA bug as a bug item", () => {
    const bug = visible(s).find((f) => f.tag === "bug");
    expect(bug?.text).toMatch(/Custom tip of 0 shows NaN/);
    expect(bug?.from).toBe("qa");
  });

  it("hides tool steps from the visible feed", () => {
    expect(s.feed.some((f) => f.quiet)).toBe(true);
    expect(visible(s).every((f) => f.tag !== "tool")).toBe(true);
  });

  it("links agents that talked to each other", () => {
    const pair = (a: string, b: string) => s.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    expect(pair("orchestrator", "coder1")?.count).toBeGreaterThan(0);
    expect(pair("coder2", "github")?.count).toBeGreaterThan(0);
    expect(pair("human", "ba")?.count).toBeGreaterThan(0);
  });

  it("numbers feed items increasingly and unique", () => {
    const ids = s.feed.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it("counts all events and remembers the last timestamp", () => {
    expect(s.eventCount).toBe(calc.length);
    expect(s.lastTs).toBe(calc[calc.length - 1]!.ts);
  });
});

describe("replaying prefixes of the run", () => {
  it("is at the Architecture phase right after the design events", () => {
    const upTo = calc.findIndex((e) => e.type === "tool_end" && "summary" in e && /PLAN\.md/.test(e.summary ?? ""));
    const s = replay(calc.slice(0, upTo + 1));
    expect(s.phase).toBe("architecture");
    expect(s.gate).toBe("approved");
    expect(s.agents.architect).toBe("active");
    expect(s.agents.ba).toBe("done");
  });

  it("has two coders and Devin working during development", () => {
    const idx = calc.findIndex((e) => e.type === "devin_progress");
    const s = replay(calc.slice(0, idx + 1));
    expect(s.phase).toBe("development");
    expect(s.lanes.coder1.step).toBeGreaterThanOrEqual(2);
    expect(s.lanes.coder2.step).toBeGreaterThanOrEqual(2);
    expect(s.lanes.devin.step).toBeGreaterThanOrEqual(1);
    expect(s.lanes.devin.done).toBe("");
    expect(s.agents.devin).toBe("active");
  });

  it("is in QA with the staging URL known but not finished", () => {
    const idx = calc.findIndex((e) => e.type === "tool_end" && (e.actions ?? []).some((a) => a.action === "qa_result"));
    const s = replay(calc.slice(0, idx + 1));
    expect(s.phase).toBe("qa");
    expect(s.finished).toBe(false);
    expect(s.urls.staging).toBeDefined();
    expect(s.urls.production).toBeUndefined();
  });

  it("never moves the phase backwards, whatever the order of the first events", () => {
    let s = createInitialState();
    let last = -1;
    for (const ev of calc) {
      s = applyEvent(s, ev);
      expect(s.phaseIndex).toBeGreaterThanOrEqual(last);
      last = s.phaseIndex;
    }
  });
});

describe("a change request on a released project", () => {
  const released = replay(calc);
  const s = replay(change, released);

  it("restarts development, review, QA and release without a new BRD", () => {
    expect(released.finished).toBe(true);
    expect(s.changeRequest).toBe(true);
    expect(phaseTitles(s).slice(-4)).toEqual(["Development", "Review", "QA", "Release"]);
    expect(s.gate).toBe("approved");
    expect(s.finished).toBe(true);
  });

  it("starts the lanes fresh for the new work", () => {
    expect(s.lanes.coder1.pr).toBe("#8");
    expect(s.lanes.coder1.branch).toBe("feature/round-up");
    expect(s.lanes.devin.step).toBe(-1);
  });

  it("resets the review and QA round counters", () => {
    expect(s.stats.reviewRounds).toBe(0);
    expect(s.stats.qaRounds).toBe(0);
  });
});

describe("applyEvent", () => {
  it("does not change the state you pass in", () => {
    const a = createInitialState();
    const before = JSON.stringify(a);
    applyEvent(a, { type: "turn_start", sid: "x", text: "hello", ts: 1 });
    expect(JSON.stringify(a)).toBe(before);
  });

  it("ignores events it does not know and keeps counting them", () => {
    const s = applyEvent(createInitialState(), { type: "plugin_loaded", ts: 5, cloud: true });
    expect(s.feed).toHaveLength(0);
    expect(s.eventCount).toBe(1);
    expect(s.lastTs).toBe(5);
  });

  it("ignores events of helper sessions in the conversation (turn_start and turn_end of a sub-agent)", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "turn_start", sid: "main", text: "x" });
    s = applyEvent(s, { type: "sub_start", parent: "main", child: "kid", goal: "Task #1 on branch feature/a" });
    const before = s.feed.length;
    s = applyEvent(s, { type: "turn_start", sid: "kid", text: "internal" });
    s = applyEvent(s, { type: "turn_end", sid: "kid", text: "internal reply" });
    expect(s.feed.length).toBe(before);
    expect(s.says).toHaveLength(0);
  });

  it("strips the order note that the bridge adds to website messages", () => {
    const s = applyEvent(createInitialState(), {
      type: "turn_start", sid: "m", text: "Add dark mode (This order came from the Hermes website. Reply on the website.)",
    });
    expect(visible(s)[0]!.text).toBe("Add dark mode");
  });

  it("treats a legacy G1 gate marker as the BRD gate", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "skill", name: "sdlc-ba" });
    s = applyEvent(s, { type: "turn_end", sid: "m", text: "Please approve.", gates: ["G1"] });
    expect(s.gate).toBe("waiting");
  });

  it("does not show an approval request before a BRD exists", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "skill", name: "sdlc-ba" });
    s = applyEvent(s, { type: "turn_end", sid: "m", text: "Do you approve of this idea?" });
    expect(s.gate).toBe("none");
  });

  it("marks a human question and clears it when answered", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "human_ask", sid: "m", kind: "clarify", text: "Which colour?" });
    expect(s.agents.human).toBe("waiting");
    expect(s.says[0]).toMatchObject({ kind: "question", text: "Which colour?" });
    s = applyEvent(s, { type: "human_answer", sid: "m", kind: "clarify", outcome: "answered" });
    expect(s.agents.human).not.toBe("waiting");
  });

  it("never links to an unsafe URL", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "skill", name: "sdlc-release" });
    s = applyEvent(s, { type: "tool_end", sid: "m", tool: "x", status: "ok", actions: [{ action: "deploy", env: "production", url: "javascript:alert(1)" }] });
    expect(s.urls.production).toBeUndefined();
    expect(s.finished).toBe(false);
  });

  it("keeps the feed bounded", () => {
    let s = createInitialState();
    for (let i = 0; i < 1700; i++) s = applyEvent(s, { type: "turn_end", sid: "m", text: `reply ${i}` });
    expect(s.feed.length).toBeLessThanOrEqual(1500);
    expect(s.feed[s.feed.length - 1]!.text).toBe("reply 1699");
  });

  it("shows a failed tool as a quiet error item", () => {
    const s = applyEvent(createInitialState(), { type: "tool_end", sid: "m", tool: "terminal", status: "error", error: "boom" });
    expect(s.feed[0]).toMatchObject({ tag: "error", quiet: true });
  });

  it("handles planned event types: team sync and Devin failure", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "skill", name: "sdlc-development" });
    s = applyEvent(s, { type: "tool_end", sid: "m", tool: "x", status: "ok", actions: [{ action: "sync", kind: "blocker", text: "Need the API shape for orders" }] });
    expect(visible(s).at(-1)).toMatchObject({ tag: "sync", text: "Blocked: Need the API shape for orders" });
    s = applyEvent(s, { type: "devin_started", sid: "d", task: "Styles" });
    s = applyEvent(s, { type: "devin_failed", sid: "d", text: "ACU limit reached" });
    expect(s.lanes.devin.done).toBe("failed");
    expect(visible(s).at(-1)).toMatchObject({ tag: "error" });
  });
});

describe("classifySubAgent", () => {
  it.each([
    ["", "Devin: build the styles", 2, "devin"],
    ["", "Task #1 input form on feature/x", 2, "coder"],
    ["", "Review the open pull requests", 2, "reviewer"],
    ["", "Fix review comments on PR #5", 3, "coder"],
    ["", "Run the Playwright e2e tests", 4, "qa"],
    ["", "Draft the architecture", 0, "architect"],
    ["", "Write the requirements", 0, "ba"],
    ["", "Hotfix NaN bug", 4, "coder"],
    ["", "Write the README and the user guide", 5, "release"],
    ["", "Something unclear", 2, "coder"],
  ] as const)("role %j goal %j at phase %i is %s", (role, goal, phase, expected) => {
    expect(classifySubAgent(role, goal, phase)).toBe(expected);
  });
});

describe("text helpers", () => {
  it("cleanOrderText leaves normal text alone", () => {
    expect(cleanOrderText("  hello  ")).toBe("hello");
    expect(cleanOrderText(undefined)).toBe("");
  });
  it("safeHttpUrl accepts http(s) only", () => {
    expect(safeHttpUrl("https://example.test/a")).toBe("https://example.test/a");
    expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpUrl("data:text/html,x")).toBeUndefined();
    expect(safeHttpUrl("not a url")).toBeUndefined();
    expect(safeHttpUrl(null)).toBeUndefined();
  });
  it("isAgentEvent checks the type field", () => {
    expect(isAgentEvent({ type: "turn_end" })).toBe(true);
    expect(isAgentEvent({ type: 3 })).toBe(false);
    expect(isAgentEvent(null)).toBe(false);
    expect(isAgentEvent("x")).toBe(false);
  });
});

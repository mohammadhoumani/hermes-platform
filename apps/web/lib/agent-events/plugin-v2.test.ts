import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import pluginRun from "./fixtures/plugin-v2-actions.json";
import { applyEvent, createInitialState, replay } from "./reduce";
import { SKILL_PHASE } from "./roster";
import type { AgentEvent, ViewState } from "./types";

/** The events below were produced by the REAL plugin (hermes/tools/make_fixture_v2.py), not typed by hand. */
const events = pluginRun as unknown as AgentEvent[];
const visible = (s: ViewState) => s.feed.filter((f) => !f.quiet);

const repoRoot = resolve(__dirname, "../../../..");
const pluginSource = readFileSync(resolve(repoRoot, "hermes/plugin/hermes-platform/__init__.py"), "utf8");
const reducerSource = readFileSync(resolve(__dirname, "reduce.ts"), "utf8");

describe("the plugin and the web app agree", () => {
  it("every action the plugin can send has a case in the reducer", () => {
    const names = new Set([...pluginSource.matchAll(/"action":\s*"(\w+)"/g)].map((m) => m[1]!));
    expect(names.size).toBeGreaterThanOrEqual(20);
    for (const name of names) expect(reducerSource, `action ${name}`).toContain(`case "${name}"`);
  });

  it("the skill to phase map is the same in the plugin and in roster.ts", () => {
    const block = /SKILL_STAGE:[^=]*=\s*\{([\s\S]*?)\n\}/.exec(pluginSource)![1]!;
    const fromPlugin = Object.fromEntries([...block.matchAll(/"(sdlc-[\w-]+)":\s*"(\w+)"/g)].map((m) => [m[1]!, m[2]!]));
    expect(fromPlugin).toEqual(SKILL_PHASE);
  });
});

describe("replaying a run recorded from the v2 plugin", () => {
  const s = replay(events);

  it("goes through the six phases and finishes only when the state file says the site is live", () => {
    expect(s.phase).toBe("release");
    expect(s.finished).toBe(true);
    expect(s.urls.production).toBe("https://tip-calculator.vercel.app/");
    expect(s.urls.staging).toBe("https://tip-calculator-git-main.vercel.app/");
    expect(s.urls.repo).toBe("https://github.com/bot-account/tip-calculator");
    expect(s.gate).toBe("approved");
  });

  it("does not finish early on a production link that only appeared in command output", () => {
    const idx = events.findIndex((e) => e.type === "tool_end" && (e.actions ?? []).some((a) => a.action === "deploy" && a.src === "output"));
    expect(idx).toBeGreaterThan(0);
    const early = replay(events.slice(0, idx + 1));
    expect(early.finished).toBe(false);
    expect(early.urls.production).toBe("https://tip-calculator.vercel.app/");
    expect(visible(early).at(-1)!.text).toMatch(/Production deploy is ready/);
  });

  it("the Team sync issue does not start the Architecture phase", () => {
    const idx = events.findIndex((e) => e.type === "tool_end" && (e.actions ?? []).some((a) => a.action === "issue" && a.sync));
    const early = replay(events.slice(0, idx + 1));
    expect(early.phaseIndex).toBeLessThan(1); // still before Architecture
  });

  it("shows Team sync comments between the coders' lanes, with a label per kind", () => {
    const sync = visible(s).filter((f) => f.tag === "sync");
    expect(sync.map((f) => f.text)).toEqual([
      "Blocked: What is the exact name of the tip field?",
      "Interface change: calcTip(bill, percent) returns cents",
      "Ready: the form is on main",
    ]);
    // "task 2 -> task 1": Coder 2 (Task #2) talks to Coder 1 (Task #1)
    expect(sync[0]).toMatchObject({ from: "coder2", to: "coder1" });
    expect(sync[2]).toMatchObject({ from: "coder1", to: "coder2" });
    // "task 1 -> all" goes to the orchestrator
    expect(sync[1]).toMatchObject({ from: "coder1", to: "orchestrator" });
  });

  it("puts Devin on its own lane from the MCP tool calls, with the ACU limit visible", () => {
    expect(s.lanes.devin.task).toMatch(/Task 3 styles and layout/);
    const handoff = visible(s).find((f) => f.kind === "handoff" && f.to === "devin")!;
    expect(handoff.text).toMatch(/limit 5 ACU/);
    expect(visible(s).some((f) => f.tag === "devin" && /design tokens/.test(f.text))).toBe(true);
  });

  it("counts a failed and a passed QA round, and shows the bug report", () => {
    expect(s.stats.qaRounds).toBe(1);
    const tags = visible(s).map((f) => f.tag);
    expect(tags).toContain("bug");
    expect(visible(s).some((f) => f.tag === "qa" && /QA passed/.test(f.text))).toBe(true);
    expect(visible(s).some((f) => f.tag === "bug" && /Reported a bug: Custom tip of 0 shows NaN/.test(f.text))).toBe(true);
  });

  it("reads the project marker without showing it", () => {
    const first = events.find((e) => e.type === "turn_start")!;
    expect(first).toMatchObject({ project: "0b6f3c1e-7a52-4d0e-9c1b-2f6a5d8e4c11" });
    expect(visible(s)[0]!.text).not.toMatch(/hermes-project/);
  });

  it("a Devin tool call that failed shows Devin as stopped", () => {
    let st = createInitialState();
    st = applyEvent(st, { type: "skill", name: "sdlc-development" });
    st = applyEvent(st, { type: "tool_end", tool: "x", status: "ok", actions: [{ action: "devin", op: "create", task: "Styles", failed: true }] });
    expect(st.lanes.devin.done).toBe("failed");
  });

  it("an unknown action from a newer plugin does not break the view", () => {
    const st = applyEvent(replay(events.slice(0, 5)), { type: "tool_end", tool: "x", status: "ok", actions: [{ action: "from_the_future" } as never] });
    expect(st.eventCount).toBe(6);
  });
});

/**
 * Turns the raw event stream into one ViewState. Pure: no DOM, no timers, no network.
 *
 * Ported from legacy/agent-room/web/index.html (onLive, onAction, apply, assignLane, goStage) and extended
 * for the v2 roster (Orchestrator, BA, Architect, Coder 1, Coder 2, Devin, Reviewer, QA, Release, GitHub),
 * the six phases, and one human gate (the BRD).
 *
 * applyEvent returns a NEW state and never changes the one you pass in, so it is safe to use with React state.
 */
import { AGENTS, CLAUDE_LANES, LANES, PHASES, SKILL_PHASE, phaseIndexOf } from "./roster";
import {
  APPROVAL_ASK_RE,
  BRD_APPROVED_RE,
  branchIn,
  cleanOrderText,
  clip,
  firstUrl,
  prIn,
  prKey,
  safeHttpUrl,
} from "./text";
import {
  LANE_STEPS,
  type AgentEvent,
  type AgentId,
  type AgentStatus,
  type DevinEvent,
  type FeedItem,
  type FeedTag,
  type LaneId,
  type LaneStep,
  type LaneView,
  type PhaseId,
  type ToolAction,
  type ViewState,
} from "./types";

const MAX_FEED = 1500;
const MAX_SAYS = 400;
const GH_TAGS = new Set<FeedTag>(["commit", "pr", "ci", "ci-fail", "merge", "deploy", "issue", "guard", "push", "branch", "repo"]);

const emptyLane = (): LaneView => ({ step: -1, task: "", branch: "", pr: "", ci: "", review: "", done: "" });

export function createInitialState(): ViewState {
  const agents = {} as Record<AgentId, AgentStatus>;
  for (const id of Object.keys(AGENTS) as AgentId[]) agents[id] = "idle";
  return {
    phaseIndex: -1,
    phase: null,
    finished: false,
    changeRequest: false,
    gate: "none",
    agents,
    doing: {},
    links: [],
    lanes: { coder1: emptyLane(), coder2: emptyLane(), devin: emptyLane() },
    feed: [],
    says: [],
    stats: { messages: 0, handoffs: 0, commits: 0, prs: 0, ci: 0, merges: 0, reviewRounds: 0, qaRounds: 0 },
    urls: {},
    eventCount: 0,
    internal: { seq: 0, childAgent: {}, laneOwner: {}, laneUsed: {}, laneSeq: 0, prLane: {}, brdWritten: false },
  };
}

function cloneState(p: ViewState): ViewState {
  return {
    ...p,
    agents: { ...p.agents },
    doing: { ...p.doing },
    links: p.links.map((l) => ({ ...l })),
    lanes: { coder1: { ...p.lanes.coder1 }, coder2: { ...p.lanes.coder2 }, devin: { ...p.lanes.devin } },
    stats: { ...p.stats },
    urls: { ...p.urls },
    internal: {
      ...p.internal,
      childAgent: { ...p.internal.childAgent },
      laneOwner: { ...p.internal.laneOwner },
      laneUsed: { ...p.internal.laneUsed },
      prLane: { ...p.internal.prLane },
    },
  };
}

// ---------------------------------------------------------------------------
// Small state helpers (all mutate the draft `s`)
// ---------------------------------------------------------------------------

const isLane = (a: AgentId | string | undefined | null): a is LaneId => a === "coder1" || a === "coder2" || a === "devin";

/** The agent who speaks for the main session in the current phase. */
function voice(s: ViewState): AgentId {
  return s.phaseIndex < 0 ? "orchestrator" : PHASES[s.phaseIndex]!.voice;
}

function agentOf(s: ViewState, sid: string | undefined): AgentId {
  return sid && s.internal.childAgent[sid] ? s.internal.childAgent[sid]! : voice(s);
}

/** Agents tied to one phase are "done" once the run has moved past it. */
const AGENT_PHASE: Partial<Record<AgentId, number>> = { ba: 0, architect: 1, reviewer: 3, qa: 4 };

function isDone(s: ViewState, id: AgentId): boolean {
  if (id === "github") return false;
  if (s.finished) return id !== "human";
  const ph = AGENT_PHASE[id];
  if (ph !== undefined && s.phaseIndex > ph) return true;
  if (isLane(id)) return s.lanes[id].step === LANE_STEPS.length - 1;
  return false;
}

function activate(s: ViewState, ids: (AgentId | null | undefined)[]): void {
  for (const k of Object.keys(s.agents) as AgentId[]) {
    if (s.agents[k] === "active") s.agents[k] = isDone(s, k) ? "done" : "idle";
  }
  for (const k of ids) if (k && s.agents[k] !== undefined && s.agents[k] !== "waiting") s.agents[k] = "active";
}

function settleIdle(s: ViewState): void {
  for (const k of Object.keys(s.agents) as AgentId[]) {
    if (s.agents[k] !== "active" && s.agents[k] !== "waiting") s.agents[k] = isDone(s, k) ? "done" : "idle";
  }
}

function link(s: ViewState, a: AgentId, b: AgentId): void {
  if (a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  const found = s.links.find((l) => l.a === x && l.b === y);
  if (found) {
    found.count++;
    found.lastSeq = s.internal.seq;
  } else s.links.push({ a: x, b: y, count: 1, lastSeq: s.internal.seq });
}

interface NewItem {
  kind: FeedItem["kind"];
  from: AgentId;
  to?: AgentId;
  tag: FeedTag;
  text: string;
  quiet?: boolean;
  lane?: LaneId | undefined;
}

function push(s: ViewState, ts: number | undefined, it: NewItem): FeedItem {
  const item: FeedItem = { id: ++s.internal.seq, ts, ...it };
  if (item.lane === undefined) delete item.lane;
  if (item.to === undefined) delete item.to;
  if (!item.quiet) {
    s.now = item;
    if (item.kind === "message" || item.kind === "handoff" || item.kind === "action") s.stats.messages++;
    if (item.kind === "handoff") s.stats.handoffs++;
    s.doing[item.from] = clip(item.text, 120);
  }
  s.feed = s.feed.length >= MAX_FEED ? [...s.feed.slice(s.feed.length - MAX_FEED + 1), item] : [...s.feed, item];
  return item;
}

/** A message between two agents (a dot travels on the map). */
function say(s: ViewState, ts: number | undefined, it: Omit<NewItem, "kind"> & { kind?: FeedItem["kind"] }): FeedItem {
  const item = push(s, ts, { kind: "message", ...it });
  if (!it.quiet) {
    activate(s, [it.from, it.to]);
    if (it.to) link(s, it.from, it.to);
    if (it.to && it.to !== "github" && GH_TAGS.has(it.tag)) {
      link(s, it.from, "github");
      s.agents.github = "active";
    }
  } else activate(s, [it.from]);
  return item;
}

function updateLane(s: ViewState, id: LaneId | undefined, o: Partial<LaneView> & { stepName?: LaneStep; reset?: boolean }): void {
  if (!id) return;
  const L = s.lanes[id];
  if (o.reset) Object.assign(L, { step: -1, pr: "", ci: "", review: "", done: "" });
  if (o.stepName) {
    const si = LANE_STEPS.indexOf(o.stepName);
    if (si > L.step) L.step = si;
  }
  if (o.ci === "running" && L.step > LANE_STEPS.indexOf("ci")) L.step = LANE_STEPS.indexOf("ci");
  for (const k of ["task", "branch", "pr", "ci", "review", "done"] as const) {
    const v = o[k];
    if (v !== undefined && v !== null) (L[k] as string) = v;
  }
  if (o.stepName === "merged" && !L.ci) L.ci = "passed";
}

function goPhase(s: ViewState, id: PhaseId, ts: number | undefined, why?: string): void {
  const idx = phaseIndexOf(id);
  if (idx <= s.phaseIndex) return;
  const from = voice(s);
  s.phaseIndex = idx;
  s.phase = id;
  push(s, ts, { kind: "phase", from: PHASES[idx]!.voice, tag: "handoff", text: PHASES[idx]!.label });
  settleIdle(s);
  // Moving past discovery means the one human gate (the BRD) was passed.
  if (idx >= 1 && s.gate !== "approved" && (s.gate === "waiting" || s.internal.brdWritten)) approveGate(s, ts);
  const to = voice(s);
  if (why && from !== to) say(s, ts, { kind: "handoff", from, to, tag: "handoff", text: why });
}

function skillPhase(s: ViewState, name: string | undefined, ts: number | undefined): void {
  if (!name) return;
  const target = SKILL_PHASE[name];
  if (!target) return;
  if (name === "sdlc-change-request") {
    startChangeRequest(s, ts);
    return;
  }
  if (target === "kickoff") {
    activate(s, ["orchestrator"]);
    return;
  }
  goPhase(s, target, ts, `Loaded ${name}`);
}

/** A change request on a released project: development, review, QA and release run again, without a new BRD. */
function startChangeRequest(s: ViewState, ts: number | undefined): void {
  if (s.changeRequest && !s.finished) return;
  s.changeRequest = true;
  s.finished = false;
  s.phaseIndex = phaseIndexOf("development") - 1; // so goPhase("development") is accepted
  s.phase = "architecture";
  s.lanes = { coder1: emptyLane(), coder2: emptyLane(), devin: emptyLane() };
  s.internal.laneOwner = {};
  s.internal.prLane = {};
  s.internal.childAgent = {};
  for (const k of Object.keys(s.agents) as AgentId[]) s.agents[k] = "idle";
  s.stats.reviewRounds = 0;
  s.stats.qaRounds = 0;
  goPhase(s, "development", ts, "Change request received. Start development");
}

function finish(s: ViewState): void {
  s.finished = true;
  for (const k of Object.keys(s.agents) as AgentId[]) s.agents[k] = k === "human" || k === "github" ? "idle" : "done";
}

function assignLane(s: ViewState, child: string, devin: boolean): LaneId {
  const pool: LaneId[] = devin ? ["devin"] : CLAUDE_LANES;
  let lane = pool.find((l) => !s.internal.laneOwner[l]);
  if (!lane) lane = [...pool].sort((a, b) => (s.internal.laneUsed[a] ?? 0) - (s.internal.laneUsed[b] ?? 0))[0]!;
  s.internal.laneOwner[lane] = child;
  s.internal.laneUsed[lane] = ++s.internal.laneSeq;
  return lane;
}

function laneOfAction(s: ViewState, a: AgentId, x: { pr?: string | number | null; branch?: string }): LaneId | undefined {
  if (isLane(a)) return a;
  const pr = prKey(x.pr);
  if (pr && s.internal.prLane[pr]) return s.internal.prLane[pr];
  if (x.branch) return LANES.find((id) => s.lanes[id].branch === x.branch);
  return undefined;
}

/** Decide which agent a new sub-agent is, from its role and goal text. */
export function classifySubAgent(role: string | undefined, goal: string | undefined, phaseIndex: number): AgentId | "coder" {
  const text = `${role ?? ""} ${goal ?? ""}`;
  if (/\bdevin\b/i.test(text)) return "devin";
  if (/\b(fix|hotfix|rebase|conflict|rework|bug ?fix)\b/i.test(text)) return "coder";
  if (/\breview/i.test(text) && phaseIndex >= phaseIndexOf("development")) return "reviewer";
  if (/\b(qa|quality|e2e|playwright|acceptance test|test plan)\b/i.test(text) && phaseIndex >= phaseIndexOf("review")) return "qa";
  if (/\barchitect/i.test(text)) return "architect";
  if (/\b(business analyst|requirements|brd)\b/i.test(text) && phaseIndex <= phaseIndexOf("discovery")) return "ba";
  if (/\b(release|deploy|devops|readme|user guide)\b/i.test(text) && phaseIndex >= phaseIndexOf("qa")) return "release";
  return "coder";
}

// ---------------------------------------------------------------------------
// Actions (git / gh / file things the plugin recognised)
// ---------------------------------------------------------------------------

function onAction(s: ViewState, a: AgentId, x: ToolAction, ts: number | undefined, sid: string | undefined): void {
  const xp = x as { pr?: string | number | null; branch?: string };
  const lane = laneOfAction(s, a, xp);
  const pr = prKey(xp.pr);
  switch (x.action) {
    case "commit":
      s.stats.commits++;
      say(s, ts, { from: a, to: "github", tag: "commit", text: `Committed${x.message ? ": " + x.message : ""}`, lane });
      updateLane(s, lane, { stepName: "commit" });
      break;
    case "push":
      say(s, ts, { from: a, to: "github", tag: "push", text: `Pushed${x.branch ? " to " + x.branch : ""}`, lane });
      updateLane(s, lane, { stepName: "commit" });
      break;
    case "worktree":
    case "branch":
      if (x.branch) {
        push(s, ts, { kind: "action", from: a, tag: "branch", text: `New branch ${x.branch}`, quiet: true, lane });
        updateLane(s, lane, { branch: x.branch });
      }
      break;
    case "pr_open": {
      if (/readme|docs?\b|guide|release/i.test(`${x.title ?? ""} ${x.branch ?? ""}`) && s.phaseIndex >= phaseIndexOf("qa")) {
        goPhase(s, "release", ts, "QA passed. Start the release");
      }
      if (pr && lane) s.internal.prLane[pr] = lane;
      s.stats.prs++;
      say(s, ts, {
        from: agentOf(s, sid), to: "github", tag: "pr",
        text: `${pr ? "Opened PR " + pr : "Opened a pull request"}${x.title ? ": " + x.title : ""}`, lane,
      });
      updateLane(s, lane, { stepName: "pr", ...(pr ? { pr } : {}), ...(x.branch ? { branch: x.branch } : {}) });
      break;
    }
    case "ci": {
      s.stats.ci++;
      const failed = x.outcome === "failed";
      say(s, ts, { from: a, to: "github", tag: failed ? "ci-fail" : "ci", text: `CI ${x.outcome ?? "checked"}${pr ? " on PR " + pr : ""}`, lane });
      updateLane(s, lane, { stepName: "ci", ci: x.outcome ?? "passed" });
      break;
    }
    case "review": {
      if (s.phaseIndex < phaseIndexOf("review")) goPhase(s, "review", ts, "Pull requests are ready for review");
      const me: AgentId = "reviewer"; // every review and approval is the Reviewer's work
      const rv = x.verdict ?? "reviewed";
      const verb = rv === "approved" ? "Approved" : rv === "changes" ? "Changes requested on" : "Reviewed";
      if (rv === "changes") s.stats.reviewRounds++;
      say(s, ts, {
        from: me, to: lane ?? "github", tag: rv === "changes" ? "changes" : "review",
        text: `${verb} PR ${pr}${x.body ? ": " + x.body : ""}`.replace(/\s+:/, ":").replace(/PR :/, "PR:"), lane,
      });
      if (lane) link(s, me, "github");
      updateLane(s, lane, { stepName: "review", review: rv });
      break;
    }
    case "pr_merge":
      s.stats.merges++;
      say(s, ts, { from: isLane(a) ? a : "reviewer", to: "github", tag: "merge", text: pr ? `Merged PR ${pr}` : "Merged a pull request", lane });
      updateLane(s, lane, { stepName: "merged" });
      break;
    case "issue":
      if (s.phaseIndex < phaseIndexOf("architecture")) goPhase(s, "architecture", ts, "Plan the work");
      say(s, ts, { from: agentOf(s, sid), to: "github", tag: "issue", text: `Created issue${x.title ? ": " + x.title : ""}` });
      break;
    case "repo": {
      say(s, ts, { from: a, to: "github", tag: "repo", text: `Created repo ${x.repo ?? ""}${x.template ? " from " + x.template : ""}`.trim() });
      if (x.repo && /^[\w.-]+\/[\w.-]+$/.test(x.repo)) s.urls.repo = `https://github.com/${x.repo}`;
      break;
    }
    case "protect":
      say(s, ts, { from: a, to: "github", tag: "guard", text: "Turned on branch protection for main" });
      break;
    case "pages": // legacy: GitHub Pages URL. In v2 the deploy action is used instead.
      if (x.url) onAction(s, a, { action: "deploy", env: "production", url: x.url }, ts, sid);
      else say(s, ts, { from: agentOf(s, sid), to: "github", tag: "deploy", text: "Checked GitHub Pages" });
      break;
    case "deploy": {
      const url = safeHttpUrl(x.url);
      if (x.env === "staging") {
        if (url) s.urls.staging = url;
        say(s, ts, { from: agentOf(s, sid), to: "github", tag: "deploy", text: `Staging site updated${url ? ": " + url : ""}` });
      } else {
        if (s.phaseIndex < phaseIndexOf("release")) goPhase(s, "release", ts, "Start the release");
        if (url) {
          s.urls.production = url;
          say(s, ts, { from: agentOf(s, sid), to: "human", tag: "live", text: `Live: ${url}` });
          finish(s);
        } else say(s, ts, { from: agentOf(s, sid), to: "github", tag: "deploy", text: "Production deploy started" });
      }
      break;
    }
    case "brd":
      if (s.phaseIndex < phaseIndexOf("discovery")) goPhase(s, "discovery", ts, "Gather the requirements");
      s.internal.brdWritten = true;
      push(s, ts, { kind: "action", from: agentOf(s, sid), tag: "file", text: `Wrote ${x.path ?? "the BRD"}` });
      activate(s, [agentOf(s, sid)]);
      break;
    case "plan":
      if (s.phaseIndex < phaseIndexOf("architecture")) goPhase(s, "architecture", ts, "Plan the work");
      push(s, ts, { kind: "action", from: agentOf(s, sid), tag: "file", text: `Wrote ${x.path ?? "the plan"}` });
      activate(s, [agentOf(s, sid)]);
      break;
    case "docs":
      push(s, ts, { kind: "action", from: a, tag: "docs", text: `Wrote ${x.path ?? "a document"}`, quiet: true });
      break;
    case "approval": // legacy approvals.md. Only the BRD gate exists in v2.
      if ((x.gates ?? []).includes("G1") && s.gate !== "approved") approveGate(s, ts);
      else push(s, ts, { kind: "action", from: a, tag: "file", text: `Updated ${x.path ?? "approvals"}`, quiet: true });
      break;
    case "file":
      push(s, ts, { kind: "action", from: a, tag: "file", text: `Edited ${x.path ?? "a file"}`, quiet: true, lane });
      updateLane(s, lane, { stepName: "code" });
      break;
    case "sync": {
      const kind = x.kind ?? "note";
      const text = clip(x.text ?? "", 160) || "Posted on the Team sync issue";
      say(s, ts, { from: a, to: "orchestrator", tag: "sync", text: `${kind === "blocker" ? "Blocked: " : kind === "question" ? "Question: " : ""}${text}`, lane });
      break;
    }
    case "qa_result": {
      if (s.phaseIndex < phaseIndexOf("qa")) goPhase(s, "qa", ts, "Staging is ready for testing");
      const failed = x.outcome === "failed";
      if (failed) s.stats.qaRounds++;
      say(s, ts, {
        from: "qa", to: "orchestrator", tag: failed ? "bug" : "qa",
        text: failed
          ? `QA found ${x.bugs ?? "some"} bug${x.bugs === 1 ? "" : "s"}${x.summary ? ": " + clip(x.summary, 120) : ""}`
          : `QA passed${x.summary ? ": " + clip(x.summary, 120) : ""}`,
      });
      break;
    }
  }
}

function approveGate(s: ViewState, ts: number | undefined): void {
  if (s.gate === "approved") return;
  s.gate = "approved";
  if (s.agents.human === "waiting") s.agents.human = "idle";
  push(s, ts, { kind: "gate", from: "human", to: "orchestrator", tag: "gate", text: "BRD approved" });
  activate(s, ["human", "orchestrator"]);
  link(s, "human", "orchestrator");
}

// ---------------------------------------------------------------------------
// Devin events (planned, M3): routed to the Devin lane
// ---------------------------------------------------------------------------

function onDevin(s: ViewState, ev: DevinEvent, ts: number | undefined): void {
  if (s.phaseIndex < phaseIndexOf("development")) goPhase(s, "development", ts, "Plan ready. Start development");
  const text = clip(ev.text ?? ev.summary ?? ev.task ?? "", 160);
  switch (ev.type) {
    case "devin_started":
      s.internal.laneOwner.devin = ev.sid ?? "devin";
      s.internal.laneUsed.devin = ++s.internal.laneSeq;
      updateLane(s, "devin", { reset: true, stepName: "assigned", task: clip(ev.task ?? text, 90), branch: ev.branch ?? branchIn(text) });
      say(s, ts, { kind: "handoff", from: "orchestrator", to: "devin", tag: "handoff", text: text || "Task handed to Devin", lane: "devin" });
      break;
    case "devin_progress":
      say(s, ts, { from: "devin", to: "github", tag: "devin", text: text || "Working", lane: "devin", quiet: !text });
      updateLane(s, "devin", { stepName: "code" });
      break;
    case "devin_pr": {
      const pr = prKey(ev.pr);
      if (pr) s.internal.prLane[pr] = "devin";
      s.stats.prs++;
      say(s, ts, { from: "devin", to: "github", tag: "pr", text: `${pr ? "Opened PR " + pr : "Opened a pull request"}${text ? ": " + text : ""}`, lane: "devin" });
      updateLane(s, "devin", { stepName: "pr", ...(pr ? { pr } : {}) });
      break;
    }
    case "devin_done":
      s.internal.laneOwner.devin = null;
      say(s, ts, { from: "devin", to: "orchestrator", tag: "done", text: `Done${text ? ": " + text : ""}`, lane: "devin" });
      updateLane(s, "devin", { done: "completed" });
      break;
    case "devin_failed":
      s.internal.laneOwner.devin = null;
      say(s, ts, { from: "devin", to: "orchestrator", tag: "error", text: `Stopped${text ? ": " + text : ""}`, lane: "devin" });
      updateLane(s, "devin", { done: "failed" });
      break;
  }
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export function applyEvent(prev: ViewState, ev: AgentEvent): ViewState {
  const s = cloneState(prev);
  s.eventCount++;
  const ts = typeof ev.ts === "number" ? ev.ts : undefined;
  if (ts !== undefined) s.lastTs = ts;

  switch (ev.type) {
    case "turn_start": {
      if (ev.sid && s.internal.childAgent[ev.sid]) break;
      const text = cleanOrderText(ev.text);
      const cmd = /^\s*\/(sdlc-[a-z-]+)/.exec(text)?.[1];
      if (cmd === "sdlc-orchestrator" && s.phaseIndex < 0) activate(s, ["orchestrator"]);
      const approves = BRD_APPROVED_RE.test(text) && s.phaseIndex <= phaseIndexOf("discovery");
      say(s, ts, { from: "human", to: voice(s), tag: cmd ? "command" : "message", text: text || "(message)" });
      if (s.agents.human === "waiting") s.agents.human = "idle";
      if (approves) approveGate(s, ts);
      if (cmd && cmd !== "sdlc-orchestrator") skillPhase(s, cmd, ts);
      break;
    }
    case "turn_end": {
      if (ev.sid && s.internal.childAgent[ev.sid]) break;
      const text = ev.text || "(reply)";
      const me = voice(s);
      const item = say(s, ts, { from: me, to: "human", tag: "reply", text });
      s.says = [...s.says.slice(-(MAX_SAYS - 1)), { id: item.id, agent: me, kind: "reply", text, ...(ts !== undefined ? { ts } : {}) }];
      const asksG1 = (ev.gates ?? []).includes("G1");
      if (s.gate === "none" && s.phaseIndex <= phaseIndexOf("discovery") && (asksG1 || (s.internal.brdWritten && APPROVAL_ASK_RE.test(text)))) {
        s.gate = "waiting";
        s.agents.human = "waiting";
        push(s, ts, { kind: "gate", from: me, to: "human", tag: "gate", text: "Waiting for you to approve the BRD" });
      }
      if (s.phaseIndex === phaseIndexOf("release") && !s.finished) {
        const url = safeHttpUrl(firstUrl(text));
        if (url && /\b(live|released|published|production)\b/i.test(text)) {
          s.urls.production = s.urls.production ?? url;
          finish(s);
        }
      }
      break;
    }
    case "skill":
      skillPhase(s, ev.name, ts);
      break;
    case "tool_start": {
      if (ev.tool === "skill_view") skillPhase(s, ev.summary, ts);
      const a = agentOf(s, ev.sid);
      const lane = isLane(a) ? a : undefined;
      push(s, ts, { kind: "action", from: a, tag: "tool", text: `${ev.tool}${ev.summary ? ": " + ev.summary : ""}`, quiet: true, lane });
      activate(s, [a]);
      if (lane && s.lanes[lane].step < 1) updateLane(s, lane, { stepName: "code" });
      break;
    }
    case "tool_end": {
      const a = agentOf(s, ev.sid);
      if (ev.status && ev.status !== "ok") {
        push(s, ts, { kind: "action", from: a, tag: "error", text: `${ev.tool} ${ev.status}${ev.error ? ": " + ev.error : ""}`, quiet: true });
      }
      for (const x of ev.actions ?? []) onAction(s, a, x, ts, ev.sid);
      break;
    }
    case "sub_start": {
      if (!ev.child) break;
      if (ev.parent && s.internal.childAgent[ev.parent]) {
        s.internal.childAgent[ev.child] = s.internal.childAgent[ev.parent]!; // helper of a helper: same lane
        break;
      }
      const text = ev.goal || ev.role || "Sub-task";
      const kind = classifySubAgent(ev.role, ev.goal, s.phaseIndex);
      let agent: AgentId;
      if (kind === "coder" || kind === "devin") {
        if (s.phaseIndex < phaseIndexOf("development")) goPhase(s, "development", ts, "Plan ready. Start development");
        const br = branchIn(text);
        const prm = prIn(text);
        const reuse = (br && LANES.find((id) => s.lanes[id].branch === br)) || (prm ? s.internal.prLane[prm] : undefined);
        if (reuse) {
          s.internal.laneOwner[reuse] = ev.child;
          s.internal.laneUsed[reuse] = ++s.internal.laneSeq;
          s.internal.childAgent[ev.child] = reuse;
          const from = voice(s) === reuse ? "orchestrator" : voice(s);
          say(s, ts, { kind: "handoff", from, to: reuse, tag: "handoff", text, lane: reuse });
          updateLane(s, reuse, { done: "" });
          break;
        }
        agent = assignLane(s, ev.child, kind === "devin");
      } else {
        agent = kind;
        if (kind === "reviewer" && s.phaseIndex < phaseIndexOf("review")) goPhase(s, "review", ts, "Pull requests are ready for review");
        if (kind === "qa" && s.phaseIndex < phaseIndexOf("qa")) goPhase(s, "qa", ts, "Staging is ready for testing");
        if (kind === "architect" && s.phaseIndex < phaseIndexOf("architecture")) goPhase(s, "architecture", ts, "BRD approved. Design the system");
        if (kind === "release" && s.phaseIndex < phaseIndexOf("release")) goPhase(s, "release", ts, "QA passed. Start the release");
      }
      s.internal.childAgent[ev.child] = agent;
      const from = voice(s) === agent ? "orchestrator" : voice(s);
      const laneId = isLane(agent) ? agent : undefined;
      say(s, ts, { kind: "handoff", from, to: agent, tag: "handoff", text, lane: laneId });
      if (laneId) updateLane(s, laneId, { reset: true, stepName: "assigned", task: text.slice(0, 90), branch: branchIn(text) });
      break;
    }
    case "sub_stop": {
      const agent = ev.child ? s.internal.childAgent[ev.child] : undefined;
      if (!agent || !ev.child) break;
      if (s.internal.laneOwner[agent as LaneId] === ev.child) s.internal.laneOwner[agent as LaneId] = null;
      const st = ev.status || "completed";
      const parent = ev.parent && s.internal.childAgent[ev.parent] ? s.internal.childAgent[ev.parent]! : voice(s);
      const lane = isLane(agent) ? agent : undefined;
      say(s, ts, {
        from: agent, to: parent === agent ? "orchestrator" : parent, tag: st === "completed" ? "done" : "error",
        text: `${st === "completed" ? "Done" : "Stopped (" + st + ")"}${ev.summary ? ": " + ev.summary : ""}`, lane,
      });
      updateLane(s, lane, { done: st });
      break;
    }
    case "human_ask": {
      if (ev.kind === "approval") break;
      const me = agentOf(s, ev.sid);
      const text = ev.text || "Needs your input";
      const item = say(s, ts, { from: me, to: "human", tag: "question", text });
      s.says = [...s.says.slice(-(MAX_SAYS - 1)), { id: item.id, agent: me, kind: "question", text, ...(ts !== undefined ? { ts } : {}) }];
      s.agents.human = "waiting";
      break;
    }
    case "human_answer":
      if (ev.kind === "approval") break;
      s.agents.human = "idle";
      say(s, ts, { from: "human", to: agentOf(s, ev.sid), tag: "answer", text: `Answered (${ev.outcome ?? "ok"})` });
      break;
    case "approval_ask":
      say(s, ts, { from: voice(s), to: "human", tag: "approval", text: `Asks before running: ${ev.command || ev.description || "a command"}` });
      break;
    case "approval_answer":
      say(s, ts, { from: "human", to: voice(s), tag: "approval", text: `Answer: ${ev.choice ?? "unknown"}` });
      break;
    case "turn_stopped":
      push(s, ts, { kind: "action", from: agentOf(s, ev.sid), tag: "error", text: ev.interrupted ? "Turn stopped" : "Turn failed" });
      break;
    case "devin_started":
    case "devin_progress":
    case "devin_pr":
    case "devin_done":
    case "devin_failed":
      onDevin(s, ev, ts);
      break;
    default:
      break; // session_start, plugin_loaded and unknown types do not change the view
  }
  if (s.finished) finish(s); // nothing stays "active" once the project is live
  return s;
}

/** Build the ViewState for a list of events (oldest first). */
export function replay(events: Iterable<AgentEvent>, from: ViewState = createInitialState()): ViewState {
  let s = from;
  for (const ev of events) s = applyEvent(s, ev);
  return s;
}

/** Narrow unknown JSON from the database to an AgentEvent (only checks that `type` is a string). */
export function isAgentEvent(x: unknown): x is AgentEvent {
  return typeof x === "object" && x !== null && typeof (x as { type?: unknown }).type === "string";
}

export const PHASE_COUNT = PHASES.length;

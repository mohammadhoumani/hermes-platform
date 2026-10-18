/**
 * ViewState -> what the 3D office should show. Pure: no three.js, no React, no timers, no randomness.
 *
 * The 3D scene is "driven only by the ViewState". Things that depend on time (a walk that is over, a speech
 * bubble that has been on screen long enough) are passed in through `OfficeOptions` by the component, which keeps
 * this function easy to test with the fixtures.
 */
import { AGENTS, AGENT_ORDER, PHASES } from "@/lib/agent-events/roster";
import { clip } from "@/lib/agent-events/text";
import type { AgentId, FeedItem, FeedTag, PhaseId, ViewState } from "@/lib/agent-events/types";
import { LANE_STEPS } from "@/lib/agent-events/types";
import { DESK, facing, meetingSeatOf, seatOf, visitSpotOf, type Spot } from "./layout";

/** How an agent looks: green = working, rose = needs the user, dim green = done. */
export type Visual = "working" | "needs-you" | "done" | "idle";
/** What an agent is doing with its body. */
export type Pose = "seated" | "visiting" | "meeting";

export interface AgentScene {
  id: AgentId;
  name: string;
  visual: Visual;
  /** Plain words for the label under the name. */
  statusText: string;
  pose: Pose;
  /** Where the figure should be (the desk seat, the receiver's desk, or the meeting table). */
  target: Spot;
  /** Rotation around y so the figure faces what it works on. */
  face: number;
  /** The agent they are walking to, when `pose` is "visiting". */
  visiting?: AgentId;
}

export type BubbleTone = "note" | "question" | "attention";

export interface Bubble {
  /** The feed item id (or -1 for the "needs you" bubble). */
  id: number;
  agent: AgentId;
  text: string;
  tone: BubbleTone;
}

export interface Packet {
  /** The feed item id: a new id means a new packet. */
  id: number;
  from: AgentId;
  to: AgentId;
}

export type MeetingKind = "review" | "qa";

export interface OfficeScene {
  agents: AgentScene[];
  /** The GitHub server rack: lights blink while it is "active". */
  rackActive: boolean;
  /** The user has to do something (approve the BRD or answer a question). Highlights the You spot in rose. */
  needsYou: boolean;
  meeting: { kind: MeetingKind; participants: AgentId[] } | null;
  bubbles: Bubble[];
  packet: Packet | null;
  phase: { index: number; id: PhaseId | null; label: string; text: string };
  /** One sentence for screen readers: what is happening now. */
  summary: string;
}

export interface OfficeOptions {
  /** False under reduced motion: nobody walks to a desk and no packet flies, but the meeting still gathers. */
  walking?: boolean;
  /** Only feed items with an id above this can make someone walk or send a packet (older ones are history). */
  freshAfter?: number;
  /** The handoff (feed id) whose walk is over: its sender goes back to their desk. */
  settledHandoff?: number;
  /** Bubbles (feed ids) that have been on screen long enough. */
  expiredBubbles?: ReadonlySet<number>;
}

const NONE: ReadonlySet<number> = new Set();
const BUBBLE_LIMIT = 3;
const BUBBLE_SCAN = 40;
const BUBBLE_CHARS = 70;

/** Tags that are worth a speech bubble. Commits, pushes, CI and file edits are too small to talk about. */
const BUBBLE_TAGS = new Set<FeedTag>(["sync", "question", "reply", "bug", "changes", "review", "qa", "handoff", "gate", "answer", "live", "approval", "message", "done", "error"]);

const STATUS_TEXT: Record<Visual, string> = { working: "working", "needs-you": "needs you", done: "done", idle: "idle" };

/** Words for the screen reader summary: "Coder 1 is opening a pull request". */
const DOING: Partial<Record<FeedTag, string>> = {
  commit: "is saving a change",
  push: "is sending code to GitHub",
  pr: "is opening a pull request",
  ci: "is checking the build",
  "ci-fail": "has a failing check",
  review: "is reviewing a pull request",
  changes: "is asking for changes",
  merge: "is merging a pull request",
  deploy: "is publishing the site",
  live: "has published the site",
  issue: "is creating an issue",
  repo: "is setting up the repository",
  guard: "is protecting the main branch",
  question: "has a question for you",
  sync: "is posting on the team sync",
  bug: "found a bug",
  qa: "finished testing",
  done: "finished a task",
  devin: "is working on a task",
  branch: "is starting a branch",
  file: "is writing a file",
  docs: "is writing documents",
  error: "ran into a problem",
};

export function agentName(id: AgentId): string {
  return AGENTS[id].name;
}

function isDeskAgent(id: AgentId | undefined): id is AgentId {
  return !!id && id !== "human" && id !== "github";
}

/** The newest feed items people would notice (no quiet tool steps). */
function recentLoud(view: ViewState, scan: number): FeedItem[] {
  const out: FeedItem[] = [];
  for (let i = view.feed.length - 1; i >= 0 && out.length < scan; i--) {
    const item = view.feed[i]!;
    if (!item.quiet) out.push(item);
  }
  return out;
}

/** The user has to act: the BRD is waiting, or an agent asked a question. */
export function needsUser(view: ViewState): boolean {
  return !view.finished && (view.gate === "waiting" || view.agents.human === "waiting");
}

/** Who is asking the user. Falls back to the voice of the current phase. */
export function askerOf(view: ViewState): AgentId {
  const last = view.says[view.says.length - 1];
  if (last) return last.agent;
  return view.phaseIndex >= 0 ? PHASES[view.phaseIndex]!.voice : "orchestrator";
}

function bubbleText(item: FeedItem): string {
  const text = clip(item.text.replace(/\s+/g, " ").trim(), BUBBLE_CHARS);
  return text;
}

/** The speech bubbles that could be on screen now (before the component hides the old ones). Newest first. */
export function pickBubbles(view: ViewState): Bubble[] {
  const out: Bubble[] = [];
  const taken = new Set<AgentId>();
  for (const item of recentLoud(view, BUBBLE_SCAN)) {
    if (out.length >= BUBBLE_LIMIT) break;
    if (item.kind === "phase" || item.kind === "action") continue;
    if (!BUBBLE_TAGS.has(item.tag)) continue;
    if (item.from === "github" || taken.has(item.from)) continue;
    taken.add(item.from);
    const tone: BubbleTone = item.tag === "question" || (item.tag === "gate" && item.to === "human") ? "attention" : "note";
    out.push({ id: item.id, agent: item.from, text: bubbleText(item) || "...", tone });
  }
  return out;
}

/** Who sits at the meeting table: the reviewer with the coders they are checking, or QA with the orchestrator. */
export function meetingOf(view: ViewState): OfficeScene["meeting"] {
  if (view.finished) return null;
  if (view.phase === "review" && view.agents.reviewer === "active") {
    const reviewIndex = LANE_STEPS.indexOf("review");
    const coders = (["coder1", "coder2", "devin"] as const).filter((lane) => {
      const l = view.lanes[lane];
      return l.step === reviewIndex && view.agents[lane] === "active" && l.review !== "changes";
    });
    return { kind: "review", participants: ["reviewer", ...coders] };
  }
  if (view.phase === "qa" && view.agents.qa === "active") {
    return { kind: "qa", participants: ["qa", "orchestrator"] };
  }
  return null;
}

function visualOf(view: ViewState, id: AgentId, asking: boolean, waitingForUser: boolean): Visual {
  if (id === "human") return waitingForUser ? "needs-you" : view.agents.human === "active" ? "working" : "idle";
  if (waitingForUser && asking) return "needs-you";
  switch (view.agents[id]) {
    case "active":
      return "working";
    case "waiting":
      return "needs-you";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

/** The walk or packet that belongs to the newest visible message, if any. */
function currentTrip(view: ViewState): { id: number; from: AgentId; to: AgentId; walks: boolean } | null {
  const now = view.now;
  if (!now || !now.to || now.from === now.to || view.finished) return null;
  if (now.kind === "phase" || now.kind === "action") return null;
  const walks = now.kind === "handoff" || now.tag === "changes" || now.tag === "review" || now.tag === "bug";
  return { id: now.id, from: now.from, to: now.to, walks };
}

function phaseView(view: ViewState): OfficeScene["phase"] {
  if (view.phaseIndex < 0) return { index: -1, id: null, label: "Not started", text: "Waiting to start" };
  const p = PHASES[view.phaseIndex]!;
  return { index: view.phaseIndex, id: p.id, label: p.label, text: `Phase ${view.phaseIndex + 1} of ${PHASES.length}: ${p.label}` };
}

/** One sentence about the newest thing that happened, in plain words. */
export function describeNow(view: ViewState): string {
  const now = view.now;
  if (view.finished) return "The project is live. Everyone is done.";
  if (!now) return "The office is quiet. Nobody has started yet.";
  const who = now.from === "human" ? "You" : agentName(now.from);
  const to = now.to ? (now.to === "human" ? "you" : agentName(now.to)) : "";
  if (now.kind === "phase") return `The team moved to the ${now.text} phase.`;
  if (now.from === "human") {
    if (now.tag === "gate") return "You approved the BRD.";
    return to ? `You sent a message to ${to}.` : "You sent a message.";
  }
  if (now.kind === "handoff") return `${who} is handing work to ${to || "the next agent"}.`;
  if (now.tag === "gate") return `${who} is waiting for you to approve the BRD.`;
  if (now.tag === "reply") return to === "you" ? `${who} replied to you.` : `${who} replied.`;
  if (now.tag === "review" || now.tag === "changes") {
    const verb = DOING[now.tag]!;
    return `${who} ${verb}${to && to !== "GitHub" ? ` for ${to}` : ""}.`;
  }
  if (now.tag === "sync") return `${who} ${DOING.sync}: ${clip(now.text, 100)}`;
  const verb = DOING[now.tag] ?? "is working";
  return `${who} ${verb}.`;
}

function summaryOf(view: ViewState, needs: boolean): string {
  const parts = [describeNow(view)];
  const ph = phaseView(view);
  if (ph.id && !view.finished) parts.push(`${ph.text}.`);
  if (needs) parts.push(view.gate === "waiting" ? "The BRD is waiting for your approval." : "An agent is waiting for your answer.");
  return parts.join(" ");
}

export function deriveOfficeScene(view: ViewState, options: OfficeOptions = {}): OfficeScene {
  const { walking = true, freshAfter = 0, settledHandoff = -1, expiredBubbles = NONE } = options;
  const needs = needsUser(view);
  const asker = needs ? askerOf(view) : null;
  const meeting = meetingOf(view);
  const inMeeting = new Set<AgentId>(meeting?.participants ?? []);

  const trip = currentTrip(view);
  // Nobody walks to a desk whose owner is already at the meeting table: they talk there.
  const walk =
    walking && trip && trip.walks && trip.id > freshAfter && trip.id !== settledHandoff && isDeskAgent(trip.from) && isDeskAgent(trip.to) && !inMeeting.has(trip.to)
      ? trip
      : null;

  const agents: AgentScene[] = AGENT_ORDER.map((id) => {
    const visual = visualOf(view, id, asker === id, needs);
    const home = id === "github" ? DESK.github : seatOf(id);
    let pose: Pose = "seated";
    let target: Spot = home;
    let face = id === "github" ? 0 : facing(home, DESK[id]);
    let visiting: AgentId | undefined;
    if (id !== "human" && id !== "github") {
      if (walk && walk.from === id) {
        pose = "visiting";
        target = visitSpotOf(walk.to);
        face = facing(target, DESK[walk.to]);
        visiting = walk.to;
      } else if (inMeeting.has(id)) {
        pose = "meeting";
        target = meetingSeatOf(id);
        face = facing(target, { x: 0, z: 0 });
      }
    }
    const scene: AgentScene = { id, name: id === "human" ? "You" : agentName(id), visual, statusText: STATUS_TEXT[visual], pose, target, face };
    if (visiting) scene.visiting = visiting;
    return scene;
  });

  // Bubbles: the old ones leave, and the "needs you" bubble stays until the user answers.
  const bubbles = pickBubbles(view).filter((b) => !expiredBubbles.has(b.id));
  let shown = bubbles;
  if (needs && asker) {
    const lastSay = view.says[view.says.length - 1];
    const text = view.gate === "waiting" ? "The BRD is ready. Please read it and approve." : lastSay ? clip(lastSay.text.replace(/\s+/g, " ").trim(), BUBBLE_CHARS) : "I need your answer.";
    shown = [{ id: -1, agent: asker, text, tone: "attention" as const }, ...bubbles.filter((b) => b.agent !== asker)].slice(0, BUBBLE_LIMIT);
  }

  const packet: Packet | null = walking && trip && trip.id > freshAfter && trip.id !== settledHandoff ? { id: trip.id, from: trip.from, to: trip.to } : null;

  return {
    agents,
    rackActive: view.agents.github === "active",
    needsYou: needs,
    meeting,
    bubbles: shown,
    packet,
    phase: phaseView(view),
    summary: summaryOf(view, needs),
  };
}

/** A list for screen readers: who is doing what right now. */
export function describeAgents(scene: OfficeScene, view: ViewState): string[] {
  return scene.agents.map((a) => {
    const doing = a.id !== "human" ? view.doing[a.id] : undefined;
    const where = a.pose === "meeting" ? ", at the meeting table" : a.pose === "visiting" && a.visiting ? `, walking to ${agentName(a.visiting)}` : "";
    return `${a.name}: ${a.statusText}${where}${doing && a.visual === "working" ? `. ${doing}` : ""}`;
  });
}

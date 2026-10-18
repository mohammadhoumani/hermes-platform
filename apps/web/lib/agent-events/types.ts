/**
 * Types for the event stream (what the Hermes agent-room plugin sends) and for the single
 * ViewState that the 2D map, the activity feed, the progress rail and the future 3D office all read.
 *
 * Source of truth for the raw events: hermes/plugin/agent-room/__init__.py (hook callbacks).
 * Types marked "planned" are added by plugin v2 / bridge v2 in M2 and M3; the reducer already understands them.
 */

// ---------------------------------------------------------------------------
// Raw events
// ---------------------------------------------------------------------------

interface EventBase {
  /** Schema version of the plugin. */
  v?: number;
  /** Unix time in seconds (with milliseconds as decimals). */
  ts?: number;
  /** True for events written by hermes/tools/simulate_run.py. */
  sim?: boolean;
}

/** One thing the agent did with git, gh or a file. Produced by classify_terminal / classify_file in the plugin. */
export type ToolAction =
  | { action: "commit"; message?: string }
  | { action: "push"; branch?: string }
  | { action: "worktree"; branch?: string }
  | { action: "branch"; branch?: string }
  | { action: "pr_open"; title?: string; branch?: string; pr?: string | number | null }
  | { action: "pr_merge"; pr?: string | number | null }
  | { action: "review"; pr?: string | number | null; verdict?: "approved" | "changes" | "reviewed"; body?: string }
  | { action: "ci"; pr?: string | number | null; outcome?: "passed" | "failed" | "running" }
  | { action: "issue"; title?: string }
  | { action: "repo"; repo?: string; template?: string }
  | { action: "protect" }
  | { action: "pages"; url?: string }
  | { action: "approval"; path?: string; gates?: string[] }
  | { action: "brd"; path?: string }
  | { action: "plan"; path?: string }
  | { action: "docs"; path?: string }
  | { action: "file"; path?: string; tool?: string }
  // planned (plugin v2, M2)
  | { action: "sync"; kind?: "blocker" | "question" | "note"; text?: string; issue?: string | number | null }
  | { action: "qa_result"; outcome?: "passed" | "failed"; round?: number; bugs?: number; summary?: string }
  | { action: "deploy"; env?: "staging" | "production"; url?: string };

export type ActionName = ToolAction["action"];

export interface SessionStartEvent extends EventBase {
  type: "session_start";
  sid?: string;
  platform?: string;
  model?: string;
}
export interface TurnStartEvent extends EventBase {
  type: "turn_start";
  sid?: string;
  platform?: string;
  sender?: string;
  first?: boolean;
  text?: string;
  skills?: string[];
}
export interface TurnEndEvent extends EventBase {
  type: "turn_end";
  sid?: string;
  platform?: string;
  text?: string;
  /** Legacy G1..G3 markers. In v2 only G1 (the BRD) can matter. */
  gates?: string[];
}
export interface ToolStartEvent extends EventBase {
  type: "tool_start";
  sid?: string;
  call?: string;
  tool: string;
  summary?: string;
}
export interface ToolEndEvent extends EventBase {
  type: "tool_end";
  sid?: string;
  call?: string;
  tool: string;
  status?: string;
  ms?: number;
  summary?: string;
  actions?: ToolAction[];
  error?: string;
}
export interface SkillEvent extends EventBase {
  type: "skill";
  sid?: string;
  name?: string;
  action?: string;
}
export interface SubStartEvent extends EventBase {
  type: "sub_start";
  parent?: string;
  child?: string;
  sub?: string;
  parent_sub?: string;
  role?: string;
  goal?: string;
}
export interface SubStopEvent extends EventBase {
  type: "sub_stop";
  parent?: string;
  child?: string;
  role?: string;
  status?: string;
  summary?: string;
  ms?: number;
  tools?: number;
  files?: string[];
}
export interface HumanAskEvent extends EventBase {
  type: "human_ask";
  sid?: string;
  key?: string;
  kind?: string;
  req?: string;
  platform?: string;
  text?: string;
}
export interface HumanAnswerEvent extends EventBase {
  type: "human_answer";
  sid?: string;
  key?: string;
  kind?: string;
  req?: string;
  outcome?: string;
}
export interface ApprovalAskEvent extends EventBase {
  type: "approval_ask";
  key?: string;
  command?: string;
  description?: string;
  surface?: string;
}
export interface ApprovalAnswerEvent extends EventBase {
  type: "approval_answer";
  key?: string;
  command?: string;
  choice?: string;
}
export interface TurnStoppedEvent extends EventBase {
  type: "turn_stopped";
  sid?: string;
  interrupted?: boolean;
  failed?: boolean;
}
export interface PluginLoadedEvent extends EventBase {
  type: "plugin_loaded";
  path?: string;
  cloud?: boolean;
}
/** Planned (M3): the bridge poller reports Devin sessions as devin_started, devin_progress, devin_pr, devin_done, devin_failed. */
export interface DevinEvent extends EventBase {
  type: "devin_started" | "devin_progress" | "devin_pr" | "devin_done" | "devin_failed";
  sid?: string;
  text?: string;
  summary?: string;
  task?: string;
  branch?: string;
  pr?: string | number | null;
  url?: string;
}

export type AgentEvent =
  | SessionStartEvent
  | TurnStartEvent
  | TurnEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | SkillEvent
  | SubStartEvent
  | SubStopEvent
  | HumanAskEvent
  | HumanAnswerEvent
  | ApprovalAskEvent
  | ApprovalAnswerEvent
  | TurnStoppedEvent
  | PluginLoadedEvent
  | DevinEvent;

export type AgentEventType = AgentEvent["type"];

// ---------------------------------------------------------------------------
// Roster, phases, lanes
// ---------------------------------------------------------------------------

export type AgentId =
  | "human"
  | "orchestrator"
  | "ba"
  | "architect"
  | "coder1"
  | "coder2"
  | "devin"
  | "reviewer"
  | "qa"
  | "release"
  | "github";

export type LaneId = "coder1" | "coder2" | "devin";

export type PhaseId = "discovery" | "architecture" | "development" | "review" | "qa" | "release";

export type AgentStatus = "idle" | "active" | "waiting" | "done";

// ---------------------------------------------------------------------------
// ViewState
// ---------------------------------------------------------------------------

/** What kind of line a feed item is. The tag gives a more precise label (commit, pr, ci ...). */
export type FeedKind = "message" | "handoff" | "action" | "gate" | "phase";

export type FeedTag =
  | "handoff" | "commit" | "push" | "branch" | "pr" | "ci" | "ci-fail" | "review" | "changes" | "merge"
  | "deploy" | "live" | "issue" | "repo" | "guard" | "question" | "answer" | "reply" | "tool" | "error"
  | "file" | "docs" | "done" | "gate" | "approval" | "command" | "sync" | "qa" | "bug" | "devin" | "message";

export interface FeedItem {
  id: number;
  kind: FeedKind;
  from: AgentId;
  to?: AgentId;
  tag: FeedTag;
  text: string;
  /** Unix seconds when known. */
  ts?: number;
  /** Technical step (a tool call). The UI hides these unless the user asks to see them. */
  quiet?: boolean;
  lane?: LaneId;
}

export const LANE_STEPS = ["assigned", "code", "commit", "pr", "ci", "review", "merged"] as const;
export type LaneStep = (typeof LANE_STEPS)[number];

export interface LaneView {
  /** Index into LANE_STEPS, -1 when not started. */
  step: number;
  task: string;
  branch: string;
  pr: string;
  ci: "" | "passed" | "failed" | "running";
  review: "" | "approved" | "changes" | "reviewed";
  /** "" while working, else the status of the finished sub-agent (completed, failed ...). */
  done: string;
}

export type GateState = "none" | "waiting" | "approved";

export interface LinkView {
  a: AgentId;
  b: AgentId;
  count: number;
  lastSeq: number;
}

export interface AgentSay {
  id: number;
  agent: AgentId;
  /** "reply" = the agent finished a turn, "question" = it asked the human something. */
  kind: "reply" | "question";
  text: string;
  ts?: number;
}

export interface ViewStats {
  messages: number;
  handoffs: number;
  commits: number;
  prs: number;
  ci: number;
  merges: number;
  reviewRounds: number;
  qaRounds: number;
}

export interface Internal {
  seq: number;
  childAgent: Record<string, AgentId>;
  laneOwner: Partial<Record<LaneId, string | null>>;
  laneUsed: Partial<Record<LaneId, number>>;
  laneSeq: number;
  prLane: Record<string, LaneId>;
  /** A BRD file was written in this run (needed before an approval question counts as the gate). */
  brdWritten: boolean;
}

export interface ViewState {
  /** Index into PHASES, -1 before the run starts. */
  phaseIndex: number;
  phase: PhaseId | null;
  finished: boolean;
  /** True after a change request started a new development round on a released project. */
  changeRequest: boolean;
  /** The one human gate: BRD approval. */
  gate: GateState;
  agents: Record<AgentId, AgentStatus>;
  /** Short text of what each agent is doing right now. */
  doing: Partial<Record<AgentId, string>>;
  links: LinkView[];
  lanes: Record<LaneId, LaneView>;
  feed: FeedItem[];
  says: AgentSay[];
  stats: ViewStats;
  urls: { repo?: string; staging?: string; production?: string };
  /** The newest message, for the "now" banner. */
  now?: FeedItem;
  /** Timestamp (unix seconds) of the latest event seen. */
  lastTs?: number;
  eventCount: number;
  internal: Internal;
}

import type { AgentId, LaneId, PhaseId } from "./types";

export interface AgentInfo {
  id: AgentId;
  name: string;
  /** Two or three letters for small badges. */
  short: string;
  /** One plain sentence: what this agent does. */
  job: string;
  kind: "person" | "agent" | "service";
  /** Home position on the 2D map (viewBox 0 0 640 440). */
  home: { x: number; y: number };
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  human: { id: "human", name: "You", short: "YOU", job: "Gives the idea and approves the BRD.", kind: "person", home: { x: 320, y: 44 } },
  orchestrator: { id: "orchestrator", name: "Orchestrator", short: "OR", job: "Runs the project and hands work to the others.", kind: "agent", home: { x: 320, y: 200 } },
  ba: { id: "ba", name: "Business Analyst", short: "BA", job: "Asks questions and writes the BRD.", kind: "agent", home: { x: 100, y: 120 } },
  architect: { id: "architect", name: "Architect", short: "AR", job: "Designs the system and splits the work into tasks.", kind: "agent", home: { x: 100, y: 290 } },
  coder1: { id: "coder1", name: "Coder 1", short: "C1", job: "Builds one task at a time (Claude).", kind: "agent", home: { x: 190, y: 380 } },
  coder2: { id: "coder2", name: "Coder 2", short: "C2", job: "Builds one task at a time (Claude).", kind: "agent", home: { x: 320, y: 400 } },
  devin: { id: "devin", name: "Devin", short: "DV", job: "Builds one task at a time (Devin).", kind: "agent", home: { x: 450, y: 380 } },
  reviewer: { id: "reviewer", name: "Reviewer", short: "RV", job: "Checks every pull request.", kind: "agent", home: { x: 540, y: 120 } },
  qa: { id: "qa", name: "QA", short: "QA", job: "Tests the staging site and files bugs.", kind: "agent", home: { x: 540, y: 290 } },
  release: { id: "release", name: "Release", short: "RL", job: "Publishes the site and writes the guide.", kind: "agent", home: { x: 600, y: 200 } },
  github: { id: "github", name: "GitHub", short: "GH", job: "Stores the code, pull requests and checks.", kind: "service", home: { x: 600, y: 410 } },
};

export const AGENT_ORDER: AgentId[] = [
  "human", "orchestrator", "ba", "architect", "coder1", "coder2", "devin", "reviewer", "qa", "release", "github",
];

export const LANES: LaneId[] = ["coder1", "coder2", "devin"];
/** Claude coders are the lanes that can be reused for any development task. Devin only gets Devin tasks. */
export const CLAUDE_LANES: LaneId[] = ["coder1", "coder2"];

export interface PhaseInfo {
  id: PhaseId;
  label: string;
  /** Who speaks for the main session in this phase. */
  voice: AgentId;
  /** Plain sentence for the progress rail. */
  blurb: string;
}

export const PHASES: PhaseInfo[] = [
  { id: "discovery", label: "Discovery", voice: "ba", blurb: "Questions and the BRD" },
  { id: "architecture", label: "Architecture", voice: "architect", blurb: "Design and plan" },
  { id: "development", label: "Development", voice: "orchestrator", blurb: "Building the tasks" },
  { id: "review", label: "Review", voice: "reviewer", blurb: "Checking the code" },
  { id: "qa", label: "QA", voice: "qa", blurb: "Testing the staging site" },
  { id: "release", label: "Release", voice: "release", blurb: "Going live" },
];

export function phaseIndexOf(id: PhaseId | null | undefined): number {
  return id ? PHASES.findIndex((p) => p.id === id) : -1;
}

/** Which phase each Hermes skill belongs to. */
export const SKILL_PHASE: Record<string, PhaseId | "kickoff"> = {
  "sdlc-orchestrator": "kickoff",
  "sdlc-ba": "discovery",
  "sdlc-architect": "architecture",
  "sdlc-development": "development",
  "sdlc-review": "review",
  "sdlc-qa": "qa",
  "sdlc-release": "release",
  "sdlc-change-request": "development",
  // names of the first version of the pipeline (still understood, same as the plugin's SKILL_STAGE)
  "sdlc-project": "kickoff",
  "sdlc-requirements": "discovery",
  "sdlc-planning": "architecture",
};

export const SKILL_NAMES = Object.keys(SKILL_PHASE);

import { PHASES } from "@/lib/agent-events/roster";
import type { Project } from "@/lib/backend/types";

export type RailState = "done" | "active" | "needs-you" | "todo";

export interface RailStep {
  id: string;
  label: string;
  short: string;
  blurb: string;
  state: RailState;
}

const SHORT: Record<string, string> = {
  discovery: "Discover",
  architecture: "Design",
  development: "Build",
  review: "Review",
  qa: "QA",
  release: "Release",
};

/** The progress rail is driven by projects.phase (and status for the two ends). */
export function buildRail(project: Pick<Project, "phase" | "status">): RailStep[] {
  const current = project.phase ? PHASES.findIndex((p) => p.id === project.phase) : -1;
  const released = project.status === "released";
  return PHASES.map((p, i) => {
    let state: RailState = "todo";
    if (released || i < current) state = "done";
    else if (i === current) state = project.status === "awaiting_brd_approval" ? "needs-you" : "active";
    return { id: p.id, label: p.label, short: SHORT[p.id] ?? p.label, blurb: p.blurb, state };
  });
}

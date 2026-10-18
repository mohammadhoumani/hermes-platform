import type { ProjectPhase, ProjectStatus } from "@/lib/backend/types";

export type StatusTone = "neutral" | "working" | "attention" | "success" | "danger";

export interface StatusInfo {
  label: string;
  tone: StatusTone;
  /** A plain sentence for people: what is going on. */
  sentence: string;
  /** True while agents are busy (the chip dot pulses). */
  pulse?: boolean;
}

/** Status to colour mapping. Colours come from design tokens (see styles/tokens.css). */
export const STATUS_INFO: Record<ProjectStatus, StatusInfo> = {
  queued: { label: "Waiting in line", tone: "neutral", sentence: "Hermes works on one project at a time. This one is next." },
  discovery: { label: "Asking questions", tone: "working", sentence: "The analyst is asking questions and writing the requirements.", pulse: true },
  awaiting_brd_approval: { label: "Needs your OK", tone: "attention", sentence: "The requirements document is ready. Please read it and approve it." },
  architecture: { label: "Designing", tone: "working", sentence: "The architect is designing the system and planning the tasks.", pulse: true },
  development: { label: "Building", tone: "working", sentence: "The coders are building the tasks.", pulse: true },
  review: { label: "Reviewing", tone: "working", sentence: "The reviewer is checking the code.", pulse: true },
  qa: { label: "Testing", tone: "working", sentence: "QA is testing the staging site.", pulse: true },
  releasing: { label: "Going live", tone: "working", sentence: "The site is being published.", pulse: true },
  released: { label: "Live", tone: "success", sentence: "The site is live." },
  paused: { label: "Paused", tone: "neutral", sentence: "Paused because of a usage limit. It will continue by itself." },
  failed: { label: "Stuck", tone: "danger", sentence: "Something went wrong and the agents could not continue." },
  stopped: { label: "Stopped", tone: "neutral", sentence: "You stopped this project. You can resume it." },
};

export function statusInfo(status: ProjectStatus): StatusInfo {
  return STATUS_INFO[status] ?? { label: status, tone: "neutral", sentence: "" };
}

export const PHASE_LABEL: Record<ProjectPhase, string> = {
  discovery: "Discovery",
  architecture: "Architecture",
  development: "Development",
  review: "Review",
  qa: "QA",
  release: "Release",
};

export const ORDER_STATUS_TEXT: Record<string, string> = {
  queued: "Waiting to be sent",
  taken: "Sent to the agents",
  running: "The agents are on it",
  waiting: "The agents are waiting for you",
  done: "Done",
  failed: "Could not be delivered",
};

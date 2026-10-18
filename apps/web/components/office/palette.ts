/**
 * Colours of the 3D office. Only brand colours and their tonal scale from styles/tokens.css:
 * Steel Gray #24213B, Caribbean Green #00CDAB, Texas Rose #FFB64D, Wafer #E4D7CC, Snow #FFFFFF.
 */
import type { PhaseId } from "@/lib/agent-events/types";
import type { Visual } from "./scene-state";

export const GREEN = "#00CDAB"; // working
export const ROSE = "#FFB64D"; // needs the user
export const STEEL = "#24213B";
export const WAFER = "#E4D7CC"; // floor and furniture
export const SNOW = "#FFFFFF";

export const COLORS = {
  floor: WAFER,
  wall: "#F4EEEA", // wafer-200
  wallDark: "#C4B9AF", // wafer-600
  deskTop: "#F9F6F4", // wafer-100
  deskLeg: "#8D857E", // wafer-700
  rug: "#E9DED5", // wafer-400
  chair: "#3E3C53", // steel-700
  bezel: STEEL,
  screenIdle: "#504D62", // steel-600
  screenDone: "#006252", // green-800
  rack: STEEL,
  rackPanel: "#312E47", // steel-800
  skin: "#EEE6DF", // wafer-300
  glass: "#CACAD0",
} as const;

/** Page backgrounds behind the canvas: the same as the panel the canvas sits in (--surface). */
export const BACKGROUND = { light: SNOW, dark: "#312E47" } as const;

/** Shirt colour of each figure: tonal steps of the brand colours so the figures differ without new hues. */
export const SHIRT: Record<string, string> = {
  human: "#996D2E", // rose-700
  orchestrator: STEEL,
  ba: "#007763", // green-700
  architect: "#504D62", // steel-600
  coder1: "#00AC90", // green-600
  coder2: "#006252", // green-800
  devin: "#705022", // rose-800
  reviewer: "#6A687A", // steel-500
  qa: "#D69941", // rose-600
  release: "#003E33", // green-900
};

export const VISUAL_COLOR: Record<Visual, string> = { working: GREEN, "needs-you": ROSE, done: "#006252", idle: "#504D62" };

/** A subtle tint for the room lights in each phase, plus how bright the room is. */
export const PHASE_LIGHT: Record<PhaseId | "none", { color: string; ambient: number }> = {
  none: { color: "#FFFFFF", ambient: 0.74 },
  discovery: { color: "#FFF9F0", ambient: 0.78 },
  architecture: { color: "#FBFAFF", ambient: 0.74 },
  development: { color: "#FFFFFF", ambient: 0.76 },
  review: { color: "#FFFAF2", ambient: 0.74 },
  qa: { color: "#FAFCFF", ambient: 0.74 },
  release: { color: "#F6FDFB", ambient: 0.8 },
};

/** The six lights over the wall sign. */
export const PHASE_PIP = { done: "#006252", current: GREEN, todo: "#8D857E" } as const;

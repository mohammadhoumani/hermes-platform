/**
 * Where everything stands in the 3D office. Pure numbers, no three.js, so the scene mapping can be unit tested.
 *
 * Coordinates: x goes right, z comes towards the camera, y is up. The floor is centred on 0,0.
 * The back row of desks is at z = -4, the front row at z = 4, the meeting table is in the middle.
 */
import type { AgentId } from "@/lib/agent-events/types";

export interface Spot {
  x: number;
  z: number;
}

export const FLOOR = { width: 20, depth: 14 } as const;

/** The desk (or spot) of everyone. "human" is the You spot, "github" is the server rack. */
export const DESK: Record<AgentId, Spot> = {
  ba: { x: -6.5, z: -4 },
  architect: { x: -3.25, z: -4 },
  orchestrator: { x: 0, z: -4 },
  reviewer: { x: 3.25, z: -4 },
  qa: { x: 6.5, z: -4 },
  coder1: { x: -6.5, z: 4 },
  coder2: { x: -3.25, z: 4 },
  devin: { x: 0, z: 4 },
  human: { x: 3.25, z: 4 },
  release: { x: 6.5, z: 4 },
  github: { x: 8.8, z: 0 },
};

export const MEETING_TABLE: Spot = { x: 0, z: 0 };
export const MEETING_RADIUS = 1.45;
const SEAT_RADIUS = 2.25;

/** People who sit at a desk (everyone except the server rack). */
export const SEATED: AgentId[] = ["ba", "architect", "orchestrator", "reviewer", "qa", "coder1", "coder2", "devin", "human", "release"];

/** Back row desks face the camera side (the worker sits behind the desk, further from the camera). */
export function isBackRow(id: AgentId): boolean {
  return DESK[id].z < 0;
}

/** Where a person stands or sits when working at their own desk. */
export function seatOf(id: AgentId): Spot {
  const d = DESK[id];
  if (id === "github") return { x: d.x - 1.6, z: d.z };
  return { x: d.x, z: d.z + (isBackRow(id) ? -1.15 : 1.15) };
}

/** The angle (rotation around y) that makes something at `from` look at `to`. */
export function facing(from: Spot, to: Spot): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** Where a visitor stands when they walk over to hand something to `id`. */
export function visitSpotOf(id: AgentId): Spot {
  const d = DESK[id];
  if (id === "github") return { x: d.x - 1.9, z: d.z };
  // Stand beside the desk, on the side that has more room.
  return { x: d.x + (d.x > 5 ? -1.7 : 1.7), z: d.z };
}

/** A fixed place at the meeting table for each agent, so nobody sits on someone else's lap. */
const MEETING_SLOT: Partial<Record<AgentId, number>> = {
  reviewer: 0,
  qa: 1,
  orchestrator: 2,
  coder1: 3,
  coder2: 4,
  devin: 5,
  architect: 6,
  ba: 7,
  release: 7,
};
export const MEETING_SLOTS = 8;

export function meetingSeatOf(id: AgentId): Spot {
  const slot = MEETING_SLOT[id] ?? 0;
  const angle = Math.PI * 0.25 + (slot / MEETING_SLOTS) * Math.PI * 2;
  return { x: MEETING_TABLE.x + Math.cos(angle) * SEAT_RADIUS, z: MEETING_TABLE.z + Math.sin(angle) * SEAT_RADIUS };
}

/** Positions of the eight stools around the meeting table. */
export function meetingStools(): Spot[] {
  return Array.from({ length: MEETING_SLOTS }, (_, slot) => {
    const angle = Math.PI * 0.25 + (slot / MEETING_SLOTS) * Math.PI * 2;
    return { x: MEETING_TABLE.x + Math.cos(angle) * SEAT_RADIUS, z: MEETING_TABLE.z + Math.sin(angle) * SEAT_RADIUS };
  });
}

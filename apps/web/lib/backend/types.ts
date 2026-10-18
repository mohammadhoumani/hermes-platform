/**
 * The data the web app works with, and the one interface (Backend) it talks to.
 * Two implementations exist: Supabase (real) and fixtures (tests and local demos).
 */
import type { AgentEvent } from "@/lib/agent-events/types";

export type Role = "owner" | "member";

export const PROJECT_STATUSES = [
  "queued", "discovery", "awaiting_brd_approval", "architecture", "development",
  "review", "qa", "releasing", "released", "paused", "failed", "stopped",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PHASE_IDS = ["discovery", "architecture", "development", "review", "qa", "release"] as const;
export type ProjectPhase = (typeof PHASE_IDS)[number];

export const ORDER_KINDS = [
  "start_project", "message", "approve_brd", "request_brd_changes", "change_request", "stop", "resume",
] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export const ORDER_STATUSES = ["queued", "taken", "running", "waiting", "done", "failed"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const MAX_ORDER_TEXT = 4000;

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  phase: ProjectPhase | null;
  repoUrl: string | null;
  stagingUrl: string | null;
  productionUrl: string | null;
  brdMarkdown: string | null;
  brdApprovedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: number;
  projectId: string;
  userId: string;
  kind: OrderKind;
  text: string;
  status: OrderStatus;
  note: string | null;
  runId: string | null;
  createdAt: string;
}

/** One row of the events table. `payload` is the raw plugin event. */
export interface PlatformEvent {
  id: number;
  projectId: string | null;
  sessionId: string;
  type: string;
  payload: AgentEvent;
  createdAt: string;
}

export interface Invite {
  email: string;
  role: Role;
  createdAt: string;
  acceptedAt: string | null;
}

export interface RoomSnapshot {
  project: Project;
  orders: Order[];
  events: PlatformEvent[];
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface RoomHandlers {
  onEvent(e: PlatformEvent): void;
  onOrder(o: Order): void;
  onProject(p: Project): void;
  onConnection(state: ConnectionState): void;
}

/** An error whose message is already plain English and safe to show. */
export class BackendError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "BackendError";
  }
}

export interface Backend {
  getCurrentUser(): Promise<CurrentUser | null>;
  listProjects(): Promise<Project[]>;
  getRoom(projectId: string): Promise<RoomSnapshot | null>;
  getEventsAfter(projectId: string, afterId: number): Promise<PlatformEvent[]>;
  createProject(name: string, idea: string): Promise<string>;
  sendOrder(projectId: string, kind: OrderKind, text: string): Promise<Order>;
  listInvites(): Promise<Invite[]>;
  createInvite(email: string, role: Role): Promise<void>;
  revokeInvite(email: string): Promise<void>;
  /** Subscribes to live changes of one project. Returns an unsubscribe function. */
  subscribeRoom(projectId: string, handlers: RoomHandlers): () => void;
}

/**
 * In-memory Backend for test mode. It follows the same rules as the database (allowed kinds, text limits,
 * ownership, rate limit) and plays out a small scripted reaction when you send an order,
 * so Playwright can check the whole room without a real backend. Never imported in production builds.
 */
import type { AgentEvent } from "@/lib/agent-events/types";
import { buildFixtureInvites, buildFixtureMembers, buildFixtureProjects, FIXTURE_USERS, type FixtureProject } from "./fixture-data";
import {
  BackendError,
  MAX_ORDER_TEXT,
  ORDER_KINDS,
  type Backend,
  type CurrentUser,
  type Order,
  type OrderKind,
  type PlatformEvent,
  type Project,
  type Role,
  type RoomHandlers,
} from "./types";

type Listener = RoomHandlers;

export interface FixtureOptions {
  /** Delay for the scripted steps. Default 250 ms. Use 0 in unit tests together with flush(). */
  stepMs?: number;
  /** Pretend a team owner removed this person's access (the notice page shows instead of the app). */
  removed?: boolean;
}

export function createFixtureBackend(role: Role, opts: FixtureOptions = {}): Backend & { flush(): Promise<void> } {
  const user: CurrentUser = { ...FIXTURE_USERS[role], ...(opts.removed ? { disabled: true } : {}) };
  const step = opts.stepMs ?? 250;
  const projects = new Map<string, FixtureProject>(buildFixtureProjects(user.id).map((p) => [p.project.id, p]));
  const invites = buildFixtureInvites();
  const members = buildFixtureMembers();
  const listeners = new Map<string, Set<Listener>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let pending = 0;
  let orderSeq = 100;
  let eventSeq = 10000;

  const emit = <K extends keyof RoomHandlers>(projectId: string, fn: K, arg: Parameters<RoomHandlers[K]>[0]) => {
    for (const l of listeners.get(projectId) ?? []) (l[fn] as (a: typeof arg) => void)(arg);
  };

  const later = (ms: number, fn: () => void) => {
    pending++;
    const t = setTimeout(() => {
      timers.delete(t);
      try {
        fn();
      } finally {
        pending--;
      }
    }, ms);
    timers.add(t);
  };

  const nowIso = () => new Date().toISOString();

  const addEvent = (fp: FixtureProject, payload: AgentEvent) => {
    const ts = Date.now() / 1000;
    const e: PlatformEvent = {
      id: ++eventSeq, projectId: fp.project.id, sessionId: "main-1", type: payload.type,
      payload: { ...payload, ts } as AgentEvent, createdAt: nowIso(),
    };
    fp.events.push(e);
    emit(fp.project.id, "onEvent", e);
  };

  const patchProject = (fp: FixtureProject, patch: Partial<Project>) => {
    fp.project = { ...fp.project, ...patch, updatedAt: nowIso() };
    emit(fp.project.id, "onProject", fp.project);
  };

  const setOrder = (fp: FixtureProject, o: Order, status: Order["status"]) => {
    const i = fp.orders.findIndex((x) => x.id === o.id);
    const next = { ...o, status };
    if (i >= 0) fp.orders[i] = next;
    emit(fp.project.id, "onOrder", next);
    return next;
  };

  /** What the agents do in reply to each kind of order. */
  const react = (fp: FixtureProject, order: Order) => {
    const kind = order.kind;
    if (kind === "message" || kind === "change_request" || kind === "request_brd_changes") {
      addEvent(fp, { type: "turn_start", sid: "main-1", platform: "api_server", text: order.text });
    }
    if (kind === "approve_brd") {
      addEvent(fp, { type: "turn_start", sid: "main-1", platform: "api_server", text: "The user approved the BRD. Continue on your own until the site is live." });
      later(step, () => {
        addEvent(fp, { type: "skill", sid: "main-1", name: "sdlc-architect", action: "loaded" });
        patchProject(fp, { status: "architecture", phase: "architecture", brdApprovedAt: nowIso() });
      });
    } else if (kind === "request_brd_changes") {
      later(step, () => {
        patchProject(fp, { brdMarkdown: `${fp.project.brdMarkdown ?? ""}\n\n## Update\n\n- ${order.text}\n` });
        addEvent(fp, { type: "turn_end", sid: "main-1", platform: "api_server", text: "I updated the BRD. Please read it again and approve it when it looks right." });
      });
    } else if (kind === "message") {
      later(step, () => addEvent(fp, { type: "turn_end", sid: "main-1", platform: "api_server", text: "Thanks, I noted that." }));
    } else if (kind === "change_request") {
      later(step, () => {
        addEvent(fp, { type: "skill", sid: "main-1", name: "sdlc-change-request", action: "loaded" });
        patchProject(fp, { status: "development", phase: "development" });
      });
    } else if (kind === "stop") {
      patchProject(fp, { status: "stopped" });
    } else if (kind === "resume") {
      patchProject(fp, { status: "development", phase: fp.project.phase ?? "development" });
    }
  };

  const mustOwn = (id: string): FixtureProject => {
    const fp = projects.get(id);
    if (!fp) throw new BackendError("You are not allowed to do that.");
    return fp;
  };

  return {
    async getCurrentUser() {
      return user;
    },
    async listProjects() {
      return [...projects.values()].map((p) => p.project).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getRoom(id) {
      const fp = projects.get(id);
      return fp ? { project: fp.project, orders: [...fp.orders], events: [...fp.events] } : null;
    },
    async getEventsAfter(id, afterId) {
      return (projects.get(id)?.events ?? []).filter((e) => e.id > afterId);
    },
    async createProject(name, idea) {
      const nm = name.trim();
      const txt = idea.trim();
      if (!nm || nm.length > 120) throw new BackendError("Give your project a name (1 to 120 characters).");
      if (!txt || txt.length > MAX_ORDER_TEXT) throw new BackendError("Describe your idea (1 to 4000 characters).");
      const id = crypto.randomUUID();
      const slug = `${nm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "project"}-${id.slice(0, 6)}`;
      const project: Project = {
        id, ownerId: user.id, name: nm, slug, status: "queued", phase: null, repoUrl: null, stagingUrl: null,
        productionUrl: null, brdMarkdown: null, brdApprovedAt: null, createdAt: nowIso(), updatedAt: nowIso(),
      };
      const order: Order = {
        id: ++orderSeq, projectId: id, userId: user.id, kind: "start_project", text: txt, status: "queued",
        note: null, runId: null, createdAt: nowIso(),
      };
      projects.set(id, { project, events: [], orders: [order] });
      return id;
    },
    async sendOrder(projectId, kind: OrderKind, text) {
      const fp = mustOwn(projectId);
      if (fp.project.ownerId !== user.id) throw new BackendError("You are not allowed to do that.");
      if (!(ORDER_KINDS as readonly string[]).includes(kind)) throw new BackendError("That is not allowed. Please check what you wrote.");
      const needsText = !["approve_brd", "stop", "resume"].includes(kind);
      if (needsText && !text.trim()) throw new BackendError("Please write a message first.");
      if (text.length > MAX_ORDER_TEXT) throw new BackendError("That text is too long. Please make it shorter (4000 characters or fewer).");
      if (kind === "approve_brd" && fp.project.status !== "awaiting_brd_approval") {
        throw new BackendError("There is no BRD waiting for your approval.");
      }
      const recent = [...projects.values()].flatMap((p) => p.orders).filter((o) => o.userId === user.id && Date.now() - Date.parse(o.createdAt) < 600_000);
      if (recent.length >= 40) throw new BackendError("You are sending too fast. Please wait a few minutes and try again.");

      const order: Order = {
        id: ++orderSeq, projectId, userId: user.id, kind, text, status: "queued", note: null, runId: null, createdAt: nowIso(),
      };
      fp.orders.push(order);
      emit(projectId, "onOrder", order);
      later(step, () => setOrder(fp, order, "taken"));
      later(step * 2, () => setOrder(fp, order, "running"));
      later(step * 3, () => {
        react(fp, order);
        setOrder(fp, order, "done");
      });
      return order;
    },
    async listInvites() {
      if (role !== "owner") throw new BackendError("You are not allowed to do that.");
      return [...invites];
    },
    async createInvite(email, r) {
      if (role !== "owner") throw new BackendError("You are not allowed to do that.");
      const e = email.trim().toLowerCase();
      if (invites.some((i) => i.email.toLowerCase() === e)) throw new BackendError("That email has already been invited.");
      invites.unshift({ email: e, role: r, createdAt: nowIso(), acceptedAt: null });
    },
    async revokeInvite(email) {
      const i = invites.findIndex((x) => x.email === email && !x.acceptedAt);
      if (i < 0) throw new BackendError("This invite cannot be removed. The person may have joined already.");
      invites.splice(i, 1);
    },
    async listMembers() {
      if (role !== "owner") throw new BackendError("Only team owners can do that.");
      return members.map((m) => ({ ...m }));
    },
    async removeMember(memberId) {
      if (role !== "owner") throw new BackendError("Only team owners can do that.");
      const m = members.find((x) => x.id === memberId);
      if (!m) throw new BackendError("That person was not found.");
      if (m.id === user.id) throw new BackendError("You cannot remove your own access.");
      if (m.role === "owner") throw new BackendError("Owners cannot be removed here. Ask the person to leave the team, or change their role in the database.");
      if (!m.disabledAt) m.disabledAt = nowIso();
    },
    async restoreMember(memberId) {
      if (role !== "owner") throw new BackendError("Only team owners can do that.");
      const m = members.find((x) => x.id === memberId);
      if (!m) throw new BackendError("That person was not found.");
      m.disabledAt = null;
    },
    subscribeRoom(id, handlers) {
      const set = listeners.get(id) ?? new Set<Listener>();
      listeners.set(id, set);
      set.add(handlers);
      later(0, () => handlers.onConnection("live"));
      return () => set.delete(handlers);
    },
    async flush() {
      for (let i = 0; i < 200 && pending > 0; i++) await new Promise((r) => setTimeout(r, Math.max(step, 1) + 5));
    },
  };
}

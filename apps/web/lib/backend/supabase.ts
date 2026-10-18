/**
 * Backend implementation on top of Supabase (PostgREST + Realtime). Works with the browser client and the server client.
 * Row level security does the real access control; this file only asks for what it needs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describeDataError } from "@/lib/auth/messages";
import type { AgentEvent } from "@/lib/agent-events/types";
import {
  BackendError,
  type Backend,
  type ConnectionState,
  type CurrentUser,
  type Invite,
  type Order,
  type OrderKind,
  type PlatformEvent,
  type Project,
  type ProjectPhase,
  type ProjectStatus,
  type Role,
  type RoomHandlers,
  type RoomSnapshot,
} from "./types";

// ---- row mappers (snake_case rows to our types) ---------------------------------------------

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function mapProject(r: Row): Project {
  return {
    id: str(r.id),
    ownerId: str(r.owner_id),
    name: str(r.name),
    slug: str(r.slug),
    status: str(r.status) as ProjectStatus,
    phase: strOrNull(r.phase) as ProjectPhase | null,
    repoUrl: strOrNull(r.repo_url),
    stagingUrl: strOrNull(r.staging_url),
    productionUrl: strOrNull(r.production_url),
    brdMarkdown: strOrNull(r.brd_markdown),
    brdApprovedAt: strOrNull(r.brd_approved_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function mapOrder(r: Row): Order {
  return {
    id: Number(r.id),
    projectId: str(r.project_id),
    userId: str(r.user_id),
    kind: str(r.kind) as OrderKind,
    text: str(r.text),
    status: str(r.status) as Order["status"],
    note: strOrNull(r.note),
    runId: strOrNull(r.run_id),
    createdAt: str(r.created_at),
  };
}

export function mapEvent(r: Row): PlatformEvent {
  const payload = r.payload && typeof r.payload === "object" ? (r.payload as AgentEvent) : ({ type: str(r.type) } as AgentEvent);
  return {
    id: Number(r.id),
    projectId: strOrNull(r.project_id),
    sessionId: str(r.session_id),
    type: str(r.type),
    payload,
    createdAt: str(r.created_at),
  };
}

export function mapInvite(r: Row): Invite {
  return { email: str(r.email), role: str(r.role) as Role, createdAt: str(r.created_at), acceptedAt: strOrNull(r.accepted_at) };
}

function fail(error: unknown): never {
  throw new BackendError(describeDataError(error), error);
}

const EVENT_PAGE = 2000;

export function createSupabaseBackend(client: SupabaseClient): Backend {
  return {
    async getCurrentUser(): Promise<CurrentUser | null> {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) return null;
      const { data: profile, error: perr } = await client
        .from("profiles")
        .select("display_name, role")
        .eq("id", data.user.id)
        .maybeSingle();
      if (perr) fail(perr);
      const email = data.user.email ?? "";
      return {
        id: data.user.id,
        email,
        displayName: str(profile?.display_name) || email.split("@")[0] || "Me",
        role: profile?.role === "owner" ? "owner" : "member",
      };
    },

    async listProjects() {
      const { data, error } = await client.from("projects").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) fail(error);
      return (data ?? []).map(mapProject);
    },

    async getRoom(projectId): Promise<RoomSnapshot | null> {
      const { data: p, error: pe } = await client.from("projects").select("*").eq("id", projectId).maybeSingle();
      if (pe) fail(pe);
      if (!p) return null;
      const [orders, events] = await Promise.all([
        client.from("orders").select("*").eq("project_id", projectId).order("id", { ascending: true }).limit(500),
        // newest first so that a very long run still shows its latest part; reversed below
        client.from("events").select("*").eq("project_id", projectId).order("id", { ascending: false }).limit(EVENT_PAGE),
      ]);
      if (orders.error) fail(orders.error);
      if (events.error) fail(events.error);
      return {
        project: mapProject(p),
        orders: (orders.data ?? []).map(mapOrder),
        events: (events.data ?? []).map(mapEvent).reverse(),
      };
    },

    async getEventsAfter(projectId, afterId) {
      const { data, error } = await client
        .from("events")
        .select("*")
        .eq("project_id", projectId)
        .gt("id", afterId)
        .order("id", { ascending: true })
        .limit(1000);
      if (error) fail(error);
      return (data ?? []).map(mapEvent);
    },

    async createProject(name, idea) {
      const { data, error } = await client.rpc("create_project", { project_name: name, idea });
      if (error) fail(error);
      if (typeof data !== "string") throw new BackendError("Something went wrong. Please try again.");
      return data;
    },

    async sendOrder(projectId, kind, text) {
      const { data, error } = await client.from("orders").insert({ project_id: projectId, kind, text }).select("*").single();
      if (error) fail(error);
      return mapOrder(data as Row);
    },

    async listInvites() {
      const { data, error } = await client.from("invites").select("*").order("created_at", { ascending: false }).limit(500);
      if (error) fail(error);
      return (data ?? []).map(mapInvite);
    },

    async createInvite(email, role) {
      const { error } = await client.from("invites").insert({ email: email.trim().toLowerCase(), role });
      if (error) {
        if (error.code === "23505") throw new BackendError("That email has already been invited.", error);
        fail(error);
      }
    },

    async revokeInvite(email) {
      const { data, error } = await client.from("invites").delete().eq("email", email).select("email");
      if (error) fail(error);
      if (!data || data.length === 0) throw new BackendError("This invite cannot be removed. The person may have joined already.");
    },

    subscribeRoom(projectId, h: RoomHandlers) {
      let everLive = false;
      const channel = client
        .channel(`room:${projectId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `project_id=eq.${projectId}` }, (p) =>
          h.onEvent(mapEvent(p.new as Row)),
        )
        .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `project_id=eq.${projectId}` }, (p) => {
          if (p.eventType !== "DELETE") h.onOrder(mapOrder(p.new as Row));
        })
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "projects", filter: `id=eq.${projectId}` }, (p) =>
          h.onProject(mapProject(p.new as Row)),
        )
        .subscribe((status) => {
          const state: ConnectionState =
            status === "SUBSCRIBED" ? "live" : status === "CLOSED" ? "offline" : everLive ? "reconnecting" : "connecting";
          if (status === "SUBSCRIBED") everLive = true;
          h.onConnection(state);
        });
      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}

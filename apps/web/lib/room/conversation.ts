/**
 * The conversation panel: what you sent (orders) mixed with what the agents said or asked (from the event stream).
 */
import { AGENTS } from "@/lib/agent-events/roster";
import type { AgentId, AgentSay } from "@/lib/agent-events/types";
import type { Order } from "@/lib/backend/types";

export type ConversationItem =
  | { key: string; at: number; side: "agent"; agent: AgentId; agentName: string; kind: "reply" | "question"; text: string }
  | { key: string; at: number; side: "you"; orderId: number; text: string; label: string | null; status: Order["status"]; note: string | null }
  | { key: string; at: number; side: "system"; text: string; status?: Order["status"] };

function orderItem(o: Order): ConversationItem | null {
  const at = Date.parse(o.createdAt);
  const base = { key: `o${o.id}`, at: Number.isFinite(at) ? at : 0 };
  switch (o.kind) {
    case "start_project":
      return { ...base, side: "you", orderId: o.id, text: o.text, label: "Your idea", status: o.status, note: o.note };
    case "message":
      return { ...base, side: "you", orderId: o.id, text: o.text, label: null, status: o.status, note: o.note };
    case "request_brd_changes":
      return { ...base, side: "you", orderId: o.id, text: o.text, label: "Changes to the BRD", status: o.status, note: o.note };
    case "change_request":
      return { ...base, side: "you", orderId: o.id, text: o.text, label: "Change request", status: o.status, note: o.note };
    case "approve_brd":
      return { ...base, side: "system", text: "You approved the BRD.", status: o.status };
    case "stop":
      return { ...base, side: "system", text: "You stopped the project.", status: o.status };
    case "resume":
      return { ...base, side: "system", text: "You resumed the project.", status: o.status };
    default:
      return null;
  }
}

export function buildConversation(orders: Order[], says: AgentSay[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const o of orders) {
    const it = orderItem(o);
    if (it) items.push(it);
  }
  for (const s of says) {
    items.push({
      key: `s${s.id}`,
      at: s.ts !== undefined ? s.ts * 1000 : 0,
      side: "agent",
      agent: s.agent,
      agentName: AGENTS[s.agent].name,
      kind: s.kind,
      text: s.text,
    });
  }
  // stable: same time keeps the order they were added (orders first, then agent lines)
  return items.map((it, i) => ({ it, i })).sort((a, b) => a.it.at - b.it.at || a.i - b.i).map((x) => x.it);
}

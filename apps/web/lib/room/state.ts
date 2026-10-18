/**
 * State of one project room: the project row, its orders and events, and the ViewState derived from the events.
 * Pure reducer, so it can be tested without React. Events may arrive twice or slightly out of order
 * (Realtime plus a catch-up fetch); this keeps them unique and sorted by id.
 */
import { applyEvent, createInitialState, isAgentEvent, replay } from "@/lib/agent-events/reduce";
import type { AgentEvent, ViewState } from "@/lib/agent-events/types";
import type { ConnectionState, Order, PlatformEvent, Project, RoomSnapshot } from "@/lib/backend/types";

export interface RoomState {
  project: Project;
  orders: Order[];
  events: PlatformEvent[];
  seen: ReadonlySet<number>;
  lastEventId: number;
  view: ViewState;
  connection: ConnectionState;
}

export type RoomAction =
  | { type: "event"; event: PlatformEvent }
  | { type: "events"; events: PlatformEvent[] }
  | { type: "order"; order: Order }
  | { type: "project"; project: Project }
  | { type: "connection"; state: ConnectionState };

function agentEvents(events: PlatformEvent[]): AgentEvent[] {
  return events.map((e) => e.payload).filter(isAgentEvent);
}

export function initRoom(snapshot: RoomSnapshot): RoomState {
  const events = [...snapshot.events].sort((a, b) => a.id - b.id);
  return {
    project: snapshot.project,
    orders: [...snapshot.orders].sort((a, b) => a.id - b.id),
    events,
    seen: new Set(events.map((e) => e.id)),
    lastEventId: events.length ? events[events.length - 1]!.id : 0,
    view: replay(agentEvents(events), createInitialState()),
    connection: "connecting",
  };
}

function addEvents(state: RoomState, incoming: PlatformEvent[]): RoomState {
  const fresh = incoming.filter((e) => !state.seen.has(e.id));
  if (fresh.length === 0) return state;
  fresh.sort((a, b) => a.id - b.id);
  const seen = new Set(state.seen);
  for (const e of fresh) seen.add(e.id);

  const inOrder = fresh[0]!.id > state.lastEventId;
  if (inOrder) {
    let view = state.view;
    for (const e of fresh) if (isAgentEvent(e.payload)) view = applyEvent(view, e.payload);
    return { ...state, events: [...state.events, ...fresh], seen, lastEventId: fresh[fresh.length - 1]!.id, view };
  }
  // something older arrived late: rebuild so the order is right
  const events = [...state.events, ...fresh].sort((a, b) => a.id - b.id);
  return { ...state, events, seen, lastEventId: events[events.length - 1]!.id, view: replay(agentEvents(events), createInitialState()) };
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "event":
      return addEvents(state, [action.event]);
    case "events":
      return addEvents(state, action.events);
    case "order": {
      const i = state.orders.findIndex((o) => o.id === action.order.id);
      if (i >= 0) {
        const orders = [...state.orders];
        orders[i] = action.order;
        return { ...state, orders };
      }
      return { ...state, orders: [...state.orders, action.order].sort((a, b) => a.id - b.id) };
    }
    case "project":
      // ignore an older copy of the row that arrives late
      return Date.parse(action.project.updatedAt) < Date.parse(state.project.updatedAt) ? state : { ...state, project: action.project };
    case "connection":
      return state.connection === action.state ? state : { ...state, connection: action.state };
  }
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { FadeIn } from "@/components/motion";
import { Alert } from "@/components/ui/alert";
import { loadBrowserBackend } from "@/lib/backend/browser";
import { BackendError, type Backend, type OrderKind, type Role, type RoomSnapshot } from "@/lib/backend/types";
import { AgentStage } from "@/components/office/agent-stage";
import { initRoom, roomReducer } from "@/lib/room/state";
import { BrdPanel } from "./brd-panel";
import { Conversation } from "./conversation";
import { ActivityFeed } from "./feed";
import { Lanes } from "./lanes";
import { PhaseRail } from "./phase-rail";
import { ReleaseCard } from "./release-card";
import { RoomHeader } from "./room-header";

const POLL_MS = 8000;

function Panel({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} aria-label={title} className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 className="mb-3 text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
}

export function RoomClient({ snapshot, testRole }: { snapshot: RoomSnapshot; testRole: Role | null }) {
  const projectId = snapshot.project.id;
  const [state, dispatch] = useReducer(roomReducer, snapshot, initRoom);
  const [loadError, setLoadError] = useState<string | null>(null);
  const backendRef = useRef<Backend | null>(null);
  const lastIdRef = useRef(state.lastEventId);
  useEffect(() => {
    lastIdRef.current = state.lastEventId;
  }, [state.lastEventId]);

  // Live updates: subscribe, and catch up on whatever was missed when the connection comes (back) up.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    (async () => {
      try {
        const backend = await loadBrowserBackend(testRole);
        if (cancelled) return;
        backendRef.current = backend;
        unsubscribe = backend.subscribeRoom(projectId, {
          onEvent: (event) => dispatch({ type: "event", event }),
          onOrder: (order) => dispatch({ type: "order", order }),
          onProject: (project) => dispatch({ type: "project", project }),
          onConnection: (s) => {
            dispatch({ type: "connection", state: s });
            if (s === "live") {
              backend
                .getEventsAfter(projectId, lastIdRef.current)
                .then((events) => !cancelled && dispatch({ type: "events", events }))
                .catch(() => undefined);
            }
          },
        });
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof BackendError ? e.message : "We could not start live updates. Reload the page to try again.");
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [projectId, testRole]);

  // Fallback: while the live connection is down, refresh by polling.
  const connection = state.connection;
  useEffect(() => {
    if (connection === "live") return;
    const t = setInterval(async () => {
      const backend = backendRef.current;
      if (!backend) return;
      try {
        const room = await backend.getRoom(projectId);
        if (!room) return;
        dispatch({ type: "project", project: room.project });
        for (const order of room.orders) dispatch({ type: "order", order });
        dispatch({ type: "events", events: room.events });
      } catch {
        /* still offline: try again next time */
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [connection, projectId]);

  const send = useCallback(
    async (kind: OrderKind, text: string) => {
      const backend = backendRef.current ?? (await loadBrowserBackend(testRole));
      backendRef.current = backend;
      const order = await backend.sendOrder(projectId, kind, text);
      dispatch({ type: "order", order });
    },
    [projectId, testRole],
  );

  const { project, view, orders } = state;
  const waiting = project.status === "awaiting_brd_approval";

  return (
    <FadeIn className="space-y-5">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/projects" className="font-semibold text-link underline underline-offset-2">
          All projects
        </Link>
      </nav>
      <RoomHeader project={project} connection={state.connection} send={send} />
      {loadError ? <Alert tone="attention">{loadError}</Alert> : null}
      {waiting ? (
        <Alert tone="attention" title="The BRD is ready for your OK">
          Read the requirements below, then approve them or ask for changes. <a href="#brd">Jump to the BRD</a>.
        </Alert>
      ) : null}
      <div className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <PhaseRail project={project} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start [&>*]:min-w-0">
        <div className="lg:sticky lg:top-4 lg:col-span-5 lg:col-start-1 lg:row-span-5 lg:row-start-1">
          <Conversation project={project} orders={orders} says={view.says} send={send} />
        </div>
        <div className={`lg:col-span-7 lg:col-start-6 ${waiting ? "max-lg:order-first" : ""}`}>
          <BrdPanel project={project} orders={orders} send={send} />
        </div>
        <div className="lg:col-span-7 lg:col-start-6">
          <AgentStage view={view} />
        </div>
        <div className="lg:col-span-7 lg:col-start-6">
          <Panel title="Coders">
            <Lanes view={view} />
          </Panel>
        </div>
        <div className="lg:col-span-7 lg:col-start-6">
          <ReleaseCard project={project} fallbackUrls={view.urls} send={send} />
        </div>
        <div className="lg:col-span-7 lg:col-start-6">
          <Panel title="Activity">
            <ActivityFeed view={view} />
          </Panel>
        </div>
      </div>
    </FadeIn>
  );
}

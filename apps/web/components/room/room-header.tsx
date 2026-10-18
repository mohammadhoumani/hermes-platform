"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PlayIcon, StopIcon } from "@/components/ui/icons";
import { StatusChip } from "@/components/ui/status-chip";
import type { ConnectionState, Project, ProjectStatus } from "@/lib/backend/types";
import { statusInfo } from "@/lib/status";
import { useAction, type SendFn } from "./use-send";

const CAN_STOP: ProjectStatus[] = ["queued", "discovery", "awaiting_brd_approval", "architecture", "development", "review", "qa", "releasing"];
const CAN_RESUME: ProjectStatus[] = ["stopped", "paused", "failed"];

const CONNECTION: Record<ConnectionState, { text: string; dot: string }> = {
  live: { text: "Updating live", dot: "bg-progress" },
  connecting: { text: "Connecting…", dot: "bg-attn" },
  reconnecting: { text: "Reconnecting… showing the last known state", dot: "bg-attn" },
  offline: { text: "Offline. Showing the last known state", dot: "bg-danger" },
};

export function RoomHeader({ project, connection, send }: { project: Project; connection: ConnectionState; send: SendFn }) {
  const { run, busy, error } = useAction(send);
  const [confirmStop, setConfirmStop] = useState(false);
  const info = statusInfo(project.status);
  const conn = CONNECTION[connection];

  return (
    <header data-testid="room-header" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-bold sm:text-3xl">{project.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusChip status={project.status} />
            <span className="text-sm text-muted">{info.sentence}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="connection" data-state={connection} role="status" className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs font-semibold">
            <span aria-hidden="true" className={`size-2 rounded-full ${conn.dot}`} />
            {conn.text}
          </span>
          {CAN_STOP.includes(project.status) ? (
            confirmStop ? (
              <span className="inline-flex items-center gap-2" role="group" aria-label="Confirm stop">
                <Button
                  variant="danger"
                  data-testid="confirm-stop"
                  loading={busy === "stop"}
                  loadingText="Stopping…"
                  onClick={async () => {
                    if (await run("stop")) setConfirmStop(false);
                  }}
                >
                  Yes, stop it
                </Button>
                <Button variant="ghost" onClick={() => setConfirmStop(false)}>
                  Keep going
                </Button>
              </span>
            ) : (
              <Button variant="secondary" data-testid="stop" onClick={() => setConfirmStop(true)}>
                <StopIcon width={16} height={16} /> Stop
              </Button>
            )
          ) : null}
          {CAN_RESUME.includes(project.status) ? (
            <Button variant="secondary" data-testid="resume" loading={busy === "resume"} loadingText="Resuming…" onClick={() => run("resume")}>
              <PlayIcon width={16} height={16} /> Resume
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </header>
  );
}

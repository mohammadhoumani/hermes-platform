"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { CheckIcon } from "@/components/ui/icons";
import { Markdown } from "@/components/markdown";
import type { Order, Project } from "@/lib/backend/types";
import { MAX_ORDER_TEXT } from "@/lib/backend/types";
import { useAction, type SendFn } from "./use-send";

const IN_FLIGHT = new Set(["queued", "taken", "running"]);

/**
 * The BRD (business requirements document) and the one approval in the whole app.
 * "Approve BRD" is the only approval button anywhere.
 */
export function BrdPanel({ project, orders, send }: { project: Project; orders: Order[]; send: SendFn }) {
  const { run, busy, error, clearError } = useAction(send);
  const [changing, setChanging] = useState(false);
  const [changes, setChanges] = useState("");

  const waiting = project.status === "awaiting_brd_approval";
  const approvalSent = orders.some((o) => o.kind === "approve_brd" && IN_FLIGHT.has(o.status));
  const changesSent = orders.some((o) => o.kind === "request_brd_changes" && IN_FLIGHT.has(o.status));
  const approved = Boolean(project.brdApprovedAt);

  return (
    <section
      id="brd"
      data-testid="brd-panel"
      aria-labelledby="brd-title"
      className={`rounded-2xl border bg-surface p-4 sm:p-5 ${waiting ? "border-2 border-attn" : "border-line"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="brd-title" className="text-lg font-bold">
          Requirements (BRD)
        </h2>
        {waiting ? (
          <span className="rounded-full bg-attn px-2.5 py-1 text-xs font-bold text-on-attn">Waiting for your OK</span>
        ) : approved ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-chip-working-bg px-2.5 py-1 text-xs font-bold text-chip-working-fg">
            <CheckIcon width={14} height={14} /> Approved
          </span>
        ) : null}
      </div>

      {project.brdMarkdown ? (
        <div className="mt-3 max-h-[32rem] overflow-y-auto rounded-xl border border-line bg-canvas p-4" tabIndex={0} aria-label="BRD text">
          <Markdown source={project.brdMarkdown} />
        </div>
      ) : (
        <p className="mt-3 rounded-xl border border-dashed border-line-strong p-4 text-sm text-muted">
          The BRD is not ready yet. The business analyst is still asking questions. Answer them in the conversation, and the document will show up here.
        </p>
      )}

      {waiting ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm">Read the document above. If it looks right, approve it. After that the agents finish the project on their own.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="attention"
              data-testid="approve-brd"
              loading={busy === "approve_brd"}
              loadingText="Approving…"
              disabled={approvalSent || busy !== null}
              onClick={() => run("approve_brd")}
            >
              Approve BRD
            </Button>
            <Button variant="secondary" data-testid="ask-changes" aria-expanded={changing} onClick={() => { setChanging((v) => !v); clearError(); }}>
              Ask for changes
            </Button>
          </div>
          {approvalSent ? <Alert tone="success" live>Your approval was sent. The agents are continuing.</Alert> : null}
          {changesSent ? <Alert tone="info" live>Your change request was sent. The analyst will update the BRD.</Alert> : null}
          {changing ? (
            <form
              className="space-y-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run("request_brd_changes", changes)) {
                  setChanges("");
                  setChanging(false);
                }
              }}
            >
              <TextAreaField
                label="What should change?"
                name="changes"
                value={changes}
                maxLength={MAX_ORDER_TEXT}
                onChange={(e) => setChanges(e.target.value)}
                hint="Write it in your own words. For example: the page must also work offline."
              />
              <Button type="submit" variant="secondary" loading={busy === "request_brd_changes"} loadingText="Sending…" disabled={!changes.trim()}>
                Send changes
              </Button>
            </form>
          ) : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      ) : approved ? (
        <p className="mt-3 text-sm text-muted">You approved this BRD on {new Date(project.brdApprovedAt!).toLocaleDateString(undefined, { dateStyle: "medium" })}.</p>
      ) : null}
    </section>
  );
}

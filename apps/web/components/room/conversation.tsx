"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SendIcon } from "@/components/ui/icons";
import { ListItem, useIsNew } from "@/components/motion";
import type { AgentSay } from "@/lib/agent-events/types";
import { MAX_ORDER_TEXT, type Order, type Project } from "@/lib/backend/types";
import { buildConversation } from "@/lib/room/conversation";
import { ORDER_STATUS_TEXT } from "@/lib/status";
import { useAction, type SendFn } from "./use-send";

export function Conversation({ project, orders, says, send }: { project: Project; orders: Order[]; says: AgentSay[]; send: SendFn }) {
  const items = useMemo(() => buildConversation(orders, says), [orders, says]);
  const { run, busy, error } = useAction(send);
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const last = items[items.length - 1]?.key;
  const isNew = useIsNew(items.map((i) => i.key));

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);

  const released = project.status === "released";
  const stopped = project.status === "stopped";
  const canType = !released && !stopped;

  const submit = async () => {
    if (!text.trim() || busy) return;
    if (await run("message", text)) setText("");
  };

  return (
    <section data-testid="conversation" aria-labelledby="conv-title" className="flex min-h-0 flex-col rounded-2xl border border-line bg-surface">
      <h2 id="conv-title" className="border-b border-line px-4 py-3 text-lg font-bold">
        Conversation
      </h2>
      <div ref={list} role="log" aria-live="polite" aria-label="Messages" className="max-h-[26rem] min-h-40 flex-1 overflow-y-auto px-4 py-3" tabIndex={0}>
      <ol className="space-y-3">
        {items.length === 0 ? (
          <li className="rounded-xl border border-dashed border-line-strong p-4 text-sm text-muted">
            No messages yet. When the agents have a question, it will show up here.
          </li>
        ) : null}
        {items.map((it) =>
          it.side === "system" ? (
            <ListItem key={it.key} fresh={isNew(it.key)} className="text-center text-xs font-semibold text-muted">
              {it.text}
            </ListItem>
          ) : it.side === "you" ? (
            <ListItem key={it.key} fresh={isNew(it.key)} className="ml-auto max-w-[88%]" data-side="you">
              <div className="rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-on-primary">
                {it.label ? <p className="text-xs font-bold opacity-90">{it.label}</p> : null}
                <p className="whitespace-pre-wrap break-words text-sm">{it.text}</p>
              </div>
              <p className="mt-1 text-right text-xs text-muted">{it.status === "done" ? "Delivered" : ORDER_STATUS_TEXT[it.status] ?? it.status}</p>
            </ListItem>
          ) : (
            <ListItem key={it.key} fresh={isNew(it.key)} className="mr-auto max-w-[92%]" data-side="agent" data-kind={it.kind}>
              <p className="mb-1 text-xs font-bold text-muted">
                {it.agentName}
                {it.kind === "question" ? " asks" : ""}
              </p>
              <div className={`rounded-2xl rounded-bl-md border px-3.5 py-2.5 ${it.kind === "question" ? "border-attn bg-surface-2" : "border-line bg-surface-2"}`}>
                <p className="whitespace-pre-wrap break-words text-sm">{it.text}</p>
              </div>
            </ListItem>
          ),
        )}
      </ol>
      </div>

      <div className="border-t border-line p-3">
        {released ? (
          <p className="px-1 text-sm text-muted">This project is live. To ask for a change, use the box on the Release card.</p>
        ) : stopped ? (
          <p className="px-1 text-sm text-muted">This project is stopped. Resume it to send messages.</p>
        ) : null}
        {canType ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-2"
          >
            <label htmlFor="reply-box" className="sr-only">
              Your reply
            </label>
            <textarea
              id="reply-box"
              data-testid="reply-box"
              value={text}
              rows={2}
              maxLength={MAX_ORDER_TEXT}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="Write a reply to the agents…"
              className="block w-full resize-y rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-base placeholder:text-muted"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted">{text.length > 3500 ? `${text.length} / ${MAX_ORDER_TEXT}` : "Ctrl+Enter sends"}</span>
              <Button type="submit" data-testid="send-reply" disabled={!text.trim()} loading={busy === "message"} loadingText="Sending…">
                <SendIcon width={16} height={16} /> Send
              </Button>
            </div>
          </form>
        ) : null}
        {error ? (
          <div className="mt-2">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
      </div>
    </section>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { ListItem, useIsNew } from "@/components/motion";
import { AGENTS } from "@/lib/agent-events/roster";
import type { AgentId, FeedItem, FeedTag, ViewState } from "@/lib/agent-events/types";
import { clockTime } from "@/lib/time";

const TAG_LABEL: Partial<Record<FeedTag, string>> = {
  handoff: "handoff", commit: "commit", push: "push", branch: "branch", pr: "pull request", ci: "checks", "ci-fail": "checks failed",
  review: "review", changes: "changes asked", merge: "merged", deploy: "deploy", live: "live", issue: "task", repo: "repository",
  guard: "protection", question: "question", answer: "answer", reply: "reply", tool: "step", error: "problem", file: "file", docs: "docs",
  done: "finished", gate: "your OK", approval: "approval", command: "start", sync: "team sync", qa: "QA", bug: "bug", devin: "Devin", message: "message",
};

function Who({ id }: { id: AgentId }) {
  const a = AGENTS[id];
  return (
    <span className="inline-flex items-center rounded-full bg-chip-neutral-bg px-2 py-0.5 text-xs font-bold text-chip-neutral-fg" title={a.job}>
      {id === "human" ? "You" : a.name}
    </span>
  );
}

function Row({ item, fresh }: { item: FeedItem; fresh: boolean }) {
  if (item.kind === "phase") {
    return (
      <ListItem fresh={fresh} className="flex items-center gap-3 py-1" data-kind="phase">
        <span aria-hidden="true" className="h-px flex-1 bg-line-strong" />
        <span className="text-xs font-bold uppercase tracking-wide text-muted">{item.text}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-line-strong" />
      </ListItem>
    );
  }
  const gate = item.kind === "gate";
  return (
    <ListItem
      fresh={fresh}
      data-kind={item.kind}
      data-tag={item.tag}
      className={`rounded-xl border px-3 py-2 ${gate ? "border-attn bg-surface-2" : "border-line bg-surface"}`}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <Who id={item.from} />
        {item.to ? (
          <>
            <span aria-label="to">→</span>
            <Who id={item.to} />
          </>
        ) : null}
        <span className="ml-auto text-xs text-muted">
          {TAG_LABEL[item.tag] ?? item.tag}
          {item.ts ? ` · ${clockTime(item.ts)}` : ""}
        </span>
      </div>
      <p className="mt-1 break-words text-sm">{item.text}</p>
    </ListItem>
  );
}

export function ActivityFeed({ view }: { view: ViewState }) {
  const [showSteps, setShowSteps] = useState(false);
  const box = useRef<HTMLOListElement>(null);
  const items = view.feed.filter((f) => showSteps || !f.quiet).slice(-120);
  const last = items[items.length - 1]?.id;
  const isNew = useIsNew(items.map((i) => i.id));

  // keep the newest line in view, unless the person scrolled up to read
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (near) el.scrollTop = el.scrollHeight;
  }, [last]);

  return (
    <div data-testid="feed">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted" aria-live="polite">
          {view.stats.messages} message{view.stats.messages === 1 ? "" : "s"}, {view.stats.commits} commit{view.stats.commits === 1 ? "" : "s"}, {view.stats.prs} pull request{view.stats.prs === 1 ? "" : "s"}
        </p>
        <label className="inline-flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={showSteps} onChange={(e) => setShowSteps(e.target.checked)} className="size-4 accent-[var(--progress)]" />
          Show technical steps
        </label>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong p-4 text-sm text-muted">Nothing yet. When the agents start working, you will see each step here.</p>
      ) : (
        <ol ref={box} className="max-h-[28rem] space-y-1.5 overflow-y-auto pr-1" tabIndex={0} aria-label="Activity, newest at the bottom">
          {items.map((it) => (
            <Row key={it.id} item={it} fresh={isNew(it.id)} />
          ))}
        </ol>
      )}
    </div>
  );
}

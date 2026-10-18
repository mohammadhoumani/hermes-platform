import { AGENTS, LANES } from "@/lib/agent-events/roster";
import { LANE_STEPS, type LaneView, type ViewState } from "@/lib/agent-events/types";

const STEP_NAMES = ["Task", "Code", "Commit", "PR", "CI", "Review", "Merged"];

function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "ok" | "bad" | "run" }) {
  const cls =
    tone === "ok" ? "bg-chip-working-bg text-chip-working-fg" : tone === "bad" ? "bg-chip-danger-bg text-chip-danger-fg" : tone === "run" ? "bg-chip-attention-bg text-chip-attention-fg" : "bg-chip-neutral-bg text-chip-neutral-fg";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

function Lane({ id, lane }: { id: (typeof LANES)[number]; lane: LaneView }) {
  const finished = lane.step === LANE_STEPS.length - 1;
  const stepLabel = lane.step < 0 ? "Not started" : STEP_NAMES[lane.step];
  return (
    <li data-lane={id} className="rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-bold">{AGENTS[id].name}</h4>
        <span className="text-xs text-muted">{stepLabel}</span>
      </div>
      <p className="mt-1 truncate text-sm" title={lane.task}>
        {lane.task || "Waiting for a task"}
      </p>
      <p className="truncate font-mono text-xs text-muted" title={lane.branch}>
        {lane.branch || "no branch yet"}
      </p>
      <div className="mt-2 flex gap-1" role="img" aria-label={lane.step < 0 ? "Not started" : `Step ${lane.step + 1} of ${LANE_STEPS.length}: ${stepLabel}`}>
        {LANE_STEPS.map((s, i) => (
          <span
            key={s}
            className={`h-2 flex-1 rounded-full ${finished ? "bg-progress" : i < lane.step ? "bg-progress" : i === lane.step ? "bg-primary ring-2 ring-progress" : "bg-line"}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {lane.done ? <Pill tone={lane.done === "completed" ? "ok" : "bad"}>{lane.done}</Pill> : null}
        <Pill>{lane.pr || "no PR"}</Pill>
        <Pill tone={lane.ci === "passed" ? "ok" : lane.ci === "failed" ? "bad" : lane.ci === "running" ? "run" : "neutral"}>CI {lane.ci || "-"}</Pill>
        <Pill tone={lane.review === "approved" ? "ok" : lane.review === "changes" ? "bad" : lane.review ? "run" : "neutral"}>
          {lane.review === "changes" ? "changes asked" : lane.review || "no review"}
        </Pill>
      </div>
    </li>
  );
}

export function Lanes({ view }: { view: ViewState }) {
  return (
    <ul data-testid="lanes" className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3" aria-label="Coders">
      {LANES.map((id) => (
        <Lane key={id} id={id} lane={view.lanes[id]} />
      ))}
    </ul>
  );
}

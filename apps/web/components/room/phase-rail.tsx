import { CheckIcon } from "@/components/ui/icons";
import type { Project } from "@/lib/backend/types";
import { buildRail, type RailState } from "@/lib/room/rail";

const DOT: Record<RailState, string> = {
  done: "bg-progress text-canvas border-progress",
  active: "bg-primary text-on-primary border-progress",
  "needs-you": "bg-attn text-on-attn border-attn",
  todo: "bg-surface text-muted border-line-strong",
};
const STATE_TEXT: Record<RailState, string> = {
  done: "done",
  active: "in progress",
  "needs-you": "needs you",
  todo: "not started",
};

export function PhaseRail({ project }: { project: Pick<Project, "phase" | "status"> }) {
  const steps = buildRail(project);
  return (
    <nav aria-label="Progress" data-testid="phase-rail">
      <ol className="grid grid-cols-6 gap-1">
        {steps.map((s, i) => (
          <li key={s.id} className="relative flex flex-col items-center text-center" aria-current={s.state === "active" || s.state === "needs-you" ? "step" : undefined}>
            {i > 0 ? (
              <span
                aria-hidden="true"
                className={`absolute right-1/2 top-[15px] -z-0 h-0.5 w-full ${steps[i - 1]!.state === "done" ? "bg-progress" : "bg-line-strong"}`}
              />
            ) : null}
            <span
              data-state={s.state}
              className={`relative z-10 inline-flex size-8 items-center justify-center rounded-full border-2 text-sm font-bold ${DOT[s.state]}`}
            >
              {s.state === "done" ? <CheckIcon width={16} height={16} /> : i + 1}
            </span>
            <span className="mt-1.5 text-[11px] font-semibold leading-tight sm:text-sm">
              <span className="sm:hidden">{s.short}</span>
              <span className="hidden sm:inline">{s.label}</span>
            </span>
            <span className="hidden text-xs text-muted sm:block">{s.blurb}</span>
            <span className="sr-only">: {STATE_TEXT[s.state]}</span>
            {s.state === "needs-you" ? <span className="mt-0.5 rounded-full bg-attn px-2 py-0.5 text-[10px] font-bold text-on-attn sm:text-xs">Needs you</span> : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

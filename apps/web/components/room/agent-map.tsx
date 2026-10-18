import { AGENT_ORDER, AGENTS } from "@/lib/agent-events/roster";
import type { AgentStatus, ViewState } from "@/lib/agent-events/types";

const STATUS_TEXT: Record<AgentStatus, string> = { idle: "idle", active: "working", waiting: "waiting for you", done: "done" };

const NODE: Record<AgentStatus, { fill: string; stroke: string; text: string }> = {
  idle: { fill: "fill-surface", stroke: "stroke-line-strong", text: "fill-fg" },
  active: { fill: "fill-primary", stroke: "stroke-progress", text: "fill-on-primary" },
  waiting: { fill: "fill-attn", stroke: "stroke-attn", text: "fill-on-attn" },
  done: { fill: "fill-chip-working-bg", stroke: "stroke-progress", text: "fill-chip-working-fg" },
};

/** "Who is talking": every agent as a node, lines for who has talked to whom, bright lines for the latest talk. */
export function AgentMap({ view }: { view: ViewState }) {
  const hub = AGENTS.orchestrator.home;
  const recent = view.internal.seq - 8;
  const summary = AGENT_ORDER.filter((id) => view.agents[id] !== "idle")
    .map((id) => `${AGENTS[id].name} ${STATUS_TEXT[view.agents[id]]}`)
    .join(", ");

  return (
    <figure data-testid="agent-map" className="m-0">
      <svg viewBox="0 0 640 450" role="img" aria-label={`Who is talking. ${summary || "Nobody is working yet."}`} className="h-auto w-full">
        {AGENT_ORDER.filter((id) => id !== "orchestrator").map((id) => (
          <line key={`hub-${id}`} x1={hub.x} y1={hub.y} x2={AGENTS[id].home.x} y2={AGENTS[id].home.y} className="stroke-line" strokeWidth="1.5" strokeDasharray="3 5" />
        ))}
        {view.links.map((l) => {
          const a = AGENTS[l.a].home;
          const b = AGENTS[l.b].home;
          const hot = l.lastSeq > recent;
          return (
            <line
              key={`${l.a}-${l.b}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={hot ? "stroke-progress" : "stroke-line-strong"}
              strokeWidth={hot ? 3 : Math.min(2.5, 1 + l.count / 8)}
              strokeLinecap="round"
              opacity={hot ? 1 : 0.55}
            />
          );
        })}
        {AGENT_ORDER.map((id) => {
          const a = AGENTS[id];
          const st = view.agents[id];
          const c = NODE[st];
          const label = id === "human" ? "You" : a.name;
          return (
            <g key={id} data-agent={id} data-status={st} transform={`translate(${a.home.x} ${a.home.y})`}>
              {st === "active" ? <circle r="34" className="fill-primary opacity-25 motion-safe:animate-pulse" /> : null}
              {a.kind === "service" ? (
                <rect x="-24" y="-20" width="48" height="40" rx="8" strokeDasharray="4 3" strokeWidth="2.5" className={`${c.fill} ${c.stroke}`} />
              ) : a.kind === "person" ? (
                <rect x="-26" y="-22" width="52" height="44" rx="12" strokeWidth="2.5" className={`${c.fill} ${c.stroke}`} />
              ) : (
                <circle r="24" strokeWidth="2.5" className={`${c.fill} ${c.stroke}`} />
              )}
              <text textAnchor="middle" y="4.5" fontSize="13" fontWeight="700" className={c.text}>
                {a.short}
              </text>
              {st === "done" ? (
                <g>
                  <circle cx="18" cy="-18" r="8" className="fill-progress" />
                  <path d="M14 -18l3 3 5-6" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="stroke-canvas" />
                </g>
              ) : null}
              <text textAnchor="middle" y="44" fontSize="13" fontWeight="600" className="fill-fg">
                {label}
              </text>
              <text textAnchor="middle" y="59" fontSize="11.5" className="fill-muted">
                {id === "github" ? (st === "active" ? "updated" : "code") : STATUS_TEXT[st]}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">
        {AGENT_ORDER.map((id) => `${AGENTS[id].name}: ${STATUS_TEXT[view.agents[id]]}`).join(". ")}
      </figcaption>
    </figure>
  );
}

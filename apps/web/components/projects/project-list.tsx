import Link from "next/link";
import { LinkButton } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { PlusIcon } from "@/components/ui/icons";
import type { Project } from "@/lib/backend/types";
import { PHASE_LABEL } from "@/lib/status";
import { timeAgo } from "@/lib/time";

export function ProjectList({ projects, currentUserId }: { projects: Project[]; currentUserId: string }) {
  if (projects.length === 0) {
    return (
      <div data-testid="empty-projects" className="rounded-2xl border border-dashed border-line-strong bg-surface p-8 text-center">
        <h2 className="text-lg font-bold">No projects yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          Describe an idea in a few sentences. Hermes will ask you some questions, write the requirements, and then build it.
        </p>
        <LinkButton href="/projects/new" className="mt-5">
          <PlusIcon width={18} height={18} /> Start your first project
        </LinkButton>
      </div>
    );
  }
  return (
    <ul data-testid="project-list" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((p) => (
        <li key={p.id}>
          <Link
            href={`/projects/${p.id}`}
            className="block h-full rounded-2xl border border-line bg-surface p-4 transition-shadow hover:shadow-md focus-visible:shadow-md"
            data-testid="project-card"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 break-words text-base font-bold">{p.name}</h2>
              <StatusChip status={p.status} />
            </div>
            <p className="mt-2 text-sm text-muted">
              {p.phase ? `Phase: ${PHASE_LABEL[p.phase]}` : "Not started"}
              {" · "}
              {timeAgo(p.updatedAt)}
            </p>
            <p className="mt-1 text-xs text-muted">{p.ownerId === currentUserId ? "Started by you" : "Started by a teammate"}</p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

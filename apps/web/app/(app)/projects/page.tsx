import type { Metadata } from "next";
import Link from "next/link";
import { ProjectList } from "@/components/projects/project-list";
import { Alert } from "@/components/ui/alert";
import { LinkButton } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";
import type { Project } from "@/lib/backend/types";
import { getSession } from "@/lib/backend/session";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const session = await getSession();
  if (session.status !== "ok") return null; // the layout already handled these cases

  let projects: Project[];
  let error: string | null = null;
  try {
    projects = await session.backend.listProjects();
  } catch (e) {
    projects = [];
    error = e instanceof Error ? e.message : "Something went wrong. Please try again.";
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">{session.user.role === "owner" ? "All projects" : "Your projects"}</h1>
          <p className="mt-1 text-sm text-muted">Each project is an idea that Hermes builds for you.</p>
        </div>
        <LinkButton href="/projects/new" data-testid="new-project">
          <PlusIcon width={18} height={18} /> New project
        </LinkButton>
      </div>
      {error ? (
        <Alert tone="danger" title="We could not load your projects">
          {error} <Link href="/projects">Try again</Link>
        </Alert>
      ) : (
        <ProjectList projects={projects} currentUserId={session.user.id} />
      )}
    </div>
  );
}

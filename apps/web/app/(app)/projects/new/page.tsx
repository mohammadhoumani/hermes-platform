import type { Metadata } from "next";
import Link from "next/link";
import { NewProjectForm } from "@/components/projects/new-project-form";
import { getSession } from "@/lib/backend/session";

export const metadata: Metadata = { title: "New project" };

export default async function NewProjectPage() {
  const session = await getSession();
  if (session.status !== "ok") return null;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/projects" className="font-semibold text-link underline underline-offset-2">
          All projects
        </Link>
      </nav>
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Start a new project</h1>
        <p className="mt-1 text-sm text-muted">Tell Hermes what you want to build. You can write it the way you would tell a friend.</p>
      </div>
      <NewProjectForm testRole={session.testRole} />
    </div>
  );
}

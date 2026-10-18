import type { Metadata } from "next";
import { TeamManager } from "@/components/team/team-manager";
import { Alert } from "@/components/ui/alert";
import type { Invite } from "@/lib/backend/types";
import { getSession } from "@/lib/backend/session";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const session = await getSession();
  if (session.status !== "ok") return null;

  if (session.user.role !== "owner") {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-bold">Team</h1>
        <Alert tone="info" title="Only owners can manage the team">
          Ask a team owner if you want to invite someone.
        </Alert>
      </div>
    );
  }

  let invites: Invite[];
  let error: string | null = null;
  try {
    invites = await session.backend.listInvites();
  } catch (e) {
    invites = [];
    error = e instanceof Error ? e.message : "Something went wrong. Please try again.";
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Team</h1>
        <p className="mt-1 text-sm text-muted">Hermes is invite only. Add the email address of each person who should have an account.</p>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TeamManager initial={invites} testRole={session.testRole} />
    </div>
  );
}

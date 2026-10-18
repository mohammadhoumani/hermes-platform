import { redirect } from "next/navigation";
import { AccessRemoved } from "@/components/access-removed";
import { AppHeader } from "@/components/app-header";
import { Alert } from "@/components/ui/alert";
import { SetupNeeded } from "@/components/setup-needed";
import { getSession } from "@/lib/backend/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.status === "not_configured") return <SetupNeeded />;
  if (session.status === "signed_out") redirect("/login");
  if (session.status === "error") {
    return (
      <main id="main" className="mx-auto max-w-2xl px-4 py-16">
        <Alert tone="danger" title="We could not load your account">
          {session.message}
        </Alert>
      </main>
    );
  }
  if (session.user.disabled) return <AccessRemoved testMode={session.testRole !== null} />;
  return (
    <>
      <AppHeader user={session.user} testMode={session.testRole !== null} />
      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </>
  );
}

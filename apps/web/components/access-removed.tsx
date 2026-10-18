import { Alert } from "@/components/ui/alert";
import { Wordmark } from "@/components/ui/logo";
import { SignOutButton } from "@/components/sign-out-button";
import { ACCESS_REMOVED_MESSAGE } from "@/lib/auth/messages";

/** Shown instead of the app when a team owner removed this person's access. */
export function AccessRemoved({ testMode }: { testMode: boolean }) {
  return (
    <>
      <header data-surface="header" className="bg-header text-on-header">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-2 sm:px-6">
          <Wordmark />
          <div className="ml-auto">
            <SignOutButton testMode={testMode} />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
        <h1 className="mb-4 text-2xl font-bold">Your access has been removed</h1>
        <Alert tone="attention">{ACCESS_REMOVED_MESSAGE}</Alert>
        <p className="mt-4 text-sm text-muted">Your projects are kept. If a team owner gives your access back, sign in again and everything will be there.</p>
      </main>
    </>
  );
}

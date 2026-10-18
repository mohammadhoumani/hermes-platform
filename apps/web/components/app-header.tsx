import Link from "next/link";
import { cookies } from "next/headers";
import { Wordmark } from "@/components/ui/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";
import type { CurrentUser } from "@/lib/backend/types";
import { THEME_COOKIE } from "@/lib/theme";

export async function AppHeader({ user, testMode }: { user: CurrentUser; testMode: boolean }) {
  const theme = (await cookies()).get(THEME_COOKIE)?.value ?? "system";
  return (
    <header data-surface="header" className="bg-header text-on-header">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
        <Link href="/projects" className="rounded-lg py-1 text-on-header" aria-label="Hermes, go to your projects">
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1 text-sm font-semibold">
          <Link href="/projects" className="rounded-lg px-3 py-2.5 hover:bg-white/10">
            Projects
          </Link>
          {user.role === "owner" ? (
            <Link href="/settings/team" className="rounded-lg px-3 py-2.5 hover:bg-white/10">
              Team
            </Link>
          ) : null}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <span className="hidden max-w-48 truncate text-sm sm:inline" title={user.email}>
            {user.displayName}
          </span>
          <ThemeToggle initial={theme} />
          <SignOutButton testMode={testMode} />
        </div>
      </div>
    </header>
  );
}

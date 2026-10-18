import Link from "next/link";
import { LinkButton } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-3xl font-bold">We could not find that page</h1>
      <p className="mt-3 text-muted">The link may be old, or the project may belong to someone else.</p>
      <LinkButton href="/projects" className="mt-6">
        Go to your projects
      </LinkButton>
      <Link href="/login" className="mt-3 text-sm font-semibold text-link underline underline-offset-2">
        Sign in with another account
      </Link>
    </main>
  );
}

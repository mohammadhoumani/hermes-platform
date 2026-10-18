import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <AuthCard
      title="Sign in"
      intro="Welcome back. Sign in to see your projects."
      footer={
        <p>
          Hermes is invite only. Have an invite?{" "}
          <Link href="/signup" className="font-semibold text-link underline underline-offset-2">
            Create your account
          </Link>
        </p>
      }
    >
      <LoginForm next={next ?? null} linkProblem={error === "link"} />
    </AuthCard>
  );
}

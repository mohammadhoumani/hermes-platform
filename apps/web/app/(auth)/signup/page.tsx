import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { SignupForm } from "@/components/auth/signup-form";
import { Alert } from "@/components/ui/alert";

export const metadata: Metadata = { title: "Create your account" };

export default function SignupPage() {
  return (
    <AuthCard
      title="Create your account"
      intro={<Alert tone="info" title="Hermes is invite only">You can only sign up with the email address that the team owner invited.</Alert>}
      footer={
        <p>
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-link underline underline-offset-2">
            Sign in
          </Link>
        </p>
      }
    >
      <SignupForm />
    </AuthCard>
  );
}

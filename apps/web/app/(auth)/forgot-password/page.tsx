import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { ForgotForm } from "@/components/auth/forgot-form";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset your password"
      intro="Enter your email and we will send you a link to choose a new password."
      footer={
        <p>
          Remembered it?{" "}
          <Link href="/login" className="font-semibold text-link underline underline-offset-2">
            Back to sign in
          </Link>
        </p>
      }
    >
      <ForgotForm />
    </AuthCard>
  );
}

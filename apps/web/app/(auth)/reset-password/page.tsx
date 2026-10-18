import type { Metadata } from "next";
import { AuthCard } from "@/components/auth-card";
import { ResetForm } from "@/components/auth/reset-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default function ResetPasswordPage() {
  return (
    <AuthCard title="Choose a new password" intro="Pick a password you have not used before.">
      <ResetForm />
    </AuthCard>
  );
}

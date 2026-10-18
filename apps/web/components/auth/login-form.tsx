"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { describeAuthError } from "@/lib/auth/messages";
import { sanitizeNext } from "@/lib/auth/route-guard";
import { validateEmail, validatePassword } from "@/lib/auth/validate";
import { getBrowserSupabase } from "@/lib/supabase/browser";

export function LoginForm({ next, linkProblem }: { next: string | null; linkProblem?: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string | null; password?: string | null }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const nextErrors = { email: validateEmail(email), password: validatePassword(password) };
    setErrors(nextErrors);
    setFormError(null);
    if (nextErrors.email || nextErrors.password) {
      document.getElementById(nextErrors.email ? "login-email" : "login-password")?.focus();
      return;
    }
    setBusy(true);
    try {
      const { error } = await getBrowserSupabase().auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      router.replace(sanitizeNext(next));
      router.refresh();
    } catch (err) {
      setFormError(describeAuthError(err, "signin"));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Sign in">
      {linkProblem ? <Alert tone="attention">That link has expired or was already used. Sign in, or ask for a new link.</Alert> : null}
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <TextField
        label="Email"
        id="login-email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
      />
      <TextField
        label="Password"
        id="login-password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
      />
      <div className="flex items-center justify-between gap-3">
        <Link href="/forgot-password" className="text-sm font-semibold text-link underline underline-offset-2">
          Forgot your password?
        </Link>
      </div>
      <Button type="submit" className="w-full" loading={busy} loadingText="Signing in…">
        Sign in
      </Button>
    </form>
  );
}

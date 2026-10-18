"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { describeAuthError } from "@/lib/auth/messages";
import { validateEmail } from "@/lib/auth/validate";
import { getBrowserSupabase } from "@/lib/supabase/browser";

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateEmail(email);
    setError(err);
    setFormError(null);
    if (err) {
      document.getElementById("forgot-email")?.focus();
      return;
    }
    setBusy(true);
    try {
      const { error: apiError } = await getBrowserSupabase().auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });
      if (apiError) throw apiError;
      setSent(true);
    } catch (e2) {
      setFormError(describeAuthError(e2, "reset"));
    }
    setBusy(false);
  };

  if (sent) {
    return (
      <Alert tone="success" title="Check your email" live>
        If {email.trim()} has an account, we sent a link to it. The link works for one hour.
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Reset your password">
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <TextField
        label="Email"
        id="forgot-email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={error}
      />
      <Button type="submit" className="w-full" loading={busy} loadingText="Sending…">
        Send the link
      </Button>
    </form>
  );
}

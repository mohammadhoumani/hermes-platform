"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { describeAuthError } from "@/lib/auth/messages";
import { validateConfirm, validateNewPassword } from "@/lib/auth/validate";
import { getBrowserSupabase } from "@/lib/supabase/browser";

type Phase = "checking" | "ready" | "no-session" | "done";

export function ResetForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string | null; confirm?: string | null }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The link in the email signs the person in (through /auth/callback). Without that session we cannot change the password.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await getBrowserSupabase().auth.getUser();
        if (alive) setPhase(data.user ? "ready" : "no-session");
      } catch (err) {
        if (alive) {
          setFormError(describeAuthError(err, "update"));
          setPhase("no-session");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next = { password: validateNewPassword(password), confirm: validateConfirm(password, confirm) };
    setErrors(next);
    setFormError(null);
    if (next.password || next.confirm) {
      document.getElementById(next.password ? "reset-password" : "reset-confirm")?.focus();
      return;
    }
    setBusy(true);
    try {
      const { error } = await getBrowserSupabase().auth.updateUser({ password });
      if (error) throw error;
      setPhase("done");
      setTimeout(() => {
        router.replace("/projects");
        router.refresh();
      }, 1500);
    } catch (err) {
      setFormError(describeAuthError(err, "update"));
      setBusy(false);
    }
  };

  if (phase === "checking") return <p className="text-sm text-muted" role="status">Checking your link…</p>;
  if (phase === "done") {
    return (
      <Alert tone="success" title="Password changed" live>
        You are signed in. Taking you to your projects…
      </Alert>
    );
  }
  if (phase === "no-session") {
    return (
      <div className="space-y-4">
        <Alert tone="attention" title="This link has expired">
          {formError ?? "Reset links work once and for one hour."}
        </Alert>
        <Link href="/forgot-password" className="inline-block font-semibold text-link underline underline-offset-2">
          Ask for a new link
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Choose a new password">
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <TextField
        label="New password"
        id="reset-password"
        name="password"
        type="password"
        autoComplete="new-password"
        hint="At least 8 characters."
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
      />
      <TextField
        label="Type it again"
        id="reset-confirm"
        name="confirm"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={errors.confirm}
      />
      <Button type="submit" className="w-full" loading={busy} loadingText="Saving…">
        Save password
      </Button>
    </form>
  );
}

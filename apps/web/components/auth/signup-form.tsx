"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { describeAuthError } from "@/lib/auth/messages";
import { validateConfirm, validateEmail, validateName, validateNewPassword } from "@/lib/auth/validate";
import { getBrowserSupabase } from "@/lib/supabase/browser";

type Errors = Partial<Record<"name" | "email" | "password" | "confirm", string | null>>;

export function SignupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [checkInbox, setCheckInbox] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {
      name: validateName(name),
      email: validateEmail(email),
      password: validateNewPassword(password),
      confirm: validateConfirm(password, confirm),
    };
    setErrors(next);
    setFormError(null);
    const firstBad = (["name", "email", "password", "confirm"] as const).find((k) => next[k]);
    if (firstBad) {
      document.getElementById(`signup-${firstBad}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await getBrowserSupabase().auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { display_name: name.trim() },
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/projects`,
        },
      });
      if (error) throw error;
      if (data.session) {
        router.replace("/projects");
        router.refresh();
        return;
      }
      setCheckInbox(true);
      setBusy(false);
    } catch (err) {
      setFormError(describeAuthError(err, "signup"));
      setBusy(false);
    }
  };

  if (checkInbox) {
    return (
      <Alert tone="success" title="Check your email" live>
        We sent a link to {email.trim()}. Open it to finish creating your account.
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Create your account">
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <TextField label="Your name" id="signup-name" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
      <TextField
        label="Email (the one you were invited with)"
        id="signup-email"
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
        id="signup-password"
        name="password"
        type="password"
        autoComplete="new-password"
        hint="At least 8 characters."
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
      />
      <TextField
        label="Type the password again"
        id="signup-confirm"
        name="confirm"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={errors.confirm}
      />
      <Button type="submit" className="w-full" loading={busy} loadingText="Creating your account…">
        Create account
      </Button>
    </form>
  );
}

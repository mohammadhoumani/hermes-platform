"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { ListItem, useIsNew } from "@/components/motion";
import { validateEmail } from "@/lib/auth/validate";
import { loadBrowserBackend } from "@/lib/backend/browser";
import { BackendError, type Invite, type Role } from "@/lib/backend/types";
import { timeAgo } from "@/lib/time";

export function TeamManager({ initial, testRole }: { initial: Invite[]; testRole: Role | null }) {
  const [invites, setInvites] = useState(initial);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = useIsNew(initial.map((i) => i.email));
  const [removing, setRemoving] = useState<string | null>(null);

  const reload = async () => {
    const backend = await loadBrowserBackend(testRole);
    setInvites(await backend.listInvites());
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const v = validateEmail(email);
    setEmailError(v);
    if (v) {
      document.getElementById("invite-email")?.focus();
      return;
    }
    setBusy(true);
    try {
      const backend = await loadBrowserBackend(testRole);
      await backend.createInvite(email, role);
      setNotice(`Invited ${email.trim().toLowerCase()}. They can now create an account with this email.`);
      setEmail("");
      await reload();
    } catch (err) {
      setError(err instanceof BackendError ? err.message : "Something went wrong. Please try again.");
    }
    setBusy(false);
  };

  const revoke = async (addr: string) => {
    setError(null);
    setNotice(null);
    setRemoving(addr);
    try {
      const backend = await loadBrowserBackend(testRole);
      await backend.revokeInvite(addr);
      setNotice(`Removed the invite for ${addr}.`);
      await reload();
    } catch (err) {
      setError(err instanceof BackendError ? err.message : "Something went wrong. Please try again.");
    }
    setRemoving(null);
  };

  return (
    <div className="space-y-6">
      <form onSubmit={add} noValidate className="space-y-4 rounded-2xl border border-line bg-surface p-5" aria-label="Invite someone">
        <h2 className="text-lg font-bold">Invite someone</h2>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {notice ? <Alert tone="success" live>{notice}</Alert> : null}
        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-start">
          <TextField
            label="Email address"
            id="invite-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailError}
          />
          <div>
            <label htmlFor="invite-role" className="mb-1.5 block text-sm font-semibold">
              Can do
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="block min-h-[46px] w-full rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-base"
            >
              <option value="member">Start their own projects</option>
              <option value="owner">Owner: see all projects and invite people</option>
            </select>
          </div>
        </div>
        <Button type="submit" loading={busy} loadingText="Inviting…">
          Send invite
        </Button>
      </form>

      <section aria-labelledby="invites-title" className="rounded-2xl border border-line bg-surface p-5">
        <h2 id="invites-title" className="text-lg font-bold">
          Invites and members
        </h2>
        {invites.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nobody has been invited yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line" data-testid="invite-list">
            {invites.map((i) => (
              <ListItem key={i.email} fresh={isNew(i.email)} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="invite-row">
                <div className="min-w-0">
                  <p className="break-all text-sm font-semibold">{i.email}</p>
                  <p className="text-xs text-muted">
                    {i.role === "owner" ? "Owner" : "Member"} · {i.acceptedAt ? `Joined ${timeAgo(i.acceptedAt)}` : `Invited ${timeAgo(i.createdAt)}, not joined yet`}
                  </p>
                </div>
                {!i.acceptedAt ? (
                  <Button variant="danger" loading={removing === i.email} loadingText="Removing…" onClick={() => revoke(i.email)} aria-label={`Remove the invite for ${i.email}`}>
                    Remove invite
                  </Button>
                ) : (
                  <span className="rounded-full bg-chip-working-bg px-2.5 py-1 text-xs font-bold text-chip-working-fg">Joined</span>
                )}
              </ListItem>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

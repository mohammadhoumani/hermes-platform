"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { ListItem, useIsNew } from "@/components/motion";
import { validateEmail } from "@/lib/auth/validate";
import { loadBrowserBackend } from "@/lib/backend/browser";
import { BackendError, type Invite, type Role, type TeamMember } from "@/lib/backend/types";
import { timeAgo } from "@/lib/time";

const SOMETHING_WRONG = "Something went wrong. Please try again.";
const message = (err: unknown) => (err instanceof BackendError ? err.message : SOMETHING_WRONG);

export function TeamManager({
  initialInvites,
  initialMembers,
  meId,
  testRole,
}: {
  initialInvites: Invite[];
  initialMembers: TeamMember[];
  meId: string;
  testRole: Role | null;
}) {
  const [invites, setInvites] = useState(initialInvites);
  const [members, setMembers] = useState(initialMembers);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = useIsNew(initialInvites.map((i) => i.email));
  const [removingInvite, setRemovingInvite] = useState<string | null>(null);
  /** The member whose "Remove access" button was pressed and who must be confirmed. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const pending = invites.filter((i) => !i.acceptedAt);

  const reload = async () => {
    const backend = await loadBrowserBackend(testRole);
    const [inv, mem] = await Promise.all([backend.listInvites(), backend.listMembers()]);
    setInvites(inv);
    setMembers(mem);
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
      setError(message(err));
    }
    setBusy(false);
  };

  const revoke = async (addr: string) => {
    setError(null);
    setNotice(null);
    setRemovingInvite(addr);
    try {
      const backend = await loadBrowserBackend(testRole);
      await backend.revokeInvite(addr);
      setNotice(`Removed the invite for ${addr}.`);
      await reload();
    } catch (err) {
      setError(message(err));
    }
    setRemovingInvite(null);
  };

  const removeAccess = async (m: TeamMember) => {
    setError(null);
    setNotice(null);
    setWorking(m.id);
    try {
      const backend = await loadBrowserBackend(testRole);
      await backend.removeMember(m.id);
      setConfirming(null);
      setNotice(`${m.displayName || m.email} can no longer sign in or see anything. Their projects are kept and their running work is being stopped.`);
      await reload();
    } catch (err) {
      setError(message(err));
    }
    setWorking(null);
  };

  const giveBack = async (m: TeamMember) => {
    setError(null);
    setNotice(null);
    setWorking(m.id);
    try {
      const backend = await loadBrowserBackend(testRole);
      await backend.restoreMember(m.id);
      setNotice(`${m.displayName || m.email} has access again.`);
      await reload();
    } catch (err) {
      setError(message(err));
    }
    setWorking(null);
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

      <section aria-labelledby="members-title" className="rounded-2xl border border-line bg-surface p-5">
        <h2 id="members-title" className="text-lg font-bold">
          People
        </h2>
        {members.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nobody has joined yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line" data-testid="member-list">
            {members.map((m) => {
              const isMe = m.id === meId;
              const removed = m.disabledAt !== null;
              const canRemove = !isMe && m.role === "member" && !removed;
              const name = m.displayName || m.email;
              return (
                <li key={m.id} className="py-3" data-testid="member-row">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        {name}
                        {isMe ? <span className="ml-2 text-xs font-medium text-muted">(you)</span> : null}
                      </p>
                      <p className="break-all text-xs text-muted">{m.email}</p>
                      <p className="text-xs text-muted">
                        {m.role === "owner" ? "Owner" : "Member"} · {m.projectCount} {m.projectCount === 1 ? "project" : "projects"}
                        {removed ? ` · Access removed ${timeAgo(m.disabledAt!)}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {removed ? (
                        <span className="rounded-full bg-chip-danger-bg px-2.5 py-1 text-xs font-bold text-chip-danger-fg">Access removed</span>
                      ) : (
                        <span className="rounded-full bg-chip-working-bg px-2.5 py-1 text-xs font-bold text-chip-working-fg">Active</span>
                      )}
                      {removed ? (
                        <Button variant="secondary" loading={working === m.id} loadingText="Working…" onClick={() => giveBack(m)} aria-label={`Give access back to ${name}`}>
                          Give access back
                        </Button>
                      ) : canRemove && confirming !== m.id ? (
                        <Button variant="danger" onClick={() => setConfirming(m.id)} aria-label={`Remove access for ${name}`}>
                          Remove access
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {confirming === m.id ? (
                    <div role="group" aria-label={`Confirm removing ${name}`} className="mt-3 space-y-3 rounded-xl border border-line-strong bg-surface-2 p-4">
                      <p className="text-sm">
                        Remove access for <strong>{name}</strong>? They are signed out and cannot see or do anything. Their projects are kept, and work that is still running is
                        stopped. You can give access back at any time.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="danger" loading={working === m.id} loadingText="Removing…" onClick={() => removeAccess(m)} aria-label={`Yes, remove access for ${name}`}>
                          Yes, remove access
                        </Button>
                        <Button variant="secondary" disabled={working === m.id} onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="invites-title" className="rounded-2xl border border-line bg-surface p-5">
        <h2 id="invites-title" className="text-lg font-bold">
          Invites waiting
        </h2>
        {pending.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No invites are waiting. Everyone you invited has joined.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line" data-testid="invite-list">
            {pending.map((i) => (
              <ListItem key={i.email} fresh={isNew(i.email)} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="invite-row">
                <div className="min-w-0">
                  <p className="break-all text-sm font-semibold">{i.email}</p>
                  <p className="text-xs text-muted">
                    {i.role === "owner" ? "Owner" : "Member"} · Invited {timeAgo(i.createdAt)}, not joined yet
                  </p>
                </div>
                <Button variant="danger" loading={removingInvite === i.email} loadingText="Removing…" onClick={() => revoke(i.email)} aria-label={`Remove the invite for ${i.email}`}>
                  Remove invite
                </Button>
              </ListItem>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

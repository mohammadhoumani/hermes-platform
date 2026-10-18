"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { loadBrowserBackend } from "@/lib/backend/browser";
import { BackendError, MAX_ORDER_TEXT, type Role } from "@/lib/backend/types";
import { suggestProjectName } from "@/lib/project-name";

export function NewProjectForm({ testRole }: { testRole: Role | null }) {
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [name, setName] = useState("");
  const [ideaError, setIdeaError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmed = idea.trim();
    if (!trimmed) {
      setIdeaError("Describe your idea first, even in one sentence.");
      document.getElementById("project-idea")?.focus();
      return;
    }
    if (trimmed.length > MAX_ORDER_TEXT) {
      setIdeaError("That is too long. Please keep it under 4000 characters. You can add details later in the conversation.");
      return;
    }
    setIdeaError(null);
    setBusy(true);
    try {
      const backend = await loadBrowserBackend(testRole);
      const id = await backend.createProject(name.trim() || suggestProjectName(trimmed), trimmed);
      router.push(`/projects/${id}`);
    } catch (err) {
      setFormError(err instanceof BackendError ? err.message : "We could not start the project. Please try again.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5 rounded-2xl border border-line bg-surface p-5 sm:p-6" aria-label="New project">
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <TextAreaField
        label="Your idea"
        id="project-idea"
        name="idea"
        rows={6}
        maxLength={MAX_ORDER_TEXT + 1}
        value={idea}
        onChange={(e) => setIdea(e.target.value)}
        error={ideaError}
        hint="What should it do? Who is it for? Do not worry about technical words."
        placeholder="A web page that works out the tip and splits the bill between friends."
      />
      <TextField
        label="Project name (optional)"
        id="project-name"
        name="name"
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
        hint="Leave it empty and we will pick a name from your idea."
      />
      <Button type="submit" loading={busy} loadingText="Starting…" data-testid="start-project">
        Start project
      </Button>
    </form>
  );
}

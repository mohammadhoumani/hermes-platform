"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { ExternalIcon } from "@/components/ui/icons";
import { MAX_ORDER_TEXT, type Project } from "@/lib/backend/types";
import { safeHttpUrl } from "@/lib/agent-events/text";
import { useAction, type SendFn } from "./use-send";

function LinkRow({ label, url, empty }: { label: string; url: string | undefined; empty: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2">
      <span className="text-sm font-semibold">{label}</span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1.5 break-all text-sm font-semibold text-link underline underline-offset-2"
        >
          {url.replace(/^https?:\/\//, "")}
          <ExternalIcon width={14} height={14} />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : (
        <span className="text-sm text-muted">{empty}</span>
      )}
    </div>
  );
}

export function ReleaseCard({ project, fallbackUrls, send }: { project: Project; fallbackUrls: { repo?: string; staging?: string; production?: string }; send: SendFn }) {
  const { run, busy, error } = useAction(send);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const released = project.status === "released";

  const repo = safeHttpUrl(project.repoUrl) ?? fallbackUrls.repo;
  const staging = safeHttpUrl(project.stagingUrl) ?? fallbackUrls.staging;
  const production = safeHttpUrl(project.productionUrl) ?? fallbackUrls.production;

  return (
    <section data-testid="release-card" aria-labelledby="rel-title" className={`rounded-2xl border bg-surface p-4 sm:p-5 ${released ? "border-2 border-progress" : "border-line"}`}>
      <h2 id="rel-title" className="text-lg font-bold">
        {released ? "Your project is live" : "Release"}
      </h2>
      <div className="mt-3 space-y-2">
        <LinkRow label="Code on GitHub" url={repo} empty="Not created yet" />
        <LinkRow label="Staging site (for testing)" url={staging} empty="Not ready yet" />
        <LinkRow label="Live site" url={production} empty="Not live yet" />
      </div>

      {released ? (
        <form
          className="mt-4 space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run("change_request", text)) {
              setText("");
              setSent(true);
            }
          }}
        >
          <TextAreaField
            label="Want something changed?"
            name="change"
            value={text}
            maxLength={MAX_ORDER_TEXT}
            onChange={(e) => {
              setText(e.target.value);
              setSent(false);
            }}
            hint="Describe the change in your own words. The agents will build it, test it and publish it. You do not need to approve anything."
          />
          <Button type="submit" variant="secondary" data-testid="send-change" loading={busy === "change_request"} loadingText="Sending…" disabled={!text.trim()}>
            Send change request
          </Button>
          {sent ? <Alert tone="success" live>Your change request was sent.</Alert> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </form>
      ) : null}
    </section>
  );
}

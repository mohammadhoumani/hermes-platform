import type { ReactNode } from "react";
import { AlertIcon, CheckIcon, InfoIcon } from "./icons";

export type AlertTone = "info" | "success" | "attention" | "danger";

const TONE: Record<AlertTone, string> = {
  info: "border-line-strong bg-surface-2 text-fg",
  success: "border-line-strong bg-chip-working-bg text-chip-working-fg",
  attention: "border-line-strong bg-chip-attention-bg text-chip-attention-fg",
  danger: "border-line-strong bg-chip-danger-bg text-chip-danger-fg",
};

export function Alert({ tone = "info", children, title, live }: { tone?: AlertTone; children: ReactNode; title?: string; live?: boolean }) {
  const Icon = tone === "success" ? CheckIcon : tone === "info" ? InfoIcon : AlertIcon;
  return (
    <div
      role={tone === "danger" ? "alert" : live ? "status" : undefined}
      className={`flex gap-3 rounded-xl border px-4 py-3 text-sm ${TONE[tone]}`}
    >
      <Icon className="mt-0.5 shrink-0" width={18} height={18} />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className="[&_a]:underline">{children}</div>
      </div>
    </div>
  );
}

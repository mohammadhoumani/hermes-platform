import type { ProjectStatus } from "@/lib/backend/types";
import { statusInfo, type StatusTone } from "@/lib/status";

const TONE: Record<StatusTone, string> = {
  neutral: "bg-chip-neutral-bg text-chip-neutral-fg",
  working: "bg-chip-working-bg text-chip-working-fg",
  attention: "bg-chip-attention-bg text-chip-attention-fg",
  success: "bg-chip-success-bg text-chip-success-fg",
  danger: "bg-chip-danger-bg text-chip-danger-fg",
};

export function StatusChip({ status, className = "" }: { status: ProjectStatus; className?: string }) {
  const info = statusInfo(status);
  return (
    <span
      data-status={status}
      data-tone={info.tone}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${TONE[info.tone]} ${className}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full bg-current ${info.pulse ? "motion-safe:animate-pulse" : ""}`} />
      {info.label}
    </span>
  );
}

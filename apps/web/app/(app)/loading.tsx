export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">Loading…</span>
      <div className="h-8 w-48 animate-pulse rounded-lg bg-surface-2" />
      <div className="h-24 animate-pulse rounded-2xl bg-surface-2" />
      <div className="h-24 animate-pulse rounded-2xl bg-surface-2" />
    </div>
  );
}

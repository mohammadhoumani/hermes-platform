export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--green-500)" />
      <path d="M10 8v16M22 8v16M10 16h12" stroke="var(--steel-900)" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M5 11c2.500-1 4-.5 5 1M27 11c-2.500-1-4-.5-5 1" stroke="var(--steel-900)" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 font-bold tracking-tight ${className}`}>
      <LogoMark />
      <span className="text-xl">Hermes</span>
    </span>
  );
}

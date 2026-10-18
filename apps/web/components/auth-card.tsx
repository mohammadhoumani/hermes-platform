import type { ReactNode } from "react";

export function AuthCard({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
      <h1 className="text-2xl font-bold">{title}</h1>
      {intro ? <div className="mt-2 text-sm text-muted">{intro}</div> : null}
      <div className="mt-6">{children}</div>
      {footer ? <div className="mt-6 border-t border-line pt-4 text-sm">{footer}</div> : null}
    </div>
  );
}

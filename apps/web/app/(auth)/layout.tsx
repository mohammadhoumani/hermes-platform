import { Wordmark } from "@/components/ui/logo";
import { FadeIn } from "@/components/motion";
import { PHASES } from "@/lib/agent-events/roster";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside data-surface="brand-panel" className="relative overflow-hidden bg-header px-6 py-8 text-on-header sm:px-10 lg:flex lg:flex-col lg:justify-between lg:py-12">
        <Wordmark />
        <div className="mt-8 max-w-md lg:mt-0">
          <h2 className="text-balance text-2xl font-bold leading-tight sm:text-3xl lg:text-4xl">
            Describe an idea. A team of agents builds it.
          </h2>
          <p className="mt-3 text-base opacity-90">
            You answer a few questions and approve one document. Hermes plans, builds, checks and publishes the rest.
          </p>
          <ol className="mt-6 hidden gap-2 sm:grid sm:grid-cols-2" aria-label="How a project moves">
            {PHASES.map((p, i) => (
              <li key={p.id} className="flex items-center gap-3 rounded-xl bg-white/10 px-3 py-2 text-sm">
                <span
                  aria-hidden="true"
                  className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    i === 0 ? "bg-attn text-on-attn" : "bg-primary text-on-primary"
                  }`}
                >
                  {i + 1}
                </span>
                <span>
                  <span className="font-semibold">{p.label}</span>
                  <span className="block text-xs opacity-80">{p.blurb}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 hidden text-sm opacity-90 sm:block">
            <span className="mr-2 inline-block size-3 rounded-full bg-attn align-middle" aria-hidden="true" />
            Step 1 is the only time Hermes needs you: you approve the requirements.
          </p>
        </div>
        <p className="mt-8 hidden text-xs opacity-80 lg:block">Hermes Platform. Invite only.</p>
      </aside>
      <main id="main" className="flex items-start justify-center px-4 py-8 sm:px-8 lg:items-center lg:py-12">
        <FadeIn className="w-full max-w-md">{children}</FadeIn>
      </main>
    </div>
  );
}

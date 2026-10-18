import { Alert } from "@/components/ui/alert";

export function SetupNeeded() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-bold">This site is not set up yet</h1>
      <div className="mt-4">
        <Alert tone="attention" title="Supabase settings are missing">
          <p>
            The website needs two settings to talk to the database: <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>. Copy <code>apps/web/.env.example</code> to <code>apps/web/.env.local</code>, fill them in, and restart.
          </p>
        </Alert>
      </div>
    </main>
  );
}

import { getBrowserSupabase } from "@/lib/supabase/browser";
import { createSupabaseBackend } from "./supabase";
import type { Backend, Role } from "./types";

let live: Backend | null = null;
let fixture: { role: Role; backend: Backend } | null = null;

/**
 * The Backend for client components. `testRole` is passed down from the server and is null in production.
 * The fixture branch is removed from production bundles because NODE_ENV is a build-time constant there.
 */
export async function loadBrowserBackend(testRole: Role | null): Promise<Backend> {
  if (process.env.NODE_ENV !== "production" && testRole) {
    if (!fixture || fixture.role !== testRole) {
      const { createFixtureBackend } = await import("./fixture");
      fixture = { role: testRole, backend: createFixtureBackend(testRole) };
    }
    return fixture.backend;
  }
  live ??= createSupabaseBackend(getBrowserSupabase());
  return live;
}

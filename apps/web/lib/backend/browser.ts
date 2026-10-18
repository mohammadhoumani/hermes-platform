import { getBrowserSupabase } from "@/lib/supabase/browser";
import { createSupabaseBackend } from "./supabase";
import type { Backend, Role } from "./types";

let live: Backend | null = null;
let fixture: { role: Role; backend: Promise<Backend> } | null = null;

/**
 * The Backend for client components. `testRole` is passed down from the server and is null in production.
 * The fixture branch is removed from production bundles because NODE_ENV is a build-time constant there.
 */
export async function loadBrowserBackend(testRole: Role | null): Promise<Backend> {
  if (process.env.NODE_ENV !== "production" && testRole) {
    // Keep the promise, not the result: two callers at the same time must share one backend.
    if (!fixture || fixture.role !== testRole) {
      fixture = { role: testRole, backend: import("./fixture").then((m) => m.createFixtureBackend(testRole)) };
    }
    return fixture.backend;
  }
  live ??= createSupabaseBackend(getBrowserSupabase());
  return live;
}

import "server-only";
import { cookies } from "next/headers";
import { TEST_USER_COOKIE } from "@/lib/env";
import { getServerSupabase } from "@/lib/supabase/server";
import { createSupabaseBackend } from "./supabase";
import type { Backend, Role } from "./types";

export interface ServerBackend {
  backend: Backend;
  /** Set only in test mode: tells client components to use the fixture backend too. */
  testRole: Role | null;
}

/**
 * The Backend for server components. Returns null when the app is not configured.
 * Test mode is decided here, on the server only, and the condition is written out in full so that
 * production builds drop the fixture import (see lib/env.ts).
 */
export async function getServerBackend(): Promise<ServerBackend | null> {
  if (process.env.NODE_ENV !== "production" && process.env.HERMES_TEST_MODE === "1") {
    const v = (await cookies()).get(TEST_USER_COOKIE)?.value;
    const role: Role = v === "owner" ? "owner" : "member";
    const { createFixtureBackend } = await import("./fixture");
    return { backend: createFixtureBackend(role), testRole: role };
  }
  const client = await getServerSupabase();
  return client ? { backend: createSupabaseBackend(client), testRole: null } : null;
}

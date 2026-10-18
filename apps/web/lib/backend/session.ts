import "server-only";
import { cache } from "react";
import { getServerBackend } from "./server";
import type { Backend, CurrentUser, Role } from "./types";

export type Session =
  | { status: "ok"; backend: Backend; user: CurrentUser; testRole: Role | null }
  | { status: "not_configured" }
  | { status: "signed_out" }
  | { status: "error"; message: string };

/** The signed-in person and the Backend, once per request (React cache). */
export const getSession = cache(async (): Promise<Session> => {
  const ctx = await getServerBackend();
  if (!ctx) return { status: "not_configured" };
  try {
    const user = await ctx.backend.getCurrentUser();
    if (!user) return { status: "signed_out" };
    return { status: "ok", backend: ctx.backend, user, testRole: ctx.testRole };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "Something went wrong. Please try again." };
  }
});

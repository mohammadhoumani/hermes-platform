import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv, isTestMode, TEST_USER_COOKIE } from "@/lib/env";

export interface SessionResult {
  response: NextResponse;
  signedIn: boolean;
}

/**
 * Looks up the session for a request and refreshes the auth cookies when needed.
 * Uses getUser(), which asks the Supabase Auth server, so a forged cookie never counts as signed in.
 */
export async function readSession(request: NextRequest): Promise<SessionResult> {
  let response = NextResponse.next({ request });

  if (isTestMode()) {
    const v = request.cookies.get(TEST_USER_COOKIE)?.value;
    return { response, signedIn: v === "owner" || v === "member" };
  }

  const env = getSupabaseEnv();
  if (!env) return { response, signedIn: false };

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  try {
    const { data } = await supabase.auth.getUser();
    return { response, signedIn: Boolean(data.user) };
  } catch {
    return { response, signedIn: false };
  }
}

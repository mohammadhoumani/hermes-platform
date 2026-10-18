import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/lib/auth/route-guard";
import { readSession } from "@/lib/supabase/proxy";

/**
 * Protects every page except the sign-in pages and static files. (Next.js 16 calls this file "proxy";
 * it is the same thing as the older "middleware".)
 */
export async function proxy(request: NextRequest) {
  const { response, signedIn } = await readSession(request);
  const { pathname, search } = request.nextUrl;
  const decision = decideAccess({ pathname, search, signedIn });
  if (decision.action === "allow") return response;

  const redirect = NextResponse.redirect(new URL(decision.to, request.url));
  // keep any refreshed auth cookies
  for (const c of response.cookies.getAll()) redirect.cookies.set(c);
  return redirect;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};

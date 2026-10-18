import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { sanitizeNext } from "@/lib/auth/route-guard";
import { getServerSupabase } from "@/lib/supabase/server";

/**
 * Where the links in our emails land (sign-up confirmation and password reset).
 * Supports the PKCE flow (?code=) and the token hash flow (?token_hash=&type=).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = sanitizeNext(searchParams.get("next"));
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await getServerSupabase();
  if (supabase) {
    try {
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) return NextResponse.redirect(new URL(next, origin));
      } else if (tokenHash && type) {
        const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
        if (!error) return NextResponse.redirect(new URL(next, origin));
      }
    } catch {
      /* fall through to the friendly error below */
    }
  }
  return NextResponse.redirect(new URL("/login?error=link", origin));
}

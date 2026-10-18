/**
 * Turns auth and database errors into short, plain sentences a person can act on.
 */

export type AuthContext = "signin" | "signup" | "reset" | "update";

interface ErrorLike {
  message?: string;
  code?: string;
  status?: number;
  name?: string;
}

function asErrorLike(e: unknown): ErrorLike {
  if (e && typeof e === "object") return e as ErrorLike;
  if (typeof e === "string") return { message: e };
  return {};
}

export const ACCESS_REMOVED_MESSAGE = "Your access has been removed. Ask a team owner if this is a mistake.";

export const NOT_INVITED_MESSAGE = "This email is not on the invite list. Ask the team owner to invite you, then try again.";

export function describeAuthError(error: unknown, context: AuthContext): string {
  const e = asErrorLike(error);
  const msg = (e.message ?? "").toLowerCase();
  const code = (e.code ?? "").toLowerCase();

  if (e.name === "NotConfiguredError") {
    return "This site is not set up yet. Ask the team owner to add the Supabase settings.";
  }
  if (
    e.name === "AuthRetryableFetchError" ||
    e.status === 0 ||
    /failed to fetch|fetch failed|networkerror|network request failed|load failed|econnrefused/.test(msg)
  ) {
    return "We could not reach the server. Check your internet and try again.";
  }
  // The invite trigger on auth.users: Supabase shows it as "Database error saving new user" (or our own text)
  if (
    context === "signup" &&
    (/database error saving new user|not been invited|invite/.test(msg) || code === "unexpected_failure" || code === "invite_required")
  ) {
    return NOT_INVITED_MESSAGE;
  }
  if (code === "user_banned" || /user is banned|user_banned/.test(msg)) return ACCESS_REMOVED_MESSAGE;
  if (code === "invalid_credentials" || /invalid login credentials/.test(msg)) {
    return "That email and password do not match. Try again, or reset your password.";
  }
  if (code === "email_not_confirmed" || /email not confirmed/.test(msg)) {
    return "Please confirm your email first. Check your inbox for the link.";
  }
  if (code === "user_already_exists" || code === "email_exists" || /already registered|already been registered/.test(msg)) {
    return "This email already has an account. Try signing in instead.";
  }
  if (code === "weak_password" || /password should be at least|weak password/.test(msg)) {
    return "Choose a stronger password with at least 8 characters.";
  }
  if (code === "same_password" || /different from the old password/.test(msg)) {
    return "Choose a password you have not used before.";
  }
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || e.status === 429 || /rate limit|too many/.test(msg)) {
    return "Too many tries. Please wait a few minutes and try again.";
  }
  if (code === "session_not_found" || code === "refresh_token_not_found" || /auth session missing|session.*(expired|missing)/.test(msg)) {
    return context === "update"
      ? "Your reset link has expired. Ask for a new one."
      : "Your session has ended. Please sign in again.";
  }
  if (code === "otp_expired" || /expired|invalid.*(token|link)/.test(msg)) {
    return "This link has expired or was already used. Ask for a new one.";
  }
  return "Something went wrong. Please try again.";
}

/** Database and API errors from the data layer (orders, invites, projects). */
export function describeDataError(error: unknown): string {
  const e = asErrorLike(error);
  const msg = (e.message ?? "").toLowerCase();
  const code = e.code ?? "";
  if (e.name === "NotConfiguredError") return "This site is not set up yet. Ask the team owner to add the Supabase settings.";
  if (/failed to fetch|fetch failed|networkerror|load failed/.test(msg)) {
    return "We could not reach the server. Check your internet and try again.";
  }
  if (code === "54000" || /too many orders/.test(msg)) return "You are sending too fast. Please wait a few minutes and try again.";
  if (/access has been removed/.test(msg)) return ACCESS_REMOVED_MESSAGE;
  if (code === "42501" && /^only owners/.test(msg)) return "Only team owners can do that.";
  if (code === "42501" || /row-level security|permission denied/.test(msg)) return "You are not allowed to do that.";
  if (code === "23505") return "That already exists.";
  if (code === "23514") {
    if (/orders_text_required/.test(msg)) return "Please write a message first.";
    if (/text_check|length/.test(msg)) return "That text is too long. Please make it shorter (4000 characters or fewer).";
    if (/email/.test(msg)) return "Enter a valid email address.";
    return "That is not allowed. Please check what you wrote.";
  }
  if ((code === "22023" || code === "P0002") && e.message) return e.message; // our own plain messages (create_project, remove_member)
  if (code === "28000") return "Please sign in again.";
  return "Something went wrong. Please try again.";
}

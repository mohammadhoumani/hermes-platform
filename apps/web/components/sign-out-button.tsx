"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { TEST_USER_COOKIE } from "@/lib/env";
import { getBrowserSupabase } from "@/lib/supabase/browser";

export function SignOutButton({ testMode }: { testMode: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      if (testMode) {
        document.cookie = `${TEST_USER_COOKIE}=; path=/; max-age=0`;
      } else {
        await getBrowserSupabase().auth.signOut();
      }
    } catch {
      /* signing out must never get stuck: go to the login page anyway */
    }
    router.replace("/login");
    router.refresh();
  };

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-on-header hover:bg-white/10 disabled:opacity-60"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

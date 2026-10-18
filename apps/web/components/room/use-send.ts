"use client";

import { useCallback, useState } from "react";
import { BackendError, MAX_ORDER_TEXT, type OrderKind } from "@/lib/backend/types";

export type SendFn = (kind: OrderKind, text: string) => Promise<void>;

/** Wraps a send function with busy and error state so every form behaves the same. */
export function useAction(send: SendFn) {
  const [busy, setBusy] = useState<OrderKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (kind: OrderKind, text = ""): Promise<boolean> => {
      setError(null);
      if (text.length > MAX_ORDER_TEXT) {
        setError("That text is too long. Please make it shorter (4000 characters or fewer).");
        return false;
      }
      setBusy(kind);
      try {
        await send(kind, text);
        return true;
      } catch (e) {
        setError(e instanceof BackendError ? e.message : "Something went wrong. Please try again.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [send],
  );
  return { run, busy, error, clearError: () => setError(null) };
}

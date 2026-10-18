"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ViewState } from "@/lib/agent-events/types";
import { STORAGE_KEY, clearMemoryChoice, detectLowEnd, hasWebGL, prefersReducedMotion, readSavedMode, saveMode, type Capabilities, type ViewMode } from "./capabilities";
import { deriveOfficeScene, pickBubbles, type OfficeScene } from "./scene-state";

const noopUnsubscribe = () => undefined;

// ---- what the browser can do (null on the server and while hydrating) ----

let capsCache: Capabilities | null = null;

function subscribeCaps(cb: () => void): () => void {
  try {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  } catch {
    return noopUnsubscribe;
  }
}

function capsSnapshot(): Capabilities {
  const reduced = prefersReducedMotion();
  if (!capsCache || capsCache.reducedMotion !== reduced) capsCache = { webgl: hasWebGL(), reducedMotion: reduced, lowEnd: detectLowEnd() };
  return capsCache;
}

export function useCapabilities(): Capabilities | null {
  return useSyncExternalStore(subscribeCaps, capsSnapshot, () => null);
}

// ---- the saved choice (localStorage, with a memory copy) ----

const choiceListeners = new Set<() => void>();

function subscribeChoice(cb: () => void): () => void {
  choiceListeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    clearMemoryChoice();
    cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    choiceListeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSavedMode(): [ViewMode | null, (mode: ViewMode) => void] {
  const saved = useSyncExternalStore(subscribeChoice, readSavedMode, () => null);
  const set = (mode: ViewMode) => {
    saveMode(mode);
    choiceListeners.forEach((cb) => cb());
  };
  return [saved, set];
}

// ---- light or dark ----

function subscribeTheme(cb: () => void): () => void {
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", cb);
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", cb);
      mo.disconnect();
    };
  } catch {
    return noopUnsubscribe;
  }
}

function darkSnapshot(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark") return true;
  if (theme === "light") return false;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function useDarkMode(): boolean {
  return useSyncExternalStore(subscribeTheme, darkSnapshot, () => false);
}

// ---- the scene, with the clock for walks and bubbles ----

/** How long a speech bubble stays, and how long a visitor stays at the other desk. */
export const BUBBLE_MS = 9000;
export const VISIT_MS = 3200;

/**
 * The OfficeScene for a ViewState. Keeps track of which walks are over and which bubbles have been
 * shown long enough. Only things that happen while the page is open can make someone walk; the history that
 * was there at the start is shown as it is.
 */
export function useOfficeScene(view: ViewState, walking: boolean): OfficeScene {
  const [freshAfter] = useState(() => view.internal.seq);
  const [settled, setSettled] = useState(-1);
  const [expired, setExpired] = useState<ReadonlySet<number>>(() => new Set());
  const scheduled = useRef(new Set<number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const nowId = view.now?.id ?? -1;
  useEffect(() => {
    if (nowId < 0) return;
    const t = setTimeout(() => setSettled(nowId), VISIT_MS);
    return () => clearTimeout(t);
  }, [nowId]);

  const bubbleKey = useMemo(() => pickBubbles(view).map((b) => b.id).join(","), [view]);
  useEffect(() => {
    for (const id of bubbleKey ? bubbleKey.split(",").map(Number) : []) {
      if (scheduled.current.has(id)) continue;
      scheduled.current.add(id);
      const t = setTimeout(() => {
        timers.current.delete(t);
        setExpired((prev) => new Set(prev).add(id));
      }, BUBBLE_MS);
      timers.current.add(t);
    }
  }, [bubbleKey]);

  // Each timer expires its own bubble, so they are only cleaned up when the office goes away.
  useEffect(() => {
    const pending = timers.current;
    const done = scheduled.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
      done.clear();
    };
  }, []);

  return useMemo(
    () => deriveOfficeScene(view, { walking, freshAfter, settledHandoff: settled, expiredBubbles: expired }),
    [view, walking, freshAfter, settled, expired],
  );
}

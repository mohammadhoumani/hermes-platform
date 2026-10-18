/**
 * Decides whether the room shows the 3D office or the 2D map. The decision is a pure function; the functions
 * that look at the browser are small and wrapped in try/catch because privacy settings can block any of them.
 */

export type ViewMode = "3d" | "map";

export const STORAGE_KEY = "hermes-office-view";

export interface Capabilities {
  webgl: boolean;
  reducedMotion: boolean;
  /** 4 cores or fewer, or 4 GB of memory or less. */
  lowEnd: boolean;
}

export type ModeReason = "no-webgl" | "saved" | "reduced-motion" | "low-end" | "default";

export interface ModeDecision {
  mode: ViewMode;
  /** False when the 3D view cannot run at all (no WebGL): the 3D button is disabled. */
  can3d: boolean;
  reason: ModeReason;
}

/** The mode to start in. A saved choice wins, except that nothing can turn on 3D without WebGL. */
export function decideMode(caps: Capabilities, saved: ViewMode | null): ModeDecision {
  if (!caps.webgl) return { mode: "map", can3d: false, reason: "no-webgl" };
  if (saved) return { mode: saved, can3d: true, reason: "saved" };
  if (caps.reducedMotion) return { mode: "map", can3d: true, reason: "reduced-motion" };
  if (caps.lowEnd) return { mode: "map", can3d: true, reason: "low-end" };
  return { mode: "3d", can3d: true, reason: "default" };
}

export function isLowEnd(hardwareConcurrency: number | undefined, deviceMemory: number | undefined): boolean {
  if (typeof hardwareConcurrency === "number" && hardwareConcurrency > 0 && hardwareConcurrency <= 4) return true;
  if (typeof deviceMemory === "number" && deviceMemory > 0 && deviceMemory <= 4) return true;
  return false;
}

export function parseMode(value: string | null | undefined): ViewMode | null {
  return value === "3d" || value === "map" ? value : null;
}

/** Kept in memory too, so the choice holds for this visit even when storage is blocked. */
let memoryChoice: ViewMode | null = null;

/** The choice made in this tab wins; otherwise what localStorage holds (null when blocked or empty). */
export function readSavedMode(): ViewMode | null {
  if (memoryChoice) return memoryChoice;
  try {
    return parseMode(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null; // private window or blocked storage
  }
}

/** Another tab changed the saved value: use that instead of this tab's copy. */
export function clearMemoryChoice(): void {
  memoryChoice = null;
}

export function saveMode(mode: ViewMode): void {
  memoryChoice = mode;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* the choice only lasts until the page is closed */
  }
}

let webglCache: boolean | undefined;

/** True when the browser can make a WebGL context. Checked once, on a throwaway canvas. */
export function hasWebGL(): boolean {
  if (webglCache !== undefined) return webglCache;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    webglCache = !!gl;
    // Give the context back right away so the page does not hold a spare one.
    (gl as WebGLRenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglCache = false;
  }
  return webglCache;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function detectLowEnd(): boolean {
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    return isLowEnd(nav.hardwareConcurrency, nav.deviceMemory);
  } catch {
    return false;
  }
}

export function detectCapabilities(): Capabilities {
  return { webgl: hasWebGL(), reducedMotion: prefersReducedMotion(), lowEnd: detectLowEnd() };
}

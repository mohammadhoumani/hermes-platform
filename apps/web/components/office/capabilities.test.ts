// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEY, clearMemoryChoice, decideMode, isLowEnd, parseMode, readSavedMode, saveMode, type Capabilities } from "./capabilities";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({ webgl: true, reducedMotion: false, lowEnd: false, ...over });

describe("decideMode", () => {
  it("opens the 3D office on a capable device", () => {
    expect(decideMode(caps(), null)).toEqual({ mode: "3d", can3d: true, reason: "default" });
  });

  it("falls back to the map, and disables 3D, when WebGL is missing, whatever was saved", () => {
    expect(decideMode(caps({ webgl: false }), null)).toEqual({ mode: "map", can3d: false, reason: "no-webgl" });
    expect(decideMode(caps({ webgl: false }), "3d").mode).toBe("map");
  });

  it("starts on the map under reduced motion and on weak devices, but allows switching", () => {
    expect(decideMode(caps({ reducedMotion: true }), null)).toEqual({ mode: "map", can3d: true, reason: "reduced-motion" });
    expect(decideMode(caps({ lowEnd: true }), null)).toEqual({ mode: "map", can3d: true, reason: "low-end" });
  });

  it("lets a saved choice win over reduced motion and weak devices", () => {
    expect(decideMode(caps({ reducedMotion: true, lowEnd: true }), "3d").mode).toBe("3d");
    expect(decideMode(caps(), "map").mode).toBe("map");
  });
});

describe("isLowEnd", () => {
  it("is true for 4 cores or fewer, or 4 GB or less", () => {
    expect(isLowEnd(4, undefined)).toBe(true);
    expect(isLowEnd(2, 8)).toBe(true);
    expect(isLowEnd(8, 4)).toBe(true);
    expect(isLowEnd(8, 8)).toBe(false);
    expect(isLowEnd(12, undefined)).toBe(false);
  });
  it("is false when the browser does not say (Safari, Firefox)", () => {
    expect(isLowEnd(undefined, undefined)).toBe(false);
    expect(isLowEnd(0, 0)).toBe(false);
  });
});

describe("the saved choice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    clearMemoryChoice();
  });

  it("only accepts the two known values", () => {
    expect(parseMode("3d")).toBe("3d");
    expect(parseMode("map")).toBe("map");
    expect(parseMode("flat")).toBeNull();
    expect(parseMode(null)).toBeNull();
  });

  it("is kept in localStorage", () => {
    saveMode("3d");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("3d");
    expect(readSavedMode()).toBe("3d");
  });

  it("does not break when storage throws, and still remembers for this visit", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => saveMode("map")).not.toThrow();
    expect(readSavedMode()).toBe("map");
  });
});

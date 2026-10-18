// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import discoveryRun from "@/lib/agent-events/fixtures/discovery-awaiting-brd.json";
import { replay } from "@/lib/agent-events/reduce";
import type { AgentEvent } from "@/lib/agent-events/types";
import { STORAGE_KEY } from "./capabilities";

// three.js cannot run in jsdom, and the real canvas is loaded lazily anyway: stand in for it.
vi.mock("./office-canvas", () => ({
  default: ({ scene, reduced }: { scene: { summary: string }; reduced: boolean }) => (
    <div data-testid="fake-canvas" data-reduced={String(reduced)}>
      {scene.summary}
    </div>
  ),
}));

const view = replay(discoveryRun as unknown as AgentEvent[]);

interface Env {
  webgl?: boolean;
  reducedMotion?: boolean;
  cores?: number;
  memory?: number;
}

function setupBrowser({ webgl = true, reducedMotion = false, cores = 8, memory = 8 }: Env = {}) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  Object.defineProperty(navigator, "hardwareConcurrency", { value: cores, configurable: true });
  Object.defineProperty(navigator, "deviceMemory", { value: memory, configurable: true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) =>
    webgl && kind.startsWith("webgl") ? { getExtension: () => null } : null) as never);
}

async function load() {
  // The capability check is cached per page load, so every test needs a fresh copy of the modules.
  vi.resetModules();
  const mod = await import("./agent-stage");
  return mod.AgentStage;
}

describe("AgentStage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts as the map on the server and on the first render", async () => {
    setupBrowser();
    const AgentStage = await load();
    const { container } = render(<AgentStage view={view} />);
    expect(container.querySelector('[data-testid="agent-map"]')).not.toBeNull();
  });

  it("opens the 3D office on a strong device", async () => {
    setupBrowser();
    const AgentStage = await load();
    render(<AgentStage view={view} />);
    expect(await screen.findByTestId("fake-canvas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3D office" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("agent-map")).toBeNull();
  });

  it("has a live text summary and a list of who does what, for screen readers", async () => {
    setupBrowser();
    const AgentStage = await load();
    render(<AgentStage view={view} />);
    await screen.findByTestId("fake-canvas");
    expect(screen.getByRole("status")).toHaveTextContent(/waiting for you to approve the BRD/i);
    expect(screen.getByRole("list", { name: "Who is doing what in the office" }).querySelectorAll("li")).toHaveLength(11);
  });

  it("stays on the map and disables 3D when WebGL is missing, even with a saved 3D choice", async () => {
    setupBrowser({ webgl: false });
    window.localStorage.setItem(STORAGE_KEY, "3d");
    const AgentStage = await load();
    render(<AgentStage view={view} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "3D office" })).toBeDisabled());
    expect(screen.getByTestId("agent-map")).toBeInTheDocument();
    expect(screen.getByTestId("office-hint")).toHaveTextContent(/needs WebGL/);
  });

  it("starts on the map under reduced motion, and the 3D office can still be opened (and then stays still)", async () => {
    setupBrowser({ reducedMotion: true });
    const AgentStage = await load();
    render(<AgentStage view={view} />);
    await waitFor(() => expect(screen.getByTestId("office-hint")).toHaveTextContent(/less motion/));
    expect(screen.getByTestId("agent-map")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "3D office" }));
    const canvas = await screen.findByTestId("fake-canvas");
    expect(canvas).toHaveAttribute("data-reduced", "true");
  });

  it("starts on the map on a weak device (4 cores or fewer, or 4 GB or less)", async () => {
    for (const env of [{ cores: 4 }, { memory: 4 }]) {
      setupBrowser(env);
      const AgentStage = await load();
      const { unmount } = render(<AgentStage view={view} />);
      await waitFor(() => expect(screen.getByTestId("office-hint")).toHaveTextContent(/looks slow/));
      expect(screen.getByRole("button", { name: "Map" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "3D office" })).toBeEnabled();
      unmount();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("remembers the choice in localStorage and keeps working when storage is blocked", async () => {
    setupBrowser({ cores: 2 });
    const AgentStage = await load();
    render(<AgentStage view={view} />);
    await userEvent.click(await screen.findByRole("button", { name: "3D office" }));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("3d");
    await screen.findByTestId("fake-canvas");
    await userEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("map");
    expect(screen.getByTestId("agent-map")).toBeInTheDocument();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "3D office" }));
    });
    expect(await screen.findByTestId("fake-canvas")).toBeInTheDocument();
  });
});

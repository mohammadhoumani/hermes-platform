"use client";

/**
 * "Who is talking" in the project room: the 2D map or the 3D office, with a switch.
 *
 * The map is the default and is what the server sends. After the page loads we look at the browser (WebGL, reduced motion,
 * a weak device) and at the saved choice, and only then load the 3D chunk. While that chunk downloads, the map stays.
 */
import dynamic from "next/dynamic";
import { Component, createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AgentMap } from "@/components/room/agent-map";
import type { ViewState } from "@/lib/agent-events/types";
import { decideMode, type ModeDecision, type ViewMode } from "./capabilities";
import { useCapabilities, useDarkMode, useOfficeScene, useSavedMode } from "./hooks";
import { describeAgents } from "./scene-state";

const ViewContext = createContext<ViewState | null>(null);

/** Shown while the 3D code downloads. */
function MapWhileLoading() {
  const view = useContext(ViewContext);
  return view ? (
    <div data-testid="office-loading">
      <AgentMap view={view} />
    </div>
  ) : null;
}

const OfficeCanvas = dynamic(() => import("./office-canvas"), { ssr: false, loading: () => <MapWhileLoading /> });

/** If the 3D code throws (for example WebGL cannot start), tell the parent so it can show the map. */
class Boundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function OfficeView({ view, reduced, onCrash }: { view: ViewState; reduced: boolean; onCrash: () => void }) {
  const scene = useOfficeScene(view, !reduced);
  const dark = useDarkMode();
  const lines = useMemo(() => describeAgents(scene, view), [scene, view]);
  const noop = useCallback(() => undefined, []);
  return (
    <div data-testid="office">
      <ViewContext.Provider value={view}>
        <Boundary onError={onCrash}>
          <OfficeCanvas scene={scene} dark={dark} reduced={reduced} onReady={noop} onFail={onCrash} />
        </Boundary>
      </ViewContext.Provider>
      <p role="status" data-testid="office-live" className="sr-only">
        {scene.summary}
      </p>
      <ul aria-label="Who is doing what in the office" className="sr-only">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function hintFor(decision: ModeDecision | null, mode: ViewMode, crashed: boolean, reduced: boolean): string | null {
  if (crashed) return "The 3D office stopped working on this device, so the map is shown.";
  if (!decision) return null;
  if (decision.reason === "no-webgl") return "The 3D office needs WebGL, and this browser does not have it. The map is shown instead.";
  if (mode === "map" && decision.reason === "reduced-motion") return "The map is shown because your device asks for less motion. You can still open the 3D office. It will stay still.";
  if (mode === "map" && decision.reason === "low-end") return "The map is shown because this device looks slow. You can still open the 3D office.";
  if (mode === "3d" && reduced) return "Your device asks for less motion, so the 3D office stays still.";
  return null;
}

function Toggle({ mode, can3d, onPick }: { mode: ViewMode; can3d: boolean; onPick: (m: ViewMode) => void }) {
  const base = "min-h-9 rounded-lg px-3 text-sm font-semibold border transition-colors disabled:cursor-not-allowed disabled:opacity-60";
  const on = "bg-primary text-on-primary border-transparent";
  const off = "bg-surface text-fg border-line-strong hover:bg-surface-2";
  return (
    <div role="group" aria-label="View" className="flex gap-2">
      <button type="button" aria-pressed={mode === "3d"} disabled={!can3d} onClick={() => onPick("3d")} className={`${base} ${mode === "3d" ? on : off}`}>
        3D office
      </button>
      <button type="button" aria-pressed={mode === "map"} onClick={() => onPick("map")} className={`${base} ${mode === "map" ? on : off}`}>
        Map
      </button>
    </div>
  );
}

export function AgentStage({ view }: { view: ViewState }) {
  const caps = useCapabilities();
  const [saved, setSaved] = useSavedMode();
  const [crashed, setCrashed] = useState(false);

  const decision = caps ? decideMode(caps, saved) : null;
  const mode: ViewMode = crashed ? "map" : (decision?.mode ?? "map");
  const reduced = caps?.reducedMotion ?? false;
  const hint = hintFor(decision, mode, crashed, reduced);

  const pick = (next: ViewMode) => {
    setCrashed(false);
    setSaved(next);
  };

  return (
    <section aria-label="Who is talking" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-lg font-bold">Who is talking</h2>
        <Toggle mode={mode} can3d={decision?.can3d ?? true} onPick={pick} />
      </div>
      {hint ? (
        <p data-testid="office-hint" className="mb-3 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {mode === "3d" ? <OfficeView view={view} reduced={reduced} onCrash={() => setCrashed(true)} /> : <AgentMap view={view} />}
    </section>
  );
}

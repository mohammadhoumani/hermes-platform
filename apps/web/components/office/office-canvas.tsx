"use client";

/**
 * The 3D office. This whole file (and three.js with it) is loaded with next/dynamic and ssr: false from agent-stage.tsx,
 * so it never runs on the server and is not part of the first page load.
 *
 * Rendering is "on demand": a frame is drawn only when the scene changes, something moves, or a working agent pulses
 * (about 30 times a second). It stops completely when the tab is hidden or the canvas is scrolled out of view.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type RefObject } from "react";
import { MathUtils, type PerspectiveCamera } from "three";
import { buttonClass } from "@/components/ui/button";
import type { AgentId } from "@/lib/agent-events/types";
import { Animator, Desk, Figure, LightRig, MeetingTable, PacketFlight, PhaseSign, Rack, Shell, YouSpot } from "./parts";
import { BACKGROUND } from "./palette";
import { OverlayLayer, OverlayProjector, useRegistry, type LabelMode } from "./overlay";
import type { OfficeScene } from "./scene-state";

export type OfficeFailure = "lost" | "error";

export interface OfficeCanvasProps {
  scene: OfficeScene;
  dark: boolean;
  /** Reduced motion: a still scene (people jump instead of walking, nothing pulses or flies). */
  reduced: boolean;
  /** Called once the first frame is on screen. */
  onReady: () => void;
  /** Called when WebGL stops working, so the room can fall back to the map. */
  onFail: (why: OfficeFailure) => void;
}

const CANVAS_LABEL =
  "3D virtual office. One desk for each agent: Orchestrator, Business Analyst, Architect, Coder 1, Coder 2, Devin, Reviewer, QA and Release, " +
  "a GitHub server rack, a meeting table and your own spot. A text summary of what is happening is read out below.";

const FOV = 34;
const TARGET = { x: 0, y: 1.0, z: -0.5 };
const AZIMUTH_LIMIT = 0.6;
const DEFAULT_POLAR = 0.95;
const DISTANCE = { min: 9, max: 42 };
const DESK_IDS: AgentId[] = ["ba", "architect", "orchestrator", "reviewer", "qa", "coder1", "coder2", "devin", "release"];

type Controls = NonNullable<ComponentRef<typeof OrbitControls>>;

interface CameraApi {
  turn: (radians: number) => void;
  zoom: (factor: number) => void;
  reset: () => void;
}

/** How far back the camera must be to see the whole office at this shape of canvas. */
function fitDistance(aspect: number): number {
  const half = Math.tan(MathUtils.degToRad(FOV / 2));
  const forWidth = 13 / (half * aspect);
  const forHeight = 20.5;
  return MathUtils.clamp(Math.max(forWidth, forHeight), DISTANCE.min, DISTANCE.max);
}

function CameraRig({ apiRef, controlsRef }: { apiRef: RefObject<CameraApi | null>; controlsRef: RefObject<Controls | null> }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);

  const place = useCallback(
    (azimuth: number) => {
      const c = controlsRef.current;
      if (!c || height === 0) return;
      const d = fitDistance(width / height);
      c.target.set(TARGET.x, TARGET.y, TARGET.z);
      camera.position.set(
        TARGET.x + d * Math.sin(DEFAULT_POLAR) * Math.sin(azimuth),
        TARGET.y + d * Math.cos(DEFAULT_POLAR),
        TARGET.z + d * Math.sin(DEFAULT_POLAR) * Math.cos(azimuth),
      );
      c.update();
      invalidate();
    },
    [camera, controlsRef, width, height, invalidate],
  );

  // Fit the office to the canvas at the start and whenever the canvas changes shape.
  useEffect(() => {
    place(0);
  }, [place]);

  useEffect(() => {
    apiRef.current = {
      turn: (radians) => {
        const c = controlsRef.current;
        if (!c) return;
        c.setAzimuthalAngle(MathUtils.clamp(c.getAzimuthalAngle() + radians, -AZIMUTH_LIMIT, AZIMUTH_LIMIT));
        c.update();
        invalidate();
      },
      zoom: (factor) => {
        const c = controlsRef.current;
        if (!c) return;
        const t = c.target;
        const dx = camera.position.x - t.x;
        const dy = camera.position.y - t.y;
        const dz = camera.position.z - t.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const k = MathUtils.clamp(len * factor, DISTANCE.min, DISTANCE.max) / len;
        camera.position.set(t.x + dx * k, t.y + dy * k, t.z + dz * k);
        c.update();
        invalidate();
      },
      reset: () => place(0),
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, camera, controlsRef, invalidate, place]);

  // Panning is allowed (two fingers on a phone), but never far enough to lose the office.
  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    const keepClose = () => {
      c.target.x = MathUtils.clamp(c.target.x, -7, 7);
      c.target.z = MathUtils.clamp(c.target.z, -4, 5);
      c.target.y = TARGET.y;
    };
    c.addEventListener("change", keepClose);
    return () => c.removeEventListener("change", keepClose);
  }, [controlsRef]);

  return null;
}

/** Draws a frame again whenever something the scene depends on changes (frameloop is "demand"). */
function Redraw({ deps }: { deps: unknown[] }) {
  const invalidate = useThree((s) => s.invalidate);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => invalidate(), [invalidate, ...deps]);
  return null;
}

export default function OfficeCanvas({ scene, dark, reduced, onReady, onFail }: OfficeCanvasProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const controls = useRef<Controls>(null);
  const cameraApi = useRef<CameraApi | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  const [mode, setMode] = useState<LabelMode>("name");
  const readyRef = useRef(onReady);
  const failRef = useRef(onFail);
  useEffect(() => {
    readyRef.current = onReady;
    failRef.current = onFail;
  }, [onReady, onFail]);

  // Pause when the canvas is off screen or the tab is hidden.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let io: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => setOnScreen(entries.some((e) => e.isIntersecting)), { threshold: 0.01 });
      io.observe(el);
    }
    const onVisibility = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(([entry]) => {
          const w = entry?.contentRect.width ?? 999;
          setMode(w < 480 ? "short" : w < 760 ? "name" : "full");
        }) : undefined;
    ro?.observe(el);
    return () => {
      io?.disconnect();
      ro?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const active = onScreen && tabVisible;

  const registry = useRegistry();
  const byId = useMemo(() => new Map(scene.agents.map((a) => [a.id, a])), [scene.agents]);
  const alive = scene.rackActive || scene.agents.some((a) => a.visual === "working" || a.visual === "needs-you");

  return (
    <div ref={wrap} data-testid="office-3d" data-paused={active ? "no" : "yes"} data-reduced={reduced ? "yes" : "no"}>
      <div className="relative aspect-[10/9] w-full overflow-hidden rounded-xl border border-line sm:aspect-[64/45]">
        <Canvas
          flat
          frameloop={active ? "demand" : "never"}
          dpr={[1, 1.75]}
          camera={{ fov: FOV, near: 0.5, far: 140, position: [0, 16, 16] }}
          gl={{ antialias: true, powerPreference: "default" }}
          onCreated={({ gl }) => {
            const el = gl.domElement;
            el.setAttribute("role", "img");
            el.setAttribute("aria-label", CANVAS_LABEL);
            el.setAttribute("data-testid", "office-canvas");
            el.addEventListener("webglcontextlost", (event) => {
              event.preventDefault();
              failRef.current("lost");
            });
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                el.setAttribute("data-ready", "1");
                readyRef.current();
              }),
            );
          }}
        >
          <color attach="background" args={[dark ? BACKGROUND.dark : BACKGROUND.light]} />
          <LightRig phase={scene.phase} dark={dark} reduced={reduced} />
          <Animator alive={alive} reduced={reduced} />
          <Redraw deps={[scene, dark, reduced, mode, active]} />
          <group dispose={null}>
            <Shell />
            <PhaseSign phase={scene.phase} registry={registry} />
            {DESK_IDS.map((id) => (
              <Desk key={id} id={id} visual={byId.get(id)?.visual ?? "idle"} />
            ))}
            <YouSpot visual={byId.get("human")?.visual ?? "idle"} />
            <Rack active={scene.rackActive} status={scene.rackActive ? "working" : "idle"} reduced={reduced} registry={registry} />
            <MeetingTable meeting={scene.meeting} registry={registry} />
            {scene.agents
              .filter((a) => a.id !== "github")
              .map((a) => (
                <Figure key={a.id} agent={a} registry={registry} reduced={reduced} />
              ))}
            <PacketFlight packet={scene.packet} reduced={reduced} />
          </group>
          <OverlayProjector registry={registry} />
          <CameraRig apiRef={cameraApi} controlsRef={controls} />
          <OrbitControls
            ref={controls}
            makeDefault
            enableDamping={!reduced}
            dampingFactor={0.12}
            rotateSpeed={0.6}
            zoomSpeed={0.7}
            screenSpacePanning={false}
            minPolarAngle={0.45}
            maxPolarAngle={1.2}
            minAzimuthAngle={-AZIMUTH_LIMIT}
            maxAzimuthAngle={AZIMUTH_LIMIT}
            minDistance={DISTANCE.min}
            maxDistance={DISTANCE.max}
          />
        </Canvas>
        <OverlayLayer registry={registry} scene={scene} mode={mode} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-xs text-muted" aria-label="Colour key">
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-3 rounded-sm bg-primary" /> Green: working
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-3 rounded-sm bg-attn" /> Orange: needs you
          </li>
        </ul>
        <div role="group" aria-label="Camera" className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass("secondary", "min-h-9 px-3 text-xs")} onClick={() => cameraApi.current?.turn(-0.25)}>
            Turn left
          </button>
          <button type="button" className={buttonClass("secondary", "min-h-9 px-3 text-xs")} onClick={() => cameraApi.current?.turn(0.25)}>
            Turn right
          </button>
          <button type="button" className={buttonClass("secondary", "min-h-9 px-3 text-xs")} onClick={() => cameraApi.current?.zoom(0.8)}>
            Zoom in
          </button>
          <button type="button" className={buttonClass("secondary", "min-h-9 px-3 text-xs")} onClick={() => cameraApi.current?.zoom(1.25)}>
            Zoom out
          </button>
          <button type="button" className={buttonClass("secondary", "min-h-9 px-3 text-xs")} onClick={() => cameraApi.current?.reset()}>
            Reset view
          </button>
        </div>
      </div>
    </div>
  );
}

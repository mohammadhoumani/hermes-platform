"use client";

/**
 * Name labels, speech bubbles and the wall sign are plain HTML on top of the canvas (so they use the site's colour tokens
 * and work in both themes, and screen readers can ignore them: they are aria-hidden and a text summary exists).
 *
 * Why not drei's <Html>? Every <Html> opens its own React root, and in React 19 development mode that logs
 * "Attempted to synchronously unmount a root while React was already rendering" for each one. This small version keeps
 * one DOM layer, moves the elements with one transform per frame, and only when they have moved.
 */
import { useFrame } from "@react-three/fiber";
import { useState } from "react";
import { Vector3, type Camera, type Object3D } from "three";
import { AGENTS } from "@/lib/agent-events/roster";
import type { AgentId } from "@/lib/agent-events/types";
import type { Bubble, OfficeScene, Visual } from "./scene-state";

/** An agent id (the figure, or the rack for "github"), the meeting table, or the wall sign. */
export type AnchorKey = AgentId | "table" | "sign";

interface Entry {
  el: HTMLElement;
  anchor: AnchorKey;
  x: number;
  y: number;
  /** Width of the content, measured once, so it can be kept inside the canvas. */
  w: number;
}

/** Links 3D anchor points (empty groups in the scene) to the HTML elements that follow them. */
export class AnchorRegistry {
  private objects = new Map<AnchorKey, Object3D>();
  private entries = new Map<string, Entry>();

  setObject(key: AnchorKey, object: Object3D | null): void {
    if (object) this.objects.set(key, object);
    else this.objects.delete(key);
  }

  setElement(id: string, anchor: AnchorKey, el: HTMLElement | null): void {
    if (el) this.entries.set(id, { el, anchor, x: Number.NaN, y: Number.NaN, w: 0 });
    else this.entries.delete(id);
  }

  /** Move every element to where its anchor is on screen. Allocation free unless an element actually moved. */
  project(camera: Camera, width: number, height: number, v: Vector3): boolean {
    let moved = false;
    for (const e of this.entries.values()) {
      const obj = this.objects.get(e.anchor);
      if (!obj) continue;
      obj.updateWorldMatrix(true, false);
      v.setFromMatrixPosition(obj.matrixWorld).project(camera);
      const behind = v.z > 1;
      if (e.w === 0) e.w = e.el.firstElementChild instanceof HTMLElement ? e.el.firstElementChild.offsetWidth : 0;
      const half = e.w / 2 + 4;
      const rawX = Math.round((v.x * 0.5 + 0.5) * width);
      // keep labels and bubbles inside the canvas, even for people at the edge of the room
      const x = width > half * 2 ? Math.min(width - half, Math.max(half, rawX)) : rawX;
      const y = Math.round((-v.y * 0.5 + 0.5) * height);
      if (x !== e.x || y !== e.y) {
        e.x = x;
        e.y = y;
        e.el.style.transform = `translate3d(${x}px,${y}px,0)`;
        e.el.style.visibility = behind ? "hidden" : "visible";
        moved = true;
      }
    }
    return moved;
  }
}

export function useRegistry(): AnchorRegistry {
  const [registry] = useState(() => new AnchorRegistry());
  return registry;
}

/** Inside the Canvas: after every frame update, put the HTML where the 3D anchors are. */
export function OverlayProjector({ registry }: { registry: AnchorRegistry }) {
  const [v] = useState(() => new Vector3());
  useFrame(({ camera, size }) => {
    registry.project(camera, size.width, size.height, v);
  });
  return null;
}

// ---------------------------------------------------------------------------------------------

const LABEL_CLASS: Record<Visual, string> = {
  working: "bg-primary text-on-primary border-transparent",
  "needs-you": "bg-attn text-on-attn border-transparent",
  done: "bg-chip-working-bg text-chip-working-fg border-transparent",
  idle: "bg-surface text-fg border-line-strong",
};
const GLYPH: Record<Visual, string> = { working: "▶", "needs-you": "!", done: "✓", idle: "" };

/** How much a label says: short code (small screens), the name, or the name and what the agent is doing. */
export type LabelMode = "short" | "name" | "full";

export function Label({ name, visual, statusText, mode }: { name: string; visual: Visual; statusText: string; mode: LabelMode }) {
  return (
    <div
      data-office-label
      data-visual={visual}
      className={`-translate-x-1/2 -translate-y-1/2 flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-bold leading-4 shadow-sm ${LABEL_CLASS[visual]}`}
    >
      {GLYPH[visual] ? <span className="text-[9px]">{GLYPH[visual]}</span> : null}
      <span>{name}</span>
      {mode === "full" ? <span className="font-medium opacity-90">· {statusText}</span> : null}
    </div>
  );
}

export function SpeechBubble({ bubble }: { bubble: Bubble }) {
  const attention = bubble.tone === "attention";
  return (
    <div
      data-office-bubble
      data-tone={bubble.tone}
      className={`-translate-x-1/2 -translate-y-full -mt-6 relative w-max max-w-[10rem] rounded-xl border-2 px-2 py-1 text-[11px] font-semibold leading-snug shadow-md ${
        attention ? "border-attn bg-attn text-on-attn" : "border-line-strong bg-surface text-fg"
      }`}
    >
      {bubble.text}
      <span
        aria-hidden="true"
        className={`absolute left-1/2 top-full size-2.5 -translate-x-1/2 -translate-y-1.5 rotate-45 border-b-2 border-r-2 ${
          attention ? "border-attn bg-attn" : "border-line-strong bg-surface"
        }`}
      />
    </div>
  );
}

/** Shorter names for the labels, so neighbours do not cover each other. */
const LABEL_NAME: Partial<Record<AgentId, string>> = { ba: "BA" };

const SLOT = "pointer-events-none absolute left-0 top-0 select-none";

/** All the HTML of the scene: wall sign, one label per person, the rack and the table, and the speech bubbles. */
export function OverlayLayer({ registry, scene, mode }: { registry: AnchorRegistry; scene: OfficeScene; mode: LabelMode }) {
  const hidden = { visibility: "hidden" } as const;
  const rack = scene.rackActive;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div ref={(el) => registry.setElement("sign", "sign", el)} className={SLOT} style={hidden}>
        <div data-office-sign className="-translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-header px-2 py-0.5 text-xs font-bold text-on-header sm:text-sm">
          {scene.phase.text}
        </div>
      </div>
      {scene.agents.map((a) => (
        <div key={a.id} ref={(el) => registry.setElement(`label:${a.id}`, a.id, el)} className={SLOT} style={hidden}>
          {a.id === "github" ? (
            <Label name={mode === "short" ? "GH" : "GitHub"} visual={rack ? "working" : "idle"} statusText={rack ? "updating" : "code"} mode={mode} />
          ) : (
            <Label name={mode === "short" ? AGENTS[a.id].short : (LABEL_NAME[a.id] ?? a.name)} visual={a.visual} statusText={a.statusText} mode={mode} />
          )}
        </div>
      ))}
      {scene.meeting ? (
        <div ref={(el) => registry.setElement("meeting", "table", el)} className={SLOT} style={hidden}>
          <div
            data-office-meeting={scene.meeting.kind}
            className="-translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-transparent bg-primary px-2 py-0.5 text-[11px] font-bold text-on-primary shadow-sm"
          >
            {scene.meeting.kind === "review" ? "Code review" : "QA check"}
          </div>
        </div>
      ) : null}
      {(mode === "short" ? scene.bubbles.slice(0, 1) : scene.bubbles).map((b) => (
        <div key={`${b.agent}-${b.id}`} ref={(el) => registry.setElement(`bubble:${b.agent}`, b.agent, el)} className={`${SLOT} z-10`} style={hidden}>
          <SpeechBubble bubble={b} />
        </div>
      ))}
    </div>
  );
}

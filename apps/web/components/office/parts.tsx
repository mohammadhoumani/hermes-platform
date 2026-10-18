"use client";

/**
 * The pieces of the 3D office: desks, people, the server rack, the meeting table, the wall sign, lights, the flying packet.
 * Rules for this file: no allocation inside useFrame, only shared geometries and materials (kit.ts), and nothing keeps
 * the renderer busy when nothing moves (the canvas runs with frameloop="demand").
 */
import { useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Color, MathUtils, type AmbientLight, type DirectionalLight, type Group, type InstancedMesh, type Mesh, Object3D } from "three";
import { AGENTS, PHASES } from "@/lib/agent-events/roster";
import type { AgentId } from "@/lib/agent-events/types";
import { basic, blobShadow, floorRing, geo, glow, lambert, LIGHT } from "./kit";
import { DESK, FLOOR, MEETING_RADIUS, MEETING_TABLE, isBackRow, meetingStools } from "./layout";
import { COLORS, GREEN, PHASE_LIGHT, SHIRT } from "./palette";
import type { AnchorRegistry } from "./overlay";
import type { AgentScene, OfficeScene, Packet, Visual } from "./scene-state";

// ---------------------------------------------------------------------------------------------
// Static room

export const Shell = memo(function Shell() {
  const { width, depth } = FLOOR;
  return (
    <group>
      <mesh geometry={geo.box} material={lambert(COLORS.floor)} position={[0, -0.1, 0]} scale={[width, 0.2, depth]} />
      <mesh geometry={geo.box} material={lambert(COLORS.wall)} position={[0, 2.6, -depth / 2 - 0.1]} scale={[width + 0.4, 5.2, 0.2]} />
      <mesh geometry={geo.box} material={lambert(COLORS.wallDark)} position={[0, 0.15, -depth / 2 + 0.02]} scale={[width, 0.3, 0.06]} />
      {/* Two plants */}
      {[-8.9, 8.9].map((x) => (
        <group key={x} position={[x, 0, x < 0 ? -5.6 : 5.8]}>
          <mesh geometry={geo.cylinder} material={lambert(COLORS.deskLeg)} position={[0, 0.3, 0]} scale={[0.32, 0.6, 0.32]} />
          <mesh geometry={geo.sphere} material={lambert("#007763")} position={[0, 1.0, 0]} scale={[0.55, 0.5, 0.55]} />
          <mesh geometry={geo.sphere} material={lambert("#00AC90")} position={[0.12, 1.45, 0.05]} scale={[0.38, 0.34, 0.38]} />
        </group>
      ))}
    </group>
  );
});

/** The wall sign: which phase we are in, with six lamps. */
export const PhaseSign = memo(function PhaseSign({ phase, registry }: { phase: OfficeScene["phase"]; registry: AnchorRegistry }) {
  const z = -FLOOR.depth / 2 + 0.05;
  return (
    <group position={[0, 4.3, z]}>
      <mesh geometry={geo.box} material={lambert(COLORS.bezel)} scale={[7.4, 1.25, 0.12]} />
      {PHASES.map((p, i) => {
        const state = phase.index < 0 ? "todo" : i < phase.index ? "done" : i === phase.index ? "current" : "todo";
        const mat = glow[state === "current" ? "working" : state === "done" ? "done" : "idle"];
        return <mesh key={p.id} geometry={geo.box} material={mat} position={[-2.75 + i * 1.1, -0.4, 0.07]} scale={[0.9, 0.12, 0.04]} />;
      })}
      <group position={[0, 0.13, 0.09]} ref={(g) => registry.setObject("sign", g)} />
    </group>
  );
});

// ---------------------------------------------------------------------------------------------
// Desks

export const Desk = memo(function Desk({ id, visual }: { id: AgentId; visual: Visual }) {
  const d = DESK[id];
  const back = isBackRow(id);
  const top = lambert(COLORS.deskTop);
  const leg = lambert(COLORS.deskLeg);
  const chair = lambert(COLORS.chair);
  const bezel = lambert(COLORS.bezel);
  return (
    <group position={[d.x, 0, d.z]} rotation={[0, back ? Math.PI : 0, 0]}>
      <mesh geometry={geo.box} material={blobShadow} position={[0, 0.012, 0.55]} scale={[2.6, 0.01, 3.1]} />
      <mesh geometry={geo.box} material={top} position={[0, 0.75, 0]} scale={[2.1, 0.1, 1.05]} />
      <mesh geometry={geo.box} material={leg} position={[-0.95, 0.37, 0]} scale={[0.1, 0.74, 0.9]} />
      <mesh geometry={geo.box} material={leg} position={[0.95, 0.37, 0]} scale={[0.1, 0.74, 0.9]} />
      {/* monitor: the screen faces the worker (+z in the desk's own frame) */}
      <mesh geometry={geo.box} material={bezel} position={[0, 0.9, -0.28]} scale={[0.12, 0.2, 0.1]} />
      <mesh geometry={geo.box} material={bezel} position={[0, 1.22, -0.28]} scale={[0.96, 0.6, 0.06]} />
      <mesh geometry={geo.box} material={glow[visual]} position={[0, 1.22, -0.245]} scale={[0.84, 0.48, 0.02]} />
      <mesh geometry={geo.box} material={bezel} position={[0, 0.81, 0.18]} scale={[0.55, 0.03, 0.2]} />
      {/* a status strip on the edge that faces the camera, so the state is visible from every desk */}
      <mesh geometry={geo.box} material={glow[visual]} position={[0, 0.7, back ? -0.54 : 0.54]} scale={[2.1, 0.05, 0.04]} />
      {/* chair */}
      <mesh geometry={geo.cylinder} material={chair} position={[0, 0.25, 1.15]} scale={[0.07, 0.5, 0.07]} />
      <mesh geometry={geo.box} material={chair} position={[0, 0.5, 1.15]} scale={[0.72, 0.1, 0.72]} />
      <mesh geometry={geo.box} material={chair} position={[0, 0.98, 1.52]} scale={[0.72, 0.8, 0.08]} />
    </group>
  );
});

/** The "You" spot: a rug, a small table with a laptop, and a ring that turns rose when the user is needed. */
export const YouSpot = memo(function YouSpot({ visual }: { visual: Visual }) {
  const d = DESK.human;
  return (
    <group position={[d.x, 0, d.z]}>
      <mesh geometry={geo.cylinder} material={lambert(COLORS.rug)} position={[0, 0.012, 0.6]} scale={[2.3, 0.02, 2.3]} />
      <mesh geometry={geo.ring} material={floorRing[visual]} position={[0, 0.03, 0.6]} scale={[2.9, 1, 2.9]} />
      <mesh geometry={geo.box} material={lambert(COLORS.deskTop)} position={[0, 0.7, 0]} scale={[1.7, 0.1, 0.9]} />
      <mesh geometry={geo.box} material={lambert(COLORS.deskLeg)} position={[-0.7, 0.35, 0]} scale={[0.1, 0.7, 0.7]} />
      <mesh geometry={geo.box} material={lambert(COLORS.deskLeg)} position={[0.7, 0.35, 0]} scale={[0.1, 0.7, 0.7]} />
      <mesh geometry={geo.box} material={lambert(COLORS.bezel)} position={[0, 1.0, -0.1]} scale={[0.8, 0.5, 0.05]} />
      <mesh geometry={geo.box} material={glow[visual]} position={[0, 1.0, -0.07]} scale={[0.7, 0.4, 0.02]} />
      <mesh geometry={geo.box} material={lambert(COLORS.chair)} position={[0, 0.5, 1.15]} scale={[0.72, 0.1, 0.72]} />
      <mesh geometry={geo.box} material={lambert(COLORS.chair)} position={[0, 0.98, 1.52]} scale={[0.72, 0.8, 0.08]} />
    </group>
  );
});

// ---------------------------------------------------------------------------------------------
// People

const SPEED = 3.4;

function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

export const Figure = memo(function Figure({ agent, registry, reduced }: { agent: AgentScene; registry: AnchorRegistry; reduced: boolean }) {
  const group = useRef<Group>(null);
  const gem = useRef<Mesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const goal = useRef({ x: agent.target.x, z: agent.target.z, face: agent.face, placed: false });
  const phase = useRef(AGENTS[agent.id].short.charCodeAt(0) * 0.37);

  useEffect(() => {
    goal.current.x = agent.target.x;
    goal.current.z = agent.target.z;
    goal.current.face = agent.face;
    invalidate();
  }, [agent.target.x, agent.target.z, agent.face, invalidate]);

  useFrame((state, dt) => {
    const g = group.current;
    if (!g) return;
    const t = goal.current;
    if (!t.placed || reduced) {
      t.placed = true;
      g.position.set(t.x, 0, t.z);
      g.rotation.y = t.face;
    } else {
      const dx = t.x - g.position.x;
      const dz = t.z - g.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      let want = t.face;
      let busy = false;
      if (dist > 0.03) {
        const step = Math.min(dist, SPEED * dt * Math.min(1, 0.35 + dist));
        g.position.x += (dx / dist) * step;
        g.position.z += (dz / dist) * step;
        g.position.y = Math.abs(Math.sin(state.clock.elapsedTime * 11)) * 0.07;
        want = Math.atan2(dx, dz);
        busy = true;
      } else {
        g.position.y = 0;
      }
      const delta = wrapAngle(want - g.rotation.y);
      if (Math.abs(delta) > 0.01) {
        g.rotation.y += delta * (1 - Math.exp(-dt * 9));
        busy = true;
      }
      if (busy) state.invalidate();
    }
    const m = gem.current;
    if (m) {
      const time = state.clock.elapsedTime;
      m.position.y = 2.0 + (reduced ? 0 : Math.sin(time * 2 + phase.current) * 0.06);
      m.rotation.y = reduced ? 0.6 : time * 1.4 + phase.current;
    }
  });

  const id = agent.id;
  const shirt = lambert(SHIRT[id] ?? COLORS.chair);
  const skin = lambert(COLORS.skin);
  return (
    <group ref={group} dispose={null}>
      <mesh geometry={geo.ring} material={floorRing[agent.visual]} position={[0, 0.03, 0]} scale={[0.75, 1, 0.75]} />
      <mesh geometry={geo.cylinder} material={shirt} position={[0, 0.75, 0]} scale={[0.3, 0.9, 0.3]} />
      <mesh geometry={id === "devin" ? geo.box : geo.sphere} material={skin} position={[0, 1.46, 0]} scale={id === "devin" ? [0.4, 0.38, 0.4] : [0.24, 0.24, 0.24]} />
      {id === "reviewer" ? <mesh geometry={geo.box} material={lambert(COLORS.bezel)} position={[0, 1.5, 0.22]} scale={[0.38, 0.07, 0.06]} /> : null}
      {id === "devin" ? (
        <>
          <mesh geometry={geo.cylinder} material={lambert(COLORS.deskLeg)} position={[0, 1.8, 0]} scale={[0.02, 0.3, 0.02]} />
          <mesh geometry={geo.sphere} material={glow[agent.visual]} position={[0, 1.99, 0]} scale={[0.06, 0.06, 0.06]} />
        </>
      ) : null}
      {id === "orchestrator" ? <mesh geometry={geo.box} material={glow.working} position={[0, 1.0, 0.3]} scale={[0.08, 0.5, 0.02]} /> : null}
      <mesh ref={gem} geometry={geo.gem} material={glow[agent.visual]} position={[0, 2.0, 0]} scale={[0.15, 0.22, 0.15]} />
      <group position={[0, 2.5, 0]} ref={(g) => registry.setObject(agent.id, g)} />
    </group>
  );
});

// ---------------------------------------------------------------------------------------------
// The GitHub server rack

const LED_ROWS = 7;
const LED_COLS = 2;

export const Rack = memo(function Rack({ active, status, reduced, registry }: { active: boolean; status: Visual; reduced: boolean; registry: AnchorRegistry }) {
  const d = DESK.github;
  const leds = useRef<InstancedMesh>(null);
  const [tmp] = useState(() => new Object3D());
  const [on] = useState(() => new Color(GREEN));
  const [off] = useState(() => new Color("#504D62"));
  const lastTick = useRef(-1);

  useLayoutEffect(() => {
    const m = leds.current;
    if (!m) return;
    for (let r = 0; r < LED_ROWS; r++) {
      for (let c = 0; c < LED_COLS; c++) {
        tmp.position.set(-0.66, 0.55 + r * 0.38, -0.3 + c * 0.6);
        tmp.scale.set(0.04, 0.12, 0.3);
        tmp.updateMatrix();
        m.setMatrixAt(r * LED_COLS + c, tmp.matrix);
        m.setColorAt(r * LED_COLS + c, (r + c) % 3 === 0 ? on : off);
      }
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [tmp, on, off]);

  useFrame((state) => {
    const m = leds.current;
    if (!m || !active || reduced) return;
    const tick = Math.floor(state.clock.elapsedTime * 7);
    if (tick === lastTick.current) return;
    lastTick.current = tick;
    for (let i = 0; i < LED_ROWS * LED_COLS; i++) m.setColorAt(i, (i * 7 + tick * 5) % 5 < 3 ? on : off);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <group position={[d.x, 0, d.z]}>
      <mesh geometry={geo.box} material={blobShadow} position={[0, 0.012, 0]} scale={[2.2, 0.01, 2.2]} />
      <mesh geometry={geo.box} material={lambert(COLORS.rack)} position={[0, 1.6, 0]} scale={[1.3, 3.2, 1.6]} />
      <mesh geometry={geo.box} material={lambert(COLORS.rackPanel)} position={[-0.63, 1.6, 0]} scale={[0.08, 3.0, 1.45]} />
      <instancedMesh ref={leds} args={[geo.box, basic.snow, LED_ROWS * LED_COLS]} frustumCulled={false} />
      <mesh geometry={geo.ring} material={floorRing[status]} position={[-0.6, 0.03, 0]} scale={[1.5, 1, 1.5]} />
      <group position={[0, 3.6, 0]} ref={(g) => registry.setObject("github", g)} />
    </group>
  );
});

// ---------------------------------------------------------------------------------------------
// The meeting table

const STOOLS = meetingStools();

export const MeetingTable = memo(function MeetingTable({ meeting, registry }: { meeting: OfficeScene["meeting"]; registry: AnchorRegistry }) {
  const t = MEETING_TABLE;
  return (
    <group position={[t.x, 0, t.z]}>
      <mesh geometry={geo.cylinder} material={blobShadow} position={[0, 0.012, 0]} scale={[3.2, 0.01, 3.2]} />
      <mesh geometry={geo.cylinder} material={lambert(COLORS.deskLeg)} position={[0, 0.38, 0]} scale={[0.25, 0.76, 0.25]} />
      <mesh geometry={geo.cylinder} material={lambert(COLORS.deskTop)} position={[0, 0.8, 0]} scale={[MEETING_RADIUS, 0.1, MEETING_RADIUS]} />
      <mesh geometry={geo.ring} material={floorRing[meeting ? "working" : "idle"]} position={[0, 0.86, 0]} scale={[1.45, 1, 1.45]} />
      {STOOLS.map((s, i) => (
        <group key={i} position={[s.x - t.x, 0, s.z - t.z]}>
          <mesh geometry={geo.cylinder} material={lambert(COLORS.chair)} position={[0, 0.2, 0]} scale={[0.05, 0.4, 0.05]} />
          <mesh geometry={geo.cylinder} material={lambert(COLORS.chair)} position={[0, 0.42, 0]} scale={[0.3, 0.08, 0.3]} />
        </group>
      ))}
      <group position={[0, 1.0, 0]} ref={(g) => registry.setObject("table", g)} />
    </group>
  );
});

// ---------------------------------------------------------------------------------------------
// A packet that flies from one desk to another (a message or a handoff)

const FLIGHT_S = 1.25;

export function PacketFlight({ packet, reduced }: { packet: Packet | null; reduced: boolean }) {
  const mesh = useRef<Mesh>(null);
  const progress = useRef(1);
  const invalidate = useThree((s) => s.invalidate);
  const id = packet?.id ?? -1;

  useEffect(() => {
    progress.current = reduced || id < 0 ? 1 : 0;
    if (mesh.current) mesh.current.visible = progress.current < 1;
    invalidate();
  }, [id, reduced, invalidate]);

  useFrame((state, dt) => {
    const m = mesh.current;
    if (!m || !packet || progress.current >= 1) {
      if (m && m.visible) m.visible = false;
      return;
    }
    progress.current = Math.min(1, progress.current + dt / FLIGHT_S);
    const p = progress.current;
    const e = p * p * (3 - 2 * p);
    const a = DESK[packet.from];
    const b = DESK[packet.to];
    m.position.set(a.x + (b.x - a.x) * e, 1.7 + Math.sin(Math.PI * e) * 1.3, a.z + (b.z - a.z) * e);
    m.rotation.y = p * 6;
    m.visible = p < 1;
    state.invalidate();
  });

  return <mesh ref={mesh} visible={false} geometry={geo.box} material={packet?.to === "human" ? basic.packetToYou : basic.packet} scale={[0.34, 0.22, 0.05]} />;
}

// ---------------------------------------------------------------------------------------------
// Light, glow and animation clock

/** Pulses the two "alive" glow materials about 30 times a second, and only while something is alive. */
export function Animator({ alive, reduced }: { alive: boolean; reduced: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!alive || reduced) return;
    const t = setInterval(invalidate, 33);
    return () => clearInterval(t);
  }, [alive, reduced, invalidate]);

  useFrame((state) => {
    const k = reduced ? 0.9 : 0.72 + 0.28 * Math.sin(state.clock.elapsedTime * 3.2);
    glow.working.emissiveIntensity = k;
    glow["needs-you"].emissiveIntensity = k;
    floorRing.working.opacity = reduced ? 0.9 : 0.55 + 0.4 * k;
    floorRing["needs-you"].opacity = reduced ? 0.95 : 0.55 + 0.45 * k;
  });
  return null;
}

/** Lights tinted a little by the phase, fading to the new colour; dimmer in dark mode. */
export function LightRig({ phase, dark, reduced }: { phase: OfficeScene["phase"]; dark: boolean; reduced: boolean }) {
  const amb = useRef<AmbientLight>(null);
  const key = useRef<DirectionalLight>(null);
  const invalidate = useThree((s) => s.invalidate);
  const [tint] = useState(() => new Color());
  const goal = useRef({ ambient: 0.74 * LIGHT.ambientScale, key: LIGHT.keyIntensity, placed: false });

  useEffect(() => {
    const p = PHASE_LIGHT[phase.id ?? "none"];
    tint.set(p.color);
    goal.current.ambient = p.ambient * LIGHT.ambientScale * (dark ? LIGHT.darkFactor : 1);
    goal.current.key = LIGHT.keyIntensity * (dark ? LIGHT.darkFactor : 1);
    invalidate();
  }, [phase.id, dark, tint, invalidate]);

  useFrame((state, dt) => {
    const a = amb.current;
    const k = key.current;
    const g = goal.current;
    if (!a || !k) return;
    if (!g.placed || reduced) {
      g.placed = true;
      a.color.copy(tint);
      k.color.copy(tint);
      a.intensity = g.ambient;
      k.intensity = g.key;
      return;
    }
    const f = 1 - Math.exp(-dt * 3);
    a.color.lerp(tint, f);
    k.color.lerp(tint, f);
    a.intensity = MathUtils.lerp(a.intensity, g.ambient, f);
    k.intensity = MathUtils.lerp(k.intensity, g.key, f);
    if (Math.abs(a.intensity - g.ambient) > 0.002 || Math.abs(k.intensity - g.key) > 0.002) state.invalidate();
  });

  return (
    <>
      <ambientLight ref={amb} intensity={0.65} />
      <directionalLight ref={key} position={[-6, 12, 9]} intensity={1} />
    </>
  );
}

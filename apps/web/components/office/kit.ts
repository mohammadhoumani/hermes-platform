/**
 * Shared geometries and materials for the whole office. Everything is made once and reused, so a new frame or a new
 * event never creates GPU objects. Meshes size themselves with `scale`; the geometries below are unit sized.
 * This file only runs in the browser (the 3D chunk is loaded with ssr: false).
 */
import { BoxGeometry, CylinderGeometry, MeshBasicMaterial, MeshLambertMaterial, OctahedronGeometry, RingGeometry, SphereGeometry } from "three";
import type { Visual } from "./scene-state";
import { COLORS, GREEN, ROSE, SNOW } from "./palette";

export const geo = {
  box: new BoxGeometry(1, 1, 1),
  cylinder: new CylinderGeometry(1, 1, 1, 14),
  sphere: new SphereGeometry(1, 14, 10),
  gem: new OctahedronGeometry(1),
  /** A flat ring that lies on the floor. */
  ring: new RingGeometry(0.72, 0.9, 40).rotateX(-Math.PI / 2),
};

const lambertCache = new Map<string, MeshLambertMaterial>();

/** One matte material per colour. */
export function lambert(color: string): MeshLambertMaterial {
  let m = lambertCache.get(color);
  if (!m) {
    m = new MeshLambertMaterial({ color });
    lambertCache.set(color, m);
  }
  return m;
}

/** Screens and status lamps: a colour that glows. The two "alive" ones are pulsed by the Animator. */
function glowing(color: string, intensity: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, emissive: color, emissiveIntensity: intensity });
}

export const glow: Record<Visual, MeshLambertMaterial> = {
  working: glowing(GREEN, 0.9),
  "needs-you": glowing(ROSE, 0.9),
  done: glowing(COLORS.screenDone, 0.35),
  idle: glowing(COLORS.screenIdle, 0.08),
};

/** Flat rings on the floor under each figure and under the You spot. */
function ring(color: string, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
}

export const floorRing: Record<Visual, MeshBasicMaterial> = {
  working: ring(GREEN, 0.9),
  "needs-you": ring(ROSE, 0.95),
  done: ring(COLORS.screenDone, 0.55),
  idle: ring("#8D857E", 0.28),
};

export const blobShadow = new MeshBasicMaterial({ color: "#24213B", transparent: true, opacity: 0.09, depthWrite: false });

export const basic = {
  packet: new MeshBasicMaterial({ color: GREEN }),
  packetToYou: new MeshBasicMaterial({ color: ROSE }),
  rackOff: new MeshBasicMaterial({ color: "#504D62" }),
  snow: new MeshBasicMaterial({ color: SNOW }),
};

/** The ambient and key lights get their colour and strength from the phase and the theme. */
/** three.js lights divide by PI in the matte material, so the strengths below are multiplied by PI to read like plain 0..1 brightness. */
export const LIGHT = { keyIntensity: 0.45 * Math.PI, darkFactor: 0.62, ambientScale: Math.PI };

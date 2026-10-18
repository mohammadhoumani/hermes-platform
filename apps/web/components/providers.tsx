"use client";

import { MotionConfig } from "motion/react";

/** One place to switch motion off for people who asked their system for less movement. */
export function Providers({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

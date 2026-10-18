"use client";

import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { useState, type ReactNode } from "react";

/**
 * Small motion helpers. When the system asks for reduced motion, they render plain elements
 * with no animation at all (not even a fade).
 */

/**
 * Fades a block in. This is plain CSS (see .fade-in in globals.css), so server-rendered content is visible
 * straight away, nothing flashes, and it is switched off by prefers-reduced-motion.
 */
export function FadeIn({
  children,
  delay = 0,
  className = "",
  style,
  ...rest
}: { children: ReactNode; delay?: number } & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div className={`fade-in ${className}`.trim()} style={delay ? { ...style, animationDelay: `${delay}s` } : style} {...rest}>
      {children}
    </div>
  );
}

/**
 * Tells which keys appeared after the first render. Rows that were already there when the list was
 * first drawn must not animate (they are in the server HTML), only rows added later slide in.
 */
export function useIsNew(keys: readonly (string | number)[]): (key: string | number) => boolean {
  const [initial] = useState(() => new Set(keys));
  return (key) => !initial.has(key);
}

/** A list row. With fresh, it slides in; otherwise it simply appears. */
export function ListItem({
  children,
  fresh = false,
  ...rest
}: { children: ReactNode; fresh?: boolean } & Omit<HTMLMotionProps<"li">, "children" | "initial" | "animate" | "transition">) {
  const reduce = useReducedMotion();
  if (reduce || !fresh) return <li {...(rest as object)}>{children}</li>;
  return (
    <motion.li initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: "easeOut" }} {...rest}>
      {children}
    </motion.li>
  );
}

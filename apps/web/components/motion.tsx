"use client";

import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";

/**
 * Small motion helpers. When the system asks for reduced motion, they render plain elements
 * with no animation at all (not even a fade).
 */

export function FadeIn({
  children,
  delay = 0,
  y = 8,
  ...rest
}: { children: ReactNode; delay?: number; y?: number } & Omit<HTMLMotionProps<"div">, "children" | "initial" | "animate" | "transition">) {
  const reduce = useReducedMotion();
  if (reduce) return <div {...(rest as object)}>{children}</div>;
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay, ease: "easeOut" }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** A list row that slides in when it is added. */
export function ListItem({
  children,
  ...rest
}: { children: ReactNode } & Omit<HTMLMotionProps<"li">, "children" | "initial" | "animate" | "transition">) {
  const reduce = useReducedMotion();
  if (reduce) return <li {...(rest as object)}>{children}</li>;
  return (
    <motion.li initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: "easeOut" }} {...rest}>
      {children}
    </motion.li>
  );
}

/** Press feedback for buttons. */
export function usePressProps(): { whileTap?: { scale: number }; transition?: { duration: number } } {
  const reduce = useReducedMotion();
  return reduce ? {} : { whileTap: { scale: 0.97 }, transition: { duration: 0.08 } };
}

"use client";

import { motion } from "motion/react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { usePressProps } from "@/components/motion";

export type ButtonVariant = "primary" | "attention" | "secondary" | "ghost" | "danger";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary hover:bg-primary-hover border border-transparent",
  attention: "bg-attn text-on-attn hover:bg-attn-hover border border-transparent",
  secondary: "bg-surface text-fg border border-line-strong hover:bg-surface-2",
  ghost: "bg-transparent text-fg border border-transparent hover:bg-surface-2",
  danger: "bg-surface text-danger border border-line-strong hover:bg-surface-2",
};

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 select-none";

export function buttonClass(variant: ButtonVariant = "primary", extra = ""): string {
  return `${BASE} ${VARIANT[variant]} ${extra}`.trim();
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}

type ButtonProps = Omit<ComponentProps<typeof motion.button>, "children"> & {
  variant?: ButtonVariant;
  loading?: boolean;
  loadingText?: string;
  children?: ReactNode;
};

export function Button({ variant = "primary", loading = false, loadingText, children, className = "", disabled, type = "button", ...rest }: ButtonProps) {
  const press = usePressProps();
  return (
    <motion.button
      type={type}
      className={buttonClass(variant, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...press}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      <span>{loading && loadingText ? loadingText : children}</span>
    </motion.button>
  );
}

export function LinkButton({
  href,
  variant = "primary",
  className = "",
  children,
  ...rest
}: { href: string; variant?: ButtonVariant; className?: string; children: ReactNode } & Omit<ComponentProps<typeof Link>, "href" | "className">) {
  return (
    <Link href={href} className={buttonClass(variant, className)} {...rest}>
      {children}
    </Link>
  );
}

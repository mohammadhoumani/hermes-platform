"use client";

import { useState } from "react";
import { AutoIcon, MoonIcon, SunIcon } from "@/components/ui/icons";
import { nextTheme, parseTheme, themeAttribute, THEME_COOKIE, type ThemeChoice } from "@/lib/theme";

const LABEL: Record<ThemeChoice, string> = {
  system: "Theme: follows your device. Switch to light.",
  light: "Theme: light. Switch to dark.",
  dark: "Theme: dark. Switch to follow your device.",
};

function writeCookie(choice: ThemeChoice) {
  try {
    document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    /* cookies blocked: the choice lasts until the page reloads */
  }
}

export function ThemeToggle({ initial }: { initial: string }) {
  const [choice, setChoice] = useState<ThemeChoice>(parseTheme(initial));

  const click = () => {
    const next = nextTheme(choice);
    setChoice(next);
    writeCookie(next);
    const attr = themeAttribute(next);
    if (attr) document.documentElement.setAttribute("data-theme", attr);
    else document.documentElement.removeAttribute("data-theme");
  };

  const Icon = choice === "dark" ? MoonIcon : choice === "light" ? SunIcon : AutoIcon;
  return (
    <button
      type="button"
      onClick={click}
      aria-label={LABEL[choice]}
      title={LABEL[choice]}
      data-theme-choice={choice}
      className="inline-flex size-11 items-center justify-center rounded-xl border border-transparent text-current hover:bg-white/10 aria-[pressed=true]:bg-white/10"
    >
      <Icon />
    </button>
  );
}

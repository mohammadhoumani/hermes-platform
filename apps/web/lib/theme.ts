export type ThemeChoice = "system" | "light" | "dark";
export const THEME_COOKIE = "hermes-theme";

export function parseTheme(value: string | undefined | null): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

/** The value for <html data-theme>. "system" sets no attribute, so prefers-color-scheme decides. */
export function themeAttribute(choice: ThemeChoice): "light" | "dark" | undefined {
  return choice === "system" ? undefined : choice;
}

export function nextTheme(current: ThemeChoice): ThemeChoice {
  return current === "system" ? "light" : current === "light" ? "dark" : "system";
}

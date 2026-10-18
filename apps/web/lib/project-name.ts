/** Makes a short project name from the first words of an idea. */
export function suggestProjectName(idea: string): string {
  const words = idea
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  if (words.length === 0) return "New project";
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return name.length > 60 ? name.slice(0, 59).trimEnd() + "…" : name;
}

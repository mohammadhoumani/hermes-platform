/** Small pure text helpers used by the reducer. */

export const prKey = (n: string | number | null | undefined): string =>
  n === null || n === undefined || n === "" ? "" : "#" + String(n).replace("#", "");

export const branchIn = (s: string | undefined): string =>
  (String(s ?? "").match(/\b(?:feature|feat|fix|hotfix|chore|docs|task)\/[\w.\-/]+/) ?? [""])[0]!.replace(/[.,;:)]+$/, "");

export const prIn = (s: string | undefined): string => {
  const m = /#(\d+)/.exec(String(s ?? ""));
  return m ? "#" + m[1] : "";
};

/** Remove the note the bridge appends to website orders, so the feed shows only what the person wrote. */
export function cleanOrderText(text: string | undefined): string {
  return String(text ?? "")
    .replace(/\s*\(This order came from the (?:Agent Room|Hermes) website[\s\S]*$/i, "")
    .trim();
}

export function clip(text: string, n: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

const URL_RE = /https?:\/\/[^\s<>"')]+/;
export function firstUrl(text: string | undefined): string | undefined {
  const m = URL_RE.exec(String(text ?? ""));
  return m ? m[0].replace(/[.,;:]+$/, "") : undefined;
}

/** Only http(s) links are safe to show as links. */
export function safeHttpUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export const BRD_APPROVED_RE = /\b(?:approved the brd|brd (?:is )?approved|i approve the brd|approve[d]? (?:the )?brd)\b/i;
export const APPROVAL_ASK_RE = /\bapprov/i;

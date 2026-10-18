/** Short, friendly relative times. Pure: pass `now` in tests. */
export function timeAgo(iso: string | number | Date, now: number = Date.now()): string {
  const t = typeof iso === "number" ? iso : new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.round(mo / 12);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

export function clockTime(tsSeconds: number | undefined, locale?: string): string {
  if (tsSeconds === undefined || !Number.isFinite(tsSeconds)) return "";
  return new Date(tsSeconds * 1000).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

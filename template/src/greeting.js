// Starter module. Replace it with the real code from docs/PLAN.md.
export function greeting(name) {
  const clean = String(name ?? "").trim();
  return clean ? `Hello, ${clean}!` : "Hello!";
}

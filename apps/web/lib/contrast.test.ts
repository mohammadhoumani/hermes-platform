import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, luminance } from "./contrast";

const css = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

/** Take the declarations of the block that starts at `header` (first match), e.g. `:root {`. */
function blockAfter(header: string): Record<string, string> {
  const start = css.indexOf(header);
  if (start < 0) throw new Error(`Block not found: ${header}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const base = blockAfter(":root {");
const darkMedia = blockAfter(':root:not([data-theme="light"]) {');
const darkToggle = blockAfter(':root[data-theme="dark"] {');

function resolveTheme(overrides: Record<string, string>) {
  const all = { ...base, ...overrides };
  const get = (name: string, depth = 0): string => {
    if (depth > 8) throw new Error(`Token loop at ${name}`);
    const raw = all[name];
    if (!raw) throw new Error(`Unknown token ${name}`);
    const ref = /^var\((--[\w-]+)\)$/.exec(raw);
    return ref ? get(ref[1]!, depth + 1) : raw;
  };
  return get;
}

const light = resolveTheme({});
const dark = resolveTheme(darkToggle);

type Pair = [fg: string, bg: string, min: number, why: string];

/** Every foreground/background combination the UI uses. 4.5 for text, 3 for UI parts (borders, focus ring). */
const PAIRS: Pair[] = [
  ["--fg", "--canvas", 4.5, "body text"],
  ["--fg", "--surface", 4.5, "text on cards"],
  ["--fg", "--surface-2", 4.5, "text on soft surfaces"],
  ["--muted", "--canvas", 4.5, "secondary text"],
  ["--muted", "--surface", 4.5, "secondary text on cards"],
  ["--muted", "--surface-2", 4.5, "secondary text on soft surfaces"],
  ["--link", "--canvas", 4.5, "links and green text"],
  ["--link", "--surface", 4.5, "links on cards"],
  ["--link", "--surface-2", 4.5, "links on soft surfaces"],
  ["--danger", "--canvas", 4.5, "error text"],
  ["--danger", "--surface", 4.5, "error text on cards"],
  ["--danger", "--surface-2", 4.5, "error text on soft surfaces"],
  ["--on-primary", "--primary", 4.5, "text on green buttons"],
  ["--on-primary", "--primary-hover", 4.5, "text on hovered green buttons"],
  ["--on-attn", "--attn", 4.5, "text on rose (approval) buttons"],
  ["--on-attn", "--attn-hover", 4.5, "text on hovered rose buttons"],
  ["--on-header", "--header-bg", 4.5, "header text"],
  ["--chip-neutral-fg", "--chip-neutral-bg", 4.5, "neutral status chip"],
  ["--chip-working-fg", "--chip-working-bg", 4.5, "working status chip"],
  ["--chip-attention-fg", "--chip-attention-bg", 4.5, "attention status chip"],
  ["--chip-success-fg", "--chip-success-bg", 4.5, "success status chip"],
  ["--chip-danger-fg", "--chip-danger-bg", 4.5, "danger status chip"],
  ["--line-strong", "--canvas", 3, "form borders on the page"],
  ["--line-strong", "--surface", 3, "form borders on cards"],
  ["--focus", "--canvas", 3, "focus ring on the page"],
  ["--focus", "--surface", 3, "focus ring on cards"],
  ["--focus", "--surface-2", 3, "focus ring on soft surfaces"],
  ["--progress", "--canvas", 3, "progress bars and active step markers on the page"],
  ["--progress", "--surface", 3, "progress bars and active step markers on cards"],
  ["--progress", "--surface-2", 3, "progress bars and active step markers on soft surfaces"],
];

describe("brand palette", () => {
  it("matches docs/palette-reference.png", () => {
    expect(light("--steel-900").toUpperCase()).toBe("#24213B");
    expect(light("--green-500").toUpperCase()).toBe("#00CDAB");
    expect(light("--rose-500").toUpperCase()).toBe("#FFB64D");
    expect(light("--wafer-500").toUpperCase()).toBe("#E4D7CC");
    expect(light("--snow").toUpperCase()).toBe("#FFFFFF");
  });

  it("explains why the rules exist: brand green and rose fail as text on white", () => {
    expect(contrastRatio(light("--green-500"), light("--snow"))).toBeLessThan(2.5);
    expect(contrastRatio(light("--rose-500"), light("--snow"))).toBeLessThan(2.5);
  });

  it("has darker shades that work as text on Snow", () => {
    expect(contrastRatio(light("--green-700"), "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light("--rose-700"), "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light("--red-700"), "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
  });

  it("has a full 50 to 900 scale for every colour", () => {
    for (const name of ["steel", "green", "rose", "wafer", "red"]) {
      for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
        expect(base[`--${name}-${step}`], `${name}-${step}`).toMatch(/^#[0-9A-F]{6}$/i);
      }
    }
  });

  it("scales get darker from 50 to 900", () => {
    for (const name of ["steel", "green", "rose", "wafer", "red"]) {
      const lums = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((s) => luminance(base[`--${name}-${s}`]!));
      for (let i = 1; i < lums.length; i++) expect(lums[i]!).toBeLessThan(lums[i - 1]!);
    }
  });
});

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("WCAG AA contrast, %s theme", (_theme, get) => {
  it.each(PAIRS)("%s on %s is at least %s:1 (%s)", (fg, bg, min) => {
    const ratio = contrastRatio(get(fg), get(bg));
    expect(ratio, `${fg} ${get(fg)} on ${bg} ${get(bg)} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
  });
});

describe("theme blocks", () => {
  it("dark mode uses Steel Gray as the background and Snow as the text", () => {
    expect(dark("--canvas").toUpperCase()).toBe("#24213B");
    expect(dark("--fg").toUpperCase()).toBe("#FFFFFF");
  });

  it("the system dark block and the toggle dark block are identical", () => {
    expect(darkMedia).toEqual(darkToggle);
  });

  it("green is never used as text on a light background by the semantic tokens", () => {
    const linkLum = luminance(light("--link"));
    expect(linkLum).toBeLessThan(luminance(light("--green-500")));
    expect(light("--link").toUpperCase()).not.toBe(light("--green-500").toUpperCase());
  });
});

describe("contrast helpers", () => {
  it("knows black on white is 21:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });
  it("is symmetric", () => {
    expect(contrastRatio("#24213B", "#00CDAB")).toBeCloseTo(contrastRatio("#00CDAB", "#24213B"), 10);
  });
  it("rejects bad input", () => {
    expect(() => hexToRgb("blue")).toThrow();
  });
});

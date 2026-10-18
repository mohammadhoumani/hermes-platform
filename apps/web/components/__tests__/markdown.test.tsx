// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, safeMarkdownUrl } from "@/components/markdown";
import { FIXTURE_BRD } from "@/lib/backend/fixture-data";

describe("Markdown (agent text is untrusted)", () => {
  it("renders headings, tables and lists", () => {
    const { container } = render(<Markdown source={"# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- one\n- two"} />);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelectorAll("table td")).toHaveLength(2);
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("drops script tags, event handlers and images from the booby-trapped BRD", () => {
    const { container } = render(<Markdown source={FIXTURE_BRD} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror/i);
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    // the text of the unsafe link is still readable
    expect(container.textContent).toContain("Click for a surprise");
  });

  it("opens only http, https, mailto and in-page links, in a new tab for outside links", () => {
    const { container } = render(
      <Markdown source={"[web](https://example.test/a) [mail](mailto:a@example.test) [jump](#top) [bad](data:text/html;base64,AAAA) [worse](JaVaScRiPt:alert(1))"} />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.test/a", "mailto:a@example.test", "#top"]);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[2]?.getAttribute("target")).toBeNull();
  });

  it("shows image alt text instead of loading images", () => {
    const { container } = render(<Markdown source={"![a diagram](https://example.test/x.png)"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[a diagram]");
  });

  it("safeMarkdownUrl", () => {
    expect(safeMarkdownUrl(" https://a.test ")).toBe("https://a.test");
    expect(safeMarkdownUrl("javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrl("//evil.test")).toBe("");
    expect(safeMarkdownUrl("")).toBe("");
  });
});

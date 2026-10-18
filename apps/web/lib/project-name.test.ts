import { describe, expect, it } from "vitest";
import { suggestProjectName } from "./project-name";

describe("suggestProjectName", () => {
  it("uses the first words, capitalised", () => {
    expect(suggestProjectName("a page that converts miles to kilometres for runners")).toBe("A Page That Converts Miles");
  });
  it("drops punctuation", () => {
    expect(suggestProjectName("Build: a to-do list!!! please")).toBe("Build A To-do List Please");
  });
  it("falls back for empty or symbol-only ideas", () => {
    expect(suggestProjectName("   ")).toBe("New project");
    expect(suggestProjectName("!!!")).toBe("New project");
  });
  it("never goes over 60 characters", () => {
    expect(suggestProjectName("Supercalifragilisticexpialidocious ".repeat(5)).length).toBeLessThanOrEqual(60);
  });
});

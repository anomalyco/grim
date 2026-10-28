// Naming new notes: Untitled names, the first-line H1 → file name, and picking a free name.
import { describe, expect, test } from "bun:test";
import { autoNamePath, fileNameFromTitle, headingTitle, isUntitledPath, uniqueNotePath, untitledPath } from "../../src/shared/untitled.ts";

describe("untitled notes", () => {
  test("which names are untitled", () => {
    for (const p of ["Untitled.md", "Untitled 2.md", "a/b/Untitled 13.md"]) expect([p, isUntitledPath(p)]).toEqual([p, true]);
    for (const p of ["Untitled 1.md", "Untitled 02.md", "untitled.md", "Untitled.markdown", "Untitled 2 copy.md", "Notes.md", "Untitled/Plan.md"]) expect([p, isUntitledPath(p)]).toEqual([p, false]);
  });

  test("a free Untitled name", () => {
    expect(untitledPath([], "")).toBe("Untitled.md");
    expect(untitledPath(["Untitled.md"], "")).toBe("Untitled 2.md");
    expect(untitledPath(["Untitled.md", "Untitled 2.md", "sub/Untitled 3.md"], "")).toBe("Untitled 3.md");
    expect(untitledPath(["Untitled.md"], "sub/")).toBe("sub/Untitled.md");
  });

  test("the heading's plain text", () => {
    expect(headingTitle("# Trip plans")).toBe("Trip plans");
    expect(headingTitle("#   Spaced   out  ")).toBe("Spaced out");
    expect(headingTitle("# **Bold** and *italic* and `code` ##")).toBe("Bold and italic and code");
    expect(headingTitle("# A [link](https://x.y) and ![pic](p.png)")).toBe("A link and pic");
    expect(headingTitle("# ~~old~~ ==new== snake_case_name")).toBe("old new snake_case_name");
    expect(headingTitle("# <b>Tags</b>")).toBe("Tags");
    for (const l of ["#", "# ", "#    ", "## Section", "Plain", "#NoSpace", " # indented"]) expect([l, headingTitle(l)]).toEqual([l, null]);
  });

  test("file names from titles", () => {
    expect(fileNameFromTitle("Trip plans")).toBe("Trip plans");
    expect(fileNameFromTitle('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(fileNameFromTitle("tab\there\u0001x")).toBe("tab here x");
    expect(fileNameFromTitle("...hidden")).toBe("hidden");
    expect(fileNameFromTitle("x".repeat(100))).toBe("x".repeat(80));
    expect(fileNameFromTitle(" / : ")).toBeNull();
  });

  test("a free name, case-insensitively", () => {
    expect(uniqueNotePath(["Trip plans.md"], "", "Trip plans")).toBe("Trip plans 2.md");
    expect(uniqueNotePath(["trip plans.md", "Trip plans 2.md"], "", "Trip plans")).toBe("Trip plans 3.md");
    expect(uniqueNotePath(["Trip plans.md"], "sub/", "Trip plans")).toBe("sub/Trip plans.md");
  });

  test("the whole rule", () => {
    expect(autoNamePath("Untitled.md", "# Trip plans\n", ["Untitled.md"])).toBe("Trip plans.md");
    expect(autoNamePath("sub/Untitled 2.md", "# Trip plans\nmore", ["sub/Untitled 2.md", "sub/Trip plans.md"])).toBe("sub/Trip plans 2.md");
    expect(autoNamePath("Notes.md", "# Trip plans\n", [])).toBeNull();
    expect(autoNamePath("Untitled.md", "Trip plans\n", [])).toBeNull();
    expect(autoNamePath("Untitled.md", "#  \n", [])).toBeNull();
    expect(autoNamePath("Untitled.md", "", [])).toBeNull();
  });
});

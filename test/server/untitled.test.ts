// Naming new notes: Untitled names, the first-line H1 → file name, and picking a free name. The cases are the Mac
// app's (grimoire-native crates/app/src/files.rs, untitled_notes_get_their_heading_as_name): both follow one rule.
import { describe, expect, test } from "bun:test";
import { autoNamePath, headingTitle, isUntitledPath, TITLE_MAX, uniqueNotePath, untitledPath } from "../../src/shared/untitled.ts";

describe("untitled notes", () => {
  test("which names are untitled (the Mac's cases)", () => {
    for (const [n, yes] of [["Untitled.md", true], ["Untitled 2.md", true], ["Untitled 12.md", true], ["Untitled.MD", false], ["Untitled2.md", false], ["Untitled x.md", false], ["Notes.md", false], ["untitled.md", false]] as const) expect([n, isUntitledPath(n)]).toEqual([n, yes]);
    expect(isUntitledPath("a/b/Untitled 13.md")).toBe(true);
    expect(isUntitledPath("Untitled/Plan.md")).toBe(false);
  });

  test("a free Untitled name", () => {
    expect(untitledPath([], "")).toBe("Untitled.md");
    expect(untitledPath(["Untitled.md"], "")).toBe("Untitled 2.md");
    expect(untitledPath(["Untitled.md", "Untitled 2.md", "sub/Untitled 3.md"], "")).toBe("Untitled 3.md");
    expect(untitledPath(["Untitled.md"], "sub/")).toBe("sub/Untitled.md");
  });

  test("the heading → a file name (the Mac's cases)", () => {
    const t = headingTitle;
    expect(t("# Road trip\n\nbody")).toBe("Road trip");
    expect(t("#   Road   trip  ")).toBe("Road trip");
    expect(t("# **Bold** and _it_ and `code` ~~gone~~ ==hi==")).toBe("Bold and it and code gone hi");
    expect(t("# snake_case stays")).toBe("snake_case stays");
    expect(t("# See [the plan](plan.md) ![pic](a.png)")).toBe("See the plan pic");
    // * is an emphasis marker: dropped, also inside a word
    expect(t('# a/b\\c: d*e?f"g<h>i|j')).toBe("a b c de f g h i j");
    expect(t("# 1\\# not a heading")).toBe("1# not a heading");
    expect(t("# Closing ##")).toBe("Closing");
    expect(t("# ...hidden")).toBe("hidden");
    expect(t("# tab\there")).toBe("tab here");
    expect(t("# ctrl\u0001x")).toBe("ctrl x");
    expect(Array.from(t(`# ${"x".repeat(120)}`)!).length).toBe(TITLE_MAX);
    for (const none of ["#", "# ", "#  ##", "## Two", "#NoSpace", "Text\n# Later", "", "# **  **"]) expect([none, t(none)]).toEqual([none, null]);
  });

  test("a free name, case-insensitively", () => {
    expect(uniqueNotePath(["Trip plans.md"], "", "Trip plans")).toBe("Trip plans 2.md");
    expect(uniqueNotePath(["trip plans.md", "Trip plans 2.md"], "", "Trip plans")).toBe("Trip plans 3.md");
    expect(uniqueNotePath(["Trip plans.md"], "sub/", "Trip plans")).toBe("sub/Trip plans.md");
    expect(uniqueNotePath(["n/Trip.md", "n/Trip 2.md"], "n/", "Trip")).toBe("n/Trip 3.md");
    expect(uniqueNotePath([], "n/", "Plan")).toBe("n/Plan.md");
  });

  test("the whole rule", () => {
    expect(autoNamePath("Untitled.md", "# Trip plans\n", ["Untitled.md"])).toBe("Trip plans.md");
    expect(autoNamePath("sub/Untitled 2.md", "# Trip plans\nmore", ["sub/Untitled 2.md", "sub/Trip plans.md"])).toBe("sub/Trip plans 2.md");
    expect(autoNamePath("Notes.md", "# Trip plans\n", [])).toBeNull();
    expect(autoNamePath("Untitled.md", "Trip plans\n", [])).toBeNull();
    expect(autoNamePath("Untitled.md", "#  \n", [])).toBeNull();
    expect(autoNamePath("Untitled.md", "", [])).toBeNull();
    // a title that is itself an untitled name: not renamed ("Untitled draft" is fine)
    expect(autoNamePath("Untitled.md", "# Untitled\n", [])).toBeNull();
    expect(autoNamePath("Untitled 2.md", "# Untitled 7\n", [])).toBeNull();
    expect(autoNamePath("Untitled.md", "# Untitled draft\n", [])).toBe("Untitled draft.md");
    expect(autoNamePath("Untitled 1.md", "# One\n", [])).toBe("One.md");
  });
});

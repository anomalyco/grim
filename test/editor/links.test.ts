// Link targets (editor-rs/links.ts): where a clicked link goes; heading slugs; the links of a line view.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findHeading, headingSlug, lineLinks, linkTarget } from "../../src/client/editor-rs/links.ts";
import { toRLine } from "../../src/client/editor-rs/lineview.ts";
import { safeUrl } from "../../src/client/editor-rs/input.ts";

const ctx = { notePath: "notes/day.md", origin: "https://grimoire.exe.xyz" };
const t = (raw: string) => linkTarget(raw, ctx);
const note = (path: string, fragment: string | null = null) => ({ kind: "file" as const, path, note: true, fragment });

describe("link targets", () => {
  test("relative paths resolve against the note's folder", () => {
    expect(t("other.md")).toEqual(note("notes/other.md"));
    expect(t("./sub/plan.md")).toEqual(note("notes/sub/plan.md"));
    expect(t("../ideas.md")).toEqual(note("ideas.md"));
    expect(t("a/../b.md")).toEqual(note("notes/b.md"));
    expect(linkTarget("x.md", { notePath: "top.md" })).toEqual(note("x.md"));
  });

  test("no extension: a note (.md); other Markdown extensions kept", () => {
    expect(t("plan")).toEqual(note("notes/plan.md"));
    expect(t("../Big Plan")).toEqual(note("Big Plan.md"));
    expect(t("x.markdown")).toEqual(note("notes/x.markdown"));
    expect(t("x.MDX")).toEqual(note("notes/x.MDX"));
    expect(t(".hidden")).toEqual(note("notes/.hidden.md"));
  });

  test("percent-encoding, angle brackets, backslash escapes, query dropped", () => {
    expect(t("my%20plan.md")).toEqual(note("notes/my plan.md"));
    expect(t("<my plan.md>")).toEqual(note("notes/my plan.md"));
    expect(t("a\\(1\\).md")).toEqual(note("notes/a(1).md"));
    expect(t("x.md?raw=1")).toEqual(note("notes/x.md"));
    expect(t("bad%zz.md")).toEqual(note("notes/bad%zz.md"));
  });

  test("#fragment", () => {
    expect(t("plan.md#Next%20steps")).toEqual(note("notes/plan.md", "Next steps"));
    expect(t("plan#intro")).toEqual(note("notes/plan.md", "intro"));
    expect(t("#heading-slug")).toEqual({ kind: "heading", fragment: "heading-slug" });
    expect(t("#My%20Heading")).toEqual({ kind: "heading", fragment: "My Heading" });
    expect(t("#")).toEqual({ kind: "none" });
  });

  test("root-relative: from the notebook root", () => {
    expect(t("/folder/x.md")).toEqual(note("folder/x.md"));
    expect(t("/Welcome")).toEqual(note("Welcome.md"));
  });

  test("leaving the notebook", () => {
    expect(t("../../x.md")).toEqual({ kind: "outside", path: "../../x.md" });
    expect(t("/../x.md")).toEqual({ kind: "outside", path: "/../x.md" });
    expect(linkTarget("../x.md", { notePath: "top.md" }).kind).toBe("outside");
  });

  test("folders and empty paths: nothing", () => {
    expect(t("sub/").kind).toBe("none");
    expect(t("./").kind).toBe("none");
    expect(t("/").kind).toBe("none");
    expect(t("").kind).toBe("none");
    expect(t("  ").kind).toBe("none");
  });

  test("other files in the notebook", () => {
    expect(t("img/cat.png")).toEqual({ kind: "file", path: "notes/img/cat.png", note: false, fragment: null });
    expect(t("../report.pdf#page=2")).toEqual({ kind: "file", path: "report.pdf", note: false, fragment: "page=2" });
  });

  test("same-origin /app/ and old /r/ URLs open in the app", () => {
    expect(t("https://grimoire.exe.xyz/app/notes/Second.md#h")).toEqual({ kind: "app", url: "/app/notes/Second.md#h" });
    expect(t("https://grimoire.exe.xyz/app")).toEqual({ kind: "app", url: "/app" });
    expect(t("https://grimoire.exe.xyz/r/notes/a%20b.md?x=1")).toEqual({ kind: "app", url: "/app/notes/a%20b.md?x=1" });
    expect(t("https://grimoire.exe.xyz/start")).toEqual({ kind: "external", url: "https://grimoire.exe.xyz/start" });
    expect(t("https://other.example/app/x")).toEqual({ kind: "external", url: "https://other.example/app/x" });
    expect(t("http://grimoire.exe.xyz/app/x").kind).toBe("external");
  });

  test("external: http(s), mailto, protocol-relative, www.", () => {
    expect(t("https://example.com/a b")).toEqual({ kind: "external", url: "https://example.com/a%20b" });
    expect(t("HTTP://Example.com")).toEqual({ kind: "external", url: "http://example.com/" });
    expect(t("mailto:me@example.com")).toEqual({ kind: "external", url: "mailto:me@example.com" });
    expect(t("//example.com/x")).toEqual({ kind: "external", url: "https://example.com/x" });
    expect(t("www.example.com")).toEqual({ kind: "external", url: "https://www.example.com/" });
    expect(t("<https://example.com/x>")).toEqual({ kind: "external", url: "https://example.com/x" });
  });

  test("unsafe schemes: nothing (like safeUrl)", () => {
    for (const s of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "vbscript:x", "ftp://e.com/x", "https://e.com/\u0000x", "<javascript:alert(1)>"]) {
      expect(t(s)).toEqual({ kind: "none" });
      if (!s.includes("\0")) expect(safeUrl(s.replace(/^<|>$/g, ""))).toBeNull();
    }
  });
});

describe("headings", () => {
  test("GitHub-style slugs", () => {
    expect(headingSlug("Next steps")).toBe("next-steps");
    expect(headingSlug("What's new? (2026)")).toBe("whats-new-2026");
    expect(headingSlug("  Ünïcode — dash  ")).toBe("ünïcode--dash");
    expect(headingSlug("snake_case & more")).toBe("snake_case--more");
  });

  test("a fragment finds its heading by slug, repeats numbered, or by its text", () => {
    const hs = ["Intro", "Next steps", "Notes", "Notes", "What's new?"];
    expect(findHeading(hs, "intro")).toBe(0);
    expect(findHeading(hs, "next-steps")).toBe(1);
    expect(findHeading(hs, "Next steps")).toBe(1);
    expect(findHeading(hs, "NEXT-STEPS")).toBe(1);
    expect(findHeading(hs, "notes")).toBe(2);
    expect(findHeading(hs, "notes-1")).toBe(3);
    expect(findHeading(hs, "whats-new")).toBe(4);
    expect(findHeading(hs, "What's new?")).toBe(4);
    expect(findHeading(hs, "missing")).toBe(-1);
  });
});

const pkg = new URL("../../src/client/editor-rs/pkg/", import.meta.url);
const m = await import(new URL("editor_wasm.js", pkg).pathname);
m.initSync({ module: readFileSync(new URL("editor_wasm_bg.wasm", pkg)) });

describe("the links of a line view", () => {
  const linksOf = (md: string, caret = 0) => {
    const e = new m.Engine("x\n" + md);
    e.set_selection(caret, caret);
    const lv = e.render_all().lines.insert[1];
    e.free();
    return lineLinks(toRLine(lv, lv.text), lv.text);
  };

  test("text, destination, collapsed", () => {
    const md = "see [the **plan**](./plan%20x.md#Top) and [b](<my file.md>) end";
    const ls = linksOf(md);
    expect(ls.map((l) => [md.slice(l.textFrom, l.textTo), l.raw, l.collapsed, md.slice(l.from, l.to)])).toEqual([
      ["the **plan**", "./plan%20x.md#Top", true, "[the **plan**](./plan%20x.md#Top)"],
      ["b", "<my file.md>", true, "[b](<my file.md>)"],
    ]);
    // the caret in the first link reveals it
    expect(linksOf(md, 2 + 6).map((l) => l.collapsed)).toEqual([false, true]);
  });

  test("a linked image", () => {
    const md = "[![alt](i.png)](http://e.com)";
    const [l] = linksOf(md);
    expect([l!.raw, md.slice(l!.textFrom, l!.textTo), l!.collapsed]).toEqual(["http://e.com", "![alt](i.png)", true]);
  });
});

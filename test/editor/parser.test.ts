import { describe, expect, test } from "bun:test";
import { parseBlocks, parseInline, parseDoc, lineAt } from "../../src/client/editor/parser.ts";
import { lineSegments } from "../../src/client/editor/render.ts";

function inl(s: string) {
  return parseInline(s, 0, s.length).elements.map((e) => [e.type, s.slice(e.from, e.to)]);
}

describe("block pass", () => {
  test("block types and tokens", () => {
    const text = [
      "# Title",
      "### Third",
      "- bullet",
      "* star",
      "- [ ] todo",
      "- [x] done",
      "12. twelve",
      "> quote",
      "---",
      "plain",
      "\t- nested",
      "#tag not heading",
      "-not bullet",
      ">noquote",
    ].join("\n");
    const lines = parseBlocks(text);
    expect(lines.map((l) => l.type)).toEqual([
      "heading",
      "heading",
      "bullet",
      "bullet",
      "todo",
      "todo",
      "numbered",
      "quote",
      "hr",
      "paragraph",
      "bullet",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    expect(lines[0]!.level).toBe(1);
    expect(lines[1]!.level).toBe(3);
    expect(lines[4]!.checked).toBe(false);
    expect(lines[5]!.checked).toBe(true);
    expect(lines[6]!.number).toBe(12);
    expect(text.slice(lines[6]!.from, lines[6]!.textFrom)).toBe("12. ");
    expect(lines[10]!.indent).toBe(1);
    expect(lines[10]!.tokens.map((t) => t.kind)).toEqual(["indent", "bullet"]);
    expect(text.slice(lines[4]!.textFrom, lines[4]!.to)).toBe("todo");
  });

  test("fenced code", () => {
    const text = "a\n```js\nlet x = **1**\n- no\n```\nb";
    const lines = parseBlocks(text);
    expect(lines.map((l) => l.type)).toEqual(["paragraph", "fence", "code", "code", "fence", "paragraph"]);
    expect(lines[2]!.inline).toEqual([]);
    expect(lines[2]!.blockStart).toBe(1);
    expect(lines[2]!.blockEnd).toBe(4);
    expect(lines[5]!.blockStart).toBe(-1);
  });

  test("unclosed fence runs to the end", () => {
    const lines = parseBlocks("```\ncode\nmore");
    expect(lines.map((l) => l.type)).toEqual(["fence", "code", "code"]);
    expect(lines[0]!.blockEnd).toBe(2);
  });

  test("lineAt", () => {
    const d = parseDoc("ab\ncd\n");
    expect(lineAt(d.lines, 0)).toBe(0);
    expect(lineAt(d.lines, 2)).toBe(0);
    expect(lineAt(d.lines, 3)).toBe(1);
    expect(lineAt(d.lines, 6)).toBe(2);
  });
});

describe("inline pass", () => {
  test("basic emphasis", () => {
    expect(inl("**b**")).toEqual([["bold", "**b**"]]);
    expect(inl("*i*")).toEqual([["italic", "*i*"]]);
    expect(inl("_i_")).toEqual([["italic", "_i_"]]);
    expect(inl("~~s~~")).toEqual([["strike", "~~s~~"]]);
    expect(inl("~u~")).toEqual([["underline", "~u~"]]);
    expect(inl("==h==")).toEqual([["highlight", "==h=="]]);
    expect(inl("`c`")).toEqual([["code", "`c`"]]);
  });

  test("Bear partial parse: **abc* is a literal * plus italic", () => {
    const s = "**abc*";
    const els = parseInline(s, 0, s.length).elements;
    expect(els.length).toBe(1);
    expect(els[0]!.type).toBe("italic");
    expect(els[0]!.from).toBe(1);
    expect(inl("**abc**")).toEqual([["bold", "**abc**"]]);
    expect(inl("**abc")).toEqual([]);
  });

  test("bold-italic and nesting", () => {
    expect(inl("***x***").map((e) => e[0]).sort()).toEqual(["bold", "italic"]);
    const s = "**bold *nested* inside**";
    expect(inl(s)).toEqual([
      ["bold", s],
      ["italic", "*nested*"],
    ]);
  });

  test("no emphasis across whitespace / intraword underscore", () => {
    expect(inl("a * b * c")).toEqual([]);
    expect(inl("snake_case_name")).toEqual([]);
  });

  test("code span hides markers inside", () => {
    expect(inl("`**x**` y")).toEqual([["code", "`**x**`"]]);
  });

  test("links", () => {
    const s = "see [the *site*](http://x.y) now";
    const els = parseInline(s, 0, s.length).elements;
    const link = els.find((e) => e.type === "link")!;
    expect(s.slice(link.from, link.to)).toBe("[the *site*](http://x.y)");
    expect(s.slice(link.url![0], link.url![1])).toBe("http://x.y");
    expect(link.markers.map((m) => s.slice(m[0], m[1]))).toEqual(["[", "](", ")"]);
    expect(els.some((e) => e.type === "italic")).toBe(true);
    expect(inl("[a](http://x.y")).toEqual([]);
  });

  test("tags", () => {
    expect(inl("#tag and #two/sub x#no #1")).toEqual([
      ["tag", "#tag"],
      ["tag", "#two/sub"],
    ]);
  });

  test("escapes", () => {
    const s = "\\*x\\*";
    const r = parseInline(s, 0, s.length);
    expect(r.elements).toEqual([]);
    expect(r.escapes).toEqual([0, 3]);
  });
});

describe("segments", () => {
  test("markers, text, tokens", () => {
    const d = parseDoc("- a **b** [l](u)");
    const segs = lineSegments(d.lines[0]!);
    expect(segs.map((s) => [s.kind, d.text.slice(s.from, s.to)])).toEqual([
      ["token", "- "],
      ["text", "a "],
      ["mk", "**"],
      ["text", "b"],
      ["mk", "**"],
      ["text", " "],
      ["mk", "["],
      ["text", "l"],
      ["mk", "]("],
      ["chip", "u"],
      ["mk", ")"],
    ]);
    expect(segs[3]!.cls).toEqual(["b"]);
  });
});

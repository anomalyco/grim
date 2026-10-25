import { describe, expect, test } from "bun:test";
import { parseBlocks, parseInline, parseDoc, lineAt, literalLine } from "../../src/client/editor/parser.ts";
import { safeUrl } from "../../src/client/editor/input.ts";
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

  test("CommonMark flanking and the rule of 3 (Bear)", () => {
    // fdel.into-bold: "a*bold**" stays literal; bs.at-bold-start: "a *bold**" is italic + literal *
    expect(inl("a*bold** b")).toEqual([]);
    expect(inl("a *bold** b")).toEqual([["italic", "*bold*"]]);
    // typing.after-bold-edge
    expect(inl("a **bold*W*Q b")).toEqual([["italic", "*W*"]]);
    // underscores: intraword is not emphasis
    expect(inl("_ab_ c")).toEqual([["italic", "_ab_"]]);
    expect(inl("__a_")).toEqual([["italic", "_a_"]]);
    expect(inl("__a__")).toEqual([["bold", "__a__"]]);
    expect(inl("__a__x")).toEqual([]);
    expect(inl("**bold**,")).toEqual([["bold", "**bold**"]]);
  });

  test("emphasis spans the soft line breaks of a paragraph", () => {
    const d = parseDoc("a **bold \ntext** b\n\n**x\ny**");
    expect(d.lines[0]!.inline.map((e) => e.type)).toEqual(["bold"]);
    expect(d.lines[1]!.inline).toBe(d.lines[0]!.inline.length ? d.lines[1]!.inline : []);
    expect(d.lines[1]!.inline[0]).toBe(d.lines[0]!.inline[0]!);
    expect(d.lines[2]!.inline).toEqual([]);
    expect(d.lines[3]!.inline.length).toBe(1);
    // list items don't join
    expect(parseDoc("- **a\n- b**").lines[0]!.inline).toEqual([]);
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

  test("balanced parens in URLs", () => {
    const s = "[w](https://en.wikipedia.org/wiki/A_(b)) x";
    const link = parseInline(s, 0, s.length).elements.find((e) => e.type === "link")!;
    expect(s.slice(link.url![0], link.url![1])).toBe("https://en.wikipedia.org/wiki/A_(b)");
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

describe("literal lines", () => {
  test("a converted line shown literally", () => {
    const d = parseDoc("\t- **a**");
    const l = literalLine(d.text, d.lines[0]!);
    expect(l.type).toBe("paragraph");
    expect(l.tokens.map((t) => t.kind)).toEqual(["indent"]);
    expect(l.textFrom).toBe(1);
    expect(l.inline.map((e) => e.type)).toEqual(["bold"]);
  });
});

describe("safeUrl", () => {
  test("only http(s) and mailto", () => {
    expect(safeUrl("https://x.y/a")).toBe("https://x.y/a");
    expect(safeUrl("example.com")).toBe("https://example.com/");
    expect(safeUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,x")).toBeNull();
  });
});

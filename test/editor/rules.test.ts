import { describe, expect, test } from "bun:test";
import { parseDoc } from "../../src/client/editor/parser.ts";
import * as R from "../../src/client/editor/rules.ts";
import type { Sel } from "../../src/client/editor/units.ts";

/** Parse "text with | caret" or "[sel]" markup. */
function st(s: string): { text: string; sel: Sel } {
  if (s.includes("|")) {
    const i = s.indexOf("|");
    return { text: s.slice(0, i) + s.slice(i + 1), sel: { anchor: i, head: i } };
  }
  const a = s.indexOf("[[");
  const b = s.indexOf("]]") - 2;
  return { text: s.replace("[[", "").replace("]]", ""), sel: { anchor: a, head: b } };
}

function show(text: string, e: R.Edit | null): string {
  if (!e) return "null";
  let out = R.applyChanges(text, e.changes);
  while (e.then) {
    e = e.then;
    out = R.applyChanges(out, e.changes);
  }
  const { anchor, head } = e.sel;
  if (anchor === head) return out.slice(0, head) + "|" + out.slice(head);
  const a = Math.min(anchor, head);
  const b = Math.max(anchor, head);
  return out.slice(0, a) + "[[" + out.slice(a, b) + "]]" + out.slice(b);
}

function run(s: string, f: (d: ReturnType<typeof parseDoc>, sel: Sel) => R.Edit | null): string {
  const { text, sel } = st(s);
  return show(text, f(parseDoc(text), sel));
}

describe("typing and conversions", () => {
  test("plain insert", () => {
    expect(run("ab|", (d, s) => R.insertText(d, s, "c"))).toBe("abc|");
    expect(run("a[[bc]]d", (d, s) => R.insertText(d, s, "x"))).toBe("ax|d");
  });
  test("conversions are flagged", () => {
    const kind = (s: string, t: string) => {
      const { text, sel } = st(s);
      const e = R.insertText(parseDoc(text), sel, t);
      return e.converts ? "convert" : (e.then?.kind ?? e.kind);
    };
    const from = (s: string, t: string) => {
      const { text, sel } = st(s);
      return R.insertText(parseDoc(text), sel, t).converts;
    };
    expect(kind("-|", " ")).toBe("convert");
    expect(kind("#|", " ")).toBe("convert");
    expect(kind("####|", " ")).toBe("convert");
    expect(kind("1.|", " ")).toBe("convert");
    expect(kind("--|", "-")).toBe("convert");
    expect(kind("- [ ]|", " ")).toBe("convert");
    expect(kind("#|existing", " ")).toBe("convert");
    expect(kind("ab|", " ")).toBe("input");
    expect(kind("# #|", " ")).toBe("input");
    expect(from("- [ ]|", " ")).toBe("bullet");
    expect(from("-|", " ")).toBe("paragraph");
  });
  test("conversions never write escapes into the text", () => {
    const { text, sel } = st("x\n-|");
    const e = R.insertText(parseDoc(text), sel, " ");
    expect(R.applyChanges(text, e.changes)).toBe("x\n- ");
    expect(e.converts).toBe("paragraph");
    expect(e.then).toBeUndefined();
    expect(run("1.|", (d, s) => R.insertText(d, s, " "))).toBe("1. |");
    expect(run("- [ ]|", (d, s) => R.insertText(d, s, " "))).toBe("- [ ] |");
    expect(run("--|", (d, s) => R.insertText(d, s, "-"))).toBe("---|");
  });
  test("> types a literal > first, then the space as a separate convert step", () => {
    const { text, sel } = st("|");
    const e = R.insertText(parseDoc(text), sel, ">");
    expect(R.applyChanges(text, e.changes)).toBe(">");
    expect(parseDoc(">").lines[0]!.type).toBe("paragraph");
    expect(e.then!.kind).toBe("convert");
  });
  test("> converts immediately", () => {
    expect(run("|", (d, s) => R.insertText(d, s, ">"))).toBe("> |");
    expect(run("a|", (d, s) => R.insertText(d, s, ">"))).toBe("a>|");
  });
  test("paste normalizes newlines", () => {
    const { text, sel } = st("x|");
    const e = R.paste(parseDoc(text), sel, "a\r\nb");
    expect(show(text, e)).toBe("xa\nb|");
    expect(e.kind).toBe("paste");
  });
});

describe("Enter", () => {
  const enter = (s: string) => run(s, R.insertParagraph);
  test("list continuation", () => {
    expect(enter("- one|")).toBe("- one\n- |");
    expect(enter("* one|")).toBe("* one\n* |");
    expect(enter("- [x] one|")).toBe("- [x] one\n- [ ] |");
    expect(enter("1. one|")).toBe("1. one\n2. |");
    expect(enter("> q|")).toBe("> q\n> |");
    expect(enter("\t- one|")).toBe("\t- one\n\t- |");
  });
  test("empty item exits", () => {
    expect(enter("- a\n- |")).toBe("- a\n|");
    expect(enter("> |")).toBe("|");
    expect(enter("\t- |")).toBe("|");
  });
  test("split bullet and heading", () => {
    expect(enter("- ab|cd")).toBe("- ab\n- |cd");
    expect(enter("# ab|cd")).toBe("# ab\n|cd");
    expect(enter("# abcd|")).toBe("# abcd\n|");
  });
  test("at text start inserts above", () => {
    expect(enter("- |abc")).toBe("- \n- |abc");
    expect(enter("# |abc")).toBe("\n# |abc");
    expect(enter("|- abc")).toBe("\n|- abc");
  });
  test("code block: literal newline, no indent", () => {
    expect(enter("```\n  ind|\n```")).toBe("```\n  ind\n|\n```");
    expect(enter("```\n  x\n```|\nafter")).toBe("```\n  x\n```\n|\nafter");
  });
  test("opening fence of an unclosed block auto-closes", () => {
    expect(enter("```|")).toBe("```\n|\n```");
    expect(enter("x\n```js|")).toBe("x\n```js\n|\n```");
    expect(enter("```|\ncode\n```")).toBe("```\n|\ncode\n```");
    // closing fence typed above an older unclosed fence (Bear's raw result)
    expect(enter("```\ncode\n```|\n```")).toBe("```\ncode\n```\n|\n```\n```");
  });
  test("with selection", () => {
    expect(enter("- a[[bc]]d")).toBe("- a\n- |d");
  });
  test("selection covering the item text splits instead of exiting", () => {
    expect(enter("- [[abc]]\nx")).toBe("- \n- |\nx");
    expect(enter("- |\nx")).toBe("|\nx");
  });
  test("between indent tokens: empty line above", () => {
    expect(enter("\t|\t- a")).toBe("\n\t|\t- a");
  });
  test("empty heading strips the token", () => {
    expect(enter("## |")).toBe("|");
  });
  test("all heading text selected: splits", () => {
    expect(enter("## [[abc]]\nx")).toBe("## \n|\nx");
  });
});

describe("Backspace / Delete", () => {
  const bs = (s: string) => run(s, R.deleteBackward);
  const del = (s: string) => run(s, R.deleteForward);
  test("token removal at text start", () => {
    expect(bs("# |Head")).toBe("|Head");
    expect(bs("- |item")).toBe("|item");
    expect(bs("2. |two")).toBe("|two");
    expect(bs("> |q")).toBe("|q");
    expect(bs("- [ ] |t")).toBe("|t");
    expect(bs("\t- |n")).toBe("\t|n");
  });
  test("raw joins", () => {
    expect(bs("- one\n|two")).toBe("- one|two");
    expect(bs("1. first\n|second")).toBe("1. first|second");
    expect(bs("**b*|*")).toBe("**b|*");
  });
  test("forward delete", () => {
    expect(del("- alpha beta|\n- second")).toBe("- alpha beta|- second");
    expect(del("|- x")).toBe("|x");
  });
  test("surrogate pairs and escapes are one unit", () => {
    expect(bs("a😀|")).toBe("a|");
    expect(bs("\\*|")).toBe("|");
  });
  test("option-backspace uses Option-Left boundaries", () => {
    expect(run("word **|tail", R.deleteWordBackward)).toBe("|tail");
    expect(run("hello world|", R.deleteWordBackward)).toBe("hello |");
    expect(run("(safe to delete)\n|tail", R.deleteWordBackward)).toBe("(safe to |tail");
    expect(run("a|, b c", R.deleteWordForward)).toBe("a| c");
    // link URLs are atomic: never partially deleted
    expect(run("see [a](https://x.y/z) |", R.deleteWordBackward)).toBe("see [|");
    expect(run("[a](|https://x.y)", R.deleteWordForward)).toBe("[a](|");
  });
  test("horizontal rule", () => {
    // Backspace after the rule removes the token and leaves an empty line
    expect(bs("---|\nb")).toBe("|\nb");
    expect(bs("a\n---|\nb")).toBe("a\n|\nb");
    // Forward Delete at the end of the previous line deletes only the newline
    expect(del("a|\n---")).toBe("a|---");
    // Backspace at the start of the next line joins raw
    expect(bs("---\n|b")).toBe("---|b");
  });
  test("forward delete at line end joins the next line raw", () => {
    expect(del("a|\n# b")).toBe("a|# b");
  });
  test("forward delete before heading token removes one #", () => {
    expect(del("para\n|## Head")).toBe("para\n|# Head");
    expect(del("para\n|# Head")).toBe("para\n|Head");
  });
  test("cmd-backspace", () => {
    expect(run("- abc|", R.deleteToLineStart)).toBe("- |");
    expect(run("- |", R.deleteToLineStart)).toBe("|");
  });
});

describe("Tab", () => {
  const tab = (s: string, shift = false) => run(s, (d, sel) => R.tab(d, sel, shift));
  test("nests at list text start, at most one deeper than above", () => {
    expect(tab("- a\n- |b")).toBe("- a\n\t- |b");
    expect(tab("- a\n\t- |b")).toBe("- a\n\t- |b");
    expect(tab("- |a")).toBe("- |a");
  });
  test("tab at column 0 of a list item uses the nesting rule", () => {
    expect(tab("- a\n|- b")).toBe("- a\n\t|- b");
    expect(tab("- a\n\t|- b")).toBe("- a\n\t|- b");
  });
  test("space-indented lists: Tab/Shift-Tab use the line's unit", () => {
    expect(tab("- a\n  - b\n  - |c")).toBe("- a\n  - b\n    - |c");
    expect(tab("- a\n  - |b", true)).toBe("- a\n- |b");
    expect(tab("- a\n    - b\n    - |c")).toBe("- a\n    - b\n        - |c");
    expect(tab("- a\n    - |b", true)).toBe("- a\n- |b");
    // an unindented item under a space-indented one takes that unit
    expect(tab("- a\n  - b\n- |c")).toBe("- a\n  - b\n  - |c");
    expect(tab("- a\n\t- |b", true)).toBe("- a\n- |b");
  });
  test("space-indented lists: Enter keeps the raw indentation", () => {
    expect(run("- a\n  - b|", R.insertParagraph)).toBe("- a\n  - b\n  - |");
    expect(run("  1. a|", R.insertParagraph)).toBe("  1. a\n  2. |");
    expect(run("   - [x] a|", R.insertParagraph)).toBe("   - [x] a\n   - [ ] |");
    expect(run("  - |a", R.insertParagraph)).toBe("  - \n  - |a");
  });
  test("literal tab mid list text and in code", () => {
    expect(tab("- a|b")).toBe("- a\t|b");
    expect(tab("```\nx|\n```")).toBe("```\nx\t|\n```");
  });
  test("paragraph: literal tab at caret", () => {
    expect(tab("ab|c")).toBe("ab\t|c");
  });
  test("shift-tab outdents", () => {
    expect(tab("- a\n\t- b|", true)).toBe("- a\n- b|");
    expect(tab("\tab|", true)).toBe("\tab|");
    expect(tab("ab|", true)).toBe("ab|");
  });
});

describe("Cmd-B / Cmd-I", () => {
  const b = (s: string) => run(s, (d, sel) => R.toggleFormat(d, sel, "bold"));
  const i = (s: string) => run(s, (d, sel) => R.toggleFormat(d, sel, "italic"));
  test("wrap selection keeps inner selected, toggle unwraps", () => {
    expect(b("a [[bc]] d")).toBe("a **[[bc]]** d");
    expect(b("a **[[bc]]** d")).toBe("a [[bc]] d");
    expect(b("a [[**bc**]] d")).toBe("a [[bc]] d");
  });
  test("word under caret (strictly inside)", () => {
    expect(b("hel|lo world")).toBe("**hel|lo** world");
    expect(i("Plain word here|")).toBe("Plain word here*|*");
    expect(i("|here")).toBe("*|*here");
    expect(b("**hel|lo** world")).toBe("hel|lo world");
  });
  test("unwrap with the caret on a revealed marker", () => {
    expect(b("a **bold*|* c")).toBe("a bold| c");
    expect(b("a |**bold** c")).toBe("a |bold c");
  });
  test("never insert markers before a block token", () => {
    expect(b("|- item")).toBe("- **|**item");
    expect(b("|# Head")).toBe("# **|**Head");
  });
  test("empty pair", () => {
    expect(b("a | b")).toBe("a **|** b");
    expect(b("a **|** b")).toBe("a | b");
  });
  test("italic inside bold", () => {
    expect(i("**bo|ld**")).toBe("***bo|ld***");
    expect(i("***bo|ld***")).toBe("**bo|ld**");
  });
});

describe("todo toggle", () => {
  test("toggles and puts caret at text start", () => {
    const d = parseDoc("x\n- [ ] task");
    expect(show(d.text, R.toggleTodo(d, 1))).toBe("x\n- [x] |task");
    const d2 = parseDoc("\t- [x] task");
    expect(show(d2.text, R.toggleTodo(d2, 0))).toBe("\t- [ ] |task");
  });
});

describe("mapPos", () => {
  test("maps through changes", () => {
    const ch = [{ from: 2, to: 2, insert: "xx" }];
    expect(R.mapPos(1, ch)).toBe(1);
    expect(R.mapPos(2, ch)).toBe(4);
    expect(R.mapPos(2, ch, -1)).toBe(2);
    expect(R.mapPos(5, [{ from: 1, to: 3, insert: "" }])).toBe(3);
  });
});

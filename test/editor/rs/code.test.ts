// Code block highlighting (src/client/editor-rs/code*.ts): the theme as CSS classes, language words from fence
// info strings, the per-block tokenizers (incremental = from scratch), and the shell drawing it as a colour layer
// (text, segments and the raw <-> DOM mapping unchanged).
import { installDom } from "./dom.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import themeJson from "../../../src/shared/highlight-theme.json";
import { lineBackground, resolveToken, themeClasses, type CodeTheme } from "../../../src/client/editor-rs/code-theme.ts";
import { fenceLang, findBlocks, type Block } from "../../../src/client/editor-rs/code.ts";
import { supported } from "../../../src/client/editor-rs/code-langs.ts";
import { CodeBlocks, load } from "../../../src/client/editor-rs/code-live.ts";
import { tokenNames } from "../../../node_modules/@pierre/highlights/dist/index.js";
import { toRLine } from "../../../src/client/editor-rs/lineview.ts";
import { domToRaw, rawToDom } from "../../../src/client/editor-rs/offsets.ts";
import { RustEditorView } from "../../../src/client/editor-rs/view.ts";
import type { Engine, EngineFactory, LineViewJs } from "../../../src/client/editor-rs/types.ts";

installDom();

const theme = themeJson as CodeTheme;
await load(new WebAssembly.Module(readFileSync(new URL("../../../node_modules/@pierre/highlights/dist/highlights.wasm", import.meta.url))));

const pkg = new URL("../../../src/client/editor-rs/pkg/", import.meta.url);
let wasm: EngineFactory | null = null;
if (existsSync(new URL("editor_wasm_bg.wasm", pkg))) {
  const m = await import(new URL("editor_wasm.js", pkg).pathname);
  m.initSync({ module: readFileSync(new URL("editor_wasm_bg.wasm", pkg)) });
  wasm = (text: string) => new m.Engine(text) as Engine;
}
const withWasm = wasm ? test : test.skip;

describe("theme", () => {
  test("longest dotted prefix, else the text colour", () => {
    expect(resolveToken(theme, "keyword")).toEqual({ color: "#296d9a" });
    expect(resolveToken(theme, "keyword.control")).toEqual({ color: "#296d9a" });
    expect(resolveToken(theme, "keyword.operator")).toEqual({ color: "#62626a" });
    expect(resolveToken(theme, "comment.doc")).toEqual({ color: "#7a7b82", italic: true });
    expect(resolveToken(theme, "property.json_key")).toEqual({ color: "#4a5560" });
    expect(resolveToken(theme, "punctuation.bracket.html")).toEqual({ color: "#62626a" });
    expect(resolveToken(theme, "string.special.symbol")).toEqual({ color: "#2f7a6e" });
    expect(resolveToken(theme, "emphasis.strong")).toEqual({ bold: true });
    expect(resolveToken(theme, "variable")).toBeNull();
    expect(resolveToken(theme, "none")).toBeNull();
    expect(resolveToken(theme, "constructor")).toEqual({ color: "#5b4fa8" });
    expect(resolveToken(theme, "toString")).toBeNull();
  });

  test("line backgrounds (diff/patch)", () => {
    expect(lineBackground(theme, "diff.plus")).toBe("#e9f3ec");
    expect(lineBackground(theme, "diff.minus")).toBe("#f7efe5");
    expect(lineBackground(theme, "comment")).toBeNull();
    expect(lineBackground(theme, "string")).toBeNull();
  });

  test("classes and CSS for the library's token names", () => {
    const c = themeClasses(theme, tokenNames);
    const id = (n: string) => tokenNames.indexOf(n);
    expect(c.token.length).toBe(tokenNames.length);
    // same style, same class
    expect(c.token[id("keyword")]).toBe(c.token[id("keyword.control")]);
    expect(c.token[id("keyword")]).not.toBe(c.token[id("string")]);
    expect(c.token[id("variable")]).toBe("");
    expect(c.line[id("diff.plus")]).not.toBe("");
    expect(c.line[id("diff.minus")]).not.toBe(c.line[id("diff.plus")]);
    expect(c.line[id("keyword")]).toBe("");
    expect(c.lead[id("punctuation.special")]).toBe(true);
    expect(c.lead[id("none")]).toBe(false);
    expect(c.lead[id("diff.plus")]).toBe(false);
    expect(c.css).toContain(`.${c.token[id("comment")]}{color:#7a7b82;font-style:italic;}`);
    expect(c.css).toContain(`.${c.line[id("diff.plus")]}{background:#e9f3ec}`);
    expect(c.css).toContain("font-weight:600");
  });
});

describe("languages", () => {
  test("the info string's first word, lower case", () => {
    expect(fenceLang("```ts")).toBe("ts");
    expect(fenceLang("```TypeScript")).toBe("typescript");
    expect(fenceLang('```ts title="x"')).toBe("ts");
    expect(fenceLang("``` Rust {1,3}")).toBe("rust");
    expect(fenceLang("~~~py")).toBe("py");
    expect(fenceLang("````diff")).toBe("diff");
    expect(fenceLang("```{.python}")).toBe("python");
    expect(fenceLang("  ```sh")).toBe("sh");
    expect(fenceLang("```")).toBeNull();
    expect(fenceLang("```   ")).toBeNull();
    expect(fenceLang("~~~")).toBeNull();
  });

  test("names and aliases the highlighter knows", () => {
    for (const l of ["ts", "typescript", "js", "javascript", "rs", "rust", "py", "python", "sh", "bash", "zsh", "yml", "yaml", "json", "diff", "patch", "go", "c", "cpp", "c++", "css", "html", "sql", "md", "swift", "toml"]) {
      expect([l, supported(l)]).toEqual([l, true]);
    }
    for (const l of ["text", "plain", "txt", "foo", "constructor", "__proto__", "TS"]) expect([l, supported(l)]).toEqual([l, false]);
    expect(supported(fenceLang("```TS")!)).toBe(true);
  });
});

/** RLines of `text` from the engine. */
function rlines(text: string) {
  const lvs = wasm!(text).render_all().lines!.insert as LineViewJs[];
  return { lines: lvs.map((lv) => toRLine(lv, lv.text)), texts: lvs.map((lv) => lv.text) };
}

describe("blocks", () => {
  withWasm("fenced blocks with a language word, their content lines", () => {
    const { lines, texts } = rlines("a\n```ts\nx\ny\n```\n```\nplain\n```\n~~~DIFF x\n+a\n~~~\n```py\nunclosed");
    expect(findBlocks(lines, (i) => texts[i]!).map((b) => [b.lang, b.from, b.to])).toEqual([
      ["ts", 2, 4],
      ["diff", 9, 10],
      ["py", 12, 13],
    ]);
  });
});

const sig = (hls: { sig: string }[] | null) => hls?.map((h) => h.sig);

describe("tokenizers", () => {
  const block = (key: string, lang: string, n: number): Block => ({ key, lang, from: 0, to: n });
  const c = themeClasses(theme, tokenNames);
  const cls = (n: string) => c.token[tokenNames.indexOf(n)];

  test("ts runs and diff line classes", () => {
    const bs = new CodeBlocks();
    const ts = ["const a = 1; // c"];
    const diff = ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old", "+new", " same"];
    const [t, d] = bs.sync([block("1", "ts", 1), block("2", "diff", 6)], () => false, (b) => (b.key === "1" ? ts : diff));
    expect(t![0]!.runs[0]).toEqual([0, 6, cls("keyword")!]);
    expect(t![0]!.runs.at(-1)).toEqual([13, 17, cls("comment")!]);
    const plus = c.line[tokenNames.indexOf("diff.plus")];
    const minus = c.line[tokenNames.indexOf("diff.minus")];
    expect(d!.map((h) => h.cls)).toEqual([minus, plus, "", minus, plus, ""]);
    expect(bs.size).toBe(2);
    bs.sync([block("2", "diff", 6)], () => true, () => diff);
    expect(bs.size).toBe(1);
    bs.dispose();
  });

  test("diff line backgrounds: the first token that isn't punctuation; a bare + / - line counts", () => {
    const plus = c.line[tokenNames.indexOf("diff.plus")];
    const minus = c.line[tokenNames.indexOf("diff.minus")];
    const lines = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,4 +1,4 @@", "-old", "+new", "+", "-", " context", "", "+  indented", "-\tx"];
    const want = ["", minus, plus, "", minus, plus, plus, minus, "", "", plus, minus];
    for (const lang of ["diff", "patch"]) {
      const bs = new CodeBlocks();
      const [d] = bs.sync([block("1", lang, lines.length)], () => false, () => lines);
      expect([lang, d!.map((h) => h.cls)]).toEqual([lang, want]);
      // the text keeps its token colours: the marker is punctuation, the rest diff.plus / diff.minus
      expect(d![5]!.runs).toEqual([
        [0, 1, cls("punctuation.special")!],
        [1, 4, cls("diff.plus")!],
      ]);
      // edited into a bare "+": still an added line
      const edited = lines.slice();
      edited[5] = "+";
      expect(bs.sync([block("1", lang, lines.length)], () => false, () => edited)[0]![5]!.cls).toBe(plus);
      bs.dispose();
    }
    // a bare "+" in another language is nothing special
    const ts = new CodeBlocks();
    expect(ts.sync([block("1", "ts", 1)], () => false, () => ["+"])[0]![0]!.cls).toBe("");
    ts.dispose();
  });

  test("incremental edits give the same highlighting as from scratch", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const words = ["const", "x", "=", "1", ";", '"s"', "/*", "*/", "//", "`t${", "}`", "fn", "(", ")", "{", "}", " ", "let"];
    const randLine = () => Array.from({ length: rnd(6) }, () => words[rnd(words.length)]).join(" ");
    let lines = Array.from({ length: 12 }, randLine);
    const live = new CodeBlocks();
    for (let step = 0; step < 300; step++) {
      const next = lines.slice();
      const op = rnd(4);
      const i = rnd(next.length + 1);
      if (op === 0) next.splice(i, 0, randLine());
      else if (op === 1 && next.length > 1) next.splice(Math.min(i, next.length - 1), 1 + rnd(2));
      else if (next.length) next[Math.min(i, next.length - 1)] = randLine();
      if (!next.length) next.push("");
      lines = next;
      const got = live.sync([block("k", "ts", lines.length)], () => false, () => lines)[0];
      const fresh = new CodeBlocks();
      const want = fresh.sync([block("k", "ts", lines.length)], () => false, () => lines)[0];
      fresh.dispose();
      expect([step, sig(got)]).toEqual([step, sig(want)]);
    }
    live.dispose();
  });

  test("a renumbered block keeps its tokenizer; a language change starts over", () => {
    const bs = new CodeBlocks();
    const a = bs.sync([block("1", "ts", 1)], () => false, () => ["let a"])[0]!;
    const b = bs.sync([block("9", "ts", 1)], () => true, () => ["let a"])[0]!;
    expect(b).toBe(a);
    const p = bs.sync([block("9", "py", 1)], () => true, () => ["let a"])[0]!;
    expect(p).not.toBe(a);
    expect(bs.size).toBe(1);
    bs.dispose();
  });
});

describe("shell", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  async function mount(text: string) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new RustEditorView(host, { text, engine: wasm! });
    for (let i = 0; i < 20 && !view.root.querySelector("[class*=hk]"); i++) await tick();
    return view;
  }
  /** raw -> DOM -> raw at every position, and every line's DOM text. */
  function mapping(view: RustEditorView): string[] {
    const bad: string[] = [];
    view.doc.lines.forEach((l, i) => {
      if (view.root.getElementsByClassName("ln")[i]!.textContent !== view.doc.text.slice(l.from, l.to)) bad.push("text " + i);
    });
    for (let p = 0; p <= view.doc.text.length; p++) {
      const d = rawToDom(view.root, view.doc, p);
      const back = domToRaw(view.root, view.doc, d.node, d.offset);
      if (back !== p) bad.push(`${p} -> ${back}`);
    }
    return bad;
  }

  withWasm("a colour layer: same text and mapping, segments split at token edges", async () => {
    const text = "x\n```ts\nconst a = 1; // c\n```\n```diff\n-a\n+b\n```\n```foo\nconst b\n```";
    const view = await mount(text);
    const ln = (i: number) => view.root.getElementsByClassName("ln")[i] as HTMLElement;
    expect(ln(2).querySelectorAll("[class*=hk]").length).toBeGreaterThan(3);
    expect([...ln(2).querySelectorAll("[data-f]")].map((e) => [e.getAttribute("data-f"), e.getAttribute("data-t"), e.textContent])[0]).toEqual(["0", "6", "const "]);
    expect(ln(5).className).toContain("hkl");
    expect(ln(6).className).toContain("hkl");
    expect(ln(5).className).not.toBe(ln(6).className);
    expect(ln(9).querySelectorAll("[data-f]").length).toBe(1);
    expect(ln(1).innerHTML).toBe('<span class="mk fence" data-f="0" data-t="5">```ts</span>');
    expect(mapping(view)).toEqual([]);

    // typing in the block: only its line is redrawn
    const other = ln(5);
    view.apply(view.engine.set_selection(text.indexOf("1;"), text.indexOf("1;")));
    view.apply(view.engine.insert_text('"s" + '));
    expect(ln(2).textContent).toBe('const a = "s" + 1; // c');
    expect(ln(2).querySelector(`[data-f="10"]`)!.className).toMatch(/hk/);
    expect(ln(5)).toBe(other);
    expect(mapping(view)).toEqual([]);
    // typing elsewhere redraws no code line
    const code = ln(2);
    view.apply(view.engine.set_selection(1, 1));
    view.apply(view.engine.insert_text("yz"));
    expect(ln(2)).toBe(code);
    // undo
    view.apply(view.engine.undo());
    view.apply(view.engine.undo());
    expect(view.engine.text()).toBe(text);
    expect(mapping(view)).toEqual([]);
    // the language removed: plain again
    const fl = view.doc.lines[1]!;
    view.apply(view.engine.set_selection(fl.to, fl.to));
    view.apply(view.engine.key("Backspace", 0, view.layout));
    view.apply(view.engine.key("Backspace", 0, view.layout));
    expect(view.doc.text.split("\n")[1]).toBe("```");
    expect(ln(2).querySelectorAll("[class*=hk]").length).toBe(0);
    expect(ln(2).querySelectorAll("[data-f]").length).toBe(1);
    view.destroy();
  });

  withWasm("remote edits and a full re-render", async () => {
    const text = "```py\ndef f(): pass\n```";
    const view = await mount(text);
    view.applyRemote([{ from: 6, to: 6, insert: "# " }]);
    expect(view.root.getElementsByClassName("ln")[1]!.querySelector("[data-f='0']")!.className).toMatch(/hk/);
    expect(view.root.getElementsByClassName("ln")[1]!.querySelectorAll("[data-f]").length).toBe(1);
    view.renderAll();
    await tick();
    expect(view.root.getElementsByClassName("ln")[1]!.className).toContain("in-code");
    expect(view.root.getElementsByClassName("ln")[1]!.querySelector("[class*=hk]")).not.toBeNull();
    expect(mapping(view)).toEqual([]);
    view.destroy();
  });
});

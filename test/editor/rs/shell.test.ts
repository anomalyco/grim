// Rust editor shell (src/client/editor-rs): line views -> DOM (same DOM as the TS renderer), DOM <-> raw mapping,
// patch application with DOM reuse, the Yjs bridge, key translation. Uses the wasm engine when its package is
// there (src/client/editor-rs/pkg), and the fake TS engine otherwise / in addition.
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { parseDoc } from "../../../src/client/editor/parser.ts";
import { computeReveal } from "../../../src/client/editor/reveal.ts";
import { applyReveal, renderLine } from "../../../src/client/editor/render.ts";
import { domToRaw, rawToDom } from "../../../src/client/editor/offsets.ts";
import { toRLine } from "../../../src/client/editor-rs/lineview.ts";
import { applyLineReveal, renderRLine } from "../../../src/client/editor-rs/render.ts";
import { RustEditorView, applyEdits, deltaToEdits } from "../../../src/client/editor-rs/view.ts";
import { translateKey } from "../../../src/client/editor-rs/input.ts";
import { FakeEngine } from "../../../src/client/editor-rs/fake.ts";
import { META, SHIFT, ALT, type Engine, type EngineFactory, type JsLayout, type LineViewJs, type Patch } from "../../../src/client/editor-rs/types.ts";

const pkg = new URL("../../../src/client/editor-rs/pkg/", import.meta.url);
let wasm: EngineFactory | null = null;
if (existsSync(new URL("editor_wasm_bg.wasm", pkg))) {
  const path: string = new URL("editor_wasm.js", pkg).pathname;
  const m = await import(path);
  m.initSync({ module: readFileSync(new URL("editor_wasm_bg.wasm", pkg)) });
  wasm = (text: string) => new m.Engine(text) as Engine;
}
const withWasm = wasm ? test : test.skip;

const stubLayout: JsLayout = {
  caret_rect: () => [0, 0, 0, 20],
  hit_test: () => undefined,
  bounds: () => [800, 600],
  adjacent_line_y: () => undefined,
  table_cell_at: () => undefined,
  line_mid_y: () => undefined,
  image_at: () => undefined,
};

const DOCS = [
  "# Title\n\nSome **bold** and *it* text with `code` and ==hl== ~u~ ~~s~~ #tag",
  "- a\n\t- nested\n- [ ] todo\n- [x] done\n1. one\n2. two\n> quote\n---\n## H2",
  '[link](http://x.y) and ![alt](http://x/y.png "t")\n![a](https://e.x/a.png)\n\\*esc\\* [![i](https://e.x/i.png)](https://e.x)',
  "```js\ncode\n  more\n```\nafter",
  "| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 |",
  "**bold *nested* inside** end\nemoji 😀 **b😀** x",
  "",
];

/** Selections to try in a document: a few carets and a range. */
function sels(md: string): [number, number][] {
  const n = md.length;
  return [
    [0, 0],
    [Math.floor(n / 3), Math.floor(n / 3)],
    [Math.floor(n / 2), Math.floor(n / 2)],
    [n, n],
    [Math.floor(n / 4), Math.floor((3 * n) / 4)],
  ];
}

function splice(lines: LineViewJs[], p: Patch) {
  if (p.lines) lines.splice(p.lines.start, p.lines.deleteCount, ...p.lines.insert);
}

function tsDom(md: string, sel: { anchor: number; head: number }): HTMLElement {
  const doc = parseDoc(md);
  const rv = computeReveal(doc, sel);
  const root = document.createElement("div");
  doc.lines.forEach((line, i) => {
    const div = renderLine(line, doc.text);
    applyReveal(div, rv.get(i));
    root.appendChild(div);
  });
  return root;
}

function rsDom(lines: LineViewJs[]): HTMLElement {
  const root = document.createElement("div");
  for (const lv of lines) {
    const r = toRLine(lv, lv.text ?? "");
    const div = renderRLine(r, lv.text ?? "");
    applyLineReveal(div, r);
    root.appendChild(div);
  }
  return root;
}

describe("line views render like the TS editor", () => {
  withWasm("same DOM for the same text and selection", () => {
    for (const md of DOCS) {
      const e = wasm!(md);
      const lines: LineViewJs[] = [];
      splice(lines, e.render_all());
      for (const [a, h] of sels(md)) {
        const p = e.set_selection(a, h);
        splice(lines, p);
        const want = tsDom(md, p.sel).innerHTML;
        const got = rsDom(lines).innerHTML;
        if (got !== want) console.log(JSON.stringify({ md, sel: p.sel }));
        expect(got).toBe(want);
      }
      e.free?.();
    }
  });

  withWasm("same DOM <-> raw mapping", () => {
    for (const md of DOCS) {
      const e = wasm!(md);
      const lines: LineViewJs[] = [];
      splice(lines, e.render_all());
      for (const [a, h] of sels(md)) {
        const p = e.set_selection(a, h);
        splice(lines, p);
        const doc = parseDoc(md);
        const ts = tsDom(md, p.sel);
        const rs = rsDom(lines);
        let at = 0;
        const odoc = { text: md, lines: lines.map((l) => ({ from: at, to: (at += l.len + 1) - 1 })) };
        expect(odoc.lines).toEqual(doc.lines.map((l) => ({ from: l.from, to: l.to })));
        for (let pos = 0; pos <= md.length; pos++) {
          const tp = rawToDom(ts, doc, pos);
          const rp = rawToDom(rs, odoc, pos);
          expect(path(rs, rp.node) + ":" + rp.offset).toBe(path(ts, tp.node) + ":" + tp.offset);
          expect(domToRaw(rs, odoc, rp.node, rp.offset)).toBe(domToRaw(ts, doc, tp.node, tp.offset));
        }
        // every DOM boundary maps back the same way
        const walk = (n: Node, m: Node) => {
          const len = n.nodeType === 3 ? (n as Text).length : n.childNodes.length;
          for (let o = 0; o <= len; o++) expect(domToRaw(rs, odoc, n, o)).toBe(domToRaw(ts, doc, m, o));
          n.childNodes.forEach((c, i) => walk(c, m.childNodes[i]!));
        };
        rs.childNodes.forEach((c, i) => walk(c, ts.childNodes[i]!));
      }
    }
  });
});

/** Child-index path of a node under root. */
function path(root: Node, n: Node): string {
  const out: number[] = [];
  while (n !== root && n.parentNode) {
    out.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
    n = n.parentNode;
  }
  return out.join("/");
}

function mount(text: string, engine: EngineFactory) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("md");
  ytext.insert(0, text);
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
  ydoc.on("update", (u: Uint8Array, origin: unknown) => origin !== "sync" && Y.applyUpdate(other, u, "sync"));
  other.on("update", (u: Uint8Array, origin: unknown) => origin !== "sync" && Y.applyUpdate(ydoc, u, "sync"));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const awareness = new Awareness(ydoc);
  const view = new RustEditorView(host, { ytext, awareness, engine });
  const domText = () => Array.from(view.root.children).map((d) => d.textContent).join("\n");
  return { view, ytext, other: other.getText("md"), domText, destroy: () => (view.destroy(), host.remove()) };
}

const engines: [string, EngineFactory | null][] = [
  ["fake", (t) => new FakeEngine(t)],
  ["wasm", wasm],
];

for (const [name, factory] of engines) {
  const t = factory ? test : test.skip;
  describe(`patches and Yjs (${name} engine)`, () => {
    t("local edits reach the Y.Text; untouched lines keep their divs", () => {
      const m = mount("alpha\nbeta\ngamma", factory!);
      const v = m.view;
      expect(v.root.children.length).toBe(3);
      const [d0, , d2] = Array.from(v.root.children);
      v.apply(v.engine.set_selection(8, 8));
      v.apply(v.engine.insert_text("X"));
      expect(v.engine.text()).toBe("alpha\nbeXta\ngamma");
      expect(m.ytext.toString()).toBe("alpha\nbeXta\ngamma");
      expect(m.other.toString()).toBe("alpha\nbeXta\ngamma");
      expect(v.doc.text).toBe("alpha\nbeXta\ngamma");
      expect(m.domText()).toBe("alpha\nbeXta\ngamma");
      expect(v.root.children[0]).toBe(d0!);
      expect(v.root.children[2]).toBe(d2!);
      expect(v.sel).toEqual({ anchor: 9, head: 9 });
      v.apply(v.engine.key("Enter", 0, stubLayout));
      expect(m.ytext.toString()).toBe("alpha\nbeX\nta\ngamma");
      expect(m.domText()).toBe("alpha\nbeX\nta\ngamma");
      expect(v.doc.lines).toEqual([
        { from: 0, to: 5 },
        { from: 6, to: 9 },
        { from: 10, to: 12 },
        { from: 13, to: 18 },
      ]);
      v.apply(v.engine.undo());
      v.apply(v.engine.undo());
      expect(m.ytext.toString()).toBe("alpha\nbeta\ngamma");
      expect(m.domText()).toBe("alpha\nbeta\ngamma");
      m.destroy();
    });

    t("remote edits go to the engine; the local selection follows", () => {
      const m = mount("one\ntwo", factory!);
      const v = m.view;
      v.apply(v.engine.set_selection(5, 5));
      m.other.insert(0, "zero\n");
      expect(v.engine.text()).toBe("zero\none\ntwo");
      expect(m.domText()).toBe("zero\none\ntwo");
      expect(v.sel).toEqual({ anchor: 10, head: 10 });
      m.other.delete(5, 4);
      m.other.insert(m.other.length, " three");
      expect(v.engine.text()).toBe("zero\ntwo three");
      expect(m.domText()).toBe("zero\ntwo three");
      expect(m.ytext.toString()).toBe(v.engine.text());
      // a same-length replacement inside a line (the line view may not change)
      m.other.delete(5, 1);
      m.other.insert(5, "T");
      expect(m.domText()).toBe("zero\nTwo three");
      m.destroy();
    });
  });
}

describe("wasm engine specifics", () => {
  withWasm("reveal changes reuse the line div; markdown edits", () => {
    const m = mount("plain **bold** end\n- item", wasm!);
    const v = m.view;
    const d0 = v.root.children[0]!;
    expect(d0.querySelectorAll(".mk.rv").length).toBe(0);
    v.apply(v.engine.set_selection(9, 9));
    expect(v.root.children[0]).toBe(d0);
    expect(d0.querySelectorAll(".mk.rv").length).toBe(2);
    v.apply(v.engine.set_selection(25, 25));
    expect(d0.querySelectorAll(".mk.rv").length).toBe(0);
    v.apply(v.engine.key("Enter", 0, stubLayout));
    expect(m.ytext.toString()).toBe("plain **bold** end\n- item\n- ");
    expect(v.root.querySelectorAll(".tok-bullet").length).toBe(2);
    v.apply(v.engine.insert_text("😀"));
    expect(m.ytext.toString()).toBe("plain **bold** end\n- item\n- 😀");
    expect(v.sel).toEqual({ anchor: 30, head: 30 });
    v.apply(v.engine.set_selection(6, 14));
    v.apply(v.engine.key("b", META, stubLayout));
    expect(m.ytext.toString()).toBe("plain bold end\n- item\n- 😀");
    m.destroy();
  });

  withWasm("todo toggle and read-only", () => {
    const m = mount("- [ ] task", wasm!);
    m.view.apply(m.view.engine.toggle_todo(0));
    expect(m.ytext.toString()).toBe("- [x] task");
    expect(m.view.root.querySelector(".ln")!.classList.contains("checked")).toBe(true);
    m.destroy();
  });
});

describe("helpers", () => {
  test("deltaToEdits / applyEdits", () => {
    expect(deltaToEdits([{ retain: 2 }, { delete: 3 }, { insert: "ab" }, { retain: 1 }, { insert: "z" }])).toEqual([
      { from: 2, to: 5, insert: "ab" },
      { from: 5, to: 5, insert: "z" },
    ]);
    expect(applyEdits("0123456789", [{ from: 2, to: 5, insert: "ab" }, { from: 5, to: 5, insert: "z" }])).toBe("01ab5z6789");
  });

  test("translateKey: macOS passes keys through, elsewhere Ctrl is the command key", () => {
    const k = (key: string, m: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({
      key,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      ...m,
    });
    expect(translateKey(k("ArrowLeft", { altKey: true }), true)).toEqual({ key: "ArrowLeft", mods: ALT });
    expect(translateKey(k("z", { metaKey: true, shiftKey: true }), true)).toEqual({ key: "z", mods: META | SHIFT });
    expect(translateKey(k("z", { ctrlKey: true }), false)).toEqual({ key: "z", mods: META });
    expect(translateKey(k("y", { ctrlKey: true }), false)).toEqual({ key: "z", mods: META | SHIFT });
    expect(translateKey(k("ArrowLeft", { ctrlKey: true, shiftKey: true }), false)).toEqual({ key: "ArrowLeft", mods: ALT | SHIFT });
    expect(translateKey(k("ArrowDown", { ctrlKey: true }), false)).toEqual({ key: "ArrowDown", mods: ALT });
    expect(translateKey(k("Home"), false)).toEqual({ key: "ArrowLeft", mods: META });
    expect(translateKey(k("End", { ctrlKey: true }), false)).toEqual({ key: "ArrowDown", mods: META });
    expect(translateKey(k("Backspace", { ctrlKey: true }), false)).toEqual({ key: "Backspace", mods: ALT });
    expect(translateKey(k("ArrowLeft", { altKey: true }), false)).toBeNull();
    expect(translateKey(k("a"), false)).toEqual({ key: "a", mods: 0 });
    expect(translateKey(k("@", { ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});

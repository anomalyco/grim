// The editor shell (src/client/editor-rs): line views -> DOM, DOM <-> raw mapping, patch application with DOM
// reuse, local documents with a LocalSync (the tests' Yjs mirror), key translation. Uses the wasm engine when its
// package is there (src/client/editor-rs/pkg), and the fake engine otherwise / in addition.
import { installDom } from "./dom.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { domToRaw, rawToDom } from "../../../src/client/editor-rs/offsets.ts";
import { toRLine } from "../../../src/client/editor-rs/lineview.ts";
import { applyLineReveal, renderRLine } from "../../../src/client/editor-rs/render.ts";
import { RustEditorView, foldStorageKey } from "../../../src/client/editor-rs/view.ts";
import { applyEdits, deltaToEdits } from "../../../src/client/editor-rs/edits.ts";
import { foldKey, translateKey } from "../../../src/client/editor-rs/input.ts";
import { FakeEngine } from "../fake.ts";
import { META, SHIFT, ALT, type Engine, type EngineFactory, type JsLayout, type LineViewJs, type Patch } from "../../../src/client/editor-rs/types.ts";
import { YjsMirror } from "../ymirror.ts";

installDom();

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

function splice(lines: LineViewJs[], p: Patch) {
  if (p.lines) lines.splice(p.lines.start, p.lines.deleteCount, ...p.lines.insert);
}

function rsDom(lines: LineViewJs[]): HTMLElement {
  const root = document.createElement("div");
  for (const lv of lines) {
    const r = toRLine(lv, lv.text ?? "");
    const div = renderRLine(r, lv.text ?? "");
    applyLineReveal(div, r);
    // fold state isn't in the golden DOM (it predates folding)
    div.classList.remove("fold-able", "folded", "fold-hidden");
    root.appendChild(div);
  }
  return root;
}

/**
 * The DOM and its raw mapping recorded from the TS editor's renderer before it was removed (render-golden.json:
 * documents × selections, the HTML, rawToDom at every position, domToRaw at every DOM boundary): the shell keeps
 * drawing exactly that, so editor.css and the mapping stay right.
 */
const golden: { md: string; sel: [number, number]; snapped: [number, number]; html: string; map: string; back: string }[] = JSON.parse(
  readFileSync(new URL("render-golden.json", import.meta.url), "utf8"),
);

describe("line views render the recorded DOM", () => {
  withWasm("same DOM for the same text and selection", () => {
    for (const g of golden) {
      const e = wasm!(g.md);
      const lines: LineViewJs[] = [];
      splice(lines, e.render_all());
      const p = e.set_selection(g.sel[0], g.sel[1]);
      splice(lines, p);
      expect([p.sel.anchor, p.sel.head]).toEqual(g.snapped);
      const got = rsDom(lines).innerHTML;
      if (got !== g.html) console.log(JSON.stringify({ md: g.md, sel: g.sel }));
      expect(got).toBe(g.html);
      e.free?.();
    }
  });

  withWasm("same DOM <-> raw mapping", () => {
    for (const g of golden) {
      const e = wasm!(g.md);
      const lines: LineViewJs[] = [];
      splice(lines, e.render_all());
      splice(lines, e.set_selection(g.sel[0], g.sel[1]));
      const rs = rsDom(lines);
      let at = 0;
      const odoc = { text: g.md, lines: lines.map((l) => ({ from: at, to: (at += l.len + 1) - 1 })) };
      const map: string[] = [];
      for (let pos = 0; pos <= g.md.length; pos++) {
        const rp = rawToDom(rs, odoc, pos);
        map.push(path(rs, rp.node) + ":" + rp.offset + "=" + domToRaw(rs, odoc, rp.node, rp.offset));
      }
      expect(map.join(" ")).toBe(g.map);
      // every DOM boundary maps back the same way
      const back: (number | null)[] = [];
      const walk = (n: Node) => {
        const len = n.nodeType === 3 ? (n as Text).length : n.childNodes.length;
        for (let o = 0; o <= len; o++) back.push(domToRaw(rs, odoc, n, o));
        n.childNodes.forEach((c) => walk(c));
      };
      rs.childNodes.forEach((c) => walk(c));
      expect(back.join(",")).toBe(g.back);
      e.free?.();
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
  const view = new RustEditorView(host, { text, sync: new YjsMirror(ytext, awareness), engine });
  const domText = () => Array.from(view.root.children).map((d) => d.textContent).join("\n");
  return { view, ytext, other: other.getText("md"), domText, destroy: () => (view.destroy(), host.remove()) };
}

const engines: [string, EngineFactory | null][] = [
  ["fake", (t) => new FakeEngine(t)],
  ["wasm", wasm],
];

for (const [name, factory] of engines) {
  const t = factory ? test : test.skip;
  describe(`patches and a Yjs mirror (${name} engine)`, () => {
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

describe("collapsible sections", () => {
  const flags = (v: RustEditorView) =>
    Array.from(v.root.children)
      .map((d) => (d.classList.contains("fold-hidden") ? "h" : d.classList.contains("folded") ? "F" : d.classList.contains("fold-able") ? "f" : "-"))
      .join("");

  withWasm("fold state is classes on reused line divs; the text and the Y.Text never change", () => {
    const m = mount("# A\na1\n## B\nb1\n# C\nc1", wasm!);
    const v = m.view;
    expect(flags(v)).toBe("f-f-f-");
    const divs = Array.from(v.root.children);
    v.toggleFold(0);
    expect(flags(v)).toBe("Fhhhf-");
    expect(Array.from(v.root.children)).toEqual(divs);
    expect(m.ytext.toString()).toBe("# A\na1\n## B\nb1\n# C\nc1");
    v.foldCommand("foldAll");
    expect(flags(v)).toBe("FhhhFh");
    v.foldCommand("unfoldAll");
    expect(flags(v)).toBe("f-f-f-");
    // typing in a folded heading keeps it folded; remote edits are mapped
    v.toggleFold(2);
    v.apply(v.engine.set_selection(11, 11));
    v.apply(v.engine.insert_text("!"));
    expect(flags(v)).toBe("f-Fhf-");
    m.other.insert(0, "x\n");
    expect(flags(v)).toBe("-f-Fhf-");
    expect(m.ytext.toString()).toBe("x\n# A\na1\n## B!\nb1\n# C\nc1");
    m.destroy();
  });

  withWasm("folds persist per note in localStorage (heading text + occurrence)", () => {
    localStorage.clear();
    const text = "# A\na\n# A\nb";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const v = new RustEditorView(host, { text, engine: wasm!, foldKey: "k" });
    v.toggleFold(2);
    v.destroy();
    expect(JSON.parse(localStorage.getItem("grimoire.folds:k")!)).toEqual([["# A", 1]]);
    const v2 = new RustEditorView(host, { text, engine: wasm!, foldKey: "k" });
    expect(flags(v2)).toBe("f-Fh");
    v2.toggleFold(2);
    v2.destroy();
    expect(localStorage.getItem("grimoire.folds:k")).toBeNull();
    host.remove();
    expect(foldStorageKey("repo", "a/b.md")).toBe("grimoire.folds:repo\u0000a/b.md");
  });

  test("the fake engine (no folding) renders as before", () => {
    const m = mount("# A\na", (t) => new FakeEngine(t));
    m.view.toggleFold(0);
    m.view.foldCommand("foldAll");
    expect(flags(m.view)).toBe("--");
    m.destroy();
  });

  test("fold shortcuts by physical key", () => {
    const k = (code: string, m: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({
      key: "“",
      code,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      ...m,
    });
    expect(foldKey(k("Quote", { metaKey: true }), true)).toEqual({ key: "'", mods: META });
    expect(foldKey(k("BracketLeft", { metaKey: true, altKey: true }), true)).toEqual({ key: "[", mods: META | ALT });
    expect(foldKey(k("BracketRight", { metaKey: true, altKey: true, shiftKey: true }), true)).toEqual({ key: "]", mods: META | ALT | SHIFT });
    expect(foldKey(k("BracketLeft", { ctrlKey: true, altKey: true }), false)).toEqual({ key: "[", mods: META | ALT });
    expect(foldKey(k("BracketLeft", { ctrlKey: true, altKey: true }), true)).toBeNull();
    expect(foldKey(k("BracketLeft", { metaKey: true }), true)).toBeNull();
    expect(foldKey(k("KeyA", { metaKey: true }), true)).toBeNull();
  });
});

describe("review A fixes", () => {
  withWasm("CRLF text stays byte-identical in the engine, the view and the Y.Text", () => {
    const m = mount("a\r\n- b\r\nc", wasm!);
    const v = m.view;
    expect(v.engine.text()).toBe("a\r\n- b\r\nc");
    expect(v.doc.text).toBe("a\r\n- b\r\nc");
    v.apply(v.engine.set_selection(9, 9));
    v.apply(v.engine.insert_text("X"));
    m.other.insert(7, "Y");
    v.apply(v.engine.insert_text("Z"));
    expect(m.ytext.toString()).toBe("a\r\n- b\rY\ncXZ");
    expect(m.other.toString()).toBe("a\r\n- b\rY\ncXZ");
    expect(v.engine.text()).toBe("a\r\n- b\rY\ncXZ");
    m.destroy();
  });

  for (const [name, factory] of engines) {
    const t = factory ? test : test.skip;
    t(`replace_range and a cancelled composition (${name} engine)`, () => {
      const m = mount("teh cat two", factory!);
      const v = m.view;
      v.apply(v.engine.set_selection(11, 11));
      v.apply(v.engine.replace_range(0, 3, "the"));
      expect(m.ytext.toString()).toBe("the cat two");
      v.apply(v.engine.set_selection(4, 7));
      v.composing = true;
      v.engine.begin_composition();
      v.finishComposition("");
      expect(m.ytext.toString()).toBe("the  two");
      expect(v.sel).toEqual({ anchor: 4, head: 4 });
      v.composing = true;
      v.engine.begin_composition();
      v.finishComposition("字");
      expect(m.ytext.toString()).toBe("the 字 two");
      m.destroy();
    });
  }

  withWasm("a line re-rendered for a text change keeps its loaded <img>", () => {
    // an engine that doesn't resend the line (the shell notices the text change itself)
    const m = mount("x ![a](https://e.x/a.png)", (t) => {
      const e = wasm!(t);
      const apply_remote = e.apply_remote.bind(e);
      e.apply_remote = (edits) => ({ ...apply_remote(edits), lines: null });
      return e;
    });
    const v = m.view;
    const img = v.root.querySelector(".imgbox img");
    expect(img).not.toBeNull();
    const div = v.root.children[0];
    m.other.doc!.transact(() => {
      m.other.delete(0, 1);
      m.other.insert(0, "y");
    });
    expect(m.domText().startsWith("y")).toBe(true);
    expect(v.root.children[0]).not.toBe(div);
    expect(v.root.querySelector(".imgbox img")).toBe(img);
    m.destroy();
  });

  test("loadWasmEngine loads once per base URL", async () => {
    const { loadWasmEngine } = await import("../../../src/client/editor-rs/engine.ts");
    const bad = loadWasmEngine("file:///nonexistent-wasm-base/");
    const good = existsSync(new URL("editor_wasm_bg.wasm", pkg)) ? loadWasmEngine(pkg.href) : null;
    expect(bad).not.toBe(good);
    expect(loadWasmEngine("file:///nonexistent-wasm-base/")).toBe(bad);
    await expect(bad).rejects.toBeDefined();
    if (good) expect((await good)("a\r\nb").text()).toBe("a\r\nb");
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

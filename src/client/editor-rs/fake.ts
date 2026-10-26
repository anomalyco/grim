// A small TS stand-in for the wasm engine (contract 4) over plain text: every line is a paragraph of plain text.
// It exercises the shell's plumbing (patches, line splices, layout queries, input, Yjs) in tests and while the
// real engine isn't available. Not used by the app.

import { ALT, META, SHIFT, type CutResult, type Edit, type Engine, type JsLayout, type LineViewJs, type Patch } from "./types.ts";

interface Sel {
  anchor: number;
  head: number;
}

export class FakeEngine implements Engine {
  private t: string;
  private sel: Sel = { anchor: 0, head: 0 };
  private prev: LineViewJs[] = [];
  private ro = false;
  private undos: { text: string; sel: Sel }[] = [];
  private redos: { text: string; sel: Sel }[] = [];
  private goalX: number | null = null;
  private composing: Sel | null = null;
  /** Every layout call, for tests. */
  calls: string[] = [];

  constructor(text: string) {
    this.t = text;
  }

  text(): string {
    return this.t;
  }

  render_all(): Patch {
    this.prev = this.views();
    return { lines: { start: 0, deleteCount: 0, insert: this.prev }, sel: { ...this.sel } };
  }

  insert_text(s: string): Patch {
    this.composing = null;
    if (this.ro) return this.patch();
    const [a, b] = this.range();
    return this.edit(a, b, s);
  }

  key(key: string, mods: number, layout: JsLayout): Patch | undefined {
    const shift = !!(mods & SHIFT);
    const k = key.length === 1 ? key.toLowerCase() : key;
    if (mods & META && k === "z") return shift ? this.redo() : this.undo();
    if (mods & META && k === "a") return this.select(0, this.t.length);
    if (mods & META && k === "b") {
      if (this.ro) return this.patch();
      const [a, b] = this.range();
      const p = this.edit(a, b, "**" + this.t.slice(a, b) + "**");
      this.sel = { anchor: a + 2, head: b + 2 };
      return { ...p, sel: { ...this.sel } };
    }
    if (mods & META && (k === "ArrowLeft" || k === "ArrowRight")) {
      const [from, to] = this.lineOf(this.sel.head);
      return this.move(k === "ArrowLeft" ? from : to, shift);
    }
    switch (k) {
      case "ArrowLeft":
      case "ArrowRight": {
        const dir = k === "ArrowLeft" ? -1 : 1;
        const [a, b] = this.range();
        if (!shift && a !== b) return this.move(dir < 0 ? a : b, false);
        let p = this.sel.head;
        if (mods & ALT) {
          p += dir;
          while (p > 0 && p < this.t.length && /\w/.test(this.t[dir < 0 ? p - 1 : p]!)) p += dir;
        } else p += dir;
        return this.move(Math.max(0, Math.min(this.t.length, p)), shift);
      }
      case "ArrowUp":
      case "ArrowDown": {
        const dir = k === "ArrowUp" ? -1 : 1;
        const cur = layout.caret_rect(this.sel.head);
        this.calls.push("caret_rect");
        const goal = this.goalX ?? cur[0];
        const y = layout.adjacent_line_y(this.sel.head, dir);
        this.calls.push("adjacent_line_y");
        let p: number;
        if (y === undefined || y === null) p = dir < 0 ? 0 : this.t.length;
        else {
          p = layout.hit_test(goal, y) ?? this.sel.head;
          this.calls.push("hit_test");
        }
        const out = this.move(p, shift);
        this.goalX = goal;
        return out;
      }
      case "Home":
      case "End":
        return { sel: { ...this.sel }, scroll: k === "Home" ? "start" : "end" };
      case "Backspace": {
        if (this.ro) return undefined;
        const [a, b] = this.range();
        if (a !== b) return this.edit(a, b, "");
        return a > 0 ? this.edit(a - 1, a, "") : this.patch();
      }
      case "Delete": {
        if (this.ro) return undefined;
        const [a, b] = this.range();
        if (a !== b) return this.edit(a, b, "");
        return a < this.t.length ? this.edit(a, a + 1, "") : this.patch();
      }
      case "Enter": {
        if (this.ro) return undefined;
        const [a, b] = this.range();
        return this.edit(a, b, "\n");
      }
      case "Tab": {
        if (this.ro || mods) return undefined;
        const [a, b] = this.range();
        return this.edit(a, b, "\t");
      }
      default:
        return undefined;
    }
  }

  mouse_down(x: number, y: number, clicks: number, shift: boolean, layout: JsLayout): Patch {
    this.goalX = null;
    const p = layout.hit_test(x, y) ?? this.sel.head;
    this.calls.push("hit_test");
    if (shift) return this.select(this.sel.anchor, p);
    if (clicks === 2) {
      let a = p;
      let b = p;
      while (a > 0 && /\w/.test(this.t[a - 1]!)) a--;
      while (b < this.t.length && /\w/.test(this.t[b]!)) b++;
      return this.select(a, b);
    }
    if (clicks >= 3) {
      const [from, to] = this.lineOf(p);
      return this.select(from, Math.min(this.t.length, to + 1));
    }
    return this.select(p, p);
  }

  mouse_drag(x: number, y: number, layout: JsLayout): Patch {
    const p = layout.hit_test(x, y);
    this.calls.push("hit_test");
    return p === undefined ? this.patch() : this.select(this.sel.anchor, p);
  }

  set_selection(anchor: number, head: number): Patch {
    this.goalX = null;
    return this.select(anchor, head);
  }

  begin_composition(): void {
    this.composing = { ...this.sel };
  }

  end_composition(): Patch {
    const c = this.composing;
    this.composing = null;
    if (!c || this.ro || c.anchor === c.head) return this.patch();
    return this.edit(Math.min(c.anchor, c.head), Math.max(c.anchor, c.head), "");
  }

  abort_composition(): void {
    this.composing = null;
  }

  replace_range(from: number, to: number, text: string): Patch {
    if (this.ro) return this.patch();
    return this.edit(Math.min(from, to), Math.max(from, to), text);
  }

  paste(text: string): Patch {
    return this.insert_text(text);
  }

  cut(): CutResult {
    const text = this.copy();
    if (this.ro || !text) return { text, patch: this.patch() };
    const [a, b] = this.range();
    return { text, patch: this.edit(a, b, "") };
  }

  copy(): string {
    const [a, b] = this.range();
    return this.t.slice(a, b);
  }

  undo(): Patch {
    const u = this.undos.pop();
    if (!u || this.ro) return this.patch();
    this.redos.push({ text: this.t, sel: { ...this.sel } });
    return this.replaceAll(u.text, u.sel);
  }

  redo(): Patch {
    const r = this.redos.pop();
    if (!r || this.ro) return this.patch();
    this.undos.push({ text: this.t, sel: { ...this.sel } });
    return this.replaceAll(r.text, r.sel);
  }

  toggle_todo(_line: number): Patch {
    return this.patch();
  }

  set_read_only(ro: boolean): void {
    this.ro = ro;
  }

  apply_remote(edits: Edit[]): Patch {
    let { anchor, head } = this.sel;
    for (const e of edits) {
      const map = (p: number) => (p <= e.from ? p : p >= e.to ? p + e.insert.length - (e.to - e.from) : e.from + e.insert.length);
      anchor = map(anchor);
      head = map(head);
      this.t = this.t.slice(0, e.from) + e.insert + this.t.slice(e.to);
    }
    this.sel = { anchor, head };
    return this.patch();
  }

  // -----------------------------------------------------------------------------------------------

  private range(): [number, number] {
    return [Math.min(this.sel.anchor, this.sel.head), Math.max(this.sel.anchor, this.sel.head)];
  }

  private lineOf(p: number): [number, number] {
    const from = this.t.lastIndexOf("\n", p - 1) + 1;
    const nl = this.t.indexOf("\n", p);
    return [from, nl < 0 ? this.t.length : nl];
  }

  private move(p: number, extend: boolean): Patch {
    this.goalX = null;
    return { ...this.select(extend ? this.sel.anchor : p, p), scroll: "caret" };
  }

  private select(anchor: number, head: number): Patch {
    const len = this.t.length;
    this.sel = { anchor: Math.max(0, Math.min(len, anchor)), head: Math.max(0, Math.min(len, head)) };
    return this.patch();
  }

  private edit(from: number, to: number, insert: string): Patch {
    this.undos.push({ text: this.t, sel: { ...this.sel } });
    this.redos = [];
    this.goalX = null;
    this.t = this.t.slice(0, from) + insert + this.t.slice(to);
    this.sel = { anchor: from + insert.length, head: from + insert.length };
    return this.patch([{ from, to, insert }], "caret");
  }

  private replaceAll(text: string, sel: Sel): Patch {
    const old = this.t;
    let a = 0;
    while (a < old.length && a < text.length && old[a] === text[a]) a++;
    let b = 0;
    while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
    this.t = text;
    this.sel = sel;
    return this.patch([{ from: a, to: old.length - b, insert: text.slice(a, text.length - b) }], "caret");
  }

  private views(): LineViewJs[] {
    const out: LineViewJs[] = [];
    let from = 0;
    const lines = this.t.split("\n");
    lines.forEach((text, index) => {
      const to = from + text.length;
      const active = this.sel.head >= from && this.sel.head <= to;
      out.push({
        key: "k" + index + ":" + text,
        len: text.length,
        textFrom: 0,
        text,
        kind: "Paragraph",
        level: 0,
        checked: false,
        number: 0,
        indent: 0,
        gutterLevels: 0,
        active,
        revealed: false,
        collapsed: false,
        code: null,
        table: null,
        segments: text.length ? [{ kind: "Text", from: 0, to: text.length, styles: [], hidden: false, token: null, cell: null, el: null }] : [],
        images: [],
        imageOnly: false,
      });
      from = to + 1;
    });
    return out;
  }

  private patch(edits?: Edit[], scroll?: Patch["scroll"]): Patch {
    const next = this.views();
    const prev = this.prev;
    const same = (a: LineViewJs, b: LineViewJs) => JSON.stringify(a) === JSON.stringify(b);
    let s = 0;
    while (s < next.length && s < prev.length && same(next[s]!, prev[s]!)) s++;
    let e = 0;
    while (e < next.length - s && e < prev.length - s && same(next[next.length - 1 - e]!, prev[prev.length - 1 - e]!)) e++;
    this.prev = next;
    const p: Patch = { sel: { ...this.sel } };
    if (s < next.length - e || s < prev.length - e) p.lines = { start: s, deleteCount: prev.length - e - s, insert: next.slice(s, next.length - e) };
    if (edits) p.edits = edits;
    if (scroll) p.scroll = scroll;
    if (this.composing) p.composing = true;
    return p;
  }
}

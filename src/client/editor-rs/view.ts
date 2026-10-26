// The Rust-engine editor view: the engine owns the text model, selection, reveal, navigation and history; this
// shell renders its line views into the same contenteditable DOM as the TS editor, answers its layout questions
// from that DOM, feeds it input, and mirrors its edits into the shared Y.Text (phase A/B of the Rust engine plan).

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { ImageResolver } from "../editor/images.ts";
import { collectImages, type ImagePool } from "../editor/render.ts";
import { rawToDom, domToRaw } from "../editor/offsets.ts";
import { lineAt } from "../editor/parser.ts";
import { type Rect, caretRect } from "../editor/geometry.ts";
import { RemoteCursors, type CursorHost } from "../editor/cursors.ts";
import { sigOf, toRLine, type RLine } from "./lineview.ts";
import { applyLineReveal, renderRLine, type RLineDiv } from "./render.ts";
import { DomLayout, scrollBy, scrollToEdge, visibleBounds } from "./layout.ts";
import { attachRustInput } from "./input.ts";
import type { Edit, Engine, EngineFactory, LineViewJs, Patch, PatchLines } from "./types.ts";

export interface RustViewOptions {
  ytext: Y.Text;
  awareness: Awareness;
  readOnly?: boolean;
  images?: ImageResolver;
  engine: EngineFactory;
}

export interface Sel {
  anchor: number;
  head: number;
}

interface LineSpan {
  from: number;
  to: number;
}

export class RustEditorView implements CursorHost {
  readonly wrapper: HTMLDivElement;
  readonly root: HTMLDivElement;
  readonly overlay: HTMLDivElement;
  readonly ytext: Y.Text;
  readonly ydoc: Y.Doc;
  readonly awareness: Awareness;
  readonly readOnly: boolean;
  readonly images: ImageResolver | undefined;
  /** Origin of every local transaction. */
  readonly origin = { editor: "rust" };
  readonly engine: Engine;
  readonly layout: DomLayout;

  /** The text as the engine has it, with absolute line spans (for the offset mapping and the cursor layer). */
  doc: { text: string; lines: LineSpan[] } = { text: "", lines: [] };
  /** The engine's line views, line-relative. */
  lines: RLine[] = [];
  sel: Sel = { anchor: 0, head: 0 };
  composing = false;
  /** The DOM is behind `lines` (changes held back during composition, or drift): reconcile when possible. */
  private domStale = false;
  private cursors: RemoteCursors;
  private mo: MutationObserver;
  private detachInput: () => void;
  private pubTimer: ReturnType<typeof setTimeout> | null = null;
  private pubDirty = false;
  private destroyed = false;
  private resizeObs: ResizeObserver | null = null;

  constructor(
    readonly container: HTMLElement,
    opts: RustViewOptions,
  ) {
    this.ytext = opts.ytext;
    const ydoc = opts.ytext.doc;
    if (!ydoc) throw new Error("mountRustEditor: ytext must belong to a Y.Doc");
    this.ydoc = ydoc;
    this.awareness = opts.awareness;
    this.readOnly = !!opts.readOnly;
    this.images = opts.images;

    this.wrapper = document.createElement("div");
    this.wrapper.className = "mde";
    this.wrapper.dataset.engine = "rust";
    // for tests and debugging (the engine and the raw text from the page)
    (this.wrapper as HTMLDivElement & { mdeView?: RustEditorView }).mdeView = this;
    this.root = document.createElement("div");
    this.root.className = "mde-content";
    this.root.contentEditable = "true";
    this.root.spellcheck = true;
    this.root.setAttribute("role", "textbox");
    this.root.setAttribute("aria-multiline", "true");
    if (this.readOnly) {
      this.root.contentEditable = "false";
      this.root.tabIndex = 0;
      this.root.setAttribute("aria-readonly", "true");
      this.wrapper.classList.add("readonly");
    }
    this.overlay = document.createElement("div");
    this.overlay.className = "mde-cursors";
    this.overlay.setAttribute("aria-hidden", "true");
    this.wrapper.append(this.root, this.overlay);
    container.appendChild(this.wrapper);

    const text = this.ytext.toString();
    this.doc = { text, lines: [] };
    this.engine = opts.engine(text);
    if (this.readOnly) this.engine.set_read_only(true);
    this.layout = new DomLayout(this);
    this.cursors = new RemoteCursors(this);

    this.mo = new MutationObserver((recs) => this.onMutations(recs));
    this.mo.observe(this.root, { childList: true, characterData: true, subtree: true });

    this.renderAll();
    this.ytext.observe(this.onYText);
    this.awareness.on("change", this.onAwareness);
    this.detachInput = attachRustInput(this);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.cursors.schedule());
      this.resizeObs.observe(this.root);
    }
    window.addEventListener("resize", this.onResize);
    this.root.addEventListener("scroll", this.onResize);
    document.fonts?.ready.then(() => !this.destroyed && this.cursors.schedule());
  }

  // ---------------------------------------------------------------------------------------------
  // Patches

  /** Rebuild everything from the engine (initial mount, or recovering from a mismatch). */
  renderAll(): void {
    this.doc.text = this.engine.text();
    const p = this.engine.render_all();
    const lines = p.lines ?? { start: 0, deleteCount: 0, insert: [] };
    this.lines = [];
    this.root.replaceChildren();
    this.apply({ ...p, edits: null, lines: { start: 0, deleteCount: 0, insert: lines.insert } }, { remote: [] });
  }

  /**
   * Apply a patch from the engine: text edits (mirrored into the Y.Text unless they came from it), the line
   * splice, the selection and scrolling.
   */
  apply(p: Patch | undefined, opts: { remote?: Edit[] } = {}): void {
    if (!p || this.destroyed) return;
    // remote patches: the text edits came from the Y.Text and are already in doc.text
    const edits = opts.remote ?? p.edits;
    if (!opts.remote && edits?.length) {
      this.doc.text = applyEdits(this.doc.text, edits);
      this.pushToY(edits);
    }
    if (p.lines) this.splice(p.lines);
    if (!this.updateSpans()) {
      // the engine and the shell disagree about the text: resync from the engine
      console.error("rust editor: line views don't match the text; re-rendering");
      this.renderAll();
      this.syncY();
      return;
    }
    if (edits?.length && !this.composing) this.refreshChanged(edits);
    if (this.domStale && !this.composing) this.reconcile();
    const len = this.doc.text.length;
    this.sel = { anchor: clamp(p.sel.anchor, len), head: clamp(p.sel.head, len) };
    if (!this.composing) this.writeDomSel();
    if (p.scroll === "caret") this.scrollCaretIntoView();
    else if (p.scroll === "start" || p.scroll === "end") scrollToEdge(this.wrapper, p.scroll === "start" ? -1 : 1);
    this.publishCursor();
    this.cursors.schedule();
  }

  private splice(pl: PatchLines): void {
    const start = Math.max(0, Math.min(this.lines.length, pl.start));
    const del = Math.max(0, Math.min(this.lines.length - start, pl.deleteCount));
    const ins = pl.insert.map((lv: LineViewJs) => toRLine(lv, lv.text));
    this.lines.splice(start, del, ...ins);
    if (this.composing || this.domStale || this.root.children.length !== this.lines.length - ins.length + del) {
      this.domStale = true;
      return;
    }
    const kids: RLineDiv[] = [];
    for (let i = start; i < start + del; i++) kids.push(this.root.children[i] as RLineDiv);
    const ref = this.root.children[start + del] ?? null;
    // reuse divs whose structure didn't change (only reveal, or only the line's position): in place first
    const reused: (RLineDiv | undefined)[] = ins.map((l, i) => (kids[i] && kids[i]._sig === l.sig ? kids[i] : undefined));
    const taken = new Set(reused);
    const pool = new Map<string, RLineDiv[]>();
    for (const k of kids) {
      if (taken.has(k)) continue;
      const list = pool.get(k._sig ?? "");
      if (list) list.push(k);
      else pool.set(k._sig ?? "", [k]);
    }
    ins.forEach((l, i) => {
      if (reused[i]) return;
      const d = pool.get(l.sig)?.shift();
      if (d) {
        reused[i] = d;
        taken.add(d);
      }
    });
    // images of replaced lines move into their new lines instead of loading again
    const images: ImagePool = new Map();
    for (const k of kids) {
      if (taken.has(k)) continue;
      collectImages(k, images);
      k.remove();
    }
    let from = 0;
    for (let i = 0; i < start; i++) from += this.lines[i]!.len + 1;
    // place the lines in order, moving only divs that aren't already where they belong
    let cursor: Element | null = this.root.children[start] ?? ref;
    ins.forEach((l, i) => {
      const div = reused[i] ?? renderRLine(l, this.doc.text.slice(from, from + l.len), { images: this.images, reuse: images });
      from += l.len + 1;
      applyLineReveal(div, l);
      if (div === cursor) cursor = cursor.nextElementSibling;
      else this.root.insertBefore(div, cursor);
    });
    this.mo.takeRecords();
  }

  /** Recompute absolute line spans; false if they don't add up to the text. */
  private updateSpans(): boolean {
    const spans: LineSpan[] = new Array(this.lines.length);
    let pos = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const len = this.lines[i]!.len;
      spans[i] = { from: pos, to: pos + len };
      pos += len + 1;
    }
    this.doc.lines = spans;
    return this.lines.length > 0 && pos - 1 === this.doc.text.length;
  }

  /**
   * Lines whose text changed while their view stayed the same (e.g. a letter replaced by another): rebuild
   * them. Only lines touched by `edits` (applied in order) are checked.
   */
  private refreshChanged(edits: Edit[]): void {
    const kids = this.root.children;
    if (kids.length !== this.lines.length) {
      this.domStale = true;
      return;
    }
    // unchanged prefix [0, lo) and suffix (the last `tail` characters) of the text
    let lo = Infinity;
    let tail = Infinity;
    let len = this.doc.text.length;
    for (let i = edits.length - 1; i >= 0; i--) len -= edits[i]!.insert.length - (edits[i]!.to - edits[i]!.from);
    for (const e of edits) {
      len += e.insert.length - (e.to - e.from);
      lo = Math.min(lo, e.from);
      tail = Math.min(tail, len - e.from - e.insert.length);
    }
    const hi = this.doc.text.length - tail;
    for (let i = lineAt(this.doc.lines, lo); i < this.lines.length && this.doc.lines[i]!.from <= hi; i++) {
      const l = this.lines[i]!;
      const span = this.doc.lines[i]!;
      const div = kids[i] as RLineDiv;
      const text = this.doc.text.slice(span.from, span.to);
      const sig = sigOf(l, text);
      if (div._sig === sig) continue;
      const fresh = { ...l, sig };
      this.lines[i] = fresh;
      const nd = renderRLine(fresh, text, { images: this.images });
      applyLineReveal(nd, fresh);
      div.replaceWith(nd);
    }
    this.mo.takeRecords();
  }

  /** Make the DOM match `lines`: rebuild lines whose div is missing or different, drop anything else. */
  reconcile(): void {
    this.domStale = false;
    // line views whose text changed without a new view (held back during composition) get their current text
    for (let i = 0; i < this.lines.length; i++) {
      const span = this.doc.lines[i];
      if (!span) break;
      const l = this.lines[i]!;
      const sig = sigOf(l, this.doc.text.slice(span.from, span.to));
      if (sig !== l.sig) this.lines[i] = { ...l, sig };
    }
    for (const n of Array.from(this.root.childNodes)) {
      if (n.nodeType !== 1 || (n as RLineDiv)._sig === undefined) n.remove();
    }
    const kids = Array.from(this.root.children) as RLineDiv[];
    const lines = this.lines;
    const n = lines.length;
    const m = kids.length;
    let s = 0;
    while (s < n && s < m && kids[s]!._sig === lines[s]!.sig) s++;
    let e = 0;
    while (e < n - s && e < m - s && kids[m - 1 - e]!._sig === lines[n - 1 - e]!.sig) e++;
    const ref = kids[m - e] ?? null;
    const images: ImagePool = new Map();
    for (let i = s; i < m - e; i++) {
      collectImages(kids[i]!, images);
      kids[i]!.remove();
    }
    const frag = document.createDocumentFragment();
    for (let i = s; i < n - e; i++) {
      const span = this.doc.lines[i];
      const text = span ? this.doc.text.slice(span.from, span.to) : "";
      frag.appendChild(renderRLine(lines[i]!, text, { images: this.images, reuse: images }));
    }
    this.root.insertBefore(frag, ref);
    const divs = this.root.children;
    for (let i = 0; i < n; i++) applyLineReveal(divs[i] as RLineDiv, lines[i]!);
    this.mo.takeRecords();
    this.cursors.schedule();
  }

  private onMutations(recs: MutationRecord[]): void {
    if (!recs.length) return;
    // lines the browser changed (IME composition, or something we didn't intercept) are rebuilt from the model
    for (const r of recs) {
      let n: Node | null = r.target;
      while (n && n.parentNode !== this.root) n = n.parentNode;
      if (n && n.nodeType === 1) (n as RLineDiv)._sig = "";
    }
    this.domStale = true;
    if (this.composing) return;
    this.reconcile();
    this.writeDomSel();
  }

  /** Composition ended with `data` committed: the browser's composed DOM gets replaced by the engine's lines. */
  finishComposition(data: string): void {
    this.composing = false;
    if (data && !this.readOnly) {
      // the engine takes the commit as the composition's text (replacing the selection it started with)
      const p = this.engine.insert_text(data);
      this.engine.end_composition();
      this.apply(p);
    } else {
      this.engine.end_composition();
      // a composition that removed the selection and committed nothing (like the TS editor: the selection goes)
      if (!this.readOnly && this.sel.anchor !== this.sel.head) this.apply(this.engine.cut().patch);
      else this.apply(this.engine.set_selection(this.sel.anchor, this.sel.head));
    }
    if (this.domStale) this.reconcile();
    this.writeDomSel();
  }

  // ---------------------------------------------------------------------------------------------
  // Yjs

  private pushToY(edits: Edit[]): void {
    this.ydoc.transact(() => {
      for (const e of edits) {
        if (e.to > e.from) this.ytext.delete(e.from, e.to - e.from);
        if (e.insert) this.ytext.insert(e.from, e.insert);
      }
    }, this.origin);
    if (this.ytext.length !== this.doc.text.length) this.syncY();
  }

  /** Last resort when the Y.Text and the engine disagree: make the Y.Text match the engine's text. */
  private syncY(): void {
    const want = this.engine.text();
    const have = this.ytext.toString();
    if (want === have) return;
    console.error("rust editor: Y.Text out of sync with the engine; resyncing");
    let a = 0;
    while (a < want.length && a < have.length && want[a] === have[a]) a++;
    let b = 0;
    while (b < want.length - a && b < have.length - a && want[want.length - 1 - b] === have[have.length - 1 - b]) b++;
    this.ydoc.transact(() => {
      if (have.length - b > a) this.ytext.delete(a, have.length - b - a);
      if (want.length - b > a) this.ytext.insert(a, want.slice(a, want.length - b));
    }, this.origin);
  }

  private onYText = (ev: Y.YTextEvent, tr: Y.Transaction) => {
    if (tr.origin === this.origin) return;
    const edits = deltaToEdits(ev.delta as DeltaOp[]);
    if (!edits.length) return;
    this.doc.text = applyEdits(this.doc.text, edits);
    this.apply(this.engine.apply_remote(edits), { remote: edits });
  };

  private onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const me = this.awareness.clientID;
    if ([...added, ...updated, ...removed].some((id) => id !== me)) this.cursors.schedule();
  };

  private onResize = () => this.cursors.schedule();

  /**
   * Relative positions that don't move with text inserted at them by others: a caret sticks to the
   * character before it; a selection's start sticks right and its end left (so it doesn't grow).
   */
  private toRel(sel: Sel): { anchor: Y.RelativePosition; head: Y.RelativePosition } {
    const rel = (i: number, assoc: number) => Y.createRelativePositionFromTypeIndex(this.ytext, i, assoc);
    const collapsed = sel.anchor === sel.head;
    const fwd = sel.anchor <= sel.head;
    return { anchor: rel(sel.anchor, collapsed || !fwd ? -1 : 0), head: rel(sel.head, collapsed || fwd ? -1 : 0) };
  }

  // ---------------------------------------------------------------------------------------------
  // Selection

  hasFocus(): boolean {
    return document.activeElement === this.root;
  }

  /** Set the selection through the engine (snapped by it), like a programmatic selection change. */
  setSel(sel: Sel, _opts?: unknown): void {
    this.apply(this.engine.set_selection(sel.anchor, sel.head));
  }

  writeDomSel(): void {
    if (!this.hasFocus()) return;
    const s = document.getSelection();
    if (!s || this.root.children.length !== this.lines.length) return;
    const a = rawToDom(this.root, this.doc, this.sel.anchor);
    const h = this.sel.anchor === this.sel.head ? a : rawToDom(this.root, this.doc, this.sel.head);
    if (s.anchorNode === a.node && s.anchorOffset === a.offset && s.focusNode === h.node && s.focusOffset === h.offset) return;
    s.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
  }

  readDomSel(): Sel | null {
    const s = document.getSelection();
    if (!s || !s.anchorNode || !s.focusNode) return null;
    if (!this.root.contains(s.anchorNode) || !this.root.contains(s.focusNode)) return null;
    if (this.root.children.length !== this.lines.length) return null;
    const a = domToRaw(this.root, this.doc, s.anchorNode, s.anchorOffset);
    const h = domToRaw(this.root, this.doc, s.focusNode, s.focusOffset);
    if (a === null || h === null) return null;
    return { anchor: a, head: h };
  }

  readRange(node: Node, offset: number): number | null {
    return domToRaw(this.root, this.doc, node, offset);
  }

  focus(): void {
    this.root.focus({ preventScroll: true });
    this.writeDomSel();
  }

  private publishCursor(): void {
    if (this.pubTimer) {
      this.pubDirty = true;
      return;
    }
    this.doPublish();
    this.pubTimer = setTimeout(() => {
      this.pubTimer = null;
      if (this.pubDirty) {
        this.pubDirty = false;
        this.doPublish();
      }
    }, 50);
  }

  /** Called on focus/blur: show our cursor to others only while focused. */
  setPresence(focused: boolean): void {
    if (focused) {
      this.doPublish();
    } else if (this.awareness.getLocalState()) {
      if (this.pubTimer) clearTimeout(this.pubTimer);
      this.pubTimer = null;
      this.pubDirty = false;
      this.awareness.setLocalStateField("cursor", null);
    }
  }

  private doPublish(): void {
    if (this.destroyed || !this.awareness.getLocalState() || !this.hasFocus()) return;
    const rel = this.toRel(this.sel);
    this.awareness.setLocalStateField("cursor", {
      anchor: Y.relativePositionToJSON(rel.anchor),
      head: Y.relativePositionToJSON(rel.head),
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Geometry (client coordinates, for the cursor layer)

  caretRect(pos: number): Rect {
    return caretRect(this.root, this.doc, pos);
  }

  /** Client rects covering the raw range [from, to). */
  rangeRects(from: number, to: number): DOMRect[] {
    if (this.root.children.length !== this.lines.length) return [];
    const a = rawToDom(this.root, this.doc, from);
    const b = rawToDom(this.root, this.doc, to);
    const range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch {
      return [];
    }
    const out: DOMRect[] = [];
    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
    const sub = document.createRange();
    const first = lineAt(this.doc.lines, from);
    const startLine = this.root.children[first];
    if (startLine) walker.currentNode = startLine;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n)) {
        if (range.comparePoint(n, 0) > 0) break;
        continue;
      }
      if (n.parentElement?.closest(".imgs")) continue;
      const len = (n as Text).length;
      const s = n === range.startContainer ? range.startOffset : 0;
      const e = n === range.endContainer ? range.endOffset : len;
      if (e <= s) continue;
      sub.setStart(n, s);
      sub.setEnd(n, e);
      for (const r of sub.getClientRects()) if (r.width > 0.5 && r.height > 1) out.push(r);
    }
    // collapsed images entirely in the range: their source shows nothing, so the image itself is highlighted
    for (let li = first; li < this.lines.length && this.doc.lines[li]!.from <= to; li++) {
      const base = this.doc.lines[li]!.from;
      const line = this.lines[li]!;
      for (const box of this.root.children[li]?.querySelectorAll<HTMLElement>(".imgbox") ?? []) {
        const f = Number(box.dataset.from);
        const t = Number(box.dataset.at);
        if (base + f < from || base + t > to) continue;
        if (line.images.find((im) => im.from === f)?.revealed) continue;
        const r = box.getBoundingClientRect();
        if (r.width > 0.5 && r.height > 1) out.push(r);
      }
    }
    return out;
  }

  scrollCaretIntoView(): void {
    if (!this.hasFocus()) return;
    const r = this.caretRect(this.sel.head);
    if (r.bottom === 0 && r.top === 0) return;
    const [vt, vb] = visibleBounds(this.wrapper);
    const m = 12;
    if (r.top < vt + m) scrollBy(this.wrapper, r.top - vt - m);
    else if (r.bottom > vb - m) scrollBy(this.wrapper, r.bottom - vb + m);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.detachInput();
    this.ytext.unobserve(this.onYText);
    this.awareness.off("change", this.onAwareness);
    this.mo.disconnect();
    this.resizeObs?.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.root.removeEventListener("scroll", this.onResize);
    this.cursors.destroy();
    if (this.pubTimer) clearTimeout(this.pubTimer);
    if (this.awareness.getLocalState()) this.awareness.setLocalStateField("cursor", null);
    this.engine.free?.();
    this.wrapper.remove();
  }
}

const clamp = (p: number, len: number) => Math.max(0, Math.min(len, p));

/** Apply edits in order (each one's offsets are in the text left by the previous ones). */
export function applyEdits(text: string, edits: Edit[]): string {
  for (const e of edits) text = text.slice(0, e.from) + e.insert + text.slice(e.to);
  return text;
}

export type DeltaOp = { retain?: number; delete?: number; insert?: string | object };

/** A Y.Text delta as edits in order (a deletion followed by an insertion at the same place becomes one edit). */
export function deltaToEdits(delta: DeltaOp[]): Edit[] {
  const out: Edit[] = [];
  let pos = 0;
  for (const d of delta) {
    if (d.retain) pos += d.retain;
    else if (d.delete) out.push({ from: pos, to: pos + d.delete, insert: "" });
    else if (d.insert !== undefined) {
      const s = typeof d.insert === "string" ? d.insert : "\ufffc";
      const prev = out[out.length - 1];
      if (prev && prev.from === pos && prev.insert === "") prev.insert = s;
      else out.push({ from: pos, to: pos, insert: s });
      pos += s.length;
    }
  }
  return out;
}

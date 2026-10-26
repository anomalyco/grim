// The editor view: owns the parsed document, the local selection, the DOM, and the Yjs binding.

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { type BlockType, type Doc, type Line, parseDoc, lineAt, literalLine, trimRange } from "./parser.ts";
import { type ImagePool, type LineDiv, renderLine, lineKey, applyReveal, collectImages, isImageLine } from "./render.ts";
import { computeReveal, type LineReveal } from "./reveal.ts";
import { rawToDom, domToRaw } from "./offsets.ts";
import { type Sel, snapSel, caret } from "./units.ts";
import { type Edit } from "./rules.ts";
import { History, type RelSel } from "./history.ts";
import type { ImageResolver } from "./images.ts";
import { RemoteCursors } from "./cursors.ts";
import { attachInput } from "./input.ts";

export interface Rect {
  left: number;
  top: number;
  bottom: number;
}

/** A line shown literally after its auto-conversion was undone (local view state only). */
interface Literal {
  /** Start of the line. */
  rel: Y.RelativePosition;
  /** The line's text when it was suppressed; any change to it ends the literal state. */
  text: string;
  /** Block type before the conversion (a todo converted from a bullet stays a bullet). */
  from: BlockType;
  /** Selection right after the conversion, restored by undo/redo of the mark. */
  sel: RelSel;
}

export interface ViewOptions {
  ytext: Y.Text;
  awareness: Awareness;
  readOnly?: boolean;
  /** Where images load from (default: only http(s) and data:image URLs). */
  images?: ImageResolver;
}

export class EditorView {
  readonly wrapper: HTMLDivElement;
  readonly root: HTMLDivElement;
  readonly overlay: HTMLDivElement;
  readonly ytext: Y.Text;
  readonly ydoc: Y.Doc;
  readonly awareness: Awareness;
  readonly readOnly: boolean;
  readonly images: ImageResolver | undefined;
  /** Origin of every local transaction. */
  readonly origin = { editor: true };
  readonly history: History<Literal>;

  doc: Doc;
  sel: Sel = caret(0);
  goalX: number | null = null;
  composing = false;
  compRel: RelSel | null = null;

  private selRel: RelSel;
  private pendingSel: Sel | null = null;
  private undoInserted: [number, number] | null = null;
  /** Position right after an auto-inserted "> ": a space typed there next is swallowed. */
  swallowSpaceAt: number | null = null;
  private lastEditRel: Y.RelativePosition | null = null;
  private reveal = new Map<number, LineReveal>();
  private revealedDivs = new Set<LineDiv>();
  private literals = new Set<Literal>();
  /** Last single click (adjusted hit-test at mousedown), consumed by the next selectionchange. */
  lastClick: { pos: number; time: number } | null = null;
  /** Raw position of the first click of the current click sequence. */
  clickPos: number | null = null;
  /** Raw range of the image the first click of the current click sequence hit, if it hit one. */
  clickImage: [number, number] | null = null;
  private cursors: RemoteCursors;
  private mo: MutationObserver;
  private detachInput: () => void;
  private pubTimer: ReturnType<typeof setTimeout> | null = null;
  private pubDirty = false;
  private destroyed = false;
  private resizeObs: ResizeObserver | null = null;

  constructor(
    readonly container: HTMLElement,
    opts: ViewOptions,
  ) {
    this.ytext = opts.ytext;
    const ydoc = opts.ytext.doc;
    if (!ydoc) throw new Error("mountEditor: ytext must belong to a Y.Doc");
    this.ydoc = ydoc;
    this.awareness = opts.awareness;
    this.readOnly = !!opts.readOnly;
    this.images = opts.images;

    this.wrapper = document.createElement("div");
    this.wrapper.className = "mde";
    this.root = document.createElement("div");
    this.root.className = "mde-content";
    this.root.contentEditable = "true";
    this.root.spellcheck = true;
    this.root.setAttribute("role", "textbox");
    this.root.setAttribute("aria-multiline", "true");
    if (this.readOnly) {
      // not editable at all (no IME, no input), but focusable so selection and navigation work
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

    this.doc = parseDoc(this.ytext.toString());
    // Start at the beginning of the first line's text, after any block prefix (e.g. a heading's "# "),
    // not before the hidden token where the caret would sit out in the gutter.
    this.sel = caret(this.doc.lines[0]?.textFrom ?? 0);
    this.selRel = this.toRel(this.sel);
    this.history = new History<Literal>(
      this.ytext,
      this.origin,
      () => this.selRel,
      (s, type, kind) => this.restoreSel(s, type, kind),
      (lit, type) => this.onLiteralMark(lit, type),
      (lit, type) => (type === "undo" ? this.literalLine(parseDoc(this.ytext.toString()), lit) !== null : this.literals.has(lit)),
    );
    this.cursors = new RemoteCursors(this);

    this.mo = new MutationObserver((recs) => {
      if (this.composing || !recs.length) return;
      // the DOM drifted from the model (something we didn't intercept): rebuild it
      this.invalidate();
      this.render();
      this.writeDomSel();
    });
    this.mo.observe(this.root, { childList: true, characterData: true, subtree: true });

    this.render();
    this.ytext.observe(this.onYText);
    this.awareness.on("change", this.onAwareness);
    this.detachInput = attachInput(this);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.cursors.schedule());
      this.resizeObs.observe(this.root);
    }
    window.addEventListener("resize", this.onResize);
    // the content scrolls sideways for wide tables: remote cursors follow
    this.root.addEventListener("scroll", this.onResize);
    document.fonts?.ready.then(() => !this.destroyed && this.cursors.schedule());
  }

  // ---------------------------------------------------------------------------------------------
  // Yjs

  private onYText = (ev: Y.YTextEvent, tr: Y.Transaction) => {
    this.doc = this.parse();
    if (tr.origin === this.history.um) {
      // text re-inserted by undo/redo (selected after undoing a deletion)
      let pos = 0;
      let from = -1;
      let to = -1;
      for (const d of ev.delta) {
        if (d.retain) pos += d.retain;
        else if (d.insert) {
          const len = typeof d.insert === "string" ? d.insert.length : 1;
          if (from < 0) from = pos;
          pos += len;
          to = pos;
        }
      }
      this.undoInserted = from >= 0 ? [from, to] : null;
    }
    let sel: Sel;
    const local = tr.origin === this.origin;
    if (local && this.pendingSel) {
      sel = this.pendingSel;
      this.pendingSel = null;
    } else {
      sel = this.fromRel(this.selRel);
    }
    sel = snapSel(this.doc, sel);
    this.sel = sel;
    if (this.composing) {
      this.selRel = this.toRel(sel);
      return;
    }
    this.render();
    // undo/redo: restoreSel (stack-item-popped) places the selection
    if (tr.origin !== this.history.um) this.setSel(sel, { dom: true, scroll: local, revealed: true });
  };

  /** Parse the shared text and apply the local literal-line state. */
  private parse(): Doc {
    const doc = parseDoc(this.ytext.toString());
    for (const lit of this.literals) {
      const line = this.literalLine(doc, lit);
      if (!line) this.literals.delete(lit);
      else doc.lines[line.index] = literalLine(doc.text, line, lit.from);
    }
    return doc;
  }

  /** The line a literal mark applies to, if it still exists unchanged. */
  private literalLine(doc: Doc, lit: Literal): Line | null {
    const abs = Y.createAbsolutePositionFromRelativePosition(lit.rel, this.ydoc);
    if (!abs || abs.type !== this.ytext) return null;
    const line = doc.lines[lineAt(doc.lines, abs.index)];
    return line && line.from === abs.index && line.text === lit.text ? line : null;
  }

  private onLiteralMark(lit: Literal, type: "undo" | "redo"): void {
    if (type === "undo") this.literals.add(lit);
    else this.literals.delete(lit);
    this.doc = this.parse();
    this.sel = snapSel(this.doc, this.fromRel(lit.sel));
    this.render();
    this.setSel(this.sel, { dom: true, scroll: true, revealed: true });
  }

  private onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const me = this.awareness.clientID;
    if ([...added, ...updated, ...removed].some((id) => id !== me)) this.cursors.schedule();
  };

  private onResize = () => this.cursors.schedule();

  /**
   * Relative positions that don't move with text inserted at them by others: a caret sticks to the
   * character before it; a selection's start sticks right and its end left (so it doesn't grow).
   */
  toRel(sel: Sel): RelSel {
    const rel = (i: number, assoc: number) => Y.createRelativePositionFromTypeIndex(this.ytext, i, assoc);
    const collapsed = sel.anchor === sel.head;
    const fwd = sel.anchor <= sel.head;
    return {
      anchor: rel(sel.anchor, collapsed || !fwd ? -1 : 0),
      head: rel(sel.head, collapsed || fwd ? -1 : 0),
      abs: { anchor: sel.anchor, head: sel.head },
    };
  }

  fromRel(r: RelSel): Sel {
    const len = this.doc.text.length;
    const res = (p: Y.RelativePosition, fb: number) => {
      const a = Y.createAbsolutePositionFromRelativePosition(p, this.ydoc);
      return Math.max(0, Math.min(len, a && a.type === this.ytext ? a.index : fb));
    };
    return { anchor: res(r.anchor, r.abs.anchor), head: res(r.head, r.abs.head) };
  }

  /** Apply an edit produced by the rules as one local transaction. */
  applyEdit(e: Edit | null): void {
    if (!e || this.readOnly) return;
    this.swallowSpaceAt = null;
    this.lastClick = null;
    if (!e.changes.length) {
      this.setSel(e.sel, { dom: true, scroll: true });
      return;
    }
    const lastPos = this.lastEditRel ? Y.createAbsolutePositionFromRelativePosition(this.lastEditRel, this.ydoc) : null;
    const jumped = lastPos !== null && lastPos.index !== this.sel.head;
    const separate = e.kind === "convert" || e.kind === "paste" || e.kind === "toggle" || e.kind === "structure";
    if (jumped || separate) this.history.stop();
    this.history.selBefore = this.toRel(this.sel);
    this.history.kind = e.kind;
    this.pendingSel = e.sel;
    const changes = [...e.changes].sort((a, b) => b.from - a.from);
    this.ydoc.transact(() => {
      for (const c of changes) {
        if (c.to > c.from) this.ytext.delete(c.from, c.to - c.from);
        if (c.insert) this.ytext.insert(c.from, c.insert);
      }
    }, this.origin);
    this.pendingSel = null;
    if (separate) this.history.stop();
    this.lastEditRel = Y.createRelativePositionFromTypeIndex(this.ytext, this.sel.head, -1);
    this.goalX = null;
    if (e.converts) {
      const line = this.doc.lines[lineAt(this.doc.lines, this.sel.head)]!;
      this.history.pushMark({
        rel: Y.createRelativePositionFromTypeIndex(this.ytext, line.from),
        text: line.text,
        from: e.converts,
        sel: this.toRel(this.sel),
      });
    }
    if (e.then) this.applyEdit(e.then);
  }

  undo(): void {
    if (this.readOnly) return;
    this.undoInserted = null;
    this.history.undo(this.toRel(this.sel));
    this.lastEditRel = null;
  }

  redo(): void {
    if (this.readOnly) return;
    this.undoInserted = null;
    this.history.redo(this.toRel(this.sel));
    this.lastEditRel = null;
  }

  private restoreSel(r: RelSel | undefined, type: "undo" | "redo", kind: string): void {
    const ins = this.undoInserted;
    this.undoInserted = null;
    if (type === "undo" && kind !== "convert" && ins) {
      this.setSel({ anchor: ins[0], head: ins[1] }, { dom: true, scroll: true });
    } else if (r) {
      this.setSel(snapSel(this.doc, this.fromRel(r)), { dom: true, scroll: true });
    } else {
      this.setSel(this.sel, { dom: true, scroll: true, revealed: true });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering

  /** Forget rendered line keys so the next render rebuilds every line. */
  invalidate(): void {
    for (const el of Array.from(this.root.children)) (el as LineDiv)._key = "";
  }

  render(): void {
    const lines = this.doc.lines;
    const kids = Array.from(this.root.children) as LineDiv[];
    const n = lines.length;
    const m = kids.length;
    let s = 0;
    while (s < n && s < m && kids[s]!._key === lineKey(lines[s]!)) s++;
    let e = 0;
    while (e < n - s && e < m - s && kids[m - 1 - e]!._key === lineKey(lines[n - 1 - e]!)) e++;
    const ref = kids[m - e] ?? null;
    // images of replaced lines move into their new lines instead of loading again
    const reuse: ImagePool = new Map();
    for (let i = s; i < m - e; i++) {
      collectImages(kids[i]!, reuse);
      kids[i]!.remove();
    }
    if (s < n - e) {
      const frag = document.createDocumentFragment();
      for (let i = s; i < n - e; i++) frag.appendChild(renderLine(lines[i]!, this.doc.text, { images: this.images, reuse }));
      this.root.insertBefore(frag, ref);
    }
    this.updateReveal();
    this.mo.takeRecords();
    this.cursors.schedule();
  }

  /** Recompute reveal for the local selection; only lines revealed before or now are touched. */
  private updateReveal(): void {
    const next = computeReveal(this.doc, this.sel);
    const divs = this.root.children;
    const now = new Set<LineDiv>();
    for (const [i, r] of next) {
      const d = divs[i] as LineDiv | undefined;
      if (!d) continue;
      applyReveal(d, r);
      now.add(d);
    }
    for (const d of this.revealedDivs) if (!now.has(d) && d.isConnected) applyReveal(d, undefined);
    this.revealedDivs = now;
    this.reveal = next;
  }

  // ---------------------------------------------------------------------------------------------
  // Selection

  setSel(sel: Sel, opts: { dom?: boolean; scroll?: boolean; keepGoal?: boolean; revealed?: boolean } = {}): void {
    const len = this.doc.text.length;
    sel = { anchor: Math.max(0, Math.min(len, sel.anchor)), head: Math.max(0, Math.min(len, sel.head)) };
    this.sel = sel;
    this.selRel = this.toRel(sel);
    if (this.swallowSpaceAt !== null && (sel.head !== this.swallowSpaceAt || sel.anchor !== sel.head)) this.swallowSpaceAt = null;
    if (!opts.keepGoal) this.goalX = null;
    if (!opts.revealed) this.updateReveal();
    if (opts.dom) this.writeDomSel();
    if (opts.scroll) this.scrollCaretIntoView();
    this.publishCursor();
    this.cursors.schedule();
  }

  hasFocus(): boolean {
    return document.activeElement === this.root;
  }

  writeDomSel(): void {
    if (!this.hasFocus()) return;
    const s = document.getSelection();
    if (!s) return;
    const a = rawToDom(this.root, this.doc, this.sel.anchor);
    const h = this.sel.anchor === this.sel.head ? a : rawToDom(this.root, this.doc, this.sel.head);
    if (
      s.anchorNode === a.node &&
      s.anchorOffset === a.offset &&
      s.focusNode === h.node &&
      s.focusOffset === h.offset
    )
      return;
    s.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
  }

  /** Read the DOM selection as raw offsets (null if it isn't in the editor). */
  readDomSel(): Sel | null {
    const s = document.getSelection();
    if (!s || !s.anchorNode || !s.focusNode) return null;
    if (!this.root.contains(s.anchorNode) || !this.root.contains(s.focusNode)) return null;
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
    this.awareness.setLocalStateField("cursor", {
      anchor: Y.relativePositionToJSON(this.selRel.anchor),
      head: Y.relativePositionToJSON(this.selRel.head),
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Geometry

  lineDiv(li: number): HTMLElement | null {
    return (this.root.children[li] as HTMLElement | undefined) ?? null;
  }

  /** Client rect of a caret at raw offset `pos`. */
  caretRect(pos: number): Rect {
    const p = rawToDom(this.root, this.doc, pos);
    const range = document.createRange();
    range.setStart(p.node, p.offset);
    range.collapse(true);
    const rects = range.getClientRects();
    const r = rects[0];
    if (r && r.height > 1) return { left: r.left, top: r.top, bottom: r.bottom };
    const li = lineAt(this.doc.lines, pos);
    const div = this.lineDiv(li);
    const lineBox = (): { top: number; bottom: number } => {
      if (!div) return { top: 0, bottom: 0 };
      // table rows: the cell's box (its padding) rather than the row's
      const anchor = p.node.nodeType === 1 ? (p.node as Element) : p.node.parentElement;
      const box = (div.classList.contains("ln-table") && anchor?.closest(".tcell")) || div;
      const dr = box.getBoundingClientRect();
      const cs = getComputedStyle(box);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
      const top = dr.top + (parseFloat(cs.paddingTop) || 0);
      // collapsed lines (e.g. a hidden code fence) are shorter than one line height
      return { top, bottom: Math.min(top + lh, dr.bottom) };
    };
    let el: Element | null = null;
    let atRight = false;
    if (p.node.nodeType === 3) el = p.node.parentElement;
    else {
      const at = p.node.childNodes[p.offset];
      // the end of a line with images is after its text, not at the images below it
      const child = at && at.nodeType === 1 && (at as Element).classList.contains("imgs") ? undefined : at;
      if (child && child.nodeType === 1 && (child as Element).tagName !== "BR") el = child as Element;
      else if (child && (child as Element).tagName === "BR") {
        const br = (child as Element).getBoundingClientRect();
        if (br.height > 1) return { left: br.left, top: br.top, bottom: br.bottom };
        const prev = child.previousSibling;
        if (prev && prev.nodeType === 1) {
          el = prev as Element;
          atRight = true;
        }
      } else if (p.offset > 0 && p.node.childNodes[p.offset - 1]?.nodeType === 1) {
        el = p.node.childNodes[p.offset - 1] as Element;
        atRight = true;
      }
    }
    if (el && el !== div) {
      const er = el.getBoundingClientRect();
      if (er.height > 1 && !el.classList.contains("mk")) {
        return { left: atRight ? er.right : er.left, top: er.top, bottom: er.bottom };
      }
      // a collapsed marker has no height but sits on its visual line's baseline: on a wrapped line, that's
      // not necessarily the first one
      const lb = (div && !div.classList.contains("ln-table") && this.visualLineAt(div, er.top)) || lineBox();
      return { left: atRight ? er.right : er.left, ...lb };
    }
    const lb = lineBox();
    if (!div) return { left: 0, ...lb };
    const dr = div.getBoundingClientRect();
    const cs = getComputedStyle(div);
    return { left: dr.left + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.textIndent) || 0), ...lb };
  }

  /** Top and bottom of the visual line of a line's text (not its images) that contains `y`, if any. */
  private visualLineAt(div: HTMLElement, y: number): { top: number; bottom: number } | null {
    const range = document.createRange();
    let best: { top: number; bottom: number } | null = null;
    for (const child of div.children) {
      if (child.classList.contains("imgs")) continue;
      range.selectNodeContents(child);
      for (const r of range.getClientRects()) {
        if (r.height <= 1 || y < r.top - 0.5 || y > r.bottom + 0.5) continue;
        // the tallest box on that line (a heading's text rather than a small marker)
        if (!best || r.bottom - r.top > best.bottom - best.top) best = { top: r.top, bottom: r.bottom };
      }
    }
    return best;
  }

  /** Client rects covering the raw range [from, to). */
  rangeRects(from: number, to: number): DOMRect[] {
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
    const startLine = this.lineDiv(lineAt(this.doc.lines, from));
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
    const lines = this.doc.lines;
    for (let li = lineAt(lines, from); li < lines.length && lines[li]!.from <= to; li++) {
      const line = lines[li]!;
      const rv = this.reveal.get(li)?.els ?? [];
      for (const box of this.lineDiv(li)?.querySelectorAll<HTMLElement>(".imgbox") ?? []) {
        const a = line.from + Number(box.dataset.from);
        const b = line.from + Number(box.dataset.at);
        if (a < from || b > to) continue;
        const k = line.inline.findIndex((el) => el.type === "image" && el.from === a);
        if (k >= 0 && rv.includes(k)) continue;
        const r = box.getBoundingClientRect();
        if (r.width > 0.5 && r.height > 1) out.push(r);
      }
    }
    return out;
  }

  /** Raw offset at a client point, hit-tested in the current layout. */
  hitTest(x: number, y: number): number | null {
    const d = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (d.caretPositionFromPoint) {
      const p = d.caretPositionFromPoint(x, y);
      if (p) {
        node = p.offsetNode;
        offset = p.offset;
      }
    } else if (d.caretRangeFromPoint) {
      const r = d.caretRangeFromPoint(x, y);
      if (r) {
        node = r.startContainer;
        offset = r.startOffset;
      }
    }
    if (!node) return null;
    return domToRaw(this.root, this.doc, node, offset);
  }

  /**
   * Hit-test in the current layout, then fix up the line edges: past the end of a line's last visible
   * character the caret goes to the line end (after collapsed closing markers); left of the first
   * visible character it goes to the text start (before collapsed opening markers).
   */
  hitTestAdjusted(x: number, y: number): number | null {
    const pos = this.hitTest(x, y);
    if (pos === null) return null;
    const line = this.doc.lines[lineAt(this.doc.lines, pos)]!;
    if (line.table) return this.tableHit(line, pos, x, y);
    if (pos < line.to && this.onlyHidden(line, pos, line.to) && x > this.caretRect(pos).left + 1) return line.to;
    if (pos > line.textFrom && this.onlyHidden(line, line.textFrom, pos) && x < this.caretRect(pos).left - 1) {
      return line.textFrom;
    }
    return pos;
  }

  /**
   * Table hits are resolved per cell (the cell under the point, or the first/last cell when the point
   * is left/right of the row). In a collapsed table, hits on hidden pipes/padding land in that cell's
   * text, and a hit on the collapsed delimiter row goes to the header row. In both states, the usual
   * edge rule applies within the cell: past the visible text, after hidden closing markers; before it,
   * before hidden opening markers.
   */
  private tableHit(line: Line, pos: number, x: number, y: number): number {
    const tb = line.table!;
    const collapsed = !this.reveal.get(line.index)?.fence;
    const div = this.lineDiv(line.index);
    if (!div) return pos;
    if (collapsed && line.type === "table-delim") {
      const head = this.doc.lines[tb.start]!;
      const hr = this.lineDiv(head.index)?.getBoundingClientRect();
      const p = hr ? this.hitTest(x, hr.top + hr.height / 2) : null;
      return p !== null && lineAt(this.doc.lines, p) === head.index ? this.tableHit(head, p, x, hr!.top + hr!.height / 2) : head.from + 1;
    }
    const cellEls = Array.from(div.children).slice(0, tb.cells.length) as HTMLElement[];
    let c = -1;
    const hit = document.elementFromPoint(x, y)?.closest(".tcell");
    if (hit && div.contains(hit)) c = Math.min(Array.prototype.indexOf.call(div.children, hit), tb.cells.length - 1);
    if (c < 0 && cellEls.length) {
      if (x >= cellEls[cellEls.length - 1]!.getBoundingClientRect().right) c = cellEls.length - 1;
      else if (x <= cellEls[0]!.getBoundingClientRect().left) c = 0;
    }
    if (c < 0) {
      // fall back to the cell containing the native hit
      c = tb.cells.findIndex(([cf, ct]) => cf <= pos && pos <= ct);
      if (c < 0) return pos;
    }
    const [cf, ct] = tb.cells[c]!;
    const [a, b] = trimRange(this.doc.text, cf, ct);
    if (collapsed) {
      if (a === b) return Math.min(cf + 1, ct);
      pos = Math.max(a, Math.min(b, pos));
    }
    if (pos < a || pos > b) return pos;
    if (pos < b && this.onlyHidden(line, pos, b) && x > this.caretRect(pos).left + 1) return b;
    if (pos > a && this.onlyHidden(line, a, pos) && x < this.caretRect(pos).left - 1) return a;
    return pos;
  }

  /**
   * Every character of [from, to) is currently collapsed (unrevealed marker or escape backslash). A collapsed
   * image among other text doesn't count: it's drawn below the line, so a click beside it isn't at its edge.
   */
  private onlyHidden(line: Line, from: number, to: number): boolean {
    if (line.type === "code" || line.type === "fence" || from < line.textFrom) return false;
    const rv = new Set(this.reveal.get(line.index)?.els ?? []);
    const images = isImageLine(line);
    for (let p = from; p < to; p++) {
      if (line.escapes.includes(p)) continue;
      const hidden = line.inline.some((el, k) => !rv.has(k) && (images || el.type !== "image") && el.markers.some((m) => m[0] <= p && p < m[1]));
      if (!hidden) return false;
    }
    return true;
  }

  private scrollParent(): HTMLElement | null {
    for (let el = this.wrapper.parentElement; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") return el;
    }
    return null;
  }

  visibleBounds(): [number, number] {
    const sp = this.scrollParent();
    let top = 0;
    let bottom = window.innerHeight;
    if (sp) {
      const r = sp.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
    }
    return [top, bottom];
  }

  scrollBy(dy: number): void {
    const sp = this.scrollParent();
    if (sp) sp.scrollTop += dy;
    else window.scrollBy(0, dy);
  }

  scrollToEdge(dir: -1 | 1): void {
    const sp = this.scrollParent();
    const el = sp ?? document.scrollingElement;
    if (el) el.scrollTop = dir < 0 ? 0 : el.scrollHeight;
  }

  scrollCaretIntoView(): void {
    if (!this.hasFocus()) return;
    const r = this.caretRect(this.sel.head);
    if (r.bottom === 0 && r.top === 0) return;
    const [vt, vb] = this.visibleBounds();
    const m = 12;
    if (r.top < vt + m) this.scrollBy(r.top - vt - m);
    else if (r.bottom > vb - m) this.scrollBy(r.bottom - vb + m);
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
    this.history.destroy();
    if (this.pubTimer) clearTimeout(this.pubTimer);
    if (this.awareness.getLocalState()) this.awareness.setLocalStateField("cursor", null);
    this.wrapper.remove();
  }
}

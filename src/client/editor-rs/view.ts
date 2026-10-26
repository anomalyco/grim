// The editor view: the Rust engine (wasm) owns the text model, selection, reveal, navigation and history; this
// shell renders its line views into a contenteditable DOM (render.ts, editor.css), answers its layout questions
// from that DOM (layout.ts) and feeds it input (input.ts). Two kinds of documents:
// - collab (notes): the engine owns the shared document itself (`RustCollab`: yrs in the wasm speaks the room's
//   protocol); the view sends the engine's outgoing frames after every command;
// - local (home page example, /start, tests, parity rig): a plain engine on a text. An optional `LocalSync`
//   (test harnesses: a Y.Text mirror) gets the engine's edits and feeds remote edits back through `applyRemote`.

import type { ImageResolver } from "./images.ts";
import { rawToDom, domToRaw, lineAt } from "./offsets.ts";
import { type Rect, caretRect } from "./geometry.ts";
import { RemoteCursors, type CursorHost, type PeerCursorView } from "./cursors.ts";
import { sigOf, toRLine, type RLine } from "./lineview.ts";
import { applyLineReveal, collectImages, renderRLine, type ImagePool, type RLineDiv } from "./render.ts";
import { applyEdits } from "./edits.ts";
import { DomLayout, scrollBy, scrollToEdge, visibleBounds } from "./layout.ts";
import { attachRustInput } from "./input.ts";
import type { CollabView, RustCollab } from "./collab.ts";
import { guardEngine } from "./guard.ts";
import type { Edit, Engine, EngineFactory, LineViewJs, Patch, PatchLines } from "./types.ts";

export type RustViewOptions = {
  readOnly?: boolean;
  images?: ImageResolver;
  /** Where folded headings persist (localStorage, see foldStorageKey); collab views use the note's repo + path. */
  foldKey?: string;
} & (
  | {
      /** The document's text. */
      text: string;
      engine: EngineFactory;
      sync?: LocalSync;
      collab?: undefined;
      /** The engine trapped (wasm panic): called once, from inside the failing call (defer the teardown). */
      onCrash?: (err: unknown) => void;
    }
  | { collab: RustCollab; text?: undefined; engine?: undefined; sync?: undefined }
);

/** Shares a local document's text (test harnesses mirror it into a Y.Text; the app has none). */
export interface LocalSync {
  /** The view is ready; remote edits go to `view.applyRemote`, presence changes to `view.cursorsChanged`. */
  attach(view: RustEditorView): void;
  /** Local edits the engine made, in order. */
  push(edits: Edit[]): void;
  /** The engine's text is the truth and the mirror may have drifted (after a re-render): make it match. */
  resync(text: string): void;
  /** Our selection changed, or focus did (the view's `sel` / `hasFocus()`). */
  selectionChanged(): void;
  /** Remote cursors to draw. */
  peerCursors(): PeerCursorView[];
  detach(): void;
}

export interface Sel {
  anchor: number;
  head: number;
}

interface LineSpan {
  from: number;
  to: number;
}

export class RustEditorView implements CursorHost, CollabView {
  readonly wrapper: HTMLDivElement;
  readonly root: HTMLDivElement;
  readonly overlay: HTMLDivElement;
  /** Collab mode: the connection whose engine this view shows (null for a local document). */
  readonly collab: RustCollab | null;
  /** Local documents: what shares the text, if anything. */
  readonly sync: LocalSync | null;
  readonly readOnly: boolean;
  readonly images: ImageResolver | undefined;
  readonly engine: Engine;
  readonly layout: DomLayout;

  /** The text as the engine has it, with absolute line spans (for the offset mapping and the cursor layer). */
  doc: { text: string; lines: LineSpan[] } = { text: "", lines: [] };
  /** The engine's line views, line-relative. */
  lines: RLine[] = [];
  sel: Sel = { anchor: 0, head: 0 };
  composing = false;
  /** A composition was dropped by a full re-render: its compositionend (if the browser still sends one) is ignored. */
  abortedComposition = false;
  /** The DOM is behind `lines` (changes held back during composition, or drift): reconcile when possible. */
  private domStale = false;
  private cursors: RemoteCursors;
  private mo: MutationObserver;
  private detachInput: () => void;
  private destroyed = false;
  private resizeObs: ResizeObserver | null = null;
  /** localStorage key of this note's folded headings (null: not persisted). */
  private readonly foldKey: string | null;
  private foldTimer: ReturnType<typeof setTimeout> | null = null;
  /** Some line is folded (or was, before the last patch): fold keys may have changed. */
  private hadFolds = false;

  constructor(
    readonly container: HTMLElement,
    opts: RustViewOptions,
  ) {
    this.collab = opts.collab ?? null;
    this.sync = opts.sync ?? null;
    this.readOnly = !!opts.readOnly || !!this.collab?.readOnly;
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

    if (opts.collab) {
      // the engine is the connection's (it outlives views: a read-only change remounts the view)
      this.engine = opts.collab.engine;
      this.doc = { text: this.engine.text(), lines: [] };
      // read-only on top of the room's (which the engine follows by itself); a remount resets it
      this.engine.set_read_only(!!opts.readOnly);
    } else {
      const text = opts.text;
      this.doc = { text, lines: [] };
      const engine = opts.engine(text);
      this.engine = opts.onCrash ? guardEngine(engine, opts.onCrash) : engine;
      if (this.readOnly) this.engine.set_read_only(true);
    }
    this.layout = new DomLayout(this);
    this.cursors = new RemoteCursors(this);
    this.foldKey = opts.collab ? foldStorageKey(opts.collab.repo, opts.collab.path) : opts.foldKey ? `grimoire.folds:${opts.foldKey}` : null;

    this.mo = new MutationObserver((recs) => this.onMutations(recs));
    this.mo.observe(this.root, { childList: true, characterData: true, subtree: true });

    this.renderAll();
    this.restoreFolds();
    if (this.collab) this.collab.view = this;
    else this.sync?.attach(this);
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
    // a composition in the DOM being replaced can't continue: the engine forgets it, the IME's end is ignored
    this.abortComposition();
    this.doc.text = this.engine.text();
    const p = this.engine.render_all();
    const lines = p.lines ?? { start: 0, deleteCount: 0, insert: [] };
    this.lines = [];
    this.root.replaceChildren();
    this.apply({ ...p, edits: null, lines: { start: 0, deleteCount: 0, insert: lines.insert } }, { remote: [] });
  }

  /**
   * Apply a patch from the engine: text edits (passed to the LocalSync unless they came from it), the line
   * splice, the selection and scrolling.
   */
  apply(p: Patch | undefined, opts: { remote?: Edit[] } = {}): void {
    if (!p || this.destroyed) return;
    // remote patches: the text edits came from the LocalSync and are already in doc.text
    const edits = opts.remote ?? p.edits;
    if (!opts.remote && edits?.length) {
      this.doc.text = applyEdits(this.doc.text, edits);
      this.sync?.push(edits);
    }
    if (p.lines) this.splice(p.lines);
    if (!this.updateSpans()) {
      // the engine and the shell disagree about the text: resync from the engine
      console.error("rust editor: line views don't match the text; re-rendering");
      this.renderAll();
      this.sync?.resync(this.doc.text);
      return;
    }
    if (edits?.length && !this.composing) this.refreshChanged(edits);
    if (this.domStale && !this.composing) this.reconcile();
    const len = this.doc.text.length;
    this.sel = { anchor: clamp(p.sel.anchor, len), head: clamp(p.sel.head, len) };
    if (!this.composing) this.writeDomSel();
    if (p.scroll === "caret") this.scrollCaretIntoView();
    else if (p.scroll === "start" || p.scroll === "end") scrollToEdge(this.wrapper, p.scroll === "start" ? -1 : 1);
    if (p.lines) this.foldsMaybeChanged();
    this.publishCursor();
    this.cursors.schedule();
  }

  // ---------------------------------------------------------------------------------------------
  // Folding (view state: the text and the shared document never change)

  /** Fold / unfold heading line `line` (its gutter chevron or "…" pill). */
  toggleFold(line: number): void {
    if (this.engine.toggle_fold) this.apply(this.engine.toggle_fold(line));
  }

  /** "toggle" | "fold" | "unfold" | "foldAll" | "unfoldAll". */
  foldCommand(which: string): void {
    if (this.engine.fold_command) this.apply(this.engine.fold_command(which));
  }

  /** Persist the folded headings soon after lines changed while something is (or was) folded. */
  private foldsMaybeChanged(): void {
    const has = this.lines.some((l) => l.folded);
    if (!has && !this.hadFolds) return;
    this.hadFolds = has;
    if (!this.foldKey || this.foldTimer) return;
    this.foldTimer = setTimeout(() => {
      this.foldTimer = null;
      this.saveFolds();
    }, 250);
  }

  private saveFolds(): void {
    if (!this.foldKey || !this.engine.fold_keys) return;
    try {
      const keys = this.engine.fold_keys();
      if (keys.length) localStorage.setItem(this.foldKey, JSON.stringify(keys));
      else localStorage.removeItem(this.foldKey);
    } catch {}
  }

  /** Fold the headings saved for this note (on mount and after the engine rebuilt its editor). */
  private restoreFolds(): void {
    if (!this.foldKey || !this.engine.set_fold_keys) return;
    let keys: unknown;
    try {
      keys = JSON.parse(localStorage.getItem(this.foldKey) ?? "null");
    } catch {
      return;
    }
    if (!Array.isArray(keys) || !keys.length) return;
    const valid = keys.filter((k): k is [string, number] => Array.isArray(k) && typeof k[0] === "string" && typeof k[1] === "number");
    this.apply(this.engine.set_fold_keys(valid));
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
      const images: ImagePool = new Map();
      collectImages(div, images);
      const nd = renderRLine(fresh, text, { images: this.images, reuse: images });
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

  private abortComposition(): void {
    if (!this.composing) return;
    this.composing = false;
    this.abortedComposition = true;
    this.engine.abort_composition();
  }

  /** Composition ended with `data` committed: the browser's composed DOM gets replaced by the engine's lines. */
  finishComposition(data: string): void {
    if (this.abortedComposition && !this.composing) {
      // its DOM was re-rendered meanwhile (reload / remount): nothing to commit into any more
      this.abortedComposition = false;
      if (this.domStale) this.reconcile();
      this.writeDomSel();
      return;
    }
    this.composing = false;
    if (data && !this.readOnly) {
      // the engine takes the commit as the composition's text (replacing the selection it started with)
      this.apply(this.engine.insert_text(data));
      this.apply(this.engine.end_composition());
    } else {
      // cancelled: the engine removes the selection the composition started on, if any
      this.apply(this.engine.end_composition());
    }
    if (this.domStale) this.reconcile();
    this.writeDomSel();
  }

  // ---------------------------------------------------------------------------------------------
  // Collab (CollabView: called by the connection)

  /** Remote edits arrived through the engine: `p.edits` is the change (already in the engine). */
  remotePatch(p: Patch): void {
    this.apply(p);
  }

  /** The engine rebuilt its editor from the shared document. */
  reload(): void {
    if (this.destroyed) return;
    this.renderAll();
    if (!this.lines.some((l) => l.folded)) this.restoreFolds();
    this.writeDomSel();
  }

  cursorsChanged(): void {
    this.cursors.schedule();
  }

  /** Remote cursors to draw. */
  peerCursors(): PeerCursorView[] {
    if (!this.collab) return this.sync?.peerCursors() ?? [];
    return this.collab.engine
      .remote_cursors()
      .map((c) => ({ id: c.client, key: c.key, anchor: c.anchor, head: c.head, name: c.name, color: c.color }));
  }

  /** Local documents: remote edits from the LocalSync (applied in order). */
  applyRemote(edits: Edit[]): void {
    if (this.destroyed || !edits.length) return;
    this.doc.text = applyEdits(this.doc.text, edits);
    this.apply(this.engine.apply_remote(edits), { remote: edits });
  }

  private onResize = () => this.cursors.schedule();

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
    if (this.destroyed) return;
    // the engine throttles the cursor itself (and publishes it only while focused)
    if (this.collab) this.collab.pump();
    else this.sync?.selectionChanged();
  }

  /** Called on focus/blur: show our cursor to others only while focused. */
  setPresence(focused: boolean): void {
    if (this.destroyed) return;
    if (this.collab) this.collab.setFocused(focused);
    else this.sync?.selectionChanged();
  }

  // ---------------------------------------------------------------------------------------------
  // Geometry (client coordinates, for the cursor layer)

  caretRect(pos: number): Rect {
    // a position hidden in a folded section (a remote cursor) shows on its folded heading, at the "…" pill
    let li = this.lines.length === this.doc.lines.length ? lineAt(this.doc.lines, pos) : -1;
    if (li > 0 && this.lines[li]!.hidden) {
      while (li > 0 && this.lines[li]!.hidden) li--;
      const r = caretRect(this.root, this.doc, this.doc.lines[li]!.to);
      return { ...r, left: r.left + 14 };
    }
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
    try {
      // a collab engine outlives the view: don't leave it composing
      this.abortComposition();
    } catch {}
    if (this.collab) {
      if (this.collab.view === this) this.collab.view = null;
      if (this.hasFocus()) this.collab.setFocused(false);
    } else {
      this.sync?.detach();
    }
    this.mo.disconnect();
    this.resizeObs?.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.root.removeEventListener("scroll", this.onResize);
    this.cursors.destroy();
    if (this.foldTimer) {
      clearTimeout(this.foldTimer);
      this.foldTimer = null;
      this.saveFolds();
    }
    if (!this.collab) {
      try {
        this.engine.free?.();
      } catch {}
    }
    this.wrapper.remove();
  }
}

const clamp = (p: number, len: number) => Math.max(0, Math.min(len, p));

/** localStorage key of a note's folded headings (view state, per browser). */
export function foldStorageKey(repo: string, path: string): string {
  return `grimoire.folds:${repo}\u0000${path}`;
}

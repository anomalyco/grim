// Input bridge for the Rust engine: every edit and caret move goes to the engine, which answers with a patch.
// beforeinput is prevented and turned into engine commands; keydown goes through the engine's key map (keys it
// doesn't handle are left to the browser); IME composition runs natively in the DOM and is committed on
// compositionend; mouse selection is the engine's.

import { ALT, CTRL, META, SHIFT } from "./types.ts";
import { scrollBy, visibleBounds } from "./layout.ts";
import type { RustEditorView } from "./view.ts";
import { crashSafe } from "./guard.ts";
import { linkDest, type LineLink } from "./links.ts";

/** How far (px) the pointer may move during a click before it becomes a drag. */
const DRAG_SLOP = 4;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * A key press as the engine's (macOS) key map sees it, or null to leave it to the browser. Elsewhere Ctrl is the
 * command key, Ctrl-arrows move by word/paragraph and Home/End go to the line (Ctrl: document) edges.
 */
export function translateKey(e: KeyLike, mac = isMac): { key: string; mods: number } | null {
  const shift = e.shiftKey ? SHIFT : 0;
  if (mac) return { key: e.key, mods: shift | (e.altKey ? ALT : 0) | (e.ctrlKey ? CTRL : 0) | (e.metaKey ? META : 0) };
  if (e.metaKey) return null;
  const k = e.key;
  switch (k) {
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown":
      if (e.altKey) return null;
      return { key: k, mods: shift | (e.ctrlKey ? ALT : 0) };
    case "Home":
    case "End":
      if (e.altKey) return null;
      if (e.ctrlKey) return { key: k === "Home" ? "ArrowUp" : "ArrowDown", mods: shift | META };
      return { key: k === "Home" ? "ArrowLeft" : "ArrowRight", mods: shift | META };
    case "Backspace":
    case "Delete":
      if (e.altKey) return null;
      return { key: k, mods: shift | (e.ctrlKey ? ALT : 0) };
    case "Enter":
    case "Tab":
    case "Escape":
      return { key: k, mods: shift | (e.altKey ? ALT : 0) | (e.ctrlKey ? CTRL : 0) };
    default:
      if (e.ctrlKey && e.altKey) return null; // AltGr characters
      if (e.ctrlKey) {
        if (k.toLowerCase() === "y") return { key: "z", mods: META | SHIFT };
        return { key: k, mods: shift | META };
      }
      return { key: k, mods: shift | (e.altKey ? ALT : 0) };
  }
}

/**
 * The fold shortcuts by physical key (Option changes `key` on a Mac: Option-[ is "“"): Cmd-' toggles, Cmd-Option-[ / ]
 * fold / unfold at the caret, with Shift every heading. Elsewhere Ctrl is the command key. Null: not a fold key.
 */
export function foldKey(e: KeyLike & { code?: string }, mac = isMac): { key: string; mods: number } | null {
  const cmd = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!cmd) return null;
  const shift = e.shiftKey ? SHIFT : 0;
  if (e.code === "Quote" && !e.altKey && !e.shiftKey) return { key: "'", mods: META };
  if (e.altKey && (e.code === "BracketLeft" || e.code === "BracketRight")) return { key: e.code === "BracketLeft" ? "[" : "]", mods: META | ALT | shift };
  return null;
}

export function attachRustInput(v: RustEditorView): () => void {
  const root = v.root;
  const engine = v.engine;
  const layout = v.layout;
  let pointerDown = false;
  /** A single click's button held down: the pointer position, and whether it moved far enough to drag. */
  let drag: { x: number; y: number; x0: number; y0: number; moved: boolean; frame: number } | null = null;
  /** A plain press on a collapsed link: it opens on release, unless the pointer moves first (then it's a drag). */
  let pressed: { li: number; link: LineLink; x0: number; y0: number } | null = null;
  /** The link a click last opened (the second click of a double click on it is ignored). */
  let opened: { li: number; from: number; time: number } | null = null;
  /** The destination of the collapsed link under the pointer (cursor and tooltip), or null. */
  let hot: string | null = null;

  /** Run an engine key command for an editing intent that arrived as beforeinput. */
  const key = (k: string, mods = 0) => v.apply(engine.key(k, mods, layout));

  const onBeforeInput = (e: InputEvent) => {
    const t = e.inputType;
    const compositionType = t === "insertCompositionText" || t === "deleteCompositionText" || t === "insertFromComposition";
    if (v.composing) return; // composition runs natively and is committed on compositionend
    if (compositionType && !e.cancelable) return;
    e.preventDefault();
    if (v.readOnly) return;
    const dataText = () => e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
    switch (t) {
      case "insertCompositionText":
      case "insertFromComposition":
      case "insertText": {
        const data = dataText();
        if (data) v.apply(engine.insert_text(data));
        break;
      }
      case "insertReplacementText": {
        const data = e.dataTransfer?.getData("text/plain") ?? e.data ?? "";
        let a: number | null = v.sel.anchor;
        let b: number | null = v.sel.head;
        const r = e.getTargetRanges()[0];
        if (r) {
          const ra = v.readRange(r.startContainer, r.startOffset);
          const rb = v.readRange(r.endContainer, r.endOffset);
          if (ra !== null && rb !== null) [a, b] = [ra, rb];
        }
        v.apply(engine.replace_range(Math.min(a, b), Math.max(a, b), data));
        break;
      }
      case "insertParagraph":
        key("Enter");
        break;
      case "insertLineBreak":
        key("Enter", SHIFT);
        break;
      case "deleteContentBackward":
        key("Backspace");
        break;
      case "deleteContentForward":
        key("Delete");
        break;
      case "deleteWordBackward":
        key("Backspace", ALT);
        break;
      case "deleteWordForward":
        key("Delete", ALT);
        break;
      case "deleteSoftLineBackward":
      case "deleteHardLineBackward":
        key("Backspace", META);
        break;
      case "deleteSoftLineForward":
      case "deleteHardLineForward":
        key("Delete", META);
        break;
      case "deleteByCut":
      case "deleteContent":
      case "deleteByDrag":
        if (v.sel.anchor !== v.sel.head) v.apply(engine.cut().patch);
        break;
      case "insertFromPaste":
      case "insertFromPasteAsQuotation": {
        const data = dataText();
        if (data) v.apply(engine.paste(data));
        break;
      }
      case "historyUndo":
        v.apply(engine.undo());
        break;
      case "historyRedo":
        v.apply(engine.redo());
        break;
      case "formatBold":
        key("b", META);
        break;
      case "formatItalic":
        key("i", META);
        break;
      case "formatUnderline":
        key("u", META);
        break;
      default:
        break;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || v.composing || e.keyCode === 229) return;
    // Cmd-Enter (elsewhere Ctrl-Enter) with the caret in a link opens it
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) {
      const link = v.linkAtCaret();
      if (link) {
        e.preventDefault();
        v.openLink(link.raw);
        return;
      }
    }
    const k = foldKey(e) ?? translateKey(e);
    if (!k) return;
    const p = engine.key(k.key, k.mods, layout);
    if (!p) return;
    e.preventDefault();
    v.apply(p);
  };

  const onCompositionStart = () => {
    v.abortedComposition = false;
    v.composing = true;
    engine.begin_composition();
  };

  const onCompositionEnd = (e: CompositionEvent) => {
    v.finishComposition(e.data ?? "");
  };

  const onSelectionChange = () => {
    if (v.composing || drag) return;
    const s = v.readDomSel();
    if (!s || (s.anchor === v.sel.anchor && s.head === v.sel.head)) return;
    // a selection change we didn't make (native keys the engine left alone, accessibility tools, ...)
    v.apply(engine.set_selection(s.anchor, s.head));
  };

  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    const text = engine.copy();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
  };

  const onCut = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    if (v.readOnly) return onCopy(e);
    if (v.sel.anchor === v.sel.head) return;
    e.preventDefault();
    const r = engine.cut();
    e.clipboardData.setData("text/plain", r.text);
    v.apply(r.patch);
  };

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    if (v.readOnly) return;
    // image files (a screenshot): uploaded, then inserted at the selection
    if (v.drops?.paste(e)) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) v.apply(engine.paste(text));
  };

  const dragTo = () => {
    if (!drag) return;
    drag.frame = 0;
    // past the visible edges: scroll, and keep extending while the pointer stays there
    const [vt, vb] = visibleBounds(v.wrapper);
    let dy = 0;
    if (drag.y < vt) dy = Math.max(-40, drag.y - vt);
    else if (drag.y > vb) dy = Math.min(40, drag.y - vb);
    if (dy) scrollBy(v.wrapper, dy);
    const [x, y] = layout.fromClient(drag.x, Math.max(vt + 1, Math.min(vb - 1, drag.y)));
    v.apply(engine.mouse_drag(x, y, layout));
    if (dy) drag.frame = requestAnimationFrame(safeDragTo);
  };

  const safeDragTo = crashSafe(dragTo);

  const onMouseMove = (e: MouseEvent) => {
    if (!drag) return;
    if (!(e.buttons & 1)) return endDrag();
    drag.x = e.clientX;
    drag.y = e.clientY;
    // a click's jitter isn't a drag (it would replace the click's caret with the raw hit)
    if (!drag.moved && Math.abs(drag.x - drag.x0) < DRAG_SLOP && Math.abs(drag.y - drag.y0) < DRAG_SLOP) return;
    drag.moved = true;
    if (!drag.frame) drag.frame = requestAnimationFrame(safeDragTo);
  };

  const endDrag = () => {
    if (drag?.frame) cancelAnimationFrame(drag.frame);
    drag = null;
    document.removeEventListener("mousemove", onMouseMove);
  };

  const onMouseDown = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target || e.button !== 0) return;
    const box = target.closest(".tok-todo");
    if (box && root.contains(box)) {
      e.preventDefault();
      const li = Array.prototype.indexOf.call(root.children, box.parentElement);
      if (!v.hasFocus()) root.focus({ preventScroll: true });
      if (!v.readOnly && li >= 0) v.apply(engine.toggle_todo(li));
      return;
    }
    // a heading's fold chevron (drawn in the gutter left of its "H1" label) or a folded heading's "…" pill
    const fold = foldHit(root, target, e.clientX, e.clientY);
    if (fold >= 0) {
      e.preventDefault();
      if (!v.hasFocus()) root.focus({ preventScroll: true });
      v.toggleFold(fold);
      return;
    }
    // a collapsed link's pencil: expand the link for editing (links never expand by the caret alone)
    const chip = target.closest(".chip") as HTMLElement | null;
    if (chip && root.contains(chip)) {
      const li = lineIndex(chip);
      const link = chip.dataset.link !== undefined
        ? v.lineLinks(li).find((l) => l.from === Number(chip.dataset.link))
        : v.lineLinks(li).find((l) => l.urlFrom === Number(chip.dataset.u));
      if (!link || link.collapsed) {
        e.preventDefault();
        endPress();
        if (link && !v.readOnly) v.revealLink(li, link);
        return;
      }
    }
    const hit = linkHit(target);
    if (hit && (e.detail || 1) > 1 && opened && opened.li === hit.li && opened.from === hit.link.from && performance.now() - opened.time < 1500) {
      // the rest of a double click on a link the first click opened
      e.preventDefault();
      return;
    }
    endPress();
    if (hit && (e.detail || 1) === 1 && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // the caret stays where it is: the link opens on release (a drag selects as usual)
      e.preventDefault();
      endDrag();
      pressed = { ...hit, x0: e.clientX, y0: e.clientY };
      document.addEventListener("mousemove", onPressMove);
      return;
    }
    // the engine places the caret / selects words and lines; the browser doesn't touch the selection
    e.preventDefault();
    press(e.clientX, e.clientY, Math.max(1, e.detail || 1), e.shiftKey);
  };

  /** A press the engine handles: caret, word / line selection; a single click may become a drag. */
  const press = (cx: number, cy: number, clicks: number, shift: boolean) => {
    // set only now: the todo / chip hits above may never see their mouseup
    pointerDown = true;
    if (!v.hasFocus()) root.focus({ preventScroll: true });
    const [x, y] = layout.fromClient(cx, cy);
    v.apply(engine.mouse_down(x, y, clicks, shift, layout));
    endDrag();
    // dragging extends from single clicks only (a double/triple click keeps its word / line)
    if (clicks > 1) return;
    drag = { x: cx, y: cy, x0: cx, y0: cy, moved: false, frame: 0 };
    document.addEventListener("mousemove", onMouseMove);
  };

  const lineIndex = (el: Element): number => Array.prototype.indexOf.call(root.children, el.closest(".ln"));

  /** The collapsed link whose text (or linked image) `target` is in. */
  const linkHit = (target: Element): { li: number; link: LineLink } | null => {
    const ln = target.closest(".ln");
    if (!ln || ln.parentElement !== root) return null;
    let at: number;
    const box = target.closest(".imgbox") as HTMLElement | null;
    if (box) at = Number(box.dataset.from);
    else {
      const seg = target.closest("[data-f]") as HTMLElement | null;
      if (!seg || !ln.contains(seg) || !seg.classList.contains("t") || !seg.classList.contains("link") || seg.classList.contains("ws")) return null;
      at = Number(seg.dataset.f);
    }
    const li = lineIndex(ln);
    const link = v.linkAt(li, at);
    return link?.collapsed ? { li, link } : null;
  };

  const onPressMove = (e: MouseEvent) => {
    const p = pressed;
    if (!p) return;
    if (!(e.buttons & 1)) return endPress();
    if (Math.abs(e.clientX - p.x0) < DRAG_SLOP && Math.abs(e.clientY - p.y0) < DRAG_SLOP) return;
    // a drag starting on the link: select from where it was pressed
    endPress();
    press(p.x0, p.y0, 1, false);
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.moved = true;
    drag.frame = requestAnimationFrame(safeDragTo);
  };

  const endPress = () => {
    pressed = null;
    document.removeEventListener("mousemove", onPressMove);
  };

  const onMouseUp = () => {
    pointerDown = false;
    endDrag();
    const p = pressed;
    if (!p) return;
    endPress();
    opened = { li: p.li, from: p.link.from, time: performance.now() };
    v.openLink(p.link.raw);
  };

  const onHover = (e: MouseEvent) => {
    const hit = e.buttons || drag || pressed ? null : linkHit(e.target as Element);
    const raw = hit ? linkDest(hit.link.raw) : null;
    if (raw === hot) return;
    hot = raw;
    v.wrapper.classList.toggle("lk-hot", raw !== null);
    if (raw !== null) root.title = raw;
    else root.removeAttribute("title");
  };

  const onFocus = () => {
    v.setPresence(true);
    // restore our selection only for programmatic/keyboard focus: a click places its own
    if (pointerDown) return;
    v.writeDomSel();
  };
  const onBlur = () => {
    pointerDown = false;
    v.setPresence(false);
  };

  const prevent = (e: Event) => e.preventDefault();

  // every entry point from the browser: an engine crash prevents the default action (no DOM edit) and stops there
  const listeners: [EventTarget, string, EventListener][] = [
    [root, "beforeinput", onBeforeInput as EventListener],
    [root, "keydown", onKeyDown as EventListener],
    [root, "compositionstart", onCompositionStart],
    [root, "compositionend", onCompositionEnd as EventListener],
    [root, "copy", onCopy as EventListener],
    [root, "cut", onCut as EventListener],
    [root, "paste", onPaste as EventListener],
    [root, "mousedown", onMouseDown as EventListener],
    [root, "mousemove", onHover as EventListener],
    [root, "mouseleave", onHover as EventListener],
    [root, "focus", onFocus],
    [root, "blur", onBlur],
    [root, "dragstart", prevent],
    [root, "drop", prevent],
    [document, "mouseup", onMouseUp],
    [document, "selectionchange", onSelectionChange],
  ].map(([t, type, fn]) => [t as EventTarget, type as string, crashSafe(fn as EventListener)]);
  for (const [t, type, fn] of listeners) t.addEventListener(type, fn);
  return () => {
    endDrag();
    endPress();
    for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
  };
}

/**
 * The line whose fold toggle a press at client (x, y) on `target` hits, or -1: the chevron sits left of the heading
 * token (its ::before), the pill after a folded heading's text (the line's ::after).
 */
export function foldHit(root: HTMLElement, target: Element, x: number, y: number): number {
  const ln = target.closest(".ln");
  if (!ln || ln.parentElement !== root || !ln.classList.contains("fold-able")) return -1;
  const li = Array.prototype.indexOf.call(root.children, ln);
  const tok = target.closest(".tok-heading");
  if (tok) return x < tok.getBoundingClientRect().left ? li : -1;
  if (target !== ln || !ln.classList.contains("folded")) return -1;
  const last = Array.from(ln.children).filter((c) => c.tagName !== "BR").pop();
  const rects = last ? last.getClientRects() : null;
  const r = rects?.[rects.length - 1];
  if (!r) return -1;
  return x >= r.right && x <= r.right + 48 && y >= r.top - 4 && y <= r.bottom + 4 ? li : -1;
}

/** Only http(s) and mailto links are opened; a URL without a scheme is treated as https. */
export function safeUrl(href: string): string | null {
  const withScheme = /^[a-z][\w+.-]*:/i.test(href) ? href : "https://" + href;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

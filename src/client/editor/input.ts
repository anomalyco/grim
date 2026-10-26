// Input controller: beforeinput intents, keyboard shortcuts, composition, clipboard and mouse.
// Every edit is prevented natively and applied to the model; IME composition is the exception
// (it runs natively and is reconciled on compositionend).

import * as rules from "./rules.ts";
import { type Sel, selFrom, selTo, snapSel, caret, wordRange } from "./units.ts";
import { lineAt } from "./parser.ts";
import { moveHorizontal, moveVertical, moveParagraph, type HUnit } from "./navigation.ts";
import type { EditorView } from "./view.ts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function attachInput(v: EditorView): () => void {
  const root = v.root;
  let pointerDown = false;

  const onBeforeInput = (e: InputEvent) => {
    const t = e.inputType;
    const compositionType =
      t === "insertCompositionText" || t === "deleteCompositionText" || t === "insertFromComposition";
    if (v.composing) return; // composition runs natively and is reconciled on compositionend
    if (compositionType && !e.cancelable) return;
    e.preventDefault();
    if (v.readOnly) return;
    const doc = v.doc;
    const sel = v.sel;
    const dataText = () => e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
    switch (t) {
      case "insertCompositionText":
      case "insertFromComposition":
      case "insertText": {
        const data = dataText();
        if (!data) break;
        if (data === " " && v.swallowSpaceAt !== null && sel.anchor === sel.head && sel.head === v.swallowSpaceAt) {
          v.swallowSpaceAt = null;
          break;
        }
        const ed = rules.insertText(doc, sel, data);
        v.applyEdit(ed);
        if (data === ">" && ed.then?.kind === "convert") v.swallowSpaceAt = v.sel.head;
        break;
      }
      case "insertReplacementText": {
        const data = e.dataTransfer?.getData("text/plain") ?? e.data ?? "";
        let s = sel;
        const r = e.getTargetRanges()[0];
        if (r) {
          const a = v.readRange(r.startContainer, r.startOffset);
          const b = v.readRange(r.endContainer, r.endOffset);
          if (a !== null && b !== null) s = { anchor: a, head: b };
        }
        v.applyEdit(rules.replaceSelection(doc, s, data));
        break;
      }
      case "insertParagraph":
        v.applyEdit(rules.insertParagraph(doc, sel));
        break;
      case "insertLineBreak":
        v.applyEdit(rules.insertLineBreak(doc, sel));
        break;
      case "deleteContentBackward":
        v.applyEdit(rules.deleteBackward(doc, sel));
        break;
      case "deleteContentForward":
        v.applyEdit(rules.deleteForward(doc, sel));
        break;
      case "deleteWordBackward":
        v.applyEdit(rules.deleteWordBackward(doc, sel));
        break;
      case "deleteWordForward":
        v.applyEdit(rules.deleteWordForward(doc, sel));
        break;
      case "deleteSoftLineBackward":
      case "deleteHardLineBackward":
        v.applyEdit(rules.deleteToLineStart(doc, sel));
        break;
      case "deleteSoftLineForward":
      case "deleteHardLineForward":
        v.applyEdit(rules.deleteToLineEnd(doc, sel));
        break;
      case "deleteByCut":
      case "deleteContent":
      case "deleteByDrag":
        if (sel.anchor !== sel.head) v.applyEdit(rules.replaceSelection(doc, sel, "", "paste"));
        break;
      case "insertFromPaste":
      case "insertFromPasteAsQuotation": {
        const data = dataText();
        if (data) v.applyEdit(rules.paste(doc, sel, data));
        break;
      }
      case "historyUndo":
        v.undo();
        break;
      case "historyRedo":
        v.redo();
        break;
      case "formatBold":
        v.applyEdit(rules.toggleFormat(doc, sel, "bold"));
        break;
      case "formatItalic":
        v.applyEdit(rules.toggleFormat(doc, sel, "italic"));
        break;
      case "formatUnderline":
        v.applyEdit(rules.toggleFormat(doc, sel, "underline"));
        break;
      default:
        break;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    v.lastClick = null;
    if (e.isComposing || v.composing || e.keyCode === 229) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key;
    if (mod && !e.altKey) {
      const lk = k.toLowerCase();
      if (lk === "z") {
        e.preventDefault();
        if (e.shiftKey) v.redo();
        else v.undo();
        return;
      }
      if (lk === "y" && !isMac) {
        e.preventDefault();
        v.redo();
        return;
      }
      if (lk === "a" && !e.shiftKey) {
        e.preventDefault();
        v.history.stop();
        v.setSel({ anchor: 0, head: v.doc.text.length }, { dom: true });
        return;
      }
      const fmt = lk === "b" ? "bold" : lk === "i" ? "italic" : lk === "u" ? "underline" : null;
      if (fmt && !e.shiftKey) {
        e.preventDefault();
        if (!v.readOnly) v.applyEdit(rules.toggleFormat(v.doc, v.sel, fmt));
        return;
      }
    }
    switch (k) {
      case "ArrowLeft":
      case "ArrowRight": {
        const dir = k === "ArrowLeft" ? -1 : 1;
        let unit: HUnit = "char";
        if (isMac) {
          if (e.metaKey) unit = "line";
          else if (e.altKey) unit = "word";
          else if (e.ctrlKey) return;
        } else {
          if (e.altKey || e.metaKey) return;
          if (e.ctrlKey) unit = "word";
        }
        e.preventDefault();
        moveHorizontal(v, dir, e.shiftKey, unit);
        return;
      }
      case "ArrowUp":
      case "ArrowDown": {
        const dir = k === "ArrowUp" ? -1 : 1;
        if (isMac ? e.metaKey : false) {
          e.preventDefault();
          moveHorizontal(v, dir, e.shiftKey, "doc");
          return;
        }
        if (isMac ? e.altKey : e.ctrlKey) {
          e.preventDefault();
          moveParagraph(v, dir, e.shiftKey);
          return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        moveVertical(v, dir, e.shiftKey);
        return;
      }
      case "Home":
      case "End": {
        if (isMac) {
          // Mac text views scroll to the document start/end without moving the caret
          e.preventDefault();
          v.scrollToEdge(k === "Home" ? -1 : 1);
          return;
        }
        e.preventDefault();
        moveHorizontal(v, k === "Home" ? -1 : 1, e.shiftKey, e.ctrlKey ? "doc" : "line");
        return;
      }
      case "Tab": {
        if (v.readOnly || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        v.applyEdit(rules.tab(v.doc, v.sel, e.shiftKey));
        return;
      }
      default:
        return;
    }
  };

  const onCompositionStart = () => {
    v.composing = true;
    v.history.stop();
    v.compRel = v.toRel(v.sel);
  };

  const onCompositionEnd = (e: CompositionEvent) => {
    v.composing = false;
    const data = e.data ?? "";
    const rel = v.compRel;
    v.compRel = null;
    v.invalidate();
    const range = rel ? v.fromRel(rel) : v.sel;
    if (!v.readOnly && (data || range.anchor !== range.head)) {
      v.sel = range;
      v.applyEdit(data ? rules.insertText(v.doc, range, data) : rules.replaceSelection(v.doc, range, ""));
    } else {
      v.render();
      v.setSel(v.sel, { dom: true });
    }
    v.history.stop();
  };

  const onSelectionChange = () => {
    if (v.composing) return;
    let s = v.readDomSel();
    if (!s) return;
    const click = v.lastClick;
    v.lastClick = null;
    let adjusted = false;
    if (click && s.anchor === s.head && performance.now() - click.time < 1000) {
      // clicks use the same edge rules as Up/Down (hit-tested at mousedown, before reveal)
      const p = click.pos;
      if (p !== s.head) {
        s = caret(p);
        adjusted = true;
      }
    }
    if (s.anchor === v.sel.anchor && s.head === v.sel.head) {
      if (adjusted) v.writeDomSel();
      return;
    }
    // keyboard-driven changes snap in their direction of travel; pointer ones to the nearest stop
    const dir = click || pointerDown ? 0 : s.head > v.sel.head ? 1 : s.head < v.sel.head ? -1 : 0;
    const ns = snapSel(v.doc, s, dir);
    // a selection change we didn't make: a caret jump, which ends the undo group
    v.history.stop();
    v.setSel(ns, { dom: adjusted || ns.anchor !== s.anchor || ns.head !== s.head });
  };

  const onCopy = (e: ClipboardEvent) => {
    const s = v.sel;
    if (s.anchor === s.head || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", v.doc.text.slice(selFrom(s), selTo(s)));
  };

  const onCut = (e: ClipboardEvent) => {
    onCopy(e);
    if (!e.defaultPrevented) return;
    if (!v.readOnly) v.applyEdit(rules.replaceSelection(v.doc, v.sel, "", "paste"));
  };

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    if (v.readOnly) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) v.applyEdit(rules.paste(v.doc, v.sel, text));
  };

  const onMouseDown = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target || e.button !== 0) return;
    pointerDown = true;
    const box = target.closest(".tok-todo");
    if (box && root.contains(box)) {
      e.preventDefault();
      const li = Array.prototype.indexOf.call(root.children, box.parentElement);
      if (!v.hasFocus()) root.focus({ preventScroll: true });
      if (v.readOnly) return;
      v.applyEdit(rules.toggleTodo(v.doc, li));
      return;
    }
    const chip = target.closest(".chip") as HTMLElement | null;
    if (chip && root.contains(chip)) {
      e.preventDefault();
      const url = safeUrl(chip.dataset.href ?? "");
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    // an image: the caret goes to the end of its source, a double click selects the source and a triple click
    // the line. The first click reveals the source and shifts the layout, so later clicks of the sequence act
    // on the image the first one hit, wherever they land.
    const img = target.closest(".imgbox") as HTMLElement | null;
    let image: [number, number] | null = null;
    if (img && root.contains(img)) {
      const line = v.doc.lines[Array.prototype.indexOf.call(root.children, img.closest(".ln"))];
      if (line) image = [line.from + Number(img.dataset.from), line.from + Number(img.dataset.at)];
    }
    if (e.detail >= 2 && v.clickImage) image = v.clickImage;
    if (e.detail <= 1) v.clickImage = image;
    if (image) {
      e.preventDefault();
      if (!v.hasFocus()) root.focus({ preventScroll: true });
      v.history.stop();
      v.goalX = null;
      v.lastClick = null;
      const len = v.doc.text.length;
      const [start, end] = [Math.min(image[0], len), Math.min(image[1], len)];
      v.clickPos = end;
      let next: Sel = e.shiftKey ? { anchor: v.sel.anchor, head: end } : caret(end);
      if (e.detail === 2 && !e.shiftKey) next = { anchor: start, head: end };
      else if (e.detail >= 3 && !e.shiftKey) {
        const lines = v.doc.lines;
        const li = lineAt(lines, end);
        next = { anchor: lines[li]!.from, head: li + 1 < lines.length ? lines[li + 1]!.from : lines[li]!.to };
      }
      v.setSel(next, { dom: true });
      return;
    }
    v.history.stop();
    v.goalX = null;
    // where the first click of a (multi-)click landed, hit-tested before any reveal shifts the layout
    if (e.detail <= 1) v.clickPos = v.hitTestAdjusted(e.clientX, e.clientY);
    const at = v.clickPos ?? v.sel.head;
    if (e.detail === 2 && !e.shiftKey) {
      // the word without its markers
      e.preventDefault();
      if (!v.hasFocus()) root.focus({ preventScroll: true });
      const w = wordRange(v.doc, at);
      if (w) v.setSel({ anchor: w[0], head: w[1] }, { dom: true });
      return;
    }
    if (e.detail >= 3 && !e.shiftKey) {
      // the whole raw line: prefix token, text and the newline
      e.preventDefault();
      if (!v.hasFocus()) root.focus({ preventScroll: true });
      const lines = v.doc.lines;
      const li = lineAt(lines, at);
      const line = lines[li]!;
      const end = li + 1 < lines.length ? lines[li + 1]!.from : line.to;
      v.setSel({ anchor: line.from, head: end }, { dom: true });
      return;
    }
    v.lastClick = e.shiftKey || v.clickPos === null ? null : { pos: v.clickPos, time: performance.now() };
  };

  const onFocus = () => {
    v.setPresence(true);
    // restore our selection only for programmatic/keyboard focus: a click places its own
    if (pointerDown || v.readDomSel()) return;
    v.writeDomSel();
  };

  const onMouseUp = () => {
    pointerDown = false;
    // a click that didn't move the DOM caret (e.g. past hidden trailing markers) fires no selectionchange
    const click = v.lastClick;
    v.lastClick = null;
    if (!click || performance.now() - click.time > 1000) return;
    const s = v.readDomSel();
    if (s && s.anchor === s.head && click.pos !== v.sel.head) {
      v.history.stop();
      v.setSel(caret(click.pos), { dom: true });
    }
  };
  const onBlur = () => v.setPresence(false);

  const prevent = (e: Event) => e.preventDefault();

  root.addEventListener("beforeinput", onBeforeInput);
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("compositionstart", onCompositionStart);
  root.addEventListener("compositionend", onCompositionEnd);
  root.addEventListener("copy", onCopy);
  root.addEventListener("cut", onCut);
  root.addEventListener("paste", onPaste);
  root.addEventListener("mousedown", onMouseDown);
  root.addEventListener("focus", onFocus);
  document.addEventListener("mouseup", onMouseUp);
  root.addEventListener("blur", onBlur);
  root.addEventListener("dragstart", prevent);
  root.addEventListener("drop", prevent);
  document.addEventListener("selectionchange", onSelectionChange);
  return () => {
    root.removeEventListener("beforeinput", onBeforeInput);
    root.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("compositionstart", onCompositionStart);
    root.removeEventListener("compositionend", onCompositionEnd);
    root.removeEventListener("copy", onCopy);
    root.removeEventListener("cut", onCut);
    root.removeEventListener("paste", onPaste);
    root.removeEventListener("mousedown", onMouseDown);
    root.removeEventListener("focus", onFocus);
    document.removeEventListener("mouseup", onMouseUp);
    root.removeEventListener("blur", onBlur);
    root.removeEventListener("dragstart", prevent);
    root.removeEventListener("drop", prevent);
    document.removeEventListener("selectionchange", onSelectionChange);
  };
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

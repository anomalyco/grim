// Input controller: beforeinput intents, keyboard shortcuts, composition, clipboard and mouse.
// Every edit is prevented natively and applied to the model; IME composition is the exception
// (it runs natively and is reconciled on compositionend).

import * as rules from "./rules.ts";
import { selFrom, selTo, snapSel } from "./units.ts";
import { moveHorizontal, moveVertical, moveParagraph, type HUnit } from "./navigation.ts";
import type { EditorView } from "./view.ts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function attachInput(v: EditorView): () => void {
  const root = v.root;

  const onBeforeInput = (e: InputEvent) => {
    const t = e.inputType;
    if (t === "insertCompositionText" || t === "deleteCompositionText" || t === "insertFromComposition") return;
    if (v.composing) return;
    e.preventDefault();
    if (v.readOnly) return;
    const doc = v.doc;
    const sel = v.sel;
    const dataText = () => e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
    switch (t) {
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
      v.applyEdit(rules.replaceSelection(v.doc, range, data));
    } else {
      v.render();
      v.setSel(v.sel, { dom: true });
    }
    v.history.stop();
  };

  const onSelectionChange = () => {
    if (v.composing) return;
    const s = v.readDomSel();
    if (!s) return;
    if (s.anchor === v.sel.anchor && s.head === v.sel.head) return;
    const dir = s.head > v.sel.head ? 1 : s.head < v.sel.head ? -1 : 0;
    const ns = snapSel(v.doc, s, dir);
    // a selection change we didn't make: a caret jump, which ends the undo group
    v.history.stop();
    v.setSel(ns, { dom: ns.anchor !== s.anchor || ns.head !== s.head });
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
      const href = chip.dataset.href;
      if (href) window.open(/^[a-z][\w+.-]*:/i.test(href) ? href : "https://" + href, "_blank", "noopener");
      return;
    }
    v.history.stop();
    v.goalX = null;
  };

  const prevent = (e: Event) => e.preventDefault();

  root.addEventListener("beforeinput", onBeforeInput);
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("compositionstart", onCompositionStart);
  root.addEventListener("compositionend", onCompositionEnd);
  root.addEventListener("copy", onCopy);
  root.addEventListener("cut", onCut);
  root.addEventListener("paste", onPaste);
  root.addEventListener("mousedown", onMouseDown);
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
    root.removeEventListener("dragstart", prevent);
    root.removeEventListener("drop", prevent);
    document.removeEventListener("selectionchange", onSelectionChange);
  };
}

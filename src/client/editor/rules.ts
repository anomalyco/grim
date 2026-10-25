// Editing rules: pure functions from (document, selection, intent) to an edit.
// Edits are lists of non-overlapping changes in original-document coordinates plus the selection afterwards.

import { type Doc, type Line, type InlineEl, type InlineType, lineAt, isListType, parseDoc, parseBlocks } from "./parser.ts";
import { type Sel, selFrom, selTo, caret, prevStop, nextStop, isWordChar, wordRange, wordLeft, wordRight } from "./units.ts";

export interface Change {
  from: number;
  to: number;
  insert: string;
}

export type EditKind = "input" | "convert" | "paste" | "format" | "toggle";

export interface Edit {
  changes: Change[];
  sel: Sel;
  kind: EditKind;
  /** A follow-up edit applied as its own undo step (the auto-space of a quote). */
  then?: Edit;
  /**
   * The edit auto-converted the caret's line (e.g. "- " became a bullet). The view records an undo step
   * that shows the line literally again, without changing the shared text.
   */
  converts?: boolean;
}

export function applyChanges(text: string, changes: Change[]): string {
  const sorted = [...changes].sort((a, b) => b.from - a.from);
  let out = text;
  for (const c of sorted) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

/** Map a position through changes (original coordinates -> new). assoc < 0 keeps it before insertions at pos. */
export function mapPos(pos: number, changes: Change[], assoc = 1): number {
  let delta = 0;
  for (const c of changes) {
    if (c.to < pos || (c.to === pos && c.from < pos)) delta += c.insert.length - (c.to - c.from);
    else if (c.from <= pos && pos <= c.to) {
      if (c.from === pos && c.to === pos) {
        if (assoc > 0) delta += c.insert.length;
      } else delta += c.from - pos + (assoc > 0 ? c.insert.length : 0);
    }
  }
  return pos + delta;
}

function edit(changes: Change[], sel: Sel, kind: EditKind = "input"): Edit {
  return { changes, sel, kind };
}

function lineOf(doc: Doc, pos: number): Line {
  return doc.lines[lineAt(doc.lines, pos)]!;
}

/** Replace the selection with `str`. */
export function replaceSelection(doc: Doc, sel: Sel, str: string, kind: EditKind = "input"): Edit {
  const a = selFrom(sel);
  const b = selTo(sel);
  return edit([{ from: a, to: b, insert: str }], caret(a + str.length), kind);
}

/**
 * Run `rule` on the document with the selection deleted, then express the combined result in the
 * original document's coordinates.
 */
function withSelectionDeleted(
  doc: Doc,
  sel: Sel,
  rule: (doc: Doc, pos: number, hadSelection: boolean) => Edit | null,
): Edit | null {
  const a = selFrom(sel);
  const b = selTo(sel);
  if (a === b) return rule(doc, a, false);
  const doc2 = parseDoc(doc.text.slice(0, a) + doc.text.slice(b));
  const e2 = rule(doc2, a, true);
  if (!e2) return edit([{ from: a, to: b, insert: "" }], caret(a));
  const d = b - a;
  const changes: Change[] = [];
  let covered = false;
  for (const c of e2.changes) {
    if (c.from <= a && a <= c.to) {
      covered = true;
      changes.push({ from: c.from, to: c.to < a ? c.to : c.to + d, insert: c.insert });
    } else if (c.to < a) changes.push(c);
    else changes.push({ from: c.from + d, to: c.to + d, insert: c.insert });
  }
  if (!covered) changes.push({ from: a, to: b, insert: "" });
  return edit(changes, e2.sel, e2.kind);
}

// ---------------------------------------------------------------------------------------------
// Typing

/** Typed text, including auto-conversions (flagged with `converts`). */
export function insertText(doc: Doc, sel: Sel, str: string): Edit {
  const a = selFrom(sel);
  const line = lineOf(doc, a);
  if (str === ">" && a === selTo(sel) && line.type === "paragraph" && a === line.textFrom) {
    // ">" converts immediately: the auto-inserted space is its own undo step (undo leaves a literal ">")
    const e = edit([{ from: a, to: a, insert: ">" }], caret(a + 1));
    e.then = edit([{ from: a + 1, to: a + 1, insert: " " }], caret(a + 2), "convert");
    return e;
  }
  const e = replaceSelection(doc, sel, str);
  if (str.includes("\n") || line.type === "code" || line.type === "fence") return e;
  // only the edited line can change type: re-parse just that line
  const b = selTo(sel);
  if (b > line.to) return e;
  const lineText = doc.text.slice(line.from, a) + str + doc.text.slice(b, line.to);
  const after = parseBlocks(lineText)[0]!;
  if (isConversion(line, after)) e.converts = true;
  return e;
}

function isConversion(before: Line, after: Line): boolean {
  if (before.type === after.type) return false;
  if (before.type === "paragraph")
    return after.type === "heading" || isListType(after.type) || after.type === "hr";
  if (before.type === "bullet") return after.type === "todo";
  return false;
}

export function paste(doc: Doc, sel: Sel, str: string): Edit {
  return replaceSelection(doc, sel, str.replace(/\r\n?/g, "\n"), "paste");
}

// ---------------------------------------------------------------------------------------------
// Enter

function continuationPrefix(doc: Doc, line: Line): string {
  const tabs = "\t".repeat(line.indent);
  const tok = line.tokens[line.tokens.length - 1]!;
  const raw = doc.text.slice(tok.from, tok.to);
  switch (line.type) {
    case "todo":
      return tabs + raw[0] + " [ ] ";
    case "numbered":
      return tabs + (line.number + 1) + ". ";
    default:
      return tabs + raw;
  }
}

export function insertParagraph(doc: Doc, sel: Sel): Edit | null {
  return withSelectionDeleted(doc, sel, (d, pos, hadSelection) => {
    const line = lineOf(d, pos);
    const plain = edit([{ from: pos, to: pos, insert: "\n" }], caret(pos + 1));
    if (line.type === "fence" && pos === line.to && hasUnclosedBlock(d)) {
      return edit([{ from: pos, to: pos, insert: "\n\n```" }], caret(pos + 1));
    }
    if (line.type === "code" || line.type === "fence" || line.type === "hr") return plain;
    if (line.tokens.length > 0 && pos === line.from) return plain;
    // between indent tokens: an empty line above
    if (pos > line.from && pos < line.textFrom) {
      return edit([{ from: line.from, to: line.from, insert: "\n" }], caret(pos + 1));
    }
    if (line.type === "heading" && line.textFrom === line.to) {
      return edit([{ from: line.from, to: line.to, insert: "" }], caret(line.from));
    }
    if (isListType(line.type)) {
      if (line.textFrom === line.to && !hadSelection) {
        // empty item: drop the token, the line becomes an empty paragraph
        return edit([{ from: line.from, to: line.to, insert: "" }], caret(line.from));
      }
      if (pos === line.textFrom && line.textFrom < line.to) {
        const prefix = d.text.slice(line.from, line.textFrom);
        const empty = line.type === "todo" ? "\t".repeat(line.indent) + prefix.slice(line.indent, line.indent + 1) + " [ ] " : prefix;
        return edit([{ from: line.from, to: line.from, insert: empty + "\n" }], caret(pos + empty.length + 1));
      }
      const cont = continuationPrefix(d, line);
      return edit([{ from: pos, to: pos, insert: "\n" + cont }], caret(pos + 1 + cont.length));
    }
    if (line.type === "heading" && pos === line.textFrom && line.textFrom < line.to) {
      return edit([{ from: line.from, to: line.from, insert: "\n" }], caret(pos + 1));
    }
    return plain;
  });
}

function hasUnclosedBlock(doc: Doc): boolean {
  const last = doc.lines[doc.lines.length - 1]!;
  if (last.blockStart < 0) return false;
  return !(last.type === "fence" && last.index !== last.blockStart);
}

export function insertLineBreak(doc: Doc, sel: Sel): Edit {
  return replaceSelection(doc, sel, "\n");
}

// ---------------------------------------------------------------------------------------------
// Deletion

function deleteRange(from: number, to: number): Edit | null {
  if (from === to) return null;
  return edit([{ from, to, insert: "" }], caret(from));
}

export function deleteBackward(doc: Doc, sel: Sel): Edit | null {
  if (sel.anchor !== sel.head) return deleteRange(selFrom(sel), selTo(sel));
  return deleteRange(prevStop(doc, sel.head), sel.head);
}

export function deleteForward(doc: Doc, sel: Sel): Edit | null {
  if (sel.anchor !== sel.head) return deleteRange(selFrom(sel), selTo(sel));
  const pos = sel.head;
  const line = lineOf(doc, pos);
  const tok = line.tokens.find((t) => t.from === pos);
  if (tok && tok.kind === "heading" && line.level > 1) return deleteRange(pos, pos + 1);
  return deleteRange(pos, nextStop(doc, pos));
}

/** Option-Backspace: same boundaries as Option-Left (non-word characters, then a word). */
export function deleteWordBackward(doc: Doc, sel: Sel): Edit | null {
  if (sel.anchor !== sel.head) return deleteRange(selFrom(sel), selTo(sel));
  return deleteRange(wordLeft(doc, sel.head), sel.head);
}

export function deleteWordForward(doc: Doc, sel: Sel): Edit | null {
  if (sel.anchor !== sel.head) return deleteRange(selFrom(sel), selTo(sel));
  return deleteRange(sel.head, wordRight(doc, sel.head));
}

/** Cmd-Backspace: delete to the start of the text, then the token, then join lines. */
export function deleteToLineStart(doc: Doc, sel: Sel): Edit | null {
  if (sel.anchor !== sel.head) return deleteRange(selFrom(sel), selTo(sel));
  const pos = sel.head;
  const line = lineOf(doc, pos);
  if (pos > line.textFrom) return deleteRange(line.textFrom, pos);
  return deleteRange(prevStop(doc, pos), pos);
}

export function deleteToLineEnd(doc: Doc, sel: Sel): Edit | null {
  if (sel.anchor !== sel.head) return deleteRange(selFrom(sel), selTo(sel));
  const pos = sel.head;
  const line = lineOf(doc, pos);
  if (pos < line.to) return deleteRange(Math.max(pos, line.from), line.to);
  return deleteRange(pos, nextStop(doc, pos));
}

// ---------------------------------------------------------------------------------------------
// Tab / Shift-Tab

export function tab(doc: Doc, sel: Sel, shift: boolean): Edit | null {
  const a = selFrom(sel);
  const b = selTo(sel);
  const l0 = lineAt(doc.lines, a);
  const l1 = lineAt(doc.lines, b);
  const mapSel = (changes: Change[]): Sel => ({
    anchor: mapPos(sel.anchor, changes),
    head: mapPos(sel.head, changes),
  });
  if (l0 !== l1) {
    const changes: Change[] = [];
    for (let i = l0; i <= l1; i++) {
      const line = doc.lines[i]!;
      if (shift) {
        if (doc.text[line.from] === "\t") changes.push({ from: line.from, to: line.from + 1, insert: "" });
      } else if (line.type !== "code" && line.type !== "fence" && line.from < line.to) {
        changes.push({ from: line.from, to: line.from, insert: "\t" });
      }
    }
    if (!changes.length) return null;
    return edit(changes, mapSel(changes));
  }
  const line = doc.lines[l0]!;
  if (shift) {
    if (line.type === "paragraph") return edit([], sel);
    if (doc.text[line.from] !== "\t") return null;
    const changes = [{ from: line.from, to: line.from + 1, insert: "" }];
    return edit(changes, mapSel(changes));
  }
  if (line.type === "code" || line.type === "fence" || line.type === "heading" || line.type === "hr") {
    return replaceSelection(doc, sel, "\t");
  }
  if (isListType(line.type)) {
    if (a === b && a > line.textFrom) return replaceSelection(doc, sel, "\t");
    const prev = l0 > 0 ? doc.lines[l0 - 1]! : null;
    const max = prev && isListType(prev.type) ? prev.indent + 1 : 0;
    if (line.indent >= max) return edit([], sel);
    const changes = [{ from: line.from, to: line.from, insert: "\t" }];
    return edit(changes, mapSel(changes));
  }
  return replaceSelection(doc, sel, "\t");
}

// ---------------------------------------------------------------------------------------------
// Cmd-B / Cmd-I / Cmd-U

export type FormatType = "bold" | "italic" | "underline" | "strike" | "highlight";

const MARKER: Record<FormatType, string> = {
  bold: "**",
  italic: "*",
  underline: "~",
  strike: "~~",
  highlight: "==",
};

const MARKER_ONLY = /^[*_~=]*$/;

function unwrap(el: InlineEl, sel: Sel): Edit {
  const [o, c] = el.markers as [[number, number], [number, number]];
  const changes = [
    { from: o[0], to: o[1], insert: "" },
    { from: c[0], to: c[1], insert: "" },
  ];
  const ol = o[1] - o[0];
  const m = (p: number) => (p <= o[0] ? p : p <= o[1] ? o[0] : p <= c[0] ? p - ol : c[0] - ol);
  return edit(changes, { anchor: m(sel.anchor), head: m(sel.head) }, "format");
}

export function toggleFormat(doc: Doc, sel: Sel, type: FormatType): Edit | null {
  const mk = MARKER[type];
  const L = mk.length;
  const a = selFrom(sel);
  const b = selTo(sel);
  const line = lineOf(doc, a);
  if (line.type === "code" || line.type === "fence" || line.type === "hr") return null;
  const els = line.inline.filter((e) => e.type === (type as InlineType));
  const t = doc.text;
  if (a !== b && b <= line.textFrom) return null;
  if (a < line.textFrom) {
    // never put markers before a block token
    const sel2 = a === b ? caret(line.textFrom) : sel.anchor <= sel.head ? { anchor: line.textFrom, head: b } : { anchor: b, head: line.textFrom };
    return toggleFormat(doc, sel2, type);
  }
  if (a !== b) {
    if (lineAt(doc.lines, b) !== line.index) return null;
    for (const el of els) {
      const inside =
        el.contentFrom <= a &&
        b <= el.contentTo &&
        MARKER_ONLY.test(t.slice(el.contentFrom, a)) &&
        MARKER_ONLY.test(t.slice(b, el.contentTo));
      if (inside || (el.from === a && el.to === b)) return unwrap(el, sel);
    }
    const changes = [
      { from: a, to: a, insert: mk },
      { from: b, to: b, insert: mk },
    ];
    const fwd = sel.anchor <= sel.head;
    return edit(changes, fwd ? { anchor: a + L, head: b + L } : { anchor: b + L, head: a + L }, "format");
  }
  const pos = a;
  for (const el of els) if (el.from <= pos && pos <= el.to) return unwrap(el, sel);
  const inWord = pos > line.textFrom && isWordChar(t[pos - 1]) && isWordChar(t[pos]);
  const w = inWord ? wordRange(doc, pos) : null;
  if (w) {
    const changes = [
      { from: w[0], to: w[0], insert: mk },
      { from: w[1], to: w[1], insert: mk },
    ];
    return edit(changes, caret(pos + L), "format");
  }
  if (t.slice(pos - L, pos) === mk && t.slice(pos, pos + L) === mk) {
    return edit([{ from: pos - L, to: pos + L, insert: "" }], caret(pos - L), "format");
  }
  return edit([{ from: pos, to: pos, insert: mk + mk }], caret(pos + L), "format");
}

// ---------------------------------------------------------------------------------------------
// Todo checkbox

export function toggleTodo(doc: Doc, lineIndex: number): Edit | null {
  const line = doc.lines[lineIndex];
  if (!line || line.type !== "todo") return null;
  const tok = line.tokens[line.tokens.length - 1]!;
  const i = doc.text.indexOf("[", tok.from) + 1;
  return edit([{ from: i, to: i + 1, insert: line.checked ? " " : "x" }], caret(line.textFrom), "toggle");
}

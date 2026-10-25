// Editing rules: pure functions from (document, selection, intent) to an edit.
// Edits are lists of non-overlapping changes in original-document coordinates plus the selection afterwards.

import { type BlockType, type Doc, type Line, type InlineEl, type InlineType, lineAt, isListType, parseDoc, parseBlocks } from "./parser.ts";
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
  converts?: BlockType;
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
  if (isConversion(line, after)) e.converts = line.type;
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

/** Prefix for a new item of the same kind as `line` (same raw indentation); `next` increments numbers. */
function itemPrefix(doc: Doc, line: Line, next: boolean): string {
  const tok = line.tokens[line.tokens.length - 1]!;
  const indent = doc.text.slice(line.from, tok.from);
  const raw = doc.text.slice(tok.from, tok.to);
  const lead = /^ */.exec(raw)![0];
  const mark = raw.slice(lead.length);
  switch (line.type) {
    case "todo":
      return indent + lead + mark[0] + " [ ] ";
    case "numbered":
      return indent + lead + (next ? line.number + 1 : line.number) + ". ";
    default:
      return indent + raw;
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
    if (line.table) return tableEnter(d, line);
    if (line.tokens.length > 0 && pos === line.from) return plain;
    // between indent tokens: an empty line above
    if (pos > line.from && pos < line.textFrom) {
      return edit([{ from: line.from, to: line.from, insert: "\n" }], caret(pos + 1));
    }
    if (line.type === "heading" && line.textFrom === line.to && !hadSelection) {
      return edit([{ from: line.from, to: line.to, insert: "" }], caret(line.from));
    }
    if (isListType(line.type)) {
      if (line.textFrom === line.to && !hadSelection) {
        // empty item: drop the token, the line becomes an empty paragraph
        return edit([{ from: line.from, to: line.to, insert: "" }], caret(line.from));
      }
      if (pos === line.textFrom && line.textFrom < line.to) {
        const empty = itemPrefix(d, line, false);
        return edit([{ from: line.from, to: line.from, insert: empty + "\n" }], caret(pos + empty.length + 1));
      }
      const cont = itemPrefix(d, line, true);
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
  const line = lineOf(doc, sel.head);
  // after a horizontal rule: remove the rule token, leaving an empty line
  const hr = line.type === "hr" && sel.head === line.to ? line.tokens.find((t) => t.kind === "hr") : undefined;
  if (hr) return deleteRange(hr.from, hr.to);
  return deleteRange(prevStop(doc, sel.head), sel.head);
}

export function deleteForward(doc: Doc, sel: Sel): Edit | null {
  if (sel.anchor !== sel.head) return deleteRange(selFrom(sel), selTo(sel));
  const pos = sel.head;
  const line = lineOf(doc, pos);
  const tok = line.tokens.find((t) => t.from === pos);
  if (tok && tok.kind === "heading" && line.level > 1) return deleteRange(pos, pos + 1);
  // at the end of a line: join the next line raw (just the newline)
  if (pos === line.to && pos < doc.text.length) return deleteRange(pos, pos + 1);
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
        const first = outdentChange(line);
        if (first) changes.push(first);
      } else if (line.type !== "code" && line.type !== "fence" && line.from < line.to) {
        changes.push({ from: line.from, to: line.from, insert: line.indentUnit });
      }
    }
    if (!changes.length) return null;
    return edit(changes, mapSel(changes));
  }
  const line = doc.lines[l0]!;
  if (line.table) return tableTab(doc, line, a, shift);
  if (shift) {
    if (line.type === "paragraph") return edit([], sel);
    if (line.type === "code" || line.type === "fence") {
      if (doc.text[line.from] !== "\t") return null;
      const changes = [{ from: line.from, to: line.from + 1, insert: "" }];
      return edit(changes, mapSel(changes));
    }
    const first = outdentChange(line);
    if (!first) return null;
    return edit([first], mapSel([first]));
  }
  if (line.type === "code" || line.type === "fence" || line.type === "heading" || line.type === "hr") {
    return replaceSelection(doc, sel, "\t");
  }
  if (isListType(line.type)) {
    if (a === b && a > line.textFrom) return replaceSelection(doc, sel, "\t");
    const prev = l0 > 0 ? doc.lines[l0 - 1]! : null;
    const max = prev && isListType(prev.type) ? prev.indent + 1 : 0;
    if (line.indent >= max) return edit([], sel);
    // same unit as the line's own indentation, else as the item above, else a tab
    const unit = line.indent > 0 ? line.indentUnit : prev && prev.indent > 0 ? prev.indentUnit : "\t";
    const changes = [{ from: line.from, to: line.from, insert: unit }];
    return edit(changes, mapSel(changes));
  }
  return replaceSelection(doc, sel, "\t");
}

// ---------------------------------------------------------------------------------------------
// Tables

/** Where the caret goes in a cell: its text start (after the padding; one space in for an empty cell). */
function cellTarget(text: string, [cf, ct]: [number, number]): number {
  let p = cf;
  while (p < ct && (text[p] === " " || text[p] === "\t")) p++;
  return p < ct ? p : Math.min(cf + 1, ct);
}

/**
 * Enter in a table: a new empty row below (below the delimiter row when on the header) with the caret
 * in its first cell; on an empty last row, the row is removed, which ends the table.
 */
function tableEnter(doc: Doc, line: Line, canExit = true): Edit {
  const tb = line.table!;
  if (canExit && line.type === "table-row" && line.index === tb.end && line.text.replace(/[|\s]/g, "") === "") {
    return edit([{ from: line.from, to: line.to, insert: "" }], caret(line.from));
  }
  const after = line.type === "table-head" ? doc.lines[line.index + 1]! : line;
  const n = doc.lines[tb.start]!.table!.cells.length;
  const row = "|" + " |".repeat(n);
  return edit([{ from: after.to, to: after.to, insert: "\n" + row }], caret(after.to + 3));
}

/** Tab / Shift-Tab in a table: next / previous cell (across rows; Tab after the last cell adds a row). */
function tableTab(doc: Doc, line: Line, pos: number, shift: boolean): Edit {
  const tb = line.table!;
  const targets: { line: number; from: number; to: number; pos: number }[] = [];
  for (let k = tb.start; k <= tb.end; k++) {
    const l = doc.lines[k]!;
    if (l.type === "table-delim") continue;
    for (const cell of l.table!.cells) targets.push({ line: k, from: cell[0], to: cell[1], pos: cellTarget(doc.text, cell) });
  }
  let g = targets.findIndex((t) => t.line === line.index && t.from <= pos && pos <= t.to);
  let next: number;
  let prev: number;
  if (g >= 0) {
    next = g + 1;
    prev = g - 1;
  } else {
    // before the first cell, or on the delimiter row
    const after = targets.findIndex((t) => t.line > line.index || (t.line === line.index && t.from >= pos));
    next = after < 0 ? targets.length : after;
    prev = next - 1;
  }
  g = shift ? prev : next;
  if (g < 0) return edit([], caret(pos));
  if (g >= targets.length) return tableEnter(doc, doc.lines[tb.end]!, false);
  return edit([], caret(targets[g]!.pos));
}

/** Remove one indent level: the line's first indent token (a tab or a unit of spaces). */
function outdentChange(line: Line): Change | null {
  const t = line.tokens[0];
  return t && t.kind === "indent" ? { from: t.from, to: t.to, insert: "" } : null;
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

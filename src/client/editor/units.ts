// Caret units over the raw text: which offsets are caret stops, and stepping by unit or word.
// Atomic units (one caret step): block prefix tokens, link URL chips, escape pairs (`\*`) and surrogate pairs.

import { type Doc, type Line, lineAt } from "./parser.ts";

export interface Sel {
  anchor: number;
  head: number;
}

export function selFrom(s: Sel): number {
  return Math.min(s.anchor, s.head);
}
export function selTo(s: Sel): number {
  return Math.max(s.anchor, s.head);
}
export function caret(pos: number): Sel {
  return { anchor: pos, head: pos };
}

/** The atomic range strictly containing `pos`, if any. */
export function atomicAround(doc: Doc, pos: number): [number, number] | null {
  const line = doc.lines[lineAt(doc.lines, pos)]!;
  return atomicAroundInLine(doc.text, line, pos);
}

function atomicAroundInLine(text: string, line: Line, pos: number): [number, number] | null {
  // a horizontal rule has a single caret stop, at its start
  if (line.type === "hr" && pos > line.from && pos <= line.to) {
    return [line.from, line.to < text.length ? line.to + 1 : line.from];
  }
  if (pos <= line.from || pos >= line.to) return null;
  for (const t of line.tokens) if (t.from < pos && pos < t.to) return [t.from, t.to];
  if (pos >= line.textFrom) {
    for (const el of line.inline) {
      if (el.url && el.url[0] < pos && pos < el.url[1]) return [el.url[0], el.url[1]];
    }
    for (const e of line.escapes) if (pos === e + 1) return [e, e + 2];
  }
  const c = text.charCodeAt(pos);
  if (c >= 0xdc00 && c <= 0xdfff) {
    const p = text.charCodeAt(pos - 1);
    if (p >= 0xd800 && p <= 0xdbff) return [pos - 1, pos + 1];
  }
  return null;
}

export function isStop(doc: Doc, pos: number): boolean {
  return atomicAround(doc, pos) === null;
}

/** Snap a position to a caret stop: dir > 0 forward, dir < 0 backward, 0 nearest. */
export function snap(doc: Doc, pos: number, dir: number): number {
  pos = Math.max(0, Math.min(doc.text.length, pos));
  const line = doc.lines[lineAt(doc.lines, pos)]!;
  const a = atomicAroundInLine(doc.text, line, pos);
  if (!a) return pos;
  if (dir > 0) return a[1];
  if (dir < 0 || line.type === "hr") return a[0];
  return pos - a[0] <= a[1] - pos ? a[0] : a[1];
}

export function snapSel(doc: Doc, s: Sel, dir = 0): Sel {
  return { anchor: snap(doc, s.anchor, dir), head: snap(doc, s.head, dir) };
}

export function nextStop(doc: Doc, pos: number): number {
  if (pos >= doc.text.length) return doc.text.length;
  return snap(doc, pos + 1, 1);
}

export function prevStop(doc: Doc, pos: number): number {
  if (pos <= 0) return 0;
  return snap(doc, pos - 1, -1);
}

const WORD = /[\p{L}\p{N}\p{M}_]/u;

export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch);
}

/** Inside a block token or a link URL (atomic units that are never part of a word). */
function inAtomic(doc: Doc, pos: number): boolean {
  const line = doc.lines[lineAt(doc.lines, pos)]!;
  for (const t of line.tokens) if (t.from <= pos && pos < t.to) return true;
  for (const el of line.inline) if (el.url && el.url[0] <= pos && pos < el.url[1]) return true;
  return false;
}

function wordAt(doc: Doc, i: number): boolean {
  return isWordChar(doc.text[i]) && !inAtomic(doc, i);
}

/** Option-Right: skip non-word characters (markers, spaces, tokens), then a word. */
export function wordRight(doc: Doc, pos: number): number {
  const n = doc.text.length;
  let i = pos;
  while (i < n && !wordAt(doc, i)) i++;
  while (i < n && wordAt(doc, i)) i++;
  return snap(doc, i, 1);
}

/** Option-Left: skip non-word characters backwards, then a word. */
export function wordLeft(doc: Doc, pos: number): number {
  let i = pos;
  while (i > 0 && !wordAt(doc, i - 1)) i--;
  while (i > 0 && wordAt(doc, i - 1)) i--;
  return snap(doc, i, -1);
}

/** Range of the word around `pos`, if the caret touches a word. */
export function wordRange(doc: Doc, pos: number): [number, number] | null {
  const t = doc.text;
  if (!wordAt(doc, pos - 1) && !wordAt(doc, pos)) return null;
  let a = pos;
  let b = pos;
  while (a > 0 && wordAt(doc, a - 1)) a--;
  while (b < t.length && wordAt(doc, b)) b++;
  return [a, b];
}

// Moving per-line values (line authors) through a text change, shared by the server (who wrote each line, blame.ts)
// and the web client (keeping the server's line authors in place between its messages, editor-rs/authors.ts).
import { linePairs } from "./textdiff.ts";

/** What changed lines get: a value, or KEEP (each keeps the value of the old line at its place in the change). */
export const KEEP = "keep";

/**
 * Who last had each line text that an edit took away (`attribute`'s `history`): when an edit brings a line's
 * exact text back (undo, redo, typing it back, pasting it back), the line gets that author again instead of the
 * editor. Blank lines aren't remembered. Bounded: the newest MAX_HISTORY texts.
 */
export interface LineHistory {
  remember(text: string, value: number): void;
  recall(text: string): number | undefined;
}

/** How many removed line texts a LineHistory keeps (and the longest text it keeps). */
export const MAX_HISTORY = 500;
export const MAX_HISTORY_TEXT = 4000;

/** A LineHistory on a Map (insertion order = age); `entries()` for persisting it. */
export class LineMemory implements LineHistory {
  private map = new Map<string, number>();
  constructor(entries: Array<[string, number]> = []) {
    for (const [t, v] of entries) if (typeof t === "string" && typeof v === "number") this.remember(t, v);
  }
  remember(text: string, value: number): void {
    if (!text.trim() || text.length > MAX_HISTORY_TEXT) return;
    this.map.delete(text);
    this.map.set(text, value);
    if (this.map.size > MAX_HISTORY) this.map.delete(this.map.keys().next().value!);
  }
  recall(text: string): number | undefined {
    return text.trim() ? this.map.get(text) : undefined;
  }
  /** Change or drop (`undefined`) every remembered value. */
  remap(fn: (v: number) => number | undefined): void {
    for (const [t, v] of [...this.map]) {
      const n = fn(v);
      if (n === undefined) this.map.delete(t);
      else this.map.set(t, n);
    }
  }
  entries(): Array<[string, number]> {
    return [...this.map];
  }
}

/**
 * The values after the text changed from `prev` to `next` (`values` has one per line of `prev`, split at "\n"):
 * lines the change left as they were keep theirs, changed and new lines get `who`. Only the lines between the
 * change's first and last character are diffed (by line), so an edit costs one pass over the text.
 * With a `history` (and a `who`): the lines the change took away are remembered with their values, and a changed
 * or new line whose exact text the history knows gets the remembered value instead of `who`.
 */
export function attribute(prev: string, next: string, values: number[], who: number | typeof KEEP, history?: LineHistory): number[] {
  if (prev === next) return values;
  let p = 0;
  const max = Math.min(prev.length, next.length);
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  // the lines holding the changed range, whole: from the start of p's line to the end of the last changed line
  const from = p === 0 ? 0 : prev.lastIndexOf("\n", p - 1) + 1;
  let first = 0;
  for (let i = prev.indexOf("\n"); i >= 0 && i < from; i = prev.indexOf("\n", i + 1)) first++;
  const oldLines = prev.slice(from, lineEnd(prev, prev.length - s)).split("\n");
  const newLines = next.slice(from, lineEnd(next, next.length - s)).split("\n");
  const old = (i: number) => values[first + i] ?? -1;
  const mid: number[] = newLines.map((_, i) => (who === KEEP ? old(Math.min(i, oldLines.length - 1)) : who));
  const pairs = linePairs(oldLines, newLines, 2000);
  for (const [a, b] of pairs) mid[b] = old(a);
  if (history && who !== KEEP) {
    const keptOld = new Set(pairs.map(([a]) => a));
    const keptNew = new Set(pairs.map(([, b]) => b));
    oldLines.forEach((t, a) => {
      if (!keptOld.has(a)) history.remember(t, old(a));
    });
    newLines.forEach((t, b) => {
      if (keptNew.has(b)) return;
      const v = history.recall(t);
      if (v !== undefined) mid[b] = v;
    });
  }
  const out = values.slice(0, first);
  for (const v of mid) out.push(v);
  for (let i = first + oldLines.length; i < values.length; i++) out.push(values[i]!);
  return out;
}

/** End of the line holding position `i` (the index of its newline, or the text's end). */
function lineEnd(text: string, i: number): number {
  const nl = text.indexOf("\n", i);
  return nl < 0 ? text.length : nl;
}

// Moving per-line values (line authors) through a text change, shared by the server (who wrote each line, blame.ts)
// and the web client (keeping the server's line authors in place between its messages, editor-rs/authors.ts).
import { linePairs } from "./textdiff.ts";

/** What changed lines get: a value, or KEEP (each keeps the value of the old line at its place in the change). */
export const KEEP = "keep";

/**
 * The values after the text changed from `prev` to `next` (`values` has one per line of `prev`, split at "\n"):
 * lines the change left as they were keep theirs, changed and new lines get `who`. Only the lines between the
 * change's first and last character are diffed (by line), so an edit costs one pass over the text.
 */
export function attribute(prev: string, next: string, values: number[], who: number | typeof KEEP): number[] {
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
  for (const [a, b] of linePairs(oldLines, newLines, 2000)) mid[b] = old(a);
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

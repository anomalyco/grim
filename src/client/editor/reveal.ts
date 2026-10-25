// Reveal engine: which markers are shown for the local selection. Pure.
// An inline element reveals when the caret is in [from, to] (inclusive) or it strictly overlaps the selection,
// together with every element nested inside it. Code fences reveal when the selection touches the block.

import { type Doc, lineAt } from "./parser.ts";
import { type Sel, selFrom, selTo } from "./units.ts";

export interface LineReveal {
  /** Indices into line.inline of revealed elements. */
  els: number[];
  fence: boolean;
  active: boolean;
}

export function computeReveal(doc: Doc, sel: Sel | null): Map<number, LineReveal> {
  const out = new Map<number, LineReveal>();
  if (!sel) return out;
  const a = selFrom(sel);
  const b = selTo(sel);
  const l0 = lineAt(doc.lines, a);
  const l1 = lineAt(doc.lines, b);
  const get = (i: number): LineReveal => {
    let r = out.get(i);
    if (!r) out.set(i, (r = { els: [], fence: false, active: false }));
    return r;
  };
  get(lineAt(doc.lines, sel.head)).active = true;
  for (let i = l0; i <= l1; i++) {
    const line = doc.lines[i]!;
    if (line.blockStart >= 0) {
      get(line.blockStart).fence = true;
      const end = doc.lines[line.blockEnd]!;
      if (end.type === "fence") get(line.blockEnd).fence = true;
      continue;
    }
    // caret: inclusive edges; selection: strict overlap
    const hit: boolean[] = line.inline.map((el) => (a === b ? el.from <= a && a <= el.to : el.from < b && el.to > a));
    line.inline.forEach((el, k) => {
      if (!hit[k]) return;
      line.inline.forEach((inner, j) => {
        if (inner.from >= el.from && inner.to <= el.to) hit[j] = true;
      });
    });
    const els: number[] = [];
    hit.forEach((h, k) => h && els.push(k));
    if (els.length) get(i).els = els;
  }
  return out;
}

export function revealKey(r: LineReveal | undefined): string {
  if (!r) return "";
  return (r.active ? "a" : "") + (r.fence ? "f" : "") + ":" + r.els.join(",");
}

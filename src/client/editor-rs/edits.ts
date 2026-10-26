// Text edits as the engine reports them (UTF-16 offsets, applied in order).

import type { Edit } from "./types.ts";

/** Apply edits in order (each one's offsets are in the text left by the previous ones). */
export function applyEdits(text: string, edits: Edit[]): string {
  for (const e of edits) text = text.slice(0, e.from) + e.insert + text.slice(e.to);
  return text;
}

export type DeltaOp = { retain?: number; delete?: number; insert?: string | object };

/** A Y.Text delta as edits in order (a deletion followed by an insertion at the same place becomes one edit). */
export function deltaToEdits(delta: DeltaOp[]): Edit[] {
  const out: Edit[] = [];
  let pos = 0;
  for (const d of delta) {
    if (d.retain) pos += d.retain;
    else if (d.delete) out.push({ from: pos, to: pos + d.delete, insert: "" });
    else if (d.insert !== undefined) {
      const s = typeof d.insert === "string" ? d.insert : "\ufffc";
      const prev = out[out.length - 1];
      if (prev && prev.from === pos && prev.insert === "") prev.insert = s;
      else out.push({ from: pos, to: pos, insert: s });
      pos += s.length;
    }
  }
  return out;
}

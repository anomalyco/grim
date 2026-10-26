import type * as Y from "yjs";
import { diffText, type Splice } from "../shared/textdiff.ts";

export { applySplices, diffText, rebaseSplices, type Splice } from "../shared/textdiff.ts";

/** Apply sorted, non-overlapping splices (positions in the current text) to `ytext`; returns the index after the last change. */
export function applyToYText(ytext: Y.Text, splices: Splice[]): number {
  let shift = 0;
  for (const s of splices) shift += s.ins.length - s.del;
  for (let i = splices.length - 1; i >= 0; i--) {
    const s = splices[i]!;
    if (s.del) ytext.delete(s.pos, s.del);
    if (s.ins) ytext.insert(s.pos, s.ins);
  }
  const last = splices[splices.length - 1];
  return last ? last.pos + last.ins.length + shift - (last.ins.length - last.del) : 0;
}

/** Turn the text of `ytext` (currently `from`) into `to` with a minimal edit. Returns the splices applied. */
export function applyDiff(ytext: Y.Text, from: string, to: string): Splice[] {
  const splices = diffText(from, to);
  applyToYText(ytext, splices);
  return splices;
}

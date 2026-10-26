// Caret navigation: Left/Right by raw unit (atomic tokens count as one), word and line jumps, and
// Up/Down with a goal x hit-tested in the current (pre-reveal) layout, then revealed.

import { lineAt } from "./parser.ts";
import { type Sel, caret, selFrom, selTo, nextStop, prevStop, wordLeft, wordRight, snap } from "./units.ts";
import type { EditorView } from "./view.ts";

export type HUnit = "char" | "word" | "line" | "doc";

export function moveHorizontal(v: EditorView, dir: -1 | 1, extend: boolean, unit: HUnit): void {
  const doc = v.doc;
  const s = v.sel;
  if (!extend && s.anchor !== s.head && unit === "char") {
    v.setSel(caret(dir < 0 ? selFrom(s) : selTo(s)), { dom: true, scroll: true });
    return;
  }
  let p = s.head;
  switch (unit) {
    case "char":
      p = dir < 0 ? prevStop(doc, p) : nextStop(doc, p);
      break;
    case "word":
      p = dir < 0 ? wordLeft(doc, p) : wordRight(doc, p);
      break;
    case "line": {
      const line = doc.lines[lineAt(doc.lines, p)]!;
      if (dir < 0) p = p > line.textFrom ? line.textFrom : line.from;
      else p = line.to;
      break;
    }
    case "doc":
      p = dir < 0 ? 0 : doc.text.length;
      break;
  }
  p = snap(doc, p, unit === "char" || unit === "word" ? dir : 0);
  const next: Sel = extend ? { anchor: s.anchor, head: p } : caret(p);
  v.setSel(next, { dom: true, scroll: true });
}

/** Option-Up/Down: start of the current/previous paragraph, end of the current/next one. */
export function moveParagraph(v: EditorView, dir: -1 | 1, extend: boolean): void {
  const doc = v.doc;
  const s = v.sel;
  const li = lineAt(doc.lines, s.head);
  const line = doc.lines[li]!;
  let p: number;
  if (dir < 0) p = s.head > line.from ? line.from : li > 0 ? doc.lines[li - 1]!.from : 0;
  else p = s.head < line.to ? line.to : li + 1 < doc.lines.length ? doc.lines[li + 1]!.to : doc.text.length;
  p = snap(doc, p, dir);
  v.setSel(extend ? { anchor: s.anchor, head: p } : caret(p), { dom: true, scroll: true });
}

export function moveVertical(v: EditorView, dir: -1 | 1, extend: boolean): void {
  const doc = v.doc;
  const s = v.sel;
  const from = extend || s.anchor === s.head ? s.head : dir < 0 ? selFrom(s) : selTo(s);
  let cur = v.caretRect(from);
  if (v.goalX === null) v.goalX = cur.left;
  const goal = v.goalX;
  let curMid = (cur.top + cur.bottom) / 2;
  let y = dir < 0 ? cur.top - 1 : cur.bottom + 1;
  let rootRect = v.root.getBoundingClientRect();
  let target: number | null = null;
  const [vt, vb] = v.visibleBounds();
  for (let i = 0; i < 500; i++) {
    if (dir < 0 ? y < rootRect.top : y > rootRect.bottom) break;
    if (y < vt + 1 || y > vb - 1) {
      const before = rootRect.top;
      v.scrollBy(y < vt + 1 ? y - vt - 40 : y - vb + 40);
      rootRect = v.root.getBoundingClientRect();
      const shift = rootRect.top - before;
      if (shift === 0) break;
      y += shift;
      curMid += shift;
      cur = { left: cur.left, top: cur.top + shift, bottom: cur.bottom + shift };
      continue;
    }
    const x = Math.max(rootRect.left + 1, Math.min(rootRect.right - 1, goal));
    // images below a line's text aren't caret stops (except on a collapsed line of only images): step over them
    const imgs = document.elementFromPoint(x, y)?.closest(".imgs");
    if (imgs && v.root.contains(imgs) && !imgs.closest(".ln-img:not(.img-rv)")) {
      const ir = imgs.getBoundingClientRect();
      y = dir < 0 ? Math.min(y - 4, ir.top - 1) : Math.max(y + 4, ir.bottom + 1);
      continue;
    }
    const pos = v.hitTestAdjusted(x, y);
    if (pos !== null) {
      const r = v.caretRect(pos);
      const mid = (r.top + r.bottom) / 2;
      // must be on another visual line: no vertical overlap with the current caret box
      if (dir < 0 ? r.bottom <= cur.top + 2 && mid < curMid : r.top >= cur.bottom - 2 && mid > curMid) {
        target = pos;
        // the probe may have hit padding around the line box (headings): re-hit at the line's middle
        if (y < r.top || y > r.bottom) {
          const again = v.hitTestAdjusted(x, mid);
          if (again !== null) target = again;
        }
        break;
      }
    }
    y += dir * 4;
  }
  if (target === null) target = dir < 0 ? 0 : doc.text.length;
  target = snap(doc, target, 0);
  v.setSel(extend ? { anchor: s.anchor, head: target } : caret(target), { dom: true, scroll: true, keepGoal: true });
}

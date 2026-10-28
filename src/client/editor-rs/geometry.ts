// DOM geometry: caret boxes and native hit-testing over the rendered lines.

import { type DomPos, type OffsetDoc, lineAt, rawToDom } from "./offsets.ts";
import { lineDivs } from "./blocks.ts";

export interface Rect {
  left: number;
  top: number;
  bottom: number;
}

/** Client rect of a caret at raw offset `pos` (line divs in `doc.lines` order: blocks.ts). */
export function caretRect(root: HTMLElement, doc: OffsetDoc, pos: number): Rect {
  const p = rawToDom(root, doc, pos);
  const range = document.createRange();
  range.setStart(p.node, p.offset);
  range.collapse(true);
  const rects = range.getClientRects();
  const r = rects[0];
  if (r && r.height > 1) return { left: r.left, top: r.top, bottom: r.bottom };
  const li = lineAt(doc.lines, pos);
  const div = (lineDivs(root)[li] as HTMLElement | undefined) ?? null;
  const lineBox = (): { top: number; bottom: number } => {
    if (!div) return { top: 0, bottom: 0 };
    // table rows: the cell's box (its padding) rather than the row's
    const anchor = p.node.nodeType === 1 ? (p.node as Element) : p.node.parentElement;
    const box = (div.classList.contains("ln-table") && anchor?.closest(".tcell")) || div;
    const dr = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
    const top = dr.top + (parseFloat(cs.paddingTop) || 0);
    // collapsed lines (e.g. a hidden code fence) are shorter than one line height
    return { top, bottom: Math.min(top + lh, dr.bottom) };
  };
  let el: Element | null = null;
  let atRight = false;
  if (p.node.nodeType === 3) el = p.node.parentElement;
  else {
    const at = p.node.childNodes[p.offset];
    // the end of a line with images is after its text, not at the images below it
    const child = at && at.nodeType === 1 && (at as Element).classList.contains("imgs") ? undefined : at;
    if (child && child.nodeType === 1 && (child as Element).tagName !== "BR") el = child as Element;
    else if (child && (child as Element).tagName === "BR") {
      const br = (child as Element).getBoundingClientRect();
      if (br.height > 1) return { left: br.left, top: br.top, bottom: br.bottom };
      const prev = child.previousSibling;
      if (prev && prev.nodeType === 1) {
        el = prev as Element;
        atRight = true;
      }
    } else if (p.offset > 0 && p.node.childNodes[p.offset - 1]?.nodeType === 1) {
      el = p.node.childNodes[p.offset - 1] as Element;
      atRight = true;
    }
  }
  if (el && el !== div) {
    const er = el.getBoundingClientRect();
    if (er.height > 1 && !el.classList.contains("mk")) {
      return { left: atRight ? er.right : er.left, top: er.top, bottom: er.bottom };
    }
    // a collapsed marker has no height but sits on its visual line's baseline: on a wrapped line, that's
    // not necessarily the first one
    const lb = (div && !div.classList.contains("ln-table") && visualLineAt(div, er.top)) || lineBox();
    return { left: atRight ? er.right : er.left, ...lb };
  }
  const lb = lineBox();
  if (!div) return { left: 0, ...lb };
  const dr = div.getBoundingClientRect();
  const cs = getComputedStyle(div);
  return { left: dr.left + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.textIndent) || 0), ...lb };
}

/** Top and bottom of the visual line of a line's text (not its images) that contains `y`, if any. */
export function visualLineAt(div: HTMLElement, y: number): { top: number; bottom: number } | null {
  const range = document.createRange();
  let best: { top: number; bottom: number } | null = null;
  for (const child of div.children) {
    if (child.classList.contains("imgs")) continue;
    range.selectNodeContents(child);
    for (const r of range.getClientRects()) {
      if (r.height <= 1 || y < r.top - 0.5 || y > r.bottom + 0.5) continue;
      // the tallest box on that line (a heading's text rather than a small marker)
      if (!best || r.bottom - r.top > best.bottom - best.top) best = { top: r.top, bottom: r.bottom };
    }
  }
  return best;
}

/** The DOM caret position at a client point (caretPositionFromPoint / caretRangeFromPoint), if any. */
export function caretPointFromClient(x: number, y: number): DomPos | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

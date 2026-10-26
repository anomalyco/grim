// JsLayout (contract 3) answered from the rendered DOM. Content coordinates: CSS px from the top-left of the
// editor root's border box, scroll included, so they don't change when the page or the root scrolls.

import { domToRaw, lineAt, type OffsetDoc } from "./offsets.ts";
import { caretPointFromClient, caretRect } from "./geometry.ts";
import type { JsLayout } from "./types.ts";

export interface LayoutHost {
  root: HTMLElement;
  wrapper: HTMLElement;
  doc: OffsetDoc;
}

interface Band {
  top: number;
  bottom: number;
}

interface Box extends Band {
  left: number;
  right: number;
}

export class DomLayout implements JsLayout {
  /** Answer adjacent_line_y from line boxes (false: let the engine probe with hit_test). */
  adjacentLines = true;

  constructor(private host: LayoutHost) {}

  /** Client position of the content origin. */
  origin(): [number, number] {
    const root = this.host.root;
    const r = root.getBoundingClientRect();
    return [r.left - root.scrollLeft, r.top - root.scrollTop];
  }

  fromClient(x: number, y: number): [number, number] {
    const [ox, oy] = this.origin();
    return [x - ox, y - oy];
  }

  caret_rect(pos: number): [number, number, number, number] {
    const [ox, oy] = this.origin();
    const r = caretRect(this.host.root, this.host.doc, pos);
    return [r.left - ox, r.top - oy, 0, Math.max(0, r.bottom - r.top)];
  }

  hit_test(x: number, y: number): number | undefined {
    let [ox, oy] = this.origin();
    let cy = y + oy;
    // native hit-testing only works inside the viewport: bring the point into view first
    const [vt, vb] = visibleBounds(this.host.wrapper);
    if (cy < vt + 1 || cy > vb - 1) {
      scrollBy(this.host.wrapper, cy < vt + 1 ? cy - vt - 40 : cy - vb + 40);
      [ox, oy] = this.origin();
      cy = y + oy;
    }
    const cx = Math.max(0, Math.min(window.innerWidth - 1, x + ox));
    // on a line-prefix token (indent, bullet, number, quote bar): its nearer edge (the native hit inside a
    // non-editable token depends on where its glyph sits in it, and on the y within the line). A todo's box
    // goes to the text start, as the native hit does.
    const tok = document.elementFromPoint(cx, cy)?.closest<HTMLElement>(".tok:not(.tok-todo)");
    if (tok && this.host.root.contains(tok) && tok.dataset.f !== undefined && tok.dataset.t !== undefined) {
      const li = Array.prototype.indexOf.call(this.host.root.children, tok.parentElement);
      const line = this.host.doc.lines[li];
      const r = tok.getBoundingClientRect();
      if (line && r.width > 0) return line.from + Number(cx < (r.left + r.right) / 2 ? tok.dataset.f : tok.dataset.t);
    }
    const p = caretPointFromClient(cx, cy);
    if (!p) return undefined;
    return domToRaw(this.host.root, this.host.doc, p.node, p.offset) ?? undefined;
  }

  bounds(): [number, number] {
    const root = this.host.root;
    const r = root.getBoundingClientRect();
    return [Math.max(root.scrollWidth, r.width), Math.max(root.scrollHeight, r.height)];
  }

  /** null: no visual line in that direction (the engine goes to the document's start / end without probing). */
  adjacent_line_y(pos: number, dir: -1 | 1): number | null | undefined {
    if (!this.adjacentLines) return undefined;
    const { root, doc } = this.host;
    // the DOM doesn't show the engine's lines: let the engine probe
    if (doc.lines.length !== root.children.length) return undefined;
    const [, oy] = this.origin();
    const cur = caretRect(root, doc, pos);
    const curMid = (cur.top + cur.bottom) / 2;
    const n = doc.lines.length;
    for (let i = lineAt(doc.lines, pos); i >= 0 && i < n; i += dir) {
      if (isFoldHidden(root.children[i]!)) continue;
      const bands = lineBands(root.children[i] as HTMLElement);
      if (dir < 0) bands.reverse();
      for (const b of bands) {
        const mid = (b.top + b.bottom) / 2;
        if (dir < 0 ? b.bottom <= cur.top + 2 && mid < curMid : b.top >= cur.bottom - 2 && mid > curMid) return mid - oy;
      }
    }
    return null;
  }

  table_cell_at(line: number, x: number, _y: number): number | undefined {
    const div = this.host.root.children[line];
    if (!div) return undefined;
    const cells = Array.from(div.children).filter((c) => c.classList.contains("tcell") && !c.classList.contains("tph"));
    if (!cells.length) return undefined;
    const [ox] = this.origin();
    const cx = x + ox;
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i]!.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right) return i;
    }
    if (cx <= cells[0]!.getBoundingClientRect().left) return 0;
    if (cx >= cells[cells.length - 1]!.getBoundingClientRect().right) return cells.length - 1;
    return undefined;
  }

  line_mid_y(line: number): number | undefined {
    const div = this.host.root.children[line];
    if (!div || isFoldHidden(div)) return undefined;
    const r = div.getBoundingClientRect();
    return (r.top + r.bottom) / 2 - this.origin()[1];
  }

  image_at(x: number, y: number): [number, number] | undefined {
    const { root, doc } = this.host;
    const [ox, oy] = this.origin();
    const cx = x + ox;
    const cy = y + oy;
    const li = lineAtY(root, cy);
    if (li < 0) return undefined;
    const div = root.children[li]!;
    const imgs = div.querySelector(":scope > .imgs");
    const line = doc.lines[li];
    if (!imgs || !line) return undefined;
    const ir = imgs.getBoundingClientRect();
    if (cy < ir.top || cy > ir.bottom) return undefined;
    // rows of images; a point in a row's band is on the nearest image of that row
    const rows: { band: Band; boxes: { el: HTMLElement; r: Box }[] }[] = [];
    for (const el of imgs.querySelectorAll<HTMLElement>(".imgbox")) {
      const r = imageBox(el, ir);
      const row = rows.find((w) => Math.abs(w.boxes[0]!.r.top - r.top) < 1);
      if (row) {
        row.band.bottom = Math.max(row.band.bottom, r.bottom);
        row.boxes.push({ el, r });
      } else rows.push({ band: { top: r.top, bottom: r.bottom }, boxes: [{ el, r }] });
    }
    const row = rows.find((w) => cy >= w.band.top && cy <= w.band.bottom);
    if (!row) return undefined;
    let best = row.boxes[0]!;
    let bestD = Infinity;
    for (const b of row.boxes) {
      const d = cx < b.r.left ? b.r.left - cx : cx > b.r.right ? cx - b.r.right : 0;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return [line.from + Number(best.el.dataset.from), line.from + Number(best.el.dataset.at)];
  }
}

/**
 * An image's box (client coordinates). One that hasn't loaded yet (no size: zero height) stands for the band of
 * its `.imgs` row container, so it can still be clicked and reached with Up/Down.
 */
function imageBox(el: HTMLElement, imgs: DOMRect): Box {
  const r = el.getBoundingClientRect();
  return r.height > 0 ? r : { top: imgs.top, bottom: imgs.bottom, left: r.left, right: r.right };
}

/** A line hidden inside a folded section (display: none: no box). */
export function isFoldHidden(div: Element): boolean {
  return div.classList.contains("fold-hidden");
}

/** Index of the (shown) line div whose box contains client y (the nearest one above it otherwise), or -1. */
export function lineAtY(root: HTMLElement, y: number): number {
  const kids = root.children;
  let lo = 0;
  let hi = kids.length - 1;
  if (hi < 0) return -1;
  // a hidden line has no box: it stands for the shown line before it (its folded heading)
  const shown = (i: number) => {
    while (i > 0 && isFoldHidden(kids[i]!)) i--;
    return i;
  };
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (kids[shown(mid)]!.getBoundingClientRect().top <= y) lo = mid;
    else hi = mid - 1;
  }
  return shown(lo);
}

/**
 * Visual lines of a line div (client coordinates), top to bottom: its text's line boxes, or its first line box
 * when it has no text. Images below a line's text aren't caret stops, except the rows of a collapsed image-only line.
 */
export function lineBands(div: HTMLElement): Band[] {
  const bands: Band[] = [];
  const add = (r: { top: number; bottom: number }) => {
    if (r.bottom - r.top <= 1) return;
    const b = bands.find((x) => r.top < x.bottom - 1 && r.bottom > x.top + 1);
    if (b) {
      b.top = Math.min(b.top, r.top);
      b.bottom = Math.max(b.bottom, r.bottom);
    } else bands.push({ top: r.top, bottom: r.bottom });
  };
  if (div.classList.contains("ln-img") && !div.classList.contains("img-rv")) {
    const imgs = div.querySelector(":scope > .imgs");
    const ir = imgs?.getBoundingClientRect();
    for (const box of div.querySelectorAll<HTMLElement>(".imgbox")) add(ir ? imageBox(box, ir) : box.getBoundingClientRect());
  } else {
    const range = document.createRange();
    for (const child of div.querySelectorAll(":scope > *:not(.imgs):not(br), :scope > .tcell > *")) {
      if (child.classList.contains("tcell")) continue;
      range.selectNodeContents(child);
      for (const r of range.getClientRects()) add(r);
      if (child.classList.contains("tok")) add(child.getBoundingClientRect());
    }
  }
  if (!bands.length) {
    const dr = div.getBoundingClientRect();
    const cs = getComputedStyle(div);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
    const top = dr.top + (parseFloat(cs.paddingTop) || 0);
    const bottom = Math.min(top + lh, dr.bottom);
    if (bottom > top) bands.push({ top, bottom });
    else if (dr.bottom > dr.top) bands.push({ top: dr.top, bottom: dr.bottom });
  }
  return bands.sort((a, b) => a.top - b.top);
}

export function scrollParent(wrapper: HTMLElement): HTMLElement | null {
  for (let el = wrapper.parentElement; el && el !== document.body; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") return el;
  }
  return null;
}

export function visibleBounds(wrapper: HTMLElement): [number, number] {
  const sp = scrollParent(wrapper);
  let top = 0;
  let bottom = window.innerHeight;
  if (sp) {
    const r = sp.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return [top, bottom];
}

export function scrollBy(wrapper: HTMLElement, dy: number): void {
  const sp = scrollParent(wrapper);
  if (sp) sp.scrollTop += dy;
  else window.scrollBy(0, dy);
}

export function scrollToEdge(wrapper: HTMLElement, dir: -1 | 1): void {
  const sp = scrollParent(wrapper);
  const el = sp ?? document.scrollingElement;
  if (el) el.scrollTop = dir < 0 ? 0 : el.scrollHeight;
}

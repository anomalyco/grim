// JsLayout (contract 3) answered from the rendered DOM. Content coordinates: CSS px from the top-left of the
// editor root's border box (x offset by OX), scroll included, so they don't change when the page, the root or a
// table / code block scrolls.

import { domToRaw, lineAt, type DomPos, type OffsetDoc } from "./offsets.ts";
import { caretPointFromClient, caretRect } from "./geometry.ts";
import type { JsLayout } from "./types.ts";
import { blockClip, isBlock, lineDivOf, lineDivs, lineIndexOf } from "./blocks.ts";

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

/**
 * Content x starts this far left of the editor root: tables and code blocks reach into the margins and scroll sideways
 * (blocks.ts), so their content can be left of the root (or far right of it), and the engine keeps x within
 * [0, bounds' width]. Inside such a block, x is as if it weren't scrolled (its scrollLeft added back), so a goal x
 * stays on its column while the block scrolls to follow the caret.
 */
const OX = 100_000;

export class DomLayout implements JsLayout {
  /** Answer adjacent_line_y from line boxes (false: let the engine probe with hit_test). */
  adjacentLines = true;

  constructor(private host: LayoutHost) {}

  /** Client position of the content origin. */
  origin(): [number, number] {
    const root = this.host.root;
    const r = root.getBoundingClientRect();
    return [r.left - root.scrollLeft - OX, r.top - root.scrollTop];
  }

  /** How far line `li`'s block (if it's in one) is scrolled sideways. */
  private scrolled(li: number): number {
    const p = li >= 0 ? lineDivs(this.host.root)[li]?.parentElement : null;
    return p && isBlock(this.host.root, p) ? p.scrollLeft : 0;
  }

  /** The same for the line at client y. */
  private scrolledAt(cy: number): number {
    return this.scrolled(lineAtY(this.host.root, cy));
  }

  fromClient(x: number, y: number): [number, number] {
    const [ox, oy] = this.origin();
    return [x - ox + this.scrolledAt(y), y - oy];
  }

  caret_rect(pos: number): [number, number, number, number] {
    const [ox, oy] = this.origin();
    const r = caretRect(this.host.root, this.host.doc, pos);
    return [r.left - ox + this.scrolled(lineAt(this.host.doc.lines, pos)), r.top - oy, 0, Math.max(0, r.bottom - r.top)];
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
    const root = this.host.root;
    let cx = x + ox;
    // only tables and code blocks reach past the editor's sides (blocks.ts); elsewhere (an x from a block, going
    // Up/Down out of it) the point is brought inside the editor. In a block, a point scrolled out of its view (or
    // off the window) can't be hit natively: the nearest character on that row, from the characters' boxes.
    const li = lineAtY(root, cy);
    const div = li >= 0 ? (lineDivs(root)[li] as HTMLElement) : null;
    const clip = blockClip(root, div);
    cx -= this.scrolled(li);
    if (clip && div && (cx < Math.max(clip[0], 0) + 1 || cx > Math.min(clip[1], window.innerWidth) - 2)) {
      const p = nearestChar(div, cx, cy);
      if (p) return domToRaw(root, this.host.doc, p.node, p.offset) ?? undefined;
    }
    if (!clip) {
      const rr = root.getBoundingClientRect();
      cx = Math.max(rr.left + 1, Math.min(rr.right - 2, cx));
    }
    cx = Math.max(0, Math.min(window.innerWidth - 1, cx));
    // on a line-prefix token (indent, bullet, number, quote bar): its nearer edge (the native hit inside a
    // non-editable token depends on where its glyph sits in it, and on the y within the line). A todo's box
    // goes to the text start, as the native hit does.
    const tok = document.elementFromPoint(cx, cy)?.closest<HTMLElement>(".tok:not(.tok-todo)");
    if (tok && this.host.root.contains(tok) && tok.dataset.f !== undefined && tok.dataset.t !== undefined) {
      const li = lineIndexOf(this.host.root, lineDivOf(this.host.root, tok));
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
    return [2 * OX + Math.max(root.scrollWidth, r.width), Math.max(root.scrollHeight, r.height)];
  }

  /** null: no visual line in that direction (the engine goes to the document's start / end without probing). */
  adjacent_line_y(pos: number, dir: -1 | 1): number | null | undefined {
    if (!this.adjacentLines) return undefined;
    const { root, doc } = this.host;
    // the DOM doesn't show the engine's lines: let the engine probe
    const kids = lineDivs(root);
    if (doc.lines.length !== kids.length) return undefined;
    const [, oy] = this.origin();
    const cur = caretRect(root, doc, pos);
    const curMid = (cur.top + cur.bottom) / 2;
    const n = doc.lines.length;
    for (let i = lineAt(doc.lines, pos); i >= 0 && i < n; i += dir) {
      if (isFoldHidden(kids[i]!)) continue;
      const bands = lineBands(kids[i] as HTMLElement);
      if (dir < 0) bands.reverse();
      for (const b of bands) {
        const mid = (b.top + b.bottom) / 2;
        if (dir < 0 ? b.bottom <= cur.top + 2 && mid < curMid : b.top >= cur.bottom - 2 && mid > curMid) return mid - oy;
      }
    }
    return null;
  }

  table_cell_at(line: number, x: number, _y: number): number | undefined {
    const div = lineDivs(this.host.root)[line];
    if (!div) return undefined;
    const cells = Array.from(div.children).filter((c) => c.classList.contains("tcell") && !c.classList.contains("tph"));
    if (!cells.length) return undefined;
    const [ox] = this.origin();
    const cx = x + ox - this.scrolled(line);
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i]!.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right) return i;
    }
    if (cx <= cells[0]!.getBoundingClientRect().left) return 0;
    if (cx >= cells[cells.length - 1]!.getBoundingClientRect().right) return cells.length - 1;
    return undefined;
  }

  line_mid_y(line: number): number | undefined {
    const div = lineDivs(this.host.root)[line];
    if (!div || isFoldHidden(div)) return undefined;
    const r = div.getBoundingClientRect();
    return (r.top + r.bottom) / 2 - this.origin()[1];
  }

  image_at(x: number, y: number): [number, number] | undefined {
    const { root, doc } = this.host;
    const [ox, oy] = this.origin();
    const cx = x + ox - this.scrolledAt(y + oy);
    const cy = y + oy;
    const li = lineAtY(root, cy);
    if (li < 0) return undefined;
    const div = lineDivs(root)[li]!;
    const line = doc.lines[li];
    // the image block under y (a split line has several)
    const imgs = Array.from(div.querySelectorAll(":scope > .imgs")).find((b) => {
      const r = b.getBoundingClientRect();
      return cy >= r.top && cy <= r.bottom;
    });
    if (!imgs || !line) return undefined;
    const ir = imgs.getBoundingClientRect();
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

/**
 * The caret position nearest client x on the visual row at client y of line div `div`, from its characters' boxes (they
 * have them where they're scrolled out of view too); null if no character is on that row.
 */
function nearestChar(div: HTMLElement, x: number, y: number): DomPos | null {
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let best: DomPos | null = null;
  let bestD = Infinity;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (n.parentElement?.closest(".imgs")) continue;
    for (let i = 0; i < n.length; i++) {
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      const r = range.getClientRects()[0];
      if (!r || r.width <= 0 || r.height <= 1 || y < r.top - 0.5 || y > r.bottom + 0.5) continue;
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (d < bestD) {
        bestD = d;
        best = { node: n, offset: x < (r.left + r.right) / 2 ? i : i + 1 };
      }
    }
  }
  return best;
}

/** A line hidden inside a folded section (display: none: no box). */
export function isFoldHidden(div: Element): boolean {
  return div.classList.contains("fold-hidden");
}

/** Index of the (shown) line div whose box contains client y (the nearest one above it otherwise), or -1. */
export function lineAtY(root: HTMLElement, y: number): number {
  const kids = lineDivs(root);
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

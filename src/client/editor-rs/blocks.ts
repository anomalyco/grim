// Wide blocks: the lines of a table, or of a fenced code block, sit together in a wrapper (.mde-blk) that may grow
// into the margins and scrolls horizontally inside itself (editor.css), so nothing ever widens the page. Line divs
// are the root's children, or the children of such a wrapper; either way they're in document order, the same order
// as doc.lines, and `lineDivs` lists them.

import type { RLine } from "./lineview.ts";

export const BLOCK = "mde-blk";

/** Kept free between a wide block and the editor pane's edges (px). */
export const SIDE_GAP = 24;

type Kind = "table" | "code";

interface BlockEl extends HTMLDivElement {
  _blk?: Kind;
}

/** The line divs of an editor root, in document order (live). */
export function lineDivs(root: HTMLElement): HTMLCollectionOf<Element> {
  return root.getElementsByClassName("ln");
}

/** Whether `el` is one of `root`'s block wrappers. */
export function isBlock(root: HTMLElement, el: Node | null): el is HTMLElement {
  return !!el && el.parentNode === root && (el as BlockEl)._blk !== undefined;
}

/** Whether `el` is a line div of `root` (its child, or a block wrapper's). */
export function isLineDiv(root: HTMLElement, el: Node | null): el is HTMLElement {
  if (!el || el.nodeType !== 1 || !(el as Element).classList.contains("ln")) return false;
  const p = el.parentNode;
  return p === root || isBlock(root, p);
}

/** The line div holding `node` (null outside the lines). */
export function lineDivOf(root: HTMLElement, node: Node | null): HTMLElement | null {
  for (let n = node; n && n !== root; n = n.parentNode) if (isLineDiv(root, n)) return n;
  return null;
}

/** Index of line div `el` (-1 if it isn't one). */
export function lineIndexOf(root: HTMLElement, el: Element | null): number {
  return el ? Array.prototype.indexOf.call(lineDivs(root), el) : -1;
}

/** The line div after `el` in document order. */
function nextLine(root: HTMLElement, el: Element): Element | null {
  const step = (n: Element | null): Element | null => (n && isBlock(root, n) ? n.firstElementChild : n);
  const n = el.nextElementSibling;
  if (n) return step(n);
  return el.parentNode !== root ? step((el.parentNode as Element).nextElementSibling) : null;
}

function firstLine(root: HTMLElement): Element | null {
  const n = root.firstElementChild;
  return n && isBlock(root, n) ? n.firstElementChild : n;
}

/**
 * Put `div` right after line div `prev` in document order (first, without `prev`), unless it's there already.
 * It may land inside a block it doesn't belong to: `groupBlocks` sorts that out.
 */
export function placeAfter(root: HTMLElement, div: Element, prev: Element | null): void {
  if ((prev ? nextLine(root, prev) : firstLine(root)) === div) return;
  if (prev) prev.parentNode!.insertBefore(div, prev.nextSibling);
  else root.insertBefore(div, root.firstChild);
}

/** The kind of block line `l` belongs to, if any. */
function kindOf(l: RLine): Kind | null {
  return l.table ? "table" : l.code ? "code" : null;
}

/** Whether line `l` (after `prev`) is in the same block as `prev` (a new table or code block starts a new one). */
function continues(l: RLine, prev: RLine, kind: Kind): boolean {
  if (kindOf(l) !== kind) return false;
  return kind === "table" ? l.type !== "table-head" : !prev.code?.last;
}

/**
 * Wrap each table's and each code block's line divs in a block, and leave every other line div at the top level,
 * moving only what isn't in place (a block keeps its element, so its horizontal scroll survives edits). `divs` are the
 * line divs in document order, one per line.
 */
export function groupBlocks(root: HTMLElement, lines: readonly RLine[], divs: readonly Element[]): void {
  const used = new Set<Element>();
  let prevTop: Node | null = null;
  const placeTop = (n: Node) => {
    const want = prevTop ? prevTop.nextSibling : root.firstChild;
    if (n !== want) root.insertBefore(n, want);
    prevTop = n;
  };
  for (let i = 0; i < lines.length; ) {
    const kind = kindOf(lines[i]!);
    if (!kind) {
      placeTop(divs[i]!);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && continues(lines[j]!, lines[j - 1]!, kind)) j++;
    const p = divs[i]!.parentNode as BlockEl;
    let blk: BlockEl;
    if (isBlock(root, p) && p._blk === kind && !used.has(p)) blk = p;
    else {
      blk = document.createElement("div") as BlockEl;
      blk._blk = kind;
      blk.className = `${BLOCK} ${BLOCK}-${kind}`;
      if (kind === "table") blk.setAttribute("role", "table");
    }
    used.add(blk);
    placeTop(blk);
    let prev: Node | null = null;
    for (let k = i; k < j; k++) {
      const d = divs[k]!;
      const want: Node | null = prev ? prev.nextSibling : blk.firstChild;
      if (d !== want) blk.insertBefore(d, want);
      prev = d;
    }
    i = j;
  }
  // blocks emptied by the moves
  for (const b of Array.from(root.children)) if (isBlock(root, b) && !b.firstChild) b.remove();
}

/** Remove what isn't `keep` from inside the blocks (stray nodes the browser added), and blocks left empty. */
export function dropStrays(root: HTMLElement, keep: (n: Node) => boolean): void {
  for (const b of Array.from(root.children)) {
    if (!isBlock(root, b)) continue;
    for (const n of Array.from(b.childNodes)) if (!keep(n)) n.remove();
    if (!b.firstChild) b.remove();
  }
}

/**
 * The widest a block may be in this editor: twice the room from the text column's centre to the nearer edge of the
 * pane, less the side gaps (never less than the text column: then blocks just keep to it).
 */
export function blockRoom(root: HTMLElement, pane: HTMLElement): number {
  const r = root.getBoundingClientRect();
  const cs = getComputedStyle(root);
  const left = r.left + (parseFloat(cs.paddingLeft) || 0);
  const right = r.right - (parseFloat(cs.paddingRight) || 0);
  const p = pane.getBoundingClientRect();
  const mid = (left + right) / 2;
  return Math.max(right - left, Math.floor(2 * Math.min(mid - p.left, p.left + pane.clientWidth - mid) - 2 * SIDE_GAP));
}

/** The visible horizontal range (client x) of the block holding line div `div`, if it's in one. */
export function blockClip(root: HTMLElement, div: Element | null): [number, number] | null {
  const b = div?.parentNode;
  if (!b || !isBlock(root, b)) return null;
  const r = b.getBoundingClientRect();
  return [r.left, r.left + b.clientWidth];
}

/** Scroll the block holding line div `div` so client x range [l, r] (a caret) is in view. */
export function scrollBlockTo(root: HTMLElement, div: Element | null, l: number, r: number): void {
  const b = div?.parentNode as HTMLElement | null;
  if (!b || !isBlock(root, b) || b.scrollWidth <= b.clientWidth) return;
  const box = b.getBoundingClientRect();
  const m = 24;
  const vl = box.left;
  const vr = box.left + b.clientWidth;
  if (l < vl + m) b.scrollLeft -= vl + m - l;
  else if (r > vr - m) b.scrollLeft += r - (vr - m);
}

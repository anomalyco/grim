// DOM <-> raw offset mapping. Line divs are the root's children, in the same order as doc.lines.
// Segment spans (data-f/data-t) are children of the line div, or of a cell wrapper on table lines.
// A line's images (.imgs, last child of the line div) hold no raw text: a position in them maps to the end
// of the image's source. A line split at its images (render.ts) has its segments in .part blocks (data-pf/data-pt:
// the part's line-relative range) with the .imgs blocks between them.

/** Index of the line containing `pos` (a position at a line's end belongs to that line). */
export function lineAt(lines: readonly { from: number }[], pos: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid]!.from <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** What the mapping needs of a document: the text's length and absolute line spans (from the engine's line views). */
export interface OffsetDoc {
  text: { length: number };
  lines: readonly { from: number; to: number }[];
}

export interface DomPos {
  node: Node;
  offset: number;
}

function isAtomic(el: Element): boolean {
  return el.classList.contains("tok") || el.classList.contains("chip");
}

function isVisibleText(el: Element): boolean {
  if (el.classList.contains("t")) return !el.classList.contains("ws");
  if (el.classList.contains("mk")) {
    if (el.classList.contains("esc")) return false;
    if (el.classList.contains("fence") || el.classList.contains("tbl")) return !!el.closest(".ln")?.classList.contains("rv");
    return el.classList.contains("rv");
  }
  return false;
}

function segRange(el: Element): [number, number] | null {
  const f = (el as HTMLElement).dataset?.f;
  if (f === undefined) return null;
  return [Number(f), Number((el as HTMLElement).dataset.t)];
}

export function rawToDom(root: HTMLElement, doc: OffsetDoc, pos: number): DomPos {
  pos = Math.max(0, Math.min(doc.text.length, pos));
  const li = lineAt(doc.lines, pos);
  const line = doc.lines[li]!;
  const div = root.children[li] as HTMLElement | undefined;
  if (!div) return { node: root, offset: Math.min(li, root.childNodes.length) };
  const rel = pos - line.from;
  const kids = segmentsOf(div);
  let atEnd: DomPos | null = null;
  let atStart: DomPos | null = null;
  let hidden: DomPos | null = null;
  for (const el of kids) {
    const r = segRange(el);
    if (!r || isAtomic(el)) continue;
    const [f, t] = r;
    if (rel < f || rel > t) continue;
    const tn = el.firstChild;
    if (!tn) continue;
    if (isVisibleText(el)) {
      if (rel > f && rel < t) return { node: tn, offset: rel - f };
      if (rel === t && !atEnd) atEnd = { node: tn, offset: t - f };
      if (rel === f && !atStart) atStart = { node: tn, offset: 0 };
    } else if (!hidden && rel > f && rel < t) {
      hidden = { node: tn, offset: rel - f };
    }
  }
  if (atEnd) return atEnd;
  if (atStart) return atStart;
  if (hidden) return hidden;
  // boundary next to atoms or an empty line: position between children of the line div (or a cell)
  if (div.querySelector(":scope > .tcell")) {
    for (const el of kids) {
      const r = segRange(el)!;
      if (r[0] >= rel) return { node: el.parentNode!, offset: Array.prototype.indexOf.call(el.parentNode!.childNodes, el) };
    }
    const lastSeg = kids[kids.length - 1];
    if (lastSeg) return { node: lastSeg.parentNode!, offset: lastSeg.parentNode!.childNodes.length };
  }
  // a split line: between the children of the (first) part holding the position
  const parts = div.querySelectorAll<HTMLElement>(":scope > .part");
  const box: Element =
    Array.from(parts).find((p) => Number(p.dataset.pf) <= rel && rel <= Number(p.dataset.pt)) ?? parts[parts.length - 1] ?? div;
  for (let i = 0; i < box.childNodes.length; i++) {
    const c = box.childNodes[i]!;
    if (c.nodeType !== 1) continue;
    const r = segRange(c as Element);
    if (!r) return { node: box, offset: i }; // <br>
    if (r[0] >= rel) return { node: box, offset: i };
  }
  return { node: box, offset: box.childNodes.length };
}

/** Map a DOM boundary to a raw offset; null if it's outside the editor. */
export function domToRaw(root: HTMLElement, doc: OffsetDoc, node: Node, offset: number): number | null {
  if (node === root) {
    if (offset >= doc.lines.length) return doc.text.length;
    return doc.lines[offset]!.from;
  }
  if (!root.contains(node)) return null;
  let div: Node = node;
  while (div.parentNode && div.parentNode !== root) div = div.parentNode;
  const li = Array.prototype.indexOf.call(root.children, div);
  const line = doc.lines[li];
  if (!line) return null;
  const len = line.to - line.from;
  const clamp = (r: number) => line.from + Math.max(0, Math.min(len, r));

  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const imgs = el?.closest(".imgs");
  if (imgs && div.contains(imgs)) {
    const box = el!.closest<HTMLElement>(".imgbox") ?? (imgs.children[Math.min(offset, imgs.children.length - 1)] as HTMLElement | undefined);
    return box?.dataset.at !== undefined ? clamp(Number(box.dataset.at)) : line.to;
  }
  if (node === div) {
    if (offset >= node.childNodes.length) return line.to;
    return clamp(startOf(node.childNodes[offset]!, len));
  }
  // find the segment element (nearest ancestor-or-self with a raw range)
  let seg: Node | null = node;
  while (seg && seg !== div && !(seg.nodeType === 1 && segRange(seg as Element))) seg = seg.parentNode;
  if (!seg || seg === div) {
    // a cell wrapper (or text part) boundary
    if (node.nodeType !== 1) return line.to;
    const pt = (node as HTMLElement).dataset?.pt;
    if (pt !== undefined && offset >= node.childNodes.length) return clamp(Number(pt));
    if (offset < node.childNodes.length) return clamp(startOf(node.childNodes[offset]!, len));
    const lastSeg = segmentsOf(node as Element).pop();
    return lastSeg ? clamp(segRange(lastSeg)![1]) : line.to;
  }
  const r = segRange(seg as Element)!;
  if (isAtomic(seg as Element)) {
    if (node === seg) return clamp(offset === 0 ? r[0] : r[1]);
    const textLen = (node.textContent ?? "").length;
    return clamp(offset * 2 < textLen ? r[0] : r[1]);
  }
  // the start of the whitespace starting a row after an image block: the row's start, after it
  if (offset === 0 && (seg as Element).classList.contains("ws")) return clamp(r[1]);
  if (node.nodeType === 3) return clamp(r[0] + Math.min(offset, r[1] - r[0]));
  return clamp(offset === 0 ? r[0] : r[1]);
}

function startOf(n: Node, len: number): number {
  // an image block between text parts: the position after it (the next part's start)
  const at = n.nodeType === 1 && (n as Element).classList.contains("imgs") ? (n as HTMLElement).dataset.at : undefined;
  if (at !== undefined) return Number(at);
  const pf = n.nodeType === 1 ? (n as HTMLElement).dataset.pf : undefined;
  if (pf !== undefined) return Number(pf);
  if (n.nodeType === 1 && !(n as Element).classList.contains("imgs")) {
    const r = segRange(n as Element);
    if (r) return r[0];
    const first = segmentsOf(n as Element)[0];
    const r2 = first && segRange(first);
    if (r2) return r2[0];
  }
  return len;
}

/** Segment elements of a line div in order, looking inside table cell wrappers. */
function segmentsOf(el: Element): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(el.children)) {
    if (c.classList.contains("tcell") || c.classList.contains("part")) out.push(...Array.from(c.children));
    else out.push(c);
  }
  return out;
}

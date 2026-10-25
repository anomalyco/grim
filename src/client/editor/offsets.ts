// DOM <-> raw offset mapping. Line divs are the root's children, in the same order as doc.lines.

import { type Doc, lineAt } from "./parser.ts";

export interface DomPos {
  node: Node;
  offset: number;
}

function isAtomic(el: Element): boolean {
  return el.classList.contains("tok") || el.classList.contains("chip");
}

function isVisibleText(el: Element): boolean {
  if (el.classList.contains("t")) return true;
  if (el.classList.contains("mk")) {
    if (el.classList.contains("esc")) return false;
    if (el.classList.contains("fence")) return !!el.parentElement?.classList.contains("rv");
    return el.classList.contains("rv");
  }
  return false;
}

function segRange(el: Element): [number, number] | null {
  const f = (el as HTMLElement).dataset?.f;
  if (f === undefined) return null;
  return [Number(f), Number((el as HTMLElement).dataset.t)];
}

export function rawToDom(root: HTMLElement, doc: Doc, pos: number): DomPos {
  pos = Math.max(0, Math.min(doc.text.length, pos));
  const li = lineAt(doc.lines, pos);
  const line = doc.lines[li]!;
  const div = root.children[li] as HTMLElement | undefined;
  if (!div) return { node: root, offset: Math.min(li, root.childNodes.length) };
  const rel = pos - line.from;
  const kids = Array.from(div.children);
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
  // boundary next to atoms or an empty line: position between children of the line div
  for (let i = 0; i < div.childNodes.length; i++) {
    const c = div.childNodes[i]!;
    if (c.nodeType !== 1) continue;
    const r = segRange(c as Element);
    if (!r) return { node: div, offset: i }; // <br>
    if (r[0] >= rel) return { node: div, offset: i };
  }
  return { node: div, offset: div.childNodes.length };
}

/** Map a DOM boundary to a raw offset; null if it's outside the editor. */
export function domToRaw(root: HTMLElement, doc: Doc, node: Node, offset: number): number | null {
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

  if (node === div) {
    if (offset >= node.childNodes.length) return line.to;
    return clamp(startOf(node.childNodes[offset]!, len));
  }
  // find the segment element (direct child of the line div)
  let seg: Node = node;
  while (seg.parentNode && seg.parentNode !== div) seg = seg.parentNode;
  const r = seg.nodeType === 1 ? segRange(seg as Element) : null;
  if (!r) return line.to;
  if (isAtomic(seg as Element)) {
    if (node === seg) return clamp(offset === 0 ? r[0] : r[1]);
    const textLen = (node.textContent ?? "").length;
    return clamp(offset * 2 < textLen ? r[0] : r[1]);
  }
  if (node.nodeType === 3) return clamp(r[0] + Math.min(offset, r[1] - r[0]));
  return clamp(offset === 0 ? r[0] : r[1]);
}

function startOf(n: Node, len: number): number {
  if (n.nodeType === 1) {
    const r = segRange(n as Element);
    if (r) return r[0];
  }
  return len;
}

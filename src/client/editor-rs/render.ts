// DOM for one engine line view: the same structure and classes as src/client/editor/render.ts (so editor.css,
// offsets.ts and the geometry helpers apply unchanged), built from an RLine instead of a parsed Line.

import {
  type ImagePool,
  addCellPlaceholders,
  renderChip,
  renderImages,
  renderTextSeg,
  renderToken,
} from "../editor/render.ts";
import { directImages, type ImageResolver } from "../editor/images.ts";
import type { RLine } from "./lineview.ts";

export interface RLineDiv extends HTMLDivElement {
  /** RLine.sig of the rendered line ("" forces a rebuild). */
  _sig?: string;
  /** Reveal state applied (see revealKey). */
  _rv?: string;
}

export interface RenderOptions {
  images?: ImageResolver;
  reuse?: ImagePool;
}

/** Render a line; `text` is its raw text. Reveal state is applied separately (applyLineReveal). */
export function renderRLine(line: RLine, text: string, opts: RenderOptions = {}): RLineDiv {
  const div = document.createElement("div") as RLineDiv;
  div._sig = line.sig;
  div._rv = "";
  const cls = ["ln", "ln-" + line.type];
  if (line.imageOnly) cls.push("ln-img");
  if (line.type === "heading") cls.push("h" + line.level);
  if (line.checked) cls.push("checked");
  if (line.code) {
    cls.push("in-code");
    if (line.code.first) cls.push("code-first");
    if (line.code.last) cls.push("code-last");
  }
  if (line.table) {
    cls.push("ln-table");
    div.setAttribute("role", "row");
    if (line.type === "table-delim") div.setAttribute("aria-hidden", "true");
  }
  div.className = cls.join(" ");
  if (line.gutterLevels) div.style.setProperty("--lv", String(line.gutterLevels));
  div.style.setProperty("--ind", String(line.indent));

  let lastIsText = false;
  const cells: HTMLElement[] = [];
  const table = line.table;
  const cellFor = (c: number): HTMLElement => {
    while (cells.length <= c) {
      const el = document.createElement("span");
      const i = cells.length;
      el.className = "tcell";
      el.setAttribute("role", line.type === "table-head" ? "columnheader" : "cell");
      const al = table!.align[i];
      if (al) el.style.textAlign = al;
      if (i >= table!.align.length) el.classList.add("textra");
      cells.push(el);
      div.appendChild(el);
    }
    return cells[c]!;
  };
  for (const s of line.segs) {
    const raw = text.slice(s.from, s.to);
    let node: HTMLElement;
    if (s.kind === "token") {
      node = renderToken(s.token!, line, raw);
      lastIsText = false;
    } else if (s.kind === "chip") {
      node = renderChip(raw, s.cls);
      lastIsText = false;
    } else {
      node = renderTextSeg(s.kind, s.cls, raw, s.el);
      lastIsText = true;
    }
    node.dataset.f = String(s.from);
    node.dataset.t = String(s.to);
    (s.cell !== undefined && table ? cellFor(s.cell) : div).appendChild(node);
  }
  if (table) {
    addCellPlaceholders(div, cells.length, table.align.length);
    return div;
  }
  if (!lastIsText) div.appendChild(document.createElement("br"));
  if (line.images.length) div.appendChild(renderImages(line.images, opts.images ?? directImages, opts.reuse));
  return div;
}

function revealKey(line: RLine): string {
  const els = new Set<number>();
  for (const s of line.segs) if (s.kind === "mk" && !s.hidden && s.el !== undefined) els.add(s.el);
  const img = line.imageOnly && line.images.some((i) => i.revealed);
  return `${line.active ? 1 : 0}${line.revealed ? 1 : 0}${img ? 1 : 0}:${[...els].join(",")}`;
}

/** Apply a line's reveal state to its div (like render.ts applyReveal). */
export function applyLineReveal(div: RLineDiv, line: RLine): void {
  // fold state: the gutter chevron (.fold-able), the "…" pill (.folded), hidden section lines (.fold-hidden)
  div.classList.toggle("fold-able", line.foldable);
  div.classList.toggle("folded", line.folded);
  div.classList.toggle("fold-hidden", line.hidden);
  const key = revealKey(line);
  if (div._rv === key) return;
  div._rv = key;
  div.classList.toggle("active", line.active);
  div.classList.toggle("rv", line.revealed);
  if (div.classList.contains("ln-table")) {
    const hide = (el: Element) => (line.revealed ? el.removeAttribute("aria-hidden") : el.setAttribute("aria-hidden", "true"));
    if (div.classList.contains("ln-table-delim")) hide(div);
    for (const m of div.querySelectorAll(".mk.tbl")) hide(m);
  }
  const shown = new Set<number>();
  for (const s of line.segs) if (s.kind === "mk" && !s.hidden && s.el !== undefined) shown.add(s.el);
  let img = false;
  for (const mk of div.querySelectorAll<HTMLElement>(".mk[data-e]")) {
    const on = shown.has(Number(mk.dataset.e));
    mk.classList.toggle("rv", on);
    if (on && mk.classList.contains("img")) img = true;
  }
  if (div.classList.contains("ln-img")) div.classList.toggle("img-rv", img || line.images.some((i) => i.revealed));
}

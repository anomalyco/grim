// Renderer: one <div class="ln"> per source line. Segment spans carry line-relative raw ranges in
// data-f / data-t. Inline markers are always in the DOM (collapsed by CSS unless revealed); block prefix
// tokens and link URLs are contenteditable=false atoms that hold no raw text.

import { type Line, type TokenKind, trimRange } from "./parser.ts";
import { type LineReveal, revealKey } from "./reveal.ts";

export type SegKind = "token" | "text" | "mk" | "esc" | "chip" | "fence" | "pipe" | "pad" | "delim";

export interface Seg {
  kind: SegKind;
  /** Absolute raw range. */
  from: number;
  to: number;
  cls: string[];
  /** For "mk": indices of the elements this marker belongs to. */
  el?: number;
  token?: TokenKind;
  /** Table lines: index of the cell this segment is drawn in. */
  cell?: number;
}

const CLS: Record<string, string> = {
  bold: "b",
  italic: "i",
  strike: "s",
  underline: "u",
  highlight: "hl",
  code: "code",
  link: "link",
  tag: "tag",
};

const PENCIL =
  '<svg viewBox="0 0 16 16" width="0.85em" height="0.85em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/></svg>';

/** Pure render plan for a line. */
export function lineSegments(line: Line): Seg[] {
  const segs: Seg[] = [];
  for (const t of line.tokens) segs.push({ kind: "token", from: t.from, to: t.to, cls: [], token: t.kind });
  if (line.type === "code") {
    if (line.to > line.from) segs.push({ kind: "text", from: line.from, to: line.to, cls: [] });
    return segs;
  }
  if (line.type === "fence") {
    if (line.to > line.from) segs.push({ kind: "fence", from: line.from, to: line.to, cls: [] });
    return segs;
  }
  if (line.type === "hr") return segs;
  if (line.table) return tableSegments(line);
  inlineSegments(line, line.textFrom, line.to, segs);
  return segs;
}

/** Inline segments of [a, b) (text, markers, escapes, link chips). */
function inlineSegments(line: Line, a: number, b: number, segs: Seg[], cell?: number): void {
  if (a >= b) return;
  const cuts = new Set<number>([a, b]);
  for (const el of line.inline) {
    cuts.add(el.from);
    cuts.add(el.to);
    for (const m of el.markers) {
      cuts.add(m[0]);
      cuts.add(m[1]);
    }
    if (el.url) {
      cuts.add(el.url[0]);
      cuts.add(el.url[1]);
    }
  }
  for (const e of line.escapes) {
    cuts.add(e);
    cuts.add(e + 1);
  }
  const points = [...cuts].filter((p) => p >= a && p <= b).sort((x, y) => x - y);
  for (let i = 0; i + 1 < points.length; i++) {
    const f = points[i]!;
    const t = points[i + 1]!;
    const cls: string[] = [];
    let kind = "text" as SegKind;
    let el: number | undefined;
    for (let k = 0; k < line.inline.length; k++) {
      const e = line.inline[k]!;
      if (e.from <= f && t <= e.to) {
        cls.push(CLS[e.type]!);
        if (e.markers.some((m) => m[0] <= f && t <= m[1])) {
          kind = "mk";
          el = k;
        }
        if (e.url && e.url[0] <= f && t <= e.url[1]) kind = "chip";
      }
    }
    if (line.escapes.includes(f) && t === f + 1) kind = "esc";
    const prev = segs[segs.length - 1];
    if (kind === "chip" && prev && prev.kind === "chip" && prev.to === f) {
      prev.to = t;
      continue;
    }
    segs.push({ kind, from: f, to: t, cls, el, cell });
  }
}

/**
 * A table row: every cell gets the pipe before it, its padding spaces and its inline content; spaces
 * before a leading pipe go to the first cell and a trailing pipe (and spaces after it) to the last.
 * Pipes and padding are collapsed unless the table is revealed; the delimiter row is raw.
 */
function tableSegments(line: Line): Seg[] {
  const tb = line.table!;
  const segs: Seg[] = [];
  const raw = (from: number, to: number, cell: number) => {
    for (let p = from; p < to; ) {
      if (tb.pipes.includes(p)) {
        segs.push({ kind: "pipe", from: p, to: p + 1, cls: [], cell });
        p++;
        continue;
      }
      let q = p;
      while (q < to && !tb.pipes.includes(q)) q++;
      segs.push({ kind: "pad", from: p, to: q, cls: [], cell });
      p = q;
    }
  };
  let pos = line.from;
  const last = tb.cells.length - 1;
  tb.cells.forEach(([cf, ct], c) => {
    raw(pos, cf, c);
    if (line.type === "table-delim") {
      if (ct > cf) segs.push({ kind: "delim", from: cf, to: ct, cls: [], cell: c });
    } else {
      const [a, b] = cellText(line, cf, ct);
      if (a > cf) segs.push({ kind: "pad", from: cf, to: a, cls: [], cell: c });
      inlineSegments(line, a, b, segs, c);
      if (ct > b) segs.push({ kind: "pad", from: b, to: ct, cls: [], cell: c });
    }
    pos = ct;
  });
  raw(pos, line.to, last);
  return segs;
}

/** A cell's content range without its padding (spaces, tabs, carriage returns). */
function cellText(line: Line, cf: number, ct: number): [number, number] {
  const [a, b] = trimRange(line.text, cf - line.from, ct - line.from);
  return [a + line.from, b + line.from];
}

/** Key that changes whenever the line's DOM must be rebuilt. */
export function lineKey(line: Line): string {
  const edge = (line.blockStart === line.index ? "s" : "") + (line.blockEnd === line.index ? "e" : "");
  // inline elements can span the lines of a paragraph, so their ranges (relative to this line) are part of the key
  const rel = (p: number) => p - line.from;
  const inl = line.inline
    .map((e) => `${e.type}:${rel(e.from)}:${rel(e.to)}:${e.markers.map((m) => rel(m[0]) + "-" + rel(m[1])).join(",")}`)
    .join(";");
  const esc = line.escapes.map(rel).join(",");
  const tb = line.table;
  const table = tb
    ? `${tb.align.join(",")}:${tb.pipes.map(rel).join(",")}`
    : "";
  return `${table}|${line.type}|${line.level}|${line.checked ? 1 : 0}|${line.indent}|${edge}|${inl}|${esc}|${line.text}`;
}

export interface LineDiv extends HTMLDivElement {
  _key?: string;
  _rv?: string;
}

export function renderLine(line: Line, text: string): LineDiv {
  const div = document.createElement("div") as LineDiv;
  div._key = lineKey(line);
  div._rv = "";
  const cls = ["ln", "ln-" + line.type];
  if (line.type === "heading") cls.push("h" + line.level);
  if (line.checked) cls.push("checked");
  if (line.blockStart >= 0) {
    cls.push("in-code");
    if (line.index === line.blockStart) cls.push("code-first");
    if (line.index === line.blockEnd) cls.push("code-last");
  }
  if (line.table) {
    cls.push("ln-table");
    div.setAttribute("role", "row");
    // rendered collapsed (applyReveal toggles these)
    if (line.type === "table-delim") div.setAttribute("aria-hidden", "true");
  }
  div.className = cls.join(" ");
  const levels = line.indent + (line.tokens.some((t) => t.kind !== "indent" && t.kind !== "heading" && t.kind !== "hr") ? 1 : 0);
  if (levels) div.style.setProperty("--lv", String(levels));
  div.style.setProperty("--ind", String(line.indent));

  const segs = lineSegments(line);
  let lastIsText = false;
  // table lines: segments go into cell wrappers (display: table-cell)
  const cells: HTMLElement[] = [];
  const cellFor = (c: number): HTMLElement => {
    while (cells.length <= c) {
      const el = document.createElement("span");
      const i = cells.length;
      el.className = "tcell";
      el.setAttribute("role", line.type === "table-head" ? "columnheader" : "cell");
      const al = line.table!.align[i];
      if (al) el.style.textAlign = al;
      if (i >= line.table!.align.length) el.classList.add("textra");
      cells.push(el);
      div.appendChild(el);
    }
    return cells[c]!;
  };
  for (const s of segs) {
    const f = s.from - line.from;
    const t = s.to - line.from;
    let node: HTMLElement;
    if (s.kind === "token") {
      node = renderToken(s.token!, line, text.slice(s.from, s.to));
      lastIsText = false;
    } else if (s.kind === "chip") {
      node = document.createElement("span");
      node.className = "chip " + s.cls.join(" ");
      node.contentEditable = "false";
      node.dataset.href = text.slice(s.from, s.to);
      node.title = text.slice(s.from, s.to);
      node.innerHTML = PENCIL;
      lastIsText = false;
    } else {
      node = document.createElement("span");
      const base =
        s.kind === "text"
          ? "t"
          : s.kind === "esc"
            ? "mk esc"
            : s.kind === "fence"
              ? "mk fence"
              : s.kind === "pipe" || s.kind === "pad" || s.kind === "delim"
                ? "mk tbl t" + s.kind
                : "mk";
      node.className = s.cls.length ? base + " " + s.cls.join(" ") : base;
      if (s.kind === "mk") node.dataset.e = String(s.el);
      if (s.kind === "pipe" || s.kind === "pad" || s.kind === "delim") node.setAttribute("aria-hidden", "true");
      node.textContent = text.slice(s.from, s.to);
      lastIsText = true;
    }
    node.dataset.f = String(f);
    node.dataset.t = String(t);
    (s.cell !== undefined ? cellFor(s.cell) : div).appendChild(node);
  }
  if (line.table) {
    // rows with fewer cells than columns: empty boxes (no raw text) so borders and padding line up
    for (let i = cells.length; i < line.table.align.length; i++) {
      const ph = document.createElement("span");
      ph.className = "tcell tph";
      ph.contentEditable = "false";
      ph.setAttribute("aria-hidden", "true");
      div.appendChild(ph);
    }
    return div;
  }
  if (!lastIsText) div.appendChild(document.createElement("br"));
  return div;
}

function renderToken(kind: TokenKind, line: Line, raw: string): HTMLElement {
  const el = document.createElement("span");
  el.contentEditable = "false";
  el.className = "tok tok-" + kind;
  el.dataset.tok = kind;
  switch (kind) {
    case "bullet":
      el.textContent = "\u2022";
      break;
    case "todo": {
      const box = document.createElement("span");
      box.className = "cb" + (line.checked ? " on" : "");
      el.appendChild(box);
      break;
    }
    case "numbered":
      el.textContent = raw.trim();
      break;
    case "heading":
      el.textContent = "H" + line.level;
      break;
    default:
      break;
  }
  return el;
}

/** Apply reveal classes to a rendered line. */
export function applyReveal(div: LineDiv, r: LineReveal | undefined): void {
  const key = revealKey(r);
  if (div._rv === key) return;
  div._rv = key;
  div.classList.toggle("active", !!r?.active);
  div.classList.toggle("rv", !!r?.fence);
  if (div.classList.contains("ln-table")) {
    // collapsed pipes, padding and delimiter row are not read out
    const hide = (el: Element) => (r?.fence ? el.removeAttribute("aria-hidden") : el.setAttribute("aria-hidden", "true"));
    if (div.classList.contains("ln-table-delim")) hide(div);
    for (const m of div.querySelectorAll(".mk.tbl")) hide(m);
  }
  const set = new Set(r?.els ?? []);
  for (const mk of div.querySelectorAll<HTMLElement>(".mk[data-e]")) {
    mk.classList.toggle("rv", set.has(Number(mk.dataset.e)));
  }
}

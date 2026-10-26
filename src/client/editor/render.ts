// Renderer: one <div class="ln"> per source line. Segment spans carry line-relative raw ranges in
// data-f / data-t. Inline markers are always in the DOM (collapsed by CSS unless revealed); block prefix
// tokens and link URLs are contenteditable=false atoms that hold no raw text. Images are drawn in a
// contenteditable=false block (.imgs) after the line's segments; it holds no raw text either.

import { type InlineEl, type Line, type TokenKind, trimRange } from "./parser.ts";
import { type LineReveal, revealKey } from "./reveal.ts";
import { cleanSrc, directImages, type ImageResolver } from "./images.ts";

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
  image: "img",
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
        if (e.type === "image" && e.contentFrom <= f && t <= e.contentTo) cls.push("alt");
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

/**
 * A line whose whole text is images (optionally inside links), with nothing else: shown as just the images
 * while the caret is elsewhere. Every caret position on it touches an image, so it's revealed whenever the
 * caret is on it.
 */
export function isImageLine(line: Line): boolean {
  if (line.type !== "paragraph" || line.tokens.length || line.to <= line.from) return false;
  const imgs = line.inline.filter((e) => e.type === "image");
  if (!imgs.length) return false;
  const links = line.inline.filter((e) => e.type === "link" && imgs.some((m) => e.contentFrom <= m.from && m.to <= e.contentTo));
  // every inline element is one of those, on this line (not, say, bold that spans the paragraph's lines)
  if (line.inline.some((e) => e.from < line.from || e.to > line.to || (e.type !== "image" && !links.includes(e)))) return false;
  for (let p = line.from; p < line.to; ) {
    const img = imgs.find((m) => m.from === p);
    if (img) {
      p = img.to;
      continue;
    }
    const link = links.find((l) => l.markers.some((m) => m[0] <= p && p < m[1]) || (l.url && l.url[0] <= p && p < l.url[1]));
    if (!link) return false;
    p++;
  }
  return true;
}

export interface RenderOptions {
  /** Where images load from (default: only http(s) and data:image URLs). */
  images?: ImageResolver;
  /** <img> elements of the lines being replaced, by URL: reused (and taken out) so a re-render doesn't reload them. */
  reuse?: ImagePool;
}

export type ImagePool = Map<string, HTMLImageElement[]>;

/** Add the <img> elements of a line about to be replaced to `pool`. */
export function collectImages(div: Element, pool: ImagePool): void {
  for (const img of div.querySelectorAll<HTMLImageElement>(".imgbox img")) {
    const url = img.dataset.url!;
    const list = pool.get(url);
    if (list) list.push(img);
    else pool.set(url, [img]);
  }
}

export function renderLine(line: Line, text: string, opts: RenderOptions = {}): LineDiv {
  const div = document.createElement("div") as LineDiv;
  div._key = lineKey(line);
  div._rv = "";
  const cls = ["ln", "ln-" + line.type];
  if (isImageLine(line)) cls.push("ln-img");
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
      node.dataset.href = cleanSrc(text.slice(s.from, s.to));
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
  const imgs = line.inline.filter((e) => e.type === "image");
  if (imgs.length) div.appendChild(renderImages(line, imgs, text, opts.images ?? directImages, opts.reuse));
  return div;
}

/** Natural sizes of images that loaded (the most recent SIZES_KEPT), so a new <img> gets its height before it loads. */
const sizes = new Map<string, [number, number]>();
const SIZES_KEPT = 500;
/** Matches max-height of `.mde .imgbox img` in editor.css. */
const MAX_IMAGE_HEIGHT = 480;

const BROKEN =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2.5 11.5l3.5-3.5 2.5 2.5 1.5-1.5 3.5 3"/><circle cx="10.5" cy="6.5" r="1"/></svg>';

/**
 * The images of a line, below its text. A failed load swaps in a placeholder by toggling a class (attribute
 * changes don't trip the editor's MutationObserver; child changes would make it rebuild the line).
 */
function renderImages(line: Line, imgs: InlineEl[], text: string, resolve: ImageResolver, reuse: ImagePool | undefined): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "imgs";
  wrap.contentEditable = "false";
  for (const el of imgs) {
    const box = document.createElement("span");
    box.className = "imgbox";
    box.dataset.at = String(el.to - line.from);
    box.dataset.from = String(el.from - line.from);
    const alt = text.slice(el.contentFrom, el.contentTo);
    const src = el.src ? text.slice(el.src[0], el.src[1]) : "";
    const missing = document.createElement("span");
    missing.className = "img-missing";
    missing.innerHTML = BROKEN;
    missing.append(alt ? `Image not found: ${alt}` : "Image not found");
    const url = resolve(src);
    if (url) {
      const img = reuse?.get(url)?.shift() ?? newImage(url);
      img.alt = alt;
      if (el.title) img.title = el.title;
      else img.removeAttribute("title");
      if (img.dataset.state !== "ok") box.classList.add(img.dataset.state === "broken" ? "broken" : "loading");
      box.append(img);
    } else {
      box.classList.add("broken");
    }
    box.append(missing);
    wrap.append(box);
  }
  return wrap;
}

/** An <img> loading `url`; it marks the .imgbox it's in when it loads or fails (it may move to a re-rendered line). */
function newImage(url: string): HTMLImageElement {
  const img = document.createElement("img");
  img.dataset.url = url;
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.draggable = false;
  const size = sizes.get(url);
  if (size) {
    sizes.delete(url);
    sizes.set(url, size);
    // the size it will have once loaded (the aspect ratio comes from width/height)
    img.width = size[0];
    img.height = size[1];
    img.style.width = `min(100%, ${size[0]}px, ${(MAX_IMAGE_HEIGHT * size[0]) / size[1]}px)`;
  }
  img.addEventListener("load", () => {
    img.dataset.state = "ok";
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      sizes.delete(url);
      sizes.set(url, [img.naturalWidth, img.naturalHeight]);
      if (sizes.size > SIZES_KEPT) sizes.delete(sizes.keys().next().value!);
    }
    img.parentElement?.classList.remove("loading");
  });
  img.addEventListener("error", () => {
    img.dataset.state = "broken";
    sizes.delete(url);
    img.parentElement?.classList.remove("loading");
    img.parentElement?.classList.add("broken");
  });
  img.dataset.state = "loading";
  img.src = url;
  return img;
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
  let img = false;
  for (const mk of div.querySelectorAll<HTMLElement>(".mk[data-e]")) {
    const on = set.has(Number(mk.dataset.e));
    mk.classList.toggle("rv", on);
    if (on && mk.classList.contains("img")) img = true;
  }
  // an image-only line shows its source line (above the images) while an image on it is revealed
  if (div.classList.contains("ln-img")) div.classList.toggle("img-rv", img);
}

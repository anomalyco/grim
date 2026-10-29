// DOM for one engine line view: one <div class="ln"> per source line. Segment spans carry line-relative raw
// ranges in data-f / data-t. Inline markers are always in the DOM (collapsed by editor.css unless revealed); a link's
// URL is ordinary raw text collapsed with its markers (`.mk.url`). Block prefix tokens and a link's pencil (after its
// URL, so right after the link text while collapsed) are contenteditable=false atoms that hold no raw text. Images are drawn in
// contenteditable=false blocks (.imgs) that hold no raw text either: after the line's segments, or, on a line with
// text after an image (split: RLine.parts), each text part is a block (.part, data-pf/data-pt its line-relative range)
// with an .imgs block after the part holding the images' sources. offsets.ts maps between this DOM and raw offsets.

import { directImages, type ImageResolver } from "./images.ts";
import type { RLine, SegKind, TokenKind } from "./lineview.ts";
import { lineLinks } from "./links.ts";

const PENCIL =
  '<svg viewBox="0 0 16 16" width="0.85em" height="0.85em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/></svg>';

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


export interface RLineDiv extends HTMLDivElement {
  /** RLine.sig of the rendered line ("" forces a rebuild). */
  _sig?: string;
  /** Reveal state applied (see revealKey). */
  _rv?: string;
  /** CodeHl.sig of the highlighting drawn (undefined: none). */
  _hl?: string;
}

/**
 * Syntax highlighting of a code line (code.ts): a colour layer only. A text segment is drawn as several spans, split
 * at the runs' edges (each still a segment span with its raw range), so the text and the offset mapping don't change.
 */
export interface CodeHl {
  sig: string;
  /** Line class ("" for none). */
  cls: string;
  /** Styled runs [from, to, class], line-relative, in order, not overlapping. */
  runs: [number, number, string][];
}

export interface RenderOptions {
  images?: ImageResolver;
  reuse?: ImagePool;
  code?: CodeHl | null;
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
  if (opts.code) {
    div._hl = opts.code.sig;
    if (opts.code.cls) cls.push(opts.code.cls);
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
  // split at the images: a .part block per text part, the image blocks between them
  const split = !line.imageOnly && !table && line.parts.length > 2;
  let parent: HTMLElement = div;
  let pi = -1;
  const nextPart = (): void => {
    if (!lastIsText && parent !== div) parent.appendChild(document.createElement("br"));
    lastIsText = false;
    for (pi++; pi < line.parts.length; pi++) {
      const p = line.parts[pi]!;
      if (p.kind === "text") {
        parent = document.createElement("span");
        parent.className = "part";
        parent.dataset.pf = String(p.from);
        parent.dataset.pt = String(p.to);
        div.appendChild(parent);
        return;
      }
      const imgs = renderImages(line.images.slice(p.first, p.end), opts.images ?? directImages, opts.reuse);
      addImageLinkChips(imgs, line, text);
      // the raw position after the block (the next part's start)
      imgs.dataset.at = String(line.parts[pi - 1]?.kind === "text" ? (line.parts[pi - 1] as { to: number }).to : 0);
      div.appendChild(imgs);
    }
  };
  if (split) nextPart();
  // a link's URL (chip segments) waiting for its ")": the pencil goes before it
  let url: number | null = null;
  for (const s of line.segs) {
    if (split) {
      while (pi < line.parts.length - 1 && s.from >= (line.parts[pi] as { to: number }).to && s.to > s.from) nextPart();
    }
    const raw = text.slice(s.from, s.to);
    let node: HTMLElement;
    if (s.kind === "token") {
      node = renderToken(s.token!, line, raw);
      lastIsText = false;
    } else if (s.kind === "chip") {
      // the URL: raw text, collapsed with the link's markers (data-e: the link)
      node = renderTextSeg("mk", [...s.cls, "url"], raw, s.el);
      url ??= s.from;
      lastIsText = true;
    } else if (opts.code && s.kind === "text" && !s.hidden && s.to > s.from) {
      codeRuns(parent, s.from, s.to, s.cls, raw, opts.code.runs);
      lastIsText = true;
      continue;
    } else {
      if (url !== null && s.kind === "mk" && raw === ")") {
        // the URL's pencil (a linked image's `](` right before the URL: the image block has the pencil)
        const pencil = renderPencil(url, s.from, text.slice(0, url).endsWith(")]("));
        (s.cell !== undefined && table ? cellFor(s.cell) : parent).appendChild(pencil);
      }
      node = renderTextSeg(s.kind, s.cls, raw, s.el);
      // the whitespace starting a row after an image block: zero width, still caret stops
      if (s.kind === "text" && s.hidden) node.classList.add("ws");
      lastIsText = true;
    }
    if (s.kind !== "chip" && s.kind !== "esc") url = null;
    node.dataset.f = String(s.from);
    node.dataset.t = String(s.to);
    (s.cell !== undefined && table ? cellFor(s.cell) : parent).appendChild(node);
  }
  if (table) {
    addCellPlaceholders(div, cells.length, table.align.length);
    return div;
  }
  if (split) {
    // the rest (a part ending the line after its last image block has been opened by now)
    while (pi < line.parts.length - 1) nextPart();
    // (nextPart closed the last part when the line ends with an image block)
    if (pi < line.parts.length && !lastIsText) parent.appendChild(document.createElement("br"));
    return div;
  }
  if (!lastIsText) div.appendChild(document.createElement("br"));
  if (line.images.length) {
    const imgs = renderImages(line.images, opts.images ?? directImages, opts.reuse);
    addImageLinkChips(imgs, line, text);
    div.appendChild(imgs);
  }
  return div;
}

/**
 * Linked images (`[![alt](img)](url)`) in an image block: the link's pencil after them (the link's own chip is in
 * the line's text, which a collapsed image line doesn't show). data-link: the link's start, data-mid: its "](".
 */
function addImageLinkChips(imgs: HTMLElement, line: RLine, text: string): void {
  const boxes = [...imgs.querySelectorAll<HTMLElement>(".imgbox")];
  for (const l of lineLinks(line, text)) {
    const inside = boxes.filter((b) => l.textFrom <= Number(b.dataset.from) && Number(b.dataset.from) < l.textTo);
    if (!inside.length) continue;
    const chip = renderChip(["img-chip"]);
    chip.dataset.link = String(l.from);
    chip.dataset.mid = String(l.textTo);
    // (a position in it maps like one in its image: to the end of the image's source)
    chip.dataset.at = inside[inside.length - 1]!.dataset.at;
    imgs.appendChild(chip);
  }
}

/** Text segment [from, to) (`raw`) as spans split at the highlighting runs. */
function codeRuns(parent: HTMLElement, from: number, to: number, cls: string[], raw: string, runs: CodeHl["runs"]): void {
  let at = from;
  const piece = (end: number, c: string) => {
    const node = renderTextSeg("text", c ? [...cls, c] : cls, raw.slice(at - from, end - from));
    node.dataset.f = String(at);
    node.dataset.t = String(end);
    parent.appendChild(node);
    at = end;
  };
  for (const [f, t, c] of runs) {
    if (t <= at) continue;
    if (f >= to) break;
    if (f > at) piece(f, "");
    piece(Math.min(t, to), c);
  }
  if (at < to) piece(to, "");
}

function revealKey(line: RLine): string {
  const els = new Set<number>();
  for (const s of line.segs) if (s.kind === "mk" && !s.hidden && s.el !== undefined) els.add(s.el);
  const img = line.imageOnly && line.images.some((i) => i.revealed);
  const parts = line.parts.map((p) => (p.kind === "text" ? (p.shown ? 1 : 0) : "")).join("");
  return `${line.active ? 1 : 0}${line.revealed ? 1 : 0}${img ? 1 : 0}:${[...els].join(",")}:${parts}`;
}

/** Apply a line's reveal state to its div. */
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
  // a linked image's pencil: hidden while the link's source shows
  for (const chip of div.querySelectorAll<HTMLElement>(".img-chip")) {
    const mid = Number(chip.dataset.mid);
    chip.classList.toggle("rv", line.segs.some((s) => s.kind === "mk" && s.from === mid && !s.hidden));
  }
  // text parts with nothing visible take no row (.nil)
  const parts = div.querySelectorAll<HTMLElement>(":scope > .part");
  if (parts.length) {
    let k = 0;
    for (const p of line.parts) if (p.kind === "text") parts[k++]?.classList.toggle("nil", !p.shown);
  }
}

/**
 * A link's pencil (atomic, holds no raw text: data-f = data-t = the URL's end; data-u: the URL's start). Drawn while
 * the link is collapsed, right after its text; a click expands the link. `image`: the link wraps just an image (its
 * image block has the pencil, see addImageLinkChips).
 */
export function renderPencil(urlFrom: number, urlTo: number, image = false): HTMLElement {
  const node = document.createElement("span");
  node.className = image ? "chip img-link" : "chip";
  node.contentEditable = "false";
  node.dataset.u = String(urlFrom);
  node.dataset.f = String(urlTo);
  node.dataset.t = String(urlTo);
  node.title = "Edit link";
  node.innerHTML = PENCIL;
  return node;
}

/** A linked image's pencil (after its image block; holds no raw text). */
function renderChip(cls: string[]): HTMLElement {
  const node = document.createElement("span");
  node.className = "chip " + cls.join(" ");
  node.contentEditable = "false";
  node.title = "Edit link";
  node.innerHTML = PENCIL;
  return node;
}

/** A segment span holding raw text: visible text, or a marker/escape/fence/table syntax (collapsed by CSS unless revealed). */
export function renderTextSeg(kind: SegKind, cls: string[], raw: string, el?: number): HTMLElement {
  const node = document.createElement("span");
  const base =
    kind === "text"
      ? "t"
      : kind === "esc"
        ? "mk esc"
        : kind === "fence"
          ? "mk fence"
          : kind === "pipe" || kind === "pad" || kind === "delim"
            ? "mk tbl t" + kind
            : "mk";
  node.className = cls.length ? base + " " + cls.join(" ") : base;
  if (kind === "mk") node.dataset.e = String(el);
  if (kind === "pipe" || kind === "pad" || kind === "delim") node.setAttribute("aria-hidden", "true");
  node.textContent = raw;
  return node;
}

/** Rows with fewer cells than columns: empty boxes (no raw text) so borders and padding line up. */
export function addCellPlaceholders(div: HTMLElement, have: number, columns: number): void {
  for (let i = have; i < columns; i++) {
    const ph = document.createElement("span");
    ph.className = "tcell tph";
    ph.contentEditable = "false";
    ph.setAttribute("aria-hidden", "true");
    div.appendChild(ph);
  }
}

/**
 * Natural sizes of images that loaded (the most recent SIZES_KEPT), so a new <img> gets its height before it loads.
 * Kept in this browser too, so a note's images have their boxes on the next page load (nothing moves when they come).
 */
const sizes = new Map<string, [number, number]>();
const SIZES_KEPT = 500;
const SIZES_KEY = "grimoire.imageSizes.v1";
try {
  const stored = JSON.parse(localStorage.getItem(SIZES_KEY) ?? "[]") as unknown;
  if (Array.isArray(stored))
    for (const e of stored) if (Array.isArray(e) && typeof e[0] === "string" && e[1] > 0 && e[2] > 0) sizes.set(e[0], [e[1], e[2]]);
} catch {}
let sizesSaving = false;

/** Forget the remembered image sizes (signing out: they name the account's images). */
export function forgetImageSizes(): void {
  sizes.clear();
  try {
    localStorage.removeItem(SIZES_KEY);
  } catch {}
}

function saveSizes() {
  if (sizesSaving) return;
  sizesSaving = true;
  queueMicrotask(() => {
    sizesSaving = false;
    try {
      // (by path: the URL's origin is the page's)
      localStorage.setItem(SIZES_KEY, JSON.stringify([...sizes].slice(-SIZES_KEPT).map(([u, [w, h]]) => [u, w, h])));
    } catch {}
  });
}
/** Matches max-height of `.mde .imgbox img` in editor.css. */
const MAX_IMAGE_HEIGHT = 480;

const BROKEN =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2.5 11.5l3.5-3.5 2.5 2.5 1.5-1.5 3.5 3"/><circle cx="10.5" cy="6.5" r="1"/></svg>';

export interface ImageItem {
  /** Source range relative to the line start. */
  from: number;
  to: number;
  alt: string;
  /** The source as written. */
  src: string;
  title?: string | null;
}

/**
 * The images of a line, below its text. A failed load swaps in a placeholder by toggling a class (attribute
 * changes don't trip the editor's MutationObserver; child changes would make it rebuild the line).
 */
export function renderImages(imgs: ImageItem[], resolve: ImageResolver, reuse: ImagePool | undefined): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "imgs";
  wrap.contentEditable = "false";
  for (const el of imgs) {
    const box = document.createElement("span");
    box.className = "imgbox";
    box.dataset.at = String(el.to);
    box.dataset.from = String(el.from);
    const { alt, src } = el;
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
      const known = sizes.get(url);
      sizes.delete(url);
      sizes.set(url, [img.naturalWidth, img.naturalHeight]);
      if (sizes.size > SIZES_KEPT) sizes.delete(sizes.keys().next().value!);
      if (known?.[0] !== img.naturalWidth || known[1] !== img.naturalHeight) saveSizes();
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

export function renderToken(kind: TokenKind, line: { checked: boolean; level: number }, raw: string): HTMLElement {
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

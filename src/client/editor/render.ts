// Renderer: one <div class="ln"> per source line. Segment spans carry line-relative raw ranges in
// data-f / data-t. Inline markers are always in the DOM (collapsed by CSS unless revealed); block prefix
// tokens and link URLs are contenteditable=false atoms that hold no raw text.

import type { Line, TokenKind } from "./parser.ts";
import { type LineReveal, revealKey } from "./reveal.ts";

export type SegKind = "token" | "text" | "mk" | "esc" | "chip" | "fence";

export interface Seg {
  kind: SegKind;
  /** Absolute raw range. */
  from: number;
  to: number;
  cls: string[];
  /** For "mk": indices of the elements this marker belongs to. */
  el?: number;
  token?: TokenKind;
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
  const a = line.textFrom;
  const b = line.to;
  if (a >= b) return segs;
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
    segs.push({ kind, from: f, to: t, cls, el });
  }
  return segs;
}

/** Key that changes whenever the line's DOM must be rebuilt. */
export function lineKey(line: Line): string {
  const edge = (line.blockStart === line.index ? "s" : "") + (line.blockEnd === line.index ? "e" : "");
  return `${line.type}|${line.level}|${line.checked ? 1 : 0}|${line.indent}|${edge}|${line.text}`;
}

export interface LineDiv extends HTMLDivElement {
  _key?: string;
  _rv?: string;
}

export function renderLine(line: Line, text: string): LineDiv {
  const div = document.createElement("div") as LineDiv;
  div._key = lineKey(line);
  const cls = ["ln", "ln-" + line.type];
  if (line.type === "heading") cls.push("h" + line.level);
  if (line.checked) cls.push("checked");
  if (line.blockStart >= 0) {
    cls.push("in-code");
    if (line.index === line.blockStart) cls.push("code-first");
    if (line.index === line.blockEnd) cls.push("code-last");
  }
  div.className = cls.join(" ");
  const levels = line.indent + (line.tokens.some((t) => t.kind !== "indent" && t.kind !== "heading" && t.kind !== "hr") ? 1 : 0);
  if (levels) div.style.setProperty("--lv", String(levels));
  div.style.setProperty("--ind", String(line.indent));

  const segs = lineSegments(line);
  let lastIsText = false;
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
      const base = s.kind === "text" ? "t" : s.kind === "esc" ? "mk esc" : s.kind === "fence" ? "mk fence" : "mk";
      node.className = s.cls.length ? base + " " + s.cls.join(" ") : base;
      if (s.kind === "mk") node.dataset.e = String(s.el);
      node.textContent = text.slice(s.from, s.to);
      lastIsText = true;
    }
    node.dataset.f = String(f);
    node.dataset.t = String(t);
    div.appendChild(node);
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
  const set = new Set(r?.els ?? []);
  for (const mk of div.querySelectorAll<HTMLElement>(".mk[data-e]")) {
    mk.classList.toggle("rv", set.has(Number(mk.dataset.e)));
  }
}

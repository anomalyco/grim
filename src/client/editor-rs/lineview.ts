// LineViewJs (absolute offsets, engine enum names) -> RLine: line-relative offsets and the TS renderer's names, so
// a line's DOM doesn't depend on where the line is in the document and render.ts's classes apply unchanged.

import type { BlockType, CellAlign, TokenKind } from "../editor/parser.ts";
import type { SegKind } from "../editor/render.ts";
import type { LineViewJs } from "./types.ts";

export interface RSeg {
  kind: SegKind;
  /** Line-relative raw range. */
  from: number;
  to: number;
  cls: string[];
  hidden: boolean;
  token?: TokenKind;
  cell?: number;
  el?: number;
}

export interface RImage {
  /** Line-relative source range. */
  from: number;
  to: number;
  alt: string;
  src: string;
  title: string | null;
  revealed: boolean;
}

export interface RLine {
  key: string;
  /** Length of the line's raw text (without the newline). */
  len: number;
  textFrom: number;
  type: BlockType;
  level: number;
  checked: boolean;
  indent: number;
  gutterLevels: number;
  active: boolean;
  revealed: boolean;
  collapsed: boolean;
  code: { first: boolean; last: boolean } | null;
  table: { align: CellAlign[]; cells: number; columns: number } | null;
  segs: RSeg[];
  images: RImage[];
  imageOnly: boolean;
  /** Everything that decides the line's DOM except reveal state (with the line's text). */
  sig: string;
}

/** "TableDelim" / "tableDelim" / "table_delim" / "table-delim" -> "table-delim". */
export function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

const SEG_KIND: Record<string, SegKind> = {
  token: "token",
  text: "text",
  marker: "mk",
  mk: "mk",
  escape: "esc",
  esc: "esc",
  chip: "chip",
  fence: "fence",
  pipe: "pipe",
  pad: "pad",
  delim: "delim",
};

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

const num = (v: number | null | undefined): number | undefined => (v === null || v === undefined ? undefined : v);

/** Normalize a line view; `text` is the line's raw text. */
export function toRLine(lv: LineViewJs, text: string): RLine {
  const base = lv.from;
  const images: (RImage & { altRange: [number, number] })[] = (lv.images ?? []).map((im) => ({
    from: im.from - base,
    to: im.to - base,
    alt: im.alt,
    src: im.src,
    title: im.title ?? null,
    revealed: !!im.revealed,
    altRange: [im.altRange[0] - base, im.altRange[1] - base] as [number, number],
  }));
  const segs: RSeg[] = lv.segments.map((s) => {
    const kind = SEG_KIND[kebab(s.kind)] ?? "text";
    const from = s.from - base;
    const to = s.to - base;
    const cls: string[] = [];
    for (const st of s.styles ?? []) {
      const c = CLS[kebab(st)];
      if (!c) continue;
      cls.push(c);
      // the alt text of an image (TS render.ts adds it right after the image's class)
      if (c === "img" && images.some((im) => im.altRange[0] <= from && to <= im.altRange[1])) cls.push("alt");
    }
    const seg: RSeg = { kind, from, to, cls, hidden: !!s.hidden };
    if (s.token !== null && s.token !== undefined) seg.token = kebab(s.token) as TokenKind;
    const cell = num(s.cell);
    if (cell !== undefined) seg.cell = cell;
    const el = num(s.el);
    if (el !== undefined) seg.el = el;
    return seg;
  });
  const table = lv.table
    ? { align: lv.table.align.map((a) => (a ? (kebab(a) as CellAlign) : null)), cells: lv.table.cells, columns: lv.table.columns }
    : null;
  const r: RLine = {
    key: lv.key,
    len: lv.to - lv.from,
    textFrom: lv.textFrom - base,
    type: kebab(lv.kind) as BlockType,
    level: lv.level,
    checked: !!lv.checked,
    indent: lv.indent,
    gutterLevels: lv.gutterLevels,
    active: !!lv.active,
    revealed: !!lv.revealed,
    collapsed: !!lv.collapsed,
    code: lv.code ? { first: !!lv.code.first, last: !!lv.code.last } : null,
    table,
    segs,
    images: images.map(({ altRange: _, ...im }) => im),
    imageOnly: !!lv.imageOnly,
    sig: "",
  };
  r.sig = sigOf(r, text);
  return r;
}

/** RLine.sig of a line with raw text `text`. */
export function sigOf(r: RLine, text: string): string {
  return JSON.stringify([
    r.type,
    r.level,
    r.checked,
    r.indent,
    r.gutterLevels,
    r.textFrom,
    r.code,
    r.table,
    r.imageOnly,
    r.segs.map((s) => [s.kind, s.from, s.to, s.cls.join(" "), s.token ?? "", s.cell ?? -1, s.el ?? -1]),
    r.images.map((im) => [im.from, im.to, im.alt, im.src, im.title]),
    text,
  ]);
}

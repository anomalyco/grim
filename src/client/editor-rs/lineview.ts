// LineViewJs (line-relative offsets, engine enum names) -> RLine: the names render.ts and editor.css use. A line's DOM doesn't depend on where the line is in the document.

import type { LinePartJs, LineViewJs } from "./types.ts";

export type BlockType =
  | "paragraph"
  | "heading"
  | "bullet"
  | "todo"
  | "numbered"
  | "quote"
  | "hr"
  | "fence"
  | "code"
  | "table-head"
  | "table-delim"
  | "table-row";

export type CellAlign = "left" | "center" | "right" | null;

export type TokenKind = "indent" | "heading" | "bullet" | "todo" | "numbered" | "quote" | "hr";

export type SegKind = "token" | "text" | "mk" | "esc" | "chip" | "fence" | "pipe" | "pad" | "delim";

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
  /** A line with images split at them (empty: no images). */
  parts: LinePartJs[];
  /** Fold state (applied like reveal state, not part of `sig`). */
  foldable: boolean;
  folded: boolean;
  hidden: boolean;
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
  const images: (RImage & { altRange: [number, number] })[] = (lv.images ?? []).map((im) => ({
    from: im.from,
    to: im.to,
    alt: im.alt,
    src: im.src,
    title: im.title ?? null,
    revealed: !!im.revealed,
    altRange: [im.altRange[0], im.altRange[1]] as [number, number],
  }));
  const segs: RSeg[] = lv.segments.map((s) => {
    const kind = SEG_KIND[kebab(s.kind)] ?? "text";
    const from = s.from;
    const to = s.to;
    const cls: string[] = [];
    for (const st of s.styles ?? []) {
      const c = CLS[kebab(st)];
      if (!c) continue;
      cls.push(c);
      // the alt text of an image (its class goes right after the image's)
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
    len: lv.len,
    textFrom: lv.textFrom,
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
    parts: (lv.parts ?? []).map((p) =>
      p.kind === "text" ? { kind: "text", from: p.from, to: p.to, shown: !!p.shown } : { kind: "images", first: p.first, end: p.end },
    ),
    foldable: !!lv.foldable,
    folded: !!lv.folded,
    hidden: !!lv.hiddenByFold,
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
    r.parts.map((p) => (p.kind === "text" ? [p.from, p.to] : [p.first, p.end])),
    r.segs.map((s) => [s.kind, s.from, s.to, s.cls.join(" "), s.token ?? "", s.cell ?? -1, s.el ?? -1, s.kind === "text" && s.hidden ? 1 : 0]),
    r.images.map((im) => [im.from, im.to, im.alt, im.src, im.title]),
    text,
  ]);
}

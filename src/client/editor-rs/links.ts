// Links: where a link's destination points (pure, no DOM), the links of a line view, heading slugs.
// A collapsed link opens on a click (input.ts); the caret never expands it, only the pencil after it does (its
// source, URL included, then edits as text).

import { cleanSrc } from "./images.ts";
import type { RLine } from "./lineview.ts";

export type LinkTarget =
  /** http(s) / mailto elsewhere: a new tab. */
  | { kind: "external"; url: string }
  /** A Grim page on this origin (/app/..., old /r/... as /app/...): path + query + hash, opened in the app. */
  | { kind: "app"; url: string }
  /** `#heading` in the current note (decoded). */
  | { kind: "heading"; fragment: string }
  /** A file in the notebook (repo-relative path): a Markdown note (`note`), else another file (opened raw). */
  | { kind: "file"; path: string; note: boolean; fragment: string | null }
  /** A relative path leaving the notebook. */
  | { kind: "outside"; path: string }
  /** Nothing to open (unsafe scheme, empty). */
  | { kind: "none" };

export interface LinkContext {
  /** The note's repo-relative path (undefined: no notebook, e.g. the home page example). */
  notePath?: string;
  /** This page's origin (same-origin /app/ links open in the app). */
  origin?: string;
}

export const NOTE_EXT = /\.(md|markdown|mdx)$/i;
const SCHEME = /^([a-z][\w+.-]*):/i;

/** A destination as written, without <angle brackets> and backslash escapes. */
export function linkDest(raw: string): string {
  return cleanSrc(raw).replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Where a link with destination `raw` (as written in the Markdown) goes. */
export function linkTarget(raw: string, ctx: LinkContext = {}): LinkTarget {
  const dest = linkDest(raw);
  if (!dest || /[\x00-\x1f\x7f]/.test(dest)) return { kind: "none" };
  if (dest.startsWith("#")) {
    const fragment = decode(dest.slice(1));
    return fragment ? { kind: "heading", fragment } : { kind: "none" };
  }
  const scheme = SCHEME.exec(dest)?.[1]?.toLowerCase();
  if (scheme || dest.startsWith("//") || /^www\./i.test(dest)) {
    let u: URL;
    try {
      u = new URL(scheme ? dest : "https:" + (dest.startsWith("//") ? dest : "//" + dest));
    } catch {
      return { kind: "none" };
    }
    if (u.protocol === "mailto:") return { kind: "external", url: u.href };
    if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "none" };
    if (ctx.origin && u.origin === ctx.origin && /^\/(app|r)(\/|$)/.test(u.pathname)) {
      const path = u.pathname.startsWith("/r") ? "/app" + u.pathname.slice(2) : u.pathname;
      return { kind: "app", url: path + u.search + u.hash };
    }
    return { kind: "external", url: u.href };
  }
  // a path in the notebook: relative to the note's folder, or to the notebook root with a leading "/"
  const hash = dest.indexOf("#");
  const fragment = hash >= 0 ? decode(dest.slice(hash + 1)) || null : null;
  let path = (hash >= 0 ? dest.slice(0, hash) : dest).replace(/\?.*$/, "");
  path = decode(path);
  if (!path) return { kind: "none" };
  if (/[\x00-\x1f\x7f\\]/.test(path)) return { kind: "none" };
  const parts = path.startsWith("/") ? [] : (ctx.notePath ?? "").split("/").slice(0, -1);
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return { kind: "outside", path };
      parts.pop();
    } else parts.push(seg);
  }
  // a folder (or the root) isn't a file
  if (!parts.length || /\/\.{0,2}$/.test(path)) return { kind: "none" };
  const name = parts[parts.length - 1]!;
  if (NOTE_EXT.test(name)) return { kind: "file", path: parts.join("/"), note: true, fragment };
  // no extension: a note ("plan" -> plan.md)
  if (!/\.[^.]+$/.test(name.replace(/^\.+/, ""))) return { kind: "file", path: parts.join("/") + ".md", note: true, fragment };
  return { kind: "file", path: parts.join("/"), note: false, fragment };
}

/** GitHub's heading anchor: lower case, punctuation dropped (letters, numbers, `-`, `_` kept), spaces as `-`. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/**
 * The heading `fragment` names (`#Some Heading`, `#some-heading`, the n-th repeat as `#some-heading-n`), given the
 * headings' visible texts in order: its index in `headings`, or -1.
 */
export function findHeading(headings: string[], fragment: string): number {
  const seen = new Map<string, number>();
  const slugs = headings.map((h) => {
    const s = headingSlug(h);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  });
  const want = [fragment.toLowerCase(), headingSlug(fragment)];
  for (const w of want) {
    const i = slugs.indexOf(w);
    if (i >= 0) return i;
  }
  // the heading's text as written
  return headings.findIndex((h) => h.trim().toLowerCase() === fragment.trim().toLowerCase());
}

/** A link on a line (line-relative offsets): `[` at `from`, text `textFrom..textTo`, destination `raw`. */
export interface LineLink {
  from: number;
  textFrom: number;
  textTo: number;
  /** The destination's (URL text's) range. */
  urlFrom: number;
  urlTo: number;
  to: number;
  raw: string;
  /** Its markers are hidden (not expanded with its pencil): a click opens it. */
  collapsed: boolean;
}

/** The links of a line view; `text` is the line's raw text. */
export function lineLinks(line: RLine, text: string): LineLink[] {
  const out: LineLink[] = [];
  let open: { from: number; textFrom: number; el: number | undefined } | null = null;
  let mid: { textTo: number; hidden: boolean } | null = null;
  let chip: { from: number; to: number } | null = null;
  for (const s of line.segs) {
    if (s.kind === "mk" && s.cls.includes("link")) {
      const raw = text.slice(s.from, s.to);
      if (raw === "[" && !s.cls.includes("img")) {
        open = { from: s.from, textFrom: s.to, el: s.el };
        mid = null;
        chip = null;
      } else if (open && s.el === open.el && raw === "](") {
        mid = { textTo: s.from, hidden: s.hidden };
      } else if (open && mid && chip && s.el === open.el && raw === ")") {
        out.push({ from: open.from, textFrom: open.textFrom, textTo: mid.textTo, urlFrom: chip.from, urlTo: chip.to, to: s.to, raw: text.slice(chip.from, chip.to), collapsed: mid.hidden });
        open = mid = chip = null;
      }
    } else if (s.kind === "chip" && open && mid) {
      chip = { from: s.from, to: s.to };
    }
  }
  return out;
}

/** A heading line's visible text (its text segments, without markers or the link chips). */
export function visibleText(line: RLine, text: string): string {
  let s = "";
  for (const seg of line.segs) if (seg.kind === "text") s += text.slice(seg.from, seg.to);
  return s;
}

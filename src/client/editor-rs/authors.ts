// Line authors in the left margin (docs/05-v1-architecture.md, "Line authors"): the room says who wrote each line
// (`{t:"blame"}`, RustCollab.blame); this layer shows a small muted name at the editor pane's left edge (no colour: the message's
// colours aren't used here), only where it changes.
// Between messages the values move with the text (attribute): our own edits are ours at once, others' keep the
// line's previous author until the next message.

import { attribute, KEEP } from "../../shared/lineauthors.ts";
import type { Blame, BlameAuthor } from "./collab.ts";
import { crashSafe } from "./guard.ts";
import type { RLine } from "./lineview.ts";

/** Narrowest margin (px, from the editor's left edge to the text column) that still shows names. */
export const MIN_MARGIN = 90;
/** Where names start: this far right of the editor pane's left edge (px). */
export const INSET = 16;
/** Space kept between a name and the text column (px). */
const GAP = 12;
/** Names longer than this many characters are cut with an ellipsis (the full name is the tooltip). */
export const MAX_NAME = 12;

/** What decides whether a line can show a name. */
export interface MarkLine {
  type: string;
  /** Folded away. */
  hidden: boolean;
  /** No text (or only spaces). */
  empty: boolean;
}

/** Lines that never show a name: headings (their gutter has the H1 label and fold chevron) and markup-only lines. */
const SKIP = new Set(["heading", "fence", "table-delim", "hr"]);

/**
 * For each line the author to show (an index into the authors), or -1. A name shows only where the author differs
 * from the last line that could show one: headings, fences, empty and folded lines are passed over (they show
 * nothing and don't change "the last author"); a line of unknown authorship shows nothing and ends the run.
 * If the lines (all of them, headings and empty ones too; unknown ones aside) have fewer than two distinct
 * authors, no line shows a name.
 */
export function authorMarks(lines: MarkLine[], values: number[]): number[] {
  const out: number[] = new Array(lines.length).fill(-1);
  // a note with one author (or none known) shows no names at all
  const distinct = new Set<number>();
  for (let i = 0; i < lines.length && distinct.size < 2; i++) if ((values[i] ?? -1) >= 0) distinct.add(values[i]!);
  if (distinct.size < 2) return out;
  let last = -1;
  lines.forEach((l, i) => {
    if (l.hidden || l.empty || SKIP.has(l.type)) return;
    const v = values[i] ?? -1;
    if (v >= 0 && v !== last) out[i] = v;
    last = v;
  });
  return out;
}

/** A name cut to MAX_NAME characters (code points), with an ellipsis when cut. */
export function shortName(name: string): string {
  const chars = Array.from(name.trim());
  return chars.length > MAX_NAME ? chars.slice(0, MAX_NAME - 1).join("").trimEnd() + "…" : chars.join("");
}

/** What the layer needs of the editor view. */
export interface AuthorHost {
  wrapper: HTMLElement;
  root: HTMLElement;
  lines: RLine[];
  doc: { text: string; lines: Array<{ from: number; to: number }> };
}

export class AuthorGutter {
  readonly layer: HTMLDivElement;
  private authors: BlameAuthor[] = [];
  /** One per line of the view's text (once a message arrived). */
  private values: number[] = [];
  private has = false;
  private self = -1;
  private frame = 0;

  constructor(
    private view: AuthorHost,
    private me: { id: string; name: string; color: string; kind?: string },
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "mde-authors";
    view.wrapper.appendChild(this.layer);
  }

  /** The room's line authors arrived. */
  set(blame: Blame): void {
    this.authors = blame.authors.slice();
    this.values = blame.lines.slice();
    this.self = this.authors.findIndex((a) => a.id === this.me.id);
    this.has = true;
    this.schedule();
  }

  /** The text changed from `prev` to `next` (`local`: our own edit). */
  textChanged(prev: string, next: string, local: boolean): void {
    if (!this.has) return;
    let who: number | typeof KEEP = KEEP;
    if (local) {
      if (this.self < 0) this.self = this.authors.push({ id: this.me.id, name: this.me.name, kind: this.me.kind ?? "human", color: this.me.color }) - 1;
      who = this.self;
    }
    this.values = attribute(prev, next, this.values, who);
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(
      crashSafe(() => {
        this.frame = 0;
        this.draw();
      }),
    );
  }

  draw(): void {
    const v = this.view;
    const frag = document.createDocumentFragment();
    if (this.has && v.doc.lines.length === v.lines.length && v.root.children.length === v.lines.length) {
      const base = v.wrapper.getBoundingClientRect();
      const box = v.root.getBoundingClientRect();
      const textLeft = box.left + (parseFloat(getComputedStyle(v.root).paddingLeft) || 0);
      // left-aligned at INSET from the editor pane's left edge (the sidebar's right edge, or the window's)
      const left = Math.max(base.left, 0) + INSET;
      const room = textLeft - GAP - left;
      if (room >= MIN_MARGIN) {
        const marks = authorMarks(
          v.lines.map((l, i) => {
            const span = v.doc.lines[i]!;
            return { type: l.type, hidden: l.hidden, empty: !v.doc.text.slice(span.from, span.to).trim() };
          }),
          this.values,
        );
        const kids = v.root.children;
        marks.forEach((a, i) => {
          const author = this.authors[a];
          if (!author) return;
          const div = kids[i] as HTMLElement;
          const r = div.getBoundingClientRect();
          if (r.height <= 0) return;
          const cs = getComputedStyle(div);
          const lh = Math.min(r.height, parseFloat(cs.lineHeight) || 22);
          // the box gets the line's font and line height, so the name (baseline-aligned in it) sits on the
          // line's baseline; table rows start their text below the cells' top padding
          const cell = div.querySelector(".tcell");
          const pad = parseFloat(cs.paddingTop) || 0;
          const cellPad = cell ? parseFloat(getComputedStyle(cell).paddingTop) || 0 : 0;
          const el = document.createElement("div");
          el.className = "mde-author";
          el.dataset.line = String(i);
          el.title = author.name;
          el.style.top = `${r.top - base.top + pad + cellPad}px`;
          el.style.left = `${left - base.left}px`;
          el.style.maxWidth = `${room}px`;
          el.style.fontFamily = cs.fontFamily;
          el.style.fontSize = cs.fontSize;
          el.style.lineHeight = `${lh}px`;
          const name = document.createElement("span");
          name.className = "nm";
          name.textContent = shortName(author.name);
          el.append(name);
          frag.appendChild(el);
        });
      }
    }
    this.layer.replaceChildren(frag);
  }

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.layer.remove();
  }
}

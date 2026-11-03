// Line authors in the left margin (docs/05-v1-architecture.md, "Line authors"): the room says who wrote each line
// (`{t:"blame"}`, RustCollab.blame); this layer shows a small muted name at the editor pane's left edge (no colour: the
// message's colours aren't used here), only where it changes. People's names are never cut (one that doesn't fit the
// margin isn't shown); an agent's lines show its session's title ("Agent" without one), cut with "…" to the margin.
// Hovering an agent's label shows the full title, the agent and the session id.
// Review mode (setReview, turned on per note by the user): lines we wrote since it was turned on (ours by the line
// authors, and not a line of the text it started from) get a light green tint (and a thin bar at its left) behind the text.
// Between messages the values move with the text (attribute): our own edits are ours at once, others' keep the
// line's previous author until the next message. An edit that brings back a line's exact text (undo, redo, typing it
// back) gives it back to whoever had that text (the client's LineHistory, as the room's), so there's no flicker.

import { attribute, KEEP, LineMemory, type LineHistory } from "../../shared/lineauthors.ts";
import { linePairs } from "../../shared/textdiff.ts";
import type { Blame, BlameAuthor } from "./collab.ts";
import { crashSafe } from "./guard.ts";
import type { RLine } from "./lineview.ts";
import { isBlock, lineDivs } from "./blocks.ts";

/**
 * Narrowest margin (px, from where names start to GAP before the text column) worth drawing names in; whether a
 * name shows is then decided by its own width (fitsMargin), so this only skips margins no name could fit.
 */
export const MIN_MARGIN = 24;
/** Where names start: this far right of the editor pane's left edge (px). */
export const INSET = 16;
/** Space kept between a name and the text column (px). */
const GAP = 12;

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

/** Whether a name `width` px wide fits a margin `room` px wide (names are shown whole or not at all). */
export function fitsMargin(width: number, room: number): boolean {
  return width <= room + 0.5;
}

/** The margin label of an author: an agent's session title, or "Agent" without one; a person's name. */
export function authorLabel(a: Pick<BlameAuthor, "kind" | "name" | "sessionName">): string {
  return a.kind === "agent" ? a.sessionName || "Agent" : a.name;
}

/** An agent label's hover: the full title (or "Agent"), then the agent's name and its session id. */
export function authorHover(a: Pick<BlameAuthor, "kind" | "name" | "session" | "sessionName">): string | null {
  if (a.kind !== "agent") return null;
  return `${a.sessionName || "Agent"}\n${[a.name, a.session].filter(Boolean).join(" · ")}`;
}

/**
 * Review mode's highlighted lines: per line of `text`, whether it's ours (`values[i] === self`), not blank, not
 * changed by someone else since the last message (`others[i]`), and not a line of `baseline` (the text review
 * mode started from, matched by a line diff: undoing or typing a line back as it was ends its highlight).
 */
export function reviewed(baseline: string, text: string, values: number[], self: number, others: ArrayLike<number> = []): boolean[] {
  const lines = text.split("\n");
  const out = new Array<boolean>(lines.length).fill(false);
  if (self < 0) return out;
  const kept = new Set(linePairs(baseline.split("\n"), lines).map(([, b]) => b));
  lines.forEach((l, i) => {
    out[i] = values[i] === self && !others[i] && !kept.has(i) && !!l.trim();
  });
  return out;
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
  /** The tints behind the text (under the text column, below the selection). */
  readonly tints: HTMLDivElement;
  private authors: BlameAuthor[] = [];
  /** One per line of the view's text (once a message arrived). */
  private values: number[] = [];
  /** Per line: 1 where someone else changed it since the last message (its author is theirs until it comes). */
  private others: number[] = [];
  /** Who had the line texts our edits took away (by author id, so it outlives messages). */
  private memory = new LineMemory();
  private remembered: BlameAuthor[] = [];
  /** Review mode's starting text (null: off), and the highlighted lines' count last drawn. */
  private review: string | null = null;
  private reviewCount = -1;
  private has = false;
  private self = -1;
  private frame = 0;

  constructor(
    private view: AuthorHost,
    private me: { id: string; name: string; color: string; kind?: string },
    /** Review mode's highlighted lines changed in number. */
    private onReview?: (count: number) => void,
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "mde-authors";
    view.wrapper.appendChild(this.layer);
    this.tints = document.createElement("div");
    this.tints.className = "mde-tints";
    this.tints.setAttribute("aria-hidden", "true");
    view.wrapper.insertBefore(this.tints, view.wrapper.firstChild);
  }

  /** The room's line authors arrived. */
  set(blame: Blame): void {
    this.authors = blame.authors.slice();
    this.values = blame.lines.slice();
    this.others = this.values.map(() => 0);
    this.self = this.authors.findIndex((a) => a.id === this.me.id);
    this.has = true;
    this.layer.classList.add("has-blame");
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
    this.values = attribute(prev, next, this.values, who, who === KEEP ? undefined : this.history);
    this.others = attribute(prev, next, this.others, local ? 0 : 1);
  }

  /** Review mode on (`baseline`: the text it started from) or off (null). */
  setReview(baseline: string | null): void {
    this.review = baseline;
    this.schedule();
  }

  /** The line history on author ids (values index `authors`, which each message replaces). */
  private history: LineHistory = {
    remember: (text, v) => {
      const a = this.authors[v];
      if (!a) return this.memory.remember(text, -1);
      let n = this.remembered.findIndex((r) => r.id === a.id);
      if (n < 0) n = this.remembered.push(a) - 1;
      this.memory.remember(text, n);
    },
    recall: (text) => {
      const n = this.memory.recall(text);
      if (n === undefined || n < 0) return n;
      const a = this.remembered[n]!;
      const i = this.authors.findIndex((x) => x.id === a.id);
      return i >= 0 ? i : this.authors.push(a) - 1;
    },
  };

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
    const tints = document.createDocumentFragment();
    let room = 0;
    let count = 0;
    if (this.has && v.doc.lines.length === v.lines.length && lineDivs(v.root).length === v.lines.length) {
      const base = v.wrapper.getBoundingClientRect();
      const box = v.root.getBoundingClientRect();
      const rootStyle = getComputedStyle(v.root);
      const textLeft = box.left + (parseFloat(rootStyle.paddingLeft) || 0);
      const textRight = box.right - (parseFloat(rootStyle.paddingRight) || 0);
      const kids = lineDivs(v.root);
      const lines = v.lines.map((l, i) => {
        const span = v.doc.lines[i]!;
        return { type: l.type, hidden: l.hidden, empty: !v.doc.text.slice(span.from, span.to).trim() };
      });
      // review mode: our lines since it started, one tint per run of them, the text column's width
      if (this.review !== null) {
        const mine = reviewed(this.review, v.doc.text, this.values, this.self, this.others);
        count = mine.filter(Boolean).length;
        let run: { top: number; bottom: number } | null = null;
        const flush = () => {
          if (!run) return;
          const t = document.createElement("div");
          t.className = "mde-tint";
          t.style.top = `${run.top - base.top}px`;
          t.style.height = `${run.bottom - run.top}px`;
          t.style.left = `${textLeft - base.left}px`;
          t.style.width = `${textRight - textLeft}px`;
          tints.appendChild(t);
          run = null;
        };
        lines.forEach((l, i) => {
          if (l.hidden || l.empty || !mine[i]) return flush();
          const r = (kids[i] as HTMLElement).getBoundingClientRect();
          if (r.height <= 0) return;
          if (run && Math.abs(r.top - run.bottom) < 1) run.bottom = r.bottom;
          else {
            flush();
            run = { top: r.top, bottom: r.bottom };
          }
        });
        flush();
      }
      // left-aligned at INSET from the editor pane's left edge (the sidebar's right edge, or the window's)
      const left = Math.max(base.left, 0) + INSET;
      room = textLeft - GAP - left;
      if (room >= MIN_MARGIN) {
        const marks = authorMarks(lines, this.values);
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
          el.style.top = `${r.top - base.top + pad + cellPad}px`;
          el.style.left = `${left - base.left}px`;
          el.style.fontFamily = cs.fontFamily;
          el.style.fontSize = cs.fontSize;
          el.style.lineHeight = `${lh}px`;
          // a table or code block grown into the margin leaves its lines less room
          const blk = div.parentNode as HTMLElement;
          const own = isBlock(v.root, blk) ? Math.min(room, blk.getBoundingClientRect().left - GAP - left) : room;
          el.dataset.room = String(own);
          const name = document.createElement("span");
          name.className = "nm";
          name.textContent = authorLabel(author);
          const hover = authorHover(author);
          if (hover !== null) {
            // an agent's session title: cut with "…" to the margin (never its start), in full on hover
            el.classList.add("agent");
            name.style.maxWidth = `${Math.max(0, own)}px`;
            el.title = hover;
          }
          el.append(name);
          frag.appendChild(el);
        });
      }
    }
    this.tints.replaceChildren(tints);
    if (this.review === null) count = 0;
    if (count !== this.reviewCount) {
      this.reviewCount = count;
      this.onReview?.(count);
    }
    this.layer.replaceChildren(frag);
    // a person's name wider than the margin would run into the text: it isn't shown (never cut)
    for (const el of Array.from(this.layer.children) as HTMLElement[]) {
      if (el.classList.contains("agent")) continue;
      if (!fitsMargin((el.firstElementChild as HTMLElement).getBoundingClientRect().width, Number(el.dataset.room))) el.remove();
    }
  }

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.layer.remove();
    this.tints.remove();
  }
}

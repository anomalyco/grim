// Syntax highlighting of fenced code blocks with a language (```ts, ~~~diff, ```Rust title="x"): a colour layer
// over the code lines' rendering (render.ts CodeHl). This part (in the main bundle) finds the blocks and their
// languages after every patch and redraws the code lines whose highlighting changed. The highlighter
// (@pierre/highlights, code-live.ts) and its wasm load only when a note has a block in a language it knows (checked
// by code-langs.ts, a small chunk); if they can't load, code stays plain.

import type { RLine } from "./lineview.ts";
import type { CodeHl, RLineDiv } from "./render.ts";
import type { CodeBlocks } from "./code-live.ts";
import { isLineDiv, lineDivs } from "./blocks.ts";

declare const __HL_WASM_HASH__: string | undefined;

const WASM_URL =
  typeof __HL_WASM_HASH__ === "string" && __HL_WASM_HASH__ ? `/dist/highlights/${__HL_WASM_HASH__}/highlights.wasm` : "/dist/highlights/highlights.wasm";

/** The language word of a fence line (the info string's first word, lower case; ```{.py} too), or null. */
export function fenceLang(line: string): string | null {
  const m = /^[ \t]*(?:`{3,}|~{3,})[ \t]*\{?\.?([^\s`{},;]+)/.exec(line);
  return m ? m[1]!.toLowerCase() : null;
}

export interface CodeHost {
  lines: RLine[];
  doc: { text: string; lines: readonly { from: number; to: number }[] };
  root: HTMLElement;
  /** The DOM may be rebuilt now (not composing, nothing pending). */
  canRedrawCode(): boolean;
  /** Redraw lines with their highlighting (null: plain). */
  redrawCode(lines: [index: number, hl: CodeHl | null][]): void;
}

/** A code block with a language: content lines [from, to) of the view. */
export interface Block {
  key: string;
  lang: string;
  from: number;
  to: number;
}

/** The fenced blocks with a language word, from the line views. */
export function findBlocks(lines: readonly RLine[], textOf: (i: number) => string): Block[] {
  const out: Block[] = [];
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const l = lines[i]!;
    if (l.type !== "fence" || !l.code?.first) continue;
    let j = i + 1;
    for (; j < n; j++) {
      const c = lines[j]!;
      if (!c.code || c.code.first || c.type === "fence") break;
      if (c.code.last) {
        j++;
        break;
      }
    }
    const lang = fenceLang(textOf(i));
    if (lang) out.push({ key: l.key, lang, from: i + 1, to: j });
    i = j - 1;
  }
  return out;
}

type Langs = typeof import("./code-langs.ts");
type Live = typeof import("./code-live.ts");
let langs: Langs | null = null;
let langsP: Promise<Langs> | null = null;
let live: Live | null = null;
let liveP: Promise<Live> | null = null;
let failed = false;

export class CodeHighlight {
  private blocks: CodeBlocks | null = null;
  /** The line views of each block at the last update (a block whose lines are the same isn't looked at again). */
  private seen = new Map<string, readonly RLine[]>();
  /** Line divs drawn with highlighting. */
  private drawn = new Set<RLineDiv>();
  private later: ReturnType<typeof setTimeout> | null = null;
  private waiting = false;
  private destroyed = false;

  constructor(private readonly host: CodeHost) {}

  /** After the view's lines or DOM changed. */
  update(): void {
    if (failed || this.destroyed || this.waiting) return;
    const h = this.host;
    const kids = lineDivs(h.root);
    if (kids.length !== h.lines.length || !h.canRedrawCode()) return;
    const textOf = (i: number) => h.doc.text.slice(h.doc.lines[i]!.from, h.doc.lines[i]!.to);
    let blocks = findBlocks(h.lines, textOf);
    if (blocks.length && !this.blocks) {
      if (!langs) return this.wait((langsP ??= import("./code-langs.ts")).then((m) => (langs = m)));
      blocks = blocks.filter((b) => langs!.supported(b.lang));
      if (blocks.length) {
        if (!live) return this.wait((liveP ??= import("./code-live.ts").then(async (m) => (await m.load(WASM_URL), m))).then((m) => (live = m)));
        this.blocks = new live.CodeBlocks();
      }
    } else if (langs) {
      blocks = blocks.filter((b) => langs!.supported(b.lang));
    }
    const want = new Map<number, CodeHl>();
    if (this.blocks) {
      const seen = new Map<string, readonly RLine[]>();
      const same = (b: Block) => {
        const ls = h.lines.slice(b.from, b.to);
        const old = this.seen.get(b.key);
        seen.set(b.key, ls);
        // a line view whose text changed gets a new sig (view.ts keeps them up to date)
        return !!old && old.length === ls.length && old.every((l, k) => l === ls[k] || l.sig === ls[k]!.sig);
      };
      try {
        const res = this.blocks.sync(blocks, same, (b) => Array.from({ length: b.to - b.from }, (_, k) => textOf(b.from + k)));
        blocks.forEach((b, k) => res[k]?.forEach((v, j) => want.set(b.from + j, v)));
        this.seen = seen;
        if (this.blocks.pending && !this.later) {
          this.later = setTimeout(() => {
            this.later = null;
            this.update();
          }, 16);
        }
      } catch {
        // a tokenizer failed (out of memory?): code goes plain
        failed = true;
        this.dispose();
        want.clear();
      }
    }
    const redraw: [number, CodeHl | null][] = [];
    const keep = new Set<Element>();
    for (const [i, hl] of want) {
      const d = kids[i] as RLineDiv;
      keep.add(d);
      if (d._hl !== hl.sig) redraw.push([i, hl]);
    }
    // lines drawn highlighted that no longer are (their block went, or its language)
    for (const d of this.drawn) {
      if (!keep.has(d) && isLineDiv(h.root, d) && d._hl !== undefined) redraw.push([Array.prototype.indexOf.call(kids, d), null]);
    }
    if (redraw.length) h.redrawCode(redraw);
    this.drawn.clear();
    for (const i of want.keys()) this.drawn.add(kids[i] as RLineDiv);
  }

  private wait(p: Promise<unknown>): void {
    this.waiting = true;
    p.then(
      () => {
        this.waiting = false;
        this.update();
      },
      () => {
        failed = true;
        this.waiting = false;
      },
    );
  }

  private dispose(): void {
    try {
      this.blocks?.dispose();
    } catch {}
    this.blocks = null;
    this.seen.clear();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.later) clearTimeout(this.later);
    this.dispose();
  }
}

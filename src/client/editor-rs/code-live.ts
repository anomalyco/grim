// The highlighter (a chunk code.ts loads on demand): @pierre/highlights with its wasm fetched from dist (not the
// package's default entry, which inlines the wasm as base64), one LiveTokenizer per code block. A block's tokenizer
// gets the changed lines as one edit; only lines it re-tokenized get new highlighting.

import { init, LiveTokenizer, tokenNames, type LiveTextEdit } from "../../../node_modules/@pierre/highlights/dist/index.js";
import themeJson from "../../shared/highlight-theme.json";
import { themeClasses, type CodeTheme, type ThemeClasses } from "./code-theme.ts";
import type { Block } from "./code.ts";
import type { CodeHl } from "./render.ts";

/** Lines this long aren't highlighted (one span per token would be a lot of DOM). */
const MAX_LINE = 4000;
/** Time a sync may spend creating tokenizers (each has its own wasm instance, ~0.7 ms); the rest wait (`pending`). */
const CREATE_BUDGET_MS = 12;
/** Token styles come from our theme (themeClasses), by token id; the tokenizer's own theme isn't used. */
const NO_THEME = { name: "none", appearance: "light", style: {} };

let classes: ThemeClasses | null = null;

/** Compile and install the wasm (a URL, or the module), and the theme's CSS. */
export async function load(wasm: string | WebAssembly.Module): Promise<void> {
  if (classes) return;
  let mod: WebAssembly.Module;
  if (typeof wasm === "string") {
    const res = await fetch(wasm);
    if (!res.ok) throw new Error(`highlighter wasm: HTTP ${res.status}`);
    mod = /application\/wasm/.test(res.headers.get("content-type") ?? "")
      ? await WebAssembly.compileStreaming(res)
      : await WebAssembly.compile(await res.arrayBuffer());
  } else {
    mod = wasm;
  }
  init(mod);
  const c = themeClasses(themeJson as CodeTheme, tokenNames);
  if (typeof document !== "undefined") {
    const style = document.createElement("style");
    style.dataset.codeTheme = (themeJson as { name?: string }).name ?? "";
    style.textContent = c.css;
    document.head.appendChild(style);
  }
  classes = c;
}

interface State {
  lang: string;
  tk: LiveTokenizer;
  texts: string[];
  hls: CodeHl[];
}

/** The tokenizers of one view's code blocks, by block key. */
export class CodeBlocks {
  private states = new Map<string, State>();
  /** The last sync left blocks without a tokenizer (null in its result): sync again soon. */
  pending = false;

  /**
   * Highlighting of every content line of `blocks` (lines of a block in order); unchanged lines keep their object.
   * `same(b)`: the block's lines are what they were at the last sync (`linesOf` isn't needed). Null: not yet.
   */
  sync(blocks: readonly Block[], same: (b: Block) => boolean, linesOf: (b: Block) => string[]): (CodeHl[] | null)[] {
    const deadline = performance.now() + CREATE_BUDGET_MS;
    this.pending = false;
    const keys = new Set(blocks.map((b) => b.key));
    // blocks whose key went (the engine renumbers lines after a full render): reused by a new block of their language
    const orphans = [...this.states].filter(([k]) => !keys.has(k));
    const out: (CodeHl[] | null)[] = [];
    for (const b of blocks) {
      let s = this.states.get(b.key);
      if (same(b) && s && s.lang === b.lang) {
        out.push(s.hls);
        continue;
      }
      const texts = linesOf(b);
      if (s && s.lang !== b.lang) {
        s.tk.dispose();
        this.states.delete(b.key);
        s = undefined;
      }
      if (!s) {
        const i = orphans.findIndex(([, o]) => o.lang === b.lang);
        if (i >= 0) {
          const [k, o] = orphans.splice(i, 1)[0]!;
          this.states.delete(k);
          this.states.set(b.key, (s = o));
        }
      }
      if (!s && performance.now() > deadline) {
        this.pending = true;
        out.push(null);
        continue;
      }
      if (!s) {
        const tk = new LiveTokenizer({ lang: b.lang as never, theme: NO_THEME, code: texts.join("\n") });
        s = { lang: b.lang, tk, texts, hls: texts.map((t, i) => lineHl(tk, i, t, b.lang)) };
        this.states.set(b.key, s);
      } else {
        update(s, texts);
      }
      out.push(s.hls);
    }
    for (const [k, o] of orphans) {
      o.tk.dispose();
      this.states.delete(k);
    }
    return out;
  }

  get size(): number {
    return this.states.size;
  }

  dispose(): void {
    for (const s of this.states.values()) s.tk.dispose();
    this.states.clear();
  }
}

/** Bring a block's tokenizer to `texts`: the lines between the unchanged first and last ones, as one edit. */
function update(s: State, texts: string[]): void {
  const old = s.texts;
  const m = old.length;
  const n = texts.length;
  let p = 0;
  while (p < m && p < n && old[p] === texts[p]) p++;
  if (p === m && p === n) return;
  let q = 0;
  while (q < m - p && q < n - p && old[m - 1 - q] === texts[n - 1 - q]) q++;
  const hls: CodeHl[] = new Array(n);
  const todo: [number, number][] = [[p, n - q]];
  if (!m || !n) {
    s.tk.reset(texts.join("\n"));
    todo[0] = [0, n];
  } else {
    let edit: LiveTextEdit;
    const mid = texts.slice(p, n - q);
    if (q > 0) {
      // whole lines [p, m - q) -> mid, each with its newline
      edit = { range: { start: { line: p, character: 0 }, end: { line: m - q, character: 0 } }, newText: mid.map((t) => t + "\n").join("") };
    } else if (p > 0) {
      // the end of the block: from the end of line p - 1
      edit = {
        range: { start: { line: p - 1, character: old[p - 1]!.length }, end: { line: m - 1, character: old[m - 1]!.length } },
        newText: mid.map((t) => "\n" + t).join(""),
      };
    } else {
      edit = { range: { start: { line: 0, character: 0 }, end: { line: m - 1, character: old[m - 1]!.length } }, newText: mid.join("\n") };
    }
    const u = s.tk.applyEdits([edit]);
    for (let i = 0; i < p; i++) hls[i] = s.hls[i]!;
    for (let i = n - q; i < n; i++) hls[i] = s.hls[i - n + m]!;
    for (const c of u.lineChanges) todo.push([c.newStartLine, c.newEndLine]);
  }
  for (const [a, b] of todo) for (let i = Math.max(0, a); i < Math.min(n, b); i++) hls[i] = lineHl(s.tk, i, texts[i]!, s.lang, hls[i]);
  s.texts = texts;
  s.hls = hls;
}

/**
 * Line `i`'s highlighting from its token records; `prev` is returned when nothing changed. The line's class (diff
 * backgrounds) comes from its first token that isn't punctuation; in a diff/patch block a line that is just "+" or
 * "-" (only punctuation) counts as added / removed (as in the native app).
 */
function lineHl(tk: LiveTokenizer, i: number, text: string, lang: string, prev?: CodeHl): CodeHl {
  const c = classes!;
  const runs: CodeHl["runs"] = [];
  let cls = (lang === "diff" || lang === "patch") && (text === "+" || text === "-") ? c.line[tokenNames.indexOf(text === "+" ? "diff.plus" : "diff.minus")] ?? "" : "";
  if (text.length <= MAX_LINE) {
    const recs = tk.getLineRecords(i);
    const d = recs.data;
    const wide = recs.format === "wide32";
    let start = 0;
    let decided = false;
    for (let k = 0; k < d.length; k += wide ? 2 : 1) {
      const end = wide ? d[k]! : d[k]! & 0xffffff;
      const id = wide ? d[k + 1]! : d[k]! >>> 24;
      if (end <= start) continue;
      if (!decided && !cls && !c.lead[id]) {
        cls = c.line[id] ?? "";
        decided = true;
      }
      const tc = c.token[id];
      if (tc) {
        const last = runs[runs.length - 1];
        if (last && last[1] === start && last[2] === tc) last[1] = end;
        else runs.push([start, end, tc]);
      }
      start = end;
    }
  }
  const sig = cls + "|" + runs.map((r) => r.join(",")).join(";");
  return prev && prev.sig === sig ? prev : { sig, cls, runs };
}

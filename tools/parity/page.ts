// Parity test page: mounts our editor (src/client/editor-rs, the Rust engine) on a local document and exposes
// window.__parity for tools/parity/runner.swift. The wasm comes base64-inlined from wasm.js (run.sh writes it)
// because Chrome can't fetch it from a file:// page.
import { RustEditorView } from "../../src/client/editor-rs/view.ts";
import { Engine, initSync } from "../../src/client/editor-rs/pkg/editor_wasm.js";
import type { EngineFactory } from "../../src/client/editor-rs/types.ts";

const host = document.getElementById("ed")!;
let view: RustEditorView | null = null;
const b64: string = (window as any).__WASM_B64;
initSync({ module: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) });
const engine: EngineFactory = (text: string) => new Engine(text) as unknown as ReturnType<EngineFactory>;

function mount(doc: string) {
  view?.destroy();
  host.innerHTML = "";
  view = new RustEditorView(host, { text: doc, engine });
  view.setSel({ anchor: 0, head: 0 });
}

const raw = () => view!.doc.text;

/**
 * Style flags of a visible text run. Inline styles come from our classes (so block-level styling choices like
 * italic quotes, underlined links and monospace code blocks are not compared); bold also counts heading text.
 */
function flags(el: Element): string {
  const c = el.classList;
  let f = "";
  if (c.contains("b") || Number(getComputedStyle(el).fontWeight) >= 600) f += "B";
  if (c.contains("i")) f += "I";
  if (c.contains("s")) f += "S";
  if (c.contains("u")) f += "U";
  return f;
}

/** The caret's line as the user sees it — same format as BearTarget.lineView in runner.swift. */
function lineView(): string {
  const v = view!;
  const text = raw();
  const { anchor, head } = v.sel;
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  // Like the Bear side, show the line holding the selection's start (the caret when collapsed).
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const lineIndex = text.slice(0, lineStart).split("\n").length - 1;
  const div = host.querySelectorAll<HTMLElement>(".ln")[lineIndex];
  if (!div) return "?";
  let out = "";
  let curFlags = "";
  let run = "";
  const flush = () => {
    if (run) out += curFlags ? `⟨${curFlags}:${run}⟩` : run;
    run = "";
  };
  const emit = (s: string, f: string) => {
    if (f !== curFlags) {
      flush();
      curFlags = f;
    }
    run += s;
  };
  const caretAt = (abs: number) => {
    if (from === to && abs === head) emit("|", curFlags);
    if (from !== to && abs === from) emit("[", curFlags);
    if (from !== to && abs === to) emit("]", curFlags);
  };
  let pos = lineStart;
  for (const node of Array.from(div.children) as HTMLElement[]) {
    if (node.dataset.f === undefined) continue;
    const f = lineStart + Number(node.dataset.f);
    const t = lineStart + Number(node.dataset.t);
    pos = f;
    if (node.classList.contains("tok")) {
      caretAt(f);
      emit("▸", "");
      if (node.dataset.tok === "numbered") emit(text.slice(f, t).trimStart(), "");
      pos = t;
      continue;
    }
    if (node.classList.contains("chip")) {
      caretAt(f);
      emit("✎", "");
      pos = t;
      continue;
    }
    const hidden = parseFloat(getComputedStyle(node).fontSize) < 0.5;
    const isMarker = node.classList.contains("mk");
    const fl = isMarker ? "" : flags(node);
    for (let i = f; i < t; i++) {
      caretAt(i);
      if (hidden) continue;
      emit(isMarker ? `‹${text[i]}›` : text[i]!, fl);
    }
    pos = t;
  }
  const lineEnd = text.indexOf("\n", lineStart);
  caretAt(lineEnd < 0 ? text.length : lineEnd);
  void pos;
  flush();
  return out;
}

(window as any).__parity = {
  reset(doc: string) {
    mount(doc);
    view!.focus();
  },
  focus() {
    view!.focus();
  },
  engine: "rust",
  axText: raw,
  raw,
  axSelection() {
    const { anchor, head } = view!.sel;
    return [Math.min(anchor, head), Math.abs(head - anchor)];
  },
  setAxSelection(loc: number, len: number) {
    view!.setSel({ anchor: loc, head: loc + len });
  },
  lineView,
  caretRect() {
    const r = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
    return r ? [r.x, r.y, r.width, r.height] : [0, 0, 0, 0];
  },
};
mount("");

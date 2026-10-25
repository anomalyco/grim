// Parity test page: mounts our editor on a local Y.Doc and exposes window.__parity for tools/parity/runner.swift.
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { EditorView } from "../../src/client/editor/view.ts";

const host = document.getElementById("ed")!;
let view: EditorView | null = null;
let ytext: Y.Text;

function mount(doc: string) {
  view?.destroy();
  host.innerHTML = "";
  const ydoc = new Y.Doc();
  ytext = ydoc.getText("md");
  ytext.insert(0, doc);
  const aw = new Awareness(ydoc);
  aw.setLocalState({ user: { id: "p", name: "Parity", color: "#d63b3b", kind: "human" }, cursor: null });
  view = new EditorView(host, { ytext, awareness: aw });
  view.setSel({ anchor: 0, head: 0 }, { dom: true });
}

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
  const raw = ytext.toString();
  const { anchor, head } = v.sel;
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  // Like the Bear side, show the line holding the selection's start (the caret when collapsed).
  const lineStart = raw.lastIndexOf("\n", from - 1) + 1;
  const lineIndex = raw.slice(0, lineStart).split("\n").length - 1;
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
      if (node.dataset.tok === "numbered") emit(raw.slice(f, t).trimStart(), "");
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
      emit(isMarker ? `‹${raw[i]}›` : raw[i]!, fl);
    }
    pos = t;
  }
  const lineEnd = raw.indexOf("\n", lineStart);
  caretAt(lineEnd < 0 ? raw.length : lineEnd);
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
  axText: () => ytext.toString(),
  raw: () => ytext.toString(),
  axSelection() {
    const { anchor, head } = view!.sel;
    return [Math.min(anchor, head), Math.abs(head - anchor)];
  },
  setAxSelection(loc: number, len: number) {
    view!.setSel({ anchor: loc, head: loc + len }, { dom: true });
  },
  lineView,
  caretRect() {
    const r = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
    return r ? [r.x, r.y, r.width, r.height] : [0, 0, 0, 0];
  },
};
mount("");

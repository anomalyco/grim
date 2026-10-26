// The Rust-engine editor: same options and handle as mountEditor (src/client/editor/index.ts). The engine (wasm)
// loads on first use; until then the container stays empty. If it can't load, the TS editor is mounted instead.

import { mountEditor, type EditorHandle, type EditorOptions } from "../editor/index.ts";
import { loadWasmEngine } from "./engine.ts";
import type { EngineFactory } from "./types.ts";
import { RustEditorView } from "./view.ts";

export interface RustEditorOptions extends EditorOptions {
  /** The engine to use (default: the wasm build served from /dist/editor-rs/). */
  engine?: EngineFactory | Promise<EngineFactory>;
}

export interface RustEditorHandle extends EditorHandle {
  /** Resolves with the view once the engine is loaded (null if the TS editor was mounted instead, or destroyed). */
  ready: Promise<RustEditorView | null>;
}

export function mountRustEditor(container: HTMLElement, opts: RustEditorOptions): RustEditorHandle {
  let view: RustEditorView | null = null;
  let fallback: EditorHandle | null = null;
  let destroyed = false;
  let wantFocus = false;
  const ready = Promise.resolve(opts.engine ?? loadWasmEngine()).then(
    (engine) => {
      if (destroyed) return null;
      view = new RustEditorView(container, { ...opts, engine });
      if (wantFocus) view.focus();
      return view;
    },
    (err) => {
      console.error("The Rust editor engine failed to load; using the TS editor.", err);
      if (destroyed) return null;
      fallback = mountEditor(container, opts);
      if (wantFocus) fallback.focus();
      return null;
    },
  );
  return {
    ready,
    destroy() {
      destroyed = true;
      view?.destroy();
      fallback?.destroy();
    },
    focus() {
      if (view) view.focus();
      else if (fallback) fallback.focus();
      else wantFocus = true;
    },
  };
}

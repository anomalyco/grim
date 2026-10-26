// The Rust-engine editor: same options and handle as mountEditor (src/client/editor/index.ts). The engine (wasm)
// loads on first use; until then the container stays empty. If it can't load, the TS editor is mounted instead.
// With `collab` (a note's RustCollab connection, which already holds a loaded engine) the view mounts at once and
// the engine owns the shared document.

import { mountEditor, type EditorHandle, type EditorOptions } from "../editor/index.ts";
import { loadWasmEngine } from "./engine.ts";
import type { RustCollab } from "./collab.ts";
import type { EngineFactory } from "./types.ts";
import { RustEditorView } from "./view.ts";

export type RustEditorOptions = Pick<EditorOptions, "readOnly" | "images"> &
  (
    | (EditorOptions & {
        /** The engine to use (default: the wasm build served from /dist/editor-rs/). */
        engine?: EngineFactory | Promise<EngineFactory>;
        collab?: undefined;
      })
    | { collab: RustCollab; ytext?: undefined; awareness?: undefined; engine?: undefined }
  );

export interface RustEditorHandle extends EditorHandle {
  /** Resolves with the view once the engine is loaded (null if the TS editor was mounted instead, or destroyed). */
  ready: Promise<RustEditorView | null>;
}

export function mountRustEditor(container: HTMLElement, opts: RustEditorOptions): RustEditorHandle {
  if (opts.collab) {
    const v = new RustEditorView(container, { collab: opts.collab, readOnly: opts.readOnly, images: opts.images });
    return { ready: Promise.resolve(v), destroy: () => v.destroy(), focus: () => v.focus() };
  }
  const local = opts;
  let view: RustEditorView | null = null;
  let fallback: EditorHandle | null = null;
  let destroyed = false;
  let wantFocus = false;
  const ready = Promise.resolve(local.engine ?? loadWasmEngine()).then(
    (engine) => {
      if (destroyed) return null;
      view = new RustEditorView(container, { ytext: local.ytext, awareness: local.awareness, readOnly: local.readOnly, images: local.images, engine });
      if (wantFocus) view.focus();
      return view;
    },
    (err) => {
      console.error("The Rust editor engine failed to load; using the TS editor.", err);
      if (destroyed) return null;
      fallback = mountEditor(container, local);
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

// The editor: a contenteditable view driven by the Rust engine (wasm), loaded on first use; until then the
// container stays empty. With `collab` (a note's RustCollab connection, which already holds a loaded engine) the
// view mounts at once and the engine owns the shared document (if it crashes, the connection reports it and the
// app shows the note read-only). A local document (`text`) whose engine can't load or crashes is shown read-only
// with a notice (fallback.ts).

import type { ImageResolver } from "./images.ts";
import type { ImageUploader } from "./drop.ts";
import { evictWasm, loadWasmEngine } from "./engine.ts";
import type { RustCollab } from "./collab.ts";
import type { EngineFactory } from "./types.ts";
import { RustEditorView, type LinkHandler, type LocalSync } from "./view.ts";
import { COULDNT_START, STOPPED, showFallback } from "./fallback.ts";

export { repoImages, type ImageResolver } from "./images.ts";
export type { ImageUploader } from "./drop.ts";
export type { LinkTarget } from "./links.ts";
export type { LinkHandler } from "./view.ts";

export type EditorOptions = {
  readOnly?: boolean;
  /** Where images load from (default: only http(s) and data:image URLs). */
  images?: ImageResolver;
  /** Opens clicked links (default: external ones in a new tab; `#heading` scrolls in the note either way). */
  onLink?: LinkHandler;
  /** Uploads images dropped or pasted into the note (without it they're ignored). */
  upload?: ImageUploader;
} & (
  | {
      text: string;
      /** The engine to use (default: the wasm build served from /dist/editor-rs/<hash>/). */
      engine?: EngineFactory | Promise<EngineFactory>;
      sync?: LocalSync;
      collab?: undefined;
    }
  | { collab: RustCollab; text?: undefined; engine?: undefined; sync?: undefined }
);

export interface EditorHandle {
  /** Resolves with the view once the engine is loaded (null if it couldn't start, or destroyed). */
  ready: Promise<RustEditorView | null>;
  destroy(): void;
  focus(): void;
  /** The text as the editor last had it (null before the view mounted). */
  text(): string | null;
  /** Scroll to a heading (`#fragment`, decoded) with the caret at its start; false if there's none (or no view yet). */
  scrollToHeading(fragment: string): boolean;
}

export function mountEditor(container: HTMLElement, opts: EditorOptions): EditorHandle {
  if (opts.collab) {
    const v = new RustEditorView(container, { collab: opts.collab, readOnly: opts.readOnly, images: opts.images, onLink: opts.onLink, upload: opts.upload });
    return {
      ready: Promise.resolve(v),
      destroy: () => v.destroy(),
      focus: () => v.focus(),
      text: () => v.doc.text,
      scrollToHeading: (f) => v.scrollToHeading(f),
    };
  }
  const local = opts;
  let view: RustEditorView | null = null;
  let fallback: (() => void) | null = null;
  let destroyed = false;
  let wantFocus = false;
  let lastText = local.text;
  const onCrash = (err: unknown) => {
    console.error("The editor engine crashed.", err);
    if (!local.engine) evictWasm();
    queueMicrotask(() => {
      if (destroyed || fallback) return;
      lastText = view?.doc.text ?? lastText;
      view?.destroy();
      view = null;
      fallback = showFallback(container, lastText, STOPPED);
    });
  };
  const ready = Promise.resolve(local.engine ?? loadWasmEngine()).then(
    (engine) => {
      if (destroyed) return null;
      view = new RustEditorView(container, { text: local.text, sync: local.sync, readOnly: local.readOnly, images: local.images, onLink: local.onLink, upload: local.upload, engine, onCrash });
      if (wantFocus) view.focus();
      return view;
    },
    (err) => {
      console.warn("The editor engine failed to load.", err);
      if (!destroyed) fallback = showFallback(container, local.text, COULDNT_START);
      return null;
    },
  );
  return {
    ready,
    destroy() {
      destroyed = true;
      view?.destroy();
      fallback?.();
    },
    focus() {
      if (view) view.focus();
      else if (!fallback) wantFocus = true;
    },
    text: () => view?.doc.text ?? lastText,
    scrollToHeading: (f) => view?.scrollToHeading(f) ?? false,
  };
}

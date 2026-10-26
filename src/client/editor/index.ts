import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { EditorView } from "./view.ts";
import type { ImageResolver } from "./images.ts";

export { repoImages, type ImageResolver } from "./images.ts";

export interface EditorOptions {
  /** Raw markdown, the source of truth. */
  ytext: Y.Text;
  /** The editor sets/clears the `cursor` field of the local state (see src/shared/presence.ts). */
  awareness: Awareness;
  readOnly?: boolean;
  /** Where images load from (default: only http(s) and data:image URLs; see repoImages in images.ts). */
  images?: ImageResolver;
}

export interface EditorHandle {
  destroy(): void;
  focus(): void;
}

export function mountEditor(container: HTMLElement, opts: EditorOptions): EditorHandle {
  const view = new EditorView(container, opts);
  return {
    destroy: () => view.destroy(),
    focus: () => view.focus(),
  };
}

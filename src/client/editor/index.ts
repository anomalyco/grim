import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { EditorView } from "./view.ts";

export interface EditorOptions {
  /** Raw markdown, the source of truth. */
  ytext: Y.Text;
  /** The editor sets/clears the `cursor` field of the local state (see src/shared/presence.ts). */
  awareness: Awareness;
  readOnly?: boolean;
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

// Remote cursors: other participants' carets and selections drawn in an overlay layer.
// They never affect marker reveal (only the local selection does).

import * as Y from "yjs";
import type { PresenceState } from "../../shared/presence.ts";
import type { EditorView } from "./view.ts";

export class RemoteCursors {
  private frame = 0;

  constructor(private view: EditorView) {}

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private resolve(json: unknown): number | null {
    if (!json) return null;
    try {
      const rel = Y.createRelativePositionFromJSON(json);
      const abs = Y.createAbsolutePositionFromRelativePosition(rel, this.view.ydoc);
      if (!abs || abs.type !== this.view.ytext) return null;
      return Math.min(abs.index, this.view.doc.text.length);
    } catch {
      return null;
    }
  }

  draw(): void {
    const v = this.view;
    const overlay = v.overlay;
    const frag = document.createDocumentFragment();
    const base = v.wrapper.getBoundingClientRect();
    for (const [id, raw] of v.awareness.getStates()) {
      if (id === v.awareness.clientID) continue;
      const st = raw as Partial<PresenceState>;
      if (!st.cursor || !st.user) continue;
      const a = this.resolve(st.cursor.anchor);
      const h = this.resolve(st.cursor.head);
      if (a === null || h === null) continue;
      const color = st.user.color || "#888";
      if (a !== h) {
        for (const r of v.rangeRects(Math.min(a, h), Math.max(a, h))) {
          const d = document.createElement("div");
          d.className = "rsel";
          d.style.cssText = `left:${r.left - base.left}px;top:${r.top - base.top}px;width:${r.width}px;height:${r.height}px;background:${color}`;
          frag.appendChild(d);
        }
      }
      const c = v.caretRect(h);
      if (c.bottom - c.top <= 0) continue;
      const caretEl = document.createElement("div");
      caretEl.className = "rcaret";
      caretEl.style.cssText = `left:${c.left - base.left - 1}px;top:${c.top - base.top}px;height:${c.bottom - c.top}px;background:${color}`;
      const label = document.createElement("div");
      label.className = "rlabel";
      label.textContent = st.user.name || "anonymous";
      label.style.background = color;
      caretEl.appendChild(label);
      frag.appendChild(caretEl);
    }
    overlay.replaceChildren(frag);
  }

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.view.overlay.replaceChildren();
  }
}

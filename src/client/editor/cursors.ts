// Remote cursors: other participants' carets and selections drawn in an overlay layer.
// They never affect marker reveal (only the local selection does).

import * as Y from "yjs";
import type { PresenceState } from "../../shared/presence.ts";
import type { EditorView } from "./view.ts";

const COLOR = /^#[0-9a-f]{3,8}$/i;

function place(el: HTMLElement, left: number, top: number, height: number, color: string): void {
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.style.background = color;
}

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
      const color = typeof st.user.color === "string" && COLOR.test(st.user.color) ? st.user.color : "#888888";
      if (a !== h) {
        for (const r of v.rangeRects(Math.min(a, h), Math.max(a, h))) {
          const d = document.createElement("div");
          d.className = "rsel";
          place(d, r.left - base.left, r.top - base.top, r.height, color);
          d.style.width = `${r.width}px`;
          frag.appendChild(d);
        }
      }
      const c = v.caretRect(h);
      if (c.bottom - c.top <= 0) continue;
      const caretEl = document.createElement("div");
      caretEl.className = "rcaret";
      place(caretEl, c.left - base.left - 1, c.top - base.top, c.bottom - c.top, color);
      const label = document.createElement("div");
      label.className = "rlabel";
      label.textContent = typeof st.user.name === "string" && st.user.name ? st.user.name : "anonymous";
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

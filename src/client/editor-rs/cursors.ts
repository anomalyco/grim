// Remote cursors: other participants' carets and selections drawn in an overlay layer.
// They never affect marker reveal (only the local selection does). A cursor's name label shows for a
// moment after each change of that cursor (and while the pointer is over its caret), then fades out.

import type { Rect } from "./geometry.ts";
import { crashSafe } from "./guard.ts";

/** What the cursor layer needs of an editor view (client coordinates). */
export interface CursorHost {
  wrapper: HTMLElement;
  overlay: HTMLElement;
  /** The remote cursors to draw (resolved by the engine in collab mode). */
  peerCursors(): PeerCursorView[];
  caretRect(pos: number): Rect;
  rangeRects(from: number, to: number): DOMRect[];
}

/** A remote cursor ready to draw: offsets into the text, a valid color, a name (others' only, not our own user's). */
export interface PeerCursorView {
  id: number;
  /** Changes when that participant moves it (shows the name label for a moment). */
  key: string;
  anchor: number;
  head: number;
  name: string;
  color: string;
}

/** How long a name label stays after its cursor last moved. */
export const LABEL_MS = 2000;
/** Pointer distance (px) from a caret that counts as hovering it. */
const HOVER_PX = 5;

function place(el: HTMLElement, left: number, top: number, height: number, color: string): void {
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.style.background = color;
}

export class RemoteCursors {
  private frame = 0;
  /** Per client: last seen cursor (serialized) and when it changed. */
  private seen = new Map<number, { key: string; at: number }>();
  /** Carets of the last draw, in wrapper coordinates. */
  private carets: { id: number; left: number; top: number; bottom: number; label: HTMLElement }[] = [];
  private hover: number | null = null;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private view: CursorHost) {
    view.wrapper.addEventListener("mousemove", this.onMouseMove);
    view.wrapper.addEventListener("mouseleave", this.onMouseLeave);
  }

  private onMouseMove = (e: MouseEvent) => {
    const base = this.view.wrapper.getBoundingClientRect();
    const x = e.clientX - base.left;
    const y = e.clientY - base.top;
    const hit = this.carets.find((c) => Math.abs(x - c.left) <= HOVER_PX && y >= c.top && y <= c.bottom);
    this.setHover(hit ? hit.id : null);
  };

  private onMouseLeave = () => this.setHover(null);

  private setHover(id: number | null): void {
    if (id === this.hover) return;
    const prev = this.hover;
    this.hover = id;
    for (const c of this.carets) if (c.id === prev || c.id === id) c.label.classList.toggle("show", this.visible(c.id));
  }

  private visible(id: number): boolean {
    const s = this.seen.get(id);
    return this.hover === id || (!!s && performance.now() - s.at < LABEL_MS);
  }

  /** Fade the label out once its time is up (unless the cursor moved again or is hovered). */
  private scheduleHide(id: number, at: number): void {
    clearTimeout(this.timers.get(id));
    const wait = at + LABEL_MS - performance.now();
    if (wait <= 0) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        const c = this.carets.find((k) => k.id === id);
        if (c && !this.visible(id)) c.label.classList.remove("show");
      }, wait + 20),
    );
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(
      crashSafe(() => {
        this.frame = 0;
        this.draw();
      }),
    );
  }

  draw(): void {
    const v = this.view;
    const overlay = v.overlay;
    const frag = document.createDocumentFragment();
    const base = v.wrapper.getBoundingClientRect();
    const now = performance.now();
    const carets: typeof this.carets = [];
    const live = new Set<number>();
    for (const { id, key, anchor: a, head: h, name, color } of v.peerCursors()) {
      live.add(id);
      const seen = this.seen.get(id);
      if (!seen || seen.key !== key) {
        this.seen.set(id, { key, at: now });
        this.scheduleHide(id, now);
      }
      if (a < 0 || h < 0) continue;
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
      label.className = this.visible(id) ? "rlabel show" : "rlabel";
      label.textContent = name;
      label.style.background = color;
      caretEl.appendChild(label);
      frag.appendChild(caretEl);
      carets.push({ id, left: c.left - base.left, top: c.top - base.top, bottom: c.bottom - base.top, label });
    }
    overlay.replaceChildren(frag);
    // a label that would run past the pane's right edge goes on the caret's left
    for (const c of carets) if (c.label.getBoundingClientRect().right > base.right) c.label.classList.add("flip");
    this.carets = carets;
    for (const id of this.seen.keys()) {
      if (live.has(id)) continue;
      this.seen.delete(id);
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    }
  }

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const t of this.timers.values()) clearTimeout(t);
    this.view.wrapper.removeEventListener("mousemove", this.onMouseMove);
    this.view.wrapper.removeEventListener("mouseleave", this.onMouseLeave);
    this.view.overlay.replaceChildren();
  }
}

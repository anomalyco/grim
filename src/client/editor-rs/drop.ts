// Images dropped onto a note or pasted into it (a screenshot): uploaded into the notebook, then their Markdown is
// inserted where they were dropped (or at the caret) as one edit, the caret after it, like the native app.
// While image files hover the text a drop caret (a thin accent bar) shows where they'd go; while they upload a
// small "Uploading…" mark sits at that spot, which follows the text as people edit it. Nothing is added to the
// document until the uploads are done (their commits land first, so everyone sees the images at once).

import { crashSafe } from "./guard.ts";
import { REPO_IMAGE_EXT } from "./images.ts";
import type { Edit } from "./types.ts";
import type { RustEditorView } from "./view.ts";

/** What uploads images for a note (the app: POST /api/repos/:id/images). */
export interface ImageUploader {
  /** Upload one image; resolves with the Markdown that shows it in the note (`![name](images/name.png)`). */
  upload(file: File): Promise<string>;
  /** A short message for the person (the app's toasts). */
  notice(message: string, kind?: "info" | "error"): void;
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i;

/** Files the server takes as images (by type, or by name when the browser doesn't know the type). */
export const isImageFile = (f: { type: string; name: string }) => (f.type ? IMAGE_TYPES.test(f.type) : REPO_IMAGE_EXT.test(f.name));

/** Where position `pos` is after `edits` (applied in order). Text deleted around it moves it to the deletion's start. */
export function mapPos(pos: number, edits: Edit[]): number {
  for (const e of edits) {
    if (e.to <= pos && (e.from < pos || e.to < pos)) pos += e.insert.length - (e.to - e.from);
    else if (e.from < pos) pos = e.from;
  }
  return pos;
}

interface Pending {
  from: number;
  to: number;
  label: string;
  el: HTMLElement | null;
}

export class ImageDrops {
  private caretEl: HTMLDivElement | null = null;
  private caretAt: number | null = null;
  private pending = new Set<Pending>();
  private layer: HTMLDivElement;
  private detach: () => void;

  constructor(
    private v: RustEditorView,
    private uploader: ImageUploader,
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "mde-drops";
    this.layer.setAttribute("aria-hidden", "true");
    v.wrapper.appendChild(this.layer);
    const root = v.root;
    const on: [string, (e: DragEvent) => void][] = [
      ["dragenter", this.onDragOver],
      ["dragover", this.onDragOver],
      ["dragleave", this.onDragLeave],
      ["drop", this.onDrop],
    ];
    const fns = on.map(([t, fn]) => [t, crashSafe(fn as EventListener)] as const);
    for (const [t, fn] of fns) root.addEventListener(t, fn);
    // a drag that ends anywhere else (Escape, dropped outside the window) hides the caret
    const end = () => this.showCaret(null);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    this.detach = () => {
      for (const [t, fn] of fns) root.removeEventListener(t, fn);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }

  /** May images go into this note now? */
  private get enabled() {
    return !this.v.readOnly;
  }

  /** The text position under client point (x, y), from the rendered DOM. */
  private hit(x: number, y: number): number | null {
    const [cx, cy] = this.v.layout.fromClient(x, y);
    const p = this.v.layout.hit_test(cx, cy);
    return p === undefined ? null : Math.max(0, Math.min(this.v.doc.text.length, p));
  }

  private onDragOver = (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt || !hasFiles(dt)) return;
    e.preventDefault();
    const images = mayHaveImages(dt);
    if (!this.enabled || !images) {
      dt.dropEffect = "none";
      this.showCaret(null);
      return;
    }
    dt.dropEffect = "copy";
    this.showCaret(this.hit(e.clientX, e.clientY));
  };

  private onDragLeave = (e: DragEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && this.v.root.contains(to)) return;
    this.showCaret(null);
  };

  private onDrop = (e: DragEvent) => {
    const dt = e.dataTransfer;
    this.showCaret(null);
    if (!dt || !hasFiles(dt)) return;
    e.preventDefault();
    if (!this.enabled) return this.uploader.notice("This note is read-only.", "error");
    const at = this.hit(e.clientX, e.clientY);
    if (at === null) return;
    this.add(Array.from(dt.files), at, at);
  };

  /** A paste with image files (and no text of its own): upload them and insert at the selection. */
  paste(e: ClipboardEvent): boolean {
    const cd = e.clipboardData;
    if (!cd) return false;
    const files = Array.from(cd.files ?? []);
    if (!files.length) return false;
    // copying a file elsewhere may put its name in the text; spreadsheet cells come with an image of themselves
    // and their text, which is what's wanted then
    const text = cd.getData("text/plain");
    if (text && !files.some((f) => f.name === text.trim())) return false;
    if (!this.enabled) return true;
    const { anchor, head } = this.v.sel;
    this.add(files, Math.min(anchor, head), Math.max(anchor, head));
    return true;
  }

  /** Upload the image files among `files` and insert their Markdown over [from, to) (followed through edits meanwhile). */
  private add(files: File[], from: number, to: number) {
    const images = files.filter(isImageFile);
    const others = files.filter((f) => !isImageFile(f));
    if (others.length) {
      const names = others.map((f) => f.name || "file").join(", ");
      this.uploader.notice(images.length ? `Skipped ${names}: only images can be added to a note.` : `Only images can be added to a note (${names} isn't one).`, "error");
    }
    if (!images.length) return;
    const p: Pending = { from, to, label: images.length === 1 ? "Uploading…" : `Uploading ${images.length} images…`, el: null };
    this.pending.add(p);
    this.redraw();
    void Promise.allSettled(images.map((f) => this.uploader.upload(f))).then(
      crashSafe((results: PromiseSettledResult<string>[]) => {
        this.pending.delete(p);
        p.el?.remove();
        const md: string[] = [];
        results.forEach((r, i) => {
          if (r.status === "fulfilled") md.push(r.value);
          else this.uploader.notice(`Couldn't upload ${images[i]!.name || "the image"}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`, "error");
        });
        if (!md.length) return;
        if (this.v.destroyed || this.v.readOnly) return this.uploader.notice("The image was uploaded but the note changed before it could be inserted.", "error");
        this.v.insertAt(p.from, p.to, md.join("\n"));
      }),
    );
  }

  /** Text edits (local or remote) happened: pending insert points follow them. */
  mapThrough(edits: Edit[]) {
    if (!edits.length) return;
    for (const p of this.pending) {
      p.from = mapPos(p.from, edits);
      p.to = Math.max(p.from, mapPos(p.to, edits));
    }
    if (this.caretAt !== null) this.caretAt = mapPos(this.caretAt, edits);
  }

  private showCaret(pos: number | null) {
    if (pos === this.caretAt && (pos === null) === !this.caretEl) return;
    this.caretAt = pos;
    if (pos === null) {
      this.caretEl?.remove();
      this.caretEl = null;
      return;
    }
    if (!this.caretEl) {
      this.caretEl = document.createElement("div");
      this.caretEl.className = "drop-caret";
      this.layer.appendChild(this.caretEl);
    }
    this.place(this.caretEl, pos);
  }

  /** Where things are drawn changed (lines re-rendered, edits). */
  redraw() {
    if (this.caretEl && this.caretAt !== null) this.place(this.caretEl, this.caretAt);
    for (const p of this.pending) {
      if (!p.el) {
        p.el = document.createElement("div");
        p.el.className = "drop-pending";
        const label = document.createElement("span");
        label.textContent = p.label;
        p.el.appendChild(label);
        this.layer.appendChild(p.el);
      }
      this.place(p.el, p.from);
    }
  }

  private place(el: HTMLElement, pos: number) {
    const r = this.v.caretRect(pos);
    const base = this.v.wrapper.getBoundingClientRect();
    el.style.left = `${r.left - base.left - 1}px`;
    el.style.top = `${r.top - base.top}px`;
    el.style.height = `${Math.max(0, r.bottom - r.top)}px`;
  }

  destroy() {
    this.detach();
    this.layer.remove();
    this.pending.clear();
  }
}

const hasFiles = (dt: DataTransfer) => Array.from(dt.types ?? []).includes("Files");

/** While dragging, browsers tell the files' types but not their names: unknown types count as maybe images. */
function mayHaveImages(dt: DataTransfer): boolean {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === "file");
  if (!items.length) return true;
  return items.some((i) => !i.type || IMAGE_TYPES.test(i.type));
}

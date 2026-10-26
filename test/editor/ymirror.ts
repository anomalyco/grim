// Test harnesses' LocalSync: mirrors a local editor's text into a Y.Text (the engine's edits go in with a local
// origin; the Y.Text's other changes become remote edits through view.applyRemote) and shows the cursors of
// the Awareness's other clients; our caret is published (relative positions) while the editor is focused.
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { LocalSync, RustEditorView } from "../../src/client/editor-rs/view.ts";
import type { PeerCursorView } from "../../src/client/editor-rs/cursors.ts";
import type { Edit } from "../../src/client/editor-rs/types.ts";
import { deltaToEdits, type DeltaOp } from "../../src/client/editor-rs/edits.ts";

const COLOR = /^#[0-9a-f]{3,8}$/i;

export class YjsMirror implements LocalSync {
  readonly origin = { editor: "mirror" };
  private view: RustEditorView | null = null;
  private pubTimer: ReturnType<typeof setTimeout> | null = null;
  private pubDirty = false;

  constructor(
    readonly ytext: Y.Text,
    readonly awareness: Awareness,
  ) {}

  attach(view: RustEditorView): void {
    this.view = view;
    this.ytext.observe(this.onYText);
    this.awareness.on("change", this.onAwareness);
  }

  detach(): void {
    this.ytext.unobserve(this.onYText);
    this.awareness.off("change", this.onAwareness);
    if (this.pubTimer) clearTimeout(this.pubTimer);
    this.pubTimer = null;
    if (this.awareness.getLocalState()) this.awareness.setLocalStateField("cursor", null);
    this.view = null;
  }

  push(edits: Edit[]): void {
    const ytext = this.ytext;
    ytext.doc!.transact(() => {
      for (const e of edits) {
        if (e.to > e.from) ytext.delete(e.from, e.to - e.from);
        if (e.insert) ytext.insert(e.from, e.insert);
      }
    }, this.origin);
    if (this.view && ytext.length !== this.view.doc.text.length) this.resync(this.view.engine.text());
  }

  /** Make the Y.Text match the engine's text (one replacement of the differing middle). */
  resync(want: string): void {
    const ytext = this.ytext;
    const have = ytext.toString();
    if (want === have) return;
    console.error("ymirror: Y.Text out of sync with the engine; resyncing");
    let a = 0;
    while (a < want.length && a < have.length && want[a] === have[a]) a++;
    let b = 0;
    while (b < want.length - a && b < have.length - a && want[want.length - 1 - b] === have[have.length - 1 - b]) b++;
    ytext.doc!.transact(() => {
      if (have.length - b > a) ytext.delete(a, have.length - b - a);
      if (want.length - b > a) ytext.insert(a, want.slice(a, want.length - b));
    }, this.origin);
  }

  selectionChanged(): void {
    const v = this.view;
    if (!v) return;
    if (!v.hasFocus()) {
      if (this.pubTimer) clearTimeout(this.pubTimer);
      this.pubTimer = null;
      this.pubDirty = false;
      if (this.awareness.getLocalState()?.cursor) this.awareness.setLocalStateField("cursor", null);
      return;
    }
    if (this.pubTimer) {
      this.pubDirty = true;
      return;
    }
    this.publish();
    this.pubTimer = setTimeout(() => {
      this.pubTimer = null;
      if (this.pubDirty) {
        this.pubDirty = false;
        this.publish();
      }
    }, 50);
  }

  /**
   * Relative positions that don't move with text inserted at them by others: a caret sticks to the character
   * before it; a selection's start sticks right and its end left (so it doesn't grow).
   */
  private publish(): void {
    const v = this.view;
    if (!v || !this.awareness.getLocalState() || !v.hasFocus()) return;
    const { anchor, head } = v.sel;
    const rel = (i: number, assoc: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.ytext, i, assoc));
    const collapsed = anchor === head;
    const fwd = anchor <= head;
    this.awareness.setLocalStateField("cursor", { anchor: rel(anchor, collapsed || !fwd ? -1 : 0), head: rel(head, collapsed || fwd ? -1 : 0) });
  }

  peerCursors(): PeerCursorView[] {
    const aw = this.awareness;
    const out: PeerCursorView[] = [];
    // your own cursors from other tabs aren't shown
    const me = (aw.getLocalState() as { user?: { id?: string } } | null)?.user?.id;
    for (const [id, raw] of aw.getStates()) {
      if (id === aw.clientID) continue;
      const st = raw as { cursor?: { anchor: unknown; head: unknown } | null; user?: { id?: string; name?: unknown; color?: unknown } };
      if (!st.cursor || !st.user || (me && st.user.id === me)) continue;
      out.push({
        id,
        key: JSON.stringify(st.cursor),
        anchor: this.resolve(st.cursor.anchor) ?? -1,
        head: this.resolve(st.cursor.head) ?? -1,
        name: typeof st.user.name === "string" && st.user.name ? st.user.name : "anonymous",
        color: typeof st.user.color === "string" && COLOR.test(st.user.color) ? st.user.color : "#888888",
      });
    }
    return out;
  }

  private resolve(json: unknown): number | null {
    if (!json) return null;
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), this.ytext.doc!);
      if (!abs || abs.type !== this.ytext) return null;
      return Math.min(abs.index, this.view?.doc.text.length ?? abs.index);
    } catch {
      return null;
    }
  }

  private onYText = (ev: Y.YTextEvent, tr: Y.Transaction) => {
    if (tr.origin === this.origin) return;
    this.view?.applyRemote(deltaToEdits(ev.delta as DeltaOp[]));
  };

  private onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const me = this.awareness.clientID;
    if ([...added, ...updated, ...removed].some((id) => id !== me)) this.view?.cursorsChanged();
  };
}

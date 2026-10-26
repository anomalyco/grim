// Edits of a session whose engine crashed, kept for the next page load (unsent.ts), turned into text edits on the
// synced document, which the new engine makes as local edits (collab.ts mergeRecovered). Two ways:
// - same room generation: the new connection rebuilds the server's document here (a JS Yjs doc fed the server's
//   sync frames) and applies the kept update on top; Yjs skips what the server already has (edits sent before the
//   crash), so nothing lands twice. Used only if the update integrates completely.
// - otherwise (the room was recreated from Git with other item ids, the update has missing dependencies, or the
//   generation is unknown): a 3-way text merge (shared/textdiff.ts merge3) of the session's change (its starting
//   text → its text at the crash) onto the server's text, which may already contain part of it (saved before).
// Loaded only when there is something to recover (its own chunk, with Yjs).

import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { deltaToEdits, type DeltaOp } from "./edits.ts";
import { merge3 } from "../../shared/textdiff.ts";
import type { KeptEdits } from "./unsent.ts";
import type { Edit } from "./types.ts";

const MSG_SYNC = 0;

export class UnsentEdits {
  private readonly doc = new Y.Doc();

  constructor(readonly kept: KeptEdits) {}

  /** A frame from the server (only sync frames matter). */
  feed(frame: Uint8Array): void {
    if (frame[0] !== MSG_SYNC) return;
    try {
      const dec = decoding.createDecoder(frame);
      decoding.readVarUint(dec);
      sync.readSyncMessage(dec, encoding.createEncoder(), this.doc, "server");
    } catch (err) {
      console.warn("recover: bad sync frame", err);
    }
  }

  /**
   * The kept edits as text edits on `current` (the synced document's text, in room `generation`), in order
   * (possibly none: the server has them all already); null if they can't be placed (both sides changed the same
   * place differently).
   */
  edits(current: string, generation: string | null): Edit[] | null {
    // (an empty update, [0, 0], has nothing to integrate)
    if (this.kept.generation !== null && generation === this.kept.generation && this.kept.update.length > 2) {
      const viaYjs = this.yjsEdits(current);
      if (viaYjs) return viaYjs;
    }
    const splices = merge3(this.kept.base, this.kept.text, current);
    if (!splices) return null;
    // positions in `current`: applied from the end, each stays valid
    return splices.reverse().map((s) => ({ from: s.pos, to: s.pos + s.del, insert: s.ins }));
  }

  /** The update applied to the server's document: its change, or null if it doesn't integrate completely. */
  private yjsEdits(current: string): Edit[] | null {
    const text = this.doc.getText("md");
    if (text.toString() !== current) return null;
    const out: Edit[] = [];
    const onChange = (ev: Y.YTextEvent) => out.push(...deltaToEdits(ev.delta as DeltaOp[]));
    text.observe(onChange);
    try {
      Y.applyUpdate(this.doc, this.kept.update, "recovered");
    } catch (err) {
      console.warn("recover: the kept update doesn't apply", err);
      return null;
    } finally {
      text.unobserve(onChange);
    }
    // items or deletions waiting for structs the server doesn't have: not this document's history
    if (this.doc.store.pendingStructs || this.doc.store.pendingDs) return null;
    return out;
  }
}

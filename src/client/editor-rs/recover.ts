// Edits of a session whose engine crashed (Engine.recover_unsent: a Yjs update), kept for the next page load
// (unsent.ts). After the reload, the new connection rebuilds the server's document here (a JS Yjs doc fed the
// server's sync frames), applies the update on top of it and turns the change into text edits, which the new
// engine makes as local edits (collab.ts mergeRecovered). Loaded only when there is something to recover (its
// own chunk, with Yjs).

import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { deltaToEdits, type DeltaOp } from "./edits.ts";
import type { Edit } from "./types.ts";

const MSG_SYNC = 0;

export class UnsentEdits {
  private readonly doc = new Y.Doc();

  constructor(private readonly update: Uint8Array) {}

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
   * The kept edits as text edits on `current` (the synced document's text), in order; null if the document
   * rebuilt here doesn't have that text (then they can't be placed).
   */
  edits(current: string): Edit[] | null {
    const text = this.doc.getText("md");
    if (text.toString() !== current) return null;
    const out: Edit[] = [];
    const onChange = (ev: Y.YTextEvent) => out.push(...deltaToEdits(ev.delta as DeltaOp[]));
    text.observe(onChange);
    try {
      Y.applyUpdate(this.doc, this.update, "recovered");
    } finally {
      text.unobserve(onChange);
    }
    return out;
  }
}

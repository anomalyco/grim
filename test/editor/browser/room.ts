// An in-page Grimoire room for the Rust engine's collab mode (harness.ts `?collab`): a JS Yjs doc that talks
// the server's WebSocket protocol (hello, sync, awareness relay) to a RustCollab through a fake socket. The doc
// doubles as "the other client": edits to its text and its awareness reach the editor as remote changes.
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { SocketLike } from "../../../src/client/editor-rs/collab.ts";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_CONTROL = 2;
const FROM_CLIENT = Symbol("client");

export class FakeRoom {
  /** The client's presence as the room knows it. */
  readonly clientAw: awarenessProtocol.Awareness;
  /** Sent in hello: change it to simulate a recreated room. */
  generation = "g1";
  private sock: FakeSocket | null = null;

  constructor(
    readonly doc: Y.Doc,
    readonly aw: awarenessProtocol.Awareness,
    readonly readOnly = false,
    /** Client frames reach the room in a later task (like a real socket; perf runs), not synchronously. */
    readonly asyncUp = false,
  ) {
    this.clientAw = new awarenessProtocol.Awareness(new Y.Doc());
    this.clientAw.setLocalState(null);
    doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === FROM_CLIENT) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeUpdate(e, u);
      this.toClient(encoding.toUint8Array(e));
    });
    aw.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      this.toClient(awFrame(awarenessProtocol.encodeAwarenessUpdate(aw, [...added, ...updated, ...removed])));
    });
  }

  /** The client's own awareness state (its cursor while focused). */
  clientState(): { cursor?: unknown } | null {
    for (const [, st] of this.clientAw.getStates()) if (st) return st;
    return null;
  }

  connect(): SocketLike {
    const s = new FakeSocket((f) => (this.asyncUp ? setTimeout(() => this.fromClient(f)) : this.fromClient(f)));
    this.sock = s;
    queueMicrotask(() => {
      const hello = { t: "hello", generation: this.generation, readOnly: this.readOnly, dirty: false, saving: false, commit: null, savedAt: null };
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_CONTROL);
      encoding.writeVarString(e, JSON.stringify(hello));
      this.toClient(encoding.toUint8Array(e));
      const e2 = encoding.createEncoder();
      encoding.writeVarUint(e2, MSG_SYNC);
      syncProtocol.writeSyncStep1(e2, this.doc);
      this.toClient(encoding.toUint8Array(e2));
      const ids = [...this.aw.getStates().keys()];
      if (ids.length) this.toClient(awFrame(awarenessProtocol.encodeAwarenessUpdate(this.aw, ids)));
    });
    return s;
  }

  private toClient(frame: Uint8Array): void {
    const s = this.sock;
    if (!s || s.readyState !== 1) return;
    // like a socket: delivered after the current task's synchronous work
    queueMicrotask(() => s.readyState === 1 && s.onmessage?.({ data: frame.slice().buffer }));
  }

  private fromClient(frame: Uint8Array): void {
    const d = decoding.createDecoder(frame);
    const t = decoding.readVarUint(d);
    if (t === MSG_SYNC) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      const sub = decoding.peekVarUint(d);
      if (this.readOnly && sub !== syncProtocol.messageYjsSyncStep1) throw new Error("a read-only client sent an update");
      syncProtocol.readSyncMessage(d, e, this.doc, FROM_CLIENT);
      if (encoding.length(e) > 1) this.toClient(encoding.toUint8Array(e));
    } else if (t === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.clientAw, decoding.readVarUint8Array(d), FROM_CLIENT);
    }
  }
}

function awFrame(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_AWARENESS);
  encoding.writeVarUint8Array(e, update);
  return encoding.toUint8Array(e);
}

class FakeSocket implements SocketLike {
  binaryType = "arraybuffer";
  readyState = 1;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(private up: (f: Uint8Array) => void) {}
  send(data: Uint8Array): void {
    if (this.readyState === 1) this.up(data.slice());
  }
  close(): void {
    this.readyState = 3;
  }
}

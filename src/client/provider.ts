// WebSocket provider for one file: y-protocols sync + awareness + JSON control messages.
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Emitter } from "./emitter.ts";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_CONTROL = 2;

export type ConnStatus = "connecting" | "connected" | "disconnected";

export interface SaveState {
  dirty: boolean;
  saving: boolean;
  commit: string | null;
  savedAt: number | null;
}

export type ClosedReason = "deleted" | "renamed" | "removed" | "unauthorized" | "forbidden" | "notfound" | "toolarge" | string;

type Events = {
  status: [ConnStatus];
  synced: [];
  saveState: [SaveState];
  closed: [ClosedReason, string | undefined];
  reset: [];
  external: [string | null];
  readOnly: [boolean];
};

type Control =
  | ({ t: "hello"; generation: string; readOnly: boolean } & SaveState)
  | ({ t: "status" } & SaveState)
  | { t: "external"; commit: string | null }
  | { t: "closed"; reason: string; to?: string };

// Close codes that end the session. Anything else (including 1013 "try again later": repo not ready,
// room closing during the upgrade) reconnects with backoff.
const STOP_CODES: Record<number, ClosedReason> = { 4401: "unauthorized", 4403: "forbidden", 4404: "notfound", 4413: "toolarge" };

export class GrimoireProvider extends Emitter<Events> {
  readonly awareness: awarenessProtocol.Awareness;
  status: ConnStatus = "disconnected";
  synced = false;
  readOnly = false;
  saveState: SaveState = { dirty: false, saving: false, commit: null, savedAt: null };
  generation: string | null = null;

  private ws: WebSocket | null = null;
  private helloSeen = false;
  private stopped = false;
  private backoff = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closedInfo: { reason: string; to?: string } | null = null;
  /** Local edits the server hasn't received yet (made while disconnected). */
  private unsent = false;

  constructor(
    readonly doc: Y.Doc,
    readonly repo: string,
    readonly path: string,
  ) {
    super();
    this.awareness = new awarenessProtocol.Awareness(doc);
    doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    window.addEventListener("online", this.onOnline);
    this.connect();
  }

  /** Ask the server to commit now. */
  flush() {
    this.sendControl({ t: "flush" });
  }

  destroy() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    window.removeEventListener("online", this.onOnline);
    // Tell the others we left (sent by onAwarenessUpdate while the socket is still open).
    if (this.awareness.getLocalState() !== null) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    }
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.closeSocket();
    this.awareness.destroy();
    this.clear();
  }

  private connect() {
    if (this.stopped) return;
    this.setStatus("connecting");
    this.helloSeen = false;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = new URLSearchParams({ repo: this.repo, path: this.path });
    const ws = new WebSocket(`${proto}//${location.host}/ws?${qs}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws || this.stopped) return;
      this.onMessage(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClose(ev.code, ev.reason);
    };
    ws.onerror = () => {};
  }

  private closeSocket() {
    const ws = this.ws;
    this.ws = null;
    this.helloSeen = false;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
    this.removeRemoteAwareness();
    this.setStatus("disconnected");
  }

  private onClose(code: number, reason: string) {
    this.helloSeen = false;
    this.removeRemoteAwareness();
    this.setStatus("disconnected");
    if (this.stopped) return;
    if (code === 4000 || this.closedInfo) {
      const info = this.closedInfo ?? { reason: reason || "removed" };
      this.stopped = true;
      this.emit("closed", info.reason, info.to);
      return;
    }
    const stop = STOP_CODES[code];
    if (stop) {
      this.stopped = true;
      this.emit("closed", stop, reason || undefined);
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10_000);
  }

  private onOnline = () => {
    if (this.retryTimer && !this.stopped) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.backoff = 500;
      this.connect();
    }
  };

  private onMessage(data: Uint8Array) {
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_CONTROL) {
      this.onControl(JSON.parse(decoding.readVarString(dec)) as Control);
      return;
    }
    // Nothing else is trusted until hello confirms we're talking to the same room generation.
    if (!this.helloSeen) return;
    if (type === MSG_SYNC) {
      if (this.readOnly) {
        // Read-only: take the server's state, never answer step1 with our own contents.
        const sub = decoding.readVarUint(dec);
        if (sub === syncProtocol.messageYjsSyncStep2 || sub === syncProtocol.messageYjsUpdate) {
          syncProtocol.readSyncStep2(dec, this.doc, this);
          if (sub === syncProtocol.messageYjsSyncStep2) this.markSynced();
        }
        return;
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const sub = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
      if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
      // Our step2 reply to the server's step1 carries everything we had offline.
      if (sub === syncProtocol.messageYjsSyncStep1) this.unsent = false;
      if (sub === syncProtocol.messageYjsSyncStep2) this.markSynced();
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
    }
  }

  private markSynced() {
    if (this.synced) return;
    this.synced = true;
    this.emit("synced");
  }

  private onControl(msg: Control) {
    switch (msg.t) {
      case "hello": {
        // A recreated room can't absorb our doc, and a read-only connection would silently drop our
        // offline edits: either way the app must start over with a fresh doc.
        if ((this.generation !== null && msg.generation !== this.generation) || (msg.readOnly && this.unsent)) {
          this.stopped = true;
          this.closeSocket();
          this.emit("reset");
          return;
        }
        this.generation = msg.generation;
        this.helloSeen = true;
        this.backoff = 500;
        if (msg.readOnly !== this.readOnly) {
          this.readOnly = msg.readOnly;
          this.emit("readOnly", msg.readOnly);
        }
        this.setSaveState(msg);
        this.setStatus("connected");
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeSyncStep1(enc, this.doc);
        this.send(encoding.toUint8Array(enc));
        // Re-announce with a bumped clock so the server doesn't drop it as stale.
        const local = this.awareness.getLocalState();
        if (local !== null) this.awareness.setLocalState(local);
        break;
      }
      case "status":
        this.setSaveState(msg);
        break;
      case "external":
        this.emit("external", msg.commit);
        break;
      case "closed":
        this.closedInfo = { reason: msg.reason, to: msg.to };
        break;
    }
  }

  private setSaveState(s: SaveState) {
    this.saveState = { dirty: s.dirty, saving: s.saving, commit: s.commit, savedAt: s.savedAt };
    this.emit("saveState", this.saveState);
  }

  private setStatus(s: ConnStatus) {
    if (s === this.status) return;
    this.status = s;
    this.emit("status", s);
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    if (this.readOnly) return;
    if (!this.helloSeen || this.ws?.readyState !== WebSocket.OPEN) {
      this.unsent = true;
      return;
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    this.send(encoding.toUint8Array(enc));
  };

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    // Only ever announce our own client; remote changes (incl. timeouts) are the server's business.
    if (origin !== "local" || !this.helloSeen) return;
    const me = this.doc.clientID;
    if (![...added, ...updated, ...removed].includes(me)) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [me]));
    this.send(encoding.toUint8Array(enc));
  };

  private sendControl(msg: object) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_CONTROL);
    encoding.writeVarString(enc, JSON.stringify(msg));
    this.send(encoding.toUint8Array(enc));
  }

  private send(data: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data as Uint8Array<ArrayBuffer>);
  }

  private removeRemoteAwareness() {
    const remote = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (remote.length) awarenessProtocol.removeAwarenessStates(this.awareness, remote, this);
    // Forget their clocks too, so the states the server sends after a reconnect aren't dropped as stale.
    for (const id of [...this.awareness.meta.keys()]) if (id !== this.doc.clientID) this.awareness.meta.delete(id);
  }
}

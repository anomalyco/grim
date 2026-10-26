// The Rust engine owning the shared document (src/client/editor-rs/collab.ts RustCollab + RustEditorView in collab
// mode) against an in-page room (test/editor/browser/room.ts): sync, local edits reaching the room, remote edits
// patching the DOM, presence, read-only, reconnect, reset, leave. Needs the wasm package (skipped otherwise).
import { installDom } from "./dom.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { RustCollab, type CollabFactory, type SocketLike } from "../../../src/client/editor-rs/collab.ts";
import { RustEditorView } from "../../../src/client/editor-rs/view.ts";
import type { CollabEngine } from "../../../src/client/editor-rs/types.ts";
import { FakeRoom } from "../browser/room.ts";

const pkg = new URL("../../../src/client/editor-rs/pkg/", import.meta.url);
let factory: CollabFactory | null = null;
if (existsSync(new URL("editor_wasm_bg.wasm", pkg))) {
  const path: string = new URL("editor_wasm.js", pkg).pathname;
  const m = await import(path);
  m.initSync({ module: readFileSync(new URL("editor_wasm_bg.wasm", pkg)) });
  factory = (id: number, user: object) => m.Engine.collab(id, user) as CollabEngine;
}
const t = factory ? test : test.skip;
installDom();
const tick = () => new Promise((r) => setTimeout(r, 5));
const user = { id: "a", name: "Alice", color: "#d63b3b", kind: "human" };

function setup(text: string, opts: { readOnly?: boolean } = {}) {
  const doc = new Y.Doc();
  const ytext = doc.getText("md");
  ytext.insert(0, text);
  const aw = new Awareness(doc);
  aw.setLocalState({ user: { id: "b", name: "Bob", color: "#2f7de1", kind: "human" }, cursor: null });
  const room = new FakeRoom(doc, aw, opts.readOnly);
  const sockets: SocketLike[] = [];
  const conn = new RustCollab(factory!, "r", "p.md", user, {
    socket: () => {
      const s = room.connect();
      sockets.push(s);
      return s;
    },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  let view: RustEditorView | null = null;
  const mount = () => (view = new RustEditorView(host, { collab: conn, readOnly: conn.readOnly }));
  const domText = () => Array.from(view!.root.children).map((d) => d.textContent).join("\n");
  return { doc, ytext, aw, room, conn, sockets, mount, domText, view: () => view!, destroy: () => (view?.destroy(), conn.destroy(), host.remove()) };
}

describe("RustCollab", () => {
  t("syncs, sends local edits, applies remote edits", async () => {
    const s = setup("# Title\nhello world");
    const events: string[] = [];
    s.conn.on("status", (st) => events.push(st));
    s.conn.on("synced", () => events.push("synced"));
    await tick();
    expect(s.conn.status).toBe("connected");
    expect(s.conn.synced).toBe(true);
    expect(events).toEqual(["connected", "synced"]);
    const v = s.mount();
    expect(v.engine.text()).toBe("# Title\nhello world");
    v.setSel({ anchor: 19, head: 19 });
    v.apply(v.engine.insert_text("!"));
    await tick();
    expect(s.ytext.toString()).toBe("# Title\nhello world!");
    // a remote edit patches the DOM and maps the caret
    s.ytext.insert(8, ">> ");
    await tick();
    expect(v.engine.text()).toBe("# Title\n>> hello world!");
    expect(v.doc.text).toBe("# Title\n>> hello world!");
    expect(s.domText().split("\n")[1]).toBe(">> hello world!");
    expect(v.sel).toEqual({ anchor: 23, head: 23 });
    s.destroy();
  });

  t("presence: remote cursors drawn from the engine, ours only while focused", async () => {
    const s = setup("abc def");
    await tick();
    const v = s.mount();
    s.aw.setLocalStateField("cursor", {
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(s.ytext, 4)),
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(s.ytext, 6)),
    });
    await tick();
    expect(v.peerCursors()).toEqual([expect.objectContaining({ anchor: 4, head: 6, name: "Bob", color: "#2f7de1" })]);
    expect(s.conn.peerStates().length).toBe(1);
    expect(s.room.clientState()?.cursor ?? null).toBe(null);
    v.setPresence(true);
    v.setSel({ anchor: 2, head: 2 });
    await new Promise((r) => setTimeout(r, 80));
    expect(s.room.clientState()?.cursor).toBeTruthy();
    v.setPresence(false);
    await tick();
    expect(s.room.clientState()?.cursor ?? null).toBe(null);
    s.destroy();
    await tick();
    // leaving sends a null state
    expect(s.room.clientState()).toBe(null);
  });

  t("read-only room: the view is read-only and nothing is sent", async () => {
    const s = setup("read me", { readOnly: true });
    const ro: boolean[] = [];
    s.conn.on("readOnly", (r) => ro.push(r));
    await tick();
    expect(ro).toEqual([true]);
    const v = s.mount();
    expect(v.readOnly).toBe(true);
    expect(v.root.contentEditable).toBe("false");
    v.apply(v.engine.insert_text("x"));
    await tick();
    expect([v.engine.text(), s.ytext.toString()]).toEqual(["read me", "read me"]);
    s.ytext.insert(0, "please ");
    await tick();
    expect(s.domText()).toBe("please read me");
    s.destroy();
  });

  t("reconnects after a drop, sending offline edits; a new generation resets", async () => {
    const s = setup("one");
    await tick();
    const v = s.mount();
    const statuses: string[] = [];
    s.conn.on("status", (st) => statuses.push(st));
    const sock = s.sockets[0]!;
    (sock as { readyState: number }).readyState = 3;
    sock.onclose?.({ code: 1006, reason: "" });
    expect(s.conn.status).toBe("disconnected");
    v.setSel({ anchor: 3, head: 3 });
    v.apply(v.engine.insert_text(" two"));
    s.ytext.insert(0, "zero ");
    await new Promise((r) => setTimeout(r, 600));
    expect(statuses).toEqual(["disconnected", "connecting", "connected"]);
    expect([v.engine.text(), s.ytext.toString()]).toEqual(["zero one two", "zero one two"]);
    // the room comes back with another generation: "reset"
    let reset = false;
    s.conn.on("reset", () => (reset = true));
    s.room.generation = "g2";
    (s.sockets[1] as { readyState: number }).readyState = 3;
    s.sockets[1]!.onclose?.({ code: 1012, reason: "" });
    await new Promise((r) => setTimeout(r, 1200));
    expect(reset).toBe(true);
    expect(s.conn.status).toBe("disconnected");
    s.destroy();
  });
});

// Protocol v2: RustCollab on a workspace socket (src/client/wsclient.ts) against a fake multiplexer
// (test/editor/browser/mux.ts) whose channels are in-page rooms. Notes share one socket; a drop re-opens every
// channel and nothing typed meanwhile is lost; `end 1013` re-opens; a new generation resets; hidden channels send no
// awareness; welcome / renew set the engine's awareness timing; workspace events. Needs the wasm package.
import { installDom } from "./dom.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { RustCollab, awarenessFrame, readAwareness, type CollabEvents, type CollabFactory } from "../../../src/client/editor-rs/collab.ts";
import { RustEditorView } from "../../../src/client/editor-rs/view.ts";
import type { CollabEngine } from "../../../src/client/editor-rs/types.ts";
import { WsClient } from "../../../src/client/wsclient.ts";
import type { WorkspaceEventMsg } from "../../../src/shared/wsmux.ts";
import { FakeRoom } from "../browser/room.ts";
import { FakeMux } from "../browser/mux.ts";

const pkg = new URL("../../../src/client/editor-rs/pkg/", import.meta.url);
let factory: CollabFactory | null = null;
if (existsSync(new URL("editor_wasm_bg.wasm", pkg))) {
  const m = await import(new URL("editor_wasm.js", pkg).pathname);
  m.initSync({ module: readFileSync(new URL("editor_wasm_bg.wasm", pkg)) });
  factory = (id: number, user: object) => m.Engine.collab(id, user) as CollabEngine;
}
const t = factory ? test : test.skip;
installDom();
const user = { id: "a", name: "Alice", color: "#d63b3b", kind: "human" };

function room(mux: FakeMux, path: string, text: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText("md");
  ytext.insert(0, text);
  const aw = new Awareness(doc);
  aw.setLocalState({ user: { id: "b", name: "Bob", color: "#2f7de1", kind: "human" }, cursor: null });
  const r = new FakeRoom(doc, aw);
  mux.rooms.set(path, r);
  return { doc, ytext, room: r };
}

/** Resolves on the collab's next `type` event. */
function next<K extends keyof CollabEvents>(c: RustCollab, type: K): Promise<CollabEvents[K]> {
  return new Promise((resolve) => {
    const off = c.on(type, (...args) => {
      off();
      resolve(args);
    });
  });
}

/** Resolves when the collab's status becomes `s`. */
function status(c: RustCollab, s: string): Promise<void> {
  return new Promise((resolve) => {
    const off = c.on("status", (st) => {
      if (st !== s) return;
      off();
      resolve();
    });
  });
}

/** Resolves when the room's doc changes so that `cond` holds. */
function docUntil(doc: Y.Doc, cond: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (cond()) return resolve();
    const on = () => {
      if (!cond()) return;
      doc.off("update", on);
      resolve();
    };
    doc.on("update", on);
  });
}

/** Resolves when the room's view of the client's awareness satisfies `cond`. */
function awUntil(r: FakeRoom, cond: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (cond()) return resolve();
    const on = () => {
      if (!cond()) return;
      r.clientAw.off("change", on);
      resolve();
    };
    r.clientAw.on("change", on);
  });
}

function collab(ws: WsClient, path: string, hidden = false) {
  return new RustCollab(factory!, "w", path, user, { workspace: ws, hidden });
}

function edit(c: RustCollab, at: number, s: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const v = new RustEditorView(host, { collab: c });
  v.setSel({ anchor: at, head: at });
  v.apply(v.engine.insert_text(s));
  v.destroy();
  host.remove();
}

describe("RustCollab on a workspace socket (v2)", () => {
  t("two notes share one socket; a switch is an open, not a connection", async () => {
    const mux = new FakeMux();
    const a = room(mux, "a.md", "note a");
    const b = room(mux, "b.md", "note b");
    const ws = new WsClient("w", { socket: mux.connect });
    const ca = collab(ws, "a.md");
    await next(ca, "synced");
    expect(ca.engine.text()).toBe("note a");
    const cb = collab(ws, "b.md");
    await next(cb, "synced");
    expect(cb.engine.text()).toBe("note b");
    expect(mux.sockets.length).toBe(1);
    expect(mux.received.filter((m) => m.t === "open").map((m) => (m as { path: string }).path)).toEqual(["a.md", "b.md"]);
    edit(cb, 6, "!");
    await docUntil(b.doc, () => b.ytext.toString() === "note b!");
    expect(a.ytext.toString()).toBe("note a");
    // closing a note closes its channel only
    ca.destroy();
    await mux.until(() => mux.received.some((m) => m.t === "close"));
    expect([...mux.socket.channels.values()].map((c) => c.path)).toEqual(["b.md"]);
    cb.destroy();
    ws.close();
  });

  t("a drop re-opens every channel in one flight, with offline edits", async () => {
    const mux = new FakeMux();
    const a = room(mux, "a.md", "aaa");
    const b = room(mux, "b.md", "bbb");
    const ws = new WsClient("w", { socket: mux.connect });
    const ca = collab(ws, "a.md");
    const cb = collab(ws, "b.md", true);
    await Promise.all([next(ca, "synced"), next(cb, "synced")]);
    const down = next(ca, "status");
    mux.socket.drop();
    expect(await down).toEqual(["disconnected"]);
    // typed while offline
    edit(ca, 3, " offline");
    const opensBefore = mux.received.length;
    const back = status(ca, "connected");
    window.dispatchEvent(new Event("online"));
    await back;
    await docUntil(a.doc, () => a.ytext.toString() === "aaa offline");
    expect(mux.sockets.length).toBe(2);
    const reopened = mux.received.slice(opensBefore);
    expect(reopened.map((m) => [m.t, (m as { path?: string }).path, (m as { hidden?: boolean }).hidden ?? false])).toEqual([
      ["open", "a.md", false],
      ["open", "b.md", true],
    ]);
    expect(reopened.every((m) => m.t === "open" && typeof m.sv === "string")).toBe(true);
    expect(b.ytext.toString()).toBe("bbb");
    ca.destroy();
    cb.destroy();
    ws.close();
  });

  t("end 1013 re-opens the channel; a new generation resets the note", async () => {
    const mux = new FakeMux();
    const a = room(mux, "a.md", "hello");
    const ws = new WsClient("w", { socket: mux.connect });
    const ca = collab(ws, "a.md");
    await next(ca, "synced");
    edit(ca, 5, " there");
    await docUntil(a.doc, () => a.ytext.toString() === "hello there");
    const back = status(ca, "connected");
    mux.socket.end("a.md", 1013, "closed meanwhile");
    await back;
    expect(ca.live).toBe(true);
    expect(mux.socket.chOf("a.md")).toBe(2);
    // the room was recreated: the engine starts over
    a.room.generation = "g2";
    const reset = next(ca, "reset");
    mux.socket.end("a.md", 1013, "reset");
    await reset;
    expect(ca.live).toBe(false);
    ca.destroy();
    ws.close();
  });

  t("hidden channels send no awareness; showing announces, hiding clears", async () => {
    const mux = new FakeMux();
    const a = room(mux, "a.md", "abc");
    const ws = new WsClient("w", { socket: mux.connect });
    const ca = collab(ws, "a.md", true);
    await next(ca, "synced");
    // Bob's presence still reaches a hidden channel
    expect(ca.peerStates().length).toBe(1);
    expect(a.room.clientState()).toBe(null);
    ca.setHidden(false);
    await awUntil(a.room, () => a.room.clientState() !== null);
    expect(mux.received.at(-1)).toEqual({ t: "view", ch: 1, hidden: false });
    ca.setHidden(true);
    await awUntil(a.room, () => a.room.clientState() === null);
    expect(mux.received.at(-1)).toEqual({ t: "view", ch: 1, hidden: true });
    // and shown again (the engine gets ahead of the null's clock)
    ca.setHidden(false);
    await awUntil(a.room, () => a.room.clientState() !== null);
    ca.destroy();
    ws.close();
  });

  t("welcome's awareness timing, and renew", async () => {
    const mux = new FakeMux();
    room(mux, "a.md", "x");
    const ws = new WsClient("w", { socket: mux.connect });
    const ca = collab(ws, "a.md");
    await next(ca, "synced");
    const timing = () => [...(ca.engine as unknown as { awareness_timing(): Float64Array }).awareness_timing()];
    expect(timing()).toEqual([300_000, 720_000]);
    mux.socket.renew("a.md", 15_000);
    await new Promise<void>((r) => queueMicrotask(() => queueMicrotask(r)));
    expect(timing()).toEqual([15_000, 720_000]);
    ca.destroy();
    ws.close();
  });

  t("open errors map like v1 close codes; workspace events reach listeners", async () => {
    const mux = new FakeMux();
    const ws = new WsClient("w", { socket: mux.connect });
    const events: WorkspaceEventMsg[] = [];
    ws.onEvent((e) => events.push(e));
    const cx = collab(ws, "missing.md");
    expect(await next(cx, "closed")).toEqual(["notfound", "not found"]);
    mux.socket.event({ t: "tree", head: "abc" });
    mux.socket.event({ t: "presence", path: "a.md", users: [] });
    mux.socket.event({ t: "saved", path: "a.md", sha: "s1" });
    await new Promise<void>((r) => queueMicrotask(() => queueMicrotask(r)));
    expect(events.map((e) => e.t)).toEqual(["tree", "presence", "saved"]);
    cx.destroy();
    ws.close();
  });

  t("pings, and reconnect when the server closes the socket", async () => {
    const mux = new FakeMux();
    mux.welcome = { ...mux.welcome, pingMs: 1 };
    room(mux, "a.md", "x");
    const ws = new WsClient("w", { socket: mux.connect });
    const ca = collab(ws, "a.md");
    await next(ca, "synced");
    await mux.until(() => mux.pings >= 2);
    const reconnects: boolean[] = [];
    ws.onWelcome((_, r) => reconnects.push(r));
    mux.socket.drop(1012, "restart");
    await status(ca, "disconnected");
    const back = status(ca, "connected");
    window.dispatchEvent(new Event("online"));
    await back;
    expect(reconnects).toEqual([true]);
    // a final close (workspace removed) ends every channel
    const closed = next(ca, "closed");
    mux.socket.drop(4404, "");
    expect((await closed)[0]).toBe("notfound");
    ca.destroy();
    ws.close();
  });
});

describe("awareness frames", () => {
  test("encode / read our entry", () => {
    const f = awarenessFrame(300, 7, "null");
    expect(readAwareness(f, 300)).toEqual({ clock: 7, removed: true });
    expect(readAwareness(f, 1)).toBe(null);
    expect(readAwareness(awarenessFrame(2 ** 31, 200, '{"user":{}}'), 2 ** 31)).toEqual({ clock: 200, removed: false });
  });
});

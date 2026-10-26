// Crash recovery: the 3-way text merge (shared/textdiff.ts merge3), UnsentEdits (recover.ts: Yjs merge in the same
// room generation, text merge otherwise, nothing inserted twice), the kept-edits store (unsent.ts), RustCollab
// merging kept edits after sync (new generation, conflicts), and engine traps at input entry points.
import { installDom } from "./dom.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import { Awareness } from "y-protocols/awareness";
import { applySplices, merge3 } from "../../../src/shared/textdiff.ts";
import { UnsentEdits } from "../../../src/client/editor-rs/recover.ts";
import { forgetAllUnsent, forgetUnsent, keepUnsent, keptUnsent, type KeptEdits } from "../../../src/client/editor-rs/unsent.ts";
import { applyEdits } from "../../../src/client/editor-rs/edits.ts";
import { RustCollab, type CollabFactory, type SocketLike } from "../../../src/client/editor-rs/collab.ts";
import { RustEditorView } from "../../../src/client/editor-rs/view.ts";
import type { CollabEngine } from "../../../src/client/editor-rs/types.ts";
import { FakeRoom } from "../browser/room.ts";

installDom();

const pkg = new URL("../../../src/client/editor-rs/pkg/", import.meta.url);
let factory: CollabFactory | null = null;
if (existsSync(new URL("editor_wasm_bg.wasm", pkg))) {
  const m = await import(new URL("editor_wasm.js", pkg).pathname);
  m.initSync({ module: readFileSync(new URL("editor_wasm_bg.wasm", pkg)) });
  factory = Object.assign((id: number, user: object) => m.Engine.collab(id, user) as CollabEngine, {
    recover: (id: number) => m.Engine.recover_unsent(id) as Uint8Array | undefined,
  });
}
const tw = factory ? test : test.skip;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const user = { id: "a", name: "Alice", color: "#d63b3b", kind: "human" };

const merged = (base: string, ours: string, theirs: string) => {
  const s = merge3(base, ours, theirs);
  return s && applySplices(theirs, s);
};

describe("merge3", () => {
  test("changes on one side only", () => {
    expect(merged("a\nb\nc\n", "a!\nb\nc\n", "a\nb\nc?\n")).toBe("a!\nb\nc?\n");
    expect(merged("a\nb\n", "a\nb\n", "x\nb\n")).toBe("x\nb\n");
    expect(merged("a\nb\n", "b\n", "a\nb\nc\n")).toBe("b\nc\n");
  });
  test("the same change on both sides lands once", () => {
    expect(merged("", "hi", "hi")).toBe("hi");
    expect(merged("alpha\n", "alpha (x)\n", "alpha (x)\n")).toBe("alpha (x)\n");
  });
  test("theirs has part of our edit (saved before the crash): only the rest is added", () => {
    expect(merged("", "hello world", "hello")).toBe("hello world");
    expect(merged("alpha\nbeta\n", "alpha one two\nbeta\n", "alpha one\nbeta (bob)\n")).toBe("alpha one two\nbeta (bob)\n");
  });
  test("someone typed into our edit: theirs kept", () => {
    expect(merged("a\n", "a hello\n", "a hel-lo\n")).toBe("a hel-lo\n");
  });
  test("different insertions at the same place: both kept", () => {
    expect(merged("a\n", "a\nx\n", "a\ny\n")).toBe("a\ny\nx\n");
  });
  test("the same text replaced differently: conflict", () => {
    expect(merge3("one two three\n", "one 2 three\n", "one TWO three\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

/** The server's sync step2 (its whole state) as the frame the client receives. */
function step2(doc: Y.Doc): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  syncProtocol.writeSyncStep2(e, doc);
  return encoding.toUint8Array(e);
}

/** A client session on `server`'s document: its local updates collected like Engine.recover_unsent. */
function session(server: Y.Doc) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  const mine: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && mine.push(u));
  const text = doc.getText("md");
  return {
    text,
    /** Send what we did so far to the server. */
    send: () => Y.applyUpdate(server, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(server)), "remote"),
    update: () => Y.mergeUpdates(mine),
  };
}

function docWith(text: string): Y.Doc {
  const d = new Y.Doc();
  d.getText("md").insert(0, text);
  return d;
}

function recoverInto(server: Y.Doc, kept: KeptEdits, generation: string | null): string | null {
  const u = new UnsentEdits(kept);
  u.feed(step2(server));
  const current = server.getText("md").toString();
  const edits = u.edits(current, generation);
  return edits && applyEdits(current, edits);
}

describe("UnsentEdits", () => {
  test("same generation: edits the server already has aren't applied again", () => {
    const server = docWith("alpha\nbeta\n");
    const s = session(server);
    const base = s.text.toString();
    s.text.insert(5, " one");
    s.send();
    s.text.insert(9, " two"); // unsent
    server.getText("md").insert(server.getText("md").length - 1, " (bob)");
    const kept = { generation: "g1", base, text: s.text.toString(), update: s.update() };
    expect(recoverInto(server, kept, "g1")).toBe("alpha one two\nbeta (bob)\n");
  });

  test("a recreated room (new generation, other item ids): text merge, nothing lost, nothing twice", () => {
    const old = docWith("alpha\nbeta\n");
    const s = session(old);
    const base = s.text.toString();
    s.text.insert(5, " one");
    s.send();
    s.text.insert(9, " two");
    // the room comes back from Git with what was committed (" one"), as a fresh document
    const fresh = docWith("alpha one\nbeta\n");
    const kept = { generation: "g1", base, text: s.text.toString(), update: s.update() };
    expect(recoverInto(fresh, kept, "g2")).toBe("alpha one two\nbeta\n");
    // even claiming the same generation, an update that doesn't integrate (pending structs) isn't "merged"
    expect(recoverInto(docWith("alpha one\nbeta\n"), kept, "g1")).toBe("alpha one two\nbeta\n");
  });

  test("edits at offset 0 of an empty note, already committed, aren't inserted twice in a recreated room", () => {
    const s = session(new Y.Doc());
    s.text.insert(0, "hello");
    const kept = { generation: "g1", base: "", text: "hello", update: s.update() };
    // a Yjs merge would integrate these (no origin) next to the committed copy: "hellohello"
    expect(recoverInto(docWith("hello"), kept, "g2")).toBe("hello");
    expect(recoverInto(docWith("hel"), kept, "g2")).toBe("hello");
  });

  test("unknown generation, or no update: text merge", () => {
    const kept = { generation: null, base: "a\n", text: "a b\n", update: new Uint8Array() };
    expect(recoverInto(docWith("a\nc\n"), kept, "g1")).toBe("a b\nc\n");
    expect(recoverInto(docWith("a\nc\n"), { ...kept, generation: "g1" }, "g1")).toBe("a b\nc\n");
  });

  test("a conflict: null (never reported as merged)", () => {
    const kept = { generation: "g1", base: "one two\n", text: "one 2\n", update: new Uint8Array([0, 0]) };
    expect(recoverInto(docWith("one TWO\n"), kept, "g2")).toBeNull();
  });
});

describe("unsent.ts", () => {
  const kept = (text: string): KeptEdits => ({ generation: "g", base: "", text, update: new Uint8Array([1, 2, 3]) });
  test("kept per user, repo and path; signing out drops the user's entries", () => {
    sessionStorage.clear();
    keepUnsent("u1", "r", "a.md", kept("one"));
    keepUnsent("u2", "r", "a.md", kept("two"));
    keepUnsent("u1", "r", "b.md", { ...kept("three"), older: ["zero"] });
    sessionStorage.setItem("grimoire.unsent:r\u0000a.md", "AAA="); // an entry from before (no user)
    expect(keptUnsent("u1", "r", "a.md")?.text).toBe("one");
    expect(keptUnsent("u2", "r", "a.md")?.text).toBe("two");
    expect(keptUnsent("u1", "r", "b.md")).toEqual({ ...kept("three"), older: ["zero"] });
    expect(keptUnsent("u1", "r", "c.md")).toBeNull();
    forgetUnsent("u1", "r", "a.md");
    expect(keptUnsent("u1", "r", "a.md")).toBeNull();
    forgetAllUnsent("u1");
    expect([keptUnsent("u1", "r", "b.md"), keptUnsent("u2", "r", "a.md")?.text, sessionStorage.getItem("grimoire.unsent:r\u0000a.md")]).toEqual([null, "two", null]);
  });
  test("a full sessionStorage: false", () => {
    const g = globalThis as { sessionStorage: unknown };
    const real = g.sessionStorage;
    g.sessionStorage = {
      setItem() {
        throw new Error("QuotaExceededError");
      },
    };
    try {
      expect(keepUnsent("u", "r", "x.md", kept("x"))).toBe(false);
    } finally {
      g.sessionStorage = real;
    }
  });
});

// ---------------------------------------------------------------------------------------------

function roomWith(text: string, generation: string) {
  const doc = docWith(text);
  const room = new FakeRoom(doc, new Awareness(doc));
  room.generation = generation;
  return { doc, room, socket: (): SocketLike => room.connect() };
}

describe("RustCollab crash recovery", () => {
  tw("a crashed session's edits merge into the next one (same generation): sent ones aren't repeated", async () => {
    const r = roomWith("alpha\nbeta\n", "g1");
    const a = new RustCollab(factory!, "r", "p.md", user, { socket: r.socket });
    await tick();
    expect([a.generation, a.baseText]).toEqual(["g1", "alpha\nbeta\n"]);
    const host = document.createElement("div");
    const v = new RustEditorView(host, { collab: a });
    v.setSel({ anchor: 5, head: 5 });
    v.apply(v.engine.insert_text(" one"));
    await tick();
    expect(r.doc.getText("md").toString()).toBe("alpha one\nbeta\n");
    // offline: the next edit stays unsent, then the engine traps
    a.engine.frames_lost();
    (a as unknown as { ws: SocketLike | null }).ws = null;
    v.apply(v.engine.insert_text(" two"));
    let unsent: Uint8Array | null = null;
    a.on("crashed", (u) => (unsent = u));
    const conn = a as unknown as { onFrame(d: Uint8Array): void; engine: { receive: unknown } };
    conn.engine.receive = () => {
      throw new WebAssembly.RuntimeError("unreachable");
    };
    conn.onFrame(new Uint8Array([1, 0]));
    await tick();
    expect(unsent).toBeInstanceOf(Uint8Array);
    const kept: KeptEdits = { generation: a.generation, base: a.baseText!, text: v.doc.text, update: unsent! };
    v.destroy();
    a.destroy();
    expect(kept.text).toBe("alpha one two\nbeta\n");
    // the reload: a new connection with the kept edits
    let result: unknown = null;
    const b = new RustCollab(factory!, "r", "p.md", user, { socket: r.socket, recover: new UnsentEdits(kept) });
    b.on("recovered", (ok, changed) => (result = [ok, changed]));
    await tick(20);
    expect(result).toEqual([true, true]);
    expect([b.engine.text(), r.doc.getText("md").toString()]).toEqual(["alpha one two\nbeta\n", "alpha one two\nbeta\n"]);
    b.destroy();
  });

  tw("into a recreated room (new generation, fresh document): merged as text", async () => {
    const old = new Y.Doc();
    const s = session(old);
    s.text.insert(0, "hello");
    const kept: KeptEdits = { generation: "g1", base: "", text: "hello world", update: s.update() };
    s.text.insert(5, " world");
    kept.update = s.update();
    const r = roomWith("hello", "g2"); // "hello" was committed; the room came back from Git
    let result: unknown = null;
    const b = new RustCollab(factory!, "r", "p.md", user, { socket: r.socket, recover: new UnsentEdits(kept) });
    b.on("recovered", (ok, changed) => (result = [ok, changed]));
    await tick(20);
    expect(result).toEqual([true, true]);
    expect([b.engine.text(), r.doc.getText("md").toString()]).toEqual(["hello world", "hello world"]);
    b.destroy();
  });

  tw("edits the server already has: merged, nothing changed", async () => {
    const r = roomWith("hello", "g2");
    let result: unknown = null;
    const b = new RustCollab(factory!, "r", "p.md", user, { socket: r.socket, recover: new UnsentEdits({ generation: "g1", base: "", text: "hello", update: new Uint8Array([0, 0]) }) });
    b.on("recovered", (ok, changed) => (result = [ok, changed]));
    await tick(20);
    expect(result).toEqual([true, false]);
    expect(r.doc.getText("md").toString()).toBe("hello");
    b.destroy();
  });

  tw("a conflict isn't reported as merged and changes nothing", async () => {
    const r = roomWith("one TWO\n", "g2");
    let result: unknown = null;
    const b = new RustCollab(factory!, "r", "p.md", user, { socket: r.socket, recover: new UnsentEdits({ generation: "g1", base: "one two\n", text: "one 2\n", update: new Uint8Array([0, 0]) }) });
    b.on("recovered", (ok, changed) => (result = [ok, changed]));
    await tick(20);
    expect(result).toEqual([false, false]);
    expect([b.engine.text(), r.doc.getText("md").toString()]).toEqual(["one TWO\n", "one TWO\n"]);
    b.destroy();
  });

  tw("a trap in a key command: default prevented, nothing thrown, the session reports the crash", async () => {
    const r = roomWith("abc", "g1");
    const a = new RustCollab(factory!, "r", "p.md", user, { socket: r.socket });
    await tick();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const v = new RustEditorView(host, { collab: a });
    let crashed = false;
    a.on("crashed", () => (crashed = true));
    (a.engine as unknown as { key: unknown }).key = () => {
      throw new WebAssembly.RuntimeError("unreachable");
    };
    const ev = Object.assign(new Event("keydown", { cancelable: true }), { key: "Backspace", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false });
    expect(() => v.root.dispatchEvent(ev)).not.toThrow();
    expect(ev.defaultPrevented).toBe(true);
    // later input after the crash: also prevented (the engine fails fast), no DOM edit by the browser
    const bi = new Event("beforeinput", { cancelable: true });
    Object.assign(bi, { inputType: "insertText", data: "x" });
    v.root.dispatchEvent(bi);
    expect(bi.defaultPrevented).toBe(true);
    await tick();
    expect(crashed).toBe(true);
    v.destroy();
    a.destroy();
    host.remove();
  });
});

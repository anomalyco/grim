// Like harness.ts, with the Rust engine (src/client/editor-rs): `ENGINE=rust bun test/editor/browser/run.mjs`
// builds it (as harness.js) with the wasm pkg. `?fake` uses the plain-text fake engine. `?collab` (COLLAB=1): the
// engine owns the shared document (RustCollab) and talks the room protocol to an in-page room (room.ts) whose doc
// is `ytext2` (the other client); `ytext` is then that same text.
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "y-protocols/awareness";
import { RustEditorView } from "../../../src/client/editor-rs/view.ts";
import { loadCollabEngine, loadWasmEngine } from "../../../src/client/editor-rs/engine.ts";
import { RustCollab } from "../../../src/client/editor-rs/collab.ts";
import { FakeRoom } from "./room.ts";
import { FakeEngine } from "../../../src/client/editor-rs/fake.ts";

const params = new URLSearchParams(location.search);
const collab = params.has("collab");
// folded headings persist in localStorage (collab: per repo + path; local docs: `foldKey`): only pages loaded with
// `?folds` keep them, so folds from one check don't carry over into the next
if (!params.has("folds")) localStorage.clear();
const doc = new Y.Doc();
const ytext = doc.getText("t");
const doc2 = new Y.Doc();
// the collab engine's shared text is "md" (like the server's)
const ytext2 = doc2.getText(collab ? "md" : "t");
if (!collab) {
  doc.on("update", (u: Uint8Array, origin: unknown) => origin !== "sync" && Y.applyUpdate(doc2, u, "sync"));
  doc2.on("update", (u: Uint8Array, origin: unknown) => origin !== "sync" && Y.applyUpdate(doc, u, "sync"));
}
const init = (window as any).INIT ?? "";
ytext2.insert(0, init);

const aw = new Awareness(doc);
aw.setLocalState({ user: { id: "a", name: "Alice", color: "#d63b3b", kind: "human" }, cursor: null });
const aw2 = new Awareness(doc2);
aw2.setLocalState({ user: { id: "b", name: "Bob", color: "#2f7de1", kind: "agent" }, cursor: null });
if (!collab) {
  aw2.on("update", ({ added, updated, removed }: any) => {
    applyAwarenessUpdate(aw, encodeAwarenessUpdate(aw2, [...added, ...updated, ...removed]), "sync");
  });
}

let view: RustEditorView;
let room: FakeRoom | null = null;
if (collab) {
  room = new FakeRoom(doc2, aw2, params.has("ro"), params.has("async"));
  const r = room;
  const conn = new RustCollab(await loadCollabEngine("./"), "r", "p.md", { id: "a", name: "Alice", color: "#d63b3b", kind: "human" }, { socket: () => r.connect() });
  if (!conn.synced) await new Promise<void>((res) => conn.on("synced", res));
  view = new RustEditorView(document.getElementById("ed")!, { collab: conn, readOnly: conn.readOnly });
} else {
  const engine = params.has("fake") ? (t: string) => new FakeEngine(t) : await loadWasmEngine("./");
  view = new RustEditorView(document.getElementById("ed")!, { ytext, awareness: aw, readOnly: params.has("ro"), engine, foldKey: "harness" });
}
(window as any).T = {
  Y,
  doc,
  // collab: the editor has no Y.Text of its own; programmatic edits go through the room's
  ytext: collab ? ytext2 : ytext,
  doc2,
  ytext2,
  // collab: the client's presence as the room sees it
  aw: collab ? { getLocalState: () => room!.clientState() } : aw,
  aw2,
  view,
  room,
  text: () => (collab ? view.engine.text() : ytext.toString()),
  sel: () => view.sel,
  setRemoteCursor(a: number, h: number) {
    aw2.setLocalStateField("cursor", {
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext2, a)),
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext2, h)),
    });
  },
};

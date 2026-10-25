import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "y-protocols/awareness";
import { EditorView } from "../../../src/client/editor/view.ts";

const params = new URLSearchParams(location.search);
const doc = new Y.Doc();
const ytext = doc.getText("t");
const doc2 = new Y.Doc();
const ytext2 = doc2.getText("t");
doc.on("update", (u: Uint8Array, origin: unknown) => origin !== "sync" && Y.applyUpdate(doc2, u, "sync"));
doc2.on("update", (u: Uint8Array, origin: unknown) => origin !== "sync" && Y.applyUpdate(doc, u, "sync"));
const init = (window as any).INIT ?? "";
ytext2.insert(0, init);

const aw = new Awareness(doc);
aw.setLocalState({ user: { id: "a", name: "Alice", color: "#d63b3b", kind: "human" }, cursor: null });
const aw2 = new Awareness(doc2);
aw2.setLocalState({ user: { id: "b", name: "Bob", color: "#2f7de1", kind: "agent" }, cursor: null });
aw2.on("update", ({ added, updated, removed }: any) => {
  applyAwarenessUpdate(aw, encodeAwarenessUpdate(aw2, [...added, ...updated, ...removed]), "sync");
});

const view = new EditorView(document.getElementById("ed")!, { ytext, awareness: aw, readOnly: params.has("ro") });
(window as any).T = {
  Y,
  doc,
  ytext,
  doc2,
  ytext2,
  aw,
  aw2,
  view,
  text: () => ytext.toString(),
  sel: () => view.sel,
  setRemoteCursor(a: number, h: number) {
    aw2.setLocalStateField("cursor", {
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext2, a)),
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext2, h)),
    });
  },
};

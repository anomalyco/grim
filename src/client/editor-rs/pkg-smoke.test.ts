// Smoke test of the editor-wasm package (built on the laptop by grimoire-native scripts/build-wasm.sh).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Engine, initSync, type JsLayout, type LineViewJs, type Patch } from "./pkg/editor_wasm.js";

initSync({ module: readFileSync(new URL("./pkg/editor_wasm_bg.wasm", import.meta.url)) });

const layout: JsLayout = {
  caret_rect: () => [0, 0, 1, 20],
  hit_test: () => undefined,
  bounds: () => [800, 600],
  adjacent_line_y: () => undefined,
  table_cell_at: () => undefined,
  line_mid_y: () => undefined,
  image_at: () => undefined,
};

function apply(lines: LineViewJs[], p: Patch) {
  if (p.lines) lines.splice(p.lines.start, p.lines.deleteCount, ...p.lines.insert);
}

test("engine patches in UTF-16", () => {
  const e = new Engine("# Hi\n- a");
  const lines: LineViewJs[] = [];
  const p0 = e.render_all();
  expect(p0.lines).toMatchObject({ start: 0, deleteCount: 0 });
  apply(lines, p0);
  expect(lines.map((l) => [l.kind, l.from, l.to, l.textFrom, l.text])).toEqual([
    ["heading", 0, 4, 2, "# Hi"],
    ["bullet", 5, 8, 7, "- a"],
  ]);
  expect(lines[0].segments[0]).toMatchObject({ kind: "token", token: "heading", from: 0, to: 2, hidden: false });
  expect(lines[0].code).toBeUndefined();
  expect(new Set(lines.map((l) => l.key)).size).toBe(2);
  expect(p0.sel).toEqual({ anchor: 2, head: 2 });

  apply(lines, e.set_selection(8, 8));
  const key1 = lines[1].key;
  const p1 = e.insert_text("😀x");
  expect(p1.edits).toEqual([{ from: 8, to: 8, insert: "😀x" }]);
  expect(p1.sel).toEqual({ anchor: 11, head: 11 });
  expect(p1.scroll).toBe("caret");
  expect(p1.lines).toMatchObject({ start: 1, deleteCount: 1 });
  apply(lines, p1);
  expect(lines[1]).toMatchObject({ from: 5, to: 11, text: "- a😀x", key: key1 });

  const p2 = e.key("Enter", 0, layout)!;
  expect(e.text()).toBe("# Hi\n- a😀x\n- ");
  expect(p2.edits).toEqual([{ from: 11, to: 11, insert: "\n- " }]);
  expect(p2.sel).toEqual({ anchor: 14, head: 14 });
  apply(lines, p2);
  expect(lines.map((l) => [l.from, l.to])).toEqual([[0, 4], [5, 11], [12, 14]]);
  expect(new Set(lines.map((l) => l.key)).size).toBe(3);

  // keys the editor doesn't handle are left to the browser
  expect(e.key("a", 0, layout)).toBeUndefined();
  expect(e.key("Shift", 1, layout)).toBeUndefined();
  // Shift-Left (mods bit 1) extends by one grapheme: the caret steps over the list token
  const p3 = e.key("ArrowLeft", 1, layout)!;
  expect(p3.edits).toBeUndefined();
  expect(p3.sel.anchor).toBe(14);

  const p4 = e.undo();
  expect(e.text()).toBe("# Hi\n- a");
  expect(p4.edits).toEqual([{ from: 8, to: 14, insert: "" }]);
  apply(lines, p4);
  expect(lines.map((l) => l.text)).toEqual(["# Hi", "- a"]);

  // copy / cut / paste
  apply(lines, e.set_selection(7, 8));
  expect(e.copy()).toBe("a");
  const cut = e.cut();
  expect(cut.text).toBe("a");
  expect(cut.patch.edits).toEqual([{ from: 7, to: 8, insert: "" }]);
  apply(lines, cut.patch);
  const p5 = e.paste("**b** 😀");
  expect(e.text()).toBe("# Hi\n- **b** 😀");
  apply(lines, p5);
  expect(lines[1].segments.filter((s) => s.styles.includes("bold")).map((s) => [s.kind, s.from, s.to])).toEqual([
    ["mk", 7, 9],
    ["text", 9, 10],
    ["mk", 10, 12],
  ]);

  // remote edits keep the local caret mapped and carry no local edits
  const p6 = e.apply_remote([{ from: 0, to: 0, insert: "😀" }]);
  expect(e.text()).toBe("😀# Hi\n- **b** 😀");
  expect(p6.edits).toBeUndefined();
  expect(p6.sel).toEqual({ anchor: 17, head: 17 });
  apply(lines, p6);
  expect(lines.map((l) => [l.kind, l.from, l.to])).toEqual([
    ["paragraph", 0, 6],
    ["bullet", 7, 17],
  ]);

  // Up/Down ask the layout for the adjacent line, then hit-test there
  const asked: number[] = [];
  const up = e.key("ArrowUp", 0, {
    ...layout,
    adjacent_line_y: (pos, dir) => (asked.push(pos, dir), 10),
    hit_test: () => 3,
  })!;
  expect(asked).toEqual([17, -1]);
  expect(up.edits).toBeUndefined();
  expect(up.sel.head).toBeLessThanOrEqual(6); // on the first line (where exactly depends on the fake geometry)
  apply(lines, e.set_selection(17, 17));

  // IME: the commit arrives as insert_text while composing
  e.begin_composition();
  const p7 = e.insert_text("é");
  expect(p7.edits).toEqual([{ from: 17, to: 17, insert: "é" }]);
  expect(p7.composing).toBeUndefined();
  e.end_composition();
  e.free();
});

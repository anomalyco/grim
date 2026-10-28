// Line authors in the margin: which lines show a name (authors.ts), the values following edits between the room's
// messages (shared/lineauthors.ts), and reading the message (collab.ts).
import { describe, expect, test } from "bun:test";
import { authorMarks, fitsMargin, type MarkLine } from "../../src/client/editor-rs/authors.ts";
import { parseBlame } from "../../src/client/editor-rs/collab.ts";
import { attribute, KEEP } from "../../src/shared/lineauthors.ts";

const L = (type: string, opts: { empty?: boolean; hidden?: boolean } = {}): MarkLine => ({ type, empty: !!opts.empty, hidden: !!opts.hidden });
const P = L("paragraph");

describe("authorMarks", () => {
  test("a name only where the author changes", () => {
    expect(authorMarks([P, P, P, P, P], [0, 0, 1, 1, 0])).toEqual([0, -1, 1, -1, 0]);
  });

  test("headings and empty lines show nothing and don't change the last author", () => {
    // A writes, a heading by B, an empty line by B, A again: A isn't repeated
    expect(authorMarks([P, L("heading"), L("paragraph", { empty: true }), P], [0, 1, 1, 0])).toEqual([0, -1, -1, -1]);
    // a heading between two authors: the next one still shows
    expect(authorMarks([P, L("heading"), P], [0, 0, 1])).toEqual([0, -1, 1]);
    // the very first line being a heading: the first paragraph shows its name
    expect(authorMarks([L("heading"), P, P, P], [1, 1, 1, 0])).toEqual([-1, 1, -1, 0]);
  });

  test("code blocks: code lines count, fences don't", () => {
    const lines = [P, L("fence"), L("code"), L("code"), L("code", { empty: true }), L("code"), L("fence"), P];
    expect(authorMarks(lines, [0, 1, 1, 0, 2, 0, 1, 0])).toEqual([0, -1, 1, 0, -1, -1, -1, -1]);
    expect(authorMarks([L("fence"), L("code"), L("fence"), P], [0, 0, 0, 1])).toEqual([-1, 0, -1, 1]);
  });

  test("lists, quotes, table rows show; delimiter rows and rules are skipped", () => {
    const lines = [L("bullet"), L("bullet"), L("quote"), L("table-head"), L("table-delim"), L("table-row"), L("hr"), L("numbered")];
    expect(authorMarks(lines, [0, 1, 1, 1, 0, 0, 1, 0])).toEqual([0, 1, -1, -1, -1, 0, -1, -1]);
  });

  test("folded lines are skipped; unknown authors show nothing and end the run", () => {
    expect(authorMarks([P, L("paragraph", { hidden: true }), P], [0, 1, 0])).toEqual([0, -1, -1]);
    expect(authorMarks([P, P, P, P], [0, -1, 0, 1])).toEqual([0, -1, 0, 1]);
    // fewer values than lines (a message for an older text): the rest are unknown
    expect(authorMarks([P, P, P], [0, 1])).toEqual([0, 1, -1]);
  });

  test("a note with fewer than two distinct authors shows no names", () => {
    expect(authorMarks([P, P, P], [0, 0, 0])).toEqual([-1, -1, -1]);
    // unknown lines don't count as an author
    expect(authorMarks([P, P, P], [0, -1, 0])).toEqual([-1, -1, -1]);
    expect(authorMarks([P, P], [-1, -1])).toEqual([-1, -1]);
    expect(authorMarks([], [])).toEqual([]);
    // every line counts, even ones that never show a name (a heading, an empty line, a folded line)
    expect(authorMarks([L("heading"), P, P], [1, 0, 0])).toEqual([-1, 0, -1]);
    expect(authorMarks([P, L("paragraph", { empty: true })], [0, 1])).toEqual([0, -1]);
    expect(authorMarks([P, L("paragraph", { hidden: true }), P], [0, 1, 0])).toEqual([0, -1, -1]);
    // values beyond the lines (a message for a longer text) don't count
    expect(authorMarks([P, P], [0, 0, 1])).toEqual([-1, -1]);
  });

  test("live: a second author makes the names appear, deleting their lines makes them go", () => {
    const lines = (n: number) => Array.from({ length: n }, () => P);
    let text = "one\ntwo";
    let values = [0, 0];
    expect(authorMarks(lines(2), values)).toEqual([-1, -1]);
    // our first keystroke in someone else's note (we're author 1): names at once
    values = attribute(text, "one\ntwo\nmine", values, 1);
    text = "one\ntwo\nmine";
    expect(authorMarks(lines(3), values)).toEqual([0, -1, 1]);
    // our line deleted (joined back): one author again
    values = attribute(text, "one\ntwo", values, 1);
    expect(values).toEqual([0, 0]);
    expect(authorMarks(lines(2), values)).toEqual([-1, -1]);
  });
});

test("fitsMargin: a name shows whole or not at all", () => {
  expect(fitsMargin(80, 100)).toBe(true);
  expect(fitsMargin(100, 100)).toBe(true);
  expect(fitsMargin(100.4, 100)).toBe(true);
  expect(fitsMargin(101, 100)).toBe(false);
});

describe("values between messages", () => {
  test("our own edit is ours at once; others' keep the line's author", () => {
    expect(attribute("a\nb\nc", "a\nbb\nc", [0, 1, 2], 5)).toEqual([0, 5, 2]);
    expect(attribute("a\nb\nc", "a\nbb\nc", [0, 1, 2], KEEP)).toEqual([0, 1, 2]);
    // a remote Enter: the new line takes the author of the line it came from; the lines below move down
    expect(attribute("a\nb\nc", "a\nb1\nb2\nc", [0, 1, 2], KEEP)).toEqual([0, 1, 1, 2]);
    expect(attribute("a\nb\nc", "a\nc", [0, 1, 2], KEEP)).toEqual([0, 2]);
  });
});

test("parseBlame checks the message", () => {
  expect(parseBlame({ authors: [{ id: "u1", name: "A", kind: "human", color: "#123456" }], lines: [0, -1, 3, 0.5, "x"] })).toEqual({
    authors: [{ id: "u1", name: "A", kind: "human", color: "#123456" }],
    lines: [0, -1, -1, -1, -1],
  });
  expect(parseBlame({ authors: [{ id: "u1", name: "A", color: "red;x" }], lines: [] })!.authors[0]).toEqual({ id: "u1", name: "A", kind: "human", color: "#888" });
  expect(parseBlame({ authors: [{ id: 1 }], lines: [] })).toBeNull();
  expect(parseBlame({ lines: [] })).toBeNull();
});

describe("the margin layer (DOM)", () => {
  test("whole names only: no dot, colour, ellipsis or tooltip; left at the pane's edge + 16px; a name too wide for the margin is hidden", async () => {
    const { installDom } = await import("./rs/dom.ts");
    installDom();
    const { AuthorGutter, INSET } = await import("../../src/client/editor-rs/authors.ts");
    const rect = (el: HTMLElement, r: { left: number; top: number; width: number; height: number }) =>
      (el.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} }) as DOMRect);
    // names are 6px a character (happy-dom has no text layout)
    const proto = window.HTMLElement.prototype as unknown as { getBoundingClientRect(): DOMRect };
    const real = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      if (this.className !== "nm") return real.call(this);
      const w = (this.textContent ?? "").length * 6;
      return { left: 0, top: 0, width: w, height: 11, right: w, bottom: 11, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
    try {
      const wrapper = document.createElement("div");
      const root = document.createElement("div");
      root.style.paddingLeft = "49px";
      wrapper.appendChild(root);
      document.body.appendChild(wrapper);
      const texts = ["Alice's line", "Bob's line", "Max's line"];
      texts.forEach((_, i) => {
        const d = document.createElement("div");
        d.className = "ln";
        rect(d, { left: 400, top: 100 + i * 25, width: 700, height: 25 });
        root.appendChild(d);
      });
      rect(wrapper, { left: 272, top: 50, width: 1128, height: 800 });
      // margin for names: text column at 400 + 49, minus 12, minus (272 + 16) = 149px
      rect(root, { left: 400, top: 50, width: 760, height: 800 });
      const lines = texts.map((t) => ({ type: "paragraph", hidden: false, len: t.length }) as never);
      const view = { wrapper, root, lines, doc: { text: texts.join("\n"), lines: [{ from: 0, to: 12 }, { from: 13, to: 23 }, { from: 24, to: 34 }] } };
      const g = new AuthorGutter(view, { id: "u1", name: "Alice", color: "#ff0000" });
      const long = "Maximilian Alexander von Habsburg"; // 33 characters: 198px
      g.set({
        authors: [
          { id: "u1", name: "Alice", kind: "human", color: "#ff0000" },
          { id: "u2", name: "Bartholomew Jones", kind: "human", color: "#00ff00" },
          { id: "u3", name: long, kind: "human", color: "#0000ff" },
        ],
        lines: [0, 1, 2],
      });
      const shown = () => [...g.layer.querySelectorAll<HTMLElement>(".mde-author")].map((e) => [e.dataset.line, e.textContent]);
      g.draw();
      expect(shown()).toEqual([["0", "Alice"], ["1", "Bartholomew Jones"]]);
      for (const e of g.layer.querySelectorAll<HTMLElement>(".mde-author")) {
        expect(e.querySelector(".dot")).toBeNull();
        expect(e.textContent).not.toContain("…");
        expect(e.title).toBe("");
        expect(e.style.maxWidth).toBe("");
        for (const c of ["#ff0000", "#00ff00", "#0000ff"]) expect(e.innerHTML).not.toContain(c);
        expect(e.style.color).toBe("");
        expect(e.style.background).toBe("");
        expect(e.style.left).toBe(`${INSET}px`);
      }
      // narrower (61px): the short name still shows, whole; the longer one is hidden, not cut
      rect(root, { left: 312, top: 50, width: 760, height: 800 });
      g.draw();
      expect(shown()).toEqual([["0", "Alice"]]);
      // no room for any name (21px)
      rect(root, { left: 272, top: 50, width: 760, height: 800 });
      g.draw();
      expect(g.layer.children.length).toBe(0);
      g.destroy();
      wrapper.remove();
    } finally {
      proto.getBoundingClientRect = real;
    }
  });
});

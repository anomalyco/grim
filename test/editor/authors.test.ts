// Line authors in the margin: which lines show a name (authors.ts), the values following edits between the room's
// messages (shared/lineauthors.ts), and reading the message (collab.ts).
import { describe, expect, test } from "bun:test";
import { authorMarks, shortName, type MarkLine } from "../../src/client/editor-rs/authors.ts";
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
    expect(authorMarks([L("heading"), P, P], [1, 1, 1])).toEqual([-1, 1, -1]);
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
    expect(authorMarks([P, P, P], [0, -1, 0])).toEqual([0, -1, 0]);
    // fewer values than lines (a message for an older text): the rest are unknown
    expect(authorMarks([P, P, P], [0])).toEqual([0, -1, -1]);
  });
});

test("shortName cuts at 12 characters with an ellipsis", () => {
  expect(shortName("Alice")).toBe("Alice");
  expect(shortName("Exactly12chr")).toBe("Exactly12chr");
  expect(shortName("Bartholomew Jones")).toBe("Bartholomew…");
  expect(shortName("😀😀😀😀😀😀😀😀😀😀😀😀😀")).toBe("😀😀😀😀😀😀😀😀😀😀😀…");
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

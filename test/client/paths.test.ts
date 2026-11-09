// Note paths in URLs and links (src/shared/paths.ts): `.md` only when the last segment has no extension.
import { expect, test } from "bun:test";
import { extensionOf, isFilePath, withNoteExtension } from "../../src/shared/paths.ts";

test("only the last segment's extension counts", () => {
  expect(withNoteExtension("plan")).toBe("plan.md");
  expect(withNoteExtension("v2.0/plan")).toBe("v2.0/plan.md");
  expect(withNoteExtension("notes/a.md")).toBe("notes/a.md");
  expect(withNoteExtension("images/a.png")).toBe("images/a.png");
  expect(withNoteExtension("v1.2")).toBe("v1.2");
  expect(withNoteExtension(".env")).toBe(".env.md");
  expect(withNoteExtension("")).toBe("");
  expect(extensionOf("a/b.C")).toBe("c");
  expect([isFilePath("a.md"), isFilePath("a.markdown"), isFilePath("a.png"), isFilePath("v2.0/plan")]).toEqual([false, false, true, false]);
});

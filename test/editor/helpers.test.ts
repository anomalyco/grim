// The editor's TS view helpers that aren't engine logic: image sources, link URLs, line lookup.
import { describe, expect, test } from "bun:test";
import { directImages, directImageUrl, repoImagePath, repoImages } from "../../src/client/editor-rs/images.ts";
import { safeUrl } from "../../src/client/editor-rs/input.ts";
import { lineAt } from "../../src/client/editor-rs/offsets.ts";

describe("image sources", () => {
  test("direct URLs: http(s), protocol-relative, data:image", () => {
    expect(directImageUrl("https://e.com/a.png")).toBe("https://e.com/a.png");
    expect(directImageUrl(" <http://e.com/a b.png> ")).toBe("http://e.com/a%20b.png");
    expect(directImageUrl("//e.com/a.png")).toBe("https://e.com/a.png");
    expect(directImageUrl("data:image/png;base64,iVBOR")).toBe("data:image/png;base64,iVBOR");
    expect(directImageUrl("data:image/svg+xml,<svg/>")).toBe("data:image/svg+xml,<svg/>");
  });

  test("other schemes never load", () => {
    for (const s of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "vbscript:x", "ftp://e.com/a.png", "https://e.com/\u0000a.png"]) {
      expect(directImageUrl(s)).toBeNull();
      expect(directImages(s)).toBeNull();
      expect(repoImages("a.md", (p) => `/raw?path=${p}`)(s)).toBeNull();
    }
  });

  test("relative paths resolve against the note's folder and stay in the repo", () => {
    expect(directImageUrl("images/cat.png")).toBeUndefined();
    expect(repoImagePath("images/cat.png", "notes/day.md")).toBe("notes/images/cat.png");
    expect(repoImagePath("./cat.png", "notes/day.md")).toBe("notes/cat.png");
    expect(repoImagePath("../a.png", "notes/day.md")).toBe("a.png");
    expect(repoImagePath("/img/a.png", "notes/deep/day.md")).toBe("img/a.png");
    expect(repoImagePath("my%20cat.png?raw=1#x", "day.md")).toBe("my cat.png");
    expect(repoImagePath("../../a.png", "notes/day.md")).toBeNull();
    expect(repoImagePath("../a.png", "day.md")).toBeNull();
    expect(repoImagePath("a\\b.png", "day.md")).toBeNull();
    expect(repoImagePath("", "day.md")).toBeNull();
    const r = repoImages("notes/day.md", (p) => `/api/repos/n/raw?path=${encodeURIComponent(p)}`);
    expect(r("images/cat.png")).toBe("/api/repos/n/raw?path=notes%2Fimages%2Fcat.png");
    expect(r("https://e.com/a.png")).toBe("https://e.com/a.png");
    expect(r("../../x.png")).toBeNull();
    // without a repo, relative paths show the placeholder
    expect(directImages("images/cat.png")).toBeNull();
  });
});

describe("safeUrl", () => {
  test("only http(s) and mailto", () => {
    expect(safeUrl("https://x.y/a")).toBe("https://x.y/a");
    expect(safeUrl("example.com")).toBe("https://example.com/");
    expect(safeUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,x")).toBeNull();
  });
});

describe("lineAt", () => {
  test("a position at a line's end belongs to that line", () => {
    const lines = [
      { from: 0, to: 2 },
      { from: 3, to: 5 },
      { from: 6, to: 6 },
    ];
    expect(lineAt(lines, 0)).toBe(0);
    expect(lineAt(lines, 2)).toBe(0);
    expect(lineAt(lines, 3)).toBe(1);
    expect(lineAt(lines, 6)).toBe(2);
  });
});

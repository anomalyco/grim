import { describe, expect, test } from "bun:test";
import { parseDoc, parseInline } from "../../src/client/editor/parser.ts";
import { isImageLine, lineSegments } from "../../src/client/editor/render.ts";
import { computeReveal } from "../../src/client/editor/reveal.ts";
import { atomicAround } from "../../src/client/editor/units.ts";
import { directImages, directImageUrl, repoImagePath, repoImages } from "../../src/client/editor/images.ts";

function els(s: string) {
  return parseInline(s, 0, s.length).elements;
}

describe("image parsing", () => {
  test("![alt](src): alt, source and markers covering the whole source", () => {
    const s = "a ![cat pic](images/cat.png) b";
    const [img] = els(s);
    expect(img!.type).toBe("image");
    expect(s.slice(img!.from, img!.to)).toBe("![cat pic](images/cat.png)");
    expect(s.slice(img!.contentFrom, img!.contentTo)).toBe("cat pic");
    expect(s.slice(img!.src![0], img!.src![1])).toBe("images/cat.png");
    expect(img!.markers.map(([f, t]) => s.slice(f, t))).toEqual(["![", "cat pic", "](images/cat.png)"]);
    expect(img!.url).toBeUndefined();
    expect(img!.title).toBeUndefined();
  });

  test("titles in double quotes, single quotes or parentheses", () => {
    for (const [s, title] of [
      ['![a](x.png "A title")', "A title"],
      ["![a](x.png 'single')", "single"],
      ["![a](x.png (paren))", "paren"],
      ['![a](x.png  "esc \\" q"  )', 'esc " q'],
    ] as const) {
      const [img] = els(s);
      expect(img?.type).toBe("image");
      expect(img!.to).toBe(s.length);
      expect(img!.title).toBe(title);
      expect(s.slice(img!.src![0], img!.src![1])).toBe("x.png");
    }
  });

  test("empty alt; nothing inline is parsed in the alt text", () => {
    const [img, ...rest] = els("![](x.png)");
    expect(img!.markers.length).toBe(2);
    expect(rest).toEqual([]);
    expect(els("![**b**](x.png)").map((e) => e.type)).toEqual(["image"]);
  });

  test("not images: no source, unclosed, a title without closing paren, across lines, escaped", () => {
    expect(els("![a]()").some((e) => e.type === "image")).toBe(false);
    expect(els("![a](x.png").some((e) => e.type === "image")).toBe(false);
    expect(els('![a](x.png "t"').some((e) => e.type === "image")).toBe(false);
    expect(els("![a](x.png y)").some((e) => e.type === "image")).toBe(false);
    const doc = parseDoc("![a\nb](x.png)");
    expect(doc.lines.flatMap((l) => l.inline).some((e) => e.type === "image")).toBe(false);
    // "\!" is an escaped "!": what follows is a link
    expect(els("\\![a](x.png)").map((e) => e.type)).toEqual(["link"]);
  });

  test("links keep their URL rules (no titles) and can wrap an image", () => {
    expect(els('[a](x "t")').length).toBe(0);
    const s = "[![badge](https://img/b.svg)](https://example.com)";
    expect(els(s).map((e) => [e.type, s.slice(e.from, e.to)])).toEqual([
      ["link", s],
      ["image", "![badge](https://img/b.svg)"],
    ]);
  });

  test("angle-bracket sources may hold spaces (CommonMark); no line break or '<' inside", () => {
    const s = '![my cat](<my cat.png> "T")';
    const [img] = els(s);
    expect(img?.type).toBe("image");
    expect(img!.to).toBe(s.length);
    expect(s.slice(img!.src![0], img!.src![1])).toBe("<my cat.png>");
    expect(img!.title).toBe("T");
    expect(els("![a](<b\\>c.png>)")[0]?.to).toBe(16);
    expect(els("![a](<b<c.png>)").some((e) => e.type === "image")).toBe(false);
    expect(els("![a](<b.png)").some((e) => e.type === "image")).toBe(false);
    expect(els("![a](<>)").some((e) => e.type === "image")).toBe(false);
    expect(parseDoc("![a](<b\nc.png>)").lines.flatMap((l) => l.inline).some((e) => e.type === "image")).toBe(false);
    // links too; the chip opens the URL without the brackets
    const l = "[a](<https://e.com/a b>) x";
    const [link] = els(l);
    expect([link!.type, l.slice(link!.from, link!.to), l.slice(link!.url![0], link!.url![1])]).toEqual(["link", "[a](<https://e.com/a b>)", "<https://e.com/a b>"]);
  });

  test("table cells don't draw images", () => {
    const doc = parseDoc("| a | b |\n|---|---|\n| ![x](y.png) | z |");
    expect(doc.lines[2]!.inline.map((e) => e.type)).toEqual(["link"]);
  });
});

describe("image rendering plan", () => {
  test("the whole source is collapsible markers; the alt is marked", () => {
    const doc = parseDoc("x ![alt](a.png)");
    const segs = lineSegments(doc.lines[0]!).map((s) => [s.kind, doc.text.slice(s.from, s.to), s.cls.join(" ")]);
    expect(segs).toEqual([
      ["text", "x ", ""],
      ["mk", "![", "img"],
      ["mk", "alt", "img alt"],
      ["mk", "](a.png)", "img"],
    ]);
  });

  test("image-only lines", () => {
    const only = (s: string) => isImageLine(parseDoc(s).lines[0]!);
    expect(only("![a](x.png)")).toBe(true);
    expect(only("![a](x.png)![b](y.png)")).toBe(true);
    expect(only("[![a](x.png)](https://e.com)")).toBe(true);
    expect(only("![a](x.png) ")).toBe(false);
    expect(only("![a](x.png) ![b](y.png)")).toBe(false);
    expect(only("text ![a](x.png)")).toBe(false);
    expect(only("- ![a](x.png)")).toBe(false);
    expect(only("[link](https://e.com)")).toBe(false);
    expect(only("![a](<my cat.png>)")).toBe(true);
    // inside formatting that spans the paragraph's lines, an image line is still part of the text
    const doc = parseDoc("**a\n![x](y.png)\nb**");
    expect(isImageLine(doc.lines[1]!)).toBe(false);
    expect(isImageLine(parseDoc("a\n![x](y.png)\nb").lines[1]!)).toBe(true);
  });

  test("the caret anywhere on an image-only line reveals it; elsewhere it stays collapsed", () => {
    const doc = parseDoc("![a](x.png)\nnext");
    for (let p = 0; p <= 11; p++) expect(computeReveal(doc, { anchor: p, head: p }).get(0)?.els).toEqual([0]);
    expect(computeReveal(doc, { anchor: 13, head: 13 }).get(0)).toBeUndefined();
  });

  test("an image's source isn't atomic: the caret steps through it", () => {
    const doc = parseDoc("![a](x.png)");
    for (let p = 1; p < 11; p++) expect(atomicAround(doc, p)).toBeNull();
  });
});

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

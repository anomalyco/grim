import { describe, expect, test } from "bun:test";
import { parseDoc } from "../../src/client/editor/parser.ts";
import { nextStop, prevStop, wordLeft, wordRight, isStop, snap } from "../../src/client/editor/units.ts";
import { computeReveal } from "../../src/client/editor/reveal.ts";

describe("caret stops", () => {
  test("block token is one step", () => {
    const d = parseDoc("ab\n- item");
    // "ab\n" = 3, "- " = 3..5
    expect(isStop(d, 4)).toBe(false);
    expect(prevStop(d, 5)).toBe(3);
    expect(prevStop(d, 3)).toBe(2);
    expect(nextStop(d, 3)).toBe(5);
  });
  test("nested indent: one token per level", () => {
    const d = parseDoc("\t- x");
    expect(prevStop(d, 3)).toBe(1);
    expect(prevStop(d, 1)).toBe(0);
  });
  test("a space indent level is one step", () => {
    // 2-space steps: line 2 "    - c" starts at 10: "  " (10..12), "  " (12..14), "- " (14..16)
    const d = parseDoc("- a\n  - b\n    - c");
    expect(prevStop(d, 16)).toBe(14);
    expect(prevStop(d, 14)).toBe(12);
    expect(prevStop(d, 12)).toBe(10);
    expect(isStop(d, 11)).toBe(false);
    // 4-space steps: one 4-space token
    const d4 = parseDoc("- a\n    - b");
    expect(prevStop(d4, 10)).toBe(8);
    expect(prevStop(d4, 8)).toBe(4);
    expect(isStop(d4, 6)).toBe(false);
  });
  test("markers are stepped one char at a time", () => {
    const d = parseDoc("a **b**");
    expect(nextStop(d, 2)).toBe(3);
    expect(nextStop(d, 3)).toBe(4);
  });
  test("link url is atomic", () => {
    const d = parseDoc("[t](http://x)");
    expect(nextStop(d, 4)).toBe(12);
    expect(snap(d, 6, 0)).toBe(4);
  });
  test("escape pair", () => {
    const d = parseDoc("\\*x");
    expect(isStop(d, 1)).toBe(false);
    expect(nextStop(d, 0)).toBe(2);
  });
});

describe("horizontal rule", () => {
  test("single caret stop", () => {
    const d = parseDoc("a\n---\nb");
    // stops: 1 (end of "a"), 5 (after the rule), 6 (start of "b")
    expect(nextStop(d, 1)).toBe(5);
    expect(prevStop(d, 5)).toBe(1);
    expect(isStop(d, 2)).toBe(false);
    expect(snap(d, 3, 0)).toBe(5);
    expect(nextStop(d, 5)).toBe(6);
  });
});

describe("word motion", () => {
  test("option-right passes over markers", () => {
    const d = parseDoc("Alpha **bold words**");
    expect(wordRight(d, 0)).toBe(5);
    expect(wordRight(d, 5)).toBe(12);
    expect(wordRight(d, 12)).toBe(18);
    expect(wordLeft(d, 18)).toBe(13);
    expect(wordLeft(d, 13)).toBe(8);
    expect(wordLeft(d, 8)).toBe(0);
  });
  test("link URLs are skipped whole", () => {
    const d = parseDoc("[a](https://x.y) end");
    expect(wordLeft(d, 16)).toBe(1);
    expect(wordRight(d, 2)).toBe(20);
  });
  test("tokens are not words", () => {
    const d = parseDoc("12. one");
    expect(wordLeft(d, 7)).toBe(4);
    expect(wordLeft(d, 4)).toBe(0);
  });
});

describe("reveal", () => {
  const text = "x **bold** y *it* z";
  const d = parseDoc(text);
  const els = (pos: number, head = pos) => computeReveal(d, { anchor: pos, head }).get(0)?.els ?? [];
  test("inclusive edges", () => {
    expect(els(2)).toEqual([0]);
    expect(els(10)).toEqual([0]);
    expect(els(11)).toEqual([]);
    expect(els(1)).toEqual([]);
  });
  test("only touched element", () => {
    expect(els(14)).toEqual([1]);
  });
  test("selection reveals strictly overlapping elements only", () => {
    expect(els(0, text.length)).toEqual([0, 1]);
    expect(els(0, 2)).toEqual([]);
    expect(els(0, 3)).toEqual([0]);
    expect(els(10, 12)).toEqual([]);
  });
  test("descendants reveal", () => {
    const d2 = parseDoc("**bold *nested* inside**");
    expect(computeReveal(d2, { anchor: 3, head: 3 }).get(0)!.els).toEqual([0, 1]);
  });
  test("an element spanning lines reveals on every line", () => {
    const d4 = parseDoc("a **bold \ntext** b");
    const r = computeReveal(d4, { anchor: 12, head: 12 });
    expect(r.get(0)!.els).toEqual([0]);
    expect(r.get(1)!.els).toEqual([0]);
  });
  test("a table reveals (all its lines) when the caret is in it", () => {
    const d5 = parseDoc("x\n| a | b |\n|---|---|\n| 1 | 2 |\ny");
    const r = computeReveal(d5, { anchor: 5, head: 5 });
    expect([1, 2, 3].map((i) => r.get(i)?.fence)).toEqual([true, true, true]);
    expect(computeReveal(d5, { anchor: 0, head: 0 }).get(1)).toBeUndefined();
  });
  test("code fences reveal when caret in block", () => {
    const d3 = parseDoc("a\n```\ncode\n```\nb");
    const r = computeReveal(d3, { anchor: 7, head: 7 });
    expect(r.get(1)!.fence).toBe(true);
    expect(r.get(3)!.fence).toBe(true);
    expect(computeReveal(d3, { anchor: 0, head: 0 }).get(1)).toBeUndefined();
  });
});

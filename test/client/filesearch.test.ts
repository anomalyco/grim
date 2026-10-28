// "Search files" ranking (src/client/filesearch.ts rankFiles).
import { expect, test } from "bun:test";
import { rankFiles } from "../../src/client/filesearch.ts";

const files = ["projects/launch/plan.md", "projects/Planets.md", "notes/explain.md", "Plan B.md", "archive/2024/p-l-a-n.md", "Welcome.md"];

test("empty query: every file, by path", () => {
  expect(rankFiles(files, "  ")).toEqual(["archive/2024/p-l-a-n.md", "notes/explain.md", "Plan B.md", "projects/launch/plan.md", "projects/Planets.md", "Welcome.md"]);
});

test("name prefix > name contains > path contains > words > letters in order; shorter names, then paths, first", () => {
  expect(rankFiles(files, "plan")).toEqual(["projects/launch/plan.md", "Plan B.md", "projects/Planets.md", "notes/explain.md", "archive/2024/p-l-a-n.md"]);
  expect(rankFiles(files, "launch")).toEqual(["projects/launch/plan.md"]);
  expect(rankFiles(files, "proj plan")).toEqual(["projects/launch/plan.md", "projects/Planets.md"]);
  expect(rankFiles(files, "WELC")).toEqual(["Welcome.md"]);
  expect(rankFiles(files, "zzz")).toEqual([]);
});

test(".md isn't matched", () => {
  expect(rankFiles(files, ".md")).toEqual([]);
});

// GitHub repo references, and read-only GitHub copies as partial clones (against local "upstream" repos, no network).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchCandidates, githubFileUrl, parseGitHubRepo, validBranch } from "../../src/shared/github.ts";
import { sh, upstreams } from "./upstream.ts";

// No server modules that load config here: test files share modules, and the others set their env first.
import { LocalGitStore } from "../../src/server/store/localgit.ts";

const tmp = mkdtempSync(join(tmpdir(), "np-gh-"));

describe("parseGitHubRepo", () => {
  const cases: Array<[string, { owner: string; name: string; kind?: "tree" | "blob" | null; rest?: string[] } | null]> = [
    ["vercel-labs/just-bash", { owner: "vercel-labs", name: "just-bash" }],
    ["  vercel-labs/just-bash  ", { owner: "vercel-labs", name: "just-bash" }],
    ["vercel-labs/just-bash.git", { owner: "vercel-labs", name: "just-bash" }],
    ["https://github.com/vercel-labs/just-bash", { owner: "vercel-labs", name: "just-bash" }],
    ["https://github.com/vercel-labs/just-bash/", { owner: "vercel-labs", name: "just-bash" }],
    ["http://www.github.com/vercel-labs/just-bash.git", { owner: "vercel-labs", name: "just-bash" }],
    ["github.com/vercel-labs/just-bash", { owner: "vercel-labs", name: "just-bash" }],
    ["https://github.com/vercel-labs/just-bash?tab=readme-ov-file#install", { owner: "vercel-labs", name: "just-bash" }],
    ["https://github.com/vercel-labs/just-bash/tree/main", { owner: "vercel-labs", name: "just-bash", kind: "tree", rest: ["main"] }],
    ["https://github.com/o/r/tree/feature/x/docs", { owner: "o", name: "r", kind: "tree", rest: ["feature", "x", "docs"] }],
    ["https://github.com/o/r/blob/main/docs/guide.md", { owner: "o", name: "r", kind: "blob", rest: ["main", "docs", "guide.md"] }],
    ["https://github.com/o/r/blob/main/docs/a%20b.md", { owner: "o", name: "r", kind: "blob", rest: ["main", "docs", "a b.md"] }],
    ["https://github.com/o/r/issues/12", { owner: "o", name: "r", kind: null, rest: [] }],
    ["git@github.com:o/r.git", { owner: "o", name: "r" }],
    ["ssh://git@github.com/o/r.git", { owner: "o", name: "r" }],
    ["o/r.js", { owner: "o", name: "r.js" }],
    ["https://gitlab.com/o/r", null],
    ["https://github.com.evil.com/o/r", null],
    ["file:///etc/passwd", null],
    ["o", null],
    ["", null],
    ["-o/r", null],
    ["o/..", null],
    ["o/r name", null],
    ["https://github.com/o", null],
    ["https://github.com/o/r/blob/%E0%A4%A/x.md", null],
  ];
  for (const [input, want] of cases) {
    test(JSON.stringify(input), () => {
      const got = parseGitHubRepo(input);
      if (!want) return expect(got).toBeNull();
      expect(got).toEqual({ owner: want.owner, name: want.name, kind: want.kind ?? null, rest: want.rest ?? [] });
    });
  }

  test("branch candidates, longest first; unsafe branch names are refused", () => {
    expect(branchCandidates(["feature", "x", "a.md"])).toEqual([
      { branch: "feature/x/a.md", path: "" },
      { branch: "feature/x", path: "a.md" },
      { branch: "feature", path: "x/a.md" },
    ]);
    for (const b of ["main", "feature/x", "v1.2", "release-2026_10", "user@fix"]) expect(validBranch(b)).toBe(true);
    for (const b of ["", "-x", "--upload-pack=evil", "a..b", "a//b", "a/", "/a", ".a", "a.lock", "a/.b", "a b", "a\nb", "x@{1}", "@", "a~1", "a^", "a:b", "a\\b"]) {
      expect(validBranch(b)).toBe(false);
    }
    expect(githubFileUrl("o", "r", "feature/x", "docs/a b.md")).toBe("https://github.com/o/r/blob/feature/x/docs/a%20b.md");
  });
});

// ---- partial clones ----

const up = upstreams(tmp);
const makeUpstream = up.make;
const githubGitUrl = (owner: string, name: string) => `${up.base}/${owner}/${name}.git`;
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Blobs at `ref` that are not on disk (without fetching them). */
async function missingBlobs(dir: string, ref: string) {
  const tree = await sh(["ls-tree", "-r", ref], dir, undefined, { GIT_NO_LAZY_FETCH: "1" });
  const oids = tree.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[2]!);
  const check = await sh(["cat-file", "--batch-check"], dir, oids.join("\n") + "\n", { GIT_NO_LAZY_FETCH: "1" });
  return check.split("\n").filter((l) => l.endsWith(" missing")).length;
}

describe("LocalGitStore: GitHub repos as partial clones", () => {
  test("clone downloads commits and trees only; reads fetch blobs lazily; listing, history, search and diff work", async () => {
    const big = "x".repeat(200_000);
    await makeUpstream("acme", "docs", { "README.md": "# Acme\n\nHello.\n", "guide/intro.md": "# Intro\n\nfind me\n", "logo.bin": big, "src/a.ts": "export {}\n" });
    const store = new LocalGitStore(join(tmp, "store"), githubGitUrl);
    await store.createRepo("gh-acme-docs", { branch: "main", github: { owner: "acme", name: "docs", branch: "main", publicReadOnly: true } });
    const dir = join(tmp, "store", "gh-acme-docs.git");
    expect(readdirSync(join(tmp, "store")).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect((await sh(["config", "remote.origin.promisor"], dir)).trim()).toBe("true");
    const head = (await store.head("gh-acme-docs", "main"))!;
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await missingBlobs(dir, head)).toBe(4);

    expect((await store.listFiles("gh-acme-docs", head)).sort()).toEqual(["README.md", "guide/intro.md", "logo.bin", "src/a.ts"]);
    expect(await missingBlobs(dir, head)).toBe(4);
    expect((await store.history("gh-acme-docs", "main", "README.md", 10)).map((c) => c.message)).toEqual(["Initial commit"]);
    expect(await missingBlobs(dir, head)).toBe(4);

    // One read fetches one blob.
    expect(await store.readFile("gh-acme-docs", "README.md", head)).toBe("# Acme\n\nHello.\n");
    expect(await missingBlobs(dir, head)).toBe(3);
    expect(await store.readFile("gh-acme-docs", "nope.md", head)).toBeNull();

    // Sizes and search fetch the Markdown blobs (in one go), never the rest.
    const meta = await store.listFilesWithMetadata("gh-acme-docs", head);
    expect(meta.sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { path: "README.md", size: 15 },
      { path: "guide/intro.md", size: 17 },
    ]);
    expect(await store.search("gh-acme-docs", head, "FIND", 10)).toEqual([{ path: "guide/intro.md", line: 3, text: "find me" }]);
    expect(await missingBlobs(dir, head)).toBe(2);
    const diff = await store.diff("gh-acme-docs", head);
    expect(diff).toContain("+# Intro");
    expect(diff).not.toContain("logo.bin");
    expect(await missingBlobs(dir, head)).toBe(2);
  });

  test("pullUpstream fetches new commits on the branch", async () => {
    const wiki = await makeUpstream("acme", "wiki", { "README.md": "v1\n" });
    const store = new LocalGitStore(join(tmp, "store"), githubGitUrl);
    await store.createRepo("gh-acme-wiki", { branch: "main", github: { owner: "acme", name: "wiki", branch: "main", publicReadOnly: true } });
    const before = await store.head("gh-acme-wiki", "main");
    await wiki.push({ "README.md": "v2\n", "new.md": "# New\n" }, "Second");
    await store.pullUpstream("gh-acme-wiki", "main");
    const after = (await store.head("gh-acme-wiki", "main"))!;
    expect(after).not.toBe(before);
    expect((await store.listFiles("gh-acme-wiki", after)).sort()).toEqual(["README.md", "new.md"]);
    expect(await store.readFile("gh-acme-wiki", "README.md", after)).toBe("v2\n");
    expect((await store.history("gh-acme-wiki", "main", undefined, 10)).map((c) => c.message)).toEqual(["Second", "Initial commit"]);
  });

  test("a clone that fails leaves nothing behind", async () => {
    const store = new LocalGitStore(join(tmp, "store"), githubGitUrl);
    await expect(store.createRepo("gh-acme-missing", { branch: "main", github: { owner: "acme", name: "missing", branch: "main" } })).rejects.toThrow();
    expect(existsSync(join(tmp, "store", "gh-acme-missing.git"))).toBe(false);
    expect(readdirSync(join(tmp, "store")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

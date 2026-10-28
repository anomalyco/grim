// GitHub repo references, and read-only GitHub copies as partial clones (against local "upstream" repos, no network).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { branchCandidates, githubFileUrl, parseGitHubRepo, validBranch } from "../../src/shared/github.ts";
import { pickNote } from "../../src/client/util.ts";
import { sh, upstreams } from "./upstream.ts";

// No server modules that load config here: test files share modules, and the others set their env first.
import { LocalGitStore } from "../../src/server/store/localgit.ts";
import { git } from "../../src/server/store/gitexec.ts";
import { FileTooLargeError, MAX_FILE_BYTES, StoreUnavailableError } from "../../src/server/store/types.ts";

const tmp = mkdtempSync(join(process.env.DATA_DIR!, "github-"));

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
    // A /blob/ URL names a file, so the last segment is never part of the branch.
    expect(branchCandidates(["feature", "x", "a.md"], "blob").map((c) => c.branch)).toEqual(["feature/x", "feature"]);
    expect(branchCandidates(["main"], "blob")).toEqual([]);
    for (const b of ["main", "feature/x", "v1.2", "release-2026_10", "user@fix"]) expect(validBranch(b)).toBe(true);
    for (const b of ["", "-x", "--upload-pack=evil", "a..b", "a//b", "a/", "/a", ".a", "a.lock", "a.lock/b", "a/b.lock/c", "a/.b", "a b", "a\nb", "x@{1}", "@", "a~1", "a^", "a:b", "a\\b"]) {
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

    // Sizes and search fetch the Markdown blobs (in a batch), never the rest.
    const meta = await store.listFilesWithMetadata("gh-acme-docs", head);
    expect(meta.sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { path: "README.md", size: 15 },
      { path: "guide/intro.md", size: 17 },
    ]);
    expect(await store.search("gh-acme-docs", head, "FIND", 10)).toEqual({ hits: [{ path: "guide/intro.md", line: 3, text: "find me" }] });
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

  test("reads tell a missing file from one GitHub can't send right now, and refuse huge files", async () => {
    const up = await makeUpstream("acme", "flaky", { "README.md": "# Flaky\n", "big.md": "x".repeat(MAX_FILE_BYTES + 1), "-notes.md": "dash\n" });
    const store = new LocalGitStore(join(tmp, "store"), githubGitUrl);
    await store.createRepo("gh-acme-flaky", { branch: "main", github: { owner: "acme", name: "flaky", branch: "main", publicReadOnly: true } });
    const head = (await store.head("gh-acme-flaky", "main"))!;
    expect(await store.readFile("gh-acme-flaky", "-notes.md", head)).toBe("dash\n");
    await expect(store.readFile("gh-acme-flaky", "big.md", head)).rejects.toBeInstanceOf(FileTooLargeError);
    // GitHub unreachable: existing files throw (transient), missing ones are still null.
    renameSync(up.bare, `${up.bare}.away`);
    try {
      await expect(store.readFile("gh-acme-flaky", "README.md", head)).rejects.toBeInstanceOf(StoreUnavailableError);
      expect(await store.readFile("gh-acme-flaky", "nope.md", head)).toBeNull();
      expect(await store.readFile("gh-acme-flaky", "-notes.md", head)).toBe("dash\n");
      // Search and listings degrade instead of failing.
      expect((await store.search("gh-acme-flaky", head, "flaky", 10)).incomplete).toContain("Searched 1 of 3");
    } finally {
      renameSync(`${up.bare}.away`, up.bare);
    }
    expect(await store.readFile("gh-acme-flaky", "README.md", head)).toBe("# Flaky\n");
  });

  test("listings, search and diffs download a bounded number of files per call", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 230; i++) files[`notes/n${String(i).padStart(3, "0")}.md`] = `# Note ${i}\nneedle ${i}\n`;
    files["UPPER.MD"] = "Needle upper\n";
    await makeUpstream("acme", "many", files);
    const store = new LocalGitStore(join(tmp, "store"), githubGitUrl);
    await store.createRepo("gh-acme-many", { branch: "main", github: { owner: "acme", name: "many", branch: "main", publicReadOnly: true } });
    const dir = join(tmp, "store", "gh-acme-many.git");
    const head = (await store.head("gh-acme-many", "main"))!;
    const first = await store.search("gh-acme-many", head, "needle", 1000);
    expect(first.incomplete).toContain("Searched 200 of 231");
    expect(first.hits).toHaveLength(200);
    expect(await missingBlobs(dir, head)).toBe(31);
    // The next call downloads the rest; .MD counts as Markdown.
    const second = await store.search("gh-acme-many", head, "needle", 1000);
    expect(second.incomplete).toBeUndefined();
    expect(second.hits).toHaveLength(231);
    expect(second.hits).toContainEqual({ path: "UPPER.MD", line: 1, text: "Needle upper" });
    expect((await store.listFilesWithMetadata("gh-acme-many", head)).length).toBe(231);
    expect(await store.diff("gh-acme-many", head)).toContain("+Needle upper");
  });

  test("read-only copies are shallow: history goes back to the cut, and its diff works", async () => {
    const up = await makeUpstream("acme", "long", { "README.md": "v0\n" });
    const work = join(tmp, "work-acme-long");
    await sh(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "--allow-empty", "-m", "filler"], work);
    for (let i = 1; i <= 205; i++) {
      await Bun.write(join(work, "README.md"), `v${i}\n`);
      await sh(["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "-am", `c${i}`], work);
    }
    await sh(["push", "-q", up.bare, "HEAD:main"], work);
    const store = new LocalGitStore(join(tmp, "store"), githubGitUrl);
    await store.createRepo("gh-acme-long", { branch: "main", github: { owner: "acme", name: "long", branch: "main", publicReadOnly: true } });
    const all = await store.history("gh-acme-long", "main", "README.md", 1000);
    expect(all).toHaveLength(200);
    expect(all[0]!.message).toBe("c205");
    expect(await store.diff("gh-acme-long", all[199]!.sha)).toContain("+v6");
    expect(await store.readFile("gh-acme-long", "README.md", all[0]!.sha)).toBe("v205\n");
  });

  test("paths starting with '-' work in ordinary repos too", async () => {
    const store = new LocalGitStore(join(tmp, "store"));
    await store.createRepo("dash", { branch: "main" });
    const r = await store.commit({ repo: "dash", branch: "main", expectedHead: null, changes: [{ path: "-notes.md", content: "hi\n" }, { path: "a*.md", content: "star\n" }, { path: "abc.md", content: "abc\n" }], message: "m", author: { name: "a", email: "a@b" } });
    expect(r.ok).toBe(true);
    const head = (await store.head("dash", "main"))!;
    expect(await store.readFile("dash", "-notes.md", head)).toBe("hi\n");
    expect(await store.history("dash", "main", "-notes.md", 5)).toHaveLength(1);
    expect(await store.diff("dash", head, "-notes.md")).toContain("+hi");
    // Paths are literal, not globs.
    expect(await store.diff("dash", head, "a*.md")).not.toContain("abc.md");
    await expect(store.commit({ repo: "dash", branch: "main", expectedHead: head, changes: [{ path: "a\nb.md", content: "x" }], message: "m", author: { name: "a", email: "a@b" } })).rejects.toThrow();
  });
});

describe("pickNote (the note the app opens first)", () => {
  const files = ["CHANGELOG.md", "README.md", "docs/README.md", "docs/a/deep.md", "docs/guide.md", "pkg/x/README.mdx", "pkg/x/z.md"];
  test("a /blob/ file, a /tree/ folder's README or shallowest note, Welcome.md, the root README", () => {
    expect(pickNote(files, { file: "docs/guide.md" })).toBe("docs/guide.md");
    expect(pickNote(files, { file: "docs/missing.md" })).toBe("docs/README.md");
    expect(pickNote(files, { folder: "pkg/x" })).toBe("pkg/x/README.mdx");
    expect(pickNote(files, { folder: "docs/a" })).toBe("docs/a/deep.md");
    expect(pickNote(files, { folder: "nope" })).toBe("README.md");
    expect(pickNote(["Welcome.md", ...files])).toBe("Welcome.md");
    expect(pickNote(["b/c.md", "z.md"])).toBe("z.md");
    expect(pickNote([])).toBeNull();
  });
});

describe("gitexec", () => {
  test("a timed-out command returns promptly even when a child process holds its pipes", async () => {
    const t0 = Date.now();
    const r = await git(["-c", "alias.nap=!sleep 30", "nap"], { timeoutMs: 300 });
    expect(r.code).toBe(124);
    expect(r.stderr).toContain("timed out");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// ---- lsRemote over smart HTTP ----

/** `info/refs?service=git-upload-pack` for anomalyco/grim as GitHub sent it (2026-10-28). */
const GRIM_REFS =
  "001e# service=git-upload-pack\n0000" +
  "015983041b1ea3703c312442be128d7aedc1fb2730b8 HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done symref=HEAD:refs/heads/main filter object-format=sha1 agent=git/github-f6e509caf74d-Linux\n" +
  "003d83041b1ea3703c312442be128d7aedc1fb2730b8 refs/heads/main\n" +
  "0000";

const pkt = (s: string) => (new TextEncoder().encode(s).length + 4).toString(16).padStart(4, "0") + s;
const sha = "a".repeat(40);
/** A bigger repo: a slashed default branch, refs before and after refs/heads/, peeled tags. */
const BIG_REFS =
  pkt("# service=git-upload-pack\n") +
  "0000" +
  pkt(`${sha} HEAD\0ofs-delta symref=HEAD:refs/heads/release/2026 agent=git/test\n`) +
  pkt(`${sha} refs/changes/1\n`) +
  pkt(`${sha} refs/heads/feature/ü\n`) +
  pkt(`${sha} refs/heads/main\n`) +
  pkt(`${sha} refs/heads/release/2026\n`) +
  pkt(`${sha} refs/pull/1/head\n`) +
  pkt(`${sha} refs/tags/v1\n`) +
  pkt(`${sha} refs/tags/v1^{}\n`) +
  "0000";
/** An empty repo advertises only its capabilities. */
const EMPTY_REFS = pkt("# service=git-upload-pack\n") + "0000" + pkt(`${"0".repeat(40)} capabilities^{}\0ofs-delta agent=git/test\n`) + "0000";

describe("lsRemote over smart HTTP", () => {
  test("parses GitHub's ref advertisement (HEAD symref, branches), stops after refs/heads/, and returns null when the repo can't be read", async () => {
    const hits: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        hits.push(`${url.pathname}${url.search}`);
        const advert = (body: string | ReadableStream) => new Response(body, { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
        switch (url.pathname) {
          case "/anomalyco/grim.git/info/refs":
            return advert(GRIM_REFS);
          case "/acme/empty.git/info/refs":
            return advert(EMPTY_REFS);
          case "/acme/big.git/info/refs": {
            // One byte at a time, then a body that never ends: lsRemote only returns if it stops reading at refs/pull/.
            const bytes = new TextEncoder().encode(BIG_REFS.slice(0, BIG_REFS.indexOf("refs/tags/v1\n")));
            let i = 0;
            return advert(
              new ReadableStream({
                pull(c) {
                  if (i < bytes.length) c.enqueue(bytes.subarray(i, ++i));
                },
              }),
            );
          }
          case "/acme/dumb.git/info/refs":
            return new Response(`${sha}\trefs/heads/main\n`);
          case "/acme/truncated.git/info/refs":
            return advert(GRIM_REFS.slice(0, 100));
          case "/acme/private.git/info/refs":
            return new Response("", { status: 401 });
          default:
            return new Response("Not Found", { status: 404 });
        }
      },
    });
    try {
      // github.ts loads config (and the db): run it in its own process, pointed at this fake GitHub.
      const script = `
        const { lsRemote, readRefAdvertisement } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/github.ts"))});
        const out = {
          grim: await lsRemote("anomalyco", "grim", ["main", "nope"]),
          grimDefault: await lsRemote("anomalyco", "grim"),
          big: await lsRemote("acme", "big", ["feature/ü", "release/2026", "main", "release", "pull/1/head", "v1"]),
          empty: await lsRemote("acme", "empty", ["main"]),
          dumb: await lsRemote("acme", "dumb", ["main"]),
          truncated: await lsRemote("acme", "truncated", ["main"]),
          private: await lsRemote("acme", "private", ["main"]),
          missing: await lsRemote("acme", "missing"),
          unreachable: await (async () => {
            const { config } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/config.ts"))});
            config.github.gitBase = "http://127.0.0.1:1";
            return lsRemote("anomalyco", "grim");
          })(),
          parsed: await readRefAdvertisement(new Response(${JSON.stringify(GRIM_REFS)}).body).then((r) => r && { head: r.head, heads: [...r.heads] }),
        };
        console.log(JSON.stringify(out));
      `;
      const dir = mkdtempSync(join(tmp, "lsremote-"));
      const proc = Bun.spawn([process.execPath, "--eval", script], {
        env: { ...process.env, DATA_DIR: dir, STORAGE: "local", GITHUB_GIT_BASE: `http://127.0.0.1:${server.port}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({
        grim: { defaultBranch: "main", branches: ["main"] },
        grimDefault: { defaultBranch: "main", branches: [] },
        big: { defaultBranch: "release/2026", branches: ["feature/ü", "release/2026", "main"] },
        empty: { defaultBranch: null, branches: [] },
        dumb: null,
        truncated: null,
        private: null,
        missing: null,
        unreachable: null,
        parsed: { head: "main", heads: ["main"] },
      });
      expect(hits).toContain("/anomalyco/grim.git/info/refs?service=git-upload-pack");
    } finally {
      server.stop(true);
    }
  });
});

// ---- GitHub imports: a resumable state machine ----

describe("GitHub imports", async () => {
  const { Database } = await import("bun:sqlite");
  const { readFileSync } = await import("node:fs");
  const { bunDb } = await import("../../src/server/bun/db-bun.ts");
  const { RepoBusyError } = await import("../../src/server/store/types.ts");
  const { RepoService, TimerImports, importStep, newImport, runDueImport, IMPORT_POLL_MS } = await import("../../src/server/repos.ts");
  type ImportState = import("../../src/server/repos.ts").ImportState;
  type ImportDeps = import("../../src/server/repos.ts").ImportDeps;

  function freshDb() {
    const sqlite = new Database(":memory:");
    sqlite.exec(readFileSync(join(import.meta.dir, "../../migrations/0001_init.sql"), "utf8"));
    return bunDb(sqlite);
  }
  const addRow = (db: ReturnType<typeof freshDb>, id: string, readOnly = 1) =>
    db.run("INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_at) VALUES (?, ?, 'github', 'acme', ?, ?, 'main', 'importing', 0)", id, id, id, readOnly);
  const status = async (db: ReturnType<typeof freshDb>, id: string) => db.get<{ status: string; error: string | null }>("SELECT status, error FROM repos WHERE id = ?", id);
  /** As a Durable Object would keep it between alarms. */
  const saved = (s: ImportState | null) => JSON.parse(JSON.stringify(s)) as ImportState | null;

  /** A Code Storage stand-in: busy for `busy` head reads, then the branch has `head`. */
  function fakeStore(opts: { busy?: number; files?: string[] } = {}) {
    const calls: string[] = [];
    let busy = opts.busy ?? 0;
    const store = {
      kind: "codestorage" as const,
      async createRepo(id: string) {
        calls.push(`create ${id}`);
      },
      async deleteRepo(id: string) {
        calls.push(`delete ${id}`);
      },
      async head() {
        calls.push("head");
        if (busy-- > 0) throw new RepoBusyError();
        return "c".repeat(40);
      },
      async listFiles() {
        return opts.files ?? ["README.md"];
      },
    };
    return { store: store as unknown as ImportDeps["store"], calls };
  }

  test("an import stopped between steps resumes from its saved state, and reports the finished head", async () => {
    const upstream = await makeUpstream("acme", "resume", { "README.md": "# Resume\n" });
    const db = freshDb();
    await addRow(db, "gh-acme-resume");
    const seen: Array<[string, string]> = [];
    const deps = (store: InstanceType<typeof LocalGitStore>): ImportDeps => ({ db, store, seenHead: async (id, head) => void seen.push([id, head]) });

    const first = deps(new LocalGitStore(join(tmp, "imports"), githubGitUrl));
    let s = saved(await importStep(first, newImport("gh-acme-resume", "acme", "resume", "main", true)));
    expect(s).toMatchObject({ phase: "create", branch: "main" });
    s = saved(await importStep(first, s!));
    expect(s).toMatchObject({ phase: "wait", polls: 0 });
    // A step that was cut short runs again from the same state: creating the copy twice is harmless.
    expect(saved(await importStep(first, { ...s!, phase: "create" }))).toEqual({ ...s!, at: expect.any(Number) });

    // "Restart": a new store over the same files, continuing from the saved state.
    const second = deps(new LocalGitStore(join(tmp, "imports"), githubGitUrl));
    const phases: Array<string | null> = [];
    while (s) {
      s = saved(await importStep(second, s));
      phases.push(s?.phase ?? null);
    }
    expect(phases).toEqual(["finish", null]);
    expect(await status(db, "gh-acme-resume")).toEqual({ status: "ready", error: null });
    const head = (await sh(["rev-parse", "main"], upstream.bare)).trim();
    expect(seen).toEqual([["gh-acme-resume", head]]);
  });

  test("head polls wait on the clock between alarms and keep their count across a restart", async () => {
    const db = freshDb();
    await addRow(db, "gh-acme-busy");
    let now = 1_000_000;
    const { store, calls } = fakeStore({ busy: 2 });
    const seen: string[] = [];
    const deps: ImportDeps = { db, store, seenHead: async (_id, head) => void seen.push(head), now: () => now };
    let box: ImportState | null = newImport("gh-acme-busy", "acme", "busy", "main", true, now);
    const durable = { get: () => saved(box), put: (s: ImportState | null) => void (box = saved(s)) };

    expect(await runDueImport(deps, durable)).toBe(now); // branch
    expect(await runDueImport(deps, durable)).toBe(now); // create
    expect(await runDueImport(deps, durable)).toBe(now + IMPORT_POLL_MS); // busy
    expect(box).toMatchObject({ phase: "wait", polls: 1 });
    // Not due yet: nothing is read.
    const heads = calls.filter((c) => c === "head").length;
    expect(await runDueImport(deps, durable)).toBe(now + IMPORT_POLL_MS);
    expect(calls.filter((c) => c === "head").length).toBe(heads);
    now += IMPORT_POLL_MS;
    expect(await runDueImport(deps, durable)).toBe(now + IMPORT_POLL_MS); // busy again
    expect(box).toMatchObject({ phase: "wait", polls: 2 });
    now += IMPORT_POLL_MS;
    expect(await runDueImport(deps, durable)).toBe(now); // head
    expect(await runDueImport(deps, durable)).toBeNull(); // finish
    expect(box).toBeNull();
    expect(await runDueImport(deps, durable)).toBeNull();
    expect(seen).toEqual(["c".repeat(40)]);
    expect(await status(db, "gh-acme-busy")).toEqual({ status: "ready", error: null });
    expect(calls).toEqual(["create gh-acme-busy", "head", "head", "head"]);
  });

  test("failures show on the workspace and drop a read-only copy; a workspace removed meanwhile leaves nothing", async () => {
    const db = freshDb();
    const seen: string[] = [];
    const run = async (deps: ImportDeps, s: ImportState | null) => {
      while (s) s = await importStep(deps, s);
    };

    await addRow(db, "gh-acme-code");
    const code = fakeStore({ files: ["src/a.ts"] });
    await run({ db, store: code.store, seenHead: async (_i, h) => void seen.push(h) }, newImport("gh-acme-code", "acme", "code", "main", true));
    expect(await status(db, "gh-acme-code")).toEqual({ status: "error", error: "No Markdown files in acme/code on main" });
    expect(code.calls).toContain("delete gh-acme-code");

    // An editable link keeps its copy, so a retry can reuse it.
    await addRow(db, "gh-acme-edit", 0);
    const edit = fakeStore({ files: [] });
    await run({ db, store: edit.store, seenHead: async (_i, h) => void seen.push(h) }, newImport("gh-acme-edit", "acme", "edit", "main", false));
    expect((await status(db, "gh-acme-edit"))!.status).toBe("error");
    expect(edit.calls).not.toContain("delete gh-acme-edit");

    // Never had a head: gives up after the last poll.
    await addRow(db, "gh-acme-empty");
    const empty = fakeStore({ busy: Infinity });
    let s: ImportState | null = { ...newImport("gh-acme-empty", "acme", "empty", "main", true), phase: "wait", polls: 199 };
    s = await importStep({ db, store: empty.store, seenHead: async () => {} }, s);
    expect(s).toBeNull();
    expect(await status(db, "gh-acme-empty")).toEqual({ status: "error", error: "acme/empty has no commits on main" });

    // Removed while copying.
    const gone = fakeStore();
    const deps: ImportDeps = { db, store: gone.store, seenHead: async (_i, h) => void seen.push(h) };
    expect(await importStep(deps, { ...newImport("gh-acme-gone", "acme", "gone", "main", true), phase: "create" })).toBeNull();
    expect(gone.calls).toEqual(["create gh-acme-gone", "delete gh-acme-gone"]);
    expect(await importStep(deps, newImport("gh-acme-gone", "acme", "gone", "main", true))).toBeNull();
    expect(seen).toEqual([]);
  });

  test("Bun: TimerImports runs at most `max` at a time on timers; RepoService reports the head through its host", async () => {
    const db = freshDb();
    const { store } = fakeStore({ busy: 1 });
    const seen: string[] = [];
    const imports = new TimerImports({ db, store, seenHead: async (id) => void seen.push(id), pollMs: 20 }, 1);
    for (const id of ["gh-acme-t1", "gh-acme-t2"]) {
      await addRow(db, id);
      imports.start(newImport(id, "acme", id, "main", true));
    }
    expect(imports.running).toBe(1);
    for (let i = 0; i < 200 && seen.length < 2; i++) await Bun.sleep(10);
    expect(seen).toEqual(["gh-acme-t1", "gh-acme-t2"]);
    expect(imports.running).toBe(0);

    // The default scheduler, through linkGitHub, against a local "GitHub".
    await makeUpstream("acme", "linked", { "README.md": "# Linked\n" });
    const local = new LocalGitStore(join(tmp, "imports"), githubGitUrl);
    const reported: Array<[string, string | null]> = [];
    const host = { get: (id: string) => ({ seenHead: async (head: string | null) => void reported.push([id, head]) }) };
    const repos = new RepoService(local, null as never, db, host as never);
    const { repo } = await repos.linkGitHub("acme", "linked", { branch: "main", publicReadOnly: true, userId: "u1" });
    expect(repo.status).toBe("importing");
    for (let i = 0; i < 200 && reported.length === 0; i++) await Bun.sleep(10);
    expect((await repos.get(repo.id))!.status).toBe("ready");
    expect(reported).toEqual([[repo.id, await local.head(repo.id, "main")]]);
  });
});

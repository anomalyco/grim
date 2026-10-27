// Image uploads (POST /api/repos/:id/images): who may upload where, type sniffing, the size cap, safe names,
// de-duplication, the commit, rate limiting, and the stores' writeBlob.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isolate } from "./helpers.ts";

process.env.QUIET_MS = "100";
process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db: earlyDb } = await import("../../src/server/db.ts");
const restore = isolate(config, earlyDb);
Object.assign(config, { storage: "local", allowDevLogin: true, allowedUsers: ["*"], quietMs: 100, pollMs: 60000, notesRepo: "img-notes", signin: "open", allowedEmails: [] });
config.github.clientId = "";
config.github.appSlug = "";
const { startServer } = await import("../../src/server/index.ts");
const { db } = await import("../../src/server/db.ts");
const { uploadLimits } = await import("../../src/server/api.ts");
const { sniffImage, uploadName, encodeLinkPath } = await import("../../src/server/ops.ts");
const { CodeStorageStore } = await import("../../src/server/store/codestorage.ts");

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
/** A different valid-looking PNG (same header, other bytes). */
const png = (tag: string) => new Uint8Array([...PNG, ...new TextEncoder().encode(tag)]);
const bytesOf = (s: string) => new TextEncoder().encode(s);

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";

interface Person {
  cookie: string;
  id: string;
  name: string;
}

async function person(name: string, opts: { email?: string } = {}): Promise<Person> {
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name }), redirect: "manual" });
  const cookie = res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
  const id = (await api(cookie, "GET", "/api/me")).data.id;
  db.query("UPDATE users SET email = COALESCE(?, email), email_verified = 1 WHERE id = ?").run(opts.email ?? null, id);
  return { cookie, id, name };
}

async function api(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

/** Upload `bytes` as `name` for `note` (raw body, same-origin like the browser). */
async function upload(cookie: string, ws: string, note: string, name: string, bytes: Uint8Array | Blob, extra = "") {
  const res = await fetch(`${base}/api/repos/${ws}/images?${new URLSearchParams({ note, name })}${extra}`, {
    method: "POST",
    headers: { cookie, origin: base, "content-type": "application/octet-stream" },
    body: bytes as BodyInit,
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, headers: res.headers };
}

async function workspace(owner: Person, title: string, files: Record<string, string> = { "n.md": "# N\n" }) {
  const r = await api(owner.cookie, "POST", "/api/workspaces", { title });
  expect(r.status).toBe(201);
  const id = r.data.id as string;
  await app.ctx.store.commit({
    repo: id,
    branch: "main",
    expectedHead: await app.ctx.store.head(id, "main"),
    changes: Object.entries(files).map(([path, content]) => ({ path, content })),
    message: "seed",
    author: { name: "x", email: "x@example.com" },
  });
  return id;
}

const raw = async (cookie: string, ws: string, path: string, extra = "") => {
  const res = await fetch(`${base}/api/repos/${ws}/raw?path=${encodeURIComponent(path)}${extra}`, { headers: { cookie } });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
};

const defaultLimit = uploadLimits.perMinute;

beforeAll(async () => {
  // (the rate limit has its own test)
  uploadLimits.perMinute = 1000;
  app = await startServer({ port: 0, quiet: true });
  base = `http://localhost:${app.server.port}`;
});

afterAll(async () => {
  uploadLimits.perMinute = defaultLimit;
  await app?.stop();
  restore();
});

describe("who may upload", () => {
  let owner: Person, editor: Person, viewer: Person, outsider: Person;
  let ws = "";

  beforeAll(async () => {
    owner = await person("Img Owner");
    editor = await person("Img Editor", { email: "editor@img.example" });
    viewer = await person("Img Viewer", { email: "viewer@img.example" });
    outsider = await person("Img Outsider");
    ws = await workspace(owner, "IMG Roles", { "n.md": "# N\n", "other.md": "# O\n" });
    await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "editor@img.example", role: "editor" });
    await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "viewer@img.example", role: "viewer" });
  });

  test("owners and editors upload; viewers get 403, outsiders 404; signed out 401", async () => {
    const o = await upload(owner.cookie, ws, "n.md", "o.png", png("o"));
    expect(o.status).toBe(201);
    expect(o.data).toEqual({ path: "images/o.png", markdownPath: "images/o.png", markdown: "![o](images/o.png)", reused: false });
    expect((await upload(editor.cookie, ws, "n.md", "e.png", png("e"))).status).toBe(201);
    expect((await upload(viewer.cookie, ws, "n.md", "v.png", png("v"))).status).toBe(403);
    expect((await upload(outsider.cookie, ws, "n.md", "x.png", png("x"))).status).toBe(404);
    expect((await upload("", ws, "n.md", "x.png", png("x"))).status).toBe(401);
    // cross-origin form posts are refused like every state-changing request
    const res = await fetch(`${base}/api/repos/${ws}/images?note=n.md&name=c.png`, { method: "POST", headers: { cookie: owner.cookie, origin: "https://evil.example" }, body: png("c") });
    expect(res.status).toBe(403);
    const tree = (await api(owner.cookie, "GET", `/api/repos/${ws}/tree`)).data.files;
    expect(tree.every((f: string) => f.endsWith(".md"))).toBe(true);
  });

  test("link access: edit uploads, view doesn't", async () => {
    const guest = await person("Img Guest");
    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "edit" });
    expect((await upload(guest.cookie, ws, "n.md", "g.png", png("g"))).status).toBe(201);
    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "view" });
    expect((await upload(guest.cookie, ws, "n.md", "g2.png", png("g2"))).status).toBe(403);
    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "none" });
  });

  test("note links: an editor link uploads next to its note only; a viewer link can't", async () => {
    const edit = (await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, { kind: "note", path: "n.md", role: "editor" })).data;
    const view = (await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, { kind: "note", path: "n.md", role: "viewer" })).data;
    const ok = await upload(outsider.cookie, ws, "n.md", "l.png", png("l"), `&share=${edit.id}`);
    expect(ok.status).toBe(201);
    expect(ok.data.path).toBe("images/l.png");
    expect((await upload(outsider.cookie, ws, "other.md", "l2.png", png("l2"), `&share=${edit.id}`)).status).toBe(403);
    expect((await upload(outsider.cookie, ws, "n.md", "l3.png", png("l3"), `&share=${view.id}`)).status).toBe(403);
    // a viewer member with an editor link to n.md may add images to n.md, not elsewhere
    expect((await upload(viewer.cookie, ws, "n.md", "vl.png", png("vl"), `&share=${edit.id}`)).status).toBe(201);
    expect((await upload(viewer.cookie, ws, "other.md", "vl2.png", png("vl2"), `&share=${edit.id}`)).status).toBe(403);
  });

  test("agent links don't open the API, and the agent shell still only sees Markdown", async () => {
    const agent = (await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, { label: "Bot" })).data;
    expect((await upload(outsider.cookie, ws, "n.md", "a.png", png("a"), `&share=${agent.id}`)).status).toBe(404);
    const res = await fetch(`${base}/api/repos/${ws}/images?note=n.md&name=a.png`, { method: "POST", headers: { "x-grimoire-share": agent.id, origin: base }, body: png("a") });
    expect(res.status).toBe(401);
    const run = async (cmd: string) => (await (await fetch(`${base}/a/${agent.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: cmd }) })).json()) as any;
    const ls = await run("ls -R; ls images 2>&1");
    expect(ls.stdout).not.toContain(".png");
  });

  test("read-only workspaces refuse uploads", async () => {
    const ro = await workspace(owner, "IMG RO");
    db.query("UPDATE repos SET read_only = 1 WHERE id = ?").run(ro);
    expect((await upload(owner.cookie, ro, "n.md", "r.png", png("r"))).status).toBe(403);
    db.query("UPDATE repos SET read_only = 0 WHERE id = ?").run(ro);
  });
});

describe("what is stored", () => {
  let owner: Person;
  let ws = "";

  beforeAll(async () => {
    owner = await person("Img Store");
    ws = await workspace(owner, "IMG Store", { "n.md": "# N\n", "sub/deep/note.md": "# D\n" });
  });

  test("types come from the bytes, not the name", async () => {
    const svg = bytesOf('<?xml version="1.0"?>\n<!-- hi -->\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>');
    const cases: Array<[string, Uint8Array, number, string?]> = [
      ["p.png", PNG, 201, "images/p.png"],
      ["wrong.jpg", png("wrong"), 201, "images/wrong.png"],
      ["noext", png("noext"), 201, "images/noext.png"],
      ["Shot.PNG", png("shot"), 201, "images/Shot.PNG"],
      ["j.jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 201, "images/j.jpeg"],
      ["g.gif", bytesOf("GIF89a\x01\x00\x01\x00"), 201, "images/g.gif"],
      ["w.webp", bytesOf("RIFF\x10\x00\x00\x00WEBPVP8 "), 201, "images/w.webp"],
      ["a.avif", new Uint8Array([0, 0, 0, 0x1c, ...bytesOf("ftypavif"), 0, 0, 0, 0, ...bytesOf("avifmif1miaf")]), 201, "images/a.avif"],
      ["b.bmp", new Uint8Array([...bytesOf("BM"), ...new Array(30).fill(0)]), 201, "images/b.bmp"],
      ["i.ico", new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]), 201, "images/i.ico"],
      ["s.svg", svg, 201, "images/s.svg"],
      ["fake.png", bytesOf("hello, not an image"), 415],
      ["page.svg", bytesOf("<html><svg></svg></html>"), 415],
      ["heic.avif", new Uint8Array([0, 0, 0, 0x18, ...bytesOf("ftypheic"), 0, 0, 0, 0, ...bytesOf("mif1heic")]), 415],
      ["bin.svg", new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20, 0xff, 0xfe, 0x00]), 415],
      ["empty.png", new Uint8Array(), 400],
    ];
    for (const [name, bytes, status, path] of cases) {
      const r = await upload(owner.cookie, ws, "n.md", name, bytes);
      expect([name, r.status, r.data.path]).toEqual([name, status, path]);
    }
    // SVGs are stored as they are and served sandboxed
    const res = await fetch(`${base}/api/repos/${ws}/raw?path=images/s.svg`, { headers: { cookie: owner.cookie } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(svg);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("size cap: 413 above 10 MB, from the header or the stream", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await upload(owner.cookie, ws, "n.md", "big.png", big)).status).toBe(413);
    // without a content-length (streamed)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big.subarray(0, 6 * 1024 * 1024));
        c.enqueue(big.subarray(6 * 1024 * 1024));
        c.close();
      },
    });
    const res = await fetch(`${base}/api/repos/${ws}/images?note=n.md&name=big.png`, { method: "POST", headers: { cookie: owner.cookie, origin: base }, body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    const ok = new Uint8Array(10 * 1024 * 1024);
    ok.set(PNG);
    expect((await upload(owner.cookie, ws, "n.md", "max.png", ok)).status).toBe(201);
  });

  test("names can't leave the images folder; bad note paths are refused", async () => {
    const cases: Array<[string, string]> = [
      ["../../evil.png", "images/evil.png"],
      ["..\\..\\win.png", "images/win.png"],
      [".git/config.png", "images/config.png"],
      [".gitignore.png", "images/gitignore.png"],
      ["...png", "images/image.png"],
      ["a\u0000b\n.png", "images/ab.png"],
    ];
    for (const [name, path] of cases) expect([name, (await upload(owner.cookie, ws, "n.md", name, png(name))).data.path]).toEqual([name, path]);
    expect((await upload(owner.cookie, ws, "../n.md", "t.png", png("t"))).status).toBe(400);
    expect((await upload(owner.cookie, ws, ".git/n.md", "t.png", png("t"))).status).toBe(400);
    expect((await upload(owner.cookie, ws, "", "t.png", png("t"))).status).toBe(400);
    const files = await app.ctx.store.listFiles(ws, (await app.ctx.store.head(ws, "main"))!);
    expect(files.every((f) => !f.startsWith(".git") && !f.includes(".."))).toBe(true);
  });

  test("next to the note, de-duplicated by content, Markdown percent-encoded", async () => {
    const note = "sub/deep/note.md";
    const A = png("A");
    const B = png("B");
    const first = await upload(owner.cookie, ws, note, "cat photo (1).png", A);
    expect(first.data).toEqual({ path: "sub/deep/images/cat photo (1).png", markdownPath: "images/cat%20photo%20%281%29.png", markdown: "![cat photo (1)](images/cat%20photo%20%281%29.png)", reused: false });
    const commits = async () => (await api(owner.cookie, "GET", `/api/repos/${ws}/history?limit=200`)).data.length;
    const before = await commits();
    expect((await upload(owner.cookie, ws, note, "cat photo (1).png", A)).data).toMatchObject({ path: first.data.path, reused: true });
    expect(await commits()).toBe(before);
    expect((await upload(owner.cookie, ws, note, "cat photo (1).png", B)).data).toMatchObject({ path: "sub/deep/images/cat photo (1)-2.png", markdown: "![cat photo (1)](images/cat%20photo%20%281%29-2.png)", reused: false });
    expect((await upload(owner.cookie, ws, note, "cat photo (1).png", B)).data).toMatchObject({ path: "sub/deep/images/cat photo (1)-2.png", reused: true });
    expect((await upload(owner.cookie, ws, note, "cat photo (1).png", png("C"))).data.path).toBe("sub/deep/images/cat photo (1)-3.png");
    expect((await upload(owner.cookie, ws, note, "why?#[x].png", png("q"))).data.markdown).toBe("![why?#\\[x\\]](images/why%3F%23[x].png)");
    // the image is in the repo with its own commit, by the uploader
    const got = await raw(owner.cookie, ws, "sub/deep/images/cat photo (1).png");
    expect(got.status).toBe(200);
    expect(got.bytes).toEqual(A);
    const hist = (await api(owner.cookie, "GET", `/api/repos/${ws}/history?limit=200`)).data;
    expect(hist.filter((c: any) => c.message.includes("cat photo (1)-2")).map((c: any) => [c.message, c.authorName])).toEqual([["Add sub/deep/images/cat photo (1)-2.png", "Img Store"]]);
    // concurrent uploads of the same name and different contents get different names
    const rs = await Promise.all(["x", "y", "z"].map((t) => upload(owner.cookie, ws, "n.md", "same.png", png(t))));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(rs.map((r) => r.data.path).sort()).toEqual(["images/same-2.png", "images/same-3.png", "images/same.png"]);
  });

  test("multipart form data works too", async () => {
    const form = new FormData();
    form.append("file", new File([png("form")], "from form.png", { type: "image/png" }));
    const res = await fetch(`${base}/api/repos/${ws}/images?note=n.md`, { method: "POST", headers: { cookie: owner.cookie, origin: base }, body: form });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).markdown).toBe("![from form](images/from%20form.png)");
    const empty = await fetch(`${base}/api/repos/${ws}/images?note=n.md`, { method: "POST", headers: { cookie: owner.cookie, origin: base }, body: new FormData() });
    expect(empty.status).toBe(400);
  });

  test("uploads are rate limited per person", async () => {
    const saved = uploadLimits.perMinute;
    uploadLimits.perMinute = 2;
    try {
      const p = await person("Img Busy");
      const w = await workspace(p, "IMG Busy");
      expect((await upload(p.cookie, w, "n.md", "1.png", png("1"))).status).toBe(201);
      expect((await upload(p.cookie, w, "n.md", "2.png", png("2"))).status).toBe(201);
      const third = await upload(p.cookie, w, "n.md", "3.png", png("3"));
      expect(third.status).toBe(429);
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
      // someone else isn't affected
      const q = await person("Img Calm");
      expect((await upload(q.cookie, await workspace(q, "IMG Calm"), "n.md", "1.png", png("1"))).status).toBe(201);
    } finally {
      uploadLimits.perMinute = saved;
    }
  });
});

describe("helpers", () => {
  test("sniffing, names and link encoding", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(bytesOf("\uFEFF  <svg/>"))).toBe("svg");
    expect(sniffImage(bytesOf('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg>'))).toBe("svg");
    expect(sniffImage(bytesOf("<svgfoo>"))).toBe(null);
    expect(sniffImage(new Uint8Array([0, 0, 2, 0, 1, 0]))).toBe(null);
    expect(uploadName("photo.jpeg", "jpg")).toEqual({ name: "photo.jpeg", stem: "photo", ext: "jpeg" });
    expect(uploadName("photo.final", "png").name).toBe("photo.final.png");
    expect(uploadName("x".repeat(300) + ".png", "png").name).toBe("x".repeat(100) + ".png");
    expect(encodeLinkPath("a b(c)%d.png")).toBe("a%20b%28c%29%25d.png");
    expect(encodeLinkPath("é ok.png")).toBe("é%20ok.png");
    expect(encodeLinkPath("why?#2.png")).toBe("why%3F%232.png");
  });
});

describe("stores", () => {
  test("local: writeBlob commits the bytes as they are", async () => {
    const owner = await person("Img Local");
    const ws = await workspace(owner, "IMG Local");
    const bin = new Uint8Array(256).map((_, i) => i);
    const head = await app.ctx.store.head(ws, "main");
    const r = await app.ctx.store.writeBlob({ repo: ws, branch: "main", expectedHead: head, path: "images/bin.png", bytes: bin, message: "Add images/bin.png", author: { name: "A", email: "a@example.com" } });
    expect(r.ok).toBe(true);
    expect(await app.ctx.store.readBlob(ws, "images/bin.png", (await app.ctx.store.head(ws, "main"))!, 1000)).toEqual(bin);
    // compare-and-swap like commit
    expect((await app.ctx.store.writeBlob({ repo: ws, branch: "main", expectedHead: head, path: "images/x.png", bytes: bin, message: "x", author: { name: "A", email: "a@example.com" } })).ok).toBe(false);
  });

  test("Code Storage: writeBlob sends the bytes with addFile, text still goes through addFileFromString", async () => {
    const calls: unknown[][] = [];
    const builder: any = {
      addFile: (...a: unknown[]) => (calls.push(["addFile", ...a]), builder),
      addFileFromString: (...a: unknown[]) => (calls.push(["addFileFromString", ...a]), builder),
      deletePath: (...a: unknown[]) => (calls.push(["deletePath", ...a]), builder),
      send: async () => ({ commitSha: "abc123" }),
    };
    const repo = { createCommit: (opts: unknown) => (calls.push(["createCommit", opts]), builder) };
    const store = Object.create(CodeStorageStore.prototype) as InstanceType<typeof CodeStorageStore>;
    (store as any).handles = new Map([["r1", repo]]);
    const bytes = new Uint8Array([1, 2, 3]);
    const r = await store.writeBlob({ repo: "r1", branch: "main", expectedHead: "h0", path: "images/a.png", bytes, message: "Add images/a.png", author: { name: "U", email: "u@example.com" } });
    expect(r).toEqual({ ok: true, sha: "abc123" });
    expect(calls[0]).toEqual(["createCommit", expect.objectContaining({ targetBranch: "main", commitMessage: "Add images/a.png", author: { name: "U", email: "u@example.com" }, expectedHeadSha: "h0" })]);
    expect(calls[1]).toEqual(["addFile", "images/a.png", bytes]);
    await store.commit({ repo: "r1", branch: "main", expectedHead: null, changes: [{ path: "n.md", content: "hi" }], message: "m", author: { name: "U", email: "u@example.com" } });
    expect(calls.at(-1)).toEqual(["addFileFromString", "n.md", "hi"]);
  });
});

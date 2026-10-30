// Content negotiation on note URLs (src/server/note-url.ts): /app/<workspace>/<path> answers the app to browsers and
// the note's Markdown (live), a folder listing, an image's bytes or a plain 404 to everything else.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isolate, room, seedNotebook, waitFor } from "./helpers.ts";

process.env.QUIET_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db: earlyDb } = await import("../../src/server/db.ts");
const restore = isolate(config, earlyDb);
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: true, quietMs: 60_000 });
const { startServer } = await import("../../src/server/index.ts");
const { wantsApp } = await import("../../src/server/note-url.ts");

const WS = "curl-notes";
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
  base = `http://localhost:${app.server.port}`;
  await seedNotebook(app.ctx, WS);
  const head = await app.ctx.store.head(WS, "main");
  await app.ctx.store.commit({
    repo: WS,
    branch: "main",
    expectedHead: head,
    changes: [
      { path: "shell-background/plan.md", content: "# Plan\n\nStep one.\n" },
      { path: "shell-background/notes.md", content: "notes\n" },
      { path: "images/a.png", content: PNG },
    ],
    message: "Seed",
    author: { name: "Test", email: "test@example.com" },
  });
});
afterAll(async () => {
  await app?.stop();
  restore();
});

const get = (path: string, accept?: string) => fetch(`${base}${path}`, { headers: accept === undefined ? {} : { accept } });

describe("wantsApp", () => {
  const ask = (accept: string | null, q = "") => wantsApp(new Request(`http://x/app/w/n.md${q}`, { headers: accept === null ? {} : { accept } }), new URL(`http://x/app/w/n.md${q}`));
  test("browsers get the app; curl, markdown and plain text don't", () => {
    expect(ask(BROWSER)).toBe(true);
    expect(ask("application/xhtml+xml")).toBe(true);
    expect(ask("*/*")).toBe(false);
    expect(ask(null)).toBe(false);
    expect(ask("text/markdown")).toBe(false);
    expect(ask("text/plain")).toBe(false);
    expect(ask("text/html;q=0, */*")).toBe(false);
    expect(ask(BROWSER, "?raw=1")).toBe(false);
  });
});

describe("note URLs", () => {
  test("a note is its Markdown, with Vary: Accept and no caching", async () => {
    const res = await get(`/app/${WS}/shell-background/plan.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("# Plan\n\nStep one.\n");
  });

  test("without .md, as the app's links resolve", async () => {
    expect(await (await get(`/app/${WS}/shell-background/plan`, "text/markdown")).text()).toBe("# Plan\n\nStep one.\n");
  });

  test("a browser gets the app, varying on Accept; ?raw=1 the note", async () => {
    const res = await get(`/app/${WS}/shell-background/plan.md`, BROWSER);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("vary")).toContain("Accept");
    expect(await res.text()).toContain("<!doctype html>");
    expect(await (await get(`/app/${WS}/shell-background/plan.md?raw=1`, BROWSER)).text()).toBe("# Plan\n\nStep one.\n");
    expect((await get("/app", "*/*")).headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("folders and the workspace list their notes", async () => {
    const dir = await get(`/app/${WS}/shell-background`);
    expect(dir.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await dir.text()).toBe("shell-background/notes.md\nshell-background/plan.md\n");
    expect(await (await get(`/app/${WS}`)).text()).toBe("Welcome.md\nshell-background/notes.md\nshell-background/plan.md\n");
  });

  test("missing notes, workspaces and other files are plain 404s", async () => {
    for (const [path, body] of [
      [`/app/${WS}/nope.md`, "Not found: nope.md\n"],
      [`/app/no-such-workspace/x.md`, "Not found: no-such-workspace\n"],
      [`/app/${WS}/data.txt`, "Not found: data.txt\n"],
    ]) {
      const res = await get(path!);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await res.text()).toBe(body!);
    }
  });

  test("images are their bytes, served like /raw", async () => {
    const res = await get(`/app/${WS}/images/a.png`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  test("the demo has nothing to fetch, and makes no room", async () => {
    const res = await get("/app/demo/Welcome.md");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("room of their own");
  });

  test("live edits not saved yet are in the answer", async () => {
    const login = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Typist" }), redirect: "manual" });
    const cookie = login.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
    const c = room(base, { repo: WS, path: "shell-background/plan.md" }, { origin: base, cookie });
    await waitFor(() => c.text.toString().length > 0);
    c.text.insert(c.text.length, "Typed live.\n");
    await waitFor(async () => (await (await get(`/app/${WS}/shell-background/plan.md`)).text()).endsWith("Typed live.\n"));
    expect(await app.ctx.store.readFile(WS, "shell-background/plan.md", (await app.ctx.store.head(WS, "main"))!)).toBe("# Plan\n\nStep one.\n");
    c.close();
  });
});

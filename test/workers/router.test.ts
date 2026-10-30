// The Worker router in Miniflare 5, configured from wrangler.jsonc itself (compat flags, aliases, assets with
// run_worker_first, the staged asset dir, Durable Object and D1 bindings): API through createApp on D1, WebSocket
// admission and forwarding, HubDO / HomeDO routing, the raw-image cache and the static site.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { sha256 } from "../../src/server/ids.ts";
import { migrationStatements, localConfig } from "./miniflare.ts";

const ROOT = join(import.meta.dir, "../..");
const ORIGIN = "http://test.local";
const COOKIE = "np_session=tok-alice";

let mf: Miniflare;
let base: string;
let outdir: string;

beforeAll(async () => {
  const cfg = localConfig();
  // the client build and wrangler's build step (stages .wrangler/assets), as `wrangler dev` would run them
  if (!existsSync(join(ROOT, "dist/index.html")) || !existsSync(join(ROOT, "dist/main.js"))) run(["bun", "run", "build:client"]);
  run(["sh", "-c", cfg.build.command!]);

  outdir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-router-"));
  const alias = cfg.alias ?? {};
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "router.worker.js")],
    outdir,
    target: "browser",
    format: "esm",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    plugins: [
      {
        name: "wrangler-alias",
        setup(b) {
          const keys = Object.keys(alias).map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
          b.onResolve({ filter: new RegExp(`^(?:${keys.join("|")})$`) }, (a) => ({ path: resolve(ROOT, alias[a.path]!) }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundling the router test Worker failed");

  // what wrangler dev would give Miniflare for this config (the parts a bundled module Worker needs)
  const { compatibilityDate, compatibilityFlags, bindings, d1Databases, durableObjects, assets } = unstable_getMiniflareWorkerOptions(cfg).workerOptions as Record<string, unknown>;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      workers: [{ compatibilityDate, compatibilityFlags, bindings: { ...(bindings as object), SERVER_NAME: "router-test" }, d1Databases, durableObjects, assets, name: "grim-router", modules: true, scriptPath: built.outputs[0]!.path, modulesRoot: outdir }],
    } as never),
  );
  base = (await mf.ready).toString().replace(/\/$/, "");
  const db = await mf.getD1Database("DB");
  await db.batch(migrationStatements().map((s) => db.prepare(s)));
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO users (id, login, name, email, created_at) VALUES ('u1', 'alice', 'Alice', 'alice@example.com', ?)").bind(now),
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'u1', ?)").bind(sha256("tok-alice"), now + 3_600_000),
    db.prepare("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('ws1', 'One', 'notes', 'main', 'ready', ?)").bind(now),
    db.prepare("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('busy', 'Busy', 'notes', 'main', 'importing', ?)").bind(now),
  ]);
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  if (outdir) rmSync(outdir, { recursive: true, force: true });
  rmSync(join(ROOT, ".wrangler/assets"), { recursive: true, force: true });
});

function run(cmd: string[]) {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${p.stderr.toString()}`);
}

const get = (path: string, headers: Record<string, string> = {}) => mf.dispatchFetch(ORIGIN + path, { headers }) as unknown as Promise<Response>;

/** A WebSocket through dispatchFetch: its messages and how it closed. */
async function ws(path: string, headers: Record<string, string>) {
  const res = (await mf.dispatchFetch(ORIGIN + path, { headers: { upgrade: "websocket", ...headers } })) as unknown as Response & { webSocket: WebSocket | null };
  const socket = res.webSocket;
  if (!socket) return { status: res.status, messages: [] as string[], closed: Promise.resolve({ code: 0, reason: "" }), socket: null };
  const messages: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((done) => socket.addEventListener("close", (e) => done({ code: e.code, reason: e.reason })));
  socket.addEventListener("message", (e) => messages.push(String(e.data)));
  (socket as unknown as { accept(): void }).accept();
  return { status: res.status, messages, closed, socket };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("API", () => {
  test("/api/server answers from createApp (config from the Worker's vars), with Server-Timing", async () => {
    const res = await get("/api/server");
    expect(res.status).toBe(200);
    // config.ts reads process.env at import: Worker vars and secrets are there already
    expect(((await res.json()) as { name: string }).name).toBe("router-test");
    expect(res.headers.get("server-timing")).toMatch(/^app;dur=\d+(\.\d)?, isolate;dur=0;desc="\d+ earlier requests, first \d+ s ago"$/);
  });

  test("signed-in reads go through D1 (a session cookie and a workspace row)", async () => {
    const res = await get("/api/repos/ws1", { cookie: COOKIE });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("ws1");
    expect((await get("/api/repos/nope")).status).toBe(404);
  });

  test("shell, MCP and share links refuse unknown links and signed-out callers in the Worker", async () => {
    expect((await get("/a/some-link")).status).toBe(404);
    expect((await get("/a/1b4e28ba-2fa1-41d2-883f-0016d3cca427")).status).toBe(404);
    expect((await mf.dispatchFetch(ORIGIN + "/api/shell", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await mf.dispatchFetch(ORIGIN + "/mcp", { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("raw images by commit come from the cache the second time", async () => {
    const { sha } = (await (await get("/api/__test/seed?repo=ws1")).json()) as { sha: string };
    const path = `/api/repos/ws1/raw?path=img.png&ref=${sha}`;
    const first = await get(path);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("server-timing")).toContain("cache;desc=miss");
    expect(new Uint8Array(await first.arrayBuffer())).toHaveLength(12);
    await get("/api/__test/unseed?repo=ws1");
    await until(async () => (await get(path)).headers.get("server-timing")?.includes("cache;desc=hit") ?? false);
    const hit = await get(path);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-type")).toBe("image/png");
    expect(hit.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await hit.arrayBuffer())).toHaveLength(12);
    // a branch name is not a commit: never cached
    expect((await get("/api/repos/ws1/raw?path=img.png&ref=main")).headers.get("server-timing")).not.toContain("cache;");
  });

  test("scheduled() runs", async () => {
    const worker = await mf.getWorker("grim-router");
    const r = (await worker.scheduled({ cron: "*/5 * * * *" })) as { outcome: string };
    expect(r.outcome).toBe("ok");
  });
});

describe("/ws admission", () => {
  test("not an upgrade: 426", async () => {
    expect((await get("/ws?repo=ws1&path=a.md")).status).toBe(426);
  });

  test("rejections close with their code after the upgrade", async () => {
    const cases: [Record<string, string>, string, number][] = [
      [{ origin: ORIGIN }, "?repo=ws1&path=a.md", 4401],
      [{ origin: "http://evil.example", cookie: COOKIE }, "?repo=ws1&path=a.md", 4403],
      [{ cookie: COOKIE }, "?repo=ws1&path=a.md", 4403],
      [{ origin: ORIGIN, cookie: COOKIE }, "?repo=nope&path=a.md", 4404],
      [{ origin: ORIGIN, cookie: COOKIE }, "?repo=ws1&path=", 4404],
      [{ origin: ORIGIN, cookie: COOKIE }, "?repo=busy&path=a.md", 1013],
      [{ origin: ORIGIN }, "?repo=ws1&path=a.md&token=bogus", 4401],
    ];
    for (const [headers, q, code] of cases) {
      const s = await ws("/ws" + q, headers);
      expect(s.status).toBe(101);
      expect((await s.closed).code).toBe(code);
    }
  });

  test("an accepted upgrade reaches the workspace's Durable Object with the admission", async () => {
    const s = await ws("/ws?repo=ws1&path=notes/a.md", { origin: ORIGIN, cookie: COOKIE });
    expect(s.status).toBe(101);
    await until(() => s.messages.length > 0);
    const got = JSON.parse(s.messages[0]!);
    expect(got.name).toBe("ws1");
    expect(new URL(got.url).pathname).toBe("/ws");
    expect(got.admission).toMatchObject({ repoId: "ws1", branch: "main", path: "notes/a.md", readOnly: false, participant: { name: "Alice" } });
    s.socket!.close(1000);
    // the join was recorded in D1
    const db = await mf.getD1Database("DB");
    expect(await db.prepare("SELECT 1 AS ok FROM joined WHERE user_id = 'u1' AND workspace_id = 'ws1'").first()).toEqual({ ok: 1 });
  });

  test("anonymous guests are admitted; a forged admission header is overwritten", async () => {
    const forged = encodeURIComponent(JSON.stringify({ repoId: "ws1", branch: "main", path: "x.md", readOnly: false, participant: { name: "Mallory" } }));
    const s = await ws("/ws?repo=ws1&path=b.md&anon=guest123&name=G%C3%BCnther&color=%23ff0000", { origin: ORIGIN, "x-grim-admission": forged });
    await until(() => s.messages.length > 0);
    const got = JSON.parse(s.messages[0]!);
    expect(got.admission.path).toBe("b.md");
    expect(got.admission.participant.name).toBe("Günther");
    s.socket!.close(1000);
  });
});

describe("Durable Object routes", () => {
  test("/api/events streams from HubDO, and a disconnect is noticed", async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: abort.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toStartWith(": connected");
    expect(((await (await get("/api/__test/hub")).json()) as { streams: number }).streams).toBe(1);
    abort.abort();
    await until(async () => ((await (await get("/api/__test/hub")).json()) as { streams: number }).streams === 0);
  });
});

describe("static site", () => {
  test("the app's HTML at / and /app/…, with the _headers security headers", async () => {
    for (const p of ["/", "/app", "/app/ws1/notes/a.md"]) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/html");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      // the content-named copy, immutable by path (Static Assets can't key caching on ?v=)
      expect(await res.text()).toMatch(/src="\/dist\/main\.[0-9a-f]{12}\.js"/);
    }
    const html = await (await get("/app")).text();
    for (const m of html.matchAll(/(?:href|src)="(\/dist\/(?:main|app|editor)\.[0-9a-f]{12}\.(?:js|css))"/g)) {
      const res = await get(m[1]!);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      await res.arrayBuffer();
    }
    expect([...html.matchAll(/\/dist\/(?:main|app|editor)\.[0-9a-f]{12}\./g)].length).toBe(3);
  });

  test("/dist/main.js and /app.css at the same URLs as on Bun", async () => {
    const js = await get("/dist/main.js?v=x", { "accept-encoding": "gzip, br" });
    // compressed on the way out (Cloudflare does the same at the edge), so no .gz copies are uploaded
    for (const [accept, encoding] of [["br, gzip", "br"], ["gzip", "gzip"]]) {
      const wire = await fetch(`${base}/dist/main.js`, { headers: { "accept-encoding": accept! }, decompress: false } as RequestInit);
      expect(wire.headers.get("content-encoding")).toBe(encoding!);
      await wire.arrayBuffer();
    }
    expect((await get("/dist/main.js.gz")).headers.get("content-type")).toStartWith("text/html");
    // dist/ files live under /dist/ only (at the root a path falls back to the app's HTML)
    expect((await get("/main.js")).headers.get("content-type")).toStartWith("text/html");
    const font = await get("/dist/fonts/Inter-roman-latin.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toStartWith("text/javascript");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await js.text()).length).toBeGreaterThan(1000);
    const css = await get("/app.css?v=x");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toStartWith("text/css");
    expect((await get("/editor.css")).headers.get("content-type")).toStartWith("text/css");
  });

  test("/r redirects to /app (_redirects)", async () => {
    const res = (await mf.dispatchFetch(ORIGIN + "/r/ws1/a.md", { redirect: "manual" })) as unknown as Response;
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toEndWith("/app/ws1/a.md");
  });
});

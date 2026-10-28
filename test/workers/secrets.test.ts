// The repo-leak guard on Workers: with a freshly generated (throwaway) P-256 key configured as
// CODE_STORAGE_PRIVATE_KEY and Code Storage in use, no 24-character run of the key (PEM body, or the private scalar
// in base64url/hex) shows up anywhere the Worker or its Durable Objects send or keep data during a broad run:
// HTTP responses (API, share-link shell incl. env/printenv//proc, MCP, /api/shell), WebSocket frames and close
// reasons (/ws, /ws/home), the SSE stream, RPC results and errors from WorkspaceDO/ShellDO/HubDO/HomeDO, every DO
// SQLite table (room_*, shell_sessions, shell_scratch, …), DO KV and socket attachments, D1 rows, and everything
// workerd logged. The other secrets (webhook, GitHub, Google) are sentinels too. Counterpart of test/server/secrets.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from "wrangler";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { sha256 } from "../../src/server/ids.ts";
import { checkDoSurface, surfaceProblems } from "../../scripts/do-surface.ts";
import { migrationStatements } from "./miniflare.ts";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "../..");
const WORKER = "grim-secrets";

const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const DER = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
const BODY = DER.toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${BODY.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
const D = (await crypto.subtle.exportKey("jwk", keys.privateKey)).d!;
const FORMS: Record<string, string> = { pem: BODY, pemUrl: DER.toString("base64url"), d: D, dHex: Buffer.from(D, "base64url").toString("hex") };
const OTHER = { webhook: "whsec-SENTINEL-5d2c8e1a90", github: "ghsec-SENTINEL-0f4b7c3e21", google: "gosec-SENTINEL-9a6e2d5b48" };

/** Every secret found in `text`: 24-character pieces of any form of the key, a PEM header, the other secrets. */
function leaks(text: string): string[] {
  const found: string[] = [];
  const flat = text.replace(/\\n|\\r|\s/g, "");
  for (const [form, s] of Object.entries(FORMS)) {
    for (let i = 0; i + 24 <= s.length; i += 12) if (flat.includes(s.slice(i, i + 24))) found.push(`${form}@${i}`);
    if (s.length >= 24 && (s.length - 24) % 12 !== 0 && flat.includes(s.slice(-24))) found.push(`${form}@end`);
  }
  if (text.includes("PRIVATE KEY")) found.push("PEM header");
  for (const [k, v] of Object.entries(OTHER)) if (text.includes(v)) found.push(k);
  return [...new Set(found)];
}

function expectClean(where: string, text: string) {
  expect({ where, leaks: leaks(text) }).toEqual({ where, leaks: [] });
}

/** Everything the run produced, by surface: [where, text]. */
const seen = { http: [] as [string, string][], ws: [] as [string, string][], sse: [] as string[], rpc: [] as [string, string][], logs: [] as string[] };

// a Code Storage that refuses everything: every store call still signs a JWT with the key first
let fake: ReturnType<typeof Bun.serve>;
let signed = 0;
let mf: Miniflare;
let base = "";
let outdir = "";
const ALICE = { origin: "", cookie: "np_session=tok-alice" };

beforeAll(async () => {
  fake = Bun.serve({
    port: 0,
    fetch(req) {
      if (/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(req.headers.get("authorization") ?? "")) signed++;
      return Response.json({ message: "nope", code: "boom" }, { status: 500 });
    },
  });
  const cfg = unstable_readConfig({ config: join(ROOT, "wrangler.jsonc") });
  outdir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-secrets-"));
  const alias = cfg.alias ?? {};
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "secrets.worker.js")],
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
  if (!built.success) throw new AggregateError(built.logs, "bundling the secrets test Worker failed");
  const { compatibilityDate, compatibilityFlags, bindings, d1Databases, durableObjects } = unstable_getMiniflareWorkerOptions(cfg).workerOptions as Record<string, unknown>;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      // everything workerd logs (console.* from the Worker and the Durable Objects, uncaught errors)
      handleStructuredLogs: (log: { level: string; message: string }) => void seen.logs.push(`${log.level} ${log.message}`),
      workers: [
        {
          compatibilityDate,
          compatibilityFlags,
          bindings: {
            ...(bindings as object),
            STORAGE: "codestorage",
            CODE_STORAGE_ORG: "sentinel-org",
            CODE_STORAGE_PRIVATE_KEY: PEM,
            CODE_STORAGE_API_URL: `http://127.0.0.1:${fake.port}`,
            CODE_STORAGE_GIT_URL: `127.0.0.1:${fake.port}`,
            CODE_STORAGE_WEBHOOK_SECRET: OTHER.webhook,
            GITHUB_CLIENT_ID: "gh-client",
            GITHUB_CLIENT_SECRET: OTHER.github,
            GOOGLE_CLIENT_ID: "go-client",
            GOOGLE_CLIENT_SECRET: OTHER.google,
            ALLOW_DEV_LOGIN: "1",
            QUIET_MS: "300",
            // the safety alarm runs during the test (head polls, crash-log recovery against the failing store)
            WORKSPACE_ALARM_MS: "1000",
          },
          d1Databases,
          durableObjects,
          name: WORKER,
          modules: true,
          scriptPath: built.outputs[0]!.path,
          modulesRoot: outdir,
        },
      ],
    } as never),
  );
  base = (await mf.ready).toString().replace(/\/$/, "");
  ALICE.origin = base;
  const db = await mf.getD1Database("DB");
  await db.batch(migrationStatements().map((s) => db.prepare(s)));
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO users (id, login, name, email, created_at) VALUES ('u1', 'alice', 'Alice', 'alice@example.com', ?)").bind(now),
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'u1', ?)").bind(sha256("tok-alice"), now + 3_600_000),
    db.prepare("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('jot', 'Jottings', 'notes', 'main', 'ready', ?)").bind(now),
    db.prepare("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('cs-notes', 'Stored', 'notes', 'main', 'ready', ?)").bind(now),
    db.prepare("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('cs-import', 'Import', 'github', 'main', 'importing', ?)").bind(now),
  ]);
  expect((await fetch(`${base}/__test/seed?repo=jot`)).status).toBe(200);
}, 60_000);

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await mf?.dispose();
  fake?.stop(true);
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

/** A request whose status, headers and body are recorded for the scan. */
async function http(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { redirect: "manual", ...init });
  const body = await res.text();
  seen.http.push([`${init.method ?? "GET"} ${path} → ${res.status}`, `${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${body}`]);
  return { res, body };
}

const json = (b: unknown, headers: Record<string, string> = ALICE) => ({ method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(b) });

async function rpc(ns: string, name: string, method: string, ...args: unknown[]) {
  const res = await fetch(`${base}/__test/rpc`, { method: "POST", body: JSON.stringify({ ns, name, method, args }) });
  const text = await res.text();
  seen.rpc.push([`${ns}(${name}).${method}`, text]);
  return JSON.parse(text) as { ok?: unknown; error?: { name: string; message: string } };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const sockets: WebSocket[] = [];

/** A /ws or /ws/home socket whose every frame and close reason is recorded (bytes as UTF-8 and Latin-1 text). */
function socket(path: string, onOpen?: (ws: WebSocket) => void) {
  const ws = new WebSocket(`${base.replace("http", "ws")}${path}`, { headers: ALICE } as never);
  ws.binaryType = "arraybuffer";
  sockets.push(ws);
  const state = { open: false, closed: null as null | number, frames: 0 };
  ws.addEventListener("open", () => {
    state.open = true;
    onOpen?.(ws);
  });
  ws.addEventListener("message", (e) => {
    state.frames++;
    const d = e.data;
    const text = typeof d === "string" ? d : `${new TextDecoder().decode(d as ArrayBuffer)}\n${new TextDecoder("latin1").decode(d as ArrayBuffer)}`;
    seen.ws.push([path, text]);
  });
  ws.addEventListener("close", (e) => {
    state.closed = e.code;
    seen.ws.push([`${path} close`, `${e.code} ${e.reason}`]);
  });
  return { ws, state };
}

/** A Yjs client on /ws that syncs and sets its awareness; `type` edits its note. */
function noteClient(repo: string, path: string) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const send = (ws: WebSocket, enc: encoding.Encoder) => ws.readyState === 1 && ws.send(encoding.toUint8Array(enc));
  const s = socket(`/ws?${new URLSearchParams({ repo, path })}`, (ws) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, doc);
    send(ws, enc);
    awareness.setLocalState({ user: { name: "Alice", color: "#123456" }, cursor: null });
  });
  s.ws.addEventListener("message", (e) => {
    const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.readSyncMessage(dec, enc, doc, "remote");
    if (encoding.length(enc) > 1) send(s.ws, enc);
  });
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    send(s.ws, enc);
  });
  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
    send(s.ws, enc);
  });
  return { ...s, text: doc.getText("md") };
}

const REPO = (id: string) => ({ id, title: id, kind: "notes", branch: "main", status: "ready", read_only: 0, owner_id: null, created_at: 0 });
const ACTOR = { id: "agent-1", name: "Agent", email: "agent@example.com", kind: "agent", color: "#123456" };

describe("the sentinel itself", () => {
  test("the key reached the Worker's config and Code Storage is the store; an unsealed SDK client would leak it", async () => {
    const s = (await (await fetch(`${base}/__test/sentinel`)).json()) as { storage: string; store: string; key: string; raw: string };
    expect(s.storage).toBe("codestorage");
    expect(s.store).toBe("codestorage");
    expect(s.key).toBe(PEM);
    expect(leaks(s.key)).toContain("pem@0");
    expect(leaks(s.raw).length).toBeGreaterThan(0);
    // every encoding of the key the scan looks for is caught
    for (const [form, v] of Object.entries(FORMS)) expect(leaks(`x${v}x`).some((l) => l.startsWith(form))).toBe(true);
  });
});

describe("a broad run over the Worker and its Durable Objects", () => {
  let events: AbortController;

  test("API, auth, webhooks, static, share-link shell, MCP, /api/shell, /ws, /ws/home and /api/events", async () => {
    // the SSE stream stays open for the whole run
    events = new AbortController();
    const stream = fetch(`${base}/api/events`, { signal: events.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          seen.sse.push(dec.decode(value));
        }
      } catch {}
    });

    // sign in by name (a new account, cookie) as well as the seeded session
    const login = await http("/auth/dev", { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Sentinel" }) });
    expect(login.res.status).toBe(303);
    const dev = { origin: base, cookie: login.res.headers.getSetCookie().find((c) => c.startsWith("np_session="))!.split(";")[0]! };

    for (const p of ["/api/config", "/api/server", "/api/me", "/api/repos", "/api/workspaces", "/api/workspaces/jot", "/api/repos/jot", "/api/repos/jot/tree", "/api/repos/jot/file?path=Welcome.md", "/api/repos/jot/history", "/api/repos/jot/search?q=Status", "/api/repos/jot/raw?path=pic.png", "/api/repos/cs-notes", "/api/repos/cs-notes/tree", "/api/repos/cs-notes/file?path=a.md", "/api/repos/cs-notes/history", "/api/repos/cs-notes/search?q=x", "/api/repos/cs-import", "/api/repos/cs-import/tree", "/api/repos/nope/tree", "/api/nope", "/auth/dev", "/auth/github", "/auth/google", "/connect"])
      await http(p, { headers: ALICE });
    await http("/api/me", { headers: dev });
    await http("/api/repos/jot/tree");
    // writes on the memory workspace and on the Code Storage one (which fail after signing)
    await http("/api/repos/jot/files", json({ path: "Plans.md", content: "# Plans\n" }));
    await http("/api/repos/jot/rename", json({ from: "Plans.md", to: "Plans2.md" }));
    await http("/api/repos/cs-notes/files", json({ path: "New.md", content: "# New\n" }));
    await http("/api/repos/cs-notes/refresh", json({}));
    await http("/api/repos/cs-notes/images?note=a.md", { method: "POST", headers: { ...ALICE, "content-type": "image/png" }, body: new Uint8Array([137, 80, 78, 71]) });
    await http("/api/workspaces", json({ title: "Secret Plans" }));
    await http("/api/workspaces", json({ title: "Secret Plans" }, dev));
    await http("/api/repos", json({ github: "https://example.invalid/x/y" }));
    await http("/api/repos", json({ title: "Another" }));
    await http("/api/me", { method: "PATCH", headers: { ...ALICE, "content-type": "application/json" }, body: JSON.stringify({ name: "Alice" }) });
    await http("/webhooks/codestorage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: { id: "cs-notes" } }) });
    await http("/webhooks/codestorage", { method: "POST", headers: { "content-type": "application/json", "x-pierre-signature": "t=1,sha256=00" }, body: "{}" });

    // notes over /ws: an edit on each workspace (the Code Storage one fails to open or to commit), a missing note
    const jot = noteClient("jot", "Welcome.md");
    await until(() => jot.state.frames > 1);
    jot.text.insert(jot.text.length, "typed over the socket\n");
    const cs = noteClient("cs-notes", "a.md");
    const missing = noteClient("jot", "nope.md");
    const home = socket("/ws/home");
    await until(() => (cs.state.closed !== null || cs.state.frames > 0) && missing.state.closed !== null && home.state.frames > 0);
    if (home.ws.readyState === 1) home.ws.send(JSON.stringify({ t: "stroke", points: [[0, 0], [1, 1]] }));

    // the share-link shell, with everything an agent might try to read the environment
    const share = JSON.parse((await http("/api/repos/jot/shares", json({ label: "Robo" }))).body) as { url: string };
    const link = new URL(share.url).pathname;
    await http(link);
    for (const command of ["env", "printenv", "set", "export -p", "declare -p", "cat /proc/self/environ", "cat /proc/1/environ", "ls -la / /proc /proc/self", "echo $CODE_STORAGE_PRIVATE_KEY", "env > /tmp/env.txt && cat /tmp/env.txt", "cat /etc/passwd", "ls -R /workspace", "cat Welcome.md", "grep -rn . .", "echo hi >> todo.md && save", "git log", "git status", "who Welcome.md", "repos", "watch todo.md --timeout 0.2"])
      await http(link, { method: "POST", headers: { "x-agent-name": "Robo", "x-shell-session": "s1" }, body: command });
    await http(`${link}?format=text`, { method: "POST", body: "printenv" });
    // the Code Storage workspace through the signed-in shell, MCP (with a session) and /api/shell
    for (const command of ["env", "ls /workspace", "cat /workspace/cs-notes/a.md", "ls /workspace/cs-notes", "cd /workspace/cs-notes && echo x > n.md && save"])
      await http("/api/shell", json({ command }));
    const init = await http("/mcp", json({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    const sid = init.res.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    for (const command of ["env", "printenv", "cat /proc/self/environ", "cat /workspace/cs-notes/a.md"])
      await http("/mcp", { ...json({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "document_command", arguments: { command } } }), headers: { ...ALICE, "content-type": "application/json", "mcp-session-id": sid } });
    await http("/mcp", json({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
    await http("/mcp", { ...json({ jsonrpc: "2.0", id: 4, method: "tools/list" }), headers: { "content-type": "application/json", authorization: "Bearer nope" } });

    // the crons (refresh, demo reset, session pruning)
    const worker = await mf.getWorker(WORKER);
    for (const cron of ["*/5 * * * *", "0 */6 * * *"]) await worker.scheduled({ cron });

    // a few alarms and quiet commits go by (QUIET_MS 300, WORKSPACE_ALARM_MS 1000) before the sockets close
    await Bun.sleep(2500);
    await http("/api/repos/jot/file?path=Welcome.md");
    expect(seen.http.find(([w]) => w.startsWith("POST /a/"))![1]).toContain("HOME=");
    events.abort();
    await stream;
    expect(seen.sse.join("")).toContain(": connected");
    expect(seen.http.length).toBeGreaterThan(60);
    // the Code Storage store really ran: its calls signed JWTs with the key
    expect(signed).toBeGreaterThan(5);
  });

  test("RPC results and errors from every Durable Object method", async () => {
    const jot = REPO("jot");
    const cs = REPO("cs-notes");
    for (const repo of [jot, cs]) {
      const id = repo.id;
      await rpc("WORKSPACE", id, "readFile", repo, id === "jot" ? "Welcome.md" : "a.md");
      await rpc("WORKSPACE", id, "readRaw", repo, "pic.png");
      await rpc("WORKSPACE", id, "createFile", repo, "Rpc.md", "# Rpc\n", ACTOR);
      await rpc("WORKSPACE", id, "patchFile", repo, "Rpc.md", "# Rpc\n", "# Rpc 2\n", ACTOR);
      await rpc("WORKSPACE", id, "appendText", repo, "Rpc.md", "more\n", ACTOR);
      await rpc("WORKSPACE", id, "restoreFile", repo, "Rpc.md", "0".repeat(40), ACTOR);
      await rpc("WORKSPACE", id, "renameFile", repo, "Rpc.md", "Rpc2.md", ACTOR);
      await rpc("WORKSPACE", id, "renameFolder", repo, "projects", "projects2", ACTOR);
      await rpc("WORKSPACE", id, "uploadImage", repo, "Rpc2.md", "x.png", { $bytes: "\x89PNG" }, ACTOR);
      await rpc("WORKSPACE", id, "tree", repo);
      await rpc("WORKSPACE", id, "head", repo);
      await rpc("WORKSPACE", id, "history", repo, undefined, 5);
      await rpc("WORKSPACE", id, "diff", repo, "0".repeat(40));
      await rpc("WORKSPACE", id, "snapshot", repo, null);
      await rpc("WORKSPACE", id, "snapshot", repo, null, ["Welcome.md", "a.md"]);
      await rpc("WORKSPACE", id, "applyWrites", repo, [{ path: "W.md", content: "w\n", base: null, appended: null }], ACTOR);
      await rpc("WORKSPACE", id, "save", repo, ["Rpc2.md"], [""]);
      await rpc("WORKSPACE", id, "who", repo, "Welcome.md");
      await rpc("WORKSPACE", id, "status", repo, "");
      await rpc("WORKSPACE", id, "liveDiff", repo, "");
      await rpc("WORKSPACE", id, "search", repo, "Status");
      await rpc("WORKSPACE", id, "waitForChange", "Welcome.md", 10);
      await rpc("WORKSPACE", id, "onPush", repo, { fresh: true, invalidate: true });
      await rpc("WORKSPACE", id, "refresh", repo, 0);
      await rpc("WORKSPACE", id, "seenHead", null);
      await rpc("WORKSPACE", id, "deleteFile", repo, "Rpc2.md", ACTOR);
      await rpc("WORKSPACE", id, "deleteFolder", repo, "projects2", ACTOR);
    }
    // a GitHub import step by step against the failing store, from the object's alarm
    await rpc("WORKSPACE", "cs-import", "startImport", { id: "cs-import", owner: "x", name: "y", readOnly: true, branch: "main", phase: "create", polls: 0, head: null, at: 0 });
    await rpc("WORKSPACE", "cs-gone", "remove");
    // the Code Storage calls failed after signing, and the errors arrived with their names
    const failed = seen.rpc.filter(([w, t]) => w.startsWith("WORKSPACE(cs-notes)") && t.startsWith('{"error"'));
    expect(failed.length).toBeGreaterThan(5);
    for (const name of ["share:nope", "user:u1"]) {
      await rpc("SHELL", name, "stats");
      await rpc("SHELL", name, "close");
    }
    await rpc("HUB", "hub", "stats");
    await rpc("HUB", "hub", "emit", { type: "presence", repo: "jot", path: "Welcome.md", users: [] });
    await rpc("HOME", "home", "stats");
    await Bun.sleep(1500);
    expect(seen.rpc.length).toBeGreaterThan(60);
  });

  test("no response, socket frame, close reason, SSE chunk or RPC result carries a secret", () => {
    for (const [w, t] of seen.http) expectClean(w, t);
    for (const [w, t] of seen.ws) expectClean(`ws ${w}`, t);
    expect(seen.ws.length).toBeGreaterThan(5);
    expectClean("sse", seen.sse.join(""));
    for (const [w, t] of seen.rpc) expectClean(`rpc ${w}`, t);
  });

  test("Durable Object SQLite tables, KV and socket attachments", async () => {
    const dumps: Record<string, { tables: Record<string, unknown[]>; kv: unknown; attachments: unknown[] }> = {};
    const shareId = seen.http.find(([w]) => w.startsWith("POST /a/"))![0].split("/a/")[1]!.split(/[ ?]/)[0]!;
    for (const [ns, name] of [["WORKSPACE", "jot"], ["WORKSPACE", "cs-notes"], ["WORKSPACE", "cs-import"], ["SHELL", `share:${shareId}`], ["SHELL", "user:u1"], ["HUB", "hub"], ["HOME", "home"]] as const) {
      const text = await (await fetch(`${base}/__test/dump?ns=${ns}&name=${encodeURIComponent(name)}`)).text();
      expectClean(`${ns}(${name}) storage`, text);
      dumps[`${ns}:${name}`] = JSON.parse(text);
    }
    // the scan saw the tables that matter, with rows in them
    const jot = dumps["WORKSPACE:jot"]!.tables;
    expect(Object.keys(jot)).toEqual(expect.arrayContaining(["room_meta", "room_updates", "workspace_meta"]));
    expect(jot.room_meta!.length).toBeGreaterThan(0);
    const shell = dumps[`SHELL:share:${shareId}`]!.tables;
    expect(shell.shell_sessions!.length).toBeGreaterThan(0);
    expect(shell.shell_scratch!.length).toBeGreaterThan(0);
    expect(JSON.stringify(shell.shell_scratch)).toContain("HOME=");
    expect(dumps["SHELL:user:u1"]!.tables.shell_sessions!.length).toBeGreaterThan(0);
    // the open note sockets' attachments
    expect(dumps["WORKSPACE:jot"]!.attachments.length).toBeGreaterThan(0);
  });

  test("D1 rows", async () => {
    const text = await (await fetch(`${base}/__test/d1`)).text();
    expectClean("D1", text);
    const d1 = JSON.parse(text) as Record<string, unknown[]>;
    for (const t of ["users", "sessions", "repos", "share_links"]) expect(d1[t]!.length).toBeGreaterThan(0);
  });

  test("everything workerd logged", async () => {
    await fetch(`${base}/__test/log?m=end-of-run`);
    await until(() => seen.logs.some((l) => l.includes("[test] marker end-of-run")));
    // errors from the failing store were logged (so the scan covers logged errors)
    expect(seen.logs.length).toBeGreaterThan(3);
    for (const l of seen.logs) expectClean(`log ${l.slice(0, 100)}`, l);
  });
});

describe("the Durable Objects' RPC surface (scripts/do-surface.ts, run by check-workers)", () => {
  test("no public method of src/workers/*-do.ts names Repo, GitStorage or a store/room/runtime", () => {
    expect(checkDoSurface(ROOT)).toEqual([]);
  });

  test("it catches a store or Repo in a signature, an inferred return, a getter and a TS-private method", () => {
    const dts = `import { DurableObject } from "cloudflare:workers";
export declare class BadDO extends DurableObject<Env> {
    #private;
    private streams;
    private sneak;
    private fine;
    constructor(ctx: DurableObjectState, env: Env);
    /** a Repo in a comment is fine */
    tree(repo: RepoRow): Promise<string[]>;
    leak(): CachedHeadStore;
    handle(): Promise<import("@pierre/storage").Repo>;
    get rooms(): RoomManager;
    stats(): {
        store: GitStore;
    };
    take(s: GitStorage): void;
}
export declare class NotADurableObject {
    store(): GitStore;
}`;
    const src = `class BadDO extends DurableObject<Env> {
  private streams = new Set<string>();
  private sneak(n: number): Promise<RoutedStore> { return null as never; }
  private fine(n: number): { ok: boolean } { return { ok: true }; }
}`;
    expect(surfaceProblems("bad-do.ts", dts, src).map((p) => `${p.member}:${p.type}`)).toEqual(["sneak:RoutedStore", "leak:CachedHeadStore", "handle:Repo", "rooms:RoomManager", "stats:GitStore", "take:GitStorage"]);
  });
});

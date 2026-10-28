// ShellDO in Miniflare 5, behind the production router (configured from wrangler.jsonc: compat flags, aliases,
// Durable Objects, D1) with WorkspaceDOs over an in-memory Git store: a share link runs ls, cat, sed -i, git status,
// git diff, who, save and watch (woken by a person editing over /ws) with the same output as the Bun shell tests;
// sessions survive the ShellDO's eviction; the link's limits (calls per minute, commands at once) and revocation;
// MCP (initialize, tools/call, sessions kept across an eviction) and /api/shell for signed-in people.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from "wrangler";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { sha256 } from "../../src/server/ids.ts";
import { migrationStatements } from "./miniflare.ts";

const ROOT = join(import.meta.dir, "../..");
const WORKER = "grim-shell";
const LINK = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const BUSY_LINK = "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f";
const LIMITED_LINK = "8b1c2d3e-4a5b-4c6d-ae7f-0a1b2c3d4e5f";
const ALICE = { origin: "", cookie: "np_session=tok-alice" };

setDefaultTimeout(60_000);

let mf: Miniflare;
let base: string;
let outdir: string;

beforeAll(async () => {
  const cfg = unstable_readConfig({ config: join(ROOT, "wrangler.jsonc") });
  outdir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-shell-"));
  const alias = cfg.alias ?? {};
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "shell.worker.js")],
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
  if (!built.success) throw new AggregateError(built.logs, "bundling the shell test Worker failed");
  const { compatibilityDate, compatibilityFlags, bindings, d1Databases, durableObjects } = unstable_getMiniflareWorkerOptions(cfg).workerOptions as Record<string, unknown>;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      workers: [
        {
          compatibilityDate,
          compatibilityFlags,
          bindings: { ...(bindings as object), QUIET_MS: "2000", WORKSPACE_ALARM_MS: "600000" },
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
  const stmts = [
    db.prepare("INSERT INTO users (id, login, name, email, created_at) VALUES ('u1', 'alice', 'Alice', 'alice@example.com', ?)").bind(now),
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'u1', ?)").bind(sha256("tok-alice"), now + 3_600_000),
  ];
  for (const id of ["jot", "jot2"]) {
    stmts.push(db.prepare("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES (?, ?, 'notes', 'main', 'ready', ?)").bind(id, id === "jot" ? "Jottings" : id, now));
  }
  for (const [id, repo] of [[LINK, "jot"], [BUSY_LINK, "jot2"], [LIMITED_LINK, "jot2"]]) {
    stmts.push(db.prepare("INSERT INTO share_links (id, repo_id, label, created_by, created_at) VALUES (?, ?, 'Robo', 'u1', ?)").bind(id, repo, now));
  }
  await db.batch(stmts);
  for (const id of ["jot", "jot2"]) expect((await fetch(`${base}/__test/seed?repo=${id}`)).status).toBe(200);
}, 60_000);

afterAll(async () => {
  for (const c of clients) c.close();
  await mf?.dispose();
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

type Result = { stdout: string; stderr: string; exitCode: number; cwd: string; truncated: boolean };

/** POST a command to a share link: the JSON result (or the error response's status and body). */
async function link(command: string, opts: { id?: string; session?: string } = {}) {
  const res = await fetch(`${base}/a/${opts.id ?? LINK}`, {
    method: "POST",
    headers: { "x-agent-name": "Robo", ...(opts.session ? { "x-shell-session": opts.session } : {}) },
    body: command,
  });
  return { status: res.status, ...((await res.json()) as Result & { error?: string }) };
}

async function out(command: string, opts: { id?: string; session?: string } = {}) {
  const r = await link(command, opts);
  if (r.status !== 200 || r.exitCode !== 0) throw new Error(`\`${command}\` failed (${r.status}, ${r.exitCode}): ${r.stderr ?? r.error}`);
  return r.stdout;
}

async function gitFile(repo: string, path: string) {
  return ((await (await fetch(`${base}/__test/git?repo=${repo}&path=${encodeURIComponent(path)}`)).json()) as { content: string | null }).content;
}

async function until(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const clients: Client[] = [];

/** A browser-like Yjs client on /ws (document sync only). */
class Client {
  doc = new Y.Doc();
  text = this.doc.getText("md");
  synced = false;
  ws: WebSocket;

  constructor(repo: string, path: string) {
    clients.push(this);
    this.ws = new WebSocket(`${base.replace("http", "ws")}/ws?${new URLSearchParams({ repo, path })}`, { headers: ALICE } as never);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.send(enc);
    });
    this.ws.addEventListener("message", (e) => {
      const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
      if (decoding.readVarUint(dec) !== 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      const type = syncProtocol.readSyncMessage(dec, enc, this.doc, "remote");
      if (type === 1) this.synced = true;
      if (encoding.length(enc) > 1) this.send(enc);
    });
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      this.send(enc);
    });
  }

  send(enc: encoding.Encoder) {
    if (this.ws.readyState === 1) this.ws.send(encoding.toUint8Array(enc));
  }

  close() {
    if (this.ws.readyState <= 1) this.ws.close();
  }
}

describe("share link shell against WorkspaceDOs", () => {
  test("GET gives the instructions; ls, cat, grep", async () => {
    const res = await fetch(`${base}/a/${LINK}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('# Grimoire notebook: Jottings');
    expect(text).toContain("projects/  (2 notes)");
    expect(await out("pwd")).toBe("/workspace/jot\n");
    expect(await out("ls")).toBe("Welcome.md\nprojects\ntodo.md\n");
    expect(await out("cat todo.md")).toBe("# Todo\n\n- milk\n- eggs\n- bread\n");
    expect(await out("grep -rn Status .")).toBe("projects/alpha.md:3:Status: planning\nprojects/beta.md:3:Status: done\n");
    // ?format=text
    const plain = await fetch(`${base}/a/${LINK}?format=text`, { method: "POST", body: "cat nope.md" });
    expect(plain.headers.get("x-exit-code")).toBe("1");
    expect(await plain.text()).toContain("[stderr]");
  });

  test("sed -i, git status, git diff, who and save", async () => {
    expect(await out("sed -i 's/- milk/- oat milk/' todo.md && cat todo.md")).toBe("# Todo\n\n- oat milk\n- eggs\n- bread\n");
    const status = await out("git status");
    expect(status).toBe("On branch main\nLive edits not committed yet (committed automatically after 3 s without edits, or run `save`):\n\tmodified:   todo.md\n");
    const diff = await out("git diff");
    expect(diff).toContain("--- a/todo.md");
    expect(diff).toContain("+- oat milk");
    expect(await out("cd projects && git diff ../todo.md; cd ..")).toBe(diff);
    expect(await out("who todo.md")).toBe("Robo (agent, you)\n");
    expect(await out("who projects/alpha.md")).toBe("nobody has projects/alpha.md open\n");
    expect(await out("save")).toMatch(/^saved todo\.md \([0-9a-f]{7}\)\n$/);
    expect(await gitFile("jot", "todo.md")).toBe("# Todo\n\n- oat milk\n- eggs\n- bread\n");
    expect(await out("save")).toBe("nothing to save\n");
    expect(await out("git status")).toBe("On branch main\nnothing to save, all edits are committed\n");
    expect(await out("git diff")).toBe("");
    expect(await out("git log --oneline -n 1 todo.md")).toMatch(/^[0-9a-f]{7} /);
    // folders, and new files
    await out("echo '# Gamma' > projects/gamma.md");
    expect(await out("git status projects")).toContain("new file:   projects/gamma.md");
    expect(await out("save projects")).toMatch(/^saved projects\/gamma\.md \([0-9a-f]{7}\)\n$/);
    expect(await gitFile("jot", "projects/gamma.md")).toBe("# Gamma\n");
  });

  test("watch wakes up when a person edits over /ws, and who sees them", async () => {
    const alice = new Client("jot", "Welcome.md");
    await until(() => alice.synced);
    expect(await out("who Welcome.md")).toBe("Alice (human)\n");
    const waiting = link("watch Welcome.md --timeout 10 && tail -1 Welcome.md");
    await Bun.sleep(500);
    alice.text.insert(alice.text.length, "alice was here\n");
    const r = await waiting;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("changed: Welcome.md\nalice was here\n");
    const none = await link("watch Welcome.md --timeout 0.2");
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain("no change to Welcome.md within 0.2s");
    alice.close();
  });

  test("a session's cwd, variables and /tmp survive the ShellDO's eviction", async () => {
    await out("cd projects && export KEPT=yes && echo scratch > /tmp/t.txt", { session: "keep" });
    await mf.unsafeEvictDurableObject(WORKER, "ShellDO", { name: `share:${LINK}` });
    expect(await out("pwd; echo $KEPT; cat /tmp/t.txt; cat alpha.md | head -1", { session: "keep" })).toBe("/workspace/jot/projects\nyes\nscratch\n# Alpha\n");
    expect(await out("pwd")).toBe("/workspace/jot\n");
  });

  test("at most 4 commands at once per link", async () => {
    const runs = Array.from({ length: 5 }, (_, i) => link("sleep 1; echo done", { id: BUSY_LINK, session: `s${i}` }));
    const results = await Promise.all(runs);
    const refused = results.filter((r) => r.status === 429);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.error).toContain("this link already has 4 commands running or queued");
    expect(results.filter((r) => r.status === 200 && r.stdout === "done\n")).toHaveLength(4);
  });

  test("at most 120 calls a minute per link", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const batch = await Promise.all(Array.from({ length: 21 }, () => fetch(`${base}/a/${LIMITED_LINK}`, { method: "HEAD" })));
      statuses.push(...batch.map((r) => r.status));
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(120);
    const last = await fetch(`${base}/a/${LIMITED_LINK}`, { method: "POST", body: "pwd", keepalive: false });
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
    await last.text();
    // other links aren't affected
    expect(await out("echo ok")).toBe("ok\n");
  });

  test("revoking the link stops its running command and closes its sessions", async () => {
    const running = link("watch Welcome.md --timeout 30");
    await Bun.sleep(500);
    const res = await fetch(`${base}/api/shares/${LINK}`, { method: "DELETE", headers: ALICE });
    expect(res.status).toBe(200);
    const r = await running;
    expect(r.status).toBe(404);
    expect((await link("pwd")).status).toBe(404);
    await until(async () => ((await (await fetch(`${base}/__test/shell?name=share:${LINK}`)).json()) as { sessions: number; kept: number }).kept === 0);
  });
});

describe("signed-in callers", () => {
  const headers = { ...ALICE, "content-type": "application/json" };
  const mcp = async (body: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    return { res, body: (await res.json()) as any };
  };

  test("MCP: initialize, tools/call, and the session outlives the ShellDO's eviction", async () => {
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.res.status).toBe(200);
    const sid = init.res.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    const call = (command: string) => mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "document_command", arguments: { command } } }, { "mcp-session-id": sid });
    const r = await call("cd /workspace/jot && cat todo.md");
    expect(r.body.result.content[0].text).toBe("# Todo\n\n- oat milk\n- eggs\n- bread\n");
    await mf.unsafeEvictDurableObject(WORKER, "ShellDO", { name: "user:u1" });
    expect((await call("pwd")).body.result.content[0].text).toBe("/workspace/jot\n");
    const tools = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "mcp-session-id": sid });
    expect(tools.body.result.tools[0].name).toBe("document_command");
    expect((await mcp({ jsonrpc: "2.0", id: 4, method: "ping" }, { "mcp-session-id": "nope" })).res.status).toBe(404);
  });

  test("/api/shell runs as the signed-in person; cross-origin and signed-out callers are refused", async () => {
    const res = await fetch(`${base}/api/shell`, { method: "POST", headers, body: JSON.stringify({ command: "ls /workspace; whoami" }) });
    expect(res.status).toBe(200);
    // (demo: the demo workspace, public, from migrations/0002_demo.sql, as on Bun)
    expect(((await res.json()) as Result).stdout).toBe("demo\njot\njot2\nalice\n");
    const xo = await fetch(`${base}/api/shell`, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: JSON.stringify({ command: "ls" }) });
    expect(xo.status).toBe(403);
    const anon = await fetch(`${base}/api/shell`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "ls" }) });
    expect(anon.status).toBe(401);
  });
});

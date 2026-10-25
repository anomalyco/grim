// Kill the real server process with SIGKILL before the quiet period ends, restart it, and check
// that the unsaved edits survive and get committed.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { LocalGitStore } from "../../src/server/store/localgit.ts";

const ROOT = join(import.meta.dir, "../..");
const dataDir = mkdtempSync(join(process.env.DATA_DIR!, "durable-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://localhost:${port}`;

function startServer() {
  return Bun.spawn(["bun", "src/server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, STORAGE: "local", PORT: String(port), ALLOW_DEV_LOGIN: "1", ALLOWED_GITHUB_USERS: "*", QUIET_MS: "1500", PUBLIC_URL: base },
    stdout: "ignore",
    stderr: "pipe",
  });
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/api/config`).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}

async function login(): Promise<string> {
  const r = await fetch(`${base}/auth/dev`, { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "name=Dura" });
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

/** Open the note over the websocket, wait for sync, then type `insert` at the end. */
async function typeOverWebsocket(cookie: string, path: string, insert: string) {
  const doc = new Y.Doc();
  const text = doc.getText("md");
  const ws = new WebSocket(`ws://localhost:${port}/ws?repo=notes&path=${encodeURIComponent(path)}`, { headers: { cookie, origin: base } } as never);
  ws.binaryType = "arraybuffer";
  let synced = false;
  ws.onmessage = (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    const kind = syncProtocol.readSyncMessage(dec, enc, doc, "server");
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (kind === syncProtocol.messageYjsSyncStep2) synced = true;
  };
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === "server") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    ws.send(encoding.toUint8Array(enc));
  });
  await new Promise((r) => (ws.onopen = r));
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, doc);
  ws.send(encoding.toUint8Array(enc));
  for (let i = 0; i < 100 && !synced; i++) await Bun.sleep(50);
  expect(synced).toBe(true);
  text.insert(text.length, insert);
  await Bun.sleep(300); // let the update reach the server's crash log
  ws.close();
}

test("unsaved edits survive kill -9 and are committed after restart", async () => {
  const store = new LocalGitStore(join(dataDir, "git"));
  let server = startServer();
  try {
    await waitUp();
    const cookie = await login();
    const created = await fetch(`${base}/api/repos/notes/files`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ path: "durable.md", content: "# Durable\n\nwritten before the crash\n" }),
    });
    expect(created.status).toBe(201);
    await typeOverWebsocket(cookie, "Welcome.md", "typed before the crash\n");

    // Nothing is committed yet: the quiet period hasn't passed.
    const headBefore = await store.head("notes", "main");
    expect(await store.readFile("notes", "durable.md", headBefore!)).toBeNull();
    expect(await store.readFile("notes", "Welcome.md", headBefore!)).not.toContain("typed before the crash");

    server.kill("SIGKILL");
    await server.exited;

    server = startServer();
    await waitUp();
    // Recovery reopens both rooms and commits them after the quiet period.
    let head: string | null = null;
    for (let i = 0; i < 60; i++) {
      head = await store.head("notes", "main");
      const a = head && (await store.readFile("notes", "durable.md", head));
      const b = head && (await store.readFile("notes", "Welcome.md", head));
      if (a && b?.includes("typed before the crash")) break;
      await Bun.sleep(200);
    }
    expect(await store.readFile("notes", "durable.md", head!)).toBe("# Durable\n\nwritten before the crash\n");
    expect(await store.readFile("notes", "Welcome.md", head!)).toContain("typed before the crash\n");
  } finally {
    server.kill("SIGKILL");
  }
}, 30_000);

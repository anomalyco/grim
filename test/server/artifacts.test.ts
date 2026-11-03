// Web artifacts (artifacts/, shared/artifacts.ts): agents write them with the shell (text and bytes, one commit per
// command), only web file types, no executables, size caps; Markdown rules elsewhere unchanged; the raw API hands
// them only to token-authenticated app clients, as downloads; browsers never get them rendered.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isolate } from "./helpers.ts";

process.env.QUIET_MS = "100";
process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db: earlyDb } = await import("../../src/server/db.ts");
const restore = isolate(config, earlyDb);
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: true, quietMs: 100 });
config.github.clientId = "";
config.github.appSlug = "";
const { startServer } = await import("../../src/server/index.ts");
const { db } = await import("../../src/server/db.ts");
const { createAppToken } = await import("../../src/server/tokens.ts");
const { MAX_ARTIFACT_BYTES, looksExecutable, isArtifactPath } = await import("../../src/shared/artifacts.ts");

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";
let cookie = "";
let token = "";
let ws = "";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

async function run(command: string, auth = token) {
  const res = await fetch(`${base}/app/${ws}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-name": "Tester", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ command }),
  });
  return (await res.json()) as { stdout: string; stderr: string; exitCode: number };
}

const raw = (path: string, headers: Record<string, string>) => fetch(`${base}/api/workspace/${ws}/raw?path=${encodeURIComponent(path)}`, { headers });

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
  base = `http://localhost:${app.server.port}`;
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Artifact Owner" }), redirect: "manual" });
  cookie = res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
  const me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as { id: string };
  token = (await createAppToken(app.ctx.repos.db, me.id, "test")).token;
  const made = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: JSON.stringify({ title: "Artifacts" }) });
  ws = ((await made.json()) as { id: string }).id;
});

afterAll(async () => {
  await app?.stop();
  restore();
});

describe("artifacts", () => {
  test("paths and executables", () => {
    expect(isArtifactPath("artifacts/demo/index.html")).toBe(true);
    expect(isArtifactPath("artifacts/demo/notes.md")).toBe(false);
    expect(isArtifactPath("other/index.html")).toBe(false);
    expect(isArtifactPath("artifacts/x.exe")).toBe(false);
    expect(looksExecutable(new Uint8Array([0x4d, 0x5a, 0, 0]))).toBe(true);
    expect(looksExecutable(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe(true);
    expect(looksExecutable(new TextEncoder().encode("<!doctype html>"))).toBe(false);
  });

  test("an agent writes an artifact folder in one commit; the tree lists it", async () => {
    const r = await run(
      `mkdir -p artifacts/demo && printf '<!doctype html><link rel=stylesheet href=style.css><h1>Hi</h1>' > artifacts/demo/index.html && echo 'h1{color:red}' > artifacts/demo/style.css && ls artifacts/demo && cat artifacts/demo/style.css`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("index.html");
    expect(r.stdout).toContain("h1{color:red}");
    const tree = (await (await fetch(`${base}/api/workspace/${ws}/tree`, { headers: { cookie } })).json()) as { files: string[]; artifacts: { path: string }[] };
    expect(tree.artifacts.map((a) => a.path).sort()).toEqual(["artifacts/demo/index.html", "artifacts/demo/style.css"]);
    expect(tree.files.some((f) => f.startsWith("artifacts/"))).toBe(false);
    const log = await app.ctx.store.history(ws, "main", undefined, 1);
    expect(log[0]!.message).toContain("Update 2 files in artifacts/");
    // bytes too (an image copied from /tmp), read back exactly
    const b64 = Buffer.from(PNG).toString("base64");
    const img = await run(`echo ${b64} | base64 -d > /tmp/p.png && cp /tmp/p.png artifacts/demo/logo.png && wc -c < artifacts/demo/logo.png`);
    expect(img.exitCode).toBe(0);
    expect(img.stdout.trim()).toBe(String(PNG.length));
  });

  test("executables, other types, oversized files and HTML outside artifacts/ are refused", async () => {
    const exe = await run(`printf 'MZ\\x90\\x00' > artifacts/demo/app.exe`);
    expect(exe.exitCode).not.toBe(0);
    expect(exe.stderr).toContain("web files only");
    const pe = await run(`printf 'MZ\\x90\\x00' > artifacts/demo/sneaky.js`);
    expect(pe.exitCode).not.toBe(0);
    expect(pe.stderr).toContain("executables");
    const big = await run(`printf "%0${MAX_ARTIFACT_BYTES + 10}d" 0 > artifacts/demo/big.txt`);
    expect(big.exitCode).not.toBe(0);
    expect(big.stderr).toContain("too large");
    const outside = await run(`echo '<h1>x</h1>' > page.html`);
    expect(outside.exitCode).not.toBe(0);
    expect(outside.stderr).toContain("only Markdown");
    const tree = (await (await fetch(`${base}/api/workspace/${ws}/tree`, { headers: { cookie } })).json()) as { artifacts: { path: string }[] };
    expect(tree.artifacts.map((a) => a.path)).not.toContain("artifacts/demo/app.exe");
  });

  test("the raw API: app tokens get a download, browsers and cookies get nothing", async () => {
    const ok = await raw("artifacts/demo/index.html", { authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/octet-stream");
    expect(ok.headers.get("content-disposition")).toStartWith("attachment");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await ok.text()).toContain("<h1>Hi</h1>");
    // a browser: signed out, or signed in with its cookie (no token)
    expect((await raw("artifacts/demo/index.html", { accept: "text/html" })).status).toBe(403);
    expect((await raw("artifacts/demo/index.html", { cookie, accept: "text/html" })).status).toBe(403);
    // images under artifacts/ aren't served as images either
    expect((await raw("artifacts/demo/logo.png", { cookie })).status).toBe(403);
    // the note URL answers a plain message, never the file
    const page = await fetch(`${base}/app/${ws}/artifacts/demo/index.html`, { headers: { accept: "*/*" } });
    expect(page.status).toBe(404);
    expect(page.headers.get("content-type")).toStartWith("text/plain");
    expect(await page.text()).toContain("Grim for Mac");
  });

  test("review artifacts: .diff/.patch files, and an artifact's history names the session that wrote it", async () => {
    expect(isArtifactPath("artifacts/review/changes.patch")).toBe(true);
    expect(isArtifactPath("artifacts/review/one.diff")).toBe(true);
    const res = await fetch(`${base}/app/${ws}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-name": "Tester", authorization: `Bearer ${token}` },
      body: JSON.stringify({ command: `mkdir -p artifacts/review && printf 'diff --git a/x b/x\\n' > artifacts/review/changes.patch && echo '<grim-diff-stack src=changes.patch></grim-diff-stack>' > artifacts/review/index.html`, session_id: "ses_review123", session_name: "Review kit" }),
    });
    expect(((await res.json()) as { exitCode: number }).exitCode).toBe(0);
    const h = (await (await fetch(`${base}/api/workspace/${ws}/history?path=${encodeURIComponent("artifacts/review/index.html")}&limit=5`, { headers: { authorization: `Bearer ${token}` } })).json()) as { message: string }[];
    expect(h.length).toBe(1);
    expect(h[0]!.message).toContain("Agent-Session-Id: ses_review123");
    expect(h[0]!.message).toContain("Agent-Session-Name: Review kit");
    // notes' history unchanged: a path without an extension is still a note
    expect(((await (await fetch(`${base}/api/workspace/${ws}/history?path=nothing`, { headers: { cookie } })).json()) as unknown[]).length).toBe(0);
  });

  test("rm and mv commit like writes", async () => {
    const r = await run(`mv artifacts/demo/style.css artifacts/demo/main.css && rm artifacts/demo/logo.png && ls artifacts/demo`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean).sort()).toEqual(["index.html", "main.css"]);
  });
});

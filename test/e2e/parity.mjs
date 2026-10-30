// Black-box parity: one HTTP + WebSocket scenario run against the Bun server and against the Workers build
// (wrangler dev --local), comparing status codes, JSON shapes (keys and value types, not values), the headers that
// matter and WebSocket close codes / first messages, so the two servers can't drift apart.
// Usage: bun test/e2e/parity.mjs   (prints each step that differs; exits non-zero if any does)
import "../local-storage.ts";
import * as decoding from "lib0/decoding";
import { startBun, startWorkers } from "./target.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const WEBHOOK_SECRET = "whsec_parity";
// EXTERNAL_SYNC=1: the webhook steps compare the route itself (off, both targets answer 404 alike)
const env = { QUIET_MS: "60000", CODE_STORAGE_WEBHOOK_SECRET: WEBHOOK_SECRET, EXTERNAL_SYNC: "1" };
const GUEST_ID = "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f";

/** A JSON value's shape: object keys (sorted) with their shapes, an array's first element, typeof for the rest. */
export function shape(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
  return typeof v;
}

/** Runs the scenario against `base`; returns step name → what was observed. */
async function scenario(base) {
  const seen = new Map();
  const record = (step, value) => {
    if (seen.has(step)) throw new Error(`step ${step} twice`);
    seen.set(step, value);
    if (process.env.PARITY_TRACE) console.error(step, JSON.stringify(value));
  };
  const origin = base;
  let cookie = "";
  const http = async (step, method, path, { body, headers = {}, raw, keep = [] } = {}) => {
    const h = { ...headers };
    if (cookie && !("cookie" in h)) h.cookie = cookie;
    if (!("origin" in h)) h.origin = origin;
    if (body !== undefined && !raw && !h["content-type"]) h["content-type"] = "application/json";
    const res = await fetch(base + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
    const type = (res.headers.get("content-type") ?? "").split(";")[0];
    const text = await res.text();
    let json;
    if (type === "application/json") {
      try {
        json = JSON.parse(text);
      } catch {}
    }
    const kept = Object.fromEntries(keep.map((k) => [k, res.headers.get(k) === null ? null : k === "location" ? res.headers.get(k) : "present"]));
    record(step, { status: res.status, type, ...(json !== undefined ? { shape: shape(json) } : {}), ...(keep.length ? { headers: kept } : {}) });
    return { res, json, text };
  };
  const wsProbe = (step, query, headers) =>
    new Promise((resolve) => {
      const url = `${base.replace("http", "ws")}${query}`;
      const ws = new WebSocket(url, { headers });
      ws.binaryType = "arraybuffer";
      let first = null;
      const done = (v) => {
        record(step, v);
        resolve(v);
      };
      ws.onmessage = (e) => {
        if (first) return;
        if (typeof e.data === "string") {
          // (a JSON text frame)
          first = JSON.parse(e.data);
          done({ open: true, text: shape(first) });
          ws.close();
          return;
        }
        const dec = decoding.createDecoder(new Uint8Array(e.data));
        const type = decoding.readVarUint(dec);
        if (type !== 2 || first) return;
        first = JSON.parse(decoding.readVarString(dec));
        done({ open: true, control: shape(first) });
        ws.close();
      };
      ws.onclose = (e) => !first && done({ open: false, close: e.code });
    });

  await http("server", "GET", "/api/server");
  await http("config", "GET", "/api/server");
  await http("me signed out", "GET", "/api/me");
  await http("workspaces signed out", "GET", "/api/workspaces");
  await http("dev sign-in cross-origin", "POST", "/auth/dev", { body: { name: "Mallory" }, headers: { origin: "https://evil.example" } });
  await http("dev sign-in without a name", "POST", "/auth/dev", { body: { name: "  " } });
  const login = await http("dev sign-in", "POST", "/auth/dev", { body: { name: "Parity", next: "/app" }, keep: ["location", "set-cookie"] });
  cookie = (login.res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("np_session=")) ?? "";
  await http("me", "GET", "/api/me");
  await http("rename me", "PATCH", "/api/me", { body: { name: "Parity Two" } });
  await http("rename me empty", "PATCH", "/api/me", { body: { name: "" } });
  await http("create workspace without a title", "POST", "/api/workspaces", { body: {} });
  const ws = (await http("create workspace", "POST", "/api/workspaces", { body: { title: "Parity" } })).json.id;
  await http("create workspace cross-origin", "POST", "/api/workspaces", { body: { title: "X" }, headers: { origin: "https://evil.example" } });
  await http("workspaces", "GET", "/api/workspaces");
  await http("workspace", "GET", `/api/workspace/${ws}`);
  await http("workspace unknown", "GET", "/api/workspace/nope-zzzz");
  await http("repos", "GET", "/api/workspaces");
  await http("repo", "GET", `/api/workspace/${ws}`);
  await http("repo unknown", "GET", "/api/workspace/nope-zzzz");
  await http("repo dot-dot", "GET", "/api/workspace/%2E%2E");
  const tree = await http("tree", "GET", `/api/workspace/${ws}/tree`, { keep: ["etag", "cache-control"] });
  await http("tree if-none-match", "GET", `/api/workspace/${ws}/tree`, { headers: { "if-none-match": tree.res.headers.get("etag") ?? "" } });
  await http("create note", "POST", `/api/workspace/${ws}/files`, { body: { path: "A.md", content: "# A\nalpha\n" } });
  await http("create note again", "POST", `/api/workspace/${ws}/files`, { body: { path: "A.md", content: "x" } });
  await http("create note without a path", "POST", `/api/workspace/${ws}/files`, { body: {} });
  await http("create note bad extension", "POST", `/api/workspace/${ws}/files`, { body: { path: "a.exe", content: "x" } });
  await http("create note signed out", "POST", `/api/workspace/${ws}/files`, { body: { path: "B.md" }, headers: { cookie: "" } });
  await http("create note cross-origin", "POST", `/api/workspace/${ws}/files`, { body: { path: "B.md" }, headers: { origin: "https://evil.example" } });
  const guest = { cookie: "", "x-grimoire-guest": GUEST_ID, "x-grimoire-guest-name": "quiet-otter" };
  await http("create note as a guest", "POST", `/api/workspace/${ws}/files`, { body: { path: "Guest.md", content: "g\n" }, headers: guest });
  await http("create note for guests", "POST", `/api/workspace/${ws}/files`, { body: { path: "Guest.md", content: "g\n" } });
  await http("rename note as a guest", "POST", `/api/workspace/${ws}/rename`, { body: { from: "Guest.md", to: "G2.md" }, headers: guest });
  await http("rename folder as a guest", "POST", `/api/workspace/${ws}/rename`, { body: { folder: true, from: "nope", to: "yes" }, headers: guest });
  await http("delete note as a guest", "DELETE", `/api/workspace/${ws}/files?path=Guest.md`, { headers: guest });
  await http("delete folder as a guest", "DELETE", `/api/workspace/${ws}/files?folder=nope`, { headers: guest });
  await http("upload image as a guest", "POST", `/api/workspace/${ws}/images?note=Guest.md&name=dot.png`, { raw: PNG, headers: { ...guest, "content-type": "image/png" } });
  await http("restore bad sha as a guest", "POST", `/api/workspace/${ws}/restore`, { body: { path: "Guest.md", sha: "nope" }, headers: guest });
  await http("demo create note as a guest", "POST", "/api/workspace/demo/files", { body: { path: "Parity guest.md", content: "g\n" }, headers: guest });
  await http("demo rename note as a guest", "POST", "/api/workspace/demo/rename", { body: { from: "Parity guest.md", to: "Parity guest 2.md" }, headers: guest });
  await http("demo delete note as a guest", "DELETE", "/api/workspace/demo/files?path=Parity%20guest%202.md", { headers: guest });
  await http("file live", "GET", `/api/workspace/${ws}/file?path=A.md`);
  await http("file missing", "GET", `/api/workspace/${ws}/file?path=Nope.md`);
  await http("file without a path", "GET", `/api/workspace/${ws}/file`);
  await http("raw of a note", "GET", `/api/workspace/${ws}/raw?path=A.md`);
  const share = (await http("agent link", "POST", `/api/workspace/${ws}/agent-link`, { body: {} })).json;
  share.id = share.url.split("/a/")[1];
  await http("save", "POST", `/a/${share.id}`, { body: { command: "save" } });
  const hist = await http("history", "GET", `/api/workspace/${ws}/history?path=A.md`);
  await http("history all", "GET", `/api/workspace/${ws}/history?limit=5`);
  await http("file at a commit", "GET", `/api/workspace/${ws}/file?path=A.md&ref=${hist.json?.[0]?.sha}`);
  await http("diff", "GET", `/api/workspace/${ws}/diff?sha=${hist.json?.[0]?.sha}&path=A.md`);
  await http("diff unknown sha", "GET", `/api/workspace/${ws}/diff?sha=${"0".repeat(40)}`);
  await http("search", "GET", `/api/workspace/${ws}/search?q=alpha`);
  await http("upload image", "POST", `/api/workspace/${ws}/images?note=A.md&name=dot.png`, { raw: PNG, headers: { "content-type": "image/png" } });
  await http("upload not an image", "POST", `/api/workspace/${ws}/images?note=A.md&name=x.txt`, { raw: "hello", headers: { "content-type": "text/plain" } });
  await http("raw image", "GET", `/api/workspace/${ws}/raw?path=images/dot.png`, { keep: ["x-content-type-options"] });
  await http("raw missing", "GET", `/api/workspace/${ws}/raw?path=images/nope.png`);
  await http("rename note", "POST", `/api/workspace/${ws}/rename`, { body: { from: "A.md", to: "B.md" } });
  await http("rename missing", "POST", `/api/workspace/${ws}/rename`, { body: { from: "Nope.md", to: "C.md" } });
  await http("rename folder", "POST", `/api/workspace/${ws}/rename`, { body: { folder: true, from: "nope", to: "yes" } });
  await http("restore bad sha", "POST", `/api/workspace/${ws}/restore`, { body: { path: "B.md", sha: "nope" } });
  await http("delete note", "DELETE", `/api/workspace/${ws}/files?path=B.md`);
  await http("delete missing", "DELETE", `/api/workspace/${ws}/files?path=B.md`);
  await http("refresh a notes workspace", "POST", `/api/workspace/${ws}/refresh`);
  await http("unknown api", "GET", "/api/nope");
  await http("token revoke unknown", "DELETE", "/api/tokens/nope");
  await http("events: gone", "GET", "/api/events");
  await http("config: gone", "GET", "/api/config");

  // share links, the shell, MCP
  await http("agent link again", "POST", `/api/workspace/${ws}/agent-link`, { body: {} });
  await http("share link GET", "GET", `/a/${share.id}`);
  await http("share link command", "POST", `/a/${share.id}`, { raw: "ls", headers: { "content-type": "text/plain" } });
  await http("share link command text", "POST", `/a/${share.id}?format=text`, { raw: "cat nope.md", headers: { "content-type": "text/plain" }, keep: ["x-exit-code"] });
  await http("share link JSON body", "POST", `/a/${share.id}`, { body: { command: "pwd" } });
  await http("share link empty", "POST", `/a/${share.id}`, { raw: "", headers: { "content-type": "text/plain" } });
  await http("share link unknown", "GET", "/a/6f1c2d3e-4a5b-4c6d-8e7f-000000000000");
  await http("shell: gone", "POST", "/api/shell", { body: { command: "pwd" } });
  await http("mcp without a token", "POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, keep: ["www-authenticate"] });
  await http("mcp GET", "GET", "/mcp");
  await http("oauth resource metadata", "GET", "/.well-known/oauth-protected-resource");
  await http("oauth server metadata", "GET", "/.well-known/oauth-authorization-server");

  // WebSockets
  const wsHeaders = { cookie, origin };
  await http("ws without an upgrade", "GET", `/ws?repo=${ws}&path=Guest.md`);
  await wsProbe("ws open", `/ws?repo=${ws}&path=Guest.md`, wsHeaders);
  await wsProbe("ws signed out", `/ws?repo=${ws}&path=Guest.md`, { origin });
  await wsProbe("ws as a guest", `/ws?repo=${ws}&path=Guest.md&anon=${GUEST_ID}&name=quiet-otter`, { origin });
  await wsProbe("ws cross-origin", `/ws?repo=${ws}&path=Guest.md`, { cookie, origin: "https://evil.example" });
  await wsProbe("ws unknown workspace", `/ws?repo=nope-zzzz&path=A.md`, wsHeaders);
  await wsProbe("ws missing note", `/ws?repo=${ws}&path=Nope.md`, wsHeaders);
  await wsProbe("ws bad token", `/ws?repo=${ws}&path=Guest.md&token=nope`, { origin });
  await wsProbe("ws demo", `/ws?repo=demo&path=Welcome.md`, wsHeaders);

  // pages and the rest
  await http("app page", "GET", "/app", { keep: ["content-security-policy", "x-frame-options", "cache-control"] });
  await http("app note page", "GET", `/app/${ws}/Guest.md`, { keep: ["content-security-policy"] });
  await http("old /r/ link", "GET", "/r/demo/Welcome.md", { keep: ["location"] });
  await http("home page", "GET", "/");
  await http("auth unknown", "GET", "/auth/nope");
  await http("google sign-in off", "GET", "/auth/google");
  // Code Storage webhooks: the push body in today's docs and the one @pierre/storage 1.17.1 expects, signed or not
  const hook = async (step, event, body, secret = WEBHOOK_SECRET) => {
    const raw = JSON.stringify(body);
    const t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`))).toString("hex");
    await http(step, "POST", "/webhooks/codestorage", { raw, headers: { "content-type": "application/json", "x-pierre-event": event, "x-pierre-signature": `t=${t},sha256=${sig}` } });
  };
  const at = new Date().toISOString();
  await http("webhook unsigned", "POST", "/webhooks/codestorage", { body: {} });
  await hook("webhook wrong secret", "push", { type: "push", repository: { repo_name: ws }, ref: "refs/heads/main", before: "a", after: "b", pushed_at: at }, "whsec_other");
  await hook("webhook push (docs shape)", "push", { type: "push", repository: { repo_name: ws }, ref: "refs/heads/main", before: "a", after: "b", pushed_at: at });
  await hook("webhook push (SDK 1.17.1 shape)", "push", { repository: { id: ws, url: "https://example.com" }, ref: "refs/heads/main", before: "a", after: "b", customer_id: "c", pushed_at: at });
  await hook("webhook push without a repo", "push", { type: "push", ref: "refs/heads/main", before: "a", after: "b" });
  await hook("webhook sync event", "repo.sync.succeeded", { type: "repo.sync.succeeded", repository: { repo_name: ws } });
  await http("connect bad redirect", "GET", `/connect?client=X&redirect=${encodeURIComponent("https://evil.example/cb")}&state=s`);

  // revoking and removing
  await http("revoke share link", "DELETE", `/api/shares/${share.id}`);
  await http("revoke share link again", "DELETE", `/api/shares/${share.id}`);
  await http("share link revoked", "POST", `/a/${share.id}`, { raw: "pwd", headers: { "content-type": "text/plain" } });
  const other = await fetch(`${base}/auth/dev`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ name: "Other" }) });
  const otherCookie = (other.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("np_session=")) ?? "";
  await http("remove workspace as someone else", "DELETE", `/api/workspace/${ws}`, { headers: { cookie: otherCookie } });
  await http("leave workspace", "DELETE", `/api/workspace/${ws}/join`);
  await http("join workspace", "POST", `/api/workspace/${ws}/join`);
  await http("remove workspace", "DELETE", `/api/workspace/${ws}`);
  await http("workspace removed", "GET", `/api/workspace/${ws}`);
  await http("sign out", "POST", "/auth/logout", { keep: ["location"] });
  await http("me after sign-out", "GET", "/api/me");
  return seen;
}

const results = {};
for (const [name, start] of [
  ["bun", startBun],
  ["workers", startWorkers],
]) {
  const t = await start({ env });
  try {
    results[name] = await scenario(t.base);
  } finally {
    await t.stop();
  }
}

let diffs = 0;
for (const [step, b] of results.bun) {
  const w = results.workers.get(step);
  const same = JSON.stringify(b) === JSON.stringify(w);
  if (!same) diffs++;
  console.log(same ? "ok  " : "FAIL", step, same ? `(${b.status ?? (b.open ? "open" : b.close)})` : `\n     bun     ${JSON.stringify(b)}\n     workers ${JSON.stringify(w)}`);
}
for (const step of results.workers.keys()) if (!results.bun.has(step)) (diffs++, console.log("FAIL", step, "(workers only)"));
console.log(diffs ? `${diffs} steps differ` : `all ${results.bun.size} steps match`);
process.exit(diffs ? 1 : 0);

// SIGN_IN off (the default for self-hosted servers): no accounts at all, everything shared. Every workspace is listed
// for everyone and anyone may do anything (one built-in user, "local"); visitors keep only their display name. No demo,
// no sign-in routes; /api/server says so; /mcp needs no auth. And SIGN_IN=on without a sign-in method refuses to start (signInProblem).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isolate } from "./helpers.ts";
import { seedNotebook, withLinkId } from "./helpers.ts";

process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db } = await import("../../src/server/db.ts");
const restore = isolate(config, db);
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: false, signInSetting: "", quietMs: 100 });
config.github.clientId = "";
config.github.appSlug = "";
config.google.clientId = "";
config.google.clientSecret = "";
const { startServer } = await import("../../src/server/index.ts");
const { signInProblem } = await import("../../src/server/auth.ts");

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";

const visitor = (id: string, name: string) => ({ "x-grimoire-guest": id, "x-grimoire-guest-name": encodeURIComponent(name), "x-grimoire-guest-color": "#7c4d3a" });
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method, redirect: "manual", headers: { origin: base, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data: withLinkId(data), headers: res.headers };
}

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
  await seedNotebook(app.ctx, "off-notes");
  base = `http://localhost:${app.server.port}`;
});

afterAll(async () => {
  await app?.stop();
  restore();
});

describe("sign-in off", () => {
  test("server info says so; no sign-in methods, no demo", async () => {
    expect((await api("GET", "/api/server")).data).toMatchObject({ signIn: false, googleLogin: false, githubLogin: false });
    expect((await api("POST", "/api/demo/room", {}, visitor("offVisitor1", "soggy-turnip"))).status).toBe(404);
    expect((await api("POST", "/api/workspaces/personal", {}, visitor("offVisitor1", "soggy-turnip"))).status).toBe(404);
  });

  test("sign-in routes go home or 404; /api/me is not there", async () => {
    const g = await api("GET", "/auth/google");
    expect(g.status).toBe(303);
    expect(g.headers.get("location")).toBe("/");
    expect((await api("POST", "/auth/dev", { name: "x" })).status).toBe(404);
    expect((await api("GET", "/api/me", undefined, visitor("offVisitor1", "soggy-turnip"))).status).toBe(404);
  });

  test("a visitor creates, renames, deletes, shares and removes its workspace", async () => {
    const v = visitor("offVisitor1", "soggy-turnip");
    const created = await api("POST", "/api/workspaces", { title: "Open notes" }, v);
    expect(created.status).toBe(201);
    const id = created.data.id as string;
    expect(created.data.canRemove).toBe(true);
    expect((await api("GET", "/api/workspaces", undefined, v)).data.map((w: any) => w.id)).toContain(id);
    expect((await api("POST", `/api/workspace/${id}/files`, { path: "a.md", content: "hi" }, v)).status).toBe(201);
    expect((await api("POST", `/api/workspace/${id}/rename`, { from: "a.md", to: "b.md" }, v)).status).toBe(200);
    const share = await api("POST", `/api/workspace/${id}/agent-link`, {}, v);
    expect([200, 201]).toContain(share.status);
    // one shared list: another visitor (or a script) sees it, and may do anything with it, removing it too
    const other = visitor("offVisitor2", "crusty-sock");
    expect((await api("GET", "/api/workspaces", undefined, other)).data.map((w: any) => w.id)).toContain(id);
    expect((await api("GET", "/api/workspaces")).data.map((w: any) => w.id)).toContain(id);
    expect((await api("DELETE", `/api/workspace/${id}/files?path=b.md`, undefined, other)).status).toBe(200);
    expect((await api("DELETE", `/api/workspace/${id}`, undefined, other)).status).toBe(200);
  });

  test("commits carry the visitor's name, as guests' do", async () => {
    const v = visitor("offVisitor3", "wobbly-llama");
    const id = (await api("POST", "/api/workspaces", { title: "Authors" }, v)).data.id as string;
    await api("POST", `/api/workspace/${id}/files`, { path: "n.md", content: "x" }, v);
    const history = await api("GET", `/api/workspace/${id}/history?path=n.md`, undefined, v);
    expect(JSON.stringify(history.data)).toContain("wobbly-llama");
  });

  test("a request without a guest identity still may; no per-visitor users or lists", async () => {
    expect((await api("POST", "/api/workspaces", { title: "Scripted" })).status).toBe(201);
    expect(db.query("SELECT count(*) AS n FROM users WHERE id LIKE 'guest:%'").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM joined").get()).toEqual({ n: 0 });
  });

  test("/mcp needs no auth: list_workspaces lists every workspace, command works on any", async () => {
    const rpc = (body: unknown) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_workspaces", arguments: {} } });
    expect(list.result.structuredContent.workspaces.map((w: any) => w.id)).toContain("off-notes");
    const out = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "command", arguments: { workspace: "off-notes", command: "ls" } } });
    expect(out.result.content[0].text).toContain("Welcome.md");
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
  });

  test("cross-origin browser writes are still refused", async () => {
    expect((await api("POST", "/api/workspaces", { title: "x" }, { ...visitor("offVisitor1", "soggy-turnip"), origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("SIGN_IN=on needs a sign-in method", () => {
  test("refused without Google or GitHub, with what to set", () => {
    const saved = { signIn: config.signIn, allowDevLogin: config.allowDevLogin };
    try {
      Object.assign(config, { signIn: true, allowDevLogin: false });
      expect(signInProblem()).toContain("GOOGLE_CLIENT_ID");
      expect(signInProblem()).toContain("docs/self-hosting.md#sign-in");
      config.google.clientId = "id";
      config.google.clientSecret = "secret";
      expect(signInProblem()).toBeNull();
      Object.assign(config, { signIn: false, signInSetting: "maybe" });
      expect(signInProblem()).toContain('SIGN_IN must be "on" or "off"');
    } finally {
      Object.assign(config, saved, { signInSetting: "" });
      config.google.clientId = "";
      config.google.clientSecret = "";
    }
  });
});

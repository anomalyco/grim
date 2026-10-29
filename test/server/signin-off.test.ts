// SIGN_IN off (the default for self-hosted servers): no accounts at all. Every visitor may do what an account may
// (workspaces, notes, folders, images, agent links) under its guest identity; sign-in routes are gone; /api/config and
// /api/server say so. And SIGN_IN=on without a sign-in method refuses to start (signInProblem).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isolate } from "./helpers.ts";

process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db } = await import("../../src/server/db.ts");
const restore = isolate(config, db);
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: false, signInSetting: "", quietMs: 100, pollMs: 60000, notesRepo: "off-notes" });
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
  return { status: res.status, data, headers: res.headers };
}

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
  base = `http://localhost:${app.server.port}`;
});

afterAll(async () => {
  await app?.stop();
  restore();
});

describe("sign-in off", () => {
  test("config and server info say so; no sign-in methods", async () => {
    expect((await api("GET", "/api/config")).data).toMatchObject({ signIn: false, googleLogin: false, githubLogin: false });
    expect((await api("GET", "/api/server")).data).toMatchObject({ signIn: false, google: false });
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
    expect((await api("POST", `/api/repos/${id}/files`, { path: "a.md", content: "hi" }, v)).status).toBe(201);
    expect((await api("POST", `/api/repos/${id}/rename`, { from: "a.md", to: "b.md" }, v)).status).toBe(200);
    const share = await api("POST", `/api/repos/${id}/shares`, {}, v);
    expect([200, 201]).toContain(share.status);
    // another visitor may edit, but only the maker removes it
    const other = visitor("offVisitor2", "crusty-sock");
    expect((await api("DELETE", `/api/repos/${id}/files?path=b.md`, undefined, other)).status).toBe(200);
    expect((await api("DELETE", `/api/repos/${id}`, undefined, other)).status).toBe(403);
    expect((await api("DELETE", `/api/repos/${id}`, undefined, v)).status).toBe(200);
  });

  test("commits carry the visitor's name, as guests' do", async () => {
    const v = visitor("offVisitor3", "wobbly-llama");
    const id = (await api("POST", "/api/workspaces", { title: "Authors" }, v)).data.id as string;
    await api("POST", `/api/repos/${id}/files`, { path: "n.md", content: "x" }, v);
    const history = await api("GET", `/api/repos/${id}/history?path=n.md`, undefined, v);
    expect(JSON.stringify(history.data)).toContain("wobbly-llama");
  });

  test("a request without a guest identity still may (one shared visitor)", async () => {
    expect((await api("POST", "/api/workspaces", { title: "Scripted" })).status).toBe(201);
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

// Workspaces: roles on every route and in rooms, invites, domain rules, link access (with guests), the joined list,
// note share links, agent links capped by their creator, event filtering, and the migration of older databases.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fakeGoogle, googleSignIn, isolate, roomHello, waitFor, type FakeGoogle } from "./helpers.ts";

const dir = process.env.DATA_DIR!;
process.env.QUIET_MS = "100";
process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db: earlyDb } = await import("../../src/server/db.ts");
const restore = isolate(config, earlyDb);
Object.assign(config, { storage: "local", allowDevLogin: true, allowedUsers: ["*"], quietMs: 100, pollMs: 60000, notesRepo: "wst-notes", signin: "open", allowedEmails: [] });
config.github.clientId = "";
config.github.appSlug = "";
Object.assign(config.google, {
  clientId: "ws-client",
  clientSecret: "ws-secret",
  authUrl: "https://fake-google.test/auth",
  tokenUrl: "https://fake-google.test/token",
  jwksUrl: "https://fake-google.test/certs",
});
const { startServer } = await import("../../src/server/index.ts");
const { db } = await import("../../src/server/db.ts");
const { setGoogleFetch } = await import("../../src/server/google.ts");
const { emit } = await import("../../src/server/events.ts");
const { embeddedImages } = await import("../../src/server/shares.ts");
const { parseDomainRule, emailMatches } = await import("../../src/server/workspaces.ts");

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";
let fg: FakeGoogle;

interface Person {
  cookie: string;
  id: string;
  name: string;
}

async function person(name: string, opts: { email?: string; verified?: boolean } = {}): Promise<Person> {
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name }), redirect: "manual" });
  expect(res.status).toBe(303);
  const cookie = res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
  const id = (await api(cookie, "GET", "/api/me")).data.id;
  db.query("UPDATE users SET email = COALESCE(?, email), email_verified = ? WHERE id = ?").run(opts.email ?? null, opts.verified ? 1 : 0, id);
  return { cookie, id, name };
}

async function guest(): Promise<Person> {
  const res = await fetch(`${base}/auth/guest`, { method: "POST", headers: { origin: base } });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
  const me = (await api(cookie, "GET", "/api/me")).data;
  return { cookie, id: me.id, name: me.name };
}

async function api(cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

/** A workspace owned by `owner` with notes and images committed. */
async function workspace(owner: Person, title: string, files: Record<string, string | Uint8Array> = {}) {
  const r = await api(owner.cookie, "POST", "/api/workspaces", { title });
  expect(r.status).toBe(201);
  const id = r.data.id as string;
  if (Object.keys(files).length) {
    await app.ctx.store.commit({
      repo: id,
      branch: "main",
      expectedHead: await app.ctx.store.head(id, "main"),
      changes: Object.entries(files).map(([path, content]) => ({ path, content: content as any })),
      message: "seed",
      author: { name: "x", email: "x@example.com" },
    });
  }
  return id;
}

const roomFor = (p: Person, repo: string, path: string, extra: Record<string, string> = {}) => roomHello(base, { repo, path, ...extra }, { cookie: p.cookie, origin: base });

beforeAll(async () => {
  fg = await fakeGoogle({ clientId: "ws-client", tokenUrl: config.google.tokenUrl, jwksUrl: config.google.jwksUrl });
  setGoogleFetch(fg.fetch);
  app = await startServer({ port: 0, quiet: true });
  base = `http://localhost:${app.server.port}`;
});

afterAll(async () => {
  await app?.stop();
  setGoogleFetch(null);
  restore();
});

describe("roles", () => {
  let owner: Person, editor: Person, viewer: Person, outsider: Person, first: Person;
  let ws = "";
  let sha = "";

  beforeAll(async () => {
    owner = await person("WS Owner", { email: "owner@ws.example", verified: true });
    editor = await person("WS Editor", { email: "editor@ws.example", verified: true });
    viewer = await person("WS Viewer", { email: "viewer@ws.example", verified: true });
    outsider = await person("WS Outsider", { email: "out@ws.example", verified: true });
    // The first account ever created, still marked admin in the database by older versions: nothing special.
    first = await person("WS First");
    db.query("UPDATE users SET created_at = 0, is_admin = 1 WHERE id = ?").run(first.id);
    ws = await workspace(owner, "WST Roles", { "a.md": "# A\n", "pic.png": PNG });
    expect((await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "editor@ws.example", role: "editor" })).data).toMatchObject({ role: "editor", pending: false, userId: editor.id });
    expect((await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "Viewer@WS.example", role: "viewer" })).data).toMatchObject({ role: "viewer", pending: false, userId: viewer.id });
    sha = (await api(owner.cookie, "GET", `/api/repos/${ws}/history?path=a.md`)).data[0].sha;
  });

  test("new workspaces are private, owned by their creator, and listed for them", async () => {
    const info = (await api(owner.cookie, "GET", `/api/workspaces/${ws}`)).data;
    expect(info).toMatchObject({ id: ws, title: "WST Roles", kind: "notes", role: "owner", linkAccess: "none", domainRule: null, ownerId: owner.id, readOnly: false });
    expect(info.members.map((m: any) => [m.name, m.role])).toEqual([
      ["WS Owner", "owner"],
      ["WS Editor", "editor"],
      ["WS Viewer", "viewer"],
    ]);
    expect((await api(owner.cookie, "GET", "/api/workspaces")).data.find((w: any) => w.id === ws)).toEqual({
      id: ws,
      title: "WST Roles",
      kind: "notes",
      role: "owner",
      linkAccess: "none",
      readOnly: false,
      status: "ready",
      head: expect.any(String),
      joinedVia: "member",
      canLeave: false,
    });
    expect((await api(viewer.cookie, "GET", "/api/workspaces")).data.find((w: any) => w.id === ws)).toMatchObject({ role: "viewer", canLeave: true });
    expect((await api(viewer.cookie, "GET", `/api/workspaces/${ws}`)).data.members).toBeUndefined();
    expect((await api(outsider.cookie, "GET", `/api/workspaces/${ws}`)).status).toBe(404);
    expect((await api(outsider.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
    expect((await api(outsider.cookie, "GET", "/api/repos")).data.some((w: any) => w.id === ws)).toBe(false);
    // Nobody has access to every workspace: the first account ever created is an outsider like any other.
    expect((db.query("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string }).id).toBe(first.id);
    expect((await api(first.cookie, "GET", `/api/workspaces/${ws}`)).status).toBe(404);
    expect((await api(first.cookie, "GET", `/api/repos/${ws}`)).status).toBe(404);
    expect((await api(first.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
    expect((await api(first.cookie, "GET", "/api/repos")).data.some((w: any) => w.id === ws)).toBe(false);
    expect("admin" in (await api(first.cookie, "GET", "/api/me")).data).toBe(false);
  });

  test("every route × every role", async () => {
    type R = { name: string; run: (p: Person) => Promise<{ status: number }>; ok: number };
    let n = 0;
    const routes: Array<R & { who: Record<string, number> }> = [];
    const read = { owner: 200, editor: 200, viewer: 200, first: 404, outsider: 404 };
    const write = { owner: 201, editor: 201, viewer: 403, first: 404, outsider: 404 };
    const write200 = { owner: 200, editor: 200, viewer: 403, first: 404, outsider: 404 };
    const own = { owner: 200, editor: 403, viewer: 403, first: 404, outsider: 404 };
    const add = (name: string, who: Record<string, number>, run: (p: Person) => Promise<{ status: number }>) => routes.push({ name, who, run, ok: 0 });
    add("details", read, (p) => api(p.cookie, "GET", `/api/repos/${ws}`));
    add("workspace", read, (p) => api(p.cookie, "GET", `/api/workspaces/${ws}`));
    add("tree", read, (p) => api(p.cookie, "GET", `/api/repos/${ws}/tree`));
    add("file", read, (p) => api(p.cookie, "GET", `/api/repos/${ws}/file?path=a.md`));
    add("history", read, (p) => api(p.cookie, "GET", `/api/repos/${ws}/history?path=a.md`));
    add("diff", read, (p) => api(p.cookie, "GET", `/api/repos/${ws}/diff?sha=${sha}`));
    add("raw", read, (p) => api(p.cookie, "GET", `/api/repos/${ws}/raw?path=pic.png`));
    add("search", read, (p) => api(p.cookie, "GET", `/api/repos/${ws}/search?q=A`));
    add("create file", write, (p) => api(p.cookie, "POST", `/api/repos/${ws}/files`, { path: `new-${p.name}-${n++}.md`, content: "x\n" }));
    add("rename", write200, async (p) => {
      const path = `mv-${n++}.md`;
      await api(owner.cookie, "POST", `/api/repos/${ws}/files`, { path, content: "x\n" });
      return api(p.cookie, "POST", `/api/repos/${ws}/rename`, { from: path, to: `moved-${n++}.md` });
    });
    add("delete file", write200, async (p) => {
      const path = `rm-${n++}.md`;
      await api(owner.cookie, "POST", `/api/repos/${ws}/files`, { path, content: "x\n" });
      return api(p.cookie, "DELETE", `/api/repos/${ws}/files?path=${path}`);
    });
    add("restore", write200, (p) => api(p.cookie, "POST", `/api/repos/${ws}/restore`, { path: "a.md", sha }));
    add("agent link", write, (p) => api(p.cookie, "POST", `/api/repos/${ws}/shares`, {}));
    add("patch", own, (p) => api(p.cookie, "PATCH", `/api/workspaces/${ws}`, { title: "WST Roles" }));
    add("members", own, (p) => api(p.cookie, "GET", `/api/workspaces/${ws}/members`));
    add("invite", own, (p) => api(p.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "later@ws.example", role: "viewer" }));
    const people = { owner, editor, viewer, outsider, first };
    for (const r of routes) {
      for (const [role, p] of Object.entries(people)) {
        const got = (await r.run(p)).status;
        expect(`${r.name} as ${role}: ${got}`).toBe(`${r.name} as ${role}: ${r.who[role]}`);
      }
    }
    // Removing the workspace: only its owners (link access gives nobody else that right).
    const doomed = await workspace(owner, "WST Doomed");
    await api(owner.cookie, "POST", `/api/workspaces/${doomed}/members`, { email: "editor@ws.example", role: "editor" });
    expect((await api(editor.cookie, "DELETE", `/api/repos/${doomed}`)).status).toBe(403);
    expect((await api(outsider.cookie, "DELETE", `/api/repos/${doomed}`)).status).toBe(404);
    expect((await api(first.cookie, "DELETE", `/api/repos/${doomed}`)).status).toBe(404);
    expect((await api(owner.cookie, "PATCH", `/api/workspaces/${doomed}`, { linkAccess: "edit" })).status).toBe(200);
    for (const p of [editor, outsider, first]) {
      expect((await api(p.cookie, "DELETE", `/api/repos/${doomed}`)).status).toBe(403);
      expect((await api(p.cookie, "PATCH", `/api/workspaces/${doomed}`, { linkAccess: "none" })).status).toBe(403);
      expect((await api(p.cookie, "POST", `/api/workspaces/${doomed}/members`, { email: "x@ws.example", role: "owner" })).status).toBe(403);
      expect((await api(p.cookie, "GET", `/api/workspaces/${doomed}/members`)).status).toBe(403);
    }
    expect((await api(owner.cookie, "DELETE", `/api/repos/${doomed}`)).data).toEqual({ ok: true });
  });

  test("rooms: owners and editors write; viewers get read-only connections; outsiders are refused", async () => {
    for (const p of [owner, editor]) {
      const { client, hello } = await roomFor(p, ws, "a.md");
      expect([p.name, hello?.readOnly]).toEqual([p.name, false]);
      client.close();
    }
    const v = await roomFor(viewer, ws, "a.md");
    expect(v.hello?.readOnly).toBe(true);
    const e = await roomFor(editor, ws, "a.md");
    await waitFor(() => e.client.text.toString().length > 0 && v.client.text.toString().length > 0);
    // The viewer's edits are ignored; the editor's arrive.
    v.client.text.insert(0, "VIEWER ");
    e.client.text.insert(0, "EDITOR ");
    await waitFor(() => v.client.text.toString().includes("EDITOR"));
    await Bun.sleep(100);
    expect(e.client.text.toString()).not.toContain("VIEWER");
    expect((await api(owner.cookie, "GET", `/api/repos/${ws}/file?path=a.md`)).data.content).not.toContain("VIEWER");
    v.client.close();
    e.client.close();
    expect((await roomFor(outsider, ws, "a.md")).client.closeCode).toBe(4403);
    expect((await roomFor(first, ws, "a.md")).client.closeCode).toBe(4403);
  });

  test("members: change roles, remove; the last owner can't be removed, demoted or leave", async () => {
    const list = (await api(owner.cookie, "GET", `/api/workspaces/${ws}/members`)).data;
    const me = list.find((m: any) => m.userId === owner.id);
    expect((await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "owner@ws.example", role: "editor" })).status).toBe(409);
    expect((await api(owner.cookie, "DELETE", `/api/workspaces/${ws}/members/${me.id}`)).status).toBe(409);
    expect((await api(owner.cookie, "DELETE", `/api/workspaces/${ws}/join`)).status).toBe(409);
    expect((await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "nope", role: "editor" })).status).toBe(400);
    expect((await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "x@ws.example", role: "god" })).status).toBe(400);
    // A second owner: now the first may step down.
    expect((await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "editor@ws.example", role: "owner" })).data.role).toBe("owner");
    expect((await api(editor.cookie, "GET", `/api/workspaces/${ws}/members`)).status).toBe(200);
    expect((await api(editor.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "editor@ws.example", role: "editor" })).data.role).toBe("editor");
    // Pending invites can be removed.
    const pending = (await api(owner.cookie, "GET", `/api/workspaces/${ws}/members`)).data.find((m: any) => m.email === "later@ws.example");
    expect(pending).toMatchObject({ pending: true, userId: null, role: "viewer" });
    expect((await api(owner.cookie, "DELETE", `/api/workspaces/${ws}/members/${pending.id}`)).data).toEqual({ ok: true });
    expect((await api(owner.cookie, "DELETE", `/api/workspaces/${ws}/members/nope`)).status).toBe(404);
  });
});

describe("invites and domain rules", () => {
  test("an email invite becomes a membership when that verified email first signs in with Google", async () => {
    const owner = await person("Inv Owner");
    const ws = await workspace(owner, "WST Invites");
    const inv = await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "New.Person@Invited.example", role: "editor" });
    expect(inv.data).toMatchObject({ email: "new.person@invited.example", pending: true, role: "editor" });
    const g = await googleSignIn(base, fg, { sub: "g-invited", email: "new.person@invited.example", name: "New Person" });
    expect(g.cookie).toBeTruthy();
    expect((await api(g.cookie!, "GET", `/api/repos/${ws}/tree`)).status).toBe(200);
    expect((await api(g.cookie!, "GET", "/api/workspaces")).data.find((w: any) => w.id === ws)).toMatchObject({ role: "editor", joinedVia: "member" });
    expect((await api(owner.cookie, "GET", `/api/workspaces/${ws}/members`)).data.find((m: any) => m.email === "new.person@invited.example")).toMatchObject({
      pending: false,
      name: "New Person",
      role: "editor",
    });
    // An unverified email never claims an invite.
    await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "unv@invited.example", role: "editor" });
    const unv = await person("Unv Invited", { email: "unv@invited.example", verified: false });
    expect((await api(unv.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(404);
  });

  test("domain rule: verified emails that match get the role; the workspace joins their list when opened", async () => {
    const owner = await person("Dom Owner");
    const ws = await workspace(owner, "WST Domain", { "d.md": "d\n" });
    expect((await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { domainRule: "*@corp" })).status).toBe(400);
    expect((await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { domainRule: "*@corp.example=owner" })).status).toBe(400);
    const patched = await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { domainRule: " *@Corp.example = viewer " });
    expect(patched.data.domainRule).toBe("*@corp.example=viewer");
    const corp = await person("Corp Person", { email: "jo@corp.example", verified: true });
    const fake = await person("Corp Faker", { email: "fake@corp.example", verified: false });
    const sub = await person("Corp Sub", { email: "jo@sub.corp.example", verified: true });
    expect((await api(fake.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(404);
    expect((await api(sub.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(404);
    expect((await api(corp.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
    expect((await api(corp.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(200);
    expect((await api(corp.cookie, "POST", `/api/repos/${ws}/files`, { path: "x.md" })).status).toBe(403);
    expect((await roomFor(corp, ws, "d.md")).hello?.readOnly).toBe(true);
    expect((await api(corp.cookie, "GET", "/api/workspaces")).data.find((w: any) => w.id === ws)).toMatchObject({ role: "viewer", joinedVia: "domain" });
    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { domainRule: "*@corp.example=editor,boss@else.example=viewer" });
    expect((await api(corp.cookie, "POST", `/api/repos/${ws}/files`, { path: "x.md" })).status).toBe(201);
    // Rule removed: access and the list entry go away.
    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { domainRule: null });
    expect((await api(corp.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(404);
    expect((await api(corp.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
  });

  test("rule parsing and matching", () => {
    expect(parseDomainRule("*@a.com=editor, b@c.org=viewer")?.rule).toBe("*@a.com=editor,b@c.org=viewer");
    expect(parseDomainRule("*@a.com")).toBeNull();
    expect(parseDomainRule("a.com=editor")).toBeNull();
    expect(parseDomainRule("")).toBeNull();
    expect(emailMatches("*@a.com", "X@A.com")).toBe(true);
    expect(emailMatches("*@a.com", "x@ba.com")).toBe(false);
    expect(emailMatches("*@a.com", "x@b.a.com")).toBe(false);
  });
});

describe("link access and the joined list", () => {
  test("none / view / edit, for guests too; opening records the join; leave removes it", async () => {
    const owner = await person("Link Owner");
    const ws = await workspace(owner, "WST Link", { "l.md": "l\n" });
    const g = await guest();
    expect((await api(g.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(404);
    expect((await roomFor(g, ws, "l.md")).client.closeCode).toBe(4403);
    expect((await api(g.cookie, "GET", `/api/workspaces/${ws}/public`)).data).toEqual({ linkAccess: "none" });
    expect((await fetch(`${base}/api/workspaces/${ws}/public`)).status).toBe(200);
    expect((await fetch(`${base}/api/workspaces/${ws}`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/workspaces/no-such-ws/public`)).json()).toEqual({ linkAccess: "none" });

    expect((await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "public" })).status).toBe(400);
    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "view" });
    expect(await (await fetch(`${base}/api/workspaces/${ws}/public`)).json()).toEqual({ linkAccess: "view" });
    expect((await api(g.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
    expect((await api(g.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(200);
    expect((await api(g.cookie, "POST", `/api/repos/${ws}/files`, { path: "g.md" })).status).toBe(403);
    expect((await roomFor(g, ws, "l.md")).hello?.readOnly).toBe(true);
    expect((await api(g.cookie, "GET", "/api/workspaces")).data.find((w: any) => w.id === ws)).toMatchObject({ role: "viewer", linkAccess: "view", joinedVia: "link" });
    // Opening the room alone also records the join.
    const g2 = await guest();
    expect((await roomFor(g2, ws, "l.md")).hello?.readOnly).toBe(true);
    expect((await api(g2.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(true);

    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "edit" });
    expect((await api(g.cookie, "POST", `/api/repos/${ws}/files`, { path: "g.md" })).status).toBe(201);
    expect((await roomFor(g, ws, "l.md")).hello?.readOnly).toBe(false);
    expect((await api(g.cookie, "GET", "/api/workspaces")).data.find((w: any) => w.id === ws).role).toBe("editor");
    // Link-access workspaces can't be managed by their visitors.
    expect((await api(g.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "none" })).status).toBe(403);

    // Leave: gone from the list, access unchanged; opening it again rejoins.
    expect((await api(g.cookie, "DELETE", `/api/workspaces/${ws}/join`)).data).toEqual({ ok: true });
    expect((await api(g.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
    expect((await api(g.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(200);
    expect((await api(g.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(true);
    // Link access turned off: not listed, no access.
    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "none" });
    expect((await api(g.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
    expect((await api(g.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(404);
  });

  test("open room connections follow access changes", async () => {
    const owner = await person("Live Owner");
    const ws = await workspace(owner, "WST Live", { "n.md": "n\n" });
    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "edit" });
    const g = await guest();
    const m = await person("Live Member", { email: "live@ws.example", verified: true });
    await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "live@ws.example", role: "editor" });
    const gr = await roomFor(g, ws, "n.md");
    const mr = await roomFor(m, ws, "n.md");
    const or = await roomFor(owner, ws, "n.md");
    expect([gr.hello?.readOnly, mr.hello?.readOnly]).toEqual([false, false]);
    // Down to view: the guest's writable connection is closed so it reconnects read-only.
    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "view" });
    await waitFor(() => gr.client.closeCode !== null);
    expect(gr.client.closeCode).toBe(1013);
    expect((await roomFor(g, ws, "n.md")).hello?.readOnly).toBe(true);
    // Removed as a member: down to the link's view access.
    const id = (await api(owner.cookie, "GET", `/api/workspaces/${ws}/members`)).data.find((x: any) => x.userId === m.id).id;
    await api(owner.cookie, "DELETE", `/api/workspaces/${ws}/members/${id}`);
    await waitFor(() => mr.client.closeCode !== null);
    expect(mr.client.closeCode).toBe(1013);
    // Link access off: read-only connections without other access are closed for good.
    const g2 = await roomFor(g, ws, "n.md");
    await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "none" });
    await waitFor(() => g2.client.closeCode !== null);
    expect(g2.client.closeCode).toBe(4403);
    await Bun.sleep(50);
    expect(or.client.closeCode).toBeNull();
    or.client.close();
  });

  test("members may leave; their role goes with them", async () => {
    const owner = await person("Leave Owner");
    const ws = await workspace(owner, "WST Leave");
    const m = await person("Leave Member", { email: "leaver@ws.example", verified: true });
    await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "leaver@ws.example", role: "editor" });
    expect((await api(m.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(true);
    expect((await api(m.cookie, "DELETE", `/api/workspaces/${ws}/join`)).data).toEqual({ ok: true });
    expect((await api(m.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(404);
    expect((await api(m.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
  });

  test("creating a workspace can set its link access; legacy POST /api/repos works too", async () => {
    const owner = await person("Create Owner");
    const r = await api(owner.cookie, "POST", "/api/workspaces", { title: "WST Open", linkAccess: "view" });
    expect(r.data).toMatchObject({ role: "owner", linkAccess: "view", joinedVia: "member", domainRule: null });
    expect((await api(owner.cookie, "POST", "/api/workspaces", { title: "WST Bad", linkAccess: "all" })).status).toBe(400);
    expect((await api(owner.cookie, "POST", "/api/workspaces", {})).status).toBe(400);
    const legacy = await api(owner.cookie, "POST", "/api/repos", { title: "WST Legacy" });
    expect((await api(owner.cookie, "GET", `/api/workspaces/${legacy.data.id}`)).data).toMatchObject({ role: "owner", linkAccess: "none" });
  });
});

describe("note share links", () => {
  let owner: Person, outsider: Person, ws: string;
  let viewLink: { id: string; url: string }, editLink: { id: string; url: string };
  const note = "notes/a.md";

  beforeAll(async () => {
    owner = await person("Note Owner");
    outsider = await person("Note Outsider");
    ws = await workspace(owner, "WST Notes", {
      [note]: "# A\n![pic](pic.png) ![up](../top.png \"t\")\n<img src=\"/imgs/html.png\">\n",
      "notes/b.md": "# B secret\n![](other.png)\n",
      "notes/pic.png": PNG,
      "top.png": PNG,
      "imgs/html.png": PNG,
      "notes/other.png": PNG,
    });
    const v = await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, { kind: "note", path: note, role: "viewer" });
    expect(v.status).toBe(201);
    viewLink = v.data;
    expect(v.data).toMatchObject({ kind: "note", path: note, role: "viewer" });
    expect(v.data.url).toBe(`${config.publicUrl}/app/${ws}/notes/a.md?share=${v.data.id}`);
    editLink = (await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, { kind: "note", path: "notes/a", role: "editor" })).data;
  });

  test("creating: path must exist; reuse returns the same link; list filters by kind and path", async () => {
    expect((await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, { kind: "note", path: "nope.md" })).status).toBe(404);
    expect((await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, { kind: "note" })).status).toBe(400);
    expect((await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, { kind: "file", path: note })).status).toBe(400);
    expect((await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, { kind: "note", path: note, role: "viewer", reuse: true })).data.id).toBe(viewLink.id);
    const notes = (await api(owner.cookie, "GET", `/api/repos/${ws}/shares?kind=note&path=${note}`)).data;
    expect(notes.map((s: any) => s.id).sort()).toEqual([viewLink.id, editLink.id].sort());
    expect(notes.find((s: any) => s.id === editLink.id)).toMatchObject({ kind: "note", path: note, role: "editor", url: editLink.url });
    expect((await api(owner.cookie, "GET", `/api/repos/${ws}/shares?kind=agent`)).data).toEqual([]);
  });

  test("a viewer link opens that note, its images and history, nothing else", async () => {
    const s = `share=${viewLink.id}`;
    const get = (path: string) => api(outsider.cookie, "GET", path.includes("?") ? `${path}&${s}` : `${path}?${s}`);
    expect((await api(outsider.cookie, "GET", `/api/repos/${ws}/tree`)).status).toBe(404);
    const info = await get(`/api/repos/${ws}`);
    expect(info.data).toMatchObject({ id: ws, access: "read", canShare: false, canRemove: false, scope: { path: note, role: "viewer", sharedBy: "Note Owner" } });
    expect((await get(`/api/repos/${ws}/tree`)).data.files).toEqual([note]);
    expect((await get(`/api/repos/${ws}/file?path=${note}`)).data.content).toContain("# A");
    expect((await get(`/api/repos/${ws}/file?path=notes/b.md`)).status).toBe(403);
    expect((await get(`/api/repos/${ws}/file`)).status).toBe(403);
    for (const img of ["notes/pic.png", "top.png", "imgs/html.png"]) expect([img, (await get(`/api/repos/${ws}/raw?path=${img}`)).status]).toEqual([img, 200]);
    expect((await get(`/api/repos/${ws}/raw?path=notes/other.png`)).status).toBe(403);
    const hist = await get(`/api/repos/${ws}/history?path=${note}`);
    expect(hist.status).toBe(200);
    expect((await get(`/api/repos/${ws}/history`)).status).toBe(403);
    expect((await get(`/api/repos/${ws}/history?path=notes/b.md`)).status).toBe(403);
    expect((await get(`/api/repos/${ws}/diff?sha=${hist.data[0].sha}&path=${note}`)).status).toBe(200);
    expect((await get(`/api/repos/${ws}/diff?sha=${hist.data[0].sha}`)).status).toBe(403);
    expect((await get(`/api/repos/${ws}/search?q=secret`)).status).toBe(403);
    expect((await api(outsider.cookie, "POST", `/api/repos/${ws}/files?${s}`, { path: "x.md" })).status).toBe(403);
    expect((await api(outsider.cookie, "POST", `/api/repos/${ws}/restore?${s}`, { path: note, sha: hist.data[0].sha })).status).toBe(403);
    expect((await api(outsider.cookie, "GET", `/api/repos/${ws}/shares?${s}`)).status).toBe(403);
    // The header works like the query parameter.
    expect((await api(outsider.cookie, "GET", `/api/repos/${ws}/file?path=${note}`, undefined, { "x-grimoire-share": viewLink.id })).status).toBe(200);
    // Rooms: the note read-only, other notes refused.
    expect((await roomFor(outsider, ws, note, { share: viewLink.id })).hello?.readOnly).toBe(true);
    expect((await roomFor(outsider, ws, "notes/b.md", { share: viewLink.id })).client.closeCode).toBe(4403);
    // Not listed, not joined; and a link for another workspace does nothing here.
    expect((await api(outsider.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
    const other = await workspace(owner, "WST Notes Other", { "o.md": "o\n" });
    expect((await api(outsider.cookie, "GET", `/api/repos/${other}/file?path=o.md&${s}`)).status).toBe(404);
    // Public info about the link.
    expect(await (await fetch(`${base}/api/note-links/${viewLink.id}`)).json()).toEqual({
      id: viewLink.id,
      workspace: { id: ws, title: "WST Notes" },
      path: note,
      role: "viewer",
      sharedBy: "Note Owner",
      server: new URL(config.publicUrl).host,
    });
    // Note links never open the agent shell.
    expect((await fetch(`${base}/a/${viewLink.id}`)).status).toBe(404);
  });

  test("an editor link edits that note (room and restore); revoking ends it; it dies with its creator's access", async () => {
    const s = editLink.id;
    const r = await roomFor(outsider, ws, note, { share: s });
    expect(r.hello?.readOnly).toBe(false);
    r.client.close();
    const sha = (await api(outsider.cookie, "GET", `/api/repos/${ws}/history?path=${note}&share=${s}`)).data[0].sha;
    expect((await api(outsider.cookie, "POST", `/api/repos/${ws}/restore?share=${s}`, { path: note, sha })).data).toEqual({ ok: true });
    expect((await api(outsider.cookie, "POST", `/api/repos/${ws}/restore?share=${s}`, { path: "notes/b.md", sha })).status).toBe(403);
    // A viewer member with an editor link may edit that note.
    const vm = await person("Note Viewer Member", { email: "nvm@ws.example", verified: true });
    await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "nvm@ws.example", role: "viewer" });
    expect((await roomFor(vm, ws, note)).hello?.readOnly).toBe(true);
    expect((await roomFor(vm, ws, note, { share: s })).hello?.readOnly).toBe(false);
    expect((await roomFor(vm, ws, "notes/b.md", { share: s })).hello?.readOnly).toBe(true);
    // A viewer can't make editor links (or any link to a writable workspace).
    expect((await api(vm.cookie, "POST", `/api/repos/${ws}/shares`, { kind: "note", path: note, role: "editor" })).status).toBe(403);

    // Made by an editor who is then removed: the link stops working.
    const ed = await person("Note Editor", { email: "ned@ws.example", verified: true });
    await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "ned@ws.example", role: "editor" });
    const theirs = (await api(ed.cookie, "POST", `/api/repos/${ws}/shares`, { kind: "note", path: note })).data;
    expect(theirs.role).toBe("editor");
    expect((await api(outsider.cookie, "GET", `/api/repos/${ws}/file?path=${note}&share=${theirs.id}`)).status).toBe(200);
    await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "ned@ws.example", role: "viewer" });
    expect((await roomFor(outsider, ws, note, { share: theirs.id })).hello?.readOnly).toBe(true);
    const memberId = (await api(owner.cookie, "GET", `/api/workspaces/${ws}/members`)).data.find((m: any) => m.userId === ed.id).id;
    await api(owner.cookie, "DELETE", `/api/workspaces/${ws}/members/${memberId}`);
    expect((await api(outsider.cookie, "GET", `/api/repos/${ws}/file?path=${note}&share=${theirs.id}`)).status).toBe(404);
    expect((await fetch(`${base}/api/note-links/${theirs.id}`)).status).toBe(404);

    expect((await api(owner.cookie, "DELETE", `/api/shares/${s}`)).data).toEqual({ ok: true });
    expect((await api(outsider.cookie, "GET", `/api/repos/${ws}/file?path=${note}&share=${s}`)).status).toBe(404);
    expect((await roomFor(outsider, ws, note, { share: s })).client.closeCode).toBe(4403);
  });

  test("embedded image paths", () => {
    const md = "![a](x.png) ![b](<sp ace.png>) ![c](../up.png 'q') ![d](/root.png) ![e](https://x.example/y.png) ![f](../../out.png) ![g](a%20b.png?x=1#y)\n<img alt=x src='h.png'>";
    expect([...embeddedImages(md, "dir/n.md")].sort()).toEqual(["dir/a b.png", "dir/h.png", "dir/sp ace.png", "dir/x.png", "root.png", "up.png"]);
  });
});

describe("agent links and events", () => {
  test("agent links are capped by their creator's current role", async () => {
    const owner = await person("Agent Owner");
    const ws = await workspace(owner, "WST Agent", { "t.md": "t\n" });
    const ed = await person("Agent Editor", { email: "aed@ws.example", verified: true });
    await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "aed@ws.example", role: "editor" });
    const link = (await api(ed.cookie, "POST", `/api/repos/${ws}/shares`, { label: "Bot" })).data;
    const url = `${base}/a/${link.url.split("/a/")[1]}`;
    const run = async (cmd: string) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: cmd }) })).json() as Promise<any>;
    expect((await run("echo x >> t.md")).exitCode).toBe(0);
    // Only this workspace is visible.
    expect((await run("ls /workspace")).stdout.trim()).toBe(ws);
    await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "aed@ws.example", role: "viewer" });
    const w = await run("echo y >> t.md");
    expect(w.exitCode).not.toBe(0);
    expect(w.stderr).toContain("read-only");
    expect(await (await fetch(url)).text()).toContain("read-only");
    // A viewer-role agent link stays read-only even for an owner.
    const ro = (await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, { role: "viewer" })).data;
    expect(ro.role).toBe("viewer");
    expect(await (await fetch(`${base}/a/${ro.id}`)).text()).toContain("read-only");
    const memberId = (await api(owner.cookie, "GET", `/api/workspaces/${ws}/members`)).data.find((m: any) => m.userId === ed.id).id;
    await api(owner.cookie, "DELETE", `/api/workspaces/${ws}/members/${memberId}`);
    expect((await fetch(url)).status).toBe(404);
  });

  test("the event stream carries nothing about workspaces the user can't see", async () => {
    const owner = await person("Ev Owner");
    const priv = await workspace(owner, "WST Ev Private");
    const open = await workspace(owner, "WST Ev Open");
    await api(owner.cookie, "PATCH", `/api/workspaces/${open}`, { linkAccess: "view" });
    const x = await person("Ev Outsider");
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { cookie: x.cookie }, signal: ac.signal });
    const reader = res.body!.getReader();
    let got = "";
    await waitFor(async () => {
      got += new TextDecoder().decode((await reader.read()).value);
      return got.includes(": connected");
    });
    emit({ type: "tree", repo: priv });
    emit({ type: "presence", repo: priv, path: "a.md", users: [{ id: "u", name: "Secret Person", color: "#000", kind: "human" }] });
    emit({ type: "saved", repo: priv, path: "a.md", sha: "abc" });
    emit({ type: "tree", repo: open });
    emit({ type: "repos" });
    while (!got.includes("event: repos")) got += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    expect(got).toContain(`"repo":"${open}"`);
    expect(got).not.toContain(priv);
    expect(got).not.toContain("Secret Person");
  });
});

describe("migration", () => {
  test("an older database: notebooks → link 'edit', GitHub copies → 'view', owned by whoever made them (never by the old admin); everyone has joined everything", async () => {
    const tmp = mkdtempSync(join(dir, "migrate-ws-"));
    const { Database } = await import("bun:sqlite");
    const old = new Database(join(tmp, "grimoire.sqlite"));
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, github_id INTEGER UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, avatar TEXT, github_token TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE repos (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, gh_owner TEXT, gh_name TEXT, read_only INTEGER NOT NULL DEFAULT 0, branch TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_by TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE share_links (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE, label TEXT, created_by TEXT REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
      INSERT INTO users (id, login, name, email, is_admin, created_at) VALUES ('admin', 'a', 'A', 'a@x', 1, 1), ('u2', 'b', 'B', 'b@x', 0, 2), ('u3', 'c', 'C', 'c@x', 0, 3);
      INSERT INTO repos (id, title, kind, branch, status, created_by, created_at) VALUES ('notes', 'Notes', 'notes', 'main', 'ready', NULL, 1), ('team', 'Team', 'notes', 'main', 'ready', 'u2', 2);
      INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_by, created_at) VALUES ('gh-o-r', 'o/r', 'github', 'o', 'r', 1, 'main', 'ready', 'u3', 3), ('gh-gone', 'o/g', 'github', 'o', 'g', 1, 'main', 'ready', 'deleted-user', 4);
      INSERT INTO share_links (id, repo_id, label, created_by, created_at) VALUES ('l1', 'team', 'Kept', 'u2', 5);`);
    old.close();
    const script = `const { db } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/db.ts"))});
      const q = (s) => db.query(s).all();
      console.log(JSON.stringify({
        repos: q("SELECT id, link_access, owner_id, domain_rule FROM repos ORDER BY id"),
        members: q("SELECT workspace_id, user_id, role FROM members ORDER BY workspace_id, user_id"),
        joined: q("SELECT workspace_id || ':' || user_id AS k FROM joined ORDER BY k").map((r) => r.k),
        users: q("SELECT id, email_verified, google_sub FROM users ORDER BY id"),
        shares: q("SELECT id, kind, path, role FROM share_links"),
        tables: q("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('members', 'joined', 'app_tokens') ORDER BY name").map((r) => r.name),
      }));`;
    const run = async () => {
      const p = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, DATA_DIR: tmp }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(err).toBe("");
      return JSON.parse(out);
    };
    const r = await run();
    expect(r.repos).toEqual([
      { id: "gh-gone", link_access: "view", owner_id: null, domain_rule: null },
      { id: "gh-o-r", link_access: "view", owner_id: "u3", domain_rule: null },
      { id: "notes", link_access: "edit", owner_id: null, domain_rule: null },
      { id: "team", link_access: "edit", owner_id: "u2", domain_rule: null },
    ]);
    expect(r.members).toEqual([
      { workspace_id: "gh-o-r", user_id: "u3", role: "owner" },
      { workspace_id: "team", user_id: "u2", role: "owner" },
    ]);
    expect(r.joined).toEqual(
      ["gh-gone:admin", "gh-gone:u2", "gh-gone:u3", "gh-o-r:admin", "gh-o-r:u2", "notes:admin", "notes:u2", "notes:u3", "team:admin", "team:u3"].sort(),
    );
    expect(r.users).toEqual([
      { id: "admin", email_verified: 0, google_sub: null },
      { id: "u2", email_verified: 0, google_sub: null },
      { id: "u3", email_verified: 0, google_sub: null },
    ]);
    expect(r.shares).toEqual([{ id: "l1", kind: "agent", path: null, role: null }]);
    expect(r.tables).toEqual(["app_tokens", "joined", "members"]);
    // Running again changes nothing.
    expect(await run()).toEqual(r);
  });
});

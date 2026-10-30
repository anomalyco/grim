// Which server an e2e script runs against:
// - default (TARGET=bun): the Bun server in this process (startServer), in a temp DATA_DIR, as before;
// - TARGET=workers: the Workers build under `wrangler dev --local` (scripts/wrangler-dev.ts), started for this script
//   with its env as Worker vars, a fresh local D1 and no Code Storage secrets;
// - BASE_URL=<url>: a server that is already running (e.g. one wrangler dev for several scripts, or staging). Its
//   settings (QUIET_MS, …) are whatever it was started with.
// Hosted servers have no default `notes` workspace, so on Workers/BASE_URL the target signs in a helper account,
// creates one ("Notes", holding the same Welcome.md as Bun's) and scripts use `T.ws` instead of "notes". The helpers
// below (history, committed text, live text, save, files) go through the server's internals on Bun and through the
// HTTP API and the agent link elsewhere, so the checks read the same.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WELCOME = `# Welcome to Grim

This is a shared notebook. Everything here is stored in Git, and everyone who has it open sees edits and cursors live.

- Notes save themselves: every change is committed to Git a few seconds after you stop typing.
- Use **History** to see every version of a note.
- Agents can read and write notes too: click **Share** next to **Share this workspace with an agent** at the bottom of the sidebar, then **Copy prompt**, and paste the prompt to your agent.
`;

/** The Bun server's NOTES_REPO default. */
const BUN_NOTES = "notes";

/**
 * @param {{ env?: Record<string, string>, port?: number, name?: string }} opts
 *   env: server settings (process.env on Bun, `--var`s on Workers); port: a fixed port (0 = any free one).
 */
export async function startTarget(opts = {}) {
  if (process.env.BASE_URL) return remoteTarget(process.env.BASE_URL.replace(/\/$/, ""), "remote", null);
  if (process.env.TARGET === "workers") return startWorkers(opts);
  if (process.env.TARGET && process.env.TARGET !== "bun") throw new Error(`TARGET must be bun or workers, not ${process.env.TARGET}`);
  return startBun(opts);
}

/** The Bun server in this process (one per process: it reads its config from process.env once). */
export function startBun(opts = {}) {
  // (MARKETING_SITE: the suites use the home page, which is only on the marketing site)
  return bunTarget({ ALLOW_DEV_LOGIN: "1", SIGN_IN: "on", MARKETING_SITE: "on", ...opts.env }, opts.port ?? 0);
}

/** The Workers build under wrangler dev, started for this caller. */
export async function startWorkers(opts = {}) {
  const { startWrangler } = await import("../../scripts/wrangler-dev.ts");
  const w = await startWrangler({ vars: { ALLOW_DEV_LOGIN: "1", SIGN_IN: "on", MARKETING_SITE: "on", ...opts.env }, port: opts.port, quiet: !process.env.WRANGLER_LOGS });
  try {
    // localhost like the Bun target (wrangler listens on 127.0.0.1), so PUBLIC_URL=http://localhost:<port> matches
    return await remoteTarget(w.base.replace("//127.0.0.1:", "//localhost:"), "workers", w);
  } catch (e) {
    await w.stop();
    throw e;
  }
}

async function bunTarget(env, port) {
  const dataDir = mkdtempSync(join(tmpdir(), "np-e2e-"));
  Object.assign(process.env, { DATA_DIR: dataDir, PORT: String(port) }, env);
  const { startServer } = await import("../../src/server/index.ts");
  const app = await startServer({ port, quiet: true });
  const store = app.ctx.store;
  const head = (repo) => store.head(repo, "main");
  return {
    kind: "bun",
    bun: true,
    base: `http://localhost:${app.server.port}`,
    app,
    ws: BUN_NOTES,
    /** Where a signed-in person lands on the default notebook. */
    appPath: "/app",
    async history(repo, path, limit = 50) {
      return store.history(repo, "main", path, limit);
    },
    async committed(repo, path) {
      return store.readFile(repo, path, await head(repo));
    },
    async live(repo, path) {
      return app.ctx.rooms.peek(repo, path)?.text.toString() ?? "";
    },
    async isOpen(repo, path) {
      return !!app.ctx.rooms.peek(repo, path);
    },
    async save(repo, path) {
      await app.ctx.rooms.peek(repo, path)?.flush();
    },
    /** Whether the workspace's head has this file (notes or images). */
    async exists(repo, path) {
      return (await store.listFiles(repo, await head(repo))).includes(path);
    },
    /** One SQL statement on the global tables (D1 on Workers: start those with REPO_CACHE=0 if they change repos). */
    async sql(statement) {
      const { db } = await import("../../src/server/db.ts");
      return db.query(statement).all();
    },
    async resetDemo() {
      const { resetDemo } = await import("../../src/server/demo.ts");
      await resetDemo(app.ctx);
    },
    async stop() {
      await app.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function remoteTarget(base, kind, wrangler) {
  const helper = await signIn(base, "E2E helper");
  const call = async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { cookie: helper, origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
    return json;
  };
  // the helper's agent link per workspace (/a/<id>): the shell
  const links = new Map();
  const shell = async (command, ws) => {
    if (!links.has(ws)) links.set(ws, (await call("POST", `/api/workspace/${enc(ws)}/agent-link`, {})).url.replace(/^https?:\/\/[^/]+/, base));
    const r = await fetch(links.get(ws), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command }) });
    const out = await r.json();
    if (out.exitCode !== 0) throw new Error(`shell \`${command}\`: ${out.exitCode} ${out.stderr}`);
    return out.stdout;
  };
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const enc = encodeURIComponent;

  // A notebook like Bun's default one: Welcome.md only.
  const repo = await call("POST", "/api/workspaces", { title: "Notes" });
  const ws = repo.id;
  await call("POST", `/api/workspace/${enc(ws)}/files`, { path: "Welcome.md", content: WELCOME });
  await call("DELETE", `/api/workspace/${enc(ws)}/files?path=README.md`);
  await shell(`save /workspace/${ws}`, ws);

  const t = {
    kind,
    bun: false,
    base,
    app: null,
    ws,
    appPath: `/app/${ws}`,
    helperCookie: helper,
    call,
    shell,
    async history(repo, path, limit = 50) {
      return call("GET", `/api/workspace/${enc(repo)}/history?limit=${limit}${path ? `&path=${enc(path)}` : ""}`);
    },
    async committed(repo, path) {
      const [last] = await t.history(repo, undefined, 1);
      if (!last) return null;
      const r = await fetch(`${base}/api/workspace/${enc(repo)}/file?path=${enc(path)}&ref=${last.sha}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`committed ${path}: ${r.status}`);
      return (await r.json()).content;
    },
    async live(repo, path) {
      const r = await fetch(`${base}/api/workspace/${enc(repo)}/file?path=${enc(path)}`);
      if (!r.ok) return "";
      const j = await r.json();
      return j.live ? j.content : "";
    },
    async isOpen(repo, path) {
      const r = await fetch(`${base}/api/workspace/${enc(repo)}/file?path=${enc(path)}`);
      return r.ok && (await r.json()).live === true;
    },
    async save(repo, path) {
      await shell(`save ${q(`/workspace/${repo}/${path}`)}`, repo);
    },
    /** Whether the workspace's head has this file (notes or images: raw serves images, file the rest). */
    async exists(repo, path) {
      const [last] = await t.history(repo, undefined, 1);
      if (!last) return false;
      const sub = /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path) ? "raw" : "file";
      const r = await fetch(`${base}/api/workspace/${enc(repo)}/${sub}?path=${enc(path)}&ref=${last.sha}`);
      await r.arrayBuffer();
      if (r.status !== 200 && r.status !== 404) throw new Error(`exists ${path}: ${r.status}`);
      return r.status === 200;
    },
    async sql(statement) {
      if (!wrangler) throw new Error("sql needs TARGET=workers (it runs wrangler d1 execute on the local D1)");
      return wrangler.sql(statement);
    },
    async resetDemo() {
      // wrangler dev's cron trigger (/__scheduled would be served by the static assets' SPA fallback)
      if (!wrangler) throw new Error("resetDemo needs TARGET=workers (it fires the */5 cron through wrangler dev, at time 0: a DEMO_RESET_MINUTES boundary)");
      const r = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=${enc("*/5 * * * *")}&time=0`);
      if (!r.ok) throw new Error(`scheduled: ${r.status} ${await r.text()}`);
    },
    async stop() {
      // The helper's workspace stays on a shared server only if removing it fails.
      if (!wrangler) await call("DELETE", `/api/workspace/${enc(ws)}`).catch(() => {});
      await wrangler?.stop();
    },
  };
  return t;
}

/** A new account through the test sign-in (POST /auth/dev, test servers only): the session cookie (`name=value`). */
export async function signIn(base, name) {
  const r = await fetch(`${base}/auth/dev`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ name, next: "/app" }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("np_session="));
  if (!cookie) throw new Error(`test sign-in at ${base} failed: ${r.status} ${await r.text()}`);
  return cookie;
}

/** A check left out on this target, with why (counted as skipped by scripts/e2e-workers.ts). */
export function skip(name, reason) {
  console.log("skip", name, `(${reason})`);
}

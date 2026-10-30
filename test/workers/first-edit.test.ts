// The first edits of a new note on Workers (Miniflare 5, the production router and WorkspaceDO over an in-memory Git
// store): a note created through the API and typed in right away is committed once, quietMs after the last
// keystroke, as its "Create" commit holding the typed text (the creation itself waits for the quiet period, so
// the first edit joins it); the next edit gets its own "Update" commit just as soon. A note created and left alone
// is committed quietMs after its creation.
// FIRST_EDIT_URL=https://staging.grimnotes.app also runs the first case against that server, as the account of
// FIRST_EDIT_COOKIE (a browser's `np_session=…` after Google sign-in: deployed servers have no other sign-in; makes a
// scratch workspace and removes it), with its own quiet period (QUIET_MS, default 3000).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { sha256 } from "../../src/server/ids.ts";
import { room, type RoomClient } from "../server/helpers.ts";
import { migrationStatements, localConfig } from "./miniflare.ts";

const ROOT = join(import.meta.dir, "../..");
const QUIET_MS = 1000;
// a commit is due quietMs after the last edit; allow for the commit itself and the polling
const MARGIN_MS = 1500;
const ALICE = { origin: "", cookie: "np_session=tok-first" };

setDefaultTimeout(60_000);

let mf: Miniflare;
let base: string;
let outdir: string;
const clients: RoomClient[] = [];

beforeAll(async () => {
  const cfg = localConfig();
  outdir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-first-edit-"));
  const alias = cfg.alias ?? {};
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "workspace.worker.js")],
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
  if (!built.success) throw new AggregateError(built.logs, "bundling the test Worker failed");
  const { compatibilityDate, compatibilityFlags, bindings, d1Databases, durableObjects } = unstable_getMiniflareWorkerOptions(cfg).workerOptions as Record<string, unknown>;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      workers: [
        {
          compatibilityDate,
          compatibilityFlags,
          bindings: { ...(bindings as object), QUIET_MS: String(QUIET_MS), WORKSPACE_ALARM_MS: "600000" },
          d1Databases,
          durableObjects,
          name: "grim-first-edit",
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
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'u1', ?)").bind(sha256("tok-first"), now + 3_600_000),
    db.prepare("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('fe', 'fe', 'notes', 'main', 'ready', ?)").bind(now),
  ]);
  expect((await fetch(`${base}/__test/seed?repo=fe`)).status).toBe(200);
}, 60_000);

afterAll(async () => {
  for (const c of clients) c.close();
  await mf?.dispose();
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

type Commit = { sha: string; message: string };
const history = async (path: string) =>
  (await (await fetch(`${base}/api/workspace/fe/history?path=${encodeURIComponent(path)}`, { headers: ALICE })).json()) as Commit[];
const committed = async (path: string) => ((await (await fetch(`${base}/__test/git?repo=fe&path=${encodeURIComponent(path)}`)).json()) as { content: string | null }).content;
const create = async (path: string, content?: string) => {
  const r = await fetch(`${base}/api/workspace/fe/files`, { method: "POST", headers: { ...ALICE, "content-type": "application/json" }, body: JSON.stringify({ path, content }) });
  expect(r.status).toBe(201);
};

/** Milliseconds until `path`'s history has `n` commits (polling), or -1 after `ms`. */
async function commitsAfter(path: string, n: number, ms: number) {
  const t = performance.now();
  while (performance.now() - t < ms) {
    if ((await history(path)).length >= n) return performance.now() - t;
    await Bun.sleep(50);
  }
  return -1;
}

test("typed right after creating: committed quietMs after the last keystroke, in the Create commit", async () => {
  const path = "First.md";
  await create(path, "");
  const a = room(base, { repo: "fe", path }, ALICE);
  clients.push(a);
  await a.opened;
  a.text.insert(0, "# Hello\n");
  await Bun.sleep(300);
  a.text.insert(a.text.length, "first edit\n");
  const ms = await commitsAfter(path, 1, QUIET_MS + MARGIN_MS);
  expect(ms).toBeGreaterThanOrEqual(0);
  expect(ms).toBeGreaterThan(QUIET_MS - 200);
  expect((await history(path)).map((c) => c.message)).toEqual([`Create ${path}`]);
  expect(await committed(path)).toBe("# Hello\nfirst edit\n");

  // the next edit: its own commit, as soon
  a.text.insert(a.text.length, "second\n");
  expect(await commitsAfter(path, 2, QUIET_MS + MARGIN_MS)).toBeGreaterThanOrEqual(0);
  expect((await history(path)).map((c) => c.message)).toEqual([`Update ${path}`, `Create ${path}`]);
  expect(await committed(path)).toBe("# Hello\nfirst edit\nsecond\n");
});

test("created and left alone: committed quietMs after the creation", async () => {
  const path = "Alone.md";
  await create(path, "# Alone\n");
  expect(await commitsAfter(path, 1, QUIET_MS + MARGIN_MS)).toBeGreaterThanOrEqual(0);
  expect(await committed(path)).toBe("# Alone\n");
});

const REMOTE = process.env.FIRST_EDIT_URL?.replace(/\/$/, "");

describe.skipIf(!REMOTE)("against FIRST_EDIT_URL", () => {
  test("typed right after creating: one commit with the text, quietMs after the last keystroke; then an Update", async () => {
    const B = REMOTE!;
    const quiet = Number(process.env.QUIET_MS ?? 3000);
    const margin = 2500;
    const cookie = process.env.FIRST_EDIT_COOKIE ?? "";
    expect(cookie).toContain("=");
    const H = { cookie, origin: B, "content-type": "application/json" };
    const ws = ((await (await fetch(`${B}/api/workspaces`, { method: "POST", headers: H, body: JSON.stringify({ title: "pw-first-edit" }) })).json()) as { id: string }).id;
    try {
      const path = "First.md";
      expect((await fetch(`${B}/api/workspace/${ws}/files`, { method: "POST", headers: H, body: JSON.stringify({ path, content: "" }) })).status).toBe(201);
      const a = room(B, { repo: ws, path }, { cookie, origin: B });
      clients.push(a);
      await a.opened;
      a.text.insert(0, "# Hello\nfirst edit\n");
      const hist = async () => (await (await fetch(`${B}/api/workspace/${ws}/history?path=${path}`, { headers: H })).json()) as Commit[];
      const at = async (sha: string) => ((await (await fetch(`${B}/api/workspace/${ws}/file?path=${path}&ref=${sha}`, { headers: H })).json()) as { content: string }).content;
      const wait = async (n: number) => {
        const t = performance.now();
        while (performance.now() - t < quiet + margin) {
          const h = await hist();
          if (Array.isArray(h) && h.length >= n) return h;
          await Bun.sleep(200);
        }
        throw new Error(`no commit ${n} within ${quiet + margin} ms`);
      };
      const first = await wait(1);
      expect(first.map((c) => c.message)).toEqual([`Create ${path}`]);
      expect(await at(first[0]!.sha)).toBe("# Hello\nfirst edit\n");
      a.text.insert(a.text.length, "second\n");
      const second = await wait(2);
      expect(second[0]!.message).toBe(`Update ${path}`);
      expect(await at(second[0]!.sha)).toBe("# Hello\nfirst edit\nsecond\n");
      a.close();
    } finally {
      await fetch(`${B}/api/workspace/${ws}`, { method: "DELETE", headers: H });
    }
  });
});

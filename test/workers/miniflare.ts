// Runs a Worker in Miniflare 5 (the workerd that wrangler dev uses) for tests: bundles `entry` with Bun.build,
// starts it with in-memory D1 / Durable Object SQLite (nothing is written under .wrangler), and applies
// migrations/*.sql to D1. Usage: const w = await startWorker({ entry, durableObjects: { NS: "ClassName" } });
// await w.fetch("/path"); await w.mf.unsafeEvictDurableObject(...); await w.dispose();
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

export interface StartedWorker {
  mf: Miniflare;
  name: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

export async function startWorker(opts: {
  entry: string;
  /** binding name → exported SQLite Durable Object class */
  durableObjects?: Record<string, string>;
  /** Bind D1 as `DB` and apply migrations/*.sql (default true). */
  d1?: boolean;
  /** Miniflare's HTTP port; 0 (default) picks a free one. MF_PORT overrides. */
  port?: number;
}): Promise<StartedWorker> {
  const name = "grim-test";
  const outdir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-mf-"));
  let mf: Miniflare | null = null;
  try {
    const built = await Bun.build({
      entrypoints: [opts.entry],
      outdir,
      target: "browser",
      format: "esm",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"],
    });
    if (!built.success) throw new AggregateError(built.logs, "bundling the test Worker failed");
    const d1 = opts.d1 ?? true;
    mf = new Miniflare(
      convertV4MiniflareOptions({
        port: Number(process.env.MF_PORT) || opts.port || 0,
        workers: [
          {
            name,
            modules: true,
            scriptPath: built.outputs[0].path,
            modulesRoot: outdir,
            compatibilityDate: compatibilityDate(),
            compatibilityFlags: ["nodejs_compat"],
            d1Databases: d1 ? ["DB"] : [],
            durableObjects: Object.fromEntries(Object.entries(opts.durableObjects ?? {}).map(([binding, className]) => [binding, { className, useSQLite: true }])),
          },
        ],
      }),
    );
    await mf.ready;
    if (d1) await applyMigrations(mf);
  } catch (e) {
    await mf?.dispose();
    rmSync(outdir, { recursive: true, force: true });
    throw e;
  }
  const started = mf;
  return {
    mf: started,
    name,
    fetch: (path, init) => started.dispatchFetch(new URL(path, "http://test.local").href, init as never) as unknown as Promise<Response>,
    async dispose() {
      await started.dispose();
      rmSync(outdir, { recursive: true, force: true });
    },
  };
}

/** migrations/*.sql in order, split into statements (no triggers there, so splitting on ";" is safe). */
export function migrationStatements(): string[] {
  const dir = join(ROOT, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean),
    );
}

async function applyMigrations(mf: Miniflare) {
  const db = await mf.getD1Database("DB");
  await db.batch(migrationStatements().map((s) => db.prepare(s)));
}

/** compatibility_date from wrangler.jsonc, so tests run with the same runtime behaviour as the deploy. */
function compatibilityDate(): string {
  const m = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8").match(/"compatibility_date"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error("no compatibility_date in wrangler.jsonc");
  return m[1];
}

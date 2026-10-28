// Bundles the Worker the way `wrangler deploy` would (without deploying) and fails if
// Bun-only or local-Git code leaked into it, if a Durable Object's RPC surface names a type that holds the Code
// Storage key (scripts/do-surface.ts), or if invocation logs are on in any environment. Usage: bun scripts/check-workers.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";
import { checkDoSurface, FORBIDDEN_TYPES } from "./do-surface.ts";

const root = join(import.meta.dir, "..");
const outdir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-workers-"));
// wrangler refuses to run without the assets directory; an empty one is enough here.
const dist = join(root, "dist");
const madeDist = !existsSync(dist);
if (madeDist) mkdirSync(dist);

const FORBIDDEN: [string, RegExp][] = [
  ["bun:*", /["']bun:[a-z]+["']/],
  ["node:child_process", /["'](node:)?child_process["']/],
  // an import of it, not any "fs" string (minified bundles keep names like __name(fs, "fs"))
  ["node:fs", /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](node:)?fs(\/promises)?["']/],
  ["store/localgit", /store\/localgit/],
  ["src/server/bun/", /src\/server\/bun\//],
];

let code = 0;
try {
  code = check() | checkSurface() | checkObservability();
} catch (e) {
  console.error("check-workers:", e);
  code = 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
  if (madeDist) {
    try {
      rmdirSync(dist);
    } catch {}
  }
}
process.exit(code);

function check(): number {
  const proc = Bun.spawnSync(["bunx", "wrangler", "deploy", "--dry-run", "--outdir", outdir], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  if (proc.exitCode !== 0) {
    process.stdout.write(proc.stdout);
    process.stderr.write(proc.stderr);
    console.error(`check-workers: wrangler deploy --dry-run failed (exit ${proc.exitCode})`);
    return 1;
  }

  const files = readdirSync(outdir, { recursive: true, encoding: "utf8" }).filter(
    (f) => statSync(join(outdir, f)).isFile() && /\.(m?js|cjs)$/.test(f),
  );
  if (files.length === 0) throw new Error(`no bundle written to ${outdir}`);

  let bytes = 0;
  const problems: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(outdir, f), "utf8");
    bytes += Buffer.byteLength(src);
    for (const [label, re] of FORBIDDEN) {
      const m = re.exec(src);
      if (!m) continue;
      const line = src.slice(0, m.index).split("\n").length;
      problems.push(`${f}:${line}: ${label} (${m[0]})`);
    }
  }
  const gzip = files.reduce((n, f) => n + Bun.gzipSync(readFileSync(join(outdir, f))).length, 0);
  console.log(`check-workers: bundle ${files.join(", ")}: ${kb(bytes)} (${kb(gzip)} gzip)`);
  if (problems.length) {
    console.error("check-workers: forbidden imports in the Worker bundle:\n  " + problems.join("\n  "));
    return 1;
  }
  console.log("check-workers: ok");
  return 0;
}

/** Public Durable Object methods (the RPC surface) never mention Repo, GitStorage or a store/room/runtime. */
function checkSurface(): number {
  const problems = checkDoSurface(root);
  if (problems.length) {
    console.error(
      `check-workers: Durable Object RPC surface names a type that can carry the Code Storage key (${FORBIDDEN_TYPES.join(", ")}); keep it #private and return plain data:\n  ` +
        problems.map((p) => `${p.file}: ${p.cls}.${p.member} (${p.type})`).join("\n  "),
    );
    return 1;
  }
  console.log("check-workers: Durable Object RPC surfaces ok");
  return 0;
}

/**
 * Invocation logs (request URLs, headers, the logs of every request) stay off in every environment: share-link URLs
 * are credentials. Also no Logpush or tail consumers, which would ship the same data elsewhere.
 */
function checkObservability(): number {
  const configPath = join(root, "wrangler.jsonc");
  const envs = Object.keys(experimental_readRawConfig({ config: configPath }).rawConfig.env ?? {});
  const problems: string[] = [];
  for (const env of [undefined, ...envs]) {
    const c = unstable_readConfig({ config: configPath, env });
    const where = env ? `env.${env}` : "top level";
    if (c.observability?.logs?.invocation_logs !== false) problems.push(`${where}: observability.logs.invocation_logs must be false`);
    if (c.logpush) problems.push(`${where}: logpush must be off`);
    if (c.tail_consumers?.length) problems.push(`${where}: no tail_consumers`);
  }
  if (problems.length) {
    console.error("check-workers: observability:\n  " + problems.join("\n  "));
    return 1;
  }
  console.log(`check-workers: invocation logs off (${["top level", ...envs.map((e) => `env.${e}`)].join(", ")})`);
  return 0;
}

function kb(n: number) {
  return `${(n / 1024).toFixed(1)} KiB`;
}

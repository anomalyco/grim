// Runs e2e scripts against the Workers build: builds the client once, then runs each script with TARGET=workers, so
// it starts its own `wrangler dev --local` (scripts/wrangler-dev.ts: fresh local D1 with the migrations applied, free
// ports, name sign-in on, in-memory Git store, the script's settings as Worker vars) and stops it at the end.
// Usage: bun scripts/e2e-workers.ts [suite ...]   (default: every suite below; `--bun` runs them on Bun instead)
// (bun run test:e2e:workers). Each wrangler dev takes a few seconds to start; the whole list takes ~10 minutes.
// Prints one line per suite (pass/fail, checks skipped) and exits non-zero if any failed.
import { resolve } from "node:path";

export const SUITES = [
  "two-users",
  "workspaces",
  "anon",
  "demo",
  "images",
  "links",
  "autoname",
  "blame",
  "tree-keys",
  "newnote-focus",
  "wide-blocks",
  "rust-collab",
  "shell",
  // runs the same scenario on both servers itself, whatever the target
  "parity",
];

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const bun = args.includes("--bun");
const names = args.filter((a) => !a.startsWith("--"));
const suites = names.length ? names : SUITES.filter((s) => !(bun && s === "parity"));
for (const s of suites) if (!(await Bun.file(`${root}/test/e2e/${s}.mjs`).exists())) throw new Error(`no test/e2e/${s}.mjs`);

const build = Bun.spawnSync(["bun", "run", "build:client"], { cwd: root, stdout: "ignore", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

const target = bun ? "bun" : "workers";
const results: { suite: string; code: number; ok: number; fail: number; skip: number; ms: number }[] = [];
for (const suite of suites) {
  console.log(`\n=== ${suite} (${target})`);
  const t = Date.now();
  const env: Record<string, string | undefined> = { ...process.env, TARGET: target };
  delete env.BASE_URL;
  const proc = Bun.spawn(["bun", `test/e2e/${suite}.mjs`], { cwd: root, env, stdout: "pipe", stderr: "inherit" });
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of proc.stdout) {
    const s = dec.decode(chunk, { stream: true });
    out += s;
    process.stdout.write(s);
  }
  const code = await proc.exited;
  const count = (re: RegExp) => out.split("\n").filter((l) => re.test(l)).length;
  results.push({ suite, code, ok: count(/^ok\b/), fail: count(/^FAIL\b/), skip: count(/^skip\b/), ms: Date.now() - t });
}

console.log(`\n${"suite".padEnd(16)}${"result".padEnd(8)}${"ok".padStart(5)}${"fail".padStart(6)}${"skip".padStart(6)}${"s".padStart(7)}`);
for (const r of results) {
  const result = r.code === 0 ? "pass" : "FAIL";
  console.log(`${r.suite.padEnd(16)}${result.padEnd(8)}${String(r.ok).padStart(5)}${String(r.fail).padStart(6)}${String(r.skip).padStart(6)}${(r.ms / 1000).toFixed(0).padStart(7)}`);
}
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);

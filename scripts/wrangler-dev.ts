// Starts the Workers build under `wrangler dev --local` for tests: a fresh local D1 (migrations applied) and DO
// state in a temp dir, on free ports, with name sign-in on and no Code Storage secrets (one in-memory Git store).
// Fire crons with GET <base>/cdn-cgi/handler/scheduled?cron=<cron>. Resolves once wrangler prints "Ready on <url>"; stop() ends it and waits for the process to exit.
// Run `bun run build:client` first (wrangler's build step only stages dist/).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface WranglerDev {
  base: string;
  stop(): Promise<void>;
  /** Everything wrangler printed so far (stdout + stderr). */
  output(): string;
}

const root = resolve(import.meta.dir, "..");

/** Vars every test run gets; `vars` override them. */
export const TEST_VARS: Record<string, string> = { ALLOW_DEV_LOGIN: "1", STORAGE: "memory" };

export async function startWrangler(opts: { vars?: Record<string, string>; port?: number; quiet?: boolean } = {}): Promise<WranglerDev> {
  const state = mkdtempSync(join(tmpdir(), "grim-wrangler-"));
  const migrate = Bun.spawnSync(["bunx", "wrangler", "d1", "migrations", "apply", "grim", "--local", "--persist-to", state], {
    cwd: root,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (migrate.exitCode !== 0) {
    rmSync(state, { recursive: true, force: true });
    throw new Error(`d1 migrations apply failed:\n${migrate.stdout.toString()}${migrate.stderr.toString()}`);
  }
  const vars = { ...TEST_VARS, ...opts.vars };
  const args = ["bunx", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(opts.port ?? 0), "--inspector-port", "0"];
  args.push("--persist-to", state, "--show-interactive-dev-session=false", "--log-level", "info");
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  const proc = Bun.spawn(args, {
    cwd: root,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  let resolveReady!: (url: string) => void;
  const ready = new Promise<string>((r) => (resolveReady = r));
  const pump = async (stream: ReadableStream<Uint8Array>, echo: boolean) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const s = dec.decode(chunk, { stream: true });
      out += s;
      if (echo && !opts.quiet) process.stderr.write(s.replace(/^/gm, "[wrangler] "));
      const m = /Ready on (http:\/\/[^\s]+)/.exec(out);
      if (m) resolveReady(m[1]!.replace(/\/$/, ""));
    }
  };
  const pumps = Promise.all([pump(proc.stdout, false), pump(proc.stderr, true)]);
  const exited = proc.exited.then((code) => {
    throw new Error(`wrangler dev exited (${code}) before it was ready:\n${out}`);
  });
  let base: string;
  try {
    base = await Promise.race([ready, exited]);
  } catch (e) {
    rmSync(state, { recursive: true, force: true });
    throw e;
  }
  exited.catch(() => {});
  return {
    base,
    output: () => out,
    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
      await pumps.catch(() => {});
      rmSync(state, { recursive: true, force: true });
    },
  };
}

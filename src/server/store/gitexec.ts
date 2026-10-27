// Running the git binary.

/**
 * Environment for anonymous network operations against GitHub: no global/system config, so the host's credential
 * helpers can't leak access to private repos, and no prompts.
 */
export const anonymousGitEnv: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
};

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  /** Largest file the command (and its children) may write, in bytes; writing more kills it with SIGXFSZ. */
  maxFileBytes?: number;
}

export async function git(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await run(args, opts, (s) => new Response(s).text());
  return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr };
}

/** Run git and return its stdout as bytes (for binary blobs). */
export async function gitBytes(args: string[], opts: RunOptions = {}): Promise<{ code: number; stdout: Uint8Array<ArrayBuffer>; stderr: string }> {
  const r = await run(args, opts, async (s) => new Uint8Array(await new Response(s).arrayBuffer()));
  return { code: r.code, stdout: r.stdout ?? new Uint8Array(), stderr: r.stderr };
}

async function run<T>(args: string[], opts: RunOptions, read: (s: ReadableStream<Uint8Array>) => Promise<T>): Promise<{ code: number; stdout?: T; stderr: string }> {
  // quotepath=false: print non-ASCII paths verbatim instead of quoted octal escapes.
  let cmd = ["git", "-c", "core.quotepath=false", ...args];
  // ulimit -f counts 512-byte blocks
  if (opts.maxFileBytes !== undefined) cmd = ["sh", "-c", 'ulimit -f "$0" && exec "$@"', String(Math.ceil(opts.maxFileBytes / 512)), ...cmd];
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : typeof opts.stdin === "string" ? new TextEncoder().encode(opts.stdin) : opts.stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([read(proc.stdout), new Response(proc.stderr).text(), proc.exited]);
  if (!opts.timeoutMs) {
    const [stdout, stderr, code] = await output;
    return { code, stdout, stderr };
  }
  let expired = false;
  const timedOut = (stderr: string) => ({ code: 124, stderr: `${stderr}\ntimed out after ${Math.round(opts.timeoutMs! / 1000)}s`.trim() });
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  // On timeout: SIGTERM, then SIGKILL, then stop waiting for the pipes (a helper process may still hold them open).
  const deadline = new Promise<{ code: number; stderr: string }>((resolve) => {
    timers.push(
      setTimeout(() => {
        expired = true;
        proc.kill("SIGTERM");
        timers.push(setTimeout(() => proc.kill("SIGKILL"), 2000));
        timers.push(setTimeout(() => resolve(timedOut("")), 3000));
      }, opts.timeoutMs),
    );
  });
  try {
    return await Promise.race([output.then(([stdout, stderr, code]) => (expired ? timedOut(stderr) : { code, stdout, stderr })), deadline]);
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}

export async function gitOk(args: string[], opts: Parameters<typeof git>[1] = {}): Promise<string> {
  const r = await git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Contents of blobs by id, read in one `cat-file --batch`. Missing objects are left out. */
export async function catBlobs(cwd: string, oids: string[], env: Record<string, string> = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!oids.length) return out;
  const proc = Bun.spawn(["git", "cat-file", "--batch"], { cwd, env: { ...process.env, ...env }, stdin: new TextEncoder().encode(oids.join("\n") + "\n"), stdout: "pipe", stderr: "ignore" });
  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  const dec = new TextDecoder();
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) break;
    // "<oid> <type> <size>" then the content and a newline, or "<oid> missing".
    const [oid, type, size] = dec.decode(buf.subarray(i, nl)).split(" ");
    i = nl + 1;
    if (type === "missing" || !size) continue;
    const n = Number(size);
    if (type === "blob") out.set(oid!, dec.decode(buf.subarray(i, i + n)));
    i += n + 1;
  }
  return out;
}

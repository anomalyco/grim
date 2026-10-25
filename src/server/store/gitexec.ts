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

export async function git(args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  // quotepath=false: print non-ASCII paths verbatim instead of quoted octal escapes.
  const proc = Bun.spawn(["git", "-c", "core.quotepath=false", ...args], {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs)
    : null;
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (timedOut) return { code: code || 124, stdout, stderr: `${stderr}\ntimed out after ${Math.round(opts.timeoutMs! / 1000)}s`.trim() };
    return { code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function gitOk(args: string[], opts: Parameters<typeof git>[1] = {}): Promise<string> {
  const r = await git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

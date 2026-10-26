// Local stand-ins for GitHub repos: bare repos under one root, served over file:// (GITHUB_GIT_BASE).
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export async function sh(args: string[], cwd: string, stdin?: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), env: { ...process.env, ...env } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out;
}

const who = { GIT_AUTHOR_NAME: "Up", GIT_AUTHOR_EMAIL: "up@example.com", GIT_COMMITTER_NAME: "Up", GIT_COMMITTER_EMAIL: "up@example.com" };

/** Make bare "GitHub" repos at <root>/upstream/<owner>/<name>.git; point config.github.gitBase at `base`. */
export function upstreams(root: string) {
  const upstreamRoot = join(root, "upstream");
  return {
    base: `file://${upstreamRoot}`,
    async make(owner: string, name: string, files: Record<string, string | Uint8Array>, branch = "main") {
      const work = join(root, `work-${owner}-${name}`);
      mkdirSync(work, { recursive: true });
      await sh(["init", "-q", "-b", branch], work);
      await commit(work, files, "Initial commit");
      const bare = join(upstreamRoot, owner, `${name}.git`);
      mkdirSync(join(upstreamRoot, owner), { recursive: true });
      await sh(["clone", "-q", "--bare", work, bare], root);
      // GitHub allows partial clones; a local upload-pack needs to be told.
      await sh(["config", "uploadpack.allowFilter", "true"], bare);
      await sh(["config", "uploadpack.allowAnySHA1InWant", "true"], bare);
      return {
        bare,
        async push(more: Record<string, string | Uint8Array>, msg: string) {
          await commit(work, more, msg);
          await sh(["push", "-q", bare, `HEAD:${branch}`], work);
        },
      };
    },
  };
}

async function commit(work: string, files: Record<string, string | Uint8Array>, msg: string) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(work, p, ".."), { recursive: true });
    await Bun.write(join(work, p), c);
  }
  await sh(["add", "-A"], work);
  await sh(["commit", "-q", "-m", msg], work, undefined, who);
}

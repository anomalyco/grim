// Talking to GitHub over Git (clone URLs, ls-remote) for public, read-only repos.
import { config } from "./config.ts";
import { anonymousGitEnv, git } from "./store/gitexec.ts";

export const githubGitUrl = (owner: string, name: string) => `${config.github.gitBase}/${owner}/${name}.git`;

/**
 * Anonymous `git ls-remote`: the default branch and which of `branches` exist. null if the repo can't be read
 * anonymously (missing or private) or GitHub can't be reached.
 */
export async function lsRemote(owner: string, name: string, branches: string[] = []): Promise<{ defaultBranch: string | null; branches: string[] } | null> {
  const patterns = branches.map((b) => `refs/heads/${b}`);
  const r = await git(["ls-remote", "--symref", githubGitUrl(owner, name), "HEAD", ...patterns], { env: anonymousGitEnv, timeoutMs: 20_000 });
  if (r.code !== 0) return null;
  let defaultBranch: string | null = null;
  const found = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (sym) defaultBranch = sym[1]!;
    const ref = /^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/.exec(line);
    if (ref) found.add(ref[1]!);
  }
  return { defaultBranch, branches: branches.filter((b) => found.has(b)) };
}

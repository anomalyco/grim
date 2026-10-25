// Finding repos on GitHub: the API, plus Git (clone URLs, ls-remote) for public repos.
import { GitHubRateLimitError, githubRepoInfo, type Access } from "./auth.ts";
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

export class GitHubLookupError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubLookup {
  /** As GitHub spells them. */
  owner: string;
  name: string;
  private: boolean;
  access: Access;
  defaultBranch: string | null;
  /** The branch meant: one of the candidates, else the default branch. */
  branch: string | undefined;
}

/**
 * Look a repo up on GitHub and work out which branch is meant. `candidates` are possible branch names (an explicit
 * one, or the splits of a /tree/ or /blob/ URL, longest first); empty means the default branch. With no `token` the
 * lookup is anonymous, and when the API is rate limited it falls back to `git ls-remote` (which only works for
 * public repos). null: the repo doesn't exist or isn't visible. Throws GitHubLookupError.
 */
export async function lookupGitHub(owner: string, name: string, opts: { token: string | null; candidates: string[] }): Promise<GitHubLookup | null> {
  const { token, candidates } = opts;
  let info;
  try {
    info = await githubRepoInfo(owner, name, token);
  } catch (e) {
    if (!(e instanceof GitHubRateLimitError)) throw new GitHubLookupError(502, `could not reach GitHub: ${(e as Error).message}`);
    if (token) throw new GitHubLookupError(429, `${e.message}. Try again later.`);
    const remote = await lsRemote(owner, name, candidates);
    if (!remote) throw new GitHubLookupError(429, `${e.message}, and ${owner}/${name} couldn't be checked another way. Try again later.`);
    return { owner, name, private: false, access: "read", defaultBranch: remote.defaultBranch, branch: pick(owner, name, candidates, remote.branches, remote.defaultBranch) };
  }
  if (!info) return null;
  const [o, n] = info.fullName?.split("/") ?? [owner, name];
  const found = { owner: o ?? owner, name: n ?? name, private: info.private, access: info.access, defaultBranch: info.defaultBranch };
  // A URL naming the default branch is unambiguous; anything else is checked against GitHub's branches.
  if (!candidates.length || (candidates.length === 1 && candidates[0] === info.defaultBranch)) return { ...found, branch: candidates[0] ?? info.defaultBranch ?? undefined };
  const remote = await lsRemote(found.owner, found.name, candidates);
  if (!remote) throw new GitHubLookupError(502, `could not reach GitHub to check the branch of ${found.owner}/${found.name}`);
  return { ...found, branch: pick(found.owner, found.name, candidates, remote.branches, info.defaultBranch) };
}

function pick(owner: string, name: string, candidates: string[], existing: string[], defaultBranch: string | null): string | undefined {
  if (!candidates.length) return defaultBranch ?? undefined;
  // Candidates are longest first, and `existing` keeps their order.
  if (!existing.length) throw new GitHubLookupError(404, `branch ${candidates[candidates.length - 1]} not found in ${owner}/${name}`);
  return existing[0];
}

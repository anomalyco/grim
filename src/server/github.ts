// Finding repos on GitHub: the API, plus Git (clone URLs, the smart-HTTP ref advertisement) for public repos.
import { GitHubRateLimitError, githubRepoInfo, type Access } from "./auth.ts";
import { config } from "./config.ts";

export const githubGitUrl = (owner: string, name: string) => `${config.github.gitBase}/${owner}/${name}.git`;

type RemoteRefs = { defaultBranch: string | null; branches: string[] };

/**
 * Anonymous ls-remote: the default branch and which of `branches` exist. null if the repo can't be read anonymously
 * (missing or private) or GitHub can't be reached. Over HTTP(S) it reads Git's smart-HTTP ref advertisement with
 * fetch (no git binary, so it also runs on Workers); file:// bases (tests) use the git CLI.
 */
export async function lsRemote(owner: string, name: string, branches: string[] = []): Promise<RemoteRefs | null> {
  const url = githubGitUrl(owner, name);
  if (url.startsWith("file://")) return lsRemoteCli(url, branches);
  try {
    const res = await fetch(`${url}/info/refs?service=git-upload-pack`, {
      headers: { "user-agent": "git/2.0 (grimoire)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return null;
    }
    const refs = await readRefAdvertisement(res.body);
    if (!refs) return null;
    return { defaultBranch: refs.head, branches: branches.filter((b) => refs.heads.has(b)) };
  } catch {
    return null;
  }
}

async function lsRemoteCli(url: string, branches: string[]): Promise<RemoteRefs | null> {
  // A computed specifier keeps the git binary wrapper out of the Workers bundle; only tests take this path.
  const gitexec = "./store/gitexec.ts";
  const { anonymousGitEnv, git } = (await import(gitexec)) as typeof import("./store/gitexec.ts");
  const patterns = branches.map((b) => `refs/heads/${b}`);
  const r = await git(["ls-remote", "--symref", url, "HEAD", ...patterns], { env: anonymousGitEnv, timeoutMs: 20_000 });
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

/**
 * Parse a protocol-v0 `info/refs?service=git-upload-pack` response (pkt-lines): the branch HEAD points at (from the
 * `symref=HEAD:refs/heads/…` capability) and every branch name. Refs come sorted, so reading stops (and the body is
 * cancelled) after the last refs/heads/ entry: big repos advertise megabytes of tags and pull refs after them.
 * null if the body isn't a complete ref advertisement.
 */
export async function readRefAdvertisement(body: ReadableStream<Uint8Array>): Promise<{ head: string | null; heads: Set<string> } | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = new Uint8Array(0);
  let line = 0;
  let head: string | null = null;
  const heads = new Set<string>();
  try {
    for (;;) {
      const pkt = await nextPkt();
      if (pkt === undefined) return null;
      line++;
      if (line === 1) {
        if (pkt === null || decoder.decode(pkt).replace(/\n$/, "") !== "# service=git-upload-pack") return null;
        continue;
      }
      if (pkt === null) {
        if (line === 2) continue;
        return { head, heads };
      }
      const text = decoder.decode(pkt).replace(/\n$/, "");
      const nul = text.indexOf("\0");
      const ref = (nul < 0 ? text : text.slice(0, nul)).split(" ")[1] ?? "";
      if (nul >= 0) {
        for (const cap of text.slice(nul + 1).split(" ")) {
          if (cap.startsWith("symref=HEAD:refs/heads/")) head = cap.slice("symref=HEAD:refs/heads/".length);
        }
      }
      if (ref.startsWith("refs/heads/")) heads.add(ref.slice("refs/heads/".length));
      else if (ref > "refs/heads/") return { head, heads };
    }
  } catch (e) {
    if (e instanceof PktError) return null;
    throw e;
  } finally {
    reader.cancel().catch(() => {});
  }

  /** The next pkt-line's payload; null for a flush (or delim) packet; undefined at the end of the body. */
  async function nextPkt(): Promise<Uint8Array | null | undefined> {
    if (!(await fill(4))) return undefined;
    const hex = decoder.decode(buf.subarray(0, 4));
    const len = /^[0-9a-f]{4}$/i.test(hex) ? parseInt(hex, 16) : -1;
    if (len < 0 || len === 3) throw new PktError();
    if (len <= 2) {
      buf = buf.subarray(4);
      return null;
    }
    if (!(await fill(len))) throw new PktError();
    const payload = buf.subarray(4, len);
    buf = buf.subarray(len);
    return payload;
  }

  async function fill(n: number): Promise<boolean> {
    while (buf.length < n) {
      const { done, value } = await reader.read();
      if (done) return false;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
    return true;
  }
}

class PktError extends Error {
  override name = "PktError";
}

export class GitHubLookupError extends Error {
  override name = "GitHubLookupError";
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

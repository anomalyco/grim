// Parsing GitHub repo references ("owner/name", github.com URLs, SSH remotes). Shared by the server and the app.

export interface GitHubRef {
  owner: string;
  name: string;
  /** "tree" or "blob" when the URL points inside the repo. */
  kind: "tree" | "blob" | null;
  /** Segments after /tree/ or /blob/: the branch, then a path. Ambiguous when the branch name has slashes. */
  rest: string[];
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Parse "owner/name", "https://github.com/owner/name(.git)(/tree|blob/<branch>/<path>)", "git@github.com:owner/name.git", … or null. */
export function parseGitHubRepo(input: string): GitHubRef | null {
  let s = input.trim();
  if (!s || s.length > 2000 || /[\x00-\x1f\x7f\s]/.test(s)) return null;
  const scp = /^git@github\.com:(.*)$/i.exec(s);
  if (scp) s = scp[1]!;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (!/^(https?|ssh|git):$/.test(u.protocol) || !/^(www\.)?github\.com$/i.test(u.hostname)) return null;
    s = u.pathname;
  } else {
    s = s.replace(/^(www\.)?github\.com\//i, "");
    s = s.split(/[?#]/)[0]!;
  }
  let parts: string[];
  try {
    parts = s.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  const kind = parts[2] === "tree" || parts[2] === "blob" ? parts[2] : null;
  // Other pages (issues, pulls, …) still name the repo; only tree/blob carry a branch.
  return { owner, name, kind, rest: kind ? parts.slice(3) : [] };
}

/** Every way to split `rest` into a branch and a path, longest branch first. */
export function branchCandidates(rest: string[]): Array<{ branch: string; path: string }> {
  const out: Array<{ branch: string; path: string }> = [];
  for (let i = rest.length; i >= 1; i--) {
    const branch = rest.slice(0, i).join("/");
    if (validBranch(branch)) out.push({ branch, path: rest.slice(i).join("/") });
  }
  return out;
}

/** A conservative subset of git's branch name rules (no options, no control characters, no ref syntax). */
export function validBranch(b: string): boolean {
  if (!b || b.length > 200) return false;
  if (!/^[A-Za-z0-9._\/+@-]+$/.test(b)) return false;
  if (b.startsWith("-") || b.startsWith("/") || b.startsWith(".") || b.endsWith("/") || b.endsWith(".") || b.endsWith(".lock")) return false;
  if (b.includes("..") || b.includes("//") || b.includes("@{") || b === "@" || b.includes("/.")) return false;
  return true;
}

export const githubFileUrl = (owner: string, name: string, branch: string, path: string) =>
  `https://github.com/${owner}/${name}/blob/${branch.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;

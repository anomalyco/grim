import type { Db } from "./seams/db.ts";
import { forgetWorkspace, recordJoin } from "./workspaces.ts";
import type { Participant } from "./room.ts";
import type { WorkspaceHost } from "./seams/workspace-host.ts";

export const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p);

/** A workspace's row (`repos`). kind, gh_*, branch and head are leftovers of the Git era: always notes/null/main. */
export interface RepoRow {
  id: string;
  title: string;
  kind: "notes";
  read_only: number;
  status: "ready" | "importing" | "error";
  error: string | null;
  created_by: string | null;
  created_at: number;
  /** Whoever made it: the only one who may remove it. */
  owner_id: string | null;
}

export function getRepo(db: Db, id: string): Promise<RepoRow | null> {
  return db.get<RepoRow>("SELECT * FROM repos WHERE id = ?", id);
}

export function listRepoRows(db: Db): Promise<RepoRow[]> {
  return db.all<RepoRow>("SELECT * FROM repos ORDER BY kind DESC, title");
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Letters and digits that can't be mistaken for one another (no i, l, o, 0, 1). */
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** Random characters per new id: 31^12 ≈ 2^59, so an id can't be guessed (on hosted servers it's what keeps a workspace to whoever has its link). */
export const ID_SUFFIX_CHARS = 12;
/** The readable title part of a new id, at most this long. */
const ID_SLUG_CHARS = 24;

/** `n` characters of ID_ALPHABET, uniformly random (bytes ≥ 248 = 8 × 31 are drawn again, so there's no modulo bias). */
export function randomIdChars(n: number): string {
  let out = "";
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b >= 248) continue;
      out += ID_ALPHABET[b % ID_ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

/**
 * A new notes workspace's id, e.g. "Design" → "design-k7f3m2q9xbtw": a short readable slug of the title, then
 * ID_SUFFIX_CHARS random characters, so addresses can't be guessed and don't reveal how many same-named workspaces
 * exist. The id is permanent; renaming the workspace doesn't change it. (Older workspaces keep their shorter ids.)
 */
export function notesRepoId(title: string): string {
  const slug = slugify(title).slice(0, ID_SLUG_CHARS).replace(/^[-.]+|[-.]+$/g, "") || "notes";
  return `${slug}-${randomIdChars(ID_SUFFIX_CHARS)}`;
}

export class RepoService {
  constructor(
    /** The global tables (repos, joined, …). */
    readonly db: Db,
    /** Each workspace's runtime: in-process on Bun, Durable Objects on Workers. */
    readonly host: WorkspaceHost,
  ) {}

  get(id: string): Promise<RepoRow | null> {
    return getRepo(this.db, id);
  }

  list(): Promise<RepoRow[]> {
    return listRepoRows(this.db);
  }

  /** A new notes workspace owned (and joined) by `userId`, with `readme` as its README.md (default `# <title>`). */
  async createNotesRepo(title: string, userId: string, readme = `# ${title}\n`) {
    // (ids always end in a random suffix, so they're never a reserved one like "demo")
    // Claim the id with the insert itself, so concurrent creates can't pick the same one.
    let id: string;
    do id = notesRepoId(title);
    while (
      !(
        await this.db.run(
          "INSERT INTO repos (id, title, kind, branch, status, created_by, created_at, owner_id) VALUES (?, ?, 'notes', 'main', 'importing', ?, ?, ?) ON CONFLICT (id) DO NOTHING",
          id,
          title,
          userId,
          Date.now(),
          userId,
        )
      ).changes
    );
    await recordJoin(this.db, userId, id);
    return this.finishNotesRepo(id, readme);
  }

  /**
   * A notes workspace whose making was cut off (its row still "importing"), finished: `readme` written if it has no
   * notes yet, then ready.
   */
  async finishNotesRepo(id: string, readme: string): Promise<RepoRow> {
    const row = (await this.get(id))!;
    const ws = this.host.get(id);
    if (!(await ws.tree({ ...row, status: "ready" })).length) await ws.createFile({ ...row, status: "ready" }, "README.md", readme, GRIM);
    await this.db.run("UPDATE repos SET status = 'ready' WHERE id = ? AND status = 'importing'", id);
    return (await this.get(id))!;
  }

  async removeRepo(id: string) {
    await this.host.get(id).remove();
    await this.db.run("DELETE FROM repos WHERE id = ?", id);
    forgetWorkspace(id);
    this.host.forget?.(id);
  }

  /** The workspace's notes. */
  tree(repo: RepoRow): Promise<string[]> {
    return this.host.get(repo.id).tree(repo);
  }
}

/** The server's own edits (a new workspace's README). */
export const GRIM: Participant = { id: "grim", name: "Grim", email: "grim@grimnotes.app", kind: "agent", color: "#888888" };

/** Normalize a user-supplied file path inside a repo. */
export function cleanPath(p: string): string | null {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  if (!parts.length || parts.some((s) => s === ".." || s.toLowerCase().startsWith(".git"))) return null;
  let out = parts.join("/");
  if (!isMarkdown(out)) out += ".md";
  return out;
}

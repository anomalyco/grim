import { config } from "./config.ts";
import { db } from "./db.ts";
import { emit, notifyChange } from "./events.ts";
import type { RoomManager } from "./rooms.ts";
import { isMarkdown, RepoBusyError, type GitStore } from "./store/types.ts";

export interface RepoRow {
  id: string;
  title: string;
  kind: "notes" | "github";
  gh_owner: string | null;
  gh_name: string | null;
  read_only: number;
  branch: string;
  status: "ready" | "importing" | "error";
  error: string | null;
  created_by: string | null;
  created_at: number;
}

export function getRepo(id: string): RepoRow | null {
  return db.query("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | null;
}

export function listRepoRows(): RepoRow[] {
  return db.query("SELECT * FROM repos ORDER BY kind DESC, title").all() as RepoRow[];
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const WELCOME = `# Welcome to Notepad

This is a shared notepad. Everything here is stored in Git, and everyone who has it open sees edits and cursors live.

- Edits are committed automatically after 15 seconds of quiet (or press **Cmd-S**).
- Use **History** to see every version of a note.
- Agents can read and write notes through the MCP endpoint.
`;

export class RepoService {
  private trees = new Map<string, { head: string | null; files: string[] }>();
  /** Branch tip last seen by onPush, per repo. */
  private heads = new Map<string, string | null>();

  constructor(
    private store: GitStore,
    private rooms: RoomManager,
  ) {}

  /** Make sure the default notes repo exists. */
  async ensureNotesRepo() {
    const id = config.notesRepo;
    if (getRepo(id)) return;
    await this.store.createRepo(id, { branch: config.defaultBranch });
    db.query("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES (?, ?, 'notes', ?, 'ready', ?)").run(id, "Notes", config.defaultBranch, Date.now());
    const head = await this.store.head(id, config.defaultBranch);
    if (!head) {
      await this.store.commit({
        repo: id,
        branch: config.defaultBranch,
        expectedHead: null,
        changes: [{ path: "Welcome.md", content: WELCOME }],
        message: "Create Welcome.md",
        author: { name: "Notepad", email: "notepad@users.noreply.code.storage" },
      });
    }
  }

  /** A new notes repo hosted only in Code Storage. */
  async createNotesRepo(title: string, userId: string) {
    const base = slugify(title) || "notes";
    let id = base;
    for (let i = 2; getRepo(id); i++) id = `${base}-${i}`;
    // Claim the id before awaiting anything, so concurrent creates can't pick the same one.
    db.query("INSERT INTO repos (id, title, kind, branch, status, created_by, created_at) VALUES (?, ?, 'notes', ?, 'importing', ?, ?)").run(id, title, config.defaultBranch, userId, Date.now());
    try {
      await this.store.createRepo(id, { branch: config.defaultBranch });
      await this.store.commit({
        repo: id,
        branch: config.defaultBranch,
        expectedHead: await this.store.head(id, config.defaultBranch),
        changes: [{ path: "README.md", content: `# ${title}\n` }],
        message: "Create README.md",
        author: { name: "Notepad", email: "notepad@users.noreply.code.storage" },
      });
    } catch (e) {
      db.query("DELETE FROM repos WHERE id = ?").run(id);
      throw e;
    }
    db.query("UPDATE repos SET status = 'ready' WHERE id = ?").run(id);
    emit({ type: "repos" });
    return getRepo(id)!;
  }

  /** Link a GitHub repo. Imports in the background; the repo shows as "importing" until the first sync is done. */
  async linkGitHub(owner: string, name: string, opts: { branch?: string; publicReadOnly?: boolean; userId: string }) {
    const id = slugify(`gh-${owner}-${name}`);
    const existing = getRepo(id);
    if (existing) return existing;
    // Insert before awaiting anything, so concurrent links of the same repo can't both insert.
    db.query(
      "INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_by, created_at) VALUES (?, ?, 'github', ?, ?, ?, ?, 'importing', ?, ?)",
    ).run(id, `${owner}/${name}`, owner, name, opts.publicReadOnly ? 1 : 0, opts.branch || "main", opts.userId, Date.now());
    emit({ type: "repos" });
    void (async () => {
      try {
        let branch = opts.branch;
        if (!branch) {
          branch = (await githubDefaultBranch(owner, name)) || "main";
          db.query("UPDATE repos SET branch = ? WHERE id = ?").run(branch, id);
        }
        await this.store.createRepo(id, { branch, github: { owner, name, branch, publicReadOnly: opts.publicReadOnly } });
        for (let i = 0; i < 200; i++) {
          try {
            const head = await this.store.head(id, branch);
            if (head) break;
          } catch (e) {
            if (!(e instanceof RepoBusyError)) throw e;
          }
          await Bun.sleep(3000);
        }
        db.query("UPDATE repos SET status = 'ready', error = NULL WHERE id = ?").run(id);
      } catch (e) {
        db.query("UPDATE repos SET status = 'error', error = ? WHERE id = ?").run(String((e as Error).message ?? e), id);
      }
      emit({ type: "repos" });
    })();
    return getRepo(id)!;
  }

  async removeRepo(id: string) {
    for (const room of this.rooms.inRepo(id)) {
      if (room.dirty) await room.flush().catch(() => {});
      room.closeWith("removed");
    }
    await this.store.deleteRepo(id).catch((e) => console.error(`[repos] delete ${id}:`, e));
    db.query("DELETE FROM repos WHERE id = ?").run(id);
    this.trees.delete(id);
    emit({ type: "repos" });
  }

  /** Markdown files at the branch tip. */
  async tree(repo: RepoRow): Promise<string[]> {
    const head = await this.store.head(repo.id, repo.branch);
    const cached = this.trees.get(repo.id);
    if (cached && cached.head === head) return cached.files;
    const files = head ? (await this.store.listFiles(repo.id, head)).filter(isMarkdown).sort() : [];
    this.trees.set(repo.id, { head, files });
    return files;
  }

  /** Called on webhook pushes and by the poller. */
  async onPush(repoId: string) {
    const repo = getRepo(repoId);
    if (!repo || repo.status !== "ready") return;
    let head: string | null;
    try {
      head = await this.store.head(repo.id, repo.branch);
    } catch {
      return;
    }
    if (this.heads.get(repo.id) === head) return;
    this.trees.delete(repo.id);
    // Merge into open rooms first, so anyone woken by the notification reads the new text.
    // Our own commits move the head too; rooms that already have it treat this as a no-op.
    const results = await Promise.allSettled(this.rooms.inRepo(repo.id).map((r) => r.checkRemote()));
    // Only remember the head once every room has it, so a failed merge is retried on the next poll.
    if (results.every((r) => r.status === "fulfilled")) this.heads.set(repo.id, head);
    emit({ type: "tree", repo: repo.id });
    notifyChange(repo.id);
  }

  /** Poll every repo for outside pushes. Returns a function that stops polling. */
  startPolling(): () => void {
    const timer = setInterval(() => {
      for (const r of listRepoRows()) if (r.status === "ready") void this.onPush(r.id);
    }, config.pollMs);
    return () => clearInterval(timer);
  }
}

async function githubDefaultBranch(owner: string, name: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { headers: { accept: "application/vnd.github+json", "user-agent": "notepad" } }).catch(() => null);
  if (!res?.ok) return null;
  return ((await res.json()) as { default_branch?: string }).default_branch ?? null;
}

/** Normalize a user-supplied file path inside a repo. */
export function cleanPath(p: string): string | null {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  if (!parts.length || parts.some((s) => s === ".." || s.toLowerCase().startsWith(".git"))) return null;
  let out = parts.join("/");
  if (!isMarkdown(out)) out += ".md";
  return out;
}

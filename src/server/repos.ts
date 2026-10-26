import { githubRepoInfo } from "./auth.ts";
import { canEditGitHub, config } from "./config.ts";
import { db } from "./db.ts";
import { emit, notifyChange } from "./events.ts";
import type { RoomManager } from "./rooms.ts";
import { isMarkdown, RepoBusyError, type GitStore } from "./store/types.ts";

/** GitHub imports running at the same time. */
const MAX_IMPORTS = 2;

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

const WELCOME = `# Welcome to Grimoire

This is a shared notebook. Everything here is stored in Git, and everyone who has it open sees edits and cursors live.

- Notes save themselves: every change is committed to Git a few seconds after you stop typing.
- Use **History** to see every version of a note.
- Agents can read and write notes too: choose **Share with agent…** in a notebook's menu and paste the prompt to your agent.
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
  /**
   * GitHub links that can't push (no Code Storage + GitHub App) must be read-only; older versions allowed editable
   * ones, whose edits only landed in the local copy. The next upstream refresh resets such a copy to GitHub's state.
   */
  enforceGitHubReadOnly() {
    if (canEditGitHub()) return;
    const n = db.query("UPDATE repos SET read_only = 1 WHERE kind = 'github' AND read_only = 0").run().changes;
    if (n) console.log(`[repos] ${n} GitHub repo(s) switched to read-only: editing needs Code Storage and the GitHub App`);
  }

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
        author: { name: "Grimoire", email: "grimoire@users.noreply.code.storage" },
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
        author: { name: "Grimoire", email: "grimoire@users.noreply.code.storage" },
      });
    } catch (e) {
      db.query("DELETE FROM repos WHERE id = ?").run(id);
      throw e;
    }
    db.query("UPDATE repos SET status = 'ready' WHERE id = ?").run(id);
    emit({ type: "repos" });
    return getRepo(id)!;
  }

  /** A linked copy of owner/name (GitHub names are case-insensitive), read-only or editable, on `branch` if given. */
  findGitHub(owner: string, name: string, opts: { readOnly: boolean; branch?: string }): RepoRow | null {
    const rows = db
      .query("SELECT * FROM repos WHERE kind = 'github' AND lower(gh_owner) = lower(?) AND lower(gh_name) = lower(?) AND read_only = ? ORDER BY created_at")
      .all(owner, name, opts.readOnly ? 1 : 0) as RepoRow[];
    return rows.find((r) => !opts.branch || r.branch === opts.branch) ?? null;
  }

  /** Read-only GitHub copies in total, and those added by `userId`. */
  readOnlyCopies(userId: string): { total: number; mine: number } {
    const r = db.query("SELECT COUNT(*) AS total, COALESCE(SUM(created_by = ?), 0) AS mine FROM repos WHERE kind = 'github' AND read_only = 1").get(userId) as { total: number; mine: number };
    return { total: r.total, mine: r.mine };
  }

  /** Link a GitHub repo. Imports in the background; the repo shows as "importing" until the first sync is done. */
  async linkGitHub(owner: string, name: string, opts: { branch?: string; publicReadOnly?: boolean; userId: string; defaultBranch?: string }) {
    const readOnly = !!opts.publicReadOnly;
    const existing = this.findGitHub(owner, name, { readOnly, branch: opts.branch });
    if (existing) return { repo: existing, created: false };
    // One id per repo; another branch, or a read-only copy next to an editable link, gets a suffix.
    let base = slugify(`gh-${owner}-${name}`);
    if (opts.branch && opts.defaultBranch && opts.branch !== opts.defaultBranch) base = slugify(`${base}-${opts.branch}`);
    let id = base;
    for (let i = 2; getRepo(id); i++) id = `${base}-${i}`;
    // Insert before awaiting anything, so concurrent links of the same repo can't both insert.
    db.query(
      "INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_by, created_at) VALUES (?, ?, 'github', ?, ?, ?, ?, 'importing', ?, ?)",
    ).run(id, `${owner}/${name}${opts.branch && opts.defaultBranch && opts.branch !== opts.defaultBranch ? ` (${opts.branch})` : ""}`, owner, name, readOnly ? 1 : 0, opts.branch || "main", opts.userId, Date.now());
    emit({ type: "repos" });
    void this.importGitHub(id, owner, name, opts.branch, readOnly);
    return { repo: getRepo(id)!, created: true };
  }

  private importing = 0;
  private importQueue: Array<() => void> = [];

  /** Imports run at most MAX_IMPORTS at a time; the rest wait their turn (still showing "importing"). */
  private async importSlot(): Promise<() => void> {
    if (this.importing >= MAX_IMPORTS) await new Promise<void>((resolve) => this.importQueue.push(resolve));
    else this.importing++;
    return () => {
      const next = this.importQueue.shift();
      if (next) next();
      else this.importing--;
    };
  }

  private async importGitHub(id: string, owner: string, name: string, branch: string | undefined, readOnly: boolean) {
    const release = await this.importSlot();
    try {
      await this.importNow(id, owner, name, branch, readOnly);
    } finally {
      release();
    }
  }

  private async importNow(id: string, owner: string, name: string, branch: string | undefined, readOnly: boolean) {
    // Removed while waiting for a slot.
    if (!getRepo(id)) return;
    try {
      if (!branch) {
        branch = (await githubDefaultBranch(owner, name)) || "main";
        db.query("UPDATE repos SET branch = ? WHERE id = ?").run(branch, id);
      }
      await this.store.createRepo(id, { branch, github: { owner, name, branch, publicReadOnly: readOnly } });
      // Removed while it was being copied: don't leave the copy behind.
      if (!getRepo(id)) {
        await this.store.deleteRepo(id).catch(() => {});
        return;
      }
      let head: string | null = null;
      // Code Storage imports in the background; a local clone is complete when createRepo returns.
      for (let i = 0; i < (this.store.kind === "local" ? 1 : 200); i++) {
        try {
          head = await this.store.head(id, branch);
          if (head) break;
        } catch (e) {
          if (!(e instanceof RepoBusyError)) throw e;
        }
        await Bun.sleep(3000);
      }
      if (!head) throw new Error(`${owner}/${name} has no commits on ${branch}`);
      if (!(await this.store.listFiles(id, head)).some(isMarkdown)) throw new Error(`No Markdown files in ${owner}/${name} on ${branch}`);
      if (!getRepo(id)) {
        await this.store.deleteRepo(id).catch(() => {});
        return;
      }
      db.query("UPDATE repos SET status = 'ready', error = NULL WHERE id = ?").run(id);
      this.heads.set(id, head);
    } catch (e) {
      console.error(`[repos] import ${id}:`, (e as Error).message ?? e);
      db.query("UPDATE repos SET status = 'error', error = ? WHERE id = ?").run(importError(e, owner, name, branch), id);
      // Don't keep a useless read-only copy (or one whose repo was removed meanwhile).
      if (readOnly || !getRepo(id)) await this.store.deleteRepo(id).catch(() => {});
    }
    emit({ type: "repos" });
  }

  /** Re-import a GitHub repo whose import failed, on behalf of `userId` (who then counts as having added it). */
  async retryImport(repo: RepoRow, userId: string) {
    if (repo.kind !== "github" || repo.status !== "error") return repo;
    // Claim the retry before awaiting, so concurrent retries start one import.
    db.query("UPDATE repos SET status = 'importing', error = NULL, created_by = ? WHERE id = ?").run(userId, repo.id);
    await this.store.deleteRepo(repo.id).catch(() => {});
    emit({ type: "repos" });
    void this.importGitHub(repo.id, repo.gh_owner!, repo.gh_name!, repo.branch, !!repo.read_only);
    return getRepo(repo.id)!;
  }

  private refreshing = new Map<string, Promise<void>>();
  private lastRefresh = new Map<string, number>();

  /**
   * Pull GitHub's latest commits into a read-only GitHub repo, then pick them up like any outside push. Other repos
   * only re-check their head. Concurrent calls share one refresh; `minIntervalMs` skips refreshes that just ran.
   */
  refresh(repo: RepoRow, minIntervalMs = 0): Promise<void> {
    let p = this.refreshing.get(repo.id);
    if (p) return p;
    p = (async () => {
      const upstream = repo.kind === "github" && !!repo.read_only && repo.status === "ready" && !!this.store.pullUpstream;
      if (upstream && Date.now() - (this.lastRefresh.get(repo.id) ?? 0) >= minIntervalMs) {
        // Counted from the attempt, so failures are rate limited too.
        this.lastRefresh.set(repo.id, Date.now());
        await this.store.pullUpstream!(repo.id, repo.branch);
      }
      await this.onPush(repo.id);
    })().finally(() => this.refreshing.delete(repo.id));
    this.refreshing.set(repo.id, p);
    return p;
  }

  async removeRepo(id: string) {
    for (const room of this.rooms.inRepo(id)) {
      if (room.dirty) await room.flush().catch(() => {});
      room.closeWith("removed");
    }
    await this.store.deleteRepo(id).catch((e) => console.error(`[repos] delete ${id}:`, e));
    db.query("DELETE FROM repos WHERE id = ?").run(id);
    this.trees.delete(id);
    this.heads.delete(id);
    this.lastRefresh.delete(id);
    emit({ type: "repos" });
  }

  /** Markdown files at the branch tip, plus open notes that aren't committed yet. */
  async tree(repo: RepoRow): Promise<string[]> {
    const head = await this.store.head(repo.id, repo.branch);
    let committed = this.trees.get(repo.id)?.head === head ? this.trees.get(repo.id)!.files : null;
    if (!committed) {
      committed = head ? (await this.store.listFiles(repo.id, head)).filter(isMarkdown).sort() : [];
      this.trees.set(repo.id, { head, files: committed });
    }
    const pending = this.rooms.inRepo(repo.id).filter((r) => !r.inBase).map((r) => r.path);
    return pending.length ? [...new Set([...committed, ...pending])].sort() : committed;
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

  /** Poll every repo for outside pushes, and refresh read-only GitHub repos from GitHub. Returns a function that stops polling. */
  startPolling(): () => void {
    const timer = setInterval(() => {
      for (const r of listRepoRows()) if (r.status === "ready") void this.onPush(r.id);
    }, config.pollMs);
    const failed = new Set<string>();
    let running = false;
    const upstream = setInterval(async () => {
      if (running) return;
      running = true;
      // One at a time, so a burst of repos doesn't hammer GitHub.
      for (const r of listRepoRows()) {
        if (r.kind !== "github" || !r.read_only || r.status !== "ready") continue;
        try {
          await this.refresh(r, config.upstreamRefreshMs / 2);
          failed.delete(r.id);
        } catch (e) {
          if (!failed.has(r.id)) console.error(`[repos] refresh ${r.id} from GitHub:`, (e as Error).message ?? e);
          failed.add(r.id);
        }
      }
      running = false;
    }, config.upstreamRefreshMs);
    return () => {
      clearInterval(timer);
      clearInterval(upstream);
    };
  }
}

async function githubDefaultBranch(owner: string, name: string): Promise<string | null> {
  return (await githubRepoInfo(owner, name, null).catch(() => null))?.defaultBranch ?? null;
}

function importError(e: unknown, owner: string, name: string, branch: string | undefined): string {
  const msg = String((e as Error).message ?? e);
  if (/Remote branch .* not found|couldn't find remote ref/i.test(msg)) return `Branch ${branch} not found in ${owner}/${name}`;
  if (/Repository not found|could not read Username|Authentication failed|terminal prompts disabled/i.test(msg)) return `${owner}/${name} wasn't found on GitHub, or it's private`;
  if (/timed out/i.test(msg)) return `Copying ${owner}/${name} from GitHub took too long`;
  return msg.replace(/^git \w+ failed: /, "").split("\n")[0]!.slice(0, 300);
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

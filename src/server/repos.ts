import { githubRepoInfo } from "./auth.ts";
import { canEditGitHub, config } from "./config.ts";
import { emit, notifyChange } from "./events.ts";
import type { Db } from "./seams/db.ts";
import { forgetWorkspace, recordJoin } from "./workspaces.ts";
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
  /** Whoever made it (or added the GitHub copy): the only one who may remove it. */
  owner_id: string | null;
}

export function getRepo(db: Db, id: string): Promise<RepoRow | null> {
  return db.get<RepoRow>("SELECT * FROM repos WHERE id = ?", id);
}

export function listRepoRows(db: Db): Promise<RepoRow[]> {
  return db.all<RepoRow>("SELECT * FROM repos ORDER BY kind DESC, title");
}

/**
 * The store as RepoService uses it: a CachedHeadStore (index.ts) also takes `{ fresh: true }` (pollers) and
 * `invalidate(repo)` (webhooks); any other GitStore ignores both.
 */
type HeadCachingStore = GitStore & {
  head(repo: string, branch: string, opts?: { fresh?: boolean }): Promise<string | null>;
  invalidate?(repo: string): void;
};

export function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Letters and digits that can't be mistaken for one another (no i, l, o, 0, 1). */
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * A new notes workspace's id, e.g. "Design" → "design-k7f3": a random suffix, so addresses can't be guessed and don't
 * reveal how many same-named workspaces exist. The id is permanent; renaming the workspace doesn't change it.
 */
export function notesRepoId(title: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let suffix = "";
  // 256 % 31 ≠ 0, so the first characters are very slightly likelier; fine for 4 characters of unguessability.
  for (const b of bytes) suffix += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${slugify(title).slice(0, 75).replace(/^[-.]+|[-.]+$/g, "") || "notes"}-${suffix}`;
}

const WELCOME = `# Welcome to Grimoire

This is a shared notebook. Everything here is stored in Git, and everyone who has it open sees edits and cursors live.

- Notes save themselves: every change is committed to Git a few seconds after you stop typing.
- Use **History** to see every version of a note.
- Agents can read and write notes too: click **Copy** next to **Share with an agent** at the bottom of the sidebar and paste the prompt to your agent.
`;

export class RepoService {
  private trees = new Map<string, { head: string | null; files: string[] }>();
  /** Branch tip last seen by onPush, per repo. */
  private heads = new Map<string, string | null>();

  constructor(
    private store: HeadCachingStore,
    private rooms: RoomManager,
    /** The global tables (repos, joined, …). */
    readonly db: Db,
  ) {}

  get(id: string): Promise<RepoRow | null> {
    return getRepo(this.db, id);
  }

  list(): Promise<RepoRow[]> {
    return listRepoRows(this.db);
  }

  /**
   * GitHub links that can't push (no Code Storage + GitHub App) must be read-only; older versions allowed editable
   * ones, whose edits only landed in the local copy. The next upstream refresh resets such a copy to GitHub's state.
   */
  async enforceGitHubReadOnly() {
    if (canEditGitHub()) return;
    const n = (await this.db.run("UPDATE repos SET read_only = 1 WHERE kind = 'github' AND read_only = 0")).changes;
    if (n) console.log(`[repos] ${n} GitHub repo(s) switched to read-only: editing needs Code Storage and the GitHub App`);
  }

  /** Make sure the default notes repo exists. */
  async ensureNotesRepo() {
    const id = config.notesRepo;
    if (await this.get(id)) return;
    await this.store.createRepo(id, { branch: config.defaultBranch });
    // Nobody owns the default notebook.
    await this.db.run("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES (?, ?, 'notes', ?, 'ready', ?) ON CONFLICT (id) DO NOTHING", id, "Notes", config.defaultBranch, Date.now());
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
    // (ids always end in a random suffix, so they're never a reserved one like "demo")
    // Claim the id with the insert itself, so concurrent creates can't pick the same one.
    let id: string;
    do id = notesRepoId(title);
    while (
      !(
        await this.db.run(
          "INSERT INTO repos (id, title, kind, branch, status, created_by, created_at, owner_id) VALUES (?, ?, 'notes', ?, 'importing', ?, ?, ?) ON CONFLICT (id) DO NOTHING",
          id,
          title,
          config.defaultBranch,
          userId,
          Date.now(),
          userId,
        )
      ).changes
    );
    await recordJoin(this.db, userId, id);
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
      await this.db.run("DELETE FROM repos WHERE id = ?", id);
      forgetWorkspace(id);
      throw e;
    }
    await this.db.run("UPDATE repos SET status = 'ready' WHERE id = ?", id);
    emit({ type: "repos" });
    return (await this.get(id))!;
  }

  /** A linked copy of owner/name (GitHub names are case-insensitive), read-only or editable, on `branch` if given. */
  async findGitHub(owner: string, name: string, opts: { readOnly: boolean; branch?: string }): Promise<RepoRow | null> {
    const rows = await this.db.all<RepoRow>(
      "SELECT * FROM repos WHERE kind = 'github' AND lower(gh_owner) = lower(?) AND lower(gh_name) = lower(?) AND read_only = ? ORDER BY created_at",
      owner,
      name,
      opts.readOnly ? 1 : 0,
    );
    return rows.find((r) => !opts.branch || r.branch === opts.branch) ?? null;
  }

  /** Read-only GitHub copies in total, and those added by `userId`. */
  async readOnlyCopies(userId: string): Promise<{ total: number; mine: number }> {
    const r = await this.db.get<{ total: number; mine: number }>(
      "SELECT COUNT(*) AS total, COALESCE(SUM(created_by = ?), 0) AS mine FROM repos WHERE kind = 'github' AND read_only = 1",
      userId,
    );
    return { total: r?.total ?? 0, mine: r?.mine ?? 0 };
  }

  /** Link a GitHub repo. Imports in the background; the repo shows as "importing" until the first sync is done. */
  async linkGitHub(owner: string, name: string, opts: { branch?: string; publicReadOnly?: boolean; userId: string; defaultBranch?: string }) {
    const readOnly = !!opts.publicReadOnly;
    // One id per repo; another branch, or a read-only copy next to an editable link, gets a suffix.
    let base = slugify(`gh-${owner}-${name}`);
    if (opts.branch && opts.defaultBranch && opts.branch !== opts.defaultBranch) base = slugify(`${base}-${opts.branch}`);
    const title = `${owner}/${name}${opts.branch && opts.defaultBranch && opts.branch !== opts.defaultBranch ? ` (${opts.branch})` : ""}`;
    for (let i = 1; ; i++) {
      const existing = await this.findGitHub(owner, name, { readOnly, branch: opts.branch });
      if (existing) return { repo: existing, created: false };
      const id = i === 1 ? base : `${base}-${i}`;
      // One statement checks for a copy and claims the id, so concurrent links of the same repo can't both insert
      // (no copy yet but the id is taken: try the next suffix). Whoever adds one owns it.
      const { changes } = await this.db.run(
        `INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_by, created_at, owner_id)
         SELECT ?, ?, 'github', ?, ?, ?, ?, 'importing', ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM repos WHERE kind = 'github' AND lower(gh_owner) = lower(?) AND lower(gh_name) = lower(?) AND read_only = ? AND (? IS NULL OR branch = ?))
         ON CONFLICT (id) DO NOTHING`,
        id,
        title,
        owner,
        name,
        readOnly ? 1 : 0,
        opts.branch || "main",
        opts.userId,
        Date.now(),
        opts.userId,
        owner,
        name,
        readOnly ? 1 : 0,
        opts.branch ?? null,
        opts.branch ?? null,
      );
      if (!changes) continue;
      emit({ type: "repos" });
      void this.importGitHub(id, owner, name, opts.branch, readOnly);
      return { repo: (await this.get(id))!, created: true };
    }
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
    if (!(await this.get(id))) return;
    try {
      if (!branch) {
        branch = (await githubDefaultBranch(owner, name)) || "main";
        await this.db.run("UPDATE repos SET branch = ? WHERE id = ?", branch, id);
      }
      await this.store.createRepo(id, { branch, github: { owner, name, branch, publicReadOnly: readOnly } });
      // Removed while it was being copied: don't leave the copy behind.
      if (!(await this.get(id))) {
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
      if (!(await this.get(id))) {
        await this.store.deleteRepo(id).catch(() => {});
        return;
      }
      await this.db.run("UPDATE repos SET status = 'ready', error = NULL WHERE id = ?", id);
      this.heads.set(id, head);
    } catch (e) {
      console.error(`[repos] import ${id}:`, (e as Error).message ?? e);
      await this.db.run("UPDATE repos SET status = 'error', error = ? WHERE id = ?", importError(e, owner, name, branch), id).catch(() => {});
      // Don't keep a useless read-only copy (or one whose repo was removed meanwhile).
      if (readOnly || !(await this.get(id).catch(() => null))) await this.store.deleteRepo(id).catch(() => {});
    }
    emit({ type: "repos" });
  }

  /** Re-import a GitHub repo whose import failed, on behalf of `userId` (who then counts as having added it). */
  async retryImport(repo: RepoRow, userId: string) {
    if (repo.kind !== "github" || repo.status !== "error") return repo;
    // Claim the retry in one statement, so concurrent retries start one import.
    const { changes } = await this.db.run("UPDATE repos SET status = 'importing', error = NULL, created_by = ? WHERE id = ? AND status = 'error'", userId, repo.id);
    if (!changes) return (await this.get(repo.id)) ?? repo;
    await this.store.deleteRepo(repo.id).catch(() => {});
    emit({ type: "repos" });
    void this.importGitHub(repo.id, repo.gh_owner!, repo.gh_name!, repo.branch, !!repo.read_only);
    return (await this.get(repo.id))!;
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
      await this.onPush(repo.id, { fresh: true });
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
    await this.db.run("DELETE FROM repos WHERE id = ?", id);
    forgetWorkspace(id);
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

  /**
   * Called on webhook pushes and by the poller. `fresh` re-reads the head past the head cache (pollers); webhooks
   * call invalidate() first instead.
   */
  async onPush(repoId: string, opts: { fresh?: boolean } = {}) {
    const repo = await this.get(repoId);
    if (!repo || repo.status !== "ready") return;
    let head: string | null;
    try {
      head = await this.store.head(repo.id, repo.branch, opts.fresh ? { fresh: true } : undefined);
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

  /** A push from outside (webhook): forget the cached head, then pick it up. */
  pushed(repoId: string): Promise<void> {
    this.store.invalidate?.(repoId);
    return this.onPush(repoId);
  }

  /** Poll every repo for outside pushes, and refresh read-only GitHub repos from GitHub. Returns a function that stops polling. */
  startPolling(): () => void {
    const timer = setInterval(async () => {
      const rows = await this.list().catch(() => []);
      for (const r of rows) if (r.status === "ready") void this.onPush(r.id, { fresh: true });
    }, config.pollMs);
    const failed = new Set<string>();
    let running = false;
    const upstream = setInterval(async () => {
      if (running) return;
      running = true;
      // One at a time, so a burst of repos doesn't hammer GitHub.
      for (const r of await this.list().catch(() => [])) {
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

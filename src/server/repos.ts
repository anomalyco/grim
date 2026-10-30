import { githubRepoInfo } from "./auth.ts";
import { canEditGitHub, config } from "./config.ts";
import { emit } from "./events.ts";
import { isErr } from "./errors.ts";
import type { Db } from "./seams/db.ts";
import { forgetWorkspace, recordJoin } from "./workspaces.ts";
import type { RoomManager } from "./rooms.ts";
import { isMarkdown } from "./store/types.ts";
import type { WorkspaceHost } from "./seams/workspace-host.ts";
import { RuntimeMap, type HeadCachingStore } from "./workspace.ts";

/** GitHub imports running at the same time (per process, on Bun). */
const MAX_IMPORTS = 2;
/** While Code Storage copies a repo from GitHub in the background, its head is polled this often… */
export const IMPORT_POLL_MS = 3000;
/** …this many times (10 minutes) before the import gives up. A local clone is complete when createRepo returns. */
const IMPORT_POLLS = 200;

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
  /** Each workspace's runtime (rooms, tree cache, heads, rename queue): in-process on Bun, Durable Objects on Workers. */
  readonly host: WorkspaceHost;

  constructor(
    private store: HeadCachingStore,
    rooms: RoomManager,
    /** The global tables (repos, joined, …). */
    readonly db: Db,
    host?: WorkspaceHost,
    /** Runs GitHub imports: in-process timers by default (Bun); on Workers, each workspace's Durable Object alarm. */
    imports?: ImportScheduler,
  ) {
    this.host = host ?? new RuntimeMap(store, rooms);
    this.importDeps = { db, store, seenHead: (id, head) => this.host.get(id).seenHead(head) };
    this.imports = imports ?? new TimerImports(this.importDeps);
  }

  private readonly importDeps: ImportDeps;
  private readonly imports: ImportScheduler;

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

  /** A new notes workspace owned (and joined) by `userId`, with `readme` as its README.md (default `# <title>`). */
  async createNotesRepo(title: string, userId: string, readme = `# ${title}\n`) {
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
        changes: [{ path: "README.md", content: readme }],
        message: "Create README.md",
        author: { name: "Grim", email: "grimoire@users.noreply.code.storage" },
      });
    } catch (e) {
      await this.db.run("DELETE FROM repos WHERE id = ?", id);
      forgetWorkspace(id);
      throw e;
    }
    await this.db.run("UPDATE repos SET status = 'ready' WHERE id = ?", id);
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
        await this.startImport(id, owner, name, opts.branch, readOnly);
      return { repo: (await this.get(id))!, created: true };
    }
  }

  /** Imports running now (Bun's timer scheduler; 0 when imports run elsewhere). */
  private get importing(): number {
    return this.imports.running ?? 0;
  }

  /** Hand a new import to the scheduler; if it can't take it, the workspace shows the error. */
  private async startImport(id: string, owner: string, name: string, branch: string | undefined, readOnly: boolean) {
    const state = newImport(id, owner, name, branch, readOnly);
    try {
      await this.imports.start(state);
    } catch (e) {
      await failImport(this.importDeps, state, e);
    }
  }

  /** Re-import a GitHub repo whose import failed, on behalf of `userId` (who then counts as having added it). */
  async retryImport(repo: RepoRow, userId: string) {
    if (repo.kind !== "github" || repo.status !== "error") return repo;
    // Claim the retry in one statement, so concurrent retries start one import.
    const { changes } = await this.db.run("UPDATE repos SET status = 'importing', error = NULL, created_by = ? WHERE id = ? AND status = 'error'", userId, repo.id);
    if (!changes) return (await this.get(repo.id)) ?? repo;
    await this.store.deleteRepo(repo.id).catch(() => {});
    emit({ type: "workspace", repo: repo.id, status: "importing" });
    await this.startImport(repo.id, repo.gh_owner!, repo.gh_name!, repo.branch, !!repo.read_only);
    return (await this.get(repo.id))!;
  }

  /**
   * Pull GitHub's latest commits into a read-only GitHub repo, then pick them up like any outside push. Other repos
   * only re-check their head. Concurrent calls share one refresh; `minIntervalMs` skips refreshes that just ran.
   */
  refresh(repo: RepoRow, minIntervalMs = 0): Promise<void> {
    return this.host.get(repo.id).refresh(repo, minIntervalMs);
  }

  async removeRepo(id: string) {
    await this.host.get(id).remove();
    await this.store.deleteRepo(id).catch((e) => console.error(`[repos] delete ${id}:`, e));
    await this.db.run("DELETE FROM repos WHERE id = ?", id);
    forgetWorkspace(id);
    this.host.forget?.(id);
  }

  /** Markdown files at the branch tip, plus open notes that aren't committed yet. */
  tree(repo: RepoRow): Promise<string[]> {
    return this.host.get(repo.id).tree(repo);
  }

  /** Refresh read-only GitHub repos from GitHub. Returns a function that stops it. */
  startPolling(): () => void {
    // GITHUB_COPIES off: existing copies stay as they are
    if (!config.githubCopiesEnabled) return () => {};
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
    return () => clearInterval(upstream);
  }
}

// ---- GitHub imports ----
//
// An import is a small state machine whose state is plain JSON, so it can be saved between steps and resumed after
// a restart or a Durable Object eviction: `importStep` runs one step and returns the next state (or null when the
// import is over, either way). Every step can safely run again if it was interrupted (createRepo is a no-op for an
// existing repo, head polls and the final checks only read). A scheduler runs the steps: `TimerImports` (setTimeout,
// in-process) on Bun; on Workers the workspace's Durable Object saves the state and runs it from its alarm
// (`runDueImport`).

export interface ImportState {
  id: string;
  owner: string;
  name: string;
  readOnly: boolean;
  /** The branch to copy; null until GitHub's default branch is looked up. */
  branch: string | null;
  /** branch: check the workspace still exists, look up the default branch if needed; create: start the copy;
   *  wait: poll for its head; finish: check it has Markdown, mark the workspace ready and report the head. */
  phase: "branch" | "create" | "wait" | "finish";
  /** Head polls so far (wait). */
  polls: number;
  /** The copy's head, once seen (finish). */
  head: string | null;
  /** Earliest time (ms since the epoch) to run the next step. */
  at: number;
}

export interface ImportDeps {
  db: Db;
  store: HeadCachingStore;
  /** The import is done: the workspace's runtime learns the head (`host.get(id).seenHead(head)`). */
  seenHead(id: string, head: string): Promise<void>;
  /** Between head polls (default IMPORT_POLL_MS). */
  pollMs?: number;
  now?(): number;
}

export interface ImportScheduler {
  /** Run a new import (now, or when a slot is free). Resolves once it is scheduled, not when it finishes. */
  start(state: ImportState): void | Promise<void>;
  /** Imports running in this process, if it runs them. */
  readonly running?: number;
}

export function newImport(id: string, owner: string, name: string, branch: string | undefined, readOnly: boolean, now = Date.now()): ImportState {
  return { id, owner, name, readOnly, branch: branch ?? null, phase: "branch", polls: 0, head: null, at: now };
}

/** Run one step of an import; the next state, or null when it is over (ready, failed, or the workspace was removed). */
export async function importStep(deps: ImportDeps, s: ImportState): Promise<ImportState | null> {
  const now = deps.now ?? Date.now;
  const { db, store } = deps;
  const exists = async () => !!(await getRepo(db, s.id));
  try {
    switch (s.phase) {
      case "branch": {
        // Removed while waiting for a slot.
        if (!(await exists())) return null;
        let branch = s.branch;
        if (!branch) {
          branch = (await githubDefaultBranch(s.owner, s.name)) || "main";
          await db.run("UPDATE repos SET branch = ? WHERE id = ?", branch, s.id);
        }
        return { ...s, branch, phase: "create", at: now() };
      }
      case "create": {
        const branch = s.branch!;
        await store.createRepo(s.id, { branch, github: { owner: s.owner, name: s.name, branch, publicReadOnly: s.readOnly } });
        // Removed while it was being copied: don't leave the copy behind.
        if (!(await exists())) {
          await store.deleteRepo(s.id).catch(() => {});
          return null;
        }
        return { ...s, phase: "wait", polls: 0, at: now() };
      }
      case "wait": {
        let head: string | null = null;
        try {
          head = await store.head(s.id, s.branch!, { fresh: true });
        } catch (e) {
          if (!isErr(e, "RepoBusyError")) throw e;
        }
        if (head) return { ...s, phase: "finish", head, at: now() };
        const polls = s.polls + 1;
        // Code Storage imports in the background; a local clone is complete when createRepo returns.
        if (polls >= (store.kind === "local" ? 1 : IMPORT_POLLS)) throw new Error(`${s.owner}/${s.name} has no commits on ${s.branch}`);
        return { ...s, polls, at: now() + (deps.pollMs ?? IMPORT_POLL_MS) };
      }
      case "finish": {
        const head = s.head!;
        if (!(await store.listFiles(s.id, head)).some(isMarkdown)) throw new Error(`No Markdown files in ${s.owner}/${s.name} on ${s.branch}`);
        if (!(await exists())) {
          await store.deleteRepo(s.id).catch(() => {});
          return null;
        }
        await db.run("UPDATE repos SET status = 'ready', error = NULL WHERE id = ?", s.id);
        await deps.seenHead(s.id, head);
            emit({ type: "workspace", repo: s.id, status: "ready" });
        return null;
      }
    }
  } catch (e) {
    await failImport(deps, s, e);
    return null;
  }
}

/** The import failed: the workspace shows why, and a read-only copy (or a removed workspace's) is deleted. */
async function failImport(deps: ImportDeps, s: ImportState, e: unknown) {
  const { db, store } = deps;
  console.error(`[repos] import ${s.id}:`, (e as Error).message ?? e);
  const error = importError(e, s.owner, s.name, s.branch ?? undefined);
  await db.run("UPDATE repos SET status = 'error', error = ? WHERE id = ?", error, s.id).catch(() => {});
  // Don't keep a useless read-only copy (or one whose repo was removed meanwhile).
  if (s.readOnly || !(await getRepo(db, s.id).catch(() => null))) await store.deleteRepo(s.id).catch(() => {});
  emit({ type: "workspace", repo: s.id, status: "error", error });
}

/**
 * Bun's scheduler: imports run in this process, at most `max` at a time (the rest wait their turn, still showing
 * "importing"); steps that aren't due yet wait on a timer. A slot is held until the import is over.
 */
export class TimerImports implements ImportScheduler {
  running = 0;
  private queue: ImportState[] = [];

  constructor(
    private deps: ImportDeps,
    private max = MAX_IMPORTS,
  ) {}

  start(state: ImportState) {
    if (this.running >= this.max) {
      this.queue.push(state);
      return;
    }
    this.running++;
    void this.run(state);
  }

  private async run(state: ImportState | null) {
    const now = this.deps.now ?? Date.now;
    while (state && state.at <= now()) state = await importStep(this.deps, state).catch(() => null);
    if (state) {
      const next = state;
      setTimeout(() => void this.run(next), next.at - now());
      return;
    }
    const queued = this.queue.shift();
    if (queued) void this.run(queued);
    else this.running--;
  }
}

/** Where a Durable Object keeps its workspace's import (one at a time). */
export interface ImportStore {
  get(): Promise<ImportState | null | undefined> | ImportState | null | undefined;
  put(state: ImportState | null): Promise<void> | void;
}

/**
 * One alarm tick of a saved import: runs its step if it is due and saves the next state. Returns when to run again
 * (ms since the epoch), or null when there's nothing left to do. Run it again after an interruption: the saved
 * state is still the step that didn't finish.
 */
export async function runDueImport(deps: ImportDeps, store: ImportStore): Promise<number | null> {
  const state = await store.get();
  if (!state) return null;
  if (state.at > (deps.now ?? Date.now)()) return state.at;
  const next = await importStep(deps, state);
  await store.put(next);
  return next?.at ?? null;
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

// The folders (workspaces) someone has joined: opening a folder while signed in records it, and their switcher
// lists it until they leave. Every folder is public, so joining grants nothing. See docs/workspaces/SPEC.md.
// Sign-in off: no lists of anyone's; every workspace is listed for everyone (`listedRows`).
import { repoAccess } from "./auth.ts";
import { config } from "./config.ts";
import { DEMO_ID } from "./demo.ts";
import { demoGate, isDemoRoom } from "./demo-rooms.ts";
import { getRepo, listRepoRows, type RepoRow } from "./repos.ts";
import type { Db } from "./seams/db.ts";
import type { AccessFn } from "./shell/fs.ts";

/**
 * (user, workspace) pairs known to be joined, oldest first, so reopening a folder doesn't write to the global
 * database (on Workers it has a single primary). Per process; a miss reads before inserting.
 */
const MAX_KNOWN = 10_000;
const known = new Map<string, true>();
const pairKey = (userId: string, repoId: string) => `${userId}\0${repoId}`;

function remember(key: string) {
  known.delete(key);
  known.set(key, true);
  if (known.size > MAX_KNOWN) known.delete(known.keys().next().value!);
}

export async function recordJoin(db: Db, userId: string, repoId: string) {
  // (sign-in off: no lists to keep; the demo is for people who aren't signed in: an account never joins it)
  if (!config.signIn || repoId === DEMO_ID) return;
  // (a demo room is never joined: it's reached through /app/demo, and goes away)
  if (isDemoRoom(repoId)) return;
  const key = pairKey(userId, repoId);
  if (known.has(key)) return remember(key);
  if (!(await db.get("SELECT 1 FROM joined WHERE workspace_id = ? AND user_id = ?", repoId, userId))) {
    await db.run("INSERT INTO joined (workspace_id, user_id, via, joined_at) VALUES (?, ?, 'link', ?) ON CONFLICT DO NOTHING", repoId, userId, Date.now());
  }
  remember(key);
}

export async function leave(db: Db, userId: string, repoId: string) {
  known.delete(pairKey(userId, repoId));
  await db.run("DELETE FROM joined WHERE workspace_id = ? AND user_id = ?", repoId, userId);
}

/** Forget the cached joins of a workspace whose rows went away (it was removed): call after deleting it. */
export function forgetWorkspace(repoId: string) {
  for (const key of known.keys()) if (key.endsWith(`\0${repoId}`)) known.delete(key);
}

/** Test hook: empty the cache of known joins. */
export function clearJoinCache() {
  known.clear();
}

export async function joinedRows(db: Db, userId: string): Promise<RepoRow[]> {
  const rows = await db.all<RepoRow>("SELECT r.* FROM joined j JOIN repos r ON r.id = j.workspace_id WHERE j.user_id = ? ORDER BY r.kind DESC, r.title", userId);
  return rows.filter((r) => r.id !== DEMO_ID);
}

/** The workspaces listed to someone: those they joined; with sign-in off, every workspace on the server (no demo there). */
export async function listedRows(db: Db, userId: string): Promise<RepoRow[]> {
  if (config.signIn) return joinedRows(db, userId);
  return (await listRepoRows(db)).filter((r) => r.id !== DEMO_ID && !isDemoRoom(r.id));
}

/**
 * An MCP caller's shell over one workspace (mcp.ts `command`): what anyone may do there (read-only stays read-only),
 * checked again on every call; never "demo" itself, nor a demo room they aren't in.
 */
export function workspaceAccess(db: Db, userId: string, repoId: string): AccessFn {
  return Object.assign(
    async (repo: RepoRow) => {
      if (repo.id !== repoId || repo.id === DEMO_ID || repo.status !== "ready") return "none" as const;
      if (isDemoRoom(repo.id) && (await demoGate().roomOf(userId)) !== repo.id) return "none" as const;
      return repoAccess(repo);
    },
    {
      listed: async () => {
        const row = await getRepo(db, repoId);
        return row ? [row] : [];
      },
    },
  );
}

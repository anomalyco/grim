// The folders (workspaces) someone has joined: opening a folder while signed in records it, and their switcher
// lists it until they leave. Every folder is public, so joining grants nothing. See docs/workspaces/SPEC.md.
import type { RepoRow } from "./repos.ts";
import type { Db } from "./seams/db.ts";

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

export function joinedRows(db: Db, userId: string): Promise<RepoRow[]> {
  return db.all<RepoRow>("SELECT r.* FROM joined j JOIN repos r ON r.id = j.workspace_id WHERE j.user_id = ? ORDER BY r.kind DESC, r.title", userId);
}

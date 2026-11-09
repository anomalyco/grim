// The folders (workspaces) someone has joined: opening a folder while signed in records it, and their switcher
// lists it until they leave. Every folder is public, so joining grants nothing. See docs/workspaces/SPEC.md.
// Sign-in off: no lists of anyone's; every workspace is listed for everyone (`listedRows`).
import { config } from "./config.ts";
import { DEMO_ID } from "./demo.ts";
import { isDemoRoom } from "./demo-rooms.ts";
import { listRepoRows, type RepoRow } from "./repos.ts";
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

/** Leave every workspace (the account is being deleted). */
export async function leaveAll(db: Db, userId: string) {
  for (const key of known.keys()) if (key.startsWith(`${userId}\0`)) known.delete(key);
  await db.run("DELETE FROM joined WHERE user_id = ?", userId);
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

// The folders (workspaces) someone has joined: opening a folder while signed in records it, and their switcher
// lists it until they leave. Every folder is public, so joining grants nothing. See docs/workspaces/SPEC.md.
import { repoAccess } from "./auth.ts";
import { config } from "./config.ts";
import { DEMO_ID } from "./demo.ts";
import { demoGate, isDemoRoom } from "./demo-rooms.ts";
import { getRepo, type RepoRow } from "./repos.ts";
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

/** A sign-in-off visitor's id (auth.ts `visitorUser`), not an account. */
export const isVisitorId = (userId: string) => userId.startsWith("guest:");

/**
 * The demo is only for people who aren't signed in: an account never joins it or sees it listed (visitors on a
 * server without sign-in, who have no accounts, keep it as guests do).
 */
const hidesDemo = (userId: string) => !isVisitorId(userId);

export async function recordJoin(db: Db, userId: string, repoId: string) {
  if (repoId === DEMO_ID && hidesDemo(userId)) return;
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
  return hidesDemo(userId) ? rows.filter((r) => r.id !== DEMO_ID) : rows;
}

const byKindTitle = (a: RepoRow, b: RepoRow) => (a.kind !== b.kind ? (a.kind < b.kind ? 1 : -1) : a.title < b.title ? -1 : a.title > b.title ? 1 : 0);

/**
 * The workspaces a listing shows someone: those they joined (none without `userId`) plus the `extra` ids that exist,
 * in the joined list's order. Never every workspace: their ids are what keeps them private.
 */
export async function listedRows(db: Db, userId: string | null, extra: string[]): Promise<RepoRow[]> {
  const [mine, more] = await Promise.all([userId ? joinedRows(db, userId) : [], Promise.all([...new Set(extra)].map((id) => getRepo(db, id)))]);
  const have = new Set(mine.map((r) => r.id));
  const rows = [...mine, ...more.filter((r): r is RepoRow => !!r && !have.has(r.id) && !(r.id === DEMO_ID && userId && hidesDemo(userId)))];
  return rows.length > mine.length ? rows.sort(byKindTitle) : rows;
}

/** A person's shell and MCP: any workspace they name by id; listings show their joined ones, the default notebook and,
 *  for visitors of a server without sign-in (never accounts), the demo room they're in (a demo room they aren't in
 *  isn't theirs to open). */
export function personAccess(db: Db, userId: string): AccessFn {
  return Object.assign(
    async (repo: RepoRow) => {
      if (repo.id === "demo" || (isDemoRoom(repo.id) && (await demoGate().roomOf(userId)) !== repo.id)) return "none" as const;
      return repoAccess(repo);
    },
    {
      listed: async () => {
        const room = hidesDemo(userId) ? null : await demoGate().roomOf(userId);
        return listedRows(db, userId, room ? [room, config.notesRepo] : [config.notesRepo]);
      },
    },
  );
}

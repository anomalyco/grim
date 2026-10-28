// The folders (workspaces) someone has joined: opening a folder while signed in records it, and their switcher
// lists it until they leave. Every folder is public, so joining grants nothing. See docs/workspaces/SPEC.md.
import { db } from "./db.ts";
import type { RepoRow } from "./repos.ts";

export function recordJoin(userId: string, repoId: string) {
  db.query("INSERT INTO joined (workspace_id, user_id, via, joined_at) VALUES (?, ?, 'link', ?) ON CONFLICT DO NOTHING").run(repoId, userId, Date.now());
}

export function leave(userId: string, repoId: string) {
  db.query("DELETE FROM joined WHERE workspace_id = ? AND user_id = ?").run(repoId, userId);
}

export function joinedRows(userId: string): RepoRow[] {
  return db.query("SELECT r.* FROM joined j JOIN repos r ON r.id = j.workspace_id WHERE j.user_id = ? ORDER BY r.kind DESC, r.title").all(userId) as RepoRow[];
}

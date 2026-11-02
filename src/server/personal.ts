// An account's own workspace ("<First name>'s notes", docs/accounts.md): made when the account is (the sign-in
// callbacks call newAccount), so every account has one whichever way it signed up (the web, the Mac app, an MCP
// client's OAuth) and whether or not a client ever asks; POST /api/workspaces/personal (the clients' landing) makes it
// for an account that has none, and answers `created: true` once for the one made at sign-up (users.welcome_ws), so
// the first sign-in's welcome still shows once.
import type { Ctx } from "./ops.ts";
import type { RepoRow } from "./repos.ts";
import { DEMO_ID } from "./demo.ts";
import { joinedRows, recordJoin } from "./workspaces.ts";
import { metric } from "./metrics.ts";

export const PERSONAL_README = `# Notes

This is your workspace. You aren't thinking of writing yourself are you? Why would you do that?

Share these files with your agent by clicking "Share" at the bottom-left of the page. Your agent gets access to a full filesystem that it can edit with any bash command. It will write files like it normally does, and you can see them here.

All changes are tracked in git. You can write here too, and your agent will be able to see what you write.

**Note: consider all of your notes public. Anyone with the URL to this workspace can read and edit them. In the future we may provide private workspaces.**
`;

/** "<First name>'s notes" (any script), or "My notes" for a name with no letter or digit in its first word. */
export function personalTitle(name: string | null | undefined): string {
  const first = Array.from((name ?? "").trim().split(/\s+/)[0] ?? "").slice(0, 40).join("");
  return /[\p{L}\p{N}]/u.test(first) ? `${first}'s notes` : "My notes";
}

/**
 * Keeps work going after the response (or a client that went away): the Worker hands it to ctx.waitUntil (router.ts),
 * so a sign-up whose tab closes mid-way doesn't leave a workspace half made.
 */
let keepAlive: (p: Promise<unknown>) => void = () => {};
export function setPersonalKeepAlive(fn: (p: Promise<unknown>) => void) {
  keepAlive = fn;
}

/** A notes workspace whose making stopped half way (status still "importing") this long ago is finished on the next ask. */
const STUCK_MS = 60_000;

/** Personal workspaces being made, per account (one at a time per process). */
const making = new Map<string, Promise<{ repo: RepoRow; created: boolean }>>();

/**
 * Where an account lands: its first joined workspace (never the demo), else the first one it made (joined again),
 * else a new personal workspace with PERSONAL_README (counted: personal_workspace_created). One whose making was cut
 * off is finished first.
 */
export function personalWorkspace(ctx: Ctx, user: { id: string; name: string }, req?: Request | null): Promise<{ repo: RepoRow; created: boolean }> {
  const busy = making.get(user.id);
  // a call that waits on another one's making didn't make it
  if (busy) return busy.then(({ repo }) => ({ repo, created: false }));
  const run = (async () => {
    const db = ctx.repos.db;
    const joined = await joinedRows(db, user.id);
    if (joined.length) return { repo: await finishIfStuck(ctx, joined[0]!, user), created: false };
    const owned = await db.get<RepoRow>("SELECT * FROM repos WHERE owner_id = ? AND id != ? ORDER BY created_at LIMIT 1", user.id, DEMO_ID);
    if (owned) {
      await recordJoin(db, user.id, owned.id);
      return { repo: await finishIfStuck(ctx, owned, user), created: false };
    }
    const repo = await ctx.repos.createNotesRepo(personalTitle(user.name), user.id, PERSONAL_README);
    metric(db, "personal_workspace_created", req);
    return { repo, created: true };
  })().finally(() => making.delete(user.id));
  making.set(user.id, run);
  keepAlive(run.catch(() => {}));
  return run;
}

async function finishIfStuck(ctx: Ctx, repo: RepoRow, user: { id: string; name: string }): Promise<RepoRow> {
  if (repo.kind !== "notes" || repo.status !== "importing" || repo.owner_id !== user.id || Date.now() - repo.created_at < STUCK_MS) return repo;
  const readme = repo.title === personalTitle(user.name) ? PERSONAL_README : `# ${repo.title}\n`;
  return ctx.repos.finishNotesRepo(repo.id, readme);
}

/** A new account's own workspace, made as it signs up; the clients' landing (POST …/personal) welcomes them to it once. */
export async function newAccount(ctx: Ctx, userId: string, req?: Request | null): Promise<void> {
  const db = ctx.repos.db;
  try {
    const user = await db.get<{ id: string; name: string }>("SELECT id, name FROM users WHERE id = ?", userId);
    if (!user) return;
    const { repo, created } = await personalWorkspace(ctx, user, req);
    if (created) await db.run("UPDATE users SET welcome_ws = ? WHERE id = ?", repo.id, user.id);
  } catch (e) {
    // signing up still works: the clients' landing makes it later
    console.error("[personal] at sign-up:", e);
  }
}

/**
 * POST /api/workspaces/personal: the account's landing workspace; `created` is true on the one answer that first hands
 * it over (made now, or made at sign-up and not welcomed yet), for the clients' one-time welcome.
 */
export async function landingWorkspace(ctx: Ctx, user: { id: string; name: string }, req?: Request | null): Promise<{ repo: RepoRow; created: boolean }> {
  const db = ctx.repos.db;
  const pending = (await db.get<{ welcome_ws: string | null }>("SELECT welcome_ws FROM users WHERE id = ?", user.id))?.welcome_ws;
  if (pending) {
    const claimed = (await db.run("UPDATE users SET welcome_ws = NULL WHERE id = ? AND welcome_ws = ?", user.id, pending)).changes > 0;
    const repo = claimed ? await ctx.repos.get(pending) : null;
    if (repo) return { repo: await finishIfStuck(ctx, repo, user), created: true };
  }
  return personalWorkspace(ctx, user, req);
}

// Deleting an account (DELETE /api/me, sign-in on only): docs/accounts.md, "Deleting your account".
import { forgetUser } from "./auth.ts";
import type { Ctx } from "./ops.ts";
import { closeRepoShares, deleteUserShares } from "./shares.ts";
import { leaveAll } from "./workspaces.ts";

export interface DeletedAccount {
  /** The workspaces the account made, removed with it. */
  workspaces: string[];
  /** Those that couldn't be removed (logged); their rows stay, with no owner. */
  failed: string[];
}

/**
 * Delete `userId` and everything that's theirs, in an order that never leaves a half-deleted account that still
 * signs in: first every way in (browser sessions, app tokens including MCP clients', sign-in codes), then their
 * agent links (stopping what runs through them), their joined list, every workspace they made (the usual removal:
 * its rooms, links and repo go), and last the user row. A workspace that fails to go is logged and reported, and the
 * rest carries on. Workspaces other people made are untouched.
 */
export async function deleteAccount(ctx: Ctx, userId: string): Promise<DeletedAccount> {
  const db = ctx.repos.db;
  await db.batch([
    ["DELETE FROM sessions WHERE user_id = ?", userId],
    ["DELETE FROM app_tokens WHERE user_id = ?", userId],
    ["DELETE FROM connect_codes WHERE user_id = ?", userId],
  ]);
  forgetUser(userId);
  await deleteUserShares(db, userId);
  await leaveAll(db, userId);
  const owned = await db.all<{ id: string }>("SELECT id FROM repos WHERE owner_id = ? ORDER BY id", userId);
  const failed: string[] = [];
  for (const { id } of owned) {
    try {
      await closeRepoShares(db, id);
      await ctx.repos.removeRepo(id);
    } catch (e) {
      console.error(`[account] delete ${userId}: removing workspace ${id} failed:`, e);
      failed.push(id);
    }
  }
  await db.batch([
    // (what failed to go stays, no one's: nobody can sign in as its maker any more)
    ["UPDATE repos SET owner_id = NULL WHERE owner_id = ?", userId],
    ["DELETE FROM users WHERE id = ?", userId],
  ]);
  forgetUser(userId);
  console.log(`[account] deleted ${userId}: ${owned.length - failed.length} workspace(s) removed${failed.length ? `, ${failed.length} failed (${failed.join(", ")})` : ""}`);
  return { workspaces: owned.map((r) => r.id), failed };
}

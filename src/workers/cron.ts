// The Worker's cron jobs (wrangler.jsonc `triggers.crons`), the Workers counterpart of Bun's pollers and timers:
// - every 5 minutes: reset every demo room when that tick crosses a DEMO_RESET_MINUTES boundary (startDemoResets on Bun);
// - every 6 hours: delete expired sessions, and the rows of demo rooms the lobby no longer has;
// - nightly (03:00 UTC): every workspace's export (zip) to R2 at backups/<workspace>/<date>.zip (docs/storage-v2.md §11).
// A cron runs outside any request, so it makes its own D1 `Db` (the router's per-request Db only works inside fetch).
import { pruneSessions } from "../server/auth.ts";
import { config } from "../server/config.ts";
import { deleteStaleDemoRows } from "../server/demo.ts";
import { listRepoRows } from "../server/repos.ts";
import type { Db } from "../server/seams/db.ts";
import type { WorkspaceApi } from "../server/seams/workspace-host.ts";
import { d1Db } from "./db-d1.ts";
import { R2Blobs } from "./blobs-r2.ts";
import type { BlobStore } from "../server/seams/blobs.ts";
import { isDemoRoom } from "../server/demo-rooms.ts";
import { demoLobby } from "./demo.ts";
import type { Env } from "./index.ts";

export const REFRESH_CRON = "*/5 * * * *";
export const RESET_CRON = "0 */6 * * *";
export const BACKUP_CRON = "0 3 * * *";

export interface CronDeps {
  db: Db;
  /** A workspace's runtime: its WorkspaceDO over RPC. */
  workspace(id: string): Pick<WorkspaceApi, "exportZip">;
  /** Where nightly exports go (R2). */
  backups?: BlobStore;
  /** Reset every demo room. */
  resetDemo(): Promise<void>;
  /** The demo rooms the lobby has (the other demo rows are stale). */
  demoRooms?(): Promise<string[]>;
  /** The tick's scheduled time (controller.scheduledTime); Date.now() by default. */
  now?(): number;
  /** DEMO_RESET_MINUTES; config's by default. */
  demoResetMinutes?: number;
}

export function cronDeps(env: Env): CronDeps {
  return {
    db: d1Db(env.DB),
    // WorkspaceDO implements WorkspaceApi (CF-24); typed through the seam until its RPC methods land.
    workspace: (id) => env.WORKSPACE.getByName(id, { locationHint: "enam" }) as unknown as Pick<WorkspaceApi, "exportZip">,
    backups: new R2Blobs(env.IMAGES),
    resetDemo: () => resetDemo(env),
    demoRooms: () => demoLobby(env).demoRooms(),
  };
}

/** Reset every demo room in its Durable Object: its seed back, its rooms discarded (clients get 1013 and reload). */
export async function resetDemo(env: Env): Promise<void> {
  const rooms = await demoLobby(env).demoRooms();
  const results = await Promise.allSettled(rooms.map((id) => env.WORKSPACE.getByName(id, { locationHint: "enam" }).resetDemo()));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map((r) => r.reason), `${failed.length} of ${rooms.length} demo rooms failed to reset`);
}

export async function scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  await runCron(controller.cron, { ...cronDeps(env), now: () => controller.scheduledTime });
}

/** Whether the 5-minute tick at `at` (ms) is the one that crosses a reset boundary (multiples of `minutes` since the
 *  epoch, so 15 → :00 :15 :30 :45 UTC; 360 → every 6 hours). Intervals under 5 minutes reset on every tick; 0 never. */
export function demoResetDue(at: number, minutes: number): boolean {
  if (!(minutes > 0)) return false;
  const m = Math.floor(at / 60_000);
  return m % minutes < 5;
}

export async function runCron(cron: string, deps: CronDeps): Promise<void> {
  switch (cron) {
    case REFRESH_CRON: {
      const reset = demoResetDue((deps.now ?? Date.now)(), deps.demoResetMinutes ?? config.demoResetMinutes);
      if (reset) await deps.resetDemo();
      return;
    }
    case RESET_CRON: {
      const live = deps.demoRooms ? new Set(await deps.demoRooms()) : null;
      await Promise.all([pruneSessions(deps.db, (deps.now ?? Date.now)()), live ? deleteStaleDemoRows(deps.db, live) : undefined]);
      return;
    }
    case BACKUP_CRON:
      await backupAll(deps);
      return;
    default:
      console.warn(`[cron] no job for "${cron}"`);
  }
}

/** Every ready workspace's export to the backups bucket, one at a time; one failing doesn't stop the others. */
export async function backupAll(deps: CronDeps): Promise<{ saved: number; failed: number }> {
  if (!deps.backups) return { saved: 0, failed: 0 };
  const day = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
  const rows = (await listRepoRows(deps.db)).filter((r) => r.status === "ready" && !isDemoRoom(r.id));
  let saved = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await deps.backups.put(`backups/${r.id}/${day}.zip`, await deps.workspace(r.id).exportZip(r), "application/zip");
      saved++;
    } catch (e) {
      failed++;
      console.error(`[cron] backup ${r.id}:`, (e as Error).message ?? e);
    }
  }
  return { saved, failed };
}

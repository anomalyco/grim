// The Worker's cron jobs (wrangler.jsonc `triggers.crons`), the Workers counterpart of Bun's pollers and timers:
// - every 5 minutes: pull GitHub's latest commits into the read-only GitHub copies (RepoService.startPolling on Bun);
// - every 6 hours: reset the demo workspace (startDemoResets on Bun) and delete expired sessions.
// Outside pushes to other workspaces come by webhook (only with EXTERNAL_SYNC=1), so there is no every-minute job.
// A cron runs outside any request, so it makes its own D1 `Db` (the router's per-request Db only works inside fetch).
import { pruneSessions } from "../server/auth.ts";
import { config } from "../server/config.ts";
import { DEMO_ID } from "../server/demo.ts";
import { listRepoRows } from "../server/repos.ts";
import type { Db } from "../server/seams/db.ts";
import type { WorkspaceApi } from "../server/seams/workspace-host.ts";
import { d1Db } from "./db-d1.ts";
import type { Env } from "./index.ts";

export const REFRESH_CRON = "*/5 * * * *";
export const RESET_CRON = "0 */6 * * *";

/** Workspaces refreshed at the same time, so a burst of copies doesn't hammer GitHub. */
const REFRESH_PARALLEL = 4;

export interface CronDeps {
  db: Db;
  /** A workspace's runtime: its WorkspaceDO over RPC. */
  workspace(id: string): Pick<WorkspaceApi, "refresh">;
  resetDemo(): Promise<void>;
  now?(): number;
}

export function cronDeps(env: Env): CronDeps {
  return {
    db: d1Db(env.DB),
    // WorkspaceDO implements WorkspaceApi (CF-24); typed through the seam until its RPC methods land.
    workspace: (id) => env.WORKSPACE.getByName(id, { locationHint: "enam" }) as unknown as Pick<WorkspaceApi, "refresh">,
    resetDemo: () => resetDemo(env),
  };
}

/** Reset the demo workspace in its Durable Object: its seed back, its rooms discarded (clients get 1013 and reload). */
export async function resetDemo(env: Env): Promise<void> {
  await env.WORKSPACE.getByName(DEMO_ID, { locationHint: "enam" }).resetDemo();
}

export async function scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  await runCron(controller.cron, cronDeps(env));
}

export async function runCron(cron: string, deps: CronDeps): Promise<void> {
  switch (cron) {
    case REFRESH_CRON:
      await refreshGitHubCopies(deps);
      return;
    case RESET_CRON: {
      const results = await Promise.allSettled([deps.resetDemo(), pruneSessions(deps.db, (deps.now ?? Date.now)())]);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      // Both run even if one fails; the cron is marked failed if either did.
      if (failed.length) throw new AggregateError(failed.map((r) => r.reason), "demo reset / session pruning failed");
      return;
    }
    default:
      console.warn(`[cron] no job for "${cron}"`);
  }
}

/** Pull GitHub into every ready read-only GitHub copy. One copy failing doesn't stop the others. */
export async function refreshGitHubCopies(deps: CronDeps): Promise<{ refreshed: number; failed: number }> {
  const rows = (await listRepoRows(deps.db)).filter((r) => r.kind === "github" && !!r.read_only && r.status === "ready");
  let refreshed = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++]!;
      try {
        // Half the interval, so a refresh that just ran (or a cron that fired early) doesn't pull again.
        await deps.workspace(r.id).refresh(r, config.upstreamRefreshMs / 2);
        refreshed++;
      } catch (e) {
        failed++;
        console.error(`[cron] refresh ${r.id} from GitHub:`, (e as Error).message ?? e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REFRESH_PARALLEL, rows.length) }, worker));
  return { refreshed, failed };
}

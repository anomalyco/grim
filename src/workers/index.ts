import type { HomeDO } from "./home-do.ts";
import { scheduled } from "./cron.ts";
import { createRouter } from "./router.ts";
import type { WorkspaceDO } from "./workspace-do.ts";

export { WorkspaceDO } from "./workspace-do.ts";
export { HomeDO } from "./home-do.ts";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  /** images (content-addressed) and nightly exports (blobs-r2.ts) */
  IMAGES: R2Bucket;
  /** the staging migration's import (import.ts); unset elsewhere */
  IMPORT_TOKEN?: string;
  /** the demo's lobby (home-do.ts: the name is history) */
  HOME: DurableObjectNamespace<HomeDO>;
}

const router = createRouter();

export default {
  fetch: (req, env, ctx) => router.fetch(req, env, ctx),
  // demo reset, session pruning, nightly backups (src/workers/cron.ts; triggers in wrangler.jsonc)
  scheduled: (controller, env, ctx) => scheduled(controller, env, ctx),
} satisfies ExportedHandler<Env>;

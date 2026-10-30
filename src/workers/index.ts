import type { HomeDO } from "./home-do.ts";
import { scheduled } from "./cron.ts";
import { createRouter } from "./router.ts";
import type { ShellDO } from "./shell-do.ts";
import type { WorkspaceDO } from "./workspace-do.ts";

export { WorkspaceDO } from "./workspace-do.ts";
export { ShellDO } from "./shell-do.ts";
export { HomeDO } from "./home-do.ts";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  SHELL: DurableObjectNamespace<ShellDO>;
  /** the demo's lobby (home-do.ts: the name is history) */
  HOME: DurableObjectNamespace<HomeDO>;
}

const router = createRouter();

export default {
  fetch: (req, env, ctx) => router.fetch(req, env, ctx),
  // GitHub refresh, demo reset, session pruning (src/workers/cron.ts; triggers in wrangler.jsonc)
  scheduled: (controller, env, ctx) => scheduled(controller, env, ctx),
} satisfies ExportedHandler<Env>;

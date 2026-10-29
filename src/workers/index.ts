import type { HomeDO } from "./home-do.ts";
import type { HubDO } from "./hub-do.ts";
import { scheduled } from "./cron.ts";
import { createRouter } from "./router.ts";
import type { ShellDO } from "./shell-do.ts";
import type { WorkspaceDO } from "./workspace-do.ts";

export { WorkspaceDO } from "./workspace-do.ts";
export { HubDO } from "./hub-do.ts";
export { ShellDO } from "./shell-do.ts";
export { HomeDO } from "./home-do.ts";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  HUB: DurableObjectNamespace<HubDO>;
  SHELL: DurableObjectNamespace<ShellDO>;
  HOME: DurableObjectNamespace<HomeDO>;
  /** this deploy's version (wrangler.jsonc version_metadata): each one gets a fresh home room (home-do.ts) */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** this Worker as currently deployed, for a home room to ask which version that is */
  SELF?: Fetcher;
}

const router = createRouter();

export default {
  fetch: (req, env, ctx) => router.fetch(req, env, ctx),
  // GitHub refresh, demo reset, session pruning (src/workers/cron.ts; triggers in wrangler.jsonc)
  scheduled: (controller, env, ctx) => scheduled(controller, env, ctx),
} satisfies ExportedHandler<Env>;

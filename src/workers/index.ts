import type { HomeDO } from "./home-do.ts";
import type { HubDO } from "./hub-do.ts";
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
}

const router = createRouter();

export default {
  fetch: (req, env, ctx) => router.fetch(req, env, ctx),
  // Cron jobs (GitHub refresh, demo reset, session pruning) arrive with CF-26; no triggers are configured yet.
  async scheduled() {},
} satisfies ExportedHandler<Env>;

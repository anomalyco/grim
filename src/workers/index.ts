export { WorkspaceDO } from "./workspace-do.ts";
export { HubDO } from "./hub-do.ts";
export { ShellDO } from "./shell-do.ts";
export { HomeDO } from "./home-do.ts";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WORKSPACE: DurableObjectNamespace;
  HUB: DurableObjectNamespace;
  SHELL: DurableObjectNamespace;
  HOME: DurableObjectNamespace;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/server" && req.method === "GET") {
      return Response.json(
        { name: url.host, publicUrl: url.origin, google: false, devLogin: false, version: "workers-skeleton" },
        { headers: { "access-control-allow-origin": "*" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

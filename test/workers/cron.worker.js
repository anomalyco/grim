// Test Worker for test/workers/cron.test.ts: the production scheduled() handler (src/workers/cron.ts, what
// src/workers/index.ts exports) with a WorkspaceDO stand-in that records the refreshes and demo resets it is asked for.
import { DurableObject } from "cloudflare:workers";
import { scheduled } from "../../src/workers/cron.ts";

export class WorkspaceDO extends DurableObject {
  async refresh(repo, minIntervalMs) {
    const calls = (await this.ctx.storage.get("calls")) ?? [];
    calls.push({ name: this.ctx.id.name ?? null, id: repo.id, minIntervalMs });
    await this.ctx.storage.put("calls", calls);
    if (repo.id === "gh-acme-broken") throw new Error("GitHub said no");
  }

  async resetDemo() {
    const calls = (await this.ctx.storage.get("calls")) ?? [];
    calls.push({ name: this.ctx.id.name ?? null, reset: true });
    await this.ctx.storage.put("calls", calls);
  }

  async calls() {
    return (await this.ctx.storage.get("calls")) ?? [];
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/calls") return Response.json(await env.WORKSPACE.getByName(url.searchParams.get("id")).calls());
    return new Response("not found", { status: 404 });
  },
  scheduled,
};

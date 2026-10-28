import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.ts";

export class WorkspaceDO extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response("Not implemented", { status: 501 });
  }
}

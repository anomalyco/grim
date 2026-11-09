// The staging migration's import (docs/storage-v2.md §12) and the epoch bump after a point-in-time restore:
// POST /api/admin/import {workspace, notes, images} and POST /api/admin/bump-epochs {workspace}, with
// `Authorization: Bearer <IMPORT_TOKEN>`. Without IMPORT_TOKEN set they don't exist (404).
import { timingSafeEqual } from "node:crypto";
import type { Ctx } from "./ops.ts";
import type { ImportNote } from "./seams/workspace-host.ts";

export const importToken = () => process.env.IMPORT_TOKEN ?? "";

function authorized(req: Request): boolean {
  const want = importToken();
  const got = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  if (want.length < 32 || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleImport(req: Request, path: string, ctx: Ctx): Promise<Response> {
  if (req.method !== "POST" || !authorized(req)) return json({ error: "not found" }, 404);
  const b = (await req.json().catch(() => null)) as { workspace?: string; notes?: ImportNote[]; images?: Array<{ path: string; base64: string }> } | null;
  if (!b || typeof b.workspace !== "string") return json({ error: "workspace is required" }, 400);
  const repo = await ctx.repos.get(b.workspace);
  if (!repo) return json({ error: "workspace not found" }, 404);
  const ws = ctx.repos.host.get(repo.id);
  if (path === "/api/admin/import") {
    const made = await ws.importNotes({ ...repo, status: "ready" }, b.notes ?? [], b.images ?? []);
    const tree = await ws.tree({ ...repo, status: "ready" });
    return json({ made, notes: tree.length });
  }
  if (path === "/api/admin/bump-epochs") return json({ notes: await ws.bumpEpochs() });
  return json({ error: "not found" }, 404);
}

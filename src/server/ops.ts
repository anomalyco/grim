// File operations shared by the HTTP API and the agent shell, so people and agents get identical behavior.
import type * as Y from "yjs";
import { emit, notifyChange } from "./events.ts";
import { NotFoundError, type Participant, type RoomManager } from "./rooms.ts";
import { cleanPath, type RepoRow, type RepoService } from "./repos.ts";
import type { GitStore } from "./store/types.ts";
import { applyToYText, diffText } from "./textdiff.ts";
import { sha256 } from "./db.ts";

export interface Ctx {
  store: GitStore;
  rooms: RoomManager;
  repos: RepoService;
}

export class OpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const version = (text: string) => sha256(text).slice(0, 16);

export function path(p: string): string {
  const out = cleanPath(p);
  if (!out) throw new OpError(400, `invalid path: ${p}`);
  return out;
}

function writable(repo: RepoRow) {
  if (repo.read_only) throw new OpError(403, `${repo.id} is read-only`);
  if (repo.status !== "ready") throw new OpError(409, `${repo.id} is ${repo.status}`);
}

async function room(ctx: Ctx, repo: RepoRow, p: string) {
  try {
    return await ctx.rooms.get(repo.id, p, repo.branch);
  } catch (e) {
    if (e instanceof NotFoundError) throw new OpError(404, `${p} not found in ${repo.id}`);
    throw e;
  }
}

async function exists(ctx: Ctx, repo: RepoRow, p: string) {
  if (ctx.rooms.peek(repo.id, p)) return true;
  const head = await ctx.store.head(repo.id, repo.branch);
  return head !== null && (await ctx.store.readFile(repo.id, p, head)) !== null;
}

/** Replace the whole text with `next` as a minimal edit; returns the index after the last change. */
function replaceMinimal(text: Y.Text, next: string): number {
  return applyToYText(text, diffText(text.toString(), next));
}

const SAFE_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,128}$/;

export async function readFile(ctx: Ctx, repo: RepoRow, p: string, ref?: string) {
  p = path(p);
  if (ref && !SAFE_REF.test(ref)) throw new OpError(400, `invalid ref: ${ref}`);
  if (!ref) {
    const open = ctx.rooms.peek(repo.id, p);
    if (open) return { path: p, content: open.text.toString(), version: version(open.text.toString()), live: true };
    ref = (await ctx.store.head(repo.id, repo.branch)) ?? undefined;
  }
  const content = ref ? await ctx.store.readFile(repo.id, p, ref) : null;
  if (content === null) throw new OpError(404, `${p} not found`);
  return { path: p, content, version: version(content), live: false };
}

/** Image files served raw (to show images in notes), by extension. */
export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** Largest image served raw. */
export const MAX_RAW_BYTES = 10 * 1024 * 1024;

/** A repo-relative image path: no "..", no .git folders, no control characters, an image extension. */
export function imagePath(p: string): { path: string; type: string } {
  if (/[\x00-\x1f\x7f]/.test(p)) throw new OpError(400, "invalid path");
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (!parts.length || parts.some((s) => s === ".." || s.toLowerCase().startsWith(".git"))) throw new OpError(400, `invalid path: ${p}`);
  const path = parts.join("/");
  const type = IMAGE_TYPES[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ""];
  if (!type) throw new OpError(415, `${path} is not an image (${Object.keys(IMAGE_TYPES).join(", ")})`);
  return { path, type };
}

/** An image file's bytes at `ref` (default: the branch tip). Images aren't edited live, so there's no room text. */
export async function readRaw(ctx: Ctx, repo: RepoRow, p: string, ref?: string) {
  const { path, type } = imagePath(p);
  if (ref && !SAFE_REF.test(ref)) throw new OpError(400, `invalid ref: ${ref}`);
  ref ??= (await ctx.store.head(repo.id, repo.branch)) ?? undefined;
  const bytes = ref ? await ctx.store.readBlob(repo.id, path, ref, MAX_RAW_BYTES) : null;
  if (bytes === null) throw new OpError(404, `${path} not found`);
  return { path, type, bytes };
}

export async function createFile(ctx: Ctx, repo: RepoRow, p: string, content: string | undefined, actor: Participant) {
  writable(repo);
  p = path(p);
  if (await exists(ctx, repo, p)) throw new OpError(409, `${p} already exists`);
  const base = p.split("/").pop()!.replace(/\.(md|markdown|mdx)$/i, "");
  const r = await ctx.rooms.get(repo.id, p, repo.branch, "");
  const initial = content ?? `# ${base}\n`;
  r.agentEdit(actor, (t) => {
    // An empty file still needs an edit, so it is attributed to the actor and wakes watchers.
    t.insert(0, initial || " ");
    if (!initial) t.delete(0, 1);
    return t.length;
  });
  // Like any edit, the new file is in the crash log now and gets committed after the quiet period.
  emit({ type: "tree", repo: repo.id });
  return { path: p, version: version(r.text.toString()) };
}

/**
 * Apply the change `base` → `next` to the live text, keeping edits that others made since `base` was read.
 * Fails (409) if both touched the same or adjacent places. Used by the agent shell, which reads, computes and writes later.
 */
export async function patchFile(ctx: Ctx, repo: RepoRow, p: string, base: string, next: string, actor: Participant) {
  writable(repo);
  p = path(p);
  const r = await room(ctx, repo, p);
  const cur = r.text.toString();
  const theirs = cur === base ? [] : diffText(base, cur);
  const ours = diffText(base, next).map((s) => {
    const end = s.pos + s.del;
    let shift = 0;
    for (const t of theirs) {
      const tEnd = t.pos + t.del;
      const overlap = t.del > 0 && s.del > 0 ? t.pos < end && s.pos < tEnd : t.pos <= end && s.pos <= tEnd;
      if (overlap) throw new OpError(409, `${p} was changed by someone else at the same place since you read it; read it again and redo the edit`);
      if (tEnd <= s.pos) shift += t.ins.length - t.del;
    }
    return { ...s, pos: s.pos + shift };
  });
  r.agentEdit(actor, (t) => applyToYText(t, ours));
  return { path: p, version: version(r.text.toString()) };
}

/** Append text to the end of the live text, exactly as given (like a shell's `>>`). */
export async function appendText(ctx: Ctx, repo: RepoRow, p: string, text: string, actor: Participant) {
  writable(repo);
  p = path(p);
  const r = await room(ctx, repo, p);
  r.agentEdit(actor, (t) => {
    t.insert(t.length, text);
    return t.length;
  });
  return { path: p, version: version(r.text.toString()) };
}

export async function restoreFile(ctx: Ctx, repo: RepoRow, p: string, sha: string, actor: Participant) {
  writable(repo);
  p = path(p);
  const old = await ctx.store.readFile(repo.id, p, sha);
  if (old === null) throw new OpError(404, `${p} not found at ${sha}`);
  const r = await room(ctx, repo, p);
  r.agentEdit(actor, (t) => replaceMinimal(t, old));
  return { path: p };
}

async function commitTreeChange(ctx: Ctx, repo: RepoRow, changes: Array<{ path: string; content?: string; delete?: boolean }>, message: string, actor: Participant) {
  for (let i = 0; i < 5; i++) {
    const head = await ctx.store.head(repo.id, repo.branch);
    const res = await ctx.store.commit({ repo: repo.id, branch: repo.branch, expectedHead: head, changes, message, author: { name: actor.name, email: actor.email } });
    if (res.ok) return res.sha;
  }
  throw new OpError(409, "could not commit: the branch keeps moving");
}

export async function deleteFile(ctx: Ctx, repo: RepoRow, p: string, actor: Participant) {
  writable(repo);
  p = path(p);
  const open = ctx.rooms.peek(repo.id, p);
  const head = await ctx.store.head(repo.id, repo.branch);
  if (!head || (await ctx.store.readFile(repo.id, p, head)) === null) {
    if (!open) throw new OpError(404, `${p} not found`);
    open.closeWith("deleted");
    notifyChange(repo.id, p);
    emit({ type: "tree", repo: repo.id });
    return { ok: true };
  }
  // Commit first: closing the room drops its unsaved edits, so only do it once the delete is in Git.
  await commitTreeChange(ctx, repo, [{ path: p, delete: true }], `Delete ${p}`, actor);
  open?.closeWith("deleted");
  await ctx.repos.onPush(repo.id);
  return { ok: true };
}

export async function renameFile(ctx: Ctx, repo: RepoRow, from: string, to: string, actor: Participant) {
  writable(repo);
  from = path(from);
  to = path(to);
  if (from === to) return { path: to };
  if (await exists(ctx, repo, to)) throw new OpError(409, `${to} already exists`);
  const open = ctx.rooms.peek(repo.id, from);
  // Commit pending edits first, so they are attributed to their authors rather than to the rename.
  if (open?.dirty) await open.flush();
  const head = await ctx.store.head(repo.id, repo.branch);
  const atHead = head ? await ctx.store.readFile(repo.id, from, head) : null;
  const content = open && !open.closed ? open.text.toString() : atHead;
  if (content === null) throw new OpError(404, `${from} not found`);
  const changes = [...(atHead !== null ? [{ path: from, delete: true }] : []), { path: to, content }];
  await commitTreeChange(ctx, repo, changes, `Rename ${from} to ${to}`, actor);
  open?.closeWith("renamed", { to });
  await ctx.repos.onPush(repo.id);
  return { path: to };
}

export async function history(ctx: Ctx, repo: RepoRow, p: string | undefined, limit = 50) {
  return ctx.store.history(repo.id, repo.branch, p ? path(p) : undefined, Math.min(Math.max(limit, 1), 200));
}

export async function diff(ctx: Ctx, repo: RepoRow, sha: string, p?: string) {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new OpError(400, "invalid sha");
  try {
    return await ctx.store.diff(repo.id, sha, p ? path(p) : undefined);
  } catch {
    throw new OpError(404, `commit ${sha} not found`);
  }
}

export async function search(ctx: Ctx, repo: RepoRow, q: string) {
  if (!q.trim()) return { hits: [] };
  const head = await ctx.store.head(repo.id, repo.branch);
  return head ? ctx.store.search(repo.id, head, q, 100) : { hits: [] };
}

// File operations shared by the HTTP API and the agent shell, so people and agents get identical behavior.
import type * as Y from "yjs";
import { emit, notifyChange } from "./events.ts";
import { authorOf, NotFoundError, type Participant, type RoomManager } from "./rooms.ts";
import { cleanPath, type RepoRow, type RepoService } from "./repos.ts";
import { FileTooLargeError, type GitStore } from "./store/types.ts";
import { applyToYText, diffText, rebaseSplices } from "./textdiff.ts";
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

/** Largest image that can be uploaded (the same as what's served raw). */
export const MAX_UPLOAD_BYTES = MAX_RAW_BYTES;

const ascii = (b: Uint8Array, at: number, s: string) => {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/**
 * The image type `bytes` really are, from their magic bytes (an extension in IMAGE_TYPES), or null. SVG is
 * UTF-8 text whose first element (after an XML declaration, comments and a doctype) is <svg>.
 */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 8 && ascii(b, 0, "\x89PNG\r\n\x1a\n")) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 6 && (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) return "gif";
  if (b.length >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "webp";
  if (b.length >= 16 && ascii(b, 4, "ftyp")) {
    // ISO-BMFF: the major brand, then compatible brands up to the end of the ftyp box
    const size = Math.min(b.length, ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0 || 0);
    for (let at = 8; at + 4 <= Math.max(16, size); at += 4) {
      if (at === 12) continue; // minor version
      if (ascii(b, at, "avif") || ascii(b, at, "avis")) return "avif";
    }
    return null;
  }
  if (b.length >= 26 && ascii(b, 0, "BM")) return "bmp";
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4] || b[5])) return "ico";
  return isSvg(b) ? "svg" : null;
}

function isSvg(b: Uint8Array): boolean {
  let text: string;
  try {
    // (stream: a character cut at the prefix's end isn't an error)
    text = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, 64 * 1024), { stream: true });
  } catch {
    return false;
  }
  if (text.includes("\0")) return false;
  let s = text.replace(/^\uFEFF/, "");
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "").replace(/^<\?xml\s[^>]*\?>/, "").replace(/^<!--[\s\S]*?-->/, "").replace(/^<!DOCTYPE\s+svg[^>[]*>/i, "");
    if (s === before) break;
  }
  return /^<svg[\s>/]/.test(s);
}

/**
 * The file name an upload is stored under: the original's last path part without control characters or
 * leading dots, its extension made to match the sniffed type `ext` (kept when it already does).
 */
export function uploadName(raw: string, ext: string): { name: string; stem: string; ext: string } {
  let name = (raw.split(/[/\\]/).pop() ?? "").normalize("NFC").replace(/[\x00-\x1f\x7f]/g, "").trim();
  const m = /^(.*)\.([A-Za-z0-9]{1,5})$/.exec(name);
  let stem = name;
  let e = ext;
  if (m && IMAGE_TYPES[m[2]!.toLowerCase()]) {
    stem = m[1]!;
    if (IMAGE_TYPES[m[2]!.toLowerCase()] === IMAGE_TYPES[ext]) e = m[2]!;
  }
  stem = [...stem.trim().replace(/[.\s]+$/, "")].slice(0, 100).join("").trim().replace(/^\.+/, "") || "image";
  name = `${stem}.${e}`;
  return { name, stem, ext: e };
}

/**
 * Percent-encode what would end or confuse a Markdown link URL (whitespace, control characters, parentheses,
 * `%`, `<`, `>`) or be read as a query or fragment (`?`, `#`), like the native app.
 */
export function encodeLinkPath(s: string): string {
  return [...s].map((ch) => (/[\s\p{Cc}()%<>?#]/u.test(ch) ? [...new TextEncoder().encode(ch)].map((x) => `%${x.toString(16).toUpperCase().padStart(2, "0")}`).join("") : ch)).join("");
}

/** Brackets and backslashes in alt text are escaped so the image still parses. */
export const escapeAlt = (s: string) => s.replace(/[[\]\\]/g, "\\$&").replace(/\n/g, " ");

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Store an uploaded image in `images/` next to note `notePath`, committed at once by `actor` ("Add <path>"). The
 * name is kept; another file with that name gets `name-2.png`, `name-3.png`…; an identical file already there is
 * reused (nothing committed). Returns the repo path and the Markdown that shows it in the note.
 */
export async function uploadImage(ctx: Ctx, repo: RepoRow, notePath: string, filename: string, bytes: Uint8Array, actor: Participant) {
  writable(repo);
  const note = path(notePath);
  if (!bytes.length) throw new OpError(400, "the file is empty");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new OpError(413, `images can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new OpError(415, `not an image (${Object.keys(IMAGE_TYPES).join(", ")})`);
  const { name, stem, ext } = uploadName(filename, sniffed);
  const dir = [...note.split("/").slice(0, -1), "images"].join("/");
  const candidate = (n: number) => imagePath(`${dir}/${n === 1 ? name : `${stem}-${n}.${ext}`}`).path;
  const result = (p: string, reused: boolean) => {
    const markdownPath = encodeLinkPath(p.slice(dir.length - "images".length));
    return { path: p, markdownPath, markdown: `![${escapeAlt(stem)}](${markdownPath})`, reused };
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const head = await ctx.store.head(repo.id, repo.branch);
    let target: string | null = null;
    for (let n = 1; n <= 1000 && !target; n++) {
      const cand = candidate(n);
      let existing: Uint8Array | null | "other" = null;
      if (head) {
        try {
          existing = await ctx.store.readBlob(repo.id, cand, head, MAX_UPLOAD_BYTES);
        } catch (e) {
          if (!(e instanceof FileTooLargeError)) throw e;
          existing = "other";
        }
      }
      if (existing === null) target = cand;
      else if (existing !== "other" && sameBytes(existing, bytes)) return result(cand, true);
    }
    if (!target) throw new OpError(409, `too many images named ${name}`);
    const res = await ctx.store.writeBlob({ repo: repo.id, branch: repo.branch, expectedHead: head, path: target, bytes, message: `Add ${target}`, author: authorOf(actor) });
    if (res.ok) {
      await ctx.repos.onPush(repo.id);
      return result(target, false);
    }
  }
  throw new OpError(409, "could not commit: the branch keeps moving");
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
  const ours = rebaseSplices(theirs, diffText(base, next));
  if (!ours) throw new OpError(409, `${p} was changed by someone else at the same place since you read it; read it again and redo the edit`);
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
    const res = await ctx.store.commit({ repo: repo.id, branch: repo.branch, expectedHead: head, changes, message, author: authorOf(actor) });
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

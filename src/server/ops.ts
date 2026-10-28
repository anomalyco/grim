// File operations shared by the HTTP API and the agent shell, so people and agents get identical behavior. They run
// in the workspace's runtime (workspace.ts), reached through the WorkspaceHost (in-process on Bun, a Durable Object
// on Workers); this module keeps the path/image helpers and the (ctx, repo, …) entry points the callers use.
import type { Participant, RoomManager } from "./rooms.ts";
import { cleanPath, type RepoRow, type RepoService } from "./repos.ts";
import type { GitStore } from "./store/types.ts";
import { sha256 } from "./ids.ts";

export interface Ctx {
  store: GitStore;
  rooms: RoomManager;
  repos: RepoService;
}

export class OpError extends Error {
  override name = "OpError";
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

/** A folder path, checked like a note path (but without the .md). */
export function dirPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (/[\x00-\x1f\x7f]/.test(p) || !parts.length || parts.some((s) => s === ".." || s.toLowerCase().startsWith(".git"))) throw new OpError(400, `invalid folder: ${p}`);
  return parts.join("/");
}

export function writable(repo: RepoRow) {
  if (repo.read_only) throw new OpError(403, `${repo.id} is read-only`);
  if (repo.status !== "ready") throw new OpError(409, `${repo.id} is ${repo.status}`);
}

export const SAFE_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,128}$/;

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

/** The workspace's runtime, through the host. */
const ws = (ctx: Ctx, repo: RepoRow) => ctx.repos.host.get(repo.id);

export const readFile = (ctx: Ctx, repo: RepoRow, p: string, ref?: string) => ws(ctx, repo).readFile(repo, p, ref);

/** An image file's bytes at `ref` (default: the branch tip). */
export const readRaw = (ctx: Ctx, repo: RepoRow, p: string, ref?: string) => ws(ctx, repo).readRaw(repo, p, ref);

/**
 * Store an uploaded image in `images/` next to note `notePath`, committed at once by `actor`; an identical file
 * already there is reused. Returns the repo path and the Markdown that shows it in the note.
 */
export const uploadImage = (ctx: Ctx, repo: RepoRow, notePath: string, filename: string, bytes: Uint8Array, actor: Participant) =>
  ws(ctx, repo).uploadImage(repo, notePath, filename, bytes, actor);

export const createFile = (ctx: Ctx, repo: RepoRow, p: string, content: string | undefined, actor: Participant) => ws(ctx, repo).createFile(repo, p, content, actor);

/** Apply the change `base` → `next` to the live text, keeping others' edits since `base` was read (409 on overlap). */
export const patchFile = (ctx: Ctx, repo: RepoRow, p: string, base: string, next: string, actor: Participant) => ws(ctx, repo).patchFile(repo, p, base, next, actor);

/** Append text to the end of the live text, exactly as given (like a shell's `>>`). */
export const appendText = (ctx: Ctx, repo: RepoRow, p: string, text: string, actor: Participant) => ws(ctx, repo).appendText(repo, p, text, actor);

export const restoreFile = (ctx: Ctx, repo: RepoRow, p: string, sha: string, actor: Participant) => ws(ctx, repo).restoreFile(repo, p, sha, actor);

export const deleteFile = (ctx: Ctx, repo: RepoRow, p: string, actor: Participant) => ws(ctx, repo).deleteFile(repo, p, actor);

/** Rename a note (one commit); renames in a workspace run one at a time. */
export const renameFile = (ctx: Ctx, repo: RepoRow, from: string, to: string, actor: Participant, opts: { ifUntitled?: boolean } = {}) =>
  ws(ctx, repo).renameFile(repo, from, to, actor, opts);

/** Rename folder `from` to `to`: every file under it moves, in one commit. */
export const renameFolder = (ctx: Ctx, repo: RepoRow, from: string, to: string, actor: Participant) => ws(ctx, repo).renameFolder(repo, from, to, actor);

/** Delete folder `dir` and everything under it, in one commit. */
export const deleteFolder = (ctx: Ctx, repo: RepoRow, dir: string, actor: Participant) => ws(ctx, repo).deleteFolder(repo, dir, actor);

export const history = (ctx: Ctx, repo: RepoRow, p: string | undefined, limit = 50) => ws(ctx, repo).history(repo, p, limit);

export const diff = (ctx: Ctx, repo: RepoRow, sha: string, p?: string) => ws(ctx, repo).diff(repo, sha, p);

export const search = (ctx: Ctx, repo: RepoRow, q: string) => ws(ctx, repo).search(repo, q);

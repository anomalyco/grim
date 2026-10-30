// Content negotiation on the app's note URLs (/app/<workspace>/<note path>): a browser (Accept names text/html) gets
// the app as before; anything else (curl's */*, text/markdown, text/plain) gets the note itself: its Markdown as the
// app shows it (live edits not saved yet included), a folder's notes one path per line, an image's bytes. What it
// reads is exactly what GET /api/workspace/:id/file, /tree and /raw answer anyone who isn't signed in.
import { rawResponse } from "./api.ts";
import { config } from "./config.ts";
import { isDemoRoom } from "./demo-rooms.ts";
import { DEMO_ID } from "./demo.ts";
import { errStatus } from "./errors.ts";
import * as ops from "./ops.ts";
import type { Ctx } from "./ops.ts";
import { cleanPath } from "./repos.ts";
import { isUnfurler } from "./share-meta.ts";

/** The same URL answers HTML or Markdown: caches must key on Accept, and live text is never stored. */
const NEGOTIATED = { vary: "Accept", "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** /app/<workspace>[/<path>]: the URLs that answer Markdown to non-browsers (/app alone is always the app). */
const NOTE_URL = /^\/app\/([^/]+)(?:\/(.*))?$/;

export function isNoteUrl(pathname: string): boolean {
  return NOTE_URL.test(pathname);
}

/**
 * Whether a request for a note URL gets the app: its Accept names text/html (or XHTML) with a q above 0, as every
 * browser navigation does. `*\/*` alone doesn't count (curl). Link-preview fetchers (Slackbot, Twitterbot, …) get the
 * app too, for its generic share tags (share-meta.ts). `?raw=1` asks for the note even from a browser.
 */
export function wantsApp(req: Request, url: URL): boolean {
  if (url.searchParams.get("raw") === "1") return false;
  if (isUnfurler(req)) return true;
  for (const part of (req.headers.get("accept") ?? "").toLowerCase().split(",")) {
    const [type, ...params] = part.split(";").map((s) => s.trim());
    if (type !== "text/html" && type !== "application/xhtml+xml") continue;
    const q = params.find((p) => p.startsWith("q="));
    if (!q || Number(q.slice(2)) > 0) return true;
  }
  return false;
}

/** The app's HTML response for a note URL, with `Vary: Accept` (the same URL also answers Markdown). */
export function withVaryAccept(res: Response): Response {
  const out = new Response(res.body, res);
  const vary = out.headers.get("vary");
  if (!vary || !/(^|,)\s*accept\s*(,|$)/i.test(vary)) out.headers.set("vary", vary ? `${vary}, Accept` : "Accept");
  return out;
}

function text(body: string, status = 200, type = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "content-type": type, ...NEGOTIATED } });
}

const notFound = (what: string) => text(`Not found: ${what}\n`, 404);

/** GET/HEAD of a note URL from a non-browser (see wantsApp). */
export async function noteUrlResponse(url: URL, ctx: Ctx): Promise<Response> {
  const m = NOTE_URL.exec(url.pathname)!;
  let id: string;
  let path: string;
  // decoded and cleaned as the client's parseRoute does
  try {
    id = decodeURIComponent(m[1]!);
    path = (m[2] ?? "").split("/").filter((s) => s && s !== "." && s !== "..").map(decodeURIComponent).join("/");
  } catch {
    return text("Bad request: malformed URL\n", 400);
  }
  // Demo rooms belong to the people in them (POST /api/demo/room, from the browser): there is none to read here.
  if (id === DEMO_ID || isDemoRoom(id))
    return config.signIn ? text("The demo has no fixed notes to fetch: each visitor gets a room of their own in the browser (open this URL in a browser).\n", 404) : notFound(id);
  if (id === "." || id === "..") return notFound(id);
  try {
    const repo = await ctx.repos.get(id);
    if (!repo) return notFound(id);
    if (repo.status !== "ready") return text(repo.status === "importing" ? `${repo.id} is still importing\n` : `${repo.id}: ${repo.error ?? repo.status}\n`, 409);
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
    // an image the notes show: its bytes, served as the raw route does (its type, never sniffed; SVGs sandboxed)
    if (ops.IMAGE_TYPES[ext]) {
      const res = rawResponse(await ops.readRaw(ctx, repo, path));
      res.headers.set("vary", "Accept");
      return res;
    }
    if (path) {
      // a note, with .md added when the path has no Markdown extension (as the app's links resolve); the live text
      const note = cleanPath(path);
      if (!note) return notFound(path);
      const read = await ops.readFile(ctx, repo, note).catch((e: unknown) => {
        if (errStatus(e) === 404) return null;
        throw e;
      });
      if (read) return text(read.content, 200, "text/markdown; charset=utf-8");
    }
    // a folder (or the workspace's root): its notes, one path per line
    const prefix = path ? path.replace(/\/+$/, "") + "/" : "";
    const files = (await ctx.repos.tree(repo)).filter((f) => f.startsWith(prefix));
    if (!files.length) return path ? notFound(path) : text("");
    return text(files.join("\n") + "\n");
  } catch (e) {
    const status = errStatus(e);
    if (status === 404 || status === 415) return notFound(path || id);
    if (status !== undefined && status < 500) return text(`${e instanceof Error ? e.message : "error"}\n`, status);
    throw e;
  }
}

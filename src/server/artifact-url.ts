// Files on note URLs, and web artifacts rendered for browsers. A note URL whose last segment has an extension other
// than Markdown's (/app/<workspace>/artifacts/report/index.html, …/images/a.png; shared/paths.ts) names a file:
// - an artifact (artifacts/…): a browser is redirected to its copy on the artifact origin (ARTIFACT_URL, e.g.
//   https://art.staging.grimnotes.app; without one, this origin), /_art/<workspace>/<token>/<path>, where it renders
//   with its own type. The token signs the workspace and an expiry (TOKEN_TTL_S), so relative assets (CSS, JS, images,
//   fetch()) resolve beside it and are authorised without cookies. Everything served there is sandboxed by CSP
//   (`sandbox allow-scripts …`, never allow-same-origin): an artifact's scripts run in an opaque origin, with no
//   cookies, storage or API of Grim's, on an origin that has none anyway. Anything else gets a download, as the raw API's.
// - an image: inline, as the raw route serves it.
// Who may: whoever may read the workspace's notes (note-url.ts), checked on the note URL before a token is made.
import { artifactResponse, rawResponse } from "./api.ts";
import { config } from "./config.ts";
import { isDemoRoom } from "./demo-rooms.ts";
import { DEMO_ID } from "./demo.ts";
import { errStatus } from "./errors.ts";
import * as ops from "./ops.ts";
import type { Ctx } from "./ops.ts";
import type { RepoRow } from "./repos.ts";
import { wantsApp } from "./note-url.ts";
import { artifactType, underArtifacts } from "../shared/artifacts.ts";
import { extensionOf, isFilePath } from "../shared/paths.ts";

/** How long an artifact link works; a page opened after that is sent back through its note URL for a new one. */
export const TOKEN_TTL_S = 3600;
/** The path prefix of rendered artifacts: /_art/<workspace>/<token>/<path>. */
const ART = /^\/_art\/([^/]+)\/([^/]+)\/(.*)$/;
/** What an artifact page may do: scripts, forms, popups and dialogs in an opaque origin of its own. */
export const ARTIFACT_SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const NOTE_URL = /^\/app\/([^/]+)\/(.+)$/;

/** Whether a note URL names a file rather than a note (its last segment has a non-Markdown extension). */
export function isFileUrl(pathname: string): boolean {
  const m = NOTE_URL.exec(pathname);
  if (!m) return false;
  try {
    return isFilePath(decodeURIComponent(m[2]!.replace(/\/+$/, "")));
  } catch {
    return false;
  }
}

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const appUrl = (ws: string, path: string) => `${config.publicUrl}/app/${encodeURIComponent(ws)}/${enc(path)}`;

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
}

/** The artifact origin, when it's another host than this server's. */
function artifactOrigin(): string | null {
  return config.artifactUrl ? new URL(config.artifactUrl).origin : null;
}

/** Whether a request came to the artifact origin (which answers artifacts and the review kit, nothing else). */
export function isArtifactHost(url: URL): boolean {
  const o = artifactOrigin();
  return !!o && new URL(o).host === url.host;
}

// ---- tokens ----

let keyPromise: Promise<CryptoKey> | null = null;

/**
 * The links' HMAC key: ARTIFACT_KEY, else derived from the Code Storage key (a secret every hosted deployment has),
 * else random per process (a single Bun server).
 */
function key(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const material = process.env.ARTIFACT_KEY?.trim() || config.codeStorage.key || crypto.getRandomValues(new Uint8Array(32));
    const bytes = typeof material === "string" ? new TextEncoder().encode(material) : material;
    const root = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const derived = await crypto.subtle.sign("HMAC", root, new TextEncoder().encode("grim artifact links v1"));
    return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  })();
  return keyPromise;
}

async function sign(ws: string, exp: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(`${ws}\n${exp}`)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

/** A token for workspace `ws`: `<expiry, base 36 seconds>.<signature>`. */
export async function artifactToken(ws: string, now = Date.now()): Promise<string> {
  const exp = (Math.floor(now / 1000) + TOKEN_TTL_S).toString(36);
  return `${exp}.${await sign(ws, exp)}`;
}

/** Whether `token` is a valid, unexpired token for `ws`. */
export async function checkToken(ws: string, token: string, now = Date.now()): Promise<boolean> {
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^[0-9a-z]{1,10}$/.test(exp) || parseInt(exp, 36) * 1000 < now) return false;
  const want = await sign(ws, exp);
  let diff = want.length ^ sig.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (sig.charCodeAt(i) || 0);
  return diff === 0;
}

/** Where workspace `ws`'s artifact `path` renders: the artifact origin (or this one), with a fresh token. */
export async function artifactLink(ws: string, path: string): Promise<string> {
  return `${artifactOrigin() ?? config.publicUrl}/_art/${encodeURIComponent(ws)}/${await artifactToken(ws)}/${enc(path)}`;
}

// ---- the note URL of a file ----

/** The workspace a file URL reads, or the response refusing it (as note URLs refuse). */
async function workspaceFor(ctx: Ctx, id: string): Promise<RepoRow | Response> {
  if (id === DEMO_ID || isDemoRoom(id) || id === "." || id === "..") return text(`Not found: ${id}\n`, 404);
  const repo = await ctx.repos.get(id);
  if (!repo) return text(`Not found: ${id}\n`, 404);
  if (repo.status !== "ready") return text(repo.status === "importing" ? `${repo.id} is still importing\n` : `${repo.id}: ${repo.error ?? repo.status}\n`, 409);
  return repo;
}

/**
 * GET/HEAD /app/<workspace>/<file> (isFileUrl). A browser: an artifact redirects to where it renders, an image is
 * served inline. Anything else (curl, agents): an artifact as a download (artifactResponse), an image's bytes.
 */
export async function fileUrlResponse(req: Request, url: URL, ctx: Ctx): Promise<Response> {
  const m = NOTE_URL.exec(url.pathname)!;
  let id: string;
  let path: string;
  try {
    id = decodeURIComponent(m[1]!);
    path = m[2]!.split("/").filter((s) => s && s !== "." && s !== "..").map(decodeURIComponent).join("/");
  } catch {
    return text("Bad request: malformed URL\n", 400);
  }
  try {
    const repo = await workspaceFor(ctx, id);
    if (repo instanceof Response) return repo;
    const browser = wantsApp(req, url);
    if (underArtifacts(path)) {
      if (!artifactType(path)) return text(`Not found: ${path}\n`, 404);
      if (!browser) return artifactResponse(await ctx.repos.host.get(repo.id).readArtifact(repo, path));
      // (read first, so a missing file is a 404 here rather than on the artifact origin)
      await ctx.repos.host.get(repo.id).readArtifact(repo, path);
      return new Response(null, { status: 302, headers: { location: await artifactLink(repo.id, path), "cache-control": "no-store", "referrer-policy": "no-referrer", vary: "Accept" } });
    }
    if (ops.IMAGE_TYPES[extensionOf(path)]) {
      const res = rawResponse(await ops.readRaw(ctx, repo, path));
      res.headers.set("vary", "Accept");
      return res;
    }
    return text(`Not found: ${path}\n`, 404);
  } catch (e) {
    const status = errStatus(e);
    if (status === 404 || status === 415) return text(`Not found: ${path}\n`, 404);
    if (status !== undefined && status < 500) return text(`${e instanceof Error ? e.message : "error"}\n`, status);
    throw e;
  }
}

// ---- the artifact origin ----

/** What every file served to render gets: its type, never sniffed, in the sandbox, readable by its pages' fetch(). */
function rendered(type: string, bytes: Uint8Array<ArrayBuffer> | null): Response {
  return new Response(bytes, {
    headers: {
      "content-type": type,
      "content-security-policy": ARTIFACT_SANDBOX,
      "x-content-type-options": "nosniff",
      // the page's opaque origin reads its own files with fetch(); no cookies are involved (the token is in the path)
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      // the token is a capability: never sent on in a Referer
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-cache",
      "x-robots-tag": "noindex",
    },
  });
}

/**
 * Requests for rendered artifacts and the review kit: everything on the artifact origin, and /_art/ and /_kit/ here
 * (/_art/ only when there's no separate artifact origin). null: not one of those.
 */
export async function artifactHostResponse(req: Request, url: URL, ctx: Ctx, staticFile: (req: Request, url: URL) => Promise<Response>): Promise<Response | null> {
  const p = url.pathname;
  const onArtHost = isArtifactHost(url);
  if (!onArtHost && !p.startsWith("/_art/") && !p.startsWith("/_kit/")) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed\n", 405);
  // Grim's review kit (native/crates/app/kit, copied to dist/_kit by the client build), which artifacts load from /_kit/
  if (/^\/_kit\/review\.(js|css)$/.test(p)) {
    const kit = new URL(`/dist${p}`, url);
    const res = await staticFile(new Request(kit, { method: req.method, headers: req.headers }), kit);
    const out = new Response(res.body, res);
    out.headers.set("access-control-allow-origin", "*");
    out.headers.set("cross-origin-resource-policy", "cross-origin");
    return out;
  }
  const m = ART.exec(p);
  if (!m || (!onArtHost && artifactOrigin())) return onArtHost && p === "/" ? Response.redirect(config.publicUrl + "/", 302) : text("Not found\n", 404);
  let id: string;
  let path: string;
  try {
    id = decodeURIComponent(m[1]!);
    path = m[3]!.split("/").filter((s) => s && s !== "." && s !== "..").map(decodeURIComponent).join("/");
  } catch {
    return text("Bad request: malformed URL\n", 400);
  }
  if (!(await checkToken(id, m[2]!))) {
    // an expired (or bad) link: a page goes back through its note URL, which checks access and makes a new one
    if (wantsApp(req, url) || req.headers.get("sec-fetch-dest") === "document") return Response.redirect(appUrl(id, path), 302);
    return text("Forbidden: this artifact link has expired; open it again from Grim\n", 403, { "access-control-allow-origin": "*" });
  }
  try {
    const repo = await workspaceFor(ctx, id);
    if (repo instanceof Response) return repo;
    // a folder: its index.html (redirected, so the page's relative links resolve inside it)
    if (underArtifacts(path) && !extensionOf(path)) return new Response(null, { status: 302, headers: { location: `/_art/${m[1]}/${m[2]}/${enc(path)}/index.html`, "cache-control": "no-store" } });
    if (underArtifacts(path)) {
      if (!artifactType(path)) return text(`Not found: ${path}\n`, 404);
      const r = await ctx.repos.host.get(repo.id).readArtifact(repo, path);
      return rendered(r.type, req.method === "HEAD" ? null : r.bytes);
    }
    // an image beside the notes
    if (ops.IMAGE_TYPES[extensionOf(path)]) {
      const r = await ops.readRaw(ctx, repo, path);
      return rendered(r.type, req.method === "HEAD" ? null : r.bytes);
    }
    // a link from an artifact to a note: the note in the app
    if (path && !isFilePath(path)) return Response.redirect(appUrl(repo.id, path), 302);
    return text(`Not found: ${path}\n`, 404);
  } catch (e) {
    const status = errStatus(e);
    if (status === 404 || status === 415) return text(`Not found: ${path}\n`, 404);
    if (status !== undefined && status < 500) return text(`${e instanceof Error ? e.message : "error"}\n`, status);
    throw e;
  }
}

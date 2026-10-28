// Cache busting for the client: the HTML (never cached) links app.css, editor.css and dist/main.js with ?v=<content
// hash>; those URLs, Bun's content-hashed chunks (dist/<name>-<hash>.js) and the hashed wasm dirs are cached forever.
// So a deploy is picked up on the next page load without a hard reload.
// The build (scripts/build-client.ts → writeStaticArtifacts) also writes what a static host needs to serve the app
// without the server: gzip copies of main.js and the CSS, the final index.html, and Cloudflare _headers/_redirects.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";

export const IMMUTABLE = "public, max-age=31536000, immutable";

/** Headers of the app's HTML (/, /app, /app/*, /start, /scratch). */
export const HTML_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

/** URL paths that serve the app's HTML. */
export function isAppPage(path: string): boolean {
  return path === "/" || path === "/app" || path.startsWith("/app/") || path === "/start" || path === "/scratch";
}

/** URL path → file (relative to the project root) of the assets the HTML links with a version. */
export const VERSIONED: Record<string, string> = {
  "/app.css": "src/client/app.css",
  "/editor.css": "src/client/editor-rs/editor.css",
  "/dist/main.js": "dist/main.js",
};

const versions = new Map<string, { stamp: string; v: string }>();

/** A short content hash of `file`, recomputed only when its size or mtime changes (a rebuild while running). */
export async function fileVersion(file: string): Promise<string | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  const st = await f.stat();
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = versions.get(file);
  if (hit?.stamp === stamp) return hit.v;
  const v = new Bun.CryptoHasher("sha256").update(await f.arrayBuffer()).digest("hex").slice(0, 12);
  versions.set(file, { stamp, v });
  return v;
}

/** The app's HTML with each versioned asset's URL carrying ?v=<hash>. */
export async function indexHtml(root: string): Promise<string> {
  let html = await Bun.file(join(root, "src/client/index.html")).text();
  for (const [url, rel] of Object.entries(VERSIONED)) {
    const v = await fileVersion(join(root, rel));
    if (v) html = html.replaceAll(`"${url}"`, `"${url}?v=${v}"`);
  }
  return html;
}

/** Cache headers for a versioned asset: forever when `?v=` is its current hash, else revalidate (an old or bare URL). */
export async function versionedCache(root: string, path: string, url: URL): Promise<string> {
  const v = url.searchParams.get("v");
  return v && v === (await fileVersion(join(root, VERSIONED[path]!))) ? IMMUTABLE : "no-cache";
}

/** dist/ files that never change under their name: fonts, the hashed wasm dirs, Bun's content-hashed chunks. */
export function immutableDist(path: string): boolean {
  return /^\/dist\/fonts\//.test(path) || /^\/dist\/(editor-rs|highlights)\/[0-9a-f]{16}\//.test(path) || /^\/dist\/[\w.-]+-[a-z0-9]{8}\.(js|css)(\.map)?$/.test(path);
}

/** dist/ files that the build writes beside the bundle; the versioned assets' .gz copies are read from here. */
const GZ: Record<string, string> = { "/app.css": "dist/app.css.gz", "/editor.css": "dist/editor.css.gz", "/dist/main.js": "dist/main.js.gz" };

async function fileResponse(path: string, headers: Record<string, string>, gz: string | null, req: Request): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const base: Record<string, string> = { "x-content-type-options": "nosniff", "cache-control": "no-cache", ...headers };
  if (gz && (await Bun.file(gz).exists())) {
    // a .gz older than its file is left from an earlier build (e.g. under --watch): never serve it
    const fresh = (await Bun.file(gz).stat()).mtimeMs >= (await file.stat()).mtimeMs;
    if (fresh) {
      base.vary = "accept-encoding";
      if (/\bgzip\b/.test(req.headers.get("accept-encoding") ?? ""))
        return new Response(Bun.file(gz), { headers: { ...base, "content-encoding": "gzip", "content-type": file.type } });
    }
  }
  return new Response(file, { headers: base });
}

/**
 * The static part of the router: old /r/… links, the app's HTML, the versioned assets (app.css, editor.css,
 * dist/main.js) and dist/ files, sending a build-time .gz copy when the client accepts gzip. Returns null for any
 * other path. `root` is the project root; `pathname` the URL's (still encoded) path.
 */
export async function staticResponse(req: Request, root: string, pathname: string): Promise<Response | null> {
  const p = pathname;
  if (p === "/r" || p.startsWith("/r/")) return new Response(null, { status: 308, headers: { location: "/app" + p.slice(2) + new URL(req.url).search } });
  if (isAppPage(p)) return new Response(await indexHtml(root), { headers: HTML_HEADERS });
  // linked with ?v=<content hash>, cached forever under that URL
  if (VERSIONED[p]) return fileResponse(join(root, VERSIONED[p]), { "cache-control": await versionedCache(root, p, new URL(req.url)) }, join(root, GZ[p]!), req);
  if (p.startsWith("/dist/")) {
    const dist = join(root, "dist");
    let file: string;
    try {
      file = normalize(join(dist, decodeURIComponent(p.slice("/dist/".length))));
    } catch {
      return new Response("Not found", { status: 404 });
    }
    if (!file.startsWith(dist + "/")) return new Response("Not found", { status: 404 });
    // fonts, the content-hashed wasm (the engine in dist/editor-rs/<hash>/, the code highlighter in
    // dist/highlights/<hash>/) and Bun's hashed chunks never change
    return fileResponse(file, immutableDist(p) ? { "cache-control": IMMUTABLE } : {}, file + ".gz", req);
  }
  return null;
}

/** Cloudflare `_headers` path patterns for the HTML (CF matches a lone splat at the end). */
const HTML_PATTERNS = ["/", "/app", "/app/*", "/start", "/scratch"];

/**
 * Writes the static-hosting artifacts into <root>/dist after a client build: .gz (level 9) of dist/main.js; app.css
 * and editor.css as served at /app.css and /editor.css, with .gz; index.html exactly as indexHtml() serves it;
 * Cloudflare `_headers` and `_redirects`. Chunks modified at or after `since` (this build's) are listed immutable.
 */
export async function writeStaticArtifacts(root: string, opts: { since?: number } = {}): Promise<void> {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const gzip = (file: string) => writeFileSync(file + ".gz", Bun.gzipSync(readFileSync(file), { level: 9 }));
  if (existsSync(join(dist, "main.js"))) gzip(join(dist, "main.js"));
  else rmSync(join(dist, "main.js.gz"), { force: true });
  for (const url of ["/app.css", "/editor.css"]) {
    const out = join(dist, url.slice(1));
    copyFileSync(join(root, VERSIONED[url]!), out);
    gzip(out);
  }
  writeFileSync(join(dist, "index.html"), await indexHtml(root));
  writeFileSync(join(dist, "_headers"), cloudflareHeaders(dist, opts.since ?? 0));
  writeFileSync(join(dist, "_redirects"), "/r /app 308\n/r/* /app/:splat 308\n");
}

/** Removes what writeStaticArtifacts wrote (before a build, so a --watch build never leaves stale copies). */
export function clearStaticArtifacts(root: string): void {
  for (const f of ["main.js.gz", "app.css", "app.css.gz", "editor.css", "editor.css.gz", "index.html", "_headers", "_redirects"])
    rmSync(join(root, "dist", f), { force: true });
}

const title = (h: string) => h.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase());

function cloudflareHeaders(dist: string, since: number): string {
  const block = (path: string, headers: Record<string, string>) =>
    `${path}\n${Object.entries(headers).map(([k, v]) => `  ${title(k)}: ${v}`).join("\n")}\n`;
  // nosniff once for every path: Cloudflare joins a header set by two matching rules with a comma
  const { "content-type": _type, "x-content-type-options": nosniff, ...html } = HTML_HEADERS;
  const out = [block("/*", { "x-content-type-options": nosniff! })];
  for (const path of HTML_PATTERNS) out.push(block(path, html));
  for (const dir of ["fonts", "editor-rs", "highlights"]) out.push(block(`/dist/${dir}/*`, { "cache-control": IMMUTABLE }));
  // Bun's content-hashed chunks: _headers has no pattern for them, so list this build's by name
  const chunks = readdirSync(dist)
    .filter((f) => immutableDist(`/dist/${f}`) && statSync(join(dist, f)).mtimeMs >= since)
    .sort();
  for (const f of chunks) out.push(block(`/dist/${f}`, { "cache-control": IMMUTABLE }));
  return out.join("");
}

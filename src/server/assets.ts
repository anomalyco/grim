// Cache busting for the client: the HTML (never cached) links app.css, editor.css and dist/main.js with ?v=<content
// hash>; those URLs, Bun's content-hashed chunks (dist/<name>-<hash>.js) and the hashed wasm dirs are cached forever.
// So a deploy is picked up on the next page load without a hard reload.
import { join } from "node:path";

export const IMMUTABLE = "public, max-age=31536000, immutable";

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

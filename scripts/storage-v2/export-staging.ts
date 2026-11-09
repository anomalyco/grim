// The staging migration, step 1 (docs/storage-v2.md §12): dump every staging workspace through the old (Git-backed)
// HTTP API, before the storage-v2 deploy: each note's live text, its last N commits (author, date, text) oldest
// first, and the images its notes link to. Writes <out>/<workspace>.json.
//   bun scripts/storage-v2/export-staging.ts <base url> <out dir> <workspace id>...
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [base, out, ...ids] = process.argv.slice(2);
if (!base || !out || !ids.length) throw new Error("usage: export-staging.ts <base url> <out dir> <workspace id>...");
const VERSIONS = 30;
mkdirSync(out, { recursive: true });

const api = (ws: string, sub: string, q: Record<string, string>) => `${base}/api/workspace/${encodeURIComponent(ws)}/${sub}?${new URLSearchParams(q)}`;

async function json<T>(url: string): Promise<T | null> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url);
    if (r.status === 404) return null;
    if (r.ok) return (await r.json()) as T;
    await Bun.sleep(500 * (i + 1));
  }
  throw new Error(`failed: ${url}`);
}

/** Image paths a note links to, resolved against its folder. */
function images(notePath: string, text: string): string[] {
  const dir = notePath.split("/").slice(0, -1);
  const out = new Set<string>();
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)) {
    let src = m[1]!;
    if (/^[a-z]+:/i.test(src) || src.startsWith("/")) continue;
    try {
      src = decodeURIComponent(src.split(/[?#]/)[0]!);
    } catch {
      continue;
    }
    const parts = [...dir];
    for (const p of src.split("/")) {
      if (p === "..") parts.pop();
      else if (p && p !== ".") parts.push(p);
    }
    if (/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(parts.join("/"))) out.add(parts.join("/"));
  }
  return [...out];
}

for (const ws of ids) {
  const tree = await json<{ files: string[] }>(`${base}/api/workspace/${encodeURIComponent(ws)}/tree`);
  if (!tree) throw new Error(`no tree for ${ws}`);
  const notes: Array<{ path: string; text: string; versions: Array<{ text: string; authorName: string; authorEmail: string; date: string; message: string }> }> = [];
  const imgs = new Set<string>();
  for (const path of tree.files) {
    const file = await json<{ content: string }>(api(ws, "file", { path }));
    if (!file) continue;
    const commits = (await json<Array<{ sha: string; message: string; authorName: string; authorEmail: string; date: string }>>(api(ws, "history", { path, limit: String(VERSIONS) }))) ?? [];
    const versions = [];
    for (const c of commits.reverse()) {
      const at = await json<{ content: string }>(api(ws, "file", { path, ref: c.sha }));
      if (at) versions.push({ text: at.content, authorName: c.authorName, authorEmail: c.authorEmail, date: c.date, message: c.message.split("\n")[0]! });
    }
    notes.push({ path, text: file.content, versions });
    for (const i of images(path, file.content)) imgs.add(i);
  }
  const images64: Array<{ path: string; base64: string }> = [];
  for (const path of imgs) {
    const r = await fetch(api(ws, "raw", { path }));
    if (r.ok) images64.push({ path, base64: Buffer.from(await r.arrayBuffer()).toString("base64") });
  }
  writeFileSync(join(out, `${ws}.json`), JSON.stringify({ workspace: ws, notes, images: images64 }));
  console.log(`${ws}: ${notes.length} notes, ${notes.reduce((n, x) => n + x.versions.length, 0)} versions, ${images64.length} images`);
}

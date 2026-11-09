// The staging migration, step 2 (docs/storage-v2.md §12): post each dump from export-staging.ts to the storage-v2
// server's import endpoint (a few notes per request), then check every note's text against the dump.
//   IMPORT_TOKEN=… bun scripts/storage-v2/import-staging.ts <base url> <dump dir> <workspace id>...
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [base, dir, ...ids] = process.argv.slice(2);
const token = process.env.IMPORT_TOKEN;
if (!base || !dir || !ids.length || !token) throw new Error("usage: IMPORT_TOKEN=… import-staging.ts <base url> <dump dir> <workspace id>...");

interface Dump {
  workspace: string;
  notes: Array<{ path: string; text: string; versions: unknown[] }>;
  images: Array<{ path: string; base64: string }>;
}

async function post(body: unknown) {
  const r = await fetch(`${base}/api/admin/import`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`import: ${r.status} ${await r.text()}`);
  return (await r.json()) as { made: string[]; notes: number };
}

let bad = 0;
for (const ws of ids) {
  const d = JSON.parse(readFileSync(join(dir, `${ws}.json`), "utf8")) as Dump;
  let made = 0;
  for (let i = 0; i < d.notes.length; i += 5) made += (await post({ workspace: ws, notes: d.notes.slice(i, i + 5) })).made.length;
  for (let i = 0; i < d.images.length; i += 5) await post({ workspace: ws, images: d.images.slice(i, i + 5) });
  // check: every note's text as dumped
  let ok = 0;
  for (const n of d.notes) {
    const r = await fetch(`${base}/api/workspace/${encodeURIComponent(ws)}/file?${new URLSearchParams({ path: n.path })}`);
    const got = r.ok ? ((await r.json()) as { content: string }).content : null;
    if (got === n.text) ok++;
    else {
      bad++;
      console.error(`  MISMATCH ${ws}/${n.path}: ${got === null ? r.status : `${got.length} vs ${n.text.length} chars`}`);
    }
  }
  console.log(`${ws}: made ${made} of ${d.notes.length} notes, ${d.images.length} images; ${ok}/${d.notes.length} texts match`);
}
if (bad) process.exit(1);

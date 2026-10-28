// Grimoire benchmark: latency of the hot paths and the first-load size, against the budgets in tools/bench-budgets.json
// (cloudflare/performance.md §2). Prints a table (or JSON) and exits 1 when a budget is missed.
//
//   BASE_URL=http://localhost:9101 bun tools/bench.ts            full run: signs in, seeds 100 notes, edits (scratch servers only)
//   BASE_URL=https://grimoire.exe.xyz bun tools/bench.ts --read-only    GETs only: HTML TTFB, first-load bytes, tree, file read
//
// Flags: --read-only, --allow-writes (full run on a non-local URL), --no-gate (report, always exit 0), --json.
// Env: BASE_URL, WORKSPACE, N_NOTES (100), SEED_WAIT_MS (4500), BUDGETS (path to the budgets file).
// The full run needs ALLOW_DEV_LOGIN=1 on the server and writes notes under bench/ in WORKSPACE; without WORKSPACE it
// creates a scratch workspace and removes it at the end. --read-only reads WORKSPACE, by default the public "demo"
// (hosted servers have no shared "notes" workspace).
import { gunzipSync } from "bun";
import { brotliDecompressSync } from "node:zlib";
import { room } from "../test/server/helpers.ts";

const args = new Set(process.argv.slice(2));
for (const a of args) if (!["--read-only", "--allow-writes", "--no-gate", "--json"].includes(a)) usage(`unknown flag ${a}`);
const READ_ONLY = args.has("--read-only");
const GATE = !args.has("--no-gate");
const JSON_OUT = args.has("--json");
const BASE = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
let WS = process.env.WORKSPACE ?? (READ_ONLY ? "demo" : "");
/** The workspace this run made (full run without WORKSPACE): removed at the end. */
let scratch: string | null = null;
const N_NOTES = Number(process.env.N_NOTES ?? 100);
const budgetsPath = process.env.BUDGETS ?? new URL("./bench-budgets.json", import.meta.url).pathname;

const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname);
if (!READ_ONLY && !local && !args.has("--allow-writes"))
  usage(`${BASE} is not local: the full run signs in, seeds notes and edits. Use --read-only, or --allow-writes for a scratch server.`);

type Budget = { label: string; p50?: number; p95?: number; max?: number };
const budgets = (await Bun.file(budgetsPath).json()) as Record<string, Budget>;
const samples: Record<string, number[]> = {};
const notes: Record<string, string> = {};
const errors: Record<string, string> = {};
const started = performance.now();

const log = (...a: unknown[]) => console.error(...a);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (v: number) => Math.round(v * 100) / 100;
const pad3 = (i: number) => String(i).padStart(3, "0");

async function time(fn: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}
async function waitUntil(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await sleep(0);
  }
}
/** Runs one measurement; a failure is recorded against its metrics instead of stopping the run. */
async function measure(keys: string[], fn: () => Promise<void>) {
  log(`… ${keys.join(", ")}`);
  try {
    await fn();
  } catch (e) {
    for (const k of keys) errors[k] = String((e as Error)?.message ?? e);
  }
}
async function ok(r: Response | Promise<Response>, what: string) {
  const res = await r;
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return res;
}

// ---- GET-only metrics (both modes) ----

let H: Record<string, string> = { origin: BASE };
let cookie = "";

await measure(["html_ttfb"], async () => {
  await ok(fetch(`${BASE}/app`), "/app").then((r) => r.arrayBuffer()); // warm the connection (TLS)
  const xs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const r = await ok(fetch(`${BASE}/app`, { headers: { "accept-encoding": "gzip, br" } }), "/app");
    xs.push(performance.now() - t);
    await r.arrayBuffer();
  }
  samples.html_ttfb = xs;
});

await measure(["first_load_kb"], async () => {
  // The real bytes on the wire with accept-encoding gzip, br (what the browser downloads); responses sent
  // uncompressed count in full and are listed in the note.
  let wire = 0;
  const raw: string[] = [];
  const get = async (path: string) => {
    const r = await ok(fetch(new URL(path, BASE), { headers: { "accept-encoding": "gzip, br" }, decompress: false } as RequestInit), path);
    const body = new Uint8Array(await r.arrayBuffer());
    const enc = r.headers.get("content-encoding") ?? "";
    wire += body.length;
    if (!enc) raw.push(new URL(path, BASE).pathname.split("/").pop() || "index.html");
    const plain = enc === "gzip" ? gunzipSync(body) : enc === "br" ? brotliDecompressSync(body) : body;
    return new TextDecoder().decode(plain);
  };
  const html = await get("/app/");
  const css = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
  const js = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
  for (const c of css) await get(c);
  // scripts and their static imports (dynamic import("…") chunks load later and don't count)
  const seen = new Set<string>();
  let wasmBase = "";
  const queue = js.map((s) => new URL(s, BASE).href);
  while (queue.length) {
    const u = queue.shift()!;
    if (seen.has(new URL(u).pathname)) continue;
    seen.add(new URL(u).pathname);
    const src = await get(u);
    wasmBase ||= src.match(/\/dist\/editor-rs\/[0-9a-f]{16}\//)?.[0] ?? "";
    for (const m of src.matchAll(/(?:^|[;}\s])import\s*(?:[\w$*{}\s,]*?from\s*)?"(\.{1,2}\/[^"]+)"/g)) queue.push(new URL(m[1]!, u).href);
  }
  if (!wasmBase) throw new Error("editor wasm not found in the bundle (no dist/ build?)");
  await get(wasmBase + "editor_wasm.js");
  await get(wasmBase + "editor_wasm_bg.wasm");
  samples.first_load_kb = [wire / 1000];
  notes.first_load_kb = `${seen.size + css.length + 3} files` + (raw.length ? `; sent uncompressed: ${raw.join(", ")}` : "");
});

if (!READ_ONLY) {
  await measure(["sign-in"], async () => {
    const login = await fetch(`${BASE}/auth/dev`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: "name=Bench&next=/app",
    });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    if (!cookie) throw new Error(`dev sign-in failed (HTTP ${login.status}; is ALLOW_DEV_LOGIN=1 set?)`);
    H = { cookie, origin: BASE, "content-type": "application/json" };
  });
  if (!cookie) finish();
  if (!WS)
    await measure(["seed"], async () => {
      const r = await ok(fetch(`${BASE}/api/workspaces`, { method: "POST", headers: H, body: JSON.stringify({ title: "bench" }) }), "create workspace");
      WS = scratch = ((await r.json()) as { id: string }).id;
      notes.tree = `scratch workspace ${WS}`;
    });
  if (errors.seed) finish();
  await measure(["seed"], async () => {
    const body = (i: number) =>
      `# Note ${i}\n\n` + Array.from({ length: 30 }, (_, k) => `- item ${k} of note ${i}: the quick brown fox ${i * k}`).join("\n") + "\n";
    const tree = (await (await ok(fetch(`${BASE}/api/repos/${WS}/tree`, { headers: H }), "tree")).json()) as { files: string[] };
    const have = new Set(tree.files);
    for (let i = 0; i < N_NOTES; i++) {
      const path = `bench/n${pad3(i)}.md`;
      if (have.has(path)) continue;
      const r = await fetch(`${BASE}/api/repos/${WS}/files`, { method: "POST", headers: H, body: JSON.stringify({ path, content: body(i) }) });
      if (r.status !== 201 && r.status !== 409) throw new Error(`create ${path}: HTTP ${r.status}`);
    }
    await sleep(Number(process.env.SEED_WAIT_MS ?? 4500)); // let the new notes commit
  });
  if (errors.seed) await dropScratch().then(finish);
}

let files: string[] = [];
await measure(["tree"], async () => {
  const xs: number[] = [];
  for (let i = 0; i < 30; i++)
    xs.push(
      await time(async () => {
        files = ((await (await ok(fetch(`${BASE}/api/repos/${WS}/tree`, { headers: H }), "tree")).json()) as { files: string[] }).files;
      }),
    );
  samples.tree = xs;
});

await measure(["file_read"], async () => {
  const md = READ_ONLY ? files.filter((f) => f.endsWith(".md")).slice(0, 15) : Array.from({ length: 15 }, (_, i) => `bench/n${pad3(80 + i)}.md`);
  if (!md.length) throw new Error(`no notes in ${WS}`);
  const xs: number[] = [];
  for (let i = 0; i < 15; i++) {
    const path = md[i % md.length]!;
    xs.push(await time(() => ok(fetch(`${BASE}/api/repos/${WS}/file?path=${encodeURIComponent(path)}`, { headers: H }), path).then((r) => r.json())));
  }
  samples.file_read = xs;
});

// ---- signed-in metrics with edits (full run only) ----

if (!READ_ONLY) {
  await measure(["workspaces"], async () => {
    const xs: number[] = [];
    for (let i = 0; i < 30; i++) xs.push(await time(() => ok(fetch(`${BASE}/api/workspaces`, { headers: H }), "workspaces").then((r) => r.arrayBuffer())));
    samples.workspaces = xs;
  });

  await measure(["open_cold", "open_warm"], async () => {
    // cold: the room isn't open (loads from the store); warm: a second client joins the open room
    const cold: number[] = [];
    const warm: number[] = [];
    for (let i = 0; i < 20; i++) {
      const path = `bench/n${pad3(50 + i)}.md`;
      let t = performance.now();
      const a = room(BASE, { repo: WS, path }, { cookie, origin: BASE });
      await waitUntil(() => a.text.length > 0);
      cold.push(performance.now() - t);
      t = performance.now();
      const b = room(BASE, { repo: WS, path }, { cookie, origin: BASE });
      await waitUntil(() => b.text.length > 0);
      warm.push(performance.now() - t);
      a.close();
      b.close();
    }
    samples.open_cold = cold;
    samples.open_warm = warm;
  });

  await measure(["keystroke"], async () => {
    const path = "bench/keystroke.md";
    const r = await fetch(`${BASE}/api/repos/${WS}/files`, { method: "POST", headers: H, body: JSON.stringify({ path, content: "# Keys\n" }) });
    if (r.status !== 201 && r.status !== 409) throw new Error(`create ${path}: HTTP ${r.status}`);
    const a = room(BASE, { repo: WS, path }, { cookie, origin: BASE });
    const b = room(BASE, { repo: WS, path }, { cookie, origin: BASE });
    try {
      await waitUntil(() => a.text.length > 0 && b.text.length > 0);
      const xs: number[] = [];
      for (let i = 0; i < 300; i++) {
        const want = b.text.length + 1;
        const t = performance.now();
        a.text.insert(a.text.length, "x");
        await waitUntil(() => b.text.length >= want);
        xs.push(performance.now() - t);
        await sleep(5);
      }
      samples.keystroke = xs;
    } finally {
      a.close();
      b.close();
    }
  });

  await measure(["shell_cat", "shell_grep_first", "shell_grep"], async () => {
    const id = Math.random().toString(36).slice(2, 8);
    const sh = async (command: string, session: string) =>
      (await ok(fetch(`${BASE}/api/shell`, { method: "POST", headers: H, body: JSON.stringify({ command, session }) }), "shell")).json();
    await sh(`cd /workspace/${WS}`, `bench-cat-${id}`);
    const cat: number[] = [];
    for (let i = 0; i < 15; i++) cat.push(await time(() => sh(`cat bench/n${pad3(i)}.md > /dev/null`, `bench-cat-${id}`)));
    samples.shell_cat = cat;
    // the first command of a new session, then warm runs in it
    const grep = () => sh(`grep -rn "fox 4" /workspace/${WS}/bench | wc -l`, `bench-grep-${id}`);
    samples.shell_grep_first = [await time(grep)];
    const xs: number[] = [];
    for (let i = 0; i < 10; i++) xs.push(await time(grep));
    samples.shell_grep = xs;
    notes.shell_grep = `${N_NOTES} notes`;
  });

  await measure(["mcp_call"], async () => {
    const rpc = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const init = await ok(
      fetch(`${BASE}/mcp`, { method: "POST", headers: H, body: rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" } }) }),
      "mcp initialize",
    );
    await init.arrayBuffer();
    const sid = init.headers.get("mcp-session-id");
    const mh = { ...H, ...(sid ? { "mcp-session-id": sid } : {}) };
    const call = (i: number) =>
      ok(fetch(`${BASE}/mcp`, { method: "POST", headers: mh, body: rpc(10 + i, "tools/call", { name: "document_command", arguments: { command: `cat /workspace/${WS}/bench/n001.md | head -3` } }) }), "mcp")
        .then((r) => r.json())
        .then((j: any) => {
          if (j.error || j.result?.isError) throw new Error(`mcp tools/call: ${JSON.stringify(j.error ?? j.result).slice(0, 200)}`);
        });
    const xs: number[] = [];
    for (let i = 0; i < 15; i++) xs.push(await time(() => call(i)));
    samples.mcp_call = xs;
  });
}

await dropScratch();
finish();

/** Remove the scratch workspace this run made (owner-only DELETE). */
async function dropScratch() {
  if (!scratch) return;
  const r = await fetch(`${BASE}/api/repos/${encodeURIComponent(scratch)}`, { method: "DELETE", headers: H }).catch((e) => e as Error);
  if (r instanceof Error || !r.ok) log(`couldn't remove the scratch workspace ${scratch}: ${r instanceof Error ? r.message : `HTTP ${r.status}`}`);
}

// ---- report ----

function finish(): never {
  const rows = Object.entries(budgets)
    .filter(([key]) => !key.startsWith("$") && (samples[key] || errors[key]))
    .map(([key, b]) => {
      const xs = samples[key];
      const p50 = xs ? round(pct(xs, 50)) : null;
      const p95 = xs ? round(pct(xs, 95)) : null;
      const pass = !!xs && (b.max !== undefined ? pct(xs, 100) <= b.max : (b.p50 === undefined || p50! <= b.p50) && (b.p95 === undefined || p95! <= b.p95));
      return { key, label: b.label, unit: key.endsWith("_kb") ? "KB" : "ms", n: xs?.length ?? 0, p50, p95, budget: b, pass, note: errors[key] ?? notes[key] };
    });
  // failures outside the budget table (sign-in, seeding)
  const other = Object.entries(errors).filter(([k]) => !budgets[k]);
  const failed = rows.some((r) => !r.pass) || other.length > 0;
  const secs = (performance.now() - started) / 1000;
  if (JSON_OUT) {
    console.log(JSON.stringify({ base: BASE, mode: READ_ONLY ? "read-only" : "full", gate: GATE, pass: !failed, seconds: Math.round(secs), metrics: rows, errors: Object.fromEntries(other) }, null, 2));
  } else {
    const f = (v: number | null | undefined) => (v == null ? "—" : v >= 100 ? v.toFixed(0) : v.toFixed(1));
    const head = ["metric", "p50", "p95", "budget", "n", "result"];
    const body = rows.map((r) => {
      const single = r.budget.max !== undefined;
      return [
        r.label,
        single ? f(pct(samples[r.key] ?? [NaN], 100)) + " " + r.unit : f(r.p50),
        single ? "" : f(r.p95),
        single ? `≤ ${r.budget.max} ${r.unit}` : `${f(r.budget.p50)} / ${f(r.budget.p95)} ms`,
        String(r.n),
        (r.pass ? "PASS" : "FAIL") + (r.note ? `  ${r.note}` : ""),
      ];
    });
    const w = head.map((h, i) => Math.max(h.length, ...body.map((row) => (i === 5 ? 4 : row[i]!.length))));
    const line = (row: string[]) => row.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : i === 5 ? c : c.padStart(w[i]!))).join("  ");
    console.log(`${BASE} (${READ_ONLY ? "read-only" : "full run"}, ${secs.toFixed(0)} s)`);
    console.log(line(head));
    for (const row of body) console.log(line(row));
    for (const [k, e] of other) console.log(`${k}: FAIL  ${e}`);
    console.log(failed ? `FAIL${GATE ? "" : " (not gating: --no-gate)"}` : "PASS");
  }
  process.exit(failed && GATE ? 1 : 0);
}

function usage(msg: string): never {
  console.error(`bench: ${msg}\nusage: BASE_URL=… bun tools/bench.ts [--read-only] [--allow-writes] [--no-gate] [--json]`);
  process.exit(2);
}

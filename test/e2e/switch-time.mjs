// Measures note-switch time (click on a tree row → the note's text visible in the editor) against a local Bun server,
// or a running one with BASE_URL (it needs ALLOW_DEV_LOGIN there; it makes a scratch workspace and removes it).
// Rounds of clicks: each note cold (first open), then back and forth (the previous note), then down the tree
// (neighbours), then a note not open yet after IDLE_MS (default 15 s) of no clicks, each round. Prints p50 / p95 / max
// per kind, how many of its clicks had to open a channel (the rest were warm: prefetched or shown before), and the
// WebSockets and v2 opens the page made.
// Usage: bun run build:client && bun test/e2e/switch-time.mjs [rounds]
// RTT_MS=80 puts a TCP proxy in front of the local server that delays every chunk by half of that each way (HTTP and
// WebSockets alike), like a real network. Each click comes as soon as the previous note is editable; DWELL_MS adds a
// user's pace between clicks (a benchmark parameter, not a wait for something; off by default: the clicks stay well
// under v2's open rate of 32 per 10 s without it). IDLE_MS=0 skips the idle round.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROUNDS = Number(process.argv[2] ?? 3);
const REMOTE = process.env.BASE_URL?.replace(/\/$/, "");
let app = null;
if (!REMOTE) {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-switch-"));
  process.env.ALLOW_DEV_LOGIN = "1";
  process.env.SIGN_IN = "on";
  process.env.QUIET_MS = "600";
  process.env.PORT = "0";
  const { startServer } = await import("../../src/server/index.ts");
  app = await startServer({ port: 0, quiet: true });
}
const RTT = Number(process.env.RTT_MS ?? 0);
const DWELL = Number(process.env.DWELL_MS ?? 0);
const IDLE = Number(process.env.IDLE_MS ?? 15_000);
const base = REMOTE ?? `http://localhost:${RTT ? delayProxy(app.server.port, RTT / 2) : app.server.port}`;

/** A TCP proxy to `port` delaying each chunk by `ms` in each direction (order kept). Returns its port. */
function delayProxy(port, ms) {
  const later = (fn) => setTimeout(fn, ms);
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        client.data = { up: null, queue: [] };
        client.data.up = await Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            data: (_s, chunk) => { const c = Buffer.from(chunk); later(() => client.write(c)); },
            close: () => later(() => client.end()),
            error: () => client.end(),
          },
        });
        for (const c of client.data.queue) client.data.up.write(c);
        client.data.queue = null;
      },
      data(client, chunk) {
        const c = Buffer.from(chunk);
        later(() => (client.data.up ? client.data.up.write(c) : client.data.queue?.push(c)));
      },
      close: (client) => later(() => client.data?.up?.end()),
      error: (client) => client.data?.up?.end(),
    },
  });
  return server.port;
}

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
if (process.env.DEBUG_WS) page.on("console", (m) => console.log("CONSOLE", m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
let sockets = 0;
let refused = 0;
/** v2 opens the page sent: [time, path]. */
const opens = [];
page.on("websocket", (ws) => {
  sockets++;
  ws.on("framesent", (f) => {
    if (typeof f.payload === "string") return;
    const b = Buffer.from(f.payload);
    // channel 0, control: varuint 0 · varuint 2 · JSON
    if (b[0] !== 0 || b[1] !== 2) return;
    try {
      const msg = JSON.parse(b.subarray(b.indexOf(123)).toString());
      if (msg.t === "open") opens.push([Date.now(), msg.path]);
    } catch {}
  });
  // v2 opens refused for the open rate or channel count (`error 4429` on channel 0)
  ws.on("framereceived", (f) => typeof f.payload !== "string" && Buffer.from(f.payload).includes('"code":4429') && refused++);
});
await page.goto(`${base}/auth/dev?next=${REMOTE ? "/app" : "/app/notes/Welcome.md"}`);
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit]");
await page.waitForURL(/\/app/, { timeout: 15000 });
let WS = "notes";
if (REMOTE) {
  WS = await page.evaluate(() =>
    fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "switch-time" }) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`create workspace: HTTP ${r.status}`))))
      .then((w) => w.id),
  );
}

const N = 16;
const names = Array.from({ length: N }, (_, i) => `S${String(i).padStart(2, "0")}.md`);
// the idle round clicks Z(2·ROUNDS) … Z02: a note's neighbour prefetch (below first, else above) never warms the next one
const idleNames = IDLE ? Array.from({ length: 2 * ROUNDS + 1 }, (_, i) => `Z${String(i).padStart(2, "0")}.md`) : [];
const label = new Map([...names.map((n, i) => [n, `Note ${i}.`]), ...idleNames.map((n, i) => [n, `Idle ${i}.`])]);
for (const [name, want] of label) {
  const body = Array.from({ length: 150 }, (_, k) => `Line ${k} of ${want} Some words to lay out and render.`).join("\n");
  const status = await page.evaluate(([ws, path, content]) => fetch(`/api/repos/${ws}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content }) }).then((r) => r.status), [WS, name, `# ${want}\n${body}\n`]);
  if (status >= 300) throw new Error(`create ${name}: HTTP ${status}`);
  await app?.ctx.rooms.peek("notes", name)?.flush();
}
await page.goto(`${base}/app/${WS}/${names.at(-1)}`);
await page.waitForSelector(`.file-row[href="/app/${WS}/${names[0]}"]`, { timeout: 15000 });
await page.waitForSelector(".mde .ln", { timeout: 15000 });
const v2 = await page.evaluate(() => fetch("/api/server").then((r) => r.json()).then((s) => (s.ws ?? [1]).includes(2)));
const socketsAtStart = sockets;
const opensAtStart = opens.length;

/**
 * Click the row of `name`: ms until its heading shows in the editor (`text`: live or the read-only preview) and until
 * the live editor is up (`live`: editable, on the synced document).
 */
const switchTo = async (name) => {
  const before = opens.length;
  const r = await page.evaluate(
    ([name, want, ws]) =>
      new Promise((resolve, reject) => {
        const row = document.querySelector(`.file-row[href="/app/${ws}/${name}"]`);
        if (!row) return reject(new Error(`no row ${name}`));
        const t0 = performance.now();
        let text = null;
        const here = () => location.pathname.endsWith(name);
        const check = () => {
          if (!here()) return false;
          const ln = document.querySelector(".doc-body .mde .ln");
          if (text === null && ln?.textContent?.includes(want)) text = performance.now() - t0;
          const live = document.querySelector(".doc-body .editor-host:not(.preview) .mde-content[contenteditable=true] .ln");
          if (text !== null && live?.textContent?.includes(want)) {
            resolve({ text, live: performance.now() - t0 });
            return true;
          }
          return false;
        };
        const obs = new MutationObserver(() => check() && obs.disconnect());
        obs.observe(document.querySelector(".doc-body"), { subtree: true, childList: true, characterData: true, attributes: true });
        row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        if (check()) obs.disconnect();
      }),
    [name, label.get(name), WS],
  );
  // did this click open a channel (cold), or was the note warm (prefetched, or shown before)?
  return { ...r, opened: opens.slice(before).some(([, p]) => p === name) };
};

/** The scratch workspace of a BASE_URL run goes at the end, also when a click fails. */
async function removeScratch() {
  if (!REMOTE) return;
  const status = await page.evaluate((ws) => fetch(`/api/repos/${ws}`, { method: "DELETE" }).then((r) => r.status), WS).catch((e) => String(e));
  if (status !== 200 && status !== 204) console.log(`couldn't remove the scratch workspace ${WS}: ${status}`);
}

const times = { cold: [], previous: [], neighbour: [], idle: [] };
try {
const dwell = () => DWELL && page.waitForTimeout(DWELL);
// cold: each note once, every other one first (so the neighbour prefetched after a click isn't the next click)
for (const n of [...names.filter((_, i) => i % 2 === 0), ...names.filter((_, i) => i % 2)]) {
  times.cold.push(await switchTo(n));
  await dwell();
}
for (let r = 0; r < ROUNDS; r++) {
  // back and forth between two notes (the first two clicks only set it up)
  for (let k = 0; k < 6; k++) {
    const i = k % 2 === 0 ? 2 : 5;
    if (k < 2) {
      await switchTo(names[i]);
      await dwell();
      continue;
    }
    times.previous.push(await switchTo(names[i]));
    await dwell();
  }
  // walk down the tree, each click once the previous note is editable
  await switchTo(names[0]);
  await dwell();
  for (let i = 1; i < N; i++) {
    times.neighbour.push(await switchTo(names[i]));
    await dwell();
  }
}
// after a pause (the server may have let the workspace sleep: DO hibernation, isolates gone), a note not shown yet;
// from the top note, so the bottom ones aren't a prefetched neighbour
for (const n of idleNames.filter((_, i) => i > 0 && i % 2 === 0).toReversed()) {
  await switchTo(names[0]);
  // the pause is what's measured here, not a wait for something
  await page.waitForTimeout(IDLE);
  times.idle.push(await switchTo(n));
}
} catch (e) {
  await removeScratch();
  throw e;
}
const stat = (a) => {
  if (!a.length) return "n=0";
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `n=${s.length} p50=${q(0.5).toFixed(1)} p95=${q(0.95).toFixed(1)} max=${s.at(-1).toFixed(1)} ms`;
};
// the client's protocol: v1 opens a socket per note
const clientV2 = sockets === socketsAtStart;
console.log(`${base}: client ${clientV2 ? "v2 (workspace socket)" : "v1 (socket per note)"} (server ws ${v2 ? "[1, 2]" : "[1]"}), RTT ${RTT} ms, dwell ${DWELL} ms, idle ${IDLE} ms`);
// v2: clicks that opened a channel apart from warm ones (prefetched or shown before: no network)
for (const [k, all] of Object.entries(times)) {
  const parts = clientV2 ? [["opened", all.filter((x) => x.opened)], ["warm", all.filter((x) => !x.opened)]] : [["", all]];
  for (const [what, a] of parts) {
    if (!a.length) continue;
    const name = what ? `${k} ${what}` : k;
    console.log(`${name.padEnd(17)} text ${stat(a.map((x) => x.text))}`);
    console.log(`${"".padEnd(17)} live ${stat(a.map((x) => x.live))}`);
  }
}
const ts = opens.slice(opensAtStart).map(([t]) => t);
const busiest = Math.max(0, ...ts.map((t) => ts.filter((u) => u >= t && u - t < 10_000).length));
console.log(`WebSockets opened during the switches: ${sockets - socketsAtStart}; v2 opens: ${ts.length}, at most ${busiest} in 10 s; refused (4429): ${refused}`);
await removeScratch();
await browser.close();
app?.server.stop(true);
process.exit(0);

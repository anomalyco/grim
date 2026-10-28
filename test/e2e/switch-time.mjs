// Measures note-switch time (click on a tree row → the note's text visible in the editor) against a local Bun server.
// Rounds of clicks: each note cold (first open), then back and forth (the previous note), then down the tree
// (neighbours). Prints p50 / p95 / max per kind, plus the WebSockets the page opened.
// Usage: bun run build:client && bun test/e2e/switch-time.mjs [rounds]
// RTT_MS=80 puts a TCP proxy in front of the server that delays every chunk by half of that each way (HTTP and
// WebSockets alike), like a real network. DWELL_MS (default 700) is the user's pace: the time on a note before the
// next click (a benchmark parameter, not a wait for something; v2's open rate is 16 notes per 10 s per socket).
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROUNDS = Number(process.argv[2] ?? 3);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-switch-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.QUIET_MS = "600";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const RTT = Number(process.env.RTT_MS ?? 0);
const DWELL = Number(process.env.DWELL_MS ?? 700);
const base = `http://localhost:${RTT ? delayProxy(app.server.port, RTT / 2) : app.server.port}`;

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
page.on("websocket", () => sockets++);
await page.goto(`${base}/auth/dev?next=/app/notes/Welcome.md`);
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit]");
await page.waitForSelector(".mde .ln", { timeout: 10000 });

const N = 8;
const names = Array.from({ length: N }, (_, i) => `S${String(i).padStart(2, "0")}.md`);
for (const [i, name] of names.entries()) {
  const body = Array.from({ length: 150 }, (_, k) => `Line ${k} of note ${i}: some words to lay out and render.`).join("\n");
  await page.evaluate(([path, content]) => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content }) }), [name, `# Note ${i}\n${body}\n`]);
  await app.ctx.rooms.peek("notes", name)?.flush();
}
await page.reload();
await page.waitForSelector(`.file-row[href="/app/notes/${names.at(-1)}"]`, { timeout: 10000 });
await page.waitForSelector(".mde .ln", { timeout: 10000 });
const v2 = await page.evaluate(() => fetch("/api/server").then((r) => r.json()).then((s) => (s.ws ?? [1]).includes(2)));
const socketsAtStart = sockets;

/**
 * Click the row of `name`: ms until its heading shows in the editor (`text`: live or the read-only preview) and until
 * the live editor is up (`live`: editable, on the synced document).
 */
const switchTo = (name, i) =>
  page.evaluate(
    ([name, i]) =>
      new Promise((resolve, reject) => {
        const want = `Note ${i}`;
        const row = document.querySelector(`.file-row[href="/app/notes/${name}"]`);
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
    [name, i],
  );

const times = { cold: [], previous: [], neighbour: [] };
const dwell = () => page.waitForTimeout(DWELL);
// cold: each note once
for (const [i, n] of names.entries()) {
  times.cold.push(await switchTo(n, i));
  await dwell();
}
for (let r = 0; r < ROUNDS; r++) {
  // back and forth between two notes (the first two clicks only set it up)
  for (let k = 0; k < 6; k++) {
    const i = k % 2 === 0 ? 2 : 5;
    if (k < 2) {
      await switchTo(names[i], i);
      await dwell();
      continue;
    }
    times.previous.push(await switchTo(names[i], i));
    await dwell();
  }
  // walk down the tree, each click once the previous note is editable
  await switchTo(names[0], 0);
  await dwell();
  for (let i = 1; i < N; i++) {
    times.neighbour.push(await switchTo(names[i], i));
    await dwell();
  }
}
const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `n=${s.length} p50=${q(0.5).toFixed(1)} p95=${q(0.95).toFixed(1)} max=${s.at(-1).toFixed(1)} ms`;
};
console.log(`protocol: ${v2 ? "v2 (workspace socket)" : "v1 (socket per note)"}, RTT ${RTT} ms, dwell ${DWELL} ms`);
for (const [k, a] of Object.entries(times)) {
  console.log(`${k.padEnd(9)} text ${stat(a.map((x) => x.text))}`);
  console.log(`${"".padEnd(9)} live ${stat(a.map((x) => x.live))}`);
}
console.log(`WebSockets opened during the switches: ${sockets - socketsAtStart}`);
await browser.close();
app.server.stop(true);
process.exit(0);

// End-to-end: a note shows the moment it's opened, even when its socket is slow. Its last known text (from being
// open before, or a prefetch when its row was hovered or focused, or an HTTP read alongside the socket) is shown
// read-only in the editor's own rendering; the live editor takes over when the document syncs, with the same text,
// scroll and caret, and keys typed meanwhile land once. Nothing big or centered shows while a note loads: at most
// a thin bar, after 300 ms.
// Usage: bun run build:client && bun test/e2e/instant-open.mjs
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-instant-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.SIGN_IN = "on";
process.env.QUIET_MS = "600";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`${base}/auth/dev?next=/app/notes/Welcome.md`);
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit]");
await page.waitForSelector(".editor-host:not(.preview) .mde .ln", { timeout: 10000 });

const long = Array.from({ length: 120 }, (_, i) => `Line ${i} of the long note.`).join("\n\n");
const notes = { "Alpha.md": "# Alpha\n\nalpha text\n", "Bravo.md": "# Bravo\n\nbravo text\n", "Charlie.md": "# Charlie\n\ncharlie text\n", "Long.md": `# Long\n\n${long}\n`, "Zulu.md": "# Zulu\n\nzulu text\n" };
for (const [path, content] of Object.entries(notes)) {
  await page.evaluate(([path, content]) => fetch("/api/workspace/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content }) }), [path, content]);
  await app.ctx.rooms.peek("notes", path)?.flush();
}

// Sockets to the note server are held until the test lets them through: a very slow network for the live document.
const held = [];
let holding = false;
await page.routeWebSocket(/\/ws\?/, (ws) => {
  const go = () => ws.connectToServer();
  if (holding) held.push(go);
  else go();
});
const release = () => {
  holding = false;
  for (const go of held.splice(0)) go();
};

await page.goto(`${base}/app/notes/Alpha.md`);
await page.waitForSelector('.file-row[href="/app/notes/Zulu.md"]', { timeout: 10000 });
await page.waitForSelector(".editor-host:not(.preview) .mde .ln", { timeout: 10000 });

const shown = () => page.evaluate(() => [...document.querySelectorAll(".doc-body .mde .ln")].map((l) => l.textContent).join("\n"));
const live = () => page.evaluate(() => !!document.querySelector(".editor-host:not(.preview) .mde")?.mdeView?.collab);
const raw = () => page.evaluate(() => document.querySelector(".editor-host:not(.preview) .mde")?.mdeView?.engine.text() ?? null);
const big = () => page.evaluate(() => !!document.querySelector(".loading, .spinner"));
/** Click a row and resolve with how long its text took to show (ms, in the page). */
const openRow = (path, marker) =>
  page.evaluate(
    ([path, marker]) =>
      new Promise((resolve) => {
        const a = document.querySelector(`.file-row[href="/app/notes/${path}"]`);
        const t = performance.now();
        a.click();
        const tick = () => {
          const text = [...document.querySelectorAll(".doc-body .mde .ln")].map((l) => l.textContent).join("\n");
          if (text.includes(marker)) resolve(performance.now() - t);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    [path, marker],
  );

const v2 = await page.evaluate(() => fetch("/api/server").then((r) => r.json()).then((s) => !!s.ws?.includes(2)));
if (v2) await workspaceSocket();

// 1. Hovered row: its text is fetched ahead, so the click shows it at once, read-only, while the socket waits.
holding = true;
await page.hover('.file-row[href="/app/notes/Bravo.md"]');
await page.waitForResponse((r) => r.url().includes("/file?path=Bravo.md"));
const tB = await openRow("Bravo.md", "bravo text");
check("hovered note: text shown within a frame or two of the click", tB < 100, true);
check("hovered note: shown read-only (preview) while the socket is held", [await live(), await page.evaluate(() => !!document.querySelector(".editor-host.preview .mde.readonly"))], [false, true]);
check("no big loading indicator", await big(), false);
// keys typed into the preview go into the live editor once it takes over
await page.click(".editor-host.preview .mde .ln >> nth=2");
await page.keyboard.press("End");
await page.keyboard.type(" plus");
release();
await page.waitForFunction(() => !!document.querySelector(".editor-host:not(.preview) .mde")?.mdeView?.collab, null, { timeout: 10000 });
await page.waitForFunction(() => document.querySelector(".editor-host:not(.preview) .mde")?.mdeView?.engine.text().includes("plus"), null, { timeout: 10000 }).catch(() => {});
check("live editor took over with the same text, and the keys typed meanwhile landed once", await raw(), "# Bravo\n\nbravo text plus\n");
check("no preview left behind", await page.evaluate(() => document.querySelectorAll(".doc-body .mde").length), 1);
await page.waitForFunction(() => document.activeElement?.closest(".mde") !== null, null, { timeout: 3000 }).catch(() => {});
check("the live editor has the focus", await page.evaluate(() => !!document.activeElement?.closest(".editor-host:not(.preview) .mde")), true);

// 2. A note opened before: shown from memory at once (no request needed).
holding = true;
const tA = await openRow("Alpha.md", "alpha text");
check("revisited note: text shown at once from memory", tA < 100, true);
release();
await page.waitForFunction(() => !!document.querySelector(".editor-host:not(.preview) .mde")?.mdeView?.collab, null, { timeout: 10000 });
check("revisited note: live text", await raw(), notes["Alpha.md"]);

// 3. Never seen (not hovered, not next to an open note): read over HTTP alongside the (held) socket and shown; a
// thin bar at most, and not before 300 ms.
holding = true;
// its HTTP read is held too, so there's nothing to show for a moment
let fileGo = null;
await page.route(/\/file\?path=Zulu\.md/, (route) => (fileGo = () => route.continue()));
const p = await page.evaluate(async () => {
  const a = document.querySelector('.file-row[href="/app/notes/Zulu.md"]');
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  // the note opens in a microtask (routing); look at the next frame
  await new Promise(requestAnimationFrame);
  const el = document.querySelector(".note-pending");
  return { bar: !!el, opacity: el ? getComputedStyle(el).opacity : null, delay: el ? getComputedStyle(el).animationDelay : null, status: document.querySelector(".save-status")?.textContent };
});
check("unseen note: only the quiet bar, invisible at first, fading in after 300 ms; no status text yet", p, { bar: true, opacity: "0", delay: "0.3s", status: "" });
await page.waitForFunction(() => document.querySelector(".note-pending") && getComputedStyle(document.querySelector(".note-pending")).opacity === "1", null, { timeout: 5000 });
check("the bar is 2 px along the top", await page.evaluate(() => { const r = document.querySelector(".note-pending").getBoundingClientRect(); const d = document.querySelector(".doc-body").getBoundingClientRect(); return [r.height, r.top === d.top]; }), [2, true]);
fileGo();
await page.waitForFunction(() => [...document.querySelectorAll(".doc-body .mde .ln")].some((l) => l.textContent.includes("zulu text")), null, { timeout: 5000 });
check("unseen note: its text over HTTP while the socket is still held", [await live(), (await shown()).includes("zulu text")], [false, true]);
check("'Connecting…' once it has taken 300 ms", await page.waitForFunction(() => document.querySelector(".save-status")?.textContent === "Connecting…", null, { timeout: 5000 }).then(() => true, () => false), true);
release();
await page.waitForFunction(() => !!document.querySelector(".editor-host:not(.preview) .mde")?.mdeView?.collab, null, { timeout: 10000 });
check("unseen note: live text, once", await raw(), notes["Zulu.md"]);

// 4. A scrolled preview keeps its scroll when the live editor takes over (no jump).
await page.hover('.file-row[href="/app/notes/Long.md"]');
await page.waitForResponse((r) => r.url().includes("/file?path=Long.md"));
holding = true;
await openRow("Long.md", "Line 3 of");
await page.evaluate(() => (document.querySelector(".doc-body").scrollTop = 900));
const before = await page.evaluate(() => document.querySelector(".doc-body").scrollTop);
release();
await page.waitForFunction(() => !!document.querySelector(".editor-host:not(.preview) .mde")?.mdeView?.collab, null, { timeout: 10000 });
check("scroll kept across the switch to the live editor", await page.evaluate(() => document.querySelector(".doc-body").scrollTop), before);
check("server text unchanged by opening (no duplicate content)", app.ctx.rooms.peek("notes", "Long.md")?.text.toString(), notes["Long.md"]);

// 5. Another user's edit made after the copy was cached: the live document wins (no stale text left, no merge).
const other = await browser.newContext();
const bob = await other.newPage();
await bob.goto(`${base}/auth/dev?next=/app/notes/Bravo.md`);
await bob.fill("input[name=name]", "Bob");
await bob.click("form button[type=submit]");
await bob.waitForSelector(".editor-host:not(.preview) .mde .ln", { timeout: 10000 });
await bob.click(".mde .ln >> nth=0");
await bob.keyboard.press("End");
await bob.keyboard.type(" by Bob");
const wantB = "# Bravo by Bob\n\nbravo text plus\n";
const tB2 = await openRow("Bravo.md", "bravo text");
check("stale copy: still shown at once", tB2 < 100, true);
await page.waitForFunction((w) => document.querySelector(".editor-host:not(.preview) .mde")?.mdeView?.engine.text() === w, wantB, { timeout: 10000 }).catch(() => {});
check("stale copy: replaced by the live text", await raw(), wantB);
check("stale copy: one editor", await page.evaluate(() => document.querySelectorAll(".doc-body .mde").length), 1);

// 6. The last note is remembered once its text is on screen, before the socket syncs: /app reopens it. A missing
// note (no text from the server) isn't remembered.
holding = true;
await page.goto(`${base}/app/notes/Charlie.md`);
await page.waitForFunction(() => [...document.querySelectorAll(".doc-body .mde .ln")].some((l) => l.textContent.includes("charlie text")), null, { timeout: 10000 });
check("deep link shown while its socket is held", await live(), false);
await page.goto(`${base}/app`);
check("/app reopens the note last shown", await page.waitForURL(/\/app\/notes\/Charlie\.md$/, { timeout: 10000 }).then(() => true, () => page.url()), true);
release();
await page.goto(`${base}/app/notes/Missing.md`);
await page.waitForFunction(() => document.body.innerText.includes("Note not found"), null, { timeout: 10000 });
await page.goto(`${base}/app`);
check("/app doesn't reopen a missing note", await page.waitForURL(/\/app\/notes\/Charlie\.md$/, { timeout: 10000 }).then(() => true, () => page.url()), true);

await done();

async function done() {
  await browser.close();
  await app.stop?.();
  console.log(fails ? `${fails} FAILED` : "all ok");
  process.exit(fails ? 1 : 0);
}

/**
 * Protocol v2: notes are channels on the workspace's one socket, so there's no socket per note to be slow. A hovered
 * row and the notes shown before are open as hidden channels: clicking one shows the live editor at once. A note
 * never seen shows the quiet bar, then its live text one round trip later, without an HTTP read.
 */
async function workspaceSocket() {
  const frames = [];
  const waiters = [];
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) => {
      frames.push(typeof f.payload === "string" ? f.payload : Buffer.from(f.payload).toString("utf8"));
      for (const w of waiters.splice(0)) w();
    }),
  );
  /** Resolves once a frame from the server contains `text`. */
  const received = async (text) => {
    while (!frames.some((f) => f.includes(text))) await new Promise((r) => waiters.push(r));
  };
  const fileReads = [];
  page.on("request", (r) => r.url().includes("/file?path=") && fileReads.push(r.url()));
  const liveOpen = (path, marker) =>
    page.evaluate(
      ([path, marker]) =>
        new Promise((resolve) => {
          const t = performance.now();
          document.querySelector(`.file-row[href="/app/notes/${path}"]`).click();
          const tick = () => {
            const text = [...document.querySelectorAll(".doc-body .editor-host:not(.preview) .mde-content[contenteditable=true] .ln")].map((l) => l.textContent).join("\n");
            if (text.includes(marker)) resolve(performance.now() - t);
            else requestAnimationFrame(tick);
          };
          tick();
        }),
      [path, marker],
    );
  await page.goto(`${base}/app/notes/Alpha.md`);
  await page.waitForSelector('.file-row[href="/app/notes/Zulu.md"]', { timeout: 10000 });
  await page.waitForSelector(".editor-host:not(.preview) .mde .ln", { timeout: 10000 });
  // (the first load reads its note over HTTP, started with the page before the socket: see first-load.mjs)
  check("v2: the first load's one HTTP read, of its note", fileReads.map((u) => decodeURIComponent(u.split("path=")[1])), ["Alpha.md"]);
  fileReads.length = 0;

  await page.hover('.file-row[href="/app/notes/Charlie.md"]');
  await received("charlie text");
  const tC = await liveOpen("Charlie.md", "charlie text");
  check("v2: hovered note (a hidden channel): the live editor within a frame or two of the click", tC < 100, true);
  check("v2: no preview, one editor", await page.evaluate(() => document.querySelectorAll(".doc-body .mde").length), 1);
  check("v2: no big loading indicator", await big(), false);

  const tA = await liveOpen("Alpha.md", "alpha text");
  check("v2: the note shown before: live at once", tA < 100, true);
  check("v2: its live text", await raw(), notes["Alpha.md"]);

  const p = await page.evaluate(async () => {
    document.querySelector('.file-row[href="/app/notes/Zulu.md"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await new Promise(requestAnimationFrame);
    const el = document.querySelector(".note-pending");
    return { bar: !!el || !!document.querySelector(".editor-host:not(.preview) .mde"), spinner: !!document.querySelector(".loading, .spinner") };
  });
  check("v2: unseen note: the quiet bar (or already the note), no spinner", p, { bar: true, spinner: false });
  await page.waitForFunction(() => !!document.querySelector(".editor-host:not(.preview) .mde")?.mdeView?.collab, null, { timeout: 10000 });
  check("v2: unseen note: live text", await raw(), notes["Zulu.md"]);
  check("v2: no HTTP reads of note text after the first load (the channel brings it)", fileReads, []);
  await done();
}

// Interop check for the Rust multiplayer client (laptop crates/collab, example grimoire_client) against a
// scratch Grimoire server on this box and a headless browser. See docs/rust-engine/yrs.md.
// Usage: bun docs/rust-engine/yrs-interop.mjs   (build the example on the laptop first)
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST_IP = process.env.HOST_IP ?? "100.73.96.98";
const PORT = Number(process.env.INTEROP_PORT ?? 8791);
const LAPTOP = "james@100.109.145.97";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-yrs-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.ALLOWED_GITHUB_USERS = "*";
process.env.STORAGE = "local";
process.env.QUIET_MS = "1500";
process.env.HOST = "0.0.0.0";
process.env.PORT = String(PORT);
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: PORT, quiet: true });
const base = `http://localhost:${PORT}`;
const room = () => app.ctx.rooms.peek("notes", "Welcome.md");
const serverText = () => room()?.text.toString() ?? "";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const alice = await ctx.newPage();
alice.on("pageerror", (e) => console.log("[alice] PAGEERROR", e.message));
await alice.goto(base + "/");
await alice.fill("input[name=name]", "Alice");
await alice.click("form button[type=submit], form button");
await alice.waitForURL(/\/app\//, { timeout: 10000 });
await alice.waitForSelector(".mde .ln", { timeout: 10000 });
const domText = () => alice.evaluate(() => [...document.querySelectorAll(".mde .ln")].map((l) => l.textContent).join("\n"));

// ---- the Rust client on the laptop ----
const rust = spawn("ssh", ["-o", "BatchMode=yes", LAPTOP,
  `cd ~/projects/grimoire-native && exec target/debug/examples/grimoire_client http://${HOST_IP}:${PORT} notes Welcome.md --login Rusty`]);
const events = [];
let buf = "";
rust.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      events.push(JSON.parse(line));
    } catch {
      console.log("[rust]", line);
    }
  }
});
rust.stderr.on("data", (d) => process.stderr.write("[rust stderr] " + d));
const cmd = (s) => rust.stdin.write(s + "\n");
let seen = 0;
/** Wait for the next Rust event matching pred (events after the last one consumed). */
async function next(pred, ms = 8000) {
  const e = await until(() => {
    for (let i = seen; i < events.length; i++) if (pred(events[i])) { seen = i + 1; return events[i]; }
    return null;
  }, ms);
  return e;
}
async function rustText() {
  cmd("text");
  return (await next((e) => e.ev === "text"))?.text;
}

const synced = await next((e) => e.ev === "synced", 15000);
check("rust client signs in (POST /auth/dev), connects and syncs", !!synced, JSON.stringify(events));
check("rust text == server text after sync", synced?.text === serverText(), `${JSON.stringify(synced?.text)} vs ${JSON.stringify(serverText())}`);

// 1. browser → rust
await alice.click(".mde .ln >> nth=0");
await alice.keyboard.press("End");
await alice.keyboard.type(" (typed in Chromium)");
const r1 = await next((e) => e.ev === "remote" && e.text.includes("(typed in Chromium)"));
check("rust receives browser typing as remote edits", !!r1, JSON.stringify(events.slice(-3)));
check("rust text == server text", (await rustText()) === serverText());

// rust sees Alice's cursor at her caret (end of line 0)
const aliceCaret = serverText().indexOf("\n");
const ac = await until(async () => {
  cmd("cursors");
  const e = await next((e) => e.ev === "cursors", 1000);
  return e?.cursors.find((c) => c.name === "Alice" && c.head === aliceCaret) ?? null;
});
check("rust resolves Alice's cursor (Yjs relative position JSON)", !!ac, JSON.stringify(events.filter((e) => e.ev === "cursors").slice(-1)));

// 2. rust → browser
const line3 = serverText().split("\n").slice(0, 2).join("\n").length + 1;
cmd(`replace ${line3} ${line3} ${JSON.stringify("From Rust! ")}`);
check("browser shows the rust edit", !!(await until(async () => (await domText()).includes("From Rust!"))), await domText());
check("server text == rust text", !!(await until(async () => serverText() === (await rustText()))));

// 3. rust cursor shows in the browser, on the right line, with the account's name
const caretAt = line3 + "From Rust! ".length;
cmd(`cursor ${caretAt} ${caretAt}`);
const shown = await until(() =>
  alice.evaluate(() => {
    const c = document.querySelector(".rcaret");
    const l = document.querySelector(".rlabel");
    return c && l ? { top: c.getBoundingClientRect().top, label: l.textContent } : null;
  }),
);
const lineTop = await alice.evaluate(() => {
  const ln = document.querySelectorAll(".mde .ln")[2];
  const r = ln.getBoundingClientRect();
  return [r.top, r.bottom];
});
check("rust cursor appears in the browser with its name", !!shown && /rusty/i.test(shown.label), JSON.stringify(shown));
check("rust cursor is on line 3", !!shown && shown.top >= lineTop[0] - 2 && shown.top < lineTop[1], JSON.stringify({ shown, lineTop }));
await alice.screenshot({ path: "/tmp/opencode/yrs-interop-cursor.png" });

// 4. concurrent edits at the same spot: rust stops reading, both insert at the start of line 3
cmd("pause");
await next((e) => e.ev === "paused");
await alice.click(".mde .ln >> nth=2");
await alice.keyboard.press("Home");
await alice.keyboard.type("[web]");
await until(() => serverText().includes("[web]"));
const at = serverText().indexOf("[web]");
cmd(`replace ${at} ${at} ${JSON.stringify("[rust]")}`);
cmd("resume");
const converged = await until(async () => {
  const t = await rustText();
  return t === serverText() && t.includes("[web]") && t.includes("[rust]") ? t : null;
});
check("concurrent same-spot inserts converge (rust == server)", !!converged, `${JSON.stringify(await rustText())}\n${JSON.stringify(serverText())}`);
const both = converged && (converged.includes("[web][rust]") || converged.includes("[rust][web]"));
check("both inserts adjacent, nothing lost", !!both, converged);
check("browser converges too", !!(await until(async () => {
  const d = await domText();
  return d.includes("[web][rust]") || d.includes("[rust][web]");
})), await domText());

// 5. rust undo/redo with an interleaved browser edit
cmd("stop");
cmd(`append ${JSON.stringify("\nUndo me (rust).")}`);
cmd("stop");
await until(() => serverText().includes("Undo me (rust)."));
await alice.click(".mde .ln >> nth=0");
await alice.keyboard.press("End");
await alice.keyboard.type(" +web");
await next((e) => e.ev === "remote" && e.text.includes("+web"));
cmd("undo");
const u = await next((e) => e.ev === "undo");
check("rust undo removes only its own last group", !!u && u.done && !u.text.includes("Undo me") && u.text.includes("+web") && u.text.includes("[rust]"), JSON.stringify(u));
check("browser sees the undo", !!(await until(async () => !(await domText()).includes("Undo me"))));
cmd("redo");
const rd = await next((e) => e.ev === "redo");
check("rust redo brings it back", !!rd && rd.done && rd.text.includes("Undo me (rust).") && rd.text.includes("+web"), JSON.stringify(rd));
check("browser sees the redo", !!(await until(async () => (await domText()).includes("Undo me (rust)."))));
check("server == rust after undo/redo", !!(await until(async () => serverText() === (await rustText()))));

// 6. the server commits the merged text to git
cmd("flush");
const committed = await until(async () => {
  const head = await app.ctx.store.head("notes", "main");
  const c = await app.ctx.store.readFile("notes", "Welcome.md", head);
  return c && c === serverText() && c.includes("From Rust!") ? c : null;
}, 10000);
check("server commits the merged text", !!committed);
const hist = await app.ctx.store.history("notes", "main", "Welcome.md", 3);
console.log("     commits:", JSON.stringify(hist.map((h) => h.message)));
check("commit credits both people", hist.some((h) => /Rusty|Alice/.test(JSON.stringify(h))), JSON.stringify(hist));

cmd("quit");
await next((e) => e.ev === "bye", 3000);
const left = await until(() => alice.evaluate(() => !document.querySelector(".rcaret")));
check("rust client's cursor disappears when it leaves", !!left);
console.log("     final text:\n" + serverText().split("\n").map((l) => "     | " + l).join("\n"));

rust.kill();
await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);

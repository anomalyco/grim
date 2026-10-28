// End-to-end: images dropped onto a note or pasted into it are uploaded into the notebook and their Markdown is
// inserted there, through the real server: the drop caret, the insert point, the image showing (for a second person
// too), undo in one step, a pasted screenshot, a non-image file, and a read-only folder that can't take a drop.
// Usage: bun run build:client && bun test/e2e/images.mjs
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { startTarget } from "./target.mjs";

// TARGET=workers runs it against wrangler dev (see target.mjs); REPO_CACHE=0 so making the folder read-only shows at once.
const T = await startTarget({ env: { QUIET_MS: "1500", REPO_CACHE: "0" } });
const base = T.base;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function user(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  page.on("console", (m) => m.type() === "error" && !/40[13]/.test(m.text()) && console.log(`[${name}] CONSOLE`, m.text()));
  await page.goto(`${base}/auth/dev?next=${T.appPath}`);
  await page.fill("input[name=name]", name);
  await page.click("form button[type=submit], form button");
  await page.waitForURL(/\/app\//, { timeout: 10000 });
  return { page };
}

const api = (page, method, path, body) =>
  page.evaluate(
    async ([method, path, body]) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, path, body],
  );

const alice = await user("Alice");
const bob = await user("Bob");
const carol = await user("Carol");
const ws = (await api(alice.page, "POST", "/api/workspaces", { title: "Pics" })).body.id;
const initial = "# Pics\nFirst line here\nSecond line\n";
check("note created", (await api(alice.page, "POST", `/api/repos/${ws}/files`, { path: "Pics.md", content: initial })).status === 201);

async function open(page) {
  await page.goto(`${base}/app/${ws}/Pics.md`);
  await page.waitForFunction(() => document.querySelector(".mde")?.mdeView?.doc.text.includes("Second line"), null, { timeout: 10000 });
}
for (const p of [alice.page, bob.page, carol.page]) await open(p);
const A = alice.page;

const text = (page) => page.evaluate(() => document.querySelector(".mde").mdeView.doc.text);
const sel = (page) => page.evaluate(() => ({ ...document.querySelector(".mde").mdeView.sel }));

/** Client point of the boundary after `before` in the line containing it (and that raw offset). */
const pointAfter = (page, before) =>
  page.evaluate((before) => {
    const v = document.querySelector(".mde").mdeView;
    const walker = document.createTreeWalker(v.root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(before);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + before.length);
      r.setEnd(n, i + before.length);
      const rect = r.getBoundingClientRect();
      return { x: rect.left, y: (rect.top + rect.bottom) / 2, offset: v.doc.text.indexOf(before) + before.length };
    }
    return null;
  }, before);

/** Dispatch drag events with files on the editor at (x, y): `types` of "enter" | "over" | "leave" | "drop". */
const drag = (page, at, files, types) =>
  page.evaluate(
    ([at, files, types, b64]) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const bytes = f.png ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(f.text ?? "hello");
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      const root = document.querySelector(".mde-content");
      for (const t of types) root.dispatchEvent(new DragEvent(t === "enter" ? "dragenter" : t === "over" ? "dragover" : t === "leave" ? "dragleave" : "drop", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, dataTransfer: dt }));
      const c = document.querySelector(".mde .drop-caret");
      return c ? { left: c.getBoundingClientRect().left, height: c.getBoundingClientRect().height } : null;
    },
    [at, files, types, PNG_B64],
  );

// ---- drop ----
await A.click(".mde .ln >> nth=2");
await A.keyboard.press("End");
const before = await sel(A);
const at = await pointAfter(A, "First");
const caret = await drag(A, at, [{ name: "dot one.png", type: "image/png", png: true }], ["enter", "over"]);
check("dragover with an image shows the drop caret at the hit text position", !!caret && Math.abs(caret.left - at.x) < 3 && caret.height > 5, JSON.stringify({ caret, at }));
if (process.env.SHOTS) await A.screenshot({ path: `${process.env.SHOTS}/drop-caret.png`, clip: { x: at.x - 200, y: at.y - 80, width: 500, height: 160 } });
check("the selection doesn't move while dragging", JSON.stringify(await sel(A)) === JSON.stringify(before));
const left = await drag(A, { x: 5, y: 5 }, [{ name: "dot one.png", type: "image/png", png: true }], ["leave"]);
check("leaving hides the drop caret", left === null);
// (uploads held back a moment, to see the upload mark)
await A.route("**/images?**", async (route) => (await new Promise((r) => setTimeout(r, 400)), route.continue()));
await drag(A, at, [{ name: "dot one.png", type: "image/png", png: true }], ["over", "drop"]);
check("an upload mark shows at the drop point meanwhile", await A.$(".mde .drop-pending").then((e) => !!e));
if (process.env.SHOTS) await A.screenshot({ path: `${process.env.SHOTS}/drop-pending.png`, clip: { x: at.x - 200, y: at.y - 80, width: 500, height: 160 } });
const md = "![dot one](images/dot%20one.png)";
const expected = initial.slice(0, at.offset) + md + initial.slice(at.offset);
await A.waitForFunction((t) => document.querySelector(".mde").mdeView.doc.text === t, expected, { timeout: 10000 }).then(
  () => check("the Markdown is inserted at the drop point", true),
  async () => check("the Markdown is inserted at the drop point", false, JSON.stringify(await text(A))),
);
await A.unroute("**/images?**");
const after = await sel(A);
check("the caret is after the inserted Markdown", after.anchor === at.offset + md.length && after.head === after.anchor, JSON.stringify(after));
check("no drop caret or upload mark left", (await A.$$(".mde .drop-caret, .mde .drop-pending")).length === 0);
const loaded = (page) => page.waitForFunction(() => [...document.querySelectorAll(".mde img")].some((i) => i.complete && i.naturalWidth === 1 && i.src.includes("raw?path=images%2Fdot")), null, { timeout: 10000 }).then(() => true, () => false);
check("the image renders (from the raw endpoint)", await loaded(A));
check("Bob sees the Markdown and the image", (await bob.page.waitForFunction((t) => document.querySelector(".mde").mdeView.doc.text === t, expected, { timeout: 10000 }).then(() => true, () => false)) && (await loaded(bob.page)));
const hist = await api(A, "GET", `/api/repos/${ws}/history?limit=20`);
check("the image has its own commit by Alice", hist.body.some((c) => c.message === "Add images/dot one.png" && c.authorName === "Alice"), JSON.stringify(hist.body));

// ---- undo: one step ----
await A.keyboard.press("Control+z");
await A.waitForFunction((t) => document.querySelector(".mde").mdeView.doc.text === t, initial, { timeout: 5000 }).then(
  () => check("undo removes the image in one step", true),
  async () => check("undo removes the image in one step", false, JSON.stringify(await text(A))),
);
await A.keyboard.press("Control+Shift+z");
await A.waitForFunction((t) => document.querySelector(".mde").mdeView.doc.text === t, expected, { timeout: 5000 }).then(() => check("redo brings it back", true), () => check("redo brings it back", false));

// ---- two images at once, the same one again (reused), one line each ----
const two = await pointAfter(A, "Second line");
await drag(A, two, [{ name: "dot one.png", type: "image/png", png: true }, { name: "b.png", type: "image/png", png: true }, { name: "notes.txt", type: "text/plain" }], ["over", "drop"]);
const twoMd = "![dot one](images/dot%20one.png)\n![b](images/b.png)";
await A.waitForFunction((s) => document.querySelector(".mde").mdeView.doc.text.includes(s), "Second line" + twoMd, { timeout: 10000 }).then(
  () => check("several images: one per line, identical file reused", true),
  async () => check("several images: one per line, identical file reused", false, JSON.stringify(await text(A))),
);
check("non-image files are skipped with a toast", await A.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("notes.txt")), null, { timeout: 5000 }).then(() => true, () => false));

// ---- paste a screenshot ----
await A.evaluate(() => {
  const v = document.querySelector(".mde").mdeView;
  const p = v.doc.text.indexOf("# Pics") + "# Pics".length;
  v.focus();
  v.setSel({ anchor: p, head: p });
});
const pasteAt = (await sel(A)).head;
const before2 = await text(A);
await A.evaluate((b64) => {
  const dt = new DataTransfer();
  dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
  document.querySelector(".mde-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, PNG_B64);
const pasted = before2.slice(0, pasteAt) + "![image](images/image.png)" + before2.slice(pasteAt);
await A.waitForFunction((t) => document.querySelector(".mde").mdeView.doc.text === t, pasted, { timeout: 10000 }).then(
  () => check("a pasted image is uploaded and inserted at the caret", true),
  async () => check("a pasted image is uploaded and inserted at the caret", false, JSON.stringify(await text(A))),
);
// text paste unchanged
await A.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData("text/plain", "plain words");
  document.querySelector(".mde-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
check("text paste still pastes text", (await text(A)).includes("![image](images/image.png)plain words"));

// ---- a read-only folder can't take a drop ----
// opening a note asks the raw endpoint only for image files: `![…](Pics.md)` shows the placeholder, no 415
{
  await api(A, "POST", `/api/repos/${ws}/files`, { path: "Refs.md", content: "# Refs\n![a note](Pics.md)\n\n![dot](images/b.png)\n" });
  const raw = [];
  const bad = [];
  const onReq = (r) => r.url().includes("/raw?") && raw.push(decodeURIComponent(new URL(r.url()).searchParams.get("path")));
  const onRes = (r) => r.status() >= 400 && bad.push(`${r.status()} ${r.url()}`);
  A.on("request", onReq);
  A.on("response", onRes);
  await A.goto(`${base}/app/${ws}/Refs.md`);
  await A.waitForFunction(() => document.querySelectorAll(".mde .imgbox").length === 2 && !document.querySelector(".mde .imgbox.loading"), null, { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  A.off("request", onReq);
  A.off("response", onRes);
  check("opening a note: only image files are requested raw", JSON.stringify(raw) === JSON.stringify(["images/b.png"]), JSON.stringify(raw));
  check("opening a note: no failed requests", bad.length === 0, JSON.stringify(bad));
  check("a non-image file shows the placeholder", await A.evaluate(() => document.querySelectorAll(".mde .imgbox.broken").length === 1));
}

await T.sql(`UPDATE repos SET read_only = 1 WHERE id = '${ws}'`);
const C = carol.page;
await open(C);
await C.waitForFunction((t) => document.querySelector(".mde").mdeView.doc.text.includes(t), "plain words", { timeout: 10000 }).catch(() => {});
const cText = await text(C);
const cat = await pointAfter(C, "First");
const cCaret = await drag(C, cat, [{ name: "carol.png", type: "image/png", png: true }], ["over"]);
check("read-only: no drop caret", cCaret === null);
await drag(C, cat, [{ name: "carol.png", type: "image/png", png: true }], ["drop"]);
await new Promise((r) => setTimeout(r, 1000));
check("read-only: a drop changes nothing", (await text(C)) === cText);
check("read-only: nothing uploaded", !(await T.exists(ws, "images/carol.png")) && (await T.exists(ws, "images/b.png")));
check("images stay out of the sidebar's tree", (await api(A, "GET", `/api/repos/${ws}/tree`)).body.files.every((f) => f.endsWith(".md")));

await browser.close();
await T.stop();
console.log(fails ? `${fails} failed` : "all ok");
process.exit(fails ? 1 : 0);

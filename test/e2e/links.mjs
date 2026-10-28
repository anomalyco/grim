// End-to-end: clicking links in a note (scratch server): a relative link navigates to the other note in the app,
// a #fragment scrolls to its heading, a missing note offers "Create it", an external link opens a new tab, same-origin
// /app/ URLs stay in the app, links leaving the notebook do nothing. Screenshots to /tmp/opencode/links/.
// Usage: bun run build:client && bun test/e2e/links.mjs
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "np-e2e-"));
process.env.DATA_DIR = dataDir;
process.env.ALLOW_DEV_LOGIN = "1";
process.env.QUIET_MS = "1500";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;
const shots = "/tmp/opencode/links";
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};

const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
await ctx.route("https://example.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>ext</title>external" }));
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => m.type() === "error" && !/401|404/.test(m.text()) && console.log("CONSOLE", m.text()));
await page.goto(base + "/auth/dev?next=/app");
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit], form button");
await page.waitForURL(/\/app\//, { timeout: 10000 });
await page.waitForSelector(".mde .ln", { timeout: 10000 });

const filler = Array.from({ length: 50 }, (_, i) => `Line ${i} of the second note.`).join("\n");
const files = {
  "Links.md": [
    "# Links",
    "To [the second note](Second.md) and [its part two](./Second.md#Part%20two).",
    "Plan: [plan](sub/plan) · missing: [nope](Nope.md) · outside: [up](../x.md)",
    "External: [example](https://example.com/page) · app URL: [in app](" + base + "/app/notes/sub/plan.md)",
    "Image file: [picture](pic.png) · here: [down](#bottom)",
    filler,
    "## Bottom",
    "the end",
    "",
  ].join("\n"),
  "Second.md": ["# Second", "The second note.", filler, "## Part two", "here", ""].join("\n"),
  "sub/plan.md": ["# Plan", "The plan. Back: [links](../Links.md)", ""].join("\n"),
};
for (const [path, content] of Object.entries(files)) {
  await page.evaluate(([path, content]) => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content }) }), [path, content]);
}

const view = () => page.evaluate(() => !!document.querySelector(".mde")?.mdeView);
const noteText = async (want) =>
  page.waitForFunction((w) => document.querySelector(".mde")?.mdeView?.doc.text.includes(w), want, { timeout: 8000 }).then(() => true, () => false);
const open = async (path) => {
  await page.goto(`${base}/app/notes/${path}`);
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
  await noteText("#");
};
/** Click the link whose text is `label`. */
const clickLink = async (label) => {
  const loc = page.locator(".mde .t.link", { hasText: label }).first();
  await loc.click();
};
const sel = () => page.evaluate(() => { const v = document.querySelector(".mde").mdeView; return [v.sel.anchor, v.sel.head]; });

await open("Links.md");
check("note shows its links collapsed with pencils", (await page.locator(".mde .chip svg").count()) >= 8);
await page.locator(".mde .ln").nth(1).screenshot({ path: shots + "/collapsed.png" });
await page.locator(".mde .t.link", { hasText: "the second note" }).hover();
check("hover: pointer + URL tooltip", (await page.evaluate(() => [getComputedStyle(document.querySelector(".mde-content")).cursor, document.querySelector(".mde-content").title])).join() === "pointer,Second.md");
await page.locator(".mde .ln").nth(1).screenshot({ path: shots + "/hover-link.png" });
await page.locator(".mde .chip").first().hover();
await page.locator(".mde .ln").nth(1).screenshot({ path: shots + "/hover-pencil.png" });
await page.locator(".mde .chip").first().click();
check("pencil expands the link (its brackets and URL shown)", (await page.locator(".mde .mk.link.rv").count()) === 4);
await page.locator(".mde .ln").nth(1).screenshot({ path: shots + "/revealed.png" });
await page.screenshot({ path: shots + "/note.png" });

// a relative link to another note: navigates in the app
await open("Links.md");
await clickLink("the second note");
await page.waitForURL(`${base}/app/notes/Second.md`, { timeout: 5000 }).catch(() => {});
check("relative link: URL /app/notes/Second.md", page.url() === `${base}/app/notes/Second.md`, page.url());
check("relative link: the other note's content", await noteText("The second note."));

// back, then the #fragment link: navigates and scrolls to the heading
await page.goBack();
await noteText("[the second note]");
check("back: Links again", page.url() === `${base}/app/notes/Links.md`, page.url());
await clickLink("its part two");
await page.waitForURL(/Second\.md#/, { timeout: 5000 }).catch(() => {});
check("#fragment link: URL with the hash", page.url() === `${base}/app/notes/Second.md#Part%20two`, page.url());
await noteText("Part two");
await page.waitForTimeout(200);
const atHeading = await page.evaluate(() => {
  const v = document.querySelector(".mde").mdeView;
  const h = v.doc.text.indexOf("## Part two") + 3;
  const r = [...document.querySelectorAll(".mde .ln-heading")].pop().getBoundingClientRect();
  return [v.sel.head === h, r.top >= 0 && r.bottom <= innerHeight];
});
check("#fragment link: caret at the heading, scrolled into view", atHeading.join() === "true,true", JSON.stringify(atHeading));

// no extension -> .md, in a folder
await open("Links.md");
await clickLink("plan");
await page.waitForURL(`${base}/app/notes/sub/plan.md`, { timeout: 5000 }).catch(() => {});
check("link without extension: sub/plan.md", page.url() === `${base}/app/notes/sub/plan.md` && (await noteText("The plan.")), page.url());
// ../ from the folder
await clickLink("links");
await page.waitForURL(`${base}/app/notes/Links.md`, { timeout: 5000 }).catch(() => {});
check("../ link back to Links.md", page.url() === `${base}/app/notes/Links.md` && (await noteText("[nope]")), page.url());

// #heading in the same note
await clickLink("down");
await page.waitForTimeout(200);
const bottom = await page.evaluate(() => {
  const v = document.querySelector(".mde").mdeView;
  return [v.sel.head === v.doc.text.indexOf("## Bottom") + 3, location.pathname];
});
check("#heading: caret at it, same note", bottom.join() === "true,/app/notes/Links.md", JSON.stringify(bottom));

// the caret and the text don't change on a click that opens; external: a new tab
await open("Links.md");
const before = await sel();
const [ext] = await Promise.all([ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null), clickLink("example")]);
if (ext) await ext.waitForLoadState().catch(() => {});
check("external link: new tab with the URL", ext?.url() === "https://example.com/page", ext?.url());
check("external link: this tab stays, caret unchanged, source hidden", page.url() === `${base}/app/notes/Links.md` && (await sel()).join() === before.join() && (await page.locator(".mde .mk.link.rv").count()) === 0);
await ext?.close();

// a same-origin /app/ URL: in the app, no new tab
let popped = false;
const onPage = () => (popped = true);
ctx.on("page", onPage);
await clickLink("in app");
await page.waitForURL(`${base}/app/notes/sub/plan.md`, { timeout: 5000 }).catch(() => {});
check("same-origin /app/ URL: navigates in the app", page.url() === `${base}/app/notes/sub/plan.md` && (await noteText("The plan.")) && !popped, page.url());
ctx.off("page", onPage);

// a link leaving the notebook: nothing (a toast)
await open("Links.md");
await clickLink("up");
await page.waitForTimeout(300);
check("outside the notebook: stays, toast", page.url() === `${base}/app/notes/Links.md` && (await page.locator(".toast", { hasText: "outside this notebook" }).count()) === 1, page.url());

// another file type: the raw file in a new tab
const [raw] = await Promise.all([ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null), clickLink("picture")]);
await raw?.waitForLoadState().catch(() => {});
check("other file: raw endpoint in a new tab", !!raw && raw.url() === `${base}/api/repos/notes/raw?path=pic.png`, raw?.url());
await raw?.close();

// a missing note: toast with "Create it", which creates it and opens it
await clickLink("nope");
const t = page.locator(".toast", { hasText: "No note at “Nope.md”" });
await t.waitFor({ timeout: 3000 }).catch(() => {});
check("missing note: toast", (await t.count()) === 1);
await page.waitForTimeout(300);
await page.locator(".toasts").screenshot({ path: shots + "/missing-toast.png" });
check("missing note: still on Links", page.url() === `${base}/app/notes/Links.md`, page.url());
await t.locator("button", { hasText: "Create it" }).click();
await page.waitForURL(`${base}/app/notes/Nope.md`, { timeout: 5000 }).catch(() => {});
check("Create it: navigates to the new note", page.url() === `${base}/app/notes/Nope.md`, page.url());
const tree = await page.evaluate(() => fetch("/api/repos/notes/tree").then((r) => r.json()));
check("Create it: the note exists", tree.files.includes("Nope.md"), JSON.stringify(tree));

// a linked image: a click on the image opens the link, the pencil after it reveals it
{
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" rx="8" fill="#6a9fb5"/></svg>');
  const content = `# Image link\n[![a picture](data:image/svg+xml,${svg})](Second.md)\nafter`;
  await page.evaluate((content) => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Img.md", content }) }), content);
  await open("Img.md");
  await page.waitForFunction(() => document.querySelector(".mde .imgbox img")?.dataset.state === "ok", null, { timeout: 5000 }).catch(() => {});
  await page.locator(".mde .ln").nth(1).screenshot({ path: shots + "/linked-image.png" });
  await page.locator(".mde .imgbox").click();
  await page.waitForURL(`${base}/app/notes/Second.md`, { timeout: 5000 }).catch(() => {});
  check("linked image: click opens the link", page.url() === `${base}/app/notes/Second.md`, page.url());
  await open("Img.md");
  await page.locator(".mde .img-chip").click();
  check("linked image: pencil reveals it", await page.evaluate(() => document.querySelectorAll(".mde .ln")[1].classList.contains("img-rv")));
  await page.locator(".mde .ln").nth(1).screenshot({ path: shots + "/linked-image-revealed.png" });
}

// the arrows walk through a collapsed link without expanding it; its pencil expands it and the URL is editable text:
// typed into, then (collapsed again) a click opens the new URL
{
  await page.evaluate(() => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Edit.md", content: "# Edit\nRead [the docs](https://example.com/docs) first.\nnext line\n" }) }));
  await open("Edit.md");
  const v = () => page.evaluate(() => { const v = document.querySelector(".mde").mdeView; return [v.sel.head, document.querySelectorAll(".mde .mk.link.rv").length, v.doc.text]; });
  await page.evaluate(() => { const v = document.querySelector(".mde").mdeView; const p = v.doc.text.indexOf("Read") + 5; v.apply(v.engine.set_selection(p, p)); });
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
  const [h, shown, text] = await v();
  check("arrows through a collapsed link: no reveal", shown === 0 && h === text.indexOf(" first."), JSON.stringify([h, shown]));
  await page.locator(".mde .chip").first().click();
  const end = (await v())[2].indexOf("](");
  check("pencil: caret at the end of the link text", (await v())[0] === end && (await v())[1] === 4);
  for (let i = 0; i < 2 + "https://example.com/docs".length; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.type("/v2");
  await page.waitForTimeout(200);
  check("the URL is edited", (await v())[2].includes("[the docs](https://example.com/docs/v2) first."), (await v())[2]);
  const box = await page.evaluate(() => {
    const ls = document.querySelectorAll(".mde .ln");
    const a = ls[0].getBoundingClientRect();
    const b = ls[2].getBoundingClientRect();
    return { x: Math.max(0, a.x - 24), y: Math.max(0, a.y - 16), width: Math.max(a.width, 560) + 48, height: b.bottom - a.y + 32 };
  });
  await page.screenshot({ path: shots + "/editable-url.png", clip: box });
  await page.keyboard.press("ArrowDown");
  check("leaving collapses it", (await v())[1] === 0);
  await page.waitForTimeout(600);
  const [tab] = await Promise.all([ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null), clickLink("the docs")]);
  await tab?.waitForLoadState().catch(() => {});
  check("a click opens the new URL", tab?.url() === "https://example.com/docs/v2", tab?.url());
  await tab?.close();
}

console.log(fails ? `${fails} FAILED` : "all passed");
await browser.close();
await app.stop();
rmSync(dataDir, { recursive: true, force: true });
process.exit(fails ? 1 : 0);

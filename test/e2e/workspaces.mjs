// End-to-end: folders (workspaces) in the web app — every folder is public: the switcher (joined folders only, the
// Open… and New… dialogs, leave), the folder-scoped sidebar, the agent card, Google sign-in (a fake provider), visitors who aren't signed in on
// any /app link, removing (its maker only), and the Mac app's sign-in (/auth/google/start).
// Usage: bun run build:client && bun test/e2e/workspaces.mjs   (screenshots in /tmp/opencode/workspaces/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync } from "node:fs";
import { fakeGoogleEnv, startFakeGoogle } from "./fake-google.mjs";
import { startTarget } from "./target.mjs";

const SHOTS = "/tmp/opencode/workspaces";
mkdirSync(SHOTS, { recursive: true });

// The server's public URL must be known before it loads (Google's redirect URI): pick a free port first.
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);
const fake = await startFakeGoogle();
// TARGET=workers runs it against wrangler dev (see target.mjs); the shared notebook is `WS` ("notes" on Bun), also in
// pages. Hosted has no notebook everyone joins, so there people open it once right after signing in.
const T = await startTarget({ port, env: { ...fakeGoogleEnv(fake), QUIET_MS: "1500", PUBLIC_URL: `http://localhost:${port}` } });
const base = T.base;
const WS = T.ws;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

async function context(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript((ws) => (globalThis.WS = ws), WS);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  return { ctx, page };
}

/** Sign in with the fake Google from the home page's "Sign in" (Continue with Google in the dialog). */
async function googleUser(name, email) {
  const { page } = await context(name);
  if (T.bun) {
    await page.goto(base + "/");
    await page.click(".home-cta .cta-signin");
  } else {
    // from the shared notebook's sidebar (Sign in comes back to it), so it's in the list like Bun's default one
    await page.goto(`${base}${T.appPath}`);
    await page.waitForSelector(".sb-account");
    await page.click(".sb-account");
  }
  // Sign in goes straight to Google
  await page.waitForURL(/\/auth$|\/auth\?/, { timeout: 10000 });
  await page.fill("#email", email);
  await page.fill("#name", name);
  await page.click("#go");
  await page.waitForURL(/\/app/, { timeout: 10000 });
  return page;
}

/** A new account through the test sign-in (/auth/dev: test servers only, no UI). */
async function nameUser(name, at = T.appPath) {
  const { page } = await context(name);
  await page.goto(`${base}/auth/dev?next=${encodeURIComponent(at)}`);
  await page.fill("input[name=name]", name);
  await page.click("form button[type=submit]");
  await page.waitForURL(/\/app/, { timeout: 10000 });
  return page;
}

const api = (page, method, url, body) =>
  page.evaluate(async ([method, url, body]) => {
    const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [method, url, body]);

async function openSwitcher(page) {
  await page.click(".ws-switcher");
  await page.waitForSelector(".ws-menu", { timeout: 5000 });
}
/** The switcher's folder rows: name, any detail text, the open dot, the ×'s aria-label, and the heading above. */
const switcherItems = (page) =>
  page.$$eval(".ws-menu .menu-item[role=menuitemradio]", (els) =>
    els.map((e) => {
      let s = e.parentElement.classList.contains("menu-row") ? e.parentElement : e;
      while (s && !s.classList.contains("menu-section")) s = s.previousElementSibling;
      const x = e.nextElementSibling?.classList.contains("menu-remove") ? e.nextElementSibling : null;
      return { label: e.querySelector(".menu-label")?.textContent, detail: e.querySelector(".menu-detail")?.textContent ?? "", on: e.getAttribute("aria-checked") === "true", x: x?.getAttribute("aria-label") ?? null, section: s?.textContent ?? null };
    }),
  );
const clickX = (page, label) => page.click(`.ws-menu .menu-row:has(.menu-label:text-is("${label}")) .menu-remove`);
/** × on a row, then the confirm dialog's Remove. */
async function removeX(page, label) {
  await clickX(page, label);
  await page.waitForSelector("dialog[open]", { timeout: 5000 });
  await page.click('dialog[open] .modal-actions button:text-is("Remove")');
}
const closeMenu = (page) => page.keyboard.press("Escape");
const switcherTitle = (page) => page.$eval(".ws-switcher .ws-title", (e) => e.textContent).catch(() => null);
const treeFiles = (page) => page.$$eval(".sb-tree .file-row", (els) => els.map((e) => e.getAttribute("href")));
async function menuClick(page, label) {
  await page.click(`.ws-menu .menu-item:has(.menu-label:text-is("${label}"))`);
}
const RENAME_SHOTS = `${SHOTS}/rename`;
mkdirSync(RENAME_SHOTS, { recursive: true });
/** Switcher → Open… → one of the dialog's choices ("open-remote", "open-github"). */
async function openDialog(page, choice) {
  await openSwitcher(page);
  await menuClick(page, "Open…");
  await page.waitForSelector("dialog.open-modal", { timeout: 5000 });
  await page.click(`dialog .open-choice[data-choice="${choice}"]`);
}
const PANE = "dialog .open-pane:not([hidden])";

// The first account ever created: an ordinary account (there are no admins).
const root = await nameUser("Root");
await root.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
const secret = await api(root, "POST", "/api/workspaces", { title: "Secret" });
check("the first account creates a folder", secret.status === 201 && /^secret-[a-z2-9]{4}$/.test(secret.body.id), JSON.stringify(secret));
// Typing the same name again makes a new account with that name, never the first one.
const rootAgain = await nameUser("Root");
await rootAgain.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
const [rootMe, againMe] = [await api(root, "GET", "/api/me"), await api(rootAgain, "GET", "/api/me")];
check("the test sign-in with a taken name is a different account", againMe.body?.name === "Root" && againMe.body?.id !== rootMe.body?.id, JSON.stringify([rootMe.body, againMe.body]));
check("…which can open the first one's folder (every folder is public) but not remove it", (await api(rootAgain, "GET", `/api/repos/${secret.body.id}/tree`)).status === 200 && (await api(rootAgain, "GET", `/api/workspaces/${secret.body.id}`)).body?.canRemove === false);

// ---- Google sign-in, the switcher, the workspace-scoped sidebar ----
const alice = await googleUser("Alice", "alice@example.com");
await alice.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
check("Google sign-in lands in the app", await alice.waitForURL((u) => u.pathname.startsWith(`/app/${WS}/`), { timeout: 10000 }).then(() => true, () => false), alice.url());
check("switcher shows the workspace and the server", (await until(alice, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Notes")) && (await alice.$eval(".ws-host", (e) => e.textContent)) === `localhost:${port}`, JSON.stringify([await switcherTitle(alice), await alice.$eval(".ws-host", (e) => e.textContent).catch(() => null)]));
const me = await api(alice, "GET", "/api/me");
check("signed in as the Google account", me.body?.email === "alice@example.com", JSON.stringify(me.body));

// The Open… dialog: one menu item instead of Add remote folder / New remote folder / Add GitHub repo
await openSwitcher(alice);
{
  const labels = await alice.$$eval(".ws-menu .menu-label", (els) => els.map((e) => e.textContent));
  check("menu: New… directly above Open…", labels.indexOf("New…") >= 0 && labels.indexOf("New…") + 1 === labels.indexOf("Open…"), JSON.stringify(labels));
  check("menu: Open…, and none of the old open/add/create items", labels.includes("Open…") && !labels.some((l) => /^(Add remote folder…|New remote folder…|Add GitHub repo…|New workspace…|Add remote workspace…)$/.test(l)), JSON.stringify(labels));
  await alice.waitForTimeout(300);
  await alice.screenshot({ path: `${RENAME_SHOTS}/switcher-menu.png` });
}
await menuClick(alice, "Open…");
await alice.waitForSelector("dialog.open-modal", { timeout: 5000 });
{
  const d = await alice.$eval("dialog.open-modal", (dlg) => ({
    title: dlg.querySelector(".modal-head h2")?.textContent,
    sections: [...dlg.querySelectorAll(".open-section")].map((e) => e.textContent),
    choices: [...dlg.querySelectorAll(".open-choice")].map((e) => `${e.dataset.choice}:${e.textContent}:${e.getAttribute("aria-selected")}`),
    focused: document.activeElement?.getAttribute("aria-label"),
    submit: dlg.querySelector(".open-pane:not([hidden]) button[type=submit]")?.textContent,
  }));
  check("Open dialog: title, sections, choices (no Create new); URL first with its field focused",
    d.title === "Open workspace" && d.sections.join() === "Open" &&
      d.choices.join() === "open-remote:URL:true,open-github:GitHub repo:false" &&
      d.focused === "URL or workspace name" && d.submit === "Open",
    JSON.stringify(d));
  await alice.waitForTimeout(300);
  await alice.screenshot({ path: `${RENAME_SHOTS}/open-remote-folder.png` });
  await alice.click('dialog .open-choice[data-choice="open-github"]');
  const gh = await alice.evaluate(() => ({ submit: document.querySelector("dialog .open-pane:not([hidden]) button[type=submit]")?.textContent, focused: document.activeElement?.closest(".open-pane")?.id }));
  check("Open dialog: GitHub repo pane (Add, field focused)", gh.submit === "Add" && gh.focused === "open-pane-open-github", JSON.stringify(gh));
  await alice.waitForTimeout(300);
  await alice.screenshot({ path: `${RENAME_SHOTS}/open-github-repo.png` });
  await alice.keyboard.press("Escape");
  check("Open dialog: Esc closes it", await until(alice, () => !document.querySelector("dialog.open-modal")));
}
// New… → the New dialog: just Name + Create; creates on this server (Enter submits)
const NEW = "dialog:has(.new-folder)";
const newDialogState = (page) =>
  page.evaluate((sel) => {
    const d = document.querySelector(sel);
    return d && { title: d.querySelector(".modal-head h2")?.textContent, fields: [...d.querySelectorAll(".field > span")].map((e) => e.textContent), inputs: d.querySelectorAll("input").length, name: d.querySelector('input[aria-label="Name"]')?.value, submit: d.querySelector("button[type=submit]")?.textContent, focused: document.activeElement?.getAttribute("aria-label") };
  }, NEW);
await openSwitcher(alice);
await menuClick(alice, "New…");
await alice.waitForSelector(NEW, { timeout: 5000 });
{
  const c = await newDialogState(alice);
  check("New dialog: title, only a Name field (no Server), Create, Name focused", c?.title === "New workspace" && c.fields.join() === "Name" && c.inputs === 1 && c.name === "" && c.submit === "Create" && c.focused === "Name", JSON.stringify(c));
  const hint = await alice.$eval(`${NEW} .hint`, (e) => e.textContent).catch(() => "");
  check("New dialog: says anyone with the link can open and edit it", hint.includes("Anyone with its link can open and edit it"), hint);
}
await alice.keyboard.type("Alpha");
await alice.waitForTimeout(300);
await alice.screenshot({ path: `${SHOTS}/new-dialog.png` });
await alice.focus(`${NEW} input[aria-label="Name"]`);
await alice.keyboard.press("Enter");
await alice.waitForURL(/\/app\/alpha-[a-z2-9]{4}(\/|$)/, { timeout: 10000 }).catch(() => {});
// The id is the title plus a random suffix (unguessable addresses); read it from the URL the app opened.
const alpha = new URL(alice.url()).pathname.split("/")[2] ?? "";
check("New: created on this server, opens at /app/<title>-<random>", /^alpha-[a-z2-9]{4}$/.test(alpha), alice.url());
await until(alice, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Alpha");
check("switcher shows the new workspace", (await switcherTitle(alice)) === "Alpha");
await alice.evaluate((alpha) => fetch(`/api/repos/${alpha}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Plan.md", content: "# Plan\nAlpha's plan.\n\n![pic](pic.png)\n" }) }), alpha);
await alice.goto(`${base}/app/${alpha}/Plan.md`);
await until(alice, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"));
await until(alice, () => document.querySelectorAll(".sb-tree .file-row").length > 0);
const files = await treeFiles(alice);
check("sidebar shows only the open workspace's tree", files.length > 0 && files.every((f) => f.startsWith(`/app/${alpha}/`)), JSON.stringify(files));

// ---- "Share with an agent": a card pinned below the tree (no menu item) ----
const agentCardState = (page) =>
  page.evaluate(() => {
    const c = document.querySelector(".sidebar .sb-agent");
    if (!c || c.hidden) return null;
    const r = c.getBoundingClientRect(), side = document.querySelector(".sidebar").getBoundingClientRect(), tree = document.querySelector(".sb-tree").getBoundingClientRect();
    const st = getComputedStyle(c);
    const lab = c.querySelector(".sb-agent-label");
    return { label: lab?.textContent, cut: !lab || lab.scrollWidth > lab.clientWidth + 1 || lab.getBoundingClientRect().right > c.querySelector("button").getBoundingClientRect().left, button: c.querySelector("button")?.textContent, last: c.nextElementSibling === c.parentElement.lastElementChild && c.nextElementSibling.classList.contains("sb-account"), belowTree: r.top >= tree.bottom - 1, pinned: side.bottom - r.bottom < 24 + c.nextElementSibling.getBoundingClientRect().height + 8, border: st.borderTopStyle, tinted: st.backgroundColor !== getComputedStyle(document.querySelector(".sidebar")).backgroundColor };
  });
{
  const c = await agentCardState(alice);
  check("agent card: Share this workspace with an agent (whole, not cut off) + Copy, pinned at the bottom of the sidebar below the tree (only the account row under it), tinted, no border", c?.label === "Share this workspace with an agent" && !c.cut && c.button === "Copy" && c.last && c.belowTree && c.pinned && c.border === "none" && c.tinted, JSON.stringify(c));
  await alice.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (t) => void window.__copied.push(t);
  });
  await alice.click(".sb-agent button");
  check("Copy → Copied", await until(alice, () => document.querySelector(".sb-agent button")?.textContent === "Copied"));
  await alice.locator(".sidebar").screenshot({ path: `${SHOTS}/agent-card.png` });
  const copied = await alice.evaluate(() => window.__copied);
  const mine = await api(alice, "POST", `/api/repos/${alpha}/shares`, {});
  const m = /^Work in this Grimoire notebook: (\S+)\nFetch that URL first \(HTTP GET\) for instructions/.exec(copied[0] ?? "");
  check("copies the agent instructions with my agent link for the folder", !!m && new RegExp(`^${base}/a/[0-9a-f-]{36}$`).test(m[1]) && mine.status === 200 && mine.body.url === m[1], JSON.stringify([copied, mine]));
  check("…and the link works for an agent", m ? (await (await fetch(m[1])).text()).includes("Grimoire notebook") : false);
  check("Copied goes back to Copy", await until(alice, () => document.querySelector(".sb-agent button")?.textContent === "Copy", null, 4000));
  await alice.click(".sb-agent button");
  await until(alice, () => window.__copied.length === 2);
  check("a second Copy reuses the same link", (await alice.evaluate(() => window.__copied[1])) === copied[0]);
  await openSwitcher(alice);
  check("no Share with agent… menu item", !(await alice.$('.ws-menu .menu-label:text-is("Share with agent…")')));
  await closeMenu(alice);
}

await openSwitcher(alice);
let items = await switcherItems(alice);
check("switcher lists the joined workspaces only", items.some((i) => i.label === "Alpha" && i.on) && items.some((i) => i.label === "Notes") && !items.some((i) => i.label === "Secret"), JSON.stringify(items));
check("switcher rows show only the name", items.every((i) => i.detail === ""), JSON.stringify(items));
check("every folder has a ×, its maker's too", items.find((i) => i.label === "Alpha")?.x === "Remove Alpha from your list" && items.find((i) => i.label === "Notes")?.x === "Remove Notes from your list", JSON.stringify(items));
check("no Leave folder, Refresh, Share folder… or Settings menu items", await alice.$$eval(".ws-menu .menu-label", (els) => !els.some((e) => /^(Leave folder|Refresh|Share folder…|Settings)$/.test(e.textContent))));
check("no account section or items in the switcher (they're in the account row's menu)", await alice.$$eval(".ws-menu .menu-label, .ws-menu .menu-section", (els) => !els.some((e) => /^(Signed in as|Change name…|Sign out)/.test(e.textContent))));
await alice.waitForTimeout(300);
await alice.screenshot({ path: `${SHOTS}/switcher-open.png` });

// Switching updates the URL and the tree; /app reopens the last workspace + note
await menuClick(alice, "Notes");
await alice.waitForURL((u) => u.pathname.startsWith(`/app/${WS}/`), { timeout: 10000 }).catch(() => {});
check("switching workspaces updates the URL", new URL(alice.url()).pathname.startsWith(`/app/${WS}/`), alice.url());
await until(alice, () => [...document.querySelectorAll(".sb-tree .file-row")].every((a) => a.getAttribute("href").startsWith(`/app/${WS}/`)));
check("switching shows the other workspace's tree", (await treeFiles(alice)).every((f) => f.startsWith(`/app/${WS}/`)));
await openSwitcher(alice);
await menuClick(alice, "Alpha");
await alice.waitForURL(`${base}/app/${alpha}/Plan.md`, { timeout: 10000 }).then(() => check("switching back reopens that workspace's last note", true), () => check("switching back reopens that workspace's last note", false, alice.url()));
await until(alice, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"));
await alice.goto(`${base}/app`);
await alice.waitForURL(`${base}/app/${alpha}/Plan.md`, { timeout: 10000 }).then(() => check("/app opens the last workspace + note", true), () => check("/app opens the last workspace + note", false, alice.url()));
// …also when the note was opened from a warm (already synced) channel: going back to the previous note
{
  await alice.evaluate((alpha) => fetch(`/api/repos/${alpha}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Two.md", content: "# Two\nThe second note.\n" }) }), alpha);
  const lastNote = () => alice.evaluate(() => JSON.parse(localStorage.getItem("grimoire.lastNote.v1") ?? "null")?.path);
  const liveNote = (text) => until(alice, (text) => !!document.querySelector(".editor-host:not(.preview) .mde")?.mdeView?.collab && document.querySelector(".mde").textContent.includes(text), text);
  await until(alice, (alpha) => !!document.querySelector(`.sb-tree .file-row[href="/app/${alpha}/Two.md"]`), alpha);
  await alice.click(`.sb-tree .file-row[href="/app/${alpha}/Two.md"]`);
  await liveNote("The second note");
  await until(alice, () => JSON.parse(localStorage.getItem("grimoire.lastNote.v1") ?? "null")?.path === "Two.md");
  await alice.click(`.sb-tree .file-row[href="/app/${alpha}/Plan.md"]`);
  await liveNote("Alpha's plan");
  check("a note opened from a warm channel (back to the previous one) is the last note at once", (await lastNote()) === "Plan.md", await lastNote());
  await alice.goto(`${base}/app`);
  await alice.waitForURL(`${base}/app/${alpha}/Plan.md`, { timeout: 10000 }).then(() => check("…and /app reopens it", true), () => check("…and /app reopens it", false, alice.url()));
}

// ---- public: anyone signed in opens and edits it by its link; opening it joins it ----
const bob = await googleUser("Bob", "bob@example.com");
await bob.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(bob);
check("Alpha isn't in Bob's list before he opens it", !(await switcherItems(bob)).some((i) => i.label === "Alpha"));
await closeMenu(bob);
await bob.goto(`${base}/app/${alpha}/Plan.md`);
check("anyone opens it by its link, editable", (await until(bob, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"))) && (await until(bob, () => document.querySelector(".save-status")?.textContent === "" && !document.querySelector(".new-note").hidden)));
check("no Share button on notes (the URL is the link)", !(await bob.$(".share-note")) && !(await bob.$('.doc-header button:text-is("Share")')));
check("the agent card is there for everyone", (await agentCardState(bob))?.button === "Copy");
await openSwitcher(bob);
items = await switcherItems(bob);
check("opening it adds it to the switcher, with a ×", items.some((i) => i.label === "Alpha" && i.x === "Remove Alpha from your list"), JSON.stringify(items));
check("someone else's menu has no Remove workspace…", !(await bob.$(`.ws-menu .menu-item:has(.menu-label:text-is("Remove workspace…"))`)));
await closeMenu(bob);
await bob.goto(`${base}/app/nope-zzzz`);
check("a folder that doesn't exist says so", await until(bob, () => document.body.innerText.includes("No such workspace")));

const carol = await nameUser("Carol");
await carol.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await carol.goto(`${base}/app/${alpha}/Plan.md`);
check("another account opens it editable too", (await until(carol, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"))) && (await until(carol, () => document.querySelector(".save-status")?.textContent === "")));

// ---- remove from the list (×): asks first; Cancel keeps it; Remove leaves it and switches away; a link brings it back ----
await openSwitcher(carol);
await clickX(carol, "Alpha");
check("× asks first: Remove Alpha from your list?", await until(carol, () => {
  const d = document.querySelector("dialog[open]");
  return d?.querySelector("h2")?.textContent === "Remove Alpha from your list?" && d.textContent.includes("This doesn't delete the workspace. All existing links to it keep working, and if you open a link to it again, it'll come back to your list.") && [...d.querySelectorAll(".modal-actions button")].map((b) => b.textContent).join(",") === "Cancel,Remove";
}));
await carol.screenshot({ path: `${SHOTS}/remove-confirm.png` });
await carol.click('dialog[open] .modal-actions button:text-is("Cancel")');
check("Cancel keeps it", (await api(carol, "GET", "/api/workspaces")).body.some((w) => w.id === alpha) && carol.url().includes(`/app/${alpha}`));
await openSwitcher(carol);
await removeX(carol, "Alpha");
await carol.waitForURL((u) => !u.pathname.startsWith(`/app/${alpha}`), { timeout: 10000 }).catch(() => {});
check("toast: Removed Alpha from your list", await until(carol, () => [...document.querySelectorAll(".toast")].some((t) => t.textContent === "Removed Alpha from your list")));
await openSwitcher(carol);
items = await switcherItems(carol);
check("after removing the open folder: it's gone and another one is open", !items.some((i) => i.label === "Alpha") && !carol.url().includes(`/app/${alpha}`) && items.some((i) => i.on), JSON.stringify(items) + carol.url());
check("not joined on the server", !(await api(carol, "GET", "/api/workspaces")).body.some((w) => w.id === alpha));
await closeMenu(carol);
await carol.goto(`${base}/app/${alpha}/Plan.md`);
await carol.waitForSelector(".mde .ln", { timeout: 10000 });
check("opening a link to it brings it back", await (async () => { for (let i = 0; i < 50; i++) { if ((await api(carol, "GET", "/api/workspaces")).body.some((w) => w.id === alpha)) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })());

// ---- the only folder in the list can't be removed ----
{
  const dave = await nameUser("Dave");
  await dave.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
  await until(dave, () => true);
  await openSwitcher(dave);
  items = await switcherItems(dave);
  const only = items.filter((i) => i.x);
  check("a new account has one folder in its list", only.length === 1, JSON.stringify(items));
  await clickX(dave, only[0].label);
  check("× on the only workspace: Can't remove your only workspace", await until(dave, () => {
    const d = document.querySelector("dialog[open]");
    return d?.querySelector("h2")?.textContent === "Can't remove your only workspace" && d.textContent.includes("You can't remove the only workspace in your list. Create a new workspace first, then remove this one.") && [...d.querySelectorAll(".modal-actions button")].map((b) => b.textContent).join(",") === "OK,New workspace…";
  }));
  await dave.screenshot({ path: `${SHOTS}/only-folder.png` });
  await dave.click('dialog[open] .modal-actions button:text-is("OK")');
  check("OK keeps it", (await api(dave, "GET", "/api/workspaces")).body.length === 1 && !(await dave.$("dialog[open]")));
  await openSwitcher(dave);
  await clickX(dave, only[0].label);
  await dave.click('dialog[open] .modal-actions button:text-is("New workspace…")');
  check("New folder… opens New", await until(dave, () => document.querySelector("dialog[open] h2")?.textContent === "New workspace"));
  await dave.context().close();
}

// ---- add remote workspace: same server → opens it; other server → remembered + navigates ----
await openDialog(bob, "open-remote");
await bob.fill(`${PANE} input`, "not a link");
await bob.click(`${PANE} button[type=submit]`);
check("add remote: rejects a non-workspace URL", await until(bob, () => !document.querySelector("dialog .open-pane:not([hidden]) .form-error")?.hidden));
await bob.waitForTimeout(300);
await bob.screenshot({ path: `${RENAME_SHOTS}/open-remote-folder-error.png` });
await bob.fill(`${PANE} input`, `${base}/app/${WS}/Welcome.md`);
await bob.keyboard.press("Enter");
await bob.waitForURL((u) => u.pathname === `/app/${WS}/Welcome.md`, { timeout: 10000 }).then(() => check("add remote (same server): opens it", true), () => check("add remote (same server): opens it", false, bob.url()));
await until(bob, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Notes");
await openSwitcher(bob);
items = await switcherItems(bob);
check("add remote (same server): joined", items.some((i) => i.label === "Notes"), JSON.stringify(items));
await closeMenu(bob);
// a folder URL, a note URL with a nested path and encoded spaces (an old /r/ link too), a missing note
await alice.evaluate((alpha) => fetch(`/api/repos/${alpha}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "trips/summer plans/Day one.md", content: "# Day one\nBeach.\n" }) }), alpha);
const openUrl = async (url) => {
  await openDialog(bob, "open-remote");
  await bob.fill(`${PANE} input`, url);
  await bob.keyboard.press("Enter");
};
await openUrl(`${base}/app/${alpha}`);
check("URL: a folder URL opens the folder", await until(bob, (a) => location.pathname.startsWith(`/app/${a}`) && document.querySelector(".ws-switcher .ws-title")?.textContent === "Alpha", alpha));
await openUrl(`${base}/app/${alpha}/trips/summer%20plans/Day%20one.md`);
check("URL: a note URL (nested, encoded spaces) opens that note", await until(bob, (a) => location.pathname === `/app/${a}/trips/summer%20plans/Day%20one.md` && document.querySelector(".mde")?.textContent.includes("Beach."), alpha), bob.url());
await openUrl(`${base}/r/${alpha}/Plan`);
check("URL: an old /r/ link without .md opens the note", await until(bob, (a) => location.pathname === `/app/${a}/Plan.md` && document.querySelector(".mde")?.textContent.includes("Alpha's plan"), alpha), bob.url());
await openUrl(`${base}/app/${alpha}/nope/Missing.md`);
check("URL: a missing note opens the folder and says No note at <path>", await until(bob, (a) => !location.pathname.includes("Missing") && location.pathname.startsWith(`/app/${a}`) && [...document.querySelectorAll(".toast")].some((t) => t.textContent === "No note at “nope/Missing.md”"), alpha), bob.url());
await openDialog(bob, "open-remote");
await bob.fill(`${PANE} input`, `${fake.origin}/app/team-notes`);
await bob.click(`${PANE} button[type=submit]`);
await bob.waitForURL(`${fake.origin}/app/team-notes`, { timeout: 10000 }).then(() => check("add remote (other server): navigates there", true), () => check("add remote (other server): navigates there", false, bob.url()));
await bob.goBack();
await bob.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openUrl(`${fake.origin}/app/team-notes/docs/Read%20me.md`);
await bob.waitForURL(`${fake.origin}/app/team-notes/docs/Read%20me.md`, { timeout: 10000 }).then(() => check("URL (other server): a note URL navigates to that exact note", true), () => check("URL (other server): a note URL navigates to that exact note", false, bob.url()));
await bob.goBack();
await bob.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(bob);
items = await switcherItems(bob);
const otherHost = new URL(fake.origin).host;
check("the other server's workspace is listed under its host, name only", items.some((i) => i.label === "team-notes" && i.detail === "" && i.section === otherHost && i.x === "Remove team-notes from your list"), JSON.stringify(items));
await bob.hover('.ws-menu .menu-row:has(.menu-label:text-is("Alpha"))');
await bob.waitForTimeout(300);
await bob.screenshot({ path: `${SHOTS}/leave-x.png` });
await menuClick(bob, "team-notes");
await bob.waitForURL(`${fake.origin}/app/team-notes`, { timeout: 10000 }).then(() => check("choosing it goes to that server's app", true), () => check("choosing it goes to that server's app", false, bob.url()));
await bob.goBack();
await bob.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(bob);
{
  const calls = [];
  const onReq = (r) => r.url().includes("/api/") && r.method() !== "GET" && calls.push(r.method() + " " + r.url());
  bob.on("request", onReq);
  await removeX(bob, "team-notes");
  await bob.waitForTimeout(300);
  bob.off("request", onReq);
  items = await switcherItems(bob);
  check("× on another server's folder forgets it here, with no server call", !items.some((i) => i.label === "team-notes") && !items.some((i) => i.section === otherHost) && !bob.url().startsWith(fake.origin) && calls.length === 0, JSON.stringify(items) + JSON.stringify(calls));
  check("…and it stays forgotten", await bob.evaluate((o) => !JSON.parse(localStorage.getItem("grimoire.remoteWorkspaces.v1") ?? "[]").some((r) => r.origin === o), fake.origin));
}

// ---- the switcher's order never depends on the open folder: hosts, then names (case-insensitive, natural) ----
{
  const made = [];
  for (const title of ["zeta", "Beta 10", "beta 2", "Gamma"]) made.push((await api(bob, "POST", "/api/workspaces", { title })).body.id);
  await bob.evaluate((o) => localStorage.setItem("grimoire.remoteWorkspaces.v1", JSON.stringify([{ origin: o, workspace: "aaa", title: "aaa", addedAt: 1 }])), "http://a-host.example");
  const order = async (id) => {
    await bob.goto(`${base}/app/${id}`);
    await bob.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
    await until(bob, () => document.querySelector(".ws-switcher .ws-title")?.textContent !== "No folder");
    await openSwitcher(bob);
    const items = await switcherItems(bob);
    await closeMenu(bob);
    return items.map((i) => `${i.section}|${i.label}`);
  };
  const first = await order(made[0]);
  const second = await order(made[2]);
  const third = await order(made[3]);
  check("switcher order is the same whichever folder is open", JSON.stringify(first) === JSON.stringify(second) && JSON.stringify(second) === JSON.stringify(third), JSON.stringify([first, second]));
  const here = first.filter((x) => x.startsWith(`localhost:${port}|`)).map((x) => x.split("|")[1]);
  const want = [...here].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  check("…folders by name, natural and case-insensitive (beta 2 before Beta 10)", JSON.stringify(here) === JSON.stringify(want) && here.indexOf("beta 2") < here.indexOf("Beta 10") && here.indexOf("Beta 10") < here.indexOf("Gamma") && here.indexOf("Gamma") < here.indexOf("zeta"), JSON.stringify(here));
  check("…servers by host name, this one not pinned first", first[0] === "a-host.example|aaa", JSON.stringify(first));
  await bob.evaluate(() => localStorage.removeItem("grimoire.remoteWorkspaces.v1"));
}

// ---- signed out: any /app link opens without an account; the sign-in dialog shows what the server has ----
{
  const { ctx, page } = await context("signed out");
  await page.goto(`${base}/app/${secret.body.id}`);
  check("signed out at a folder: opens it without an account", await until(page, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Secret") && (await page.evaluate(async () => (await fetch("/api/me")).status)) === 401);
  await page.goto(`${base}/app/${WS}/Welcome.md`);
  check("…and a note", await until(page, () => !!document.querySelector(".mde .ln") && document.querySelector(".ws-switcher") !== null));
  check("signed out: no Share with an agent card", await page.$eval(".sb-agent", (el) => el.hidden));
  await ctx.close();
}
{
  const { ctx, page } = await context("sign-in options");
  await page.goto(`${base}/app/${alpha}`);
  await page.waitForSelector(".sb-account");
  const here = await page.evaluate(() => location.pathname);
  const [req] = await Promise.all([page.waitForRequest((r) => r.url().includes("/auth/google?"), { timeout: 10000 }).catch(() => null), page.click(".sb-account")]);
  check("signed out: the folder opens; Sign in goes straight to Google, back to this note", here.startsWith(`/app/${alpha}/`) && req?.url() === `${base}/auth/google?next=${encodeURIComponent(here)}`, req?.url());
  await ctx.close();
}

// ---- the maker may take their own folder off their list too; opening it again rejoins ----
await alice.goto(`${base}/app/${alpha}`);
await alice.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(alice);
await removeX(alice, "Alpha");
await alice.waitForURL((u) => !u.pathname.startsWith(`/app/${alpha}`), { timeout: 10000 }).catch(() => {});
check("the maker's × (confirmed) takes it off the list", !(await alice.$("dialog[open]")) && !(await api(alice, "GET", "/api/workspaces")).body.some((w) => w.id === alpha));
await alice.goto(`${base}/app/${alpha}`);
await alice.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
check("opening it again rejoins", await (async () => { for (let i = 0; i < 50; i++) { if ((await api(alice, "GET", "/api/workspaces")).body.some((w) => w.id === alpha)) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })());

// ---- remove a folder: its maker only ----
const doomed = await api(alice, "POST", "/api/workspaces", { title: "Doomed" });
await alice.goto(`${base}/app/${doomed.body.id}`);
await alice.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(alice);
check("the maker's menu has Remove workspace…", await alice.$(`.ws-menu .menu-item:has(.menu-label:text-is("Remove workspace…"))`).then(Boolean));
await menuClick(alice, "Remove workspace…");
check("the confirmation names the workspace", await until(alice, () => document.querySelector("dialog")?.textContent.includes("Remove workspace") && document.querySelector("dialog")?.textContent.includes("Doomed")));
await alice.click("dialog .btn-danger");
check("removed on the server", await (async () => { for (let i = 0; i < 50; i++) { if ((await api(alice, "GET", `/api/workspaces/${doomed.body.id}`)).status === 404) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })());

// ---- the Mac app's sign-in: /auth/google/start goes straight to Google, then a one-time code on the loopback ----
{
  const { page } = await context("app sign-in");
  const seen = [];
  const loop = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(req.url), new Response("You're signed in")) });
  const cb = `http://127.0.0.1:${loop.port}/callback`;
  const verifier = "e2e-mac-app-verifier-0123456789-abcdefghijklmnop";
  const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
  const state = "e2e-app-state-0123456789";
  await page.goto(`${base}/auth/google/start?${new URLSearchParams({ client: "mac", redirect_uri: cb, state, code_challenge: challenge, code_challenge_method: "S256" })}`);
  check("app sign-in: straight to Google's page (no page of ours)", await page.waitForURL(/\/auth$|\/auth\?/, { timeout: 10000 }).then(() => true, () => false), page.url());
  await page.fill("#email", "mac@example.com");
  await page.fill("#name", "Mac User");
  await page.click("#go");
  await until(page, () => location.href.startsWith("http://127.0.0.1:"));
  const back = new URL(seen.at(-1));
  check("…back on the loopback with a code and the state, never a token", back.searchParams.get("code") && back.searchParams.get("state") === state && !back.searchParams.has("token"), back.href);
  const got = await (await fetch(`${base}/auth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: back.searchParams.get("code"), code_verifier: verifier }) })).json();
  const gme = await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${got.token}` } })).json();
  check("…the code's exchange gives the Google account's token", gme.email === "mac@example.com" && got.email === "mac@example.com" && gme.token?.label === "Grimoire for Mac", JSON.stringify(gme));
  await page.close();
  loop.stop(true);
}

// ---- the account row at the bottom of the sidebar: its menu has Change name… and Sign out ----
{
  await alice.goto(`${base}/app/${WS}`);
  await alice.waitForSelector(".sb-tree .file-row", { timeout: 10000 });
  check("account row shows who's signed in", (await alice.$eval(".sb-account .sb-account-name", (e) => e.textContent)) === "Alice" && !!(await alice.$(".sb-account .avatar")));
  check("account row is the sidebar's last item, below the agent card", await alice.$eval(".sidebar", (s) => s.lastElementChild?.classList.contains("sb-account") && s.querySelector(".sb-agent")?.nextElementSibling === s.lastElementChild));
  await openSwitcher(alice);
  const sw = await alice.$$eval(".ws-menu .menu-label, .ws-menu .menu-section", (els) => els.map((e) => e.textContent));
  check("switcher: no account section or items", !sw.some((l) => /^(Signed in as|Change name…|Settings|Sign out)/.test(l)), JSON.stringify(sw));
  await closeMenu(alice);
  await alice.click(".sb-account");
  await alice.waitForSelector(".account-menu", { timeout: 5000 });
  const m = await alice.$eval(".account-menu", (el) => ({
    sections: [...el.querySelectorAll(".menu-section")].map((e) => e.textContent),
    labels: [...el.querySelectorAll(".menu-label")].map((e) => e.textContent),
    above: el.getBoundingClientRect().bottom <= document.querySelector(".sb-account").getBoundingClientRect().top,
    expanded: document.querySelector(".sb-account").getAttribute("aria-expanded"),
    focused: document.activeElement?.textContent,
  }));
  check("account menu: Change name… and Sign out (and the email above them)", JSON.stringify(m.labels) === JSON.stringify(["Change name…", "Sign out"]) && JSON.stringify(m.sections) === JSON.stringify(["alice@example.com"]), JSON.stringify(m));
  check("account menu opens upward from the row, first item focused", m.above && m.expanded === "true" && m.focused === "Change name…", JSON.stringify(m));
  await alice.waitForTimeout(200);
  await alice.screenshot({ path: `${SHOTS}/account-row.png` });
  await alice.click(".sb-account");
  check("clicking the row again closes it", await until(alice, () => !document.querySelector(".account-menu")));
  await alice.click(".sb-account");
  await alice.click('.account-menu .menu-item:has(.menu-label:text-is("Change name…"))');
  await alice.waitForSelector("dialog[open] input", { timeout: 5000 });
  await alice.fill("dialog[open] input", "Alice B");
  await alice.click("dialog[open] button[type=submit]");
  check("Change name… renames the account row", await until(alice, () => document.querySelector(".sb-account .sb-account-name")?.textContent === "Alice B"));
}

// ---- sign out from the account menu ----
await alice.click(".sb-account");
await alice.click('.account-menu .menu-item:has(.menu-label:text-is("Sign out"))');
await alice.waitForURL(`${base}/`, { timeout: 10000 }).then(() => check("Sign out", true), () => check("Sign out", false, alice.url()));

await browser.close();
await T.stop();
fake.stop();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);

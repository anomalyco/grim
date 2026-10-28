// End-to-end: workspaces in the web app — the switcher (joined workspaces only, the Open… dialog, leave), the
// workspace-scoped sidebar, sharing by email and link access, Google sign-in (a fake provider), the private-workspace
// sign-in screen, note share links, and connected apps in Settings.
// Usage: bun run build:client && bun test/e2e/workspaces.mjs   (screenshots in /tmp/opencode/workspaces/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGoogleEnv, startFakeGoogle } from "./fake-google.mjs";

const SHOTS = "/tmp/opencode/workspaces";
mkdirSync(SHOTS, { recursive: true });

// The server's public URL must be known before it loads (Google's redirect URI): pick a free port first.
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);
const fake = await startFakeGoogle();
fakeGoogleEnv(fake);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-ws-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.ALLOWED_GITHUB_USERS = "*";
process.env.QUIET_MS = "1500";
process.env.PORT = String(port);
process.env.PUBLIC_URL = `http://localhost:${port}`;
const { startServer } = await import("../../src/server/index.ts");
const { createAppToken } = await import("../../src/server/tokens.ts");
const { config } = await import("../../src/server/config.ts");
const app = await startServer({ port, quiet: true });
const base = `http://localhost:${port}`;

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
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  return { ctx, page };
}

/** Sign in with the fake Google from the home page's "or continue with Google". */
async function googleUser(name, email) {
  const { page } = await context(name);
  await page.goto(base + "/");
  await page.click("a.cta-google");
  await page.waitForURL(/\/auth$|\/auth\?/, { timeout: 10000 });
  await page.fill("#email", email);
  await page.fill("#name", name);
  await page.click("#go");
  await page.waitForURL(/\/app/, { timeout: 10000 });
  return page;
}

/** Sign in with a name (the open server's name sign-in). */
async function nameUser(name, at = "/") {
  const { page } = await context(name);
  await page.goto(base + at);
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
const BADGE = /^(owner|editor|viewer|can edit|can view|via link|via domain)$|· domain/i;
const noBadges = (items) => items.every((i) => !BADGE.test(i.detail));
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
check("the first account creates a private workspace", secret.status === 201 && secret.body.linkAccess === "none", JSON.stringify(secret));
// Typing the same name again makes a new account with that name, never the first one.
const rootAgain = await nameUser("Root");
await rootAgain.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
const [rootMe, againMe] = [await api(root, "GET", "/api/me"), await api(rootAgain, "GET", "/api/me")];
check("name sign-in with a taken name is a different account", againMe.body?.name === "Root" && againMe.body?.id !== rootMe.body?.id, JSON.stringify([rootMe.body, againMe.body]));
check("…which can't open the first one's private workspace", (await api(rootAgain, "GET", `/api/repos/${secret.body.id}/tree`)).status === 404 && (await api(rootAgain, "GET", `/api/workspaces/${secret.body.id}`)).status === 404);

// ---- Google sign-in, the switcher, the workspace-scoped sidebar ----
const alice = await googleUser("Alice", "alice@example.com");
await alice.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
check("Google sign-in lands in the app", await alice.waitForURL(/\/app\/notes\//, { timeout: 10000 }).then(() => true, () => false), alice.url());
check("switcher shows the workspace and the server", (await switcherTitle(alice)) === "Notes" && (await alice.$eval(".ws-host", (e) => e.textContent)) === `localhost:${port}`);
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
  check("Open dialog: title, sections, choices (no Create new); Remote folder first with its field focused",
    d.title === "Open" && d.sections.join() === "Open" &&
      d.choices.join() === "open-remote:Remote folder:true,open-github:GitHub repo:false" &&
      d.focused === "Folder URL" && d.submit === "Open",
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
  check("New dialog: title, only a Name field (no Server), Create, Name focused", c?.title === "New" && c.fields.join() === "Name" && c.inputs === 1 && c.name === "" && c.submit === "Create" && c.focused === "Name", JSON.stringify(c));
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
    return { label: c.querySelector(".sb-agent-label")?.textContent, button: c.querySelector("button")?.textContent, last: c === c.parentElement.lastElementChild, belowTree: r.top >= tree.bottom - 1, pinned: side.bottom - r.bottom < 24, border: st.borderTopStyle, tinted: st.backgroundColor !== getComputedStyle(document.querySelector(".sidebar")).backgroundColor };
  });
{
  const c = await agentCardState(alice);
  check("agent card: Share with an agent + Copy, pinned at the bottom of the sidebar below the tree, tinted, no border", c?.label === "Share with an agent" && c.button === "Copy" && c.last && c.belowTree && c.pinned && c.border === "none" && c.tinted, JSON.stringify(c));
  await alice.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (t) => void window.__copied.push(t);
  });
  await alice.click(".sb-agent button");
  check("Copy → Copied", await until(alice, () => document.querySelector(".sb-agent button")?.textContent === "Copied"));
  await alice.locator(".sidebar").screenshot({ path: `${SHOTS}/agent-card.png` });
  const copied = await alice.evaluate(() => window.__copied);
  const links = (await api(alice, "GET", `/api/repos/${alpha}/shares`)).body;
  const m = /^Work in this Grimoire notebook: (\S+)\nFetch that URL first \(HTTP GET\) for instructions/.exec(copied[0] ?? "");
  check("copies the agent instructions with my agent link for the folder", !!m && new RegExp(`^${base}/a/[0-9a-f-]{36}$`).test(m[1]) && links?.length === 1 && links[0].url === m[1], JSON.stringify([copied, links]));
  check("…and the link works for an agent", m ? (await (await fetch(m[1])).text()).includes("Grimoire notebook") : false);
  check("Copied goes back to Copy", await until(alice, () => document.querySelector(".sb-agent button")?.textContent === "Copy", null, 4000));
  await alice.click(".sb-agent button");
  await until(alice, () => window.__copied.length === 2);
  check("a second Copy reuses the same link", (await alice.evaluate(() => window.__copied[1])) === copied[0] && (await api(alice, "GET", `/api/repos/${alpha}/shares`)).body?.length === 1);
  await openSwitcher(alice);
  check("no Share with agent… menu item", !(await alice.$('.ws-menu .menu-label:text-is("Share with agent…")')));
  await closeMenu(alice);
}

await openSwitcher(alice);
let items = await switcherItems(alice);
check("switcher lists the joined workspaces only", items.some((i) => i.label === "Alpha" && i.on) && items.some((i) => i.label === "Notes") && !items.some((i) => i.label === "Secret"), JSON.stringify(items));
check("switcher shows no access badges (Owner, via link)", noBadges(items) && items.every((i) => i.detail === ""), JSON.stringify(items));
check("the sole owner gets no × on their folder; a link-joined one has Leave ×", items.find((i) => i.label === "Alpha")?.x === null && items.find((i) => i.label === "Notes")?.x === "Leave Notes", JSON.stringify(items));
check("no Leave folder menu item", !(await alice.$('.ws-menu .menu-label:text-is("Leave folder")')));
check("folder menu has no Refresh", !(await alice.$('.ws-menu .menu-label:text-is("Refresh")')));
check("owner menu has Share folder…, no Leave", !!(await alice.$('.ws-menu .menu-label:text-is("Share folder…")')) && !(await alice.$('.ws-menu .menu-label:text-is("Leave folder")')));
await alice.waitForTimeout(300);
await alice.screenshot({ path: `${SHOTS}/switcher-open.png` });

// Switching updates the URL and the tree; /app reopens the last workspace + note
await menuClick(alice, "Notes");
await alice.waitForURL(/\/app\/notes\//, { timeout: 10000 }).catch(() => {});
check("switching workspaces updates the URL", /\/app\/notes\//.test(alice.url()), alice.url());
await until(alice, () => [...document.querySelectorAll(".sb-tree .file-row")].every((a) => a.getAttribute("href").startsWith("/app/notes/")));
check("switching shows the other workspace's tree", (await treeFiles(alice)).every((f) => f.startsWith("/app/notes/")));
await openSwitcher(alice);
await menuClick(alice, "Alpha");
await alice.waitForURL(`${base}/app/${alpha}/Plan.md`, { timeout: 10000 }).then(() => check("switching back reopens that workspace's last note", true), () => check("switching back reopens that workspace's last note", false, alice.url()));
await until(alice, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"));
await alice.goto(`${base}/app`);
await alice.waitForURL(`${base}/app/${alpha}/Plan.md`, { timeout: 10000 }).then(() => check("/app opens the last workspace + note", true), () => check("/app opens the last workspace + note", false, alice.url()));

// ---- share by email: invite → the invitee signs in → sees it ----
await openSwitcher(alice);
await menuClick(alice, "Share folder…");
await alice.waitForSelector("dialog .invite-row input", { timeout: 10000 });
await alice.fill("dialog .invite-row input", "bob@example.com");
await alice.click("dialog .invite-row button[type=submit]");
const invited = await until(alice, () => [...document.querySelectorAll("dialog .member")].some((m) => m.dataset.email === "bob@example.com" && m.textContent.includes("Invited")));
await alice.waitForTimeout(300);
await alice.screenshot({ path: `${RENAME_SHOTS}/share-folder.png` });
check("invite shows as pending", invited);
check("with Google sign-in on, no note about it", !(await alice.$("dialog .invite-note")));
await alice.waitForTimeout(300);
await alice.screenshot({ path: `${SHOTS}/share-dialog.png` });

// The first account (and anyone else) can't see Alpha while it's private.
check("a private workspace is invisible to the first account", (await api(root, "GET", `/api/workspaces/${alpha}`)).status === 404 && (await api(root, "GET", `/api/repos/${alpha}/tree`)).status === 404 && !(await api(root, "GET", "/api/workspaces")).body.some((w) => w.id === alpha));

// Without Google sign-in on the server, the dialog says invites wait for it.
{
  const { page: owner } = await context("Owner without Google");
  const savedClient = config.google.clientId;
  config.google.clientId = "";
  try {
    await owner.goto(base + "/");
    await owner.fill("input[name=name]", "Olga");
    await owner.click("form button[type=submit]");
    await owner.waitForURL(/\/app/, { timeout: 10000 });
    const ws = await api(owner, "POST", "/api/workspaces", { title: "No Google" });
    await owner.goto(`${base}/app/${ws.body.id}`);
    await owner.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
    await openSwitcher(owner);
    await menuClick(owner, "Share folder…");
    await owner.waitForSelector("dialog .invite-row input", { timeout: 10000 });
    const note = await owner.$eval("dialog .invite-note", (e) => e.textContent).catch(() => "");
    check("without Google sign-in, the share dialog says invitees need it", /Google sign-in is turned on/.test(note) && /sign in with Google using that email/.test(note), note);
    await owner.waitForTimeout(300);
    await owner.screenshot({ path: `${SHOTS}/share-dialog-no-google.png` });
  } finally {
    config.google.clientId = savedClient;
  }
}

const bob = await googleUser("Bob", "bob@example.com");
await bob.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(bob);
items = await switcherItems(bob);
check("the invitee sees the workspace after signing in", items.some((i) => i.label === "Alpha"), JSON.stringify(items));
check("no Editor badge for the invitee; a Leave × instead", noBadges(items) && items.find((i) => i.label === "Alpha")?.detail === "" && items.find((i) => i.label === "Alpha")?.x === "Leave Alpha", JSON.stringify(items));
await clickX(bob, "Alpha");
check("a member's × asks first", await until(bob, () => document.querySelector("dialog")?.textContent.includes("Leave Alpha? You'll need a new invite to get back in.")));
await bob.click('dialog .btn:text-is("Cancel")');
await openSwitcher(bob);
check("cancelling keeps the membership", (await switcherItems(bob)).some((i) => i.label === "Alpha"));
await menuClick(bob, "Alpha");
check("the invitee opens it", (await bob.waitForURL(new RegExp(`/app/${alpha}/`), { timeout: 10000 }).then(() => true, () => false)) && (await until(bob, () => !!document.querySelector(".mde .ln"))), bob.url());
check("the invitee can leave (not an owner)", await (async () => {
  await openSwitcher(bob);
  const ok = (await switcherItems(bob)).find((i) => i.label === "Alpha")?.x === "Leave Alpha" && !(await bob.$('.ws-menu .menu-label:text-is("Leave folder")')) && !(await bob.$('.ws-menu .menu-label:text-is("Share folder…")')) && !(await bob.$('.ws-menu .menu-label:text-is("Refresh")'));
  await closeMenu(bob);
  return ok;
})());
check("Alice sees Bob as a member now", await until(alice, () => true) && (await api(alice, "GET", `/api/workspaces/${alpha}/members`)).body?.some?.((m) => m.email === "bob@example.com" && !m.pending));

// ---- link access: view vs edit ----
const carol = await nameUser("Carol");
await carol.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await carol.goto(`${base}/app/${alpha}/Plan.md`);
check("private workspace: a signed-in non-member gets no access", await until(carol, () => document.body.innerText.includes("No access to this folder")));
check("no agent card without an open folder", (await agentCardState(carol)) === null);
await alice.selectOption("dialog .access-row select", "view");
await until(alice, () => document.querySelector("dialog .access-row select")?.value === "view");
await carol.goto(`${base}/app/${alpha}/Plan.md`);
check("link access view: opens read-only", (await until(carol, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"))) && (await until(carol, () => document.querySelector(".save-status")?.textContent === "Read-only")));
await openSwitcher(carol);
items = await switcherItems(carol);
check("opening a link-access workspace adds it, with no via link badge", items.some((i) => i.label === "Alpha" && i.detail === "") && noBadges(items), JSON.stringify(items));
check("no New note in a view-only workspace", await carol.$eval(".new-note", (b) => b.hidden));
check("no agent card where you can't create agent links (view-only)", (await agentCardState(carol)) === null);
await closeMenu(carol);
await alice.selectOption("dialog .access-row select", "edit");
await until(alice, () => document.querySelector("dialog .access-row select")?.value === "edit");
await carol.reload();
check("link access edit: editable", (await until(carol, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"))) && (await until(carol, () => document.querySelector(".save-status")?.textContent === "" && !document.querySelector(".new-note").hidden)));

// ---- leave (×): joined by link → at once, with Undo; the open folder switches away ----
await openSwitcher(carol);
await clickX(carol, "Alpha");
await carol.waitForURL((u) => !u.pathname.startsWith(`/app/${alpha}`), { timeout: 10000 }).catch(() => {});
check("a link-joined × leaves without asking", !(await carol.$("dialog[open]")));
check("toast: Left Alpha, with Undo", await until(carol, () => [...document.querySelectorAll(".toast")].some((t) => t.textContent === "Left AlphaUndo")));
await openSwitcher(carol);
items = await switcherItems(carol);
check("after leaving the open folder: it's gone and another one is open", !items.some((i) => i.label === "Alpha") && !carol.url().includes(`/app/${alpha}`) && items.some((i) => i.on), JSON.stringify(items) + carol.url());
check("not joined on the server", !(await api(carol, "GET", "/api/workspaces")).body.some((w) => w.id === alpha));
await closeMenu(carol);
await carol.click('.toast-action:text-is("Undo")');
await carol.waitForURL((u) => u.pathname.startsWith(`/app/${alpha}`), { timeout: 10000 }).catch(() => {});
check("Undo rejoins and reopens it", (await api(carol, "GET", "/api/workspaces")).body.some((w) => w.id === alpha && w.joinedVia === "link") && carol.url().includes(`/app/${alpha}`), carol.url());
await alice.click("dialog .modal-head .icon-btn");

// ---- add remote workspace: same server → opens it; other server → remembered + navigates ----
await openDialog(bob, "open-remote");
await bob.fill(`${PANE} input`, "not a link");
await bob.click(`${PANE} button[type=submit]`);
check("add remote: rejects a non-workspace URL", await until(bob, () => !document.querySelector("dialog .open-pane:not([hidden]) .form-error")?.hidden));
await bob.waitForTimeout(300);
await bob.screenshot({ path: `${RENAME_SHOTS}/open-remote-folder-error.png` });
await bob.fill(`${PANE} input`, `${base}/app/notes/Welcome.md`);
await bob.keyboard.press("Enter");
await bob.waitForURL(/\/app\/notes\/Welcome\.md$/, { timeout: 10000 }).then(() => check("add remote (same server): opens it", true), () => check("add remote (same server): opens it", false, bob.url()));
await until(bob, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Notes");
await openSwitcher(bob);
items = await switcherItems(bob);
check("add remote (same server): joined", items.some((i) => i.label === "Notes"), JSON.stringify(items));
await closeMenu(bob);
await openDialog(bob, "open-remote");
await bob.fill(`${PANE} input`, `${fake.origin}/app/team-notes`);
await bob.click(`${PANE} button[type=submit]`);
await bob.waitForURL(`${fake.origin}/app/team-notes`, { timeout: 10000 }).then(() => check("add remote (other server): navigates there", true), () => check("add remote (other server): navigates there", false, bob.url()));
await bob.goBack();
await bob.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(bob);
items = await switcherItems(bob);
const otherHost = new URL(fake.origin).host;
check("the other server's workspace is listed under On <its host>, name only", items.some((i) => i.label === "team-notes" && i.detail === "" && i.section === `On ${otherHost}` && i.x === "Leave team-notes") && noBadges(items), JSON.stringify(items));
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
  await clickX(bob, "team-notes");
  await bob.waitForTimeout(300);
  bob.off("request", onReq);
  items = await switcherItems(bob);
  check("× on another server's folder forgets it here, with no server call", !items.some((i) => i.label === "team-notes") && !items.some((i) => i.section === `On ${otherHost}`) && !bob.url().startsWith(fake.origin) && calls.length === 0, JSON.stringify(items) + JSON.stringify(calls));
  check("…and it stays forgotten", await bob.evaluate((o) => !JSON.parse(localStorage.getItem("grimoire.remoteWorkspaces.v1") ?? "[]").some((r) => r.origin === o), fake.origin));
  await closeMenu(bob);
}

// ---- signed out: private workspace → sign-in screen; link-access workspace → guest ----
{
  const { ctx, page } = await context("guest");
  await page.goto(`${base}/app/secret`);
  const shown = await until(page, () => document.body.innerText.includes("Sign in to view this folder"));
  check("private workspace signed out: the sign-in screen (not the home page)", shown && !(await page.$(".home-editor")), await page.evaluate(() => document.body.innerText.slice(0, 200)));
  check("sign-in screen: Continue with Google (back to this workspace) and the name sign-in", (await page.$eval("a.btn-google", (a) => a.getAttribute("href")).catch(() => null)) === "/auth/google?next=%2Fapp%2Fsecret" && !!(await page.$(".signin-name input[name=name]")));
  await page.screenshot({ path: `${SHOTS}/private-signin.png` });
  await page.goto(`${base}/app/notes/Welcome.md`);
  check("link-access workspace signed out: guest lands on the note", await until(page, () => !!document.querySelector(".mde .ln") && document.querySelector(".ws-switcher") !== null));
  await ctx.close();
}

// ---- note share links ----
check("owner turns link access off", (await api(alice, "PATCH", `/api/workspaces/${alpha}`, { linkAccess: "none" })).status === 200);
await alice.goto(`${base}/app/${alpha}/Plan.md`);
await until(alice, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"));
async function noteLink(role) {
  await alice.click(".share-note");
  await alice.selectOption("dialog select", role);
  await alice.click("dialog button[type=submit]");
  await alice.waitForSelector("dialog .note-link-url", { timeout: 10000 });
  const url = await alice.$eval("dialog .note-link-url", (e) => e.textContent);
  await alice.click("dialog .modal-head .icon-btn");
  return url;
}
const viewUrl = await noteLink("viewer");
check("Share note… creates a note link", viewUrl.includes(`/app/${alpha}/Plan.md?share=`), viewUrl);
{
  const { ctx, page } = await context("linkviewer");
  await page.goto(viewUrl);
  const ok = await until(page, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"));
  const bar = await page.$eval(".note-link-from", (e) => e.textContent).catch(() => "");
  check("note link (view): just the note, no sidebar", ok && !(await page.$(".sidebar")) && !(await page.$(".ws-switcher")));
  check("note link header: From <workspace> · <server> · Can view", bar.includes("From Alpha") && bar.includes(`localhost:${port}`) && bar.includes("Can view"), bar);
  check("note link (view): read-only", await until(page, () => document.querySelector(".save-status")?.textContent === "Read-only"));
  check("note link: Add to my Grimoire and Download .md", !!(await page.$(".add-to-grimoire")) && !!(await page.$(".download-md")));
  const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await page.click(".download-md");
  const download = await dl;
  check("Download .md downloads the note", download?.suggestedFilename() === "Plan.md", download?.suggestedFilename());
  const other = await api(page, "GET", `/api/repos/${alpha}/file?path=Welcome.md&share=` + new URL(viewUrl).searchParams.get("share"));
  check("a note link opens only its note", other.status === 403 || other.status === 404, JSON.stringify(other));
  await page.screenshot({ path: `${SHOTS}/note-share-view.png` });
  await ctx.close();
}
const editUrl = await noteLink("editor");
{
  const page = carol;
  await page.goto(editUrl);
  const ok = await until(page, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"));
  const bar = await page.$eval(".note-link-from", (e) => e.textContent).catch(() => "");
  check("note link (edit): Can edit, editable", ok && bar.includes("Can edit") && (await until(page, () => document.querySelector(".save-status")?.textContent === "")), bar);
  await page.click(".add-to-grimoire");
  const added = await until(page, () => document.querySelector(".add-to-grimoire")?.textContent === "Added to your Grimoire", null, 5000);
  check("Add to my Grimoire", added, await page.$eval(".add-to-grimoire", (e) => e.textContent).catch(() => ""));
  await page.goto(`${base}/app`);
  await page.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
  await openSwitcher(page);
  const shared = await switcherItems(page);
  check("the added note is listed under Shared with me, name only", shared.some((i) => i.label === "Plan" && i.detail === "" && i.section === "Shared with me" && i.x === "Remove Plan from this list") && noBadges(shared), JSON.stringify(shared));
  await menuClick(page, "Plan");
  await page.waitForURL(editUrl, { timeout: 10000 }).then(() => check("choosing it opens the note link", true), () => check("choosing it opens the note link", false, page.url()));
}

// ---- leave (×) as a member, from the open folder; an owner can leave once there's another owner ----
await api(alice, "POST", `/api/workspaces/${alpha}/members`, { email: "bob@example.com", role: "owner" });
await alice.goto(`${base}/app/${alpha}`);
await alice.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(alice);
check("with a second owner, the owner gets a Leave ×", (await switcherItems(alice)).find((i) => i.label === "Alpha")?.x === "Leave Alpha");
await closeMenu(alice);
await bob.goto(`${base}/app/${alpha}`);
await bob.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(bob);
await clickX(bob, "Alpha");
check("an owner's × asks first too", await until(bob, () => document.querySelector("dialog")?.textContent.includes("Leave Alpha? You'll need a new invite to get back in.")));
await bob.click("dialog .btn-danger");
await bob.waitForURL((u) => !u.pathname.startsWith(`/app/${alpha}`), { timeout: 10000 }).catch(() => {});
await openSwitcher(bob);
items = await switcherItems(bob);
check("after confirming: left, and another folder is open", !items.some((i) => i.label === "Alpha") && !bob.url().includes(`/app/${alpha}`) && items.some((i) => i.on), JSON.stringify(items) + bob.url());
check("the membership is gone", !(await api(alice, "GET", `/api/workspaces/${alpha}/members`)).body.some((m) => m.email === "bob@example.com"));
await closeMenu(bob);
await alice.reload();
await alice.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(alice);
check("the sole owner again: no ×", (await switcherItems(alice)).find((i) => i.label === "Alpha")?.x === null);
await closeMenu(alice);

// ---- remove a workspace: owners only ----
const doomed = await api(alice, "POST", "/api/workspaces", { title: "Doomed" });
await alice.goto(`${base}/app/${doomed.body.id}`);
await alice.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(alice);
check("the owner's menu has Remove folder…", await alice.$(`.ws-menu .menu-item:has(.menu-label:text-is("Remove folder…"))`).then(Boolean));
await menuClick(alice, "Remove folder…");
check("the confirmation names the workspace", await until(alice, () => document.querySelector("dialog")?.textContent.includes("Remove folder") && document.querySelector("dialog")?.textContent.includes("Doomed")));
await alice.click("dialog .btn-danger");
check("removed on the server", await (async () => { for (let i = 0; i < 50; i++) { if ((await api(alice, "GET", `/api/workspaces/${doomed.body.id}`)).status === 404) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })());
await carol.goto(`${base}/app/${alpha}`);
await carol.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(carol);
check("a link editor's menu has no Remove folder…", !(await carol.$(`.ws-menu .menu-item:has(.menu-label:text-is("Remove folder…"))`)));
await closeMenu(carol);

// ---- the /connect page (the Mac app's sign-in): states ----
{
  const { page } = await context("connect");
  // the app's loopback listener
  const seen = [];
  const loop = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(req.url), new Response("app")) });
  const cb = `http://127.0.0.1:${loop.port}/callback`;
  // the connect pages allow no scripts (CSP): ask /api/me with the browser's cookies from here
  const meStatus = async () => (await fetch(`${base}/api/me`, { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })).status;
  const q = (state) => `${base}/connect?${new URLSearchParams({ client: "Grimoire for Mac", redirect: cb, state })}`;
  await page.goto(q("s1"));
  const out = await page.textContent("body");
  check("connect signed out: sign-in options, no account made", out.includes("Continue with Google") && out.includes("Sign in with a name") && out.includes("creates a new account") && (await meStatus()) === 401, out);
  await page.screenshot({ path: "/tmp/opencode/workspaces/connect-signed-out.png" });
  await page.click("text=Sign in with a name");
  check("the name form says it makes a new account", (await page.textContent("body")).includes("creates a new account"));
  await page.fill("input[name=name]", "Connie");
  await page.click("form button[type=submit]");
  await page.waitForURL(/\/connect\?/, { timeout: 10000 });
  const ap = await page.textContent("body");
  check("connect signed in: names the account, offers Not you?", ap.includes("as Connie?") && ap.includes("Not you?"), ap);
  check("…with Allow as Connie", await page.$("text=Allow as Connie").then(Boolean));
  await page.screenshot({ path: "/tmp/opencode/workspaces/connect-approve.png" });
  await page.click("text=Sign in as someone else");
  await page.waitForURL(/\/connect\?/, { timeout: 10000 });
  check("Not you? signs the browser out", (await page.textContent("body")).includes("Continue with Google") && (await meStatus()) === 401);
  await page.click("text=Sign in with a name");
  await page.fill("input[name=name]", "Connie Two");
  await page.click("form button[type=submit]");
  await page.waitForURL(/\/connect\?/, { timeout: 10000 });
  await page.click("button[value=deny]");
  await until(page, () => location.href.startsWith("http://127.0.0.1:"));
  check("Cancel → the app gets error=access_denied", seen.some((u) => u.includes("error=access_denied") && u.includes("state=s1") && !u.includes("token=")), JSON.stringify(seen));
  await page.goto(q("s2"));
  await page.click("button[value=allow]");
  await until(page, () => location.href.startsWith("http://127.0.0.1:"));
  const ok = new URL(seen.at(-1));
  check("Allow → token, token id and the account", ok.searchParams.get("token")?.startsWith("gmt_") && ok.searchParams.get("token_id")?.startsWith("t_") && ok.searchParams.get("account") === "Connie Two" && ok.searchParams.get("state") === "s2", ok.href);
  const tok = ok.searchParams.get("token");
  const me = await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${tok}` } })).json();
  check("the token is Connie Two's, and /api/me names it", me.name === "Connie Two" && me.token?.id === ok.searchParams.get("token_id"), JSON.stringify(me));
  const bad = await page.goto(`${base}/connect?${new URLSearchParams({ client: "X", redirect: "https://evil.example/cb", state: "s" })}`);
  check("bad redirect → 400", bad.status() === 400 && (await page.textContent("body")).includes("on this computer"));
  await page.close();
  loop.stop(true);
}

// ---- Settings: connected apps (tokens) list + revoke ----
createAppToken(me.body.id, "Grimoire for Mac · Test MacBook");
await openSwitcher(alice);
await menuClick(alice, "Settings");
check("Settings lists connected apps", await until(alice, () => [...document.querySelectorAll("dialog .token-label")].some((e) => e.textContent === "Grimoire for Mac · Test MacBook")));
await alice.click("dialog .token .btn");
check("Revoke removes it", await until(alice, () => document.querySelector("dialog .tokens")?.textContent.includes("No connected apps")));
check("revoked on the server", (await api(alice, "GET", "/api/tokens")).body?.length === 0);
await alice.click("dialog .modal-head .icon-btn");

// ---- sign out from the switcher ----
await openSwitcher(alice);
await menuClick(alice, "Sign out");
await alice.waitForURL(`${base}/`, { timeout: 10000 }).then(() => check("Sign out", true), () => check("Sign out", false, alice.url()));

await browser.close();
await app.stop();
fake.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);

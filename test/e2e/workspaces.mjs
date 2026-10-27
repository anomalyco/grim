// End-to-end: workspaces in the web app — the switcher (joined workspaces only, add remote, new, leave), the
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
const switcherItems = (page) =>
  page.$$eval(".ws-menu .menu-item.has-detail", (els) => els.map((e) => ({ label: e.querySelector(".menu-label")?.textContent, detail: e.querySelector(".menu-detail")?.textContent ?? "", on: e.getAttribute("aria-checked") === "true" })));
const closeMenu = (page) => page.keyboard.press("Escape");
const switcherTitle = (page) => page.$eval(".ws-switcher .ws-title", (e) => e.textContent).catch(() => null);
const treeFiles = (page) => page.$$eval(".sb-tree .file-row", (els) => els.map((e) => e.getAttribute("href")));
async function menuClick(page, label) {
  await page.click(`.ws-menu .menu-item:has(.menu-label:text-is("${label}"))`);
}

// The first user is the server admin (owner of everything): someone else, so the people below are ordinary users.
const root = await nameUser("Root");
await root.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
const secret = await api(root, "POST", "/api/workspaces", { title: "Secret" });
check("admin creates a private workspace", secret.status === 201 && secret.body.linkAccess === "none", JSON.stringify(secret));

// ---- Google sign-in, the switcher, the workspace-scoped sidebar ----
const alice = await googleUser("Alice", "alice@example.com");
await alice.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
check("Google sign-in lands in the app", await alice.waitForURL(/\/app\/notes\//, { timeout: 10000 }).then(() => true, () => false), alice.url());
check("switcher shows the workspace and the server", (await switcherTitle(alice)) === "Notes" && (await alice.$eval(".ws-host", (e) => e.textContent)) === `localhost:${port}`);
const me = await api(alice, "GET", "/api/me");
check("signed in as the Google account", me.body?.email === "alice@example.com", JSON.stringify(me.body));

// New workspace
await openSwitcher(alice);
await menuClick(alice, "New workspace…");
await alice.fill("dialog input", "Alpha");
await alice.click("dialog button[type=submit]");
await alice.waitForURL(/\/app\/alpha-[a-z2-9]{4}(\/|$)/, { timeout: 10000 }).catch(() => {});
// The id is the title plus a random suffix (unguessable addresses); read it from the URL the app opened.
const alpha = new URL(alice.url()).pathname.split("/")[2] ?? "";
check("new workspace opens at /app/<title>-<random>", /^alpha-[a-z2-9]{4}$/.test(alpha), alice.url());
await until(alice, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Alpha");
check("switcher shows the new workspace", (await switcherTitle(alice)) === "Alpha");
await alice.evaluate((alpha) => fetch(`/api/repos/${alpha}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Plan.md", content: "# Plan\nAlpha's plan.\n\n![pic](pic.png)\n" }) }), alpha);
await alice.goto(`${base}/app/${alpha}/Plan.md`);
await until(alice, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"));
const files = await treeFiles(alice);
check("sidebar shows only the open workspace's tree", files.length > 0 && files.every((f) => f.startsWith(`/app/${alpha}/`)), JSON.stringify(files));

await openSwitcher(alice);
let items = await switcherItems(alice);
check("switcher lists the joined workspaces only", items.some((i) => i.label === "Alpha" && i.detail === "Owner" && i.on) && items.some((i) => i.label === "Notes" && i.detail === "via link") && !items.some((i) => i.label === "Secret"), JSON.stringify(items));
check("owner menu has Share workspace…, no Leave", !!(await alice.$('.ws-menu .menu-label:text-is("Share workspace…")')) && !(await alice.$('.ws-menu .menu-label:text-is("Leave workspace")')));
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
await menuClick(alice, "Share workspace…");
await alice.waitForSelector("dialog .invite-row input", { timeout: 10000 });
await alice.fill("dialog .invite-row input", "bob@example.com");
await alice.click("dialog .invite-row button[type=submit]");
const invited = await until(alice, () => [...document.querySelectorAll("dialog .member")].some((m) => m.dataset.email === "bob@example.com" && m.textContent.includes("Invited")));
check("invite shows as pending", invited);
await alice.waitForTimeout(300);
await alice.screenshot({ path: `${SHOTS}/share-dialog.png` });

const bob = await googleUser("Bob", "bob@example.com");
await bob.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(bob);
items = await switcherItems(bob);
check("the invitee sees the workspace after signing in", items.some((i) => i.label === "Alpha" && i.detail === "Editor"), JSON.stringify(items));
await menuClick(bob, "Alpha");
check("the invitee opens it", (await bob.waitForURL(new RegExp(`/app/${alpha}/`), { timeout: 10000 }).then(() => true, () => false)) && (await until(bob, () => !!document.querySelector(".mde .ln"))), bob.url());
check("the invitee can leave (not an owner)", await (async () => {
  await openSwitcher(bob);
  const ok = !!(await bob.$('.ws-menu .menu-label:text-is("Leave workspace")')) && !(await bob.$('.ws-menu .menu-label:text-is("Share workspace…")'));
  await closeMenu(bob);
  return ok;
})());
check("Alice sees Bob as a member now", await until(alice, () => true) && (await api(alice, "GET", `/api/workspaces/${alpha}/members`)).body?.some?.((m) => m.email === "bob@example.com" && !m.pending));

// ---- link access: view vs edit ----
const carol = await nameUser("Carol");
await carol.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await carol.goto(`${base}/app/${alpha}/Plan.md`);
check("private workspace: a signed-in non-member gets no access", await until(carol, () => document.body.innerText.includes("No access to this workspace")));
await alice.selectOption("dialog .access-row select", "view");
await until(alice, () => document.querySelector("dialog .access-row select")?.value === "view");
await carol.goto(`${base}/app/${alpha}/Plan.md`);
check("link access view: opens read-only", (await until(carol, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"))) && (await until(carol, () => document.querySelector(".save-status")?.textContent === "Read-only")));
await openSwitcher(carol);
items = await switcherItems(carol);
check("opening a link-access workspace adds it (via link)", items.some((i) => i.label === "Alpha" && i.detail === "via link"), JSON.stringify(items));
check("no New note in a view-only workspace", await carol.$eval(".new-note", (b) => b.hidden));
await closeMenu(carol);
await alice.selectOption("dialog .access-row select", "edit");
await until(alice, () => document.querySelector("dialog .access-row select")?.value === "edit");
await carol.reload();
check("link access edit: editable", (await until(carol, () => document.querySelector(".mde")?.textContent?.includes("Alpha's plan"))) && (await until(carol, () => document.querySelector(".save-status")?.textContent === "" && !document.querySelector(".new-note").hidden)));

// ---- leave ----
await openSwitcher(carol);
await menuClick(carol, "Leave workspace");
await carol.click("dialog .btn-danger");
await carol.waitForURL((u) => !u.pathname.startsWith(`/app/${alpha}`), { timeout: 10000 }).catch(() => {});
await openSwitcher(carol);
items = await switcherItems(carol);
check("after leaving, the switcher no longer lists it", !items.some((i) => i.label === "Alpha") && !carol.url().includes(`/app/${alpha}`), JSON.stringify(items) + carol.url());
await closeMenu(carol);
await alice.click("dialog .modal-head .icon-btn");

// ---- add remote workspace: same server → opens it; other server → remembered + navigates ----
await openSwitcher(bob);
await menuClick(bob, "Add remote workspace…");
await bob.fill("dialog input", "not a link");
await bob.click("dialog button[type=submit]");
check("add remote: rejects a non-workspace URL", await until(bob, () => !document.querySelector("dialog .form-error")?.hidden));
await bob.fill("dialog input", `${base}/app/notes/Welcome.md`);
await bob.click("dialog button[type=submit]");
await bob.waitForURL(/\/app\/notes\/Welcome\.md$/, { timeout: 10000 }).then(() => check("add remote (same server): opens it", true), () => check("add remote (same server): opens it", false, bob.url()));
await until(bob, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Notes");
await openSwitcher(bob);
items = await switcherItems(bob);
check("add remote (same server): joined", items.some((i) => i.label === "Notes"), JSON.stringify(items));
await menuClick(bob, "Add remote workspace…");
await bob.fill("dialog input", `${fake.origin}/app/team-notes`);
await bob.click("dialog button[type=submit]");
await bob.waitForURL(`${fake.origin}/app/team-notes`, { timeout: 10000 }).then(() => check("add remote (other server): navigates there", true), () => check("add remote (other server): navigates there", false, bob.url()));
await bob.goBack();
await bob.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 });
await openSwitcher(bob);
items = await switcherItems(bob);
const otherHost = new URL(fake.origin).host;
check("the other server's workspace is remembered, with its host", items.some((i) => i.label === "team-notes" && i.detail === otherHost), JSON.stringify(items));
await menuClick(bob, "team-notes");
await bob.waitForURL(`${fake.origin}/app/team-notes`, { timeout: 10000 }).then(() => check("choosing it goes to that server's app", true), () => check("choosing it goes to that server's app", false, bob.url()));
await bob.goBack();

// ---- signed out: private workspace → sign-in screen; link-access workspace → guest ----
{
  const { ctx, page } = await context("guest");
  await page.goto(`${base}/app/secret`);
  const shown = await until(page, () => document.body.innerText.includes("Sign in to view this workspace"));
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
  check("the added note is listed under Shared with me", shared.some((i) => i.label === "Plan" && i.detail === "Alpha"), JSON.stringify(shared));
  await menuClick(page, "Plan");
  await page.waitForURL(editUrl, { timeout: 10000 }).then(() => check("choosing it opens the note link", true), () => check("choosing it opens the note link", false, page.url()));
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

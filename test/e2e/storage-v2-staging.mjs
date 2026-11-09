// Storage v2 against a live deployment (staging): a temporary account (made in D1, deleted at the end with
// DELETE /api/me), a fresh workspace, two headless Chromium browsers, the note shell, MCP and export.
// Usage: BASE=https://staging.grimnotes.app SESSION=<raw session token> TOKEN=<raw app token> bun test/e2e/storage-v2-staging.mjs
// (scripts make the account and pass the tokens through the environment; nothing here prints them)
import { chromium } from "playwright-core";

const base = process.env.BASE;
const SESSION = process.env.SESSION;
const TOKEN = process.env.TOKEN;
const AGENTS_WS = process.env.AGENTS_WS ?? "";
if (!base || !SESSION || !TOKEN) throw new Error("BASE, SESSION and TOKEN are required");
const host = new URL(base).host;
const cookie = `np_session=${SESSION}`;
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : String(detail).slice(0, 400));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, path, body, headers = {}) => {
  const r = await fetch(`${base}${path}`, { method, headers: { cookie, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const t = await r.text();
  let data = t;
  try {
    data = JSON.parse(t);
  } catch {}
  return { status: r.status, data };
};
const shell = async (ws, path, command, headers = {}) => {
  const r = await fetch(`${base}/app/${ws}/${path}`, { method: "POST", headers: { "x-agent-name": "Checker", ...headers }, body: command });
  return { status: r.status, ...(r.ok ? await r.json() : { error: await r.text() }) };
};
const fileText = async (ws, path) => (await api("GET", `/api/workspace/${ws}/file?path=${encodeURIComponent(path)}`)).data.content;

// ---- a workspace ----
const made = await api("POST", "/api/workspaces", { title: "Storage v2 check" });
check("workspace created", made.status === 201, JSON.stringify(made));
const WS = made.data.id;
const W = (p) => `/api/workspace/${WS}${p}`;
check("README.md exists", (await fileText(WS, "README.md")) === "# Storage v2 check\n");
await api("POST", W("/files"), { path: "plan.md", content: "# Plan\n\n- [ ] milk\n- [ ] eggs\n" });

// ---- browsers ----
const browser = await chromium.launch({ executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell" });
async function person() {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addCookies([{ name: "np_session", value: SESSION, domain: host, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  PAGEERROR", e.message));
  return { ctx, page };
}
const ready = (page) => page.waitForSelector(".editor-host:not(.preview) .mde .ln", { timeout: 20000 });
const shows = (page, s, timeout = 15000) => page.waitForFunction((s) => document.querySelector(".editor-host:not(.preview) .mde")?.textContent?.includes(s), s, { timeout }).then(() => true, () => false);
const typeAtEnd = async (page, s) => {
  await page.click(".editor-host:not(.preview) .mde .ln >> nth=-1");
  await page.keyboard.press("Control+End");
  await page.keyboard.type(s);
};

const A = await person();
await A.page.goto(`${base}/app/${WS}/plan.md`);
await ready(A.page);
check("browser opens the note", await shows(A.page, "milk"));
await typeAtEnd(A.page, "\ntyped in the browser");
await sleep(1500);
check("edit reaches the server", (await fileText(WS, "plan.md")).includes("typed in the browser"));
await A.page.reload();
await ready(A.page);
check("edit survives a reload", await shows(A.page, "typed in the browser"));

// ---- two browsers ----
const B = await person();
await B.page.goto(`${base}/app/${WS}/plan.md`);
await ready(B.page);
await typeAtEnd(B.page, "\nfrom B");
check("A sees B's typing live", await shows(A.page, "from B"));
await typeAtEnd(A.page, "\nfrom A");
check("B sees A's typing live", await shows(B.page, "from A"));

// ---- the note shell ----
let r = await shell(WS, "plan.md", "sed -i 's/- \\[ \\] milk/- [x] milk/; s/eggs/oat eggs/' plan.md && grep -c x plan.md");
check("agent sed -i ok", r.exitCode === 0, JSON.stringify(r));
check("agent sed -i lands live in both browsers", (await shows(A.page, "oat eggs")) && (await shows(B.page, "oat eggs")));
r = await shell(WS, "plan.md", "ls -a; ls ..; cat ../README.md; cat README.md; find / -name '*.md'");
check("shell sees only its note", r.stdout.includes("plan.md") && !r.stdout.includes("README") && !r.stdout.includes("Storage v2 check"), JSON.stringify(r));
r = await shell(WS, "plan.md", "history");
check("history lists the agent's version", /^v\d+ .* agent +Checker/m.test(r.stdout), JSON.stringify(r));
const vid = r.stdout.split(" ")[0];
r = await shell(WS, "plan.md", `history show ${vid}`);
check("history show prints it", r.stdout.includes("[x] milk"), JSON.stringify(r));
r = await shell(WS, "plan.md", `history diff ${vid}`);
check("history diff shows the change", r.stdout.includes("+- [x] milk"), JSON.stringify(r));
r = await shell(WS, "", "ls");
check("POST to the workspace URL points at note URLs", r.status === 405, JSON.stringify(r));
r = await shell(WS, "new-by-guest.md", "echo hi > new-by-guest.md");
check("a guest agent can't create notes", r.status === 404, JSON.stringify(r));
r = await shell(WS, "agent-made.md", "printf '# Agent made\\n' > agent-made.md", { authorization: `Bearer ${TOKEN}` });
check("an account's agent creates a note", r.exitCode === 0 && (await fileText(WS, "agent-made.md")) === "# Agent made\n", JSON.stringify(r));

// ---- history API, review mode, restore ----
const hist = (await api("GET", W(`/history?path=plan.md`))).data;
check("history API: versions with the old shape", Array.isArray(hist) && /^v\d+$/.test(hist[0]?.sha ?? "") && hist[0].authorName === "Checker", JSON.stringify(hist).slice(0, 300));
await A.page.click(".review-toggle").catch(() => {});
const reviewLabel = await A.page.waitForFunction(() => /Reviewing: /.test(document.querySelector(".review-toggle")?.textContent ?? ""), null, { timeout: 10000 }).then(() => A.page.evaluate(() => document.querySelector(".review-toggle").textContent), () => null);
check("review mode shows the latest author's batch", !!reviewLabel && /Reviewing: .+ · \d+ line/.test(reviewLabel), reviewLabel);
await A.page.click(".review-toggle").catch(() => {});
const oldest = hist[hist.length - 1];
r = await api("POST", W("/restore"), { path: "plan.md", sha: oldest.sha });
check("restore ok", r.status === 200, JSON.stringify(r));
check("restore lands live", await A.page.waitForFunction(() => !document.querySelector(".editor-host:not(.preview) .mde")?.textContent?.includes("oat eggs"), null, { timeout: 15000 }).then(() => true, () => false));
check("restore is a version", (await api("GET", W(`/history?path=plan.md&limit=1`))).data[0]?.kind === "restore");
const d = await api("GET", W(`/diff?sha=${hist[0].sha}&path=plan.md`));
check("diff API", typeof d.data.diff === "string" && d.data.diff.includes("[x] milk"), JSON.stringify(d).slice(0, 200));

// ---- images ----
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const up = await fetch(`${base}${W("/images")}?note=plan.md&name=dot.png`, { method: "POST", headers: { cookie, "content-type": "image/png", origin: base }, body: PNG });
const upj = await up.json();
check("image upload", up.status === 201 && upj.path === "images/dot.png", JSON.stringify(upj));
const raw = await fetch(`${base}${W("/raw")}?path=images/dot.png`);
check("image served", raw.ok && Buffer.from(await raw.arrayBuffer()).equals(PNG));
await shell(WS, "plan.md", `echo '${upj.markdown}' >> plan.md`);
check("image shows in the note", await A.page.waitForFunction(() => [...document.querySelectorAll(".mde img")].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).then(() => true, () => false));

// ---- search ----
const s = (await api("GET", W("/search?q=milk"))).data;
check("search finds the note", s.hits?.some((h) => h.path === "plan.md"), JSON.stringify(s));

// ---- rename and delete ----
r = await api("POST", W("/rename"), { from: "plan.md", to: "plans/q4.md" });
check("rename ok", r.status === 200, JSON.stringify(r));
await A.page.waitForURL(/plans\/q4\.md/, { timeout: 15000 }).then(() => check("the browser follows the rename", true), () => check("the browser follows the rename", false, A.page.url()));
check("history follows the rename", (await api("GET", W(`/history?path=plans/q4.md`))).data.length >= hist.length + 1);
r = await api("DELETE", W(`/files?path=agent-made.md`));
check("delete ok", r.status === 200 && !(await api("GET", W("/tree"))).data.files.includes("agent-made.md"), JSON.stringify(r));

// ---- offline over a minute, then reconnect: nothing lost ----
await B.ctx.close();
await A.page.goto(`${base}/app/${WS}/plans/q4.md`);
await ready(A.page);
await A.ctx.setOffline(true);
await sleep(1000);
await typeAtEnd(A.page, "\nwritten offline");
console.log("  (offline for 75 s…)");
// meanwhile someone else edits (the room closes and reopens while A is away)
await sleep(20000);
await shell(WS, "plans/q4.md", "echo 'agent while A was offline' >> q4.md");
await sleep(55000);
await A.ctx.setOffline(false);
check("offline edit merged after reconnect", await A.page.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("agent while A was offline"), null, { timeout: 30000 }).then(() => true, () => false));
await sleep(2000);
const after = await fileText(WS, "plans/q4.md");
check("nothing lost: the server has both", after.includes("written offline") && after.includes("agent while A was offline"), after);

// ---- unacked edits kept across a page close (IndexedDB) ----
await A.ctx.setOffline(true);
await sleep(500);
await typeAtEnd(A.page, "\nkept in indexeddb");
await sleep(1200);
await A.page.close();
await A.ctx.setOffline(false);
const A2 = await A.ctx.newPage();
await A2.goto(`${base}/app/${WS}/plans/q4.md`);
await ready(A2);
check("an edit made offline and closed is merged on the next open", await shows(A2, "kept in indexeddb", 20000));
await sleep(2000);
check("…and reaches the server", (await fileText(WS, "plans/q4.md")).includes("kept in indexeddb"));

// ---- MCP ----
const mcp = async (body, sid) => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
  return { sid: res.headers.get("mcp-session-id"), data: await res.json() };
};
const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "v2-check" } } });
const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, init.sid);
check("MCP tools", JSON.stringify(tools.data.result.tools.map((t) => t.name)) === JSON.stringify(["list_workspaces", "list_notes", "note_command"]), JSON.stringify(tools.data).slice(0, 300));
const notes = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_notes", arguments: { workspace: WS } } }, init.sid);
check("MCP list_notes", notes.data.result.content[0].text.includes("plans/q4.md"), JSON.stringify(notes.data).slice(0, 300));
const nc = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "note_command", arguments: { note: `${base}/app/${WS}/plans/q4.md`, command: "echo 'via mcp' >> q4.md; tail -1 q4.md; history 1" } } }, init.sid);
check("MCP note_command writes", nc.data.result.content[0].text.includes("via mcp") && (await fileText(WS, "plans/q4.md")).includes("via mcp"), JSON.stringify(nc.data).slice(0, 300));

// ---- export ----
const z = await fetch(`${base}${W("/export")}`, { headers: { cookie } });
const zb = Buffer.from(await z.arrayBuffer());
check("zip export", z.ok && zb.subarray(0, 2).toString() === "PK" && zb.includes("plans/q4.md") && zb.includes("images/dot.png") && zb.includes(".grim/versions.json"), `${z.status} ${zb.length}`);

// ---- the agents workspace still reads and writes through the note shell ----
if (AGENTS_WS) {
  r = await shell(AGENTS_WS, "coordinate.md", "head -3 coordinate.md; history 1");
  check("agents workspace: read coordinate.md", r.exitCode === 0 && r.stdout.startsWith("# agents"), JSON.stringify(r).slice(0, 300));
  r = await shell(AGENTS_WS, "storage-v2-check.md", "printf '# storage v2 check\\nwritten by the check, then deleted\\n' > storage-v2-check.md; cat storage-v2-check.md", { authorization: `Bearer ${TOKEN}` });
  check("agents workspace: write a note", r.exitCode === 0 && r.stdout.includes("written by the check"), JSON.stringify(r));
  await fetch(`${base}/api/workspace/${AGENTS_WS}/files?path=storage-v2-check.md`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
}

// ---- versions after idle (5 min): the human edits became a version ----
if (process.env.WAIT_IDLE) {
  console.log("  (waiting 6 min for idle versions…)");
  await sleep(6 * 60_000 + 30_000);
  const h = (await api("GET", W(`/history?path=plans/q4.md`))).data;
  check("idle versions cut", h.some((v) => v.kind === "edit" && v.authorName !== "Checker" && v.authorName !== "Grim"), JSON.stringify(h.map((v) => [v.kind, v.authorName])));
}

await browser.close();
// the workspace goes with the account (DELETE /api/me removes what it made)
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);

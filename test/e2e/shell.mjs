// End-to-end: the agent shell through the real server: a share link (instructions, ls/cat/grep, ?format=text,
// sed -i → git status/diff → who → save → committed, a new note, watch woken by a person editing over /ws, at most
// 4 commands at once and 120 calls a minute per link, revoking it mid-command), MCP (initialize, tools/call,
// tools/list, unknown session) and /api/shell (signed in, cross-origin, signed out). No browser.
// Usage: bun test/e2e/shell.mjs   (TARGET=workers: against wrangler dev, see target.mjs)
import "../local-storage.ts";
import { room } from "../server/helpers.ts";
import { signIn, startTarget } from "./target.mjs";

// A long quiet period: nothing commits by itself, so `git status` and `save` see the edits.
const T = await startTarget({ env: { QUIET_MS: "60000" } });
const base = T.base;

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const eq = (name, got, want) => check(name, got === want, `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const alice = await signIn(base, "Alice");
const as = (cookie) => ({ cookie, origin: base, "content-type": "application/json" });
const api = async (cookie, method, path, body) => {
  const r = await fetch(base + path, { method, headers: as(cookie), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const ws = (await api(alice, "POST", "/api/workspaces", { title: "Jottings" })).body.id;
for (const [path, content] of [
  ["Welcome.md", "# Welcome\n"],
  ["todo.md", "# Todo\n\n- milk\n- eggs\n- bread\n"],
  ["projects/alpha.md", "# Alpha\n\nStatus: planning\n"],
  ["projects/beta.md", "# Beta\n\nStatus: done\n"],
]) {
  check(`seed ${path}`, (await api(alice, "POST", `/api/repos/${ws}/files`, { path, content })).status === 201);
}
check("seed: README.md removed", (await api(alice, "DELETE", `/api/repos/${ws}/files?path=README.md`)).status === 200);
eq("seed: saved", (await api(alice, "POST", "/api/shell", { command: `save /workspace/${ws}` })).body?.exitCode, 0);

const share = (await api(alice, "POST", `/api/repos/${ws}/shares`, { label: "Robo" })).body;
// (its host is PUBLIC_URL's, which these test servers don't set)
check("share link made", typeof share?.id === "string" && share.url.endsWith(`/a/${share.id}`), JSON.stringify(share));
const link = async (command, { id = share.id, session } = {}) => {
  const res = await fetch(`${base}/a/${id}`, { method: "POST", headers: { "X-Agent-Name": "Robo", ...(session ? { "x-shell-session": session } : {}) }, body: command });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
};
const out = async (command, opts) => {
  const r = await link(command, opts);
  if (r.status !== 200 || r.exitCode !== 0) console.log(`     (${command}: ${r.status} ${r.exitCode} ${r.stderr ?? r.error})`);
  return r.stdout;
};

// ---- instructions, reads ----
{
  const res = await fetch(`${base}/a/${share.id}`);
  const text = await res.text();
  check("GET: the instructions", res.status === 200 && text.includes("# Grimoire notebook: Jottings") && text.includes("projects/  (2 notes)"), text.slice(0, 300));
  eq("pwd", await out("pwd"), `/workspace/${ws}\n`);
  eq("ls", await out("ls"), "Welcome.md\nprojects\ntodo.md\n");
  eq("cat", await out("cat todo.md"), "# Todo\n\n- milk\n- eggs\n- bread\n");
  eq("grep -rn", await out("grep -rn Status ."), "projects/alpha.md:3:Status: planning\nprojects/beta.md:3:Status: done\n");
  const plain = await fetch(`${base}/a/${share.id}?format=text`, { method: "POST", body: "cat nope.md" });
  check("?format=text: exit code header and [stderr]", plain.headers.get("x-exit-code") === "1" && (await plain.text()).includes("[stderr]"));
}

// ---- edits: git status, git diff, who, save ----
{
  eq("sed -i", await out("sed -i 's/- milk/- oat milk/' todo.md && cat todo.md"), "# Todo\n\n- oat milk\n- eggs\n- bread\n");
  eq("git status", await out("git status"), "On branch main\nLive edits not committed yet (committed automatically after 3 s without edits, or run `save`):\n\tmodified:   todo.md\n");
  const diff = await out("git diff");
  check("git diff", diff.includes("--- a/todo.md") && diff.includes("+- oat milk"), diff);
  eq("who (the agent itself)", await out("who todo.md"), "Robo (agent, you)\n");
  eq("who (nobody)", await out("who projects/alpha.md"), "nobody has projects/alpha.md open\n");
  check("save", /^saved todo\.md \([0-9a-f]{7}\)\n$/.test(await out("save")));
  eq("…committed", await T.committed(ws, "todo.md"), "# Todo\n\n- oat milk\n- eggs\n- bread\n");
  eq("save again: nothing", await out("save"), "nothing to save\n");
  eq("git status: clean", await out("git status"), "On branch main\nnothing to save, all edits are committed\n");
  check("git log", /^[0-9a-f]{7} /.test(await out("git log --oneline -n 1 todo.md")));
  await out("echo '# Gamma' > projects/gamma.md");
  check("git status: new file", (await out("git status projects")).includes("new file:   projects/gamma.md"));
  const saved = await out("save projects");
  // (notes of the folder that are open but unchanged say "nothing to save")
  check("save a folder", /^saved projects\/gamma\.md \([0-9a-f]{7}\)$/m.test(saved), saved);
  eq("…committed", await T.committed(ws, "projects/gamma.md"), "# Gamma\n");
  const s = await link("cd projects && export KEPT=yes", { session: "keep" });
  eq("a session keeps cwd and variables", await out("pwd; echo $KEPT", { session: "keep" }), `/workspace/${ws}/projects\nyes\n`);
  eq("…other sessions start at the workspace", s.status === 200 && (await out("pwd")), `/workspace/${ws}\n`);
}

// ---- a person on /ws: who, watch ----
{
  const person = room(base, { repo: ws, path: "Welcome.md" }, { cookie: alice, origin: base });
  await until(() => person.controls.some((m) => m.t === "hello") || person.closeCode !== null);
  check("a person joins over /ws", person.controls.some((m) => m.t === "hello"), `close ${person.closeCode}`);
  await until(() => person.text.toString() === "# Welcome\n");
  eq("who sees them", await until(async () => ((await out("who Welcome.md")) === "Alice (human)\n" ? "Alice (human)\n" : null)), "Alice (human)\n");
  let done = false;
  const waiting = link("watch Welcome.md --timeout 10 && tail -1 Welcome.md").finally(() => (done = true));
  // the person edits until the watch returns (an edit made before the watch started isn't a change it sees)
  while (!done) {
    person.text.insert(person.text.length, "alice was here\n");
    await Promise.race([waiting, new Promise((r) => setTimeout(r, 250))]);
  }
  const r = await waiting;
  check("watch wakes on the person's edit", r.exitCode === 0 && r.stdout === "changed: Welcome.md\nalice was here\n", JSON.stringify(r));
  const none = await link("watch Welcome.md --timeout 0.2");
  check("watch times out", none.exitCode === 1 && none.stderr.includes("no change to Welcome.md within 0.2s"), JSON.stringify(none));
  person.close();
}

// ---- limits ----
{
  const runs = await Promise.all(Array.from({ length: 5 }, (_, i) => link("sleep 1; echo done", { session: `s${i}` })));
  const refused = runs.filter((r) => r.status === 429);
  check("at most 4 commands at once per link", refused.length === 1 && refused[0].error.includes("4 commands running or queued") && runs.filter((r) => r.status === 200 && r.stdout === "done\n").length === 4, JSON.stringify(runs.map((r) => r.status)));
  // another person's link to the same workspace, for the rate limit
  const bob = await signIn(base, "Bob");
  const bobLink = (await api(bob, "POST", `/api/repos/${ws}/shares`, {})).body.id;
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const batch = await Promise.all(Array.from({ length: 21 }, () => fetch(`${base}/a/${bobLink}`, { method: "HEAD" })));
    statuses.push(...batch.map((r) => r.status));
  }
  const last = await fetch(`${base}/a/${bobLink}`, { method: "POST", body: "pwd" });
  await last.text();
  check("at most 120 calls a minute per link", statuses.filter((s) => s === 200).length === 120 && last.status === 429 && Number(last.headers.get("retry-after")) > 0, `${statuses.filter((s) => s === 200).length} ok, then ${last.status}`);
  eq("…other links aren't affected", await out("echo ok"), "ok\n");
  // a refused command's body is never read; the connection it came on must still work (on Workers the Worker used
  // to stream it on to the ShellDO, and workerd dropped the connection, or wrangler dev itself, after the 429)
  const after = [];
  for (let i = 0; i < 5; i++) {
    const refused = await fetch(`${base}/a/${bobLink}`, { method: "POST", body: `echo ${"x".repeat(1000)}` });
    await refused.text();
    after.push(refused.status, (await link(`echo ${i}`).catch((e) => ({ status: e.code }))).status);
  }
  eq("…a refused command leaves the connection usable", after.join(), "429,200,429,200,429,200,429,200,429,200");
}

// ---- MCP and /api/shell ----
{
  const mcp = async (body, extra = {}) => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...as(alice), ...extra }, body: JSON.stringify(body) });
    return { res, body: await res.json().catch(() => null) };
  };
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const sid = init.res.headers.get("mcp-session-id");
  check("MCP initialize: a session", init.res.status === 200 && !!sid);
  const call = (command) => mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "document_command", arguments: { command } } }, { "mcp-session-id": sid });
  eq("MCP tools/call", (await call(`cd /workspace/${ws} && cat todo.md`)).body?.result?.content?.[0]?.text, "# Todo\n\n- oat milk\n- eggs\n- bread\n");
  eq("MCP session keeps the cwd", (await call("pwd")).body?.result?.content?.[0]?.text, `/workspace/${ws}\n`);
  eq("MCP tools/list", (await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "mcp-session-id": sid })).body?.result?.tools?.[0]?.name, "document_command");
  eq("MCP unknown session: 404", (await mcp({ jsonrpc: "2.0", id: 4, method: "ping" }, { "mcp-session-id": "nope" })).res.status, 404);
  const me = await api(alice, "POST", "/api/shell", { command: "whoami; ls /workspace" });
  check("/api/shell as the signed-in person", me.status === 200 && me.body.stdout.startsWith("alice\n") && me.body.stdout.includes(`${ws}\n`), JSON.stringify(me));
  const xo = await fetch(`${base}/api/shell`, { method: "POST", headers: { ...as(alice), origin: "https://evil.example" }, body: JSON.stringify({ command: "ls" }) });
  eq("/api/shell cross-origin: 403", xo.status, 403);
  const anon = await fetch(`${base}/api/shell`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "ls" }) });
  eq("/api/shell signed out: 401", anon.status, 401);
}

// ---- revoking the link stops its running command ----
{
  // (whether the command has started or not when the link goes, it ends with 404)
  const running = link("watch Welcome.md --timeout 30");
  eq("revoke", (await api(alice, "DELETE", `/api/shares/${share.id}`)).status, 200);
  const r = await running;
  eq("…the running command ends with 404", r.status, 404);
  eq("…and the link is gone", (await link("pwd")).status, 404);
}

await T.stop();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);

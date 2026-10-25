// MCP server over Streamable HTTP (JSON responses only, stateless). Written by hand: JSON-RPC 2.0 + tools.
import { waitForChange } from "./events.ts";
import * as ops from "./ops.ts";
import { OpError, type Ctx } from "./ops.ts";
import { getRepo, listRepoRows, type RepoRow } from "./repos.ts";
import type { Participant } from "./rooms.ts";
import type { Access } from "./auth.ts";
import { RepoBusyError } from "./store/types.ts";

type AccessFn = (repo: RepoRow) => Promise<Access>;

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_VERSION = "2025-06-18";
// Stays below Bun's 120 s idle timeout.
const MAX_WAIT_S = 110;

const INSTRUCTIONS = `Notepad is a shared, multiplayer Markdown notepad. Content is organized in repos (call list_repos first); each repo is a Git repository of Markdown files (.md, .markdown, .mdx), and paths are relative to the repo root ("notes/today.md"; ".md" is added if missing).

- Edits are live: people with the file open see your changes immediately, with a cursor labelled with your name. Files are auto-committed to Git after 15 seconds without edits; call save to commit right away.
- Prefer edit_file (replace one exact snippet) or append_file over write_file, so you never overwrite text someone else is typing. write_file replaces the whole file (as a minimal diff) and should be used only for large rewrites.
- read_file returns a version. Pass it as expected_version to edit_file/write_file so the edit fails instead of clobbering changes made since you read; on a version error, read the file again and retry.
- Use wait_for_change to wait for others to edit a file (or the repo) and react to it; use who_is_here to see who has a file open.
- Use file_history and diff to see past commits (authors, messages, changes).`;

const AUTO_COMMIT = "The change is live immediately and committed to Git automatically after 15 s without edits (or call save).";

// ---- tool definitions ----

interface Schema {
  type: "string" | "integer";
  description: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  default?: unknown;
}

type Args = Record<string, unknown>;

interface CallCtx {
  ctx: Ctx;
  actor: Participant;
  access: AccessFn;
  signal: AbortSignal;
  repo: RepoRow; // only meaningful for tools with `need`
}

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: false };
  need: Access | null; // repo access needed; null: no repo argument
  run(args: Args, c: CallCtx): Promise<string>;
}

const s = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: "string", description, ...extra });
const REPO = s("Repo id, as returned by list_repos (e.g. \"notes\").", { minLength: 1 });
const PATH = s("File path relative to the repo root, e.g. \"ideas/todo.md\". \".md\" is appended if the path has no Markdown extension.", { minLength: 1 });
const EXPECTED = s("Optional. The version returned by read_file (or a previous edit). If the file has changed since, the call fails instead of overwriting; read the file again and retry.");

function tool(
  name: string,
  title: string,
  description: string,
  props: Record<string, Schema>,
  required: string[],
  hints: { readOnly: boolean; destructive?: boolean; idempotent?: boolean },
  need: Access | null,
  run: Tool["run"],
): Tool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: props, required, additionalProperties: false },
    annotations: {
      title,
      readOnlyHint: hints.readOnly,
      ...(hints.readOnly ? {} : { destructiveHint: hints.destructive ?? false }),
      ...(hints.idempotent !== undefined ? { idempotentHint: hints.idempotent } : {}),
      openWorldHint: false,
    },
    need,
    run,
  };
}

const json = (v: unknown) => JSON.stringify(v);
const str = (a: Args, k: string) => a[k] as string;
const opt = (a: Args, k: string) => (a[k] === undefined || a[k] === null || a[k] === "" ? undefined : (a[k] as string));

/** Effective access: write access to a read-only repo is read access. */
async function accessTo(access: AccessFn, row: RepoRow): Promise<Access> {
  const raw = await access(row);
  return raw === "write" && row.read_only ? "read" : raw;
}

async function currentVersion(c: CallCtx, path: string): Promise<string | null> {
  try {
    return (await ops.readFile(c.ctx, c.repo, path)).version;
  } catch (e) {
    if (e instanceof OpError && e.status === 404) return null;
    throw e;
  }
}

const TOOLS: Tool[] = [
  tool(
    "list_repos",
    "List repos",
    "List the repos (collections of Markdown notes) you can access. Returns a JSON array of {id, title, kind, branch, status, access, github?, error?}. Use the id as the `repo` argument of the other tools. Only repos with status \"ready\" can be used; access \"read\" means you can read but not edit.",
    {},
    [],
    { readOnly: true, idempotent: true },
    null,
    async (_a, c) => {
      const out = [];
      for (const r of listRepoRows()) {
        const access = await accessTo(c.access, r);
        if (access === "none") continue;
        out.push({
          id: r.id,
          title: r.title,
          kind: r.kind,
          branch: r.branch,
          status: r.status,
          access,
          ...(r.gh_owner ? { github: `${r.gh_owner}/${r.gh_name}` } : {}),
          ...(r.error ? { error: r.error } : {}),
        });
      }
      return json(out);
    },
  ),
  tool(
    "list_files",
    "List files",
    "List all Markdown files in a repo (committed files at the branch tip), as a sorted JSON array of path strings.",
    { repo: REPO },
    ["repo"],
    { readOnly: true, idempotent: true },
    "read",
    async (_a, c) => json(await ops.listFiles(c.ctx, c.repo)),
  ),
  tool(
    "read_file",
    "Read file",
    "Read a Markdown file. The first line of the result is a JSON header {path, version, live}; the rest (after the first newline) is the exact file content. `live: true` means the file is open and the content includes not-yet-committed edits; otherwise it is the committed content. Pass `version` as expected_version to edit_file/write_file. With `ref` (a commit sha or branch) you get the file at that commit instead.",
    { repo: REPO, path: PATH, ref: s("Optional commit sha or branch name to read an old version from. Omit for the current (live) text.") },
    ["repo", "path"],
    { readOnly: true, idempotent: true },
    "read",
    async (a, c) => {
      const f = await ops.readFile(c.ctx, c.repo, str(a, "path"), opt(a, "ref"));
      return `${json({ path: f.path, version: f.version, live: f.live })}\n${f.content}`;
    },
  ),
  tool(
    "search",
    "Search",
    "Full-text search across the committed Markdown files of a repo (case-insensitive substring match; edits from the last ~15 s may not be found yet). Returns a JSON array of {path, line, text} (up to 100 hits; line is 1-based).",
    { repo: REPO, query: s("Text to search for.", { minLength: 1 }) },
    ["repo", "query"],
    { readOnly: true, idempotent: true },
    "read",
    async (a, c) => json(await ops.search(c.ctx, c.repo, str(a, "query"))),
  ),
  tool(
    "create_file",
    "Create file",
    "Create a new Markdown file with the given content and commit it immediately. Fails if the file already exists (use edit_file/write_file to change existing files). Parent folders are created implicitly. Returns {path, version}.",
    { repo: REPO, path: PATH, content: s("Full initial Markdown content of the file.") },
    ["repo", "path", "content"],
    { readOnly: false, destructive: false, idempotent: false },
    "write",
    async (a, c) => json(await ops.createFile(c.ctx, c.repo, str(a, "path"), str(a, "content"), c.actor)),
  ),
  tool(
    "write_file",
    "Write file",
    `Replace the entire content of an existing file. Applied as a minimal diff, so people's cursors and untouched text survive, but any text not in \`content\` is removed — prefer edit_file or append_file for small changes, and pass expected_version so you don't clobber edits made since you read. ${AUTO_COMMIT} Returns {path, version}.`,
    { repo: REPO, path: PATH, content: s("The complete new Markdown content of the file."), expected_version: EXPECTED },
    ["repo", "path", "content"],
    { readOnly: false, destructive: true, idempotent: true },
    "write",
    async (a, c) => json(await ops.writeFile(c.ctx, c.repo, str(a, "path"), str(a, "content"), c.actor, opt(a, "expected_version"))),
  ),
  tool(
    "edit_file",
    "Edit file",
    `Replace one exact snippet of a file. \`old_text\` must occur exactly once in the current text (whitespace and newlines count); include a few surrounding words or lines to make it unique. Fails if it is not found or matches more than once — then read the file again. Use an empty new_text to delete the snippet. ${AUTO_COMMIT} Returns {path, version}.`,
    {
      repo: REPO,
      path: PATH,
      old_text: s("Exact text to replace; must match exactly once.", { minLength: 1 }),
      new_text: s("Replacement text (may be empty to delete)."),
      expected_version: EXPECTED,
    },
    ["repo", "path", "old_text", "new_text"],
    { readOnly: false, destructive: true, idempotent: false },
    "write",
    async (a, c) =>
      json(await ops.editFile(c.ctx, c.repo, str(a, "path"), str(a, "old_text"), str(a, "new_text"), c.actor, opt(a, "expected_version"))),
  ),
  tool(
    "append_file",
    "Append to file",
    `Append text to the end of a file (a newline is inserted first if the file doesn't end with one). Creates the file if it doesn't exist. Safe to use while others are editing. ${AUTO_COMMIT} Returns {path, version}.`,
    { repo: REPO, path: PATH, text: s("Markdown text to append.", { minLength: 1 }) },
    ["repo", "path", "text"],
    { readOnly: false, destructive: false, idempotent: false },
    "write",
    async (a, c) => json(await ops.appendFile(c.ctx, c.repo, str(a, "path"), str(a, "text"), c.actor)),
  ),
  tool(
    "delete_file",
    "Delete file",
    "Delete a file and commit the deletion immediately. People who have it open see it closed. It can still be recovered from history. Returns {ok: true}.",
    { repo: REPO, path: PATH },
    ["repo", "path"],
    { readOnly: false, destructive: true, idempotent: false },
    "write",
    async (a, c) => json(await ops.deleteFile(c.ctx, c.repo, str(a, "path"), c.actor)),
  ),
  tool(
    "rename_file",
    "Rename file",
    "Rename or move a file (including not-yet-committed live edits) in a single commit. Fails if the destination exists. Returns {path} with the new path.",
    { repo: REPO, from: s("Current path of the file.", { minLength: 1 }), to: s("New path, e.g. \"archive/old.md\".", { minLength: 1 }) },
    ["repo", "from", "to"],
    { readOnly: false, destructive: false, idempotent: false },
    "write",
    async (a, c) => json(await ops.renameFile(c.ctx, c.repo, str(a, "from"), str(a, "to"), c.actor)),
  ),
  tool(
    "file_history",
    "File history",
    "List the commits that changed a file, newest first, as a JSON array of {sha, message, authorName, authorEmail, date}. Use diff with a sha to see what changed, or read_file with ref=sha to read an old version.",
    { repo: REPO, path: PATH, limit: { type: "integer", description: "Maximum number of commits (1-200).", minimum: 1, maximum: 200, default: 20 } },
    ["repo", "path"],
    { readOnly: true, idempotent: true },
    "read",
    async (a, c) => json(await ops.history(c.ctx, c.repo, str(a, "path"), (a.limit as number | undefined) ?? 20)),
  ),
  tool(
    "diff",
    "Show commit diff",
    "Show the unified diff of one commit against its parent, optionally limited to one file. Returns the diff as plain text (\"(no changes)\" if empty).",
    { repo: REPO, sha: s("Commit sha (from file_history).", { minLength: 7 }), path: s("Optional file path to limit the diff to.") },
    ["repo", "sha"],
    { readOnly: true, idempotent: true },
    "read",
    async (a, c) => (await ops.diff(c.ctx, c.repo, str(a, "sha"), opt(a, "path"))) || "(no changes)",
  ),
  tool(
    "save",
    "Save (commit) file",
    "Commit a file's pending live edits to Git now instead of waiting for the automatic commit (15 s after the last edit). Returns {path, saved, commit}: saved is false if there was nothing to commit; commit is the file's latest commit sha in the open session (null if the file isn't open).",
    { repo: REPO, path: PATH },
    ["repo", "path"],
    { readOnly: false, destructive: false, idempotent: true },
    "write",
    async (a, c) => {
      const p = ops.path(str(a, "path"));
      const room = c.ctx.rooms.peek(c.repo.id, p);
      if (!room?.dirty) return json({ path: p, saved: false, commit: room?.status().commit ?? null });
      await room.flush();
      return json({ path: p, saved: true, commit: room.status().commit });
    },
  ),
  tool(
    "who_is_here",
    "Who is here",
    "List the people and agents who currently have a file open, as a JSON array of {id, name, kind, color}. Includes agents (possibly you) that edited the file in the last ~30 s. Empty if nobody has it open.",
    { repo: REPO, path: PATH },
    ["repo", "path"],
    { readOnly: true, idempotent: true },
    "read",
    async (a, c) => json(c.ctx.rooms.peek(c.repo.id, ops.path(str(a, "path")))?.participants() ?? []),
  ),
  tool(
    "wait_for_change",
    "Wait for change",
    `Block until a file (or, without path, anything in the repo) changes, or until the timeout. With path and since_version (from read_file), returns immediately if the file already differs from that version. Returns {changed} without path, or {changed, version} with path (version: the file's current version, null if it doesn't exist); then read_file to see what changed. Use this to react to people's edits instead of polling.`,
    {
      repo: REPO,
      path: s("Optional file to watch. Omit to watch the whole repo."),
      since_version: s("Optional version you last saw (from read_file or an edit). Requires path."),
      timeout_seconds: { type: "integer", description: `How long to wait, in seconds (0-${MAX_WAIT_S}).`, minimum: 0, maximum: MAX_WAIT_S, default: 30 },
    },
    ["repo"],
    { readOnly: true, idempotent: true },
    "read",
    async (a, c) => {
      const raw = opt(a, "path");
      const p = raw === undefined ? undefined : ops.path(raw);
      const since = opt(a, "since_version");
      if (since && !p) throw new OpError(400, "since_version requires path");
      const timeout = ((a.timeout_seconds as number | undefined) ?? 30) * 1000;
      if (p && since) {
        const v = await currentVersion(c, p);
        if (v !== since) return json({ changed: true, version: v });
      }
      let changed = await waitForChange(c.repo.id, p, timeout, c.signal);
      if (!p) return json({ changed });
      const v = await currentVersion(c, p);
      if (!changed && since && v !== since) changed = true;
      return json({ changed, version: v });
    },
  ),
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool list as sent to clients (without internal fields). */
export function toolList() {
  return TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, title: annotations.title, description, inputSchema, annotations }));
}

function validate(t: Tool, args: Args): string | null {
  const { properties, required } = t.inputSchema;
  for (const k of required) if (args[k] === undefined || args[k] === null) return `missing required argument: ${k}`;
  for (const [k, v] of Object.entries(args)) {
    const sch = properties[k];
    if (!sch) return `unknown argument: ${k}`;
    if (v === undefined || v === null) continue;
    if (sch.type === "string") {
      if (typeof v !== "string") return `${k} must be a string`;
      if (sch.minLength && v.length < sch.minLength) return `${k} must be at least ${sch.minLength} characters`;
    } else {
      if (typeof v !== "number" || !Number.isInteger(v)) return `${k} must be an integer`;
      if (sch.minimum !== undefined && v < sch.minimum) return `${k} must be >= ${sch.minimum}`;
      if (sch.maximum !== undefined && v > sch.maximum) return `${k} must be <= ${sch.maximum}`;
    }
  }
  return null;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(params: unknown, ctx: Ctx, actor: Participant, access: AccessFn, signal: AbortSignal) {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const t = typeof p.name === "string" ? TOOL_MAP.get(p.name) : undefined;
  if (!t) return text(`unknown tool: ${String(p.name)}. Available: ${TOOLS.map((x) => x.name).join(", ")}`, true);
  if (p.arguments !== undefined && p.arguments !== null && (typeof p.arguments !== "object" || Array.isArray(p.arguments))) {
    return text(`${t.name}: arguments must be an object`, true);
  }
  const args = (p.arguments ?? {}) as Args;
  const bad = validate(t, args);
  if (bad) return text(`${t.name}: ${bad}`, true);
  try {
    let repo = undefined as unknown as RepoRow;
    if (t.need) {
      const id = args.repo as string;
      const row = getRepo(id);
      const have = row ? await accessTo(access, row) : "none";
      if (!row || have === "none") return text(`repo not found: ${id}. Call list_repos to see available repos.`, true);
      if (t.need === "write" && have !== "write") return text(`${id} is read-only for you`, true);
      if (row.status !== "ready") return text(`${id} is ${row.status}${row.error ? `: ${row.error}` : ""}; try again later`, true);
      repo = row;
    }
    return text(await t.run(args, { ctx, actor, access, signal, repo }));
  } catch (e) {
    if (e instanceof RepoBusyError) return text(`${e.message}; try again later`, true);
    if (!(e instanceof OpError)) console.error(`[mcp] ${t.name}:`, e);
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

// ---- JSON-RPC ----

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type RpcResponse = { jsonrpc: "2.0"; id: unknown; result: unknown } | { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

const rpcError = (id: unknown, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Handle one message; returns null for notifications and client responses. */
async function handleMessage(m: unknown, ctx: Ctx, actor: Participant, access: AccessFn, signal: AbortSignal): Promise<RpcResponse | null> {
  if (!m || typeof m !== "object" || Array.isArray(m)) return rpcError(null, -32600, "Invalid Request");
  const msg = m as RpcMessage;
  const hasId = "id" in msg && msg.id !== undefined;
  const validId = !hasId || msg.id === null || typeof msg.id === "string" || typeof msg.id === "number";
  if (msg.jsonrpc !== "2.0" || !validId) return rpcError(validId ? (msg.id ?? null) : null, -32600, "Invalid Request");
  if (typeof msg.method !== "string") {
    // A response from the client (result/error) needs no reply; anything else is invalid.
    if (hasId && ("result" in msg || "error" in msg)) return null;
    return rpcError(msg.id ?? null, -32600, "Invalid Request");
  }
  if (!hasId) return null; // notification (notifications/initialized, notifications/cancelled, ...)
  const id = msg.id;
  const ok = (result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion = typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_VERSION;
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "notepad", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: toolList() });
    case "tools/call":
      return ok(await callTool(msg.params, ctx, actor, access, signal));
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const isInitialize = (body: unknown) =>
  (Array.isArray(body) ? body : [body]).some((m) => !!m && typeof m === "object" && (m as RpcMessage).method === "initialize");

export async function handleMcp(req: Request, ctx: Ctx, actor: Participant, access: AccessFn): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST" },
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return reply(rpcError(null, -32700, "Parse error"), 400);
  }
  // The version header is only meaningful after initialization negotiated a version.
  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !PROTOCOL_VERSIONS.includes(pv) && !isInitialize(body)) {
    return reply(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${pv}`), 400);
  }
  if (Array.isArray(body)) {
    if (!body.length) return reply(rpcError(null, -32600, "Invalid Request: empty batch"), 400);
    // Sequential, so a batch like [create_file, edit_file] behaves as written.
    const out: RpcResponse[] = [];
    for (const m of body) {
      const r = await handleMessage(m, ctx, actor, access, req.signal);
      if (r) out.push(r);
    }
    return out.length ? reply(out) : new Response(null, { status: 202 });
  }
  const res = await handleMessage(body, ctx, actor, access, req.signal);
  return res ? reply(res) : new Response(null, { status: 202 });
}

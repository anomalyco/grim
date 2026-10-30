// The account's MCP server at /mcp: Streamable HTTP (JSON responses, no SSE stream), JSON-RPC 2.0 by hand, two tools.
// One connection works across all of the caller's workspaces:
//   list_workspaces: the workspaces they've joined;
//   changes: what people wrote by hand since the last agent commit in one workspace (changes.ts);
//   command: a shell script in one workspace, in the same sandboxed shell as agent links (/a/<id>: shares.ts), with
//            the same limits per workspace, live edits, agent cursor and commits.
// Who the caller is (app.ts `mcpCaller`): an account by its bearer app token (OAuth: oauth.ts), or on a server without
// sign-in the shared MCP visitor. On Workers this runs in the caller's ShellDO ("user:<id>"), which sees all their calls.
import { participantForAgent, repoAccess } from "./auth.ts";
import { config } from "./config.ts";
import { errStatus, isErr } from "./errors.ts";
import { formatChanges } from "./changes.ts";
import type { RepoRow } from "./repos.ts";
import type { Participant } from "./rooms.ts";
import { cleanLabel, LIVE_EDITS, rateLimited, shareLimits, shellLimits, usefulCommands, type ShareCtx } from "./shares.ts";
import { WORKSPACE } from "./shell/fs.ts";
import { DEFAULT_TIMEOUT_S, formatResult, MAX_TIMEOUT_S, parseTimeout, type ShellSessions } from "./shell/session.ts";
import { listedRows, workspaceAccess } from "./workspaces.ts";
import { DEMO_ID } from "./demo.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_VERSION = "2025-06-18";

/** Who is calling: whose workspaces (an account; with sign-in off, the local user everyone is: every workspace). */
export interface McpCaller {
  userId: string;
}

/** The name an agent's cursor and commits get when its client doesn't say. */
export const DEFAULT_AGENT_NAME = "MCP agent";

const SESSION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
/** Workspaces whose note count list_workspaces reads (each is a tree read). */
const MAX_COUNTED = 50;

export function instructions(): string {
  const host = new URL(config.publicUrl).host;
  return `Grim (${host}) is a shared, multiplayer Markdown notebook: people edit notes live in the browser, and every note is a Markdown file in a Git repo. Notes live in workspaces (one Git repo each).

Three tools:
- \`list_workspaces\`: your workspaces (id, title, access, note count). Any other workspace whose id you're given (it's the part after /app/ in a ${host} link) works too.
- \`command\`: runs a shell script (bash syntax) in one workspace, in a sandboxed shell whose filesystem is that workspace's live notes. Your shell starts in ${WORKSPACE}/<workspace>, the workspace's folder. This is how you read, search and edit notes.
- \`changes\`: what people wrote by hand in a workspace since the last agent commit (any agent's), unsaved live edits included: a file list with +/− counts and unified diffs. Run it when you come back to a workspace, before you start. (The same as the shell's \`changes\` command.)

${LIVE_EDITS}

Shell state (cwd, variables, /tmp) persists between calls to the same workspace (and \`session\`, for separate shells side by side) during this MCP connection.

Useful commands:
${usefulCommands("todo.md")}

Limits:
${shellLimits(null, "", "per workspace")}`;
}

const COMMAND_DESCRIPTION = `Run a shell script in one Grim workspace: a single command, a pipeline or a whole script (bash syntax: pipes, redirects, heredocs, &&, ||, ;, loops, $(...)). It runs in a sandboxed shell whose filesystem is the workspace's live Markdown notes; it starts in the workspace's folder (${WORKSPACE}/<workspace>).

Writes are live: people with a note open see the change at once, with your cursor, and the files you changed are committed to Git right after each call, as your own commit. Read-only workspaces can be read but not written. cwd, variables and /tmp persist between calls with the same workspace and session.

Examples:
  ls -R; find . -name '*.md' | head -50
  grep -rn 'TODO' .
  cat todo.md; sed -n '40,80p' long.md
  sed -i 's/- \\[ \\] milk/- [x] milk/' todo.md
  echo '- buy eggs' >> todo.md
  cat > ideas/new.md <<'EOF'
  # New idea
  Text here.
  EOF
  mv draft.md archive/draft.md; rm old.md
  git log --oneline -n 5 todo.md; git show HEAD; git diff; git status

Grim commands: repos (the workspace and your access); changes [--stat] [path] (what people wrote by hand since the last agent commit); save [path] (rarely needed: your writes are committed after each call); who <file> (who has it open); watch [path] [--timeout S] (blocks until someone else edits; waiting doesn't count toward the time limit, max ${MAX_TIMEOUT_S} s); git log [-n N] [--oneline] [path] | show <commit> [path] | diff [<commit>] [path] | status (read-only; commits are automatic).

Constraints: only Markdown files (.md, .markdown, .mdx) exist in a workspace; /tmp is private scratch space. No python/node/other runtimes, no network, no interactive programs or editors (use sed -i, heredocs, >>). Output over 200 KB per stream is truncated. Each call stops after timeout_seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). At most ${shareLimits.perMinute} calls per minute and ${shareLimits.concurrent} commands at a time per workspace.

Result: stdout, then "[stderr]" and stderr if any, then "[exit N]" if the exit code isn't 0.`;

const TOOLS = [
  {
    name: "list_workspaces",
    title: "List workspaces",
    description: "List your Grim workspaces (the ones you've joined; on a server without sign-in, all of its workspaces): id, title, access (read or write), kind (notes, or a read-only copy of a GitHub repo), status and note count. Pass an id to `command` to work in that workspace. Workspaces not listed here can still be used by id if someone gave you one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List workspaces", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "changes",
    title: "What people changed",
    description:
      "What people wrote by hand since the last agent commit in this workspace (by any agent: you, another MCP client or an agent link), including edits not saved yet. Returns a header naming that commit, the changed notes with status (added, modified, deleted, renamed) and +/- line counts, then unified diffs (over 200 KB: the list only; narrow it with `path`). With no agent commit yet, every change since the workspace began. The JSON is in structuredContent: {since: {commit, agent, at} | null, files: [{path, status, from?, added, removed, diff}], truncated}.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "The workspace id (from list_workspaces, or the part after /app/ in a workspace link).", minLength: 1 },
        path: { type: "string", description: "Optional: only this note or folder (relative to the workspace)." },
      },
      required: ["workspace"],
      additionalProperties: false,
    },
    annotations: { title: "What people changed", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "command",
    title: "Run a command in a workspace",
    description: COMMAND_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "The workspace id (from list_workspaces, or the part after /app/ in a workspace link).", minLength: 1 },
        command: { type: "string", description: "The shell script to run, from one command to a multi-line script (bash syntax).", minLength: 1 },
        session: { type: "string", description: "Optional name of a separate shell in this workspace (its own cwd, variables and /tmp): 1-128 characters of A-Z a-z 0-9 . _ : -.", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
        timeout_seconds: {
          type: "number",
          description: `Time limit for this call in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). Time spent in \`watch\` doesn't count, but no call runs longer than ${MAX_TIMEOUT_S} s in total.`,
          minimum: 1,
          maximum: MAX_TIMEOUT_S,
          default: DEFAULT_TIMEOUT_S,
        },
      },
      required: ["workspace", "command"],
      additionalProperties: false,
    },
    annotations: { title: "Run a command in a workspace", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

/** Tool list as sent to clients. */
export function toolList() {
  return TOOLS;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** One MCP connection: its id (keys its shells) and the agent's name (its client's). */
interface Connection {
  id: string;
  name: string;
}

interface CallCtx {
  server: McpServer;
  caller: McpCaller;
  conn: Connection;
  signal: AbortSignal;
}

/** The shell actor of a caller in one workspace: its cursor, commits, limits and sessions. */
export const mcpActorId = (userId: string, workspace: string) => `mcp:${userId}:${workspace}`;

async function listWorkspaces(c: CallCtx) {
  const ctx = c.server.ctx;
  const rows = await listedRows(ctx.repos.db, c.caller.userId);
  const counts = await Promise.all(rows.map((r, i) => (i < MAX_COUNTED && r.status === "ready" ? ctx.repos.tree(r).then((f) => f.length, () => null) : Promise.resolve(null))));
  const workspaces = rows.map((r, i) => ({
    id: r.id,
    title: r.title,
    access: repoAccess(r),
    kind: r.kind,
    status: r.status,
    ...(counts[i] !== null ? { notes: counts[i] } : {}),
    url: `${config.publicUrl}/app/${encodeURIComponent(r.id)}`,
  }));
  const body = workspaces.length ? JSON.stringify({ workspaces }, null, 2) : "You haven't joined any workspaces yet. Open one in Grim (or pass a workspace id you were given to `command`).";
  return { ...text(body), structuredContent: { workspaces } };
}

async function command(params: Record<string, unknown>, c: CallCtx) {
  for (const k of Object.keys(params)) if (!["workspace", "command", "session", "timeout_seconds"].includes(k)) return text(`unknown argument: ${k} (expected workspace, command, session, timeout_seconds)`, true);
  const id = params.workspace;
  if (typeof id !== "string" || !id.trim()) return text("workspace is required (a workspace id: see list_workspaces)", true);
  if (typeof params.command !== "string" || !params.command.trim()) return text("command is required (a non-empty string)", true);
  if (params.session !== undefined && (typeof params.session !== "string" || !SESSION_KEY.test(params.session))) return text("session must be 1-128 characters of A-Z a-z 0-9 . _ : -", true);
  const timeout = parseTimeout(params.timeout_seconds);
  if (typeof timeout === "string") return text(timeout, true);
  const { ctx, shells } = c.server;
  const userId = c.caller.userId;
  const repo = id === DEMO_ID ? null : await ctx.repos.get(id.trim());
  const notFound = `No workspace "${id}" on this server. list_workspaces lists yours.`;
  if (!repo) return text(notFound, true);
  if (repo.status !== "ready") return text(`Workspace ${repo.id} isn't ready (${repo.status === "importing" ? "still importing" : (repo.error ?? repo.status)}); try again shortly.`, true);
  const access = workspaceAccess(ctx.repos.db, userId, repo.id);
  if ((await access(repo)) === "none") return text(notFound, true);
  const actorId = mcpActorId(userId, repo.id);
  const wait = rateLimited(actorId);
  if (wait) return text(`Too many calls: at most ${shareLimits.perMinute} per minute per workspace. Retry in ${wait} s.`, true);
  if (shells.pending(actorId) >= shareLimits.concurrent) return text(`${shareLimits.concurrent} commands are already running or queued in this workspace; wait for them to finish.`, true);
  const actor: Participant = participantForAgent({ id: actorId, name: c.conn.name });
  try {
    const run = shells.exec(actor, `mcp:${c.conn.id}${params.session ? `:${params.session}` : ""}`, access, params.command, {
      timeoutMs: timeout * 1000,
      signal: c.signal,
      cwd: `${WORKSPACE}/${repo.id}`,
    });
    return text(formatResult(await run));
  } catch (e) {
    if (!isErr(e, "ShellBusyError")) console.error("[mcp] command:", e);
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

/** The workspace a tool call names, if the caller may use it (as `command` checks), else the error to return. */
async function openWorkspace(id: unknown, c: CallCtx): Promise<{ repo: RepoRow; actorId: string } | ReturnType<typeof text>> {
  if (typeof id !== "string" || !id.trim()) return text("workspace is required (a workspace id: see list_workspaces)", true);
  const ctx = c.server.ctx;
  const repo = id === DEMO_ID ? null : await ctx.repos.get(id.trim());
  const notFound = `No workspace "${id}" on this server. list_workspaces lists yours.`;
  if (!repo) return text(notFound, true);
  if (repo.status !== "ready") return text(`Workspace ${repo.id} isn't ready (${repo.status === "importing" ? "still importing" : (repo.error ?? repo.status)}); try again shortly.`, true);
  if ((await workspaceAccess(ctx.repos.db, c.caller.userId, repo.id)(repo)) === "none") return text(notFound, true);
  const actorId = mcpActorId(c.caller.userId, repo.id);
  const wait = rateLimited(actorId);
  if (wait) return text(`Too many calls: at most ${shareLimits.perMinute} per minute per workspace. Retry in ${wait} s.`, true);
  return { repo, actorId };
}

async function changes(params: Record<string, unknown>, c: CallCtx) {
  for (const k of Object.keys(params)) if (!["workspace", "path"].includes(k)) return text(`unknown argument: ${k} (expected workspace, path)`, true);
  if (params.path !== undefined && typeof params.path !== "string") return text("path must be a string", true);
  const w = await openWorkspace(params.workspace, c);
  if (!("repo" in w)) return w;
  const path = ((params.path as string | undefined) ?? "").replace(/^\/+|\/+$/g, "");
  try {
    const r = await c.server.ctx.repos.host.get(w.repo.id).changes(w.repo, path);
    return { ...text(formatChanges(r, { path: path || undefined })), structuredContent: r };
  } catch (e) {
    if (errStatus(e) === undefined) console.error("[mcp] changes:", e);
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

async function callTool(params: unknown, c: CallCtx) {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (p.arguments !== undefined && p.arguments !== null && (typeof p.arguments !== "object" || Array.isArray(p.arguments))) return text("arguments must be an object", true);
  const args = (p.arguments ?? {}) as Record<string, unknown>;
  if (p.name === "list_workspaces") return listWorkspaces(c);
  if (p.name === "command") return command(args, c);
  if (p.name === "changes") return changes(args, c);
  return text(`unknown tool: ${String(p.name)}. The tools are list_workspaces, command and changes.`, true);
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
async function handleMessage(m: unknown, c: CallCtx): Promise<RpcResponse | null> {
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
        serverInfo: { name: "grim", title: "Grim", version: "0.3.0" },
        instructions: instructions(),
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: toolList() });
    case "tools/call":
      return ok(await callTool(msg.params, c));
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

const MAX_BATCH = 32;

const hasMethod = (m: unknown, method: string) => !!m && typeof m === "object" && (m as RpcMessage).method === method;

/** A single, valid initialize request: the only thing that starts a connection. */
const isInitialize = (m: unknown) => {
  if (!hasMethod(m, "initialize")) return false;
  const msg = m as RpcMessage;
  return msg.jsonrpc === "2.0" && (typeof msg.id === "string" || typeof msg.id === "number");
};

/** The agent's name from initialize's clientInfo (its title, else its name). */
function clientName(m: unknown): string {
  const info = ((m as RpcMessage).params as { clientInfo?: { name?: unknown; title?: unknown } } | undefined)?.clientInfo;
  return cleanLabel(info?.title) ?? cleanLabel(info?.name) ?? DEFAULT_AGENT_NAME;
}

/**
 * Mcp-Session-Id: "<uuid>.<the agent's name, base64url>". Nothing is kept per connection on the server (a ShellDO may
 * be evicted, a Bun server restarted): the id names the connection's shells and carries the name its cursor shows.
 */
function sessionId(conn: Connection): string {
  return `${conn.id}.${Buffer.from(conn.name, "utf8").toString("base64url")}`;
}

function parseSessionId(raw: string | null): Connection | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{0,200})$/.exec(raw ?? "");
  if (!m) return null;
  return { id: m[1]!, name: cleanLabel(Buffer.from(m[2]!, "base64url").toString("utf8")) ?? DEFAULT_AGENT_NAME };
}

export class McpServer {
  constructor(
    readonly shells: ShellSessions,
    readonly ctx: ShareCtx,
  ) {}

  async handle(req: Request, caller: McpCaller, headers: Record<string, string> = {}): Promise<Response> {
    const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers, ...extra } });
    // (nothing is kept per connection: ending one only lets its shells expire)
    if (req.method === "DELETE") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return reply({ error: "Method Not Allowed: POST JSON-RPC messages (this server sends no SSE stream)" }, 405, { allow: "POST, DELETE" });
    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return reply(rpcError(null, -32700, "Parse error"), 400);
    }
    if (Array.isArray(body)) {
      if (!body.length) return reply(rpcError(null, -32600, "Invalid Request: empty batch"), 400);
      if (body.length > MAX_BATCH) return reply(rpcError(null, -32600, `Invalid Request: at most ${MAX_BATCH} messages per batch`), 400);
      if (body.some((m) => hasMethod(m, "initialize"))) return reply(rpcError(null, -32600, "Invalid Request: initialize must not be batched"), 400);
    }
    const init = isInitialize(body);
    // The version header is only meaningful after initialization negotiated a version.
    const pv = req.headers.get("mcp-protocol-version");
    if (pv && !PROTOCOL_VERSIONS.includes(pv) && !init) return reply(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${pv}`), 400);
    // Clients that don't keep the session id share one connection per caller.
    const conn: Connection = init ? { id: crypto.randomUUID(), name: clientName(body) } : (parseSessionId(req.headers.get("mcp-session-id")) ?? { id: "00000000-0000-0000-0000-000000000000", name: DEFAULT_AGENT_NAME });
    const out: Record<string, string> = init ? { "mcp-session-id": sessionId(conn) } : {};
    const c: CallCtx = { server: this, caller, conn, signal: req.signal };
    if (Array.isArray(body)) {
      const results: RpcResponse[] = [];
      for (const m of body) {
        const r = await handleMessage(m, c);
        if (r) results.push(r);
      }
      return results.length ? reply(results, 200, out) : new Response(null, { status: 202, headers: { ...headers, ...out } });
    }
    const res = await handleMessage(body, c);
    return res ? reply(res, 200, out) : new Response(null, { status: 202, headers: { ...headers, ...out } });
  }
}

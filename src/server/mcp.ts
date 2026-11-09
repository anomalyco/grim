// The account's MCP server at /mcp: Streamable HTTP (JSON responses, no SSE stream), JSON-RPC 2.0 by hand.
// One connection works across all of the caller's workspaces, one note at a time (docs/storage-v2.md §8):
//   list_workspaces: the workspaces they've joined;
//   list_notes: a workspace's notes, with their URLs;
//   note_command: a shell command on one note (the note shell, notes/shell.ts: the note is the only file), the same
//                 as POSTing to the note's URL: live edits, agent cursor, its own version, the same limits.
// Who the caller is (app.ts `mcpCaller`): an account by its bearer app token (OAuth: oauth.ts), or on a server without
// sign-in the shared MCP visitor.
import { metric } from "./metrics.ts";
import { participantForAgent, repoAccess } from "./auth.ts";
import { config } from "./config.ts";
import { errStatus } from "./errors.ts";
import type { RepoRow } from "./repos.ts";
import { cleanLabel, LIVE_EDITS, noteUrl, parseAppUrl, runAgentCommand, shellLimits, type AgentCtx } from "./agent-url.ts";
import { DEFAULT_TIMEOUT_S, formatResult, MAX_TIMEOUT_S, parseTimeout } from "./notes/shell.ts";
import { listedRows } from "./workspaces.ts";
import { DEMO_ID } from "./demo.ts";
import { isDemoRoom } from "./demo-rooms.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_VERSION = "2025-06-18";

/** Who is calling: whose workspaces (an account; with sign-in off, the local user everyone is: every workspace). */
export interface McpCaller {
  userId: string;
}

/** The name an agent's cursor and versions get when its client doesn't say. */
export const DEFAULT_AGENT_NAME = "MCP agent";

/** Workspaces whose note count list_workspaces reads. */
const MAX_COUNTED = 50;

export function instructions(): string {
  const host = new URL(config.publicUrl).host;
  return `Grim (${host}) is a shared, multiplayer Markdown notebook: people edit notes live in the browser. Notes live in workspaces; you work on one note at a time.

Tools:
- \`list_workspaces\`: your workspaces (id, title, access, note count). Any other workspace whose id you're given (the part after /app/ in a ${host} link) works too.
- \`list_notes\`: a workspace's notes, with their URLs.
- \`note_command\`: runs a shell script (bash syntax) on ONE note. The note is the only file, ./<its name>, in an otherwise empty directory: cat, sed -i, grep, awk, >>, heredocs all work on it. \`history\` lists its versions, \`history show <id>\` prints one, \`history diff <id>\` shows what it changed; \`who\` lists who has it open.

${LIVE_EDITS}

Limits:
${shellLimits()}`;
}

const NOTE_ARG = {
  type: "string",
  description: `The note: its URL (${"https://<server>/app/<workspace>/<path>"}) or "<workspace>/<path>" (e.g. "design-k7f3m2q9xbtw/plans/q3.md"). A path that doesn't exist is created when the command writes it (accounts only).`,
  minLength: 1,
};

const COMMAND_DESCRIPTION = `Run a shell script on one Grim note: a command, a pipeline or a whole script (bash syntax: pipes, redirects, heredocs, &&, ||, loops). The note is the only file: ./<its file name> in the working directory. Nothing else exists (no other notes, no workspace tree, no network).

What the script writes to the note lands live (people see it at once, with your cursor) and becomes a version of its own. If someone changed the same spot meanwhile, the write is refused: read again and redo.

Examples (for a note named todo.md):
  cat todo.md; sed -n '40,80p' todo.md; grep -n TODO todo.md
  sed -i 's/- \\[ \\] milk/- [x] milk/' todo.md
  echo '- buy eggs' >> todo.md
  cat > todo.md <<'EOF'
  # Todo
  EOF
  history; history show <id>; history diff <id>; who

Each call stops after timeout_seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}); output over 200 KB per stream is cut.

Result: stdout, then "[stderr]" and stderr if any, then "[exit N]" if the exit code isn't 0.`;

const TOOLS = [
  {
    name: "list_workspaces",
    title: "List workspaces",
    description: "List your Grim workspaces (the ones you've joined; on a server without sign-in, all of them): id, title, access (read or write), note count and URL. Pass an id to list_notes to see its notes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List workspaces", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_notes",
    title: "List a workspace's notes",
    description: "A workspace's notes: their paths and URLs (pass one to note_command).",
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string", description: "The workspace id (from list_workspaces, or the part after /app/ in a workspace link), or its URL.", minLength: 1 } },
      required: ["workspace"],
      additionalProperties: false,
    },
    annotations: { title: "List notes", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "note_command",
    title: "Run a command on a note",
    description: COMMAND_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        note: NOTE_ARG,
        command: { type: "string", description: "The shell script to run (bash syntax).", minLength: 1 },
        timeout_seconds: { type: "number", description: `Time limit in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`, minimum: 1, maximum: MAX_TIMEOUT_S, default: DEFAULT_TIMEOUT_S },
      },
      required: ["note", "command"],
      additionalProperties: false,
    },
    annotations: { title: "Run a command on a note", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

/** Tool list as sent to clients. */
export function toolList() {
  return TOOLS;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** One MCP connection: its id and the agent's name (its client's). */
interface Connection {
  id: string;
  name: string;
}

interface CallCtx {
  server: McpServer;
  caller: McpCaller;
  conn: Connection;
}

async function listWorkspaces(c: CallCtx) {
  const ctx = c.server.ctx;
  const rows = await listedRows(ctx.repos.db, c.caller.userId);
  const counts = await Promise.all(rows.map((r, i) => (i < MAX_COUNTED && r.status === "ready" ? ctx.repos.tree(r).then((f) => f.length, () => null) : Promise.resolve(null))));
  const workspaces = rows.map((r, i) => ({
    id: r.id,
    title: r.title,
    access: repoAccess(r),
    ...(counts[i] !== null ? { notes: counts[i] } : {}),
    url: `${config.publicUrl}/app/${encodeURIComponent(r.id)}`,
  }));
  const body = workspaces.length ? JSON.stringify({ workspaces }, null, 2) : "You haven't joined any workspaces yet. Open one in Grim (or pass a workspace id you were given to list_notes).";
  return { ...text(body), structuredContent: { workspaces } };
}

/** A workspace by id or URL, if it exists and is ready. */
async function workspace(raw: unknown, c: CallCtx): Promise<RepoRow | string> {
  if (typeof raw !== "string" || !raw.trim()) return "workspace is required (a workspace id: see list_workspaces)";
  let id = raw.trim();
  if (/^https?:\/\//.test(id)) id = parseAppUrl(new URL(id).pathname)?.id ?? id;
  const repo = id === DEMO_ID || isDemoRoom(id) ? null : await c.server.ctx.repos.get(id);
  if (!repo) return `No workspace "${id}" on this server. list_workspaces lists yours.`;
  if (repo.status !== "ready") return `Workspace ${repo.id} isn't ready; try again shortly.`;
  return repo;
}

async function listNotes(params: Record<string, unknown>, c: CallCtx) {
  for (const k of Object.keys(params)) if (k !== "workspace") return text(`unknown argument: ${k} (expected workspace)`, true);
  const repo = await workspace(params.workspace, c);
  if (typeof repo === "string") return text(repo, true);
  const notes = (await c.server.ctx.repos.tree(repo)).map((path) => ({ path, url: noteUrl(repo.id, path) }));
  return { ...text(notes.length ? notes.map((n) => `${n.path}  ${n.url}`).join("\n") : "(no notes yet)"), structuredContent: { workspace: repo.id, notes } };
}

/** "<ws>/<path>" or a note URL → workspace id and path. */
function parseNote(raw: string): { ws: string; path: string } | null {
  let s = raw.trim();
  if (/^https?:\/\//.test(s)) {
    try {
      const u = parseAppUrl(new URL(s).pathname);
      return u && u.rest ? { ws: u.id, path: u.rest } : null;
    } catch {
      return null;
    }
  }
  s = s.replace(/^\/+/, "").replace(/^app\//, "");
  const i = s.indexOf("/");
  return i > 0 && i < s.length - 1 ? { ws: s.slice(0, i), path: s.slice(i + 1) } : null;
}

async function noteCommand(params: Record<string, unknown>, c: CallCtx) {
  for (const k of Object.keys(params)) if (!["note", "command", "timeout_seconds"].includes(k)) return text(`unknown argument: ${k} (expected note, command, timeout_seconds)`, true);
  const n = typeof params.note === "string" ? parseNote(params.note) : null;
  if (!n) return text('note is required: a note URL or "<workspace>/<path>" (see list_notes)', true);
  if (typeof params.command !== "string" || !params.command.trim()) return text("command is required (a non-empty string)", true);
  const timeout = parseTimeout(params.timeout_seconds);
  if (typeof timeout === "string") return text(timeout, true);
  const repo = await workspace(n.ws, c);
  if (typeof repo === "string") return text(repo, true);
  const userId = c.caller.userId;
  const actor = participantForAgent({ id: `mcp:${userId}:${repo.id}`, name: c.conn.name });
  try {
    const out = await runAgentCommand(c.server.ctx, repo, n.path, { command: params.command, timeoutMs: timeout * 1000 }, actor, { userId, ip: "" }, `mcp:${userId}`);
    return text(formatResult(out));
  } catch (e) {
    if (errStatus(e) === undefined) console.error("[mcp] note_command:", e);
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

async function callTool(params: unknown, c: CallCtx) {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (p.arguments !== undefined && p.arguments !== null && (typeof p.arguments !== "object" || Array.isArray(p.arguments))) return text("arguments must be an object", true);
  const args = (p.arguments ?? {}) as Record<string, unknown>;
  if (p.name === "list_workspaces") return listWorkspaces(c);
  if (p.name === "list_notes") return listNotes(args, c);
  if (p.name === "note_command") {
    metric(c.server.ctx.repos.db, "mcp_command");
    return noteCommand(args, c);
  }
  return text(`unknown tool: ${String(p.name)}. The tools are list_workspaces, list_notes and note_command.`, true);
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
  constructor(readonly ctx: AgentCtx) {}

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
    const c: CallCtx = { server: this, caller, conn };
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

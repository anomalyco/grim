// MCP server over Streamable HTTP (JSON responses only). Written by hand: JSON-RPC 2.0 with one tool, `bash`.
import type { Participant } from "./rooms.ts";
import type { AccessFn } from "./shell/fs.ts";
import { ShellBusyError, type ShellResult, type ShellSessions } from "./shell/session.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_VERSION = "2025-06-18";
// Stays below Bun's 120 s idle timeout.
export const MAX_TIMEOUT_S = 110;
export const DEFAULT_TIMEOUT_S = 30;

const INSTRUCTIONS = `Grimoire is a shared, multiplayer Markdown notebook. You work in it through one tool, \`bash\`: a sandboxed shell whose filesystem is the live notes.

- /workspace/<repo>/... holds the notes, one directory per repo you can access (\`repos\` or \`ls /workspace\` lists them). Each repo is a Git repository; only Markdown files (.md, .markdown, .mdx) are shown and can be written. Your shell starts in /workspace.
- /tmp is private scratch space for this session (any file type, never shared or saved).
- Edits are live: people with a note open see your change immediately, as a minimal edit with a cursor labelled with your name, and can be typing at the same time. Changed files are committed to Git automatically after 15 s without edits; run \`save\` to commit right away. Prefer targeted edits (sed -i, >>) over rewriting whole files. If someone changed the same spot since you last read a file, your write fails with "changed by someone else": read it again and redo the edit.
- Grimoire commands: \`repos\` (repos and your access), \`save [path]\` (commit now), \`who <file>\` (who has it open), \`watch [path] [--timeout S]\` (wait until someone changes a file or folder), \`git log|show|diff|status\` (read-only history; \`git diff\` shows unsaved live edits).
- Shell state (cwd, variables, /tmp) persists across calls within this MCP session.
- Most standard tools work (ls, cat, grep, sed, awk, find, jq, diff, sort, ...). There is no python, node or other language runtime, no package manager, and no network access.`;

const TOOL_DESCRIPTION = `Run a bash command line in a sandboxed shell over the shared Markdown notes. This is the only way to read, search and edit notes.

Filesystem:
- /workspace/<repo>/<path>.md: the notes, one directory per repo you can access (run \`repos\` or \`ls /workspace\`). Only Markdown files (.md, .markdown, .mdx) are visible and writable. The shell starts in /workspace (also $HOME).
- /tmp: private scratch space for this session (any file type; not shared, not saved).
Writing to /workspace is live: people with the note open see the change at once (as a minimal edit with your name on the cursor), and it is committed to Git after 15 s without edits (\`save\` commits now). Read-only repos can be read but not written. cwd, variables and /tmp persist between calls.

Examples:
  ls /workspace/notes; find /workspace -name '*.md'
  grep -rn 'TODO' /workspace/notes
  cat notes/todo.md; sed -n '40,80p' notes/long.md
  sed -i 's/- \\[ \\] milk/- [x] milk/' notes/todo.md
  echo '- buy eggs' >> notes/todo.md
  cat > notes/ideas/new.md <<'EOF'
  # New idea
  Text here.
  EOF
  mv notes/draft.md notes/archive/draft.md; rm notes/old.md
  git log --oneline -n 5 notes/todo.md; git show HEAD; git diff; git status

Grimoire commands: repos; save [path]; who <file>; watch [path] [--timeout S] (blocks until someone else edits; waiting doesn't count toward the time limit, max 110 s); git log [-n N] [--oneline] [path] | show <commit> [path] | diff [<commit>] [path] | status (read-only; commits are automatic).

Constraints: no python/node/other runtimes, no network, no interactive programs or editors (use sed -i, heredocs, >>). Output over 200 KB per stream is truncated (narrow with head, grep, sed -n). Each call is stopped after timeout_seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).

Result: stdout, then "[stderr]" and stderr if any, then "[exit N]" if the exit code isn't 0.`;

const BASH_TOOL = {
  name: "bash",
  title: "Bash",
  description: TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run (bash syntax: pipes, redirects, heredocs, &&, loops).", minLength: 1 },
      timeout_seconds: {
        type: "number",
        description: `Time limit for this call in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). Time spent in \`watch\` doesn't count, but no call runs longer than ${MAX_TIMEOUT_S} s in total.`,
        minimum: 1,
        maximum: MAX_TIMEOUT_S,
        default: DEFAULT_TIMEOUT_S,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  annotations: { title: "Bash", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

/** Tool list as sent to clients. */
export function toolList() {
  return [BASH_TOOL];
}

/** Parse a timeout_seconds argument: a number in [1, MAX_TIMEOUT_S], or the default when absent. Returns an error string otherwise. */
export function parseTimeout(v: unknown): number | string {
  if (v === undefined || v === null) return DEFAULT_TIMEOUT_S;
  if (typeof v !== "number" || !Number.isFinite(v)) return "timeout_seconds must be a number";
  if (v < 1 || v > MAX_TIMEOUT_S) return `timeout_seconds must be between 1 and ${MAX_TIMEOUT_S}`;
  return v;
}

/** Compact, LLM-friendly rendering of a command result. */
export function formatResult(r: Pick<ShellResult, "stdout" | "stderr" | "exitCode">): string {
  let out = r.stdout;
  if (r.stderr) out += `${out && !out.endsWith("\n") ? "\n" : ""}[stderr]\n${r.stderr}`;
  if (r.exitCode !== 0) out += `${out && !out.endsWith("\n") ? "\n" : ""}[exit ${r.exitCode}]`;
  return out || "(no output)";
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

interface CallCtx {
  shells: ShellSessions;
  actor: Participant;
  access: AccessFn;
  shellKey: string;
  signal: AbortSignal;
}

async function callTool(params: unknown, c: CallCtx) {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (p.name !== "bash") return text(`unknown tool: ${String(p.name)}. The only tool is bash.`, true);
  if (p.arguments !== undefined && p.arguments !== null && (typeof p.arguments !== "object" || Array.isArray(p.arguments))) {
    return text("bash: arguments must be an object", true);
  }
  const args = (p.arguments ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(args)) if (k !== "command" && k !== "timeout_seconds") return text(`bash: unknown argument: ${k}`, true);
  if (typeof args.command !== "string" || !args.command.trim()) return text("bash: command is required (a non-empty string)", true);
  const timeout = parseTimeout(args.timeout_seconds);
  if (typeof timeout === "string") return text(`bash: ${timeout}`, true);
  try {
    const r = await c.shells.exec(c.actor, c.shellKey, c.access, args.command, { timeoutMs: timeout * 1000, signal: c.signal });
    return text(formatResult(r));
  } catch (e) {
    if (!(e instanceof ShellBusyError)) console.error("[mcp] bash:", e);
    return text(`bash: ${e instanceof Error ? e.message : String(e)}`, true);
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
        serverInfo: { name: "grimoire", version: "0.2.0" },
        instructions: INSTRUCTIONS,
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

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const MAX_BATCH = 32;

const hasMethod = (m: unknown, method: string) => !!m && typeof m === "object" && (m as RpcMessage).method === method;

/** A single, valid initialize request: the only thing that may create a session. */
const isInitialize = (m: unknown) => {
  if (!hasMethod(m, "initialize")) return false;
  const msg = m as RpcMessage;
  return msg.jsonrpc === "2.0" && (typeof msg.id === "string" || typeof msg.id === "number");
};

const shellKey = (sessionId: string) => `mcp:${sessionId}`;

/**
 * The /mcp endpoint. Each MCP session (Mcp-Session-Id, assigned on initialize) is a shell session, so cwd and
 * variables carry over between calls; the shell sessions own the lifetime (idle expiry, limits), so an expired or
 * evicted shell means an unknown MCP session. Clients that don't send the header share one shell per actor.
 */
export class McpServer {
  constructor(private shells: ShellSessions) {}

  async handle(req: Request, actor: Participant, access: AccessFn): Promise<Response> {
    const sid = req.headers.get("mcp-session-id");
    if (req.method === "DELETE") {
      if (!sid) return reply(rpcError(null, -32600, "Bad Request: Mcp-Session-Id header required"), 400);
      if (!this.shells.has(actor, shellKey(sid))) return reply(rpcError(null, -32001, "Session not found"), 404);
      this.shells.close(actor, shellKey(sid));
      return new Response(null, { status: 204 });
    }
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: { "content-type": "application/json", allow: "POST, DELETE" },
      });
    }
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
    if (pv && !PROTOCOL_VERSIONS.includes(pv) && !init) {
      return reply(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${pv}`), 400);
    }
    let session: string | null = null;
    if (init) {
      session = crypto.randomUUID();
      this.shells.open(actor, shellKey(session), access);
    } else if (sid) {
      if (!this.shells.touch(actor, shellKey(sid))) return reply(rpcError(null, -32001, "Session not found; initialize a new session"), 404);
      session = sid;
    }
    const headers: Record<string, string> = init && session ? { "mcp-session-id": session } : {};
    const c: CallCtx = { shells: this.shells, actor, access, shellKey: session ? shellKey(session) : "mcp", signal: req.signal };
    if (Array.isArray(body)) {
      const out: RpcResponse[] = [];
      for (const m of body) {
        const r = await handleMessage(m, c);
        if (r) out.push(r);
      }
      return out.length ? reply(out, 200, headers) : new Response(null, { status: 202, headers });
    }
    const res = await handleMessage(body, c);
    return res ? reply(res, 200, headers) : new Response(null, { status: 202, headers });
  }
}

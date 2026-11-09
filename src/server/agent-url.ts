// Agents on note URLs (docs/storage-v2.md §8): /app/<workspace>/<note> is the one address for people and agents.
// - GET /app/<workspace> from a non-browser: plain-text instructions and the workspace's notes with their URLs;
//   GET /app/<workspace>/<note>: the note's Markdown (note-url.ts).
// - POST /app/<workspace>/<note>: a shell command that sees only that note, as ./<name> (notes/shell.ts), run in the
//   workspace's runtime; what it writes lands live as the agent's own version.
// Who: without credentials, guest rules (hosted: edit existing notes only; SIGN_IN=off: everything); with
// `Authorization: Bearer <app token>`, that account (which may also create notes).
import { config, guestCreate } from "./config.ts";
import { bearerToken, participantForAgent, repoAccess, userFromAppToken } from "./auth.ts";
import { type RepoRow, type RepoService } from "./repos.ts";
import type { Db } from "./seams/db.ts";
import { errStatus } from "./errors.ts";
import { isDemoRoom } from "./demo-rooms.ts";
import { DEMO_ID } from "./demo.ts";
import { clientIp } from "./proxy.ts";
import { MCP_AUDIENCE } from "./tokens.ts";
import { metric } from "./metrics.ts";
import { DEFAULT_TIMEOUT_S, formatResult, MAX_TIMEOUT_S, parseTimeout } from "./notes/shell.ts";
import { agentLimits } from "./workspace.ts";
import { cleanPath } from "./repos.ts";
import type { Participant } from "./room.ts";

const MAX_BODY = 1024 * 1024;
const DEFAULT_NAME = "Agent";

/** What agents on note URLs need of the app. */
export interface AgentCtx {
  repos: Pick<RepoService, "db" | "tree" | "get" | "host">;
}

/** Who POSTs: an account (by its bearer token) or nobody in particular, and from where. */
export interface AgentCaller {
  userId: string | null;
  ip: string;
}

/** A label or agent name, made safe to show: no control characters, single spaces, at most `max` characters. */
export function cleanLabel(raw: unknown, max = 40): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return name || null;
}

/** /app/<workspace>[/<path>] */
const APP_URL = /^\/app\/([^/]+)(?:\/(.*))?$/;

/** The workspace id and the note path of an /app/ URL, decoded (null: malformed). */
export function parseAppUrl(pathname: string): { id: string; rest: string } | null {
  const m = APP_URL.exec(pathname);
  if (!m) return null;
  try {
    return { id: decodeURIComponent(m[1]!), rest: (m[2] ?? "").split("/").filter((s) => s && s !== "." && s !== "..").map(decodeURIComponent).join("/") };
  } catch {
    return null;
  }
}

/** The caller of a POST: an account by its bearer token (hosted only), else anonymous. A bad token is a 401. */
export async function agentCaller(db: Db, req: Request): Promise<AgentCaller | Response> {
  const ip = clientIp(req);
  const token = config.signIn ? bearerToken(req) : null;
  if (!token) return { userId: null, ip };
  const user = await userFromAppToken(db, token, MCP_AUDIENCE);
  if (!user) return failure(req, new URL(req.url), true)(401, "invalid or expired token: sign in again, or send no Authorization header for guest access");
  return { userId: user.id, ip };
}

// ---- responses ----

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", vary: "Accept" };

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...HEADERS, ...headers } });

const jsonRes = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...HEADERS, ...headers } });

function wantsText(req: Request, url: URL) {
  const accept = req.headers.get("accept") ?? "";
  return url.searchParams.get("format") === "text" || (accept.includes("text/plain") && !accept.includes("application/json"));
}

function failure(req: Request, url: URL, post: boolean) {
  const asText = !post || wantsText(req, url);
  return (status: number, error: string, headers: Record<string, string> = {}) => (asText ? text(`${error}\n`, status, headers) : jsonRes({ error }, status, headers));
}

/** /a/<uuid>: the agent links that were. */
export function goneAgentLink(): Response {
  return text(`Agent links were replaced: GET the workspace URL ${config.publicUrl}/app/<workspace-id> for instructions.\n`, 410);
}

function refusal(id: string, repo: RepoRow | null, fail: (status: number, error: string, headers?: Record<string, string>) => Response): Response | null {
  if (id === DEMO_ID || isDemoRoom(id)) {
    return config.signIn ? fail(404, "The demo is for people in the browser: each visitor gets a room of their own, and agents can't join it. Open this URL in a browser.") : fail(404, `Not found: ${id}`);
  }
  if (!repo) return fail(404, `Not found: ${id}`);
  if (repo.status !== "ready") return fail(409, "This workspace isn't ready; try again shortly.", { "retry-after": "10" });
  return null;
}

/** The URL of a note. */
export const noteUrl = (ws: string, path: string) => `${config.publicUrl}/app/${encodeURIComponent(ws)}/${path.split("/").map(encodeURIComponent).join("/")}`;

// ---- GET ----

/** GET/HEAD of a workspace URL from a non-browser: the instructions. null for notes and folders (note-url.ts). */
export async function handleAgentGet(req: Request, url: URL, ctx: AgentCtx): Promise<Response | null> {
  const u = parseAppUrl(url.pathname);
  if (!u || u.rest) return null;
  const fail = failure(req, url, false);
  const repo = u.id === DEMO_ID || isDemoRoom(u.id) || u.id === "." || u.id === ".." ? null : await ctx.repos.get(u.id);
  const refused = refusal(u.id, repo, fail);
  if (refused) return refused;
  const accept = req.headers.get("accept") ?? "";
  const markdown = accept.includes("text/markdown") && !accept.includes("text/plain");
  const body = await instructionsFor(ctx, repo!);
  return text(req.method === "HEAD" ? "" : body, 200, markdown ? { "content-type": "text/markdown; charset=utf-8" } : {});
}

// ---- POST ----

class BadRequest extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: Request): Promise<string> {
  const tooBig = () => new BadRequest(413, `request body too large (max ${MAX_BODY / 1024 / 1024} MB)`);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw tooBig();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(value);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new BadRequest(400, "the body must be UTF-8 text");
  }
}

/** The body as {command, timeout_seconds?}: JSON when declared (or a JSON object with a string "command"), else the command itself. */
export function commandFields(body: string, contentType: string): { command: string; timeoutMs: number } {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  let fields: Record<string, unknown> = { command: body };
  if (type === "application/json" || ((type === "" || type === "application/x-www-form-urlencoded") && /^\s*\{/.test(body))) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      if (type === "application/json") throw new BadRequest(400, "invalid JSON body");
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (type === "application/json" || typeof (parsed as { command?: unknown }).command === "string")) fields = parsed as Record<string, unknown>;
    else if (type === "application/json") throw new BadRequest(400, 'expected a JSON object: {"command": "...", "timeout_seconds"?: N}');
  }
  for (const k of Object.keys(fields)) if (!["command", "timeout_seconds", "session"].includes(k)) throw new BadRequest(400, `unknown field: ${k} (expected command, timeout_seconds)`);
  if (typeof fields.command !== "string" || !fields.command.trim()) throw new BadRequest(400, "the command is empty");
  const t = parseTimeout(fields.timeout_seconds);
  if (typeof t === "string") throw new BadRequest(400, t);
  return { command: fields.command, timeoutMs: t * 1000 };
}

/** Whether `caller` may create notes in `repo` (an account, a workspace open to guests, or a server without sign-in). */
const mayCreate = (caller: AgentCaller, repo: RepoRow) => !config.signIn || !!caller.userId || guestCreate(repo.id);

/**
 * Run an agent's command on one note (the HTTP note shell and MCP): checks, then the workspace's runtime. Returns
 * the result or throws (errors with a status).
 */
export async function runAgentCommand(ctx: AgentCtx, repo: RepoRow, notePath: string, cmd: { command: string; timeoutMs: number }, actor: Participant, caller: AgentCaller, limitKey: string) {
  const p = cleanPath(notePath);
  if (!p) throw new BadRequest(400, `invalid note path: ${notePath}`);
  if (repoAccess(repo) === "none") throw new BadRequest(404, `Not found: ${repo.id}`);
  return ctx.repos.host.get(repo.id).noteCommand(repo, p, { command: cmd.command, timeoutMs: cmd.timeoutMs, create: mayCreate(caller, repo), limitKey }, actor);
}

/** POST /app/<workspace>/<note>: run a command on that note. */
export async function handleAgentPost(req: Request, url: URL, ctx: AgentCtx, caller: AgentCaller): Promise<Response> {
  const fail = failure(req, url, true);
  const u = parseAppUrl(url.pathname);
  if (!u) return fail(400, "Bad request: malformed URL");
  const repo = u.id === DEMO_ID || isDemoRoom(u.id) || u.id === "." || u.id === ".." ? null : await ctx.repos.get(u.id);
  const refused = refusal(u.id, repo, fail);
  if (refused) return refused;
  if (!u.rest) return fail(405, `POST commands to a note's URL (${noteUrl(u.id, "<note>.md")}); GET this URL for the list of notes and instructions.`, { allow: "GET, HEAD" });
  try {
    const cmd = commandFields(await readBody(req), req.headers.get("content-type") ?? "");
    metric(ctx.repos.db, "agent_command", req);
    const name = cleanLabel(req.headers.get("x-agent-name")) ?? DEFAULT_NAME;
    const actor = participantForAgent({ id: `agent:${caller.userId ?? "guest"}:${repo!.id}:${name.toLowerCase()}`, name });
    const key = caller.userId ? `user:${caller.userId}` : `ip:${caller.ip}`;
    const out = await runAgentCommand(ctx, repo!, u.rest, cmd, actor, caller, key);
    if (wantsText(req, url)) return text(formatResult(out).replace(/\n?$/, "\n"), 200, { "x-exit-code": String(out.exitCode) });
    return jsonRes({ stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, truncated: out.truncated });
  } catch (e) {
    if (e instanceof BadRequest) return fail(e.status, e.message);
    const status = errStatus(e);
    if (status !== undefined && e instanceof Error) return fail(status, e.message, status === 429 ? { "retry-after": "10" } : {});
    console.error("[agent] exec:", e);
    return fail(500, "internal error");
  }
}

// ---- the instructions ----

const MAX_LISTED = 500;

async function instructionsFor(ctx: AgentCtx, repo: RepoRow): Promise<string> {
  const files = await ctx.repos.tree(repo).catch(() => [] as string[]);
  const writable = repoAccess(repo) === "write";
  const editOnly = writable && config.signIn && !guestCreate(repo.id);
  const sample = files.find((f) => /^[\w. -]+$/.test(f)) ?? files[0] ?? "note.md";
  const sampleUrl = noteUrl(repo.id, sample);
  const listing = files.length
    ? [...files.slice(0, MAX_LISTED).map((f) => `- ${f}  ${noteUrl(repo.id, f)}`), ...(files.length > MAX_LISTED ? [`… and ${files.length - MAX_LISTED} more`] : [])].join("\n")
    : "(empty: no notes yet)";
  const access = !writable
    ? "Access: read-only."
    : editOnly
      ? "Access without credentials: read and EDIT existing notes, but not create new ones. For that, send `Authorization: Bearer <token>` (a Grim app token, the kind Grim for Mac or an MCP client signs in for), or use MCP: " + `${config.publicUrl}/mcp.`
      : "Access: read, edit and create notes.";
  return `# Grim workspace: ${repo.title}

Grim is a multiplayer Markdown notebook: people edit notes live in the browser. You, an AI agent, work on **one note at a time** over plain HTTP (curl): GET a note's URL to read it, POST a shell command to a note's URL to run it with that note as the only file. There is nothing to install.
${access}

## Run a command on a note
POST the command to the note's URL. The shell's working directory holds just that note, as ./<its file name>; nothing else exists (no other notes, no workspace tree, no network). Standard tools work: cat, sed, grep, awk, head, tail, wc, diff, jq, sort...

\`\`\`bash
curl -s -X POST -H 'X-Agent-Name: <your name>' --data-binary 'cat ${sample.split("/").pop()}' '${sampleUrl}?format=text'
curl -s -X POST --data-binary "sed -i 's/- \\[ \\] milk/- [x] milk/' ${sample.split("/").pop()}" '${sampleUrl}?format=text'
curl -s -X POST -H 'content-type: application/json' -d '{"command": "grep -n TODO *.md", "timeout_seconds": 60}' '${sampleUrl}'
\`\`\`

- X-Agent-Name labels your cursor and versions (default "${DEFAULT_NAME}"); send it on every call.
- Multi-line scripts (pipes, loops, heredocs) work as one body: send them with --data-binary @- and a quoted heredoc:

\`\`\`bash
curl -s -X POST --data-binary @- '${sampleUrl}?format=text' <<'CMD'
cat >> ${sample.split("/").pop()} <<'EOF'
- a new line, with $dollars and \`backticks\` kept as is
EOF
CMD
\`\`\`
${editOnly ? "" : `
To create a note, POST to the URL it should have, with a command that writes it (\`cat > name.md <<'EOF' ... EOF\`). Folders are just path prefixes.
`}
## Live edits and versions
${LIVE_EDITS}

## History
\`history\` lists the note's versions (newest first: id, date, kind, author); \`history show <id>\` prints one; \`history diff <id>\` shows what it changed. \`who\` lists who has the note open.

## The response
- JSON by default: {"stdout": "...", "stderr": "...", "exitCode": 0, "truncated": false}
- With ?format=text (or Accept: text/plain): stdout, then "[stderr]" and stderr, then "[exit N]" if it failed (also in X-Exit-Code).
- Errors come back with a 4xx status and {"error": "..."}.

## Just read
GET a note's URL for its Markdown (live). GET this URL for this list again.

## Limits
${shellLimits()}

## Notes in this workspace (${files.length})
${listing}
`;
}

// ---- shared with MCP (mcp.ts) ----

export const LIVE_EDITS = `What a command writes to the note lands live: people with it open see the change at once, with your cursor, and it becomes a version of its own (yours). Prefer targeted edits (\`sed -i\`, \`>>\`) over rewriting the whole file. If someone changed the same spot while your command ran, the write is refused ("changed by someone else"): read it again and redo the edit. Other files your command makes are discarded, and the note can't be deleted or renamed from the shell.`;

export function shellLimits(): string {
  return `- Each call stops after ${DEFAULT_TIMEOUT_S} s by default (timeout_seconds up to ${MAX_TIMEOUT_S}); a command that times out writes nothing. Output over 200 KB per stream is cut ("truncated": true). Request bodies up to 1 MB.
- At most ${agentLimits.perMinute} calls per minute and ${agentLimits.concurrent} commands at a time per caller and workspace.
- No python, node or other runtimes, no network, no editors.`;
}

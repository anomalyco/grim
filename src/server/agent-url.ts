// Agents on the workspace URL: /app/<workspace> is the one address for people and agents.
// - GET from a non-browser (note-url.ts negotiates): the root answers plain-text instructions plus the file listing,
//   /app/<id>/changes what people changed (JSON); notes and folders answer Markdown as before (note-url.ts).
// - POST /app/<id>: runs a command in the sandboxed shell over that workspace.
// Who: without credentials, guest rules (hosted: edit existing notes only; SIGN_IN=off: everything); with
// `Authorization: Bearer <app token>` (an app's or an MCP client's), what that account may do.
import { config, guestCreate } from "./config.ts";
import { bearerToken, participantForAgent, repoAccess, userFromAppToken, type Access } from "./auth.ts";
import { getRepo, type RepoRow, type RepoService } from "./repos.ts";
import type { Db } from "./seams/db.ts";
import { WORKSPACE, type AccessFn, type ShellCtx } from "./shell/fs.ts";
import { formatResult, parseShellRequest, type ShellSessions } from "./shell/session.ts";
import { errStatus, isErr } from "./errors.ts";
import { isDemoRoom } from "./demo-rooms.ts";
import { DEMO_ID } from "./demo.ts";
import { clientIp } from "./proxy.ts";
import { MCP_AUDIENCE } from "./tokens.ts";
import { workspaceAccess } from "./workspaces.ts";
import { metric } from "./metrics.ts";

const MAX_BODY = 1024 * 1024;
const DEFAULT_NAME = "Agent";
const WINDOW_MS = 60_000;

/** Per caller and workspace (and MCP caller and workspace): calls per minute, and commands running or queued at once. Tests lower them. */
export const agentLimits = { perMinute: 120, concurrent: 4 };

/** What agents on the workspace URL need of the app: the shell's, plus the global tables and the workspace's listing. */
export interface AgentCtx extends ShellCtx {
  repos: ShellCtx["repos"] & Pick<RepoService, "db" | "tree">;
}

/** Who POSTs to a workspace URL: an account (by its bearer token) or nobody in particular, and from where. */
export interface AgentCaller {
  userId: string | null;
  ip: string;
}

/** What guests are told to do for more than editing. */
export const TOKEN_HINT = "send Authorization: Bearer <token> or use MCP";

/** A label or agent name, made safe to show: no control characters, single spaces, at most `max` characters. */
export function cleanLabel(raw: unknown, max = 40): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return name || null;
}

/** /app/<workspace>[/<path>] */
const APP_URL = /^\/app\/([^/]+)(?:\/(.*))?$/;

/** The workspace id and the rest of an /app/ path, decoded (null: malformed). */
function parseAppUrl(pathname: string): { id: string; rest: string } | null {
  const m = APP_URL.exec(pathname);
  if (!m) return null;
  try {
    return { id: decodeURIComponent(m[1]!), rest: (m[2] ?? "").replace(/^\/+|\/+$/g, "") };
  } catch {
    return null;
  }
}

/** The workspace a POST to an /app/ URL is for (Workers route it to a shell by it), or null when it isn't one. */
export function agentWorkspace(pathname: string): string | null {
  const u = parseAppUrl(pathname);
  return u && !u.rest ? u.id : null;
}

/**
 * The caller of a POST: an account by its bearer token (hosted only; app tokens and MCP tokens both count), else
 * anonymous. A token that doesn't work is refused (401) rather than quietly treated as no token.
 */
export async function agentCaller(db: Db, req: Request): Promise<AgentCaller | Response> {
  const ip = clientIp(req);
  const token = config.signIn ? bearerToken(req) : null;
  if (!token) return { userId: null, ip };
  const user = await userFromAppToken(db, token, MCP_AUDIENCE);
  if (!user) return failure(req, new URL(req.url), true)(401, "invalid or expired token: sign in again, or send no Authorization header for guest access");
  return { userId: user.id, ip };
}

// ---- rate limits ----

/** Fixed one-minute windows per key (a caller and workspace here; an MCP caller and workspace: mcp.ts). */
const calls = new Map<string, { start: number; n: number }>();

/** Seconds until `key` may be called again, or 0 if this call is allowed. */
export function rateLimited(key: string): number {
  const now = Date.now();
  if (calls.size > 10_000) for (const [k, v] of calls) if (now - v.start >= WINDOW_MS) calls.delete(k);
  const c = calls.get(key);
  if (!c || now - c.start >= WINDOW_MS) {
    calls.set(key, { start: now, n: 1 });
    return 0;
  }
  return ++c.n > agentLimits.perMinute ? Math.max(1, Math.ceil((c.start + WINDOW_MS - now) / 1000)) : 0;
}

/** Commands running or queued per limit key. */
const running = new Map<string, number>();

/** The key the limits count under: an account and workspace, or an IP address and workspace. */
const limitKey = (c: AgentCaller, workspace: string) => (c.userId ? `agent:user:${c.userId}:${workspace}` : `agent:ip:${c.ip}:${workspace}`);

// ---- responses ----

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", vary: "Accept" };

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...HEADERS, ...headers } });

const jsonRes = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...HEADERS, ...headers } });

/** Whether a POST asked for a plain-text answer. */
function wantsText(req: Request, url: URL) {
  const accept = req.headers.get("accept") ?? "";
  return url.searchParams.get("format") === "text" || (accept.includes("text/plain") && !accept.includes("application/json"));
}

/** POST errors are JSON {error} unless text was asked for; `asText` forces text. */
function failure(req: Request, url: URL, post: boolean) {
  const asText = !post || wantsText(req, url);
  return (status: number, error: string, headers: Record<string, string> = {}) => (asText ? text(`${error}\n`, status, headers) : jsonRes({ error }, status, headers));
}

/** /a/<uuid>: the agent links that were. */
export function goneAgentLink(): Response {
  return text(`Agent links were replaced: use the workspace URL ${config.publicUrl}/app/<workspace-id> instead (GET it for instructions).\n`, 410);
}

/** Why a workspace can't take agents (demo, unknown, not ready), or null when it can. */
function refusal(id: string, repo: RepoRow | null, fail: (status: number, error: string, headers?: Record<string, string>) => Response): Response | null {
  // Demo rooms belong to the people in them (POST /api/demo/room, from the browser).
  if (id === DEMO_ID || isDemoRoom(id)) {
    return config.signIn ? fail(404, "The demo is for people in the browser: each visitor gets a room of their own, and agents can't join it. Open this URL in a browser.") : fail(404, `Not found: ${id}`);
  }
  if (!repo) return fail(404, `Not found: ${id}`);
  if (repo.status !== "ready") return fail(409, `This workspace isn't ready (${repo.status === "importing" ? "still importing" : (repo.error ?? repo.status)}); try again shortly.`, { "retry-after": "10" });
  return null;
}

// ---- GET ----

/**
 * GET/HEAD of a workspace URL from a non-browser: the workspace root's instructions, or /changes. null for anything
 * else (notes and folders: note-url.ts).
 */
export async function handleAgentGet(req: Request, url: URL, ctx: AgentCtx): Promise<Response | null> {
  const u = parseAppUrl(url.pathname);
  if (!u || (u.rest && u.rest !== "changes")) return null;
  const fail = failure(req, url, false);
  const repo = u.id === DEMO_ID || isDemoRoom(u.id) || u.id === "." || u.id === ".." ? null : await ctx.repos.get(u.id);
  const refused = refusal(u.id, repo, fail);
  if (refused) return refused;
  if (u.rest === "changes") {
    const wait = rateLimited(limitKey({ userId: null, ip: clientIp(req) }, repo!.id));
    if (wait) return fail(429, `Too many calls: at most ${agentLimits.perMinute} per minute. Retry in ${wait} s.`, { "retry-after": String(wait) });
    try {
      return jsonRes(await ctx.repos.host.get(repo!.id).changes(repo!, url.searchParams.get("path") ?? ""));
    } catch (e) {
      const status = errStatus(e);
      if (status !== undefined && e instanceof Error) return fail(status, e.message);
      console.error("[agent] changes:", e);
      return fail(500, "internal error");
    }
  }
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

/** The request body as text, read up to MAX_BODY bytes (larger bodies are refused without buffering them). */
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

/**
 * The body as shell request fields: JSON when declared, or (with no content type, or curl -d's form type) a JSON
 * object with a string "command"; otherwise the body is the command itself.
 */
function requestFields(body: string, contentType: string): Record<string, unknown> {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new BadRequest(400, "invalid JSON body");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest(400, 'expected a JSON object: {"command": "...", "session"?: "...", "timeout_seconds"?: N}');
    return parsed as Record<string, unknown>;
  }
  if ((type === "" || type === "application/x-www-form-urlencoded") && /^\s*\{/.test(body)) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { command?: unknown }).command === "string") return parsed as Record<string, unknown>;
    } catch {
      // Not JSON: a shell command that starts with "{".
    }
  }
  return { command: body };
}

/** What the caller may do in the workspace, asked again (with its row as the shell just read it) on every call. */
function callerAccess(db: Db, caller: AgentCaller, repoId: string): AccessFn {
  if (caller.userId) return workspaceAccess(db, caller.userId, repoId);
  const access = async (r: RepoRow): Promise<Access> => (r.id === repoId && r.status === "ready" ? repoAccess(r) : "none");
  const listed = async () => {
    const row = await getRepo(db, repoId);
    return row ? [row] : [];
  };
  // hosted guests edit existing notes; the rest needs an account (as in the browser), except in workspaces open to guests
  return Object.assign(access, { listed }, config.signIn && !guestCreate(repoId) ? { editOnly: TOKEN_HINT } : {});
}

/** POST /app/<id>: run a command. `caller`: from agentCaller (on Workers, the Worker resolved it). */
export async function handleAgentPost(req: Request, url: URL, ctx: AgentCtx, shells: ShellSessions, caller: AgentCaller): Promise<Response> {
  const fail = failure(req, url, true);
  const u = parseAppUrl(url.pathname);
  if (!u) return fail(400, "Bad request: malformed URL");
  if (u.rest) return fail(405, `POST commands to the workspace URL itself: ${config.publicUrl}/app/${encodeURIComponent(u.id)}`, { allow: "GET, HEAD" });
  const repo = u.id === DEMO_ID || isDemoRoom(u.id) || u.id === "." || u.id === ".." ? null : await ctx.repos.get(u.id);
  const refused = refusal(u.id, repo, fail);
  if (refused) return refused;
  const r0 = repo!;
  const access = callerAccess(ctx.repos.db, caller, r0.id);
  if ((await access(r0)) === "none") return fail(404, `Not found: ${u.id}`);
  const key = limitKey(caller, r0.id);
  const wait = rateLimited(key);
  if (wait) return fail(429, `Too many calls: at most ${agentLimits.perMinute} per minute. Retry in ${wait} s.`, { "retry-after": String(wait) });
  try {
    const fields = requestFields(await readBody(req), req.headers.get("content-type") ?? "");
    const r = parseShellRequest(fields, req.headers.get("x-shell-session"));
    if (typeof r === "string") throw new BadRequest(400, r);
    metric(ctx.repos.db, "agent_command", req);
    if ((running.get(key) ?? 0) >= agentLimits.concurrent) throw new BadRequest(429, `${agentLimits.concurrent} commands are already running or queued; wait for them to finish`);
    const name = cleanLabel(req.headers.get("x-agent-name")) ?? DEFAULT_NAME;
    // One agent per name and workspace (and account): its cursor, presence and commits.
    const actor = participantForAgent({ id: `agent:${caller.userId ?? "guest"}:${r0.id}:${name.toLowerCase()}`, name });
    // Anonymous callers' sessions (cwd, variables, /tmp) are kept apart by address.
    const session = `http:${caller.userId ? "" : `${caller.ip}:`}${r.session ?? ""}`;
    running.set(key, (running.get(key) ?? 0) + 1);
    let out;
    try {
      out = await shells.exec(actor, session, access, r.command, { timeoutMs: r.timeoutMs, signal: req.signal, cwd: `${WORKSPACE}/${r0.id}` });
    } finally {
      const n = (running.get(key) ?? 1) - 1;
      if (n > 0) running.set(key, n);
      else running.delete(key);
    }
    if (wantsText(req, url)) return text(formatResult(out).replace(/\n?$/, "\n"), 200, { "x-exit-code": String(out.exitCode), "x-cwd": encodeURI(out.cwd) });
    return jsonRes({ stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, cwd: out.cwd, truncated: !!out.truncated });
  } catch (e) {
    if (e instanceof BadRequest) return fail(e.status, e.message);
    if (isErr(e, "ShellBusyError")) return fail(429, e.message);
    console.error("[agent] exec:", e);
    return fail(500, "internal error");
  }
}

// ---- the instructions ----

const MAX_LISTED = 500;

async function instructionsFor(ctx: AgentCtx, repo: RepoRow): Promise<string> {
  const url = `${config.publicUrl}/app/${encodeURIComponent(repo.id)}`;
  const root = `${WORKSPACE}/${repo.id}`;
  const files = await ctx.repos.tree(repo).catch(() => [] as string[]);
  const writable = repoAccess(repo) === "write";
  const editOnly = writable && config.signIn && !guestCreate(repo.id);
  const sample = files.find((f) => /^[\w.-]+$/.test(f)) ?? files.find((f) => /^[\w./-]+$/.test(f)) ?? "note.md";
  const samplePath = sample.split("/").map(encodeURIComponent).join("/");
  const listing = files.length
    ? [...files.slice(0, MAX_LISTED), ...(files.length > MAX_LISTED ? [`… and ${files.length - MAX_LISTED} more (run ls -R)`] : [])].join("\n")
    : "(empty: no notes yet)";
  const access = !writable
    ? "Access: read-only (this workspace is a read-only copy: you can read and search; writes fail)."
    : editOnly
      ? `Access without credentials: you can read, search and EDIT existing notes, but not create, rename, move or delete notes or make folders (those fail with "needs a token"). For full access, send \`Authorization: Bearer <token>\` (a Grim app token: the kind Grim for Mac or an MCP client signs in for) on every call, or connect over MCP: ${config.publicUrl}/mcp.`
      : "Access: read and write.";
  const auth = editOnly ? `\n- Authorization: Bearer <token> (optional) acts as that account: full access.` : "";
  const writing = writable
    ? `
## Writing files
${LIVE_EDITS}

${
  editOnly
    ? `Without a token, change existing notes in place (\`sed -i\`, \`>>\`, or \`cat > existing.md\`). `
    : ""
}To write a whole file, send a script whose \`cat > file\` reads a quoted heredoc, and wrap the script in a quoted heredoc of your own so your local shell leaves $, quotes and backticks alone${editOnly ? "" : " (folders are created as needed)"}:

\`\`\`bash
curl -s -X POST --data-binary @- '${url}?format=text' <<'CMD'
cat > ${editOnly ? sample : "ideas/new-note.md"} <<'EOF'
# New note
Text with $dollars, 'quotes' and \`backticks\`, kept as is.
EOF
CMD
\`\`\`

To upload a local file, build the same script around it (pick a delimiter that isn't a line of the file; awk 1 adds a missing final newline):

\`\`\`bash
{ printf "cat > ${editOnly ? sample : "notes/plan.md"} <<'GRIM_EOF'\\n"; awk 1 plan.md; printf 'GRIM_EOF\\n'; } | curl -s -X POST --data-binary @- '${url}?format=text'
\`\`\`
`
    : "";
  return `# Grim workspace: ${repo.title}

Grim is a multiplayer Markdown notebook: people edit notes live in the browser, and every note is a Markdown file in a Git repo. This URL is the workspace "${repo.title}": people open it in a browser, and you, an AI agent, use it with plain HTTP (curl): GET to read, POST to run commands in a sandboxed bash shell over the workspace. There is nothing to install.
${access}

The workspace is a folder of Markdown files at ${root}, where your shell starts. ${files.length} note${files.length === 1 ? "" : "s"}, listed at the end.

## Run a command
POST the command to this exact URL as the request body:

\`\`\`bash
curl -s -X POST --data-binary 'ls -R' '${url}?format=text'
curl -s -X POST -H 'X-Agent-Name: <your name>' --data-binary 'cat ${sample}' '${url}?format=text'
curl -s -X POST -H 'content-type: application/json' -d '{"command": "grep -rn TODO .", "session": "work", "timeout_seconds": 60}' '${url}'
\`\`\`

- X-Agent-Name labels your cursor and commits (default "${DEFAULT_NAME}"); send it on every call.${auth}
- JSON bodies take {"command": "...", "session"?: "...", "timeout_seconds"?: N}. Multi-line scripts (pipes, loops, heredocs) work as one body: send them with --data-binary @- and a quoted heredoc, as below.

## The response
- JSON by default: {"stdout": "...", "stderr": "...", "exitCode": 0, "cwd": "${root}", "truncated": false}
- With ?format=text (or Accept: text/plain): stdout, then "[stderr]" and stderr, then "[exit N]" if it failed. The X-Exit-Code and X-Cwd headers carry the rest.
- Errors (bad request, rate limit) come back with a 4xx status and {"error": "..."} (plain text with ?format=text).

## Sessions
A session keeps the cwd, variables and /tmp between calls: \`cd ideas\` in one call and the next call starts in ideas/. Calls without a session share one default session. For a separate one, send "session": "<name>" in JSON or the header X-Shell-Session: <name> (1-128 characters of A-Z a-z 0-9 . _ : -).

## Just read a note
GET a note's URL for its Markdown (live, unsaved edits included); a folder's URL lists its notes, one per line:

\`\`\`bash
curl -s '${url}/${samplePath}'
\`\`\`

## See what people changed
People keep editing while you're away. \`changes\` shows what they wrote by hand since the last agent commit (any agent's), edits not saved yet included: the changed notes with +/- counts, then unified diffs. Run it when you come back, before you start.

\`\`\`bash
curl -s -X POST --data-binary 'changes' '${url}?format=text'          # everything
curl -s -X POST --data-binary 'changes --stat' '${url}?format=text'   # just the list
curl -s -X POST --data-binary 'changes ${sample}' '${url}?format=text'
curl -s '${url}/changes'                                         # JSON: {"since": {"commit", "agent", "at"} | null, "files": [{"path", "status", "from"?, "added", "removed", "diff"}], "truncated"}
curl -s '${url}/changes?path=${sample}'
\`\`\`
(A note named changes.md is at ${url}/changes.md.)
${writing}
## Useful commands
${usefulCommands(sample)}

## Limits
${shellLimits(writable, "Request bodies up to 1 MB. ", `per ${editOnly ? "address" : "caller"} and workspace`)}

## Notes in this workspace
${listing}
`;
}

// ---- what the workspace URL's instructions and the MCP server's (mcp.ts) say alike ----

/** How writes behave. */
export const LIVE_EDITS = `Edits are live: people with the note open see them at once, with your cursor. The files a command wrote are committed to Git right after it, on a commit of your own (people's edits get commits of their own, so \`changes\` can tell them apart). Prefer targeted edits (\`sed -i\`, \`>>\`) over rewriting whole files. If someone changed the same spot since you read a file, the write fails with "changed by someone else": read it again and redo the edit.`;

/** A block of commands worth knowing, with `sample` as the example note. */
export function usefulCommands(sample: string): string {
  return `\`\`\`bash
ls -R; cat ${sample}; sed -n '40,80p' long.md
grep -rn 'TODO' .; find . -name '*.md' | head -50
git log --oneline -n 10; git diff; git status  # history (read-only; commits are automatic)
who ${sample}  # who has it open
watch ${sample} --timeout 60  # wait until someone edits it
changes  # what people wrote by hand since the last agent commit (--stat: the list only)
repos  # the workspace's name and access
\`\`\``;
}

/** The shell's limits as a list; `extra` goes before the rate limits, which apply `per` (a caller and workspace, a workspace). */
export function shellLimits(writable: boolean | null, extra: string, per: string): string {
  return `- Only Markdown files (.md, .markdown, .mdx) exist in a workspace${writable === null ? " (read-only workspaces can't be written)" : writable ? " and can be written" : ""}; /tmp is private scratch space for any file.
- Standard tools work (ls cat grep sed awk find jq diff sort head wc ...). There is no python, node or other runtime, no network access, no editors.
- Each call stops after 30 s by default (timeout_seconds up to 110). Output over 200 KB per stream is cut ("truncated": true; narrow it with head, grep, sed -n). ${extra}At most ${agentLimits.perMinute} calls per minute and ${agentLimits.concurrent} commands at a time ${per}.`;
}

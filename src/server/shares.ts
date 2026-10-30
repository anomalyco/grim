// "Share with agent" links: /a/<uuid> is a capability URL that gives whoever holds it a shell over one folder (one
// link per person per folder). GET returns instructions for an AI agent; POST runs a command. No cookies, no other auth.
import { config } from "./config.ts";
import { participantForAgent, repoAccess, type Access } from "./auth.ts";
import { getRepo, type RepoRow, type RepoService } from "./repos.ts";
import type { Db } from "./seams/db.ts";
import { WORKSPACE, type AccessFn, type ShellCtx } from "./shell/fs.ts";
import { formatResult, parseShellRequest, type ShellSessions } from "./shell/session.ts";
import { errStatus, isErr } from "./errors.ts";
import { isDemoRoom } from "./demo-rooms.ts";

export interface ShareRow {
  id: string;
  repo_id: string;
  label: string | null;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BODY = 1024 * 1024;
const DEFAULT_NAME = "Agent";
const WINDOW_MS = 60_000;
/** How often a link's last_used_at is written at most (the global database has a single primary on Workers). */
export const LAST_USED_EVERY_MS = 5 * 60_000;

/** Per link: calls per minute (GET and POST), and commands running or queued at once. Tests lower them. */
export const shareLimits = { perMinute: 120, concurrent: 4 };

export const shareUrl = (id: string) => `${config.publicUrl}/a/${id}`;

/** The shell actor id of a link: one identity per link, whatever name the agent gives. */
export const shareActorId = (id: string) => `share:${id}`;

/** A label or agent name, made safe to show: no control characters, single spaces, at most `max` characters. */
export function cleanLabel(raw: unknown, max = 40): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return name || null;
}

/** `userId`'s active link for a folder, made on first use. */
export async function myShare(db: Db, repoId: string, userId: string, label: string | null): Promise<{ share: ShareRow; created: boolean }> {
  const find = () => db.get<ShareRow>("SELECT * FROM share_links WHERE repo_id = ? AND created_by = ? AND revoked_at IS NULL ORDER BY created_at LIMIT 1", repoId, userId);
  const mine = await find();
  if (mine) return { share: mine, created: false };
  const share: ShareRow = { id: crypto.randomUUID(), repo_id: repoId, label, created_by: userId, created_at: Date.now(), last_used_at: null, revoked_at: null };
  // Inserted only if there's still none, so concurrent first uses make one link.
  const { changes } = await db.run(
    "INSERT INTO share_links (id, repo_id, label, created_by, created_at) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM share_links WHERE repo_id = ? AND created_by = ? AND revoked_at IS NULL)",
    share.id,
    repoId,
    label,
    userId,
    share.created_at,
    repoId,
    userId,
  );
  if (changes) return { share, created: true };
  return { share: (await find())!, created: false };
}

/** The statement getShare reads an active link with (a ShellDO answers it from a short cache). */
export const GET_SHARE_SQL = "SELECT * FROM share_links WHERE id = ? AND revoked_at IS NULL";

/** An active link by id (null if unknown, malformed or revoked). */
export async function getShare(db: Db, id: string): Promise<ShareRow | null> {
  if (!UUID.test(id)) return null;
  return db.get<ShareRow>(GET_SHARE_SQL, id);
}

const closedListeners = new Set<(id: string) => void>();

/** Called with a link's id when it stops working (revoked, or its notebook is going away), to end its shells. */
export function onShareClosed(fn: (id: string) => void): () => void {
  closedListeners.add(fn);
  return () => closedListeners.delete(fn);
}

function closed(id: string) {
  calls.delete(id);
  for (const fn of closedListeners) fn(id);
}

export async function revokeShare(db: Db, id: string) {
  await db.run("UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", Date.now(), id);
  closed(id);
}

/** Before a notebook is removed (its links are deleted with it): stop everything running through its links. */
export async function closeRepoShares(db: Db, repoId: string) {
  for (const s of await db.all<{ id: string }>("SELECT id FROM share_links WHERE repo_id = ? AND revoked_at IS NULL", repoId)) closed(s.id);
}

/** Before an account is deleted: stop everything running through its links (in any workspace), then delete them. */
export async function deleteUserShares(db: Db, userId: string) {
  for (const s of await db.all<{ id: string }>("SELECT id FROM share_links WHERE created_by = ? AND revoked_at IS NULL", userId)) closed(s.id);
  await db.run("DELETE FROM share_links WHERE created_by = ?", userId);
}

/** What a link may do right now: what anyone may do in its folder (links of deleted accounts are gone). */
function linkAccess(share: ShareRow, repo: RepoRow): Access {
  return share.repo_id === repo.id && repo.status === "ready" && share.created_by ? repoAccess(repo) : "none";
}

/** The shell's view: only the link's folder, checked again (the link, and the folder's row the shell just read) on every call. */
function shellAccess(db: Db, shareId: string, repoId: string): AccessFn {
  const access = async (r: RepoRow): Promise<Access> => {
    if (r.id !== repoId) return "none";
    const share = await getShare(db, shareId);
    return share ? linkAccess(share, r) : "none";
  };
  const listed = async () => {
    const row = await getRepo(db, repoId);
    return row ? [row] : [];
  };
  return Object.assign(access, { listed });
}

/** Record a link's use, at most once per LAST_USED_EVERY_MS. */
async function touchShare(db: Db, share: ShareRow) {
  const now = Date.now();
  if (share.last_used_at !== null && now - share.last_used_at < LAST_USED_EVERY_MS) return;
  // (the row may be a cached one, reused by the next calls)
  share.last_used_at = now;
  await db.run("UPDATE share_links SET last_used_at = ? WHERE id = ?", now, share.id);
}

// ---- public endpoint ----

/** Fixed one-minute windows per link (and per MCP caller and workspace: mcp.ts). */
const calls = new Map<string, { start: number; n: number }>();

/** Seconds until `id` (a link, or an MCP caller's workspace) may be called again, or 0 if this call is allowed. */
export function rateLimited(id: string): number {
  const now = Date.now();
  if (calls.size > 10_000) for (const [k, v] of calls) if (now - v.start >= WINDOW_MS) calls.delete(k);
  const c = calls.get(id);
  if (!c || now - c.start >= WINDOW_MS) {
    calls.set(id, { start: now, n: 1 });
    return 0;
  }
  return ++c.n > shareLimits.perMinute ? Math.max(1, Math.ceil((c.start + WINDOW_MS - now) / 1000)) : 0;
}

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...HEADERS, ...headers } });

const jsonRes = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...HEADERS, ...headers } });

const NOT_FOUND = "Not found: this share link doesn't exist or was revoked.";

/** Whether a POST asked for a plain-text answer. */
function wantsText(req: Request, url: URL) {
  const accept = req.headers.get("accept") ?? "";
  return url.searchParams.get("format") === "text" || (accept.includes("text/plain") && !accept.includes("application/json"));
}

/** /a/<uuid>: GET for instructions, POST to run a command. */
/** What share links need of the app: the shell's, plus the global tables and the notebook listing for the instructions. */
export interface ShareCtx extends ShellCtx {
  repos: ShellCtx["repos"] & Pick<RepoService, "db" | "tree">;
}

export async function handleShareLink(req: Request, url: URL, ctx: ShareCtx, shells: ShellSessions): Promise<Response> {
  const post = req.method === "POST";
  // POST errors are JSON {error} unless text was asked for; GET answers are always text.
  const m = /^\/a\/([^/]+?)(\/changes)?\/?$/.exec(url.pathname);
  // GET /a/<id>/changes: JSON (what people changed since the last agent commit)
  const changes = !!m?.[2];
  const asText = (!post && !changes) || (post && wantsText(req, url));
  const fail = (status: number, error: string, headers: Record<string, string> = {}) => (asText ? text(`${error}\n`, status, headers) : jsonRes({ error }, status, headers));

  const db = ctx.repos.db;
  const share = m ? await getShare(db, m[1]!.toLowerCase()) : null;
  const repo = share ? await getRepo(db, share.repo_id) : null;
  if (!share || !repo) return fail(404, NOT_FOUND);
  if (!post && req.method !== "GET" && req.method !== "HEAD") return fail(405, "Method not allowed: GET for instructions, POST to run a command.", { allow: "GET, HEAD, POST" });
  if (repo.status !== "ready") return fail(409, `This notebook isn't ready (${repo.status === "importing" ? "still importing" : (repo.error ?? repo.status)}); try again shortly.`, { "retry-after": "10" });
  const level = linkAccess(share, repo);
  if (level === "none") return fail(404, NOT_FOUND);
  const wait = rateLimited(share.id);
  if (wait) return fail(429, `Too many calls: at most ${shareLimits.perMinute} per minute per link. Retry in ${wait} s.`, { "retry-after": String(wait) });
  if (changes) {
    if (req.method !== "GET") return fail(405, "Method not allowed: GET /changes", { allow: "GET" });
    try {
      return jsonRes(await ctx.repos.host.get(repo.id).changes(repo, url.searchParams.get("path") ?? ""));
    } catch (e) {
      const status = errStatus(e);
      if (status !== undefined && e instanceof Error) return fail(status, e.message);
      console.error("[share] changes:", e);
      return fail(500, "internal error");
    }
  }
  if (post) return run(req, db, share, repo, shells, asText, fail);
  const accept = req.headers.get("accept") ?? "";
  const markdown = accept.includes("text/markdown") && !accept.includes("text/plain");
  const body = await prompt(ctx, share, repo, level);
  return text(req.method === "HEAD" ? "" : body, 200, markdown ? { "content-type": "text/markdown; charset=utf-8" } : {});
}

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

async function run(
  req: Request,
  db: Db,
  share: ShareRow,
  repo: RepoRow,
  shells: ShellSessions,
  asText: boolean,
  fail: (status: number, error: string) => Response,
): Promise<Response> {
  try {
    const fields = requestFields(await readBody(req), req.headers.get("content-type") ?? "");
    const r = parseShellRequest(fields, req.headers.get("x-shell-session"));
    if (typeof r === "string") throw new BadRequest(400, r);
    const actorId = shareActorId(share.id);
    if (shells.pending(actorId) >= shareLimits.concurrent) {
      throw new BadRequest(429, `this link already has ${shareLimits.concurrent} commands running or queued; wait for them to finish`);
    }
    const actor = participantForAgent({ id: actorId, name: cleanLabel(req.headers.get("x-agent-name")) ?? share.label ?? DEFAULT_NAME });
    // Started before anything else is awaited, so the check above and this command's slot can't be split by
    // another call (the cap stays strict where the database is remote: a ShellDO).
    const running = shells.exec(actor, r.session ? `share:${r.session}` : "share", shellAccess(db, share.id, repo.id), r.command, {
      timeoutMs: r.timeoutMs,
      signal: req.signal,
      cwd: `${WORKSPACE}/${repo.id}`,
    });
    const [out] = await Promise.all([running, touchShare(db, share).catch((e) => console.error("[share] last_used_at:", e))]);
    // Revoked while it ran: the command was stopped; say so instead of returning its partial output.
    if (!(await getShare(db, share.id))) return fail(404, NOT_FOUND);
    if (asText) return text(formatResult(out).replace(/\n?$/, "\n"), 200, { "x-exit-code": String(out.exitCode), "x-cwd": encodeURI(out.cwd) });
    return jsonRes({ stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, cwd: out.cwd, truncated: !!out.truncated });
  } catch (e) {
    if (e instanceof BadRequest) return fail(e.status, e.message);
    if (isErr(e, "ShellBusyError")) return fail(429, e.message);
    console.error("[share] exec:", e);
    return fail(500, "internal error");
  }
}

// ---- the prompt ----

const MAX_LISTED = 25;

/** Top-level entries of the notebook: files, then folders with their note counts. */
function topLevel(files: string[]): string[] {
  const dirs = new Map<string, number>();
  const top: string[] = [];
  for (const f of files) {
    const i = f.indexOf("/");
    if (i < 0) top.push(f);
    else dirs.set(f.slice(0, i), (dirs.get(f.slice(0, i)) ?? 0) + 1);
  }
  const entries = [...[...dirs].map(([d, n]) => `${d}/  (${n} note${n === 1 ? "" : "s"})`), ...top];
  if (entries.length <= MAX_LISTED) return entries;
  return [...entries.slice(0, MAX_LISTED), `… and ${entries.length - MAX_LISTED} more (run ls)`];
}

async function prompt(ctx: ShareCtx, share: ShareRow, repo: RepoRow, level: Access): Promise<string> {
  const url = shareUrl(share.id);
  const root = `${WORKSPACE}/${repo.id}`;
  const files = await ctx.repos.tree(repo).catch(() => [] as string[]);
  const writable = level === "write";
  const listing = files.length ? topLevel(files).map((l) => `    ${l}`).join("\n") : "    (empty: no notes yet)";
  const name = share.label ?? DEFAULT_NAME;
  const sample = files.find((f) => /^[\w.-]+$/.test(f)) ?? files.find((f) => /^[\w./-]+$/.test(f)) ?? "note.md";
  // (a demo room's notes have no public URL: /app/demo/… gives each browser a room of its own)
  const readOnly = isDemoRoom(repo.id)
    ? ""
    : `## Just read a note
Every note's page URL also answers plain GETs with the note's Markdown (live, unsaved edits included); a folder's URL lists its notes, one per line:

\`\`\`bash
curl -s '${config.publicUrl}/app/${encodeURIComponent(repo.id)}/${sample.split("/").map(encodeURIComponent).join("/")}'
\`\`\`

`;
  const writing = writable
    ? `
## Writing files
${LIVE_EDITS}

To write a whole file, send a script whose \`cat > file\` reads a quoted heredoc, and wrap the script in a quoted heredoc of your own so your local shell leaves $, quotes and backticks alone (folders are created as needed):

\`\`\`bash
curl -s -X POST --data-binary @- '${url}?format=text' <<'CMD'
cat > ideas/new-note.md <<'EOF'
# New note
Text with $dollars, 'quotes' and \`backticks\`, kept as is.
EOF
CMD
\`\`\`

To upload a local file, build the same script around it (pick a delimiter that isn't a line of the file; awk 1 adds a missing final newline):

\`\`\`bash
{ printf "cat > notes/plan.md <<'GRIM_EOF'\\n"; awk 1 plan.md; printf 'GRIM_EOF\\n'; } | curl -s -X POST --data-binary @- '${url}?format=text'
\`\`\`
`
    : "";
  return `# Grim notebook: ${repo.title}

Grim is a multiplayer Markdown notebook: people edit notes live in the browser, and every note is a Markdown file in a Git repo. This URL gives you, an AI agent, a sandboxed bash shell over one notebook, "${repo.title}". Access: ${writable ? "read and write" : "read-only (you can read and search; writes fail)"}. Use it with plain HTTP (curl); there is nothing to install.

The notebook is a folder of Markdown files at ${root}, where your shell starts. ${files.length} note${files.length === 1 ? "" : "s"}. Top level:
${listing}

## Run a command
POST the command to this exact URL as the request body:

\`\`\`bash
curl -s -X POST --data-binary 'ls -R' '${url}?format=text'
curl -s -X POST -H 'X-Agent-Name: <your name>' --data-binary 'cat ${sample}' '${url}?format=text'
curl -s -X POST -H 'content-type: application/json' -d '{"command": "grep -rn TODO .", "session": "work", "timeout_seconds": 60}' '${url}'
\`\`\`

- X-Agent-Name labels your cursor and commits (default "${name}"); send it on every call.
- JSON bodies take {"command": "...", "session"?: "...", "timeout_seconds"?: N}. Multi-line scripts (pipes, loops, heredocs) work as one body: send them with --data-binary @- and a quoted heredoc, as below.

## The response
- JSON by default: {"stdout": "...", "stderr": "...", "exitCode": 0, "cwd": "${root}", "truncated": false}
- With ?format=text (or Accept: text/plain): stdout, then "[stderr]" and stderr, then "[exit N]" if it failed. The X-Exit-Code and X-Cwd headers carry the rest.
- Errors (bad request, rate limit) come back with a 4xx status and {"error": "..."} (plain text with ?format=text).

## Sessions
A session keeps the cwd, variables and /tmp between calls: \`cd ideas\` in one call and the next call starts in ideas/. Calls without a session share one default session. For a separate one, send "session": "<name>" in JSON or the header X-Shell-Session: <name> (1-128 characters of A-Z a-z 0-9 . _ : -).

${readOnly}## See what people changed
People keep editing while you're away. \`changes\` shows what they wrote by hand since the last agent commit (any agent's), edits not saved yet included: the changed notes with +/- counts, then unified diffs. Run it when you come back, before you start.

\`\`\`bash
curl -s -X POST --data-binary 'changes' '${url}?format=text'          # everything
curl -s -X POST --data-binary 'changes --stat' '${url}?format=text'   # just the list
curl -s -X POST --data-binary 'changes ${sample}' '${url}?format=text'
curl -s '${url}/changes'                                         # JSON: {"since": {"commit", "agent", "at"} | null, "files": [{"path", "status", "from"?, "added", "removed", "diff"}], "truncated"}
curl -s '${url}/changes?path=${sample}'
\`\`\`
${writing}
## Useful commands
${usefulCommands(sample)}

## Limits
${shellLimits(writable, "Request bodies up to 1 MB. ", "per link")}
`;
}

// ---- what the link's instructions and the MCP server's (mcp.ts) say alike ----

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

/** The shell's limits as a list; `extra` goes before the rate limits, which apply `per` (a link, a workspace). */
export function shellLimits(writable: boolean | null, extra: string, per: string): string {
  return `- Only Markdown files (.md, .markdown, .mdx) exist in a workspace${writable === null ? " (read-only workspaces can't be written)" : writable ? " and can be written" : ""}; /tmp is private scratch space for any file.
- Standard tools work (ls cat grep sed awk find jq diff sort head wc ...). There is no python, node or other runtime, no network access, no editors.
- Each call stops after 30 s by default (timeout_seconds up to 110). Output over 200 KB per stream is cut ("truncated": true; narrow it with head, grep, sed -n). ${extra}At most ${shareLimits.perMinute} calls per minute and ${shareLimits.concurrent} commands at a time ${per}.`;
}


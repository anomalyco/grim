// "Share with agent" links: /a/<uuid> is a capability URL that gives whoever holds it a shell over one notebook.
// GET returns instructions for an AI agent; POST runs a command. No cookies, no other auth.
import { config } from "./config.ts";
import { participantForAgent, type Access } from "./auth.ts";
import { db } from "./db.ts";
import { formatResult, parseTimeout } from "./mcp.ts";
import type { Ctx } from "./ops.ts";
import { getRepo, slugify, type RepoRow } from "./repos.ts";
import type { Participant } from "./rooms.ts";
import { WORKSPACE, type AccessFn } from "./shell/fs.ts";
import { ShellBusyError, type ShellSessions } from "./shell/session.ts";

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
const SESSION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const DEFAULT_NAME = "Agent";

/** Calls per link per minute (GET and POST). Tests lower it. */
export const shareLimits = { perMinute: 120 };

export const shareUrl = (id: string) => `${config.publicUrl}/a/${id}`;

/** What a link may do: the notebook's own level (read-only notebooks are read-only). */
export const shareAccess = (repo: RepoRow): Access => (repo.read_only ? "read" : "write");

export function createShare(repoId: string, label: string | null, createdBy: string | null): ShareRow {
  const row: ShareRow = { id: crypto.randomUUID(), repo_id: repoId, label, created_by: createdBy, created_at: Date.now(), last_used_at: null, revoked_at: null };
  db.query("INSERT INTO share_links (id, repo_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(row.id, row.repo_id, row.label, row.created_by, row.created_at);
  return row;
}

/** Active links of a notebook, oldest first, with their creator's name. */
export function listShares(repoId: string): Array<ShareRow & { creator_name: string | null }> {
  return db
    .query("SELECT s.*, u.name AS creator_name FROM share_links s LEFT JOIN users u ON u.id = s.created_by WHERE s.repo_id = ? AND s.revoked_at IS NULL ORDER BY s.created_at")
    .all(repoId) as Array<ShareRow & { creator_name: string | null }>;
}

/** An active link by id (null if unknown, malformed or revoked). */
export function getShare(id: string): ShareRow | null {
  if (!UUID.test(id)) return null;
  return db.query("SELECT * FROM share_links WHERE id = ? AND revoked_at IS NULL").get(id) as ShareRow | null;
}

export function revokeShare(id: string) {
  db.query("UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  calls.delete(id);
}

// ---- public endpoint ----

/** Fixed one-minute windows per link. */
const calls = new Map<string, { start: number; n: number }>();

function rateLimited(id: string): boolean {
  const now = Date.now();
  if (calls.size > 10_000) for (const [k, v] of calls) if (now - v.start >= 60_000) calls.delete(k);
  const c = calls.get(id);
  if (!c || now - c.start >= 60_000) {
    calls.set(id, { start: now, n: 1 });
    return false;
  }
  return ++c.n > shareLimits.perMinute;
}

/** X-Agent-Name, made safe to show: no control characters, single spaces, at most 40 characters. */
export function agentName(raw: string | null): string | null {
  const name = (raw ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return name || null;
}

function participant(share: ShareRow, header: string | null): Participant {
  const given = agentName(header);
  const name = given ?? share.label ?? DEFAULT_NAME;
  return participantForAgent({ id: given ? `share:${share.id}:${slugify(given) || "agent"}` : `share:${share.id}`, name });
}

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });

const NOT_FOUND = () => text("Not found: this share link doesn't exist or was revoked.\n", 404);

/** /a/<uuid>: GET for instructions, POST to run a command. */
export async function handleShareLink(req: Request, url: URL, ctx: Ctx, shells: ShellSessions): Promise<Response> {
  const m = /^\/a\/([^/]+)\/?$/.exec(url.pathname);
  const share = m ? getShare(m[1]!.toLowerCase()) : null;
  if (!share) return NOT_FOUND();
  const repo = getRepo(share.repo_id);
  if (!repo) return NOT_FOUND();
  const method = req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return text("Method not allowed: GET for instructions, POST to run a command.\n", 405, { allow: "GET, HEAD, POST" });
  if (repo.status !== "ready") return text(`This notebook isn't ready (${repo.status === "importing" ? "still importing" : (repo.error ?? repo.status)}); try again shortly.\n`, 409, { "retry-after": "10" });
  if (rateLimited(share.id)) return text(`Too many calls: at most ${shareLimits.perMinute} per minute per link. Wait a bit and retry.\n`, 429, { "retry-after": "10" });
  if (method === "POST") return run(req, url, share, repo, shells);
  const accept = req.headers.get("accept") ?? "";
  const markdown = accept.includes("text/markdown") && !accept.includes("text/plain");
  const body = await prompt(ctx, share, repo);
  return text(method === "HEAD" ? "" : body, 200, markdown ? { "content-type": "text/markdown; charset=utf-8" } : {});
}

class BadRequest extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readCommand(req: Request): Promise<{ command: string; session?: string; timeout?: unknown }> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) throw new BadRequest(413, `request body too large (max ${MAX_BODY / 1024 / 1024} MB)`);
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY) throw new BadRequest(413, `request body too large (max ${MAX_BODY / 1024 / 1024} MB)`);
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new BadRequest(400, "the body must be UTF-8 text");
  }
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  // JSON when declared, or when it plainly is a {"command": ...} object (curl -d sends a form content type).
  let parsed: unknown = undefined;
  if (type.startsWith("application/json") || /^\s*\{\s*"command"\s*:/.test(body)) {
    try {
      parsed = JSON.parse(body);
    } catch {
      if (type.startsWith("application/json")) throw new BadRequest(400, "invalid JSON body");
    }
  }
  if (parsed === undefined) return { command: body };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest(400, 'expected a JSON object: {"command": "...", "session"?: "...", "timeout_seconds"?: N}');
  const b = parsed as Record<string, unknown>;
  if (typeof b.command !== "string") throw new BadRequest(400, "command is required (a string)");
  if (b.session !== undefined && b.session !== null && typeof b.session !== "string") throw new BadRequest(400, "session must be a string");
  return { command: b.command, session: (b.session as string | null) ?? undefined, timeout: b.timeout_seconds };
}

async function run(req: Request, url: URL, share: ShareRow, repo: RepoRow, shells: ShellSessions): Promise<Response> {
  const accept = req.headers.get("accept") ?? "";
  const asText = url.searchParams.get("format") === "text" || (accept.includes("text/plain") && !accept.includes("application/json"));
  const fail = (status: number, error: string) => (asText ? text(`error: ${error}\n`, status) : jsonRes({ error }, status));
  try {
    const b = await readCommand(req);
    if (!b.command.trim()) throw new BadRequest(400, "command is required: send the shell command as the request body");
    const session = b.session ?? req.headers.get("x-shell-session") ?? undefined;
    if (session !== undefined && !SESSION_KEY.test(session)) throw new BadRequest(400, "session must be 1-128 characters of A-Z a-z 0-9 . _ : -");
    const timeout = parseTimeout(b.timeout);
    if (typeof timeout === "string") throw new BadRequest(400, timeout);
    const actor = participant(share, req.headers.get("x-agent-name"));
    const level = shareAccess(repo);
    const access: AccessFn = async (r) => (r.id === repo.id ? level : "none");
    db.query("UPDATE share_links SET last_used_at = ? WHERE id = ?").run(Date.now(), share.id);
    const r = await shells.exec(actor, session ? `share:${session}` : "share", access, b.command, {
      timeoutMs: timeout * 1000,
      signal: req.signal,
      cwd: `${WORKSPACE}/${repo.id}`,
    });
    if (asText) return text(formatResult(r).replace(/\n?$/, "\n"), 200, { "x-exit-code": String(r.exitCode), "x-cwd": encodeURI(r.cwd) });
    return jsonRes({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, cwd: r.cwd, truncated: !!r.truncated });
  } catch (e) {
    if (e instanceof BadRequest) return fail(e.status, e.message);
    if (e instanceof ShellBusyError) return fail(429, e.message);
    console.error("[share] exec:", e);
    return fail(500, "internal error");
  }
}

const jsonRes = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

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

async function prompt(ctx: Ctx, share: ShareRow, repo: RepoRow): Promise<string> {
  const url = shareUrl(share.id);
  const root = `${WORKSPACE}/${repo.id}`;
  const files = await ctx.repos.tree(repo).catch(() => [] as string[]);
  const writable = shareAccess(repo) === "write";
  const listing = files.length ? topLevel(files).map((l) => `    ${l}`).join("\n") : "    (empty: no notes yet)";
  const name = share.label ?? DEFAULT_NAME;
  const sample = files.find((f) => /^[\w.-]+$/.test(f)) ?? files.find((f) => /^[\w./-]+$/.test(f)) ?? "note.md";
  const writeExamples = writable
    ? `sed -i 's/- \\[ \\] milk/- [x] milk/' todo.md       # targeted edit
echo '- buy eggs' >> todo.md                       # append
cat > ideas/new-note.md <<'EOF'                    # create a note (folders are implicit)
# New note
Text here.
EOF
mv draft.md archive/draft.md; rm old.md
save                                               # commit now instead of in 15 s
`
    : "";
  return `# Grimoire notebook: ${repo.title}

Grimoire is a multiplayer Markdown notebook: people edit notes live in the browser, and every note is a Markdown file in a Git repo. This URL gives you, an AI agent, a sandboxed bash shell over one notebook, "${repo.title}". Access: ${writable ? "read and write" : "read-only (you can read and search; writes fail)"}.

The notebook is a filesystem of Markdown files: its root is ${root}, where your shell starts. ${files.length} note${files.length === 1 ? "" : "s"}. Top level:
${listing}

## How to run commands
POST a bash command to this exact URL; the request body is the command:

\`\`\`bash
curl -s -X POST '${url}' --data-binary 'ls -R'
\`\`\`

Send multi-line scripts (pipes, heredocs, loops all work) through a quoted heredoc so your own shell leaves them alone:

\`\`\`bash
curl -s -X POST '${url}' --data-binary @- <<'CMD'
${writable ? "cat > ideas/new-note.md <<'EOF'\n# New note\nText here.\nEOF\n" : ""}grep -rn 'TODO' . | head -20
CMD
\`\`\`

Or send JSON, {"command": "...", "session": "optional", "timeout_seconds": 30}:

\`\`\`bash
curl -s -X POST '${url}' -H 'content-type: application/json' -d '{"command": "cat ${sample}"}'
\`\`\`

The response is JSON: {"stdout": "...", "stderr": "...", "exitCode": 0, "cwd": "${root}", "truncated": false}
Add ?format=text to the URL (or send Accept: text/plain) to get plain text instead: stdout, then [stderr] and stderr, then [exit N] if it failed.

- Shell state (cwd, variables, /tmp) persists between calls: calls share one session unless you send "session" (or the X-Shell-Session header) to keep separate ones.
- Send the header X-Agent-Name: <your name> to label your cursor and commits (default "${name}").
${writable ? `- Edits are live: people with a note open see your change at once, with your cursor. Changed files are committed to Git after 15 s without edits; \`save\` commits now. Prefer targeted edits (sed -i, >>) over rewriting whole files. If someone changed the same spot since you read a file, the write fails with "changed by someone else": read it again and redo the edit.
` : ""}
## Example commands (send them as the POST body)
\`\`\`bash
ls -R; cat ${sample}; sed -n '40,80p' long.md
grep -rn 'TODO' .
find . -name '*.md' | head -50
${writeExamples}git log --oneline -n 10; git diff; git status      # history (read-only; commits are automatic)
who todo.md                                        # who has it open
watch todo.md --timeout 60                         # wait until someone edits it
\`\`\`

## Limits
- Only Markdown files (.md, .markdown, .mdx) exist in the notebook${writable ? " and can be written" : ""}; /tmp is private scratch space for any file.
- Standard tools work (ls cat grep sed awk find jq diff sort head wc ...). There is no python, node or other runtime, no network access, no editors.
- Each call stops after 30 s by default (timeout_seconds up to 110). Output over 200 KB per stream is cut (narrow it with head, grep, sed -n). At most ${shareLimits.perMinute} calls per minute.
`;
}

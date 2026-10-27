// "Share with agent" links: /a/<uuid> is a capability URL that gives whoever holds it a shell over one notebook.
// GET returns instructions for an AI agent; POST runs a command. No cookies, no other auth.
import { config } from "./config.ts";
import { participantForAgent, repoAccess, userById, type Access } from "./auth.ts";
import { db } from "./db.ts";
import type { Ctx } from "./ops.ts";
import { getRepo, type RepoRow } from "./repos.ts";
import { WORKSPACE, type AccessFn } from "./shell/fs.ts";
import { formatResult, parseShellRequest, ShellBusyError, type ShellSessions } from "./shell/session.ts";

export interface ShareRow {
  id: string;
  repo_id: string;
  label: string | null;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  /** 'agent': a shell over the workspace (/a/<id>); 'note': one note in the web app (?share=<id>). */
  kind: "agent" | "note";
  /** A note link's note. */
  path: string | null;
  /** 'viewer' caps the link at read-only; 'editor' (or NULL, older links) at what its creator can do. */
  role: "viewer" | "editor" | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BODY = 1024 * 1024;
const DEFAULT_NAME = "Agent";
const WINDOW_MS = 60_000;

/** Per link: calls per minute (GET and POST), and commands running or queued at once. Tests lower them. */
export const shareLimits = { perMinute: 120, concurrent: 4 };

export const shareUrl = (id: string) => `${config.publicUrl}/a/${id}`;

/** A note link: the note in the web app, carrying the link as ?share=<id>. */
export const noteShareUrl = (id: string, repoId: string, path: string) =>
  `${config.publicUrl}/app/${encodeURIComponent(repoId)}/${path.split("/").map(encodeURIComponent).join("/")}?share=${id}`;

export const linkUrl = (s: Pick<ShareRow, "id" | "kind" | "repo_id" | "path">) => (s.kind === "note" && s.path ? noteShareUrl(s.id, s.repo_id, s.path) : shareUrl(s.id));

/** The shell actor id of a link: one identity per link, whatever name the agent gives. */
export const shareActorId = (id: string) => `share:${id}`;

/** A label or agent name, made safe to show: no control characters, single spaces, at most `max` characters. */
export function cleanLabel(raw: unknown, max = 40): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return name || null;
}

export function createShare(
  repoId: string,
  label: string | null,
  createdBy: string,
  opts: { kind?: "agent" | "note"; path?: string | null; role?: "viewer" | "editor" | null } = {},
): ShareRow {
  const row: ShareRow = {
    id: crypto.randomUUID(),
    repo_id: repoId,
    label,
    created_by: createdBy,
    created_at: Date.now(),
    last_used_at: null,
    revoked_at: null,
    kind: opts.kind ?? "agent",
    path: opts.path ?? null,
    role: opts.role ?? null,
  };
  db.query("INSERT INTO share_links (id, repo_id, label, created_by, created_at, kind, path, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.repo_id,
    row.label,
    row.created_by,
    row.created_at,
    row.kind,
    row.path,
    row.role,
  );
  return row;
}

/** Active links of a notebook, oldest first, with their creator's name; only `createdBy`'s if given. */
export function listShares(repoId: string, createdBy?: string): Array<ShareRow & { creator_name: string | null }> {
  const mine = createdBy === undefined ? "" : " AND s.created_by = ?";
  return db
    .query(`SELECT s.*, u.name AS creator_name FROM share_links s LEFT JOIN users u ON u.id = s.created_by WHERE s.repo_id = ? AND s.revoked_at IS NULL${mine} ORDER BY s.created_at`)
    .all(...(createdBy === undefined ? [repoId] : [repoId, createdBy])) as Array<ShareRow & { creator_name: string | null }>;
}

/** An active link by id (null if unknown, malformed or revoked). */
export function getShare(id: string): ShareRow | null {
  if (!UUID.test(id)) return null;
  return db.query("SELECT * FROM share_links WHERE id = ? AND revoked_at IS NULL").get(id) as ShareRow | null;
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

export function revokeShare(id: string) {
  db.query("UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  closed(id);
}

/** Before a notebook is removed (its links are deleted with it): stop everything running through its links. */
export function closeRepoShares(repoId: string) {
  for (const s of listShares(repoId)) closed(s.id);
}

/**
 * What a link may do right now: the notebook's own level (read-only notebooks are read-only), capped by what its
 * creator can currently do (a creator who lost access, or may no longer sign in, takes the link down with them).
 */
export async function linkAccess(share: ShareRow, repo: RepoRow): Promise<Access> {
  if (share.repo_id !== repo.id || repo.status !== "ready" || !share.created_by) return "none";
  const creator = userById(share.created_by);
  if (!creator) return "none";
  const theirs = await repoAccess(creator, repo);
  if (theirs === "none") return "none";
  return theirs === "write" && !repo.read_only && share.role !== "viewer" ? "write" : "read";
}

/** The shell's view: only the link's notebook, checked again (link, notebook, creator) on every call. */
function shellAccess(shareId: string, repoId: string): AccessFn {
  return async (r) => {
    if (r.id !== repoId) return "none";
    const share = getShare(shareId);
    const repo = getRepo(repoId);
    return share && repo && share.kind === "agent" ? linkAccess(share, repo) : "none";
  };
}

// ---- public endpoint ----

/** Fixed one-minute windows per link. */
const calls = new Map<string, { start: number; n: number }>();

/** Seconds until the link may be called again, or 0 if this call is allowed. */
function rateLimited(id: string): number {
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
export async function handleShareLink(req: Request, url: URL, ctx: Ctx, shells: ShellSessions): Promise<Response> {
  const post = req.method === "POST";
  // POST errors are JSON {error} unless text was asked for; GET answers are always text.
  const asText = !post || wantsText(req, url);
  const fail = (status: number, error: string, headers: Record<string, string> = {}) => (asText ? text(`${error}\n`, status, headers) : jsonRes({ error }, status, headers));

  const m = /^\/a\/([^/]+)\/?$/.exec(url.pathname);
  const share = m ? getShare(m[1]!.toLowerCase()) : null;
  const repo = share ? getRepo(share.repo_id) : null;
  // Note links open one note in the web app; only agent links give a shell.
  if (!share || !repo || share.kind !== "agent") return fail(404, NOT_FOUND);
  if (!post && req.method !== "GET" && req.method !== "HEAD") return fail(405, "Method not allowed: GET for instructions, POST to run a command.", { allow: "GET, HEAD, POST" });
  if (repo.status !== "ready") return fail(409, `This notebook isn't ready (${repo.status === "importing" ? "still importing" : (repo.error ?? repo.status)}); try again shortly.`, { "retry-after": "10" });
  const level = await linkAccess(share, repo);
  if (level === "none") return fail(404, NOT_FOUND);
  const wait = rateLimited(share.id);
  if (wait) return fail(429, `Too many calls: at most ${shareLimits.perMinute} per minute per link. Retry in ${wait} s.`, { "retry-after": String(wait) });
  if (post) return run(req, share, repo, shells, asText, fail);
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
    db.query("UPDATE share_links SET last_used_at = ? WHERE id = ?").run(Date.now(), share.id);
    const out = await shells.exec(actor, r.session ? `share:${r.session}` : "share", shellAccess(share.id, repo.id), r.command, {
      timeoutMs: r.timeoutMs,
      signal: req.signal,
      cwd: `${WORKSPACE}/${repo.id}`,
    });
    // Revoked while it ran: the command was stopped; say so instead of returning its partial output.
    if (!getShare(share.id)) return fail(404, NOT_FOUND);
    if (asText) return text(formatResult(out).replace(/\n?$/, "\n"), 200, { "x-exit-code": String(out.exitCode), "x-cwd": encodeURI(out.cwd) });
    return jsonRes({ stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, cwd: out.cwd, truncated: !!out.truncated });
  } catch (e) {
    if (e instanceof BadRequest) return fail(e.status, e.message);
    if (e instanceof ShellBusyError) return fail(429, e.message);
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

async function prompt(ctx: Ctx, share: ShareRow, repo: RepoRow, level: Access): Promise<string> {
  const url = shareUrl(share.id);
  const root = `${WORKSPACE}/${repo.id}`;
  const files = await ctx.repos.tree(repo).catch(() => [] as string[]);
  const writable = level === "write";
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
save                                               # commit now instead of in 3 s
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
${writable ? `- Edits are live: people with a note open see your change at once, with your cursor. Changed files are committed to Git after 3 s without edits; \`save\` commits now. Prefer targeted edits (sed -i, >>) over rewriting whole files. If someone changed the same spot since you read a file, the write fails with "changed by someone else": read it again and redo the edit.
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

// ---- note links ----

/** The share link id a request carries for the web app or the Mac app: ?share=<id> or X-Grimoire-Share. */
export function requestShareId(req: Request, url: URL): string | null {
  const id = (url.searchParams.get("share") ?? req.headers.get("x-grimoire-share") ?? "").trim().toLowerCase();
  return id || null;
}

/** A note link the request carries for this workspace, with what it allows now (capped by its creator). */
export async function noteLinkFor(req: Request, url: URL, repo: RepoRow): Promise<{ share: ShareRow; path: string; access: Access } | null> {
  const id = requestShareId(req, url);
  const share = id ? getShare(id) : null;
  if (!share || share.kind !== "note" || share.repo_id !== repo.id || !share.path) return null;
  const access = await linkAccess(share, repo);
  return access === "none" ? null : { share, path: share.path, access };
}

/** Split a repo path into clean parts, or null if it leaves the repo. */
function resolveParts(base: string[], rel: string): string[] | null {
  const out = rel.startsWith("/") ? [] : [...base];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out : null;
}

/**
 * The repo paths of the images a note shows: Markdown images `![alt](src "title")` (and `<src>`), and HTML
 * `<img src>`. Relative sources resolve against the note's folder, `/…` against the repo root; URLs with a scheme
 * aren't repo files.
 */
export function embeddedImages(markdown: string, notePath: string): Set<string> {
  const dir = notePath.split("/").slice(0, -1);
  const out = new Set<string>();
  const add = (raw: string) => {
    let src = raw.trim();
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//") || src.startsWith("#")) return;
    src = src.replace(/[?#].*$/, "");
    try {
      src = decodeURIComponent(src);
    } catch {
      // keep it as written
    }
    const parts = resolveParts(dir, src.replace(/\\/g, "/"));
    if (parts) out.add(parts.join("/"));
  };
  for (const m of markdown.matchAll(/!\[(?:[^\]\\]|\\.)*\]\(\s*(?:<([^>\n]*)>|([^\s)]+))/g)) add(m[1] ?? m[2] ?? "");
  for (const m of markdown.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

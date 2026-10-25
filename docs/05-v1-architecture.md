# Grimoire V1: architecture and internal contracts

Grimoire: a multiplayer markdown notebook. People edit in the browser with live cursors; agents work in a bash shell over the same notes (through MCP or HTTP). Everything is stored in Git via Code Storage (or local bare repos in dev). This doc is the contract that the server, MCP, client shell, and editor are built against.

## Overview

```
Browsers ──WS /ws (Yjs sync + awareness + control)──┐
Browsers ──HTTP /api/*, SSE /api/events ─────────────┤
Agents   ──HTTP /mcp (bash tool), POST /api/shell ───┼─► Bun server ──► GitStore (Code Storage | local git)
Code Storage ──POST /webhooks/codestorage ───────────┘     ├─ RoomManager: one live Yjs room per open file
                                                           ├─ RepoService: repo registry, markdown tree, push handling
                                                           └─ SQLite: users, sessions, agent tokens, repos, crash log
```

- **Repos:** `kind = "notes"` repos are hosted only in Code Storage. The default one is `config.notesRepo` (created at startup), and people can create more. `kind = "github"` repos are Code Storage repos synced two-way with GitHub (needs the GitHub App) or read-only copies of a public repo (`read_only = 1`) that any signed-in user can add. Read-only copies are refreshed from GitHub every `UPSTREAM_REFRESH_MS` (5 min) and on `POST /api/repos/:id/refresh` (`store.pullUpstream`, then `onPush`). In local mode they are partial clones (`--filter=blob:none`): blobs are fetched from GitHub when read, and in one batch for listings with sizes, search and diffs.
- **Branch:** every repo commits to its default branch (`repos.branch`).
- **Only Markdown files** (`.md`, `.markdown`, `.mdx`) are listed or opened.
- **Commits:** a room commits its file after `QUIET_MS` (15 s) without edits, on Cmd-S (control message `flush`), when an agent runs `save`, or before the room closes. The author is the main editor since the last commit; other editors become `Co-authored-by:` trailers.
- **Outside pushes:** a Code Storage webhook (plus a poller every `POLL_MS`) triggers `RepoService.onPush`. That refreshes the tree, emits SSE `tree`, and 3-way merges the change into open rooms.

## Existing modules (phase 1, done)
- `src/server/config.ts`: env config.
- `src/server/db.ts`: `db` (bun:sqlite) with the tables `users`, `sessions`, `agent_tokens`, `repos`, `room_meta`, `room_updates`; `newId(prefix)`, `sha256(s)`.
- `src/server/store/*`: `GitStore` interface, `LocalGitStore`, `CodeStorageStore`; `isMarkdown`, `RepoBusyError`.
- `src/server/rooms.ts`: `RoomManager`, `Room`, `Participant`, `Conn`, `NotFoundError`, `MSG_*`, `TEXT_NAME`.
  - `rooms.get(repo, path, branch, create?)` opens or loads a room. `create` is the initial text for a new file; `null` means the file must exist.
  - `room.text` is a `Y.Text`.
  - `room.agentEdit(participant, fn)` applies an edit as that participant; `fn` may return a cursor index to show the agent's cursor.
  - `room.flush()`, `room.status()`, `room.participants()`, `room.version` (bumped on every change), `room.addConn/removeConn/onMessage`.
- `src/server/repos.ts`: `RepoService`, `getRepo(id)`, `listRepoRows()`, `cleanPath(p)` (normalizes and appends `.md`; returns null if invalid), `slugify`.
  - `RepoService` methods: `ensureNotesRepo`, `createNotesRepo`, `linkGitHub`, `removeRepo`, `tree`, `onPush`, `startPolling`.
- `src/server/events.ts`: `emit`, `subscribe`, `notifyChange`, `waitForChange(repo, path?, timeoutMs, signal?)` (a path ending in `/` watches a folder; no path watches the repo).
- `src/shared/presence.ts`: `PresenceState` (awareness state shape).

## Auth (`src/server/auth.ts`)
```ts
export interface User { id: string; login: string; name: string; email: string; avatar: string | null; isAdmin: boolean; githubToken: string | null }
export function userFromRequest(req: Request): User | null                 // session cookie "np_session"
export function agentFromRequest(req: Request): { id: string; name: string } | null  // "Authorization: Bearer grim_..."
export function participantForUser(u: User): Participant                   // kind "human", stable color from id; email = GitHub noreply if needed
export function participantForAgent(a: { id: string; name: string }): Participant  // kind "agent", email `${slug}@agents.grimoire`
export async function handleAuthRoute(req: Request, url: URL): Promise<Response | null>  // /auth/* routes, else null
export function createAgentToken(name: string, createdBy: string | null): { id: string; token: string }
export function listAgentTokens(): Array<{ id: string; name: string; createdAt: number; lastUsedAt: number | null }>
export function deleteAgentToken(id: string): void
export async function repoAccess(u: User, repo: RepoRow): Promise<"write" | "read" | "none">
```
- **GitHub OAuth** (`GITHUB_CLIENT_ID`/`SECRET`, works with a GitHub App's user auth):
  - `/auth/github` → GitHub; `/auth/github/callback` → upsert the user, set the cookie, redirect to `/`.
  - Request the `read:user user:email` scopes. A GitHub App ignores scopes, which is fine.
  - The email is the primary verified email, or `${github_id}+${login}@users.noreply.github.com`.
- **Dev login:** `/auth/dev` (a form with a name) is enabled only if `ALLOW_DEV_LOGIN=1`.
- **Logout:** `POST /auth/logout`.
- **Who may sign in:** `ALLOWED_GITHUB_USERS` (`*` = anyone). If it's empty, only the first user to sign in may, and that user becomes admin. The first user is always admin.
- **Sessions:** 30 days, cookie `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when `PUBLIC_URL` is https.
- **Agent tokens:** `grim_<random>`. Only `sha256(token)` is stored. `last_used_at` is updated on use.
- **`repoAccess`:**
  - Notes repos: `write`.
  - GitHub repos with `read_only=1`: `read`.
  - Other GitHub repos: ask GitHub with the user's token (`GET /repos/{o}/{n}` → `permissions.push` ⇒ write, `pull` ⇒ read, 404 ⇒ none), cached 5 min. With no user token (dev login): `write`.
- **Agents** have `write` on all repos with `read_only=0` in V1.

## HTTP API (`src/server/api.ts`, JSON, requires a session unless noted)
| Method & path | Body / query | Response |
|---|---|---|
| GET `/api/config` (no auth) | | `{ githubLogin: bool, devLogin: bool, githubAppSlug: string \| null, storage: "codestorage" \| "local" }` |
| GET `/api/me` | | `User` minus `githubToken`, or 401 |
| GET `/api/repos` | | `[{ id, title, kind, ghOwner, ghName, branch, status, error, readOnly, access, canRemove }]` (`access` != none) |
| POST `/api/repos` | `{ title }` → new notes repo · `{ github: "<owner/name or github.com URL>", branch?, readOnly?: bool (default true; publicReadOnly is the old name) }` → add a GitHub repo. Read-only: any user, public repos only (checked without a token; falls back to anonymous `git ls-remote` when GitHub's API is rate limited). Editable: needs access on GitHub or admin. The branch comes from `branch` or a `/tree/`/`/blob/` URL | repo (201), or the existing copy (200) |
| GET `/api/repos/:id` | | repo (any status) |
| POST `/api/repos/:id/refresh` | | `{ head }`. Read-only GitHub copies pull from GitHub first (at most every 10 s) |
| DELETE `/api/repos/:id` | admins, or whoever added a read-only GitHub copy (`canRemove`) | `{ ok: true }` |
| GET `/api/repos/:id/tree` | | `{ head, files: string[] }` (Markdown paths, sorted) |
| POST `/api/repos/:id/files` | `{ path, content? }` | `{ path, version }` (201). Opens a room with the content (default `"# <basename>\n"`); like any edit it is in the crash log at once and committed after the quiet period. 409 if it already exists |
| DELETE `/api/repos/:id/files?path=` | | `{ ok }`. Commits the deletion; open room → `closeWith("deleted")` |
| POST `/api/repos/:id/rename` | `{ from, to }` | `{ path: to }`. Flushes the room, commits add+delete in one commit, open room → `closeWith("renamed", { to })` |
| GET `/api/repos/:id/history?path=&limit=` | | `[{ sha, message, authorName, authorEmail, date }]` |
| GET `/api/repos/:id/diff?sha=&path=` | | `{ diff }` (unified) |
| GET `/api/repos/:id/file?path=&ref=` | | `{ content, version, live }` at ref (default: live room text if open, else branch tip; `live` says which) |
| POST `/api/repos/:id/restore` | `{ path, sha }` | `{ ok }`. Replaces the live text with the file at `sha`, as a normal edit by the user (minimal diff) |
| GET `/api/repos/:id/search?q=` | | `[{ path, line, text }]` |
| GET `/api/events` | | SSE stream of `AppEvent` (`tree`, `repos`, `presence`, `saved`) for repos the user can access |
| GET/POST/DELETE `/api/agent-tokens[/:id]` | admin; POST `{ name }` | list / `{ id, token }` (shown once) / ok |
| POST `/api/shell` | agent bearer token or session cookie (same CSRF rule as `/api`); `{ command, session?, timeout_seconds? }`; the session key can also come from `X-Shell-Session` | `{ stdout, stderr, exitCode, cwd, truncated? }`; 429 if the session already has too many commands queued. See "Agent shell" |
| POST `/webhooks/codestorage` (no session) | Code Storage push webhook; verified with `validateWebhook` from `@pierre/storage` and `CODE_STORAGE_WEBHOOK_SECRET` | calls `repos.onPush(repository.id)` |

Errors: `{ error: string }` with a 4xx/5xx status. Repo ids in paths are URL-encoded.

## WebSocket `/ws?repo=<id>&path=<path>` (session cookie)
- Binary messages. The first varUint is the type:
  - `0` = y-protocols sync
  - `1` = y-protocols awareness
  - `2` = control: a varString of JSON
- **Server → client control messages:**
  - `{t:"hello", generation, readOnly, dirty, saving, commit, savedAt}`: the first message after connecting.
  - `{t:"status", dirty, saving, commit, savedAt}`
  - `{t:"external", commit}`: an outside change was merged in.
  - `{t:"closed", reason: "deleted" | "renamed" | "removed", to?}`
- **Client → server:** `{t:"flush"}`.
- **Generation:** if a reconnect's `hello.generation` differs from the one the client synced with before, the room was recreated. The client must throw away its Y.Doc, create a fresh one and remount the editor. Merging the old doc into the new one would duplicate text.
- **Read-only connections:** their document updates are ignored.
- **Close codes:**
  - 4401: unauthorized
  - 4403: no access
  - 4404: file not found
  - 4000: closed for a reason

## Agent shell (`src/server/shell/`)
Bash is the only interface for agents. Each shell is a [just-bash](https://www.npmjs.com/package/just-bash) interpreter (TypeScript, no processes; its defense-in-depth lockdown is on, and our filesystem runs as trusted host code) with:
- **`/workspace/<repo>/<path>`**: the Markdown files of every ready repo the actor can access (`fs.ts`, `GrimoireFs`).
  - Reads see live room text, else the branch tip (cached by commit). Listings and `stat` never download files: sizes come from the store's file listing (`listFilesWithMetadata`).
  - Writes are collected while a command runs and applied when it finishes, as minimal edits through `room.agentEdit` (people see them live with the agent's cursor; a redirect's truncate-then-write is one edit). If the command times out, is cancelled or hits an execution limit, its writes are dropped.
  - A rewrite is a 3-way merge (`ops.patchFile`) from what the agent last *read* (remembered per session across commands) to what it wrote, onto the live text: edits people made since are kept; if both touched the same or adjacent spot the write fails with "changed by someone else". `>>` appends at the live end.
  - `mv` is a single rename commit; `rm` commits the deletion. Only Markdown can be written; read-only repos refuse writes; directories are implicit (`mkdir` makes a session-local one).
- **`/tmp`**: private in-memory scratch space per session (16 MB, any file type). `/bin`, `/usr`, `/proc` and `/dev` are read-only (`/dev/null` works).
- **Grimoire commands** (`commands.ts`): `repos`, `save [path]`, `who <file>`, `watch [file|folder] [--timeout S]` (waits for a change; the wait doesn't count toward the time limit), `git log|show|diff|status [path]` (read-only, Markdown only; paths may be folders or deleted files), `whoami`. Language runtimes, network tools and editors print "not available" (exit 127).
- **Sessions** (`session.ts`, `ShellSessions`): keyed by actor id + session key; they keep cwd, variables (up to 64 KB) and `/tmp` between commands, and run one command at a time (at most 4 queued; more → `ShellBusyError`). Idle sessions are dropped after 30 min; at most 50 per actor and 1000 in total. Each top-level statement's output is collected as it finishes and cwd/variables are checkpointed after it, so a timed-out command still returns what ran before the cutoff and `exit N` keeps earlier `cd`s.
- **Limits:** a time limit per call (default 30 s, `timeout_seconds` up to 110 s; exit 124), counted from when the call arrives (queueing included, `watch` excluded), and a hard 110 s per call in total so HTTP requests stay under Bun's idle timeout. stdout and stderr are each cut at 200 KB with a note (`truncated`). just-bash's "hardened" limits with a few raised (commands/loops 100k). A client disconnect stops the command.
- **Front ends:** MCP (`bash` tool, session = MCP session), `POST /api/shell` (session = `session`/`X-Shell-Session`, else one default per actor), and the CLI `bin/grimoire` (calls `/api/shell`).

## MCP `/mcp` (`src/server/mcp.ts`, `McpServer`)
- Streamable HTTP, JSON responses only (no SSE).
- **Auth:** `Authorization: Bearer grim_...`, or a browser session (same CSRF rule as `/api`).
- **JSON-RPC methods:** `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Batches of up to 32 messages are supported (not containing `initialize`). GET returns 405.
- **Sessions:** a single, valid `initialize` request returns a new `Mcp-Session-Id` header and opens that session's shell. The shell sessions own the lifetime: any request with the header keeps it alive; an unknown, expired, evicted or other actor's id → 404 (the client should initialize again). `DELETE /mcp` with the header ends the session and its shell (204). Requests without the header share one default shell per actor.
- **One tool, `bash(command, timeout_seconds?)`**: runs the command in the session's shell. The text result is stdout, then `[stderr]` and stderr if non-empty, then `[exit N]` if the exit code isn't 0 (`(no output)` if all are empty). Non-zero exits are normal results; `isError: true` only for bad arguments, a busy session or internal failures. `initialize`'s `instructions` and the tool description explain the filesystem, live edits and auto-commit, the Grimoire commands and what isn't available.

## Shared server operations (`src/server/ops.ts`)
The API and the agent shell both call these, so behavior is identical:
- `createFile` (committed after the quiet period, like any edit)
- `deleteFile`
- `renameFile`
- `readFile` (live if open)
- `patchFile` (3-way merge of an agent's rewrite onto the live text; 409 on overlapping edits)
- `appendText` (insert at the live end)
- `restoreFile`
- `history`
- `diff`
- `search`

Each takes `(ctx: { store, rooms, repos }, repo: RepoRow, …, actor: Participant)`.

## Client (`src/client/`)
- `index.html` (served for `/` and `/r/*`), `app.css`, `main.ts` → `dist/main.js`. The editor's CSS is served at `/editor.css` from `src/client/editor/editor.css`.
- `provider.ts`: our own websocket provider (y-protocols), with reconnect/backoff, generation handling and control messages.
- The editor is mounted with `mountEditor(container, { ytext, awareness, readOnly })` from `src/client/editor/index.ts`.
- **URL:** `/r/<repo>/<path>`.

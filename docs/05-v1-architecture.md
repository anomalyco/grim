# V1 architecture and internal contracts

Multiplayer markdown notepad. People edit in the browser with live cursors; agents edit through MCP. Everything is stored in Git via Code Storage (or local bare repos in dev). This doc is the contract that the server, MCP, client shell, and editor are built against.

## Overview

```
Browsers ──WS /ws (Yjs sync + awareness + control)──┐
Browsers ──HTTP /api/*, SSE /api/events ─────────────┤
Agents   ──HTTP POST /mcp (MCP, bearer token) ───────┼─► Bun server ──► GitStore (Code Storage | local git)
Code Storage ──POST /webhooks/codestorage ───────────┘     ├─ RoomManager: one live Yjs room per open file
                                                           ├─ RepoService: repo registry, markdown tree, push handling
                                                           └─ SQLite: users, sessions, agent tokens, repos, crash log
```

- **Repos:** `kind = "notes"` repos are hosted only in Code Storage. The default one is `config.notesRepo` (created at startup), and people can create more. `kind = "github"` repos are Code Storage repos synced two-way with GitHub (needs the GitHub App) or copied once from a public repo (`read_only = 1`).
- **Branch:** every repo commits to its default branch (`repos.branch`).
- **Only Markdown files** (`.md`, `.markdown`, `.mdx`) are listed or opened.
- **Commits:** a room commits its file after `QUIET_MS` (15 s) without edits, on Cmd-S (control message `flush`), when an agent calls `save`, or before the room closes. The author is the main editor since the last commit; other editors become `Co-authored-by:` trailers.
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
- `src/server/events.ts`: `emit`, `sseResponse(filter)`, `notifyChange`, `waitForChange(repo, path?, timeoutMs)`.
- `src/shared/presence.ts`: `PresenceState` (awareness state shape).

## Auth (`src/server/auth.ts`)
```ts
export interface User { id: string; login: string; name: string; email: string; avatar: string | null; isAdmin: boolean; githubToken: string | null }
export function userFromRequest(req: Request): User | null                 // session cookie "np_session"
export function agentFromRequest(req: Request): { id: string; name: string } | null  // "Authorization: Bearer np_agent_..."
export function participantForUser(u: User): Participant                   // kind "human", stable color from id; email = GitHub noreply if needed
export function participantForAgent(a: { id: string; name: string }): Participant  // kind "agent", email `${slug}@agents.notepad`
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
- **Agent tokens:** `np_agent_<random>`. Only `sha256(token)` is stored. `last_used_at` is updated on use.
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
| GET `/api/repos` | | `[{ id, title, kind, ghOwner, ghName, branch, status, error, readOnly, access }]` (`access` != none) |
| POST `/api/repos` | `{ title }` → new notes repo · `{ github: "owner/name", publicReadOnly?: bool }` → link | repo |
| DELETE `/api/repos/:id` | admin only | `{ ok: true }` |
| GET `/api/repos/:id/tree` | | `{ head, files: string[] }` (Markdown paths, sorted) |
| POST `/api/repos/:id/files` | `{ path, content? }` | `{ path }`. Opens a room with `create = content ?? "# <basename>\n"`, then flushes so the file exists immediately. 409 if it already exists |
| DELETE `/api/repos/:id/files?path=` | | `{ ok }`. Commits the deletion; open room → `closeWith("deleted")` |
| POST `/api/repos/:id/rename` | `{ from, to }` | `{ path: to }`. Flushes the room, commits add+delete in one commit, open room → `closeWith("renamed", { to })` |
| GET `/api/repos/:id/history?path=&limit=` | | `[{ sha, message, authorName, authorEmail, date }]` |
| GET `/api/repos/:id/diff?sha=&path=` | | `{ diff }` (unified) |
| GET `/api/repos/:id/file?path=&ref=` | | `{ content }` at ref (default: live room text if open, else branch tip) |
| POST `/api/repos/:id/restore` | `{ path, sha }` | `{ ok }`. Replaces the live text with the file at `sha`, as a normal edit by the user (minimal diff) |
| GET `/api/repos/:id/search?q=` | | `[{ path, line, text }]` |
| GET `/api/events` | | SSE stream of `AppEvent` (`tree`, `repos`, `presence`, `saved`) for repos the user can access |
| GET/POST/DELETE `/api/agent-tokens[/:id]` | admin; POST `{ name }` | list / `{ id, token }` (shown once) / ok |
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

## MCP `POST /mcp` (`src/server/mcp.ts`)
- Streamable HTTP, JSON responses only (no SSE), stateless.
- **Auth:** `Authorization: Bearer np_agent_...`, or a browser session.
- **JSON-RPC methods:** `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Batches are supported. GET returns 405.
- **Tools** (all text results; errors as `isError: true`):
  - `list_repos()`
  - `list_files(repo)`
  - `read_file(repo, path, ref?)`: live text and `version` (sha256 of the text, first 16 hex chars).
  - `search(repo, query)`
  - `create_file(repo, path, content)`
  - `write_file(repo, path, content, expected_version?)`: a minimal-diff replace, so concurrent cursors survive.
  - `edit_file(repo, path, old_text, new_text, expected_version?)`: `old_text` must match exactly once.
  - `append_file(repo, path, text)`
  - `delete_file(repo, path)`
  - `rename_file(repo, from, to)`
  - `file_history(repo, path, limit?)`
  - `diff(repo, sha, path?)`
  - `save(repo, path)`: commit now.
  - `who_is_here(repo, path)`
  - `wait_for_change(repo, path?, since_version?, timeout_seconds ≤ 120)`
- Agent edits go through `room.agentEdit(participant, fn)`, so people see them live with the agent's named cursor.

## Shared server operations (`src/server/ops.ts`)
The API and MCP both call these, so behavior is identical:
- `createFile`
- `deleteFile`
- `renameFile`
- `readFile` (live if open)
- `writeFile` (minimal diff via `diffText`)
- `editFile`
- `appendFile`
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

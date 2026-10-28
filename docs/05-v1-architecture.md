# Grimoire V1: architecture and internal contracts

Grimoire: a multiplayer markdown notebook. People edit in the browser with live cursors; agents work in a bash shell over the same notes (through a notebook's "Share with agent" link). Everything is stored in Git via Code Storage (or local bare repos in dev). This doc is the contract that the server, MCP, client shell, and editor are built against.

## Overview

```
Browsers ──WS /ws (Yjs sync + awareness + control)──┐
Browsers ──HTTP /api/*, SSE /api/events ─────────────┤
Agents   ──HTTP GET/POST /a/<uuid> (share links) ─────────┼─► Bun server ──► GitStore (Code Storage | local git)
Code Storage ──POST /webhooks/codestorage ───────────┘     ├─ RoomManager: one live Yjs room per open file
                                                           ├─ RepoService: repo registry, markdown tree, push handling
                                                           └─ SQLite: users, sessions, share links, repos, crash log
```

- **Repos:** `kind = "notes"` repos are hosted only in Code Storage. The default one is `config.notesRepo` (created at startup), and people can create more. `kind = "github"` repos are Code Storage repos synced two-way with GitHub (needs the GitHub App) or read-only copies of a public repo (`read_only = 1`) that any signed-in user can add. Read-only copies are refreshed from GitHub every `UPSTREAM_REFRESH_MS` (5 min) and on `POST /api/repos/:id/refresh` (`store.pullUpstream`, then `onPush`). In local mode they are shallow (200 commits) partial clones (`--filter=blob:none`): a file is downloaded from GitHub when first read; listings with sizes, search and diffs download at most 200 files / 20 MB per call in batches and say when results are incomplete. A file that exists but can't be downloaded throws `StoreUnavailableError` (rooms stay open and retry on the next poll; the API answers 503), never "not found". Files over 5 MB (`MAX_FILE_BYTES`) aren't opened (`FileTooLargeError`: API 413, WebSocket close 4413). Limits: `MAX_GITHUB_REPOS` (100) read-only copies in total, `MAX_GITHUB_REPOS_PER_USER` (10) per person, two imports at a time (the rest queue). Read-only lookups never send the user's GitHub token.
- **Demo folder** (`demo.ts`): repo id `demo` (title "Demo", no owner, public) lives in a `MemoryStore` (`store/memory.ts`: per repo a chain of snapshot commits, ids = SHA-1 of the commit content, CAS on the expected head, history/diff (unified, via `store/unified.ts`)/search like Git). The server's store is a `RoutedStore` (`store/routed.ts`): `demo` → the MemoryStore, every other repo → the configured store; nothing else special-cases storage, except that `RoomManager({ ephemeral })` keeps no crash log for the demo's rooms. Seeded at startup (Welcome, Agents, `tour/…`, `images/grimoire.svg`), reset every `DEMO_RESET_HOURS` (6; `resetDemo`: reseed, then `rooms.discardRepo` closes its rooms with 1013 so clients reconnect to a new generation and reload, SSE `tree`). Limits (`demoLimits`): 1 MB per Markdown file, 2 MB per other file, 10 MB of non-Markdown, 20 MB per snapshot (`StoreFullError` "The demo is full — it resets every few hours": API 413; a room whose commit is refused keeps its text live, warns once and retries every minute), the newest 200 commits (history ends at the oldest kept). Ids of new folders always carry a random suffix, so they're never `demo`; `NOTES_REPO=demo` is refused.
- **Branch:** every repo commits to its default branch (`repos.branch`).
- **Only Markdown files** (`.md`, `.markdown`, `.mdx`) are listed or opened.
- **Commits:** a room commits its file after `QUIET_MS` (3 s) without edits, when an agent runs `save`, or before the room closes. The author is the main editor since the last commit; other editors become `Co-authored-by:` trailers.
- **Outside pushes:** a Code Storage webhook (plus a poller every `POLL_MS`) triggers `RepoService.onPush`. That refreshes the tree, emits SSE `tree`, and 3-way merges the change into open rooms.

## Existing modules (phase 1, done)
- `src/server/config.ts`: env config.
- `src/server/db.ts`: `db` (bun:sqlite) with the tables `users`, `sessions`, `repos`, `share_links`, `joined`, `app_tokens`, `room_meta`, `room_updates` (`anon_visitors`/`anon_ip_days` from a dropped guest edit limit are dropped at startup) (`agent_tokens` and `members` are dropped); `newId(prefix)`, `sha256(s)`.
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
export interface User { id: string; login: string; name: string; email: string; avatar: string | null; githubToken: string | null; emailVerified: boolean }
export function userFromRequest(req: Request): User | null                 // session cookie "np_session"
export function participantForUser(u: User): Participant                   // kind "human" (a signed-in user), stable color from id; email = GitHub noreply if needed
export function participantForAgent(a: { id: string; name: string }): Participant  // kind "agent", email `${slug}@agents.grimoire`
export async function handleAuthRoute(req: Request, url: URL): Promise<Response | null>  // /auth/* routes, else null
export const repoAccess = (repo: RepoRow): "write" | "read"              // the same for everyone: read-only copies "read"
```
- **GitHub OAuth** (`GITHUB_CLIENT_ID`/`SECRET`, works with a GitHub App's user auth):
  - `/auth/github` → GitHub; `/auth/github/callback` → upsert the user, set the cookie, redirect to `next` (passed to `/auth/github?next=`, carried in the state cookie).
  - Request the `read:user user:email` scopes. A GitHub App ignores scopes, which is fine.
  - The email is the primary verified email, or `${github_id}+${login}@users.noreply.github.com`.
- **Dev login:** `/auth/dev` (a form with a name, optional `next`) is enabled only if `ALLOW_DEV_LOGIN=1`. It always creates a new account (display name as typed, login `slug-xxxx` with a random suffix). Name-only sign-in never signs into an existing account. There are no guest accounts (`/auth/guest` is gone): see "Guests".
- **After sign-in:** `next` if it's a same-origin path under `/app` or `/start` (`safeNext`), else `/app`.
- **Logout:** `POST /auth/logout` → `/`.
- **Who may sign in:** anyone (sign-in is for identity). There are no admins (`users.is_admin` is an unused leftover column) and no first-user rule.
- **Sessions:** 30 days, cookie `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when `PUBLIC_URL` is https.
- **`repoAccess`:** every folder is public: anyone may open and edit it, guests too (`write`); read-only repos are `read`. Only `repos.owner_id` (whoever made the folder or added the GitHub copy) may remove it.
- **Google** (`google.ts`, `GOOGLE_CLIENT_ID`/`SECRET`): `/auth/google?next=` → Google (code flow, PKCE S256, state + nonce in the `np_google_state` cookie under `/auth`); `/auth/google/callback` → token exchange → id_token checked (RS256 with Google's JWKS, cached per Cache-Control and refetched on an unknown key id at most every 10 s; `iss`, `aud`, `exp`, `nonce`, `email_verified`) → if a cookie session was signed in when the flow started (its user id rides in the state cookie) and is still the same account and that account has no Google identity: the Google identity is attached to it (409 if the `google_sub` or the verified email belongs to another account) → else user by `google_sub`, else linked to an account with the same verified email, else created → session. Endpoints are overridable (`GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_JWKS_URL`, `GOOGLE_ISSUERS`) and tests inject `setGoogleFetch`.
- **Name-only sign-in** only with `ALLOW_DEV_LOGIN=1` (`devLoginEnabled()`). Signed out at any `/app` URL, the web app opens it as a guest (no account).
- **App tokens** (`tokens.ts`): `app_tokens(id, user_id, token_hash, label, created_at, last_used_at, revoked_at)`; `gmt_<random>`, only the SHA-256 is stored. `Authorization: Bearer` authenticates any `/api` route, `/mcp` and `/ws` (also `?token=`), skips the CSRF/Origin checks, and never falls back to the cookie. `/connect` (cookie session only) approves an app and redirects to its loopback URL with `token`, `token_id`, `account`, `login` + `state`. `GET /api/me` with a token adds `token: {id, label}`; `DELETE /api/tokens/:id` revokes one of the user's tokens (the app's Disconnect).
- **Workspaces** (`workspaces.ts`, contract in `docs/workspaces/SPEC.md`): `repos.owner_id`; `joined(workspace_id, user_id, via (unused), joined_at)` recorded when someone signed in opens a folder (tree or room); the switcher lists it until they leave. Older databases are migrated at startup (`db.ts`): before folders, each notebook is owned by its creator if they still exist (else nobody) and every user joins every notebook; from the private-folders era, memberships become joined entries and the `members` table is dropped, note links and viewer-only agent links are revoked, and `repos.link_access`/`domain_rule` and `share_links.kind`/`path`/`role` stay unread.
- **Participant kinds** (decided by the server from how the request authenticated, never from client data): `"human"` = a signed-in user (cookie or app token), `"guest"` = an anonymous browser visitor (`anon.ts`), `"agent"` = share links, MCP and `/api/shell`. Nobody is limited by kind; it shows in presence and in commits.
- **Agents** only exist through share links (below): a link gives access to its one notebook (`read` for read-only notebooks, else `write`) and `none` to every other repo.

## Guests (`src/server/anon.ts`)
Visitors who aren't signed in have no account and edit freely.
- **Identity:** the browser keeps `{id, name (sillyName), color}` in localStorage (`grimoire.anon.v1`). Rooms: `/ws?repo&path&anon=<id>&name=<name>&color=<#rrggbb>`. REST: `X-Grimoire-Guest: <id>`, `X-Grimoire-Guest-Name: <URL-encoded name>`, `X-Grimoire-Guest-Color`. `guestParticipant` validates them (id `[A-Za-z0-9_-]{6,40}`, name ≤ 40 letters/digits/` ._'-`; else 4401 / 401) and makes `{id: "guest:<id>", name, email: "guest@grimoire.invalid", kind: "guest"}`, whatever else the request says. A WebSocket with an app token never becomes a guest. Commits: `authorOf` → `<name> (guest) <guest@grimoire.invalid>` (rooms, renames, deletes, uploads).
- **Open to guests:** every read (`GET /api/repos` is just the default notebook; `/api/repos/:id` and its `tree`, `file`, `raw`, `history`, `diff`, `search`; `/api/events`) and, with the guest headers, `POST /api/repos/:id/files`, `DELETE …/files`, `POST …/rename`, `…/images` (rate limit per IP), `…/restore`, `…/refresh`. Same CSRF rule as signed-in requests.
- **Account only (401):** `/api/workspaces*`, `POST /api/repos` (new folder, GitHub repo), `DELETE /api/repos/:id`, `POST …/shares`, `/api/me`, `/api/tokens/*`, `/api/shell`, `/mcp`. Nothing is recorded in `joined` for guests.
- **Web client:** guests' switcher lists the folders this browser opened (`grimoire.visited.v1`); New… and Open… open the sign-in dialog ("You need to sign in to create or open folders"), as does the bottom row "Sign in" (`signin.ts`: Google / GitHub / name sign-in landing back on the note, and "Play in a scratch note instead"). `/scratch` (`scratch.ts`) is the editor on a local text in localStorage (`grimoire.scratch.v1`); `?from=<folder>/<path>` copies a note in once; nothing is sent to the server.

## Share links (`src/server/shares.ts`)
"Share with agent" links are capability URLs: `${PUBLIC_URL}/a/<uuid>` (a random v4 UUID, `crypto.randomUUID()`). Table `share_links(id, repo_id → repos ON DELETE CASCADE, label, created_by → users ON DELETE CASCADE, created_at, last_used_at, revoked_at)`; revoking sets `revoked_at`. (Older tables without the `created_by` foreign key are rebuilt at startup, keeping their rows.)
- **One link per person per folder.** The sidebar's "Share with an agent" card (pinned below the tree) has a Copy button that calls `POST /api/repos/:id/shares`, which returns the caller's active link for that folder (or creates one), and copies a ready-to-paste prompt with it. Anyone signed in may make one. **Revoke:** only the link's creator (`DELETE /api/shares/:id`; asking again then makes a new one). There is no UI for revoking.
- **Effective access** (`linkAccess`, checked on every request and again on every filesystem call): the folder's level (`read` for read-only folders, else `write`); a link whose creator was deleted is gone with them.
- **Revocation and removal take effect at once:** `revokeShare` (and `closeRepoShares` before a notebook is removed) aborts the link's running and queued commands and drops its shell sessions (`ShellSessions.closeActor("share:<uuid>")`, wired through `onShareClosed`). The shell's `AccessFn` re-reads the link and notebook on each call, and `NotesFs` asks again right before applying any write, `rm` or `mv`. A command that was stopped by a revocation answers 404.
- **`GET /a/<uuid>`** (no cookies, no CSRF): `text/plain` (`text/markdown` if `Accept` asks for it), `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. A prompt for an AI agent: what Grimoire is, the notebook's title, access level, root folder and top-level listing (capped at 25 entries), how to POST (curl with a plain-text body, a heredoc, JSON), the response shape, sessions, `X-Agent-Name`, live edits and auto-commit, examples and limits.
- **`POST /a/<uuid>`**: body (read up to 1 MB) = the command as text, or JSON `{command, session?, timeout_seconds?}` with `Content-Type: application/json` (unknown keys → 400). Without a content type or with curl's form default, a body that parses as a JSON object with a string `command` is taken as JSON too; `text/plain` is always the command. Parsing is shared with `/api/shell` (`parseShellRequest` in `shell/session.ts`). Runs in `ShellSessions` as `participantForAgent({ id: "share:<uuid>", name: X-Agent-Name (≤ 40 chars) ?? label ?? "Agent" })`: one identity per link; the name only changes how the session shows up (cursor, commits, `$USER`). The shell starts in `/workspace/<repo>` (also `$HOME`). Session key: `session` / `X-Shell-Session`, else one default per link. `req.signal` stops the command on disconnect. Response `{stdout, stderr, exitCode, cwd, truncated}`, or with `?format=text` / `Accept: text/plain` the text form (stdout, `[stderr]`, `[exit N]`, from `formatResult`) plus `X-Exit-Code`. Updates `last_used_at`.
- **Errors:** POST errors are JSON `{error}` unless text was asked for; GET errors are text. 404 unknown, revoked or malformed link, or notebook gone; 405 other methods; 409 notebook not ready; 413 body over 1 MB; 400 bad body/session/timeout; 429 over 120 calls per minute per link (GET and POST, fixed one-minute windows; `Retry-After` = seconds left in the window), more than 4 commands running or queued for the link across its sessions, or a full session queue (`ShellBusyError`). Server logs redact `/a/<uuid>`.

## HTTP API (`src/server/api.ts`, JSON, requires a session unless noted; what guests may do is listed under "Guests")
| Method & path | Body / query | Response |
|---|---|---|
| GET `/api/config` (no auth) | | `{ githubLogin: bool, googleLogin: bool, devLogin: bool, githubAppSlug: string \| null, storage: "codestorage" \| "local" }` |
| GET `/api/server` (no auth, CORS `*`) | | `{ name, publicUrl, google: bool, devLogin: bool, version }` |
| GET `/api/me` | | `User` minus `githubToken`, or 401 |
| GET `/api/repos` | | the joined folders plus the default notebook: `[{ id, title, kind, ghOwner, ghName, branch, status, error, readOnly, canRemove }]` |
| POST `/api/repos` | `{ title }` → new notes repo · `{ github: "<owner/name or github.com URL>", branch?, readOnly?: bool (default true; publicReadOnly is the old name) }` → add a GitHub repo. Read-only: any user, public repos only (checked without a token; falls back to anonymous `git ls-remote` when GitHub's API is rate limited). Editable: needs Code Storage + the GitHub App and the user's GitHub sign-in with access on GitHub (the same for everyone). The branch comes from `branch` or a `/tree/`/`/blob/` URL | repo (201), or the existing copy (200) |
| GET `/api/repos/:id` | | repo (any status) |
| POST `/api/repos/:id/refresh` | | `{ head }`. Read-only GitHub copies pull from GitHub first (at most every 10 s) |
| DELETE `/api/repos/:id` | whoever made the folder (or added the GitHub copy) (`canRemove`) | `{ ok: true }` |
| GET `/api/repos/:id/tree` | | `{ head, files: string[] }` (Markdown paths, sorted). Records the join |
| POST `/api/repos/:id/files` | `{ path, content? }` | `{ path, version }` (201). Opens a room with the content (default `"# <basename>\n"`); like any edit it is in the crash log at once and committed after the quiet period. 409 if it already exists |
| DELETE `/api/repos/:id/files?path=` | | `{ ok }`. Commits the deletion; open room → `closeWith("deleted")` |
| POST `/api/repos/:id/rename` | `{ from, to, ifUntitled? }` (`ifUntitled`: only while `from` is an untitled note, else 409; renames in a repo run one at a time) | `{ path: to }`. Flushes the room, commits add+delete in one commit, open room → `closeWith("renamed", { to })` |
| GET `/api/repos/:id/history?path=&limit=` | | `[{ sha, message, authorName, authorEmail, date }]` |
| GET `/api/repos/:id/diff?sha=&path=` | | `{ diff }` (unified) |
| GET `/api/repos/:id/file?path=&ref=` | | `{ content, version, live }` at ref (default: live room text if open, else branch tip; `live` says which) |
| GET `/api/repos/:id/raw?path=&ref=` | | an image file's bytes at ref (default: branch tip), for notes that show it. Only png/jpg/jpeg/gif/webp/svg/avif/bmp/ico (else 415), at most 10 MB (413); `..` and `.git` paths → 400. Type from the extension, `Cache-Control: private, max-age=60`, `X-Content-Type-Options: nosniff`; SVGs also get `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. Regular files only: symlinks and submodules are 404. Partial GitHub clones download the blob on first read (at most 2 downloads at a time per repo, each cut off once its pack outgrows the cap) |
| POST `/api/repos/:id/images?note=` | an image as the raw body (its file name in `?name=` or `X-Filename`, URL-encoded) or multipart form data (the first file). Not for read-only folders | `{ path, markdownPath, markdown, reused }` (201). Stored in `images/` next to the note, name kept (sanitized: last path part, no control characters or leading dots, ≤ 100 characters); another file with that name becomes `name-2.png`, `name-3.png`…; an identical file already there is reused (no commit). The type comes from the magic bytes (png jpg gif webp svg avif bmp ico; else 415; the extension is corrected to match); SVGs are stored as they are (served sandboxed). Empty → 400, over 10 MB → 413, 30 uploads a minute per person (429 + `Retry-After`). Committed at once (`Add <path>`, author = the uploader) through `GitStore.writeBlob`, before the client inserts `markdown` (`![stem](images/name.png)`, spaces, parentheses, `%<>?#` percent-encoded), so everyone sees the image as soon as the text arrives. Listings, the tree and the agent shell stay Markdown-only |
| POST `/api/repos/:id/restore` | `{ path, sha }` | `{ ok }`. Replaces the live text with the file at `sha`, as a normal edit by the user (minimal diff) |
| GET `/api/repos/:id/search?q=` | | `{ hits: [{ path, line, text }], incomplete?: string }` (`incomplete` says why matches may be missing) |
| GET `/api/events` | | SSE stream of `AppEvent` (`tree`, `repos`, `presence`, `saved`) |
| GET `/api/workspaces` | | the joined folders `[{ id, title, kind, readOnly, status, head, canRemove }]` |
| POST `/api/workspaces` | `{ title }` | the new folder's item (201); its maker owns and joins it |
| GET `/api/workspaces/:id` | | the item plus `ownerId` |
| DELETE `/api/workspaces/:id/join` | | leave (off the joined list): `{ ok: true }` |
| DELETE `/api/tokens/:id` | one of the caller's app tokens | `{ ok: true }` |
| POST `/api/repos/:id/shares` | `{ label? }` (≤ 40 chars) | `{ id, url }`: the caller's link for the folder (200), or a new one (201) |
| DELETE `/api/shares/:id` | the link's creator (others get 404) | `{ ok: true }`; the link stops working at once |
| GET/POST `/a/<uuid>` (no session) | see "Share links" | agent prompt / command result |
| POST `/api/shell` | session cookie (same CSRF rule as `/api`); `{ command, session?, timeout_seconds? }`; the session key can also come from `X-Shell-Session` | `{ stdout, stderr, exitCode, cwd, truncated? }`; 429 if the session already has too many commands queued. See "Agent shell" |
| POST `/webhooks/codestorage` (no session) | Code Storage push webhook; verified with `validateWebhook` from `@pierre/storage` and `CODE_STORAGE_WEBHOOK_SECRET` | calls `repos.onPush(repository.id)` |

Errors: `{ error: string }` with a 4xx/5xx status. Repo ids in paths are URL-encoded.

## WebSocket `/ws?repo=<id>&path=<path>` (session cookie)
- Binary messages. The first varUint is the type:
  - `0` = y-protocols sync
  - `1` = y-protocols awareness
  - `2` = control: a varString of JSON
- **Who:** a session cookie or app token (a signed-in user), or for guests the `anon`, `name`, `color` query parameters (see "Guests").
- **Server → client control messages:**
  - `{t:"hello", generation, readOnly, dirty, saving, commit, savedAt}`: the first message after connecting.
  - `{t:"status", dirty, saving, commit, savedAt}`
  - `{t:"external", commit}`: an outside change was merged in.
  - `{t:"closed", reason: "deleted" | "renamed" | "removed", to?}`
- **Client → server:** `{t:"flush"}`.
- **Generation:** if a reconnect's `hello.generation` differs from the one the client synced with before, the room was recreated. The client must throw away its document (the engine's yrs doc), create a fresh one and remount the editor. Merging the old doc into the new one would duplicate text.
- **Read-only connections:** their document updates are ignored.
- **Close codes:**
  - 4401: unauthorized
  - 4403: cross-origin
  - 4404: file not found
  - 4000: closed for a reason

## Agent shell (`src/server/shell/`)
Bash is the only interface for agents. Each shell is a [just-bash](https://www.npmjs.com/package/just-bash) interpreter (TypeScript, no processes; its defense-in-depth lockdown is on, and our filesystem runs as trusted host code) with:
- **`/workspace/<repo>/<path>`**: the Markdown files of every ready repo the actor can access (`fs.ts`: `NotesFs` is the `/workspace` mount, `ShellFs` mounts it with `/tmp` and the read-only system folders).
  - Reads see live room text, else the branch tip (cached by commit). Listings and `stat` never download files: sizes come from the store's file listing (`listFilesWithMetadata`).
  - Writes are collected while a command runs and applied when it finishes, as minimal edits through `room.agentEdit` (people see them live with the agent's cursor; a redirect's truncate-then-write is one edit). If the command times out, is cancelled or hits an execution limit, its writes are dropped.
  - A rewrite is a 3-way merge (`ops.patchFile`) from what the agent last *read* (remembered per session across commands) to what it wrote, onto the live text: edits people made since are kept; if both touched the same or adjacent spot the write fails with "changed by someone else". `>>` appends at the live end.
  - `mv` is a single rename commit; `rm` commits the deletion. Only Markdown can be written; read-only repos refuse writes; directories are implicit (`mkdir` makes a session-local one).
- **`/tmp`**: private in-memory scratch space per session (16 MB, any file type). `/bin`, `/usr`, `/proc` and `/dev` are read-only (`/dev/null` works).
- **Grimoire commands** (`commands.ts`): `repos`, `save [path]`, `who <file>`, `watch [file|folder] [--timeout S]` (waits for a change; the wait doesn't count toward the time limit), `git log|show|diff|status [path]` (read-only, Markdown only; paths may be folders or deleted files), `whoami`. Language runtimes, network tools and editors print "not available" (exit 127).
- **Sessions** (`session.ts`, `ShellSessions`): keyed by actor id + session key; they keep cwd, variables (up to 64 KB) and `/tmp` between commands, and run one command at a time (at most 4 queued; more → `ShellBusyError`). Idle sessions are dropped after 30 min; at most 50 per actor and 1000 in total. Each top-level statement's output is collected as it finishes and cwd/variables are checkpointed after it, so a timed-out command still returns what ran before the cutoff and `exit N` keeps earlier `cd`s.
- **Limits:** a time limit per call (default 30 s, `timeout_seconds` up to 110 s; exit 124), counted from when the call arrives (queueing included, `watch` excluded), and a hard 110 s per call in total so HTTP requests stay under Bun's idle timeout. stdout and stderr are each cut at 200 KB with a note (`truncated`). just-bash's "hardened" limits with a few raised (commands/loops 100k). A client disconnect stops the command.
- **Start directory:** `/workspace` by default; `ShellSessions.open/exec(..., { cwd })` sets another (share links use the notebook's folder). If the cwd disappears the shell goes back to it, else to `/workspace`.
- **Front ends:** share links `POST /a/<uuid>` (session = `session`/`X-Shell-Session`, else one default per link), the CLI `bin/grimoire` (POSTs to a share link), and for signed-in browser sessions MCP (`document_command` tool, session = MCP session) and `POST /api/shell`.

## MCP `/mcp` (`src/server/mcp.ts`, `McpServer`)
- Streamable HTTP, JSON responses only (no SSE).
- **Auth:** a signed-in browser session only (same CSRF rule as `/api`). Agent tokens were removed; agents use share links.
- **JSON-RPC methods:** `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Batches of up to 32 messages are supported (not containing `initialize`). GET returns 405.
- **Sessions:** a single, valid `initialize` request returns a new `Mcp-Session-Id` header and opens that session's shell. The shell sessions own the lifetime: any request with the header keeps it alive; an unknown, expired, evicted or other actor's id → 404 (the client should initialize again). `DELETE /mcp` with the header ends the session and its shell (204). Requests without the header share one default shell per actor.
- **One tool, `document_command(command, timeout_seconds?)`**: runs any shell command string in the session's shell. The text result is stdout, then `[stderr]` and stderr if non-empty, then `[exit N]` if the exit code isn't 0 (`(no output)` if all are empty). Non-zero exits are normal results; `isError: true` only for bad arguments, a busy session or internal failures. `initialize`'s `instructions` and the tool description explain the filesystem, live edits and auto-commit, the Grimoire commands and what isn't available.

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
- `index.html` (served for `/`, `/app`, `/app/*`, `/start` and `/scratch`), `app.css`, `main.ts` → `dist/main.js`. The editor's CSS is served at `/editor.css` from `src/client/editor-rs/editor.css`.
- **Editor engine: Rust** (`editor-core` from the grimoire-native repo, the same engine as the native Mac app, compiled to wasm by `crates/editor-wasm`). There is no other editor. The web shell is `src/client/editor-rs/`: a contenteditable div that renders the engine's line views (`render.ts`, `editor.css`), maps DOM positions to raw offsets (`offsets.ts`), sends input to the engine (`input.ts`: `beforeinput`/keys/IME/mouse/clipboard), answers its layout questions from the DOM (`layout.ts`, `geometry.ts`) and draws remote cursors (`cursors.ts`) and images (`images.ts`). In notes the engine also owns the shared document (yrs, wire-compatible with the server's Yjs) and speaks the room protocol itself (`editor-rs/collab.ts` `RustCollab`: reconnect/backoff, generation handling, control messages). Local documents (home page example, `/start`) use a plain engine on a text. Contracts and history: `docs/rust-engine/PLAN.md`.
  - **Mounting:** `mountEditor(container, { collab, readOnly, images })` for a note (its `RustCollab`, synced) or `mountEditor(container, { text, readOnly, images })` for a local document, from `src/client/editor-rs/index.ts`. `images` maps an image's source to a URL: notes use `repoImages(notePath, …)` (relative paths resolve against the note's folder and load from `/api/repos/:id/raw`); without it only http(s) and `data:image` URLs load. Test harnesses pass a `sync` (`LocalSync`, e.g. `test/editor/ymirror.ts`, a Y.Text mirror) to share a local document.
  - **When the editor can't run** (`editor-rs/fallback.ts`): if the wasm can't load (a warning in the console), the note's Markdown (`GET /api/repos/:id/file`, or the local text) is shown as plain read-only text under "The editor couldn't start. Reload to try again." and a Reload button. If the engine traps mid-session (or rejects a sync frame), the connection stops, a toast says so, the note is shown read-only (the editor's last text) with a Reload button, and the session's edits (`Engine.recover_unsent`, a Yjs update) are kept in sessionStorage (`grimoire.unsent:<repo>\0<path>`, `editor-rs/unsent.ts`). The next load of that note feeds the server's sync frames into a JS Yjs doc as well (`editor-rs/recover.ts`, its own chunk with Yjs, loaded only then), applies the kept update on top once synced and makes the resulting change as local edits (`replace_range`) in the new engine, which sends them; then the kept edits are dropped and a toast says they were restored.
  - **Loading:** `bun run build:client` (`scripts/build-client.ts`) copies `src/client/editor-rs/pkg/editor_wasm.js` and `editor_wasm_bg.wasm` (plus `.gz` copies) to `dist/editor-rs/<content hash>/` and bakes the hash into `main.js`; the server sends those files with `cache-control: immutable` (gzipped when accepted). `main.ts` starts fetching and compiling the wasm as soon as it runs, in parallel with the API calls. Measure with `bun tools/perf/note-open.mjs` (first note open, cold/warm; `THROTTLE=1`) and `bun tools/perf/keystroke.mjs` (per keystroke in a 3000-line note).
  - **Rebuilding the pkg** (never run cargo on the server box): on the machine with the Rust workspace, `cd ~/projects/grimoire-native && scripts/build-wasm.sh`, then copy `target/editor-wasm-pkg/*` into `src/client/editor-rs/pkg/` (e.g. `scp 'james@100.109.145.97:projects/grimoire-native/target/editor-wasm-pkg/*' src/client/editor-rs/pkg/`), run `bun test src/client/editor-rs test/editor`, and commit the pkg.
  - **Tests:** `bun test test/editor` (shell unit tests with happy-dom; `test/editor/rs/render-golden.json` is the DOM and offset mapping recorded from the removed TS renderer, which the shell must keep producing), `bun test/editor/browser/run.mjs` (the editor suite in Chromium; `COLLAB=1`: the engine owning a shared doc against an in-page room), `test/editor/browser/diff.mjs` (random keys in a plain vs a collab engine), `test/e2e/*.mjs` (through the real server), `tools/parity/` (Bear parity on the Mac).
- **New notes and their names** (`src/shared/untitled.ts`, same rules in the Mac app): "New note" (or a subfolder's "+") creates the first free `Untitled.md` / `Untitled N.md` in the open note's folder (or that subfolder), empty, and opens it focused. In a note whose file name is untitled, Enter (the editor's `onEnter` hook) with the caret past a first-line H1 renames it once to the heading's plain text (the Mac app's `files::heading_title`, ported exactly: links and images → their text, backslash escapes, `*` and `` ` `` (also inside a word), `~~`, `==` and `_` at a word's edge dropped; `/ \ : * ? " < > |` and control characters → spaces; spaces collapsed; no leading dots; ≤ 80 characters; `Title 2.md` when taken, case-insensitively; not when the title is itself `Untitled`/`Untitled N`; untitled = `Untitled.md` or `Untitled <digits>.md`) with `rename {ifUntitled: true}`; the renaming session reopens the new path with the same caret and scroll and a still copy of the editor until it mounts (no loading flash); collaborators follow through the room's `renamed` close.
- **Dropping and pasting images** (`editor-rs/drop.ts`, `mountEditor(..., { upload })`; notes only, not read-only): while image files are dragged over the text a drop caret (a thin accent bar at the DOM hit-tested position) shows where they'd go; dropped (or pasted with no text of their own, e.g. a screenshot), each image is uploaded (`POST /api/repos/:id/images`) while an "Uploading…" mark sits at that spot (it follows edits made meanwhile), then their Markdown, one per line, replaces [drop point] or the selection as one edit (`set_selection` + `paste`: one undo step, caret after). Other files are skipped with a toast; failed uploads say why.
- **Images** (`![alt](src "title")`): drawn below their line in a `contenteditable=false` block (`.imgs`) that holds no raw text, so the offset mapping skips it (a position in it maps to the end of the image's source). The source collapses like a marker; a line of only images shows just the images until the caret is on it, then its source line appears above them. Clicking an image puts the caret at the end of its source (double click selects it, triple click the line). Re-rendering a line moves its loaded `<img>` elements into the new line instead of reloading them. Failed or unsafe sources show an "Image not found" placeholder with the alt text. Table cells don't draw images.
- **URLs:**
  - `/`: always the home page (signed in, its call to action is **Open Grimoire →**, a link to `/app`; signed out, **View the notes** (`/app/demo`, the demo folder, as a guest) and **Sign in** (the sign-in dialog)). The demo folder shows "Demo folder — anyone can edit; it resets every few hours." above its notes; the sign-in dialog offers "Try the demo folder" elsewhere.
  - `/app`: reopens the note last opened (localStorage `grimoire.lastNote.v1`, per user) if it still exists, else the Notes notebook's default note.
  - `/app/<notebook>` (its default note), `/app/<notebook>/<path>` (a note). Opened signed out, they open as a guest (no account).
  - `/start`: the getting-started guide. `/scratch`: the scratch note. `/a/<id>`: agent share links.
  - Old `/r/<notebook>/<path>` links get a 308 to the same `/app/…` URL (query kept; the browser keeps the hash); the client also rewrites `/r/` with `replaceState`.

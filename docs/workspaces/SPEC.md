# Workspaces, switcher and sign-in — spec and coordination board

Single source of truth for this project. Every agent reads this whole file first, updates **its own row**
on the board (`doing (session)` → `done (commits)`), and appends short lines to the Log (newest last).
Small targeted edits only — other agents edit this file concurrently. Questions go under Open questions.
Rules: never touch `./data`, never restart/deploy the live server (the coordinator deploys), commit only
your own paths with `git -c user.name=opencode -c user.email=opencode@localhost commit -- <paths>`.
Rust builds only on the Mac laptop (`ssh -o BatchMode=yes james@100.109.145.97`, prefix
`export PATH="$HOME/.cargo/bin:$PATH"`), never on this Linux box (very little disk: keep temp files small).

## Owner's decisions

> **2026-10-28: privacy removed — every folder is public** (see the last Log line). Members, invites, roles, domain
> rules, link access, note links, the Share folder dialog, Settings and `SIGNIN=emails` below are history.

- **One workspace open at a time.** A switcher at the very top left of the sidebar.
- A **workspace** is one folder of Markdown notes:
  - **Local** — any directory on the Mac (Mac app only). No multiplayer, no sign-in.
  - **Remote** — a workspace hosted on a Grimoire server (multiplayer, history, agent links). Web and Mac.
- A server hosts many workspaces (today's "notebooks"/repos become workspaces; read-only GitHub repos
  become read-only workspaces).
- Web and Mac can both **add a remote workspace** by URL. The web app only has remote workspaces.
- Sign-in: **Google only** (OAuth 2.0 / OpenID Connect) for now. Servers may stay open/public.
- **The switcher lists the workspaces I've joined** (owner decision). Joined = I'm a member (owner/editor/
  viewer, incl. accepted email invites and domain-rule matches I've opened), or I opened a link-access
  workspace while signed in (recorded as a "joined" entry that grants nothing beyond the link access; I can
  "Leave" it). Not every workspace on the server.
- Coordinator decision (v1): on the **web**, joined workspaces on *this* server come from
  `GET /api/workspaces`; joined workspaces on *other* servers are remembered in localStorage and choosing
  one navigates to that server's own web app (full page load) — no cross-origin tokens on the web in v1.
  The **Mac** app talks to any server with app tokens and lists joined workspaces from each.

## Model

```
Server (one Bun process, its own SQLite)
 ├─ users          id, email (verified, lower-case), name, avatar, google_sub, created_at
 ├─ sessions       browser sign-in cookies (existing table, now tied to Google users)
 ├─ app_tokens     id, user_id, token_hash, label ("Grimoire for Mac · James's MacBook"), created_at, last_used_at, revoked_at
 ├─ workspaces     = existing repos table + columns: link_access ('none'|'view'|'edit'), domain_rule (e.g. '*@company.com=editor' or NULL), owner_id
 ├─ members        workspace_id, user_id NULL | email (invite), role ('owner'|'editor'|'viewer'), invited_by, created_at
 └─ share_links    existing agent share links + note share links: workspace_id, path NULL|note path, role ('viewer'|'editor'), kind ('agent'|'note'), created_by, expires_at, revoked_at
```

**Server sign-in policy** (env): `SIGNIN=open|emails` and `ALLOWED_EMAILS` (comma list; entries are
emails or `*@domain`). `open` keeps today's behaviour: anyone may sign in, and the legacy name-only
guest/dev sign-in remains available (ALLOW_DEV_LOGIN); every name-only or guest sign-in creates a new account
(never an existing one with that name). A signed-in account without Google that completes Google sign-in gets
that Google identity attached (refused if it or its email belongs to another account). There are **no admins**:
the policy applies to every account, with no first-user exception. `emails`: only Google-verified emails matching the
list may sign in; name-only sign-in is disabled. Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
(redirect `${PUBLIC_URL}/auth/google/callback`). With no Google credentials configured, Google sign-in is
hidden and the server behaves as today.

**Access to a workspace** = the highest of:
1. member role (owner > editor > viewer); an invite row by email becomes a membership the first time a
   user signs in with that verified email;
2. the workspace's domain rule, if the user's verified email matches;
3. a share link the request carries (note links are limited to that note + the images it embeds + its
   history; agent links as today, capped by the creator's access);
4. the workspace's `link_access` (anyone with the workspace URL; anonymous visitors get a generated guest
   name as today, `view` or `edit`).
Nothing else: no account (not the first one created) has access to every workspace. Only owners change a
workspace's settings and members or remove it; agent/note links are listed and revoked by their creator or the
workspace's owners.
`none` = 403/404. Enforced on every REST route, the WebSocket room join (read-only connections for
viewers), /raw, history/diff, the agent shell, search, and the event stream (no events about workspaces
you can't see).

**Migration of existing data:** existing notebooks → workspaces with `link_access='edit'`, owner = their
creator if still there (originally: the then admin; admins were removed on 2026-10-27, owners kept);
existing users keep working; GitHub read-only repos → workspaces with
`link_access='view'`. Nothing visible changes for current visitors of grimoire.exe.xyz.

## URLs

- Web app: `/app` (last workspace + note), `/app/<workspace>` , `/app/<workspace>/<path>` (unchanged shape).
- **Remote workspace URL** (what you paste into "Add remote workspace"): `https://<server>/app/<workspace>`
  (a URL with a note path is also accepted; the server part + workspace id are taken from it).
- Old `/r/...` redirects stay.

## API contract (server ↔ web and Mac clients)

All JSON. Auth: browser cookie (same origin) **or** `Authorization: Bearer <app token>` (Mac app).
- `GET /api/server` → `{ name, publicUrl, signin: "open"|"emails", google: boolean, devLogin: boolean, version }` (no auth).
- `GET /auth/google?next=<path>` → redirect to Google; `GET /auth/google/callback` → verify (state + PKCE + nonce; id_token checked: iss, aud, exp, email_verified) → session cookie → redirect to `next` (same-origin paths only).
- `GET /api/me` → user (existing, plus `email`, `avatar`; no admin flag).
- `GET /api/workspaces` → workspaces **I've joined** (see Owner's decisions): `[{ id, title, kind: "notes"|"github", role, linkAccess, readOnly, head, joinedVia: "member"|"domain"|"link" }]`. Opening a workspace (REST tree or room join) while signed in records the join (`joined` table: workspace_id, user_id, via, joined_at) when access comes from link access or a domain rule. `DELETE /api/workspaces/:id/join` = leave (members other than the last owner may leave too).
- `POST /api/workspaces {title}` → create (creator = owner).
- `GET /api/workspaces/:id` → details incl. `role`, `linkAccess`, `domainRule` (owner sees members).
- `PATCH /api/workspaces/:id {title?, linkAccess?, domainRule?}` (owner).
- `GET /api/workspaces/:id/members` / `POST {email, role}` (invite or change) / `DELETE /api/workspaces/:id/members/:memberId` (owner; can't remove the last owner).
- Existing per-repo routes (`/api/repos/:id/...` tree, files, history, raw, shares, rooms over WebSocket) keep working with `:id` = workspace id; they now check workspace access as above.
- **App tokens (Mac connect flow):** `GET /connect?client=<name>&redirect=<loopback url>&state=<s>` — signed-in page "Allow Grimoire for Mac to access your workspaces on <server>?" → on approve, creates an app token and redirects to `http://127.0.0.1:<port>/callback?token=…&state=…` (only loopback redirects allowed). `GET /api/tokens` / `DELETE /api/tokens/:id` to list/revoke (web settings).
- WebSocket rooms accept the app token as `Authorization` header or a `token` query param (the Mac app's WebSocket client).
- **W1 additions (implemented):**
  - `GET /api/workspaces/:id/public` (no auth) → `{ linkAccess }` (`"none"` for unknown/private). Signed out, every other `/api/*` answers 401.
  - New workspaces (`POST /api/workspaces` and the legacy `POST /api/repos {title}`) are private (`linkAccess: "none"`) unless the body says `linkAccess`. Read-only GitHub copies: `view`, owner = whoever added them. Owners may `DELETE /api/repos/:id`.
  - `GET /api/repos` (legacy) = the joined workspaces + the default notebook.
  - `GET /api/workspaces` items also carry `status`. `GET /api/workspaces/:id` → item + `domainRule, ownerId, canRemove` (+ `members` for owners). `PATCH` returns the same with `members`.
  - Member item: `{ id, userId, email, name, avatar, role, pending (invite), invitedBy, createdAt }`; `POST …/members {email, role (default editor)}` returns it. Domain rule: comma list of `pattern=role`, pattern `*@domain` or an address, role `editor|viewer`.
  - `/api/me` adds `emailVerified`; `/api/config` adds `googleLogin`, `signin`.
  - App tokens: `gmt_…`; `GET /api/tokens` → `[{ id, label, createdAt, lastUsedAt }]`. `/connect` approve → `redirect?token=…&state=…`, cancel → `redirect?error=access_denied&state=…`. Loopback = `http://127.0.0.1|localhost|[::1]` any port. `/connect` needs a cookie session (signed out it shows sign-in links that come back to it).
  - **Note share links:** `POST /api/repos/:id/shares {kind:"note", path, role?:"viewer"|"editor", label?, reuse?}` → `{id, url, kind, path, role}` (editor links need write access); `url` = `<publicUrl>/app/<ws>/<path>?share=<id>`. `GET /api/repos/:id/shares?kind=&path=` filters (items gain `kind, path, role`). Requests carry the link as `?share=<id>` (or header `X-Grimoire-Share`) on `/api/repos/:id/*` and `/ws`; with only the link: `GET /api/repos/:id` (+ `scope: {path, role, sharedBy}`), `tree` (just that note), `file`/`history`/`diff` with `path` = the note, `raw` for images the note embeds (now or at `ref`), `restore` (editor links), the room (read-only for viewer links); anything else 403. Links are capped by their creator's current access. `GET /api/note-links/:id` (no auth) → `{id, workspace:{id,title}, path, role, sharedBy, server}` or 404. No "Add to my Grimoire" for note links in v1 (a joined entry can't grant one note): `POST /api/repos/:id/join` doesn't exist → 404.
  - Fake Google provider for e2e/dev: env `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_JWKS_URL`, `GOOGLE_ISSUERS` (comma list) override Google's endpoints; tests can also `setGoogleFetch()` (src/server/google.ts).

## Clients

**Web** (`src/client/`): switcher at the top left of the sidebar (current workspace name + server host,
caret); menu: recent workspaces (this server's from `/api/workspaces` + remembered remote ones from other
servers, each with host), "Add remote workspace…" (paste URL → if same server: open; else remember and
navigate), "New workspace…", and for owners "Share workspace…" (members by email with role, link access,
domain rule) and "Settings" (app tokens list/revoke). The sidebar shows only the open workspace's tree.
Sign-in page: "Continue with Google" when configured (plus the existing name sign-in when the server is
`open`). Signed-out visitors to a private workspace see "Sign in to view this workspace" (not the
homepage); link-access workspaces keep guest auto sign-in.

**Mac** (`~/projects/grimoire-native/crates/app`): switcher top left (same layout); "Open folder…"
(native folder picker — or a text field if Rune has no picker), recent list persisted in the app's support
dir, "Add remote workspace…" (URL field) → connect flow (open the browser to `/connect` with a loopback
redirect, receive the token, store it in the macOS Keychain if easy, else a 0600 file in the support dir)
→ remote workspace: file tree via REST, notes via `crates/collab` (multiplayer, cursors) — the existing
editor-core `CollabStore`. Local workspaces work as today.

## Board

| id | task | owner paths | depends | status |
|---|---|---|---|---|
| W1 | Server: Google sign-in, sign-in policy, users/sessions, app tokens + /connect, workspaces columns + members + invites + domain rule + link access, access checks everywhere, migration, /api/server, /api/workspaces*, tests | web repo `src/server/`, `test/server/`, README/.env.example | — | done (27594c3) |
| W2 | Web client: switcher, workspace-scoped sidebar, add remote workspace, share-workspace dialog, settings (tokens), Google sign-in button, private-workspace sign-in screen; e2e | web repo `src/client/` (not editor-rs), `test/e2e/` | API contract (mock until W1 lands) | done (504faba) |
| W3 | Mac app: switcher, open folder, recents, add remote workspace + connect flow + token storage, remote workspace (REST tree + collab rooms) | laptop `crates/app`, maybe `crates/collab` | API contract (run a scratch server from the web repo on this box over Tailscale to test) | done (laptop grimoire-native 56beb0b) |
| W4 | Review (Gemini) + fixes, deploy (coordinator) | — | W1–W3 | todo |

## Open questions
- Google OAuth client for grimoire.exe.xyz: the owner must create one (Google Cloud console → OAuth client ID, Web application, redirect URI `https://grimoire.exe.xyz/auth/google/callback`) and give the coordinator the client ID/secret. Until then, everything is built and tested against a fake OAuth provider in tests.
- W2 → W1 (proposal; the web client is built against this unless W1 answers otherwise here): **note share links**. Create: `POST /api/repos/:id/shares {kind:"note", path, role:"viewer"|"editor"}` → `{id, url}` with `url` = `<publicUrl>/app/<ws>/<path>?share=<id>` (the existing SPA route; no new server route needed); `GET /api/repos/:id/shares?kind=note&path=` lists them. Info (no auth needed): `GET /api/note-links/:id` → `{id, workspace:{id,title}, path, role, sharedBy, server}` (404 when revoked/expired). Requests made under the link carry `?share=<id>` (query param, so `<img>` raw URLs and the WebSocket work too): `/api/repos/:ws/file|raw|history|diff?…&share=<id>` and `/ws?repo&path&share=<id>` (read-only connection for viewer links). `POST /api/note-links/:id/join` (signed in) = "Add to my Grimoire" (records the join). Signed-out visitors of a note link get the guest sign-in (`POST /auth/guest`) when devLogin, as for link-access workspaces. Also: the private-workspace screen needs `GET /api/workspaces/:id` (or tree) to answer 401 (signed out) vs 404 — the client calls `GET /api/workspaces/:id` signed out and treats 401 as "Sign in to view", 404 as not found; please make `GET /api/workspaces/:id` reply `{id,title,linkAccess}` without auth when linkAccess≠none so the client knows to guest-sign-in. Fake Google for e2e: tell me the env hook (e.g. `GOOGLE_FAKE=1` / an issuer URL override).

- Agent write rate limiting (later): agents are exempt from the guest edit limit; existing protections are the shell's per-link call rate (120/min), per-call timeouts and output caps; decide on write-volume limits per link/IP later.
- Guests (2026-10-28): the participant kind for signed-in users stays `"human"` on the wire (the Mac app and the wasm engine read it); in the server's docs it is "user". Rename to `"user"` later only together with the Mac app.

## Log
- 2026-10-27 coordinator: spec written; launching W1, W2, W3 in parallel.
- 2026-10-27 W1: started server work (reading code).
- 2026-10-27 W2: started web client work (reading code).
- 2026-10-27 W3: started Mac app work (reading grimoire-native).
- 2026-10-27 W2: proposed the note-share-link + signed-out workspace probe contract under Open questions (W1 please confirm/adjust there).
- 2026-10-27 W2: adapting the client to W1's in-tree API: signed-out probe = `GET /api/workspaces/:id/public`, note links = `?share=` on `/api/repos/:id/*` + `/ws`, info from `GET /api/repos/:id?share=` (`scope.path`). W1: for the note-link header please add `scope.sharedBy` (creator name) + `scope.role` to that response, and an "Add to my Grimoire" endpoint — client calls `POST /api/repos/:id/join?share=<id>` (records a joined entry for the note link; 404 → client hides the button). Client also tries `GET /api/note-links/:id` first (optional).
- 2026-10-27 W1: server API in tree (uncommitted until tests are done): see "W1 additions" in the API section — answers W2's open question (note links as proposed, `/public` probe, `/api/note-links/:id`, scope.role/sharedBy; no join for note links).
- 2026-10-27 W2: done (504faba). Web client per "Clients → Web", against W1's in-tree API (older servers without /api/server still work). "Add to my Grimoire" on a note link is client-side (this browser remembers it; the switcher lists it under "Shared with me"), since the server has no note-link join in v1. Tests: `bun test/e2e/workspaces.mjs` (fake Google: test/e2e/fake-google.mjs via the GOOGLE_*_URL env), `bun test/e2e/signin-emails.mjs`; two-users, links, rust-collab green; home-doodle fails the same way without W2's changes (server side). Both new e2e need W1's server code (uncommitted at the time). Screenshots: /tmp/opencode/workspaces/.
- 2026-10-27 W1: done (27594c3). Contract as in "W1 additions" plus: open room connections are re-checked when access changes (link access, domain rule, members, leave, link revoke): lost write → close 1013 (reconnects read-only), lost all → 4403; agent links accept `role: "viewer"`. Migration also makes every existing user joined to every existing workspace (switchers look like today's sidebar). Tests: test/server 239 pass ×2, tsc, build:client, e2e two-users/links/rust-collab/workspaces/signin-emails green (home-doodle has a stroke-count flake unrelated to the server change). Deploy: set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (redirect `${PUBLIC_URL}/auth/google/callback`); SIGNIN defaults to open, so the current env keeps working unchanged.
- 2026-10-27 W3: Mac app done (grimoire-native 56beb0b): switcher (recents, joined per server, Open folder…, Add remote workspace…), connect flow (loopback + state, token in Keychain or 0600 file), remote tree/REST notes, rooms via collab CollabEditor (cursors, read-only, reconnect). Integration run against a scratch server of W1's in-tree server: /connect, /api/server, /api/me, /api/workspaces, tree, files/rename/delete and Bearer WebSocket all worked; Mac + headless browser converged, cursors visible both ways. Snapshots: /tmp/opencode/workspaces/native/. Docs: grimoire-native docs/app.md "Workspaces".
- 2026-10-27 workspace ids: new notes workspaces get `slugify(title)-<4 random>` ids (alphabet `abcdefghjkmnpqrstuvwxyz23456789`, crypto RNG, retry on collision, `notes-xxxx` when the title slugifies to nothing), e.g. "Design" → `design-k7f3`, so addresses can't be guessed or counted; ids stay permanent on rename. Existing ids (`notes`, `gh-…`) unchanged, no migration; GitHub ids keep `gh-owner-name`. `notesRepoId()` in src/server/repos.ts; both `POST /api/repos {title}` and `POST /api/workspaces` use it. Clients must use the returned id (the web client already does).
- 2026-10-27 security: admins removed (a private workspace was visible to the server admin, and name-only sign-in could enter any existing account by typing its name, e.g. the admin's). Access comes only from members, domain rules, share links and link access; owners alone manage/remove a workspace and its members; links are listed/revoked by their creator or owners; editable GitHub links need the user's GitHub sign-in for everyone; the sign-in allowlist has no first-user exception. `/auth/dev` and `/auth/guest` always create a new account (login `name-xxxx`). Completing Google sign-in while signed in to an account without Google attaches it (409 if that Google account/email belongs to someone else). Share dialog notes that invites need Google sign-in when it's off. `users.is_admin` is kept but unread; existing owners and link access unchanged.
- 2026-10-28 QA (owner's "Loading…" forever): /connect names the approving account ("Allow Grimoire for Mac to access your workspaces on <server> as **<name>**?", "Signed in as <name> (@login or email)", "Allow as <name>") with "Not you? Sign in as someone else" (POST decision=switch: ends the browser's session, back to the signed-out page of the same request); signed out it lists Google / GitHub / name sign-in and says a name sign-in creates a new account (also on /auth/dev); no account is ever made silently. The approval redirect adds `token_id`, `account`, `login`; `GET /api/me` with an app token adds `token: {id, label}` (so apps can revoke their own token with `DELETE /api/tokens/:id`). Web: "Remove workspace" confirmation wording. Tests: google.test.ts (connect names the account / Not you / account in the redirect / me.token), e2e workspaces.mjs (remove workspace owner-only, /connect states incl. deny + bad redirect), server 260 pass ×2. Mac app (grimoire-native c894cc1): every remote failure is a page with fixes (Signed out → Reconnect, No access as <account> → Switch account / Remove, offline with backoff, not Grimoire, deleted), account per server + Switch account / Disconnect in the switcher, no Recent section, titles never empty. QA matrix: /tmp/opencode/workspaces/qa.md. Live note: grimoire.exe.xyz has no Google sign-in yet, so a browser signed out of "James" can't get back into it (name sign-in always makes a new account) — configure Google.
- 2026-10-28 wording: user-facing text calls a workspace a "folder" (owner decision): web menus/dialogs/empty states/toasts ("Add remote folder…", "New remote folder…", "Share folder…", "Leave folder", "Remove folder…", "No folders yet", "Sign in to view this folder", "No access to this folder"), /start guide, /connect page ("access your folders on <server>"), server error messages the UI shows ("folder not found", "a folder needs an owner…"), README. Tree directories are "subfolders" in user text ("Use slashes for subfolders"). Code identifiers, API paths (/api/workspaces), DB names, CSS classes, storage keys, URLs and the agent shell's /workspace path are unchanged.
- 2026-10-28 web "Open…" (owner decision; same labels as the Mac app): the switcher's "Add remote folder…", "New remote folder…" and "Add GitHub repo…" are one item, **Open…**, opening a dialog titled "Open" with a choice list on the left — section "Open": "Remote folder" (paste https://server/app/<id>[/<path>]; this server: opens it and records the join; another server: remembered and navigated to; button "Open"), "GitHub repo" (the old add-repo form; button "Add"); section "Create new": "Remote folder" (name → created on this server, private, opened; button "Create"). The Mac app also has "Folder" (local) in both sections. Esc closes, Enter submits, the chosen form's first field is focused, ↑/↓ move between choices. The empty-state "New remote folder" buttons open it at Create new. `openDialog` in src/client/workspaces.ts (`gitHubForm` in dialogs.ts); e2e workspaces.mjs drives it (screenshots /tmp/opencode/workspaces/rename/).
- 2026-10-28 privacy removed: all folders public (owner decision; privacy = host your own server). Anyone signed in opens and edits any folder (read-only GitHub copies stay read-only); a note's URL is its share link. Removed: members, email invites, roles, domain rules, link access, note share links (`?share=`, `X-Grimoire-Share`, `/api/note-links/:id`), the Share folder and Share note dialogs, "Shared with me", the private-folder sign-in screen and "No access" screen (now "No such folder"), re-checking open rooms on access changes, event filtering, `SIGNIN=emails`/`ALLOWED_EMAILS` and `ALLOWED_GITHUB_USERS` (anyone may sign in; `ALLOW_DEV_LOGIN` still gates name/guest sign-in), the per-user GitHub permission cap on editable GitHub copies, Settings (connected apps) and `GET /api/tokens`. Kept: the joined list (opening records it; × leaves, always allowed, no confirm, Undo), only `owner_id` may remove a folder, agent links (one per person per folder, `POST /api/repos/:id/shares` returns it; only its creator revokes via `DELETE /api/shares/:id`), `/connect`, bearer tokens, `GET /api/me` (+`token`), `DELETE /api/tokens/:id`. API: `/api/workspaces` items are `{id, title, kind, readOnly, status, head, canRemove}` (`GET /:id` adds `ownerId`); repo JSON drops `access` and `canShare`; `/api/server` and `/api/config` drop `signin`; `PATCH /api/workspaces/:id`, `/members*`, `/public`, `GET /api/repos/:id/shares` are gone; `POST /api/repos/:id/shares` ignores `kind`/`path`/`role`/`reuse`; version `2026-10-28.public`. Migration (db.ts, at startup): memberships → joined entries, `members` dropped, note links and viewer-only agent links revoked, `repos.link_access`/`domain_rule` and `share_links.kind`/`path`/`role` left unread.
- 2026-10-28 guests replace guest accounts (owner decision): no `/auth/guest`, no account without signing in. Signed-out visitors browse any folder/note (open REST reads + rooms) as kind "guest" with a made-up name/colour from localStorage (`/ws?…&anon=&name=&color=`); `ANON_EDIT_LIMIT` (10) edits = bursts without a `QUIET_MS` pause, per httpOnly `grimoire_anon` cookie, plus `ANON_EDITS_PER_IP_DAY` (50); over it the server refuses the change and turns the connection read-only (`{t:"anonLimit"}`), accepted edits stay; `{t:"anon", used, limit, burstMs}` after hello/new edits; `GET /api/anon`; guest commits `<name> (guest) <guest@grimoire.invalid>`. Kinds are server-decided: human (user) | guest | agent; only guests are limited — agents (share links, MCP, /api/shell) and users never. Web: hint near the limit, read-only + "Sign in to keep editing" dialog on the next attempt (Google/GitHub/name, "Play in a scratch note instead"), account-only actions prompt sign-in, bottom-left "Sign in", the agent card only signed in, guest switcher = folders visited in this browser, `/scratch` local-only editor, homepage "View the notes" + "Sign in". Mac app: unaffected (always signed in with a token; a bad token still closes 4401). Tests: test/server/anon.test.ts, e2e anon.mjs. Screenshots /tmp/opencode/anon/.
- 2026-10-28 guests edit freely (owner change, supersedes the guest edit limit above): no counting, no `ANON_EDIT_LIMIT`/`ANON_EDITS_PER_IP_DAY`, no `grimoire_anon` cookie (tables dropped at startup), no `{t:"anon"}`/`{t:"anonLimit"}`, no `/api/anon`. Guests create/rename/delete notes, restore and upload images (REST with `X-Grimoire-Guest`, `-Name` (URL-encoded), `-Color`; uploads limited per IP); commits `<name> (guest)` everywhere. Account only: folders (New…, Open…, `POST /api/repos`, `/api/workspaces*`), agent links, the account. Web: the switcher's New…/Open… open "You need to sign in to create or open folders"; the × always confirms ("Remove <folder> from your list?" — doesn't delete it, links keep working, opening a link brings it back) and the only folder in the list can't be removed ("Can't remove your only folder", New folder… / OK). Open dialog: "Remote folder" → **URL** (folder or note links; a missing note opens the folder with "No note at <path>"; other servers navigate to the exact URL) — the Mac app uses the same label.
- 2026-10-28 demo folder (owner design): repo `demo` ("Demo", no owner, public) in an in-memory `MemoryStore` behind a `RoutedStore` (demo → memory, else the configured store), seeded with a tour at startup, reset every `DEMO_RESET_HOURS` (6; open rooms discarded with 1013 → clients reload), no crash log for its rooms, limits 1 MB/note, 2 MB/image, 10 MB images, 20 MB total, last 200 commits ("The demo is full — it resets every few hours", 413). Guests edit it like everything else. Web: home "View the notes" → `/app/demo`, banner in the demo, "Try the demo folder" in the sign-in dialog. Tests: test/server/stores.test.ts (GitStore contract on local + memory, limits, routing), test/server/demo.test.ts, e2e demo.mjs. Switcher order (owner): servers by host (not pinned), folders by name (case-insensitive natural, ties by id), identical whichever folder is open.
- 2026-10-28 web: sidebar order = switcher, Filter files, New note, tree. New note creates `Untitled.md` (`Untitled N.md`) at once (no dialog; a subfolder's "+" creates inside it); an untitled note is renamed once after its first-line H1 on Enter (`src/shared/untitled.ts`; `rename {ifUntitled}`; the renamer keeps caret/scroll, collaborators follow). Same rules as the Mac app (other agent).
- 2026-10-28 web sidebar keyboard + menus + search (owner changes; the Mac app mirrors them, other agents): the tree is a roving-tabindex ARIA tree; clicking a row focuses it; the focused current row is a light blue background (18% #296d9a), the open note otherwise keeps the grey tint. Keys: Up/Down (notes open at once, focus stays), Right/Left expand/collapse/child/parent, Home/End, type-ahead, Enter (note → editor, folder → toggle), Tab/Escape → editor, ⌘⇧E (Ctrl+Shift+E) → tree. Row ⋯ / right-click: exactly "New note", "New folder" (no "+"; makes `New folder/Untitled.md`, then renames the folder in place), "Rename" (in place; folders move every file in one commit: `POST rename {folder:true}`), "Delete" (folders: `DELETE files?folder=`). The tree is never filtered: "Search files" (Ctrl+P on every platform, `src/client/filesearch.ts`) is a dialog listing full paths, ranked name prefix > name contains > path contains > words > letters in order, ≤ 200 rows; the "/" shortcut is gone, and so is the sidebar's text search.
- 2026-10-28 Open… is public (owner rule: all folders are public, opening one needs no authentication; the Mac app mirrors it): guests use the switcher's **Open…** without signing in — a folder name (this server) or a folder/note URL (any server) opens it and adds it to the browser's list (`grimoire.visited.v1`; other servers: `rememberRemote`). Only **New…** (and the Open dialog's GitHub repo tab, hidden for guests) needs an account; the sign-in line is now "You need to sign in to create folders. It's free." Supersedes "Account only: … Open…" above. e2e anon.mjs.

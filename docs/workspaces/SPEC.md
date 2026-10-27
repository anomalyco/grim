# Workspaces, switcher and sign-in — spec and coordination board

Single source of truth for this project. Every agent reads this whole file first, updates **its own row**
on the board (`doing (session)` → `done (commits)`), and appends short lines to the Log (newest last).
Small targeted edits only — other agents edit this file concurrently. Questions go under Open questions.
Rules: never touch `./data`, never restart/deploy the live server (the coordinator deploys), commit only
your own paths with `git -c user.name=opencode -c user.email=opencode@localhost commit -- <paths>`.
Rust builds only on the Mac laptop (`ssh -o BatchMode=yes james@100.109.145.97`, prefix
`export PATH="$HOME/.cargo/bin:$PATH"`), never on this Linux box (very little disk: keep temp files small).

## Owner's decisions

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
guest/dev sign-in remains available (ALLOW_DEV_LOGIN). `emails`: only Google-verified emails matching the
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
   name as today, `view` or `edit`);
5. server admin (the first user, as today) — owner of everything.
`none` = 403/404. Enforced on every REST route, the WebSocket room join (read-only connections for
viewers), /raw, history/diff, the agent shell, search, and the event stream (no events about workspaces
you can't see).

**Migration of existing data:** existing notebooks → workspaces with `link_access='edit'`, owner = the
current admin; existing users keep working; GitHub read-only repos → workspaces with
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
- `GET /api/me` → user + `{ admin }` (existing, plus `email`, `avatar`).
- `GET /api/workspaces` → workspaces **I've joined** (see Owner's decisions): `[{ id, title, kind: "notes"|"github", role, linkAccess, readOnly, head, joinedVia: "member"|"domain"|"link" }]`. Opening a workspace (REST tree or room join) while signed in records the join (`joined` table: workspace_id, user_id, via, joined_at) when access comes from link access or a domain rule. `DELETE /api/workspaces/:id/join` = leave (members other than the last owner may leave too).
- `POST /api/workspaces {title}` → create (creator = owner).
- `GET /api/workspaces/:id` → details incl. `role`, `linkAccess`, `domainRule` (owner sees members).
- `PATCH /api/workspaces/:id {title?, linkAccess?, domainRule?}` (owner).
- `GET /api/workspaces/:id/members` / `POST {email, role}` (invite or change) / `DELETE /api/workspaces/:id/members/:memberId` (owner; can't remove the last owner).
- Existing per-repo routes (`/api/repos/:id/...` tree, files, history, raw, shares, rooms over WebSocket) keep working with `:id` = workspace id; they now check workspace access as above.
- **App tokens (Mac connect flow):** `GET /connect?client=<name>&redirect=<loopback url>&state=<s>` — signed-in page "Allow Grimoire for Mac to access your workspaces on <server>?" → on approve, creates an app token and redirects to `http://127.0.0.1:<port>/callback?token=…&state=…` (only loopback redirects allowed). `GET /api/tokens` / `DELETE /api/tokens/:id` to list/revoke (web settings).
- WebSocket rooms accept the app token as `Authorization` header or a `token` query param (the Mac app's WebSocket client).

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
| W1 | Server: Google sign-in, sign-in policy, users/sessions, app tokens + /connect, workspaces columns + members + invites + domain rule + link access, access checks everywhere, migration, /api/server, /api/workspaces*, tests | web repo `src/server/`, `test/server/`, README/.env.example | — | todo |
| W2 | Web client: switcher, workspace-scoped sidebar, add remote workspace, share-workspace dialog, settings (tokens), Google sign-in button, private-workspace sign-in screen; e2e | web repo `src/client/` (not editor-rs), `test/e2e/` | API contract (mock until W1 lands) | todo |
| W3 | Mac app: switcher, open folder, recents, add remote workspace + connect flow + token storage, remote workspace (REST tree + collab rooms) | laptop `crates/app`, maybe `crates/collab` | API contract (run a scratch server from the web repo on this box over Tailscale to test) | todo |
| W4 | Review (Gemini) + fixes, deploy (coordinator) | — | W1–W3 | todo |

## Open questions
- Google OAuth client for grimoire.exe.xyz: the owner must create one (Google Cloud console → OAuth client ID, Web application, redirect URI `https://grimoire.exe.xyz/auth/google/callback`) and give the coordinator the client ID/secret. Until then, everything is built and tested against a fake OAuth provider in tests.

## Log
- 2026-10-27 coordinator: spec written; launching W1, W2, W3 in parallel.

# Grim: technical docs

How Grim is built, how to develop it and how the server and its APIs work. To use Grim, start with the [README](../README.md); to run your own server, see [Self-hosting](self-hosting.md).

The same server code runs two ways: as one Bun process (self-hosting, development, tests) and on Cloudflare Workers + Durable Objects (the hosted service at grimnotes.app). How the hosted build works is in [Grim on Cloudflare](06-cloudflare.md).

## What it does, in detail
- Open it in the browser and type: everyone in the same note sees edits and cursors live.
- The editor is a live-preview Markdown editor, built from scratch. Its engine is Rust (`editor-core`, shared with the native Mac app) compiled to WebAssembly; it also owns the note's shared document (yrs) in the browser.
- Every note is a Markdown file in a Git repo, hosted on [Code Storage](https://code.storage) or on the server's own disk ([run your own server](#run-your-own-server-no-code-storage)). Edits are committed to the repo's main branch after 3 seconds of quiet, so the full history is there.
- **New note** makes `Untitled.md` (`Untitled 2.md`, …) right away; type a first-line heading (`# Trip plans`) and press Enter, and the note is named after it (`Trip plans.md`), once.
- Drop images onto a note (or paste a screenshot): they're uploaded into the notebook (`images/` next to the note) and shown inline.
- Repos can be plain notebooks (only in the server's storage) or linked GitHub repos (two-way sync via a GitHub App; only `.md` files are shown).
- Where the server turns it on (`GITHUB_COPIES=on`; off by default, and off on grimnotes.app and staging), anyone signed in can add a public GitHub repo to browse its Markdown read-only: **Open… → GitHub repo** takes a repo URL (`/tree/<branch>` and `/blob/<branch>/<file>` URLs work too). It's refreshed from GitHub every 5 minutes. With it off the option isn't offered, and copies added earlier stay readable but are no longer refreshed. Locally these are shallow partial clones: file contents are only downloaded when read.
- Agents work on the same notes in a sandboxed bash shell and show up as participants with their own cursor. You hand one a notebook with a "Share with agent" link.
- **Sign-in is a server setting** (`SIGN_IN`, [below](#sign-in-sign_in)): off by default on a self-hosted server (no accounts at all: everything is shared, every visitor sees every workspace and may do everything), on at grimnotes.app and staging (Google sign-in, guests only read and edit).
- No account needed to look around: visitors who aren't signed in open any workspace and note as **guests**, with a made-up name on their cursor ("moist-noodle"), and edit them (see [Guests](#guests-not-signed-in)). `/scratch` is a local-only scratch note for playing with the editor.
- The **demo workspace** (`/app/demo`, where the home page's "View the notes" goes) is a playground anyone can edit, partitioned into **rooms of at most 10 people**: each room is its own copy of the demo (its own notes, edits, presence and cursors), so 1,000 visitors land in ~100 independent demos (only the demo: every other workspace takes any number of people). `/app/demo` is an alias: the client asks `POST /api/demo/room` which room is its own and uses that workspace (`demo.<room>`) for everything (REST, the workspace socket, agent links, uploads), while its links still say `/app/demo/…`, so whoever opens a shared link gets a room with space. People are counted by browser (the guest id it keeps in localStorage, or the account), not by tab: reloads and notes keep you in your room while it exists. A newcomer joins the fullest room with space, else a new one; someone who closes the page gives up their place ~30 s later, and a room nobody is in goes ~1 min after (its row and memory freed). The server enforces it: a REST call or socket on a room from someone not in it gets 409 / close 4409 when it's full, 404 / 4404 when it's gone (the clients then ask for a room again). Each room is kept only in the server's memory, starts from a short tour, and goes back to it every `DEMO_RESET_MINUTES` (default 15; the banner says "your copy resets every 15 minutes"); a restart drops every room. People in it at a reset get the tour back live: their open notes reload. Limits, per room: 1 MB per note, 2 MB per image, 10 MB of images, 20 MB in all, the last 200 commits; past them saving says "The demo is full — it resets every 15 minutes" (the configured interval). Nobody owns a room, so nobody can remove it. Design: `src/server/demo-rooms.ts` (the lobby, shared), Bun `src/server/bun/demo-rooms-bun.ts`, Workers `src/workers/demo.ts` + the HomeDO named `demo-lobby`. **It's only for people who aren't signed in:** an account never joins it (`recordJoin` refuses it; `join-many` skips it; migration `0005_demo_not_joined.sql` and Bun's startup removed existing joins), never sees it listed (`GET /api/workspaces`, MCP's `list_workspaces`), and opening `/app/demo` signed in lands in the account's own workspace. **A server without sign-in has no demo** (`POST /api/demo/room` answers 404; `/app/demo` opens the app).

## Repository layout

This is a monorepo with the histories of both original repos:

- **`/` (root): the web app and server** (Bun + TypeScript): `src/server`, `src/client`, `test`, `scripts`, `docs`. `src/client/editor-rs/pkg` is the editor engine built to WebAssembly from `native/crates/editor-wasm`.
- **`native/`: the Mac app** (Rust + [Rune](https://github.com/anomalyco/rune)), a Cargo workspace: `crates/editor-core` (the editor engine, shared with the web app), `crates/collab` (yrs), `crates/highlight`, `crates/editor-wasm` (the web build), `crates/app` (the native app). See `native/docs/`.

For now the Mac app is still developed in its own working repo (`~/projects/grimoire-native` on the Mac), and `native/` here is synced from its `main` with `scripts/sync-native.sh` (history rewritten under `native/`, merged as "Sync native"). Don't edit `native/` here until the Mac app's development moves into a grim checkout.

The Mac app builds against Rune's `dev` branch through a path dependency in `native/crates/app/Cargo.toml` (`../../../worktrees/rune-dev/crates/rune`). From this repo that path is `worktrees/rune-dev` at the repo root (ignored by Git). Clone Rune there, or symlink an existing checkout:

```bash
git clone -b dev https://github.com/anomalyco/rune.git worktrees/rune-dev
# or: ln -s ~/projects/worktrees worktrees
cd native && cargo build -p grimoire
```

## Run

```bash
bun install
cp .env.example .env    # pick STORAGE and fill in its settings (see below)
bun run start           # builds the client and starts the server on $PORT (default 8787)
```

For local development without a Google client:
```bash
ALLOW_DEV_LOGIN=1 bun run dev
```
Without `SIGN_IN` that's a server with no accounts (everyone may do everything). `SIGN_IN=on ALLOW_DEV_LOGIN=1 bun run dev` has accounts through the **test sign-in**: `POST /auth/dev` (or the bare form at `/auth/dev`) with a name makes a new account and signs this browser in. It has no link or button anywhere in the app, it counts as a sign-in method for the `SIGN_IN=on` startup check, it's what the tests use, and the server ignores it unless `PUBLIC_URL` is plain `http://`, so it can never be on at an https deployment.

### Development commands (`package.json`)
| Command | What it does |
| --- | --- |
| `bun run dev` | Rebuilds the client on change (`scripts/build-client.ts --watch`) and restarts the server on change (`bun --watch src/server/index.ts`). |
| `bun run start` | Builds the client once, then runs the server. |
| `bun run build:client` | Builds the browser app into `dist/` (plus gzip copies and the static-hosting files; see `src/server/assets.ts`). |
| `bun test` | The server and editor-shell tests (`test/`; `bunfig.toml` preloads `test/preload.ts`, and test servers refuse any storage but `STORAGE=local`). |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run test:workers`, `bun run check:workers`, `bun run dev:workers` | The Cloudflare Workers build (`src/workers/`, `wrangler.jsonc`): its tests (Miniflare), its type and bundle check, and a local `wrangler dev`. See [Running and testing the Workers build](06-cloudflare.md#running-and-testing-the-workers-build). |

Browser suites: `test/editor/browser/run.mjs` (the editor) and `test/e2e/*.mjs` (browsers and an agent through the real server).

### Deploying
- **Hosted (Cloudflare):** see [Deploying](06-cloudflare.md#deploying) in the Cloudflare doc (wrangler environments, secrets, D1 migrations).
- `scripts/deploy-exe.sh [vm-host]`: syncs the checkout to an exe.dev VM, runs `bun install` and the client build there, installs the `grimoire` systemd unit (env file `/etc/grimoire/grimoire.env`) and restarts it. Secrets stay on the VM in `/etc/grimoire/`.
- `scripts/start-live.sh`: (re)starts a server in the background with the settings in `~/.config/grimoire/live.env` (or `$GRIMOIRE_ENV`), logging to `$DATA_DIR/server.log`.
- `scripts/sync-native.sh`: merges the Mac app's repo into `native/` (see [Repository layout](#repository-layout)).
- For your own server, follow [Self-hosting](self-hosting.md).

### Production settings (`.env`)
- **Code Storage** (`STORAGE=codestorage`; for a server without it see [Run your own server](#run-your-own-server-no-code-storage)):
  - Set `CODE_STORAGE_ORG` and `CODE_STORAGE_PRIVATE_KEY_FILE` (the private key from the org's Keys page).
  - Commits made outside Grim (pushes straight to Code Storage) aren't picked up while a note is open; a commit that meets a moved head still merges it in. (The Code Storage webhook sync is gone.)
- **GitHub App:**
  - Used for "Sign in with GitHub" and for repo sync. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_APP_SLUG`.
  - Callback URL: `$PUBLIC_URL/auth/github/callback`.
  - Permissions: Contents read & write, Metadata read.
  - GitHub's webhook URL for the app: `https://<org>.code.storage/webhooks/github`.
  - Register the app with Code Storage.
- **Behind a reverse proxy:** `X-Forwarded-For/-Proto/-Host` are only believed from `TRUSTED_PROXIES` (comma-separated IPs or CIDRs; default `127.0.0.0/8,::1`, which fits exe.dev, whose proxy connects from loopback on the VM; `none` trusts no one).
- **Google sign-in:**
  - In the [Google Cloud console](https://console.cloud.google.com/apis/credentials): configure the OAuth consent screen (External; scopes `openid`, `email`, `profile`), then **Create credentials → OAuth client ID → Web application**.
  - Authorized redirect URI: `$PUBLIC_URL/auth/google/callback` (e.g. `https://grimoire.example.com/auth/google/callback`). No JavaScript origins are needed.
  - Put the client ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (or `GOOGLE_CLIENT_SECRET_FILE`). Without them, "Continue with Google" is hidden.
  - The server uses the authorization code flow with PKCE, state and nonce, and checks the id_token's signature (Google's keys, cached), issuer, audience, expiry and `email_verified`.
- <a id="sign-in-sign_in"></a>**Sign-in (`SIGN_IN`):** one setting, `off` (the default when unset) or `on`.
  - `off`: **no accounts at all, and everything is shared**, as if everyone were one built-in user. No sign-in UI anywhere (no Sign in button, prompts or account menu; `/api/server` says `signIn: false`; `/auth/*` and `/oauth/*` GETs go home or 404; `/api/me` (including deleting an account) and `/api/tokens` 404). `GET /api/workspaces` lists **every workspace on the server** for everyone (the web, the Mac app and MCP's `list_workspaces`); there are no per-person lists and no "only its maker may remove it": anyone may create, rename, delete and remove workspaces, notes and folders, upload, add GitHub copies and make agent links. There's no demo. Ownership and lists belong to one built-in `users` row, `local` (`visitorUser` in `auth.ts`); visitors keep only how others see them: the guest identity their browser or app sends (the `X-Grimoire-Guest` headers, the rooms' `anon`/`name`/`color`; requests without one are "Visitor"), so cursors, presence and commits (`<name> (guest)`) still tell people apart. Names change with **Change name…**. `/mcp` needs no authorization. Older servers' per-visitor `guest:<id>` users and joins are left in the database and ignored. Sessions and app tokens are ignored. Per-IP limits stay. Cross-origin browser requests are still refused. **Keep such a server private** ([Self-hosting](self-hosting.md#sign-in)).
  - `on`: accounts through Google (GitHub too where configured); guests read and edit only. The server refuses to start without a sign-in method (`signInProblem`: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, or GitHub sign-in; the plain-http test sign-in counts for tests): Bun exits with the error, a Worker answers every request with it (500) and logs it.
  - Named `SIGN_IN` (rather than e.g. `REQUIRE_SIGN_IN`) because it switches the feature itself: with it on, signing in is still optional for reading and editing.
- **Landing after sign-in:** an account opens its own workspace: its first joined one, else one it made, else a new "<First name>'s notes" ("My notes" without a name) with a short welcome README, made on the spot (`POST /api/workspaces/personal`, idempotent; the web calls it when the account has no workspace to open, the Mac app after signing in with nothing open or instead of the demo).
- **Who can sign in** (`SIGN_IN=on`): anyone with a Google account (sign-in is for identity, not privacy), or a GitHub account on self-hosted servers that configure GitHub sign-in. The old name-only sign-in is gone (2026-10-29); accounts made with it keep their sessions until those expire (30 days), and a test sign-in (`ALLOW_DEV_LOGIN=1`, plain-http servers only, no UI) makes such accounts for tests. There are no admins. Nobody gets an account without signing in: visitors who don't are guests (below).
  - Someone signed in to an old name-only account can add Google to it once: completing "Continue with Google" while signed in links that Google account to the current one (refused if that Google account or its email already belongs to another account).
- **Workspaces** (notebooks and GitHub copies, one Git repo each; directories inside one are its **folders**) are **public by link**: anyone with a workspace's URL can open and edit it, signed in or not (read-only GitHub copies stay read-only), and a note's URL is its share link. New workspace ids are a short slug of the title (at most 24 characters) and 12 random characters (`design-k7f3m2q9xbtw`, ~59 bits from a 31-letter alphabet, drawn without modulo bias: `notesRepoId` in `repos.ts`), so on a hosted server an address can't be guessed; older workspaces keep their shorter ids, read-only GitHub copies are `gh-<owner>-<repo>` (public anyway) and demo rooms `demo.<room>`. Opening a folder adds it to your switcher (the "joined" list); × takes it off. Only whoever made a folder (or added the GitHub copy) may remove it (with sign-in off: anyone). There's no default notebook: a new server starts empty ("Start a workspace", New workspace). **Want privacy? [Run your own server](#run-your-own-server-no-code-storage)** (on your own machine or behind your own network).
- **Apps** (Grim for Mac) sign in through the browser (RFC 8252): `GET /auth/google/start?client&redirect_uri=http://127.0.0.1:<port>/callback&state&code_challenge` goes to Google, the app receives a one-time code on its loopback redirect and exchanges it with its PKCE verifier at `POST /auth/token` for an app token. Tokens are stored hashed and stop working after 90 days unused; `GET /api/me` with a token names it (`token: {id, label}`) and `DELETE /api/tokens/:id` revokes it (the app's Disconnect). Apps send them as `Authorization: Bearer <token>` (WebSockets also as `?token=`).
- **Agents:** connect a whole account with MCP (`$PUBLIC_URL/mcp`, see [MCP](#mcp)), or hand one workspace to an agent with its "Share with agent" link (see [Agents](#agents)).

### Guests (not signed in)
With `SIGN_IN=on` (with it off, everything is shared: every visitor sees every workspace and may do everything, and the bottom row is its name with Change name…):
- A visitor who isn't signed in has **no account**. The browser picks a made-up name and colour (kept in localStorage) that others see on their cursor and in the participants list (marked "guest"). The sidebar's bottom row just says **Sign in**; the "Share with an agent" card isn't shown.
- Guests read and **edit** existing notes (live) and restore versions; creating, renaming and deleting notes and folders and adding images need an account ("Sign in to …"), except in the demo. Their commits are authored `<name> (guest) <guest@grimoire.invalid>`. The web app sends their name with REST calls (`X-Grimoire-Guest`, `X-Grimoire-Guest-Name`, `X-Grimoire-Guest-Color`) and rooms (`/ws?…&anon=&name=&color=`). Image uploads are rate-limited per IP for guests.
- Guests **open any workspace** too (all workspaces are public): the switcher's **Open…** takes a workspace's name or a link to a workspace or note, opens it and adds it to the workspaces remembered in this browser. Only **creating workspaces** (the switcher's New…, and adding a GitHub repo), agent links and the account need an account: the app opens a sign-in dialog (the server's sign-in methods, landing back on the same note, plus "Play in a scratch note instead": `/scratch?from=<folder>/<note>`, a copy that stays in the browser).

### Run your own server (no Code Storage)
With `STORAGE=local` the server needs no outside accounts: each workspace is a bare Git repo on the server's own disk, `$DATA_DIR/git/<workspace-id>.git`, next to the SQLite database `$DATA_DIR/grimoire.sqlite`. Full history, live editing, agents and read-only GitHub copies all work as usual. The [self-hosting guide](self-hosting.md) covers it end to end: the quick start, every setting, storage, sign-in, systemd, HTTPS behind Caddy, the Mac app and agents, backups, upgrades and troubleshooting.

## Agents
Agents get one interface: a bash shell whose filesystem is the live notes of one notebook.
- At the bottom of the sidebar, **Share with an agent → Share** opens "Share with an agent" (`shareDialog` in `src/client/dialogs.ts`; the Mac app's matches). **This workspace:** **Copy prompt** copies a ready-to-paste prompt with your link for the open workspace (the link is shown too, with its own Copy), `$PUBLIC_URL/a/<uuid>` (one per person per workspace: made the first time, the same one after that; `POST /api/workspace/:id/agent-link` → `{url}`). Paste it to your agent. **All your workspaces (MCP):** the server's `$PUBLIC_URL/mcp` with its own Copy, **Copy prompt** (asks the agent to add it to its MCP configuration; on a server without sign-in it says no sign-in is needed) and a collapsed "opencode config" (its `opencode.json` entry; other clients [below](#connect-an-mcp-client)). Guests don't see the card. Whoever has the link can use that folder and nothing else (read-only folders stay read-only). Removing the folder, or the account that made the link, removes it.
- The app has no screen for managing links; `DELETE /api/shares/<uuid>` revokes yours (only its creator can; the uuid is the link's last part), and asking again makes a new one. Revoking stops whatever the agent is running right away.
- A `GET` on the link returns plain-text instructions for the agent (what's in the notebook, how to call it, examples, limits).
- Agents call the link over plain HTTP (curl); there's no client to install. `POST` runs a command. The body is the command as plain text, or JSON `{"command", "session"?, "timeout_seconds"?}`; the response is `{stdout, stderr, exitCode, cwd, truncated}` (or plain text with `?format=text` / `Accept: text/plain`: stdout, `[stderr]` and stderr, `[exit N]`, with `X-Exit-Code` and `X-Cwd` headers). `X-Agent-Name` sets the name on the agent's cursor and commits (default "Agent"); it's still one agent per link. Calls share one session (cwd, variables, `/tmp`, so a `cd` carries over) unless they send `session` or `X-Shell-Session`.
  ```bash
  curl -s -X POST --data-binary 'grep -rn TODO .' "$LINK?format=text"
  curl -s -X POST -H 'X-Agent-Name: Claude' -H 'content-type: application/json' -d '{"command": "cd ideas && ls", "session": "work", "timeout_seconds": 60}' "$LINK"
  curl -s -X POST --data-binary @- "$LINK?format=text" <<'CMD'      # write a file: a quoted heredoc inside a quoted heredoc
  cat > ideas/new.md <<'EOF'
  # New note
  EOF
  save
  CMD
  ```
- The shell starts in the notebook's directory, `/workspace/<repo>`; `/tmp` is private scratch space.
- Writes show up live in people's editors (with the agent's cursor). A rewrite keeps edits people made since the agent read the file (or fails if they touched the same spot).
- **Agent commits are kept apart from people's.** The notes a command wrote are committed right after it, on the agent's own commit (author `<agent name> <slug@agents.grimoire>`; `save` is rarely needed now). Before an agent writes into a note, people's unsaved edits there are committed first as their own commit (`Room.settle`); the note's text right after the write is pinned (`Room.pin`) and that exact text is committed as the agent's (`Room.commitPinned`), so whatever people type meanwhile stays pending and gets a manual commit of its own after the quiet period. (If the note changed upstream in between, or the store keeps refusing, the normal quiet commit takes over.) Renames and deletes by agents commit people's pending edits first, as before.
- **`changes`** (`changes`, `changes <path>`, `changes --stat`; `src/server/changes.ts`): what **people** wrote by hand since the newest agent commit (any agent: link or MCP; agent commits are the ones whose author email ends in `@agents.grimoire`), from that commit to the current text, unsaved live edits included. A header ("Manual changes since the last agent commit <sha> (<agent>, <when>):"), the files with status (A/M/D/R) and +/- counts, then unified diffs, cut at 200 KB ("narrow it with `changes <path>`"). With no agent commit yet: "No agent commit yet; showing all manual changes" (everything since the first commit). Over HTTP: `GET <link>/changes[?path=…]` → `{since: {commit, agent, at} | null, files: [{path, status: "added"|"modified"|"deleted"|"renamed", from?, added, removed, diff}], truncated}` (the link's access rules and rate limit). It looks back over the last 300 commits for the agent commit.
- Extra commands: `repos`, `changes [--stat] [path]`, `save [path]`, `who <file>`, `watch [path] [--timeout S]`, and read-only `git log|show|diff|status`.
- Standard tools work (`ls cat grep sed awk find jq diff ...`). There's no python, node or network.
- Limits: 110 s per call (30 s by default), 200 KB of output per stream, 1 MB request bodies, 120 calls per minute and 4 commands at a time per link.

## MCP
`$PUBLIC_URL/mcp` (the bare path, `src/server/mcp.ts`) is the account's [MCP](https://modelcontextprotocol.io) server: one connection works across all of the person's workspaces. Transport: Streamable HTTP (`POST` JSON-RPC, JSON answers, no SSE stream; `DELETE` ends a session). Agents see three tools:
- **`list_workspaces`**: the caller's workspaces (the ones they've joined; on a server without sign-in, every workspace): `id`, `title`, `access` (`read`/`write`), `kind`, `status`, `notes` (count) and `url`.
- **`changes`** `{workspace, path?}`: what people wrote by hand in a workspace since the last agent commit (the shell's `changes`, same text), with the JSON (as `GET <link>/changes`) as `structuredContent`. Read-only; the same access checks and rate limit as `command`.
- **`command`** `{workspace, command, session?, timeout_seconds?}`: a shell script in one workspace, in the same sandboxed shell as agent links (it starts in `/workspace/<id>`, sees only that workspace, writes live with the agent's cursor and commits as the agent link does; read-only stays read-only). Any workspace the caller can open works, joined or not (they're public by URL). Limits per caller and workspace, as per link: 120 calls a minute, 4 commands at a time; sessions (cwd, variables, `/tmp`) per MCP connection, workspace and `session`.

The agent's cursor and commits carry the MCP client's name (`clientInfo.title`, else `name`; "MCP agent" without one). The server's `instructions` teach the shell (the agent link's text, shared in `shares.ts`).

**Authorization** (the MCP spec's OAuth 2.1; `src/server/oauth.ts`), with `SIGN_IN=on`:
1. A request without a token gets `401` with `WWW-Authenticate: Bearer resource_metadata="$PUBLIC_URL/.well-known/oauth-protected-resource"`.
2. `GET /.well-known/oauth-protected-resource` (also `…/mcp`) names the resource (`$PUBLIC_URL/mcp`) and this server as its authorization server; `GET /.well-known/oauth-authorization-server` lists `authorization_endpoint` (`/oauth/authorize`), `token_endpoint` (`/oauth/token`), `registration_endpoint` (`/oauth/register`), `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code"]`, `token_endpoint_auth_methods_supported: ["none"]`.
3. `POST /oauth/register` (dynamic client registration, RFC 7591): public clients only. Redirect URIs may be https (`https://claude.ai/api/mcp/auth_callback`), http on a loopback address (`http://127.0.0.1:<port>/callback`, `http://localhost:<port>/…`; any port is accepted later, RFC 8252 §7.3) or a private-use scheme (`cursor://…`). Nothing is stored: the client id carries the client's name and redirect URIs (`gmc_…`). The authorize step only ever redirects to a registered URI (exact match, loopback port aside); anything else shows an error page instead of redirecting.
4. `GET /oauth/authorize` (authorization code + PKCE S256 required; `resource`, RFC 8707, must be `$PUBLIC_URL/mcp` if sent): signed out, it sends the person through the usual sign-in (Google) and back; signed in, it shows a consent page, "Allow <client> to access your Grim workspaces?", with the client's name, where it sends you back to and "Signed in as <email>". Only **Allow** (a same-origin `POST /oauth/authorize`) issues a one-time code (60 s, single use; the same table as the Mac app's codes); Cancel sends `error=access_denied`.
5. `POST /oauth/token` `grant_type=authorization_code&code&code_verifier` → `{access_token, token_type: "Bearer", scope}`. The token is an app token (hashed, 90-day idle expiry, revocable) **bound to `/mcp`** (`app_tokens.audience = 'mcp'`, migration 0007): the API and the sockets refuse it, so an MCP client can't act as the person anywhere else. No refresh tokens: after 90 days unused the client signs in again.
- A plain app token (the Mac app's, no audience) works at `/mcp` too.
- Signing out or switching accounts in the web app ends browser sessions only; MCP tokens keep working until revoked or 90 days unused. **To disconnect an MCP client:** its token is listed with the account's app tokens, labelled "<client> (MCP)". There's no screen yet: revoke it with `DELETE /api/tokens/<id>` (signed in; the id from the database), or in the database: `UPDATE app_tokens SET revoked_at = <ms> WHERE user_id = '<account>' AND label LIKE '% (MCP)'` (on Workers: `wrangler d1 execute grim --remote --command "…"`; a revoked token may work up to 60 s longer in other Worker isolates, the auth cache).
- With `SIGN_IN=off` there are no accounts: `/mcp` works **without authorization**, as the built-in local user, across every workspace on the server (`list_workspaces` lists them all), and the `/.well-known/oauth-*` and `/oauth/*` endpoints answer 404. Browsers may call it only from the server's own origin. Keep such a server private.
- On Workers, `/mcp` runs in the caller's `ShellDO` ("user:<id>"), so one object sees all of a person's calls (strict limits) and sessions survive evictions.

### Connect an MCP client
Use `https://grimnotes.app/mcp` (or your server's `$PUBLIC_URL/mcp`). The client discovers the sign-in by itself: a browser opens, you sign in with Google if needed and allow the client.

- **Claude Code:** `claude mcp add --transport http grim https://grimnotes.app/mcp`, then `/mcp` in Claude Code to sign in.
- **Claude Desktop / claude.ai:** Settings → Connectors → Add custom connector, URL `https://grimnotes.app/mcp`. (Claude Desktop's `claude_desktop_config.json` only starts local servers; for it through a bridge: `{"mcpServers": {"grim": {"command": "npx", "args": ["-y", "mcp-remote", "https://grimnotes.app/mcp"]}}}`.)
- **Cursor** (`~/.cursor/mcp.json`): `{"mcpServers": {"grim": {"url": "https://grimnotes.app/mcp"}}}`
- **opencode** (`opencode.json`): `{"mcp": {"grim": {"type": "remote", "url": "https://grimnotes.app/mcp"}}}`, then `opencode mcp auth grim`.
- Anything else: Streamable HTTP at that URL, OAuth as above, or `Authorization: Bearer <app token>`.

## HTTP API
All JSON. Writes need the same origin, a JSON body or a bearer token (CSRF). "Anyone": signed in or not (guests send `X-Grimoire-Guest`, `-Name`, `-Color`); with `SIGN_IN=off` every visitor may do what an account may.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/server` | anyone | `{name, signIn, marketing, googleLogin, githubLogin, githubAppSlug, githubCopies, demoResetMinutes, ws}` (`githubCopies: false`: adding GitHub repos is off, `GITHUB_COPIES`; clients don't offer it): the one boot request (preloaded by the HTML) and the apps' "is this Grim?" probe |
| `GET /api/me`, `PATCH /api/me {name}` | account | the account; renaming |
| `DELETE /api/me` | account (cookie or app token, not an MCP token) | delete my account ([Deleting your account](accounts.md#deleting-your-account)): sessions and app tokens, my agent links, my list, the workspaces I made, me → `{ok, deletedWorkspaces, failedWorkspaces}`, clearing the cookie (404 with sign-in off) |
| `DELETE /api/tokens/:id` | account | revoke one of my app tokens (Mac Disconnect, MCP clients) |
| `GET /api/workspaces` | account (sign-in off: anyone) | my workspaces (with sign-in off: all of them), each a **Workspace** |
| `POST /api/workspaces {title}` / `{github, branch?, readOnly?}` | account | a new notes workspace (201), or a GitHub copy (read-only; may be importing; an existing copy 200). With `GITHUB_COPIES` off, `{github}` is 403 "Adding GitHub repos is turned off on this server" |
| `POST /api/workspaces/personal` | account | my landing workspace (made the first time; 404 with sign-in off) |
| `POST /api/workspaces/join-many {ids}` | account | add up to 200 ids to my list → `{joined, missing}` |
| `POST /api/demo/room` | guest | my demo room → `{workspace, resetMinutes}` (404 with sign-in off) |
| `GET /api/workspace/:id` | anyone | the **Workspace** |
| `DELETE /api/workspace/:id` | its maker (sign-in off: anyone) | remove it (its agent links go too) |
| `DELETE /api/workspace/:id/join` | account | leave (off my list) |
| `GET /api/workspace/:id/tree` | anyone | `{head, files}`, with an ETag (304); opening records the join |
| `GET /api/workspace/:id/file?path=&ref=` | anyone | `{content, version, live}` (live, or at a commit) |
| `GET /api/workspace/:id/raw?path=&ref=` | anyone | an image's bytes |
| `GET /api/workspace/:id/history?path=&limit=` | anyone | commits, newest first |
| `GET /api/workspace/:id/diff?sha=&path=` | anyone | `{diff}` |
| `GET /api/workspace/:id/search?q=` | anyone | full-text hits (no client uses it) |
| `POST /api/workspace/:id/files {path, content?}` | account, or guests where `guestCreate` | a new note |
| `DELETE /api/workspace/:id/files?path=` / `?folder=` | account, or guests where `guestCreate` | delete a note / a folder |
| `POST /api/workspace/:id/rename {from, to, folder?, ifUntitled?}` | account, or guests where `guestCreate` | rename a note or folder |
| `POST /api/workspace/:id/restore {path, sha}` | anyone | a note back to a version |
| `POST /api/workspace/:id/images?note=&name=` | account, or guests where `guestCreate` | upload an image (raw body) → `{path, markdownPath, markdown}` |
| `POST /api/workspace/:id/refresh` | account | pull a GitHub copy now (no client uses it; the cron refreshes). 403 for GitHub copies with `GITHUB_COPIES` off |
| `POST /api/workspace/:id/agent-link` | account | my agent link → `{url}` (201 when made) |
| `DELETE /api/shares/<uuid>` | its creator | revoke an agent link |
| `GET/POST /a/<uuid>` | the link | agent instructions / run a command ([Agents](#agents)) |
| `GET /a/<uuid>/changes?path=` | the link | what people changed since the last agent commit, JSON ([Agents](#agents)) |
| `POST/DELETE /mcp` | an MCP token or app token (sign-in off: anyone) | [MCP](#mcp) |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token` | | MCP's OAuth ([MCP](#mcp)) |
| `GET /ws?repo=<id>` | cookie, bearer or guest query | the workspace socket (protocol v2, [docs/07](07-workspace-socket.md)); `&path=` is the older per-note socket |
| `/auth/google`, `/auth/google/start`, `/auth/google/callback`, `/auth/token`, `/auth/logout`, `/auth/github*`, `/auth/dev` (test hook) | | sign-in |

### Fetch any note as Markdown
The app's note URLs negotiate (`src/server/note-url.ts`): `curl https://grimnotes.app/app/<workspace>/<note>` returns the note itself, while a browser at the same URL gets the app.
```bash
curl -s https://grimnotes.app/app/<workspace>/ideas/plan.md   # the Markdown (live: unsaved edits included); ideas/plan works too (.md added)
curl -s https://grimnotes.app/app/<workspace>/ideas           # a folder: its notes, one path per line (the workspace alone: all of them)
curl -s https://grimnotes.app/app/<workspace>/images/a.png    # an image: its bytes, served like /raw (nosniff, sandboxed SVG)
```
- A request whose `Accept` names `text/html` (every browser navigation) gets the app's HTML as before; anything else (curl's `*/*`, `text/markdown`, `text/plain`) gets `text/markdown; charset=utf-8` (folders `text/plain`), with `Vary: Accept` and `Cache-Control: no-store`. `?raw=1` asks for the note even from a browser.
- Exactly what `GET /api/workspace/:id/file`, `/tree` and `/raw` give anyone (no sign-in needed; nothing more). A missing note or workspace is a plain-text 404 (`Not found: <path>`); other files 404. `/app/<workspace>` alone lists the whole workspace; `/app` is always the app.
- The demo (`/app/demo/…`) has no fixed notes (each browser gets a room of its own), so it answers a 404 with a short explanation; no room is made.
- On Workers, `/app/*` runs the Worker first (`run_worker_first`): browsers get `index.html` from the assets binding (`_headers` caching as before), everything else the note.

**Workspace** = `{id, title, kind: "notes"|"github", ghOwner, ghName, branch, status: "ready"|"importing"|"error", error, readOnly, canRemove, guestCreate}`. There are no `/api/repos`, `/api/config`, `/api/events`, `/api/shell` or `/webhooks/codestorage` routes any more.

## Layout
- `src/server/`: the server, shared by the Bun entry and the Workers build.
  - `index.ts`: the Bun entry: `Bun.serve`, WebSockets and wiring. `app.ts`: the router (`createApp`), also used by the Worker.
  - `seams/`: the interfaces that differ between Bun and Workers (`Db`, `RoomStorage`, `WorkspaceHost`, `EventBus`); `bun/`: their Bun implementations. See [the seams](06-cloudflare.md#the-seams-bun-vs-workers).
  - `workspace.ts`: `WorkspaceRuntime`, one workspace's operations, rooms, tree cache and heads (a `Map` of them on Bun, one per Durable Object on Workers).
  - `room.ts`, `rooms.ts`: live Yjs rooms (`Room`) and their manager. Each room has a crash-safe log, does a 3-way merge of outside pushes, and commits after a quiet period.
  - `store/`: Code Storage and local Git backends, the in-memory store (`memory.ts`, the demo workspace's), `routed.ts` (the server's store: each demo room → its own memory store, everything else → the configured backend) and `cached-head.ts` (branch heads cached in front of it).
  - `demo.ts`: the demo's seed, resets, limits and room rows; `demo-rooms.ts`: its rooms (≤ 10 people each) and the lobby that hands them out and admits every call; `bun/demo-rooms-bun.ts`: Bun's lobby and room stores.
  - `ops.ts`: file operations shared by the API and the agent shell (they call the workspace's runtime through the `WorkspaceHost`).
  - `shell/`: the agent shell (a just-bash interpreter over the live notes) and its sessions.
  - `shares.ts`: "Share with agent" links (`/a/<uuid>`): the agent prompt and command endpoint.
  - `mcp.ts`: the account's MCP server at `/mcp` (`list_workspaces`, `command`); `oauth.ts`: its OAuth 2.1 (metadata, registration, consent, tokens bound to `/mcp`).
  - `anon.ts`: guests (visitors who aren't signed in): the guest participant from the room query or the REST headers.
  - `api.ts`, `auth.ts` (sessions, app tokens, Google/GitHub sign-in, the test sign-in), `google.ts` (Google OpenID Connect: PKCE, id_token checks), `tokens.ts` (app tokens and their one-time codes), `account.ts` (deleting an account), `workspaces.ts` (the joined list; with sign-in off, every workspace), `repos.ts`.
- `src/workers/`: the Cloudflare Workers build: the Worker's router and crons, the Durable Objects (`WorkspaceDO`, `HomeDO` (now only the demo's lobby), `ShellDO`) and the D1 / DO SQLite adapters. Configured by `wrangler.jsonc`; D1 schema in `migrations/`. See [Grim on Cloudflare](06-cloudflare.md).
- `src/client/`: the browser app (vanilla TypeScript).
- `src/client/editor-rs/`: the editor: the web shell of the Rust engine (contenteditable rendering, `editor.css`, input, layout from the DOM, remote cursors, images, the multiplayer connection). The engine itself is the wasm build in `editor-rs/pkg/` (from `crates/editor-wasm` in the grimoire-native repo; see docs/05-v1-architecture.md for rebuilding it). If the wasm can't load or crashes, the note's Markdown is shown read-only with a Reload button; a crash keeps the unsent edits for the reload.
- `src/client/landing/`: the landing page (our hosted site only: `MARKETING_SITE=on`; the app loads it as its own chunks, and only there): `home.ts` the page (the intro note, whose Markdown is `home-note.md`, "Get started", the top-right action, the footer), `doodle/` your pencil and the bots' (3D, WebGL) and their marks (2D canvas), `bots/` the three bots, entirely in the browser: `engine.ts` (what they do and when), `home-lines.ts` (what they write: edit freely), `home-drawings.ts` (moist-burrito's drawings), `cast.ts` (their hands), `handwriting.ts` (the Hershey-glyph handwriting); no socket, nothing synced between visitors or kept, every page load starts afresh, `signature.ts` the footer's Anomaly signature (hokum.app's footer, in IBM Plex Mono, `src/client/fonts/IBMPlexMono-400.woff2`). Without the setting, `/` is the app and none of it is fetched. To preview it locally: `MARKETING_SITE=on bun run start` (or `bun run dev`), then open `/`.
- `test/`: `bun test` (server and editor shell), `test/workers/` (the Workers build in Miniflare), the editor's browser suite `test/editor/browser/run.mjs`, plus `test/e2e/*.mjs` (browsers and an agent through the real server).
- `tools/parity/`: plays the same keystrokes in a reference Mac Markdown app and in our editor on a Mac and compares what the user sees step by step.

## More docs
- [`workspaces/SPEC.md`](workspaces/SPEC.md): workspaces, the switcher and sign-in: the spec and its decision log.
- [`docs/05-v1-architecture.md`](05-v1-architecture.md): the current architecture and internal contracts.
- [`docs/06-cloudflare.md`](06-cloudflare.md): the hosted build on Cloudflare as built: the Worker router, the Durable Objects, the seams, hibernation and crash recovery, caches, crons, wrangler config and secrets, its tests, security rules and deploying.
- [`docs/07-workspace-socket.md`](07-workspace-socket.md): design (not built yet): one WebSocket per workspace (protocol v2): channel framing, open/close, workspace events, hibernation, reconnect, migration from per-note sockets.
- [`docs/08-first-load.md`](08-first-load.md): how a client starts: the HTML splash, the boot requests in parallel, what the first view waits for (then everything shows in one frame), the 3 s cap, workspace switches. The Mac app matches it.
- [`docs/typography.md`](typography.md): the note's type scale and colour tokens, shared value for value by the web editor (`editor.css`) and the Mac app (`theme.rs`), and how to check that they match.
- [`docs/04-editor-engine.md`](04-editor-engine.md): the measured interaction spec of a reference Markdown editor, and the editor design (implemented in `crates/editor-core`).
- `docs/01`–`03`: earlier designs (OT/CRDT research, lock-based server), superseded.

# Grimoire: technical docs

How Grimoire is built, how to develop it and how the server and its APIs work. To use Grimoire, start with the [README](../README.md); to run your own server, see [Self-hosting](self-hosting.md).

The same server code runs two ways: as one Bun process (self-hosting, development, tests) and on Cloudflare Workers + Durable Objects (the hosted service at grimnotes.app). How the hosted build works is in [Grimoire on Cloudflare](06-cloudflare.md).

## What it does, in detail
- Open it in the browser and type: everyone in the same note sees edits and cursors live.
- The editor is a live-preview Markdown editor, built from scratch. Its engine is Rust (`editor-core`, shared with the native Mac app) compiled to WebAssembly; it also owns the note's shared document (yrs) in the browser.
- Every note is a Markdown file in a Git repo, hosted on [Code Storage](https://code.storage) or on the server's own disk ([run your own server](#run-your-own-server-no-code-storage)). Edits are committed to the repo's main branch after 3 seconds of quiet, so the full history is there.
- **New note** makes `Untitled.md` (`Untitled 2.md`, …) right away; type a first-line heading (`# Trip plans`) and press Enter, and the note is named after it (`Trip plans.md`), once.
- Drop images onto a note (or paste a screenshot): they're uploaded into the notebook (`images/` next to the note) and shown inline.
- Repos can be plain notebooks (only in the server's storage) or linked GitHub repos (two-way sync via a GitHub App; only `.md` files are shown).
- Anyone signed in can add a public GitHub repo to browse its Markdown read-only: "+ GitHub repo" in the sidebar takes a repo URL (`/tree/<branch>` and `/blob/<branch>/<file>` URLs work too). It's refreshed from GitHub every 5 minutes. Locally these are shallow partial clones: file contents are only downloaded when read.
- Agents work on the same notes in a sandboxed bash shell and show up as participants with their own cursor. You hand one a notebook with a "Share with agent" link.
- **Sign-in is a server setting** (`SIGN_IN`, [below](#sign-in-sign_in)): off by default on a self-hosted server (no accounts at all: every visitor may do everything), on at grimnotes.app and staging (Google sign-in, guests only read and edit).
- No account needed to look around: visitors who aren't signed in open any workspace and note as **guests**, with a made-up name on their cursor ("moist-noodle"), and edit them (see [Guests](#guests-not-signed-in)). `/scratch` is a local-only scratch note for playing with the editor.
- The **demo workspace** (`/app/demo`, where the home page's "View the notes" goes) is a playground anyone can edit: it's kept only in the server's memory, starts from a short tour, and goes back to it on restart and every `DEMO_RESET_MINUTES` (default 15; the banner says how often). People in it at a reset get the tour back live: their open notes reload. Limits: 1 MB per note, 2 MB per image, 10 MB of images, 20 MB in all, the last 200 commits; past them saving says "The demo is full — it resets every 15 minutes" (the configured interval). Nobody owns it, so nobody can remove it. **It's only for people who aren't signed in:** an account never joins it (`recordJoin` refuses it; `join-many` skips it; migration `0005_demo_not_joined.sql` and Bun's startup removed existing joins), never sees it listed (`/api/repos`, `/api/workspaces`, the agent shell's and MCP's listings), and opening `/app/demo` signed in lands in the account's own workspace. Visitors of a server without sign-in (no accounts) keep it like guests.

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
  - Outside pushes are picked up only with `EXTERNAL_SYNC=1` (off by default). Then add a webhook pointing at `$PUBLIC_URL/webhooks/codestorage` and put its secret in `CODE_STORAGE_WEBHOOK_SECRET`; without the webhook they are picked up by polling every 20 s.
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
  - `off`: **no accounts at all.** No sign-in UI anywhere (no Sign in button, prompts or account menu; `/api/config` and `/api/server` say `signIn: false`; `/auth/*` GETs go home, the rest 404; `/api/me` and `/api/tokens` 404). Every visitor may do what an account may: create workspaces, notes and folders, rename, delete, upload, add GitHub copies, make agent links, use `/api/shell` and `/mcp`. Each visitor is its guest identity (the `X-Grimoire-Guest` headers, the rooms' `anon`/`name`/`color`; requests without one share a "Visitor"), kept as a credential-less `users` row `guest:<id>` (`visitorUser` in `auth.ts`) so what accounts own (the workspaces they made, their joined list, agent links) works for visitors too. Names change with **Change name…** (the browser's or app's own guest name), commits are `<name> (guest)`. Sessions and app tokens are ignored. Per-IP limits stay (image uploads are limited per IP for visitors). Cross-origin browser requests are still refused.
  - `on`: accounts through Google (GitHub too where configured); guests read and edit only. The server refuses to start without a sign-in method (`signInProblem`: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, or GitHub sign-in; the plain-http test sign-in counts for tests): Bun exits with the error, a Worker answers every request with it (500) and logs it.
  - Named `SIGN_IN` (rather than e.g. `REQUIRE_SIGN_IN`) because it switches the feature itself: with it on, signing in is still optional for reading and editing.
- **Landing after sign-in:** an account opens its own workspace: its first joined one, else one it made, else a new "<First name>'s notes" ("My notes" without a name) with a short welcome README, made on the spot (`POST /api/workspaces/personal`, idempotent; the web calls it when the account has no workspace to open, the Mac app after signing in with nothing open or instead of the demo).
- **Who can sign in** (`SIGN_IN=on`): anyone with a Google account (sign-in is for identity, not privacy), or a GitHub account on self-hosted servers that configure GitHub sign-in. The old name-only sign-in is gone (2026-10-29); accounts made with it keep their sessions until those expire (30 days), and a test sign-in (`ALLOW_DEV_LOGIN=1`, plain-http servers only, no UI) makes such accounts for tests. There are no admins. Nobody gets an account without signing in: visitors who don't are guests (below).
  - Someone signed in to an old name-only account can add Google to it once: completing "Continue with Google" while signed in links that Google account to the current one (refused if that Google account or its email already belongs to another account).
- **Workspaces** (notebooks and GitHub copies, one Git repo each; directories inside one are its **folders**) are **public**: anyone can open and edit any workspace, signed in or not (read-only GitHub copies stay read-only), and a note's URL is its share link. Workspace ids get a random suffix (`design-k7f3`), so addresses can't be guessed. Opening a folder adds it to your switcher (the "joined" list); × takes it off. Only whoever made a folder (or added the GitHub copy) may remove it. **Want privacy? [Run your own server](#run-your-own-server-no-code-storage)** (on your own machine or behind your own network).
- **Apps** (Grimoire for Mac) connect through `$PUBLIC_URL/connect`: the user approves in the browser, the app receives a one-time code on a loopback redirect (`http://127.0.0.1:<port>/…`) and exchanges it with its PKCE verifier at `POST /connect/token` for a token. Tokens are stored hashed; `GET /api/me` with a token names it (`token: {id, label}`) and `DELETE /api/tokens/:id` revokes it (the app's Disconnect). Apps send them as `Authorization: Bearer <token>` (WebSockets also as `?token=`).
- **Agents:** connect through a notebook's "Share with agent" link. See [Agents](#agents).

### Guests (not signed in)
With `SIGN_IN=on` (with it off, every visitor is like a guest but may do everything, and the bottom row is its name with Change name…):
- A visitor who isn't signed in has **no account**. The browser picks a made-up name and colour (kept in localStorage) that others see on their cursor and in the participants list (marked "guest"). The sidebar's bottom row just says **Sign in**; the "Share with an agent" card isn't shown.
- Guests read and **edit** existing notes (live) and restore versions; creating, renaming and deleting notes and folders and adding images need an account ("Sign in to …"), except in the demo. Their commits are authored `<name> (guest) <guest@grimoire.invalid>`. The web app sends their name with REST calls (`X-Grimoire-Guest`, `X-Grimoire-Guest-Name`, `X-Grimoire-Guest-Color`) and rooms (`/ws?…&anon=&name=&color=`). Image uploads are rate-limited per IP for guests.
- Guests **open any workspace** too (all workspaces are public): the switcher's **Open…** takes a workspace's name or a link to a workspace or note, opens it and adds it to the workspaces remembered in this browser. Only **creating workspaces** (the switcher's New…, and adding a GitHub repo), agent links and the account need an account: the app opens a sign-in dialog (the server's sign-in methods, landing back on the same note, plus "Play in a scratch note instead": `/scratch?from=<folder>/<note>`, a copy that stays in the browser).

### Run your own server (no Code Storage)
With `STORAGE=local` the server needs no outside accounts: each workspace is a bare Git repo on the server's own disk, `$DATA_DIR/git/<workspace-id>.git`, next to the SQLite database `$DATA_DIR/grimoire.sqlite`. Full history, live editing, agents and read-only GitHub copies all work as usual. The [self-hosting guide](self-hosting.md) covers it end to end: the quick start, every setting, storage, sign-in, systemd, HTTPS behind Caddy, the Mac app and agents, backups, upgrades and troubleshooting.

## Agents
Agents get one interface: a bash shell whose filesystem is the live notes of one notebook.
- At the bottom of the sidebar, **Share this workspace with an agent → Copy** copies a ready-to-paste prompt with your link for the open workspace, `$PUBLIC_URL/a/<uuid>` (one per person per workspace: made the first time, the same one after that; `POST /api/repos/:id/shares`). Paste it to your agent. Whoever has the link can use that folder and nothing else (read-only folders stay read-only). Removing the folder, or the account that made the link, removes it.
- The app has no screen for managing links; `DELETE /api/shares/:id` revokes yours (only its creator can), and asking again makes a new one. Revoking stops whatever the agent is running right away.
- A `GET` on the link returns plain-text instructions for the agent (what's in the notebook, how to call it, examples, limits).
- `POST` runs a command. The body is the command as plain text, or JSON `{"command", "session"?, "timeout_seconds"?}`; the response is `{stdout, stderr, exitCode, cwd, truncated}` (or plain text with `?format=text` / `Accept: text/plain`). `X-Agent-Name` sets the name on the agent's cursor and commits (default: the link's label); it's still one agent per link. Calls share one session (cwd, variables, `/tmp`) unless they send `session` or `X-Shell-Session`.
  ```bash
  curl -s -X POST "$LINK" --data-binary 'grep -rn TODO .'
  ```
- The shell starts in the notebook's directory, `/workspace/<repo>`; `/tmp` is private scratch space.
- Writes show up live in people's editors (with the agent's cursor) and are committed after 3 s of quiet, or right away with `save`. A rewrite keeps edits people made since the agent read the file (or fails if they touched the same spot).
- Extra commands: `repos`, `save [path]`, `who <file>`, `watch [path] [--timeout S]`, and read-only `git log|show|diff|status`.
- Standard tools work (`ls cat grep sed awk find jq diff ...`). There's no python, node or network.
- Limits: 110 s per call (30 s by default), 200 KB of output per stream, 1 MB request bodies, 120 calls per minute and 4 commands at a time per link.

**CLI:** `bin/grimoire` (needs Bun; `bun link` puts `grimoire` on your PATH):
```bash
export GRIMOIRE_SHARE_URL=https://grimoire.example.com/a/<uuid>
# or grimoire --url <link> ..., or put {"url": "<link>"} in ~/.config/grimoire/config.json (chmod 600)
grimoire 'grep -rn TODO .'                 # run one command (or -c '...'); exits with its exit code
grimoire -t 110 'watch plan.md'
grimoire                                   # interactive shell (prompt shows the cwd)
```
One-off commands share a default session, so `cd` carries over. Set `GRIMOIRE_SESSION=<name>` to use a separate one; the interactive shell prints its session name when it starts. `GRIMOIRE_AGENT_NAME` sets `X-Agent-Name`.

**MCP and `/api/shell`** (one `document_command` tool at `$PUBLIC_URL/mcp`; `POST /api/shell`) still exist but only accept a signed-in browser session; agents use share links.

## Layout
- `src/server/`: the server, shared by the Bun entry and the Workers build.
  - `index.ts`: the Bun entry: `Bun.serve`, WebSockets and wiring. `app.ts`: the router (`createApp`), also used by the Worker.
  - `seams/`: the interfaces that differ between Bun and Workers (`Db`, `RoomStorage`, `WorkspaceHost`, `EventBus`); `bun/`: their Bun implementations. See [the seams](06-cloudflare.md#the-seams-bun-vs-workers).
  - `workspace.ts`: `WorkspaceRuntime`, one workspace's operations, rooms, tree cache and heads (a `Map` of them on Bun, one per Durable Object on Workers).
  - `room.ts`, `rooms.ts`: live Yjs rooms (`Room`) and their manager. Each room has a crash-safe log, does a 3-way merge of outside pushes, and commits after a quiet period.
  - `store/`: Code Storage and local Git backends, the in-memory store (`memory.ts`, the demo workspace's), `routed.ts` (the server's store: `demo` → memory, everything else → the configured backend) and `cached-head.ts` (branch heads cached in front of it).
  - `demo.ts`: the demo workspace: seed, resets, limits.
  - `ops.ts`: file operations shared by the API and the agent shell (they call the workspace's runtime through the `WorkspaceHost`).
  - `shell/`: the agent shell (a just-bash interpreter over the live notes) and its sessions.
  - `shares.ts`: "Share with agent" links (`/a/<uuid>`): the agent prompt and command endpoint.
  - `mcp.ts`: the MCP endpoint (one `document_command` tool; browser sessions only).
  - `home.ts`: a home page doodle room (`/ws/home`, public): up to 4 visitors' pencils and strokes plus the room's own bots that write sayings. In memory only, rate- and size-limited; protocol in `src/shared/doodle.ts`. `home-lobby.ts` shares visitors out into rooms (fullest with space first, a new room when all are full; Bun and Workers), `home-rooms.ts` holds Bun's rooms.
  - `anon.ts`: guests (visitors who aren't signed in): the guest participant from the room query or the REST headers.
  - `api.ts`, `auth.ts` (sessions, app tokens, Google/GitHub sign-in, the test sign-in), `google.ts` (Google OpenID Connect: PKCE, id_token checks), `tokens.ts` (app tokens and `/connect`), `workspaces.ts` (the joined list), `repos.ts`.
- `src/workers/`: the Cloudflare Workers build: the Worker's router and crons, the Durable Objects (`WorkspaceDO`, `HubDO`, `HomeDO`, `ShellDO`) and the D1 / DO SQLite adapters. Configured by `wrangler.jsonc`; D1 schema in `migrations/`. See [Grimoire on Cloudflare](06-cloudflare.md).
- `bin/grimoire`: CLI for the agent shell (talks to a share link).
- `src/client/`: the browser app (vanilla TypeScript).
- `src/client/editor-rs/`: the editor: the web shell of the Rust engine (contenteditable rendering, `editor.css`, input, layout from the DOM, remote cursors, images, the multiplayer connection). The engine itself is the wasm build in `editor-rs/pkg/` (from `crates/editor-wasm` in the grimoire-native repo; see docs/05-v1-architecture.md for rebuilding it). If the wasm can't load or crashes, the note's Markdown is shown read-only with a Reload button; a crash keeps the unsent edits for the reload.
- `src/client/doodle/`: the home page's 3D pencils (WebGL) and pencil marks (2D canvas), loaded only on the home page.
- The home page's footer is hokum.app's (the Anomaly copyright in IBM Plex Mono, `src/client/fonts/IBMPlexMono-400.woff2`, over the Anomaly signature SVG in `src/client/signature.ts`, a chunk loaded after first paint) on a full-width black band.
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

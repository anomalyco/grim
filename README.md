# Grimoire

A multiplayer markdown notebook for people and agents.
- Open it in the browser and type: everyone in the same note sees edits and cursors live.
- The editor is a Bear-style live markdown editor, built from scratch. Its engine is Rust (`editor-core`, shared with the native Mac app) compiled to WebAssembly; it also owns the note's shared document (yrs) in the browser.
- Every note is a Markdown file in a Git repo, hosted on [Code Storage](https://code.storage) or on the server's own disk ([run your own server](#run-your-own-server-no-code-storage)). Edits are committed to the repo's main branch after 3 seconds of quiet, so the full history is there.
- **New note** makes `Untitled.md` (`Untitled 2.md`, …) right away; type a first-line heading (`# Trip plans`) and press Enter, and the note is named after it (`Trip plans.md`), once.
- Drop images onto a note (or paste a screenshot): they're uploaded into the notebook (`images/` next to the note) and shown inline.
- Repos can be plain notebooks (only in the server's storage) or linked GitHub repos (two-way sync via a GitHub App; only `.md` files are shown).
- Anyone signed in can add a public GitHub repo to browse its Markdown read-only: "+ GitHub repo" in the sidebar takes a repo URL (`/tree/<branch>` and `/blob/<branch>/<file>` URLs work too). It's refreshed from GitHub every 5 minutes. Locally these are shallow partial clones: file contents are only downloaded when read.
- Agents work on the same notes in a sandboxed bash shell and show up as participants with their own cursor. You hand one a notebook with a "Share with agent" link.
- No account needed to look around: visitors who aren't signed in open any workspace and note as **guests**, with a made-up name on their cursor ("moist-noodle"), and edit them (see [Guests](#guests-not-signed-in)). `/scratch` is a local-only scratch note for playing with the editor.
- The **demo workspace** (`/app/demo`, where the home page's "View the notes" goes) is a playground anyone can edit: it's kept only in the server's memory, starts from a short tour, and goes back to it on restart and every `DEMO_RESET_HOURS` (default 6). Limits: 1 MB per note, 2 MB per image, 10 MB of images, 20 MB in all, the last 200 commits; past them saving says "The demo is full — it resets every few hours". Nobody owns it, so nobody can remove it.

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

For local development without any accounts:
```bash
ALLOW_DEV_LOGIN=1 bun run dev
```
This stores repos as bare Git repos in `./data/git` and adds a name-only sign-in. Every name sign-in creates a new account (typing a name that's already used gives a separate account with that display name). Never set `ALLOW_DEV_LOGIN` on an internet-facing server.

### Production settings (`.env`)
- **Code Storage** (`STORAGE=codestorage`; for a server without it see [Run your own server](#run-your-own-server-no-code-storage)):
  - Set `CODE_STORAGE_ORG` and `CODE_STORAGE_PRIVATE_KEY_FILE` (the private key from the org's Keys page).
  - Add a webhook pointing at `$PUBLIC_URL/webhooks/codestorage` and put its secret in `CODE_STORAGE_WEBHOOK_SECRET`. Without the webhook, outside pushes are still picked up by polling every 20 s.
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
- **Who can sign in:** anyone (sign-in is for identity, not privacy). Google and GitHub sign-in when configured; with `ALLOW_DEV_LOGIN=1`, the name-only sign-in too. Each name-only sign-in is a new account (the login gets a random suffix, e.g. `james-k7f3`), never an existing one. There are no admins. Nobody gets an account without signing in: visitors who don't are guests (below).
  - Someone signed in to a name-only account can add Google to it once: completing "Continue with Google" while signed in links that Google account to the current one (refused if that Google account or its email already belongs to another account).
- **Workspaces** (notebooks and GitHub copies, one Git repo each; directories inside one are its **folders**) are **public**: anyone can open and edit any workspace, signed in or not (read-only GitHub copies stay read-only), and a note's URL is its share link. Workspace ids get a random suffix (`design-k7f3`), so addresses can't be guessed. Opening a folder adds it to your switcher (the "joined" list); × takes it off. Only whoever made a folder (or added the GitHub copy) may remove it. **Want privacy? [Run your own server](#run-your-own-server-no-code-storage)** (on your own machine or behind your own network).
- **Apps** (Grimoire for Mac) connect through `$PUBLIC_URL/connect`: the user approves in the browser and the app receives a token on a loopback redirect (`http://127.0.0.1:<port>/…`). Tokens are stored hashed; `GET /api/me` with a token names it (`token: {id, label}`) and `DELETE /api/tokens/:id` revokes it (the app's Disconnect). Apps send them as `Authorization: Bearer <token>` (WebSockets also as `?token=`).
- **Agents:** connect through a notebook's "Share with agent" link. See [Agents](#agents).

### Guests (not signed in)
- A visitor who isn't signed in has **no account**. The browser picks a made-up name and colour (kept in localStorage) that others see on their cursor and in the participants list (marked "guest"). The sidebar's bottom row just says **Sign in**; the "Share with an agent" card isn't shown.
- Guests read and **edit everything**: notes (live), new notes, renames, deletes, images, restoring versions. Their commits are authored `<name> (guest) <guest@grimoire.invalid>`. The web app sends their name with REST calls (`X-Grimoire-Guest`, `X-Grimoire-Guest-Name`, `X-Grimoire-Guest-Color`) and rooms (`/ws?…&anon=&name=&color=`). Image uploads are rate-limited per IP for guests.
- Guests **open any workspace** too (all workspaces are public): the switcher's **Open…** takes a workspace's name or a link to a workspace or note, opens it and adds it to the workspaces remembered in this browser. Only **creating workspaces** (the switcher's New…, and adding a GitHub repo), agent links and the account need an account: the app opens a sign-in dialog (the server's sign-in methods, landing back on the same note, plus "Play in a scratch note instead": `/scratch?from=<folder>/<note>`, a copy that stays in the browser).

### Run your own server (no Code Storage)
Every workspace on a server is public to everyone signed in there, so privacy means hosting your own. With `STORAGE=local` the server needs no outside accounts: each workspace is a Git repo on the server's own disk, `$DATA_DIR/git/<workspace-id>.git`. Full history, live editing, agents and read-only GitHub copies all work as usual.
- The repos are **bare**: notes are Git objects, not plain `.md` files you can open in place. `git clone $DATA_DIR/git/<workspace-id>.git` gives you the files. Pushes back to the main branch are picked up (polled every `POLL_MS`, default 20 s).
- GitHub copies are partial clones in the same directory. File contents are fetched from GitHub when first read.

Minimal `.env`:
```bash
PORT=8787
PUBLIC_URL=https://notes.example.com   # also the base of "Share with agent" links
DATA_DIR=/var/lib/grimoire
STORAGE=local
ALLOW_DEV_LOGIN=1                      # name-only sign-in; leave unset (or 0) if only Google should work
# DEMO_RESET_HOURS=6                   # the demo workspace goes back to its tour this often (0: only on restart)
# GOOGLE_CLIENT_ID=…                   # optional "Continue with Google" (see above)
# GOOGLE_CLIENT_SECRET=…
```
Start it with `bun run start` (builds the client, then runs `bun src/server/index.ts`). Or install it as a systemd service: the unit in `scripts/deploy-exe.sh` runs `bun src/server/index.ts` with `EnvironmentFile=` pointing at your env file. Stop it with SIGTERM so it commits pending edits first.

**Backups:** copy `DATA_DIR`. It holds the SQLite database (`grimoire.sqlite`: accounts, workspaces, sign-ins, edits not yet committed) and `git/` (every note and its history). Stop the server first for a consistent copy, or snapshot the database with `sqlite3 grimoire.sqlite ".backup …"`.

**Compared with `STORAGE=codestorage`:** your notes live in hosted Git on [Code Storage](https://code.storage) (by Pierre), so they survive losing the server, and linked GitHub workspaces can be edited (two-way sync through the GitHub App). With `STORAGE=local`, GitHub folders are always read-only copies.

If `STORAGE` is unset, the server uses Code Storage when `CODE_STORAGE_ORG` and its private key are set, and local storage otherwise. Set it explicitly. The startup log line shows which one is in use (`storage: local`). A guided onboarding flow for setting up your own server will come later.

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
- `src/server/`: the Bun server.
  - `index.ts`: HTTP, WebSocket and wiring.
  - `rooms.ts`: live Yjs rooms. Each has a crash-safe log, does a 3-way merge of outside pushes, and commits after a quiet period.
  - `store/`: Code Storage and local Git backends, the in-memory store (`memory.ts`, the demo workspace's) and `routed.ts` (the server's store: `demo` → memory, everything else → the configured backend).
  - `demo.ts`: the demo workspace: seed, resets, limits.
  - `ops.ts`: file operations shared by the API and the agent shell.
  - `shell/`: the agent shell (a just-bash interpreter over the live notes) and its sessions.
  - `shares.ts`: "Share with agent" links (`/a/<uuid>`): the agent prompt and command endpoint.
  - `mcp.ts`: the MCP endpoint (one `document_command` tool; browser sessions only).
  - `home.ts`: the home page doodle room (`/ws/home`, public): visitors' pencils and strokes plus server-side bots that write sayings. In memory only, rate- and size-limited; protocol in `src/shared/doodle.ts`.
  - `anon.ts`: guests (visitors who aren't signed in): the guest participant from the room query or the REST headers.
  - `api.ts`, `auth.ts` (sessions, app tokens, GitHub/Google/name sign-in), `google.ts` (Google OpenID Connect: PKCE, id_token checks), `tokens.ts` (app tokens and `/connect`), `workspaces.ts` (the joined list), `repos.ts`.
- `bin/grimoire`: CLI for the agent shell (talks to a share link).
- `src/client/`: the browser app (vanilla TypeScript).
- `src/client/editor-rs/`: the editor: the web shell of the Rust engine (contenteditable rendering, `editor.css`, input, layout from the DOM, remote cursors, images, the multiplayer connection). The engine itself is the wasm build in `editor-rs/pkg/` (from `crates/editor-wasm` in the grimoire-native repo; see docs/05-v1-architecture.md for rebuilding it). If the wasm can't load or crashes, the note's Markdown is shown read-only with a Reload button; a crash keeps the unsent edits for the reload.
- `src/client/doodle/`: the home page's 3D pencils (WebGL) and pencil marks (2D canvas), loaded only on the home page.
- `test/`: `bun test` (server and editor shell), the editor's browser suite `test/editor/browser/run.mjs`, plus `test/e2e/*.mjs` (browsers and an agent through the real server).
- `tools/parity/`: plays the same keystrokes in Bear and in our editor on a Mac and compares what the user sees step by step.

## Docs
- [`docs/05-v1-architecture.md`](docs/05-v1-architecture.md): the current architecture and internal contracts.
- [`docs/04-editor-engine.md`](docs/04-editor-engine.md): Bear's measured interaction spec and the editor design (implemented in `crates/editor-core`).
- `docs/01`–`03`: earlier designs (OT/CRDT research, lock-based server), superseded.

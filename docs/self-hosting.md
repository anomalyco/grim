# Self-hosting Grim

Grim is one Bun process. Run it on your laptop, a home server or a small VPS, and your notes stay on that machine: each workspace is a Git repo in a folder you choose, next to one SQLite file.

- [Why self-host](#why-self-host)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Storage](#storage)
- [Sign-in](#sign-in)
- [Running it for real](#running-it-for-real): systemd, HTTPS with Caddy
- [Connecting apps and agents](#connecting-apps-and-agents)
- [Backups and upgrades](#backups-and-upgrades)
- [Troubleshooting](#troubleshooting)

## Why self-host

**Privacy.** On a Grim server every workspace is public: anyone who can reach the server can open and edit any workspace, without signing in. With [sign-in](#sign-in) off (the default) they can also create, rename and delete anything. That's what makes sharing a link so easy, and it's why the hosted service isn't the place for private notes. Your own server with `STORAGE=local` keeps everything on your disk, with no outside accounts or services.

That also means **your server is only as private as its network.** Keep it on your own machine (`HOST=127.0.0.1`, as in the quick start), your home network, or a private network like Tailscale. If you put it on the public internet, everyone who finds it can read and edit it.

The hosted service is moving to [grimnotes.app](https://grimnotes.app), which runs on Cloudflare. Self-hosting doesn't change: it stays a single Bun process.

## Requirements

- **[Bun](https://bun.sh)** 1.4 or newer (this guide was checked with Bun 1.4.2). Install it with `curl -fsSL https://bun.sh/install | bash`.
- **Git** on the `PATH`. With local storage the server runs `git` to store every note.
- **Linux or macOS.**
- About 450 MB of disk for the checkout and its `node_modules`, plus your notes.

## Quick start

```bash
git clone https://github.com/anomalyco/grim.git grim && cd grim
bun install
printf 'STORAGE=local\nHOST=127.0.0.1\n' > .env
bun run start
```

Open <http://localhost:8787/app>: the **Notes** workspace opens straight away. There's no sign-in (it's [off by default](#sign-in)): you can create workspaces with **New…** in the workspace switcher at the top left, create, rename and delete notes, add images and hand a workspace to an agent. Your browser picks a made-up name for your cursor and commits; change it with **Change name…** at the bottom of the sidebar.

What those settings do: `STORAGE=local` keeps workspaces as Git repos in `./data`, and `HOST=127.0.0.1` means only this machine can connect. Bun reads `.env` from the current directory by itself. `bun run start` builds the web app and then starts the server; stop it with Ctrl-C, which saves any pending edits first.

The first start creates a workspace called **Notes** (with a `Welcome.md`) that everyone on the server sees, and the **demo workspace** at `/app/demo`, a playground for visitors that lives only in memory, in rooms of at most 10 people (each its own copy of the demo; more visitors get more rooms), and goes back to its tour every 15 minutes (`DEMO_RESET_MINUTES`); a restart drops every room.

## Configuration

Settings are environment variables, read from `.env` in the directory you start the server in, or from your service manager (see [systemd](#systemd)). Everything is optional; with no settings at all you get local storage in `./data` on port 8787 and no sign-in (everyone who can reach the server can do everything).

`.env.example` in the repository lists the common ones with comments.

### Basics

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | The port the server listens on. |
| `HOST` | all interfaces | The address to listen on: `127.0.0.1` for this machine only (also what you want behind a reverse proxy on the same machine), or e.g. a Tailscale address. |
| `PUBLIC_URL` | `http://localhost:$PORT` | The address people use to reach the server, without a trailing slash (`https://notes.example.com`). Set it whenever that isn't `http://localhost:$PORT`: it's the base of agent links (`$PUBLIC_URL/a/…`) and sign-in callbacks, and once it's set to a real host name, sign-in and editing only work from pages opened at that address. |
| `SERVER_NAME` | the host of `PUBLIC_URL` | The server's name, shown to the Mac app and on its connect page. |
| `DATA_DIR` | `./data` | Where the database and the Git repos live, relative to the directory the server starts in. Created if missing. |
| `MARKETING_SITE` | off | Leave it off. `on` is for our hosted site only: its landing page at `/` (pencils that write, the intro note). Off, `/` opens the app. |
| `TRUSTED_PROXIES` | `127.0.0.0/8,::1` | Reverse proxies whose `X-Forwarded-For`, `-Proto` and `-Host` headers are believed: comma-separated IPs or CIDRs, or `none`. The default fits a proxy on the same machine. |

### Storage

| Variable | Default | What it does |
| --- | --- | --- |
| `STORAGE` | `codestorage` if the two Code Storage settings below are set, otherwise `local` | Where workspaces are stored: `local` (Git repos in `$DATA_DIR/git`) or `codestorage` (hosted Git on [Code Storage](https://code.storage)). Set it explicitly. |
| `CODE_STORAGE_ORG` | | Your Code Storage organization. `codestorage` only. |
| `CODE_STORAGE_PRIVATE_KEY` or `CODE_STORAGE_PRIVATE_KEY_FILE` | | The organization's private key (from its Keys page), or the path of a file holding it. `codestorage` only. |
| `CODE_STORAGE_WEBHOOK_SECRET` or `…_FILE` | | The secret of a Code Storage webhook pointing at `$PUBLIC_URL/webhooks/codestorage`, so outside pushes show up right away instead of at the next poll. `codestorage` and `EXTERNAL_SYNC=1` only. |
| `CODE_STORAGE_API_URL`, `CODE_STORAGE_GIT_URL` | Code Storage's own | Other Code Storage API and Git endpoints. You won't normally need these. |
| `CODE_STORAGE_REPO_PREFIX` | | Prepended to every repo id sent to Code Storage (e.g. `test-`), so two servers can share one organization without touching each other's repos. `codestorage` only. |

### Sign-in

| Variable | Default | What it does |
| --- | --- | --- |
| `SIGN_IN` | `off` | `on` turns on accounts: people sign in with Google (or GitHub, if configured) to create workspaces and notes, and visitors who don't are guests who only read and edit. `on` needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (or GitHub sign-in): without them the server refuses to start and says what to set. `off`: no accounts and no sign-in anywhere; everyone can do everything. See [Sign-in](#sign-in). |
| `ALLOW_DEV_LOGIN` | off | Tests only: `1` turns on `/auth/dev`, which makes a new account with a typed name (no link or button in the app). Ignored unless `PUBLIC_URL` is plain `http://`. Not a sign-in method. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (or `GOOGLE_CLIENT_SECRET_FILE`) | | With `SIGN_IN=on`: **Continue with Google**. See [Google](#google). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (or `GITHUB_CLIENT_SECRET_FILE`) | | With `SIGN_IN=on`: **Continue with GitHub**. See [GitHub](#github). |
| `GITHUB_APP_SLUG` | | The GitHub App's slug. Only used with `STORAGE=codestorage`, where it makes linked GitHub repos editable. |

### Behavior

| Variable | Default | What it does |
| --- | --- | --- |
| `NOTES_REPO` | `notes` | The id of the shared workspace created at the first start. Can't be `demo`. |
| `DEFAULT_BRANCH` | `main` | The branch new workspaces use. |
| `QUIET_MS` | `3000` | Edits are committed after this many milliseconds without typing. |
| `EXTERNAL_SYNC` | off | `1` picks up commits made outside Grim (pushed straight to Code Storage or to the local Git repo): the Code Storage webhook and the `POLL_MS` poller. Off: not supported for now, the webhook answers 404 and nothing polls; a Grim commit that meets such a commit merges it in rather than losing either side. |
| `POLL_MS` | `20000` | With `EXTERNAL_SYNC=1`: how often (ms) the server checks every workspace for changes pushed from outside. |
| `DEMO_RESET_MINUTES` | `15` | How often (minutes) each demo room goes back to its tour. `0`: only on restart. People in it get the tour back live (their open notes reload). |
| `DEMO_RESET_HOURS` | — | The older setting, in hours; used only when `DEMO_RESET_MINUTES` isn't set. |
| `UPSTREAM_REFRESH_MS` | `300000` | How often (ms) read-only GitHub workspaces are refreshed from GitHub. |
| `MAX_GITHUB_REPOS` | `100` | How many read-only GitHub workspaces the server holds in total. |
| `MAX_GITHUB_REPOS_PER_USER` | `10` | How many of those one person may add. |
| `AUTH_CACHE` | off | `1` keeps sign-in lookups in memory for up to a minute. Made for the Cloudflare build; a self-hosted server doesn't need it. |
| `REPO_CACHE` | off | `1` keeps workspace records in memory for up to 10 seconds. Made for the Cloudflare build, like `AUTH_CACHE`. |

The secrets (`CODE_STORAGE_PRIVATE_KEY`, `CODE_STORAGE_WEBHOOK_SECRET`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`) can each come from a file: set `<NAME>_FILE` to its path and leave `<NAME>` empty. In the variable itself, `\n` stands for a line break.

For tests only: `GITHUB_GIT_BASE` (where GitHub repos are cloned from, default `https://github.com`) and `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_JWKS_URL`, `GOOGLE_ISSUERS` (a stand-in Google).

The startup log line shows what's in use:

```
grimoire listening on http://localhost:8787 (port 8787) · storage: local · sign-in: off (no accounts: everyone can do everything) · Google: off · GitHub login: off · test sign-in (/auth/dev): off
```

## Storage

### Local Git (`STORAGE=local`)

Everything is in `DATA_DIR`:

```
data/
├── grimoire.sqlite        accounts, sign-ins, workspaces, agent links, and edits not committed yet
├── grimoire.sqlite-wal    (SQLite's write-ahead log; part of the database)
├── grimoire.sqlite-shm
└── git/
    ├── notes.git          the shared Notes workspace
    └── <workspace-id>.git one bare Git repo per workspace, e.g. trip-qmkt.git
```

- Edits are committed to the workspace's `main` branch after 3 seconds of quiet, under the name of whoever made them, so the full history is there.
- The repos are **bare**: the notes are inside Git, not loose `.md` files. To get the files, clone one:
  ```bash
  git clone data/git/<workspace-id>.git
  git -C data/git/<workspace-id>.git log
  ```
- Pushing back to it is picked up only with `EXTERNAL_SYNC=1` (within `POLL_MS`, 20 s, merged with live edits). Without it a push isn't shown until a Grim commit meets the moved branch (the note is then merged with it, nothing lost) or the server restarts.
- Read-only GitHub workspaces are partial clones in the same directory; a file's contents are downloaded from GitHub the first time someone opens it.
- The workspace id is the URL's last part: `http://localhost:8787/app/trip-qmkt` is `git/trip-qmkt.git`.
- The demo's rooms are never written to disk (each has a row in the database while it exists; a restart deletes them).

### Code Storage (`STORAGE=codestorage`)

Your notes live in hosted Git on [Code Storage](https://code.storage) (by Pierre) instead of your disk, so they survive losing the server, and linked GitHub repos can be edited with two-way sync (through a GitHub App registered with Code Storage). The database stays in `DATA_DIR`. With `STORAGE=local`, GitHub workspaces are always read-only copies.

Setting it up (the org's private key, the webhook, the GitHub App's permissions) is described in the [technical docs](README.md#production-settings-env).

## Sign-in

**Sign-in is off by default.** With no `SIGN_IN` setting there are no accounts at all: no sign-in buttons, no account menu, and **everyone who can reach the server can do everything**: create, rename and delete workspaces, notes and folders, add images, add GitHub copies and make agent links. Each browser (and the Mac app) picks a made-up name ("moist-noodle") for its cursor and its commits (authored `<name> (guest)`); **Change name…** at the bottom of the sidebar changes it. So keep a server without sign-in on your own machine (`HOST=127.0.0.1`), a private network like Tailscale, or behind your own authentication (a reverse proxy with a password or SSO). On the public internet, turn sign-in on.

**`SIGN_IN=on`** turns accounts on, as on [grimnotes.app](https://grimnotes.app): people sign in with **Google** (GitHub too, if you configure it) to create workspaces and notes, rename, delete, add images and make agent links. Visitors who don't sign in are guests: they read and edit existing notes (see [Guests](#guests)). A browser stays signed in for 30 days. Sign-in still isn't access control: every workspace stays open to everyone who can reach the server. There are no admins.

`SIGN_IN=on` needs a way to sign in: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (or GitHub sign-in). Without them the server refuses to start, with an error saying what to set. To turn sign-in on:

1. Create a Google OAuth client ([below](#google)).
2. Add to `.env` (or your service's environment):
   ```
   SIGN_IN=on
   GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-…
   ```
3. Restart. The startup line says `sign-in: on · Google: on`, and the sidebar shows **Sign in**.

Workspaces made while sign-in was off keep working after you turn it on; they just have no maker who can remove them.

Accounts made with the old name sign-in keep working until their sessions expire. Someone signed in to one can add Google to it once: completing **Continue with Google** while signed in links the Google account to it.

### Google

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (or pick one).
2. **APIs & Services → OAuth consent screen:** choose **External**, give the app a name (e.g. "Grim") and a support email, and add the scopes `openid`, `email` and `profile`. While the app is in "Testing", only the test users you list can sign in; **Publish app** lets any Google account sign in (these scopes need no review).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type **Web application**.
4. Under **Authorized redirect URIs** add `$PUBLIC_URL/auth/google/callback`, exactly, e.g. `https://notes.example.com/auth/google/callback` (on your own machine: `http://localhost:8787/auth/google/callback`). No JavaScript origins are needed.
5. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (or put the secret in a file and set `GOOGLE_CLIENT_SECRET_FILE`), set `SIGN_IN=on`, and restart.

### GitHub

1. Create a GitHub App (GitHub → Settings → Developer settings → GitHub Apps → New GitHub App).
2. Callback URL: `$PUBLIC_URL/auth/github/callback`, e.g. `https://notes.example.com/auth/github/callback`.
3. Generate a client secret, set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and restart.

For sign-in alone that's all; repo permissions and `GITHUB_APP_SLUG` only matter for editable GitHub repos with Code Storage.

### Guests

With `SIGN_IN=on`, visitors who don't sign in are guests: their browser picks a made-up name ("moist-noodle") for their cursor, and they can read and edit every workspace; their commits are authored `<name> (guest)`. Creating workspaces, notes and folders (outside the demo), agent links and remote workspaces in the Mac app need an account. Guests are always allowed; there's no setting to turn them off. (With sign-in off, everyone is a visitor like this, but may do everything.)

## Running it for real

### systemd

Put the checkout somewhere stable, build the web app once, and let systemd run the server. This is the unit Grim's own deployment uses (`scripts/deploy-exe.sh`), with your own user and paths. As root (or with `sudo`):

```bash
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash   # Bun in /usr/local/bin, usable by every user
useradd --system --create-home grimoire
git clone https://github.com/anomalyco/grim.git /opt/grimoire
chown -R grimoire: /opt/grimoire
cd /opt/grimoire && sudo -u grimoire bun install && sudo -u grimoire bun run build:client
install -d -m 700 -o grimoire -g grimoire /etc/grimoire /var/lib/grimoire
```

`/etc/grimoire/grimoire.env`:

```bash
PORT=8787
HOST=127.0.0.1
PUBLIC_URL=https://notes.example.com
DATA_DIR=/var/lib/grimoire
STORAGE=local
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
```

`/etc/systemd/system/grimoire.service`:

```ini
[Unit]
Description=Grim (multiplayer markdown notebooks)
After=network-online.target
Wants=network-online.target

[Service]
User=grimoire
WorkingDirectory=/opt/grimoire
EnvironmentFile=/etc/grimoire/grimoire.env
ExecStart=/usr/local/bin/bun src/server/index.ts
# SIGTERM makes the server commit pending edits before exiting.
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now grimoire
journalctl -u grimoire -f
```

If Bun is somewhere else, point `ExecStart` at it (`which bun`). The unit runs the server directly, so run `bun run build:client` again after every upgrade. Bun also reads a `.env` in the working directory; values from `EnvironmentFile` win over it, but it's clearer to keep only one.

### HTTPS with Caddy

Put a reverse proxy in front for HTTPS. With [Caddy](https://caddyserver.com) on the same machine, this `Caddyfile` is all it takes (Caddy gets the certificate itself):

```
notes.example.com {
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
```

What the server needs from a proxy:

- **WebSockets** at `/ws` (live editing). Caddy passes them through on its own.
- **Server-sent events** at `/api/events` (who's in which note, new and saved notes). They must not be buffered; `flush_interval -1` makes sure. The server sends a ping every 25 seconds, so idle timeouts above that are fine.
- **Request bodies** up to 16 MB (image uploads).
- **The forwarded headers** (`X-Forwarded-For`, `-Proto`, `-Host`), which Caddy sets. They're only believed from `TRUSTED_PROXIES`, by default this machine, so a proxy elsewhere needs its address there.
- **`PUBLIC_URL`** set to the HTTPS address (`https://notes.example.com`), and `HOST=127.0.0.1` so nobody can skip the proxy.

With another proxy (nginx and the like), pass the WebSocket upgrade headers, turn off response buffering for `/api/events`, and allow 16 MB request bodies.

On Tailscale you may not need a proxy at all: set `HOST` to the machine's Tailscale address and `PUBLIC_URL=http://<that address>:8787`, so only your tailnet can reach it.

## Connecting apps and agents

### The web app

Open `PUBLIC_URL` in a browser. That's it: `/` opens the app (your workspaces; there's no landing page on your own server), and the demo workspace is in the workspace switcher.

### The Mac app

There's no download yet; build it from source (see [`native/docs/app.md`](../native/docs/app.md) and the [technical docs](README.md#repository-layout)). To use your server from it:

- **File → Open Workspace…** (⌘O) → **URL**, and paste the link of a workspace or note on your server (`https://notes.example.com/app/trip-qmkt`), or
- **File → New Workspace…** (⌥⌘N) → **On a server**, and type your server's address in **Server**.

With sign-in off (the default) that's all: the app connects without signing in, under its own made-up name (the sidebar's bottom row says "<your server> · No sign-in", with **Change name…**). With `SIGN_IN=on`, the first time the app opens your browser to sign in with Google; it then keeps a token for that server in the Keychain (**Sign out** in the account menu revokes it).

### Agents

At the bottom of the sidebar, **Share this workspace with an agent → Copy** copies a ready-to-paste prompt with the workspace's link, `$PUBLIC_URL/a/<id>`. Give it to your agent: the link is a shell over that one workspace. The agent must be able to reach `PUBLIC_URL`, so for an agent on another machine, use an address both can reach.

Agents call the link over plain HTTP; there's nothing to install. A `GET` returns the instructions the agent follows, and a `POST` runs a command. Try a link by hand:

```bash
curl -s "$LINK"                                                 # the agent's instructions
curl -s -X POST --data-binary 'ls' "$LINK?format=text"          # run a command
```

The full agent interface, and the MCP endpoint (`/mcp`, for signed-in browser sessions only), are in the [technical docs](README.md#agents).

## Backups and upgrades

### Backups

Back up `DATA_DIR`: `grimoire.sqlite` holds accounts, workspaces, agent links and edits from the last few seconds that aren't committed yet; `git/` holds every note and its history.

The simplest consistent copy is with the server stopped (stopping commits pending edits first):

```bash
sudo systemctl stop grimoire
sudo tar -czf grimoire-$(date +%F).tar.gz -C /var/lib grimoire
sudo systemctl start grimoire
```

Without stopping it, snapshot the database with the `sqlite3` tool and copy the repos:

```bash
sqlite3 /var/lib/grimoire/grimoire.sqlite ".backup /backups/grimoire.sqlite"
cp -a /var/lib/grimoire/git /backups/
```

Since every workspace is a Git repo, `git clone --mirror` (or `git fetch` into an existing mirror) is also a good way to keep copies elsewhere.

### Upgrades

```bash
cd /opt/grimoire
sudo -u grimoire git pull
sudo -u grimoire bun install
sudo -u grimoire bun run build:client
sudo systemctl restart grimoire
```

(Without systemd: `git pull && bun install`, then stop the server and `bun run start` again.)

The database upgrades itself in place when the server starts: new tables and columns are added and older data is migrated, and a database from older versions named `notepad.sqlite` is renamed to `grimoire.sqlite`. Back up before upgrading, since there's no way back to an older schema.

## Troubleshooting

- **The server won't start because the port is in use:** something else listens on 8787. Set another `PORT`, or find it with `lsof -i :8787`.
- **"Cross-origin sign-in refused", "cross-origin request refused", or notes that never connect:** the address in your browser doesn't match `PUBLIC_URL`. Once `PUBLIC_URL` is a real host name, open the server only at exactly that address (scheme, host and port). On your own machine, leave `PUBLIC_URL` unset and use `http://localhost:8787`.
- **Agent links or sign-in callbacks point at `localhost`:** set `PUBLIC_URL` to the address people and agents use.
- **"refusing to start: SIGN_IN=on needs Google sign-in":** set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` ([Google](#google)), or remove `SIGN_IN=on` to run without accounts.
- **There's no Sign in button:** sign-in is off (the default). Set `SIGN_IN=on` and Google's client ([Sign-in](#sign-in)).
- **Google or GitHub says the redirect URI doesn't match:** the callback registered there must be exactly `$PUBLIC_URL/auth/google/callback` or `$PUBLIC_URL/auth/github/callback`.
- **Behind a proxy, notes never connect, or other people's changes only appear after a reload:** the proxy isn't passing WebSockets (`/ws`) or is buffering `/api/events`. See [HTTPS with Caddy](#https-with-caddy).
- **Signed out right after signing in, over plain HTTP on a real host name:** with an `https://` `PUBLIC_URL` the sign-in cookie is HTTPS-only, so the browser must use HTTPS too.
- **Everyone appears to come from the proxy's IP** (guest upload limits hit everyone at once): the proxy isn't in `TRUSTED_PROXIES`.
- **Permission denied on startup:** the user running the server must be able to write `DATA_DIR` (`sudo chown -R grimoire: /var/lib/grimoire`).
- **`git` not found, or errors while saving:** install Git and make sure it's on the server's `PATH` (systemd's `PATH` can differ from your shell's).
- **Which storage am I using?** The startup line says `storage: local` or `storage: codestorage`. An unset `STORAGE` picks Code Storage if its settings are present.

A guided onboarding flow for setting up your own server will come later.

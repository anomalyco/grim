# Grimoire

A multiplayer markdown notebook for people and agents.
- Open it in the browser and type: everyone in the same note sees edits and cursors live.
- The editor is a Bear-style live markdown editor, built from scratch.
- Every note is a Markdown file in a Git repo hosted on [Code Storage](https://code.storage). Edits are committed to the repo's main branch after 3 seconds of quiet, so the full history is there.
- Repos can be plain notebooks (hosted only in Code Storage) or linked GitHub repos (two-way sync via a GitHub App; only `.md` files are shown).
- Anyone signed in can add a public GitHub repo to browse its Markdown read-only: "+ GitHub repo" in the sidebar takes a repo URL (`/tree/<branch>` and `/blob/<branch>/<file>` URLs work too). It's refreshed from GitHub every 5 minutes. Locally these are shallow partial clones: file contents are only downloaded when read.
- Agents work on the same notes in a sandboxed bash shell and show up as participants with their own cursor. You hand one a notebook with a "Share with agent" link.

## Run

```bash
bun install
cp .env.example .env    # fill in Code Storage + GitHub App settings (see below)
bun run start           # builds the client and starts the server on $PORT (default 8787)
```

For local development without any accounts:
```bash
ALLOW_DEV_LOGIN=1 bun run dev
```
This stores repos as bare Git repos in `./data/git` and adds a name-only login form. Never set `ALLOW_DEV_LOGIN` on an internet-facing server.

### Production settings (`.env`)
- **Code Storage:**
  - Set `CODE_STORAGE_ORG` and `CODE_STORAGE_PRIVATE_KEY_FILE` (the private key from the org's Keys page).
  - Add a webhook pointing at `$PUBLIC_URL/webhooks/codestorage` and put its secret in `CODE_STORAGE_WEBHOOK_SECRET`. Without the webhook, outside pushes are still picked up by polling every 20 s.
- **GitHub App:**
  - Used for "Sign in with GitHub" and for repo sync. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_APP_SLUG`.
  - Callback URL: `$PUBLIC_URL/auth/github/callback`.
  - Permissions: Contents read & write, Metadata read.
  - GitHub's webhook URL for the app: `https://<org>.code.storage/webhooks/github`.
  - Register the app with Code Storage.
- **Who can sign in:** `ALLOWED_GITHUB_USERS` (comma-separated logins, or `*`). If it's empty, only the first person to sign in can, and they become admin.
- **Agents:** connect through a notebook's "Share with agent" link. See [Agents](#agents).

## Agents
Agents get one interface: a bash shell whose filesystem is the live notes of one notebook.
- In a notebook's **⋯** menu, **Share with agent…** shows a ready-to-copy prompt with your link for that notebook, `$PUBLIC_URL/a/<uuid>` (made the first time, the same one after that). Paste it to your agent. Whoever has the link can use that notebook and nothing else, with the notebook's access capped by yours (read-only notebooks stay read-only; if you lose access, so does the link). Removing the notebook removes its links.
- The app has no screen for managing links; `GET /api/repos/:id/shares` lists yours and `DELETE /api/shares/:id` revokes one (its creator, an admin or anyone who can edit the notebook). Revoking stops whatever the agent is running right away.
- A `GET` on the link returns plain-text instructions for the agent (what's in the notebook, how to call it, examples, limits).
- `POST` runs a command. The body is the command as plain text, or JSON `{"command", "session"?, "timeout_seconds"?}`; the response is `{stdout, stderr, exitCode, cwd, truncated}` (or plain text with `?format=text` / `Accept: text/plain`). `X-Agent-Name` sets the name on the agent's cursor and commits (default: the link's label); it's still one agent per link. Calls share one session (cwd, variables, `/tmp`) unless they send `session` or `X-Shell-Session`.
  ```bash
  curl -s -X POST "$LINK" --data-binary 'grep -rn TODO .'
  ```
- The shell starts in the notebook's folder, `/workspace/<repo>`; `/tmp` is private scratch space.
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
  - `store/`: Code Storage and local Git backends.
  - `ops.ts`: file operations shared by the API and the agent shell.
  - `shell/`: the agent shell (a just-bash interpreter over the live notes) and its sessions.
  - `shares.ts`: "Share with agent" links (`/a/<uuid>`): the agent prompt and command endpoint.
  - `mcp.ts`: the MCP endpoint (one `document_command` tool; browser sessions only).
  - `home.ts`: the home page doodle room (`/ws/home`, public): visitors' pencils and strokes plus server-side bots that write sayings. In memory only, rate- and size-limited; protocol in `src/shared/doodle.ts`.
  - `api.ts`, `auth.ts`, `repos.ts`.
- `bin/grimoire`: CLI for the agent shell (talks to a share link).
- `src/client/`: the browser app (vanilla TypeScript).
- `src/client/editor/`: the from-scratch live markdown editor.
- `src/client/doodle/`: the home page's 3D pencils (WebGL) and pencil marks (2D canvas), loaded only on the home page.
- `test/`: `bun test` (server and editor), plus `test/e2e/two-users.mjs` (two browsers and an agent through the real server).
- `tools/parity/`: plays the same keystrokes in Bear and in our editor on a Mac and compares what the user sees step by step.

## Docs
- [`docs/05-v1-architecture.md`](docs/05-v1-architecture.md): the current architecture and internal contracts.
- [`docs/04-editor-engine.md`](docs/04-editor-engine.md): Bear's measured interaction spec and the editor design.
- `docs/01`–`03`: earlier designs (OT/CRDT research, lock-based server), superseded.

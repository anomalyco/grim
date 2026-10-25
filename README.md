# Grimoire

A multiplayer markdown notebook for people and agents.
- Open it in the browser and type: everyone in the same note sees edits and cursors live.
- The editor is a Bear-style live markdown editor, built from scratch.
- Every note is a Markdown file in a Git repo hosted on [Code Storage](https://code.storage). Edits are committed to the repo's main branch after 15 seconds of quiet, so the full history is there.
- Repos can be plain notebooks (hosted only in Code Storage) or linked GitHub repos (two-way sync via a GitHub App; only `.md` files are shown).
- Agents work on the same notes in a sandboxed bash shell (over MCP, HTTP or a small CLI) and show up as participants with their own cursor.

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
- **Agents:** an admin creates an agent token in the app ("Agent tokens"). See [Agents](#agents).

## Agents
Agents get one interface: a bash shell whose filesystem is the live notes.
- `/workspace/<repo>/...` has the Markdown files of every repo the agent can access; `/tmp` is private scratch space.
- Writes show up live in people's editors (with the agent's cursor) and are committed after 15 s of quiet, or right away with `save`. A rewrite keeps edits people made since the agent read the file (or fails if they touched the same spot).
- Extra commands: `repos`, `save [path]`, `who <file>`, `watch [path] [--timeout S]`, and read-only `git log|show|diff|status`.
- Standard tools work (`ls cat grep sed awk find jq diff ...`). There's no python, node or network.

**MCP:** one tool, `bash`, at `$PUBLIC_URL/mcp`. Each MCP session keeps its own cwd and variables. For example, in Claude Code's `.mcp.json`:
```json
{
  "mcpServers": {
    "grimoire": {
      "type": "http",
      "url": "https://grimoire.example.com/mcp",
      "headers": { "Authorization": "Bearer grim_..." }
    }
  }
}
```

**CLI:** `bin/grimoire` (needs Bun; `bun link` puts `grimoire` on your PATH):
```bash
export GRIMOIRE_URL=https://grimoire.example.com GRIMOIRE_TOKEN=grim_...
# or put {"url": "...", "token": "..."} in ~/.config/grimoire/config.json (chmod 600)
grimoire 'grep -rn TODO /workspace/notes'      # run one command (or -c '...'); exits with its exit code
grimoire -t 110 'watch /workspace/notes/plan.md'
grimoire                                         # interactive shell (prompt shows the cwd)
```
One-off commands share a default session, so `cd` carries over. Set `GRIMOIRE_SESSION=<name>` to use a separate one; the interactive shell prints its session name when it starts.

**HTTP:** `POST /api/shell` with `Authorization: Bearer <token>` and `{"command": "...", "session": "optional", "timeout_seconds": 30}` returns `{stdout, stderr, exitCode, cwd, truncated?}`.

## Layout
- `src/server/`: the Bun server.
  - `index.ts`: HTTP, WebSocket and wiring.
  - `rooms.ts`: live Yjs rooms. Each has a crash-safe log, does a 3-way merge of outside pushes, and commits after a quiet period.
  - `store/`: Code Storage and local Git backends.
  - `ops.ts`: file operations shared by the API and the agent shell.
  - `shell/`: the agent shell (a just-bash interpreter over the live notes) and its sessions.
  - `mcp.ts`: the MCP endpoint (one `bash` tool).
  - `api.ts`, `auth.ts`, `repos.ts`.
- `bin/grimoire`: CLI for the agent shell.
- `src/client/`: the browser app (vanilla TypeScript).
- `src/client/editor/`: the from-scratch live markdown editor.
- `test/`: `bun test` (server and editor), plus `test/e2e/two-users.mjs` (two browsers and an agent through the real server).
- `tools/parity/`: plays the same keystrokes in Bear and in our editor on a Mac and compares what the user sees step by step.

## Docs
- [`docs/05-v1-architecture.md`](docs/05-v1-architecture.md): the current architecture and internal contracts.
- [`docs/04-editor-engine.md`](docs/04-editor-engine.md): Bear's measured interaction spec and the editor design.
- `docs/01`–`03`: earlier designs (OT/CRDT research, lock-based server), superseded.

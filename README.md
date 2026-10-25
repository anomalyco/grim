# Notepad

A multiplayer markdown notepad for people and agents.
- Open it in the browser and type: everyone in the same note sees edits and cursors live.
- The editor is a Bear-style live markdown editor, built from scratch.
- Every note is a Markdown file in a Git repo hosted on [Code Storage](https://code.storage). Edits are committed to the repo's main branch after 15 seconds of quiet, so the full history is there.
- Repos can be plain notebooks (hosted only in Code Storage) or linked GitHub repos (two-way sync via a GitHub App; only `.md` files are shown).
- Agents read and write the same notes through an MCP endpoint and show up as participants with their own cursor.

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
- **Agents:** an admin creates an agent token in the app ("Agent tokens"). Point an MCP client at `$PUBLIC_URL/mcp` with `Authorization: Bearer <token>`.

## Layout
- `src/server/`: the Bun server.
  - `index.ts`: HTTP, WebSocket and wiring.
  - `rooms.ts`: live Yjs rooms. Each has a crash-safe log, does a 3-way merge of outside pushes, and commits after a quiet period.
  - `store/`: Code Storage and local Git backends.
  - `ops.ts`: file operations shared by the API and MCP.
  - `api.ts`, `auth.ts`, `mcp.ts`, `repos.ts`.
- `src/client/`: the browser app (vanilla TypeScript).
- `src/client/editor/`: the from-scratch live markdown editor.
- `test/`: `bun test` (server and editor), plus `test/e2e/two-users.mjs` (two browsers and an agent through the real server).
- `tools/parity/`: plays the same keystrokes in Bear and in our editor on a Mac and compares what the user sees step by step.

## Docs
- [`docs/05-v1-architecture.md`](docs/05-v1-architecture.md): the current architecture and internal contracts.
- [`docs/04-editor-engine.md`](docs/04-editor-engine.md): Bear's measured interaction spec and the editor design.
- `docs/01`–`03`: earlier designs (OT/CRDT research, lock-based server), superseded.

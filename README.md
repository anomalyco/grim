# Grim

**A multiplayer Markdown notebook for people and agents.**

Grim is a place to write notes together. Open a note and start typing: everyone who has it open sees your words and your cursor as you write, and AI agents can join in too. Your notes are plain Markdown files, saved in Git, so nothing is locked in and every version is kept.

- **Write together, live.** Share a link and edit the same note at the same time, with everyone's cursor on the page.
- **Plain Markdown, with full history.** Every note is a Markdown file in a Git repo. Notes save themselves a few seconds after you stop typing, and **History** shows every version.
- **Bring in an AI agent with a link.** Copy a workspace's agent link into your agent's chat, and it can read and edit your notes alongside you. The link is a shell over the workspace that the agent calls over plain HTTP (curl), so there's nothing to install.
- **Images just work.** Drop or paste one into a note.
- **A Mac app**, for the same notes in a native window.

## Get started

1. Go to **[grimnotes.app](https://grimnotes.app)**.
2. Try the **demo workspace**: a playground anyone can edit, no account needed.
3. **Sign in**, then create your own workspace with **New…** in the workspace switcher at the top left. Inside a workspace, organize notes into folders.
4. Invite people by sending them a note's link.
5. To bring in an agent, click **Copy** on **Share this workspace with an agent** at the bottom of the sidebar, and paste it to your agent. It fetches the link for its instructions, then runs commands by POSTing them to it.

Workspaces on grimnotes.app are public: anyone with the link can read and edit them. For private notes, run your own server (below).

**Mac app:** there's no download yet. You can build it from source; see the [technical docs](docs/README.md#repository-layout).

## Self-host in 2 minutes

Your own Grim server keeps your notes on your own machine: no accounts, no outside services. All you need is [Bun](https://bun.sh) and Git, on Linux or macOS.

```bash
git clone https://github.com/anomalyco/grim.git grim && cd grim
bun install
printf 'STORAGE=local\nHOST=127.0.0.1\n' > .env
bun run start
```

Open **<http://localhost:8787/app>**: there's no sign-in, and you can create workspaces and notes right away. Your notes are saved as Git repos in the `data` folder.

**Sign-in is off by default:** everyone who can reach the server can do everything, which is why the quick start listens on `127.0.0.1` only. Keep a shared server on a private network (or behind your own auth), or turn on Google sign-in with `SIGN_IN=on` ([self-hosting guide: Sign-in](docs/self-hosting.md#sign-in)).

Want to share it with others, put it behind HTTPS, run it as a service or back it up? The **[self-hosting guide](docs/self-hosting.md)** covers all of it.

## Learn more

- [Self-hosting guide](docs/self-hosting.md): setup, configuration, sign-in options, HTTPS, backups and upgrades.
- [Technical docs](docs/README.md): how Grim is built, development setup, tests, the agent API and the architecture.

The landing page at [grimnotes.app](https://grimnotes.app) (pencils that write, the intro note) lives in `src/client/landing/`, all in the browser (the bots too: no server sync); it's only on with `MARKETING_SITE=on` (set for grimnotes.app and staging). To preview it locally: `MARKETING_SITE=on bun run start`, then open <http://localhost:8787/>. Without it, `/` opens the app.

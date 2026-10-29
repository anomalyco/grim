# Grimoire

**A multiplayer Markdown notebook for people and agents.**

Grimoire is a place to write notes together. Open a note and start typing: everyone who has it open sees your words and your cursor as you write, and AI agents can join in too. Your notes are plain Markdown files, saved in Git, so nothing is locked in and every version is kept.

- **Write together, live.** Share a link and edit the same note at the same time, with everyone's cursor on the page.
- **Plain Markdown, with full history.** Every note is a Markdown file in a Git repo. Notes save themselves a few seconds after you stop typing, and **History** shows every version.
- **Bring in an AI agent with a link.** Copy a workspace's agent link into your agent's chat, and it can read and edit your notes alongside you.
- **Images just work.** Drop or paste one into a note.
- **A Mac app**, for the same notes in a native window.

## Get started

1. Go to **[grimnotes.app](https://grimnotes.app)**.
2. Try the **demo workspace**: a playground anyone can edit, no account needed.
3. **Sign in**, then create your own workspace with **New…** in the workspace switcher at the top left. Inside a workspace, organize notes into folders.
4. Invite people by sending them a note's link.
5. To bring in an agent, click **Copy** on **Share this workspace with an agent** at the bottom of the sidebar, and paste it to your agent.

Workspaces on grimnotes.app are public: anyone with the link can read and edit them. For private notes, run your own server (below).

**Mac app:** there's no download yet. You can build it from source; see the [technical docs](docs/README.md#repository-layout).

## Self-host in 2 minutes

Your own Grimoire server keeps your notes on your own machine: no accounts, no outside services. All you need is [Bun](https://bun.sh) and Git, on Linux or macOS.

```bash
git clone https://github.com/anomalyco/grim.git grimoire && cd grimoire
bun install
printf 'STORAGE=local\nHOST=127.0.0.1\n' > .env
bun run start
```

Open **<http://localhost:8787/app>**: you can read and edit the notes right away, without an account. Sign-in is with Google: add a Google OAuth client ([self-hosting guide](docs/self-hosting.md#google)) to create workspaces and notes. Your notes are saved as Git repos in the `data` folder.

Want to share it with others, put it behind HTTPS, run it as a service or back it up? The **[self-hosting guide](docs/self-hosting.md)** covers all of it.

## Learn more

- [Self-hosting guide](docs/self-hosting.md): setup, configuration, sign-in options, HTTPS, backups and upgrades.
- [Technical docs](docs/README.md): how Grimoire is built, development setup, tests, the agent API and the architecture.

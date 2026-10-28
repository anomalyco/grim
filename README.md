# Grimoire

A multiplayer markdown notebook for people and agents.
- Open it in the browser and type: everyone in the same note sees edits and cursors live.
- The editor is a Bear-style live markdown editor, built from scratch. Its engine is Rust (`editor-core`, shared with the native Mac app) compiled to WebAssembly; it also owns the note's shared document (yrs) in the browser.
- Every note is a Markdown file in a Git repo, hosted on [Code Storage](https://code.storage) or on the server's own disk ([run your own server](docs/README.md#run-your-own-server-no-code-storage)). Edits are committed to the repo's main branch after 3 seconds of quiet, so the full history is there.
- **New note** makes `Untitled.md` (`Untitled 2.md`, …) right away; type a first-line heading (`# Trip plans`) and press Enter, and the note is named after it (`Trip plans.md`), once.
- Drop images onto a note (or paste a screenshot): they're uploaded into the notebook (`images/` next to the note) and shown inline.
- Repos can be plain notebooks (only in the server's storage) or linked GitHub repos (two-way sync via a GitHub App; only `.md` files are shown).
- Anyone signed in can add a public GitHub repo to browse its Markdown read-only: "+ GitHub repo" in the sidebar takes a repo URL (`/tree/<branch>` and `/blob/<branch>/<file>` URLs work too). It's refreshed from GitHub every 5 minutes. Locally these are shallow partial clones: file contents are only downloaded when read.
- Agents work on the same notes in a sandboxed bash shell and show up as participants with their own cursor. You hand one a notebook with a "Share with agent" link.

Development, the repository layout, server settings, the agent API and the architecture: see the [technical docs](docs/README.md).

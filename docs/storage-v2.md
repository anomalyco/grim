# Storage v2: notes in SQLite, no Git

*Spec, 2026-11-09. Target: staging and Grim Beta (branch `editor-improvements`). Author: Claude Opus 5.5 (`opencode/claude-opus-5-5`).*
*Background: [the storage research report](../../website/artifacts/grim-storage/report.md) (`/root/projects/website/artifacts/grim-storage/report.md`).*

**The owner's decisions**
- No Git. A new, simple store.
- Keep Yjs for live editing. The server stays the central authority: changes are never lost, and offline is short.
- Agents get a shell over **one file**: `sed`, `cat`, `grep`, `awk` and so on, on a single note. There's no filesystem tree.
- Agents get a `history` command.
- Build the smallest architecture that works.

**The rule:** text, versions and line authors are the truth. The Y.Doc is a merge cache that can be rebuilt from the text at any time by bumping the note's **epoch**.

---

## 1. Data model

One SQLite database per workspace: the WorkspaceDO's SQLite on Workers. On Bun, everything goes in the server's `grimoire.sqlite`, with a `ws` column. Both reach it through the existing synchronous `RoomStorage` seam. The code is `src/server/notes/store.ts` (`NoteStore`).

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,            -- stable note id ("n_…"); the path is just a column
  ws TEXT NOT NULL,
  path TEXT NOT NULL,             -- "folder/note.md"
  text TEXT NOT NULL,             -- the current text, compacted (the truth together with note_updates)
  epoch INTEGER NOT NULL,         -- bumped when the Y.Doc is rebuilt from text (import, demo reset, backup restore)
  authors TEXT,                   -- JSON {people, lines, history}: line authors at `text` (§6)
  pending TEXT,                   -- JSON: the open version {started, last, authors[]} (§3)
  created_at INTEGER, updated_at INTEGER, deleted_at INTEGER
);
CREATE UNIQUE INDEX notes_path ON notes(ws, path) WHERE deleted_at IS NULL;
-- the Y.Doc state at `text`, in RoomStorage blobs (chunked on DO): key "ydoc:<note id>"
CREATE TABLE note_updates (note_id TEXT, epoch INTEGER, seq INTEGER, data BLOB, author INTEGER,
  PRIMARY KEY (note_id, seq)) WITHOUT ROWID;   -- the tail since the last compaction (the old crash log)
CREATE TABLE versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- shown as "v<id>": the API's "sha"
  ws TEXT NOT NULL, note_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- edit | agent | restore | rename | delete | import
  path TEXT NOT NULL,             -- the note's path when cut
  started_at INTEGER, ended_at INTEGER,
  authors TEXT NOT NULL,          -- JSON [{id, name, email, kind, edits}], main author first
  message TEXT,
  text TEXT NOT NULL,
  line_authors TEXT               -- JSON {people, lines}
);
CREATE INDEX versions_note ON versions(note_id, id);
CREATE VIRTUAL TABLE notes_fts USING fts5(note_id UNINDEXED, ws UNINDEXED, path, text, tokenize = 'trigram');
CREATE TABLE images (ws TEXT, path TEXT, sha256 TEXT, type TEXT, size INTEGER, by TEXT, created_at INTEGER,
  PRIMARY KEY (ws, path)) WITHOUT ROWID;
```

- **Images:** the bytes are content-addressed at `<ws>/<sha256>`, in R2 (`IMAGES` binding, bucket `grim-staging-images`) on Workers and in `$DATA_DIR/images/` on Bun. The `images` table maps paths to hashes. An upload with the same bytes reuses the hash.
- **Workspaces** stay in D1/`grimoire.sqlite` (`repos`). `kind`, `branch`, `gh_*` and `head` are unused leftovers, and `kind = 'github'` rows are deleted (migration `0009`).
- **Demo rooms:** each demo room's WorkspaceDO uses its own SQLite through the same `NoteStore`; on Bun, an in-memory `bun:sqlite`. A reset deletes the room's notes and reseeds them with **new epochs**. `MemoryStore` and `memory-persist` are gone.

## 2. Rooms and the Yjs protocol

The wire protocol doesn't change: v1 and v2 framing, sync, awareness and control. Only the meaning of three things changes:

- **Epoch instead of generation.** `hello.generation` is `"<note id>.<epoch>"`. It's persisted, so it stays the same when a room closes, reopens, hibernates, recovers after an eviction, after a deploy or after a rename. A reconnecting client sees the same generation and does an ordinary state-vector sync, which sends its offline edits. **This fixes the data-loss bug:** today a room reopened from Git got a new generation, and the client dropped its unsent edits.
- **Merge on reset.** When the generation really differs (the epoch was bumped), clients don't drop their edits. They keep the session's edits (`recover_unsent`) together with the text they started from and their current text, reopen, and **3-way merge** that change onto the server's text. They reuse the crash-recovery path (`editor-rs/recover.ts`, `merge3`). The Mac app does the same in `remote.rs`.
- **Ack after a durable write.** Updates are buffered for 250 ms and written as one `note_updates` row. After the write, each connection whose updates were in it gets `{t:"ack", n}`, where `n` counts the sync frames from that connection that are now durable. On Workers, output gates hold the ack until the write is durable. Clients ignore unknown `t`.
- **The server doc uses `gc: true`.** Snapshots and `absorb` are gone, so nothing needs `gc: false`.
- **Room lifetime:** a room loads the doc blob, replays the tail, and rebuilds line authors (synchronously, so `wake()` still needs no network). **Compaction** writes `text`, the doc blob and `authors`, then empties the tail. It runs on version cuts, on close, and when the tail reaches 500 rows. Rooms still close 55 s after the last connection. Closing compacts but never drops anything.
- **Local persistence on the client.** The web client keeps its unsent edits in IndexedDB (`grimoire-unsent`, per user and note: generation, base text, text, Yjs update). It writes them 400 ms after each local edit and on `pagehide`, and clears them when an ack covers every frame it sent and nothing changed since. On the next load of that note, the existing recovery merge applies them: by Yjs in the same generation (idempotent), else by text merge. Client IDs are never persisted.

## 3. Versions

A version is a plain-text snapshot of the note with the people who made it. One version stays open per note (`notes.pending`: start, last edit, contributors with their edit counts). It's cut, meaning written to `versions` with the current text and line authors, under these conditions:

| Trigger | Kind |
|---|---|
| ~5 min without edits (`VERSION_IDLE_MS`) | edit |
| ~30 min of continuous editing (`VERSION_SPAN_MS`) | edit |
| before and after each **agent command** that writes: people's pending edits are cut first, then the agent's write is its own version | agent |
| restore | restore |
| rename / delete | rename / delete |

- A change of human author doesn't cut a version. Contributors are recorded inside the version, main author first.
- Idle versions are cut by the room's timer (Bun) or by the WorkspaceDO alarm, which runs `store.cutIdle(now)`. Both are plain SQL, so closed notes get cut too.
- **Dirty state:** `status.dirty` is true while a version is open, and `commit` is the newest version id.

## 4. History, diff, file and restore (HTTP shapes kept)

- `GET /api/workspace/:id/history?path=&limit=` → `[{ sha, message, authorName, authorEmail, date }]`, newest first.
  - `sha` is the version id ("v47").
  - `authorName`/`authorEmail` are the main author's (guests: `"<name> (guest)"` / `guest@grimoire.invalid`; agents: `…@agents.grimoire`).
  - `message` is `"Update <path>"` (`Restore …`, `Rename … to …`, `Delete …`), with `Co-authored-by:` lines for the other contributors.
- `GET …/diff?sha=&path=` → `{ diff }`: a unified diff of that version against the note's previous one.
- `GET …/file?path=&ref=` → `{ content, version, live }`. `ref` is a version id; without it, you get the live text.
- `POST …/restore {path, sha}`: a minimal-diff edit by the restorer, cut as a `restore` version.
- The Mac app and the web client need no changes for these, beyond not assuming Git.

## 5. Review mode

The rule is the same: the latest author's batch. It works on versions because their shape is the same. The newest run of versions with the same main author is diffed against the version before it, and live edits not yet cut belong to whoever made them (line authors). The code doesn't change (`src/client/review.ts`, Mac `review_mode.rs`).

## 6. Line authors and undo authorship

- They're stored with the note (`notes.authors`) and with every version (`line_authors`).
- The `attribute()` algorithm and `LineMemory` (undo gives a line back to its author) are unchanged, and are replayed from the tail on wake. The difference is that there are no origin lines and no Git blame.
- Imported notes get their line authors once, at import, from their imported versions (`blameFromVersions`).

## 7. Search

FTS5 with the trigram tokenizer over `notes_fts`, updated when a version is cut and on create, rename and delete. Queries of 3 or more characters use `MATCH`. Shorter ones scan with `instr`. The result shape `{hits: [{path, line, text}]}` is kept: the lines are found in the matching notes' text.

## 8. The single-file agent shell

- **`POST /app/<ws>/<path>`** runs a command with only that note visible: `./<name>.md` in an otherwise empty working directory `/note`. It's a fresh just-bash `Bash` per command over an `InMemoryFs`. There's no `/workspace`, no `/tmp` that persists, no other notes, and no sessions.
  - `cd`, `ls ..` and `cat ../x` see only that empty tree.
  - The body is the command as text, or `{command, timeout_seconds?}` in JSON.
  - The response is the same as before: `{stdout, stderr, exitCode, truncated}`, or text with `?format=text`.
- **Writes:** if the command changed the file, the change (read text → written text) is applied as a **3-way patch** into the live room by the agent (people see it live, with a cursor). It's refused with "changed by someone else" if it overlaps edits made meanwhile, and cut as an `agent` version. Any other file the command creates is discarded, with a note on stderr. Deleting or renaming the file isn't possible from the shell.
- **The shell runs in the workspace's runtime** (the WorkspaceDO on Workers, in-process on Bun), so the note is read and written with no RPC. Limits are per caller and workspace: 120 calls a minute and 4 at a time. The time limit is 30 s by default and 110 s at most, and output is capped at 200 KB per stream.
- **Built-ins:**
  - `history [n]`: versions, newest first (`<id> <date> <author> <kind>`).
  - `history show <id>`: that version's text.
  - `history diff <id>`: that version against the one before it.
  - `who`: who has the note open.
  - `whoami`.
- **Creating a note:** POST to a path that doesn't exist with a body that writes it (`cat > x.md <<'EOF'`). The note is created if the caller may create notes (an account, or a workspace open to guests).
- **`GET /app/<ws>`** (non-browser) lists the notes, with their note URLs, and explains the per-note shell. `GET /app/<ws>/<path>` still answers the note's Markdown. `POST /app/<ws>` answers 405 with a pointer to the note URLs.
- **MCP:**
  - `list_workspaces` (unchanged).
  - `list_notes {workspace}`.
  - `note_command {note, command, timeout_seconds?}`, where `note` is a note URL (`https://…/app/<ws>/<path>`) or `<ws>/<path>`.
  - It runs the same shell through the workspace's runtime. The `ShellDO` is deleted (wrangler migration `v3`).
- **Share-with-agent prompts** point at the workspace URL. The agent picks a note per command.

## 9. What goes away

- `GitStore` and every store: `LocalGitStore`, `CodeStorageStore`, `MemoryStore`, `RoutedStore`, `CachedHeadStore`, `memory-persist`, `unified`'s Git use, `gitexec`, `store/blame`.
- Commits, webhooks, `EXTERNAL_SYNC`, outside-push merging (`absorb`, `checkRemote`, `onPush`), heads, `repos.head` writes, Git blame (`resolveAuthors`' Git half, origin lines).
- GitHub workspaces, both linked and read-only: import, refresh, the cron job, `POST /api/workspaces {github}`, `github.ts` lookups, and the client UI. GitHub *sign-in* stays.
- The multi-file `NotesFs`, `ShellFs`, `ShellSessions`, the `ShellDO`, `POST /api/shell`, `/app/<ws>/changes` and the `changes` tool and command, `git` and `save` in the shell, and `snapshot`/`applyWrites`.
- The `@pierre/storage` dependency, and the `CODE_STORAGE_*` vars and secrets on staging once the import is done.

## 10. What stays

Workspaces, folders as path prefixes, the tree, renames (note and folder), deletes, images, guests, app tokens, OAuth, MCP, the v1 and v2 socket protocols the Mac app speaks, demo rooms, the landing page and metrics.

## 11. Export and backup

- `GET /api/workspace/:id/export` returns a zip: every note's Markdown at its path, the images, and `.grim/versions.json` (every version's metadata and text).
- A **nightly cron** (`0 3 * * *`) writes each workspace's export to R2 at `backups/<ws>/<date>.zip`. On Bun, a nightly copy goes to `$DATA_DIR/backups/`.
- **After a point-in-time restore** of a DO, bump every note's epoch (`POST /api/admin/bump-epochs`, same bearer). Clients then merge by text instead of re-sending rolled-back updates.

## 12. Migrating staging

1. Before the deploy, `scripts/export-staging.ts` dumps every staging workspace (from D1's `repos`) through the old HTTP API: the tree, each note's text, its last 30 commits (`history` + `file?ref=`) with authors and dates, and the images (`raw`).
2. After the deploy, `scripts/import-staging.ts` posts each dump to `POST /api/admin/import` (bearer `IMPORT_TOKEN`, a staging-only secret; the route is 404 without it). This creates the notes, their imported versions (`kind: import`, the original authors and dates) and line authors from them.
3. The script checks every note's text against the dump. The Code Storage repos (`stg-*`) are left untouched as a backup. The `CODE_STORAGE_*` bindings are removed from the staging config.

Edits made between the export and the import are lost (a window of minutes, on staging). The agents workspace (`agents-a9v5b4v5vg42`) is exported last and checked first.

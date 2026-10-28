# Folder switcher: web ↔ Mac parity (2026-10-28, public folders)

Reference: multiplayer-notepad `src/client/main.ts` (`openSwitcher`, `openAccountMenu`, `leaveWorkspace`,
`removeRepo`, `changeName`, `logout`, the sidebar's agent card), `workspaces.ts` (the New / Open dialogs),
`dialogs.ts`, `api.ts`; server `api.ts`, `workspaces.ts`, `shares.ts`, `tokens.ts` (`7e925d3`: every folder is
public). Mac: `crates/app/src/menu.rs` (items), `switcher.rs`, `dialogs.rs`, `actions.rs`.

Since the server's `7e925d3` every folder on a server is public: anyone signed in opens and edits it (read-only
GitHub copies are read-only); only its maker may remove it (`canRemove`). There are no members, invites, roles,
link access, domain rules, note links or Settings in either app; privacy means running your own server.

## How it was checked (re-recorded on the public-folders server)

- Scratch server on the Linux box: multiplayer-notepad `e5e63c6` (server `7e925d3` + the web's account row),
  `qa-scratch.mjs`, `W3_HOST=100.73.96.98 W3_PORT=47395`, temp `DATA_DIR`, fake Google on; `/api/server` said
  `version: 2026-10-28.public`. Killed and its data deleted afterwards.
- Mac: `GRIMOIRE_QA_SERVER=http://100.73.96.98:47395 GRIMOIRE_QA_GOOGLE_HOST=100.73.96.98 GRIMOIRE_QA_AGENT_WAIT=120
  cargo test --release -p grimoire parity_against_a_server -- --ignored --nocapture` (`src/remote_qa.rs`):
  9 × `QA PASS`, `test result: ok`. While it waited, the Linux box POSTed `echo hi > agent-was-here.md` to the agent
  link the Mac copied from the sidebar card (`PARITY AGENT-URL http://100.73.96.98:47395/a/<uuid>`); the tree's
  3 s poll then listed `agent-was-here.md`.
- Web: `BASE=… LINKED=linked-xydk PARITY=parity-qa-r9et OUT=… bun parity-web.mjs` (headless Chromium): James's
  switcher on "Parity QA" (made by the Mac user) and on "Linked" (made by James), and his account menu.
- `menu::tests::matches_the_web_menu_captured_on_the_scratch_server` replays those menus against the Mac's model:
  equal item for item; the account menu equal once the Mac-only "Switch account" is taken out.
- Also against the same server: `qa_flows_against_a_server` (another account's folder opens and takes edits, a
  missing folder → "No such workspace", the joined list, Switch account, notes create/rename/delete, token revoked
  → Reconnect, offline → recovers, deleted while open, Disconnect revokes: 14 × `QA PASS` with the setup),
  `new_remote_folder_against_a_server` (never connected → connect flow → created and opened, `canRemove`), and
  `remote::tests::integration_against_a_server` with `bob.mjs` (live edits and carets both ways): all `ok`.

Changed after the recording (both apps, 2026-10-28): the server headings read just the host
("100.73.96.98:47395", not "On 100.73.96.98:47395"); the captures below and
`menu::tests::matches_the_web_menu_captured_on_the_scratch_server`'s fixture were edited by hand to match.

Captured (web, Chromium):

    other:   100.73.96.98:47395 | Linked | • Parity QA | — | New Workspace… | Open Workspace…
    maker:   100.73.96.98:47395 | • Linked | Parity QA | — | New Workspace… | Open Workspace… | — | Remove workspace…
    account: james@example.com | Change name… | Sign out

Captured (Mac, real server):

    other:   100.73.96.98:47395 | • Linked | — | New Workspace… | Open Workspace…
    maker:   100.73.96.98:47395 | Linked | • Parity QA | — | New Workspace… | Open Workspace… | — | Remove workspace…
    account: mac-user-5cjq@dev.grimoire | Change name… | Switch account | Sign out
    local:   This Mac | • folder-a | 100.73.96.98:47395 | Parity QA | — | New Workspace… | Open Workspace…

## Check list (web item → Mac item)

| # | Web (label · order · rule) | Mac | Result |
|---|---|---|---|
| 0 | One order whichever folder is open: servers by host, folders by name (case-insensitive, natural, ties by id; web `55b1e10`) | the same rule (`menu::natural_cmp`, `folder_cmp`), This Mac first | PASS (same input → same order: `menu::tests::natural_order_matches_the_web` replays names and hosts sorted by the web's comparator in bun; `…::the_order_is_the_same_whichever_folder_is_open`) |
| 1 | Section heading with the server's host ("grimoire.exe.xyz"; "On <host>" until 2026-10-28) | same text | PASS |
| 2 | Joined folders by title, a dot on the open one, an × on each, shown only while the row is hovered or keyboard-focused; the × asks "Remove <name> from your list?" (remote / local texts), Remove / Cancel, then toast "Removed <name> from your list"; the only folder in the list: "Can't remove your only workspace" (New workspace… / OK) | same words and buttons, the × shown while the pointer is over the row or the row has the keyboard highlight (its space reserved); Up/Down/Return, Delete/Backspace = ×, Esc | PASS (real: Linked left, gone from `/api/workspaces`) |
| 3 | Open folder not joined: listed, checked, no × | same | PASS (unit) |
| 4 | "No workspaces yet" (disabled) when none | same | PASS (unit) |
| 5 | A <host> heading per remembered remote server (its × forgets it) | A <host> heading per other connected server: its joined folders, the × leaves with that server's token | DIFFERS (the Mac has a token per server) |
| 6 | — | "This Mac" (local folders, × on hover, not on the open one: the local "Remove <name> from your list?" confirm) | Mac only |
| 7 | sep · "New Workspace…" · "Open Workspace…" | same | PASS |
| 8 | Open: URL ("Remote folder" until 2026-10-28; a folder's or a note's link: nested, encoded, old `/r/`, `.md` added; the folder opens at the note, or "No note at “<path>”"; the hint and error texts), GitHub repo (Read-only / Edit with the app) | same labels, texts and behaviour (both apps changed together: it matches), plus Mac-only Folder (system picker) | PASS (unit: `actions::tests::open_url_takes_folder_and_note_links`; + Mac extra) |
| 9 | New: Name / Create on this server; toast "Created “…”" | New → Remote folder: Server (the open folder's server, else the first connected one, else https://grimoire.exe.xyz/) + Name / Create, the connect flow first when not connected; plus Mac-only New → Folder | PASS (real: connect → created, opened) |
| 10 | sep, then only with an open folder: "Open on GitHub" (GitHub copies), "Remove workspace…" (`canRemove`, its maker; confirm "Remove “…” from Grimoire for everyone who has it?") | same | PASS (real: maker yes, others no; repo 404 after) |
| 11 | Sidebar card "Share this workspace with an agent" + Copy: `POST /api/repos/:id/shares` (one link per person per folder), the prompt copied, "Copied" | same, prompt word for word, on every remote folder; plus local folders (path instructions) | PASS (real: the Linux box's shell command through the link showed up) |
| 12 | Account row at the bottom of the sidebar; its menu upward: the email (no @localhost email), Change name…, Sign out | same, the open folder's server's account, plus "Switch account"; signed out: Reconnect / Forget; no row for a local folder | PASS (real + unit) |
| 13 | "Change name…" (Name / Save, `PATCH /api/me`) | same; the room reconnects with the new name | PASS (real: `/api/me` "Mac Parity") |
| 14 | "Sign out" (`POST /auth/logout`, no confirm) | "Sign out" with a confirm: revokes this app's token (`DELETE /api/tokens/:id`), forgets it | PASS (real: token → 401) |
| 15 | A missing folder: "No such workspace" | same page ("“<id>” doesn't exist on <host>."), Remove | PASS (real + unit) |
| 16 | — | Open → Folder from a remote and from a local folder | PASS (real: both opened) |

Removed from both apps with `7e925d3` (and from this list): Share folder… (members, invites, roles, link access,
domain rule, Copy link), the note header's Share and note links ("Shared with me" on the web), Settings
(connected apps), viewer read-only, the leave confirm and owner rules (`canLeave`), and the "No access" page.

## The order, checked against the web's comparator

The web sorts with `a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })`, ties by id
(`src/client/main.ts`, `55b1e10`). Run in bun on the Linux box over the same names and hosts, it gave:

    names: 2 things|i, 10 things|h, alpha|c2, Alpha|d, b|e, B2|f, b10|g, notes 1|c, Notes 2|b, notes 02|j, notes 10|a, team|s, Team|t, Zeta|z
    hosts: 2.example, 10.0.0.2:3000, 100.73.96.98:3000, b.example, Grimoire.example, grimoire.exe.xyz

`menu::tests::natural_order_matches_the_web` sorts the same input with the Mac's `natural_cmp` and gets these
lists exactly. Not covered: accented letters (the web's collation folds "Ä" to "a"; the Mac compares them after
"z") and punctuation such as `_`, where ICU's order differs from code-point order.

## What differs, and why

- **Open → Folder, New → Folder, New → Remote folder's Server field, This Mac, Switch account**: Mac only
  (folders on disk; one app token per server to replace).
- **Sign out** asks first and revokes only this app's token (the web ends the browser session).
- **This Mac** comes first in the Mac's list (the web has no local folders).
- **Other servers' headings** (their hosts) list the folders joined on the other servers the app has tokens for, and their ×
  leaves there (the web lists the remote folders a browser remembers, its × forgets them); a signed-out one
  says so with Reconnect / Forget.
- **Keyboard**: both apps take the same keys in the tree (focus areas tree / editor, one current row in a
  light blue focus style, Up/Down/Left/Right/Home/End, Return, Tab, Esc, type-ahead; a click on a row or ⌘⇧E get into it) and in the switcher (arrows, Return, Delete/Backspace on a folder row
  for its ×, Esc). Unit: `sidebar::tests::the_tree_moves_with_the_keys_and_keeps_them_from_the_editor`,
  `…::typeahead_waits_a_second`,
  `menu::tests::the_switcher_takes_arrow_keys`. The focused row is shown only by its background on both
  (the web's `color-mix(in srgb, var(--blue) 18%, var(--paper-2))` = the Mac's `#d0dce5`); no left bar.
- **Guests**: both open, read and edit any folder without an account, as the same kind of guest (a random id,
  a silly name, the same colour rule; REST `X-Grimoire-Guest*` headers, the room's `anon`/`name`/`color`;
  commits "<name> (guest)"); the account row says "Sign in"; no agent card; no GitHub repo in Open; New Workspace… on a
  server needs an account (the server refuses guests). DIFFERS on purpose: the web's Open Workspace… asks a guest to
  sign in, the Mac's opens folders and URLs as a guest. Unit: `remote::tests::open_by_url_works_as_a_guest`,
  `…::a_guest_reads_and_writes_with_the_guest_headers`, `actions::tests::a_guest_gets_no_github_repo_choice`;
  real server: `qa_flows_against_a_server` step 0 (PASS: committed as "wobbly-goblin (guest)", no browser).
- **A revoked token**: the Mac notices at launch, when its window comes to the front (`GET /api/me`) and on any
  401, drops it, says "Signed out of <host>" and goes on as a guest in the open folder (still editable); the web's
  session ends with the browser's sign-out. Real server: `qa_flows_against_a_server` step 7 (PASS: token
  deleted on the web → guest, editable → Sign in → James again). The whole QA flow passes end to end.
- **Header**: the same breadcrumb, avatars (6 then +N, "(you)", guest ring, AI badge, the same initials and
  colours), save status (nothing while connected; "Offline — changes will sync when reconnected" / "Offline" /
  "Connecting…" / "Read-only" as the web's; `remote::tests::a_dropped_room_reconnects_back_to_saved_not_loading`), Authors (pressed = grey) and History. DIFFERS: no burger (the Mac has ⌘\ for the
  sidebar); local notes have a header with the breadcrumb and History only (History from `git` in a Git
  repository, disabled otherwise).
- **History**: the same drawer, list, diff colours, View/Diff, Restore confirm and toast, empty and loading texts,
  live refresh on a new commit (the web: its event stream's `saved`; the Mac: the room's save state). Unit:
  `history::tests::*` (the server's endpoints through the fake server; a real `git` repository).
- **Line authors**: the same message, rules and look (muted 11 px names, no colour, full names or none, 16 from
  the pane's left edge on the line's baseline, single-author notes show none, own edits at once); the toggle is
  "Authors" on both, plus View ▸ Show Authors on the Mac, remembered per browser / in `workspaces.json`. Unit:
  `collab::blame::tests::*`, `authors::tests::*`, `remote::tests::line_authors_come_from_the_room_and_follow_the_text`,
  `header::tests::initials_and_people_like_the_web`.
- **Open Workspace… / Open Folder…**: the Mac's Open Workspace… is remote folders only (URL, GitHub repo, as the web's); Open Folder…
  (⇧⌘O, the switcher) is the system picker for a folder on this Mac — the web has none. The File menu adds New Workspace…
  ⌥⌘N (the switcher's New Workspace…). Unit: `tree_edit::tests::the_file_menu_has_new_note_new_folder_and_open_with_their_shortcuts`,
  `actions::tests::a_guest_gets_no_github_repo_choice`.
- **Event stream**: the same `GET /api/events` (tree, repos, presence, saved) with the same effects: presence dots
  on the tree's rows (four, agents hollow, "+N"), the tree reloaded on changes, History refreshed on a new commit;
  reconnects with 1–30 s backoff and reloads the tree. The Mac has no 3 s poll any more. Unit:
  `remote::tests::server_events_update_presence_tree_and_history`, `net::tests::event_streams_parse_like_eventsource`;
  real server: `qa_flows_against_a_server` (presence from the stream; a folder deleted while open).
- **Toasts**: the same stack, look, error dot, button and durations (3.5 / 6 / 8 s). Unit: `toasts::tests::toasts_stack`.
- **Links out of the folder**: the same "“<path>” is outside this notebook." error toast. Unit:
  `links::tests::missing_notes_and_headings_in_this_note`.
- **Terminology**: "workspace" for the top-level thing (a repo, or a directory on this Mac), "folder" for a
  directory inside one, in both apps (switcher, dialogs, confirms, toasts, agent card, empty states).
- **Closed notes** (not found, no access, too large, deleted, removed, renamed away): the web's wording and
  buttons (Create it, Go home). Difference: the Mac draws the message with its problem page (centred, 17 pt
  heading, no header above it) rather than the web's `.empty-state` (24 pt heading, under the header's breadcrumb). Renamed by someone else: the same "“a” was renamed to “b”." toast. Unit: `remote::tests::closed_notes_say_why`.
- **New note hidden** in a read-only or loading workspace, as the web's. Unit: `remote::tests::read_only_rooms_and_missing_notes`.
- **Tree Space**: Space acts as Enter unless typing ahead, as the web's. Unit: `sidebar::tests::space_acts_as_enter_unless_typing`.
  Still different: the web opens a note on a held arrow after 150 ms; the Mac opens each row it moves to at once.
- **Demo banner**: same text and look. Difference: on the web it scrolls away with the note; the Mac keeps it
  above the page. Unit: `remote::tests::the_demo_workspace_has_its_banner`.
- **Avatars**: the web's `initials` and `colorFor` in the header and the account row. Unit: `header::tests::initials_and_people_like_the_web`.
- **Linked repos start closed**, as the web's `openByDefault`. Unit: `remote::tests::linked_repos_start_with_their_folders_closed`.
- **Dropped non-images**: the web's error toasts. Unit: `drop::tests::other_files_say_why_they_werent_added`.
- **Empty state**: the web's text and New note button. Unit: `remote::tests::the_empty_page_says_what_the_web_says`.
  (The web's "Welcome / Start a workspace." page for no workspace at all can't happen on the Mac.)
- **Folders remembered** across launches (newest 500, against the workspace's default), as the web's. Unit:
  `sidebar::tests::open_and_closed_folders_are_remembered`.
- **Folds remembered** across launches (newest 500), as the web's. Unit: `tests::folds_are_remembered_across_launches`,
  `remote::tests::remote_folds_come_back_after_the_sync`.
- **Sidebar button** in the header while the sidebar is hidden, as the web's narrow layout (the Mac's sidebar
  pushes the page rather than sliding over it). Unit: `header::tests::the_sidebar_button_shows_while_the_sidebar_is_hidden`.
- **Row tooltips**: the path, and "More" on ⋯, as the web's titles. Snapshot `161-row-tooltip`. (The web's switcher
  has no tooltip; neither does the Mac's.)
- **From GitHub link** in the header of a read-only GitHub copy, as the web's. Unit:
  `remote::tests::github_copies_link_the_file_on_github`.
- **Link hover** shows the destination, as the web's title. Unit: `links::tests::hover_shows_the_destination`; snapshot
  `163-link-tooltip`.
- **Missing workspace**: the web's "Go to my workspaces", plus the Mac's Remove. Unit: `remote::tests::a_missing_folder_says_so`.
- **Sidebar width**: 272 pt, the web's `--sidebar-w` (was 240).
- **Inline rename**: the name only, all selected, commit on Return or a click elsewhere, the web's messages. Unit:
  `tree_edit::tests::local_notes_and_folders_are_renamed_and_trashed`.
- **Search files**: the same dialog (full paths, folders muted, name emphasised; the same ranking — the Mac's
  `filesearch::tests::ranking_matches_the_web` runs the web's test vectors; ≤ 200 rows with the same footer;
  "No matching files"; Up/Down, Return/click opens with the editor focused, Escape closes; the tree is never
  filtered). The web's shortcut is Ctrl+P on every platform, the Mac's ⌘P (File ▸ Search Files…). The Mac
  had no "/" shortcut to remove; its ⌘K alias is gone.
- **Row menu**: identical — "New note", "New folder", "Rename", "Delete", in that order, no separators, for
  notes and folders (the Mac's is a native `NSMenu` from a right-click / Ctrl-click / two-finger click, the
  row's ⋯ or Shift+F10 / the Menu key; the web's an in-page menu from its ⋯ or a right-click). New note and
  New folder go in the row's folder (a folder row's own, a note's folder); New folder = "New folder/Untitled.md"
  ("New folder 2"…) opened with the folder in rename (Enter renames, Escape keeps); folder rename and delete
  in one commit (`{folder: true}`, `?folder=`). Delete confirms the same way for remote notes ("Delete note",
  "Delete “path”? It stays in the Git history."); local notes (Mac only) go to the Trash. The Mac also has
  the menu bar's File menu (New Note ⌘N, New Folder ⇧⌘N, …). Unit: `tree_edit::tests::*`,
  `remote::tests::remote_folders_are_made_renamed_and_deleted_through_their_notes`; real server:
  `qa_flows_against_a_server` step 6b (new folder, folder rename, folder delete: PASS).
- The web's legacy-server rules (`server.legacy`) don't apply: the Mac only connects to servers with
  `/api/server`.

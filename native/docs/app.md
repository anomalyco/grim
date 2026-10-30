# The app crate (`crates/app`, package `grimoire`)

Phase 1 of the native port: `editor-core` drawn with Rune. Built against Rune's `dev` branch, checked
out as the worktree `~/projects/worktrees/rune-dev` (branch `grimoire-app-dev` at `origin/dev`;
`rune = { path = "../../../worktrees/rune-dev/crates/rune", features = ["native-file-dialog"] }`). The
APIs it uses are listed in `docs/rune-capabilities.md`, "Rune dev". (The old `grimoire-patches` branch,
worktree `~/projects/worktrees/rune-grimoire`, is obsolete.) In the code a folder of notes, local or
remote, is a *workspace* (`WsRef`, `workspaces.rs`, the server's `/api/workspaces`); the UI always says
**folder**, as the web app does.

```sh
cargo build --release -p grimoire
target/release/grimoire path/to/folder       # the folder's notes in the sidebar, its newest note open
target/release/grimoire path/to/note.md      # its folder, with the note open (created if missing)
target/release/grimoire                      # the workspace open last (recent list), else ~/Documents/Grimoire (created, and seeded with Welcome.md, when it has no notes)
target/release/grimoire --remote-demo --snap x.png   # headless: a remote workspace on the in-process mock server
sh crates/app/scripts/run.sh                 # headless snapshots → crates/app/out/*.png
cargo test --release -p grimoire             # autosave, folder scan, file search, note switching, reload
scripts/bundle.sh                            # dist/Grim.app (gitignored)
scripts/install.sh                           # ~/Applications/Grim.app (quits and removes an old Grimoire.app)
```

**The name.** The app is called **Grim** (it was Grimoire until 2026-10-30): `CFBundleName` and
`CFBundleDisplayName`, the app menu, window titles, dialogs and `Grim.app`. What identifies the app and its
data kept the old name, so a sign-in, workspaces and caches carry over from Grimoire.app: the bundle id
`co.anoma.grimoire`, the package and cargo binary grimoire (in the bundle it is Contents/MacOS/Grim, since Rune names the About / Hide / Quit menu items after the process), the Keychain service "Grimoire",
`~/Library/Application Support/Grimoire` (`workspaces.json`), `~/Library/Caches/Grimoire` and the default local
folder `~/Documents/Grimoire`.

Headless runs (`--snap`, `--script`, `--tree`) never write to disk: they read the folder, and a
new note only exists in memory. `--sample` (or no argument) loads the built-in sample note
(`crates/app/sample.md`) with no folder and so no sidebar, and scenes (`--scene empty|caret-in-bold|selection|in-table|in-code`)
set up states. `crates/app/scripts/long.md` and `italic.md` are fixtures for the scroll and
italic snapshots; `crates/app/tests/fixtures/code` (highlighted code blocks) and `crates/app/tests/fixtures/notes` (nested folders, plus a hidden folder,
`node_modules` and non-Markdown files that must not show) and `fixtures/empty` are the sidebar's; `fixtures/photos` (a note with PNGs beside it and in `images/`, one missing) is the images'.


**Terminology** (since 2026-10-28, as the web): the top-level thing — one entry in the switcher, a repo on a server
or a directory on this Mac — is a **workspace** in the UI (`WsRef` in the code, as before); a **folder** is a
directory inside a workspace (the tree's folders, New Folder, the row menu's New folder / Rename / Delete). Open
Folder… keeps its name: it picks a folder in Finder, which becomes a workspace ("Choose a folder to open as a
workspace"). The File menu: New Note ⌘N, New Folder ⇧⌘N (a subfolder), New Workspace… ⌥⌘N, a separator, Open Workspace… ⌘O
(a server's workspace by URL, a GitHub repo), Open Folder… ⇧⌘O, Search Files… ⌘P; the switcher's footer: New
Workspace…, Open Workspace…, Open Folder…. The New workspace dialog's choices: **On this Mac** · **On a
server**; the Open workspace dialog's: **URL** · **GitHub repo**. Some older paragraphs below still say "folder"
for a workspace.

## Modules

| file | what it does |
|---|---|
| `main.rs` | `App` state (the `Editor`, path, caret blink `Live`, saver, IME marked text; the notes folder, its tree, collapsed folders, the search dialog's state, the sidebar choice), `open_note` / `new_note` / `refreshed`, the 2 s refresh thread, fonts (the Inter 4.1 faces in `assets/fonts`, italics included, plus Menlo read from `/System/Library/Fonts`), `AppSpec` with the note's name in the window title, scenes, autosave on close, and `ApplePressAndHoldEnabled = NO` registered at startup |
| `layout.rs` | Text layout through Rune's own `TextSystem::layout_rich` (a thread-local `TextSystem` built from the app's fonts and families, as Rune's runtime builds its: the same layouts, cached the same way, at device scale), so there is no copy of Rune's Parley code to keep in step. Turns each `LineView` into a `LineGeo` of `Piece`s (one per line, one per cell in tables), whose display text leaves hidden segments out, with display ↔ raw byte maps (`DisplayMap` from editor-core for hits, resolving the click's affinity next to hidden markers; `r2d` for carets). Block tokens become gutter slots (`Tok`). Implements editor-core's `Layout` (`caret_rect`, `hit_test`, `bounds`, `table_cell_at`, `line_mid_y`, `image_at`, `adjacent_line_y` from each line's visual rows: Parley line metrics merged across table cells, image bands, rule/collapsed lines as one row), plus selection rects and `splice_marked` (IME text drawn into the caret's piece). Holds the column width and viewport height of the last view (`set_viewport`, `col_w`, `view_h`) |
| `files.rs` | Scanning the folder (`.md`/`.markdown`, skipping hidden folders and `node_modules`, folders without notes left out; symlinked notes followed, symlinked folders not; folders first, then by name) with a fingerprint of paths, sizes and mtimes taken in tree order; the tree's rows (collapsed folders, filter); the filter match (the web app's: each term in the path, or loosely in order in the name); `Untitled N.md` names |
| `sidebar.rs` | The sidebar view (below) and its handlers: row presses, Cmd-\ toggle, the tree's keys |
| `header.rs` | The note's header (the web's `.doc-header`): breadcrumb, the save status, the people in the note (avatars), the ⋯ menu (History, Authors, Rename…, Delete…, Copy Link, Open in Browser) |
| `history.rs` | The history drawer (the web's `history.ts`): versions, a version's diff or text, Restore; the server's endpoints or `git` for a local folder |
| `authors.rs` | Line authors: `LineAuthors` (the room's `blame`, following the text), `marks` (the web's `authorMarks`), the margin's names |
| `filesearch.rs` | The "Search files" dialog (⌘P): `rank` (the web's `rankFiles`), its keys, its view, the sidebar's search button |
| `tree_edit.rs` | The File menu (`FILE_MENU`: New Note, New Folder, New Workspace…, Open Workspace…, Open Folder…, Search Files…), the rows' native Rename / Delete menu, `selected_dir`, New Folder, rename and delete of notes and folders (local: the files, the Trash; remote: the server's note and folder endpoints) |
| `render.rs` | The view: the sidebar (when shown) over the left 272 pt (the web's --sidebar-w), the page in the rest. Code block backgrounds, quote bars, table rules, hr, bullets, numbers, checkboxes (clickable → `toggle_todo`), `H1`…`H6` labels on the active heading, one `rich()` per piece, strikethrough rules, images below their lines (`El::pixels` of the decoded `rune::Image`, or the placeholder), the translucent selection, and the blinking caret (`ime_cursor()`, kept transparent under a selection), inside a centred column in a Rune scroll viewport (`scroll`). The surface element takes the mouse |
| `keys.rs` | The macOS key table every editor gets (`keys::editor`): editor-core's `KeyTable::standard()` (AppKit's `StandardKeyBinding.dict`) with the user's `~/Library/KeyBindings/DefaultKeyBinding.dict` on top, read once at startup (old-style text directly; XML or binary through `plutil -convert json`). Headless runs skip the user's dict; `--key-bindings=FILE` loads one |
| `input.rs` | `on_key` → `insert_text` / `Editor::key` through the key table, plus Cmd-C/X/V (arboard), Cmd-S, Cmd-Enter on a link, paging (`Command::Page`), Ctrl-L (`CenterSelection`), Home/End scrolling and keeping the caret in view. `on_ime` → marked text / `end_composition`. `surface_drag` → `mouse_down` (click count, Shift) / `mouse_drag`, or a press on a collapsed link (`LinkPress`: follows it on release); `pencil_drag`, `link_text_drag` |
| `images.rs` | Where an image's source points (`resolve`): relative to the note's folder, percent-decoded, absolute paths, `~/`, `file://`; http(s) and other schemes aren't loaded |
| `drop.rs` | Image files dragged in from Finder (below): the surface's `on_drop_files` / `on_drop_move` / `on_drop_hover`, the drop caret position, the link for each image (relative path, copy into `images/`, de-dupe, URL encoding), a pasted bitmap written as `images/image.png` (`link_bytes`) |
| `rimages.rs` | Images over the network: `source` (a local note's files, a remote note's own files as `GET /api/workspace/:id/raw?path=` resolved like the web's `repoImagePath`, http(s) URLs like its `directImageUrl`), `fetch` (downloads on threads, at most 6 at once, cached in `~/Library/Caches/Grimoire/images`, checked again after 60 s, failures retried after 15 s, a copy from an earlier launch shown at once; the token only to the folder's own server; offline in headless runs unless a test's `Fake` answers) |
| `uploads.rs` | Images dropped or pasted (Cmd-V: a screenshot, image files copied in Finder; `paste`) into a note: written next to a local note, uploaded into a remote one (`POST /api/workspace/:id/images`) with an "Uploading…" mark that follows everyone's edits (`map_pos`, the web's `mapPos`) until the server's Markdown goes in; the web's toasts |
| `doc.rs` | Picking the folder and note from the argument (`locate`), opening the file, atomic writes, a debounced (1 s) background saver, and a flush on Cmd-S or when the window closes |
| `theme.rs` | Colours and metrics from the web editor's `editor.css` (paper `#fcfcfb`, ink `#1d1e22`, markers `#62626a`, links `#296d9a`, code `#f1f1f2`, 33 pt gutter, heading sizes) and the sidebar's from `app.css` (`#f4f4f5`, hover `#ececee`, active `#e4e4e7`, `#3f3f46` folders, 272 pt wide, hidden below 700 pt) |
| `links.rs` | Following a link (below): `resolve` (unescaping, `<…>`, schemes, `#heading`, paths against the note's folder or the notes folder, `.md` tried, the folder's bounds), GitHub heading slugs, `App::follow_link` (open, note, heading, toast) and `launch` (`/usr/bin/open`, recorded instead in headless runs) |
| `note.rs` | `NoteStore` (an `editor-core` `TextStore` over a plain string or collab's `CollabStore`) and `Ed` (a local `Editor<NoteStore>` or a boxed `CollabEditor<NoteStore>`), which derefs to the editor: the rest of the app calls `app.ed.…` for both kinds of note |
| `gitsync.rs` | Git in local folders: the first-time dialog (track changes / automatic commits), the per-folder choice, and `Committer` (commits only the app's own changes with `git commit --only`, off the UI thread) |
| `workspaces.rs` | `WsRef` (local folder / remote `server + id + title`), remote workspace URL parsing, the persisted `Store` (recent workspaces with their last note, connected servers with their joined workspaces) and `Tokens` (the Keychain through Security.framework, `keychain`) |
| `net.rs` | A small blocking HTTP/1.1 client (http, https through native-tls = Security.framework; JSON, chunked bodies), URL parsing and escaping, the loopback listener of the connect flow, random hex from `/dev/urandom` |
| `wsock.rs` | The app's WebSockets, event-driven: blocking handshakes, then a thread asleep in `mio::Poll` until data, a queued frame (`Waker`) or the heartbeat; no read timeouts |
| `v2.rs` | Protocol v2: the selected workspace's one socket (`Mux` in `Remote`), warm and prefetched notes as hidden channels, workspace events, reconnect |
| `boot.rs` | Launch and workspace switches in two phases: the launch screen (or the old view, inert) until the first view is ready, then the complete view in one frame; 3 s cap |
| `diskcache.rs` | Remote workspaces on disk (`~/Library/Caches/Grimoire/notes`): trees and notes' text, 200 MB LRU, readable offline |
| `imagesizes.rs` | Image sizes per source (latest 500, kept on disk): boxes reserved before images load |
| `sysfont.rs` | The macOS system font (San Francisco) from the system: CoreText's file URL for `kCTFontUIFontSystem` and its italic |
| `notecache.rs` | Recently seen notes' text (100 notes / 8M characters), shown at once when a note opens |
| `remote.rs` | Remote workspaces: the REST client (`Api`), the connect flow, the v1 room socket, `Remote` (the open workspace and note), `App::open_remote` / `open_remote_note` / `room_frame` / `room_closed` / `pump_collab`, status, remote carets, notes created / renamed / deleted on the server, the in-process `Mock` server (headless demo, tests) and the integration test |
| `switcher.rs` | The workspace switcher (top left of the sidebar), its menu drawn from `menu::items`, the status pill |
| `menu.rs` | What the switcher's menu lists, in order: the web app's switcher for a remote folder (plus This Mac), only what needs no server for a local one; the account row's menu (`account_items`); `Act` (what an item does) |
| `dialogs.rs` | The modal dialogs (state and drawing, the web's `.modal`): prompts, confirms, Open (folder / remote folder / GitHub repo) and New (a folder here or on a server); buttons, fields, segmented controls, radios |
| `actions.rs` | What the menu items and dialogs do against the server (`App::api_task`: a thread, or in place against the mock), GitHub refs and note picking, the agent card's Copy |
| `fake.rs` | `FakeRest`: an in-process stand-in for the server's REST API (account, folders, agent links, token revoke) for headless runs (`--remote-demo=owner|editor|viewer`) and tests |
| `highlight.rs` | Code block highlighting (below): finds fenced blocks with a language, keeps a tokenizer per block between builds (matched by language and text, else the nearest block of its language, taking the change as one edit), at most `LIVE_MAX` (8) live Wasm instances; per code line the token ranges to colour and a diff/patch background. `layout::build` calls it; `make_piece` turns the ranges into spans |

## Folders (workspaces)

One folder is open at a time: a **local** folder of notes (as before) or a **remote** folder on a
Grim server (multiplayer). Spec: multiplayer-notepad `docs/workspaces/SPEC.md` ("Clients → Mac").
Every folder on a server is public (since the server's 2026-10-28 change, `7e925d3`): anyone signed in there
opens and edits it; only read-only GitHub copies are read-only. Neither app offers removing a workspace (no "Remove workspace…"; the
server's `DELETE /api/workspace/:id` stays for its maker, and the app only calls it to clean up a failed GitHub import).
Privacy means running your own server. There are no members, invites, roles, link access, domain rules,
note links or Settings.
Every user-facing string says "folder" (the web's labels, word for word); code identifiers, API paths, JSON
keys and file names keep "workspace".

- **Switcher** (`switcher.rs`, key `switcher`): at the very top left of the sidebar, under the traffic
  lights: a glyph (folder or globe), the folder's name (Inter SemiBold 13.5) over where it lives
  (`~/Documents/Grimoire`, or the server's host, 11.5 muted), and a caret. A press opens the menu (an
  overlay 300 pt wide, scrolling when taller than the window, with a backdrop that closes it; Esc closes it
  too). What it lists is `menu::items`: **when the open folder is remote, the web app's switcher
  (`openSwitcher` in multiplayer-notepad `src/client/main.ts`) item for item**, drawn like its `.ws-menu`
  (30 pt rows, sections in sentence case). **Every folder row is only its name (a dot before the open one)
  and an × at the right**, shown only while the pointer is over the row, as on the web (`group_opacity` under
  the row's hover; its 18 pt slot is always reserved, so nothing moves; muted, darker over the × itself; a
  press on the row opens the folder, one on the × doesn't; the keyboard-highlighted row shows its × too).
  **Keys** in the open switcher (`App::switcher_key`, over `menu::choosable`: the folder rows and enabled
  items): Up/Down move a highlight (the hover tint; no wrap; from nothing Down takes the first, Up the last),
  Home/End, Return chooses, Delete/Backspace on a folder row is its × (the confirm), Esc closes:
  no access badge, host or path. Folders from several servers are grouped under one heading each: the server's host ("grimoire.exe.xyz").
  **The order never depends on the open folder** (it only gets its dot): This Mac first (local folders by
  name), then the servers by host, each one's folders by name — case-insensitive natural order ("Notes 2"
  before "Notes 10"; the web's `localeCompare(…, {numeric: true, sensitivity: "base"})`), ties by path / id
  (`menu::natural_cmp`, `menu::folder_cmp`); the web app sorts its servers and folders by the same rule.
  - **<host>** (the heading is just the host): the folders joined there (`GET /api/workspaces`, refreshed each time the menu opens and
    after a folder opens; cached in the store), plus the open folder when it isn't joined (no ×), or "No
    folders yet" (disabled). The × (any row, local or remote) always asks first, in the web's words
    (`App::ask_remove_folder`): "Remove <name> from your list?" — remote: "This doesn't delete the folder. All
    existing links to it keep working, and if you open a link to it again, it'll come back to your list.";
    local: "This doesn't delete the workspace's folder or its files. You can open it again any time with Open Folder…" —
    **Remove** (primary) / **Cancel**. Remove leaves a remote folder (`DELETE /api/workspace/:id/join`) or
    forgets a local one, toast "Removed <name> from your list"; leaving the open folder opens the next one
    joined there (or none). The × on the only folder in the whole list (local and remote rows together) shows
    "Can't remove your only workspace" ("You can't remove the only folder in your list. Create a new folder
    first, then remove this one.", **New workspace…** opens the New dialog, **OK**) and removes nothing.
  - **<host>** for each other server the app is connected to: its joined folders, the × leaving them with
    that server's token (a signed-out one: "Signed out" with Reconnect / Forget). **This Mac**: the local
    folders opened before (by real path, sorted by name, an × "Remove from list" on all but the open one).
    Remembered, not a history: there is no "Recent" section.
  - **New Workspace…**, **Open Workspace…** and **Open Folder…** (the New and Open dialogs below; Open Folder… goes straight to
    the system folder picker, no dialog in between and no sign-in); then for the open folder (once
    loaded): **Open on GitHub** (GitHub copies); no Remove workspace… (gone in both apps, 2026-10-30). Signed out of the open folder's server: no folder items (the account
    row says so). No account items: those are in the account row's menu.
  - **When the open folder is local**: This Mac, then **<host>** for each connected server (its joined
    folders; a signed-out one: "Signed out" with Reconnect / Forget), then New Workspace…, Open Workspace… and Open Folder… only.
- **Local folders and remote workspaces** (the mental model): local folders are just folders on this Mac,
  always listed whether or not you're signed in, with no sharing (no links or presence; the agent card's Share has
  only the prompt for an agent on this Mac).
  Remote workspaces only exist while signed in to their server: signed out there, none (at launch the app drops
  the recents, joined lists and cached notes and images of servers it has no token for; opening one by its
  URL signs in first, `switcher.pending_open`). The switcher lists This Mac's folders, then each server's
  workspaces under its host.
- **Account row** (`switcher::account_row`, the web's `.sb-account`): always at the very bottom of the sidebar,
  whichever workspace is open (local or remote), below the agent card when there is one: signed in, a round
  avatar with the account's initials in its colour and its name (else email); signed out, "Sign in" (no avatar),
  which signs in to the open remote folder's server, else the one the app was signed in to, else the default
  server (`menu::account_server`). Signed in, a press opens the account menu upward from the
  row (`switcher::account_menu`, `menu::account_items`; same style as the switcher's, its bottom 4 pt above
  the row; Esc, the backdrop or a second press close it; it and the switcher are never open together): the
  email (none for the old name sign-in's made-up `@dev.grimoire`/`@localhost` ones; sign-in is Google only), **Change name…**, **Switch account** (Mac only: the
  connect flow again; another account signs the old one out completely first, see "Accounts and
  workspaces"), **Sign out** (a confirm, then Disconnect: this app's token revoked with `DELETE
  /api/tokens/:id`, forgotten here, and the account's workspaces and cached notes leave this Mac). Signed out: "Signed out of <host>" with
  **Reconnect** / **Forget**.
- **Dialogs** (`dialogs.rs`, drawn like the web's `.modal`: title and ×, body, actions bottom right, a dimmed
  backdrop that closes it, Esc too, Return confirms a confirm dialog or submits a form), with the web's
  wording; what they do is `actions.rs`, through the endpoints the web app uses, with the Bearer token
  (`remote::Api`), on a thread:
  - **Open** and **New** (`Dialog::Open`, wide; `OpenDlg::new` tells them apart): a list at the left, the
    chosen form at the right (its field focused; Return submits, Esc closes). **Open** (remote folders only):
    **URL** · **GitHub repo** (primary buttons Open / Add; a guest gets URL only). **New** (the menu's "New Workspace…",
    above Open Workspace…): **Folder** · **On a server** (primary button Create). "Folder" is Mac only.
    - **Open Folder…** (the switcher and File ▸ Open Folder… ⇧⌘O, not a dialog): the system folder picker
      (`App::open_folder_dialog`: `Tx::open_folder`; `App::picker` stands in for it in tests; headless or when
      it can't run, the "Open folder" path dialog); the folder opens and joins This Mac.
    - **URL** (as on the web): URL (placeholder `https://<server>/app/…`), "Paste the link to a folder or a
      note on any Grim server."; a folder's link (`https://<server>/app/<folder>`) or a note's
      (`…/app/<folder>/<path/to/note.md>`: nested paths, URL-encoded names, old `/r/…` links, `.md` added when
      missing). It adds the folder and opens it (as a guest when there's no token for the server: no sign-in), at that
      note once the folder loads; a note that isn't there opens the folder with the toast "No note at
      “<path>”" (`Remote::asked`). A bad link: "That isn't a folder or note link. It looks like
      https://server/app/folder or https://server/app/folder/note.md."
    - **GitHub repo** (`parse_github` = the web's `parseGitHubRepo`; Read-only / Edit when `/api/server`
      has `githubAppSlug`; `POST /api/workspaces {github, readOnly}`, "Looking up…", "Copying … from GitHub…" while
      it imports (`GET /api/workspace/:id` each second), a failed copy removed, then the note `pick_note` (the
      web's `pickNote`) chooses opens). It goes to the open remote folder's server, else the first one the
      app is signed in to; with several, a **Server** choice picks it. No server: "Connect to a Grim
      server first…" and **Add a server…** (the Remote folder form).
    - **New → Folder**: Location (`~/Documents` by default; **Choose…** opens the folder picker there)
      and Name; makes the folder (never over one that exists: "There's already a “…” in …"; no `/` or
      leading `.`; "No folder at …" for a missing location) and opens it as the current folder, empty (the
      empty-folder page: ⌘N starts a note), remembered under This Mac. Headless runs don't write.
    - **New → Remote folder**: **Server** (a text field; its default is a server the app already knows: the
      open folder's when it's remote, else the first connected one in the switcher's order, else
      `https://grimnotes.app/`; `App::new_remote_server`) and **Name**. The address must look like one
      ("Enter a server address like https://grimnotes.app/"; no scheme means https). Connected to it:
      `POST /api/workspaces`, opens it, toast
      "Created “…”". Not connected yet: `GET /api/server` checks it's a Grim server, then the connect flow
      runs ("Waiting for the browser to connect to <host>…" in the form; `Switcher::pending_new`) and the
      folder is created and opened when it's done. Errors stay in the form: "<host> isn't a Grim server.",
      "Can't reach <host>. Check the address and your connection.", "You don't have permission to create
      folders on <host>." (`actions::new_remote_error`).
  - **Remove folder** / **Sign out** confirmations (Remove: `DELETE /api/workspace/:id`, then the next folder
    joined on that server, else a local folder, else the sample). **Change name** (`PATCH /api/me`; the room
    reconnects with the new name).
  Choosing a workspace leaves the open one (the local note saved, the remote room left with a null
  presence) and opens it: a local one at the note open last there, else its newest; a remote one at the
  note from the URL, else the one open last there, else its first note.
- **Persistence**: `~/Library/Application Support/Grimoire/workspaces.json` (`recent`: the workspaces opened,
  most recent first, each with its last note, up to 12 local and 12 remote — the menu's "This Mac" list and
  what launch reopens, never shown as a history; remote ones keep the server's title, never an empty one
  (the id stands in until it's known; renames on the server follow the joined list); `servers` with their
  name, joined list, account and token id). No argument at launch opens the most recent workspace and its
  note (a remote one connects in the background). Headless runs read it only with `--support-dir=DIR` and
  never write it.
- **Guests** (as on the web: every folder is public). Without a token for its server the app opens, reads and
  edits a folder as a **guest** — no browser, no sign-in — at startup, from the switcher, from Open Workspace… (a
  folder's or a note's URL), on any server. The guest identity is made once and kept in `workspaces.json`
  (`workspaces::Guest`: a random id, a silly name like "moist-noodle" from the web's lists, the web's `colorFor`
  colour) and sent as the web's guests send it: REST requests carry `X-Grimoire-Guest`,
  `X-Grimoire-Guest-Name` (URL-encoded), `X-Grimoire-Guest-Color` and `Origin: <server>` (the server only takes
  a guest's writes from its own origin), no bearer; the folder comes from `GET /api/workspace/:id` (no `/api/me`,
  no `/api/workspaces`), the room joins with `&anon=<id>&name=<name>&color=<colour>`. The server signs a
  guest's commits "<name> (guest)" and shows the name on the guest's caret. A guest's account row is just
  **Sign in** (no avatar; it starts the connect flow, the only time the browser opens), the agent card is
  hidden (agent links are for accounts), the switcher lists the folders opened on that server (its × forgets
  one here), and Open Workspace… offers no **GitHub repo** (the web hides it for guests). Only **New Workspace…** on a server
  (creating a folder) and adding a GitHub repo need an account: the server refuses them to guests (401). The
  web's Open Workspace… asks a guest to sign in; the Mac's doesn't (the owner's decision).
- **Sign-in** (`remote::connect_flow`, OAuth for native apps, RFC 8252; grim `docs/accounts.md`), for Sign in, the
  "No workspaces" page, New Workspace… on a server without a token, Reconnect and Switch account: the sign-in
  dialog ("Continue in your browser…", **Cancel** only; New Workspace… says it in its own form instead), then
  `GET /api/server` (must be a Grim server), a listener on `127.0.0.1:<random port>`, and `/usr/bin/open
  <server>/auth/google/start?client=mac&redirect_uri=http://127.0.0.1:<port>/callback&state=<128 random
  bits>&code_challenge=<S256>&code_challenge_method=S256` (PKCE: a fresh 256-bit verifier per flow, `net::pkce`,
  SHA-256 through CommonCrypto). That goes straight to Google (no page of ours, no code to read or copy); after
  Google the server redirects to the loopback with a one-time `code` (single use, 60 s) and our state, or `error`
  / `error_description`. The listener takes the one callback with our state (other requests, and callbacks with
  another state, get 404/400 and are skipped), closes, and gives up after 5 minutes or on Cancel (closing the
  dialog any way stops it: `App::cancel_connect`). The app trades the code with the verifier at `POST
  <server>/auth/token` (straight to the server: the token never goes through the browser) for `{token, token_id,
  account, login, email}`, stores the token, then answers the browser tab "You're signed in — you can close this
  tab" (or what went wrong). The dialog closes; a failure shows "Couldn't sign in" with why and **Retry**. The
  switcher shows no sign-in status. The newest flow wins.
- **Accounts and workspaces** (the same rules as the web, grim `docs/accounts.md`; per server, since each
  server has its own account; `App::connected`, `App::sign_out_account`, `App::disconnect`):
  1. *Signing in as another account* than the one signed in on that server (another email; `Connected::email`
     from `POST /connect/token`) signs the previous one out completely first: its token is revoked on the
     server and removed from the Keychain, its sockets close (the open workspace there is left), its remote
     workspaces leave the sidebar (`Store::drop_remotes`: recents and the joined list) and its cached notes
     (`~/Library/Caches/Grimoire/notes`) and downloaded images are deleted. The new account then sees only
     its own workspaces (its joined list); if one of the old account's workspaces was open, the most recent
     local folder shows until the new account's first workspace opens (`switcher.open_first`). The same
     account again (Reconnect) keeps everything; only its old token is revoked.
  2. *Signing in from a guest* keeps the guest's remote workspaces on that server and adds them to the
     account on the server (`POST /api/workspaces/join-many`), so they're in its list everywhere.
  3. *Local folders* never change with signing in or out.
  4. *Signing out* (Sign out) is the first half of rule 1, everywhere: every server's token is revoked and
     removed from the Keychain, every remote workspace (guests' on other servers too) leaves the sidebar and the
     switcher at once and their caches are deleted; the most recent local folder opens, else the "No
     workspaces" page (**Open a folder…**, **Sign in**; `App::no_workspaces`). A token the server refuses (below)
     does it for that server, but the open workspace stays open as a guest's.
- **The demo is for people who aren't signed in** (grim `docs/accounts.md`): signed in to a server, its `demo`
  workspace is never opened or listed. Opening it (a link, the recents, the open workspace when signing in from
  it) opens the account's own workspace instead (`App::open_own`: `POST /api/workspaces/personal`, the first
  joined one, else a new "<First name>'s notes" made for it with a welcome note); signing in drops it from the
  recents and joined list, `join-many` never sends it (`saved_ids`), and the launch drops it for servers with a
  token. Signing in with nothing open opens the account's own workspace; with a local folder open, it stays.
  Guests keep the demo as before; servers without sign-in have no demo.
- **Servers without sign-in** (grim's `SIGN_IN` off, the self-hosted default; `/api/server` `signIn: false`;
  `Server::no_sign_in`, saved as `noSignIn`): no accounts there, so no token and no sign-in. Whatever would
  sign in first (opening one of its workspaces, New Workspace… on it, the account row) checks `/api/server`
  before the sign-in dialog opens (`App::start_connect`); a server without sign-in is remembered as such
  (`App::without_sign_in`) and what was waiting goes ahead, without the dialog or the browser. Its workspaces
  then open as the app's guest identity (the guest headers and room query, as above) but nothing is limited
  (`Remote::no_sign_in`: not a guest, no "Sign in to …" prompts); they show at launch without a token, the
  switcher lists every workspace on that server (`GET /api/workspaces`: with sign-in off the list is everyone's,
  there are no per-person lists and anyone may remove a workspace; there's no demo either), and Sign out leaves
  them alone. A server with no workspaces yet shows "No workspaces yet" with New Workspace….
  The account row says "<host> · No sign-in" (no avatar); its menu has only **Change name…**, which renames the
  app's guest identity (the server's guest-name rules) and opens the workspace again. `refresh_joined` notices
  when such a server turns sign-in on (then the next open signs in). Local folders are unchanged: their account
  row shows a server with accounts (else "Sign in"). Servers with sign-in on behave as before.
- **Signed out** (`App::signed_out`): a token the server refuses (revoked on the web, expired) is dropped
  and the app carries on as a guest there: the toast "Signed out of <host>", the account's workspaces there
  leave the list and its cached notes and images are deleted, but the open folder on that server opens again
  as a guest (readable and editable; it's then the guest's), the account row says "Sign in". Folders stay readable with
  a bad token (they're public), so `App::check_tokens` asks `GET /api/me` with each token at launch and when
  the window comes to the front (`App::on_focus`, at most every 30 s); any other request with the token that
  gets a 401 (loading, a tree load, the room's "unauthorized", the account fetch) does the same.
- **Problems** (`remote::Problem`, the page instead of the editor, with buttons; the status pill and the
  sidebar say it short): 401 without a token → "Signed out of <host>" (**Reconnect**); 404 when
  opening → "No such workspace: “<id>” doesn't exist on <host>." (**Remove**); a network error or 502–504 →
  "Can't reach <host>", retried by itself after 1, 2, 4… 30 s (**Retry now**); an answer that isn't the
  Grim API → "<host> isn't a Grim server"; deleted while open (a tree load's 404 after the event stream's `tree` / `repos`) → "<folder> is no
  longer available";
  a failed connect flow → "Couldn't open" (**Try again**). **Remove** forgets the workspace here (it stays in
  the menu if it's in the server's joined list) and opens the next local folder, else the sample note.
  While open, an event stream that drops shows "Offline · reconnecting" and keeps the note.
  Choosing a workspace that shows a problem tries it again. Headless: `--remote-demo=missing|signedout|
  offline|notgrimoire|gone|loading` (snapshots 101, 102).
- **Token storage** (`workspaces::Tokens`, `workspaces::keychain`): the Keychain only, through Security.framework:
  the app's own generic-password item, service "Grimoire", account = the server's origin, label "Grimoire app
  token (<origin>)", with access control `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (never synced or
  moved to another Mac); in the data protection keychain when macOS lets this build use it, else the login
  keychain (`--keychain-selftest` says which). Never in files, logs, URLs or caches: if the Keychain refuses,
  the sign-in fails ("Couldn't sign in"). Tokens from older builds (a `security`-made item, or the old 0600
  `tokens.json`) move into the app's item on first read. Looked up once per run (cached in memory). Every REST
  call sends `Authorization: Bearer <token>` to the server it was issued for only; the WebSocket sends it as a
  header (plus `Origin: <server>`). A token unused for 90 days stops working on the server; a 401 drops it.
- **Remote workspace**: the sidebar's tree comes from `GET /api/workspace/:id/tree` (fetched again on the socket's `tree` event;
  paths with hidden or `..` segments and non-Markdown files skipped) under a virtual root
  (`/.grimoire-remote/<host>/<id>`, never on disk). The user for presence comes from `/api/me` (name,
  colour), read-only (a read-only GitHub copy) from `GET /api/workspace/:id` (`readOnly`) and from the room's
  hello.
  **New note** = `POST /api/workspace/:id/files` (`Untitled.md`, `Untitled 2.md`…), then opened; **New
  Folder** creates `<folder>/New folder/Untitled.md` the same way (folders are only paths on the server).
  The **row menu** (see the sidebar) renames a note with `POST /api/workspace/:id/rename` and a folder with
  `{folder: true}` (one commit, everything in it moves; the open note follows), deletes a note with
  `DELETE /api/workspace/:id/files?path=` and a folder with `?folder=` (one commit; the first note left
  opens). Errors show as a toast.
- **Remote note**: `Ed::Remote(CollabEditor<NoteStore>)` (collab's `CollabEditor` is generic over the
  editor's store for this). On a v1 server (`/api/server` `ws` without 2, or `GRIMOIRE_WS=1`) each note has a
  WebSocket to `/ws?repo=<id>&path=<note>`; on v2 the note is a channel of the workspace socket (below). Either
  runs on `wsock` (tungstenite after a blocking handshake, then non-blocking in `mio::Poll`: the thread sleeps
  until the server sends, a frame is queued or the heartbeat is due; an idle socket measured 0.000 s CPU in 30 s,
  `wsock::tests::idle_sockets_use_no_cpu`); frames and closes come back to the UI thread through `AppHandle::update`
  tagged with a connection generation (stale ones dropped). The editor stays read-only until the room's
  initial sync (then the room's / the workspace's read-only applies); after every handled event
  `pump_collab` sends what the editor has (`take_outgoing`) and schedules its wake-up (a sleeping thread),
  and publishes our caret while the editor has the keys (not while the search dialog, the switcher or a rename
  field has them). Remote edits patch the editor (`receive`); a rebuild at sync gets the key table back.
  Close codes: retry with collab's backoff (500 ms doubling to 10 s, "Offline · reconnecting"), or end with
  a reason (deleted, renamed → the new path opens, unauthorized → "Signed out", forbidden (4403: only a
  cross-origin refusal now), not found, too large; the
  editor goes read-only); `Notice::Reset` reconnects with a fresh document and a toast. No local autosave:
  the status pill at the top right shows the server's save state (Saving… / Edited / Saved, "Read only ·"
  first for read-only copies) or the connection's.
- **Remote carets** (`render::remote_cursors`): each other participant's caret (2 pt, their colour), their
  selection (their colour at 18 %), and their name in a small pill above the caret (Inter SemiBold 11, paper
  on their colour). Same-user carets are hidden (collab).
- **Images in remote notes** come from the server (`rimages.rs`): a relative source is a file of the folder,
  relative to the note (or to the root with a leading `/`), fetched from `GET /api/workspace/:id/raw?path=` (with
  the token; folders are public) and drawn exactly like a local image; http(s) sources load directly (local
  notes too). While it downloads a quiet box says "Loading image…" ("Loading image: alt"); a missing one is
  the web's "Image not found: alt", one that can't be reached "Couldn't load image: alt". Copies are cached
  on disk (`~/Library/Caches/Grimoire/images`, cleaned after 30 days unused) and checked again after 60 s.
- **Adding images to a remote note** (`uploads.rs`): dropped images and pasted ones (Cmd-V with a screenshot
  on the clipboard, or image files copied in Finder) are uploaded with the web's request (`POST
  /api/workspace/:id/images?note=&name=`, the image as the raw body); an accent bar with "Uploading…" ("Uploading
  N images…") marks where they go and follows everyone's edits; when all are done the server's Markdown
  (`![name](images/name.png)`) goes in there as one edit, the caret after it. The web's toasts: "This note is
  read-only.", "Only images can be added to a note (x isn't one).", "Skipped x: only images can be added to a
  note.", "Couldn't upload x: …", "The image was uploaded but the note changed before it could be inserted."
  Pasting a screenshot into a local note writes `images/image.png` (`image-2.png`… for other contents, the
  same contents reused) next to it, as the server names uploads.
- **Links between remote notes** open them (against the folder's tree, ignoring case, `.md` tried, then the
  `#heading` once the room has synced); another file of the folder opens the server's copy (`/raw`) in the
  browser; a missing note shows "No note at “path”" with **Create it** (writable folders: `POST
  /api/workspace/:id/files` without content, so the note starts with `# <name>` as on the web, then opens it).
  **Grim app links** (`https://<server>/app/<folder>[/<note>][#heading]`, old `/r/…`) on a server the app
  is signed in to open here: a note of the open folder like a relative link, another folder added and opened
  at that note (no sign-in); any other URL opens in the browser.
- **Headless / tests**: `remote::Mock` (collab's `relay::Relay` per note, a tree, scripted peers through the
  same protocol) stands in for the server; `--remote-demo` opens a remote workspace on it with Ada typing
  and her caret showing (`99`). Tests: `net::tests` (URLs, escapes, requests/responses against a mock
  HTTP server, chunked bodies, the loopback listener), `workspaces::tests` (remote URL parsing, names,
  recents and servers persisted, the 0600 token file; the Keychain round trip is `#[ignore]`: it needs a GUI
  session), `remote::tests` (the connect flow through a mock server and a scripted browser: token, wrong
  state, `error=`, not a server; the REST client's paths, bodies, 401/403; room URLs and trees; a remote
  note opened, edited both ways, remote cursor with name/colour, our cursor published/withdrawn with the
  focus, left on switching notes; create/rename/delete; read-only rooms and a missing note; switching
  between a local and a remote folder keeps one open; Open → Remote folder), `menu::tests`
  (the items for a local folder, a remote folder we made and someone else's, not joined, a GitHub copy,
  signed-out servers, the × on every row, the account menu, and the web's switcher as captured on the
  scratch server), `actions::tests` (every
  action's requests and their answers against `FakeRest`: Open → every form (a new remote folder, a new local
  folder made and opened and never over an existing one, a remote folder by URL, a folder from both kinds of
  folder, a GitHub repo; no server), the agent card's prompt and its reuse (local and remote), Leave,
  Remove, Change name, Sign out), and
  `remote::tests::workspace_actions_use_the_web_apps_endpoints` (each call's method, path and body over HTTP).
- **Parity run** (`remote_qa::parity_against_a_server`, `#[ignore]`; `tests/integration/parity.md`): every
  item against a scratch server, with the web app's switcher captured beside it (`parity-web.mjs`).
- **Integration** (`remote::tests::integration_against_a_server`, `#[ignore]`):
  `GRIMOIRE_IT_SERVER=http://<host>:<port> cargo test --release -p grimoire integration_against_a_server --
  --ignored --nocapture` against a scratch server (multiplayer-notepad with `STORAGE=local ALLOW_DEV_LOGIN=1
  SIGNIN=open PUBLIC_URL=…`): the connect flow (the browser part done by the test: dev sign-in, Allow on
  /connect, the redirect), joined list, tree, the note over the real WebSocket while a headless browser
  edits it ("Bob was here"), our edit and caret, Bob's caret and his next edit, then create / rename /
  delete over REST. Run 2026-10-27 against W1's server: both sides converged byte for byte (server file ==
  the Mac's text) and the browser showed the "Mac user" caret label.

## Links

Clicking a link follows it; its pencil opens it for editing (like the web editor, same rules):

- **Never revealed by the caret:** editor-core keeps every link collapsed whatever the caret or
  selection (the caret steps through its text like plain text; its brackets and URL are no caret
  stops, see editor-core's README). Only `Editor::expand_link` (the pencil) expands one: its URL
  is then ordinary text (marker grey, a caret stop at every character, typing edits it); its
  `Chip` segments carry the link's element (`el`) and are hidden while it's collapsed.
- **Collapsed link:** its text in the link colour, underlined, then a pencil. Layout keeps a slot
  for the pencil in the text (`PENCIL_SLOT`, a transparent `W` at 0.85 em, the size the old `↗`
  chip had, so lines keep their metrics and the pencil never wraps away from the link's last
  word; `Piece::pencils`). `Geo::links` lists the collapsed links on screen: their text rects
  (or the image a link wraps), their pencil and where their text ends. The view lays an element
  with `Cursor::Pointer` over each text rect (its gestures go to `surface_drag`, shifted by its
  position; while a gesture that started there is held, a stand-in with the same key covers the
  surface, so revealing the link mid-drag doesn't cut the drag off), and draws the pencil
  (`render::pencil_icon`) with its own hover and press.
- **A plain click on the text** (left button, no modifiers, single click, released within 4 pt)
  follows the link on release and leaves the caret, the selection and the reveal alone. Moving
  further first selects from the press point as a normal drag would. Shift-click extends,
  Cmd/Option/Ctrl-clicks and double/triple clicks place the caret or select as usual (the first
  click of a double click has already followed the link). A click on an image wrapped in a
  collapsed link follows the link. **Cmd-Enter** follows the link holding (or touching) the caret.
- **The pencil:** a press expands the link (`Editor::expand_link`), the caret at the end of its
  text (before `]`); the caret or selection leaving the link (`[`…`)`) collapses it again. An
  expanded link has no pencil and clicks in it place the caret as anywhere else. A link around
  just an image has no pencil (the image is the link) until the image's source shows (the caret
  on the image); its pencil then sits after the source.
- **Targets** (`links::resolve`, on the URL's source: `<…>` dropped, backslash escapes undone):
  `http:` / `https:` / `mailto:` → `/usr/bin/open <url>` (one argument, no shell; normalized by
  `url::safe_url`, spaces as `%20`); any other scheme (`javascript:`, `data:`, `file:`,
  `vbscript:`…) and `//host` → nothing. `#heading` → the heading of this note whose GitHub slug
  (lowercase, punctuation but `-`/`_` dropped, spaces → `-`, repeats `-1`, `-2`…) matches, also
  when written as the heading's text; the caret goes to its text start and it scrolls to the top
  of the view. Anything else is a path: `?query` dropped, `#fragment` kept, `%`-escapes decoded
  (control characters and `\` refused), relative to the note's folder or, with a leading `/`, to
  the notes folder; `.`/`..` resolved, and it must stay inside the notes folder (also through
  symlinks), else nothing. `plan` (no `.md`/`.markdown`) is tried as `plan.md` too. A Markdown
  note opens in the app like a press on its sidebar row (the open note saved first, its folders
  opened, the title set), then goes to the `#fragment`; another existing file opens with its
  default app (`open <path>`); a missing one shows the toast "No note at “notes/plan.md”" (relative
  to the notes folder) with **Create it**, which writes it with `# plan` and opens it (as the web). No folder (the built-in sample): only URLs and
  headings work.
- **Toast:** `App::show_toast`: an ink pill centred near the bottom of the page, faded out after
  2.5 s (a `Live` opacity set from a timer thread; headless runs keep it). `App::toast_with` adds a
  button (`links::ToastAction`: "Create it") and shows for 8 s, as the web's toasts with an action.
- **Headless:** nothing is launched; every action is recorded in `App::link_log` and printed to
  stderr as `grimoire: link: open https://example.com/`, `note sub/deep.md`, `heading #x`,
  `missing nope.md`, `ignored javascript:…`.
- Tests: editor-core `tests/link_urls.rs` (arrows, words, Up/Down and clicks through a collapsed
  link never reveal it, typing and deleting in its text, `expand_link`: editable URL, clicks in
  it, collapsing on leaving, remote edits and undo removing it); `links::tests` (schemes and unsafe
  ones, headings and slugs, paths incl. `..`, `%2F`, `%00`, root-relative, escaping the root and
  a symlink out; clicks: open without moving the caret, drag selects, Shift-click, double click,
  the pencil, a click in a revealed link edits, relative notes with sidebar row and title, a
  `#fragment`, missing notes and headings, Cmd-Enter, linked images); `layout::tests` (the pencil
  slot, its rect, link rects and hits, the caret in the text not revealing, expanded URL carets
  and hits);
  snapshots 34–39, 56 (`tests/fixtures/links`).

## Untitled notes take their heading as a name (once)

A note named `Untitled.md` / `Untitled <n>.md` (`files::is_untitled`) whose first line is an H1 (`# Some
title`) is renamed when Enter is pressed at or after the end of that line (`input.rs` → `App::auto_name`):
to the heading's plain text (`files::heading_title`: `![alt](…)` → alt, `[text](…)` → text, backslash
escapes, `*`, `` ` ``, `~~`, `==` and `_` at a word's edge dropped; `/ \ : * ? " < > |` and control characters
→ spaces; spaces collapsed; no leading dots; trimmed; at most 80 characters) + `.md`, in the same folder; a
taken name becomes `Title 2.md`, `Title 3.md`… (`files::free_name`). Not for an empty heading, a first line
that isn't an H1, or a title that's itself `Untitled…`. Only once: after it the note isn't untitled, so
later heading edits never rename it. Local: the edits are saved first, the file is moved, and the saver,
the sidebar, the window title, the folder's last note and the folds follow; the editor keeps its text and
caret. Remote: the server's rename (`POST /api/workspace/:id/rename`, as the sidebar's Rename); the new name's
room is joined without a blank moment (`App::reopen_renamed`: until its sync the old text and caret stay
shown read-only and the new room's editor waits in `App::staged`, then takes over with the caret where it
was; also when the room itself says the note was renamed). The web app gets the same rules.

## Sidebar

**Share with an agent** (`sidebar::agent_card`, the web's `.sb-agent`): a card pinned at the very bottom
(neutral tint, 6 pt radius, no border) with "Share with an agent" and **Share** at the right, which
opens **Share with an agent** (`actions::open_share`, `dialogs::ShareDlg`; the web's `shareDialog`, word for word,
520 pt wide). It replaced the switcher's "Share with agent…" item.
- **A remote folder**, two sections with a hairline between them:
  - **This workspace**: "Give this prompt to an agent. It works with this workspace directly over HTTP (no setup) and can
    only see this workspace.", this account's agent link for the folder in a monospace field with its own Copy
    (`POST /api/workspace/:id/agent-link`: `{url}`, made when the dialog opens, "Making a link…" until then, then
    remembered per folder), and **Copy prompt** (`actions::copy_agent_prompt`: the web's agent prompt,
    `dialogs::agent_prompt`: "Work in this Grim notebook: <agent URL>" and to fetch it first).
  - **All your workspaces (MCP)**: add Grim as an MCP server (it works with all your workspaces and signs in with your
    Grim account the first time; on a server without sign-in "no sign-in needed on this server"), the server's MCP URL
    (`ShareDlg::mcp_url`: the agent link's origin + `/mcp`) with its Copy, **Copy prompt** (`dialogs::mcp_prompt`: add
    it to your MCP configuration, then use list_workspaces and command), and **opencode config**, collapsed at first
    (`dialogs::mcp_snippet`: its `opencode.json` entry, with its Copy).
- **A local folder**: only "This folder": "Give this prompt to an agent on this Mac…" and **Copy prompt**
  (`actions::local_agent_prompt`: "Work in this folder of Markdown notes: <absolute path>" and to read and edit the
  .md files directly, Grim showing the changes as they happen, keeping notes as Markdown). No link, no MCP.
- Every copy button shows "Copied" for 1.5 s (`AgentCard::copied`: the button that copied); **Done**, ×, Escape and a
  click outside close it. Shown for local folders, and for remote ones that are loaded and ready while signed in
  (or on a server without sign-in); guests don't see it.

Styled after the web app's sidebar (`src/client/app.css` in multiplayer-notepad: `.sidebar`,
`.sb-actions`, `.sb-search`, `.repo-row`, `.folder-row`, `.file-row`):

- 34 pt clear at the top for the traffic lights, then the workspace switcher (below, under
  Workspaces; it replaced the folder's name label), the search button right under it (a field's look:
  32 pt, paper, 1 pt hairline, "Search files" in the muted grey, a `⌘P` hint; a press opens the dialog), then "+ New
  note" as a quiet row with a hover tint (this order since 2026-10-28, as on the web; 10 pt apart, the tree
  where it was): Inter Regular 13.5 in the muted grey (`#62626a`, ink on hover), a light 1.5 pt plus
  (`#8b8b93`) in the chevrons' 10 pt box with its centre on the top-level chevrons' (22 pt from the sidebar's
  edge) and the label where top-level names start (34 pt); and the tree in its own scroll viewport.
- Rows are 28 pt, inset 8 pt with 6 pt corners, Inter 14. A folder has a 1.5 pt chevron
  (right when closed, down when open) and the name in `#3f3f46`; each level indents 14 pt; note
  names drop the extension and are cut with "…". The open note's row is `#e4e4e7` and semibold;
  other rows tint `#ececee` under the pointer. The tree clips hard; its top and bottom edges fade (12 pt) only
  while rows are scrolled under them. While the tree has the keys, its current row is shown only
  by its background, a light blue `#d0dce5` (the app blue `#296d9a` 18 % over the sidebar's `#f4f4f5`,
  mixed in sRGB like the web's `color-mix`; Rune's alpha blending is in linear light and came out grey),
  the text staying dark; no edge or ring, and the pointer doesn't change it.
- **Row menu**: a right-click, Ctrl-click or two-finger click on a row (`on_secondary_press`, at the
  pointer), its **⋯** (20 pt at the row's right end, shown while the row is hovered or is the tree's current
  row; the menu drops from the row, `PopupAnchor` = the row's key), or Shift+F10 / the Menu key while the
  tree has the keys (handled in `App::tree_key`: Rune's own Shift+F10 needs a focused Rune element) open a
  **native** menu (`Tx::popup_menu`, an `NSMenu`) with exactly the web's items, in its order and with no
  separators: **New note**, **New folder**, **Rename**, **Delete**, for notes and folders alike. A note in a
  remote workspace adds, after a separator, **Copy Link** (its web address, `<server>/app/<id>/<path>` with
  each part percent-encoded as the web's `urlFor`; "Link copied") and **Open in Browser**
  (`App::note_web_url`); read-only remote folders have only those two; local folders never have them
  (`tree_edit::row_popup`); dismissing it does nothing. New note and New folder are the File menu's,
  aimed at the row's folder (a folder row's own, a note's folder: the row becomes the tree's current row). There is no in-window fallback any
  more (the app is macOS-only; elsewhere `popup_menu_supported()` is false and the menu answers nothing).
  No menu and no ⋯ in a read-only or unloaded remote folder. **Rename** turns the row into a field holding
  the path (a note's without `.md`), its last name selected: Return renames (`App::rename_path`; a note
  gets `.md` back; a folder can't go inside itself; a taken name says “… already exists”), Esc keeps the
  old name. Locally the file or directory moves and the saver, the open note, closed folders, folds and
  the window title follow. **Delete** confirms first: "Delete note" / "Delete folder", remote "Delete
  “path”? It stays in the Git history." (a folder: "… and the N notes in it? They stay …"), local "Move
  “path” to the Trash?" (a folder: "… and everything in it to the Trash?"); Delete is the danger button. A
  local delete moves it into `~/.Trash` ("name 2.md"… when taken); the first note left opens.
- **File menu** (the menu bar, `tree_edit::FILE_MENU` as `rune::MenuItem`s): **New Note** ⌘N, **New
  Folder** ⇧⌘N, **New Workspace…** ⌥⌘N (the New dialog, as the switcher's: a new folder on this Mac or on a server, the
  latter asking to sign in), **Open Workspace…** ⌘O (the Open dialog: URL, GitHub repo), **Open Folder…** ⇧⌘O (the system
  folder picker), **Search Files…** ⌘P; Close ⌘W is Rune's standard Window menu. Rune's custom menu items have
  no separators yet, so there's none between New Workspace… and Open Workspace…. They wait while
  a dialog is open. ⌘N is only the menu's now (`input.rs` has no ⌘N). Scripts fire them with
  `{"menu": "New Note"}`.
- **Keyboard** (as on the web): two places have the keys, the tree and the editor; the tree has one current
  row (`App::tree_cur`: the open note unless the keys moved elsewhere). A press on a row or ⌘⇧E (from
  anywhere: the current row) give the tree the keys; a press on the page, Esc, Tab or Return on a note give them back to the editor. In the tree
  (`App::tree_key`; the editor gets none of these, and its caret stops blinking and isn't published to the
  room): Up/Down the previous/next shown row (no wrap), Right opens a closed folder or goes to an open one's
  first child, Left closes an open folder or goes to the parent, Home/End the first/last row, Return on a
  folder opens or closes it; moving onto a note opens it at once (the keys stay in the tree), onto a folder
  only selects it (new notes go there); typing jumps to the next row whose name starts with what was typed
  within a second.
- **Press a note:** the open note is flushed (`save_now`, before reading, so the open note
  pressed under another name — a symlink — is a no-op; paths compare canonicalized), the new one
  is read and gets its own saver, its folders open, the page scrolls to the top and the window title becomes its name
  (`Tx::set_title`). **Press a folder:** it opens or closes (kept in memory in
  `App::collapsed`; all open by default) and becomes the tree's current row (where new notes go).
- **New note** (the row or ⌘N): `Untitled.md` (`Untitled 2.md`… when taken) in the **selected folder**
  (`App::selected_dir`: the tree's current row's folder — a note's folder, a folder itself — else the
  root; a folder still on disk, even one emptied of notes), written empty, added to the tree without a
  rescan, opened with the caret at the start, and the editor has the keys (`App::type_here`: never the tree,
  the search dialog or a menu — also from the row menu's New note and "+ New note"; New Folder hands them to
  the folder's name instead). `45-new-note` and `142-new-folder` show the tree no longer focused after them.
- **New Folder** (⇧⌘N): "New folder" ("New folder 2"…) in the selected folder with an empty
  `Untitled.md` in it, opened (its folders open), and the folder's row in rename at once (Return names
  it, Esc keeps "New folder").
- **Search files** (⌘P — File ▸ Search Files… — or the sidebar's search button; as the web's Ctrl+P
  dialog, `filesearch.rs`): a card 560 pt wide 12 % down the window over a dimmed backdrop, a focused
  field ("Search files", 15 pt) and a flat list of the open folder's notes as full paths without the
  extension, the folders muted and the name semibold (`fs-item:<n>` rows, 30 pt). Ranked as the web's
  `rankFiles` (`filesearch::rank`): the name starts with the query, then contains it, then the path does,
  then every word is in the path (or loosely in order in the name), then the letters in order; ties: shorter
  names, shorter paths, then by path; an empty query lists every note by path. At most 200 rows ("Showing
  200 of N. Type more to narrow it down."), "No matching files" when nothing matches. Up/Down move the
  highlight (`#d3dee5`, the web's 18 % blue over the paper; no wrap; another query starts at the first row
  again), the pointer moves it too; Return or a press opens the note, closes the dialog and gives the editor
  the keys; Esc or a press outside closes it. The field takes its keys first (`on_input_key` hands it
  Up/Down/Return/Esc); while it's open the editor gets none and an IME composition never crosses between
  them. Local and remote folders alike (the tree's notes). The tree is never filtered; the old "Filter
  notes" field, its ⌘K alias and its Down-into-the-tree are gone (the Mac never had the web's "/").
  The rows are cached on the scan and the closed folders, so typing in the editor doesn't rebuild them.
- **Show/hide:** Cmd-\ or Cmd-Shift-L. Until the user toggles, it shows when the window is at
  least 700 pt wide. The page column is centred in the width left over (`layout::set_viewport`
  gets the editor's width); hits need no offset because `Drag` is relative to the surface. Beside
  the sidebar in a narrow window the column squeezes down to `MIN_TEXT_W` (100 pt) and the page
  is clipped to its own area, so nothing slides under the sidebar.
- **Refresh:** a thread rescans the folder every 2 s (directory entries and metadata only; the
  startup scan is reused for the first tree and fingerprint) and, when the fingerprint changes,
  hands the new tree to `App::refreshed` through `AppHandle::update`. `App::check_disk` reloads
  the open note with `Editor::set_text` (the caret is mapped, IME marked text dropped) only when
  the file differs from what the saver last *confirmed* writing, the editor holds exactly that
  (nothing queued, nothing failing to save), and nothing was typed for 3 s. When it can't decide
  yet it sets `App::recheck`, and the thread calls `check_disk` again on its next tick even if the
  folder didn't change, so an outside edit made while typing still loads after the pause.
- **Saving:** one `doc::Saver` thread per open note writes ~1 s after the last edit, through a
  temporary file unique to the write (`.name.<pid>-<n>.grimoire-tmp`) and a rename. It keeps the
  last text it wrote successfully (`confirmed`). A failed write stays queued and is retried every
  second (also for a while after switching notes); it's logged once.
- A folder with no notes shows the empty state ("No note open.", New note; see No note open) in place of the page, and
  keys don't reach the editor.

## Styling compared with the web editor

- Same fonts, sizes, paddings, colours, bullets (5 pt squares), checkboxes, quote bar, code
  block, table rules and hr. Bold is Inter Bold (700), and the H1 is 700.
- Italic is Inter Italic / Bold Italic (`Span::italic`). There's no SemiBold Italic face, so
  italic inside an H2–H6 (600) uses the nearest face.
- A collapsed link is its underlined text and a small drawn pencil after it (muted `#a1a1aa`,
  `#52525b` under the pointer); revealed, its whole source shows, the URL in the markers' grey
  (see Links).
- A tab character is drawn as four spaces.
- The text column follows the window: the width left after the gutter and margins, at most
  767 pt (`MAX_TEXT_W`: the web's `.mde-content` max-width of 840 px less its 49 px gutter and 24 px right
  padding, the Mac's `PAD_L` and `PAD_R`) and at least 100 pt (`MIN_TEXT_W`), centred. Narrower windows wrap.
  Images are at most the column's width (and 480 pt high). `min_size` is 420×320.

## Input

- **Mouse:** one `on_drag` on the surface. `Drag` is measured from the scrolled rect, so the
  pointer maps straight to document space (`d.x - PAD_L`, `d.y - PAD_T`). `Drag::clicks` gives
  double-click (word) and triple-click (line), and `Drag::mods.shift` extends from the anchor.
  A drag after a double or triple click keeps the first selection: editor-core's `mouse_drag`
  has no word or line granularity. Checkboxes have their own `on_drag` on top.
- **Keys:** every key goes through the macOS text system's table (editor-core `macos_keys`; the
  whole list of bindings, what's implemented and what's skipped is in its README): Ctrl-A/E
  (paragraph ends), Ctrl-F/B/N/P, Ctrl-D/H, Ctrl-K kills to the paragraph end and Ctrl-Y yanks
  (a kill buffer apart from the clipboard, kept across notes), Ctrl-T, Ctrl-O, Ctrl-V, Ctrl-L,
  Ctrl-Option-B/F, Ctrl-←/→, Ctrl-Backspace, Ctrl-Return, Shift-Home/End, the Shift forms, and
  the user's own `DefaultKeyBinding.dict` over them (`keys.rs`). Cmd-Left/Right go to the visual
  line's ends on a wrapped paragraph, Ctrl-A/E to the paragraph's. Ctrl-letters reach `on_key`
  as the letter with `ctrl` (or as its control character); Option-letters as their composed
  character, plus the key's own letter from Rune's `Tx::key_base()`, which is what a user's
  `"~f" = "moveWordForward:"` binds (unbound, Option-F still types ƒ). Ctrl-↑/↓ (and the system's
  Ctrl-←/→) are Mission Control's unless that's turned off.
  Typing and every editing or moving key end with `tx.scroll_into_view("caret")` (the scroll view has
  `scroll_margin(24)`), so the caret stays visible with the least scroll. Home/End are editor-core's
  `ScrollToStart`/`ScrollToEnd` → `tx.scroll_to_y("scroll", 0 | ∞)`; the caret stays. Paging (`Command::Page`:
  PageUp/PageDown, Option-PageUp/PageDown, Ctrl-V) needs the viewport, so it's done here: the
  caret moves by the viewport height less two lines, keeping its x (Shift extends), and scrolls
  into view. Ctrl-L scrolls the caret's line to the middle of the view.
- **Mouse:** `Drag::clicks` counts double and triple clicks (AppKit's interval and slop), `Tx::mods()`
  gives Shift-click; a right-click or Ctrl-click on a sidebar row opens its native menu
  (`El::on_secondary_press`, `Tx::popup_menu`).
- **IME:** through `App::on_ime` (Rune hands the app the input method when no text field has focus and the
  caret element has `ime_cursor()`). `Ime::Preedit` keeps the marked text and the IME caret in `App::marked`; the view
  splices it into the caret's piece with an underline (`Geo::splice_marked`) and puts the caret
  inside it. `Ime::Commit` → `begin_composition` + `end_composition(text)`, which replaces the
  selection. Keys pressed while composing go to the IME and not to `on_key`, so the selection
  can't change mid-composition. `Ime::Disabled` drops the marked text. The caret element carries
  `ime_cursor()`, so the candidate window opens beside it (the caret element exists, transparent,
  even under a selection).
- **Press and hold:** `main.rs` registers `ApplePressAndHoldEnabled = NO` in the
  `NSUserDefaults` registration domain before the window opens, so held keys repeat instead of
  opening the accent picker (which winit can't deliver correctly). A user's own
  `defaults write` value still wins. It's done in code, not in `packaging/Info.plist`, because
  `NSUserDefaults` doesn't read Info.plist keys, and so it also covers the unbundled binary.

## Dropping images

Drag image files from Finder onto the page (Rune's `El::on_drop_files` on the surface with
`accepts_files(is_image)`, `on_drop_move` for the drop caret and `on_drop_hover(false)` to hide it; the
drop point is `Tx::drop_point()`; points are surface-local with the scroll included, like `Drag`):

- Only images count: `png jpg jpeg gif webp heic svg tiff tif bmp`, any case. Other files are
  skipped, and when none of the hovered files is an image there's no drop caret.
- **Hover:** a 2 pt `#007aff` drop caret (`drop-caret`, `App::drop_at`) at the text position the
  pointer hit-tests to: the same `to_text` clamp and `Editor::hit_test` (with the hidden-marker
  affinity) as a click. It hides when the drag leaves and when the files move over the sidebar, which is a
  drop target that takes nothing, so it also wins where it covers the page. The page's side
  margins outside the surface aren't a target (as for clicks).
- **Drop:** one `![stem](url)` per image, joined by newlines, inserted at the drop point as is
  (mid-line stays inline, in the line's text) with `Editor::set_selection(caret)` + `Editor::paste`: one
  undo step, the caret after the text, any selection collapsed, autosave as for typing. The
  search dialog closes and any IME marked text is dropped.
- **Where the link points:**
  - An image inside the notes folder (after `canonicalize`) is linked by its path relative to
    the note's folder (`shot.png`, `../../assets/logo.png`).
  - Anything else is copied into `images/` beside the note (created): `images/name.png`, or
    `name-2.png`, `name-3.png`… when a different file has that name. A file there with the same
    size and bytes is reused, not copied again.
  - Headless runs work out the same link but copy nothing. The built-in sample (no folder, no
    note path) links the absolute path.
  - The URL is percent-encoded where the editor's link parser would break: whitespace, `(`, `)`,
    `%`, `<`, `>` (`cat photo (1).png` → `cat%20photo%20%281%29.png`). editor-core's parser (like
    the TS one) ends a URL at whitespace and has no `<…>` form. `[`, `]` and `\` in the alt text
    are backslash-escaped.
- The dropped link renders as the image (below) once the file is there.
- Tests: `drop::tests` (image extensions; relative links incl. `../`; copy, reuse and de-dupe in
  temp dirs; headless copies nothing; encoding; the link parses as one link). Script
  `file-drop.json` (`52`–`54` below).

## Code highlighting

Fenced code blocks whose info string names a language are coloured like the web editor, with
Pierre's [`@pierre/highlights`](https://www.npmjs.com/package/@pierre/highlights) 0.3.0
(Apache-2.0, `crates/app/assets/highlights-LICENSE.md`): its WebAssembly module
(`crates/app/assets/highlights.wasm`, from the npm package) runs inside the app in
[Wasmi](https://github.com/wasmi-labs/wasmi) 2.0, a pure-Rust interpreter.

- **`crates/highlight`**: `Highlighter` (the module compiled once, lazily: on the first block that
  needs it) and `Tokenizer`, a port of the package's `LiveTokenizer` (`dist/live.js`) over the
  module's `live*` exports: `liveStage` + `liveInitDoc` + `liveRun` for the text, one
  `liveApplyEdits` per change (the common prefix and suffix of the old and new text kept; UTF-8
  byte offsets converted to the module's line / UTF-16 column positions), then `liveRun`, which
  re-lexes from the edited line until the lexer state matches the previous run; only the lines in
  `liveChangesPtr`'s change list are read back. Line records (packed24 `(id << 24) | end` or wide32
  pairs, ends in UTF-16 units) become byte-offset `Token`s. The imports `env.is_id_start` /
  `env.is_id_continue` take a UTF-8 code point in memory (pointer, length) and answer with
  `unicode-ident` (XID_Start / XID_Continue, plus ZWNJ/ZWJ for continue, as the JS regexes).
  `info_lang` takes the info string's first word, case-insensitive, through the package's alias
  table (`src/tables.rs`, generated from `dist/languages.js` and `dist/token-types.js`: 299
  names, 121 lexers); `plain`/`text`, unknown names and no info string are left alone. Wasmi is
  built without `wat`, memory64 and the validator (`Module::new_unchecked` on the embedded
  module; a test validates it), with SIMD (the module uses it). A `\r` lexes as a space.
- **Theme** (`crates/app/assets/highlight-theme.json`, the web app's file as is): a token takes the
  entry of the longest dotted prefix of its name (`keyword.control` → `keyword`), else the
  foreground (`#1d1e22`, the code ink): colour, `italic`, `bold`. `lines` gives a code line a
  background across the block (drawn after the block's own, before the text): a line whose first
  token that isn't punctuation (the `+`/`-` marker is `punctuation.special`) is `diff.plus` /
  `diff.minus`; in a diff, a line of just `+` or `-` too (an added or removed empty line). So
  `--- a/file` / `+++ b/file` headers are tinted, `@@` hunks and context lines aren't.
- **Drawing:** `layout::build` asks `highlight::highlight(src, views)` for each code line's token
  ranges (raw byte ranges; tokens drawn like plain text are left out) and `make_piece` adds a
  span per token (colour, `italic`, weight 700 for `bold`) after the line's own, mapped through
  `r2d` (a tab's four spaces stay in its token). The spans go into the same Parley layout the
  carets, hits and selections use and that Rune paints, so they always agree; colour isn't part
  of the layout cache key. Menlo's italic, bold and bold italic faces have the regular face's
  advances (`layout::tests::menlo_styles_share_advances`), so glyph positions don't move.
  The fence lines stay as they were.
- **Updates:** every build compares each block's text (its code lines joined by `\n`) with the
  cached one: unchanged blocks cost a string compare; an edited block (typing, paste, undo/redo,
  a reload with `set_text`, a remote change) gets the difference as one edit. A new block, a
  changed language or a block whose tokenizer was dropped (more than 8 live) tokenizes from
  scratch. Blocks no longer in the note are dropped (switching notes drops them all). A note
  with no highlighted block skips it all (one pass over the line views).
- **Cost** (M-series laptop, release; `cargo run --release -p highlight --example highlight_bench`
  and `cargo test --release -p grimoire -- --ignored --nocapture typing_in_a_long_code_block`):
  compiling the module 2–2.5 ms once; a 500-line TypeScript block (20.8 kB) tokenizes in ~7–8 ms;
  typing a character in it re-lexes in ~0.03 ms (0.15 ms worst); opening a `/*` at its top
  0.75 ms and closing it 5.6 ms (everything below re-lexed). In the app, a keystroke in that
  block is a ~0.7 ms `build` (0.15 ms of it highlighting: building and comparing the block text,
  the edit, the token lists) against ~0.37 ms for the same block without a language. The
  release binary grows by ~2.4 MB (15.73 → 18.19 MB: Wasmi, wasmparser's parser, the 282 kB
  module).
- **Fidelity:** `crates/highlight/tests/fixtures.rs` compares our tokens (name and text of every
  run) with the JS library's for ts, rust, python, json, sh, diff and patch snippets (non-ASCII
  and astral characters included) and for edit sequences (applied in UTF-16 positions in JS,
  as byte replacements and as `set_text` here): identical. The fixtures
  (`tests/fixtures/expected.json`) are written by `tests/fixtures/gen.ts` with bun from the npm
  package. Incremental results also equal a fresh tokenization after every step of typing a file
  character by character and other edits. The one known difference: ID_Start/ID_Continue (JS)
  vs XID_Start/XID_Continue (`unicode-ident`) disagree on a few compatibility characters in
  identifiers.
- Tests: `crates/highlight` (fixtures, edits, incremental vs fresh, change lists, languages, the
  theme's prefixes, diff backgrounds, the module validates); `layout::tests` (colours, italic
  comments, unknown / no language and fences plain, info string case and extra words, tabs; text
  and every caret and hit unchanged against the same block unhighlighted; Menlo advances; diff
  and patch backgrounds; edits, undo, typing outside, reloads, a new block, changing and dropping
  the language); `highlight::tests` (more blocks than live tokenizers, the cache dropped with
  the note); snapshots 92–96.

## Images

`![alt](src)` and `![alt](src "title")` (also `'title'`, `(title)`) draw the image where it is in
the line, splitting the line around it, like the web editor (`src/client/editor/render.ts`, `.imgs` in `editor.css`; parser and
navigation behaviour mirrored from multiplayer-notepad 67ce146):

- **Parsing (editor-core):** `InlineType::Image` with `InlineEl::src` (the source range) and
  `title`, ported from the TS `parser.ts`: one line only, the alt text isn't parsed for styles,
  the markers are `![`, the alt text and `](src …)`, so the whole source collapses. Table cells
  have no images (`parse_inline_with(.., false)`: `![a](b)` is a `!` before a link). Links still
  have no titles and can wrap an image. Destinations may be in angle brackets (CommonMark:
  `![my cat](<my cat.png>)`, no line break or unescaped `<` inside; links too, `safe_url` drops
  the brackets); the brackets stay in the source range. `LineView::images` lists them
  (`ImageView`: range, alt, source as written, title, revealed) and `LineView::image_only` /
  `text_hidden()` mark a paragraph of nothing but images (optionally inside links), as the TS
  `isImageLine`: every inline element on the line is an image or a link around one, on this
  line (an image line inside bold spanning the paragraph's lines is text). While `text_hidden()`,
  every non-token segment is hidden, so a linked image gets no pencil.
- **Splitting (editor-core `LineView::parts`):** a line with images is a list of parts: text
  parts (`LinePart::Text`, raw ranges, `shown`) and image blocks (`LinePart::Images`, a range of
  `images`). A text part ends after an image's source, the block follows on its own row(s), and
  the text after it starts a new row below: `this is ![x](…) a line` draws "this is", the image,
  then "a line". Images (or links around just an image) with only whitespace between them share a
  block. A part with nothing visible (only collapsed sources and whitespace, e.g. before an image
  starting the line, or spaces after one ending it) isn't `shown`: no empty row; its positions sit
  at the end of the shown part before it, else the start of the next (if no part would show, the
  first does, keeping a row for the caret). The whitespace starting a text part after a block is
  a hidden `Text` segment: real text with caret stops, drawn at zero width (no indent at the row's
  start, like whitespace at a soft wrap); whitespace before an image stays at the end of the row
  above, where it hangs like at a soft wrap. Image-only lines are one text part (shown unless
  `text_hidden`) and one block, as before.
- **Reveal:** the same rule as links: the source shows (dimmed markers, the alt text in ink) when
  the caret or selection touches it, in place, and its block stays right after it (the row
  breaks after the source); collapsed, the source just collapses out of the text. An image-only line shows only its images
  while collapsed; with the caret on it (every position touches an image) the source row appears
  above them, and the images stay drawn (they move down by one row, as in the web editor).
- **Layout (`layout.rs`):** each `LineGeo` has one `Piece` per shown text part, top to bottom,
  `images: Vec<ImgGeo>` and `blocks` (each image block's band), and its height includes them, so
  hits, carets, Up/Down, scrolling into view, IME marked text and selections all see them. A
  caret position goes to the first piece ending at or after it (at a block's end: the part before,
  holding the source); a hit to the piece under y. Gutter tokens sit beside the first row (the
  image's top when a block comes first). Images flow left to right from the content's left edge
  (inside list items too), 6 pt apart, wrapping at the column; 4 pt above a block (6 pt with no
  text above it on the line) and 6 pt below. Size: one pixel a
  point, at most the column wide and `MAX_IMAGE_H` (480 pt) tall, aspect kept; 6 pt corners.
  Sizes come from `images::state` (Rune's `ImageCache` underneath: decoded on its worker, which wakes the
  app; one handle per path, the file re-read when its mtime or length changes, checked at most every
  500 ms; headless runs wait for each decode), so the line grows when a load finishes (the view runs again); while loading the placeholder's height is kept and nothing is drawn. Once known, a size
  stays (layout never decodes again, however many images a note has), and a touched file keeps
  its previous image and height until the new one is decoded.
- **Sources (`images.rs`):** relative to the open note's folder with `%`-escapes decoded and
  `?query`/`#fragment` dropped (`images/cat%20photo%20%281%29.png` from a drop works; drops
  escape `?` and `#` in names), control characters rejected after decoding (`%00`), `<…>`
  stripped, absolute paths, `~/…`, `file:///…` (and `file://localhost/…`). http(s) shows a
  "Remote image: alt" placeholder (not downloaded). The sample note has no folder, so only
  absolute sources load there.
- **Formats:** PNG, JPEG (EXIF orientation applied), GIF (first frame), WebP, BMP, TIFF, SVG; at most
  8192 px a side.
- **Placeholder:** missing, unreadable, unsupported (HEIC) or unresolvable images draw a
  muted `#ececee` pill with a broken-image icon and "Image not found: alt" at 0.8 em.
- **Mouse:** images are hit explicitly (`Layout::image_at`, implemented by `Geo`): each row of
  images is a band across the column (from the text above or the previous row to the next row,
  the text below or the line's bottom), and a point in a band is on the nearest image of that row (beside a narrow image, in
  the gaps). `hit_test_adjusted` returns the image's end as is (no edge jump past a following
  hidden image). A click puts the caret after the source, Shift-click extends there, a double
  click selects the source and a triple click the line (`Editor::mouse_down`; later clicks of a
  sequence act on the image the first hit, as the first reveals the source and moves it). Among
  other text an image's collapsed source isn't an edge marker (`only_hidden`): a click past the
  text stays before it. Up/Down step over images among a line's text (from the text before an image to the text after
  it) (TS `moveVertical`); only on
  a collapsed image-only line are they caret stops, landing at the end of the image under the
  goal x, with no re-hit at the text row. A selection covering an image's whole source tints the
  image too.
- Tests: editor-core `tests/images.rs` (the TS `images.test.ts` cases: alt/source/markers,
  titles, not-images, angle-bracket sources, links around images, table cells, segments,
  image-only lines, reveal, line views, the hidden chip of a linked image, images not edge
  markers among text; line parts: a mid-line split, images at the line's edges, shared blocks); `images::tests` (resolving, `?`/`#`, control characters);
  `layout::tests` (box sizes, line heights and image positions with `tests/fixtures/photos`,
  clicks, the revealed source row, Up/Down over images, two images on a row and a narrow one
  under text: clicks, double/shift-clicks, Up stepping over and stopping, placeholders; a mid-line image: pieces, carets, clicks, Up/Down, revealed, selection across it,
  wrapping before it, an image starting a line); snapshots 85-91 (`tests/fixtures/inline`:
  collapsed, revealed, Down/Up, a drop mid-line, narrow); `drop::tests` (a dropped link parses as an image and resolves back to the file).

## Rune APIs the app relies on

All on Rune `dev` (see docs/rune-capabilities.md, "Rune dev"): `TextSystem::layout_rich` for every
layout, `Cx::layout_size("root")` for the window size, `Tx::scroll_to_y` / `scroll_into_view` +
`El::scroll_margin`, `Tx::set_title`, `Tx::open_folder`, `Drag::clicks`, `Tx::mods` / `button` /
`key_base`, `El::on_secondary_press`, `App::on_ime` + `El::ime_cursor`, `El::on_drop_files` /
`on_drop_move` / `Tx::drop_point`, `El::single_line`, `ImageCache` + `El::pixels`.

**Text layout check:** `layout::tests::carets_and_hits_land_on_the_glyphs_rune_draws` runs the app's view in
a headless `rune::Runtime` (the app's fonts) over a note with plain, bold, italic, bold italic, code
(Menlo), headings, emoji, CJK, Hangul and ligature-prone text (`office ffi -> => != www`, in body text and
in code), wrapped and not. For every piece it compares the glyph quads Rune places for *our* layout
(`TextSystem::glyphs_for_layout` at the element's drawn origin) with the glyph and colour-emoji instances
the runtime painted (they must be identical, rect for rect), then checks that each glyph lies between the
carets at its cluster's ends and that a hit at its middle lands on one of them.

## Headless scripts

`crates/app/scripts/run.sh` writes `crates/app/out/NN-name.png`:

| PNG | Shows |
|---|---|
| `01`–`05` | the sample and the scenes |
| `10`–`19` | heading, list Enter, bold, click on hidden markers, shift+arrows, todo, undo, drag, tab, click and drag after scrolling (now exact) |
| `20-shift-click` | click, then shift-click two lines down: the selection runs from the first click |
| `21-double-click` | the word under a double click |
| `22-triple-click` | the whole list item (raw line) under a triple click |
| `23-ime-preedit` | a dead-key `´` underlined at the caret after `caf` |
| `24-ime-commit` | `Commit("é")` then typing: `café ok` |
| `25-narrow` | a 420 pt window: the column narrows and wraps |
| `26-italic` | `italic.md`: real italic, bold italic, italic in a heading and a quote |
| `27-type-at-bottom` | `long.md`: Cmd-Down, typing and Enter at the end; the view follows the caret |
| `28-end`, `29-home` | End scrolls to the bottom (caret stays at the top), Home scrolls back |
| `30-page-down`, `31-page-up-shift` | two PageDowns move the caret two pages, then Shift-PageUp selects a page back |
| `75-ctrl-move` | three typed lines; Ctrl-A, Ctrl-P, Ctrl-E, Ctrl-N: the caret on the third line under the end of `second` (goal x) |
| `76-ctrl-kill-yank` | then Ctrl-K kills the rest of the line, Ctrl-P, Ctrl-A, Ctrl-Y yanks it at the start of line 2 and Ctrl-T swaps the two characters around the caret: `e of texstecond` |
| `77-ctrl-shift-e` | then Ctrl-Shift-E selects to the paragraph's end |
| `78-cmd-right-row`, `79-cmd-shift-left-row`, `80-ctrl-e-paragraph` | a wrapped paragraph in a 420 pt window: Cmd-Up, Down, Cmd-Right goes to the end of the second visual row (before its space), Shift-Cmd-Left selects the row, Ctrl-E goes to the paragraph's end |
| `81-ctrl-v`, `82-ctrl-l` | `long.md`: two Ctrl-Vs page down exactly as PageDown does (81 is byte-identical to 30), then Ctrl-L centres the caret's line |
| `83-user-keys`, `84-no-user-keys` | `--key-bindings=scripts/DefaultKeyBinding.dict` (`"~f" = "moveWordForward:"`, `"^w" = "deleteWordBackward:"`): Ctrl-A, Option-F twice, Ctrl-W leaves `one  three`; without it Option-F types `ƒ` and Ctrl-W does nothing |
| `34-link-click` | `tests/fixtures/links/Home.md`: a click on "web" opens it (stderr `grimoire: link: open https://example.com/`); the caret stays in the title, every link collapsed with its pencil |
| `35-link-pencil-hover` | the pointer on the pencil after "web": darker |
| `36-link-revealed` | the pencil pressed: `[web](https://example.com)` revealed, the caret before `]` |
| `37-link-drag` | a drag starting on "web": a selection from the press point, the link revealed |
| `38-link-note` | a click on "the plan" (`plan.md`): the note open, its sidebar row selected (title "plan") |
| `39-link-missing` | a click on "missing one" (`nope.md`): the toast "No note at nope.md", nothing created |
| `56-link-deep` | a click on "deep note" (`sub/deep.md#next-steps`): that note, the caret at "Next steps" |
| `40-sidebar` | `tests/fixtures/notes/Loose ends.md`: the tree (nested folders, a truncated name, the open note highlighted; no hidden folder, `node_modules` or `.txt`) |
| `41-switch` | press `people/hiring`, click in its text and type: the caret lands under the pointer beside the sidebar |
| `42-search-empty` | a press on the sidebar's search button: the dialog with every note by path |
| `43-search-filtered` | File ▸ Search Files…, `pl`, Down: ranked (`projects/launch/plan` first), the second row highlighted |
| `44-search-none` | `zzz`: "No matching files" |
| `143-search-open` | `hir`, Return: `people/hiring` opens and the next keys go to the editor |
| `45-new-note` | ⌘N (File menu) and a heading (root `Untitled`), then press `people` and "New note": `people/Untitled` |
| `135-auto-name` | ⌘N (File menu), `# Trip **ideas**`, Enter, "Pack light": the note is "Trip ideas" (sidebar row, title), the caret after "Pack light" |
| `46-collapse` | `projects` and `archive` closed |
| `47-sidebar-off` | Cmd-\ hides it; the column centres in the whole window |
| `48-narrow`, `49-narrow-toggle` | a 680 pt window starts without it; Cmd-\ shows it and the column narrows |
| `50-hover` | the hover tint on a folder row |
| `55-narrowest-sidebar` | a 420 pt window with Cmd-\: the column squeezes beside the sidebar, nothing under it |
| `51-empty-folder` | `tests/fixtures/empty`: the empty states |
| `52-drop-hover` | `long.md` scrolled; a `.pdf` alone hovers (no caret), then two images and a `.pdf`: the blue drop caret in "Paragraph 8: … fil‸l" under the pointer (over the sidebar it hides, back on the page it shows) |
| `53-drop` | dropped: `![cat photo (1)](images/cat%20photo%20%281%29.png)` and `![dog](images/dog.JPG)` on two lines at that point, the caret after them; nothing written (so both show the "Image not found" placeholder) |
| `54-drop-undo` | Cmd-Z removes both in one step |
| `60-images` | `tests/fixtures/photos/Photos.md`, caret at the top: an image-only line (800×450 PNG at the column width), a badge below its sentence (`my%20badge.png`, the source collapsed out of the text), a tall PNG capped at 480 pt, the "Image not found: old scan" placeholder |
| `61-image-caret` | a click on the sunset: the caret after its source, the source row (dimmed markers, alt in ink) above the image |
| `62-image-inline-caret` | then a click on the badge: its source revealed inside the sentence, the badge still below |
| `63-image-down`, `64-image-past` | from the end of "The sunset from the pier:", Down twice lands on the image line (source revealed), Down again steps past the image to the blank line (`image-updown.json` then comes back up over it) |
| `65-image-drop` | `images/sunset.png` from the fixture dropped after "Last line.": the link and the image below it |
| `66-image-narrow` | a 420 pt window: the images scale to the narrow column |
| `67-image-rows` | the whole fixture: two badges side by side on one line (the second's source in `<…>`), the linked badge with no pencil |
| `68-image-double-click` | a double click on the second badge: its source `![two](<images/my badge.png>)` selected (revealed above, the badge tinted) |
| `69-image-beside` | then a click right of the narrow badge under the sentence: the caret after the badge's source, not in the text above |
| `92-code-blocks` | `tests/fixtures/code/Code.md`: ts, rust, python, json, sh, diff and patch blocks coloured (italic comments, the diff/patch lines' backgrounds), a block without a language in ink |
| `93-code-comment-open`, `94-code-typed`, `95-code-undo` | typing in the ts block: `/* ` at the start of its first line turns everything up to the doc comment's end into a comment; then ` */` closes it on that line and a typed line (a template string) colours as it's typed; six Cmd-Z put the block back as in 92 |
| `96-code-narrow` | a 420 pt window: wrapped code lines keep their colours (tokens split across rows), the diff/patch backgrounds narrow with the block |
| `97-switcher` | `--support-dir=tests/fixtures/support`: the switcher open over `Loose ends.md` (local): This Mac (a dot on the open folder), On grimoire.exe.xyz with its three joined folders (titles only), New Workspace…, Open Workspace… (nothing that needs a server) |
| `98-switcher-add-remote` | then Open Workspace… → Remote folder: a URL typed |
| `103-menu-local` | the local menu again (as 97) |
| `104-menu-remote-owner`, `-editor`, `-viewer` | `--remote-demo=owner|editor|viewer` (with the support fixture): Team made by us, by someone else, and as a read-only GitHub copy (Open on GitHub); rows are names and × only, each server under its own "On <host>", This Mac; the account row at the bottom (no account items in the switcher) |
| `130-menu-row-hover` | `--remote-demo=owner`, the switcher open and the pointer over the first folder row (links, under This Mac): its × shows (the other rows' stay hidden, as in every snapshot without a hovered row) |
| `131-dialog-remove-from-list` | `--remote-demo=owner`: the pointer on Design reviews' ×, then a press: "Remove Design reviews from your list?" with the remote text, Cancel / Remove |
| `132-dialog-only-folder` | `--remote-demo=single` (Team the only folder in the list): its × → "Can't remove your only workspace", OK / New workspace… |
| `129-account-menu` | the account row (Ann Lee, the open folder's server's account) pressed: its menu opens upward with ann@example.com, Change name…, Switch account, Sign out |
| `110`, `113` | Change name, Sign out |
| `115-dialog-open-folder` | Open Folder… from the switcher, headless: the "Open folder" path dialog in place of the system picker |
| `116-dialog-open-remote`, `121-dialog-open-remote-error` | URL: the URL field; then a bad link and Return: "That isn't a folder or note link…" |
| `133-open-url-note`, `134-open-url-missing-note` | Open → URL with `…/app/team/ideas/Names.md`: Team opens at Names; with `…/app/team/nope/Missing.md`: Team opens (its first note) and the toast "No note at “nope/Missing.md”" |
| `114-dialog-open-github` | GitHub repo on the open folder's server (the mock server has no GitHub App: no Edit choice) |
| `109-dialog-open-new-remote` | New Workspace… → Remote folder: Server (`https://grimoire.example/`, the open folder's), Name, the hint |
| `119-dialog-open-new-folder` | New Workspace… → Folder: Location `~/Documents` with Choose…, Name |
| `124-dialog-new-remote-bad-url` | New → Remote folder with Server "not a server": "Enter a server address like https://grimnotes.app/" |
| `125-dialog-new-remote-connecting` | New → Remote folder on `https://other.example/` (not connected): "Waiting for the browser to connect to other.example…", Create busy |
| `126-dialog-new-remote-local` | New → Remote folder from a local folder with no server connected: Server `https://grimoire.exe.xyz/` |
| `127-share-remote` | `--remote-demo=owner`: the card's Share: "Share with an agent", This workspace (the agent link, Copy prompt) and All your workspaces (MCP) |
| `127-share-remote-snippets` | the same with "opencode config" open |
| `128-share-local` | the local sample folder: Share: only This folder's prompt |
| `122-dialog-open-folder-path` | Open Folder… with a path that isn't a folder: "No folder at /no/such/folder" |
| `157-file-menu-open` | File ▸ Open Workspace…: the Open dialog, URL and GitHub repo only |
| `118-dialog-open-folder-local` | Open Folder… from a local folder (the path dialog) |
| `120-dialog-open-guest` | no account anywhere: Open offers Folder and URL, no GitHub repo (a guest can't add one, as on the web) |
| `123-dialog-open-new-folder-taken` | New → Folder in `crates/app/tests/fixtures` named `notes`: "There's already a “notes” in …" |
| `99-remote-cursor` | `--remote-demo`: a remote workspace (globe, "Team / grimoire.example", its tree from the mock server), the note synced ("Saved"), Ada's edit ("today") and her pink caret with her name |

The scripts that open a file (`26`–`31`) now show the sidebar with `crates/app/scripts`' notes.

With clickable links (the `↗` chip became a pencil, and a revealed link shows its URL), the
snapshots showing a link changed: `01`–`05`, `13`–`15`, `17`, `20`–`25`, `32`, `33` (the sample's
"links"), `40`, `42`, `43`, `46`–`50`, `55` (`Loose ends.md`), `70`–`74`.

With links collapsed whatever the selection (only the pencil expands one), `03`, `20` and `37`
changed: a selection over the sample's "links" / the fixture's "web" link no longer shows its
source.

With code highlighting, the snapshots showing the sample's `rust` block changed (only those lines' colours): `01`, `02`, `04`, `05`, `13`–`15`, `17`, `19`–`22`, `25`, `32`, `33`, `70`, `72`.

With the switcher matching the web app's, `97`, `98` (a dialog instead of the field in the menu), `100`
and `102` changed (the menu's new rows: one line each, badges at the right, the account section); `103`–`118`
are new.

With the access badges (Owner / Editor / Viewer / via link / · domain) and "Refresh" taken out of the
switcher (2026-10-28, the web app likewise), only the switcher snapshots changed: `97-switcher`,
`100-switcher-remove`, `102-remote-noaccess-switcher`, `103-menu-local`, `104-menu-remote-owner`, `-editor`,
`-viewer`; every other snapshot is byte-identical.

With "Leave folder" replaced by the rows' × and the rows cut to name and × (hosts and paths gone, other
servers under "On <host>" headings), the same switcher snapshots changed again plus `111-dialog-leave` (the
new confirm wording, opened from Team's ×: `scripts/menu-leave.json` taps `sw-ws-0-remove`).

With "New Workspace…" above "Open Workspace…" (the New dialog: Folder, Remote folder with a Server field) and the Open dialog
without its "Create new" section (and no section headings), the menus (`97`, `98`, `100`, `102`–`104`) and
every Open/New dialog (`109`, `114`–`116`, `118`–`121`, `123`) changed; `124`–`126` are new.

With the "Share this workspace with an agent" card at the bottom of the sidebar (and "Share with agent…" gone from the menu,
`107-dialog-share-agent` with it), every snapshot showing a sidebar with a local folder or a remote one this
account can make agent links for changed (`26`–`31`, `34`–`46`, `49`–`56`, `60`–`65`, `67`–`69`, `81`, `82`,
`85`–`90`, `92`–`95`, `97`, `98`, `100`, `103`, `104-…-owner`, `-editor`, `105`, `106`, `108`–`126`); those
without it (no sidebar, the no-access page, the viewer) are byte-identical; `127` and `128` are new.

With every folder public (the server's `7e925d3`): Share folder…, Settings, the note header's Share, the
leave confirm and the "No access" page are gone. Gone snapshots: `101-remote-noaccess`,
`102-remote-noaccess-switcher`, `105-dialog-share-workspace`, `106-dialog-share-invited`, `108-dialog-settings`,
`111-dialog-leave`, `117-dialog-share-note`; new: `101-remote-missing` ("No such workspace"),
`102-remote-missing-switcher`. Changed: `97`, `100`, `103`, `104-…-owner`, `-editor`, `-viewer` (an × on every
remote row; the viewer demo is a read-only GitHub copy now), `101-remote-gone` (the wording), `109`, `110`,
`112`–`116`, `119`, `121`, `122`, `124`–`127` (no Share in the note header), `129-account-menu` (no Settings).

With "Remove workspace…" gone from the switcher (2026-10-30, as on the web): gone `112-dialog-remove` (and its
script `menu-remove.json`); changed `104-menu-remote-owner` (no separator and Remove workspace… at the bottom).

With the folder rows' × shown only while the pointer is over the row: `97`, `100`, `102-remote-missing-switcher`,
`103`, `104-…-owner`, `-editor`, `-viewer` changed (no × without a hovered row); `130-menu-row-hover` is new.

With the server headings reading just the host ("grimoire.exe.xyz", not "On grimoire.exe.xyz"; the web
likewise): the snapshots with server headings in the open switcher changed: `97`, `102-remote-missing-switcher`,
`103`, `104-…-owner`, `-editor`, `-viewer`, `130`.

With the × asking first ("Remove <name> from your list?", or "Can't remove your only workspace"): `100-switcher-remove`
now shows the local folder's confirm (the script hovers the row first: the × only takes presses once the row
is hovered and it shows; before this, the script's press fell on the row and opened the folder); `131` and
`132` are new.

With Open's "Remote folder" renamed "URL" (folder or note links): the Open dialogs `98`, `114`–`116`, `118`, `120`,
`121` changed (the list's label; the URL form); `133` and `134` are new.

With one fixed order (This Mac, then servers by host, folders by name; the open folder no longer first):
`97`, `102-remote-missing-switcher`, `103`, `104-…-owner`, `-editor`, `-viewer`, `130` changed.

With the filter field above "New note" (swapped; the tree doesn't move): every snapshot showing the sidebar
changed (82: `26`–`31`, `34`–`46`, `49`–`56`, `60`–`65`, `67`–`69`, `81`, `82`, `85`–`90`, `92`–`95`, `98`–`101`,
`109`, `110`, `112`–`116`, `118`–`135`); those without the sidebar, or with the switcher's menu over it, are
byte-identical.

With the tree's keyboard focus, the switcher's arrow keys and a quieter "+ New note" (regular, muted, a light
plus lined up with the chevrons): every snapshot showing the sidebar's tools changed (81); `45` and `46` also
show the clicked row in the tree's focus style; `136-tree-focus` (⌘⇧E and arrows: the current row in light
blue), `137-tree-focus-editor` (then Esc: the open note in grey) and `138-menu-keys` (the switcher's fifth
row highlighted by Down ×5, its × showing) are new. Measured on `40-sidebar` (2×): the plus's ink centre at
x = 44.0 px, the archive chevron's at 44.0 px (22.0 pt both); the label boxes start at 34 pt (the ink at 70 vs
69 px: "N" and "a" have different side bearings).

With the native row menu, the File menu, New Folder and the blue-only focus row: the local sidebar shots
reserve the rows' ⋯ (long names cut 20 pt sooner), so `40`, `41`, `43`, `45`, `46`, `49`, `50`, `55`, `97`, `98`,
`100`, `103`, `118`, `120`, `123`, `126`, `128`, `135` changed; `136`/`137` show the focus as background only
(`#d0dce5`, measured (208, 220, 229) on `136`). New (the NSMenu itself can't be captured, so the states
after a pick): `139-row-rename` (right-click `people`, Rename: the field), `140-row-delete-confirm` (right-click
`Ideas`, Delete: the confirm), `141-row-more-hover` (the ⋯ of a hovered row), `142-new-folder` (File ▸ New
Folder in `people`: the open Untitled and the folder's rename field). `--tree` checks: a secondary click shows
`popupMenu` with items `rename`/"Rename", `delete`/"Delete" and nothing else at the pointer; the ⋯ shows the
same menu anchored at `row:people`; `menu-cancel` leaves no dialog and no rename.

## Workspace socket (protocol v2)

- **One socket** (`v2.rs`, grim `docs/07-workspace-socket.md`): when `/api/server` says `ws: [1, 2]` (asked by
  `spawn_load` alongside the load) the selected remote workspace gets one WebSocket, `/ws?repo=<id>` (a guest's
  `anon`/`name`/`color`, or the Bearer token). Only the workspace selected in the window has one: `Mux` lives in
  `Remote` and closes its socket when dropped, so switching to another workspace (remote or local), losing it or
  closing the window closes it with all its channels; local workspaces have none; a second window would have its
  own. The note is a channel (`open` with the editor's state vector, `opened`, then the v1 frames prefixed by the
  channel), driven by the same room code as v1 (`room_frame`, `room_closed`). `welcome` (and `renew`) set the
  editors' awareness timing (`CollabEditor::set_awareness_timing`); `"ping"` every `welcome.pingMs`, no `"pong"` in
  10 s → reconnect. `error`/`end` carry v1's close codes: `end` 1013 reopens with the state vector, the rest as v1.
- **Warm and prefetched notes**: a note left for another stays open as a hidden channel (synced, no awareness: a
  null state on hide, published again when shown) while there's room (`maxChannels − 3` warm, least recently
  shown out first); the open note's tree neighbour (below first, else above) is prefetched hidden, at most 2
  syncing at once and within half the open rate (32 per 10 s; reopens within 60 s free). Going to a warm or
  prefetched note swaps its synced editor in: no open, no round trip (its authors from the blame it kept).
- **Workspace events** on channel 0 (the only event channel): the presence snapshot after `welcome` and its
  changes (the tree's dots), `tree` (the tree loads again), `saved` (History), `workspace` (import status, title;
  `removed` → "Not available", then the socket's 4404).
- **Reconnect**: a dropped socket is "Offline" (the note stays editable), reconnects after 500 ms doubling to
  10 s, and reopens every note in one flight, each with its state vector (edits made meanwhile go out in the step
  2); then the tree and the switcher's list load again. 4404 → "Not available", 4401 → signed out.
- **Production** (`v2::tests::against_production`, https://grimnotes.app on Cloudflare, from the laptop): the demo
  by its URL in two phases on one socket; first launch (no cache, no note known) live in 1.1–1.25 s (the REST
  load 0.4–0.65 s, each request 0.45–0.75 s at the server); relaunch with the cache: complete view 2 ms, live
  0.64–0.73 s; switches: warm 3 ms, cold 65–110 ms (p95); an edit is on the server (`GET /file`) in 0.4–1.1 s;
  offline relaunch: the cached view in 3 ms, "Offline: read-only", live again ~1.1–1.5 s after the network is
  back (the test's switch that fails every new connection, `net::OFFLINE`).
- **Note switch time** (`v2::tests::switch_time_against_bun`, grim main's Bun server on the laptop, 8 notes ×
  150 lines, click → live and editable, p50): RTT 0: cold 1.0 ms (v1 1.5), previous 2.8 (v1 9.2), next 3.2 (v1
  8.7); RTT 80 ms: cold 89 (1 RTT; v1 178), previous 3.0 (v1 176), next 3.2 (v1 174); 39 clicks = 1 socket (v1:
  40).

## Remote workspaces on disk (Mac only)

- **What** (`diskcache.rs`, behind `NoteCache`): each remote workspace's tree and the text of the notes opened or
  prefetched here (with the commit they were saved as when known), under `~/Library/Caches/Grimoire/notes`: a
  folder per server + workspace (hashed) with `meta.json` (server, id, tree) and `notes/<hash>.json`. No tokens or
  anything secret. At most 200 MB, the least recently used notes out first (reading one touches it), trimmed at
  launch and after writes.
- **Kept up to date**: on sync, on every update received or typed (written a second after the first change), on
  tree changes, renames (the text moves) and deletes (removed). Removing a workspace from the list removes its
  cache; signing out of a server (Forget, a revoked token) removes all of that server's (its notes may be
  private to the account).
- **Shown**: a note opens on its cached text at once (as the in-memory cache, the live editor taking over at the
  sync). At launch online, a workspace on disk shows its cached tree and note at once (read-only; the complete
  first view, ~2 ms) while it loads, then the note goes live in place; one the server spoke v2 for last time
  (`meta.json` `ws2`) starts its socket with the load, so the note is live one round trip after both.
- **Offline: read-only**: launched offline with the workspace on disk, its tree and notes show from the cache,
  read-only, with "Offline: read-only" in the header (quiet, no warning colour); a note not on disk shows "Can't
  reach <host>" / "“<note>” isn't saved on this Mac yet. It opens when <host> is back."; without a cache, the
  offline page as before. The load keeps retrying (1, 2, 4… s); when it gets through, the note shown goes live in
  place (its live editor behind the cached text until it syncs: no flash, caret and scroll kept) and is editable.
  A note whose connection drops mid-session keeps what was typed (it syncs when the connection is back) but takes
  no more typing until then ("Offline: read-only"); this replaces editing offline with a sync later.

## Launch and switching workspaces

- **Matches grim `docs/08-first-load.md`** (the web's boot spec), in the Mac's terms below.
- **Two phases, never the pieces** (`boot.rs`): with a remote workspace to open at launch the window shows the
  page's colour (`PAPER`), then after 150 ms a small quiet "GRIM" mark (11 pt, 600, tracked, muted at 70 %;
  snapshot 174); no spinner, no sidebar, no "Loading…". When everything for the first view is there (the
  workspace's details and tree, and the open note's text, live or its cached text; or a page saying why not) the
  complete view shows in one frame. Ready means (§3): who we are, the workspace and its tree, the open note's text
  (live, its HTTP read, or its cached text) or the page saying why it can't open, and its images with their sizes
  (decoded, failed, or a size remembered in `imagesizes`, so the box is reserved); fonts and the highlighter are
  in-process, there before the first frame. A finished image download or decode settles the gate too
  (`boot::image_arrived`). A local workspace is read before the window draws, so its first frame is
  complete. Switching to a remote workspace keeps the old view (its last frame, inert under a cover) until the new
  one is ready, then swaps; the window title and the scroll back to the top wait for the swap. After 3 s it shows
  what's ready with quiet placeholders: an empty tree (not "Loading…") and a 2 pt bar along the top of the note
  area (`pending_bar`, the web's `.note-pending`, from 300 ms; it pulses where the web's slides; snapshot 101);
  problem pages show at once. ("Loading from …" stays for the browser's connect flow.)
- **Everything at once** (§2, `remote::load_parallel`): the account, the workspace's details, its tree, the repo,
  `/api/server` and the note's text (`/api/workspace/:id/file`, when the note is known) are asked at once, and the
  switcher's list as the workspace opens; the read text shows read-only until the live editor syncs. Launch at
  80 ms RTT: 345 → 96 ms to the complete view; a switch 343 → 95 ms.
- **After the reveal** (§4): the preview → live swap keeps text, scroll, caret and layout (image boxes from
  `imagesizes`); no "Connecting…" while the note's text shows until 3 s (`CONNECTING_WITH_TEXT_MS`), 300 ms with
  nothing on screen; presence dots, header avatars and line authors fade in over 0.3 s without moving anything.
- **How**: `view` only reads `App::gate` (Open / Launch / Switch); it opens in `settle_gate`, run after every
  background update (`Handle::update`) and every handled event; the last complete frame is kept for a switch
  (`App::last_view`; +0.02 ms per frame on the snapshot runs).
- **Tested** (`v2::tests::launch_and_switch_show_two_phases_against_bun`, grim main's Bun server): sampling the
  phase after every update — launch: launch screen → complete (17 ms; 345 ms at 80 ms RTT), switch: old view →
  complete (13 ms; 343 ms), and back (1 ms, cached text; 187 ms) — the first complete frame already has the tree,
  the note's text and no placeholder; `v2::tests::local_launches_complete_and_problems_show_at_once`.

## Instant open

- A note seen before shows its last known text at once (`notecache`, the web's `NoteCache`: filled when a note is
  left, when it syncs and when a prefetch syncs; 100 notes / 8M characters, least recently used out), read-only
  in the normal renderer, with the live editor staged behind it (`App::staged`, as for a rename); at the sync it
  takes over in the same frame (`take_staged`), scroll kept and the caret kept when the text is the same; when
  the live text differs it wins (no merge). No spinner: "Connecting…" only after 300 ms
  (`CONNECTING_AFTER_MS`). Keys typed into the preview are not replayed (the web does).

## Workspace events

- On a v2 server the workspace socket's channel 0 carries the events (presence, tree, saved, workspace status:
  `v2.rs`). The server's old `GET /api/events` stream (and the app's `spawn_events` / `net::sse` for v1-only servers)
  is gone: on a v1-only server notes still sync, but the tree and presence don't update live. Presence shows on the
  tree's rows as the web's `.presence-dots` (up to four 7 pt squares with 2 pt corners in each person's colour, an
  agent's hollow, then "+N", their names as the tooltip; never us); `saved` for the open note refreshes a showing
  History list.

## Toasts

- **Toasts** (`toasts.rs`, the web's `toast()`): a stack at the bottom centre of the page, 24 pt up, 8 pt apart,
  newest last, at most four. Each is an ink pill (10 pt corners, 10/14 padding, paper 13 pt text, wrapping at
  480 pt); an error (`App::show_error`: every "Couldn't …" and failed request) starts with a 7 pt yellow dot
  (`#f5c542`) and stays 6 s; one with a button ("Create it", a translucent white button) 8 s; others 3.5 s; then
  they fade (0.3 s) and go. `158-toasts` (`--remote-demo=toasts`) shows the three kinds; its error is long enough to wrap.
- **Outside this notebook**: a link whose path climbs above the folder's root (`../../x.md` from a note one level
  down, `/../x.md`) shows the web's error toast "“<path>” is outside this notebook." and opens nothing
  (`links::Target::Outside`); local and remote notes alike.

## No note open

With no note open (a workspace with no notes, or none picked) the page shows the web's empty state: "Nothing open",
"No note open." ("Importing…" while a linked repo is being imported), "Pick a note from the sidebar, or start a new
one.", and a **New note** button when the workspace takes notes (`App::empty_page`). It said "No notes yet / Press
⌘N to start one." before.

## Dropping other files

Files that aren't images dropped on the page say why, as the web's error toasts: "Only images can be added to a
note (<names> isn't one)." alone, "Skipped <names>: only images can be added to a note." beside images (which go
in as usual), and "This note is read-only." on a read-only note (`drop::on_drop_rejected`, Rune's
`El::on_drop_rejected`). Before, they were ignored without a word.

## Folders remembered

Folders you open or close stay so across launches, as the web's `grimoire.tree.v2`: `workspaces.json`'s
`folders` keeps each folder whose state differs from its workspace's default (open; a linked repo's closed), by
its full path (a remote workspace's under its virtual root), the newest 500 (`Store::folder_open`/`set_folder`,
`App::remember_folders` after each handled event; folders new to the tree start as remembered, `App::set_files`).

## Pills

Inline code, `==highlight==` and tags draw a rounded background (a pill). With the caret in one, its markers show
inside the same pill (the backticks or `==` muted): the markers' spans carry the content's background and pad, and
Rune merges touching runs of one background on a line into one rect, so it's one pill with no gaps or inner corners;
wrapped, each line's part has its own rounded ends. Collapsed, the pill is the content's. Snapshots `170-pills` to
`173-pill-wrap` (a pixel check finds no gap in the revealed code pill).

## Wide content

The window never scrolls sideways. Tables and code blocks are boxes of their own (`layout::Wide`,
`render::wide_view`, Rune's `El::scroll_x`): one that fits stays in the text column (a narrow table at its natural
width, a short code block the column's width); a wider one breaks out into the margins on both sides, centred on the column, code up to
`CODE_MAX_W` (1000 pt) and tables `TABLE_MAX_W` (1400 pt), as the web's, and never wider than twice the distance from
the column's centre to the nearer pane edge less 24 pt each side (so it shrinks with the window); past that it scrolls sideways inside
itself (trackpad, Shift + wheel). Table columns take their natural width (a cell longer than the text column
wraps); code lines don't wrap. Clicks, drags and drops in a scrolled box add its scroll (`App::unscroll`), so the
caret, selection, the `|` reveal, links, remote carets and folds work as before; the author margin skips lines of a
block that covers it. Long URLs wrap at their slashes, and a word longer than the column (or a table cell's width)
breaks anywhere, as the web's `overflow-wrap: anywhere` (Rune's `RichLayoutOptions::wrap_anywhere`, in the one
layout used for drawing, carets, hits and selection); code lines never wrap. Code lines' backgrounds (diffs)
span the whole scrolled width. Other people's carets in a block are clipped by it (hidden once scrolled out of
view); their labels reach above it and follow its scroll. Measured as the web at 1440 px (a 1168 pt pane): the
30-column table 1095, long code 1000 (both exact); the web's medium fixture: its 9-column table 881 (the web 877: the
same Inter 16 and 18 pt gaps, Rune measuring each column's text about half a point wider), its 104-character code
line 873 (the web 870: Menlo against the browser's monospace), both centred, neither scrolling. Snapshots `164-wide`, `165-wide-scrolled`, `166-wide-narrow`, `167-wide-1440`, `168-long-word`, `169-wide-medium`.

## Pages under the header

The pages that say why there's no note sit under the header, as the web's: a note's notice (Note not found, No
access…) keeps its breadcrumb (no people, save status or ⋯, as the web's header without a session);
a workspace that can't load (No such workspace, Can't reach…, Signed out…) has an empty header. Both draw as the
web's `.empty-state`: a 24 pt heading, a 14.5 pt muted line, the web's `.btn` / `.btn-primary` buttons
(`render::web_btn`, also the empty state's New note).

**Kept as Mac conventions (owner):** the window title is the note's name alone (the web's tab says "<note> ·
Grim"); signing in goes through the browser's connect flow (the web has its own sign-in dialog).

## Search Files metrics

The dialog follows the web's latest `.fs-*` (f1043f6): min(600, 90% of the window) wide, 12% from the top; an
8 pt band around a 32 pt field with 14 pt text; a 4 pt list of 28 pt rows (5/10 padding, 14/18 text, 4 pt
corners) growing up to min(420, 60% of the window height, 88% − 120) and then scrolling; the highlight the web's
blue at 16 % over the paper (`#dae5eb`); its rules `--line-soft`; the footer 7/14 padding.

## Tree notes

In place of its rows the tree says, as the web's `renderWorkspaceTree` (`App::tree_note`): "Importing…" while a
linked repo is being imported and has no notes yet; the import's error ("The import failed." without one); "Loading…";
why the workspace can't load ("No such workspace", "Offline · retrying in 4 s"…); "No notes yet.". Errors are ink-2
after the web's 6 pt yellow dot. The server's `repos` event fetches the repo's status again, so "Importing…" turns
into the notes when the import is done.

## Carets in folded sections

Someone else's caret inside a folded section is drawn on the folded heading, 14 pt past its end (on the "…" pill),
as the web's `caretRect` (`Geo::caret`), with its label.

## Caret labels fade

Another person's name label on their caret shows for 2 s after their cursor last moved, and while the pointer is
within 5 pt of the caret, then fades out, as the web's `cursors.ts` (`LABEL_MS`, `HOVER_PX`; `cursors.rs`, the
label's opacity a `Live` smoothed by a spring). Headless runs keep labels shown.

## Switcher mark

The switcher button starts with the web's `.ws-mark`: the workspace's first letter on a 24 pt ink square
(`switcher::mark`), in place of the folder / globe glyph. The line under the name still says where it is (the
folder's path, or the server's host).

## Rename

Rename (the row menu's, a new folder's name) edits the row's name only, as the web's inline rename: the field
holds the note's name without `.md` (a folder's name), all selected; Return or a click elsewhere (the web's blur)
renames it in the same folder, keeping its extension; Escape keeps it. A name with `/` or `\\` (or `.`, `..`)
says "A name can't contain / or \\."; a taken one "“<name>” already exists.". Notes no longer move between
folders by rename.

## Missing workspace

A workspace the server says doesn't exist shows "No such workspace" / "“<id>” doesn't exist on <host>." with the
web's **Go to my workspaces** (the next workspace in the list that can open; it stays in the list) and the Mac's
**Remove** (forget it).

## Link tooltips

Holding the pointer on a link's text shows its destination ("plan.md#next-steps", "https://…") as a tooltip, as
the web's `title` (`links::dest`, the web's `linkDest`: no angle brackets or backslash escapes). `163-link-tooltip`.

## From GitHub

A read-only GitHub copy's header shows the web's "Read-only · from GitHub ↗" after the breadcrumb (12 pt, muted
on paper-2); it opens the note on GitHub (`header::github_file_url`: `github.com/<owner>/<name>/blob/<branch>/<path>`,
HEAD when the server sends no branch). Hidden in windows under 900 pt, as the web's. `162-github-source`.

## Tooltips in the tree

As the web's `title`s: a tree row's tooltip is its path in the workspace ("projects/Roadmap.md"), the ⋯ button's
"More" (Rune's `El::help`). `161-row-tooltip`.

## Sidebar button

While the sidebar is hidden (a narrow window, or ⌘\\) the header starts with the web's sidebar button, a 32 pt
burger (`header::burger`); pressing it shows the sidebar. Clicking the workspace's name in the breadcrumb still
does too.

## Folds remembered

Each note's folded headings stay folded across launches, as the web's `grimoire.folds:<repo>\0<path>`:
`workspaces.json`'s `folds` keeps them (`Editor::fold_keys`) by the note's full path, the newest 500
(`Store::folds_of`/`set_folds`, saved after each handled event by `App::save_folds`; renames carry them). A remote
note's come back once its text has synced.

## Linked repos start closed

A remote workspace whose `kind` isn't "notes" (a linked GitHub repo, often big) shows its folders closed when it
loads, and folders that appear later start closed too; the open note's folders open (`Remote.folders_closed`), as
the web's `openByDefault`. Notebooks open with every folder open, as before. (A server that sends no `kind`:
open.)

## Avatars

Everywhere a person shows as a coloured initials square (the header's avatars, the account row) uses the web's
`initials` (split on spaces, `.`, `_`, `-`: first and last part's first letters; one word: its first two, "Me" →
"ME") and, without a colour of their own, its `colorFor` (12 colours, `hash * 31`; `workspaces::guest_color`), so a
person looks the same in both apps.

## Demo banner

A note of a server's demo (a demo room, or an older server's shared `demo`) shows the web's banner centred under
the header, in its own band (16 pt above, 20 pt below: the note's title starts under it, never under the banner):
"Demo workspace — anyone can edit; your copy resets every 15 minutes." (the interval from `POST /api/demo/room`'s
`resetMinutes`, 15 until known; `App::shows_demo_banner`; pale yellow `#faeecb`, the web's `--warn-soft` over the
paper, 13 pt, 6 pt corners). `160-demo-banner` (`--remote-demo=demo`).

## Demo rooms

On servers with demo rooms (grim `src/server/demo-rooms.ts`: at most 10 people per independent copy of the demo),
`demo` is an alias: opening it (a link, the recents, the launch) first asks `POST /api/demo/room` (as the app's
guest: the server keeps the same guest in the same room while it's there) and opens the workspace it names,
`demo.<room>` (`App::open_remote` → `open_remote_now`; a server without rooms answers 404 and its shared `demo`
opens as before). The recents, last notes and Copy Link still say `demo` (`workspaces::canon`, `remote::canon_id`),
so whoever opens a link gets a room with space. If the room goes (404, socket 4404) or is full for us after being
away (409 "demo room", socket 4409), the app asks for a room again, once in a row (`App::reopen_demo`).

## Space in the tree

With the tree holding the keys, **Space** does what Enter does (a folder opens or closes, a note opens and the
editor takes the keys), unless it comes within a second of type-ahead letters, when it's part of the name being
typed ("meeting n…"), as the web's tree.

## Guests: creating needs an account

As the web (grim `docs/05-v1-architecture.md`, 2026-10-29): a guest connection (no app token) reads and edits
notes as before, but outside workspaces open to guests (`GET /api/workspace/:id` `guestCreate`, the demo) New note
(⌘N, the row menu, "+ New note"), New folder (⇧⌘N, the row menu), Rename, Delete (row menu, Delete keys, ⌘⌫) and
image drop/paste stay visible and open the quiet sign-in prompt instead (`App::guest_blocks`, `GuestAction`):
title "Sign in", the web's line ("Sign in to create notes and folders. It's free." / "… rename …" / "… delete …"
/ "Sign in to add images. It's free."), **Sign in** (the browser connect flow: /connect offers Continue with
Google) and **Close**. After connecting, the workspace loads signed in and the action runs (the note or folder is
made where it was asked, the rename field or the delete confirm opens; an image is dropped again). The server's
401s on those calls (POST files, DELETE files incl. `?folder=`, POST rename, POST images) show the same prompt.
An untitled note isn't renamed after its heading for guests there. Connected users and local workspaces are never
limited. After any connect, this Mac's saved workspaces for that server join the account (`POST
/api/workspaces/join-many {ids}`, ≤ 200), then the switcher shows `GET /api/workspaces`, the same list on every
device. `176-guest-sign-in`; `v2::tests::guests_are_asked_to_sign_in_and_their_action_runs_after`,
`remote::tests::saved_workspaces_join_the_account_after_connecting`, `v2::tests::guest_limits_on_production`.

## Fonts: the system font

- **San Francisco from the system** (`sysfont.rs`, `app_fonts`): CoreText gives the system font's files
  (`CTFontCreateUIFontForLanguage(kCTFontUIFontSystem)` → `kCTFontURLAttribute`, and its italic; on macOS 15:
  `/System/Library/Fonts/SFNS.ttf`, `SFNSItalic.ttf`), read at launch and registered with Rune as the sans family
  "System Font" (never bundled). Code and inline code: SF Mono (`ui-monospace` in the mono slot: Rune loads the
  system's monospaced font), then Menlo. The bundled Inter only if the system font can't be read.
- **Like CoreText**: one variable font for every style. Rune sets `opsz` to each run's point size (body 16 pt in SF
  Text shapes, headings ≥ 20 pt in Display shapes) and applies the font's `trak` table at that size; weights go on
  `wght` with AppKit's values for the named weights (`theme::wt`: 500 → Medium 510, 600 → Semibold 590, 700 →
  Bold 700, linear between), so headings are Semibold/Bold as `NSFont.systemFont(ofSize:weight:)` makes them.
  Headings drop the extra letter-spacing they had for Inter (the font tracks itself). UI chrome (sidebar, header,
  dialogs, toasts) is the same system font at its sizes.
- **Optical size as CoreText maps it**: CoreText's `opsz` is the point size clamped to the font's axis (SF on macOS
  15: 17–96, default 28): 9–17 pt → 17, 18 → 18, 20 → 20, 23.5 → 23.5, 32 → 32, 120 → 96 (`CTFontCopyVariation` of
  `NSFont.systemFont`). Rune asks for the point size and a coordinate below the axis is clamped, so the app already
  gets those instances: at 12.8, 14 and 16 pt Rune's default lays out and rasterises exactly as `opsz` 17
  (`sysfont::tests::rune_opsz_below_the_axis_clamps_like_core_text`: advances and glyph boxes at 4×, weights 400 /
  590 / 700; `opsz` 20 differs, so the check sees optical size). No mapping is needed in the app.
- **Checked against CoreText** (`sysfont::tests::the_system_font_matches_core_text`, `scripts/sf-dump.swift`:
  NSFont.systemFont, CTLine glyphs and positions): the same glyphs at every size (the same optical-size
  instance), and positions: regular 16 pt body max |Δx| 0.0001 pt over 150 glyphs, 12.8 pt 0.0002 pt; Semibold
  H2/H3 0.024 pt over 43 glyphs; Bold H1 32 pt 0.14 pt over 43, bold body 0.16 pt over 150. The heavier
  instances drift by 1/256 pt on some glyphs: Rune's shaping rounds an interpolated (`HVAR`) advance to a whole font
  unit where CoreText keeps the fraction (a Rune-side limit; the default instance has none).

## Delete in the tree

With the tree holding the keys, **Delete** (Backspace), **forward Delete** or **⌘⌫** (Finder's) on the focused row
is the row menu's Delete (`App::ask_delete`): the same confirm (remote: "Delete “…”? It stays in the Git history.";
local: "Move “…” to the Trash?"; a folder says what's in it), Return deletes, Escape cancels with the row still
focused. After the delete the focus goes to the next row (the previous one after the last), and a deleted open
note gives way to the next note in the tree's order, else the previous (`App::plan_after_delete`, also for the row
menu's Delete). Nothing in a read-only workspace or while renaming. `175-tree-delete-key`;
`sidebar::tests::delete_keys_delete_the_focused_row_after_the_confirm`,
`v2::tests::the_delete_key_deletes_remote_notes_and_does_nothing_read_only`.

## New note in a read-only workspace

"+ New note" isn't shown while a remote workspace is loading or when it's read-only (a GitHub copy you can't
write, a viewer's workspace), as the web hides it (`App::shows_new_note`); it used to show greyed out.

## When a note's room closes

As the web's `Session.onClosed` / `notice`: the page shows a message in place of the note (`Remote.notice`,
drawn by the problem page) with the web's wording, or the note is left with a toast (`App::leave_note`, the
web's Go home: the workspace's first other note opens):

- **notfound**: "Note not found" / "“<path>” doesn't exist in <workspace>." with **Create it** (when the
  workspace can be written; it makes the note as a link's Create it does, `create_linked`) and **Go home**.
  `159-note-not-found` (`--remote-demo=notfound`).
- **forbidden**: "No access" / "You don't have access to this note."; **toolarge**: "File too large to open" /
  "“<path>” is larger than 5 MB, too large to open as a note."; anything else: "Closed" / "The note was closed
  (<reason>)." — each with Go home.
- **deleted**: toast "“<name>” was deleted."; **removed**: "This repo was removed."; **renamed** with no new
  name: "“<name>” was renamed." — then the first other note. Renamed with a new name joins it in place, as before;
  when someone else renamed it, a toast says "“<a>” was renamed to “<b>”." (our own renames, `Remote.renaming_to`,
  carry on quietly).

The header's save status shows nothing on a notice page.

## Header and line authors

- **Header** (`header.rs`, as the web's `.doc-header`), above the page whenever a note is open (local or
  remote; not on the problem, loading or empty pages): 52 pt, padding 0 12 0 24, gap 12. Left, the breadcrumb:
  the folder's name (muted, 500 14 pt, ink under the pointer; a press shows a hidden sidebar), `/` separators
  (`#a1a1aa`), the note's folders (muted) and the note (ink, its path as the tooltip). Right: the save status
  (`App::save_status`, the web's wording: nothing while connected — notes save themselves — "Read-only" for a
  read-only note, "Connecting…" before the first connection (only 300 ms after a click), and once it's lost "Offline: read-only"
  (quiet; no typing until it's back, `diskcache` above); the old
  "Saved / Saving… / Edited" pill is gone, local notes show nothing); for a remote note with someone else in it,
  the people (us first, then each participant once, from the room's presence; none while we're alone; 26 pt
  avatars 6 pt apart with 4 pt corners and the web's initials — two letters of a one-word name, else first and
  last words' — white on the person's colour; another guest's with a paper-then-colour ring at 85 %, ours never
  ringed; an agent's with an "AI" badge; tooltips "<name> (you)", "(you, not signed in)", "(guest, not signed
  in)", "(agent)"; six, then "+N"); and at the right edge the **⋯** (the web's `.doc-more`: a 30 pt square,
  three ink dots, grey under the pointer, `#e4e4e7` while its menu is open; tooltip "More", label "More
  actions"). Its native menu (`header::header_popup`, under the button): **Show History** / **Hide History**
  (the drawer; disabled for a local folder that isn't a Git repository), **Show Authors** / **Hide Authors**
  (remote notes), a separator, **Rename…** and **Delete…** (the row menu's: the row's rename field, its folders
  opened and the sidebar shown; the delete confirm; disabled for a read-only note), and for a remote note a
  separator, **Copy Link** and **Open in Browser** (as its row's; never for local folders). The page's scroll
  area starts below the header.
- **History drawer** (`history.rs`, a port of the web's `history.ts`, styled as `.history`): 380 pt on the right
  (`#f4f4f5`), pushing the page from 900 pt windows up, covering it (with a shadow) below; its head "History"
  (600 14 pt) and a × (Close history). The list: the note's newest 100 versions (`GET /api/workspace/:id/history`,
  or `git log -n 100 -- <note>` for a local note in a Git repository), each its message's first line (550),
  "author · when" (the web's `relativeTime`: just now, 42s ago, 5 min ago, 3 h ago, 2 d ago, else M/D/YYYY)
  and the short sha (mono, right); a hover tint; "Loading…", the error, or "No saved versions yet. Changes are
  committed after a short pause, or press ⌘S.". A press: "← All versions", the title (650 15), "author · when
  · sha", **View** (the whole text at that version, `GET …/file?ref=` or `git show sha:./note`; then **Diff**)
  and **Restore this version** (disabled for the newest version — "This is the latest version" — or a
  read-only note), then the version's diff (`GET …/diff`, or `git show`): mono 12 pt lines, added ones on a
  9 % blue with a 2 pt blue edge, removed ones grey and muted with a grey edge, hunks and headers muted; "No
  changes to this file in this commit." Restore asks first ("Restore version", "Replace the current text with
  the version from <sha>? Everyone editing will see the change, and it can be undone from history.",
  Restore / Cancel), then `POST …/restore` (a local note: that text replaces the editor's, one undo step, saved
  as any edit), the toast "Restored version <sha>" and the list again. Live: when the room's save state names a
  new commit for the note, a showing list loads again; another note retargets the drawer. Loads run on
  threads (in place headless and in tests); stale answers are dropped.
- **Line authors** (`authors.rs`, the web's `editor-rs/authors.ts`): collab parses the room's `{t:"blame",
  authors, lines}` (`collab::Blame`, `Notice::Blame`; unknown fields ignored, malformed messages dropped).
  Between messages the values follow the text (`collab::blame::attribute`, the web's `attribute` with its
  `linePairs` Myers diff): our edits (`handled`) make the lines ours at once (we're added as an author), the
  room's changes keep each line's author. Names are drawn in muted grey (`#9a9aa1`, 500 11 pt, no colour, no
  dot), left-aligned 16 pt from the editor pane's left edge (the sidebar's right edge, or the window's), each on
  its line's first baseline; always the whole name — one that doesn't fit before 12 pt short of the text column
  isn't shown, none when that room is under 24 pt. The web's rules (`authors::marks`): a name only where the
  author differs from the last one shown; headings, empty lines, fences, table delimiter rows, rules and folded
  lines show nothing and don't count; unknown lines show nothing and end a run; fewer than two distinct authors
  in the whole note (live, our guess included): no names. The header's ⋯ ▸ **Show/Hide Authors** and View ▸ **Show Authors** (checked
  while on) toggle it, remembered (`workspaces.json` `showAuthors`, on by default). Local notes have none.

Snapshots: the header moved every note page down 52 pt (97 changed); `99-remote-cursor` and `146-remote-guest`
show the header and the names (Me / Ada / Me); `148-authors-off` (⋯ ▸ Hide Authors: no names) and
`99-remote-cursor` now shows presence dots (Ada in Team notes; six people in the roadmap: four dots, an agent's
hollow, "+2").
`148-authors-off` and the history snapshots open the ⋯ menu and pick its item (`menu-pick`); `177-header-menu`
shows the ⋯ pressed while its menu is open (the native menu itself isn't drawn).
`152-history-list`, `153-history-diff`, `154-history-view`, `155-history-restore` (1400 wide: the drawer pushes the
page) and `156-history-narrow` (800 wide: it covers it) show the drawer on the mock server's three versions;
`149-authors-menu` (View ▸ Show Authors twice: on again) and `151-remote-offline` (the connection dropped: the
header's "Offline — changes will sync when reconnected") are new. The status pill at the page's top right is
gone, also from the problem and loading pages (the page says it).

With the "Search files" dialog in place of the filter field: every snapshot showing the sidebar changed (the
search button); `42-filter`, `43-filter-esc` and `44-cmd-p-enter` are replaced by `42-search-empty`,
`43-search-filtered`, `44-search-none` and the new `143-search-open`.

Guests: `146-remote-guest` (`--remote-demo=guest`: the Team folder without an account, Ada typing, the account
row "Sign in", no agent card) and `120-dialog-open-guest` (Open without an account: Folder and URL, no GitHub
repo; it replaces `120-dialog-open-github-no-server`) are new; `97-switcher` and `103-menu-local` list the
remote folder the support fixture opened on a server without a token (100.73.96.98:3000 · Team), and
`118-dialog-open-folder-local` has no GitHub repo choice (no account).

The tree's viewport had a 6 pt soft clip (`clip_soft(6.0)`) on every edge, at rest too: the first row's top 6 pt
faded into the sidebar (the focused row looked shaded at its top). It's a hard clip now with Rune's
`scroll_edge_fade(12.0)` (top and bottom fade only while rows are hidden under them) and `scroll_margin(12.0)`.
`147-tree-focus-top` (⌘⇧E, Home: `archive` focused) is new and `run.sh` checks its row is one colour at its
top, middle and bottom (`scripts/pixel.py same`: (208, 220, 229) at y = 344, 372, 398 px); every snapshot with
the first row hovered, open or focused changed at its top edge.

The row menu with the web's items: `144-row-new-note` (right-click `people`, New note: `people/Untitled` open) and
`145-row-new-folder` (right-click `people/hiring`, New folder: `people/New folder` with its Untitled, the folder in
rename) are new; `--tree` shows `popupMenu` items new-note "New note", new-folder "New folder", rename
"Rename", delete "Delete", in that order.

With the workspace switcher (at the top of the sidebar in place of the folder's name label: New note and
the filter move down 40 pt, the tree 8 pt), every snapshot showing the sidebar changed: `26`–`31`, `34`–`46`, `49`–`56`, `60`–`65`,
`67`–`69`, `81`, `82`, `85`–`90`, `92`–`95`. Those without it (`01`–`25`, `32`, `33`, `47`, `48`, `66`,
`70`–`80`, `83`, `84`, `91`, `96`) are byte-identical.

On Rune `dev` (2026-10-28) every snapshot changed byte-wise, but 97 of the 118 only in how glyphs are
rasterized (dev draws text heavier; no ink moved by more than 0.5 pt, nothing else changed:
`/tmp/opencode/rune-port/snapshots.md`). `03` and `20` also draw the `==highlight==` markers' backgrounds as one
pill; `17` keeps the selection where the drag left it (dev sends no extra Move on release, which used to pull
the head back after markers revealed). The folder rename and the Open dialog changed `97`, `98`, `100`–`104`,
`107`, `108`, `111`, `112`, `115`, `118`; `109`, `114`, `116` and `119`–`123` show the Open dialog's forms.

## Git in local folders

`gitsync.rs`. Local folders are plain files unless the user asks for Git:

- **First opening.** The first time the app opens a local folder it has never seen (at launch, Open Folder…, the
  switcher, a new folder made on this Mac), it checks whether the folder is in a Git work tree (`git rev-parse
  --show-toplevel`, so a subfolder of a repository counts; git isn't run at all when there's no `.git` here or
  above) and asks once:
  - *Not a repository:* **Track changes in this folder?** "Grim can create a Git repository here to keep a
    history of every change, so you can see and restore earlier versions." **Track Changes** (primary, Return)
    runs `git init`, turns automatic commits on and commits the folder's notes (the Markdown files the tree lists,
    nothing else) as "Track changes"; **Not Now** (Escape, ×, a click outside) leaves the folder untouched.
  - *A repository:* **This folder is a Git repository** "Grim can commit your changes automatically as you
    write, or leave the repository entirely to you." **Turn On Automatic Commits** and **Leave It to Me** — the
    default (the primary button, at the right): Return and Escape both choose it. Off, the app never writes to the
    repository; History reads it as before.
  The answer is kept per folder (`Store::git` in `workspaces.json`: `[path, on]`) and the folder is never asked
  again (also after it leaves the list). Folders already in the recent list when this arrived count as seen (off).
  Headless runs never ask, except with `--ask-git` (snapshots of the two dialogs).
- **Asked once.** There's no control to change the choice later (no workspace-management UI yet): neither the
  switcher nor the File menu has Git items. Only editing `workspaces.json` (its `git` entry) changes it.
- **Automatic commits** (`Committer`, one thread for the open folder while they're on): the app tells it what it
  changed — the note edited (`App::handled`), notes created (New Note, New Folder's note, images copied beside a
  note), renamed or moved (notes and folders, also an untitled note named after its heading) and deleted (into the
  Trash) — and it commits 3 s after the last change (`gitsync::QUIET`, the saver has written by then) and right
  away on ⌘S (after the save), and what's left when the folder closes or the window does (≤ 5 s).
  - Only those paths: tracked files under them (a deleted one too) and new ones that aren't ignored (`git ls-files`;
    the new ones `git add`ed), then `git commit --only -- <files>`. Never `add -A`; other files and whatever is
    staged for them stay as they were. Nothing different from the last commit: no commit.
  - Messages as the server's: "Update a.md", "Create a.md", "Rename a.md to b.md", "Delete a.md" (paths relative
    to the folder); several changes in one commit: "Update a.md and 2 more changes" with each on its own line below.
  - Author: git's own `user.name` / `user.email`; when unset, the signed-in account's name and email, else
    "Grim" <grimoire@localhost>, given per command (`-c`), never written to any config.
  - Skipped quietly (kept for the next change) during a merge, rebase, cherry-pick or revert, or with conflicts.
    Hooks run; one that fails (or any other git error) shows **Not committed** in the header's save-status place
    (the warning pill, the error as its tooltip), logged once; the changes stay queued and are tried again with the
    next change, and the pill goes when a commit works.
  - git runs on that thread (`/usr/bin/git`); typing never waits for it. History shows the commits (`git log`).
- `--git-selftest` (`Grim.app/Contents/MacOS/Grim --git-selftest`): the two dialogs, Track Changes, Return
  in the repository dialog, automatic commits turned on (the stored choice), edits, a new note, a rename, a failing hook and a merge in progress against
  temporary folders; prints what it saw and exits 0 when all is as expected (a one-off check, not a test suite).

## Known gaps

- Workspaces: the Keychain path is only exercised in a GUI session (over SSH `security` can't write
  the login keychain and the file fallback is used; its test is `#[ignore]`). Servers can't be disconnected
  (token removed) from the menu. Remote notes show no images
  (`/raw` isn't fetched) and links between remote notes don't open; no participants list, no history.
  Images can't be dropped onto a remote note (a toast says so). The tree is polled
  every 3 s (no event stream). Window focus isn't reported by Rune, so our caret stays published while the
  window is in the background. The remote name pill can cover the line above.

- Code highlighting runs synchronously in `build` (no render range or background slices as in
  the JS `LiveTokenizer`): pasting a block of several thousand lines tokenizes it all before the
  next frame (~15 ms per 1000 lines). There's no dark theme, and the fence's language word isn't
  completed or validated.
- The sidebar has no drag-and-drop move, and no full-text search (the web app's "In text" hits). The folder is rescanned on a 2 s timer,
  not when the window gains focus (Rune doesn't report focus changes).
- A note changed outside while it has unsaved edits isn't merged: the editor's text wins at the
  next autosave. A save that keeps failing is only reported on stderr, not in the window.
- The tree's row elements are still built on every view (the rows themselves are cached); very
  large folders would want `El::virtualize`.

- Dropping images hasn't been tried with a real Finder drag (only `file_hover`/`file_drop`
  scripts). Images dragged from a browser as data (no file URL) don't arrive. Undo after a drop
  leaves the caret at the drop point, not the earlier selection.
- Images: http(s) sources aren't downloaded (placeholder), and HEIC/SVG don't decode
  (placeholder). Background loading and the line growing when a load finishes are covered by
  Rune's tests but haven't been watched in a real window (headless decodes synchronously).
  Images aren't draggable or resizable, have no context menu, and the title isn't shown.
- Links: no hover preview of the URL, and no "create it?" for a missing note (just the toast).
  The pointing hand over link text comes from elements laid over it, so while a gesture that
  started there is held the cursor is the I-beam. Only `http`/`https`/`mailto` open outside the
  app; `file:` and other schemes are ignored.
- Every event rebuilds the geometry for all lines. Shaped layouts are cached, but very long
  notes will want virtualization.
- No autoscroll while drag-selecting past the top or bottom edge.
- Dragging after a double/triple click doesn't extend by words/lines (needs editor-core).
- IME, the press-and-hold setting and the candidate window position haven't been tried in a
  real window, only headless (`ime` script events, `ime_area` in `--tree`).
- Marked text that wraps onto a new visual line overlaps the line below until it commits.

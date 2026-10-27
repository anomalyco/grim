# The app crate (`crates/app`, package `grimoire`)

Phase 1 of the native port: `editor-core` drawn with Rune. Built against the `grimoire-patches`
branch of Rune, checked out as the worktree `~/projects/worktrees/rune-grimoire`
(`rune = { path = "../../../worktrees/rune-grimoire/crates/rune" }`). Its APIs are described in
`docs/rune-capabilities.md`, "Patched Rune", plus `Tx::scroll_to` / `Tx::scroll_into_view` and
`Tx::set_title` and images (below).

```sh
cargo build --release -p grimoire
target/release/grimoire path/to/folder       # the folder's notes in the sidebar, its newest note open
target/release/grimoire path/to/note.md      # its folder, with the note open (created if missing)
target/release/grimoire                      # the workspace open last (recent list), else ~/Documents/Grimoire (created, and seeded with Welcome.md, when it has no notes)
target/release/grimoire --remote-demo --snap x.png   # headless: a remote workspace on the in-process mock server
sh crates/app/scripts/run.sh                 # headless snapshots → crates/app/out/*.png
cargo test --release -p grimoire             # autosave, folder scan, filter, note switching, reload
scripts/bundle.sh                            # dist/Grimoire.app (gitignored)
```

Headless runs (`--snap`, `--script`, `--tree`) never write to disk: they read the folder, and a
new note only exists in memory. `--sample` (or no argument) loads the built-in sample note
(`crates/app/sample.md`) with no folder and so no sidebar, and scenes (`--scene empty|caret-in-bold|selection|in-table|in-code`)
set up states. `crates/app/scripts/long.md` and `italic.md` are fixtures for the scroll and
italic snapshots; `crates/app/tests/fixtures/code` (highlighted code blocks) and `crates/app/tests/fixtures/notes` (nested folders, plus a hidden folder,
`node_modules` and non-Markdown files that must not show) and `fixtures/empty` are the sidebar's; `fixtures/photos` (a note with PNGs beside it and in `images/`, one missing) is the images'.

## Modules

| file | what it does |
|---|---|
| `main.rs` | `App` state (the `Editor`, path, caret blink `Live`, saver, IME marked text; the notes folder, its tree, collapsed folders, the filter `TextEdit`, the sidebar choice), `open_note` / `new_note` / `refreshed`, the 2 s refresh thread, fonts (the Inter 4.1 faces in `assets/fonts`, italics included, plus Menlo read from `/System/Library/Fonts`), `AppSpec` with the note's name in the window title, scenes, autosave on close, and `ApplePressAndHoldEnabled = NO` registered at startup |
| `layout.rs` | Parley layout mirroring Rune's `TextSystem::layout_rich` (same fonts and parameters, italic included, device scale, a cache keyed like Rune's). Turns each `LineView` into a `LineGeo` of `Piece`s (one per line, one per cell in tables), whose display text leaves hidden segments out, with display ↔ raw byte maps (`DisplayMap` from editor-core for hits, resolving the click's affinity next to hidden markers; `r2d` for carets). Block tokens become gutter slots (`Tok`). Implements editor-core's `Layout` (`caret_rect`, `hit_test`, `bounds`, `table_cell_at`, `line_mid_y`, `image_at`, `adjacent_line_y` from each line's visual rows: Parley line metrics merged across table cells, image bands, rule/collapsed lines as one row), plus selection rects and `splice_marked` (IME text drawn into the caret's piece). Holds the column width and viewport height of the last view (`set_viewport`, `col_w`, `view_h`) |
| `files.rs` | Scanning the folder (`.md`/`.markdown`, skipping hidden folders and `node_modules`, folders without notes left out; symlinked notes followed, symlinked folders not; folders first, then by name) with a fingerprint of paths, sizes and mtimes taken in tree order; the tree's rows (collapsed folders, filter); the filter match (the web app's: each term in the path, or loosely in order in the name); `Untitled N.md` names |
| `sidebar.rs` | The sidebar view (below) and its handlers: row presses, Cmd-\ toggle, filter focus and Esc, Enter opens the first match |
| `render.rs` | The view: the sidebar (when shown) over the left 240 pt, the page in the rest. Code block backgrounds, quote bars, table rules, hr, bullets, numbers, checkboxes (clickable → `toggle_todo`), `H1`…`H6` labels on the active heading, one `rich()` per piece, strikethrough rules, images below their lines (`rune::image`, or the placeholder), the translucent selection, and the blinking caret (`ime_cursor()`, kept transparent under a selection), inside a centred column in a Rune scroll viewport (`scroll`). The surface element takes the mouse |
| `keys.rs` | The macOS key table every editor gets (`keys::editor`): editor-core's `KeyTable::standard()` (AppKit's `StandardKeyBinding.dict`) with the user's `~/Library/KeyBindings/DefaultKeyBinding.dict` on top, read once at startup (old-style text directly; XML or binary through `plutil -convert json`). Headless runs skip the user's dict; `--key-bindings=FILE` loads one |
| `input.rs` | `on_key` → `insert_text` / `Editor::key` through the key table, plus Cmd-C/X/V (arboard), Cmd-S, Cmd-Enter on a link, paging (`Command::Page`), Ctrl-L (`CenterSelection`), Home/End scrolling and keeping the caret in view. `on_ime` → marked text / `end_composition`. `surface_drag` → `mouse_down` (click count, Shift) / `mouse_drag`, or a press on a collapsed link (`LinkPress`: follows it on release); `pencil_drag`, `link_text_drag` |
| `images.rs` | Where an image's source points (`resolve`): relative to the note's folder, percent-decoded, absolute paths, `~/`, `file://`; http(s) and other schemes aren't loaded |
| `drop.rs` | Image files dragged in from Finder (below): the surface's `on_file_drop`, the drop caret position, the link for each image (relative path, copy into `images/`, de-dupe, URL encoding) |
| `doc.rs` | Picking the folder and note from the argument (`locate`), opening the file, atomic writes, a debounced (1 s) background saver, and a flush on Cmd-S or when the window closes |
| `theme.rs` | Colours and metrics from the web editor's `editor.css` (paper `#fcfcfb`, ink `#1d1e22`, markers `#62626a`, links `#296d9a`, code `#f1f1f2`, 33 pt gutter, heading sizes) and the sidebar's from `app.css` (`#f4f4f5`, hover `#ececee`, active `#e4e4e7`, `#3f3f46` folders, 240 pt wide, hidden below 700 pt) |
| `links.rs` | Following a link (below): `resolve` (unescaping, `<…>`, schemes, `#heading`, paths against the note's folder or the notes folder, `.md` tried, the folder's bounds), GitHub heading slugs, `App::follow_link` (open, note, heading, toast) and `launch` (`/usr/bin/open`, recorded instead in headless runs) |
| `note.rs` | `NoteStore` (an `editor-core` `TextStore` over a plain string or collab's `CollabStore`) and `Ed` (a local `Editor<NoteStore>` or a boxed `CollabEditor<NoteStore>`), which derefs to the editor: the rest of the app calls `app.ed.…` for both kinds of note |
| `workspaces.rs` | `WsRef` (local folder / remote `server + id + title`), remote workspace URL parsing, the persisted `Store` (recent workspaces with their last note, connected servers with their joined workspaces) and `Tokens` (Keychain via `security`, 0600 file fallback) |
| `net.rs` | A small blocking HTTP/1.1 client (http, https through native-tls = Security.framework; JSON, chunked bodies), URL parsing and escaping, the loopback listener of the connect flow, random hex from `/dev/urandom` |
| `remote.rs` | Remote workspaces: the REST client (`Api`), the connect flow, the room's WebSocket thread (tungstenite), `Remote` (the open workspace and note), `App::open_remote` / `open_remote_note` / `room_frame` / `room_closed` / `pump_collab`, status, remote carets, notes created / renamed / deleted on the server, the in-process `Mock` server (headless demo, tests) and the integration test |
| `switcher.rs` | The workspace switcher (top left of the sidebar) and its menu: recents, joined workspaces per server, Open folder…, Add remote workspace…, the status pill |
| `highlight.rs` | Code block highlighting (below): finds fenced blocks with a language, keeps a tokenizer per block between builds (matched by language and text, else the nearest block of its language, taking the change as one edit), at most `LIVE_MAX` (8) live Wasm instances; per code line the token ranges to colour and a diff/patch background. `layout::build` calls it; `make_piece` turns the ranges into spans |

## Workspaces

One workspace is open at a time: a **local** folder of notes (as before) or a **remote** workspace on a
Grimoire server (multiplayer). Spec: multiplayer-notepad `docs/workspaces/SPEC.md` ("Clients → Mac").

- **Switcher** (`switcher.rs`, key `switcher`): at the very top left of the sidebar, under the traffic
  lights: a glyph (folder or globe), the workspace's name (Inter SemiBold 13.5) over where it lives
  (`~/Documents/Grimoire`, or the server's host, 11.5 muted), and a caret. A press opens the menu (an
  overlay 300 pt wide, with a backdrop that closes it; Esc closes it too):
  - **Recent**: the last 12 workspaces opened (8 shown), local and remote, the open one checked.
  - **On <host>**: for each server the app has a token for, the workspaces joined there
    (`GET /api/workspaces`, refreshed each time the menu opens and after a workspace opens; cached in the
    store, so they show at once), with the role (and "read only").
  - **Open folder…**: the system folder picker (`osascript -e 'choose folder'` on a thread: an
    NSOpenPanel in its own process, so Rune's event loop isn't re-entered); headless runs, or when the
    picker can't run, a path field instead (`~` expanded).
  - **Add remote workspace…**: a URL field (`https://server/app/<workspace>[/<note path>]`; also the old
    `/r/…`; no scheme = https). Return parses it (`workspaces::parse_remote_url`): bad URLs show an error
    under the field.
  Choosing a workspace leaves the open one (the local note saved, the remote room left with a null
  presence) and opens it: a local one at the note open last there, else its newest; a remote one at the
  note from the URL, else the one open last there, else its first note.
- **Persistence**: `~/Library/Application Support/Grimoire/workspaces.json` (`recent` with each workspace's
  last note, `servers` with their name and joined list). No argument at launch opens the most recent
  workspace (a remote one connects in the background). Headless runs read it only with
  `--support-dir=DIR` and never write it.
- **Connect flow** (`remote::connect_flow`), when there's no token for the server: `GET /api/server`
  (must be a Grimoire server), a listener on `127.0.0.1:<random port>`, `/usr/bin/open
  <server>/connect?client=Grimoire%20for%20Mac&redirect=http://127.0.0.1:<port>/callback&state=<128 random
  bits>`, then waits (5 min) for the browser's redirect: the state must match, `error=` is reported, the
  token must look like one; the loopback answers with a "you can close this tab" page. The menu shows
  "Waiting for the browser…" meanwhile. A 401 later (revoked token) forgets the token and runs the flow
  again.
- **Token storage** (`workspaces::Tokens`): the macOS Keychain, generic password service "Grimoire",
  account = the server's origin, written through `security -i` with the command on stdin (so the token
  never shows in a process list) and read back to check; if the Keychain refuses (no GUI session),
  `tokens.json` in the support folder, created 0600 (temp file + rename). Every REST call sends
  `Authorization: Bearer <token>`; the WebSocket sends it as a header (plus `Origin: <server>`).
- **Remote workspace**: the sidebar's tree comes from `GET /api/repos/:id/tree` (fetched again every 3 s;
  paths with hidden or `..` segments and non-Markdown files skipped) under a virtual root
  (`/.grimoire-remote/<host>/<id>`, never on disk). The user for presence comes from `/api/me` (name,
  colour), read-only from `GET /api/workspaces/:id` (`readOnly`, `role: viewer`) and from the room's hello.
  **New note** = `POST /api/repos/:id/files` (`Untitled.md`, `Untitled 2.md`…), then opened.
  **Right-click (or Ctrl-click) a note row** shows Rename… / Delete under it: Rename turns the row into a
  field (the path without `.md`; Return = `POST /api/repos/:id/rename`, `.md` added, the open note
  follows; Esc cancels); Delete asks for a second press (`DELETE /api/repos/:id/files?path=`; the next note
  opens). Errors show as a toast.
- **Remote note**: `Ed::Remote(CollabEditor<NoteStore>)` (collab's `CollabEditor` is generic over the
  editor's store for this) on a WebSocket to `/ws?repo=<id>&path=<note>` run by a thread (tungstenite,
  15 ms read timeout loop); frames and closes come back to the UI thread through `AppHandle::update`
  tagged with a connection generation (stale ones dropped). The editor stays read-only until the room's
  initial sync (then the room's / the workspace's read-only applies); after every handled event
  `pump_collab` sends what the editor has (`take_outgoing`) and schedules its wake-up (a sleeping thread),
  and publishes our caret while the editor has the keys (not while the filter, the switcher or a rename
  field has them). Remote edits patch the editor (`receive`); a rebuild at sync gets the key table back.
  Close codes: retry with collab's backoff (500 ms doubling to 10 s, "Offline · reconnecting"), or end with
  a reason (deleted, renamed → the new path opens, unauthorized, forbidden, not found, too large; the
  editor goes read-only); `Notice::Reset` reconnects with a fresh document and a toast. No local autosave:
  the status pill at the top right shows the server's save state (Saving… / Edited / Saved, "Read only ·"
  first for viewers) or the connection's.
- **Remote carets** (`render::remote_cursors`): each other participant's caret (2 pt, their colour), their
  selection (their colour at 18 %), and their name in a small pill above the caret (Inter SemiBold 11, paper
  on their colour). Same-user carets are hidden (collab).
- Remote notes don't load images (no folder on disk; placeholders) and links to other notes resolve
  against nothing on disk (toast "No note at …").
- **Headless / tests**: `remote::Mock` (collab's `relay::Relay` per note, a tree, scripted peers through the
  same protocol) stands in for the server; `--remote-demo` opens a remote workspace on it with Ada typing
  and her caret showing (`99`). Tests: `net::tests` (URLs, escapes, requests/responses against a mock
  HTTP server, chunked bodies, the loopback listener), `workspaces::tests` (remote URL parsing, names,
  recents and servers persisted, the 0600 token file; the Keychain round trip is `#[ignore]`: it needs a GUI
  session), `remote::tests` (the connect flow through a mock server and a scripted browser: token, wrong
  state, `error=`, not a server; the REST client's paths, bodies, 401/403; room URLs and trees; a remote
  note opened, edited both ways, remote cursor with name/colour, our cursor published/withdrawn with the
  focus, left on switching notes; create/rename/delete; read-only rooms and a missing note; switching
  between a local and a remote workspace keeps one open; the switcher's URL field).
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
  default app (`open <path>`); a missing one shows a toast "No note at notes/plan.md" (relative
  to the notes folder; nothing is created). No folder (the built-in sample): only URLs and
  headings work.
- **Toast:** `App::show_toast`: an ink pill centred near the bottom of the page, faded out after
  2.5 s (a `Live` opacity set from a timer thread; headless runs keep it).
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

## Sidebar

Styled after the web app's sidebar (`src/client/app.css` in multiplayer-notepad: `.sidebar`,
`.sb-actions`, `.sb-filter`, `.repo-row`, `.folder-row`, `.file-row`):

- 34 pt clear at the top for the traffic lights, then the workspace switcher (below, under
  Workspaces; it replaced the folder's name label), "+ New note" (a drawn 10 pt plus, Inter
  Medium 13.5) as a row with a hover tint, the filter field (32 pt, paper, 1 pt hairline, blue
  when focused, "Filter notes" placeholder, a `⌘P` hint while empty), and the tree in its own
  scroll viewport.
- Rows are 28 pt, inset 8 pt with 6 pt corners, Inter 14. A folder has a 1.5 pt chevron
  (right when closed, down when open) and the name in `#3f3f46`; each level indents 14 pt; note
  names drop the extension and are cut with "…". The open note's row is `#e4e4e7` and semibold;
  other rows tint `#ececee` under the pointer.
- **Press a note:** the open note is flushed (`save_now`, before reading, so the open note
  pressed under another name — a symlink — is a no-op; paths compare canonicalized), the new one
  is read and gets its own saver, its folders open, the page scrolls to the top and the window title becomes its name
  (`Tx::set_title`). **Press a folder:** it opens or closes (kept in memory in
  `App::collapsed`; all open by default) and becomes where new notes go until a note is pressed.
- **New note** (the row or Cmd-N): `Untitled.md` (`Untitled 2.md`… when taken) in that folder or
  the root (a folder still on disk, even one emptied of notes), written empty, added to the tree
  without a rescan, opened with the caret at the start; the filter clears.
- **Filter** (click it, or Cmd-P / Cmd-K, which also shows a hidden sidebar): a Rune
  `text_input` bound to `App::filter`. While it has focus `on_key` returns `false` for everything
  but the app shortcuts, so keys reach the field and not the editor, and the editor's caret
  hides; `on_ime` declines too. Esc clears it, a second Esc leaves it; Enter opens the first
  match. Pressing the page (or a row) takes the focus back. Matching notes show with their
  folders, all open. It's `single_line` (pasted or Shift/Alt-Enter line breaks become spaces /
  submit). An IME composition never crosses between the two: the editor's marked text is dropped
  (and hidden) when the filter takes the keys, and the filter's preedit when it loses them.
  The rows are cached on the scan, the closed folders and the filter text, so typing in the
  editor doesn't rebuild them.
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
- A folder with no notes shows "No notes yet / Press ⌘N to start one." in place of the page, and
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
  660 pt (`MAX_TEXT_W`) and at least 240 pt, centred. Narrower windows wrap. `min_size` is
  420×320.

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
  character, plus the key's own letter in Rune's `KeyEvent::base`, which is what a user's
  `"~f" = "moveWordForward:"` binds (unbound, Option-F still types ƒ). Ctrl-↑/↓ (and the system's
  Ctrl-←/→) are Mission Control's unless that's turned off.
  Typing and every editing or moving key end with `tx.scroll_into_view("caret", 24)`, so the
  caret stays visible with the least scroll. Home/End are editor-core's `ScrollToStart`/
  `ScrollToEnd` → `tx.scroll_to("scroll", 0 | ∞)`; the caret stays. Paging (`Command::Page`:
  PageUp/PageDown, Option-PageUp/PageDown, Ctrl-V) needs the viewport, so it's done here: the
  caret moves by the viewport height less two lines, keeping its x (Shift extends), and scrolls
  into view. Ctrl-L scrolls the caret's line to the middle of the view.
- **IME:** `Ime::Preedit` keeps the marked text and the IME caret in `App::marked`; the view
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

Drag image files from Finder onto the page (Rune's `El::on_file_drop` on the surface, so points
are surface-local with the scroll included, like `Drag`; `AppSpec::on_file_drop` is `None`):

- Only images count: `png jpg jpeg gif webp heic svg tiff tif bmp`, any case. Other files are
  skipped, and when none of the hovered files is an image there's no drop caret.
- **Hover:** a 2 pt `#007aff` drop caret (`drop-caret`, `App::drop_at`) at the text position the
  pointer hit-tests to: the same `to_text` clamp and `Editor::hit_test` (with the hidden-marker
  affinity) as a click. It hides on `Cancel` and when the files move over the sidebar, which is a
  drop target that takes nothing, so it also wins where it covers the page. The page's side
  margins outside the surface aren't a target (as for clicks).
- **Drop:** one `![stem](url)` per image, joined by newlines, inserted at the drop point as is
  (mid-line stays inline, like Bear) with `Editor::set_selection(caret)` + `Editor::paste`: one
  undo step, the caret after the text, any selection collapsed, autosave as for typing. The
  filter loses focus and any IME marked text is dropped.
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
  Sizes come from `rune::image_state`, so the line grows when a load finishes (Rune re-runs the
  view); while loading the placeholder's height is kept and nothing is drawn. Once known, a size
  stays (layout never decodes again, however many images a note has), and a touched file keeps
  its previous image and height until the new one is decoded.
- **Sources (`images.rs`):** relative to the open note's folder with `%`-escapes decoded and
  `?query`/`#fragment` dropped (`images/cat%20photo%20%281%29.png` from a drop works; drops
  escape `?` and `#` in names), control characters rejected after decoding (`%00`), `<…>`
  stripped, absolute paths, `~/…`, `file:///…` (and `file://localhost/…`). http(s) shows a
  "Remote image: alt" placeholder (not downloaded). The sample note has no folder, so only
  absolute sources load there.
- **Placeholder:** missing, unreadable, unsupported (HEIC, SVG) or unresolvable images draw a
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

## Rune API added for the app: images

On `grimoire-patches` (commit "Images: rune::image(ImageSource) element …"):
`rune::image(src).size(w, h).radius(r).fit(Fit::…)`, `rune::image_state(path)` /
`rune::image_size(path)`; see docs/rune-capabilities.md, "8. Images".

## Rune API added for the app: scroll requests

On `grimoire-patches` (commit "Tx::scroll_to / scroll_into_view"):

```rust
impl Tx {
    /// Set the keyed scroll viewport's offset (points from the top, clamped; f32::INFINITY = end).
    pub fn scroll_to(&mut self, viewport: impl Into<String>, offset: f32);
    /// Scroll the nearest scroll viewport around the keyed element by the least amount that
    /// shows it with `margin` to spare above and below; nothing moves if it already shows.
    pub fn scroll_into_view(&mut self, key: impl Into<String>, margin: f32);
}
```

Requests are queued in the `Tx` and applied in `Runtime::frame` right after `step_scroll`, so
they see the commit's new layout and scroll extent (a line just typed at the bottom is already
measured). They stop any momentum. Offsets are in the viewport's content space, so they don't
account for virtualized stacks. Test: `runtime::tests::handlers_scroll_a_viewport_to_an_offset_or_an_element`.

## Rune API added for the app: window title

On `grimoire-patches` (commit "Tx::set_title"):

```rust
impl Tx {
    /// Set the window title after this handler (the latest request wins).
    pub fn set_title(&mut self, title: impl Into<String>);
}
```

Merged like the other `Tx` requests (from handlers and `AppHandle::update`), kept in
`Runtime::title_request` for the shell, which calls `Window::set_title`, and in `Runtime::title`,
which `--tree` prints as `"title"`. The macOS window hides its title text (full-size content
view), but the title still names the window in the Window menu, Mission Control and the Dock.
Test: `runtime::tests::handlers_and_updates_set_the_window_title`.

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
| `42-filter`, `43-filter-esc` | click the filter and type `launch` (only matching notes and their folders; the editor gets none of the keys), then Esc clears it |
| `44-cmd-p-enter` | Cmd-P, `gra`, Enter opens `1-1 Grace`; the next key goes to the editor |
| `45-new-note` | Cmd-N and a heading (root `Untitled`), then press `people` and "New note": `people/Untitled` |
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
| `97-switcher` | `--support-dir=tests/fixtures/support`: the switcher open over `Loose ends.md`: recent workspaces (the open folder checked, remote ones with their host), the three joined on grimoire.exe.xyz with roles, Open folder…, Add remote workspace… |
| `98-switcher-add-remote` | then Add remote workspace… and a URL typed into its field |
| `99-remote-cursor` | `--remote-demo`: a remote workspace (globe, "Team / grimoire.example", its tree from the mock server), the note synced ("Saved"), Ada's edit ("today") and her pink caret with her name |

The scripts that open a file (`26`–`31`) now show the sidebar with `crates/app/scripts`' notes.

With clickable links (the `↗` chip became a pencil, and a revealed link shows its URL), the
snapshots showing a link changed: `01`–`05`, `13`–`15`, `17`, `20`–`25`, `32`, `33` (the sample's
"links"), `40`, `42`, `43`, `46`–`50`, `55` (`Loose ends.md`), `70`–`74`.

With links collapsed whatever the selection (only the pencil expands one), `03`, `20` and `37`
changed: a selection over the sample's "links" / the fixture's "web" link no longer shows its
source.

With code highlighting, the snapshots showing the sample's `rust` block changed (only those lines' colours): `01`, `02`, `04`, `05`, `13`–`15`, `17`, `19`–`22`, `25`, `32`, `33`, `70`, `72`.

With the workspace switcher (at the top of the sidebar in place of the folder's name label: New note and
the filter move down 40 pt, the tree 8 pt), every snapshot showing the sidebar changed: `26`–`31`, `34`–`46`, `49`–`56`, `60`–`65`,
`67`–`69`, `81`, `82`, `85`–`90`, `92`–`95`. Those without it (`01`–`25`, `32`, `33`, `47`, `48`, `66`,
`70`–`80`, `83`, `84`, `91`, `96`) are byte-identical.

## Known gaps

- Workspaces: the Keychain path is only exercised in a GUI session (over SSH `security` can't write
  the login keychain and the file fallback is used; its test is `#[ignore]`). Servers can't be disconnected
  (token removed) from the menu, and a joined workspace can't be left. Remote notes show no images
  (`/raw` isn't fetched) and links between remote notes don't open; no participants list, no history.
  Images can't be dropped onto a remote note (a toast says so). The tree is polled
  every 3 s (no event stream). Window focus isn't reported by Rune, so our caret stays published while the
  window is in the background. The remote name pill can cover the line above. Open folder's picker is
  `osascript`'s (its own process, so it may open behind the window on first use).

- Code highlighting runs synchronously in `build` (no render range or background slices as in
  the JS `LiveTokenizer`): pasting a block of several thousand lines tokenizes it all before the
  next frame (~15 ms per 1000 lines). There's no dark theme, and the fence's language word isn't
  completed or validated.
- The sidebar has no rename, delete or move, no keyboard navigation of the rows (arrow keys),
  and no full-text search (the web app's "In text" hits). The folder is rescanned on a 2 s timer,
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

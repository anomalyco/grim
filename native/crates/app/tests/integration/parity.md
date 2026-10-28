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
  missing folder → "No such folder", the joined list, Switch account, notes create/rename/delete, token revoked
  → Reconnect, offline → recovers, deleted while open, Disconnect revokes: 14 × `QA PASS` with the setup),
  `new_remote_folder_against_a_server` (never connected → connect flow → created and opened, `canRemove`), and
  `remote::tests::integration_against_a_server` with `bob.mjs` (live edits and carets both ways): all `ok`.

Changed after the recording (both apps, 2026-10-28): the server headings read just the host
("100.73.96.98:47395", not "On 100.73.96.98:47395"); the captures below and
`menu::tests::matches_the_web_menu_captured_on_the_scratch_server`'s fixture were edited by hand to match.

Captured (web, Chromium):

    other:   100.73.96.98:47395 | Linked | • Parity QA | — | New… | Open…
    maker:   100.73.96.98:47395 | • Linked | Parity QA | — | New… | Open… | — | Remove folder…
    account: james@example.com | Change name… | Sign out

Captured (Mac, real server):

    other:   100.73.96.98:47395 | • Linked | — | New… | Open…
    maker:   100.73.96.98:47395 | Linked | • Parity QA | — | New… | Open… | — | Remove folder…
    account: mac-user-5cjq@dev.grimoire | Change name… | Switch account | Sign out
    local:   This Mac | • folder-a | 100.73.96.98:47395 | Parity QA | — | New… | Open…

## Check list (web item → Mac item)

| # | Web (label · order · rule) | Mac | Result |
|---|---|---|---|
| 1 | Section heading with the server's host ("grimoire.exe.xyz"; "On <host>" until 2026-10-28) first | same text, first in a remote menu | PASS |
| 2 | Joined folders by title, a dot on the open one, an × on each, shown only while the row is hovered or keyboard-focused; the × asks "Remove <name> from your list?" (remote / local texts), Remove / Cancel, then toast "Removed <name> from your list"; the only folder in the list: "Can't remove your only folder" (New folder… / OK) | same words and buttons, the × shown while the pointer is over the row (its space reserved); no keyboard navigation in the Mac's switcher | PASS (real: Linked left, gone from `/api/workspaces`) |
| 3 | Open folder not joined: listed, checked, no × | same | PASS (unit) |
| 4 | "No folders yet" (disabled) when none | same | PASS (unit) |
| 5 | A <host> heading per remembered remote server (its × forgets it) | A <host> heading per other connected server: its joined folders, the × leaves with that server's token | DIFFERS (the Mac has a token per server) |
| 6 | — | "This Mac" (local folders, × on hover, not on the open one: the local "Remove <name> from your list?" confirm) | Mac only |
| 7 | sep · "New…" · "Open…" | same | PASS |
| 8 | Open: URL ("Remote folder" until 2026-10-28; a folder's or a note's link: nested, encoded, old `/r/`, `.md` added; the folder opens at the note, or "No note at “<path>”"; the hint and error texts), GitHub repo (Read-only / Edit with the app) | same labels, texts and behaviour (both apps changed together: it matches), plus Mac-only Folder (system picker) | PASS (unit: `actions::tests::open_url_takes_folder_and_note_links`; + Mac extra) |
| 9 | New: Name / Create on this server; toast "Created “…”" | New → Remote folder: Server (the open folder's server, else the first connected one, else https://grimoire.exe.xyz/) + Name / Create, the connect flow first when not connected; plus Mac-only New → Folder | PASS (real: connect → created, opened) |
| 10 | sep, then only with an open folder: "Open on GitHub" (GitHub copies), "Remove folder…" (`canRemove`, its maker; confirm "Remove “…” from Grimoire for everyone who has it?") | same | PASS (real: maker yes, others no; repo 404 after) |
| 11 | Sidebar card "Share with an agent" + Copy: `POST /api/repos/:id/shares` (one link per person per folder), the prompt copied, "Copied" | same, prompt word for word, on every remote folder; plus local folders (path instructions) | PASS (real: the Linux box's shell command through the link showed up) |
| 12 | Account row at the bottom of the sidebar; its menu upward: the email (no @localhost email), Change name…, Sign out | same, the open folder's server's account, plus "Switch account"; signed out: Reconnect / Forget; no row for a local folder | PASS (real + unit) |
| 13 | "Change name…" (Name / Save, `PATCH /api/me`) | same; the room reconnects with the new name | PASS (real: `/api/me` "Mac Parity") |
| 14 | "Sign out" (`POST /auth/logout`, no confirm) | "Sign out" with a confirm: revokes this app's token (`DELETE /api/tokens/:id`), forgets it | PASS (real: token → 401) |
| 15 | A missing folder: "No such folder" | same page ("“<id>” doesn't exist on <host>."), Remove | PASS (real + unit) |
| 16 | — | Open → Folder from a remote and from a local folder | PASS (real: both opened) |

Removed from both apps with `7e925d3` (and from this list): Share folder… (members, invites, roles, link access,
domain rule, Copy link), the note header's Share and note links ("Shared with me" on the web), Settings
(connected apps), viewer read-only, the leave confirm and owner rules (`canLeave`), and the "No access" page.

## What differs, and why

- **Open → Folder, New → Folder, New → Remote folder's Server field, This Mac, Switch account**: Mac only
  (folders on disk; one app token per server to replace).
- **Sign out** asks first and revokes only this app's token (the web ends the browser session).
- **Other servers' headings** (their hosts) list the folders joined on the other servers the app has tokens for, and their ×
  leaves there (the web lists the remote folders a browser remembers, its × forgets them); a signed-out one
  says so with Reconnect / Forget.
- **Keyboard**: the web's switcher rows take the keyboard focus (and show their × then); the Mac's switcher
  has no keyboard navigation, so its × shows on pointer hover only.
- The web's legacy-server rules (`server.legacy`) don't apply: the Mac only connects to servers with
  `/api/server`.

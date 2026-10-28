# Folder switcher: web ↔ Mac parity (2026-10-28)

Reference: multiplayer-notepad `src/client/main.ts` (`openSwitcher`, `joinedBadge`, `leaveWorkspace`, `removeRepo`,
`changeName`, `logout`, `shareCurrentNote`), `workspaces.ts` (dialogs), `dialogs.ts`, `api.ts`; server `api.ts`,
`workspaces.ts`, `shares.ts`, `tokens.ts`. Mac: `crates/app/src/menu.rs` (items), `dialogs.rs`, `actions.rs`.

## How it was checked

- Scratch server on the Linux box (`qa-scratch.mjs`, `W3_HOST=100.73.96.98 W3_PORT=47393`, temp `DATA_DIR`, fake
  Google on; killed and its data deleted afterwards).
- Mac: `GRIMOIRE_QA_SERVER=http://100.73.96.98:47393 GRIMOIRE_QA_GOOGLE_HOST=100.73.96.98 cargo test --release -p
  grimoire parity_against_a_server -- --ignored --nocapture` (`src/remote_qa.rs`): 14 × `QA PASS`, `test result: ok`.
  While it waited, the Linux box POSTed `echo "# The agent was here" > agent-was-here.md` to the agent link the Mac
  made (`PARITY AGENT-URL`); the Mac's Refresh then listed `agent-was-here.md` (since 2026-10-28 there is no
  Refresh: the test waits for the tree's 3 s poll instead).
- Web: `parity-web.mjs` (headless Chromium on the Linux box) captured the web switcher for the same server (James:
  owner of "Linked", "Parity QA" through its domain rule) and opened the Mac's two note links signed out.
- `menu::tests::matches_the_web_menu_captured_on_the_scratch_server` replays those two web menus against the Mac's
  model: equal item for item once the Mac-only "Switch account" is taken out.

Re-run 2026-10-28 after the "folder" rename and the one "Open…" item (web d74c0de, Mac on Rune dev): Mac parity
run 15 × `QA PASS`, `test result: ok`; the agent link's shell command showed up after Refresh; the web capture
below equals `menu::tests::matches_the_web_menu_captured_on_the_scratch_server`'s fixture item for item (the Mac
adds only "Switch account", and "This Mac" when it has local folders).

Changed 2026-10-28 (both apps, in parallel): the access badges (Owner / Editor / Viewer / "via link" /
"· domain") are gone from every folder row, and "Refresh" is gone from the menu (the tree's 3 s poll picks up
changes, e.g. the agent's note). The recorded web menus below had both taken out by hand to match;
`menu::tests::matches_the_web_menu_captured_on_the_scratch_server` replays them as edited.

Changed again 2026-10-28 (both apps): "Leave folder" is gone from the menu (taken out of the recorded web menu
below by hand too). Every folder row is its name and an ×, nothing else (no host or path); other servers'
folders sit under their own "On <host>" heading. The × on a remote folder leaves it (`DELETE
/api/workspaces/:id/join`, with that server's token): joined via link or domain at once; an invited member
after "Leave <name>? You'll need a new invite to get back in."; an owner only when the server's `canLeave`
is true (there are other owners); none on a folder that's open but not joined. Leaving the open folder opens
another one (or none). Local folders' × is "Remove from list" (not on the open one). Unit:
`menu::tests::every_folder_row_gets_an_x_by_the_webs_rules`, `actions::tests::leave_and_remove`; the parity
run leaves Linked through its × (link join: no confirm). The web also offers Undo after a link leave; the Mac
doesn't (its toasts have no actions; opening the link again rejoins).

Changed again 2026-10-28 (both apps): "New…" sits above "Open…" (added to the recorded web menus below by hand)
and opens a "New" dialog; the Open dialog lost its "Create new" section. The web's New dialog has only the
remote form (Name, Create, on that server); the Mac's has Folder (this Mac) and Remote folder with a **Server**
field (default: the open folder's server, else the first connected one, else https://grimoire.exe.xyz/),
which runs the connect flow first for a server it isn't connected to. Unit:
`actions::tests::new_remote_folder_connects_first_then_creates`,
`…::new_remote_folder_server_defaults_to_one_already_known`; real: `remote_qa::new_remote_folder_against_a_server`
(scratch server 100.73.96.98:47394, never connected → connect flow with a name sign-in → created private,
role owner, opened: `QA PASS`).

Changed again 2026-10-28 (both apps): "Share with agent…" is gone from the menu (taken out of the recorded web
menu below by hand); a "Share with an agent" card pinned at the bottom of the sidebar has **Copy** ("Copied" for
a moment), which copies the web's agent prompt with this account's agent link for the open folder (`POST
/api/repos/:id/shares {reuse: true}`), and is hidden where the account can't make agent links (`canShare`). The
Mac also shows it for local folders, copying instructions with the folder's path (no server). Unit:
`actions::tests::agent_link_prompt_and_note_links`, `…::the_agent_card_for_viewers_and_local_folders`; the
parity run copies through the card.

Captured (web, Chromium):

    owner:       On 100.73.96.98:47393 | • Linked | Parity QA | — | New… | Open… | — | Share folder… | Remove folder… | — | Signed in as James · james@example.com | Change name… | Settings | Sign out
    link/domain: On 100.73.96.98:47393 | Linked | • Parity QA | — | New… | Open… | — | Signed in as James · james@example.com | Change name… | Settings | Sign out

Captured (Mac, real server; before the badges and Refresh were taken out):

    link editor: On 100.73.96.98:47393 | • Linked [via link] | — | Open… | — | Share with agent… | Refresh | Leave folder | — | Signed in as Mac user · mac-user-s7rt@dev.grimoire | Change name… | Settings | Switch account | Sign out
    owner:       On 100.73.96.98:47393 | Linked [via link] | • Parity QA [Owner] | — | Open… | — | Share folder… | Share with agent… | Refresh | Remove folder… | — | Signed in as Mac user · … | Change name… | Settings | Switch account | Sign out
    local:       This Mac | • folder-a [/private/var/…/folder-a] | On 100.73.96.98:47393 | Parity QA [Owner] | — | Open…

Note links (web, signed out): view → "Can view", typing changes nothing; edit → typing reaches the server
("# Parity QA typed via edit link").

## Check list (web item → Mac item)

| # | Web (label · order · rule) | Mac | Result |
|---|---|---|---|
| 1 | Section "On <host>" first | same text, first in a remote menu | PASS |
| 2 | Joined workspaces by title, no access badge (Owner / Editor / Viewer / "via link" / "· domain" removed 2026-10-28), dot on the open one | same: title, dot | PASS (unit; web capture replayed without badges) |
| 3 | Open workspace not joined: listed, checked | same (a problem page adds why, e.g. "no access") | PASS |
| 4 | "No folders yet" (disabled) when none | same | PASS (unit) |
| 5 | "On <host>" per remembered remote server (names only) | "On <host>" per other connected server: its joined folders, names only, × leaves with that server's token | PASS (unit) |
| 6 | "Shared with me" (note links this browser opened) | — | DIFFERS: the Mac doesn't open note links |
| 7 | — | "This Mac" (local folders, × Remove from list) | Mac only |
| 8 | sep · "New…" · "Open…" (the Open dialog: Remote folder, GitHub repo; Folder URL, hint, "Open", the web's error) | same, plus Mac-only Open → Folder (system picker) | PASS (+ Mac extras) |
| 9 | New… → "New" dialog: Name / Create on this server; toast "Created “…”" | New → Remote folder: Server (known-server default) + Name / Create, connect flow first when not connected; plus Mac-only New → Folder; `POST /api/workspaces` | PASS (real: connect → created, opened, role owner) |
| 10 | Open → GitHub repo ( Read-only / Edit with the app, statuses, errors) | same | PASS (unit, fake server; not run against GitHub) |
| 11 | sep, then only with an open workspace | same (once loaded, signed in) | PASS |
| 12 | "Share folder…" owners only (not legacy) | same | PASS (owner yes; editor / viewer / link no) |
| 12a | invite by email + Can edit / Can view, "Enter an email address." | same | PASS (real: bob@example.com pending editor) |
| 12b | pending "Invited", role change Owner / Can edit / Can view | same (segmented control instead of `<select>`) | PASS (real: → viewer) |
| 12c | remove member ×; last owner shows "Owner", no ×, server refuses | same | PASS (real: removed; last owner 409 shown) |
| 12d | General access none / view / edit + hint | same (radio buttons) | PASS (real: `/public` says view) |
| 12e | Everyone at a company: `*@company.com` + role, Save, toasts, "Enter a domain like *@company.com." | same | PASS (real: `*@example.com=viewer`; James then joined through the domain rule) |
| 12f | link + "Copy link" | same, system clipboard, "Copied" | PASS |
| 12g | note when Google sign-in is off | same text, from `/api/server` `google` | PASS (unit on/off; real server google on → hidden) |
| 13 | Sidebar card "Share with an agent" + Copy (was the "Share with agent…" item) when `canShare` and ready: link (reuse), the prompt copied, "Copied" | same, prompt word for word; plus local folders (path instructions) | PASS (unit; real before the change: Linux box's shell command through the link showed up) |
| 14 | "Open on GitHub" (GitHub copies) | same (`/usr/bin/open`) | PASS (unit) |
| 15 | — ("Refresh" removed 2026-10-28) | — (removed; the tree's 3 s poll shows new notes) | PASS (unit: not in any menu) |
| 16 | × on a joined folder (no "Leave folder" item since 2026-10-28): link/domain at once; member confirm "Leave <name>? You'll need a new invite to get back in."; owners only with `canLeave` | same (`menu::leave_cross`); then the next joined folder opens | PASS (unit; real run before the change: left via the old item, gone from `/api/workspaces`) |
| 17 | "Remove folder…" `canRemove`; confirm "Remove folder", "Remove “…” from Grimoire for everyone who has it?", Remove | same | PASS (real: repo 404 afterwards) |
| 18 | sep · "Signed in as <name> · <email>" (no @localhost email) | same | PASS |
| 19 | "Change name…" (Name / Save / "Shown on your cursor and on your commits.", `PATCH /api/me`, reload) | same; the room reconnects with the new name | PASS (real: `/api/me` "Mac Parity") |
| 20 | "Settings": Connected apps, hint, label, "Connected … · last used … / never used", Revoke, toast, 404 / empty texts | same | PASS (real: 2 listed, other revoked → 401, ours 200) |
| 21 | — | "Switch account" (connect flow, old token revoked) | Mac only (kept from the old per-server rows) |
| 22 | "Sign out" (`POST /auth/logout`, no confirm) | "Sign out" with a confirm: revokes this app's token (`DELETE /api/tokens/:id`), forgets it | PASS (as asked: real token → 401) |
| 23 | Note header "Share" (hidden for note links / legacy): "Share note", Can view / Can edit (writable), Create link, copied, toast "Link copied.", Copy | same, left of the status pill | PASS (real: view link read-only in Chromium, edit link's typing reached the file) |
| 24 | — | local folder: This Mac, "On <host>" per server, New… and Open… only | PASS (no server items; real + unit) |
| 25 | — | Open → Folder from a remote and from a local folder | PASS (real: both opened) |

## What differs, and why

- **Shared with me** (web): the Mac can't open note links, so there is nothing to list.
- **Open → Folder, New → Folder, New → Remote folder's Server field, This Mac, Switch account**: Mac only (folders on disk; one app token per server to replace).
- **Sign out** asks first and revokes only this app's token (the web ends the browser session).
- **Selects** are segmented controls / radio buttons (Rune has no `<select>`); options and labels are the web's.
- **Other servers' headings** list the folders joined on the other servers the app has tokens for, and their ×
  leaves there (the web lists the remote folders a browser remembers, its × forgets them); a signed-out one
  says so with Reconnect / Forget.
- The web's legacy-server rules (`server.legacy`) don't apply: the Mac only connects to servers with
  `/api/server`.
- A viewer of a writable workspace sees the note's Share (as on the web) and the server refuses the link
  ("you need write access…"), shown in the dialog.

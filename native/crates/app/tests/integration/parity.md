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
  made (`PARITY AGENT-URL`); the Mac's Refresh then listed `agent-was-here.md`.
- Web: `parity-web.mjs` (headless Chromium on the Linux box) captured the web switcher for the same server (James:
  owner of "Linked", "Parity QA" through its domain rule) and opened the Mac's two note links signed out.
- `menu::tests::matches_the_web_menu_captured_on_the_scratch_server` replays those two web menus against the Mac's
  model: equal item for item once the Mac-only "Switch account" is taken out.

Re-run 2026-10-28 after the "folder" rename and the one "Open…" item (web d74c0de, Mac on Rune dev): Mac parity
run 15 × `QA PASS`, `test result: ok`; the agent link's shell command showed up after Refresh; the web capture
below equals `menu::tests::matches_the_web_menu_captured_on_the_scratch_server`'s fixture item for item (the Mac
adds only "Switch account", and "This Mac" when it has local folders).

Captured (web, Chromium):

    owner:       On 100.73.96.98:47393 | • Linked [Owner] | Parity QA [Viewer · domain] | — | Open… | — | Share folder… | Share with agent… | Refresh | Remove folder… | — | Signed in as James · james@example.com | Change name… | Settings | Sign out
    link/domain: On 100.73.96.98:47393 | Linked [Owner] | • Parity QA [Viewer · domain] | — | Open… | — | Refresh | Leave folder | — | Signed in as James · james@example.com | Change name… | Settings | Sign out

Captured (Mac, real server):

    link editor: On 100.73.96.98:47393 | • Linked [via link] | — | Open… | — | Share with agent… | Refresh | Leave folder | — | Signed in as Mac user · mac-user-s7rt@dev.grimoire | Change name… | Settings | Switch account | Sign out
    owner:       On 100.73.96.98:47393 | Linked [via link] | • Parity QA [Owner] | — | Open… | — | Share folder… | Share with agent… | Refresh | Remove folder… | — | Signed in as Mac user · … | Change name… | Settings | Switch account | Sign out
    local:       This Mac | • folder-a [/private/var/…/folder-a] | On 100.73.96.98:47393 | Parity QA [Owner] | — | Open…

Note links (web, signed out): view → "Can view", typing changes nothing; edit → typing reaches the server
("# Parity QA typed via edit link").

## Check list (web item → Mac item)

| # | Web (label · order · rule) | Mac | Result |
|---|---|---|---|
| 1 | Section "On <host>" first | same text, first in a remote menu | PASS |
| 2 | Joined workspaces, badge Owner / Editor / Viewer / "via link" / "<Role> · domain" / "via domain" (`joinedBadge`), dot on the open one | same (`Joined::badge`), right-aligned badge, dot | PASS (real server: "via link", "Owner"; web capture "Viewer · domain" replayed) |
| 3 | Open workspace not joined: listed, checked, no badge | same (a problem page adds why, e.g. "no access") | PASS |
| 4 | "No folders yet" (disabled) when none | same | PASS (unit) |
| 5 | "Other servers" (remembered remotes, host as detail) | "Other servers": workspaces joined on the other connected servers, host as detail | PASS |
| 6 | "Shared with me" (note links this browser opened) | — | DIFFERS: the Mac doesn't open note links |
| 7 | — | "This Mac" (local folders, × Remove from list) | Mac only |
| 8 | sep · "Open…" (the Open dialog: Open → Remote folder, GitHub repo; Create new → Remote folder; Folder URL, hint, "Open", the web's error) | sep · "Open…", the same dialog plus Mac-only Open → Folder (system picker) and Create new → Folder | PASS (+ Mac extras) |
| 9 | Open → Create new → Remote folder (Name / Create / "A folder of Markdown notes on <host>. Only you can open it until you share it."; toast "Created “…”") | same, on a chosen connected server; `POST /api/workspaces` | PASS (real: created, opened, role owner) |
| 10 | Open → GitHub repo ( Read-only / Edit with the app, statuses, errors) | same | PASS (unit, fake server; not run against GitHub) |
| 11 | sep, then only with an open workspace | same (once loaded, signed in) | PASS |
| 12 | "Share folder…" owners only (not legacy) | same | PASS (owner yes; editor / viewer / link no) |
| 12a | invite by email + Can edit / Can view, "Enter an email address." | same | PASS (real: bob@example.com pending editor) |
| 12b | pending "Invited", role change Owner / Can edit / Can view | same (segmented control instead of `<select>`) | PASS (real: → viewer) |
| 12c | remove member ×; last owner shows "Owner", no ×, server refuses | same | PASS (real: removed; last owner 409 shown) |
| 12d | General access none / view / edit + hint | same (radio buttons) | PASS (real: `/public` says view) |
| 12e | Everyone at a company: `*@company.com` + role, Save, toasts, "Enter a domain like *@company.com." | same | PASS (real: `*@example.com=viewer`; web then badges James "Viewer · domain") |
| 12f | link + "Copy link" | same, system clipboard, "Copied" | PASS |
| 12g | note when Google sign-in is off | same text, from `/api/server` `google` | PASS (unit on/off; real server google on → hidden) |
| 13 | "Share with agent…" when `canShare` and ready: link (reuse), the prompt, Copy | same, prompt word for word | PASS (real: Linux box's shell command through it showed up) |
| 14 | "Open on GitHub" (GitHub copies) | same (`/usr/bin/open`) | PASS (unit) |
| 15 | "Refresh" | same: `POST /refresh`, tree reloaded | PASS (real) |
| 16 | "Leave folder" joined and not owner; confirm "Leave folder", "Leave “…”? <how>", Leave; toast "You left “…”." | same; then the next joined workspace opens | PASS (real: link wording; gone from `/api/workspaces`) |
| 17 | "Remove folder…" `canRemove`; confirm "Remove folder", "Remove “…” from Grimoire for everyone who has it?", Remove | same | PASS (real: repo 404 afterwards) |
| 18 | sep · "Signed in as <name> · <email>" (no @localhost email) | same | PASS |
| 19 | "Change name…" (Name / Save / "Shown on your cursor and on your commits.", `PATCH /api/me`, reload) | same; the room reconnects with the new name | PASS (real: `/api/me` "Mac Parity") |
| 20 | "Settings": Connected apps, hint, label, "Connected … · last used … / never used", Revoke, toast, 404 / empty texts | same | PASS (real: 2 listed, other revoked → 401, ours 200) |
| 21 | — | "Switch account" (connect flow, old token revoked) | Mac only (kept from the old per-server rows) |
| 22 | "Sign out" (`POST /auth/logout`, no confirm) | "Sign out" with a confirm: revokes this app's token (`DELETE /api/tokens/:id`), forgets it | PASS (as asked: real token → 401) |
| 23 | Note header "Share" (hidden for note links / legacy): "Share note", Can view / Can edit (writable), Create link, copied, toast "Link copied.", Copy | same, left of the status pill | PASS (real: view link read-only in Chromium, edit link's typing reached the file) |
| 24 | — | local folder: This Mac, "On <host>" per server, Open… only | PASS (no server items; real + unit) |
| 25 | — | Open → Folder from a remote and from a local folder | PASS (real: both opened) |

## What differs, and why

- **Shared with me** (web): the Mac can't open note links, so there is nothing to list.
- **Open → Folder, Create new → Folder, This Mac, Switch account**: Mac only (folders on disk; one app token per server to replace).
- **Sign out** asks first and revokes only this app's token (the web ends the browser session).
- **Selects** are segmented controls / radio buttons (Rune has no `<select>`); options and labels are the web's.
- **Other servers** lists the workspaces joined on the other servers the app has tokens for (the web lists the
  remote workspaces a browser remembers); a signed-out one says so with Reconnect / Forget.
- The web's legacy-server rules (`server.legacy`) don't apply: the Mac only connects to servers with
  `/api/server`.
- A viewer of a writable workspace sees the note's Share (as on the web) and the server refuses the link
  ("you need write access…"), shown in the dialog.

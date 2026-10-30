# Integration run against a real server (W3, 2026-10-27)

On the Linux box with the web repo (multiplayer-notepad), from its root:

    W3_HOST=<tailscale ip> W3_PORT=47391 bun crates/app/tests/integration/scratch.mjs   # temp DATA_DIR, STORAGE=local, dev login, SIGNIN=open
    W3_BASE=http://<tailscale ip>:47391 bun crates/app/tests/integration/bob.mjs        # "Bob" in headless Chromium (playwright-core in /tmp/opencode/pw)

On the Mac, while Bob waits:

    GRIMOIRE_IT_SERVER=http://<tailscale ip>:47391 cargo test --release -p grimoire integration_against_a_server -- --ignored --nocapture

Both print the note's final text (`IT-TEXT`, `BOB-TEXT` = the server's file): they must be equal. bob.mjs also
checks that the "Mac user" caret label shows and saves a screenshot. Kill the server and delete its DATA_DIR after.

## QA run: every workspace flow (2026-10-28)

    W3_HOST=<tailscale ip> W3_PORT=47392 DATA_DIR=/tmp/opencode/qa/data bun crates/app/tests/integration/qa-scratch.mjs   # + fake Google

On the Mac:

    GRIMOIRE_QA_SERVER=http://<tailscale ip>:47392 GRIMOIRE_QA_NOT_GRIMOIRE=http://<tailscale ip>:<fake google port> \
      cargo test --release -p grimoire qa_flows_against_a_server -- --ignored --nocapture

`src/remote_qa.rs`: a scripted browser (cookies, name and Google sign-in, "Not you?") drives the connect page
while the app runs its real network code; each flow prints `QA PASS …` (another account's folder opens and
takes edits (every folder is public); a missing folder → No such folder; joined list; Switch account ("Not
you?" → Google); notes create/rename/delete; token
revoked on the web → Reconnect; server down through a proxy → offline → recovers; local ↔ remote; deleted
while open; Remove; not a Grim server; recents with titles after a reload; Disconnect revokes).

## Parity run: the switcher's items like the web app's (2026-10-28)

    W3_HOST=<tailscale ip> W3_PORT=47393 DATA_DIR=/tmp/opencode/qa-parity/data bun crates/app/tests/integration/qa-scratch.mjs

On the Mac (in the background, its log watched for `PARITY AGENT-URL`):

    GRIMOIRE_QA_SERVER=http://<tailscale ip>:47393 GRIMOIRE_QA_GOOGLE_HOST=<tailscale ip> \
      cargo test --release -p grimoire parity_against_a_server -- --ignored --nocapture

When it prints `PARITY AGENT-URL <url>`, POST a shell command to it from the Linux box (`curl -X POST <url> -H
'content-type: application/json' -d '{"command":"echo hi > agent-was-here.md"}'`); the test waits for the tree's
periodic update (every 3 s) to show the note. Then `BASE=… LINKED=… PARITY=… OUT=… bun parity-web.mjs` (the ids the
Mac run printed: `QA PASS setup` and `new folder`) captures the web switcher for the same folders and the web's
account menu. Results: `parity.md`.

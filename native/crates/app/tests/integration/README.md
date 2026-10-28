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
while the app runs its real network code; each flow prints `QA PASS …` (private workspace with another
account → No access → Switch account → loads; link view/edit; joined list; notes create/rename/delete; token
revoked on the web → Reconnect; server down through a proxy → offline → recovers; local ↔ remote; deleted
while open; Remove; not a Grimoire server; recents with titles after a reload; Disconnect revokes).

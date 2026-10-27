# Integration run against a real server (W3, 2026-10-27)

On the Linux box with the web repo (multiplayer-notepad), from its root:

    W3_HOST=<tailscale ip> W3_PORT=47391 bun crates/app/tests/integration/scratch.mjs   # temp DATA_DIR, STORAGE=local, dev login, SIGNIN=open
    W3_BASE=http://<tailscale ip>:47391 bun crates/app/tests/integration/bob.mjs        # "Bob" in headless Chromium (playwright-core in /tmp/opencode/pw)

On the Mac, while Bob waits:

    GRIMOIRE_IT_SERVER=http://<tailscale ip>:47391 cargo test --release -p grimoire integration_against_a_server -- --ignored --nocapture

Both print the note's final text (`IT-TEXT`, `BOB-TEXT` = the server's file): they must be equal. bob.mjs also
checks that the "Mac user" caret label shows and saves a screenshot. Kill the server and delete its DATA_DIR after.

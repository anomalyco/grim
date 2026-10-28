# Reference editor probe harness

Swift scripts that drive the reference Markdown editor (version 2.8.1, macOS) through the Accessibility API and record exact editor state after each keystroke. Used to derive `docs/04-editor-engine.md`.

- `axlib.swift`: finds the reference editor's text area and provides `text()`, `setSel()`, and RTF run dumps.
- `harness.swift`: focuses the editor, sends keys/typing via `CGEvent.postToPid`, and has a guard that aborts unless the scratch note "ZZ opencode render test (safe to delete)" is open.
- `state.swift`: `st(label)` prints line, column, raw selection, caret rect, the AX line (block tokens show as `￼`), and a compact view where `·` = collapsed marker, `‹x›` = revealed marker.
- `p*.swift`: individual probe scenarios (typing inline syntax, block conversions, arrows, up/down, backspace/tab/undo).

Run on the laptop: `cat axlib.swift harness.swift state.swift pA.swift > run.swift && swift run.swift`.
Requires Accessibility permission for the SSH session (`/usr/libexec/sshd-session` / `sshd-keygen-wrapper`). Screen Recording isn't needed: everything is read through AX (`AXValue`, `AXRTFForRange`, `AXBoundsForRange`, `AXSelectedTextRange`).

Note: RTF indices omit `￼` attachment characters, and AX value indices include them.

## Screenshots (`bearshot/`)

Screen Recording isn't granted to the SSH session, but it is granted to Terminal. `bearshot/start.command` (opened via `open -a Terminal`) launches `daemon.sh` as a Terminal child, so it inherits the permission. It then captures on request (`~/.bearshot/req` = output path, `~/.bearshot/args` = screencapture flags). `winid.swift` finds the reference editor's window ID so only that window is captured (`-o -l <id>`). Client: `tools/bearshot [out.png]`. The daemon must be restarted after a reboot (the client auto-starts it). macOS may periodically re-ask to confirm Terminal's Screen Recording access.

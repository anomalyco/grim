# C1: editor-core on the shared document (`crates/collab`)

Laptop `~/projects/grimoire-native/crates/collab` (commits 907430a, e1653a1).
Builds for wasm32-unknown-unknown (no threads, no clock, no RNG; tungstenite is only a dev-dependency of the
example client). yrs pinned to 0.28.x, no `sync` feature.

## Shape

```
CollabEditor ── Editor<CollabStore>   editor-core, unchanged; undo = editor-core History (remote-rebased)
             │      └─ CollabStore { yrs: Rc<RefCell<YrsStore>>, mirror: String }   TextStore
             └─ Session (protocol.rs, ported from provider.ts) ── same Rc<RefCell<YrsStore>>
YrsStore::without_undo(client_id)   yrs Doc + Text "md" (UTF-16); yrs UndoManager not used
```

- Local edit: `Editor` → `CollabStore::replace(bytes)` → UTF-16 → yrs transaction (origin local) + mirror. Undo/redo
  are ordinary local edits on the same path.
- Remote: `Session::receive` applies the update (origin remote) → yrs text delta → sequential UTF-16 edits →
  bytes against a scratch copy → `Editor::apply_remote` (maps selection, literals, history) → `replace_remote`
  updates the mirror only.

## API for C2 (all sans-IO: the shell owns the WebSocket and timers)

```rust
CollabEditor::new(client_id: u32, user: serde_json::Value) -> CollabEditor   // id from crypto.getRandomValues; user {id,name,color,kind}
fn editor(&self) -> &Editor<CollabStore>
fn editor_mut(&mut self) -> &mut Editor<CollabStore>   // run every Engine command here (never apply_remote)
fn take_outgoing(&mut self, now_ms: f64) -> Outgoing   // call after every command and when wake_in_ms fires
    Outgoing { frames: Vec<Vec<u8>>, wake_in_ms: Option<f64>, awareness: bool /* peers timed out → redraw */ }
fn receive(&mut self, frame: &[u8]) -> Result<Received, String>   // every binary frame from the server
    Received { outgoing: Vec<Vec<u8>>,                       // send these now
               edits: Vec<(Range<usize>, String)>,           // remote edits applied (bytes, sequential)
               edits_utf16: Vec<collab::Edit>,               // same, UTF-16 {from,to,insert}
               reloaded: bool,                               // editor rebuilt at initial sync → render_all
               awareness: bool,                              // remote presence changed → redraw cursors/participants
               notices: Vec<Notice> }
    Notice::{ Hello{read_only, msg}, Synced, ReadOnly(bool), SaveState(Value), External(Option<String>), Reset }
fn set_focused(&mut self, focused: bool, now_ms: f64) -> Vec<Vec<u8>>   // focus/blur: cursor shown only while focused
fn remote_cursors(&self) -> Vec<PeerCursor>   // {client, user_id, name, color, anchor, head (bytes), anchor_utf16, head_utf16}
fn peers(&self) -> Vec<(u64, Value)>          // other clients' {user, cursor} states (participants list)
// lifecycle
fn connecting(&mut self)                                         // before opening the socket
fn disconnected(&mut self, code: u16, reason: &str) -> AfterClose   // Retry{delay_ms} | Closed{reason, to}
fn online(&mut self) -> bool                                     // window "online": true = reconnect now
fn reset(&mut self, client_id: u32)                              // after Notice::Reset: fresh doc, then reconnect
fn request_flush(&mut self) -> Vec<Vec<u8>>;  fn leave(&mut self) -> Vec<Vec<u8>>
fn status() -> ConnStatus; synced() -> bool; read_only() -> bool; save_state() -> &Value; client_id() -> u64
fn is_consistent(&self) -> bool   // editor text == yrs text (debug aid)
```

Suggested wasm glue: after each Engine command `take_outgoing(performance.now())` → `ws.send` each frame; arm one
timer for `wake_in_ms`. `onmessage` → `receive` → send `outgoing`, then patch: `reloaded` → `render_all`, else
diff lines as for any edit (`edits_utf16` for anything that wants the text change); redraw cursors when `awareness`.
`onclose` → `disconnected(code, reason)` → retry timer or end the session; `Notice::Reset` → close the socket, toast
"This note was reloaded from the server.", `reset(newId)`, connect again. Like main.ts, mount the editor only
after `Notice::Synced` (the editor is rebuilt there with the caret at the start unless it was edited before).

## Matches the TS client

provider.ts: nothing trusted before `hello`; step1 + awareness re-announce (bumped clock) on hello; step2 answer
carries offline edits (`unsent`); read-only never answers step1 nor sends updates (editor read-only too); generation
change or read-only with unsent edits → `Reset`; close codes 4401/4403/4404/4413 final, 4000 / `closed` control →
final with reason/`to`, others retry 500 ms doubling to 10 s, reset on hello, `online()` retries at once; remote
presence and its clocks forgotten on disconnect; `leave()` sends a null state. Awareness renewed every 15 s and
remote states expire after 30 s (y-protocols timers; the server's Awareness drops states not renewed).
view.ts/cursors.ts: cursor published only while focused, throttled 50 ms (trailing), selection as Yjs relative
positions (`toRel` assoc rules, `relativePositionToJSON` format); remote cursors of the same user id hidden,
invalid colors → `#888888`, empty name → "anonymous". Local edits of one command → one merged update frame.

history.ts behaviours, tested with two/three `CollabEditor`s through an in-process relay server
(`crates/collab/tests/editor.rs`): local-only undo with interleaved remote edits; selection restore mapped through
remote edits (typed text: caret back; deleted selection: re-selected); a group continues across remote edits;
undo after a remote delete of part of the group (rest removed, redo restores what's left); remote text inserted
inside an undone group stays; redo after remote edits (caret after redone text); new local edit clears redo,
remote edits don't; conversion marks (literal lines) survive remote edits elsewhere and are dropped when the line
changes remotely. Convergence fuzz: 300 seeds × 250 steps, 2–3 editors, random typing (incl. auto-conversions,
emoji), deletes, selections, paste, Tab, undo/redo, random interleaving of deliveries and reconnects that lose
in-flight frames, then everyone undoes everything: all editors == server, editor text == yrs text after every frame.
Interop: `bun docs/rust-engine/yrs-interop.mjs` (the example client now runs on `CollabEditor`): all checks pass.

## Gaps vs the TS editor

- Undo is editor-core's OT history, not Y.UndoManager items: equivalent in all tested cases, but undo/redo
  re-insert *new* items, so remote carets that sat inside the undone text don't come back with it, and exotic
  concurrent cases may differ from Yjs's item-level result (both converge).
- `Editor::with_store` normalizes CRLF/CR to LF; on initial sync a note containing `\r` is rewritten as a local
  edit (sent to everyone, committed). The TS editor keeps `\r`. Fix if it matters: normalize in the server or
  give editor-core a no-normalize constructor.
- A remote edit splitting a UTF-16 surrogate pair (only possible from a buggy peer) is clamped by
  `apply_remote`, so the mirror would differ from yrs; `is_consistent()` detects it (no automatic rebuild).
- yrs 0.28 bug: updates from one peer applied out of order don't always integrate when the gap fills
  (`tests/pending.rs`, ignored). Unreachable over our FIFO WebSocket (the server relays in order). Also A4's
  `follow_redone` bug is irrelevant now (no yrs UndoManager).
- Not ported (shell work for C2): the remote cursor label fade/hover (cursors.ts UI), toast texts, participants
  rendering, `setPresence` wiring to DOM focus.

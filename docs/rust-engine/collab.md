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
fn take_outgoing_at(&mut self, now_ms: f64, sel_utf16: Option<(u32, u32)>) -> Outgoing  // (RC) caller has the UTF-16 selection
fn receive(&mut self, frame: &[u8], now_ms: f64) -> Result<Received, String>   // every binary frame; (RC) now_ms: same clock
    Received { outgoing: Vec<Vec<u8>>,                       // send these now
               edits: Vec<(Range<usize>, String)>,           // remote edits applied (bytes, sequential)
               edits_utf16: Vec<collab::Edit>,               // same, UTF-16 {from,to,insert}
               reloaded: bool,                               // editor rebuilt at initial sync → render_all
               awareness: bool,                              // remote presence changed → redraw cursors/participants
               notices: Vec<Notice> }
    Notice::{ Hello{read_only, msg}, Synced, ReadOnly(bool), SaveState(Value), External(Option<String>), Reset }
fn set_focused(&mut self, focused: bool, now_ms: f64) -> Vec<Vec<u8>>   // focus/blur: cursor shown only while focused
fn frames_lost(&mut self)                       // (RC) the shell couldn't send what it got (socket closing): edits unsent
fn set_local_read_only(&mut self, ro: bool)     // (RC) read-only on top of the room's (a view mounted read-only)
fn remote_cursors(&self) -> Vec<PeerCursor>   // {client, user_id, name, color, anchor_utf16, head_utf16, key} (RC: no bytes)
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
change or read-only with unsent edits → `Reset`. (RC, stricter than provider.ts:) local edits go out as updates only
after the server's step1 of the connection is answered (once, in the step2); edits still pending in the store, made
before that, or in frames the shell reports lost count as unsent; a read-only connection whose server state vector
lacks some of our items resets too; a remote removal of our presence is answered with a re-announce; close codes 4401/4403/4404/4413 final, 4000 / `closed` control →
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
- ~~`Editor::with_store` normalizes CRLF/CR to LF~~ — fixed by RA (laptop 9d9b2c5): editor-core keeps `\r` like
  the TS parser, so a note containing `\r` is no longer rewritten on load.
- A remote edit splitting a UTF-16 surrogate pair (only possible from a buggy peer): yrs moves it past the pair;
  `apply_changes` rounds offsets inside a pair up the same way (RC; 300 JS-made updates at random offsets in
  `tests/fixtures/js_surrogates.txt` stay consistent without a rebuild). Note the JS side shows such a split as
  two U+FFFD, yrs keeps the pair: the texts differ for that character, both stay internally consistent.
- An embed in "md" (a misbehaving peer) shows as U+FFFC in the editor (RC): `YrsStore::text()` and the remote edits
  agree, so offsets match yrs's.
- yrs 0.28 bug: updates from one peer applied out of order don't always integrate when the gap fills
  (`tests/pending.rs`, ignored). It is reachable (a broadcast can overtake our step2 after a reconnect), so (RC)
  `Session` holds back an update whose client clocks jump past ours until the gap is filled. Also A4's
  `follow_redone` bug is irrelevant now (no yrs UndoManager).
- (RC) yrs trusts its input: crafted updates can panic it (divisions by zero, unwraps, overflows), which in the
  browser's panic=abort build kills the engine. `collab::validate` rejects what our docs never contain (other roots,
  nested types, map keys, zero-length or skip blocks, a client listed twice, huge clocks, empty delete ranges)
  before yrs sees an update; with that and the held updates, 300k crafted updates (`crafted_updates_never_panic`,
  `FUZZ_N`) and random/truncated frames don't panic. If something still does, the web shell falls back to the TS
  editor with our edits (`recover_local_updates`, a log kept outside the store).
- ~~Not ported (shell work for C2): the remote cursor label fade/hover (cursors.ts UI), toast texts, participants
  rendering, `setPresence` wiring to DOM focus.~~ — done in C2 (web `src/client/editor-rs/collab.ts` RustCollab +
  view.ts collab mode; cursors.ts draws `Engine.remote_cursors()`; main.ts Session uses the same events as
  GrimoireProvider). C2 also added `CollabEditor::rebuild()` (called by `receive` when `is_consistent()` fails;
  in practice yrs moves an edit that would split a surrogate pair past it, so it hasn't been seen to trigger).

## C2: in the browser

`Engine.collab(clientId, user)` (editor-wasm) wraps `CollabEditor`; see the editor-wasm README "Collab mode" and
PLAN.md contract 4. `?engine=rust` notes: `Session` (main.ts) loads the wasm, then `RustCollab` (one WebSocket,
frames from/to the engine, retry timer, wake timer, `online`), mounts `mountRustEditor(host, { collab })` on
`synced`; a read-only change remounts the view over the same engine; `reset` reopens the note (new engine, like
the TS path). If the wasm can't load, the session falls back to GrimoireProvider + the TS editor. The JS Yjs
mirror (A3) stays for local docs only (home page examples, run.mjs/parity harnesses). Tests: `cargo test -p
editor-wasm` (collab_tests.rs), `bun test test/editor/rs/collab.test.ts`, `ENGINE=rust COLLAB=1
test/editor/browser/run.mjs` (in-page room, test/editor/browser/room.ts), `ENGINE=rust|ts+rust|rust+ts
test/e2e/two-users.mjs`, `test/e2e/rust-collab.mjs` (offline merge, generation reset, read-only, agent edit +
cursor, CRLF byte-identical).

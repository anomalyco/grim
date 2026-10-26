# yrs spike (A4): the Rust side as a Grimoire multiplayer client

Code: laptop `~/projects/grimoire-native/crates/collab` (yrs 0.28.0, no extra features).
- `src/store.rs`: `YrsStore`: yrs `Doc` + `Text` "md" (UTF-16 offsets), local/remote origins, remote and
  undo changes as edits, outgoing updates, UndoManager with explicit groups and selection metadata.
- `src/protocol.rs`: `Session`: Grimoire's WebSocket protocol as a sans-IO state machine (bytes in → events,
  frames out). The same code can sit behind tungstenite (native) or a browser `WebSocket` (wasm, C2).
- `examples/grimoire_client.rs`: a scriptable client over blocking tungstenite (dev login, JSON lines out,
  commands in).
- Tests: `cargo test -p collab` (7 pass; 1 `#[ignore]`d test shows the yrs bug below).
- Interop script (this box): `docs/rust-engine/yrs-interop.mjs`.

## Interop result: everything works

`bun docs/rust-engine/yrs-interop.mjs` starts a scratch server on this box (temp DATA_DIR, STORAGE=local,
ALLOW_DEV_LOGIN=1, HOST=0.0.0.0, port 8791), opens Chromium as Alice, and starts the Rust client on the laptop over
ssh, connecting to `http://100.73.96.98:8791`. All 21 checks pass:

- The Rust client signs in itself (`POST /auth/dev` with a same-origin `Origin` header → `np_session` cookie),
  opens `/ws?repo=notes&path=Welcome.md` (with `Cookie` + `Origin` headers) and syncs. Its text equals the server's.
- Browser typing → Rust gets remote edits. Rust edits → the browser shows them. Server text == Rust text throughout.
- Rust resolves Alice's cursor from her awareness state (Yjs `relativePositionToJSON` format) to her caret offset.
- **The Rust cursor shows in the browser**: an `.rcaret` with the label "Rusty" (the server replaces `user` with the
  signed-in account), on the right line. Screenshot: caret drawn just after "From Rust! ".
- Concurrent inserts at the same spot (Rust stops reading the socket, both insert at the start of line 3, Rust
  resumes) converge to `[web][rust]` everywhere: Rust, server, browser.
- Rust undo after an interleaved browser edit removes only Rust's last group and keeps the browser's text. Redo brings
  it back. The browser sees both.
- The server commits the merged text to git ("Update Welcome.md"). When the Rust client leaves, it sends an awareness
  `null` and its caret disappears from the browser.
- Cleanup: the server stops, the temp dir is deleted, the ssh client exits.

## Protocol details (what C2 must do; all in `Session`)

- Frame = `varuint type` + payload. **0** = y-protocols sync (`0` step1 = state vector, `1` step2 = update,
  `2` update). **1** = awareness (`varbuf` holding `[n, (client varuint, clock varuint, json varstring)*]`).
  **2** = control JSON (`varstring`): server → client `hello {generation, readOnly, dirty, saving, commit, savedAt}`,
  `status`, `external {commit}`, `closed {reason, to?}`. Client → server: `{t:"flush"}`.
  **Type 2 clashes with y-sync's MSG_AUTH**, so `yrs::sync::Message::decode` / `DefaultProtocol` can't be used
  directly. `Session` decodes the type byte itself and uses yrs's `SyncMessage` and `AwarenessUpdate` encoders.
- Order: the server sends `hello`, then its step1 (and current awareness states). Like provider.ts, the client
  ignores everything before `hello`. On `hello` it sends its step1 and (re)announces its awareness state with a
  bumped clock. It answers the server's step1 with step2 (diff), except when read-only. The server's step2 = synced.
  After that, each local transaction becomes one sync `update` frame.
- Edits made before `hello` (offline) travel in the step2 reply. While read-only, nothing is sent.
- Auth: the cookie `np_session` + an `Origin` equal to the server's origin (`sameOrigin`). Close codes 4401, 4403,
  4404 and 4413 are final; 1013 means retry.
- Awareness state: `{ user: {id,name,color,kind}, cursor: {anchor, head} | null }`. anchor/head = yrs `StickyIndex`
  serde JSON, which is the same as Yjs's `relativePositionToJSON` (`{item:{client,clock},assoc}` or
  `{tname:"md",assoc}`; JS's explicit `null` fields are accepted). The server overwrites `user`, so the name and
  color come from the account. The browser hides cursors with the same user id as its own (same person, other
  tab).
- **Client ids must be < 2^32**: the server drops awareness entries from ids ≥ 2^32 (reserved for agents). yrs
  generates 53-bit ids by default, so `YrsStore::new(client_id: u32)` takes one explicitly.
- Not done in the spike (C2 should port it from provider.ts): reconnect with backoff, `generation` change → throw
  away the doc and start over (`reset`), read-only with unsent edits → reset, and removing remote awareness
  states on disconnect.

## YrsStore API (as built)

```rust
YrsStore::new(client_id: u32)                  // Doc{offset_kind: Utf16} + Text "md" + UndoManager
text() -> String; len() -> u32 (UTF-16)
replace(from, to, &str); apply_local(&[Edit])  // one transaction, origin "local" (undoable)
apply_remote_update(&[u8])                     // origin "remote": not undoable, not echoed back
state_vector(); diff(&StateVector) -> Vec<u8>
take_changes() -> Vec<Change{kind: Remote|Undo|Redo, edits: Vec<Edit{from,to,insert}>}>  // sequential UTF-16 edits from the text delta
take_updates() -> Vec<Vec<u8>>                 // local + undo/redo updates to send
sticky(pos, Assoc) / resolve(&StickyIndex); sel_rel(a, h) / resolve_sel(&SelRel)   // view.ts toRel/fromRel rules
will_edit(a, h, kind); did_edit(a, h)          // selection before / after an edit → undo item meta
stop_capturing(); undo() / redo() -> Option<UndoResult{edits, sel}>; can_undo/can_redo; undo_depth()
```

Edits from a text delta are sequential: each edit's offsets refer to the text after the edits before it, which is
the same as contract 4's `Edit[]` and A1's `Editor::apply_remote` byte ranges. A delete and an insert at the same
spot merge into one replace.

## UndoManager mapping (history.ts → yrs)

| history.ts / Y.UndoManager | yrs 0.28 |
|---|---|
| `trackedOrigins: {origin}` | `Options.tracked_origins = {Origin::from("local")}` |
| `captureTimeout: MAX_SAFE_INTEGER`, `stopCapturing()` | `capture_timeout_millis: u64::MAX`, a **constant non-zero clock** (`timestamp: Arc::new(\|\| 1)`; `last_change == 0` means "boundary"), `reset()` = stop capturing. This also keeps it free of `SystemTime` (wasm) |
| `stack-item-added/updated/popped` + `meta` Map | `observe_item_added/updated/popped(key, FnMut(&TransactionMut, &mut Event<M>))`, typed `M: Default` meta (`UndoMeta {before, after, kind}`) |
| meta written after the edit (`after` = current selection) | stack items' meta can only be changed inside observers, so `after` is an `Rc<RefCell<Option<SelRel>>>` that the observer shares with the store; `did_edit` fills it in after the transaction |
| pop: preset `selBefore`/`afterNext` from the top item, because the inverse item is added before `popped` fires | same order in yrs: `pop()` peeks `undo_stack().last().meta()` and presets them |
| `tr.origin === um` (undo/redo transactions) | `txn.origin() == Some(&um.as_origin())`. The text observer doesn't say undo vs redo, so the store sets a flag during `pop` |
| `um.undoStack.length` (marks' depth) | `undo_stack().len()` / `redo_stack().len()`, so marks port 1:1 |
| `deleteFilter` | not supported (commented out in yrs). We don't use it |
| new local edit clears redo | same (tested) |

Tested: groups built from several transactions, undo after a remote insert before the text (offsets and restored
selection mapped), remote edits never undone, redo after a remote delete, undo/redo updates reach the other peer as
ordinary edits.

**yrs bug found:** `Store::follow_redone` drops the offset inside the redone block (Yjs's `followRedone` keeps it
as `diff`). So after a redo, a sticky index into the middle of re-inserted text resolves to the start of that text,
and redo restores the caret after "f" instead of after "foo". It's a one-line fix, verified on a patched copy:
`next_id = slice.ptr.redone.map(|r| ID::new(r.client, r.clock + slice.start))`. Until it lands upstream:
`[patch.crates-io]` with a vendored yrs, or restore redo selections from the redo's edits. Remote carets inside
redone text have the same bug.

## C1 recommendation: YrsStore behind A1's TextStore

A1's trait: `text() -> &str`, `replace(Range<usize>, &str)` (byte offsets), `replace_remote(..)` (default =
replace). `Editor::apply_remote(&[(Range<usize>, String)])` maps the selection and rebases editor-core's own
`History`. Shape for C1 (feature `collab` in editor-core, or an adapter in `crates/collab` that depends on
editor-core):

```rust
pub struct CollabStore { yrs: YrsStore, mirror: String }      // mirror = the text the editor sees (bytes)
impl TextStore for CollabStore {
    fn text(&self) -> &str { &self.mirror }
    fn replace(&mut self, r: Range<usize>, s: &str) {          // local: into yrs (origin local) + mirror
        let (a, b) = (byte_to_utf16(&self.mirror, r.start), byte_to_utf16(&self.mirror, r.end));
        self.yrs.replace(a, b, s);
        self.mirror.replace_range(r, s);
    }
    fn replace_remote(&mut self, r: Range<usize>, s: &str) { self.mirror.replace_range(r, s) } // yrs has it already
}
// After Session::receive: take_changes() (UTF-16, sequential) → convert each edit to bytes against a scratch copy
// of the mirror, applying as you go → editor.apply_remote(byte_edits) → the store's replace_remote keeps the mirror in step.
```

**Undo: two options. Coordinator to choose (see Open questions):**
1. **editor-core's History** (already rebased through remote edits by A1). Undo produces ordinary local ops, so
   `replace` sends them to yrs and no yrs UndoManager is needed. Native and web share one undo implementation with
   marks. Downsides: not Yjs's item-level semantics. Remote carets in text that undo restores don't come back with
   it, and the result can differ from the TS editor in rare concurrent cases. It also avoids the yrs bug.
2. **yrs UndoManager** (this spike, exact Y.UndoManager parity with the TS editor). editor-core's History must be
   swappable (trait or enum), and undo/redo return `UndoResult` edits that the editor applies like remote edits
   (with the restored selection). Needs the yrs patch above for exact caret restore after redo.
   Recommended if the parity rig must match the TS editor exactly. Otherwise 1 is simpler.

Either way, `stop_capturing` maps to `History::stop()`, which the editor already calls at the same points.

Performance note: `byte_to_utf16` is O(n) per edit. Fine for typing, but for big docs and bulk remote edits a line
index helps. `YrsStore::text()` builds a new String, so keep the mirror and don't call it per keystroke.

## wasm32-unknown-unknown: compiles, size

A temporary cdylib (deleted after) that calls YrsStore + Session (store, undo, sync, awareness, sticky JSON)
through `extern "C"` exports, release, `lto = true`, `codegen-units = 1`, `panic = "abort"`, `strip`, no wasm-opt
(not installed on the laptop):

| contents | opt-level | raw | gzip -9 |
|---|---|---|---|
| store + undo + protocol + awareness (+ serde_json) | `z` | 353 KB | 138 KB |
| same | `s` | 428 KB | 158 KB |
| store + undo only | `z` | 297 KB | 116 KB |

Inside editor-wasm the added size will be lower (std, alloc and serde are shared). wasm-opt -Oz typically takes off
another 10 to 15%. yrs APIs that aren't compiled for wasm (`Awareness::new`, `UndoManager::new`,
`undo::Options::default`, `SystemClock`) are avoided: the spike uses `Awareness::with_clock` and
`UndoManager::with_options` with its own clock.

## Risks

- **Client id on wasm:** yrs's `ClientID::random()` / `Doc::new()` use fastrand, which may not be seeded on
  wasm32-unknown-unknown (could be the same id in every tab, which corrupts the doc). Always pass a random u32 from
  `crypto.getRandomValues`.
- yrs 0.28 `follow_redone` bug (above). yrs's API changes a lot between minor versions (0.28: `ClientID` newtype,
  observers keyed by origin and no longer returning `Subscription`). Pin the version.
- yrs's `sync` feature makes observers `Send + Sync`. The store uses `Rc<RefCell>` closures, so keep it off (it is
  also unnecessary in wasm).
- `undo_blocking`/`redo_blocking` deadlock if a transaction is open. Never call them from inside an observer.
- Browser-side parity details still to port in C2: hiding cursors of the same user, presence only while focused
  (`setPresence`), the publish throttle, generation reset, and reconnect.
- The editor must apply the conversion of remote UTF-16 edits to byte ranges sequentially, and clamp offsets that
  land inside a surrogate pair (A1's `apply_remote` already clamps with `floor_boundary`).

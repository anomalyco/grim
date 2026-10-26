# Phase C review findings

Fixed by RC (see PLAN.md board/log).

1. **HIGH** `collab.ts:118/173/222` — on "reset"/"closed" `stopped=true` is set before emitting, so `destroy()` returns
   early and never frees the Engine, clears the wake timer, or removes the `online` listener. Use a separate
   destroyed flag; always clean up.
2. **HIGH** `protocol.rs:210,235-240,270-285` + `collab.ts:261-265` — unsent/pre-sync races: offline edits +
   receive(hello) before take_outgoing: `unsent` false (updates still in YrsStore) → read-only hello skips Reset and
   drops edits; writable hello sends them in SyncStep2 AND again as Update. Edits after hello before SyncStep1, or
   while ws CLOSING/CLOSED, drain updates without setting unsent. Treat pending store updates as unsent; only emit
   Update after answering SyncStep1; drain take_updates() when encoding SyncStep2(diff). Never lose edits made while
   the socket is closing (requeue).
3. **HIGH** — panic=abort: malformed frames can panic inside yrs 0.28 (e.g. `BlockSet::find_index` divide-by-zero on
   crafted updates) → WebAssembly RuntimeError "unreachable"; the cached instance (engine.ts `loading`) stays
   poisoned. Catch RuntimeError in RustCollab/RustEditorView, evict the cached module/instance, and fall back to the
   TS editor + GrimoireProvider for that session (keep the user's unsent text: re-open via TS provider; report a
   toast). Also consider validating/decoding updates defensively before applying (yrs decode errors → Result not
   panic) where cheap, and add a fuzz test feeding random/truncated frames to `CollabEditor::receive` (native)
   asserting no panic — fix panics you can in our code.
4. **MEDIUM** `protocol.rs:163-164,223,255,292-315` — stale `self.now` in receive: duplicate hello awareness
   broadcast; peer cursor `updated` stamped up to 15 s in the past → peers expire early. Pass `now_ms` into receive
   (and the wasm `receive(frame, now)`; update contract 4 + editor-wasm README + shell).
5. **MEDIUM** `store.rs:390-416`, `editor.rs:336-358` — non-string embeds in Text("md") inserted as U+FFFC in editor
   but skipped by get_string → rebuild + offset desync; JS peer inserting inside a surrogate pair: yrs rounds up, our
   utf16_to_byte rounds down → rebuild wipes undo. Skip embeds consistently; align surrogate rounding with yrs.
6. **MEDIUM** `view.ts:150-157,195,371-376,600-620` — reload()/remount during IME composition leaves DOM blank or
   `v.composing` stuck. Reset composing in renderAll()/destroy() (end composition on the engine).
7. **MEDIUM** `protocol.rs:95-101` — remote removal of our awareness state not re-announced; `entry.clock+1`
   overflow. saturating_add + re-announce.
8. **MEDIUM** — initial sync parses/renders the whole doc twice (apply_remote then rebuild on Synced; receive_rs
   serializes a full render patch that collab.ts discards). Skip apply_changes when Synced rebuilds in the same
   frame; don't serialize a full patch nobody uses.
9. **MEDIUM** `lib.rs:929-934,1058-1063`, `editor.rs:146-162` — multi-site edits collapse into one whole-doc span via
   text_edit(); feed the sequential edits (r.edits_utf16 / applied Ops) into snap.edit and PatchJs.edits; keep dirty
   ranges per edit.
10. **LOW** — redundant O(N) prefix scans (sel_utf16 twice per command; `CollabStore::replace` scans start and end
    from 0; apply_changes clones doc; remote_cursors_rs parses peer JSON twice and computes unused byte offsets).
    Optimize (use snap checkpoints, relative end offsets, single parse).
11. **LOW** `view.ts:86,113-122`, `input.ts:161-169` — opts.readOnly not enforced in collab mode
    (`Engine::set_read_only` no-op for collab). Make set_read_only work for CollabEditor and check in onKeyDown.
12. **LOW** `editor.rs:178-183` — reset() keeps focused=true with session.cursor None → announces cursor null then
    (0,0). Initialize cursor on reset when focused.

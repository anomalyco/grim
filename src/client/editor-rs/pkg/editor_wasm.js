/* @ts-self-types="./editor_wasm.d.ts" */

export class Engine {
    static __wrap(ptr) {
        const obj = Object.create(Engine.prototype);
        obj.__wbg_ptr = ptr;
        EngineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engine_free(ptr, 0);
    }
    /**
     * Forgets a composition without changing the text (the view that showed it was rebuilt or went away).
     */
    abort_composition() {
        wasm.engine_abort_composition(this.__wbg_ptr);
    }
    /**
     * Remote text edits (UTF-16, applied in order). The patch has no `edits` (they aren't local). Plain engines
     * only: a collab engine gets remote edits through `receive` (this changes nothing there).
     * @param {Edit[]} edits
     * @returns {Patch}
     */
    apply_remote(edits) {
        const ret = wasm.engine_apply_remote(this.__wbg_ptr, addHeapObject(edits));
        return takeObject(ret);
    }
    /**
     * The awareness timing in force, `[renew_ms, timeout_ms]` (a plain engine: the v1 defaults).
     * @returns {Float64Array}
     */
    awareness_timing() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.engine_awareness_timing(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    begin_composition() {
        wasm.engine_begin_composition(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    client_id() {
        const ret = wasm.engine_client_id(this.__wbg_ptr);
        return ret;
    }
    /**
     * An engine on the shared document of a Grimoire room. `client_id`: random per session, below 2^32
     * (`crypto.getRandomValues`); `user`: our presence user `{id, name, color, kind}`. The document is empty
     * until the server's state arrives through `receive`. Every command works as for a plain engine; call
     * `take_outgoing` after each one and send the frames.
     * @param {number} client_id
     * @param {object} user
     * @returns {Engine}
     */
    static collab(client_id, user) {
        const ret = wasm.engine_collab(client_id, addHeapObject(user));
        return Engine.__wrap(ret);
    }
    /**
     * About to open a socket (status → connecting).
     */
    connecting() {
        wasm.engine_connecting(this.__wbg_ptr);
    }
    /**
     * @returns {string}
     */
    copy() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.engine_copy(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {CutResult}
     */
    cut() {
        const ret = wasm.engine_cut(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * The socket closed: `{retry: ms}` (reconnect then) or `{closed: reason, to}` (the session ended:
     * deleted, renamed (`to`), removed, unauthorized, forbidden, notfound, toolarge, …).
     * @param {number} code
     * @param {string} reason
     * @returns {AfterClose}
     */
    disconnected(code, reason) {
        const ptr0 = passStringToWasm0(reason, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_disconnected(this.__wbg_ptr, code, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Ends a composition that had no commit (cancelled): a selection it replaced is deleted (like
     * the TS editor), the undo group ends. After a commit (`insert_text`) it changes nothing.
     * @returns {Patch}
     */
    end_composition() {
        const ret = wasm.engine_end_composition(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * A link's pencil: expand the link at `pos` (UTF-16; anywhere in its source), its brackets and URL shown
     * as editable text, the caret at the end of its text. It collapses when the selection leaves it.
     * @param {number} pos
     * @returns {Patch}
     */
    expand_link(pos) {
        const ret = wasm.engine_expand_link(this.__wbg_ptr, pos);
        return takeObject(ret);
    }
    /**
     * The fold commands of the key map: "toggle" (Cmd-'), "fold" / "unfold" at the caret (Cmd-Option-[ / ]),
     * "foldAll" / "unfoldAll".
     * @param {string} which
     * @returns {Patch}
     */
    fold_command(which) {
        const ptr0 = passStringToWasm0(which, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_fold_command(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * The folded headings as `[heading line text, occurrence among equal heading lines]` pairs (to persist).
     * @returns {[string, number][]}
     */
    fold_keys() {
        const ret = wasm.engine_fold_keys(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Frames from `take_outgoing` / `receive` / `set_focused` couldn't be sent (the socket was closing): the
     * edits in them count as unsent (they go out with the next connection's step2).
     */
    frames_lost() {
        wasm.engine_frames_lost(this.__wbg_ptr);
    }
    /**
     * Typed text, or the IME commit while composing.
     * @param {string} s
     * @returns {Patch}
     */
    insert_text(s) {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_insert_text(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * @returns {boolean}
     */
    is_collab() {
        const ret = wasm.engine_is_collab(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * The editor's text equals the shared document's (`receive` rebuilds the editor when it doesn't).
     * @returns {boolean}
     */
    is_consistent() {
        const ret = wasm.engine_is_consistent(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * A key press through editor-core's key map; `undefined` when the key isn't the editor's.
     * @param {string} key
     * @param {number} mods
     * @param {JsLayout} layout
     * @returns {Patch | undefined}
     */
    key(key, mods, layout) {
        try {
            const ptr0 = passStringToWasm0(key, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.engine_key(this.__wbg_ptr, ptr0, len0, mods, addBorrowedObject(layout));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * Announce that we leave (send these, then close the socket).
     * @returns {Uint8Array[]}
     */
    leave() {
        const ret = wasm.engine_leave(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} clicks
     * @param {boolean} shift
     * @param {JsLayout} layout
     * @returns {Patch}
     */
    mouse_down(x, y, clicks, shift, layout) {
        try {
            const ret = wasm.engine_mouse_down(this.__wbg_ptr, x, y, clicks, shift, addBorrowedObject(layout));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {JsLayout} layout
     * @returns {Patch}
     */
    mouse_drag(x, y, layout) {
        try {
            const ret = wasm.engine_mouse_drag(this.__wbg_ptr, x, y, addBorrowedObject(layout));
            return takeObject(ret);
        } finally {
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * @param {string} text
     */
    constructor(text) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_new(ptr0, len0);
        this.__wbg_ptr = ret;
        EngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * The browser went online: true = a retry is pending, reconnect now.
     * @returns {boolean}
     */
    online() {
        const ret = wasm.engine_online(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {string} text
     * @returns {Patch}
     */
    paste(text) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_paste(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Other clients' presence states `{user, cursor}` (participants list).
     * @returns {Peer[]}
     */
    peers() {
        const ret = wasm.engine_peers(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * With profiling on: milliseconds spent in the last command as `[engine, serialization, edit, render, diff,
     * conversion]` (engine = edit + render + diff + conversion: everything before the patch becomes JS objects).
     * @returns {Float64Array | undefined}
     */
    profile() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.engine_profile(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF64FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 8, 8);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {boolean}
     */
    read_only() {
        const ret = wasm.engine_read_only(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Feed one binary frame from the server. Send `frames`, apply `patch`, act on `notices`. `now_ms`: the
     * same clock as `take_outgoing`'s (`performance.now()`).
     * @param {Uint8Array} frame
     * @param {number} now_ms
     * @returns {Received}
     */
    receive(frame, now_ms) {
        const ptr0 = passArray8ToWasm0(frame, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_receive(this.__wbg_ptr, ptr0, len0, now_ms);
        return takeObject(ret);
    }
    /**
     * Every local edit of the collab engine with `client_id` this session, as one Yjs v1 update (undefined:
     * none, or no such engine). Readable even after that engine trapped (a panic): the app hands it to the
     * TS editor that takes over.
     * @param {number} client_id
     * @returns {Uint8Array | undefined}
     */
    static recover_unsent(client_id) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.engine_recover_unsent(retptr, client_id);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayU8FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Patch}
     */
    redo() {
        const ret = wasm.engine_redo(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Other participants' carets/selections to draw (not our own user's from other tabs), UTF-16.
     * @returns {PeerCursor[]}
     */
    remote_cursors() {
        const ret = wasm.engine_remote_cursors(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Full render: replaces every line the front end has (fresh keys).
     * @returns {Patch}
     */
    render_all() {
        const ret = wasm.engine_render_all(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Replace `from..to` (UTF-16) with `text` as one edit (spelling correction, `insertReplacementText`), without
     * typing rules.
     * @param {number} from
     * @param {number} to
     * @param {string} text
     * @returns {Patch}
     */
    replace_range(from, to, text) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_replace_range(this.__wbg_ptr, from, to, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Ask the server to commit now.
     * @returns {Uint8Array[]}
     */
    request_flush() {
        const ret = wasm.engine_request_flush(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * After a `reset` notice: a fresh, empty document with a new client id (then connect again). Returns
     * the full render of the empty document.
     * @param {number} client_id
     * @returns {Patch}
     */
    reset(client_id) {
        const ret = wasm.engine_reset(this.__wbg_ptr, client_id);
        return takeObject(ret);
    }
    /**
     * `{dirty, saving, commit, savedAt}` from the last hello / status (null before).
     * @returns {SaveState | null}
     */
    save_state() {
        const ret = wasm.engine_save_state(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * The awareness timing (ms) on a collab engine: renew our state after `renew_ms` without sending it, drop
     * remote states not renewed for `timeout_ms`. v1 (one socket per note): 15 s / 30 s, the default. On a v2
     * workspace socket: `welcome.renewMs` / `welcome.awarenessTimeoutMs` (5 min / 12 min), and a channel's
     * `{t:"renew", ms}` changes the renewal (pass the timeout again, or 0 to keep it). A value that isn't a positive
     * number keeps the current one; kept across `reset`. A plain engine ignores it.
     * @param {number} renew_ms
     * @param {number} timeout_ms
     */
    set_awareness_timing(renew_ms, timeout_ms) {
        wasm.engine_set_awareness_timing(this.__wbg_ptr, renew_ms, timeout_ms);
    }
    /**
     * Focus / blur: our cursor is shown to others only while the editor is focused.
     * @param {boolean} focused
     * @param {number} now_ms
     * @returns {Uint8Array[]}
     */
    set_focused(focused, now_ms) {
        const ret = wasm.engine_set_focused(this.__wbg_ptr, focused, now_ms);
        return takeObject(ret);
    }
    /**
     * Fold exactly the headings named by `keys` (from `fold_keys`; unknown ones are ignored).
     * @param {[string, number][]} keys
     * @returns {Patch}
     */
    set_fold_keys(keys) {
        const ret = wasm.engine_set_fold_keys(this.__wbg_ptr, addHeapObject(keys));
        return takeObject(ret);
    }
    /**
     * Time the parts of every command (with `performance.now()`), for `profile()`.
     * @param {boolean} on
     */
    set_profiling(on) {
        wasm.engine_set_profiling(this.__wbg_ptr, on);
    }
    /**
     * Read-only (no edits; selection, copy and remote edits still work). A collab engine is also read-only
     * while the room says so: this adds to that (false: follow the room).
     * @param {boolean} ro
     */
    set_read_only(ro) {
        wasm.engine_set_read_only(this.__wbg_ptr, ro);
    }
    /**
     * @param {number} anchor
     * @param {number} head
     * @returns {Patch}
     */
    set_selection(anchor, head) {
        const ret = wasm.engine_set_selection(this.__wbg_ptr, anchor, head);
        return takeObject(ret);
    }
    /**
     * "connecting" | "connected" | "disconnected" ("connected" for a plain engine).
     * @returns {string}
     */
    status() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.engine_status(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The server's state has arrived (the editor shows the note).
     * @returns {boolean}
     */
    synced() {
        const ret = wasm.engine_synced(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Frames to send after a command (local edits as one update, our cursor while focused, presence renewal),
     * and when to call again (`wakeInMs`). `now_ms`: `performance.now()`.
     * @param {number} now_ms
     * @returns {Outgoing}
     */
    take_outgoing(now_ms) {
        const ret = wasm.engine_take_outgoing(this.__wbg_ptr, now_ms);
        return takeObject(ret);
    }
    /**
     * @returns {string}
     */
    text() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.engine_text(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Fold / unfold heading line `line` (a click on its chevron or "…" pill). Folding is view state: no
     * text edit. A selection end the fold hides moves to the end of the heading line.
     * @param {number} line
     * @returns {Patch}
     */
    toggle_fold(line) {
        const ret = wasm.engine_toggle_fold(this.__wbg_ptr, line);
        return takeObject(ret);
    }
    /**
     * @param {number} line
     * @returns {Patch}
     */
    toggle_todo(line) {
        const ret = wasm.engine_toggle_todo(this.__wbg_ptr, line);
        return takeObject(ret);
    }
    /**
     * @returns {Patch}
     */
    undo() {
        const ret = wasm.engine_undo(this.__wbg_ptr);
        return takeObject(ret);
    }
}
if (Symbol.dispose) Engine.prototype[Symbol.dispose] = Engine.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_Number_14af1003b8dd5ead: function(arg0) {
            const ret = Number(getObject(arg0));
            return ret;
        },
        __wbg___wbindgen_bigint_get_as_i64_a2383202b9353e4c: function(arg0, arg1) {
            const v = getObject(arg1);
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_5b446f51afd21013: function(arg0) {
            const v = getObject(arg0);
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_4687d8d8c2017d52: function(arg0, arg1) {
            const ret = debugString(getObject(arg1));
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_92f62ee1427d9e49: function(arg0, arg1) {
            const ret = getObject(arg0) in getObject(arg1);
            return ret;
        },
        __wbg___wbindgen_is_bigint_b123553bed3bb382: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_1f9d30630b8b1d3d: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_e343b7d08827ba72: function(arg0) {
            const ret = getObject(arg0) === null;
            return ret;
        },
        __wbg___wbindgen_is_object_3c45d4f2dde4e749: function(arg0) {
            const val = getObject(arg0);
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_90b56bc79aad6f6c: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
            const ret = getObject(arg0) === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_02babf21faa37971: function(arg0, arg1) {
            const ret = getObject(arg0) === getObject(arg1);
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_677f21e468d6b461: function(arg0, arg1) {
            const ret = getObject(arg0) == getObject(arg1);
            return ret;
        },
        __wbg___wbindgen_number_get_2e0e7dee9f701a71: function(arg0, arg1) {
            const obj = getObject(arg1);
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = getObject(arg1);
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_adjacent_line_y_9163b87268112d0e: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = getObject(arg0).adjacent_line_y(arg1, arg2);
            return addHeapObject(ret);
        }, arguments); },
        __wbg_bounds_0b4273956b94e0e4: function() { return handleError(function (arg0) {
            const ret = getObject(arg0).bounds();
            return addHeapObject(ret);
        }, arguments); },
        __wbg_call_6137034ef55c9d0f: function() { return handleError(function (arg0, arg1) {
            const ret = getObject(arg0).call(getObject(arg1));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_caret_rect_64d9b40cbdec0a93: function() { return handleError(function (arg0, arg1) {
            const ret = getObject(arg0).caret_rect(arg1);
            return addHeapObject(ret);
        }, arguments); },
        __wbg_done_b41a1d26cdb37fb6: function(arg0) {
            const ret = getObject(arg0).done;
            return ret;
        },
        __wbg_entries_fb6397112b1de25f: function(arg0) {
            const ret = Object.entries(getObject(arg0));
            return addHeapObject(ret);
        },
        __wbg_from_296ca31f8d0f1c52: function(arg0) {
            const ret = Array.from(getObject(arg0));
            return addHeapObject(ret);
        },
        __wbg_getRandomValues_436a51d0629d84e1: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_get_658f6698067d9515: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(getObject(arg0), getObject(arg1));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_get_6c896e0571ddae51: function(arg0, arg1) {
            const ret = getObject(arg0)[arg1 >>> 0];
            return addHeapObject(ret);
        },
        __wbg_get_unchecked_288889d017702237: function(arg0, arg1) {
            const ret = getObject(arg0)[arg1 >>> 0];
            return addHeapObject(ret);
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = getObject(arg0)[getObject(arg1)];
            return addHeapObject(ret);
        },
        __wbg_hit_test_dd241daa9864e9b8: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = getObject(arg0).hit_test(arg1, arg2);
            return addHeapObject(ret);
        }, arguments); },
        __wbg_image_at_84f63654c39e4daa: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = getObject(arg0).image_at(arg1, arg2);
            return addHeapObject(ret);
        }, arguments); },
        __wbg_instanceof_ArrayBuffer_a99f175873e5d9b8: function(arg0) {
            let result;
            try {
                result = getObject(arg0) instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Map_b2611749102d7ba3: function(arg0) {
            let result;
            try {
                result = getObject(arg0) instanceof Map;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_828cef2aaacafc31: function(arg0) {
            let result;
            try {
                result = getObject(arg0) instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_e15a2ff68ffdbef2: function(arg0) {
            const ret = Array.isArray(getObject(arg0));
            return ret;
        },
        __wbg_isSafeInteger_717808ad6a54bd9e: function(arg0) {
            const ret = Number.isSafeInteger(getObject(arg0));
            return ret;
        },
        __wbg_iterator_e3c31c892080e444: function() {
            const ret = Symbol.iterator;
            return addHeapObject(ret);
        },
        __wbg_length_7f3c00c40364105e: function(arg0) {
            const ret = getObject(arg0).length;
            return ret;
        },
        __wbg_length_d4bdea10311bd9cf: function(arg0) {
            const ret = getObject(arg0).length;
            return ret;
        },
        __wbg_line_mid_y_b0f8491be5475b1c: function() { return handleError(function (arg0, arg1) {
            const ret = getObject(arg0).line_mid_y(arg1);
            return addHeapObject(ret);
        }, arguments); },
        __wbg_new_1dbf7428bba60a42: function(arg0) {
            const ret = new Uint8Array(getObject(arg0));
            return addHeapObject(ret);
        },
        __wbg_new_28744009d011f847: function() {
            const ret = new Map();
            return addHeapObject(ret);
        },
        __wbg_new_617a8cdb8bb1130e: function() {
            const ret = new Object();
            return addHeapObject(ret);
        },
        __wbg_new_ee2291f50781bf1d: function() {
            const ret = new Array();
            return addHeapObject(ret);
        },
        __wbg_next_33784799010f1bbe: function(arg0) {
            const ret = getObject(arg0).next;
            return addHeapObject(ret);
        },
        __wbg_next_f4aac29c42af995c: function() { return handleError(function (arg0) {
            const ret = getObject(arg0).next();
            return addHeapObject(ret);
        }, arguments); },
        __wbg_now_2919f09cbb4807ce: function() {
            const ret = performance.now();
            return ret;
        },
        __wbg_prototypesetcall_bc27214492979395: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
        },
        __wbg_set_6ae97e73113c4f0b: function(arg0, arg1, arg2) {
            const ret = getObject(arg0).set(getObject(arg1), getObject(arg2));
            return addHeapObject(ret);
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
        },
        __wbg_set_bea140a88be9b277: function(arg0, arg1, arg2) {
            getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
        },
        __wbg_table_cell_at_f716b6cb4a723359: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = getObject(arg0).table_cell_at(arg1, arg2, arg3);
            return addHeapObject(ret);
        }, arguments); },
        __wbg_value_f3c585ee8f5ba40c: function(arg0) {
            const ret = getObject(arg0).value;
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000002: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000005: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_clone_ref: function(arg0) {
            const ret = getObject(arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./editor_wasm_bg.js": import0,
    };
}

const EngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engine_free(ptr, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function addBorrowedObject(obj) {
    if (stack_pointer == 1) throw new Error('out of js stack');
    heap[--stack_pointer] = obj;
    return stack_pointer;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export3(addHeapObject(e));
    }
}

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let stack_pointer = 1024;

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('editor_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

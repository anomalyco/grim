# Phase A review (Gemini) — findings to fix (task RA)

1. **High** — CRLF: `Editor::new` strips `\r` but ytext keeps it → UTF-16 offsets of every later Yjs delta/cursor shift (view.ts:102-136, editor.rs:68,207); `apply_remote` doesn't normalize. Fix: keep `\r` in the engine like TS `parseDoc` (preferred: shared text stays byte-identical), or normalize consistently on both sides. (Same as the C2 note.)
2. **High** — history.rs:161-181: after `map_remote` turns an item into a no-op, `undo()` pops past it and reads `sel_before`/`after_next`/`kind` from the wrong item, and can skip a conversion mark at a lower depth. Fix: take those from the item that actually mutates; don't pop past a depth with a valid mark.
3. **Medium** — collab store.rs:409-418 `utf16_to_byte` inside a surrogate pair rounds up (returns 4 for "😀",1); editor-core rounds down. Use `editor_core::text::utf16_to_byte`.
4. **Medium** — cancelled IME composition (`compositionend` data "") calls `engine.end_composition()` which only clears the glue's flag; `Editor.composing` stays set, `history.stop()` skipped, and a selection is removed via `cut()` (Paste kind). Fix: `Engine::end_composition` → `ed.end_composition("")`, or always `insert_text(data)` on compositionend.
5. **Medium** — input.ts:221-262 / editor.rs:593: a 1px pointer move after a click-past-hidden-markers or a double-click calls `mouse_drag` (raw hit) and wrecks the selection. Fix: drag only for single clicks and after a few px threshold.
6. **Medium** — `adjacent_line_y` returning None at the document edge is treated as "not implemented" → probes through the 40vh bottom padding and scrolls in hit_test. Fix: distinguish "edge" from "unsupported" (e.g. `Option<Option<f64>>` / enum); edge → jump to 0 / len.
7. **Medium** — editor.rs:562: a mousedown with detail 2/3 without a prior detail-1 at that spot (Playwright clickCount:2) selects at the old click_pos. Fix: hit-test when click_pos is None or the previous click wasn't recent/nearby.
8. **Medium** — input.ts:238-274: `pointerDown=true` set before the `.chip` (window.open) / `.tok-todo` early returns, mouseup never arrives → later focus skips writeDomSel. Set after the early returns; reset in onBlur.
9. **Medium** — insertReplacementText (spellcheck) does set_selection + insert_text (typing rules, split undo). Expose `Engine.replace_range(from,to,text)` (Editor::replace_range) and use it.
10. **Low** — view.ts:253-265 refreshChanged re-renders image lines without reusing loaded `<img>`s (collectImages).
11. **Low** — layout.ts:122-125 `image_at` skips unloaded `.imgbox` (height 0) on collapsed image lines → Up/Down onto an unloaded image line breaks; use the `.imgs` band.
12. **Low** — engine.ts:14-26 `loadWasmEngine` caches one promise regardless of `base`; key by base.

Also from A3: the CSP now allows `'wasm-unsafe-eval'` (src/server/index.ts) — reviewer raised no issue with it.

// Loads the wasm engine (crates/editor-wasm, built with wasm-bindgen --target web). `bun run build:client` copies
// src/client/editor-rs/pkg/editor_wasm.js and editor_wasm_bg.wasm to dist/editor-rs/; they're fetched only when
// the Rust engine is used.

import type { Engine, EngineFactory } from "./types.ts";

export const WASM_BASE = "/dist/editor-rs/";

interface WasmModule {
  default: (init?: { module_or_path: string | URL }) => Promise<unknown>;
  Engine: new (text: string) => Engine;
}

let loading: Promise<EngineFactory> | null = null;

export function loadWasmEngine(base = WASM_BASE): Promise<EngineFactory> {
  loading ??= (async () => {
    // a runtime URL, not bundled
    const url: string = base + "editor_wasm.js";
    const mod = (await import(/* @vite-ignore */ url)) as WasmModule;
    await mod.default({ module_or_path: base + "editor_wasm_bg.wasm" });
    return (text: string) => new mod.Engine(text);
  })();
  loading.catch(() => (loading = null));
  return loading;
}

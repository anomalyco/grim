// Loads the wasm engine (crates/editor-wasm, built with wasm-bindgen --target web). `bun run build:client` copies
// src/client/editor-rs/pkg/editor_wasm.js and editor_wasm_bg.wasm to dist/editor-rs/<content hash>/ (served
// immutable) and defines __WASM_HASH__; main.ts starts loading them at startup (preloadWasm) when the Rust engine
// is used, which is the default.

import type { CollabEngine, Engine, EngineFactory } from "./types.ts";
import type { CollabFactory } from "./collab.ts";

declare const __WASM_HASH__: string | undefined;

export const WASM_BASE = typeof __WASM_HASH__ === "string" && __WASM_HASH__ ? `/dist/editor-rs/${__WASM_HASH__}/` : "/dist/editor-rs/";

interface WasmModule {
  default: (init?: { module_or_path: string | URL | Response | Promise<Response> }) => Promise<unknown>;
  Engine: {
    new (text: string): Engine;
    collab(clientId: number, user: object): CollabEngine;
    recover_unsent(clientId: number): Uint8Array | undefined;
  };
}

/** One load per base URL (a failed load is retried on the next call). */
const loading = new Map<string, Promise<WasmModule>>();
/** Instances thrown away after a crash, per base: the next load imports a fresh copy of the module. */
const evicted = new Map<string, number>();

/**
 * Forget the loaded instance for `base` (it trapped: its state can't be trusted). Engines created later get a
 * new instance; the old one stays alive only as long as something still references it.
 */
export function evictWasm(base = WASM_BASE): void {
  loading.delete(base);
  plain.delete(base);
  evicted.set(base, (evicted.get(base) ?? 0) + 1);
}

function loadWasm(base: string): Promise<WasmModule> {
  let p = loading.get(base);
  if (!p) {
    p = (async () => {
      // a runtime URL, not bundled (after a crash: another URL, so the browser instantiates the module again)
      const n = evicted.get(base);
      const url: string = base + "editor_wasm.js" + (n ? `?instance=${n}` : "");
      // the .wasm downloads while the glue module loads
      const wasm = fetch(base + "editor_wasm_bg.wasm");
      wasm.catch(() => {});
      const mod = (await import(/* @vite-ignore */ url)) as WasmModule;
      await mod.default({ module_or_path: wasm });
      return mod;
    })();
    loading.set(base, p);
    p.catch(() => loading.delete(base));
  }
  return p;
}

const plain = new Map<string, Promise<EngineFactory>>();

/** Plain engines (a local text; the shell mirrors edits into a Y.Text itself). */
export function loadWasmEngine(base = WASM_BASE): Promise<EngineFactory> {
  let p = plain.get(base);
  if (!p) {
    p = loadWasm(base).then((mod) => (text: string) => new mod.Engine(text));
    plain.set(base, p);
    p.catch(() => plain.delete(base));
  }
  return p;
}

/** Collab engines (the engine owns a room's shared document and speaks its protocol). */
export async function loadCollabEngine(base = WASM_BASE): Promise<CollabFactory> {
  const mod = await loadWasm(base);
  return Object.assign((clientId: number, user: object) => mod.Engine.collab(clientId, user), {
    recover: (clientId: number) => mod.Engine.recover_unsent(clientId),
    evict: () => evictWasm(base),
  });
}

/** Start fetching and compiling the wasm now (in parallel with the app's API calls); failures surface on use. */
export function preloadWasm(base = WASM_BASE): void {
  loadWasm(base).catch(() => {});
}

/**
 * Which editor engine notes use: Rust by default; `?engine=ts` switches to the TS engine (kept for one release as
 * the fallback) and `?engine=rust` back. The choice is remembered.
 */
export function preferredEngine(): "rust" | "ts" {
  try {
    const q = new URLSearchParams(location.search).get("engine");
    if (q === "rust" || q === "ts") localStorage.setItem("grimoire.engine", q);
    return localStorage.getItem("grimoire.engine") === "ts" ? "ts" : "rust";
  } catch {
    return "rust";
  }
}

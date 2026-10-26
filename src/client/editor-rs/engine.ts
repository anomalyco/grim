// Loads the wasm engine (crates/editor-wasm, built with wasm-bindgen --target web). `bun run build:client` copies
// src/client/editor-rs/pkg/editor_wasm.js and editor_wasm_bg.wasm to dist/editor-rs/; they're fetched only when
// the Rust engine is used.

import type { CollabEngine, Engine, EngineFactory } from "./types.ts";
import type { CollabFactory } from "./collab.ts";

export const WASM_BASE = "/dist/editor-rs/";

interface WasmModule {
  default: (init?: { module_or_path: string | URL }) => Promise<unknown>;
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
      const mod = (await import(/* @vite-ignore */ url)) as WasmModule;
      await mod.default({ module_or_path: base + "editor_wasm_bg.wasm" });
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

/** Which editor engine notes use: `?engine=rust` / `?engine=ts` switches (and is remembered); TS by default. */
export function preferredEngine(): "rust" | "ts" {
  try {
    const q = new URLSearchParams(location.search).get("engine");
    if (q === "rust" || q === "ts") localStorage.setItem("grimoire.engine", q);
    return localStorage.getItem("grimoire.engine") === "rust" ? "rust" : "ts";
  } catch {
    return "ts";
  }
}

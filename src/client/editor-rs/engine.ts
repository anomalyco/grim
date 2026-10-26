// Loads the wasm engine (crates/editor-wasm, built with wasm-bindgen --target web). `bun run build:client` copies
// src/client/editor-rs/pkg/editor_wasm.js and editor_wasm_bg.wasm to dist/editor-rs/; they're fetched only when
// the Rust engine is used.

import type { CollabEngine, Engine, EngineFactory } from "./types.ts";
import type { CollabFactory } from "./collab.ts";

export const WASM_BASE = "/dist/editor-rs/";

interface WasmModule {
  default: (init?: { module_or_path: string | URL }) => Promise<unknown>;
  Engine: { new (text: string): Engine; collab(clientId: number, user: object): CollabEngine };
}

/** One load per base URL (a failed load is retried on the next call). */
const loading = new Map<string, Promise<WasmModule>>();

function loadWasm(base: string): Promise<WasmModule> {
  let p = loading.get(base);
  if (!p) {
    p = (async () => {
      // a runtime URL, not bundled
      const url: string = base + "editor_wasm.js";
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
  return (clientId: number, user: object) => mod.Engine.collab(clientId, user);
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

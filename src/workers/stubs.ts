// Stand-ins the Worker bundle uses (wrangler.jsonc "alias") for Bun-only modules that shared code still imports.
// Temporary: they go once rooms.ts stops defaulting to the Bun storage and config.ts stops importing node:fs.

/** rooms.ts's defaults (`opts.storage ?? bunRoomStorage()`, `opts.db ?? bunDb()`); the Worker always passes both. */
export function bunDb(): never {
  throw new Error("bunDb() is not available on Workers");
}

export function bunRoomStorage(): never {
  throw new Error("bunRoomStorage() is not available on Workers");
}

/** config.ts reads `<NAME>_FILE` secrets with it; on Workers secrets are plain environment bindings. */
export function readFileSync(file: string): never {
  throw new Error(`can't read ${file} on Workers: set the secret itself, not <NAME>_FILE`);
}

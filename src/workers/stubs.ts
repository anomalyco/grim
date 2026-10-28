// Stand-ins the Worker bundle uses (wrangler.jsonc "alias") for Bun-only modules that shared code still imports.
// Temporary: it goes once config.ts stops importing node:fs.

/** config.ts reads `<NAME>_FILE` secrets with it; on Workers secrets are plain environment bindings. */
export function readFileSync(file: string): never {
  throw new Error(`can't read ${file} on Workers: set the secret itself, not <NAME>_FILE`);
}

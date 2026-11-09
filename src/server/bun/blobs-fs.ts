import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore } from "../seams/blobs.ts";

/** Blobs as files under `root` ($DATA_DIR/blobs on Bun). Keys are "<workspace>/<sha256>" or "backups/…". */
export class FsBlobs implements BlobStore {
  constructor(private root: string) {}

  private file(key: string) {
    if (key.split("/").some((p) => !p || p === "." || p === "..")) throw new Error(`bad blob key: ${key}`);
    return join(this.root, key);
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.file(key)));
    } catch {
      return null;
    }
  }

  async put(key: string, bytes: Uint8Array) {
    const f = this.file(key);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, bytes);
  }

  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
}

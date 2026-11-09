import type { BlobStore } from "../seams/blobs.ts";

/** Blobs in memory: demo rooms (gone with the room) and tests. */
export class MemoryBlobs implements BlobStore {
  private map = new Map<string, Uint8Array<ArrayBuffer>>();

  async get(key: string) {
    return this.map.get(key) ?? null;
  }

  async put(key: string, bytes: Uint8Array) {
    this.map.set(key, new Uint8Array(bytes));
  }

  async delete(key: string) {
    this.map.delete(key);
  }
}

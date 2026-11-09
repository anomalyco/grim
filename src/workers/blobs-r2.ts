import type { BlobStore } from "../server/seams/blobs.ts";

/** Blobs in an R2 bucket (IMAGES): images at "<workspace>/<sha256>", nightly exports at "backups/<workspace>/<date>.zip". */
export class R2Blobs implements BlobStore {
  constructor(private bucket: R2Bucket) {}

  async get(key: string) {
    const o = await this.bucket.get(key);
    return o ? new Uint8Array(await o.arrayBuffer()) : null;
  }

  async put(key: string, bytes: Uint8Array, type?: string) {
    await this.bucket.put(key, bytes, type ? { httpMetadata: { contentType: type } } : undefined);
  }

  async delete(key: string) {
    await this.bucket.delete(key);
  }
}

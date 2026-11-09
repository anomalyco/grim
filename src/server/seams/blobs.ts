/** Content-addressed bytes (images, backups): R2 on Workers (src/workers/blobs-r2.ts), files on Bun (bun/blobs-fs.ts),
 * memory for demo rooms and tests (notes/blobs-memory.ts). */
export interface BlobStore {
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  put(key: string, bytes: Uint8Array, type?: string): Promise<void>;
  delete(key: string): Promise<void>;
}

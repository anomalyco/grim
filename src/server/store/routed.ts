// The server's store: a few repos live in their own store (the demo folder in a MemoryStore), everything else in
// the configured one (Code Storage or local Git). The rest of the server only sees this one GitStore.
import type { BlobWrite, CommitInput, GitHubLink, GitStore } from "./types.ts";

export class RoutedStore implements GitStore {
  constructor(
    readonly base: GitStore,
    private routes: Map<string, GitStore>,
  ) {}

  get kind() {
    return this.base.kind;
  }

  /** The store that holds `repo`. */
  storeFor(repo: string): GitStore {
    return this.routes.get(repo) ?? this.base;
  }

  createRepo(id: string, opts: { branch: string; github?: GitHubLink }) {
    return this.storeFor(id).createRepo(id, opts);
  }
  deleteRepo(id: string) {
    return this.storeFor(id).deleteRepo(id);
  }
  head(repo: string, branch: string) {
    return this.storeFor(repo).head(repo, branch);
  }
  listFiles(repo: string, ref: string) {
    return this.storeFor(repo).listFiles(repo, ref);
  }
  async listFilesWithMetadata(repo: string, ref: string) {
    const s = this.storeFor(repo);
    if (s.listFilesWithMetadata) return s.listFilesWithMetadata(repo, ref);
    return (await s.listFiles(repo, ref)).map((path) => ({ path, size: 0 }));
  }
  readFile(repo: string, path: string, ref: string) {
    return this.storeFor(repo).readFile(repo, path, ref);
  }
  readBlob(repo: string, path: string, ref: string, maxBytes: number) {
    return this.storeFor(repo).readBlob(repo, path, ref, maxBytes);
  }
  commit(input: CommitInput) {
    return this.storeFor(input.repo).commit(input);
  }
  writeBlob(input: BlobWrite) {
    return this.storeFor(input.repo).writeBlob(input);
  }
  history(repo: string, branch: string, path: string | undefined, limit: number) {
    return this.storeFor(repo).history(repo, branch, path, limit);
  }
  diff(repo: string, sha: string, path?: string) {
    return this.storeFor(repo).diff(repo, sha, path);
  }
  search(repo: string, ref: string, query: string, limit: number) {
    return this.storeFor(repo).search(repo, ref, query, limit);
  }
  async pullUpstream(repo: string, branch: string) {
    await this.storeFor(repo).pullUpstream?.(repo, branch);
  }
}

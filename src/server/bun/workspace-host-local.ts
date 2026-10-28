// The Bun WorkspaceHost: every workspace's runtime in this process (a Map, see workspace.ts RuntimeMap), sharing one
// RoomManager over the Bun RoomStorage. Crash-log recovery and the shutdown flush cover all workspaces at once.
import type { RoomManager } from "../rooms.ts";
import { RuntimeMap, type HeadCachingStore } from "../workspace.ts";

export class LocalWorkspaceHost extends RuntimeMap {
  constructor(store: HeadCachingStore, rooms: RoomManager) {
    super(store, rooms);
  }

  /** Reopen rooms with crash-log entries from a previous run (any workspace), so their edits get committed. */
  recover(branchOf: (repo: string) => string | undefined) {
    return this.rooms.recover(branchOf);
  }

  /** Commit every open room and close them all (shutdown). */
  flushAll() {
    return this.rooms.flushAll();
  }
}

// The Bun WorkspaceHost: every workspace's runtime in this process (a Map, see workspace.ts RuntimeMap), sharing one
// RoomManager over the Bun RoomStorage. Crash-log recovery and the shutdown flush cover all workspaces at once.
import { subscribe } from "../events.ts";
import type { RoomManager } from "../rooms.ts";
import { RuntimeMap, type HeadCachingStore } from "../workspace.ts";

export class LocalWorkspaceHost extends RuntimeMap {
  /** Workspace events reach their runtime's v2 sockets. */
  private unsubscribe = subscribe((e) => {
    if ("repo" in e) void this.runtimes.get(e.repo)?.socketEvent(e);
  });

  constructor(store: HeadCachingStore, rooms: RoomManager) {
    super(store, rooms);
  }

  /** Close every v2 socket (shutdown) and stop forwarding events. */
  closeSockets(code: number, reason: string) {
    this.unsubscribe();
    for (const rt of this.runtimes.values()) rt.closeSockets(code, reason);
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

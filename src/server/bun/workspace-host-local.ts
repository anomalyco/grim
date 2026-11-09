// The Bun WorkspaceHost: every workspace's runtime in this process (a Map, see workspace.ts RuntimeMap), sharing one
// RoomManager. Versions due are cut by a sweep every minute; shutdown compacts every room.
import { subscribe } from "../events.ts";
import type { RoomManager } from "../rooms.ts";
import type { RoomStorage } from "../seams/room-storage.ts";
import { RuntimeMap } from "../workspace.ts";
import type { BlobStore } from "../seams/blobs.ts";

export class LocalWorkspaceHost extends RuntimeMap {
  /** Workspace events reach their runtime's v2 sockets. */
  private unsubscribe = subscribe((e) => {
    if ("repo" in e) void this.runtimes.get(e.repo)?.socketEvent(e);
  });
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(rooms: RoomManager, blobsFor: (repoId: string) => BlobStore) {
    super(rooms, blobsFor);
  }

  /** Cut due versions every minute: open rooms, and notes of `storage` (the shared database) with an open version. */
  startSweeps(storage: RoomStorage, extra: () => string[] = () => []) {
    this.sweeper = setInterval(() => {
      const ws = storage.exec<{ ws: string }>("SELECT DISTINCT ws FROM notes WHERE pending IS NOT NULL AND deleted_at IS NULL").map((r) => r.ws);
      for (const id of new Set([...ws, ...extra(), ...this.rooms.list().map((r) => r.repo)])) {
        try {
          this.rooms.cutDue(id);
        } catch (e) {
          console.error(`[versions] ${id}:`, e);
        }
      }
    }, 60_000);
  }

  /** Close every v2 socket (shutdown) and stop forwarding events. */
  closeSockets(code: number, reason: string) {
    this.unsubscribe();
    if (this.sweeper) clearInterval(this.sweeper);
    for (const rt of this.runtimes.values()) rt.closeSockets(code, reason);
  }

  /** Compact every room and close them all (shutdown). */
  flushAll() {
    return this.rooms.flushAll();
  }
}

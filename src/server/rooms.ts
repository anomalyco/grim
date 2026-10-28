import type { GitStore } from "./store/types.ts";
import type { RoomStorage } from "./seams/room-storage.ts";
import type { Db } from "./seams/db.ts";
import { NotFoundError, Room, roomKey, type RoomOptions } from "./room.ts";

export * from "./room.ts";

export class RoomManager {
  private loading = new Map<string, Promise<Room>>();
  private open = new Map<string, Room>();
  private storage: RoomStorage;
  private db: Db;

  constructor(
    private store: GitStore,
    /** `storage`: the crash log (Bun: bunRoomStorage(), Workers: the DO's); `db`: the global tables (blame author lookups); `room`: timers per platform. */
    private opts: { ephemeral?: (repo: string) => boolean; storage: RoomStorage; db: Db; room?: RoomOptions },
  ) {
    this.storage = opts.storage;
    this.db = opts.db;
  }

  /** Get or open a room. `create` is the initial text when the file doesn't exist; null means it must exist. */
  async get(repo: string, path: string, branch: string, create: string | null = null): Promise<Room> {
    const key = roomKey(repo, path);
    const existing = this.open.get(key);
    if (existing && !existing.closed) return existing;
    let p = this.loading.get(key);
    if (!p) {
      p = (async () => {
        const room = new Room(repo, path, branch, this.store, this.storage, this.db, (r) => {
          if (this.open.get(r.key) === r) this.open.delete(r.key);
        }, this.opts.ephemeral?.(repo) ?? false, this.opts.room);
        try {
          await room.open(create);
        } catch (e) {
          // Stop the room's timers; keep its crash log (if any) for the next attempt.
          room.destroy(false);
          throw e;
        }
        if (room.closed) throw new NotFoundError(`${path} not found`);
        this.open.set(key, room);
        return room;
      })();
      this.loading.set(key, p);
      p.finally(() => this.loading.delete(key)).catch(() => {});
    }
    return p;
  }

  /** An already-open room, without loading. */
  peek(repo: string, path: string): Room | undefined {
    const r = this.open.get(roomKey(repo, path));
    return r && !r.closed ? r : undefined;
  }

  list(): Room[] {
    return [...this.open.values()].filter((r) => !r.closed);
  }

  inRepo(repo: string): Room[] {
    return this.list().filter((r) => r.repo === repo);
  }

  /**
   * Throw away a repo's open rooms without saving (its store was reset underneath them): their clients reconnect
   * (1013), get a new room with a new generation, and reload the note.
   */
  async discardRepo(repo: string) {
    await Promise.allSettled([...this.loading.entries()].filter(([k]) => k.startsWith(roomKey(repo, ""))).map(([, p]) => p));
    for (const r of this.inRepo(repo)) {
      for (const c of r.conns) c.close(1013, "reset");
      r.destroy(true);
    }
  }

  /** Rooms with crash-log entries from a previous run: reopen them so their edits get committed. */
  async recover(branchOf: (repo: string) => string | undefined) {
    const rows = this.storage.exec<{ room: string }>("SELECT room FROM room_meta");
    for (const { room } of rows) {
      const [repo, path] = room.split("\u0000") as [string, string];
      const branch = branchOf(repo);
      if (!branch) {
        this.storage.transaction(() => {
          this.storage.exec("DELETE FROM room_meta WHERE room = ?", room);
          this.storage.exec("DELETE FROM room_updates WHERE room = ?", room);
        });
        continue;
      }
      try {
        const r = await this.get(repo, path, branch);
        r.touch();
      } catch (e) {
        console.error(`[recover] ${repo}:${path}:`, e);
      }
    }
  }

  /** Commit every open room and close them all (shutdown). Rooms that could not be saved keep their crash log. */
  async flushAll() {
    await Promise.allSettled([...this.loading.values()]);
    const rooms = this.list();
    await Promise.allSettled(rooms.map((r) => r.flush()));
    for (const r of rooms) r.destroy(!r.dirty);
  }
}

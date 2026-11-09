import type { NoteStore } from "./notes/store.ts";
import { NotFoundError, Room, roomKey, type RoomOptions } from "./room.ts";

export * from "./room.ts";

/** The open rooms of one host (Bun: every workspace; a WorkspaceDO: its own), keyed by workspace and path. */
export class RoomManager {
  private open = new Map<string, Room>();

  constructor(
    /** `store(repo)`: the workspace's notes; `room`: timers per platform. */
    private opts: { store: (repo: string) => NoteStore; room?: RoomOptions },
  ) {}

  store(repo: string): NoteStore {
    return this.opts.store(repo);
  }

  /** Get or open a room (throws NotFoundError when the note doesn't exist). Opening is synchronous: a store read. */
  async get(repo: string, path: string): Promise<Room> {
    const room = this.getSync(repo, path);
    if (!room) throw new NotFoundError(`${path} not found`);
    return room;
  }

  getSync(repo: string, path: string): Room | null {
    const key = roomKey(repo, path);
    const existing = this.open.get(key);
    if (existing && !existing.closed) return existing;
    const room = new Room(repo, path, this.opts.store(repo), (r) => {
      if (this.open.get(r.key) === r) this.open.delete(r.key);
    }, this.opts.room);
    if (!room.wake()) {
      room.destroy(true);
      return null;
    }
    this.open.set(key, room);
    return room;
  }

  /** The same as getSync (a Durable Object waking from hibernation): no network, ever. */
  wake(repo: string, path: string): Room | null {
    return this.getSync(repo, path);
  }

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

  /** Throw away a workspace's open rooms without keeping their state (a demo reset): clients reconnect (1013). */
  async discardRepo(repo: string) {
    for (const r of this.inRepo(repo)) {
      for (const c of r.conns) c.close(1013, "reset");
      r.destroy(true);
    }
  }

  /** Compact and close every room (shutdown). */
  async flushAll() {
    for (const r of this.list()) r.destroy();
  }

  /** Cut due versions: open rooms by their own clock, closed notes from the store. */
  cutDue(repo: string, now = Date.now()) {
    const open = this.inRepo(repo);
    for (const r of open) r.cutIfDue(now);
    this.opts.store(repo).cutDue(now, new Set(open.map((r) => r.noteId)));
  }
}

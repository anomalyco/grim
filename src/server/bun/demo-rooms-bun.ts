// Bun's demo rooms (demo-rooms.ts): the lobby, and each room's in-memory store, in the server process. A room is made
// (row + seeded MemoryStore) when the lobby needs one and dropped (rooms discarded, store and row gone) once nobody
// has been in it for a while. Sockets tell it who is connected where, so they keep their places.
import { createDemoRoomRow, deleteDemoRoomRow, deleteStaleDemoRows, newDemoStore, seedDemoRepo, startDemoResets } from "../demo.ts";
import { DEMO_REPORT_MS, DemoLobby, isDemoRoom, localGate, setDemoGate, type LobbyOptions } from "../demo-rooms.ts";
import type { Ctx } from "../ops.ts";
import { forgetRepo } from "../repo-cache.ts";
import type { Db } from "../seams/db.ts";
import type { MemoryStore } from "../store/memory.ts";
import type { WorkspaceHost } from "../seams/workspace-host.ts";

export class BunDemoRooms {
  readonly stores = new Map<string, MemoryStore>();
  readonly lobby: DemoLobby;
  /** room → person → open sockets */
  private conns = new Map<string, Map<string, number>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopResets: () => void = () => {};
  private ctx: Ctx | null = null;

  constructor(
    private db: Db,
    opts: LobbyOptions = {},
  ) {
    this.lobby = new DemoLobby({
      ...opts,
      onCreate: (id) => this.create(id),
      onDrop: (id) => this.drop(id),
    });
  }

  /** The store of a demo room (RoutedStore's lookup); undefined for every other repo. */
  storeFor = (repo: string) => (isDemoRoom(repo) ? this.stores.get(repo) : undefined);

  /** Start: rows left by the last run go, the gate is this lobby, rooms report every DEMO_REPORT_MS and reset on schedule. */
  async start(ctx: Ctx) {
    this.ctx = ctx;
    await deleteStaleDemoRows(this.db, new Set());
    setDemoGate(localGate(this.lobby));
    this.timer = setInterval(() => this.reportAll(), DEMO_REPORT_MS);
    this.stopResets = startDemoResets(ctx, () => [...this.stores.keys()]);
  }

  /** A socket of `person` opened, or closed, in a demo room. */
  connected(room: string, person: string, delta: 1 | -1) {
    if (!isDemoRoom(room)) return;
    const m = this.conns.get(room) ?? new Map<string, number>();
    const n = (m.get(person) ?? 0) + delta;
    if (n > 0) m.set(person, n);
    else m.delete(person);
    if (m.size) this.conns.set(room, m);
    else this.conns.delete(room);
    this.lobby.report(room, [...m.keys()]);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.stopResets();
  }

  private reportAll() {
    for (const [room, m] of this.conns) this.lobby.report(room, [...m.keys()]);
    this.lobby.prune();
  }

  private async create(id: string) {
    const ctx = this.ctx!;
    this.stores.set(id, newDemoStore());
    await createDemoRoomRow(this.db, id);
    await seedDemoRepo(ctx.store, id);
  }

  private async drop(id: string) {
    const ctx = this.ctx!;
    this.conns.delete(id);
    await ctx.rooms.discardRepo(id);
    (ctx.repos.host as WorkspaceHost & { forget?(id: string): void }).forget?.(id);
    this.stores.delete(id);
    await deleteDemoRoomRow(this.db, id);
    forgetRepo(id);
  }
}

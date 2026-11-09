// Bun's demo rooms (demo-rooms.ts): the lobby, and each room's in-memory NoteStore, in the server process. A room is
// made (row + seeded notes) when the lobby needs one and dropped (rooms discarded, store and row gone) once nobody has
// been in it for a while. Sockets tell it who is connected where, so they keep their places.
import { Database } from "bun:sqlite";
import { createDemoRoomRow, deleteDemoRoomRow, deleteStaleDemoRows, seedDemo, startDemoResets } from "../demo.ts";
import { DEMO_REPORT_MS, DemoLobby, isDemoRoom, localGate, setDemoGate, type LobbyOptions } from "../demo-rooms.ts";
import { forgetRepo } from "../repo-cache.ts";
import type { Db } from "../seams/db.ts";
import { NoteStore } from "../notes/store.ts";
import { MemoryBlobs } from "../notes/blobs-memory.ts";
import { BunRoomStorage } from "./room-storage-bun.ts";
import type { LocalWorkspaceHost } from "./workspace-host-local.ts";

export class BunDemoRooms {
  readonly stores = new Map<string, NoteStore>();
  readonly blobs = new Map<string, MemoryBlobs>();
  readonly lobby: DemoLobby;
  /** room → person → open sockets */
  private conns = new Map<string, Map<string, number>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopResets: () => void = () => {};

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

  /** A demo room's notes (an in-memory SQLite of its own). */
  storeFor(repo: string): NoteStore {
    let s = this.stores.get(repo);
    if (!s) this.stores.set(repo, (s = new NoteStore(new BunRoomStorage(new Database(":memory:")), repo)));
    return s;
  }

  blobsFor(repo: string): MemoryBlobs {
    let b = this.blobs.get(repo);
    if (!b) this.blobs.set(repo, (b = new MemoryBlobs()));
    return b;
  }

  private host: LocalWorkspaceHost | null = null;

  /** Start: rows left by the last run go, the gate is this lobby, rooms report every DEMO_REPORT_MS and reset on schedule. */
  async start(host: LocalWorkspaceHost) {
    this.host = host;
    await deleteStaleDemoRows(this.db, new Set());
    setDemoGate(localGate(this.lobby));
    this.timer = setInterval(() => this.reportAll(), DEMO_REPORT_MS);
    this.stopResets = startDemoResets((id) => host.get(id), () => [...this.stores.keys()]);
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
    this.storeFor(id);
    await createDemoRoomRow(this.db, id);
    await seedDemo(this.host!.get(id));
  }

  private async drop(id: string) {
    this.conns.delete(id);
    await this.host!.rooms.discardRepo(id);
    this.host!.forget(id);
    this.stores.delete(id);
    this.blobs.delete(id);
    await deleteDemoRoomRow(this.db, id);
    forgetRepo(id);
  }
}

// Bun's home page rooms: the lobby (home-lobby.ts) and the rooms it hands out, in the server process. A room is made
// when its first person comes and goes away (bots stopped) once nobody is in it or coming back to it.
import { HomeRoom, type HomeOptions } from "./home.ts";
import { HOME_IDLE_MS, HomeLobby, isRoomId, type LobbyOptions } from "./home-lobby.ts";

export class HomeRooms {
  readonly lobby: HomeLobby;
  readonly rooms = new Map<string, HomeRoom>();

  constructor(
    private opts: HomeOptions = {},
    lobby: LobbyOptions = {},
  ) {
    // (the rooms' clock if they're given one, as in tests: an undefined `now` would hide the lobby's own)
    this.lobby = new HomeLobby({ ...(opts.now ? { now: opts.now } : {}), ...lobby });
  }

  /** A room for a new connection from `ip` (back to `prev` if it held `slot` there), or null: try later. */
  assign(ip: string, prev?: string | null, slot?: string | null): string | null {
    return this.lobby.assign(ip, isRoomId(prev) ? prev : undefined, !!slot);
  }

  /** The room with this id, made if it isn't there (its bots start with its first person). */
  room(id: string): HomeRoom {
    let room = this.rooms.get(id);
    if (room) return room;
    room = new HomeRoom({
      idleMs: HOME_IDLE_MS,
      ...this.opts,
      room: id,
      onOccupancy: (n, ips) => {
        this.lobby.report(id, n, ips);
        if (n > 0 || this.rooms.get(id) !== room) return;
        this.rooms.delete(id);
        room!.stop();
      },
    });
    this.rooms.set(id, room);
    return room;
  }

  /** A room with nobody in it (or coming back) goes. */
  drop(room: HomeRoom) {
    if (room.occupancy() > 0) return;
    for (const [id, r] of this.rooms) if (r === room) this.rooms.delete(id);
    room.stop();
  }

  /** For tests: the room the next person will be put in (made now, so it can be looked at or changed first). */
  first(): HomeRoom {
    let best: HomeRoom | null = null;
    for (const r of this.rooms.values()) if (!best || r.occupancy() > best.occupancy()) best = r;
    if (best) return best;
    const id = this.lobby.assign("test");
    if (!id) throw new Error("no room to be had");
    return this.room(id);
  }

  stop() {
    for (const room of this.rooms.values()) room.stop();
    this.rooms.clear();
  }
}

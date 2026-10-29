// The demo's rooms: the demo is never one shared workspace. Each signed-out visitor is put in a room of at most
// DEMO_ROOM_PEOPLE people, its own copy of the demo (workspace id "demo.<room>": its own notes, edits, presence and
// cursors, seeded with the tour, reset every DEMO_RESET_MINUTES), so a crowd is spread over many independent demos.
// "/app/demo" is only an alias: clients ask POST /api/demo/room which room is theirs and use that workspace id for
// everything else (the web and the Mac app still show /app/demo/... links).
//
// The lobby (DemoLobby) hands out rooms and keeps who is in each: people, not sockets, keyed by their browser's guest
// id (or account id), so tabs and reloads take one place. A newcomer goes to the fullest room with space, else a new
// one. Someone stays in their room while they have a socket open in it (the rooms report who is connected) or used
// it in the last DEMO_MEMBER_GRACE_MS; a room nobody is in goes after DEMO_ROOM_GRACE_MS (its workspace row deleted,
// its memory freed). Every REST call and socket on a room is admitted through the lobby (`demoGate()`), so an 11th
// person can't get in by naming the room. Bun keeps the lobby in the server process (index.ts); Workers keep it in the
// HomeDO named "demo-lobby" (src/workers/home-do.ts), the rooms in their own WorkspaceDOs.

/** people per demo room */
export const DEMO_ROOM_PEOPLE = 10;
/** someone not connected and not seen for this long gives up their place */
export const DEMO_MEMBER_GRACE_MS = 30_000;
/** a room with nobody in it goes this long after its last person left (or after it was made) */
export const DEMO_ROOM_GRACE_MS = 60_000;
/** rooms say who's connected every DEMO_REPORT_MS (and when it changes); a report older than this counts for nothing */
export const DEMO_REPORT_MS = 15_000;
const DEMO_REPORT_STALE_MS = DEMO_REPORT_MS * 3;
/** close code (and REST 409 `demoRoom: "full"`) for "that demo room is full": ask for a room again */
export const DEMO_ROOM_FULL = 4409;

const ROOM_ID = /^demo\.[a-z0-9]{10}$/;
/** Whether a workspace id is one of the demo's rooms. */
export const isDemoRoom = (id: string): boolean => ROOM_ID.test(id);

export type Admit = "ok" | "full" | "gone";

export interface LobbyOptions {
  now?: () => number;
  newId?: () => string;
  /** no more rooms than this: past it, try later */
  maxRooms?: number;
  /** new people per IP: a token bucket refilled at joinsPerMin with room for joinBurst */
  joinsPerMin?: number;
  joinBurst?: number;
  memberGraceMs?: number;
  roomGraceMs?: number;
  /** a room was made (its workspace row and seed); awaited before anyone is sent to it */
  onCreate?: (workspace: string) => Promise<void> | void;
  /** a room went: drop its row and memory */
  onDrop?: (workspace: string) => Promise<void> | void;
}

interface RoomInfo {
  /** person → last seen (admitted or reported connected) */
  members: Map<string, number>;
  /** the people its sockets belong to, as the room last said, and when */
  connected: Set<string>;
  connectedAt: number;
  /** when it last had someone in it (or was made) */
  emptySince: number;
  ready: Promise<void>;
}

export class DemoLobby {
  private rooms = new Map<string, RoomInfo>();
  private where = new Map<string, string>();
  private perIp = new Map<string, { tokens: number; t: number }>();
  private opts: Required<LobbyOptions>;

  constructor(opts: LobbyOptions = {}) {
    this.opts = {
      now: Date.now,
      newId: () => crypto.randomUUID().replace(/-/g, "").slice(0, 10),
      maxRooms: 1000,
      joinsPerMin: 30,
      joinBurst: 15,
      memberGraceMs: DEMO_MEMBER_GRACE_MS,
      roomGraceMs: DEMO_ROOM_GRACE_MS,
      onCreate: () => {},
      onDrop: () => {},
      ...opts,
    };
  }

  /** The room for `person` (their own while it's there, else the fullest with space, else a new one), or null: try later. */
  async assign(person: string, ip: string): Promise<string | null> {
    const now = this.opts.now();
    this.prune(now);
    const mine = this.where.get(person);
    if (mine) {
      const r = this.rooms.get(mine)!;
      r.members.set(person, now);
      await r.ready;
      return mine;
    }
    if (!this.takeToken(ip, now)) return null;
    let best: [string, RoomInfo] | null = null;
    for (const e of this.rooms) {
      const n = e[1].members.size;
      if (n < DEMO_ROOM_PEOPLE && (!best || n > best[1].members.size)) best = e;
    }
    if (!best) {
      if (this.rooms.size >= this.opts.maxRooms) return null;
      let id = `demo.${this.opts.newId()}`;
      while (this.rooms.has(id)) id = `demo.${this.opts.newId()}`;
      const info: RoomInfo = { members: new Map(), connected: new Set(), connectedAt: 0, emptySince: now, ready: Promise.resolve() };
      info.ready = Promise.resolve(this.opts.onCreate(id)).catch((e) => {
        if (this.rooms.get(id) === info) this.drop(id);
        throw e;
      });
      this.rooms.set(id, info);
      best = [id, info];
    }
    this.join(best[0], best[1], person, now);
    await best[1].ready;
    return best[0];
  }

  /** May `person` use this room now? Its members may; anyone else only while it has space (they join it). */
  admit(workspace: string, person: string, ip: string): Admit {
    const now = this.opts.now();
    this.prune(now);
    const r = this.rooms.get(workspace);
    if (!r) return "gone";
    if (r.members.has(person)) {
      r.members.set(person, now);
      return "ok";
    }
    if (r.members.size >= DEMO_ROOM_PEOPLE || this.where.has(person) || !this.takeToken(ip, now)) return "full";
    this.join(workspace, r, person, now);
    return "ok";
  }

  /** A room says whose sockets it holds (they keep their places); a room the lobby lost (Workers: it restarted) is
   *  taken back with them. */
  report(workspace: string, people: string[]) {
    const now = this.opts.now();
    let r = this.rooms.get(workspace);
    if (!r) {
      if (!people.length || !isDemoRoom(workspace)) return;
      r = { members: new Map(), connected: new Set(), connectedAt: 0, emptySince: now, ready: Promise.resolve() };
      this.rooms.set(workspace, r);
    }
    r.connected = new Set(people);
    r.connectedAt = now;
    for (const p of people) {
      const other = this.where.get(p);
      if (other && other !== workspace) continue;
      if (!r.members.has(p) && r.members.size >= DEMO_ROOM_PEOPLE) continue;
      this.join(workspace, r, p, now);
    }
    this.prune(now);
  }

  /** The room `person` is in, if any. */
  roomOf(person: string): string | null {
    this.prune(this.opts.now());
    return this.where.get(person) ?? null;
  }

  /** The rooms there are now. */
  list(): string[] {
    this.prune(this.opts.now());
    return [...this.rooms.keys()];
  }

  /** For tests and monitoring. */
  stats(): { rooms: number; people: number } {
    return { rooms: this.rooms.size, people: this.where.size };
  }

  /** Expire people and rooms (also on every call). */
  prune(now = this.opts.now()) {
    const { memberGraceMs, roomGraceMs } = this.opts;
    for (const [id, r] of this.rooms) {
      for (const [p, seen] of r.members) {
        if (r.connected.has(p) && now - r.connectedAt < DEMO_REPORT_STALE_MS) r.members.set(p, now);
        else if (now - seen > memberGraceMs) {
          r.members.delete(p);
          if (this.where.get(p) === id) this.where.delete(p);
          if (!r.members.size) r.emptySince = now;
        }
      }
      if (!r.members.size && now - r.emptySince > roomGraceMs) this.drop(id);
    }
  }

  private join(id: string, r: RoomInfo, person: string, now: number) {
    r.members.set(person, now);
    this.where.set(person, id);
  }

  private drop(id: string) {
    const r = this.rooms.get(id);
    if (!r) return;
    this.rooms.delete(id);
    for (const p of r.members.keys()) if (this.where.get(p) === id) this.where.delete(p);
    void Promise.resolve()
      .then(() => this.opts.onDrop(id))
      .catch((e) => console.error(`[demo] drop ${id}:`, e));
  }

  private takeToken(ip: string, now: number): boolean {
    const { joinsPerMin, joinBurst } = this.opts;
    if (this.perIp.size > 10_000) {
      for (const [k, b] of this.perIp) if (b.tokens + ((now - b.t) * joinsPerMin) / 60_000 >= joinBurst) this.perIp.delete(k);
    }
    const b = this.perIp.get(ip) ?? { tokens: joinBurst, t: now };
    b.tokens = Math.min(joinBurst, b.tokens + ((now - b.t) * joinsPerMin) / 60_000);
    b.t = now;
    this.perIp.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }
}

/** How the shared app reaches the lobby: in process on Bun, over RPC to its Durable Object on Workers. */
export interface DemoGate {
  assign(person: string, ip: string): Promise<string | null>;
  admit(workspace: string, person: string, ip: string): Promise<Admit>;
  roomOf(person: string): Promise<string | null>;
}

/** Without a lobby (tests that don't start one): every room lets everyone in, nobody is assigned one. */
let gate: DemoGate = { assign: async () => null, admit: async () => "ok", roomOf: async () => null };

export function setDemoGate(g: DemoGate) {
  gate = g;
}

export function demoGate(): DemoGate {
  return gate;
}

/** A lobby in this process as a gate. */
export function localGate(lobby: DemoLobby): DemoGate {
  return {
    assign: (person, ip) => lobby.assign(person, ip),
    admit: async (workspace, person, ip) => lobby.admit(workspace, person, ip),
    roomOf: async (person) => lobby.roomOf(person),
  };
}

// The home page's rooms: at most ROOM_HUMANS people each, with their own three bots, so a crowd never lands on one
// page. The lobby hands out rooms: the fullest one with space (so people meet), else a fresh one. The rooms tell it how
// many people they hold (and, on Workers, that they're still there). Bun keeps the lobby and the rooms in the server
// process (home-rooms.ts); Workers keep each in a HomeDO of its own (src/workers/home-do.ts). Shared by both.
import { DOODLE } from "../../shared/doodle.ts";

/** people per room (each also sees the room's three bots: at most 7 pencils) */
export const ROOM_HUMANS = 4;
/** someone whose socket drops keeps their place this long, to come back to */
export const SLOT_HOLD_MS = 5_000;
/** close code for "this room is full": the client reconnects and is given another */
export const ROOM_FULL = 4409;
/** a room handed out counts as having its newcomer this long, until the room says they came */
const PENDING_MS = 10_000;

export const isRoomId = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9]{6,16}$/.test(s);

export interface LobbyOptions {
  now?: () => number;
  /** a room not heard from for this long is gone (Workers: rooms report every 15 s) */
  staleMs?: number;
  /** rooms handed out per IP: a token bucket refilled at assignsPerMin with room for assignBurst */
  assignsPerMin?: number;
  assignBurst?: number;
  /** no more rooms than this (each runs three bots): past it, try later */
  maxRooms?: number;
  /** sockets per IP across all rooms (the rooms report theirs) */
  maxPerIp?: number;
  newId?: () => string;
}

interface RoomInfo {
  humans: number;
  /** people here per IP, as the room last said */
  ips: Record<string, number>;
  /** the newcomers sent here, not yet arrived: from where, and when they stop counting */
  pending: { ip: string; until: number }[];
  seen: number;
}

export class HomeLobby {
  private rooms = new Map<string, RoomInfo>();
  private perIp = new Map<string, { tokens: number; t: number }>();
  private opts: Required<LobbyOptions>;

  constructor(opts: LobbyOptions = {}) {
    this.opts = {
      now: Date.now,
      staleMs: Infinity,
      assignsPerMin: 20,
      assignBurst: 10,
      maxRooms: 250,
      maxPerIp: DOODLE.maxConnsPerIp,
      newId: () => crypto.randomUUID().replace(/-/g, "").slice(0, 10),
      ...opts,
    };
  }

  /**
   * A room for a new connection from `ip`, or null (too many from it, or every room's taken: try later). Someone
   * reconnecting names the room they were in (`prev`, with the slot they held there): they go back to it while it's
   * there; the room itself lets them in if their place is still free, or turns them away (ROOM_FULL) to ask again.
   */
  assign(ip: string, prev?: string, slot?: boolean): string | null {
    const now = this.opts.now();
    this.prune(now);
    if (!this.takeToken(ip, now)) return null;
    if (prev && slot && this.rooms.has(prev)) return prev;
    let mine = 0;
    for (const r of this.rooms.values()) mine += (r.ips[ip] ?? 0) + r.pending.filter((p) => p.ip === ip).length;
    if (mine >= this.opts.maxPerIp) return null;
    let best: [string, RoomInfo] | null = null;
    for (const e of this.rooms) {
      const n = load(e[1]);
      if (n < ROOM_HUMANS && (!best || n > load(best[1]))) best = e;
    }
    if (best) {
      best[1].pending.push({ ip, until: now + PENDING_MS });
      return best[0];
    }
    if (this.rooms.size >= this.opts.maxRooms) return null;
    let id = this.opts.newId();
    while (this.rooms.has(id)) id = this.opts.newId();
    this.rooms.set(id, { humans: 0, ips: {}, pending: [{ ip, until: now + PENDING_MS }], seen: now });
    return id;
  }

  /** A room says how many it holds (people, and places held for people who dropped; `ips`: people per IP); 0: it's
   *  gone. */
  report(room: string, humans: number, ips: Record<string, number> = {}) {
    const now = this.opts.now();
    if (humans <= 0) return void this.rooms.delete(room);
    const r = this.rooms.get(room);
    if (!r) return void this.rooms.set(room, { humans, ips, pending: [], seen: now });
    // (whoever came is no longer on the way)
    for (const [ip, n] of Object.entries(ips))
      for (let k = n - (r.ips[ip] ?? 0); k > 0; k--) {
        const i = r.pending.findIndex((p) => p.ip === ip);
        if (i < 0) break;
        r.pending.splice(i, 1);
      }
    r.humans = humans;
    r.ips = ips;
    r.seen = now;
  }

  /** For tests and monitoring: rooms and how many each holds. */
  stats(): { rooms: number; humans: number } {
    let humans = 0;
    for (const r of this.rooms.values()) humans += r.humans;
    return { rooms: this.rooms.size, humans };
  }

  private prune(now: number) {
    for (const [id, r] of this.rooms) {
      r.pending = r.pending.filter((p) => p.until > now);
      // (handed out but nobody came; or not heard from)
      if ((r.humans === 0 && !r.pending.length && now - r.seen > PENDING_MS) || now - r.seen > this.opts.staleMs) this.rooms.delete(id);
    }
  }

  private takeToken(ip: string, now: number): boolean {
    const { assignsPerMin, assignBurst } = this.opts;
    if (this.perIp.size > 10_000) {
      for (const [k, b] of this.perIp) if (b.tokens + ((now - b.t) * assignsPerMin) / 60_000 >= assignBurst) this.perIp.delete(k);
    }
    const b = this.perIp.get(ip) ?? { tokens: assignBurst, t: now };
    b.tokens = Math.min(assignBurst, b.tokens + ((now - b.t) * assignsPerMin) / 60_000);
    b.t = now;
    this.perIp.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }
}

const load = (r: RoomInfo) => r.humans + r.pending.length;

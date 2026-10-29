// A home page doodle room (/ws/home): everyone in it sees each other's pencils and drawings, plus a few bots that
// write little sayings. A room holds a few people (ROOM_HUMANS; the lobby, home-lobby.ts, shares them out). Public
// and unauthenticated, so everything is capped; nothing is saved. Protocol and coordinates: src/shared/doodle.ts.
import { DOODLE, INK_FADE_MS, INK_MS, PENCIL_COLORS, type Peer } from "../../shared/doodle.ts";
import { boxesOverlap, drawPicture, measurePhrase, wrapPhrase, writePhrase, type Box, type MarkKind } from "../../shared/handwriting.ts";
import { DRAWINGS, type Drawing } from "./home-drawings.ts";
import { IN_ORDER, IN_ORDER_GAP_MIN } from "./home-lines.ts";
import { sillyName } from "../../shared/names.ts";
import { CAST, type Character } from "./cast.ts";
import { pickLine } from "./lines.ts";
import { ROOM_FULL, ROOM_HUMANS, SLOT_HOLD_MS } from "./home-lobby.ts";

export interface HomeSocket {
  send(msg: string): void;
  close(code: number, reason: string): void;
  /** bytes queued for this socket */
  buffered(): number;
}

export interface HomeClient {
  peer: Peer;
  ip: string;
  sock: HomeSocket;
  hidden: boolean;
  msgTokens: number;
  ptTokens: number;
  refilled: number;
  open?: { k: number; rec: StrokeRec };
  closed: boolean;
  /** their place here: a dropped socket that comes back with it within SLOT_HOLD_MS gets it back */
  slot: string;
  /** when they came in */
  joinedAt: number;
  /** when they last moved their pencil or drew (pages go quiet, closing their socket, after 30 s without) */
  lastSeen: number;
  /** the paper they can see (page units): their window's width, and its height down to the bottom of the blank
   *  paper; bots keep to what everyone can see */
  view?: { w: number; h: number };
}

/** Where bots write and roam, in page units. */
export interface BotArea {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface StrokeRec {
  id: number;
  u: string;
  c: string;
  w: number;
  p: number[];
  /** when its points came in: [points so far, time, …] per batch */
  bt: number[];
  t0: number;
  open: boolean;
  /** whose connection drew it ("" for bots): the per-person caps are per IP */
  ip: string;
  /** dropped from the buffer (expired or capped) */
  gone?: boolean;
  /** when it was finished: a person's when it ended, a bot's with its line or drawing (its ink fades INK_MS after) */
  doneAt?: number;
}

export interface HomeOptions {
  bots?: number;
  tickMs?: number;
  maxConnsPerIp?: number;
  maxConns?: number;
  /** new connections per IP: a token bucket refilled at joinsPerMin with room for joinBurst */
  joinsPerMin?: number;
  joinBurst?: number;
  /** joins and leaves are announced in batches this often (ms) */
  presenceMs?: number;
  now?: () => number;
  /** people at most (places held for dropped sockets count) */
  maxHumans?: number;
  /** this room's id (sent to its people, to come back to) */
  room?: string;
  /** told how many it holds (people and held places) whenever that changes, and its people per IP */
  onOccupancy?: (n: number, ips: Record<string, number>) => void;
  /** someone who hasn't moved their pencil or drawn for this long is dropped, and their place given up (a page that
   *  didn't go quiet itself, or a socket that died without a close) */
  idleMs?: number;
}

const MAX_BUFFERED = 1024 * 1024;
/** per IP, open strokes included */
const PER_USER_STROKES = 300;
const PER_USER_POINTS = 20_000;
/** the stroke snapshot newcomers get is rebuilt at most this often */
const SNAPSHOT_MS = 500;
/** a stroke never said to be finished counts as finished this long after its last point */
const UNFINISHED_MS = 120_000;
/** when a stroke's ink is gone everywhere (finished, plus INK_MS, plus the fade), with a second to spare */
const goneAt = (s: StrokeRec) => (s.doneAt ?? lastAt(s) + UNFINISHED_MS) + INK_MS + INK_FADE_MS + 1000;

/** A stroke for newcomers, as of `at`: its points with their batches' ages, and how long ago it was finished (dn).
 *  Null once its ink is gone. */
function strokeJson(s: StrokeRec, at: number): string | null {
  if (s.doneAt !== undefined && at - s.doneAt >= INK_MS + INK_FADE_MS) return null;
  const b: number[] = [];
  let prev = 0;
  for (let j = 0; j < s.bt.length; j += 2) {
    const end = s.bt[j]!;
    if (end > prev) b.push(end - prev, at - s.bt[j + 1]!);
    prev = end;
  }
  return JSON.stringify({ id: s.id, u: s.u, c: s.c, w: s.w, p: s.p, b, ...(s.open ? { o: true } : {}), ...(s.doneAt !== undefined ? { dn: at - s.doneAt } : {}) });
}
const lastAt = (s: StrokeRec) => (s.bt.length ? s.bt[s.bt.length - 1]! : s.t0);
const notNull = <T>(v: T | null): v is T => v !== null;
const peerInfo = (c: HomeClient): Peer => (c.hidden ? { id: c.peer.id, name: c.peer.name, color: c.peer.color, tab: c.peer.tab, v: c.peer.v } : { ...c.peer });
/** a page's own ids (tab, visitor): short random tokens */
const pageId = (s: string | undefined) => (s && /^[\w-]{8,64}$/.test(s) ? s : undefined);

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
/** a bot starts its next line this long after finishing the last (ms): it lifts off, rests, hops over to where the
 *  next one starts (hovering), lowers its tip to the paper, waits a moment, and writes */
const GAP_MS = [3000, 5000] as const;
const APPROACH_MS = [600, 1300] as const;
const LIFT_MS = 250;
const SETTLE_MS = 300;
const READY_MS = [1000, 2000] as const;
/** how high a bot's tip hovers between lines (page units) */
const HOVER = 30;
/** a bot coming in shows (pages fade it in, drifting it down onto its spot, wobbling) this long, hovering, before it
 *  lowers its tip: with SETTLE_MS, it touches the paper 0.8-1.2 s after it shows */
const FADE_IN_MS = [500, 900] as const;
/** when a room's bots start, they come in one after another: the first this soon, each next this much later */
const FIRST_IN_MS = [400, 700] as const;
const NEXT_IN_MS = [1000, 2000] as const;
/** the page holds one fresh phrase (being written, or not fading yet) per this much of the bots' area (square page
 *  units): a desktop has room for more than they write, a phone for two, so there they take turns */
const AREA_PER_PHRASE = 65_000;
/** a bot's tip stays this far inside everyone's window (page units) */
const EDGE_X = 22;
const EDGE_Y = 36;

export class HomeRoom {
  readonly clients = new Set<HomeClient>();
  readonly strokes: StrokeRec[] = [];
  readonly bots: Bot[] = [];
  private points = 0;
  private nextStroke = 1;
  private nextPeer = 1;
  private perIp = new Map<string, number>();
  private joinTokens = new Map<string, { tokens: number; t: number }>();
  /** points and strokes per IP */
  private usage = new Map<string, { n: number; pts: number }>();
  private joined = new Set<HomeClient>();
  private left: string[] = [];
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** closed strokes serialized for newcomers, with ages as of `at` */
  private snap: { at: number; json: string; ids: Set<number> } | null = null;
  /** how many times the snapshot was rebuilt (for tests) */
  snapshots = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private lastPrune = 0;
  /** where bots' phrases are: `until` they've faded (Infinity while still being written) */
  private recent: { box: Box; t: number; until: number }[] = [];
  private recentSayings: string[] = [];
  /** no new bot fight starts before this (so the page isn't constant chaos) */
  private nextFightAt = 0;
  /** places held for people whose socket dropped: slot → until */
  private held = new Map<string, number>();
  private heldTimer: ReturnType<typeof setTimeout> | null = null;
  readonly opts: Required<Omit<HomeOptions, "onOccupancy">> & Pick<HomeOptions, "onOccupancy">;

  constructor(opts: HomeOptions = {}) {
    this.opts = {
      bots: 3,
      tickMs: DOODLE.batchMs,
      maxConnsPerIp: DOODLE.maxConnsPerIp,
      maxConns: DOODLE.maxConns,
      joinsPerMin: 10,
      joinBurst: 6,
      presenceMs: 250,
      now: Date.now,
      maxHumans: ROOM_HUMANS,
      room: "",
      idleMs: Infinity,
      ...opts,
    };
    for (let i = 0; i < this.opts.bots; i++) {
      const c = CAST[i % CAST.length]!;
      // (the first three keep their names; any more get fresh ones)
      this.bots.push(new Bot(this, { id: `bot${i + 1}`, name: i < CAST.length ? c.name : sillyName(), color: c.color, bot: true }, c));
    }
  }

  /** People here, and places held for people who dropped. */
  occupancy(): number {
    return this.clients.size + this.held.size;
  }

  /** Someone just in hasn't said how much paper they see yet (a phone's narrow window): new lines wait for it, else
   *  one could be planned for a wider page and run off theirs. (2 s at most.) */
  viewsPending(): boolean {
    const now = this.opts.now();
    return [...this.clients].some((c) => !c.view && now - c.joinedAt < 2000);
  }

  /** People here per IP. */
  peopleByIp(): Record<string, number> {
    return Object.fromEntries(this.perIp);
  }

  /**
   * Add a connection, or close it with a reason when over a limit. `slot`: the place it held here, coming back to it;
   * `color`: the pencil colour its page picked (a palette colour: kept, so its pencil never changes colour); `tab`,
   * `visitor`: its page's and person's ids (a tab joining again replaces its earlier connection here: one per tab).
   */
  join(ip: string, sock: HomeSocket, o: { slot?: string; color?: string; tab?: string; visitor?: string } = {}): HomeClient | null {
    const { slot, color } = o;
    const tab = pageId(o.tab);
    // (that tab's earlier socket, still here: it's stale, so it goes; its page ignores it already)
    if (tab) for (const c of [...this.clients]) if (c.peer.tab === tab) this.kick(c, 4000, "replaced");
    this.expireHeld();
    const back = !!slot && this.held.has(slot);
    if (this.occupancy() - (back ? 1 : 0) >= this.opts.maxHumans) {
      sock.close(ROOM_FULL, "room full");
      return null;
    }
    if (this.clients.size >= this.opts.maxConns) {
      sock.close(1013, "too many people here, try later");
      return null;
    }
    const n = this.perIp.get(ip) ?? 0;
    if (n >= this.opts.maxConnsPerIp) {
      sock.close(4429, "too many connections");
      return null;
    }
    const now = this.opts.now();
    if (!this.takeJoin(ip, now)) {
      sock.close(4429, "reconnecting too often");
      return null;
    }
    this.perIp.set(ip, n + 1);
    const used = new Set([...this.clients].map((c) => c.peer.color).concat(this.bots.map((b) => b.peer.color)));
    const free = PENCIL_COLORS.filter((c) => !used.has(c));
    const pool = free.length ? free : PENCIL_COLORS;
    // (not one of the bots' names)
    let name = sillyName();
    while (this.bots.some((b) => b.peer.name === name)) name = sillyName();
    const peer: Peer = { id: `p${this.nextPeer++}`, name, color: color && PENCIL_COLORS.includes(color) ? color : pool[Math.floor(Math.random() * pool.length)]!, tab, v: pageId(o.visitor) };
    const mine = back ? slot! : crypto.randomUUID();
    const client: HomeClient = { peer, ip, sock, hidden: true, msgTokens: DOODLE.msgsPerSec * 2, ptTokens: DOODLE.pointsPerSec * 2, refilled: now, closed: false, slot: mine, joinedAt: now, lastSeen: now };
    this.prune();
    // (the bots start first: the hello says when each comes in)
    this.startBots();
    const peers = [...this.bots.map((b) => b.info()), ...[...this.clients].map(peerInfo)];
    const { json, d } = this.snapshot(now);
    const where = `"room":${JSON.stringify(this.opts.room)},"slot":${JSON.stringify(mine)}`;
    this.send(client, `{"t":"hi","you":${JSON.stringify(peer)},${where},"peers":${JSON.stringify(peers)},"d":${d},"strokes":${json}}`);
    if (client.closed) {
      if (!this.clients.size) this.stopBots();
      return null;
    }
    if (back) this.held.delete(mine);
    this.clients.add(client);
    this.opts.onOccupancy?.(this.occupancy(), this.peopleByIp());
    this.joined.add(client);
    this.schedulePresence();
    return client;
  }

  /** Token bucket per IP for new connections, so reconnect loops can't churn the room. */
  private takeJoin(ip: string, now: number): boolean {
    const { joinsPerMin, joinBurst } = this.opts;
    if (this.joinTokens.size > 10_000) {
      for (const [k, b] of this.joinTokens) if (b.tokens + ((now - b.t) * joinsPerMin) / 60_000 >= joinBurst) this.joinTokens.delete(k);
    }
    const b = this.joinTokens.get(ip) ?? { tokens: joinBurst, t: now };
    b.tokens = Math.min(joinBurst, b.tokens + ((now - b.t) * joinsPerMin) / 60_000);
    b.t = now;
    this.joinTokens.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }

  /** Recent strokes for a newcomer as a JSON array, ages as of `d` ms ago (the closed ones come from a cache). */
  private snapshot(now: number): { json: string; d: number } {
    // (points fade all the time, so it's rebuilt whenever it's old enough rather than when something changed)
    if (!this.snap || now - this.snap.at >= SNAPSHOT_MS) {
      const closed = this.strokes.filter((s) => !s.open);
      this.snap = { at: now, json: closed.map((s) => strokeJson(s, now)).filter(notNull).join(","), ids: new Set(closed.map((s) => s.id)) };
      this.snapshots++;
    }
    const snap = this.snap;
    const extra = this.strokes
      .filter((s) => s.open || !snap.ids.has(s.id))
      .map((s) => strokeJson(s, snap.at))
      .filter(notNull);
    if (snap.json) extra.unshift(snap.json);
    return { json: `[${extra.join(",")}]`, d: now - snap.at };
  }

  /** Joins and leaves go out in batches: a burst of reconnects is one message per person here, not one per join. */
  private schedulePresence() {
    if (this.presenceTimer || this.opts.presenceMs <= 0) return;
    this.presenceTimer = setTimeout(() => this.flushPresence(), this.opts.presenceMs);
  }

  flushPresence() {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    const ids = this.left;
    const joined = [...this.joined].filter((c) => !c.closed);
    this.left = [];
    this.joined.clear();
    if (ids.length) this.broadcast(JSON.stringify({ t: "l", ids }));
    if (!joined.length) return;
    const peers = joined.map(peerInfo);
    const all = JSON.stringify({ t: "j", peers });
    const fresh = new Set(joined);
    // the newcomers know about themselves (and may already know each other: repeats are ignored)
    for (const c of this.clients) {
      if (!fresh.has(c)) this.send(c, all);
      else if (peers.length > 1) this.send(c, JSON.stringify({ t: "j", peers: peers.filter((p) => p.id !== c.peer.id) }));
    }
  }

  leave(client: HomeClient) {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    const n = (this.perIp.get(client.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(client.ip);
    else this.perIp.set(client.ip, n);
    this.endOpen(client);
    // someone who came and went before anyone heard about it needn't be announced at all
    if (!this.joined.delete(client)) {
      this.left.push(client.peer.id);
      this.schedulePresence();
    }
    if (this.clients.size === 0) {
      this.stopBots();
    } else if (client.view) this.refit();
    // (their place is kept a moment, in case they're only reconnecting)
    this.held.set(client.slot, this.opts.now() + SLOT_HOLD_MS);
    this.scheduleHeld();
    this.opts.onOccupancy?.(this.occupancy(), this.peopleByIp());
  }

  /** Places held past their time are given up (and the lobby told). */
  private expireHeld() {
    const now = this.opts.now();
    let gone = false;
    for (const [slot, until] of this.held)
      if (until <= now) {
        this.held.delete(slot);
        gone = true;
      }
    if (gone) this.opts.onOccupancy?.(this.occupancy(), this.peopleByIp());
    return gone;
  }

  private scheduleHeld() {
    if (this.heldTimer || !this.held.size) return;
    const next = Math.min(...this.held.values());
    this.heldTimer = setTimeout(() => {
      this.heldTimer = null;
      this.expireHeld();
      this.scheduleHeld();
    }, Math.max(0, next - this.opts.now()) + 5);
  }

  /** Close the client's stroke in progress and tell everyone, so their copy ends where the server's does. */
  private endOpen(client: HomeClient) {
    const open = client.open;
    if (!open) return;
    client.open = undefined;
    this.close(open.rec);
    this.broadcast(JSON.stringify({ t: "s", id: open.rec.id, u: open.rec.u, c: open.rec.c, w: open.rec.w, p: [], e: 1 }), client);
  }

  close(rec: StrokeRec) {
    if (!rec.open) return;
    rec.open = false;
    // (a person's stroke is finished when it ends; a bot's when its line or drawing is: inkDone)
    if (!rec.u.startsWith("bot")) rec.doneAt = this.opts.now();
  }

  /** A bot finished the line or drawing these strokes are (or gave it up): their ink fades INK_MS from now. */
  inkDone(recs: StrokeRec[]) {
    const now = this.opts.now();
    const ids: number[] = [];
    for (const rec of recs) {
      if (rec.doneAt !== undefined || rec.gone) continue;
      rec.doneAt = now;
      ids.push(rec.id);
    }
    if (ids.length) this.broadcast(JSON.stringify({ t: "d", ids }));
  }

  /** A frame from a client. Only small text frames are accepted; anything else disconnects before it's looked at. */
  message(client: HomeClient, raw: unknown) {
    if (client.closed) return;
    if (typeof raw !== "string") return this.kick(client, 1003, "text frames only");
    if (raw.length > DOODLE.maxMessageBytes) return this.kick(client, 1009, "message too big");
    // (an old page's ping: not activity)
    if (raw === '{"t":"p"}') return;
    if (!this.take(client, "msg", 1)) return;
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    const msg = m as Record<string, unknown>;
    // (still at it: scrolling, reading, touching the page)
    if (msg.t === "a") return void (client.lastSeen = this.opts.now());
    if (msg.t === "v") {
      if (!isNum(msg.w) || !isNum(msg.h)) return;
      client.view = { w: clamp(Math.round(msg.w), 240, 4000), h: clamp(Math.round(msg.h), 320, 4000) };
      return this.refit();
    }
    if (msg.t === "c") {
      if (msg.h) {
        if (client.hidden) return;
        client.hidden = true;
        return this.broadcast(JSON.stringify({ t: "c", id: client.peer.id, h: 1 }), client);
      }
      if (!isNum(msg.x) || !isNum(msg.y)) return;
      client.lastSeen = this.opts.now();
      const was = client.hidden ? null : { x: client.peer.x ?? 0, y: client.peer.y ?? 0 };
      client.hidden = false;
      client.peer.x = round1(clamp(msg.x, DOODLE.minX, DOODLE.maxX));
      client.peer.y = round1(clamp(msg.y, DOODLE.minY, DOODLE.maxY));
      if (was) this.poked(client, was.x, was.y);
      return this.broadcast(JSON.stringify({ t: "c", id: client.peer.id, x: client.peer.x, y: client.peer.y }), client);
    }
    if (msg.t === "s") {
      client.lastSeen = this.opts.now();
      const k = msg.k;
      const p = msg.p;
      if (!Number.isInteger(k) || !Array.isArray(p) || p.length % 3 !== 0 || p.length > DOODLE.maxPointsPerMessage * 3) return;
      if (!p.every(isNum)) return;
      const n = p.length / 3;
      if (!this.take(client, "pt", n)) return;
      const pts: number[] = [];
      for (let i = 0; i < p.length; i += 3) {
        pts.push(round1(clamp(p[i] as number, DOODLE.minX, DOODLE.maxX)), round1(clamp(p[i + 1] as number, DOODLE.minY, DOODLE.maxY)), Math.round(clamp(p[i + 2] as number, 0, 1) * 100) / 100);
      }
      if (client.open && (client.open.k !== k || client.open.rec.gone)) this.endOpen(client);
      if (!client.open) {
        if (!pts.length) return;
        client.open = { k: k as number, rec: this.addStroke(client.peer, 2.2, client.ip) };
      }
      const open = client.open;
      const rec = open.rec;
      const room = DOODLE.maxPointsPerStroke * 3 - rec.p.length;
      let add = pts.slice(0, Math.max(0, room));
      // keep within the per-person cap by dropping their oldest finished strokes; over it with nothing to drop, stop
      if (!this.capIp(client.ip, add.length / 3)) add = [];
      this.append(rec, add);
      const end = !!msg.e || rec.p.length >= DOODLE.maxPointsPerStroke * 3 || !add.length;
      if (end) {
        client.open = undefined;
        this.close(rec);
      }
      client.hidden = false;
      if (add.length >= 3) {
        client.peer.x = add[add.length - 3];
        client.peer.y = add[add.length - 2];
      }
      if (add.length || end) this.broadcast(JSON.stringify({ t: "s", id: rec.id, u: rec.u, c: rec.c, w: rec.w, p: add, ...(end ? { e: 1 } : {}) }), client);
      this.prune();
    }
  }

  /** Token buckets: false (drop it) when over the rate; close sustained abusers. */
  private take(client: HomeClient, kind: "msg" | "pt", n: number): boolean {
    const now = this.opts.now();
    const dt = (now - client.refilled) / 1000;
    client.refilled = now;
    client.msgTokens = Math.min(DOODLE.msgsPerSec * 2, client.msgTokens + dt * DOODLE.msgsPerSec);
    client.ptTokens = Math.min(DOODLE.pointsPerSec * 2, client.ptTokens + dt * DOODLE.pointsPerSec);
    const key = kind === "msg" ? "msgTokens" : "ptTokens";
    const rate = kind === "msg" ? DOODLE.msgsPerSec : DOODLE.pointsPerSec;
    client[key] -= n;
    if (client[key] >= 0) return true;
    if (client[key] < -rate * 3) this.kick(client, 1008, "rate limit");
    return false;
  }

  private kick(client: HomeClient, code: number, reason: string) {
    client.sock.close(code, reason);
    this.leave(client);
  }

  addStroke(peer: Peer, w: number, ip = "", color = peer.color): StrokeRec {
    const rec: StrokeRec = { id: this.nextStroke++, u: peer.id, c: color, w, p: [], bt: [], t0: this.opts.now(), open: true, ip };
    this.strokes.push(rec);
    if (ip) this.use(ip).n++;
    return rec;
  }

  append(rec: StrokeRec, pts: number[]) {
    if (!pts.length) return;
    for (const v of pts) rec.p.push(v);
    const now = this.opts.now();
    const n = rec.p.length / 3;
    if (rec.bt.length && rec.bt[rec.bt.length - 1] === now) rec.bt[rec.bt.length - 2] = n;
    else rec.bt.push(n, now);
    if (rec.gone) return;
    this.points += pts.length / 3;
    if (rec.ip) this.use(rec.ip).pts += pts.length / 3;
  }

  private use(ip: string) {
    let u = this.usage.get(ip);
    if (!u) this.usage.set(ip, (u = { n: 0, pts: 0 }));
    return u;
  }

  /** Drop strokes[i] from the buffer. */
  private drop(i: number) {
    const [s] = this.strokes.splice(i, 1);
    if (!s) return;
    s.gone = true;
    this.points -= s.p.length / 3;
    if (s.ip) {
      const u = this.use(s.ip);
      u.n--;
      u.pts -= s.p.length / 3;
      if (u.n <= 0) this.usage.delete(s.ip);
    }
    this.close(s);
  }

  /** Keep one person (IP) from filling the whole buffer: make room for `more` points. False when there's none to make. */
  private capIp(ip: string, more: number): boolean {
    const u = this.usage.get(ip);
    if (!u) return true;
    while (u.n > PER_USER_STROKES || u.pts + more > PER_USER_POINTS) {
      const i = this.strokes.findIndex((s) => s.ip === ip && !s.open);
      if (i < 0) return false;
      this.drop(i);
    }
    return true;
  }

  /** usage per IP (for tests) */
  usageOf(ip: string) {
    return this.usage.get(ip);
  }

  /** Drop strokes whose every point has faded, and the oldest ones when over the caps. */
  prune() {
    const now = this.opts.now();
    this.lastPrune = now;
    for (let i = this.strokes.length - 1; i >= 0; i--) if (now > goneAt(this.strokes[i]!)) this.drop(i);
    while (this.strokes.length > DOODLE.maxStrokes || this.points > DOODLE.maxBufferedPoints) this.drop(0);
    // (a phrase a bot never finished is forgotten after a minute)
    this.recent = this.recent.filter((r) => r.until > now && now - r.t < 60_000);
    // (nobody at it, or a socket that died without a close: its place goes to someone else)
    for (const c of [...this.clients]) if (now - c.lastSeen > this.opts.idleMs) this.kick(c, 4408, "gone quiet");
  }

  send(client: HomeClient, msg: string) {
    if (client.closed) return;
    if (client.sock.buffered() > MAX_BUFFERED) return this.kick(client, 1013, "too slow");
    client.sock.send(msg);
  }

  broadcast(msg: string, except?: HomeClient) {
    for (const c of this.clients) if (c !== except) this.send(c, msg);
  }

  private startBots() {
    if (this.timer || !this.bots.length) return;
    this.lastTick = this.opts.now();
    // (a room starting, or starting over: the kid's fear from the start, the count from the top)
    this.bornAt = this.lastTick;
    this.saidAt.clear();
    // they come in one at a time, in no particular order
    const order = [...this.bots].sort(() => Math.random() - 0.5);
    let at = this.lastTick + rand(FIRST_IN_MS[0], FIRST_IN_MS[1]);
    for (const b of order) {
      b.comeInAt(at);
      at += rand(NEXT_IN_MS[0], NEXT_IN_MS[1]);
    }
    this.timer = setInterval(() => this.tick(), this.opts.tickMs);
  }

  private stopBots() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get botsRunning() {
    return !!this.timer;
  }

  /** Advance the bots by `ms` (the interval calls this; tests can too). */
  tick(ms?: number) {
    const now = this.opts.now();
    const dt = Math.min(250, ms ?? now - this.lastTick);
    this.lastTick = now;
    if (now >= this.nextFightAt) this.maybeFight(now);
    for (const b of this.bots) b.step(dt);
    if (now - this.lastPrune >= 1000) this.prune();
  }

  /** A bot near another pencil may pick a fight with it (now and then: per-bot cooldowns and a room-wide gap). */
  private maybeFight(now: number) {
    for (const b of this.bots) {
      if (!b.ready(now)) continue;
      for (const o of this.bots) {
        if (o === b || !o.ready(now) || Math.hypot(o.x - b.x, o.y - b.y) > 130 || Math.random() > 0.08) continue;
        b.duel(o);
        this.nextFightAt = now + rand(3000, 5000);
        return;
      }
      for (const c of this.clients) {
        if (c.hidden || c.peer.x === undefined || c.peer.y === undefined) continue;
        if (Math.hypot(c.peer.x - b.x, c.peer.y - b.y) > 110 || Math.random() > 0.03) continue;
        b.startFight(c);
        this.nextFightAt = now + rand(3000, 5000);
        return;
      }
    }
  }

  /** A person's pencil moved from (fx, fy): jabbing a bot's body quickly may make it chase them. */
  private poked(client: HomeClient, fx: number, fy: number) {
    const x = client.peer.x!;
    const y = client.peer.y!;
    if (Math.hypot(x - fx, y - fy) < 6) return;
    const now = this.opts.now();
    for (const b of this.bots) {
      if (!b.ready(now) || !touchesBody(x - b.x, y - b.y)) continue;
      if (now >= this.nextFightAt - 2500 && Math.random() < 0.5) {
        b.startFight(client);
        this.nextFightAt = now + rand(3000, 5000);
      }
      return;
    }
  }

  /** Where the bots keep to: DOODLE.bot, narrowed to the smallest window here (a phone shows ±195 around the middle). */
  area(): BotArea {
    return this.botArea;
  }
  private botArea: BotArea = { ...DOODLE.bot };

  private computeArea(): BotArea {
    const A = DOODLE.bot;
    let hw = A.maxX;
    let maxY = A.maxY;
    for (const c of this.clients) {
      if (!c.view) continue;
      hw = Math.min(hw, c.view.w / 2 - EDGE_X);
      maxY = Math.min(maxY, c.view.h - EDGE_Y);
    }
    return { minX: -Math.max(110, hw), maxX: Math.max(110, hw), minY: A.minY, maxY: Math.max(A.minY + 180, maxY) };
  }

  /** The area changed (someone with a smaller window came): bots outside it, or about to write outside it, start over
   *  inside it. */
  private refit() {
    const a = this.computeArea();
    const was = this.botArea;
    if (a.minX === was.minX && a.maxX === was.maxX && a.minY === was.minY && a.maxY === was.maxY) return;
    this.botArea = a;
    for (const b of this.bots) b.fit(a);
  }

  /** A place for a phrase in the bots' area, away from the phrases still showing. */
  placePhrase(who: Character, chosen?: string): { text: string; lines: string[]; cx: number; cy: number; size: number; angle: number; box: Box } {
    const text = chosen ?? pickLine(this.linesFor(who), this.recentSayings)!;
    this.saidAt.set(text, this.opts.now());
    this.recentSayings.push(text);
    if (this.recentSayings.length > 60) this.recentSayings.shift();
    const A = this.area();
    // narrow (a phone is here): shorter lines, smaller and straighter writing
    const narrow = A.maxX - A.minX < 600;
    const lines = wrapPhrase(text, narrow ? who.narrowWrap : who.wrap);
    const m = measurePhrase(lines, who.hand);
    const best = this.findSpot(m, () => rand(who.size[0], who.size[1]) * (lines.length > 1 ? 0.9 : 1) * (narrow ? 0.75 : 1), who.tilt * (narrow ? 0.5 : 1), 15);
    return { text, lines, ...best };
  }

  /** A place for one of moist-burrito's drawings, like a phrase's: as tall as it says (smaller
   *  on a phone), away from what's still showing. */
  placeDrawing(d: Drawing): { cx: number; cy: number; size: number; angle: number; box: Box } {
    const A = this.area();
    const narrow = A.maxX - A.minX < 600;
    const [lo, hi] = d.height;
    return this.findSpot({ w: d.aspect * 21, h: 21 }, () => rand(lo, hi) * (narrow ? 0.6 : 1), narrow ? 4 : 8, 40);
  }

  /** Somewhere in the bots' area for something `m` big (glyph units: 21 = `size` tall), tilted up to `tilt` degrees,
   *  shrunk to fit down to `minSize`, near `near` if there's room: the spot overlapping least what's still showing. */
  private findSpot(m: { w: number; h: number }, sizeOf: () => number, tilt: number, minSize: number): { cx: number; cy: number; size: number; angle: number; box: Box } {
    const A = this.area();
    let best: { cx: number; cy: number; size: number; angle: number; box: Box } | null = null;
    let bestHits = Infinity;
    for (let tries = 0; tries < 150; tries++) {
      let size = sizeOf();
      const angle = (rand(-tilt, tilt) * Math.PI) / 180;
      const extent = (size: number) => {
        const hw = (m.w * size) / 21 / 2 + 6;
        const hh = (m.h * size) / 21 / 2 + 4;
        return { hw, hh, ex: Math.abs(hw * Math.cos(angle)) + Math.abs(hh * Math.sin(angle)), ey: Math.abs(hw * Math.sin(angle)) + Math.abs(hh * Math.cos(angle)) };
      };
      let e = extent(size);
      // too big for the area: smaller (down to minSize), else try another angle
      const fit = Math.min((A.maxX - A.minX) / (e.ex * 2), (A.maxY - A.minY) / (e.ey * 2));
      if (fit < 1) {
        size = Math.floor(size * fit * 0.97 * 10) / 10;
        if (size < minSize) continue;
        e = extent(size);
        if (e.ex * 2 > A.maxX - A.minX || e.ey * 2 > A.maxY - A.minY) continue;
      }
      const { hw, hh, ex, ey } = e;
      // a third of them near the middle, so narrow (phone) windows see some too
      const spanX = Math.random() < 0.33 ? Math.min(A.maxX - ex, 120) : A.maxX - ex;
      const cx = rand(Math.max(A.minX + ex, -spanX), Math.min(A.maxX - ex, spanX));
      const cy = rand(A.minY + ey, A.maxY - ey);
      const box = { cx, cy, hw, hh, angle };
      // overlapping a phrase that will show for longer costs more: one about to fade away is nearly free to write over
      const now = this.opts.now();
      let hits = 0;
      for (const r of this.recent) if (r.until > now && boxesOverlap(r.box, box, 10)) hits += 0.2 + Math.min(1, (r.until - now) / (INK_MS + INK_FADE_MS)) * 4;
      if (hits < bestHits) {
        best = { cx, cy, size, angle, box };
        bestHits = hits;
        if (hits === 0) break;
      }
    }
    if (!best) {
      // nothing fits: the smallest, in the middle
      const cy = (A.minY + A.maxY) / 2;
      const size = minSize;
      best = { cx: 0, cy, size, angle: 0, box: { cx: 0, cy, hw: (m.w * size) / 42 + 6, hh: (m.h * size) / 42 + 4, angle: 0 } };
    }
    this.recent.push({ box: best.box, t: this.opts.now(), until: Infinity });
    return best;
  }

  /** Room for another phrase: fewer fresh ones in the bots' area than it holds (see AREA_PER_PHRASE). A phrase stops
   *  counting NEXT_LEAD_MS before it starts to fade (the next one's on its way in as it goes: no blank page), and one
   *  from a wider window that's now off the side doesn't count. */
  hasRoom(): boolean {
    const A = this.area();
    const now = this.opts.now();
    const inside = (b: Box) => b.cx >= A.minX && b.cx <= A.maxX && b.cy >= A.minY && b.cy <= A.maxY;
    const fresh = this.recent.filter((r) => r.until - now > INK_FADE_MS + NEXT_LEAD_MS && inside(r.box)).length;
    return fresh < Math.max(2, Math.floor(((A.maxX - A.minX) * (A.maxY - A.minY)) / AREA_PER_PHRASE));
  }

  /** A bot gave up on the phrase in `box` before putting any ink down: forget it. */
  cancelPhrase(box: Box) {
    this.recent = this.recent.filter((r) => r.box !== box);
  }

  /** what each bot that draws did last (a line, or a drawing's id): nothing twice running */
  private lastTurn = new Map<string, string>();

  /** when this room's bots started (its life, for the kid's stages), and when each line was last written in it (for
   *  IN_ORDER); both start over when the room empties */
  private bornAt = 0;
  private saidAt = new Map<string, number>();

  /** The lines `who` may write now: its stage's (by the room's age), less any IN_ORDER line that isn't due. */
  linesFor(who: Character): string[] {
    const now = this.opts.now();
    let lines = who.lines;
    if (who.stages) {
      const min = (now - this.bornAt) / 60_000;
      lines = who.stages.filter((s) => s.fromMin <= min).at(-1)?.lines ?? who.stages[0]!.lines;
    }
    const due = lines.filter((l) => {
      const order = IN_ORDER.find((o) => o.includes(l));
      if (!order) return true;
      if (this.saidAt.has(l)) return false;
      const i = order.indexOf(l);
      const before = i > 0 ? this.saidAt.get(order[i - 1]!) : undefined;
      return i === 0 || (before !== undefined && now - before >= IN_ORDER_GAP_MIN * 60_000);
    });
    return due.length ? due : lines;
  }

  /** What `who` does next: a line (chosen here for a bot that draws; else placePhrase picks it), or a drawing. */
  pickTurn(who: Character): { line?: string; drawing?: Drawing } {
    if (!who.draws) return {};
    const last = this.lastTurn.get(who.key);
    if (Math.random() >= who.draws) {
      const line = pickLine(this.linesFor(who).filter((l) => l !== last), this.recentSayings);
      if (line) {
        this.lastTurn.set(who.key, line);
        return { line };
      }
    }
    const pool = DRAWINGS.filter((d) => d.id !== last);
    const d = pool[Math.floor(Math.random() * pool.length)]!;
    this.lastTurn.set(who.key, d.id);
    return { drawing: d };
  }

  /** A bot finished writing the phrase in `box` (or gave up on it): it's gone once its last points fade, and someone
   *  else may write. */
  finishPhrase(box: Box) {
    const r = this.recent.find((r) => r.box === box);
    if (r) r.until = this.opts.now() + INK_MS + INK_FADE_MS;
  }

  stop() {
    this.stopBots();
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = null;
    this.held.clear();
    for (const c of [...this.clients]) c.sock.close(1001, "server stopping");
    this.clients.clear();
  }
}

/** `gap`: between lines (pages only bring a bot's pencil in then, never mid-line); a move from height `fz` to `tz`
 *  (with a hump of `lift`), else from and to the paper */
type Action =
  | { kind: "move"; fx: number; fy: number; tx: number; ty: number; dur: number; t: number; lift: number; fz?: number; tz?: number; gap?: boolean }
  | { kind: "draw"; pts: number[]; i: number; speed: number; w: number; press: number; wobble: number; rec?: StrokeRec; travelled: number; total: number; carry: number; exact?: boolean; c?: string }
  | { kind: "pause"; left: number; done?: Box; gap?: boolean };

/** A bot's fight: square up beside the foe, jab and swing at it a few times, then retreat. */
interface Fight {
  foe: Bot | HomeClient;
  t: number;
  dur: number;
  /** which side of the foe it stands on (+1: to the right) */
  side: number;
  /** a duel between bots stays around this spot */
  ax: number;
  ay: number;
  nextJab: number;
  jab: { t: number; dur: number; swing: boolean } | null;
}

/** Pencils lean the same way on every screen (tip up-left, eraser down-right along about (0.52, 0.85)): is a tip at
 *  (dx, dy) from a pencil's tip touching its body? */
function touchesBody(dx: number, dy: number): boolean {
  const along = dx * 0.52 + dy * 0.85;
  return Math.abs(dx * 0.85 - dy * 0.52) < 22 && along > -25 && along < 200;
}

/** A pencil on the server that writes sayings: travel (lifted), write each stroke, hop between strokes, pause. */
class Bot {
  x = rand(-300, 300);
  y = rand(200, 600);
  z = 40;
  private plan: Action[] = [];
  private lastSent = "";
  /** some of the phrase it's on is on the page */
  private inked = false;
  /** the strokes of the line or drawing it's on (finished together: room.inkDone) */
  private phraseRecs: StrokeRec[] = [];
  /** waiting for a turn since (a full page, on a phone): turns go to whoever has waited longest */
  waitingSince: number | null = null;
  /** time left over from a tick in which a drawing's stroke ended (it goes on to the next tick) */
  private spareMs = 0;
  /** not here yet: comes in then (0: here); coming in: its first line starts with the entrance */
  private enterAt = 0;
  private entering = false;

  /** Come in at `at` (the room's bots are starting): till then it does nothing and shows nowhere. */
  comeInAt(at: number) {
    this.dropPlan();
    this.enterAt = at;
    this.entering = false;
    this.fight = null;
  }

  /** between lines (or not here yet): a page may bring its pencil in now */
  private get between(): boolean {
    const a = this.plan[0];
    return !this.fight && !this.enterAt && !this.entering && !!a && a.kind !== "draw" && !!a.gap;
  }
  fight: Fight | null = null;
  /** no fights before this */
  private readyAt: number;

  constructor(
    private room: HomeRoom,
    readonly peer: Peer,
    readonly cast: Character,
  ) {
    this.readyAt = room.opts.now() + rand(3000, 8000);
  }

  /** free to fight: not fighting already, and between lines (they write slowly: a fight mustn't cut one off) */
  ready(now: number): boolean {
    return !this.fight && !this.enterAt && now >= this.readyAt && !this.plan.some((a) => a.kind === "draw");
  }

  /** Drop whatever it was doing (a stroke being written ends where it is). */
  private dropPlan() {
    for (const a of this.plan) {
      if (a.kind === "draw" && a.rec?.open) {
        this.room.close(a.rec);
        this.room.broadcast(JSON.stringify({ t: "s", id: a.rec.id, u: a.rec.u, c: a.rec.c, w: a.rec.w, p: [], e: 1 }));
      } else if (a.kind === "pause" && a.done) {
        // (nothing of it on the page yet: it mustn't hold a turn)
        if (this.inked) this.room.finishPhrase(a.done);
        else this.room.cancelPhrase(a.done);
        // (what it did write of it fades from now)
        this.room.inkDone(this.phraseRecs.splice(0));
      }
    }
    this.plan = [];
  }

  startFight(foe: Bot | HomeClient, dur = rand(2000, 4000), side?: number, ax?: number, ay?: number) {
    const p = foePos(foe);
    if (!p) return;
    this.dropPlan();
    // (not waiting for a turn while it fights: others mustn't wait behind it)
    this.waitingSince = null;
    this.fight = { foe, t: 0, dur, side: side ?? (this.x >= p.x ? 1 : -1), ax: ax ?? p.x, ay: ay ?? p.y, nextJab: rand(350, 700), jab: null };
  }

  /** A sword fight with another bot: both square up around the spot between them. */
  duel(o: Bot) {
    const dur = rand(2500, 4000);
    const side = this.x >= o.x ? 1 : -1;
    const A = this.room.area();
    const ax = clamp((this.x + o.x) / 2, A.minX + 40, A.maxX - 40);
    const ay = clamp((this.y + o.y) / 2, A.minY, A.maxY);
    this.startFight(o, dur, side, ax, ay);
    o.startFight(this, dur, -side, ax, ay);
  }

  private endFight() {
    const f = this.fight!;
    this.fight = null;
    this.readyAt = this.room.opts.now() + rand(8000, 15000);
    const A = this.room.area();
    const tx = clamp(this.x + f.side * rand(120, 220), A.minX, A.maxX);
    const ty = clamp(this.y + rand(-80, 80), A.minY, A.maxY);
    this.plan.push({ kind: "move", fx: this.x, fy: this.y, tx, ty, dur: 700, t: 0, lift: 60 });
    this.plan.push({ kind: "pause", left: rand(300, 800) });
  }

  private fightStep(dt: number) {
    const f = this.fight!;
    f.t += dt;
    const p = foePos(f.foe);
    const vsBot = f.foe instanceof Bot;
    if (!p || f.t >= f.dur || (f.foe instanceof Bot && f.foe.fight?.foe !== this) || (!vsBot && Math.hypot(p.x - this.x, p.y - this.y) > 450)) return this.endFight();
    const sx = vsBot ? f.ax + f.side * 36 : p.x + f.side * 65;
    const sy = vsBot ? f.ay : p.y;
    // a hit lands just beside the foe's tip, so the bodies touch (that's what clients see as a clash)
    const hx = p.x + f.side * 14;
    const hy = p.y;
    if (!f.jab && f.t >= f.nextJab && f.t < f.dur - 300) {
      const swing = Math.random() < 0.3;
      f.jab = { t: 0, dur: swing ? rand(420, 520) : rand(240, 300), swing };
      // the other bot often meets it with a jab of its own: the pencils clash in the middle
      if (f.foe instanceof Bot && f.foe.fight && !f.foe.fight.jab && Math.random() < 0.5) f.foe.fight.jab = { t: 0, dur: 240, swing: false };
    }
    let tx = sx;
    let ty = sy;
    let tz: number;
    let rate: number;
    const j = f.jab;
    if (j) {
      j.t += dt;
      const u = j.t / j.dur;
      if (j.swing) {
        // wind up (lift and pull back), slash down onto it, recoil
        if (u < 0.45) {
          tx = sx + f.side * 14 * (u / 0.45);
          ty = sy - 12 * (u / 0.45);
          tz = 12 + 48 * (u / 0.45);
          rate = 10;
        } else if (u < 0.62) {
          tx = hx;
          ty = hy;
          tz = 0;
          rate = 45;
        } else {
          tz = 12;
          rate = 9;
        }
      } else if (u < 0.38) {
        tx = hx;
        ty = hy;
        tz = 4;
        rate = 40;
      } else {
        tz = 12;
        rate = 10;
      }
      if (j.t >= j.dur) {
        f.jab = null;
        f.nextJab = f.t + rand(200, 600);
      }
    } else {
      // bounce on the spot, sizing the other one up
      tx += Math.sin(f.t / 110) * 4;
      ty += Math.sin(f.t / 170) * 5;
      tz = 12 + 9 * Math.abs(Math.sin(f.t / 160));
      rate = 8;
    }
    const k = 1 - Math.exp((-rate * dt) / 1000);
    let mx = (tx - this.x) * k;
    let my = (ty - this.y) * k;
    const cap = j ? Infinity : 1.3 * dt;
    const m = Math.hypot(mx, my);
    if (m > cap) {
      mx *= cap / m;
      my *= cap / m;
    }
    // (chasing someone off the edge of a narrow window: it stops at the edge)
    const A = this.room.area();
    this.x = clamp(this.x + mx, A.minX, A.maxX);
    this.y = clamp(this.y + my, A.minY, A.maxY);
    this.z += (tz - this.z) * k;
  }

  /** Keep to the area `a`: when it, or what it's about to write, is outside, drop that and go back in. */
  fit(a: BotArea) {
    const inside = (x: number, y: number) => x >= a.minX - 1 && x <= a.maxX + 1 && y >= a.minY - 1 && y <= a.maxY + 1;
    const out = !inside(this.x, this.y) || this.plan.some((p) => (p.kind === "move" ? !inside(p.tx, p.ty) : p.kind === "draw" && p.pts.some((v, i) => i % 2 === 0 && !inside(v, p.pts[i + 1]!))));
    if (!out) return;
    if (this.fight) this.fight = null;
    this.dropPlan();
    const tx = clamp(this.x, a.minX, a.maxX);
    const ty = clamp(this.y, a.minY, a.maxY);
    if (tx !== this.x || ty !== this.y) this.plan.push({ kind: "move", fx: this.x, fy: this.y, tx, ty, dur: 600, t: 0, lift: 50, gap: true });
    this.plan.push({ kind: "pause", left: rand(200, 600), gap: true });
  }

  /** For a newcomer's hello: where it is; whether it's between lines (g); how long until it comes in (in, ms). */
  info(): Peer & { z: number; g?: 1; in?: number } {
    const wait = this.enterAt ? Math.max(0, this.enterAt - this.room.opts.now()) : 0;
    return { ...this.peer, x: round1(this.x), y: round1(this.y), z: Math.round(this.z), ...(this.between ? { g: 1 as const } : {}), ...(wait ? { in: Math.round(wait) } : {}) };
  }

  private planNext() {
    // (someone just in hasn't said how big their window is: wait for that, so the line fits it)
    if (this.room.viewsPending()) {
      this.plan.push({ kind: "pause", left: 100, gap: true });
      return;
    }
    // (a full page, on a phone: wait for a line to fade, and then for the ones that have waited longer)
    const since = this.waitingSince;
    const behind = this.room.bots.some((b) => b !== this && b.waitingSince !== null && (since === null || b.waitingSince < since));
    if (!this.room.hasRoom() || behind) {
      this.waitingSince ??= this.room.opts.now();
      this.plan.push({ kind: "pause", left: 500, gap: true });
      return;
    }
    this.waitingSince = null;
    const c = this.cast;
    const turn = this.room.pickTurn(c);
    const seed = Math.floor(Math.random() * 2 ** 31);
    let strokes: number[][];
    // a drawing's marks: contours, hatching (scribbled fast, heavier) or light lines
    let kinds: (MarkKind | undefined)[] = [];
    let secs = 0;
    // the writing's size (cap height): its pace and line width go by it (a drawing's, by a fifth of its height)
    let size: number;
    let ph: { box: Box };
    if (turn.drawing) {
      const d = turn.drawing;
      const at = this.room.placeDrawing(d);
      const marks = drawPicture(d.make(Math.random), { cx: at.cx, cy: at.cy, size: at.size, angle: at.angle, seed, hand: c.hand });
      strokes = marks.map((m) => m.pts);
      kinds = marks.map((m) => m.kind);
      secs = rand(d.secs[0], d.secs[1]);
      size = clamp(at.size / 5, 18, 32);
      ph = { box: at.box };
    } else {
      const placed = this.room.placePhrase(c, turn.line);
      strokes = writePhrase(placed.lines, { cx: placed.cx, cy: placed.cy, size: placed.size, angle: placed.angle, seed, hand: c.hand }).strokes;
      size = placed.size;
      ph = placed;
    }
    this.inked = false;
    keepInside(strokes, this.room.area());
    const w = Math.round(clamp(size * c.width[0], c.width[1], c.width[2]) * 100) / 100;
    const [sx0, sy0] = [strokes[0]![0]!, strokes[0]![1]!];
    if (this.entering) {
      // coming in: it shows (pages fade it in) hovering where its first line starts
      this.entering = false;
      [this.x, this.y, this.z] = [sx0, sy0, HOVER];
      this.plan.push({ kind: "pause", left: rand(FADE_IN_MS[0], FADE_IN_MS[1]), gap: true });
    } else {
      // over to where the line starts, hovering (the hop fits in what's left of the gap: see GAP_MS)
      const d = Math.hypot(sx0 - this.x, sy0 - this.y);
      this.plan.push({ kind: "move", fx: this.x, fy: this.y, tx: sx0, ty: sy0, dur: clamp(d / (0.6 * c.hop), APPROACH_MS[0], APPROACH_MS[1]), t: 0, lift: 25, fz: this.z, tz: HOVER, gap: true });
    }
    // the tip goes down to the paper, and it waits a moment before writing
    this.plan.push({ kind: "move", fx: sx0, fy: sy0, tx: sx0, ty: sy0, dur: SETTLE_MS, t: 0, lift: 0, fz: HOVER, tz: 0, gap: true });
    this.plan.push({ kind: "pause", left: rand(READY_MS[0], READY_MS[1]), gap: true });
    // between strokes: a breath, and the hop over (within a drawing, quicker; between two of its scribbles, a flick)
    const hops: { wait: number; dur: number; d: number }[] = [];
    let x = sx0;
    let y = sy0;
    for (const [i, pts] of strokes.entries()) {
      const d = Math.hypot(pts[0]! - x, pts[1]! - y);
      const flick = kinds[i] === "hatch" && kinds[i - 1] === "hatch";
      hops.push(
        i === 0 ? { wait: 0, dur: 0, d }
        : flick ? { wait: rand(0, 30), dur: clamp(d / (0.8 * c.hop), 50, 200), d }
        : secs ? { wait: rand(20, 70), dur: clamp(d / (0.8 * c.hop), 80, 300), d }
        : { wait: rand(c.dawdle[0], c.dawdle[1]), dur: clamp(d / (0.4 * c.hop), 140 / c.hop, 600 / c.hop), d },
      );
      x = pts[pts.length - 2]!;
      y = pts[pts.length - 1]!;
    }
    const lengths = strokes.map((pts) => {
      let total = 0;
      for (let j = 2; j < pts.length; j += 2) total += Math.hypot(pts[j]! - pts[j - 2]!, pts[j + 1]! - pts[j - 1]!);
      return total;
    });
    // its pace: writing goes at the writer's speed; a drawing is fitted to its `secs`, the scribbling five times as
    // fast as the contours, and its last mark (the finishing touch) slower
    const speedOf = this.drawingPace(secs, strokes.length, kinds, lengths, hops, size);
    x = sx0;
    y = sy0;
    strokes.forEach((pts, i) => {
      const hop = hops[i]!;
      if (i > 0) {
        this.plan.push({ kind: "pause", left: hop.wait });
        this.plan.push({ kind: "move", fx: x, fy: y, tx: pts[0]!, ty: pts[1]!, dur: hop.dur, t: 0, lift: clamp(hop.d * 0.15, 4, 16) });
      }
      // (hatching and fine detail pressed hard: darker, in a deeper shade of its pencil's colour)
      const k = kinds[i];
      const press = k === "hatch" ? rand(0.9, 1) : k === "light" ? rand(0.4, 0.55) : k === "fine" ? rand(0.85, 0.95) : rand(c.press[0], c.press[1]);
      const sw = k === "hatch" ? w * 1.9 : k === "light" ? w * 0.8 : k === "fine" ? w * 0.6 : w;
      const col = k === "hatch" || k === "fine" ? { c: shade(this.peer.color, 0.45) } : {};
      this.plan.push({ kind: "draw", pts, i: 0, speed: speedOf(i), w: Math.round(sw * 100) / 100, press, wobble: c.pressWobble, travelled: 0, total: lengths[i]!, carry: 0, ...(secs ? { exact: true } : {}), ...col });
      x = pts[pts.length - 2]!;
      y = pts[pts.length - 1]!;
    });
    // then it lifts off and rests: with the hop over to the next, the settle and the wait, GAP_MS
    this.plan.push({ kind: "move", fx: x, fy: y, tx: x, ty: y, dur: LIFT_MS, t: 0, lift: 0, fz: 0, tz: HOVER, gap: true });
    const rest = rand(GAP_MS[0], GAP_MS[1]) - LIFT_MS - APPROACH_MS[1] - SETTLE_MS - READY_MS[1];
    this.plan.push({ kind: "pause", left: Math.max(0, rest), done: ph.box, gap: true });
  }

  /** Each stroke's speed (px/s): the writer's own pace; or, for a drawing (`secs` > 0), contours at a deliberate pace
   *  (a bit brisker than its writing; the last mark, the finishing touch, slower), and the scribbling as fast as it must
   *  be for the whole to take about `secs`, hops and all. */
  private drawingPace(secs: number, n: number, kinds: (MarkKind | undefined)[], lengths: number[], hops: { wait: number; dur: number }[], size: number): (i: number) => number {
    const c = this.cast;
    if (!secs) return () => size * rand(c.speed[0], c.speed[1]);
    const vc = size * c.speed[0] * 1.7;
    let contour = 0;
    let scribble = 0;
    for (let i = 0; i < n; i++) (kinds[i] === "hatch" ? (scribble += lengths[i]!) : (contour += lengths[i]! / (i === n - 1 ? 0.6 : 1)));
    // (each stroke eases in over its first 25 px: about 20 px more to go)
    const overhead = hops.reduce((t, h) => t + h.wait + h.dur, 0) / 1000 + (contour + 20 * n) / vc;
    const vh = clamp(scribble / Math.max(0.5, secs - overhead), 800, 4000);
    return (i) => (i === n - 1 ? vc * 0.6 : kinds[i] === "hatch" ? vh : vc) * rand(0.92, 1.08);
  }

  step(dt: number) {
    if (this.enterAt) {
      if (this.room.opts.now() < this.enterAt) return;
      this.enterAt = 0;
      this.entering = true;
    }
    if (this.fight) {
      this.fightStep(dt);
      return this.sendCursor();
    }
    const out: number[] = [];
    let rec: StrokeRec | undefined;
    let ended = false;
    dt += this.spareMs;
    this.spareMs = 0;
    while (dt > 0) {
      if (!this.plan.length) this.planNext();
      const a = this.plan[0]!;
      if (a.kind === "pause") {
        if (a.done) {
          this.room.finishPhrase(a.done);
          this.room.inkDone(this.phraseRecs.splice(0));
        }
        a.done = undefined;
        const used = Math.min(dt, a.left);
        a.left -= used;
        dt -= used;
        if (a.left <= 0) this.plan.shift();
      } else if (a.kind === "move") {
        const used = Math.min(dt, a.dur - a.t);
        a.t += used;
        dt -= used;
        const u = a.t / a.dur;
        const e = u * u * (3 - 2 * u);
        const len = Math.hypot(a.tx - a.fx, a.ty - a.fy);
        const bow = Math.sin(Math.PI * e) * Math.min(len * 0.08, 30);
        const nx = len ? -(a.ty - a.fy) / len : 0;
        const ny = len ? (a.tx - a.fx) / len : 0;
        const A = this.room.area();
        this.x = clamp(a.fx + (a.tx - a.fx) * e + nx * bow, Math.min(A.minX, a.fx, a.tx), Math.max(A.maxX, a.fx, a.tx));
        this.y = clamp(a.fy + (a.ty - a.fy) * e + ny * bow, Math.min(A.minY, a.fy, a.ty), Math.max(A.maxY, a.fy, a.ty));
        if (a.fz !== undefined || a.tz !== undefined) this.z = Math.max(0, (a.fz ?? 0) + ((a.tz ?? 0) - (a.fz ?? 0)) * e + a.lift * Math.sin(Math.PI * e));
        else this.z = Math.max(a.lift * Math.sin(Math.PI * Math.min(1, u * 1.15)), u > 0.9 ? 0 : 2);
        if (a.t >= a.dur) this.plan.shift();
      } else {
        if (rec && a.rec !== rec) break; // one stroke per batch
        if (!a.rec) {
          a.rec = this.room.addStroke(this.peer, a.w, "", a.c);
          this.phraseRecs.push(a.rec);
          a.i = 0;
        }
        rec = a.rec;
        this.z = 0;
        // ease in at the start of a stroke
        const speed = a.speed * (0.55 + 0.45 * Math.min(1, a.travelled / 25));
        // (slow writers move less than a point's spacing per tick: what's left over carries on to the next)
        let budget = a.carry + (speed * dt) / 1000;
        dt = 0;
        while (a.i < a.pts.length && budget >= 0) {
          const px = a.pts[a.i]!;
          const py = a.pts[a.i + 1]!;
          const d = Math.hypot(px - this.x, py - this.y);
          if (a.i > 0 && d > budget) {
            a.carry = budget;
            break;
          }
          budget -= d;
          a.travelled += d;
          this.x = px;
          this.y = py;
          const u = a.travelled / Math.max(1, a.total);
          const taper = Math.min(1, a.travelled / 10) * Math.min(1, (a.total - a.travelled) / 8 + 0.35);
          const p = clamp(a.press * (0.55 + 0.45 * taper) * (1 - a.wobble + a.wobble * Math.sin(u * 19 + a.total)), 0.15, 1);
          out.push(round1(px), round1(py), Math.round(p * 100) / 100);
          this.inked = true;
          a.i += 2;
        }
        if (a.i >= a.pts.length) {
          ended = true;
          // (a drawing keeps to its time: what's left of this tick goes on to the next)
          if (a.exact) this.spareMs = (Math.max(0, budget) / speed) * 1000;
          this.room.close(a.rec);
          this.plan.shift();
          break;
        }
      }
    }
    if (rec) {
      this.room.append(rec, out);
      this.room.broadcast(JSON.stringify({ t: "s", id: rec.id, u: rec.u, c: rec.c, w: rec.w, p: out, ...(ended ? { e: 1 } : {}) }));
      this.lastSent = "";
      return;
    }
    this.sendCursor();
  }

  private sendCursor() {
    // (not here yet: nothing to show until it comes in, where its first line starts)
    if (this.enterAt || this.entering) return;
    const cur = JSON.stringify({ t: "c", id: this.peer.id, x: round1(this.x), y: round1(this.y), z: Math.round(this.z), ...(this.between ? { g: 1 } : {}) });
    if (cur !== this.lastSent) this.room.broadcast(cur);
    this.lastSent = cur;
  }
}

/** `hex` (#rrggbb) darkened: each channel times (1 - k) */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(v * (1 - k)).toString(16).padStart(2, "0");
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

/** a phrase stops holding its place on a full page this long before its ink starts to fade */
const NEXT_LEAD_MS = 5_000;

/** Handwriting strays a little past its box: slide a phrase's strokes ([x, y, …] each) back inside the area `a`
 *  (and clamp what still sticks out, if it's wider than the area). */
function keepInside(strokes: number[][], a: BotArea) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of strokes)
    for (let i = 0; i + 1 < s.length; i += 2) {
      x0 = Math.min(x0, s[i]!);
      x1 = Math.max(x1, s[i]!);
      y0 = Math.min(y0, s[i + 1]!);
      y1 = Math.max(y1, s[i + 1]!);
    }
  const dx = x0 < a.minX ? a.minX - x0 : x1 > a.maxX ? a.maxX - x1 : 0;
  const dy = y0 < a.minY ? a.minY - y0 : y1 > a.maxY ? a.maxY - y1 : 0;
  if (!dx && !dy) return;
  for (const s of strokes)
    for (let i = 0; i + 1 < s.length; i += 2) {
      s[i] = clamp(s[i]! + dx, a.minX, a.maxX);
      s[i + 1] = clamp(s[i + 1]! + dy, a.minY, a.maxY);
    }
}

function foePos(foe: Bot | HomeClient): { x: number; y: number } | null {
  if (foe instanceof Bot) return { x: foe.x, y: foe.y };
  if (foe.closed || foe.hidden || foe.peer.x === undefined || foe.peer.y === undefined) return null;
  return { x: foe.peer.x, y: foe.peer.y };
}

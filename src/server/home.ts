// The home page doodle room (/ws/home): everyone on the home page sees each other's pencils and drawings, plus a
// few bots that write little sayings. Public and unauthenticated, so everything is capped; nothing is saved.
// Protocol and coordinates: src/shared/doodle.ts.
import { DOODLE, PENCIL_COLORS, SAYINGS, type Peer, type Stroke } from "../shared/doodle.ts";
import { boxesOverlap, measurePhrase, wrapPhrase, writePhrase, type Box } from "../shared/handwriting.ts";
import { sillyName } from "../shared/names.ts";

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
}

export interface StrokeRec {
  id: number;
  u: string;
  c: string;
  w: number;
  p: number[];
  t0: number;
  open: boolean;
}

export interface HomeOptions {
  bots?: number;
  tickMs?: number;
  maxConnsPerIp?: number;
  maxConns?: number;
  now?: () => number;
}

const MAX_BUFFERED = 1024 * 1024;
const PER_USER_STROKES = 300;
const PER_USER_POINTS = 20_000;

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export class HomeRoom {
  readonly clients = new Set<HomeClient>();
  readonly strokes: StrokeRec[] = [];
  readonly bots: Bot[] = [];
  private points = 0;
  private nextStroke = 1;
  private nextPeer = 1;
  private perIp = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private recent: { box: Box; t: number }[] = [];
  private recentSayings: string[] = [];
  readonly opts: Required<HomeOptions>;

  constructor(opts: HomeOptions = {}) {
    this.opts = { bots: 3, tickMs: DOODLE.batchMs, maxConnsPerIp: DOODLE.maxConnsPerIp, maxConns: DOODLE.maxConns, now: Date.now, ...opts };
    for (let i = 0; i < this.opts.bots; i++) this.bots.push(new Bot(this, { id: `bot${i + 1}`, name: sillyName(), color: PENCIL_COLORS[[0, 2, 3][i % 3]!]!, bot: true }));
  }

  /** Add a connection, or close it with a reason when over a limit. */
  join(ip: string, sock: HomeSocket): HomeClient | null {
    if (this.clients.size >= this.opts.maxConns) {
      sock.close(1013, "too many people here, try later");
      return null;
    }
    const n = this.perIp.get(ip) ?? 0;
    if (n >= this.opts.maxConnsPerIp) {
      sock.close(4429, "too many connections");
      return null;
    }
    this.perIp.set(ip, n + 1);
    const now = this.opts.now();
    const used = new Set([...this.clients].map((c) => c.peer.color).concat(this.bots.map((b) => b.peer.color)));
    const free = PENCIL_COLORS.filter((c) => !used.has(c));
    const pool = free.length ? free : PENCIL_COLORS;
    const peer: Peer = { id: `p${this.nextPeer++}`, name: sillyName(), color: pool[Math.floor(Math.random() * pool.length)]! };
    const client: HomeClient = { peer, ip, sock, hidden: true, msgTokens: DOODLE.msgsPerSec * 2, ptTokens: DOODLE.pointsPerSec * 2, refilled: now, closed: false };
    this.prune();
    const peers = [...this.bots.map((b) => b.info()), ...[...this.clients].map((c) => (c.hidden ? { id: c.peer.id, name: c.peer.name, color: c.peer.color } : c.peer))];
    const strokes: Stroke[] = this.strokes.map((s) => ({ id: s.id, u: s.u, c: s.c, w: s.w, p: s.p, a: now - s.t0, ...(s.open ? { o: true } : {}) }));
    this.send(client, JSON.stringify({ t: "hi", you: peer, peers, strokes }));
    this.broadcast(JSON.stringify({ t: "j", ...peer }), client);
    this.clients.add(client);
    this.startBots();
    return client;
  }

  leave(client: HomeClient) {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    const n = (this.perIp.get(client.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(client.ip);
    else this.perIp.set(client.ip, n);
    if (client.open) client.open.rec.open = false;
    this.broadcast(JSON.stringify({ t: "l", id: client.peer.id }));
    if (this.clients.size === 0) this.stopBots();
  }

  message(client: HomeClient, raw: string | Uint8Array) {
    if (client.closed) return;
    if (typeof raw !== "string") return;
    if (raw.length > DOODLE.maxMessageBytes) return this.kick(client, 1009, "message too big");
    if (!this.take(client, "msg", 1)) return;
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    const msg = m as Record<string, unknown>;
    if (msg.t === "c") {
      if (msg.h) {
        if (client.hidden) return;
        client.hidden = true;
        return this.broadcast(JSON.stringify({ t: "c", id: client.peer.id, h: 1 }), client);
      }
      if (!isNum(msg.x) || !isNum(msg.y)) return;
      client.hidden = false;
      client.peer.x = round1(clamp(msg.x, DOODLE.minX, DOODLE.maxX));
      client.peer.y = round1(clamp(msg.y, DOODLE.minY, DOODLE.maxY));
      return this.broadcast(JSON.stringify({ t: "c", id: client.peer.id, x: client.peer.x, y: client.peer.y }), client);
    }
    if (msg.t === "s") {
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
      let open = client.open;
      if (open && open.k !== k) {
        open.rec.open = false;
        open = undefined;
      }
      if (!open) {
        if (!pts.length) return;
        open = { k: k as number, rec: this.addStroke(client.peer, 2.2) };
        client.open = open;
      }
      const rec = open.rec;
      const room = DOODLE.maxPointsPerStroke * 3 - rec.p.length;
      const add = pts.slice(0, Math.max(0, room));
      this.append(rec, add);
      const end = !!msg.e || rec.p.length >= DOODLE.maxPointsPerStroke * 3;
      if (end) {
        rec.open = false;
        client.open = undefined;
      }
      client.hidden = false;
      if (add.length >= 3) {
        client.peer.x = add[add.length - 3];
        client.peer.y = add[add.length - 2];
      }
      if (add.length || end) this.broadcast(JSON.stringify({ t: "s", id: rec.id, u: rec.u, c: rec.c, w: rec.w, p: add, ...(end ? { e: 1 } : {}) }), client);
      this.capUser(client.peer.id);
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

  addStroke(peer: Peer, w: number): StrokeRec {
    const rec: StrokeRec = { id: this.nextStroke++, u: peer.id, c: peer.color, w, p: [], t0: this.opts.now(), open: true };
    this.strokes.push(rec);
    return rec;
  }

  append(rec: StrokeRec, pts: number[]) {
    for (const v of pts) rec.p.push(v);
    this.points += pts.length / 3;
  }

  /** Keep one person from filling the whole buffer. */
  private capUser(u: string) {
    let n = 0;
    let pts = 0;
    for (const s of this.strokes) if (s.u === u) (n++, (pts += s.p.length / 3));
    while (n > PER_USER_STROKES || pts > PER_USER_POINTS) {
      const i = this.strokes.findIndex((s) => s.u === u && !s.open);
      if (i < 0) break;
      const [s] = this.strokes.splice(i, 1);
      n--;
      pts -= s!.p.length / 3;
      this.points -= s!.p.length / 3;
    }
  }

  prune() {
    const now = this.opts.now();
    while (this.strokes.length) {
      const s = this.strokes[0]!;
      const old = now - s.t0 > DOODLE.strokeLifeMs;
      if (!old && this.strokes.length <= DOODLE.maxStrokes && this.points <= DOODLE.maxBufferedPoints) break;
      this.strokes.shift();
      this.points -= s.p.length / 3;
      s.open = false;
    }
    this.recent = this.recent.filter((r) => now - r.t < DOODLE.strokeLifeMs);
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
    for (const b of this.bots) b.step(dt);
    if (Math.random() < 0.02) this.prune();
  }

  /** A place for a phrase in the bots' area, away from recent ones. */
  placePhrase(): { lines: string[]; cx: number; cy: number; size: number; angle: number; box: Box } {
    let text = SAYINGS[Math.floor(Math.random() * SAYINGS.length)]!;
    for (let i = 0; i < 8 && this.recentSayings.includes(text); i++) text = SAYINGS[Math.floor(Math.random() * SAYINGS.length)]!;
    this.recentSayings.push(text);
    if (this.recentSayings.length > 30) this.recentSayings.shift();
    const lines = wrapPhrase(text);
    const m = measurePhrase(lines);
    const A = DOODLE.bot;
    let best: { cx: number; cy: number; size: number; angle: number; box: Box } | null = null;
    let bestHits = Infinity;
    for (let tries = 0; tries < 150; tries++) {
      const size = rand(22, 46) * (lines.length > 1 ? 0.85 : 1);
      const angle = (rand(-25, 25) * Math.PI) / 180;
      const s = size / 21;
      const hw = (m.w * s) / 2 + 6;
      const hh = (m.h * s) / 2 + 4;
      const ex = Math.abs(hw * Math.cos(angle)) + Math.abs(hh * Math.sin(angle));
      const ey = Math.abs(hw * Math.sin(angle)) + Math.abs(hh * Math.cos(angle));
      if (ex * 2 > A.maxX - A.minX || ey * 2 > A.maxY - A.minY) continue;
      // a third of them near the middle, so narrow (phone) windows see some too
      const spanX = Math.random() < 0.33 ? Math.min(A.maxX - ex, 120) : A.maxX - ex;
      const cx = rand(Math.max(A.minX + ex, -spanX), Math.min(A.maxX - ex, spanX));
      const cy = rand(A.minY + ey, A.maxY - ey);
      const box = { cx, cy, hw, hh, angle };
      // overlapping a newer phrase costs more; once the page is full, the oldest get written over
      const now = this.opts.now();
      let hits = 0;
      for (const r of this.recent) if (boxesOverlap(r.box, box, 10)) hits += 1 + Math.max(0, 1 - (now - r.t) / DOODLE.strokeLifeMs) * 4;
      if (hits < bestHits) {
        best = { cx, cy, size, angle, box };
        bestHits = hits;
        if (hits === 0) break;
      }
    }
    best ??= { cx: 0, cy: (A.minY + A.maxY) / 2, size: 22, angle: 0, box: { cx: 0, cy: 400, hw: 100, hh: 20, angle: 0 } };
    this.recent.push({ box: best.box, t: this.opts.now() });
    return { lines, ...best };
  }

  stop() {
    this.stopBots();
    for (const c of [...this.clients]) c.sock.close(1001, "server stopping");
    this.clients.clear();
  }
}

type Action =
  | { kind: "move"; fx: number; fy: number; tx: number; ty: number; dur: number; t: number; lift: number }
  | { kind: "draw"; pts: number[]; i: number; speed: number; w: number; press: number; rec?: StrokeRec; travelled: number; total: number }
  | { kind: "pause"; left: number };

/** A pencil on the server that writes sayings: travel (lifted), write each stroke, hop between strokes, pause. */
class Bot {
  x = rand(-300, 300);
  y = rand(200, 600);
  z = 40;
  private plan: Action[] = [];
  private phrases = 0;
  private lastSent = "";

  constructor(
    private room: HomeRoom,
    readonly peer: Peer,
  ) {}

  info(): Peer {
    return { ...this.peer, x: round1(this.x), y: round1(this.y) };
  }

  private planNext() {
    this.phrases++;
    if (this.phrases % 3 === 0) {
      // wander off for a bit
      this.plan.push({ kind: "move", fx: this.x, fy: this.y, tx: clamp(this.x + rand(-200, 200), -560, 560), ty: clamp(this.y + rand(-150, 150), 120, 760), dur: 900, t: 0, lift: 70 });
      this.plan.push({ kind: "pause", left: rand(800, 2200) });
      return;
    }
    const ph = this.room.placePhrase();
    const { strokes } = writePhrase(ph.lines, { cx: ph.cx, cy: ph.cy, size: ph.size, angle: ph.angle, seed: Math.floor(Math.random() * 2 ** 31) });
    const w = Math.round(clamp(ph.size * 0.055, 1.3, 2.5) * 100) / 100;
    const press = rand(0.72, 0.92);
    let x = this.x;
    let y = this.y;
    strokes.forEach((pts, i) => {
      const sx = pts[0]!;
      const sy = pts[1]!;
      const d = Math.hypot(sx - x, sy - y);
      if (i === 0) this.plan.push({ kind: "move", fx: x, fy: y, tx: sx, ty: sy, dur: clamp(d / 0.9, 350, 1300), t: 0, lift: 45 });
      else this.plan.push({ kind: "move", fx: x, fy: y, tx: sx, ty: sy, dur: clamp(d / 0.45, 90, 450), t: 0, lift: clamp(d * 0.15, 4, 14) });
      let total = 0;
      for (let j = 2; j < pts.length; j += 2) total += Math.hypot(pts[j]! - pts[j - 2]!, pts[j + 1]! - pts[j - 1]!);
      this.plan.push({ kind: "draw", pts, i: 0, speed: ph.size * rand(7, 10), w, press, travelled: 0, total });
      x = pts[pts.length - 2]!;
      y = pts[pts.length - 1]!;
    });
    this.plan.push({ kind: "pause", left: rand(1500, 4500) });
  }

  step(dt: number) {
    const out: number[] = [];
    let rec: StrokeRec | undefined;
    let ended = false;
    while (dt > 0) {
      if (!this.plan.length) this.planNext();
      const a = this.plan[0]!;
      if (a.kind === "pause") {
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
        this.x = a.fx + (a.tx - a.fx) * e + nx * bow;
        this.y = a.fy + (a.ty - a.fy) * e + ny * bow;
        this.z = Math.max(a.lift * Math.sin(Math.PI * Math.min(1, u * 1.15)), u > 0.9 ? 0 : 2);
        if (a.t >= a.dur) this.plan.shift();
      } else {
        if (rec && a.rec !== rec) break; // one stroke per batch
        if (!a.rec) {
          a.rec = this.room.addStroke(this.peer, a.w);
          a.i = 0;
        }
        rec = a.rec;
        this.z = 0;
        // ease in at the start of a stroke
        const speed = a.speed * (0.55 + 0.45 * Math.min(1, a.travelled / 25));
        let budget = (speed * dt) / 1000;
        dt = 0;
        while (a.i < a.pts.length && budget >= 0) {
          const px = a.pts[a.i]!;
          const py = a.pts[a.i + 1]!;
          const d = Math.hypot(px - this.x, py - this.y);
          if (a.i > 0 && d > budget) break;
          budget -= d;
          a.travelled += d;
          this.x = px;
          this.y = py;
          const u = a.travelled / Math.max(1, a.total);
          const taper = Math.min(1, a.travelled / 10) * Math.min(1, (a.total - a.travelled) / 8 + 0.35);
          const p = clamp(a.press * (0.55 + 0.45 * taper) * (0.92 + 0.08 * Math.sin(u * 19 + a.total)), 0.15, 1);
          out.push(round1(px), round1(py), Math.round(p * 100) / 100);
          a.i += 2;
        }
        if (a.i >= a.pts.length) {
          ended = true;
          a.rec.open = false;
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
    const cur = JSON.stringify({ t: "c", id: this.peer.id, x: round1(this.x), y: round1(this.y), z: Math.round(this.z) });
    if (cur !== this.lastSent) this.room.broadcast(cur);
    this.lastSent = cur;
  }
}

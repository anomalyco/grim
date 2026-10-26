import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DOODLE } from "../../src/shared/doodle.ts";
import { boxesOverlap, writePhrase } from "../../src/shared/handwriting.ts";

process.env.ALLOW_DEV_LOGIN = "1";
const { config } = await import("../../src/server/config.ts");
Object.assign(config, { storage: "local", allowDevLogin: true, allowedUsers: ["*"], quietMs: 100, pollMs: 60000, notesRepo: "home-notes" });
const { startServer } = await import("../../src/server/index.ts");
const { HomeRoom } = await import("../../src/server/home.ts");

type Msg = Record<string, any>;

/** A fake socket for driving a HomeRoom directly. */
function fakeSock() {
  const s = {
    got: [] as Msg[],
    closed: null as null | { code: number; reason: string },
    send(m: string) {
      s.got.push(JSON.parse(m));
    },
    close(code: number, reason: string) {
      s.closed = { code, reason };
    },
    buffered: () => 0,
    of: (t: string) => s.got.filter((m) => m.t === t),
  };
  return s;
}

describe("HomeRoom", () => {
  test("hello, join, cursor relay, leave", () => {
    const room = new HomeRoom({ bots: 2 });
    const a = fakeSock();
    const b = fakeSock();
    const ca = room.join("1.1.1.1", a)!;
    expect(a.got[0]!.t).toBe("hi");
    expect(a.got[0]!.you.id).toBe(ca.peer.id);
    expect(a.got[0]!.you.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(a.got[0]!.peers.filter((p: Peer) => p.bot)).toHaveLength(2);
    expect(room.botsRunning).toBe(true);
    const cb = room.join("2.2.2.2", b)!;
    expect(a.of("j")[0]!.id).toBe(cb.peer.id);
    expect(b.got[0]!.peers.some((p: Peer) => p.id === ca.peer.id)).toBe(true);
    room.message(ca, JSON.stringify({ t: "c", x: 12.345, y: 400 }));
    expect(b.of("c").at(-1)).toEqual({ t: "c", id: ca.peer.id, x: 12.3, y: 400 });
    expect(a.of("c")).toHaveLength(0);
    room.message(ca, JSON.stringify({ t: "c", h: 1 }));
    expect(b.of("c").at(-1)).toEqual({ t: "c", id: ca.peer.id, h: 1 });
    room.leave(ca);
    expect(b.of("l")[0]!.id).toBe(ca.peer.id);
    room.leave(cb);
    expect(room.botsRunning).toBe(false);
    room.stop();
  });

  test("strokes are relayed, buffered for newcomers, and capped", () => {
    const room = new HomeRoom({ bots: 0 });
    const a = fakeSock();
    const b = fakeSock();
    const ca = room.join("1.1.1.1", a)!;
    room.join("2.2.2.2", b);
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: [0, 100, 0.5, 10, 110, 0.6] }));
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: [20, 120, 2], e: 1 }));
    const got = b.of("s");
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ u: ca.peer.id, c: ca.peer.color, p: [0, 100, 0.5, 10, 110, 0.6] });
    expect(got[1]).toMatchObject({ id: got[0]!.id, p: [20, 120, 1], e: 1 });
    // a new key starts a new stroke
    room.message(ca, JSON.stringify({ t: "s", k: 2, p: [5, 5, 0.5] }));
    expect(b.of("s").at(-1)!.id).not.toBe(got[0]!.id);
    const c = fakeSock();
    room.join("3.3.3.3", c);
    const hi = c.got[0]!;
    expect(hi.strokes).toHaveLength(2);
    expect(hi.strokes[0].p).toHaveLength(9);
    expect(hi.strokes[1].o).toBe(true);
    expect(typeof hi.strokes[0].a).toBe("number");
    room.stop();
  });

  test("bad input is dropped; coordinates are clamped", () => {
    const room = new HomeRoom({ bots: 0 });
    const a = fakeSock();
    const b = fakeSock();
    const ca = room.join("1.1.1.1", a)!;
    room.join("2.2.2.2", b);
    const n = () => b.got.length;
    const before = n();
    for (const bad of ["nope", "null", "[]", '{"t":"c","x":"1","y":2}', '{"t":"c","x":1}', '{"t":"s","k":1.5,"p":[1,2,3]}', '{"t":"s","k":1,"p":[1,2]}', '{"t":"s","k":1,"p":[1,null,0.5]}', '{"t":"zz"}']) {
      room.message(ca, bad);
    }
    room.message(ca, new Uint8Array([1, 2, 3]));
    expect(n()).toBe(before);
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: Array(DOODLE.maxPointsPerMessage * 3 + 3).fill(1) }));
    expect(n()).toBe(before);
    room.message(ca, JSON.stringify({ t: "c", x: 1e9, y: -50 }));
    expect(b.got.at(-1)).toEqual({ t: "c", id: ca.peer.id, x: DOODLE.maxX, y: 0 });
    room.message(ca, "x".repeat(DOODLE.maxMessageBytes + 1));
    expect(a.closed?.code).toBe(1009);
    expect(room.clients.has(ca)).toBe(false);
    room.stop();
  });

  test("per-IP and total connection limits", () => {
    const room = new HomeRoom({ bots: 0, maxConnsPerIp: 2, maxConns: 3 });
    const s1 = fakeSock();
    const c1 = room.join("9.9.9.9", s1);
    room.join("9.9.9.9", fakeSock());
    const s3 = fakeSock();
    expect(room.join("9.9.9.9", s3)).toBeNull();
    expect(s3.closed?.code).toBe(4429);
    room.leave(c1!);
    expect(room.join("9.9.9.9", fakeSock())).not.toBeNull();
    room.join("8.8.8.8", fakeSock());
    const s4 = fakeSock();
    expect(room.join("7.7.7.7", s4)).toBeNull();
    expect(s4.closed?.code).toBe(1013);
    room.stop();
  });

  test("message and point rates are limited; flooding disconnects", () => {
    let now = 1000;
    const room = new HomeRoom({ bots: 0, now: () => now });
    const a = fakeSock();
    const b = fakeSock();
    const ca = room.join("1.1.1.1", a)!;
    room.join("2.2.2.2", b);
    for (let i = 0; i < DOODLE.msgsPerSec * 2 + 10; i++) room.message(ca, JSON.stringify({ t: "c", x: i, y: 1 }));
    expect(b.of("c")).toHaveLength(DOODLE.msgsPerSec * 2);
    now += 1000;
    room.message(ca, JSON.stringify({ t: "c", x: 1, y: 1 }));
    expect(b.of("c")).toHaveLength(DOODLE.msgsPerSec * 2 + 1);
    for (let i = 0; i < DOODLE.msgsPerSec * 6; i++) room.message(ca, JSON.stringify({ t: "c", x: i, y: 1 }));
    expect(a.closed?.code).toBe(1008);
    // points: a fresh client can burst 2 s worth, then is cut off
    const c = fakeSock();
    const cc = room.join("3.3.3.3", c)!;
    const pts = Array.from({ length: DOODLE.maxPointsPerMessage }, (_, i) => [i, 100, 0.5]).flat();
    let sent = 0;
    for (let i = 0; i < 30; i++) {
      const was = b.of("s").length;
      room.message(cc, JSON.stringify({ t: "s", k: 1, p: pts }));
      if (b.of("s").length > was) sent += DOODLE.maxPointsPerMessage;
    }
    expect(sent).toBeLessThanOrEqual(DOODLE.pointsPerSec * 2);
    expect(sent).toBeGreaterThan(DOODLE.pointsPerSec);
    room.stop();
  });

  test("strokes expire and the buffer is capped", () => {
    let now = 0;
    const room = new HomeRoom({ bots: 0, now: () => now });
    const ca = room.join("1.1.1.1", fakeSock())!;
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: [1, 1, 1], e: 1 }));
    now += DOODLE.strokeLifeMs + 1;
    room.prune();
    expect(room.strokes).toHaveLength(0);
    const p = room.strokes;
    for (let i = 0; i < DOODLE.maxStrokes + 50; i++) room.addStroke({ id: "x", name: "x", color: "#000" }, 2).open = false;
    room.prune();
    expect(p.length).toBe(DOODLE.maxStrokes);
    room.stop();
  });

  test("bots write strokes only while someone is connected", () => {
    const room = new HomeRoom({ bots: 2, tickMs: 1e9 });
    const a = fakeSock();
    const ca = room.join("1.1.1.1", a)!;
    for (let i = 0; i < 400; i++) room.tick(50);
    const strokes = a.of("s");
    expect(strokes.length).toBeGreaterThan(5);
    expect(a.of("c").length).toBeGreaterThan(5);
    for (const s of strokes) {
      expect(s.p.length % 3).toBe(0);
      for (let i = 0; i < s.p.length; i += 3) {
        expect(s.p[i]).toBeGreaterThanOrEqual(DOODLE.bot.minX - 1);
        expect(s.p[i]).toBeLessThanOrEqual(DOODLE.bot.maxX + 1);
        expect(s.p[i + 1]).toBeGreaterThanOrEqual(DOODLE.bot.minY - 1);
        expect(s.p[i + 1]).toBeLessThanOrEqual(DOODLE.bot.maxY + 1);
      }
    }
    room.leave(ca);
    expect(room.botsRunning).toBe(false);
    room.stop();
  });
});

describe("handwriting", () => {
  test("phrases are strokes in writing order inside their box", () => {
    const w = writePhrase(["two heads, one cursor"], { cx: 0, cy: 300, size: 30, angle: 0.3, seed: 1 });
    expect(w.strokes.length).toBeGreaterThan(3);
    // cursive: most letters join, so far fewer strokes than letters plus dots
    expect(w.strokes.length).toBeLessThan(16);
    for (const st of w.strokes) {
      for (let i = 0; i < st.length; i += 2) {
        const dx = st[i]! - w.box.cx;
        const dy = st[i + 1]! - w.box.cy;
        const u = dx * Math.cos(w.box.angle) + dy * Math.sin(w.box.angle);
        const v = -dx * Math.sin(w.box.angle) + dy * Math.cos(w.box.angle);
        expect(Math.abs(u)).toBeLessThan(w.box.hw + 10);
        expect(Math.abs(v)).toBeLessThan(w.box.hh + 20);
      }
    }
    // same seed, same writing; another seed, different
    expect(writePhrase(["hi"], { cx: 0, cy: 0, size: 30, angle: 0, seed: 5 })).toEqual(writePhrase(["hi"], { cx: 0, cy: 0, size: 30, angle: 0, seed: 5 }));
    expect(writePhrase(["hi"], { cx: 0, cy: 0, size: 30, angle: 0, seed: 5 })).not.toEqual(writePhrase(["hi"], { cx: 0, cy: 0, size: 30, angle: 0, seed: 6 }));
  });

  test("box overlap", () => {
    const a = { cx: 0, cy: 0, hw: 50, hh: 10, angle: 0 };
    expect(boxesOverlap(a, { cx: 90, cy: 0, hw: 50, hh: 10, angle: 0 })).toBe(true);
    expect(boxesOverlap(a, { cx: 0, cy: 30, hw: 50, hh: 10, angle: 0 })).toBe(false);
    expect(boxesOverlap(a, { cx: 0, cy: 30, hw: 50, hh: 10, angle: 0.6 })).toBe(true);
  });
});

describe("/ws/home", () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let base = "";
  beforeAll(async () => {
    app = await startServer({ port: 0, quiet: true, home: { bots: 1, maxConnsPerIp: 3 } });
    base = `http://localhost:${app.server.port}`;
  });
  afterAll(async () => {
    await app?.stop();
  });

  function open(origin = base) {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/home`, { headers: { origin } } as any);
    const got: Msg[] = [];
    const c = {
      ws,
      got,
      code: null as number | null,
      opened: new Promise<void>((r) => ws.addEventListener("open", () => r())),
      closed: new Promise<void>((r) => ws.addEventListener("close", (e) => ((c.code = e.code), r()))),
      wait: async (fn: (m: Msg) => boolean, ms = 3000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const m = got.find(fn);
          if (m) return m;
          await Bun.sleep(10);
        }
        throw new Error("timed out");
      },
    };
    ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data))));
    return c;
  }

  test("a cross-origin connection is refused", async () => {
    const c = open("https://evil.example");
    await c.closed;
    expect(c.code).toBe(4403);
  });

  test("two visitors see each other's pencil and strokes; the bot draws", async () => {
    const a = open();
    const hi = await a.wait((m) => m.t === "hi");
    expect(hi.peers.some((p: Peer) => p.bot)).toBe(true);
    const b = open();
    const hib = await b.wait((m) => m.t === "hi");
    await a.wait((m) => m.t === "j" && m.id === hib.you.id);
    a.ws.send(JSON.stringify({ t: "c", x: 10, y: 20 }));
    await b.wait((m) => m.t === "c" && m.id === hi.you.id && m.x === 10);
    a.ws.send(JSON.stringify({ t: "s", k: 7, p: [1, 2, 0.5, 3, 4, 0.5], e: 1 }));
    const s = await b.wait((m) => m.t === "s" && m.u === hi.you.id);
    expect(s.p).toEqual([1, 2, 0.5, 3, 4, 0.5]);
    await a.wait((m) => m.t === "s" && m.u === "bot1", 8000);
    const extra = [open(), open()];
    await Promise.race(extra.map((c) => c.closed));
    expect(extra.map((c) => c.code)).toContain(4429);
    a.ws.close();
    await b.wait((m) => m.t === "l" && m.id === hi.you.id);
    b.ws.close();
    for (const c of extra) c.ws.close();
  }, 15000);
});

interface Peer {
  id: string;
  bot?: boolean;
}

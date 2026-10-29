import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DOODLE } from "../../src/shared/doodle.ts";
import { boxesOverlap, rng, wrapPhrase, writePhrase } from "../../src/shared/handwriting.ts";
import { CAST } from "../../src/server/cast.ts";
import { PAIRS } from "../../src/server/home-lines.ts";
import { PromptBoard, RESPONSE_WINDOW_MS, pickLine } from "../../src/server/lines.ts";

process.env.ALLOW_DEV_LOGIN = "1";
const { config } = await import("../../src/server/config.ts");
Object.assign(config, { storage: "local", allowDevLogin: true, quietMs: 100, pollMs: 60000, notesRepo: "home-notes" });
const { startServer } = await import("../../src/server/index.ts");
const { HomeRoom } = await import("../../src/server/home.ts");
const { clientIp, normalizeIp, notePeer, requestProto } = await import("../../src/server/proxy.ts");
const { sameOrigin } = await import("../../src/server/auth.ts");

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
    room.flushPresence();
    expect(a.got[0]!.t).toBe("hi");
    expect(a.got[0]!.you.id).toBe(ca.peer.id);
    expect(a.got[0]!.you.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(a.got[0]!.peers.filter((p: Peer) => p.bot)).toHaveLength(2);
    expect(room.botsRunning).toBe(true);
    const cb = room.join("2.2.2.2", b)!;
    room.flushPresence();
    expect(a.of("j")[0]!.peers.map((p: Peer) => p.id)).toEqual([cb.peer.id]);
    expect(b.of("j")).toHaveLength(0);
    expect(b.got[0]!.peers.some((p: Peer) => p.id === ca.peer.id)).toBe(true);
    room.message(ca, JSON.stringify({ t: "c", x: 12.345, y: 400 }));
    expect(b.of("c").at(-1)).toEqual({ t: "c", id: ca.peer.id, x: 12.3, y: 400 });
    expect(a.of("c")).toHaveLength(0);
    room.message(ca, JSON.stringify({ t: "c", h: 1 }));
    expect(b.of("c").at(-1)).toEqual({ t: "c", id: ca.peer.id, h: 1 });
    room.leave(ca);
    room.flushPresence();
    expect(b.of("l")[0]!.ids).toEqual([ca.peer.id]);
    room.leave(cb);
    expect(room.botsRunning).toBe(false);
    room.stop();
  });

  test("joins and leaves are batched; a quick visit isn't announced", () => {
    const room = new HomeRoom({ bots: 0, maxConnsPerIp: 50, joinBurst: 50 });
    const a = fakeSock();
    room.join("1.1.1.1", a);
    room.flushPresence();
    const quick = room.join("1.1.1.1", fakeSock())!;
    room.leave(quick);
    room.flushPresence();
    expect(a.of("j")).toHaveLength(0);
    expect(a.of("l")).toHaveLength(0);
    const socks = Array.from({ length: 5 }, () => fakeSock());
    const cs = socks.map((s) => room.join("1.1.1.1", s)!);
    room.leave(cs[4]!);
    room.flushPresence();
    expect(a.of("j")).toHaveLength(1);
    expect(a.of("j")[0]!.peers).toHaveLength(4);
    // a newcomer hears about the others who arrived with it, not about itself
    expect(socks[0]!.of("j")[0]!.peers.map((p: Peer) => p.id)).toEqual(cs.slice(1, 4).map((c) => c.peer.id));
    room.stop();
  });

  test("new connections are rate limited per IP", () => {
    let now = 0;
    const room = new HomeRoom({ bots: 0, maxConnsPerIp: 100, now: () => now });
    const ok = [];
    for (let i = 0; i < 6; i++) ok.push(room.join("5.5.5.5", fakeSock()));
    expect(ok.every(Boolean)).toBe(true);
    for (const c of ok) room.leave(c!);
    const s = fakeSock();
    expect(room.join("5.5.5.5", s)).toBeNull();
    expect(s.closed?.code).toBe(4429);
    expect(room.join("6.6.6.6", fakeSock())).not.toBeNull();
    now += 6_000;
    expect(room.join("5.5.5.5", fakeSock())).not.toBeNull();
    expect(room.join("5.5.5.5", fakeSock())).toBeNull();
    room.stop();
  });

  test("the stroke snapshot is cached but never misses a stroke", () => {
    let now = 10_000;
    const room = new HomeRoom({ bots: 0, maxConnsPerIp: 50, joinBurst: 50, now: () => now });
    const ca = room.join("1.1.1.1", fakeSock())!;
    const built = room.snapshots;
    // closed since the snapshot (built when ca joined): sent alongside it
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: [1, 1, 1], e: 1 }));
    const s1 = fakeSock();
    room.join("1.1.1.1", s1);
    expect(room.snapshots).toBe(built);
    expect(s1.got[0]!.strokes).toHaveLength(1);
    now += 100;
    room.message(ca, JSON.stringify({ t: "s", k: 2, p: [2, 2, 1], e: 1 }));
    room.message(ca, JSON.stringify({ t: "s", k: 3, p: [3, 3, 1] }));
    now += 100;
    const s2 = fakeSock();
    room.join("1.1.1.1", s2);
    expect(room.snapshots).toBe(built);
    const hi = s2.got[0]!;
    expect(hi.d).toBe(200);
    expect(hi.strokes.map((s: Msg) => s.p[0])).toEqual([1, 2, 3]);
    expect(hi.strokes[0].b).toEqual([1, 0]);
    expect(hi.strokes[0].b[1] + hi.d).toBe(200);
    expect(hi.strokes[2].o).toBe(true);
    now += 600;
    room.join("1.1.1.1", fakeSock());
    expect(room.snapshots).toBe(built + 1);
    room.stop();
  });

  test("newcomers get each batch's age and only the points still showing", () => {
    let now = 50_000;
    const room = new HomeRoom({ bots: 0, maxConnsPerIp: 50, joinBurst: 50, now: () => now });
    const ca = room.join("1.1.1.1", fakeSock())!;
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: [1, 1, 1, 2, 2, 1] }));
    now += 5_000;
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: [3, 3, 1] }));
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: [4, 4, 1] })); // same moment: same batch
    now += 6_000;
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: [5, 5, 1], e: 1 }));
    now += 1_000;
    const s1 = fakeSock();
    room.join("1.1.1.1", s1);
    let st = s1.got[0]!.strokes[0];
    expect(st.p).toEqual([3, 3, 1, 4, 4, 1, 5, 5, 1]);
    expect(st.b.map((v: number, i: number) => (i % 2 ? v + s1.got[0]!.d : v))).toEqual([2, 7_000, 1, 1_000]);
    // from the cached snapshot: ages as of when it was built, d since then
    now += 300;
    const s2 = fakeSock();
    room.join("1.1.1.1", s2);
    st = s2.got[0]!.strokes[0];
    expect(s2.got[0]!.d).toBe(300);
    expect(st.b[1] + s2.got[0]!.d).toBe(7_300);
    // once every point has faded, the stroke isn't sent at all
    now += 11_000;
    const s3 = fakeSock();
    room.join("1.1.1.1", s3);
    expect(s3.got[0]!.strokes).toHaveLength(0);
    room.stop();
  });

  test("a stroke in progress is ended for everyone when its owner leaves or starts another", () => {
    const room = new HomeRoom({ bots: 0 });
    const ca = room.join("1.1.1.1", fakeSock())!;
    const b = fakeSock();
    room.join("2.2.2.2", b);
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: [1, 1, 1] }));
    room.message(ca, JSON.stringify({ t: "s", k: 2, p: [2, 2, 1] }));
    const [s1, end1, s2] = b.of("s");
    expect(end1).toMatchObject({ id: s1!.id, p: [], e: 1 });
    expect(s2!.id).not.toBe(s1!.id);
    room.leave(ca);
    expect(b.of("s").at(-1)).toMatchObject({ id: s2!.id, p: [], e: 1 });
    expect(room.strokes.every((s) => !s.open)).toBe(true);
    room.stop();
  });

  test("per-person caps are per IP, across reconnects, open strokes included", () => {
    const room = new HomeRoom({ bots: 0, maxConnsPerIp: 50, joinBurst: 1000 });
    const pts = Array.from({ length: DOODLE.maxPointsPerMessage }, (_, i) => [i, 100, 0.5]).flat();
    let k = 0;
    // 20 short visits of 2,000 points each from one IP: 40,000 points, but only 20,000 are kept
    for (let v = 0; v < 20; v++) {
      const c = room.join("4.4.4.4", fakeSock())!;
      for (let i = 0; i < 31; i++) {
        c.ptTokens = c.msgTokens = 1e9;
        room.message(c, JSON.stringify({ t: "s", k: ++k, p: pts.slice(0, 64 * 3), e: i === 30 ? 1 : undefined }));
      }
      room.leave(c);
    }
    expect(room.usageOf("4.4.4.4")!.pts).toBeLessThanOrEqual(20_000);
    const kept = room.strokes.filter((s) => s.ip === "4.4.4.4").reduce((n, s) => n + s.p.length / 3, 0);
    expect(kept).toBe(room.usageOf("4.4.4.4")!.pts);
    expect(kept).toBeGreaterThan(15_000);
    room.stop();
  });

  test("binary frames close the connection", () => {
    const room = new HomeRoom({ bots: 0 });
    const a = fakeSock();
    const ca = room.join("1.1.1.1", a)!;
    room.message(ca, new Uint8Array([1, 2, 3]));
    expect(a.closed?.code).toBe(1003);
    expect(room.clients.has(ca)).toBe(false);
    room.stop();
  });

  test("strokes are relayed, buffered for newcomers, and capped", () => {
    // a fixed clock: the newcomer's ages are as of the cached snapshot, so a millisecond passing between b joining
    // (which builds it) and the strokes would make the age -1
    const room = new HomeRoom({ bots: 0, now: () => 1_000_000 });
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
    expect(hi.strokes[0].b).toEqual([3, 0]);
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

  test("strokes expire once their last point has faded (about 12 s) and the buffer is capped", () => {
    expect(DOODLE.inkLifeMs).toBe(12_000);
    let now = 0;
    const room = new HomeRoom({ bots: 0, maxConnsPerIp: 50, joinBurst: 50, now: () => now });
    const ca = room.join("1.1.1.1", fakeSock())!;
    room.message(ca, JSON.stringify({ t: "s", k: 1, p: [1, 1, 1], e: 1 }));
    now += DOODLE.inkLifeMs - 1;
    room.prune();
    expect(room.strokes).toHaveLength(1);
    now += 2_500;
    room.prune();
    expect(room.strokes).toHaveLength(0);
    // a long stroke lives as long as points keep coming
    room.message(ca, JSON.stringify({ t: "s", k: 2, p: [1, 1, 1] }));
    for (let i = 0; i < 6; i++) {
      now += 5_000;
      room.message(ca, JSON.stringify({ t: "s", k: 2, p: [i, 1, 1] }));
    }
    expect(room.strokes).toHaveLength(1);
    expect(room.strokes[0]!.p).toHaveLength(21);
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

  test("bots keep to the smallest window here (a phone), and go back to the desktop area when it leaves", () => {
    let now = 0;
    const room = new HomeRoom({ bots: 3, tickMs: 1e9, now: () => now });
    const desk = room.join("1.1.1.1", fakeSock())!;
    room.message(desk, JSON.stringify({ t: "v", w: 1440, h: 900 }));
    expect(room.area()).toEqual({ ...DOODLE.bot });
    // someone on the desktop hovers far out on the left (a bot may come to fight it)
    room.message(desk, JSON.stringify({ t: "c", x: -600, y: 400 }));
    for (; now < 10_000; now += 50) room.tick(50);
    const ph = fakeSock();
    const phone = room.join("2.2.2.2", ph)!;
    room.message(phone, JSON.stringify({ t: "v", w: 360, h: 740 }));
    const a = room.area();
    expect(a.maxX).toBeLessThanOrEqual(180 - 20);
    expect(a.minX).toBeGreaterThanOrEqual(-180 + 20);
    expect(a.maxY).toBeLessThanOrEqual(740 - 30);
    const out: string[] = [];
    const joined = now;
    let from = 0;
    for (; now < 190_000; now += 50) {
      room.tick(50);
      // (the ones outside take a moment to come in)
      if (now - joined < 1000) {
        from = ph.got.length;
        continue;
      }
      for (const b of room.bots) if (b.x < a.minX - 0.5 || b.x > a.maxX + 0.5 || b.y < a.minY - 0.5 || b.y > a.maxY + 0.5) out.push(`${b.peer.id} at ${b.x},${b.y}`);
    }
    const after = ph.got.slice(from);
    const strokes = after.filter((m) => m.t === "s" && m.p.length);
    expect(strokes.length).toBeGreaterThan(100);
    for (const s of strokes) for (let i = 0; i < s.p.length; i += 3) if (s.p[i] < a.minX - 1 || s.p[i] > a.maxX + 1 || s.p[i + 1] > a.maxY + 1) out.push(`ink ${s.p[i]},${s.p[i + 1]}`);
    for (const c of after.filter((m) => m.t === "c")) if (c.id.startsWith("bot") && !c.h && (c.x < a.minX - 1 || c.x > a.maxX + 1)) out.push(`pencil ${c.x}`);
    expect(out.slice(0, 5)).toEqual([]);
    // nonsense sizes are clamped
    room.message(phone, JSON.stringify({ t: "v", w: 5, h: -3 }));
    expect(room.area().maxX).toBeGreaterThanOrEqual(110);
    room.leave(phone);
    expect(room.area()).toEqual({ ...DOODLE.bot, maxY: 900 - 36 > DOODLE.bot.maxY ? DOODLE.bot.maxY : 900 - 36 });
    room.stop();
  });

  test("bots keep a few phrases showing, and don't write over ones still showing", () => {
    let now = 0;
    const room = new HomeRoom({ bots: 3, tickMs: 1e9, now: () => now });
    room.join("1.1.1.1", fakeSock());
    const counts: number[] = [];
    let pairs = 0;
    let overlaps = 0;
    for (let t = 0; t < 400_000; t += 50) {
      now = t;
      room.tick(50);
      if (t < 90_000 || t % 1000) continue;
      const showing = (room as any).recent.filter((r: { until: number }) => r.until > now);
      counts.push(showing.length);
      for (let i = 0; i < showing.length; i++)
        for (let j = i + 1; j < showing.length; j++) {
          pairs++;
          if (boxesOverlap(showing[i].box, showing[j].box, 0)) overlaps++;
        }
      // nothing older than its last point plus the margin is kept
      for (const s of room.strokes) expect(now - (s.bt.at(-1) ?? s.t0)).toBeLessThanOrEqual(DOODLE.botInkLifeMs + 2_000);
    }
    // a few on the page at a time, not a crowd
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(avg).toBeGreaterThanOrEqual(3);
    expect(avg).toBeLessThanOrEqual(9);
    expect(overlaps / pairs).toBeLessThan(0.05);
    room.stop();
  });

  test("with a phone here, the bots take turns: a few lines at a time, not written over each other", () => {
    let now = 0;
    const room = new HomeRoom({ bots: 3, tickMs: 1e9, now: () => now });
    const phone = room.join("1.1.1.1", fakeSock())!;
    room.message(phone, JSON.stringify({ t: "v", w: 390, h: 694 }));
    // (and every bot gets turns: they go to whoever has waited longest)
    const lines = new Map<string, number>();
    const place = room.placePhrase.bind(room);
    room.placePhrase = (who) => {
      lines.set(who.key, (lines.get(who.key) ?? 0) + 1);
      return place(who);
    };
    const counts: number[] = [];
    let pairs = 0;
    let overlaps = 0;
    for (now = 0; now < 400_000; now += 50) {
      room.tick(50);
      if (now < 90_000 || now % 1000) continue;
      const showing = (room as any).recent.filter((r: { until: number }) => r.until > now);
      counts.push(showing.length);
      // (writing over a line that's nearly gone is fine)
      const fresh = showing.filter((r: { until: number }) => r.until - now > DOODLE.botInkLifeMs / 3);
      for (let i = 0; i < fresh.length; i++)
        for (let j = i + 1; j < fresh.length; j++) {
          pairs++;
          if (boxesOverlap(fresh[i].box, fresh[j].box, 0)) overlaps++;
        }
    }
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(avg).toBeGreaterThanOrEqual(1.5);
    expect(avg).toBeLessThanOrEqual(4);
    expect(overlaps / pairs).toBeLessThan(0.03);
    for (const c of CAST) expect(lines.get(c.key) ?? 0).toBeGreaterThanOrEqual(3);
    room.stop();
  });

  test("when a narrower phone comes, the bots soon write again: dropped and off-screen phrases don't hold turns", () => {
    for (let run = 0; run < 5; run++) {
      let now = 0;
      const room = new HomeRoom({ bots: 3, tickMs: 1e9, now: () => now });
      const wide = room.join("1.1.1.1", fakeSock())!;
      room.message(wide, JSON.stringify({ t: "v", w: 390, h: 844 }));
      for (; now < 60_000 + run * 7_000; now += 50) room.tick(50);
      const narrow = room.join("2.2.2.2", fakeSock())!;
      room.message(narrow, JSON.stringify({ t: "v", w: 360, h: 740 }));
      room.leave(wide);
      const joined = now;
      let first = Infinity;
      const append = room.append.bind(room);
      room.append = (rec, pts) => {
        if (pts.length && rec.u.startsWith("bot") && rec.t0 >= joined) first = Math.min(first, now);
        append(rec, pts);
      };
      for (; now < joined + 40_000; now += 50) room.tick(50);
      expect(first - joined).toBeLessThanOrEqual(35_000);
      room.stop();
    }
  });

  test("no pencil is idle more than 5 s: each starts its next line 3-5 s after the last", () => {
    for (let run = 0; run < 5; run++) {
      let now = 0;
      const room = new HomeRoom({ bots: 3, tickMs: 1e9, now: () => now });
      room.join("1.1.1.1", fakeSock());
      // when each last put ink down (a fight counts as busy too)
      const last = new Map<string, number>(room.bots.map((b) => [b.peer.id, 0]));
      const append = room.append.bind(room);
      room.append = (rec, pts) => {
        if (pts.length && last.has(rec.u)) last.set(rec.u, now);
        append(rec, pts);
      };
      let worst = 0;
      for (now = 0; now < 120_000; now += 50) {
        room.tick(50);
        for (const b of room.bots) {
          if (b.fight) last.set(b.peer.id, now);
          worst = Math.max(worst, now - last.get(b.peer.id)!);
        }
      }
      expect(worst).toBeLessThanOrEqual(5_050);
      room.stop();
    }
  });
});

describe("handwriting", () => {
  test("a long line wraps onto as many even lines as keep within the limit (a phone's, too)", () => {
    expect(wrapPhrase("stop. writing. near. me.", 30)).toEqual(["stop. writing. near. me."]);
    expect(wrapPhrase("I hate this pencil. I hate this page. I hate you specifically.", 20)).toEqual(["I hate this", "pencil. I hate", "this page. I hate", "you specifically."]);
    for (const c of CAST)
      for (const { text } of c.lines)
        for (const max of [c.wrap, c.narrowWrap]) {
          const lines = wrapPhrase(text, max);
          expect(lines.join(" ")).toBe(text);
          for (const l of lines) expect(l.length <= max || !l.includes(" ")).toBe(true);
        }
  });

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
    await a.wait((m) => m.t === "j" && m.peers.some((p: Peer) => p.id === hib.you.id));
    a.ws.send(JSON.stringify({ t: "c", x: 10, y: 20 }));
    await b.wait((m) => m.t === "c" && m.id === hi.you.id && m.x === 10);
    a.ws.send(JSON.stringify({ t: "s", k: 7, p: [1, 2, 0.5, 3, 4, 0.5], e: 1 }));
    const s = await b.wait((m) => m.t === "s" && m.u === hi.you.id);
    expect(s.p).toEqual([1, 2, 0.5, 3, 4, 0.5]);
    await a.wait((m) => m.t === "s" && m.u === "bot1", 8000);
    const extra = [open(), open()];
    await Promise.race(extra.map((c) => c.closed));
    expect(extra.map((c) => c.code)).toContain(4429);
    // binary frames close the connection
    for (const c of extra) c.ws.close();
    await Promise.all(extra.map((c) => c.closed));
    const bin = open();
    await bin.wait((m) => m.t === "hi");
    bin.ws.send(new Uint8Array(100_000));
    await bin.closed;
    expect(bin.code).toBe(1003);
    a.ws.close();
    await b.wait((m) => m.t === "l" && m.ids.includes(hi.you.id));
    b.ws.close();
    for (const c of extra) c.ws.close();
  }, 15000);
});

describe("behind a proxy", () => {
  const req = (peer: string, headers: Record<string, string> = {}, url = "http://grimoire.exe.xyz/ws/home") => {
    const r = new Request(url, { headers });
    notePeer(r, peer);
    return r;
  };

  test("addresses are normalized", () => {
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::FFFF:7f00:1")).toBe("127.0.0.1");
    expect(normalizeIp("[2001:DB8:0:0:0:0:0:1]")).toBe("2001:db8::1");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });

  test("X-Forwarded-For only counts from a trusted proxy (loopback, as on exe.dev)", () => {
    // exe.dev's proxy runs on the VM and connects over loopback; Bun reports it IPv4-mapped
    expect(clientIp(req("::ffff:127.0.0.1", { "x-forwarded-for": "9.9.9.9, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req("::1", { "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req("::ffff:127.0.0.1"))).toBe("127.0.0.1");
    // anyone else's header is ignored: private ranges, Tailscale, mapped private addresses, public peers
    for (const peer of ["::ffff:10.42.0.7", "10.0.0.2", "192.168.1.5", "fd7a:115c:a1e0::1", "100.101.102.103", "198.51.100.1"]) {
      expect(clientIp(req(peer, { "x-forwarded-for": "1.2.3.4" }))).toBe(normalizeIp(peer));
    }
    // the right-most hop that isn't a trusted proxy, so a client can't pick its own address
    expect(clientIp(req("127.0.0.1", { "x-forwarded-for": "1.1.1.1, 203.0.113.7, 127.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(req("127.0.0.1", { "x-forwarded-for": "::ffff:203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req("127.0.0.1", { "x-forwarded-for": "1.1.1.1, nonsense" }))).toBe("invalid");
    expect(clientIp(new Request("http://x/"))).toBe("unknown");
  });

  test("TRUSTED_PROXIES replaces the default", () => {
    const was = config.trustedProxies;
    try {
      config.trustedProxies = "10.42.0.0/16, fd7a:115c:a1e0::/48";
      expect(clientIp(req("::ffff:10.42.3.4", { "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
      expect(clientIp(req("fd7a:115c:a1e0:ab12::5", { "x-forwarded-for": "203.0.113.8" }))).toBe("203.0.113.8");
      expect(clientIp(req("127.0.0.1", { "x-forwarded-for": "203.0.113.7" }))).toBe("127.0.0.1");
      config.trustedProxies = "none";
      expect(clientIp(req("127.0.0.1", { "x-forwarded-for": "203.0.113.7" }))).toBe("127.0.0.1");
    } finally {
      config.trustedProxies = was;
    }
  });

  test("the forwarded scheme: Secure cookies and same-origin checks behind an https proxy", () => {
    expect(requestProto(req("::ffff:127.0.0.1", { "x-forwarded-proto": "https" }))).toBe("https:");
    expect(requestProto(req("203.0.113.9", { "x-forwarded-proto": "https" }))).toBe("http:");
    const was = process.env.PUBLIC_URL;
    const pub = config.publicUrl;
    delete process.env.PUBLIC_URL;
    config.publicUrl = "http://localhost:8000";
    try {
      const h = { origin: "https://grimoire.exe.xyz", "x-forwarded-proto": "https", "x-forwarded-host": "grimoire.exe.xyz" };
      expect(sameOrigin(req("::ffff:127.0.0.1", h))).toBe(true);
      expect(sameOrigin(req("::ffff:127.0.0.1", { origin: "https://grimoire.exe.xyz", "x-forwarded-proto": "https" }))).toBe(true);
      expect(sameOrigin(req("203.0.113.9", h))).toBe(false);
      expect(sameOrigin(req("::ffff:127.0.0.1", { ...h, origin: "https://evil.example" }))).toBe(false);
      expect(sameOrigin(req("203.0.113.9", { origin: "http://grimoire.exe.xyz" }))).toBe(true);
    } finally {
      config.publicUrl = pub;
      if (was !== undefined) process.env.PUBLIC_URL = was;
    }
  });
});

interface Peer {
  id: string;
  bot?: boolean;
}

describe("prompts and responses", () => {
  test("a response is never picked before its prompt has been written by another bot, then soon, and only once", () => {
    for (const pair of PAIRS) {
      const by = pair.prompt[0];
      const who = pair.response[0];
      const lines = CAST.find((c) => c.key === who)!.lines;
      const reply = lines.find((l) => l.respondsTo === pair.id)!;
      const prompt = { text: pair.prompt[1], id: pair.id };
      const rand = rng(42);
      const board = new PromptBoard();
      let now = 0;
      // nothing written yet: in 20,000 draws, never a response
      for (let i = 0; i < 20_000; i++) expect(pickLine(lines, who, board, (now += 100), [], rand).respondsTo).toBeUndefined();
      // the responder writing the prompt itself doesn't arm its response
      board.wrote(prompt, who, now);
      for (let i = 0; i < 2_000; i++) expect(pickLine(lines, who, board, now, [], rand).respondsTo).toBeUndefined();
      // its writer writes the prompt: the reply comes within a few picks, and once
      board.wrote(prompt, by, now);
      const picks = Array.from({ length: 2_000 }, () => pickLine(lines, who, board, now, [], rand));
      expect(picks.slice(0, 6)).toContain(reply);
      expect(picks.filter((l) => l === reply)).toHaveLength(1);
      // written again but long ago: too late to answer
      board.wrote(prompt, by, now);
      now += RESPONSE_WINDOW_MS + 1;
      for (let i = 0; i < 2_000; i++) expect(pickLine(lines, who, board, now, [], rand).respondsTo).toBeUndefined();
    }
  });

  test("no bot writes the same line twice in a row, and each gets round all its lines", () => {
    let now = 0;
    const room = new HomeRoom({ tickMs: 1e9, now: () => now });
    room.join("1.1.1.1", fakeSock());
    const written = new Map<string, string[]>();
    const place = room.placePhrase.bind(room);
    room.placePhrase = (who) => {
      const ph = place(who);
      const mine = written.get(who.key) ?? [];
      mine.push(ph.line.text);
      written.set(who.key, mine);
      return ph;
    };
    for (now = 0; now < 30 * 60_000; now += 50) room.tick(50);
    for (const c of CAST) {
      const mine = written.get(c.key)!;
      expect(mine.length).toBeGreaterThan(40);
      for (let i = 1; i < mine.length; i++) expect(mine[i]).not.toBe(mine[i - 1]);
      for (const l of c.lines.filter((l) => !l.respondsTo)) expect(mine).toContain(l.text);
    }
    room.stop();
  });

  test("every pair: the prompt is in one bot's pool, the response in another's, and the barbara exchange is spicy-pretzel → moist-burrito", () => {
    for (const p of PAIRS) {
      const a = CAST.find((c) => c.key === p.prompt[0])!;
      const b = CAST.find((c) => c.key === p.response[0])!;
      expect(a).not.toBe(b);
      expect(a.lines.filter((l) => l.id === p.id).map((l) => l.text)).toEqual([p.prompt[1]]);
      expect(b.lines.filter((l) => l.respondsTo === p.id).map((l) => l.text)).toEqual([p.response[1]]);
    }
    const room = new HomeRoom({ tickMs: 1e9 });
    expect(room.bots.map((b) => b.peer.name)).toEqual(["grumpy-pickle", "spicy-pretzel", "moist-burrito"]);
    expect(room.bots[1]!.cast.lines.some((l) => l.text === "oh great barbara is coming now")).toBe(true);
    expect(room.bots[2]!.cast.lines.some((l) => l.text === "I told you not to call me barbara")).toBe(true);
    room.stop();
  });

  test("spicy-pretzel underlines about 1 in 5 of its lines", () => {
    const hand = CAST.find((c) => c.key === "crank")!.hand;
    const lines = ["who keeps opening", "this notebook"];
    let underlined = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      const opts = { cx: 0, cy: 0, size: 30, angle: 0, seed };
      const n = writePhrase(lines, { ...opts, hand }).strokes.length;
      if (n > writePhrase(lines, { ...opts, hand: { ...hand, underlineOdds: 0 } }).strokes.length) underlined++;
    }
    expect(underlined / 1000).toBeGreaterThan(0.15);
    expect(underlined / 1000).toBeLessThan(0.25);
  });

  test("in the room, responses only start after their prompts are finished, by another bot, recently", () => {
    let now = 0;
    const room = new HomeRoom({ tickMs: 1e9, now: () => now });
    room.join("1.1.1.1", fakeSock());
    const finished = new Map<string, { by: string; t: number }>();
    const wrote = room.prompts.wrote.bind(room.prompts);
    room.prompts.wrote = (line, by, t, box) => {
      if (line.id) finished.set(line.id, { by, t });
      wrote(line, by, t, box);
    };
    const place = room.placePhrase.bind(room);
    let responses = 0;
    room.placePhrase = (who) => {
      const ph = place(who);
      const id = ph.line.respondsTo;
      if (id) {
        const p = finished.get(id);
        expect(p).toBeDefined();
        expect(p!.by).not.toBe(who.key);
        expect(now - p!.t).toBeLessThanOrEqual(RESPONSE_WINDOW_MS);
        responses++;
      }
      return ph;
    };
    for (now = 0; now < 40 * 60_000; now += 50) room.tick(50);
    expect(responses).toBeGreaterThan(0);
    room.stop();
  });
});

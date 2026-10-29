// A HomeDO room (/ws/home) in workerd via Miniflare 5: strokes between two clients, bots only while someone is
// connected, and the room's cap on people (the lobby's room handouts are tested in test/server/home.test.ts).
// Run: bun test test/workers/home.test.ts
// (Standalone Miniflare setup; fold into the shared Workers test harness from CF-15 once it lands.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { DOODLE } from "../../src/shared/doodle.ts";
import { ROOM_FULL, ROOM_HUMANS } from "../../src/server/home/home-lobby.ts";

let BASE = "";
const root = join(import.meta.dir, "../..");
let dir = "";
let mf: Miniflare;

// A stand-in for CF-21's router: forwards /ws/home to the one HomeDO with the caller's IP (here from ?ip=).
const ENTRY = `
export { HomeDO } from ${JSON.stringify(join(root, "src/workers/home-do.ts"))};
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const home = env.HOME.getByName("home");
    if (url.pathname === "/stats") return Response.json(await home.stats());
    const headers = new Headers(req.headers);
    headers.set("CF-Connecting-IP", url.searchParams.get("ip") ?? "");
    return home.fetch(new Request(req, { headers }));
  },
};
`;

beforeAll(async () => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-home-test-"));
  writeFileSync(join(dir, "entry.ts"), ENTRY);
  const out = await Bun.build({ entrypoints: [join(dir, "entry.ts")], target: "browser", format: "esm", external: ["cloudflare:*", "node:*"] });
  if (!out.success) throw new AggregateError(out.logs, "bundle failed");
  mf = new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      workers: [
        {
          name: "home-test",
          modules: true,
          script: await out.outputs[0]!.text(),
          compatibilityDate: "2026-08-18",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: { HOME: { className: "HomeDO", useSQLite: true } },
        },
      ],
    }),
  );
  BASE = (await mf.ready).toString().replace(/\/$/, "");
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Client {
  ws: WebSocket;
  msgs: any[];
  closed: Promise<{ code: number; reason: string }>;
  next(pred: (m: any) => boolean, ms?: number): Promise<any>;
}

function connect(ip: string): Promise<Client> {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws/home?ip=${ip}`);
  ws.binaryType = "arraybuffer";
  const msgs: any[] = [];
  const waiters = new Set<() => void>();
  ws.onmessage = (e) => {
    msgs.push(JSON.parse(e.data as string));
    for (const w of waiters) w();
  };
  const closed = new Promise<{ code: number; reason: string }>((r) => (ws.onclose = (e) => r({ code: e.code, reason: e.reason })));
  const next = (pred: (m: any) => boolean, ms = 5000) =>
    new Promise<any>((resolve, reject) => {
      let i = 0;
      const check = () => {
        for (; i < msgs.length; i++) if (pred(msgs[i])) return done(msgs[i]);
      };
      const done = (m: any) => {
        waiters.delete(check);
        clearTimeout(t);
        resolve(m);
      };
      const t = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`no matching message in ${ms} ms (got ${msgs.map((m) => m.t).join(",")})`));
      }, ms);
      waiters.add(check);
      check();
    });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, msgs, closed, next });
    ws.onerror = () => reject(new Error("socket error"));
  });
}

const stats = async (): Promise<{ clients: number; strokes: number; botsRunning: boolean }> => (await fetch(`${BASE}/stats`)).json();

async function until(fn: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

test("no bots before anyone connects", async () => {
  expect(await stats()).toEqual({ clients: 0, strokes: 0, botsRunning: false });
});

test("two clients exchange strokes; bots run only while someone is connected", async () => {
  const a = await connect("10.0.0.1");
  const b = await connect("10.0.0.2");
  const hiA = await a.next((m) => m.t === "hi");
  const hiB = await b.next((m) => m.t === "hi");
  expect(hiA.peers.filter((p: any) => p.bot).length).toBe(3);
  expect((await stats()).botsRunning).toBe(true);
  // the bots move: their pencils show up as cursor messages
  await a.next((m) => m.t === "c" && String(m.id).startsWith("bot"));

  a.ws.send(JSON.stringify({ t: "s", k: 1, p: [10, 300, 0.5, 20, 310, 0.6, 30, 320, 0.7] }));
  a.ws.send(JSON.stringify({ t: "s", k: 1, p: [40, 330, 0.5], e: 1 }));
  const s1 = await b.next((m) => m.t === "s" && m.u === hiA.you.id);
  expect(s1.p).toEqual([10, 300, 0.5, 20, 310, 0.6, 30, 320, 0.7]);
  const s2 = await b.next((m) => m.t === "s" && m.u === hiA.you.id && m.e === 1);
  expect(s2.id).toBe(s1.id);
  expect(s2.p).toEqual([40, 330, 0.5]);

  b.ws.send(JSON.stringify({ t: "s", k: 7, p: [-50, 400, 1], e: 1 }));
  const back = await a.next((m) => m.t === "s" && m.u === hiB.you.id);
  expect(back).toMatchObject({ p: [-50, 400, 1], e: 1 });

  // a newcomer gets the strokes in its hello
  const c = await connect("10.0.0.3");
  const hiC = await c.next((m) => m.t === "hi");
  expect(hiC.strokes.map((s: any) => s.u)).toEqual(expect.arrayContaining([hiA.you.id, hiB.you.id]));

  // binary frames are refused (and arrive as ArrayBuffer, not Blob, in the DO)
  c.ws.send(new Uint8Array([1, 2, 3]));
  expect((await c.closed).code).toBe(1003);

  a.ws.close();
  b.ws.close();
  await until(async () => (await stats()).clients === 0);
  expect((await stats()).botsRunning).toBe(false);
  // with nobody left, the bots stay put: no new bot strokes
  const before = (await stats()).strokes;
  await Bun.sleep(DOODLE.batchMs * 10);
  expect((await stats()).strokes).toBeLessThanOrEqual(before);
});

test("a room holds ROOM_HUMANS people: the next is turned away (to be given another room by the lobby)", async () => {
  const ok: Client[] = [];
  for (let i = 0; i < ROOM_HUMANS; i++) {
    const c = await connect(`203.0.113.${i + 1}`);
    await c.next((m) => m.t === "hi");
    ok.push(c);
  }
  const over = await connect("203.0.113.99");
  expect(await over.closed).toEqual({ code: ROOM_FULL, reason: "room full" });
  expect((await stats()).clients).toBe(ROOM_HUMANS);
  for (const c of ok) c.ws.close();
  await until(async () => (await stats()).clients === 0);
  expect((await stats()).botsRunning).toBe(false);
});

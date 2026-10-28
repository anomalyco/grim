// HubDO in Miniflare 5 (the workerd that wrangler dev uses), driven from bun test.
// Minimal harness: bundle the DO with Bun.build and serve it behind a tiny glue Worker. To be merged with CF-15's
// Workers test setup once that lands.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { join } from "node:path";
import type { AppEvent } from "../../src/server/seams/events.ts";

const PING_MS = 300;

const GLUE = `
import { HubDO } from "./hub-do.js";
export { HubDO };
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const hub = env.HUB.get(env.HUB.idFromName("hub"));
    if (url.pathname === "/api/events") return hub.fetch(req);
    if (url.pathname === "/emit") { await hub.emit(await req.json()); return new Response("ok"); }
    if (url.pathname === "/stats") return Response.json(await hub.stats());
    return new Response("Not found", { status: 404 });
  },
};`;

let mf: Miniflare;
let base: string;

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../src/workers/hub-do.ts")],
    target: "browser",
    format: "esm",
    external: ["cloudflare:workers"],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundling hub-do.ts failed");
  mf = new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      workers: [
        {
          name: "hub",
          modules: [
            { type: "ESModule", path: "glue.js", contents: GLUE },
            { type: "ESModule", path: "hub-do.js", contents: await built.outputs[0]!.text() },
          ],
          compatibilityDate: "2026-08-18",
          compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
          durableObjects: { HUB: { className: "HubDO", useSQLite: true } },
          bindings: { HUB_PING_MS: String(PING_MS) },
        },
      ],
    }),
  );
  base = (await mf.ready).toString().replace(/\/$/, "");
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
});

/** An SSE client over real HTTP that collects raw frames. */
function client() {
  const abort = new AbortController();
  const frames: string[] = [];
  let buf = "";
  const done = (async () => {
    const res = await fetch(`${base}/api/events`, { signal: abort.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          frames.push(buf.slice(0, i + 2));
          buf = buf.slice(i + 2);
        }
      }
    } catch {}
  })();
  return {
    frames,
    events: () => frames.filter((f) => f.startsWith("event:")),
    close: async () => {
      abort.abort();
      await done.catch(() => {});
    },
  };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const emit = (e: AppEvent) => fetch(`${base}/emit`, { method: "POST", body: JSON.stringify(e) }).then((r) => r.text());
const stats = () => fetch(`${base}/stats`).then((r) => r.json() as Promise<{ streams: number; ping: boolean; presence: number }>);
const frame = (e: AppEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

test("two clients get emitted events in order, a new client gets the presence snapshot, no timers once all close", async () => {
  expect(await stats()).toEqual({ streams: 0, ping: false, presence: 0 });

  const a = client();
  const b = client();
  await until(() => a.frames.length > 0 && b.frames.length > 0);
  expect(a.frames[0]).toBe(": connected\n\n");
  expect(b.frames[0]).toBe(": connected\n\n");
  expect(await stats()).toMatchObject({ streams: 2, ping: true });

  const ann = { id: "u1", name: "Ann", color: "#f00", kind: "user" };
  const sent: AppEvent[] = [
    { type: "tree", repo: "r1" },
    { type: "presence", repo: "r1", path: "a.md", users: [ann] },
    { type: "repos" },
    { type: "saved", repo: "r1", path: "a.md", sha: "abc" },
    { type: "presence", repo: "r1", path: "b.md", users: [ann] },
    { type: "presence", repo: "r1", path: "b.md", users: [] },
  ];
  for (const e of sent) await emit(e);
  await until(() => a.events().length === sent.length && b.events().length === sent.length);
  expect(a.events()).toEqual(sent.map(frame));
  expect(b.events()).toEqual(sent.map(frame));

  // Pings arrive while streams are open.
  await until(() => a.frames.includes(": ping\n\n") && b.frames.includes(": ping\n\n"), 3000);

  // A new client starts with the current presence (b.md was emptied, so only a.md).
  const c = client();
  await until(() => c.events().length === 1);
  expect(c.frames.slice(0, 2)).toEqual([": connected\n\n", frame(sent[1]!)]);

  await Promise.all([a.close(), b.close(), c.close()]);
  await until(async () => (await stats()).streams === 0);
  expect(await stats()).toEqual({ streams: 0, ping: false, presence: 1 });

  // The snapshot survives eviction (presence lives in DO SQLite).
  await mf.unsafeEvictDurableObject("hub", "HubDO", { name: "hub" });
  const d = client();
  await until(() => d.events().length === 1);
  expect(d.events()).toEqual([frame(sent[1]!)]);
  await d.close();
  await until(async () => (await stats()).streams === 0);
  expect((await stats()).ping).toBe(false);
}, 30_000);

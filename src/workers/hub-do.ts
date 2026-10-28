import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.ts";
import { PresenceSnapshot, SSE_CONNECTED, SSE_HEADERS, SSE_PING, SSE_PING_MS, sseEvent, type AppEvent, type PresenceEvent } from "../server/seams/events.ts";

/** A stream this far behind (in queued chunks) is dropped rather than buffered without bound. */
const MAX_QUEUED = 256;
const encoder = new TextEncoder();

/**
 * The /api/events fan-out on Workers (one instance, `HUB.getByName("hub")`): it holds the SSE streams, receives
 * `emit` by RPC from the Worker and WorkspaceDOs, and keeps the presence snapshot new streams start with (in
 * SQLite, so it survives eviction). The wire format is the one api.ts sends on Bun. The 25 s ping runs only while
 * streams are open, so with none the DO has no timers and can be evicted.
 */
export class HubDO extends DurableObject<Env> {
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private presence = new PresenceSnapshot();
  private ping: ReturnType<typeof setInterval> | undefined;
  private pingMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.pingMs = Number((env as Env & { HUB_PING_MS?: string }).HUB_PING_MS) || SSE_PING_MS;
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS presence (key TEXT PRIMARY KEY, event TEXT NOT NULL)");
    for (const row of sql.exec<{ event: string }>("SELECT event FROM presence")) this.presence.apply(JSON.parse(row.event) as PresenceEvent);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    // TODO(owner decision #10, post-v1): optional `?repos=a,b` to receive only those workspaces' tree/presence/saved
    // events (plus `repos`). Today every stream gets every event, as on Bun.
    return this.open(req.signal);
  }

  /** RPC: fan an event out to every open stream, in call order. */
  emit(e: AppEvent): void {
    if (this.presence.apply(e)) {
      const key = PresenceSnapshot.key(e);
      if (e.users.length) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO presence (key, event) VALUES (?, ?)", key, JSON.stringify(e));
      else this.ctx.storage.sql.exec("DELETE FROM presence WHERE key = ?", key);
    }
    const s = sseEvent(e);
    for (const c of [...this.streams]) this.write(c, s);
  }

  /** RPC: for tests and debugging. */
  stats(): { streams: number; ping: boolean; presence: number } {
    return { streams: this.streams.size, ping: this.ping !== undefined, presence: this.presence.list().length };
  }

  /** A stream ends when the client disconnects (`signal`, which needs the `enable_request_signal` compat flag; the
   * body's cancel alone is not reliable through the Worker → DO hop), on a failed write, or when it falls too far behind. */
  private open(signal: AbortSignal): Response {
    let self: ReadableStreamDefaultController<Uint8Array> | undefined;
    const end = () => self && this.close(self);
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        self = c;
        this.streams.add(c);
        this.write(c, SSE_CONNECTED);
        for (const e of this.presence.list()) this.write(c, sseEvent(e));
        this.startPing();
      },
      cancel: end,
    });
    if (signal.aborted) end();
    else signal.addEventListener("abort", end, { once: true });
    return new Response(body, { headers: SSE_HEADERS });
  }

  private write(c: ReadableStreamDefaultController<Uint8Array>, s: string) {
    if (!this.streams.has(c)) return;
    if (c.desiredSize !== null && c.desiredSize < -MAX_QUEUED) return this.close(c);
    try {
      c.enqueue(encoder.encode(s));
    } catch {
      this.drop(c);
    }
  }

  private close(c: ReadableStreamDefaultController<Uint8Array>) {
    this.drop(c);
    try {
      c.close();
    } catch {}
  }

  private drop(c: ReadableStreamDefaultController<Uint8Array>) {
    this.streams.delete(c);
    if (this.streams.size === 0 && this.ping !== undefined) {
      clearInterval(this.ping);
      this.ping = undefined;
    }
  }

  private startPing() {
    if (this.ping !== undefined || this.streams.size === 0) return;
    this.ping = setInterval(() => {
      for (const c of [...this.streams]) this.write(c, SSE_PING);
    }, this.pingMs);
  }
}

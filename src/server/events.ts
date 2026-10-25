// Server-sent events to browsers: tree changes, per-file presence, save status.
export type AppEvent =
  | { type: "tree"; repo: string }
  | { type: "repos" }
  | { type: "presence"; repo: string; path: string; users: Array<{ id: string; name: string; color: string; kind: string }> }
  | { type: "saved"; repo: string; path: string; sha: string };

type Listener = (e: AppEvent) => void;
const listeners = new Set<Listener>();
// Per-file version waiters, for MCP wait_for_change.
const changeWaiters = new Set<{ repo: string; path?: string; resolve: () => void }>();

export function emit(e: AppEvent) {
  for (const l of listeners) l(e);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function notifyChange(repo: string, path?: string) {
  for (const w of [...changeWaiters]) {
    if (w.repo === repo && (!w.path || !path || w.path === path)) {
      changeWaiters.delete(w);
      w.resolve();
    }
  }
}

export function waitForChange(repo: string, path: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (changed: boolean) => {
      clearTimeout(t);
      changeWaiters.delete(w);
      signal?.removeEventListener("abort", onAbort);
      resolve(changed);
    };
    const onAbort = () => done(false);
    const w = { repo, path, resolve: () => done(true) };
    const t = setTimeout(() => done(false), timeoutMs);
    changeWaiters.add(w);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function sseResponse(filter: (e: AppEvent) => boolean, initial: AppEvent[] = []): Response {
  let unsubscribe = () => {};
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream<string>({
    start(controller) {
      // A closed stream throws on enqueue: stop listening instead of throwing inside emit().
      const write = (s: string) => {
        try {
          controller.enqueue(s);
        } catch {
          unsubscribe();
          clearInterval(ping);
        }
      };
      const send = (e: AppEvent) => {
        if (filter(e)) write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      write(": connected\n\n");
      for (const e of initial) send(e);
      unsubscribe = subscribe(send);
      ping = setInterval(() => write(": ping\n\n"), 25_000);
    },
    cancel() {
      unsubscribe();
      clearInterval(ping);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

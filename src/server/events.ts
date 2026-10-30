// Workspace events (tree changes, per-file presence, save status) for the protocol v2 sockets: the in-process bus,
// on Bun and in each WorkspaceDO. See seams/events.ts.
import type { AppEvent, EventBus, EventListener } from "./seams/events.ts";

export type { AppEvent, EventBus } from "./seams/events.ts";

export class LocalEventBus implements EventBus {
  private listeners = new Set<EventListener>();

  emit(e: AppEvent) {
    for (const l of [...this.listeners]) l(e);
  }

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const bus = new LocalEventBus();

type Listener = (e: AppEvent) => void;

// Change waiters for the shell's `watch`: a file, a folder ("dir/") or, without path, the whole repo.
const changeWaiters = new Set<{ repo: string; path?: string; resolve: () => void }>();

function matches(watched: string | undefined, changed: string | undefined) {
  if (!watched || !changed) return true;
  return watched.endsWith("/") ? changed.startsWith(watched) : watched === changed;
}

export function emit(e: AppEvent) {
  bus.emit(e);
}

export function subscribe(l: Listener): () => void {
  return bus.subscribe(l);
}

export function notifyChange(repo: string, path?: string) {
  for (const w of [...changeWaiters]) {
    if (w.repo === repo && matches(w.path, path)) {
      changeWaiters.delete(w);
      w.resolve();
    }
  }
}

/** Resolves true when the file (or folder, if `path` ends with "/") changes, false on timeout or abort. */
export function waitForChange(repo: string, path: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
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

// Server-sent events to browsers: tree changes, per-file presence, save status.
// The in-process EventBus (Bun); on Workers, HubDO plays this role. See seams/events.ts.
import { PresenceSnapshot, type AppEvent, type EventBus, type EventFilter, type EventListener } from "./seams/events.ts";

export type { AppEvent, EventBus } from "./seams/events.ts";

export class LocalEventBus implements EventBus {
  private listeners = new Set<EventListener>();
  private snapshot = new PresenceSnapshot();

  emit(e: AppEvent) {
    this.snapshot.apply(e);
    for (const l of [...this.listeners]) l(e);
  }

  subscribe(fn: EventListener): () => void;
  subscribe(filter: EventFilter | undefined, fn: EventListener): () => void;
  subscribe(a: EventFilter | EventListener | undefined, b?: EventListener): () => void {
    const fn = b ?? (a as EventListener);
    const filter = b ? (a as EventFilter | undefined) : undefined;
    const l: EventListener = filter ? (e) => filter(e) && fn(e) : fn;
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  presence() {
    return this.snapshot.list();
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

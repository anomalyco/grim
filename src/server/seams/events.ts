/** App events for /api/events (SSE): tree changes, workspace list changes, per-file presence, save status.
 * Bun: the in-process bus in events.ts. Workers: HubDO (src/workers/hub-do.ts), fed by `emit` over RPC.
 * Keystroke-level change notifications (`notifyChange`/`waitForChange`) are not events: they stay per workspace. */
export type PresenceUser = { id: string; name: string; color: string; kind: string };

export type AppEvent =
  | { type: "tree"; repo: string }
  | { type: "repos" }
  | { type: "presence"; repo: string; path: string; users: PresenceUser[] }
  | { type: "saved"; repo: string; path: string; sha: string }
  /** The import status of one workspace changed (protocol v2 sockets' `workspace` event; SSE clients ignore it). */
  | { type: "workspace"; repo: string; status: "ready" | "importing" | "error"; error?: string };

export type PresenceEvent = Extract<AppEvent, { type: "presence" }>;
export type EventFilter = (e: AppEvent) => boolean;
export type EventListener = (e: AppEvent) => void;

export interface EventBus {
  emit(e: AppEvent): void | Promise<void>;
  /** Calls `fn` for every later event (that passes `filter`); returns the unsubscribe function. */
  subscribe(fn: EventListener): () => void;
  subscribe(filter: EventFilter | undefined, fn: EventListener): () => void;
  /** The latest non-empty presence event per (repo, path), sent first to a new stream. */
  presence(): PresenceEvent[];
}

/** Keeps the latest presence per file; an event with no users removes the file. Shared by both buses. */
export class PresenceSnapshot {
  private files = new Map<string, PresenceEvent>();

  static key(e: { repo: string; path: string }) {
    return `${e.repo}\0${e.path}`;
  }

  /** Returns true if `e` was a presence event (and so changed the snapshot). */
  apply(e: AppEvent): e is PresenceEvent {
    if (e.type !== "presence") return false;
    const k = PresenceSnapshot.key(e);
    if (e.users.length) this.files.set(k, e);
    else this.files.delete(k);
    return true;
  }

  list(): PresenceEvent[] {
    return [...this.files.values()];
  }
}

// ---- SSE wire format (identical on Bun and Workers; the web app and the Mac app parse it) ----

export const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };
export const SSE_CONNECTED = ": connected\n\n";
export const SSE_PING = ": ping\n\n";
export const SSE_PING_MS = 25_000;

export function sseEvent(e: AppEvent): string {
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

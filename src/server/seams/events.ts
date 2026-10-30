/** Workspace events (tree changes, per-file presence, save status, import status): the in-process bus in events.ts
 * carries them to the workspace's protocol v2 sockets (channel 0), on Bun and in each WorkspaceDO.
 * Keystroke-level change notifications (`notifyChange`/`waitForChange`) are not events: they stay per workspace. */
export type PresenceUser = { id: string; name: string; color: string; kind: string };

export type AppEvent =
  | { type: "tree"; repo: string }
  | { type: "presence"; repo: string; path: string; users: PresenceUser[] }
  | { type: "saved"; repo: string; path: string; sha: string }
  /** The import status of one workspace changed (protocol v2 sockets' `workspace` event). */
  | { type: "workspace"; repo: string; status: "ready" | "importing" | "error"; error?: string };

export type PresenceEvent = Extract<AppEvent, { type: "presence" }>;
export type EventListener = (e: AppEvent) => void;

export interface EventBus {
  emit(e: AppEvent): void | Promise<void>;
  /** Calls `fn` for every later event; returns the unsubscribe function. */
  subscribe(fn: EventListener): () => void;
}

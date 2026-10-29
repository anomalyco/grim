// Typed wrappers for the HTTP API and the SSE event stream.

export interface Config {
  /** false: the server has no accounts (SIGN_IN off): no sign-in anywhere, every visitor may do everything. */
  signIn?: boolean;
  githubLogin: boolean;
  googleLogin?: boolean;
  githubAppSlug: string | null;
  storage: "codestorage" | "local";
  /** How often the demo workspace resets (0: only on restart); missing from older servers. */
  demoResetMinutes?: number;
  /** our hosted marketing site (MARKETING_SITE): "/" is the landing page; elsewhere "/" is the app */
  marketing?: boolean;
}

export interface Me {
  id: string;
  login: string;
  name: string;
  email: string;
  avatar: string | null;
  color?: string;
}

export interface Repo {
  id: string;
  title: string;
  kind: "notes" | "github";
  ghOwner: string | null;
  ghName: string | null;
  branch: string;
  status: string;
  error: string | null;
  readOnly: boolean;
  /** Only whoever made a folder may remove it. */
  canRemove: boolean;
  /** Guests may create, rename, delete and upload here too (the demo); elsewhere they only edit notes. */
  guestCreate?: boolean;
}

/** GET /api/server: how this server lets people sign in. */
export interface ServerInfo {
  name: string;
  publicUrl: string;
  /** false: no accounts on this server (SIGN_IN off). */
  signIn?: boolean;
  google: boolean;
  version?: string;
  /** WebSocket protocol versions served (v2 = one socket per workspace); absent: v1 only. */
  ws?: number[];
}

/** A folder I've joined (GET /api/workspaces). */
export interface Workspace {
  id: string;
  title: string;
  kind: "notes" | "github";
  readOnly: boolean;
  head?: string | null;
}

export interface Tree {
  head: string | null;
  files: string[];
}

export interface Commit {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string | number;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface PresenceUserInfo {
  id: string;
  name: string;
  color: string;
  kind: string;
}

export type AppEvent =
  | { type: "tree"; repo: string }
  | { type: "repos" }
  | { type: "presence"; repo: string; path: string; users: PresenceUserInfo[] }
  | { type: "saved"; repo: string; path: string; sha: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Not signed in: who I am as a guest, sent with every request (the server names my commits after it). */
let guestHeaders: Record<string, string> = {};

export function setGuest(g: { id: string; name: string; color: string } | null) {
  guestHeaders = g ? { "x-grimoire-guest": g.id, "x-grimoire-guest-name": encodeURIComponent(g.name), "x-grimoire-guest-color": g.color } : {};
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: { ...guestHeaders } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? (text || res.statusText);
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const r = (id: string) => `/api/repos/${encodeURIComponent(id)}`;
const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  return s.toString();
};

export const api = {
  config: () => req<Config>("GET", "/api/config"),
  me: () => req<Me>("GET", "/api/me"),
  logout: () => req<unknown>("POST", "/auth/logout"),
  setName: (name: string) => req<{ name: string }>("PATCH", "/api/me", { name }),

  repos: () => req<Repo[]>("GET", "/api/repos"),
  addGitHub: (github: string, readOnly: boolean) => req<Repo>("POST", "/api/repos", { github, readOnly }),
  repo: (id: string) => req<Repo>("GET", r(id)),
  deleteRepo: (id: string) => req<{ ok: true }>("DELETE", r(id)),

  tree: (id: string) => req<Tree>("GET", `${r(id)}/tree`),
  createFile: (id: string, path: string, content?: string) => req<{ path: string }>("POST", `${r(id)}/files`, { path, content }),
  deleteFile: (id: string, path: string) => req<{ ok: boolean }>("DELETE", `${r(id)}/files?${q({ path })}`),
  /** `ifUntitled`: only while `from` is still an untitled note (naming it after its heading). */
  renameFolder: (id: string, from: string, to: string) => req<{ path: string }>("POST", `${r(id)}/rename`, { from, to, folder: true }),
  deleteFolder: (id: string, folder: string) => req<{ ok: boolean }>("DELETE", `${r(id)}/files?${q({ folder })}`),
  rename: (id: string, from: string, to: string, ifUntitled = false) => req<{ path: string }>("POST", `${r(id)}/rename`, { from, to, ...(ifUntitled ? { ifUntitled } : {}) }),
  history: (id: string, path: string, limit?: number) => req<Commit[]>("GET", `${r(id)}/history?${q({ path, limit })}`),
  diff: (id: string, sha: string, path?: string) => req<{ diff: string }>("GET", `${r(id)}/diff?${q({ sha, path })}`),
  file: (id: string, path: string, ref?: string) => req<{ content: string }>("GET", `${r(id)}/file?${q({ path, ref })}`),
  restore: (id: string, path: string, sha: string) => req<{ ok: boolean }>("POST", `${r(id)}/restore`, { path, sha }),
  /** Upload an image next to note `note`: its repo path and the Markdown that shows it in the note. */
  uploadImage: async (id: string, note: string, file: File): Promise<{ path: string; markdownPath: string; markdown: string }> => {
    const res = await fetch(`${r(id)}/images?${q({ note, name: file.name || "image" })}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { ...guestHeaders, "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    const data = (await res.json().catch(() => null)) as { error?: string; path: string; markdownPath: string; markdown: string } | null;
    if (!res.ok || !data) throw new ApiError(res.status, data?.error ?? (res.status === 413 ? "the image is too large (10 MB at most)" : res.statusText));
    return data;
  },
  search: (id: string, query: string) => req<{ hits: SearchHit[]; incomplete?: string }>("GET", `${r(id)}/search?${q({ q: query })}`),

  /** My agent link for the folder, created on first use. */
  myShare: (id: string) => req<{ id: string; url: string }>("POST", `${r(id)}/shares`, {}),

  server: () => req<ServerInfo>("GET", "/api/server"),
  /** The folders I've joined on this server. */
  workspaces: () => req<Workspace[]>("GET", "/api/workspaces"),
  /** My demo room (its workspace id): /app/demo opens it (the server's demo-rooms.ts). */
  demoRoom: () => req<{ workspace: string; resetMinutes?: number }>("POST", "/api/demo/room"),
  createWorkspace: (title: string) => req<{ id: string; title: string }>("POST", "/api/workspaces", { title }),
  leaveWorkspace: (id: string) => req<unknown>("DELETE", `${w(id)}/join`),
  /** Add workspaces to my list (those that still exist): what this browser opened before signing in. */
  /** An account's own workspace to land in (made the first time: "<First name>'s notes"). */
  personalWorkspace: () => req<Workspace>("POST", "/api/workspaces/personal"),
  joinMany: (ids: string[]) => req<{ joined: string[]; missing: string[] }>("POST", "/api/workspaces/join-many", { ids }),
};

const w = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;

/** A /api/events subscription (servers without protocol v2). */
export interface EventSubscription {
  stop(): void;
  /** Reconnect if the workspaces to follow changed. */
  update(): void;
}

/**
 * Subscribe to /api/events for the workspaces `repos()` names (the server sends nothing about others), with
 * auto-reconnect. `onOpen(reconnect)` fires on every connect; `reconnect` is false for the first one, so callers
 * only resync after missing events.
 */
export function subscribeEvents(repos: () => string[], onEvent: (e: AppEvent) => void, onOpen?: (reconnect: boolean) => void): EventSubscription {
  let es: EventSource | null = null;
  let stopped = false;
  let delay = 1000;
  let opened = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let named = "";
  const wanted = () => [...new Set(repos())].sort().slice(0, 100).join(",");

  const connect = () => {
    if (stopped) return;
    named = wanted();
    es = new EventSource(`/api/events?${new URLSearchParams({ repos: named })}`);
    es.onopen = () => {
      delay = 1000;
      onOpen?.(opened);
      opened = true;
    };
    for (const type of ["tree", "repos", "presence", "saved"]) {
      es.addEventListener(type, (ev) => {
        try {
          onEvent(JSON.parse((ev as MessageEvent).data) as AppEvent);
        } catch (err) {
          console.error("bad event", err);
        }
      });
    }
    es.onerror = () => {
      // EventSource retries by itself while CONNECTING; reconnect manually once it gives up.
      if (es && es.readyState === EventSource.CLOSED) {
        es = null;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      }
    };
  };
  connect();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
    },
    update() {
      if (stopped || wanted() === named) return;
      if (timer) clearTimeout(timer);
      timer = null;
      es?.close();
      connect();
    },
  };
}

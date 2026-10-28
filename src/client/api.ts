// Typed wrappers for the HTTP API and the SSE event stream.

export interface Config {
  githubLogin: boolean;
  googleLogin?: boolean;
  devLogin: boolean;
  githubAppSlug: string | null;
  storage: "codestorage" | "local";
}

export interface Me {
  id: string;
  login: string;
  name: string;
  email: string;
  avatar: string | null;
  color?: string;
}

/** GET /api/anon: a visitor who isn't signed in and their guest edits. */
export interface AnonStatus {
  used: number;
  limit: number;
  /** The quiet period that ends one edit (QUIET_MS). */
  burstMs: number;
  signedIn: boolean;
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
}

/** GET /api/server: how this server lets people sign in. */
export interface ServerInfo {
  name: string;
  publicUrl: string;
  google: boolean;
  devLogin: boolean;
  version?: string;
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

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
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
  /** Not signed in: my guest edits (also sets the grimoire_anon cookie that counts them). */
  anon: () => req<AnonStatus>("GET", "/api/anon"),
  setName: (name: string) => req<{ name: string }>("PATCH", "/api/me", { name }),

  repos: () => req<Repo[]>("GET", "/api/repos"),
  addGitHub: (github: string, readOnly: boolean) => req<Repo>("POST", "/api/repos", { github, readOnly }),
  repo: (id: string) => req<Repo>("GET", r(id)),
  deleteRepo: (id: string) => req<{ ok: true }>("DELETE", r(id)),

  tree: (id: string) => req<Tree>("GET", `${r(id)}/tree`),
  createFile: (id: string, path: string, content?: string) => req<{ path: string }>("POST", `${r(id)}/files`, { path, content }),
  deleteFile: (id: string, path: string) => req<{ ok: boolean }>("DELETE", `${r(id)}/files?${q({ path })}`),
  rename: (id: string, from: string, to: string) => req<{ path: string }>("POST", `${r(id)}/rename`, { from, to }),
  history: (id: string, path: string, limit?: number) => req<Commit[]>("GET", `${r(id)}/history?${q({ path, limit })}`),
  diff: (id: string, sha: string, path?: string) => req<{ diff: string }>("GET", `${r(id)}/diff?${q({ sha, path })}`),
  file: (id: string, path: string, ref?: string) => req<{ content: string }>("GET", `${r(id)}/file?${q({ path, ref })}`),
  restore: (id: string, path: string, sha: string) => req<{ ok: boolean }>("POST", `${r(id)}/restore`, { path, sha }),
  /** Upload an image next to note `note`: its repo path and the Markdown that shows it in the note. */
  uploadImage: async (id: string, note: string, file: File): Promise<{ path: string; markdownPath: string; markdown: string }> => {
    const res = await fetch(`${r(id)}/images?${q({ note, name: file.name || "image" })}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": file.type || "application/octet-stream" },
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
  createWorkspace: (title: string) => req<{ id: string; title: string }>("POST", "/api/workspaces", { title }),
  leaveWorkspace: (id: string) => req<unknown>("DELETE", `${w(id)}/join`),
};

const w = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;

/**
 * Subscribe to /api/events with auto-reconnect. `onOpen(reconnect)` fires on every connect; `reconnect` is
 * false for the first one, so callers only resync after missing events.
 */
export function subscribeEvents(onEvent: (e: AppEvent) => void, onOpen?: (reconnect: boolean) => void): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let delay = 1000;
  let opened = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    es = new EventSource("/api/events");
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
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}

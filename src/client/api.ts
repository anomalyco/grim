// Typed wrappers for the HTTP API and the SSE event stream.

export interface Config {
  githubLogin: boolean;
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
  access: "write" | "read";
  canRemove: boolean;
  canShare: boolean;
}

/** GET /api/server: how this server lets people sign in. */
export interface ServerInfo {
  name: string;
  publicUrl: string;
  signin: "open" | "emails";
  google: boolean;
  devLogin: boolean;
  version?: string;
  /** (client side) the server predates workspaces: no /api/server */
  legacy?: boolean;
}

export type Role = "owner" | "editor" | "viewer";
export type LinkAccess = "none" | "view" | "edit";

/** A workspace I've joined (GET /api/workspaces). */
export interface Workspace {
  id: string;
  title: string;
  kind: "notes" | "github";
  role: Role | null;
  linkAccess: LinkAccess;
  readOnly: boolean;
  head?: string | null;
  joinedVia: "member" | "domain" | "link";
}

export interface Member {
  id: string;
  userId?: string | null;
  email: string | null;
  name?: string | null;
  avatar?: string | null;
  role: Role;
  /** An invite by email nobody has signed in with yet. */
  pending?: boolean;
}

export interface WorkspaceDetails {
  id: string;
  title: string;
  role: Role | null;
  linkAccess: LinkAccess;
  domainRule: string | null;
  members?: Member[];
}

export interface AppToken {
  id: string;
  label: string;
  createdAt: number | string;
  lastUsedAt: number | string | null;
}

/** GET /api/note-links/:id: what a note share link opens. */
export interface NoteLink {
  id: string;
  workspace: { id: string; title: string };
  path: string;
  role: "viewer" | "editor";
  sharedBy: string | null;
  server?: string;
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

export interface ShareLink {
  id: string;
  url: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  createdBy: string | null;
  canRevoke: boolean;
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

/** The note share link this page was opened with: carried by every request about the workspace. */
let shareToken: string | null = null;
export function setShareToken(token: string | null) {
  shareToken = token;
}
/** `url` with the open note link's `share=` param (for raw image URLs and the WebSocket too). */
export function withShare(url: string) {
  return shareToken ? `${url}${url.includes("?") ? "&" : "?"}share=${encodeURIComponent(shareToken)}` : url;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (url.startsWith("/api/repos/")) url = withShare(url);
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
  guest: () => req<{ name: string }>("POST", "/auth/guest"),
  setName: (name: string) => req<{ name: string }>("PATCH", "/api/me", { name }),

  repos: () => req<Repo[]>("GET", "/api/repos"),
  createNotebook: (title: string) => req<Repo>("POST", "/api/repos", { title }),
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
    const res = await fetch(withShare(`${r(id)}/images?${q({ note, name: file.name || "image" })}`), {
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

  shares: (id: string) => req<ShareLink[]>("GET", `${r(id)}/shares`),
  createShare: (id: string, label?: string) => req<{ id: string; url: string }>("POST", `${r(id)}/shares`, { label }),
  /** This person's link for the notebook, created on first use. */
  myShare: (id: string) => req<{ id: string; url: string }>("POST", `${r(id)}/shares`, { reuse: true }),
  revokeShare: (shareId: string) => req<{ ok: true }>("DELETE", `/api/shares/${encodeURIComponent(shareId)}`),
  createNoteLink: (id: string, path: string, role: "viewer" | "editor") => req<{ id: string; url: string }>("POST", `${r(id)}/shares`, { kind: "note", path, role }),
  /**
   * What note link `id` opens (with the link set by setShareToken). `at`: the workspace and note from its URL, for
   * servers that describe the link on the workspace itself (`GET /api/repos/:id?share=`).
   */
  noteLink: async (id: string, at: { repo: string; path: string | null }): Promise<NoteLink> => {
    try {
      return await req<NoteLink>("GET", `/api/note-links/${encodeURIComponent(id)}`);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
    const repo = await req<Repo & { scope?: { path: string; role?: "viewer" | "editor"; sharedBy?: string | null } }>("GET", r(at.repo));
    const path = repo.scope?.path ?? at.path;
    if (!path) throw new ApiError(404, "note link not found");
    const role = repo.scope?.role ?? (repo.access === "write" && !repo.readOnly ? "editor" : "viewer");
    return { id, workspace: { id: repo.id, title: repo.title }, path, role, sharedBy: repo.scope?.sharedBy ?? null };
  },

  /** How this server signs people in; servers without workspaces (no /api/server) behave like `open`. */
  server: async (config: Config): Promise<ServerInfo> => {
    try {
      return await req<ServerInfo>("GET", "/api/server");
    } catch (err) {
      // older servers answer 401 to every /api route but /api/config when signed out; a broken one shouldn't
      // stop the app from starting either
      if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 401)) console.warn("/api/server:", err);
      return { name: location.host, publicUrl: location.origin, signin: "open", google: false, devLogin: config.devLogin, legacy: true };
    }
  },
  /** The workspaces I've joined on this server (servers without workspaces: every repo I can open). */
  workspaces: async (): Promise<Workspace[]> => {
    try {
      return await req<Workspace[]>("GET", "/api/workspaces");
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      const repos = await req<Repo[]>("GET", "/api/repos");
      return repos.map((x) => ({ id: x.id, title: x.title, kind: x.kind, role: x.access === "write" ? "editor" : "viewer", linkAccess: "none", readOnly: x.readOnly, joinedVia: "member" }));
    }
  },
  createWorkspace: async (title: string): Promise<{ id: string; title: string }> => {
    try {
      return await req<{ id: string; title: string }>("POST", "/api/workspaces", { title });
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 405)) throw err;
      return req<Repo>("POST", "/api/repos", { title });
    }
  },
  workspace: (id: string) => req<WorkspaceDetails>("GET", w(id)),
  /** Signed out: whether anyone with the workspace's URL may open it. */
  workspacePublic: (id: string) => req<{ linkAccess: LinkAccess }>("GET", `${w(id)}/public`),
  updateWorkspace: (id: string, patch: { title?: string; linkAccess?: LinkAccess; domainRule?: string | null }) => req<WorkspaceDetails>("PATCH", w(id), patch),
  leaveWorkspace: (id: string) => req<unknown>("DELETE", `${w(id)}/join`),
  members: (id: string) => req<Member[]>("GET", `${w(id)}/members`),
  setMember: (id: string, email: string, role: Role) => req<Member>("POST", `${w(id)}/members`, { email, role }),
  removeMember: (id: string, memberId: string) => req<unknown>("DELETE", `${w(id)}/members/${encodeURIComponent(memberId)}`),

  tokens: () => req<AppToken[]>("GET", "/api/tokens"),
  revokeToken: (id: string) => req<unknown>("DELETE", `/api/tokens/${encodeURIComponent(id)}`),
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

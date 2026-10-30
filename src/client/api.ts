// Typed wrappers for the HTTP API.

/** GET /api/server: what this server is and how people sign in (preloaded by index.html). */
export interface ServerInfo {
  name: string;
  /** false: no accounts on this server (SIGN_IN off): no sign-in anywhere, everything is shared. */
  signIn: boolean;
  /** our hosted marketing site (MARKETING_SITE): "/" is the landing page; elsewhere "/" is the app */
  marketing: boolean;
  googleLogin: boolean;
  githubLogin: boolean;
  githubAppSlug: string | null;
  /** false: adding GitHub repos is turned off on this server (GITHUB_COPIES); absent on older servers: on. */
  githubCopies?: boolean;
  /** How often the demo workspace resets (0: only on restart). */
  demoResetMinutes: number;
  /** WebSocket protocol versions served (v2 = one socket per workspace); absent: v1 only. */
  ws?: number[];
}

export interface Me {
  id: string;
  login: string;
  name: string;
  email: string;
  avatar: string | null;
  color?: string;
}

/** A workspace: what every workspace route returns (GET /api/workspaces, GET /api/workspace/:id, creating one). */
export interface Workspace {
  id: string;
  title: string;
  kind: "notes" | "github";
  ghOwner: string | null;
  ghName: string | null;
  branch: string;
  status: string;
  error: string | null;
  readOnly: boolean;
  /** Only whoever made a workspace may remove it (anyone, on a server without sign-in). */
  canRemove: boolean;
  /** Guests may create, rename, delete and upload here too (the demo); elsewhere they only edit notes. */
  guestCreate?: boolean;
}

/** What the switcher lists: a workspace, or the little a guest's browser remembers of one it opened. */
export type WorkspaceItem = Pick<Workspace, "id" | "title" | "kind" | "readOnly">;

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


export interface PresenceUserInfo {
  id: string;
  name: string;
  color: string;
  kind: string;
}

export type AppEvent =
  | { type: "tree"; repo: string }
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

const w = (id: string) => `/api/workspace/${encodeURIComponent(id)}`;
const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  return s.toString();
};

export const api = {
  server: () => req<ServerInfo>("GET", "/api/server"),
  me: () => req<Me>("GET", "/api/me"),
  logout: () => req<unknown>("POST", "/auth/logout"),
  setName: (name: string) => req<{ name: string }>("PATCH", "/api/me", { name }),

  /** My workspaces on this server (every workspace, on a server without sign-in). */
  workspaces: () => req<Workspace[]>("GET", "/api/workspaces"),
  createWorkspace: (title: string) => req<Workspace>("POST", "/api/workspaces", { title }),
  addGitHub: (github: string, readOnly: boolean) => req<Workspace>("POST", "/api/workspaces", { github, readOnly }),
  /** An account's own workspace to land in (made the first time: "<First name>'s notes"; `created` on that call). */
  personalWorkspace: () => req<Workspace & { created?: boolean }>("POST", "/api/workspaces/personal"),
  /** Add workspaces to my list (those that still exist): what this browser opened before signing in. */
  joinMany: (ids: string[]) => req<{ joined: string[]; missing: string[] }>("POST", "/api/workspaces/join-many", { ids }),
  /** My demo room (its workspace id): /app/demo opens it (the server's demo-rooms.ts). */
  demoRoom: () => req<{ workspace: string; resetMinutes?: number }>("POST", "/api/demo/room"),

  repo: (id: string) => req<Workspace>("GET", w(id)),
  deleteRepo: (id: string) => req<{ ok: true }>("DELETE", w(id)),
  leaveWorkspace: (id: string) => req<unknown>("DELETE", `${w(id)}/join`),
  /** My agent link for the workspace, made on first use. */
  agentLink: (id: string) => req<{ url: string }>("POST", `${w(id)}/agent-link`),

  tree: (id: string) => req<Tree>("GET", `${w(id)}/tree`),
  file: (id: string, path: string, ref?: string) => req<{ content: string }>("GET", `${w(id)}/file?${q({ path, ref })}`),
  createFile: (id: string, path: string, content?: string) => req<{ path: string }>("POST", `${w(id)}/files`, { path, content }),
  deleteFile: (id: string, path: string) => req<{ ok: boolean }>("DELETE", `${w(id)}/files?${q({ path })}`),
  deleteFolder: (id: string, folder: string) => req<{ ok: boolean }>("DELETE", `${w(id)}/files?${q({ folder })}`),
  /** `ifUntitled`: only while `from` is still an untitled note (naming it after its heading). */
  rename: (id: string, from: string, to: string, ifUntitled = false) => req<{ path: string }>("POST", `${w(id)}/rename`, { from, to, ...(ifUntitled ? { ifUntitled } : {}) }),
  renameFolder: (id: string, from: string, to: string) => req<{ path: string }>("POST", `${w(id)}/rename`, { from, to, folder: true }),
  history: (id: string, path: string, limit?: number) => req<Commit[]>("GET", `${w(id)}/history?${q({ path, limit })}`),
  diff: (id: string, sha: string, path?: string) => req<{ diff: string }>("GET", `${w(id)}/diff?${q({ sha, path })}`),
  restore: (id: string, path: string, sha: string) => req<{ ok: boolean }>("POST", `${w(id)}/restore`, { path, sha }),
  /** Upload an image next to note `note`: its repo path and the Markdown that shows it in the note. */
  uploadImage: async (id: string, note: string, file: File): Promise<{ path: string; markdownPath: string; markdown: string }> => {
    const res = await fetch(`${w(id)}/images?${q({ note, name: file.name || "image" })}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { ...guestHeaders, "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    const data = (await res.json().catch(() => null)) as { error?: string; path: string; markdownPath: string; markdown: string } | null;
    if (!res.ok || !data) throw new ApiError(res.status, data?.error ?? (res.status === 413 ? "the image is too large (10 MB at most)" : res.statusText));
    return data;
  },
};

/** An image in a workspace, as notes show it. */
export const rawUrl = (id: string, path: string) => `${w(id)}/raw?${new URLSearchParams({ path })}`;

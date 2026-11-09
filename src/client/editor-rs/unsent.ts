// Edits the server hasn't acked yet, kept per user and note in IndexedDB (`grimoire-unsent`) until the next open of
// the note merges them (recover.ts): the Yjs update from Engine.recover_unsent (every local edit of the session), the
// room generation (note id and epoch) it was made in, the text the server last had (the merge base) and the
// editor's text. Written 400 ms after edits the server hasn't acked, when the page goes away and when the engine
// crashes; dropped once the server acks everything (collab.ts). Same generation: the update merges as is (what the
// server already has is skipped); another epoch: a 3-way text merge of base → text onto the server's text.
// Reads are synchronous from a copy loaded at startup (loadUnsent); writes go to IndexedDB in the background.
// Without IndexedDB (private modes), sessionStorage.

export interface KeptEdits {
  /** The room generation (hello) the edits were made in; null if unknown. */
  generation: string | null;
  /** The note's text the server last had (the merge base). */
  base: string;
  /** The editor's text when kept. */
  text: string;
  /** Engine.recover_unsent: the session's edits as a Yjs update. */
  update: Uint8Array;
  /** Texts of earlier sessions that couldn't be merged (still offered to copy). */
  older?: string[];
}

const PREFIX = "grimoire.unsent:";
const DB = "grimoire-unsent";
const STORE = "edits";
const key = (user: string, repo: string, path: string) => `${PREFIX}${user}\u0000${repo}\u0000${path}`;

const cache = new Map<string, KeptEdits>();
let db: IDBDatabase | null = null;

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function parse(raw: unknown): KeptEdits | null {
  const o = (typeof raw === "string" ? JSON.parse(raw) : raw) as { v?: number; generation?: unknown; base?: unknown; text?: unknown; update?: unknown; older?: unknown } | null;
  if (!o || o.v !== 2 || typeof o.base !== "string" || typeof o.text !== "string" || typeof o.update !== "string") return null;
  return {
    generation: typeof o.generation === "string" ? o.generation : null,
    base: o.base,
    text: o.text,
    update: Uint8Array.from(atob(o.update), (c) => c.charCodeAt(0)),
    ...(Array.isArray(o.older) && o.older.length ? { older: o.older.filter((t): t is string => typeof t === "string") } : {}),
  };
}

const serialize = (k: KeptEdits) => ({ v: 2, generation: k.generation, base: k.base, text: k.text, update: toB64(k.update), older: k.older?.length ? k.older : undefined });

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Load what's kept (call once at startup, before notes open). */
export async function loadUnsent(): Promise<void> {
  // entries kept by older versions (this tab's sessionStorage)
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const v = parse(sessionStorage.getItem(k));
      if (v) cache.set(k, v);
    }
  } catch {}
  db = await Promise.race([open(), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db!.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        const v = parse(c.value);
        if (v && typeof c.key === "string" && !cache.has(c.key)) cache.set(c.key, v);
        c.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function write(k: string, v: KeptEdits | null) {
  if (db) {
    try {
      const tx = db.transaction(STORE, "readwrite");
      if (v) tx.objectStore(STORE).put(serialize(v), k);
      else tx.objectStore(STORE).delete(k);
      return true;
    } catch {}
  }
  try {
    if (v) sessionStorage.setItem(k, JSON.stringify(serialize(v)));
    else sessionStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/** Keep a session's unacked edits for this note. False if they couldn't be stored. */
export function keepUnsent(user: string, repo: string, path: string, kept: KeptEdits): boolean {
  const k = key(user, repo, path);
  cache.set(k, kept);
  return write(k, kept);
}

/** The edits kept for this note, if any. */
export function keptUnsent(user: string, repo: string, path: string): KeptEdits | null {
  return cache.get(key(user, repo, path)) ?? null;
}

export function forgetUnsent(user: string, repo: string, path: string): void {
  const k = key(user, repo, path);
  cache.delete(k);
  write(k, null);
  try {
    sessionStorage.removeItem(k);
  } catch {}
}

/** Drop every note's kept edits of `user` (signing out), and entries from before they were kept per user. */
export function forgetAllUnsent(user: string): void {
  const mine = `${PREFIX}${user}\u0000`;
  for (const k of [...cache.keys()]) {
    if (k.startsWith(mine) || k.split("\u0000").length === 2) {
      cache.delete(k);
      write(k, null);
    }
  }
  try {
    const drop: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX) && (k.startsWith(mine) || k.split("\u0000").length === 2)) drop.push(k);
    }
    for (const k of drop) sessionStorage.removeItem(k);
  } catch {}
}

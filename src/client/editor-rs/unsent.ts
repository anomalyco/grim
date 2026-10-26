// Edits of a session whose engine crashed (a Yjs update from Engine.recover_unsent), kept per note in this tab's
// sessionStorage until the next load merges them (recover.ts).

const key = (repo: string, path: string) => `grimoire.unsent:${repo}\u0000${path}`;

/** Keep a crashed session's edits for this note (base64 in sessionStorage; this tab only). */
export function keepUnsent(repo: string, path: string, update: Uint8Array): boolean {
  try {
    let bin = "";
    for (let i = 0; i < update.length; i += 0x8000) bin += String.fromCharCode(...update.subarray(i, i + 0x8000));
    sessionStorage.setItem(key(repo, path), btoa(bin));
    return true;
  } catch {
    return false;
  }
}

/** The edits kept for this note, if any. */
export function keptUnsent(repo: string, path: string): Uint8Array | null {
  try {
    const b64 = sessionStorage.getItem(key(repo, path));
    return b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : null;
  } catch {
    return null;
  }
}

export function forgetUnsent(repo: string, path: string): void {
  try {
    sessionStorage.removeItem(key(repo, path));
  } catch {}
}

// Review mode (per note, per user, on this browser only): turning it on records the note's text then (the
// baseline); while it's on, the lines we've written since are highlighted (editor-rs/authors.ts `reviewed`).
// Turning it off forgets the baseline. Kept in localStorage, so a reload keeps it while it's on.

const PREFIX = "grimoire.review:";

/** One note's review session: the text it started from, and when. */
export interface ReviewSession {
  baseline: string;
  at: number;
}

/** The localStorage key of a note's review session: this server (origin), the workspace and the note's path. */
export function reviewKey(repo: string, path: string, origin = location.origin): string {
  return `${PREFIX}${origin}\u0000${repo}\u0000${path}`;
}

export function loadReview(repo: string, path: string): ReviewSession | null {
  try {
    const raw = localStorage.getItem(reviewKey(repo, path));
    const r = raw ? (JSON.parse(raw) as Partial<ReviewSession>) : null;
    return r && typeof r.baseline === "string" ? { baseline: r.baseline, at: typeof r.at === "number" ? r.at : 0 } : null;
  } catch {
    return null;
  }
}

/** Start a review session from `baseline` (null: end it). */
export function saveReview(repo: string, path: string, baseline: string | null): void {
  try {
    if (baseline === null) localStorage.removeItem(reviewKey(repo, path));
    else localStorage.setItem(reviewKey(repo, path), JSON.stringify({ baseline, at: Date.now() } satisfies ReviewSession));
  } catch {}
}

/** The review toggle's label: "Review", or with the highlighted lines' count while on. */
export function reviewLabel(on: boolean, count: number): string {
  return on && count > 0 ? `Review · ${count} ${count === 1 ? "edit" : "edits"}` : "Review";
}

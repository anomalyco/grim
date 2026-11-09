// Review mode (per note, on this device only, nothing on the server): shows the latest batch of changes from the
// latest author, whoever that is (you, someone else or an agent).
//
// Turning it on walks the note's commit history from the newest commit: the latest author is the newest commit's
// author, or, when the note has live edits not committed yet, whoever made those (the line author of most of the
// lines that differ from the newest commit). Going back while commits have that same author, the baseline is the
// note's text at the first commit by somebody else (the empty note when that author made the whole history). Every
// line that differs from the baseline is highlighted (added or changed lines; deletions aren't shown).
//
// While it's on, the baseline stays put and the highlights follow the text live, so edits anyone makes after that
// are highlighted too (a different author's included) until it's turned off and on again, which recomputes it.

import { linePairs } from "../shared/textdiff.ts";

/** A commit as the history API gives it. */
export interface ReviewCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
}

/** Who a commit or live edit is by: a name, and an email when known. */
export interface ReviewAuthor {
  name: string;
  email?: string;
}

/** How many commits review mode reads (the history API's page). */
export const REVIEW_HISTORY = 100;

/** A name as commits and line authors both spell it: guests' commits add " (guest)". */
function plainName(name: string): string {
  return name.replace(/ \(guest\)$/, "").trim().toLowerCase();
}

/** Whether two authors are the same person or agent: the same email when both have one, else the same name. */
export function sameAuthor(a: ReviewAuthor, b: ReviewAuthor): boolean {
  const ea = a.email?.trim().toLowerCase();
  const eb = b.email?.trim().toLowerCase();
  if (ea && eb) return ea === eb;
  return plainName(a.name) === plainName(b.name);
}

/**
 * The latest batch: its author (`live`, who made uncommitted edits, else the newest commit's author) and the commit
 * whose text is the baseline (`null`: the empty note). `commits` are newest first; a full page (`limit`) all by the
 * same author uses its oldest commit as the baseline.
 */
export function latestBatch(commits: ReviewCommit[], live: ReviewAuthor | null, limit = REVIEW_HISTORY): { author: ReviewAuthor | null; baseline: string | null } {
  const head = commits[0];
  const author = live ?? (head ? { name: head.authorName, email: head.authorEmail } : null);
  if (!author) return { author: null, baseline: null };
  const other = commits.find((c) => !sameAuthor({ name: c.authorName, email: c.authorEmail }, author));
  if (other) return { author, baseline: other.sha };
  return { author, baseline: commits.length >= limit ? commits[commits.length - 1]!.sha : null };
}

/** Per line of `text`: whether it's highlighted, i.e. not blank and not a line of `baseline` (line diff). */
export function reviewChanged(baseline: string, text: string): boolean[] {
  const lines = text.split("\n");
  const kept = new Set(linePairs(baseline.split("\n"), lines).map(([, b]) => b));
  return lines.map((l, i) => !kept.has(i) && !!l.trim());
}

/** The header pill: "Review" while off; "Reviewing: Alice · 12 lines" while on. */
export function reviewLabel(author: string | null, count: number): string {
  if (author === null) return "Review";
  return `Reviewing: ${author} · ${count} ${count === 1 ? "line" : "lines"}`;
}

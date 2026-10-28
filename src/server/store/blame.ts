// Git blame computed from a file's versions, for stores without a blame of their own (the memory store, and Code
// Storage when its blame endpoint fails).
import { linePairs } from "../../shared/textdiff.ts";
import type { Author } from "./types.ts";

/** How many of a file's versions (newest first) a computed blame looks at; older lines go to the oldest one seen. */
export const BLAME_DEPTH = 200;

/**
 * When the blame has to be computed over the network (Code Storage's fallback): how many versions it reads, and how
 * many at once (Workers allows 6 simultaneous outbound connections per request).
 */
export const REMOTE_BLAME_DEPTH = 50;
export const REMOTE_BLAME_PARALLEL = 4;

/** A file's lines as Git counts and compares them: with their newlines (none after a final newline). */
export function gitLines(text: string): string[] {
  return text ? text.split(/(?<=\n)/) : [];
}

/**
 * Blame from a file's versions, oldest first: every line of the oldest version is its author's, then each version
 * keeps the authors of the lines it left as they were (a line diff with the previous version) and takes the
 * others. One author per line of the newest version (gitLines).
 */
export function blameFromVersions(versions: Array<{ text: string; author: Author }>): Author[] {
  let prev: string[] = [];
  let authors: Author[] = [];
  for (const v of versions) {
    const lines = gitLines(v.text);
    const next: Author[] = new Array(lines.length).fill(v.author);
    for (const [a, b] of linePairs(prev, lines)) next[b] = authors[a]!;
    prev = lines;
    authors = next;
  }
  return authors;
}

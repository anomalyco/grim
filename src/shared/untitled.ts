// New notes start as "Untitled.md" ("Untitled 2.md", …) and are named once after their first-line H1 (the web app
// and the Mac app follow the same rules). Shared by the client and the server.

const UNTITLED = /^Untitled(?: ([2-9]|[1-9]\d+))?\.md$/;

/** Whether a note's file name (any folder) is an untitled one: Untitled.md, Untitled 2.md, … */
export function isUntitledPath(path: string): boolean {
  return UNTITLED.test(path.slice(path.lastIndexOf("/") + 1));
}

/** The plain text of a first line that is an H1 (`# Title`), or null (not an H1, or nothing in it). */
export function headingTitle(firstLine: string): string | null {
  const m = /^#[ \t]+(.*)$/.exec(firstLine);
  if (!m) return null;
  let t = m[1]!.replace(/[ \t]+#+[ \t]*$/, ""); // closing #s
  t = t
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
    .replace(/<[^>]+>/g, "") // HTML tags
    .replace(/`+/g, "")
    .replace(/(\*\*|__|~~|==)/g, "")
    .replace(/(^|[^\p{L}\p{N}])[*_]+|[*_]+(?=[^\p{L}\p{N}]|$)/gu, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!~=|])/g, "$1");
  t = t.replace(/\s+/g, " ").trim();
  return t || null;
}

const MAX_NAME = 80;

/**
 * A file name (without folder or extension) from a title: characters files can't have (`/ \ : * ? " < > |` and
 * control characters) become spaces, spaces collapse, no leading dots, at most 80 characters. null if nothing is left.
 */
export function fileNameFromTitle(title: string): string | null {
  let n = title.replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  n = n.replace(/^\.+/, "").trim();
  if (n.length > MAX_NAME) n = n.slice(0, MAX_NAME).trim();
  return n || null;
}

/** `<dir><name>.md`, or `<dir><name> 2.md`, `<dir><name> 3.md`… if taken (`dir` "" or ending in "/"). */
export function uniqueNotePath(taken: Iterable<string>, dir: string, name: string): string {
  const set = new Set([...taken].map((p) => p.toLowerCase()));
  for (let i = 1; ; i++) {
    const p = `${dir}${name}${i === 1 ? "" : ` ${i}`}.md`;
    if (!set.has(p.toLowerCase())) return p;
  }
}

/** Where a new note goes: the first free Untitled name in `dir`. */
export const untitledPath = (taken: Iterable<string>, dir: string) => uniqueNotePath(taken, dir, "Untitled");

/** The note's new path after its heading, or null when it shouldn't be renamed (not untitled, no H1 title). */
export function autoNamePath(path: string, text: string, taken: Iterable<string>): string | null {
  if (!isUntitledPath(path)) return null;
  const title = headingTitle(text.split("\n", 1)[0] ?? "");
  const name = title ? fileNameFromTitle(title) : null;
  if (!name) return null;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  return uniqueNotePath([...taken].filter((p) => p !== path), dir, name);
}

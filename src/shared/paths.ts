// Which paths in note URLs and links name notes and which name files: only the last segment counts, and `.md` is added
// only when it has no extension (`plan` -> plan.md, `v2.0/plan` -> v2.0/plan.md; `artifacts/x/index.html`,
// `images/a.png` and `v1.2` are files, as written).

const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** A path's extension (letters and digits after the last segment's last dot, lower case), or "" (`.env`, `notes`). */
export function extensionOf(path: string): string {
  const name = (path.split("/").pop() ?? "").replace(/^\.+/, "");
  return /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
}

/** Whether a path names a file that isn't a note: its last segment has an extension other than Markdown's. */
export function isFilePath(path: string): boolean {
  return !!extensionOf(path) && !MARKDOWN.test(path);
}

/** The note or file a URL's or link's path names: `.md` added when its last segment has no extension. */
export function withNoteExtension(path: string): string {
  return path && !extensionOf(path) ? path + ".md" : path;
}

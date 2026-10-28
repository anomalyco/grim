// New notes start as "Untitled.md" ("Untitled 2.md", …) and are named once after their first-line H1. The rules are
// the Mac app's (grimoire-native crates/app/src/files.rs: is_untitled, heading_title, free_name), ported exactly.
// Shared by the client and the server.

/** Whether a note's file name (any folder) is an untitled one: `Untitled.md` or `Untitled <digits>.md`. */
export function isUntitledPath(path: string): boolean {
  return /^Untitled(?: [0-9]+)?\.md$/.test(path.slice(path.lastIndexOf("/") + 1));
}

/** The longest name a note gets from its heading (characters, before `.md`). */
export const TITLE_MAX = 80;

/**
 * A note's file name (without `.md`) from its first line when that's an H1 (`# Some title`): the heading's plain
 * text (links → their text, Markdown markers dropped), `/ \ : * ? " < > |` and control characters → spaces, spaces
 * collapsed, no leading dots, trimmed, at most TITLE_MAX characters. null for an empty heading or a first line that
 * isn't an H1.
 */
export function headingTitle(text: string): string | null {
  const first = text.split("\n", 1)[0] ?? "";
  if (!first.startsWith("#")) return null;
  const rest = first.slice(1);
  if (!rest.startsWith(" ") && !rest.startsWith("\t")) return null;
  // an optional closing sequence of #s
  let body = rest.trim();
  const stripped = body.replace(/#+$/, "");
  if (stripped.length < body.length && (stripped === "" || /[ \t]$/.test(stripped))) body = stripped.trimEnd();
  const plain = plainInline(body);
  let out = "";
  for (const ch of plain) {
    const bad = /[/\\:*?"<>|]/.test(ch) || /\p{Cc}/u.test(ch);
    const c = bad || /\s/u.test(ch) ? " " : ch;
    if (c === " " && (out === "" || out.endsWith(" "))) continue;
    out += c;
  }
  out = out.replace(/^[. ]+/, "").trimEnd();
  out = Array.from(out).slice(0, TITLE_MAX).join("").trimEnd();
  return out || null;
}

const isAsciiPunct = (c: string | undefined) => !!c && /^[!-/:-@[-`{-~]$/.test(c);
const isAlnum = (c: string | undefined) => !!c && /^[\p{L}\p{N}]$/u.test(c);

/**
 * A heading's text without Markdown: `![alt](src)` → alt, `[text](url)` → text, backslash escapes, and the emphasis,
 * code, strikethrough and highlight markers (`*`, `` ` ``, `~~`, `==`, and `_` at a word's edge).
 */
function plainInline(s: string): string {
  const c = Array.from(s);
  let out = "";
  let i = 0;
  while (i < c.length) {
    const ch = c[i]!;
    if (ch === "\\" && i + 1 < c.length && isAsciiPunct(c[i + 1])) {
      out += c[i + 1];
      i += 2;
      continue;
    }
    const open = ch === "!" && c[i + 1] === "[" ? i + 1 : ch === "[" ? i : -1;
    if (open >= 0) {
      const close = c.indexOf("]", open + 1);
      const end = close >= 0 && c[close + 1] === "(" ? c.indexOf(")", close + 2) : -1;
      if (end >= 0) {
        out += plainInline(c.slice(open + 1, close).join(""));
        i = end + 1;
        continue;
      }
    }
    if ((ch === "~" && c[i + 1] === "~") || (ch === "=" && c[i + 1] === "=")) {
      i += 2;
      continue;
    }
    if (ch === "*" || ch === "`") {
      i++;
      continue;
    }
    if (ch === "_") {
      const before = i > 0 && c[i - 1] !== "_" ? c[i - 1] : undefined;
      const after = c.slice(i + 1).find((x) => x !== "_");
      if (!(isAlnum(before) && isAlnum(after))) {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** `<dir><name>.md`, or `<dir><name> 2.md`, `<dir><name> 3.md`… if taken, case-insensitively (`dir` "" or ending in "/"). */
export function uniqueNotePath(taken: Iterable<string>, dir: string, name: string): string {
  const set = new Set([...taken].map((p) => p.toLowerCase()));
  for (let i = 1; ; i++) {
    const p = `${dir}${name}${i === 1 ? "" : ` ${i}`}.md`;
    if (!set.has(p.toLowerCase())) return p;
  }
}

/** Where a new note goes: the first free Untitled name in `dir`. */
export const untitledPath = (taken: Iterable<string>, dir: string) => uniqueNotePath(taken, dir, "Untitled");

/**
 * The note's new path after its heading, or null when it isn't renamed: the note isn't untitled, the first line
 * isn't an H1 with a title, or the title is itself an untitled name ("Untitled", "Untitled 3").
 */
export function autoNamePath(path: string, text: string, taken: Iterable<string>): string | null {
  if (!isUntitledPath(path)) return null;
  const name = headingTitle(text);
  if (!name || isUntitledPath(`${name}.md`)) return null;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  return uniqueNotePath([...taken].filter((p) => p !== path), dir, name);
}

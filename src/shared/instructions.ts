// A note's instructions for agents: the first fenced code block with the language `instructions` (or `instruction`)
// at the top of the note, where only blank lines, front matter (--- … ---) and one title heading may come before it.
// Agents must have read a note's current block before the server takes their edits to it (server/instructions.ts);
// the editors (web and Mac) show it as an "Instructions for agents" callout.

export const INSTRUCTIONS_LANGS = ["instructions", "instruction"];

export interface InstructionsBlock {
  /** Line index of the opening fence. */
  open: number;
  /** Line index of the closing fence (the last line when the block isn't closed: it runs to the end, as in CommonMark). */
  close: number;
  /** The block's content, between the fences ("\r" dropped). */
  body: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*\{?\.?([^\s`{},;]+)/;
/** Front matter longer than this (lines) isn't looked for: a note starting with a --- rule isn't scanned to its end. */
const MAX_FRONT_MATTER = 200;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/** The note's instructions block, from its lines (text.split("\n")), or null when it has none at the top. */
export function instructionsBlockOf(lines: readonly string[]): InstructionsBlock | null {
  return instructionsBlockAt(lines.length, (i) => lines[i]!);
}

/** `instructionsBlockOf` over `n` lines read on demand (an editor's: only the top of the note is looked at). */
export function instructionsBlockAt(n: number, lineAt: (i: number) => string): InstructionsBlock | null {
  const line = (i: number) => lineAt(i).replace(/\r$/, "");
  const blank = (i: number) => !line(i).trim();
  let i = 0;
  while (i < n && blank(i)) i++;
  if (i < n && line(i).trimEnd() === "---") {
    let j = i + 1;
    while (j < n && j < i + MAX_FRONT_MATTER && line(j).trimEnd() !== "---" && line(j).trimEnd() !== "...") j++;
    if (j < n && j < i + MAX_FRONT_MATTER) {
      i = j + 1;
      while (i < n && blank(i)) i++;
    }
  }
  if (i < n && HEADING.test(line(i))) {
    i++;
    while (i < n && blank(i)) i++;
  }
  if (i >= n) return null;
  const m = FENCE.exec(line(i));
  if (!m || !INSTRUCTIONS_LANGS.includes(m[2]!.toLowerCase())) return null;
  const fence = m[1]!;
  if (fence[0] === "`" && line(i).slice(m[0].length).includes("`")) return null;
  const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
  let close = i + 1;
  while (close < n && !closing.test(line(close))) close++;
  const body = Array.from({ length: Math.min(close, n) - i - 1 }, (_, k) => line(i + 1 + k)).join("\n");
  return { open: i, close: Math.min(close, n - 1), body };
}

/** The note's instructions (the block's content), or null when it has none. */
export function instructionsOf(text: string): string | null {
  return instructionsBlockOf(text.split("\n"))?.body ?? null;
}

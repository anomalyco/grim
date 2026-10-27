// The languages @pierre/highlights knows (names and aliases, lower case), without the highlighter itself: a small
// chunk code.ts loads to decide whether a note needs the highlighter. Plain text (id 0) isn't highlighted.
import languages from "../../../node_modules/@pierre/highlights/dist/languages.js";

const ids: Record<string, number> = languages;

export function supported(lang: string): boolean {
  const id = Object.hasOwn(ids, lang) ? ids[lang] : undefined;
  return typeof id === "number" && id !== 0;
}

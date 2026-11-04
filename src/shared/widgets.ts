// Inline widgets in Markdown: `<name attr="value" … />`, a self-closing tag in a paragraph, list item, quote or
// table cell. Only known names with the attributes they need are widgets; anything else stays literal text. Not in
// inline code or fenced code (the editor checks that against its line views: render.ts), nor after a backslash
// (`\<session … />` stays literal). The syntax matches Grim for Mac's.
//
// Pure: no DOM, used by the web editor and available to the server.

export interface WidgetMatch {
  /** The tag's range in the text it was found in: `<` to after `/>`. */
  from: number;
  to: number;
  name: string;
  /** Attributes as written (the first of a repeated name wins), values unescaped of nothing: taken verbatim. */
  attrs: Record<string, string>;
}

/** What a widget needs to be one: the names Grim knows and the attributes each requires (non-empty). */
export const WIDGETS: Record<string, { required: string[] }> = {
  session: { required: ["id"] },
};

// `<name`, then ` attr="value"` / ` attr='value'` pairs (at least one space before each), optional spaces, `/>`
const TAG = /<([A-Za-z][\w-]*)((?:\s+[A-Za-z_][\w-]*=(?:"[^"\n]*"|'[^'\n]*'))*)\s*\/>/g;
const ATTR = /([A-Za-z_][\w-]*)=(?:"([^"\n]*)"|'([^'\n]*)')/g;

/** Whether `name` with `attrs` is a widget Grim draws (known, with its required attributes non-empty). */
export function isWidget(name: string, attrs: Record<string, string>): boolean {
  const def = Object.hasOwn(WIDGETS, name) ? WIDGETS[name] : undefined;
  return !!def && def.required.every((a) => !!attrs[a]?.trim());
}

/**
 * The widgets in `text` (one line, or any text without code), in order. Tags that aren't widgets (unknown names,
 * missing attributes), and tags right after a backslash, aren't returned.
 */
export function findWidgets(text: string): WidgetMatch[] {
  if (!text.includes("/>")) return [];
  const out: WidgetMatch[] = [];
  TAG.lastIndex = 0;
  for (let m = TAG.exec(text); m; m = TAG.exec(text)) {
    if (m.index > 0 && text[m.index - 1] === "\\") continue;
    const name = m[1]!;
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = 0;
    for (let a = ATTR.exec(m[2]!); a; a = ATTR.exec(m[2]!)) if (!Object.hasOwn(attrs, a[1]!)) attrs[a[1]!] = a[2] ?? a[3] ?? "";
    if (!isWidget(name, attrs)) continue;
    out.push({ from: m.index, to: m.index + m[0].length, name, attrs });
  }
  return out;
}

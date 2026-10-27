// The code highlighting theme (src/shared/highlight-theme.json, shared with the native app) as CSS classes for the
// web editor: one class per distinct token style (`hk<n>` on the token's span), one per line background (`hkl<n>` on
// the line div, diff/patch lines). Token names are @pierre/highlights' (tokenNames); a token takes the style of its
// longest dotted prefix in the theme (keyword.control -> keyword), else the text colour (no class).

export interface TokenStyle {
  color?: string;
  italic?: boolean;
  bold?: boolean;
}

export interface CodeTheme {
  foreground?: string;
  tokens: Record<string, TokenStyle>;
  /** Backgrounds of whole lines, by the name of the line's first token (non-object entries are comments). */
  lines?: Record<string, { background: string } | string>;
}

/** The theme style of token `name` (longest dotted prefix), or null (the text colour). */
export function resolveToken(theme: CodeTheme, name: string): TokenStyle | null {
  for (let n = name; ; ) {
    const s = Object.hasOwn(theme.tokens, n) ? theme.tokens[n] : undefined;
    if (s && typeof s === "object") return s;
    const dot = n.lastIndexOf(".");
    if (dot < 0) return null;
    n = n.slice(0, dot);
  }
}

/**
 * The line background for a line whose first token that isn't punctuation is `name` (diff.plus / diff.minus; the
 * leading "+"/"-" is a punctuation token of its own). Same rule as the native app; `---`/`+++` headers count too.
 */
export function lineBackground(theme: CodeTheme, name: string): string | null {
  const l = theme.lines && Object.hasOwn(theme.lines, name) ? theme.lines[name] : undefined;
  return l && typeof l === "object" ? l.background : null;
}

export interface ThemeClasses {
  /** Span class per token id ("" = text colour). */
  token: string[];
  /** Line class per token id, for the line's first token ("" = none). */
  line: string[];
  /** Token ids that don't decide a line's class (punctuation: a diff line's leading "+"/"-" is its own token). */
  lead: boolean[];
  css: string;
}

const isColor = (c: unknown): c is string => typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c);

/** Classes and CSS for `names` (token names by id). */
export function themeClasses(theme: CodeTheme, names: readonly string[]): ThemeClasses {
  const styles = new Map<string, string>();
  const bgs = new Map<string, string>();
  const token: string[] = [];
  const line: string[] = [];
  const lead: boolean[] = [];
  let css = "";
  for (const name of names) {
    const s = resolveToken(theme, name);
    let decl = "";
    if (s) {
      if (isColor(s.color)) decl += `color:${s.color};`;
      if (s.italic) decl += "font-style:italic;";
      if (s.bold) decl += "font-weight:600;";
    }
    let cls = "";
    if (decl) {
      cls = styles.get(decl) ?? "";
      if (!cls) {
        cls = "hk" + styles.size;
        styles.set(decl, cls);
        css += `.mde .ln.in-code .${cls}{${decl}}\n`;
      }
    }
    token.push(cls);
    const bg = lineBackground(theme, name);
    let lc = "";
    if (isColor(bg)) {
      lc = bgs.get(bg) ?? "";
      if (!lc) {
        lc = "hkl" + bgs.size;
        bgs.set(bg, lc);
        css += `.mde .ln.in-code.${lc}{background:${bg}}\n`;
      }
    }
    line.push(lc);
    lead.push(name.startsWith("punctuation"));
  }
  return { token, line, lead, css };
}

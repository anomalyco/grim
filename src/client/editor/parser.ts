// Markdown parser for the editor: a block pass (one entry per source line) and an inline pass per block.
// All offsets are absolute UTF-16 offsets into the raw document string. Pure functions, no DOM.

export type BlockType =
  | "paragraph"
  | "heading"
  | "bullet"
  | "todo"
  | "numbered"
  | "quote"
  | "hr"
  | "fence"
  | "code"
  | "table-head"
  | "table-delim"
  | "table-row";

export type CellAlign = "left" | "center" | "right" | null;

/** GFM table info of a table line. */
export interface TableLine {
  /** Line indices of the header row and of the last row. */
  start: number;
  end: number;
  /** Column alignments (from the delimiter row). */
  align: CellAlign[];
  /** Offsets of the cell-separating pipes. */
  pipes: number[];
  /** Cell content ranges between the pipes (including surrounding spaces). */
  cells: [number, number][];
}

export type TokenKind = "indent" | "heading" | "bullet" | "todo" | "numbered" | "quote" | "hr";

/** An atomic prefix token: one caret unit. */
export interface Token {
  kind: TokenKind;
  from: number;
  to: number;
}

export type InlineType = "bold" | "italic" | "strike" | "underline" | "highlight" | "code" | "link" | "tag" | "image";

export interface InlineEl {
  type: InlineType;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  /** Collapsible marker ranges (revealed together with the element). */
  markers: [number, number][];
  /** Link URL range: an atomic, always-visible chip. */
  url?: [number, number];
  /** Images: the source range (inside the parentheses, without the title) and the title's text, if any. */
  src?: [number, number];
  title?: string;
}

export interface Line {
  index: number;
  from: number;
  /** End of the line, excluding the newline. */
  to: number;
  text: string;
  type: BlockType;
  /** Number of leading indent tokens (levels: a tab, or a unit of spaces on list lines). */
  indent: number;
  /** Raw text of one indent level for this line ("\t", or the document's space unit for space-indented lines). */
  indentUnit: string;
  /** Heading level (1-6), 0 otherwise. */
  level: number;
  checked: boolean;
  /** Number of a numbered item. */
  number: number;
  /** Prefix tokens, in order. */
  tokens: Token[];
  /** Where the line's content starts (after all prefix tokens). */
  textFrom: number;
  /** Code blocks: line index of the opening fence and of the closing fence (or last line if unclosed); -1 otherwise. */
  blockStart: number;
  blockEnd: number;
  inline: InlineEl[];
  /** Offsets of escape backslashes (always collapsed). */
  escapes: number[];
  /** Set on table lines. */
  table?: TableLine;
}

export interface Doc {
  text: string;
  lines: Line[];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6}) /;
const HR = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TODO = /^([-*]) \[([ xX])\] /;
const BULLET = /^([-*]) /;
const NUMBERED = /^(\d{1,9})\. /;
const QUOTE = /^> /;
const LIST_START = /^(?:[-*] |\d{1,9}\. |> )/;

export function parseDoc(text: string): Doc {
  return { text, lines: parseBlocks(text) };
}

export function parseBlocks(text: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  let fence: { char: string; len: number; start: number } | null = null;
  const parts = text.split("\n");
  // space-indented lists: 2 spaces per level, or 4 when the list steps by 4
  let spaceUnit = 2;
  let prevListSpaces = -1;
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i]!;
    const from = pos;
    const to = pos + t.length;
    pos = to + 1;
    const line: Line = {
      index: i,
      from,
      to,
      text: t,
      type: "paragraph",
      indent: 0,
      indentUnit: "\t",
      level: 0,
      checked: false,
      number: 0,
      tokens: [],
      textFrom: from,
      blockStart: -1,
      blockEnd: -1,
      inline: [],
      escapes: [],
    };
    lines.push(line);

    if (fence) {
      line.blockStart = fence.start;
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(t);
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len) {
        line.type = "fence";
        for (let k = fence.start; k <= i; k++) lines[k]!.blockEnd = i;
        fence = null;
      } else {
        line.type = "code";
      }
      continue;
    }
    const fm = FENCE_OPEN.exec(t);
    if (fm && !(fm[1]![0] === "`" && fm[2]!.includes("`"))) {
      line.type = "fence";
      line.blockStart = i;
      fence = { char: fm[1]![0]!, len: fm[1]!.length, start: i };
      continue;
    }

    let ind = 0;
    const ws = /^[ \t]*/.exec(t)![0];
    if (ws.includes(" ") && LIST_START.test(t.slice(ws.length))) {
      // a list line indented with spaces (and maybe tabs): tabs and space units are indent tokens;
      // leftover spaces belong to the block token
      const spaces = ws.length - ws.replace(/ /g, "").length;
      if (!ws.includes("\t")) {
        if (prevListSpaces >= 0 && spaces > prevListSpaces) {
          const step = spaces - prevListSpaces;
          if (step % 4 === 0 && spaces % 4 === 0) spaceUnit = 4;
          else if (step === 2) spaceUnit = 2;
        }
        prevListSpaces = spaces;
      }
      line.indentUnit = " ".repeat(spaceUnit);
      let run = 0;
      for (let k = 0; k < ws.length; k++) {
        if (ws[k] === "\t") {
          run = 0;
          line.tokens.push({ kind: "indent", from: from + k, to: from + k + 1 });
          ind = k + 1;
        } else if (++run === spaceUnit) {
          run = 0;
          line.tokens.push({ kind: "indent", from: from + k + 1 - spaceUnit, to: from + k + 1 });
          ind = k + 1;
        }
      }
      line.indent = line.tokens.length;
    } else {
      while (t.charCodeAt(ind) === 9) {
        line.tokens.push({ kind: "indent", from: from + ind, to: from + ind + 1 });
        ind++;
      }
      line.indent = ind;
      if (LIST_START.test(t.slice(ind))) prevListSpaces = 0;
      else if (t.trim() !== "") prevListSpaces = -1;
    }
    // block-token regexes run after the indent tokens; leftover spaces (list lines) are part of the token
    const lead = ind < ws.length && line.indentUnit !== "\t" ? ws.length - ind : 0;
    const rest = t.slice(ind + lead);
    let m: RegExpExecArray | null;
    let tokLen = 0;
    if ((m = HEADING.exec(rest))) {
      line.type = "heading";
      line.level = m[1]!.length;
      tokLen = m[0].length;
      tokLen += lead;
      line.tokens.push({ kind: "heading", from: from + ind, to: from + ind + tokLen });
    } else if (HR.test(rest)) {
      line.type = "hr";
      tokLen = rest.length;
      line.tokens.push({ kind: "hr", from: from + ind, to: to });
    } else if ((m = TODO.exec(rest))) {
      line.type = "todo";
      line.checked = m[2] !== " ";
      tokLen = m[0].length;
      tokLen += lead;
      line.tokens.push({ kind: "todo", from: from + ind, to: from + ind + tokLen });
    } else if ((m = BULLET.exec(rest))) {
      line.type = "bullet";
      tokLen = m[0].length;
      tokLen += lead;
      line.tokens.push({ kind: "bullet", from: from + ind, to: from + ind + tokLen });
    } else if ((m = NUMBERED.exec(rest))) {
      line.type = "numbered";
      line.number = parseInt(m[1]!, 10);
      tokLen = m[0].length;
      tokLen += lead;
      line.tokens.push({ kind: "numbered", from: from + ind, to: from + ind + tokLen });
    } else if ((m = QUOTE.exec(rest))) {
      line.type = "quote";
      tokLen = m[0].length;
      tokLen += lead;
      line.tokens.push({ kind: "quote", from: from + ind, to: from + ind + tokLen });
    }
    line.textFrom = from + ind + tokLen;
  }
  if (fence) {
    const last = lines.length - 1;
    for (let k = fence.start; k <= last; k++) lines[k]!.blockEnd = last;
  }
  detectTables(text, lines);
  // Inline pass per block. Consecutive non-blank paragraph lines form one paragraph, so inline
  // elements can span soft line breaks; each line lists the elements that touch it.
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (line.table) {
      // inline elements stay inside their cell
      if (line.type !== "table-delim") {
        for (const [cf, ct] of line.table.cells) {
          // images aren't drawn in table cells: `![a](b)` stays a "!" before a link
          const r = parseInline(text, cf, ct, false);
          line.inline.push(...r.elements);
          line.escapes.push(...r.escapes);
          // "\|" inside a code span in a cell shows as "|" (GFM)
          for (const el of r.elements) {
            if (el.type !== "code") continue;
            for (let p = el.contentFrom; p + 1 < el.contentTo; p++) if (text[p] === "\\" && text[p + 1] === "|") line.escapes.push(p++);
          }
        }
      }
      i++;
      continue;
    }
    if (line.type === "code" || line.type === "fence" || line.type === "hr") {
      i++;
      continue;
    }
    let j = i + 1;
    if (isParagraphLine(line)) while (j < lines.length && isParagraphLine(lines[j]!)) j++;
    const last = lines[j - 1]!;
    const r = parseInline(text, line.textFrom, last.to);
    for (let k = i; k < j; k++) {
      const l = lines[k]!;
      l.inline = j - i === 1 ? r.elements : r.elements.filter((e) => e.from < l.to && e.to > l.textFrom);
      l.escapes = j - i === 1 ? r.escapes : r.escapes.filter((e) => e >= l.textFrom && e < l.to);
    }
    i = j;
  }
  return lines;
}

/**
 * The same line shown literally: its block prefix (except indentation) is plain text.
 * Used for the local "conversion undone" state.
 */
export function literalLine(text: string, line: Line, from: BlockType = "paragraph"): Line {
  if (line.type === "paragraph" || line.type === "code" || line.type === "fence") return line;
  const tokens = line.tokens.filter((t) => t.kind === "indent");
  let type: BlockType = "paragraph";
  if (from === "bullet" && line.type === "todo") {
    // a todo shown as the bullet it was converted from: "- " stays a token, "[ ] " is text
    const tok = line.tokens[line.tokens.length - 1]!;
    tokens.push({ kind: "bullet", from: tok.from, to: tok.from + 2 });
    type = "bullet";
  }
  const textFrom = tokens.length ? tokens[tokens.length - 1]!.to : line.from;
  const r = parseInline(text, textFrom, line.to);
  return {
    ...line,
    type,
    level: 0,
    checked: false,
    number: 0,
    tokens,
    textFrom,
    inline: r.elements,
    escapes: r.escapes,
  };
}

/** Index of the line containing `pos` (a position at a line's end belongs to that line). */
export function lineAt(lines: Line[], pos: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid]!.from <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------
// GFM tables

const DELIM_CELL = /^\s*(:?)-+(:?)\s*$/;
const BLANK = /[ \t\r]/;

/** [from, to) without surrounding spaces, tabs and carriage returns. */
export function trimRange(text: string, from: number, to: number): [number, number] {
  while (from < to && BLANK.test(text[from]!)) from++;
  while (to > from && BLANK.test(text[to - 1]!)) to--;
  return [from, to];
}

/**
 * Split a table row into cells. Pipes that are escaped (\|) don't split. Pipes inside a code span
 * don't split either: that's a deliberate deviation from GFM (where `a|b` in a cell must be written
 * `a\|b`), because agent-written tables often put pipes in code. Returns the separating pipes and
 * the cell ranges between them (outer pipes are optional).
 */
export function splitRow(text: string, from: number, to: number): { pipes: number[]; cells: [number, number][] } {
  const bars: number[] = [];
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
    } else if (c === "`") {
      let n = 1;
      while (i + n < to && text[i + n] === "`") n++;
      // find a closing run of exactly n backticks
      let j = i + n;
      let close = -1;
      while (j < to) {
        if (text[j] === "`") {
          let m = 1;
          while (j + m < to && text[j + m] === "`") m++;
          if (m === n) {
            close = j;
            break;
          }
          j += m;
        } else j++;
      }
      i = close >= 0 ? close + n - 1 : i + n - 1;
    } else if (c === "|") {
      bars.push(i);
    }
  }
  const [start, end] = trimRange(text, from, to);
  const cells: [number, number][] = [];
  const lead = bars.length > 0 && bars[0] === start;
  const trail = bars.length > 0 && bars[bars.length - 1] === end - 1 && !(lead && bars.length === 1);
  let cur = lead ? bars[0]! + 1 : from;
  for (const b of bars.slice(lead ? 1 : 0, trail ? -1 : undefined)) {
    cells.push([cur, b]);
    cur = b + 1;
  }
  cells.push([cur, trail ? bars[bars.length - 1]! : to]);
  return { pipes: bars, cells };
}

function delimAlign(text: string, line: Line): CellAlign[] | null {
  if (!line.text.includes("-")) return null;
  const { pipes, cells } = splitRow(text, line.from, line.to);
  if (!pipes.length && cells.length === 1) return null; // "---" alone is a rule, not a table
  const out: CellAlign[] = [];
  for (const [f, t] of cells) {
    const m = DELIM_CELL.exec(text.slice(f, t));
    if (!m) return null;
    out.push(m[1] && m[2] ? "center" : m[2] ? "right" : m[1] ? "left" : null);
  }
  return out;
}

/** A line that can be part of a table: a non-blank paragraph line indented by at most 3 spaces. */
function tableCandidate(l: Line | undefined): l is Line {
  return !!l && l.type === "paragraph" && /^ {0,3}[^ \t\r]/.test(l.text);
}

/**
 * Mark GFM tables: a header row, a delimiter row with the same column count, then body rows.
 * Like GFM, any following non-blank paragraph line continues the table as a row, even without
 * pipes ("lazy continuation"); a blank line or another block ends it.
 */
function detectTables(text: string, lines: Line[]): void {
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i]!;
    const delim = lines[i + 1]!;
    if (!tableCandidate(head) || !tableCandidate(delim)) continue;
    const headRow = splitRow(text, head.from, head.to);
    if (!headRow.pipes.length) continue;
    const align = delimAlign(text, delim);
    if (!align || align.length !== headRow.cells.length) continue;
    let end = i + 1;
    while (end + 1 < lines.length && tableCandidate(lines[end + 1])) end++;
    for (let k = i; k <= end; k++) {
      const l = lines[k]!;
      const row = k === i ? headRow : splitRow(text, l.from, l.to);
      l.type = k === i ? "table-head" : k === i + 1 ? "table-delim" : "table-row";
      l.tokens = [];
      l.textFrom = l.from;
      l.table = { start: i, end, align, pipes: row.pipes, cells: row.cells };
    }
    i = end;
  }
}

function isParagraphLine(l: Line): boolean {
  return l.type === "paragraph" && l.text.trim() !== "";
}

export function isListType(t: BlockType): boolean {
  return t === "bullet" || t === "todo" || t === "numbered" || t === "quote";
}

// ---------------------------------------------------------------------------------------------
// Inline pass

interface Delim {
  ch: string;
  pos: number;
  len: number;
  origLen: number;
  canOpen: boolean;
  canClose: boolean;
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const WS = /\s/;
const PUNCT = /[\p{P}\p{S}]/u;
const TAG_CHAR = /[\p{L}\p{N}\p{M}_\-/]/u;
const LETTER = /[\p{L}]/u;

export function parseInline(src: string, start: number, end: number, images = true): { elements: InlineEl[]; escapes: number[] } {
  const elements: InlineEl[] = [];
  const escapes: number[] = [];
  scan(src, start, end, elements, escapes, images);
  elements.sort((a, b) => a.from - b.from || b.to - a.to);
  return { elements, escapes };
}

function scan(s: string, start: number, end: number, out: InlineEl[], escapes: number[], images: boolean): void {
  const stack: Delim[] = [];
  let i = start;
  while (i < end) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < end && ASCII_PUNCT.test(s[i + 1]!)) {
      escapes.push(i);
      i += 2;
      continue;
    }
    if (c === "`") {
      const n = runLength(s, i, end, "`");
      let j = i + n;
      let found = -1;
      while (j < end) {
        if (s[j] === "`") {
          const m = runLength(s, j, end, "`");
          if (m === n) {
            found = j;
            break;
          }
          j += m;
        } else j++;
      }
      if (found > i + n) {
        out.push({
          type: "code",
          from: i,
          to: found + n,
          contentFrom: i + n,
          contentTo: found,
          markers: [
            [i, i + n],
            [found, found + n],
          ],
        });
        i = found + n;
      } else {
        i += n;
      }
      continue;
    }
    if (c === "!" && images && s[i + 1] === "[") {
      // an image: `![alt](src)` or `![alt](src "title")`, on one line. The whole source collapses (the image is
      // drawn below the line); the alt text is plain text, not parsed for inline styles.
      const m = matchLink(s, i + 1, end, true);
      if (m && !s.slice(i, m.end).includes("\n")) {
        const markers: [number, number][] = [[i, i + 2]];
        if (m.textEnd > i + 2) markers.push([i + 2, m.textEnd]);
        markers.push([m.textEnd, m.end]);
        out.push({
          type: "image",
          from: i,
          to: m.end,
          contentFrom: i + 2,
          contentTo: m.textEnd,
          markers,
          src: [m.textEnd + 2, m.srcEnd],
          ...(m.title !== undefined ? { title: m.title } : {}),
        });
        i = m.end;
        continue;
      }
      i++;
      continue;
    }
    if (c === "[") {
      const m = matchLink(s, i, end);
      if (m) {
        scan(s, i + 1, m.textEnd, out, escapes, images);
        out.push({
          type: "link",
          from: i,
          to: m.end,
          contentFrom: i + 1,
          contentTo: m.textEnd,
          markers: [
            [i, i + 1],
            [m.textEnd, m.textEnd + 2],
            [m.end - 1, m.end],
          ],
          url: [m.textEnd + 2, m.end - 1],
        });
        i = m.end;
        continue;
      }
      i++;
      continue;
    }
    if (c === "#" && (i === start || WS.test(s[i - 1]!))) {
      let j = i + 1;
      let letter = false;
      while (j < end && TAG_CHAR.test(s[j]!)) {
        if (LETTER.test(s[j]!)) letter = true;
        j++;
      }
      // trailing "/" or "-" is not part of a tag
      while (j > i + 1 && (s[j - 1] === "/" || s[j - 1] === "-")) j--;
      if (letter && j > i + 1) {
        out.push({ type: "tag", from: i, to: j, contentFrom: i, contentTo: j, markers: [] });
        i = j;
        continue;
      }
      i++;
      continue;
    }
    if (c === "*" || c === "_" || c === "~" || c === "=") {
      const n = runLength(s, i, end, c);
      handleDelim(s, start, end, c, i, n, stack, out);
      i += n;
      continue;
    }
    i++;
  }
}

function runLength(s: string, i: number, end: number, ch: string): number {
  let j = i;
  while (j < end && s[j] === ch) j++;
  return j - i;
}

function handleDelim(
  s: string,
  start: number,
  end: number,
  ch: string,
  pos: number,
  n: number,
  stack: Delim[],
  out: InlineEl[],
): void {
  if (ch === "=" && n !== 2) return;
  if (ch === "~" && n > 2) return;
  // CommonMark flanking rules (the block's edges count as whitespace)
  const prev = pos > start ? s[pos - 1]! : " ";
  const next = pos + n < end ? s[pos + n]! : " ";
  const left = !WS.test(next) && (!PUNCT.test(next) || WS.test(prev) || PUNCT.test(prev));
  const right = !WS.test(prev) && (!PUNCT.test(prev) || WS.test(next) || PUNCT.test(next));
  let canOpen = left;
  let canClose = right;
  if (ch === "_") {
    canOpen = left && (!right || PUNCT.test(prev));
    canClose = right && (!left || PUNCT.test(next));
  }
  const d: Delim = { ch, pos, len: n, origLen: n, canOpen, canClose };
  const emph = ch === "*" || ch === "_";
  if (canClose) {
    while (d.len > 0) {
      let k = stack.length - 1;
      while (k >= 0) {
        const o = stack[k]!;
        if (o.ch === ch) {
          if (!emph) {
            if (o.len === d.len) break;
          } else {
            // "rule of 3": a run that can both open and close doesn't pair when the lengths sum to a multiple of 3
            const both = o.canClose || d.canOpen;
            const sum = o.origLen + d.origLen;
            if (!(both && sum % 3 === 0 && !(o.origLen % 3 === 0 && d.origLen % 3 === 0))) break;
          }
        }
        k--;
      }
      if (k < 0) break;
      const o = stack[k]!;
      const use = emph ? (o.len >= 2 && d.len >= 2 ? 2 : 1) : d.len;
      const type: InlineType =
        ch === "~" ? (use === 2 ? "strike" : "underline") : ch === "=" ? "highlight" : use === 2 ? "bold" : "italic";
      const oFrom = o.pos + o.len - use;
      out.push({
        type,
        from: oFrom,
        to: d.pos + use,
        contentFrom: o.pos + o.len,
        contentTo: d.pos,
        markers: [
          [oFrom, o.pos + o.len],
          [d.pos, d.pos + use],
        ],
      });
      o.len -= use;
      d.pos += use;
      d.len -= use;
      stack.length = o.len > 0 ? k + 1 : k;
    }
  }
  if (d.len > 0 && canOpen) stack.push(d);
}

function matchLink(s: string, i: number, end: number, title = false): { textEnd: number; end: number; srcEnd: number; title?: string } | null {
  let depth = 0;
  let j = i + 1;
  for (; j < end; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      if (depth === 0) break;
      depth--;
    }
  }
  if (j >= end || s[j + 1] !== "(") return null;
  const textEnd = j;
  let k = j + 2;
  let parens = 0;
  for (; k < end && !WS.test(s[k]!); k++) {
    if (s[k] === "(") parens++;
    else if (s[k] === ")") {
      if (parens === 0) break;
      parens--;
    }
  }
  if (k === j + 2) return null;
  const srcEnd = k;
  if (title && k < end && (s[k] === " " || s[k] === "\t")) {
    // `(src "title")`, `(src 'title')` or `(src (title))`
    while (k < end && (s[k] === " " || s[k] === "\t")) k++;
    const open = s[k];
    const close = open === "(" ? ")" : open;
    if (open !== '"' && open !== "'" && open !== "(") return null;
    const t0 = k + 1;
    k = t0;
    while (k < end && s[k] !== close && s[k] !== "\n") k += s[k] === "\\" ? 2 : 1;
    if (k >= end || s[k] !== close) return null;
    const t = s.slice(t0, k).replace(/\\([!-/:-@[-`{-~])/g, "$1");
    k++;
    while (k < end && (s[k] === " " || s[k] === "\t")) k++;
    if (k >= end || s[k] !== ")") return null;
    return { textEnd, end: k + 1, srcEnd, title: t };
  }
  if (k >= end || s[k] !== ")") return null;
  return { textEnd, end: k + 1, srcEnd };
}

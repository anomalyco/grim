// Handwritten phrases from single-stroke script glyphs, in writing order, with per-letter jitter so no two look
// the same. Used by the home page bots on the server; the browser only draws the points it is sent.
import { SCRIPT_GLYPHS } from "./hershey-script.ts";
import { SIMPLEX_GLYPHS } from "./hershey-simplex.ts";

type P = [number, number];
interface Glyph {
  l: number;
  r: number;
  strokes: P[][];
}

const parse = (set: string[]): Glyph[] =>
  set.map((s) => {
    const R = 82;
    const strokes: P[][] = [[]];
    for (let i = 2; i + 1 < s.length; i += 2) {
      if (s[i] === " " && s[i + 1] === "R") strokes.push([]);
      else strokes[strokes.length - 1]!.push([s.charCodeAt(i) - R, s.charCodeAt(i + 1) - R]);
    }
    return { l: s.charCodeAt(0) - R, r: s.charCodeAt(1) - R, strokes: strokes.filter((st) => st.length > 0) };
  });

const FONTS = { script: parse(SCRIPT_GLYPHS), print: parse(SIMPLEX_GLYPHS) };

/** ✅, the way an assistant would sign off: a box with a tick that overshoots it */
const CHECK: Glyph = { l: -10, r: 13, strokes: [[[-8, -9], [8, -9], [8, 8], [-8, 8], [-8, -9]], [[-4, -1], [-1, 4], [11, -14]]] };

const glyphIn = (font: Glyph[], ch: string) => (ch === "✅" ? CHECK : (font[ch.charCodeAt(0) - 32] ?? font["?".charCodeAt(0) - 32]!));

/**
 * How someone writes. Units are glyph units (capitals are 21 tall, the baseline is y = 9). Each bot keeps one hand,
 * so its writing is recognisable whatever it writes.
 */
export interface Hand {
  font: "script" | "print";
  /** writes in capitals */
  upper?: boolean;
  /** tops lean right by this much per unit of height */
  slant: number;
  /** horizontal scale of the letters: < 1 compact, > 1 round */
  width: number;
  /** extra space after each letter, and how much it varies */
  tracking: number;
  spacingJit: number;
  /** per letter: scale variance (fraction), baseline offset, rotation (radians) */
  sizeJit: number;
  baseJit: number;
  rotJit: number;
  /** slow up-and-down drift of the baseline along a line */
  wander: number;
  /** a shaky hand: wobble along every stroke */
  tremor: number;
  /** smoothing passes (0 leaves the corners) */
  smooth: number;
  /** straightens curves into angles: points closer than this to a straight run are dropped (0: off) */
  corner: number;
  /** runs on into the next letter when it starts within this distance (0: lifts between letters) */
  join: number;
  /** letters it sometimes writes backwards, and how often */
  backwards?: string;
  backwardsOdds?: number;
  /** a swash off the end of each line, and sometimes a looping underline */
  flourish?: boolean;
  /** how often a phrase gets the looping underline (with a flourish) */
  underlineOdds?: number;
  /** a small child's mess (see Messy) */
  messy?: Messy;
}

/** How messy a hand is, beyond jitter: odds and amounts, all optional in effect (0 turns one off). */
export interface Messy {
  /** a line runs downhill (or up) by up to this slope */
  slope: number;
  /** a line starts big and shrinks along it; or runs out of room and squashes its last letters */
  shrinkOdds: number;
  squashOdds: number;
  /** after a letter: a huge gap, or the next one jammed into it */
  gapOdds: number;
  crampOdds: number;
  /** a letter comes out lowercase */
  lowerOdds: number;
  /** a loop isn't closed (or overshoots), a stroke overshoots its end */
  openOdds: number;
  /** a stroke is gone over again */
  retraceOdds: number;
  /** per line: a wrong letter, scribbled out, and the right one written after it */
  redoOdds: number;
}

/** The default: a tidy, joined-up script (what the bots wrote before they had hands of their own). */
export const PLAIN_HAND: Hand = { font: "script", slant: 0, width: 1, tracking: 0, spacingJit: 0.7, sizeJit: 0.06, baseJit: 0.9, rotJit: 0.05, wander: 0, tremor: 0, smooth: 1, corner: 0, join: 9 };

/** A small seeded PRNG (mulberry32), so a phrase can be reproduced from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An oriented box: centre, half sizes, angle (radians). */
export interface Box {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  angle: number;
}

export interface Written {
  /** Strokes in writing order, each a flat [x, y, x, y, …] list in page units. */
  strokes: number[][];
  box: Box;
}

/** Split a phrase into at most two lines of roughly `max` characters. */
export function wrapPhrase(text: string, max = 18): string[] {
  if (text.length <= max) return [text];
  const words = text.split(" ");
  // as few lines as fit `max` (a word longer than that gets a line of its own), as even as can be
  const lines = Math.max(2, Math.ceil(text.length / max));
  let best = [text];
  let bestScore = Infinity;
  const split = (from: number, left: number, acc: string[]) => {
    if (left === 1) {
      const all = [...acc, words.slice(from).join(" ")];
      const score = Math.max(...all.map((l) => l.length));
      if (score < bestScore) [best, bestScore] = [all, score];
      return;
    }
    for (let i = from + 1; i <= words.length - left + 1; i++) split(i, left - 1, [...acc, words.slice(from, i).join(" ")]);
  };
  for (let n = 2; n <= Math.min(lines + 1, words.length) && bestScore > max; n++) split(0, n, []);
  return best;
}

const advance = (hand: Hand, ch: string) => {
  const g = glyphIn(FONTS[hand.font], hand.upper ? ch.toUpperCase() : ch);
  return (g.r - g.l) * (ch === " " ? 1 : hand.width) + (ch === " " ? 0 : hand.tracking);
};

/** The unrotated size of a phrase in glyph units (before scaling), for placement. */
export function measurePhrase(lines: string[], hand: Hand = PLAIN_HAND): { w: number; h: number } {
  let w = 0;
  for (const line of lines) {
    let x = 0;
    for (const ch of line) x += advance(hand, ch);
    // (a messy hand's gaps make its lines run longer)
    w = Math.max(w, x * (hand.messy ? 1.12 : 1) + Math.abs(hand.slant) * 21);
  }
  const loose = hand.wander + hand.baseJit + hand.sizeJit * 20;
  return { w, h: 21 + (lines.length - 1) * lineUnits(hand) + 10 + loose * 2 + (hand.flourish ? 8 : 0) };
}

const LINE_UNITS = 34;
/** (a messy hand needs more room between its lines) */
const lineUnits = (hand: Hand) => LINE_UNITS + (hand.messy ? 12 : 0);

/**
 * Write `lines` with the top-left of the first line's cap height near the box's corner: the result is centred on
 * (cx, cy), rotated by `angle`, with capitals `size` units tall, in `hand`.
 */
export function writePhrase(lines: string[], opts: { cx: number; cy: number; size: number; angle: number; seed: number; hand?: Hand }): Written {
  const hand = opts.hand ?? PLAIN_HAND;
  const font = FONTS[hand.font];
  const rand = rng(opts.seed);
  const jit = (a: number) => (rand() * 2 - 1) * a;
  const s = opts.size / 21;
  const m = measurePhrase(lines, hand);
  const strokes: P[][] = [];
  const wph = rand() * 10;
  const underline = rand() < (hand.underlineOdds ?? 0);
  const wfreq = 0.035 + rand() * 0.03;
  // line height: capitals sit higher in the box than a lowercase script line
  const top = -m.h / 2 + 12 + (m.h - (21 + (lines.length - 1) * lineUnits(hand) + 10 + (hand.flourish ? 8 : 0))) / 2;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    let w = 0;
    for (const ch of line) w += advance(hand, ch);
    let pen = -m.w / 2 + jit(3) + (li ? 6 : 0);
    const base = top + li * lineUnits(hand) + jit(1.5);
    const M = hand.messy;
    // (a messy line: its slope, how it shrinks along, and which letter gets botched and redone)
    const lineStart = pen;
    const slope = M ? (rand() < 0.4 ? rand() * M.slope : jit(M.slope * 0.4)) : 0;
    const mode = M ? (rand() < M.shrinkOdds ? "shrink" : rand() < M.squashOdds ? "squash" : "") : "";
    const letters = [...line].filter((c) => c !== " ").length;
    const redo = M && letters > 2 && rand() < M.redoOdds ? 1 + Math.floor(rand() * (letters - 1)) : -1;
    let n = -1;
    const deferred: P[][] = [];
    let open: P[] | null = null;
    let lastEnd: P | null = null;
    let lastRawY = 0;
    for (const raw of line) {
      // (only letters whose small form is a different shape: a small o is just a small O, or a dot)
      const lower = !!M && "BDEGHNRTY".includes(raw.toUpperCase()) && rand() < M.lowerOdds;
      const ch = hand.upper && !lower ? raw.toUpperCase() : lower ? raw.toLowerCase() : raw;
      if (ch === " ") {
        const g = glyphIn(font, ch);
        pen += g.r - g.l + jit(2);
        flushDeferred();
        open = null;
        lastEnd = null;
        continue;
      }
      n++;
      const u = letters > 1 ? n / (letters - 1) : 0;
      const grow = mode === "shrink" ? 1.3 - 0.6 * u : mode === "squash" && u > 0.6 ? 1 - (u - 0.6) * 1.3 : 1;
      if (n === redo) {
        // the wrong letter first, scribbled out
        const wrong = glyphIn(font, String.fromCharCode(65 + Math.floor(rand() * 26)));
        const at = strokes.length;
        letter(wrong, grow, false);
        const pts = strokes.slice(at).flat();
        if (pts.length) strokes.push(scribbleOver(pts, rand));
        open = null;
        lastEnd = null;
      }
      letter(glyphIn(font, ch), grow, !!hand.backwards?.includes(ch.toUpperCase()) && rand() < (hand.backwardsOdds ?? 0));
    }
    function letter(g: Glyph, grow: number, flip: boolean) {
      const sc = (1 + jit(hand.sizeJit)) * grow;
      const rot = jit(hand.rotJit);
      const dy = jit(hand.baseJit) + Math.sin(wph + pen * wfreq) * hand.wander + (M ? Math.sin(wph * 2.3 + pen * wfreq * 2.7) * hand.wander * 0.5 + (pen - lineStart) * slope : 0);
      const dx = jit(0.6);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const span = (g.r - g.l) * hand.width * (grow < 1 ? grow : 1);
      const pivot = hand.upper ? -1.5 : 4;
      const place = (p: P): P => {
        let lx = (p[0] - g.l) * hand.width * (grow < 1 ? grow : 1);
        if (flip) lx = span - lx;
        const x = (lx - span / 2) * (grow < 1 ? 1 : sc);
        const y = (p[1] - pivot) * sc;
        const X = x * cos - y * sin;
        const Y = pivot + x * sin + y * cos;
        return [pen + (span * (grow < 1 ? 1 : sc)) / 2 + dx + X - (Y - 9) * hand.slant, base + 4 + dy + Y - 4];
      };
      let first = true;
      for (const raw of g.strokes) {
        const st = M ? loosen(raw, M, rand) : raw;
        const pts = st.map(place);
        const ext = Math.max(...st.map((p) => p[0])) - Math.min(...st.map((p) => p[0])) + Math.max(...st.map((p) => p[1])) - Math.min(...st.map((p) => p[1]));
        // dots go on after the word, like people do
        if (ext <= 3) {
          deferred.push(pts);
          continue;
        }
        const start = pts[0]!;
        const gap = lastEnd ? Math.hypot(start[0] - lastEnd[0], start[1] - lastEnd[1]) : Infinity;
        // cursive: run on into the next letter when its first stroke starts near where the last one left off, in the
        // lowercase band; within a letter, only when the pen would barely lift
        const band = (y: number) => y >= -1 && y <= 9;
        const joins = first ? gap < hand.join && band(lastRawY) && band(st[0]![1]) : gap < 2.5;
        if (open && lastEnd && joins) {
          open.push(...pts.slice(gap < 0.5 ? 1 : 0));
        } else {
          open = pts;
          strokes.push(open);
        }
        // going back over it (the pen doesn't lift)
        if (M && rand() < M.retraceOdds) {
          const back = pts.slice(0, -1).reverse().map(([x, y]): P => [x + jit(0.8), y + jit(0.8)]);
          open!.push(...back);
        }
        lastEnd = open![open!.length - 1]!;
        lastRawY = st[st.length - 1]![1];
        first = false;
      }
      const r = rand();
      const extra = M && r < M.gapOdds ? 5 + rand() * 9 : M && r < M.gapOdds + M.crampOdds ? -(1 + rand() * 3) : jit(hand.spacingJit);
      pen += span * (grow < 1 ? 1 : sc) + hand.tracking + extra;
    }
    flushDeferred();
    if (hand.flourish && open) swash(open, li === lines.length - 1 && underline ? -m.w / 2 + 4 : null, base, rand, strokes);
    function flushDeferred() {
      strokes.push(...deferred.splice(0));
    }
  }
  // straighten (or smooth) the polylines, shake them, then rotate and scale into place
  const cos = Math.cos(opts.angle);
  const sin = Math.sin(opts.angle);
  const ph = rand() * 10;
  const out = strokes.map((st) => {
    let sm = hand.corner ? simplify(st, hand.corner) : st;
    for (let k = 0; k < hand.smooth; k++) sm = chaikin(sm);
    if (hand.tremor) sm = shake(sm, hand.tremor, rand() * 10);
    const flat: number[] = [];
    for (let i = 0; i < sm.length; i++) {
      const [x0, y0] = sm[i]!;
      const x = x0 + Math.sin(ph + x0 * 0.11) * 0.35;
      const y = y0 + Math.sin(ph * 1.7 + x0 * 0.07) * 0.6;
      flat.push(opts.cx + (x * cos - y * sin) * s, opts.cy + (x * sin + y * cos) * s);
    }
    return resample(flat, 2.5);
  });
  return { strokes: out, box: { cx: opts.cx, cy: opts.cy, hw: (m.w * s) / 2 + 6, hh: (m.h * s) / 2 + 4, angle: opts.angle } };
}

/** A messy child's version of a glyph stroke: loops left open or overshot, ends that run on. */
function loosen(st: P[], M: Messy, rand: () => number): P[] {
  if (st.length < 3 || rand() >= M.openOdds) return st;
  const [fx, fy] = st[0]!;
  const [lx, ly] = st[st.length - 1]!;
  if (Math.hypot(lx - fx, ly - fy) < 3) {
    // a loop: stop short of closing it, or carry on round past the start
    if (rand() < 0.55) return st.slice(0, Math.max(2, Math.round(st.length * (0.7 + rand() * 0.15))));
    return [...st, ...st.slice(1, 2 + Math.floor(rand() * 3)).map(([x, y]): P => [x * 1.08, y * 1.08])];
  }
  // an end that runs on past where it should stop
  const [px, py] = st[st.length - 2]!;
  const d = Math.hypot(lx - px, ly - py) || 1;
  const k = 1.5 + rand() * 3;
  return [...st, [lx + ((lx - px) / d) * k, ly + ((ly - py) / d) * k]];
}

/** A letter gone wrong, scribbled out: a tight zigzag back and forth over where it was. */
function scribbleOver(pts: P[], rand: () => number): P[] {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs) - 1;
  const x1 = Math.max(...xs) + 1;
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const out: P[] = [];
  const n = 5 + Math.floor(rand() * 3);
  for (let i = 0; i <= n; i++) {
    const v = y0 + ((y1 - y0) * i) / n + (rand() - 0.5) * 2;
    out.push([i % 2 ? x1 + rand() * 2 : x0 - rand() * 2, v]);
  }
  return out;
}

/** A flourish: the line's last stroke runs on into a rising curl; sometimes a looping underline from `under`. */
function swash(st: P[], under: number | null, base: number, rand: () => number, strokes: P[][]) {
  const [ex, ey] = st[st.length - 1]!;
  const n = 14;
  const len = 9 + rand() * 5;
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    st.push([ex + len * u + Math.sin(u * Math.PI) * 1.5, ey - 7 * u * u - Math.sin(u * Math.PI * 1.6) * 1.2]);
  }
  if (under === null) return;
  const y = base + 14 + rand() * 2;
  const x1 = ex + 4;
  const ul: P[] = [];
  // a small loop at the start, then a long, slightly sagging stroke that lifts at the end
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * 0.5 + (i / 10) * Math.PI * 2;
    ul.push([under + 3 + Math.cos(a) * 3, y - 2 + Math.sin(a) * 2.5]);
  }
  for (let i = 1; i <= 16; i++) {
    const u = i / 16;
    ul.push([under + 3 + (x1 - under - 3) * u, y + Math.sin(u * Math.PI) * 1.8 - u * u * u * 4]);
  }
  strokes.push(ul);
}

/** Douglas–Peucker: drops points within `tol` of a straight run, turning curves into a few angles. */
function simplify(pts: P[], tol: number): P[] {
  if (pts.length < 3) return pts;
  const [fx, fy] = pts[0]!;
  const [lx, ly] = pts[pts.length - 1]!;
  if (Math.hypot(lx - fx, ly - fy) < tol * 2) {
    // a closed loop (an o): split it at its far side so the halves keep their shape
    let at = 1;
    for (let i = 1; i < pts.length - 1; i++) if (Math.hypot(pts[i]![0] - fx, pts[i]![1] - fy) > Math.hypot(pts[at]![0] - fx, pts[at]![1] - fy)) at = i;
    return [...simplify(pts.slice(0, at + 1), tol), ...simplify(pts.slice(at), tol).slice(1)];
  }
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const [ax, ay] = pts[i0]!;
    const [bx, by] = pts[i1]!;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1;
    let at = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = pts[i]!;
      const d = len > 0.01 ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len : Math.hypot(px - ax, py - ay);
      if (d > far) {
        far = d;
        at = i;
      }
    }
    if (at > 0 && far > tol) {
      keep[at] = true;
      stack.push([i0, at], [at, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A shaky hand: walk the stroke in small steps and push it about with a couple of slow waves. */
function shake(pts: P[], amp: number, ph: number): P[] {
  const out: P[] = [];
  let d = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    if (i > 0) {
      const [px, py] = pts[i - 1]!;
      const seg = Math.hypot(x - px, y - py);
      const n = Math.max(1, Math.ceil(seg / 0.8));
      for (let k = 1; k <= n; k++) {
        const u = k / n;
        const dd = d + seg * u;
        out.push([px + (x - px) * u + Math.sin(ph + dd * 0.45) * amp + Math.sin(ph * 2.3 + dd * 1.1) * amp * 0.4, py + (y - py) * u + Math.sin(ph * 1.7 + dd * 0.38) * amp + Math.sin(ph * 3.1 + dd * 0.9) * amp * 0.4]);
      }
      d += seg;
    } else out.push([x + Math.sin(ph) * amp, y + Math.sin(ph * 1.7) * amp]);
  }
  return out;
}

function chaikin(pts: P[]): P[] {
  if (pts.length < 3) return pts;
  const out: P[] = [pts[0]!];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[i + 1]!;
    out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** Evenly spaced points (every `step` units) along a flat polyline. */
export function resample(flat: number[], step: number): number[] {
  if (flat.length <= 2) return flat.length ? [flat[0]!, flat[1]!, flat[0]! + 0.5, flat[1]! + 0.5] : flat;
  const out = [flat[0]!, flat[1]!];
  let carry = 0;
  for (let i = 2; i < flat.length; i += 2) {
    const ax = flat[i - 2]!;
    const ay = flat[i - 1]!;
    const bx = flat[i]!;
    const by = flat[i + 1]!;
    const len = Math.hypot(bx - ax, by - ay);
    let d = step - carry;
    while (d <= len) {
      out.push(ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len);
      d += step;
    }
    carry = len - (d - step);
  }
  const lx = flat[flat.length - 2]!;
  const ly = flat[flat.length - 1]!;
  if (out[out.length - 2] !== lx || out[out.length - 1] !== ly) out.push(lx, ly);
  return out;
}

/** Do two oriented boxes overlap (separating axis test), with `pad` units of margin? */
export function boxesOverlap(a: Box, b: Box, pad = 0): boolean {
  const axes = [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2];
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  for (const t of axes) {
    const ux = Math.cos(t);
    const uy = Math.sin(t);
    const ra = Math.abs((a.hw + pad) * Math.cos(a.angle - t)) + Math.abs((a.hh + pad) * Math.sin(a.angle - t));
    const rb = Math.abs((b.hw + pad) * Math.cos(b.angle - t)) + Math.abs((b.hh + pad) * Math.sin(b.angle - t));
    if (Math.abs(dx * ux + dy * uy) > ra + rb) return false;
  }
  return true;
}

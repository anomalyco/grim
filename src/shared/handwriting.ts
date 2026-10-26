// Handwritten phrases from single-stroke script glyphs, in writing order, with per-letter jitter so no two look
// the same. Used by the home page bots on the server; the browser only draws the points it is sent.
import { SCRIPT_GLYPHS } from "./hershey-script.ts";

type P = [number, number];
interface Glyph {
  l: number;
  r: number;
  strokes: P[][];
}

const glyphs: Glyph[] = SCRIPT_GLYPHS.map((s) => {
  const R = 82;
  const strokes: P[][] = [[]];
  for (let i = 2; i + 1 < s.length; i += 2) {
    if (s[i] === " " && s[i + 1] === "R") strokes.push([]);
    else strokes[strokes.length - 1]!.push([s.charCodeAt(i) - R, s.charCodeAt(i + 1) - R]);
  }
  return { l: s.charCodeAt(0) - R, r: s.charCodeAt(1) - R, strokes: strokes.filter((st) => st.length > 0) };
});

const glyph = (ch: string) => glyphs[ch.charCodeAt(0) - 32] ?? glyphs["?".charCodeAt(0) - 32]!;

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
  let best = [text];
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const score = Math.max(a.length, b.length);
    if (score < bestScore) {
      bestScore = score;
      best = [a, b];
    }
  }
  return best;
}

/** The unrotated size of a phrase in glyph units (before scaling), for placement. */
export function measurePhrase(lines: string[]): { w: number; h: number } {
  let w = 0;
  for (const line of lines) {
    let x = 0;
    for (const ch of line) {
      const g = glyph(ch);
      x += g.r - g.l;
    }
    w = Math.max(w, x);
  }
  return { w, h: 21 + (lines.length - 1) * LINE_UNITS + 10 };
}

const LINE_UNITS = 34;

/**
 * Write `lines` with the top-left of the first line's cap height near the box's corner: the result is centred on
 * (cx, cy), rotated by `angle`, with capitals `size` units tall.
 */
export function writePhrase(lines: string[], opts: { cx: number; cy: number; size: number; angle: number; seed: number }): Written {
  const rand = rng(opts.seed);
  const jit = (a: number) => (rand() * 2 - 1) * a;
  const s = opts.size / 21;
  const m = measurePhrase(lines);
  const strokes: P[][] = [];
  for (let li = 0; li < lines.length; li++) {
    let pen = -m.w / 2 + jit(3) + (li ? 6 : 0);
    const base = -m.h / 2 + 12 + li * LINE_UNITS + jit(1.5);
    const deferred: P[][] = [];
    let open: P[] | null = null;
    let lastEnd: P | null = null;
    for (const ch of lines[li]!) {
      const g = glyph(ch);
      if (ch === " ") {
        pen += g.r - g.l + jit(2);
        flushDeferred();
        open = null;
        lastEnd = null;
        continue;
      }
      const sc = 1 + jit(0.06);
      const rot = jit(0.05);
      const dy = jit(0.9);
      const dx = jit(0.6);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const ox = pen - g.l;
      const place = (p: P): P => {
        const x = p[0] * sc;
        const y = (p[1] - 4) * sc;
        return [ox + dx + x * cos - y * sin, base + 4 + dy + x * sin + y * cos];
      };
      let first = true;
      for (const st of g.strokes) {
        const pts = st.map(place);
        const ext = Math.max(...st.map((p) => p[0])) - Math.min(...st.map((p) => p[0])) + Math.max(...st.map((p) => p[1])) - Math.min(...st.map((p) => p[1]));
        // dots go on after the word, like people do
        if (ext <= 3) {
          deferred.push(pts);
          continue;
        }
        const start = [pen - g.l + st[0]![0], st[0]![1]] as P;
        const gap = lastEnd ? Math.hypot(start[0] - lastEnd[0], start[1] - lastEnd[1]) : Infinity;
        // cursive: run on into the next letter when its first stroke starts near where the last one left off,
        // in the lowercase band; within a letter, only when the pen would barely lift
        const joins = first ? gap < 9 && lastEnd![1] >= -1 && lastEnd![1] <= 9 && start[1] >= -1 && start[1] <= 9 : gap < 2.5;
        if (open && lastEnd && joins) {
          open.push(...pts.slice(gap < 0.5 ? 1 : 0));
        } else {
          open = pts;
          strokes.push(open);
        }
        const end = st[st.length - 1]!;
        lastEnd = [pen - g.l + end[0], end[1]];
        first = false;
      }
      pen += g.r - g.l + jit(0.7);
    }
    flushDeferred();
    function flushDeferred() {
      strokes.push(...deferred.splice(0));
    }
  }
  // smooth the polylines, add a slow wobble, then rotate and scale into place
  const cos = Math.cos(opts.angle);
  const sin = Math.sin(opts.angle);
  const ph = rand() * 10;
  const out = strokes.map((st) => {
    const sm = chaikin(st);
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

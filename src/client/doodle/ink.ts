// Pencil marks on a 2D canvas the size of the page. Strokes are stamped as small overlapping dots filled with a
// paper-grain pattern in the pencil's colour, so they come out grainy, pressure-varying and a bit see-through.
//
// Marks don't last: every point shows for DOODLE.inkLifeMs from when it was drawn and fades out over the last
// inkFadeMs, so a pencil leaves a trail that dies away behind it. Each piece of a stroke (the dots from one point to
// the next) is drawn at an opacity level; when pieces step down a level or die, only the boxes around them are cleared
// and drawn again, in the order the pieces first went down. The stamps' jitter is a hash of the stroke and the
// stamp's position along it, so redrawing puts every dot back exactly where it was.
import { DOODLE } from "../../shared/doodle.ts";

export interface InkStroke {
  id: string;
  color: string;
  w: number;
  /** [x, y, pressure, …] in page units, every point it ever had (so stamps keep their place) */
  p: number[];
  seed: number;
  /** performance.now() when it was added */
  t0: number;
  /** its pieces still showing (or waiting to be drawn) */
  live: number;
}

interface Piece {
  s: InkStroke;
  /** point index: the dots from point i - 1 to i (just the dot at point 0 for i = 0) */
  i: number;
  /** when it was drawn (performance.now()) */
  t: number;
  /** opacity level it's on the canvas at; -1 before it's drawn */
  lvl: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const MAX_PIXELS = 14_000_000;
const LEVELS = 32;
/** fading pieces are stepped down at most this often (ms) */
const STEP_MS = 50;
const LIFE = DOODLE.inkLifeMs;
const FADE = DOODLE.inkFadeMs;

/** Opacity of a piece drawn at `t`: 1, then easing out to 0 over the fade, in LEVELS steps. */
function levelAt(t: number, now: number): number {
  const left = LIFE - (now - t);
  if (left <= 0) return 0;
  if (left >= FADE) return 1;
  const f = left / FADE;
  return Math.ceil(f * f * (3 - 2 * f) * LEVELS) / LEVELS;
}

const overlaps = (a: Box, b: Box) => a.x1 >= b.x0 && a.x0 <= b.x1 && a.y1 >= b.y0 && a.y0 <= b.y1;

export class InkLayer {
  readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  readonly strokes = new Map<string, InkStroke>();
  /** in the order they were added; pieces[0, drawn) are on the canvas */
  private pieces: Piece[] = [];
  private drawn = 0;
  private patterns = new Map<string, CanvasPattern>();
  private grain: HTMLCanvasElement;
  private w = 0;
  private h = 0;
  private scale = 1;
  private lastFade = -Infinity;
  /** something on the canvas is fading */
  private fading = false;
  /** when the next piece starts fading, or an empty stroke can go */
  private nextAt = Infinity;
  private nextSeed = 1;

  constructor() {
    this.canvas.className = "doodle-ink";
    this.canvas.setAttribute("aria-hidden", "true");
    this.ctx = this.canvas.getContext("2d")!;
    this.grain = makeGrain();
  }

  /** Cover a page w × h CSS px. */
  resize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.scale = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
    this.canvas.width = Math.round(w * this.scale);
    this.canvas.height = Math.round(h * this.scale);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.patterns.clear();
    this.redraw();
  }

  add(id: string, color: string, w: number, t0 = performance.now()): InkStroke {
    let s = this.strokes.get(id);
    if (!s) {
      s = { id, color, w, p: [], seed: Math.imul(this.nextSeed++, 0x9e3779b1), t0, live: 0 };
      this.strokes.set(id, s);
    }
    return s;
  }

  /** Add points to a stroke, drawn at `t` (performance.now() time); they go on the canvas at the next flush. */
  push(s: InkStroke, pts: number[], t: number) {
    if (this.strokes.get(s.id) !== s) this.strokes.set(s.id, s);
    const pad = s.w * 0.75 + 2;
    for (let k = 0; k + 2 < pts.length; k += 3) {
      const i = s.p.length / 3;
      s.p.push(pts[k]!, pts[k + 1]!, pts[k + 2]!);
      const a = i ? i - 1 : 0;
      const ax = s.p[a * 3]!;
      const ay = s.p[a * 3 + 1]!;
      const x = pts[k]!;
      const y = pts[k + 1]!;
      this.pieces.push({ s, i, t, lvl: -1, x0: Math.min(ax, x) - pad, y0: Math.min(ay, y) - pad, x1: Math.max(ax, x) + pad, y1: Math.max(ay, y) + pad });
      s.live++;
    }
  }

  /** Forget every stroke but `keep` and repaint. */
  reset(keep?: string) {
    for (const id of [...this.strokes.keys()]) if (id !== keep) this.strokes.delete(id);
    this.pieces = this.pieces.filter((q) => this.strokes.get(q.s.id) === q.s);
    this.drawn = this.pieces.findIndex((q) => q.lvl < 0);
    if (this.drawn < 0) this.drawn = this.pieces.length;
    this.redraw();
  }

  /** Draw the pieces added since the last call; step fading ones down and drop dead ones. */
  flush(now: number) {
    if (now - this.lastFade >= STEP_MS) this.fade(now);
    if (this.drawn === this.pieces.length) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (; this.drawn < this.pieces.length; this.drawn++) {
      const q = this.pieces[this.drawn]!;
      q.lvl = levelAt(q.t, now);
      this.piece(q);
      if (q.lvl === 1) this.nextAt = Math.min(this.nextAt, q.t + LIFE - FADE);
      else this.fading = true;
    }
  }

  /** ms until flush has something to do (0: now), Infinity when there's nothing on the page. */
  nextChange(now: number): number {
    if (this.drawn < this.pieces.length) return 0;
    if (this.fading) return Math.max(0, this.lastFade + STEP_MS - now);
    return Math.max(0, this.nextAt - now);
  }

  /** Something is fading or waiting to be drawn: flush again soon. */
  get busy(): boolean {
    return this.fading || this.drawn < this.pieces.length;
  }

  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (let n = 0; n < this.drawn; n++) this.piece(this.pieces[n]!);
  }

  private fade(now: number) {
    this.lastFade = now;
    this.fading = false;
    this.nextAt = Infinity;
    const boxes: (Box & { s: InkStroke; i: number })[] = [];
    let run: (typeof boxes)[number] | null = null;
    let dead = 0;
    for (let n = 0; n < this.drawn; n++) {
      const q = this.pieces[n]!;
      if (q.lvl === 0) {
        dead++;
        continue;
      }
      const lvl = levelAt(q.t, now);
      if (lvl > 0 && lvl < 1) this.fading = true;
      else if (lvl === 1) this.nextAt = Math.min(this.nextAt, q.t + LIFE - FADE);
      if (lvl === q.lvl) continue;
      q.lvl = lvl;
      if (lvl === 0) dead++;
      // neighbouring pieces of a stroke share a box
      if (run && run.s === q.s && run.i + 1 === q.i) {
        run.i = q.i;
        run.x0 = Math.min(run.x0, q.x0);
        run.y0 = Math.min(run.y0, q.y0);
        run.x1 = Math.max(run.x1, q.x1);
        run.y1 = Math.max(run.y1, q.y1);
      } else boxes.push((run = { s: q.s, i: q.i, x0: q.x0, y0: q.y0, x1: q.x1, y1: q.y1 }));
    }
    for (const b of merge(boxes)) this.repaint(b);
    if (dead) {
      const keep: Piece[] = [];
      for (let n = 0; n < this.pieces.length; n++) {
        const q = this.pieces[n]!;
        if (q.lvl === 0) q.s.live--;
        else keep.push(q);
      }
      this.drawn -= dead;
      this.pieces = keep;
    }
    for (const [id, s] of this.strokes) {
      if (s.live > 0) continue;
      if (now - s.t0 >= LIFE) this.strokes.delete(id);
      else this.nextAt = Math.min(this.nextAt, s.t0 + LIFE);
    }
  }

  /** Clear one box and draw back everything in it. */
  private repaint(b: Box) {
    const ctx = this.ctx;
    const k = this.scale;
    const cx = this.w / 2;
    const x0 = Math.max(0, Math.floor((cx + b.x0) * k));
    const y0 = Math.max(0, Math.floor(b.y0 * k));
    const x1 = Math.min(this.canvas.width, Math.ceil((cx + b.x1) * k));
    const y1 = Math.min(this.canvas.height, Math.ceil(b.y1 * k));
    if (x1 <= x0 || y1 <= y0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    for (let n = 0; n < this.drawn; n++) {
      const q = this.pieces[n]!;
      if (q.lvl > 0 && overlaps(q, b)) this.piece(q);
    }
    ctx.restore();
  }

  private pattern(color: string): CanvasPattern {
    let p = this.patterns.get(color);
    if (!p) {
      const c = document.createElement("canvas");
      c.width = this.grain.width;
      c.height = this.grain.height;
      const g = c.getContext("2d")!;
      g.fillStyle = color;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(this.grain, 0, 0);
      p = this.ctx.createPattern(c, "repeat")!;
      // grain at about one texel per CSS px whatever the canvas scale
      p.setTransform(new DOMMatrix().scale(this.scale));
      this.patterns.set(color, p);
    }
    return p;
  }

  /** Stamp one piece at its level. */
  private piece(q: Piece) {
    if (q.lvl <= 0) return;
    const s = q.s;
    const k = this.scale;
    const cx = this.w / 2;
    const i = q.i;
    this.ctx.fillStyle = this.pattern(s.color);
    if (i === 0) return this.stamp(cx + s.p[0]!, s.p[1]!, s.p[2]!, s.w, q.lvl, k, hash(s.seed, 0, 0));
    const x0 = cx + s.p[i * 3 - 3]!;
    const y0 = s.p[i * 3 - 2]!;
    const p0 = s.p[i * 3 - 1]!;
    const x1 = cx + s.p[i * 3]!;
    const y1 = s.p[i * 3 + 1]!;
    const p1 = s.p[i * 3 + 2]!;
    const d = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(0.35, s.w * 0.22);
    const steps = Math.max(1, Math.ceil(d / step));
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      this.stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t, s.w, q.lvl, k, hash(s.seed, i, j));
    }
  }

  private stamp(x: number, y: number, p: number, w: number, life: number, k: number, h: number) {
    const ctx = this.ctx;
    const r = Math.max(0.45, w * (0.32 + 0.38 * p)) * k;
    ctx.globalAlpha = (0.14 + 0.3 * p) * life;
    ctx.beginPath();
    // jitter of up to ±0.25 px each way, from the hash's low and high halves
    ctx.arc(x * k + ((h & 0xffff) / 0xffff - 0.5) * 0.5 * k, y * k + ((h >>> 16) / 0xffff - 0.5) * 0.5 * k, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Merge overlapping boxes, so no area is repainted twice. */
function merge(boxes: Box[]): Box[] {
  const out: Box[] = [];
  for (const b of boxes) {
    let m = { ...b };
    for (let i = 0; i < out.length; ) {
      if (overlaps(out[i]!, m)) {
        const o = out.splice(i, 1)[0]!;
        m = { x0: Math.min(o.x0, m.x0), y0: Math.min(o.y0, m.y0), x1: Math.max(o.x1, m.x1), y1: Math.max(o.y1, m.y1) };
        i = 0;
      } else i++;
    }
    out.push(m);
  }
  return out;
}

/** 32-bit hash of (stroke seed, point index, stamp index). */
function hash(seed: number, i: number, j: number): number {
  let h = Math.imul(seed ^ Math.imul(i, 0x85ebca6b) ^ Math.imul(j, 0xc2b2ae35), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** Paper tooth: fine noise over a softer mottle, as alpha. */
function makeGrain(): HTMLCanvasElement {
  const N = 128;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d")!;
  const img = g.createImageData(N, N);
  const coarse = new Float32Array(16 * 16).map(() => Math.random());
  const at = (x: number, y: number) => coarse[((y & 15) << 4) | (x & 15)]!;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * 16;
      const fy = (y / N) * 16;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const m = (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
      const v = 0.6 * Math.random() + 0.4 * m;
      const a = Math.min(1, Math.max(0, (v - 0.1) / 0.5));
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Pencil marks on a 2D canvas the size of the page. Strokes are stamped as small overlapping dots filled with a
// paper-grain pattern in the pencil's colour, so they come out grainy, pressure-varying and a bit see-through.
//
// Strokes fade out at the end of their life in a few alpha steps ("bands"). When a stroke steps down, only its own
// box is cleared and redrawn (with whatever else crosses it), a few boxes per frame; the stamps' jitter is a hash of
// the stroke and the stamp's position along it, so redrawing a mark puts every dot back exactly where it was.
import { DOODLE } from "../../shared/doodle.ts";

export interface InkStroke {
  color: string;
  w: number;
  /** [x, y, pressure, …] in page units */
  p: number[];
  /** points already on the canvas */
  drawn: number;
  /** performance.now() when it started */
  t0: number;
  /** opacity step it's drawn at (1 until it starts fading) */
  band: number;
  seed: number;
  /** bounds of the drawn points, page units */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const MAX_PIXELS = 14_000_000;
const BANDS = 16;
/** stroke boxes redrawn per flush at most; the rest wait for the next frames */
const REGIONS_PER_FLUSH = 6;

const bandAt = (s: InkStroke, now: number) => Math.ceil(Math.min(1, Math.max(0, (DOODLE.strokeLifeMs - (now - s.t0)) / DOODLE.fadeMs)) * BANDS) / BANDS;

export class InkLayer {
  readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  readonly strokes = new Map<string, InkStroke>();
  private patterns = new Map<string, CanvasPattern>();
  private grain: HTMLCanvasElement;
  private w = 0;
  private h = 0;
  private scale = 1;
  private lastFade = 0;
  private nextSeed = 1;
  /** boxes to clear and redraw, page units */
  private dirty: { x0: number; y0: number; x1: number; y1: number }[] = [];

  constructor() {
    this.canvas.className = "doodle-ink";
    this.canvas.setAttribute("aria-hidden", "true");
    this.ctx = this.canvas.getContext("2d")!;
    this.grain = makeGrain();
  }

  /** Cover a page w × h CSS px. When only the height changes, the marks are kept rather than drawn again. */
  resize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    const scale = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
    const keep = w === this.w && scale === this.scale && this.canvas.height > 0;
    let snap: HTMLCanvasElement | null = null;
    if (keep) {
      snap = document.createElement("canvas");
      snap.width = this.canvas.width;
      snap.height = Math.round(Math.min(this.h, h) * scale);
      snap.getContext("2d")!.drawImage(this.canvas, 0, 0);
    }
    const oldH = this.h;
    this.w = w;
    this.h = h;
    this.scale = scale;
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.patterns.clear();
    if (!snap) return this.redraw();
    this.ctx.drawImage(snap, 0, 0);
    // marks below the old bottom (the page had shrunk past them) come back
    if (h > oldH) this.repaint({ x0: -w, y0: oldH - 4, x1: w, y1: h });
  }

  add(id: string, color: string, w: number, t0: number): InkStroke {
    let s = this.strokes.get(id);
    if (!s) {
      s = { color, w, p: [], drawn: 0, t0, band: 1, seed: Math.imul(this.nextSeed++, 0x9e3779b1), x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      s.band = bandAt(s, performance.now());
      this.strokes.set(id, s);
    }
    return s;
  }

  /** Forget every stroke but `keep` and repaint. */
  reset(keep?: string) {
    for (const id of [...this.strokes.keys()]) if (id !== keep) this.strokes.delete(id);
    this.dirty = [];
    this.redraw();
  }

  /** Draw points added since the last call; step fading strokes down and drop dead ones, a few at a time. */
  flush(now: number) {
    if (now - this.lastFade > 500) {
      this.lastFade = now;
      for (const [id, s] of this.strokes) {
        const band = bandAt(s, now);
        if (band > 0 && band === s.band) continue;
        s.band = band;
        if (band <= 0) this.strokes.delete(id);
        if (s.drawn) this.dirty.push(this.box(s));
      }
    }
    for (const s of this.strokes.values()) if (s.drawn * 3 < s.p.length) this.draw(s, s.drawn, s.p.length / 3);
    for (let i = 0; i < REGIONS_PER_FLUSH && this.dirty.length; i++) this.repaint(this.dirty.shift()!);
  }

  /** Boxes still waiting to be repainted: call flush again next frame. */
  get busy(): boolean {
    return this.dirty.length > 0;
  }

  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.dirty = [];
    for (const s of this.strokes.values()) {
      s.drawn = 0;
      this.draw(s, 0, s.p.length / 3);
    }
  }

  private box(s: InkStroke) {
    const pad = s.w * 0.75 + 2;
    return { x0: s.x0 - pad, y0: s.y0 - pad, x1: s.x1 + pad, y1: s.y1 + pad };
  }

  /** Clear one box and draw back everything in it. */
  private repaint(b: { x0: number; y0: number; x1: number; y1: number }) {
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
    for (const s of this.strokes.values()) {
      if (!s.drawn) continue;
      const sb = this.box(s);
      if (sb.x1 < b.x0 || sb.x0 > b.x1 || sb.y1 < b.y0 || sb.y0 > b.y1) continue;
      this.stroke(s, 0, s.drawn);
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

  /** Draw points [from, to) of a stroke that aren't on the canvas yet, and grow its box. */
  private draw(s: InkStroke, from: number, to: number) {
    for (let i = from; i < to; i++) {
      const x = s.p[i * 3]!;
      const y = s.p[i * 3 + 1]!;
      if (x < s.x0) s.x0 = x;
      if (x > s.x1) s.x1 = x;
      if (y < s.y0) s.y0 = y;
      if (y > s.y1) s.y1 = y;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.stroke(s, from, to);
    s.drawn = to;
  }

  /** Stamp points [from, to): the dot at `from` itself only when it's the first point. */
  private stroke(s: InkStroke, from: number, to: number) {
    if (to <= from || s.band <= 0) return;
    const ctx = this.ctx;
    const k = this.scale;
    ctx.fillStyle = this.pattern(s.color);
    const cx = this.w / 2;
    if (from === 0) this.stamp(cx + s.p[0]!, s.p[1]!, s.p[2]!, s.w, s.band, k, hash(s.seed, 0, 0));
    for (let i = Math.max(1, from); i < to; i++) {
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
        this.stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t, s.w, s.band, k, hash(s.seed, i, j));
      }
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

// Pencil marks on a 2D canvas the size of the page. Strokes are stamped as small overlapping dots filled with a
// paper-grain pattern in the pencil's colour, so they come out grainy, pressure-varying and a bit see-through.
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
  done: boolean;
}

const MAX_PIXELS = 14_000_000;

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

  constructor() {
    this.canvas.className = "doodle-ink";
    this.canvas.setAttribute("aria-hidden", "true");
    this.ctx = this.canvas.getContext("2d")!;
    this.grain = makeGrain();
  }

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

  add(id: string, color: string, w: number, t0: number): InkStroke {
    let s = this.strokes.get(id);
    if (!s) {
      s = { color, w, p: [], drawn: 0, t0, done: false };
      this.strokes.set(id, s);
    }
    return s;
  }

  /** Draw points added since the last call; every few seconds, redraw to fade and drop old strokes. */
  flush(now: number) {
    if (now - this.lastFade > 4000) {
      this.lastFade = now;
      let fading = false;
      for (const [id, s] of this.strokes) {
        const age = now - s.t0;
        if (age > DOODLE.strokeLifeMs) this.strokes.delete(id);
        if (age > DOODLE.strokeLifeMs - DOODLE.fadeMs) fading = true;
      }
      if (fading) return this.redraw();
    }
    for (const s of this.strokes.values()) if (s.drawn * 3 < s.p.length) this.draw(s, now);
  }

  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const now = performance.now();
    for (const s of this.strokes.values()) {
      s.drawn = 0;
      this.draw(s, now);
    }
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

  private draw(s: InkStroke, now: number) {
    const n = s.p.length / 3;
    if (n === 0) return;
    const ctx = this.ctx;
    const k = this.scale;
    const life = Math.min(1, Math.max(0, (DOODLE.strokeLifeMs - (now - s.t0)) / DOODLE.fadeMs));
    if (life <= 0) return void (s.drawn = n);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.pattern(s.color);
    const cx = this.w / 2;
    let i = Math.max(1, s.drawn);
    if (s.drawn === 0) {
      this.stamp(cx + s.p[0]!, s.p[1]!, s.p[2]!, s.w, life, k);
      if (n === 1) return void (s.drawn = 1);
    }
    for (; i < n; i++) {
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
        this.stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t, s.w, life, k);
      }
    }
    s.drawn = n;
  }

  private stamp(x: number, y: number, p: number, w: number, life: number, k: number) {
    const ctx = this.ctx;
    const r = Math.max(0.45, w * (0.32 + 0.38 * p)) * k;
    ctx.globalAlpha = (0.14 + 0.3 * p) * life;
    ctx.beginPath();
    ctx.arc(x * k + (Math.random() - 0.5) * 0.5 * k, y * k + (Math.random() - 0.5) * 0.5 * k, r, 0, Math.PI * 2);
    ctx.fill();
  }
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

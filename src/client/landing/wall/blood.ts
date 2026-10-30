// Bloody scratches: a few times (one while the wall's being punched, two once things start coming out), a
// three-fingered claw rakes across the wall's surface somewhere on the screen in a quick swipe: three
// parallel, slightly curved strokes, tapering at both ends, uneven, deep red and wet (a dark core, a lighter wet
// streak, a glint), sometimes a splatter at the end. Half a second to a second later they start to drip: drops gather
// along the lower edge of the strokes and run down the page, each a bead that slows, sometimes stops, and leaves a
// thin trail. They stay. Each lands at a random spot on the screen, clear of the note, the button, the hole and the
// punch sites, and away from the others. Drawn into a page-sized
// offscreen canvas as they happen (so what's settled costs nothing), shown through a fixed canvas over the plastic and
// under the text and pencils; only the moving beads are drawn each frame.
import { clamp, gauss, rand, type View } from "./core.ts";

export const BLOOD = {
  /** the budget: this many ever. One while the wall's being punched, this long (s) after the punching starts; then
   *  `after` more once the crawlers start, one at a time, each at a random moment within `afterWithin` (s) of the
   *  first crawler. (The debug panel's button ignores the budget.) */
  total: 3,
  first: [3, 8] as const,
  after: 2,
  afterWithin: [0.4, 5] as const,
  /** where they land: clear of the window's sides and top (px), with room below for drips (a fraction of the
   *  window's height), at least `apart` (a fraction of the window's diagonal) from each other, and clear of these */
  margin: 60,
  top: 90,
  dripRoom: 0.3,
  apart: 0.32,
  avoid: ".home-top, .home-hint, .home-editor, .home-cta",
  /** length of a stroke (px), gap between the three (px), how much they bow (px), widest point (px) */
  length: [130, 260] as const,
  spacing: [13, 20] as const,
  bow: [-28, 28] as const,
  width: [3.5, 7] as const,
  /** the swipe's duration (s) */
  swipe: [0.12, 0.25] as const,
  /** colours: the core, the wet streak, the edge */
  core: "#5c0309",
  wet: "rgba(186, 22, 32, 0.85)",
  edge: "rgba(40, 0, 4, 0.9)",
  glint: "rgba(255, 235, 235, 0.45)",
  /** chance of splatter dots at a stroke's end */
  splatter: 0.4,
  /** drips: when they start after the scratch (s), how many per scratch, bead size (px) */
  dripDelay: [0.5, 1] as const,
  drips: [3, 7] as const,
  dripsLow: [2, 4] as const,
  bead: [1.6, 3.2] as const,
  /** how long a drop gathers before it runs (s) */
  gather: [0.25, 0.7] as const,
  /** running: top speed (px/s), and how far it can run (px) before it's spent; one in `longChance` runs far */
  speed: [25, 90] as const,
  run: [20, 140] as const,
  longRun: [250, 650] as const,
  longChance: 0.25,
  /** chance per second a running drop catches and pauses, and for how long (s) */
  stick: 0.35,
  stickTime: [0.2, 1.2] as const,
  /** at most this many drops running at once */
  maxDrips: 60,
};

interface Stroke {
  /** sampled centreline (flat xy) and half-width at each sample */
  pts: number[];
  w: number[];
  /** samples drawn so far */
  drawn: number;
}

interface Scratch {
  strokes: Stroke[];
  t: number;
  dur: number;
  dripAt: number;
  dripped: boolean;
}

interface Drip {
  x: number;
  y: number;
  r: number;
  /** gathering until this is ≤ 0 */
  gather: number;
  gatherTotal: number;
  v: number;
  top: number;
  left: number;
  stuck: number;
  wob: number;
}

export class Blood {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** everything settled, in page px from (0, 0) */
  private sheet: HTMLCanvasElement;
  private sg: CanvasRenderingContext2D;
  private scratches: Scratch[] = [];
  private drips: Drip[] = [];
  private queue: number[] = [];
  /** where each scratch went (page px), to keep the next away */
  private spots: [number, number][] = [];
  private time = 0;
  private dirty = true;
  private lastSx = NaN;
  private lastSy = NaN;
  count = 0;

  constructor(
    w: number,
    h: number,
    private low: boolean,
    /** discs (page px: x, y, radius, and whether it may shrink when there's no room) to keep clear of: the hole
     *  (never shrinks), the punch sites */
    private keepClear: () => [number, number, number, boolean][],
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wall-blood";
    this.canvas.setAttribute("aria-hidden", "true");
    this.ctx = this.canvas.getContext("2d")!;
    this.sheet = document.createElement("canvas");
    this.sheet.width = Math.ceil(w);
    this.sheet.height = Math.ceil(h);
    this.sg = this.sheet.getContext("2d")!;
  }

  /** The page got wider: a bigger sheet, keeping what's on it. */
  resize(w: number, h: number) {
    if (w <= this.sheet.width && h <= this.sheet.height) return;
    const old = this.sheet;
    this.sheet = document.createElement("canvas");
    this.sheet.width = Math.max(old.width, Math.ceil(w));
    this.sheet.height = Math.max(old.height, Math.ceil(h));
    this.sg = this.sheet.getContext("2d")!;
    this.sg.drawImage(old, 0, 0);
    this.dirty = true;
  }

  /** One more, `delay` s from now, if the budget allows. */
  plan(delay: number) {
    if (this.count + this.queue.length >= BLOOD.total) return;
    this.queue.push(this.time + delay);
    this.queue.sort((a, b) => a - b);
  }

  /** A scratch now (the debug panel: never mind the budget). */
  now(v: View) {
    this.scratch(v, true);
  }

  /** Somewhere on the screen with room for a scratch of reach `ext` (px): clear of the page's text and the discs,
   *  away from the others. */
  private place(v: View, ext: number, clear = 1): [number, number] | null {
    const rects: [number, number, number, number][] = [];
    for (const el of document.querySelectorAll(BLOOD.avoid)) {
      const r = el.getBoundingClientRect();
      if (r.width) rects.push([r.left + v.sx, r.top + v.sy, r.right + v.sx, r.bottom + v.sy]);
    }
    const discs = this.keepClear();
    const x0 = v.sx + BLOOD.margin + ext;
    const x1 = v.sx + v.vw - BLOOD.margin - ext;
    const y0 = v.sy + BLOOD.top + ext;
    const y1 = v.sy + v.vh * (1 - BLOOD.dripRoom) - ext;
    if (x1 <= x0 || y1 <= y0) return null;
    const diag = Math.hypot(v.vw, v.vh);
    let best: [number, number] | null = null;
    let bestD = -1;
    for (let i = 0; i < 300; i++) {
      const x = rand(x0, x1);
      const y = rand(y0, y1);
      if (rects.some(([a, b, c, d]) => x > a - ext && x < c + ext && y > b - ext && y < d + ext)) continue;
      if (discs.some(([dx, dy, r, give]) => Math.hypot(x - dx, y - dy) < r * (give ? clear : 1) + ext)) continue;
      const near = this.spots.reduce((m, [sx, sy]) => Math.min(m, Math.hypot(x - sx, y - sy)), Infinity);
      if (near >= BLOOD.apart * diag) return [x, y];
      if (near > bestD) {
        bestD = near;
        best = [x, y];
      }
    }
    return best;
  }

  /** A scratch now; false if there was nowhere for it. */
  private scratch(v: View, force = false) {
    if (!force && this.count >= BLOOD.total) return true;
    let L = rand(...BLOOD.length);
    const gap = rand(...BLOOD.spacing);
    const bow = rand(...BLOOD.bow) * 0.6;
    // nowhere with room? a shorter scratch, and only the middle of the punch sites kept clear
    let spot: [number, number] | null = null;
    for (let k = 0; k < 4 && !spot; k++) {
      spot = this.place(v, L / 2 + gap + Math.abs(bow), 1 - k * 0.2);
      if (!spot) L *= 0.82;
    }
    if (!spot) return false;
    const [cx, cy] = spot;
    this.spots.push(spot);
    this.count++;
    // mostly diagonal, either way
    const a = (Math.PI / 4) * [1, 3, 5, 7][Math.floor(Math.random() * 4)]! + gauss() * 0.3;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const nx = -uy;
    const ny = ux;
    const strokes: Stroke[] = [];
    for (let k = -1; k <= 1; k++) {
      // each finger a little shorter or offset, the middle one longest
      const len = L * (k === 0 ? 1 : rand(0.75, 0.95));
      const start = rand(-0.08, 0.08) * L;
      const ox = cx + nx * k * gap + ux * start;
      const oy = cy + ny * k * gap + uy * start;
      const b = bow * (1 + k * 0.1);
      const wmax = rand(...BLOOD.width) * (k === 0 ? 1 : rand(0.7, 0.95));
      const n = Math.max(12, Math.round(len / 6));
      const pts: number[] = [];
      const w: number[] = [];
      const ph = Math.random() * 10;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const s = (t - 0.5) * len;
        // a slight bow, as a claw's arc
        const off = b * (1 - (2 * t - 1) ** 2);
        pts.push(ox + ux * s + nx * off, oy + uy * s + ny * off);
        // tapering at both ends (sharper at the end the claw lifts off), uneven
        const taper = Math.sin(Math.PI * Math.pow(t, 0.8)) ** 0.7;
        const uneven = 1 + 0.25 * Math.sin(t * 17 + ph) + 0.15 * Math.sin(t * 41 + ph * 2);
        w.push((wmax / 2) * taper * uneven);
      }
      strokes.push({ pts, w, drawn: 0 });
    }
    this.scratches.push({ strokes, t: 0, dur: rand(...BLOOD.swipe), dripAt: rand(...BLOOD.dripDelay), dripped: false });
    this.dirty = true;
    return true;
  }

  clear() {
    this.scratches = [];
    this.drips = [];
    this.queue = [];
    this.spots = [];
    this.count = 0;
    this.sg.clearRect(0, 0, this.sheet.width, this.sheet.height);
    this.dirty = true;
  }

  get busy() {
    return this.queue.length > 0 || this.drips.length > 0 || this.scratches.some((s) => !s.dripped);
  }

  update(dt: number, v: View) {
    this.time += dt;
    while (this.queue.length && this.queue[0]! <= this.time) {
      this.queue.shift();
      // (no room just now, e.g. scrolled to the note: try again in a moment)
      if (!this.scratch(v)) {
        this.queue.push(this.time + 1);
        break;
      }
    }
    for (const s of this.scratches) {
      if (s.dripped) continue;
      s.t += dt;
      const k = clamp(s.t / s.dur, 0, 1);
      // the swipe: fast, easing out
      const e = 1 - (1 - k) ** 2;
      for (const st of s.strokes) {
        const n = st.w.length - 1;
        const upto = Math.round(e * n);
        if (upto > st.drawn) {
          this.paint(st, st.drawn, upto);
          if (upto === n && Math.random() < BLOOD.splatter) this.splat(st);
          st.drawn = upto;
          this.dirty = true;
        }
      }
      if (s.t >= s.dur + s.dripAt) {
        s.dripped = true;
        this.startDrips(s);
      }
    }
    // (finished scratches are all on the sheet: drop them)
    this.scratches = this.scratches.filter((s) => !s.dripped);
    for (const d of this.drips) this.stepDrip(d, dt);
    const before = this.drips.length;
    this.drips = this.drips.filter((d) => d.left > 0 || d.gather > 0);
    if (this.drips.length !== before || this.drips.length) this.dirty = true;
  }

  /** Paint samples [i0, i1] of a stroke onto the sheet: dark core, wet streak, glint. */
  private paint(st: Stroke, i0: number, i1: number) {
    const g = this.sg;
    const p = st.pts;
    const quad = (i: number, grow: number, shift: number) => {
      const j = i + 1;
      const tx = p[j * 2]! - p[i * 2]!;
      const ty = p[j * 2 + 1]! - p[i * 2 + 1]!;
      const l = Math.hypot(tx, ty) || 1;
      const nx = -ty / l;
      const ny = tx / l;
      const wi = st.w[i]! * grow;
      const wj = st.w[j]! * grow;
      const si = st.w[i]! * shift;
      const sj = st.w[j]! * shift;
      g.moveTo(p[i * 2]! + nx * (si + wi), p[i * 2 + 1]! + ny * (si + wi));
      g.lineTo(p[j * 2]! + nx * (sj + wj), p[j * 2 + 1]! + ny * (sj + wj));
      g.lineTo(p[j * 2]! + nx * (sj - wj), p[j * 2 + 1]! + ny * (sj - wj));
      g.lineTo(p[i * 2]! + nx * (si - wi), p[i * 2 + 1]! + ny * (si - wi));
      g.closePath();
    };
    const layer = (style: string, grow: number, shift: number) => {
      g.fillStyle = style;
      g.beginPath();
      for (let i = Math.max(0, i0 - 1); i < i1; i++) quad(i, grow, shift);
      g.fill();
    };
    layer(BLOOD.edge, 1.15, 0);
    layer(BLOOD.core, 1, 0);
    // the wet streak sits toward the light (up-left of the centreline, roughly), the glint inside it
    layer(BLOOD.wet, 0.45, -0.3);
    layer(BLOOD.glint, 0.12, -0.45);
  }

  private splat(st: Stroke) {
    const g = this.sg;
    const n = st.w.length - 1;
    const x = st.pts[n * 2]!;
    const y = st.pts[n * 2 + 1]!;
    const tx = x - st.pts[(n - 2) * 2]!;
    const ty = y - st.pts[(n - 2) * 2 + 1]!;
    const l = Math.hypot(tx, ty) || 1;
    const k = Math.round(rand(1, 4));
    for (let i = 0; i < k; i++) {
      const d = rand(4, 22);
      const px = x + (tx / l) * d + gauss() * 4;
      const py = y + (ty / l) * d + gauss() * 4;
      const r = rand(0.8, 2.6);
      this.bead(g, px, py, r);
    }
  }

  private bead(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
    g.fillStyle = BLOOD.edge;
    g.beginPath();
    g.arc(x, y, r * 1.15, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = BLOOD.core;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = BLOOD.glint;
    g.beginPath();
    g.arc(x - r * 0.35, y - r * 0.35, Math.max(0.5, r * 0.3), 0, Math.PI * 2);
    g.fill();
  }

  private startDrips(s: Scratch) {
    const range = this.low ? BLOOD.dripsLow : BLOOD.drips;
    const n = Math.round(rand(range[0], range[1]));
    for (let i = 0; i < n && this.drips.length < BLOOD.maxDrips; i++) {
      const st = s.strokes[Math.floor(Math.random() * s.strokes.length)]!;
      const m = st.w.length - 1;
      const k = Math.round(rand(0.15, 0.85) * m);
      const w = st.w[k]!;
      // from the stroke's lower edge
      const x = st.pts[k * 2]!;
      const y = st.pts[k * 2 + 1]! + w * 0.8;
      const long = Math.random() < BLOOD.longChance;
      const gather = rand(...BLOOD.gather) + Math.random() * 0.4;
      this.drips.push({
        x, y, r: rand(...BLOOD.bead) * clamp(w / 2.5, 0.7, 1.2),
        gather, gatherTotal: gather, v: 0, top: rand(...BLOOD.speed),
        left: long ? rand(...BLOOD.longRun) : rand(...BLOOD.run), stuck: 0, wob: Math.random() * 10,
      });
    }
  }

  private stepDrip(d: Drip, dt: number) {
    if (d.gather > 0) {
      d.gather -= dt;
      return;
    }
    if (d.stuck > 0) {
      d.stuck -= dt;
      return;
    }
    if (Math.random() < dt * BLOOD.stick) d.stuck = rand(...BLOOD.stickTime);
    // it speeds up, then slows as it runs out
    const spent = clamp(d.left / 80, 0.15, 1);
    d.v += (d.top * spent - d.v) * Math.min(1, dt * 3);
    const dy = d.v * dt;
    const x0 = d.x;
    const y0 = d.y;
    d.wob += dt;
    d.x += Math.sin(d.wob * 2.3) * 0.15;
    d.y += dy;
    d.left -= dy;
    if (d.y > this.sheet.height - 4) d.left = 0;
    // the trail it leaves, thinner as it runs out
    const g = this.sg;
    g.strokeStyle = BLOOD.core;
    g.lineCap = "round";
    g.lineWidth = d.r * (0.5 + 0.35 * spent);
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(d.x, d.y);
    g.stroke();
    // spent: the bead dries where it stopped
    if (d.left <= 0) this.bead(g, d.x, d.y, d.r * 0.9);
  }

  draw(v: View) {
    const cv = this.canvas;
    const w = Math.round(v.vw * v.dpr);
    const h = Math.round(v.vh * v.dpr);
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
      cv.style.width = v.vw + "px";
      cv.style.height = v.vh + "px";
      this.dirty = true;
    }
    if (!this.dirty && v.sx === this.lastSx && v.sy === this.lastSy && v.shakeX === 0 && v.shakeY === 0) return;
    this.dirty = false;
    this.lastSx = v.sx;
    this.lastSy = v.sy;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!this.count) return;
    g.setTransform(v.dpr, 0, 0, v.dpr, (-v.sx + v.shakeX) * v.dpr, (-v.sy + v.shakeY) * v.dpr);
    g.drawImage(this.sheet, 0, 0);
    // the drops still moving, and the ones gathering, swelling at the edge
    for (const d of this.drips) {
      const r = d.gather > 0 ? d.r * (1 - d.gather / d.gatherTotal) : d.r * (d.stuck > 0 ? 1.1 : 1);
      if (r > 0.3) this.bead(g, d.x, d.y + (d.gather > 0 ? 0 : r * 0.3), r);
    }
  }
}

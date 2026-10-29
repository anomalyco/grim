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
  rgb?: ParsedColor;
  px0?: number;
  py0?: number;
  px1?: number;
  py1?: number;
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
  /** device-pixel bounds and range [s0, s1) in InkLayer.stamps */
  px0: number;
  py0: number;
  px1: number;
  py1: number;
  s0: number;
  s1: number;
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

const TILE = 128;
const TILE_SHIFT = 7;
const R_BINS = 48;
const SUB = 8;
const CELL = 8;
const R_MIN = 0.4;
const R_MAX = 3.0;
let covLUT: Uint8Array | null = null;
let covMin: Uint8Array | null = null;
let covMax: Uint8Array | null = null;

/** Browser-rasterized anti-aliased circle coverage table, indexed by (radius bin, subpixel y, subpixel x, cell y, cell x). */
function getCovLUT(): { lut: Uint8Array; min: Uint8Array; max: Uint8Array } {
  if (covLUT && covMin && covMax) return { lut: covLUT, min: covMin, max: covMax };
  const c = document.createElement("canvas");
  c.width = SUB * SUB * CELL;
  c.height = R_BINS * CELL;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  for (let ri = 0; ri < R_BINS; ri++) {
    const r = R_MIN + (ri / (R_BINS - 1)) * (R_MAX - R_MIN);
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        const col = sy * SUB + sx;
        g.beginPath();
        g.arc(col * CELL + 3 + (sx + 0.5) / SUB, ri * CELL + 3 + (sy + 0.5) / SUB, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const lut = new Uint8Array(R_BINS * SUB * SUB * CELL * CELL);
  const cMin = new Uint8Array(R_BINS);
  const cMax = new Uint8Array(R_BINS);
  const stride = c.width;
  for (let ri = 0; ri < R_BINS; ri++) {
    let lo = CELL;
    let hi = 0;
    for (let s = 0; s < SUB * SUB; s++) {
      const base = (ri * SUB * SUB + s) * (CELL * CELL);
      const ox = s * CELL;
      const oy = ri * CELL;
      for (let py = 0; py < CELL; py++) {
        const row = (oy + py) * stride + ox;
        const lRow = base + py * CELL;
        for (let px = 0; px < CELL; px++) {
          const v = data[(row + px) * 4 + 3]!;
          lut[lRow + px] = v;
          if (v > 0) {
            if (px < lo) lo = px;
            if (py < lo) lo = py;
            if (px + 1 > hi) hi = px + 1;
            if (py + 1 > hi) hi = py + 1;
          }
        }
      }
    }
    cMin[ri] = lo < hi ? lo : 0;
    cMax[ri] = lo < hi ? hi : 0;
  }
  covLUT = lut;
  covMin = cMin;
  covMax = cMax;
  return { lut, min: cMin, max: cMax };
}

/** Opacity of a piece drawn at `t`: 1, then easing out to 0 over the fade, in LEVELS steps. */
function levelAt(t: number, now: number): number {
  const left = LIFE - (now - t);
  if (left <= 0) return 0;
  if (left >= FADE) return 1;
  const f = left / FADE;
  return Math.ceil(f * f * (3 - 2 * f) * LEVELS) / LEVELS;
}

const overlaps = (a: Box, b: Box) => a.x1 >= b.x0 && a.x0 <= b.x1 && a.y1 >= b.y0 && a.y0 <= b.y1;

interface ParsedColor {
  bgr: number;
  r: number;
  g: number;
  b: number;
}

export class InkLayer {
  readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  readonly strokes = new Map<string, InkStroke>();
  /** in the order they were added; pieces[0, drawn) are on the canvas */
  private pieces: Piece[] = [];
  private drawn = 0;
  private colors = new Map<string, ParsedColor>();
  private grain: HTMLCanvasElement;
  private cov: Uint8Array;
  private covMin: Uint8Array;
  private covMax: Uint8Array;
  private buf32 = new Uint32Array(0);
  private grainTile = new Uint8Array(0);
  private xMod = new Uint16Array(0);
  private yMod = new Uint32Array(0);
  private stamps = new Int32Array(16384);
  private stampLen = 0;
  private tiles: Piece[][] = [];
  private tCols = 0;
  private tRows = 0;
  private patchCache = new Map<number, { img: ImageData; u32: Uint32Array }>();
  private w = 0;
  private h = 0;
  private scale = 1;
  /** canvas px per CSS px across and down: the canvas's whole-pixel size over the page's, so a mark is drawn exactly
   *  where it shows (one scale for both put marks up to half a pixel off at the far edges) */
  private kx = 1;
  private ky = 1;
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
    const { lut, min, max } = getCovLUT();
    this.cov = lut;
    this.covMin = min;
    this.covMax = max;
  }

  /** Cover a page w × h CSS px. */
  resize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.scale = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
    const cw = Math.round(w * this.scale);
    const ch = Math.round(h * this.scale);
    this.kx = w ? cw / w : 1;
    this.ky = h ? ch / h : 1;
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.buf32 = new Uint32Array(cw * ch);
    this.tCols = (cw + TILE - 1) >> TILE_SHIFT;
    this.tRows = (ch + TILE - 1) >> TILE_SHIFT;
    this.tiles = Array.from({ length: this.tCols * this.tRows }, () => []);
    this.buildGrainTile(cw, ch);
    this.redraw();
  }

  private buildGrainTile(cw: number, ch: number) {
    const gSize = Math.max(1, Math.round(this.grain.width * this.scale));
    const c = document.createElement("canvas");
    c.width = c.height = gSize;
    const g = c.getContext("2d")!;
    const pat = g.createPattern(this.grain, "repeat")!;
    // grain at about one texel per CSS px whatever the canvas scale
    pat.setTransform(new DOMMatrix().scale(gSize / this.grain.width));
    g.fillStyle = pat;
    g.fillRect(0, 0, gSize, gSize);
    const data = g.getImageData(0, 0, gSize, gSize).data;
    const tile = new Uint8Array(gSize * gSize);
    for (let i = 0; i < tile.length; i++) tile[i] = data[i * 4 + 3]!;
    this.grainTile = tile;
    const xm = new Uint16Array(cw);
    for (let x = 0; x < cw; x++) xm[x] = x % gSize;
    const ym = new Uint32Array(ch);
    for (let y = 0; y < ch; y++) ym[y] = (y % gSize) * gSize;
    this.xMod = xm;
    this.yMod = ym;
  }

  add(id: string, color: string, w: number, t0 = performance.now()): InkStroke {
    let s = this.strokes.get(id);
    if (!s) {
      s = {
        id,
        color,
        w,
        p: [],
        seed: Math.imul(this.nextSeed++, 0x9e3779b1),
        t0,
        live: 0,
        rgb: this.parseColor(color),
        px0: Infinity,
        py0: Infinity,
        px1: -Infinity,
        py1: -Infinity,
      };
      this.strokes.set(id, s);
    }
    return s;
  }

  /** Add points to a stroke, drawn at `t` (performance.now() time); they go on the canvas at the next flush. */
  push(s: InkStroke, pts: number[], t: number) {
    if (this.strokes.get(s.id) !== s) {
      s.rgb ??= this.parseColor(s.color);
      s.px0 ??= Infinity;
      s.py0 ??= Infinity;
      s.px1 ??= -Infinity;
      s.py1 ??= -Infinity;
      this.strokes.set(s.id, s);
    }
    const pad = s.w * 0.75 + 2;
    for (let k = 0; k + 2 < pts.length; k += 3) {
      const i = s.p.length / 3;
      s.p.push(pts[k]!, pts[k + 1]!, pts[k + 2]!);
      const a = i ? i - 1 : 0;
      const ax = s.p[a * 3]!;
      const ay = s.p[a * 3 + 1]!;
      const x = pts[k]!;
      const y = pts[k + 1]!;
      this.pieces.push({
        s,
        i,
        t,
        lvl: -1,
        x0: Math.min(ax, x) - pad,
        y0: Math.min(ay, y) - pad,
        x1: Math.max(ax, x) + pad,
        y1: Math.max(ay, y) + pad,
        px0: 0,
        py0: 0,
        px1: 0,
        py1: 0,
        s0: 0,
        s1: 0,
      });
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

  /** Take a stroke off the page now (repainting just where it was). */
  remove(id: string) {
    const s = this.strokes.get(id);
    if (!s) return;
    this.strokes.delete(id);
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const keep: Piece[] = [];
    let drawn = 0;
    for (let n = 0; n < this.pieces.length; n++) {
      const q = this.pieces[n]!;
      if (q.s !== s) {
        keep.push(q);
        if (n < this.drawn) drawn++;
      } else if (n < this.drawn && q.lvl > 0) {
        box.x0 = Math.min(box.x0, q.x0);
        box.y0 = Math.min(box.y0, q.y0);
        box.x1 = Math.max(box.x1, q.x1);
        box.y1 = Math.max(box.y1, q.y1);
      }
    }
    this.pieces = keep;
    this.drawn = drawn;
    for (const t of this.tiles) {
      let w = 0;
      for (let i = 0; i < t.length; i++) if (t[i]!.s !== s) t[w++] = t[i]!;
      t.length = w;
    }
    if (box.x0 <= box.x1) this.repaint(box);
  }

  /** Draw the pieces added since the last call; step fading ones down and drop dead ones. */
  flush(now: number) {
    if (now - this.lastFade >= STEP_MS) this.fade(now);
    if (this.drawn === this.pieces.length) return;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (!cw || !ch) {
      for (; this.drawn < this.pieces.length; this.drawn++) {
        const q = this.pieces[this.drawn]!;
        q.lvl = levelAt(q.t, now);
        if (q.lvl === 1) this.nextAt = Math.min(this.nextAt, q.t + LIFE - FADE);
        else this.fading = true;
      }
      return;
    }
    const boxes: (Box & { s: InkStroke; i: number })[] = [];
    let run: (typeof boxes)[number] | null = null;
    for (; this.drawn < this.pieces.length; this.drawn++) {
      const q = this.pieces[this.drawn]!;
      q.lvl = levelAt(q.t, now);
      this.buildPiece(q, cw, ch);
      if (q.lvl > 0) {
        this.stampPiece(q, 0, 0, cw, ch);
        if (
          run &&
          run.s === q.s &&
          run.i + 1 === q.i &&
          (Math.max(run.x1, q.x1) - Math.min(run.x0, q.x0)) * (Math.max(run.y1, q.y1) - Math.min(run.y0, q.y0)) <= 2400
        ) {
          run.i = q.i;
          run.x0 = Math.min(run.x0, q.x0);
          run.y0 = Math.min(run.y0, q.y0);
          run.x1 = Math.max(run.x1, q.x1);
          run.y1 = Math.max(run.y1, q.y1);
        } else boxes.push((run = { s: q.s, i: q.i, x0: q.x0, y0: q.y0, x1: q.x1, y1: q.y1 }));
      }
      if (q.lvl === 1) this.nextAt = Math.min(this.nextAt, q.t + LIFE - FADE);
      else this.fading = true;
    }
    const { kx, ky } = this;
    const cx = this.w / 2;
    for (const b of merge(boxes)) {
      this.upload(
        Math.max(0, Math.floor((cx + b.x0) * kx)),
        Math.max(0, Math.floor(b.y0 * ky)),
        Math.min(cw, Math.ceil((cx + b.x1) * kx)),
        Math.min(ch, Math.ceil(b.y1 * ky)),
      );
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
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, cw, ch);
    if (!cw || !ch) return;
    this.buf32.fill(0);
    this.stampLen = 0;
    for (const t of this.tiles) t.length = 0;
    for (const s of this.strokes.values()) {
      s.px0 = Infinity;
      s.py0 = Infinity;
      s.px1 = -Infinity;
      s.py1 = -Infinity;
    }
    if (!this.drawn) return;
    const boxes: (Box & { s: InkStroke; i: number })[] = [];
    let run: (typeof boxes)[number] | null = null;
    for (let n = 0; n < this.drawn; n++) {
      const q = this.pieces[n]!;
      this.buildPiece(q, cw, ch);
      if (q.lvl <= 0) continue;
      this.stampPiece(q, 0, 0, cw, ch);
      if (
        run &&
        run.s === q.s &&
        run.i + 1 === q.i &&
        (Math.max(run.x1, q.x1) - Math.min(run.x0, q.x0)) * (Math.max(run.y1, q.y1) - Math.min(run.y0, q.y0)) <= 2400
      ) {
        run.i = q.i;
        run.x0 = Math.min(run.x0, q.x0);
        run.y0 = Math.min(run.y0, q.y0);
        run.x1 = Math.max(run.x1, q.x1);
        run.y1 = Math.max(run.y1, q.y1);
      } else boxes.push((run = { s: q.s, i: q.i, x0: q.x0, y0: q.y0, x1: q.x1, y1: q.y1 }));
    }
    const { kx, ky } = this;
    const cx = this.w / 2;
    for (const b of merge(boxes)) {
      this.upload(
        Math.max(0, Math.floor((cx + b.x0) * kx)),
        Math.max(0, Math.floor(b.y0 * ky)),
        Math.min(cw, Math.ceil((cx + b.x1) * kx)),
        Math.min(ch, Math.ceil(b.y1 * ky)),
      );
    }
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
      if (
        run &&
        run.s === q.s &&
        run.i + 1 === q.i &&
        (Math.max(run.x1, q.x1) - Math.min(run.x0, q.x0)) * (Math.max(run.y1, q.y1) - Math.min(run.y0, q.y0)) <= 2400
      ) {
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
      for (const t of this.tiles) {
        let w = 0;
        for (let i = 0; i < t.length; i++) if (t[i]!.lvl !== 0) t[w++] = t[i]!;
        t.length = w;
      }
      if (!this.pieces.length) this.stampLen = 0;
      else if (this.stampLen > 65536 && this.stampLen > this.drawn * 28) this.compactStamps();
    }
    for (const [id, s] of this.strokes) {
      if (s.live > 0) continue;
      if (now - s.t0 >= LIFE) this.strokes.delete(id);
      else this.nextAt = Math.min(this.nextAt, s.t0 + LIFE);
    }
  }

  /** Clear one box and draw back everything in it. */
  private repaint(b: Box) {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const { kx, ky } = this;
    const cx = this.w / 2;
    const x0 = Math.max(0, Math.floor((cx + b.x0) * kx));
    const y0 = Math.max(0, Math.floor(b.y0 * ky));
    const x1 = Math.min(cw, Math.ceil((cx + b.x1) * kx));
    const y1 = Math.min(ch, Math.ceil(b.y1 * ky));
    if (x1 <= x0 || y1 <= y0) return;
    const buf = this.buf32;
    for (let y = y0; y < y1; y++) buf.fill(0, y * cw + x0, y * cw + x1);
    const tx0 = x0 >> TILE_SHIFT;
    const ty0 = y0 >> TILE_SHIFT;
    const tx1 = (x1 - 1) >> TILE_SHIFT;
    const ty1 = (y1 - 1) >> TILE_SHIFT;
    if (tx0 === tx1 && ty0 === ty1) {
      const pcs = this.tiles[ty0 * this.tCols + tx0]!;
      for (let n = 0; n < pcs.length; n++) {
        const q = pcs[n]!;
        if (q.lvl > 0 && q.px1 > x0 && q.px0 < x1 && q.py1 > y0 && q.py0 < y1) {
          this.stampPiece(q, x0, y0, x1, y1);
        }
      }
    } else {
      let skip: InkStroke | null = null;
      for (let n = 0; n < this.drawn; n++) {
        const q = this.pieces[n]!;
        const s = q.s;
        if (s === skip) continue;
        if (s.px1! <= x0 || s.px0! >= x1 || s.py1! <= y0 || s.py0! >= y1) {
          skip = s;
          continue;
        }
        if (q.lvl > 0 && q.px1 > x0 && q.px0 < x1 && q.py1 > y0 && q.py0 < y1) {
          this.stampPiece(q, x0, y0, x1, y1);
        }
      }
    }
    this.upload(x0, y0, x1, y1);
  }

  private upload(x0: number, y0: number, x1: number, y1: number) {
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return;
    const cw = this.canvas.width;
    const qw = bw <= 256 ? (bw + 15) & ~15 : bw;
    const qh = bh <= 256 ? (bh + 15) & ~15 : bh;
    const key = (qw << 12) | qh;
    let patch = this.patchCache.get(key);
    if (!patch) {
      const img = this.ctx.createImageData(qw, qh);
      patch = { img, u32: new Uint32Array(img.data.buffer) };
      if (qw <= 256 && qh <= 256) this.patchCache.set(key, patch);
    }
    const dst = patch.u32;
    const src = this.buf32;
    for (let y = 0; y < bh; y++) {
      const sOff = (y0 + y) * cw + x0;
      dst.set(src.subarray(sOff, sOff + bw), y * qw);
    }
    this.ctx.putImageData(patch.img, x0, y0, 0, 0, bw, bh);
  }

  private compactStamps() {
    const stamps = this.stamps;
    let w = 0;
    for (let n = 0; n < this.drawn; n++) {
      const q = this.pieces[n]!;
      const len = q.s1 - q.s0;
      if (len > 0 && q.s0 !== w) stamps.copyWithin(w, q.s0, q.s1);
      q.s0 = w;
      w += len;
      q.s1 = w;
    }
    this.stampLen = w;
  }

  private parseColor(color: string): ParsedColor {
    let c = this.colors.get(color);
    if (!c) {
      const n = parseInt(color.replace("#", ""), 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      c = { bgr: r | (g << 8) | (b << 16), r, g, b };
      this.colors.set(color, c);
    }
    return c;
  }

  private pushStamp(x: number, y: number, p: number, w: number, h: number) {
    const k = this.scale;
    const r = Math.max(0.45, w * (0.32 + 0.38 * p)) * k;
    const ri = Math.max(0, Math.min(R_BINS - 1, Math.round(((r - R_MIN) / (R_MAX - R_MIN)) * (R_BINS - 1))));
    const gx = x * this.kx + ((h & 0xffff) / 0xffff - 0.5) * 0.5 * k;
    const gy = y * this.ky + ((h >>> 16) / 0xffff - 0.5) * 0.5 * k;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const px0 = ix - 3;
    const py0 = iy - 3;
    const sx = Math.min(SUB - 1, Math.floor((gx - ix) * SUB));
    const sy = Math.min(SUB - 1, Math.floor((gy - iy) * SUB));
    const lutIdx = ri * (SUB * SUB) + sy * SUB + sx;
    const baseA = ((0.14 + 0.3 * p) * (257.00392 * 8) + 0.5) | 0;
    if (this.stampLen + 2 > this.stamps.length) {
      const next = new Int32Array(this.stamps.length * 2);
      next.set(this.stamps);
      this.stamps = next;
    }
    this.stamps[this.stampLen++] = (px0 & 0xffff) | (py0 << 16);
    this.stamps[this.stampLen++] = lutIdx | (baseA << 12);
  }

  private buildPiece(q: Piece, cw: number, ch: number) {
    const s = q.s;
    const { kx, ky } = this;
    const cx = this.w / 2;
    const i = q.i;
    q.px0 = Math.max(0, Math.floor((cx + q.x0) * kx));
    q.py0 = Math.max(0, Math.floor(q.y0 * ky));
    q.px1 = Math.min(cw, Math.ceil((cx + q.x1) * kx));
    q.py1 = Math.min(ch, Math.ceil(q.y1 * ky));
    if (q.px0 < s.px0!) s.px0 = q.px0;
    if (q.py0 < s.py0!) s.py0 = q.py0;
    if (q.px1 > s.px1!) s.px1 = q.px1;
    if (q.py1 > s.py1!) s.py1 = q.py1;
    q.s0 = this.stampLen;
    if (i === 0) {
      this.pushStamp(cx + s.p[0]!, s.p[1]!, s.p[2]!, s.w, hash(s.seed, 0, 0));
    } else {
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
        this.pushStamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t, s.w, hash(s.seed, i, j));
      }
    }
    q.s1 = this.stampLen;
    if (q.px1 > q.px0 && q.py1 > q.py0) {
      const tx0 = q.px0 >> TILE_SHIFT;
      const ty0 = q.py0 >> TILE_SHIFT;
      const tx1 = (q.px1 - 1) >> TILE_SHIFT;
      const ty1 = (q.py1 - 1) >> TILE_SHIFT;
      const cols = this.tCols;
      const tiles = this.tiles;
      for (let ty = ty0; ty <= ty1; ty++) {
        const rOff = ty * cols;
        for (let tx = tx0; tx <= tx1; tx++) {
          tiles[rOff + tx]!.push(q);
        }
      }
    }
  }

  /** Stamp one piece at its level into buf32 clipped to [cx0..cx1, cy0..cy1). */
  private stampPiece(q: Piece, cx0: number, cy0: number, cx1: number, cy1: number) {
    const lvlInt = (q.lvl * LEVELS + 0.5) | 0;
    if (lvlInt <= 0) return;
    const col = (q.s.rgb ??= this.parseColor(q.s.color));
    const colBGR = col.bgr;
    const cov = this.cov;
    const cMin = this.covMin;
    const cMax = this.covMax;
    const grain = this.grainTile;
    const xm = this.xMod;
    const ym = this.yMod;
    const buf = this.buf32;
    const cw = this.canvas.width;
    const stamps = this.stamps;
    const s0 = q.s0;
    const s1 = q.s1;

    for (let m = s0; m < s1; m += 2) {
      const w0 = stamps[m]!;
      const w1 = stamps[m + 1]!;
      const px0 = (w0 << 16) >> 16;
      const py0 = w0 >> 16;
      const lutIdx = w1 & 0xfff;
      const ri = lutIdx >>> 6;
      const cLo = cMin[ri]!;
      const cHi = cMax[ri]!;
      const dx0 = px0 + cLo < cx0 ? cx0 - px0 : cLo;
      const dy0 = py0 + cLo < cy0 ? cy0 - py0 : cLo;
      const dx1 = px0 + cHi > cx1 ? cx1 - px0 : cHi;
      const dy1 = py0 + cHi > cy1 ? cy1 - py0 : cHi;
      if (dx0 >= dx1 || dy0 >= dy1) continue;

      const lutBase = lutIdx << 6;
      const aFixed = ((w1 >>> 12) * lvlInt + 128) >> 8;
      for (let dy = dy0; dy < dy1; dy++) {
        const py = py0 + dy;
        const gRow = ym[py]!;
        const bRow = py * cw + px0;
        const lRow = lutBase + (dy << 3);
        for (let dx = dx0; dx < dx1; dx++) {
          const c = cov[lRow + dx]!;
          if (c === 0) continue;
          const ga = grain[gRow + xm[px0 + dx]!]!;
          const sa = (c * ga * aFixed + 8192) >>> 16;
          if (sa === 0) continue;
          const idx = bRow + dx;
          const word = buf[idx]!;
          const da = word >>> 24;
          if (da === 0) {
            buf[idx] = (sa << 24) | colBGR;
          } else if ((word & 0x00ffffff) === colBGR) {
            const outA = sa + ((da * (255 - sa) + 64) >>> 8);
            buf[idx] = (outA << 24) | colBGR;
          } else {
            const sScale = sa * 255;
            const dScale = da * (255 - sa);
            const outA255 = sScale + dScale;
            const outA = ((outA255 + 127) * 257) >>> 16;
            const half = outA255 >> 1;
            const nr = ((col.r * sScale + (word & 255) * dScale + half) / outA255) | 0;
            const ng = ((col.g * sScale + ((word >>> 8) & 255) * dScale + half) / outA255) | 0;
            const nb = ((col.b * sScale + ((word >>> 16) & 255) * dScale + half) / outA255) | 0;
            buf[idx] = (outA << 24) | (nb << 16) | (ng << 8) | nr;
          }
        }
      }
    }
  }
}

/** Merge overlapping boxes when their union is tighter than painting them separately. */
function merge(boxes: Box[]): Box[] {
  const out: Box[] = [];
  for (const b of boxes) {
    let m = { ...b };
    for (let i = 0; i < out.length; ) {
      const o = out[i]!;
      if (overlaps(o, m)) {
        const ux0 = Math.min(o.x0, m.x0);
        const uy0 = Math.min(o.y0, m.y0);
        const ux1 = Math.max(o.x1, m.x1);
        const uy1 = Math.max(o.y1, m.y1);
        if ((ux1 - ux0) * (uy1 - uy0) <= (o.x1 - o.x0) * (o.y1 - o.y0) + (m.x1 - m.x0) * (m.y1 - m.y0) + 200) {
          out.splice(i, 1);
          m = { x0: ux0, y0: uy0, x1: ux1, y1: uy1 };
          i = 0;
          continue;
        }
      }
      i++;
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

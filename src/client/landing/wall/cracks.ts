// Cracks: the wall around the strike cluster is pre-split into fragments (a Voronoi partition, denser toward the
// centre, every edge jagged), invisible until cracks run along those edges. Cracking starts at the claw slits: a spur
// runs from each slit to the nearest fragment corner, and from there cracks grow corner to corner, mostly toward the
// centre, sometimes running on by themselves, darkening and widening as they age. Stray slits elsewhere get a couple
// of short hairlines. A fragment whose edges have all cracked can break off (debris.ts), and removed fragments make the
// hole (hole.ts): this module owns that geometry for both.
import { gauss, rand, seeded, triangulate, type Batch, type View } from "./core.ts";
import type { Puncture } from "./strikes.ts";

export const CRACK = {
  /** the fractured disc round the hole centre (px) */
  region: 340,
  regionLow: 220,
  /** fragment spacing (px) at the centre and at the region's edge */
  cellMin: 36,
  cellMax: 100,
  /** jaggedness: subdivision levels, and sideways kick as a fraction of each piece's length */
  jagLevels: 4,
  jag: 0.22,
  /** growth speed (px/s) */
  speed: [70, 170] as const,
  /** chance a finished crack runs on along a neighbouring edge by itself */
  runOn: 0.3,
  /** width (px) when new and when old, and darkness (alpha) when new and when old; aging takes `age` s */
  width: [0.6, 1.5] as const,
  dark: [0.3, 0.85] as const,
  age: 30,
  /** hairlines round a stray slit: how many, how long (px) */
  strays: [1, 3] as const,
  strayLength: [8, 26] as const,
};

interface Vtx {
  x: number;
  y: number;
  edges: number[];
  cracked: boolean;
}

export interface Edge {
  a: number;
  b: number;
  /** jagged polyline from vertex a to vertex b */
  pts: number[];
  cells: number[];
  crack: Crack | null;
}

export interface Cell {
  id: number;
  /** jagged outline (flat xy) and its triangles */
  poly: number[];
  tris: number[];
  edges: number[];
  cx: number;
  cy: number;
  /** distance from the hole centre */
  r: number;
  /** wholly inside the fractured region (only these can break) */
  interior: boolean;
  removed: boolean;
}

interface Crack {
  pts: number[];
  cum: number[];
  total: number;
  grown: number;
  speed: number;
  age: number;
  onDone?: () => void;
}

function makeCrack(pts: number[], speed: number, onDone?: () => void): Crack {
  const cum = [0];
  for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1]! + Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!));
  return { pts, cum, total: cum[cum.length - 1]!, grown: 0, speed, age: 0, onDone };
}

/** Jag the segment (x0, y0)–(x1, y1) by midpoint displacement; returns flat xy including both ends. */
export function jagged(x0: number, y0: number, x1: number, y1: number, levels: number, kick: number, rnd: () => number): number[] {
  let pts = [x0, y0, x1, y1];
  for (let l = 0; l < levels; l++) {
    const next: number[] = [];
    for (let i = 0; i + 2 < pts.length; i += 2) {
      const ax = pts[i]!;
      const ay = pts[i + 1]!;
      const bx = pts[i + 2]!;
      const by = pts[i + 3]!;
      const len = Math.hypot(bx - ax, by - ay);
      const o = (rnd() - 0.5) * 2 * kick * len;
      const t = 0.5 + (rnd() - 0.5) * 0.3;
      next.push(ax, ay, ax + (bx - ax) * t - ((by - ay) / (len || 1)) * o, ay + (by - ay) * t + ((bx - ax) / (len || 1)) * o);
    }
    next.push(pts[pts.length - 2]!, pts[pts.length - 1]!);
    pts = next;
  }
  return pts;
}

/** The fractured region: fragments, their shared jagged edges and corners, and the cracks growing along them. */
export class Fracture {
  readonly verts: Vtx[] = [];
  readonly edges: Edge[] = [];
  readonly cells: Cell[] = [];
  private loose: Crack[] = [];
  private spurred = new Set<Puncture>();
  readonly radius: number;
  started = false;

  constructor(
    readonly cx: number,
    readonly cy: number,
    low: boolean,
  ) {
    this.radius = low ? CRACK.regionLow : CRACK.region;
    this.build(low ? 0.7 : 1);
  }

  private build(scale: number) {
    const R = this.radius;
    const { cx, cy } = this;
    // seeds: dart throwing, closer together near the centre
    const seeds: [number, number][] = [[cx + rand(-6, 6), cy + rand(-6, 6)]];
    const gap = (x: number, y: number) => {
      const t = Math.min(1, Math.hypot(x - cx, y - cy) / R);
      return (CRACK.cellMin + (CRACK.cellMax - CRACK.cellMin) * t * t) * scale;
    };
    for (let tries = 0; tries < 4000; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * R * 1.25;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const g = gap(x, y);
      if (seeds.every(([sx, sy]) => (sx - x) ** 2 + (sy - y) ** 2 > g * g)) seeds.push([x, y]);
    }
    // each cell: the box clipped by the half-planes toward every other seed; each side remembers which seed made it
    const B = R * 1.3;
    const vertId = (x: number, y: number) => {
      for (let i = 0; i < this.verts.length; i++) {
        const v = this.verts[i]!;
        if (Math.abs(v.x - x) < 0.5 && Math.abs(v.y - y) < 0.5) return i;
      }
      this.verts.push({ x, y, edges: [], cracked: false });
      return this.verts.length - 1;
    };
    const edgeIds = new Map<string, number>();
    seeds.forEach(([sx, sy], ci) => {
      // polygon: points with the label of the side starting there (-1: the box)
      let poly: { x: number; y: number; l: number }[] = [
        { x: cx - B, y: cy - B, l: -1 },
        { x: cx + B, y: cy - B, l: -1 },
        { x: cx + B, y: cy + B, l: -1 },
        { x: cx - B, y: cy + B, l: -1 },
      ];
      seeds.forEach(([ox, oy], oi) => {
        if (oi === ci) return;
        const mx = (sx + ox) / 2;
        const my = (sy + oy) / 2;
        const nx = ox - sx;
        const ny = oy - sy;
        const side = (p: { x: number; y: number }) => (p.x - mx) * nx + (p.y - my) * ny;
        const out: typeof poly = [];
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i]!;
          const q = poly[(i + 1) % poly.length]!;
          const sp = side(p);
          const sq = side(q);
          if (sp <= 0) out.push(p);
          if ((sp <= 0) !== (sq <= 0)) {
            const t = sp / (sp - sq);
            // entering the kept side continues p's side; leaving starts the new side along this bisector
            out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, l: sp <= 0 ? oi : p.l });
          }
        }
        poly = out;
      });
      if (poly.length < 3) return;
      const vids = poly.map((p) => vertId(p.x, p.y));
      const cell: Cell = { id: this.cells.length, poly: [], tris: [], edges: [], cx: 0, cy: 0, r: 0, interior: true, removed: false };
      for (let i = 0; i < poly.length; i++) {
        const a = vids[i]!;
        const b = vids[(i + 1) % poly.length]!;
        if (a === b) continue;
        if (poly[i]!.l < 0) cell.interior = false;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        let e = edgeIds.get(key);
        if (e === undefined) {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const va = this.verts[lo]!;
          const vb = this.verts[hi]!;
          const rnd = seeded(lo * 7919 + hi * 104729 + 17);
          e = this.edges.length;
          this.edges.push({ a: lo, b: hi, pts: jagged(va.x, va.y, vb.x, vb.y, CRACK.jagLevels, CRACK.jag, rnd), cells: [], crack: null });
          va.edges.push(e);
          vb.edges.push(e);
          edgeIds.set(key, e);
        }
        const edge = this.edges[e]!;
        edge.cells.push(cell.id);
        cell.edges.push(e);
        // this side's jagged points from a toward b, without the end
        const pts = edge.a === a ? edge.pts : reversed(edge.pts);
        for (let k = 0; k < pts.length - 2; k += 2) cell.poly.push(pts[k]!, pts[k + 1]!);
      }
      let x = 0;
      let y = 0;
      for (let k = 0; k < poly.length; k++) {
        x += poly[k]!.x;
        y += poly[k]!.y;
      }
      cell.cx = x / poly.length;
      cell.cy = y / poly.length;
      cell.r = Math.hypot(cell.cx - cx, cell.cy - cy);
      if (cell.r > R * 0.92) cell.interior = false;
      cell.tris = triangulate(cell.poly);
      this.cells.push(cell);
    });
  }

  /** Start one round of cracking: spurs from new slits, then a crack from the cracked network toward the centre. */
  crack(punctures: readonly Puncture[]) {
    this.started = true;
    for (const p of punctures) {
      if (this.spurred.has(p)) continue;
      this.spurred.add(p);
      if (Math.hypot(p.x - this.cx, p.y - this.cy) > this.radius * 0.95) {
        this.strayLines(p);
        continue;
      }
      let best = -1;
      let bd = Infinity;
      this.verts.forEach((v, i) => {
        const d = (v.x - p.x) ** 2 + (v.y - p.y) ** 2;
        if (d < bd && v.edges.length > 1) {
          bd = d;
          best = i;
        }
      });
      if (best < 0) continue;
      const v = this.verts[best]!;
      const pts = jagged(p.x, p.y, v.x, v.y, 3, CRACK.jag, Math.random);
      this.loose.push(makeCrack(pts, rand(...CRACK.speed), () => this.reach(best)));
    }
    this.grow();
  }

  private strayLines(p: Puncture) {
    const n = Math.round(rand(CRACK.strays[0], CRACK.strays[1]));
    for (let i = 0; i < n; i++) {
      const a = p.a + (Math.random() < 0.5 ? 0 : Math.PI) + gauss() * 0.6;
      const L = rand(...CRACK.strayLength);
      const sx = p.x + Math.cos(a) * p.len * 0.4;
      const sy = p.y + Math.sin(a) * p.len * 0.4;
      this.loose.push(makeCrack(jagged(sx, sy, sx + Math.cos(a) * L, sy + Math.sin(a) * L, 3, CRACK.jag, Math.random), rand(...CRACK.speed) * 0.5));
    }
  }

  /** A crack reached a corner: it's cracked; sometimes the crack runs on. */
  private reach(v: number) {
    this.verts[v]!.cracked = true;
    if (Math.random() < CRACK.runOn) this.grow(v);
  }

  /** Grow a crack along an uncracked edge from a cracked corner (from `from` if given), favouring the centre. */
  grow(from?: number) {
    const cands: { e: number; v: number; w: number }[] = [];
    const add = (vi: number) => {
      for (const e of this.verts[vi]!.edges) {
        const ed = this.edges[e]!;
        if (ed.crack || ed.cells.length < 2) continue;
        const mx = (this.verts[ed.a]!.x + this.verts[ed.b]!.x) / 2;
        const my = (this.verts[ed.a]!.y + this.verts[ed.b]!.y) / 2;
        cands.push({ e, v: vi, w: Math.exp(-Math.hypot(mx - this.cx, my - this.cy) / (this.radius * 0.3)) });
      }
    };
    if (from !== undefined) add(from);
    else this.verts.forEach((v, i) => v.cracked && add(i));
    if (!cands.length) return false;
    let r = Math.random() * cands.reduce((s, c) => s + c.w, 0);
    const c = cands.find((c) => (r -= c.w) <= 0) ?? cands[cands.length - 1]!;
    this.crackEdge(c.e, c.v, rand(...CRACK.speed));
    return true;
  }

  private crackEdge(e: number, from: number, speed: number) {
    const ed = this.edges[e]!;
    const to = ed.a === from ? ed.b : ed.a;
    ed.crack = makeCrack(ed.a === from ? ed.pts : reversed(ed.pts), speed, () => this.reach(to));
  }

  /** The next fragment to break: the centre one first, then a neighbour of the hole, closest to the centre. */
  nextCell(): Cell | null {
    const removed = this.cells.filter((c) => c.removed);
    const open = this.cells.filter((c) => c.interior && !c.removed);
    if (!open.length) return null;
    if (!removed.length) return open.reduce((a, b) => (a.r < b.r ? a : b));
    const touching = open.filter((c) => c.edges.some((e) => this.edges[e]!.cells.some((o) => this.cells[o]!.removed)));
    const pool = touching.length ? touching : open;
    return pool.reduce((a, b) => (a.r + rand(0, 40) < b.r + rand(0, 40) ? a : b));
  }

  /** Crack all round a fragment at once and take it out of the wall (the caller makes it fall). */
  breakCell(c: Cell) {
    for (const e of c.edges) {
      const ed = this.edges[e]!;
      if (!ed.crack) ed.crack = makeCrack(ed.pts, 1);
      ed.crack.grown = ed.crack.total;
      ed.crack.age = Math.max(ed.crack.age, CRACK.age * 0.6);
      this.verts[ed.a]!.cracked = this.verts[ed.b]!.cracked = true;
    }
    c.removed = true;
    this.started = true;
  }

  /** The hole's outline: edges between a removed fragment and one still in the wall, as [edge, the removed cell]. */
  rim(): [Edge, Cell][] {
    const out: [Edge, Cell][] = [];
    for (const ed of this.edges) {
      const [a, b] = ed.cells;
      if (a === undefined || b === undefined) continue;
      const ca = this.cells[a]!;
      const cb = this.cells[b]!;
      if (ca.removed !== cb.removed) out.push([ed, ca.removed ? ca : cb]);
    }
    return out;
  }

  get removed() {
    return this.cells.filter((c) => c.removed);
  }

  update(dt: number) {
    const step = (c: Crack) => {
      c.age += dt;
      if (c.grown >= c.total) return;
      c.grown += c.speed * dt;
      if (c.grown >= c.total) {
        c.grown = c.total;
        c.onDone?.();
      }
    };
    for (const c of this.loose) step(c);
    for (const ed of this.edges) if (ed.crack) step(ed.crack);
  }

  get busy() {
    return this.loose.some((c) => c.grown < c.total) || this.edges.some((e) => e.crack && e.crack.grown < e.crack.total);
  }

  draw(b: Batch, _v: View) {
    const one = (c: Crack) => {
      const t = Math.min(1, c.age / CRACK.age);
      const w = CRACK.width[0] + (CRACK.width[1] - CRACK.width[0]) * t;
      const a = CRACK.dark[0] + (CRACK.dark[1] - CRACK.dark[0]) * t;
      const dark = [0.12, 0.11, 0.12, a];
      const lit = [1, 1, 1, 0.55 * a];
      for (let i = 2; i < c.pts.length; i += 2) {
        const s0 = c.cum[i / 2 - 1]!;
        if (s0 >= c.grown) break;
        const s1 = c.cum[i / 2]!;
        const f = s1 <= c.grown ? 1 : (c.grown - s0) / (s1 - s0);
        const x0 = c.pts[i - 2]!;
        const y0 = c.pts[i - 1]!;
        const x1 = x0 + (c.pts[i]! - x0) * f;
        const y1 = y0 + (c.pts[i + 1]! - y0) * f;
        // the far lip catches the light, just below the dark line
        b.line(x0 + 0.7, y0 + 0.8, x1 + 0.7, y1 + 0.8, w * 0.7, lit);
        b.line(x0, y0, x1, y1, w, dark);
      }
    };
    for (const c of this.loose) one(c);
    for (const ed of this.edges) {
      if (!ed.crack) continue;
      // the hole draws its own rim; edges inside it are gone
      if (ed.cells.some((c) => this.cells[c]!.removed)) continue;
      one(ed.crack);
    }
  }
}

function reversed(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i]!, pts[i + 1]!);
  return out;
}

// Cracks: the drywall round a punch site is pre-split the way a punched board breaks: cracks radiating from the
// centre, crossed by concentric fractures, the plates between them jagged (every edge shared by both neighbours). It's
// invisible until the punches crack it: each punch drives the radial cracks a ring further out (fast, with short
// branches), and later ones join them with concentric cracks. Cracks widen as the plates either side lift (plates.ts).
// Plates are what lift, break off (debris.ts) and open the hole (hole.ts), so this module owns that geometry.
import { clamp, gauss, rand, seeded, triangulate, type Batch, type View } from "./core.ts";

export const CRACK = {
  /** the fractured disc round a site (px) */
  radius: 290,
  radiusLow: 185,
  /** cracks radiating from the centre, and the chance one stops short of each ring (by ring: so plates further out
   *  are bigger and fewer) */
  radials: [8, 11] as const,
  stop: [0, 0.12, 0.3, 0.45, 0.55] as const,
  /** the concentric fractures, as fractions of the radius (the last is the disc's edge, never cracked) */
  rings: [0.13, 0.3, 0.52, 0.78, 1] as const,
  /** jitter: each ring's radius (fraction of its gap to the next), each radial's angle (fraction of a sector) */
  ringJitter: 0.85,
  /** the chance each piece of a concentric fracture ever cracks, by ring (so they're broken arcs, not circles) */
  ringFate: [1, 0.85, 0.6, 0.4] as const,
  /** at most this many sectors run into one plate */
  merge: 2,
  angleJitter: 0.8,
  /** jaggedness: subdivision levels, and sideways kick as a fraction of each piece's length */
  jagLevels: 4,
  jag: 0.2,
  /** short branches off a radial crack: how many per edge, how long (px) */
  branches: [1, 3] as const,
  branchLength: [8, 30] as const,
  /** how fast a crack runs (px/s): a punch drives it almost at once */
  speed: [500, 1100] as const,
  /** width (px) and darkness (alpha) when new and when old; aging takes `age` s */
  width: [0.55, 1.2] as const,
  dark: [0.42, 0.8] as const,
  age: 12,
  /** a crack between lifting plates opens up to this wide (px) */
  gap: 2.6,
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
  /** radial (from the centre outward: a is the inner end), concentric, or the disc's edge */
  kind: "radial" | "ring" | "edge";
  /** the ring it's on (concentric), or the ring it starts from (radial) */
  ring: number;
  branches: number[][];
  /** (concentric) whether it will ever crack */
  fated: boolean;
}

export interface Cell {
  id: number;
  /** jagged outline (flat xy) and its triangles */
  poly: number[];
  tris: number[];
  /** a triangle fan over the outline: filled with the stencil's even-odd rule, right even where tris aren't */
  fan: number[];
  edges: number[];
  cx: number;
  cy: number;
  /** distance from the site's centre */
  r: number;
  /** its ring (0: the wedges round the centre) */
  ring: number;
  /** the edge it hinges on when it lifts (its outer edge), as two points */
  hinge: [number, number, number, number];
  hingeEdge: number;
  /** may break out (not the outer ring) */
  interior: boolean;
  removed: boolean;
  /** how far it has lifted (0..1; plates.ts animates it) and how far it's going */
  lift: number;
  liftTarget: number;
  liftV: number;
  /** a little character per plate */
  seed: number;
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
      // (calmer next to the corners, so two edges meeting at a sharp angle don't cross)
      const end = i === 0 || i + 4 >= pts.length ? 0.25 : 1;
      const o = (rnd() - 0.5) * 2 * kick * len * end;
      const t = 0.5 + (rnd() - 0.5) * 0.3;
      next.push(ax, ay, ax + (bx - ax) * t - ((by - ay) / (len || 1)) * o, ay + (by - ay) * t + ((bx - ax) / (len || 1)) * o);
    }
    next.push(pts[pts.length - 2]!, pts[pts.length - 1]!);
    pts = next;
  }
  return pts;
}

/** A punch site's fracture: plates, their shared jagged edges and corners, and the cracks growing along them. */
export class Fracture {
  readonly verts: Vtx[] = [];
  readonly edges: Edge[] = [];
  readonly cells: Cell[] = [];
  private loose: Crack[] = [];
  readonly radius: number;
  readonly rings: number;
  started = false;

  constructor(
    readonly cx: number,
    readonly cy: number,
    low: boolean,
    scale = 1,
  ) {
    this.radius = (low ? CRACK.radiusLow : CRACK.radius) * scale;
    this.rings = CRACK.rings.length;
    this.build();
  }

  private build() {
    const R = this.radius;
    const { cx, cy } = this;
    const n = Math.round(rand(CRACK.radials[0], CRACK.radials[1]));
    const K = CRACK.rings.length;
    const sector = (Math.PI * 2) / n;
    const a0 = Math.random() * Math.PI * 2;
    // each radial's base angle, and the corners where it meets each ring (wandering a little ring to ring)
    // irregular, but never closer than a fraction of a sector (or the wedges between them pinch to nothing)
    let ang: number[] = [];
    for (let tries = 0; tries < 200; tries++) {
      ang = [];
      for (let i = 0; i < n; i++) ang.push(a0 + i * sector + rand(-0.5, 0.5) * CRACK.angleJitter * sector);
      if (ang.every((a, i) => (i + 1 < n ? ang[i + 1]! : ang[0]! + Math.PI * 2) - a > sector * 0.5)) break;
    }
    const centre = this.vert(cx, cy);
    const grid: number[][] = [];
    for (let i = 0; i < n; i++) {
      const col: number[] = [];
      let a = ang[i]!;
      for (let k = 0; k < K; k++) {
        const f = CRACK.rings[k]!;
        const gap = (CRACK.rings[k + 1] ?? f + 0.2) - f;
        const r = R * (k === K - 1 ? f * (1 + rand(-0.04, 0.04)) : f + gap * rand(-CRACK.ringJitter, CRACK.ringJitter) * 0.5);
        a += gauss() * sector * 0.05;
        col.push(this.vert(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
      }
      grid.push(col);
    }
    const V = (i: number, k: number) => (k < 0 ? centre : grid[((i % n) + n) % n]![k]!);
    const radial = new Map<string, number>();
    const ring = new Map<string, number>();
    const rnd = seeded(Math.floor(Math.random() * 1e9));
    const edge = (a: number, b: number, kind: Edge["kind"], k: number, arc: boolean) => {
      const va = this.verts[a]!;
      const vb = this.verts[b]!;
      let pts: number[];
      if (arc) {
        // concentric: bowed along the ring through a midpoint on the circle
        const ra = Math.hypot(va.x - cx, va.y - cy);
        const rb = Math.hypot(vb.x - cx, vb.y - cy);
        let aa = Math.atan2(va.y - cy, va.x - cx);
        let ab = Math.atan2(vb.y - cy, vb.x - cx);
        if (ab < aa) ab += Math.PI * 2;
        if (ab - aa > Math.PI) aa += Math.PI * 2;
        const am = (aa + ab) / 2;
        const rm = (ra + rb) / 2;
        const mx = cx + Math.cos(am) * rm;
        const my = cy + Math.sin(am) * rm;
        const kick = kind === "edge" ? CRACK.jag * 0.6 : CRACK.jag;
        const h1 = jagged(va.x, va.y, mx, my, CRACK.jagLevels - 1, kick, rnd);
        const h2 = jagged(mx, my, vb.x, vb.y, CRACK.jagLevels - 1, kick, rnd);
        pts = h1.concat(h2.slice(2));
      } else pts = jagged(va.x, va.y, vb.x, vb.y, CRACK.jagLevels, CRACK.jag, rnd);
      const branches: number[][] = [];
      if (kind === "radial") {
        const nb = Math.round(rand(CRACK.branches[0], CRACK.branches[1]));
        for (let j = 0; j < nb; j++) {
          const m = Math.floor(rand(0.3, 0.8) * (pts.length / 2 - 1));
          const dx = vb.x - va.x;
          const dy = vb.y - va.y;
          const da = Math.atan2(dy, dx) + (Math.random() < 0.5 ? -1 : 1) * rand(0.4, 0.9);
          const L = rand(...CRACK.branchLength);
          const sx = pts[m * 2]!;
          const sy = pts[m * 2 + 1]!;
          branches.push(jagged(sx, sy, sx + Math.cos(da) * L, sy + Math.sin(da) * L, 3, CRACK.jag, rnd));
        }
      }
      const id = this.edges.length;
      const fated = kind !== "ring" || Math.random() < (CRACK.ringFate[k] ?? 0.3);
      this.edges.push({ a, b, pts, cells: [], crack: null, kind, ring: k, branches, fated });
      va.edges.push(id);
      vb.edges.push(id);
      return id;
    };
    const radialEdge = (i: number, k: number) => {
      // from ring k-1 (or the centre) out to ring k
      const key = `${((i % n) + n) % n},${k}`;
      let e = radial.get(key);
      if (e === undefined) radial.set(key, (e = edge(V(i, k - 1), V(i, k), "radial", k, false)));
      return e;
    };
    const ringEdge = (i: number, k: number) => {
      const key = `${((i % n) + n) % n},${k}`;
      let e = ring.get(key);
      if (e === undefined) ring.set(key, (e = edge(V(i, k), V(i + 1, k), k === K - 1 ? "edge" : "ring", k, true)));
      return e;
    };
    // which radials reach each ring (some stop short: the plates either side are one); at least three always do
    const reach: boolean[][] = [];
    for (let k = 0; k < K; k++) {
      const row: boolean[] = [];
      for (let i = 0; i < n; i++) row.push(k === 0 || (reach[k - 1]![i]! && Math.random() >= (CRACK.stop[k] ?? 0.5)));
      // (no plate longer than CRACK.merge sectors)
      for (let i = 0, run = 0; i < n * 2; i++) {
        if (row[i % n]) run = 0;
        else if (++run >= CRACK.merge) {
          row[i % n] = true;
          run = 0;
        }
      }
      for (let tries = 0; row.filter(Boolean).length < 3 && tries < 50; tries++) row[Math.floor(Math.random() * n)] = true;
      reach.push(row);
    }
    // the cells: wedges at the centre, then the plates of each ring: runs of sectors between radials that reach it
    for (let k = 0; k < K; k++) {
      const row = reach[k]!;
      const first = row.indexOf(true);
      for (let s0 = 0; s0 < n; s0++) {
        const i = first + s0;
        if (!row[i % n]) continue;
        let j = i + 1;
        while (!row[j % n]) j++;
        // sectors i .. j-1, bounded by radial i and radial j
        const sides: [number, boolean][] = [[radialEdge(i, k), true]];
        for (let q = i; q < j; q++) sides.push([ringEdge(q, k), true]);
        sides.push([radialEdge(j, k), false]);
        if (k > 0) for (let q = j - 1; q >= i; q--) sides.push([ringEdge(q, k - 1), false]);
        const cell: Cell = {
          id: this.cells.length, poly: [], tris: [], fan: [], edges: [], cx: 0, cy: 0, r: 0, ring: k,
          hinge: [0, 0, 0, 0], hingeEdge: -1, interior: k < K - 1, removed: false,
          lift: 0, liftTarget: 0, liftV: 0, seed: Math.random(),
        };
        let sx = 0;
        let sy = 0;
        let hingeLen = -1;
        for (const [e, fwd] of sides) {
          const ed = this.edges[e]!;
          ed.cells.push(cell.id);
          cell.edges.push(e);
          const pts = fwd ? ed.pts : reversed(ed.pts);
          for (let m = 0; m < pts.length - 2; m += 2) cell.poly.push(pts[m]!, pts[m + 1]!);
          const v = this.verts[fwd ? ed.a : ed.b]!;
          sx += v.x;
          sy += v.y;
          // it hinges on its longest outer edge
          if (fwd && (ed.kind === "ring" || ed.kind === "edge") && ed.ring === k) {
            const va = this.verts[ed.a]!;
            const vb = this.verts[ed.b]!;
            const len = Math.hypot(vb.x - va.x, vb.y - va.y);
            if (len > hingeLen) {
              hingeLen = len;
              cell.hinge = [va.x, va.y, vb.x, vb.y];
              cell.hingeEdge = e;
            }
          }
        }
        cell.cx = sx / sides.length;
        cell.cy = sy / sides.length;
        // (the wedges' corners are mostly at their outer edge: pull the middle in)
        if (k === 0) {
          cell.cx = (cell.cx * 3 + cx) / 4;
          cell.cy = (cell.cy * 3 + cy) / 4;
        }
        cell.r = Math.hypot(cell.cx - cx, cell.cy - cy);
        cell.tris = triangulate(cell.poly);
        for (let m = 1; m + 1 < cell.poly.length / 2; m++) cell.fan.push(0, m, m + 1);
        this.cells.push(cell);
        if (j >= n + first) break;
        s0 = j - first - 1;
      }
    }
    this.verts[centre]!.cracked = true;
  }

  private vert(x: number, y: number) {
    this.verts.push({ x, y, edges: [], cracked: false });
    return this.verts.length - 1;
  }

  /**
   * A punch: radial cracks reach out to ring `radial` (counting from 1), and each concentric fracture up to ring
   * `ring` cracks with chance `chance`. Cracks run from a corner that's already cracked.
   */
  advance(radial: number, ring: number, chance: number) {
    this.started = true;
    for (let e = 0; e < this.edges.length; e++) {
      const ed = this.edges[e]!;
      if (ed.crack || ed.kind === "edge") continue;
      if (ed.kind === "radial" && ed.ring < radial) {
        if (this.verts[ed.a]!.cracked) this.crackEdge(e, ed.a);
      } else if (ed.kind === "ring" && ed.fated && ed.ring < ring && Math.random() < chance) {
        if (this.verts[ed.a]!.cracked) this.crackEdge(e, ed.a);
        else if (this.verts[ed.b]!.cracked) this.crackEdge(e, ed.b);
      }
    }
  }

  private crackEdge(e: number, from: number) {
    const ed = this.edges[e]!;
    const to = ed.a === from ? ed.b : ed.a;
    ed.crack = makeCrack(ed.a === from ? ed.pts : reversed(ed.pts), rand(...CRACK.speed), () => {
      this.verts[to]!.cracked = true;
      for (const b of ed.branches) this.loose.push(makeCrack(b, rand(...CRACK.speed) * 0.5));
    });
  }

  /** Cracked all round but for its hinge: free to lift. */
  canLift(c: Cell) {
    return !c.removed && c.edges.every((e) => e === c.hingeEdge || this.edges[e]!.crack);
  }

  /** The next plate to break out: the centre ones first, then roughly outward, beside the hole. */
  nextCell(reach = Infinity): Cell | null {
    const open = this.cells.filter((c) => c.interior && !c.removed && c.r < reach);
    if (!open.length) return null;
    const removed = this.cells.some((c) => c.removed);
    const touching = removed ? open.filter((c) => c.edges.some((e) => this.edges[e]!.cells.some((o) => this.cells[o]!.removed))) : [];
    const pool = touching.length ? touching : open;
    // roughly outward, but ragged
    return pool.reduce((a, b) => (a.r * rand(0.7, 1.3) < b.r * rand(0.7, 1.3) ? a : b));
  }

  /** Crack all round a plate at once and take it out of the wall (the caller makes it fall). */
  breakCell(c: Cell) {
    for (const e of c.edges) {
      const ed = this.edges[e]!;
      if (!ed.crack) ed.crack = makeCrack(ed.pts, 1);
      ed.crack.grown = ed.crack.total;
      this.verts[ed.a]!.cracked = this.verts[ed.b]!.cracked = true;
    }
    c.removed = true;
    this.started = true;
  }

  /** The hole's outline: edges between a removed plate and one still in the wall, as [edge, the removed cell]. */
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
    const one = (c: Crack, open: number) => {
      const t = Math.min(1, c.age / CRACK.age);
      const w = CRACK.width[0] + (CRACK.width[1] - CRACK.width[0]) * t + open * CRACK.gap;
      const a = clamp(CRACK.dark[0] + (CRACK.dark[1] - CRACK.dark[0]) * t + open, 0, 1);
      // the crack: a shadowed groove, its far lip catching the light (the light's from the top left)
      const dark = [0.16 - open * 0.07, 0.15 - open * 0.07, 0.14 - open * 0.07, a];
      const lit = [1, 1, 1, 0.7 * a];
      for (let i = 2; i < c.pts.length; i += 2) {
        const s0 = c.cum[i / 2 - 1]!;
        if (s0 >= c.grown) break;
        const s1 = c.cum[i / 2]!;
        const f = s1 <= c.grown ? 1 : (c.grown - s0) / (s1 - s0);
        const x0 = c.pts[i - 2]!;
        const y0 = c.pts[i - 1]!;
        const x1 = x0 + (c.pts[i]! - x0) * f;
        const y1 = y0 + (c.pts[i + 1]! - y0) * f;
        const o = 0.5 + w * 0.5;
        b.line(x0 + o, y0 + o, x1 + o, y1 + o, Math.max(0.6, w * 0.5), lit);
        b.line(x0, y0, x1, y1, w, dark);
      }
    };
    for (const c of this.loose) one(c, 0);
    for (let e = 0; e < this.edges.length; e++) {
      const ed = this.edges[e]!;
      if (!ed.crack) continue;
      // the hole draws its own rim; edges inside it are gone
      if (ed.cells.some((c) => this.cells[c]!.removed)) continue;
      // opened by a plate either side lifting away from it (not where a plate hinges: that bends, it doesn't open)
      let open = 0;
      for (const c of ed.cells) if (this.cells[c]!.hingeEdge !== e) open = Math.max(open, this.cells[c]!.lift);
      one(ed.crack, open);
    }
  }
}

function reversed(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i]!, pts[i + 1]!);
  return out;
}

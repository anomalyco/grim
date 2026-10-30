// The fracture round a punch site, worked out in advance and revealed a crack at a time. Irregular plates: a
// Voronoi tiling whose cells are small near the impact and bigger further out, with three cells meeting at the
// impact point. Every shared edge is one jagged polyline used by both plates, so the plates fit exactly. Edges on
// the outside of the fractured area never crack: that's where it joins the rest of the wall. The plates themselves
// (as 3D slabs) are in plates.ts.
import { clamp, rand, seeded, triangulate } from "./core.ts";

export const CRACK = {
  /** the fractured area's radius (px; times the site's scale) */
  radius: 230,
  radiusLow: 150,
  /** the spacing of plates (px, times scale): near the impact, at the edge */
  spacingNear: 46,
  spacingFar: 112,
  /** how much the spacing follows the distance (exponent) */
  spacingCurve: 1.15,
  /** jagged edges: a point every `step` px, nudged up to `jag` px; plus one bend of up to `bend` times the length */
  step: 9,
  jag: 1.9,
  bend: 0.07,
  /** a crack takes this long (s) to run its length */
  zip: 0.07,
};

export interface Edge {
  id: number;
  /** its two ends (corner ids) */
  a: number;
  b: number;
  /** the polyline from a to b (flat xy, ends included) */
  pts: number[];
  /** the plates on either side (-1: none; the edge of the fractured area) */
  left: number;
  right: number;
  /** on the outside of the fractured area (never cracks unless a plate on it is knocked out) */
  outer: boolean;
  cracked: boolean;
  /** how much of it has run (0..1), and from which end */
  run: number;
  fromB: boolean;
  /** when it cracked (punch number) */
  at: number;
}

export interface PlateShape {
  id: number;
  /** its outline (flat xy, positive area), and that outline's triangles */
  poly: number[];
  tris: number[];
  /** where each edge starts in `poly`, the edge, and whether it runs backwards */
  sides: { edge: Edge; start: number; rev: boolean }[];
  /** centroid, and its distance from the impact */
  cx: number;
  cy: number;
  r: number;
  area: number;
}

export class Fracture {
  readonly edges: Edge[] = [];
  readonly shapes: PlateShape[] = [];
  /** corner positions (flat xy) */
  readonly corners: number[] = [];
  readonly radius: number;
  /** corners reached by a crack */
  readonly reached = new Set<number>();
  /** the corner at the impact */
  readonly origin: number;
  /** plates knocked out (the hole; crawlers clip to these) */
  readonly removed: PlateShape[] = [];

  constructor(
    readonly cx: number,
    readonly cy: number,
    scale: number,
    low: boolean,
  ) {
    this.radius = (low ? CRACK.radiusLow : CRACK.radius) * scale;
    const R = this.radius;
    const near = CRACK.spacingNear * scale * (low ? 0.8 : 1);
    const far = CRACK.spacingFar * scale * (low ? 0.8 : 1);
    const spacing = (r: number) => near + (far - near) * Math.pow(clamp(r / R, 0, 1), CRACK.spacingCurve);

    // seeds: three round the impact, then darts (each needs its spacing to the others), then a ring outside
    const seeds: number[] = [];
    const a0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < 3; i++) {
      const a = a0 + (i * Math.PI * 2) / 3 + rand(-0.35, 0.35);
      const d = near * rand(0.5, 0.65);
      seeds.push(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
    }
    const ok = (x: number, y: number, s: number) => {
      for (let i = 0; i < seeds.length; i += 2) if (Math.hypot(seeds[i]! - x, seeds[i + 1]! - y) < s) return false;
      return true;
    };
    for (let tries = 0; tries < 4000; tries++) {
      const r = R * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (ok(x, y, spacing(r) * 0.82)) seeds.push(x, y);
    }
    const inner = seeds.length / 2;
    const ring = Math.max(10, Math.round((Math.PI * 2 * R * 1.2) / far));
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2 + rand(-0.15, 0.15);
      const d = R * rand(1.12, 1.32);
      seeds.push(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
    }

    // cells of the inner seeds, each edge labelled with the seed across it
    const box = R * 2;
    const cornerIds = new Map<string, number>();
    // (the same Voronoi corner, worked out from different cells, can differ in the last digits: merge near ones)
    const corner = (x: number, y: number) => {
      const gx = Math.round(x * 4);
      const gy = Math.round(y * 4);
      for (let ix = -1; ix <= 1; ix++)
        for (let iy = -1; iy <= 1; iy++) {
          const id = cornerIds.get(`${gx + ix},${gy + iy}`);
          if (id !== undefined && Math.hypot(this.corners[id * 2]! - x, this.corners[id * 2 + 1]! - y) < 0.2) return id;
        }
      const id = this.corners.length / 2;
      cornerIds.set(`${gx},${gy}`, id);
      this.corners.push(x, y);
      return id;
    };
    const edgeIds = new Map<string, Edge>();
    const cells: { cs: number[]; ns: number[] }[] = [];
    for (let i = 0; i < inner; i++) {
      const sx = seeds[i * 2]!;
      const sy = seeds[i * 2 + 1]!;
      let poly: { x: number; y: number; n: number }[] = [
        { x: cx - box, y: cy - box, n: -1 },
        { x: cx + box, y: cy - box, n: -1 },
        { x: cx + box, y: cy + box, n: -1 },
        { x: cx - box, y: cy + box, n: -1 },
      ];
      for (let j = 0; j < seeds.length / 2; j++) {
        if (j === i) continue;
        const tx = seeds[j * 2]!;
        const ty = seeds[j * 2 + 1]!;
        // keep points nearer i than j: (p - m) · (t - s) <= 0
        const mx = (sx + tx) / 2;
        const my = (sy + ty) / 2;
        const dx = tx - sx;
        const dy = ty - sy;
        const side = (p: { x: number; y: number }) => (p.x - mx) * dx + (p.y - my) * dy;
        const out: typeof poly = [];
        for (let k = 0; k < poly.length; k++) {
          const P = poly[k]!;
          const Q = poly[(k + 1) % poly.length]!;
          const sp = side(P);
          const sq = side(Q);
          const cut = () => {
            const t = sp / (sp - sq);
            return { x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t };
          };
          if (sp <= 0) {
            out.push(P);
            if (sq > 0) out.push({ ...cut(), n: j });
          } else if (sq <= 0) out.push({ ...cut(), n: P.n });
        }
        poly = out;
        if (poly.length < 3) break;
      }
      const cs = poly.map((p) => corner(p.x, p.y));
      cells.push({ cs, ns: poly.map((p) => p.n) });
    }

    // the edges, jagged once, shared
    for (let i = 0; i < inner; i++) {
      const { cs, ns } = cells[i]!;
      const sides: PlateShape["sides"] = [];
      const poly: number[] = [];
      for (let k = 0; k < cs.length; k++) {
        const a = cs[k]!;
        const b = cs[(k + 1) % cs.length]!;
        if (a === b) continue;
        const n = ns[k]!;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        let e = edgeIds.get(key);
        if (!e) {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          e = {
            id: this.edges.length,
            a: lo,
            b: hi,
            pts: this.jag(lo, hi),
            left: i,
            right: n >= 0 && n < inner ? n : -1,
            outer: !(n >= 0 && n < inner),
            cracked: false,
            run: 0,
            fromB: false,
            at: -1,
          };
          edgeIds.set(key, e);
          this.edges.push(e);
        }
        const rev = e.a !== a;
        sides.push({ edge: e, start: poly.length / 2, rev });
        const m = e.pts.length / 2;
        for (let q = 0; q < m - 1; q++) {
          const idx = rev ? m - 1 - q : q;
          poly.push(e.pts[idx * 2]!, e.pts[idx * 2 + 1]!);
        }
      }
      let area = 0;
      let mx = 0;
      let my = 0;
      const np = poly.length / 2;
      for (let q = 0; q < np; q++) {
        const x0 = poly[q * 2]!;
        const y0 = poly[q * 2 + 1]!;
        const x1 = poly[((q + 1) % np) * 2]!;
        const y1 = poly[((q + 1) % np) * 2 + 1]!;
        const c = x0 * y1 - x1 * y0;
        area += c;
        mx += (x0 + x1) * c;
        my += (y0 + y1) * c;
      }
      area /= 2;
      mx /= 6 * area;
      my /= 6 * area;
      // (positive area throughout, so "left of an edge" is inside)
      if (area < 0) throw new Error("wall: a plate wound the wrong way");
      this.shapes.push({ id: i, poly, tris: triangulate(poly), sides, cx: mx, cy: my, r: Math.hypot(mx - cx, my - cy), area });
    }

    // the impact: the corner nearest the middle
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.corners.length / 2; i++) {
      const d = Math.hypot(this.corners[i * 2]! - cx, this.corners[i * 2 + 1]! - cy);
      if (d < bd && this.edges.some((e) => !e.outer && (e.a === i || e.b === i))) {
        bd = d;
        best = i;
      }
    }
    this.origin = best;
    this.reached.add(best);
  }

  /** A jagged polyline between two corners (the same for both plates: seeded by the corners). */
  private jag(a: number, b: number): number[] {
    const r = seeded(a * 7919 + b * 104729 + 17);
    const x0 = this.corners[a * 2]!;
    const y0 = this.corners[a * 2 + 1]!;
    const x1 = this.corners[b * 2]!;
    const y1 = this.corners[b * 2 + 1]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / CRACK.step));
    const nx = -(y1 - y0) / (len || 1);
    const ny = (x1 - x0) / (len || 1);
    const bendAt = 0.3 + r() * 0.4;
    const bend = (r() * 2 - 1) * CRACK.bend * len;
    const out = [x0, y0];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      // the bend: a kink, straight either side
      const k = t < bendAt ? t / bendAt : (1 - t) / (1 - bendAt);
      const fade = Math.min(1, Math.min(t, 1 - t) * n * 0.7);
      const d = bend * k + (r() * 2 - 1) * CRACK.jag * fade;
      out.push(x0 + (x1 - x0) * t + nx * d, y0 + (y1 - y0) * t + ny * d);
    }
    out.push(x1, y1);
    return out;
  }

  cornerXY(c: number): [number, number] {
    return [this.corners[c * 2]!, this.corners[c * 2 + 1]!];
  }

  /** Crack an edge (its run starts from the end a crack already reached). */
  crack(e: Edge, at: number, instant = false) {
    if (e.cracked) return;
    e.cracked = true;
    e.at = at;
    e.fromB = this.reached.has(e.b) && !this.reached.has(e.a);
    e.run = instant ? 1 : 0;
    this.reached.add(e.a);
    this.reached.add(e.b);
  }

  get started() {
    return this.edges.some((e) => e.cracked);
  }

  /** advance the cracks that are running; true while any are */
  update(dt: number) {
    let busy = false;
    for (const e of this.edges) {
      if (!e.cracked || e.run >= 1) continue;
      e.run = Math.min(1, e.run + dt / CRACK.zip);
      busy = true;
    }
    return busy;
  }
}

// The plates as rigid 3D slabs: a polygon face, its broken sides (the wall's full thickness) and its back. A plate
// cracked free on all sides but one tips up toward you about that side, its hinge: a hard step a few degrees at a
// punch, snapping to the new angle with no overshoot. The same slab drawing serves the debris (debris.ts).
import { axisAngle, IDENTITY, type Xf } from "./core.ts";
import type { Edge, Fracture, PlateShape } from "./cracks.ts";
import { MATERIAL } from "./material.ts";
import { xf, xfDir, type Scene, type V3 } from "./scene.ts";

export const PLATE = {
  /** the most a plate ever tips (degrees; each plate: somewhere in the range, times the site's `tilt`); how far
   *  (punches.ts says how much each knock tips it) */
  max: [42, 54] as const,
  /** a rim plate tipping after a widening (degrees) */
  rim: [12, 22] as const,
  /** each knock also pops it this far out of the wall (px), up to `popMax` (popping partly free comes on top) */
  pop: [3, 6] as const,
  popMax: [9, 15] as const,
  /** a lift takes this long (s), easing out: a hard knock, no spring */
  snap: 0.07,
};

/** A slab's shape: its outline, the outline's triangles, each outline segment's outward normal, where the
 *  corners are (ink runs down the sides there), and its thickness. In page px, at rest. */
export interface Slab {
  poly: number[];
  tris: number[];
  normals: number[];
  corners: number[];
  depth: number;
}

export function slabOf(s: PlateShape, depth: number): Slab {
  const n = s.poly.length / 2;
  const normals: number[] = new Array(n * 2);
  for (const side of s.sides) {
    const m = side.edge.pts.length / 2 - 1;
    // the chord of the whole side: one flat face per side, however jagged
    const i0 = side.start;
    const i1 = (side.start + m) % n;
    const dx = s.poly[i1 * 2]! - s.poly[i0 * 2]!;
    const dy = s.poly[i1 * 2 + 1]! - s.poly[i0 * 2 + 1]!;
    const l = Math.hypot(dx, dy) || 1;
    for (let k = 0; k < m; k++) {
      const q = (i0 + k) % n;
      normals[q * 2] = dy / l;
      normals[q * 2 + 1] = -dx / l;
    }
  }
  return { poly: s.poly, tris: s.tris, normals, corners: s.sides.map((x) => x.start), depth };
}

export interface SlabStyle {
  /** draw the sides and back (a slab seen at an angle) */
  solid: boolean;
  /** ink on the face's outline, and on the back and down the corners */
  ink: number;
  inkBack: number;
  /** casts a shadow this dark (0: none) */
  shadow: number;
}

/** Draw a slab moved by `x`. */
export function drawSlab(scene: Scene, s: Slab, x: Xf, st: SlabStyle) {
  const P = MATERIAL.paper;
  const C = MATERIAL.core;
  const n = s.poly.length / 2;
  const d = s.depth;
  const top: V3[] = [];
  const bot: V3[] = [];
  for (let i = 0; i < n; i++) {
    top.push(xf(x, s.poly[i * 2]!, s.poly[i * 2 + 1]!, 0));
    if (st.solid || st.shadow) bot.push(xf(x, s.poly[i * 2]!, s.poly[i * 2 + 1]!, -d));
  }
  const up = xfDir(x, 0, 0, 1);
  for (let i = 0; i < s.tris.length; i += 3) {
    const a = s.tris[i]!;
    const b = s.tris[i + 1]!;
    const c = s.tris[i + 2]!;
    scene.tri(top[a]!, top[b]!, top[c]!, up, P);
    if (st.solid) scene.tri(bot[a]!, bot[c]!, bot[b]!, [-up[0]!, -up[1]!, -up[2]!], C);
    if (st.shadow) {
      scene.shadowTri(top[a]!, top[b]!, top[c]!, st.shadow);
      scene.shadowTri(bot[a]!, bot[b]!, bot[c]!, st.shadow);
    }
  }
  if (st.solid) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const nn = xfDir(x, s.normals[i * 2]!, s.normals[i * 2 + 1]!, 0);
      scene.tri(top[i]!, bot[i]!, top[j]!, nn, C);
      scene.tri(top[j]!, bot[i]!, bot[j]!, nn, C);
      if (st.shadow) {
        scene.shadowTri(top[i]!, bot[i]!, top[j]!, st.shadow);
        scene.shadowTri(top[j]!, bot[i]!, bot[j]!, st.shadow);
      }
    }
  }
  const ink = MATERIAL.ink;
  if (st.ink) for (let i = 0; i < n; i++) scene.seg(top[i]!, top[(i + 1) % n]!, st.ink, ink);
  if (st.inkBack && st.solid) {
    for (let i = 0; i < n; i++) scene.seg(bot[i]!, bot[(i + 1) % n]!, st.inkBack, ink);
    for (const c of s.corners) scene.seg(top[c]!, bot[c]!, st.inkBack, ink);
  }
}

/** The broken side of a flat plate from `start`, `count` outline segments long (a crack wall seen in a gap). */
export function drawWall(scene: Scene, s: Slab, start: number, count: number) {
  const C = MATERIAL.core;
  const n = s.poly.length / 2;
  const d = s.depth;
  for (let k = 0; k < count; k++) {
    const i = (start + k) % n;
    const j = (i + 1) % n;
    const x0 = s.poly[i * 2]!;
    const y0 = s.poly[i * 2 + 1]!;
    const x1 = s.poly[j * 2]!;
    const y1 = s.poly[j * 2 + 1]!;
    const nn = [s.normals[i * 2]!, s.normals[i * 2 + 1]!, 0];
    scene.tri([x0, y0, 0], [x0, y0, -d], [x1, y1, 0], nn, C);
    scene.tri([x1, y1, 0], [x0, y0, -d], [x1, y1, -d], nn, C);
  }
}

/** A plate of the fracture: where it is (its hinge and how far it's tipped), or knocked out. */
export class Plate {
  readonly slab: Slab;
  /** the side it tips about (null: it can't) */
  readonly hinge: Edge | null;
  /** the hinge line: a point on it and its direction (so that a positive angle lifts the plate toward you) */
  private hx = 0;
  private hy = 0;
  private ux = 1;
  private uy = 0;
  /** the most this one tips (rad) */
  readonly max: number;
  angle = 0;
  target = 0;
  private from = 0;
  /** how far it's popped out (px) */
  z = 0;
  private zTarget = 0;
  private zFrom = 0;
  private zMax = PLATE.popMax[0] + Math.random() * (PLATE.popMax[1] - PLATE.popMax[0]);
  /** waiting this long (s) before the knock reaches it */
  private wait = 0;
  private t = 1;
  removed = false;

  constructor(readonly shape: PlateShape, f: Fracture, tilt: number) {
    this.slab = slabOf(shape, MATERIAL.thickness);
    this.max = ((PLATE.max[0] + Math.random() * (PLATE.max[1] - PLATE.max[0])) * tilt * Math.PI) / 180;
    // the hinge: the outside of the fractured area if it touches it (the longest such side); otherwise the side
    // facing most away from the impact, longer sides first
    const len = (e: Edge) => {
      const [x0, y0] = f.cornerXY(e.a);
      const [x1, y1] = f.cornerXY(e.b);
      return Math.hypot(x1 - x0, y1 - y0);
    };
    let hinge: Edge | null = null;
    const outer = shape.sides.filter((s) => s.edge.outer).map((s) => s.edge);
    if (outer.length) hinge = outer.reduce((a, b) => (len(b) > len(a) ? b : a));
    else {
      let best = -Infinity;
      const rx = shape.cx - f.cx;
      const ry = shape.cy - f.cy;
      const rl = Math.hypot(rx, ry) || 1;
      for (const s of shape.sides) {
        const [x0, y0] = f.cornerXY(s.edge.a);
        const [x1, y1] = f.cornerXY(s.edge.b);
        const mx = (x0 + x1) / 2 - shape.cx;
        const my = (y0 + y1) / 2 - shape.cy;
        const ml = Math.hypot(mx, my) || 1;
        const score = ((mx * rx + my * ry) / (ml * rl)) * Math.sqrt(len(s.edge));
        if (score > best) {
          best = score;
          hinge = s.edge;
        }
      }
    }
    this.hinge = hinge;
    if (hinge) {
      const [x0, y0] = f.cornerXY(hinge.a);
      const [x1, y1] = f.cornerXY(hinge.b);
      const l = Math.hypot(x1 - x0, y1 - y0) || 1;
      this.hx = x0;
      this.hy = y0;
      this.ux = (x1 - x0) / l;
      this.uy = (y1 - y0) / l;
      // rotating about u by +θ lifts the side where u × d points toward you
      if (this.ux * (shape.cy - y0) - this.uy * (shape.cx - x0) < 0) {
        this.ux = -this.ux;
        this.uy = -this.uy;
      }
    }
  }

  /** Free on every side but its hinge (and never knocked out). */
  get free() {
    if (this.removed || !this.hinge) return false;
    return this.shape.sides.every((s) => s.edge === this.hinge || s.edge.cracked);
  }

  get lifted() {
    return this.angle > 1e-4 || this.target > 0;
  }

  get busy() {
    return this.t < 1;
  }

  /** Tip up by `deg` more (up to its most), pop out, and `free` px more (popping partly free), `wait` s from now: a
   *  knock. */
  lift(deg: number, free = 0, wait = 0) {
    const to = Math.min(this.max, this.target + (deg * Math.PI) / 180);
    if (to <= this.target + 1e-4 && !free) return false;
    this.from = this.angle;
    this.target = Math.max(to, this.target);
    this.zFrom = this.z;
    this.zMax += free;
    this.zTarget = Math.min(this.zMax, this.zTarget + PLATE.pop[0] + Math.random() * (PLATE.pop[1] - PLATE.pop[0]) + free);
    this.t = 0;
    this.wait = wait;
    return true;
  }

  update(dt: number) {
    if (this.t >= 1) return;
    if (this.wait > 0) {
      this.wait -= dt;
      return;
    }
    this.t = Math.min(1, this.t + dt / PLATE.snap);
    const e = 1 - Math.pow(1 - this.t, 3);
    this.angle = this.from + (this.target - this.from) * e;
    this.z = this.zFrom + (this.zTarget - this.zFrom) * e;
  }

  /** where it is: a rotation about the hinge, popped out */
  get xf(): Xf {
    if (this.angle <= 0) return IDENTITY;
    const r = axisAngle(this.ux, this.uy, 0, this.angle);
    const h = [this.hx, this.hy, 0];
    return { r, t: [h[0]! - (r[0]! * h[0]! + r[1]! * h[1]!), h[1]! - (r[3]! * h[0]! + r[4]! * h[1]!), this.z - (r[6]! * h[0]! + r[7]! * h[1]!)] };
  }

  /** the way it's tipping (unit, flat): away from the hinge */
  get away(): [number, number] {
    return [-this.uy, this.ux];
  }
}

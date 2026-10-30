// Lifting plates: once a plate of cracked drywall is free on all sides but its outer edge, the punches behind it tip
// it up toward you, hinged on that outer edge (the wedges at the centre most, the outer plates a little). Each lifted
// plate is drawn as a tilted slab: its painted face shaded by its tilt (and the bulge under it) in the key light, its
// broken gypsum thickness showing along the edges that rose, a torn paint lip catching the light, and a shadow cast
// onto the wall below and to the right. Each punch jolts them; they settle a little after.
import { clamp, type Batch, type View } from "./core.ts";
import type { Cell, Fracture } from "./cracks.ts";
import { MATERIAL, type Material } from "./material.ts";

export const PLATE = {
  /** the most a plate tips (radians), by ring: the centre wedges, then outward; and how far each ring may lift at
   *  all (of a site's liftMax) */
  tilt: [0.62, 0.46, 0.26, 0.12, 0.06] as const,
  ringLift: [1, 0.9, 0.55, 0.28, 0.1] as const,
  /** the board bends rather than tipping flat: its rise goes as (distance from the hinge)^bend */
  bend: 1.5,
  /** the room's fill light, against the key light: a plate turned away from the key is this much less dark */
  fill: 0.85,
  /** the centre wedges are also pushed straight out by this much (px) at full lift */
  push: 16,
  /** the board's thickness (px), as its broken edge shows */
  thickness: 11,
  /** the viewer's distance (px): how much raised parts swell and slide outward */
  distance: 1100,
  /** the broken gypsum: colour (a warm grey off-white), shade in light and in shadow */
  gypsum: [0.9, 0.875, 0.83] as const,
  gypsumLit: 1,
  gypsumDark: 0.58,
  /** the torn paint along a raised edge: width (px) and brightness */
  paint: 1.3,
  /** the cast shadow: darkness, and how many layers soften it */
  shadow: 0.42,
  shadowLayers: 3,
  /** the darkness under a raised plate, over its whole footprint (0: off; the crack gaps and shadows do it) */
  cavity: 0,
  /** how quickly a plate follows its lift (spring), and how a punch jolts it (in lift units) */
  spring: 60,
  damping: 11,
  jolt: 0.35,
};

interface Pose {
  /** projected outline, its heights, and the shadow's outline */
  pts: number[];
  z: number[];
  /** the board's slope at each corner (it bends) */
  slope: number[];
  shadow: number[];
  /** the board's back corners (outline pushed along the plate's normal by the thickness), projected */
  back: number[];
  /** tilt direction (unit, toward the centre side) and angle */
  dx: number;
  dy: number;
  angle: number;
  top: number;
}

export class Plates {
  constructor(
    readonly fracture: Fracture,
    private material: Material,
    /** this site's tilt, against PLATE.tilt */
    private scale = 1,
  ) {}

  /** A punch: every plate that's lifting jumps. */
  jolt(k = 1) {
    for (const c of this.fracture.cells) if (c.liftTarget > 0 && !c.removed) c.liftV += PLATE.jolt * k * 8;
  }

  update(dt: number) {
    for (const c of this.fracture.cells) {
      if (c.removed || (c.liftTarget === 0 && c.lift === 0)) continue;
      const a = (c.liftTarget - c.lift) * PLATE.spring - c.liftV * PLATE.damping;
      c.liftV += a * dt;
      c.lift = clamp(c.lift + c.liftV * dt, 0, 1.25);
    }
  }

  get busy() {
    return this.fracture.cells.some((c) => !c.removed && Math.abs(c.liftTarget - c.lift) + Math.abs(c.liftV) > 0.002);
  }

  /** Where a plate is: tipped on its hinge by its lift. */
  pose(c: Cell, v: View): Pose {
    const [hx0, hy0, hx1, hy1] = c.hinge;
    // the tilt runs from the hinge toward the side the plate is on
    let nx = -(hy1 - hy0);
    let ny = hx1 - hx0;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    if ((c.cx - hx0) * nx + (c.cy - hy0) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const tilts = PLATE.tilt;
    const angle = c.lift * (tilts[Math.min(c.ring, tilts.length - 1)] ?? 0.05) * this.scale * (0.8 + 0.4 * c.seed);
    const tan = Math.tan(angle);
    let D = 1;
    for (let i = 0; i < c.poly.length; i += 2) D = Math.max(D, (c.poly[i]! - hx0) * nx + (c.poly[i + 1]! - hy0) * ny);
    const push = c.ring === 0 ? PLATE.push * c.lift * this.scale : 0;
    const F = PLATE.distance;
    const ccx = v.sx + v.vw / 2;
    const ccy = v.sy + v.vh / 2;
    const L = MATERIAL.light;
    const sx = -L[0]! / L[2]!;
    const sy = -L[1]! / L[2]!;
    const T = PLATE.thickness;
    const pts: number[] = [];
    const z: number[] = [];
    const slope: number[] = [];
    const shadow: number[] = [];
    const back: number[] = [];
    let top = 0;
    const proj = (x: number, y: number, h: number) => {
      const k = F / (F - h);
      return [ccx + (x - ccx) * k, ccy + (y - ccy) * k];
    };
    for (let i = 0; i < c.poly.length; i += 2) {
      const x = c.poly[i]!;
      const y = c.poly[i + 1]!;
      const d = clamp(((x - hx0) * nx + (y - hy0) * ny) / D, 0, 1);
      // bent: flat at the hinge, rising faster toward the free edge
      const h = D * tan * d ** PLATE.bend + push;
      const sl = tan * PLATE.bend * d ** (PLATE.bend - 1);
      top = Math.max(top, h);
      const [px, py] = proj(x, y, h);
      pts.push(px, py);
      z.push(h);
      slope.push(sl);
      shadow.push(x + sx * h, y + sy * h);
      // the back face: down the board's normal there by its thickness
      const la = Math.atan(sl);
      const [bx, by] = proj(x + nx * Math.sin(la) * T, y + ny * Math.sin(la) * T, h - Math.cos(la) * T);
      back.push(bx, by);
    }
    return { pts, z, slope, shadow, back, dx: nx, dy: ny, angle, top };
  }

  /** The gaps under raised plates, and the shadows they cast: drawn on the wall, under the plates. */
  drawUnder(b: Batch, poses: Map<Cell, Pose>) {
    for (const [c, p] of poses) {
      const k = clamp(p.top / 10, 0, 1);
      // under it, the cavity behind the board shows where the plate no longer covers it
      b.poly(c.poly, c.tris, [0.05, 0.045, 0.045, PLATE.cavity * k]);
    }
    for (const [c, p] of poses) {
      const n = PLATE.shadowLayers;
      for (let j = 0; j < n; j++) {
        const s = 0.8 + (0.4 * j) / Math.max(1, n - 1);
        const pts: number[] = [];
        for (let i = 0; i < c.poly.length; i += 2) {
          pts.push(c.poly[i]! + (p.shadow[i]! - c.poly[i]!) * s, c.poly[i + 1]! + (p.shadow[i + 1]! - c.poly[i + 1]!) * s);
        }
        b.poly(pts, c.tris, [0, 0, 0, (PLATE.shadow / n) * clamp(p.top / 6, 0, 1)]);
      }
    }
  }

  /** The raised plates themselves, lowest first: broken edges, then faces, then the torn paint. */
  drawPlates(b: Batch, poses: Map<Cell, Pose>) {
    const L = MATERIAL.light;
    const ll = Math.hypot(L[0]!, L[1]!, L[2]!);
    const lx = L[0]! / ll;
    const ly = L[1]! / ll;
    const lz = L[2]! / ll;
    const base = MATERIAL.base;
    const G = PLATE.gypsum;
    const sorted = [...poses].sort((a, b) => a[1].top - b[1].top);
    for (const [c, p] of sorted) {
      const n = p.pts.length / 2;
      // the broken edges: the band between the face's outline and the back's, toward wherever it shows
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (p.z[i]! < 0.4 && p.z[j]! < 0.4) continue;
        const ex = c.poly[j * 2]! - c.poly[i * 2]!;
        const ey = c.poly[j * 2 + 1]! - c.poly[i * 2 + 1]!;
        const el = Math.hypot(ex, ey) || 1;
        // the edge's outward side, and how it faces the light
        let ox = ey / el;
        let oy = -ex / el;
        if ((c.poly[i * 2]! - c.cx) * ox + (c.poly[i * 2 + 1]! - c.cy) * oy < 0) {
          ox = -ox;
          oy = -oy;
        }
        const facing = clamp(-(ox * lx + oy * ly) * 1.4 + 0.35, 0, 1);
        const s = PLATE.gypsumDark + (PLATE.gypsumLit - PLATE.gypsumDark) * facing;
        // rough: each bit of the break a little different
        const grain = 0.94 + 0.1 * (((i * 7919 + c.id * 31) % 13) / 13);
        const top = [G[0] * s * grain, G[1] * s * grain, G[2] * s * grain, 1];
        const bot = [G[0] * s * 0.72, G[1] * s * 0.72, G[2] * s * 0.72, 1];
        b.tri(p.pts[i * 2]!, p.pts[i * 2 + 1]!, p.pts[j * 2]!, p.pts[j * 2 + 1]!, p.back[j * 2]!, p.back[j * 2 + 1]!, top, top, bot);
        b.tri(p.pts[i * 2]!, p.pts[i * 2 + 1]!, p.back[j * 2]!, p.back[j * 2 + 1]!, p.back[i * 2]!, p.back[i * 2 + 1]!, top, bot, bot);
      }
      // the painted face, shaded corner by corner (it bends): its slope there, and the bulge under it
      const [gx, gy] = this.material.slope(c.cx, c.cy);
      const flat = PLATE.fill + lz;
      const tone = 1 + (c.seed - 0.5) * 0.014;
      const cols: number[][] = [];
      for (let i = 0; i < n; i++) {
        const sl = p.slope[i]!;
        let nx = -sl * p.dx - gx * MATERIAL.relief;
        let ny = -sl * p.dy - gy * MATERIAL.relief;
        let nz = 1;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl;
        ny /= nl;
        nz /= nl;
        const shade = ((PLATE.fill + Math.max(0, nx * lx + ny * ly + nz * lz)) / flat) * tone;
        cols.push([base[0]! * shade, base[1]! * shade, base[2]! * shade, 1]);
      }
      for (let t = 0; t < c.tris.length; t += 3) {
        const i0 = c.tris[t]!;
        const i1 = c.tris[t + 1]!;
        const i2 = c.tris[t + 2]!;
        b.tri(p.pts[i0 * 2]!, p.pts[i0 * 2 + 1]!, p.pts[i1 * 2]!, p.pts[i1 * 2 + 1]!, p.pts[i2 * 2]!, p.pts[i2 * 2 + 1]!, cols[i0]!, cols[i1]!, cols[i2]!);
      }
      // the paint tore along the raised edges: a fine bright lip
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const h = Math.min(p.z[i]!, p.z[j]!);
        if (h < 0.8) continue;
        b.line(p.pts[i * 2]!, p.pts[i * 2 + 1]!, p.pts[j * 2]!, p.pts[j * 2 + 1]!, PLATE.paint, [1, 1, 1, clamp(h / 8, 0, 0.85)]);
      }
    }
  }

  /** Every plate that's up, posed for this frame. */
  poses(v: View): Map<Cell, Pose> {
    const out = new Map<Cell, Pose>();
    for (const c of this.fracture.cells) if (!c.removed && c.lift > 0.004) out.set(c, this.pose(c, v));
    return out;
  }
}

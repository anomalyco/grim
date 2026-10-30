// A punch site. Each punch is one big, hard knock: the fracture (cracks.ts) cracks wide, the crack front spreading out
// from the impact with long cracks running on past it; two to four plates tip up hard about their hinges, toward you
// (plates.ts), some popping partly free; crumbs and chunks fly (debris.ts). Nothing bends or settles: the plates
// only rotate and move, rigidly, snapping to their new place. The site also draws its
// plates, its cracks, and the dark behind anything tipped up; and it picks the plates for the breakthrough and the
// widening.
import { rand } from "./core.ts";
import { Fracture, type Edge } from "./cracks.ts";
import type { Debris } from "./debris.ts";
import { MATERIAL } from "./material.ts";
import { drawSlab, drawWall, Plate, PLATE } from "./plates.ts";
import type { Scene, V3 } from "./scene.ts";

export const PUNCH = {
  /** each punch cracks every edge out to this fraction of the fracture's radius (the site's 1st punch, 2nd, 3rd…) */
  reach: [0.55, 0.85, 1] as const,
  /** plus this many long cracks running on out from there, up to `runLength` edges each */
  runs: [3, 5] as const,
  runLength: 4,
  /** the crack front spreads out from the impact at this speed (px/s): plates further out lift as it gets there */
  spread: 1600,
  /** plates lifted by each punch, and a fresh one's tilt (degrees, times the site's `tilt`); one already up tips
   *  `tiltMore` further */
  lifts: [2, 4] as const,
  tilt: [30, 46] as const,
  tiltMore: [8, 14] as const,
  /** the chance a lifted plate pops partly free (comes further out of the wall), and how far (px) */
  popFree: 0.35,
  popFreeZ: [12, 26] as const,
  /** crumbs (per lifted plate) and chunks (per punch) flying out */
  crumbs: [5, 8] as const,
  chunks: [2, 4] as const,
  /** the breakthrough knocks out every plate tipped up, and every plate this near the impact (of the radius) */
  breakReach: 0.55,
  /** a plate knocked out cracks each plate next to it with this chance */
  shock: 0.7,
};

export interface SiteShape {
  /** size of the fracture */
  scale: number;
  /** how far plates tip */
  tilt: number;
}

export class Site {
  readonly fracture: Fracture;
  readonly plates: Plate[];
  n = 0;

  constructor(
    readonly cx: number,
    readonly cy: number,
    low: boolean,
    private shape: SiteShape,
    private debris: Debris,
  ) {
    this.fracture = new Fracture(cx, cy, shape.scale, low);
    this.plates = this.fracture.shapes.map((s) => new Plate(s, this.fracture, shape.tilt));
  }

  get radius() {
    return this.fracture.radius;
  }

  /** how long (s) the crack front takes to get this far from the impact */
  private delay(x: number, y: number) {
    return Math.hypot(x - this.cx, y - this.cy) / PUNCH.spread;
  }

  /** One big knock: the fracture cracks wide, a few plates tip up hard, and bits fly. */
  punch() {
    this.n++;
    const f = this.fracture;
    const R = f.radius;
    const rc = R * PUNCH.reach[Math.min(this.n, PUNCH.reach.length) - 1]!;
    const dist = (c: number) => {
      const [x, y] = f.cornerXY(c);
      return Math.hypot(x - this.cx, y - this.cy);
    };
    // everything inside the reach cracks, the front spreading out from the impact
    const crack = (e: Edge) => {
      if (e.cracked) return;
      const near = Math.min(dist(e.a), dist(e.b));
      f.crack(e, this.n, false, near / PUNCH.spread);
    };
    for (const e of f.edges) if (!e.outer && Math.max(dist(e.a), dist(e.b)) <= rc) crack(e);
    if (!f.edges.some((e) => e.cracked)) for (const e of f.edges) if (!e.outer && (e.a === f.origin || e.b === f.origin)) crack(e);
    // long cracks running on out
    const tips = [...f.reached].filter((c) => dist(c) > rc * 0.55).sort(() => Math.random() - 0.5);
    const runs = Math.round(rand(...PUNCH.runs));
    for (let i = 0; i < runs && i < tips.length; i++) {
      let tip = tips[i]!;
      for (let k = 0; k < PUNCH.runLength; k++) {
        const here = dist(tip);
        const next = f.edges.filter((e) => !e.cracked && !e.outer && (e.a === tip || e.b === tip) &&
          dist(e.a === tip ? e.b : e.a) > here - 4);
        if (!next.length) break;
        const e = next[Math.floor(Math.random() * next.length)]!;
        crack(e);
        tip = e.a === tip ? e.b : e.a;
      }
    }
    // plates tip up hard: fresh ones (those whose free sides show most first), and maybe one already up, further
    const free = this.plates.filter((p) => p.free && p.target < p.max - 1e-3);
    const exposed = (q: Plate) => q.shape.sides.filter((x) => {
      if (x.edge === q.hinge) return false;
      const o = x.edge.left === q.shape.id ? x.edge.right : x.edge.left;
      return o < 0 || !this.plates[o]!.lifted;
    }).length / q.shape.sides.length;
    const fresh = free.filter((p) => !p.lifted).sort((p, q) =>
      p.shape.r / R - exposed(p) * 0.5 + Math.random() * 0.35 - (q.shape.r / R - exposed(q) * 0.5 + Math.random() * 0.35));
    const up = free.filter((p) => p.lifted);
    const n = Math.round(rand(...PUNCH.lifts));
    const lift: Plate[] = fresh.slice(0, n - (up.length ? 1 : 0));
    if (up.length) lift.push(up[Math.floor(Math.random() * up.length)]!);
    const pts: [number, number][] = [];
    for (const p of lift) {
      const wait = this.delay(p.shape.cx, p.shape.cy);
      const pop = Math.random() < PUNCH.popFree ? rand(...PUNCH.popFreeZ) : 0;
      p.lift(p.lifted ? rand(...PUNCH.tiltMore) : rand(...PUNCH.tilt) * this.shape.tilt, pop, wait);
      // crumbs off its free edges
      const poly = p.shape.poly;
      const own: [number, number][] = [];
      for (const side of p.shape.sides) {
        if (side.edge === p.hinge) continue;
        const m = side.edge.pts.length / 2 - 1;
        for (let q = 0; q < m; q += 2) {
          const i = (side.start + q) % (poly.length / 2);
          own.push([poly[i * 2]!, poly[i * 2 + 1]!]);
        }
      }
      this.debris.crumbs(own, p.away[0], p.away[1], Math.round(rand(...PUNCH.crumbs)), 1, wait);
      pts.push(...own);
    }
    // and a few chunks from round the impact
    const core = this.plates.filter((p) => !p.removed && p.shape.r < rc * 0.6).map((p) => [p.shape.cx, p.shape.cy] as [number, number]);
    this.debris.crumbs(core.length ? core : [[this.cx, this.cy]], 0, 0, Math.round(rand(...PUNCH.chunks)), 2.2);
    return f;
  }

  /** The plates to knock out at the breakthrough: everything tipped up, and the plates round the impact. */
  breakthrough(): Plate[] {
    const R = this.fracture.radius;
    return this.plates
      .filter((p) => !p.removed && (p.lifted || p.shape.r < R * PUNCH.breakReach))
      .sort((a, b) => a.shape.r - b.shape.r);
  }

  /** `k` more plates next to the opening (not past `reach` of the radius), and the plates that are then free on
   *  the opening's side tip up a little (the rim is wrecked). */
  widen(k: number, reach: number): Plate[] {
    const R = this.fracture.radius;
    const gone = new Set(this.fracture.removed.map((s) => s.id));
    const nextTo = (p: Plate) => p.shape.sides.some((s) => {
      const o = s.edge.left === p.shape.id ? s.edge.right : s.edge.left;
      return o >= 0 && gone.has(o);
    });
    const cands = this.plates.filter((p) => !p.removed && p.shape.r < R * reach && nextTo(p));
    cands.sort((a, b) => a.shape.r + Math.random() * R * 0.35 - (b.shape.r + Math.random() * R * 0.35));
    return cands.slice(0, k);
  }

  /** Knock a plate out: it leaves the wall (as debris) from where it is. */
  knockOut(p: Plate, hx: number, hy: number) {
    if (p.removed) return;
    const x = p.xf;
    const ox = p.shape.cx - hx;
    const oy = p.shape.cy - hy;
    const ol = Math.hypot(ox, oy) || 1;
    const away: [number, number] = p.lifted ? p.away : [ox / ol, oy / ol];
    p.removed = true;
    for (const s of p.shape.sides) {
      this.fracture.crack(s.edge, this.n, true);
      // the shock cracks the plates round it too: the opening gets a broken rim, not a clean edge
      const o = s.edge.left === p.shape.id ? s.edge.right : s.edge.left;
      const q = o >= 0 ? this.plates[o]! : null;
      if (!q || q.removed || Math.random() > PUNCH.shock) continue;
      const whole = q.shape.sides.filter((x) => !x.edge.cracked && !x.edge.outer && x.edge !== q.hinge);
      if (whole.length) this.fracture.crack(whole[Math.floor(Math.random() * whole.length)]!.edge, this.n);
    }
    this.fracture.removed.push(p.shape);
    this.debris.knock(p.slab, x, p.shape.cx, p.shape.cy, hx, hy, away);
  }

  /** Plates next to the opening that are free now tip up a little (after a widening). */
  wreckRim(n: number, going: Plate[]) {
    const gone = new Set([...this.fracture.removed.map((s) => s.id), ...going.map((p) => p.shape.id)]);
    const rim = this.plates.filter((p) => !p.removed && !going.includes(p) && p.hinge && p.shape.sides.some((s) => {
      const o = s.edge.left === p.shape.id ? s.edge.right : s.edge.left;
      return o >= 0 && gone.has(o) && s.edge !== p.hinge;
    }));
    for (let i = 0; i < n && rim.length; i++) {
      const p = rim.splice(Math.floor(Math.random() * rim.length), 1)[0]!;
      for (const s of p.shape.sides) if (s.edge !== p.hinge && !s.edge.outer) this.fracture.crack(s.edge, this.n);
      if (p.free) p.lift(rand(...PLATE.rim));
    }
  }

  get busy() {
    return this.plates.some((p) => p.busy) || this.fracture.edges.some((e) => e.cracked && e.run < 1);
  }

  get lifting() {
    return this.plates.some((p) => p.lifted && !p.removed);
  }

  update(dt: number) {
    this.fracture.update(dt);
    for (const p of this.plates) p.update(dt);
  }

  draw(scene: Scene) {
    const T = MATERIAL.thickness;
    const P = MATERIAL.paper;
    const dark = MATERIAL.dark;
    for (const p of this.plates) {
      if (p.removed) continue;
      const s = p.shape;
      if (!p.lifted) {
        // flat: just its face (it hides what's behind it)
        for (let i = 0; i < s.tris.length; i += 3) {
          const a = s.tris[i]! * 2;
          const b = s.tris[i + 1]! * 2;
          const c = s.tris[i + 2]! * 2;
          scene.tri([s.poly[a]!, s.poly[a + 1]!, 0], [s.poly[b]!, s.poly[b + 1]!, 0], [s.poly[c]!, s.poly[c + 1]!, 0], [0, 0, 1], P);
        }
        // and its broken sides where a neighbour's tipped up (seen down the gap)
        for (const side of s.sides) {
          const o = side.edge.left === s.id ? side.edge.right : side.edge.left;
          if (o >= 0 && this.plates[o]!.lifted && !this.plates[o]!.removed) drawWall(scene, p.slab, side.start, side.edge.pts.length / 2 - 1);
        }
        continue;
      }
      // tipped up: the dark behind where it was, then the slab
      for (let i = 0; i < s.tris.length; i += 3) {
        const a = s.tris[i]! * 2;
        const b = s.tris[i + 1]! * 2;
        const c = s.tris[i + 2]! * 2;
        scene.tri([s.poly[a]!, s.poly[a + 1]!, -T - 1], [s.poly[b]!, s.poly[b + 1]!, -T - 1], [s.poly[c]!, s.poly[c + 1]!, -T - 1], [0, 0, 1], dark);
      }
      drawSlab(scene, p.slab, p.xf, { solid: true, ink: MATERIAL.inkEdge, inkBack: MATERIAL.inkBack, shadow: 1 });
    }
    // cracks in the face of the wall: on flat plates (a tipped plate inks its own outline; the opening inks its rim)
    const flat = (id: number) => id < 0 || (!this.plates[id]!.removed && !this.plates[id]!.lifted);
    const gone = (id: number) => id >= 0 && this.plates[id]!.removed;
    for (const e of this.fracture.edges) {
      if (!e.cracked || gone(e.left) || gone(e.right)) continue;
      if (!flat(e.left) && !flat(e.right)) continue;
      this.crackLine(scene, e);
    }
  }

  /** A crack in the face: ink with a slight dark gap either side, run out as far as it's got. */
  private crackLine(scene: Scene, e: Edge) {
    const m = e.pts.length / 2;
    const segs = m - 1;
    const upto = e.run * segs;
    const ink = MATERIAL.ink;
    for (let i = 0; i < segs && i < upto; i++) {
      const q = e.fromB ? segs - 1 - i : i;
      const f = Math.min(1, upto - i);
      const a: V3 = [e.pts[q * 2]!, e.pts[q * 2 + 1]!, 0];
      let b: V3 = [e.pts[q * 2 + 2]!, e.pts[q * 2 + 3]!, 0];
      if (e.fromB) b = [e.pts[q * 2]!, e.pts[q * 2 + 1]!, 0];
      const s0: V3 = e.fromB ? [e.pts[q * 2 + 2]!, e.pts[q * 2 + 3]!, 0] : a;
      const s1: V3 = [s0[0]! + (b[0]! - s0[0]!) * f, s0[1]! + (b[1]! - s0[1]!) * f, 0];
      scene.seg(s0, s1, MATERIAL.gap, ink, MATERIAL.gapAlpha);
      scene.seg(s0, s1, MATERIAL.inkCrack, ink);
    }
  }
}
